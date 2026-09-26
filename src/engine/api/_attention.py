"""Helpers for GET /api/period/{id}/attention (the route sits in pipeline.py
beside /comparatives and /sector-benchmark, because only `get_period` serves
the statements every figure is read from).

THE PRIOR. "Which period is the comparison" is answered here, with the
caller's organization IN EVERY FILTER — the candidate periods and the
documents that make a period listable — so the answer can never name another
tenant's period. The rule itself is `engine.attention.sources.same_length_prior`
(the dashboard's default comparison, owned by the engine since this route):
the same company's immediately preceding period of the same length, among
the periods that carry a live financial document (exactly the periods the
dashboard's period list shows).

`requested` is the route's optional `prior` query: absent or "auto" -> the
rule; "none" -> the comparison is switched off (the reader's own choice on
the dashboard), the rule still answered as `available_period_id` so the
"compare" action can turn it back on; any other value -> that period id,
loaded with the org in the filter like /comparatives' own `prior`.
"""
from __future__ import annotations

from typing import Any, Dict, List, Mapping, Optional, Tuple

from engine.attention.sources import same_length_prior

from ._comparatives import ComparativesRefused, load_period_in_org

__all__ = ["PRIOR_RULE", "resolve_prior", "listable_periods"]

PRIOR_RULE = "same_company_previous_period_same_length"

_PERIOD_COLUMNS = "id,org_id,period_start,period_end"


def listable_periods(client: Any, current_row: Mapping[str, Any], *, org_id: str
                     ) -> List[Dict[str, Any]]:
    """The workspace's periods that close BEFORE the current one and carry
    at least one live financial document — the dashboard lists no other
    (frontend/lib/orgPeriods.ts drops a period with no document)."""
    end = str(current_row.get("period_end") or "")[:10]
    if len(end) != 10:
        return []
    rows = client.select(
        "financial_periods",
        filters={"org_id": "eq.%s" % org_id, "period_end": "lt.%s" % end},
        columns=_PERIOD_COLUMNS) or []
    ids = sorted({str(r["id"]) for r in rows if r.get("id") and r.get("id") != current_row.get("id")})
    if not ids:
        return []
    docs = client.select(
        "documents",
        filters={"org_id": "eq.%s" % org_id, "scope": "eq.financial",
                 "deleted_at": "is.null", "period_id": "in.(%s)" % ",".join(ids)},
        columns="id,period_id") or []
    with_docs = {str(d.get("period_id")) for d in docs if d.get("period_id")}
    return [dict(r) for r in rows if str(r.get("id")) in with_docs]


def _described(row: Optional[Mapping[str, Any]]) -> Dict[str, Any]:
    if not row:
        return {"period_id": None, "period_start": None, "period_end": None}
    return {"period_id": row.get("id"), "period_start": row.get("period_start"),
            "period_end": row.get("period_end")}


def resolve_prior(client: Any, current_row: Mapping[str, Any], *, org_id: str,
                  requested: Optional[str]) -> Tuple[Dict[str, Any], Optional[Dict[str, Any]]]:
    """(prior description, prior period row or None). Raises
    ComparativesRefused for an explicit id outside the workspace (404) or
    equal to the current period (400)."""
    ask = (requested or "auto").strip() or "auto"
    base = {"rule": PRIOR_RULE, "requested": ask, "reason": None,
            "available_period_id": None, "available_period_end": None}
    if ask not in ("auto", "none"):
        if ask == current_row.get("id"):
            raise ComparativesRefused("same_period", "A period cannot be compared with itself.",
                                      status=400)
        row = load_period_in_org(client, ask, org_id=org_id)
        return dict(base, status="found", **_described(row)), dict(row)
    found = same_length_prior(listable_periods(client, current_row, org_id=org_id), current_row)
    if ask == "none":
        out = dict(base, status="off", **_described(None))
        out["available_period_id"] = found.get("id") if found else None
        out["available_period_end"] = found.get("period_end") if found else None
        return out, None
    if found is None:
        return dict(base, status="absent", reason={
            "code": "no_same_length_prior",
            "inputs": [str(current_row.get("period_start") or ""),
                       str(current_row.get("period_end") or "")]}, **_described(None)), None
    # The row as the comparatives route loads it: org in the filter.
    row = load_period_in_org(client, str(found["id"]), org_id=org_id)
    return dict(base, status="found", **_described(row)), dict(row)
