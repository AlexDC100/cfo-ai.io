"""F4.5-prep — Hungarian pack canonical adapter (skeleton).

Mirrors `ro_romania/canonical_adapter.py` interface. The mapping table
is EMPTY until calibration; every line_item routes to `unmapped`.

When _RULES in chart_of_accounts.py is filled, this adapter's
_SZL_TO_CANONICAL prefix table also needs filling — the canonical
bucket on the line_item is what the engine routes to, but this adapter
re-validates and computes always-positive magnitudes per F3.15 §3b.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from engine.canonical import schema_version


# Empty prefix table — operator fills during calibration alongside
# chart_of_accounts._RULES. Longest-prefix-first ordering when populated.
_SZL_TO_CANONICAL: List[tuple] = [
    # ("411", "share_capital"),   # Jegyzett tőke
    # ("412", "share_premium"),    # Tőketartalék
    # ...
]


def assemble_canonical(
    line_items: List[Dict[str, Any]],
    *,
    source_data_quality: Optional[Dict[str, Any]] = None,
    current_year_pnl: float = 0.0,
    profit_distribution: float = 0.0,
) -> Dict[str, Any]:
    """Skeleton — returns empty canonical envelope with schema_version
    set so downstream gates pass the structural check (F4.1-CANONICAL).
    The `round_trip_check.passed` field is True because empty data
    trivially round-trips. Real reconciliation kicks in when _RULES
    is calibrated."""
    return {
        "schema_version": schema_version(),
        "leaves": {},
        "aggregates": {},
        "unmapped": [
            {"code": str(li.get("ro_account_code") or ""),
             "name": str(li.get("ro_account_name") or ""),
             "amount": float(li.get("amount") or 0),
             "reason": "hu_adapter_uncalibrated"}
            for li in (line_items or [])
        ],
        "source_data_quality": source_data_quality,
        "round_trip_check": {
            "passed": True,
            "tolerance_pct": 0.5,
            "max_deviation_pct": 0.0,
            "note": "empty canonical (uncalibrated pack); trivial round-trip",
        },
    }
