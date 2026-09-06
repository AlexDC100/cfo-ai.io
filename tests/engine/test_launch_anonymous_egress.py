"""LR4 — WHAT ONE ANONYMOUS HIT COSTS, for every route of the real app.

THE CLAIM
=========
"Money per anonymous hit" is a launch P0. This gate measures it rather
than reasoning about it: it walks the route table of the REAL
``create_app()`` in the PRODUCTION posture (``PUBLIC_MARKETS_ENABLED``
unset, ``FIRM_COCKPIT_ENABLED`` unset), calls every GET and POST TWICE
with NO bearer, and records every outbound call at the TRANSPORT — urllib
below ``urlopen``, ``httpx.Client.send``, the ``anthropic`` client, and a
socket tripwire under all three (``tests/engine/public/egress_wire.py``;
the bodies are successful and URL-aware, so a multi-hop provider chain
runs to its end and the count is the real fan-out, not the first hop).

Each anonymous route then falls into exactly one bucket:

  FREE      both calls reached zero outbound hosts.
  WALLED    it reached a host, and it refuses anonymously anyway
            (401 / 403 / 404 / 429 / 503) — the caller cannot repeat it
            into a bill.
  CACHED    the first call reached a host and the SECOND reached none.
  LIMITED   both calls reached a host, and the surface answers 429 (the
            RO limiter / the refresh shield) before it answers again.
  OPEN      both calls reached a host, both answered 2xx, nothing
            limited them — an anonymous caller can loop it. RED.

TC-11 — what this gate reds on AFTER the repairs it was written for:
the plant is enabling the markets surface in this gate's app
(``PUBLIC_MARKETS_ENABLED=1``, which is how the surface's own suites
build it); ``GET /api/public/companies/{ticker}`` and its siblings then
land in OPEN and the gate reds naming each route, its host count and the
hosts. It would ALSO red on a regression to a route that is in scope:
dropping the ``/api/health`` memo puts it back in OPEN naming
``test.supabase.co``. And it reds on VACUITY — if the spies record
nothing at all across the whole sweep, the harness is broken and the
green means nothing, so a positive control asserts a known-costly route
still measures its cost.

Hermetic: the test-manifest Supabase URL, boot verification skipped, a
throwaway ``PUBLIC_RO_DB_PATH``, and a socket tripwire that refuses (and
records) anything that escaped the three transports. Nothing here points
at production, and no paid call is ever really made.

Python 3.9 — no ``match``, no ``X | Y`` unions.
"""

from __future__ import annotations

import json
import os
import pathlib
import sys

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent / "public"))
import egress_wire as wire  # noqa: E402

# Loopback + the app's own database are not third-party providers, but an
# anonymous route that hits either on every call is still work per hit —
# so they are MEASURED and reported, and they count toward OPEN.
OWN_HOSTS = ("test.supabase.co",)

# Routes this sweep does not drive, each with the reason. Anything not
# listed here is called.
SKIP = {
    # The legacy n8n contract; ``auth_dep`` refuses without the engine
    # bearer and it is swept by test_cron_auth.py.
    ("POST", "/run-daily"),
    ("GET", "/decisions/{run_date}"),
    # Operator-token mutations on the RO storefront's own store. Refusing
    # is their whole behaviour and test_identity_wall.py declares them;
    # driving them here would only exercise the same refusal.
    ("POST", "/api/public/ro/companies/{cui}/teardown"),
    ("POST", "/api/public/ro/takedown"),
}

REFUSAL_STATUSES = (401, 402, 403, 404, 405, 422, 429, 503)


def _concrete(path: str) -> str:
    out = []
    for seg in path.split("/"):
        if seg.startswith("{") and seg.endswith("}"):
            name = seg[1:-1].split(":")[0]
            if "shard" in name:
                out.append("0")
            elif "date" in name:
                out.append("2026-01-01")
            elif "ticker" in name or "symbol" in name:
                out.append("AAPL")
            elif "market" in name:
                out.append("us")
            elif "cui" in name:
                out.append("14399840")
            else:
                out.append("00000000-0000-0000-0000-000000000000")
        else:
            out.append(seg)
    return "/".join(out)


@pytest.fixture(scope="module")
def prod_app(tmp_path_factory):
    os.environ.setdefault("VITE_SUPABASE_URL", "https://test.supabase.co")
    os.environ.setdefault("VITE_SUPABASE_ANON_KEY", "test-anon")
    os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test-service")
    os.environ["CFO_AI_SKIP_BOOT_VERIFY"] = "1"
    os.environ["PUBLIC_RO_DB_PATH"] = str(
        tmp_path_factory.mktemp("ro") / "public_ro.db")
    for flag in ("PUBLIC_MARKETS_ENABLED", "FIRM_COCKPIT_ENABLED"):
        os.environ.pop(flag, None)
    assert "test." in os.environ["VITE_SUPABASE_URL"], (
        "refusing a non-manifest Supabase URL")
    from engine.api.server import create_app

    return create_app()


@pytest.fixture
def rec(monkeypatch):
    r = wire.install(monkeypatch)
    yield r
    assert r.escapes == [], (
        "A TRANSPORT ESCAPED THE SPIES and reached a real socket: %r. Every "
        "count in this module is a lie until that transport is patched."
        % r.escapes)


def _anonymous_routes(app):
    rows = []
    for r in app.routes:
        path = getattr(r, "path", None)
        if not path:
            continue
        for method in sorted((getattr(r, "methods", None) or set())
                             - {"HEAD", "OPTIONS"}):
            if method not in ("GET", "POST"):
                continue
            if (method, path) in SKIP:
                continue
            rows.append((method, path))
    return sorted(set(rows))


def _drive(client, rec, method, path):
    """Call twice, anonymously. Returns (status1, hosts1, status2, hosts2)."""
    url = _concrete(path)
    rec.reset()
    kwargs = {"json": {}} if method == "POST" else {}
    r1 = client.request(method, url, **kwargs)
    hosts1 = rec.hosts()
    rec.reset()
    r2 = client.request(method, url, **kwargs)
    hosts2 = rec.hosts()
    return r1.status_code, hosts1, r2.status_code, hosts2


def _classify(status1, hosts1, status2, hosts2):
    n1, n2 = sum(hosts1.values()), sum(hosts2.values())
    if n1 == 0 and n2 == 0:
        return "FREE"
    if status1 in REFUSAL_STATUSES and status2 in REFUSAL_STATUSES:
        return "WALLED" if status2 != 429 else "LIMITED"
    if n2 == 0:
        return "CACHED"
    if status2 == 429:
        return "LIMITED"
    return "OPEN"


@pytest.fixture(scope="module")
def census(prod_app, request):
    """Drive the whole table once; every test below reads this table."""
    mp = pytest.MonkeyPatch()
    r = wire.install(mp)
    request.addfinalizer(mp.undo)
    client = TestClient(prod_app, raise_server_exceptions=False)
    rows = []
    for method, path in _anonymous_routes(prod_app):
        try:
            s1, h1, s2, h2 = _drive(client, r, method, path)
        except Exception as exc:  # noqa: BLE001 — a crash is not a wall
            rows.append({"method": method, "path": path, "bucket": "ERROR",
                         "status1": None, "status2": None,
                         "hosts1": {}, "hosts2": {},
                         "error": "%s: %s" % (type(exc).__name__, str(exc)[:120])})
            continue
        rows.append({
            "method": method, "path": path,
            "status1": s1, "status2": s2,
            "hosts1": h1, "hosts2": h2,
            "bucket": _classify(s1, h1, s2, h2),
        })
    assert r.escapes == [], (
        "A TRANSPORT ESCAPED THE SPIES: %r — every count below is a lie."
        % r.escapes)
    out = os.environ.get("LAUNCH_EGRESS_TABLE")
    if out:
        pathlib.Path(out).write_text(json.dumps(rows, indent=2), encoding="utf-8")
    return rows


# ── the assertions ──────────────────────────────────────────────────────


def test_the_sweep_actually_covered_the_app(census):
    """Vacuity guard #1 — a census of nothing proves nothing."""
    assert len(census) >= 80, len(census)
    paths = set(r["path"] for r in census)
    for expected in ("/api/health", "/api/fx-rates", "/api/features/status",
                     "/api/pricing/config", "/api/sessions"):
        assert expected in paths, (expected, sorted(paths)[:40])


def test_the_spies_can_still_see_a_provider_call(prod_app, rec):
    """Vacuity guard #2 — if the harness recorded nothing anywhere, every
    'FREE' below would be a measurement artefact rather than a fact."""
    from engine.api import fx_rates

    fx_rates.reset_fx_cache()
    payload = fx_rates.get_fx_rates(force_refresh=True)
    assert sum(rec.hosts().values()) >= 1, (
        "the transport spies recorded zero calls for a function whose only "
        "job is an outbound fetch — the harness is not attached")
    assert payload["base"] == "EUR"


def test_no_anonymous_route_is_an_open_provider_tap(census):
    """THE CLAIM. An anonymous caller must not be able to loop any route
    into repeated upstream work."""
    open_rows = [r for r in census if r["bucket"] == "OPEN"]
    assert open_rows == [], (
        "ANONYMOUS ROUTES THAT REACH A HOST ON EVERY CALL, UNWALLED AND "
        "UNLIMITED — one loop is one bill:\n  " + "\n  ".join(
            "%s %s -> %s then %s, hosts %s then %s"
            % (r["method"], r["path"], r["status1"], r["status2"],
               r["hosts1"], r["hosts2"]) for r in open_rows))


def test_no_anonymous_route_crashes_the_process(census):
    errored = [r for r in census if r["bucket"] == "ERROR"]
    assert errored == [], (
        "anonymous route(s) raised out of the app rather than answering:\n  "
        + "\n  ".join("%s %s: %s" % (r["method"], r["path"], r["error"])
                      for r in errored))


def test_the_markets_surface_costs_nothing_while_it_is_hidden(census):
    """Every /api/public/* route that is not the RO storefront must reach
    no host at all — the surface is not mounted, so there is nothing to
    reach."""
    offenders = []
    for r in census:
        p = r["path"]
        if not p.startswith("/api/public/") or p.startswith("/api/public/ro/"):
            continue
        if sum(r["hosts1"].values()) or sum(r["hosts2"].values()):
            offenders.append("%s %s hosts=%s" % (r["method"], p, r["hosts1"]))
        if r["status1"] != 404:
            offenders.append("%s %s -> %s (want 404)" % (r["method"], p, r["status1"]))
    assert offenders == [], "\n  ".join([""] + offenders)


def test_the_ro_storefront_reaches_no_provider(census):
    """PS2/PS3: the storefront is deterministic and provider-free. It is
    the one public surface that stays LIVE at launch, so this is the claim
    that keeps 600k indexed URLs from being a cost centre."""
    offenders = []
    for r in census:
        p = r["path"]
        is_ro = p.startswith("/api/public/ro/") or p.split("/")[1:2] in (
            ["companii"], ["companies"], ["sector"], ["sectors"],
            ["judet"], ["counties"], ["sitemap.xml"], ["sitemaps"], ["og"])
        if not is_ro:
            continue
        hosts = set(r["hosts1"]) | set(r["hosts2"])
        third_party = sorted(h for h in hosts if h not in OWN_HOSTS)
        if third_party:
            offenders.append("%s %s -> %s" % (r["method"], p, third_party))
    assert offenders == [], (
        "the RO storefront reached a third-party host:\n  " + "\n  ".join(offenders))
