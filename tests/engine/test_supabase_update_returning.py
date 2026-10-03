"""`SupabaseClient.update_returning` — the compare-and-swap the mail drains
and the nudge cron CLAIM a row with (gate scheduled-mail-tenancy).

The doubles answer "the rows the PATCH changed"; this pins that the REAL
client asks PostgREST for exactly that: a PATCH whose filters travel as the
query string (the WHERE Postgres re-checks under the row lock) and whose
`Prefer: return=representation` makes the answer the changed rows — [] when
another caller already moved the row. Driven over httpx.MockTransport: no
socket is opened.

Python 3.9 — no `match`, no `X | Y` unions.
"""

from __future__ import annotations

import json
from typing import Any, Dict, List

import httpx
import pytest

from engine.api._supabase import SupabaseClient


def _client(handler: Any) -> SupabaseClient:
    c = SupabaseClient("https://test.supabase.co", "service-role-test-key")
    c._client = httpx.Client(transport=httpx.MockTransport(handler), headers=c._headers, timeout=5)
    return c


def test_update_returning_sends_the_filter_and_asks_for_the_changed_rows():
    seen = []  # type: List[Dict[str, Any]]

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append({"method": request.method, "path": request.url.path,
                     "params": dict(request.url.params), "prefer": request.headers.get("prefer"),
                     "body": json.loads(request.content)})
        return httpx.Response(200, json=[{"id": "row-1", "status": "failed"}])

    rows = _client(handler).update_returning(
        "firm_email_queue", {"status": "failed", "error": "claimed"},
        filters={"id": "eq.row-1", "status": "eq.queued"})
    assert rows == [{"id": "row-1", "status": "failed"}]
    assert seen == [{"method": "PATCH", "path": "/rest/v1/firm_email_queue",
                     "params": {"id": "eq.row-1", "status": "eq.queued"},
                     "prefer": "return=representation",
                     "body": {"status": "failed", "error": "claimed"}}], seen


def test_a_lost_swap_is_an_empty_list_not_an_error():
    """The row was already claimed: the WHERE matches nothing, PostgREST
    answers 200 with [], and the caller must be able to tell."""
    rows = _client(lambda request: httpx.Response(200, json=[])).update_returning(
        "firm_email_queue", {"status": "failed"}, filters={"id": "eq.x", "status": "eq.queued"})
    assert rows == []


def test_a_refused_patch_raises_and_claims_nothing():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, json={"code": "42703", "message": "column does not exist"})

    with pytest.raises(httpx.HTTPStatusError):
        _client(handler).update_returning("firm_email_queue", {"nope": 1}, filters={"id": "eq.x"})
