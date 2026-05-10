"""Power BI dataset export — flatten daily-decisions JSON into a tabular file.

Power BI ingests parquet natively (and CSV); a single flat table per run keeps
the downstream model simple. Schema matches what the Power BI dashboard team
will import via Get Data → Parquet/Folder.

One row per (run_date, category) — same shape as `daily_decisions` table in PG,
so PBI can choose either source.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List

import pandas as pd


# Output column order — pinned so the PBI report doesn't break on column reorder.
_COLUMNS: List[str] = [
    "run_date",
    "data_period",
    "category",
    "level",
    "flag",
    "reason",
    "recommendation",
    "real_margin_pct",
    "volume_tons",
    "abs_profit_kron",
    "dio_days",
    "do_not_eliminate",
    "capital_freed_kron",
    "alert_reason",
    "context",
    "cost_of_capital_pct",
]


# Output groups in the JSON payload that contain decisions.
_FLAG_GROUPS = (
    "anchor",
    "anchor_alerts",
    "anchor_review",
    "eliminate",
    "warning",
    "scale",
    "keep",
)


def flatten(payload: Dict[str, Any]) -> pd.DataFrame:
    """Flatten a daily-decisions JSON into a one-row-per-decision DataFrame."""
    run_date = payload["run_date"]
    data_period = payload.get("data_period", "")
    coc = payload.get("config_used", {}).get("cost_of_capital_pct")

    rows: List[Dict[str, Any]] = []
    for group in _FLAG_GROUPS:
        for d in payload.get(group, []):
            rows.append({
                "run_date": run_date,
                "data_period": data_period,
                "category": d.get("id"),
                "level": d.get("level", "category"),
                "flag": _group_to_flag(group),
                "reason": d.get("reason"),
                "recommendation": d.get("recommendation"),
                "real_margin_pct": d.get("real_margin_pct"),
                "volume_tons": d.get("volume_tons"),
                "abs_profit_kron": d.get("abs_profit_kron"),
                "dio_days": d.get("dio_days"),
                "do_not_eliminate": d.get("do_not_eliminate", False),
                "capital_freed_kron": d.get("capital_freed_kron"),
                "alert_reason": d.get("alert_reason"),
                "context": d.get("context"),
                "cost_of_capital_pct": coc,
            })

    df = pd.DataFrame(rows, columns=_COLUMNS)
    df["run_date"] = pd.to_datetime(df["run_date"])
    return df


def export_parquet(payload: Dict[str, Any], output_dir: Path) -> Path:
    """Write the flattened DataFrame to parquet. Power BI prefers this format."""
    df = flatten(payload)
    output_dir.mkdir(parents=True, exist_ok=True)
    out_path = output_dir / f"decisions_{payload['run_date']}.parquet"
    df.to_parquet(out_path, index=False)
    return out_path


def export_csv(payload: Dict[str, Any], output_dir: Path) -> Path:
    df = flatten(payload)
    output_dir.mkdir(parents=True, exist_ok=True)
    out_path = output_dir / f"decisions_{payload['run_date']}.csv"
    df.to_csv(out_path, index=False)
    return out_path


def _group_to_flag(group: str) -> str:
    return {
        "anchor": "ANCHOR",
        "anchor_alerts": "ANCHOR_ALERT",
        "anchor_review": "ANCHOR_REVIEW",
        "eliminate": "ELIMINATE",
        "warning": "WARNING",
        "scale": "SCALE",
        "keep": "KEEP",
    }[group]
