"""Floor-substitute fixes, batch C3 / group C5 — the served period day count
and the RO pack's ROA check (owner ruling R-OTHER, 2026-09-15).

What this file reds on AFTER the repair (TC-11), beside the plant that
proved it (TC-2 — plant log in docs/engine_book/gates.md, `floor-valuation`):

* periodDays — reds if a 31 December book stops serving exactly
  ``{"periodDays": 365}`` (the corpus regression), if a June book serves
  365, or if a fallback-filed period serves any day count.
* ROA — reds if a non-positive asset base grades the check pass or fail.
"""
from __future__ import annotations

import copy
import math
import types
from pathlib import Path
from typing import Any, Dict

import pytest

from engine.api import _valuation as V
from engine.api import pipeline as P
from engine.country_packs.ro_romania import chart_of_accounts as COA

import test_rebuild_net_income_anchor as ANCHOR

REPO = Path(__file__).resolve().parents[2]

def _corpus_book(name: str):
    return ANCHOR._book("saga_10_col_%s" % name, REPO / "corpus" / ("saga_10_col_%s" % name))


# ── periodDays ──────────────────────────────────────────────────────────


@pytest.mark.parametrize("end,start,signal,days", [
    ("2025-12-31", "2025-12-31", "user_confirmed", 365),
    ("2024-12-31", "2024-12-31", "filename", 366),
    ("2025-06-30", "2025-06-30", "in_document", 181),
    ("2025-12-31", "2025-01-01", None, 365),        # stated span (the Scandia baseline row)
])
def test_period_days_are_established_from_the_period(end, start, signal, days):
    covered = COA.period_days_covered(end, period_start=start, signal_used=signal)
    assert covered["days"] == days and covered["refusal"] is None


@pytest.mark.parametrize("end,start,signal,why", [
    ("2025-12-31", "2025-12-31", "fallback_today", "'fallback_today' signal"),
    ("2025-12-31", "2025-12-31", None, "no detection record"),
    ("not-a-date", None, "filename", "not a date"),
    (None, None, "user_confirmed", "not a date"),
])
def test_an_unestablished_period_length_refuses_rather_than_reading_as_a_year(end, start, signal, why):
    covered = COA.period_days_covered(end, period_start=start, signal_used=signal)
    assert covered["days"] is None
    assert covered["refusal"].startswith(COA.PERIOD_DAYS_REFUSAL_PREFIX)
    assert why in covered["refusal"]


def _served(monkeypatch, bk):
    with ANCHOR._routed(bk, monkeypatch) as (client, _db):
        resp = client.get("/api/period/%s" % bk.period_id, headers={"Authorization": "Bearer test"})
    assert resp.status_code == 200, resp.text[:400]
    return resp.json()


def _with_period(bk, **changes):
    period = copy.deepcopy(bk.period)
    signal = changes.pop("signal", None)
    period.update(changes)
    if signal is not None:
        period["assembled_canonical_v1"]["period_detection"]["signal_used"] = signal
    return types.SimpleNamespace(period=period, line_items=bk.line_items, org=bk.org,
                                 period_id=bk.period_id)


def _dso(body):
    row = [r for r in body["assembled_metrics"]["ratio_table"]["rows"] if r["key"] == "dso"][0]
    days = [o for o in row["operands"] if o["name"] == "period_days"][0]
    return row["value"], days


def test_a_31_december_corpus_book_serves_exactly_the_bytes_it_served_before(monkeypatch):
    body = _served(monkeypatch, _corpus_book("agras"))
    assert body["statements"]["supplementary"] == {"periodDays": 365}
    _value, days = _dso(body)
    assert days == {"name": "period_days", "value": 365.0, "source": "supplementary.periodDays"}


def test_a_june_year_to_date_book_serves_its_true_day_count(monkeypatch):
    """Measured before the fix: the Scandia baseline scaled to a 181/365 YTD
    served DSO 37.6 -> 75.7 under periodDays 365."""
    bk = _corpus_book("agras")
    dec_value, _ = _dso(_served(monkeypatch, bk))
    june = _served(monkeypatch, _with_period(bk, period_end="2025-06-30", period_start="2025-06-30"))
    assert june["statements"]["supplementary"] == {"periodDays": 181}
    june_value, days = _dso(june)
    assert days["value"] == 181.0
    assert math.isclose(june_value, dec_value * 181 / 365, rel_tol=1e-9)


def test_a_fallback_filed_period_serves_no_day_count_and_says_why(monkeypatch):
    bk = _with_period(_corpus_book("agras"), signal="fallback_today")
    sup = _served(monkeypatch, bk)["statements"]["supplementary"]
    assert sup["periodDays"] is None
    assert sup["periodDaysRefusal"].startswith(COA.PERIOD_DAYS_REFUSAL_PREFIX)


def test_the_assembler_does_not_claim_a_period_length_it_was_not_given():
    """`assemble_statements` wrote a hard-coded 365 placeholder."""
    accounts = [{"code": "5121", "name": "Bank", "amount": 100.0},
                {"code": "1012", "name": "Capital", "amount": -100.0}]
    bare = COA.assemble_statements(accounts)
    assert bare["statements"]["supplementary"] == {"periodDays": None}
    given = COA.assemble_statements(accounts, period_end="2025-12-31", period_start="2025-01-01")
    assert given["statements"]["supplementary"] == {"periodDays": 365}


# ── RO pack: ROA check (C5.1) ───────────────────────────────────────────


@pytest.mark.parametrize("total_assets", [0.0, -5_000.0])
def test_roa_on_a_non_positive_asset_base_is_uncertain_and_not_scored(total_assets):
    """Measured before the fix: NI 120,000 on TA 0 served roa_positive
    'fail' "0.00% on 0 RON total assets", score 3."""
    out = COA._piotroski_checks(net_income_statutory=120_000.0, total_assets=total_assets,
                                cash_from_operating=150_000.0, prior=None, currency="RON")
    roa = [c for c in out["checks"] if c["key"] == "roa_positive"][0]
    assert roa["result"] == "uncertain"
    assert roa["detail"].startswith("ROA not computable: total assets are not positive")
    assert out["score"] == 3  # ni_positive + cfo_positive + cfo_gt_ni — ROA not counted


def test_roa_on_a_positive_asset_base_is_graded_as_before():
    out = COA._piotroski_checks(net_income_statutory=120_000.0, total_assets=1_000_000.0,
                                cash_from_operating=150_000.0, prior=None, currency="RON")
    roa = [c for c in out["checks"] if c["key"] == "roa_positive"][0]
    assert roa == {"key": "roa_positive", "label": "ROA positive", "result": "pass",
                   "detail": "12.00% on 1,000,000 RON total assets"}
    assert out["score"] == 4




@pytest.mark.xfail(strict=True, reason=(
    "UNDONE — lane 1 owns src/engine/ratios: `ratios/table.py` substitutes "
    "`constant.period_days_default` (365) for an absent periodDays, so the DSO "
    "row of the SAME GET /api/period response carries a value beside "
    "`supplementary.periodDaysRefusal` (the FE's `bsOr` then falls back to "
    "that engine metric). Strict: this goes red the day lane 1 refuses, and "
    "the marker is removed then."))
def test_the_dso_row_on_a_fallback_filed_period_carries_no_value(monkeypatch):
    """Measured (2026-09-19, corpus agras, signal_used='fallback_today'):
    `supplementary: {'periodDays': None, 'periodDaysRefusal': 'Day-count
    ratios unavailable: ...'}` beside `dso 26.205674261074325` with the
    operand `{"name": "period_days", "value": 365.0, "source":
    "constant.period_days_default"}` — the refusal re-floored one layer down."""
    bk = _with_period(_corpus_book("agras"), signal="fallback_today")
    body = _served(monkeypatch, bk)
    assert body["statements"]["supplementary"]["periodDays"] is None
    row = [r for r in body["assembled_metrics"]["ratio_table"]["rows"] if r["key"] == "dso"][0]
    assert row["value"] is None, row["value"]
    assert not any(o.get("source") == "constant.period_days_default" for o in row["operands"])
