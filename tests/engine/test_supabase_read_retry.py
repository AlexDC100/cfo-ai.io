"""supabase-read-retry — ruling R5 (owner, 2026-09-28): the engine's Supabase
client logs a WARNING and retries ONCE on a read timeout for GET / select,
and NEVER retries a write.

WHY: two transient `httpx.ReadTimeout`s hit production on 2026-09-28 (the
rulings deploy pre-flight's reprocess dry run on `select("documents", …)`,
and a 500 on the running container that served 200 seconds later), while the
same selects answer in 0.07-0.4 s between them (specs-durable ops_log.md). A
stalled read is worth one more try; a timed-out WRITE may have landed, and
replaying it could apply it twice.

THE LAW, through the REAL `SupabaseClient` (only its transport is stubbed —
`httpx.MockTransport`, the transport the production `httpx.Client` would
otherwise open a socket through):
  1. a select whose first GET times out and whose second answers returns the
     second answer — exactly TWO GETs, the same URL and parameters, and ONE
     WARNING line naming the table (never a parameter value, never the key);
  2. a select that times out twice raises the ReadTimeout after exactly two
     GETs — ONE retry, not a loop;
  3. every write method (insert, upsert, update, delete, rpc, signed_url,
     upload_object, delete_object) that times out raises after exactly ONE
     request and logs no retry;
  4. only a READ timeout is retried: a connect timeout, a connect error and
     an HTTP 500 on a select propagate after one request;
  5. the client's one GET call site is the retrying helper, and no write
     method reaches it (AST census over engine/api/_supabase.py) — a new GET
     cannot bypass the rule, a write cannot borrow it.

WHAT IT REDS ON, AFTER THE REPAIR (TC-11): the retry removed, retried twice or
more, extended to any write or to a non-timeout failure, or carried out
without its WARNING line (or with a parameter value / the key in it); a second
raw GET in the client. WHAT IT CANNOT SEE: whether a real PostgREST stall
clears inside one retry (ops, not code); `_billing._user_email`'s own GET to
the auth admin API, which reaches into `client._client` directly and swallows
every failure (not the PostgREST read path this ruling names).
"""
from __future__ import annotations

import ast
import logging
from pathlib import Path
from typing import Any, Callable, Dict, List

import httpx
import pytest

from engine.api import _supabase as SB

REPO = Path(__file__).resolve().parents[2]
SOURCE = REPO / "src" / "engine" / "api" / "_supabase.py"

URL = "https://project.supabase.invalid"
KEY = "service-role-key-must-never-be-logged"
ORG = "0a0a0000-0000-4000-8000-00000000r5r5"
SECRET_ID = "doc-id-that-must-not-reach-the-log"


class Transport:
    """A stub transport scripted per request: each entry is an exception to
    raise or a (status, json) to answer. Every request is recorded."""

    def __init__(self, script: List[Any]) -> None:
        self.script = list(script)
        self.requests: List[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        step = self.script.pop(0) if self.script else (200, [])
        if isinstance(step, BaseException):
            raise step
        if isinstance(step, type) and issubclass(step, BaseException):
            raise step("stubbed %s" % step.__name__, request=request)
        status, body = step
        return httpx.Response(status, json=body, request=request)


def _client(transport: Transport) -> SB.SupabaseClient:
    c = SB.SupabaseClient(URL, KEY)
    c._client.close()
    c._client = httpx.Client(transport=httpx.MockTransport(transport),
                             headers=c._headers, timeout=30.0)
    return c


def _warnings(caplog) -> List[logging.LogRecord]:
    return [r for r in caplog.records
            if r.name == SB.__name__ and r.levelno == logging.WARNING]


# ── 1–2. a read: one retry, logged ──────────────────────────────────────


def test_a_read_that_times_out_once_is_retried_once_and_logged(caplog):
    caplog.set_level(logging.DEBUG, logger=SB.__name__)
    t = Transport([httpx.ReadTimeout, (200, [{"id": SECRET_ID, "status": "analyzed"}])])
    with _client(t) as c:
        rows = c.select("documents", filters={"id": "eq.%s" % SECRET_ID}, limit=1)
    assert rows == [{"id": SECRET_ID, "status": "analyzed"}]
    assert [r.method for r in t.requests] == ["GET", "GET"]
    assert str(t.requests[0].url) == str(t.requests[1].url), "the retry is the same read"
    warns = _warnings(caplog)
    assert len(warns) == 1, [w.getMessage() for w in warns]
    msg = warns[0].getMessage()
    assert "read timeout" in msg and "documents" in msg and "retrying once" in msg, msg
    assert SECRET_ID not in msg and KEY not in msg, msg
    assert "id" in msg and "limit" in msg and "select" in msg, "the parameter NAMES are logged"
    print("GATE-WORK supabase-read-retry scenario=read_once_then_ok requests=2 warnings=1")


def test_a_single_object_read_is_retried_the_same_way(caplog):
    caplog.set_level(logging.DEBUG, logger=SB.__name__)
    t = Transport([httpx.ReadTimeout, (200, {"id": ORG, "name": "Org"})])
    with _client(t) as c:
        rows = c.select("organizations", filters={"id": "eq.%s" % ORG}, single=True)
    assert rows == [{"id": ORG, "name": "Org"}]
    assert len(t.requests) == 2
    assert all(r.headers.get("accept") == "application/vnd.pgrst.object+json" for r in t.requests)
    assert len(_warnings(caplog)) == 1


def test_a_read_that_times_out_twice_raises_after_exactly_one_retry(caplog):
    caplog.set_level(logging.DEBUG, logger=SB.__name__)
    t = Transport([httpx.ReadTimeout, httpx.ReadTimeout, (200, [])])
    with _client(t) as c:
        with pytest.raises(httpx.ReadTimeout):
            c.select("periods", filters={"org_id": "eq.%s" % ORG})
    assert len(t.requests) == 2, "one retry, never a loop"
    assert len(_warnings(caplog)) == 1
    assert SB.READ_TIMEOUT_RETRIES == 1


# ── 3. a write: never retried ──────────────────────────────────────────


WRITES: Dict[str, Callable[[SB.SupabaseClient], Any]] = {
    "insert": lambda c: c.insert("documents", {"id": SECRET_ID}),
    "upsert": lambda c: c.upsert("metrics", [{"id": 1}], on_conflict="id"),
    "update": lambda c: c.update("documents", {"status": "failed"}, filters={"id": "eq.x"}),
    "delete": lambda c: c.delete("documents", filters={"id": "eq.x"}),
    "rpc": lambda c: c.rpc("create_workspace", {"p_name": "X"}),
    "signed_url": lambda c: c.signed_url("documents", "%s/uploads/a.pdf" % ORG, org_id=ORG),
    "upload_object": lambda c: c.upload_object("documents", "%s/uploads/a.pdf" % ORG, b"%PDF",
                                               org_id=ORG),
    "delete_object": lambda c: c.delete_object("documents", "%s/uploads/a.pdf" % ORG, org_id=ORG),
}


@pytest.mark.parametrize("method", sorted(WRITES))
def test_a_write_that_times_out_is_never_retried(method, caplog):
    caplog.set_level(logging.DEBUG, logger=SB.__name__)
    t = Transport([httpx.ReadTimeout, (201, [{"id": 1}])])
    with _client(t) as c:
        with pytest.raises(httpx.ReadTimeout):
            WRITES[method](c)
    assert len(t.requests) == 1, (method, [r.method for r in t.requests])
    assert t.requests[0].method != "GET", method
    assert _warnings(caplog) == [], method
    print("GATE-WORK supabase-read-retry scenario=write_%s requests=1 warnings=0" % method)


def test_every_write_method_of_the_client_is_held():
    """The parametrised list above IS the client's write surface: a new
    public method that sends a request must be classified here."""
    public = {n for n in dir(SB.SupabaseClient)
              if not n.startswith("_") and callable(getattr(SB.SupabaseClient, n))}
    assert public - {"close", "get_user", "select"} == set(WRITES), sorted(public)


# ── 4. only a READ timeout is retried ──────────────────────────────────


@pytest.mark.parametrize("failure", ["connect_timeout", "connect_error", "http_500"])
def test_a_read_failing_otherwise_is_not_retried(failure, caplog):
    caplog.set_level(logging.DEBUG, logger=SB.__name__)
    first = {"connect_timeout": httpx.ConnectTimeout, "connect_error": httpx.ConnectError,
             "http_500": (500, {"message": "boom"})}[failure]
    expected = {"connect_timeout": httpx.ConnectTimeout, "connect_error": httpx.ConnectError,
                "http_500": httpx.HTTPStatusError}[failure]
    t = Transport([first, (200, [])])
    with _client(t) as c:
        with pytest.raises(expected):
            c.select("documents", filters={"id": "eq.x"})
    assert len(t.requests) == 1, failure
    assert _warnings(caplog) == [], failure


# ── 5. one GET call site, and it is the retrying one ───────────────────


def _methods() -> Dict[str, ast.FunctionDef]:
    tree = ast.parse(SOURCE.read_text(encoding="utf-8"))
    cls = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "SupabaseClient")
    return {n.name: n for n in cls.body if isinstance(n, ast.FunctionDef)}


def _calls(fn: ast.FunctionDef, attr: str) -> List[ast.Call]:
    return [n for n in ast.walk(fn) if isinstance(n, ast.Call)
            and isinstance(n.func, ast.Attribute) and n.func.attr == attr]


def test_the_clients_one_get_is_the_retrying_helper_and_no_write_reaches_it():
    methods = _methods()
    raw_gets = {name: len([c for c in _calls(fn, "get")
                           if ast.unparse(c.func.value) == "self._client"])
                for name, fn in methods.items()}
    assert {k: v for k, v in raw_gets.items() if v} == {"_get": 1}, raw_gets
    readers = {name for name, fn in methods.items()
               if any(ast.unparse(c.func.value) == "self" for c in _calls(fn, "_get"))}
    assert readers == {"select"}, readers
    helper = ast.unparse(methods["_get"])
    assert "except httpx.ReadTimeout" in helper and "logger.warning" in helper
    assert "READ_TIMEOUT_RETRIES" in helper
