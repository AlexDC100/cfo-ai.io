"""Common size, the variance bridge, and top movers — measured on real books.

FIXTURES ARE REAL AND COMMITTED: the `scandia_fy2025` (analytic) and
`eei_dec_2025` (synthetic) regression baselines, plus a condensed
derivation of the analytic book (the one transformation the external
balanță applies). The identities the bridge walks were MEASURED on these
envelopes before being written into `analysis.py`; this file is what
keeps them measured.

WHAT THESE RED ON, with the module correct (TC-11):
  · a bridge that no longer closes to the cent on the real pair
  · a bridge served with a plug — a perturbed envelope must REFUSE with
    the residual named, never close by inventing a step
  · a derived line (EBITDA, total assets) ranked as a mover, so a move
    counts twice
  · a verdict on a line with no declared direction
  · the materiality floor no longer rendered from the data (TC-10)
  · common size stated as a percentage of a percentage instead of points
  · a refused column acquiring a share, a movement or a verdict
"""
from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

from engine.comparatives import build_comparative_columns, spec_for
from engine.comparatives.analysis import (
    FAVORABLE_DIRECTION,
    MATERIALITY_FLOOR,
    bs_bridge,
    common_size,
    movers,
    pl_bridge,
)
from engine.comparatives.lines import ZERO_FLOOR
from engine.country_packs.ro_romania.detail_level import (
    SYNTHETIC_MAX_DIGITS,
    classify_detail_level,
)

REPO = Path(__file__).resolve().parents[2]
BASELINES = (REPO / "src" / "engine" / "country_packs" / "ro_romania"
             / "fixtures" / "regression_baselines")


def _baseline(name):
    with open(str(BASELINES / (name + ".json")), encoding="utf-8") as fh:
        return json.load(fh)["assembled"]


def _level(env):
    return classify_detail_level(
        [li.get("ro_account_code") for li in env["lineItems"]]).level


def _condense(envelope, revenue_factor=0.97):
    """The external condensed book: codes rolled to the synthetic
    boundary, the doubtful-receivable row folded into trade receivables,
    and — because a real prior is a different YEAR — net turnover moved
    with the P&L chain re-derived so the assembler's identities still
    hold. Nothing else is touched."""
    out = copy.deepcopy(envelope)
    for li in out["lineItems"]:
        code = str(li.get("ro_account_code") or "")
        if code.isdigit():
            li["ro_account_code"] = code[:SYNTHETIC_MAX_DIGITS]
        if (li.get("canonical_bucket") or li.get("bucket")) == "ar_doubtful":
            li["canonical_bucket"] = "ar"
            li["bucket"] = "ar"
    out["statements"]["assembled_bs"]["ar_doubtful_gross"] = 0.0
    pl = out["statements"]["assembled_pl"]
    pl["revenue"] = round(pl["revenue"] * revenue_factor, 2)
    pl["ebitda"] = round(pl["revenue"] + pl["other_income_758"]
                         + pl["other_income_781_reversals"] - pl["cogs"]
                         - pl["opex_total"], 2)
    pl["ebit"] = round(pl["ebitda"] - pl["depreciation"], 2)
    pl["pretax"] = round(pl["ebit"] + pl["net_financial_result"], 2)
    pl["net_income_operational"] = round(pl["pretax"] - pl["tax"], 2)
    pl["net_income_statutory"] = pl["net_income_operational"]
    return out


ANALYTIC = _baseline("scandia_fy2025")
SYNTHETIC = _baseline("eei_dec_2025")
CONDENSED = _condense(ANALYTIC)


def _table(cur, pri):
    return build_comparative_columns(cur, pri, _level(cur), _level(pri), "cur", "pri")


@pytest.fixture(params=[("analytic_vs_condensed", ANALYTIC, CONDENSED),
                        ("analytic_vs_synthetic", ANALYTIC, SYNTHETIC)],
                ids=lambda p: p[0])
def pair(request):
    return request.param


# ── the bridge ────────────────────────────────────────────────────────

def test_the_pl_bridge_closes_to_the_cent_on_the_real_pair(pair):
    _, cur, pri = pair
    b = pl_bridge(cur, pri, _table(cur, pri))
    assert b.closes, b.reason
    assert b.residual == 0.0
    walked = b.prior_total + sum(s.amount for s in b.steps)
    assert abs(walked - b.current_total) < ZERO_FLOOR
    # The walk names its own statement of closure — no prose threshold.
    assert "to the cent" in b.reason


def test_both_bs_bridges_close_to_the_cent_on_the_real_pair(pair):
    _, cur, pri = pair
    assets, le = bs_bridge(cur, pri, _table(cur, pri))
    for b in (assets, le):
        assert b.closes, b.reason
        assert abs(b.prior_total + sum(s.amount for s in b.steps) - b.current_total) < ZERO_FLOOR


def test_a_broken_identity_refuses_the_bridge_instead_of_plugging_it():
    """THE PLUG GATE. Move one component without moving the total: the
    assembler's identity no longer holds, and the bridge must say so with
    the residual, not close by inventing a step."""
    cur = copy.deepcopy(ANALYTIC)
    cur["statements"]["assembled_pl"]["opex_total"] += 1234.56
    b = pl_bridge(cur, CONDENSED)
    assert b.closes is False
    assert b.residual is not None and abs(abs(b.residual) - 1234.56) < ZERO_FLOOR
    assert "refused" in b.reason and "1234.56" in b.reason
    # And no step appeared to absorb it.
    assert not any("residual" in s.key or "plug" in s.key for s in b.steps)

    bs_cur = copy.deepcopy(ANALYTIC)
    bs_cur["statements"]["assembled_bs"]["cash"] += 99.99
    assets, _ = bs_bridge(bs_cur, CONDENSED)
    assert assets.closes is False and abs(abs(assets.residual) - 99.99) < ZERO_FLOOR


def test_a_missing_field_refuses_the_bridge_by_name():
    cur = copy.deepcopy(ANALYTIC)
    del cur["statements"]["assembled_pl"]["depreciation"]
    b = pl_bridge(cur, CONDENSED)
    assert b.closes is False and b.residual is None
    assert "current.assembled_pl.depreciation" in b.reason


def test_a_line_only_one_period_carries_is_a_named_new_or_gone_step():
    """eei has no cogs bucket; scandia does. The step is the whole current
    figure and is labelled `new` — not a delta from a fabricated zero."""
    t = _table(ANALYTIC, SYNTHETIC)
    b = pl_bridge(ANALYTIC, SYNTHETIC, t)
    cogs = next(s for s in b.steps if s.key == "pl.cogs")
    assert cogs.status == "new"
    assert cogs.prior == 0.0 or cogs.prior is None
    assert b.closes


def test_the_statutory_adjustment_is_an_explicit_step():
    """eei's statutory net income differs from its operational one by the
    capitalised own work (722); the walk carries that as a named step."""
    b = pl_bridge(ANALYTIC, SYNTHETIC)
    adj = next(s for s in b.steps if s.key == "pl.statutory_adjustment")
    pl_s = SYNTHETIC["statements"]["assembled_pl"]
    expected_prior = pl_s["net_income_statutory"] - pl_s["net_income_operational"]
    assert abs(adj.prior - expected_prior) < ZERO_FLOOR
    assert abs(expected_prior - 2164079.83) < ZERO_FLOOR  # measured on eei


# ── movers ────────────────────────────────────────────────────────────

def test_movers_rank_only_bucket_backed_lines_so_nothing_counts_twice(pair):
    _, cur, pri = pair
    m = movers(_table(cur, pri))
    for mv in m.top + m.improved + m.deteriorated:
        spec = spec_for(mv.key)
        assert spec is not None and spec.source_buckets, (
            "%s is a derived line and was ranked as a mover" % mv.key)


def test_the_top_mover_on_the_real_pair_is_net_turnover():
    m = movers(_table(ANALYTIC, CONDENSED))
    assert m.top and m.top[0].key == "pl.revenue"
    assert m.top[0].verdict == "improved"
    assert abs(m.top[0].delta - 12411826.80) < ZERO_FLOOR  # 3% of 413.7M, measured


def test_verdicts_follow_the_declared_direction_and_nothing_else(pair):
    _, cur, pri = pair
    m = movers(_table(cur, pri))
    for mv in m.top:
        fav = FAVORABLE_DIRECTION.get(mv.key)
        if fav is None:
            assert mv.verdict is None, "%s has no declared direction yet got %r" % (mv.key, mv.verdict)
        elif mv.delta > 0:
            assert mv.verdict == ("improved" if fav == "up" else "deteriorated")
        else:
            assert mv.verdict == ("deteriorated" if fav == "up" else "improved")
    assert all(mv.verdict == "improved" for mv in m.improved)
    assert all(mv.verdict == "deteriorated" for mv in m.deteriorated)


def test_the_materiality_floor_is_rendered_from_the_data():
    m = movers(_table(ANALYTIC, CONDENSED))
    assert m.materiality_floor == MATERIALITY_FLOOR
    assert m.bases["PL"][0] == "pl.revenue" and m.bases["BS"][0] == "bs.total_assets"
    # 30 lines moved by less than the floor on this pair — counted, not hidden.
    assert m.below_floor > 0
    assert all(mv.materiality >= MATERIALITY_FLOOR for mv in m.top)


def test_a_refused_column_is_never_a_mover():
    t = _table(ANALYTIC, CONDENSED)
    refused = {c.key for c in t.refusals()}
    assert "bs.ar_doubtful_gross" in refused  # the measured trap
    m = movers(t)
    assert not (refused & {mv.key for mv in m.top + m.improved + m.deteriorated})


def test_movers_are_deterministic():
    t = _table(ANALYTIC, SYNTHETIC)
    a = [(m.key, m.delta) for m in movers(t).top]
    b = [(m.key, m.delta) for m in movers(t).top]
    assert a == b


# ── common size ───────────────────────────────────────────────────────

def test_common_size_delta_is_in_percentage_points():
    rows = {r.key: r for r in common_size(_table(ANALYTIC, CONDENSED))}
    cogs = rows["pl.cogs"]
    assert cogs.status == "compared"
    expected_pts = (cogs.current_share - cogs.prior_share) * 100.0
    assert abs(cogs.delta_pts - expected_pts) < 1e-3
    # cogs is unchanged in money; revenue rose 3%, so its share FELL — a
    # percentage-of-percentage reading would show a ~-3% relative change
    # instead of the ~-1.6 point drop.
    assert -2.0 < cogs.delta_pts < -1.0


def test_a_refused_column_has_no_share_and_no_points():
    rows = {r.key: r for r in common_size(_table(ANALYTIC, CONDENSED))}
    r = rows["bs.ar_doubtful_gross"]
    assert r.status == "absent_prior"
    assert r.prior_share is None and r.delta_pts is None
    assert r.current_share is not None  # the current side is a real share


def test_a_zero_base_refuses_the_share_rather_than_dividing():
    cur = copy.deepcopy(ANALYTIC)
    cur["statements"]["assembled_pl"]["revenue"] = 0.0
    rows = {r.key: r for r in common_size(_table(cur, CONDENSED))}
    assert rows["pl.cogs"].status == "no_base"
    assert rows["pl.cogs"].current_share is None
    assert "zero floor" in rows["pl.cogs"].note
