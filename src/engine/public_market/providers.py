"""Licensed-provider adapter SLOT (EODHD-shaped) — zero-owner mode.

The platform has no paid market-data key today. This module ships the
full adapter surface anyway, in two implementations behind one
resolver:

    provider_from_env(env)
        PROVIDER_API_KEY unset/blank  → MockProvider   (live=False)
        PROVIDER_API_KEY set          → LicensedProvider (live=True)

Self-activation is the whole design: the day a key exists, setting one
env var flips every call site from canned data to the licensed wire —
no code change, no redeploy of anything but config.

KEYLESS LAW (tested): the mock NEVER attempts the network. Its call
paths contain no socket use at all — a urlopen trap in the test suite
proves it. Mock output is unmistakably mock: ``"mock": True`` on every
block and ``provenance.source == "provider:mock"`` on every figure, so
a mock number can never masquerade as a licensed one (PM1: nothing
here is numeric-authoritative until a real feed stands behind it).

API SHAPE: EODHD-style REST (https://eodhd.com/api) — fundamentals,
EOD prices, delayed real-time. The builders are pure functions so the
exact requests are testable without a key or a socket. EODHD's data is
licensed per-account; ``license_notes`` for served markets live in the
prices registry (prices.py), not here.

SECRETS: the key never appears in repr/str/logs or refusal details.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Callable, Dict, Optional, Tuple, Union

from engine.public_market._refusal import Refusal, refuse

PROVIDER_ENV_KEY = "PROVIDER_API_KEY"
DEFAULT_BASE_URL = "https://eodhd.com/api"
USER_AGENT = "cfo-ai.io engine (contact: ad.crestin@gmail.com)"

MOCK_SOURCE = "provider:mock"
LICENSED_SOURCE = "provider:eodhd"


@dataclass(frozen=True)
class ProviderCapabilities:
    """Capability flags a caller may branch on. ``live`` is the one
    that gates serving: mock data may drive dev surfaces but never an
    envelope figure."""

    fundamentals_annual: bool
    fundamentals_quarterly: bool
    eod_prices: bool
    delayed_intraday: bool
    markets: Tuple[str, ...]
    live: bool


#: What the licensed slot offers once keyed: quarterlies and broader
#: EU coverage are exactly the two things the free deterministic feeds
#: (EDGAR annual companyfacts, ESEF annuals) cannot give.
_SLOT_MARKETS = ("US", "DE", "GB", "FR", "IT", "ES", "AE", "HU")

MOCK_CAPABILITIES = ProviderCapabilities(
    fundamentals_annual=True,
    fundamentals_quarterly=True,  # the mock can produce canned quarters
    eod_prices=True,
    delayed_intraday=False,
    markets=_SLOT_MARKETS,
    live=False,
)

LICENSED_CAPABILITIES = ProviderCapabilities(
    fundamentals_annual=True,
    fundamentals_quarterly=True,
    eod_prices=True,
    delayed_intraday=True,
    markets=_SLOT_MARKETS,
    live=True,
)

# ── polite HTTP (licensed path only; module-level for test patching) ─

_urlopen = urllib.request.urlopen
_MIN_REQUEST_INTERVAL_S = 0.5
_MAX_ATTEMPTS = 3
_TIMEOUT_S = 30.0
_last_request_monotonic = [0.0]


def _polite_fetch(url):
    # type: (str) -> bytes
    wait = _MIN_REQUEST_INTERVAL_S - (time.monotonic() - _last_request_monotonic[0])
    if wait > 0:
        time.sleep(wait)
    last_error = None  # type: Optional[BaseException]
    for attempt in range(_MAX_ATTEMPTS):
        _last_request_monotonic[0] = time.monotonic()
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        try:
            with _urlopen(request, timeout=_TIMEOUT_S) as response:
                return response.read()
        except urllib.error.HTTPError as exc:
            last_error = exc
            if exc.code != 429 and exc.code < 500:
                raise
        except urllib.error.URLError as exc:
            last_error = exc
        time.sleep(2.0 ** attempt)
    if last_error is not None:
        raise last_error
    raise RuntimeError("unreachable: no attempt made")


class MockProvider(object):
    """Keyless stand-in. Deterministic canned data, obviously fake
    round numbers, ``mock: True`` everywhere — and NO network code on
    any path (the test suite traps sockets to prove it)."""

    name = MOCK_SOURCE
    capabilities = MOCK_CAPABILITIES

    _FIXED_FETCHED_AT = "2026-01-02T00:00:00+00:00"  # fixed: mock is a fixture

    def _provenance(self, as_of):
        # type: (str) -> Dict[str, object]
        return {
            "source": MOCK_SOURCE,
            "dataset_version": "mock-fixture-1",
            "as_of": as_of,
            "fetched_at": self._FIXED_FETCHED_AT,
        }

    def fundamentals(self, symbol):
        # type: (str) -> Dict[str, object]
        as_of = "2025-12-31"
        return {
            "mock": True,
            "symbol": symbol,
            "annual": {
                "revenue": 100000000.0,
                "profit": 10000000.0,
                "assets": 200000000.0,
                "equity": 80000000.0,
            },
            "quarterly": {
                # capability demo only — obviously synthetic quarters
                "2025-Q4": {"revenue": 25000000.0, "profit": 2500000.0},
            },
            "currency": "EUR",
            "as_of": as_of,
            "provenance": self._provenance(as_of),
        }

    def eod_price(self, symbol):
        # type: (str) -> Dict[str, object]
        as_of = "2026-01-02"
        return {
            "mock": True,
            "symbol": symbol,
            "value": 123.45,
            "currency": "EUR",
            "as_of": as_of,
            "provenance": self._provenance(as_of),
        }


class LicensedProvider(object):
    """The real HTTP path — activates when a key is present. URL
    builders are pure so tests pin the request shape keylessly."""

    name = LICENSED_SOURCE
    capabilities = LICENSED_CAPABILITIES

    def __init__(self, api_key, base_url=DEFAULT_BASE_URL, fetch=None):
        # type: (str, str, Optional[Callable[[str], bytes]]) -> None
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._fetch = fetch if fetch is not None else _polite_fetch

    def __repr__(self):
        # type: () -> str
        # never the key — repr travels into logs and tracebacks
        return "LicensedProvider(base_url=%r, key=***)" % self._base_url

    __str__ = __repr__

    # pure builders ---------------------------------------------------

    def _url(self, path, extra_params=None):
        # type: (str, Optional[Dict[str, str]]) -> str
        params = {"api_token": self._api_key, "fmt": "json"}
        if extra_params:
            params.update(extra_params)
        return "%s/%s?%s" % (self._base_url, path, urllib.parse.urlencode(params))

    def build_fundamentals_url(self, symbol):
        # type: (str) -> str
        return self._url("fundamentals/%s" % urllib.parse.quote(symbol))

    def build_eod_url(self, symbol):
        # type: (str) -> str
        # order=d&limit=1 → most recent close only; we label, not chart
        return self._url(
            "eod/%s" % urllib.parse.quote(symbol),
            extra_params={"order": "d", "limit": "1"},
        )

    def build_real_time_url(self, symbol):
        # type: (str) -> str
        return self._url("real-time/%s" % urllib.parse.quote(symbol))

    # network paths ---------------------------------------------------

    def _get_json(self, url, refusal_code):
        # type: (str, str) -> Union[object, Refusal]
        try:
            payload = self._fetch(url)
        except Exception as exc:  # noqa: BLE001 — boundary refusal, no key in detail
            return refuse(
                refusal_code,
                "provider fetch failed: %s" % exc.__class__.__name__,
                LICENSED_SOURCE,
            )
        try:
            return json.loads(payload)
        except ValueError:
            return refuse(refusal_code, "provider returned non-JSON", LICENSED_SOURCE)

    def fundamentals(self, symbol):
        # type: (str) -> Union[Dict[str, object], Refusal]
        document = self._get_json(
            self.build_fundamentals_url(symbol), "provider_fundamentals_error"
        )
        if isinstance(document, Refusal):
            return document
        # Pass the raw licensed document through with provenance; the
        # normalization into public_market statement facts is a
        # follow-up once a real keyed response can be fixtured (real
        # bytes law — no idealized mapping of a payload never seen).
        return {
            "mock": False,
            "symbol": symbol,
            "raw": document,
            "provenance": {
                "source": LICENSED_SOURCE,
                "dataset_version": None,
                "as_of": None,
                "fetched_at": _utc_now_iso(),
            },
        }

    def eod_price(self, symbol):
        # type: (str) -> Union[Dict[str, object], Refusal]
        document = self._get_json(self.build_eod_url(symbol), "provider_eod_error")
        if isinstance(document, Refusal):
            return document
        # EODHD /eod returns a list of {date, close, ...} rows.
        if not isinstance(document, list) or not document:
            return refuse("provider_eod_error", "empty EOD response", LICENSED_SOURCE)
        row = document[0]
        if not isinstance(row, dict) or "close" not in row or "date" not in row:
            return refuse(
                "provider_eod_error", "EOD row missing close/date", LICENSED_SOURCE
            )
        as_of = str(row["date"])
        try:
            value = float(row["close"])
        except (TypeError, ValueError):
            return refuse(
                "provider_eod_error", "EOD close is not numeric", LICENSED_SOURCE
            )
        return {
            "mock": False,
            "symbol": symbol,
            "value": value,
            "currency": str(row.get("currency") or ""),  # ABSENT stays visible
            "as_of": as_of,
            "provenance": {
                "source": LICENSED_SOURCE,
                "dataset_version": None,
                "as_of": as_of,
                "fetched_at": _utc_now_iso(),
            },
        }


def provider_from_env(env=None):
    # type: (Optional[Dict[str, str]]) -> object
    """The one resolver every call site uses. Blank/whitespace keys are
    NOT keys — an accidentally-empty env var must not flip live."""
    if env is None:
        import os

        env = dict(os.environ)
    api_key = (env.get(PROVIDER_ENV_KEY) or "").strip()
    if not api_key:
        return MockProvider()
    return LicensedProvider(api_key=api_key)


def provider_is_live(provider):
    # type: (object) -> bool
    capabilities = getattr(provider, "capabilities", None)
    return bool(capabilities is not None and getattr(capabilities, "live", False))


def _utc_now_iso():
    # type: () -> str
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat(timespec="seconds")
