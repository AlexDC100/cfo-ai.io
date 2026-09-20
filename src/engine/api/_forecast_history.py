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

import json
import threading
from collections import OrderedDict
from typing import Any, Dict, List, Tuple

__all__ = ["LINE_ITEM_COLUMNS", "cache_key", "clear_cache", "load_plan_inputs"]

#: The statement_line_items columns the rebuild and the cost pools read.
LINE_ITEM_COLUMNS = "statement,bucket,ro_account_code,ro_account_name,amount"


#: The 1.5 cache: key -> the loaded rows and rebuilt statements as ONE
#: immutable JSON byte string. A hit is deserialised into fresh objects per
#: request, so nothing a run does to its inputs can reach the cached value
#: (bytes cannot be mutated), and OpeningPosition and every FactsGateway are
#: rebuilt per request from those fresh objects, which keeps one access-log
#: line per served read. A 409 rebuild failure is never stored.
_CACHE = OrderedDict()  # type: "OrderedDict[Tuple[Any, ...], bytes]"
_CACHE_LOCK = threading.Lock()
CACHE_ENTRIES = 32


def cache_key(org_id: str, period_id: str, updated_at: Any,
              history: Tuple[Tuple[str, Any], ...] = ()) -> Tuple[Any, ...]:
    """(org_id, anchor period_id, anchor updated_at, the ordered (period_id,
    updated_at) of every candidate history period, engine_version,
    pack_hash). org_id is IN the key: a period id alone never reaches another
    workspace's cached rows. B7 extends ``history``."""
    import engine
    from engine.forecast_serving.plan_response import pack_hash
    return (org_id, period_id, updated_at, tuple(history), engine.__version__,
            pack_hash())


def clear_cache() -> None:
    with _CACHE_LOCK:
        _CACHE.clear()


def _loaded(client: Any, org_id: str, period_id: str) -> Dict[str, Any]:
    """The org-filtered financial_periods select runs on EVERY request,
    before any cache lookup; the cache is consulted only after it returned
    the row (1.5)."""
    from .pipeline import PeriodNotFound, load_period_rows
    rows = client.select("financial_periods",
                         filters={"id": "eq.%s" % period_id,
                                  "org_id": "eq.%s" % org_id},
                         columns="id,org_id,updated_at", single=True) or []
    if not rows:
        raise PeriodNotFound(period_id)
    key = cache_key(org_id, period_id, rows[0].get("updated_at"))
    with _CACHE_LOCK:
        blob = _CACHE.get(key)
        if blob is not None:
            _CACHE.move_to_end(key)
    if blob is None:
        loaded = load_period_rows(client, period_id, org_id=org_id, rebuild=True,
                                  line_item_columns=LINE_ITEM_COLUMNS)
        blob = json.dumps(loaded, ensure_ascii=False, sort_keys=True).encode("utf-8")
        with _CACHE_LOCK:
            _CACHE[key] = blob
            while len(_CACHE) > CACHE_ENTRIES:
                _CACHE.popitem(last=False)
    return json.loads(blob.decode("utf-8"))


def load_plan_inputs(jwt: str, org_id: str, period_id: str
                     ) -> Tuple[Dict[str, Any], List[Dict[str, Any]], Any, Dict[str, Any]]:
    """(anchor_payload, prior_periods, PlanContext, history block).

    Raises ``pipeline.PeriodNotFound`` when the period is not in the resolved
    workspace and ``pipeline.StatementsRebuildError`` when the anchor's
    statements cannot be rebuilt."""
    from . import _supabase
    from engine.forecast.assumptions import jurisdiction_of
    from engine.forecast.levers import PlanContext
    from engine.forecast.resolve import HISTORY_NOT_READ

    with _supabase.per_user(jwt) as client:
        loaded = _loaded(client, org_id, period_id)

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
               "notes": [dict(HISTORY_NOT_READ)],
               "anchor_updated_at": row.get("updated_at")}
    return anchor_payload, [], context, history
