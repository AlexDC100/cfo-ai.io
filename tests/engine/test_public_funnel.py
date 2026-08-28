"""Lane 5 — funnel honesty + teardown content engine.

Covers (all offline — no network, synthetic fixtures only):
  * event sink: shapes, silent drops, hourly cap, daily salt rotation;
  * PRIVACY: the raw client IP appears NOWHERE in the SQLite file
    (regex over the raw db bytes — the session_log anti-pattern must
    not be repeated here);
  * PS4: a public_only-cohort user NEVER appears in the paid funnel;
    an upload MIGRATES the user (cohort flips) with attribution
    preserved;
  * rollup math incl. honest-None on zero/unknown denominators;
  * /ops funnel section (obs.status read + ops_snapshot key + CLI line);
  * teardown generator: byte-determinism, ENGINE_API_TOKEN fail-closed
    gate (503 unset / 401 bad), PS7 PJ gate, and "never auto-publishes"
    (zero writes outside data/public_teardowns).
"""
from __future__ import annotations

import json
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from engine.public_ro import funnel, teardown

RAW_IP = "203.0.113.77"
CRAWLER_UA = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"
BROWSER_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"
)


@pytest.fixture()
def funnel_db(tmp_path, monkeypatch):
    db = tmp_path / "public_ro.db"
    monkeypatch.setenv("PUBLIC_RO_DB_PATH", str(db))
    monkeypatch.delenv("PUBLIC_FUNNEL_HOURLY_CAP", raising=False)
    return db


@pytest.fixture()
def sink_client(funnel_db):
    app = FastAPI()
    app.include_router(funnel.build_funnel_router())
    return TestClient(app)


def _rows(db: Path):
    if not db.exists():
        return []  # a fully-dropped event may never even create the DB
    conn = sqlite3.connect(str(db))
    try:
        return conn.execute(
            "SELECT kind, cui, path, utm, ip_hash, ua_class, day FROM funnel_events"
        ).fetchall()
    except sqlite3.OperationalError:
        return []
    finally:
        conn.close()


# ──────────────────────────────────────────────────────────────────────
# Event sink
# ──────────────────────────────────────────────────────────────────────

def test_event_sink_stores_valid_event(sink_client, funnel_db):
    r = sink_client.post(
        "/api/public/ro/event",
        json={
            "kind": "page_view",
            "cui": "13548146",
            "path": "/companii/13548146-scandia",
            "utm": {"utm_source": "google", "utm_medium": "organic",
                    "bogus_key": "dropped"},
        },
        headers={"x-forwarded-for": RAW_IP, "user-agent": BROWSER_UA},
    )
    assert r.status_code == 204
    rows = _rows(funnel_db)
    assert len(rows) == 1
    kind, cui, path, utm, ip_hash, ua_class, day = rows[0]
    assert kind == "page_view"
    assert cui == "13548146"
    assert path == "/companii/13548146-scandia"
    utm_obj = json.loads(utm)
    assert utm_obj == {"utm_medium": "organic", "utm_source": "google"}
    assert re.fullmatch(r"[0-9a-f]{16}", ip_hash)
    assert ua_class == "browser"
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}", day)


def test_unknown_kind_dropped_silently(sink_client, funnel_db):
    r = sink_client.post(
        "/api/public/ro/event",
        json={"kind": "totally_made_up"},
        headers={"x-forwarded-for": RAW_IP},
    )
    assert r.status_code == 204  # no oracle: dropped == stored to the caller
    assert _rows(funnel_db) == []


def test_ua_classification(sink_client, funnel_db):
    for ua, expected in (
        (CRAWLER_UA, "crawler"),
        (BROWSER_UA, "browser"),
        ("curl/8.4.0", "other"),
    ):
        sink_client.post(
            "/api/public/ro/event",
            json={"kind": "page_view"},
            headers={"x-forwarded-for": RAW_IP, "user-agent": ua},
        )
    classes = [row[5] for row in _rows(funnel_db)]
    assert classes == ["crawler", "browser", "other"]


def test_no_raw_ip_anywhere_in_db_file(sink_client, funnel_db):
    """The session_log anti-pattern (whole IPs at rest) must not recur:
    regex the raw SQLite bytes — main db AND WAL — for the client IP."""
    for _ in range(5):
        sink_client.post(
            "/api/public/ro/event",
            json={"kind": "page_view", "path": "/companii/123"},
            headers={"x-forwarded-for": RAW_IP, "user-agent": BROWSER_UA},
        )
    # fold WAL into the main file so nothing hides there, then scan both
    conn = sqlite3.connect(str(funnel_db))
    conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    conn.close()
    blob = funnel_db.read_bytes()
    wal = funnel_db.with_name(funnel_db.name + "-wal")
    if wal.exists():
        blob += wal.read_bytes()
    assert RAW_IP.encode() not in blob
    assert not re.search(rb"\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}", blob)


def test_hourly_cap_drops_silently(funnel_db, monkeypatch):
    monkeypatch.setenv("PUBLIC_FUNNEL_HOURLY_CAP", "5")
    app = FastAPI()
    app.include_router(funnel.build_funnel_router())
    client = TestClient(app)
    for _ in range(8):
        r = client.post(
            "/api/public/ro/event",
            json={"kind": "page_view"},
            headers={"x-forwarded-for": RAW_IP, "user-agent": BROWSER_UA},
        )
        assert r.status_code == 204  # capped requests are indistinguishable
    assert len(_rows(funnel_db)) == 5


def test_daily_salt_rotation_breaks_cross_day_correlation(funnel_db):
    day1 = datetime(2026, 8, 27, 12, 0, tzinfo=timezone.utc)
    day2 = datetime(2026, 8, 28, 12, 0, tzinfo=timezone.utc)
    assert funnel.record_event(kind="page_view", ip=RAW_IP, now=day1)
    assert funnel.record_event(kind="page_view", ip=RAW_IP, now=day2)
    hashes = {row[4] for row in _rows(funnel_db)}
    assert len(hashes) == 2  # same IP, different day → different hash


def test_beacon_snippet_contract():
    s = funnel.BEACON_SNIPPET
    assert s.startswith("<script>") and s.endswith("</script>")
    assert "/api/public/ro/event" in s
    assert "keepalive:true" in s
    assert ".catch(function(){})" in s
    assert "http://" not in s and "https://" not in s  # no external hosts
    assert "__cfoPubEvent" in s  # the page's tap/CTA hook


# ──────────────────────────────────────────────────────────────────────
# PS4 — cohorts and paid/public funnel separation
# ──────────────────────────────────────────────────────────────────────

FT = {"utm": {"utm_source": "google"}, "ft_cui": "13548146",
      "captured_at": "2026-08-01T00:00:00Z"}


def _fixture_users():
    """One fixture set feeding BOTH funnels (the PS4 requirement)."""
    subscriptions = [
        {"user_id": "u-public", "tier": "trial", "status": "trial"},
        {"user_id": "u-paid", "tier": "professional", "status": "active"},
        {"user_id": "u-organic", "tier": "trial", "status": "trial"},
    ]
    usage = {
        "u-public": [{"month": "2026-08", "uploads": 0}],
        "u-paid": [{"month": "2026-07", "uploads": 2},
                   {"month": "2026-08", "uploads": 1}],
        "u-organic": [{"month": "2026-08", "uploads": 3}],
    }
    attribution = {"u-public": FT, "u-paid": FT, "u-organic": None}
    return subscriptions, usage, attribution


def test_public_only_user_never_in_paid_funnel():
    subs, usage, attribution = _fixture_users()
    assert (
        funnel.cohort_for_user(
            first_touch=attribution["u-public"], usage_rows=usage["u-public"]
        )
        == "public_only"
    )
    paid = funnel.compute_paid_funnel(subs, usage)
    paid_ids = {row["user_id"] for row in paid}
    assert "u-public" not in paid_ids  # PS4: strict separation
    assert paid_ids == {"u-paid", "u-organic"}


def test_upload_migrates_cohort_and_preserves_attribution():
    subs, usage, attribution = _fixture_users()
    # the migration event: u-public performs their first upload
    usage["u-public"].append({"month": "2026-09", "uploads": 1})
    cohort = funnel.cohort_for_user(
        first_touch=attribution["u-public"], usage_rows=usage["u-public"]
    )
    assert cohort == "activated"  # cohort FLIPS on upload …
    assert attribution["u-public"] == FT  # … attribution preserved (immutable)
    paid_ids = {row["user_id"] for row in funnel.compute_paid_funnel(subs, usage)}
    assert "u-public" in paid_ids  # and the user now enters the paid funnel


def test_unattributed_user_stays_unattributed():
    _, usage, attribution = _fixture_users()
    assert (
        funnel.cohort_for_user(
            first_touch=attribution["u-organic"], usage_rows=usage["u-organic"]
        )
        == "unattributed"  # never reconstruct an attribution not captured
    )


# ──────────────────────────────────────────────────────────────────────
# Rollup math + honest None + /ops surfaces
# ──────────────────────────────────────────────────────────────────────

def _seed_events(db):
    now = datetime(2026, 8, 28, 10, 0, tzinfo=timezone.utc)
    plan = [
        ("page_view", BROWSER_UA, 4),
        ("page_view", CRAWLER_UA, 2),
        ("search", BROWSER_UA, 3),
        ("report_open", BROWSER_UA, 2),
        ("locked_ratio_tap", BROWSER_UA, 1),
        ("cta_click", BROWSER_UA, 1),
    ]
    for i, (kind, ua, n) in enumerate(plan):
        for j in range(n):
            assert funnel.record_event(
                kind=kind, ip=f"198.51.100.{i * 10 + j}", user_agent=ua,
                now=now, db=db,
            )
    return now


def test_rollup_math_and_honest_none(funnel_db):
    now = _seed_events(funnel_db)
    counts = funnel.read_event_counts(db=funnel_db, window_days=30, now=now)
    assert counts["counts"]["page_view"] == 6
    assert counts["traffic_browser"] == 4
    assert counts["counts"]["search"] == 3

    # attribution source unreachable → None everywhere downstream
    rec = funnel.compute_funnel_rollup(
        event_counts=counts, signups_attributed=None, uploads_attributed=None
    )
    assert rec["traffic"] == 6
    assert rec["signups_attributed"] is None
    assert rec["public_to_signup_rate"] is None
    assert rec["signup_to_upload_rate"] is None

    # known counts → real rates over the BROWSER denominator
    rec2 = funnel.compute_funnel_rollup(
        event_counts=counts, signups_attributed=2, uploads_attributed=1
    )
    assert rec2["public_to_signup_rate"] == pytest.approx(2 / 4)
    assert rec2["signup_to_upload_rate"] == pytest.approx(1 / 2)

    # zero denominator → honest None, never 0.0
    empty = {"window_days": 30, "counts": {}, "traffic_browser": 0}
    rec3 = funnel.compute_funnel_rollup(
        event_counts=empty, signups_attributed=0, uploads_attributed=0
    )
    assert rec3["public_to_signup_rate"] is None
    assert rec3["signup_to_upload_rate"] is None


def test_funnel_record_roundtrip_and_ops_snapshot(funnel_db, tmp_path, monkeypatch):
    from engine.obs import status as obs_status

    obs = tmp_path / "obs"
    monkeypatch.setenv("ENGINE_OBS_DIR", str(obs))
    monkeypatch.delenv("ENGINE_JOURNAL_DIR", raising=False)

    now = _seed_events(funnel_db)
    counts = funnel.read_event_counts(db=funnel_db, window_days=30, now=now)
    record = funnel.compute_funnel_rollup(
        event_counts=counts, signups_attributed=None, uploads_attributed=None
    )
    target = funnel.write_funnel_record(record)
    assert target == obs / "funnel_last.json"

    read = obs_status.read_funnel_record()
    assert read["recorded"] is True
    assert read["traffic"] == 6
    assert read["traffic_browser"] == 4
    assert read["public_to_signup_rate"] is None

    snap = obs_status.ops_snapshot()
    assert snap["funnel"]["recorded"] is True
    assert snap["funnel"]["searches"] == 3

    # absent record stays honest
    assert obs_status.read_funnel_record(tmp_path / "nope.json") == {
        "recorded": False, "path": str(tmp_path / "nope.json"),
    }


def test_engine_ops_status_renders_funnel_lines(funnel_db, tmp_path, monkeypatch, capsys):
    import importlib.util

    obs = tmp_path / "obs"
    monkeypatch.setenv("ENGINE_OBS_DIR", str(obs))
    monkeypatch.delenv("ENGINE_JOURNAL_DIR", raising=False)

    repo = Path(__file__).resolve().parents[2]
    spec = importlib.util.spec_from_file_location(
        "engine_ops_cli", repo / "scripts" / "engine_ops.py"
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    # not recorded yet
    assert mod.main(["status"]) == 0
    out = capsys.readouterr().out
    assert "funnel" in out and "not recorded yet" in out

    now = _seed_events(funnel_db)
    counts = funnel.read_event_counts(db=funnel_db, window_days=30, now=now)
    funnel.write_funnel_record(
        funnel.compute_funnel_rollup(
            event_counts=counts, signups_attributed=None, uploads_attributed=None
        )
    )
    assert mod.main(["status"]) == 0
    out = capsys.readouterr().out
    assert "page views 6" in out
    assert "public→signup n/a" in out  # honest n/a, never 0.0%


# ──────────────────────────────────────────────────────────────────────
# Teardown generator
# ──────────────────────────────────────────────────────────────────────

def _company_fixture():
    """Synthetic public_summary rows mirroring the VERIFIED stable
    FY2019-FY2025 i-code layout (I13 cifra de afaceri, I18/I19 profit/
    pierdere, I7 datorii, I10 capitaluri, I20 salariati, active totale
    = I1+I2+I6)."""
    def year(y, cifra, profit, pierdere, datorii, capitaluri, i1, i2, i6, emp):
        return {
            "year": y,
            "indicators": {
                "I1": i1, "I2": i2, "I6": i6, "I7": datorii,
                "I10": capitaluri, "I13": cifra, "I18": profit,
                "I19": pierdere, "I20": emp,
            },
            "provenance": {
                "source": "data.gov.ro/mfp", "dataset_version": "fy-final",
                "cui": "13548146", "year": y,
            },
        }

    return {
        "cui": "13548146",
        "name": "SCANDIA FOOD S.R.L.",
        "tip_contrib": "PJ",
        "years": [
            year(2023, 380_000_000, 30_000_000, 0, 90_000_000, 130_000_000,
                 120_000_000, 150_000_000, 2_000_000, 800),
            year(2024, 400_000_000, 33_000_000, 0, 95_000_000, 140_000_000,
                 125_000_000, 160_000_000, 2_100_000, 820),
            year(2025, 413_727_560, 36_787_353, 0, 100_000_000, 150_151_551,
                 130_000_000, 160_000_000, 3_050_085, 830),
        ],
    }


def test_teardown_render_is_deterministic(tmp_path):
    company = _company_fixture()
    out_a = teardown.generate_teardown(company, out_root=tmp_path / "a")
    out_b = teardown.generate_teardown(company, out_root=tmp_path / "b")
    assert out_a["markdown"] == out_b["markdown"]
    files_a = sorted(Path(p).name for p in out_a["files"])
    files_b = sorted(Path(p).name for p in out_b["files"])
    assert files_a == files_b
    for name in files_a:
        assert (tmp_path / "a" / "13548146-2025" / name).read_bytes() == (
            tmp_path / "b" / "13548146-2025" / name
        ).read_bytes()
    md = out_a["markdown"]
    assert "SCANDIA FOOD S.R.L." in md
    assert "FY2025" in md
    assert "public summary data" in md  # the honest note
    assert "data.gov.ro" in md          # source attribution
    assert "413.727.560" in md          # KPI table value, RO thousands
    assert "cifra_afaceri_sparkline.svg" in md


def test_teardown_health_flags_fire_on_distress():
    company = _company_fixture()
    last = company["years"][-1]
    last["indicators"]["I10"] = -5_000_000        # negative equity
    last["indicators"]["I18"], last["indicators"]["I19"] = 0, 2_000_000  # net loss
    md = teardown.render_teardown(company)["markdown"]
    assert "Capitaluri totale negative" in md
    assert "Pierdere netă" in md


def _teardown_client():
    app = FastAPI()
    app.include_router(teardown.build_teardown_router())
    return TestClient(app)


def test_teardown_gate_fails_closed_without_token(monkeypatch):
    monkeypatch.delenv("ENGINE_API_TOKEN", raising=False)
    client = _teardown_client()
    r = client.post("/api/public/ro/companies/13548146/teardown")
    assert r.status_code == 503
    r = client.get("/api/public/ro/teardowns")
    assert r.status_code == 503


def test_teardown_gate_rejects_bad_token(monkeypatch):
    monkeypatch.setenv("ENGINE_API_TOKEN", "secret-token")
    client = _teardown_client()
    r = client.post("/api/public/ro/companies/13548146/teardown")
    assert r.status_code == 401  # missing bearer
    r = client.post(
        "/api/public/ro/companies/13548146/teardown",
        headers={"Authorization": "Bearer wrong"},
    )
    assert r.status_code == 401


def test_teardown_route_writes_only_under_teardowns_dir(tmp_path, monkeypatch):
    """The 'never auto-publishes' assertion: with the whole data area
    sandboxed to tmp, generation touches ONLY data/public_teardowns."""
    data_root = tmp_path / "data"
    tear_root = data_root / "public_teardowns"
    (data_root / "public_pages").mkdir(parents=True)  # page cache — must stay untouched
    monkeypatch.setenv("PUBLIC_TEARDOWNS_DIR", str(tear_root))
    monkeypatch.setenv("ENGINE_API_TOKEN", "secret-token")
    monkeypatch.setattr(
        teardown, "_load_company", lambda cui: ("ok", _company_fixture())
    )

    before = {str(p) for p in data_root.rglob("*")}
    client = _teardown_client()
    r = client.post(
        "/api/public/ro/companies/13548146/teardown",
        headers={"Authorization": "Bearer secret-token"},
    )
    assert r.status_code == 200
    body = r.json()
    assert "SCANDIA" in body["markdown"]
    assert len(body["files"]) == 3  # md + 2 sparklines
    for f in body["files"]:
        assert Path(f).is_file()
        assert str(Path(f)).startswith(str(tear_root))  # nothing escapes

    after = {str(p) for p in data_root.rglob("*")}
    new_paths = after - before
    assert new_paths  # something was written …
    assert all(p.startswith(str(tear_root)) for p in new_paths)  # … only there

    # GET lists the draft (same gate)
    r = client.get(
        "/api/public/ro/teardowns",
        headers={"Authorization": "Bearer secret-token"},
    )
    assert r.status_code == 200
    assert r.json()["count"] == 1
    assert r.json()["drafts"][0]["draft"] == "13548146-2025"


def test_teardown_ps7_pj_gate(monkeypatch):
    monkeypatch.setenv("ENGINE_API_TOKEN", "secret-token")
    pf_company = {**_company_fixture(), "tip_contrib": "PF"}
    monkeypatch.setattr(teardown, "_load_company", lambda cui: ("ok", pf_company))
    client = _teardown_client()
    r = client.post(
        "/api/public/ro/companies/13548146/teardown",
        headers={"Authorization": "Bearer secret-token"},
    )
    assert r.status_code == 404  # a PF record is never renderable


def test_teardown_store_unavailable_is_503(monkeypatch):
    monkeypatch.setenv("ENGINE_API_TOKEN", "secret-token")
    monkeypatch.setattr(teardown, "_load_company", lambda cui: ("unavailable", None))
    client = _teardown_client()
    r = client.post(
        "/api/public/ro/companies/13548146/teardown",
        headers={"Authorization": "Bearer secret-token"},
    )
    assert r.status_code == 503
