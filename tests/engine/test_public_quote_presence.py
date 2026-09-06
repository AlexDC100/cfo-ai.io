# -*- coding: utf-8 -*-
"""A QUOTE TIMESTAMP RIDES A PRICE, NEVER A PROVIDER ENTRY.

``_bvb_seed_rows`` merged the live quote sweep like this::

    q = quotes.get(row["ticker"])
    if q:
        row["price"] = q.get("price", row.get("price"))
        ...
        row["quoteAsOf"] = quoted_at

``if q:`` is a TRUTHINESS test on the provider's dict, not a presence test
on the price. A provider entry carrying any other field — a change
percentage, a currency, a symbol echo, an error note — is truthy, so the
row kept the seed's ``price: None`` and gained a ``quoteAsOf`` stating
when that absent price was observed. The frontend reads ``quoteAsOf`` as
"this price is as of", so the card would carry an observation day for a
figure it does not have.

Latent on today's provider (``yahoo_bvb`` only emits entries that carry a
price), which is exactly why it needs a gate: it is one provider field
away from live, and nothing else in the suite would notice.

TC-1 — the rows are the REAL seed table (``bvb_seed._BVB_TABLE``), not a
hand-built double; only the provider seam is replaced, and the shapes it
returns are the shapes a provider can actually produce.
TC-3 — every law asserts it had rows to be about before asserting.
No network: the sweep function is monkeypatched at the provider module.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

_SRC = Path(__file__).resolve().parents[2] / "src"
if (_SRC / "engine").exists() and str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

from engine.public import universe_service  # noqa: E402
from engine.public.providers import yahoo_bvb  # noqa: E402


@pytest.fixture(autouse=True)
def _fresh_quote_cache():
    saved = dict(universe_service._bvb_quotes_cache)
    universe_service._bvb_quotes_cache.update({"at": 0.0, "quoted_at": None, "quotes": {}})
    yield
    universe_service._bvb_quotes_cache.clear()
    universe_service._bvb_quotes_cache.update(saved)


def _sweep(monkeypatch, quotes):
    monkeypatch.setattr(
        yahoo_bvb, "fetch_bvb_spark_quotes", lambda tickers, timeout=12.0: quotes
    )


def _rows():
    return {r["ticker"]: r for r in universe_service._bvb_seed_rows()}


# ── the shapes a provider can return ────────────────────────────────────

PRICELESS_SHAPES = {
    # The entry exists but names no price at all.
    "no_price_key": {"priceChangePct": 1.25},
    # The entry names the price and says it is absent.
    "explicit_none": {"price": None, "priceChangePct": 1.25},
    # An entry carrying only bookkeeping — still truthy.
    "echo_only": {"symbol": "TLV.RO"},
}


@pytest.mark.parametrize("shape", sorted(PRICELESS_SHAPES))
def test_a_priceless_quote_entry_stamps_no_observation_day(monkeypatch, shape):
    _sweep(monkeypatch, {"TLV": PRICELESS_SHAPES[shape]})
    rows = _rows()
    tlv = rows.get("TLV")
    assert tlv is not None, "the seed no longer carries TLV — this gate has no subject"
    assert tlv.get("price") is None, (
        "the seed row already carries a price, so this shape cannot show "
        "whether quoteAsOf followed the price or the provider entry"
    )
    assert tlv.get("quoteAsOf") is None, (
        f"provider shape {shape!r} carries no price, yet the row was stamped "
        f"quoteAsOf={tlv.get('quoteAsOf')!r} — an observation day for a figure "
        "that does not exist."
    )


def test_a_priceless_entry_does_not_silence_the_rest_of_the_universe(monkeypatch):
    """TC-9 — a clean result must be distinguishable from an empty one."""
    _sweep(monkeypatch, {"TLV": {"priceChangePct": 1.25}})
    rows = _rows()
    assert len(rows) >= 80, "the seed universe is empty, so the laws above are vacuous"
    assert all(r.get("quoteAsOf") is None for r in rows.values())


def test_a_real_price_still_carries_its_sweep_time(monkeypatch):
    """TC-9, the other half: the stamp is REFUSED, not removed."""
    _sweep(monkeypatch, {"TLV": {"price": 31.5, "priceChangePct": 0.4}})
    rows = _rows()
    tlv = rows["TLV"]
    assert tlv["price"] == 31.5
    assert tlv["quoteAsOf"] is not None, (
        "a row that DID receive a price carries no observation day — the fix "
        "removed the stamp instead of tying it to the price"
    )
    assert tlv["priceChangePct"] == 0.4
    # A quote does not make the SEEDED figures fresher.
    assert tlv["lastUpdated"] != tlv["quoteAsOf"]


def test_a_price_of_zero_is_a_price(monkeypatch):
    """0.0 is falsy in Python and is a legitimate quote. The presence test
    must key on `is not None`, not on truth."""
    _sweep(monkeypatch, {"TLV": {"price": 0.0}})
    tlv = _rows()["TLV"]
    assert tlv["price"] == 0.0
    assert tlv["quoteAsOf"] is not None, (
        "a quoted price of 0.0 was dropped by a truthiness test — the same "
        "class of bug this gate exists for, with the sign reversed"
    )
