"""Common size, the variance bridge, and top movers — measured on real books.

FIXTURES ARE REAL AND BUILT AT TEST TIME. `_comparatives_fixtures` runs
committed corpus books through the offline reference path, so every
envelope carries exactly what today's assembler emits — including
`other_operating_income`, the term its EBITDA is built from, which the
older regression baselines predate. The pair (one ANALYTIC book, one
SYNTHETIC) is chosen by the pack's own detail-level detector, never by
name; the condensed derivation of the analytic book is the third leg.

The identities the bridge walks were MEASURED on real envelopes before
being written into `analysis.py`; this file keeps them measured — on the
two real client books the first spelling of the EBITDA identity (758 +
781) missed the assembler's term by 326,903.15 on the condensed year,
and the walk now carries the assembler's own field.

WHAT THESE RED ON, with the module correct (TC-11):
  · a bridge that no longer closes to the cent on a real pair
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

from _comparatives_fixtures import condense, level_of, pick_pair

_AN, _SY = pick_pair()
if _AN is None or _SY is None:
    pytest.skip("the corpus no longer carries both an analytic and a synthetic "
                "deterministic book — the pair these gates measure is gone",
                allow_module_level=True)

ANALYTIC_ID, ANALYTIC = _AN
SYNTHETIC_ID, SYNTHETIC = _SY
CONDENSED = condense(ANALYTIC)
REVENUE_FACTOR = 0.97


def _table(cur, pri):
    return build_comparative_columns(cur, pri, level_of(cur), level_of(pri), "cur", "pri")


@pytest.fixture(params=[("analytic_vs_condensed", ANALYTIC, CONDENSED),
                        ("analytic_vs_synthetic", ANALYTIC, SYNTHETIC)],
                ids=lambda p: p[0])
def pair(request):
    return request.param


def test_the_pair_is_what_its_name_says():
    """TC-3 — the gates below compare two DIFFERENT depths."""
    assert level_of(ANALYTIC) == "analytic", ANALYTIC_ID
    assert level_of(SYNTHETIC) == "synthetic", SYNTHETIC_ID
    assert level_of(CONDENSED) == "synthetic"


# ── the bridge ────────────────────────────────────────────────────────

def test_the_pl_bridge_closes_to_the_cent_on_the_real_pair(pair):
    _, cur, pri = pair
    b = pl_bridge(cur, pri, _table(cur, pri))
    assert b.closes, b.reason
    assert b.residual == 0.0
    walked = b.prior_total + sum(s.amount for s in b.steps)
    assert abs(walked - b.current_total) < ZERO_FLOOR
    assert "to the cent" in b.reason


def test_both_bs_bridges_close_to_the_cent_on_the_real_pair(pair):
    _, cur, pri = pair
    assets, le = bs_bridge(cur, pri, _table(cur, pri))
    for b in (assets, le):
        assert b.closes, b.reason
        assert abs(b.prior_total + sum(s.amount for s in b.steps) - b.current_total) < ZERO_FLOOR


def test_the_walk_carries_the_assemblers_own_ebitda_term():
    """The step is `other_operating_income`, not a re-spelling of it."""
    b = pl_bridge(ANALYTIC, CONDENSED)
    keys = [s.key for s in b.steps]
    assert "pl.other_operating_income_total" in keys
    assert not any("781" in k or "758" in k for k in keys)


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
    assert not any("residual" in s.key or "plug" in s.key for s in b.steps)

    # Balance sheet: move one canonical asset ROW without moving the
    # object's totals — the row walk must refuse by that amount.
    bs_cur = copy.deepcopy(ANALYTIC)
    rows = bs_cur["statements"]["canonical_bs"]["rows"]
    first_asset = next(r for r in rows if r["section"] in ("non_current_assets", "current_assets", "prepaid_expenses"))
    first_asset["amount"] = round(float(first_asset["amount"]) + 99.99, 2)
    assets, _ = bs_bridge(bs_cur, CONDENSED)
    assert assets.closes is False and abs(abs(assets.residual) - 99.99) < ZERO_FLOOR
    assert not any("plug" in s.key for s in assets.steps)


def test_a_missing_field_refuses_the_bridge_by_name():
    cur = copy.deepcopy(ANALYTIC)
    del cur["statements"]["assembled_pl"]["depreciation"]
    b = pl_bridge(cur, CONDENSED)
    assert b.closes is False and b.residual is None
    assert "current.assembled_pl.depreciation" in b.reason


def test_a_line_only_one_period_carries_is_a_named_new_step():
    """Remove the prior's cost-of-goods rows (and its figure): the step is
    the whole current figure, labelled `new` — not a delta from a
    fabricated zero — and the walk still closes."""
    pri = copy.deepcopy(CONDENSED)
    pri["lineItems"] = [li for li in pri["lineItems"]
                        if (li.get("canonical_bucket") or li.get("bucket")) != "cogs"]
    pl = pri["statements"]["assembled_pl"]
    # Fold the removed cost into the chain so the assembler's identity
    # still holds on the constructed prior.
    pl["cogs"] = 0.0
    net_72x = pl["capitalized_own_work"]["value"]
    net_711 = pl["inventory_variation"]["value"]
    pl["ebitda_before_stock_variation"] = round(
        pl["revenue"] + pl["other_operating_income"] - pl["cogs"] - pl["opex_total"], 2)
    pl["ebitda"] = round(pl["ebitda_before_stock_variation"] + net_72x + net_711, 2)
    pl["ebit"] = round(pl["ebitda"] - pl["depreciation"], 2)
    pl["pretax"] = round(pl["ebit"] + pl["net_financial_result"], 2)
    pl["net_income_operational"] = round(
        pl["ebitda_before_stock_variation"] - pl["depreciation"] + pl["net_financial_result"] - pl["tax"], 2)
    pl["net_income_statutory"] = round(pl["pretax"] - pl["tax"], 2)
    t = _table(ANALYTIC, pri)
    assert t.by_key("pl.cogs").status == "absent_prior"
    b = pl_bridge(ANALYTIC, pri, t)
    cogs = next(s for s in b.steps if s.key == "pl.cogs")
    assert cogs.status == "new"
    assert abs(cogs.amount + ANALYTIC["statements"]["assembled_pl"]["cogs"]) < ZERO_FLOOR
    assert b.closes, b.reason


def _named_lines(pl):
    return (pl["net_income_operational"] + pl["capitalized_own_work"]["value"]
            + pl["inventory_variation"]["value"])


def test_the_statutory_adjustment_is_an_explicit_step():
    """What account 121 holds beyond every NAMED line — the operational
    build-up, net 72x and the measured net 711 (the one EBITDA, owner ruling
    2026-09-26) — walks as a NAMED step on both sides. Where net 711 came off
    the 121 bridge the step is 0.00 by construction; it is never where 711
    hides (the step names net 711 separately)."""
    b = pl_bridge(ANALYTIC, SYNTHETIC)
    adj = next(s for s in b.steps if s.key == "pl.statutory_adjustment")
    inv = next(s for s in b.steps if s.key == "pl.inventory_variation")
    cap = next(s for s in b.steps if s.key == "pl.capitalized_own_work")
    pl_s = SYNTHETIC["statements"]["assembled_pl"]
    pl_a = ANALYTIC["statements"]["assembled_pl"]
    assert abs(adj.prior - (pl_s["net_income_statutory"] - _named_lines(pl_s))) < ZERO_FLOOR
    assert abs(adj.current - (pl_a["net_income_statutory"] - _named_lines(pl_a))) < ZERO_FLOOR
    assert inv.current == pl_a["inventory_variation"]["value"] and inv.prior == pl_s["inventory_variation"]["value"]
    assert cap.current == pl_a["capitalized_own_work"]["value"]


def test_the_walk_passes_through_the_one_ebitda_on_both_sides():
    """EBITDA = turnover + other operating income + net 72x − cost of sales
    + net 711 − operating expenses, on the CURRENT and the PRIOR envelope,
    to the cent — the identity the walk's steps sum (owner ruling
    2026-09-26; before it, the walk had no 711 and no 72x step and the
    statutory adjustment carried both)."""
    for env in (ANALYTIC, SYNTHETIC, CONDENSED):
        pl = env["statements"]["assembled_pl"]
        built = (pl["revenue"] + pl["other_operating_income"] + pl["capitalized_own_work"]["value"]
                 - pl["cogs"] + pl["inventory_variation"]["value"] - pl["opex_total"])
        assert abs(built - pl["ebitda"]) < 0.01, (built, pl["ebitda"])
    keys = [s.key for s in pl_bridge(ANALYTIC, CONDENSED).steps]
    assert keys.index("pl.inventory_variation") == keys.index("pl.cogs") + 1  # beside cost of sales


def test_a_refused_ebitda_refuses_the_bridge_with_its_reason():
    """A period whose one EBITDA is refused has no stock variation to walk:
    the bridge refuses by name, on either side, and computes no step."""
    import copy as _copy
    pri = _copy.deepcopy(CONDENSED)
    pri["statements"]["assembled_pl"]["ebitda_refusal"] = {
        "code": "book_state_mixed", "text_en": "the trial balance is partly closed",
        "fields": ["ebitda", "ebit", "gross_profit", "pretax"]}
    pri["statements"]["assembled_pl"]["inventory_variation"]["value"] = None
    for cur, prior, side in ((ANALYTIC, pri, "prior"), (pri, ANALYTIC, "current")):
        b = pl_bridge(cur, prior)
        assert b.closes is False and b.residual is None and b.steps == ()
        assert "the %s period (book_state_mixed" % side in b.reason, b.reason


# ── movers ────────────────────────────────────────────────────────────

def test_movers_rank_only_bucket_backed_lines_so_nothing_counts_twice(pair):
    _, cur, pri = pair
    m = movers(_table(cur, pri))
    for mv in m.top + m.improved + m.deteriorated:
        spec = spec_for(mv.key)
        assert spec is not None and spec.source_buckets, (
            "%s is a derived line and was ranked as a mover" % mv.key)


def test_the_top_mover_on_the_condensed_pair_is_net_turnover():
    """Only net turnover moved (by 3%); it must top the list, improved, by
    exactly the amount the derivation moved it."""
    m = movers(_table(ANALYTIC, CONDENSED))
    assert m.top and m.top[0].key == "pl.revenue"
    assert m.top[0].verdict == "improved"
    revenue = ANALYTIC["statements"]["assembled_pl"]["revenue"]
    assert abs(m.top[0].delta - round(revenue - round(revenue * REVENUE_FACTOR, 2), 2)) < ZERO_FLOOR


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
    # Every unmoved line sits under the floor — counted, not hidden.
    assert m.below_floor > 0
    assert all(mv.materiality >= MATERIALITY_FLOOR for mv in m.top)


def test_a_refused_column_is_never_a_mover():
    t = _table(ANALYTIC, CONDENSED)
    refused = {c.key for c in t.refusals()}
    assert refused, "nothing was refused — the analytic-only family is gone"
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
    # cogs is unchanged in money; revenue rose by 1/0.97, so its share
    # fell to share/1.0309…: the change is POINTS, s - s/f... spelled out:
    expected_pts = (cogs.current_share - cogs.prior_share) * 100.0
    assert abs(cogs.delta_pts - expected_pts) < 1e-3
    assert cogs.prior_share > cogs.current_share
    # And it is not a relative change (which would be a flat -3% for every line).
    assert abs(cogs.delta_pts - (-3.0)) > 0.01 or cogs.current_share == 0.0


def test_a_refused_column_has_no_share_and_no_points():
    t = _table(ANALYTIC, CONDENSED)
    rows = {r.key: r for r in common_size(t)}
    refused = [c.key for c in t.refusals()]
    assert refused
    for key in refused:
        r = rows[key]
        assert r.delta_pts is None
        assert r.status not in ("compared",)


def test_a_zero_base_refuses_the_share_rather_than_dividing():
    cur = copy.deepcopy(ANALYTIC)
    cur["statements"]["assembled_pl"]["revenue"] = 0.0
    rows = {r.key: r for r in common_size(_table(cur, CONDENSED))}
    assert rows["pl.cogs"].status == "no_base"
    assert rows["pl.cogs"].current_share is None
    assert "zero floor" in rows["pl.cogs"].note
