"""Every public route's OUTBOUND cost, measured AT THE TRANSPORT, under every
activation shape — and the guard on each route keyed on what THAT route
spends.

Third file in the /api/public control series (``test_public_refresh_shield``
proves the bust limiter; ``test_public_post_surface`` classifies the
mutating routes). Rebuilt 2026-09-05 after a critic instrumented the
transport with SUCCESSFUL canned responses and found the previous map —
built with spies that RAISED, at the provider function, with the six
activation variables unset — had been green over four open amplifiers:

  E1  GET .../companies/{t}/signals was classified NO_EGRESS. With the five
      signal variables set it fanned out 13 times on EVERY call (newsapi,
      an RSS feed, 5x FRED, 5x EIA, GDELT), uncached, unguarded; 400
      anonymous calls = 5,200 outbound, 0 x 429. A nonsense ticker cost the
      same 13. newsapi.org is a 100/day tier: one client, 8 hits, quota gone.
  E2  GET .../risk-score guarded on the UNIVERSE's warmth while its compute
      ran the signal sweep: universe warmed once, 150 distinct tickers from
      one client = 1,950 outbound, 0 x 429, 0 tokens spent.
  E3  build_company_exposure_profile(try_filings=True) -> SEC EDGAR + a paid
      completion, reached from exposure / risk-score / supply-chain /
      ai-market-read, guarded on the universe only. With SEC_EDGAR_ENABLED +
      ANTHROPIC_API_KEY: 9 distinct tickers on supply-chain at a 3/min
      budget = 9 completions, 0 x 429. Verified on this tree before the fix.
  E4  GET /macro-signals cached on a CALLER-supplied key.
  E5  The map was enumerated under NASDAQ_API_KEY + ANTHROPIC_API_KEY only.

THE METHOD (tests/engine/public/egress_wire.py)
==============================================
Nothing above the transport is patched. ``urllib`` at ``OpenerDirector
.open`` (below ``urlopen``), ``httpx`` at ``Client.send`` (loopback passed
through — the TestClient rides httpx too), the LLM as a recording
``anthropic`` module (the SDK is NOT installed here, so without the stub the
paid path measures 0), and a socket tripwire under all three that must never
fire. Every body is a 200 a real parser accepts, so a chain whose next URL
comes out of the last body (EDGAR: 4 hops then a completion) runs to its end.

WHAT THE MAP DEPENDS ON — stated, and enumerated
================================================
Eight environment variables decide what this surface can reach:

    NASDAQ_API_KEY      ANTHROPIC_API_KEY        (the production shape)
    NEWS_API_KEY  RSS_FEED_URLS  FRED_API_KEY  EIA_API_KEY  GDELT_ENABLED
    SEC_EDGAR_ENABLED                            (the six activation vars)

Every cost assertion runs under NINE shapes: none of the six, all six, each
of the six ALONE, and KEYLESS (nothing at all — the shape the old map
measured). ``COST`` is the model: per route, which RESOURCES its compute
touches, and per resource, which hosts and how many calls under a shape.
The numbers are measurements, not derivations; a drift reds with the
measured and the expected side by side.

THE THREE RULES THIS FILE ENFORCES
==================================
 1. warm => zero. Wherever a route hands ``egress_guard`` ``warm=True``,
    the call it guards makes ZERO outbound calls and ZERO completions.
    Instrumented by wrapping the guard and recording the flag per call.
 2. A nonsense ticker costs nothing. Malformed -> 400/404 with zero
    outbound on every route; a well-formed UNKNOWN symbol -> 404 with zero
    outbound on every intelligence route (validated against the served
    registry), and on the three routes where the provider is the authority
    on existence (/companies/{t}, /sync: one exact-then-retry TICKERS lookup,
    2 calls; /price-history: one SEP query, 1 call) that cost cold and ZERO
    warm — recorded, not hidden.
 3. Daily ceilings. newsapi.org stops below its 100/day tier and the feed
    serves last-known; paid completions stop at PUBLIC_LLM_COMPLETIONS_PER_
    DAY on BOTH paid paths and the deterministic narrative says why; one
    (ticker, accession) is extracted at most once per process.

PLANT (TC-2) — each in an ISOLATED COPY, red observed, reverted:
  · intelligence/routes.py ticker_exposure: ``warm=_profile_warm(tu)`` ->
    ``warm=_universe_warm()`` (a NEIGHBOUR's flag).
    RED: test_warm_means_zero_outbound_and_zero_completions[...exposure]
         and test_distinct_tickers_on_a_warm_universe_are_budgeted[...].
  · intelligence/routes.py ticker_signals: delete ``_validated_ticker``
    (use ``ticker.upper()``).
    RED: test_a_nonsense_ticker_costs_nothing[...signals...].
  · intelligence/routes.py ticker_exposure: delete the ``_egress_guard``
    block.
    RED: test_a_cold_read_is_budgeted[GET .../exposure].
  · adapters/news_signal_adapter.py: ``open_with_ceiling`` ->
    ``urllib.request.urlopen``.
    RED: test_newsapi_stops_below_its_daily_tier_and_serves_last_known.
  · ai_market_read.py ClaudeMarketReadClient.complete: delete the
    ``reserve_completion`` line.
    RED: test_paid_completions_stop_at_the_daily_ceiling_on_both_paths.
"""

from __future__ import annotations

import collections
import importlib.util
import os
import socket
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

# ── the harness, loaded by path ──────────────────────────────────────────
_WIRE_PATH = Path(__file__).resolve().parent / "public" / "egress_wire.py"
_spec = importlib.util.spec_from_file_location("public_egress_wire", str(_WIRE_PATH))
wire = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(wire)  # type: ignore[union-attr]


# ── classes ──────────────────────────────────────────────────────────────
NO_EGRESS = "NO_EGRESS"
GUARDED = "GUARDED"
BUST = "BUST"
UPSTREAM_SHIELDED = "UPSTREAM_SHIELDED"
WALLED = "WALLED"

# ── resources: what a route's compute can touch ──────────────────────────
UNIVERSE = "UNIVERSE"          # universe_service hydration (Nasdaq batch + Yahoo BVB sweep)
FEED = "FEED"                  # the six-adapter signal fan-out
FILINGS = "FILINGS"            # SEC EDGAR chain + Claude extraction + our filings DB
LLM = "LLM"                    # the ai-market-read completion
NASDAQ_ENVELOPE = "NASDAQ_ENVELOPE"
NASDAQ_SEARCH = "NASDAQ_SEARCH"
NASDAQ_SYNC = "NASDAQ_SYNC"
BVB_HISTORY = "BVB_HISTORY"
FILINGS_OBS = "FILINGS_OBS"    # /intelligence/health's two DB selects

# ── the map: (method, template) -> (class, concrete url, resources) ──────
ROUTES = {
    ("GET", "/api/public/health"): (NO_EGRESS, "/api/public/health", ()),
    ("GET", "/api/public/status"): (NO_EGRESS, "/api/public/status", ()),
    ("GET", "/api/public/sectors"): (NO_EGRESS, "/api/public/sectors", ()),
    ("GET", "/api/public/universe/search"): (NO_EGRESS, "/api/public/universe/search?q=app", ()),
    ("GET", "/api/public/search"): (GUARDED, "/api/public/search?q=app&limit=20", (NASDAQ_SEARCH,)),
    ("GET", "/api/public/companies/{ticker}"): (GUARDED, "/api/public/companies/AAPL", (NASDAQ_ENVELOPE,)),
    ("GET", "/api/public/companies/{ticker}/price-history"):
        (GUARDED, "/api/public/companies/TLV/price-history?range=1M", (BVB_HISTORY,)),
    ("GET", "/api/public/universe"): (GUARDED, "/api/public/universe", (UNIVERSE,)),
    ("POST", "/api/public/companies/compare"): (NO_EGRESS, "/api/public/companies/compare", ()),
    ("POST", "/api/public/companies/{ticker}/refresh"): (BUST, "/api/public/companies/AAPL/refresh", ()),
    ("POST", "/api/public/companies/{ticker}/sync"):
        (UPSTREAM_SHIELDED, "/api/public/companies/AAPL/sync", (NASDAQ_SYNC,)),
    ("GET", "/api/public/intelligence/health"):
        (GUARDED, "/api/public/intelligence/health", (FILINGS_OBS,)),
    ("GET", "/api/public/intelligence/risk-radar"): (NO_EGRESS, "/api/public/intelligence/risk-radar", ()),
    ("GET", "/api/public/intelligence/macro-signals"):
        (GUARDED, "/api/public/intelligence/macro-signals", (FEED,)),
    ("GET", "/api/public/intelligence/companies/{ticker}/signals"):
        (GUARDED, "/api/public/intelligence/companies/AAPL/signals", (FEED,)),
    ("GET", "/api/public/intelligence/supply-chain"):
        (GUARDED, "/api/public/intelligence/supply-chain?ticker=AAPL", (UNIVERSE, FILINGS)),
    ("GET", "/api/public/intelligence/companies/{ticker}/risk-score"):
        (GUARDED, "/api/public/intelligence/companies/AAPL/risk-score", (UNIVERSE, FEED, FILINGS)),
    ("GET", "/api/public/intelligence/companies/{ticker}/exposure"):
        (GUARDED, "/api/public/intelligence/companies/AAPL/exposure", (UNIVERSE, FILINGS)),
    ("GET", "/api/public/intelligence/companies/{ticker}/ai-market-read"):
        (GUARDED, "/api/public/intelligence/companies/AAPL/ai-market-read",
         (UNIVERSE, FEED, FILINGS, LLM)),
    ("GET", "/api/public/intelligence/risk-scores"):
        (GUARDED, "/api/public/intelligence/risk-scores", (UNIVERSE,)),
    ("POST", "/api/public/intelligence/refresh-signals"):
        (BUST, "/api/public/intelligence/refresh-signals", ()),
    ("POST", "/api/public/intelligence/refresh-filings-cache"):
        (WALLED, "/api/public/intelligence/refresh-filings-cache", ()),
    ("POST", "/api/public/intelligence/signals/manual"):
        (WALLED, "/api/public/intelligence/signals/manual", ()),
    # public_market: READ-ONLY BY DESIGN (its get_company "never fetches from
    # the feed on a web request"). Asserted, not believed.
    ("GET", "/api/public/markets"): (NO_EGRESS, "/api/public/markets", ()),
    ("GET", "/api/public/markets/"): (NO_EGRESS, "/api/public/markets/", ()),
    ("GET", "/api/public/markets/universe"): (NO_EGRESS, "/api/public/markets/universe", ()),
    ("GET", "/api/public/markets/search"): (NO_EGRESS, "/api/public/markets/search?q=app", ()),
    ("GET", "/api/public/markets/company/{market}/{ticker}"):
        (NO_EGRESS, "/api/public/markets/company/us/AAPL", ()),
    # RO storefront: local store, its OWN limiter (engine.public_ro.ratelimit).
    ("GET", "/api/public/ro/companies"): (NO_EGRESS, "/api/public/ro/companies", ()),
    ("GET", "/api/public/ro/companii"): (NO_EGRESS, "/api/public/ro/companii", ()),
    ("GET", "/api/public/ro/companies/{key}"): (NO_EGRESS, "/api/public/ro/companies/probe-1234567", ()),
    ("GET", "/api/public/ro/companii/{key}"): (NO_EGRESS, "/api/public/ro/companii/probe-1234567", ()),
    ("GET", "/api/public/ro/search"): (NO_EGRESS, "/api/public/ro/search?q=probe", ()),
    ("GET", "/api/public/ro/sector/{slug}"): (NO_EGRESS, "/api/public/ro/sector/agricultura", ()),
    ("GET", "/api/public/ro/sectors/{slug}"): (NO_EGRESS, "/api/public/ro/sectors/agricultura", ()),
    ("GET", "/api/public/ro/judet/{slug}"): (NO_EGRESS, "/api/public/ro/judet/cluj", ()),
    ("GET", "/api/public/ro/counties/{slug}"): (NO_EGRESS, "/api/public/ro/counties/cluj", ()),
    ("GET", "/api/public/ro/og/companii/{name}"): (NO_EGRESS, "/api/public/ro/og/companii/probe", ()),
    ("GET", "/api/public/ro/sitemap.xml"): (NO_EGRESS, "/api/public/ro/sitemap.xml", ()),
    ("GET", "/api/public/ro/sitemaps/{shard}.xml.gz"): (NO_EGRESS, "/api/public/ro/sitemaps/0001.xml.gz", ()),
    ("GET", "/api/public/ro/teardowns"): (NO_EGRESS, "/api/public/ro/teardowns", ()),
    ("POST", "/api/public/ro/event"): (NO_EGRESS, "/api/public/ro/event", ()),
    ("POST", "/api/public/ro/takedown"): (WALLED, "/api/public/ro/takedown", ()),
    ("POST", "/api/public/ro/companies/{cui}/teardown"):
        (WALLED, "/api/public/ro/companies/1234567/teardown", ()),
}

BODIES = {
    "/api/public/companies/compare": {"tickers": ["AAPL", "MSFT"]},
    "/api/public/ro/event": {"kind": "page_view"},
    "/api/public/ro/takedown": {"cui": "1234567", "action": "remove",
                                "reason": "gate", "verified_by": "gate"},
    "/api/public/intelligence/signals/manual": {
        "signal_type": "geopolitical", "title": "Gate probe signal",
        "summary": "A payload the schema accepts.", "severity": "high"},
}

# Per-ticker routes and how to address a nonsense ticker on each.
TICKER_ROUTES = {
    ("GET", "/api/public/companies/{ticker}"): "/api/public/companies/%s",
    ("GET", "/api/public/companies/{ticker}/price-history"): "/api/public/companies/%s/price-history?range=1M",
    ("POST", "/api/public/companies/{ticker}/sync"): "/api/public/companies/%s/sync",
    ("POST", "/api/public/companies/{ticker}/refresh"): "/api/public/companies/%s/refresh",
    ("GET", "/api/public/intelligence/companies/{ticker}/signals"): "/api/public/intelligence/companies/%s/signals",
    ("GET", "/api/public/intelligence/supply-chain"): "/api/public/intelligence/supply-chain?ticker=%s",
    ("GET", "/api/public/intelligence/companies/{ticker}/risk-score"): "/api/public/intelligence/companies/%s/risk-score",
    ("GET", "/api/public/intelligence/companies/{ticker}/exposure"): "/api/public/intelligence/companies/%s/exposure",
    ("GET", "/api/public/intelligence/companies/{ticker}/ai-market-read"): "/api/public/intelligence/companies/%s/ai-market-read",
}
# Routes where the PROVIDER is the authority on whether a well-formed symbol
# exists (Sharadar's whole TICKERS table is served, not the 291-ticker
# registry). A well-formed unknown costs ONE provider question cold there —
# the adapter's exact-then-retry TICKERS lookup (2 calls) on /companies and
# /sync, a single SEP query (1 call) on /price-history — recorded, not hidden.
UNKNOWN_LOOKUP_COST = {
    ("GET", "/api/public/companies/{ticker}"): {"data.nasdaq.com": 2},
    ("POST", "/api/public/companies/{ticker}/sync"): {"data.nasdaq.com": 2},
    ("GET", "/api/public/companies/{ticker}/price-history"): {"data.nasdaq.com": 1},
}
PROVIDER_AUTHORITY_ROUTES = {
    ("GET", "/api/public/companies/{ticker}"),
    ("GET", "/api/public/companies/{ticker}/price-history"),
    ("POST", "/api/public/companies/{ticker}/sync"),
}
MALFORMED_TICKERS = ["ZZZZNOTAREALTICKER", "..%2F..%2Fetc%2Fpasswd", "A" * 64, "%3Cscript%3E"]
WELL_FORMED_UNKNOWN = "ZZQQ"

# ── the shapes ───────────────────────────────────────────────────────────
ACTIVATION = {
    "NEWS_API_KEY": "gate-news-key",
    "RSS_FEED_URLS": "https://feeds.example/gate.xml",
    "FRED_API_KEY": "gate-fred-key",
    "EIA_API_KEY": "gate-eia-key",
    "GDELT_ENABLED": "1",
    "SEC_EDGAR_ENABLED": "1",
}
PRODUCTION = {"NASDAQ_API_KEY": "gate-nasdaq-key", "ANTHROPIC_API_KEY": "gate-anthropic-key"}
ALL_VARS = sorted(set(ACTIVATION) | set(PRODUCTION) | {"NASDAQ_DATA_LINK_API_KEY"})

SHAPES = {"none": {}, "all": dict(ACTIVATION), "keyless": {}}
for _v in ACTIVATION:
    SHAPES["only:" + _v] = {_v: ACTIVATION[_v]}
SHAPE_NAMES = sorted(SHAPES)


def _on(shape: str, var: str) -> bool:
    if var in PRODUCTION:
        return shape != "keyless"
    return var in SHAPES[shape]


# ── the cost model — MEASURED numbers ────────────────────────────────────

def _cost_of(resource: str, shape: str) -> dict:
    c: collections.Counter = collections.Counter()
    if resource == UNIVERSE:
        # 203 tickers in 3 chunks x (SF1 + DAILY) = 6 Nasdaq calls; the BVB
        # seed sweep is 5 Yahoo spark calls and happens on the demo path too.
        if _on(shape, "NASDAQ_API_KEY"):
            c["data.nasdaq.com"] += 6
        c["query1.finance.yahoo.com"] += 5
    elif resource == FEED:
        if _on(shape, "NEWS_API_KEY"):
            c["newsapi.org"] += 1
        if _on(shape, "RSS_FEED_URLS"):
            c["feeds.example"] += 1
        if _on(shape, "FRED_API_KEY"):
            c["api.stlouisfed.org"] += 5
        if _on(shape, "EIA_API_KEY"):
            c["api.eia.gov"] += 5
        if _on(shape, "GDELT_ENABLED"):
            c["api.gdeltproject.org"] += 1
    elif resource == FILINGS:
        if _on(shape, "SEC_EDGAR_ENABLED") and _on(shape, "ANTHROPIC_API_KEY"):
            c["test.supabase.co"] += 2          # DB read-through miss + write-through
            c["www.sec.gov"] += 3               # tickers map + index + primary document
            c["data.sec.gov"] += 1              # submissions
            c["api.anthropic.com"] += 1         # the paid extraction
    elif resource == LLM:
        if _on(shape, "ANTHROPIC_API_KEY"):
            c["api.anthropic.com"] += 1
    elif resource == NASDAQ_ENVELOPE:
        if _on(shape, "NASDAQ_API_KEY"):
            c["data.nasdaq.com"] += 2           # TICKERS hit + SF1 (empty -> no DAILY)
    elif resource == NASDAQ_SEARCH:
        if _on(shape, "NASDAQ_API_KEY"):
            # NasdaqAdapter.search is exact-then-retry: a query that is not
            # itself a symbol misses the exact pass and is re-asked without
            # the SF1 table filter. Two calls for the driven "app".
            c["data.nasdaq.com"] += 2
    elif resource == NASDAQ_SYNC:
        if _on(shape, "NASDAQ_API_KEY"):
            c["data.nasdaq.com"] += 4           # 2 dimensions x (TICKERS + SF1)
    elif resource == BVB_HISTORY:
        c["query1.finance.yahoo.com"] += 1
    elif resource == FILINGS_OBS:
        c["test.supabase.co"] += 2
    return dict(c)


def expected_cost(key, shape: str) -> dict:
    total: collections.Counter = collections.Counter()
    for res in ROUTES[key][2]:
        total.update(_cost_of(res, shape))
    return dict(total)


REAL_TOKEN = "the-real-operator-token"
REAL_PEER = "203.0.113.7"
OTHER_PEER = "203.0.113.9"
TEST_EGRESS_BUDGET = 3
TEST_BUST_BUDGET = 2
BIG = "100000"


# ── fixtures ─────────────────────────────────────────────────────────────

@pytest.fixture(scope="module")
def gdelt_cache_path(tmp_path_factory) -> str:
    return str(tmp_path_factory.mktemp("gdelt") / "gdelt_cache.json")


@pytest.fixture(scope="module")
def app(gdelt_cache_path):
    os.environ.setdefault("VITE_SUPABASE_URL", "https://test.supabase.co")
    os.environ.setdefault("VITE_SUPABASE_ANON_KEY", "test-anon")
    os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test-service")
    os.environ["CFO_AI_SKIP_BOOT_VERIFY"] = "1"
    # This suite builds the REAL app and measures the public-markets
    # surface, so it must mount it. Production leaves it UNMOUNTED
    # (PUBLIC_MARKETS_ENABLED unset — the launch posture: Public
    # Companies ships hidden); that absence is asserted by
    # tests/engine/test_launch_survival.py.
    os.environ["PUBLIC_MARKETS_ENABLED"] = "1"
    os.environ["GDELT_CACHE_PATH"] = gdelt_cache_path
    assert "test." in os.environ["VITE_SUPABASE_URL"], "refusing a non-manifest Supabase URL"
    from engine.api.server import create_app

    return create_app()


@pytest.fixture
def rec(monkeypatch):
    """Transport spies + socket tripwire. Yields the Recorder; asserts no escape."""
    r = wire.install(monkeypatch)
    yield r
    assert r.escapes == [], (
        "A TRANSPORT ESCAPED THE SPIES and reached a real socket: %r. Every "
        "count in this module is a lie until that transport is patched." % r.escapes)


def _apply_shape(monkeypatch, shape: str, gdelt_cache_path: str, *,
                 egress_budget: str = BIG, bust_budget: str = BIG) -> None:
    for v in ALL_VARS:
        monkeypatch.delenv(v, raising=False)
    if shape != "keyless":
        for k, v in PRODUCTION.items():
            monkeypatch.setenv(k, v)
    for k, v in SHAPES[shape].items():
        monkeypatch.setenv(k, v)
    monkeypatch.delenv("ENGINE_API_TOKEN", raising=False)
    monkeypatch.delenv("PUBLIC_PROVIDER_DAILY_CEILINGS", raising=False)
    monkeypatch.delenv("PUBLIC_LLM_COMPLETIONS_PER_DAY", raising=False)
    monkeypatch.setenv("PUBLIC_EGRESS_RATE_PER_MIN", egress_budget)
    monkeypatch.setenv("PUBLIC_EGRESS_RATE_BURST", egress_budget)
    monkeypatch.setenv("PUBLIC_REFRESH_RATE_PER_MIN", bust_budget)
    monkeypatch.setenv("PUBLIC_REFRESH_RATE_BURST", bust_budget)
    monkeypatch.setenv("GDELT_CACHE_PATH", gdelt_cache_path)
    wire.cold(gdelt_cache_path)


@pytest.fixture
def client(app, rec, monkeypatch, gdelt_cache_path):
    """The ALL shape, big budgets, cold. Use ``_apply_shape`` to change."""
    _apply_shape(monkeypatch, "all", gdelt_cache_path)
    c = TestClient(app, raise_server_exceptions=False)
    yield c
    wire.cold(gdelt_cache_path)


def _call(client, method, url, **kw):
    body = BODIES.get(url.split("?")[0])
    if method == "GET":
        return client.get(url, **kw)
    if body is not None:
        return client.post(url, json=body, **kw)
    return client.post(url, **kw)


def _xff(peer, spoof="198.51.100.1"):
    return {"x-forwarded-for": "%s, %s" % (spoof, peer)}


def _rid(v):
    return v if isinstance(v, str) else " ".join(v)


# ── the inventory: no unclassified public route ──────────────────────────

def _live_routes(app):
    out = set()
    for r in app.routes:
        p = getattr(r, "path", "")
        if not (p == "/api/public" or p.startswith("/api/public/")):
            continue
        for m in (getattr(r, "methods", None) or set()):
            if m in ("HEAD", "OPTIONS"):
                continue
            out.add((m, p))
    return out


def test_every_public_route_is_classified_and_driven(app):
    live = _live_routes(app)
    unclassified = live - set(ROUTES)
    assert not unclassified, (
        "UNCLASSIFIED PUBLIC ROUTE(S) — no measured egress cost on record: %s. "
        "Add each to ROUTES with its class, a concrete URL and the RESOURCES "
        "its compute touches, then run this file: the cold-cost test measures "
        "it under every shape." % sorted(unclassified))
    stale = set(ROUTES) - live
    assert not stale, "classified but no longer on the app: %s" % sorted(stale)
    assert len(live) >= 40, "public route-coverage floor breached: %d" % len(live)
    guarded = [k for k, v in ROUTES.items() if v[0] == GUARDED]
    assert len(guarded) >= 10, "GUARDED floor breached: %d" % len(guarded)
    assert set(TICKER_ROUTES) <= set(ROUTES)


def test_the_map_states_the_variables_it_depends_on():
    """Every variable the cost model reads is enumerated as a shape."""
    import inspect

    src = inspect.getsource(_cost_of)
    read = {v for v in ALL_VARS if '"%s"' % v in src}
    assert read == set(ACTIVATION) | {"NASDAQ_API_KEY", "ANTHROPIC_API_KEY"}, read
    for v in ACTIVATION:
        assert "only:" + v in SHAPES, "activation variable %s has no solo shape" % v
    assert {"none", "all", "keyless"} <= set(SHAPES)


# ── rule 0: the cold cost is the measured one, under every shape ─────────

@pytest.mark.parametrize("shape", SHAPE_NAMES)
@pytest.mark.parametrize("key", sorted(ROUTES), ids=_rid)
def test_the_cold_cost_is_the_measured_one(app, rec, monkeypatch, gdelt_cache_path, key, shape):
    _apply_shape(monkeypatch, shape, gdelt_cache_path)
    client = TestClient(app, raise_server_exceptions=False)
    method, path = key
    cls, url, _ = ROUTES[key]
    rec.reset()
    r = _call(client, method, url, headers=_xff(REAL_PEER))
    # A typed 503 envelope (nasdaq_key_missing in the keyless shape, or a
    # walled route with no token) is a refusal, not a crash; only 500 is.
    assert r.status_code != 500, (
        "%s %s CRASHED under shape %s: %s" % (method, path, shape, r.text[:200]))
    if cls == WALLED:
        assert r.status_code == 503, (method, path, r.status_code)
    if cls in (NO_EGRESS, BUST, WALLED):
        assert rec.hosts() == {}, (
            "EGRESS MAP IS WRONG — %s %s is classified %s but reached %r under "
            "shape %s. Either it grew an upstream dependency (it needs a cache "
            "and refresh_shield.egress_guard, and its class becomes GUARDED) or "
            "the classification was never true." % (method, path, cls, rec.hosts(), shape))
    assert rec.hosts() == expected_cost(key, shape), (
        "COLD COST DRIFTED — %s %s under shape %s reached %r, the map says %r. "
        "Re-measure, then update the resource list or the per-resource cost "
        "with the new number and the reason." % (method, path, shape, rec.hosts(),
                                                  expected_cost(key, shape)))


# ── rule 1a: a warm repeat costs zero outbound and zero completions ──────

@pytest.mark.parametrize("shape", SHAPE_NAMES)
@pytest.mark.parametrize("key", sorted(k for k, v in ROUTES.items() if v[0] in (GUARDED, NO_EGRESS)), ids=_rid)
def test_a_repeat_inside_the_window_costs_zero(app, rec, monkeypatch, gdelt_cache_path, key, shape):
    _apply_shape(monkeypatch, shape, gdelt_cache_path)
    client = TestClient(app, raise_server_exceptions=False)
    method, path = key
    cls, url, _ = ROUTES[key]
    first = _call(client, method, url, headers=_xff(REAL_PEER))
    assert first.status_code != 429
    cold = rec.hosts()
    rec.reset()
    for i in range(3):
        r = _call(client, method, url, headers=_xff(REAL_PEER))
        assert rec.calls == [], (
            "NO CACHE — %s %s reached %r on repeat %d inside its window (cold "
            "cost was %r) under shape %s. One anonymous GET must not equal one "
            "provider call forever." % (method, path, rec.hosts(), i + 1, cold, shape))
        assert rec.completions() == 0
        assert r.status_code != 429, (
            "a WARM repeat was rate limited: %s %s repeat %d" % (method, path, i + 1))


# ── rule 1b: warm => zero, PER ROUTE, read off the guard itself ──────────

@pytest.fixture
def guard_log(monkeypatch):
    """Wrap ``egress_guard`` in both routers; record (route, warm) per call."""
    from engine.public import refresh_shield
    from engine.public import routes as public_routes
    from engine.public.intelligence import routes as intel_routes

    log: list = []
    real = refresh_shield.egress_guard

    def _wrapped(request, *, route, warm):
        log.append((route, bool(warm)))
        return real(request, route=route, warm=warm)

    monkeypatch.setattr(public_routes, "_egress_guard", _wrapped)
    monkeypatch.setattr(intel_routes, "_egress_guard", _wrapped)
    return log


GUARDED_KEYS = sorted(k for k, v in ROUTES.items() if v[0] == GUARDED)


def _states(client, key):
    """Ways to make the NEIGHBOURS warm while this route's own cache is cold.

    Each state is a callable that prepares the world; the test then drives
    the route once and checks that IF the guard said warm, nothing went out.
    The states are exactly the ones the critics used: universe warm alone,
    feed warm alone, both warm, and everything warm but this route's own
    rendered cache dropped.
    """
    from engine.public.intelligence import intelligence_cache as ic

    def _cold_all():
        wire.cold(os.environ.get("GDELT_CACHE_PATH"))

    def _universe_warm():
        _cold_all()
        client.get("/api/public/universe")

    def _feed_warm():
        _cold_all()
        client.get("/api/public/intelligence/macro-signals")

    def _both_warm():
        _universe_warm()
        client.get("/api/public/intelligence/macro-signals")

    def _all_but_own():
        _both_warm()
        # Fill every intelligence cache for AAPL, then drop only THIS
        # route's rendered entry so its guard must decide from the resources.
        for u in ("/api/public/intelligence/companies/AAPL/exposure",
                  "/api/public/intelligence/companies/AAPL/risk-score",
                  "/api/public/intelligence/companies/AAPL/ai-market-read",
                  "/api/public/intelligence/health",
                  "/api/public/intelligence/risk-scores"):
            client.get(u)
        own = {
            ("GET", "/api/public/intelligence/companies/{ticker}/exposure"): "exposure:",
            ("GET", "/api/public/intelligence/supply-chain"): "exposure:",
            ("GET", "/api/public/intelligence/companies/{ticker}/risk-score"): "risk-score:",
            ("GET", "/api/public/intelligence/companies/{ticker}/ai-market-read"): "ai-market-read:",
            ("GET", "/api/public/intelligence/health"): "filings-observability:",
            ("GET", "/api/public/intelligence/risk-scores"): "risk-scores:",
        }.get(key)
        if own:
            ic.get_intelligence_cache().invalidate(own)

    return [("cold", _cold_all), ("universe-warm", _universe_warm),
            ("feed-warm", _feed_warm), ("both-warm", _both_warm),
            ("all-but-own", _all_but_own)]


@pytest.mark.parametrize("key", GUARDED_KEYS, ids=_rid)
def test_warm_means_zero_outbound_and_zero_completions(client, rec, guard_log, key):
    """THE RULE. Whenever a route tells the guard warm=True, the call it
    guards makes zero outbound calls and zero completions — under the ALL
    shape, where every resource is live. Read off the guard, so a route
    that keys warmth on a NEIGHBOUR's cache (the E2 / E3 shape) reds here
    with the resource it forgot in the message.
    """
    method, path = key
    _, url, _ = ROUTES[key]
    for state, prepare in _states(client, key):
        prepare()
        guard_log.clear()
        rec.reset()
        r = _call(client, method, url, headers=_xff(REAL_PEER))
        assert r.status_code < 500, (state, r.status_code, r.text[:200])
        mine = [w for route, w in guard_log if route == path]
        assert mine, "the guard was not consulted by %s %s in state %s" % (method, path, state)
        if mine[-1]:
            assert rec.calls == [] and rec.completions() == 0, (
                "WARM WAS A LIE — %s %s told egress_guard warm=True in state %r "
                "and then reached %r (%d completion(s)). The flag is reading a "
                "neighbour's cache; it must be the conjunction of every resource "
                "THIS route's compute touches." % (method, path, state, rec.hosts(),
                                                    rec.completions()))
    # The converse, for the subject check: after a full cold call the route's
    # own cache is warm, and a repeat MUST report warm (or the flag is
    # useless and every repeat spends a token).
    guard_log.clear()
    _call(client, method, url, headers=_xff(REAL_PEER))
    guard_log.clear()
    rec.reset()
    _call(client, method, url, headers=_xff(REAL_PEER))
    assert [w for route, w in guard_log if route == path][-1] is True, (
        "%s %s never reports warm even on an immediate repeat" % (method, path))
    assert rec.calls == [] and rec.completions() == 0


def test_a_universe_warm_alone_is_not_warm_for_the_routes_that_spend_more(client, rec, guard_log):
    """E2 / E3 as a direct property: with ONLY the universe warm, every
    route whose compute also touches the feed or the filings chain must
    report warm=False. The general rule above catches this too; this names
    the exact defect so the plant reds with a message about it.
    """
    for key in GUARDED_KEYS:
        resources = set(ROUTES[key][2])
        if not (resources & {FEED, FILINGS, LLM}):
            continue
        method, path = key
        _, url, _ = ROUTES[key]
        # EVERYTHING cold (including the filings memory an earlier route in
        # this loop may have filled), then the universe alone warmed.
        wire.cold(os.environ.get("GDELT_CACHE_PATH"))
        client.get("/api/public/universe")
        guard_log.clear()
        _call(client, method, url, headers=_xff(REAL_PEER))
        mine = [w for route, w in guard_log if route == path]
        assert mine and mine[-1] is False, (
            "A NEIGHBOUR'S WARMTH — %s %s reported warm=%r with only the "
            "universe warm, while its compute touches %s." % (method, path, mine, sorted(resources)))


# ── rule 1c: the budget binds on distinct tickers with a warm universe ───

@pytest.mark.parametrize("leaf", ["exposure", "risk-score", "ai-market-read", "signals", "supply-chain"])
def test_distinct_tickers_on_a_warm_universe_are_budgeted(app, rec, monkeypatch, gdelt_cache_path, leaf):
    """The critics' measurement, re-run as the gate: universe warmed once,
    then DISTINCT tickers from one client at a 3/min budget. Before the fix:
    150 tickers, 1,950 outbound, 0 x 429 (E2); 9 tickers, 9 completions
    (E3). Now: at most the budget is served, the rest are 429 and spend
    nothing, and no served call is free.
    """
    _apply_shape(monkeypatch, "all", gdelt_cache_path, egress_budget=str(TEST_EGRESS_BUDGET))
    client = TestClient(app, raise_server_exceptions=False)
    client.get("/api/public/universe", headers=_xff(OTHER_PEER))   # warm it on ANOTHER client
    client.get("/api/public/intelligence/macro-signals", headers=_xff(OTHER_PEER))
    tickers = ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "AMD"]
    served, refused, spent = 0, 0, 0
    rec.reset()
    for t in tickers:
        before = len(rec.calls)
        if leaf == "supply-chain":
            r = client.get("/api/public/intelligence/supply-chain?ticker=%s" % t, headers=_xff(REAL_PEER))
        else:
            r = client.get("/api/public/intelligence/companies/%s/%s" % (t, leaf), headers=_xff(REAL_PEER))
        if r.status_code == 429:
            refused += 1
            assert len(rec.calls) == before, "a 429 spent %r upstream" % rec.calls[before:]
        else:
            assert r.status_code == 200, (t, r.status_code, r.text[:200])
            served += 1
            spent += len(rec.calls) - before
    if leaf == "signals":
        # The feed is ticker-INDEPENDENT: every ticker filters the same
        # cached list, so all eight are warm and free — zero outbound is the
        # property here, not a 429.
        assert served == len(tickers) and spent == 0 and rec.completions() == 0, (
            "signals on a warm feed spent %d outbound over %d tickers" % (spent, served))
        return
    assert refused >= len(tickers) - TEST_EGRESS_BUDGET, (
        "DISTINCT TICKERS WERE FREE on /%s — %d served, %d refused of %d at a "
        "budget of %d/min with the universe warm; %d outbound spent." % (
            leaf, served, refused, len(tickers), TEST_EGRESS_BUDGET, spent))
    assert served <= TEST_EGRESS_BUDGET
    # A served ticker pays at most TWO completions: the filings extraction
    # (once per ticker per 10-K) and, on ai-market-read only, the narrative.
    assert rec.completions() <= 2 * TEST_EGRESS_BUDGET, (
        "PAID COMPLETIONS OUTRAN THE BUDGET on /%s: %d" % (leaf, rec.completions()))


# ── rule 2: a nonsense ticker costs nothing ──────────────────────────────

@pytest.mark.parametrize("shape", ["all", "none", "keyless"])
@pytest.mark.parametrize("key", sorted(TICKER_ROUTES), ids=_rid)
def test_a_nonsense_ticker_costs_nothing(app, rec, monkeypatch, gdelt_cache_path, key, shape):
    _apply_shape(monkeypatch, shape, gdelt_cache_path)
    client = TestClient(app, raise_server_exceptions=False)
    method, path = key
    fmt = TICKER_ROUTES[key]
    for junk in MALFORMED_TICKERS:
        wire.cold(gdelt_cache_path)
        rec.reset()
        r = _call(client, method, fmt % junk, headers=_xff(REAL_PEER))
        assert r.status_code in (400, 404, 422), (method, path, junk, r.status_code, r.text[:160])
        assert rec.calls == [], (
            "A MALFORMED IDENTIFIER REACHED A PROVIDER — %s %s with %r cost %r "
            "under shape %s. Validate the shape before the guard." % (
                method, path, junk, rec.hosts(), shape))
    # well-formed but unknown
    wire.cold(gdelt_cache_path)
    rec.reset()
    r = _call(client, method, fmt % WELL_FORMED_UNKNOWN, headers=_xff(REAL_PEER))
    if key in PROVIDER_AUTHORITY_ROUTES:
        # The provider is asked whether the symbol exists (one exact-then-
        # retry lookup); the negative answer is cached on the GETs, and
        # /sync sits behind the bust budget.
        allowed = UNKNOWN_LOOKUP_COST[key] if _on(shape, "NASDAQ_API_KEY") else {}
        assert rec.hosts() in (allowed, {}), (
            "%s %s with unknown %r cost %r; the recorded residual is %r" % (
                method, path, WELL_FORMED_UNKNOWN, rec.hosts(), allowed))
        if method == "GET":
            rec.reset()
            _call(client, method, fmt % WELL_FORMED_UNKNOWN, headers=_xff(REAL_PEER))
            assert rec.calls == [], (
                "NEGATIVE ANSWER NOT CACHED — %s %s asked the provider about %r "
                "again on a repeat: %r" % (method, path, WELL_FORMED_UNKNOWN, rec.hosts()))
    elif ROUTES[key][0] == BUST:
        # /refresh accepts any well-formed symbol: it busts caches and
        # reaches nothing, so an unknown one costs exactly what a known
        # one does — zero.
        assert rec.calls == [], (method, path, rec.hosts())
    else:
        assert r.status_code in (400, 404), (method, path, r.status_code, r.text[:160])
        assert rec.calls == [], (
            "AN UNKNOWN TICKER REACHED A PROVIDER — %s %s with %r cost %r under "
            "shape %s. The ticker must be validated against the served registry "
            "BEFORE the guard and before any fan-out." % (
                method, path, WELL_FORMED_UNKNOWN, rec.hosts(), shape))
        assert rec.completions() == 0


def test_no_cache_key_carries_caller_text(client, rec):
    """Server-derived keys, and the caller-keyed caches hold only symbols.

    The intelligence cache must carry NO caller text at all. Three caches are
    keyed on an identifier the caller supplies by design (/companies/{t},
    /search, /price-history — free-text lookups on a provider-authority
    surface); they are bounded, and only a well-formed symbol can reach a
    write there, so the junk below must appear in none of them either.
    """
    from engine.public import price_history_service as ph
    from engine.public import routes as public_routes
    from engine.public.intelligence.intelligence_cache import get_intelligence_cache

    junk = "ZQXJ" * 6
    for key, fmt in TICKER_ROUTES.items():
        _call(client, key[0], fmt % junk)
    for u in ("/api/public/intelligence/macro-signals?sector=%s&ticker=%s&limit=7" % (junk, junk),
              "/api/public/intelligence/supply-chain?sector=%s" % junk,
              "/api/public/intelligence/macro-signals",
              "/api/public/intelligence/companies/AAPL/signals"):
        client.get(u)
    polluted = [k for k in get_intelligence_cache()._store if junk in k.upper()]
    assert polluted == [], "CALLER TEXT IN A SERVER CACHE KEY: %r" % polluted
    feed_keys = [k for k in get_intelligence_cache()._store if k.startswith("macro-signals:")]
    assert feed_keys == ["macro-signals:__feed__"], feed_keys
    for store, name in ((public_routes._company_cache, "company"),
                        (public_routes._search_cache, "search"),
                        (ph._warm_cache, "price-history")):
        assert not [k for k in store if junk in k.upper()], (name, list(store)[:5])
    assert public_routes._MAX_CACHE_KEYS <= 20_000 and ph._MAX_CACHE_KEYS <= 20_000


# ── the guard: budgeted, keyed on the last hop, honest ───────────────────

@pytest.mark.parametrize("key", GUARDED_KEYS, ids=_rid)
def test_a_cold_read_is_budgeted(app, rec, monkeypatch, gdelt_cache_path, key):
    """Over the budget: 429, and NOTHING is fetched on the way out.

    Every call is deliberately COLD (the caches are dropped between calls,
    the bucket is kept) so the guard is the only thing that can stop it.
    """
    _apply_shape(monkeypatch, "all", gdelt_cache_path, egress_budget=str(TEST_EGRESS_BUDGET))
    client = TestClient(app, raise_server_exceptions=False)
    method, path = key
    _, url, _ = ROUTES[key]
    for i in range(TEST_EGRESS_BUDGET):
        wire.cold(gdelt_cache_path, keep_budget=True)
        r = _call(client, method, url, headers=_xff(REAL_PEER))
        assert r.status_code != 429, ("a cold read WITHIN the budget must work", method, path, i)
    wire.cold(gdelt_cache_path, keep_budget=True)
    spent = list(rec.calls)
    r = _call(client, method, url, headers=_xff(REAL_PEER))
    assert r.status_code == 429, (
        "ROUTE IS UNGUARDED — %s %s answered %s to the N+1st COLD anonymous read "
        "from one client (budget %d/min). This route reaches a data provider on "
        "every cold call, so an unbounded loop drives cold upstream reads until "
        "the provider blocks the host." % (method, path, r.status_code, TEST_EGRESS_BUDGET))
    assert rec.calls == spent, (
        "%s %s spent %r on its way to a 429 — the guard must run BEFORE the fetch"
        % (method, path, rec.calls[len(spent):]))


def _burn(client, peer):
    for i in range(TEST_EGRESS_BUDGET):
        r = client.get("/api/public/search?q=burn%d" % i, headers=_xff(peer))
        assert r.status_code != 429


@pytest.fixture
def budgeted(app, rec, monkeypatch, gdelt_cache_path):
    _apply_shape(monkeypatch, "all", gdelt_cache_path,
                 egress_budget=str(TEST_EGRESS_BUDGET), bust_budget=str(TEST_BUST_BUDGET))
    return TestClient(app, raise_server_exceptions=False)


def test_the_budget_keys_on_the_last_forwarded_hop(budgeted, rec):
    _burn(budgeted, REAL_PEER)
    assert budgeted.get("/api/public/search?q=over", headers=_xff(REAL_PEER)).status_code == 429
    rotated = budgeted.get("/api/public/search?q=rot", headers=_xff(REAL_PEER, spoof="198.51.100.99"))
    assert rotated.status_code == 429, (
        "SHIELD BYPASSABLE BY A HEADER — a fresh budget by rotating the LEFTMOST "
        "X-Forwarded-For hop. Key on the LAST hop, the one our proxy appended.")
    assert budgeted.get("/api/public/search?q=other", headers=_xff(OTHER_PEER)).status_code != 429


def test_one_client_shares_one_egress_budget_across_routes(budgeted, rec):
    _burn(budgeted, REAL_PEER)
    r = budgeted.get("/api/public/intelligence/companies/MSFT/exposure", headers=_xff(REAL_PEER))
    assert r.status_code == 429, "a FRESH budget on another route: %s" % r.status_code


def test_a_limited_caller_learns_that_nothing_was_fetched(budgeted, rec):
    _burn(budgeted, REAL_PEER)
    r = budgeted.get("/api/public/search?q=refused", headers=_xff(REAL_PEER))
    assert r.status_code == 429 and int(r.headers["Retry-After"]) >= 1
    body = r.json()
    assert body["error"]["code"] == "public_egress_rate_limited"
    assert "NOT fetched" in body["error"]["message"]
    assert body["error"]["details"]["fetched"] == []


def test_the_two_budgets_are_separate_buckets(budgeted, rec):
    _burn(budgeted, REAL_PEER)
    assert budgeted.get("/api/public/search?q=x", headers=_xff(REAL_PEER)).status_code == 429
    assert budgeted.post("/api/public/companies/AAPL/refresh", headers=_xff(REAL_PEER)).status_code == 200


@pytest.mark.parametrize("url", [
    "/api/public/universe?refresh=true",
    "/api/public/companies/TLV/price-history?range=1M&refresh=true",
])
def test_a_query_parameter_cannot_force_an_unbounded_cold_read(budgeted, rec, url):
    for i in range(TEST_BUST_BUDGET):
        r = budgeted.get(url, headers=_xff(REAL_PEER))
        assert r.status_code == 200 and r.json().get("refresh_honored") is True, (url, i)
    spent = list(rec.calls)
    r = budgeted.get(url, headers=_xff(REAL_PEER))
    body = r.json()
    assert r.status_code == 200 and body.get("refresh_honored") is False, (
        "UNBOUNDED FORCED COLD READ — %s honored refresh=true past the bust budget" % url)
    assert "NOT honored" in (body.get("refresh_message") or "")
    assert rec.calls == spent


def test_an_operator_bearer_may_still_force_a_cold_read(budgeted, rec, monkeypatch):
    monkeypatch.setenv("ENGINE_API_TOKEN", REAL_TOKEN)
    hdrs = dict(_xff(REAL_PEER))
    hdrs["Authorization"] = "Bearer %s" % REAL_TOKEN
    for i in range(TEST_BUST_BUDGET * 3):
        r = budgeted.get("/api/public/universe?refresh=true", headers=hdrs)
        assert r.status_code == 200 and r.json().get("refresh_honored") is True, i


# ── rule 3: the daily ceilings ───────────────────────────────────────────

def test_newsapi_stops_below_its_daily_tier_and_serves_last_known(app, rec, monkeypatch, gdelt_cache_path):
    """newsapi.org is 100/day; the feed cache is 60 s; a caller who keeps
    the feed cold spends the day's quota in 100 minutes. The per-host
    ledger stops at PROVIDER_HOST_CEILINGS (80 by default, 2 here), the
    provider is never asked again that day, and the feed keeps serving the
    LAST successful poll's news signals with the reason on /health.
    """
    from engine.public import egress_ledger
    from engine.public.intelligence import intelligence_cache as ic

    _apply_shape(monkeypatch, "only:NEWS_API_KEY", gdelt_cache_path)
    monkeypatch.setenv("PUBLIC_PROVIDER_DAILY_CEILINGS", "newsapi.org=2")
    egress_ledger.reset_ledgers()
    assert egress_ledger.PROVIDER_HOST_CEILINGS["newsapi.org"] < 100, "the default must sit BELOW the tier"
    client = TestClient(app, raise_server_exceptions=False)
    titles = []
    for i in range(5):
        ic.reset_intelligence_cache()      # keep the feed COLD, as an abuser would
        r = client.get("/api/public/intelligence/macro-signals")
        assert r.status_code == 200, (i, r.text[:200])
        titles.append(sorted(s["title"] for s in r.json()["signals"] if s["source"].startswith("newsapi")))
    assert rec.hosts().get("newsapi.org") == 2, (
        "NEWSAPI QUOTA UNBOUNDED — 5 cold feed reads reached newsapi.org %d "
        "time(s) with a ceiling of 2/day." % rec.hosts().get("newsapi.org", 0))
    assert titles[0] and all(t == titles[0] for t in titles), (
        "the feed did not keep serving last-known news past the ceiling: %r" % titles)
    health = client.get("/api/public/intelligence/health").json()
    assert "ceiling" in (health["adapters"]["news"].get("last_error") or ""), health["adapters"]["news"]
    assert health["egress_ledgers"]["provider_hosts"]["used"]["newsapi.org"] == 2


def test_paid_completions_stop_at_the_daily_ceiling_on_both_paths(app, rec, monkeypatch, gdelt_cache_path):
    """One wallet, two paid paths. With PUBLIC_LLM_COMPLETIONS_PER_DAY=2:
    the first two tickers pay, every later one gets the deterministic
    narrative (model_id says why) and the sector profile, and NOTHING more
    goes to api.anthropic.com or to EDGAR — the pre-check refuses before
    the first EDGAR hop, not after three of them.
    """
    from engine.public import egress_ledger

    _apply_shape(monkeypatch, "all", gdelt_cache_path)
    monkeypatch.setenv("PUBLIC_LLM_COMPLETIONS_PER_DAY", "2")
    egress_ledger.reset_ledgers()
    client = TestClient(app, raise_server_exceptions=False)
    client.get("/api/public/universe")
    client.get("/api/public/intelligence/macro-signals")
    rec.reset()
    # Filings path: exposure for distinct tickers.
    sources = []
    for t in ("AAPL", "MSFT", "NVDA", "AMZN"):
        r = client.get("/api/public/intelligence/companies/%s/exposure" % t)
        assert r.status_code == 200, r.text[:200]
        sources.append(r.json()["source"])
    assert rec.completions() == 2, "FILINGS COMPLETIONS UNBOUNDED: %d" % rec.completions()
    assert sources == ["filings", "filings", "sector_model", "sector_model"], sources
    edgar_after = {h: n for h, n in rec.hosts().items() if h.endswith("sec.gov")}
    assert edgar_after == {"www.sec.gov": 5, "data.sec.gov": 2}, (
        "EDGAR was asked past the completion ceiling: %r" % edgar_after)
    # Market-read path: the same wallet is already empty.
    rec.reset()
    reads = []
    for t in ("AAPL", "MSFT"):
        r = client.get("/api/public/intelligence/companies/%s/ai-market-read" % t)
        assert r.status_code == 200, r.text[:200]
        reads.append(r.json()["model_id"])
    assert rec.completions() == 0, "MARKET-READ COMPLETIONS PAST THE CEILING: %d" % rec.completions()
    assert all(m.startswith("deterministic_v1 (completion ceiling reached") for m in reads), reads
    health = client.get("/api/public/intelligence/health").json()
    assert health["egress_ledgers"]["completions"] == {"used_today": 2, "limit_per_day": 2}


def test_one_filing_is_extracted_at_most_once_per_process(app, rec, monkeypatch, gdelt_cache_path):
    """The (ticker, accession) memo. With the filings DB refusing writes —
    the local / DB-down shape, where filings_cache deliberately leaves
    the in-memory layer empty — the same 10-K used to be fetched and PAID
    FOR again on every call. Now the accession is looked up (one EDGAR
    hop) and the extraction is reused.
    """
    from engine.public.intelligence import filings_cache

    _apply_shape(monkeypatch, "all", gdelt_cache_path)
    monkeypatch.setattr(filings_cache, "_db_put", lambda profile: False)
    client = TestClient(app, raise_server_exceptions=False)
    client.get("/api/public/universe")
    from engine.public.intelligence import intelligence_cache as ic
    rec.reset()
    assert client.get("/api/public/intelligence/companies/AAPL/exposure").json()["source"] == "filings"
    assert rec.completions() == 1
    ic.reset_intelligence_cache()          # drop the rendered profile; DB has nothing
    rec.reset()
    assert client.get("/api/public/intelligence/companies/AAPL/exposure").json()["source"] == "filings"
    assert rec.completions() == 0, "THE SAME FILING WAS PAID FOR TWICE"
    assert rec.hosts().get("www.sec.gov", 0) <= 1 and rec.hosts().get("data.sec.gov", 0) == 1, rec.hosts()


def test_the_default_ceilings_are_the_documented_ones():
    from engine.public import egress_ledger as L

    assert L.DEFAULT_COMPLETIONS_PER_DAY == 300
    assert L.PROVIDER_HOST_CEILINGS["newsapi.org"] == 80
    for host in ("api.stlouisfed.org", "api.eia.gov", "api.gdeltproject.org", "www.sec.gov", "data.sec.gov"):
        assert host in L.PROVIDER_HOST_CEILINGS
    L.reset_ledgers()
    assert L.completions().limit("llm") == 300
    assert L.provider_hosts().limit("newsapi.org") == 80
    assert L.provider_hosts().limit("an.unlisted.host") == L.DEFAULT_HOST_CEILING


def test_a_misconfigured_ceiling_falls_back_rather_than_500s(monkeypatch):
    from engine.public import egress_ledger as L

    monkeypatch.setenv("PUBLIC_LLM_COMPLETIONS_PER_DAY", "nonsense")
    monkeypatch.setenv("PUBLIC_PROVIDER_DAILY_CEILINGS", "newsapi.org=abc,,=,api.eia.gov=7")
    L.reset_ledgers()
    assert L.completions().limit("llm") == 300
    assert L.provider_hosts().limit("newsapi.org") == 80
    assert L.provider_hosts().limit("api.eia.gov") == 7
    L.reset_ledgers()


# ── the page a real visitor loads must still work ────────────────────────

MARKETS_PAGE_TILES = 24


def _markets_page_urls():
    from engine.public.bvb_seed import bvb_universe

    page = list(bvb_universe().keys())[:MARKETS_PAGE_TILES]
    return (["/api/public/universe", "/api/public/intelligence/risk-radar"]
            + ["/api/public/companies/%s/price-history?range=1M" % t for t in page])


def test_the_measured_markets_page_load_fits_the_default_budget(app, rec, monkeypatch, gdelt_cache_path):
    """On the SHIPPED default budget: the cold page is not refused, and its
    warm replay costs zero. MEASURED at the transport: 11 (universe) + 24
    (one Yahoo call per tile) = 35 outbound cold, 0 warm.
    """
    from engine.public import refresh_shield

    _apply_shape(monkeypatch, "all", gdelt_cache_path)
    for v in ("PUBLIC_EGRESS_RATE_PER_MIN", "PUBLIC_EGRESS_RATE_BURST",
              "PUBLIC_REFRESH_RATE_PER_MIN", "PUBLIC_REFRESH_RATE_BURST"):
        monkeypatch.delenv(v, raising=False)
    refresh_shield.reset_limiter()
    client = TestClient(app, raise_server_exceptions=False)
    urls = _markets_page_urls()
    for u in urls:
        assert client.get(u, headers=_xff(REAL_PEER)).status_code != 429, (
            "THE SHIELD BROKE THE PAGE at %s (budget %d/min)" % (u, refresh_shield.DEFAULT_EGRESS_PER_MIN))
    cold = len(rec.calls)
    assert cold == 35, "the cold markets page changed size: %d (%r)" % (cold, rec.hosts())
    assert cold <= refresh_shield.DEFAULT_EGRESS_PER_MIN
    rec.reset()
    for u in urls:
        assert client.get(u, headers=_xff(REAL_PEER)).status_code != 429
    assert rec.calls == [], "the warm replay cost %d" % len(rec.calls)


# ── the shield's own contract ────────────────────────────────────────────

def test_the_egress_guard_and_the_bust_shield_read_the_same_hop():
    from engine.public import refresh_shield
    from engine.public_ro import ratelimit

    class _Req:
        headers = {"x-forwarded-for": "198.51.100.1, %s" % REAL_PEER}
        client = None

    assert refresh_shield._client_ip_rightmost(_Req()) == REAL_PEER
    assert ratelimit._client_ip(_Req()) == REAL_PEER


def test_the_ro_storefront_carries_its_own_limiter():
    import inspect

    from engine.public_ro import ratelimit
    from engine.public_ro.pages import router as ro_router

    assert inspect.getsource(ro_router).count("ratelimit.check(request)") >= 4
    assert ratelimit._DEFAULT_PER_MIN >= 1


def test_the_three_bucket_tables_are_distinct():
    from engine.public import refresh_shield
    from engine.public_ro import ratelimit

    refresh_shield.reset_limiter()
    assert refresh_shield.get_egress_limiter() is not ratelimit.get_limiter()
    assert refresh_shield.get_egress_limiter() is not refresh_shield.get_limiter()


def test_the_default_budgets_are_the_measured_ones():
    from engine.public import refresh_shield

    assert refresh_shield.DEFAULT_REFRESH_PER_MIN == 5
    assert refresh_shield.DEFAULT_EGRESS_PER_MIN == 120 >= 35


def test_a_misconfigured_egress_budget_throttles_rather_than_500s(monkeypatch):
    from engine.public import refresh_shield

    for per_min, burst in (("0.5", None), ("0", None), ("nonsense", None), ("10", "0"), ("10", "nope")):
        monkeypatch.setenv("PUBLIC_EGRESS_RATE_PER_MIN", per_min)
        if burst is None:
            monkeypatch.delenv("PUBLIC_EGRESS_RATE_BURST", raising=False)
        else:
            monkeypatch.setenv("PUBLIC_EGRESS_RATE_BURST", burst)
        refresh_shield.reset_limiter()
        assert refresh_shield.get_egress_limiter().burst >= 1
    refresh_shield.reset_limiter()


def test_the_harness_reaches_the_app_and_the_spies_succeed(client, rec):
    """TC-9, both halves: the app answered (not the spy), and a cold feed
    carries PARSED live signals from every provider — a raising spy would
    cache an empty feed and make every 'repeat costs zero' vacuous.
    """
    body = client.get("/api/public/intelligence/macro-signals").json()
    assert "feed_status" in body and body["feed_status"] == "live_feed_active"
    live = {s["source"].split(":")[0] for s in body["signals"]} - {"sector_model", "theme"}
    assert live >= {"fred", "eia", "newsapi", "gdelt", "rss"}, sorted(live)
    assert rec.hosts() == expected_cost(("GET", "/api/public/intelligence/macro-signals"), "all")


def test_no_test_in_this_file_opened_a_real_socket(rec):
    assert socket.getaddrinfo.__name__ == "_gai"
    assert socket.create_connection.__name__ == "_create"
