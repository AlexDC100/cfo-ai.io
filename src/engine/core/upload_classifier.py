"""F3.3 — Upload classifier.

At upload time, every registered country pack is asked
`detect_from_content(content, filename)` and the highest-scoring pack
is chosen. If no pack scores above the classification threshold, the
upload is routed to Review Mode (F3.4) with `country_code=None`.

The classifier does NOT do any detection of its own — it's a thin
dispatcher over the per-pack detection. Country-specific signal logic
lives inside each pack (the language patterns, account-code formats,
currency markers, VAT-ID layouts each country uses).
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Dict, List, Optional

from .country_pack import CountryAccountingPack
from .country_pack_registry import all_packs
from .types import DetectionConfidence


logger = logging.getLogger(__name__)


# Below this score, no pack is considered authoritative. Acceptance from
# the F3.3 kickoff: Romanian uploads should clear 0.95 easily;
# unsupported countries should fall below 0.90 and route to Review
# Mode. 0.50 is the don't-even-consider floor.
CLASSIFICATION_THRESHOLD = 0.50
HIGH_CONFIDENCE_THRESHOLD = 0.90


@dataclass
class ClassificationResult:
    """Outcome of asking every pack which one should handle an upload.

    `pack` is None when no pack scored above `CLASSIFICATION_THRESHOLD`
    — the caller should route to Review Mode and ask the user to
    pick a country manually (F3.4).

    `all_scores` carries every pack's score (sorted desc) so the FE
    can render a "considered packs" tooltip in the Confidence
    Indicator component.
    """
    pack: Optional[CountryAccountingPack]
    confidence: float
    detection: Optional[DetectionConfidence]
    all_scores: List[DetectionConfidence] = field(default_factory=list)
    review_mode_reasons: List[str] = field(default_factory=list)


def classify_upload(content: bytes, filename: str = "") -> ClassificationResult:
    """Ask every registered pack for a detection-confidence score; pick
    the highest. Returns a `ClassificationResult` with the winning
    pack (or None) plus every pack's score for transparency.
    """
    packs = all_packs()
    if not packs:
        # F3.1e startup gate should have prevented this; defensive.
        return ClassificationResult(
            pack=None,
            confidence=0.0,
            detection=None,
            all_scores=[],
            review_mode_reasons=[
                "No country accounting pack registered in this engine."
            ],
        )

    scores: List[tuple] = []  # (pack, DetectionConfidence)
    for p in packs:
        try:
            det = p.detect_from_content(content, filename)
            scores.append((p, det))
        except Exception:  # noqa: BLE001
            logger.exception(
                "[classify_upload] %s.detect_from_content raised; skipping",
                p.country_code,
            )

    if not scores:
        return ClassificationResult(
            pack=None,
            confidence=0.0,
            detection=None,
            all_scores=[],
            review_mode_reasons=[
                "Every registered pack's detect_from_content() raised an exception."
            ],
        )

    scores.sort(key=lambda t: t[1].confidence, reverse=True)
    best_pack, best_det = scores[0]
    all_dets = [t[1] for t in scores]

    reasons: List[str] = []
    if best_det.confidence < CLASSIFICATION_THRESHOLD:
        reasons.append(
            f"No country pack scored above the classification threshold "
            f"({CLASSIFICATION_THRESHOLD:.0%}). Best was {best_det.country_code} "
            f"at {best_det.confidence:.0%}."
        )
        return ClassificationResult(
            pack=None,
            confidence=best_det.confidence,
            detection=best_det,
            all_scores=all_dets,
            review_mode_reasons=reasons,
        )

    if best_det.confidence < HIGH_CONFIDENCE_THRESHOLD:
        reasons.append(
            f"Country detection confidence is {best_det.confidence:.0%}, "
            f"below the high-confidence threshold of "
            f"{HIGH_CONFIDENCE_THRESHOLD:.0%}. Manual confirmation "
            f"recommended."
        )

    return ClassificationResult(
        pack=best_pack,
        confidence=best_det.confidence,
        detection=best_det,
        all_scores=all_dets,
        review_mode_reasons=reasons,
    )
