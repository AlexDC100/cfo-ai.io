"""Custom solutions admin routes — who may link accounts, and what a link
writes.

The router is mounted on its own FastAPI app with the Supabase client
replaced by an in-memory double, so the test exercises the real handlers
(auth, allowlist, e-mail lookup, upsert, delete) without a network.
"""

from __future__ import annotations

from typing import Any, Dict, List

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from engine.api import _custom_solutions as CS
from engine.api import _supabase

ADMIN = "11111111-1111-1111-1111-111111111111"
USER = "22222222-2222-2222-2222-222222222222"
OTHER = "33333333-3333-3333-3333-333333333333"

EMAILS = {
    ADMIN: "operator@cfo-ai.io",
    USER: "finance@automasters.ro",
    OTHER: "someone@example.com",
}


class Book:
    """The two tables + the two admin RPCs, in memory."""

    def __init__(self) -> None:
        self.solutions = [{"key": "automasters", "name": "AutoMasters",
                           "description": "Dealership", "created_at": "2026-10-02"}]
        self.grants: List[Dict[str, Any]] = []
        self.calls: List[str] = []

    # context manager, like SupabaseClient
    def __enter__(self) -> "Book":
        return self

    def __exit__(self, *_: Any) -> None:
        return None

    def get_user(self, jwt: str) -> Dict[str, Any]:
        if jwt not in EMAILS:
            raise AssertionError("unverifiable bearer reached get_user")
        return {"id": jwt}

    def select(self, table: str, *, filters: Any = None, columns: str = "*",
               limit: Any = None, order: Any = None, single: bool = False) -> List[Dict[str, Any]]:
        self.calls.append("select:%s" % table)
        rows = self.solutions if table == "custom_solutions" else self.grants
        if filters and "key" in filters:
            want = filters["key"].split(".", 1)[1]
            rows = [r for r in rows if r["key"] == want]
        return [dict(r) for r in rows]

    def rpc(self, fn: str, params: Dict[str, Any]) -> Any:
        self.calls.append("rpc:%s" % fn)
        if fn == "admin_find_user_by_email":
            want = params["_email"].strip().lower()
            return [{"id": uid, "email": e} for uid, e in EMAILS.items() if e == want]
        if fn == "admin_user_emails":
            return [{"id": uid, "email": EMAILS[uid]} for uid in params["_ids"] if uid in EMAILS]
        raise AssertionError(fn)

    def upsert(self, table: str, row: Dict[str, Any], *, on_conflict: str,
               returning: bool = False) -> List[Dict[str, Any]]:
        assert table == "custom_solution_grants" and on_conflict == "solution_key,user_id"
        self.grants = [g for g in self.grants
                       if not (g["solution_key"] == row["solution_key"] and g["user_id"] == row["user_id"])]
        self.grants.append({**row, "granted_at": "2026-10-02T10:00:00Z"})
        return []

    def delete(self, table: str, *, filters: Dict[str, str]) -> None:
        key = filters["solution_key"].split(".", 1)[1]
        uid = filters["user_id"].split(".", 1)[1]
        self.grants = [g for g in self.grants
                       if not (g["solution_key"] == key and g["user_id"] == uid)]


@pytest.fixture()
def book(monkeypatch: pytest.MonkeyPatch) -> Book:
    b = Book()
    monkeypatch.setattr(_supabase, "admin", lambda: b)
    monkeypatch.setattr(_supabase, "per_user", lambda jwt: b)
    monkeypatch.setenv("PLATFORM_ADMIN_USER_IDS", ADMIN)
    monkeypatch.delenv("PRICING_ADMIN_USER_IDS", raising=False)
    return b


@pytest.fixture()
def client(book: Book) -> TestClient:
    app = FastAPI()
    app.include_router(CS.build_router())
    return TestClient(app)


def hdr(uid: str) -> Dict[str, str]:
    return {"Authorization": "Bearer %s" % uid}


def test_admin_me_answers_for_any_verified_user(client: TestClient) -> None:
    assert client.get("/api/admin/me", headers=hdr(ADMIN)).json() == {"is_admin": True}
    assert client.get("/api/admin/me", headers=hdr(USER)).json() == {"is_admin": False}
    assert client.get("/api/admin/me").status_code == 401


def test_a_non_admin_can_neither_read_nor_link_nor_unlink(client: TestClient, book: Book) -> None:
    assert client.get("/api/admin/custom-solutions", headers=hdr(USER)).status_code == 403
    r = client.post("/api/admin/custom-solutions/automasters/grants",
                    json={"email": EMAILS[USER]}, headers=hdr(USER))
    assert r.status_code == 403
    r = client.delete("/api/admin/custom-solutions/automasters/grants/%s" % USER, headers=hdr(USER))
    assert r.status_code == 403
    assert book.grants == []


def test_an_empty_allowlist_fails_closed(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PLATFORM_ADMIN_USER_IDS", "")
    assert client.get("/api/admin/custom-solutions", headers=hdr(ADMIN)).status_code == 403


def test_the_pricing_allowlist_is_honoured_too(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PLATFORM_ADMIN_USER_IDS", "")
    monkeypatch.setenv("PRICING_ADMIN_USER_IDS", " %s ,x" % ADMIN)
    assert client.get("/api/admin/custom-solutions", headers=hdr(ADMIN)).status_code == 200


def test_link_by_email_then_unlink(client: TestClient, book: Book) -> None:
    r = client.post("/api/admin/custom-solutions/automasters/grants",
                    json={"email": "  Finance@AutoMasters.ro ", "note": "CFO"}, headers=hdr(ADMIN))
    assert r.status_code == 200, r.text
    (sol,) = r.json()["solutions"]
    assert sol["key"] == "automasters"
    assert sol["accounts"] == [{
        "user_id": USER, "email": EMAILS[USER], "granted_at": "2026-10-02T10:00:00Z",
        "granted_by_email": EMAILS[ADMIN], "note": "CFO",
    }]
    # linking again is idempotent — still one account
    client.post("/api/admin/custom-solutions/automasters/grants",
                json={"email": EMAILS[USER]}, headers=hdr(ADMIN))
    assert len(book.grants) == 1

    listed = client.get("/api/admin/custom-solutions", headers=hdr(ADMIN)).json()
    assert [a["email"] for a in listed["solutions"][0]["accounts"]] == [EMAILS[USER]]

    r = client.delete("/api/admin/custom-solutions/automasters/grants/%s" % USER, headers=hdr(ADMIN))
    assert r.status_code == 200
    assert r.json()["solutions"][0]["accounts"] == []
    assert book.grants == []


def test_unknown_email_is_404_and_writes_nothing(client: TestClient, book: Book) -> None:
    r = client.post("/api/admin/custom-solutions/automasters/grants",
                    json={"email": "nobody@nowhere.ro"}, headers=hdr(ADMIN))
    assert r.status_code == 404
    assert "sign up" in r.json()["detail"]
    assert book.grants == []


def test_bad_email_and_unknown_solution_are_refused(client: TestClient, book: Book) -> None:
    r = client.post("/api/admin/custom-solutions/automasters/grants",
                    json={"email": "not-an-email"}, headers=hdr(ADMIN))
    assert r.status_code == 422
    r = client.post("/api/admin/custom-solutions/nope/grants",
                    json={"email": EMAILS[USER]}, headers=hdr(ADMIN))
    assert r.status_code == 404
    r = client.post("/api/admin/custom-solutions/..%2Fx/grants",
                    json={"email": EMAILS[USER]}, headers=hdr(ADMIN))
    assert r.status_code == 404
    r = client.delete("/api/admin/custom-solutions/automasters/grants/not-a-uuid", headers=hdr(ADMIN))
    assert r.status_code == 404
    assert book.grants == []
