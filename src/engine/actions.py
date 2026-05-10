"""Action generator — produces the daily-decisions JSON contract.

Output shape now matches the CFO AI product spec:

    {
      "company": {...},
      "executive_summary": {...},
      "decision_buckets": {protect: [], watch: [], fix: [], reduce: [], liquidate: [], scale: []},
      "recommendations": [...],
      "briefing": {...}
    }

Legacy fields (anchor / anchor_alerts / anchor_review / eliminate / warning /
scale / keep) are retained at the top level for backward compatibility with
n8n, Power BI, and existing tests. They will be removed once the frontend
migration completes.
"""

from __future__ import annotations

import json
from datetime import date
from pathlib import Path
from typing import Any, Dict, List, Optional

from .buckets import BUCKET_KEYS, Bucket
from .config import Config
from .models import CategoryMetrics, Decision, Recommendation


# Legacy flag → output group key (kept for backward compatibility)
FLAG_GROUPS: Dict[str, str] = {
    "ANCHOR": "anchor",
    "ANCHOR_ALERT": "anchor_alerts",
    "ANCHOR_REVIEW": "anchor_review",
    "ELIMINATE": "eliminate",
    "WARNING": "warning",
    "SCALE": "scale",
    "KEEP": "keep",
}


def build_output(
    decisions: List[Decision],
    metrics: List[CategoryMetrics],
    cfg: Config,
    run_date: date,
    data_period: str,
    sku_count: Optional[int] = None,
    company: Optional[Dict[str, Any]] = None,
    recommendations: Optional[List[Recommendation]] = None,
    briefing: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Build the structured JSON payload for the CFO AI frontend."""
    # Legacy flag groups
    by_flag: Dict[str, List[Dict[str, Any]]] = {v: [] for v in FLAG_GROUPS.values()}
    for d in decisions:
        group = FLAG_GROUPS.get(d.flag, "keep")
        by_flag[group].append(_decision_payload(d))

    # New CFO buckets
    by_bucket: Dict[str, List[Dict[str, Any]]] = {v: [] for v in BUCKET_KEYS.values()}
    for d in decisions:
        bkey = BUCKET_KEYS.get(Bucket(d.bucket), "watch")
        by_bucket[bkey].append(_decision_payload(d))

    summary = _executive_summary(decisions, metrics, cfg, sku_count)

    company_block = company or {
        "name": "Demo Company",
        "currency": "RON",
        "cost_of_capital": cfg.cost_of_capital_pct,
    }

    payload: Dict[str, Any] = {
        "run_date": run_date.isoformat(),
        "data_period": data_period,
        "config_used": {"cost_of_capital_pct": cfg.cost_of_capital_pct},
        "company": company_block,
        "executive_summary": summary,
        "decision_buckets": by_bucket,
        # Legacy: kept until frontend migration completes
        "summary": _legacy_summary(decisions, metrics, cfg, sku_count),
        "anchor": by_flag["anchor"],
        "anchor_alerts": by_flag["anchor_alerts"],
        "anchor_review": by_flag["anchor_review"],
        "eliminate": by_flag["eliminate"],
        "warning": by_flag["warning"],
        "scale": by_flag["scale"],
        "keep": by_flag["keep"],
    }
    if recommendations is not None:
        payload["recommendations"] = [_recommendation_payload(r) for r in recommendations]
    if briefing is not None:
        payload["briefing"] = briefing
    return payload


def write_output(payload: Dict[str, Any], output_dir: Path, filename_pattern: str) -> Path:
    """Persist payload to disk and return the file path."""
    output_dir.mkdir(parents=True, exist_ok=True)
    fname = filename_pattern.format(date=payload["run_date"])
    path = output_dir / fname
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False, default=str)
    return path


def _decision_payload(d: Decision) -> Dict[str, Any]:
    body: Dict[str, Any] = {
        "level": d.level,
        "id": d.id,
        "bucket": d.bucket,
        "real_margin_pct": d.real_margin_pct,
        "volume_tons": d.volume_tons,
        "abs_profit_kron": d.abs_profit_kron,
        "dio_days": d.dio_days,
    }
    if d.reason:
        body["reason"] = d.reason
    if d.recommendation:
        body["recommendation"] = d.recommendation
    if d.do_not_eliminate:
        body["do_not_eliminate"] = True
    if d.capital_freed_kron is not None:
        body["capital_freed_kron"] = d.capital_freed_kron
    if d.alert_reason:
        body["alert_reason"] = d.alert_reason
    if d.context:
        body["context"] = d.context
    if d.capital_trapped_kron is not None:
        body["capital_trapped_kron"] = round(d.capital_trapped_kron, 2)
    if d.roic_pct is not None:
        body["roic_pct"] = round(d.roic_pct, 2)
    if d.gmroii_pct is not None:
        body["gmroii_pct"] = round(d.gmroii_pct, 2)
    if d.gross_margin_pct is not None:
        body["gross_margin_pct"] = d.gross_margin_pct
    if d.niv_kron is not None:
        body["niv_kron"] = d.niv_kron
    if d.category is not None:
        body["category"] = d.category
    return body


def _recommendation_payload(r: Recommendation) -> Dict[str, Any]:
    return {
        "id": r.id,
        "target_type": r.target_type,
        "target_id": r.target_id,
        "bucket": r.bucket,
        "action_type": r.action_type,
        "title": r.title,
        "explanation": r.explanation,
        "expected_cash_impact_kron": r.expected_cash_impact_kron,
        "expected_margin_impact_pct": r.expected_margin_impact_pct,
        "urgency": r.urgency,
        "owner": r.owner,
        "status": r.status,
        "due_date": r.due_date.isoformat() if r.due_date else None,
        "created_at": r.created_at.isoformat() if r.created_at else None,
        "updated_at": r.updated_at.isoformat() if r.updated_at else None,
    }


def _executive_summary(
    decisions: List[Decision],
    metrics: List[CategoryMetrics],
    cfg: Config,
    sku_count: Optional[int],
) -> Dict[str, Any]:
    """The CFO-facing summary block for the Today page."""
    total_capital_trapped = sum(
        m.capital_trapped_kron or (m.niv_kron * m.dio_days / 365.0) for m in metrics
    )
    cash_recovery = sum(
        d.capital_freed_kron or 0.0
        for d in decisions
        if d.bucket in ("LIQUIDATE", "REDUCE")
    )
    # Portfolio-level real margin: weighted by NIV
    total_niv = sum(m.niv_kron for m in metrics) or 1.0
    weighted_rm = sum(m.real_margin_pct * m.niv_kron for m in metrics) / total_niv
    # Portfolio ROIC: total abs profit / total capital trapped
    total_abs_profit = sum(m.abs_profit_kron for m in metrics)
    portfolio_roic = (
        (total_abs_profit / total_capital_trapped * 100.0)
        if total_capital_trapped > 0
        else 0.0
    )

    bucket_counts = {key: 0 for key in BUCKET_KEYS.values()}
    for d in decisions:
        bkey = BUCKET_KEYS.get(Bucket(d.bucket), "watch")
        bucket_counts[bkey] = bucket_counts.get(bkey, 0) + 1

    urgent = bucket_counts.get("liquidate", 0) + bucket_counts.get("fix", 0)

    return {
        # In kRON because the engine works in kRON throughout. Frontend
        # multiplies by 1000 if it needs RON; cleaner than mixing units here.
        "cash_trapped_kron": round(total_capital_trapped, 2),
        "cash_recovery_potential_kron": round(cash_recovery, 2),
        "roic_pct": round(portfolio_roic, 2),
        "real_margin_pct": round(weighted_rm, 2),
        "products_analyzed": sku_count if sku_count is not None else len(decisions),
        "categories_analyzed": len(decisions),
        "urgent_actions": urgent,
        "bucket_counts": bucket_counts,
    }


def _legacy_summary(
    decisions: List[Decision],
    metrics: List[CategoryMetrics],
    cfg: Config,
    sku_count: Optional[int],
) -> Dict[str, Any]:
    """Pre-CFO-AI summary shape — kept until n8n + Power BI cut over."""
    counts = {flag: 0 for flag in FLAG_GROUPS}
    for d in decisions:
        counts[d.flag] = counts.get(d.flag, 0) + 1

    total_woca = sum(m.niv_kron * m.dio_days / 365.0 for m in metrics)
    total_abs_profit = sum(m.abs_profit_kron for m in metrics)
    capital_recoverable = sum(
        (d.capital_freed_kron or 0.0) for d in decisions if d.flag == "ELIMINATE"
    )
    roic_pct = (total_abs_profit / total_woca * 100.0) if total_woca else 0.0

    return {
        "total_categories_analyzed": len(decisions),
        "total_skus_analyzed": sku_count if sku_count is not None else 0,
        "capital_blocked_RON": round(total_woca * 1000, 0),
        "capital_recoverable_30d_RON": round(capital_recoverable * 1000, 0),
        "anchors_count": counts.get("ANCHOR", 0)
        + counts.get("ANCHOR_ALERT", 0)
        + counts.get("ANCHOR_REVIEW", 0),
        "anchors_with_alerts": counts.get("ANCHOR_ALERT", 0),
        "eliminate_count": counts.get("ELIMINATE", 0),
        "warning_count": counts.get("WARNING", 0),
        "scale_count": counts.get("SCALE", 0),
        "keep_count": counts.get("KEEP", 0),
        "total_roic_pct": round(roic_pct, 1),
        "cost_of_capital_pct": cfg.cost_of_capital_pct,
    }
