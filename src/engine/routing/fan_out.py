"""F4.4 fan-out routing implementation.

Routes an upload through one of three paths based on classifier
confidence, scored coverage of each candidate pack's assembled output.

Thresholds (operator decision 3d, locked F3.15):
  - HIGH_CONFIDENCE = 0.85   → fast path, single pack
  - MEDIUM_CONFIDENCE = 0.60 → fan-out to top 2, pick cleanest
  - <0.60                    → operator-required (no auto-pick)

Coverage scoring (when assembled output is available):
    coverage_score = (1 - unmapped_amount_pct/100) × (1 - bs_drift_pct/10)
Higher is better. Both subterms clamped to [0, 1] so a 100% unmapped
result OR a 10%+ drift give 0; anything between is monotonically
decreasing in unmapped/drift.

This module is read-only: it never persists, never mutates upstream
inputs. The caller (pipeline.py) consumes RoutingResult to drive
downstream assembly + metric computation.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional

from ..core.country_pack import CountryAccountingPack
from ..core.country_pack_registry import all_packs, get_pack
from ..core.upload_classifier import (
    ClassificationResult,
    CLASSIFICATION_THRESHOLD,
)

logger = logging.getLogger(__name__)


# ── Thresholds (operator decision 3d) ────────────────────────────────
HIGH_CONFIDENCE = 0.85
MEDIUM_CONFIDENCE = 0.60


class RoutingMode(str, Enum):
    FAST_PATH = "fast_path"
    FAN_OUT = "fan_out"
    OPERATOR_REQUIRED = "operator_required"


@dataclass
class PackCandidate:
    """One pack considered during routing. The chosen one carries
    `chosen=True`; others are kept for the audit trail."""
    pack_id: str
    detection_confidence: float
    assembled_bs_drift_pct: float = 0.0
    unmapped_accounts: int = 0
    unmapped_amount_pct: float = 0.0
    coverage_score: float = 0.0
    assembled: Optional[Dict[str, Any]] = None
    chosen: bool = False
    error: Optional[str] = None
    evidence: List[str] = field(default_factory=list)


@dataclass
class RoutingResult:
    """Outcome of fan-out routing — what the pipeline consumes."""
    mode: RoutingMode
    chosen_pack: Optional[CountryAccountingPack]
    chosen_assembled: Optional[Dict[str, Any]]
    candidates_evaluated: List[PackCandidate]
    operator_choice_required: bool
    classification: ClassificationResult
    notes: List[str] = field(default_factory=list)


# ──────────────────────────────────────────────────────────────────────
# Public entry point
# ──────────────────────────────────────────────────────────────────────


def route_with_fan_out(
    classification: ClassificationResult,
    content: bytes,
    filename: str,
    *,
    company_name: str = "Entity",
    currency: str = "RON",
    period_label: str = "",
    industry: Optional[str] = None,
) -> RoutingResult:
    """Run the 3d routing decision and return what downstream needs.

    For HIGH confidence: assembles once with the classifier's chosen pack.
    For MEDIUM: assembles with top-2, picks cleanest by coverage_score.
    For LOW: returns top-3 evidence WITHOUT assembling; operator must pick.
    """
    notes: List[str] = []

    # ── Defensive: no pack registered or classifier flatlined ──
    if classification.pack is None and not classification.all_scores:
        notes.append("classifier produced no candidates; operator action required")
        return RoutingResult(
            mode=RoutingMode.OPERATOR_REQUIRED,
            chosen_pack=None, chosen_assembled=None,
            candidates_evaluated=[],
            operator_choice_required=True,
            classification=classification, notes=notes,
        )

    confidence = float(classification.confidence or 0.0)

    # ── HIGH: fast path ────────────────────────────────────────
    if confidence >= HIGH_CONFIDENCE and classification.pack is not None:
        cand = _assemble_one_candidate(
            classification.pack, confidence, content, filename,
            company_name=company_name, currency=currency,
            period_label=period_label, industry=industry,
        )
        cand.chosen = True
        return RoutingResult(
            mode=RoutingMode.FAST_PATH,
            chosen_pack=classification.pack,
            chosen_assembled=cand.assembled,
            candidates_evaluated=[cand],
            operator_choice_required=False,
            classification=classification,
            notes=["high_confidence_fast_path"],
        )

    # ── MEDIUM: fan-out to top 2 ──────────────────────────────
    if confidence >= MEDIUM_CONFIDENCE:
        top_n = _resolve_top_n_packs(classification, n=2)
        if not top_n:
            notes.append("medium confidence but no resolvable packs; falling through to operator_required")
            return _operator_required_result(classification, notes)
        candidates: List[PackCandidate] = []
        for pack, det_conf in top_n:
            candidates.append(_assemble_one_candidate(
                pack, det_conf, content, filename,
                company_name=company_name, currency=currency,
                period_label=period_label, industry=industry,
            ))
        # If only one pack actually resolved (e.g. single-pack engine),
        # collapse to fast_path semantics with one candidate.
        if len(candidates) == 1:
            candidates[0].chosen = True
            notes.append("single_pack_collapse_to_fast_path")
            return RoutingResult(
                mode=RoutingMode.FAST_PATH,
                chosen_pack=candidates[0].assembled and _pack_or_none(candidates[0].pack_id),
                chosen_assembled=candidates[0].assembled,
                candidates_evaluated=candidates,
                operator_choice_required=False,
                classification=classification, notes=notes,
            )
        # All candidates errored — escalate
        if all(c.error for c in candidates):
            notes.append("all fan-out candidates errored; operator action required")
            return RoutingResult(
                mode=RoutingMode.OPERATOR_REQUIRED,
                chosen_pack=None, chosen_assembled=None,
                candidates_evaluated=candidates,
                operator_choice_required=True,
                classification=classification, notes=notes,
            )
        # Pick highest coverage_score (errors get -inf)
        candidates.sort(key=lambda c: c.coverage_score if c.error is None else float("-inf"),
                        reverse=True)
        winner = candidates[0]
        winner.chosen = True
        return RoutingResult(
            mode=RoutingMode.FAN_OUT,
            chosen_pack=_pack_or_none(winner.pack_id),
            chosen_assembled=winner.assembled,
            candidates_evaluated=candidates,
            operator_choice_required=False,
            classification=classification,
            notes=["medium_confidence_fan_out"] + notes,
        )

    # ── LOW: operator required ────────────────────────────────
    return _operator_required_result(classification, notes)


def routing_decision_dict(result: RoutingResult) -> Dict[str, Any]:
    """Shape per CANONICAL_SCHEMA_V1.md §7 — feeds into detection
    envelope's routing_decision field."""
    return {
        "mode": result.mode.value,
        "candidates_evaluated": [
            {
                "pack_id": c.pack_id,
                "detection_confidence": round(c.detection_confidence, 4),
                "assembled_bs_drift_pct": round(c.assembled_bs_drift_pct, 4),
                "unmapped_accounts": c.unmapped_accounts,
                "unmapped_amount_pct": round(c.unmapped_amount_pct, 4),
                "coverage_score": round(c.coverage_score, 4),
                "chosen": c.chosen,
                "error": c.error,
                "evidence": c.evidence,
            }
            for c in result.candidates_evaluated
        ],
        "operator_choice_required": result.operator_choice_required,
        "notes": result.notes,
    }


# ──────────────────────────────────────────────────────────────────────
# Internals
# ──────────────────────────────────────────────────────────────────────


def _resolve_top_n_packs(classification: ClassificationResult, n: int = 2
                          ) -> List[tuple]:
    """Return up to n (pack, detection_confidence) tuples from
    classification.all_scores. Skips entries whose country_code can't be
    resolved via get_pack (e.g. detected but not registered)."""
    out: List[tuple] = []
    seen: set = set()
    for det in classification.all_scores[:n * 2]:  # widen search; some may not resolve
        cc = getattr(det, "country_code", None)
        if not cc or cc in seen:
            continue
        seen.add(cc)
        pack = get_pack(cc)
        if pack is None:
            continue
        out.append((pack, float(getattr(det, "confidence", 0.0) or 0.0)))
        if len(out) >= n:
            break
    return out


def _pack_or_none(country_code: str) -> Optional[CountryAccountingPack]:
    try:
        return get_pack(country_code)
    except Exception:  # noqa: BLE001
        return None


def _assemble_one_candidate(
    pack: CountryAccountingPack, detection_confidence: float,
    content: bytes, filename: str, *,
    company_name: str, currency: str, period_label: str,
    industry: Optional[str],
) -> PackCandidate:
    """Parse + assemble one pack candidate; score by coverage."""
    cand = PackCandidate(
        pack_id=pack.country_code,
        detection_confidence=detection_confidence,
    )
    try:
        # Parse the upload via the pack's parser, then assemble.
        # Different packs may expose different parser entry points; the
        # universal pattern is `pack.parse_to_accounts(content, filename)`
        # followed by `pack.assemble_statements(accounts, **)`.
        accounts: List[Dict[str, Any]] = []
        parser = getattr(pack, "parse_to_accounts", None)
        if callable(parser):
            accounts = parser(content, filename)
        else:
            # Fallback: pack's trial_balance_parser direct call (RO pack pattern).
            tbp = getattr(pack, "trial_balance_parser", None)
            if tbp is not None:
                rows = tbp.parse_trial_balance_file(content, filename)
                accounts = tbp.accounts_to_assemble_shape(rows)
            else:
                cand.error = f"pack {pack.country_code} has no parse_to_accounts or trial_balance_parser"
                cand.evidence.append(cand.error)
                return cand
        assembled = pack.assemble_statements(
            accounts, company_name=company_name, currency=currency,
            period_label=period_label, industry=industry,
        )
        cand.assembled = assembled

        # Score: bs_drift + unmapped
        statements = (assembled or {}).get("statements") or {}
        bs = statements.get("assembled_bs") or {}
        total_assets = float(bs.get("total_assets") or 0.0)
        bs_delta = float(bs.get("bs_balance_delta") or 0.0)
        unmapped = assembled.get("unmapped") or []
        unmapped_amt = sum(abs(float(u.get("amount") or 0)) for u in unmapped
                            if isinstance(u, dict))
        cand.unmapped_accounts = len(unmapped)
        if total_assets > 0:
            cand.assembled_bs_drift_pct = abs(bs_delta) / total_assets * 100
            cand.unmapped_amount_pct = unmapped_amt / total_assets * 100
        # Coverage score per design: clamp each subterm to [0, 1].
        drift_term = max(0.0, 1.0 - (cand.assembled_bs_drift_pct / 10.0))
        coverage_term = max(0.0, 1.0 - (cand.unmapped_amount_pct / 100.0))
        cand.coverage_score = drift_term * coverage_term
        cand.evidence.append(
            f"bs_drift={cand.assembled_bs_drift_pct:.2f}% "
            f"unmapped={cand.unmapped_accounts} "
            f"coverage={cand.coverage_score:.4f}"
        )
    except Exception as e:  # noqa: BLE001
        logger.exception("[routing.fan_out] pack %s assembly raised", pack.country_code)
        cand.error = f"{type(e).__name__}: {e}"
        cand.evidence.append(cand.error)
    return cand


def _operator_required_result(classification: ClassificationResult,
                               notes: List[str]) -> RoutingResult:
    """Build a no-auto-pick result with top-3 detection-only candidates."""
    candidates: List[PackCandidate] = []
    for det in classification.all_scores[:3]:
        cc = getattr(det, "country_code", None) or ""
        candidates.append(PackCandidate(
            pack_id=cc,
            detection_confidence=float(getattr(det, "confidence", 0.0) or 0.0),
            evidence=[f"detection_only (no assembly attempted at low confidence)"],
        ))
    notes.append(f"low_confidence_operator_required (best={classification.confidence:.2%})")
    return RoutingResult(
        mode=RoutingMode.OPERATOR_REQUIRED,
        chosen_pack=None, chosen_assembled=None,
        candidates_evaluated=candidates,
        operator_choice_required=True,
        classification=classification,
        notes=notes,
    )
