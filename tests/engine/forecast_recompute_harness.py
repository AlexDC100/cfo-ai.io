"""Shared by the plan/2 B6 route gates: one POST or GET through the REAL
create_app, the route's own loader, statements rebuild, engine, fp1.2 builder
and boundary guard. Only ``_org.resolve_org`` and ``_supabase.per_user`` are
replaced, by the committed-book row server scripts/measure_plan_blast_radius
uses (as-built B0-6): it serves one corpus book's rows, honours eq. filters
and projects columns. It is not a tenancy wall; the gates that need one
(forecast-cache, test_cross_org_reads) use the tenancy double instead.

Python 3.9 - no ``match``, no ``X | Y`` unions.
"""
from __future__ import annotations

import hashlib
import json
from typing import Any, Dict, List, Optional, Tuple

from test_forecast_route import BOOKS, _call  # noqa: F401

BASE3 = {"horizon": {"total_years": 3, "monthly_months": 12}}
#: Every lever kind B6 accepts, in one request (3.6 lever ids in comments).
LEVERED = {
    "horizon": {"total_years": 3, "monthly_months": 12},
    "overrides": {"dividend_payout_pct": {"values": ["0.30", None, "0.10"]}},  # override:<key>
    "shocks": [
        {"id": "rail:volume_index", "driver_key": "volume_index", "op": "level_pct",
         "value": "-0.20", "start_month": 3, "ramp_months": 6},                # shock id
        {"id": "template:t:1", "driver_key": "dso_days", "op": "add_days",
         "value": "12", "group_id": "template:t", "source": "template:t"},     # group_id
        {"id": "template:t:2", "driver_key": "price_index", "op": "level_pct",
         "value": "0.03", "start_month": 7, "group_id": "template:t",
         "source": "template:t"},
    ],
    "behaviour_overrides": [{"pool": "personnel", "fixed_share": "0.5"}],       # behaviour:<pool>
    "debt_schedule": [{"year": 2, "lt_draw": "500000.00"}],                     # debt:<year>
}
LEVER_IDS = ("override:dividend_payout_pct", "rail:volume_index", "template:t",
             "behaviour:personnel", "debt:2")


def levered_for(name: str) -> Tuple[Dict[str, Any], Tuple[str, ...]]:
    """LEVERED for one book. A book that cannot price debt (no opening debt,
    so no observable borrowing rate) rightly refuses a debt row; there the
    request states the rate, which is one more lever (SYNTHETIC rate 8%)."""
    body = json.loads(json.dumps(LEVERED))
    ids = list(LEVER_IDS)
    base = post(name, BASE3)
    if base["drivers"]["interest_rate_debt"]["basis"]["tier"] == "absent":
        body["overrides"]["interest_rate_debt"] = {"values": ["0.08", "0.08", "0.08"]}
        ids.insert(1, "override:interest_rate_debt")
    return body, tuple(ids)


def post(name: str, body: Dict[str, Any]) -> Dict[str, Any]:
    status, answer = _call(name, "POST", body=body)
    assert status == 200, (name, status, str(answer)[:400])
    return answer


def without(body: Dict[str, Any], lever_id: str) -> Dict[str, Any]:
    out = json.loads(json.dumps(body))
    if lever_id.startswith("override:"):
        out["overrides"].pop(lever_id.split(":", 1)[1])
    elif lever_id.startswith("behaviour:"):
        out["behaviour_overrides"] = [b for b in out["behaviour_overrides"]
                                      if b["pool"] != lever_id.split(":", 1)[1]]
    elif lever_id.startswith("debt:"):
        out["debt_schedule"] = [r for r in out["debt_schedule"]
                                if "debt:%d" % r["year"] != lever_id]
    else:
        out["shocks"] = [s for s in out["shocks"]
                         if s["id"] != lever_id and s.get("group_id") != lever_id]
    return out


def amounts(body: Dict[str, Any]) -> Dict[Tuple[str, str], Optional[int]]:
    return dict(((f["line"], f["period"]), f.get("amount_minor"))
                for f in body["figures"])


def figures_hash(body: Dict[str, Any]) -> str:
    """Contract 12: sha256 over the canonical (line, period, amount_minor) of
    figures plus series plus summary, excluding pins, drivers, history and
    lever_ids."""
    def strip(node: Any) -> Any:
        if isinstance(node, dict):
            return dict((k, strip(v)) for k, v in node.items()
                        if k not in ("lever_ids", "driver_ids", "joint"))
        if isinstance(node, list):
            return [strip(v) for v in node]
        return node
    payload = {"figures": [[f["line"], f["period"], f.get("amount_minor")]
                           for f in body.get("figures") or []],
               "series": strip(body.get("series")), "summary": strip(body.get("summary"))}
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()
