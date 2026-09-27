"""Phase 3 pipeline orchestrator — turn an uploaded document into a populated
financial period the UI can render.

Endpoints:
  POST /api/pipeline/run     { document_id }   → 202 (async kicked off)
  POST /api/pipeline/retry   { document_id }   → 202 (resets + reruns)
  GET  /api/period/:id                          → consolidated payload

Pipeline stages (each updates documents.status as it starts):
  queued → extracting → mapping → computing → narrating → analyzed | failed

Stages:
  detect   — filename + LLM classifier
  ocr      — Claude Opus 4.7 reads PDF directly (no separate OCR call)
  extract  — Same call returns structured RO accounts
  map      — _ro_coa.assemble_statements() rolls accounts into BS/PL buckets
  assemble — Statements blob + statement_line_items rows
  validate — BS-balance + sanity checks → alerts (data_quality)
  compute  — calculated_metrics rows (revenue, EBITDA, margin, leverage, ratios…)
  narrate  — Opus 4.7 → briefing + recommendations + alerts
  finalize — documents.status = 'analyzed'; documents.period_id set

CRITICAL: every stage is idempotent. retry() wipes prior derivatives before
re-running so the user can re-attempt without ghost data.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
import traceback
import uuid
from datetime import date, datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, Query
from pydantic import BaseModel, Field

from . import _detect
from . import _doc_dedupe
from . import _journal_routes
from . import _ops_routes
from . import _org
# PERIOD DETECTION (Part B) — the ONE hint-free answer to "which
# period does this document belong to?", shared by stage_persist and
# the /api/period/detect route the upload UI calls. One service means
# the engine and the UI can never disagree about a document's month.
from . import _period_detect
# PERIOD MOVE (Part D) — the correction path for rows that were ALREADY
# misfiled before Part B landed. Re-files a document under a month the
# human confirmed for it and invalidates whatever the departure
# orphaned; the actual re-filing is delegated back to stage_persist via
# the hint, so there is no second implementation of "which period".
from . import _period_move
# What the plan COUNTED, per document, where the browser cannot write it
# (verifier lens S): whether a run is metered, and what the settlement
# records. See `_needs_metering` and `_commit_pipeline_quota`.
from . import _quota_ledger
from . import _ratio_units
from . import _reconcile
from . import _supabase
from . import _usage_limits
from . import _valuation

# F3.1c — Country-pack dispatch. The pack is reached via the registry
# rather than direct module imports so country-specific behaviour
# (account-code mapping, parsing, industry classification) can be
# swapped at runtime in F3.3+. Importing the ro_romania subpackage as
# a side-effect registers the Romania pack with the registry.
import engine.country_packs.ro_romania  # noqa: F401  — side-effect: registers RomaniaPack
# The day-count rule (`period_days_covered`) is pack data + a pure function;
# read directly, like the net-income anchor helpers below.
from engine.country_packs.ro_romania import chart_of_accounts as _ro_chart_of_accounts
# The text-line balanta PDF reader and the parser version its five-pair
# layout is gated on. Imported here, not lazily inside stage_extract: a
# reader that cannot import must fail the engine's boot loudly — never let
# a five-pair PDF fall through to the positional fast-path or Claude.
from engine.country_packs.ro_romania import pdf_balanta_text as _pdf_balanta_text
from engine.country_packs.ro_romania import trial_balance_parser as _ro_tb_parser
from engine import ai_lane as _ai_lane  # HU/OTHER jurisdiction AI extraction lane
from engine.ai_lane import routes as _ai_lane_routes
# Account-121 anchor provenance — the SAME code object the offline seam
# (RomaniaPack.assemble_parsed_tb) stamps with, so the served and
# offline `assembled_pl` can never carry different field sets.
from engine.core import net_income_anchor as _net_income_anchor
from engine.ratios import credit_boundary as _credit_boundary
from engine.ratios import credit_model as _credit_model
# sv1 FACTS GATEWAY — the ONE typed reader of served (reconciliation-
# adjusted) balance-sheet truth. Every totals-level read in this module
# goes through it; raw envelope/canonical_bs totals reads are forbidden
# here (scripts/check_import_boundary.py enforces the boundary).
from engine.serving.facts import FactsGateway as _FactsGateway
from engine.serving.facts import MissingFactError as _MissingFact
# RUN JOURNAL (Part A) — event-sourced spine around the pipeline. Every
# hook below is a COMPLETE NO-OP unless ENGINE_JOURNAL_DIR is set (the
# corpus replay and determinism gates run without it, so goldens cannot
# move); hooks never raise and never mutate their arguments. The DB
# envelope write in stage_persist remains the serving source of truth.
from engine.journal import hooks as _journal_hooks
# Model registry (engine/ai/models.yaml) — the single config source for
# every AI model id + prompt version. Value-identical wiring (red test:
# tests/engine/test_pipeline_registry_wiring.py); a model bump is a
# models.yaml edit + recorded eval run, never a code change.
from engine.ai import registry as _model_registry
# Advisory pass (AI Decision Engine) — additive-only, env-gated OFF by
# default (AI_ADVISORY_ENABLED); the hook never raises and can never
# mutate status/totals (R1/R2, tests/engine/test_ai_advisory.py).
from engine.ai import advisory as _ai_advisory

# ── Registry-resolved model ids — READ AT FIRST USE, never at import ────
#
# `_EXTRACT_MODEL` / `_NARRATIVE_MODEL` (roles per engine/ai/models.yaml)
# were module-level registry reads. This module is in the import closure
# of `from engine.api import create_app` (server.py imports it; `python
# -m engine serve` -> __main__._cmd_serve -> create_app), so a registry
# that could not resolve — a missing role, an unreadable file, a role
# with no breaker caps — was a RegistryError at IMPORT: no app, no
# process, the §14 restart-loop shape, and the deterministic firm board
# (which reads no model) died with it (critic D6, 2026-09-05; gated by
# tests/engine/test_firm_real_app.py on the REAL create_app in a fresh
# process). The same shape as engine.api._reconcile: the two names stay
# module attributes (PEP 562 `__getattr__` below — `pipeline._EXTRACT_
# MODEL` reads as before, a monkeypatch still wins), the use sites call
# the cached accessors `_extract_model()` / `_narrative_model()` (a bare
# global read inside this module never consults `__getattr__`), and the
# registry's failure stays LOUD at the first AI call that needs the id.
_REGISTRY_MODEL_ROLES = {"_EXTRACT_MODEL": "extract", "_NARRATIVE_MODEL": "narrative"}


def _resolve_registry_model(name: str) -> str:
    """Read the role's model id from the registry and pin it into this
    module's globals (later reads are plain attribute reads). Raises the
    registry's own RegistryError when it cannot resolve — at the seam."""
    value = str(_model_registry.model_for(_REGISTRY_MODEL_ROLES[name]))
    globals().setdefault(name, value)
    return globals()[name]


def __getattr__(name: str) -> Any:
    if name in _REGISTRY_MODEL_ROLES:
        return _resolve_registry_model(name)
    raise AttributeError("module %r has no attribute %r" % (__name__, name))


def _model_constant(name: str) -> str:
    """The pinned (or monkeypatched) module global when one exists, else
    the registry read that pins it."""
    value = globals().get(name)
    return str(value) if value is not None else _resolve_registry_model(name)


def _extract_model() -> str:
    """The model id for the `extract` role — the RO LLM fallback."""
    return _model_constant("_EXTRACT_MODEL")


def _narrative_model() -> str:
    """The model id for the `narrative` role — the narrate family."""
    return _model_constant("_NARRATIVE_MODEL")


# F4.5 — Hungary pack (SKELETON / UNCALIBRATED). Registered so F4.4 fan-out
# routing can exercise multi-pack logic. detect_from_content() returns 0.0
# confidence so the RO pack always wins on RO uploads.
try:
    import engine.country_packs.hu_hungary  # noqa: F401
except Exception:  # noqa: BLE001
    # Skeleton may not be deployed in every environment; non-fatal.
    pass


# F4.6 — deprecated fields list (static, cheap to re-emit per request).
# Imported once at module load; returned in /api/period responses to give
# consumers migration targets before the 2Q sunset.
def _deprecated_fields_for_response() -> List[Dict[str, Any]]:
    try:
        from .deprecated_fields import deprecated_fields_list
        return deprecated_fields_list()
    except Exception:  # noqa: BLE001
        return []
from engine.core.country_pack_registry import get_pack as _get_country_pack


def _ro_pack():
    """Lazy resolver for the Romania country pack. Cached on first
    call; raises a clear error if the pack failed to register (which
    indicates an import-time failure inside the pack module, not a
    routine missing-country case)."""
    pack = _get_country_pack("RO")
    if pack is None:
        raise RuntimeError(
            "Romania country pack not registered. Check that "
            "engine.country_packs.ro_romania imported cleanly."
        )
    return pack


logger = logging.getLogger(__name__)


# ── Loud-failure state for the DIO-columns-missing fallback ──────────
# When sku_aggregates lacks days_inventory_on_hand / inventory_value_krn
# / cogs_krn, the insert retry path silently drops those values to keep
# the upload alive. Without this tracker the warning log scrolled past
# unnoticed for weeks. We capture: when it last fired, how many rows were
# affected, and the dataset_id, so /api/health can surface the degraded
# state and the FE can render a "schema migration pending" banner.
_DIO_DROP_STATE: Dict[str, Any] = {
    "degraded": False,
    "last_drop_at": None,
    "last_dataset_id": None,
    "total_rows_dropped": 0,
    "drop_event_count": 0,
    "first_error_sample": None,
}


def _record_dio_drop(*, dataset_id: str, rows_dropped: int, first_error: str) -> None:
    """Mark DIO persistence as degraded. Reset by the next clean upload."""
    _DIO_DROP_STATE["degraded"] = True
    _DIO_DROP_STATE["last_drop_at"] = _now_iso() if "_now_iso" in globals() else None
    _DIO_DROP_STATE["last_dataset_id"] = dataset_id
    _DIO_DROP_STATE["total_rows_dropped"] += rows_dropped
    _DIO_DROP_STATE["drop_event_count"] += 1
    if not _DIO_DROP_STATE.get("first_error_sample"):
        _DIO_DROP_STATE["first_error_sample"] = first_error


def get_dio_persistence_state() -> Dict[str, Any]:
    """Read-only snapshot for /api/health. Public — imported by _health.py."""
    return dict(_DIO_DROP_STATE)


def reset_dio_persistence_state() -> None:
    """Clear the degraded flag — called after a clean upload that
    succeeds without hitting the column-missing fallback. Operator can
    also clear via a one-shot admin endpoint if needed."""
    _DIO_DROP_STATE["degraded"] = False


class PublicRecordsUnparseableError(Exception):
    """Raised when stage_extract detects a listafirme.ro / termene.ro / firme.info
    public-records PDF (via `_public_records_parser.looks_like_public_records`)
    but the year-row extractor recovers zero rows from the document.

    Without this guard, the document falls through to the Claude TB extractor,
    which hallucinates trial-balance numbers from a 6-aggregate annual table
    (the original failure mode: revenue = EBITDA = net income, or 1,921 RON
    total assets on ELIT). Surfacing as an exception lets the outer pipeline
    handler at `_run_pipeline_sync` mark the document `status='failed'` with
    a user-readable `error` string, and STOPS the Claude TB path from ever
    seeing this PDF.
    """


class BalantaPdfRefusedError(Exception):
    """Raised when stage_extract recognises a five-column-pair balanta PDF
    (Sold initial / Rulaj anterior / Rulaj curent / Total rulaj / Sold
    final — `pdf_balanta_text`) and the verified text-line reader REFUSES
    it, or its verified read cannot be served.

    Without this guard the refused document fell through to the positional
    fast-path, which reads only undotted account codes and accepts on the
    account-121 anchor alone — so a book the reader had just refused (one
    row off by a cent, a class total missing, every pair printed
    credit-first) was served anyway from a partial read: one account of
    twenty-eight, or a profit read as a loss. The reader refuses rather
    than approximates, and so does the pipeline: the outer handler in
    `_run_pipeline_sync` marks the document `status='failed'` with this
    message as `documents.error` and releases the quota reservation.
    Nothing is estimated from the document, and Claude never sees it.

    A document whose header names BOTH balanta layouts is refused the same
    way, with its own message (`balanta_refusal_message`): it is not told
    it is a five-pair balanta. So is a balanta printed with FOUR column
    pairs whose zeros print as blank cells (Sold initial / Rulaje / Total /
    Solduri finale — LAYOUT_FOUR_PAIR_COLUMNS): read strictly, each figure
    placed by the column it is printed in, or refused with its own message.
    """


_BALANTA_REFUSAL_NEXT_STEP = (
    "Nothing was estimated from it. Upload the same balanta exported as Excel (.xlsx), "
    "or a PDF printed directly from the accounting program."
)


def balanta_refusal_message(layout: Optional[str], reason: str) -> str:
    """The user-facing `documents.error` for a balanta PDF the text-line
    reader refused. It names the layout the header ACTUALLY names: a header
    naming both layouts is not told it is a five-pair balanta — it is told
    the header names both, which is why no column can be read from it."""
    if layout == _pdf_balanta_text.LAYOUT_FOUR_PAIR_COLUMNS:
        return (
            "This PDF is a balanta de verificare printed with four column pairs "
            "(Sold initial / Rulaje / Total / Solduri finale), but it was not read: %s. "
            % reason + _BALANTA_REFUSAL_NEXT_STEP
        )
    if layout == _pdf_balanta_text.LAYOUT_BOTH:
        return (
            "This PDF's header names both balanta layouts — the one printed in four column "
            "blocks (Solduri initiale / Rulaje / Sume totale / Solduri finale) and the one "
            "printed in five column pairs (Sold initial / Rulaj anterior / Rulaj curent / "
            "Total rulaj / Sold final) — so which printed column holds which figure cannot be "
            "read from it. " + _BALANTA_REFUSAL_NEXT_STEP
        )
    return (
        "This PDF is a balanta de verificare printed with five column pairs "
        "(Sold initial / Rulaj anterior / Rulaj curent / Total rulaj / Sold final), "
        "but it was not read: %s. " % reason + _BALANTA_REFUSAL_NEXT_STEP
    )


# ─── Helpers ────────────────────────────────────────────────────────────────


def _require_jwt(authorization: Optional[str]) -> str:
    # PUBLIC_TEST_MODE bypass — see `_test_mode.py`. When the env flag is
    # on, every request is treated as authenticated as the shared test
    # user (id from TEST_USER_ID). Real customer orgs remain isolated
    # because the test user has membership only in TEST_ORG_ID.
    from . import _test_mode
    if _test_mode.is_test_mode():
        # Mint (and cache) a real Supabase access_token for the synthetic
        # test user — keeps RLS active (scoped to test org via the test
        # user's membership). See _test_mode.get_test_user_jwt().
        try:
            return _test_mode.get_test_user_jwt()
        except Exception:  # noqa: BLE001
            logger.exception("[test_mode] JWT mint failed; falling back to placeholder.")
            return _test_mode.JWT_BYPASS_PLACEHOLDER
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "Missing Bearer token.")
    return authorization.split(" ", 1)[1].strip()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _sane_period_end(iso: Optional[str]) -> Optional[str]:
    """Reject implausible period dates. Real workspaces have ended up with
    periods like 5309-03-31 and 2050-12-31 (Excel serials / account codes
    misread as dates by filename parsing or LLM extraction) — those labels
    then leak into every surface ("MAR. 5309" in the header, operator
    mobile screenshot 2026-08-04). Anything outside 2000..2035 is treated
    as no-detection so callers fall back to today / current month."""
    if not iso:
        return None
    try:
        y = int(str(iso)[:4])
    except ValueError:
        return None
    return iso if 2000 <= y <= 2035 else None


def _detect_period_end_from_filename(filename: Optional[str]) -> str:
    """Extract the trial-balance date from a Romanian ERP export filename.

    Patterns we've actually seen in customer uploads:
      - 'Balanta Scandia Food_31.12.2025 LV.xls'  → '2025-12-31'
      - 'Balanta_EEI_dec_2025.pdf'                → '2025-12-31' (month-name)
      - 'scandia trial balance 2025.xlsx'         → '2025-12-31' (year only)
      - 'balanta_verificare_dec_2025.xlsx'        → '2025-12-31'
      - 'TB-2024-09-30.xlsx'                      → '2024-09-30'

    Falls back to today's date when no pattern matches — logs a warning so
    the misclassification is visible. Never raises.
    """
    import re
    if not filename:
        logger.warning("[period_end] no filename — defaulting to today")
        return date.today().isoformat()

    name = filename.strip()
    # Pattern: DD.MM.YYYY or DD_MM_YYYY or DD-MM-YYYY (Romanian convention)
    m = re.search(r"(\d{1,2})[._\-](\d{1,2})[._\-](\d{4})", name)
    if m:
        d, mo, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
        try:
            candidate = date(y, mo, d).isoformat()
            if _sane_period_end(candidate):
                return candidate
        except ValueError:
            pass
    # Pattern: YYYY-MM-DD or YYYY_MM_DD
    m = re.search(r"(\d{4})[._\-](\d{1,2})[._\-](\d{1,2})", name)
    if m:
        y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
        try:
            candidate = date(y, mo, d).isoformat()
            if _sane_period_end(candidate):
                return candidate
        except ValueError:
            pass
    # Pattern: month-name + year ("dec 2025", "decembrie 2025")
    months_ro = {
        "ian": 1, "feb": 2, "mar": 3, "apr": 4, "mai": 5, "iun": 6,
        "iul": 7, "aug": 8, "sep": 9, "oct": 10, "noi": 11, "dec": 12,
    }
    # Replace separators with spaces so the regex sees real word boundaries
    # ('balanta_EEI_dec_2025' → 'balanta eei dec 2025').
    name_lower = re.sub(r"[._\-]+", " ", name.lower())
    for tag, mo in months_ro.items():
        m = re.search(rf"\b{tag}\w*\b.*?(\d{{4}})", name_lower)
        if m:
            y = int(m.group(1))
            try:
                # Default to end of month — that's the trial-balance convention.
                import calendar
                last_day = calendar.monthrange(y, mo)[1]
                candidate = date(y, mo, last_day).isoformat()
                if _sane_period_end(candidate):
                    return candidate
            except ValueError:
                pass
    # Year-only pattern — assume end of year.
    m = re.search(r"\b(20\d{2})\b", name)
    if m:
        return date(int(m.group(1)), 12, 31).isoformat()

    logger.warning("[period_end] no date pattern in filename %r — defaulting to today", name)
    return date.today().isoformat()


def _verify_user_owns_document(jwt: str, document_id: str) -> Dict[str, Any]:
    """Returns the document row when the JWT-bearing user has read access.
    Raises 403 otherwise.
    """
    with _supabase.per_user(jwt) as client:
        rows = client.select(
            "documents",
            filters={"id": f"eq.{document_id}"},
            single=True,
        )
        if not rows:
            raise HTTPException(404, f"Document {document_id} not found or not visible to you.")
        return rows[0]


def _user_id_from_jwt(jwt: str) -> str:
    """The calling user's VERIFIED id (engine.api._jwt through
    `_org.verified_user_id`; the PUBLIC_TEST_MODE seam included). 401 when
    the bearer's signature does not verify, 503 when no signing key can be
    obtained. Until 2026-09-05 (FC1x, critic D5) this read the id through
    `per_user(jwt).get_user(jwt)` — an unverified payload decode in the
    real client and in every double that stood in for it."""
    return _org.verified_user_id(jwt)


# ── THE WRITE WALL (FC1x, critic D4, 2026-09-05) ────────────────────────
# Every mutating route below used to authorize on "is the row visible to
# the caller under per_user?" and then write through the service role.
# The firm READ policies (schema_phase_firm.sql: `can_read_client_org`)
# make a client's rows visible to a firm viewer with a read cell and NO
# membership — so that viewer hard-deleted a client's period, re-ran and
# re-filed its documents through these routes (crit_pipeline_census.py:
# DELETE /api/period/{id} 200 row gone, POST .../reextract 200,
# POST /api/documents/{id}/move-period 200, POST /api/pipeline/run 202).
# A write needs a `memberships` row in the org it targets; visibility is
# the READ wall and never the write wall. `_org.require_org_member` is the
# one helper; these wrap it in the shapes the handlers need. The census
# and the viewer sweep live in tests/engine/test_identity_wall.py.


def _verify_user_may_write_document(jwt: str, document_id: str) -> Dict[str, Any]:
    """Visible to the caller under RLS (404 otherwise) AND the caller holds
    a memberships row in the document's org (403 otherwise). Returns the
    document row. Firm visibility never writes a client's books. The
    identity is verified FIRST, before any table read: a forged bearer is
    401 from the verifier, never a 404 from an anonymous read."""
    _org.verified_user_id(jwt)
    doc = _verify_user_owns_document(jwt, document_id)
    _org.require_org_member(jwt, doc.get("org_id"))
    return doc


def _verify_user_may_write_period(jwt: str, period_id: str) -> Dict[str, Any]:
    """The same wall for period-scoped mutations. Returns the period row."""
    _org.verified_user_id(jwt)
    with _supabase.per_user(jwt) as client:
        rows = client.select(
            "financial_periods",
            filters={"id": f"eq.{period_id}"},
            single=True,
        )
    if not rows:
        raise HTTPException(404, "Period not found or not visible to you.")
    _org.require_org_member(jwt, rows[0].get("org_id"))
    return rows[0]


def _require_member(jwt: str, org_id: Optional[str]) -> str:
    """`_org.require_org_member`, looked up at call time — for handlers
    that bind a LOCAL name `_org` further down (review/reanalyze does) and
    therefore cannot name the module directly."""
    return _org.require_org_member(jwt, org_id)


def _only_member_orgs(jwt: str, rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """For the bulk routes whose scope is 'everything visible to me'
    (clear-deleted, recover-stuck): keep only rows in orgs the caller is a
    MEMBER of. A firm viewer's visible-but-not-mine rows are left alone."""
    member_of = set(_org.member_org_ids(_user_id_from_jwt(jwt)))
    return [r for r in rows if str(r.get("org_id")) in member_of]


def _admin_set_status(doc_id: str, status: str, *, error: Optional[str] = None,
                      duration_ms: Optional[int] = None,
                      period_id: Optional[str] = None,
                      pipeline_started_at: Optional[str] = None) -> None:
    patch: Dict[str, Any] = {"status": status}
    if error is not None:
        patch["error"] = error
    elif status != "failed":
        patch["error"] = None
    if duration_ms is not None:
        patch["duration_ms"] = duration_ms
    if period_id is not None:
        patch["period_id"] = period_id
    if pipeline_started_at is not None:
        patch["pipeline_started_at"] = pipeline_started_at
    with _supabase.admin() as client:
        client.update("documents", patch, filters={"id": f"eq.{doc_id}"})


# ─── Pipeline stages ────────────────────────────────────────────────────────


# ─── Multi-format extraction ────────────────────────────────────────────────
# stage_extract dispatches on file type. The original PDF-only path lives at
# /api/financial-statements/parse and is reused for actual PDFs. For everything
# else (XLSX, CSV, JPG, PNG, plain text) we call Claude directly with the
# appropriate content block shape, using a broader extraction prompt that
# accepts trial balances, balance sheets, P&Ls, invoice registers, sales
# analyses, product catalogs, and bank statements.

_BROAD_SYSTEM_PROMPT = """You are a forensic accountant analyzing a financial business document.

Your job: extract structured financial data from whatever the user uploaded.
The document might be a Romanian trial balance ("balanță de verificare"), a
bilanț (balance sheet), a P&L, an invoice register (e-Factura / SAF-T /
SmartBill / generic CSV), a sales-by-product analysis, a bank statement, or
any other accounting / business document.

ADDITIONAL EXTRACTION FOR SKU/SALES DOCUMENTS:
If the document contains SKU-level or product-level rollups (sales by
product, trading analysis, invoice register with line items, inventory
report), populate the `skus` array with the MOST MATERIAL rows only —
AT MOST 25 rows, ranked by revenue (or volume when revenue is absent).
DO NOT echo every line: the full per-SKU portfolio is parsed separately
by a deterministic reader, so this array is only a representative sample
for the executive briefing. Emitting hundreds of rows overflows the
output budget and truncates the JSON — keep it to 25 at most.
Each SKU row: { sku, brand, category, channel, volume, volume_unit,
units_sold, revenue, cogs, gross_margin, gross_margin_pct,
inventory_value, days_inventory_on_hand }. All numeric fields default to
null when not in the source. Volume in tonnes when the data is in tonnes,
otherwise "units". For trading analyses with NIV (Net Invoiced Value),
treat NIV as `revenue`. For documents with only category-level rollups
(no individual SKUs), emit one row PER category as the sku ("CATEGORY:
PESTE") with category=name and brand=null — these synthetic rows still
let the engine classify portfolio segments.

CRITICAL RULES — read these before extracting:

1. Output STRICT JSON matching <schema>. No prose, no preamble, no markdown
   fences. The first character of your reply must be '{'.

2. Identify the document type and set `detected_type` accordingly. Acceptable
   values: trial_balance | bilant | pl | annual_report | invoice_register |
   sales_analysis | bank_statement | unknown.

3. If the document IS a trial balance / bilanț / P&L (financial statements):
   extract account rows into the `accounts` array using Romanian OMFP-1802
   account codes. Each account: closing balance (sold final). For accounts
   with separate debit/credit columns, follow standard signing — Class 1, 4
   (passive), 5 (passive), 7 take credit, emit positive; Class 2, 3, 4
   (active), 5 (active cash), 6 take debit, emit positive. If the codes
   aren't shown, map line items to canonical RO codes (5121 cash, 4111 AR,
   371 inventory, 212 PPE, 401 AP, 1621 LT debt, 1012 share capital, 117
   retained earnings, 704/706 revenue, 602 materials, 628 services, 641
   salaries, 681 D&A, 666 interest, 691 tax).

4. If the document IS NOT a financial statement (e.g. invoice register,
   sales analysis, product list): leave `accounts` as an empty array. Do
   NOT invent accounts. Populate `summary` with what the document IS and
   what it contains so downstream tabs can render it. Suggested fields:
       summary.row_count            — number of detail rows
       summary.headline_total       — RON total if obvious
       summary.headline_label       — what the total represents
       summary.top_records          — array of up to 10 string descriptors of
                                      the most material rows (e.g. customer
                                      names, product SKUs, invoice numbers)
       summary.warnings             — anything you couldn't resolve

5. Romanian numbers use ',' or '.' as decimal separator with '.' or space
   thousand grouping. Always emit clean decimal numbers.

6. Confidence rubric (emit a number 0..1):
   0.95 — clear balanță de verificare with all rows mapped
   0.85 — bilanț + P&L extracted to canonical RO codes
   0.70 — invoice register / sales analysis with structured rows captured
   0.60 — scanned/OCR'd image, some rows unclear
   0.40 — heavily inferred from narrative
   <0.40 — only headline figures

<schema>
{
  "company_name": string | null,
  "period_label": string,
  "period_end": string | null,         // ISO yyyy-mm-dd if discoverable
  "currency": string,                  // default "RON"
  "confidence": number,                // 0..1
  "detected_type": string,             // see rule 2
  "accounts": [{ "code": "5121", "name": "...", "amount": 1494836.00 }],
  "summary": {
    "row_count": number | null,
    "headline_total": number | null,
    "headline_label": string | null,
    "top_records": [string],
    "warnings": [string]
  },
  "skus": [                              // AT MOST 25 most-material rows (sample only)
    {
      "sku": "string (full descriptor incl. weight/format)",
      "brand": "string | null",
      "category": "string | null",
      "channel": "string | null",
      "volume": "number | null",
      "volume_unit": "tons | units | kg | l | null",
      "units_sold": "number | null",
      "revenue": "number | null (NIV in source currency)",
      "cogs": "number | null",
      "gross_margin": "number | null (revenue - cogs)",
      "gross_margin_pct": "number | null (gm / revenue, decimal)",
      "inventory_value": "number | null",
      "days_inventory_on_hand": "number | null"
    }
  ],
  "warnings": [string]
}
</schema>

Begin."""


def _classify_file(doc: Dict[str, Any]) -> str:
    """Returns 'pdf' | 'xlsx' | 'csv' | 'image_jpeg' | 'image_png' | 'text' | 'unknown'."""
    mime = (doc.get("mime_type") or "").lower()
    name = (doc.get("original_filename") or "").lower()
    if mime == "application/pdf" or name.endswith(".pdf"):
        return "pdf"
    if "spreadsheet" in mime or name.endswith(".xlsx") or name.endswith(".xls"):
        return "xlsx"
    if mime == "text/csv" or name.endswith(".csv"):
        return "csv"
    if mime == "image/jpeg" or name.endswith((".jpg", ".jpeg")):
        return "image_jpeg"
    if mime == "image/png" or name.endswith(".png"):
        return "image_png"
    if mime.startswith("text/") or name.endswith(".txt"):
        return "text"
    return "unknown"


def _detect_spreadsheet_format(spreadsheet_bytes: bytes) -> str:
    """Identify the actual spreadsheet container by magic bytes — file
    extensions can lie (an .xls file may really be xlsx, or vice versa).

    Returns one of: 'xlsx' (zip-based OOXML), 'xls' (legacy OLE2/CFB
    binary), 'unknown'.
    """
    if len(spreadsheet_bytes) < 8:
        return "unknown"
    head = spreadsheet_bytes[:8]
    # XLSX / XLSB / ODS / DOCX etc. are all ZIP archives. We only handle
    # XLSX here; XLSB would also start with PK but openpyxl can't read it.
    if head[:4] == b"PK\x03\x04":
        return "xlsx"
    # XLS (Excel 97-2003) and other CFB/OLE2 documents.
    if head == b"\xD0\xCF\x11\xE0\xA1\xB1\x1A\xE1":
        return "xls"
    return "unknown"


def _xls_to_text(xls_bytes: bytes, *, max_chars: int = 200_000) -> str:
    """Render a legacy .xls workbook (OLE2/CFB) as TSV. Uses pandas+xlrd
    since openpyxl only reads zip-based .xlsx files."""
    import io
    import pandas as pd  # type: ignore

    # engine='xlrd' is required for .xls; pandas would otherwise try
    # openpyxl and crash with BadZipFile.
    sheets = pd.read_excel(
        io.BytesIO(xls_bytes), sheet_name=None, header=None, engine="xlrd"
    )
    out: List[str] = []
    total_chars = 0
    for sheet_name, df in sheets.items():
        if total_chars > max_chars:
            out.append(f"\n[truncated — additional sheets omitted at {max_chars} chars]")
            break
        section = [f"=== Sheet: {sheet_name} ==="]
        for _, row in df.iterrows():
            cells = [
                "" if (pd.isna(v) or v is None) else str(v).replace("\t", " ")
                for v in row.values
            ]
            if not any(c.strip() for c in cells):
                continue
            line = "\t".join(cells)
            if total_chars + len(line) > max_chars:
                section.append("[truncated]")
                break
            section.append(line)
            total_chars += len(line) + 1
        out.append("\n".join(section))
    return "\n\n".join(out)


def _xlsx_to_text(spreadsheet_bytes: bytes, *, max_chars: int = 200_000) -> str:
    """Render a spreadsheet workbook as TSV text Claude can read.
    Each sheet becomes a labeled section: '=== Sheet: <name> ===' followed by
    rows joined with tabs. Truncated at max_chars to stay under context limits.

    Format-aware: detects xlsx vs legacy .xls by magic bytes and dispatches
    to the right reader. Trial balances from Romanian ERP exports often come
    as .xls (Excel 97-2003); openpyxl can't read those.

    Trial-balance fast-path: tries the deterministic structure detector
    first. When that succeeds, returns a canonical TSV (10 fixed columns,
    explicit labels) so Claude doesn't have to guess at paired-Debit/Credit
    columns in Crystal Reports / SAP exports. Falls through to the raw-
    sheet rendering when the file isn't a trial balance.
    """
    import io
    from openpyxl import load_workbook  # type: ignore

    fmt = _detect_spreadsheet_format(spreadsheet_bytes)
    if fmt == "unknown":
        raise RuntimeError(
            "Unrecognized spreadsheet format. Supported: .xlsx (Excel 2007+) "
            "and .xls (Excel 97-2003). If your file was downloaded from "
            "an ERP, try Save As → Excel Workbook (.xlsx) before uploading."
        )

    # Trial-balance fast-path. Best-effort: any failure here just falls
    # through to the legacy raw-render. Never raise from this branch.
    try:
        pack = _ro_pack()
        accounts = pack.parse_trial_balance(spreadsheet_bytes, "")
        if accounts:
            canonical = pack.accounts_to_canonical_tsv(accounts)
            preamble = (
                "Trial balance pre-parsed into canonical layout "
                f"({len(accounts)} accounts). Columns are explicit; no "
                "column-pairing inference needed.\n\n"
            )
            payload = preamble + canonical
            if len(payload) > max_chars:
                payload = payload[:max_chars] + "\n[truncated at canonical-tsv cap]"
            logger.info(
                "[xlsx_to_text] trial-balance fast-path: %d accounts, %d chars",
                len(accounts), len(payload),
            )
            return payload
    except Exception as e:  # noqa: BLE001
        logger.info(
            "[xlsx_to_text] trial-balance fast-path skipped (%s); using raw render",
            type(e).__name__,
        )

    if fmt == "xls":
        return _xls_to_text(spreadsheet_bytes, max_chars=max_chars)

    wb = load_workbook(io.BytesIO(spreadsheet_bytes), data_only=True, read_only=True)
    out: List[str] = []
    total_chars = 0
    for sheet_name in wb.sheetnames:
        if total_chars > max_chars:
            out.append(f"\n[truncated — additional sheets omitted at {max_chars} chars]")
            break
        ws = wb[sheet_name]
        section = [f"=== Sheet: {sheet_name} ==="]
        for row in ws.iter_rows(values_only=True):
            cells = ["" if v is None else str(v).replace("\t", " ") for v in row]
            if not any(c.strip() for c in cells):
                continue
            line = "\t".join(cells)
            if total_chars + len(line) > max_chars:
                section.append("[truncated]")
                break
            section.append(line)
            total_chars += len(line) + 1
        out.append("\n".join(section))
    return "\n\n".join(out)


def _stamp_llm_extraction(out: Dict[str, Any]) -> Dict[str, Any]:
    """PROVENANCE STAMP for LLM-extracted `parsed` payloads (integrity fix,
    2026-08-21). The scanned-PDF Claude fallback returned NO extraction
    stamp, so build_canonical_bs_v2 defaulted to method="deterministic"
    and the envelope could claim BALANCED — violating the CANONICAL_BS_V2
    llm cap ("llm => never BALANCED") and leaving the period
    auto-reconcile-eligible (verifier finding, previously frozen LOUDLY by
    the llm_fallback_scanned_pdf corpus golden; red test:
    tests/engine/test_llm_stamp.py). Shared with scripts/corpus_replay.py
    so the replay exercises THIS implementation, never a mirror. Never
    overwrites a stamp the extractor already set."""
    if not (out.get("extraction") or {}).get("method"):
        out["extraction"] = {
            **(out.get("extraction") or {}),
            "method": "llm",
            "source_format": "llm_freeform",
        }
    return out


def _deterministic_tb_parsed(
    doc: Dict[str, Any],
    tb_rows: Any,
    shaped: Any,
    statutory_anchor: Optional[float],
    source_quality: Dict[str, Any],
) -> Dict[str, Any]:
    """Build the `parsed` payload for the deterministic TB fast-paths
    (PDF / XLSX / CSV). One builder for all three branches so the
    canonical_bs v2 plumbing (contract: docs/CANONICAL_BS_V2_CONTRACT.md)
    can't drift between them.

    Beyond the legacy keys, carries the parse-result metadata stage_map
    forwards into `assemble_statements`' canonical_bs kwargs:
      · source_anchor / extraction — verbatim from the parser's
        TrialBalanceParseResult (external conservation + provenance).
      · parser_unmapped / parser_excluded — the AssembleShapeResult
        telemetry (accounts the deterministic path previously dropped
        with zero trace — audit gaps 14/17).
      · source_account_census — for invariants.source_conservation
        (see RomaniaPack.deterministic_source_census for the counting
        constraint).
    `getattr` fallbacks keep the builder harmless if a caller ever hands
    plain lists (legacy shape) instead of the metadata-carrying results.
    """
    if os.environ.get("SHADOW_CLASSIFY") == "1":
        # SHADOW-CLASSIFY probe (zero-behavior-change phase): compare the
        # legacy classification with the jurisdiction-pack classification
        # over this same parse and LOG the outcome. Opt-in via
        # SHADOW_CLASSIFY=1, default OFF; logs only — never mutates
        # inputs, never raises, never touches the returned payload.
        try:
            from engine.passes.shadow import log_shadow_for_tb
            log_shadow_for_tb(tb_rows, doc_id=str(doc.get("id") or ""))
        except Exception:  # noqa: BLE001 — the shadow must never break prod
            logger.exception("[shadow_classify] probe failed (ignored)")
    return {
        "company_name": (doc.get("original_filename") or "Imported entity").rsplit(".", 1)[0],
        "period_label": "Imported period",
        "period_end": _detect_period_end_from_filename(doc.get("original_filename")),
        "currency": "RON",
        "confidence": 0.95,
        "detected_type": "trial_balance",
        "accounts": list(shaped),
        "warnings": [],
        "source_data_quality": source_quality,
        "statutory_net_profit_anchor": statutory_anchor,
        "source_anchor": getattr(tb_rows, "source_anchor", None),
        "extraction": getattr(tb_rows, "extraction", None),
        "parser_unmapped": list(getattr(shaped, "unmapped", None) or []),
        "parser_excluded": list(getattr(shaped, "excluded", None) or []),
        "source_account_census": _ro_pack().deterministic_source_census(shaped),
        # Net 711 / net 72x evidence (owner ruling 2026-09-26), measured
        # HERE because this is the last seam that holds the parsed rows:
        # stage_map decides the one EBITDA from it and stage_persist stores
        # it on the envelope for every later rebuild.
        "stock_variation_evidence": _ro_pack().measure_stock_variation(tb_rows),
    }


def _enforce_nonro_plan_gate(doc: Dict[str, Any]) -> None:
    """2026-08 tiers — plan gate for NON-RO documents, consulted at the
    exact seam where the jurisdiction resolver routes a document into
    the AI lane (jurisdiction != RO).

    · USAGE_LIMITS_ENABLED off (prod today) → strictly inert: returns
      before any plan/state read.
    · Plan without non-RO entitlement (trial/intro/solo/pro) → raises
      NonRoNotIncludedError whose message is the TYPED refusal JSON
      ({"error": "non_ro_not_included", "upgrade_to": "multi", ...}).
      The generic failure handler persists it into `documents.error`,
      the generic release path frees the doc-slot reservation, and the
      FE matches `non_ro_not_included` to render an upgrade prompt
      instead of a failure card.
    · multi → reserves the non-RO meter and stamps the documents row
      (`nonro_doc`, `nonro_metered_extra`) so `_commit_pipeline_quota`
      can commit/release the meter from the daemon thread.

    ONLY THE FIRST, METERED RUN RESERVES (2026-09-21, verifier P-E). The
    non-RO meter is reserved — and so committed and billed — only when THIS
    run holds a document-slot reservation in the ledger (a first analysis
    through /run, a recovery, the firm landing), and under that verified
    reserver. A run that holds none — /retry, the ai-lane force-reextract,
    a period-move re-run — re-analyses a document already counted: the plan
    still gates it (the typed refusal), but nothing is reserved or counted.
    It used to reserve and register on every run: a retry of an analysed
    non-RO document on Multi at the included cap moved nonro uploads 8→9 and
    metered `extra_nonro` again.
    """
    from . import _usage_gate as _ug
    if not _ug.enforcement_enabled():
        return
    holder = _doc_slot_holder(str(doc.get("id") or ""))
    if holder is None:
        user_id = doc.get("uploaded_by")
        if not user_id:
            return
        refusal = _ug.nonro_entitlement_refusal(str(user_id))
        if refusal is None:
            return
        payload = dict(refusal.refusal or {"error": "non_ro_not_included"})
        payload["plan_key"] = refusal.plan_key
        payload["message"] = refusal.message
        raise _ug.NonRoNotIncludedError(json.dumps(payload, ensure_ascii=False))
    user_id = holder
    decision = _ug.reserve_nonro_document(str(user_id))
    if decision.kind in ("allowed", "disabled"):
        if decision.kind == "allowed":
            # Settled with THIS run by `_commit_pipeline_quota` (the ledger),
            # never from the row stamp a later re-run would still carry.
            _register_nonro_reservation(str(doc.get("id")), user_id=str(user_id),
                                        was_extra=bool(decision.was_extra))
            try:
                with _supabase.admin() as ac:
                    ac.update(
                        "documents",
                        {"nonro_doc": True,
                         "nonro_metered_extra": bool(decision.was_extra)},
                        filters={"id": f"eq.{doc.get('id')}"},
                    )
            except Exception:  # noqa: BLE001 — stamp is best-effort
                logger.exception(
                    "[pipeline] non-RO stamp failed for doc %s (meter "
                    "commit will be skipped)", doc.get("id"),
                )
        return
    # refused (typed upgrade prompt) or blocked (monthly non-RO cap).
    payload = dict(decision.refusal or {"error": "nonro_quota_exhausted"})
    payload["plan_key"] = decision.plan_key
    payload["message"] = decision.message
    raise _ug.NonRoNotIncludedError(json.dumps(payload, ensure_ascii=False))


def _maybe_route_ai_lane(
    doc: Dict[str, Any], file_bytes: bytes, kind: str,
) -> Optional[Dict[str, Any]]:
    """Jurisdiction gate for the AI extraction lane — runs the
    deterministic resolver BEFORE lane selection.

    RO (or any resolver failure) → returns None and the existing RO code
    path runs EXACTLY as before — deterministic fast-paths, statutory
    detection and the RO freeform LLM fallback are all untouched.
    HU/OTHER → the ai_lane pipeline (format_detect → extract → classify
    → self-check) replaces the freeform LLM fallback for those
    jurisdictions only. AiLaneError propagates → documents.status
    'failed' with the clear lane error (never partial numbers).
    """
    try:
        resolution = _ai_lane.resolve_jurisdiction(doc, file_bytes)
        jurisdiction = str(resolution.get("jurisdiction") or "RO")
    except Exception:  # noqa: BLE001 — the RO lane must never be blocked
        logger.exception(
            "[stage_extract] jurisdiction resolver failed — defaulting to RO path"
        )
        return None
    if jurisdiction == "RO":
        return None
    # 2026-08 tiers — non-RO documents are a plan entitlement (multi
    # only). Inert when USAGE_LIMITS_ENABLED is off; raises the typed
    # refusal (→ documents.error) when the plan doesn't include non-RO.
    _enforce_nonro_plan_gate(doc)
    logger.info(
        "[stage_extract] AI lane engaged: jurisdiction=%s source=%s "
        "confidence=%s kind=%s doc=%s",
        jurisdiction, resolution.get("source"), resolution.get("confidence"),
        kind, doc.get("id"),
    )
    return _ai_lane.run_ai_lane(
        doc=doc,
        file_bytes=file_bytes,
        kind=kind,
        resolution=resolution,
        admin_factory=_supabase.admin,
    )


def _resolve_consensus_jurisdiction(doc: Dict[str, Any], file_bytes: bytes) -> str:
    """Jurisdiction for the consensus lanes — the SAME deterministic
    resolver the AI lane uses (never raises; empty string on failure so
    the lane degrades to a no-op via the missing-pack path)."""
    try:
        resolution = _ai_lane.resolve_jurisdiction(doc, file_bytes)
        return str(resolution.get("jurisdiction") or "")
    except Exception:  # noqa: BLE001
        return ""


def _maybe_dual_map_lane(
    doc: Dict[str, Any], file_bytes: bytes, kind: str,
) -> Optional[Dict[str, Any]]:
    """C2 — DUAL-MAP STRUCTURAL READER hook (env gate
    AI_STRUCTURAL_READER=1, default OFF). Runs in the deterministic
    fast-path's PARSE-FAILURE branch, BEFORE the freeform-LLM fallback:
    two independent AI structural interpretations + two MECHANICAL
    map-guided reads + atom-level consensus. Returns a
    `_deterministic_tb_parsed`-compatible payload with
    extraction.method == "mechanical_mapped" (consensus block riding
    extraction, popped to canonical_bs.consensus by the builder), or
    None → the existing freeform fallback runs exactly as before.
    Never raises."""
    if os.environ.get("AI_STRUCTURAL_READER") != "1":
        return None
    try:
        from engine.consensus import lane as _consensus_lane

        jurisdiction = _resolve_consensus_jurisdiction(doc, file_bytes)
        payload = _consensus_lane.run_dual_map_lane(
            file_bytes,
            doc.get("original_filename") or "",
            jurisdiction,
        )
        if payload is not None:
            logger.info(
                "[stage_extract] C2 dual-map lane produced a mechanical_mapped "
                "payload for doc %s (jurisdiction=%s)",
                doc.get("id"), jurisdiction,
            )
        return payload
    except Exception:  # noqa: BLE001 — the lane must never block extraction
        logger.exception("[stage_extract] C2 dual-map lane failed (ignored)")
        return None


def _maybe_c1_consensus(
    doc: Dict[str, Any], file_bytes: bytes, kind: str, tb_rows: Any,
) -> Optional[Dict[str, Any]]:
    """C1 — classic-vs-mapped consensus probe on a successfully parsed
    deterministic document. Two gates (both default OFF; mirrors the
    SHADOW_CLASSIFY probe discipline — never mutates, never raises):

      CONSENSUS_SHADOW=1   run + LOG only; always returns None;
      CONSENSUS_ENABLED=1  run + return the block — stage_extract stashes
                           it on the parsed payload and stage_persist
                           attaches it ADDITIVELY to canonical_bs
                           (served values stay classic — E4).
    """
    shadow = os.environ.get("CONSENSUS_SHADOW") == "1"
    enabled = os.environ.get("CONSENSUS_ENABLED") == "1"
    if not (shadow or enabled):
        return None
    try:
        from engine.consensus import lane as _consensus_lane

        jurisdiction = _resolve_consensus_jurisdiction(doc, file_bytes)
        block = _consensus_lane.run_c1_consensus(
            file_bytes,
            doc.get("original_filename") or "",
            jurisdiction,
            tb_rows,
        )
        if block is None:
            return None
        logger.info(
            "[consensus_c1] doc=%s consensus_pct=%s atoms=%d disagreements=%d "
            "totals=%s eligible=%s mode=%s",
            doc.get("id"), block.get("consensus_pct"),
            int(block.get("atoms_compared") or 0),
            len(block.get("disagreements") or []),
            block.get("totals_match"), block.get("eligible_balanced"),
            "persist" if enabled else "shadow",
        )
        return block if enabled else None
    except Exception:  # noqa: BLE001 — the probe must never break prod
        logger.exception("[consensus_c1] probe failed (ignored)")
        return None


def stage_extract(doc: Dict[str, Any]) -> Dict[str, Any]:
    """Format-aware extraction. Sends the document to Claude Opus 4.7 in the
    most appropriate content-block shape for its type, then validates the
    JSON response and returns it.

    Supported inputs:
      - PDF      → document content block (handled by the legacy parser)
      - XLSX     → openpyxl-rendered TSV text content block
      - CSV      → raw text content block
      - JPG/PNG  → image content block
      - Plain text → text content block
    Anything else falls back to text after best-effort UTF-8 decoding.
    """
    storage_path: str = doc["storage_path"]
    kind = _classify_file(doc)

    # PDF still uses the existing parser (it has the canonical RO trial-balance
    # rubric in its system prompt — re-using avoids drift between two prompts).
    if kind == "pdf":
        # ── Public-records short-circuit ─────────────────────────────
        # Before handing off to the TB-rubric parser, check whether the
        # PDF is a listafirme.ro / termene.ro / firme.info / risco.ro
        # public-records summary. These PDFs carry a 6-aggregate × N-year
        # table that CANNOT be reconstructed as a trial balance — pushing
        # them through the TB pipeline produces nonsense (the Claude
        # extractor stuffs cifra de afaceri into every empty slot:
        # revenue = EBITDA = net income = 1.14B for PRO TV's case).
        # Detection runs locally on extracted text — zero Claude tokens
        # spent on the wrong format.
        try:
            with _supabase.admin() as admin_client:
                signed_for_text = admin_client.signed_url(
                    "documents", storage_path,
                    org_id=doc.get("org_id"), expires_in=300)
            with httpx.Client(timeout=30.0) as http:
                _r = http.get(signed_for_text)
                _r.raise_for_status()
                _pdf_bytes = _r.content
            try:
                from pypdf import PdfReader  # type: ignore
            except ImportError:
                from PyPDF2 import PdfReader  # type: ignore
            import io
            _txt = ""
            _reader = PdfReader(io.BytesIO(_pdf_bytes))
            for _p in _reader.pages:
                _txt += "\n" + (_p.extract_text() or "")
            from . import _public_records_parser as _prp
            # Sentinel captured INSIDE the try, acted on OUTSIDE the broad
            # except. When `looks_like_public_records` is True but the
            # year-row extractor returns no rows (or low confidence), we
            # MUST NOT fall through to the Claude TB extractor — it
            # hallucinates trial-balance numbers from this format. The
            # raise lives outside this try so it isn't swallowed by the
            # blanket "detection skipped (non-fatal)" handler below.
            _pr_unparseable: Optional[Dict[str, Any]] = None
            if _prp.looks_like_public_records(_txt):
                # Pass the raw PDF bytes so the parser can use the
                # geometry-aware extractor (pdfplumber word-coordinates +
                # 10 px gap threshold). That path handles both dense
                # (PRO TV, 20/20) and sparse (ELIT, 17/17) layouts
                # uniformly. Falls back to text-only parsing if pdfplumber
                # isn't available or geometry fails.
                _extract = _prp.parse_public_records_pdf(_txt, pdf_bytes=_pdf_bytes)
                if _extract.confidence >= 0.5 and _extract.years:
                    logger.info(
                        "[stage_extract] public_records_summary detected: %s "
                        "CUI=%s CAEN=%s years=%d confidence=%.2f",
                        _extract.company_name, _extract.cui, _extract.caen_code,
                        len(_extract.years), _extract.confidence,
                    )
                    # Return a marker payload — the orchestrator routes this
                    # to a dedicated persistence path that skips TB stages.
                    return {
                        "detected_type": "public_records_summary",
                        "company_name": _extract.company_name,
                        "cui": _extract.cui,
                        "reg_com": _extract.reg_com,
                        "caen_code": _extract.caen_code,
                        "caen_description": _extract.caen_description,
                        "source_site": _extract.source_site,
                        "confidence": _extract.confidence,
                        "years": [
                            {
                                "year": r.year,
                                "cifra_afaceri": r.cifra_afaceri,
                                "profit_net": r.profit_net,
                                "datorii_totale": r.datorii_totale,
                                "active_imobilizate": r.active_imobilizate,
                                "active_circulante": r.active_circulante,
                                "capitaluri_proprii": r.capitaluri_proprii,
                                "total_assets": r.total_assets,
                                "salariati": r.salariati,
                                "net_margin_pct": r.net_margin_pct,
                            }
                            for r in _extract.years
                        ],
                        "raw_text": _txt[:5000],  # for downstream detection caching
                        # Empty placeholders so the orchestrator's downstream
                        # detection/persist stages don't crash on missing keys.
                        "accounts": [],
                        "warnings": [],
                    }
                # Header matched but year-row extractor came up empty (or
                # confidence < 0.5). Capture context for the post-try raise.
                _pr_unparseable = {
                    "confidence": float(_extract.confidence),
                    "years_found": len(_extract.years),
                    "company_name": _extract.company_name,
                    "cui": _extract.cui,
                    "source_site": _extract.source_site,
                }
                logger.warning(
                    "[stage_extract] public-records detected but unparseable: "
                    "name=%r cui=%r confidence=%.2f years=%d — STOPPING "
                    "before Claude TB fall-through.",
                    _extract.company_name, _extract.cui,
                    _extract.confidence, len(_extract.years),
                )
        except Exception:  # noqa: BLE001
            logger.exception("[stage_extract] public-records detection skipped (non-fatal)")
            _pr_unparseable = None  # detection itself crashed — let the TB path try

        # OUTSIDE the broad-except: if header detection succeeded but no
        # rows came out, fail loudly. The outer pipeline handler in
        # `_run_pipeline_sync` will catch this and mark documents.status
        # = 'failed' with the message below as documents.error, which
        # surfaces to the FE upload panel. Document stays orphan-free —
        # no period created, no statement_line_items written, no garbage.
        if _pr_unparseable is not None:
            raise PublicRecordsUnparseableError(
                "This looks like a public-records financial summary "
                "(listafirme.ro / termene.ro / firme.info), but we couldn't "
                "read the financial-year rows from this specific PDF layout. "
                "Try: (1) re-download the PDF directly from the source site "
                "using the browser's 'Print → Save as PDF' option, or "
                "(2) upload a trial balance (balanță de verificare) Excel "
                f"instead. [cui={_pr_unparseable.get('cui')}, "
                f"confidence={_pr_unparseable['confidence']:.2f}, "
                f"years_found={_pr_unparseable['years_found']}]"
            )

        # ── AI-lane jurisdiction gate (PDF) ─────────────────────────
        # Resolver BEFORE lane selection. Uses the bytes already
        # downloaded for public-records detection; when that download
        # failed the gate is skipped and the RO fallback path below runs
        # unchanged. RO documents fall straight through (gate → None).
        try:
            _pdf_bytes_for_resolver: Optional[bytes] = _pdf_bytes
        except NameError:
            _pdf_bytes_for_resolver = None
        if _pdf_bytes_for_resolver is not None:
            _ai_parsed = _maybe_route_ai_lane(doc, _pdf_bytes_for_resolver, "pdf")
            if _ai_parsed is not None:
                return _ai_parsed

        # ── Text-line balanta reader (2026-09-21) ───────────────────
        # The position-based ingester below finds no rows on balante that
        # print space-thousands figures ("12 345.00"), so those went to
        # Claude — which fails outright without Anthropic credit and never
        # captures the account-121 anchor. `pdf_balanta_text` reads the
        # PDF's text lines — three layouts, chosen by header tokens and, for
        # the five-pair one, by structure (rows of ten figure columns name
        # it whatever the header's wording): the eight-figure "sume totale"
        # balanta, the WinMentor/SceptrumERP five-pair one (Sold initial
        # / Rulaj anterior / Rulaj curent / Total rulaj / Sold final) and
        # the four-pair one whose zeros print as blank cells (Sold initial
        # / Rulaje / Total / Solduri finale, 2026-09-26). The five-pair
        # reader places every line by the column its first word is printed
        # in, the four-pair reader every FIGURE by the column it is printed
        # in (pdfplumber word positions), never by its text. It
        # REFUSES unless every account line
        # carries its layout's full figure count, each class sums to the
        # document's own printed class total and debit == credit on every
        # column pair (the five-pair layout also checks both per-row
        # identities to the cent). On success
        # the balance is handed over as a SAGA 10-column workbook to the
        # SAME parse call an .xlsx upload takes, so anchor, mapping and
        # rebuild are the Excel path unchanged. An eight-figure refusal
        # keeps today's behaviour exactly.
        #
        # It runs BEFORE the positional fast-path: a read it accepts is
        # verified line by line against the document's own printed totals,
        # while the positional ingester keeps only undotted codes — on a
        # five-pair book with analytic codes ("1015.03") it returns the few
        # plain rows, and when account 121 is one of them its fast-path
        # accepts that partial balance on the anchor alone. Every
        # eight-figure or unrecognised PDF it refuses takes exactly the
        # path it took before.
        #
        # A document whose header names the FIVE-PAIR layout or the FOUR-
        # PAIR one (`names_strict_layout`) never leaves this block for the
        # positional fast-path or Claude: it is read by its strict reader,
        # or the refusal is final —
        # `BalantaPdfRefusedError`, raised below outside the broad except —
        # because the positional ingester keeps only undotted codes and
        # would serve a partial balance on the 121 anchor alone. That holds
        # whatever goes wrong: `read_balanta_text_verdict` never raises and
        # names the layout before anything can fail (with a second opinion
        # from the first page's PyMuPDF / pypdf text when the text lines
        # name none), and anything this block raises after that is a
        # refusal for such a document. The eight-figure layout keeps its
        # fall-back unchanged.
        _balanta_refusal: Optional[str] = None
        try:
            _pdf_for_text: Optional[bytes] = _pdf_bytes
        except NameError:
            _pdf_for_text = None
        if _pdf_for_text is not None:
            _verdict = _pdf_balanta_text.read_balanta_text_verdict(_pdf_for_text)  # never raises
            _five_pair_named = _pdf_balanta_text.names_five_pair(_verdict.layout)
            _strict_named = _pdf_balanta_text.names_strict_layout(_verdict.layout)
            if _strict_named and _verdict.workbook is None:
                _balanta_refusal = _verdict.refusal or "the reader refused it"
            try:
                if (_verdict.workbook is not None and _five_pair_named
                        and not _pdf_balanta_text.five_pair_servable_on(_ro_tb_parser.PARSER_VERSION)):
                    # Deploy-order guard (owner ruling 2026-09-21: this
                    # layout ships after parser v6). Never served on a
                    # parser that adds 709 reductions to revenue.
                    _balanta_refusal = (
                        "this engine's trial-balance parser (%s) adds a document's 709 "
                        "commercial reductions to revenue instead of deducting them; "
                        "five-pair balanta PDFs are read only on tb_parser_v6 or later"
                        % _ro_tb_parser.PARSER_VERSION
                    )
                elif _verdict.workbook is not None and _verdict.meta is not None:
                    _xlsx_bytes, _meta = _verdict.workbook, _verdict.meta
                    pack = _ro_pack()
                    tb_rows = pack.parse_trial_balance(_xlsx_bytes, "balanta.xlsx")
                    shaped = pack.accounts_to_assemble_shape(tb_rows) if tb_rows else []
                    statutory_anchor = pack.compute_statutory_net_profit_anchor(tb_rows) if tb_rows else None
                    if shaped and statutory_anchor is not None:
                        source_quality = pack.compute_source_imbalance(tb_rows)
                        logger.info(
                            "[stage_extract] text-line balanta PDF path: %s — %d accounts "
                            "(%s layout, %s number format) → %d mapped, ct 121 anchor = %s RON",
                            doc.get("original_filename") or "(no filename)",
                            _meta.get("accounts"), _meta.get("layout"), _meta.get("number_format"),
                            len(shaped), f"{statutory_anchor:,.2f}",
                        )
                        _parsed_tb = _deterministic_tb_parsed(
                            doc, tb_rows, shaped, statutory_anchor, source_quality,
                        )
                        # The period the document PRINTS ("Decembrie 2025")
                        # is the period — not the filename's guess, which
                        # `_deterministic_tb_parsed` seeds. Clamped like
                        # every other source; absent, the filename's stays.
                        _printed_end = _sane_period_end(_meta.get("period_end"))
                        if _printed_end:
                            logger.info(
                                "[stage_extract] text-line balanta PDF prints its period %r → "
                                "period_end %s (filename said %s)",
                                _meta.get("period_text"), _printed_end, _parsed_tb.get("period_end"),
                            )
                            _parsed_tb["period_end"] = _printed_end
                        return _parsed_tb
                    if _strict_named:
                        _balanta_refusal = (
                            "its verified read carries no account-121 closing balance "
                            "to anchor net profit" if statutory_anchor is None
                            else "its verified read maps no accounts"
                        )
                    logger.info(
                        "[stage_extract] text-line balanta PDF read but not used "
                        "(mapped=%d, anchor=%s) — %s",
                        len(shaped or []), statutory_anchor,
                        "refusing" if _strict_named else "falling back",
                    )
            except Exception as e:  # noqa: BLE001
                if _strict_named and _balanta_refusal is None:
                    _balanta_refusal = "its verified read could not be parsed (%s)" % type(e).__name__
                logger.info(
                    "[stage_extract] text-line balanta PDF path skipped (%s) — %s",
                    type(e).__name__,
                    "refusing" if _strict_named else "falling back to the positional ingester",
                )
        if _balanta_refusal is not None:
            logger.warning(
                "[stage_extract] balanta PDF (%s layout) refused: %s — %s — STOPPING before "
                "the positional fast-path and Claude",
                _verdict.layout, doc.get("original_filename") or "(no filename)", _balanta_refusal,
            )
            raise BalantaPdfRefusedError(balanta_refusal_message(_verdict.layout, _balanta_refusal))

        # ── F3.8c — Deterministic PDF trial-balance fast-path ───────
        # Romanian RAS PDF trial balances (WinMENTOR / SAGA / Ciel /
        # generic-RAS) parse cleanly via the PyMuPDF position-based
        # ingester landed in F3.8a. When the parser yields a non-
        # empty account list AND captures the account-121 statutory
        # anchor, skip Claude entirely and feed the structured output
        # straight into the mapper — same fast-path the XLSX kind
        # has used since the F3.1 country-pack refactor.
        #
        # If the PDF doesn't parse cleanly (rare layouts, scanned
        # pages, non-RAS PDFs), fall through to the existing
        # Claude-based extractor in financial_statements.parse_document.
        try:
            pack = _ro_pack()
            tb_rows = pack.parse_trial_balance(
                _pdf_bytes, doc.get("original_filename") or "",
            )
            if tb_rows:
                shaped = pack.accounts_to_assemble_shape(tb_rows)
                statutory_anchor = pack.compute_statutory_net_profit_anchor(tb_rows)
                # F3.9 / F3.11 — source-data quality telemetry. Computed
                # from raw tb_rows (sf_d/sf_c) before any engine routing
                # so the operator can see source-data fault vs engine
                # fault on the WARN badge. Threaded through parsed →
                # stage_map → assemble_statements → API response.
                source_quality = pack.compute_source_imbalance(tb_rows)
                if shaped and (statutory_anchor or len(shaped) >= 50):
                    logger.info(
                        "[stage_extract] deterministic PDF TB path: "
                        "%d raw rows → %d mapped accounts "
                        "(ct 121 anchor = %s RON, source imbalance %.4f%% %s)",
                        len(tb_rows), len(shaped),
                        f"{statutory_anchor:,.0f}" if statutory_anchor else "n/a",
                        float(source_quality.get("raw_imbalance_pct") or 0),
                        "WARN" if source_quality.get("warn") else "ok",
                    )
                    # canonical_bs v2 — shared payload builder carries the
                    # parse-result metadata (anchor/extraction/unmapped/
                    # excluded/census) through to stage_map.
                    return _deterministic_tb_parsed(
                        doc, tb_rows, shaped, statutory_anchor, source_quality,
                    )
        except Exception as e:  # noqa: BLE001
            logger.info(
                "[stage_extract] PDF TB fast-path skipped (%s) — "
                "falling back to Claude/statements parser",
                type(e).__name__,
            )

        with _supabase.admin() as admin_client:
            signed = admin_client.signed_url(
                "documents", storage_path,
                org_id=doc.get("org_id"), expires_in=300)
        from .financial_statements import (  # type: ignore
            ParseRequest,
            build_router as _build_fs_router,
        )
        fs_router = _build_fs_router()
        parse_handler = None
        for route in fs_router.routes:
            if getattr(route, "name", None) == "parse_document":
                parse_handler = route.endpoint  # type: ignore[attr-defined]
                break
        if parse_handler is None:
            raise RuntimeError("financial_statements router missing parse_document route")
        parsed = parse_handler(ParseRequest(
            pdf_url=signed,
            original_filename=doc.get("original_filename"),
        ))
        out = parsed.model_dump() if hasattr(parsed, "model_dump") else dict(parsed)
        return _stamp_llm_extraction(out)

    # Everything else: download bytes, build a Claude message, parse the JSON.
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise RuntimeError("ANTHROPIC_API_KEY not configured.")

    with _supabase.admin() as admin_client:
        signed = admin_client.signed_url(
            "documents", storage_path,
            org_id=doc.get("org_id"), expires_in=300)
    with httpx.Client(timeout=30.0) as http:
        r = http.get(signed)
        r.raise_for_status()
        file_bytes = r.content

    if len(file_bytes) > 25 * 1024 * 1024:
        raise RuntimeError(f"File too large ({len(file_bytes)/1_000_000:.1f} MB) — 25 MB ceiling.")

    # ── AI-lane jurisdiction gate (xlsx/csv/text/image) ──────────────
    # Resolver BEFORE lane selection: HU/OTHER documents route to the
    # ai_lane pipeline (replacing the freeform LLM fallback for those
    # jurisdictions only); RO documents return None here and every
    # branch below runs exactly as before.
    _ai_parsed = _maybe_route_ai_lane(doc, file_bytes, kind)
    if _ai_parsed is not None:
        return _ai_parsed

    # Fix 9 — dual-pipeline routing. BEFORE the trial-balance fast-path
    # runs, detect whether this xlsx/xls is a statutory ANAF filing
    # (Formular F30 P&L + F10 Bilanț) and, if so, parse it via the
    # statutory parser instead. The trial-balance parser CANNOT read a
    # statutory return — it only sees account 722 (capitalized own work)
    # and silently drops Cifra de afaceri (the actual revenue line),
    # which produced a 20× revenue understatement on the food-manufacturer
    # case. Detection is regex + structural; on ambiguity we fall through
    # to the TB path so EEI / Scandia regression stays at zero. See
    # `_document_type_detector.py` for the anchor list.
    # `_classify_file` collapses both .xlsx and legacy .xls under "xlsx";
    # the document detector itself does magic-byte format detection.
    if kind == "xlsx":
        try:
            from . import _document_type_detector as _dtd
            doc_type, dt_meta = _dtd.detect_document_type(
                file_bytes, doc.get("original_filename") or "",
            )
            logger.info(
                "[stage_extract] document type detected: %s (%s)",
                doc_type, dt_meta.get("reason"),
            )
            if doc_type == "statutory_f30_f10":
                from . import _statutory_parser as _sp
                extraction = _sp.parse_statutory_file(
                    file_bytes, doc.get("original_filename") or "",
                )
                if not extraction.pl_data:
                    # Detection said statutory, but the row map produced
                    # nothing — most likely a layout variant we don't
                    # support yet. Fall through to TB / Claude rather
                    # than crashing so the user still gets *something*.
                    logger.warning(
                        "[stage_extract] statutory detection fired but no rows "
                        "extracted — falling through to TB path. Sheets=%s",
                        extraction.warnings,
                    )
                else:
                    shaped = _sp.accounts_to_assemble_shape(extraction)
                    period_end = _sane_period_end(extraction.period_end) or _detect_period_end_from_filename(
                        doc.get("original_filename")
                    )
                    logger.info(
                        "[stage_extract] statutory F30/F10 path: %d P&L rows + %d BS rows "
                        "→ %d synth accounts (period_end=%s industry=%s)",
                        len(extraction.pl_data),
                        len(extraction.bs_data),
                        len(shaped),
                        period_end,
                        extraction.detected_industry,
                    )
                    return {
                        "company_name": (
                            extraction.company_name
                            or (doc.get("original_filename") or "Imported entity").rsplit(".", 1)[0]
                        ),
                        "period_label": (period_end or "Imported period"),
                        "period_end": period_end,
                        "currency": "RON",
                        "confidence": 0.88,  # high but below TB (less granular)
                        "detected_type": "statutory_f30_f10",
                        "accounts": shaped,
                        "warnings": extraction.warnings,
                        # canonical_bs v2 provenance — deterministic row-map
                        # parse, contract source_format for ANAF filings. No
                        # source_anchor: statutory returns carry no TB totals
                        # row (builder defaults to NO_ANCHOR).
                        "extraction": {
                            "method": "deterministic",
                            "source_format": "statutory_f30_f10",
                        },
                        # The filed return prints the stock variation NET
                        # (rows sold C / sold D) — the measurement itself.
                        "stock_variation_evidence": _sp.stock_variation_evidence(extraction),
                        "statutory": {
                            "pl_data": extraction.pl_data,
                            "bs_data": extraction.bs_data,
                            "period_prior": extraction.period_prior,
                            "industry_hint": extraction.detected_industry,
                            "pl_sheet": extraction.pl_sheet_name,
                            "bs_sheet": extraction.bs_sheet_name,
                            "detection": dt_meta,
                        },
                    }
        except Exception as e:  # noqa: BLE001
            # Detection / statutory parsing should NEVER block the TB
            # path. Log and fall through silently.
            logger.info(
                "[stage_extract] statutory branch skipped (%s: %s) — falling back to TB path",
                type(e).__name__, str(e)[:120],
            )

    # Fix 8 — deterministic trial-balance fast-path. When the file parses
    # cleanly as a Romanian trial balance, skip Claude entirely and feed
    # the structured 809-account output straight into the mapper. Closes
    # the class-65 / sub-class-64 extraction gap (Claude was silently
    # dropping minor accounts and inflating downstream EBITDA).
    if kind == "xlsx":
        try:
            pack = _ro_pack()
            tb_rows = pack.parse_trial_balance(
                file_bytes, doc.get("original_filename") or "",
            )
            if tb_rows:
                shaped = pack.accounts_to_assemble_shape(tb_rows)
                # Account 121 closing balance = the statutory net profit
                # anchor (the legally filed figure on Romanian books).
                # Threaded through parsed → stage_compute so the platform
                # cites the SAME number the user sees on their own account
                # 121 instead of a reconstructed approximation that's off
                # by 1-6% on real data.
                statutory_anchor = pack.compute_statutory_net_profit_anchor(tb_rows)
                # F3.9 / F3.11 — source-data quality telemetry. See PDF
                # fast-path above for the rationale.
                source_quality = pack.compute_source_imbalance(tb_rows)
                logger.info(
                    "[stage_extract] deterministic TB path: %d raw rows → %d mapped accounts "
                    "(ct 121 anchor = %s RON, source imbalance %.4f%% %s)",
                    len(tb_rows), len(shaped),
                    f"{statutory_anchor:,.0f}" if statutory_anchor else "n/a",
                    float(source_quality.get("raw_imbalance_pct") or 0),
                    "WARN" if source_quality.get("warn") else "ok",
                )
                # canonical_bs v2 — shared payload builder carries the
                # parse-result metadata (anchor/extraction/unmapped/
                # excluded/census) through to stage_map.
                parsed_payload = _deterministic_tb_parsed(
                    doc, tb_rows, shaped, statutory_anchor, source_quality,
                )
                # C1 consensus probe (env-gated OFF; shadow logs only,
                # enabled stashes the block for the persist-seam attach).
                _c1_block = _maybe_c1_consensus(doc, file_bytes, kind, tb_rows)
                if _c1_block is not None:
                    parsed_payload["consensus_c1"] = _c1_block
                return parsed_payload
        except Exception as e:  # noqa: BLE001
            logger.info(
                "[stage_extract] TB fast-path skipped (%s) — falling back to Claude",
                type(e).__name__,
            )
            # C2 — dual-map structural reader (env-gated OFF): a
            # mechanically-read, consensus-verified payload replaces the
            # freeform-LLM fallback when the lane succeeds; None falls
            # through to Claude exactly as before.
            _c2_parsed = _maybe_dual_map_lane(doc, file_bytes, kind)
            if _c2_parsed is not None:
                return _c2_parsed

    # canonical_bs v2 — deterministic CSV fast-path (audit item 1c: CSVs
    # previously ALWAYS went to the LLM as raw text, so the same SAGA
    # balance got a different fidelity class than its XLSX twin). The
    # parser's CSV entry point runs the same structure detection, locale
    # detection and anchor machinery as the XLSX path; the LLM remains
    # strictly the fallback for CSVs that don't parse as a trial balance.
    if kind == "csv":
        try:
            pack = _ro_pack()
            tb_rows = pack.parse_trial_balance_csv(
                file_bytes, doc.get("original_filename") or "",
            )
            if tb_rows:
                shaped = pack.accounts_to_assemble_shape(tb_rows)
                statutory_anchor = pack.compute_statutory_net_profit_anchor(tb_rows)
                source_quality = pack.compute_source_imbalance(tb_rows)
                logger.info(
                    "[stage_extract] deterministic CSV TB path: %d raw rows → %d mapped accounts "
                    "(ct 121 anchor = %s RON, source imbalance %.4f%% %s)",
                    len(tb_rows), len(shaped),
                    f"{statutory_anchor:,.0f}" if statutory_anchor else "n/a",
                    float(source_quality.get("raw_imbalance_pct") or 0),
                    "WARN" if source_quality.get("warn") else "ok",
                )
                parsed_payload = _deterministic_tb_parsed(
                    doc, tb_rows, shaped, statutory_anchor, source_quality,
                )
                # C1 consensus probe (env-gated OFF) — see the XLSX branch.
                _c1_block = _maybe_c1_consensus(doc, file_bytes, kind, tb_rows)
                if _c1_block is not None:
                    parsed_payload["consensus_c1"] = _c1_block
                return parsed_payload
        except Exception as e:  # noqa: BLE001
            logger.info(
                "[stage_extract] CSV TB fast-path skipped (%s) — falling back to Claude",
                type(e).__name__,
            )
            # C2 — dual-map structural reader (env-gated OFF) — see the
            # XLSX branch.
            _c2_parsed = _maybe_dual_map_lane(doc, file_bytes, kind)
            if _c2_parsed is not None:
                return _c2_parsed

    try:
        from anthropic import Anthropic  # type: ignore
    except ImportError:
        raise RuntimeError("anthropic SDK not installed.")
    # max_retries=5 (vs SDK default 2) + extended timeout — covers the
    # sustained-Opus-overload case (HTTP 529) without surfacing it to
    # the user. Exponential backoff ~1s → 2s → 4s → 8s → 16s.
    client = Anthropic(api_key=api_key, max_retries=5, timeout=180.0)

    import base64 as _b64
    user_content: List[Dict[str, Any]]
    user_text = (
        f"Extract this document into the JSON schema. "
        f"Filename: {doc.get('original_filename') or 'unknown'}. "
        "Pick the most appropriate detected_type. Return JSON only."
    )

    if kind in ("image_jpeg", "image_png"):
        media_type = "image/jpeg" if kind == "image_jpeg" else "image/png"
        b64 = _b64.standard_b64encode(file_bytes).decode("ascii")
        user_content = [
            {"type": "image", "source": {"type": "base64", "media_type": media_type, "data": b64}},
            {"type": "text", "text": user_text},
        ]
    else:
        # XLSX, CSV, plain text, unknown — coerce to text.
        if kind == "xlsx":
            text_payload = _xlsx_to_text(file_bytes)
            preamble = "Workbook rendered as TSV (sheets separated by '=== Sheet:' markers)."
        elif kind == "csv":
            text_payload = file_bytes.decode("utf-8", errors="replace")
            preamble = "CSV content."
        else:
            text_payload = file_bytes.decode("utf-8", errors="replace")
            preamble = "File content as text (best-effort decode)."

        # Cap the text payload so we don't blow the context window.
        if len(text_payload) > 250_000:
            text_payload = text_payload[:250_000] + "\n[truncated at 250k chars]"

        user_content = [
            {"type": "text", "text": f"{preamble}\n\n{text_payload}"},
            {"type": "text", "text": user_text},
        ]

    try:
        resp = client.messages.create(
            model=_extract_model(),
            # 2026-07-26 — was 8000, which truncated the JSON mid-string on
            # sales-analysis files (detected_type="sales_analysis" emits every
            # SKU row into `skus`), surfacing as "Claude returned invalid JSON:
            # Unterminated string". 16000 gives headroom for the illustrative
            # trading files. NOTE: a very large SKU list can still exceed this —
            # the durable fix is deterministic SKU extraction (see _sales_extract)
            # rather than emitting all rows through the model.
            max_tokens=16000,
            system=[
                {"type": "text", "text": _BROAD_SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}},
            ],
            messages=[{"role": "user", "content": user_content}],
            output_config={"effort": "high"},
        )
    except Exception as e:  # noqa: BLE001
        # After max_retries on the Anthropic client are exhausted, a 529
        # (overloaded) becomes user-visible. Re-raise with a clear message
        # so the upstream orchestrator can show actionable copy instead of
        # the raw SDK error.
        status = getattr(e, "status_code", None)
        err_str = str(e)
        if status == 529 or "overloaded_error" in err_str or "529" in err_str:
            raise RuntimeError(
                "Claude is temporarily overloaded after multiple retries. Try again in 1-2 minutes — your document is fine."
            )
        if status == 429 or "rate_limit" in err_str:
            raise RuntimeError("Rate limit reached on the Claude API. Try again in a minute.")
        raise RuntimeError(f"Claude extraction failed: {e}")

    text = "".join(getattr(b, "text", "") for b in resp.content if getattr(b, "type", None) == "text").strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.startswith("json"):
            text = text[4:]
        text = text.strip()
    try:
        data = json.loads(text)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"Claude returned invalid JSON. First 200 chars: {text[:200]!r}. Error: {e}")

    # Repair / defaults
    data.setdefault("company_name", None)
    data.setdefault("period_label", "Imported period")
    data.setdefault("period_end", None)
    data.setdefault("currency", "RON")
    data.setdefault("confidence", 0.5)
    data.setdefault("detected_type", "unknown")
    data.setdefault("accounts", [])
    data.setdefault("warnings", [])
    data.setdefault("summary", {})
    data.setdefault("skus", [])

    # Coerce account amounts
    cleaned: List[Dict[str, Any]] = []
    for raw in data.get("accounts", []):
        try:
            amt = float(raw.get("amount", 0) or 0)
            cleaned.append({
                "code": str(raw.get("code", "")).strip(),
                "name": str(raw.get("name", "")).strip(),
                "amount": amt,
            })
        except (TypeError, ValueError):
            data["warnings"].append(f"Dropped malformed account row: {raw}")
    data["accounts"] = cleaned

    # F3.16-3b.2 Path X (Path B variant) — synthesize the statutory
    # 121 anchor from Claude's cleaned accounts so the kwarg in
    # `stage_map`'s call to `assemble_statements` can fire the
    # net-income override even when the TB fast-path was bypassed.
    # Claude usually emits account 121 as a regular row; when it
    # does, sum every 121-prefixed code's amount. When Claude omits
    # 121 entirely (some periods), this stays None and the in-loop
    # capture inside `assemble_statements` is the only safety net
    # (and since Claude doesn't set bucket metadata, the in-loop
    # capture also yields None — fallback to reconstruction). This is
    # best-effort: it makes Claude path PARITY with TB fast-path when
    # Claude surfaces 121; otherwise the period gets reconstruction-
    # only behavior, which is what it had before this fix anyway.
    _claude_121_amounts = [
        float(a.get("amount") or 0)
        for a in cleaned
        if str(a.get("code") or "").strip().startswith("121")
    ]
    if _claude_121_amounts:
        _synth_anchor = sum(_claude_121_amounts)
        logger.info(
            "[stage_extract] Claude path: synthesized statutory_net_profit_anchor"
            "=%s RON from %d 121-prefixed rows (Path X / Path B)",
            f"{_synth_anchor:,.0f}", len(_claude_121_amounts),
        )
        data["statutory_net_profit_anchor"] = _synth_anchor
    else:
        data.setdefault("statutory_net_profit_anchor", None)

    # canonical_bs v2 provenance — this is the LLM extraction path. The
    # builder caps canonical_bs.status at MINOR_DRIFT off method=="llm"
    # (an LLM extraction can never claim BALANCED per the contract), and
    # the NO_ANCHOR default applies: there is no file totals row to
    # reconcile against on this path.
    data["extraction"] = {"method": "llm", "source_format": "llm_freeform"}
    # No trial-balance columns reach this path (one amount per account), so
    # net 711 cannot be measured: it refuses — with this reason — on a book
    # that posts to 711, and the one EBITDA with it.
    from engine.country_packs.ro_romania import stock_variation as _stock_variation
    data["stock_variation_evidence"] = _stock_variation.absent_evidence(
        _stock_variation.REASON_NO_TB_COLUMNS
    )

    return data


def stage_map(doc: Dict[str, Any], parsed: Dict[str, Any], industry: Optional[str]) -> Dict[str, Any]:
    """Roll accounts into BS/PL buckets via the country pack's mapper.
    Pre-F3.1c this called `_ro_coa.assemble_statements` directly; now
    dispatched through the Romania pack so the same call site will
    transparently work for other country packs once they're added.

    F3.11 — `source_data_quality` (when computed upstream in
    stage_extract and stored in `parsed`) is forwarded through so the
    engine envelope surfaces source-imbalance telemetry to the FE.
    Default None preserves byte-identical for paths that don't set it
    (Claude-extracted fallback, statutory F30/F10).
    """
    # F3.16-3b.2 Path X — thread the 121-anchor through. `stage_extract`
    # captures `statutory_net_profit_anchor` from raw TB rows BEFORE any
    # preprocessing that might drop the 121 line item (Path A: TB fast-
    # path via `compute_statutory_net_profit_anchor`; Path B: Claude
    # path via the post-parse 121-prefix sum). When neither path
    # surfaced an anchor, the kwarg is None and `assemble_statements`
    # falls back to its in-loop capture, preserving byte-identical
    # behavior on the fixture path and on any caller that doesn't ship
    # the anchor in `parsed`. See chart_of_accounts.py:1796-1804 for
    # the F3.16 forbidden-pattern marker explaining why this kwarg
    # exists (and why a comment-without-test was the original bug).
    # canonical_bs v2 — forward the extraction provenance + external
    # anchor + census + parser unmapped captured in stage_extract, so the
    # write-time envelope's canonical_bs carries them per the contract.
    # All keys are absent on paths that don't set them (legacy callers,
    # statutory partially) — .get() → None keeps the builder's defensive
    # defaults, preserving prior behavior exactly.
    pack = _ro_pack()
    assembled = pack.assemble_statements(
        parsed.get("accounts") or [],
        company_name=parsed.get("company_name") or "Imported entity",
        currency=parsed.get("currency") or "RON",
        period_label=parsed.get("period_label") or "Imported period",
        industry=industry,
        source_data_quality=parsed.get("source_data_quality"),
        account_121_anchor_override=parsed.get("statutory_net_profit_anchor"),
        source_anchor=parsed.get("source_anchor"),
        extraction_meta=parsed.get("extraction"),
        source_account_census=parsed.get("source_account_census"),
        extra_unmapped=parsed.get("parser_unmapped"),
        # Net 711 / net 72x (owner ruling 2026-09-26): measured off the
        # rows in stage_extract; absent on a path that holds no rows (the
        # LLM extraction) → 711 refuses on a book that posts to it.
        stock_variation_evidence=parsed.get("stock_variation_evidence"),
    )
    # Parser-level exclusions (class 8 incl. 891/892, 581 transit) are
    # dropped BEFORE assembly, so the assembler can't record them itself
    # — completed into canonical_bs.excluded at this seam (same helper
    # the offline determinism/reprocessing scripts run).
    pack.merge_parser_exclusions(assembled, parsed.get("parser_excluded"))
    # Anchor provenance on the WRITE path too. This call site already
    # threads the anchor (the line above), so the labels here are almost
    # always `anchored` — but they must be emitted on both paths, or a
    # reader would have to know which seam produced a payload before it
    # could trust `net_income_statutory`. See `_annotate_net_income_anchor`.
    #
    # The SAME call the offline seam makes
    # (`RomaniaPack.assemble_parsed_tb`), through the same helper: the
    # `source` label and the `applied` derivation live inside it, so the
    # two seams cannot label the same book differently. Gated by
    # tests/engine/test_offline_served_parity.py.
    _net_income_anchor.annotate_from_parsed_tb_rows(
        assembled, parsed.get("statutory_net_profit_anchor"),
    )

    # THE PRODUCT SEAM — structural impossibilities refuse here.
    #
    # This is where a document becomes something a person reads, so this
    # is where a P&L that cannot be a true reading of its own trial
    # balance must stop. Every real Romanian book in this repo is
    # POST-CLOSING (class 6/7 closed to 121, both cumulative sides equal,
    # closing zero), so a reader that nets the two sides or takes the
    # closing column serves revenue = 0.00 against a billion of turnover
    # — and nothing objected until now.
    #
    # Deliberately NOT raised inside `pack.assemble_parsed_tb`: that is a
    # library entry point which test_metamorphic, the DST harness and the
    # mutation kernel feed perturbed books on purpose, and every one of
    # them is entitled to an answer to judge. The findings are attached
    # there; the refusal is here.
    _rows = parsed.get("tb_rows") or parsed.get("rows") or []
    if _rows:
        from engine.country_packs.ro_romania import pl_sanity as _pl_sanity

        _pl_sanity.assert_servable(
            (assembled.get("statements") or {}).get("assembled_pl") or {}, _rows
        )
    return assembled


def resolve_period_end_for_persist(
    doc: Dict[str, Any], parsed: Dict[str, Any]
) -> Tuple[str, Dict[str, Any]]:
    """Resolve the period this document is filed under, and record WHY.

    PURE — no DB, no clock beyond the documented last-resort fallback.
    Split out of `stage_persist` so the decision is testable on its own
    and so the ranked order lives in one readable place.

    RANKED ORDER (unchanged from the pre-2026-08-30 behaviour):

      1. `documents.period_end_hint` — the CONFIRMATION channel. It means
         "a human confirmed that THIS document belongs to THIS month",
         and it deliberately overrides the engine's own detection.
         That meaning is load-bearing: the 2026-08-30 audit found the
         frontend filling it with the DROP TARGET's date, so the engine
         discarded correct detections on a value no human had ever read
         off the document. The channel is not the bug — filling it with
         UI state was. Rank 1 stays.
      2. in_document     |
      3. closing_balance | `_period_detect.detect_period` — hint-free,
      4. filename        | the SAME service the upload UI calls, so
                         | engine and UI can never disagree.
      5. today, logged as a fallback and labelled `fallback_today` in
         the record. Never labelled a detection.

    Returns `(period_end, detection_record)`. The record is stamped onto
    the persisted envelope so the mismatch chip (Parts D/E) reads GROUND
    TRUTH — what actually won at write time — instead of recomputing a
    verdict that could drift from the row it describes.

    Behaviour note (2026-08-30): the only resolution that changes is
    filenames the engine helper alone could not parse and which
    therefore landed on TODAY — `balanta_2025.xlsx`, `dec2025.xls`,
    `FY2025.xlsx`, `tb_2025-12.xlsx`. Those now resolve to their real
    month. Every filename the helper already resolved resolves
    identically; no existing row is rewritten.
    """
    # Sane-clamped like every other source: the FE's client-side
    # detection once seeded the confirm dialog with a garbage year
    # (2115-03-31, from stray numbers in a header row) and this path
    # trusted it verbatim — the one unclamped door left after the
    # 2050-12-31 fix. Out-of-range hints fall through to the document's
    # own evidence instead of minting a corrupt period.
    hint = doc.get("period_end_hint")
    period_end_hint: Optional[str] = None
    if hint:
        try:
            period_end_hint = _sane_period_end(
                date.fromisoformat(str(hint)[:10]).isoformat()
            )
        except (TypeError, ValueError):
            period_end_hint = None

    detected = _period_detect.detect_period(
        extracted=parsed if isinstance(parsed, dict) else None,
        filename=doc.get("original_filename"),
    )

    if period_end_hint:
        period_end = period_end_hint
        signal_used = "user_confirmed"
        confidence = 1.0
        evidence = "user-confirmed period end: %s" % period_end_hint
    elif detected["proposed_period_end"]:
        period_end = detected["proposed_period_end"]
        signal_used = detected["signal_used"]
        confidence = detected["confidence"]
        evidence = detected["evidence_snippet"]
    else:
        # ABSENT. Nothing in the document, nothing in the filename, no
        # human confirmation. The period still has to be filed
        # somewhere, so today stands in — but it is recorded as a
        # fallback, never as a detection, so the UI can ask.
        period_end = date.today().isoformat()
        signal_used = "fallback_today"
        confidence = 0.0
        evidence = None
        logger.warning(
            "[period_end] no signal for document %s (%r) — filing under "
            "today (%s) and flagging it as unconfirmed",
            doc.get("id"),
            doc.get("original_filename"),
            period_end,
        )

    # ABSENT != ZERO: a document with no evidence of its own cannot
    # DISAGREE with the human's choice. Only a real, resolved detection
    # that points somewhere else is a mismatch.
    proposed = detected["proposed_period_end"]
    record = {
        "resolved_period_end": period_end,
        "signal_used": signal_used,
        "confidence": confidence,
        "evidence_snippet": evidence,
        "hint": period_end_hint,
        "detected": detected,
        "mismatch": bool(proposed) and proposed != period_end,
    }
    return period_end, record


# ── G4: no period without an analysed source document ─────────────────
#
# `stage_persist` runs BEFORE compute / validate / narrate, so a period row
# is inserted while its document is still mid-analysis. When a later stage
# raised, the document was marked `failed` and the freshly inserted period
# stayed behind — a month in the workspace whose only document failed, with
# half an analysis under it. The orchestrator now removes a period THIS run
# inserted when the run fails. Only the INSERT branch records: a re-run of a
# document that already had its period, and a same-month takeover of an
# existing period, leave the row where it was (the row predates the run).
_PERIODS_MINTED_BY_RUN: Dict[str, str] = {}
_PERIODS_MINTED_LOCK = threading.Lock()


def _record_period_minted(document_id: Any, period_id: Any) -> None:
    if not document_id or not period_id:
        return
    with _PERIODS_MINTED_LOCK:
        _PERIODS_MINTED_BY_RUN[str(document_id)] = str(period_id)


def _pop_period_minted(document_id: Any) -> Optional[str]:
    with _PERIODS_MINTED_LOCK:
        return _PERIODS_MINTED_BY_RUN.pop(str(document_id or ""), None)


def _rollback_period_of_failed_run(document_id: str, org_id: Optional[str]) -> Optional[str]:
    """Remove the period THIS failed run inserted, when nothing else holds
    it. Returns the removed period id, or None.

    Every filter names the tenant and the document — under the service role
    the filter IS the access control — and a period another document now
    points at is left alone. Derivatives go with the row (their foreign keys
    cascade); the document's own `period_id` is cleared first so a failed
    document is never pinned to a month that no longer exists. Never raises:
    the failure being handled is the one the user sees."""
    period_id = _pop_period_minted(document_id)
    if not period_id or not org_id:
        return None
    try:
        with _supabase.admin() as ac:
            rows = ac.select(
                "financial_periods",
                filters={"id": f"eq.{period_id}", "org_id": f"eq.{org_id}",
                         "source_document_id": f"eq.{document_id}"},
                columns="id",
                limit=1,
            )
            if not rows:
                return None
            others = ac.select(
                "documents",
                filters={"period_id": f"eq.{period_id}", "org_id": f"eq.{org_id}",
                         "id": f"neq.{document_id}"},
                columns="id",
                limit=1,
            )
            if others:
                return None
            ac.update("documents", {"period_id": None},
                      filters={"id": f"eq.{document_id}", "org_id": f"eq.{org_id}"})
            ac.delete("financial_periods",
                      filters={"id": f"eq.{period_id}", "org_id": f"eq.{org_id}",
                               "source_document_id": f"eq.{document_id}"})
        logger.info("[pipeline] %s failed — removed the period %s it had created",
                    document_id, period_id)
        return period_id
    except Exception:  # noqa: BLE001 — never mask the failure being handled
        logger.exception("[pipeline] could not remove the period %s of failed document %s",
                         period_id, document_id)
        return None


# ── G4: a same-month re-upload replaces the month only once its run succeeds ──
#
# THE DEFECT THIS ENDS (production, 2026-09, the owner's December 2025): a
# second file for a month that already had an analysed one made
# `stage_persist` re-point the month's period at the NEW document and wipe
# the first document's line items and envelope BEFORE the new run had
# succeeded. An ordinary failure two stages later left a period whose only
# source had failed — the year vanished from the company page, and the
# figures that had been served a minute earlier were gone.
#
# THE ORDER NOW. The new run persists everything under a period row of its
# OWN (the staged row: the same tuple the unique constraint keys, so it is
# the run's row and nobody else's), and the served row is not touched.
# Only the run's terminal success replaces the month: the run's rows move
# onto the served row, the served row takes the new envelope and names the
# new document, the staged row goes, and the superseded document is
# archived (restorable, never deleted). A run that fails takes its staged
# row with it (`_rollback_period_of_failed_run` — it was minted by the
# run) and the month keeps serving exactly what it served before.
#
# THE OTHER COMPANY. The upload routes by CUI now (G1), and the card lets a
# member file anything into a company of theirs. The persist layer is the
# belt and braces: a file whose own header names a CUI other than the
# company's — its CUI on file, or for a company created before CUIs were
# recorded, the CUI the month's own file states — never replaces that
# company's month: the run fails with a plain sentence, and nothing of the
# month changes.

#: The rows a run persists under a period id, in the order they are moved.
#: Explicit, like `_period_move._DERIVED_TABLES`: a table missing here
#: would leave the run's rows under the staged row, and the gate's
#: "nothing left under a period that no longer exists" check reds on it.
TAKEOVER_TABLES = ("statement_line_items", "calculated_metrics", "alerts",
                   "recommendations", "briefings", "valuations")

#: The columns that ARE the served row's identity — never copied over it.
_PERIOD_IDENTITY_COLUMNS = frozenset({"id", "org_id", "period_start", "period_end",
                                      "created_at", "source_document_id"})

#: The `documents.error` marker on a document another one replaced for
#: its month (the `duplicate_of:` shape; the row stays `analyzed`, archived).
SUPERSEDED_MARKER_PREFIX = "superseded_by:"

_TAKEOVERS_BY_RUN: Dict[str, Dict[str, Any]] = {}
_TAKEOVERS_LOCK = threading.Lock()


class PlainRefusal(RuntimeError):
    """A run refused for a reason the user reads as a sentence: the
    document's `error` carries the message itself, never the exception's
    name in front of it."""


class SameMonthTakeoverRefused(PlainRefusal):
    """The file's own CUI is not the company's — its month is not replaced."""


def superseded_marker(replacing_document_id: str) -> str:
    return "%s%s" % (SUPERSEDED_MARKER_PREFIX, replacing_document_id)


def _record_takeover(document_id: Any, *, staged: str, served: str,
                     superseded_document: Optional[str]) -> None:
    with _TAKEOVERS_LOCK:
        _TAKEOVERS_BY_RUN[str(document_id)] = {"staged": str(staged), "served": str(served),
                                               "superseded_document": superseded_document}


def _pop_takeover(document_id: Any) -> Optional[Dict[str, Any]]:
    with _TAKEOVERS_LOCK:
        return _TAKEOVERS_BY_RUN.pop(str(document_id or ""), None)


def _company_cui_of_org(admin_client: Any, org_id: Any) -> Optional[str]:
    """The company's CUI (`org_prefs.prefs.cui` — production has no
    `organizations.cui`), digits only; None when the company has none."""
    try:
        rows = admin_client.select("org_prefs", filters={"org_id": f"eq.{org_id}"},
                                   columns="org_id,prefs", limit=1) or []
    except Exception:  # noqa: BLE001 — no CUI on file is "cannot prove", not a failure
        logger.exception("[stage_persist] could not read the company's CUI for %s", org_id)
        return None
    prefs = (rows[0].get("prefs") if rows else None) or {}
    raw = prefs.get("cui") if isinstance(prefs, dict) else None
    digits = "".join(ch for ch in str(raw or "") if ch.isdigit())
    return digits or None


def _document_company_cui(doc: Dict[str, Any]) -> Optional[str]:
    """The CUI the document's OWN header states (`company_identity`, no
    registry), or None when it states none or its bytes cannot be read.
    Absent evidence never refuses anything."""
    try:
        with _supabase.admin() as admin_client:
            signed = admin_client.signed_url("documents", doc["storage_path"],
                                             org_id=doc.get("org_id"), expires_in=300)
        with httpx.Client(timeout=30.0) as http:
            r = http.get(signed)
            r.raise_for_status()
            content = r.content
        from engine.workspaces.company_identity import identify_document
        identity = identify_document(content, str(doc.get("original_filename") or ""), registry=None)
        digits = "".join(ch for ch in str(identity.cui or "") if ch.isdigit())
        return digits or None
    except Exception:  # noqa: BLE001
        logger.exception("[stage_persist] could not read the document's own CUI for %s", doc.get("id"))
        return None


def _served_document_cui(admin_client: Any, served_row: Dict[str, Any], org_id: Any) -> Optional[str]:
    """The CUI the month's OWN file states — the document the served row
    names — or None when the row names none, the document is gone, or its
    bytes state no CUI. Read only for a company without a CUI on file."""
    source_id = (served_row or {}).get("source_document_id")
    if not source_id or not org_id:
        return None
    try:
        rows = admin_client.select(
            "documents",
            filters={"id": f"eq.{source_id}", "org_id": f"eq.{org_id}"},
            columns="id,org_id,storage_path,original_filename",
            limit=1,
        ) or []
    except Exception:  # noqa: BLE001 — unreadable is "cannot prove", not a failure
        logger.exception("[stage_persist] could not read the month's own document %s", source_id)
        return None
    if not rows or not rows[0].get("storage_path"):
        return None
    return _document_company_cui(rows[0])


def _refuse_cross_company_takeover(admin_client: Any, doc: Dict[str, Any], period_end: str,
                                   served_row: Optional[Dict[str, Any]] = None) -> None:
    """Raise `SameMonthTakeoverRefused` when the file's own CUI provably
    differs from the company whose month it would replace.

    The month's company is the company's CUI on file (`org_prefs`); a
    company created before companies were keyed by CUI has none, and then
    the CUI the month's OWN file states is the evidence of whose month it
    is (G4, 2026-09-26: without it, another company's book silently
    replaced such a company's month). Refuses only what it can prove: a
    file without a CUI, or a month with no CUI on either record, passes."""
    document_cui = _document_company_cui(doc)
    if not document_cui:
        return
    company_cui = (_company_cui_of_org(admin_client, doc.get("org_id"))
                   or _served_document_cui(admin_client, served_row or {}, doc.get("org_id")))
    if not company_cui or document_cui == company_cui:
        return
    month = str(period_end)[:7]
    raise SameMonthTakeoverRefused(
        "This file belongs to CUI %s, but %s of this company belongs to CUI %s. "
        "The month was not replaced — the analysis already there is unchanged. "
        "Upload the file to its own company." % (document_cui, month, company_cui)
    )


def _finalize_same_month_takeover(doc: Dict[str, Any], period_id: str) -> str:
    """The run has SUCCEEDED: if it was staged beside an existing month,
    make it that month. Returns the period id the document is pinned to —
    the served row after a takeover, `period_id` itself otherwise.

    Order, so that a crash between two steps leaves a state a reader can
    tell apart (the provenance stamp names the document an envelope was
    built from) and never an empty month:
      1. the run's rows move from the staged row onto the served row;
      2. the served row takes the staged row's columns (envelope, currency,
         confidence, detection) — its identity columns untouched;
      3. the staged row gives up the (org, month, document) tuple, the
         served row takes it, the staged row goes;
      4. the document is pinned to the served row; the superseded document
         is archived with a marker naming its replacement — bytes and row
         kept, restorable."""
    record = _pop_takeover(doc.get("id"))
    if not record or record.get("staged") != str(period_id):
        return period_id
    staged, served = record["staged"], record["served"]
    org_id = doc.get("org_id")
    superseded = record.get("superseded_document")
    with _supabase.admin() as admin_client:
        served_rows = admin_client.select(
            "financial_periods",
            filters={"id": f"eq.{served}", "org_id": f"eq.{org_id}"},
            columns="id,source_document_id", limit=1,
        ) or []
        if not served_rows:
            # The month's row went away during the run (a delete, a move):
            # the staged row is simply the month's row now.
            logger.info("[stage_persist] %s: the month's period %s is gone — the staged row %s stands",
                        doc.get("id"), served, staged)
            return period_id
        # 1. the run's rows
        for table in TAKEOVER_TABLES:
            admin_client.delete(table, filters={"period_id": f"eq.{served}"})
            admin_client.update(table, {"period_id": served}, filters={"period_id": f"eq.{staged}"})
        # 2. the row's own columns
        staged_rows = admin_client.select("financial_periods", filters={"id": f"eq.{staged}"}, limit=1) or []
        patch = dict((k, v) for k, v in (staged_rows[0] if staged_rows else {}).items()
                     if k not in _PERIOD_IDENTITY_COLUMNS)
        patch["updated_at"] = _now_iso()
        if patch:
            admin_client.update("financial_periods", patch, filters={"id": f"eq.{served}"})
        # 3. the tuple, then the staged row
        admin_client.update("financial_periods", {"source_document_id": None}, filters={"id": f"eq.{staged}"})
        admin_client.update("financial_periods", {"source_document_id": doc.get("id")},
                            filters={"id": f"eq.{served}"})
        admin_client.delete("financial_periods", filters={"id": f"eq.{staged}", "org_id": f"eq.{org_id}"})
        # 4. the documents
        admin_client.update("documents", {"period_id": served},
                            filters={"id": f"eq.{doc.get('id')}", "org_id": f"eq.{org_id}"})
        if superseded and str(superseded) != str(doc.get("id")):
            admin_client.update(
                "documents",
                {"deleted_at": _now_iso(), "error": superseded_marker(str(doc.get("id")))},
                filters={"id": f"eq.{superseded}", "org_id": f"eq.{org_id}", "deleted_at": "is.null"},
            )
    # The staged row no longer exists: nothing of this run is left to roll back.
    _pop_period_minted(doc.get("id"))
    logger.info("[stage_persist] %s replaced the month's period %s (staged %s; superseded document %s)",
                doc.get("id"), served, staged, superseded)
    return served


def stage_persist(doc: Dict[str, Any], parsed: Dict[str, Any], assembled: Dict[str, Any]) -> str:
    """Lookup-or-create the financial_period for this document's
    (org, period_end, source_document_id) tuple, then refresh its
    statement_line_items from the extracted statements. Returns the
    resolved period_id.

    Period-container discipline (post Bug-A fix — May 2026):
      · ONE period per (org_id, period_end, source_document_id) — enforced
        by the `financial_periods_org_period_doc_unique` constraint.
      · Same-document re-runs UPDATE the same period (the SELECT on the
        3-col tuple finds the existing row).
      · Two different documents on the same date — even for the same
        company — each get their OWN period row. This prevents the
        historical collision where a same-date upload from a different
        company would hijack and wipe the first company's line items.
      · `financial_periods.source_document_id` is the canonical identity
        key, immutable, FK-bound to documents(id).

    Pre-Bug-A history: the lookup-or-create previously filtered only by
    (org_id, period_end), which meant ANY second upload sharing a date
    found and reused the first period's row, then wiped its line items
    in step 4 below. Adding source_document_id to the SELECT closes that
    collision. (See Bug A fix: src/engine/api/pipeline.py:910-922.)
    """
    period_end, period_detection = resolve_period_end_for_persist(doc, parsed)
    period_start = period_end  # we don't have start info — treat as point-in-time

    # AUTO-RECONCILE addendum — the previously-persisted period row (when
    # one exists) supplies the OLD envelope so reconciliation state can be
    # carried forward on a same-file re-scan (see step 5 below).
    prior_period_row: Optional[Dict[str, Any]] = None

    with _supabase.admin() as admin_client:
        # 1. Lookup existing period for this (org, period_end, source_document_id).
        # Post-Bug-A: the DB enforces UNIQUE (org_id, period_end, source_document_id);
        # the 3-col SELECT here finds same-document re-runs (so we UPDATE
        # the same period row) but NOT different-document uploads sharing
        # the same date (each gets its own period row via the INSERT branch).
        existing = admin_client.select(
            "financial_periods",
            filters={
                "org_id": f"eq.{doc['org_id']}",
                "period_end": f"eq.{period_end}",
                "source_document_id": f"eq.{doc['id']}",
            },
            single=True,
        )
        if existing:
            period_id = existing[0]["id"]
            prior_period_row = existing[0]
            # Keep source_document_id pointing at the original. Update mutable
            # fields only — extraction_confidence reflects the latest analysis.
            admin_client.update(
                "financial_periods",
                {
                    "currency": parsed.get("currency") or existing[0].get("currency") or "RON",
                    "extraction_confidence": parsed.get("confidence", 0.5),
                    "updated_at": _now_iso(),
                },
                filters={"id": f"eq.{period_id}"},
            )
        else:
            # 2a. Duplicate-month = REPLACE (2026-07-25 operator directive).
            #     No period exists for THIS document, but one may already exist
            #     for this MONTH from a DIFFERENT document. Under the current
            #     one-company-per-workspace model, a same-month upload is the
            #     same company's same month, so it must REPLACE that month's
            #     period rather than leave a second period for the same month
            #     ("don't allow duplicate months in a workspace") — but only
            #     ONCE ITS RUN HAS SUCCEEDED (G4, 2026-09-26): the run below
            #     persists under a staged row and `_finalize_same_month_
            #     takeover` swaps it in at the terminal; a failure leaves the
            #     month serving what it served. Re-pointing the row here, as
            #     this branch used to, emptied the owner's December when the
            #     replacing run failed.
            #
            #     NB: the Bug-A separation (different documents on the same
            #     date in separate periods, so a *different company's* file
            #     never wipes the first) is kept in its own form: a file whose
            #     own CUI is another company's is refused before anything is
            #     staged (`_refuse_cross_company_takeover`).
            month_periods = admin_client.select(
                "financial_periods",
                filters={
                    "org_id": f"eq.{doc['org_id']}",
                    "period_end": f"eq.{period_end}",
                },
                order="updated_at.desc",  # newest first if legacy duplicates exist
            )
            if month_periods:
                # 2a'. NOT YET. The served row keeps serving until this run
                #      has succeeded (G4 — see the takeover notes above the
                #      helpers). The run persists under a STAGED row of its
                #      own, minted by this run (rolled back with a failure);
                #      `_finalize_same_month_takeover` makes it the month
                #      once the run is terminal. First the belt and braces:
                #      another company's file never replaces this month.
                served_row = month_periods[0]
                _refuse_cross_company_takeover(admin_client, doc, period_end, served_row)
                prior_period_row = served_row
                try:
                    staged = admin_client.insert(
                        "financial_periods",
                        {
                            "org_id": doc["org_id"],
                            "source_document_id": doc["id"],
                            "period_start": period_start,
                            "period_end": period_end,
                            "currency": parsed.get("currency") or served_row.get("currency") or "RON",
                            "extraction_confidence": parsed.get("confidence", 0.5),
                        },
                        returning=True,
                    )
                    period_id = staged[0]["id"]
                    _record_period_minted(doc.get("id"), period_id)
                except Exception:
                    # This document's own tuple already exists (a twin run of
                    # the same document): it is this run's row.
                    own = admin_client.select(
                        "financial_periods",
                        filters={
                            "org_id": f"eq.{doc['org_id']}",
                            "period_end": f"eq.{period_end}",
                            "source_document_id": f"eq.{doc['id']}",
                        },
                    )
                    if not own:
                        raise
                    period_id = own[0]["id"]
                _record_takeover(doc.get("id"), staged=period_id, served=served_row["id"],
                                 superseded_document=served_row.get("source_document_id"))
            else:
                # 2b. Genuinely new month — insert a fresh period row. If a
                #     concurrent upload races to insert the same tuple, the
                #     unique constraint raises and we re-select the winner.
                try:
                    inserted = admin_client.insert(
                        "financial_periods",
                        {
                            "org_id": doc["org_id"],
                            "source_document_id": doc["id"],
                            "period_start": period_start,
                            "period_end": period_end,
                            "currency": parsed.get("currency") or "RON",
                            "extraction_confidence": parsed.get("confidence", 0.5),
                        },
                        returning=True,
                    )
                    period_id = inserted[0]["id"]
                    # G4 — this run MINTED the row. Recorded so that, if a
                    # later stage fails, the orchestrator removes it again:
                    # a period exists only once an analysed source document
                    # backs it (see `_rollback_period_of_failed_run`).
                    _record_period_minted(doc.get("id"), period_id)
                except Exception:
                    # Race-loser: another upload for this month won. Re-select
                    # by (org_id, period_end) and reuse it — same replace
                    # semantics as 2a.
                    rows = admin_client.select(
                        "financial_periods",
                        filters={
                            "org_id": f"eq.{doc['org_id']}",
                            "period_end": f"eq.{period_end}",
                        },
                        order="updated_at.desc",
                    )
                    if not rows:
                        raise
                    period_id = rows[0]["id"]
                    prior_period_row = rows[0]

        # 3. Pin the document to the resolved period. Documents drive period
        #    ownership now — multiple docs per period.
        admin_client.update(
            "documents",
            {"period_id": period_id},
            filters={"id": f"eq.{doc['id']}"},
        )

        # 4. Wipe + re-insert statement line items for this period. The new
        #    document's extraction becomes the canonical analysis until
        #    another doc on this period is re-run.
        admin_client.delete("statement_line_items", filters={"period_id": f"eq.{period_id}"})
        line_items = assembled.get("lineItems") or []
        if line_items:
            # Whitelist columns that exist in statement_line_items. The
            # assembler emits an extra `canonical_bucket` field for the
            # sub-aggregate audit trail; PostgREST 400s on unknown columns,
            # so strip it here. When the DB migration adds a sub_bucket
            # column, this whitelist gets extended (or removed).
            _ALLOWED_COLS = {
                "period_id", "statement", "bucket",
                "ro_account_code", "ro_account_name",
                "amount", "is_derived",
            }
            rows = [
                {k: v for k, v in {"period_id": period_id, **item}.items() if k in _ALLOWED_COLS}
                for item in line_items
            ]
            for i in range(0, len(rows), 500):
                admin_client.insert("statement_line_items", rows[i:i+500], returning=False)

        # 5. F4.1e — persist the canonical envelope to the JSONB column on
        #    financial_periods. Best-effort: any failure here doesn't break
        #    the pipeline (assembled_bs/pl/cf and line items already landed).
        #    The read path also recomputes canonical on-the-fly via
        #    assemble_statements, so a NULL persisted value doesn't block
        #    consumers — DB persistence is for archive + offline analytics +
        #    audit (matches the comment on the column).
        #
        #    Note: only writes when the engine actually emitted a canonical
        #    envelope. Old engine builds without F4.1c return assembled
        #    without the key, in which case we leave the column NULL rather
        #    than UPDATE to NULL (which would overwrite any prior canonical
        #    captured by a newer engine — preserving the most-recent envelope).
        canonical = assembled.get("assembled_canonical_v1")
        if isinstance(canonical, dict):
            # canonical_bs v2 — the presentation-ready BS authority
            # travels INSIDE this envelope (built at stage_map, served
            # verbatim by /api/period). Absence means the builder failed
            # upstream and the period will fall back to the legacy
            # Fix-A1 read path — loggable, not fatal.
            if "canonical_bs" not in canonical:
                logger.warning(
                    "[stage_persist] envelope carries no canonical_bs for "
                    "period %s — legacy Fix-A1 read path will serve it",
                    period_id,
                )
            # PROVENANCE STAMP (2026-08-13). A period was caught serving a
            # DELETED document's analysis under a newer document's name: the
            # Aug-02 Agras envelope survived its documents' soft-deletion and
            # an Aug-12 adoption scan of a different file linked the new doc
            # without this envelope being replaced — the numbers on screen
            # belonged to a file that was no longer attached. Stamping the
            # envelope with the document it was BUILT FROM makes that state
            # detectable forever: any reader can assert
            # envelope.provenance.source_document_id == period.source_document_id
            # and flag a mismatch instead of trusting stale artifacts.
            canonical["provenance"] = {
                "source_document_id": doc.get("id"),
                "original_filename": doc.get("original_filename"),
                "content_hash": doc.get("content_hash"),
                "written_at": datetime.now(timezone.utc).isoformat(),
            }
            # PERIOD-DETECTION STAMP (2026-08-30). Same seam, same
            # reason as the provenance stamp above: record WHICH SIGNAL
            # actually decided this period's identity, plus what the
            # document's own evidence said, at the moment it was
            # written. `mismatch` is true when a real detection points
            # somewhere other than where the period was filed — the
            # ground truth behind the mismatch chip (Parts D/E), which
            # must never have to recompute a verdict about a row it
            # didn't write. Additive; readers that don't know the key
            # are unaffected.
            canonical["period_detection"] = period_detection
            # AUTO-RECONCILE (contract addendum, 2026-08-19) — between the
            # canonical build and the SINGLE envelope write below:
            #   1. Same-file carry-forward: a re-scan of the SAME file
            #      (content_hash + parser_version + mapping_version all
            #      matching) keeps its reconciliation, history and
            #      undo-suppression instead of dropping them with the
            #      replaced envelope — no flicker, no re-run of the AI.
            #   2. The automatic stage: MINOR_DRIFT within the 0.1% gate
            #      is diagnosed (deterministic first, AI proposal only if
            #      inconclusive), validated (exact 0-cent close only) and
            #      written into THIS envelope before the persist — so the
            #      period is already RECONCILED on its very first serving
            #      and the client never sees an intermediate unreconciled
            #      sub-threshold state. Failure to fix → honest
            #      MINOR_DRIFT + needs_review on the served object (calm,
            #      not an error). Never raises.
            try:
                _carried = _reconcile.carry_forward_reconciliation(
                    canonical,
                    (prior_period_row or {}).get("assembled_canonical_v1"),
                )
                if _carried != "nothing_to_carry":
                    logger.info(
                        "[stage_persist] reconciliation carry-forward=%s "
                        "for period %s",
                        _carried,
                        period_id,
                    )
                _auto = _reconcile.auto_reconcile_envelope(canonical)
                # PS1 STRUCTURAL GUARD — public_summary envelopes never
                # reach the AI-advisory or consensus seams. The env gates
                # (AI_ADVISORY_ENABLED / CONSENSUS_ENABLED) are
                # operational, not structural: they can be turned on.
                # Document-class check, shared predicate with the
                # reconcile refusals.
                _is_public_summary = _reconcile.is_public_summary_envelope(canonical)
                # Advisory AI review (env-gated OFF; additive-only; never
                # raises; deterministic validator remains the only gate).
                if not _is_public_summary:
                    _ai_advisory.pipeline_hook(canonical)
                # C1 CONSENSUS attach (CONSENSUS_ENABLED=1 only — the
                # block exists on `parsed` only behind that gate):
                # additive-only onto canonical_bs; served values stay
                # CLASSIC (E4). Never raises. Skipped structurally for
                # public_summary (a consensus block would feed the
                # "AI-verified" trust line onto a document no AI touched).
                _c1_consensus = (parsed or {}).get("consensus_c1")
                if isinstance(_c1_consensus, dict) and not _is_public_summary:
                    from engine.consensus import persist as _consensus_persist
                    if _consensus_persist.attach_consensus(canonical, _c1_consensus):
                        logger.info(
                            "[stage_persist] consensus block attached for "
                            "period %s", period_id,
                        )
                # RUN JOURNAL — RECONCILE_APPLIED / RECONCILE_SKIPPED.
                _journal_hooks.on_reconcile_outcome(doc, period_id, canonical, _auto)
                if _auto.get("outcome") not in ("balanced_noop",):
                    logger.info(
                        "[stage_persist] auto-reconcile outcome=%s for "
                        "period %s: %s",
                        _auto.get("outcome"),
                        period_id,
                        _auto,
                    )
            except Exception:  # noqa: BLE001 — persist must never break
                logger.exception(
                    "[stage_persist] auto-reconcile stage failed "
                    "(non-fatal) for period %s",
                    period_id,
                )
            # RUN JOURNAL — SNAPSHOT_PERSISTED. Ordering rule: the
            # content-addressed object is written FIRST, then the journal
            # event commits, and only THEN does serving flip via the DB
            # write below (crash-safety contract; no-op when the journal
            # is off, never raises, never mutates `canonical`).
            _journal_hooks.on_snapshot_persisted(doc, period_id, canonical)
            try:
                admin_client.update(
                    "financial_periods",
                    {"assembled_canonical_v1": canonical},
                    filters={"id": f"eq.{period_id}"},
                )
            except Exception:  # noqa: BLE001
                logger.exception(
                    "[stage_persist] failed to persist assembled_canonical_v1 "
                    "for period %s (non-fatal; read path still recomputes)",
                    period_id,
                )

    return period_id


# ── F1.h — composite-score → letter grade mapping (locked per SPEC §10). ──
# The ladder itself lives in ONE place: `engine.ratios.credit_model.
# CREDIT_LETTER_LADDER`. This helper and the `letter_grade_bands` field
# `get_period` serves both read it, so the letter a composite earns and
# the rungs printed beside it cannot disagree. The FE's
# `compositeToGrade()` in `CreditScoreCard.tsx` mirrors those rungs;
# `tests/engine/test_credit_ladder_single_source.py` reds on a second
# literal copy anywhere in this module or in `engine/ratios/`.
def _composite_to_letter_grade(composite: Optional[float]) -> Optional[str]:
    # None for a null, non-finite or out-of-range composite (R-RANGE): a
    # letter is never minted from a score the model did not validly produce.
    return _credit_model.composite_to_letter_grade(composite)


def stage_compute(doc: Dict[str, Any], assembled: Dict[str, Any], period_id: str) -> List[Dict[str, Any]]:
    """Compute headline metrics + ratios from the assembled statements.
    Persists to calculated_metrics (idempotent: wipe + re-insert).

    The arithmetic is `engine.ratios.credit_model.compute_period_metrics`
    — a pure function of the statements, run here and nowhere else at
    persist time. This function only persists what it returns.
    """
    metrics = _credit_model.compute_period_metrics(
        assembled["statements"],
        source_data_quality=assembled.get("source_data_quality"),
    )

    # Persist
    org_id = doc["org_id"]
    with _supabase.admin() as admin_client:
        admin_client.delete("calculated_metrics", filters={"period_id": f"eq.{period_id}"})
        rows = [
            {
                "period_id": period_id,
                "org_id": org_id,
                "name": m["name"],
                "value": m["value"],
                "unit": m["unit"],
                "direction": m["direction"],
            }
            for m in metrics
        ]
        admin_client.insert("calculated_metrics", rows, returning=False)
    return metrics


#: The EBITDA definition every stored briefing is stamped with.
_EBITDA_DEFINITION_REVISION = _ro_chart_of_accounts.EBITDA_DEFINITION_REVISION

#: The one-line note a briefing written under an earlier EBITDA definition is
#: served with (and hidden behind) — never shown beside corrected numbers.
BRIEFING_PREVIOUS_DEFINITION_NOTE = {
    "ro": "Comentariul a fost scris sub definiția anterioară a EBITDA "
          "(fără variația stocurilor de produse și producția imobilizată) și "
          "este ascuns; reanalizați perioada pentru un comentariu nou.",
    "en": "This briefing was written under the previous EBITDA definition "
          "(without the stock variation and own work capitalised) and is "
          "hidden; re-analyse the period for a new one.",
}


def briefing_definition_status(briefing: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """For a stored briefing row: the EBITDA definition it was written under
    and, when that is not today's (or unknown — every row written before the
    stamp existed), `written_under_previous_definition` and the note. None
    when there is no briefing."""
    if not briefing:
        return None
    stamped = briefing.get("ebitda_definition")
    current = stamped == _EBITDA_DEFINITION_REVISION
    return {
        "written_under": stamped,
        "current_definition": _EBITDA_DEFINITION_REVISION,
        "written_under_previous_definition": not current,
        "note": None if current else dict(BRIEFING_PREVIOUS_DEFINITION_NOTE),
    }


def stage_validate(doc: Dict[str, Any], assembled: Dict[str, Any], period_id: str) -> List[Dict[str, Any]]:
    """Generate deterministic alerts from the canonical `period_facts`-shaped
    views (`assembled_pl`, `assembled_bs`, `assembled_cf`). Every rule has a
    unique `alert_key`; duplicates are removed structurally before insert.

    LLM-generated alerts are NO LONGER persisted — narrative is reserved for
    the briefing + decision rationale. This eliminates the "15 duplicate
    critical alerts" problem (LLM emitting multiple variations of the same
    concern, each with a fresh fallback key on every rerun).

    Sign-bug guard: rules that interpret negative numbers (equity below half
    of capital, negative FCF, etc.) read values directly from the canonical
    views, which store credit-natural amounts with the SAME sign convention
    as the source books (positive equity = positive equity). No inversion.
    """
    s = assembled["statements"]
    bs = s["balanceSheet"]
    pl = s["incomeStatement"]
    pl_canonical = s.get("assembled_pl", {}) or {}
    bs_canonical = s.get("assembled_bs", {}) or {}
    cf_canonical = s.get("assembled_cf", {}) or {}
    sub_agg = s.get("subAggregates", {}) or {}
    industry_key = doc.get("industry_key") or "generic"

    # ── Canonical inputs ─────────────────────────────────────────────────
    # Pull the numbers we need ONCE up front, with safe fallbacks back to
    # the legacy assembled shape for the rare case where canonical views
    # aren't populated. Every rule below reads from these locals — no rule
    # re-derives a metric from the raw `bs` / `pl` blobs.
    # THE ONE EBITDA (owner ruling 2026-09-26): net 711 and net 72x inside.
    # A REFUSED EBITDA (net 711 unmeasurable on a book that posts to it) is
    # None here and every EBITDA rule stays silent on it — it used to read
    # `or 0`, which turned a refusal into "EBITDA RON 0 — earnings-based
    # valuation not applicable". The refusal is its own alert (R10b).
    _ebitda_raw = pl_canonical.get("ebitda")
    ebitda_refusal = pl_canonical.get("ebitda_refusal") if _ebitda_raw is None else None
    ebitda_known = isinstance(_ebitda_raw, (int, float)) and not isinstance(_ebitda_raw, bool)
    # Kept under its historical local name (the fact key the persisted
    # alerts cite); it IS the one EBITDA — `ebitda_statutory` is its alias.
    ebitda_statutory = float(_ebitda_raw) if ebitda_known else 0.0
    capitalized = float(
        pl_canonical.get("capitalized_own_work_memo", pl.get("capitalizedOwnWork", 0)) or 0
    )
    rental_revenue = float(pl_canonical.get("revenue", pl.get("revenue", 0)) or 0)
    interest_expense = float(pl_canonical.get("interest_expense", pl.get("interestExpense", 0)) or 0)
    total_assets = float(bs_canonical.get("total_assets") or 0)
    total_liabilities = float(bs_canonical.get("total_liabilities") or 0)
    total_equity = float(bs_canonical.get("total_equity") or 0)
    share_capital = float(bs_canonical.get("share_capital", bs.get("shareCapital", 0)) or 0)
    revaluation_reserves = float(bs_canonical.get("revaluation_reserves") or 0)
    bank_debt_total = float(bs_canonical.get("total_debt") or 0)
    cash_val = float(bs_canonical.get("cash", bs.get("cash", 0)) or 0)
    ap_dividends = float(bs_canonical.get("ap_dividends") or sub_agg.get("ap_dividends", 0) or 0)
    intercompany = float(bs_canonical.get("intercompany_loans") or sub_agg.get("ar_intercompany", 0) or 0)
    cf_cfo = float(cf_canonical.get("cash_from_operating") or 0)
    cf_capex = float(cf_canonical.get("capex_real") or 0)
    cf_fcf = float(cf_canonical.get("free_cash_flow") or 0)
    cip_capex = float(cf_canonical.get("capitalized_construction") or 0)

    # Fallback computation for total_assets when canonical isn't populated
    # — keeps the BS-imbalance rule meaningful for legacy callers.
    if total_assets == 0 and bs:
        total_assets = (
            bs.get("cash", 0) + bs.get("accountsReceivable", 0) + bs.get("inventory", 0)
            + bs.get("otherCurrentAssets", 0) + bs.get("propertyPlantEquipment", 0)
            + bs.get("intangibles", 0) + bs.get("otherNonCurrentAssets", 0)
        )
    bs_delta = float(bs_canonical.get("bs_balance_delta") or 0)

    # Industry-aware Debt/EBITDA threshold table.
    _DTE_THRESHOLDS = {
        "real_estate_commercial":  (8.0, 12.0),
        "real_estate_residential": (7.0, 10.0),
        "real_estate":             (8.0, 12.0),
        "manufacturing":           (4.0, 6.0),
        "wholesale_distribution":  (3.5, 5.5),
        "fmcg":                    (3.5, 5.5),
        "saas":                    (3.0, 5.0),
        "b2b_saas":                (3.0, 5.0),
    }
    dte_high, dte_critical = _DTE_THRESHOLDS.get(industry_key, (4.0, 6.0))

    candidates: List[Dict[str, Any]] = []

    # The currency the period's books are actually in, and the currency
    # LABEL these rule strings hard-code. They are the same for every
    # production period today (all 128 are RON) but they are different
    # CONCEPTS: `stmt_currency` is what the numbers mean, `_AUTHORED_LABEL`
    # is what the f-strings below type. Templatizing against the authored
    # label is what lets a non-RON period drop the wrong word instead of
    # rendering a EUR magnitude under a RON tag.
    stmt_currency = str(s.get("currency") or "RON").upper()
    _AUTHORED_LABEL = "RON"

    def _q(value: float, name: Optional[str] = None) -> "_ratio_units.Quantity":
        """A money operand in the period's own currency, at unit scale.
        Every ratio below is computed from two of these — identical
        currency, identical scale — or it raises rather than coerces."""
        return _ratio_units.money(value, stmt_currency, name=name)

    def _add(rule_key: str, severity: str, category: str, title: str, body: str,
             facts: Dict[str, float]) -> None:
        """Append a candidate alert. Same rule_key can only land once per
        period (deduped before persist).

        TYPED PLACEHOLDERS (2026-08-30). Alongside the plain strings, each
        candidate carries `title_template` / `body_template`, in which
        every cited MONEY figure — and its hard-coded currency label — has
        been replaced by `{{money:<fact>}}`, plus `fact_units`, the unit of
        every cited fact. The renderer resolves those through the same
        money path as the rest of the UI, so one claim can no longer mix a
        native figure with a converted one (the Critical-461 defect).

        Additive on purpose: `title` / `body` stay byte-identical and
        remain the fallback for stored rows that predate this, and
        `render_native(template) == body` byte-for-byte (gated in
        tests/engine/test_ratio_units.py::test_g13...). Templatizing is
        derived, never hand-authored, so the two cannot drift apart.
        """
        candidate: Dict[str, Any] = {
            "alert_key": f"{rule_key}:{period_id}",
            "rule_key": rule_key,
            "severity": severity,
            "category": category,
            "title": title,
            "body": body,
            "facts_cited": facts,
            "industry": industry_key,
        }
        try:
            candidate["fact_units"] = _ratio_units.units_for(facts)
            candidate["source_currency"] = stmt_currency
            candidate["title_template"] = _ratio_units.templatize(
                title, facts, _AUTHORED_LABEL)
            candidate["body_template"] = _ratio_units.templatize(
                body, facts, _AUTHORED_LABEL)
        except Exception:  # pragma: no cover — never block an alert on prose
            logger.warning("[pipeline] templatize failed for %s", rule_key, exc_info=True)
        candidates.append(candidate)

    # ── R1. Data quality — BS imbalance ──────────────────────────────────
    drift = abs(bs_delta) if bs_delta else abs(total_assets - total_liabilities - total_equity)
    # RATIO LAW: drift and assets are both money in the period's own
    # currency at unit scale, so this quotient is dimensionless and
    # invariant under the display currency. `_q` refuses rather than
    # coerces if that ever stops being true.
    # `safe_ratio` because this one is computed UNCONDITIONALLY: a
    # non-finite total from a broken extract must skip the rule the way it
    # always did, not raise out of stage_validate on a live upload.
    _drift_share = _ratio_units.safe_ratio(_q(drift, "drift"),
                                           _q(max(total_assets, 1), "total_assets"))
    drift_share = _drift_share if _drift_share is not None else 0.0
    if total_assets > 0 and drift_share > 0.01:
        sev = "critical" if drift > total_assets * 0.05 else "high"
        _add(
            "data_quality_bs_imbalance", sev, "data_quality",
            f"Balance sheet does not balance — drift RON {drift:,.0f}",
            f"Total assets RON {total_assets:,.0f} vs liabilities + equity RON "
            f"{total_liabilities + total_equity:,.0f} differ by RON {drift:,.0f} "
            f"({drift_share * 100:.1f}% of assets). Pipeline "
            f"integrity issue — every downstream metric is suspect until resolved.",
            {"total_assets": total_assets, "total_liabilities": total_liabilities,
             "total_equity": total_equity, "drift": drift},
        )

    # ── R2. Data quality — empty P&L ─────────────────────────────────────
    if rental_revenue == 0 and total_assets > 1_000_000 and capitalized == 0:
        _add(
            "data_quality_pnl_zero", "critical", "data_quality",
            f"Zero revenue with RON {total_assets:,.0f} asset base — extraction gap",
            f"No revenue recorded for the period despite material assets. Likely a "
            f"P&L extraction issue (assembler reading closing balances for income "
            f"accounts instead of YTD movements). Investigate before relying on any "
            f"P&L metric.",
            {"rental_revenue": rental_revenue, "total_assets": total_assets},
        )

    # ── R3. Leverage — Debt/EBITDA above threshold ───────────────────────
    if ebitda_known and ebitda_statutory > 0 and bank_debt_total > 0:
        dte = _ratio_units.ratio(_q(bank_debt_total, "bank_debt_total"),
                                 _q(ebitda_statutory, "ebitda_statutory"))
        if dte > dte_critical:
            _add(
                "leverage_debt_to_ebitda_high", "critical", "leverage",
                f"Debt/EBITDA at {dte:.2f}× exceeds {dte_critical:.1f}× critical threshold for {industry_key}",
                f"Bank debt RON {bank_debt_total:,.0f} divided by EBITDA "
                f"RON {ebitda_statutory:,.0f} = {dte:.2f}×, above the {dte_critical:.1f}× "
                f"critical threshold typical for this industry. Covenant breach risk.",
                {"debt_to_ebitda": dte, "bank_debt_total": bank_debt_total,
                 "ebitda_statutory": ebitda_statutory, "threshold": dte_critical},
            )
        elif dte > dte_high:
            _add(
                "leverage_debt_to_ebitda_high", "high", "leverage",
                f"Debt/EBITDA at {dte:.2f}× above {dte_high:.1f}× comfort zone for {industry_key}",
                f"Bank debt RON {bank_debt_total:,.0f} on EBITDA "
                f"RON {ebitda_statutory:,.0f} = {dte:.2f}×, above typical comfort but "
                f"below covenant alarm for {industry_key}.",
                {"debt_to_ebitda": dte, "bank_debt_total": bank_debt_total,
                 "ebitda_statutory": ebitda_statutory, "threshold": dte_high},
            )

    # ── R4. Equity below half of share capital (Art. 153^24) ─────────────
    # SIGN-BUG GUARD: only fires when total_equity (as stored, positive
    # convention) is actually below half of share_capital. Previously the
    # platform inverted the sign and tripped this rule on a positive-equity
    # company.
    if share_capital > 0 and total_equity < share_capital / 2:
        sev = "critical" if total_equity < 0 else "high"
        title = (
            f"Negative book equity RON {total_equity:,.0f} — Romanian Company Law requires review"
            if total_equity < 0
            else f"Equity (RON {total_equity:,.0f}) below half of share capital (RON {share_capital:,.0f})"
        )
        _add(
            "equity_below_half_capital", sev, "compliance",
            title,
            f"Under Romanian Company Law Art. 153^24, when equity falls below half of "
            f"registered share capital the administrator must convene the general "
            f"meeting to decide on recapitalisation or dissolution.",
            {"total_equity": total_equity, "share_capital": share_capital,
             "ratio": _ratio_units.ratio(_q(total_equity, "total_equity"),
                                         _q(max(share_capital, 1), "share_capital"))},
        )

    # ── R5. RETIRED 2026-09-26 (owner ruling) ───────────────────────────
    # "Capitalized own-work … Statutory EBITDA (with 722) vs operational
    # view (without)". The ruling puts 72x INSIDE the one EBITDA and allows
    # no served second EBITDA beside it, so the "dual view" this card sized
    # no longer exists (both names are aliases of one figure; the card
    # would have printed the same number twice). The own work capitalised
    # is shown on its own line of the EBITDA reconciliation
    # (assembled_pl.ebitda_reconciliation), with its provenance.

    # ── R6. Revaluation reserves — equity quality ────────────────────────
    if total_equity > 0 and abs(revaluation_reserves) > total_equity * 0.25:
        share_pct = _ratio_units.ratio(
            _q(abs(revaluation_reserves), "revaluation_reserves"),
            _q(total_equity, "total_equity")) * 100
        _add(
            "equity_quality_revaluation_reserves", "info", "data_quality",
            f"Revaluation reserves are {share_pct:.0f}% of equity",
            f"Account 105 (Rezerve din reevaluare) of RON {abs(revaluation_reserves):,.0f} "
            f"represents {share_pct:.0f}% of total equity RON {total_equity:,.0f}. "
            f"This is a non-cash accounting reserve from upward revaluation of property — "
            f"equity quality is materially lower than the balance sheet suggests for lender / "
            f"buyer analysis.",
            {"revaluation_reserves": revaluation_reserves, "total_equity": total_equity,
             "pct_of_equity": share_pct / 100},
        )

    # ── R7. Concentration — intercompany receivable ──────────────────────
    if total_assets > 0 and intercompany > 100_000:
        # The 19.6% of the Critical-461 note. Native over native, same
        # currency, same scale — correct, and pinned by
        # frontend/lib/__tests__/noteCurrencyUnity.test.tsx.
        pct = _ratio_units.ratio(_q(intercompany, "intercompany_loans"),
                                 _q(total_assets, "total_assets"))
        if pct > 0.10:
            sev = "high" if pct > 0.20 else "medium"
            _add(
                "concentration_intercompany_loan", sev, "data_quality",
                f"Intercompany receivable RON {intercompany:,.0f} = {pct*100:.1f}% of total assets",
                f"Account 461 (Debitori diverși) holds RON {intercompany:,.0f} due from "
                f"related parties — {pct*100:.1f}% of total assets RON {total_assets:,.0f}. "
                f"Recoverability and intent on settlement should be confirmed. Lenders "
                f"typically haircut related-party receivables during covenant measurement.",
                {"intercompany_loans": intercompany, "total_assets": total_assets,
                 "pct_of_assets": pct},
            )

    # ── R8. Dividends declared but unpaid ────────────────────────────────
    if ap_dividends > 1000:
        _add(
            "cash_dividends_declared_unpaid", "medium", "liquidity",
            f"RON {ap_dividends:,.0f} dividends declared but not paid in cash",
            f"Account 457 (Dividende de plătit) carries RON {ap_dividends:,.0f} liability. "
            f"Dividends were debited to retained earnings but no cash distribution occurred. "
            + ("Operating cash flow is positive — could service this if distribution is planned."
               if cf_cfo > 0
               else "Operating cash flow is negative; distribution would strain liquidity."),
            {"dividends_payable": ap_dividends, "cash": cash_val, "cash_from_operating": cf_cfo},
        )

    # ── R9. FCF negative — development phase vs ongoing burn ─────────────
    if cf_fcf < 0 and cf_capex < 0:
        cip_dominant = abs(cip_capex) > abs(cf_capex) * 0.7
        if cip_dominant:
            _add(
                "fcf_negative_development_phase", "medium", "liquidity",
                f"Free cash flow RON {cf_fcf:,.0f} — one-time CIP capex",
                f"Operating cash flow RON {cf_cfo:,.0f} minus capex RON {abs(cf_capex):,.0f} "
                f"(RON {abs(cip_capex):,.0f} into account 231 Construction in Progress) "
                f"produces negative FCF this period. Development-phase drag, not ongoing burn — "
                f"stabilized FCF should be positive once CIP delivers.",
                {"cash_from_operating": cf_cfo, "capex_real": cf_capex,
                 "capitalized_construction": cip_capex, "free_cash_flow": cf_fcf},
            )
        else:
            _add(
                "fcf_negative_development_phase", "high", "liquidity",
                f"Free cash flow RON {cf_fcf:,.0f} — ongoing burn",
                f"Operating cash flow does not cover capex; cash buffer is being eroded.",
                {"cash_from_operating": cf_cfo, "capex_real": cf_capex,
                 "free_cash_flow": cf_fcf},
            )

    # ── R10. Valuation — EBITDA non-positive ─────────────────────────────
    # Single alert covers it (no longer 6 variations from the LLM).
    if ebitda_known and ebitda_statutory <= 0:
        _add(
            "valuation_ebitda_negative", "high", "data_quality",
            f"EBITDA RON {ebitda_statutory:,.0f} — earnings-based valuation not applicable",
            f"With EBITDA at or below zero, EV/EBITDA multiples produce meaningless values. "
            f"The platform uses asset-based and revenue-multiple methods for valuation; see "
            f"the Valuation tab.",
            {"ebitda_statutory": ebitda_statutory},
        )

    # ── R10b. EBITDA refused (owner ruling 2026-09-26) ─────────────────
    # Net 711 could not be measured on a book that posts to it, so EBITDA,
    # the operating result and every margin on them are refused — stated,
    # with the engine's reason, never shown as 0.
    if not ebitda_known and isinstance(ebitda_refusal, dict):
        _add(
            "ebitda_refused_stock_variation", "high", "data_quality",
            "EBITDA cannot be stated for this period — the stock variation "
            "(711) is not measurable",
            "EBITDA, the operating result and the margins built on them are "
            "refused rather than shown without the stock variation: "
            + str(ebitda_refusal.get("text_en") or ebitda_refusal.get("code") or "")
            + ". Re-analyse the period from its trial balance to measure it.",
            {},
        )

    # ── RISK INVENTORY — 5-8 named risks per analysis ───────────────────
    # Ported from archive/calibration_toolkit/financial_analysis.py build_risk_inventory().
    # These are the structural risks a CFO scans for when reading a deal
    # memo: receivables-allowance quality, liquidity tightness, raw-material
    # exposure, affiliate-income dependency, asset maturity, and leverage.
    # Each one is a separate alert with category='risk_inventory' so the
    # FE can group them into a distinct section (Section 7 in the
    # comprehensive report) without interleaving with data-quality alerts.
    revenue_local = float(pl_canonical.get("revenue", pl.get("revenue", 0)) or 0)
    net_income_local = float(pl_canonical.get("net_income_statutory") or pl_canonical.get("net_income_operational") or 0)
    trade_rec_local = float(bs_canonical.get("ar_net") or 0)
    rec_provisions_local = float(bs_canonical.get("ar_provisions") or 0)
    inventory_local = float(bs.get("inventory", 0) or 0)
    exp_601 = float(sub_agg.get("cogs_601") or 0)
    exp_602 = float(sub_agg.get("cogs_602") or 0)
    materials_pct = (
        _ratio_units.ratio(_q(exp_601 + exp_602, "materials"), _q(revenue_local, "revenue"))
        if revenue_local > 0 else 0
    )
    cur_liab_local = float(
        bs.get("accountsPayable", 0) + bs.get("shortTermDebt", 0)
        + bs.get("otherCurrentLiabilities", 0)
    )
    cash_ratio_local = (
        _ratio_units.ratio(_q(cash_val, "cash"), _q(cur_liab_local, "cur_liab"))
        if cur_liab_local > 0 else 0
    )
    ppe_gross_proxy = abs(float(bs.get("propertyPlantEquipment", 0) or 0))
    ppe_amort_proxy = max(0.0, float(sub_agg.get("ppe_amort") or 0))
    asset_maturity = (
        _ratio_units.ratio(_q(ppe_amort_proxy, "ppe_amort"), _q(ppe_gross_proxy, "ppe_gross"))
        if ppe_gross_proxy > 0 else 0
    )
    affiliate_income = float(sub_agg.get("financial_income") or 0)
    affiliate_dep = (
        _ratio_units.ratio(_q(affiliate_income, "affiliate_income"),
                           _q(net_income_local, "net_income"))
        if net_income_local > 0 else 0
    )
    net_debt_local = bank_debt_total - cash_val
    nde_local = (
        _ratio_units.ratio(_q(net_debt_local, "net_debt"), _q(ebitda_statutory, "ebitda_statutory"))
        if ebitda_known and ebitda_statutory > 0 else 0
    )

    # R-RI-1 — Receivables allowance elevated. Historical credit issues
    # or affiliated-party stale balances. The Scandia case had 9.78M of
    # 491+496 provisions on 51M of gross trade rec = 19%, which fires.
    # Category is `working_capital` (a DB-allowed category); the
    # `rule_key` prefix `risk_inventory_*` is what the FE filters by to
    # show Section-7 risks. The DB CHECK constraint doesn't accept
    # `risk_inventory` so we route via rule_key instead.
    if trade_rec_local > 0 and rec_provisions_local > 0:
        prov_pct = _ratio_units.ratio(_q(rec_provisions_local, "rec_provisions"),
                                      _q(trade_rec_local, "trade_rec"))
        if prov_pct > 0.15:
            _add(
                "risk_inventory_receivables_quality", "high", "working_capital",
                f"Receivables allowance {prov_pct*100:.0f}% of gross — historical credit issues",
                f"Provisions at {prov_pct*100:.0f}% of gross trade receivables suggest stale "
                f"balances (often affiliated parties or one-off customer defaults). Pull the "
                f"491/496 aging by counterparty; write off uncollectibles to clean the BS.",
                {"prov_pct": prov_pct, "trade_rec": trade_rec_local, "rec_provisions": rec_provisions_local},
            )

    # R-RI-2 — Tight cash liquidity (cash ratio <0.10).
    if cur_liab_local > 0 and cash_ratio_local < 0.10:
        _add(
            "risk_inventory_cash_tight", "high", "liquidity",
            f"Tight cash liquidity — cash ratio {cash_ratio_local:.2f}×",
            f"Cash covers only {cash_ratio_local*100:.1f}% of current liabilities — heavy "
            f"dependence on revolvers. A 15-day disruption could push the company past "
            f"covenants or payment terms.",
            {"cash_ratio": cash_ratio_local, "cash": cash_val, "cur_liab": cur_liab_local},
        )

    # R-RI-3 — Raw-material price exposure (>30% of revenue).
    if materials_pct > 0.30:
        _add(
            "risk_inventory_raw_materials", "medium", "margin",
            f"Raw material exposure — {materials_pct*100:.0f}% of turnover",
            f"Materials cost {materials_pct*100:.0f}% of revenue. A 10% commodity-price spike "
            f"compresses EBITDA margin by ~{materials_pct*10:.1f} pp. Consider hedging the "
            f"next 6-12 months of volume via forward contracts.",
            {"materials_pct": materials_pct},
        )

    # R-RI-4 — Affiliate income dependency (>15% of net profit).
    if net_income_local > 0 and affiliate_dep > 0.15:
        _add(
            "risk_inventory_affiliate_dep", "medium", "opportunity",
            f"Affiliate income dependency — {affiliate_dep*100:.0f}% of net profit",
            f"Affiliate dividends + interest produce {affiliate_dep*100:.0f}% of net profit. "
            f"Concentration risk if any single affiliate stops distributing. Entity-by-entity "
            f"yield review recommended.",
            {"affiliate_dep": affiliate_dep, "affiliate_income": affiliate_income, "net_income": net_income_local},
        )

    # R-RI-5 — Mature asset base (accumulated dep >55% of gross PP&E).
    if ppe_gross_proxy > 0 and asset_maturity > 0.55:
        _add(
            "risk_inventory_asset_maturity", "medium", "leverage",
            f"Mature asset base — accumulated depreciation {asset_maturity*100:.0f}% of gross PP&E",
            f"Equipment approaching end of useful life. Capex pressure ahead — plan a "
            f"3-5 year replacement program; consider EU grants for eligible modernizations.",
            {"asset_maturity": asset_maturity},
        )

    # R-RI-6 — Elevated leverage (Net Debt/EBITDA >4).
    if nde_local > 4 and ebitda_known and ebitda_statutory > 0:
        _add(
            "risk_inventory_leverage", "high", "leverage",
            f"Elevated leverage — Net Debt/EBITDA {nde_local:.1f}×",
            f"Leverage at {nde_local:.1f}× EBITDA is above the typical 3× safety threshold. "
            f"Covenant pressure likely; refinancing risk if rates rise. Build a covenant "
            f"dashboard with the lender.",
            {"net_debt_ebitda": nde_local, "net_debt": net_debt_local, "ebitda": ebitda_statutory},
        )

    # R-RI-7 — FX exposure (FX cash >10% of total cash). Proxy via cash_fx sub_agg.
    fx_cash_local = float(sub_agg.get("cash_fx") or 0)
    fx_cash_share = (
        _ratio_units.ratio(_q(fx_cash_local, "fx_cash"), _q(cash_val, "total_cash"))
        if cash_val > 0 else 0
    )
    if cash_val > 0 and fx_cash_share > 0.10:
        _add(
            "risk_inventory_fx_exposure", "medium", "liquidity",
            f"FX exposure — {fx_cash_share*100:.0f}% of cash in foreign currency",
            f"Significant FX cash position. Movements in EUR/RON or USD/RON create P&L "
            f"volatility. Consider an FX hedging policy or natural-hedge alignment with "
            f"foreign-currency liabilities.",
            {"fx_cash_pct": fx_cash_share, "fx_cash": fx_cash_local, "total_cash": cash_val},
        )

    # ── Deduplicate by rule_key (structural guarantee) ──────────────────
    seen: set[str] = set()
    deduped: List[Dict[str, Any]] = []
    for alert in candidates:
        if alert["rule_key"] in seen:
            continue
        seen.add(alert["rule_key"])
        deduped.append(alert)

    # Sort critical → info so the FE renders the right order on insert.
    _severity_order = {"critical": 0, "high": 1, "medium": 2, "low": 3, "info": 4}
    deduped.sort(key=lambda a: _severity_order.get(a["severity"], 99))
    return deduped


def _convert_currency(
    value: Any,
    source_currency: str,
    display_currency: str,
    fx_rates: Optional[Dict[str, float]],
) -> Any:
    """Convert a monetary value from source to display currency.

    `fx_rates` follows the BNR shape from `fx_rates.get_fx_rates()` —
    EUR-base, where rates["RON"]=4.97 means 1 EUR ≈ 4.97 RON. Conversion
    formula: `amount_dst = amount_src * (rates[dst] / rates[src])`.
    Non-numeric inputs pass through unchanged; mismatched/missing rates
    return the source value so the briefing never silently shows garbage.
    """
    if value is None or not isinstance(value, (int, float)):
        return value
    src = (source_currency or "RON").upper()
    dst = (display_currency or src).upper()
    if dst == src or not fx_rates:
        return value
    src_rate = fx_rates.get(src)
    dst_rate = fx_rates.get(dst)
    if not src_rate or not dst_rate:
        return value
    return value * (dst_rate / src_rate)


def _convert_briefing_facts(
    facts: Dict[str, Any],
    source_currency: str,
    display_currency: str,
    fx_rates: Optional[Dict[str, float]],
) -> Dict[str, Any]:
    """Walk briefing_facts and convert every monetary field. Ratios + pct
    fields (anything ending in `_pct`, `_margin`, `_ratio`, `_pct_*`, or
    inside the `ratios` sub-dict that isn't itself a money amount) stay
    untouched — they're dimensionless and don't change with FX."""
    if display_currency == source_currency or not fx_rates:
        return facts
    out: Dict[str, Any] = {}
    for k, v in facts.items():
        if k == "ratios" and isinstance(v, dict):
            # Sub-dict: only `net_debt` is currency-denominated; ratios are dimensionless.
            sub: Dict[str, Any] = {}
            for rk, rv in v.items():
                if rk == "net_debt":
                    sub[rk] = _convert_currency(rv, source_currency, display_currency, fx_rates)
                else:
                    sub[rk] = rv
            out[k] = sub
        elif isinstance(v, (int, float)):
            out[k] = _convert_currency(v, source_currency, display_currency, fx_rates)
        else:
            out[k] = v
    return out


def stage_council(doc: Dict[str, Any], parsed: Dict[str, Any],
                  assembled: Dict[str, Any]) -> Dict[str, Any]:
    """Advisory AI-council review of EXTRACTION INTEGRITY (added 2026-07-20).

    A panel of independent Claude personas — reconciliation / completeness /
    classification auditors — scans the freshly-assembled statements; a
    deterministic chair returns a consensus verdict (pass / warn / fail).

    Advisory by design: this stage NEVER blocks the pipeline and NEVER
    raises. Any failure (no API key, provider down, malformed output)
    degrades to the deterministic baseline inside `_ai_council.run_council`,
    which is itself exception-safe. The caller surfaces the verdict + any
    findings by appending `council_findings_as_alerts(...)` to
    `validation_alerts`, so they flow through the existing 'data_quality'
    alerts channel with no schema migration.

    Returns the full council result dict, or {} if the stage itself errors.
    """
    from . import _ai_council
    try:
        return _ai_council.run_council(assembled, parsed, document_id=doc.get("id"))
    except Exception:  # noqa: BLE001 — advisory stage must never break analysis
        logger.exception("[stage_council] failed (non-fatal)")
        return {}


def _briefing_grand_totals(assembled: Dict[str, Any],
                           bs_canonical: Dict[str, Any]) -> Dict[str, float]:
    """The four BS grand totals `stage_narrate`'s briefing_facts cites
    (total_assets / total_equity / total_liabilities / bs_balance_delta)
    — resolved through the sv1 FactsGateway so the briefing narrates the
    SERVED (reconciliation-adjusted) figures on BOTH paths:

      · WRITE TIME: `assembled` carries the canonical envelope at its
        top level, already mutated in place by stage_persist (provenance
        + any auto-reconcile receipt) — the gateway serves it exactly
        like /api/period will, so the FIRST briefing cites the same
        totals the dashboard renders (previously builder-fresh values:
        write-time vs regenerate diverged on reconciled periods).
      · REGENERATE: `_rebuild_assembled_for_briefing` already ran
        `_apply_envelope_truth_to_statements` (the same gateway) over
        the statements, so `bs_canonical` carries the served totals and
        `assembled` has no top-level envelope — the landed values pass
        through unchanged. Degenerate docs with no envelope at all
        (SKU-scope briefings) keep the builder values the same way.
    """
    out = {
        "total_assets": bs_canonical.get("total_assets", 0.0),
        "total_equity": bs_canonical.get("total_equity", 0.0),
        "total_liabilities": bs_canonical.get("total_liabilities", 0.0),
        "bs_balance_delta": bs_canonical.get("bs_balance_delta", 0.0),
    }
    try:
        _gw = _FactsGateway.from_envelope(assembled.get("assembled_canonical_v1") or {})
        if _gw is not None:
            out["total_assets"] = round(_gw.total_assets().to_float(), 2)
            out["total_equity"] = round(_gw.equity().to_float(), 2)
            out["total_liabilities"] = round(_gw.total_liabilities().to_float(), 2)
            out["bs_balance_delta"] = round(_gw.difference().to_float(), 2)
    except Exception:  # noqa: BLE001 — narration must never break on facts
        logger.exception("[stage_narrate] served grand-totals read failed (non-fatal)")
    return out


def _briefing_ratios(
    pl_canonical: Dict[str, Any],
    bs_canonical: Dict[str, Any],
    total_equity: Optional[float],
) -> Tuple[Dict[str, Optional[float]], Dict[str, str]]:
    """The `briefing_facts.ratios` block and the stated reason for every
    ratio in it that does not compute.

    These are citable numerals (`numerals.facts_from_briefing`), so a value
    here must be a measurement. It used to hold two substitutes: a zero or
    absent operating EBITDA divided as 1e-9 (debt 2,000,000 over no EBITDA
    served Debt/EBITDA 2e15x), and margins of 0.00% on zero or absent
    revenue (a loss of 150,000 on no revenue handed to the model as
    break-even). Each now refuses.
    """
    def num(v: Any) -> Optional[float]:
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            return None
        return float(v)

    # THE ONE EBITDA over TURNOVER (owner ruling 2026-09-26): net 711 and net
    # 72x inside EBITDA; every margin divides by cifra de afaceri netă
    # (70x − 709) — never by total operating revenue, which it used to.
    ebitda = num(pl_canonical.get("ebitda"))
    ebitda_refusal = pl_canonical.get("ebitda_refusal") if ebitda is None else None
    revenue = num(pl_canonical.get("turnover"))
    if revenue is None:
        revenue = num(pl_canonical.get("revenue"))
    net_income = num(pl_canonical.get("net_income_statutory"))
    # Absent debt or cash is absent — it used to be read as 0.0, which
    # served a citable Debt/EBITDA 0.0, Debt/Equity 0.0 and net debt 0.0
    # on a book that reported neither (and a TypeError on an explicit None).
    total_debt = num(bs_canonical.get("total_debt"))
    cash_val = num(bs_canonical.get("cash"))
    refusals: Dict[str, str] = {}

    refused_text = None
    if isinstance(ebitda_refusal, dict):
        refused_text = ("EBITDA refused: %s"
                        % (ebitda_refusal.get("text_en") or ebitda_refusal.get("code")))

    def margin(key: str, numerator: Optional[float], what: str) -> Optional[float]:
        if revenue is None:
            refusals[key] = "margin not computable: net turnover not reported"
            return None
        if revenue <= 0:
            refusals[key] = "margin not computable: no net turnover in this period"
            return None
        if numerator is None:
            refusals[key] = ("margin not computable: " + refused_text
                             if (what == "EBITDA" and refused_text)
                             else "margin not computable: %s not reported" % what)
            return None
        return round(100 * numerator / revenue, 2)

    ratios: Dict[str, Optional[float]] = {
        "ebitda_margin_pct": margin("ebitda_margin_pct", ebitda, "EBITDA"),
        "net_margin_pct": margin("net_margin_pct", net_income, "net income"),
    }
    if ebitda is None and refused_text:
        refusals["debt_to_ebitda"] = "Debt/EBITDA unavailable: " + refused_text
        ratios["debt_to_ebitda"] = None
    elif ebitda is None or ebitda == 0:
        refusals["debt_to_ebitda"] = (
            "Debt/EBITDA unavailable: EBITDA is zero or not reported for this period")
        ratios["debt_to_ebitda"] = None
    elif ebitda < 0:
        refusals["debt_to_ebitda"] = (
            "Debt/EBITDA unavailable: EBITDA is negative, so the multiple is not meaningful")
        ratios["debt_to_ebitda"] = None
    elif total_debt is None:
        refusals["debt_to_ebitda"] = "Debt/EBITDA unavailable: total debt not reported for this period"
        ratios["debt_to_ebitda"] = None
    else:
        ratios["debt_to_ebitda"] = round(total_debt / ebitda, 2)
    if total_debt is None:
        refusals["debt_to_equity"] = "Debt/Equity unavailable: total debt not reported for this period"
        ratios["debt_to_equity"] = None
    elif not total_equity:
        refusals["debt_to_equity"] = ("Debt/Equity unavailable: book equity is %s for this period"
                                      % ("not reported" if total_equity is None else "zero"))
        ratios["debt_to_equity"] = None
    else:
        ratios["debt_to_equity"] = round(total_debt / total_equity, 2)
    if total_debt is None or cash_val is None:
        missing = [n for n, v in (("total debt", total_debt), ("cash", cash_val)) if v is None]
        refusals["net_debt"] = "Net debt unavailable: %s not reported for this period" % " and ".join(missing)
        ratios["net_debt"] = None
    else:
        ratios["net_debt"] = round(total_debt - cash_val, 2)
    return ratios, refusals


def stage_narrate(doc: Dict[str, Any], assembled: Dict[str, Any], metrics: List[Dict[str, Any]],
                  org: Dict[str, Any], period_id: str,
                  parsed: Optional[Dict[str, Any]] = None,
                  valuation: Optional[Dict[str, Any]] = None,
                  display_currency: Optional[str] = None,
                  fx_rates: Optional[Dict[str, float]] = None) -> Dict[str, Any]:
    """Call Opus 4.7 with the metrics + industry context. Returns:
       { briefing: str, recommendations: [...], alerts: [...] }

    For non-financial documents (invoice register, sales analysis, product
    catalog) the prompt switches modes: instead of ratio-based CFO commentary,
    Claude describes what's in the document and surfaces the headline
    findings from `parsed.summary`.
    """
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        return {"briefing": "Set ANTHROPIC_API_KEY on the backend to enable AI narrative.", "recommendations": [], "alerts": []}

    try:
        from anthropic import Anthropic  # type: ignore
    except ImportError:
        return {"briefing": "anthropic SDK not installed on backend.", "recommendations": [], "alerts": []}

    # max_retries=5 covers transient Opus 529 overloads on the narrate stage.
    client = Anthropic(api_key=api_key, max_retries=5, timeout=180.0)

    industry_key = org.get("industry_key") or "generic"
    industry_display = org.get("industry_display_name") or industry_key

    accounts_count = len((parsed or {}).get("accounts") or [])
    detected_type = (parsed or {}).get("detected_type") or "unknown"
    is_financial = accounts_count > 0 or detected_type in (
        "trial_balance", "statutory_f30_f10", "bilant", "pl", "annual_report",
    )

    # Output language — explicit on document row, falls back to English. The
    # /api/pipeline/run endpoint stores the user's UI language onto
    # documents.detected_language when they trigger a run; later, the real
    # auto-detection stage (Phase 4 Step 2) will overwrite this from the
    # document itself, so an English UI user uploading a German Saldenliste
    # still gets German narrative.
    output_language = (doc.get("detected_language") or "en").lower()[:2]
    language_instructions = {
        "en": "Reply in English.",
        "ro": "Răspunde în limba română.",
        "de": "Antworten Sie auf Deutsch.",
        "fr": "Répondez en français.",
        "es": "Responde en español.",
        "it": "Rispondi in italiano.",
        "pt": "Responda em português.",
        "nl": "Antwoord in het Nederlands.",
        "pl": "Odpowiedz po polsku.",
    }
    lang_instruction = language_instructions.get(output_language, language_instructions["en"])

    # ── Display currency — drives both the FX-converted numbers in
    # briefing_facts AND the currency suffix the LLM uses in prose. The
    # source currency comes from the statements; display defaults to it
    # unless the regenerate endpoint passes an explicit override from
    # the user's TopHeader currency toggle (RON/EUR/USD).
    source_currency = (assembled["statements"].get("currency") or "RON").upper()
    effective_display = (display_currency or source_currency).upper()
    # Currency formatting hint — uses the display currency code, with
    # locale-appropriate thousand/decimal separators per the output language.
    _example_amount = "1,234,567" if output_language in ("en",) else (
        "1 234 567" if output_language == "fr" else "1.234.567"
    )
    currency_hint = (
        f"Numbers in {output_language.upper()} locale; cite currency as "
        f"'{effective_display}' (e.g. '{_example_amount} {effective_display}'). "
        f"Every monetary figure in `briefing_facts` is pre-converted to "
        f"{effective_display} — do NOT re-convert."
    )

    if is_financial:
        system = (
            "You are a senior CFO advising the management team of a European SME.\n"
            "You receive standardized financial statements and computed ratios.\n"
            "You DO NOT compute numbers — explain them in industry context.\n\n"
            "═══════════════════════════════════════════════════════════════\n"
            "CANONICAL FACTS — SINGLE SOURCE OF TRUTH\n"
            "═══════════════════════════════════════════════════════════════\n"
            "The user payload contains a `briefing_facts` block. Every\n"
            "headline number you cite in the briefing — revenue, EBITDA,\n"
            "net profit, total debt, equity, leverage, key ratios — MUST\n"
            "come from `briefing_facts` verbatim. Do NOT derive your own\n"
            "EBITDA from `income_statement.revenue − operatingExpenses` —\n"
            "that path drops capitalized own-work (account 722) and gives\n"
            "the wrong sign. The frontend, KPI tiles, P&L tab, and balance\n"
            "sheet all read the operating-view numbers; the briefing must\n"
            "match them or the dashboard contradicts itself.\n\n"
            "Specifically, when citing P&L numbers:\n"
            " - Revenue → `briefing_facts.turnover` (cifra de afaceri netă,\n"
            "   70x − 709; every margin is over this)\n"
            " - EBITDA → `briefing_facts.ebitda`. It INCLUDES the stock\n"
            "   variation (`briefing_facts.inventory_variation`, 711,\n"
            "   \"Variația stocurilor de produse\") and own work capitalised\n"
            "   (`briefing_facts.capitalized_own_work`, 72x). If\n"
            "   `briefing_facts.ebitda` is null, EBITDA is REFUSED —\n"
            "   `briefing_facts.ebitda_refusal` says why; say so, never\n"
            "   estimate one.\n"
            " - Net profit → `briefing_facts.net_income_statutory`\n"
            " - Total debt → `briefing_facts.total_debt`\n"
            " - Equity → `briefing_facts.total_equity`\n"
            " - Cash → `briefing_facts.cash`\n\n"
            # ── F3.16-3b.6 EBITDA RULE — binding constraint on prose ─────
            # Closes the Carniprod −6.87M briefing-prose problem (the LLM
            # combined PL line items to produce an EBITDA value that
            # appeared nowhere in the engine's canonical fields). Per
            # docs/F3.16-3b6-f42-hardening-plan.md §4 — the engine is the
            # source of truth; LLM prose may reference canonical fields
            # by name but MUST NOT compute new values.
            "EBITDA RULE — there is ONE EBITDA: `briefing_facts.ebitda`\n"
            "(equivalent to `methodology.ebitda.reported`). It includes the\n"
            "stock variation (711) and own work capitalised (72x); do NOT\n"
            "describe an EBITDA \"with\" or \"without\" either as a second\n"
            "view. DO NOT compute new EBITDA values in prose. Do NOT sum or\n"
            "transform PL line items to produce a different EBITDA. If EBITDA\n"
            "is refused (null, with `briefing_facts.ebitda_refusal`), state\n"
            "the refusal and its reason rather than approximating one.\n\n"
            "If `briefing_facts.ebitda > 0` you MUST NOT describe the\n"
            "company as posting an operating loss.\n\n"
            "CRITICAL: Apply industry-appropriate thresholds.\n"
            " - Real estate: 4-8× Debt/EBITDA is normal; do NOT recommend deleveraging below 8×.\n"
            " - SaaS: focus on rule-of-40, ARR growth, gross margin >70%.\n"
            " - FMCG: working-capital efficiency, inventory turn, thin margins are normal.\n"
            " - Manufacturing: capex intensity, fixed-cost leverage are normal.\n\n"
            "═══════════════════════════════════════════════════════════════\n"
            "INDUSTRY-APPROPRIATE LANGUAGE — STRICTLY ENFORCED\n"
            "═══════════════════════════════════════════════════════════════\n"
            "Recommendation titles, rationales, and actions MUST use the\n"
            "vocabulary of the company's actual industry. Generic templates\n"
            "(\"exit unprofitable SKUs/customers\", \"renegotiate top suppliers\",\n"
            "\"inventory turnover\", \"product line review\") map ONLY to\n"
            "distribution / retail / manufacturing. Misapplying them to a\n"
            "CRE vehicle (one tenant, one property, one mortgage) makes the\n"
            "output unusable and damages user trust.\n\n"
            "For `industry_key = real_estate_*`:\n"
            "  • There are NO \"SKUs\", NO \"customers\" in the retail sense,\n"
            "    NO \"inventory\", NO \"product lines\".\n"
            "  • Use: tenants, leases, rental income, the property itself,\n"
            "    property operating costs (utilities, insurance, maintenance,\n"
            "    property taxes, property management).\n"
            "  • Cost-reduction language: \"renegotiate property management\n"
            "    contract\", \"review property insurance renewals\", \"challenge\n"
            "    property tax assessment\" — NEVER \"renegotiate top suppliers\".\n"
            "  • Tenant management: \"renew lease early\", \"add CPI indexation\",\n"
            "    \"identify backup tenants\" — NEVER \"exit unprofitable customers\".\n\n"
            "DISTRESS LANGUAGE — only allowed when the genuine signal is present:\n"
            "  • DO NOT recommend \"engage a restructuring advisor\" unless\n"
            "    Altman Z\" (industry-appropriate variant) < 1.10 AND DSCR < 1.0.\n"
            "  • DO NOT recommend \"covenant waiver\" unless DSCR < 1.0.\n"
            "  • DO NOT recommend \"13-week cash forecast\" unless cash <\n"
            "    3 months of debt service.\n"
            "  • The platform reads `briefing_facts.ebitda` and\n"
            "    `briefing_facts.net_income_statutory` — both POSITIVE for a\n"
            "    healthy company. Don't claim \"negative EBITDA\" or \"operating\n"
            "    loss\" when those values are positive. Always cite the\n"
            "    statutory headline.\n\n"
            "VALUATION FRAMING — THIS IS NEW AND MANDATORY:\n"
            "When a `valuation` block is present in the user payload, treat the\n"
            "EBITDA-multiple equity (`valuation.equity_p50`, based on the peer P50\n"
            "multiple) as the company's headline equity value. Reference this\n"
            "single number in the briefing — do NOT invent another. The DCF and\n"
            "EV/Revenue numbers are cross-checks; mention divergence between them\n"
            "and the EBITDA multiple only when material (>30% spread).\n"
            " - You MUST NEVER produce a different valuation number than the one\n"
            "   in `valuation.equity_p50`. The engine is the source of truth.\n"
            " - If `valuation.confidence` is 'low' (negative EBITDA, thin margin,\n"
            "   or generic industry fallback), flag the confidence concern in the\n"
            "   briefing and add a recommendation to refine the inputs (capex,\n"
            "   working capital, industry classification) before the number is\n"
            "   used in a transaction context.\n"
            " - Always cite the source line — `valuation.multiples_source` and\n"
            "   `valuation.multiples_as_of_date` — so readers know which peer set.\n"
            " - Recommendations that talk about valuation must quantify in equity\n"
            "   value terms (e.g. 'a 10% EBITDA lift expands equity by X RON at\n"
            "   the current peer multiple').\n\n"
            f"LANGUAGE: {lang_instruction} {currency_hint}\n"
            "Translate industry terminology appropriately (e.g. Working capital → Betriebskapital / Fonds de roulement / Capital de lucru / Capital de trabajo).\n"
            "Briefing text, recommendation titles, rationales, actions — all in the output language.\n"
            "Be specific. Quantify recommendations in monetary terms when possible.\n"
            "Output STRICT JSON. No prose outside JSON. The first character of your reply must be '{'."
        )
    else:
        system = (
            "You are a senior CFO advisor reviewing a business document. The user uploaded\n"
            "a non-statement document (invoice register, sales analysis, product catalog,\n"
            "bank statement, etc.) — there is NO income statement or balance sheet to read.\n\n"
            "Your job:\n"
            "  1. Briefing (3 sentences): describe in concrete terms what the document IS,\n"
            "     what it covers, and what the most material rows / aggregates are. Use the\n"
            "     `summary` block in the input — row_count, headline_total, top_records.\n"
            "  2. Recommendations: 1–3 actionable next steps grounded in this specific\n"
            "     document. E.g. 'export accounts receivable aging from this register and\n"
            "     contact the top 3 overdue customers' or 'cross-check this sales analysis\n"
            "     against your trial balance to confirm revenue recognition'.\n"
            "  Do NOT generate alerts — the platform's deterministic rule registry handles\n"
            "  exception detection. Briefing + recommendations only.\n\n"
            "Do NOT fabricate revenue / EBITDA / ratios. Do NOT lecture about leverage.\n"
            f"LANGUAGE: {lang_instruction} {currency_hint}\n"
            "Output STRICT JSON. The first character of your reply must be '{'."
        )

    # ── Canonical briefing facts — single source of truth ─────────────────
    # The frontend's `usePeriodFacts()` hook, P&L tab, BS tab, KPI tiles,
    # and recommendation rules all read these exact fields from the
    # assembled canonical views. Surfacing them as `briefing_facts` (with
    # the same field names) lets the prompt above pin the briefing to the
    # same numbers and removes the prior drift between dashboard and
    # narrative.
    pl_canonical = assembled["statements"].get("assembled_pl", {}) or {}
    bs_canonical = assembled["statements"].get("assembled_bs", {}) or {}

    # sv1 — the four BS grand totals come from the FactsGateway (served,
    # reconciliation-adjusted truth), not the builder-fresh assembled_bs:
    # write-time briefings now cite the same figures /api/period serves.
    grand_totals = _briefing_grand_totals(assembled, bs_canonical)

    # ABSENT != ZERO: a missing or REFUSED EBITDA or turnover stays None
    # here (it used to default to 0.0, the same value as a measured zero).
    # THE ONE EBITDA over TURNOVER (owner ruling 2026-09-26).
    ebitda_one = pl_canonical.get("ebitda")
    turnover = pl_canonical.get("turnover", pl_canonical.get("revenue"))
    _inv = pl_canonical.get("inventory_variation")
    _cap = pl_canonical.get("capitalized_own_work")
    total_debt = bs_canonical.get("total_debt", 0.0)
    total_equity = grand_totals["total_equity"]
    cash_val = bs_canonical.get("cash", 0.0)
    briefing_ratios, briefing_ratio_refusals = _briefing_ratios(
        pl_canonical, bs_canonical, total_equity)

    briefing_facts_raw = {
        # P&L — the ONE definition (matches the P&L tab, KPI tiles, report,
        # benchmark and forecast). A refused EBITDA / operating result is
        # None with `ebitda_refusal` beside it — never 0.0.
        "turnover": turnover,
        "ebitda": ebitda_one,
        "operating_result": pl_canonical.get("operating_result"),
        "inventory_variation": (_inv.get("value") if isinstance(_inv, dict) else None),
        "capitalized_own_work": (_cap.get("value") if isinstance(_cap, dict) else None),
        "depreciation": pl_canonical.get("depreciation", 0.0),
        "interest_expense": pl_canonical.get("interest_expense", 0.0),
        "tax": pl_canonical.get("tax", 0.0),
        "net_income_statutory": pl_canonical.get("net_income_statutory", 0.0),
        # BS — closing balances (Solduri finale year-end convention);
        # grand totals are the SERVED, reconciliation-adjusted figures
        # (sv1 gateway — see _briefing_grand_totals).
        "total_assets": grand_totals["total_assets"],
        "total_equity": total_equity,
        "total_liabilities": grand_totals["total_liabilities"],
        "total_debt": total_debt,
        "lt_debt": bs_canonical.get("lt_debt", 0.0),
        "st_debt": bs_canonical.get("st_debt", 0.0),
        "cash": cash_val,
        "ar_net": bs_canonical.get("ar_net", 0.0),
        "ap_trade": bs_canonical.get("ap_trade", 0.0),
        "ap_dividends": bs_canonical.get("ap_dividends", 0.0),
        "intercompany_loans": bs_canonical.get("intercompany_loans", 0.0),
        "ppe_net": bs_canonical.get("ppe_net", 0.0),
        "ppe_under_construction": bs_canonical.get("ppe_under_construction", 0.0),
        "current_year_pnl": bs_canonical.get("current_year_pnl", 0.0),
        "bs_balance_delta": grand_totals["bs_balance_delta"],
        # Key derived ratios — operating-view based, so the briefing's
        # leverage / coverage commentary stays consistent with the tab.
        # A ratio that cannot be computed is None (numerals.facts_from_
        # briefing types it RatioFact(None), so it can never be cited).
        "ratios": briefing_ratios,
    }
    if ebitda_one is None and isinstance(pl_canonical.get("ebitda_refusal"), dict):
        _r = pl_canonical["ebitda_refusal"]
        briefing_facts_raw["ebitda_refusal"] = {
            "code": _r.get("code"), "text_en": _r.get("text_en"), "text_ro": _r.get("text_ro")}
    briefing_facts_raw["ebitda_definition"] = pl_canonical.get("ebitda_definition")
    if briefing_ratio_refusals:
        # Why each None ratio is None — the model reads the reason instead
        # of inventing a figure. Present only when something refused, so a
        # book whose ratios all compute sends the same payload as before.
        briefing_facts_raw["ratio_refusals"] = briefing_ratio_refusals
    # ── FX conversion ─────────────────────────────────────────────────
    # Convert every monetary value in briefing_facts from the source
    # currency (the trial balance's native currency, almost always RON)
    # to the user's display currency. Ratios + percentages stay as-is —
    # they're dimensionless. The LLM then narrates in the converted
    # currency, so toggling RON → EUR in the top bar produces a
    # regenerated briefing that says "€1,634,000 revenue" instead of
    # "8,121,590 RON revenue".
    briefing_facts = _convert_briefing_facts(
        briefing_facts_raw, source_currency, effective_display, fx_rates
    )

    user_payload = {
        "company": {
            "name": assembled["statements"].get("companyName"),
            "industry_key": industry_key,
            "industry_display_name": industry_display,
            # `currency` is the DISPLAY currency the briefing should cite
            # — already applied to every number in `briefing_facts`. The
            # original source currency is kept on `source_currency` for
            # auditability (e.g. "company filed in RON; report displays in EUR").
            "currency": effective_display,
            "source_currency": source_currency,
            "period_label": assembled["statements"].get("periodLabel"),
        },
        "document": {
            "filename": doc.get("original_filename"),
            "detected_type": detected_type,
            "accounts_extracted": accounts_count,
            "summary": (parsed or {}).get("summary") or {},
        },
        # CANONICAL — cite from here. Read the system prompt first.
        "briefing_facts": briefing_facts,
        "balance_sheet": assembled["statements"]["balanceSheet"],
        "income_statement": assembled["statements"]["incomeStatement"],
        # The narrator is a SURFACE (R-RANGE, absolute): persisted credit
        # rows reach it only under the law - a filed Z'' 1584.89 handed to
        # the model becomes a sentence about the company.
        "metrics": [
            {"name": m["name"], "value": m["value"], "unit": m["unit"], "direction": m["direction"]}
            for m in _credit_boundary.enforce_metric_rows(metrics, assembled["statements"])
        ],
        # Server-computed valuation. Briefing must reference equity_p50 and never
        # invent a different headline number. See VALUATION FRAMING in system.
        "valuation": (
            {
                "primary_method": valuation["primary_method"],
                "confidence": valuation["confidence"],
                "industry_key_used": valuation.get("industry_key_used"),
                "multiples_source": valuation["multiples_source"],
                "multiples_as_of_date": valuation["multiples_as_of_date"],
                "ebitda_used": valuation["ebitda_used"],
                "total_debt_used": valuation["total_debt_used"],
                "cash_used": valuation["cash_used"],
                "multiple_p25": valuation["multiple_ebitda_p25"],
                "multiple_p50": valuation["multiple_ebitda_p50"],
                "multiple_p75": valuation["multiple_ebitda_p75"],
                "equity_p25": valuation["equity_ebitda_p25"],
                "equity_p50": valuation["equity_ebitda_p50"],
                "equity_p75": valuation["equity_ebitda_p75"],
                "ev_revenue_equity_p50": valuation["ev_revenue_equity_p50"],
                "dcf_equity_value": valuation["dcf_equity_value"],
            }
            if valuation
            else None
        ),
        "schema": {
            "briefing": "3 sentences. Industry-aware. RON-denominated. Reference specific metrics from the input.",
            "recommendations": [
                {
                    "severity": "critical|high|medium|low",
                    "category": "financial|operational|data_quality",
                    "title": "string (8 words max)",
                    "rationale": "string (1-2 sentences explaining why)",
                    "actions": ["string action 1", "string action 2"],
                    "estimated_ron_impact": "number or null",
                    "metric_referenced": "name of the metric this is grounded in",
                }
            ],
            # NOTE: alerts are NOT generated by the LLM. The platform's
            # deterministic rule registry (stage_validate) is the single
            # source for alerts. LLMs produce briefing + recommendation
            # narrative only.
        },
    }

    try:
        resp = client.messages.create(
            model=_narrative_model(),
            max_tokens=4096,
            system=system,
            messages=[{"role": "user", "content": json.dumps(user_payload)}],
            output_config={"effort": "high"},
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("Opus narrate failed: %s", e)
        # NEVER surface the raw provider error as the briefing body — an
        # Anthropic billing refusal ended up rendered verbatim on the
        # operator's dashboard (2026-08-04). A sentinel the FE recognizes
        # (and a neutral fallback for API consumers) replaces it; the raw
        # error stays in the logs above.
        return {
            "briefing": "[NARRATIVE_UNAVAILABLE]",
            "recommendations": [],
            "alerts": [],
            "narrate_error": str(e)[:200],
        }

    text = "".join(getattr(b, "text", "") for b in resp.content if getattr(b, "type", None) == "text").strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.startswith("json"):
            text = text[4:]
        text = text.strip()
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return {"briefing": text[:500] or "Narrative unavailable.", "recommendations": [], "alerts": []}

    narrated = {
        "briefing": data.get("briefing", "Narrative unavailable."),
        "recommendations": data.get("recommendations", []) or [],
        "alerts": data.get("alerts", []) or [],
    }

    # ── THE AI BOUNDARY (engine.ai.numerals) ──────────────────────────
    # This is where model output becomes narrative the product ships:
    # `briefing` lands in the briefings table and `recommendations`
    # land — title, rationale and actions as free text — in the
    # recommendations table, which the UI renders verbatim. Alerts do
    # NOT come through here (stage_validate is their only source), so
    # this is the one seam where a model authors a digit the engine
    # then displays.
    #
    # The guard resolves `{fact_id}` placeholders against TYPED facts
    # and rejects any numeral the model wrote itself. DEFAULT MODE IS
    # `observe`: the payload passes through byte-identical and the
    # verdict is logged only — today's prompt still asks for literal
    # figures, so enforcing here would replace every live briefing.
    # Flipping AI_NUMERAL_GUARD=enforce is the ops action that lands
    # after the prompt moves to placeholder form; the fallback text is
    # deterministic and already in place.
    try:
        from engine.ai import numerals as _numerals

        narrated, _numeral_report = _numerals.guard_narrate_result(
            narrated,
            _numerals.facts_from_briefing(briefing_facts, effective_display),
        )
        if _numeral_report["fields_rejected"]:
            logger.warning(
                "[pipeline] narrative numeral guard (%s): %d/%d fields carry "
                "model-authored digits %s — doc=%s",
                _numeral_report["mode"], _numeral_report["fields_rejected"],
                _numeral_report["fields_checked"],
                _numeral_report["rejected_fields"], doc.get("id"),
            )
    except Exception:  # noqa: BLE001 — the boundary must never break narration
        logger.exception("[pipeline] numeral guard failed (non-fatal)")
    return narrated


def stage_persist_narrative(
    doc: Dict[str, Any],
    period_id: str,
    narrate: Dict[str, Any],
    validation_alerts: List[Dict[str, Any]],
) -> None:
    org_id = doc["org_id"]
    document_id = doc["id"]
    with _supabase.admin() as admin_client:
        # Defensive: if a concurrent DELETE /api/period/{id} removed the
        # period between stage_persist and now, every FK-bound write below
        # will 409. Detect that here and skip narrative persistence — the
        # pipeline reports success because the analysis itself completed,
        # the user just lost the briefing/recommendations layer.
        period_still_exists = admin_client.select(
            "financial_periods",
            filters={"id": f"eq.{period_id}"},
            single=True,
            columns="id",
        )
        if not period_still_exists:
            logger.warning(
                "[stage_persist_narrative] period %s vanished mid-pipeline (race with DELETE); "
                "skipping briefing/recommendations write",
                period_id,
            )
            return

        # Briefing — upsert one row per period
        admin_client.upsert(
            "briefings",
            {
                "period_id": period_id,
                "org_id": org_id,
                "body": narrate["briefing"],
                "language": "en",
                "model": _narrative_model(),
                # The EBITDA definition the prose was written under (owner
                # ruling 2026-09-26). Served beside the body so a briefing
                # written under an earlier definition is recognised and
                # hidden, never shown beside corrected numbers. Column added
                # by supabase/schema_phase_briefing_ebitda_definition.sql.
                "ebitda_definition": _EBITDA_DEFINITION_REVISION,
            },
            on_conflict="period_id",
            returning=False,
        )

        # Recommendations — wipe per-PERIOD, re-insert with period_id.
        #
        # Phase D-backend: the prior `delete WHERE org_id = ?` wiped EVERY
        # period's recommendations on every re-run, then re-inserted only
        # the current period's. Result: only the most-recently-analysed
        # period had recs; every other period's were silently wiped on
        # the next upload. The new scope is `WHERE period_id = ?` so a
        # re-run only replaces THIS period's recs; sibling periods are
        # untouched. The schema migration at
        # supabase/schema_phase_notes_period_scope.sql adds the period_id
        # column + index this query depends on.
        admin_client.delete("recommendations", filters={"period_id": f"eq.{period_id}"})
        recs = []
        for r in narrate["recommendations"]:
            actions = r.get("actions") or []
            explanation = r.get("rationale", "") + ("\n\nActions:\n• " + "\n• ".join(actions) if actions else "")
            urgency_map = {"critical": "critical", "high": "high", "medium": "medium", "low": "low"}
            severity = (r.get("severity") or "medium").lower()
            recs.append({
                "org_id": org_id,
                "period_id": period_id,
                "target_type": "dataset",
                "target_id": str(period_id),
                "title": r.get("title", "Untitled recommendation"),
                "explanation": explanation,
                "expected_cash_impact_kron": r.get("estimated_ron_impact"),
                "urgency": urgency_map.get(severity, "medium"),
                "status": "new",
            })
        if recs:
            admin_client.insert("recommendations", recs, returning=False)

        # ── Alerts — DETERMINISTIC rules only (read from canonical views) ──
        # LLM-generated alerts are NO LONGER persisted. The "15 duplicate
        # critical alerts" problem came from the LLM emitting many slight
        # variations of the same concern, each landing as a fresh row.
        # `stage_validate` is now the single source — each rule has a
        # unique rule_key, structurally deduped before this step.
        #
        # Phase D-backend: dedup scope is now (period_id, alert_key), not
        # (org_id, alert_key). The pre-D-backend setup had alerts as
        # org-scoped rows — `/api/period/:id` then returned the union of
        # every period's alerts on every period view, producing the
        # "80 on file" duplicate pile the user reported. Now:
        #
        #   1. DELETE every alert for THIS period_id before inserting
        #      (covers re-runs and old document_ids that previously
        #      attached to this period via documents.period_id).
        #   2. INSERT the deduped set with period_id stamped on each
        #      row, with a (period_id, alert_key) unique constraint
        #      enforcing idempotency at the DB level.
        #
        # The schema migration that adds `period_id` + the new unique
        # is at supabase/schema_phase_notes_period_scope.sql — both
        # must ship together.
        admin_client.delete("alerts", filters={"period_id": f"eq.{period_id}"})

        rows: List[Dict[str, Any]] = []
        seen_keys: set[str] = set()
        # validation_alerts already came from stage_validate deduped — but
        # double-check at the persist boundary in case a callsite added more.
        for a in validation_alerts:
            key = a.get("alert_key")
            if not key or key in seen_keys:
                continue
            seen_keys.add(key)
            severity = (a.get("severity") or "medium").lower()
            if severity not in ("critical", "high", "medium", "low", "info"):
                severity = "medium"
            category = (a.get("category") or "data_quality").lower()
            # `risk_inventory` is the Section-7 category — 5-8 named structural
            # risks the deterministic engine identifies (receivables quality,
            # liquidity tightness, raw-material exposure, etc.). Added to the
            # allowlist alongside the existing categories so the FE can filter
            # to it for the Comprehensive Report's risk inventory section.
            if category not in ("liquidity", "leverage", "margin", "inventory", "compliance",
                                 "data_quality", "working_capital", "customer", "supplier",
                                 "opportunity", "risk_inventory"):
                category = "data_quality"
            # Carry facts_cited + industry on the payload column for the
            # FE's "Facts backing this alert" expander.
            rows.append({
                "org_id": org_id,
                "period_id": period_id,
                "alert_key": key,
                "severity": severity,
                "category": category,
                "title": a.get("title", "Untitled alert"),
                "body": a.get("body", ""),
                "document_id": document_id,
                "payload": {
                    "rule_key": a.get("rule_key"),
                    "facts_cited": a.get("facts_cited"),
                    "industry": a.get("industry"),
                    # Typed placeholders (2026-08-30). `*_template` carry
                    # `{{money:<fact>}}` in place of every cited money
                    # figure AND its currency label, so the renderer puts
                    # every figure in one claim through one money path.
                    # `fact_units` ends the guessing ("≥1000 is money",
                    # "|v|>1 is money") that renders a leverage multiple
                    # as a currency amount. All four keys are optional —
                    # a row without them falls back to `title` / `body`.
                    "title_template": a.get("title_template"),
                    "body_template": a.get("body_template"),
                    "fact_units": a.get("fact_units"),
                    "source_currency": a.get("source_currency"),
                },
            })
        if rows:
            admin_client.upsert("alerts", rows, on_conflict="period_id,alert_key", returning=False)


# ─── Orchestrator ───────────────────────────────────────────────────────────


def _run_sales_dataset_pipeline(doc: Dict[str, Any]) -> Optional[str]:
    """Branch for trading-analysis / sales XLSX uploads. Reads the workbook
    via openpyxl, persists native-granularity rows into sku_lines, rolls up
    into sku_aggregates, classifies via the engine, and creates the
    sales_datasets row that ties it all together.

    Returns the new dataset_id on success, None when the file isn't sales-
    shaped (caller falls back to the generic LLM-summary path).
    """
    from . import _supabase
    from ._sales_extract import (
        aggregate_sku_lines,
        extract_category_dio,
        extract_category_dio_from_analysis_sheet,
        is_sales_dataset,
        stream_sales_rows,
    )
    from ._sku_classify import classify_portfolio

    # Mint a signed URL + download the bytes so openpyxl can read them.
    with _supabase.admin() as ac:
        signed = ac.signed_url("documents", doc["storage_path"],
                               org_id=doc.get("org_id"), expires_in=300)
    r = httpx.get(signed, timeout=60.0)
    r.raise_for_status()
    xlsx_bytes = r.content

    detected, info = is_sales_dataset(xlsx_bytes)
    if not detected or not info:
        return None

    # Stream rows + materialize so we can both insert AND aggregate.
    lines = list(stream_sales_rows(xlsx_bytes, info))
    if not lines:
        return None

    period_label = info.get("period_label") or "Imported dataset"

    with _supabase.admin() as ac:
        # 1. sales_datasets row (upsert on document_id — re-running for the
        # same doc replaces the dataset).
        existing = ac.select("sales_datasets", filters={"document_id": f"eq.{doc['id']}"}, single=True)
        if existing:
            dataset_id = existing[0]["id"]
            ac.update("sales_datasets", {
                "label": period_label,
                "source_filename": doc["original_filename"],
                "row_count": len(lines),
            }, filters={"id": f"eq.{dataset_id}"})
            ac.delete("sku_lines", filters={"dataset_id": f"eq.{dataset_id}"})
            ac.delete("sku_aggregates", filters={"dataset_id": f"eq.{dataset_id}"})
        else:
            inserted = ac.insert("sales_datasets", {
                "org_id": doc["org_id"],
                "document_id": doc["id"],
                "label": period_label,
                "source_filename": doc["original_filename"],
                "row_count": len(lines),
                "is_active": True,
            }, returning=True)
            dataset_id = inserted[0]["id"]

        # 2. sku_lines — batched insert.
        #
        # CRITICAL: PostgREST's bulk-insert endpoint (`POST /sku_lines`
        # with an array body) requires every object in the array to have
        # the SAME key set — error PGRST102 "All object keys must match"
        # otherwise. Previously this code did `{k: v for k, v in line.items()
        # if v is not None}` which stripped Nones row-by-row, producing
        # heterogeneous shapes and triggering a PGRST102 on every batch.
        # The pipeline then fell back to per-row inserts (~400 sequential
        # HTTP round-trips) and stalled the upload for minutes.
        #
        # Fix: build a stable UNION key set across all rows, then fill
        # missing keys with explicit None on every row. PostgREST accepts
        # explicit nulls as long as the keys are uniform.
        # `inventory_value` and `cogs` are parser-only fields driving the
        # DIO calculation; they are aggregated server-side BEFORE the
        # per-line insert. Excluded here so the sku_lines table schema
        # (which doesn't carry these columns) keeps accepting bulk
        # inserts. The aggregator below still sees them on the in-memory
        # `lines` list.
        _LINE_INSERT_EXCLUDE = {"inventory_value", "cogs"}
        raw_rows = [
            {
                "dataset_id": dataset_id,
                "org_id": doc["org_id"],
                **{k: v for k, v in line.items() if k not in _LINE_INSERT_EXCLUDE},
            }
            for line in lines
        ]
        all_keys: set[str] = set()
        for row in raw_rows:
            all_keys.update(row.keys())
        line_rows = [
            {k: row.get(k) for k in all_keys}
            for row in raw_rows
        ]
        BATCH = 200
        inserted = 0
        for i in range(0, len(line_rows), BATCH):
            batch = line_rows[i:i+BATCH]
            try:
                ac.insert("sku_lines", batch, returning=False)
                inserted += len(batch)
            except Exception as e:  # noqa: BLE001
                logger.warning("[sales] batch %d failed, falling back per-row: %s", i // BATCH, e)
                for row in batch:
                    try:
                        ac.insert("sku_lines", row, returning=False)
                        inserted += 1
                    except Exception as e2:  # noqa: BLE001
                        logger.warning("[sales] dropped row product=%r reason=%s", row.get("product_name"), e2)
        logger.info("[sales] inserted %d/%d sku_lines into dataset %s", inserted, len(line_rows), dataset_id)

        # 3. Aggregate + classify.
        # Per-category DIO is read from TWO possible sources, preferring
        # the operator-set targets in the Analysis sheet over the
        # computed actuals in the standalone DIO sheet's Region 2:
        #
        #   1. Analysis sheet (cols 60-63 in Trading_analysis_*.xlsx) —
        #      operator-chosen realistic targets like LEGUME=60d,
        #      JELEURI=180d. Built by the analyst when reasoning about
        #      working capital, so they reflect business reality.
        #   2. DIO sheet Region 2 — naive (inventory ÷ COGS × 365)
        #      computations that can produce extreme outliers
        #      (JELEURI=1001.7d ≈ 3 years), useful only when the
        #      Analysis sheet doesn't carry a value for that category.
        #
        # The dicts are merged with Analysis winning per-key; DIO sheet
        # entries fill in any categories the Analysis sheet missed.
        # Both downstream paths (aggregate_sku_lines fallback chain,
        # FE category-card display) just see one merged dict.
        analysis_dio_map = extract_category_dio_from_analysis_sheet(xlsx_bytes)
        dio_sheet_map = extract_category_dio(xlsx_bytes)
        category_dio_map = {**dio_sheet_map, **analysis_dio_map}
        logger.info(
            "[sales] category DIO sourced: analysis_sheet=%d cats, dio_sheet=%d cats, merged=%d cats",
            len(analysis_dio_map), len(dio_sheet_map), len(category_dio_map),
        )
        agg_rows = aggregate_sku_lines(lines, category_dio=category_dio_map)
        # classify_portfolio expects 'sku' + 'revenue' keys; bridge to its API.
        for a in agg_rows:
            a["sku"] = a["product_name"]
            a["revenue"] = a["niv_krn"]
            a["cogs"] = max(0.0, (a["niv_krn"] or 0) - (a["gm_krn"] or 0))
        classified = classify_portfolio(agg_rows)

        agg_inserts = [{
            "dataset_id": dataset_id,
            "org_id": doc["org_id"],
            "product_name": c["product_name"],
            "brand": c.get("brand"),
            "category": c.get("category"),
            "volume_tons": c.get("volume_tons"),
            "niv_krn": c.get("niv_krn"),
            "gm_krn": c.get("gm_krn"),
            "gm_pct": c.get("gm_pct"),
            "real_margin_krn": c.get("real_margin"),
            "real_margin_pct": c.get("real_margin_pct"),
            # DIO inputs + output (optional). Files without inventory/
            # COGS columns yield None across all three → DIO null → FE
            # renders "not available" honestly. The `sku_aggregates`
            # table's `inventory_value_krn` / `cogs_krn` /
            # `days_inventory_on_hand` columns are nullable; this
            # insertion is therefore backward-compatible with the
            # previous Products upload format. `cogs_krn` is included
            # so the WC roll-up panel can compute company DIO as
            # sum(inv) / sum(cogs) * 365 (the spec's preferred formula)
            # rather than a weighted-average fallback.
            "inventory_value_krn": c.get("inventory_value_krn"),
            "cogs_krn": c.get("cogs_krn"),
            "days_inventory_on_hand": c.get("days_inventory_on_hand"),
            "classification": c.get("classification") or "keep",
            "classification_reason": c.get("classification_reason"),
            "line_row_count": c.get("line_row_count"),
            "channels_present": c.get("channels_present") or [],
            "clients_present": c.get("clients_present") or [],
        } for c in classified]
        any_dio_drops_this_upload = False
        for i in range(0, len(agg_inserts), 400):
            try:
                ac.insert("sku_aggregates", agg_inserts[i:i+400], returning=False)
            except Exception as e:  # noqa: BLE001
                # Defensive: if the deployed schema is older and lacks
                # the inventory_value_krn / days_inventory_on_hand
                # columns, retry the chunk WITHOUT those fields rather
                # than failing the whole upload. This guarantees
                # backward-compatibility on environments that haven't
                # yet had the (nullable) DIO columns added.
                msg = str(e).lower()
                if (
                    "inventory_value_krn" in msg
                    or "cogs_krn" in msg
                    or "days_inventory_on_hand" in msg
                ):
                    fallback = [
                        {k: v for k, v in row.items()
                         if k not in (
                             "inventory_value_krn",
                             "cogs_krn",
                             "days_inventory_on_hand",
                         )}
                        for row in agg_inserts[i:i+400]
                    ]
                    ac.insert("sku_aggregates", fallback, returning=False)
                    # 2026-05-26 — loud-failure plumbing. The defensive
                    # retry preserved the upload but silently dropped
                    # every DIO value, and the warning scrolled past in
                    # the log noise for weeks. Now we ALSO mark the
                    # service as degraded so /api/health surfaces it
                    # and the FE shows a banner. Operator runs the SQL
                    # migration → flag clears on the next clean upload.
                    any_dio_drops_this_upload = True
                    _record_dio_drop(
                        dataset_id=dataset_id,
                        rows_dropped=len(fallback),
                        first_error=str(e)[:300],
                    )
                    logger.error(
                        "[sales] DIO PERSISTENCE DEGRADED — sku_aggregates "
                        "is missing days_inventory_on_hand / inventory_value_krn / "
                        "cogs_krn columns. Inserted %d rows WITHOUT DIO. "
                        "Run supabase/schema_phase_sku_dio_columns.sql to fix. "
                        "Dataset=%s. PostgREST error: %s",
                        len(fallback), dataset_id, str(e)[:300],
                    )
                else:
                    raise

        ac.update("sales_datasets", {"sku_count": len(agg_inserts)},
                  filters={"id": f"eq.{dataset_id}"})

        # Clean upload — clears the degraded flag so /api/health flips
        # back to ok and the FE banner disappears on next poll. Operator
        # has run the schema migration; the silent-drop path is gone.
        if not any_dio_drops_this_upload:
            reset_dio_persistence_state()

    return dataset_id


def _persist_sku_analysis(doc: Dict[str, Any], parsed: Dict[str, Any], narrative: Dict[str, Any]) -> None:
    """Persist a SKU analysis + classified per-SKU rollups.

    SKU/inventory uploads (XLSX trading analysis, sales-by-product exports,
    invoice registers) are intentionally separate from the financial-statement
    data model — they should never appear on Dashboard / Cash / Profit.

    Two writes per upload:
      1. sku_analyses (one row per document) — briefing + recommendations
      2. sku_aggregates (N rows) — engine-classified per-SKU rollups
    """
    from ._sku_classify import classify_portfolio

    raw_skus = parsed.get("skus") or []
    classified = classify_portfolio(raw_skus)
    period_label = parsed.get("period_label") or "Imported period"

    with _supabase.admin() as client:
        client.upsert(
            "sku_analyses",
            {
                "org_id": doc["org_id"],
                "document_id": doc["id"],
                "briefing": narrative.get("briefing", ""),
                "summary": parsed.get("summary") or {},
                "recommendations": narrative.get("recommendations") or [],
                "language": "en",
                "model": _narrative_model(),
            },
            on_conflict="document_id",
            returning=False,
        )

        # Legacy: the OLD sku_aggregates table was keyed on document_id +
        # produced from the LLM's synthetic category roll-ups. After the
        # sales-dataset refactor the table is keyed on dataset_id and is
        # populated by _run_sales_dataset_pipeline directly. _persist_sku_
        # analysis no longer manages sku_aggregates — it only writes the
        # briefing/summary into sku_analyses. The deletes below are a no-op
        # in the new schema (we skip them).
        if False and classified:  # legacy path retained as dead code for clarity
            rows = [
                {
                    "org_id": doc["org_id"],
                    "document_id": doc["id"],
                    "period_label": period_label,
                    "sku": s.get("sku"),
                    "brand": s.get("brand"),
                    "category": s.get("category"),
                    "channel": s.get("channel"),
                    "volume": s.get("volume"),
                    "volume_unit": s.get("volume_unit") or "tons",
                    "units_sold": s.get("units_sold"),
                    "revenue": s.get("revenue") or 0,
                    "cogs": s.get("cogs") or 0,
                    "gross_margin": s.get("gross_margin"),
                    "gross_margin_pct": s.get("gross_margin_pct"),
                    "real_margin": s.get("real_margin"),
                    "real_margin_pct": s.get("real_margin_pct"),
                    "inventory_value": s.get("inventory_value") or 0,
                    "days_inventory_on_hand": s.get("days_inventory_on_hand"),
                    "capital_tied_up": s.get("capital_tied_up"),
                    "classification": s.get("classification") or "keep",
                    "classification_reason": s.get("classification_reason"),
                    "classification_confidence": s.get("classification_confidence"),
                }
                for s in classified
            ]
            for i in range(0, len(rows), 500):
                client.insert("sku_aggregates", rows[i:i+500], returning=False)


# ── The reservation ledger — every reservation settles exactly once ──────
#
# WHERE THE OWNER'S 51 CAME FROM (2026-09-21). `user_usage.uploads` — the
# number behind "documents used" and behind the meter's `uploads + reserved
# < cap` guard — was bumped TWICE per successful upload and ONCE per failed
# one, and once more for every re-run of an already-counted document:
#
#   1. `POST /api/pipeline/run` called the legacy soft counter
#      `_usage_limits.record_usage(user_id, "upload")` → `increment_user_usage`
#      → uploads + 1, at ENQUEUE time: before the analysis, for failures and
#      for re-uploads of the same file alike (the firm landing did the same);
#   2. the terminal `commit_user_upload` RPC → uploads + 1 again on success;
#   3. `/api/pipeline/retry`, the period-move correction re-run and the
#      stuck-SKU watchdog reserve NOTHING by design ("a correction must not
#      consume quota"), yet their terminal still ran `commit_user_upload`
#      (uploads + 1) and — when the row still carried `metered_extra` from
#      its first run — bumped `extra_docs_billed_period` and asked Stripe to
#      meter it again; a failed re-run RELEASED a reservation it never took,
#      stealing another upload's.
#
# So the count moved ~2 per book, the 402 extra-document dialog opened long
# before the plan's included documents were used, and every confirmed
# "extra" was a document the user already had. The legacy bump is gone (the
# V3 commit is the one counter), and a terminal now settles only what ITS
# run reserved: the entry below is written where the reservation is made
# (/run, recover-stuck, the watchdog, the firm landing, the non-RO gate) and
# taken exactly once here. No entry → nothing to settle. A re-run of a
# document that holds NO analysis yet (/retry or a move-period correction
# after a failed first run) is that document's first successful analysis
# and reserves like /run (`_start_rerun`) — only an analysed document's
# re-run is free.
#
# The in-process entry is what the run's own terminal settles; every
# reservation is ALSO written to the document's row of the server-only quota
# ledger (`_quota_ledger`, verifier lens S, S8, 2026-09-21). A restart
# mid-run kills the daemon thread and loses the in-process entry; the slot
# used to stay in `user_usage.uploads_reserved` — counted against the cap —
# for the rest of the month, and `scripts/recompute_document_quota.py` did
# NOT reconcile it (it left the current month's reservations alone). Now
# the document's next run ADOPTS the orphaned reservation
# (`_meter_first_analysis`), and a reservation whose owner stopped
# heartbeating is released by the ledger's sweep
# (`start_quota_ledger_maintenance`) and by the restore script.


class _QuotaRun:
    __slots__ = ("user_id", "was_extra", "doc_reserved", "month", "reservation_id",
                 "nonro_user", "nonro_reserved", "nonro_extra", "nonro_month")

    def __init__(self) -> None:
        self.user_id: Optional[str] = None
        self.was_extra = False
        self.doc_reserved = False
        #: The month the reservation was made in — where it settles.
        self.month: Optional[str] = None
        #: The ledger row's `reservation_id` this run holds — the
        #: settlement's compare-and-set key (`_quota_ledger.mark_settling`).
        self.reservation_id: Optional[str] = None
        self.nonro_user: Optional[str] = None
        self.nonro_reserved = False
        self.nonro_extra = False
        self.nonro_month: Optional[str] = None


_QUOTA_RUNS: Dict[str, _QuotaRun] = {}
_QUOTA_RUNS_LOCK = threading.Lock()


def _register_quota_run(document_id: str, *, user_id: str, was_extra: bool,
                        month: Optional[str] = None,
                        reservation_id: Optional[str] = None) -> bool:
    """Record that THIS run of `document_id` holds a document-slot
    reservation made under the verified `user_id` in `month` (default: now)
    — in process, for the run's own terminal, and in the quota ledger, for
    a restart.

    Returns False — holding NOTHING: the slot just reserved is given back to
    the meter and the in-process entry dropped — when the document's ledger
    row already carries an OUTSTANDING reservation (P2-B, 2026-09-26): a
    colleague's run of this document that a restart orphaned, or one in
    flight in another container. The record used to overwrite that row,
    and the colleague's slot leaked for the month; adopting it instead
    would charge the colleague for this caller's run. The caller refuses
    the run (409 `reservation_outstanding`); the sweep frees the orphan.

    `reservation_id`: the ledger reservation this run ALREADY holds — a
    confirmed extra's (recorded by the confirm) or an adopted orphan's
    (`_quota_ledger.adopt`): registered as the run's own, never recorded a
    second time."""
    from . import _usage_gate as _ug
    month = month or _ug._month_bucket()
    with _QUOTA_RUNS_LOCK:
        run = _QUOTA_RUNS.setdefault(str(document_id), _QuotaRun())
        run.user_id = str(user_id)
        run.was_extra = bool(was_extra)
        run.doc_reserved = True
        run.month = month
    if reservation_id:
        with _QUOTA_RUNS_LOCK:
            run = _QUOTA_RUNS.get(str(document_id))
            if run is not None:
                run.reservation_id = str(reservation_id)
        return True
    rid = _quota_ledger.record_reservation(str(document_id), user_id=str(user_id),
                                           was_extra=bool(was_extra), month=month)
    if isinstance(rid, _quota_ledger.Outstanding):
        with _QUOTA_RUNS_LOCK:
            _QUOTA_RUNS.pop(str(document_id), None)
        _ug.release_document(str(user_id), was_extra=bool(was_extra), month=month)
        logger.warning(
            "[pipeline][quota] document %s: its ledger row holds an outstanding reservation of user "
            "%s (%s) — this run's slot was given back, the run is not started",
            document_id, rid.user_id, rid.row.get("reservation_id"))
        return False
    with _QUOTA_RUNS_LOCK:
        run = _QUOTA_RUNS.get(str(document_id))
        if run is not None:
            run.reservation_id = rid
    return True


def _register_nonro_reservation(document_id: str, *, user_id: str, was_extra: bool) -> None:
    """The non-RO gate reserved its meter mid-run; settle it with the run."""
    from . import _usage_gate as _ug
    month = _ug._month_bucket()
    with _QUOTA_RUNS_LOCK:
        run = _QUOTA_RUNS.setdefault(str(document_id), _QuotaRun())
        run.nonro_user = str(user_id)
        run.nonro_reserved = True
        run.nonro_extra = bool(was_extra)
        run.nonro_month = month
    _quota_ledger.record_nonro_reservation(str(document_id), user_id=str(user_id),
                                           was_extra=bool(was_extra), month=month)


def _release_run_reservation(document_id: str, run: Optional["_QuotaRun"]) -> None:
    """Give back what a run that will not settle normally holds (refused,
    errored before its hand-off, a failed landing): the meter, in the month
    each reservation was made in, and its ledger row."""
    if run is None:
        return
    from . import _usage_gate as _ug
    if run.doc_reserved or run.nonro_reserved:
        _quota_ledger.mark_settling(str(document_id), reservation_id=run.reservation_id)
    if run.doc_reserved and run.user_id:
        _ug.release_document(run.user_id, was_extra=run.was_extra, month=run.month)
    if run.nonro_reserved and run.nonro_user:
        _ug.release_nonro_document(run.nonro_user, was_extra=run.nonro_extra, month=run.nonro_month)
    _quota_ledger.record_release(str(document_id))


def _reservation_is_live(document_id: str) -> bool:
    """Does THIS process hold `document_id`'s reservation — a run in flight
    or in the in-process ledger, or a confirmed-extra grant? The ledger's
    sweep never releases one that does."""
    from . import _usage_gate as _ug
    key = str(document_id)
    with _QUOTA_RUNS_LOCK:
        if key in _QUOTA_RUNS:
            return True
    return (_doc_dedupe.in_flight(key) is not None or _ug.has_extra_grant(key)
            or _quota_ledger.is_pending(key))


def _live_reservation_ids() -> List[str]:
    """Every document whose reservation this process holds (heartbeat)."""
    from . import _usage_gate as _ug
    with _QUOTA_RUNS_LOCK:
        ids = [k for k, r in _QUOTA_RUNS.items() if r.doc_reserved or r.nonro_reserved]
    return ids + _ug.granted_document_ids() + _quota_ledger.pending_ids()


def _orphan_analysis_finished(document_id: str) -> bool:
    """Did the orphaned run's analysis FINISH — the document analysed and
    not an archived duplicate — so that only its settlement was lost?"""
    try:
        with _supabase.admin() as ac:
            found = ac.select("documents", filters={"id": f"eq.{document_id}"}, single=True) or []
    except Exception:  # noqa: BLE001 — unknown: released, never charged
        logger.exception("[pipeline] orphan settlement: could not read document %s", document_id)
        return False
    doc = dict(found[0]) if found else {}
    return (str(doc.get("status") or "").lower() == "analyzed"
            and not _doc_dedupe.is_archived_duplicate(doc) and not doc.get("deleted_at"))


def _settle_orphaned_reservation(row: Dict[str, Any]) -> None:
    """The quota ledger's sweep found `row`'s reservation orphaned (its
    owning process stopped heartbeating; nothing here holds it). Settle it
    as the dead run's terminal would have:

      * the analysis never finished → released (`_quota_ledger.release_rpcs`);
      * the analysis FINISHED and only the settlement was lost (the restart
        landed between `analyzed` and `_commit_pipeline_quota`) → settled
        as a SUCCESS through the one settlement — re-hydrated from the row —
        with its backstops: an archived duplicate, or a book already counted
        (a later run of it, a re-upload), is released, never counted twice.
        Releasing it would have left a book the banner counts and the meter
        never did (verifier lens S, the restart fix's "not analysed");
      * the row reads SETTLING (`_quota_ledger.is_settling`: reserved,
        stamped, not committed) → NOTHING. Its owner had begun moving the
        meter — a commit that landed with its record lost, or a release —
        and the restart came before the record. The meter may already have
        moved; releasing or committing it here is the double count / the
        double `record_metered_extra_doc` (P1 RESTART, second shape). Logged
        at ERROR for scripts/recompute_document_quota.py. The sweep never
        hands such a row here (it skips them before claiming); this is the
        guard for any other caller."""
    doc_id = str(row.get("document_id") or "")
    if _quota_ledger.is_settling(row):
        logger.error("[pipeline][billing] quota: REFUSED to settle the orphaned reservation of %s — "
                     "it was SETTLING when its owner died (reservation %s, user=%s month=%s "
                     "extra=%s): the meter may already have moved. Left for the restore script.",
                     doc_id, row.get("reservation_id"), row.get("user_id"), row.get("month"),
                     bool(row.get("was_extra")))
        return
    if not doc_id or not _orphan_analysis_finished(doc_id):
        _quota_ledger.release_rpcs(row)
        return
    run = _QuotaRun()
    run.user_id = str(row.get("user_id") or "") or None
    run.was_extra = bool(row.get("was_extra"))
    run.doc_reserved = bool(run.user_id)
    run.month = row.get("month") or None
    run.reservation_id = str(row.get("reservation_id") or "") or None
    if row.get("nonro_reserved_at") and row.get("nonro_user_id"):
        run.nonro_user = str(row.get("nonro_user_id"))
        run.nonro_reserved = True
        run.nonro_extra = bool(row.get("nonro_was_extra"))
        run.nonro_month = row.get("nonro_month") or None
    with _QUOTA_RUNS_LOCK:
        if doc_id in _QUOTA_RUNS:
            return  # a run of it in this process holds its own reservation
        _QUOTA_RUNS[doc_id] = run
    logger.warning("[pipeline] quota: settling the orphaned reservation of %s as the success its "
                   "finished analysis was (user=%s month=%s extra=%s)", doc_id, run.user_id,
                   run.month, run.was_extra)
    _commit_pipeline_quota(doc_id, success=True)


def start_quota_ledger_maintenance() -> bool:
    """Heartbeat this process's reservations and settle the ones a dead
    process left behind (`_quota_ledger.start_maintenance`,
    `_settle_orphaned_reservation`). Started once by `server.create_app`."""
    return _quota_ledger.start_maintenance(live_ids=_live_reservation_ids,
                                           is_live=_reservation_is_live,
                                           settle=_settle_orphaned_reservation)


def _doc_slot_holder(document_id: str) -> Optional[str]:
    """The verified user THIS run's document-slot reservation was made
    for, or None when the run holds none (a re-run / an unmetered run)."""
    with _QUOTA_RUNS_LOCK:
        run = _QUOTA_RUNS.get(str(document_id))
        if run is not None and run.doc_reserved and run.user_id:
            return run.user_id
    return None


def _take_quota_run(document_id: str) -> Optional[_QuotaRun]:
    with _QUOTA_RUNS_LOCK:
        return _QUOTA_RUNS.pop(str(document_id), None)


def _commit_pipeline_quota(document_id: str, *, success: bool) -> None:
    """Pricing V3 (refined-spec gap D) — settle THIS run's reservations:
    a consumed slot on success, a release on failure. Exactly once: the
    ledger entry is taken here, so a second call is a no-op, and a run that
    reserved nothing (the re-run of an analysed document) settles nothing.

    Success is the RUN's outcome (`_run_pipeline_stages` returned
    "analyzed"), never a column the browser can write. It is refused —
    released, never committed or billed — when this process archived the
    document as a duplicate while it ran (`_doc_dedupe.archived_here`): a
    duplicate or a failure is never counted and `record_metered_extra_doc`
    is never called for one.

    WHO is charged is the verified caller the reservation was made for (the
    ledger), not `documents.uploaded_by`, which the browser writes.

    Best-effort: any failure here is LOGGED but never re-raised. Quota
    correctness is downstream of user-visible analysis state, not the other
    way around.
    """
    from . import _usage_gate as _ug
    run = _take_quota_run(document_id)
    if run is None:
        logger.info(
            "[pipeline] quota: no reservation recorded for this run of %s — "
            "nothing to settle (retry / correction re-run / unmetered)", document_id,
        )
        return
    if not _ug.enforcement_enabled():
        _quota_ledger.record_release(document_id)
        return
    try:
        # A success is refused — released, never committed or billed — when
        # THIS process archived the document as a duplicate (a retry or the
        # watchdog archiving a run in flight). The run's own outcome decides
        # success; nothing browser-writable on the row can turn a success
        # into a free release (`_doc_dedupe.archived_here`).
        settle_as_success = bool(success)
        if settle_as_success and _doc_dedupe.archived_here(document_id):
            logger.error(
                "[pipeline][billing] REFUSED commit for document=%s — archived "
                "as a duplicate while it ran; released instead, never counted "
                "or billed", document_id,
            )
            settle_as_success = False
        if settle_as_success and run.doc_reserved and _run_book_already_counted(
                document_id, own_reservation_id=run.reservation_id):
            # ONE COUNT PER BOOK, whatever entry reserved (verifier lens S):
            # the document — or a live copy of the same book — was already
            # counted (the quota ledger). Released, never committed or billed.
            logger.error(
                "[pipeline][billing] REFUSED commit for document=%s — its book was "
                "already counted; released instead, never counted or billed", document_id,
            )
            settle_as_success = False

        # THE MARK BEFORE THE MOVE (P1 RESTART, second shape, 2026-09-26).
        # The meter RPC and its record are two writes. A record that failed
        # (kept in `_quota_ledger._PENDING` and retried) followed by a
        # restart left a row that read "reserved" for a meter that had
        # already moved, and the new process's sweep settled the finished
        # analysis as a commit AGAIN — a paid extra billed twice. The row is
        # stamped SETTLING (compare-and-set on this run's reservation id)
        # before any RPC below; a settling row is never settled by the sweep,
        # never adopted, and its book is never metered again — it waits for
        # the restore script. Best-effort like every ledger write: a failed
        # stamp is logged and the settlement proceeds.
        if run.doc_reserved or run.nonro_reserved:
            _quota_ledger.mark_settling(document_id, reservation_id=run.reservation_id)

        if run.doc_reserved and run.user_id:
            if settle_as_success:
                # Into the month the reservation was made in.
                _ug.commit_document(run.user_id, was_extra=run.was_extra, month=run.month)
                # The fact every later entry reads back: THIS document was
                # counted (a table the browser cannot write).
                _quota_ledger.record_commit(document_id, user_id=run.user_id,
                                            was_extra=run.was_extra,
                                            month=run.month or _ug._month_bucket())
                # WS2 — a successful PAID EXTRA records one usage unit on the
                # user's Stripe metered item. Idempotency key = document_id.
                if run.was_extra:
                    try:
                        from . import _billing
                        result = _billing.record_metered_extra_doc(
                            user_id=run.user_id,
                            reservation_id=document_id,
                        )
                        if not result.get("ok"):
                            logger.error(
                                "[pipeline] record_metered_extra_doc returned non-ok for "
                                "doc=%s user=%s — manual reconciliation may be needed. "
                                "Result: %s", document_id, run.user_id, result,
                            )
                        elif not result.get("billed"):
                            logger.info(
                                "[pipeline] metered extra-doc not billed (doc=%s reason=%s)",
                                document_id, result.get("reason"),
                            )
                    except Exception:  # noqa: BLE001
                        logger.exception(
                            "[pipeline] record_metered_extra_doc raised — local "
                            "extras_billed_period already bumped, Stripe side missed "
                            "this charge. doc=%s user=%s", document_id, run.user_id,
                        )
            else:
                _ug.release_document(run.user_id, was_extra=run.was_extra, month=run.month)
                _quota_ledger.record_release(document_id)

        # Non-RO meter — reserved mid-run by `_enforce_nonro_plan_gate`,
        # settled with the run under the same success-only discipline.
        if run.nonro_reserved and run.nonro_user:
            # The non-RO reservation was made under `documents.uploaded_by`,
            # which the BROWSER writes: it settles only against a member of
            # the document's own organization (P0 family, 2026-09-09).
            nonro_success = settle_as_success
            if nonro_success:
                with _supabase.admin() as ac:
                    found = ac.select("documents", filters={"id": f"eq.{document_id}"},
                                      columns="id,org_id", single=True)
                doc_org = str((found[0] if found else {}).get("org_id") or "").strip()
                if not doc_org or not _org.user_is_member(run.nonro_user, doc_org):
                    logger.error(
                        "[security] REFUSED non-RO commit: document=%s names "
                        "uploaded_by=%r who is not a member of its org=%r",
                        document_id, run.nonro_user, doc_org,
                    )
                    nonro_success = False
            if nonro_success:
                _ug.commit_nonro_document(run.nonro_user, was_extra=run.nonro_extra,
                                          month=run.nonro_month)
                if run.nonro_extra:
                    try:
                        from . import _billing
                        result = _billing.record_metered_extra_doc(
                            user_id=run.nonro_user,
                            reservation_id=document_id,
                            kind="extra_nonro",
                        )
                        if not result.get("ok"):
                            logger.error(
                                "[pipeline] non-RO metered usage non-ok for "
                                "doc=%s user=%s: %s", document_id, run.nonro_user, result,
                            )
                    except Exception:  # noqa: BLE001
                        logger.exception(
                            "[pipeline] non-RO metered usage raised — local "
                            "tally bumped, Stripe missed this charge. "
                            "doc=%s user=%s", document_id, run.nonro_user,
                        )
            else:
                _ug.release_nonro_document(run.nonro_user, was_extra=run.nonro_extra,
                                           month=run.nonro_month)
                _quota_ledger.record_release(document_id)
    except Exception:
        logger.exception(
            "[pipeline] _commit_pipeline_quota(%s, success=%s) failed",
            document_id, success,
        )


def _run_book_already_counted(document_id: str, *, own_reservation_id: Optional[str] = None) -> bool:
    """The settlement's backstop: the document as it is NOW — is its book
    already counted? Unknown (unreadable) → False: the run's own
    reservation is settled as it always was. `own_reservation_id`: the
    reservation THIS settlement holds — its settling mark (the sweep's
    claim, or this run's own stamp) is not another settlement's."""
    try:
        with _supabase.admin() as ac:
            found = ac.select("documents", filters={"id": f"eq.{document_id}"}, single=True) or []
    except Exception:  # noqa: BLE001
        logger.exception("[pipeline] settlement: could not re-read document %s", document_id)
        return False
    return bool(_book_already_counted(dict(found[0]) if found else None,
                                      own_reservation_id=own_reservation_id))


def _enter_run(doc: Dict[str, Any], user_id: str) -> "_doc_dedupe.Entry":
    """`/api/pipeline/run`'s entry (`_doc_dedupe.enter_analysis`, FIRST).

    When another entry holds this document's claim and is still asking the
    meter (a recovery on page mount), wait — bounded — for it to decide:
    if it gives the claim back, THIS /run is the one that asks, instead of
    answering "queued" for a run nobody is going to start."""
    entry = _doc_dedupe.enter_analysis(doc, user_id, now_iso=_now_iso(), mode=_doc_dedupe.FIRST)
    if entry.kind == _doc_dedupe.BUSY and _doc_dedupe.await_decision(str(doc.get("id") or "")) is None:
        entry = _doc_dedupe.enter_analysis(doc, user_id, now_iso=_now_iso(), mode=_doc_dedupe.FIRST)
    return entry


def _meter_first_analysis(document_id: str, user_id: str) -> Any:
    """Ask the meter for the FIRST analysis of `document_id` under the
    verified `user_id` — /run's reservation, shared with every re-run of a
    document that holds no analysis yet (`_start_rerun`).

    ONE METER: the reservation itself is `reserve_upload_or_refuse`, the
    function `/api/uploads/commit` takes too — the grant a confirmed extra
    gave THIS document first (verifier P-B), then the document's own
    reservation a restart orphaned (`_adopt_reservation`, lens S S8), else
    `reserve_document`; 429 `doc_quota_blocked` / 402
    `extra_doc_confirmation_required` with /run's exact body, the 402 noted
    against this document. What this adds is the ledger: an `allowed`
    reservation goes into it — in the month it was made — BEFORE any other
    write, so a write that fails after it finds the reservation there to
    release it — or, when the document's ledger row already holds another
    member's OUTSTANDING reservation, gives the slot straight back and
    answers 409 `reservation_outstanding` (fix/dedupe-quota P2-B). The
    caller gives its claim back (and releases whatever the ledger holds)
    when it does not hand the run off."""
    decision = reserve_upload_or_refuse(user_id, document_id)
    if decision.kind == "allowed":
        if not _register_quota_run(document_id, user_id=user_id, was_extra=bool(decision.was_extra),
                                   month=getattr(decision, "month", "") or None,
                                   reservation_id=getattr(decision, "reservation_id", "") or None):
            raise HTTPException(409, {
                "code": "reservation_outstanding",
                "message": ("This document's analysis is still reserved by the member who started "
                            "it. Try again in a few minutes."),
            })
    # `allowed` or `disabled` — the caller hands the run off.
    return decision


def _adopt_reservation(document_id: str, user_id: str, *, take_extra: bool) -> Any:
    """The document's OWN outstanding reservation that a restart orphaned
    (the quota ledger), taken over by the run the caller just claimed —
    instead of reserving the same document a second time (verifier lens S,
    S8). A confirmed extra only for the document's own run (`take_extra`).
    None when there is none: the caller asks the meter."""
    from . import _usage_gate as _ug
    if not _ug.enforced_for(user_id):
        return None
    with _QUOTA_RUNS_LOCK:
        if str(document_id) in _QUOTA_RUNS:
            return None
    row = _quota_ledger.adopt(str(document_id), user_id=str(user_id), take_extra=take_extra)
    if row is None:
        return None
    return _ug.DocReserveDecision(
        kind="allowed", plan_key="", used=0, reserved=0, cap=0, extra_doc_eur=None,
        message="", was_extra=bool(row.get("was_extra")), month=str(row.get("month") or ""),
        reservation_id=str(row.get("reservation_id") or ""))


def _release_unstarted(entry: "_doc_dedupe.Entry", document_id: str) -> None:
    """An entry that claimed but never handed its run off (refused by the
    meter, or a write failed): the claim goes back — a dismissed dialog must
    not leave a phantom "running" original behind for the next upload to
    hit — and a reservation already taken is released, never leaked."""
    _doc_dedupe.release_claim(entry.released_row())
    _release_run_reservation(document_id, _take_quota_run(document_id))


def _book_already_counted(row: Optional[Dict[str, Any]], *,
                          own_reservation_id: Optional[str] = None) -> Optional[bool]:
    """Has the plan already COUNTED this document's book? True when the
    document itself, or any live copy of the same book (company, uploader,
    content, scope, period — `_doc_dedupe.book_copy_ids`), carries a commit
    in the quota ledger (`_quota_ledger`, a table the browser cannot
    write) — or a reservation whose settlement is undetermined
    (`_quota_ledger.is_settling`: the meter may have counted it; never
    metered again, the restore script rules). None when that cannot be
    read."""
    if not row:
        return None
    ids = _doc_dedupe.book_copy_ids(row)
    if ids is None:
        return None
    counted = _quota_ledger.counted_ids(ids, except_reservation=own_reservation_id)
    if counted is None:
        return None
    return bool(counted)


def _needs_metering(entry: "_doc_dedupe.Entry") -> bool:
    """Is THIS claimed run the book's FIRST analysis — the one the meter
    reserves, commits and (above the cap) bills?

      * an ANALYSED document re-runs unmetered (a correction of a book the
        plan counted, or analysed before the meter existed);
      * a document whose book the plan already COUNTED re-runs unmetered,
        whatever its status says now (verifier lens S, 2026-09-21);
      * anything else — a failed first run, a 402 the user dismissed, a run
        a restart killed — is metered exactly like /run (lens Q).

    THE STATUS IS NOT THE RECORD (lens S). This used to be `status !=
    analyzed` alone. A counted book goes back to `failed` whenever a free
    correction re-run of it fails (the re-run has already deleted its
    period; a PDF on an empty Anthropic balance, §24), and the next /retry,
    the failed banner's /run or a re-upload of the same bytes then counted
    it a second time — at the cap as a PAID EXTRA. What the plan counted is
    now read from the quota ledger the settlement writes.

    THE LEDGER BEFORE THE STATUS (P1 METERING BYPASS, 2026-09-26). The
    `analyzed` short-circuit used to come FIRST — before the ledger was
    consulted. Every column of `documents` is browser-writable, so a member
    who PATCHed status='analyzed' onto a fresh upload and POSTed /retry got
    an analysis that was never reserved, committed or billed. The order is
    now: the ledger decides whenever it can be read — counted → unmetered;
    readable and NOT counted → metered like /run whatever the status says
    (a status the browser wrote, or a document analysed with enforcement
    OFF, whose settlement recorded a release and never a count: it meters
    ONCE on its next re-run — stated in the migration header). ONLY an
    unreadable or absent ledger falls back to the status rule, logged."""
    status = str(entry.status or "").strip().lower()
    counted = _book_already_counted(entry.row)
    if counted is not None:
        if counted:
            logger.info("[pipeline][quota] document %s: its book was already counted — re-run "
                        "unmetered", entry.row.get("id"))
            return False
        if status == "analyzed":
            logger.warning(
                "[pipeline][quota] document %s reads `analyzed` but the quota ledger holds no "
                "count for its book — metered like /run (analysed with enforcement off, or a "
                "status the browser wrote)", entry.row.get("id"))
        return True
    # The ledger cannot be read (absent, or a transient failure): the status
    # rule is the fallback — an analysed document re-runs free (metering it
    # by guess would count a book twice), anything else is metered.
    # A ledger known to be ABSENT (the migration not applied — the window's
    # one INFO line said so) is not an error per document: INFO. A read that
    # failed for any other reason keeps its ERROR.
    level = logging.INFO if _quota_ledger.absent() else logging.ERROR
    if status == "analyzed":
        logger.log(level,
                   "[pipeline][quota] the quota ledger could not be read for document %s — an "
                   "analysed document re-runs unmetered by its status; "
                   "supabase/schema_phase_document_quota_ledger.sql applied?", entry.row.get("id"))
        return False
    logger.log(level,
               "[pipeline][quota] the quota ledger could not be read for document %s — metering "
               "by its status (%s); supabase/schema_phase_document_quota_ledger.sql applied?",
               entry.row.get("id"), entry.status)
    return True


def _start_rerun(doc: Dict[str, Any], caller_id: str, start: Any) -> "_doc_dedupe.Entry":
    """THE entry for every RE-RUN of a stored document — /retry, and the
    move-period / make-active correction re-runs: the same step as /run
    (`_doc_dedupe.enter_analysis`, RERUN — the one-run-per-document claim
    and the duplicate look, under the lock), then

      * a document that holds an analysis, or whose book the plan already
        counted (the quota ledger — `_needs_metering`), re-runs UNMETERED
        (a correction: it reserves, settles and bills nothing);
      * anything else is the book's FIRST successful analysis and is
        metered exactly like /run (`_meter_first_analysis`: the grant for
        this document, else the meter; 402 / 429 refuse it).

    `start()` hands the claimed run off (wipes what it must, queues,
    enqueues). Anything that stops short of that gives the claim and the
    reservation back. Returns the entry; only a CLAIMED entry started."""
    from . import _usage_gate as _ug
    doc_id = str(doc.get("id") or "")
    entry = _doc_dedupe.enter_analysis(doc, caller_id, now_iso=_now_iso(), mode=_doc_dedupe.RERUN)
    if entry.kind != _doc_dedupe.CLAIMED:
        if entry.kind in (_doc_dedupe.DUPLICATE, _doc_dedupe.DELETED):
            # A confirmed extra for a document that will never run as a
            # first analysis goes back now, unbilled (verifier P-B).
            _ug.cancel_extra_grant(doc_id)
        return entry
    metered = _needs_metering(entry)
    if not metered:
        # An analysed document never spends a confirmed extra.
        _ug.cancel_extra_grant(doc_id)
    started = False
    try:
        if metered:
            decision = _meter_first_analysis(doc_id, caller_id)
            if decision.was_extra:
                # Visibility only (support, the audit scripts): the
                # settlement reads the LEDGER, never this stamp.
                with _supabase.admin() as ac:
                    ac.update("documents", {"metered_extra": True}, filters={"id": f"eq.{doc_id}"})
        start()
        started = True
    finally:
        if not started:
            _release_unstarted(entry, doc_id)
    return entry


def _correction_rerun(jwt: str, document_id: str, started_at: str) -> None:
    """move-period / make-active's re-run (`_period_move.register_routes`
    `rerun`).

    EVERY correction enters like /retry does (`_start_rerun`): the
    one-run-per-document claim, the duplicate look and — only for a book
    the plan has not counted yet — the meter, 402 / 429 included. A
    correction of an ANALYSED (or already counted) document re-runs
    unmetered: the book is counted, and the move has already re-shaped its
    periods on the promise of this re-run.

    THE CLAIM IS NOT OPTIONAL (verifier lens S, S6 / S7 / S11, 2026-09-21).
    The analysed branch used to queue and enqueue with NO claim: while it
    ran, a Docs-panel /retry, the failed banner's /run or a second move
    found the document neither in flight nor analysed, claimed it, metered
    it as the book's first analysis and started a second daemon thread on
    the same row — whose terminal then dropped the first run's claim. Now
    the claim is taken (then `mark_running`, then the enqueue), and a
    document another entry holds is BUSY: not started. The routes refuse a
    move of a running document before re-filing it
    (`_period_move.register_routes` `is_running`), so BUSY here is the race
    between that check and this claim."""
    caller_id = _user_id_from_jwt(jwt)
    try:
        # The caller's own companies are the filter: the id is the document
        # the route authorized or a sibling of its period (same company).
        orgs = [str(o) for o in _org.member_org_ids(caller_id) if o]
        rows: List[Dict[str, Any]] = []
        if orgs:
            with _supabase.admin() as ac:
                rows = ac.select("documents", filters={
                    "id": f"eq.{document_id}", "org_id": "in.(%s)" % ",".join(orgs),
                }, single=True) or []
    except Exception:  # noqa: BLE001 — an unreadable row is re-run unmetered, claimed
        logger.exception("[pipeline] correction re-run: could not read document %s", document_id)
        rows = []
    row = dict(rows[0]) if rows else None

    def start() -> None:
        _admin_set_status(document_id, "queued", pipeline_started_at=started_at)
        _doc_dedupe.mark_running(document_id)
        _enqueue(document_id)

    if row is None:
        # Unreadable: nothing can be looked up or metered — but the run is
        # still ONE run: claimed, or not started.
        if not _doc_dedupe.try_mark_in_flight(document_id):
            logger.info("[pipeline] correction re-run of %s not started: busy", document_id)
            return
        started = False
        try:
            start()
            started = True
        finally:
            if not started:
                _doc_dedupe.clear_in_flight(document_id)
        return

    entry = _start_rerun(row, caller_id, start)
    if entry.kind != _doc_dedupe.CLAIMED:
        logger.info("[pipeline] correction re-run of %s not started: %s", document_id, entry.kind)


def _recover_one(row: Dict[str, Any], caller_id: str) -> Tuple[str, Dict[str, Any]]:
    """recover-stuck's and the SKU watchdog's entry for ONE stuck upload —
    a /run that was refused (402 / 429) or never arrived.

    THE SAME STEP AS /run (2026-09-21, verifier P-C). Both used to look for
    a duplicate WITHOUT claiming and stamp `pipeline_started_at` only after
    the reservation, outside the lock: a /run of a twin copy landing in that
    window found the stuck row unstarted, claimed itself, and both copies
    were analysed and counted; recover-stuck and the watchdog firing on one
    Products mount each reserved the same row. Now the look-then-claim is
    `_doc_dedupe.enter_analysis` (RECOVER) under the lock, on the row as it
    is NOW, and a refusal by the meter gives the claim back — exactly as
    /run does. A document holding a confirmed extra is left to its own /run
    (the only run that may spend the grant).

    Returns (outcome, info): "recovered", "duplicate" (info names the
    original), "needs_confirmation" (info["reason"]) or "skipped"."""
    from . import _usage_gate as _ug
    doc_id = str(row.get("id") or "")
    if _ug.has_extra_grant(doc_id):
        return "skipped", {}
    lost = _quota_ledger.outstanding(doc_id)
    if lost is not None and lost.get("was_extra"):
        # A confirmed extra a restart took out of memory: still this
        # document's, spent only by its own /run (or given back by the sweep).
        return "skipped", {}
    entry = _doc_dedupe.enter_analysis(row, caller_id, now_iso=_now_iso(), mode=_doc_dedupe.RECOVER)
    if entry.kind == _doc_dedupe.DUPLICATE:
        return "duplicate", {
            "existing_document_id": entry.hit.existing_document_id if entry.hit else None,
            "period_id": entry.hit.period_id if entry.hit else None,
        }
    if entry.kind != _doc_dedupe.CLAIMED:
        return "skipped", {}
    enqueued = False
    try:
        if not _needs_metering(entry):
            # Its book was already counted (the quota ledger): recovered
            # unmetered, like every other re-run of a counted book.
            _admin_set_status(doc_id, "queued", pipeline_started_at=_now_iso())
            _doc_dedupe.mark_running(doc_id)
            _enqueue(doc_id)
            enqueued = True
            return "recovered", {}
        try:
            decision = (_adopt_reservation(doc_id, caller_id, take_extra=False)
                        or _ug.reserve_document(caller_id))
        except Exception:  # noqa: BLE001 — an unreachable meter refuses
            logger.exception("[pipeline] recovery: meter unreachable for doc %s", doc_id)
            return "needs_confirmation", {"reason": "metering_unavailable"}
        if decision.kind == "allowed":
            if not _register_quota_run(doc_id, user_id=caller_id, was_extra=bool(decision.was_extra),
                                       month=decision.month or None,
                                       reservation_id=decision.reservation_id or None):
                # Another member's reservation of it is outstanding: left for
                # the sweep; the next mount recovers it.
                return "skipped", {}
        if decision.kind not in ("allowed", "disabled"):
            logger.info("[pipeline] recovery: doc %s not re-enqueued — meter says %s",
                        doc_id, decision.kind)
            return "needs_confirmation", {"reason": decision.kind}
        if decision.was_extra:
            with _supabase.admin() as ac:
                ac.update("documents", {"metered_extra": True}, filters={"id": f"eq.{doc_id}"})
        _admin_set_status(doc_id, "queued", pipeline_started_at=_now_iso())
        _doc_dedupe.mark_running(doc_id)
        _enqueue(doc_id)
        enqueued = True
        return "recovered", {}
    finally:
        if not enqueued:
            _doc_dedupe.release_claim(entry.released_row())
            _release_run_reservation(doc_id, _take_quota_run(doc_id))


def _run_pipeline_sync(document_id: str) -> None:
    """Run the stages, then settle THIS run's reservation on the outcome.

    Every terminal path goes through the one settlement below — the early
    successes (public-records summary, AI-lane cache hit, AI lane, SKU scope)
    used to `return` past the commit and leave their reservation outstanding
    forever, and a document that vanished mid-run released nothing. The
    document leaves the in-flight registry only after its settlement, so a
    second entry can never claim it while this run still holds its slot."""
    outcome = "failed"
    try:
        outcome = _run_pipeline_stages(document_id)
    finally:
        try:
            _commit_pipeline_quota(document_id, success=(outcome == "analyzed"))
        except Exception:  # noqa: BLE001
            logger.exception("[pipeline] quota settlement failed (non-fatal)")
        finally:
            _doc_dedupe.clear_in_flight(document_id)


def _run_pipeline_stages(document_id: str) -> str:
    """Every pipeline stage for one document. Returns the outcome —
    "analyzed", "failed" (the failure is persisted on the row) or
    "vanished" — and never settles quota itself (`_run_pipeline_sync`)."""
    t0 = time.time()
    # Bound before the try so the failure handler can name the tenant of the
    # period this run may have to roll back (G4).
    doc: Optional[Dict[str, Any]] = None
    try:
        with _supabase.admin() as admin_client:
            doc_rows = admin_client.select("documents", filters={"id": f"eq.{document_id}"}, single=True)
            if not doc_rows:
                logger.warning("[pipeline] document %s vanished mid-run", document_id)
                return "vanished"
            doc = doc_rows[0]

            org_rows = admin_client.select("organizations", filters={"id": f"eq.{doc['org_id']}"}, single=True)
            org = org_rows[0] if org_rows else {"id": doc["org_id"], "name": "Unknown", "industry_key": None, "industry_display_name": None}

        scope = (doc.get("scope") or "financial").lower()

        # RUN JOURNAL — RUN_STARTED (no-op unless ENGINE_JOURNAL_DIR set).
        _journal_hooks.on_run_started(doc, industry=org.get("industry_display_name") or org.get("industry_key"))

        _admin_set_status(document_id, "extracting", pipeline_started_at=_now_iso())
        parsed = stage_extract(doc)
        # RUN JOURNAL — FRONTEND_DONE (deterministic parse / ai-lane /
        # llm-fallback all complete here, whatever lane ran).
        _journal_hooks.on_frontend_done(doc, parsed)

        # ── Public-records short-circuit ────────────────────────────────
        # `stage_extract` returns `detected_type='public_records_summary'`
        # when it recognized the PDF as a listafirme.ro / termene.ro
        # multi-year aggregate table. These are NOT trial balances — they
        # have 6 numbers per year, not 800+ accounts. Pushing them through
        # the TB pipeline silently produces nonsense (the PRO TV regression
        # case: revenue = EBITDA = net income = 1.14B). Persist the parsed
        # years to the sku_analyses table (re-using the existing JSONB
        # column to avoid a migration) and mark the doc analyzed cleanly.
        # The `documents.detected_type` column has a CHECK constraint so we
        # tag the doc via `briefing.kind` instead — the FE filters by that.
        if (parsed or {}).get("detected_type") == "public_records_summary":
            persisted = False
            try:
                with _supabase.admin() as admin_client:
                    admin_client.upsert(
                        "sku_analyses",
                        {
                            "org_id": doc["org_id"],
                            "document_id": document_id,
                            "briefing": {
                                "kind": "public_records_summary",
                                "company_name": parsed.get("company_name"),
                                "cui": parsed.get("cui"),
                                "reg_com": parsed.get("reg_com"),
                                "caen_code": parsed.get("caen_code"),
                                "caen_description": parsed.get("caen_description"),
                                "source_site": parsed.get("source_site"),
                                "confidence": parsed.get("confidence"),
                                "years": parsed.get("years") or [],
                            },
                            "summary": {
                                "kind": "public_records_summary",
                                "company_name": parsed.get("company_name"),
                                "year_count": len(parsed.get("years") or []),
                            },
                            "recommendations": [],
                            "language": "en",
                            "model": "public_records_parser_v1",
                        },
                        on_conflict="document_id",
                        returning=False,
                    )
                persisted = True
                logger.info(
                    "[pipeline] %s public_records_summary persisted: %d years",
                    document_id, len(parsed.get("years") or []),
                )
            except Exception:  # noqa: BLE001
                logger.exception("[pipeline] public_records persistence failed")
            if persisted:
                # Mark the doc analyzed with NO period (this isn't a TB).
                _admin_set_status(
                    document_id, "analyzed",
                    duration_ms=int((time.time() - t0) * 1000),
                    period_id=None,
                )
                # Best-effort tag the detected_type. The CHECK constraint
                # may reject `public_records_summary` — that's fine, the
                # briefing.kind discriminator is the canonical signal.
                try:
                    with _supabase.admin() as admin_client:
                        admin_client.update(
                            "documents",
                            {"detected_type": "public_records_summary"},
                            filters={"id": f"eq.{document_id}"},
                        )
                except Exception:  # noqa: BLE001
                    pass  # CHECK constraint rejection is non-fatal
                return "analyzed"  # Short-circuit — no TB stages for this doc.

        # ── AI-lane (HU/OTHER jurisdictions) short-circuit ──────────────
        # `stage_extract` returns `detected_type='ai_lane_statement'` when
        # the jurisdiction resolver routed the document through the AI
        # extraction lane. The lane already built the FULL canonical
        # envelope (canonical_bs via build_canonical_bs_v2 + ai_audit +
        # needs_review) — persist it through the UNTOUCHED stage_persist
        # (provenance stamp + auto-reconcile seam, which correctly skips
        # llm extractions) and stop: the RO mapper/compute/narrate stages
        # must never consume non-RO accounts. Mirrors the public-records
        # marker-payload pattern above.
        if (parsed or {}).get("detected_type") == _ai_lane.AI_LANE_DETECTED_TYPE:
            _ai_info = parsed.get("ai_lane") or {}
            if _ai_info.get("cached"):
                # Cache hit — the persisted envelope IS the cache; the
                # period already carries this content_hash + prompt
                # versions. Zero model calls, zero writes.
                _admin_set_status(
                    document_id, "analyzed",
                    duration_ms=int((time.time() - t0) * 1000),
                    period_id=_ai_info.get("period_id"),
                )
                logger.info(
                    "[pipeline] %s ai_lane cache hit — served persisted "
                    "envelope (period %s)",
                    document_id, _ai_info.get("period_id"),
                )
                return "analyzed"
            _admin_set_status(document_id, "mapping")
            assembled = _ai_info.get("assembled") or {}
            # RUN JOURNAL — PASS_DONE (ai-lane assembled envelope).
            _journal_hooks.on_pass_done(doc, assembled)
            period_id = stage_persist(doc, parsed, assembled)
            # G4 — a same-month re-upload becomes the month only now.
            period_id = _finalize_same_month_takeover(doc, period_id)
            _admin_set_status(
                document_id, "analyzed",
                duration_ms=int((time.time() - t0) * 1000),
                period_id=period_id,
            )
            _pop_period_minted(document_id)
            logger.info(
                "[pipeline] %s ai_lane complete in %dms (jurisdiction=%s, "
                "period %s)",
                document_id, int((time.time() - t0) * 1000),
                _ai_info.get("jurisdiction"), period_id,
            )
            return "analyzed"

        # Persist the deterministic detected_type back to the documents
        # row. Upload-time detection uses filename heuristics only — once
        # `stage_extract` has inspected the content (TB anchors, F30/F10
        # row layout, Claude classification), the result here is far more
        # reliable and drives the FE banner. We only overwrite when
        # stage_extract surfaced a strong type so e.g. an SKU sales-export
        # routed via Claude doesn't clobber an existing "xlsx_workbook"
        # tag with "unknown".
        try:
            extracted_type = (parsed or {}).get("detected_type")
            if extracted_type in (
                "trial_balance", "statutory_f30_f10",
                "bilant", "pl", "annual_report",
            ):
                with _supabase.admin() as _ac:
                    _ac.update(
                        "documents",
                        {"detected_type": extracted_type},
                        filters={"id": f"eq.{document_id}"},
                    )
        except Exception:
            logger.exception("[pipeline] detected_type persist failed (non-fatal)")

        # Run the multi-country detector against the extracted text. Result is
        # stored on the document row so the mapper can pick the right COA and
        # the UI can decide whether to surface a "confirm detection?" card.
        # Best-effort: failures are non-fatal — extraction proceeds either way.
        try:
            ocr_text = parsed.get("raw_text") or "\n".join(
                f"{a.get('code','')} {a.get('name','')}"
                for a in (parsed.get("accounts") or [])
            )
            if ocr_text:
                det = _detect.detect_format(
                    ocr_text,
                    filename=doc.get("original_filename"),
                )
                with _supabase.admin() as ac:
                    ac.update(
                        "documents",
                        {
                            "detected_coa": det.get("coa_key"),
                            "detected_country": det.get("country_code"),
                            "detected_language": det.get("language"),
                            "detection_confidence": det.get("confidence"),
                        },
                        filters={"id": f"eq.{document_id}"},
                    )
                # Inject detection hints into parsed payload so downstream
                # stages (mapping, narrate) can use them.
                parsed.setdefault("detection", det)
                logger.info(
                    "[pipeline] %s detected: coa=%s country=%s lang=%s conf=%.2f decided_by=%s",
                    document_id, det.get("coa_key"), det.get("country_code"),
                    det.get("language"), det.get("confidence") or 0.0,
                    det.get("decided_by"),
                )
        except Exception:  # noqa: BLE001
            logger.exception("[pipeline] detection stage failed (non-fatal)")

        # SKU branch — completely independent of financial_periods. Two
        # sub-paths:
        #   1. Trading-analysis XLSX with native per-SKU rows → openpyxl
        #      extraction into sku_lines + sku_aggregates (full 406-row
        #      portfolio for the user's actual file).
        #   2. Anything else (PDF, CSV without recognizable sales shape) →
        #      the LLM-summary briefing path (sku_analyses).
        if scope == "sku":
            _admin_set_status(document_id, "mapping")
            dataset_id: Optional[str] = None
            try:
                dataset_id = _run_sales_dataset_pipeline(doc)
            except Exception as e:  # noqa: BLE001
                logger.warning("[pipeline] sales dataset path failed, falling back to summary: %s", e)

            # Always also produce a briefing — useful even with sku_lines,
            # gives the user a 3-sentence executive summary alongside the
            # raw portfolio. Skips if extraction returned nothing.
            _admin_set_status(document_id, "narrating")
            assembled = stage_map(doc, parsed, org.get("industry_display_name") or org.get("industry_key"))
            narrative = stage_narrate(doc, assembled, [], org, period_id="-", parsed=parsed)
            _persist_sku_analysis(doc, parsed, narrative)

            _admin_set_status(
                document_id,
                "analyzed",
                duration_ms=int((time.time() - t0) * 1000),
                period_id=None,
            )
            logger.info(
                "[pipeline] %s (sku scope) complete in %dms, dataset_id=%s",
                document_id, int((time.time() - t0) * 1000), dataset_id,
            )
            return "analyzed"

        # Financial branch — existing path.
        #
        # Zero-accounts guard (2026-08-02, operator-reported "upload succeeds
        # but dashboard stays empty"): if extraction produced NO accounts,
        # this used to mint an empty-but-'analyzed' period and navigate the
        # user into a blank dashboard (the FE's empty-container detection then
        # shows the dropzone, so the period was pure noise). Fail loudly
        # instead — the blanket handler below marks the document 'failed' with
        # this message, and the scan view shows it with a retry path. Statutory
        # F30/F10 files synthesize accounts and public-records docs short-
        # circuit earlier, so zero here always means "not a financial document
        # we could read".
        accounts_count = len(parsed.get("accounts") or [])
        if accounts_count == 0:
            raise RuntimeError(
                "No financial data could be extracted — the file doesn't look "
                "like a trial balance or financial statement. Check that you "
                "uploaded the right file (or start from the official template) "
                "and try again."
            )

        _admin_set_status(document_id, "mapping")
        assembled = stage_map(doc, parsed, org.get("industry_display_name") or org.get("industry_key"))
        # RUN JOURNAL — PASS_DONE (assemble stage boundary).
        _journal_hooks.on_pass_done(doc, assembled)
        period_id = stage_persist(doc, parsed, assembled)

        _admin_set_status(document_id, "computing")
        valuation_payload: Optional[Dict[str, Any]] = None
        if accounts_count > 0:
            metrics = stage_compute(doc, assembled, period_id)
            # Statutory anchor override — the TB parser captures account
            # 121's closing balance directly (the legally filed net profit
            # on Romanian books). stage_compute writes a stand-in
            # `net_income_statutory = operational + 722`, which is correct
            # for asset-heavy companies (EEI's case) where the 722 carry
            # IS the statutory gap. For manufacturers without 722 the gap
            # comes from class-65 provision movements and 781 reversals
            # — small enough that the reconstruction is within 1-2% of 121
            # for the oracle but can drift up to 6% on the platform.
            # The 121 closing balance is the authoritative number — patch
            # `net_income_statutory` to that when available so the FE +
            # briefing cite the same figure the user sees on their filings.
            anchor = (parsed or {}).get("statutory_net_profit_anchor")
            if anchor and abs(anchor) > 0.01:
                try:
                    with _supabase.admin() as ac:
                        ac.delete(
                            "calculated_metrics",
                            filters={"period_id": f"eq.{period_id}", "name": "eq.net_income_statutory"},
                        )
                        ac.insert("calculated_metrics", [{
                            "period_id": period_id,
                            "org_id": doc["org_id"],
                            "name": "net_income_statutory",
                            "value": round(float(anchor), 2),
                            "unit": "RON",
                            "direction": "higher",
                        }], returning=False)
                    logger.info(
                        "[pipeline] net_income_statutory overridden with ct 121 anchor: %s",
                        f"{float(anchor):,.0f}",
                    )
                except Exception:  # noqa: BLE001
                    logger.exception("[pipeline] statutory anchor override failed (non-fatal)")
            validation_alerts = stage_validate(doc, assembled, period_id)
            # AI Council — advisory extraction-integrity review (2026-07-20).
            # A panel of independent Claude personas scans the extraction and a
            # deterministic chair returns a consensus verdict. Non-blocking:
            # findings are appended to validation_alerts as 'data_quality'
            # advisories and surface in the existing alerts UI. stage_council
            # never raises; a missing API key degrades to a deterministic
            # rule-based verdict.
            council_result = stage_council(doc, parsed, assembled)
            if council_result:
                from . import _ai_council
                logger.info(
                    "[pipeline] ai_council verdict=%s confidence=%.2f findings=%d (doc=%s)",
                    council_result.get("verdict"),
                    council_result.get("confidence", 0.0),
                    len(council_result.get("findings", []) or []),
                    document_id,
                )
                validation_alerts = list(validation_alerts) + \
                    _ai_council.council_findings_as_alerts(council_result)
            # ── Advisory unit-sanity sweep (engine.ai.unit_sanity) ─────
            # Reads the ASSEMBLED alert text the way a CFO reads it — one
            # sentence at a time — and flags two things nothing upstream
            # can see: two currencies inside one claim, and a percentage
            # its own stated operands contradict. It runs over the merged
            # list deliberately: `stage_validate`'s rows are rule-authored
            # and native, but `council_findings_as_alerts` carries MODEL
            # free text into this same channel with `facts_cited: None`.
            #
            # Advisory in the strict sense: flags only, never rewrites,
            # never blocks, needs no credits. A finding here means an
            # operator should look, not that the pipeline should stop.
            try:
                from engine.ai import unit_sanity as _unit_sanity

                _unit_findings = _unit_sanity.check_alerts(validation_alerts)
                for _f in _unit_findings:
                    logger.warning(
                        "[pipeline] unit-sanity %s at alert %s — %s | %r",
                        _f.code, _f.pointer, _f.message, _f.sentence[:160],
                    )
            except Exception:  # noqa: BLE001 — advisory: never breaks a run
                logger.exception("[pipeline] unit-sanity sweep failed (non-fatal)")
            # Industry classification fallback. When the org's industry_key is
            # unset or "generic", run the auto-classifier on the assembled
            # statements — for EEI this detects real_estate_commercial from
            # account 215 (investment property) and account 706 (rental income)
            # dominance, which gates the valuation method choice below.
            stored_industry_key = (org.get("industry_key") or "").lower().strip() or None
            classification = _ro_pack().classify_industry({"assembled": assembled})
            detected_industry_key = classification.get("industry_key") if classification.get("confidence", 0) >= 0.5 else None
            effective_industry_key = stored_industry_key if stored_industry_key and stored_industry_key != "generic" else (detected_industry_key or stored_industry_key)
            if classification.get("confidence", 0) >= 0.5:
                logger.info(
                    "[pipeline] industry classified as %s (confidence=%s, stored=%s, effective=%s)",
                    classification.get("industry_key"),
                    classification.get("confidence"),
                    stored_industry_key,
                    effective_industry_key,
                )

            # EBITDA-multiple valuation (primary) + DCF + EV/Revenue cross-checks.
            # For CRE / negative-EBITDA cases, _valuation.compute_valuation
            # demotes EV/EBITDA and uses asset-based as primary (Step 5 guard).
            # Pure math — never blocks the rest of the pipeline if it errors.
            try:
                valuation_payload = _valuation.compute_valuation(
                    industry_key=effective_industry_key,
                    statements=assembled["statements"],
                )
                # Surface the detection result on the valuation payload so the
                # frontend can display "Industry: Commercial Real Estate ·
                # auto-classified · confidence 0.85 · [Change]" badge.
                if valuation_payload is not None:
                    valuation_payload["industry_classification"] = classification
                    valuation_payload["industry_key_effective"] = effective_industry_key
                    valuation_payload["industry_key_stored"] = stored_industry_key
                _valuation.persist_valuation(period_id, doc["org_id"], valuation_payload)
            except Exception:  # noqa: BLE001
                logger.exception("[pipeline] valuation compute failed (non-fatal)")
        else:
            metrics = []
            validation_alerts = []

        _admin_set_status(document_id, "narrating")
        narrative = stage_narrate(
            doc, assembled, metrics, org, period_id,
            parsed=parsed, valuation=valuation_payload,
        )
        # Non-fatal: the narrative/recommendations/alerts persistence is a
        # supplementary layer on top of the analysis, which is already
        # persisted (stage_persist + calculated_metrics + valuation above).
        # A failure here — e.g. a schema-drift 409 when the
        # schema_phase_notes_period_scope migration (period_id column +
        # (period_id, alert_key) unique) hasn't been applied, or the period
        # being deleted mid-run — must NOT fail the whole scan. This mirrors
        # the "period vanished" skip inside stage_persist_narrative and the
        # non-fatal handling every other side-effect in this pipeline uses.
        try:
            stage_persist_narrative(doc, period_id, narrative, validation_alerts)
        except Exception:  # noqa: BLE001
            logger.exception(
                "[pipeline] narrative/alerts persistence failed (non-fatal) — "
                "analysis still succeeds; briefing/recommendations/alerts may be "
                "incomplete for %s until schema_phase_notes_period_scope is applied",
                document_id,
            )

        # Persist the assembled statements blob on financial_periods so the
        # period read endpoint can return it without re-deriving.
        # F4.3 — also persist the detection envelope (country/standard/
        # doc_type/industry detection + methodology pin) per
        # CANONICAL_SCHEMA_V1.md §7. Best-effort: if the JSONB column
        # doesn't exist yet (pre-F4.3 migration), the UPDATE fails and
        # we log + continue.
        envelope_payload: Dict[str, Any] = {}
        try:
            from engine.detection import build_detection_envelope  # type: ignore
            envelope = build_detection_envelope(
                classification=None,  # full upload classification only available in read path
                assembled=assembled,
                methodology_id="ro_ras_2025_v1",
                industry_key=effective_industry_key,
                period_start=parsed.get("period_end"),
                period_end=parsed.get("period_end"),
                currency=parsed.get("currency") or "RON",
            )
            envelope_payload = {
                "detection_envelope": envelope,
                "methodology_version": envelope.get("methodology_version") or "",
            }
        except Exception:  # noqa: BLE001
            logger.exception(
                "[pipeline] detection envelope build failed (non-fatal); "
                "read path will recompute"
            )
        with _supabase.admin() as admin_client:
            try:
                admin_client.update(
                    "financial_periods",
                    {"updated_at": _now_iso(), **envelope_payload},  # touch to bust cache + persist envelope
                    filters={"id": f"eq.{period_id}"},
                )
            except Exception:  # noqa: BLE001
                # F4.3 column may not exist yet on this DB — retry without it.
                logger.exception(
                    "[pipeline] period UPDATE with envelope failed; "
                    "retrying without envelope columns"
                )
                admin_client.update(
                    "financial_periods",
                    {"updated_at": _now_iso()},
                    filters={"id": f"eq.{period_id}"},
                )

        # G4 — every stage has succeeded: a same-month re-upload becomes
        # the month only now (the served row was untouched until here).
        period_id = _finalize_same_month_takeover(doc, period_id)
        _admin_set_status(
            document_id,
            "analyzed",
            duration_ms=int((time.time() - t0) * 1000),
            period_id=period_id,
        )
        # The period is now backed by an analysed document — nothing to
        # roll back from here on.
        _pop_period_minted(document_id)
        # Pricing V3 (gap D) — analysis SUCCEEDED. `_run_pipeline_sync`
        # settles this run's reservation on the returned outcome.
        logger.info("[pipeline] %s complete in %dms", document_id, int((time.time() - t0) * 1000))
        return "analyzed"
    except Exception as exc:  # noqa: BLE001
        logger.exception("[pipeline] %s failed", document_id)
        # RUN JOURNAL — RUN_FAILED + dead-letter entry (no-op when off).
        _journal_hooks.on_run_failed(document_id, exc)
        # A plain refusal is read by the user as written; anything else
        # carries its type so the log line and the card agree.
        msg = str(exc) if isinstance(exc, PlainRefusal) else f"{type(exc).__name__}: {exc}"
        try:
            _admin_set_status(document_id, "failed", error=msg, duration_ms=int((time.time() - t0) * 1000))
        except Exception:
            logger.exception("[pipeline] also failed to mark failed")
        # G4 — a period exists only once an analysed source document backs
        # it. The period this run inserted (if any) goes with the failure;
        # a staged same-month row is exactly such a period, and the month
        # it was staged beside is left serving what it served.
        _pop_takeover(document_id)
        _rollback_period_of_failed_run(
            document_id, doc.get("org_id") if isinstance(doc, dict) else None)
        # Pricing V3 (gap D) — analysis FAILED. `_run_pipeline_sync`
        # releases this run's reservation: nothing counted, nothing billed.
        return "failed"


# ── Statutory net-income anchor (account 121) — ONE resolver ──────────
#
# CLAUDE.md Appendix A §3 / Step 11: the CLOSING BALANCE OF ACCOUNT 121
# IS the statutory net profit. The class-6/7 reconstruction is the
# validation check, never the authoritative number.
#
# `assemble_statements()` honours that rule — but it can only see the
# anchor when a caller hands it `account_121_anchor_override`, because
# `accounts_to_assemble_shape()` routes 121 to `ignore_control` and drops
# the row before assembly (chart_of_accounts.py ~1085-1105).
#
# The persist path threads it (stage_map, `assemble_statements(...)`
# below). Every REBUILD-FROM-LINE-ITEMS path did not, so the same books
# served a raw reconstruction under the statutory name. Measured across
# the golden corpus (docs: design_review/engine/NET_INCOME_ANCHOR.md):
#
#   book                    account 121      rebuild served     factor
#   saga_10_col_realestate    -801,604.14    -30,391,418.38      37.9x
#   saga_10_col_agras        7,533,676.02     14,106,102.03       1.9x
#   saga_10_col_carniprod    1,435,533.59      5,843,449.04       4.1x
#   saga_10_col_retail       3,205,212.62      1,161,957.98       0.36x
#   saga_10_col                402,869.16        171,665.97       0.43x
#   pdf_positional             650,887.06        615,350.00       0.95x
#
# and it is not one field: net_income_statutory drags
# free_cash_flow_proxy, assembled_bs.current_year_pnl,
# assembled_bs.total_equity (the NAV cascade's book-equity floor) and
# bs_balance_delta with it — 30 disagreeing fields across 7 books, all
# 30 resolved by threading the anchor.
#
# THE RULE: a rebuild path calls `_assemble_with_statutory_anchor()`,
# never `assemble_statements()` directly. Threading the anchor at one
# seam and forgetting it at the next IS the defect, so resolving it,
# passing it and labelling the result are fused into one call that
# cannot be half-done. Gated by
# tests/engine/test_rebuild_net_income_anchor.py.

#: `assembled_pl.net_income_anchor_status` vocabulary. Defined once in
#: `engine.core.net_income_anchor` and re-exported here so the offline
#: seam (`RomaniaPack.assemble_parsed_tb`) can label a book without
#: importing this module — see that module's header for why the two
#: field sets used to differ.
NET_INCOME_ANCHOR_ANCHORED = _net_income_anchor.NET_INCOME_ANCHOR_ANCHORED
NET_INCOME_ANCHOR_WITHIN_TOLERANCE = (
    _net_income_anchor.NET_INCOME_ANCHOR_WITHIN_TOLERANCE
)
NET_INCOME_ANCHOR_ABSENT = _net_income_anchor.NET_INCOME_ANCHOR_ABSENT


def _statutory_anchor_for(
    period_row: Optional[Dict[str, Any]],
    line_items: Optional[List[Dict[str, Any]]] = None,
) -> Tuple[Optional[float], Optional[str]]:
    """Resolve account 121's closing balance for a period being REBUILT
    from its persisted line items. Returns `(anchor, source)`; both None
    when no anchor is recoverable.

    Sources, in order:

    1. ``period.assembled_canonical_v1.canonical_bs.invariants
       .p121_cross_check.p121`` — AUTHORITATIVE. It is literally the
       value `pack.compute_statutory_net_profit_anchor(tb_rows)` returned
       at write time, carried onto the envelope by the canonical adapter
       (canonical_adapter.py ~1557) and rounded to the cent. Nothing
       downstream mutates it.

       NOT used: the equity result ROW (``rows[id=current_year_profit]``).
       It looks like the same number and usually is, but it is
       `p121_cents + pl_net_cents` under `result_basis ==
       "sf_closing_column"` (canonical_adapter.py ~1615), so the P&L net
       leaks into it — measured on corpus/saga_compact_6_col, where the
       row reads 500.00 against an account 121 of 0.00. It also flips id
       to `current_year_loss` on a negative result and is omitted
       entirely when the result is zero. It is a presentation row, not
       the anchor.

    2. A persisted 121 line item. Today this never fires: 121 is
       `ignore_control`, so `accounts_to_assemble_shape()` drops it and
       `stage_persist` never writes it — measured 0 of 0 across all 7
       corpus books that carry a p121. Kept because a non-deterministic
       extraction lane may emit a 121 row, and because if the mapping
       ever stops dropping it this path must be the one that wins, not a
       silent reconstruction.

    3. Nothing. The caller serves the reconstruction and SAYS SO (see
       `_annotate_net_income_anchor`). This is today's outcome on the
       Radar surface, whose `LIGHT_PERIOD_COLUMNS` projection
       (_radar.py:64) selects `assembled_canonical_v1->>schema_version`
       but never the envelope object itself.

       A light projection can opt back in WITHOUT paying for the whole
       envelope column by selecting the scalar under the alias `p121`:

           p121:assembled_canonical_v1->canonical_bs->invariants
                ->p121_cross_check->>p121

       which source 1 below accepts alongside the nested object. That
       one added column is all `_radar.LIGHT_PERIOD_COLUMNS` would need
       to serve an anchored figure; the column is read here rather than
       there so the projection stays the only thing that has to change.
    """
    flat = (period_row or {}).get("p121")
    if flat is not None:
        try:
            return float(flat), "envelope_p121_cross_check"
        except (TypeError, ValueError):
            pass

    env = (period_row or {}).get("assembled_canonical_v1")
    if isinstance(env, dict):
        # The persisted shape nests invariants under `canonical_bs`; the
        # SERVED shape (`_reconcile.served_canonical_bs` output) IS the
        # canonical_bs, so its invariants sit at the top. Accept both —
        # a caller handing either object must resolve the same anchor.
        for holder in (env.get("canonical_bs"), env):
            if not isinstance(holder, dict):
                continue
            block = ((holder.get("invariants") or {}) or {}).get("p121_cross_check")
            if isinstance(block, dict) and block.get("p121") is not None:
                try:
                    return float(block["p121"]), "envelope_p121_cross_check"
                except (TypeError, ValueError):
                    pass

    total = 0.0
    seen = False
    for li in (line_items or []):
        if str((li or {}).get("ro_account_code") or "").strip().startswith("121"):
            try:
                total += float(li.get("amount") or 0)
                seen = True
            except (TypeError, ValueError):
                continue
    if seen:
        return round(total, 2), "line_items_121"
    return None, None


def _anchor_kwargs(assembler: Any, anchor: Optional[float]) -> Dict[str, Any]:
    """`{"account_121_anchor_override": anchor}` when there is an anchor
    AND `assembler` accepts that kwarg, else `{}`.

    The capability probe is load-bearing, not defensive noise: the
    review/reanalyze route assembles through
    `get_pack(overrides.confirmed_country_code)`, and the Hungarian
    pack's `assemble_statements` (hu_hungary/pack.py:127) has no such
    parameter. Reanalysing an RO period — whose envelope DOES carry a
    p121 — under a confirmed country of HU would raise TypeError and
    500 the route.
    """
    if anchor is None:
        return {}
    try:
        import inspect
        params = inspect.signature(assembler).parameters
    except (TypeError, ValueError):  # pragma: no cover — builtins/C funcs
        return {}
    if "account_121_anchor_override" not in params and not any(
        p.kind is p.VAR_KEYWORD for p in params.values()
    ):
        return {}
    return {"account_121_anchor_override": float(anchor)}


def _stock_variation_evidence_for(
    period_row: Optional[Dict[str, Any]],
) -> Dict[str, Any]:
    """The `stock_variation/1` evidence a period was persisted with — read
    back for a REBUILD (owner ruling 2026-09-26: net 711 / net 72x are
    measured off the trial balance at persist time; the rows are never
    stored, so the envelope block is the only witness a rebuild has).

    Sources: ``period.assembled_canonical_v1.stock_variation`` (the full
    envelope), or a flat ``stock_variation`` alias a light projection may
    select (``stock_variation:assembled_canonical_v1->stock_variation``).

    Absent → an absence marker whose reason says which absence it is:
    the envelope was read and carries no block (a period written before
    the measurement existed — it is reprocessed at deploy), or the row
    handed here never selected the envelope at all. Either way net 711
    REFUSES on a book that posts to 711; it is never read off the line
    amount (the gross production stocked) and never 0.00.
    """
    from engine.country_packs.ro_romania import stock_variation as _stock_variation

    row = period_row or {}
    flat = row.get("stock_variation")
    if _stock_variation.is_measured(flat):
        return dict(flat)
    env = row.get("assembled_canonical_v1")
    if isinstance(env, dict):
        block = env.get("stock_variation")
        if _stock_variation.is_measured(block):
            return dict(block)
        return _stock_variation.absent_evidence(_stock_variation.REASON_PREDATES)
    return _stock_variation.absent_evidence(_stock_variation.REASON_ENVELOPE_NOT_READ)


def _evidence_kwargs(assembler: Any, evidence: Dict[str, Any]) -> Dict[str, Any]:
    """`{"stock_variation_evidence": evidence}` when `assembler` accepts it
    — the same capability probe as `_anchor_kwargs`, for the same reason
    (the review/reanalyze route may assemble through the HU pack)."""
    try:
        import inspect
        params = inspect.signature(assembler).parameters
    except (TypeError, ValueError):  # pragma: no cover — builtins/C funcs
        return {}
    if "stock_variation_evidence" not in params and not any(
        p.kind is p.VAR_KEYWORD for p in params.values()
    ):
        return {}
    return {"stock_variation_evidence": evidence}


def _assemble_with_statutory_anchor(
    assembler: Any,
    accounts: List[Dict[str, Any]],
    *,
    period_row: Optional[Dict[str, Any]],
    line_items: Optional[List[Dict[str, Any]]],
    **assemble_kwargs: Any,
) -> Dict[str, Any]:
    """THE ONLY WAY a rebuild path may call `assemble_statements()`.

    Resolve → thread → label, as one indivisible step. The defect this
    exists to prevent was not "someone wrote the wrong number"; it was
    that resolving the anchor, passing it to the assembler, and telling
    the reader what happened were three separate acts, so a seam could
    do one and skip the others and still look finished. Fusing them
    means a new rebuild seam either goes through here and is correct, or
    does not and is visible to `test_every_rebuild_call_site_threads_
    the_anchor`.

    The stock-variation evidence (net 711 / net 72x, the ONE EBITDA) is
    threaded by the same call for the same reason: a rebuild seam that
    re-assembled without it would serve a refused 711 on every
    manufacturer — or, worse, a seam that forgot it once read the line
    amount. `_stock_variation_evidence_for` is the only reader.
    """
    anchor, source = _statutory_anchor_for(period_row, line_items)
    anchor_kwargs = _anchor_kwargs(assembler, anchor)
    evidence_kwargs = _evidence_kwargs(
        assembler, _stock_variation_evidence_for(period_row)
    )
    assembled = assembler(accounts, **assemble_kwargs, **anchor_kwargs,
                          **evidence_kwargs)
    _annotate_net_income_anchor(
        assembled, anchor, source,
        applied=_anchor_reached_the_assembler(assembled, anchor, anchor_kwargs),
    )
    return assembled


def _anchor_reached_the_assembler(
    assembled: Optional[Dict[str, Any]],
    anchor: Optional[float],
    anchor_kwargs: Dict[str, Any],
) -> bool:
    """Did the assembler ACTUALLY receive the anchor? Read the answer off
    its own output, never off the caller's intent.

    `assemble_statements` copies the anchor it resolved into
    `assembled_canonical_v1.canonical_bs.invariants.p121_cross_check
    .p121` (chart_of_accounts.py:1714 → canonical_adapter.py:1556), so
    that field is a witness: if it equals what we handed over, the value
    was received.

    Trusting `bool(anchor_kwargs)` instead would mean trusting that the
    kwargs dict we built was also passed — which is precisely the class
    of mistake this whole change exists to remove. A caller that
    resolves an anchor and then drops it on the way to the assembler
    must end up labelled `absent`, not `within_tolerance`.

    Fallback: when the pack emits no p121 cross-check block at all
    (a non-RO pack), there is no witness and the caller's intent is all
    there is. When the block EXISTS but carries a null p121, that is a
    real answer — the assembler had no anchor — and it is honoured, even
    though a BS-only extract lands there with an anchor that simply had
    no P&L to apply to. Calling that `absent` is conservative and never
    misleading: there is no reconstruction being passed off as statutory.
    """
    if anchor is None:
        return False
    block = None
    if isinstance(assembled, dict):
        env = assembled.get("assembled_canonical_v1")
        if isinstance(env, dict):
            cbs = env.get("canonical_bs")
            if isinstance(cbs, dict):
                block = (cbs.get("invariants") or {}).get("p121_cross_check")
    if not isinstance(block, dict):
        return bool(anchor_kwargs)
    witnessed = block.get("p121")
    if witnessed is None:
        return False
    try:
        return abs(float(witnessed) - float(anchor)) < 0.005
    except (TypeError, ValueError):
        return False


#: Anchor provenance is stamped by ONE code object
#: (`engine.core.net_income_anchor.annotate_net_income_anchor`), shared
#: with the offline seam `RomaniaPack.assemble_parsed_tb`. This name is
#: kept as the pipeline-local alias because every rebuild call site and
#: `tests/engine/test_rebuild_net_income_anchor.py` reach it through the
#: pipeline module. The docstring the rule is written in lives with the
#: implementation, not here, so there is only one place to read it.
_annotate_net_income_anchor = _net_income_anchor.annotate_net_income_anchor


def _apply_envelope_truth_to_statements(
    statements: Dict[str, Any], period: Dict[str, Any]
) -> None:
    """Serve the persisted write-time BS truth onto a re-assembled
    `statements` dict, in place. ONE code object shared by /api/period
    and `_rebuild_assembled_for_briefing` — the audit found the briefing
    rebuild replicated the lossy round-trip WITHOUT the Fix A1 override,
    so a regenerated briefing could cite different totals than the tab.

    Two-tier source, per docs/CANONICAL_BS_V2_CONTRACT.md — both tiers
    resolved through ONE authority object, `engine.serving.facts
    .FactsGateway` (sv1):
      1. `period.assembled_canonical_v1.canonical_bs` (bs_v2) — the
         gateway's SERVED copy (reconciliation applied) is served
         VERBATIM as `statements.canonical_bs` (the FE renders it with
         zero arithmetic) AND sources the assembled_bs totals.
      2. Legacy envelopes (no canonical_bs key): the original Fix A1
         path — the gateway's methodology tier (`methodology.totals`)
         overrides the same 8 fields.
    Either way the source is the PERSISTED envelope (`period[...]`), never
    the re-assembled one: the recomputed envelope reproduces the exact
    round-trip drift this override exists to replace (0.44%–35.47%
    across the 8 fixtures, scripts/measure_bs_drift_roundtrip.py).

    The re-assembled `statements.assembled_canonical_v1.canonical_bs`
    (assemble_statements now always attaches one) is likewise replaced
    with the persisted object — or popped on legacy periods — so a
    round-trip artifact can never be served as the BS authority.
    """
    try:
        _env = period.get("assembled_canonical_v1") or {}
        _served_env = statements.get("assembled_canonical_v1")
        # sv1 FACTS GATEWAY (engine.serving.facts) — the ONE typed reader
        # of served balance-sheet truth. Internally runs the AUTO-RECONCILE
        # serve path (`_reconcile.served_canonical_bs`): the stored
        # accepted reconciliation (written by the automatic persist-seam
        # stage or the ops POST, keyed by provenance.content_hash) is
        # applied to a SERVED COPY (status RECONCILED, difference 0,
        # visible line + receipt + sv1 stamps), and every totals-level
        # figure below is the reconciliation-ADJUSTED value. The
        # persisted canonical_bs itself is never touched (source cents
        # never overwritten), and the deterministic build path never
        # sees any of this. Legacy (pre-canonical_bs) envelopes resolve
        # through the same gateway from methodology.totals.
        _gateway = _FactsGateway.from_envelope(
            _env, currency=str(statements.get("currency") or "RON")
        )
        if _gateway is None:
            # Nothing persisted to override with (pre-F4.1e row) — the
            # recomputed canonical_bs (if any) is a round-trip artifact.
            if isinstance(_served_env, dict):
                _served_env.pop("canonical_bs", None)
            return
        if _gateway.tier == _FactsGateway.TIER_SUMMARY:
            # PS1 GUARD — a public_summary envelope (reduced open-data
            # filing) must never be served as BS truth on this hook: no
            # canonical_bs, no assembled_bs total overrides. The public
            # storefront serves summaries through its own routes
            # (engine.public_ro), never through /api/period statements.
            if isinstance(_served_env, dict):
                _served_env.pop("canonical_bs", None)
            return
        _cbs = _gateway.served_canonical_bs
        if isinstance(_cbs, dict):
            # canonical_bs v2 path — serve verbatim.
            statements["canonical_bs"] = _cbs
            if isinstance(_served_env, dict):
                _served_env["canonical_bs"] = _cbs
            # PLACEMENT RULE (auto-reconcile addendum): a P&L-placed
            # reconciliation ("Diferențe de reconciliere" caused by a
            # class 6/7 account) reaches the BS through the result row;
            # the visible LINE is served on `statements.assembled_pl`
            # as `reconciliation_adjustment` so the P&L view renders it.
            # `amount` is the signed effect on the result (+ income /
            # − expense); extracted P&L figures are never altered.
            _rec = _cbs.get("reconciliation")
            if (
                _cbs.get("status") == "RECONCILED"
                and isinstance(_rec, dict)
                and str(_rec.get("placement") or "") == _reconcile.PLACEMENT_PL
            ):
                _a_pl = statements.get("assembled_pl")
                if isinstance(_a_pl, dict):
                    _a_pl["reconciliation_adjustment"] = {
                        "label": _reconcile.SYNTHETIC_ROW_LABEL,
                        "placement": _rec.get("placement_detail")
                        or (
                            _reconcile.PLACEMENT_DETAIL_PL_INCOME
                            if float(_rec.get("applied_delta") or 0) >= 0
                            else _reconcile.PLACEMENT_DETAIL_PL_EXPENSE
                        ),
                        "amount": float(_rec.get("applied_delta") or 0.0),
                        "synthetic": True,
                    }
        elif isinstance(_served_env, dict):
            # Legacy envelope — recomputed canonical_bs (if any) is a
            # round-trip artifact; never serve it as an authority.
            _served_env.pop("canonical_bs", None)
        _ta = _gateway.total_assets().to_float()
        _te = _gateway.equity().to_float()
        _tl = _gateway.total_liabilities().to_float()
        _delta = _gateway.difference().to_float()
        try:
            _cur_a = _gateway.current_assets().to_float()
        except _MissingFact:
            _cur_a = None
        try:
            _cur_l = _gateway.current_liabilities().to_float()
        except _MissingFact:
            _cur_l = None
        # Fix A1 (+ 2026-08-13 extension) — GRAND TOTALS and the balance
        # delta must come from the write-time envelope; the re-assembled
        # values are round-trip artifacts (the "39.19M vs 45.81M" screen).
        # Section-level sub-aggregates beyond current/non-current stay
        # round-tripped — neither source carries them.
        _a_bs = statements.get("assembled_bs") or {}
        _a_bs["bs_balance_delta"] = round(_delta, 2)
        _a_bs["total_assets"] = round(_ta, 2)
        _a_bs["total_equity"] = round(_te, 2)
        _a_bs["total_liabilities"] = round(_tl, 2)
        if _cur_a is not None:
            _a_bs["total_current_assets"] = round(_cur_a, 2)
            _a_bs["total_non_current_assets"] = round(_ta - _cur_a, 2)
        if _cur_l is not None:
            _a_bs["total_current_liabilities"] = round(_cur_l, 2)
            _a_bs["total_non_current_liabilities"] = round(_tl - _cur_l, 2)
        statements["assembled_bs"] = _a_bs
        # RUN JOURNAL — SERVED (the serve seam). Deduplicated inside the
        # hook: appends only when the served state differs from the last
        # recorded one, and self-heals the chain when the persisted
        # envelope changed out-of-band (e.g. reconcile undo).
        _journal_hooks.on_served(_env, _cbs if isinstance(_cbs, dict) else None)
    except Exception:  # noqa: BLE001
        logger.exception(
            "[envelope-truth] persisted-envelope override failed (non-fatal)"
        )


# ── The insight block (engine.insights) on the served statements ─────
#
# `engine.insights.build_insights` reads a FINISHED book and says what a
# sharp reader would notice — 70.4% of Agras' gross PP&E already written
# off, a current ratio of 2.11x that is 1.51x once intercompany comes
# out, the 46,613.06 in account 413 that no statement line explains. It
# was built, tested and committed and CALLED FROM NOWHERE, so
# `statements.insights` was absent on every served payload and the
# report showed none of it.
#
# TWO SEAMS, ONE CODE OBJECT. `statements` reaches a reader down exactly
# two paths and this helper is called at the end of both:
#   1. `get_period`                     — GET /api/period/{period_id},
#                                         what the report renders
#   2. `_rebuild_assembled_for_briefing` — the shared served-rebuild seam
#                                         (Capsule, Radar, firm attention,
#                                         briefing regenerate)
# CLAUDE.md §14 records what a field threaded into one and not the other
# costs: the account-121 anchor reached the persist path only and every
# served "statutory" net income was a raw reconstruction for months.
# Both call sites sit immediately after
# `_apply_envelope_truth_to_statements`, so the book the detectors read
# is the SERVED book — the same reconciliation-adjusted `canonical_bs`
# the FE renders, never the round-trip artifact.
def _attach_insights_block(
    statements: Dict[str, Any], line_items: Optional[List[Dict[str, Any]]]
) -> None:
    """Attach `statements["insights"]` in place, or leave the key ABSENT.

    ABSENT != ZERO, and this helper is where that law is enforced for
    the wire. The engine's `not_fired` entries are stated gaps, which are
    information — but only when the book was actually READ. Measured on
    the agras fixture with its envelope withheld (the book that really
    does carry 46,613.06 under an Unclassified row):

        unclassified_balances | Every account in the book matched a
        classification rule; no balance is carried under an Unclassified row.

    That is a false all-clear produced by absence, not by a clean book.
    So the block is served only when the payload carries BOTH authorities
    the detectors read — the assembled P&L and the SERVED canonical rows.
    Without them there is no block at all and the reader (`readInsights`
    returns null) renders nothing, which is the truth.

    Never raises: a failure here must not cost the reader the report, the
    same rule the industry-signal block follows. On failure the key stays
    absent rather than half-written.
    """
    try:
        if not isinstance(statements, dict):
            return
        pl = statements.get("assembled_pl")
        if not isinstance(pl, dict) or not pl:
            return

        # The envelope handed to the detectors, in one authority order:
        # the served canonical envelope if the re-assembly produced one
        # (its `canonical_bs` has already been REPLACED with the served
        # copy by `_apply_envelope_truth_to_statements`), else the served
        # `canonical_bs` on its own — which is what remains when the
        # re-assembly failed but the persisted envelope was still served.
        envelope = None  # type: Optional[Dict[str, Any]]
        _env = statements.get("assembled_canonical_v1")
        if isinstance(_env, dict) and isinstance(_env.get("canonical_bs"), dict):
            envelope = _env
        else:
            _cbs = statements.get("canonical_bs")
            if isinstance(_cbs, dict):
                envelope = {"canonical_bs": _cbs}
        if envelope is None:
            return
        rows = (envelope.get("canonical_bs") or {}).get("rows")
        if not isinstance(rows, list) or not rows:
            return

        from engine.insights import build_insights as _build_insights

        # `drafter=None`: no model, no network, no clock — a pure
        # function of the book, which is what makes the served block
        # byte-identical across two reads of the same period.
        block = _build_insights({
            "statements": statements,
            "envelope": envelope,
            "line_items": [li for li in (line_items or []) if isinstance(li, dict)],
        })
        if not isinstance(block, dict):
            return
        if not block.get("insights") and not block.get("not_fired"):
            # A pack with no detectors. Nothing was checked, so nothing
            # may be claimed — absent, not an empty list.
            return
        statements["insights"] = block
    except Exception:  # noqa: BLE001
        logger.exception("[insights] block build failed (non-fatal, key stays absent)")


def _complete_bucket_equity(
    bs: Dict[str, float],
    pl: Dict[str, float],
    period: Optional[Dict[str, Any]],
    *,
    inv_var_711: float = 0.0,
) -> None:
    """Complete the bucket-summed equity of a rebuild from line items, in
    place, on `bs["retainedEarnings"]`. THE ONE COMPLETION: every seam
    that rebuilds `balanceSheet` from `statement_line_items` calls this —
    `_rebuild_assembled` (valuation routes), `get_period`
    (GET /api/period/{id}, and through it the comparatives route) and
    `_rebuild_assembled_for_briefing` (the Capsule tools, Radar, the firm
    attention lane, briefing regenerate and the forecast route; joined
    2026-09-15, ruling Q1).

    `pl` is the P&L bucket dict of the same rebuild; `inv_var_711` is the
    account-711 production variation still INCLUDED in `pl["otherIncome"]`
    (0.0 when the caller already carved it out), subtracted from the
    legacy net-income fallback only.

    2026-09-14 (ratios B4, step 0): `get_period` summed the line items into
    `statements.balanceSheet` WITHOUT this completion, so the served
    `retainedEarnings` / bucket equity were short by exactly
    `assembled_pl.net_income_statutory` (agras 7,533,676.02; carniprod
    1,435,533.59; realestate -801,604.14; retail 3,205,212.62) beside a
    served `canonical_bs` that carried the complete equity. Any reader of
    the legacy view (the credit model's X2/X4, the equity sub-score, the
    workbook's Retained earnings row) read a second equity. Now both
    rebuilds share this code object;
    `tests/engine/test_served_equity_completion.py` holds the served
    bucket equity to the served canonical equity to the cent.
    """
    # Equity completion (audit, persistence section): statement_line_items
    # never persist the current-year result — assemble_statements adds it
    # to retainedEarnings in-memory at write time only — so a rebuild from
    # rows understates equity by exactly net income, and the valuation
    # fallback (`total_equity = shareCapital + retainedEarnings +
    # otherEquity` in _valuation.py) inherited the gap. Complete it here:
    #   1. Envelope-true when the period row carries the write-time
    #      canonical envelope: `FactsGateway.equity()` — the SERVED,
    #      reconciliation-ADJUSTED equity (canonical_bs tier, else the
    #      legacy methodology tier). Adjust retainedEarnings so
    #      bucket-summed equity equals the served engine truth — this
    #      also absorbs any other round-trip equity loss.
    #   2. Legacy fallback (no envelope): add the net income
    #      reconstructed from the persisted P&L buckets, 711 excluded
    #      (non-cash production variation).
    #
    # sv1 INTENTIONAL NUMBER CHANGE (the ONE in this effort): this read
    # previously took the PERSISTED canonical_bs['totals']['equity'] RAW
    # — bypassing `served_canonical_bs` — so on RECONCILED periods the
    # Valuation tab (POST/DELETE /valuation-assumptions + POST
    # /valuation/recompute → persisted valuations row → tab + dashboard
    # hero) valued the company on PRE-reconciliation equity while every
    # other surface served the adjusted figure. The gateway read makes
    # valuation equity the ADJUSTED (reconciliation-inclusive) figure.
    # BALANCED periods are numerically unchanged (adjusted == raw).
    _env_te: Optional[float] = None
    if period:
        _gw = _FactsGateway.from_envelope(period.get("assembled_canonical_v1") or {})
        if _gw is not None:
            try:
                _env_te = _gw.equity().to_float()
            except _MissingFact:
                _env_te = None
    _bucket_equity = bs["shareCapital"] + bs["retainedEarnings"] + bs["otherEquity"]
    if _env_te is not None:
        bs["retainedEarnings"] += round(_env_te - _bucket_equity, 2)
    else:
        _ni = (
            pl["revenue"]
            + (pl["otherIncome"] - inv_var_711)
            + pl["financialIncome"]
            - pl["costOfGoodsSold"]
            - pl["operatingExpenses"]
            - pl["depreciationAmortization"]
            - pl["interestExpense"]
            - pl["financialExpense"]
            - pl["taxExpense"]
        )
        bs["retainedEarnings"] += round(_ni, 2)



def _rebuild_assembled(
    line_items: List[Dict[str, Any]],
    period: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Reconstruct the `assembled.statements`-shaped dict the valuation
    engine expects, given the persisted statement_line_items for a period.
    Mirrors the bucket map used in /api/period/:id."""
    bs_buckets = {
        "cash": "cash", "ar": "accountsReceivable", "inventory": "inventory",
        "otherCurrentAssets": "otherCurrentAssets",
        "ppe": "propertyPlantEquipment", "intangibles": "intangibles",
        "otherNonCurrentAssets": "otherNonCurrentAssets",
        "ap": "accountsPayable", "stDebt": "shortTermDebt", "otherCurrentLiab": "otherCurrentLiabilities",
        "ltDebt": "longTermDebt", "otherNonCurrentLiab": "otherNonCurrentLiabilities",
        "shareCapital": "shareCapital", "retainedEarnings": "retainedEarnings", "otherEquity": "otherEquity",
    }
    pl_buckets = {
        "revenue": "revenue", "cogs": "costOfGoodsSold", "operatingExpenses": "operatingExpenses",
        "depreciation": "depreciationAmortization", "interestExpense": "interestExpense",
        "otherIncome": "otherIncome", "financialIncome": "financialIncome",
        "financialExpense": "financialExpense", "taxExpense": "taxExpense",
    }
    bs: Dict[str, float] = {v: 0.0 for v in bs_buckets.values()}
    pl: Dict[str, float] = {v: 0.0 for v in pl_buckets.values()}
    # 711 production-variation lines persist under bucket `otherIncome`
    # (DB CHECK constraint) but are a non-cash accrual — tracked apart so
    # the net-income reconstruction below doesn't inflate equity by it.
    # The returned `otherIncome` bucket keeps including 711 (unchanged
    # legacy behavior for the valuation consumers of this shape).
    inv_var_711 = 0.0
    for item in line_items:
        bucket = item["bucket"]
        amount = float(item["amount"] or 0)
        code = (item.get("ro_account_code") or "").strip()
        if bucket in bs_buckets:
            bs[bs_buckets[bucket]] += amount
        elif bucket in pl_buckets:
            if bucket == "otherIncome" and code.startswith("711"):
                inv_var_711 += amount
            pl[pl_buckets[bucket]] += amount

    _complete_bucket_equity(bs, pl, period, inv_var_711=inv_var_711)

    return {"balanceSheet": bs, "incomeStatement": pl}


def _served_supplementary(period: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """`statements.supplementary` for a served period row — ONE rule for
    every served-rebuild seam (/api/period and `_rebuild_assembled_for_
    briefing`, which the Capsule, Radar, Forecast and the firm lane read).

    `periodDays` is established from the row: a stated span
    (`period_start` before `period_end`), or the period end with the
    detection record `stage_persist` stamped on the envelope
    (`period_detection.signal_used`), counted from the pack's financial-
    year start — `chart_of_accounts.period_days_covered`. Otherwise it is
    None and `periodDaysRefusal` says why. It was a hard-coded 365 at both
    seams, which served a June year-to-date book's DSO / DIO / DPO at
    twice their value under a provenance that read like a measured field.

    An established period serves exactly `{"periodDays": n}` — the same
    bytes as before for every 31 December book on the corpus.
    """
    row = period or {}
    env = row.get("assembled_canonical_v1")
    record = env.get("period_detection") if isinstance(env, dict) else None
    signal = record.get("signal_used") if isinstance(record, dict) else None
    covered = _ro_chart_of_accounts.period_days_covered(
        row.get("period_end"), period_start=row.get("period_start"),
        signal_used=signal if isinstance(signal, str) else None,
    )
    if covered["days"] is not None:
        return {"periodDays": covered["days"]}
    return {"periodDays": None, "periodDaysRefusal": covered["refusal"]}


# ── plan/2 B5 (plan_contract_v2 1.4): the ONE period reader ─────────────
class PeriodNotFound(LookupError):
    """No financial_periods row answers this id (and org, when given)
    through the caller's client."""


class StatementsRebuildError(RuntimeError):
    """The statements of a persisted period could not be rebuilt from its
    rows. Carries the sentence a reader is answered with; never swallowed
    into ``statements=None`` (the forecast route did that until B5 and then
    projected off a period with no statements)."""

    CODE = "statements_rebuild_failed"

    def __init__(self, period_id: str, cause: BaseException) -> None:
        self.period_id = period_id
        self.cause = cause
        self.text = ("the statements of this period could not be rebuilt from "
                     "its stored rows (%s), so nothing is projected from it"
                     % (type(cause).__name__,))
        RuntimeError.__init__(self, self.text)

    def sentence(self) -> Dict[str, str]:
        return {"code": self.CODE, "text": self.text}


def load_period_rows(client: Any, period_id: str, org_id: Optional[str] = None,
                     rebuild: bool = True,
                     line_item_columns: Optional[str] = None) -> Dict[str, Any]:
    """Read one persisted period through the CALLER'S client (RLS scopes it).

    Selects the financial_periods row filtered on id, and on org_id when one
    is given (a second lock on top of RLS, never the only one); the period's
    statement_line_items; the organizations row of that period's org; and,
    when ``rebuild`` is true, the statements of
    ``_rebuild_assembled_for_briefing(line_items, row, org)``. Returns
    ``{row, org, line_items, statements}``; ``statements`` is None when
    ``rebuild`` is false. Raises PeriodNotFound, or StatementsRebuildError
    when the rebuild fails."""
    filters = {"id": f"eq.{period_id}"}
    if org_id is not None:
        filters["org_id"] = f"eq.{org_id}"
    rows = client.select("financial_periods", filters=filters, single=True) or []
    if not rows:
        raise PeriodNotFound(period_id)
    row = rows[0]
    item_kwargs: Dict[str, Any] = {}
    if line_item_columns is not None:
        item_kwargs["columns"] = line_item_columns
    line_items = client.select("statement_line_items",
                               filters={"period_id": f"eq.{period_id}"},
                               **item_kwargs) or []
    org_rows = client.select("organizations",
                             filters={"id": f"eq.{row.get('org_id')}"},
                             single=True) or []
    org = org_rows[0] if org_rows else None
    statements = None
    if rebuild:
        try:
            statements = _rebuild_assembled_for_briefing(
                line_items, row, org).get("statements")
            if not isinstance(statements, dict):
                raise ValueError("the rebuild returned no statements")
            # B5V-6: _rebuild_assembled_for_briefing SWALLOWS its canonical
            # re-assembly failure ("non-fatal; falling back to bucket
            # aggregates only") and returns statements with no assembled
            # P&L. That is this function's failure mode, not a success: a
            # caller that asked for the rebuild gets the refusal, and
            # scripts/measure_statement_rebuilds.py counts it.
            for name in ("assembled_pl", "assembled_bs"):
                if not isinstance(statements.get(name), dict):
                    raise ValueError("the rebuild returned no %s" % name)
        except Exception as exc:  # noqa: BLE001
            logger.exception("[load_period_rows] statements rebuild failed for %s",
                             period_id)
            raise StatementsRebuildError(period_id, exc)
    return {"row": row, "org": org, "line_items": line_items,
            "statements": statements}


def _rebuild_assembled_for_briefing(
    line_items: List[Dict[str, Any]],
    period: Dict[str, Any],
    org: Optional[Dict[str, Any]],
) -> Dict[str, Any]:
    """Rebuild the FULL canonical-shaped `assembled` envelope the way
    /api/period/{period_id} does — i.e. with `statements.assembled_pl`,
    `assembled_bs`, `assembled_cf`, `companyName`, `currency`,
    `periodLabel` populated — so `stage_narrate` can read its
    `briefing_facts` from operating-view canonical values rather than
    the coarse bucket sums returned by `_rebuild_assembled`.

    Mirrors the canonical-reassembly block in `/api/period/{period_id}`
    (search "canonical re-assembly" in this file). Used by the F2.8
    `POST /api/period/{period_id}/briefing/regenerate` endpoint so the
    regenerated briefing cites the same numbers the dashboard renders.
    """
    # F3.1c: dispatch via the Romania country pack rather than direct
    # `_ro_coa` import. `_coa_mod` alias preserved so the call sites
    # below read identically — the alias now points at the pack.
    _coa_mod = _ro_pack()

    # ── Legacy bucket aggregates (same map as _rebuild_assembled and
    # the /api/period reconstruction). Needed so the response carries
    # balanceSheet + incomeStatement alongside the canonical views.
    bs_buckets = {
        "cash": "cash", "ar": "accountsReceivable", "inventory": "inventory",
        "otherCurrentAssets": "otherCurrentAssets",
        "ppe": "propertyPlantEquipment", "intangibles": "intangibles",
        "otherNonCurrentAssets": "otherNonCurrentAssets",
        "ap": "accountsPayable", "stDebt": "shortTermDebt",
        "otherCurrentLiab": "otherCurrentLiabilities",
        "ltDebt": "longTermDebt",
        "otherNonCurrentLiab": "otherNonCurrentLiabilities",
        "shareCapital": "shareCapital",
        "retainedEarnings": "retainedEarnings",
        "otherEquity": "otherEquity",
    }
    pl_buckets = {
        "revenue": "revenue", "cogs": "costOfGoodsSold",
        "operatingExpenses": "operatingExpenses",
        "depreciation": "depreciationAmortization",
        "interestExpense": "interestExpense",
        "otherIncome": "otherIncome",
        "financialIncome": "financialIncome",
        "financialExpense": "financialExpense",
        "taxExpense": "taxExpense",
    }
    bs: Dict[str, float] = {v: 0.0 for v in bs_buckets.values()}
    pl: Dict[str, float] = {v: 0.0 for v in pl_buckets.values()}
    inv_var_memo = 0.0
    for item in line_items:
        bucket = item["bucket"]
        amount = float(item["amount"] or 0)
        code = (item.get("ro_account_code") or "").strip()
        if bucket in bs_buckets:
            bs[bs_buckets[bucket]] += amount
        elif bucket in pl_buckets:
            if bucket == "otherIncome" and code.startswith("711"):
                inv_var_memo += amount
            else:
                pl[pl_buckets[bucket]] += amount

    # Equity completion — THE ONE COMPLETION (`_complete_bucket_equity`),
    # exactly as `get_period` runs it: on the cent-rounded buckets, with
    # 711 already carved out of `pl["otherIncome"]` (hence 0.0). Until
    # 2026-09-15 (ratios R2b, ruling Q1) this seam summed the line items
    # with no completion, so the Capsule tools, Radar, the firm attention
    # lane, a regenerated briefing and the forecast route served a
    # retainedEarnings short by the year's result beside the complete
    # equity GET /api/period serves for the same period.
    bs = {k: round(v, 2) for k, v in bs.items()}
    _complete_bucket_equity(bs, pl, period, inv_var_711=0.0)

    statements: Dict[str, Any] = {
        "companyName": (org or {}).get("name") if org else None,
        "industry": (org or {}).get("industry_display_name") if org else None,
        "currency": period.get("currency", "RON"),
        "periodLabel": period.get("period_end"),
        "balanceSheet": {k: round(v, 2) for k, v in bs.items()},
        "incomeStatement": {
            **{k: round(v, 2) for k, v in pl.items()},
            "inventoryVariationMemo": round(inv_var_memo, 2),
        },
        "supplementary": _served_supplementary(period),
    }

    # ── Canonical reassembly via assemble_statements ─────────────────
    # Same flow as /api/period: rebuild `recovered_accounts` from
    # line_items (preserving bucket_override for side-flipped rows),
    # re-apply sign for rule.sign==-1, then call assemble_statements.
    try:
        recovered_accounts: List[Dict[str, Any]] = []
        for li in (line_items or []):
            code = li.get("ro_account_code") or ""
            if not code:
                continue
            stored_bucket = li.get("bucket") or li.get("canonical_bucket") or ""
            rule = _coa_mod.bucket_for(code)
            bucket_override = None
            if rule and stored_bucket and stored_bucket != rule.bucket:
                legacy = _coa_mod.persistence_bucket(rule.bucket)
                if stored_bucket != legacy:
                    bucket_override = stored_bucket
            row = {
                "code": code,
                "name": li.get("ro_account_name") or "",
                "amount": float(li.get("amount") or 0),
            }
            if bucket_override:
                row["bucket_override"] = bucket_override
            recovered_accounts.append(row)
        # Re-apply sign so assemble_statements sees the raw input.
        for acct in recovered_accounts:
            rule = _coa_mod.bucket_for(acct["code"])
            if rule and rule.sign == -1:
                acct["amount"] = -acct["amount"]
        # Account 121 anchor — see `_assemble_with_statutory_anchor`.
        # Without it this seam serves a raw class-6/7 reconstruction
        # under the statutory name, on every surface that reads it: the
        # Capsule's statements context, Radar's `s_engine` facts, the
        # firm attention lane, and the regenerated briefing.
        assembled_full = _assemble_with_statutory_anchor(
            _coa_mod.assemble_statements,
            recovered_accounts,
            period_row=period,
            line_items=line_items,
            company_name=statements["companyName"] or "Entity",
            currency=statements["currency"],
            period_label=str(statements["periodLabel"]) if statements["periodLabel"] else "Period",
            industry=(org or {}).get("industry_key") if org else None,
        )
        statements["assembled_bs"] = assembled_full["statements"].get("assembled_bs")
        statements["assembled_pl"] = assembled_full["statements"].get("assembled_pl")
        statements["assembled_cf"] = assembled_full["statements"].get("assembled_cf")
        statements["assembled_bands"] = assembled_full["statements"].get("assembled_bands")
        statements["assembled_piotroski"] = assembled_full["statements"].get("assembled_piotroski")
        statements["subAggregates"] = assembled_full["statements"].get("subAggregates")
        # F4.1e — surface the country-agnostic canonical envelope on the
        # response statements. Lives at top level of `assembled_full`
        # (sibling of `statements`), NOT under statements.assembled_*.
        # Source: chart_of_accounts.assemble_statements line ~1817.
        statements["assembled_canonical_v1"] = assembled_full.get("assembled_canonical_v1")
        # F4.3 — surface the detection envelope (country/standard/doc_type/
        # industry + methodology pin per CANONICAL_SCHEMA_V1.md §7).
        try:
            from engine.detection import build_detection_envelope as _bde  # type: ignore
            statements["detection_envelope"] = _bde(
                classification=None, assembled=assembled_full,
                methodology_id="ro_ras_2025_v1",
                industry_key=(org or {}).get("industry_key") if org else None,
                currency=statements.get("currency"),
                period_end=str(statements.get("periodLabel") or ""),
            )
        except Exception:  # noqa: BLE001
            logger.exception("[briefing/regenerate] detection envelope build failed (non-fatal)")
    except Exception:  # noqa: BLE001
        logger.exception(
            "[briefing/regenerate] canonical re-assembly failed (non-fatal); "
            "falling back to bucket aggregates only"
        )

    # canonical_bs v2 / Fix A1 extension — the audit found this rebuild
    # replicated the /api/period round-trip WITHOUT the envelope-truth
    # override, so a regenerated briefing could cite lossy totals while
    # the dashboard showed envelope truth (two books on one screen,
    # narrative edition). Same shared helper as /api/period: serves the
    # persisted canonical_bs verbatim and overrides the assembled_bs
    # grand/current totals from the write-time envelope.
    _apply_envelope_truth_to_statements(statements, period)

    # SEAM 2 of 2 — the insight block on the shared served-rebuild seam,
    # so the Capsule, Radar, the firm attention lane and a regenerated
    # briefing read the same block /api/period serves. See
    # `_attach_insights_block`.
    _attach_insights_block(statements, line_items)

    # F4.6 — surface deprecated-field warnings on the response so
    # consumers can migrate ahead of the 2Q sunset (~Nov 2026).
    payload = {"statements": statements}
    try:
        from .deprecated_fields import attach_deprecated_fields
        attach_deprecated_fields(payload)
    except Exception:  # noqa: BLE001
        logger.exception("[briefing/regenerate] deprecated_fields attach failed (non-fatal)")
    return payload


def _serialize_valuation(valuation: Optional[Dict[str, Any]],
                          user_assumptions: Optional[Dict[str, Any]],
                          statements: Optional[Dict[str, Any]] = None) -> Optional[Dict[str, Any]]:
    """Shape the raw valuations row for the dashboard. Returns None when the
    pipeline never produced a valuation (non-financial doc, or failure).

    When `statements` is passed, we re-run `_valuation.compute_valuation`
    against the canonical assembled views so the FE gets the same
    operating-view / asset-based payload the pipeline computed at write
    time — including FCF breakdown with REAL CapEx, asset-based primary
    for CRE, and the explicit ebitda_statutory / _operational / _operating_view
    triple. The persisted DB row alone doesn't carry those fields, but
    they're deterministic from the canonical statements.
    """
    if not valuation:
        return None

    # ── Recompute the full valuation against canonical statements ────────
    # When statements (with assembled_*) are available, prefer the fresh
    # recomputation over the row — the row loses the asset-based card,
    # FCF breakdown, and method warnings on round-trip. Reapply user
    # assumptions on top so manual overrides still take effect.
    fresh: Optional[Dict[str, Any]] = None
    if statements and statements.get("assembled_pl"):
        try:
            industry_key = None
            if isinstance(statements.get("industry"), str):
                industry_key = statements["industry"]
            ua_dict = None
            if user_assumptions:
                ua_dict = {
                    k: user_assumptions.get(k)
                    for k in ("ebitda_used", "multiple_used", "debt_used", "cash_used",
                              "ebitda_definition")
                    if user_assumptions.get(k) is not None
                }
            fresh = _valuation.compute_valuation(
                industry_key=industry_key,
                statements=statements,
                user_assumptions=ua_dict,
            )
        except Exception:  # noqa: BLE001
            logger.exception("[/api/period] valuation fresh recompute failed (non-fatal)")
            fresh = None

    # Choose the source of truth: fresh recomputation if available, else the row.
    src = fresh if fresh is not None else valuation

    def f(key: str) -> Optional[float]:
        v = src.get(key)
        return None if v is None else float(v)

    multiple_p50 = f("multiple_ebitda_p50")
    ebitda = f("ebitda_used")
    debt = f("total_debt_used")
    cash = f("cash_used")
    primary_method = src.get("primary_method") or "ev_ebitda"
    is_asset_based_primary = primary_method == "asset_based"

    def _fmt(n: Optional[float]) -> str:
        if n is None:
            return "—"
        sign = "-" if n < 0 else ""
        a = abs(n)
        if a >= 1_000_000:
            return f"{sign}{a/1_000_000:.2f}M"
        if a >= 1_000:
            return f"{sign}{a/1_000:.0f}K"
        return f"{sign}{a:.0f}"

    if is_asset_based_primary:
        formula_text = (
            src.get("formula_text")
            or f"Equity = Book equity ({_fmt(src.get('total_equity_used'))}) "
               f"+ RE markup (1.2-1.5× book) − Debt + Cash"
        )
    else:
        formula_text = (
            f"Equity = EBITDA ({_fmt(ebitda)}) × {multiple_p50}× − Debt ({_fmt(debt)}) + Cash ({_fmt(cash)})"
            if multiple_p50 is not None
            else "Insufficient benchmark data for an EBITDA-multiple valuation."
        )

    football_field: List[Dict[str, Any]] = []
    # Prefer the engine's pre-built football field when fresh is available
    # — it already places asset-based as primary for CRE and demotes
    # EV/EBITDA. Fall back to row-derived rows for legacy paths.
    if fresh and isinstance(fresh.get("football_field"), list):
        football_field = list(fresh["football_field"])
    elif f("equity_ebitda_p25") is not None and not is_asset_based_primary:
        football_field.append({
            "method": "EV / EBITDA (peers)",
            "primary": True,
            "low": f("equity_ebitda_p25"),
            "mid": f("equity_ebitda_p50"),
            "high": f("equity_ebitda_p75"),
            "subtitle": (
                f"{f('multiple_ebitda_p25')}× — {f('multiple_ebitda_p50')}× — {f('multiple_ebitda_p75')}×"
                if f("multiple_ebitda_p25") is not None else None
            ),
        })
    # Only append from the row when fresh isn't available (else we'd
    # duplicate the rows fresh already produced).
    if not fresh and f("ev_revenue_equity_p25") is not None:
        football_field.append({
            "method": "EV / Revenue (peers)",
            "primary": False,
            "low": f("ev_revenue_equity_p25"),
            "mid": f("ev_revenue_equity_p50"),
            "high": f("ev_revenue_equity_p75"),
            "subtitle": (
                f"{f('multiple_revenue_p25')}× — {f('multiple_revenue_p50')}× — {f('multiple_revenue_p75')}×"
                if f("multiple_revenue_p25") is not None else None
            ),
        })
    if not fresh and f("dcf_equity_value") is not None:
        football_field.append({
            "method": "DCF (WACC + Gordon)",
            "primary": False,
            "low": f("dcf_sensitivity_low"),
            "mid": f("dcf_equity_value"),
            "high": f("dcf_sensitivity_high"),
            "subtitle": (
                f"WACC {float(src['dcf_wacc'])*100:.1f}%, g {float(src['dcf_terminal_growth'])*100:.1f}%"
                if src.get("dcf_wacc") is not None else None
            ),
        })

    return {
        "primary_method": primary_method,
        "primary_label": src.get("primary_label"),
        "primary_equity_value": f("primary_equity_value"),
        "primary_equity_low": f("primary_equity_low"),
        "primary_equity_high": f("primary_equity_high"),
        "method_warnings": src.get("method_warnings") or [],
        # FCF breakdown — Valuation tab tiles read these verbatim. Real
        # CapEx, statutory net income. Only available when fresh recompute
        # ran (canonical statements present).
        "fcf_breakdown": (fresh or {}).get("fcf_breakdown"),
        # THE ONE EBITDA (owner ruling 2026-09-26: net 711 and net 72x
        # inside), its definition revision and its typed refusal. The three
        # legacy view names are aliases of it. A valuation served from the
        # persisted row alone (no fresh recompute) states no definition: the
        # row does not carry one.
        "ebitda": f("ebitda"),
        "ebitda_definition": (fresh or {}).get("ebitda_definition"),
        "ebitda_refusal": (fresh or {}).get("ebitda_refusal"),
        "ebitda_statutory": f("ebitda_statutory"),
        "ebitda_operational": f("ebitda_operational"),
        "ebitda_operating_view": f("ebitda_operating_view"),
        # Why the primary method is what it is (sector / the margin rule /
        # the EBITDA's refusal or sign) and the NAV cap-rate NOI proxy
        # (EBITDA − net 711, "NOI (aproximare)") the NAV cascade reads.
        "routing": (fresh or {}).get("routing"),
        "noi_approximation": (fresh or {}).get("noi_approximation"),
        "confidence": src.get("confidence"),
        "multiples_source": src.get("multiples_source"),
        "multiples_as_of_date": str(src.get("multiples_as_of_date")) if src.get("multiples_as_of_date") else None,
        "formula_text": formula_text,
        "inputs": {
            "ebitda_used": ebitda,
            "revenue_used": f("revenue_used"),
            "total_debt_used": debt,
            "cash_used": cash,
        },
        "primary": {
            "method": primary_method,
            "multiple_p25": f("multiple_ebitda_p25"),
            "multiple_p50": multiple_p50,
            "multiple_p75": f("multiple_ebitda_p75"),
            "ev_p25": f("ev_ebitda_p25"),
            "ev_p50": f("ev_ebitda_p50"),
            "ev_p75": f("ev_ebitda_p75"),
            "equity_p25": f("equity_ebitda_p25"),
            "equity_p50": f("equity_ebitda_p50"),
            "equity_p75": f("equity_ebitda_p75"),
        },
        "cross_checks": {
            "revenue_multiple": {
                "multiple_p25": f("multiple_revenue_p25"),
                "multiple_p50": f("multiple_revenue_p50"),
                "multiple_p75": f("multiple_revenue_p75"),
                "equity_p25": f("ev_revenue_equity_p25"),
                "equity_p50": f("ev_revenue_equity_p50"),
                "equity_p75": f("ev_revenue_equity_p75"),
            },
            "dcf": {
                "wacc": f("dcf_wacc"),
                "terminal_growth": f("dcf_terminal_growth"),
                "enterprise_value": f("dcf_enterprise_value"),
                "equity_value": f("dcf_equity_value"),
                "sensitivity_low": f("dcf_sensitivity_low"),
                "sensitivity_high": f("dcf_sensitivity_high"),
                # Why the DCF refused ([] when it computed; None on the
                # legacy persisted-row path, which carries no reasons).
                "refusals": src.get("dcf_refusals"),
            },
        },
        "football_field": football_field,
        "user_assumptions": user_assumptions and {
            "ebitda_used": user_assumptions.get("ebitda_used"),
            "multiple_used": user_assumptions.get("multiple_used"),
            "debt_used": user_assumptions.get("debt_used"),
            "cash_used": user_assumptions.get("cash_used"),
            # Which EBITDA definition the override was typed under, and the
            # flag "salvat sub definiția anterioară a EBITDA" when it is not
            # today's (a row saved before the stamp existed reads NULL).
            "definition": _valuation.override_definition_status(user_assumptions),
        },
    }


def _workspace_is_archived(client: Any, org_id: Optional[str]) -> bool:
    """True when `org_id` names an ARCHIVED workspace (`organizations.
    archived_at` set — in its recovery window or HELD by the workspace
    migration, `purge_after` NULL). Nothing in an archived workspace is
    shown anywhere, so nothing in it may be hard-deleted through the
    product: `clear_recently_deleted` answers such a workspace with
    nothing, and `delete_period`, `permanent_delete_document` and the
    empty-period drop refuse it (2026-09-26 — a held archive keeps the
    originals a migration rollback points documents back at, and
    `financial_periods.source_document_id` is ON DELETE CASCADE). An org
    that cannot be read is treated as archived: a hard delete whose
    workspace cannot be named has no wall to pass."""
    org = str(org_id or "").strip()
    if not org:
        return True
    rows = client.select("organizations", filters={"id": f"eq.{org}"}, columns="id,archived_at", limit=1)
    if not rows:
        return True
    return rows[0].get("archived_at") is not None


def _maybe_drop_empty_period(period_id: str, *, org_id: str = "") -> None:
    """Hard-delete the period row when NO documents (live OR soft-deleted)
    reference it. Skipped when the period was created < 5 minutes ago
    (safety window — a freshly-uploaded doc may not yet have stage_persist
    pinned its period_id, and we don't want to race-delete its parent), and
    REFUSED when the period's workspace is archived (`_workspace_is_archived`:
    a held archive's periods are shown nowhere and must outlive any
    per-document cleanup; the rollback of the workspace migration needs
    them).

    Bug-A fix (May 2026): previously this NULLed sibling documents'
    period_id BEFORE dropping the period, then deleted the period. With
    the pre-Bug-A 2-col period collision, two companies could share one
    period_id; soft-deleting one company's doc would null the OTHER
    company's period_id reference, orphaning its analyses. The fix here:
      · Don't manually NULL anything. documents.period_id has ON DELETE
        SET NULL (phase3.sql:530), so the FK handles cleanup atomically.
      · Only drop the period when EVERY doc (live OR soft-deleted) that
        could reference it is gone. Conservative — periods linger on the
        soft-delete shelf instead of vanishing the moment all live docs
        are gone, but never orphans data.

    Cascade: the financial_periods row has ON DELETE CASCADE on
    statement_line_items, calculated_metrics, briefings, benchmark_reports,
    valuations, user_valuation_assumptions — all drop atomically with it.
    """
    from datetime import datetime, timedelta, timezone

    with _supabase.admin() as client:
        period_rows = client.select(
            "financial_periods",
            filters=({"id": f"eq.{period_id}", "org_id": f"eq.{org_id}"}
                     if org_id else {"id": f"eq.{period_id}"}),
            single=True,
        )
        if not period_rows:
            return
        # An archived workspace's period is never dropped: its trash is
        # shown nowhere, and a held archive is the migration's to keep.
        if _workspace_is_archived(client, org_id or period_rows[0].get("org_id")):
            logger.info("[docs] period %s is in an archived workspace — not dropped", period_id)
            return
        created_at = period_rows[0].get("created_at")
        if created_at:
            try:
                created = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
                if datetime.now(timezone.utc) - created < timedelta(minutes=5):
                    return  # too young — pipeline may still be attaching docs
            except (TypeError, ValueError):
                pass

        # Bug-A fix: only drop the period when EVERY doc (live OR soft-deleted)
        # referencing it is gone. Don't manually NULL siblings — documents.
        # period_id is ON DELETE SET NULL (phase3.sql:530), the FK handles
        # cleanup atomically when the parent period row is finally deleted.
        any_docs = client.select(
            "documents",
            filters={"period_id": f"eq.{period_id}"},
            limit=1,
        )
        if any_docs:
            return  # period still has at least one doc (live or sd) — keep it

        # The org is named in the filter as well as in the select above:
        # under the service role the filter IS the access control, and a
        # guard that lives only in an earlier early-return is one edit away
        # from being bypassed.
        client.delete("financial_periods", filters=(
            {"id": f"eq.{period_id}", "org_id": f"eq.{org_id}"}
            if org_id else {"id": f"eq.{period_id}"}))
        logger.info("[docs] dropped orphan period %s", period_id)


def reserve_upload_or_refuse(user_id: str, document_id: Optional[str] = None) -> Any:
    """THE UPLOAD METER — the reservation every new document takes before
    it is analysed, mapped to the HTTP shapes the frontend already knows.

    One function, two callers: `POST /api/pipeline/run` (a document the
    browser already stored) and `POST /api/uploads/commit` (a file the
    engine stores itself). Pricing V3 (refined spec gaps C + D) — atomic
    reserve, success-only consume:

      · `_usage_limits.check_quota` stays as the legacy safety rail;
      · `_usage_gate.reserve_document` is an atomic conditional UPDATE, so
        two concurrent uploads at the boundary cannot both pass (gap C);
      · the reservation is PROVISIONAL — the orchestrator commits it on
        analysis success and releases it on failure (gap D).

    Returns the `_usage_gate.DocReserveDecision` (`allowed` or `disabled`):
    the caller registers an `allowed` reservation in the run ledger
    (`_register_quota_run`) so the terminal settles exactly this one, and
    stamps `was_extra` on the row for visibility. Raises 429
    `doc_quota_blocked` or 402 `extra_doc_confirmation_required` — nothing
    was reserved then; after a 402 the frontend calls
    POST /api/plan/confirm-extra-doc and repeats the request, which then
    sees an `allowed` reservation.

    A confirmed extra is a GRANT for ONE document (verifier P-B,
    fix/dedupe-quota): with `document_id` — the document `/run` is about —
    that document's grant is taken first (`claim_extra_grant`, once, by the
    confirming user), and a 402 records the document it was asked for
    (`note_extra_required`, what an older bundle's body-less confirm
    resolves to). `reserve_document` never spends a confirmed extra, so a
    caller without a document (`/api/uploads/commit` meters BEFORE it stores
    anything) can neither take nor leave one. With a document, the
    document's own reservation a restart orphaned is adopted before a new
    one is made (`_adopt_reservation`, fix/dedupe-quota lens S S8) — for
    /run and every re-run that meters through `_meter_first_analysis`.
    """
    _usage_limits.check_quota(user_id, "upload")
    from . import _usage_gate as _ug
    decision = ((_ug.claim_extra_grant(user_id, document_id) if document_id else None)
                or (_adopt_reservation(document_id, user_id, take_extra=True) if document_id else None)
                or _ug.reserve_document(user_id))
    if decision.kind == "blocked":
        raise HTTPException(
            status_code=429,
            detail={
                "code": "doc_quota_blocked",
                "plan_key": decision.plan_key,
                "docs_used": decision.used,
                "docs_included": decision.cap,
                "message": decision.message,
                "upgrade_url": "/pricing",
            },
        )
    if decision.kind == "extra_required":
        if document_id:
            # FE must surface the confirm dialog and then call
            # POST /api/plan/confirm-extra-doc {document_id}, which reserves
            # the slot as billable and GRANTS it to this document; this
            # document's repeat request then takes the grant — and nothing
            # else can.
            _ug.note_extra_required(user_id, document_id)
        raise HTTPException(
            status_code=402,
            detail={
                "code": "extra_doc_confirmation_required",
                "plan_key": decision.plan_key,
                "docs_used": decision.used,
                "docs_included": decision.cap,
                "extra_doc_eur": decision.extra_doc_eur,
                "message": decision.message,
                "confirm_url": "/api/plan/confirm-extra-doc",
            },
        )
    # `allowed` or `disabled` — the caller proceeds with enqueue.
    return decision


def _enqueue(document_id: str) -> None:
    """Run the pipeline on a daemon thread. Production should swap this for a
    real queue (Inngest, Supabase Edge functions, BullMQ-equivalent), but for
    a single-server MVP a thread per upload is fine — uploads are infrequent
    and each pipeline takes <60s.
    """
    t = threading.Thread(target=_run_pipeline_sync, args=(document_id,), daemon=True)
    t.start()


# ─── HTTP shape ─────────────────────────────────────────────────────────────


class PeriodDetectRequest(BaseModel):
    """POST body for `/api/period/detect`.

    `extra="forbid"` is the W1 guard at the wire: a client that tries to
    smuggle the open period / drop target into the decision gets a 422,
    not a silently-ignored field.

    Declared at MODULE level on purpose. A Pydantic model defined inside
    the `build_router()` closure cannot have its annotations resolved by
    FastAPI — the body parameter degrades into a required *query* param
    (422 on every POST) and `/openapi.json` 500s on the forward ref.
    See CLAUDE.md §16 "Backend cleanup" for the same trap on
    `ContactSalesRequest`.
    """

    model_config = {"extra": "forbid"}

    filename: Optional[str] = None
    extracted: Optional[Dict[str, Any]] = None


class RunRequest(BaseModel):
    document_id: str
    # Optional ISO 639-1 language code (en, ro, de, fr, es, …). When provided,
    # stage_narrate replies in that language; defaults to English.
    output_language: Optional[str] = None


class RunResponse(BaseModel):
    document_id: str
    status: str
    # status == "duplicate" (2026-09-21): the document duplicates a live one
    # of the same account, company and period — it was archived, nothing was
    # reserved, analysed or counted. The FE renders "Already uploaded — open
    # it" linking to `period_id` (None while the original is still running).
    existing_document_id: Optional[str] = None
    period_id: Optional[str] = None


class DuplicateCheckRequest(BaseModel):
    """POST body for `/api/documents/duplicate-check` — asked by the browser
    BEFORE it writes a byte to storage. Module scope on purpose (a model
    nested in `build_router` degrades to a query parameter — CLAUDE.md §22).

    `content_hash` is the SHA-256 of the file bytes, 64 lowercase hex, as
    `lib/supabase.ts::uploadDocument` computes it. `period_end_hint` is the
    closing date the user confirmed, when they confirmed one."""

    content_hash: str
    period_end_hint: Optional[str] = None
    # "financial" (the dashboard) or "sku" (Products) — the SCOPE clause.
    # Absent (an older bundle) → financial, the column's default.
    scope: Optional[str] = None


class ReviewReanalyzeRequest(BaseModel):
    """F3.4 — Body for POST /api/period/{id}/review/reanalyze.

    Carries the user's per-session bucket overrides (`account_buckets`),
    their confirmation of country / accounting standard, and the
    `propose_as_calibration_rules` flag that promotes the overrides
    to `org_coa_mappings_overrides` (org-wide).
    """
    account_buckets: Dict[str, str] = Field(default_factory=dict)
    confirmed_country_code: Optional[str] = None
    confirmed_standard: Optional[str] = None
    notes: str = ""
    propose_as_calibration_rules: bool = False


def build_router() -> APIRouter:
    router = APIRouter(tags=["pipeline"])

    # RECONCILIATION FLOW (docs/CANONICAL_BS_V2_CONTRACT.md addendum):
    # POST /api/period/{id}/reconcile + /reconcile/undo. `_require_jwt`
    # is injected so _reconcile never imports back into this module.
    _reconcile.register_routes(router, require_jwt=_require_jwt)

    # AI-lane: POST /api/period/{id}/reextract — flags the period's
    # envelope for forced re-extraction (cache bypass) on the next scan.
    # Mounted exactly like the reconcile routes (require_jwt injected).
    _ai_lane_routes.register_routes(router, require_jwt=_require_jwt)

    # RUN JOURNAL: GET /api/period/{id}/asof — read-only as-of endpoint
    # (auth like the reconcile routes; 404 when no journal coverage).
    _journal_routes.register_routes(router, require_jwt=_require_jwt)

    # PERIOD MOVE (Part D): POST /api/documents/{id}/move-period and
    # /make-active — the correction path. Dependencies are injected the
    # same way the reconcile/journal routers take `require_jwt`, so
    # `_period_move` never imports back into this module. The re-run of
    # an ANALYSED document goes through `_admin_set_status` + `_enqueue`
    # directly rather than /api/pipeline/run: correcting a misfiled
    # document is not a new upload and must not consume the user's
    # document quota. A document that holds no analysis yet is its first
    # analysis and is metered (`_correction_rerun`).
    _period_move.register_routes(
        router,
        require_jwt=_require_jwt,
        # The WRITE wall (FC1x, D4): move-period / make-active re-file and
        # re-run a client's documents — membership, not firm visibility.
        verify_owns=_verify_user_may_write_document,
        set_status=_admin_set_status,
        enqueue=_enqueue,
        admin_client=_supabase.admin,
        # A document that holds no analysis yet is metered on its re-run
        # like its first analysis (`_correction_rerun`); an analysed one
        # re-runs unmetered, as above. Every correction takes the
        # one-run-per-document claim.
        rerun=lambda jwt, document_id, started_at: _correction_rerun(jwt, document_id, started_at),
        # A document whose run is in flight is not re-filed under it
        # (verifier lens S, S11): 409 before anything is written.
        is_running=lambda document_id: _doc_dedupe.in_flight(document_id) is not None,
    )

    # OBSERVABILITY: GET /api/ops — read-only engine-health snapshot
    # (auth like the reconcile routes; also installs the inert tracing
    # seams over the journal hooks — no behavior change until
    # ENGINE_OBS_TRACE is set).
    _ops_routes.register_routes(router, require_jwt=_require_jwt)

    # ── FX rates endpoint (currency toggle, BNR proxy) ────────────────
    # Returns {base, rates, source, as_of, fetched_at, stale}. Backend
    # proxy avoids browser CORS on bnr.ro + caches 24h across all FE clients.
    @router.get("/api/fx-rates")
    def get_fx_rates_endpoint(refresh: bool = False) -> Dict[str, Any]:
        from .fx_rates import get_fx_rates
        return get_fx_rates(force_refresh=refresh)

    # ── PERIOD DETECTION (Part B) ────────────────────────────────────
    # REGISTRATION ORDER IS LOAD-BEARING. `/api/period/{period_id}`
    # (registered further down) would happily swallow the literal path
    # segment `detect`; FastAPI resolves in registration order, so this
    # route must be declared BEFORE it. Pinned by
    # tests/engine/test_period_detection.py::
    # test_get_route_is_not_shadowed_by_the_period_id_route.
    #
    # Stateless by design: no DB read, no DB write, no document
    # required. The upload flow calls it BEFORE creating the document,
    # on a filename alone or on a parsed preview, so the user confirms
    # a date that came off the DOCUMENT — which is the only thing
    # `documents.period_end_hint` is allowed to carry.

    def _detect_period_payload(
        filename: Optional[str], extracted: Optional[Dict[str, Any]]
    ) -> Dict[str, Any]:
        return _period_detect.detect_period(extracted=extracted, filename=filename)

    @router.get("/api/period/detect")
    def detect_period_get(
        filename: Optional[str] = None,
        authorization: Optional[str] = Header(None),
    ) -> Dict[str, Any]:
        """Filename-only detection, for the moment a file is picked and
        no bytes have been parsed yet. Unknown query parameters are
        ignored — and cannot matter, because the service's signature
        accepts nothing but the document's own evidence."""
        _require_jwt(authorization)
        return _detect_period_payload(filename, None)

    @router.post("/api/period/detect")
    def detect_period_post(
        req: PeriodDetectRequest,
        authorization: Optional[str] = Header(None),
    ) -> Dict[str, Any]:
        """Detection on a parsed preview (`extracted`) plus filename."""
        _require_jwt(authorization)
        return _detect_period_payload(req.filename, req.extracted)

    # F3-UX-2 follow-up: /api/paste-trial-balance endpoint removed after the
    # FE Paste-Trial-Balance UI was deleted (no remaining FE caller; no
    # external integrations found via grep). The request/response Pydantic
    # models and the handler block were deleted together. If a third-party
    # integration needs deterministic paste-parsing later, restore via:
    #   1. Pydantic models PasteTrialBalanceRequest / PasteTrialBalanceResponse
    #   2. Handler body — calls pack.parse_pasted_trial_balance + accounts_to_canonical_tsv
    # The country-pack methods themselves (parse_pasted_trial_balance,
    # accounts_to_canonical_tsv) remain available in the Romania pack.

    @router.post("/api/documents/duplicate-check")
    def duplicate_check(
        req: DuplicateCheckRequest,
        authorization: Optional[str] = Header(None),
        x_org_id: Optional[str] = Header(None, alias="X-Org-Id"),
    ) -> Dict[str, Any]:
        """Asked by the browser BEFORE it stores a byte: does this ACCOUNT
        already hold a live copy of these bytes in this COMPANY for this
        PERIOD? (`_doc_dedupe` holds the definition.) Read-only — no row,
        no storage object, no reservation. The company is the caller's
        `X-Org-Id`, validated against membership (403 otherwise)."""
        jwt = _require_jwt(authorization)
        user_id, org_id = _org.resolve_org(jwt, x_org_id)
        content_hash = _doc_dedupe.normalize_hash(req.content_hash)
        if not content_hash:
            raise HTTPException(422, "content_hash must be the 64-hex SHA-256 of the file bytes.")
        hit = _doc_dedupe.find_live_original(
            org_id=org_id, user_id=user_id, content_hash=content_hash,
            hint=req.period_end_hint, scope=req.scope,
        )
        if hit is None:
            return {"duplicate": False}
        return hit.to_payload()

    @router.post("/api/pipeline/run", response_model=RunResponse, status_code=202)
    def run_pipeline(req: RunRequest, authorization: Optional[str] = Header(None)) -> RunResponse:
        jwt = _require_jwt(authorization)
        doc = _verify_user_may_write_document(jwt, req.document_id)  # the WRITE wall (FC1x, D4)
        user_id = _user_id_from_jwt(jwt)
        # DUPLICATE FIRST (2026-09-21) — before any reservation. A document
        # that duplicates a live one of the same account, company and
        # period is archived and answered as `duplicate`: nothing reserved,
        # analysed, counted or billed. Otherwise the run CLAIMS the document
        # (its pipeline_started_at) under the same lock, so a racing twin
        # finds it running and is the one archived.
        entry = _enter_run(doc, user_id)
        if entry.kind in (_doc_dedupe.DUPLICATE, _doc_dedupe.DONE, _doc_dedupe.DELETED):
            # A confirmed extra for a document that will not run as a first
            # analysis goes back now, unbilled (verifier P-B).
            from . import _usage_gate as _ug_grant
            _ug_grant.cancel_extra_grant(req.document_id)
        if entry.kind == _doc_dedupe.DUPLICATE:
            return RunResponse(document_id=req.document_id, status="duplicate",
                               existing_document_id=entry.hit.existing_document_id if entry.hit else None,
                               period_id=entry.hit.period_id if entry.hit else None)
        if entry.kind == _doc_dedupe.DELETED:
            raise HTTPException(409, {
                "code": "document_deleted",
                "message": "This document was deleted. Restore it before analysing it.",
            })
        if entry.kind != _doc_dedupe.CLAIMED:
            # ONE RUN PER DOCUMENT (2026-09-21). This document already has its
            # run (in flight in this process) or its analysis: nothing is
            # reserved and nothing is enqueued, and the answer is where it
            # stands — the browser polls the row either way. The failed-upload
            # banner's Retry posts /run on the SAME id, and a `failed` banner
            # can be a lost response for a run the server did start (CLAUDE.md
            # §24): that Retry used to reserve and commit the book a second
            # time, or leave a second reservation behind for good.
            return RunResponse(document_id=req.document_id, status=entry.status or "queued",
                               period_id=entry.period_id)
        enqueued = False
        try:
            # THE ONE UPLOAD METER — `reserve_upload_or_refuse`, which
            # `/api/uploads/commit` calls too, so the two entry points cannot
            # drift apart (429 / 402 raised from there). Pricing V3 (refined
            # spec gaps C + D): an atomic reserve, success-only consume. For
            # this document it first takes the extra THIS document was
            # confirmed for (a grant — verifier P-B) and, on a 402, records
            # the document the question was asked for.
            #
            # The reservation is PROVISIONAL — `_run_pipeline_sync` settles
            # it once the run ends: committed on `analyzed`, released on any
            # failure (gap D — "consumed" = success only). The ledger entry
            # `_meter_first_analysis` writes (through the one meter above)
            # is what lets the terminal settle exactly this one; a 402 / 429
            # is raised from there.
            #
            # A document whose BOOK the plan already counted (the quota
            # ledger — its correction re-run failed and the failed banner's
            # Retry lands here) is re-analysed unmetered: no reservation, no
            # dialog, no second count (verifier lens S, `_needs_metering`).
            decision = (_meter_first_analysis(req.document_id, user_id)
                        if _needs_metering(entry) else None)
            if decision is None:
                from . import _usage_gate as _ug_counted
                _ug_counted.cancel_extra_grant(req.document_id)
            # `allowed` or `disabled` — proceed with enqueue.

            # Stamp the was_extra flag on the row for visibility (support,
            # the audit scripts). The settlement reads the LEDGER, never
            # this stamp — a later re-run of the row would still carry it.
            is_extra_reservation = bool(decision is not None and decision.was_extra)
            if req.output_language or is_extra_reservation:
                patch: Dict[str, Any] = {}
                if req.output_language:
                    patch["detected_language"] = req.output_language
                if is_extra_reservation:
                    patch["metered_extra"] = True
                with _supabase.admin() as ac:
                    ac.update("documents", patch, filters={"id": f"eq.{req.document_id}"})

            _admin_set_status(req.document_id, "queued", pipeline_started_at=_now_iso())
            _doc_dedupe.mark_running(req.document_id)
            _enqueue(req.document_id)
            enqueued = True
        finally:
            if not enqueued:
                # Refused (402 / 429) or errored: nothing runs — the claim
                # and any reservation already taken go back.
                _release_unstarted(entry, req.document_id)
        # NOTE: no `_usage_limits.record_usage(user_id, "upload")` here any
        # more. It bumped `user_usage.uploads` at ENQUEUE time — failures and
        # duplicates included — on top of the terminal commit's own bump:
        # the owner's "51 documents used" (see the ledger note above
        # `_commit_pipeline_quota`).
        return RunResponse(document_id=req.document_id, status="queued")

    @router.get("/api/sku-analysis/latest")
    def get_latest_sku_analysis(authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
        """Return the latest SKU analysis for the caller's organization.

        Strictly scoped to scope='sku' documents — never returns financial
        statement data. Used by the Products page to render the briefing +
        recommendations from the most recent inventory/sales upload.
        """
        jwt = _require_jwt(authorization)
        with _supabase.per_user(jwt) as client:
            rows = client.select(
                "sku_analyses",
                columns="*,documents!inner(id,original_filename,status,scope,created_at,error)",
                order="created_at.desc",
                limit=1,
            )
            if not rows:
                return {"analysis": None}
            r = rows[0]
            doc = r.get("documents") or {}
            return {
                "analysis": {
                    "id": r["id"],
                    "document": {
                        "id": doc.get("id"),
                        "filename": doc.get("original_filename"),
                        "status": doc.get("status"),
                        "scope": doc.get("scope"),
                        "created_at": doc.get("created_at"),
                        "error": doc.get("error"),
                    },
                    "briefing": r.get("briefing"),
                    "summary": r.get("summary"),
                    "recommendations": r.get("recommendations") or [],
                    "model": r.get("model"),
                    "created_at": r.get("created_at"),
                },
            }

    @router.get("/api/public-records/latest")
    def get_latest_public_records(authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
        """Return the most recent public-records-summary extract for the
        caller's org. The data lives in `sku_analyses` (reused — same JSONB
        shape) and is keyed by `briefing.kind == 'public_records_summary'`.
        The Multi-year History FE page reads from here.
        """
        jwt = _require_jwt(authorization)
        with _supabase.per_user(jwt) as client:
            # We over-fetch by 10 since `sku_analyses` mixes SKU briefings
            # with public-records extracts; the JSON `kind` discriminator
            # is the filter. Postgres JSONB path filter isn't trivially
            # exposed via PostgREST, so client-side filter is the cleanest.
            rows = client.select(
                "sku_analyses",
                columns="*,documents!inner(id,original_filename,status,scope,detected_type,created_at,error)",
                order="created_at.desc",
                limit=10,
            )
            for r in rows:
                briefing = r.get("briefing")
                # PostgREST returns JSONB as either dict or string depending
                # on Accept header negotiation — handle both shapes.
                if isinstance(briefing, str):
                    try:
                        briefing = json.loads(briefing)
                    except (json.JSONDecodeError, TypeError):
                        briefing = {}
                briefing = briefing or {}
                if isinstance(briefing, dict) and briefing.get("kind") == "public_records_summary":
                    doc = r.get("documents") or {}
                    return {
                        "extract": {
                            "id": r["id"],
                            "document": {
                                "id": doc.get("id"),
                                "filename": doc.get("original_filename"),
                                "status": doc.get("status"),
                                "detected_type": doc.get("detected_type"),
                                "created_at": doc.get("created_at"),
                            },
                            "company_name": briefing.get("company_name"),
                            "cui": briefing.get("cui"),
                            "reg_com": briefing.get("reg_com"),
                            "caen_code": briefing.get("caen_code"),
                            "caen_description": briefing.get("caen_description"),
                            "source_site": briefing.get("source_site"),
                            "confidence": briefing.get("confidence"),
                            "years": briefing.get("years") or [],
                            "created_at": r.get("created_at"),
                        },
                    }
            return {"extract": None}

    @router.get("/api/public-records/by-document/{document_id}")
    def get_public_records_by_document(
        document_id: str,
        authorization: Optional[str] = Header(None),
    ) -> Dict[str, Any]:
        """Fetch the public-records extract for a specific document. Lets
        the FE deep-link `/multi-year-history?doc=<id>` to a specific
        upload rather than always rendering the latest."""
        jwt = _require_jwt(authorization)
        with _supabase.per_user(jwt) as client:
            rows = client.select(
                "sku_analyses",
                filters={"document_id": f"eq.{document_id}"},
                columns="*,documents!inner(id,original_filename,status,detected_type,created_at)",
                single=True,
            )
            if not rows:
                raise HTTPException(404, "No analysis for that document.")
            r = rows[0]
            briefing = r.get("briefing")
            if isinstance(briefing, str):
                try:
                    briefing = json.loads(briefing)
                except (json.JSONDecodeError, TypeError):
                    briefing = {}
            briefing = briefing or {}
            if not isinstance(briefing, dict) or briefing.get("kind") != "public_records_summary":
                raise HTTPException(404, "Document is not a public-records summary.")
            doc = r.get("documents") or {}
            return {
                "extract": {
                    "id": r["id"],
                    "document": {
                        "id": doc.get("id"),
                        "filename": doc.get("original_filename"),
                        "status": doc.get("status"),
                        "detected_type": doc.get("detected_type"),
                        "created_at": doc.get("created_at"),
                    },
                    "company_name": briefing.get("company_name"),
                    "cui": briefing.get("cui"),
                    "reg_com": briefing.get("reg_com"),
                    "caen_code": briefing.get("caen_code"),
                    "caen_description": briefing.get("caen_description"),
                    "source_site": briefing.get("source_site"),
                    "confidence": briefing.get("confidence"),
                    "years": briefing.get("years") or [],
                    "created_at": r.get("created_at"),
                },
            }

    @router.get("/api/org/periods-with-documents")
    def list_periods_with_documents(
        authorization: Optional[str] = Header(None),
        x_org_id: Optional[str] = Header(None, alias="X-Org-Id"),
    ) -> Dict[str, Any]:
        """Right-anchored Docs panel feed: every financial_period the user's
        org has, with the source documents that produced it, ordered newest
        first. Plus a `recently_deleted` shelf for soft-deleted docs that
        haven't hit the 30-day hard-delete cutoff.

        Single endpoint per panel-open (no re-fetch on toggle).
        """
        from datetime import datetime, timezone, timedelta

        jwt = _require_jwt(authorization)
        # Caller's ACTIVE workspace — validated against membership, not the
        # first row. See _org.resolve_org.
        try:
            _user_id, org_id = _org.resolve_org(jwt, x_org_id)
        except HTTPException as exc:
            if exc.status_code == 404:
                return {"active_period_id": None, "periods": [], "recently_deleted": []}
            raise
        with _supabase.per_user(jwt) as client:
            periods = client.select(
                "financial_periods",
                filters={"org_id": f"eq.{org_id}"},
                order="period_end.desc,created_at.desc",
            )
            docs = client.select(
                "documents",
                filters={
                    "org_id": f"eq.{org_id}",
                    "scope": "eq.financial",
                    "deleted_at": "is.null",
                },
                order="created_at.desc",
            )
            deleted = client.select(
                "documents",
                filters={
                    "org_id": f"eq.{org_id}",
                    "deleted_at": "not.is.null",
                },
                order="deleted_at.desc",
            )

        # Index docs by period_id (one doc → one period). Documents not yet
        # attached to a period (mid-pipeline or sku-scope) are omitted; the
        # panel surfaces only analyzed financial periods.
        docs_by_period: Dict[str, List[Dict[str, Any]]] = {}
        for d in docs:
            pid = d.get("period_id")
            if not pid:
                continue
            docs_by_period.setdefault(pid, []).append({
                "id": d["id"],
                "display_name": d.get("display_name") or d["original_filename"],
                "original_filename": d["original_filename"],
                "storage_path": d["storage_path"],
                "mime_type": d.get("mime_type"),
                "detected_type": d.get("detected_type"),
                "size_bytes": d["size_bytes"],
                "uploaded_at": d["created_at"],
                "status": d["status"],
                "is_active": d.get("is_active", True),
                "confidence": d.get("extraction_confidence"),
                "error": d.get("error"),
            })

        # Most recent analyzed period = the dashboard default.
        #
        # F3.15 Chunk 2 — prefer periods with meaningful data so a fresh
        # dashboard load lands on the operator's most recent USEFUL
        # analysis, not an empty SKU-misuploaded period that happens to
        # be the newest. The data-status check needs the per-period
        # has_meaningful_data computed below, so we do a quick pre-pass
        # here using the same logic (total_assets metric + sku_analyses
        # existence) — duplicates a few lines but avoids restructuring
        # the whole function. Falls back to the legacy newest-with-docs
        # rule if every period is empty (so the dashboard still has
        # SOMETHING to show on edge accounts).
        pre_period_ids = [pp["id"] for pp in periods if docs_by_period.get(pp["id"])]
        pre_doc_ids = [dd["id"] for plist in docs_by_period.values() for dd in plist]
        with _supabase.admin() as ac_pre:
            pre_metrics = ac_pre.select(
                "calculated_metrics",
                filters={
                    "period_id": "in.(" + ",".join(pre_period_ids) + ")",
                    "name": "eq.total_assets",
                },
            ) if pre_period_ids else []
            pre_sku = ac_pre.select(
                "sku_analyses",
                filters={"document_id": "in.(" + ",".join(pre_doc_ids) + ")"} if pre_doc_ids else {},
            ) if pre_doc_ids else []
        pre_ta_by_period: Dict[str, float] = {}
        for mm in (pre_metrics or []):
            try:
                pre_ta_by_period[mm["period_id"]] = float(mm.get("value") or 0)
            except (TypeError, ValueError):
                continue
        pre_sku_doc_ids = {ss.get("document_id") for ss in (pre_sku or []) if ss.get("document_id")}

        def _period_has_data(pp: Dict[str, Any]) -> bool:
            dlist = docs_by_period.get(pp["id"], [])
            if not dlist:
                return False
            status = (dlist[0].get("status") or "").lower()
            if status != "analyzed":
                # In-flight uploads count as "has data" (don't skip them).
                return True
            return pre_ta_by_period.get(pp["id"], 0.0) > 0 or any(d["id"] in pre_sku_doc_ids for d in dlist)

        active_period_id = next(
            (p["id"] for p in periods if _period_has_data(p)),
            None,
        )
        # Final fallback — if every period is empty, still pick the
        # newest-with-docs so the dashboard isn't completely blank.
        if active_period_id is None:
            active_period_id = next(
                (p["id"] for p in periods if docs_by_period.get(p["id"])),
                None,
            )

        # Skip periods with zero live documents. The pipeline's `stage_persist`
        # always attaches a document on insert, so a doc-less period can only
        # appear when (a) every attached doc was soft-deleted or (b) a row
        # leaked through pre-fix code paths. Either way the UI never wants to
        # render them. (Step 5 of the docs-panel fix.)
        #
        # F3.15 Chunk 2 — `has_meaningful_data` per period. Bulk-load the
        # total_assets metric for every period in one query (no N+1 risk
        # even with hundreds of periods) plus an existence check on
        # sku_analyses for the period's documents. The FE filters by this
        # flag by default and shows "N empty periods hidden · show" at
        # the picker's bottom for one-click reveal. The `status` guard
        # keeps in-flight uploads visible: only `analyzed` periods with
        # zero TB output AND no SKU output are flagged as empty.
        period_ids = [p["id"] for p in periods if docs_by_period.get(p["id"])]
        all_doc_ids = [d["id"] for plist in docs_by_period.values() for d in plist]
        with _supabase.admin() as ac_bulk:
            metric_rows = ac_bulk.select(
                "calculated_metrics",
                filters={
                    "period_id": "in.(" + ",".join(period_ids) + ")",
                    "name": "eq.total_assets",
                },
            ) if period_ids else []
            sku_rows = ac_bulk.select(
                "sku_analyses",
                filters={"document_id": "in.(" + ",".join(all_doc_ids) + ")"} if all_doc_ids else {},
            ) if all_doc_ids else []
        total_assets_by_period: Dict[str, float] = {}
        for m in (metric_rows or []):
            try:
                total_assets_by_period[m["period_id"]] = float(m.get("value") or 0)
            except (TypeError, ValueError):
                continue
        sku_doc_ids = {s.get("document_id") for s in (sku_rows or []) if s.get("document_id")}

        period_rows = []
        for p in periods:
            doc_list = docs_by_period.get(p["id"], [])
            if not doc_list:
                continue
            # has_meaningful_data: True unless ALL these hold:
            #   1. The primary doc is in 'analyzed' status (in-flight stays visible)
            #   2. total_assets is zero/missing on this period
            #   3. None of the period's docs have an sku_analyses row
            # Conservative default: show. Hide only on proven emptiness.
            primary_doc_status = (doc_list[0].get("status") or "").lower()
            ta = total_assets_by_period.get(p["id"], 0.0)
            has_sku = any(d["id"] in sku_doc_ids for d in doc_list)
            if primary_doc_status == "analyzed" and ta == 0 and not has_sku:
                has_data = False
            else:
                has_data = True
            period_rows.append({
                "period_id": p["id"],
                "period_label": p.get("period_end") or "Imported period",
                "period_start": p.get("period_start"),
                "period_end": p.get("period_end"),
                "is_active": p["id"] == active_period_id,
                "currency": p.get("currency"),
                "documents": doc_list,
                # THE ANALYSIS SOURCE, stated rather than guessed
                # (2026-08-30). One document per period backs its numbers
                # — `stage_persist` writes this pointer and stamps the
                # same id into the envelope's provenance. The workspace
                # UI used to infer it with a most-recently-analyzed
                # heuristic, which silently picked a winner on a period
                # holding two companies' files. Surfaced so the label can
                # be a fact; null on legacy rows, where the UI must fall
                # back rather than pretend.
                "source_document_id": p.get("source_document_id"),
                "extraction_confidence": p.get("extraction_confidence"),
                "has_meaningful_data": has_data,
                # PERIOD-DETECTION GROUND TRUTH (2026-08-30). Written by
                # stage_persist into the period's envelope; surfaced
                # here verbatim so the mismatch chip renders WHAT
                # ACTUALLY HAPPENED at write time instead of recomputing
                # a verdict about a row it didn't write. None on periods
                # persisted before this shipped — ABSENT != ZERO, so the
                # chip must render nothing rather than "no mismatch".
                "period_detection": (
                    (p.get("assembled_canonical_v1") or {}).get("period_detection")
                    if isinstance(p.get("assembled_canonical_v1"), dict)
                    else None
                ),
            })

        # Soft-delete window is 30 days — surface deleted docs that fall
        # within that range so the user can restore them.
        cutoff = datetime.now(timezone.utc) - timedelta(days=30)
        deleted_rows = []
        for d in deleted:
            # An upload archived as a DUPLICATE was never stored as far as
            # the user is concerned ("Already uploaded — open it"): it is
            # not a delete of theirs to restore or empty.
            if _doc_dedupe.is_archived_duplicate(d):
                continue
            deleted_at = _doc_dedupe._ts(d.get("deleted_at"))
            if deleted_at is None:
                continue
            if deleted_at < cutoff:
                continue
            deleted_rows.append({
                "id": d["id"],
                "display_name": d.get("display_name") or d["original_filename"],
                "deleted_at": d["deleted_at"],
                "restorable_until": (deleted_at + timedelta(days=30)).isoformat(),
                # `scope` lets the FE filter this shared array per panel:
                #   · DocsPanel (dashboard, financial domain) shows only
                #     scope=='financial' rows
                #   · DatasetsPanel (/products, SKU domain) shows only
                #     scope=='sku' rows
                # Without this field, BOTH panels would render the union
                # — leaking trial-balance / public-records deletes into
                # the Products UI (the user-reported "93 deleted finance
                # files appearing in Products" bug). Domain isolation is
                # client-side here because the endpoint is shared; the
                # backend keeps returning the union for backwards-compat.
                "scope": d.get("scope"),
            })

        # Public-records uploads (listafirme.ro / termene.ro / firme.info)
        # don't create a financial_period — they live in sku_analyses with
        # briefing.kind = 'public_records_summary'. The DocsPanel switcher
        # needs them too so the user can flip between trial-balance and
        # public-records analyses for any company they've uploaded. Add a
        # parallel `public_records` array keyed only on `documents.id`.
        public_records: List[Dict[str, Any]] = []
        try:
            with _supabase.admin() as ac:
                # Live (non-soft-deleted) sku_analyses rows joined with their
                # parent document, filtered to this org.
                sku_rows = ac.select(
                    "sku_analyses",
                    columns="document_id,briefing,created_at,documents!inner(id,original_filename,display_name,status,detected_type,created_at,deleted_at,org_id)",
                    order="created_at.desc",
                    limit=50,
                )
                for r in sku_rows:
                    doc = r.get("documents") or {}
                    if doc.get("deleted_at"):
                        continue
                    if doc.get("org_id") != org_id:
                        continue
                    briefing = r.get("briefing")
                    if isinstance(briefing, str):
                        try:
                            briefing = json.loads(briefing)
                        except (json.JSONDecodeError, TypeError):
                            briefing = {}
                    if not isinstance(briefing, dict):
                        continue
                    if briefing.get("kind") != "public_records_summary":
                        continue
                    years = briefing.get("years") or []
                    year_min = min((y.get("year") for y in years if y.get("year")), default=None)
                    year_max = max((y.get("year") for y in years if y.get("year")), default=None)
                    public_records.append({
                        "document_id": doc.get("id"),
                        "display_name": doc.get("display_name") or doc.get("original_filename"),
                        "original_filename": doc.get("original_filename"),
                        "status": doc.get("status"),
                        "detected_type": doc.get("detected_type"),
                        "created_at": doc.get("created_at"),
                        "company_name": briefing.get("company_name"),
                        "cui": briefing.get("cui"),
                        "caen_code": briefing.get("caen_code"),
                        "caen_description": briefing.get("caen_description"),
                        "years_count": len(years),
                        "year_min": year_min,
                        "year_max": year_max,
                        "confidence": briefing.get("confidence"),
                    })
        except Exception:
            logger.exception("[periods-with-documents] public-records enumeration failed (non-fatal)")

        return {
            "active_period_id": active_period_id,
            "periods": period_rows,
            "public_records": public_records,
            "recently_deleted": deleted_rows,
        }

    @router.patch("/api/documents/{document_id}")
    def patch_document(document_id: str, payload: Dict[str, Any], authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
        """Rename / mark-inactive / soft-delete a document. RLS scoped — the
        caller must be a member of the document's org for the update to
        succeed (per-user client respects member-scoped policies)."""
        jwt = _require_jwt(authorization)
        allowed = {"display_name", "is_active"}
        patch = {k: v for k, v in payload.items() if k in allowed}
        if not patch:
            raise HTTPException(400, "No allowed fields provided. Allowed: display_name, is_active.")
        _verify_user_may_write_document(jwt, document_id)  # the WRITE wall (FC1x, D4)
        with _supabase.per_user(jwt) as client:
            client.update("documents", patch, filters={"id": f"eq.{document_id}"})
            rows = client.select("documents", filters={"id": f"eq.{document_id}"}, single=True)
            if not rows:
                raise HTTPException(404, "Document not found or not visible.")
            return rows[0]

    # Static-path routes MUST be registered before the
    # `/api/documents/{document_id}` parameter route below — otherwise
    # FastAPI matches the static segment as a `document_id` value.

    @router.post("/api/documents/clear-mine")
    def clear_my_uploads(
        authorization: Optional[str] = Header(None),
        x_org_id: Optional[str] = Header(None, alias="X-Org-Id"),
    ) -> Dict[str, Any]:
        """Settings → Data → "Clear all my uploaded documents."
        Soft-deletes every live document in the caller's org with a
        single UPDATE: sets `deleted_at = NOW()` where
        `org_id = caller's org AND deleted_at IS NULL`.

        Safety contract — what this endpoint INTENTIONALLY DOES NOT DO:
          · No hard-delete. No `DELETE FROM`. Rows stay in the documents
            table with `deleted_at` set so they remain restorable.
          · No `financial_periods` mutation. No row removed, no column
            updated. Orphaned empty periods left behind are Bug A's
            domain and are intentionally NOT cleaned up here.
          · No call to `_maybe_drop_empty_period`. That helper triggers
            the sibling-NULL cascade that Bug A is about; reproducing
            that cascade from a Settings button would create the exact
            data-bleed pattern Bug A is meant to fix.
          · No `statement_line_items`/`calculated_metrics` mutation.
            FK ON DELETE SET NULL handles `documents.period_id` if a
            period is later dropped (separate path), but that's not
            this endpoint's job.

        This is the only SAFE batch soft-delete in the codebase. The
        adjacent `DELETE /api/documents/{id}` endpoint DOES call
        `_maybe_drop_empty_period` per-doc — Settings deliberately
        does NOT loop that endpoint for this reason.

        Returns: {"deleted_count": N, "org_id": "..."}.
        """
        jwt = _require_jwt(authorization)
        # Caller's ACTIVE workspace. This used to be inlined (to dodge a
        # circular import from _benchmarks.py) and took the first membership;
        # _org has no router deps, so it can be imported safely.
        try:
            _user_id, org_id = _org.resolve_org(jwt, x_org_id)
        except HTTPException as exc:
            if exc.status_code == 404:
                return {"deleted_count": 0, "org_id": None, "deleted_at": None}
            raise

        now = _now_iso()
        # Single UPDATE via PostgREST — atomic, org-scoped via the
        # filter (defense-in-depth on top of RLS), no cascade.
        with _supabase.admin() as ac:
            # Fetch first (for the count to return); update second.
            live = ac.select(
                "documents",
                filters={
                    "org_id":     f"eq.{org_id}",
                    "deleted_at": "is.null",
                },
                columns="id",
            )
            if live:
                ac.update(
                    "documents",
                    {"deleted_at": now},
                    filters={
                        "org_id":     f"eq.{org_id}",
                        "deleted_at": "is.null",
                    },
                )
        return {
            "deleted_count": len(live),
            "org_id": org_id,
            "deleted_at": now,
        }

    @router.delete("/api/documents/clear-deleted")
    def clear_recently_deleted(
        period_id: Optional[str] = None,
        authorization: Optional[str] = Header(None),
        x_org_id: Optional[str] = Header(None, alias="X-Org-Id"),
    ) -> Dict[str, Any]:
        """Hard-delete every soft-deleted document in the caller's ACTIVE,
        LIVE workspace.

        ONE workspace: the `X-Org-Id` one when the caller is a member of
        it, else the caller's oldest live workspace (`_org.
        default_org_for_user` — the same fallback the Docs panel's
        `recently_deleted` shelf is listed from, so "Clear all" empties
        exactly the shelf the user was shown). Never an ARCHIVED workspace:
        its trash is not shown anywhere. Until 2026-09-21 the scope was
        "every soft-deleted document visible to me" across every workspace
        the caller is a member of — archived ones included — and
        `financial_periods.source_document_id` is ON DELETE CASCADE, so one
        "Clear all" in one workspace erased periods in others (the
        workspace migration's holding archive among them).

        When `period_id` is supplied, scope is limited further to that
        period. Uses per_user select to enforce RLS scoping, then admin
        cleanup for storage + cascade — same pattern as the per-doc
        endpoint below.
        """
        jwt = _require_jwt(authorization)
        # VERIFY BEFORE READING (FC1x, critic finding I1) — an expired
        # bearer must be a 401 from the verifier, not a PostgREST 401
        # escaping through raise_for_status as an opaque 500.
        user_id = _user_id_from_jwt(jwt)
        requested = (x_org_id or "").strip()
        if requested:
            # A workspace the caller is not a member of: nothing of theirs
            # to empty (a 200 with nothing, like the firm-viewer contract).
            org_id = requested if _org.user_is_member(user_id, requested) else None
        else:
            org_id = _org.default_org_for_user(user_id)
        if not org_id:
            return {"deleted_count": 0, "deleted_ids": [], "org_id": None}
        with _supabase.per_user(jwt) as client:
            org_rows = client.select("organizations", filters={"id": f"eq.{org_id}"},
                                     columns="id,archived_at")
            if not org_rows or org_rows[0].get("archived_at") is not None:
                return {"deleted_count": 0, "deleted_ids": [], "org_id": org_id}
            filters: Dict[str, str] = {"org_id": f"eq.{org_id}", "deleted_at": "not.is.null"}
            if period_id:
                filters["period_id"] = f"eq.{period_id}"
            visible = client.select("documents", filters=filters)
        # The WRITE wall (FC1x, D4): a firm viewer sees a client's
        # soft-deleted documents under can_read_client_org; only the
        # caller's OWN workspaces' rows may be hard-deleted here.
        visible = _only_member_orgs(jwt, visible)
        # Archived duplicates are not on the shelf, so "empty recently
        # deleted" never reaches them: their storage object is kept.
        visible = [d for d in visible if not _doc_dedupe.is_archived_duplicate(d)]

        deleted_ids: List[str] = []
        with _supabase.admin() as admin:
            for doc in visible:
                doc_id = doc["id"]
                storage_path = doc.get("storage_path")
                if storage_path:
                    try:
                        admin.delete_object("documents", storage_path,
                                            org_id=doc.get("org_id"))
                    except Exception:  # noqa: BLE001
                        logger.exception(
                            "[docs] clear-deleted: failed to remove blob %s", storage_path
                        )
                for table in ("alerts", "statement_line_items", "calculated_metrics",
                              "sales_datasets", "sku_lines", "sku_aggregates"):
                    try:
                        admin.delete(table, filters={"document_id": f"eq.{doc_id}"})
                    except Exception:  # noqa: BLE001
                        logger.debug("[docs] clear-deleted: no cascade on %s", table)
                admin.delete("documents", filters={"id": f"eq.{doc_id}"})
                deleted_ids.append(doc_id)

        return {"deleted_count": len(deleted_ids), "deleted_ids": deleted_ids, "org_id": org_id}

    @router.delete("/api/documents/{document_id}")
    def soft_delete_document(document_id: str, authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
        """Soft-delete a document. Sets deleted_at = now(). Restorable via
        POST /api/documents/:id/restore within 30 days; a cron sweep
        hard-deletes after.

        Side effect: if soft-deleting this document leaves the parent
        financial_period with zero live documents, drop the period row
        and its derived data so the panel never shows a doc-less period.
        Skips periods younger than 5 minutes (safety window: a doc may
        be mid-pipeline and not yet pinned to period_id). (Step 5 of the
        docs-panel fix.)
        """
        jwt = _require_jwt(authorization)
        # VERIFY BEFORE READING (FC1x, critic finding I1) — an expired
        # bearer must be a 401 from the verifier, not a PostgREST 401
        # escaping through raise_for_status as an opaque 500.
        _user_id_from_jwt(jwt)
        doc_rows = [_verify_user_may_write_document(jwt, document_id)]  # the WRITE wall (FC1x, D4)
        with _supabase.per_user(jwt) as client:
            client.update("documents", {"deleted_at": _now_iso()}, filters={"id": f"eq.{document_id}"})

        # Cleanup orphan period using admin so RLS doesn't block the cascade.
        doc = doc_rows[0] if doc_rows else None
        period_id = doc and doc.get("period_id")
        if period_id:
            try:
                _maybe_drop_empty_period(
                    period_id, org_id=str((doc or {}).get("org_id") or ""))
            except Exception:  # noqa: BLE001
                logger.exception("[docs] orphan-period cleanup failed for %s", period_id)
        return {"document_id": document_id, "deleted_at": _now_iso()}

    @router.post("/api/documents/{document_id}/restore")
    def restore_document(document_id: str, authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
        """Restore a soft-deleted document.

        AN ARCHIVED DUPLICATE (P2-C, 2026-09-26). `archive_as_duplicate`
        leaves the copy `deleted_at` + status='analyzed' (a terminal state
        for a tab watching it) + the `duplicate_of:` marker. Clearing
        `deleted_at` alone left a live row that read analysed yet held no
        analysis, that every counter skipped by its marker, that /run refused
        as DONE and /retry re-ran unmetered. It goes back as a PLAIN COPY —
        the marker cleared, `queued`, never started — that the next entry
        re-checks (recover-stuck on the next mount, or its own /run):
        archived again while the original is live, analysed — and metered —
        as the book's first analysis once it is not."""
        jwt = _require_jwt(authorization)
        doc = _verify_user_may_write_document(jwt, document_id)  # the WRITE wall (FC1x, D4)
        was_duplicate = _doc_dedupe.is_archived_duplicate(doc)
        patch: Dict[str, Any] = {"deleted_at": None}
        if was_duplicate:
            patch.update({"error": None, "status": "queued", "pipeline_started_at": None})
        with _supabase.per_user(jwt) as client:
            client.update("documents", patch, filters={"id": f"eq.{document_id}"})
        if was_duplicate:
            # This process's own memory of the archive would otherwise make
            # the settlement refuse the restored copy's successful run.
            _doc_dedupe.forget_archived_here(document_id)
            logger.info("[docs] document %s restored from its duplicate archive as a plain copy — "
                        "the next entry re-checks it", document_id)
        return {"document_id": document_id, "restored": True, "was_duplicate": was_duplicate}

    @router.delete("/api/documents/{document_id}/permanent")
    def permanent_delete_document(
        document_id: str, authorization: Optional[str] = Header(None)
    ) -> Dict[str, Any]:
        """Hard-delete a previously soft-deleted document.

        Two-step gate: the document MUST already have `deleted_at` set —
        accidental deletes on active documents are not possible through
        this endpoint. The flow is always
            DELETE /api/documents/:id            (soft, sets deleted_at)
            DELETE /api/documents/:id/permanent  (hard, removes blob + row)

        Side effects:
          1. Removes the underlying blob from the `documents` storage
             bucket (path = `documents.storage_path`).
          2. Cascade-deletes derived rows (statement_line_items,
             calculated_metrics, briefings, valuations, alerts) that
             are FK-tied to the document or its period.
          3. Hard-deletes the document row itself.
        """
        jwt = _require_jwt(authorization)
        # VERIFY BEFORE READING (FC1x, critic finding I1) — an expired
        # bearer must be a 401 from the verifier, not a PostgREST 401
        # escaping through raise_for_status as an opaque 500.
        _user_id_from_jwt(jwt)
        with _supabase.per_user(jwt) as client:
            rows = client.select("documents", filters={"id": f"eq.{document_id}"}, single=True)
            if not rows:
                raise HTTPException(404, "Document not found.")
            doc = rows[0]
            if not doc.get("deleted_at"):
                raise HTTPException(
                    400,
                    "Cannot permanently delete a document that has not been soft-deleted first.",
                )
            storage_path = doc.get("storage_path")
        # The WRITE wall (FC1x, D4): per_user visibility is NOT a
        # membership check — firm viewers see a client's rows too.
        _org.require_org_member(jwt, doc.get("org_id"))

        # Storage + cascade cleanup use the admin client (RLS doesn't gate
        # us once we've passed the membership wall above).
        with _supabase.admin() as admin:
            # Never in an archived workspace: its trash is shown nowhere,
            # and a held archive keeps the originals the workspace
            # migration's rollback points documents back at.
            if _workspace_is_archived(admin, doc.get("org_id")):
                raise HTTPException(
                    409, "This document's workspace is archived; restore the workspace before "
                         "permanently deleting anything in it.")
            # 1) Remove the underlying blob. Log + continue on failure — a
            # missing blob shouldn't block the DB cleanup.
            if storage_path:
                try:
                    admin.delete_object("documents", storage_path,
                                        org_id=doc.get("org_id"))
                except Exception:  # noqa: BLE001
                    logger.exception(
                        "[docs] failed to remove storage blob %s (continuing with DB cleanup)",
                        storage_path,
                    )

            # 2) Cascade-delete derived rows that reference this doc. Most
            # FKs are ON DELETE CASCADE at the schema level, but some
            # (alerts.document_id, sales_datasets.document_id) are
            # ON DELETE SET NULL / restrict — wipe those explicitly so the
            # next user doesn't see ghost rows pointing at a deleted doc.
            for table in ("alerts", "statement_line_items", "calculated_metrics",
                          "sales_datasets", "sku_lines", "sku_aggregates"):
                try:
                    admin.delete(table, filters={"document_id": f"eq.{document_id}"})
                except Exception:  # noqa: BLE001
                    # Some tables won't have a document_id column; that's
                    # fine — the FK simply doesn't exist there.
                    logger.debug("[docs] no document_id cascade on %s (skipping)", table)

            # 3) Hard-delete the document row.
            admin.delete("documents", filters={"id": f"eq.{document_id}"})

        return {"document_id": document_id, "permanently_deleted": True}

    @router.patch("/api/sales-datasets/{dataset_id}")
    def patch_sales_dataset(dataset_id: str, payload: Dict[str, Any], authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
        """Rename a sales dataset's user-visible label."""
        jwt = _require_jwt(authorization)
        allowed = {"label", "is_active"}
        patch = {k: v for k, v in payload.items() if k in allowed}
        if not patch:
            raise HTTPException(400, "No allowed fields. Allowed: label, is_active.")
        # VERIFY BEFORE READING (FC1x, critic finding I1). The read below
        # goes to PostgREST as the caller. With an EXPIRED bearer — the
        # everyday case, tokens last an hour — PostgREST answers 401,
        # `raise_for_status` turns that into an exception no handler
        # catches, and the user gets an opaque 500 instead of the 401
        # the frontend keys its re-login off. Verifying first makes the
        # refusal a decision rather than a crash.
        _org.verified_user_id(jwt)
        with _supabase.per_user(jwt) as client:
            rows = client.select("sales_datasets", filters={"id": f"eq.{dataset_id}"}, single=True)
            if not rows:
                raise HTTPException(404, "Dataset not found.")
            _org.require_org_member(jwt, rows[0].get("org_id"))  # the WRITE wall (FC1x, D4)
            client.update("sales_datasets", patch, filters={"id": f"eq.{dataset_id}"})
            rows = client.select("sales_datasets", filters={"id": f"eq.{dataset_id}"}, single=True)
            return rows[0]

    @router.delete("/api/sales-datasets/{dataset_id}")
    def delete_sales_dataset(dataset_id: str, authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
        """Soft-delete: marks the parent document as deleted_at=now() so the
        dataset list filter (which joins documents where deleted_at IS NULL)
        hides it. The sku_lines + sku_aggregates rows cascade-delete only
        when the dataset row itself is hard-deleted by the 30-day cron."""
        jwt = _require_jwt(authorization)
        # VERIFY BEFORE READING (FC1x, critic finding I1). The read below
        # goes to PostgREST as the caller. With an EXPIRED bearer — the
        # everyday case, tokens last an hour — PostgREST answers 401,
        # `raise_for_status` turns that into an exception no handler
        # catches, and the user gets an opaque 500 instead of the 401
        # the frontend keys its re-login off. Verifying first makes the
        # refusal a decision rather than a crash.
        _org.verified_user_id(jwt)
        with _supabase.per_user(jwt) as client:
            ds = client.select("sales_datasets", filters={"id": f"eq.{dataset_id}"}, single=True)
            if not ds:
                raise HTTPException(404, "Dataset not found.")
            doc_id = ds[0]["document_id"]
            _org.require_org_member(jwt, ds[0].get("org_id"))  # the WRITE wall (FC1x, D4)
            client.update("documents", {"deleted_at": _now_iso()}, filters={"id": f"eq.{doc_id}"})
            return {"dataset_id": dataset_id, "document_id": doc_id, "deleted_at": _now_iso()}

    @router.patch("/api/sku-aggregates/{sku_id}/decision")
    def patch_sku_decision(
        sku_id: str,
        payload: Dict[str, Any],
        authorization: Optional[str] = Header(None),
    ) -> Dict[str, Any]:
        """Persist the operator decision on a single SKU. Used by the Products
        detail drawer's two action buttons:
          - 'eliminate_approved' — operator confirms the engine's cut signal
          - 'strategic_override' — operator overrides eliminate/wind_down,
                                   marking the SKU as strategic (keep)
        Pass `null` to clear an existing override and fall back to the engine
        classification. The engine `classification` column is NOT mutated —
        we only write `user_override` so the override is reversible and the
        original engine reasoning stays auditable.
        """
        allowed = {"eliminate_approved", "strategic_override"}
        raw = payload.get("user_override")
        if raw is not None and raw not in allowed:
            raise HTTPException(
                400,
                f"Invalid user_override. Allowed: {sorted(allowed)} or null to clear.",
            )

        jwt = _require_jwt(authorization)
        # VERIFY BEFORE READING (FC1x, critic finding I1). The read below
        # goes to PostgREST as the caller. With an EXPIRED bearer — the
        # everyday case, tokens last an hour — PostgREST answers 401,
        # `raise_for_status` turns that into an exception no handler
        # catches, and the user gets an opaque 500 instead of the 401
        # the frontend keys its re-login off. Verifying first makes the
        # refusal a decision rather than a crash.
        _org.verified_user_id(jwt)
        with _supabase.per_user(jwt) as client:
            existing = client.select("sku_aggregates", filters={"id": f"eq.{sku_id}"}, single=True)
            if not existing:
                raise HTTPException(404, "SKU not found.")
            _org.require_org_member(jwt, existing[0].get("org_id"))  # the WRITE wall (FC1x, D4)
            client.update(
                "sku_aggregates",
                {"user_override": raw},
                filters={"id": f"eq.{sku_id}"},
            )
            rows = client.select("sku_aggregates", filters={"id": f"eq.{sku_id}"}, single=True)
            return {"sku": rows[0]}

    @router.post("/api/sales-datasets/{dataset_id}/rerun")
    def rerun_sales_dataset(dataset_id: str, authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
        """Re-classify a dataset AND re-extract DIO from the source XLSX.
        Useful after engine rule changes OR parser upgrades.

        2026-05-26 — extended from re-classify-only. Originally this
        endpoint just re-ran `classify_portfolio` on existing aggregates,
        so any improvement to the upload-time parsers (e.g. the new
        Analysis-sheet DIO extraction) was invisible to existing
        datasets — users had to re-upload from scratch to see new
        category DIO values. That's unintuitive: "rerun" should mean
        "run the pipeline again", not "re-color the existing buckets".
        Now: fetch the original XLSX → re-extract the DIO map (Analysis
        sheet preferred, DIO sheet fallback) → update each SKU row's
        `days_inventory_on_hand` from the category map → reclassify.
        """
        from ._sales_extract import (
            extract_category_dio,
            extract_category_dio_from_analysis_sheet,
            _normalize_category,
        )
        from ._sku_classify import classify_portfolio
        import re as _re

        jwt = _require_jwt(authorization)
        # VERIFY BEFORE READING (FC1x, critic finding I1). The read below
        # goes to PostgREST as the caller. With an EXPIRED bearer — the
        # everyday case, tokens last an hour — PostgREST answers 401,
        # `raise_for_status` turns that into an exception no handler
        # catches, and the user gets an opaque 500 instead of the 401
        # the frontend keys its re-login off. Verifying first makes the
        # refusal a decision rather than a crash.
        _org.verified_user_id(jwt)
        with _supabase.per_user(jwt) as client:
            ds = client.select("sales_datasets", filters={"id": f"eq.{dataset_id}"}, single=True)
            if not ds:
                raise HTTPException(404, "Dataset not found.")
            ds_row = ds[0]
        _org.require_org_member(jwt, ds_row.get("org_id"))  # the WRITE wall (FC1x, D4)

        with _supabase.admin() as ac:
            aggs = ac.select("sku_aggregates", filters={"dataset_id": f"eq.{dataset_id}"})
            if not aggs:
                return {"reclassified": 0}

            # ── DIO re-extraction pass ────────────────────────────
            # The dataset row carries `document_id` linking to the
            # original upload. If we can fetch the storage_path we
            # can re-run the modern DIO parsers on the source bytes
            # and refresh the per-SKU `days_inventory_on_hand` column.
            dio_updated = 0
            try:
                doc_id = ds_row.get("document_id")
                if doc_id:
                    docs = ac.select("documents", filters={"id": f"eq.{doc_id}"}, single=True)
                    if docs:
                        storage_path = docs[0].get("storage_path")
                        if storage_path:
                            signed = ac.signed_url(
                                "documents", storage_path,
                                org_id=docs[0].get("org_id"), expires_in=300)
                            r = httpx.get(signed, timeout=60.0)
                            r.raise_for_status()
                            xlsx_bytes = r.content
                            analysis_map = extract_category_dio_from_analysis_sheet(xlsx_bytes)
                            dio_sheet_map = extract_category_dio(xlsx_bytes)
                            cat_dio_map = {**dio_sheet_map, **analysis_map}
                            logger.info(
                                "[rerun] dataset=%s re-extracted category DIO: "
                                "analysis=%d, dio_sheet=%d, merged=%d",
                                dataset_id, len(analysis_map), len(dio_sheet_map),
                                len(cat_dio_map),
                            )
                            # Apply per-aggregate, mirroring aggregate_sku_lines
                            # fallback order: explicit DIO (kept as-is) >
                            # computed inv/cogs (kept as-is) > category map.
                            # We only OVERWRITE when the existing value is
                            # null — preserves any per-SKU DIO that was
                            # already correct from a richer-shaped workbook.
                            for a in aggs:
                                if a.get("days_inventory_on_hand") is not None:
                                    continue
                                cat = _normalize_category(a.get("category") or "")
                                dio = None
                                if cat and cat in cat_dio_map:
                                    dio = cat_dio_map[cat]
                                elif cat:
                                    base = _re.sub(r"\s+FILE$", "", cat).strip()
                                    if base and base in cat_dio_map:
                                        dio = cat_dio_map[base]
                                if dio is not None:
                                    ac.update(
                                        "sku_aggregates",
                                        {"days_inventory_on_hand": round(float(dio), 2)},
                                        filters={"id": f"eq.{a['id']}"},
                                    )
                                    a["days_inventory_on_hand"] = round(float(dio), 2)
                                    dio_updated += 1
                            logger.info(
                                "[rerun] dataset=%s applied category DIO to %d SKU rows",
                                dataset_id, dio_updated,
                            )
            except Exception:  # noqa: BLE001
                # DIO refresh is best-effort — don't fail the reclassify
                # if the source workbook is unreadable. Log and continue.
                logger.exception("[rerun] DIO re-extraction failed; reclassify only")

            # ── Reclassify pass (existing behaviour) ──────────────
            # Bridge column names: classifier expects 'sku' + 'revenue'.
            for a in aggs:
                a["sku"] = a["product_name"]
                a["revenue"] = a["niv_krn"] or 0
                a["cogs"] = max(0.0, (a["niv_krn"] or 0) - (a["gm_krn"] or 0))
            classified = classify_portfolio(aggs)
            for c in classified:
                ac.update(
                    "sku_aggregates",
                    {
                        "classification": c["classification"],
                        "classification_reason": c.get("classification_reason"),
                        "real_margin_krn": c.get("real_margin"),
                        "real_margin_pct": c.get("real_margin_pct"),
                    },
                    filters={"id": f"eq.{c['id']}"},
                )
            return {
                "reclassified": len(classified),
                "dio_refreshed": dio_updated,
            }

    @router.get("/api/sales-datasets/compare")
    def compare_sales_datasets(
        a: str,
        b: str,
        authorization: Optional[str] = Header(None),
    ) -> Dict[str, Any]:
        """Side-by-side comparison of two datasets. Matches SKUs by product_name;
        returns per-SKU deltas, top movers (winners + losers), and SKUs that
        exist in one dataset but not the other."""
        jwt = _require_jwt(authorization)
        with _supabase.per_user(jwt) as client:
            datasets = client.select(
                "sales_datasets",
                filters={"id": f"in.({a},{b})"},
            )
            if len(datasets) != 2:
                raise HTTPException(404, "One or both datasets not found.")
            ds_a = next(d for d in datasets if d["id"] == a)
            ds_b = next(d for d in datasets if d["id"] == b)

            skus_a = client.select("sku_aggregates", filters={"dataset_id": f"eq.{a}"})
            skus_b = client.select("sku_aggregates", filters={"dataset_id": f"eq.{b}"})

        by_name_a = {s["product_name"]: s for s in skus_a}
        by_name_b = {s["product_name"]: s for s in skus_b}
        all_names = sorted(set(by_name_a) | set(by_name_b))

        rows: List[Dict[str, Any]] = []
        for name in all_names:
            sa = by_name_a.get(name)
            sb = by_name_b.get(name)
            niv_a = float(sa["niv_krn"]) if sa and sa.get("niv_krn") else 0.0
            niv_b = float(sb["niv_krn"]) if sb and sb.get("niv_krn") else 0.0
            gm_a = float(sa["gm_krn"]) if sa and sa.get("gm_krn") else 0.0
            gm_b = float(sb["gm_krn"]) if sb and sb.get("gm_krn") else 0.0
            vol_a = float(sa["volume_tons"]) if sa and sa.get("volume_tons") else 0.0
            vol_b = float(sb["volume_tons"]) if sb and sb.get("volume_tons") else 0.0
            rows.append({
                "product_name": name,
                "brand": (sa or sb or {}).get("brand"),
                "category": (sa or sb or {}).get("category"),
                "niv_a": round(niv_a, 2),
                "niv_b": round(niv_b, 2),
                "niv_delta": round(niv_a - niv_b, 2),
                "gm_a": round(gm_a, 2),
                "gm_b": round(gm_b, 2),
                "gm_delta": round(gm_a - gm_b, 2),
                "volume_a": round(vol_a, 2),
                "volume_b": round(vol_b, 2),
                "volume_delta": round(vol_a - vol_b, 2),
                "classification_a": sa.get("classification") if sa else None,
                "classification_b": sb.get("classification") if sb else None,
                "new_in_a": not sb,
                "new_in_b": not sa,
            })

        # Movers: top 10 winners (gm_delta > 0) + top 10 losers (gm_delta < 0)
        ranked = sorted(rows, key=lambda r: r["gm_delta"], reverse=True)
        winners = [r for r in ranked if r["gm_delta"] > 0][:10]
        losers = [r for r in reversed(ranked) if r["gm_delta"] < 0][:10]
        new_in_active = [r for r in rows if r["new_in_a"]]

        return {
            "active": {
                "id": ds_a["id"],
                "label": ds_a["label"],
                "source_filename": ds_a.get("source_filename"),
            },
            "compared": {
                "id": ds_b["id"],
                "label": ds_b["label"],
                "source_filename": ds_b.get("source_filename"),
            },
            "totals": {
                "niv_a": round(sum(r["niv_a"] for r in rows), 2),
                "niv_b": round(sum(r["niv_b"] for r in rows), 2),
                "gm_a": round(sum(r["gm_a"] for r in rows), 2),
                "gm_b": round(sum(r["gm_b"] for r in rows), 2),
                "sku_count_a": len(skus_a),
                "sku_count_b": len(skus_b),
                "new_in_active": len(new_in_active),
            },
            "winners": winners,
            "losers": losers,
            "new_in_active": new_in_active[:20],
            "rows": rows,
        }

    @router.get("/api/sales-datasets")
    def list_sales_datasets(authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
        """Right-anchored Datasets panel feed for /products."""
        jwt = _require_jwt(authorization)
        with _supabase.per_user(jwt) as client:
            rows = client.select(
                "sales_datasets",
                order="uploaded_at.desc",
                columns="*,documents!inner(original_filename,status,deleted_at,period_id)",
            )
        active = [r for r in rows if not (r.get("documents") or {}).get("deleted_at")]
        return {
            "active_dataset_id": active[0]["id"] if active else None,
            "datasets": [{
                "id": r["id"],
                "label": r["label"],
                "source_filename": r.get("source_filename"),
                "row_count": r.get("row_count"),
                "sku_count": r.get("sku_count"),
                "uploaded_at": r["uploaded_at"],
                "is_active": r.get("is_active", True),
                "document_status": (r.get("documents") or {}).get("status"),
                "deleted_at": (r.get("documents") or {}).get("deleted_at"),
                # Exposed so the Products "Source files" cards can open the
                # uploaded file preview in a new tab (2026-07-26).
                "document_id": r.get("document_id"),
                # Month this file belongs to, so the Products file list can
                # nest files under the active period (2026-07-26). Set by the
                # FRONTEND at upload time from the then-active period — the
                # SKU pipeline branch deliberately resolves no period of its
                # own (it finalizes with period_id=None, which
                # _admin_set_status omits rather than nulls, so the value
                # survives). NULL for every pre-existing upload; the FE treats
                # NULL as "unassigned" and shows it under every month.
                "period_id": (r.get("documents") or {}).get("period_id"),
            } for r in active],
        }

    @router.get("/api/sales-datasets/{dataset_id}/skus")
    def list_skus_for_dataset(dataset_id: str, authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
        """All SKU aggregates for one dataset — the full 406-row portfolio.
        Frontend virtualizes the table, so this endpoint can return the
        whole list (typical files are 400-2000 SKUs, ~150 KB JSON)."""
        jwt = _require_jwt(authorization)
        # VERIFY BEFORE READING (FC1x, critic finding I1). The read below
        # goes to PostgREST as the caller. With an EXPIRED bearer — the
        # everyday case, tokens last an hour — PostgREST answers 401,
        # `raise_for_status` turns that into an exception no handler
        # catches, and the user gets an opaque 500 instead of the 401
        # the frontend keys its re-login off. Verifying first makes the
        # refusal a decision rather than a crash.
        _org.verified_user_id(jwt)
        with _supabase.per_user(jwt) as client:
            ds = client.select("sales_datasets", filters={"id": f"eq.{dataset_id}"}, single=True)
            if not ds:
                raise HTTPException(404, "Dataset not found.")
            skus = client.select(
                "sku_aggregates",
                filters={"dataset_id": f"eq.{dataset_id}"},
                order="gm_krn.desc.nullslast",
            )
        # Totals for the KPI strip — computed server-side once instead of
        # the frontend mapping over the full list per render.
        cls_counts: Dict[str, int] = {}
        total_volume = total_niv = total_gm = total_losses = 0.0
        categories: set = set()
        brands: set = set()
        for s in skus:
            cls = s.get("classification") or "keep"
            cls_counts[cls] = cls_counts.get(cls, 0) + 1
            total_volume += s.get("volume_tons") or 0
            total_niv += s.get("niv_krn") or 0
            total_gm += s.get("gm_krn") or 0
            if (s.get("gm_krn") or 0) < 0:
                total_losses += s.get("gm_krn") or 0
            if s.get("category"):
                categories.add(s["category"])
            if s.get("brand"):
                brands.add(s["brand"])
        return {
            "dataset": {
                "id": ds[0]["id"],
                "label": ds[0]["label"],
                "source_filename": ds[0].get("source_filename"),
                "row_count": ds[0].get("row_count"),
                "sku_count": ds[0].get("sku_count"),
                "uploaded_at": ds[0]["uploaded_at"],
            },
            "totals": {
                "sku_count": len(skus),
                "classification_counts": cls_counts,
                "volume_tons": round(total_volume, 2),
                "niv_krn": round(total_niv, 2),
                "gm_krn": round(total_gm, 2),
                "losses_krn": round(total_losses, 2),
                "category_count": len(categories),
                "brand_count": len(brands),
                "categories": sorted(categories),
                "brands": sorted(brands),
            },
            "skus": skus,
        }

    @router.get("/api/sku-analysis/portfolio")
    def get_sku_portfolio(authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
        """Consolidated payload for the Products page: totals, classification
        counts, full SKU list (frontend virtualizes), categories, briefing,
        recommendations. Returns the latest active SKU document's analysis.
        """
        from ._sku_classify import portfolio_totals
        jwt = _require_jwt(authorization)
        with _supabase.per_user(jwt) as client:
            # Latest active sku document
            docs = client.select(
                "documents",
                filters={"scope": "eq.sku", "is_active": "eq.true", "deleted_at": "is.null"},
                order="created_at.desc",
                limit=1,
            )
            if not docs:
                return {"document": None, "totals": None, "skus": [], "analysis": None}
            doc = docs[0]
            skus = client.select(
                "sku_aggregates",
                filters={"document_id": f"eq.{doc['id']}"},
                order="real_margin.desc.nullslast",
            )
            analyses = client.select(
                "sku_analyses",
                filters={"document_id": f"eq.{doc['id']}"},
            )
            analysis = analyses[0] if analyses else None

        totals = portfolio_totals(skus)
        return {
            "document": {
                "id": doc["id"],
                "filename": doc.get("display_name") or doc["original_filename"],
                "status": doc["status"],
                "created_at": doc["created_at"],
                "is_active": doc.get("is_active", True),
            },
            "totals": totals,
            "skus": skus,
            "analysis": analysis and {
                "briefing": analysis.get("briefing"),
                "recommendations": analysis.get("recommendations") or [],
                "summary": analysis.get("summary") or {},
                "model": analysis.get("model"),
            },
        }

    @router.get("/api/sku-analysis/documents")
    def list_sku_documents(authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
        """Document history for /products. Excludes soft-deleted docs by default."""
        jwt = _require_jwt(authorization)
        with _supabase.per_user(jwt) as client:
            docs = client.select(
                "documents",
                filters={"scope": "eq.sku", "deleted_at": "is.null"},
                order="created_at.desc",
            )
            counts: Dict[str, int] = {}
            for d in docs:
                rows = client.select(
                    "sku_aggregates",
                    filters={"document_id": f"eq.{d['id']}"},
                    columns="id",
                )
                counts[d["id"]] = len(rows)
        return {
            "documents": [
                {
                    "id": d["id"],
                    "filename": d.get("display_name") or d["original_filename"],
                    "original_filename": d["original_filename"],
                    "status": d["status"],
                    "is_active": d.get("is_active", True),
                    "created_at": d["created_at"],
                    "size_bytes": d["size_bytes"],
                    "sku_count": counts.get(d["id"], 0),
                    "error": d.get("error"),
                }
                for d in docs
            ],
        }

    @router.get("/api/sku-analysis/inflight")
    def get_inflight_sku_doc(authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
        """Return the most recent in-flight (not analyzed) SKU document, if any.
        Lets the Products page resume showing a progress card after a refresh.

        Watchdog: if the doc has been sitting at status='queued' with
        pipeline_started_at=None — i.e. the upload completed but
        /api/pipeline/run was never delivered (network blip, backend was
        down at upload time) — auto-enqueue it on the next poll. This
        prevents the "stuck at Step 0 of 6 forever" failure the user
        otherwise has no way to recover from without a manual retry.
        """
        jwt = _require_jwt(authorization)
        with _supabase.per_user(jwt) as client:
            rows = client.select(
                "documents",
                filters={"scope": "eq.sku"},
                columns="id,org_id,original_filename,status,error,created_at,pipeline_started_at,deleted_at",
                order="created_at.desc",
                limit=1,
            )
            if not rows:
                return {"document": None}
            d = rows[0]
            if d.get("status") in ("analyzed", "failed"):
                return {"document": None}

            # ── Auto-recover stuck uploads ──────────────────────────────
            # If the doc is queued AND the pipeline never started (no
            # pipeline_started_at), AND the row is older than 5 seconds
            # (race-condition guard against the normal upload→enqueue
            # gap), kick it now.
            try:
                from datetime import datetime, timezone, timedelta
                if d.get("status") == "queued" and not d.get("pipeline_started_at") and not d.get("deleted_at"):
                    created_dt = _doc_dedupe._ts(d.get("created_at"))
                    if created_dt and datetime.now(timezone.utc) - created_dt > timedelta(seconds=5):
                        # THE SAME METER AS /run and recover-stuck (2026-09-21).
                        # This watchdog used to enqueue with no reservation —
                        # a SKU upload refused by the 402 ran anyway — and its
                        # terminal then counted a slot nobody had reserved.
                        caller_id = str(_org.verified_user_id(jwt))
                        if not _org.user_is_member(caller_id, str(d.get("org_id") or "")):
                            # Firm visibility is a READ grant: a viewer's poll
                            # never enqueues (and never bills) a client's file.
                            return {"document": d}
                        full = client.select("documents", filters={"id": f"eq.{d['id']}"}, single=True)
                        row = full[0] if full else dict(d)
                        outcome, info = _recover_one(row, caller_id)
                        if outcome == "duplicate":
                            return {"document": None}
                        if outcome == "recovered":
                            logger.warning(
                                "[pipeline] watchdog: doc %s stuck at queued with no pipeline_started_at — auto-enqueued",
                                d["id"],
                            )
                        elif outcome == "needs_confirmation":
                            logger.info("[pipeline] watchdog: doc %s not re-enqueued — %s",
                                        d["id"], info.get("reason"))
            except Exception:  # noqa: BLE001
                logger.exception("[pipeline] watchdog auto-enqueue failed (non-fatal)")
            return {"document": d}

    @router.post("/api/pipeline/recover-stuck", status_code=200)
    def recover_stuck_pipelines(authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
        """Generic watchdog — find every doc the caller's org has at
        status='queued' with NO pipeline_started_at AND older than 5s, then
        re-enqueue all of them. Same recovery the SKU-only watchdog in
        /api/sku-analysis/inflight does, but covers *every* scope so the
        FinancialStatements page can also escape the "Step 0 of 6 forever"
        trap when /api/pipeline/run silently fails at upload moment (env
        crash, network blip, backend restart between FE upload and FE
        enqueue, etc.).

        Idempotent — calling it twice in a row is safe; the second pass sees
        pipeline_started_at != None and skips. RLS-scoped so a user can only
        recover their own org's docs.

        Returns the list of recovered doc IDs + a count so the FE can show
        a toast like "Recovered 2 stuck uploads".
        """
        jwt = _require_jwt(authorization)
        from datetime import datetime, timezone, timedelta

        recovered: List[Dict[str, Any]] = []
        needs_confirmation: List[Dict[str, Any]] = []
        duplicates: List[Dict[str, Any]] = []
        # VERIFY BEFORE READING (FC1x, critic finding I1) — see the note
        # on the sales-dataset handlers: an expired bearer must be a 401
        # from the verifier, not a PostgREST 401 escaping as a 500.
        caller_id = str(_org.verified_user_id(jwt))
        with _supabase.per_user(jwt) as client:
            rows = client.select(
                "documents",
                # `*`, not a column list: the duplicate check needs the
                # optional `period_end_hint`, which naming would 400 on a
                # database without it. Archived / deleted rows are never
                # "stuck".
                filters={"status": "eq.queued", "deleted_at": "is.null"},
                order="created_at.desc",
                limit=20,
            )
            # The WRITE wall (FC1x, D4): re-enqueue only the caller's OWN
            # workspaces' stuck uploads, never a client's seen through
            # firm visibility.
            rows = _only_member_orgs(jwt, rows)
            if rows:
                logger.info("[pipeline] recover-stuck: scanning %d queued doc(s) for caller", len(rows))
            now = datetime.now(timezone.utc)
            cutoff_min = now - timedelta(seconds=5)
            # Hard age cap: don't re-enqueue zombie docs older than 24h —
            # the user has clearly moved on (likely uploaded a fresh copy
            # in the meantime), and silently spawning a new period on next
            # page-load would pollute the dashboard with duplicates. Mark
            # those as failed instead so they leave the inflight tracker.
            cutoff_max = now - timedelta(hours=24)
            stale_failed: List[Dict[str, Any]] = []
            for d in rows:
                if d.get("pipeline_started_at"):
                    continue  # worker thread already kicked
                created = d.get("created_at")
                if not created:
                    continue
                try:
                    created_dt = datetime.fromisoformat(created.replace("Z", "+00:00"))
                except (ValueError, AttributeError):
                    continue
                if created_dt > cutoff_min:
                    continue  # too fresh — normal upload→enqueue race window
                if created_dt < cutoff_max:
                    # Zombie — mark failed so it stops showing as inflight.
                    logger.warning(
                        "[pipeline] recover-stuck: doc %s (%s, scope=%s) >24h stale — marking failed",
                        d["id"], d.get("original_filename"), d.get("scope"),
                    )
                    try:
                        _admin_set_status(
                            d["id"], "failed",
                            error="Pipeline never started (upload-time backend hiccup). Please re-upload.",
                        )
                        stale_failed.append({
                            "id": d["id"],
                            "filename": d.get("original_filename"),
                            "scope": d.get("scope"),
                        })
                    except Exception:  # noqa: BLE001
                        logger.exception("[pipeline] failed to mark stale doc as failed")
                    continue
                # THE SAME METER AS /api/pipeline/run (2026-09-20) and THE
                # SAME ENTRY (2026-09-21): `_recover_one`. A document whose
                # run was REFUSED — 402 extra-document confirmation, 429
                # blocked — is left exactly as the browser inserted it:
                # status='queued', no pipeline_started_at. That is this
                # watchdog's definition of "stuck", so it used to enqueue the
                # very documents the meter had just refused, with no
                # reservation: an unbilled extra on every page load (measured
                # in production: two documents ran with metered_extra false
                # after their 402). Recovery reserves under the CALLER's
                # verified identity, as /run does; a refusal leaves the
                # document queued and says so, and the FE's Retry sends it
                # back through /run where the confirm dialog lives. A
                # duplicate of a live document of the caller's in the same
                # company is archived, not re-enqueued.
                outcome, info = _recover_one(d, caller_id)
                if outcome == "duplicate":
                    duplicates.append({
                        "id": d["id"], "filename": d.get("original_filename"),
                        "scope": d.get("scope"), **info,
                    })
                elif outcome == "needs_confirmation":
                    needs_confirmation.append({
                        "id": d["id"], "filename": d.get("original_filename"),
                        "scope": d.get("scope"), "reason": info.get("reason"),
                    })
                elif outcome == "recovered":
                    logger.warning(
                        "[pipeline] recover-stuck: doc %s (%s, scope=%s) stuck — re-enqueued",
                        d["id"], d.get("original_filename"), d.get("scope"),
                    )
                    recovered.append({
                        "id": d["id"],
                        "filename": d.get("original_filename"),
                        "scope": d.get("scope"),
                    })
        return {
            "recovered_count": len(recovered),
            "recovered": recovered,
            "stale_failed_count": len(stale_failed),
            "stale_failed": stale_failed,
            "needs_confirmation_count": len(needs_confirmation),
            "needs_confirmation": needs_confirmation,
            "duplicates_count": len(duplicates),
            "duplicates": duplicates,
        }

    @router.post("/api/pipeline/retry", response_model=RunResponse, status_code=202)
    def retry_pipeline(req: RunRequest, authorization: Optional[str] = Header(None)) -> RunResponse:
        jwt = _require_jwt(authorization)
        doc = _verify_user_may_write_document(jwt, req.document_id)  # the WRITE wall (FC1x, D4)
        # A re-run of a document that duplicates a live one (an older copy
        # uploaded before dedupe existed, retried from the Docs panel) is
        # archived instead of re-analysed. A document whose run is already
        # in flight is not started a second time: two daemon threads on one
        # document is never a re-run. A re-run of an ANALYSED document (a
        # correction) reserves nothing and — with no ledger entry — settles
        # nothing; a document that holds no analysis yet (its first run
        # failed, or its 402 was dismissed) is metered exactly like /run,
        # 402 / 429 included (`_start_rerun`).
        entry = _start_rerun(doc, _user_id_from_jwt(jwt),
                             lambda: _retry_rerun(req.document_id, doc))
        if entry.kind == _doc_dedupe.DELETED:
            raise HTTPException(409, {
                "code": "document_deleted",
                "message": "This document was deleted. Restore it before re-running it.",
            })
        if entry.kind == _doc_dedupe.DUPLICATE:
            return RunResponse(document_id=req.document_id, status="duplicate",
                               existing_document_id=entry.hit.existing_document_id if entry.hit else None,
                               period_id=entry.hit.period_id if entry.hit else None)
        if entry.kind != _doc_dedupe.CLAIMED:
            return RunResponse(document_id=req.document_id, status=entry.status or "queued",
                               period_id=entry.period_id)
        return RunResponse(document_id=req.document_id, status="queued")

    def _retry_rerun(document_id: str, doc: Dict[str, Any]) -> None:
        """The body of a claimed retry: wipe the prior derivatives, queue,
        hand the run to its thread."""
        # Wipe prior derivatives via cascade — deleting the financial_periods
        # row removes statement_line_items, calculated_metrics, briefings,
        # AND alerts (alerts.document_id has on delete set null, we explicitly
        # wipe by document below for that one).
        # THE ORG IS PART OF THE FILTER, not an assumption (P0, 2026-09-09).
        # `documents.period_id` is written by the BROWSER — `documents` RLS is
        # is_member_of(org_id) with no column restriction, and its FK to
        # financial_periods is EXISTENCE-only, so nothing ties it to the same
        # tenant. The write wall above validated the DOCUMENT; it never looked
        # at period_id. This delete runs under the SERVICE ROLE, so the filter
        # IS the access control — filtering on id alone let a row filed in
        # your own workspace, carrying another workspace's period id, delete
        # that period and cascade away its line items, metrics and briefings.
        # Same defect as the storage-path bypass and the make-active twin
        # fixed the same day. With org_id in the filter a cross-tenant id
        # simply matches nothing.
        doc_org = str(doc.get("org_id") or "").strip()
        if doc.get("period_id") and doc_org:
            with _supabase.admin() as admin_client:
                admin_client.delete("financial_periods", filters={
                    "id": f"eq.{doc['period_id']}",
                    "org_id": f"eq.{doc_org}",
                })
        with _supabase.admin() as admin_client:
            admin_client.delete("alerts", filters={"document_id": f"eq.{document_id}"})
            admin_client.update(
                "documents",
                {"period_id": None, "error": None, "duration_ms": None},
                filters={"id": f"eq.{document_id}"},
            )
        _admin_set_status(document_id, "queued", pipeline_started_at=_now_iso())
        _doc_dedupe.mark_running(document_id)
        _enqueue(document_id)

    @router.get("/api/period/{period_id}")
    def get_period(period_id: str, authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
        """Return the consolidated payload for one period: statements (assembled
        from line items), metrics, briefing, recommendations, alerts.

        RLS-scoped: uses the caller's JWT so they only see their own data.
        """
        jwt = _require_jwt(authorization)
        with _supabase.per_user(jwt) as client:
            # plan/2 B5 (contract 1.4): the period, its line items and its
            # organization are read through the one module-scope reader,
            # id-only (RLS scopes the row) and with no rebuild, so this
            # handler's served assembly below is unchanged.
            try:
                loaded = load_period_rows(client, period_id, org_id=None, rebuild=False)
            except PeriodNotFound:
                raise HTTPException(404, "Period not found.")
            period = loaded["row"]
            line_items = loaded["line_items"]
            metrics = client.select(
                "calculated_metrics",
                filters={"period_id": f"eq.{period_id}"},
            )
            briefings = client.select("briefings", filters={"period_id": f"eq.{period_id}"})
            briefing = briefings[0] if briefings else None

            doc_rows = client.select(
                "documents",
                filters={"id": f"eq.{period['source_document_id']}"},
                single=True,
            ) if period.get("source_document_id") else []
            doc = doc_rows[0] if doc_rows else None
            org_id = period["org_id"]

            # Phase D-backend: scope alerts + recommendations to this
            # period_id rather than the whole org. Pre-fix this query
            # returned every alert/rec in the org on every period view,
            # which is why a single period showed "(80 on file)" — that
            # was 5 periods' worth of rules + stale rows from old
            # document_ids accumulated in one list.
            #
            # Backward compat: legacy rows have period_id IS NULL (the
            # migration backfills via documents.period_id when possible
            # but can't attribute every historic row). Those legacy
            # NULL rows are intentionally excluded here — the FE never
            # surfaces them. They remain in the table for audit until
            # someone wants to garbage-collect.
            recs = client.select(
                "recommendations",
                filters={"period_id": f"eq.{period_id}"},
                order="urgency.desc,created_at.desc",
            )
            alerts = client.select(
                "alerts",
                filters={
                    "period_id": f"eq.{period_id}",
                    "resolved_at": "is.null",
                },
            )

            org = loaded["org"]

            # Valuation row (one per period). Returned at the top level so the
            # dashboard can render the EBITDA-multiple primary card.
            valuation_rows = client.select(
                "valuations",
                filters={"period_id": f"eq.{period_id}"},
                single=True,
            )
            valuation = valuation_rows[0] if valuation_rows else None

            # Per-user assumption overrides — only returned if the user has
            # saved any. Dashboard merges these on top of engine defaults.
            try:
                ua_rows = client.select(
                    "user_valuation_assumptions",
                    filters={"period_id": f"eq.{period_id}"},
                    single=True,
                )
                user_assumptions = ua_rows[0] if ua_rows else None
            except Exception:  # noqa: BLE001
                user_assumptions = None

        # Re-assemble Statements from line_items so the frontend doesn't need
        # to know how to rebuild them.
        bs_buckets = {
            "cash": "cash", "ar": "accountsReceivable", "inventory": "inventory",
            "otherCurrentAssets": "otherCurrentAssets",
            "ppe": "propertyPlantEquipment", "intangibles": "intangibles",
            "otherNonCurrentAssets": "otherNonCurrentAssets",
            "ap": "accountsPayable", "stDebt": "shortTermDebt", "otherCurrentLiab": "otherCurrentLiabilities",
            "ltDebt": "longTermDebt", "otherNonCurrentLiab": "otherNonCurrentLiabilities",
            "shareCapital": "shareCapital", "retainedEarnings": "retainedEarnings", "otherEquity": "otherEquity",
        }
        pl_buckets = {
            "revenue": "revenue", "cogs": "costOfGoodsSold", "operatingExpenses": "operatingExpenses",
            "depreciation": "depreciationAmortization", "interestExpense": "interestExpense",
            "otherIncome": "otherIncome", "financialIncome": "financialIncome",
            "financialExpense": "financialExpense", "taxExpense": "taxExpense",
        }
        bs: Dict[str, float] = {v: 0.0 for v in bs_buckets.values()}
        pl: Dict[str, float] = {v: 0.0 for v in pl_buckets.values()}
        # SPLIT-OUT bucket for RAS account 711 (Variația stocurilor —
        # inventory variation). `_ro_coa._persistence_bucket()` writes
        # 711 to `statement_line_items.bucket = 'otherIncome'` so the
        # existing DB CHECK constraint accepts it, but cash-view EBITDA
        # MUST exclude 711 (it's a non-cash production-variation
        # accrual). Without this split, the FE's `deriveTotals`
        # computes `ebitda = grossProfit - opex + otherIncome` and
        # picks up the 711 inflation — for Scandia FY2025 that's
        # +630M, turning a 13% EBITDA margin into a nonsensical 165%.
        # Identify 711 lines by their ro_account_code prefix and route
        # them into a separate `inventoryVariationMemo` field that the
        # FE knows to exclude from cash EBITDA.
        inv_var_memo = 0.0
        for item in line_items:
            bucket = item["bucket"]
            amount = float(item["amount"] or 0)
            code = (item.get("ro_account_code") or "").strip()
            if bucket in bs_buckets:
                bs[bs_buckets[bucket]] += amount
            elif bucket in pl_buckets:
                # Carve out 711 from otherIncome before the bucket sum.
                if bucket == "otherIncome" and code.startswith("711"):
                    inv_var_memo += amount
                else:
                    pl[pl_buckets[bucket]] += amount

        # Equity completion — the SAME code object `_rebuild_assembled`
        # runs (see `_complete_bucket_equity`). Applied to the cent-rounded
        # buckets so the served bucket equity equals the served
        # `canonical_bs` equity to the cent, not merely to the float.
        # `pl["otherIncome"]` already excludes 711 here, hence 0.0.
        bs = {k: round(v, 2) for k, v in bs.items()}
        _complete_bucket_equity(bs, pl, period, inv_var_711=0.0)

        statements = {
            "companyName": (org or {}).get("name") if org else None,
            "industry": (org or {}).get("industry_display_name") if org else None,
            "currency": period.get("currency", "RON"),
            "periodLabel": period.get("period_end"),
            "balanceSheet": {k: round(v, 2) for k, v in bs.items()},
            "incomeStatement": {
                **{k: round(v, 2) for k, v in pl.items()},
                # Surfaced separately so the FE can render the
                # production-variation footnote AND so cash EBITDA
                # never re-inflates from it.
                "inventoryVariationMemo": round(inv_var_memo, 2),
            },
            # Required by the TS Statements interface so computeRatios() can
            # read supplementary.periodDays — established from the period
            # row or refused with its reason, never a 365 placeholder.
            "supplementary": _served_supplementary(period),
        }

        # ── Re-assemble the canonical views from line items ──────────────
        # The DB row only carries the legacy bucket-level aggregates, but
        # the Valuation tab + briefing now consume `assembled_pl`,
        # `assembled_bs`, `assembled_cf` (operating-view EBITDA, real
        # CapEx, etc.). Reconstruct them deterministically from the
        # per-account `line_items` so the page-load response carries the
        # same canonical facts the pipeline computed at write time.
        try:
            # F3.1c: dispatch via the country pack rather than direct
            # `_ro_coa` import. `_coa_mod` alias preserved so the call
            # sites below read identically.
            _coa_mod = _ro_pack()
            recovered_accounts = []
            for li in (line_items or []):
                code = li.get("ro_account_code") or ""
                if not code:
                    continue
                stored_bucket = li.get("bucket") or li.get("canonical_bucket") or ""
                rule = _coa_mod.bucket_for(code)
                # Detect side-flip / inventory-contra: if the persisted bucket
                # diverges from what bucket_for(code) would now return, the
                # write-path must have routed this row via `bucket_override`
                # (typical for 418 customer-accrual C-side, 451 affiliated
                # C-side, etc.). Preserve that override so the re-assembled
                # canonical view round-trips correctly. Without this, every
                # /api/period reassembly silently moves the side-flipped
                # amounts BACK to the natural-side bucket — a BS asset bloom
                # plus a matching liability hole of identical magnitude.
                bucket_override = None
                if rule and stored_bucket and stored_bucket != rule.bucket:
                    # Also tolerate the legacy-bucket bridge (e.g. canonical
                    # `ar_intercompany` persists as `otherCurrentAssets`).
                    legacy = _coa_mod.persistence_bucket(rule.bucket)
                    if stored_bucket != legacy:
                        bucket_override = stored_bucket
                row = {
                    "code": code,
                    "name": li.get("ro_account_name") or "",
                    # `line_items.amount` is already signed (mapping rule
                    # applied at write time). assemble_statements expects
                    # raw amounts and re-applies the sign via the mapping
                    # rule. To avoid double-signing, divide back out.
                    "amount": float(li.get("amount") or 0),
                }
                if bucket_override:
                    row["bucket_override"] = bucket_override
                recovered_accounts.append(row)
            # Re-apply sign so assemble_statements sees the raw input.
            for acct in recovered_accounts:
                rule = _coa_mod.bucket_for(acct["code"])
                if rule and rule.sign == -1:
                    acct["amount"] = -acct["amount"]
            # Account 121 anchor — see `_assemble_with_statutory_anchor`.
            # This is the Statements page P&L, the Valuation tab, the
            # cash-flow statement and the NAV cascade's book-equity
            # floor; it does NOT go through
            # `_rebuild_assembled_for_briefing`, which is why the anchor
            # has to be resolved through the shared helper at every site
            # rather than fixed once at the seam.
            assembled_full = _assemble_with_statutory_anchor(
                _coa_mod.assemble_statements,
                recovered_accounts,
                period_row=period,
                line_items=line_items,
                company_name=statements["companyName"] or "Entity",
                currency=statements["currency"],
                period_label=str(statements["periodLabel"]) if statements["periodLabel"] else "Period",
                industry=(org or {}).get("industry_key") if org else None,
            )
            # Surface canonical views on the response statements.
            statements["assembled_bs"] = assembled_full["statements"].get("assembled_bs")
            statements["assembled_pl"] = assembled_full["statements"].get("assembled_pl")
            statements["assembled_cf"] = assembled_full["statements"].get("assembled_cf")
            # F1.f / F1.g — bands + Piotroski live on the re-assembled
            # canonical view; carry them through to the response.
            statements["assembled_bands"] = assembled_full["statements"].get("assembled_bands")
            statements["assembled_piotroski"] = assembled_full["statements"].get("assembled_piotroski")
            statements["subAggregates"] = assembled_full["statements"].get("subAggregates")
            # F4.1e — surface the country-agnostic canonical envelope on the
            # response statements. Lives at top level of `assembled_full`
            # (sibling of `statements`), NOT under statements.assembled_*.
            # Source: chart_of_accounts.assemble_statements line ~1817.
            statements["assembled_canonical_v1"] = assembled_full.get("assembled_canonical_v1")

            # F4.3 — surface the detection envelope (country/standard/doc_type/
            # industry + methodology pin per CANONICAL_SCHEMA_V1.md §7).
            try:
                from engine.detection import build_detection_envelope as _bde  # type: ignore
                statements["detection_envelope"] = _bde(
                    classification=None, assembled=assembled_full,
                    methodology_id="ro_ras_2025_v1",
                    industry_key=(org or {}).get("industry_key") if org else None,
                    currency=statements.get("currency"),
                    period_end=str(statements.get("periodLabel") or ""),
                )
            except Exception:  # noqa: BLE001
                logger.exception("[/api/period] detection envelope build failed (non-fatal)")
        except Exception:  # noqa: BLE001
            logger.exception("[/api/period] canonical re-assembly failed (non-fatal)")

        # F3.27-DRIFT-TRANSFORMATION-GLUE — Fix A1, now shared with the
        # briefing rebuild via `_apply_envelope_truth_to_statements` and
        # extended for canonical_bs v2: when the PERSISTED envelope
        # carries `canonical_bs`, it is served VERBATIM as
        # `statements.canonical_bs` and sources the assembled_bs totals;
        # legacy envelopes keep the original methodology.totals override.
        # Deliberately OUTSIDE the re-assembly try above so the persisted
        # truth is still served when re-assembly itself failed, and BEFORE
        # the confidence report below — build_confidence_report reads the
        # same `assembled_bs` dict by reference, so the override must land
        # first (correctness-by-aliasing noted in the audit).
        _apply_envelope_truth_to_statements(statements, period)

        # SEAM 1 of 2 — the insight block. Immediately after the
        # envelope-truth override so the detectors read the SERVED book
        # (the reconciliation-adjusted `canonical_bs` the FE renders),
        # never the round-trip artifact. See `_attach_insights_block`.
        _attach_insights_block(statements, line_items)

        # ── F3.3 — Per-upload confidence report ─────────────────────
        # Surface the country-detection / layout / reconciliation /
        # Review-Mode-trigger envelope on every analysis page. Uses
        # the assembled output (already produced above) plus a
        # synthesised content blob (line-items code+name concat) for
        # detection — the original document bytes aren't always
        # available at read time, but the line-items carry enough RAS
        # signal for the pack's detect_from_content() to score
        # confidently.
        confidence_dict: Optional[Dict[str, Any]] = None
        try:
            from engine.core.upload_classifier import classify_upload
            from engine.core.confidence_engine import (
                build_confidence_report,
                confidence_report_to_dict,
            )
            # Synthesise a content blob from line items + period
            # metadata so the pack's existing text-pattern detector
            # has something to scan. This is sufficient for high-
            # confidence Romanian detection (account codes alone
            # carry 0.30 weight, language labels 0.25). Real
            # uploads at write time will use the original document
            # bytes (future enhancement once we plumb them through).
            synth_lines = []
            for li in (line_items or [])[:200]:
                code = li.get("ro_account_code") or ""
                name = li.get("ro_account_name") or ""
                synth_lines.append(f"{code} {name}")
            synth_lines.append(f"Moneda: {period.get('currency', 'RON')}")
            synth_lines.append("Sume totale credit  Sold final debitor")  # SAGA header marker
            synth = "\n".join(synth_lines).encode("utf-8", errors="ignore")
            fn_hint = (doc or {}).get("original_filename") or "balanta.xlsx"
            classification = classify_upload(synth, fn_hint)
            report = build_confidence_report(classification, assembled_full)
            confidence_dict = confidence_report_to_dict(report)
            # F4.4-int — run fan-out routing on top of the classification
            # so the detection envelope's routing_decision field gets
            # populated. With one pack registered, fan-out collapses to
            # fast_path; with multiple, the highest-coverage pack is
            # auto-picked. Either way we rebuild the detection envelope
            # with full classification + routing_decision attached
            # (the earlier build at line ~5078 used classification=None).
            try:
                from engine.routing import route_with_fan_out as _route, routing_decision_dict as _rdd
                from engine.detection import build_detection_envelope as _bde2
                _routing_result = _route(
                    classification, synth, fn_hint,
                    company_name=statements.get("companyName") or "Entity",
                    currency=statements.get("currency") or "RON",
                    period_label=str(statements.get("periodLabel") or ""),
                    industry=(org or {}).get("industry_key") if org else None,
                )
                statements["detection_envelope"] = _bde2(
                    classification=classification,
                    assembled=assembled_full,
                    methodology_id="ro_ras_2025_v1",
                    industry_key=(org or {}).get("industry_key") if org else None,
                    currency=statements.get("currency"),
                    period_end=str(statements.get("periodLabel") or ""),
                    routing_decision=_rdd(_routing_result),
                )
            except Exception:  # noqa: BLE001
                logger.exception("[/api/period] fan-out routing integration failed (non-fatal)")
        except Exception:  # noqa: BLE001
            logger.exception("[/api/period] confidence report build failed (non-fatal)")

        # ── F1.i — typed `assembled_metrics` envelope. Single bundled
        # object the FE imports + reads; eliminates string lookups
        # against `metrics[]` and removes the case-by-case fallback
        # chains the canonical-conformance audit catalogued. Composed
        # here at read time from data already on the response (no new
        # math, no new persistence).
        _m_by_name = {m["name"]: m for m in (metrics or [])}
        # THE CREDIT CONTENT IS COMPOSED AND CHECKED AT THE SERVING BOUNDARY
        # (engine.ratios.credit_boundary, owner 2026-09-20). This route hands
        # the boundary the PERSISTED rows untouched; when the serve-time
        # model below does not replace the credit block, the boundary
        # composes the `basis: as_filed` envelope under the whole law
        # (range, the model's own domain, no composite beside a refused
        # component, a pack that cannot be read) at the moment the body
        # leaves - so no fallback on this route can serve an unchecked
        # figure. Nothing credit-family is read here.
        def _m(name: str) -> Optional[float]:
            row = _m_by_name.get(name)
            return None if row is None else row.get("value")
        assembled_metrics_envelope = {
            "pl": statements.get("assembled_pl") or {},
            "bs": statements.get("assembled_bs") or {},
            "cf": statements.get("assembled_cf") or {},
            "ratios": {
                "liquidity": {
                    "current_ratio":         _m("current_ratio"),
                    "quick_ratio":           _m("quick_ratio"),
                    "cash_ratio":            _m("cash_ratio"),
                    "working_capital":       _m("working_capital"),
                    "net_debt":              _m("net_debt"),
                    "net_debt_to_ebitda":    _m("net_debt_to_ebitda"),
                },
                "leverage": {
                    "equity_ratio":          _m("equity_ratio"),
                    "debt_to_assets":        _m("debt_to_assets"),
                    "debt_to_equity":        _m("debt_to_equity"),
                    "debt_to_ebitda":        _m("debt_to_ebitda"),
                    "lt_debt_to_equity":     _m("lt_debt_to_equity"),
                },
                "coverage": {
                    "interest_coverage":     _m("interest_coverage"),
                    "ebitda_to_interest":    _m("ebitda_to_interest"),
                    "dscr":                  _m("dscr"),
                    "dscr_with_lt_principal":_m("dscr_with_lt_principal"),
                },
                "profitability": {
                    "gross_margin":          _m("gross_margin"),
                    "operating_margin":      _m("operating_margin"),
                    "ebitda_margin":         _m("ebitda_margin"),
                    "core_ebitda_margin":    _m("core_ebitda_margin"),
                    "net_margin":            _m("net_margin"),
                    "roa":                   _m("roa"),
                    "roe":                   _m("roe"),
                    "roic":                  _m("roic"),
                },
                "efficiency": {
                    "asset_turnover":        _m("asset_turnover"),
                    "dso":                   _m("dso"),
                    "dio":                   _m("dio"),
                    "dpo":                   _m("dpo"),
                    "ccc":                   _m("ccc"),
                    "inventory_turnover":    _m("inventory_turnover"),
                },
            },
            "bands": statements.get("assembled_bands"),
            # A stub: `credit_boundary.enforce_credit_boundary` composes the
            # as-filed envelope from `metrics` + `statements` on the way out
            # (or the serve-time model replaces this block below).
            "credit": {"basis": "as_filed"},
            "piotroski": statements.get("assembled_piotroski"),
            # `valuation` is deferred to F1.j (new override endpoint) —
            # the existing `valuation` key on the response carries the
            # current data the FE can read meanwhile.
        }

        # ── The second opinion on `organizations.industry_key` ─────────
        # The workspace industry is a USER SETTING and nothing checked it
        # against the book: the Agras Dec-2025 report was headed "Real
        # estate · residential rental" over a trial balance carrying 301
        # raw materials, 341/345 own-produced stock and 26.5M of 607
        # merchandise cost. Read the account mix here, next to the line
        # items it reads, and serve the reading WITH its evidence plus a
        # single agreement verdict — one computation, so the banner and
        # the block cannot disagree with each other. A failure here must
        # never cost the reader the rest of the report, so it degrades to
        # an absent key (the FE then renders no banner and blocks
        # nothing) rather than a 500.
        industry_signal_block = None
        try:
            from ..industry import build_industry_signal as _build_industry_signal

            # Bases come from the LINE ITEMS, not from the assembled
            # totals: every share the reading prints must be reproducible
            # from the accounts it names, and a denominator taken from a
            # different object is a second authority the reader cannot
            # check against the evidence. Measured on the four committed
            # books, the line-item asset-bucket sum and the class-70 sum
            # equal `assembled_bs.total_assets` / `assembled_pl.revenue`
            # to the cent — so this costs no accuracy and keeps the read
            # inside the import boundary (E-ASSEMBLED-TOTAL).
            industry_signal_block = _build_industry_signal(
                line_items or [],
                industry_key=(org or {}).get("industry_key") if org else None,
                industry_display=(org or {}).get("industry_display_name") if org else None,
            )
        except Exception:  # noqa: BLE001
            logger.exception("[pipeline] industry signal failed for period %s", period.get("id"))

        # ── Is a margin meaningful on this book? ONE rule ───────────────
        # (engine.ratios.margin_meaning, packs/ratios/margin_meaning.yaml).
        # Served on `statements` so every reader of the served statements —
        # the dashboard's KPI cards, the P&L key margins, the ratio bundle,
        # the printed report — asks the same verdict before it prints a
        # margin, and none decides it again. The ratio table below reads the
        # same rule over the same operands. The one note the pack names (a
        # property developer's capitalised 711) rides on the same block.
        # Served ONLY where the rule refuses: every other book's body is the
        # body it always was, byte for byte, and a statements block with no
        # verdict refuses nothing (tests/engine/test_margin_meaning.py).
        # Non-fatal: a failure serves no verdict, which refuses nothing.
        try:
            from engine.ratios import margin_meaning as _margin_meaning

            _margin_block = _margin_meaning.period_block(statements, industry_signal_block)
            if _margin_block.get("status") == _margin_meaning.NOT_MEANINGFUL:
                statements["margin_meaning"] = _margin_block
        except Exception:  # noqa: BLE001
            logger.exception("[/api/period] margin meaning failed for period %s (non-fatal)",
                             period.get("id"))

        # ── The served ratio table + the serve-time credit model ─────────
        # (ratios B4). `build_ratio_table(..., serve_time_metrics=True)`
        # runs the credit model on these statements. The credit envelope
        # AND the credit-family rows of `metrics` are then served from that
        # one serve-time result: every FE credit reader (dashboard hero and
        # Risks tab via computeCreditScore, /report CreditScoreCard, the
        # workbook) takes composite, Altman and sub-scores from the metrics
        # rows first and the letter from the envelope, so switching only the
        # envelope printed a persisted composite beside a letter banded from
        # a different one. The persisted rows move, verbatim, to
        # `credit_metrics_as_filed` — the as-filed evidence, disclosed in
        # `credit.as_filed` only where it differs (a reanalyze never
        # recomputes them). When the serve-time model cannot run on these
        # statements (a source that declares its absences) nothing is
        # switched: the persisted block stays, labelled `basis: as_filed`,
        # beside its own rows. Switched ON by measurement: on the four
        # corpus books and the Scandia FY2025 baseline, once the served
        # balance sheet carries complete equity, no Altman zone and no
        # letter moves against the persisted rows (Scandia baseline
        # composite 71.7 as filed -> 71.9 served: the account-121 anchor
        # the capture predates; letter A both). Non-fatal: a failure keeps
        # the as-filed block above, labelled `basis: as_filed`.
        _persisted_env = period.get("assembled_canonical_v1")
        _persisted_pack_provenance = (
            _persisted_env.get("pack_provenance")
            if isinstance(_persisted_env, dict) and isinstance(_persisted_env.get("pack_provenance"), dict)
            else None
        )
        ratio_table_block = None
        served_metric_rows = list(metrics or [])
        credit_metrics_as_filed = None
        _serve_rows = None
        try:
            from engine.ratios.table import build_ratio_table as _build_ratio_table
            from engine.ratios.table import serve_time_metric_rows as _serve_time_metric_rows

            _serve_rows = _serve_time_metric_rows(statements)

            ratio_table_block = _build_ratio_table({
                "statements": statements,
                "metrics": metrics or [],
                "industry_signal": industry_signal_block,
                "period": {"id": period.get("id"),
                           "methodology_version": period.get("methodology_version")},
                "pack_provenance": _persisted_pack_provenance,
            }, serve_time_metrics=True)
        except Exception:  # noqa: BLE001
            logger.exception("[/api/period] ratio table failed for period %s (non-fatal)", period.get("id"))
        assembled_metrics_envelope["ratio_table"] = ratio_table_block
        if (isinstance(ratio_table_block, dict) and isinstance(ratio_table_block.get("credit"), dict)
                and _serve_rows is not None):
            served_metric_rows, credit_metrics_as_filed = _credit_model.serve_credit_rows(
                metrics or [], _serve_rows)
            assembled_metrics_envelope["credit"] = _credit_model.serve_credit_envelope(
                ratio_table_block["credit"])
            # The typed ratios block was composed from the PERSISTED rows
            # above. A definition-revised row (interest_coverage: EBITDA
            # basis as filed before 2026-09-19, EBIT since) must carry the
            # figure `metrics[]` and `ratio_table` carry — one key, one
            # value, on every surface of this body.
            _served_by_name = {m.get("name"): m.get("value") for m in served_metric_rows}
            for _group in assembled_metrics_envelope["ratios"].values():
                if not isinstance(_group, dict):
                    continue
                for _name in _credit_model.DEFINITION_REVISED_METRICS:
                    if _name in _group:
                        _group[_name] = _served_by_name.get(_name)

        _period_body = {
            # F1.k — canonical_version stamp. v2.0 = the F1 contract
            # extensions (assembled_metrics envelope, ratio expansion,
            # bands, piotroski, F1.a/b/c canonical extras). v2.1 = F1.e
            # (FE source switch on ebitda_margin / net_margin). FE readers
            # can branch on this if v1 / v2 differ; the cache integrity
            # check in _benchmarks.py uses an analogous gate.
            "canonical_version": "v2.1",
            "assembled_metrics": assembled_metrics_envelope,
            # F3.3 — per-upload country-detection + confidence engine.
            # Drives the Confidence Indicator badge on every FE
            # analysis page and the Review Mode trigger (F3.4).
            "confidence": confidence_dict,
            "period": {
                "id": period["id"],
                "period_end": period["period_end"],
                "currency": period["currency"],
                "extraction_confidence": period.get("extraction_confidence"),
                # The stamp `assembled_metrics.ratio_table` carries; served
                # here so a table rebuilt from this body (the comparatives
                # block) stamps the same period the same way.
                "methodology_version": period.get("methodology_version"),
                "source_document": doc and {
                    "id": doc["id"],
                    "filename": doc["original_filename"],
                    "status": doc["status"],
                    # NEW: surfaces "statutory_f30_f10" vs "trial_balance"
                    # so the UI can render the appropriate accuracy /
                    # limitation banner. Existing TB-routed periods still
                    # carry "trial_balance" here — no banner needed.
                    "detected_type": doc.get("detected_type"),
                },
            },
            "organization": org and {
                "id": org["id"],
                "name": org["name"],
                "industry_key": org.get("industry_key"),
                "industry_display_name": org.get("industry_display_name"),
            },
            # What the ACCOUNT MIX says the company does, the evidence for
            # it, and whether that agrees with `organization.industry_key`.
            # `block_sector_content` is the one authority the report reads
            # before rendering anything calibrated by sector.
            "industry_signal": industry_signal_block,
            # The PERSISTED envelope's pack provenance (never the serve-time
            # re-assembly's): what the ratio table stamps, per period.
            "pack_provenance": _persisted_pack_provenance,
            "statements": statements,
            # Per-account line items — drives the reference-format P&L
            # renderer (account codes + per-line drill-down). Each entry
            # carries the RO account code, name, bucket, statement (BS/PL),
            # and amount (positive after sign-correction by the mapping
            # rule). The frontend's buildPLStatement() consumes this list.
            "line_items": [
                {
                    "statement": li.get("statement"),
                    "bucket": li.get("bucket"),
                    "ro_account_code": li.get("ro_account_code"),
                    "ro_account_name": li.get("ro_account_name"),
                    "amount": float(li.get("amount") or 0),
                    "is_derived": bool(li.get("is_derived")),
                }
                for li in (line_items or [])
            ],
            # Credit-family rows are the serve-time model's whenever
            # `assembled_metrics.credit.basis` is "serve" (see above).
            "metrics": [
                {
                    "name": m["name"],
                    "value": m["value"],
                    "unit": m["unit"],
                    "direction": m.get("direction"),
                }
                for m in served_metric_rows
            ],
            # The persisted credit-family rows those replaced, verbatim
            # (null when nothing was replaced): the as-filed evidence.
            "credit_metrics_as_filed": None if credit_metrics_as_filed is None else [
                {
                    "name": m["name"],
                    "value": m["value"],
                    "unit": m["unit"],
                    "direction": m.get("direction"),
                }
                for m in credit_metrics_as_filed
            ],
            "briefing": briefing and {
                "body": briefing["body"],
                "language": briefing.get("language", "en"),
                "model": briefing.get("model"),
                # Which EBITDA definition the prose was written under; the
                # page hides one written under an earlier definition with
                # the note (owner ruling 2026-09-26, design A9).
                "definition": briefing_definition_status(briefing),
            },
            "recommendations": [
                {
                    "id": r["id"],
                    "title": r["title"],
                    "explanation": r.get("explanation"),
                    "urgency": r.get("urgency"),
                    "expected_cash_impact_kron": r.get("expected_cash_impact_kron"),
                    "status": r.get("status"),
                }
                for r in recs
            ],
            "alerts": [
                {
                    "id": a["id"],
                    "alert_key": a["alert_key"],
                    # `rule_key` / `facts_cited` / `industry` are carried on
                    # the `payload` JSONB column at persist time. Surface
                    # them at the top level for the FE's facts-backing
                    # expander.
                    "rule_key": (a.get("payload") or {}).get("rule_key")
                                 if isinstance(a.get("payload"), dict) else None,
                    "facts_cited": (a.get("payload") or {}).get("facts_cited")
                                 if isinstance(a.get("payload"), dict) else None,
                    "industry": (a.get("payload") or {}).get("industry")
                                 if isinstance(a.get("payload"), dict) else None,
                    # Typed placeholders — null on rows written before
                    # 2026-08-30, which is exactly why the FE keeps the
                    # plain-text fallback.
                    "title_template": (a.get("payload") or {}).get("title_template")
                                 if isinstance(a.get("payload"), dict) else None,
                    "body_template": (a.get("payload") or {}).get("body_template")
                                 if isinstance(a.get("payload"), dict) else None,
                    "fact_units": (a.get("payload") or {}).get("fact_units")
                                 if isinstance(a.get("payload"), dict) else None,
                    "source_currency": (a.get("payload") or {}).get("source_currency")
                                 if isinstance(a.get("payload"), dict) else None,
                    "severity": a["severity"],
                    "category": a["category"],
                    "title": a["title"],
                    "body": a.get("body"),
                }
                for a in alerts
            ],
            "valuation": _serialize_valuation(valuation, user_assumptions, statements),
            # F4.6 — list of legacy fields slated for removal at the 2Q
            # deprecation horizon (~Nov 2026 per F3.15 §3e). Consumers
            # should switch to the canonical replacements before sunset.
            "deprecated_fields": _deprecated_fields_for_response(),
        }
        # THE CHOKEPOINT: the credit content of this body is composed (the
        # unswitched period) and read against the pack ranges HERE, as it
        # leaves - whichever branch above produced it.
        return _credit_boundary.enforce_credit_boundary(_period_body, surface="period")

    @router.get("/api/period/{period_id}/comparatives")
    def get_period_comparatives(
        period_id: str,
        prior: str = Query(..., description="The comparison period's id — same workspace"),
        authorization: Optional[str] = Header(None),
        x_org_id: Optional[str] = Header(None, alias="X-Org-Id"),
    ) -> Dict[str, Any]:
        """Two periods of ONE workspace, side by side.

        Both ids are browser-supplied. Each is loaded with the caller's
        organization IN THE FILTER (`_comparatives.load_period_in_org`), so
        a period in another workspace — or in another of the caller's own
        workspaces — is not found. The envelopes are what `get_period`
        serves, read through that very function, so the comparison is over
        exactly what the dashboard renders.
        """
        from . import _comparatives as _cmp

        jwt = _require_jwt(authorization)
        _user_id, org_id = _org.resolve_org(jwt, x_org_id)
        if prior == period_id:
            raise HTTPException(400, {"code": "same_period",
                                      "message": "A period cannot be compared with itself."})
        try:
            with _supabase.per_user(jwt) as client:
                cur_row = _cmp.load_period_in_org(client, period_id, org_id=org_id)
                pri_row = _cmp.load_period_in_org(client, prior, org_id=org_id)
                # The workspace's CAEN, from its ONE authority (ruling Q6):
                # without it the band findings' company profile is inferred
                # from the account mix alone, while the Capsule, Radar and
                # the firm lane all qualify the same company by its code.
                # Fails open to None, as `caen_for_org` documents.
                caen = _org.caen_for_org(client, org_id)
            cur_payload = get_period(period_id, authorization)
            pri_payload = get_period(prior, authorization)
            return _credit_boundary.enforce_credit_boundary(
                _cmp.compare_payloads(
                    cur_payload, pri_payload, current_row=cur_row, prior_row=pri_row,
                    caen=caen),
                surface="comparatives")
        except _cmp.ComparativesRefused as exc:
            raise HTTPException(exc.status, {"code": exc.code, "message": exc.message})

    @router.get("/api/period/{period_id}/sector-benchmark")
    def get_period_sector_benchmark(
        period_id: str,
        authorization: Optional[str] = Header(None),
        x_org_id: Optional[str] = Header(None, alias="X-Org-Id"),
    ) -> Dict[str, Any]:
        """The company beside its sector, from the Ministry of Finance
        annual filings (open data, CC-BY-4.0) — every figure with its
        source, year and n, or a stated refusal.

        Same wall as comparatives: the organization is resolved from the
        VERIFIED bearer + X-Org-Id, the period (and the prior period, found
        one year earlier in the SAME workspace) is loaded with the org IN
        THE FILTER, and the company side is read off what `get_period`
        serves — never a second assembly.
        """
        from . import _comparatives as _cmp
        from . import _sector_benchmark as _sb
        from engine.benchmarks_ro import sector as _sector

        jwt = _require_jwt(authorization)
        _user_id, org_id = _org.resolve_org(jwt, x_org_id)
        try:
            with _supabase.per_user(jwt) as client:
                cur_row = _cmp.load_period_in_org(client, period_id, org_id=org_id)
                prior_id, prior_reason = _sb.find_prior_period(client, cur_row, org_id=org_id)
                caen = _org.caen_for_org(client, org_id)
        except _cmp.ComparativesRefused as exc:
            raise HTTPException(exc.status, {"code": exc.code, "message": exc.message})
        # CAEN: the workspace's own code first (the ONE authority the
        # comparatives, Capsule and Radar read — a workspace is one
        # company); only when it is absent, the per-period industry choice
        # the legacy benchmark report resolves. The document says which.
        caen_source = "workspace" if caen else None
        if not caen:
            try:
                from . import _benchmarks as _bm
                picked, _src, _refusal = _bm._resolve_effective_caen(jwt=jwt, period_id=period_id)
                if picked:
                    caen, caen_source = picked, "period_industry_choice"
            except Exception:  # noqa: BLE001 — a classification is not worth a 500
                logger.exception("[sector-benchmark] period CAEN lookup failed for %s", period_id)
        cur_payload = get_period(period_id, authorization)
        pri_payload = None
        if prior_id is not None:
            try:
                pri_payload = get_period(prior_id, authorization)
            except HTTPException:
                prior_reason = {"code": "prior_period_not_servable", "inputs": [prior_id]}
        doc = _sector.build_sector_benchmark(
            cur_payload, caen=caen, prior_payload=pri_payload, prior_reason=prior_reason)
        doc["caen_source"] = caen_source
        problems = _sector.check_document_law(doc)
        if problems:
            logger.error("[sector-benchmark] unlawful document for %s: %s", period_id, problems[:5])
            raise HTTPException(500, {"code": "sector_benchmark_unlawful",
                                      "message": "a sector figure lacked its source, year or n"})
        return doc

    @router.put("/api/period/{period_id}/valuation-assumptions")
    def save_valuation_assumptions(
        period_id: str,
        body: Dict[str, Any],
        authorization: Optional[str] = Header(None),
    ) -> Dict[str, Any]:
        """Save per-user overrides on the valuation inputs (EBITDA / multiple /
        debt / cash). RLS keys on auth.uid() == user_id so users can only
        manage their own row. POST/PUT both upsert by (user_id, period_id).
        """
        jwt = _require_jwt(authorization)
        # The WRITE wall (FC1x, D4): the period must be visible AND the
        # caller a member of its org — the recompute below re-persists the
        # period's valuations row through the service role.
        _verify_user_may_write_period(jwt, period_id)
        with _supabase.per_user(jwt) as client:
            # The caller's VERIFIED auth.uid() (engine.api._jwt) so user_id
            # is never taken from the body.
            user = client.get_user(jwt)
            user_id = user["id"]

            payload = {
                "user_id": user_id,
                "period_id": period_id,
                "ebitda_used": body.get("ebitda_used"),
                "multiple_used": body.get("multiple_used"),
                "debt_used": body.get("debt_used"),
                "cash_used": body.get("cash_used"),
                "notes": body.get("notes"),
                # The EBITDA definition this override was typed under (owner
                # ruling 2026-09-26: 711 and 72x inside). Stamped by the
                # engine, never taken from the body; a row saved before the
                # stamp existed reads NULL and is served flagged
                # (`_valuation.override_definition_status`). Column added by
                # supabase/schema_phase_valuation_ebitda_definition.sql.
                "ebitda_definition": _valuation.EBITDA_DEFINITION_REVISION,
                "updated_at": _now_iso(),
            }
            client.upsert(
                "user_valuation_assumptions",
                payload,
                on_conflict="user_id,period_id",
            )
        # Recompute and re-persist the valuation row reflecting the user's
        # overrides, so the dashboard can re-read /api/period/:id and see
        # the new numbers without any client-side math.
        try:
            with _supabase.admin() as admin_client:
                periods_admin = admin_client.select(
                    "financial_periods",
                    filters={"id": f"eq.{period_id}"},
                    single=True,
                )
                period = periods_admin[0] if periods_admin else None
                if period:
                    org_rows = admin_client.select(
                        "organizations",
                        filters={"id": f"eq.{period['org_id']}"},
                        single=True,
                    )
                    org = org_rows[0] if org_rows else {}
                    line_items = admin_client.select(
                        "statement_line_items",
                        filters={"period_id": f"eq.{period_id}"},
                    )
                    # The SAME served-rebuild seam GET /api/period and
                    # /valuation/recompute read (canonical assembled_pl /
                    # _bs / _cf). The bucket-only `_rebuild_assembled` carries
                    # no working-capital change, so on that shape every save /
                    # reset persisted a `dcf_fcf_input_absent` refusal over a
                    # period whose GET computes a DCF (the §21 sibling miss).
                    assembled = _rebuild_assembled_for_briefing(line_items, period, org)["statements"]
                    result = _valuation.compute_valuation(
                        industry_key=org.get("industry_key"),
                        statements=assembled,
                        user_assumptions={
                            "ebitda_used": payload["ebitda_used"],
                            "multiple_used": payload["multiple_used"],
                            "debt_used": payload["debt_used"],
                            "cash_used": payload["cash_used"],
                        },
                    )
                    _valuation.persist_valuation(period_id, period["org_id"], result)
        except Exception:  # noqa: BLE001
            logger.exception("[pipeline] valuation recompute failed (non-fatal)")
        return {"ok": True}

    @router.delete("/api/period/{period_id}/valuation-assumptions")
    def reset_valuation_assumptions(
        period_id: str,
        authorization: Optional[str] = Header(None),
    ) -> Dict[str, Any]:
        """Reset to engine defaults: drop the user_valuation_assumptions row
        and re-compute the valuations row from raw statements."""
        jwt = _require_jwt(authorization)
        _verify_user_may_write_period(jwt, period_id)  # the WRITE wall (FC1x, D4)
        with _supabase.per_user(jwt) as client:
            user = client.get_user(jwt)
            user_id = user["id"]
            client.delete(
                "user_valuation_assumptions",
                filters={
                    "user_id": f"eq.{user_id}",
                    "period_id": f"eq.{period_id}",
                },
            )
        try:
            with _supabase.admin() as admin_client:
                periods_admin = admin_client.select(
                    "financial_periods",
                    filters={"id": f"eq.{period_id}"},
                    single=True,
                )
                period = periods_admin[0] if periods_admin else None
                if period:
                    org_rows = admin_client.select(
                        "organizations",
                        filters={"id": f"eq.{period['org_id']}"},
                        single=True,
                    )
                    org = org_rows[0] if org_rows else {}
                    line_items = admin_client.select(
                        "statement_line_items",
                        filters={"period_id": f"eq.{period_id}"},
                    )
                    # The SAME served-rebuild seam GET /api/period and
                    # /valuation/recompute read (canonical assembled_pl /
                    # _bs / _cf). The bucket-only `_rebuild_assembled` carries
                    # no working-capital change, so on that shape every save /
                    # reset persisted a `dcf_fcf_input_absent` refusal over a
                    # period whose GET computes a DCF (the §21 sibling miss).
                    assembled = _rebuild_assembled_for_briefing(line_items, period, org)["statements"]
                    result = _valuation.compute_valuation(
                        industry_key=org.get("industry_key"),
                        statements=assembled,
                    )
                    _valuation.persist_valuation(period_id, period["org_id"], result)
        except Exception:  # noqa: BLE001
            logger.exception("[pipeline] valuation reset recompute failed (non-fatal)")
        return {"ok": True}

    @router.post("/api/period/{period_id}/valuation/recompute")
    def recompute_valuation(
        period_id: str,
        body: Dict[str, Any],
        authorization: Optional[str] = Header(None),
    ) -> Dict[str, Any]:
        """F1.j — Stateless interactive DCF recompute (SPEC §11).

        Accepts the spec'd override body:
          {
            forecast_years?:        number,   // default 5
            forecast_growth?:       number,   // default 0.035
            terminal_growth?:       number,   // default 0.030
            beta?:                  number,   // default 1.0
            equity_risk_premium?:   number,   // default 0.075
            rf?:                    number,   // default 0.0675 (extension)
            property_market_value?: number,   // schema-only, round-tripped
            annual_lease_expense?:  number,   // schema-only, round-tripped
            shares_outstanding?:    number,   // schema-only, round-tripped
          }

        Auth: same JWT + ownership check as GET /api/period/:id. RLS on
        financial_periods scopes the row to the caller's org.

        Response shape: the SAME `assembled_metrics.valuation` envelope
        that GET /api/period/:id emits — so the FE can swap the rendered
        result for the recomputed one with no shape translation.

        Stateless: this endpoint does NOT persist. The
        `user_valuation_assumptions` table is only written by
        PUT /api/period/{id}/valuation-assumptions (the dedicated
        save-overrides endpoint). The recompute endpoint is the
        what-if calculator.
        """
        jwt = _require_jwt(authorization)
        # Whitelist + type-coerce the body so the FE can't sneak unexpected
        # keys into compute_valuation. Anything else is ignored silently.
        ALLOWED_OVERRIDES = {
            "forecast_years",
            "forecast_growth",
            "terminal_growth",
            "beta",
            "equity_risk_premium",
            "rf",
            "property_market_value",
            "annual_lease_expense",
            "shares_outstanding",
        }
        overrides: Dict[str, Any] = {}
        for k in ALLOWED_OVERRIDES:
            v = (body or {}).get(k)
            if v is None:
                continue
            if isinstance(v, bool):
                raise HTTPException(
                    400, f"valuation/recompute: '{k}' must be numeric (got {v!r})."
                )
            try:
                overrides[k] = float(v)
            except (TypeError, ValueError):
                raise HTTPException(
                    400, f"valuation/recompute: '{k}' must be numeric (got {v!r})."
                )
        # OUT-OF-DOMAIN OVERRIDES ARE A 400, never a computation at a
        # substitute: the domains are `_valuation.DCF_OVERRIDE_DOMAINS`
        # (a non-finite value, fewer than one forecast year, a fractional
        # year, a growth rate at or below -100%). `forecast_years` used to be
        # `int()`-truncated here, so 2.5 years silently became 2.
        domain_errors = _valuation.dcf_override_domain_errors(overrides)
        if domain_errors:
            raise HTTPException(400, "valuation/recompute: " + " ".join(domain_errors))
        if "forecast_years" in overrides:
            overrides["forecast_years"] = int(overrides["forecast_years"])

        with _supabase.per_user(jwt) as client:
            periods = client.select(
                "financial_periods",
                filters={"id": f"eq.{period_id}"},
                single=True,
            )
            if not periods:
                raise HTTPException(404, "Period not found.")
            period = periods[0]

        with _supabase.admin() as admin_client:
            org_rows = admin_client.select(
                "organizations",
                filters={"id": f"eq.{period['org_id']}"},
                single=True,
            )
            org = org_rows[0] if org_rows else {}
            line_items = admin_client.select(
                "statement_line_items",
                filters={"period_id": f"eq.{period_id}"},
            )
            # The SAME served-rebuild seam GET /api/period's valuation reads
            # (canonical assembled_pl / _bs / _cf). The bucket-only
            # `_rebuild_assembled` carries no working-capital change, and the
            # DCF no longer reads an absent ΔWC as 0 — on that shape every
            # recompute would refuse, and before this it computed a DCF the
            # GET path never served.
            assembled = _rebuild_assembled_for_briefing(line_items, period, org)["statements"]

            # Layer the user's saved EBITDA/multiple/debt/cash overrides
            # underneath the recompute's DCF overrides — same precedence
            # the GET endpoint uses, so toggling DCF inputs doesn't
            # silently revert the user's persisted EBITDA choice.
            ua_rows = admin_client.select(
                "user_valuation_assumptions",
                filters={"period_id": f"eq.{period_id}"},
            )
            user_assumptions = None
            if ua_rows:
                ua = ua_rows[0]
                user_assumptions = {
                    "ebitda_used":   ua.get("ebitda_used"),
                    "multiple_used": ua.get("multiple_used"),
                    "debt_used":     ua.get("debt_used"),
                    "cash_used":     ua.get("cash_used"),
                    "ebitda_definition": ua.get("ebitda_definition"),
                }

            try:
                result = _valuation.compute_valuation(
                    industry_key=org.get("industry_key"),
                    statements=assembled,
                    user_assumptions=user_assumptions,
                    dcf_overrides=overrides,
                )
            except Exception as exc:  # noqa: BLE001
                logger.exception(
                    "[/api/period/{id}/valuation/recompute] compute failed"
                )
                raise HTTPException(
                    500, f"Valuation recompute failed: {type(exc).__name__}"
                ) from exc

        # The Gordon terminal is undefined when the central WACC does not
        # exceed terminal growth. With the caller's overrides in play that
        # is an out-of-domain request, answered 400 with the engine's own
        # sentence — the old code nudged WACC to g + 0.5% and served an EV
        # (692.6M against 72.2M at defaults, measured) at a rate nobody chose.
        if overrides:
            undefined = [r for r in (result.get("dcf_refusals") or [])
                         if r.get("code") in ("dcf_wacc_not_above_growth",
                                              "dcf_override_out_of_domain")]
            if undefined:
                raise HTTPException(
                    400, "valuation/recompute: " + " ".join(r["text"] for r in undefined))

        return {
            "valuation": result,
            "overrides_applied": result.get("overrides_applied"),
        }

    @router.post("/api/period/{period_id}/briefing/regenerate")
    def regenerate_briefing(
        period_id: str,
        currency: Optional[str] = None,
        language: Optional[str] = None,
        authorization: Optional[str] = Header(None),
    ) -> Dict[str, Any]:
        """F2.8 — Regenerate the LLM CFO Briefing for an existing period
        against the current canonical statements + metrics. Used after the
        F1.e basis decisions (cash vs statutory EBITDA, statutory ct.121
        net profit, Z″ Altman) shifted the canonical numbers — cached
        briefings still cite the pre-F1.e values until regenerated.

        `currency` (optional query param): RON/EUR/USD. When provided,
        every monetary number in `briefing_facts` is FX-converted to that
        currency before the LLM sees them, and the prompt asks the LLM
        to cite the converted currency. Defaults to the period's source
        currency (typically RON). Wired from the FE TopHeader currency
        toggle so the briefing prose follows RON ↔ EUR ↔ USD switches.

        Calls `stage_narrate` against the rebuilt assembled statements +
        the period's `calculated_metrics` rows, then upserts the resulting
        briefing body on the `briefings` table. Recommendations + alerts
        are NOT touched (those have their own deterministic generation
        path via `stage_validate`).
        """
        jwt = _require_jwt(authorization)
        # The WRITE wall (FC1x, D4): visible under RLS AND a member of the
        # period's org — the briefing is upserted through the service role.
        period = _verify_user_may_write_period(jwt, period_id)

        with _supabase.admin() as admin_client:
            org_rows = admin_client.select(
                "organizations",
                filters={"id": f"eq.{period['org_id']}"},
                single=True,
            )
            org = org_rows[0] if org_rows else {}
            line_items = admin_client.select(
                "statement_line_items",
                filters={"period_id": f"eq.{period_id}"},
            )
            metric_rows = admin_client.select(
                "calculated_metrics",
                filters={"period_id": f"eq.{period_id}"},
            )
            # calculated_metrics columns are name/value/unit/direction
            # (NOT metric_name/metric_value — the earlier shape was an F2.8
            # transcription error against the live schema, caught by the
            # post-deploy KeyError on the first regenerate call).
            metrics = [
                {
                    "name": m["name"],
                    "value": m["value"],
                    "unit": m.get("unit"),
                    "direction": m.get("direction"),
                }
                for m in metric_rows
            ]
            valuation_rows = admin_client.select(
                "valuations",
                filters={"period_id": f"eq.{period_id}"},
            )
            valuation = valuation_rows[0] if valuation_rows else None
            doc_rows = admin_client.select(
                "documents",
                filters={"period_id": f"eq.{period_id}"},
            )
            doc = doc_rows[0] if doc_rows else {
                "id": "regenerate",
                "org_id": period["org_id"],
                "language": "en",
            }
            # `language` (optional query param, 2026-08-04): the FE passes
            # the ACTIVE UI language so a user who switched EN↔RO can pull
            # the briefing into the language they're reading the app in —
            # stage_narrate reads doc["detected_language"], so override it
            # here rather than threading a new parameter through.
            if language and language.lower()[:2] in ("en", "ro", "de", "fr", "es", "it", "pt", "nl", "pl"):
                doc = {**doc, "detected_language": language.lower()[:2]}
            # F2.8 fix: stage_narrate reads from `assembled["statements"]
            # .assembled_pl` etc., not the bucket-only shape that
            # `_rebuild_assembled` returns. Use the canonical-shaped
            # rebuilder so the regenerated briefing cites
            # operating-view EBITDA, statutory net income, and the
            # rest of the briefing_facts envelope.
            assembled = _rebuild_assembled_for_briefing(line_items, period, org)

            # FX rates for currency conversion. Skip the fetch when the
            # caller wants the period's native currency (the no-op case).
            display_currency = (currency or "").upper() or None
            fx_payload: Optional[Dict[str, Any]] = None
            if display_currency and display_currency not in ("", "RON"):
                try:
                    from .fx_rates import get_fx_rates as _get_fx_rates
                    fx_payload = _get_fx_rates()
                except Exception:  # noqa: BLE001
                    logger.warning(
                        "[/api/period/{id}/briefing/regenerate] fx_rates fetch failed; "
                        "falling back to source currency"
                    )
            fx_rates_map = (fx_payload or {}).get("rates") if fx_payload else None

            try:
                narrative = stage_narrate(
                    doc, assembled, metrics, org, period_id,
                    parsed=None, valuation=valuation,
                    display_currency=display_currency,
                    fx_rates=fx_rates_map,
                )
            except Exception as exc:  # noqa: BLE001
                logger.exception(
                    "[/api/period/{id}/briefing/regenerate] stage_narrate failed"
                )
                raise HTTPException(
                    500, f"Briefing regeneration failed: {type(exc).__name__}"
                ) from exc

            # Upsert briefing only; do NOT touch recommendations/alerts
            # (deterministic rules own those — regen would create
            # duplicates and disagree with the validation pipeline).
            #
            # Currency-conversion regenerations (display_currency != source)
            # are NOT persisted — the DB row stays the canonical
            # source-currency briefing. If a user toggles RON → EUR, the
            # EUR briefing is returned in the response only; on next
            # session load they'd see RON again until they toggle. This
            # avoids the alternative-currency briefing becoming "sticky"
            # and confusing users who later toggle back.
            should_persist = not display_currency or display_currency.upper() == "RON"
            if should_persist:
                admin_client.upsert(
                    "briefings",
                    {
                        "period_id": period_id,
                        "org_id": period["org_id"],
                        "body": narrative.get("briefing", ""),
                        "language": "en",
                        "model": _narrative_model(),
                        # see stage_persist_narrative (ruling 2026-09-26)
                        "ebitda_definition": _EBITDA_DEFINITION_REVISION,
                    },
                    on_conflict="period_id",
                    returning=False,
                )
                admin_client.update(
                    "financial_periods",
                    {"updated_at": _now_iso()},
                    filters={"id": f"eq.{period_id}"},
                )

        return {
            "ok": True,
            "period_id": period_id,
            "briefing_length": len(narrative.get("briefing", "")),
            "briefing": narrative.get("briefing", ""),
            "currency": display_currency or "RON",
        }

    # ── F3.4 — Review Mode ─────────────────────────────────────────
    # `ReviewReanalyzeRequest` lives at module level (see above);
    # nested-class Pydantic bodies don't resolve correctly through
    # FastAPI's type inspector.

    @router.get("/api/period/{period_id}/review")
    def get_review_state(
        period_id: str,
        authorization: Optional[str] = Header(None),
    ) -> Dict[str, Any]:
        """F3.4 — return the Review Mode state for a period.

        Surfaces:
          - `unmapped_accounts` — accounts the pack's chart-of-
            accounts couldn't bucket. These are what the user
            assigns manually in Review Mode.
          - `org_overrides` — any persisted org-wide overrides
            (`org_coa_mappings_overrides`) that already apply to
            this org's uploads.

        Romanian fixtures should return `unmapped_accounts: []`.
        """
        jwt = _require_jwt(authorization)
        from engine.core import review_mode as _rm
        from engine.core.country_pack_registry import get_pack

        with _supabase.per_user(jwt) as client:
            periods = client.select(
                "financial_periods",
                filters={"id": f"eq.{period_id}"},
                single=True,
            )
            if not periods:
                raise HTTPException(404, "Period not found.")
            period = periods[0]

        with _supabase.admin() as ac:
            line_items = ac.select(
                "statement_line_items",
                filters={"period_id": f"eq.{period_id}"},
            )
            # Load any org-level overrides previously saved.
            try:
                org_overrides_rows = ac.select(
                    "org_coa_mappings_overrides",
                    filters={"org_id": f"eq.{period['org_id']}"},
                )
            except Exception:  # noqa: BLE001
                org_overrides_rows = []

        pack = get_pack("RO")  # F3.7+ will dispatch the active pack
        accounts_for_unmapped = []
        for li in (line_items or []):
            code = (li.get("ro_account_code") or "").strip()
            if not code:
                continue
            accounts_for_unmapped.append({
                "code": code,
                "name": li.get("ro_account_name") or "",
                "amount": float(li.get("amount") or 0),
            })
        unmapped = _rm.collect_unmapped_accounts(pack, accounts_for_unmapped) if pack else []

        return {
            "period_id": period_id,
            "unmapped_accounts": unmapped,
            "org_overrides": [
                {
                    "account_code": r["account_code"],
                    "standardized_bucket": r["standardized_bucket"],
                    "sign": r.get("sign", 1),
                    "coa_key": r.get("coa_key"),
                }
                for r in (org_overrides_rows or [])
            ],
            "review_state_version": "f3.4",
        }

    @router.post("/api/period/{period_id}/review/reanalyze")
    def reanalyze_with_overrides(
        period_id: str,
        payload: ReviewReanalyzeRequest,
        authorization: Optional[str] = Header(None),
    ) -> Dict[str, Any]:
        """F3.4 — Rerun assemble_statements with user-supplied
        overrides applied. Overrides come in the request body
        (transient per-session); when `propose_as_calibration_rules`
        is True they are ALSO upserted to org_coa_mappings_overrides
        for future uploads.

        Returns the post-reanalysis confidence report so the FE can
        show "Review Mode trigger went from True → False" once the
        residuals are within tolerance.
        """
        jwt = _require_jwt(authorization)
        from engine.core import review_mode as _rm
        from engine.core.country_pack_registry import get_pack
        from engine.core.upload_classifier import classify_upload
        from engine.core.confidence_engine import (
            build_confidence_report, confidence_report_to_dict,
        )

        # VERIFY BEFORE READING (FC1x, critic finding I1) — see the note
        # on the sales-dataset handlers: an expired bearer must be a 401
        # from the verifier, not a PostgREST 401 escaping as a 500.
        # `_verified_user_id`, not `_org.`: this handler binds a LOCAL
        # `_org` further down, which would shadow the module here.
        _user_id_from_jwt(jwt)
        with _supabase.per_user(jwt) as client:
            periods = client.select(
                "financial_periods",
                filters={"id": f"eq.{period_id}"},
                single=True,
            )
            if not periods:
                raise HTTPException(404, "Period not found.")
            period = periods[0]
        # The WRITE wall (FC1x, D4): the re-analysis re-persists the
        # period's confidence report and may upsert calibration rules.
        # (`_require_member`, not `_org.`: this handler binds a LOCAL
        # `_org` further down, which would shadow the module here.)
        _require_member(jwt, period.get("org_id"))

        overrides = _rm.ReviewOverrides(
            period_id=period_id,
            account_buckets=payload.account_buckets,
            confirmed_country_code=payload.confirmed_country_code,
            confirmed_standard=payload.confirmed_standard,
            notes=payload.notes,
            propose_as_calibration_rules=payload.propose_as_calibration_rules,
        )

        # Format-learning confirm hook (Part F): a human reviewing and
        # re-analysing a period whose extraction carries a layout
        # template_fingerprint counts as a confirmation of that layout's
        # StructuralMap. Best-effort telemetry for the promotion bar —
        # it must never fail the review request.
        try:
            _env = (period.get("assembled_canonical_v1") or {})
            _ext = ((_env.get("canonical_bs") or {}).get("extraction") or {})
            _fp = _ext.get("template_fingerprint")
            if _fp:
                from engine.interp.templates import TemplateStore
                _who = str(jwt.get("email") or jwt.get("sub") or "").strip()
                _doc_hash = str(
                    ((_env.get("provenance") or {}).get("content_hash"))
                    or ""
                ).strip()
                _org = str(period.get("org_id") or "").strip()
                if _who and _doc_hash and _org:
                    TemplateStore().confirm(
                        str(_fp), confirmed_by=_who,
                        doc_content_hash=_doc_hash, company_key=_org,
                    )
        except Exception:  # noqa: BLE001 — telemetry only
            logger.info("[review/reanalyze] template confirm skipped",
                        exc_info=True)

        with _supabase.admin() as ac:
            line_items = ac.select(
                "statement_line_items",
                filters={"period_id": f"eq.{period_id}"},
            )
            if not line_items:
                raise HTTPException(400, "Period has no line items to reanalyse.")
            org_rows = ac.select(
                "organizations",
                filters={"id": f"eq.{period['org_id']}"},
                single=True,
            )
            org = org_rows[0] if org_rows else {}

            pack_country = overrides.confirmed_country_code or "RO"
            pack = get_pack(pack_country)
            if pack is None:
                raise HTTPException(
                    400,
                    f"No country pack registered for {pack_country!r}.",
                )

            # ── Merge org-level overrides on top of user input ─────
            # This lets users layer a Review session on top of
            # previously-saved org defaults.
            merged_overrides = dict(overrides.account_buckets)
            try:
                org_overrides_rows = ac.select(
                    "org_coa_mappings_overrides",
                    filters={"org_id": f"eq.{period['org_id']}"},
                )
                for r in (org_overrides_rows or []):
                    code = r["account_code"]
                    if code not in merged_overrides:
                        merged_overrides[code] = r["standardized_bucket"]
            except Exception:  # noqa: BLE001
                pass
            merged = _rm.ReviewOverrides(
                period_id=period_id,
                account_buckets=merged_overrides,
                confirmed_country_code=overrides.confirmed_country_code,
                confirmed_standard=overrides.confirmed_standard,
                notes=overrides.notes,
            )
            override_bucket_for = _rm.apply_overrides(pack, merged)

            recovered_accounts: List[Dict[str, Any]] = []
            for li in line_items:
                code = (li.get("ro_account_code") or "").strip()
                if not code:
                    continue
                stored_bucket = li.get("bucket") or ""
                rule = override_bucket_for(code)
                bucket_override = None
                if rule and stored_bucket and stored_bucket != rule.bucket:
                    legacy = pack.persistence_bucket(rule.bucket)
                    if stored_bucket != legacy:
                        bucket_override = stored_bucket
                row = {
                    "code": code,
                    "name": li.get("ro_account_name") or "",
                    "amount": float(li.get("amount") or 0),
                }
                if bucket_override:
                    row["bucket_override"] = bucket_override
                recovered_accounts.append(row)
            for acct in recovered_accounts:
                rule = override_bucket_for(acct["code"])
                if rule and rule.sign == -1:
                    acct["amount"] = -acct["amount"]

            # Account 121 anchor — see `_assemble_with_statutory_anchor`.
            # Review overrides re-bucket ACCOUNTS; they never re-open the
            # statutory result, so the anchor still governs here. The
            # kwarg is probed rather than passed blind because `pack` is
            # `get_pack(confirmed_country_code)` and a non-RO pack has no
            # such parameter (see `_anchor_kwargs`).
            original_bucket_for = pack.bucket_for
            pack.bucket_for = override_bucket_for  # type: ignore[assignment]
            try:
                assembled_full = _assemble_with_statutory_anchor(
                    pack.assemble_statements,
                    recovered_accounts,
                    period_row=period,
                    line_items=line_items,
                    company_name=org.get("name") or "Entity",
                    currency=period.get("currency", "RON"),
                    period_label=str(period.get("period_end")) or "Period",
                    industry=(org or {}).get("industry_key"),
                )
            finally:
                pack.bucket_for = original_bucket_for  # type: ignore[assignment]

            synth = "\n".join(
                f"{a['code']} {a.get('name', '')}" for a in recovered_accounts[:200]
            )
            synth += f"\nMoneda: {period.get('currency', 'RON')}\n"
            synth_bytes = synth.encode("utf-8", errors="ignore")
            fn_hint = period.get("period_end") or ""
            classification = classify_upload(synth_bytes, fn_hint)
            report = build_confidence_report(classification, assembled_full)
            confidence_dict = confidence_report_to_dict(report)
            # F4.4-int — run fan-out routing + rebuild detection envelope
            # with full classification + routing_decision (mirrors site A).
            try:
                from engine.routing import route_with_fan_out as _route, routing_decision_dict as _rdd
                from engine.detection import build_detection_envelope as _bde2
                _routing_result = _route(
                    classification, synth_bytes, fn_hint,
                    company_name=org.get("name") or "Entity",
                    currency=period.get("currency", "RON"),
                    period_label=str(period.get("period_end")) or "Period",
                    industry=(org or {}).get("industry_key"),
                )
                # Reanalyze path doesn't populate `statements` the same way;
                # attach routing_decision to the response payload below.
                confidence_dict = confidence_dict or {}
                confidence_dict["routing_decision"] = _rdd(_routing_result)
            except Exception:  # noqa: BLE001
                logger.exception("[/api/period reanalyze] fan-out routing integration failed (non-fatal)")

            # ── F3.5 hand-off: propose as calibration rules ────────
            # Insert into `calibration_rules` with status='pending'.
            # Admin approves via /api/admin/calibration/rules/{id}/
            # approve, which copies to org_coa_mappings_overrides
            # (the engine's actual read source).
            calibration_rules_proposed = 0
            if payload.propose_as_calibration_rules and overrides.account_buckets:
                rows_to_insert: List[Dict[str, Any]] = []
                for code, bucket in overrides.account_buckets.items():
                    rows_to_insert.append({
                        "org_id": period["org_id"],
                        "coa_key": "omfp_1802",  # F3.7+ will reflect pack
                        "account_code": code,
                        "standardized_bucket": bucket,
                        "sign": 1,
                        "source": "review_mode",
                        "status": "pending",
                        "period_id": period_id,
                        "notes": overrides.notes,
                    })
                try:
                    ac.insert(
                        "calibration_rules",
                        rows_to_insert,
                        returning=False,
                    )
                    calibration_rules_proposed = len(rows_to_insert)
                except Exception:  # noqa: BLE001
                    logger.warning(
                        "[review/reanalyze] proposing to calibration_rules "
                        "failed (table may not be migrated yet): %s",
                        rows_to_insert[0] if rows_to_insert else None,
                    )

        return {
            "ok": True,
            "period_id": period_id,
            "overrides_applied": len(overrides.account_buckets),
            "merged_overrides_applied": len(merged_overrides),
            "calibration_rules_proposed": calibration_rules_proposed,
            "post_reanalysis_confidence": confidence_dict,
        }

    # ── F3.5 / F3.6 — Calibration store + admin dashboard ──────────

    def _require_engine_admin(authorization: Optional[str]) -> None:
        """Gate admin endpoints behind the ENGINE_API_TOKEN.
        Mirrors the pattern used by billing's cron endpoints — admin
        endpoints are scheduler/operator-only, never user-callable.
        """
        token = os.environ.get("ENGINE_API_TOKEN")
        if not token:
            # No token configured → no admin endpoints accessible.
            raise HTTPException(503, "Admin endpoints disabled (ENGINE_API_TOKEN unset).")
        provided = _require_jwt(authorization)
        if provided != token:
            raise HTTPException(401, "Invalid admin token.")

    @router.get("/api/admin/calibration/coverage")
    def admin_calibration_coverage(
        authorization: Optional[str] = Header(None),
    ) -> Dict[str, Any]:
        """F3.6 — Coverage matrix for the admin dashboard.

        Returns, per country pack:
          - calibration_tier (from the pack's metadata)
          - fixture count (from `calibration_fixtures`)
          - pending-rule count (from `calibration_rules` where
            status='pending')
          - last F-A3.1 verdict (from `calibration_results`)
        """
        _require_engine_admin(authorization)
        from engine.core.country_pack_registry import all_packs

        rows: List[Dict[str, Any]] = []
        with _supabase.admin() as ac:
            # Per-pack counts — tolerate missing tables.
            for pack in all_packs():
                fixture_count = 0
                pending_count = 0
                approved_count = 0
                latest_result: Optional[Dict[str, Any]] = None
                try:
                    fixtures = ac.select(
                        "calibration_fixtures",
                        filters={"country_code": f"eq.{pack.country_code}"},
                    )
                    fixture_count = len(fixtures or [])
                except Exception:  # noqa: BLE001
                    pass
                try:
                    pending = ac.select(
                        "calibration_rules",
                        filters={"coa_key": f"eq.omfp_1802", "status": "eq.pending"},
                    )
                    pending_count = len(pending or [])
                    approved = ac.select(
                        "calibration_rules",
                        filters={"coa_key": f"eq.omfp_1802", "status": "eq.approved"},
                    )
                    approved_count = len(approved or [])
                except Exception:  # noqa: BLE001
                    pass
                rows.append({
                    "country_code": pack.country_code,
                    "country_name": pack.country_name,
                    "accounting_standard": pack.accounting_standard,
                    "pack_version": pack.pack_version,
                    "calibration_tier": pack.calibration_tier.value,
                    "fixture_count": fixture_count,
                    "pending_rule_count": pending_count,
                    "approved_rule_count": approved_count,
                    "regression_fixtures_declared": list(pack.regression_fixtures),
                })
        return {
            "packs": rows,
            "summary": {
                "total_packs": len(rows),
                "deeply_calibrated": sum(1 for r in rows if r["calibration_tier"] == "deeply_calibrated"),
                "partially_calibrated": sum(1 for r in rows if r["calibration_tier"] == "partially_calibrated"),
                "experimental": sum(1 for r in rows if r["calibration_tier"] == "experimental"),
            },
        }

    @router.get("/api/admin/calibration/rules")
    def admin_list_calibration_rules(
        status: Optional[str] = None,
        coa_key: Optional[str] = None,
        authorization: Optional[str] = Header(None),
    ) -> Dict[str, Any]:
        """F3.6 — List calibration rules. Supports `status` filter
        (pending / approved / rejected) and `coa_key` filter.
        """
        _require_engine_admin(authorization)
        filters: Dict[str, str] = {}
        if status:
            filters["status"] = f"eq.{status}"
        if coa_key:
            filters["coa_key"] = f"eq.{coa_key}"
        try:
            with _supabase.admin() as ac:
                rows = ac.select(
                    "calibration_rules",
                    filters=filters,
                    order="created_at.desc",
                )
        except Exception as e:  # noqa: BLE001
            logger.warning("[admin/calibration/rules] table miss: %s", e)
            return {"rules": [], "error": "calibration_rules table not migrated yet"}
        return {"rules": rows or []}

    @router.post("/api/admin/calibration/rules/{rule_id}/approve")
    def admin_approve_calibration_rule(
        rule_id: str,
        authorization: Optional[str] = Header(None),
    ) -> Dict[str, Any]:
        """F3.6 — Approve a pending calibration rule. Side effects:
          1. Mark `calibration_rules.status='approved'`.
          2. Upsert the rule into `org_coa_mappings_overrides` so the
             engine picks it up on future uploads.
        """
        _require_engine_admin(authorization)
        try:
            with _supabase.admin() as ac:
                rows = ac.select(
                    "calibration_rules",
                    filters={"id": f"eq.{rule_id}"},
                    single=True,
                )
                if not rows:
                    raise HTTPException(404, f"Calibration rule {rule_id} not found.")
                rule = rows[0]
                if rule["status"] != "pending":
                    raise HTTPException(
                        400,
                        f"Rule status is {rule['status']!r}; only pending rules can be approved.",
                    )
                # Mark approved.
                ac.update(
                    "calibration_rules",
                    {
                        "status": "approved",
                        "approved_at": _now_iso(),
                        "updated_at": _now_iso(),
                    },
                    filters={"id": f"eq.{rule_id}"},
                )
                # Apply to org_coa_mappings_overrides — this is what
                # the engine actually reads.
                if rule.get("org_id"):
                    ac.upsert(
                        "org_coa_mappings_overrides",
                        {
                            "org_id": rule["org_id"],
                            "coa_key": rule["coa_key"],
                            "account_code": rule["account_code"],
                            "standardized_bucket": rule["standardized_bucket"],
                            "sign": rule.get("sign", 1),
                        },
                        on_conflict="org_id,coa_key,account_code",
                        returning=False,
                    )
                return {
                    "ok": True,
                    "rule_id": rule_id,
                    "applied_to_org": rule.get("org_id"),
                    "account_code": rule["account_code"],
                    "standardized_bucket": rule["standardized_bucket"],
                }
        except HTTPException:
            raise
        except Exception as e:  # noqa: BLE001
            logger.exception("[admin/calibration/rules/approve] failed")
            raise HTTPException(500, f"Approval failed: {type(e).__name__}")

    @router.post("/api/admin/calibration/rules/{rule_id}/reject")
    def admin_reject_calibration_rule(
        rule_id: str,
        reason: Optional[str] = None,
        authorization: Optional[str] = Header(None),
    ) -> Dict[str, Any]:
        """F3.6 — Reject a pending calibration rule."""
        _require_engine_admin(authorization)
        try:
            with _supabase.admin() as ac:
                ac.update(
                    "calibration_rules",
                    {
                        "status": "rejected",
                        "rejection_reason": reason or "",
                        "updated_at": _now_iso(),
                    },
                    filters={"id": f"eq.{rule_id}", "status": "eq.pending"},
                )
        except Exception as e:  # noqa: BLE001
            logger.exception("[admin/calibration/rules/reject] failed")
            raise HTTPException(500, f"Rejection failed: {type(e).__name__}")
        return {"ok": True, "rule_id": rule_id, "status": "rejected"}

    @router.get("/api/admin/calibration/fixtures")
    def admin_list_fixtures(
        country_code: Optional[str] = None,
        authorization: Optional[str] = Header(None),
    ) -> Dict[str, Any]:
        """F3.6 — List calibration fixtures. Optional country_code
        filter (e.g. 'RO' → only Romanian fixtures)."""
        _require_engine_admin(authorization)
        filters: Dict[str, str] = {}
        if country_code:
            filters["country_code"] = f"eq.{country_code}"
        try:
            with _supabase.admin() as ac:
                rows = ac.select(
                    "calibration_fixtures",
                    filters=filters,
                    order="created_at.desc",
                )
        except Exception as e:  # noqa: BLE001
            logger.warning("[admin/calibration/fixtures] table miss: %s", e)
            return {"fixtures": [], "error": "calibration_fixtures table not migrated yet"}
        return {"fixtures": rows or []}

    @router.delete("/api/period/{period_id}")
    def delete_period(
        period_id: str,
        authorization: Optional[str] = Header(None),
    ) -> Dict[str, Any]:
        """Hard-delete a period and ALL of its derivatives + soft-delete the
        attached documents. Surfaced behind the "Reset (clear period)" item
        in the Replace dropdown so the user can recover the dashboard back
        to an empty state without leaving stale rows behind.

        The actual deletion happens through the admin client (service role)
        so RLS doesn't get in the way; ownership is verified via the
        per-user client first.
        """
        jwt = _require_jwt(authorization)
        # 1. Ownership check via the user's own RLS scope.
        # VERIFY BEFORE READING (FC1x, critic finding I1) — see the note
        # on the sales-dataset handlers: an expired bearer must be a 401
        # from the verifier, not a PostgREST 401 escaping as a 500.
        _org.verified_user_id(jwt)
        with _supabase.per_user(jwt) as user_client:
            visible = user_client.select(
                "financial_periods",
                filters={"id": f"eq.{period_id}"},
                single=True,
            )
            if not visible:
                raise HTTPException(404, "Period not found or not visible to you.")
            org_id = visible[0]["org_id"]
        # 1b. THE WRITE WALL (FC1x, critic D4): visibility is the READ wall.
        # A firm viewer with a read cell and no membership hard-deleted a
        # client's period through this route (crit_pipeline_census.py).
        # A memberships row in the period's org, or 403 — never firm
        # visibility.
        _org.require_org_member(jwt, org_id)

        # 2. Soft-delete every document attached to the period — keeps the
        # underlying Storage blob recoverable from "Recently deleted" for 30
        # days. (The cleanup-cron handles the hard-delete after that.)
        with _supabase.admin() as ac:
            # 1c. Never in an archived workspace (2026-09-26): nothing in it
            # is shown, and a HELD archive (the workspace migration's) keeps
            # the periods and originals its rollback needs. Restore the
            # workspace first, then clear.
            if _workspace_is_archived(ac, org_id):
                raise HTTPException(
                    409, "This period's workspace is archived; restore the workspace before "
                         "clearing a period in it.")
            attached = ac.select(
                "documents",
                filters={"period_id": f"eq.{period_id}"},
                columns="id",
            )
            now = _now_iso()
            for d in attached:
                ac.update(
                    "documents",
                    {"deleted_at": now, "period_id": None},
                    filters={"id": f"eq.{d['id']}"},
                )

            # 3. Hard-delete period derivatives. Order matters where foreign
            # keys exist; explicit per-table is safer than relying on cascade.
            # `alerts` is scoped by document_id (not period_id) — we handle
            # it separately via the document soft-delete loop above which
            # leaves alert rows intact under the soft-deleted document.
            for table in (
                "statement_line_items",
                "calculated_metrics",
                "briefings",
                "valuations",
                "user_valuation_assumptions",
            ):
                try:
                    ac.delete(table, filters={"period_id": f"eq.{period_id}"})
                except Exception:  # noqa: BLE001
                    logger.exception("[delete_period] cascade delete failed on %s", table)
            # Recommendations are org-scoped (not period-scoped) but the period
            # they were generated for is gone; safest to leave them — re-running
            # a future upload will overwrite. (Don't accidentally wipe other
            # periods' recommendations.)
            # org_id is re-stated here although the period was already
            # authorized above (per-user select + require_org_member): a
            # service-role delete of a period always names its tenant, so the
            # rule holds by inspection at every site rather than by tracing
            # each one back to its wall.
            ac.delete("financial_periods",
                      filters={"id": f"eq.{period_id}", "org_id": f"eq.{org_id}"})

        return {
            "ok": True,
            "period_id": period_id,
            "documents_soft_deleted": len(attached),
        }

    return router
