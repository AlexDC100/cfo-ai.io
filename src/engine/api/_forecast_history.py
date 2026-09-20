"""What the forecast route loads before the engine runs (plan/2 B5,
plan_contract_v2 1.1, 1.4).

``load_plan_inputs`` reads the anchor period through the caller's OWN
Supabase client (RLS scopes the row; the resolved ``org_id`` filter is a
second lock, never the only one) by way of the one module-scope reader,
``engine.api.pipeline.load_period_rows``, and hands back what
``engine.forecast.levers.project_plan`` takes: the anchor payload, the prior
periods, the PlanContext and the history block. ``project_plan`` performs no
I/O; everything it reads is loaded here.

Until B7 lands no prior period is read: the history block is empty and the
notes say so (contract 1.4). An anchor whose statements cannot be rebuilt
raises StatementsRebuildError, which the route answers 409 with its
sentence; it is never swallowed into ``statements=None``.

Python 3.9 - no ``match``, no ``X | Y`` unions.
"""

from __future__ import annotations

from typing import Any, Dict, List, Tuple

__all__ = ["LINE_ITEM_COLUMNS", "load_plan_inputs"]

#: The statement_line_items columns the rebuild and the cost pools read.
LINE_ITEM_COLUMNS = "statement,bucket,ro_account_code,ro_account_name,amount"


def load_plan_inputs(jwt: str, org_id: str, period_id: str
                     ) -> Tuple[Dict[str, Any], List[Dict[str, Any]], Any, Dict[str, Any]]:
    """(anchor_payload, prior_periods, PlanContext, history block).

    Raises ``pipeline.PeriodNotFound`` when the period is not in the resolved
    workspace and ``pipeline.StatementsRebuildError`` when the anchor's
    statements cannot be rebuilt."""
    from . import _supabase
    from .pipeline import load_period_rows
    from engine.forecast.assumptions import jurisdiction_of
    from engine.forecast.levers import PlanContext
    from engine.forecast.resolve import HISTORY_NOT_READ

    with _supabase.per_user(jwt) as client:
        loaded = load_period_rows(client, period_id, org_id=org_id, rebuild=True,
                                  line_item_columns=LINE_ITEM_COLUMNS)

    row = loaded["row"]
    org = loaded["org"] or {}
    envelope = row.get("assembled_canonical_v1")
    anchor_payload = {
        "envelope": envelope,
        "statements": loaded["statements"],
        "line_items": loaded["line_items"],
        "period_end": row.get("period_end"),
        "period_label": row.get("period_label"),
        "currency": row.get("currency") or "RON",
        # contract 1.1: organizations.name, from the org row the loader read
        "company_name": org.get("name"),
    }
    jurisdiction, source = jurisdiction_of(envelope if isinstance(envelope, dict) else {})
    context = PlanContext(jurisdiction=jurisdiction, jurisdiction_source=source,
                          industry_key=org.get("industry_key"))
    history = {"held": [], "eligible": [], "excluded": [],
               "notes": [dict(HISTORY_NOT_READ)]}
    return anchor_payload, [], context, history
