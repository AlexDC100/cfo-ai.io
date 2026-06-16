"""F4.2 methodology evaluator.

Walks a MethodologyDoc + canonical envelope and produces a dict of named
views (EBITDA variants + totals + ratios + industry-adjusted versions).

The formula evaluator is a restricted AST walker — supports:
  - Number literals
  - Name references (resolved against canonical envelope or prior views)
  - + - * / and unary minus
  - Parentheses
  - `.net` suffix on aggregate names

NO function calls, NO attribute access beyond the whitelisted `.net`,
NO indexing, NO comprehensions. The YAML files are trusted (versioned in
the repo, code-reviewed) but the evaluator stays restricted as a
defense-in-depth measure — a typo in a methodology file should fail
loudly with a clear error, not silently execute arbitrary code.
"""
from __future__ import annotations

import ast
import logging
from typing import Any, Dict, List, Optional, Set, Tuple

from .loader import MethodologyDoc, EbitdaVariantSpec, NamedFormula, MethodologyError

logger = logging.getLogger(__name__)


# ──────────────────────────────────────────────────────────────────────
# Public entry point
# ──────────────────────────────────────────────────────────────────────


def evaluate(methodology: MethodologyDoc,
             canonical_envelope: Dict[str, Any],
             industry_key: Optional[str] = None,
             operator_addbacks: Optional[float] = None) -> Dict[str, Any]:
    """Compute all named views for one period.

    Args:
        methodology: parsed MethodologyDoc (from load_methodology)
        canonical_envelope: the `assembled_canonical_v1` dict — needs
            `leaves` (per-bucket magnitudes) and `aggregates` (per-parent
            `.net` sums). Negative magnitudes are interpreted via
            sign_meaning so callers see signed-by-convention values.
        industry_key: optional industry override (e.g. "real_estate_developer")
        operator_addbacks: optional sum of per-period adjusted-EBITDA addbacks

    Returns:
        {
          "methodology_id": "...",
          "methodology_version": "1.0.0",
          "industry_key_applied": "default" | "...",
          "ebitda": {"reported": ..., "strict": ..., "cash": ..., "adjusted": ...},
          "totals": {"revenue_net": ..., "gross_profit": ..., ...},
          "ratios": {"ebitda_margin_reported": {"value": 0.13, "unit": "ratio",
                     "direction": "higher_is_better", "band": [0.08, 0.15]},
                     ...},
          "missing_buckets": [...],   # optional buckets that defaulted to 0
          "errors": [...],            # per-formula errors (rare; numerator/denominator etc.)
        }
    """
    # ── Apply industry overrides to a working copy of the doc ──────
    eff_variants = dict(methodology.ebitda_variants)
    eff_ratios = dict(methodology.ratios)
    industry_applied = "default"
    if industry_key and industry_key in methodology.industry_overrides:
        industry_applied = industry_key
        override = methodology.industry_overrides[industry_key]
        for dotted_key, new_value in override.overrides.items():
            _apply_override(eff_variants, eff_ratios, dotted_key, new_value)

    # ── Bind canonical leaves + aggregates to a resolver ───────────
    resolver = _Resolver(canonical_envelope, operator_addbacks=operator_addbacks)

    # ── Compute EBITDA variants in dependency order ───────────────
    ebitda_values: Dict[str, float] = {}
    errors: List[Dict[str, str]] = []
    for name in _topo_sort_variants(eff_variants):
        spec = eff_variants[name]
        try:
            value = _compute_variant(spec, eff_variants, ebitda_values, resolver)
            ebitda_values[name] = round(value, 4)
        except Exception as e:  # noqa: BLE001
            errors.append({"scope": f"ebitda.{name}", "error": f"{type(e).__name__}: {e}"})
            ebitda_values[name] = 0.0
    resolver.bind_view_namespace("ebitda", ebitda_values)

    # ── Compute totals ────────────────────────────────────────────
    totals_values: Dict[str, float] = {}
    for name, formula in methodology.totals.items():
        try:
            value = resolver.evaluate(formula.formula)
            totals_values[name] = round(value, 4)
        except Exception as e:  # noqa: BLE001
            errors.append({"scope": f"totals.{name}", "error": f"{type(e).__name__}: {e}"})
            totals_values[name] = 0.0
    resolver.bind_view_namespace("totals", totals_values)

    # ── Compute ratios ────────────────────────────────────────────
    # Bind the ratio_results dict to view_namespaces BEFORE the loop so
    # late-evaluated ratios (e.g. cash_conversion_cycle references
    # days_inventory_outstanding) can reference earlier-computed ratios
    # via `ratios.<name>`. The dict is mutated in place; each iteration
    # adds the freshly-computed ratio so subsequent iterations see it.
    ratio_results: Dict[str, Dict[str, Any]] = {}
    resolver.bind_view_namespace("ratios", ratio_results)
    for name, ratio in eff_ratios.items():
        try:
            value = resolver.evaluate(ratio.formula)
            # Guard against divide-by-zero and infinity
            if value != value or value in (float("inf"), float("-inf")):  # NaN check
                value = None
                ratio_results[name] = {"value": None, "unit": ratio.unit,
                                       "direction": ratio.direction,
                                       "band": ratio.band_default,
                                       "note": ratio.note,
                                       "reason": "divide_by_zero_or_nan"}
                continue
            ratio_results[name] = {
                "value": round(value, 6),
                "unit": ratio.unit,
                "direction": ratio.direction,
                "band": ratio.band_default,
                "note": ratio.note,
            }
        except Exception as e:  # noqa: BLE001
            errors.append({"scope": f"ratios.{name}", "error": f"{type(e).__name__}: {e}"})
            ratio_results[name] = {"value": None, "unit": ratio.unit,
                                   "direction": ratio.direction,
                                   "band": ratio.band_default,
                                   "note": ratio.note,
                                   "reason": "formula_error"}

    return {
        "methodology_id": methodology.methodology_id,
        "methodology_version": methodology.methodology_version,
        "schema_version": methodology.schema_version,
        "industry_key_applied": industry_applied,
        "ebitda": ebitda_values,
        "totals": totals_values,
        "ratios": ratio_results,
        "missing_buckets": sorted(resolver.missing_buckets_seen),
        "errors": errors,
    }


# ──────────────────────────────────────────────────────────────────────
# EBITDA variant composition
# ──────────────────────────────────────────────────────────────────────


def _topo_sort_variants(variants: Dict[str, EbitdaVariantSpec]) -> List[str]:
    """Resolve `base:` dependencies so each variant is computed after
    the variants it depends on. Cycle = MethodologyError."""
    visited: Set[str] = set()
    order: List[str] = []
    stack: Set[str] = set()

    def visit(name: str) -> None:
        if name in visited:
            return
        if name in stack:
            raise MethodologyError(f"ebitda_variants cycle detected at '{name}'")
        stack.add(name)
        spec = variants.get(name)
        if spec is None:
            raise MethodologyError(f"ebitda_variants.{name} not defined")
        if spec.base:
            visit(spec.base)
        stack.discard(name)
        visited.add(name)
        order.append(name)

    for name in variants:
        visit(name)
    return order


def _compute_variant(spec: EbitdaVariantSpec,
                     variants: Dict[str, EbitdaVariantSpec],
                     computed: Dict[str, float],
                     resolver: "_Resolver") -> float:
    if spec.formula is not None:
        return resolver.evaluate(spec.formula)
    # Composition: base ± terms
    if spec.base is None:
        raise MethodologyError(f"variant {spec.name}: neither formula nor base")
    if spec.base not in computed:
        raise MethodologyError(f"variant {spec.name}: base '{spec.base}' not yet computed (topo bug)")
    total = float(computed[spec.base])
    for token in spec.add:
        total += resolver.resolve_token(token)
    for token in spec.subtract:
        total -= resolver.resolve_token(token)
    return total


def _apply_override(variants: Dict[str, EbitdaVariantSpec],
                    ratios: Dict[str, NamedFormula],
                    dotted_key: str,
                    new_value: Any) -> None:
    """Apply one industry override entry (dotted path → value).

    Supported paths today:
      ebitda_variants.<name>.formula
      ratios.<name>.formula
      ratios.<name>.band_default
    Unknown paths are logged + skipped (forward-compatible)."""
    parts = dotted_key.split(".")
    if len(parts) < 3:
        logger.warning("methodology industry override key too short: %s", dotted_key)
        return
    section, name, field = parts[0], parts[1], ".".join(parts[2:])
    if section == "ebitda_variants" and name in variants:
        spec = variants[name]
        if field == "formula":
            variants[name] = EbitdaVariantSpec(
                name=spec.name, description=spec.description,
                formula=str(new_value).strip(),
                base=None, subtract=[], add=[],
                excludes_by_convention=spec.excludes_by_convention,
                note=spec.note,
            )
    elif section == "ratios" and name in ratios:
        r = ratios[name]
        if field == "formula":
            ratios[name] = NamedFormula(name=r.name, formula=str(new_value).strip(),
                                         unit=r.unit, direction=r.direction,
                                         band_default=r.band_default, note=r.note)
        elif field == "band_default":
            ratios[name] = NamedFormula(name=r.name, formula=r.formula,
                                         unit=r.unit, direction=r.direction,
                                         band_default=list(new_value) if isinstance(new_value, list) else r.band_default,
                                         note=r.note)
    else:
        logger.warning("methodology industry override unknown path: %s", dotted_key)


# ──────────────────────────────────────────────────────────────────────
# AST-walking formula evaluator
# ──────────────────────────────────────────────────────────────────────


class _Resolver:
    """Resolves bucket / aggregate / view-namespace references during
    formula evaluation."""

    def __init__(self, canonical_envelope: Dict[str, Any],
                 operator_addbacks: Optional[float] = None) -> None:
        self.leaves = canonical_envelope.get("leaves") or {}
        self.aggregates = canonical_envelope.get("aggregates") or {}
        self.view_namespaces: Dict[str, Dict[str, float]] = {}
        # Operator-defined add-back sum, fed into the `operator_addbacks` token
        self.operator_addbacks = float(operator_addbacks or 0.0)
        # Names the formulas asked for but the envelope didn't have —
        # surfaced to the caller for diagnostics.
        self.missing_buckets_seen: Set[str] = set()
        # Set of identifiers that carried the `?` optional marker in the
        # current formula — populated by evaluate() before _eval_node runs.
        # Suppresses missing-bucket warnings for these.
        self._current_optional: Set[str] = set()

    def bind_view_namespace(self, namespace: str, values: Dict[str, float]) -> None:
        """Bind a computed view namespace (e.g. 'ebitda', 'totals') so
        downstream formulas can reference `ebitda.reported` etc."""
        self.view_namespaces[namespace] = values

    def resolve_token(self, token: str) -> float:
        """Resolve a single bucket/aggregate/optional token (used by
        the base+add/subtract composition path)."""
        token = token.strip()
        return self._resolve_identifier(token)

    def evaluate(self, formula: str) -> float:
        """Parse + walk a formula expression. Returns the float value.

        Pre-processing: strips the `?` optional-marker prefix from any
        identifier before AST parse (Python doesn't accept `?` as part of
        an identifier). The optional semantics is preserved separately —
        identifiers that originally carried `?` are tracked in
        self._optional_names_in_current_formula so the resolver knows
        not to register them in missing_buckets_seen even when absent.
        """
        # Normalize whitespace + newlines (YAML literal-block formulas
        # often span multiple lines).
        normalized = " ".join(formula.split())
        # Capture optional-marked identifiers, then strip the `?` prefix
        # so the result is valid Python syntax for AST parse.
        import re as _re
        optional_names: set = set()
        for m in _re.finditer(r"\?([a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)?)",
                              normalized, _re.IGNORECASE):
            optional_names.add(m.group(1))
        normalized = _re.sub(
            r"\?(?=[a-z_])", "", normalized, flags=_re.IGNORECASE
        )
        # Stash on the resolver so _resolve_identifier can suppress the
        # missing-bucket warning for these names during THIS evaluation.
        self._current_optional = optional_names
        try:
            tree = ast.parse(normalized, mode="eval")
        except SyntaxError as e:
            raise MethodologyError(f"formula syntax error: {normalized!r}: {e}") from e
        return self._eval_node(tree.body)

    # ── AST node walkers ─────────────────────────────────────────
    def _eval_node(self, node: ast.AST) -> float:
        if isinstance(node, ast.Constant):
            if isinstance(node.value, (int, float)):
                return float(node.value)
            raise MethodologyError(f"unsupported literal: {node.value!r}")
        if isinstance(node, ast.Num):  # py<3.8
            return float(node.n)  # type: ignore[attr-defined]
        if isinstance(node, ast.UnaryOp):
            if isinstance(node.op, ast.USub):
                return -self._eval_node(node.operand)
            if isinstance(node.op, ast.UAdd):
                return self._eval_node(node.operand)
            raise MethodologyError(f"unsupported unary op: {type(node.op).__name__}")
        if isinstance(node, ast.BinOp):
            left = self._eval_node(node.left)
            right = self._eval_node(node.right)
            if isinstance(node.op, ast.Add):
                return left + right
            if isinstance(node.op, ast.Sub):
                return left - right
            if isinstance(node.op, ast.Mult):
                return left * right
            if isinstance(node.op, ast.Div):
                if right == 0:
                    raise ZeroDivisionError("division by zero")
                return left / right
            raise MethodologyError(f"unsupported binary op: {type(node.op).__name__}")
        if isinstance(node, ast.Name):
            return self._resolve_identifier(node.id)
        if isinstance(node, ast.Attribute):
            # Only support a single-level `.something` (e.g. `aggregate.net`,
            # `ebitda.reported`, `totals.revenue_net`). The Attribute node
            # has node.value (Name) and node.attr (str).
            if isinstance(node.value, ast.Name):
                return self._resolve_identifier(f"{node.value.id}.{node.attr}")
            raise MethodologyError(
                f"unsupported attribute access: nested {ast.dump(node)!r}"
            )
        raise MethodologyError(f"unsupported AST node: {type(node).__name__}")

    # ── Name resolution ──────────────────────────────────────────
    def _resolve_identifier(self, name: str) -> float:
        """Resolve a token to a float. Handles:
          - `?bucket`           → leaf magnitude, 0 if missing (no warning)
          - `bucket`            → leaf magnitude, 0 if missing (warning logged)
          - `aggregate.net`     → aggregate net sum
          - `ebitda.<variant>`  → previously-computed EBITDA variant
          - `totals.<name>`     → previously-computed total
          - `ratios.<name>`     → previously-computed ratio (.value)
          - `operator_addbacks` → injected by evaluator
        """
        optional = name.startswith("?")
        if optional:
            name = name[1:]
        # An identifier carrying `?` in THIS formula is also considered
        # optional (set by evaluate() before AST walk). resolve_token()
        # path (from base+add/subtract composition) uses the literal `?`
        # prefix instead.
        if name in self._current_optional:
            optional = True

        if name == "operator_addbacks":
            return self.operator_addbacks

        # Namespaced view reference (ebitda.reported, totals.foo, ratios.bar)
        if "." in name:
            head, tail = name.split(".", 1)
            if head in self.view_namespaces:
                ns = self.view_namespaces[head]
                if tail not in ns:
                    if optional:
                        return 0.0
                    raise MethodologyError(f"view '{head}.{tail}' not computed yet")
                value = ns[tail]
                # ratios namespace stores dicts; extract `.value`
                if isinstance(value, dict):
                    return float(value.get("value") or 0.0)
                return float(value)
            # Otherwise treat as `aggregate.net` (canonical aggregate field)
            if tail == "net":
                agg = self.aggregates.get(head)
                if isinstance(agg, dict) and "net" in agg:
                    return float(agg.get("net") or 0.0)
                if optional:
                    self.missing_buckets_seen.add(name)
                    return 0.0
                # Aggregate absent — register and return 0 (don't hard-error;
                # the YAML may reference an aggregate that's empty for this
                # particular fixture). Diagnostic surfaces in missing_buckets.
                self.missing_buckets_seen.add(name)
                return 0.0
            # Some other dot-access (e.g. ebitda.reported.foo) — not supported
            raise MethodologyError(f"unsupported nested reference: {name}")

        # Bare leaf bucket name
        leaf = self.leaves.get(name)
        if isinstance(leaf, dict):
            return float(leaf.get("magnitude") or 0.0)

        # Not found anywhere — optional → 0; required → register + 0
        if optional:
            return 0.0
        self.missing_buckets_seen.add(name)
        return 0.0
