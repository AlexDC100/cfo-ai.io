"""Industry-intelligence API routes — `/api/industry/*` (Phases B + C).

Phase B added the read surface. Phase C adds the write surface
(assignment upsert, lock toggle, recalc) — every mutation also writes
one row to `industry_change_audit_log` for traceability.

ROUTES
======
READ (Phase B):
    GET /api/industry/profiles
        List active industries (for dropdowns / search). Optional
        `sector=...` filter.

    GET /api/industry/profiles/{key}
        Full detail for one industry: parent, sector, CAENs that map
        in, peer candidates, latest benchmark_set revision.

    GET /api/industry/caen/{caen_code}
        Resolve a raw CAEN code through caen_industry_mappings. 404 if
        no mapping.

    GET /api/industry/search?q=<text>
        Search industries by display_name + aliases. Case-insensitive
        substring match. Returns up to 20 results ranked by alias.weight.

    GET /api/industry/detect/{period_id}
        Run the detection service for the period. Returns primary +
        candidates + inputs. Does NOT write.

    GET /api/industry/assignment/{period_id}
        Read the current company_industry_assignments row, if any.
        Returns 404 if no assignment exists yet (caller should fall
        back to the auto-detect endpoint).

    GET /api/industry/audit-log/{period_id}
        All historical changes for this period's assignment. Read-only.

WRITE (Phase C):
    POST /api/industry/assignment/{period_id}
        Upsert the assignment. Body { selected_industry_key, source?,
        confidence?, locked_by_user? }. Defaults source to
        'user_override' when called from a UI; pass source='auto_*' to
        record an auto-suggested write. Server fills `detected_industry_key`
        and `caen_code` from the org. Busts cached benchmark_reports
        for this period.

    POST /api/industry/assignment/{period_id}/lock
        Body { locked: bool }. Flips locked_by_user without touching
        the selected industry. Locking PREVENTS subsequent /recalc
        from changing the row; unlock first if you want auto-detection
        to drive it again.

    POST /api/industry/assignment/{period_id}/recalc
        Re-runs detection and persists the new primary candidate.
        Returns 409 if the existing row is `locked_by_user=true` — the
        caller must unlock explicitly first. Busts benchmark_reports cache.

AUTH
====
Every route requires a JWT bearer (`Authorization: Bearer …`). Catalog
tables are world-readable to authenticated sessions per the RLS policy
in `schema_phase_industry_intelligence.sql`, so we read them via the
admin client for speed. Tenant tables (assignments) read via the
per-user client so RLS does the org-scoping for us.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Header, HTTPException, Query
from pydantic import BaseModel

from . import _supabase
from ._industry_detection import (
    Candidate,
    DetectionResult,
    detect_industry_for_period,
)


logger = logging.getLogger(__name__)


# ──────────────────────────────────────────────────────────────────────
# Auth helpers (same pattern as _benchmarks.py — local copy to avoid
# circular imports across the router package)
# ──────────────────────────────────────────────────────────────────────

def _require_jwt(authorization: Optional[str]) -> str:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "Missing Bearer token.")
    return authorization.split(" ", 1)[1].strip()


def _resolve_user_org(jwt: str) -> tuple[str, str]:
    """Resolve (user_id, org_id) from a JWT. Mirrors _benchmarks.py."""
    with _supabase.per_user(jwt) as client:
        user = client.get_user(jwt)
    user_id = user.get("id") if user else None
    if not user_id:
        raise HTTPException(401, "Could not resolve user from JWT.")
    with _supabase.admin() as ac:
        mems = ac.select("memberships", filters={"user_id": f"eq.{user_id}"}, limit=1)
    if not mems:
        raise HTTPException(404, "User has no organization membership.")
    return user_id, mems[0]["org_id"]


# ──────────────────────────────────────────────────────────────────────
# Response models — typed so OpenAPI is honest about the contract
# ──────────────────────────────────────────────────────────────────────

class IndustryProfileSummary(BaseModel):
    key: str
    display_name: str
    display_name_ro: Optional[str] = None
    sector: str
    parent_key: Optional[str] = None
    benchmark_depth: Optional[str] = None
    confidence_default: Optional[float] = None


class CaenMappingRow(BaseModel):
    caen_code: str
    caen_label_en: str
    caen_label_ro: Optional[str] = None
    industry_key: str
    parent_industry_key: Optional[str] = None
    match_quality: str
    confidence: float


class PeerCandidateRow(BaseModel):
    id: str
    company_name: str
    country: Optional[str] = "RO"
    source: Optional[str] = None
    is_internal_brand_default: bool = False
    has_uploaded_financials: bool = False
    notes: Optional[str] = None


class BenchmarkSetRow(BaseModel):
    id: str
    revision: int
    effective_from: Optional[str] = None
    effective_to: Optional[str] = None
    source_label: str
    source_year: int
    confidence: str


class IndustryProfileDetail(IndustryProfileSummary):
    description: Optional[str] = None
    caen_codes: List[str] = []
    caen_mappings: List[CaenMappingRow] = []
    peers: List[PeerCandidateRow] = []
    latest_benchmark_set: Optional[BenchmarkSetRow] = None


class CandidateRow(BaseModel):
    industry_key: str
    parent_industry_key: Optional[str] = None
    display_name: Optional[str] = None
    source: str
    confidence: float
    match_quality: Optional[str] = None
    rationale: Optional[str] = ""


class DetectResponse(BaseModel):
    period_id: str
    primary: Optional[CandidateRow]
    candidates: List[CandidateRow]
    inputs: Dict[str, Any]
    locked: bool = False


class AssignmentRow(BaseModel):
    period_id: str
    organization_id: str
    company_name: Optional[str] = None
    caen_code: Optional[str] = None
    detected_industry_key: Optional[str] = None
    selected_industry_key: str
    source: str
    confidence: float
    locked_by_user: bool
    updated_at: Optional[str] = None


class AssignmentUpsertRequest(BaseModel):
    selected_industry_key: str
    source: Optional[str] = "user_override"
    confidence: Optional[float] = None
    locked_by_user: Optional[bool] = None
    reason: Optional[str] = None  # free-text rationale logged to audit


class AssignmentLockRequest(BaseModel):
    locked: bool
    reason: Optional[str] = None


class AuditLogRow(BaseModel):
    id: str
    period_id: str
    organization_id: str
    changed_at: str
    changed_by: Optional[str] = None
    prev_industry_key: Optional[str] = None
    new_industry_key: str
    prev_source: Optional[str] = None
    new_source: str
    reason: Optional[str] = None


# ──────────────────────────────────────────────────────────────────────
# Internal helpers
# ──────────────────────────────────────────────────────────────────────

# Valid `source` strings — MUST stay in lock-step with the CHECK
# constraint on company_industry_assignments.source (see Phase A
# migration). Keep alphabetized for diff stability.
_VALID_SOURCES = frozenset({
    "auto_account_structure",
    "auto_activity_text",
    "auto_caen",
    "auto_keyword",
    "fallback",
    "user_override",
})


def _validate_industry_key(industry_key: str) -> Dict[str, Any]:
    """Look up an industry_profile by key. 422 if missing or inactive.
    Returns the row (used to populate parent_key / sector echoes)."""
    with _supabase.admin() as ac:
        rows = ac.select(
            "industry_profiles",
            filters={"key": f"eq.{industry_key}", "is_active": "eq.true"},
            columns="key,display_name,parent_key,sector",
        )
    if not rows:
        raise HTTPException(
            422,
            f"industry_key '{industry_key}' is not a known active industry. "
            f"Use GET /api/industry/profiles to list valid keys.",
        )
    return rows[0]


def _validate_source(source: str) -> str:
    if source not in _VALID_SOURCES:
        raise HTTPException(
            422,
            f"source '{source}' is invalid. Allowed: {sorted(_VALID_SOURCES)}",
        )
    return source


def _read_existing_assignment(client: Any, period_id: str
                              ) -> Optional[Dict[str, Any]]:
    rows = client.select(
        "company_industry_assignments",
        filters={"period_id": f"eq.{period_id}"},
        columns=(
            "id,period_id,organization_id,company_name,caen_code,"
            "detected_industry_key,selected_industry_key,source,"
            "confidence,locked_by_user,updated_at"
        ),
    )
    return rows[0] if rows else None


def _read_org_facts(org_id: str) -> Dict[str, Any]:
    """Pull caen_code + company name for the audit-log payload + the
    assignment row's denormalized fields."""
    with _supabase.admin() as ac:
        rows = ac.select(
            "organizations",
            filters={"id": f"eq.{org_id}"},
            columns="id,name,caen_code",
        )
    return rows[0] if rows else {"id": org_id, "name": None, "caen_code": None}


def _write_audit_log(*, org_id: str, period_id: str, user_id: Optional[str],
                     prev_row: Optional[Dict[str, Any]],
                     new_industry_key: str, new_source: str,
                     reason: Optional[str],
                     payload_snapshot: Dict[str, Any]) -> None:
    """Append one row to industry_change_audit_log via the admin client.

    The audit table has NO member-write RLS policy by design (tamper
    prevention), so writes MUST go through the service-role client.
    """
    row: Dict[str, Any] = {
        "organization_id": org_id,
        "period_id": period_id,
        "changed_by": user_id,
        "prev_industry_key": (prev_row or {}).get("selected_industry_key"),
        "new_industry_key": new_industry_key,
        "prev_source": (prev_row or {}).get("source"),
        "new_source": new_source,
        "reason": reason,
        "payload": payload_snapshot,
    }
    with _supabase.admin() as ac:
        try:
            ac.insert("industry_change_audit_log", row, returning=False)
        except Exception as exc:  # pragma: no cover - non-fatal
            # An audit-log failure must NOT roll back the assignment
            # write — assignments are the source of truth, audits are
            # observability. Log loudly so an SRE can backfill.
            logger.error(
                "industry_change_audit_log write FAILED for period %s: %s",
                period_id, exc,
            )


def _bust_benchmark_cache(period_id: str) -> None:
    """Delete cached benchmark_reports for this period so the next
    /api/benchmarks/report call recomputes against the new industry.

    The cache table keys on period_id; one DELETE is sufficient. We
    use the admin client because catalog deletes don't fit RLS member
    policies cleanly, and the table is org-scoped through the period
    FK anyway."""
    try:
        with _supabase.admin() as ac:
            ac.delete(
                "benchmark_reports",
                filters={"period_id": f"eq.{period_id}"},
            )
    except Exception as exc:  # pragma: no cover - non-fatal
        logger.warning(
            "benchmark_reports cache bust FAILED for period %s: %s "
            "(next report fetch may serve stale industry).",
            period_id, exc,
        )

def _candidate_to_row(c: Candidate) -> CandidateRow:
    return CandidateRow(
        industry_key=c.industry_key,
        parent_industry_key=c.parent_industry_key,
        display_name=c.display_name,
        source=c.source,
        confidence=c.confidence,
        match_quality=c.match_quality,
        rationale=c.rationale,
    )


def _detection_to_response(period_id: str, r: DetectionResult) -> DetectResponse:
    return DetectResponse(
        period_id=period_id,
        primary=_candidate_to_row(r.primary) if r.primary else None,
        candidates=[_candidate_to_row(c) for c in r.candidates],
        inputs=r.inputs,
        locked=r.locked,
    )


# ──────────────────────────────────────────────────────────────────────
# Router
# ──────────────────────────────────────────────────────────────────────

def build_router() -> APIRouter:
    router = APIRouter(tags=["industry"])

    # ─── list profiles ────────────────────────────────────────────
    @router.get("/api/industry/profiles", response_model=List[IndustryProfileSummary])
    def list_profiles(
        sector: Optional[str] = Query(None, description="Filter by top-level sector key."),
        include_inactive: bool = Query(False, description="Include is_active=false rows."),
        seeded_only: bool = Query(
            False,
            description=(
                "If true, return only industries whose `caen_codes` array "
                "overlaps with the seeded `industry_benchmarks` catalog. "
                "Used by the FE IndustryPicker so users never pick an "
                "industry that would render an empty 'not calibrated' "
                "benchmark — a confidently wrong or empty bench is worse "
                "than a small honest menu."
            ),
        ),
        authorization: Optional[str] = Header(None),
    ) -> List[IndustryProfileSummary]:
        _require_jwt(authorization)
        filters: Dict[str, str] = {}
        if sector:
            filters["sector"] = f"eq.{sector}"
        if not include_inactive:
            filters["is_active"] = "eq.true"
        with _supabase.admin() as ac:
            # When seeded_only is requested we need caen_codes too so we
            # can intersect with the live benchmark catalog below.
            cols = (
                "key,display_name,display_name_ro,sector,parent_key,"
                "benchmark_depth,confidence_default"
            )
            if seeded_only:
                cols += ",caen_codes"
            rows = ac.select(
                "industry_profiles",
                filters=filters,
                columns=cols,
                order="sector.asc,key.asc",
            )

            if seeded_only:
                # One query to enumerate seeded CAENs — distinct caen_code
                # rows present in industry_benchmarks. We pull them once
                # and intersect in Python so we don't issue one query per
                # profile (the table is small: ~8 CAENs today).
                bench_rows = ac.select(
                    "industry_benchmarks",
                    columns="caen_code",
                )
                seeded_caens = {
                    str(r["caen_code"]).strip()
                    for r in bench_rows
                    if r.get("caen_code")
                }
                kept: List[Dict[str, Any]] = []
                for r in rows:
                    caens = r.get("caen_codes") or []
                    if any(str(c).strip() in seeded_caens for c in caens):
                        # Drop caen_codes before serialization since the
                        # response model doesn't carry it (kept the read
                        # local to the filter step).
                        r.pop("caen_codes", None)
                        kept.append(r)
                rows = kept

        return [IndustryProfileSummary(**r) for r in rows]

    # ─── single profile (with mappings + peers + latest benchmark) ─
    @router.get("/api/industry/profiles/{key}", response_model=IndustryProfileDetail)
    def get_profile(
        key: str,
        authorization: Optional[str] = Header(None),
    ) -> IndustryProfileDetail:
        _require_jwt(authorization)
        with _supabase.admin() as ac:
            profiles = ac.select(
                "industry_profiles",
                filters={"key": f"eq.{key}"},
                columns=(
                    "key,display_name,display_name_ro,sector,parent_key,"
                    "description,caen_codes,benchmark_depth,confidence_default,"
                    "is_active"
                ),
            )
            if not profiles or not profiles[0].get("is_active", True):
                raise HTTPException(404, f"Industry '{key}' not found or inactive.")
            profile = profiles[0]

            mappings_rows = ac.select(
                "caen_industry_mappings",
                filters={"industry_key": f"eq.{key}"},
                columns=(
                    "caen_code,caen_label_en,caen_label_ro,industry_key,"
                    "parent_industry_key,match_quality,confidence"
                ),
                order="caen_code.asc",
            )
            peer_rows = ac.select(
                "peer_candidates",
                filters={"industry_key": f"eq.{key}"},
                columns=(
                    "id,company_name,country,source,is_internal_brand_default,"
                    "has_uploaded_financials,notes"
                ),
                order="is_internal_brand_default.asc,company_name.asc",
            )
            # Latest non-expired benchmark_set, if any.
            set_rows = ac.select(
                "benchmark_sets",
                filters={"industry_key": f"eq.{key}", "effective_to": "is.null"},
                columns=(
                    "id,revision,effective_from,effective_to,source_label,"
                    "source_year,confidence"
                ),
                order="revision.desc",
                limit=1,
            )

        return IndustryProfileDetail(
            **{
                "key": profile["key"],
                "display_name": profile["display_name"],
                "display_name_ro": profile.get("display_name_ro"),
                "sector": profile["sector"],
                "parent_key": profile.get("parent_key"),
                "benchmark_depth": profile.get("benchmark_depth"),
                "confidence_default": profile.get("confidence_default"),
                "description": profile.get("description"),
                "caen_codes": profile.get("caen_codes") or [],
                "caen_mappings": [CaenMappingRow(**m) for m in mappings_rows],
                "peers": [PeerCandidateRow(**p) for p in peer_rows],
                "latest_benchmark_set": (
                    BenchmarkSetRow(**set_rows[0]) if set_rows else None
                ),
            }
        )

    # ─── CAEN → industry lookup ───────────────────────────────────
    @router.get("/api/industry/caen/{caen_code}", response_model=CaenMappingRow)
    def resolve_caen(
        caen_code: str,
        authorization: Optional[str] = Header(None),
    ) -> CaenMappingRow:
        _require_jwt(authorization)
        # Normalize: strip non-digits, pad to 4 (the loader stores them
        # this way). Don't import _normalize_caen to avoid module coupling
        # — the rule is one line.
        digits = "".join(ch for ch in str(caen_code) if ch.isdigit())
        if len(digits) == 3:
            digits = "0" + digits
        digits = digits[:4]
        if not digits:
            raise HTTPException(400, "Invalid CAEN code.")
        with _supabase.admin() as ac:
            rows = ac.select(
                "caen_industry_mappings",
                filters={"caen_code": f"eq.{digits}"},
                columns=(
                    "caen_code,caen_label_en,caen_label_ro,industry_key,"
                    "parent_industry_key,match_quality,confidence"
                ),
            )
        if not rows:
            raise HTTPException(404, f"CAEN {digits} is not mapped.")
        return CaenMappingRow(**rows[0])

    # ─── search (by name + aliases) ───────────────────────────────
    @router.get("/api/industry/search", response_model=List[IndustryProfileSummary])
    def search(
        q: str = Query(..., min_length=2, max_length=80),
        limit: int = Query(20, ge=1, le=100),
        seeded_only: bool = Query(
            False,
            description=(
                "If true, results are intersected with the seeded "
                "`industry_benchmarks` catalog — picker callers set this "
                "so search never surfaces an industry that would render "
                "an empty 'not calibrated' bench."
            ),
        ),
        authorization: Optional[str] = Header(None),
    ) -> List[IndustryProfileSummary]:
        _require_jwt(authorization)
        needle = q.lower().strip()
        with _supabase.admin() as ac:
            # PostgREST supports `ilike` on display_name + display_name_ro.
            # Wrap the term in % for substring match. PostgREST URL form:
            #   display_name=ilike.*term*
            # We pass filters {"display_name": "ilike.*term*"} but %
            # would be URL-encoded; the * shorthand works in postgrest.
            name_hits = ac.select(
                "industry_profiles",
                filters={"display_name": f"ilike.*{needle}*", "is_active": "eq.true"},
                columns=(
                    "key,display_name,display_name_ro,sector,parent_key,"
                    "benchmark_depth,confidence_default"
                ),
                limit=limit,
            )
            # Also search aliases; map each hit back to a profile.
            alias_hits = ac.select(
                "industry_aliases",
                filters={"alias": f"ilike.*{needle}*"},
                columns="industry_key,alias,weight",
                limit=limit,
            )
            alias_keys = list({a["industry_key"] for a in alias_hits})
            alias_profiles: List[Dict[str, Any]] = []
            if alias_keys:
                # PostgREST `in` filter — comma-separated, URL-safe form.
                in_list = ",".join(alias_keys)
                alias_profiles = ac.select(
                    "industry_profiles",
                    filters={"key": f"in.({in_list})", "is_active": "eq.true"},
                    columns=(
                        "key,display_name,display_name_ro,sector,parent_key,"
                        "benchmark_depth,confidence_default"
                    ),
                )

        # Merge + dedupe, preferring direct name hits (they rank above
        # alias-only matches).
        seen: Dict[str, Dict[str, Any]] = {}
        for r in name_hits:
            seen[r["key"]] = r
        for r in alias_profiles:
            seen.setdefault(r["key"], r)
        results = list(seen.values())[:limit]

        if seeded_only and results:
            # Same intersection pattern as list_profiles' seeded_only —
            # one query for the seeded CAEN set, then drop any profile
            # whose caen_codes don't overlap.
            keys = [r["key"] for r in results]
            with _supabase.admin() as ac2:
                bench_rows = ac2.select(
                    "industry_benchmarks",
                    columns="caen_code",
                )
                seeded_caens = {
                    str(r["caen_code"]).strip()
                    for r in bench_rows
                    if r.get("caen_code")
                }
                in_list = ",".join(keys)
                detail_rows = ac2.select(
                    "industry_profiles",
                    filters={"key": f"in.({in_list})"},
                    columns="key,caen_codes",
                )
                key_to_caens = {
                    d["key"]: (d.get("caen_codes") or []) for d in detail_rows
                }
            results = [
                r for r in results
                if any(
                    str(c).strip() in seeded_caens
                    for c in key_to_caens.get(r["key"], [])
                )
            ]

        return [IndustryProfileSummary(**r) for r in results]

    # ─── detect industry for a period (read-only) ─────────────────
    @router.get("/api/industry/detect/{period_id}", response_model=DetectResponse)
    def detect(
        period_id: str,
        authorization: Optional[str] = Header(None),
    ) -> DetectResponse:
        jwt = _require_jwt(authorization)
        _user_id, org_id = _resolve_user_org(jwt)

        # Confirm period belongs to the caller's org — same defensive
        # check as _benchmarks.py. RLS would prevent reading another
        # org's period anyway, but a clear 403 beats a silent empty row.
        with _supabase.per_user(jwt) as client:
            periods = client.select(
                "financial_periods",
                filters={"id": f"eq.{period_id}"},
                columns="id,org_id",
            )
            if not periods:
                raise HTTPException(404, f"Period '{period_id}' not found.")
            if periods[0]["org_id"] != org_id:
                raise HTTPException(403, "Period belongs to a different organization.")

            result = detect_industry_for_period(client, period_id, org_id)

        return _detection_to_response(period_id, result)

    # ─── read the current assignment (if any) ─────────────────────
    @router.get("/api/industry/assignment/{period_id}", response_model=AssignmentRow)
    def get_assignment(
        period_id: str,
        authorization: Optional[str] = Header(None),
    ) -> AssignmentRow:
        jwt = _require_jwt(authorization)
        _user_id, org_id = _resolve_user_org(jwt)
        with _supabase.per_user(jwt) as client:
            rows = client.select(
                "company_industry_assignments",
                filters={"period_id": f"eq.{period_id}"},
                columns=(
                    "period_id,organization_id,company_name,caen_code,"
                    "detected_industry_key,selected_industry_key,source,"
                    "confidence,locked_by_user,updated_at"
                ),
            )
        if not rows:
            raise HTTPException(
                404,
                "No assignment recorded for this period yet. "
                "Call /api/industry/detect/{period_id} for an auto-suggestion."
            )
        row = rows[0]
        if row.get("organization_id") != org_id:
            # RLS should have filtered this out, but defense in depth.
            raise HTTPException(403, "Assignment belongs to a different organization.")
        return AssignmentRow(**row)

    # ─── audit log (read) ─────────────────────────────────────────
    @router.get("/api/industry/audit-log/{period_id}",
                response_model=List[AuditLogRow])
    def get_audit_log(
        period_id: str,
        limit: int = Query(50, ge=1, le=200),
        authorization: Optional[str] = Header(None),
    ) -> List[AuditLogRow]:
        jwt = _require_jwt(authorization)
        _user_id, org_id = _resolve_user_org(jwt)
        with _supabase.per_user(jwt) as client:
            rows = client.select(
                "industry_change_audit_log",
                filters={"period_id": f"eq.{period_id}"},
                columns=(
                    "id,period_id,organization_id,changed_at,changed_by,"
                    "prev_industry_key,new_industry_key,prev_source,"
                    "new_source,reason"
                ),
                order="changed_at.desc",
                limit=limit,
            )
        # Defense in depth — RLS scopes this already, but if a future
        # config disabled the policy, we don't want to leak cross-org.
        rows = [r for r in rows if r.get("organization_id") == org_id]
        return [AuditLogRow(**r) for r in rows]

    # ─── upsert assignment (user override or programmatic write) ──
    @router.post("/api/industry/assignment/{period_id}",
                 response_model=AssignmentRow)
    def upsert_assignment(
        period_id: str,
        body: AssignmentUpsertRequest,
        authorization: Optional[str] = Header(None),
    ) -> AssignmentRow:
        jwt = _require_jwt(authorization)
        user_id, org_id = _resolve_user_org(jwt)

        # Validate body inputs before any DB write.
        _validate_industry_key(body.selected_industry_key)
        source = _validate_source(body.source or "user_override")

        # Confirm the period belongs to the caller's org.
        with _supabase.per_user(jwt) as client:
            periods = client.select(
                "financial_periods",
                filters={"id": f"eq.{period_id}"},
                columns="id,org_id",
            )
            if not periods:
                raise HTTPException(404, f"Period '{period_id}' not found.")
            if periods[0]["org_id"] != org_id:
                raise HTTPException(403, "Period belongs to a different organization.")

            prev = _read_existing_assignment(client, period_id)

        # If user is making the call from the UI (source='user_override'),
        # `locked_by_user` defaults to True unless they explicitly passed
        # False. For programmatic / auto-detect writes, default False so
        # the user can still override.
        if body.locked_by_user is not None:
            locked = body.locked_by_user
        else:
            locked = (source == "user_override")

        org_facts = _read_org_facts(org_id)

        # Detected industry — best-effort pull from the latest detection
        # to record what auto-detection would have said, even when the
        # user is overriding. Read-only, no side effects.
        detected_key: Optional[str] = (prev or {}).get("detected_industry_key")
        if detected_key is None:
            try:
                with _supabase.per_user(jwt) as client2:
                    det = detect_industry_for_period(client2, period_id, org_id)
                    if det.primary and not det.locked:
                        detected_key = det.primary.industry_key
            except HTTPException:
                # Period might still be importing — skip rather than fail.
                pass

        row: Dict[str, Any] = {
            "organization_id": org_id,
            "period_id": period_id,
            "company_name": org_facts.get("name"),
            "caen_code": org_facts.get("caen_code"),
            "detected_industry_key": detected_key,
            "selected_industry_key": body.selected_industry_key,
            "source": source,
            "confidence": (
                body.confidence if body.confidence is not None
                else (1.0 if source == "user_override" else 0.7)
            ),
            "locked_by_user": locked,
        }
        with _supabase.per_user(jwt) as client:
            client.upsert(
                "company_industry_assignments",
                row,
                on_conflict="period_id",
                returning=False,
            )
            stored = _read_existing_assignment(client, period_id)
        if not stored:
            raise HTTPException(500, "Assignment write succeeded but read-back failed.")

        _write_audit_log(
            org_id=org_id, period_id=period_id, user_id=user_id,
            prev_row=prev, new_industry_key=body.selected_industry_key,
            new_source=source, reason=body.reason,
            payload_snapshot={"new": row, "prev": prev},
        )
        _bust_benchmark_cache(period_id)
        return AssignmentRow(**stored)

    # ─── toggle the lock flag ─────────────────────────────────────
    @router.post("/api/industry/assignment/{period_id}/lock",
                 response_model=AssignmentRow)
    def toggle_lock(
        period_id: str,
        body: AssignmentLockRequest,
        authorization: Optional[str] = Header(None),
    ) -> AssignmentRow:
        jwt = _require_jwt(authorization)
        user_id, org_id = _resolve_user_org(jwt)

        with _supabase.per_user(jwt) as client:
            prev = _read_existing_assignment(client, period_id)
            if not prev:
                raise HTTPException(
                    404,
                    "No assignment to lock/unlock. Call POST "
                    "/api/industry/assignment/{period_id} first.",
                )
            if prev["organization_id"] != org_id:
                raise HTTPException(403, "Assignment belongs to a different organization.")
            client.update(
                "company_industry_assignments",
                {"locked_by_user": body.locked},
                filters={"period_id": f"eq.{period_id}"},
            )
            stored = _read_existing_assignment(client, period_id)

        _write_audit_log(
            org_id=org_id, period_id=period_id, user_id=user_id,
            prev_row=prev, new_industry_key=prev["selected_industry_key"],
            new_source=prev["source"], reason=body.reason,
            payload_snapshot={"lock_flip": {"from": prev["locked_by_user"],
                                             "to": body.locked}},
        )
        # No cache bust — locking doesn't change the industry choice.
        return AssignmentRow(**stored)

    # ─── re-run detection and persist (respects lock) ─────────────
    @router.post("/api/industry/assignment/{period_id}/recalc",
                 response_model=AssignmentRow)
    def recalc_assignment(
        period_id: str,
        authorization: Optional[str] = Header(None),
    ) -> AssignmentRow:
        jwt = _require_jwt(authorization)
        user_id, org_id = _resolve_user_org(jwt)

        with _supabase.per_user(jwt) as client:
            periods = client.select(
                "financial_periods",
                filters={"id": f"eq.{period_id}"},
                columns="id,org_id",
            )
            if not periods:
                raise HTTPException(404, f"Period '{period_id}' not found.")
            if periods[0]["org_id"] != org_id:
                raise HTTPException(403, "Period belongs to a different organization.")

            prev = _read_existing_assignment(client, period_id)
            if prev and prev.get("locked_by_user"):
                raise HTTPException(
                    409,
                    "Assignment is locked by user. Call POST "
                    "/api/industry/assignment/{period_id}/lock with "
                    "{ locked: false } before recalculating.",
                )

            detection = detect_industry_for_period(client, period_id, org_id)
            if detection.primary is None:
                raise HTTPException(
                    500,
                    "Detection produced no candidates — should be impossible. "
                    "Check the universal fallback in _industry_detection.",
                )
            org_facts = _read_org_facts(org_id)

            new_key = detection.primary.industry_key
            new_source = detection.primary.source
            row: Dict[str, Any] = {
                "organization_id": org_id,
                "period_id": period_id,
                "company_name": org_facts.get("name"),
                "caen_code": org_facts.get("caen_code"),
                "detected_industry_key": new_key,
                "selected_industry_key": new_key,
                "source": new_source,
                "confidence": detection.primary.confidence,
                "locked_by_user": False,
            }
            client.upsert(
                "company_industry_assignments",
                row,
                on_conflict="period_id",
                returning=False,
            )
            stored = _read_existing_assignment(client, period_id)

        _write_audit_log(
            org_id=org_id, period_id=period_id, user_id=user_id,
            prev_row=prev, new_industry_key=new_key, new_source=new_source,
            reason="recalc — detection re-ran from current signals",
            payload_snapshot={
                "primary": {
                    "industry_key": detection.primary.industry_key,
                    "source": detection.primary.source,
                    "confidence": detection.primary.confidence,
                    "match_quality": detection.primary.match_quality,
                    "rationale": detection.primary.rationale,
                },
                "candidates": [
                    {"industry_key": c.industry_key, "source": c.source,
                     "confidence": c.confidence}
                    for c in detection.candidates
                ],
                "inputs": detection.inputs,
            },
        )
        _bust_benchmark_cache(period_id)
        return AssignmentRow(**stored)

    return router
