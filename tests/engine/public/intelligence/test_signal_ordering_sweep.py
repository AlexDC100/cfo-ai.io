"""The merged feed's ORDERING, and the whole /api/public surface under every
provider date shape. Measured at the transport, on a plane.

Fifth file in the /api/public control series. ``test_signal_clock_egress.py``
made the CUTOFF tz-aware and hardened each adapter's own ``since``
comparison; this one exists because that left the stamp itself free to be
naive, and the place all six adapters' stamps finally meet — one merged,
CACHED list — still ordered them raw.

WHAT THIS GATE DEPENDS ON — SAY IT PLAINLY
===========================================
The map below is a function of the FIVE SIGNAL ACTIVATION VARIABLES:

    RSS_FEED_URLS   NEWS_API_KEY   EIA_API_KEY   FRED_API_KEY   GDELT_ENABLED

Every adapter reads its own variable at CONSTRUCTION and refuses before the
wire when it is unset, so a fixture that leaves them unset measures a
KEYLESS deployment: every signal route answers 200 over an empty feed and
no ordering ever happens. ``ACTIVATION_CASES`` drives all five together,
each one ALONE, and NONE — the last as the control that says what a
keyless box looks like, not as evidence about a configured one.

``NASDAQ_DATA_LINK_API_KEY`` and ``ANTHROPIC_API_KEY`` are set alongside
them for the PRODUCTION shape. Keyless, the LLM boundary is never
constructed and the Nasdaq adapter refuses before the wire, so
``ai-market-read`` — the largest amplifier on this surface — would measure
as 1 outbound instead of reaching a paid completion.

``GDELT_CACHE_PATH`` is pointed at a per-test temp file. Its default is
``/app/data/gdelt_cache.json``; left alone, a warm disk cache would let the
GDELT adapter answer without a fetch and quietly un-exercise a shape.

AND IT DEPENDS ON THE PROVIDER'S DATE SHAPE — WHICH IS THE FINDING
===================================================================
The previous gate's canned RSS body carried ``Tue, 01 Sep 2026 10:00:00
+0000`` and its NewsAPI body always carried a valid ``publishedAt``. Both
parse AWARE. So the merged list it built was uniformly aware, the ordering
never met a mixture, and sixteen green tests sat on top of a live 500.

A canned body is not a neutral harness detail — it IS the input class
under test. ``DATE_SHAPES`` therefore walks SEVEN, all of which a real feed
produces:

    aware_rfc2822    RFC-2822 with an offset          (the old gate's only shape)
    aware_iso_z      ISO with a trailing Z
    naive_iso        ISO with NO offset               -> was 500
    naive_date_only  a bare calendar date             -> was 500
    malformed        a string no parser accepts       -> undated -> was 500
    missing          the timestamp field absent       -> undated -> was 500
    empty            the provider returns no items
    error_payload    the provider returns an error document

THE DEFECT THIS PINS
=====================
``routes.macro_signals`` ordered the merged feed with

    key=lambda s: (RANK[s.severity], s.published_at or datetime.min)

``datetime.min`` is NAIVE, and ``published_at`` could be naive too, so any
undated signal — or any signal from a provider that wrote a date without an
offset — met the aware stamps every other producer emits and raised

    TypeError: can't compare offset-naive and offset-aware datetimes

at ``routes.py`` ``all_signals.sort``. MEASURED anonymous against the real
``create_app()`` with SUCCESSFUL canned bodies, before the fix:

    RSS_FEED_URLS alone, <pubDate>Tue, 01 Sep 2026 10:00:00 +0000</pubDate>
        -> 200, 47 signals
    RSS_FEED_URLS alone, <pubDate>2026-09-01T10:00:00</pubDate>
        -> 500
    NEWS_API_KEY alone, "publishedAt": "not-a-date"
        -> 500

and it is STICKY: the list that chokes is the CACHED feed
(``routes._FEED_KEY``), so one bad stamp answers 500 for the whole feed
TTL, and every other route reading that feed hands the FE an ISO string
with no offset.

THE FIX IS AT THE BOUNDARY THE VALUE ENTERS, NOT AT THE COMPARISON
===================================================================
Three edits, each at an entrance:

  · ``models.IntelligenceSignal.__post_init__`` coerces ``published_at``
    through ``as_utc``. Six adapters build this class and the number
    grows; coercing in each of them is six edits the seventh is free to
    forget. There is no way to become an ``IntelligenceSignal`` without
    passing here. ``None`` STAYS ``None`` — the class does not invent a
    timestamp, and the readers still disagree about what undated means.
  · ``rss_signal_adapter._parse_date_safe`` stamps UTC on its ISO branch,
    which it never did while its RFC-2822 branch always had. That
    asymmetry was documented in this package as a reason readers must
    coerce; it was never fixed at the producer.
  · ``routes._signal_sort_key`` carries presence as its own tuple
    component, so an undated signal is never compared against a dated one
    and NO sentinel is needed. Order is unchanged from the sentinel
    version — undated first within a severity band, dated ascending
    behind it — because this lane owns the crash, not the editorial order.

No broad ``try`` anywhere. A swallowed sort would have answered 200 with
the feed silently re-ordered or dropped, which is strictly worse than the
500 it replaced.

THE PLANTS CORRECTED THE FIX, NOT ONLY THE FILE
================================================
``_signal_sort_key`` first shipped WITHOUT the ``as_utc`` call, on the
reasoning that the model boundary already guaranteed aware stamps so
presence-as-a-tuple-component was enough. Plant 2+3 disproved it: with the
model boundary out, two DATED signals at the same severity — one aware,
one naive — share a presence flag, reach the third component, and are
compared raw. The routes went 500 while
``test_the_merged_order_is_total_over_a_mixture`` stayed GREEN, because
that test had placed its naive signal at a severity whose only other
member was undated. Both were fixed: the key coerces, and the test now
carries an aware/naive pair in the same band. A plant that only confirms
what you already believe is not a plant.

PLANT (TC-2) — applied in an ISOLATED COPY, RED observed, reverted, GREEN.
Each line records what ACTUALLY reds, not what was expected to. Counts are
for this file alone (104 tests):

  1. routes.py — restore ``key=lambda s: (RANK[s.severity],
     s.published_at or datetime.min)``.
     RED: 8 failed / 96 passed — test_the_signal_routes_survive_every_
     provider_date_shape[malformed, missing] and the six per-variable
     cases for those two shapes ("500 ON A LIVE FEED — GET
     /api/public/intelligence/macro-signals answered 500 with date shape
     'missing' …"). ONLY the undated shapes: with the model boundary
     still in place ``naive_iso`` / ``naive_date_only`` arrive aware, so
     it is the SENTINEL, not the stamp, that this plant restores. That
     split is the reason both halves are fixed and both are asserted.

  2. models.py — delete ``__post_init__``.
     RED: test_a_signal_normalises_its_stamp_at_construction ONLY, 1
     failed / 103 passed. No route moves, and no adapter test moves,
     because the RSS producer (fix 3) is still stamping. The model
     boundary is defence in depth for the NEXT producer, and defence in
     depth that is inferred from a green route is not measured at all —
     hence an assertion of its own.

  3. rss_signal_adapter.py — return the bare ``datetime.fromisoformat``
     from the ISO branch again.
     RED: test_the_rss_parser_stamps_every_branch ONLY, 1 failed / 103
     passed. The model boundary catches it downstream, so the producer
     likewise needs asserting at its own level.

  2+3 TOGETHER — both nets out; the naive stamp reaches the merged list.
     RED: 5 failed / 99 passed — the two unit tests above, plus
     test_every_adapter_emits_aware_or_nothing[rss-naive_iso] and
     [rss-naive_date_only], plus test_no_response_serialises_a_stamp_
     without_an_offset[all]. STILL NO 500: ``_signal_sort_key``'s own
     coercion holds the whole surface up while the FE is handed
     offset-less timestamps. That quiet half is exactly what the
     serialisation sweep exists to catch — a 200 is not evidence the
     value served is well-formed.

  1+2+3 TOGETHER — the defect exactly as it shipped.
     RED: 21 failed / 83 passed, now including both naive shapes, the
     whole-surface sweep [all] and [RSS_FEED_URLS], and the fan-out
     test.

  THE HARNESS IS PLANTED TOO, because here the method IS the finding:

  4. THIS FILE — drop ``naive_iso`` / ``naive_date_only`` / ``malformed``
     / ``missing`` from ``DATE_SHAPES``, leaving only the two aware
     shapes the PREVIOUS gate served.
     RED: test_the_date_shapes_cover_the_naive_and_undated_cases ONLY,
     1 failed / 54 passed ("THE SHAPE TABLE LOST ITS TEETH — ['malformed',
     'missing', 'naive_date_only', 'naive_iso'] are gone from
     DATE_SHAPES").
     WITH PLANT 1 ALSO APPLIED and that one assertion deselected: 54
     PASSED — a fully green gate sitting on a live 500. That is the
     previous gate's failure reproduced deliberately, and it is why the
     shape table is asserted against LITERAL names rather than against
     ``_NAIVE_OR_UNDATED_SHAPES``: narrowing the table and the constant
     together made the constant-based check vacuously true, and the file
     then red only on an incidental KeyError further down.

  5. THIS FILE — convert the ``urllib`` spy to ``raise OSError``.
     RED: 2 failed / 102 passed — test_the_spies_succeed_and_the_feed_
     carries_parsed_signals ("THE SPIES ARE NOT SUCCEEDING — a cold
     macro-signals call reached 13 provider endpoint(s) … but the feed
     carries live signals from only []") and the fan-out test. The call
     COUNT is unchanged at 13: the recorder appends before it raises, so
     counting attempts would have passed this plant.

  6. THIS FILE — delete the ``_LOOPBACK_HOSTS`` pass-through in the httpx
     spy, so the TestClient's own transport is intercepted.
     RED: 5 failed / 99 passed, led by test_the_harness_actually_reaches_
     the_app ("THE HARNESS IS NOT REACHING THE APP — /intelligence/health
     did not answer the router's payload but []"). Without that positive
     control this plant is INVISIBLE: every route answers 200 with one
     outbound call and the socket tripwire stays clean while NO ROUTE
     EVER RUNS (TC-9).
"""

from __future__ import annotations

import io
import json
import os
import socket
import urllib.request
from datetime import datetime, timedelta, timezone
from typing import Any, Optional
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

# all-five, each-alone, and none. The "none" case is the CONTROL: it says
# what a keyless box looks like and is evidence about nothing else.
ACTIVATION_CASES: dict[str, dict[str, str]] = {
    "all": dict(ACTIVATION_VARS),
    "none": {},
    **{v: {v: ACTIVATION_VARS[v]} for v in sorted(ACTIVATION_VARS)},
}

SIGNAL_ROUTES = [
    "/api/public/intelligence/macro-signals",
    "/api/public/intelligence/companies/AAPL/signals",
    "/api/public/intelligence/companies/AAPL/risk-score",
    "/api/public/intelligence/companies/AAPL/ai-market-read",
]

# The TestClient's own in-process transport. NOT egress.
_LOOPBACK_HOSTS = {"testserver", "localhost", "127.0.0.1"}

# Path-parameter fill for the whole-surface sweep. Real-looking values, so a
# route that would 404 on nonsense still executes its body where it can.
_PATH_FILL = {
    "ticker": "AAPL",
    "market": "nasdaq",
    "cui": "12345678",
    "key": "12345678",
    "slug": "agricultura",
    "name": "acme-srl",
    "shard": "0001",
    "document_id": "d1",
}

# A 5xx that is a DELIBERATE, self-describing refusal rather than a crash.
# Measured on this surface: the operator-only teardown generator refuses
# with 503 when ENGINE_API_TOKEN is unset, and the Nasdaq-backed reads
# refuse with 503 when the key is unset. Both are fail-closed by design and
# are the only 5xx this gate tolerates — 500 never is.
_FAIL_CLOSED = 503


# ─────────────────────────────────────────────────────────────────────────
# The seven provider date shapes. THIS TABLE IS THE INPUT CLASS UNDER TEST.
# ─────────────────────────────────────────────────────────────────────────
#
# `rss` is the raw <pubDate> text (None = omit the element entirely).
# `iso` is what NewsAPI writes into "publishedAt" (None = omit the key).
# `gdelt` is "seendate"; `day` is the FRED/EIA observation date.
DATE_SHAPES: dict[str, dict[str, Optional[str]]] = {
    "aware_rfc2822": {"rss": "Tue, 01 Sep 2026 10:00:00 +0000",
                      "iso": "2026-09-01T10:00:00Z",
                      "gdelt": "20260901T100000Z", "day": "2026-09-01"},
    "aware_iso_z": {"rss": "2026-09-01T10:00:00Z",
                    "iso": "2026-09-01T10:00:00+02:00",
                    "gdelt": "20260901T100000Z", "day": "2026-09-01"},
    "naive_iso": {"rss": "2026-09-01T10:00:00",
                  "iso": "2026-09-01T10:00:00",
                  "gdelt": "20260901T100000Z", "day": "2026-09-01"},
    "naive_date_only": {"rss": "2026-09-01", "iso": "2026-09-01",
                        "gdelt": "20260901T100000Z", "day": "2026-09-01"},
    "malformed": {"rss": "not a date at all", "iso": "not-a-date",
                  "gdelt": "nonsense", "day": "nonsense"},
    "missing": {"rss": None, "iso": None, "gdelt": None, "day": None},
    "empty": {},          # every provider returns an empty collection
    "error_payload": {},  # every provider returns an error document
}

# The shapes that were 500 before the fix. Named so a future edit to the
# table cannot quietly delete the coverage that matters — see plant 4.
_NAIVE_OR_UNDATED_SHAPES = {"naive_iso", "naive_date_only", "malformed", "missing"}


def _canned_body(url: str, shape: str) -> bytes:
    """A SUCCESSFUL provider body in that provider's own format.

    Success, never a raise. A spy that raises makes every line after the
    first provider response unreachable: the adapters catch their own
    transport errors, degrade to no signals, and the route answers 200 over
    an empty cached feed — a healthy-looking map for code that 500s on the
    first real byte.
    """
    host = (urlparse(url).netloc or "").lower()
    path = urlparse(url).path or ""
    d = DATE_SHAPES[shape]
    is_fred = "stlouisfed.org" in host
    is_eia = "eia.gov" in host
    is_news = "newsapi.org" in host
    is_gdelt = "gdeltproject.org" in host
    is_rss = path.endswith((".xml", ".rss")) or "rss" in path or "feed" in path

    if shape == "empty":
        if is_fred:
            return json.dumps({"observations": []}).encode()
        if is_eia:
            return json.dumps({"response": {"data": []}}).encode()
        if is_news:
            return json.dumps({"status": "ok", "articles": []}).encode()
        if is_gdelt:
            return json.dumps({"articles": []}).encode()
        if is_rss:
            return b'<?xml version="1.0"?><rss version="2.0"><channel></channel></rss>'

    if shape == "error_payload":
        if is_fred:
            return json.dumps({"error_code": 400,
                               "error_message": "Bad Request. Invalid series_id."}).encode()
        if is_eia:
            return json.dumps({"error": "invalid or missing api_key"}).encode()
        if is_news:
            return json.dumps({"status": "error", "code": "apiKeyInvalid",
                               "message": "Your API key is invalid."}).encode()
        if is_gdelt:
            return b"Error: unrecognized query."
        if is_rss:
            return b"<html><body>502 Bad Gateway</body></html>"

    if is_fred:
        obs: list[dict] = []
        for day, val in ((d.get("day"), "5.10"), ("2026-08-29", "4.20")):
            row: dict[str, Any] = {"value": val}
            if day is not None:
                row["date"] = day
            obs.append(row)
        return json.dumps({"observations": obs}).encode()
    if is_eia:
        rows: list[dict] = []
        for period, val in ((d.get("day"), 95.0), ("2026-08-29", 70.0)):
            row = {"value": val}
            if period is not None:
                row["period"] = period
            rows.append(row)
        return json.dumps({"response": {"data": rows}}).encode()
    if is_news:
        art: dict[str, Any] = {
            "title": "Oil prices surge on supply disruption",
            "description": "A tariff shock hit energy costs and shipping.",
            "content": "c", "url": "https://example.invalid/a",
            "source": {"name": "Reuters"},
        }
        if d.get("iso") is not None:
            art["publishedAt"] = d["iso"]
        return json.dumps({"status": "ok", "articles": [art]}).encode()
    if is_gdelt:
        art = {"title": "Taiwan strait tensions escalate",
               "url": "https://example.invalid/taiwan",
               "tone": -9.5, "domain": "example.invalid"}
        if d.get("gdelt") is not None:
            art["seendate"] = d["gdelt"]
        return json.dumps({"articles": [art]}).encode()
    if is_rss:
        pub = (b"<pubDate>" + d["rss"].encode() + b"</pubDate>"
               if d.get("rss") is not None else b"")
        return (b'<?xml version="1.0"?><rss version="2.0"><channel>'
                b"<item><title>Energy tariff shock raises freight costs</title>"
                b"<link>https://example.invalid/r</link><description>d</description>"
                + pub + b"</item></channel></rss>")
    if "yahoo" in host:
        return json.dumps({"chart": {"result": [{
            "meta": {"regularMarketPrice": 10.0, "previousClose": 9.5,
                     "currency": "RON", "symbol": "TLV.RO"},
            "timestamp": [1756684800],
            "indicators": {"quote": [{"close": [10.0]}]},
        }], "error": None}}).encode()
    if "nasdaq" in host:
        return json.dumps({"dataset_data": {"data": [], "column_names": []}}).encode()
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


class _Outbound:
    """Recorder + the knob that selects which provider date shape is served."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, str]] = []
        self.shape = "aware_rfc2822"

    def clear(self) -> None:
        self.calls.clear()

    def urls(self) -> list[str]:
        return [u for _, u in self.calls]

    def hosts(self) -> set[str]:
        return {urlparse(u).netloc for _, u in self.calls}

    def __len__(self) -> int:
        return len(self.calls)


@pytest.fixture
def outbound(monkeypatch):
    """Recording spies at the TRANSPORT, all returning SUCCESS."""
    rec = _Outbound()

    # 1. Below urlopen — catches `from urllib.request import urlopen` and
    #    every module-scope `_urlopen = urllib.request.urlopen` alias.
    def _opener_open(self, fullurl, data=None, timeout=None):
        url = fullurl if isinstance(fullurl, str) else fullurl.full_url
        rec.calls.append(("urllib", url))
        return _CannedResponse(url, _canned_body(url, rec.shape))

    monkeypatch.setattr(urllib.request.OpenerDirector, "open", _opener_open)

    # 2. httpx — but never the TestClient's own loopback transport (TC-9).
    import httpx

    _orig_send = httpx.Client.send

    def _send(self, request, **kw):
        if request.url.host in _LOOPBACK_HOSTS:
            return _orig_send(self, request, **kw)
        url = str(request.url)
        rec.calls.append(("httpx", url))
        body = _canned_body(url, rec.shape)
        try:
            payload = json.loads(body or b"{}")
        except ValueError:
            payload = {}
        return httpx.Response(200, json=payload, request=request)

    monkeypatch.setattr(httpx.Client, "send", _send)

    # 3. The LLM boundary is a transport too.
    from engine.public.intelligence import ai_market_read as amr

    class _SpyLlm:
        model_id = "gate-spy"

        def complete(self, system, user):
            rec.calls.append(("anthropic", "https://api.anthropic.com/v1/messages"))
            return ('{"headline": "h", "narrative": "n", '
                    '"what_to_watch": ["w"], "bull_case": "b", "bear_case": "x"}')

    monkeypatch.setattr(amr, "_resolve_default_client", lambda: _SpyLlm())

    # 4. Our OWN Supabase — the /health boundary. Success, not a raise.
    from engine.public.intelligence import filings_cache

    class _SpyDb:
        def select(self, table, filters=None, columns=None):
            rec.calls.append(("supabase", "https://test.supabase.co/rest/v1/%s" % table))
            return []

    monkeypatch.setattr(filings_cache, "_get_admin_client", lambda: _SpyDb())
    return rec


@pytest.fixture(autouse=True)
def _leave_no_shared_state():
    """Reset every process-wide singleton this module touches, AFTERWARDS.

    MEASURED, and it was this file's own defect: a whole-surface sweep
    spends tokens from ``refresh_shield``'s shared egress bucket (default
    120/min), and ``_cold()`` only resets it when a client is BUILT. Run
    alone, this file was green and so was
    ``tests/engine/test_public_post_surface.py``; run in the same session,
    that module answered 429 on five tests it does not own. A gate that
    reds a neighbour is a gate that gets deleted.

    The singletons matter for the same reason in the other direction, and
    one of them is worse than a wrong measurement. ``pipeline._ADAPTER``
    is a process-wide ``NasdaqAdapter`` built ONCE, at first use, from the
    env live at that moment. This module sets ``NASDAQ_DATA_LINK_API_KEY``
    for the production shape, so an adapter constructed here holds a FAKE
    key and survives the monkeypatch that removes the variable. MEASURED:
    a later module that expects the keyless ``503 nasdaq_key_missing``
    instead reached ``data.nasdaq.com`` FOR REAL and answered 429 — this
    module's socket tripwire does not protect anyone else's tests. Every
    singleton this file can cause to be built is therefore dropped here.
    """
    yield
    _reset_process_wide_state()


@pytest.fixture(autouse=True)
def _no_real_socket(monkeypatch):
    """GROUND TRUTH. Not a control — the check on the map.

    Every real connection entry point raises. If any test in this module
    trips it, a transport escaped the spies and every number here is a lie.
    No real socket is opened by this module; it runs on a plane.
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


def _set_env(monkeypatch, activation: dict, tmp_path) -> None:
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
    # A warm GDELT disk cache would answer without a fetch and silently
    # un-exercise the shape under test. Fresh file per test.
    monkeypatch.setenv("GDELT_CACHE_PATH", str(tmp_path / "gdelt_cache.json"))
    assert "test." in os.environ["VITE_SUPABASE_URL"], "refusing a non-manifest Supabase URL"
    for k, v in {**PRODUCTION_SHAPE_VARS, **activation}.items():
        monkeypatch.setenv(k, v)


def _reset_process_wide_state() -> None:
    """Drop every process-wide singleton and cache this module can build.

    Used both to make a read genuinely COLD and, from the autouse teardown,
    to leave nothing behind for the next module.
    """
    from engine.public import price_history_service as ph
    from engine.public import pipeline as public_pipeline
    from engine.public import refresh_shield
    from engine.public import routes as public_routes
    from engine.public import universe_service as us
    from engine.public.intelligence import intelligence_cache as ic
    from engine.public.intelligence import macro_signal_service as mss

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
    # Same hazard, higher stakes — see _leave_no_shared_state. The Nasdaq
    # adapter caches the API key it was constructed with, so one built here
    # sends a later, keyless test onto the real network.
    public_pipeline._ADAPTER = None
    refresh_shield.reset_limiter()
    # The DAILY ledgers (engine.public.egress_ledger) are process-wide;
    # a suite that fans the feed out more than 80 times in one process
    # would otherwise watch newsapi.org vanish behind its own ceiling.
    from engine.public import egress_ledger
    egress_ledger.reset_ledgers()


def _cold() -> None:
    """Drop every cache on this path so the next read is genuinely COLD."""
    _reset_process_wide_state()


def _client(monkeypatch, activation: dict, tmp_path) -> TestClient:
    _set_env(monkeypatch, activation, tmp_path)
    _cold()
    from engine.api.server import create_app

    return TestClient(create_app(), raise_server_exceptions=False)


def _public_get_routes(app) -> list[str]:
    """Every GET under /api/public on the REAL app, path params filled.

    Enumerated from the app's own route table rather than a hand-written
    list: a route added tomorrow is swept without editing this file, which
    is the only way a surface sweep stays a sweep.
    """
    urls: list[str] = []
    for r in app.routes:
        path = getattr(r, "path", "")
        if not path.startswith("/api/public"):
            continue
        if "GET" not in (getattr(r, "methods", None) or set()):
            continue
        for key, val in _PATH_FILL.items():
            path = path.replace("{%s}" % key, val)
        assert "{" not in path, (
            "UNFILLED PATH PARAMETER in %r — add it to _PATH_FILL or this "
            "route is swept as a literal string and tests nothing." % path)
        urls.append(path)
    return sorted(set(urls))


def _walk(obj: Any, key: str):
    """Yield every value stored under ``key`` anywhere in a JSON document."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k == key:
                yield v
            yield from _walk(v, key)
    elif isinstance(obj, list):
        for item in obj:
            yield from _walk(item, key)


# ─────────────────────────────────────────────────────────────────────────
# 0. The harness is itself suspect (TC-9)
# ─────────────────────────────────────────────────────────────────────────

def test_the_harness_actually_reaches_the_app(monkeypatch, outbound, tmp_path):
    """POSITIVE CONTROL. Without it every number in this file is unfalsifiable.

    An httpx spy patched unconditionally intercepts the TestClient's own
    transport and reports 200 + one outbound call for every route on the
    surface while NO ROUTE RUNS and the socket tripwire stays clean. A
    clean result would be indistinguishable from no subject.
    """
    client = _client(monkeypatch, ACTIVATION_VARS, tmp_path)
    body = client.get("/api/public/intelligence/health").json()
    assert "adapters" in body, (
        "THE HARNESS IS NOT REACHING THE APP — /intelligence/health did not "
        "answer the router's payload but %r. Every outbound count in this "
        "module is measuring the spy, not the engine." % sorted(body)[:6])
    assert set(body["adapters"]) >= {"rates", "commodity", "rss", "news", "geopolitical"}


def test_the_spies_succeed_and_the_feed_carries_parsed_signals(
    monkeypatch, outbound, tmp_path,
):
    """A raising spy sees nothing past call #1 — the discriminator is the FEED.

    Counting attempts measures the harness: the recorder appends before it
    would raise, and FRED/EIA walk five series under a per-series ``try``,
    so ten attempts are recorded whether or not a byte was ever consumed.
    Only a signal that came OUT of a parsed provider body proves the
    response was read.
    """
    client = _client(monkeypatch, ACTIVATION_VARS, tmp_path)
    outbound.shape = "aware_rfc2822"
    body = client.get("/api/public/intelligence/macro-signals").json()
    # `sector_model` / `theme` are SYNTHESIZED server-side and appear even
    # with every provider dead, so they prove nothing and are excluded.
    live = {s["source"].split(":")[0] for s in body["signals"]} - {"sector_model", "theme"}
    assert live >= {"fred", "eia", "newsapi", "gdelt", "rss"}, (
        "THE SPIES ARE NOT SUCCEEDING — a cold macro-signals call reached "
        "%d provider endpoint(s) %r but the feed carries live signals from "
        "only %r. A provider body that is never PARSED means the spy raised "
        "and the adapter swallowed it; every line after the first response "
        "is then unreachable and this whole map is blind past call #1."
        % (len(outbound), sorted(outbound.hosts()), sorted(live)))
    assert body["feed_status"] == "live_feed_active"


def test_the_date_shapes_cover_the_naive_and_undated_cases():
    """The shape table IS the input class — deleting a row deletes the gate.

    The previous gate was green over a live 500 for exactly one reason: its
    canned RSS body carried an RFC-2822 date and its NewsAPI body always
    carried a valid ``publishedAt``, so the merged list was uniformly aware
    and the ordering never met a mixture. This assertion reds on the table
    itself, before any route runs, so that narrowing cannot happen quietly.
    """
    from engine.public.intelligence.adapters.rss_signal_adapter import _parse_date_safe

    # Named as LITERALS, not via ``_NAIVE_OR_UNDATED_SHAPES``. Measured:
    # narrowing the table and the constant together leaves a check against
    # the constant vacuously true, and the gate then reds only on an
    # incidental KeyError further down instead of on its own message.
    required = {"naive_iso", "naive_date_only", "malformed", "missing"}
    missing = required - set(DATE_SHAPES)
    assert not missing, (
        "THE SHAPE TABLE LOST ITS TEETH — %r are gone from DATE_SHAPES. "
        "Those four are the shapes that answered 500; without them this "
        "file passes over the defect it exists to pin." % sorted(missing))
    assert _NAIVE_OR_UNDATED_SHAPES == required, (
        "_NAIVE_OR_UNDATED_SHAPES drifted from the shapes that actually "
        "answered 500: %r vs %r. The per-variable sweep parametrises on it."
        % (sorted(_NAIVE_OR_UNDATED_SHAPES), sorted(required)))
    assert {"empty", "error_payload"} <= set(DATE_SHAPES)

    # And the naive shapes are genuinely naive AT THE SOURCE — asserted
    # against the real parser, not asserted about the string. A row whose
    # text stopped being naive would otherwise still count as coverage.
    for shape in ("naive_iso", "naive_date_only"):
        raw = DATE_SHAPES[shape]["rss"]
        assert datetime.fromisoformat(raw).tzinfo is None, (shape, raw)
    for shape in ("malformed", "missing"):
        raw = DATE_SHAPES[shape]["rss"]
        assert raw is None or _parse_date_safe(raw) is None, (shape, raw)


# ─────────────────────────────────────────────────────────────────────────
# 1. THE DEFECT — the merged feed's ordering
# ─────────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("shape", sorted(DATE_SHAPES))
def test_the_signal_routes_survive_every_provider_date_shape(
    monkeypatch, outbound, tmp_path, shape,
):
    """Every signal route, every date shape, all five providers live.

    Four of these shapes answered 500 before the fix and two did not. The
    two that did not are the two the previous gate served.
    """
    client = _client(monkeypatch, ACTIVATION_VARS, tmp_path)
    outbound.shape = shape
    for route in SIGNAL_ROUTES:
        _cold()
        resp = client.get(route)
        assert resp.status_code != 500, (
            "500 ON A LIVE FEED — GET %s answered 500 with date shape %r "
            "and every provider returning a SUCCESSFUL body. This is the "
            "naive/aware boundary in the MERGED feed: a stamp is coerced at "
            "IntelligenceSignal.__post_init__ and the ordering goes through "
            "routes._signal_sort_key, which needs no sentinel. Note the "
            "failure is sticky — the poisoned list is the cached feed."
            % (route, shape))
        assert resp.status_code == 200, (route, shape, resp.status_code)


@pytest.mark.parametrize("shape", sorted(_NAIVE_OR_UNDATED_SHAPES))
@pytest.mark.parametrize("case", sorted(ACTIVATION_CASES))
def test_each_activation_variable_alone_survives_a_naive_or_undated_stamp(
    monkeypatch, outbound, tmp_path, case, shape,
):
    """One variable at a time, against the shapes that used to 500.

    Walked one at a time because that is the shape a real deployment has —
    an operator turns one feed on first — and because the all-together case
    cannot show a per-provider failure: any single working adapter makes a
    route look alive. ``none`` is the control and is expected to answer over
    an empty feed, not to prove anything about a configured box.
    """
    client = _client(monkeypatch, ACTIVATION_CASES[case], tmp_path)
    outbound.shape = shape
    for route in SIGNAL_ROUTES:
        _cold()
        resp = client.get(route)
        assert resp.status_code == 200, (
            "500 FROM ONE LIVE PROVIDER — GET %s answered %d with %s set "
            "alone and date shape %r." % (route, resp.status_code, case, shape))


def test_the_merged_order_is_total_over_a_mixture():
    """``_signal_sort_key`` orders a naive/aware/undated mixture, unit level.

    A route test cannot isolate this: the model boundary means a naive stamp
    should never reach the key in production. This asserts the key is total
    ANYWAY, because the key is what makes the sentinel unnecessary, and
    because defence in depth that is never asserted is decoration.

    THE FIRST VERSION OF THIS TEST PASSED OVER A KEY THAT WAS NOT TOTAL.
    It placed the naive signal at a severity where the only other member
    was UNDATED, so the presence component separated them and the two
    datetimes were never compared. Plant 2+3 exposed it — the routes went
    500 while this assertion stayed green. ``high-naive`` and ``high-aware``
    below are the pair that fixes it: same severity, both dated, one of
    each kind, so the third tuple component is genuinely exercised.
    """
    from engine.public.intelligence.models import IntelligenceSignal
    from engine.public.intelligence.routes import _signal_sort_key

    def sig(sev, at, ident):
        s = IntelligenceSignal(
            id=ident, signal_type="energy", title=ident, summary="s",
            source="test", severity=sev, time_horizon="3m", confidence=0.5,
            published_at=at,
        )
        # Re-plant a NAIVE stamp past the model's own coercion: the key must
        # hold even if a producer is ever added that routes around the model.
        if at is not None and at.tzinfo is None:
            object.__setattr__(s, "published_at", at)
        return s

    aware_old = datetime(2026, 6, 1, tzinfo=timezone.utc)
    aware_new = datetime(2026, 9, 1, tzinfo=timezone.utc)
    naive_mid = datetime(2026, 7, 1)
    signals = [
        sig("low", aware_new, "low-new"),
        sig("critical", None, "crit-undated"),
        sig("critical", aware_new, "crit-new"),
        sig("high", naive_mid, "high-naive"),          # naive, DATED
        sig("high", aware_new, "high-aware"),          # aware, DATED, same band
        sig("critical", aware_old, "crit-old"),
        sig("high", None, "high-undated"),
    ]
    ordered = [s.id for s in sorted(signals, key=_signal_sort_key)]
    assert ordered == ["crit-undated", "crit-old", "crit-new",
                       "high-undated", "high-naive", "high-aware",
                       "low-new"], ordered
    # And the naive stamp is ordered ON ITS INSTANT, read as UTC — not
    # merely tolerated by being pushed to one end.
    assert ordered.index("high-naive") < ordered.index("high-aware")

    # ORDER IS UNCHANGED from the sentinel version wherever the sentinel
    # version could run AT ALL — that is, over dated, uniformly-aware
    # signals, the only input the old key could order without raising. This
    # is what makes "the crash is fixed, the feed's editorial order is not
    # touched" a measured claim rather than an assurance.
    dated_aware = [s for s in signals
                   if s.published_at is not None and s.published_at.tzinfo is not None]
    # Four: the two undated ones and the re-planted naive one are excluded,
    # which is precisely the input the old key could not handle.
    assert len(dated_aware) == 4, [s.id for s in dated_aware]
    legacy_key = lambda s: (                                    # noqa: E731
        {"critical": 0, "high": 1, "medium": 2, "low": 3}[s.severity],
        s.published_at or datetime.min)
    assert ([s.id for s in sorted(dated_aware, key=_signal_sort_key)]
            == [s.id for s in sorted(dated_aware, key=legacy_key)]), (
        "THE FEED'S ORDER MOVED — the new key must agree with the sentinel "
        "key on every input the sentinel key could order. This lane owns the "
        "crash, not the editorial order.")

    # And the undated placement matches what ``datetime.min`` gave: FIRST
    # within its severity band. Asserted separately because the old key
    # could not be run over this input to compare against.
    assert ordered.index("crit-undated") < ordered.index("crit-old")
    assert ordered.index("high-undated") < ordered.index("high-naive")


def test_the_severity_rank_covers_every_severity_in_the_model():
    """A fifth severity must red a test, not 500 a route.

    ``_signal_sort_key`` INDEXES the rank dict rather than ``.get``-ing a
    fallback, because a severity outside the model's Literal is a broken
    contract that should be loud. That is only safe while the dict is
    exhaustive, so exhaustiveness is asserted here rather than assumed.
    """
    from typing import get_args

    from engine.public.intelligence.models import Severity
    from engine.public.intelligence.routes import _SEVERITY_RANK

    assert set(_SEVERITY_RANK) == set(get_args(Severity)), (
        "SEVERITY RANK IS OUT OF SYNC WITH THE MODEL — ranked %r, model "
        "declares %r. _signal_sort_key indexes this dict, so an unranked "
        "severity is a KeyError inside a route."
        % (sorted(_SEVERITY_RANK), sorted(get_args(Severity))))


# ─────────────────────────────────────────────────────────────────────────
# 2. THE BOUNDARY — where the value enters
# ─────────────────────────────────────────────────────────────────────────

def test_a_signal_normalises_its_stamp_at_construction():
    """The invariant, at the one place every signal is born.

    Six adapters build this class and the number grows. Coercing in each is
    six edits the seventh producer is free to forget; there is no way to
    become an ``IntelligenceSignal`` without passing through here.
    """
    from engine.public.intelligence.models import IntelligenceSignal

    def sig(at):
        return IntelligenceSignal(
            id="i", signal_type="energy", title="t", summary="s", source="test",
            severity="low", time_horizon="3m", confidence=0.5, published_at=at)

    naive = datetime(2026, 9, 1, 10, 0)
    assert sig(naive).published_at == datetime(2026, 9, 1, 10, 0, tzinfo=timezone.utc), (
        "A NAIVE STAMP SURVIVED CONSTRUCTION — IntelligenceSignal must coerce "
        "published_at through models.as_utc, or one adapter's naive value "
        "poisons the merged feed for the whole TTL.")
    assert sig(naive).published_at.tzinfo is not None

    # A non-UTC offset is CONVERTED, not merely accepted.
    plus_two = datetime(2026, 9, 1, 12, 0, tzinfo=timezone(timedelta(hours=2)))
    assert sig(plus_two).published_at == datetime(2026, 9, 1, 10, 0, tzinfo=timezone.utc)

    # ABSENT != ZERO. The class does not invent a timestamp, and undated
    # stays undated — the readers deliberately disagree about what it means
    # (the news adapter includes an undated signal, the manual one excludes).
    assert sig(None).published_at is None, (
        "AN UNDATED SIGNAL WAS GIVEN A TIMESTAMP — filing a missing stamp as "
        "a real instant is the falsy-zero mistake in datetime clothing.")


def test_as_utc_has_exactly_one_implementation():
    """``adapters.base`` re-exports the model's helper; it does not fork it.

    Two copies of a coercion rule drift, and the one that drifts is the one
    no test imports.
    """
    from engine.public.intelligence.adapters import base
    from engine.public.intelligence import models

    assert base.as_utc is models.as_utc, (
        "as_utc HAS FORKED — adapters.base and models hold different "
        "objects. There must be one implementation and one re-export.")
    assert "as_utc" in base.__all__


def test_the_rss_parser_stamps_every_branch():
    """The producer, at its own level. Its two branches disagreed.

    ``_parse_date_safe`` stamped UTC on the RFC-2822 branch and returned a
    bare ``fromisoformat`` on the ISO one, so ONE function emitted aware and
    naive for dates a single feed carries on adjacent items.
    """
    from engine.public.intelligence.adapters.rss_signal_adapter import _parse_date_safe

    for raw in ("Tue, 01 Sep 2026 10:00:00 +0000",   # RFC-2822, offset
                "Tue, 01 Sep 2026 10:00:00 GMT",     # RFC-2822, named zone
                "2026-09-01T10:00:00Z",              # ISO, Z
                "2026-09-01T10:00:00+02:00",         # ISO, offset
                "2026-09-01T10:00:00",               # ISO, NO offset
                "2026-09-01"):                       # bare calendar date
        got = _parse_date_safe(raw)
        assert got is not None and got.tzinfo is not None, (
            "NAIVE OUT OF _parse_date_safe for %r -> %r. Both branches must "
            "stamp UTC; the ISO branch did not, and that naive value "
            "travelled into the merged feed." % (raw, got))

    # A date the provider did publish is never filed as ABSENT...
    assert _parse_date_safe("2026-09-01") == datetime(2026, 9, 1, tzinfo=timezone.utc)
    # ...and a string no parser accepts is ABSENT, not a stand-in instant.
    assert _parse_date_safe("not a date at all") is None
    assert _parse_date_safe(None) is None
    assert _parse_date_safe("") is None


ADAPTER_CASES = [
    ("rss", "RSS_FEED_URLS"),
    ("news", "NEWS_API_KEY"),
    ("rates", "FRED_API_KEY"),
    ("commodity", "EIA_API_KEY"),
    ("geopolitical", "GDELT_ENABLED"),
    ("manual", None),
]


@pytest.mark.parametrize("shape", sorted(DATE_SHAPES))
@pytest.mark.parametrize("adapter_name,var", ADAPTER_CASES, ids=[a for a, _ in ADAPTER_CASES])
def test_every_adapter_emits_aware_or_nothing(
    monkeypatch, outbound, tmp_path, adapter_name, var, shape,
):
    """Feed each adapter every shape and a NAIVE cutoff. Nothing raises.

    Driven through the adapters themselves rather than through a route, so
    an adapter that silently swallowed a raise into an empty list is still
    visible: the assertion is on ``last_error`` as well as on the stamps.
    """
    _set_env(monkeypatch, ACTIVATION_VARS, tmp_path)
    _cold()
    outbound.shape = shape
    from engine.public.intelligence.macro_signal_service import MacroSignalService

    adapter = {a.name: a for a in MacroSignalService().adapters}[adapter_name]
    if var is not None:
        assert adapter.configured, (adapter_name, var)

    # A NAIVE cutoff from a direct caller — the other direction of the
    # mixture, and one no route can produce.
    for since in (datetime.now(timezone.utc) - timedelta(days=90),
                  datetime.utcnow() - timedelta(days=90)):
        signals = adapter.fetch_recent_signals(since)
        for s in signals:
            assert s.published_at is None or s.published_at.tzinfo is not None, (
                "%s EMITTED A NAIVE STAMP under shape %r: %r. It lands in the "
                "merged feed and the ordering there is what answers 500."
                % (adapter_name, shape, s.published_at))
        err = getattr(adapter, "_last_error", None)
        assert not (err and "offset-naive" in str(err)), (
            "%s SWALLOWED A TZ COMPARISON under shape %r: last_error=%r. A "
            "broad except turns this defect into a silently empty feed, "
            "which is worse than the 500 it replaces." % (adapter_name, shape, err))


# ─────────────────────────────────────────────────────────────────────────
# 3. THE WHOLE /api/public SURFACE, anonymous
# ─────────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("case", sorted(ACTIVATION_CASES))
def test_every_public_get_answers_without_a_crash(
    monkeypatch, outbound, tmp_path, case,
):
    """Every GET under /api/public, anonymous, under each activation set.

    Served the WORST date shape (``naive_iso``), because a sweep on the
    friendly shape is the sweep that was already green.

    The only 5xx tolerated is 503, and only because three routes on this
    surface refuse deliberately and say so: the operator-only teardown
    generator with ENGINE_API_TOKEN unset, and the two Nasdaq-backed reads
    with the key unset. 500 is never tolerated.
    """
    client = _client(monkeypatch, ACTIVATION_CASES[case], tmp_path)
    outbound.shape = "naive_iso"
    from engine.api.server import create_app

    routes = _public_get_routes(create_app())
    assert len(routes) >= 30, (
        "THE SWEEP FOUND ONLY %d GET ROUTES under /api/public — the route "
        "table lookup is broken and this test is measuring nothing."
        % len(routes))

    crashed = []
    for url in routes:
        resp = client.get(url)
        if resp.status_code >= 500 and resp.status_code != _FAIL_CLOSED:
            crashed.append((url, resp.status_code, resp.text[:160]))
    assert crashed == [], (
        "CRASHED ROUTE(S) with activation %s and date shape 'naive_iso': %r"
        % (case, crashed))


@pytest.mark.parametrize("case", ["all", "none"])
def test_no_response_serialises_a_stamp_without_an_offset(
    monkeypatch, outbound, tmp_path, case,
):
    """Every ``published_at`` the surface emits carries a UTC offset.

    The second, quieter half of the naive stamp: even where nothing ordered
    it, ``_serialize`` wrote it out as an offset-less ISO string and the FE
    rendered it as local time. A route answering 200 is not evidence the
    value it served is well-formed.
    """
    client = _client(monkeypatch, ACTIVATION_CASES[case], tmp_path)
    outbound.shape = "naive_iso"
    from engine.api.server import create_app

    seen = 0
    offenders = []
    for url in _public_get_routes(create_app()):
        resp = client.get(url)
        if resp.status_code != 200 or "json" not in resp.headers.get("content-type", ""):
            continue
        try:
            body = resp.json()
        except ValueError:
            continue
        for value in _walk(body, "published_at"):
            if not isinstance(value, str):
                continue
            seen += 1
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                offenders.append((url, value))
    assert offenders == [], (
        "OFFSET-LESS TIMESTAMP SERVED to the FE: %r. A naive published_at "
        "renders as the reader's local time." % offenders[:5])
    if case == "all":
        assert seen > 0, (
            "NO published_at WAS INSPECTED — a clean result here would be "
            "indistinguishable from no subject (TC-9).")


def test_the_signal_fan_out_is_bounded_and_a_repeat_costs_zero(
    monkeypatch, outbound, tmp_path,
):
    """Cold cost is real, repeat cost is zero — under a NAIVE shape.

    The repeat half is the assertion a broken feed passes vacuously: a route
    that 500s caches nothing useful and a route whose adapters all errored
    caches an empty list, and both make "a repeat costs zero" true for the
    wrong reason. Asserted here alongside a cold call that produced live
    signals.
    """
    client = _client(monkeypatch, ACTIVATION_VARS, tmp_path)
    outbound.shape = "naive_iso"
    _cold()
    outbound.clear()
    body = client.get("/api/public/intelligence/macro-signals").json()
    cold = len(outbound)
    live = {s["source"].split(":")[0] for s in body["signals"]} - {"sector_model", "theme"}
    assert cold >= 10, cold
    assert live >= {"fred", "eia", "newsapi", "gdelt", "rss"}, sorted(live)

    outbound.clear()
    assert client.get("/api/public/intelligence/macro-signals").status_code == 200
    assert outbound.calls == [], (
        "A REPEAT INSIDE THE FEED WINDOW REACHED %d PROVIDER(S) %r — the "
        "shared feed cache is not holding, so every poll is a fresh fan-out."
        % (len(outbound), outbound.urls()))


def test_no_public_route_mints_a_cache_key_from_caller_text(
    monkeypatch, outbound, tmp_path,
):
    """A key a caller can vary is a cache-MISS lever, not a cache key.

    Swept over the WHOLE public GET surface, not just the intelligence
    router: the caches on this path are unbounded dicts whose entries expire
    only when READ, so a key minted from caller text is never read again and
    never expires.
    """
    client = _client(monkeypatch, ACTIVATION_VARS, tmp_path)
    outbound.shape = "naive_iso"
    from engine.api.server import create_app
    from engine.public.intelligence.intelligence_cache import get_intelligence_cache

    junk = "ZQXJ" * 12 + "<script>"
    fill = {**_PATH_FILL}
    for key in fill:
        fill[key] = junk
    urls = []
    for r in create_app().routes:
        path = getattr(r, "path", "")
        if not path.startswith("/api/public") or "{" not in path:
            continue
        if "GET" not in (getattr(r, "methods", None) or set()):
            continue
        for key, val in fill.items():
            path = path.replace("{%s}" % key, val)
        urls.append(path)
    assert urls, "no parameterised public GET routes found — sweep is empty"
    for url in urls:
        client.get(url)

    polluted = [k for k in get_intelligence_cache()._store if junk[:16] in k.upper()]
    assert polluted == [], (
        "A CALLER MINTED CACHE KEY(S) %r. Every key on this surface must be "
        "server-derived (see routes._FEED_KEY / _FILINGS_OBS_KEY) or "
        "validated before the write." % polluted)


def test_no_unvalidated_identifier_reaches_a_provider(
    monkeypatch, outbound, tmp_path,
):
    """Caller text is filtered against the universe server-side, never sent."""
    client = _client(monkeypatch, ACTIVATION_VARS, tmp_path)
    outbound.shape = "naive_iso"
    junk = "ZZQQ-NOT-A-TICKER"
    for leaf in ("risk-score", "exposure", "ai-market-read", "signals"):
        _cold()
        outbound.clear()
        client.get("/api/public/intelligence/companies/%s/%s" % (junk, leaf))
        leaked = [u for u in outbound.urls() if junk.lower() in u.lower()]
        assert leaked == [], (
            "AN UNVALIDATED IDENTIFIER REACHED A PROVIDER on %s: %r"
            % (leaf, leaked))
