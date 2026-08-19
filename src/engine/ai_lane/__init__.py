"""AI extraction lane — HU / OTHER jurisdictions (non-RO documents).

Pipeline: jurisdiction resolver (deterministic, engine.ai_lane.
jurisdiction_resolver) → format_detect → extract → classify →
self-check → canonical envelope, replacing the freeform LLM fallback
FOR NON-RO JURISDICTIONS ONLY. The RO deterministic lane (and the RO
freeform fallback for unparseable RO docs) is untouched.

Contract highlights (operator spec):
  · Output flows through the SAME builder the deterministic lane uses —
    `build_canonical_bs_v2` — with extraction.method "llm",
    source_format "llm_hu" | "llm_intl" (additive vocabulary) and a
    classification meta block {method: "llm", prompt_version, model}.
    An LLM extraction's status can NEVER be BALANCED (builder cap).
  · classify confidence < 0.85 → the account joins `needs_review` AND
    its balance rides the Unclassified rows (closing-identity machinery
    — value never dropped) with reason "low_confidence_llm".
  · self-check: Σdebit vs Σcredit of extracted rows AND vs the
    document's own totals row when one was found — deltas land in
    `source_anchor` (anchor_status DIVERGED on mismatch). Figures are
    NEVER auto-altered.
  · Full audit: raw model responses + prompt versions + model id under
    envelope key `ai_audit` (appended per stage/attempt).
  · Cache: the persisted envelope IS the cache, keyed by content_hash +
    the prompt versions recorded on it. Same hash + versions → zero
    model calls on re-run, unless a force_reextract flag is set (doc
    key, or the envelope marker written by
    POST /api/period/{id}/reextract).
  · Failures raise AiLaneError → documents.status 'failed' with a clear
    message. Never fabricated numbers, never partial persists.

This package NEVER imports engine.api at module level (importing
engine.api boots the whole FastAPI app); Supabase access is injected by
the pipeline via `admin_factory`.
"""
from __future__ import annotations

import hashlib
import logging
from typing import Any, Callable, Dict, List, Optional, Tuple

from engine.canonical import BucketType

from . import classify as _classify_mod
from . import config
from . import extract as _extract_mod
from . import format_detect as _format_mod
from . import jurisdiction_resolver
from .schemas import (
    AiLaneError,
    ClassifiedAccount,
    ClassifyResult,
    ExtractedRow,
    ExtractResult,
    FormatDetectResult,
)

logger = logging.getLogger("engine.api")

# Confidence gate: below this, the account is needs_review + Unclassified.
NEEDS_REVIEW_CONFIDENCE = 0.85

# Marker `parsed["detected_type"]` the pipeline orchestrator routes on
# (mirrors the public_records_summary marker pattern).
AI_LANE_DETECTED_TYPE = "ai_lane_statement"

# Envelope flag set by POST /api/period/{id}/reextract; honored (and
# naturally cleared — stage_persist replaces the whole envelope) by the
# next scan.
FORCE_REEXTRACT_ENVELOPE_KEY = "ai_lane_force_reextract"

# Anchor tolerance (currency units) — parity with the deterministic
# builder's extracted-SF balance convention (≤ 1.0).
_ANCHOR_TOLERANCE = 1.0

__all__ = [
    "AiLaneError",
    "AI_LANE_DETECTED_TYPE",
    "FORCE_REEXTRACT_ENVELOPE_KEY",
    "NEEDS_REVIEW_CONFIDENCE",
    "resolve_jurisdiction",
    "run_ai_lane",
    "build_source_anchor",
    "build_ai_envelope",
]


def resolve_jurisdiction(
    doc: Optional[Dict[str, Any]],
    file_bytes: bytes,
    user_choice: Optional[str] = None,
) -> Dict[str, Any]:
    """Deterministic resolver entry point for the pipeline. CONTRACT:
    the explicit user choice is `documents.jurisdiction_hint` when that
    column exists on the doc row (else the same key injected into the
    doc dict); `user_choice` overrides both."""
    doc = doc or {}
    choice = user_choice if user_choice is not None else doc.get("jurisdiction_hint")
    return jurisdiction_resolver.resolve(doc, file_bytes, choice)


def _c(value: Any) -> int:
    """Currency value → integer cents (the lane accumulates in cents,
    floats only at serialization — same discipline as the builder)."""
    try:
        return int(round(float(value or 0.0) * 100))
    except (TypeError, ValueError):
        return 0


def build_source_anchor(
    extract_result: ExtractResult,
    fmt: FormatDetectResult,
) -> Dict[str, Any]:
    """Self-check stage. Σdebit / Σcredit over the EXTRACTED rows, and —
    when the document carries its own totals row — the deltas against
    those FILE values. DIVERGED on any per-side delta beyond 1 currency
    unit; the figures themselves are never altered."""
    extracted_debit_c = 0
    extracted_credit_c = 0
    for row in extract_result.rows:
        if row.debit is not None or row.credit is not None:
            extracted_debit_c += _c(row.debit)
            extracted_credit_c += _c(row.credit)
        else:
            signed = _c(row.balance)
            if signed >= 0:
                extracted_debit_c += signed
            else:
                extracted_credit_c += -signed

    file_debit = extract_result.totals_debit
    file_credit = extract_result.totals_credit
    have_file_totals = file_debit is not None or file_credit is not None
    totals_row_found = bool(have_file_totals or fmt.totals_row_index is not None)

    pair: Dict[str, Any] = {
        "file_debit": file_debit,
        "file_credit": file_credit,
        "extracted_debit": extracted_debit_c / 100.0,
        "extracted_credit": extracted_credit_c / 100.0,
        "delta_debit": None,
        "delta_credit": None,
    }
    anchor_status = "NO_ANCHOR"
    source_balanced: Optional[bool] = None
    if have_file_totals:
        delta_d = (extracted_debit_c - _c(file_debit)) / 100.0
        delta_c = (extracted_credit_c - _c(file_credit)) / 100.0
        pair["delta_debit"] = delta_d
        pair["delta_credit"] = delta_c
        diverged = (
            abs(delta_d) > _ANCHOR_TOLERANCE or abs(delta_c) > _ANCHOR_TOLERANCE
        )
        anchor_status = "DIVERGED" if diverged else "MATCHED"
        source_balanced = abs(_c(file_debit) - _c(file_credit)) <= int(_ANCHOR_TOLERANCE * 100)

    return {
        "totals_row_found": totals_row_found,
        "pairs": {"sf": pair},
        "anchor_status": anchor_status,
        "source_balanced": source_balanced,
    }


def _number_locale(fmt: FormatDetectResult) -> str:
    """Closest contract locale for the detected separators (the raw
    separators are recorded alongside): comma decimal → "ro"-family,
    dot decimal → "anglo"."""
    return "ro" if (fmt.decimal_sep or ",") == "," else "anglo"


def build_ai_envelope(
    *,
    rows: List[ExtractedRow],
    classify_result: ClassifyResult,
    fmt: FormatDetectResult,
    source_anchor: Dict[str, Any],
    jurisdiction: str,
    resolution: Optional[Dict[str, Any]] = None,
) -> Tuple[Dict[str, Any], List[Dict[str, Any]], List[Dict[str, Any]]]:
    """Assemble the canonical envelope THROUGH build_canonical_bs_v2.

    Returns (envelope, line_items, needs_review). Placement rules:
      · BS-classified accounts (confidence ≥ 0.85) accumulate their
        natural-signed closing balance into the canonical leaf
        (asset leaves debit-positive; equity/liability credit-positive)
        — the builder renders leaves as rows/sections/totals.
      · P&L-classified accounts net into the current-year result leaf
        (credit − debit), the builder's documented reconstruction basis
        for LLM extractions (invariants.result_basis "reconstruction").
      · `excluded_control` → the excluded transparency list.
      · confidence < 0.85 / unknown line_id → needs_review + the
        builder's Unclassified rows (reason "low_confidence_llm").
        Builder caveat inherited from RO class semantics: 6/7-prefixed
        codes are marked "absorbed_in_result" — the lane makes that TRUE
        by netting them into the result leaf; 9-prefixed codes are
        listed as off-balance (value excluded, honestly flagged).
    Traceability of per-account assignments lives in the classification
    meta + needs_review (line_items are NOT passed to the builder — its
    line-item router is RO-prefix based and must not guess HU codes).
    """
    # Zero-risk import per the ownership rules: the RO adapter module is
    # only read, never modified. This is THE one canonical_bs builder.
    from engine.country_packs.ro_romania.canonical_adapter import (
        build_canonical_bs_v2,
    )

    vocab = _classify_mod.vocabulary()
    assignments = classify_result.assignments

    leaves_cents: Dict[str, int] = {}
    pl_net_cents = 0
    line_items: List[Dict[str, Any]] = []
    needs_review: List[Dict[str, Any]] = []
    unmapped_for_builder: List[Dict[str, Any]] = []
    excluded_for_builder: List[Dict[str, Any]] = []

    for row in rows:
        signed_c = _c(row.debit_signed())
        a: Optional[ClassifiedAccount] = assignments.get(row.code)
        bucket = vocab.get(a.line_id) if a is not None else None

        if a is not None and a.line_id == _classify_mod.EXCLUDED_CONTROL:
            excluded_for_builder.append({
                "code": row.code,
                "name": row.label,
                "reason": "control_account_llm",
            })
            continue

        confident = (
            a is not None
            and bucket is not None
            and a.confidence >= NEEDS_REVIEW_CONFIDENCE
        )
        if confident:
            btype = bucket.bucket_type
            if btype == BucketType.ASSET:
                natural_c = signed_c
            elif btype in (BucketType.LIABILITY, BucketType.EQUITY):
                natural_c = -signed_c
            elif btype in (BucketType.REVENUE, BucketType.EXPENSE):
                # P&L: net into the current-year result (credit − debit).
                pl_net_cents += -signed_c
                line_items.append({
                    "statement": "PL",
                    "bucket": a.line_id,
                    "canonical_bucket": a.line_id,
                    "ro_account_code": row.code,
                    "ro_account_name": row.label,
                    "amount": (-signed_c if btype == BucketType.REVENUE else signed_c) / 100.0,
                    "is_derived": False,
                })
                continue
            else:
                # MEMO / OCI / CF leaf picked by the model — no BS
                # placement exists; route to review so the value stays
                # visible instead of silently vanishing.
                confident = False
            if confident:
                leaves_cents[a.line_id] = leaves_cents.get(a.line_id, 0) + natural_c
                line_items.append({
                    "statement": "BS",
                    "bucket": a.line_id,
                    "canonical_bucket": a.line_id,
                    "ro_account_code": row.code,
                    "ro_account_name": row.label,
                    "amount": natural_c / 100.0,
                    "is_derived": False,
                })
                continue

        # needs_review path — value rides the Unclassified rows. Field
        # names follow the FE's CanonicalBsNeedsReviewEntry contract
        # (code/name aliases, signed amount, section of the Unclassified
        # row the value landed in).
        needs_review.append({
            "code": row.code,
            "name": row.label,
            "line_id": (a.line_id if a is not None else None),
            "amount": signed_c / 100.0,
            "section": ("current_assets" if signed_c >= 0 else "current_liabilities"),
            "confidence": (a.confidence if a is not None else 0.0),
            "rationale": (a.rationale if a is not None else "no assignment returned"),
            "reason": "low_confidence_llm",
        })
        unmapped_for_builder.append({
            "code": row.code,
            "name": row.label,
            "amount": signed_c / 100.0,
            "reason": "low_confidence_llm",
        })
        # Builder marks 6/7-prefixed unmapped as absorbed-in-result (RO
        # class semantics) — make the claim true by actually netting the
        # balance into the result reconstruction.
        if row.code[:1] in ("6", "7"):
            pl_net_cents += -signed_c

    # Current-year result leaf — the builder's reconstruction fallback
    # reads current_year_profit/current_year_loss ras_line_items_sum_signed.
    if pl_net_cents != 0:
        result_leaf = "current_year_profit" if pl_net_cents > 0 else "current_year_loss"
        leaves_cents[result_leaf] = leaves_cents.get(result_leaf, 0) + pl_net_cents

    envelope_leaves = {
        name: {"ras_line_items_sum_signed": cents / 100.0}
        for name, cents in leaves_cents.items()
    }
    envelope: Dict[str, Any] = {
        "schema_version": _schema_version(),
        "leaves": envelope_leaves,
        "aggregates": {},
        "unmapped": [dict(u) for u in unmapped_for_builder],
        "source_data_quality": None,
        "round_trip_check": {
            "passed": True,
            "note": "ai_lane llm extraction — canonical_bs is the authority",
        },
    }

    source_format = "llm_hu" if jurisdiction == "HU" else "llm_intl"
    extraction_meta: Dict[str, Any] = {
        "method": "llm",
        "parser_version": config.AI_LANE_PARSER_VERSION,
        "source_format": source_format,
        # Singular prompt_version = the extract stage's (the FE AI-read
        # badge reads it); the full per-stage map rides prompt_versions.
        "prompt_version": config.EXTRACT_PROMPT_VERSION,
        "number_locale": _number_locale(fmt),
        "separators": {
            "thousands_sep": fmt.thousands_sep,
            "decimal_sep": fmt.decimal_sep,
        },
        "scale": fmt.scale,
        "language": fmt.language,
        "model": config.MODEL_ID,
        "prompt_versions": config.prompt_versions(),
    }

    canonical_bs = build_canonical_bs_v2(
        envelope,
        line_items=None,           # RO-prefix router must not touch non-RO codes
        source_anchor=source_anchor,
        unmapped=unmapped_for_builder,
        excluded=excluded_for_builder,
        extraction=extraction_meta,
        source_account_census=None,  # not falsifiable without RO line-item routing
    )
    # Belt on the contract cap (the builder already enforces it).
    if canonical_bs.get("status") == "BALANCED":
        canonical_bs["status"] = "MINOR_DRIFT"
    canonical_bs["classification"] = {
        "method": "llm",
        "prompt_version": config.CLASSIFY_PROMPT_VERSION,
        "model": config.MODEL_ID,
        "needs_review": needs_review,
    }
    # Resolved jurisdiction — the FE badge's structured shape. Wire codes
    # follow the FE vocabulary ("HU" | "INTL"); "hint" when the user chose
    # it explicitly (upload dropdown / reextract override), else "auto".
    canonical_bs["jurisdiction"] = {
        "resolved": "HU" if jurisdiction == "HU" else "INTL",
        "source": (
            "hint" if str((resolution or {}).get("source") or "") == "user" else "auto"
        ),
        "pack_version": config.AI_LANE_PARSER_VERSION,
    }
    # Persisted per-account review list on the object itself. NOTE: the
    # serve path (_reconcile.served_canonical_bs) overwrites the SERVED
    # copy's `needs_review` with its reconciliation boolean — the list
    # stays reachable on the served object via classification.needs_review.
    canonical_bs["needs_review"] = needs_review

    envelope["canonical_bs"] = canonical_bs
    envelope["needs_review"] = needs_review
    return envelope, line_items, needs_review


def _schema_version() -> str:
    from engine.canonical import schema_version
    return schema_version()


def content_hash_of(file_bytes: bytes) -> str:
    return hashlib.sha256(file_bytes or b"").hexdigest()


def _cache_lookup(
    doc: Dict[str, Any],
    content_hash: str,
    admin_factory: Optional[Callable[[], Any]],
) -> Optional[Dict[str, Any]]:
    """The persisted envelope IS the cache. Returns a cached parsed
    payload when this document's period already carries an envelope
    whose ai_audit records the SAME content_hash + prompt versions +
    model, and no force_reextract flag is set. Never raises."""
    if admin_factory is None:
        return None
    if doc.get("force_reextract"):
        logger.info("[ai_lane] cache bypassed: doc force_reextract flag set")
        return None
    try:
        with admin_factory() as admin_client:
            try:
                rows = admin_client.select(
                    "financial_periods",
                    filters={
                        "org_id": "eq.%s" % doc.get("org_id"),
                        "source_document_id": "eq.%s" % doc.get("id"),
                    },
                    order="updated_at.desc",
                )
            except TypeError:  # fakes without `order`
                rows = admin_client.select(
                    "financial_periods",
                    filters={
                        "org_id": "eq.%s" % doc.get("org_id"),
                        "source_document_id": "eq.%s" % doc.get("id"),
                    },
                )
    except Exception:  # noqa: BLE001 — cache is best-effort, extraction must proceed
        logger.exception("[ai_lane] cache lookup failed (non-fatal) — re-extracting")
        return None
    for row in rows or []:
        envelope = row.get("assembled_canonical_v1")
        if not isinstance(envelope, dict):
            continue
        if envelope.get(FORCE_REEXTRACT_ENVELOPE_KEY):
            logger.info(
                "[ai_lane] cache bypassed: %s set on period %s envelope",
                FORCE_REEXTRACT_ENVELOPE_KEY, row.get("id"),
            )
            return None
        audit = envelope.get("ai_audit")
        if not isinstance(audit, dict):
            continue
        if (
            audit.get("content_hash") == content_hash
            and audit.get("prompt_versions") == config.prompt_versions()
            and audit.get("model") == config.MODEL_ID
        ):
            logger.info(
                "[ai_lane] cache HIT for document %s (period %s) — "
                "content_hash + prompt versions match; zero model calls",
                doc.get("id"), row.get("id"),
            )
            return {
                "detected_type": AI_LANE_DETECTED_TYPE,
                "company_name": (doc.get("original_filename") or "Imported entity").rsplit(".", 1)[0],
                "period_label": "Imported period",
                "period_end": None,
                "currency": row.get("currency") or "EUR",
                "confidence": 0.6,
                "accounts": [],
                "warnings": [],
                "ai_lane": {
                    "cached": True,
                    "period_id": row.get("id"),
                    "content_hash": content_hash,
                },
            }
    return None


def run_ai_lane(
    *,
    doc: Dict[str, Any],
    file_bytes: bytes,
    kind: str,
    resolution: Dict[str, Any],
    client_factory: Optional[Callable[[], Any]] = None,
    admin_factory: Optional[Callable[[], Any]] = None,
) -> Dict[str, Any]:
    """Full AI-lane run for a HU/OTHER document. Returns the `parsed`
    payload the pipeline orchestrator persists via its dedicated
    ai-lane branch. Raises AiLaneError on any unrecoverable failure —
    the document is then marked failed with the message (never partial
    numbers, nothing persisted)."""
    jurisdiction = str(resolution.get("jurisdiction") or "OTHER")
    content_hash = content_hash_of(file_bytes)

    cached = _cache_lookup(doc, content_hash, admin_factory)
    if cached is not None:
        return cached

    filename = str(doc.get("original_filename") or "")
    doc_text = _format_mod.document_to_text(kind, file_bytes, filename)

    # ONE client for all three stages, created lazily AFTER the cache
    # check so a cache hit never constructs (or calls) a client.
    client = (client_factory or config.default_client_factory)()

    audit_stages: List[Dict[str, Any]] = []
    logger.info(
        "[ai_lane] run start: doc=%s jurisdiction=%s source=%s conf=%s "
        "model=%s prompt_versions=%s",
        doc.get("id"), jurisdiction, resolution.get("source"),
        resolution.get("confidence"), config.MODEL_ID, config.prompt_versions(),
    )

    fmt = _format_mod.run_format_detect(
        doc_text, jurisdiction=jurisdiction, filename=filename,
        client=client, audit_stages=audit_stages,
    )
    extract_result = _extract_mod.run_extract(
        doc_text, fmt, jurisdiction=jurisdiction, filename=filename,
        client=client, audit_stages=audit_stages,
    )
    if not extract_result.rows:
        raise AiLaneError(
            "AI extraction returned no account rows — the document does "
            "not look like a readable trial balance / statement export."
        )
    classify_result = _classify_mod.run_classify(
        extract_result.rows, jurisdiction=jurisdiction,
        client=client, audit_stages=audit_stages,
    )

    source_anchor = build_source_anchor(extract_result, fmt)
    envelope, line_items, needs_review = build_ai_envelope(
        rows=extract_result.rows,
        classify_result=classify_result,
        fmt=fmt,
        source_anchor=source_anchor,
        jurisdiction=jurisdiction,
        resolution=resolution,
    )
    envelope["ai_audit"] = {
        "model": config.MODEL_ID,
        "content_hash": content_hash,
        "prompt_versions": config.prompt_versions(),
        "jurisdiction": jurisdiction,
        "resolution": dict(resolution),
        "stages": audit_stages,
    }

    canonical_bs = envelope["canonical_bs"]
    totals = canonical_bs.get("totals") or {}
    currency = fmt.currency or ("HUF" if jurisdiction == "HU" else "EUR")
    company_name = (filename or "Imported entity").rsplit(".", 1)[0]

    assembled: Dict[str, Any] = {
        "statements": {
            "companyName": company_name,
            "currency": currency,
            "periodLabel": "Imported period",
            "balanceSheet": {},
            "incomeStatement": {},
            # Legacy totals SERIALIZED from canonical_bs (no arithmetic).
            "assembled_bs": {
                "total_assets": totals.get("assets"),
                "total_liabilities": totals.get("liabilities"),
                "total_equity": totals.get("equity"),
                "bs_balance_delta": canonical_bs.get("difference"),
            },
            "assembled_pl": {},
            "assembled_cf": {},
        },
        "lineItems": line_items,
        "unmapped": [dict(u) for u in envelope.get("unmapped") or []],
        "ignored": [],
        "assembled_canonical_v1": envelope,
        "pack_notice": (
            "AI extraction lane (%s, %s): %d accounts classified, %d in "
            "needs_review. LLM extractions are capped below BALANCED by "
            "contract." % (
                jurisdiction, config.MODEL_ID,
                len(line_items), len(needs_review),
            )
        ),
    }

    logger.info(
        "[ai_lane] run complete: doc=%s status=%s rows=%d classified=%d "
        "needs_review=%d anchor=%s",
        doc.get("id"), canonical_bs.get("status"), len(extract_result.rows),
        len(line_items), len(needs_review),
        (source_anchor or {}).get("anchor_status"),
    )

    return {
        "detected_type": AI_LANE_DETECTED_TYPE,
        "company_name": company_name,
        "period_label": "Imported period",
        "period_end": None,  # stage_persist falls back to filename detection
        "currency": currency,
        "confidence": 0.6,
        "accounts": [],      # RO stages must never consume AI-lane accounts
        "warnings": [],
        "ai_lane": {
            "cached": False,
            "jurisdiction": jurisdiction,
            "resolution": dict(resolution),
            "content_hash": content_hash,
            "assembled": assembled,
        },
    }
