"""Industry detection service — Phase B.

WHAT
====
Given a period's signals (organization CAEN, financial metrics, optional
activity text), pick the best `industry_key` from `industry_profiles`,
ranked by source priority, with a confidence score.

PRIORITY ORDER (highest first)
==============================
0. **Locked user assignment** — `company_industry_assignments.locked_by_user`
   is true for this period. Detection returns the locked value verbatim;
   nothing else is consulted. This is the immutable user intent.

1. **CAEN exact match** — `organizations.caen_code` resolves through
   `caen_industry_mappings` (match_quality='exact'). Confidence is the
   mapping's stored `confidence` field (typically 0.85–0.95).

2. **CAEN close match** — same lookup, match_quality='close'. Confidence
   ~0.65–0.80. The UI should surface the next-best alternatives too.

3. **Activity-text keyword** — substring match of
   `organizations.activity_description` against `industry_aliases.alias`.
   Per-row confidence weighted by alias.weight (0.5–0.8 typical).

4. **Cost-structure heuristic** — calls the legacy
   `_industry_classifier.suggest_caen_code`, then re-resolves the
   suggested CAEN through `caen_industry_mappings`. Confidence is the
   classifier confidence × 0.9 (small haircut: the classifier sees only
   the cost structure, not the company name / activity description).

5. **Sector fallback** — CAEN matched but only at sector level
   (match_quality='sector_fallback'). Confidence 0.40–0.55.

6. **Universal fallback** — nothing resolved. Returns the
   `manufacturing_generic` (or `professional_services_generic` for
   service-style cost structures) at confidence 0.30.

The returned `DetectionResult` always contains:
  - primary: the top candidate (industry_key, source, confidence, match_quality)
  - candidates: a deduped ranked list (top 5) of all considered industries
  - rationale: human-readable explanation of why primary won

The HTTP route in `_industry_intelligence.py` is the only caller; this
file is testable in isolation via the bottom-of-file `__main__` block.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

from . import _supabase
from ._industry_classifier import suggest_caen_code


logger = logging.getLogger(__name__)


# ──────────────────────────────────────────────────────────────────────
# Data shapes
# ──────────────────────────────────────────────────────────────────────

# Source enum — MUST match the CHECK constraint on
# company_industry_assignments.source. Keep in sync with the migration.
SOURCE_USER_OVERRIDE       = "user_override"
SOURCE_AUTO_CAEN           = "auto_caen"
SOURCE_AUTO_KEYWORD        = "auto_keyword"
SOURCE_AUTO_ACCOUNT_STRUCT = "auto_account_structure"
SOURCE_AUTO_ACTIVITY_TEXT  = "auto_activity_text"
SOURCE_FALLBACK            = "fallback"


@dataclass
class Candidate:
    """One industry guess. Ranked by `confidence` desc; ties broken by
    source priority (auto_caen > activity_text > account_structure > fallback)."""
    industry_key: str
    parent_industry_key: Optional[str]
    display_name: Optional[str]
    source: str
    confidence: float
    match_quality: Optional[str] = None      # 'exact' | 'close' | 'sector_fallback' | None
    rationale: str = ""


@dataclass
class DetectionResult:
    """Output of `detect_industry_for_period`."""
    primary: Optional[Candidate]
    candidates: List[Candidate] = field(default_factory=list)
    # Echo back the inputs we considered — useful for UI debugging and
    # for the audit log payload on subsequent reassignments.
    inputs: Dict[str, Any] = field(default_factory=dict)
    # If a locked assignment short-circuited everything else.
    locked: bool = False


# ──────────────────────────────────────────────────────────────────────
# Pure helpers (no DB) — testable in isolation
# ──────────────────────────────────────────────────────────────────────

# Source-priority order for tie-breaking when confidences match. Lower
# index = stronger preference. user_override and locked-assignment skip
# this list entirely (handled by the caller).
_SOURCE_TIEBREAK: List[str] = [
    SOURCE_AUTO_CAEN,
    SOURCE_AUTO_ACTIVITY_TEXT,
    SOURCE_AUTO_KEYWORD,
    SOURCE_AUTO_ACCOUNT_STRUCT,
    SOURCE_FALLBACK,
]


def _tiebreak(c: Candidate) -> Tuple[float, int]:
    """Sort key: -confidence, then source priority. Negation puts higher
    confidence first when used with `sorted(...)` ascending."""
    try:
        prio = _SOURCE_TIEBREAK.index(c.source)
    except ValueError:
        prio = len(_SOURCE_TIEBREAK)
    return (-float(c.confidence), prio)


def _dedupe_candidates(cands: List[Candidate]) -> List[Candidate]:
    """Keep the highest-confidence row per (industry_key)."""
    best: Dict[str, Candidate] = {}
    for c in cands:
        existing = best.get(c.industry_key)
        if existing is None or c.confidence > existing.confidence:
            best[c.industry_key] = c
    return list(best.values())


def _normalize_caen(caen: Optional[str]) -> Optional[str]:
    """Normalize a CAEN code to the storage form (4-digit string, leading
    zero preserved). Returns None for blank inputs."""
    if not caen:
        return None
    s = str(caen).strip()
    if not s:
        return None
    # Strip any non-numeric prefix (e.g. user pastes "CAEN 1013")
    digits = "".join(ch for ch in s if ch.isdigit())
    if not digits:
        return None
    # Standardize to 4 digits if 3 — Romanian CAENs are 4-digit canonical.
    if len(digits) == 3:
        digits = "0" + digits
    return digits[:4]


# ──────────────────────────────────────────────────────────────────────
# Catalog lookups
# ──────────────────────────────────────────────────────────────────────

def _resolve_caen(client: Any, caen_code: str) -> Optional[Dict[str, Any]]:
    """Read one row from caen_industry_mappings. Returns None on miss."""
    rows = client.select(
        "caen_industry_mappings",
        filters={"caen_code": f"eq.{caen_code}"},
        columns=(
            "caen_code,caen_label_en,caen_label_ro,industry_key,"
            "parent_industry_key,match_quality,confidence"
        ),
    )
    return rows[0] if rows else None


def _industry_display_name(client: Any, industry_key: str) -> Optional[str]:
    """Read display_name for an industry_key. Returns None if not found
    (e.g., catalog drift; should not happen after a clean Phase A load)."""
    rows = client.select(
        "industry_profiles",
        filters={"key": f"eq.{industry_key}", "is_active": "eq.true"},
        columns="key,display_name,parent_key,sector",
    )
    return rows[0].get("display_name") if rows else None


def _aliases_matching_text(client: Any, text: str) -> List[Dict[str, Any]]:
    """Find aliases whose lowercase form appears as a substring of `text`.
    Done in two PostgREST queries (one per language) keeps the surface
    narrow — full-text search is overkill at our catalog size."""
    if not text or len(text) < 3:
        return []
    needle = text.lower()
    # We can't do substring-on-CLIENT-side from PostgREST; pull all
    # aliases (the table is small, <500 rows) and filter in-process.
    rows = client.select(
        "industry_aliases",
        columns="industry_key,alias,alias_lang,weight",
    )
    matches: List[Dict[str, Any]] = []
    for r in rows:
        alias = (r.get("alias") or "").lower().strip()
        if alias and len(alias) >= 3 and alias in needle:
            matches.append(r)
    return matches


# ──────────────────────────────────────────────────────────────────────
# Signal-level builders (each returns 0+ Candidates)
# ──────────────────────────────────────────────────────────────────────

def _candidates_from_caen(client: Any, caen: Optional[str]) -> List[Candidate]:
    """Resolve a CAEN code to one or more industry candidates."""
    norm = _normalize_caen(caen)
    if not norm:
        return []
    row = _resolve_caen(client, norm)
    if not row:
        return []
    industry_key = row["industry_key"]
    quality = row.get("match_quality") or "exact"
    # Sector-fallback comes back as low confidence; surface as
    # SOURCE_FALLBACK so the UI knows we're guessing.
    if quality == "sector_fallback":
        src = SOURCE_FALLBACK
        rationale = (
            f"CAEN {norm} is in the sector-fallback band — no precise "
            f"sub-industry mapping yet. Resolved to '{industry_key}' "
            f"via its parent sector."
        )
    else:
        src = SOURCE_AUTO_CAEN
        rationale = (
            f"CAEN {norm} resolves to '{industry_key}' "
            f"(match_quality={quality}, confidence={row.get('confidence')})."
        )
    return [Candidate(
        industry_key=industry_key,
        parent_industry_key=row.get("parent_industry_key"),
        display_name=_industry_display_name(client, industry_key),
        source=src,
        confidence=float(row.get("confidence") or 0.5),
        match_quality=quality,
        rationale=rationale,
    )]


def _candidates_from_activity_text(client: Any,
                                    activity_text: Optional[str]) -> List[Candidate]:
    """Match the company's free-form activity description against aliases."""
    if not activity_text:
        return []
    matches = _aliases_matching_text(client, activity_text)
    if not matches:
        return []
    # Aggregate by industry — multiple alias hits on the same industry
    # add weight (cap at 0.85 so this never beats a real exact CAEN).
    by_industry: Dict[str, float] = {}
    by_alias: Dict[str, List[str]] = {}
    for m in matches:
        k = m["industry_key"]
        w = float(m.get("weight") or 1.0)
        by_industry[k] = min(0.85, by_industry.get(k, 0.0) + 0.25 * w)
        by_alias.setdefault(k, []).append(m["alias"])
    out: List[Candidate] = []
    for industry_key, conf in by_industry.items():
        aliases_hit = ", ".join(by_alias[industry_key][:3])
        out.append(Candidate(
            industry_key=industry_key,
            parent_industry_key=None,
            display_name=_industry_display_name(client, industry_key),
            source=SOURCE_AUTO_ACTIVITY_TEXT,
            confidence=conf,
            match_quality=None,
            rationale=(
                f"Activity description matched alias(es): {aliases_hit}."
            ),
        ))
    return out


def _candidates_from_cost_structure(client: Any,
                                     metrics: Optional[Dict[str, float]]) -> List[Candidate]:
    """Run the legacy structural classifier and resolve its CAEN guess."""
    if not metrics:
        return []
    caen, label, conf = suggest_caen_code(metrics)
    if not caen:
        return []
    row = _resolve_caen(client, caen)
    if not row:
        # Classifier returned a CAEN that isn't in our mapping table —
        # silently drop (this means we have a coverage gap and the
        # classifier rule is talking past the mapping yaml).
        return []
    # Haircut: structural classifier is less authoritative than a real
    # CAEN registry hit, so cap and reduce.
    confidence = min(0.75, float(conf) * 0.9)
    return [Candidate(
        industry_key=row["industry_key"],
        parent_industry_key=row.get("parent_industry_key"),
        display_name=_industry_display_name(client, row["industry_key"]),
        source=SOURCE_AUTO_ACCOUNT_STRUCT,
        confidence=confidence,
        match_quality=row.get("match_quality"),
        rationale=(
            f"Cost structure matches '{label}' pattern (CAEN {caen}, "
            f"classifier confidence {conf:.2f}). Mapped via "
            f"caen_industry_mappings to '{row['industry_key']}'."
        ),
    )]


def _universal_fallback(client: Any,
                        metrics: Optional[Dict[str, float]]) -> Candidate:
    """When NOTHING else resolved. Picks `professional_services_generic`
    for service-shaped cost structures (high personnel %, low COGS) and
    `manufacturing_generic` otherwise."""
    is_services_like = False
    if metrics:
        revenue = float(
            metrics.get("total_operating_revenue") or metrics.get("revenue") or 0
        )
        personnel = float(metrics.get("opex_personnel") or 0)
        cogs = float(metrics.get("cogs") or 0)
        if revenue > 0:
            personnel_pct = personnel / revenue
            cogs_pct = cogs / revenue
            is_services_like = personnel_pct > 0.35 and cogs_pct < 0.20
    key = "professional_services_generic" if is_services_like else "manufacturing_generic"
    return Candidate(
        industry_key=key,
        parent_industry_key=None,
        display_name=_industry_display_name(client, key),
        source=SOURCE_FALLBACK,
        confidence=0.30,
        match_quality=None,
        rationale=(
            "No CAEN, activity text or recognizable cost-structure signal — "
            f"defaulted to '{key}'. User must pick the correct industry."
        ),
    )


# ──────────────────────────────────────────────────────────────────────
# Public entrypoints
# ──────────────────────────────────────────────────────────────────────

def detect_from_signals(client: Any,
                         caen_code: Optional[str] = None,
                         activity_text: Optional[str] = None,
                         metrics: Optional[Dict[str, float]] = None,
                         ) -> DetectionResult:
    """Pure-input detection — used by tests and by the period-based
    detector once it's pulled the signals out of the DB. `client` must
    be an active SupabaseClient (admin or per_user — catalog reads work
    either way per RLS)."""
    cands: List[Candidate] = []
    cands += _candidates_from_caen(client, caen_code)
    cands += _candidates_from_activity_text(client, activity_text)
    cands += _candidates_from_cost_structure(client, metrics)
    cands = _dedupe_candidates(cands)
    cands.sort(key=_tiebreak)
    if not cands:
        fallback = _universal_fallback(client, metrics)
        cands = [fallback]
    return DetectionResult(
        primary=cands[0] if cands else None,
        candidates=cands[:5],
        inputs={
            "caen_code": _normalize_caen(caen_code),
            "has_activity_text": bool(activity_text),
            "has_metrics": bool(metrics),
        },
    )


def detect_industry_for_period(client: Any,
                                 period_id: str,
                                 org_id: str) -> DetectionResult:
    """Resolve signals for a period and run detection.

    Reads (all via the SupabaseClient `client`):
      · company_industry_assignments[period_id] — if locked, return immediately
      · organizations[org_id].caen_code + organizations[org_id].activity_description
      · calculated_metrics[period_id] — cost-structure flat dict

    The caller is responsible for using an RLS-scoped client (per_user)
    for the tenant tables; we use admin() implicitly via the catalog
    helpers above, which is safe because catalog rows are world-readable
    to any authenticated session.
    """
    # ── (0) locked assignment short-circuit ────────────────────────
    existing = client.select(
        "company_industry_assignments",
        filters={"period_id": f"eq.{period_id}"},
        columns=(
            "selected_industry_key,source,confidence,locked_by_user,"
            "detected_industry_key"
        ),
    )
    if existing and existing[0].get("locked_by_user"):
        row = existing[0]
        with _supabase.admin() as ac:
            display = _industry_display_name(ac, row["selected_industry_key"])
            ind_row = ac.select(
                "industry_profiles",
                filters={"key": f"eq.{row['selected_industry_key']}"},
                columns="key,parent_key",
            )
        parent = ind_row[0].get("parent_key") if ind_row else None
        c = Candidate(
            industry_key=row["selected_industry_key"],
            parent_industry_key=parent,
            display_name=display,
            source=SOURCE_USER_OVERRIDE,
            confidence=float(row.get("confidence") or 1.0),
            match_quality=None,
            rationale="User has locked this assignment; auto-detection skipped.",
        )
        return DetectionResult(primary=c, candidates=[c], locked=True,
                               inputs={"locked_assignment_present": True})

    # ── (1) gather signals ────────────────────────────────────────
    caen_code: Optional[str] = None
    activity_text: Optional[str] = None
    with _supabase.admin() as ac:
        org_rows = ac.select(
            "organizations",
            filters={"id": f"eq.{org_id}"},
            columns="id,name,caen_code",
        )
        if org_rows:
            caen_code = org_rows[0].get("caen_code")
        # activity_description may not exist on every deployment — guard.
        try:
            org_extra = ac.select(
                "organizations",
                filters={"id": f"eq.{org_id}"},
                columns="activity_description",
            )
            if org_extra:
                activity_text = org_extra[0].get("activity_description")
        except Exception:
            activity_text = None

    # Cost-structure metrics — read calculated_metrics via the caller's
    # client (RLS-scoped) so we never read other-tenants' periods.
    metric_rows = client.select(
        "calculated_metrics",
        filters={"period_id": f"eq.{period_id}"},
        columns="name,value",
    )
    metrics: Dict[str, float] = {}
    for r in metric_rows:
        name = r.get("name")
        val = r.get("value")
        if name and val is not None:
            try:
                metrics[name] = float(val)
            except (TypeError, ValueError):
                pass

    # Catalog reads go through the admin client (catalog tables are
    # world-readable to authenticated sessions, but admin() avoids
    # paying RLS evaluation cost).
    with _supabase.admin() as ac:
        result = detect_from_signals(
            ac,
            caen_code=caen_code,
            activity_text=activity_text,
            metrics=metrics,
        )

    # Echo the signal inventory back so the UI can show "we used CAEN +
    # cost structure" without re-querying.
    result.inputs["caen_code"] = _normalize_caen(caen_code)
    result.inputs["activity_text_len"] = len(activity_text or "")
    result.inputs["metrics_count"] = len(metrics)
    result.inputs["period_id"] = period_id
    return result


# ──────────────────────────────────────────────────────────────────────
# Self-test
# ──────────────────────────────────────────────────────────────────────
# Lightweight pure tests — no DB. Replaces _supabase calls with a stub
# that returns canned rows. Verifies:
#   · CAEN 1013 → packaged_canned_meat_prepared_foods (Scandia anchor)
#   · CAEN 4511 → automotive_retail_distribution (Porsche anchor)
#   · Empty signals → universal fallback at 0.30 confidence
#
# Run with:
#   .venv/bin/python -m engine.api._industry_detection

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)

    class _StubClient:
        """In-memory stand-in for SupabaseClient — covers select() only."""
        _MAPPINGS = {
            "1013": {
                "caen_code": "1013",
                "industry_key": "packaged_canned_meat_prepared_foods",
                "parent_industry_key": "food_manufacturing",
                "match_quality": "exact",
                "confidence": 0.95,
            },
            "4511": {
                "caen_code": "4511",
                "industry_key": "automotive_retail_distribution",
                "parent_industry_key": "trade_distribution_generic",
                "match_quality": "exact",
                "confidence": 0.95,
            },
        }
        _PROFILES = {
            "packaged_canned_meat_prepared_foods": {
                "key": "packaged_canned_meat_prepared_foods",
                "display_name": "Packaged canned meat & prepared foods",
                "parent_key": "food_manufacturing",
                "sector": "food_manufacturing",
            },
            "automotive_retail_distribution": {
                "key": "automotive_retail_distribution",
                "display_name": "Automotive retail and distribution",
                "parent_key": "trade_distribution_generic",
                "sector": "trade_distribution_generic",
            },
            "manufacturing_generic": {
                "key": "manufacturing_generic",
                "display_name": "Manufacturing (general industrial)",
                "parent_key": None,
                "sector": "manufacturing_generic",
            },
            "professional_services_generic": {
                "key": "professional_services_generic",
                "display_name": "Professional services (general)",
                "parent_key": None,
                "sector": "professional_services_generic",
            },
        }
        def select(self, table, filters=None, columns="*", **kw):
            f = filters or {}
            if table == "caen_industry_mappings":
                caen = f.get("caen_code", "").split(".", 1)[-1]
                row = self._MAPPINGS.get(caen)
                return [row] if row else []
            if table == "industry_profiles":
                key = f.get("key", "").split(".", 1)[-1]
                row = self._PROFILES.get(key)
                return [row] if row else []
            if table == "industry_aliases":
                return []
            return []

    stub = _StubClient()

    # Scandia anchor
    r = detect_from_signals(stub, caen_code="1013")
    assert r.primary.industry_key == "packaged_canned_meat_prepared_foods", r
    assert r.primary.source == SOURCE_AUTO_CAEN
    print(f"  Scandia (1013) → {r.primary.industry_key} (conf {r.primary.confidence})  OK")

    # Porsche anchor
    r = detect_from_signals(stub, caen_code="4511")
    assert r.primary.industry_key == "automotive_retail_distribution", r
    print(f"  Porsche (4511) → {r.primary.industry_key} (conf {r.primary.confidence})  OK")

    # Empty signals → fallback
    r = detect_from_signals(stub)
    assert r.primary.source == SOURCE_FALLBACK
    assert r.primary.confidence == 0.30
    print(f"  Empty signals  → {r.primary.industry_key} (fallback)  OK")

    # Services-shaped metrics → professional_services_generic fallback
    r = detect_from_signals(stub, metrics={
        "total_operating_revenue": 1_000_000,
        "opex_personnel": 500_000,
        "cogs": 50_000,
    })
    assert r.primary.industry_key == "professional_services_generic", r
    print(f"  Services-shape → {r.primary.industry_key} (fallback)  OK")

    print("\nAll self-tests passed.")
