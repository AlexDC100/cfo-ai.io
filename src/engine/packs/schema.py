"""Typed, immutable in-memory form of a JURISDICTION DATA PACK (Part C).

A *pack* is a data directory (YAML files, no code) describing one
jurisdiction's accounting rules for one effective window:

    pack.yaml            identity: jurisdiction, pack_id, version,
                         effective_from / effective_to, legal sources,
                         changelog
    classification.yaml  account-code -> statement-line rules (exact |
                         prefix | numeric range), contra flags,
                         balance-side-conditional side_flip re-routes;
                         OPTIONAL `prompt_guidance` (Phase 4, AI-lane
                         prompt-from-pack): header prose + class_map
                         entries + footer prose the LLM classify prompt
                         renders — jurisdictions whose classification is
                         LLM-driven (HU/INTL) carry their chart logic
                         here instead of in engine code
    checks.yaml          declarative check configs (D0-D9 + per-
                         jurisdiction ids); escape hatch: named impl
                         refs into the engine-side CHECK_IMPLS registry
    statement_map.yaml   the canonical statement-line tree (BS / PL);
                         its ids must cover every classification target
    reconcile.yaml       auto-reconcile threshold, placement rules,
                         adjustment labels per language
    confirmed_mappings.yaml
                         OPTIONAL overlay (Phase 4): human-confirmed
                         account-code -> line_id memoizations, loaded as
                         HIGHEST-PRECEDENCE exact rules (rule_id
                         "confirmed.<code>", appended after the base
                         rules so the exact index resolves them last-
                         wins over any base rule for the same code).
                         Covered by pack_hash like every other rule, so
                         adding/editing a confirmation re-versions the
                         pack content (and with it the AI-lane classify
                         prompt_version and cache key).

Both optional additions are BACKWARD-COMPATIBLE within pack1: packs
without them load exactly as before, and their canonical_form (the
pack_hash input) is unchanged — the new sections only enter the hash
when present.

This module owns the TYPES (frozen dataclasses, deep-frozen mappings),
the typed error hierarchy, and the engine-side ``CHECK_IMPLS`` registry.
Parsing/validation/compilation lives in ``loader.py``; static analysis
in ``lint.py``.

SHADOW-PHASE LEAF. Nothing in the production pipeline imports this
package yet (zero behavior change; the golden corpus is untouched by
construction). The only engine coupling is the pair of built-in check
impls, and those import lazily INSIDE the wrapper functions so the
package stays import-leaf.

Immutability follows the ``engine.ir`` discipline: all dataclasses are
frozen, sequences are tuples, and JSON-shaped bags (check params,
placement rules, labels) are deep-frozen (dict -> ``MappingProxyType``,
list -> tuple) so no caller can alias-mutate a compiled pack.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from types import MappingProxyType
from typing import Any, Callable, Dict, List, Mapping, Optional, Tuple

__all__ = [
    "PACK_SCHEMA_VERSION",
    "KNOWN_DECLARATIVE_CHECK_IDS",
    "RECONCILE_PLACEMENTS",
    "PackError",
    "PackSchemaError",
    "PackResolutionError",
    "NoPackFoundError",
    "AmbiguousPackError",
    "PackIssue",
    "LegalSource",
    "ChangelogEntry",
    "PackIdentity",
    "SideFlip",
    "ClassificationRule",
    "CheckConfig",
    "StatementNode",
    "ReconcilePolicy",
    "CompiledPack",
    "register_check_impl",
    "unregister_check_impl",
    "registered_check_impls",
    "freeze_json",
    "thaw_json",
]


#: Version of the pack DATA schema itself (not of any one pack). Bump
#: with a migration note when the YAML shape changes; loaders refuse
#: foreign versions rather than parsing leniently (mirrors IR_VERSION).
PACK_SCHEMA_VERSION = "pack1"

#: The declarative check vocabulary a pack may configure WITHOUT naming
#: an impl: the canonical_bs v2 diagnosis codes (docs/
#: CANONICAL_BS_V2_CONTRACT.md, emitted by engine.confidence.
#: reconciliation_checks.run_bs_diagnosis). Any OTHER check_id is
#: per-jurisdiction and MUST carry an ``impl`` ref registered in
#: CHECK_IMPLS — that is the escape hatch, and it is registry-gated so a
#: data pack can never name engine code that does not exist.
KNOWN_DECLARATIVE_CHECK_IDS = frozenset(
    {
        "D0_ANCHOR_DIVERGENCE",
        "D1_SOURCE_IMBALANCED",
        "D2_FINGERPRINT",
        "D3_CONTRA_MISPLACED",
        "D4_BIFUNCTIONAL_SIDE",
        "D5_DUPLICATE_ROWS",
        "D6_121_MISMATCH",
        "D7_MAGNITUDE",
        "D8_OMITTED",
        "D9_UNMAPPED_INCLUDED",
    }
)

#: Reconcile placement vocabulary (operator spec / AUTO-RECONCILE
#: addendum): one visible adjustment line, either on the balance sheet
#: or routed to the P&L by the delta's sign.
RECONCILE_PLACEMENTS = frozenset({"bs", "pl_other_income", "pl_other_expense"})


# --- errors -----------------------------------------------------------------


class PackError(ValueError):
    """Base for every pack loading / resolution failure."""


class PackSchemaError(PackError):
    """A pack directory does not conform to the pack1 schema.

    Carries the FULL issue list (``.issues``) so lint can surface every
    problem in one pass instead of stopping at the first."""

    def __init__(self, issues: Tuple["PackIssue", ...]):
        self.issues = issues
        lines = ["pack schema invalid (%d issue%s):" % (
            len(issues), "" if len(issues) == 1 else "s")]
        lines.extend("  [%s] %s: %s" % (i.code, i.where or i.file or "-", i.message)
                     for i in issues)
        super().__init__("\n".join(lines))


class PackResolutionError(PackError):
    """Base for effective-dated resolution failures."""


class NoPackFoundError(PackResolutionError):
    """No pack version's [effective_from, effective_to) window contains
    the requested period_end for the requested jurisdiction."""


class AmbiguousPackError(PackResolutionError):
    """More than one pack version's window contains the requested
    period_end — the pack data has overlapping effective ranges and must
    be fixed (lint reports this as ``effective-overlap``)."""


# --- issue record (shared by loader validation and lint) --------------------


@dataclass(frozen=True)
class PackIssue:
    """One validation / lint finding. ``severity`` is 'error' or
    'warning'; ``code`` is a stable kebab-case identifier tests and CI
    can key on; ``file`` is the pack-relative filename; ``where`` is a
    human path inside the file (rule id, node id, ...)."""

    severity: str
    code: str
    message: str
    file: Optional[str] = None
    where: Optional[str] = None

    def render(self) -> str:
        loc = ":".join(p for p in (self.file, self.where) if p)
        return "%-7s %-28s %s%s" % (
            self.severity.upper(), self.code,
            ("[%s] " % loc) if loc else "", self.message,
        )


# --- deep freeze / thaw for JSON-shaped bags --------------------------------


def freeze_json(value: Any, path: str = "value") -> Any:
    """Recursively convert JSON-shaped data into immutable equivalents:
    dict -> MappingProxyType over a fresh dict, list/tuple -> tuple.
    Scalars pass through. Non-JSON-shaped input raises PackError — the
    compiled pack must stay serializable and hash-stable."""
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, (list, tuple)):
        return tuple(
            freeze_json(v, "%s[%d]" % (path, i)) for i, v in enumerate(value)
        )
    if isinstance(value, (dict, MappingProxyType)):
        frozen: Dict[str, Any] = {}
        for k in value:
            if not isinstance(k, str):
                raise PackError(
                    "%s: mapping keys must be str, got %s" % (path, type(k).__name__)
                )
            frozen[k] = freeze_json(value[k], "%s.%s" % (path, k))
        return MappingProxyType(frozen)
    raise PackError(
        "%s: unsupported value type %s — pack data must be JSON-shaped"
        % (path, type(value).__name__)
    )


def thaw_json(value: Any) -> Any:
    """Inverse of freeze_json: fresh plain dict/list structures with no
    aliasing into the frozen pack (safe for json.dumps)."""
    if isinstance(value, (dict, MappingProxyType)):
        return {k: thaw_json(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [thaw_json(v) for v in value]
    return value


# --- CHECK_IMPLS — the engine-side named-implementation registry ------------

#: impl-ref id -> engine callable. Packs may ONLY reference ids present
#: here at load time; an unknown ref is a schema error (the loader
#: prints the registered ids). The registry maps NAMES to code — the
#: pack stays pure data.
CHECK_IMPLS: Dict[str, Callable[..., Any]] = {}


def register_check_impl(impl_id: str, fn: Callable[..., Any]) -> None:
    """Register an engine-side check implementation under ``impl_id``.
    Re-registering an existing id raises — silent replacement would let
    two engine modules fight over a name."""
    if not isinstance(impl_id, str) or not impl_id.strip():
        raise PackError("impl_id must be a non-empty str, got %r" % (impl_id,))
    if not callable(fn):
        raise PackError("check impl %r must be callable" % (impl_id,))
    if impl_id in CHECK_IMPLS:
        raise PackError("check impl %r already registered" % (impl_id,))
    CHECK_IMPLS[impl_id] = fn


def unregister_check_impl(impl_id: str) -> None:
    """Remove a registered impl (tests / ops teardown). Unknown id raises."""
    if impl_id not in CHECK_IMPLS:
        raise PackError("check impl %r is not registered" % (impl_id,))
    del CHECK_IMPLS[impl_id]


def registered_check_impls() -> Tuple[str, ...]:
    """Sorted snapshot of the registered impl ids (for error messages)."""
    return tuple(sorted(CHECK_IMPLS))


def _builtin_bs_diagnosis(*args: Any, **kwargs: Any) -> Any:
    """Built-in impl: the canonical_bs v2 D0-D8 diagnosis pass.
    Lazy import keeps this package an import-leaf."""
    from engine.confidence.reconciliation_checks import run_bs_diagnosis

    return run_bs_diagnosis(*args, **kwargs)


def _builtin_reconciliation_identities(*args: Any, **kwargs: Any) -> Any:
    """Built-in impl: the assembled-output accounting-identity checks
    (debits=credits, A=L+E, P&L rollups). Lazy import — see above."""
    from engine.confidence.reconciliation_checks import run_reconciliation_checks

    return run_reconciliation_checks(*args, **kwargs)


CHECK_IMPLS["builtin.bs_diagnosis"] = _builtin_bs_diagnosis
CHECK_IMPLS["builtin.reconciliation_identities"] = _builtin_reconciliation_identities


# --- identity ---------------------------------------------------------------


@dataclass(frozen=True)
class LegalSource:
    """One legal citation backing the pack (statute, order, standard)."""

    citation: str
    url: Optional[str] = None


@dataclass(frozen=True)
class ChangelogEntry:
    version: str
    date: str  # ISO YYYY-MM-DD (kept verbatim; identity dates are parsed)
    notes: str


@dataclass(frozen=True)
class PackIdentity:
    """pack.yaml — who this pack is and WHEN it applies.

    ``effective_from`` / ``effective_to`` bound the half-open window
    [effective_from, effective_to) in which the pack governs a
    period_end; ``effective_to`` None means open-ended."""

    jurisdiction: str
    pack_id: str
    version: str
    effective_from: date
    effective_to: Optional[date]
    legal_sources: Tuple[LegalSource, ...]
    changelog: Tuple[ChangelogEntry, ...]

    def contains(self, period_end: date) -> bool:
        if period_end < self.effective_from:
            return False
        return self.effective_to is None or period_end < self.effective_to


# --- classification ---------------------------------------------------------


@dataclass(frozen=True)
class SideFlip:
    """Balance-side-conditional re-route: when the account's CLOSING
    balance lands on ``side`` (the side OPPOSITE the rule's natural
    one), the amount belongs on ``line_id`` instead of the rule's
    target — e.g. RO 4111 closing CREDIT is customer advances received,
    never negative receivables (BIFUNCTIONAL_WRONG_SIDE_FLIPS)."""

    side: str  # 'debit' | 'credit'
    line_id: str


@dataclass(frozen=True)
class ClassificationRule:
    """One classification rule. Exactly one of exact / prefix / range
    is set (enforced by the loader). Precedence at match time is fixed:
    exact > longest-prefix > range (ranges in declaration order).

    ``range`` semantics: both bounds are digit strings of equal length
    L; a code matches when its first L digits, read as an integer, fall
    within [range_from, range_to] inclusive — i.e. the contiguous
    prefix band 391..398 covers 391xxx through 398xxx.

    ``contra`` marks a contra line (sign -1 against its target — e.g.
    accumulated depreciation, allowances); the flag is data for the
    consumer, the loader only carries it."""

    rule_id: str
    kind: str  # 'exact' | 'prefix' | 'range'
    line_id: str
    exact: Optional[str] = None
    prefix: Optional[str] = None
    range_from: Optional[str] = None
    range_to: Optional[str] = None
    contra: bool = False
    side_flip: Optional[SideFlip] = None
    description: str = ""

    def matches(self, code: str) -> bool:
        if self.kind == "exact":
            return code == self.exact
        if self.kind == "prefix":
            return code.startswith(self.prefix or "")
        # range
        L = len(self.range_from or "")
        head = code[:L]
        if len(head) < L or not head.isdigit():
            return False
        return int(self.range_from or "0") <= int(head) <= int(self.range_to or "0")


# --- checks -----------------------------------------------------------------


@dataclass(frozen=True)
class CheckConfig:
    """One declarative check config. ``check_id`` is either a known
    declarative id (D0-D9) or a per-jurisdiction id that MUST name an
    ``impl`` registered in CHECK_IMPLS. ``params`` is a deep-frozen
    JSON-shaped bag passed to the implementation."""

    check_id: str
    enabled: bool = True
    impl: Optional[str] = None
    params: Mapping[str, Any] = field(default_factory=lambda: MappingProxyType({}))


# --- statement map ----------------------------------------------------------


@dataclass(frozen=True)
class StatementNode:
    """One node of the canonical statement-line tree. Leaves (no
    children) are the classifiable targets; parents are presentation
    subtotals."""

    id: str
    label: str
    children: Tuple["StatementNode", ...] = ()

    @property
    def is_leaf(self) -> bool:
        return not self.children


# --- reconcile --------------------------------------------------------------


@dataclass(frozen=True)
class ReconcilePolicy:
    """reconcile.yaml — auto-reconcile policy knobs.

    ``threshold``: max |difference| / max(assets, E+L) ratio eligible
    for auto-reconcile (contract value 0.001). ``placement_rules``:
    diagnosed cause -> placement ('bs' | 'pl_other_income' |
    'pl_other_expense'); the 'default' cause is required.
    ``adjustment_labels``: language -> visible adjustment-line label
    (e.g. ro: 'Diferențe de reconciliere')."""

    threshold: float
    placement_rules: Mapping[str, str]
    adjustment_labels: Mapping[str, str]

    def placement_for(self, cause: str) -> str:
        return self.placement_rules.get(cause, self.placement_rules["default"])

    def label_for(self, language: str) -> str:
        if language in self.adjustment_labels:
            return self.adjustment_labels[language]
        # deterministic fallback: first language by sorted key
        first = sorted(self.adjustment_labels)[0]
        return self.adjustment_labels[first]


# --- the compiled pack ------------------------------------------------------


@dataclass(frozen=True)
class CompiledPack:
    """The immutable, validated, index-compiled in-memory pack.

    ``exact_index`` / ``prefix_index`` / ``range_rules`` are DERIVED
    from ``rules`` at load time (read-only mappings): exact lookup is
    O(1), prefix lookup walks the code's own prefixes longest-first
    (O(len(code))), ranges scan in declaration order. ``pack_hash`` is
    sha256 over the canonical serialized pack CONTENT (sorted-key
    compact JSON of ``canonical_form``), so two loads of the same data
    hash identically regardless of file formatting, comments, or
    directory path, while ANY semantic change changes the hash.
    """

    identity: PackIdentity
    rules: Tuple[ClassificationRule, ...]
    checks: Tuple[CheckConfig, ...]
    balance_sheet: Tuple[StatementNode, ...]
    profit_loss: Tuple[StatementNode, ...]
    reconcile: ReconcilePolicy
    pack_hash: str
    schema_version: str = PACK_SCHEMA_VERSION
    #: Optional LLM-prompt guidance (deep-frozen mapping) — header prose,
    #: class_map entries ({digit, name, guidance}), footer prose. None for
    #: packs whose classification is fully deterministic (e.g. RO).
    prompt_guidance: Optional[Mapping[str, Any]] = None
    # derived indexes (built by the loader; equality-safe read-only views)
    exact_index: Mapping[str, ClassificationRule] = field(
        default_factory=lambda: MappingProxyType({})
    )
    prefix_index: Mapping[str, ClassificationRule] = field(
        default_factory=lambda: MappingProxyType({})
    )
    range_rules: Tuple[ClassificationRule, ...] = ()

    # -- lookup ------------------------------------------------------------

    def match(self, code: str) -> Optional[ClassificationRule]:
        """The winning rule for an account code under the fixed
        precedence exact > longest-prefix > range, or None (unmapped)."""
        hit = self.exact_index.get(code)
        if hit is not None:
            return hit
        for length in range(len(code), 0, -1):
            hit = self.prefix_index.get(code[:length])
            if hit is not None:
                return hit
        for rule in self.range_rules:
            if rule.matches(code):
                return rule
        return None

    def target_line(
        self, code: str, closing_side: Optional[str] = None
    ) -> Optional[str]:
        """The statement line an account code routes to; applies the
        rule's side_flip when ``closing_side`` ('debit'|'credit') equals
        the flip side. None when the code is unmapped."""
        rule = self.match(code)
        if rule is None:
            return None
        if (
            rule.side_flip is not None
            and closing_side is not None
            and closing_side == rule.side_flip.side
        ):
            return rule.side_flip.line_id
        return rule.line_id

    # -- introspection -----------------------------------------------------

    def statement_line_ids(self) -> Tuple[str, ...]:
        """Every node id in the statement map, document order."""
        out: List[str] = []

        def walk(nodes: Tuple[StatementNode, ...]) -> None:
            for n in nodes:
                out.append(n.id)
                walk(n.children)

        walk(self.balance_sheet)
        walk(self.profit_loss)
        return tuple(out)

    def leaf_line_ids(self) -> Tuple[str, ...]:
        out: List[str] = []

        def walk(nodes: Tuple[StatementNode, ...]) -> None:
            for n in nodes:
                if n.is_leaf:
                    out.append(n.id)
                walk(n.children)

        walk(self.balance_sheet)
        walk(self.profit_loss)
        return tuple(out)

    # -- canonical serialization (the hash input) --------------------------

    def canonical_form(self) -> Dict[str, Any]:
        """Plain JSON-shaped dict of the pack CONTENT — the normalized
        data the pack_hash is computed over. Excludes everything
        run-specific (paths, load order) and the hash itself.

        `prompt_guidance` enters the form ONLY when present, so packs
        predating the Phase-4 optional sections keep their exact
        pre-extension hash (confirmed-mapping overlay rules ride inside
        `classification` like every other rule)."""
        ident = self.identity
        form: Dict[str, Any] = {
            "schema_version": self.schema_version,
            "identity": {
                "jurisdiction": ident.jurisdiction,
                "pack_id": ident.pack_id,
                "version": ident.version,
                "effective_from": ident.effective_from.isoformat(),
                "effective_to": (
                    ident.effective_to.isoformat()
                    if ident.effective_to is not None else None
                ),
                "legal_sources": [
                    {"citation": s.citation, "url": s.url}
                    for s in ident.legal_sources
                ],
                "changelog": [
                    {"version": c.version, "date": c.date, "notes": c.notes}
                    for c in ident.changelog
                ],
            },
            "classification": [
                {
                    "rule_id": r.rule_id,
                    "kind": r.kind,
                    "exact": r.exact,
                    "prefix": r.prefix,
                    "range_from": r.range_from,
                    "range_to": r.range_to,
                    "line_id": r.line_id,
                    "contra": r.contra,
                    "side_flip": (
                        {"side": r.side_flip.side, "line_id": r.side_flip.line_id}
                        if r.side_flip is not None else None
                    ),
                    "description": r.description,
                }
                for r in self.rules
            ],
            "checks": [
                {
                    "check_id": c.check_id,
                    "enabled": c.enabled,
                    "impl": c.impl,
                    "params": thaw_json(c.params),
                }
                for c in self.checks
            ],
            "statement_map": {
                "balance_sheet": [_node_form(n) for n in self.balance_sheet],
                "profit_loss": [_node_form(n) for n in self.profit_loss],
            },
            "reconcile": {
                "threshold": self.reconcile.threshold,
                "placement_rules": thaw_json(self.reconcile.placement_rules),
                "adjustment_labels": thaw_json(self.reconcile.adjustment_labels),
            },
        }
        if self.prompt_guidance is not None:
            form["prompt_guidance"] = thaw_json(self.prompt_guidance)
        return form


def _node_form(node: StatementNode) -> Dict[str, Any]:
    return {
        "id": node.id,
        "label": node.label,
        "children": [_node_form(c) for c in node.children],
    }
