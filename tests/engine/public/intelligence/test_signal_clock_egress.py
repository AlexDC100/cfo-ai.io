"""The signal feed's CLOCK, and its egress measured AT THE TRANSPORT LAYER.

Fourth file in the /api/public control series, and the first one whose
spies SUCCEED. ``test_public_egress.py`` classifies every route's outbound
cost and enforces the class; this one exists because that map — and the two
before it — were built with a spy that RAISED, and a raising spy cannot see
past the first provider response. Everything the signal routes do after
call #1 was invisible to them, including the defect that made four of those
routes answer 500.

WHAT THIS GATE DEPENDS ON — SAY IT PLAINLY
===========================================
The map below is a function of the FIVE SIGNAL ACTIVATION VARIABLES:

    RSS_FEED_URLS   NEWS_API_KEY   EIA_API_KEY   FRED_API_KEY   GDELT_ENABLED

Every adapter reads its own variable at CONSTRUCTION and refuses before the
wire when it is unset, so a fixture that does not set them measures a
keyless deployment and reports zero for routes that fan out thirteen times
in production. ``_activation`` sets all five and
``test_each_activation_variable_alone_still_answers`` walks them ONE AT A
TIME, because the per-variable shape is equally real — and because it is
exactly the shape the defect had: three of the five were reported as 500
and two as 200, and the two "safe" ones were an artefact of the canned body
rather than a property of the code.

``ANTHROPIC_API_KEY`` and ``NASDAQ_DATA_LINK_API_KEY`` are set too — the
PRODUCTION shape. Keyless, the LLM boundary is never constructed and the
Nasdaq adapter refuses before the wire, so the largest amplifier on this
surface (ai-market-read, MEASURED at 25 outbound cold including one paid
completion) would measure as 1.

THE METHOD, AND WHY IT IS THE FINDING
======================================
1. SPIES SUCCEED. Every canned response is a 200 with a URL-aware body a
   real parser accepts. A spy that raises makes every line after the first
   provider response unreachable: the adapters catch their own transport
   errors, degrade to no signals, and the route answers 200 — so a raising
   spy reports a healthy route and a cached empty feed for a code path that
   500s in production on the first real byte.

2. INSTRUMENT BELOW ``urlopen``. The patch is on
   ``urllib.request.OpenerDirector.open``, which is what ``urlopen``
   actually calls. Patching the NAME ``urllib.request.urlopen`` misses
   every module that bound it at import time — ``public_market/esef.py``
   and ``public_market/providers.py`` both do ``_urlopen =
   urllib.request.urlopen`` at module scope.

3. THE LLM IS A TRANSPORT TOO. A recording ``anthropic`` stub, because a
   chain whose next URL comes out of the last response body reports one
   call instead of four and a paid completion.

4. GROUND TRUTH: a socket tripwire that must NEVER fire. It is not a
   control — it is the check on the map itself. If it fires, a transport
   escaped the spies and every number here is a lie. No real socket is
   opened by this module; it runs on a plane.

5. THE HARNESS IS ITSELF SUSPECT (TC-9). The first build of this probe
   patched ``httpx.Client.send`` unconditionally and thereby intercepted
   the TestClient's own in-process transport: every route reported 200
   with one outbound call and the tripwire stayed clean, while NO ROUTE
   EVER RAN. ``test_the_harness_actually_reaches_the_app`` is the positive
   control that makes that failure loud, and ``_LOOPBACK_HOSTS`` is the
   fix.

THE DEFECT THIS PINS
=====================
``MacroSignalService.fetch_all`` built its 90-day cutoff with
``datetime.utcnow()`` — NAIVE — and handed it to five adapters that every
one of them parse provider timestamps into tz-AWARE UTC. The first item any
live provider returned raised ``TypeError: can't compare offset-naive and
offset-aware datetimes`` at an unguarded comparison, and

    GET /api/public/intelligence/macro-signals
    GET /api/public/intelligence/companies/{ticker}/signals
    GET /api/public/intelligence/companies/{ticker}/risk-score
    GET /api/public/intelligence/companies/{ticker}/ai-market-read

answered 500 forever, at a repeat cost of one outbound call each. See
``adapters/base.py`` for the fix and ``as_utc`` / ``is_before``.

PLANT (TC-2) — applied in an ISOLATED COPY, RED observed, reverted, GREEN.
Each line records what ACTUALLY reds, not what was expected to:

  1. macro_signal_service.py — put back ``datetime.utcnow()`` in
     ``fetch_all`` and drop the ``as_utc(since)`` branch.
     RED: test_the_default_cutoff_is_timezone_aware ONLY, 1 failed / 15
     passed. NOT the route tests — the adapters' own ``is_before`` still
     coerces, so the defence-in-depth holds the surface up. That is the
     design working, and it is why the clock needs an assertion of its
     own rather than being inferred from a green route.

  2. adapters/base.py — make ``is_before`` return ``dt < since``.
     RED: test_the_comparison_is_total_in_both_directions ONLY, 1 failed
     / 15 passed. Again not the routes: the cutoff is aware, so aware
     provider stamps still order.

  1+2 TOGETHER — the original defect, exactly.
     RED: 10 failed / 6 passed, including ALL FIVE parametrisations of
     test_every_activation_variable_alone_still_answers ("500 FROM A LIVE
     PROVIDER — GET /api/public/intelligence/macro-signals answered 500
     with FRED_API_KEY set alone …"). All five, including NEWS_API_KEY and
     GDELT_ENABLED, which an earlier map reported as 200.

  3. adapters/manual_signal_adapter.py — put back
     ``(s.published_at or datetime.min) >= since`` and the naive
     ``published_at`` default.
     RED: test_an_operator_signal_survives_the_aware_clock ("THE CLOCK FIX
     ATE THE OPERATOR'S SIGNAL — … returned 0. last_error=\"can't compare
     offset-naive and offset-aware datetimes\""). NO route fails and no
     500 appears: the adapter's broad ``except`` turns the raise into an
     empty list. This plant is the reason that assertion exists.

  4. routes.py — delete the ``_egress_guard`` block in ``health``.
     RED: test_the_health_probe_is_guarded_and_warm_polls_are_free
     ("AN UNBOUNDED COLD READ — 8 cold /health calls against a budget of
     3 were all served [200]").

  5. routes.py — inline the two ``filings_cache`` DB calls back into
     ``health`` instead of ``_filings_observability()``.
     RED: test_the_health_probe_costs_nothing_on_a_repeat ("… reached the
     database 2 time(s) on a REPEAT call") + the guard test.

  THE HARNESS IS PLANTED TOO, because here the method IS the finding:

  6. THIS FILE — convert the ``urllib`` spy back to ``raise OSError``.
     RED: test_the_spies_return_success_rather_than_raising ("… reached 13
     provider endpoint(s) … but the feed carries live signals from only
     []"). The FIRST version of that test asserted ``len(outbound) >= 10``
     and PASSED this plant — the recorder appends before it raises — so
     the assertion was rewritten to require PARSED signals. A gate that
     cannot catch the method it exists to enforce is not a gate.

  7. THIS FILE — delete the ``_LOOPBACK_HOSTS`` pass-through in the httpx
     spy, so the TestClient's own transport is intercepted.
     RED: 6 failed, led by test_the_harness_actually_reaches_the_app
     ("THE HARNESS IS NOT REACHING THE APP …"). Without that positive
     control this plant is INVISIBLE: it makes every route answer 200
     with one outbound call and the socket tripwire clean.
"""

from __future__ import annotations

import io
import json
import os
import socket
import urllib.request
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse

import pytest
from fastapi.testclient import TestClient

# ── The five, and the two that make the shape production-like ────────────
ACTIVATION_VARS = {
    "RSS_FEED_URLS": "https://feeds.example.invalid/business.xml",
    "NEWS_API_KEY": "gate-news-key",
    "EIA_API_KEY": "gate-eia-key",
    "FRED_API_KEY": "gate-fred-key",
    "GDELT_ENABLED": "1",
}
PRODUCTION_SHAPE_VARS = {
    "NASDAQ_DATA_LINK_API_KEY": "gate-nasdaq-key",
    "ANTHROPIC_API_KEY": "gate-anthropic-key",
}

# The four routes the naive clock took down.
SIGNAL_ROUTES = [
    "/api/public/intelligence/macro-signals",
    "/api/public/intelligence/companies/AAPL/signals",
    "/api/public/intelligence/companies/AAPL/risk-score",
    "/api/public/intelligence/companies/AAPL/ai-market-read",
]

# The TestClient's own in-process transport. NOT egress — see method note 5.
_LOOPBACK_HOSTS = {"testserver", "localhost", "127.0.0.1"}


# ── Canned, URL-aware, SUCCESSFUL provider bodies ────────────────────────
#
# Each one carries a REAL TIMESTAMP in the provider's own format. That is
# the whole point: a body without one exercises the parse and never the
# comparison, which is how an earlier map reported NewsAPI and GDELT as
# 200 while they raised identically to the other three.
def _canned_body(url: str) -> bytes:
    host = (urlparse(url).netloc or "").lower()
    path = urlparse(url).path or ""

    if "stlouisfed.org" in host:                       # FRED
        return json.dumps({"observations": [
            {"date": "2026-09-01", "value": "5.10"},
            {"date": "2026-08-29", "value": "4.20"},
        ]}).encode()
    if "eia.gov" in host:                              # EIA
        return json.dumps({"response": {"data": [
            {"period": "2026-09-01", "value": 95.0},
            {"period": "2026-08-29", "value": 70.0},
        ]}}).encode()
    if "newsapi.org" in host:                          # NewsAPI
        return json.dumps({"status": "ok", "articles": [{
            "title": "Oil prices surge on supply disruption",
            "description": "A tariff shock hit energy costs.",
            "content": "c", "url": "https://example.invalid/a",
            "source": {"name": "Reuters"},
            "publishedAt": "2026-09-01T10:00:00Z",
        }]}).encode()
    if "gdeltproject.org" in host:                     # GDELT
        return json.dumps({"articles": [{
            "title": "Taiwan strait tensions escalate",
            "url": "https://example.invalid/taiwan",
            "seendate": "20260901T100000Z",
            "tone": -9.5, "domain": "example.invalid",
        }]}).encode()
    if "yahoo" in host:
        return json.dumps({"chart": {"result": [{
            "meta": {"regularMarketPrice": 10.0, "previousClose": 9.5,
                     "currency": "RON", "symbol": "TLV.RO"},
            "timestamp": [1756684800], "indicators": {"quote": [{"close": [10.0]}]},
        }], "error": None}}).encode()
    if "nasdaq" in host:
        return json.dumps({"dataset_data": {"data": [], "column_names": []}}).encode()
    if path.endswith((".xml", ".rss")) or "rss" in path or "feed" in path:   # RSS
        return (b'<?xml version="1.0"?><rss version="2.0"><channel>'
                b"<item><title>Energy tariff shock raises costs</title>"
                b"<link>https://example.invalid/r</link><description>d</description>"
                b"<pubDate>Tue, 01 Sep 2026 10:00:00 +0000</pubDate></item>"
                b"</channel></rss>")
    return b"{}"


class _CannedResponse(io.BytesIO):
    """Enough of ``http.client.HTTPResponse`` for every caller in this tree."""

    def __init__(self, url: str, body: bytes):
        super().__init__(body)
        self.url, self.status, self.code, self.reason = url, 200, 200, "OK"
        self.headers = {"Content-Type": "application/json"}

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def getcode(self):
        return 200

    def geturl(self):
        return self.url

    def info(self):
        return self.headers


@pytest.fixture
def outbound(monkeypatch):
    """Recording spies at the TRANSPORT, all returning SUCCESS.

    Returns the outbound list — one entry per provider-boundary call, in
    order, as ``(transport, url)``.
    """
    calls: list[tuple[str, str]] = []

    # 1. Below urlopen. Catches `from urllib.request import urlopen` and
    #    every module-scope `_urlopen = urllib.request.urlopen` alias.
    def _opener_open(self, fullurl, data=None, timeout=None):
        url = fullurl if isinstance(fullurl, str) else fullurl.full_url
        calls.append(("urllib", url))
        return _CannedResponse(url, _canned_body(url))

    monkeypatch.setattr(urllib.request.OpenerDirector, "open", _opener_open)

    # 2. httpx — but never the TestClient's own loopback transport.
    import httpx

    _orig_send = httpx.Client.send

    def _send(self, request, **kw):
        if request.url.host in _LOOPBACK_HOSTS:
            return _orig_send(self, request, **kw)
        url = str(request.url)
        calls.append(("httpx", url))
        return httpx.Response(200, json=json.loads(_canned_body(url) or b"{}"),
                              request=request)

    monkeypatch.setattr(httpx.Client, "send", _send)

    # 3. The LLM boundary, recorded like any other transport.
    from engine.public.intelligence import ai_market_read as amr

    class _SpyLlm:
        model_id = "gate-spy"

        def complete(self, system, user):
            calls.append(("anthropic", "https://api.anthropic.com/v1/messages"))
            return ('{"headline": "h", "narrative": "n", '
                    '"what_to_watch": ["w"], "bull_case": "b", "bear_case": "x"}')

    monkeypatch.setattr(amr, "_resolve_default_client", lambda: _SpyLlm())

    # 4. Our OWN Supabase — the /health boundary. Success, not a raise.
    from engine.public.intelligence import filings_cache

    class _SpyDb:
        def select(self, table, filters=None, columns=None):
            calls.append(("supabase", "https://test.supabase.co/rest/v1/%s" % table))
            return []

    monkeypatch.setattr(filings_cache, "_get_admin_client", lambda: _SpyDb())
    return calls


@pytest.fixture(autouse=True)
def _no_real_socket(monkeypatch):
    """GROUND TRUTH. Not a control — the check on the map.

    Every real connection entry point raises. If any test in this module
    trips it, a transport escaped the spies above and every outbound count
    in this file is wrong.
    """
    tripped: list[str] = []

    def _boom(name):
        def _f(*a, **k):
            tripped.append("%s%r" % (name, a[:2]))
            raise AssertionError(
                "REAL SOCKET ATTEMPTED via %s: %r — a transport escaped the "
                "spies and every outbound count in this module is a lie."
                % (name, a[:2]))
        return _f

    monkeypatch.setattr(socket, "getaddrinfo", _boom("getaddrinfo"))
    monkeypatch.setattr(socket, "create_connection", _boom("create_connection"))
    monkeypatch.setattr(socket.socket, "connect", _boom("socket.connect"))
    yield tripped
    assert tripped == [], tripped


def _set_env(monkeypatch, activation: dict) -> None:
    for k in list(ACTIVATION_VARS) + list(PRODUCTION_SHAPE_VARS) + ["ENGINE_API_TOKEN"]:
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("VITE_SUPABASE_URL", "https://test.supabase.co")
    monkeypatch.setenv("VITE_SUPABASE_ANON_KEY", "test-anon")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "test-service")
    monkeypatch.setenv("CFO_AI_SKIP_BOOT_VERIFY", "1")
    # This suite builds the REAL app and measures the public-markets
    # surface, so it must mount it. Production leaves it UNMOUNTED
    # (PUBLIC_MARKETS_ENABLED unset — Public Companies ships hidden).
    monkeypatch.setenv("PUBLIC_MARKETS_ENABLED", "1")
    assert "test." in os.environ["VITE_SUPABASE_URL"], "refusing a non-manifest Supabase URL"
    for k, v in {**PRODUCTION_SHAPE_VARS, **activation}.items():
        monkeypatch.setenv(k, v)


def _cold() -> None:
    """Drop every cache on this path so the next read is genuinely COLD."""
    from engine.public import price_history_service as ph
    from engine.public import routes as public_routes
    from engine.public import universe_service as us
    from engine.public.intelligence import intelligence_cache as ic
    from engine.public.intelligence import macro_signal_service as mss
    from engine.public import refresh_shield

    us.clear_warm_cache()
    us._bvb_quotes_cache["at"] = 0.0
    us._bvb_quotes_cache["quotes"] = {}
    ph.clear_warm_cache()
    public_routes.clear_read_caches()
    ic.reset_intelligence_cache()
    # The adapters read their env at CONSTRUCTION and the service is a
    # process-wide singleton, so a singleton built under a DIFFERENT
    # activation set would silently measure the wrong deployment.
    mss.reset_macro_signal_service()
    refresh_shield.reset_limiter()
    # The DAILY ledgers (engine.public.egress_ledger) are process-wide;
    # a suite that fans the feed out more than 80 times in one process
    # would otherwise watch newsapi.org vanish behind its own ceiling.
    from engine.public import egress_ledger
    egress_ledger.reset_ledgers()


def _client(monkeypatch, activation: dict) -> TestClient:
    _set_env(monkeypatch, activation)
    _cold()
    from engine.api.server import create_app

    return TestClient(create_app(), raise_server_exceptions=False)


# ─────────────────────────────────────────────────────────────────────────
# 0. The harness is itself suspect (TC-9)
# ─────────────────────────────────────────────────────────────────────────

def test_the_harness_actually_reaches_the_app(monkeypatch, outbound):
    """POSITIVE CONTROL. Without it every number in this file is unfalsifiable.

    The first build of this probe patched ``httpx.Client.send``
    unconditionally, intercepted the TestClient's own transport, and
    reported 200 + one outbound call for every route on the surface while
    NO ROUTE RAN and the socket tripwire stayed clean. A clean result was
    indistinguishable from no subject.
    """
    client = _client(monkeypatch, ACTIVATION_VARS)
    body = client.get("/api/public/intelligence/health").json()
    assert "adapters" in body, (
        "THE HARNESS IS NOT REACHING THE APP — /intelligence/health did not "
        "answer the router's payload but %r. Every outbound count in this "
        "module is measuring the spy, not the engine." % sorted(body)[:6])
    assert set(body["adapters"]) >= {"rates", "commodity", "rss", "news", "geopolitical"}


def test_the_spies_return_success_rather_than_raising(monkeypatch, outbound):
    """The method finding, pinned. A raising spy sees nothing past call #1.

    THE DISCRIMINATOR IS THE PARSED FEED, NOT THE CALL COUNT. The first
    version of this test asserted ``len(outbound) >= 10`` and PASSED with
    the spy converted back to ``raise OSError`` — because the recorder
    appends before it raises, and FRED/EIA walk their five series under a
    per-series ``try``, so ten attempts are recorded whether or not one
    byte was ever consumed. Counting attempts measures the harness; only
    a signal that came out of a parsed provider body proves the response
    was READ.

    Every adapter swallows its own transport error and degrades to no
    signals, and the route still answers 200 over an empty-but-cached
    feed. That is exactly the false green the previous maps reported.
    """
    client = _client(monkeypatch, ACTIVATION_VARS)
    body = client.get("/api/public/intelligence/macro-signals").json()
    hosts = {urlparse(u).netloc for _, u in outbound}
    sources = {s["source"].split(":")[0] for s in body["signals"]}
    # `sector_model` / `theme` are SYNTHESIZED server-side and appear even
    # with every provider dead, so they prove nothing and are excluded.
    live = sources - {"sector_model", "theme"}
    assert live >= {"fred", "eia", "newsapi", "gdelt", "rss"}, (
        "THE SPIES ARE NOT SUCCEEDING — a cold macro-signals call reached "
        "%d provider endpoint(s) %r but the feed carries live signals from "
        "only %r. A provider body that is never PARSED means the spy raised "
        "and the adapter swallowed it; every line after the first response "
        "is then unreachable and this whole map is blind past call #1."
        % (len(outbound), sorted(hosts), sorted(live)))
    assert body["feed_status"] == "live_feed_active"
    assert {"api.stlouisfed.org", "api.eia.gov"} <= hosts, sorted(hosts)


# ─────────────────────────────────────────────────────────────────────────
# 1. THE DEFECT — the clock
# ─────────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("var", sorted(ACTIVATION_VARS))
def test_every_activation_variable_alone_still_answers(monkeypatch, outbound, var):
    """Each variable SET ALONE, against a provider that ANSWERS.

    Walked one at a time because that is the shape the defect had and the
    shape a real deployment has — an operator turns one feed on first. The
    all-together case cannot show it: any single working adapter would be
    enough to make a route look alive if the failure were per-adapter, and
    this failure is not per-adapter — it is at the boundary they share.
    """
    client = _client(monkeypatch, {var: ACTIVATION_VARS[var]})
    for route in SIGNAL_ROUTES:
        _cold()
        resp = client.get(route)
        assert resp.status_code != 500, (
            "500 FROM A LIVE PROVIDER — GET %s answered 500 with %s set "
            "alone and the provider returning a SUCCESSFUL body carrying a "
            "real timestamp. This is the naive/aware datetime boundary: the "
            "cutoff must be tz-aware (macro_signal_service.fetch_all) and "
            "every ordering must go through adapters.base.is_before."
            % (route, var))
        assert resp.status_code == 200, (route, var, resp.status_code)


def test_all_five_together_answer(monkeypatch, outbound):
    client = _client(monkeypatch, ACTIVATION_VARS)
    for route in SIGNAL_ROUTES:
        _cold()
        assert client.get(route).status_code == 200, route


def test_the_comparison_is_total_in_both_directions():
    """``is_before`` must never raise, whichever side carries the tzinfo.

    Both directions are real and neither is hypothetical: the RSS adapter's
    own ``_parse_date_safe`` returns AWARE for an RFC-2822 ``pubDate`` and
    NAIVE for a bare-ISO one, so a single feed hands the same loop both;
    and a direct caller of an adapter may still pass a naive cutoff.
    """
    from engine.public.intelligence.adapters.base import as_utc, is_before

    aware = datetime(2026, 9, 1, 10, 0, tzinfo=timezone.utc)
    naive = datetime(2026, 9, 1, 10, 0)
    older_naive = datetime(2026, 6, 1, 10, 0)
    older_aware = datetime(2026, 6, 1, 10, 0, tzinfo=timezone.utc)

    assert is_before(older_aware, naive) is True      # aware item, naive cutoff
    assert is_before(older_naive, aware) is True      # naive item, aware cutoff
    assert is_before(aware, older_naive) is False
    assert is_before(naive, older_aware) is False
    assert is_before(aware, naive) is False           # equal instants
    # A non-UTC offset is converted, not merely accepted.
    plus_two = datetime(2026, 9, 1, 12, 0, tzinfo=timezone(timedelta(hours=2)))
    assert is_before(plus_two, aware) is False and is_before(aware, plus_two) is False
    assert as_utc(None) is None
    assert as_utc(naive).tzinfo is timezone.utc


def test_the_default_cutoff_is_timezone_aware():
    """The ONE clock. ``datetime.utcnow()`` here is the whole defect."""
    from engine.public.intelligence.macro_signal_service import MacroSignalService

    seen: list[datetime] = []

    class _Recorder:
        name, configured = "recorder", True

        def fetch_recent_signals(self, since):
            seen.append(since)
            return []

        def health(self):
            from engine.public.intelligence.adapters.base import AdapterHealth
            return AdapterHealth(name=self.name, configured=True)

    svc = MacroSignalService(manual_adapter=_Recorder(), news_adapter=_Recorder(),
                             rss_adapter=_Recorder(), commodity_adapter=_Recorder(),
                             rates_adapter=_Recorder(), geopolitical_adapter=_Recorder())
    svc.fetch_all()
    assert seen and all(s.tzinfo is not None for s in seen), (
        "THE CUTOFF IS NAIVE — fetch_all handed %r to its adapters. Every "
        "adapter on this feed parses provider timestamps into tz-aware UTC, "
        "so a naive cutoff makes the first live item raise TypeError."
        % (seen[0] if seen else None))

    # A caller-supplied naive cutoff is coerced rather than propagated.
    seen.clear()
    svc.fetch_all(since=datetime(2026, 6, 1, 10, 0))
    assert seen and all(s.tzinfo is not None for s in seen)


def test_an_operator_signal_survives_the_aware_clock():
    """The regression the clock fix would have caused, pinned.

    Making the cutoff aware WITHOUT fixing the manual adapter raises inside
    its broad ``except``, which returns an EMPTY LIST. Every
    operator-uploaded signal would vanish from the radar, from
    macro-signals and from every per-ticker score — and the 500 that used
    to advertise the bug would stop advertising it. No route test can see
    this: the routes all answer 200 while the content is gone.
    """
    from engine.public.intelligence.adapters.manual_signal_adapter import (
        ManualSignalAdapter,
    )

    adapter = ManualSignalAdapter()
    adapter.create_signal(
        signal_type="regulation", title="Red Sea container hijacking",
        summary="s", severity="high", time_horizon="3m",
        affected_sectors=["Industrials"],
    )
    since = datetime.now(timezone.utc) - timedelta(days=90)
    got = adapter.fetch_recent_signals(since)
    assert len(got) == 1, (
        "THE CLOCK FIX ATE THE OPERATOR'S SIGNAL — one manual signal was "
        "created and an aware 90-day cutoff returned %d. last_error=%r. "
        "A silently empty feed is worse than the 500 it replaced."
        % (len(got), adapter._last_error))
    assert adapter._last_error is None
    assert got[0].published_at.tzinfo is not None


# ─────────────────────────────────────────────────────────────────────────
# 2. THE EGRESS MAP, at the transport
# ─────────────────────────────────────────────────────────────────────────

def test_the_signal_fan_out_is_bounded_and_a_repeat_costs_zero(monkeypatch, outbound):
    """Cold cost is real and repeat cost is zero — measured, not assumed.

    The repeat half is the assertion the raising spy could not make
    honestly: an errored fan-out caches an empty feed just as well as a
    successful one, so "a repeat costs zero" was vacuously true whenever
    the spy raised.
    """
    client = _client(monkeypatch, ACTIVATION_VARS)
    _cold()
    outbound.clear()
    assert client.get("/api/public/intelligence/macro-signals").status_code == 200
    cold = len(outbound)
    assert cold >= 10, cold
    outbound.clear()
    assert client.get("/api/public/intelligence/macro-signals").status_code == 200
    assert outbound == [], (
        "A REPEAT INSIDE THE FEED WINDOW REACHED %d PROVIDER(S) %r — the "
        "shared feed cache is not holding, so every poll is a fresh fan-out."
        % (len(outbound), [u for _, u in outbound]))


def test_no_cache_key_carries_caller_supplied_text(monkeypatch, outbound):
    """A key a caller can vary is a cache-MISS lever, not a cache key.

    The intelligence cache is an unbounded dict whose entries expire only
    when READ, so a key minted from caller text is never read again and
    never expires — unbounded growth from anonymous requests.
    """
    client = _client(monkeypatch, ACTIVATION_VARS)
    from engine.public.intelligence.intelligence_cache import get_intelligence_cache

    junk = "Z" * 200 + "<script>"
    for leaf in ("risk-score", "exposure", "ai-market-read", "signals"):
        client.get("/api/public/intelligence/companies/%s/%s" % (junk, leaf))
    polluted = [k for k in get_intelligence_cache()._store if junk[:16] in k.upper()]
    assert polluted == [], (
        "A CALLER MINTED CACHE KEY(S) %r. Every key on this router must be "
        "server-derived (see _FEED_KEY / _FILINGS_OBS_KEY) or validated "
        "before the write." % polluted)


def test_no_unvalidated_identifier_reaches_a_provider(monkeypatch, outbound):
    """The ticker is filtered against the universe server-side, never sent."""
    client = _client(monkeypatch, ACTIVATION_VARS)
    junk = "ZZQQ-NOT-A-TICKER"
    for leaf in ("risk-score", "exposure", "ai-market-read", "signals"):
        _cold()
        outbound.clear()
        client.get("/api/public/intelligence/companies/%s/%s" % (junk, leaf))
        leaked = [u for _, u in outbound if junk.lower() in u.lower()]
        assert leaked == [], (
            "AN UNVALIDATED IDENTIFIER REACHED A PROVIDER on %s: %r"
            % (leaf, leaked))


def test_the_health_probe_costs_nothing_on_a_repeat(monkeypatch, outbound):
    """MEASURED before the fix: 2 unbounded Supabase selects on EVERY call.

    ``total_cached_entries`` and ``oldest_entry_age_seconds`` each pull
    every filings row of ``company_exposure_profiles``, and the route held
    no cache — so the cost grew with the table and 200 anonymous calls
    meant 400 full-table reads.
    """
    client = _client(monkeypatch, ACTIVATION_VARS)
    _cold()
    outbound.clear()
    assert client.get("/api/public/intelligence/health").status_code == 200
    cold_db = [u for t, u in outbound if t == "supabase"]
    assert len(cold_db) == 2, cold_db
    outbound.clear()
    assert client.get("/api/public/intelligence/health").status_code == 200
    repeat_db = [u for t, u in outbound if t == "supabase"]
    assert repeat_db == [], (
        "/intelligence/health reached the database %d time(s) on a REPEAT "
        "call: %r. The FE polls this route for feed status; without a cache "
        "every poll is two full-table selects."
        % (len(repeat_db), repeat_db))


def test_the_health_probe_is_guarded_and_warm_polls_are_free(monkeypatch, outbound):
    """A SHIELD, not a wall — and the shield must never bill a warm poll.

    Both halves matter. Guarding it at all is what bounds an anonymous
    loop; charging nothing when warm is what keeps the Macro Signals tab
    working, and is the reason this route could be moved out of the
    INTERNAL class at all (see test_public_egress.py).
    """
    from engine.public import refresh_shield

    monkeypatch.setenv("PUBLIC_EGRESS_RATE_PER_MIN", "3")
    monkeypatch.setenv("PUBLIC_EGRESS_RATE_BURST", "3")
    client = _client(monkeypatch, ACTIVATION_VARS)
    refresh_shield.reset_limiter()

    # WARM: far more polls than the budget, and not one is refused.
    codes = [client.get("/api/public/intelligence/health").status_code
             for _ in range(30)]
    assert set(codes) == {200}, (
        "A WARM POLL WAS BILLED — statuses %r over a budget of 3. A cached "
        "answer must cost zero budget as well as zero outbound, or the FE's "
        "feed-status probe throttles on its own re-render." % sorted(set(codes)))

    # COLD every time: the guard is the only thing that can stop it.
    from engine.public.intelligence import intelligence_cache as ic

    refresh_shield.reset_limiter()
    outbound.clear()
    cold_codes = []
    for _ in range(8):
        ic.reset_intelligence_cache()
        cold_codes.append(client.get("/api/public/intelligence/health").status_code)
    assert 429 in cold_codes, (
        "AN UNBOUNDED COLD READ — 8 cold /health calls against a budget of 3 "
        "were all served %r. The route needs refresh_shield.egress_guard."
        % sorted(set(cold_codes)))
    served = cold_codes.count(200)
    db_calls = len([u for t, u in outbound if t == "supabase"])
    assert db_calls == 2 * served, (
        "A REFUSED CALL STILL READ THE DATABASE — %d served, %d db calls. "
        "The guard must run BEFORE the read." % (served, db_calls))
