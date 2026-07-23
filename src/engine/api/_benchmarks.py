"""Industry-benchmark API routes — `GET/POST /api/benchmarks/*`.

Routes implemented:
    GET  /api/benchmarks/available-industries     — list seeded CAEN codes
    GET  /api/benchmarks/suggest/{period_id}      — auto-suggest CAEN from P&L
    POST /api/benchmarks/set-caen                 — user confirms CAEN on the org
    GET  /api/benchmarks/report/{period_id}       — compute or fetch cached report

All routes auth via the JWT header (Bearer …) like every other
endpoint in this project. RLS does the per-tenant scoping at the
database layer; the application code reads via `_supabase.per_user(jwt)`
so a user can never see another org's data.

No LLM calls. Pure deterministic comparison + lookup.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

from . import _supabase
from . import _org
from ._benchmark_engine import build_benchmark_report
# F3.1e: CAEN map moved into the Romania country pack.
from engine.country_packs.ro_romania.caen_industry_map import caen_to_category, caen_label_fallback
from ._industry_classifier import suggest_caen_code


logger = logging.getLogger(__name__)


def _require_jwt(authorization: Optional[str]) -> str:
    """Same pattern as pipeline.py — kept local to avoid a circular import."""
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "Missing Bearer token.")
    return authorization.split(" ", 1)[1].strip()


def _load_period_signals(jwt: str, period_id: str) -> Dict[str, float]:
    """Load and flatten the per-period signals the industry classifier needs.

    Shared by `/api/benchmarks/suggest/{period_id}` (user-facing suggest
    endpoint) and the internal confident auto-detect inside
    `_resolve_effective_caen`. Single-sourcing the input shape keeps
    suggest and auto-resolve in lock-step — a change in classifier
    inputs only edits one site.
    """
    # Imported lazily to keep the module-level import surface small —
    # `_benchmark_engine` pulls heavyweight statistics deps.
    from ._benchmark_engine import (
        OPEX_PERSONNEL_PREFIXES, OPEX_ENERGY_PREFIXES, OPEX_RENT_PREFIXES,
        OPEX_EXTERNAL_SERVICES_PREFIXES, _sum_line_items_by_prefix,
    )

    with _supabase.per_user(jwt) as client:
        metrics_rows = client.select(
            "calculated_metrics",
            filters={"period_id": f"eq.{period_id}"},
            columns="name,value",
        )
        line_items = client.select(
            "statement_line_items",
            filters={"period_id": f"eq.{period_id}"},
            columns="statement,bucket,ro_account_code,amount",
        )

    flat: Dict[str, float] = {}
    for r in metrics_rows:
        name = r.get("name")
        val = r.get("value")
        if name and val is not None:
            try:
                flat[name] = float(val)
            except (TypeError, ValueError):
                pass
    bucket_sums: Dict[str, float] = {}
    for li in line_items:
        if li.get("statement") != "PL":
            continue
        b = (li.get("bucket") or "").strip()
        try:
            bucket_sums[b] = bucket_sums.get(b, 0.0) + float(li.get("amount") or 0)
        except (TypeError, ValueError):
            pass
    if "revenue" in bucket_sums and "total_operating_revenue" not in flat:
        flat["total_operating_revenue"] = (
            bucket_sums["revenue"]
            + bucket_sums.get("capitalizedOwnWork", 0)
            + bucket_sums.get("otherIncome", 0)
        )
    flat.setdefault("cogs", bucket_sums.get("cogs", 0))
    flat.setdefault("depreciation_amortization", bucket_sums.get("depreciation", 0))
    flat["opex_personnel"] = _sum_line_items_by_prefix(line_items, OPEX_PERSONNEL_PREFIXES)
    flat["opex_energy"] = _sum_line_items_by_prefix(line_items, OPEX_ENERGY_PREFIXES)
    flat["opex_rent"] = _sum_line_items_by_prefix(line_items, OPEX_RENT_PREFIXES)
    flat["opex_external_services"] = _sum_line_items_by_prefix(line_items, OPEX_EXTERNAL_SERVICES_PREFIXES)
    return flat


# Minimum confidence the per-period auto-detect must achieve before a
# CAEN is accepted without explicit user confirmation. Mirrors the
# classifier's "single-rule match" tier (returns 0.7). Anything weaker
# falls through to the caen_not_set gate so the user picks via
# IndustryPicker — a confident wrong industry is worse than no industry.
_AUTODETECT_MIN_CONFIDENCE = 0.7


def _resolve_effective_caen(*, jwt: str, period_id: str) -> tuple[str, str]:
    """Resolve the CAEN to render benchmarks against for a single period.

    Resolution order — there is intentionally NO silent fallback to the
    organization's stale `caen_code`. That fallback used to leak the
    first-set industry (Scandia's meat-processing CAEN) onto every
    subsequent upload from the same workspace and produced confidently
    wrong peer comparisons. The honest "pick an industry" gate is
    strictly better than a confidently wrong benchmark.

    1. **Per-period user choice** — `company_industry_assignments[period_id]`
       written by the IndustryPicker. Authoritative when present and
       the chosen industry has a CAEN that exists in the legacy
       `industry_benchmarks` catalog.

    2. **Confident auto-detect** — run `suggest_caen_code()` against
       THIS period's own metrics + line items. Accepted only at
       confidence ≥ `_AUTODETECT_MIN_CONFIDENCE` (single-rule match)
       AND when the suggested CAEN is seeded in the benchmark catalog.

    3. **Unknown** — return `("", "unknown")`. The caller fires the
       `caen_not_set` gate so the FE opens IndustryPicker.

    Returns ``(caen_code, source)`` where ``source`` is one of
    ``"period_assignment"``, ``"auto_detected"``, or ``"unknown"``.
    """
    try:
        # ── Step 1: per-period user choice (authoritative) ──────────
        # The user's explicit pick ALWAYS wins. We never silently
        # auto-detect over it, even when their chosen industry has no
        # rows in the seeded `industry_benchmarks` catalog. In that
        # unseeded case we return the industry's first CAEN anyway —
        # the downstream benchmark engine then surfaces the existing
        # honest `benchmarks_not_available` disclosure for that CAEN,
        # which is the right empty state. (The picker is constrained
        # to seeded-only profiles, so this unseeded-pick branch only
        # ever fires on legacy assignments written before that
        # constraint shipped.)
        with _supabase.per_user(jwt) as client:
            rows = client.select(
                "company_industry_assignments",
                filters={"period_id": f"eq.{period_id}"},
                columns="selected_industry_key",
            )
        selected = (rows[0].get("selected_industry_key") if rows else None) or None
        if selected:
            with _supabase.admin() as ac:
                profiles = ac.select(
                    "industry_profiles",
                    filters={"key": f"eq.{selected}"},
                    columns="caen_codes",
                )
                candidate_caens: List[str] = (
                    profiles[0].get("caen_codes") or []
                ) if profiles else []
                # Prefer the first candidate that is seeded — that yields
                # a real benchmark render. If none are seeded, return the
                # FIRST raw CAEN so the response carries an unambiguous
                # caen_code; the benchmark engine treats that CAEN as
                # "not seeded yet" and emits benchmarks_not_available.
                first_caen: Optional[str] = None
                for caen in candidate_caens:
                    if not caen or len(str(caen)) < 3:
                        continue
                    if first_caen is None:
                        first_caen = str(caen)
                    hits = ac.select(
                        "industry_benchmarks",
                        filters={"caen_code": f"eq.{caen}"},
                        columns="caen_code",
                        limit=1,
                    )
                    if hits:
                        return str(caen), "period_assignment"
                if first_caen:
                    # User-picked industry exists but has no seeded
                    # benchmarks. Return the picked CAEN so the FE shows
                    # the honest "not calibrated" disclosure, not a
                    # silently-different auto-detected industry.
                    return first_caen, "period_assignment_unseeded"

        # ── Step 2: confident auto-detect from this period's data ───
        try:
            signals = _load_period_signals(jwt, period_id)
            caen, _label, confidence = suggest_caen_code(signals)
        except Exception:
            logger.exception(
                "auto-detect failed for period=%s; deferring to picker",
                period_id,
            )
            caen, confidence = None, 0.0

        if caen and confidence >= _AUTODETECT_MIN_CONFIDENCE:
            # Verify the suggested CAEN is actually seeded — anything
            # without rows in industry_benchmarks would render an empty
            # report. Treat as unknown rather than emit an empty page.
            with _supabase.admin() as ac:
                hits = ac.select(
                    "industry_benchmarks",
                    filters={"caen_code": f"eq.{caen}"},
                    columns="caen_code",
                    limit=1,
                )
                if hits:
                    return str(caen), "auto_detected"

        # ── Step 3: unknown — defer to user via the picker gate ─────
        return "", "unknown"
    except Exception:
        # Belt-and-braces: any failure here MUST NOT serve a wrong
        # industry. Surfacing the picker is the safe default.
        logger.exception(
            "_resolve_effective_caen failed for period=%s; treating as unknown",
            period_id,
        )
        return "", "unknown"


def _resolve_user_org(jwt: str, org_id: Optional[str] = None) -> tuple[str, str]:
    """Resolve (user_id, org_id) for the caller's ACTIVE workspace.

    Thin wrapper over _org.resolve_org so this module keeps its historical
    call signature; the multi-workspace logic (validate the X-Org-Id header
    against membership, else fall back to the oldest one) lives in one place.
    """
    return _org.resolve_org(jwt, org_id)


# ─── Request / response shapes ──────────────────────────────────────────────


class SuggestResponse(BaseModel):
    period_id: str
    suggested_caen: Optional[str]
    suggested_label: Optional[str]
    confidence: float


class SetCaenRequest(BaseModel):
    caen_code: str
    org_id: Optional[str] = None  # optional — defaults to the caller's org


class SetCaenResponse(BaseModel):
    updated: bool
    caen_code: str
    org_id: str


# ─── Router ─────────────────────────────────────────────────────────────────


def build_router() -> APIRouter:
    router = APIRouter(tags=["benchmarks"])

    @router.get("/api/benchmarks/available-industries")
    def list_available_industries(authorization: Optional[str] = Header(None)) -> List[Dict[str, Any]]:
        """Return every distinct CAEN code present in `industry_benchmarks`.
        Drives the industry dropdown in the frontend `IndustryPicker`."""
        # JWT is required (catalogue is readable by any authenticated
        # user per the RLS policy — we just need a valid session token).
        _require_jwt(authorization)
        with _supabase.admin() as ac:
            rows = ac.select(
                "industry_benchmarks",
                columns="caen_code,caen_label,industry_category",
                order="caen_code.asc",
            )
        # Deduplicate (one row per metric per CAEN exists in the table).
        seen: Dict[str, Dict[str, Any]] = {}
        for r in rows:
            code = r["caen_code"]
            if code not in seen:
                seen[code] = {
                    "caen_code": code,
                    "caen_label": r.get("caen_label"),
                    "industry_category": r.get("industry_category"),
                }
        return list(seen.values())

    @router.get("/api/benchmarks/suggest/{period_id}", response_model=SuggestResponse)
    def suggest_industry(
        period_id: str,
        authorization: Optional[str] = Header(None),
    ) -> SuggestResponse:
        """Auto-suggest a CAEN from the period's calculated_metrics +
        statement_line_items. Returns confidence so the UI can downweight
        ambiguous matches.

        Shares its signal-flattening helper (`_load_period_signals`) with
        `_resolve_effective_caen` so the user-facing suggestion and the
        internal benchmark auto-detect stay in lock-step.
        """
        jwt = _require_jwt(authorization)
        flat = _load_period_signals(jwt, period_id)
        caen, label, confidence = suggest_caen_code(flat)
        return SuggestResponse(
            period_id=period_id,
            suggested_caen=caen,
            suggested_label=label,
            confidence=confidence,
        )

    @router.post("/api/benchmarks/set-caen", response_model=SetCaenResponse)
    def set_caen_code(
        req: SetCaenRequest,
        authorization: Optional[str] = Header(None),
        x_org_id: Optional[str] = Header(None, alias="X-Org-Id"),
    ) -> SetCaenResponse:
        """User confirms / overrides the CAEN code on their org. Marked
        as 'user' source so we can distinguish operator-confirmed
        classifications from auto-suggestions later."""
        jwt = _require_jwt(authorization)
        _, org_id = _resolve_user_org(jwt, x_org_id)
        # Spec allows the request to carry org_id explicitly (multi-org
        # users) but we still scope to a membership we can verify.
        target_org = req.org_id or org_id
        if req.org_id and req.org_id != org_id:
            # User asked to update a different org — verify membership.
            with _supabase.admin() as ac:
                # NB: we already trust `org_id` from _resolve_user_org;
                # if the request points elsewhere we deny. Phase 2 can
                # add multi-org support behind an explicit membership
                # check.
                raise HTTPException(403, "Cross-org CAEN updates require explicit membership.")

        # Validate the CAEN against the seeded catalogue so we don't
        # accept typos or made-up codes.
        with _supabase.admin() as ac:
            valid = ac.select(
                "industry_benchmarks",
                filters={"caen_code": f"eq.{req.caen_code}"},
                columns="caen_code",
                limit=1,
            )
            if not valid:
                raise HTTPException(
                    400,
                    f"CAEN {req.caen_code} is not in the benchmark catalogue. "
                    f"Call /api/benchmarks/available-industries for the list.",
                )
            ac.update(
                "organizations",
                {
                    "caen_code": req.caen_code,
                    "caen_code_confirmed_at": datetime.now(timezone.utc).isoformat(),
                    "caen_code_source": "user",
                },
                filters={"id": f"eq.{target_org}"},
            )
            # Invalidate any cached benchmark reports for this org. The
            # cache key is period_id, so a stale row carrying the OLD
            # CAEN's comparisons would otherwise be served back to the
            # FE on next read until the period itself is re-analyzed.
            # Deleting all of the org's cache rows forces recompute on
            # next /api/benchmarks/report call against the NEW caen_code.
            try:
                ac.delete("benchmark_reports", filters={"org_id": f"eq.{target_org}"})
            except Exception:
                logger.exception("[benchmarks] cache invalidation on caen-change failed (non-fatal)")
        return SetCaenResponse(updated=True, caen_code=req.caen_code, org_id=target_org)

    @router.get("/api/benchmarks/report/{period_id}")
    def get_benchmark_report(
        period_id: str,
        authorization: Optional[str] = Header(None),
        x_org_id: Optional[str] = Header(None, alias="X-Org-Id"),
    ) -> Dict[str, Any]:
        """Build (or fetch cached) benchmark report for a period.

        Resolution order:
          1. Load period → resolve org → check CAEN code is set.
          2. If a cached report exists for this period_id, return it.
          3. Otherwise compute from calculated_metrics + line_items,
             cache it, and return.
        """
        jwt = _require_jwt(authorization)
        _, org_id = _resolve_user_org(jwt, x_org_id)

        with _supabase.per_user(jwt) as client:
            periods = client.select(
                "financial_periods",
                filters={"id": f"eq.{period_id}"},
                single=True,
            )
            if not periods:
                raise HTTPException(404, "Period not found.")
            period = periods[0]
            # Per-user RLS already scopes this read to the caller's
            # memberships — but we double-check the org_id matches.
            if period["org_id"] != org_id:
                raise HTTPException(403, "Period belongs to a different organization.")

        # Resolve CAEN. The resolver checks (1) per-period assignment,
        # then (2) confident auto-detect from this period's signals.
        # There is NO fallback to `organizations.caen_code` — that
        # silent fallback produced cross-company industry bleed
        # (Scandia's meat CAEN on every other upload in the same
        # workspace). When neither path yields a confident answer the
        # resolver returns `("", "unknown")` and we surface the picker.
        with _supabase.admin() as ac:
            org_rows = ac.select(
                "organizations",
                filters={"id": f"eq.{org_id}"},
                columns="id,name",
                single=True,
            )

        caen_code, caen_source = _resolve_effective_caen(
            jwt=jwt, period_id=period_id,
        )

        # Gate — surface the picker when we have no confident industry.
        if not caen_code:
            return {
                "error": "caen_not_set",
                "message": (
                    "Industry is not set for this period. Open the "
                    "industry picker to choose one."
                ),
                "period_id": period_id,
                "org_id": org_id,
            }
        logger.info(
            "benchmark_report period=%s caen=%s source=%s",
            period_id, caen_code, caen_source,
        )

        # Cache hit? Avoid recomputing if the period hasn't been
        # re-analyzed (re-analysis produces a NEW period_id, so the
        # cache key never goes stale incorrectly).
        #
        # Integrity check: cached rows from before the industry-default
        # fix were rendered against `organizations.caen_code` and may
        # carry a different CAEN than the one `_resolve_effective_caen`
        # now resolves. Serving that stale cache would re-introduce
        # the bleed bug. We compare `benchmark_reports.caen_code`
        # against the freshly-resolved CAEN and fall through to
        # recompute when they diverge.
        with _supabase.admin() as ac:
            cached = ac.select(
                "benchmark_reports",
                filters={"period_id": f"eq.{period_id}"},
                columns="report_data,generated_at,caen_code",
                single=True,
            )
            if cached and cached[0].get("caen_code") == caen_code:
                payload = cached[0]["report_data"]
                # PostgREST returns jsonb as a dict already; if it's a
                # string for any reason, decode it.
                if isinstance(payload, str):
                    try:
                        payload = json.loads(payload)
                    except json.JSONDecodeError:
                        payload = None
                if payload and not payload.get("error"):
                    payload["cached"] = True
                    payload["generated_at"] = cached[0].get("generated_at")
                    return payload

        # Load benchmarks for this CAEN.
        with _supabase.admin() as ac:
            bench_rows = ac.select(
                "industry_benchmarks",
                filters={"caen_code": f"eq.{caen_code}"},
                columns="metric_name,p25_value,p50_value,p75_value,unit,source_label,source_year,confidence,notes,caen_label,industry_category",
            )
        if not bench_rows:
            return {
                "error": "benchmarks_not_available",
                "message": (
                    f"Benchmarks for CAEN {caen_code} are not yet in the catalogue. "
                    f"Coverage is expanding — contact support to add your industry."
                ),
                "period_id": period_id,
                "caen_code": caen_code,
            }
        caen_label = bench_rows[0].get("caen_label") or caen_code
        industry_category = bench_rows[0].get("industry_category") or "unknown"
        benchmarks_keyed: Dict[str, Dict[str, Any]] = {
            r["metric_name"]: {
                "p25": float(r["p25_value"]) if r.get("p25_value") is not None else None,
                "p50": float(r["p50_value"]) if r.get("p50_value") is not None else None,
                "p75": float(r["p75_value"]) if r.get("p75_value") is not None else None,
                "unit": r.get("unit"),
                "source": r.get("source_label"),
                # Trust rail: every percentile row now carries the year, the
                # confidence tier (`verified` / `directional` / `estimated`)
                # and the notes string. The FE renders these as inline chips
                # so the user can see exactly where each number came from —
                # no more "AI invented this benchmark" perception.
                "source_year": r.get("source_year"),
                "confidence": r.get("confidence"),
                "notes": r.get("notes"),
            }
            for r in bench_rows
        }

        # Load company metrics + line items.
        with _supabase.per_user(jwt) as client:
            calc = client.select(
                "calculated_metrics",
                filters={"period_id": f"eq.{period_id}"},
                columns="name,value,unit,direction",
            )
            line_items = client.select(
                "statement_line_items",
                filters={"period_id": f"eq.{period_id}"},
                columns="statement,bucket,ro_account_code,ro_account_name,amount",
            )

        # Deep-analysis catalogue data (Phase 7b). Pull peers, leader
        # reasons, and qualitative blocks for the same CAEN. Missing
        # rows are fine — the engine downgrades gracefully when any
        # piece is absent.
        peers_rows: List[Dict[str, Any]] = []
        leader_rows: List[Dict[str, Any]] = []
        qual_payload: Dict[str, Any] = {}
        try:
            with _supabase.admin() as ac:
                peers_rows = ac.select(
                    "industry_peers",
                    filters={"caen_code": f"eq.{caen_code}"},
                    order="display_order.asc",
                )
                leader_rows = ac.select(
                    "industry_leader_reasons",
                    filters={"caen_code": f"eq.{caen_code}"},
                    order="rank.asc",
                )
                qual_rows = ac.select(
                    "industry_qualitative",
                    filters={"caen_code": f"eq.{caen_code}"},
                    single=True,
                )
                if qual_rows:
                    qual_payload = qual_rows[0]
        except Exception:
            logger.exception("[benchmarks] deep-data fetch failed (non-fatal — percentile section still renders)")

        # Resolve the org's display name so the synthetic "this is you"
        # peer row reads correctly in the table.
        company_name = (org_rows[0].get("name") if org_rows else "Your company") or "Your company"

        report = build_benchmark_report(
            period_id=period_id,
            caen_code=caen_code,
            caen_label=caen_label,
            industry_category=industry_category,
            calculated_metrics=calc,
            line_items=line_items,
            benchmarks=benchmarks_keyed,
            peers=peers_rows,
            leader_reasons=leader_rows,
            qualitative={
                "target_tiers": qual_payload.get("target_tiers"),
                "dynamics": qual_payload.get("dynamics"),
                "success_patterns": qual_payload.get("success_patterns"),
                "failure_modes": qual_payload.get("failure_modes"),
                "market_context": qual_payload.get("market_context"),
            } if qual_payload else {},
            company_name=company_name,
        )

        # Cache.
        try:
            with _supabase.admin() as ac:
                ac.upsert(
                    "benchmark_reports",
                    [{
                        "period_id": period_id,
                        "org_id": org_id,
                        "caen_code": caen_code,
                        "report_data": report,
                        "generated_at": datetime.now(timezone.utc).isoformat(),
                    }],
                    on_conflict="period_id",
                    returning=False,
                )
        except Exception:
            logger.exception("[benchmarks] failed to cache report (non-fatal)")

        report["cached"] = False
        return report

    # ─── Level-1 benchmark: from public-records summary ────────────────────
    #
    # When the user uploaded a listafirme.ro / termene.ro / firme.info PDF
    # there's no `financial_period` row, no `calculated_metrics`, no
    # `statement_line_items` — but the public-records briefing carries
    # ~17-20 years of (revenue, profit, debt, fixed assets, current
    # assets, equity, employees) plus identity (name, CUI, CAEN). That's
    # enough for a Level-1 benchmark: net margin, equity ratio, debt-
    # to-equity, debt-to-assets, asset turnover, profit-per-employee.
    # We CANNOT compute EBITDA, gross margin, DIO/DSO/DPO — those
    # require trial-balance depth and the FE shows them as "upload
    # trial balance to unlock" via the DataDepthBanner.
    #
    # Industry detection: CAEN auto-mapped to industry_category via the
    # 2-digit prefix mapper (`_caen_industry_map`), so the user gets a
    # directional comparison even for CAEN codes not in the catalogue
    # (e.g. PORSCHE 4511, PRO TV 5911, ELIT 7830 are NOT in the seed).

    @router.get("/api/benchmarks/public-records/latest")
    def get_public_records_benchmark(
        document_id: Optional[str] = None,
        authorization: Optional[str] = Header(None),
        x_org_id: Optional[str] = Header(None, alias="X-Org-Id"),
    ) -> Dict[str, Any]:
        """Build a Level-1 benchmark from the latest (or specified)
        public-records-summary document. Designed for the case where
        the user has no `financial_period` but has uploaded a
        listafirme-style PDF.

        Query param: `?document_id=<uuid>` pins to a specific document;
        otherwise uses the most recent public-records doc for the org.

        Returns a payload shaped to be compatible with the FE benchmark
        page's existing renderer:
          { mode: "level_1_public_records",
            company: {name, cui, caen_code, caen_label, ...},
            industry: {category, source, label},
            depth: "public_summary",
            latest_year: {...},
            history: [...],
            comparisons: [{metric_name, company_value, benchmark, verdict, ...}],
            generated_at: "...",
            warnings: ["upload trial balance for EBITDA / DIO / ..."] }
        """
        jwt = _require_jwt(authorization)
        _, org_id = _resolve_user_org(jwt, x_org_id)

        # 1. Locate the public-records document.
        with _supabase.per_user(jwt) as client:
            if document_id:
                rows = client.select(
                    "sku_analyses",
                    columns="*,documents!inner(id,original_filename,status,detected_type,created_at,org_id)",
                    filters={"document_id": f"eq.{document_id}"},
                    single=True,
                )
            else:
                # Over-fetch and client-side filter on briefing.kind
                rows = client.select(
                    "sku_analyses",
                    columns="*,documents!inner(id,original_filename,status,detected_type,created_at,org_id)",
                    order="created_at.desc",
                    limit=10,
                )

        extract: Optional[Dict[str, Any]] = None
        for r in rows or []:
            briefing = r.get("briefing")
            if isinstance(briefing, str):
                try:
                    briefing = json.loads(briefing)
                except (json.JSONDecodeError, TypeError):
                    briefing = {}
            briefing = briefing or {}
            if isinstance(briefing, dict) and briefing.get("kind") == "public_records_summary":
                extract = {**briefing, "_row": r}
                break

        if not extract:
            raise HTTPException(
                404,
                "No public-records summary found for this user. "
                "Upload a listafirme.ro / termene.ro / firme.info PDF first.",
            )

        # Defensive scope check against the resolved org.
        _doc = (extract["_row"].get("documents") or {})
        if _doc.get("org_id") and _doc["org_id"] != org_id:
            raise HTTPException(403, "Document belongs to a different organization.")

        years_raw = extract.get("years") or []
        if not years_raw:
            raise HTTPException(422, "Public-records extract has no year rows.")

        # 2. Compute Level-1 metrics on the latest year. years_raw is
        #    newest-first per the parser; latest is at index 0.
        latest = years_raw[0]
        prev = years_raw[1] if len(years_raw) > 1 else None

        def _f(x: Any) -> Optional[float]:
            if x is None: return None
            try: return float(x)
            except (TypeError, ValueError): return None

        cifra   = _f(latest.get("cifra_afaceri"))
        profit  = _f(latest.get("profit_net"))
        debt    = _f(latest.get("datorii_totale"))
        imob    = _f(latest.get("active_imobilizate"))
        circ    = _f(latest.get("active_circulante"))
        cap     = _f(latest.get("capitaluri_proprii"))
        sal     = _f(latest.get("salariati"))
        total_assets = (imob or 0) + (circ or 0)

        def _safe_div(a: Optional[float], b: Optional[float]) -> Optional[float]:
            if a is None or b is None or b == 0: return None
            return a / b

        # Level-1 derivable metrics.
        metrics: Dict[str, Optional[float]] = {
            "revenue":              cifra,
            "net_profit":           profit,
            "total_debt":           debt,
            "total_assets":         total_assets if total_assets > 0 else None,
            "total_equity":         cap,
            "employees":            sal,
            "net_margin":           _safe_div(profit, cifra) if cifra and cifra > 0 else None,
            "equity_ratio":         _safe_div(cap, total_assets) if total_assets > 0 else None,
            "debt_to_equity":       _safe_div(debt, cap) if cap and cap > 0 else None,
            "debt_to_assets":       _safe_div(debt, total_assets) if total_assets > 0 else None,
            "asset_turnover":       _safe_div(cifra, total_assets) if total_assets > 0 else None,
            "revenue_per_employee": _safe_div(cifra, sal) if sal and sal > 0 else None,
            "profit_per_employee":  _safe_div(profit, sal) if sal and sal > 0 else None,
        }

        # Growth metrics (vs prior year) — directional signal.
        if prev:
            prev_rev = _f(prev.get("cifra_afaceri"))
            prev_prf = _f(prev.get("profit_net"))
            metrics["revenue_yoy_pct"] = _safe_div(
                (cifra - prev_rev) if (cifra is not None and prev_rev) else None,
                abs(prev_rev) if prev_rev else None,
            )
            metrics["profit_yoy_pct"] = _safe_div(
                (profit - prev_prf) if (profit is not None and prev_prf is not None) else None,
                abs(prev_prf) if prev_prf else None,
            )

        # 3. Resolve industry. CAEN-exact catalogue first; if no rows,
        #    fall back to the 2-digit-prefix → industry_category mapping
        #    and aggregate benchmarks across all CAENs in that category.
        caen_code: Optional[str] = extract.get("caen_code")
        caen_desc: Optional[str] = extract.get("caen_description") or caen_label_fallback(caen_code)
        industry_category, mapping_source = caen_to_category(caen_code)

        bench_rows: List[Dict[str, Any]] = []
        bench_source = "none"
        with _supabase.admin() as ac:
            if caen_code:
                bench_rows = ac.select(
                    "industry_benchmarks",
                    filters={"caen_code": f"eq.{caen_code}"},
                    columns="metric_name,p25_value,p50_value,p75_value,unit,source_label,source_year,confidence,notes,caen_label,industry_category",
                )
            if bench_rows:
                bench_source = "exact_caen"
            else:
                # Fall back to industry_category aggregation. We pick the
                # MEDIAN of the p25/p50/p75 across CAENs within the same
                # category — directional but honest, and only used when
                # the user's exact CAEN isn't catalogued.
                cat_rows = ac.select(
                    "industry_benchmarks",
                    filters={"industry_category": f"eq.{industry_category}"},
                    columns="metric_name,p25_value,p50_value,p75_value,unit,source_label,source_year,confidence,notes,caen_label,industry_category",
                )
                if cat_rows:
                    # Aggregate by metric_name → median p25/p50/p75.
                    by_metric: Dict[str, List[Dict[str, Any]]] = {}
                    for r in cat_rows:
                        by_metric.setdefault(r["metric_name"], []).append(r)
                    def _median(xs: List[Any]) -> Optional[float]:
                        nums = sorted(float(x) for x in xs if x is not None)
                        if not nums: return None
                        n = len(nums)
                        return nums[n // 2] if n % 2 == 1 else (nums[n // 2 - 1] + nums[n // 2]) / 2
                    for metric_name, rows_for_metric in by_metric.items():
                        bench_rows.append({
                            "metric_name": metric_name,
                            "p25_value": _median([r.get("p25_value") for r in rows_for_metric]),
                            "p50_value": _median([r.get("p50_value") for r in rows_for_metric]),
                            "p75_value": _median([r.get("p75_value") for r in rows_for_metric]),
                            "unit":      rows_for_metric[0].get("unit"),
                            "source_label": "industry_category_aggregate",
                            "source_year":  None,
                            "confidence":   "directional",
                            "notes": (
                                f"Aggregated across {len(rows_for_metric)} CAEN(s) in "
                                f"category '{industry_category}'. Exact CAEN {caen_code} "
                                f"not yet in catalogue."
                            ),
                            "caen_label": caen_desc,
                            "industry_category": industry_category,
                        })
                    bench_source = "category_aggregate"

        # Scale-normalize benchmark percentiles to match the company-value
        # scale (decimal ratios — `0.05` for 5%).
        #
        # The seed table `industry_benchmarks` stores percentage metrics
        # as whole-percent values (`unit='pct'`, e.g. net_margin p50=4.0
        # meaning 4%). The Level-1 company values computed earlier in
        # this endpoint are decimal ratios (e.g. net_margin=0.056). The
        # FE renders both with `(v * 100).toFixed(1)%`, so without
        # normalization the benchmark gets multiplied by 100 a second
        # time → "350% median net_margin", "5500% P75 equity_ratio"
        # — the exact impossible numbers the user reported.
        #
        # Fix: convert benchmark percentiles to the ratio scale here, at
        # the single point where they enter the API payload. The FE keeps
        # its existing "*100 once" rendering. Bug-confined fix:
        # this endpoint only — does NOT touch `/api/benchmarks/report/`,
        # does NOT touch the seed table, does NOT touch the FE.
        def _scale_to_ratio(v: Optional[float], unit: Optional[str]) -> Optional[float]:
            if v is None:
                return None
            return v / 100.0 if (unit and unit.lower() == "pct") else v

        benchmarks_keyed: Dict[str, Dict[str, Any]] = {}
        for r in bench_rows:
            u = r.get("unit")
            benchmarks_keyed[r["metric_name"]] = {
                "p25": _scale_to_ratio(
                    float(r["p25_value"]) if r.get("p25_value") is not None else None, u),
                "p50": _scale_to_ratio(
                    float(r["p50_value"]) if r.get("p50_value") is not None else None, u),
                "p75": _scale_to_ratio(
                    float(r["p75_value"]) if r.get("p75_value") is not None else None, u),
                "unit": u,
                "source": r.get("source_label"),
                "source_year": r.get("source_year"),
                "confidence": r.get("confidence"),
                "notes": r.get("notes"),
            }

        # 4. Build comparisons for the metrics where we have BOTH a
        #    company value AND a benchmark. Skip silently otherwise —
        #    the FE renders the available comparisons + an "available
        #    at Level 1 but no benchmark seeded" note for the rest.
        DIRECTION = {  # lower_is_better
            "net_margin": False, "equity_ratio": False,
            "debt_to_equity": True, "debt_to_assets": True,
            "asset_turnover": False, "revenue_per_employee": False,
            "profit_per_employee": False, "revenue_yoy_pct": False,
            "profit_yoy_pct": False,
        }

        def _verdict(value: Optional[float], b: Dict[str, Any],
                     lower_is_better: bool) -> str:
            if value is None or b.get("p50") is None:
                return "not_available"
            p25, p50, p75 = b.get("p25"), b.get("p50"), b.get("p75")
            if lower_is_better:
                if p25 is not None and value <= p25: return "top_quartile"
                if value <= p50: return "above_median"
                if p75 is not None and value <= p75: return "below_median"
                return "bottom_quartile"
            if p75 is not None and value >= p75: return "top_quartile"
            if value >= p50: return "above_median"
            if p25 is not None and value >= p25: return "below_median"
            return "bottom_quartile"

        comparisons = []
        for metric_name, value in metrics.items():
            if metric_name in ("revenue", "net_profit", "total_debt",
                               "total_assets", "total_equity", "employees"):
                continue  # absolute size, not a ratio — skipped for comparison
            b = benchmarks_keyed.get(metric_name)
            if not b:
                continue
            lower = DIRECTION.get(metric_name, False)
            comparisons.append({
                "metric_name": metric_name,
                "company_value": value,
                "benchmark": b,
                "verdict": _verdict(value, b, lower),
                "lower_is_better": lower,
            })

        warnings = []
        if bench_source == "category_aggregate":
            warnings.append(
                f"Exact CAEN {caen_code} ({caen_desc}) not yet in catalogue. "
                f"Showing aggregated benchmarks across the '{industry_category}' category."
            )
        elif bench_source == "none":
            warnings.append(
                f"No benchmarks seeded yet for CAEN {caen_code} or its category "
                f"'{industry_category}'. Coverage is expanding; metrics above are "
                f"shown without industry comparison."
            )
        warnings.append(
            "Data depth: Public Financial Summary (Level 1). EBITDA, gross "
            "margin, cost structure, and DIO/DSO require a trial balance upload."
        )

        return {
            "mode": "level_1_public_records",
            "company": {
                "name": extract.get("company_name"),
                "cui": extract.get("cui"),
                "reg_com": extract.get("reg_com"),
                "caen_code": caen_code,
                "caen_label": caen_desc,
            },
            "industry": {
                "category": industry_category,
                "source": mapping_source,
                "label": caen_desc,
            },
            "benchmark_source": bench_source,
            "depth": "public_summary",
            "depth_level": 1,
            "latest_year": {
                "year": latest.get("year"),
                "metrics": metrics,
            },
            "history": years_raw,
            "comparisons": comparisons,
            "warnings": warnings,
            "document_id": _doc.get("id"),
            "generated_at": datetime.now(timezone.utc).isoformat(),
        }

    return router
