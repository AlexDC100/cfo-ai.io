"""The served legacy balance sheet carries the SAME equity as the served
canonical balance sheet — to the cent — on every period GET /api/period
serves.

THE DEFECT (measured 2026-09-14, ratios wave r1): `get_period` summed
`statement_line_items` into `statements.balanceSheet` with no equity
completion. The line items never carry the current-year result, so the
served `retainedEarnings` and bucket equity were short by exactly
`assembled_pl.net_income_statutory`, beside a served `canonical_bs` whose
equity was complete:

    book              bucket equity served   canonical equity   gap
    agras                  16,390,407.70       23,924,083.72     7,533,676.02
    carniprod             105,460,434.32      106,895,967.91     1,435,533.59
    realestate             41,085,738.87       40,284,134.73      -801,604.14
    retail                 22,018,963.98       25,224,176.60     3,205,212.62
    scandia baseline      113,364,198.01      149,632,161.65    36,267,963.64

The credit model reads `balanceSheet.retainedEarnings` (Altman X2) and the
bucket equity (X4, the equity sub-score, ROE in profitability): on the
Scandia xlsx the serve-time composite fell from A to BBB on this alone.

THE REPAIR is one code object, `pipeline._complete_bucket_equity`, which
`_rebuild_assembled` already ran and `get_period` now runs too.

WHAT THIS REDS ON, AFTER THE REPAIR (TC-11):
  · any of the five books serving bucket equity (shareCapital +
    retainedEarnings + otherEquity) that differs from the served
    `canonical_bs.totals.equity` by half a cent or more — the message
    names the book and the cent gap;
  · a served body with no `canonical_bs` or no equity total (the gate
    would otherwise pass over nothing);
  · `get_period` or `_rebuild_assembled` no longer calling the one
    completion helper (a re-spelled completion is a second authority);
  · THE LEGACY BRANCH: a period persisted with no write-time envelope
    (`assembled_canonical_v1` absent from its row — agras and the Scandia
    baseline, both carrying account-711 production variation) serving
    bucket equity that is not the line items' shareCapital +
    retainedEarnings + otherEquity plus the net income reconstructed from
    the persisted P&L buckets with 711 excluded, to the cent.

  · THE BRIEFING SEAM (ruling Q1, 2026-09-15): `_rebuild_assembled_for_briefing`
    — the rebuild the Capsule tools, Radar, the firm attention lane, briefing
    regenerate and the forecast route read — serving bucket equity that
    differs from the bucket equity GET /api/period serves for the same
    period by half a cent or more, on any of the five books or on the
    legacy no-envelope branch; or no longer calling the one completion.
    Measured before the repair (the seam summed line items with no
    completion): agras 16,390,407.70 against 23,924,083.72, carniprod
    105,460,434.32 / 106,895,967.91, realestate 41,085,738.87 /
    40,284,134.73, retail 22,018,963.98 / 25,224,176.60, Scandia baseline
    113,364,198.01 / 149,632,161.65.

WHAT IT CANNOT SEE: a caller that reads equity from somewhere other than
these rebuilds (the served money facts go through the FactsGateway and are
held by their own gates).
"""
from __future__ import annotations

import ast
import types
from decimal import Decimal
from pathlib import Path

import pytest

import _served_books as SB

PIPELINE = Path(__file__).resolve().parents[2] / "src" / "engine" / "api" / "pipeline.py"


def _d(v) -> Decimal:
    return Decimal(str(v))


@pytest.mark.parametrize("name", SB.ALL_BOOKS)
def test_served_bucket_equity_is_the_served_canonical_equity(name):
    body = SB.served_body(name)
    st = body["statements"]
    bs = st["balanceSheet"]
    cbs = st.get("canonical_bs")
    assert isinstance(cbs, dict), "%s: the served body carries no canonical_bs" % name
    ceq = (cbs.get("totals") or {}).get("equity")
    assert isinstance(ceq, (int, float)), "%s: canonical_bs serves no equity total" % name
    bucket = _d(bs["shareCapital"]) + _d(bs["retainedEarnings"]) + _d(bs["otherEquity"])
    gap = (_d(ceq) - bucket).quantize(Decimal("0.01"))
    assert abs(_d(ceq) - bucket) < Decimal("0.005"), (
        "%s: served balanceSheet equity %s is not the served canonical_bs equity %s "
        "(gap %s RON; served assembled_pl.net_income_statutory %s)"
        % (name, bucket, _d(ceq), gap, (st.get("assembled_pl") or {}).get("net_income_statutory")))


def _calls_in(func_name: str):
    tree = ast.parse(PIPELINE.read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name == func_name:
            return {n.func.id for n in ast.walk(node)
                    if isinstance(n, ast.Call) and isinstance(n.func, ast.Name)}
    raise AssertionError("pipeline.py has no function %s" % func_name)


@pytest.mark.parametrize("func", ["get_period", "_rebuild_assembled", "_rebuild_assembled_for_briefing"])
def test_both_rebuilds_call_the_one_completion(func):
    assert "_complete_bucket_equity" in _calls_in(func), (
        "%s no longer calls _complete_bucket_equity" % func)


#: Persisted bucket -> its sign in the legacy net-income reconstruction.
_PL_SIGN = {"revenue": 1, "otherIncome": 1, "financialIncome": 1, "cogs": -1, "operatingExpenses": -1,
            "depreciation": -1, "interestExpense": -1, "financialExpense": -1, "taxExpense": -1}
_EQUITY_BUCKETS = ("shareCapital", "retainedEarnings", "otherEquity")


@pytest.mark.parametrize("name", ["agras", SB.SCANDIA])
def test_a_period_with_no_envelope_completes_equity_from_its_own_pl_buckets(name):
    bk = SB.book(name)
    period = {k: v for k, v in bk.period.items() if k != "assembled_canonical_v1"}
    legacy = types.SimpleNamespace(period=period, line_items=bk.line_items, org=bk.org,
                                   period_id=bk.period_id)
    body = SB.routed_body(legacy)
    bs = body["statements"]["balanceSheet"]
    served = sum(_d(bs[k]) for k in _EQUITY_BUCKETS)

    items = Decimal(0)
    for bucket in _EQUITY_BUCKETS:
        items += sum((_d(li["amount"] or 0) for li in bk.line_items if li["bucket"] == bucket),
                     Decimal(0)).quantize(Decimal("0.01"))
    excluded_711 = Decimal(0)
    ni = Decimal(0)
    for li in bk.line_items:
        sign = _PL_SIGN.get(li["bucket"])
        if sign is None:
            continue
        if li["bucket"] == "otherIncome" and (li.get("ro_account_code") or "").strip().startswith("711"):
            excluded_711 += _d(li["amount"] or 0)
            continue
        ni += sign * _d(li["amount"] or 0)
    assert excluded_711 != 0, "%s carries no 711 line — the exclusion is untested" % name
    want = items + ni.quantize(Decimal("0.01"))
    assert abs(served - want) <= Decimal("0.01"), (
        "%s (no envelope): served bucket equity %s is not line-item equity %s + reconstructed net "
        "income %s (711 excluded: %s); gap %s" % (name, served, items, ni, excluded_711, served - want))


def _bucket_equity(bs) -> Decimal:
    return sum((_d(bs[k]) for k in _EQUITY_BUCKETS), Decimal(0))


@pytest.mark.parametrize("name", SB.ALL_BOOKS)
def test_the_briefing_seam_serves_the_equity_get_period_serves(name):
    """The rebuild behind the Capsule tools, Radar, the firm attention lane,
    briefing regenerate and the forecast route states the same equity as
    GET /api/period for the same persisted rows, to the cent."""
    from engine.api import pipeline as P

    bk = SB.book(name)
    served = _bucket_equity(SB.served_body(name)["statements"]["balanceSheet"])
    rebuilt = _bucket_equity(P._rebuild_assembled_for_briefing(
        [dict(li) for li in bk.line_items], dict(bk.period), bk.org)["statements"]["balanceSheet"])
    assert abs(rebuilt - served) < Decimal("0.005"), (
        "%s: _rebuild_assembled_for_briefing serves bucket equity %s, GET /api/period serves %s "
        "(gap %s RON)" % (name, rebuilt, served, served - rebuilt))


@pytest.mark.parametrize("name", ["agras", SB.SCANDIA])
def test_the_briefing_seam_completes_a_period_with_no_envelope_like_get_period(name):
    from engine.api import pipeline as P

    bk = SB.book(name)
    period = {k: v for k, v in bk.period.items() if k != "assembled_canonical_v1"}
    legacy = types.SimpleNamespace(period=period, line_items=bk.line_items, org=bk.org,
                                   period_id=bk.period_id)
    served = _bucket_equity(SB.routed_body(legacy)["statements"]["balanceSheet"])
    rebuilt = _bucket_equity(P._rebuild_assembled_for_briefing(
        [dict(li) for li in bk.line_items], period, bk.org)["statements"]["balanceSheet"])
    assert abs(rebuilt - served) < Decimal("0.005"), (
        "%s (no envelope): briefing seam equity %s != GET /api/period equity %s" % (name, rebuilt, served))
