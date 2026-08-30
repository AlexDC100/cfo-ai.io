"""Licensed-provider slot + prices slot — keyless degradation contract.

The two laws these tests enforce, in zero-owner mode:

1. KEYLESS NEVER TOUCHES THE NETWORK. With no PROVIDER_API_KEY the
   provider resolves to the mock and the price block is ABSENT; any
   socket/urlopen attempt in a keyless flow is a test failure.
2. ABSENT != ZERO for prices: keyless mode returns None — the serving
   envelope simply has no price block, and the serving layer's honest
   "prices unavailable" state is the rendering of that absence. No
   placeholder quote, no 0.0, no mock number ever enters an envelope.

Every served price carries {as_of, delay_note} — the delay note comes
from the market registry — and is_stale() is the PM4 hook.
"""

from __future__ import annotations

import socket
import urllib.request

import pytest

from engine.public_market import prices, providers
from engine.public_market._refusal import Refusal


class _NetworkTrap(object):
    """Any attempt to open a connection fails the test loudly."""

    def __init__(self, monkeypatch):
        def _boom(*args, **kwargs):
            raise AssertionError("keyless flow attempted network access")

        monkeypatch.setattr(socket, "create_connection", _boom)
        monkeypatch.setattr(urllib.request, "urlopen", _boom)
        monkeypatch.setattr(providers, "_urlopen", _boom, raising=False)


# ────────────────────────────────────────────────────────────────────
# Provider slot: keyless → mock, key → licensed
# ────────────────────────────────────────────────────────────────────


def test_keyless_env_resolves_to_mock():
    p = providers.provider_from_env({})
    assert p.capabilities.live is False
    assert p.name == "provider:mock"
    # whitespace is not a key
    p2 = providers.provider_from_env({"PROVIDER_API_KEY": "   "})
    assert p2.capabilities.live is False


def test_keyless_mode_never_attempts_the_network(monkeypatch):
    _NetworkTrap(monkeypatch)
    p = providers.provider_from_env({})
    fundamentals = p.fundamentals("STF.PA")
    quote = p.eod_price("STF.PA")
    assert fundamentals["mock"] is True
    assert quote["mock"] is True
    # and the keyless PRICE path is absent without any socket either
    assert prices.price_block("STF.PA", "FR", env={}) is None


def test_mock_output_is_unmistakably_mock():
    p = providers.provider_from_env({})
    f = p.fundamentals("STF.PA")
    assert f["mock"] is True
    assert f["provenance"]["source"] == "provider:mock"
    q = p.eod_price("STF.PA")
    assert q["mock"] is True
    assert q["provenance"]["source"] == "provider:mock"


def test_api_key_activates_the_licensed_path():
    p = providers.provider_from_env({"PROVIDER_API_KEY": "k-secret-123"})
    assert p.capabilities.live is True
    assert p.capabilities.fundamentals_quarterly is True
    url = p.build_fundamentals_url("STF.PA")
    assert url.startswith("https://eodhd.com/api/fundamentals/STF.PA?")
    assert "api_token=k-secret-123" in url
    # the key never leaks through repr/str
    assert "k-secret-123" not in repr(p)
    assert "k-secret-123" not in str(p)


def test_licensed_url_builders_are_pure_and_quote_symbols():
    p = providers.LicensedProvider(api_key="k")
    url = p.build_eod_url("BRK A")  # pathological symbol: must be quoted
    assert " " not in url
    assert url.startswith("https://eodhd.com/api/eod/")


# ────────────────────────────────────────────────────────────────────
# Prices slot: keyless = fundamentals-only (price block ABSENT)
# ────────────────────────────────────────────────────────────────────


def test_price_block_keyless_is_absent_not_mocked():
    # None IS the contract: the envelope omits the price key entirely
    # and the serving layer renders its honest "prices unavailable"
    # state. A mock quote must never be promoted into an envelope.
    assert prices.price_block("AAPL", "US", env={}) is None


class _StubLiveProvider(object):
    """Protocol stub for a live provider — no network, canned quote."""

    name = "provider:stub"
    capabilities = providers.ProviderCapabilities(
        fundamentals_annual=True,
        fundamentals_quarterly=True,
        eod_prices=True,
        delayed_intraday=False,
        markets=("US",),
        live=True,
    )

    def eod_price(self, symbol):
        return {
            "symbol": symbol,
            "value": 187.5,
            "currency": "USD",
            "as_of": "2026-08-28",
            "provenance": {
                "source": "provider:stub",
                "dataset_version": "stub-1",
                "as_of": "2026-08-28",
                "fetched_at": "2026-08-29T10:00:00+00:00",
            },
        }


def test_live_price_block_is_labeled_with_as_of_and_delay_note():
    now = "2026-08-29T10:00:00+00:00"
    block = prices.price_block("AAPL", "US", provider=_StubLiveProvider(), now=now)
    assert block is not None and not isinstance(block, Refusal)
    assert block["value"] == 187.5
    assert block["as_of"] == "2026-08-28"
    assert block["delay_note"] == prices.MARKET_REGISTRY["US"]["delay_note"]
    assert block["cadence"] == "eod"
    assert block["stale"] is False
    assert block["provenance"]["source"] == "provider:stub"


def test_live_quote_without_as_of_fails_closed():
    class _Broken(_StubLiveProvider):
        def eod_price(self, symbol):
            return {"symbol": symbol, "value": 1.0, "currency": "USD"}

    out = prices.price_block("AAPL", "US", provider=_Broken(), now="2026-08-29T10:00:00+00:00")
    assert isinstance(out, Refusal)
    assert out.code == "price_missing_as_of"


def test_unknown_market_gets_the_conservative_default_note():
    assert prices.delay_note_for("ZZ") == prices.DEFAULT_DELAY_NOTE
    note = prices.delay_note_for("GB")
    assert note == prices.MARKET_REGISTRY["GB"]["delay_note"]


def test_home_market_is_not_in_this_registry():
    # PM7: BVB / public_ro is a separate, untouched deterministic feed.
    # This slot must never claim Romania.
    assert "RO" not in prices.MARKET_REGISTRY


def test_registry_carries_license_notes_for_every_market():
    for code, entry in prices.MARKET_REGISTRY.items():
        assert entry["license_notes"], code
        assert entry["delay_note"], code
        assert entry["cadence"] in prices.STALENESS_BUDGETS, code


# ────────────────────────────────────────────────────────────────────
# Staleness (PM4 hook)
# ────────────────────────────────────────────────────────────────────


def test_is_stale_eod_budget():
    price = {"as_of": "2026-08-27"}
    assert prices.is_stale(price, "eod", now="2026-08-29T12:00:00+00:00") is False
    assert prices.is_stale(price, "eod", now="2026-09-05T12:00:00+00:00") is True


def test_is_stale_realtime_budget():
    price = {"as_of": "2026-08-29T11:30:00+00:00"}
    assert prices.is_stale(price, "realtime", now="2026-08-29T11:40:00+00:00") is False
    assert prices.is_stale(price, "realtime", now="2026-08-29T12:30:00+00:00") is True


def test_is_stale_accepts_zulu_timestamps():
    price = {"as_of": "2026-08-29T11:30:00Z"}
    assert prices.is_stale(price, "realtime", now="2026-08-29T11:40:00Z") is False


def test_is_stale_fails_closed():
    # missing as_of → stale; unparseable as_of → stale; unknown cadence → stale
    assert prices.is_stale({}, "eod", now="2026-08-29T12:00:00+00:00") is True
    assert prices.is_stale({"as_of": "not-a-date"}, "eod", now="2026-08-29T12:00:00+00:00") is True
    assert prices.is_stale({"as_of": "2026-08-29"}, "warp-speed", now="2026-08-29T12:00:00+00:00") is True
