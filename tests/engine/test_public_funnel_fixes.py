"""Lane 5 regression battery — four confirmed defects in the public
funnel sink and its rollup.

Each test here reproduced a live defect BEFORE the fix:

  D1  ``PublicRoStore`` creates ``funnel_events`` WITHOUT a ``day``
      column; ``funnel.connect()`` then raised ``no such column: day``
      on its index DDL, ``record_event`` swallowed it and the route
      still answered 204 — every production event was dropped while
      every observer saw success.
  D2  the hourly abuse cap bucketed on the LEFTMOST X-Forwarded-For
      entry, which the client writes; rotating it bought unlimited
      writes into the /ops funnel numbers.
  D3  the signup numerator was all-time while the traffic denominator
      was the trailing window — the panel could print >100%.
  D4  ``user_usage`` was read unfiltered under a row budget, so
      attributed uploaders fell off the end of the page and the panel
      reported 0.0% where the truth was 100%.

Offline only: SQLite in tmp_path and a fake Supabase admin client that
actually APPLIES the PostgREST filters it is handed (a fake that ignored
filters would let the D3/D4 regressions pass again).
"""
from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from engine.public_ro import funnel, store

BROWSER_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"
)
REAL_IP = "203.0.113.9"      # what the trusted proxy appends
FORGED_IP = "198.51.100.1"   # what the caller puts in front of it

NOW = datetime(2026, 8, 28, 10, 0, tzinfo=timezone.utc)


@pytest.fixture()
def funnel_db(tmp_path, monkeypatch):
    db = tmp_path / "public_ro.db"
    monkeypatch.setenv("PUBLIC_RO_DB_PATH", str(db))
    monkeypatch.delenv("PUBLIC_FUNNEL_HOURLY_CAP", raising=False)
    return db


@pytest.fixture()
def store_created_db(funnel_db):
    """The production ordering: lane 1's store creates the file (and the
    funnel_events table, in ITS shape) before the sink ever opens it."""
    st = store.PublicRoStore(funnel_db)
    st.close()
    return funnel_db


def _client(db):
    app = FastAPI()
    app.include_router(funnel.build_funnel_router())
    return TestClient(app)


def _rows(db, columns="kind, ip_hash, ua_class, day"):
    conn = sqlite3.connect(str(db))
    try:
        return conn.execute("SELECT %s FROM funnel_events" % columns).fetchall()
    finally:
        conn.close()


# ──────────────────────────────────────────────────────────────────────
# D1 — the sink must persist on a store-created database file
# ──────────────────────────────────────────────────────────────────────

def test_connect_succeeds_on_store_created_db(store_created_db):
    conn = funnel.connect(store_created_db)
    conn.close()


def test_record_event_persists_on_store_created_db(store_created_db):
    assert funnel.record_event(
        kind="page_view", ip=REAL_IP, user_agent=BROWSER_UA,
        path="/companii/13548146-scandia", now=NOW, db=store_created_db,
    ) is True
    rows = _rows(store_created_db)
    assert len(rows) == 1
    assert rows[0][0] == "page_view"
    assert rows[0][3] == "2026-08-28"


def test_route_actually_stores_on_store_created_db(store_created_db):
    r = _client(store_created_db).post(
        "/api/public/ro/event",
        json={"kind": "page_view", "path": "/companii/13548146"},
        headers={"x-forwarded-for": REAL_IP, "user-agent": BROWSER_UA},
    )
    assert r.status_code == 204          # 204 was ALWAYS true …
    assert len(_rows(store_created_db)) == 1  # … the storage was not


def test_rollup_reads_events_written_to_a_store_created_db(store_created_db):
    for i in range(3):
        assert funnel.record_event(
            kind="page_view", ip="198.51.100.%d" % i, user_agent=BROWSER_UA,
            now=NOW, db=store_created_db,
        )
    counts = funnel.read_event_counts(db=store_created_db, window_days=30, now=NOW)
    assert counts["counts"]["page_view"] == 3
    assert counts["traffic_browser"] == 3


def test_day_backfilled_for_rows_written_before_the_column_existed(store_created_db):
    """A store-created file can already hold rows (written by an older
    build through the store's own shape); the migration must not leave
    their `day` NULL."""
    conn = sqlite3.connect(str(store_created_db))
    conn.execute(
        "INSERT INTO funnel_events(ts, kind, ip_hash, ua_class)"
        " VALUES ('2026-08-01T09:00:00+00:00', 'page_view', 'abc123', 'browser')"
    )
    conn.commit()
    conn.close()

    funnel.connect(store_created_db).close()
    days = [r[0] for r in _rows(store_created_db, "day")]
    assert days == ["2026-08-01"]


def test_fresh_funnel_created_db_is_reopenable_by_the_store(funnel_db):
    """The other ordering: the sink creates the file first. The store
    must still open it — the two shapes have to be compatible in BOTH
    directions."""
    assert funnel.record_event(
        kind="search", ip=REAL_IP, user_agent=BROWSER_UA, now=NOW, db=funnel_db
    )
    st = store.PublicRoStore(funnel_db)
    try:
        assert st.schema_version() >= 1
    finally:
        st.close()
    assert funnel.record_event(
        kind="search", ip=REAL_IP, user_agent=BROWSER_UA, now=NOW, db=funnel_db
    )
    assert len(_rows(funnel_db)) == 2


def test_sink_failure_is_logged_not_only_swallowed(tmp_path, caplog):
    """The defect's real damage was silence. An unexpected sink failure
    must leave a WARNING behind even though the caller still sees 204."""
    unopenable = tmp_path / "as_a_directory.db"
    unopenable.mkdir()
    with caplog.at_level("WARNING", logger="engine.public_ro.funnel"):
        assert funnel.record_event(
            kind="page_view", ip=REAL_IP, now=NOW, db=unopenable
        ) is False
    assert any(rec.levelname == "WARNING" for rec in caplog.records)


# ──────────────────────────────────────────────────────────────────────
# D2 — the abuse cap must key on the proxy-appended hop
# ──────────────────────────────────────────────────────────────────────

class _StubRequest:
    def __init__(self, headers, host=None):
        self.headers = headers
        self.client = type("C", (), {"host": host})() if host else None


def test_client_ip_takes_the_rightmost_forwarded_entry():
    req = _StubRequest({"x-forwarded-for": "%s, %s" % (FORGED_IP, REAL_IP)})
    assert funnel._client_ip(req) == REAL_IP


def test_client_ip_ignores_blank_trailing_entries():
    req = _StubRequest({"x-forwarded-for": "%s, %s ,  " % (FORGED_IP, REAL_IP)})
    assert funnel._client_ip(req) == REAL_IP


def test_client_ip_falls_back_to_socket_peer():
    assert funnel._client_ip(_StubRequest({}, host="192.0.2.5")) == "192.0.2.5"
    assert funnel._client_ip(_StubRequest({"x-forwarded-for": "  ,  "},
                                          host="192.0.2.5")) == "192.0.2.5"


def test_rotating_the_forged_forwarded_header_cannot_escape_the_cap(
    funnel_db, monkeypatch
):
    """One caller, ten requests, a fresh forged left-hand hop each time.
    Only the cap's worth may land — otherwise a single anonymous caller
    rewrites every /ops funnel number."""
    monkeypatch.setenv("PUBLIC_FUNNEL_HOURLY_CAP", "3")
    client = _client(funnel_db)
    for i in range(10):
        r = client.post(
            "/api/public/ro/event",
            json={"kind": "page_view"},
            headers={
                "x-forwarded-for": "10.0.0.%d, %s" % (i, REAL_IP),
                "user-agent": BROWSER_UA,
            },
        )
        assert r.status_code == 204
    rows = _rows(funnel_db)
    assert len(rows) == 3
    assert len({row[1] for row in rows}) == 1  # one bucket, not ten


# ──────────────────────────────────────────────────────────────────────
# Fake Supabase admin client (applies the filters it is given)
# ──────────────────────────────────────────────────────────────────────

def _match(row: Dict[str, Any], column: str, expr: str) -> bool:
    if expr == "not.is.null":
        return row.get(column) is not None
    if expr.startswith("gte."):
        return str(row.get(column) or "") >= expr[4:]
    if expr.startswith("lt."):
        return str(row.get(column) or "") < expr[3:]
    if expr.startswith("gt."):
        return float(row.get(column) or 0) > float(expr[3:])
    if expr.startswith("in.(") and expr.endswith(")"):
        wanted = {
            v.strip().strip('"') for v in expr[4:-1].split(",") if v.strip()
        }
        return str(row.get(column)) in wanted
    raise AssertionError("fake client got an unsupported filter: %r" % expr)


class _FakeAdmin:
    """Stands in for ``_supabase.admin()``. ``max_rows`` emulates the
    server-side row budget that made D4 fatal."""

    def __init__(self, profiles, usage, *, max_rows=10000, fail_tables=()):
        self.profiles = profiles
        self.usage = usage
        self.max_rows = max_rows
        self.fail_tables = set(fail_tables)
        self.calls: List[Dict[str, Any]] = []

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return None

    def close(self):
        return None

    def select(self, table, *, columns="*", filters=None, limit=None,
               order=None, single=False):
        self.calls.append(
            {"table": table, "filters": dict(filters or {}), "limit": limit}
        )
        if table in self.fail_tables:
            raise RuntimeError("supabase unreachable")
        rows = {"profiles": self.profiles, "user_usage": self.usage}[table]
        out = [
            dict(r) for r in rows
            if all(_match(r, col, expr) for col, expr in (filters or {}).items())
        ]
        budget = self.max_rows if limit is None else min(int(limit), self.max_rows)
        return out[:budget]

    def calls_for(self, table):
        return [c for c in self.calls if c["table"] == table]


def _install(monkeypatch, fake):
    from engine.api import _supabase

    monkeypatch.setattr(_supabase, "admin", lambda: fake)
    return fake


def _profile(uid, days_ago):
    return {
        "id": uid,
        "first_touch": {"utm": {"utm_source": "google"}},
        "created_at": (NOW - timedelta(days=days_ago)).isoformat(),
    }


# ──────────────────────────────────────────────────────────────────────
# D3 — numerator and denominator must share one window
# ──────────────────────────────────────────────────────────────────────

def test_signup_numerator_is_confined_to_the_rollup_window(monkeypatch):
    fake = _install(monkeypatch, _FakeAdmin(
        profiles=[_profile("u-old-%d" % i, 200) for i in range(7)]
        + [_profile("u-new-1", 3), _profile("u-new-2", 10)],
        usage=[],
    ))
    signups, _ = funnel.fetch_attributed_counts(window_days=30, now=NOW)
    assert signups == 2  # not 9 — the seven pre-window signups are out
    filters = fake.calls_for("profiles")[0]["filters"]
    assert "created_at" in filters


def test_conversion_rate_cannot_exceed_one_hundred_percent(funnel_db, monkeypatch):
    """The exact /ops lie: an all-time numerator over a 30-day
    denominator printed 225%."""
    _install(monkeypatch, _FakeAdmin(
        profiles=[_profile("u-old-%d" % i, 200) for i in range(7)]
        + [_profile("u-new-1", 3), _profile("u-new-2", 10)],
        usage=[],
    ))
    for i in range(4):
        assert funnel.record_event(
            kind="page_view", ip="198.51.100.%d" % i, user_agent=BROWSER_UA,
            now=NOW, db=funnel_db,
        )
    counts = funnel.read_event_counts(db=funnel_db, window_days=30, now=NOW)
    signups, uploads = funnel.fetch_attributed_counts(window_days=30, now=NOW)
    rec = funnel.compute_funnel_rollup(
        event_counts=counts, signups_attributed=signups,
        uploads_attributed=uploads,
    )
    assert rec["public_to_signup_rate"] == pytest.approx(2 / 4)
    assert rec["public_to_signup_rate"] <= 1.0


def test_window_days_is_threaded_from_the_cli(funnel_db, tmp_path, monkeypatch):
    import importlib.util

    fake = _install(monkeypatch, _FakeAdmin(
        profiles=[_profile("u-new-1", 3), _profile("u-old-1", 60)], usage=[],
    ))
    repo = __import__("pathlib").Path(__file__).resolve().parents[2]
    spec = importlib.util.spec_from_file_location(
        "public_funnel_cli", repo / "scripts" / "public_funnel.py"
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    out = tmp_path / "funnel_last.json"
    assert mod.main(["--db", str(funnel_db), "--window-days", "7",
                     "--out", str(out)]) == 0
    filters = fake.calls_for("profiles")[0]["filters"]
    assert filters.get("created_at", "").startswith("gte.")
    cutoff = filters["created_at"][4:]
    seven_days = (datetime.now(timezone.utc) - timedelta(days=7))
    assert abs((datetime.fromisoformat(cutoff) - seven_days).total_seconds()) < 120


# ──────────────────────────────────────────────────────────────────────
# D4 — the upload numerator must be filtered server-side, or be None
# ──────────────────────────────────────────────────────────────────────

def test_attributed_uploader_is_not_truncated_away_by_unrelated_rows(monkeypatch):
    """user_usage is one row per user PER MONTH. Under a row budget the
    unattributed majority pushed the attributed uploader off the page and
    the panel reported 0 uploads where the truth was 1."""
    noise = [
        {"user_id": "u-noise-%d" % i, "month": "2026-0%d" % (i + 1),
         "uploads": 4}
        for i in range(5)
    ]
    fake = _install(monkeypatch, _FakeAdmin(
        profiles=[_profile("u-att", 3)],
        usage=noise + [{"user_id": "u-att", "month": "2026-08", "uploads": 2}],
        max_rows=5,  # the budget the real call blows through with limit=10000
    ))
    signups, uploads = funnel.fetch_attributed_counts(window_days=30, now=NOW)
    assert signups == 1
    assert uploads == 1  # was 0 — the truncation lie
    usage_filters = fake.calls_for("user_usage")[0]["filters"]
    assert "user_id" in usage_filters


def test_upload_numerator_is_none_when_the_usage_read_fails(monkeypatch):
    """ABSENT != ZERO: a failed usage read must surface as n/a, never as
    'nobody uploaded'."""
    _install(monkeypatch, _FakeAdmin(
        profiles=[_profile("u-att", 3)], usage=[], fail_tables=("user_usage",),
    ))
    signups, uploads = funnel.fetch_attributed_counts(window_days=30, now=NOW)
    assert uploads is None
    rec = funnel.compute_funnel_rollup(
        event_counts={"window_days": 30, "counts": {"page_view": 10},
                      "traffic_browser": 10},
        signups_attributed=signups, uploads_attributed=uploads,
    )
    assert rec["signup_to_upload_rate"] is None


def test_both_counts_none_when_supabase_is_unreachable(monkeypatch):
    _install(monkeypatch, _FakeAdmin(
        profiles=[], usage=[], fail_tables=("profiles",),
    ))
    assert funnel.fetch_attributed_counts(window_days=30, now=NOW) == (None, None)


def test_zero_attributed_signups_is_a_measured_zero(monkeypatch):
    """No attributed signups in the window is KNOWN, not unknown — the
    honest answer is 0, and the derived rate is None on the zero
    denominator (handled by _rate, not by inventing a numerator)."""
    _install(monkeypatch, _FakeAdmin(
        profiles=[_profile("u-old", 400)], usage=[{"user_id": "u-old",
                                                   "month": "2026-01",
                                                   "uploads": 9}],
    ))
    signups, uploads = funnel.fetch_attributed_counts(window_days=30, now=NOW)
    assert (signups, uploads) == (0, 0)
    rec = funnel.compute_funnel_rollup(
        event_counts={"window_days": 30, "counts": {"page_view": 5},
                      "traffic_browser": 5},
        signups_attributed=signups, uploads_attributed=uploads,
    )
    assert rec["signup_to_upload_rate"] is None


def test_attributed_users_are_chunked_across_requests(monkeypatch):
    """The in.() list cannot grow without bound — a 400-user cohort must
    still produce a complete, honest count."""
    profiles = [_profile("u-%03d" % i, 3) for i in range(400)]
    usage = [{"user_id": "u-%03d" % i, "month": "2026-08", "uploads": 1}
             for i in range(0, 400, 2)]
    fake = _install(monkeypatch, _FakeAdmin(profiles=profiles, usage=usage))
    signups, uploads = funnel.fetch_attributed_counts(window_days=30, now=NOW)
    assert signups == 400
    assert uploads == 200
    assert len(fake.calls_for("user_usage")) > 1
