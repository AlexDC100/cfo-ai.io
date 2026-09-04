"""Every POST under /api/public is classified, and each class is enforced.

Companion to ``test_public_refresh_shield.py``. That file proves the RATE
LIMIT works; this one proves the classification itself — that each mutating
public route has the control it is supposed to have, and that a NEW public
POST cannot appear without a decision being recorded here.

Measured 2026-09-04 against the real ``create_app()``, before this gate:

    POST /api/public/intelligence/signals/manual
        Anonymous, valid payload -> 200 and a macro signal was CREATED.
        The product then serves it through risk-radar, macro-signals and
        every per-ticker risk score. Content injection, not a cache bust.

    POST /api/public/intelligence/refresh-filings-cache
        Anonymous -> 200, and the handler made the SEC EDGAR request ITSELF,
        synchronously (run_refresh -> _fetch_recent_10k_filings -> urlopen).
        SEC publishes a host-wide ceiling of 10 req/s; a loop here gets the
        VPS blocked and takes the whole US market down.

    POST /api/public/companies/{ticker}/sync
        Anonymous and unbounded, and it PULLS from the provider inside the
        handler (one full envelope per dimension), spending the adapter's
        metered daily budget on every call. A stronger amplifier than the
        two cache-bust routes that were shielded first.

WALL vs SHIELD — the two contracts, and why routes get different ones
----------------------------------------------------------------------
``tests/engine/test_cron_auth.py``: scheduler routes FAIL CLOSED (503 with
ENGINE_API_TOKEN unset) because running them unauthenticated is worse than
not running them at all.

``refresh_shield``: an unset token does NOT fail closed, because refusing
would break a working PUBLIC surface to protect a cache.

A route that WRITES, or that reaches upstream ITSELF, and that no public
client calls, belongs with the first. A route a real visitor's button calls
belongs with the second. Both walled routes here have zero callers in
frontend/, e2e/, scripts/ or deploy/; /sync is called by
PublicCompanyDashboard.tsx's refresh button, so it is shielded, not walled.

THE VACUITY TRAP THIS GATE AVOIDS
----------------------------------
FastAPI validates the body BEFORE the handler runs, so an anonymous POST
with an EMPTY body answers 422 whether or not the wall exists. Measured:

    empty body, no bearer, wall present -> 422
    empty body, no bearer, wall removed -> 422   (identical)

A test that posted ``{}`` and asserted "not 200" would therefore stay GREEN
with the wall deleted. Every wall assertion below sends a payload that is
KNOWN-VALID, and ``test_the_walled_payloads_are_valid_so_a_401_means_the_wall``
proves it is valid by driving the same body through with a correct bearer and
requiring success. Without that control the whole file could go vacuous.

Everything runs over the REAL ``create_app()`` — no fake app, no stub router,
no intercepted route (CLAUDE.md §22: an intercepted route is a route with no
gate). No test here reaches the network: the one route that would call EDGAR
has its fetch replaced by a SPY, so even a planted regression is caught
without a request leaving the machine.

PLANT (TC-2) — each plant reds ONLY its own route:
  · Delete the ``_require_operator(...)`` line from ``post_manual_signal``
    (src/engine/public/intelligence/routes.py).
    RED: test_a_walled_route_refuses_a_wrong_bearer[...signals/manual],
         test_a_walled_route_refuses_when_the_token_is_unset[...signals/manual],
         test_an_unauthenticated_manual_signal_creates_nothing
    — each naming /api/public/intelligence/signals/manual. The
    refresh-filings-cache parametrisations stay GREEN. REVERT.
  · Delete the ``_require_operator(...)`` line from ``refresh_filings_cache``.
    RED: the [...refresh-filings-cache] parametrisations +
         test_an_unauthenticated_filings_refresh_never_calls_edgar. REVERT.
  · Delete the two ``_refresh_guard`` lines from ``sync_company``
    (src/engine/public/routes.py).
    RED: test_sync_is_limited_after_the_budget. REVERT.
"""

from __future__ import annotations

import os

import pytest
from fastapi.testclient import TestClient

# ── the classification. A new POST under /api/public must land here. ─────
#
# WALLED  — operator bearer required, FAILS CLOSED when unset (cron contract)
# SHIELDED— anonymous but rate limited per client (refresh_shield contract)
# PUBLIC  — deliberately uncontrolled; the reason is recorded per route and
#           asserted below, so "public" can never mean "nobody looked".

WALLED = {
    "/api/public/intelligence/signals/manual",
    "/api/public/intelligence/refresh-filings-cache",
    # The two RO compliance surfaces were already walled and fail closed.
    # PS8 ("a takedown is honored everywhere, immediately") is the reason
    # they must NOT be moved to SHIELDED: a rate limit can REFUSE, and a
    # takedown that 429s under load is a takedown that was not honored.
    # An authenticated operator is never limited, which is the point.
    "/api/public/ro/takedown",
    "/api/public/ro/companies/{cui}/teardown",
}

SHIELDED = {
    "/api/public/companies/{ticker}/refresh",
    "/api/public/companies/{ticker}/sync",
    "/api/public/intelligence/refresh-signals",
}

PUBLIC_BY_DESIGN = {
    # Writes nothing and reaches no upstream: universe_meta() is a
    # comprehension over an in-module tuple, demo_snapshot_for() is a static
    # dict lookup, and the handler caps the request at 20 tickers.
    "/api/public/companies/compare",
    # The funnel sink. Carries its OWN cap inside record_event(): an hourly
    # per-ip_hash ceiling (PUBLIC_FUNNEL_HOURLY_CAP, default 120) enforced in
    # SQL, and it always answers 204 so stored / capped / malformed are
    # indistinguishable to the caller (no abuse oracle). Adding the refresh
    # shield would give it a SECOND, contradictory limit and a 429 that leaks
    # exactly the signal the 204 exists to hide.
    "/api/public/ro/event",
}

CLASSIFIED = WALLED | SHIELDED | PUBLIC_BY_DESIGN

REAL_TOKEN = "the-real-operator-token"
TEST_BUDGET_PER_MIN = 3
REAL_PEER = "203.0.113.7"

# Known-VALID bodies for the two walled intelligence routes. Validity is not
# assumed — test_the_walled_payloads_are_valid_so_a_401_means_the_wall drives
# each one through with a correct bearer and requires it to succeed.
VALID_BODY = {
    "/api/public/intelligence/signals/manual": {
        "signal_type": "geopolitical",
        "title": "Gate probe signal",
        "summary": "A payload the schema accepts, used to prove the wall.",
        "severity": "high",
    },
    "/api/public/intelligence/refresh-filings-cache": None,  # takes no body
}
WALLED_INTELLIGENCE = sorted(VALID_BODY)


@pytest.fixture(scope="module")
def app_and_client():
    os.environ.setdefault("VITE_SUPABASE_URL", "https://test.supabase.co")
    os.environ.setdefault("VITE_SUPABASE_ANON_KEY", "test-anon")
    os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test-service")
    os.environ["CFO_AI_SKIP_BOOT_VERIFY"] = "1"
    assert "test." in os.environ["VITE_SUPABASE_URL"], "refusing a non-manifest Supabase URL"
    from engine.api.server import create_app

    app = create_app()
    return app, TestClient(app)


@pytest.fixture
def edgar_spy(monkeypatch):
    """Replace the EDGAR fetch with a recorder.

    Installed for EVERY test that can reach refresh-filings-cache, so that a
    PLANTED regression (wall removed) is caught WITHOUT a request leaving
    this machine. The spy is the assertion surface: `calls` must stay 0 for
    anonymous callers.
    """
    from engine.public.intelligence import filings_refresh

    calls: list[str] = []

    def _spy():
        calls.append("edgar")
        return []

    monkeypatch.setattr(filings_refresh, "_fetch_recent_10k_filings", _spy)
    return calls


@pytest.fixture
def client(app_and_client, monkeypatch, edgar_spy):
    """Fresh bucket + small budget + no token, per test."""
    from engine.public import refresh_shield

    monkeypatch.setenv("PUBLIC_REFRESH_RATE_PER_MIN", str(TEST_BUDGET_PER_MIN))
    monkeypatch.setenv("PUBLIC_REFRESH_RATE_BURST", str(TEST_BUDGET_PER_MIN))
    monkeypatch.delenv("ENGINE_API_TOKEN", raising=False)
    refresh_shield.reset_limiter()
    yield app_and_client[1]
    refresh_shield.reset_limiter()


def _post(client, path, body, **kw):
    return client.post(path, json=body, **kw) if body is not None else client.post(path, **kw)


# ── the inventory: no unclassified mutating public route ─────────────────

def test_every_public_post_on_the_real_app_is_classified(app_and_client):
    """The durable property. A new POST under /api/public reds this until
    somebody decides — walled, shielded, or public with a stated reason."""
    app, _ = app_and_client
    live = {
        r.path
        for r in app.routes
        if r.path.startswith("/api/public")
        and {"POST", "PUT", "PATCH", "DELETE"} & (getattr(r, "methods", None) or set())
    }
    unclassified = live - CLASSIFIED
    assert not unclassified, (
        "UNCLASSIFIED MUTATING PUBLIC ROUTE(S): %s\n"
        "Every POST under /api/public needs a recorded decision. Add each to "
        "WALLED (operator bearer, fails closed — it writes, or it reaches "
        "upstream itself, and no public client calls it), SHIELDED (rate "
        "limited — a real visitor's button calls it), or PUBLIC_BY_DESIGN "
        "(with the reason written down)." % sorted(unclassified))
    stale = CLASSIFIED - live
    assert not stale, (
        "CLASSIFIED ROUTE(S) NO LONGER ON THE APP — renamed or unmounted, so "
        "the assertions below test nothing: %s" % sorted(stale))


def test_the_classification_has_no_route_in_two_classes(app_and_client):
    """A route in two classes would make one of them unenforced."""
    assert not (WALLED & SHIELDED), sorted(WALLED & SHIELDED)
    assert not (WALLED & PUBLIC_BY_DESIGN), sorted(WALLED & PUBLIC_BY_DESIGN)
    assert not (SHIELDED & PUBLIC_BY_DESIGN), sorted(SHIELDED & PUBLIC_BY_DESIGN)
    assert len(CLASSIFIED) == len(WALLED) + len(SHIELDED) + len(PUBLIC_BY_DESIGN)


# ── the anti-vacuity control ─────────────────────────────────────────────

@pytest.mark.parametrize("path", WALLED_INTELLIGENCE)
def test_the_walled_payloads_are_valid_so_a_401_means_the_wall(client, monkeypatch, path, edgar_spy):
    """Without this, every wall assertion below could be passing on a 422.

    FastAPI validates the body before the handler, so a malformed payload
    is refused whether or not the wall exists. Proving the payload is
    ACCEPTED with a correct bearer is what makes the refusals meaningful.
    """
    monkeypatch.setenv("ENGINE_API_TOKEN", REAL_TOKEN)
    r = _post(client, path, VALID_BODY[path],
              headers={"Authorization": "Bearer %s" % REAL_TOKEN})
    assert r.status_code == 200, (
        "the gate's own payload for %s is not valid — every wall assertion "
        "in this file would then be passing on a 422 instead of a 401. "
        "Got %s: %s" % (path, r.status_code, r.text[:200]))


# ── the wall: fail closed, exactly like the crons ────────────────────────

@pytest.mark.parametrize("path", WALLED_INTELLIGENCE)
def test_a_walled_route_refuses_when_the_token_is_unset(client, monkeypatch, path, edgar_spy):
    monkeypatch.delenv("ENGINE_API_TOKEN", raising=False)
    r = _post(client, path, VALID_BODY[path])
    assert r.status_code == 503, (
        "OPERATOR ROUTE RUNS OPEN — %s answered %s to an anonymous, "
        "VALID-payload POST with ENGINE_API_TOKEN unset. It must fail closed "
        "(503) like the scheduler routes in tests/engine/test_cron_auth.py: "
        "an unconfigured deployment cannot authenticate anyone, and running "
        "this route unauthenticated is worse than not running it. Body: %s"
        % (path, r.status_code, r.text[:200]))


@pytest.mark.parametrize("path", WALLED_INTELLIGENCE)
def test_a_walled_route_refuses_a_wrong_bearer(client, monkeypatch, path, edgar_spy):
    monkeypatch.setenv("ENGINE_API_TOKEN", REAL_TOKEN)
    r = _post(client, path, VALID_BODY[path],
              headers={"Authorization": "Bearer not-the-token"})
    assert r.status_code in (401, 403), (
        "OPERATOR ROUTE ACCEPTS A WRONG BEARER — %s answered %s. Got: %s"
        % (path, r.status_code, r.text[:200]))
    r = _post(client, path, VALID_BODY[path])
    assert r.status_code in (401, 403), (
        "OPERATOR ROUTE ACCEPTS AN ANONYMOUS CALL — %s answered %s with the "
        "token configured and no Authorization header at all. Got: %s"
        % (path, r.status_code, r.text[:200]))


@pytest.mark.parametrize("path", WALLED_INTELLIGENCE)
def test_a_walled_route_is_never_merely_rate_limited(client, monkeypatch, path, edgar_spy):
    """429 instead of 401 would mean N free calls per window before refusal.

    For a route that WRITES, N>=1 is already the whole defect: one injected
    signal is durable and is served to users regardless of the call rate.
    """
    monkeypatch.delenv("ENGINE_API_TOKEN", raising=False)
    for _ in range(TEST_BUDGET_PER_MIN + 2):
        r = _post(client, path, VALID_BODY[path])
        assert r.status_code != 200, (
            "%s served an anonymous caller: %s" % (path, r.text[:160]))
        assert r.status_code != 429, (
            "%s is RATE LIMITED where it must be WALLED — a limit still "
            "admits calls inside the budget, and for this route one admitted "
            "call is the entire defect." % path)


# ── the wall actually prevents the side effect ───────────────────────────

def test_an_unauthenticated_manual_signal_creates_nothing(client, monkeypatch):
    """The measured defect: anonymous POST -> 200 -> a live macro signal."""
    from engine.public.intelligence.macro_signal_service import get_macro_signal_service

    path = "/api/public/intelligence/signals/manual"
    store = get_macro_signal_service().manual._memory
    before = len(store)

    monkeypatch.delenv("ENGINE_API_TOKEN", raising=False)
    r = _post(client, path, VALID_BODY[path])
    assert r.status_code == 503, (
        "CONTENT INJECTION OPEN — %s answered %s to an anonymous, "
        "VALID-payload POST with ENGINE_API_TOKEN unset: %s"
        % (path, r.status_code, r.text[:160]))

    monkeypatch.setenv("ENGINE_API_TOKEN", REAL_TOKEN)
    for hdrs in ({}, {"Authorization": "Bearer not-the-token"}):
        r = _post(client, path, VALID_BODY[path], headers=hdrs)
        assert r.status_code in (401, 403), (
            "CONTENT INJECTION OPEN — %s answered %s to headers=%r: %s"
            % (path, r.status_code, hdrs, r.text[:160]))

    assert len(store) == before, (
        "CONTENT INJECTION — an unauthenticated POST to %s created %d macro "
        "signal(s). Anything created here is served to users through "
        "risk-radar, macro-signals and every per-ticker risk score."
        % (path, len(store) - before))


def test_an_unauthenticated_filings_refresh_never_calls_edgar(client, monkeypatch, edgar_spy):
    """The measured defect: anonymous POST -> a live synchronous SEC request.

    The spy stands in for EDGAR, so a planted regression is caught here
    rather than by the SEC blocking the host.
    """
    path = "/api/public/intelligence/refresh-filings-cache"

    monkeypatch.delenv("ENGINE_API_TOKEN", raising=False)
    for i in range(3):
        r = client.post(path)
        assert r.status_code == 503, (
            "OUTBOUND AMPLIFIER OPEN — %s answered %s to anonymous call %d "
            "with ENGINE_API_TOKEN unset. This handler performs the SEC EDGAR "
            "request itself, synchronously." % (path, r.status_code, i + 1))

    monkeypatch.setenv("ENGINE_API_TOKEN", REAL_TOKEN)
    for hdrs in ({}, {"Authorization": "Bearer not-the-token"}):
        r = client.post(path, headers=hdrs)
        assert r.status_code in (401, 403), (
            "OUTBOUND AMPLIFIER OPEN — %s answered %s to headers=%r. Every "
            "such call is a live request to SEC EDGAR."
            % (path, r.status_code, hdrs))

    assert edgar_spy == [], (
        "OUTBOUND AMPLIFIER OPEN — an unauthenticated POST to %s reached SEC "
        "EDGAR %d time(s). This handler makes the request itself, "
        "synchronously; SEC publishes a host-wide ceiling of 10 req/s and a "
        "block there takes the whole US market down." % (path, len(edgar_spy)))

    # ...and the authenticated call DOES reach it, so the assertion above is
    # about authentication and not about a spy that never fires.
    assert client.post(
        path, headers={"Authorization": "Bearer %s" % REAL_TOKEN}
    ).status_code == 200
    assert edgar_spy == ["edgar"], (
        "the operator path no longer performs the refresh: %r" % edgar_spy)


# ── the shield on /sync, the strongest upstream amplifier ────────────────

SYNC = "/api/public/companies/AAPL/sync"


def test_sync_is_limited_after_the_budget(client):
    """/sync PULLS from the provider inside the handler, once per dimension.

    Its under-budget status is not asserted as 200: with no Nasdaq key
    configured the route legitimately answers a typed 503 envelope. What
    matters is that it is NOT 429 under budget and IS 429 over it.
    """
    for i in range(TEST_BUDGET_PER_MIN):
        r = client.post(SYNC)
        assert r.status_code != 429, (
            "a sync WITHIN the budget must still work — call %d gave 429" % (i + 1))
    r = client.post(SYNC)
    assert r.status_code == 429, (
        "ROUTE IS UNSHIELDED — %s answered %s to the N+1st anonymous sync "
        "(budget %d/min). Every call pulls a full envelope per dimension from "
        "the provider inside the handler and spends the adapter's metered "
        "daily budget." % (SYNC, r.status_code, TEST_BUDGET_PER_MIN))
    body = r.json()
    assert body["error"]["code"] == "public_refresh_rate_limited", body
    assert r.headers.get("Retry-After"), "a 429 must carry Retry-After"


def test_a_limited_sync_spends_nothing_upstream(client, monkeypatch):
    """The 429 must be decided BEFORE the provider is touched."""
    from engine.public import pipeline as public_pipeline

    for _ in range(TEST_BUDGET_PER_MIN):
        assert client.post(SYNC).status_code != 429

    calls: list[str] = []
    monkeypatch.setattr(
        public_pipeline, "sync_company",
        lambda *a, **k: calls.append("upstream") or {},
    )
    r = client.post(SYNC)
    assert r.status_code == 429, (
        "ROUTE IS UNSHIELDED — %s answered %s once the budget was spent, so "
        "there is no 429 path to check for upstream spend." % (SYNC, r.status_code))
    assert calls == [], (
        "the 429 path called pipeline.sync_company anyway — the shield must "
        "run BEFORE any provider fetch, or a rate-limited caller still "
        "spends the daily budget they were refused for.")


def test_sync_shares_one_budget_with_the_other_shielded_routes(client):
    """Keyed by client, not by (client, route).

    /sync is the strongest amplifier of the three, so a separate allowance
    for it would let a loop alternate routes for a larger cold fan-out.
    """
    for _ in range(TEST_BUDGET_PER_MIN):
        assert client.post(SYNC).status_code != 429
    r = client.post("/api/public/companies/AAPL/refresh")
    assert r.status_code == 429, (
        "a client who spent their budget on /sync was handed a FRESH one on "
        "/refresh — alternating routes multiplies the cold-read fan-out. One "
        "bucket per client, not per route. Got %s" % r.status_code)


def test_a_valid_bearer_is_never_limited_on_sync(client, monkeypatch):
    monkeypatch.setenv("ENGINE_API_TOKEN", REAL_TOKEN)
    hdrs = {"Authorization": "Bearer %s" % REAL_TOKEN}
    for i in range(TEST_BUDGET_PER_MIN * 4):
        assert client.post(SYNC, headers=hdrs).status_code != 429, (
            "the operator bearer must never be rate limited — sync call %d" % (i + 1))


def test_sync_with_the_token_unset_still_serves_anonymously(client, monkeypatch):
    """SHIELDED, not WALLED: /sync is behind a real visitor's refresh button
    (PublicCompanyDashboard.tsx -> syncPublicCompany), so failing closed on
    an unset token would break that button for everyone to protect a
    provider quota. Deliberately NOT the cron contract."""
    monkeypatch.delenv("ENGINE_API_TOKEN", raising=False)
    r = client.post(SYNC)
    assert r.status_code != 429, "the anonymous path must serve under budget"
    assert r.status_code not in (401, 403), (
        "/sync must not require a bearer — it is a live public surface. If "
        "this was deliberate, move it from SHIELDED to WALLED above.")


# ── public by design: the reason is asserted, not just written down ──────

def test_compare_is_deliberately_uncontrolled_and_stays_cheap(client):
    """Local-only compute, bounded at 20 tickers, no write, no upstream."""
    body = {"tickers": ["AAPL", "MSFT"]}
    for i in range(TEST_BUDGET_PER_MIN + 3):
        r = client.post("/api/public/companies/compare", json=body)
        assert r.status_code == 200, (
            "/api/public/companies/compare is classified PUBLIC_BY_DESIGN but "
            "answered %s on call %d. If it was shielded deliberately, move it "
            "to SHIELDED above." % (r.status_code, i + 1))
    over = client.post(
        "/api/public/companies/compare",
        json={"tickers": ["T%d" % i for i in range(21)]},
    )
    assert over.status_code == 400, (
        "the 20-ticker cap is what bounds this route's work per call; without "
        "it the PUBLIC_BY_DESIGN classification no longer holds. Got %s"
        % over.status_code)


def test_the_funnel_sink_keeps_its_own_cap_and_its_silence(client):
    """/ro/event is PUBLIC_BY_DESIGN because it carries its own limit.

    Asserted rather than assumed: the cap helper must exist and the route
    must answer 204 regardless, so stored / capped / malformed stay
    indistinguishable (no abuse oracle). A 429 here would leak exactly the
    signal the 204 exists to hide.
    """
    from engine.public_ro import funnel

    assert funnel.DEFAULT_HOURLY_CAP >= 1 and callable(funnel._hourly_cap), (
        "the funnel's own hourly cap is the reason /api/public/ro/event needs "
        "no shield; it is gone, so the classification no longer holds")
    for _ in range(TEST_BUDGET_PER_MIN + 2):
        r = client.post("/api/public/ro/event", json={"kind": "page_view"})
        assert r.status_code == 204, (
            "/api/public/ro/event must answer 204 to every caller — a %s here "
            "is an abuse oracle. If a shield was added deliberately, move the "
            "route to SHIELDED above." % r.status_code)


# ── the compliance surfaces stay walled, and stay unlimited ──────────────

@pytest.mark.parametrize("path", [
    "/api/public/ro/takedown",
    "/api/public/ro/companies/1234567/teardown",
])
def test_ps8_compliance_routes_are_walled_and_never_rate_limited(client, monkeypatch, path):
    """PS8: a takedown is honored everywhere, immediately.

    So these must be WALLED and must NOT gain the refresh shield: a limiter
    can REFUSE, and a takedown that 429s under load is a takedown that was
    not honored. The correct control is an authenticated operator who is
    never limited.
    """
    monkeypatch.delenv("ENGINE_API_TOKEN", raising=False)
    body = {"cui": "1234567", "action": "remove", "reason": "gate", "verified_by": "gate"}
    for _ in range(TEST_BUDGET_PER_MIN + 2):
        r = client.post(path, json=body)
        assert r.status_code == 503, (
            "%s must fail closed (503) with ENGINE_API_TOKEN unset; got %s"
            % (path, r.status_code))
        assert r.status_code != 429, (
            "PS8 VIOLATION — %s was rate limited. A takedown that can be "
            "refused under load is not honored immediately." % path)
