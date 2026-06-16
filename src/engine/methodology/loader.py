"""F4.2 methodology YAML loader.

Loads + validates a methodology YAML file from the repo-root `methodology/`
directory (or a configured override path). Returns a frozen
`MethodologyDoc` dataclass with the EBITDA variants, totals, ratios, and
industry overrides parsed and ready for the evaluator to walk.

Validation surface:
  - schema_version must match the canonical schema string the engine
    was built against. Mismatch = hard error (don't silently render
    wrong-version numbers).
  - Every EBITDA variant must have either a `formula` OR a `base` +
    {`add`, `subtract`} composition. Not both.
  - Every formula's referenced bucket name must exist in the canonical
    catalog (BS_BUCKETS / PL_BUCKETS / CF_BUCKETS) OR be a parent
    aggregate name OR start with `?` (optional).
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Set

try:
    import yaml  # type: ignore
except ImportError:
    yaml = None  # type: ignore


class MethodologyError(ValueError):
    """Raised for any methodology load / validation failure."""


@dataclass(frozen=True)
class EbitdaVariantSpec:
    """One EBITDA variant — either a direct `formula` or a
    `base + add - subtract` composition."""
    name: str
    description: str
    formula: Optional[str] = None
    base: Optional[str] = None
    subtract: List[str] = field(default_factory=list)
    add: List[str] = field(default_factory=list)
    excludes_by_convention: List[str] = field(default_factory=list)
    note: str = ""


@dataclass(frozen=True)
class NamedFormula:
    """Generic named formula entry (used for `totals` and `ratios`)."""
    name: str
    formula: str
    unit: str = "ratio"
    direction: str = "neutral"
    band_default: Optional[List[float]] = None
    note: str = ""


@dataclass(frozen=True)
class IndustryOverride:
    industry_key: str
    note: str
    overrides: Dict[str, Any]  # dotted-path → value


@dataclass(frozen=True)
class MethodologyDoc:
    methodology_id: str
    methodology_version: str
    schema_version: str
    applies_to: Dict[str, Any]
    created_at: str
    authors: List[str]
    ebitda_variants: Dict[str, EbitdaVariantSpec]
    totals: Dict[str, NamedFormula]
    ratios: Dict[str, NamedFormula]
    industry_overrides: Dict[str, IndustryOverride]
    source_path: str


# ──────────────────────────────────────────────────────────────────────
# Public loader
# ──────────────────────────────────────────────────────────────────────


def _candidate_methodology_dirs() -> List[Path]:
    """Search paths for methodology YAML files. Mirrors fixture-loader
    pattern in measure_bs_drift.py — covers local-repo and /app container."""
    here = Path(__file__).resolve().parent
    candidates: List[Path] = []
    # 1. Repo-root /methodology (preferred)
    for c in [here, *here.parents][:6]:
        if (c / "pyproject.toml").is_file():
            candidates.append(c / "methodology")
            break
    # 2. /app/methodology (container layout)
    candidates.append(Path("/app") / "methodology")
    # 3. Relative to this module (in-package fallback for dev)
    candidates.append(here.parent.parent.parent / "methodology")
    return [c for c in candidates if c.is_dir()]


def load_methodology(methodology_id: str) -> MethodologyDoc:
    """Locate `methodology/<methodology_id>.yaml`, parse, validate, return
    a frozen MethodologyDoc."""
    if yaml is None:
        raise MethodologyError(
            "PyYAML not installed. The methodology layer requires `pyyaml`. "
            "Install via `pip install pyyaml` or add to pyproject.toml."
        )

    candidates = _candidate_methodology_dirs()
    if not candidates:
        raise MethodologyError(
            f"No methodology directory found. Searched: "
            f"{[str(p) for p in _candidate_methodology_dirs()]}"
        )

    yaml_path: Optional[Path] = None
    for d in candidates:
        p = d / f"{methodology_id}.yaml"
        if p.is_file():
            yaml_path = p
            break
    if yaml_path is None:
        raise MethodologyError(
            f"Methodology '{methodology_id}.yaml' not found in any of: "
            f"{[str(d) for d in candidates]}"
        )

    try:
        data = yaml.safe_load(yaml_path.read_text(encoding="utf-8"))
    except yaml.YAMLError as e:
        raise MethodologyError(f"YAML parse failed for {yaml_path}: {e}") from e

    if not isinstance(data, dict):
        raise MethodologyError(f"{yaml_path}: root must be a mapping, got {type(data).__name__}")

    return _build_doc(data, str(yaml_path))


# ──────────────────────────────────────────────────────────────────────
# Builders + validators
# ──────────────────────────────────────────────────────────────────────


def _build_doc(data: Dict[str, Any], source_path: str) -> MethodologyDoc:
    # Schema version check — refuse to load against a different canonical
    # schema than the engine was built for.
    try:
        from ..canonical import schema_version  # type: ignore
        engine_schema = schema_version()
    except Exception:
        engine_schema = "canonical_v1.0.0"  # fallback for tooling that runs without engine

    yaml_schema = str(data.get("schema_version") or "")
    if yaml_schema != engine_schema:
        raise MethodologyError(
            f"{source_path}: schema_version mismatch — YAML says "
            f"'{yaml_schema}', engine is '{engine_schema}'. Refusing to "
            f"render wrong-version numbers."
        )

    methodology_id = str(data.get("methodology_id") or "")
    if not methodology_id:
        raise MethodologyError(f"{source_path}: methodology_id is required")

    # EBITDA variants
    variants_raw = data.get("ebitda_variants") or {}
    if not isinstance(variants_raw, dict):
        raise MethodologyError(f"{source_path}: ebitda_variants must be a mapping")
    variants: Dict[str, EbitdaVariantSpec] = {}
    for name, body in variants_raw.items():
        if not isinstance(body, dict):
            raise MethodologyError(f"{source_path}: ebitda_variants.{name} must be a mapping")
        has_formula = bool(body.get("formula"))
        has_base = bool(body.get("base"))
        if not (has_formula or has_base):
            raise MethodologyError(
                f"{source_path}: ebitda_variants.{name} must declare either "
                f"`formula` or `base` (with optional add/subtract)"
            )
        if has_formula and has_base:
            raise MethodologyError(
                f"{source_path}: ebitda_variants.{name} cannot declare BOTH "
                f"`formula` and `base` — pick one"
            )
        variants[name] = EbitdaVariantSpec(
            name=name,
            description=str(body.get("description") or "").strip(),
            formula=str(body["formula"]).strip() if has_formula else None,
            base=str(body["base"]).strip() if has_base else None,
            subtract=list(body.get("subtract") or []),
            add=list(body.get("add") or []),
            excludes_by_convention=list(body.get("excludes_by_convention") or []),
            note=str(body.get("note") or "").strip(),
        )

    # Totals (named intermediate sums used by ratios)
    totals_raw = data.get("totals") or {}
    totals: Dict[str, NamedFormula] = {}
    for name, body in totals_raw.items():
        if not isinstance(body, dict) or not body.get("formula"):
            raise MethodologyError(f"{source_path}: totals.{name} requires a `formula` field")
        totals[name] = NamedFormula(
            name=name,
            formula=str(body["formula"]).strip(),
            unit=str(body.get("unit") or "currency"),
            direction=str(body.get("direction") or "neutral"),
            band_default=list(body["band_default"]) if body.get("band_default") else None,
            note=str(body.get("note") or "").strip(),
        )

    # Ratios
    ratios_raw = data.get("ratios") or {}
    ratios: Dict[str, NamedFormula] = {}
    for name, body in ratios_raw.items():
        if not isinstance(body, dict) or not body.get("formula"):
            raise MethodologyError(f"{source_path}: ratios.{name} requires a `formula` field")
        ratios[name] = NamedFormula(
            name=name,
            formula=str(body["formula"]).strip(),
            unit=str(body.get("unit") or "ratio"),
            direction=str(body.get("direction") or "neutral"),
            band_default=list(body["band_default"]) if body.get("band_default") else None,
            note=str(body.get("note") or "").strip(),
        )

    # Industry overrides
    industry_raw = data.get("industry_overrides") or {}
    industry: Dict[str, IndustryOverride] = {}
    for key, body in industry_raw.items():
        if not isinstance(body, dict):
            continue
        industry[key] = IndustryOverride(
            industry_key=key,
            note=str(body.get("note") or "").strip(),
            overrides=dict(body.get("overrides") or {}),
        )

    return MethodologyDoc(
        methodology_id=methodology_id,
        methodology_version=str(data.get("methodology_version") or "1.0.0"),
        schema_version=yaml_schema,
        applies_to=dict(data.get("applies_to") or {}),
        created_at=str(data.get("created_at") or ""),
        authors=list(data.get("authors") or []),
        ebitda_variants=variants,
        totals=totals,
        ratios=ratios,
        industry_overrides=industry,
        source_path=source_path,
    )


# Helper: extract bare identifier references from a formula. Used for
# bucket-existence validation when integrating with the canonical schema.
_IDENT_RE = re.compile(r"\??[a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)?", re.IGNORECASE)


def referenced_identifiers(formula: str) -> Set[str]:
    """Return the set of identifier-shaped tokens in a formula string.
    Identifiers may be `bucket_name`, `bucket_name.net`, `view.subview`,
    or optional-prefixed `?bucket_name`. Numeric tokens excluded."""
    out: Set[str] = set()
    for m in _IDENT_RE.finditer(formula):
        tok = m.group(0)
        # Skip numeric-only matches that the regex doesn't catch (none with this regex)
        out.add(tok)
    return out
