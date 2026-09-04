"""The two public cache-BUST routes are shielded (rate limit + operator bearer).

Measured 2026-09-04 against the real ``create_app()``: both routes answered
200 to twelve consecutive unauthenticated POSTs and neither module referenced
any rate limiter.

    POST /api/public/companies/{ticker}/refresh
    POST /api/public/intelligence/refresh-signals

They leak nothing and fetch nothing themselves — they INVALIDATE caches, so
the next read is cold against upstream. The US market is served through SEC
EDGAR ("Current max request rate: 10 requests/second", quoted in
src/engine/public_market/markets.yaml). A loop on either route drives cold
reads until the host is blocked and the whole US market goes down.

A THIRD route, POST /api/public/companies/{ticker}/sync, joined the same
shield and the same bucket later the same day — it is a stronger amplifier
still (it performs the provider pull itself rather than making the next read
cold). It is NOT parametrised into this file because with no Nasdaq key
configured it answers a typed 503 envelope rather than the 200 every
assertion here expects; its shield is covered in the sibling file,
tests/engine/test_public_post_surface.py, which also holds the
walled/shielded/public classification for the whole /api/public POST surface.

Everything here runs over the REAL create_app() — no fake app, no stub router,
no intercepted route. CLAUDE.md §22: an intercepted route is a route with no
gate, and that is exactly how the Capsule 422 survived to production.

PLANT (TC-2) — remove the shield from ONE route:
    In src/engine/public/intelligence/routes.py, delete the two guard lines
        limited = _refresh_guard(request, route=".../refresh-signals")
        if limited is not None: return limited
    RED: test_anonymous_calls_are_limited_after_the_budget[...refresh-signals]
    fails with a message NAMING that route as unshielded. REVERT.

    Same for src/engine/public/routes.py's refresh_company → the [...refresh]
    parametrisation reds and names it.
"""

from __future__ import annotations

import os

import pytest
from fastapi.testclient import TestClient

# The routes under test. The floor below is asserted against the real app so
# this gate cannot go vacuous by a rename.
REFRESH_ROUTE = "/api/public/companies/AAPL/refresh"
SIGNALS_ROUTE = "/api/public/intelligence/refresh-signals"
GUARDED_ROUTES = [REFRESH_ROUTE, SIGNALS_ROUTE]
GUARDED_ROUTE_FLOOR = 2

# Route templates as FastAPI registers them (path params unsubstituted).
GUARDED_TEMPLATES = {
    "/api/public/companies/{ticker}/refresh",
    "/api/public/intelligence/refresh-signals",
}

TEST_BUDGET_PER_MIN = 3
REAL_TOKEN = "the-real-operator-token"

# A spoofed leftmost hop (caller-written) in front of the real Caddy-appended
# peer. Keying on hops[0] would let this rotate a fresh bucket per request.
REAL_PEER = "203.0.113.7"


def _xff(spoof: str, peer: str = REAL_PEER) -> dict:
    return {"x-forwarded-for": "%s, %s" % (spoof, peer)}


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
def client(app_and_client, monkeypatch):
    """Fresh bucket table + a small, deterministic budget per test."""
    from engine.public import refresh_shield

    monkeypatch.setenv("PUBLIC_REFRESH_RATE_PER_MIN", str(TEST_BUDGET_PER_MIN))
    monkeypatch.setenv("PUBLIC_REFRESH_RATE_BURST", str(TEST_BUDGET_PER_MIN))
    monkeypatch.delenv("ENGINE_API_TOKEN", raising=False)
    refresh_shield.reset_limiter()
    yield app_and_client[1]
    refresh_shield.reset_limiter()


# ── the floor: the gate cannot go vacuous ────────────────────────────────

def test_both_guarded_routes_still_exist_on_the_real_app(app_and_client):
    """If a route is renamed this reds instead of silently testing nothing."""
    app, _ = app_and_client
    posts = {
        r.path
        for r in app.routes
        if "POST" in (getattr(r, "methods", None) or set())
    }
    missing = GUARDED_TEMPLATES - posts
    assert not missing, (
        "guarded cache-bust route(s) missing from the real app — renamed or "
        "unmounted, so this gate would test nothing: %s" % sorted(missing))
    covered = GUARDED_TEMPLATES & posts
    assert len(covered) >= GUARDED_ROUTE_FLOOR, (
        "route-coverage floor breached: expected >= %d guarded cache-bust "
        "routes, found %d (%s)" % (GUARDED_ROUTE_FLOOR, len(covered), sorted(covered)))


# ── under the budget: unchanged behaviour ────────────────────────────────

@pytest.mark.parametrize("path", GUARDED_ROUTES)
def test_under_the_budget_the_refresh_still_works(client, path):
    for i in range(TEST_BUDGET_PER_MIN):
        r = client.post(path)
        assert r.status_code == 200, (
            "a refresh WITHIN the budget must still work — %s call %d gave %s: %s"
            % (path, i + 1, r.status_code, r.text[:200]))
        assert "error" not in r.json(), (path, r.json())


def test_under_the_budget_the_payloads_are_byte_for_byte_unchanged(client):
    """The success bodies are the pre-shield contract; the FE reads them."""
    r = client.post(REFRESH_ROUTE)
    assert r.status_code == 200
    assert r.json() == {
        "ticker": "AAPL",
        "refreshed": ["universe_warm_cache", "price_history_cache"],
        "message": (
            "Caches cleared. The next read for this ticker will hit the "
            "configured providers (live SF1/SEP when entitled, demo "
            "fallback otherwise)."
        ),
    }
    r2 = client.post(SIGNALS_ROUTE)
    assert r2.status_code == 200
    body = r2.json()
    assert body["ok"] is True and "cache_keys_invalidated" in body, body


# ── over the budget: 429, Retry-After, and NOTHING mutated ───────────────

@pytest.mark.parametrize("path", GUARDED_ROUTES)
def test_anonymous_calls_are_limited_after_the_budget(client, path):
    for _ in range(TEST_BUDGET_PER_MIN):
        assert client.post(path).status_code == 200
    r = client.post(path)
    assert r.status_code == 429, (
        "ROUTE IS UNSHIELDED — %s answered %s to the N+1st anonymous "
        "cache-bust in the window (budget %d/min). An unbounded loop here "
        "forces cold upstream reads until the provider blocks the host."
        % (path, r.status_code, TEST_BUDGET_PER_MIN))
    assert r.headers.get("Retry-After"), (
        "%s: a 429 must carry Retry-After so a caller can back off" % path)
    assert int(r.headers["Retry-After"]) >= 1
    body = r.json()
    assert body["error"]["code"] == "public_refresh_rate_limited", body
    assert "NOT performed" in body["error"]["message"], body
    assert body["error"]["details"]["refreshed"] == [], body


def test_a_limited_call_mutates_no_cache(client):
    """A 429 must not have cleared anything on its way out."""
    from engine.public import price_history_service as ph
    from engine.public import universe_service as us

    for _ in range(TEST_BUDGET_PER_MIN):
        assert client.post(REFRESH_ROUTE).status_code == 200

    us._warm_cache["sentinel"] = {"_cached_at": 0.0, "payload": {"keep": "me"}}
    ph._warm_cache["sentinel"] = {"_cached_at": 0.0, "payload": {"keep": "me"}}
    assert client.post(REFRESH_ROUTE).status_code == 429
    assert us._warm_cache.get("sentinel"), (
        "the 429 path cleared the universe warm cache — the shield must "
        "run BEFORE any mutation")
    assert ph._warm_cache.get("sentinel"), (
        "the 429 path cleared the price-history cache — the shield must "
        "run BEFORE any mutation")
    us._warm_cache.pop("sentinel", None)
    ph._warm_cache.pop("sentinel", None)


def test_a_limited_signals_call_invalidates_nothing(client):
    from engine.public.intelligence.intelligence_cache import get_intelligence_cache

    for _ in range(TEST_BUDGET_PER_MIN):
        assert client.post(SIGNALS_ROUTE).status_code == 200
    cache = get_intelligence_cache()
    cache.put("risk-radar:sentinel", {"keep": "me"}, 600)
    assert client.post(SIGNALS_ROUTE).status_code == 429
    assert cache.get("risk-radar:sentinel") == {"keep": "me"}, (
        "the 429 path invalidated the intelligence cache — the shield must "
        "run BEFORE any mutation")


# ── the operator bearer is never limited ─────────────────────────────────

@pytest.mark.parametrize("path", GUARDED_ROUTES)
def test_a_valid_bearer_is_never_limited(client, monkeypatch, path):
    """Prove it by blowing far past the budget while authenticated."""
    monkeypatch.setenv("ENGINE_API_TOKEN", REAL_TOKEN)
    hdrs = {"Authorization": "Bearer %s" % REAL_TOKEN}
    for i in range(TEST_BUDGET_PER_MIN * 4):
        r = client.post(path, headers=hdrs)
        assert r.status_code == 200, (
            "the operator bearer must never be rate limited — %s call %d "
            "gave %s" % (path, i + 1, r.status_code))
    # ...and it spent no anonymous tokens on the way.
    assert client.post(path).status_code == 200, (
        "bearer calls consumed the anonymous bucket")


def test_a_wrong_bearer_is_treated_as_anonymous_not_accepted(client, monkeypatch):
    """Not 401 — that would be a probing oracle. It just spends a token."""
    monkeypatch.setenv("ENGINE_API_TOKEN", REAL_TOKEN)
    hdrs = {"Authorization": "Bearer not-the-token"}
    for _ in range(TEST_BUDGET_PER_MIN):
        r = client.post(REFRESH_ROUTE, headers=hdrs)
        assert r.status_code == 200, (r.status_code, r.text[:160])
    r = client.post(REFRESH_ROUTE, headers=hdrs)
    assert r.status_code == 429, (
        "a WRONG bearer must be treated as anonymous and limited, not "
        "accepted — got %s" % r.status_code)


def test_absent_token_leaves_the_anonymous_path_working(client, monkeypatch):
    """ABSENT != ZERO, and deliberately NOT test_cron_auth.py's fail-closed.

    Refusing here would break a working public surface to protect a cache.
    """
    monkeypatch.delenv("ENGINE_API_TOKEN", raising=False)
    r = client.post(REFRESH_ROUTE)
    assert r.status_code == 200, (
        "with ENGINE_API_TOKEN unset the anonymous limited path must still "
        "serve (503 here would be the cron contract, not this one) — got %s"
        % r.status_code)
    r2 = client.post(REFRESH_ROUTE, headers={"Authorization": "Bearer anything"})
    assert r2.status_code == 200
    from engine.public import refresh_shield

    assert refresh_shield.has_operator_bearer(
        type("R", (), {"headers": {"authorization": "Bearer anything"}})()
    ) is False, "an unset token must never authorise a bearer"


# ── the key is the RIGHTMOST forwarded hop ───────────────────────────────

@pytest.mark.parametrize("path", GUARDED_ROUTES)
def test_rotating_a_spoofed_leftmost_hop_cannot_mint_new_buckets(client, path):
    """Caddy APPENDS the real peer, so hops[0] is always caller-written.

    engine.public_ro.ratelimit._client_ip reads hops[0]; this shield does
    NOT use it for exactly this reason (see refresh_shield's docstring).
    """
    for i in range(TEST_BUDGET_PER_MIN):
        r = client.post(path, headers=_xff("10.0.0.%d" % i))
        assert r.status_code == 200, (i, r.status_code)
    r = client.post(path, headers=_xff("10.0.0.99"))
    assert r.status_code == 429, (
        "BUCKET SPLIT ON A SPOOFED HOP — %s answered %s after the budget "
        "was spent, because a rotating leftmost X-Forwarded-For minted a "
        "fresh bucket. Key on the RIGHTMOST hop." % (path, r.status_code))


def test_distinct_real_peers_do_get_distinct_buckets(client):
    """The control: rightmost keying must still separate real clients."""
    for i in range(TEST_BUDGET_PER_MIN):
        assert client.post(REFRESH_ROUTE, headers=_xff("10.0.0.1")).status_code == 200
    assert client.post(REFRESH_ROUTE, headers=_xff("10.0.0.1")).status_code == 429
    r = client.post(REFRESH_ROUTE, headers=_xff("10.0.0.1", peer="198.51.100.4"))
    assert r.status_code == 200, (
        "a different REAL peer must get its own bucket — got %s" % r.status_code)


def test_the_shields_hop_semantics_match_the_funnels(client):
    """Single authority by assertion: these two must not drift apart.

    funnel._client_ip is the repo's hardened (D2) rightmost reader.
    """
    from engine.public import refresh_shield
    from engine.public_ro import funnel

    class _Req:
        def __init__(self, xff):
            self.headers = {"x-forwarded-for": xff}
            self.client = None

    for raw in (
        "10.9.9.9, 203.0.113.7",
        "203.0.113.7",
        "10.9.9.9, 10.8.8.8, 203.0.113.7",
        "10.9.9.9, 203.0.113.7 ,  ",
    ):
        assert refresh_shield._client_ip_rightmost(_Req(raw)) == funnel._client_ip(_Req(raw)), (
            "refresh_shield and funnel disagree on the client hop for %r" % raw)


def test_the_shield_and_the_limiter_read_the_same_hop(client):
    """One topology, one hop reader.

    This test used to PIN a divergence: ``ratelimit._client_ip`` read
    ``hops[0]`` — the caller-written hop — so the shield kept a private
    rightmost copy. Pinning another module's defect as an invariant meant
    that repairing it turned this gate red, which pressures the next
    engineer to revert the repair. The defect was fixed at source on
    2026-09-04 and the copy was removed; what must hold now is AGREEMENT,
    across the whole family that keys abuse controls on the client.
    """
    from engine.public import refresh_shield
    from engine.public_ro import ratelimit, funnel

    class _Req:
        def __init__(self, xff):
            self.headers = {"x-forwarded-for": xff}
            self.client = None

    for chain in ("10.9.9.9, %s" % REAL_PEER,
                  "203.0.113.1, 198.51.100.4, %s" % REAL_PEER,
                  "  1.1.1.1 ,  %s  " % REAL_PEER,
                  REAL_PEER):
        req = _Req(chain)
        got = refresh_shield._client_ip_rightmost(req)
        assert got == REAL_PEER, (
            "SHIELD KEYS ON A SPOOFABLE HOP — %r gave %r, not the peer our own "
            "proxy appended (%r). Rotating the leftmost hop would mint a fresh "
            "bucket per request." % (chain, got, REAL_PEER))
        assert got == ratelimit._client_ip(req) == funnel._client_ip(req), (
            "HOP SEMANTICS DRIFTED on %r: shield=%r ratelimit=%r funnel=%r"
            % (chain, got, ratelimit._client_ip(req), funnel._client_ip(req)))


def test_a_rate_below_one_does_not_take_the_route_down(client, monkeypatch):
    """The DERIVED burst, not just the explicit one.

    TokenBucketLimiter defaults burst to the rate and raises below 1, at
    request time. So PUBLIC_REFRESH_RATE_PER_MIN=0.5 — exactly what an
    operator writes to mean "one bust every two minutes" — took every
    shielded route to a hard 500. The first clamp covered only the explicit
    burst, and every fixture sets BURST explicitly, so no test walked the
    default path.
    """
    from engine.public import refresh_shield

    monkeypatch.delenv("PUBLIC_REFRESH_RATE_BURST", raising=False)
    for bad in ("0.5", "0.9", "0.99", "0.01"):
        monkeypatch.setenv("PUBLIC_REFRESH_RATE_PER_MIN", bad)
        refresh_shield.reset_limiter()
        r = client.post("/api/public/intelligence/refresh-signals")
        assert r.status_code != 500, (
            "MISCONFIGURED BUDGET TOOK THE ROUTE DOWN — "
            "PUBLIC_REFRESH_RATE_PER_MIN=%r gave 500: %s" % (bad, r.text[:200]))
    monkeypatch.delenv("PUBLIC_REFRESH_RATE_PER_MIN", raising=False)
    refresh_shield.reset_limiter()


def test_a_burst_below_one_does_not_take_the_route_down(client, monkeypatch):
    """A misconfigured budget must not 500 a working public surface.

    ``TokenBucketLimiter`` raises on burst < 1, and it raises at REQUEST
    time, so ``PUBLIC_REFRESH_RATE_BURST=0`` (or 0.5) turned every shielded
    route into a hard 500 — while a non-numeric value was caught and
    ignored. The asymmetry made it look covered.
    """
    from engine.public import refresh_shield

    for bad in ("0", "0.5", "-3", "abc", ""):
        monkeypatch.setenv("PUBLIC_REFRESH_RATE_BURST", bad)
        refresh_shield.reset_limiter()
        r = client.post("/api/public/intelligence/refresh-signals")
        assert r.status_code != 500, (
            "MISCONFIGURED BUDGET TOOK THE ROUTE DOWN — "
            "PUBLIC_REFRESH_RATE_BURST=%r gave 500: %s" % (bad, r.text[:200]))
    monkeypatch.delenv("PUBLIC_REFRESH_RATE_BURST", raising=False)
    refresh_shield.reset_limiter()

def test_the_shield_imports_the_storefront_token_bucket(client):
    from engine.public import refresh_shield
    from engine.public_ro import ratelimit

    assert isinstance(refresh_shield.get_limiter(), ratelimit.TokenBucketLimiter)
    # ...but with its own table: the storefront's browsing budget must not
    # be spendable on cache busts, nor vice versa.
    assert refresh_shield.get_limiter() is not ratelimit.get_limiter()


def test_one_budget_is_shared_across_both_routes(client):
    """Keyed by client, NOT by (client, route).

    Cold upstream reads are a shared resource; a per-route budget would let
    a loop alternate between the two routes for double the fan-out.
    """
    for _ in range(TEST_BUDGET_PER_MIN):
        assert client.post(REFRESH_ROUTE).status_code == 200
    r = client.post(SIGNALS_ROUTE)
    assert r.status_code == 429, (
        "the second cache-bust route handed out a FRESH budget to a client "
        "that had already spent theirs — alternating routes would double the "
        "cold-read fan-out. One bucket per client, not per route. Got %s"
        % r.status_code)


def test_the_default_budget_is_the_documented_one():
    from engine.public import refresh_shield

    assert refresh_shield.DEFAULT_REFRESH_PER_MIN == 5, (
        "the budget is derived from the shortest TTL these routes bust "
        "(SIGNALS_TTL_SEC = 60 s → 1/min is the useful ceiling, 5x headroom). "
        "Changing it means re-deriving it in the module docstring.")
