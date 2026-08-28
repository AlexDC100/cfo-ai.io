"""Reconciliation flow for canonical_bs v2 — the calm, reversible,
validator-gated fix for sources that land slightly off.

Contract: docs/CANONICAL_BS_V2_CONTRACT.md, section "RECONCILIATION FLOW"
+ the AUTO-RECONCILE addendum (revised operator spec, 2026-08-19):
reconciliation is a FULLY AUTOMATIC server-side stage. Ground rules:

  · The ENGINE owns arithmetic — every adjustment runs in INTEGER CENTS.
  · AI may only PROPOSE (a proposal object, never a mutation); the
    deterministic validator decides, and it accepts ONLY an exact
    0-cent close. No path produces BALANCED from altered numbers —
    RECONCILED is a distinct state.
  · AUTO STAGE (`auto_reconcile_envelope`): runs at stage_persist time,
    between the canonical build and the SINGLE envelope write, so a
    freshly-scanned sub-threshold period is already RECONCILED by the
    time any client can fetch it — the client is never sent an
    intermediate unreconciled sub-threshold state. Deterministic
    diagnosis first (R1 rounding cents → R2 single unmapped == delta →
    R3 side-flip → R_DUP duplicated totals row), AI proposal only when
    inconclusive. AI unavailable / proposal rejected → HONEST
    MINOR_DRIFT + `needs_review: true` on the served object (calm, not
    an error) — never a fake zero.
  · Source cents are NEVER overwritten: the persisted
    `assembled_canonical_v1.canonical_bs` stays byte-identical; the
    accepted reconciliation is stored NEXT TO it
    (`assembled_canonical_v1.reconciliation`, keyed by
    provenance.content_hash) and applied to the SERVED object only.
  · PLACEMENT: one visible line "Diferențe de reconciliere". A class
    6/7 diagnosed cause routes it to the P&L by the delta's sign
    (income / expense), reaching the BS through the result row; every
    other cause is a balance-sheet line. Extracted cents never change.
  · Serving is a pure function of the persisted envelope
    (`served_canonical_bs`) so a hard refresh re-serves RECONCILED
    byte-identically. A content-hash mismatch (re-scan of a different
    file) ignores the stored entry — logged, never deleted.
  · UNDO writes a suppression entry keyed by content_hash +
    parser_version + mapping_version so the auto stage never re-applies
    against the user's explicit choice; a new file or a version bump
    clears the key (the suppression simply stops matching). The
    explicit ops POST /reconcile clears a matching suppression.
  · The deterministic numeric path (`build_canonical_bs_v2`, the
    determinism gate, measure_bs_drift) is untouched: reconciliation
    applies at persist-seam / serve time only.

Wired from `pipeline.stage_persist` (`carry_forward_reconciliation` +
`auto_reconcile_envelope`, before the single envelope write), from
`pipeline.build_router()` via `register_routes(...)` (the two POST
endpoints — /reconcile is now an ops/manual trigger; the FE only calls
undo) and from `_apply_envelope_truth_to_statements` (the serve-path
application + `needs_review` / `reconcile_offer` stamps + the P&L-placed
line on `statements.assembled_pl`).
"""

from __future__ import annotations

import copy
import json
import logging
import os
import re
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from fastapi import Header, HTTPException

from engine import serving as _serving
from engine.ai import registry as _model_registry

from . import _supabase

logger = logging.getLogger("engine.api.reconcile")

# ── Constants ──────────────────────────────────────────────────────────

#: Recorded on every llm_proposed receipt. REGISTRY-WIRED (engine.ai/
#: models.yaml, role "reconcile_proposal") with value-identical cutover
#: — stored receipts carry these exact strings; bump the base version
#: in models.yaml on ANY prompt change. Locked by
#: tests/engine/test_model_registry.py.
PROMPT_VERSION = _model_registry.params_for("reconcile_proposal")["prompt_version"]
#: The proposal model (registry role "reconcile_proposal").
AI_MODEL = _model_registry.model_for("reconcile_proposal")

#: The reconcile gate: offer / accept only while
#: |difference| / max(assets, equity_plus_liabilities) <= 0.1%.
#: Expressed as an integer multiplier so the check runs in exact cents:
#: |diff_cents| * GATE_DENOMINATOR_MULTIPLier <= denom_cents.
_GATE_MULTIPLIER = 1000  # 1/0.001

SYNTHETIC_ROW_ID = "reconciliation_adjustment"
SYNTHETIC_ROW_LABEL = "Diferențe de reconciliere"

#: `applied_by` on receipts written by the automatic persist-seam stage.
AUTO_APPLIED_BY = "system:auto-reconcile"

#: Receipt `placement` — the value the FE strip consumes (2-way):
PLACEMENT_BS = "balance_sheet"
PLACEMENT_PL = "pnl"
#: Receipt `placement_detail` — the operator-spec vocabulary (3-way),
#: also carried on the P&L-served `reconciliation_adjustment` line:
PLACEMENT_DETAIL_BS = "bs"
PLACEMENT_DETAIL_PL_INCOME = "pl_other_income"
PLACEMENT_DETAIL_PL_EXPENSE = "pl_other_expense"

#: The two result-row ids the P&L placement adjusts (the delta reaches
#: the BS through this equity line).
_RESULT_ROW_IDS = ("current_year_profit", "current_year_loss")

#: Mirrors canonical_adapter._BS_V2_ASSET_SECTIONS (kept literal here so
#: this module never imports the builder — serve-path must not touch the
#: deterministic build path).
_ASSET_SECTIONS = {"non_current_assets", "current_assets", "prepaid_expenses"}

#: D5_DUPLICATE_ROWS detail parser for the R_DUP diagnosis — the format
#: is owned by engine.confidence.reconciliation_checks (run_bs_diagnosis)
#: and locked by test_reconciliation.py::test_dup_totals_row_*.
_D5_DETAIL_RE = re.compile(
    r"appears\s+(\d+)×\s+with identical amount\s+(-?[\d,]+\.\d{2})"
)


class ReconcileRejected(Exception):
    """Raised by the pure flow when the reconcile action must 409.

    `payload` is the response body: {"status": "rejected"|"inconclusive",
    "diagnosis": [{code, detail}, ...]}.
    """

    def __init__(self, payload: Dict[str, Any]) -> None:
        super().__init__(json.dumps(payload, sort_keys=True, ensure_ascii=False))
        self.payload = payload


# ── Cents helpers (same convention as canonical_adapter._cents) ────────


def _cents(value: Any) -> int:
    """Parse a 2-decimal currency value into exact integer cents."""
    try:
        return int(round(float(value or 0) * 100))
    except (TypeError, ValueError):
        return 0


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _gate_ok(diff_cents: int, assets_cents: int, el_cents: int) -> bool:
    """True iff 0 < |diff| / max(|assets|, |E+L|) <= 0.1%, in exact cents."""
    denom = max(abs(assets_cents), abs(el_cents))
    if denom <= 0 or diff_cents == 0:
        return False
    return abs(diff_cents) * _GATE_MULTIPLIER <= denom


# ── Offer (REVISED semantics — auto-reconcile addendum) ────────────────


def compute_reconcile_offer(cbs: Dict[str, Any], *, needs_review: bool = False) -> bool:
    """`reconcile_offer` is kept for API compatibility but is now true
    ONLY in the needs-review situations where the automatic stage could
    not fix the drift (rejected proposal / AI unavailable). The FE no
    longer renders a button from it — POST /reconcile is an ops/manual
    trigger. A plain sub-threshold drift the auto stage never judged
    (legacy envelope, suppressed-after-undo) does NOT offer."""
    if not needs_review:
        return False
    status = str(cbs.get("status") or "")
    if status in ("BALANCED", "RECONCILED"):
        return False
    totals = cbs.get("totals") or {}
    return _gate_ok(
        _cents(cbs.get("difference")),
        _cents(totals.get("assets")),
        _cents(totals.get("equity_plus_liabilities")),
    )


# ── Version / suppression / auto-marker keys ───────────────────────────


def _cbs_versions(cbs: Dict[str, Any]) -> Tuple[Optional[str], Optional[str]]:
    """(parser_version, mapping_version) of a canonical_bs — the two
    halves of every reconciliation key besides content_hash."""
    extraction = cbs.get("extraction") if isinstance(cbs, dict) else None
    parser_version = (extraction or {}).get("parser_version")
    mapping_version = (cbs or {}).get("mapping_version")
    return (
        str(parser_version) if parser_version is not None else None,
        str(mapping_version) if mapping_version is not None else None,
    )


def _envelope_key(envelope: Dict[str, Any]) -> Tuple[Optional[str], Optional[str], Optional[str]]:
    """(content_hash, parser_version, mapping_version) of an envelope —
    the identity every suppression / auto-marker entry is matched on."""
    provenance_hash = (envelope.get("provenance") or {}).get("content_hash")
    parser_version, mapping_version = _cbs_versions(envelope.get("canonical_bs") or {})
    return (
        str(provenance_hash) if provenance_hash else None,
        parser_version,
        mapping_version,
    )


def _envelope_pack_hash(envelope: Any) -> Optional[str]:
    """The classification pack content hash the envelope was built under
    (assembled_canonical_v1.pack_provenance.pack_hash — Phase 3 cutover),
    or None for pre-cutover envelopes / lanes without a pack (HU AI
    lane). Part of the carry-forward snapshot key: a pack content change
    (even without a version bump) must drop stale reconciliation state
    the same way a parser/mapping version bump does."""
    if not isinstance(envelope, dict):
        return None
    provenance = envelope.get("pack_provenance")
    if not isinstance(provenance, dict):
        return None
    pack_hash = provenance.get("pack_hash")
    return str(pack_hash) if pack_hash else None


def _entry_matches_key(
    entry: Any, key: Tuple[Optional[str], Optional[str], Optional[str]]
) -> bool:
    if not isinstance(entry, dict) or not key[0]:
        return False
    return (
        entry.get("content_hash") == key[0]
        and entry.get("parser_version") == key[1]
        and entry.get("mapping_version") == key[2]
    )


def _matching_suppression(envelope: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """The suppression entry (written by an explicit undo) that matches
    this envelope's content_hash + parser_version + mapping_version, or
    None. A new file or a version bump simply stops matching — that is
    how suppression 'clears' on recompute-worthy changes."""
    key = _envelope_key(envelope)
    for entry in envelope.get("reconciliation_suppressed") or []:
        if _entry_matches_key(entry, key):
            return entry
    return None


def _matching_needs_review_marker(envelope: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """The auto-stage needs-review marker matching the CURRENT source +
    versions, or None (a stale marker for another file/build is inert)."""
    marker = envelope.get("reconciliation_auto")
    if not isinstance(marker, dict) or marker.get("outcome") != "needs_review":
        return None
    return marker if _entry_matches_key(marker, _envelope_key(envelope)) else None


# ── Adjustment application (pure, integer cents) ───────────────────────


def _recompute_partition_difference_cents(cbs: Dict[str, Any]) -> int:
    """Difference recomputed FROM THE ROWS (the partition), in cents:
    Σ(asset-section rows) − Σ(non-asset-section rows). The validator
    accepts only an exact 0 here — never a totals-only echo."""
    asset_cents = 0
    el_cents = 0
    for row in cbs.get("rows") or []:
        amount = _cents(row.get("amount"))
        if str(row.get("section") or "") in _ASSET_SECTIONS:
            asset_cents += amount
        else:
            el_cents += amount
    return asset_cents - el_cents


def _apply_adjustment(
    served: Dict[str, Any],
    amount_cents: int,
    receipt: Optional[Dict[str, Any]],
    placement: str = PLACEMENT_BS,
) -> Dict[str, Any]:
    """Apply the accepted adjustment to a SERVED COPY of canonical_bs,
    in place: visible line + section subtotal + totals + difference +
    status RECONCILED (+ the receipt when given). `amount_cents` is the
    signed adjustment on the equity+liabilities side (positive ⇒ the
    credit side gains; negative ⇒ the asset side gains |amount|), so an
    exact close requires amount_cents == difference_cents.

    PLACEMENT RULE (auto-reconcile addendum): `placement`
      · "balance_sheet" (default) — the synthetic "Diferențe de
        reconciliere" row lands in current_liabilities / current_assets
        by the delta's sign (unchanged prior behavior);
      · "pnl" — the diagnosed cause is a class 6/7 account: the visible
        line lives in the P&L (served on `statements.assembled_pl` as
        `reconciliation_adjustment` by the pipeline hook) and reaches
        the BS through the RESULT row, which is adjusted by the delta
        and carries a leaf note. When the statement has no result row
        yet, the synthetic row lands in the equity section instead so
        the adjustment stays visible on the BS.

    Mutates and returns `served`. Callers pass a deep copy — the
    persisted canonical_bs (extracted source cents) is never touched.
    """
    totals = served.get("totals") or {}
    assets_cents = _cents(totals.get("assets"))
    equity_cents = _cents(totals.get("equity"))
    liabilities_cents = _cents(totals.get("liabilities"))
    current_assets_cents = _cents(totals.get("current_assets"))
    current_liabilities_cents = _cents(totals.get("current_liabilities"))
    rows = list(served.get("rows") or [])
    sections = list(served.get("sections") or [])

    def _bump_section(section_id: str, delta_cents: int) -> None:
        for entry in sections:
            if str(entry.get("id") or "") == section_id:
                entry["subtotal"] = (
                    _cents(entry.get("subtotal")) + delta_cents
                ) / 100.0
                return
        sections.append({"id": section_id, "subtotal": delta_cents / 100.0})

    def _insert_synthetic(section_id: str, row_amount_cents: int) -> None:
        synthetic_row = {
            "id": SYNTHETIC_ROW_ID,
            "section": section_id,
            "label_key": "bs.row.%s" % SYNTHETIC_ROW_ID,
            "label": SYNTHETIC_ROW_LABEL,
            "account_codes": [],
            "amount": row_amount_cents / 100.0,
            "opening": None,
            "leaf_ids": [],
            "synthetic": True,
        }
        # Keep section grouping: insert after the last row of the target
        # section; append at the end when the section has no rows yet.
        insert_at = len(rows)
        for i, row in enumerate(rows):
            if str(row.get("section") or "") == section_id:
                insert_at = i + 1
        rows.insert(insert_at, synthetic_row)

    if placement == PLACEMENT_PL:
        # Class 6/7 cause — the delta reaches the BS through the result
        # row in equity; no synthetic BS row for the common case.
        result_row = next(
            (r for r in rows if str(r.get("id") or "") in _RESULT_ROW_IDS), None
        )
        if result_row is not None:
            result_row["amount"] = (
                _cents(result_row.get("amount")) + amount_cents
            ) / 100.0
            # Leaf note: the adjusted figure names its reason — the
            # extracted leaves themselves (leaf_ids) are untouched.
            result_row["reconciliation_delta"] = amount_cents / 100.0
            result_row["reconciliation_note"] = SYNTHETIC_ROW_LABEL
        else:
            _insert_synthetic("equity", amount_cents)
        _bump_section("equity", amount_cents)
        equity_cents += amount_cents
        totals["equity"] = equity_cents / 100.0
    elif amount_cents > 0:
        _insert_synthetic("current_liabilities", amount_cents)
        _bump_section("current_liabilities", amount_cents)
        liabilities_cents += amount_cents
        current_liabilities_cents += amount_cents
    else:
        _insert_synthetic("current_assets", -amount_cents)
        _bump_section("current_assets", -amount_cents)
        assets_cents += -amount_cents
        current_assets_cents += -amount_cents

    served["rows"] = rows
    served["sections"] = sections

    el_cents = equity_cents + liabilities_cents
    totals["assets"] = assets_cents / 100.0
    totals["liabilities"] = liabilities_cents / 100.0
    totals["equity_plus_liabilities"] = el_cents / 100.0
    totals["current_assets"] = current_assets_cents / 100.0
    totals["current_liabilities"] = current_liabilities_cents / 100.0
    served["totals"] = totals

    served["difference"] = (assets_cents - el_cents) / 100.0
    served["status"] = "RECONCILED"
    if receipt is not None:
        served["reconciliation"] = dict(receipt)
    return served


# ── Serve path (pure function of the persisted envelope) ───────────────


def served_canonical_bs(envelope: Any) -> Optional[Dict[str, Any]]:
    """The canonical_bs object /api/period serves for this envelope.

    Pure and deterministic: deep-copies the persisted canonical_bs,
    applies the stored accepted reconciliation ONLY when its
    content_hash matches the envelope's provenance.content_hash (and
    only when it still closes to exactly 0 cents), then stamps
    `needs_review` (True iff the auto stage attempted and could not fix
    THIS source+build), `reconcile_offer` (revised semantics: true only
    in that needs-review state), `envelope_version` ("sv1" — the served
    contract version, docs/served_envelope.schema.json) and
    `status_presentation` (the ONE wording object every surface derives
    its status copy from — engine.serving.present_status). Byte-identical
    output for the same envelope — hard-refresh stable by construction.
    Returns None when the envelope carries no usable canonical_bs
    (legacy periods keep the Fix-A1 path).

    ADDITIVE-ONLY SERVE GUARD (sv1): the served object is compared
    key->type against the persisted canonical_bs — serve mutations may
    only ADD keys (incl. the documented needs_review boolean stamp when
    the key was absent); a removal or retype (incl. replacing the
    AI-lane needs_review ARRAY with a boolean — the array-preserve
    guard) trips the guard, which logs loudly and falls back to serving
    the UNMUTATED persisted object with the serve stamps only. Serving
    never breaks; the guard's real teeth are the contract tests.
    """
    if not isinstance(envelope, dict):
        return None
    cbs = envelope.get("canonical_bs")
    if not isinstance(cbs, dict) or not isinstance(cbs.get("totals"), dict):
        return None
    served = copy.deepcopy(cbs)

    stored = envelope.get("reconciliation")
    if isinstance(stored, dict):
        provenance_hash = (envelope.get("provenance") or {}).get("content_hash")
        stored_hash = stored.get("content_hash")
        if stored_hash and provenance_hash and stored_hash == provenance_hash:
            try:
                trial = _apply_adjustment(
                    copy.deepcopy(served),
                    int(stored["amount_cents"]),
                    stored,
                    placement=str(stored.get("placement") or PLACEMENT_BS),
                )
                totals = trial.get("totals") or {}
                closes_exactly = (
                    _cents(totals.get("assets"))
                    - _cents(totals.get("equity_plus_liabilities"))
                    == 0
                    and _recompute_partition_difference_cents(trial) == 0
                )
                if closes_exactly:
                    served = trial
                else:
                    logger.warning(
                        "[reconcile] stored reconciliation no longer closes to "
                        "exactly 0 cents — serving the original canonical_bs "
                        "(entry kept for audit)"
                    )
            except Exception:  # noqa: BLE001 — serving must never break
                logger.exception(
                    "[reconcile] failed to apply stored reconciliation — "
                    "serving the original canonical_bs"
                )
        else:
            # Re-scan of a different file: the stored entry is keyed to a
            # source that is no longer attached. Ignore it entirely — do
            # NOT delete; the audit trail stays, and a matching source
            # would re-apply it.
            logger.info(
                "[reconcile] stored reconciliation ignored: content_hash "
                "mismatch (stored=%s, current=%s)",
                stored_hash,
                provenance_hash,
            )

    def _stamped(obj: Dict[str, Any]) -> Dict[str, Any]:
        # needs_review — served flag only (never persisted into
        # canonical_bs): the auto stage ran on THIS source+build and
        # could not close it (validator reject / AI unavailable).
        # Honest drift, calm surface.
        needs_review = (
            obj.get("status") != "RECONCILED"
            and _matching_needs_review_marker(envelope) is not None
        )
        # AI-lane envelopes carry needs_review as an ARRAY of
        # low-confidence lines (a different meaning: human mapping
        # queue, not auto-reconcile rejection). Overwriting it with
        # this stage's boolean silenced the FE's needs-review panel on
        # every real serving (verifier NO-GO, 2026-08-19). LLM
        # extractions are out of auto-reconcile scope, so the boolean
        # is never true for them — preserve the array.
        if not isinstance(obj.get("needs_review"), list):
            obj["needs_review"] = needs_review
        obj["reconcile_offer"] = compute_reconcile_offer(
            obj, needs_review=needs_review
        )
        # sv1 served-envelope contract stamps (engine.serving):
        # `envelope_version` versions the served shape against
        # docs/served_envelope.schema.json; `status_presentation` is the
        # ONE wording object chip/HTML/Excel/API status copy derives
        # from (RECONCILED never presents as a 'balanced'-family label).
        obj["envelope_version"] = _serving.ENVELOPE_VERSION
        obj["status_presentation"] = _serving.present_status(obj, surface="api")
        return obj

    served = _stamped(served)
    # ADDITIVE-ONLY SERVE GUARD — serve mutations must never remove or
    # retype a pipeline-produced field (sv1 contract). Unreachable by
    # construction today; if a future serve edit trips it, serve the
    # UNMUTATED persisted object (stamps only) rather than a payload
    # that dropped pipeline truth. Serving itself never breaks.
    _violations = _serving.additive_serve_violations(cbs, served)
    if _violations:
        logger.error(
            "[reconcile] ADDITIVE-ONLY SERVE GUARD tripped — serving the "
            "unmutated canonical_bs instead: %s",
            "; ".join(_violations),
        )
        served = _stamped(copy.deepcopy(cbs))
    return served


# ── Deterministic diagnosis (contract order: a → b → c) ────────────────


def _unmapped_balance_cents(entry: Dict[str, Any]) -> Optional[int]:
    """Signed debit-side balance of an `unmapped` entry, in cents, or
    None when the entry carries no usable balance (or is explicitly
    absorbed / off-balance — those cannot be the missing value)."""
    reason = str(entry.get("reason") or "")
    if "absorbed_in_result" in reason or "off_balance" in reason:
        return None
    if "sf_d" in entry or "sf_c" in entry:
        return _cents(entry.get("sf_d")) - _cents(entry.get("sf_c"))
    if "amount" in entry:
        return _cents(entry.get("amount"))
    return None


def run_deterministic_diagnosis(cbs: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """The engine's own diagnosis, in the contract's fixed order:
      (a) rounding-cent drift — |difference| <= 1 RON × sections touched;
      (b) a single unmapped/unclassified account whose |balance| equals
          |difference| to the cent;
      (c) a sign/contra side-flip whose 2×|balance| equals |difference|
          to the cent (exactly one candidate across rows + unmapped);
      (d) R_DUP — a duplicated totals row: exactly one D5_DUPLICATE_ROWS
          account appearing twice with an identical amount whose removal
          closes the difference to 0 (|amount| == |difference| exactly).
    Returns a proposal dict {origin, diagnosis_code, target_account,
    amount_cents, rationale} or None (→ AI proposal path).

    `amount_cents` is always the signed difference itself: the ONLY
    adjustment the validator can accept is the one that closes the
    partition to exactly 0 cents. The diagnosis names the likely
    culprit; the engine owns the arithmetic.
    """
    diff_cents = _cents(cbs.get("difference"))
    if diff_cents == 0:
        return None

    # (a) rounding-cent drift.
    sections_touched = sum(
        1 for s in (cbs.get("sections") or []) if _cents(s.get("subtotal")) != 0
    )
    if abs(diff_cents) <= 100 * max(1, sections_touched):
        return {
            "origin": "deterministic",
            "diagnosis_code": "R1_ROUNDING_CENTS",
            "target_account": None,
            "amount_cents": diff_cents,
            "rationale": (
                "difference of %.2f RON is within 1 RON x %d sections touched "
                "— rounding-cent drift" % (diff_cents / 100.0, sections_touched)
            ),
        }

    # (b) single unmapped/unclassified account matching the difference.
    matches: List[Tuple[str, int]] = []
    for entry in cbs.get("unmapped") or []:
        if not isinstance(entry, dict):
            continue
        balance = _unmapped_balance_cents(entry)
        if balance is not None and balance != 0 and abs(balance) == abs(diff_cents):
            matches.append((str(entry.get("code") or ""), balance))
    if len(matches) == 1:
        code, balance = matches[0]
        return {
            "origin": "deterministic",
            "diagnosis_code": "R2_SINGLE_UNMAPPED_MATCH",
            "target_account": code,
            "amount_cents": diff_cents,
            "rationale": (
                "unmapped account %s balance %.2f RON equals the difference "
                "%.2f RON to the cent"
                % (code, balance / 100.0, diff_cents / 100.0)
            ),
        }

    # (c) side-flip: 2×|balance| == |difference| — exactly one candidate.
    flips: List[Tuple[str, int]] = []
    for row in cbs.get("rows") or []:
        if not isinstance(row, dict):
            continue
        amount = _cents(row.get("amount"))
        if amount != 0 and 2 * abs(amount) == abs(diff_cents):
            flips.append((str(row.get("id") or ""), amount))
    for entry in cbs.get("unmapped") or []:
        if not isinstance(entry, dict):
            continue
        balance = _unmapped_balance_cents(entry)
        if balance is not None and balance != 0 and 2 * abs(balance) == abs(diff_cents):
            flips.append((str(entry.get("code") or ""), balance))
    if len(flips) == 1:
        target, balance = flips[0]
        return {
            "origin": "deterministic",
            "diagnosis_code": "R3_SIDE_FLIP",
            "target_account": target,
            "amount_cents": diff_cents,
            "rationale": (
                "%s at %.2f RON: twice its magnitude equals the difference "
                "%.2f RON — likely classified on the wrong side"
                % (target, balance / 100.0, diff_cents / 100.0)
            ),
        }

    # (d) R_DUP — duplicated totals row. The build's own D5_DUPLICATE_ROWS
    # diagnosis already names every (code, amount) pair appearing more
    # than once; the reconcile condition on top: the pair appears exactly
    # TWICE and removing one copy closes the difference to 0, i.e.
    # |amount| == |difference| to the cent. Exactly one candidate.
    dups: List[Tuple[str, int]] = []
    for entry in cbs.get("diagnosis") or []:
        if not isinstance(entry, dict) or entry.get("code") != "D5_DUPLICATE_ROWS":
            continue
        match = _D5_DETAIL_RE.search(str(entry.get("detail") or ""))
        if not match:
            continue
        count = int(match.group(1))
        amount_cents = _cents(match.group(2).replace(",", ""))
        if count != 2 or amount_cents == 0:
            continue
        if abs(amount_cents) != abs(diff_cents):
            continue
        leaf_ids = entry.get("leaf_ids") or []
        code = str(leaf_ids[0]) if leaf_ids else ""
        dups.append((code, amount_cents))
    if len(dups) == 1:
        code, amount_cents = dups[0]
        return {
            "origin": "deterministic",
            "diagnosis_code": "R_DUP_TOTALS_ROW",
            "target_account": code,
            "amount_cents": diff_cents,
            "rationale": (
                "account %s appears twice with identical amount %.2f RON — "
                "removing the duplicated totals row closes the difference "
                "%.2f RON exactly"
                % (code, amount_cents / 100.0, diff_cents / 100.0)
            ),
        }

    return None


# ── Placement rule (auto-reconcile addendum) ───────────────────────────


def _placement_for(
    proposal: Dict[str, Any], amount_cents: int
) -> Tuple[str, str]:
    """(placement, placement_detail) for a validated proposal.

    A diagnosed cause that is a class 6/7 account code routes the
    visible line to the P&L by the delta's sign — the equity side must
    GAIN when assets exceed E+L (income), SHRINK otherwise (expense) —
    reaching the BS through the result row. Every other cause (rounding
    cents, BS-account fingerprints, row ids, no named account) is a
    balance-sheet line."""
    target = str(proposal.get("target_account") or "")
    if target.isdigit() and target[:1] in ("6", "7") and amount_cents != 0:
        detail = (
            PLACEMENT_DETAIL_PL_INCOME
            if amount_cents > 0
            else PLACEMENT_DETAIL_PL_EXPENSE
        )
        return PLACEMENT_PL, detail
    return PLACEMENT_BS, PLACEMENT_DETAIL_BS


def _target_row_id_for(cbs: Dict[str, Any], placement: str) -> str:
    """The row the visible adjustment lands on: the result row for P&L
    placement (when the statement has one), the synthetic row otherwise."""
    if placement == PLACEMENT_PL:
        for row in cbs.get("rows") or []:
            if str(row.get("id") or "") in _RESULT_ROW_IDS:
                return str(row["id"])
    return SYNTHETIC_ROW_ID


# ── AI proposal (proposal object only — never a mutation) ──────────────

_AI_SYSTEM_PROMPT = (
    "You are the reconciliation advisor for a Romanian (OMFP 1802) balance "
    "sheet engine. You receive a compact JSON canonical balance sheet whose "
    "`difference` (assets minus equity+liabilities, RON) is nonzero, plus "
    "its rows and unmapped accounts. Propose the single most likely "
    "adjusting entry as JSON. `amount_cents` is the SIGNED integer-cents "
    "adjustment applied to the equity+liabilities side (positive increases "
    "liabilities, negative increases assets); to close the statement it "
    "must equal the difference in cents exactly. `target_account` names the "
    "account or row you believe is at fault. You only PROPOSE — a "
    "deterministic validator recomputes everything in integer cents and "
    "accepts only an exact zero close. Never invent account codes not "
    "present in the input."
)

_AI_PROPOSAL_SCHEMA = {
    "type": "object",
    "properties": {
        "target_account": {"type": "string"},
        "amount_cents": {"type": "integer"},
        "rationale": {"type": "string"},
    },
    "required": ["target_account", "amount_cents", "rationale"],
    "additionalProperties": False,
}


def _ai_propose(cbs: Dict[str, Any]) -> Dict[str, Any]:
    """Ask Claude for a proposal object. Raises on ANY failure (missing
    key, SDK missing, network, refusal, bad JSON) — the caller maps every
    raise to 409 {"status": "inconclusive"}. Never fabricates a proposal.
    """
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise RuntimeError("ANTHROPIC_API_KEY not configured")
    from anthropic import Anthropic  # ImportError → inconclusive

    client = Anthropic(api_key=api_key, max_retries=2, timeout=60.0)
    compact = {
        "difference": cbs.get("difference"),
        "status": cbs.get("status"),
        "totals": cbs.get("totals"),
        "rows": [
            {
                "id": row.get("id"),
                "section": row.get("section"),
                "amount": row.get("amount"),
                "account_codes": row.get("account_codes"),
            }
            for row in (cbs.get("rows") or [])
        ],
        "unmapped": cbs.get("unmapped") or [],
        "diagnosis": cbs.get("diagnosis") or [],
    }
    response = client.messages.create(
        model=AI_MODEL,
        max_tokens=1024,
        system=_AI_SYSTEM_PROMPT,
        messages=[
            {
                "role": "user",
                "content": json.dumps(compact, sort_keys=True, ensure_ascii=False),
            }
        ],
        output_config={
            "format": {"type": "json_schema", "schema": _AI_PROPOSAL_SCHEMA}
        },
    )
    if getattr(response, "stop_reason", None) == "refusal":
        raise RuntimeError("model declined the reconciliation request")
    raw = "".join(
        block.text
        for block in response.content
        if getattr(block, "type", None) == "text"
    ).strip()
    data = json.loads(raw)  # bad JSON raises → inconclusive
    return {
        "origin": "llm_proposed",
        "diagnosis_code": "R4_AI_PROPOSAL",
        "target_account": str(data["target_account"]),
        "amount_cents": int(data["amount_cents"]),
        "rationale": str(data["rationale"]),
        "model": AI_MODEL,
        "prompt_version": PROMPT_VERSION,
    }


# ── Validator gate (deterministic; exact-zero close only) ──────────────


def validate_proposal(
    cbs: Dict[str, Any],
    proposal: Dict[str, Any],
    placement: str = PLACEMENT_BS,
) -> int:
    """Apply the proposal as a synthetic adjusting entry to a COPY of
    the canonical totals/rows — at the SAME placement the accepted
    receipt would serve with — and recompute the difference in integer
    cents from the adjusted partition. Accept ONLY difference == 0
    exactly AND |amount| within the 0.1% gate. Returns the accepted
    amount_cents; raises ReconcileRejected otherwise."""
    try:
        amount_cents = int(proposal["amount_cents"])
    except (KeyError, TypeError, ValueError):
        raise ReconcileRejected(
            {
                "status": "rejected",
                "diagnosis": [
                    {
                        "code": "VALIDATOR_INVALID_PROPOSAL",
                        "detail": "proposal carries no integer amount_cents",
                    }
                ],
            }
        )
    totals = cbs.get("totals") or {}
    denom_cents = max(
        abs(_cents(totals.get("assets"))),
        abs(_cents(totals.get("equity_plus_liabilities"))),
    )
    if (
        amount_cents == 0
        or denom_cents <= 0
        or abs(amount_cents) * _GATE_MULTIPLIER > denom_cents
    ):
        raise ReconcileRejected(
            {
                "status": "rejected",
                "diagnosis": [
                    {
                        "code": "VALIDATOR_AMOUNT_ABOVE_GATE",
                        "detail": (
                            "proposed adjustment %.2f RON is zero or exceeds "
                            "0.1%% of the balance sheet" % (amount_cents / 100.0)
                        ),
                    }
                ],
            }
        )
    trial = _apply_adjustment(
        copy.deepcopy(cbs), amount_cents, receipt=None, placement=placement
    )
    trial_totals = trial.get("totals") or {}
    totals_close_cents = _cents(trial_totals.get("assets")) - _cents(
        trial_totals.get("equity_plus_liabilities")
    )
    partition_close_cents = _recompute_partition_difference_cents(trial)
    if totals_close_cents != 0 or partition_close_cents != 0:
        raise ReconcileRejected(
            {
                "status": "rejected",
                "diagnosis": [
                    {
                        "code": "VALIDATOR_NONZERO_CLOSE",
                        "detail": (
                            "adjusted statement does not close to exactly "
                            "0.00: totals %.2f RON, partition %.2f RON"
                            % (
                                totals_close_cents / 100.0,
                                partition_close_cents / 100.0,
                            )
                        ),
                    }
                ],
            }
        )
    return amount_cents


# ── Orchestration (pure, DB-free — the routes are thin wrappers) ───────


def _gate_checks(cbs: Dict[str, Any], provenance_hash: Optional[str]) -> int:
    """Shared pre-flight for the auto stage and the explicit action:
    keyable source, nonzero non-BALANCED difference, within the 0.1%
    gate. Returns the difference in cents; raises ReconcileRejected."""
    if not provenance_hash:
        raise ReconcileRejected(
            {
                "status": "rejected",
                "diagnosis": [
                    {
                        "code": "NO_PROVENANCE_HASH",
                        "detail": (
                            "envelope has no provenance.content_hash — a "
                            "reconciliation could never be keyed to its source"
                        ),
                    }
                ],
            }
        )
    diff_cents = _cents(cbs.get("difference"))
    totals = cbs.get("totals") or {}
    if diff_cents == 0 or str(cbs.get("status") or "") == "BALANCED":
        raise ReconcileRejected(
            {
                "status": "rejected",
                "diagnosis": [
                    {
                        "code": "NOTHING_TO_RECONCILE",
                        "detail": "statement already closes exactly — nothing to fix",
                    }
                ],
            }
        )
    if not _gate_ok(
        diff_cents,
        _cents(totals.get("assets")),
        _cents(totals.get("equity_plus_liabilities")),
    ):
        raise ReconcileRejected(
            {
                "status": "rejected",
                "diagnosis": [
                    {
                        "code": "ABOVE_RECONCILE_GATE",
                        "detail": (
                            "|difference| %.2f RON exceeds 0.1%% of the "
                            "balance sheet — needs a human, not an adjustment"
                            % (diff_cents / 100.0)
                        ),
                    }
                ],
            }
        )
    return diff_cents


def _diagnose_validate_receipt(
    cbs: Dict[str, Any],
    provenance_hash: str,
    diff_cents: int,
    applied_by: str,
) -> Dict[str, Any]:
    """The shared core: deterministic diagnosis (R1→R2→R3→R_DUP) → AI
    proposal fallback → placement rule → validator gate → receipt.
    Raises ReconcileRejected on every refusal (inconclusive AI,
    validator reject). The receipt is the audit record: original delta,
    cause, method (origin + diagnosis_code), model + prompt_version when
    AI was consulted, placement, snapshot key (content_hash +
    parser_version + mapping_version), timestamp, actor."""
    proposal = run_deterministic_diagnosis(cbs)
    if proposal is None:
        try:
            proposal = _ai_propose(cbs)
        except Exception as exc:  # noqa: BLE001 — ANY failure → inconclusive
            logger.warning("[reconcile] AI proposal unavailable: %s", exc)
            raise ReconcileRejected(
                {
                    "status": "inconclusive",
                    "diagnosis": list(cbs.get("diagnosis") or [])
                    + [
                        {
                            "code": "AI_UNAVAILABLE",
                            "detail": (
                                "deterministic diagnosis found no single "
                                "cause and the AI proposal path failed "
                                "(%s) — hand off to manual mapping"
                                % exc.__class__.__name__
                            ),
                        }
                    ],
                }
            )

    placement, placement_detail = _placement_for(
        proposal, _cents(proposal.get("amount_cents"))
    )
    amount_cents = validate_proposal(cbs, proposal, placement=placement)
    parser_version, mapping_version = _cbs_versions(cbs)

    return {
        "content_hash": provenance_hash,
        "parser_version": parser_version,
        "mapping_version": mapping_version,
        "original_difference": diff_cents / 100.0,
        "applied_delta": amount_cents / 100.0,
        "amount_cents": amount_cents,
        "target_row_id": _target_row_id_for(cbs, placement),
        "target_account": proposal.get("target_account"),
        "placement": placement,
        "placement_detail": placement_detail,
        "origin": proposal.get("origin"),
        "diagnosis_code": proposal.get("diagnosis_code"),
        "rationale": proposal.get("rationale"),
        "model": proposal.get("model"),
        "prompt_version": proposal.get("prompt_version"),
        "applied_at": _now_iso(),
        "applied_by": applied_by,
        "reversible": True,
    }


def _store_receipt(updated: Dict[str, Any], receipt: Dict[str, Any]) -> None:
    """Write the accepted receipt into `updated` (a deep copy),
    archiving any hash-mismatched previous entry (audit trail is
    permanent, never deleted) and clearing a stale needs-review marker."""
    previous = updated.get("reconciliation")
    if isinstance(previous, dict):
        history = list(updated.get("reconciliation_history") or [])
        archived = dict(previous)
        archived["archived_at"] = _now_iso()
        archived["archive_reason"] = "superseded_by_rescan"
        history.append(archived)
        updated["reconciliation_history"] = history
    updated["reconciliation"] = receipt
    updated.pop("reconciliation_auto", None)


def is_public_summary_envelope(envelope: Any) -> bool:
    """PS1 document-class predicate: True when the envelope is a
    reduced open-data filing (``envelope["public_summary"]`` with a
    dict ``indicators`` — the ps1 shape the summary tier of
    engine.serving.FactsGateway probes). ONE predicate shared by every
    structural refusal seam — auto_reconcile_envelope,
    perform_reconcile, and pipeline.stage_persist's AI-advisory /
    consensus-attach guards — so the refusals can never drift apart.
    Never raises."""
    if not isinstance(envelope, dict):
        return False
    summary = envelope.get("public_summary")
    return isinstance(summary, dict) and isinstance(summary.get("indicators"), dict)


def _serve_mismatch() -> ReconcileRejected:
    return ReconcileRejected(
        {
            "status": "rejected",
            "diagnosis": [
                {
                    "code": "VALIDATOR_SERVE_MISMATCH",
                    "detail": "accepted adjustment did not serve as RECONCILED",
                }
            ],
        }
    )


def perform_reconcile(
    envelope: Dict[str, Any], user_id: str
) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    """The EXPLICIT reconcile action (ops/manual trigger — the FE no
    longer calls it) against one persisted envelope.

    Returns (updated_envelope, served_canonical_bs). When the envelope
    already carries an accepted reconciliation for the current source,
    returns the SAME envelope object (callers skip the persist) — the
    action is idempotent. A suppression entry written by an earlier undo
    is CLEARED by this explicit call (the caller is overriding that
    choice deliberately). Raises ReconcileRejected for every refusal
    (gate, balanced, validator, AI unavailable/inconclusive).
    """
    # PS1 STRUCTURAL REFUSAL — document-class check FIRST, before any
    # canonical_bs probe: a public_summary envelope (reduced open-data
    # filing) is NEVER reconcilable, even if a canonical_bs-shaped block
    # was ever attached for convenience. Named, not incidental — the
    # NO_CANONICAL_BS refusal below would silently vanish the moment
    # such a block appeared.
    if is_public_summary_envelope(envelope):
        raise ReconcileRejected(
            {
                "status": "rejected",
                "diagnosis": [
                    {
                        "code": "PUBLIC_SUMMARY",
                        "detail": "public_summary envelopes are summary-level "
                        "open data — reconciliation requires a trial balance",
                    }
                ],
            }
        )
    cbs = envelope.get("canonical_bs") if isinstance(envelope, dict) else None
    if not isinstance(cbs, dict) or not isinstance(cbs.get("totals"), dict):
        raise ReconcileRejected(
            {
                "status": "inconclusive",
                "diagnosis": [
                    {
                        "code": "NO_CANONICAL_BS",
                        "detail": "envelope carries no canonical_bs to reconcile",
                    }
                ],
            }
        )

    provenance_hash = (envelope.get("provenance") or {}).get("content_hash")
    stored = envelope.get("reconciliation")
    if (
        isinstance(stored, dict)
        and provenance_hash
        and stored.get("content_hash") == provenance_hash
    ):
        # Idempotent: already reconciled for this exact source.
        return envelope, served_canonical_bs(envelope)

    diff_cents = _gate_checks(cbs, provenance_hash)
    receipt = _diagnose_validate_receipt(
        cbs, provenance_hash, diff_cents, applied_by=user_id
    )

    updated = copy.deepcopy(envelope)
    # Explicit call clears a matching suppression — respecting it means
    # acknowledging it deliberately, and the caller IS the override.
    key = _envelope_key(updated)
    suppressed = list(updated.get("reconciliation_suppressed") or [])
    kept = [e for e in suppressed if not _entry_matches_key(e, key)]
    if len(kept) != len(suppressed):
        logger.info(
            "[reconcile] explicit reconcile clears %d suppression entr%s "
            "for content_hash=%s",
            len(suppressed) - len(kept),
            "y" if len(suppressed) - len(kept) == 1 else "ies",
            key[0],
        )
        if kept:
            updated["reconciliation_suppressed"] = kept
        else:
            updated.pop("reconciliation_suppressed", None)
    _store_receipt(updated, receipt)

    served = served_canonical_bs(updated)
    if (
        not isinstance(served, dict)
        or served.get("status") != "RECONCILED"
        or _cents(served.get("difference")) != 0
    ):
        # By construction unreachable; fail loud rather than persist a
        # reconciliation the serve path would not honor.
        raise _serve_mismatch()
    return updated, served


def perform_undo(
    envelope: Dict[str, Any], user_id: str
) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    """Reverse an applied reconciliation: archive the stored entry under
    reconciliation_history (the audit trail is permanent), WRITE THE
    SUPPRESSION ENTRY {content_hash, parser_version, mapping_version,
    suppressed_at, suppressed_by} so the automatic stage never re-applies
    against this explicit choice (a new file or a version bump stops the
    key matching and clears it), and return (updated_envelope, recomputed
    original serving — the TRUE source imbalance)."""
    stored = envelope.get("reconciliation") if isinstance(envelope, dict) else None
    if not isinstance(stored, dict):
        raise ReconcileRejected(
            {
                "status": "rejected",
                "diagnosis": [
                    {
                        "code": "NOTHING_TO_UNDO",
                        "detail": "no stored reconciliation on this period",
                    }
                ],
            }
        )
    updated = copy.deepcopy(envelope)
    archived = dict(updated.pop("reconciliation"))
    archived["undone_at"] = _now_iso()
    archived["undone_by"] = user_id
    history = list(updated.get("reconciliation_history") or [])
    history.append(archived)
    updated["reconciliation_history"] = history

    # Suppression key: the CURRENT source + build versions (fallback to
    # the receipt's own key halves for legacy envelopes without them).
    content_hash, parser_version, mapping_version = _envelope_key(updated)
    suppression = {
        "content_hash": content_hash or archived.get("content_hash"),
        "parser_version": parser_version,
        "mapping_version": mapping_version,
        "suppressed_at": _now_iso(),
        "suppressed_by": user_id,
    }
    entries = [
        e
        for e in (updated.get("reconciliation_suppressed") or [])
        if not _entry_matches_key(
            e, (suppression["content_hash"], parser_version, mapping_version)
        )
    ]
    entries.append(suppression)
    updated["reconciliation_suppressed"] = entries
    # A needs-review marker cannot coexist with the user's explicit
    # "leave it raw" choice — drop it so the served state is plain.
    updated.pop("reconciliation_auto", None)

    served = served_canonical_bs(updated)
    return updated, served


# ── AUTO STAGE (persist seam — pipeline.stage_persist) ─────────────────


def carry_forward_reconciliation(
    new_envelope: Dict[str, Any], old_envelope: Any
) -> str:
    """SAME-FILE CARRY-FORWARD: stage_persist replaces the whole
    envelope on every run, which would drop the reconciliation state on
    a re-scan of the SAME file. Copy `reconciliation`,
    `reconciliation_history` and `reconciliation_suppressed` from the
    old envelope onto the new one when old provenance.content_hash ==
    new provenance.content_hash AND parser_version + mapping_version
    match AND the classification pack_hash matches (the snapshot key);
    drop otherwise. Pack-hash rule (Phase 3 cutover): an old envelope
    WITHOUT a pack_provenance stamp is a pre-cutover snapshot — treated
    as matching (its mapping_version half already pins the rule
    vintage); once the old side carries a hash, any mismatch with the
    new build's hash drops the state, so even a same-version pack
    content edit invalidates carry-forward. Returns an outcome string
    for the caller's log line: "carried" | "dropped_stale" |
    "nothing_to_carry". Mutates `new_envelope` in place.
    """
    if not isinstance(old_envelope, dict):
        return "nothing_to_carry"
    carry_keys = (
        "reconciliation",
        "reconciliation_history",
        "reconciliation_suppressed",
    )
    if not any(isinstance(old_envelope.get(k), (dict, list)) for k in carry_keys):
        return "nothing_to_carry"
    old_key = _envelope_key(old_envelope)
    new_key = _envelope_key(new_envelope)
    if not old_key[0] or not new_key[0] or old_key != new_key:
        return "dropped_stale"
    old_pack_hash = _envelope_pack_hash(old_envelope)
    if old_pack_hash is not None and old_pack_hash != _envelope_pack_hash(new_envelope):
        return "dropped_stale"
    for k in carry_keys:
        value = old_envelope.get(k)
        if isinstance(value, (dict, list)):
            new_envelope[k] = copy.deepcopy(value)
    return "carried"


def auto_reconcile_envelope(envelope: Dict[str, Any]) -> Dict[str, Any]:
    """The FULLY AUTOMATIC reconciliation stage. Runs in
    `pipeline.stage_persist` between the canonical build and the SINGLE
    envelope write — so a freshly-scanned sub-threshold period is
    served RECONCILED from its very first fetch; the client never sees
    an intermediate unreconciled state.

    Mutates `envelope` in place and returns {"outcome": ..., ...} for
    the caller's log line. Outcomes:
      · "accepted"           — receipt written (origin deterministic |
                               llm_proposed, applied_by
                               "system:auto-reconcile"); the same
                               persist that writes the envelope writes
                               the reconciliation.
      · "needs_review"       — diagnosis inconclusive + AI unavailable/
                               failed, or the validator rejected the
                               proposal: envelope untouched except the
                               `reconciliation_auto` marker; the served
                               object shows honest MINOR_DRIFT +
                               needs_review: true. Calm, not an error.
      · "balanced_noop"      — ratio == 0 (or status BALANCED).
      · "above_gate"         — drift > 0.1%: no auto-fix, needs a human.
      · "already_reconciled" — carried-forward receipt for this source.
      · "suppressed"         — an explicit undo suppressed auto for this
                               content_hash + versions.
      · "public_summary_refused" — PS1 structural refusal: the envelope
                               is a reduced open-data filing
                               (public_summary); reconciliation (and
                               its AI proposal path) never engages,
                               checked FIRST on the document class so
                               the refusal survives any canonical_bs-
                               shaped block attached for convenience.
      · "not_minor_drift" / "llm_extraction" / "no_canonical_bs" /
        "no_provenance"      — out of scope for the auto stage.
    Never raises (a reconcile bug must not break the pipeline persist).
    """
    try:
        # PS1 — document-class refusal FIRST (a return, never a raise:
        # this function's whole body is a never-raises try).
        if is_public_summary_envelope(envelope):
            return {"outcome": "public_summary_refused"}
        cbs = envelope.get("canonical_bs") if isinstance(envelope, dict) else None
        if not isinstance(cbs, dict) or not isinstance(cbs.get("totals"), dict):
            return {"outcome": "no_canonical_bs"}

        status = str(cbs.get("status") or "")
        diff_cents = _cents(cbs.get("difference"))
        if status == "BALANCED" or diff_cents == 0:
            return {"outcome": "balanced_noop"}
        if status != "MINOR_DRIFT":
            return {"outcome": "not_minor_drift", "status": status}
        # LLM-extracted numbers have no trustworthy source cents to
        # close against (their status can never even be BALANCED) — the
        # auto stage stays out; the ops/manual POST remains available.
        method = str((cbs.get("extraction") or {}).get("method") or "")
        if method and method != "deterministic":
            return {"outcome": "llm_extraction"}

        provenance_hash, parser_version, mapping_version = _envelope_key(envelope)
        if not provenance_hash:
            return {"outcome": "no_provenance"}

        stored = envelope.get("reconciliation")
        if isinstance(stored, dict) and stored.get("content_hash") == provenance_hash:
            return {"outcome": "already_reconciled"}

        totals = cbs.get("totals") or {}
        if not _gate_ok(
            diff_cents,
            _cents(totals.get("assets")),
            _cents(totals.get("equity_plus_liabilities")),
        ):
            return {"outcome": "above_gate", "difference": diff_cents / 100.0}

        suppression = _matching_suppression(envelope)
        if suppression is not None:
            return {
                "outcome": "suppressed",
                "suppressed_at": suppression.get("suppressed_at"),
            }

        try:
            receipt = _diagnose_validate_receipt(
                cbs,
                provenance_hash,
                diff_cents,
                applied_by=AUTO_APPLIED_BY,
            )
        except ReconcileRejected as rejected:
            # Honest MINOR_DRIFT — record the attempt so serving stamps
            # needs_review: true for THIS source+build. Calm skip.
            envelope["reconciliation_auto"] = {
                "content_hash": provenance_hash,
                "parser_version": parser_version,
                "mapping_version": mapping_version,
                "outcome": "needs_review",
                "reason": rejected.payload.get("status"),
                "diagnosis": rejected.payload.get("diagnosis") or [],
                "original_difference": diff_cents / 100.0,
                "attempted_at": _now_iso(),
                "attempted_by": AUTO_APPLIED_BY,
            }
            return {
                "outcome": "needs_review",
                "reason": rejected.payload.get("status"),
            }

        _store_receipt(envelope, receipt)
        served = served_canonical_bs(envelope)
        if (
            not isinstance(served, dict)
            or served.get("status") != "RECONCILED"
            or _cents(served.get("difference")) != 0
        ):
            # By construction unreachable — revert rather than persist a
            # receipt the serve path would not honor.
            envelope.pop("reconciliation", None)
            envelope["reconciliation_auto"] = {
                "content_hash": provenance_hash,
                "parser_version": parser_version,
                "mapping_version": mapping_version,
                "outcome": "needs_review",
                "reason": "serve_mismatch",
                "diagnosis": _serve_mismatch().payload["diagnosis"],
                "original_difference": diff_cents / 100.0,
                "attempted_at": _now_iso(),
                "attempted_by": AUTO_APPLIED_BY,
            }
            return {"outcome": "needs_review", "reason": "serve_mismatch"}
        return {
            "outcome": "accepted",
            "origin": receipt.get("origin"),
            "diagnosis_code": receipt.get("diagnosis_code"),
            "placement": receipt.get("placement"),
            "applied_delta": receipt.get("applied_delta"),
        }
    except Exception:  # noqa: BLE001 — the persist must never break
        logger.exception("[reconcile] auto stage failed (non-fatal)")
        return {"outcome": "error"}


# ── Routes (thin DB wrappers; same auth pattern as get_period) ─────────


def register_routes(router: Any, *, require_jwt: Any) -> None:
    """Mount POST /api/period/{id}/reconcile and .../reconcile/undo on
    the pipeline router. `require_jwt` is injected from pipeline.py so
    this module never imports it back (no cycle); the period is resolved
    through the CALLER's per-user client so RLS enforces membership."""

    def _resolve(period_id: str, authorization: Optional[str]) -> str:
        """Auth + RLS visibility check; returns the caller's user id."""
        jwt = require_jwt(authorization)
        with _supabase.per_user(jwt) as client:
            rows = client.select(
                "financial_periods",
                filters={"id": "eq.%s" % period_id},
                single=True,
            )
            if not rows:
                raise HTTPException(404, "Period not found.")
            user = client.get_user(jwt) or {}
        user_id = user.get("id")
        if not user_id:
            raise HTTPException(401, "Could not resolve user from JWT.")
        return user_id

    @router.post("/api/period/{period_id}/reconcile")
    def reconcile_period(
        period_id: str,
        authorization: Optional[str] = Header(None),
    ) -> Dict[str, Any]:
        """Explicit ops/manual trigger (the FE no longer renders a
        Reconcile button — the automatic persist-seam stage covers the
        product path): diagnose the drift, validate the adjustment,
        persist the receipt, return the RECONCILED serving. Clears a
        matching undo-suppression (the explicit call IS the override).
        409 with {status, diagnosis} on every refusal."""
        user_id = _resolve(period_id, authorization)
        with _supabase.admin() as admin_client:
            rows = admin_client.select(
                "financial_periods",
                filters={"id": "eq.%s" % period_id},
                single=True,
            )
            period = rows[0] if rows else None
            envelope = (period or {}).get("assembled_canonical_v1")
            if not isinstance(envelope, dict):
                raise HTTPException(
                    409,
                    detail={
                        "status": "inconclusive",
                        "diagnosis": [
                            {
                                "code": "NO_CANONICAL_ENVELOPE",
                                "detail": "period has no assembled_canonical_v1",
                            }
                        ],
                    },
                )
            try:
                updated_envelope, served = perform_reconcile(envelope, user_id)
            except ReconcileRejected as rejected:
                raise HTTPException(409, detail=rejected.payload)
            if updated_envelope is not envelope:
                admin_client.update(
                    "financial_periods",
                    {"assembled_canonical_v1": updated_envelope},
                    filters={"id": "eq.%s" % period_id},
                )
        return {"status": "reconciled", "canonical_bs": served}

    @router.post("/api/period/{period_id}/reconcile/undo")
    def undo_reconcile_period(
        period_id: str,
        authorization: Optional[str] = Header(None),
    ) -> Dict[str, Any]:
        """Reverse an accepted reconciliation: archive the stored entry
        under reconciliation_history (permanent audit trail), write the
        suppression entry so the auto stage never re-applies against
        this explicit choice (clears on file/version change), and serve
        the recomputed original — the TRUE source imbalance."""
        user_id = _resolve(period_id, authorization)
        with _supabase.admin() as admin_client:
            rows = admin_client.select(
                "financial_periods",
                filters={"id": "eq.%s" % period_id},
                single=True,
            )
            period = rows[0] if rows else None
            envelope = (period or {}).get("assembled_canonical_v1")
            if not isinstance(envelope, dict):
                raise HTTPException(
                    409,
                    detail={
                        "status": "rejected",
                        "diagnosis": [
                            {
                                "code": "NO_CANONICAL_ENVELOPE",
                                "detail": "period has no assembled_canonical_v1",
                            }
                        ],
                    },
                )
            try:
                updated_envelope, served = perform_undo(envelope, user_id)
            except ReconcileRejected as rejected:
                raise HTTPException(409, detail=rejected.payload)
            admin_client.update(
                "financial_periods",
                {"assembled_canonical_v1": updated_envelope},
                filters={"id": "eq.%s" % period_id},
            )
        return {"status": "undone", "canonical_bs": served}
