"""The TRANSPORT-LEVEL egress harness the public gates share.

Loaded by path from ``tests/engine/test_public_egress.py`` (no package
import games — ``tests/engine/public`` has no ``__init__.py`` on purpose,
so the intelligence suites keep their module names).

WHY THE TRANSPORT, AND WHY SUCCESS
==================================
Two earlier egress maps were blind for the same two reasons, and this
module exists so a third cannot be:

  1. A spy at a PROVIDER function (``NasdaqAdapter._fetch_datatable``,
     ``ai_market_read._resolve_default_client``) replaces the very code
     that decides whether to go to the wire, so the map can never observe
     the env-gating that code does. Nothing above the transport is
     patched here. ``urllib`` is intercepted at ``OpenerDirector.open`` —
     below ``urlopen``, so ``from urllib.request import urlopen`` and every
     module-scope ``_urlopen = urllib.request.urlopen`` alias are caught —
     ``httpx`` at ``Client.send``, the LLM at a recording ``anthropic``
     module (the SDK is not installed in this checkout, so without the
     stub the paid path is UNREACHABLE locally and measures 0), and a
     socket tripwire underneath all three that records and refuses.

  2. A spy that RAISES makes every line after a successful provider
     response unreachable. The SEC EDGAR chain is four dependent hops
     (tickers.json -> submissions -> index -> primary document) and THEN a
     paid completion; a raising spy reports one call for that chain and
     never reaches the completion at all. Every body here is a 200 with a
     URL-aware payload a real parser accepts, so every chain runs to its
     end and the count is the real fan-out.

The canned Nasdaq TICKERS body answers only for the served registry
(203 NASDAQ + 88 BVB) — the provider modelled as an AUTHORITY on which
symbols exist — so a well-formed unknown symbol measures what it costs in
production: one lookup, then a cached 404.
"""

from __future__ import annotations

import collections
import io
import json
import socket
import sys
import types
import urllib.parse
import urllib.request
from typing import Any, Dict, Iterable, List, Optional, Tuple

LOOPBACK_HOSTS = {"testserver", "localhost", "127.0.0.1", "::1"}


class Recorder:
    """Every provider-boundary call, in order, as (transport, host, url)."""

    def __init__(self) -> None:
        self.calls: List[Tuple[str, str, str]] = []
        self.escapes: List[str] = []

    def reset(self) -> None:
        self.calls.clear()
        self.escapes.clear()

    def hosts(self) -> Dict[str, int]:
        return dict(collections.Counter(h for _, h, _ in self.calls))

    def completions(self) -> int:
        return sum(1 for t, _, _ in self.calls if t == "anthropic")

    def urls(self) -> List[str]:
        return [u for _, _, u in self.calls]

    def __len__(self) -> int:
        return len(self.calls)


def host_of(url: str) -> str:
    return url.split("//", 1)[-1].split("/", 1)[0].split("?", 1)[0].split("@")[-1].lower()


def _query(url: str) -> Dict[str, str]:
    return {k: v[0] for k, v in urllib.parse.parse_qs(urllib.parse.urlsplit(url).query).items()}


# ── canned SUCCESSFUL bodies, URL-aware so multi-hop chains complete ─────

_TENK_HTML = (
    b"<html><body>" + b"filler " * 50
    + b"Item 1A. Risk Factors "
    + (b"We face material risks in supply chain, foreign exchange and regulation. ") * 200
    + b" Item 1B. Unresolved Staff Comments </body></html>"
)


class Canned:
    def __init__(self, known_tickers: Iterable[str]) -> None:
        self.known = sorted({t.upper() for t in known_tickers})
        # A CIK for every registry ticker, so the EDGAR chain can run to
        # its completion for any of them. BVB symbols carry a dot or are
        # short; SEC lists none of them, and the map says so.
        self.cik_map = json.dumps({
            str(i): {"cik_str": 1000 + i, "ticker": t, "title": "Gate %s" % t}
            for i, t in enumerate(t for t in self.known if "." not in t)
        }).encode()

    def body_for(self, url: str) -> bytes:
        u = url.lower()
        h = host_of(url)
        q = _query(url)
        if "company_tickers.json" in u:
            return self.cik_map
        if h == "data.sec.gov":
            return json.dumps({"filings": {"recent": {
                "form": ["10-K"], "accessionNumber": ["0000320193-23-000106"],
                "filingDate": ["2023-11-03"]}}}).encode()
        if "-index.json" in u:
            return json.dumps({"directory": {"item": [
                {"type": "10-K", "name": "gate-10k.htm"}]}}).encode()
        if "/archives/edgar/" in u:
            return _TENK_HTML
        if h == "api.stlouisfed.org":
            return json.dumps({"observations": [
                {"date": "2026-09-01", "value": "5.10"},
                {"date": "2026-08-29", "value": "4.20"}]}).encode()
        if h == "api.eia.gov":
            return json.dumps({"response": {"data": [
                {"period": "2026-09-01", "value": 95.0},
                {"period": "2026-08-29", "value": 70.0}]}}).encode()
        if h == "newsapi.org":
            return json.dumps({"status": "ok", "articles": [{
                "title": "Oil prices surge on supply disruption at Apple supplier",
                "description": "A tariff shock hit energy costs.",
                "content": "c", "url": "https://example.invalid/a",
                "source": {"name": "Reuters"},
                "publishedAt": "2026-09-01T10:00:00Z"}]}).encode()
        if h == "api.gdeltproject.org":
            return json.dumps({"articles": [{
                "title": "Taiwan strait tensions escalate",
                "url": "https://example.invalid/taiwan",
                "seendate": "20260901T100000Z",
                "tone": -9.5, "domain": "example.invalid"}]}).encode()
        if h == "query1.finance.yahoo.com":
            if "/spark" in u:
                return json.dumps({"spark": {"result": []}}).encode()
            return json.dumps({"chart": {"result": [{
                "meta": {"regularMarketPrice": 10.0, "previousClose": 9.5,
                         "currency": "RON", "symbol": "TLV.RO"},
                "timestamp": [1756684800],
                "indicators": {"quote": [{"close": [10.0], "open": [9.9],
                                          "high": [10.1], "low": [9.8],
                                          "volume": [100]}]},
            }], "error": None}}).encode()
        if h == "data.nasdaq.com":
            if "/tickers.json" in u:
                t = (q.get("ticker") or "").upper()
                if t in self.known:
                    return json.dumps({"datatable": {
                        "data": [[t, "Gate %s" % t, "Technology", None, "NASDAQ",
                                  "United States", "USD", "Y"]],
                        "columns": [{"name": n} for n in (
                            "ticker", "name", "sector", "industry", "exchange",
                            "location", "currency", "isdelisted")]}}).encode()
                return json.dumps({"datatable": {"data": [], "columns": []}}).encode()
            return json.dumps({"datatable": {"data": [], "columns": []}}).encode()
        if "supabase" in h:
            return b"{}"
        if u.endswith((".xml", ".rss")) or "rss" in u or "feed" in u:
            return (b"<?xml version='1.0'?><rss version='2.0'><channel>"
                    b"<item><title>Energy tariff shock raises costs</title>"
                    b"<link>https://example.invalid/r</link><description>d</description>"
                    b"<pubDate>Tue, 01 Sep 2026 10:00:00 +0000</pubDate></item>"
                    b"</channel></rss>")
        return b"{}"


class _CannedResponse(io.BytesIO):
    """Enough of ``http.client.HTTPResponse`` for every caller in this tree."""

    def __init__(self, url: str, body: bytes) -> None:
        super().__init__(body)
        import email.message
        m = email.message.Message()
        m["Content-Type"] = "application/json"
        self.headers = m
        self.url, self.status, self.code, self.reason = url, 200, 200, "OK"

    def geturl(self):
        return self.url

    def info(self):
        return self.headers

    def getcode(self):
        return 200

    def __enter__(self):
        return self

    def __exit__(self, *a):
        self.close()
        return False


def install(monkeypatch, *, known_tickers: Optional[Iterable[str]] = None,
            fake_anthropic: bool = True) -> Recorder:
    """Patch the four transports. Returns the Recorder."""
    rec = Recorder()
    if known_tickers is None:
        from engine.public.bvb_seed import bvb_universe
        from engine.public.universe import universe_tickers
        known_tickers = list(universe_tickers()) + list(bvb_universe().keys())
    canned = Canned(known_tickers)

    # 1. urllib — below urlopen.
    def _open(self, fullurl, data=None, timeout=None):
        url = getattr(fullurl, "full_url", None) or str(fullurl)
        rec.calls.append(("urllib", host_of(url), url))
        return _CannedResponse(url, canned.body_for(url))

    monkeypatch.setattr(urllib.request.OpenerDirector, "open", _open, raising=True)

    # 2. httpx — Client.send is the chokepoint for get/post/patch/delete.
    import httpx

    real_send = httpx.Client.send

    def _send(self, request, **kw):
        host = request.url.host
        if host in LOOPBACK_HOSTS:
            # The TestClient drives the ASGI app through httpx. Its
            # loopback host is NOT a provider boundary.
            return real_send(self, request, **kw)
        url = str(request.url)
        rec.calls.append(("httpx", host_of(url), url))
        return httpx.Response(200, content=canned.body_for(url),
                              headers={"content-type": "application/json"},
                              request=request)

    monkeypatch.setattr(httpx.Client, "send", _send, raising=True)

    # 3. anthropic — a recording stub with the production shape.
    if fake_anthropic:
        mod = types.ModuleType("anthropic")

        class _Messages:
            def create(self, **kw):
                rec.calls.append(("anthropic", "api.anthropic.com",
                                  "messages.create model=%s" % kw.get("model")))
                blk = types.SimpleNamespace(type="text", text=json.dumps({
                    "headline": "h", "summary": "s", "what_to_watch": ["w"],
                    "confidence": 0.5,
                    "geographic_exposure": {"us": 0.6, "china": 0.4},
                    "supply_chain_exposure": {"semiconductors": 0.9},
                    "financial_sensitivity": {"fx": 0.5},
                    "main_risks": [{"key": "k", "label": "L", "severity": "high",
                                    "channels": ["revenue"], "explanation": "e"}],
                    "main_opportunities": [],
                }))
                return types.SimpleNamespace(content=[blk])

        class Anthropic:  # noqa: N801
            def __init__(self, *a, **kw):
                self.messages = _Messages()

        mod.Anthropic = Anthropic
        mod.APIError = Exception
        monkeypatch.setitem(sys.modules, "anthropic", mod)

    # 4. socket tripwire — anything reaching here escaped all three.
    def _gai(host, port, *a, **kw):
        rec.escapes.append("getaddrinfo:%s:%s" % (host, port))
        raise socket.gaierror(-2, "WIRE TRIPWIRE: %s:%s" % (host, port))

    def _conn(self, address):
        rec.escapes.append("connect:%r" % (address,))
        raise OSError("WIRE TRIPWIRE: %r" % (address,))

    def _create(address, *a, **kw):
        rec.escapes.append("create_connection:%r" % (address,))
        raise OSError("WIRE TRIPWIRE: %r" % (address,))

    _gai.__name__ = "_gai"
    _create.__name__ = "_create"
    monkeypatch.setattr(socket, "getaddrinfo", _gai)
    monkeypatch.setattr(socket.socket, "connect", _conn)
    monkeypatch.setattr(socket, "create_connection", _create)
    return rec


def cold(gdelt_cache_path: Optional[str] = None, *, keep_budget: bool = False) -> None:
    """Drop EVERY cache and ledger this surface owns, so the next read is COLD.

    All of them, because they chain: the intelligence reads hydrate through
    universe_service, universe_service's demo path sweeps Yahoo through a
    cache of its own, the exposure path reads the filings cache, the filings
    extractor memoises by accession and caches the CIK map, and GDELT keeps
    a DISK cache that would otherwise make its cold call vanish after the
    first shape.
    """
    import os

    from engine.public import egress_ledger
    from engine.public import pipeline
    from engine.public import price_history_service as ph
    from engine.public import refresh_shield
    from engine.public import routes as public_routes
    from engine.public import universe_service as us
    from engine.public.intelligence import filings_cache
    from engine.public.intelligence import filings_extractor as fx
    from engine.public.intelligence import intelligence_cache as ic
    from engine.public.intelligence import macro_signal_service as mss
    from engine.public_ro import ratelimit as ro_ratelimit

    us.clear_warm_cache()
    us._bvb_quotes_cache["at"] = 0.0
    us._bvb_quotes_cache["quotes"] = {}
    ph.clear_warm_cache()
    public_routes.clear_read_caches()
    ic.reset_intelligence_cache()
    mss.reset_macro_signal_service()
    pipeline._ADAPTER = None
    fx._reset_cik_cache()
    filings_cache.reset_in_memory()
    if not keep_budget:
        egress_ledger.reset_ledgers()
        refresh_shield.reset_limiter()
        # The RO storefront's OWN limiter (60/min, process-wide, imported not
        # edited): 800 tests from one peer would exhaust it and every RO
        # repeat would read as a 429 that has nothing to do with egress.
        ro_ratelimit.reset_limiter()
    if gdelt_cache_path and os.path.exists(gdelt_cache_path):
        os.remove(gdelt_cache_path)
