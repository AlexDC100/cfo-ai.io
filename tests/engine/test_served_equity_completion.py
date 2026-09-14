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
    completion helper (a re-spelled completion is a second authority).

WHAT IT CANNOT SEE: `_rebuild_assembled_for_briefing` (the Capsule /
Radar / briefing seam) still builds `balanceSheet` without the completion;
that seam is a recorded live defect held for the owner, not gated here —
a gate that allowlisted it would pin it.
"""
from __future__ import annotations

import ast
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


@pytest.mark.parametrize("func", ["get_period", "_rebuild_assembled"])
def test_both_rebuilds_call_the_one_completion(func):
    assert "_complete_bucket_equity" in _calls_in(func), (
        "%s no longer calls _complete_bucket_equity" % func)
