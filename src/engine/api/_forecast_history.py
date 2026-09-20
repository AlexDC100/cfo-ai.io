"""What the forecast route loads before the engine runs (plan/2 B5,
plan_contract_v2 1.1, 1.4).

``load_plan_inputs`` reads the anchor period through the caller's OWN
Supabase client (RLS scopes the row; the resolved ``org_id`` filter is a
second lock, never the only one) by way of the one module-scope reader,
``engine.api.pipeline.load_period_rows``, and hands back what
``engine.forecast.levers.project_plan`` takes: the anchor payload, the prior
periods, the PlanContext and the history block. ``project_plan`` performs no
I/O; everything it reads is loaded here.

B7: ONE comparable prior period is resolved INSIDE the org and handed on,
for the ``revenue_growth`` ladder's book rung. The org filter is on the
candidate select itself, so a prior in another workspace is never read; the
comparability verdict (same fiscal year end, exactly one year back) is taken
HERE and nowhere else, so a ladder cannot quietly widen it. Every candidate
that is passed over leaves its reason in ``history["excluded"]``.

An anchor whose statements cannot be rebuilt raises StatementsRebuildError,
which the route answers 409 with its sentence; it is never swallowed into
``statements=None``. A PRIOR whose statements cannot be rebuilt is NOT an
error — the anchor's plan is served, with the prior excluded for that
reason and the growth ladder falling through to its macro rung.

Python 3.9 - no ``match``, no ``X | Y`` unions.
"""

from __future__ import annotations

import json
import threading
from collections import OrderedDict
from typing import Any, Dict, List, Tuple

__all__ = ["LINE_ITEM_COLUMNS", "PRIOR_CANDIDATES", "PRIOR_COLUMNS",
           "PRIOR_ORDER", "cache_key", "clear_cache", "comparability",
           "load_plan_inputs"]

#: The statement_line_items columns the rebuild and the cost pools read.
LINE_ITEM_COLUMNS = "statement,bucket,ro_account_code,ro_account_name,amount"

#: The tie-break of every org-scoped "the period before this one" select in
#: this codebase (``_firm_attention.PERIOD_ORDER``). Most recent first; the
#: id settles two periods that end on the same day, so the choice is stable
#: across requests rather than whatever Postgres returns first.
PRIOR_ORDER = "period_end.desc,id.asc"

#: How many candidates the select looks at before giving up. A book with
#: four interim periods between two year ends would otherwise never reach
#: its comparable prior; a book with more than that is not one this build
#: reads history for.
PRIOR_CANDIDATES = 6

#: The columns of a candidate row. The candidate select reads the INDEX
#: columns only — never the envelope — so looking for a prior costs one
#: cheap select even when none of them is comparable.
PRIOR_COLUMNS = "id,org_id,period_end,updated_at"


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
    workspace's cached rows.

    B7 note: the ANCHOR's entry keeps ``history=()`` deliberately. Its rows
    do not change when a prior period appears or is re-uploaded, and keying
    them on the history would throw away the anchor's rebuild every time the
    prior moved. The prior is cached under its OWN key (it is an ordinary
    period), and ``pins.history_hash`` on the wire is what tells a client
    the history moved."""
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


def _ymd(value: Any) -> Any:
    """(year, month, day) of a YYYY-MM-DD period_end, or None."""
    text = str(value or "")
    try:
        return int(text[0:4]), int(text[5:7]), int(text[8:10])
    except (TypeError, ValueError):
        return None


def comparability(anchor_period_end: Any, candidate_period_end: Any) -> Any:
    """None when the candidate is a comparable prior year of the anchor,
    otherwise the {code, text} reason it is not.

    Two conditions, both about the SPAN rather than the size of anything:
    the candidate must end on the same day of the same month (a book's
    fiscal year end), and exactly one year earlier. An interim period would
    make a twelve-month turnover grow against a three-month one; a period
    two years back would make a two-year growth be spent as a one-year rate.
    Neither is a growth this build can read, so neither is offered as one."""
    anchor = _ymd(anchor_period_end)
    candidate = _ymd(candidate_period_end)
    if anchor is None or candidate is None:
        return {"code": "period_end_unreadable",
                "text": "the period end is not a date this reader can parse"}
    if (candidate[1], candidate[2]) != (anchor[1], anchor[2]):
        return {"code": "different_year_end",
                "text": "ends %s, the anchor ends %s: a turnover cannot be "
                        "grown against a different span"
                        % (candidate_period_end, anchor_period_end)}
    gap = anchor[0] - candidate[0]
    if gap != 1:
        return {"code": "not_the_prior_year",
                "text": "ends %d year(s) before the anchor: a single-year "
                        "growth cannot be read across that gap" % gap}
    return None


def _history_block(client: Any, org_id: str, period_id: str,
                   anchor_period_end: Any) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    """(prior_periods, history block). The org filter is ON THIS SELECT: a
    period in another workspace is never a candidate, never loaded and never
    named in the block."""
    from .pipeline import PeriodNotFound, StatementsRebuildError

    rows = client.select(
        "financial_periods",
        filters={"org_id": "eq.%s" % org_id,
                 "period_end": "lt.%s" % anchor_period_end,
                 "id": "neq.%s" % period_id},
        columns=PRIOR_COLUMNS, order=PRIOR_ORDER,
        limit=PRIOR_CANDIDATES) or []

    eligible = []  # type: List[Dict[str, Any]]
    excluded = []  # type: List[Dict[str, Any]]
    for row in rows:
        entry = {"period_id": row.get("id"),
                 "period_end": row.get("period_end")}
        reason = comparability(anchor_period_end, row.get("period_end"))
        if reason is not None:
            excluded.append(dict(entry, reason=dict(reason)))
            continue
        eligible.append(entry)

    prior_periods = []  # type: List[Dict[str, Any]]
    held = []  # type: List[Dict[str, Any]]
    held_rows = []  # type: List[Dict[str, Any]]
    for entry in eligible:
        row = [r for r in rows if r.get("id") == entry["period_id"]][0]
        try:
            loaded = _loaded(client, org_id, str(entry["period_id"]))
        except StatementsRebuildError as failed:
            # NOT the anchor's failure: the plan is still served, with the
            # growth ladder falling through to its macro rung.
            excluded.append(dict(entry, reason={
                "code": "statements_not_rebuilt",
                "text": "this period's statements could not be rebuilt, so "
                        "its turnover cannot be read: %s" % failed}))
            continue
        except PeriodNotFound:
            # The candidate select saw the row and the id+org_id load did
            # not. That means RLS refused it, so the row is not this
            # workspace's to read whatever the candidate select thought:
            # the PRIOR is dropped, never the anchor's whole plan.
            excluded.append(dict(entry, reason={
                "code": "prior_not_readable",
                "text": "this period is not readable in this workspace"}))
            continue
        prior_periods.append({
            "period_id": entry["period_id"],
            "period_end": entry["period_end"],
            "envelope": (loaded["row"] or {}).get("assembled_canonical_v1"),
            "statements": loaded["statements"],
        })
        held.append(dict(entry))
        held_rows.append({"period_id": entry["period_id"],
                          "updated_at": row.get("updated_at")})
        break
    # every eligible period after the one held is passed over, and says so
    for entry in eligible[len(held):] if held else []:
        if entry["period_id"] not in [h["period_id"] for h in held]:
            excluded.append(dict(entry, reason={
                "code": "superseded_by_a_nearer_prior",
                "text": "a nearer comparable period is held"}))
    return prior_periods, {"held": held, "eligible": eligible,
                           "excluded": excluded, "held_rows": held_rows}


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
        prior_periods, history = _history_block(
            client, org_id, period_id, (loaded["row"] or {}).get("period_end"))

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
    history["notes"] = ([] if history["held"] else [dict(HISTORY_NOT_READ)])
    history["anchor_updated_at"] = row.get("updated_at")
    return anchor_payload, prior_periods, context, history
