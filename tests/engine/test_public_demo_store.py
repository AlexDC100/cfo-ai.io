"""THE PUBLIC DEMO STORE — the shared SQLite file holds nothing a visitor
can read back, and a visitor's request stores nothing another can read.

Owner ticket 2026-10-02: "public demo routes — confirm the shared SQLite
store holds no real user data." The store is ``engine.db`` (production:
``sqlite:////app/data/engine.db`` on the ``backend_data`` volume), opened by
``create_app()`` through ``PostgresAdapter`` — six tables, none of which
carries a user or workspace column.

MEASURED 2026-10-02 against the real ``create_app()``, no bearer anywhere:

  visitor A  POST /api/cfo/today   one SKU row named after a customer's
                                   product, ``persist_recommendations``
                                   left at its default (True) -> 200, one
                                   row written to ``recommendations``
  visitor B  GET  /api/cfo/decisions -> 200, A's SKU id, real margin,
                                   volume and DIO in the body
  visitor B  POST /api/cfo/decisions/1/status {"status": "rejected",
                                   "owner": "visitor B"} -> 200, A's row
                                   rewritten
  visitor B  POST /api/cfo/today   answered ``top_actions`` FROM THE TABLE
                                   (A's rows), and its reconcile ran
                                   against every stored row

The identity wall's census declared all of it "public demo: computes from
the request body", which was true of four of the six routes and false of
the two that mattered. The repair (``cfo_ai.py``): the stored queue is the
operator's — ``GET /decisions`` and ``POST /decisions/{id}/status`` need the
engine bearer and fail closed without one configured; ``POST /today``
persists only for that bearer and otherwise computes from the body.

WHAT THE LAW IS (claims on the real app, never shapes):

  * a customer-shaped row PLANTED in every table of the store is returned
    by no route of the real app to a caller without the operator bearer —
    every route, enumerated from the app's own route table, and the six
    body-computing demo routes again with a full body;
  * no such request changes any table except the ONE declared anonymous
    write (``session_log``, by ``POST /api/sessions/track``);
  * what one visitor posts never comes back to another, from any route;
  * the operator still reads, persists and updates the queue (the walls did
    not kill the function they guard — the non-vacuity half);
  * without a configured token the queue routes are 503, never open;
  * the store has exactly the tables this file plants — a seventh table
    reds until it is planted and classified here.

TC-11 — what this reds on AFTER the repair: any route that hands a stored
row to a caller without the operator bearer; any anonymous write to a table
outside ``ANONYMOUS_WRITES``; a table added to the store without a plant; a
wall that also refuses the operator. Plant log: docs/engine_book/gates.md
"public-demo-store".

Hermetic: the app is built against the test-manifest Supabase URL with boot
verification skipped, and every test runs under a socket tripwire of its
own (``_no_outbound_socket``) — the sweep calls routes that would otherwise
dial a provider, and this gate must not depend on ``-p netblock`` being on
the command line. The store is a real SQLite FILE under ``tmp_path`` (a
file, not ``:memory:`` — production is a file, and the before/after digest
is read through a second connection). Python 3.9.
"""

from __future__ import annotations

import hashlib
import os
import socket
import sqlite3
from datetime import date, datetime
from pathlib import Path
from typing import Any, Dict, List, Tuple

import pytest
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient

REPO = Path(__file__).resolve().parents[2]

OPERATOR_TOKEN = "public-demo-store-operator-0123456789"
OPERATOR = {"Authorization": "Bearer %s" % OPERATOR_TOKEN}

#: Every table of the shared store, and the marker its planted row carries.
#: Each marker is a string no engine computation yields, so finding one in a
#: response body says a STORED row was served.
MARKERS = {
    "recommendations": "PLANTED-CUSTOMER-SKU-7781",
    "session_log": "Planted Customer Popescu",
    "chat_messages": "PLANTED-CUSTOMER-CHAT-4410",
    "daily_decisions": "PLANTED-CUSTOMER-CATEGORY-3307",
    "category_metrics": "PLANTED-CUSTOMER-METRIC-9925",
    "master_skus": "PLANTED-CUSTOMER-MASTER-6618",
}
PLANTED_IP = "198.51.100.77"
PLANTED_FIGURE = 918273.64          # expected_cash_impact_kron of the planted row

#: The ONE table a request without the operator bearer may write, and the
#: route that writes it. `session_log` holds a typed name, the address our
#: own proxy observed and the device string — personal data — and its only
#: reader (GET /api/sessions) is operator-walled
#: (tests/engine/test_hotfix_anonymous_leaks.py).
ANONYMOUS_WRITES = {"session_log": ("POST", "/api/sessions/track")}

#: The six public demo routes that compute from the body, driven a second
#: time with a body that produces decisions (an empty body exercises
#: nothing — measured: it writes no row even on the pre-fix code).
VISITOR_SKU = "VISITOR-A-SKU-5521 Salam Sibiu 400g"
DEMO_BODY = {
    "company": {"name": "Visitor A Customer SRL"},
    "categories": [{"category": "Mezeluri", "volume_tons": 120.0, "niv_kron": 9000.0,
                    "gm_pct": 4.0, "dio_days": 190, "dso_days": 40, "dpo_days": 30,
                    "woca_kron": 4200.0}],
    "skus": [{"sku_id": VISITOR_SKU, "category": "Mezeluri", "customer": "Kaufland",
              "supplier": "Furnizor Confidential SRL", "volume_tons": 120.0,
              "revenue_kron": 9000.0, "gross_margin_pct": 4.0, "dio_days": 190,
              "woca_kron": 4200.0}],
}
DEMO_ROUTES = ("/api/cfo/today", "/api/cfo/cash", "/api/cfo/profit", "/api/cfo/products",
               "/api/cfo/exports/board-summary", "/api/cfo/exports/action-list")

_ENV_OFF = ("PUBLIC_TEST_MODE", "PRICING_ADMIN_USER_IDS", "SUPABASE_JWT_SECRET",
            "ANTHROPIC_API_KEY")
#: Every surface flag ON, so the sweep covers the widest route table the
#: code can mount — a hidden surface is still code that could read the store.
_ENV_ON = {
    "VITE_SUPABASE_URL": "https://test.supabase.co",
    "VITE_SUPABASE_ANON_KEY": "test-anon",
    "SUPABASE_SERVICE_ROLE_KEY": "test-service",
    "CFO_AI_SKIP_BOOT_VERIFY": "1",
    "FIRM_COCKPIT_ENABLED": "1",
    "PUBLIC_MARKETS_ENABLED": "1",
    "ANOMALY_RADAR_ENABLED": "1",
    "LEGACY_SKU_AI_ENABLED": "1",
    "FIRM_REQUEST_SIGNING_KEY": "public-demo-store-signing-key-0123456789",
}


def _is_loopback(host: Any) -> bool:
    if isinstance(host, bytes):
        host = host.decode("ascii", "replace")
    name = str(host or "localhost").strip("[]").lower()
    return name in ("localhost", "testserver", "::1") or name.startswith("127.")


@pytest.fixture(autouse=True)
def _no_outbound_socket(monkeypatch):
    """Refuse every non-loopback DNS lookup and connect for the test.

    The sweep drives EVERY route of the app, several of which reach a
    provider (BNR, Supabase, the markets feeds). A refused socket is an
    error the route handles or a 500 the sweep reads like any other answer;
    either way no byte leaves the machine and no marker can come back from
    anywhere but the store."""
    real_gai, real_connect = socket.getaddrinfo, socket.socket.connect
    real_connect_ex, real_create = socket.socket.connect_ex, socket.create_connection

    def _host(address: Any) -> Any:
        return address[0] if isinstance(address, (tuple, list)) and address else None

    def gai(host, *a, **kw):
        if _is_loopback(host):
            return real_gai(host, *a, **kw)
        raise socket.gaierror(-2, "public-demo-store: outbound DNS refused for %s" % host)

    def connect(self, address):
        if isinstance(address, (str, bytes)) or _is_loopback(_host(address)):
            return real_connect(self, address)
        raise OSError("public-demo-store: outbound connect refused: %r" % (address,))

    def connect_ex(self, address):
        if isinstance(address, (str, bytes)) or _is_loopback(_host(address)):
            return real_connect_ex(self, address)
        raise OSError("public-demo-store: outbound connect refused: %r" % (address,))

    def create(address, *a, **kw):
        if _is_loopback(_host(address)):
            return real_create(address, *a, **kw)
        raise OSError("public-demo-store: outbound connect refused: %r" % (address,))

    monkeypatch.setattr(socket, "getaddrinfo", gai)
    monkeypatch.setattr(socket.socket, "connect", connect)
    monkeypatch.setattr(socket.socket, "connect_ex", connect_ex)
    monkeypatch.setattr(socket, "create_connection", create)


def _build(monkeypatch: Any, tmp_path: Path, token: Any = OPERATOR_TOKEN) -> Tuple[Any, Path]:
    for key in _ENV_OFF:
        monkeypatch.delenv(key, raising=False)
    for key, value in _ENV_ON.items():
        monkeypatch.setenv(key, value)
    if token is None:
        monkeypatch.delenv("ENGINE_API_TOKEN", raising=False)
    else:
        monkeypatch.setenv("ENGINE_API_TOKEN", token)
    monkeypatch.setenv("PUBLIC_RO_DB_PATH", str(tmp_path / "public_ro.db"))
    monkeypatch.setenv("PUBLIC_MARKET_DB_PATH", str(tmp_path / "public_market.db"))
    assert "test." in os.environ["VITE_SUPABASE_URL"], "refusing a non-manifest Supabase URL"
    from engine.api.server import create_app

    db = tmp_path / "engine.db"
    app = create_app(config_path=REPO / "config.yaml", db_url="sqlite:///%s" % db)
    return app, db


@pytest.fixture()
def world(monkeypatch, tmp_path):
    app, db = _build(monkeypatch, tmp_path)
    _plant(app)
    return app, db


def _plant(app: Any) -> None:
    """One customer-shaped row in EVERY table, through the store's own
    models (the real schema, never a parallel CREATE TABLE)."""
    from sqlalchemy.orm import Session

    from engine.storage import postgres as P

    now = datetime(2026, 10, 2, 9, 0, 0)
    rows = [
        P.SchemaRecommendation(
            target_type="sku", target_id=MARKERS["recommendations"], bucket="LIQUIDATE",
            action_type="liquidate", title="Liquidate %s" % MARKERS["recommendations"],
            explanation="Real margin -3.1% on volume 44.0t (DIO 211d).",
            expected_cash_impact_kron=PLANTED_FIGURE, urgency="critical", status="new",
            created_at=now, updated_at=now),
        P.SessionLog(name=MARKERS["session_log"], ip=PLANTED_IP,
                     user_agent="Mozilla/5.0 (planted customer device)",
                     first_seen=now, last_seen=now, visit_count=7),
        P.ChatMessage(company_id="planted-company", role="user",
                      content="%s: why did our margin on Kaufland fall?" % MARKERS["chat_messages"],
                      created_at=now),
        P.DailyDecisionRow(run_date=date(2026, 10, 1), category=MARKERS["daily_decisions"],
                           flag="ELIMINATE", real_margin_pct=-3.1, volume_tons=44.0,
                           abs_profit_kron=-12.5, dio_days=211,
                           payload={"id": MARKERS["daily_decisions"]}, created_at=now),
        P.SchemaCategoryMetric(snapshot_date=date(2026, 10, 1),
                               category=MARKERS["category_metrics"], volume_tons=44.0,
                               niv_kron=1200.0, gm_pct=3.0, dio_days=211),
        P.SchemaMasterOverride(sku_id=MARKERS["master_skus"], strategic_flag=True,
                               override_reason="planted customer override"),
    ]
    with Session(app.state.adapter.engine, future=True) as s:
        for row in rows:
            s.add(row)
        s.commit()


def _tables(db: Path) -> List[str]:
    con = sqlite3.connect(str(db))
    try:
        return [r[0] for r in con.execute(
            "select name from sqlite_master where type='table' and name not like 'sqlite_%' order by 1")]
    finally:
        con.close()


def _digest(db: Path) -> Dict[str, str]:
    """Row count and content hash of every table, through a connection of
    its own — what is on disk, not what a session remembers."""
    con = sqlite3.connect(str(db))
    try:
        out = {}
        for name in _tables(db):
            rows = con.execute('select * from "%s" order by 1' % name).fetchall()
            out[name] = "%d:%s" % (len(rows), hashlib.sha256(repr(rows).encode("utf-8")).hexdigest()[:16])
        return out
    finally:
        con.close()


def _every_route(app: Any) -> List[Tuple[str, str, str]]:
    """(method, concrete path, template) for every route the app mounts."""
    out = []
    for route in app.routes:
        if not isinstance(route, APIRoute):
            continue
        path = route.path
        for name, conv in route.param_convertors.items():
            kind = type(conv).__name__
            value = ("1" if "Integer" in kind
                     else "2026-10-01" if name == "run_date"
                     else "00000000-0000-4000-8000-000000000001")
            path = path.replace("{%s}" % name, value).replace("{%s:path}" % name, value)
        for method in sorted(route.methods - {"HEAD", "OPTIONS"}):
            out.append((method, path, route.path))
    return out


def _request(client: TestClient, method: str, path: str, **kw: Any) -> Any:
    if method in ("POST", "PUT", "PATCH") and "json" not in kw:
        kw["json"] = {}
    return client.request(method, path, **kw)


def _leaks(text: str) -> List[str]:
    found = [table for table, marker in MARKERS.items() if marker in text]
    if PLANTED_IP in text:
        found.append("session_log.ip")
    if repr(PLANTED_FIGURE) in text:
        found.append("recommendations.expected_cash_impact_kron")
    return found


def _served_stored_rows(app: Any, headers: Dict[str, str]) -> List[str]:
    """Every route of the app with ``headers``, then the demo routes with a
    body: the routes that put a planted marker in their answer."""
    client = TestClient(app, raise_server_exceptions=False, follow_redirects=False)
    routes = _every_route(app)
    # Measured 230 with every surface flag on; 160 without them. Below 200
    # the flags did not take and the sweep is over a narrower app.
    assert len(routes) >= 200, "only %d routes enumerated — a surface did not mount" % len(routes)
    offenders = []
    for method, path, template in routes:
        r = _request(client, method, path, headers=headers)
        hit = _leaks(r.text)
        if hit:
            offenders.append("%s %s -> %s served a stored row of %s" % (method, template, r.status_code, hit))
    for path in DEMO_ROUTES:
        r = client.post(path, json=DEMO_BODY, headers=headers)
        assert r.status_code == 200, "%s no longer computes from the body: %s %s" % (path, r.status_code, r.text[:200])
        hit = _leaks(r.text)
        if hit:
            offenders.append("POST %s (with a body) -> %s served a stored row of %s" % (path, r.status_code, hit))
    return offenders


# ── the store is what this file thinks it is ─────────────────────────────


def test_the_store_has_exactly_the_tables_this_gate_plants(world):
    """A seventh table is a new place for a customer row to sit. It reds
    here until it is planted above and its readers swept below."""
    _app, db = world
    assert _tables(db) == sorted(MARKERS), (
        "the shared store's tables changed: %s — plant a row in the new one and "
        "classify its writers before this gate may pass" % _tables(db))
    con = sqlite3.connect(str(db))
    try:
        for table in MARKERS:
            cols = [c[1] for c in con.execute('pragma table_info("%s")' % table)]
            tenant = [c for c in cols if c in ("user_id", "org_id", "workspace_id", "owner_id")]
            assert not tenant, (
                "%s grew a tenant column (%s): the store's rule — no table can tell one "
                "customer's row from another's — no longer describes it; re-read the gate" % (table, tenant))
    finally:
        con.close()


def test_every_table_holds_its_planted_row(world):
    """Non-vacuity: the sweep below is only a law if the rows are there."""
    _app, db = world
    digest = _digest(db)
    assert all(digest[t].startswith("1:") for t in MARKERS), digest


# ── the law ──────────────────────────────────────────────────────────────


def test_no_route_returns_a_stored_row_without_the_operator_bearer(world):
    """Every route of the real app, no Authorization header, the store full
    of planted customer rows: not one marker in any response."""
    app, _db = world
    offenders = _served_stored_rows(app, {})
    assert not offenders, "\n".join(offenders)


def test_a_user_bearer_is_not_the_operator_bearer(world):
    """A signed-in customer is not the operator: any bearer that is not the
    engine token reads nothing from the queue."""
    app, _db = world
    client = TestClient(app, raise_server_exceptions=False)
    for headers in ({"Authorization": "Bearer not-the-operator-token"},
                    {"Authorization": "Basic %s" % OPERATOR_TOKEN},
                    {"Authorization": OPERATOR_TOKEN},
                    {"X-Engine-Token": OPERATOR_TOKEN}):
        r = client.get("/api/cfo/decisions", headers=headers)
        assert r.status_code == 401, (headers, r.status_code)
        assert not _leaks(r.text)
        r = client.post("/api/cfo/decisions/1/status", headers=headers,
                        json={"status": "rejected", "owner": "someone else"})
        assert r.status_code == 401, (headers, r.status_code)
        assert not _leaks(r.text)


def test_no_request_without_the_operator_bearer_changes_the_store(world):
    """Every route, anonymously, then the six demo routes with a body that
    produces decisions: each table's content is byte-identical afterwards,
    except the one declared anonymous write."""
    app, db = world
    client = TestClient(app, raise_server_exceptions=False, follow_redirects=False)
    offenders = []
    calls = [(m, p, t, {}) for m, p, t in _every_route(app)]
    calls += [("POST", p, p + " (with a body)", {"json": DEMO_BODY}) for p in DEMO_ROUTES]
    calls.append(("POST", "/api/cfo/decisions/1/status", "/api/cfo/decisions/{rec_id}/status (with a body)",
                  {"json": {"status": "rejected", "owner": "visitor"}}))
    calls.append(("POST", "/api/sessions/track", "/api/sessions/track (with a body)",
                  {"json": {"name": "Visitor A"}}))
    wrote = set()
    for method, path, label, kw in calls:
        before = _digest(db)
        _request(client, method, path, **kw)
        after = _digest(db)
        for table in after:
            if after[table] == before.get(table):
                continue
            if ANONYMOUS_WRITES.get(table) == (method, path):
                wrote.add(table)
                continue
            offenders.append("%s %s changed %s (%s -> %s)" % (method, label, table, before.get(table), after[table]))
    assert not offenders, "\n".join(offenders)
    assert wrote == set(ANONYMOUS_WRITES), (
        "the declared anonymous write did not happen (%s) — the digest is not seeing writes" % sorted(wrote))


def test_what_one_visitor_posts_never_comes_back_to_another(world):
    """Visitor A sends a customer's SKU rows to every demo route with the
    default flags. Visitor B then asks every route of the app for anything."""
    app, _db = world
    visitor_a = TestClient(app, raise_server_exceptions=False)
    visitor_b = TestClient(app, raise_server_exceptions=False, follow_redirects=False)
    a_today = visitor_a.post("/api/cfo/today", json=DEMO_BODY)
    assert a_today.status_code == 200
    assert any(VISITOR_SKU in (act.get("title") or "") for act in a_today.json()["top_actions"]), (
        "visitor A's own answer no longer names their SKU — the route stopped computing from the body")
    for path in DEMO_ROUTES:
        assert visitor_a.post(path, json=DEMO_BODY).status_code == 200
    seen = []
    for method, path, template in _every_route(app):
        r = _request(visitor_b, method, path)
        if "VISITOR-A-SKU-5521" in r.text or "Visitor A Customer" in r.text or "Furnizor Confidential" in r.text:
            seen.append("%s %s -> %s" % (method, template, r.status_code))
    b_today = visitor_b.post("/api/cfo/today", json={"company": {"name": "B"}})
    assert "VISITOR-A-SKU-5521" not in b_today.text
    assert not seen, "visitor B was served visitor A's rows by: %s" % seen
    # ...and not to the operator either: nothing of A's was stored.
    stored = TestClient(app).get("/api/cfo/decisions", headers=OPERATOR).json()["recommendations"]
    assert [r["target_id"] for r in stored] == [MARKERS["recommendations"]]


# ── the walls did not kill what they guard ───────────────────────────────


def test_the_operator_still_reads_persists_and_updates_the_queue(world):
    app, db = world
    client = TestClient(app, raise_server_exceptions=False)
    listed = client.get("/api/cfo/decisions", headers=OPERATOR)
    assert listed.status_code == 200
    rows = listed.json()["recommendations"]
    assert [r["target_id"] for r in rows] == [MARKERS["recommendations"]]
    assert rows[0]["expected_cash_impact_kron"] == PLANTED_FIGURE

    persisted = client.post("/api/cfo/today", headers=OPERATOR, json=DEMO_BODY)
    assert persisted.status_code == 200
    ids = [r["target_id"] for r in client.get("/api/cfo/decisions", headers=OPERATOR,
                                              params={"limit": 50}).json()["recommendations"]]
    assert VISITOR_SKU in ids, "the operator's run was not persisted: %s" % ids

    updated = client.post("/api/cfo/decisions/%d/status" % rows[0]["id"], headers=OPERATOR,
                          json={"status": "in_review", "owner": "operator"})
    assert updated.status_code == 200 and updated.json()["status"] == "in_review"

    # ...and the same body with persistence declined stores nothing more.
    before = _digest(db)
    r = client.post("/api/cfo/today", headers=OPERATOR,
                    json=dict(DEMO_BODY, persist_recommendations=False))
    assert r.status_code == 200 and _digest(db) == before


def test_the_queue_fails_closed_where_no_operator_token_is_configured(monkeypatch, tmp_path):
    """ENGINE_API_TOKEN unset: the queue is 503 for everyone — an
    unconfigured deployment refuses, it does not open — no route of the app
    serves a stored row whatever bearer is sent (the legacy `/decisions/
    {run_date}` reader included: an unset token used to DISABLE its check),
    and /today still answers from the body without storing."""
    app, db = _build(monkeypatch, tmp_path, token=None)
    _plant(app)
    for headers in ({}, OPERATOR):
        offenders = _served_stored_rows(app, headers)
        assert not offenders, "\n".join(offenders)
    client = TestClient(app, raise_server_exceptions=False)
    for headers in ({}, OPERATOR, {"Authorization": "Bearer "}):
        r = client.get("/api/cfo/decisions", headers=headers)
        assert r.status_code == 503, (headers, r.status_code, r.text[:120])
        assert not _leaks(r.text)
        r = client.post("/api/cfo/decisions/1/status", headers=headers, json={"status": "done"})
        assert r.status_code == 503, (headers, r.status_code)
    before = _digest(db)
    r = client.post("/api/cfo/today", headers=OPERATOR, json=DEMO_BODY)
    assert r.status_code == 200 and not _leaks(r.text)
    assert _digest(db) == before


# ── the operator's count tool ────────────────────────────────────────────


def test_the_count_tool_prints_counts_and_columns_and_never_a_row(world, monkeypatch, tmp_path, capsys):
    """scripts/check_public_store.py is what the operator runs against
    production. Over a store full of planted customer rows it reports that
    rows are present (exit 3) and prints no value of any of them; over a
    fresh store it is green; it never creates or changes the file."""
    from conftest import load_module_from_path

    tool = load_module_from_path("check_public_store", REPO / "scripts" / "check_public_store.py")
    _app, db = world
    before = _digest(db)
    assert tool.main(["--db", str(db)]) == 3
    out = capsys.readouterr().out
    assert not _leaks(out), "the count tool printed a stored value: %s" % _leaks(out)
    assert "Mozilla" not in out and "planted" not in out.lower()
    for table in MARKERS:
        assert table in out
    assert _digest(db) == before

    fresh_dir = tmp_path / "fresh"
    fresh_dir.mkdir()
    _fresh_app, fresh = _build(monkeypatch, fresh_dir)
    assert tool.main(["--db", str(fresh)]) == 0
    capsys.readouterr()

    absent = tmp_path / "absent.db"
    assert tool.main(["--db", str(absent)]) == 2
    assert not absent.exists(), "the read-only tool created the file it was asked to read"
