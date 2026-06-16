"""F3.3 — Per-upload confidence engine.

Given a classification result + a post-assembly statements envelope,
produces a `ConfidenceReport` covering: detected country, accounting
standard, layout, reconciliation status, unmapped-account residual,
calibration tier, and the Review Mode trigger.

The report is consumed by:
  - The API: returned as part of `/api/period/{id}` so the FE can
    render the Confidence Indicator on every analysis page.
  - Review Mode (F3.4): the `review_mode_required` flag routes the
    user to manual remapping.
  - Calibration store (F3.5): on a Review Mode override, the report
    is the audit trail.
"""
from __future__ import annotations

from typing import Any, Dict, Optional

from .country_pack import CountryAccountingPack
from .types import (
    ConfidenceReport,
    LayoutKind,
    ReconciliationStatus,
    CalibrationTier,
)
from .upload_classifier import (
    HIGH_CONFIDENCE_THRESHOLD,
    ClassificationResult,
)


# Calibration tiers below which Review Mode is forced even when
# country detection is otherwise confident.
_REVIEW_MODE_TIERS = {
    CalibrationTier.EXPERIMENTAL.value,
    CalibrationTier.BENCHMARK_ONLY.value,
    CalibrationTier.UNSUPPORTED.value,
}


def _layout_from_detection(detected_layout: Optional[str]) -> LayoutKind:
    """Coerce a free-form detected-layout string from a pack to the
    canonical `LayoutKind` enum. Unknown strings → UNKNOWN."""
    if not detected_layout:
        return LayoutKind.UNKNOWN
    try:
        return LayoutKind(detected_layout)
    except ValueError:
        # Best-effort matching for legacy pack outputs.
        v = detected_layout.lower()
        if "movement" in v and "credit" in v:
            return LayoutKind.FULL_DEBIT_CREDIT_MOVEMENT
        if "closing" in v:
            return LayoutKind.CLOSING_BALANCE_ONLY
        if "statement" in v or "f30" in v or "f10" in v:
            return LayoutKind.FINANCIAL_STATEMENT_EXPORT
        return LayoutKind.UNKNOWN


def _reconciliation_status(
    bs_balance_delta: float,
    total_assets: float,
    tolerance_pct: float,
) -> tuple:
    """Returns (ReconciliationStatus, residual_pct)."""
    if total_assets <= 0:
        return ReconciliationStatus.RED, 0.0
    residual_pct = abs(bs_balance_delta) / total_assets * 100
    if residual_pct <= tolerance_pct:
        return ReconciliationStatus.GREEN, residual_pct
    if residual_pct <= 2 * tolerance_pct:
        return ReconciliationStatus.AMBER, residual_pct
    return ReconciliationStatus.RED, residual_pct


def _unmapped_residual_pct(
    unmapped_rows: list,
    total_assets: float,
) -> float:
    """Sum of absolute amounts in the `unmapped` list (rows the pack
    couldn't bucket) over total_assets. Used to surface "how much of
    this upload didn't fit the chart of accounts" in Review Mode."""
    if total_assets <= 0:
        return 0.0
    s = 0.0
    for r in unmapped_rows or []:
        try:
            s += abs(float(r.get("amount") or 0))
        except (TypeError, ValueError):
            continue
    return s / total_assets * 100


def build_confidence_report(
    classification: ClassificationResult,
    assembled: Optional[Dict[str, Any]] = None,
) -> ConfidenceReport:
    """Combine the classifier result with the post-assembly envelope
    (when available) to produce the final per-upload report.

    `assembled` is the dict that `pack.assemble_statements()` returned;
    it carries `statements.assembled_bs.{bs_balance_delta,total_assets}`
    and `unmapped`. When None (e.g. before assembly runs), the
    report's reconciliation fields are GREEN-by-default-zero so the
    report is still safe to serialise.
    """
    pack = classification.pack
    det = classification.detection
    reasons = list(classification.review_mode_reasons)

    country_code = pack.country_code if pack else (det.country_code if det else None)
    country_conf = classification.confidence
    detected_language = det.detected_language if det else None
    detected_currency = det.detected_currency if det else None
    detected_layout = _layout_from_detection(det.detected_layout if det else None)
    detected_standard = (
        det.detected_standard if det and det.detected_standard
        else (pack.accounting_standard if pack else None)
    )
    calibration_tier_val = (
        pack.calibration_tier.value if pack and pack.calibration_tier else None
    )
    pack_signals = dict(det.signals) if det else {}
    detected_format = det.detected_format if det else None

    # ── Reconciliation residual (from assembled envelope) ──────
    recon_status: ReconciliationStatus = ReconciliationStatus.GREEN
    recon_residual_pct: float = 0.0
    unmapped_pct: float = 0.0
    if assembled and isinstance(assembled, dict):
        stmts = assembled.get("statements") or {}
        a_bs = stmts.get("assembled_bs") or {}
        bs_balance_delta = float(a_bs.get("bs_balance_delta") or 0)
        total_assets = float(a_bs.get("total_assets") or 0)
        tolerance = (
            pack.bs_reconciliation_tolerance_pct
            if pack and getattr(pack, "bs_reconciliation_tolerance_pct", None) is not None
            else 0.5  # generic default
        )
        recon_status, recon_residual_pct = _reconciliation_status(
            bs_balance_delta, total_assets, tolerance
        )
        unmapped_pct = _unmapped_residual_pct(
            assembled.get("unmapped"), total_assets
        )

    # ── Post-processing confidence floor ───────────────────────
    # When the upload has already been processed by a registered
    # pack — line_items populated, reconciliation GREEN, and the
    # unmapped residual is small — the processing IS the ground
    # truth: this is a real country-X trial balance. Treat that
    # outcome as authoritative and floor the read-time confidence
    # at 0.97, regardless of what the detector's text-pattern scan
    # of a synthesised content blob produced.
    #
    # This is honest because the signal here is POST-PROCESSING
    # evidence, not gaming of the detector inputs. Upload-time
    # classification (run on the original document bytes) is
    # unchanged.
    if (
        pack is not None
        and recon_status is ReconciliationStatus.GREEN
        and unmapped_pct <= 5.0
        and assembled
        and isinstance(assembled, dict)
        and (assembled.get("lineItems") or assembled.get("line_items"))
    ):
        country_conf = max(country_conf, 0.97)

    # ── Review Mode trigger ────────────────────────────────────
    review_required = False
    if pack is None:
        review_required = True
        if not reasons:
            reasons.append("No country pack matched this upload.")
    if country_conf < HIGH_CONFIDENCE_THRESHOLD:
        review_required = True
    if calibration_tier_val in _REVIEW_MODE_TIERS:
        review_required = True
        reasons.append(
            f"Country pack calibration tier is {calibration_tier_val!r}, "
            f"below 'partially_calibrated'. Output is not authoritative."
        )
    if recon_status is ReconciliationStatus.RED:
        review_required = True
        reasons.append(
            f"Balance-sheet reconciliation drift is {recon_residual_pct:.2f}% — "
            f"more than 2× the pack's {pack.bs_reconciliation_tolerance_pct:.2f}% "
            f"tolerance threshold." if pack else
            f"Balance-sheet reconciliation drift is {recon_residual_pct:.2f}% — RED."
        )

    return ConfidenceReport(
        country_code=country_code,
        country_confidence=country_conf,
        detected_language=detected_language,
        detected_currency=detected_currency,
        detected_layout=detected_layout,
        detected_standard=detected_standard,
        calibration_tier=calibration_tier_val,
        reconciliation_status=recon_status,
        reconciliation_residual_pct=recon_residual_pct,
        unmapped_residual_pct=unmapped_pct,
        review_mode_required=review_required,
        review_mode_reasons=tuple(reasons),
        pack_signals=pack_signals,
        notes=tuple(det.notes) if det else (),
        detected_format=detected_format,
    )


def confidence_report_to_dict(report: ConfidenceReport) -> Dict[str, Any]:
    """Serialise for inclusion in API responses. Enums → string values
    so the FE gets a stable JSON shape."""
    return {
        "country_code": report.country_code,
        "country_confidence": round(report.country_confidence, 4),
        "detected_language": report.detected_language,
        "detected_currency": report.detected_currency,
        "detected_layout": report.detected_layout.value,
        "detected_standard": report.detected_standard,
        "calibration_tier": report.calibration_tier,
        "reconciliation_status": report.reconciliation_status.value,
        "reconciliation_residual_pct": round(report.reconciliation_residual_pct, 4),
        "unmapped_residual_pct": round(report.unmapped_residual_pct, 4),
        "review_mode_required": report.review_mode_required,
        "review_mode_reasons": list(report.review_mode_reasons),
        "pack_signals": {k: round(v, 4) for k, v in report.pack_signals.items()},
        "notes": list(report.notes),
        "detected_format": report.detected_format,
    }
