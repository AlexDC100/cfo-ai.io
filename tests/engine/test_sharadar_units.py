"""SHARADAR unit scaling — the 10^6 that two tables disagree on.

Measured against real captured API bytes (2026-09-09, prod key):

    SHARADAR/DAILY  AAPL  marketcap = 4,614,971.6          <- USD MILLIONS
    SHARADAR/SF1    AAPL  marketcap = 3,995,082,560,610    <- USD UNITS

Same vendor, same field name, a factor of a million apart. The adapter
scales DAILY at its boundary so everything downstream speaks raw USD --
in TWO separate places, with two different idioms (an inline
``* 1_000_000`` in the batch path, a ``_millions_to_usd`` helper in the
single path). That is precisely the shape where one gets repaired and
the other silently does not, so these tests pin both paths and pin that
they agree with each other.

What these gates red on, with the code correct (TC-11):
  - a DAILY path that stops scaling, or scales by the wrong power
  - the two DAILY paths drifting apart from one another
  - SF1 marketcap/ev acquiring a scale factor it must never have
  - the fixture being replaced by hand-written round numbers (TC-1)
"""
from __future__ import annotations

import json
from datetime import date
from pathlib import Path

import pytest

from engine.public.adapter import NasdaqAdapter

FIXTURE = (Path(__file__).parent / "fixtures" / "public_market"
           / "sharadar_units_REAL.json")

# AAPL's market capitalisation is on the order of 4e12 USD. Anything
# inside this band is dollars; the millions form lands near 4e6.
USD_TRILLIONS_LOW, USD_TRILLIONS_HIGH = 1e12, 2e13
MILLIONS_LOW, MILLIONS_HIGH = 1e6, 2e7


def _rows(key: str):
    payload = json.loads(FIXTURE.read_text())[key]["datatable"]
    cols = [c["name"] for c in payload["columns"]]
    return [dict(zip(cols, r)) for r in payload["data"]]


def _adapter() -> NasdaqAdapter:
    return NasdaqAdapter(api_key="test-key-not-used-no-network")


# ── the raw bytes really do disagree ────────────────────────────────

def test_the_fixture_is_real_vendor_bytes_not_round_numbers():
    """TC-1. Hand-written fixtures pick tidy numbers; the vendor does not."""
    for key in ("daily_aapl", "daily_msft", "sf1_aapl"):
        row = _rows(key)[0]
        cap = row["marketcap"]
        assert cap is not None
        assert cap != round(cap, -3), (
            f"{key} marketcap={cap} is suspiciously round for real API bytes"
        )


def test_daily_and_sf1_report_marketcap_a_million_apart():
    """The premise of every scaling rule below. If this ever fails, the
    vendor changed its units and both call sites need rereading."""
    daily = _rows("daily_aapl")[0]["marketcap"]
    sf1 = _rows("sf1_aapl")[0]["marketcap"]
    assert MILLIONS_LOW < daily < MILLIONS_HIGH, (
        f"SHARADAR/DAILY marketcap={daily} is no longer in the millions band"
    )
    assert USD_TRILLIONS_LOW < sf1 < USD_TRILLIONS_HIGH, (
        f"SHARADAR/SF1 marketcap={sf1} is no longer in the raw-USD band"
    )
    ratio = sf1 / daily
    assert 1e5 < ratio < 1e7, f"expected ~1e6 between the tables, got {ratio:.3g}"


# ── both DAILY paths scale, and agree ───────────────────────────────

def _parse_single(adapter, row, monkeypatch):
    monkeypatch.setattr(adapter, "_require_available", lambda: None)
    monkeypatch.setattr(adapter, "_fetch_datatable",
                        lambda *a, **k: [row])
    return adapter.get_daily_metrics(row["ticker"])


def _parse_batch(adapter, rows, monkeypatch):
    monkeypatch.setattr(adapter, "_require_available", lambda: None)
    monkeypatch.setattr(adapter, "_fetch_datatable",
                        lambda *a, **k: list(rows))
    return adapter.get_daily_metrics_batch([r["ticker"] for r in rows])


@pytest.mark.parametrize("key", ["daily_aapl", "daily_msft"])
def test_single_path_scales_daily_millions_to_usd(key, monkeypatch):
    row = _rows(key)[0]
    got = _parse_single(_adapter(), row, monkeypatch)
    assert got is not None, "the single DAILY path returned nothing"
    assert got.market_cap == pytest.approx(row["marketcap"] * 1_000_000)
    assert got.enterprise_value == pytest.approx(row["ev"] * 1_000_000)
    assert USD_TRILLIONS_LOW < got.market_cap < USD_TRILLIONS_HIGH, (
        f"{key} served market_cap={got.market_cap} is not a plausible "
        f"USD market capitalisation for a mega-cap"
    )


def test_batch_path_scales_daily_millions_to_usd(monkeypatch):
    rows = [_rows("daily_aapl")[0], _rows("daily_msft")[0]]
    got = _parse_batch(_adapter(), rows, monkeypatch)
    assert set(got) == {"AAPL", "MSFT"}, f"batch path returned {sorted(got)}"
    for r in rows:
        m = got[r["ticker"]]
        assert m.market_cap == pytest.approx(r["marketcap"] * 1_000_000)
        assert m.enterprise_value == pytest.approx(r["ev"] * 1_000_000)


def test_the_two_daily_paths_do_not_drift_apart(monkeypatch):
    """The real gate. Two idioms for one conversion; when someone repairs
    or changes one, this reds unless they change the other."""
    row = _rows("daily_aapl")[0]
    single = _parse_single(_adapter(), row, monkeypatch)
    batch = _parse_batch(_adapter(), [row], monkeypatch)["AAPL"]
    assert single.market_cap == batch.market_cap, (
        f"single path says {single.market_cap}, batch path says "
        f"{batch.market_cap} for identical vendor bytes"
    )
    assert single.enterprise_value == batch.enterprise_value


@pytest.mark.parametrize("field", ["ev_ebitda", "ev_ebit", "pe_ratio",
                                   "pb_ratio", "ps_ratio"])
def test_unitless_multiples_are_never_scaled(field, monkeypatch):
    row = _rows("daily_aapl")[0]
    got = _parse_single(_adapter(), row, monkeypatch)
    raw_name = {"ev_ebitda": "evebitda", "ev_ebit": "evebit",
                "pe_ratio": "pe", "pb_ratio": "pb", "ps_ratio": "ps"}[field]
    assert getattr(got, field) == pytest.approx(row[raw_name]), (
        f"{field} is a ratio and must pass through the adapter untouched"
    )


# ── SF1 must never acquire the DAILY scale factor ───────────────────

def test_sf1_marketcap_is_already_usd_and_must_not_be_scaled():
    """The inverse bug. SF1 is in units; multiplying it by 1e6 would put
    Apple's market cap at 4e18 -- larger than world GDP."""
    sf1 = _rows("sf1_aapl")[0]
    assert USD_TRILLIONS_LOW < sf1["marketcap"] < USD_TRILLIONS_HIGH
    assert USD_TRILLIONS_LOW < sf1["ev"] < USD_TRILLIONS_HIGH


def test_only_the_daily_table_carries_a_million_scaling_in_the_adapter():
    """Structural. Pins that the 1e6 conversion appears only where DAILY
    rows are parsed -- a new scaling site elsewhere reds this."""
    src = (Path(__file__).parents[2] / "src" / "engine" / "public"
           / "adapter.py").read_text()
    code = "\n".join(
        line.split("#")[0] if line.strip().startswith("#") is False else ""
        for line in src.splitlines()
    )
    occurrences = code.count("1_000_000")
    assert occurrences == 3, (
        f"expected exactly 3 non-comment '1_000_000' occurrences in "
        f"adapter.py (batch marketcap, batch ev, the _millions_to_usd "
        f"helper) -- found {occurrences}. A new one means a fourth "
        f"scaling site that these gates do not cover."
    )
