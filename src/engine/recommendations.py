"""Recommendation generator + reconciler.

A `Decision` is a stateless classification produced by the rules engine on
every run. A `Recommendation` is what the CFO actually sees, owns, approves,
and closes — it persists across runs.

This module:
  1. Translates fresh decisions into recommendation candidates.
  2. Reconciles candidates against the existing open queue:
       - same target + same bucket  → update in place (option A: auto-update)
       - same target + new bucket    → archive old, create new (option B: replace)
       - decision no longer fires    → mark old as 'done' (auto-resolved)

Estimates of cash and margin impact are deliberately rough — the action
generator's job is to surface a number good enough for triage, not a board-
grade financial model. Refinement comes when the user supplies SKU-level WOCA.
"""

from __future__ import annotations

import hashlib
from datetime import date, datetime, timedelta
from typing import Dict, Iterable, List, Optional, Tuple

from .config import Config
from .models import (
    ActionType,
    Decision,
    Recommendation,
    RecommendationStatus,
    Urgency,
)


# ─── Decision → Recommendation translation ───────────────────────────────


def _action_for(decision: Decision) -> str:
    """Map (bucket, reason) to an action_type."""
    bucket = decision.bucket
    reason = decision.reason or ""

    if bucket == "LIQUIDATE":
        return ActionType.LIQUIDATE
    if bucket == "REDUCE":
        return ActionType.REDUCE_REORDER_QTY
    if bucket == "FIX":
        if "thin_margin" in reason or "thin_real_margin" in reason:
            if "high_volume" in reason:
                return ActionType.RENEGOTIATE_SUPPLIER
            return ActionType.RENEGOTIATE_SUPPLIER
        return ActionType.INCREASE_PRICE
    if bucket == "SCALE":
        return ActionType.SCALE_PURCHASING
    if bucket == "PROTECT":
        return ActionType.PROTECT_ANCHOR
    if bucket == "WATCH":
        return ActionType.REVIEW_MANUALLY
    return ActionType.REVIEW_MANUALLY


def _urgency_for(decision: Decision) -> str:
    """Heuristic urgency. CRITICAL for negative real margin or large cash drag."""
    if decision.flag == "ELIMINATE" and decision.real_margin_pct < 0:
        return Urgency.CRITICAL
    if decision.bucket == "LIQUIDATE":
        return Urgency.HIGH
    if decision.bucket in ("FIX", "REDUCE"):
        return Urgency.MEDIUM
    if decision.bucket == "SCALE":
        return Urgency.LOW
    return Urgency.LOW


def _expected_cash_impact(decision: Decision) -> Optional[float]:
    """Best estimate of working capital recoverable, in kRON."""
    if decision.capital_freed_kron is not None:
        return decision.capital_freed_kron
    if decision.bucket == "REDUCE" and decision.capital_trapped_kron:
        # Throttling reorder typically frees ~30% of trapped capital
        return round(decision.capital_trapped_kron * 0.3, 2)
    if decision.bucket == "LIQUIDATE" and decision.capital_trapped_kron:
        return round(decision.capital_trapped_kron, 2)
    return None


def _expected_margin_impact(decision: Decision) -> Optional[float]:
    """For FIX actions, estimate margin lift if action succeeds."""
    if decision.bucket != "FIX":
        return None
    if decision.real_margin_pct < 0:
        return abs(decision.real_margin_pct) + 2.0
    return 2.0  # default 2pp uplift assumption for renegotiation


def _due_date_for(urgency: str, today: date) -> date:
    return today + {
        Urgency.CRITICAL: timedelta(days=2),
        Urgency.HIGH: timedelta(days=7),
        Urgency.MEDIUM: timedelta(days=14),
        Urgency.LOW: timedelta(days=30),
    }.get(urgency, timedelta(days=14))


def _title_for(decision: Decision) -> str:
    """Short imperative title for the Decisions queue."""
    bucket = decision.bucket
    name = decision.id
    if bucket == "LIQUIDATE":
        return f"Liquidate {name}"
    if bucket == "REDUCE":
        return f"Reduce reorder for {name}"
    if bucket == "FIX":
        if "high_volume" in (decision.reason or ""):
            return f"Renegotiate {name} (urgent)"
        return f"Renegotiate or reprice {name}"
    if bucket == "SCALE":
        return f"Scale purchasing for {name}"
    if bucket == "PROTECT":
        return f"Hold {name} (anchor)"
    if bucket == "WATCH":
        return f"Review {name}"
    return f"Review {name}"


def _explanation_for(decision: Decision, cfg: Config) -> str:
    """Plain-language reason that references the rule and the numbers.

    Grounds the AI surface in concrete metrics so the CFO can defend any
    action they take. Format: "<bucket>. <metric quote>. <rule hint>."
    """
    parts: List[str] = []
    parts.append(
        f"Real margin {decision.real_margin_pct:.1f}% on volume "
        f"{decision.volume_tons:.1f}t (DIO {decision.dio_days}d)."
    )

    reason = decision.reason
    if reason == "real_margin_negative":
        parts.append("Every unit sold loses money after working capital cost.")
    elif reason == "thin_real_margin":
        parts.append(
            f"Real margin below the {cfg.warning.thin_real_margin_max_pct:.1f}% "
            f"warning threshold."
        )
    elif reason == "thin_margin_high_volume":
        parts.append(
            f"High volume but thin margin — "
            f"{cfg.warning.thin_real_margin_max_pct:.1f}% threshold breached "
            f"with significant working capital exposed."
        )
    elif reason == "capital_trap":
        parts.append(
            f"DIO above {cfg.eliminate.dio_capital_trap}d combined with "
            f"weak real margin — capital trapped without return."
        )
    elif reason == "long_dio":
        parts.append(
            f"DIO above {cfg.warning.long_dio_days}d — inventory turnover "
            f"is degrading. Watch closely."
        )
    elif reason == "high_volume_anchor_below_floor":
        parts.append(
            f"Anchor protection still applies, but real margin is below the "
            f"{cfg.anchor.high_volume_anchor_floor_pct:.1f}% high-volume floor."
        )
    elif reason and reason.startswith("micro"):
        parts.append("Volume and absolute profit both below worth-keeping floors.")
    elif decision.bucket == "SCALE":
        parts.append("Strong real margin and velocity — capital deserves to move here.")
    elif decision.bucket == "PROTECT":
        parts.append("Strategic anchor — do not auto-touch.")
    return " ".join(parts)


def _decision_hash(decision: Decision) -> str:
    """Stable hash of the decision-shaping inputs.

    Two recommendations with the same hash describe the same situation;
    the reconciler can skip touching the existing record. Hash only the
    fields that drive the action — not display fields like context.
    """
    payload = (
        f"{decision.id}|{decision.bucket}|{decision.flag}|{decision.reason}|"
        f"{decision.real_margin_pct:.2f}|{decision.volume_tons:.2f}|"
        f"{decision.abs_profit_kron:.2f}|{decision.dio_days}"
    )
    return hashlib.sha256(payload.encode()).hexdigest()[:16]


def decision_to_recommendation(
    decision: Decision,
    cfg: Config,
    today: Optional[date] = None,
) -> Recommendation:
    """Translate one Decision into a fresh Recommendation candidate."""
    today = today or date.today()
    urgency = _urgency_for(decision)
    return Recommendation(
        target_type=decision.level,
        target_id=decision.id,
        bucket=decision.bucket,
        action_type=_action_for(decision),
        title=_title_for(decision),
        explanation=_explanation_for(decision, cfg),
        expected_cash_impact_kron=_expected_cash_impact(decision),
        expected_margin_impact_pct=_expected_margin_impact(decision),
        urgency=urgency,
        status=RecommendationStatus.NEW,
        due_date=_due_date_for(urgency, today),
        decision_hash=_decision_hash(decision),
    )


# ─── Reconciliation against the persisted queue ──────────────────────────


def reconcile(
    fresh: List[Recommendation],
    existing: Iterable[Recommendation],
) -> Tuple[List[Recommendation], List[Recommendation], List[Recommendation]]:
    """Diff fresh candidates against the existing open queue.

    Returns three lists:
      to_insert  — brand-new recommendations
      to_update  — existing rows whose bucket is unchanged but numbers moved
      to_archive — existing rows superseded by a new bucket OR no longer fired
                   (the caller decides whether to mark them 'archived' or 'done')

    Reconciliation policy (option A primary, B available):
      - same (target_type, target_id) + same bucket → update in place
      - same target + new bucket → archive old, insert new (set superseded_by)
      - target gone from fresh → archive existing as 'done' (auto-resolved)
    """
    fresh_by_target: Dict[Tuple[str, str], Recommendation] = {
        (r.target_type, r.target_id): r for r in fresh
    }
    existing_by_target: Dict[Tuple[str, str], Recommendation] = {
        (r.target_type, r.target_id): r
        for r in existing
        if r.status not in (RecommendationStatus.DONE,
                            RecommendationStatus.REJECTED,
                            RecommendationStatus.ARCHIVED)
    }

    to_insert: List[Recommendation] = []
    to_update: List[Recommendation] = []
    to_archive: List[Recommendation] = []

    for key, fresh_rec in fresh_by_target.items():
        old = existing_by_target.get(key)
        if old is None:
            to_insert.append(fresh_rec)
            continue
        if old.decision_hash == fresh_rec.decision_hash:
            # Nothing material changed — leave as-is
            continue
        if old.bucket == fresh_rec.bucket:
            # Same bucket, refresh numbers (option A: auto-update)
            updated = old.model_copy(update={
                "explanation": fresh_rec.explanation,
                "expected_cash_impact_kron": fresh_rec.expected_cash_impact_kron,
                "expected_margin_impact_pct": fresh_rec.expected_margin_impact_pct,
                "urgency": fresh_rec.urgency,
                "decision_hash": fresh_rec.decision_hash,
                "updated_at": datetime.utcnow(),
            })
            to_update.append(updated)
        else:
            # Bucket changed (option B: archive + replace)
            archived = old.model_copy(update={
                "status": RecommendationStatus.ARCHIVED,
                "closed_at": datetime.utcnow(),
            })
            to_archive.append(archived)
            to_insert.append(fresh_rec)

    # Anything in existing that didn't appear in fresh has resolved on its own
    for key, old in existing_by_target.items():
        if key not in fresh_by_target:
            resolved = old.model_copy(update={
                "status": RecommendationStatus.DONE,
                "closed_at": datetime.utcnow(),
            })
            to_archive.append(resolved)

    return to_insert, to_update, to_archive


def generate_recommendations(
    decisions: List[Decision],
    cfg: Config,
    today: Optional[date] = None,
) -> List[Recommendation]:
    """Translate a list of decisions to fresh recommendation candidates.

    Filters out PROTECT and WATCH-with-no-issue cases unless they actually
    require attention — the queue should only show decisions that need a
    human. PROTECT items still produce a 'hold' entry so the CFO sees what
    is being protected, but with low urgency.
    """
    today = today or date.today()
    out: List[Recommendation] = []
    for d in decisions:
        # Skip pure KEEP-style WATCH decisions with healthy real margin —
        # surfacing them just adds noise.
        if d.bucket == "WATCH" and d.flag == "KEEP" and d.real_margin_pct >= 5.0:
            continue
        out.append(decision_to_recommendation(d, cfg, today=today))
    return out
