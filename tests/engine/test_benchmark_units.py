"""Unit-collision regression — the "EBITDA margin 1553.0%" class.

Production, 2026-08-30: the benchmark engine converted ratio-stored
margins to percent BY NAME, the frontend multiplied by 100 again, and a
period whose operating recompute could not run rendered 1553.0% for a
real 15.53% margin. The stored data was correct the whole time; only the
unit convention collided.

The fix converts by each ROW'S OWN unit. These three cases were proved
in the production container the day of the fix; they live here so the
class cannot come back — a name list can drift, a unit field cannot.
"""
from __future__ import annotations

import pytest

from engine.api import _benchmark_engine as be


def _margin(rows):
    return be.compute_company_metrics(rows, [])["ebitda_margin"]


def test_stored_pct_is_not_doubled():
    # Already a display percentage -> passes through untouched.
    assert _margin([{"name": "ebitda_margin", "value": 15.53, "unit": "pct"}]) == pytest.approx(15.53)


def test_stored_ratio_is_scaled_once():
    # The engine's own stage_compute unit ("ratio", 0..1).
    assert _margin([{"name": "ebitda_margin", "value": 0.1553, "unit": "ratio"}]) == pytest.approx(15.53)


def test_legacy_row_without_unit_keeps_the_name_fallback():
    # Pre-unit-column rows still convert — the fallback exists for them.
    assert _margin([{"name": "ebitda_margin", "value": 0.1553}]) == pytest.approx(15.53)


def test_ratio_DISPLAY_metric_is_never_scaled():
    # debt_to_ebitda is displayed as a multiple, not a percent: a
    # "ratio" unit here must NOT trigger the x100 path.
    out = be.compute_company_metrics(
        [{"name": "debt_to_ebitda", "value": 2.05, "unit": "ratio"}], [])
    assert out["debt_to_ebitda"] == pytest.approx(2.05)


def test_every_pct_display_metric_round_trips_from_ratio():
    """The whole pct family, not just the three that broke."""
    pct_names = [n for n, d in be.METRIC_DISPLAY.items() if d.get("fmt") == "pct"]
    assert "ebitda_margin" in pct_names and len(pct_names) >= 3
    rows = [{"name": n, "value": 0.10, "unit": "ratio"} for n in pct_names]
    out = be.compute_company_metrics(rows, [])
    for n in pct_names:
        if n in out:  # some are recomputed downstream from line items
            assert out[n] == pytest.approx(10.0), n
