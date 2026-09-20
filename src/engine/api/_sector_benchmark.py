"""Helpers for GET /api/period/{id}/sector-benchmark (the route itself
sits in pipeline.py beside comparatives, because only ``get_period``
serves the statements a lender-facing figure may be read from).

``find_prior_period`` answers "is there a period one year earlier IN THIS
WORKSPACE" with the organization in the filter, so the answer can never
name another tenant's period.
"""
from __future__ import annotations

from typing import Any, Dict, Optional, Tuple

PRIOR_COLUMNS = "id,org_id,period_start,period_end"


def _year_back(iso_date: Any) -> Optional[str]:
    text = str(iso_date or "")[:10]
    if len(text) != 10 or text[4] != "-" or text[7] != "-":
        return None
    try:
        year = int(text[:4])
    except ValueError:
        return None
    if text[5:] == "02-29":
        return "%04d-02-28" % (year - 1)
    return "%04d%s" % (year - 1, text[4:])


def find_prior_period(client: Any, current_row: Dict[str, Any], *, org_id: str
                      ) -> Tuple[Optional[str], Optional[Dict[str, Any]]]:
    """(prior period id, None) or (None, reason). The prior period is the
    one in the SAME workspace whose period_end is one year before the
    current period_end (and, when both carry a start, whose start is one
    year before too — a year is never compared with a month)."""
    wanted_end = _year_back(current_row.get("period_end"))
    if wanted_end is None:
        return None, {"code": "period_end_absent", "inputs": ["period_end"]}
    rows = client.select(
        "financial_periods",
        filters={"org_id": "eq.%s" % org_id, "period_end": "eq.%s" % wanted_end},
        columns=PRIOR_COLUMNS) or []
    wanted_start = _year_back(current_row.get("period_start"))
    for row in rows:
        if row.get("id") == current_row.get("id"):
            continue
        start = str(row.get("period_start") or "")[:10]
        if wanted_start and start and start != wanted_start:
            continue
        return str(row["id"]), None
    return None, {"code": "prior_period_absent", "inputs": [wanted_end]}
