"""F4.3 detection envelope builder.

Composes the §7 contract envelope from existing inputs:
  - ClassificationResult (from upload_classifier)
  - ConfidenceReport (from confidence_engine)
  - Assembled engine output (for source_data_quality + bs_balance_delta)
  - The active methodology_id (e.g. "ro_ras_2025_v1")

The envelope is a plain dict (JSON-serializable) so it can be persisted
in `financial_periods.detection_envelope` (JSONB column) and surfaced
on read paths without further transformation.

Fan-out routing details (CANONICAL_SCHEMA_V1.md §7's `routing_decision`
field) are populated later by F4.4. This builder fills in a `null`
routing_decision when called before fan-out routing exists.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional


DETECTION_ENVELOPE_VERSION = "1.0.0"


def build_detection_envelope(
    classification: Optional[Any] = None,
    assembled: Optional[Dict[str, Any]] = None,
    methodology_id: Optional[str] = None,
    industry_key: Optional[str] = None,
    caen_code: Optional[str] = None,
    routing_decision: Optional[Dict[str, Any]] = None,
    period_start: Optional[str] = None,
    period_end: Optional[str] = None,
    currency: Optional[str] = None,
) -> Dict[str, Any]:
    """Build a §7-compliant detection envelope.

    Arguments are all optional — the builder gracefully fills in
    sentinels (None / empty string / empty list) for fields that the
    available inputs can't supply. This lets the pipeline call the
    builder at any stage without per-stage guards.

    Returns a JSON-serializable dict shaped per CANONICAL_SCHEMA_V1.md §7.
    """
    # ── Country detection ────────────────────────────────────────
    country_iso2 = ""
    country_conf = 0.0
    country_evidence: List[str] = []
    if classification is not None:
        pack = getattr(classification, "pack", None)
        det = getattr(classification, "detection", None)
        if pack is not None:
            country_iso2 = str(getattr(pack, "country_code", "") or "")
        elif det is not None:
            country_iso2 = str(getattr(det, "country_code", "") or "")
        country_conf = float(getattr(classification, "confidence", 0.0) or 0.0)
        # Evidence: pack mechanism (chart of accounts, language, layout)
        if det is not None:
            lang = getattr(det, "detected_language", None)
            if lang:
                country_evidence.append(f"language={lang}")
            layout = getattr(det, "detected_layout", None)
            if layout:
                country_evidence.append(f"layout={layout}")

    # ── Accounting standard ──────────────────────────────────────
    standard_code = ""
    standard_conf = country_conf  # default mirrors country; refine when separate signal exists
    standard_evidence: List[str] = []
    if classification is not None:
        pack = getattr(classification, "pack", None)
        det = getattr(classification, "detection", None)
        std = None
        if det is not None:
            std = getattr(det, "detected_standard", None)
        if std is None and pack is not None:
            std = getattr(pack, "accounting_standard", None)
        if std is not None:
            standard_code = str(std)
            standard_evidence.append(f"detected_via=pack={getattr(pack, 'key', 'unknown') if pack else 'classifier'}")

    # ── Document type ────────────────────────────────────────────
    doc_type_code = ""
    doc_type_conf = country_conf
    doc_type_evidence: List[str] = []
    if classification is not None:
        det = getattr(classification, "detection", None)
        if det is not None:
            dtype = getattr(det, "detected_document_type", None) or getattr(det, "document_type", None)
            if dtype:
                doc_type_code = str(dtype)

    # ── Industry ─────────────────────────────────────────────────
    industry_obj = {
        "key": str(industry_key or ""),
        "caen_code": caen_code,
        "confidence": 1.0 if industry_key else 0.0,
        "evidence": (["operator_assigned"] if industry_key else []),
    }
    # If assembled carries a detected industry (e.g. from chart_of_accounts.detect_industry),
    # promote its evidence — but keep operator-supplied key authoritative.
    if assembled is not None:
        detected_industry = (
            (assembled.get("statements") or {}).get("detected_industry")
            or assembled.get("detected_industry")
        )
        if isinstance(detected_industry, dict):
            if not industry_obj["key"]:
                industry_obj["key"] = str(detected_industry.get("key") or "")
            industry_obj["confidence"] = float(
                detected_industry.get("confidence") or industry_obj["confidence"]
            )
            ev = detected_industry.get("evidence") or detected_industry.get("reasons") or []
            if isinstance(ev, list):
                industry_obj["evidence"] = [str(e) for e in ev] + industry_obj["evidence"]

    # ── Source-data quality (F3.9, relocated per §7) ─────────────
    source_data_quality = None
    if assembled is not None:
        sq = (assembled.get("assembled_canonical_v1") or {}).get("source_data_quality")
        if sq is None:
            sq = assembled.get("source_data_quality")
        if isinstance(sq, dict):
            source_data_quality = {
                "raw_imbalance_pct": float(sq.get("raw_imbalance_pct") or 0.0),
                "raw_imbalance_abs": float(sq.get("raw_imbalance_abs") or 0.0),
                "warn": bool(sq.get("warn")),
            }

    return {
        "detection_envelope_version": DETECTION_ENVELOPE_VERSION,
        "country": {
            "iso2": country_iso2,
            "confidence": round(country_conf, 4),
            "evidence": country_evidence,
        },
        "standard": {
            "code": standard_code,
            "confidence": round(standard_conf, 4),
            "evidence": standard_evidence,
        },
        "doc_type": {
            "code": doc_type_code,
            "confidence": round(doc_type_conf, 4),
            "evidence": doc_type_evidence,
        },
        "industry": industry_obj,
        "currency": currency or "",
        "fiscal_year_end": period_end or "",
        "period_start": period_start or "",
        "period_end": period_end or "",
        "methodology_version": methodology_id or "",
        "routing_decision": routing_decision,   # populated by F4.4; null pre-fan-out
        "source_data_quality": source_data_quality,
    }
