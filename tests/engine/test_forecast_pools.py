"""forecast-pools — the cost pools of section 5, on the four books, with no
shock (plan_contract_v2 5.1, 5.2, 5.3, 5.6; battery gate ``forecast-pools``;
plan/2 B4b).

WHAT IT CHECKS
==============
On agras, carniprod, realestate and retail:

- the pools plus the unallocated residual equal the assembled
  opex_excluding_cogs_and_da to the cent, and the cost_of_sales pool is the
  assembled cost of sales; every share (of operating cost, and each pool's
  fixed share) is printed with the unallocated amount and share beside the
  refusal cutoff rendered from the pack (TC-10);
- the amount-weighted fixed share of the served opex pools is the ONE
  ``opex_fixed_share`` engine.forecast_drivers publishes, to the micro
  (contract 4);
- the cap, checked DIRECTLY: no served opex pool whose tier is not user has
  a variable base above cost_behaviour.yaml#variable_base_max_share_of_revenue
  x anchor revenue; a capped pool serves fixed_share 1, tier convention, the
  cap sentence and a rejected rung; capped names and counts are printed per
  book, and a count of 0 on realestate reds;
- with revenue_growth supplied as a caller assumption of -0.20 and inflation
  0, plan-year-one cost_of_sales equals mul_div(base, 800000, MICRO) to the
  cent and plan-year-one operating_costs equals the 5.3 formula evaluated
  HERE per pool (fixed part at C = 1, variable part at G = 0.8), each pool
  printed;
- nil pools: counts printed per book; on a test-built copy of agras with
  every 624 row removed, transport_logistics serves the nil_pool rung (fixed
  share 0, tier convention, the fit and classification rungs rejected with
  reason nil pool) and the plan projects.

WHAT THIS GATE REDS ON AFTER THE REPAIR (TC-11)
-----------------------------------------------
A pool input that drops a row (the sum no longer ties to the assembled
figure, or the split refuses by name and the source is no longer the line
items); a second derivation of the opex fixed share in forecast_drivers (the
micro no longer agrees); a pool over the cap left variable (the direct cap
check, on realestate); cost of sales grown with the inflation index instead
of revenue growth (the growth check); a fixed share ignored in the pool
arithmetic (the agras operating_costs check); the nil_pool rung deleted (the
test-built book refuses); a scope over nothing (TC-3).

IT CANNOT SEE: a shock (volume, price, input price, pool level compile only
in B5 — scenario-cost-behaviour); the two-point fit rung (B7); the served
bytes of the pools (B6).
"""

from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

from engine.forecast import project_payload
from engine.forecast.assumptions import AssumptionSet
from engine.forecast.errors import AssumptionError
from engine.forecast.money import MICRO, cents_from, fmt, mul_div
from engine.forecast.pools import (COST_OF_SALES, FIXED_SHARE_PREFIX, LEVEL_PREFIX,
                                   OPEX_BUCKET, UNALLOCATED, PackError,
                                   load_cost_behaviour, split_for_payload)
from engine.forecast.project import assumptions_for_payload
from engine.forecast_drivers import build_case_set

REPO = Path(__file__).resolve().parents[2]
FIRM = REPO / "tests" / "engine" / "fixtures" / "firm"
PACK = REPO / "packs" / "forecast" / "cost_behaviour.yaml"
BOOKS = ("agras", "carniprod", "realestate", "retail")
SYNTHETIC = "agras without its 624 rows (transport_logistics nil)"

#: A caller rate for the one line a book may not price itself, so the
#: growth check exercises the pools rather than re-testing that refusal.
_CALLER_REVOLVER_RATE = 0.09

_WORK = {"sum_checks": 0, "share_checks": 0, "cap_checks": 0,
         "growth_checks": 0, "nil_checks": 0}
_CAPPED = {}
_NIL = {}
_SHARES = {}


@pytest.fixture(autouse=True)
def _no_access_log(monkeypatch):
    monkeypatch.setenv("ENGINE_ACCESS_LOG", "0")


def load(name):
    return json.loads((FIRM / ("saga_10_col_%s.json" % name)).read_text(encoding="utf-8"))


def _pl(book):
    return book["statements"]["assembled_pl"]


def _project(book, **drivers):
    try:
        return project_payload(book, **drivers)
    except AssumptionError as exc:
        if "revolver_rate" not in str(exc) or "revolver_rate" in drivers:
            raise
        return project_payload(book, revolver_rate=_CALLER_REVOLVER_RATE, **drivers)


def _year_one(projection, line):
    """A cost line's plan-year-one charge, positive (the P&L stores costs
    as negatives)."""
    return -sum(p.pl[line] for p in projection.periods if p.period.year_offset == 1)


# ── 5.1: the pools are the line items, to the cent ──────────────────────


@pytest.mark.parametrize("name", BOOKS)
def test_pools_plus_unallocated_equal_the_assembled_operating_cost_to_the_cent(name, capsys):
    book = load(name)
    pack = load_cost_behaviour()
    split = split_for_payload(book)
    opex = cents_from(_pl(book)["opex_excluding_cogs_and_da"])
    cogs = cents_from(_pl(book).get("cogs") or 0)
    _WORK["sum_checks"] += 1
    assert split.source == "line_items" and not split.refused, (
        "%s: the split did not come from the line items (%s, %s)"
        % (name, split.source, split.refusal_rule_id))
    assert split.opex_names()[-1] == UNALLOCATED
    assert set(split.opex_names()[:-1]) == set(pack.pools)
    assert split.opex_sum_cents == opex, (
        "%s: the pools sum to %s, the assembled operating cost is %s (delta %s)"
        % (name, fmt(split.opex_sum_cents), fmt(opex), fmt(split.opex_sum_cents - opex)))
    assert split.cost_of_sales.base_cents == cogs, (name, fmt(split.cost_of_sales.base_cents), fmt(cogs))
    assert split.unallocated_share_micros is not None
    assert split.unallocated_share_micros <= pack.micros("max_unallocated_share")
    # the projection runs on THIS split, and serves its pools by key
    projection = _project(book, horizon_years=1)
    assert projection.assumptions.pools is not None
    assert projection.assumptions.pools.as_dict() == split.as_dict()
    keys = projection.assumptions.pool_keys()
    assert keys == split.fixed_share_keys() + split.level_keys(), keys
    assert keys[0] == FIXED_SHARE_PREFIX + COST_OF_SALES
    assert all(not k.startswith(LEVEL_PREFIX + COST_OF_SALES) for k in keys)
    rows = []
    for pool in split.opex:
        share_of_opex = mul_div(pool.base_cents, MICRO, opex) if opex else 0
        rows.append("%s %s (%s of operating cost; fixed share %s; %s)"
                    % (pool.name, fmt(pool.base_cents), _pct(share_of_opex),
                       _pct(pool.fixed_share_micros), pool.rule_id.split("#")[-1]))
    _SHARES[name] = rows
    with capsys.disabled():
        print("\n%s pools: cost_of_sales %s; operating cost %s over %d pools; "
              "unallocated %s (%s of operating cost, refusal above %s per %s)"
              % (name, fmt(split.cost_of_sales.base_cents), fmt(opex), len(split.opex),
                 fmt(split.unallocated_cents), _pct(split.unallocated_share_micros),
                 pack.rule("max_unallocated_share").value,
                 pack.rule("max_unallocated_share").rule_id))
        for row in rows:
            print("  " + row)


def _pct(micros):
    return "%.4f%%" % (micros / 10000.0)


# ── contract 4: one opex fixed share ────────────────────────────────────


@pytest.mark.parametrize("name", BOOKS)
def test_the_aggregate_fixed_share_is_the_one_forecast_drivers_publishes(name, capsys):
    book = load(name)
    split = split_for_payload(book)
    # computed HERE from the served pools, amount-weighted
    base = sum(p.base_cents for p in split.opex if p.base_cents > 0)
    fixed = sum(mul_div(p.base_cents, p.fixed_share_micros, MICRO)
                for p in split.opex if p.base_cents > 0)
    ours = mul_div(fixed, MICRO, base)
    model = assumptions_for_payload(book)["pools.opex_fixed_share"]
    drivers = build_case_set([book]).case("base").driver("opex_fixed_share")
    _WORK["share_checks"] += 1
    assert model.exact == ours == split.aggregate_fixed_share_micros(), (
        name, model.exact, ours, split.aggregate_fixed_share_micros())
    assert drivers is not None and drivers.exact == model.exact, (
        "%s: forecast_drivers opex_fixed_share %r, the engine's pool split %r "
        "— two derivations of one concept (contract 4)"
        % (name, getattr(drivers, "exact", None), model.exact))
    assert drivers.unit == "rate" and drivers.tier == model.tier, (name, drivers.unit, drivers.tier, model.tier)
    with capsys.disabled():
        print("%s opex_fixed_share: engine %s = forecast_drivers %s (amount-weighted over %s of pooled cost)"
              % (name, _pct(model.exact), _pct(drivers.exact), fmt(base)))


# ── 5.2: the cap, checked directly ──────────────────────────────────────


@pytest.mark.parametrize("name", BOOKS)
def test_no_served_opex_pool_keeps_a_variable_base_above_the_packs_share_of_revenue(name, capsys):
    book = load(name)
    pack = load_cost_behaviour()
    rule = pack.rule("variable_base_max_share_of_revenue")
    projection = _project(book, horizon_years=1)
    pools = projection.assumptions.pools
    revenue = pools.revenue_cents
    limit = mul_div(max(revenue, 0), pack.micros("variable_base_max_share_of_revenue"), MICRO)
    capped = []
    for pool in pools.opex:
        driver = projection.assumptions[FIXED_SHARE_PREFIX + pool.name]
        if driver.tier == "user":
            continue
        _WORK["cap_checks"] += 1
        variable_base = pool.base_cents - mul_div(pool.base_cents, driver.exact, MICRO)
        assert variable_base <= limit, (
            "%s %s: variable base %s exceeds %s x revenue %s = %s and the pool "
            "was left variable" % (name, pool.name, fmt(variable_base), rule.value,
                                   fmt(revenue), fmt(limit)))
        if pool.capped:
            capped.append(pool.name)
            assert driver.exact == MICRO and driver.tier == "convention"
            assert driver.rule_id == rule.rule_id
            assert rule.render() in driver.basis, driver.basis
            assert any(s["outcome"] == "rejected" for s in driver.fallback_steps), driver.fallback_steps
    _CAPPED[name] = capped
    with capsys.disabled():
        print("%s capped pools: %d (%s); cap %s x revenue %s = %s (%s)"
              % (name, len(capped), ", ".join(capped) or "none", rule.value,
                 fmt(revenue), fmt(limit), rule.rule_id))
    if name == "realestate":
        assert capped, "realestate serves no capped pool: the cap is not applied"
        assert "third_party_services" in capped, capped


# ── 5.3: the formula, at a twenty-percent fall with no inflation ────────


@pytest.mark.parametrize("name", BOOKS)
def test_a_twenty_percent_fall_moves_cost_of_sales_in_full_and_each_pool_by_its_variable_part(name, capsys):
    book = load(name)
    projection = _project(book, horizon_years=1, revenue_growth=-0.2, inflation=0)
    pools = projection.assumptions.pools
    g = 800000  # G = 0.8 in micros
    cogs_base = pools.cost_of_sales.base_cents
    cogs_share = projection.assumptions[FIXED_SHARE_PREFIX + COST_OF_SALES].exact
    assert cogs_share == 0, (name, cogs_share)
    expected_cogs = mul_div(cogs_base, g, MICRO)
    got_cogs = _year_one(projection, "cost_of_sales")
    _WORK["growth_checks"] += 1
    assert got_cogs == expected_cogs, (
        "%s: plan-year-one cost of sales %s, expected %s x 0.8 = %s"
        % (name, fmt(got_cogs), fmt(cogs_base), fmt(expected_cogs)))
    expected_opex = 0
    rows = []
    for pool in pools.opex:
        share = projection.assumptions[FIXED_SHARE_PREFIX + pool.name].exact
        level = projection.assumptions[LEVEL_PREFIX + pool.name].exact
        assert level == MICRO, (name, pool.name, level)
        # 5.3: F = round(B x f x C), V = round(B x G) - round(B x f x G),
        # each ONE exact product rounded once (never a rounded product
        # rounded again)
        fixed_part = mul_div(pool.base_cents, share, MICRO)  # C = 1
        variable_part = (mul_div(pool.base_cents, g, MICRO)
                         - mul_div(pool.base_cents, share * g, MICRO * MICRO))
        expected_opex += fixed_part + variable_part
        rows.append("%s base %s fixed %s -> fixed part %s + variable part %s"
                    % (pool.name, fmt(pool.base_cents), _pct(share),
                       fmt(fixed_part), fmt(variable_part)))
    got_opex = _year_one(projection, "operating_costs")
    _WORK["growth_checks"] += 1
    assert got_opex == expected_opex, (
        "%s: plan-year-one operating costs %s, the 5.3 formula gives %s "
        "(delta %s)\n%s" % (name, fmt(got_opex), fmt(expected_opex),
                            fmt(got_opex - expected_opex), "\n".join(rows)))
    revenue = sum(p.pl["revenue"] for p in projection.periods if p.period.year_offset == 1)
    assert revenue == mul_div(pools.revenue_cents, g, MICRO), (name, revenue)
    with capsys.disabled():
        print("%s at revenue -20%%, inflation 0: cost_of_sales %s -> %s; operating costs %s -> %s"
              % (name, fmt(cogs_base), fmt(got_cogs), fmt(pools.opex_sum_cents), fmt(got_opex)))
        for row in rows:
            print("  " + row)


def test_zz_the_growth_check_had_a_book_with_a_cost_of_sales_pool():
    assert any(split_for_payload(load(n)).cost_of_sales.base_cents > 0 for n in BOOKS), (
        "no book carries cost of sales; the growth check proved nothing (TC-3)")


# ── 5.2 rung 0: nil pools ───────────────────────────────────────────────


@pytest.mark.parametrize("name", BOOKS)
def test_nil_pool_counts_are_printed(name, capsys):
    split = split_for_payload(load(name))
    pack = load_cost_behaviour()
    nil = [p.name for p in split.opex if p.base_cents == 0]
    for pool in split.opex:
        if pool.base_cents == 0:
            _WORK["nil_checks"] += 1
            if pool.name == UNALLOCATED:
                assert pool.rule_id == pack.rule("unallocated_follows_allocated").rule_id
            else:
                assert pool.rule_id == pack.rule("nil_pool").rule_id and pool.fixed_share_micros == 0
    _NIL[name] = nil
    with capsys.disabled():
        print("%s nil pools: %d (%s)" % (name, len(nil), ", ".join(nil) or "none"))


def _agras_without_624():
    """A test-built copy of agras with every 624 row removed and the
    assembled operating cost reduced by exactly their sum, so the rows
    still tie to the figure (5.1)."""
    book = copy.deepcopy(load("agras"))
    removed = 0
    kept = []
    for row in book["line_items"]:
        code = str(row.get("ro_account_code") or "")
        if row.get("bucket") == OPEX_BUCKET and code.startswith("624"):
            removed += cents_from(row["amount"])
            continue
        kept.append(row)
    assert removed != 0, "agras carries no 624 row; the shape proves nothing"
    book["line_items"] = kept
    opex = cents_from(_pl(book)["opex_excluding_cogs_and_da"]) - removed
    _pl(book)["opex_excluding_cogs_and_da"] = "%d.%02d" % divmod(opex, 100)
    return book, removed


def test_a_book_whose_pool_is_nil_serves_the_nil_pool_rung_and_projects(capsys):
    book, removed = _agras_without_624()
    pack = load_cost_behaviour()
    projection = _project(book, horizon_years=2)
    _WORK["nil_checks"] += 1
    assert len(projection.periods) > 0
    pool = projection.assumptions.pools.pool("transport_logistics")
    driver = projection.assumptions[FIXED_SHARE_PREFIX + "transport_logistics"]
    assert pool.base_cents == 0 and pool.row_count == 0
    assert (driver.exact, driver.tier, driver.rule_id) == (0, "convention", pack.rule("nil_pool").rule_id), (
        driver.exact, driver.tier, driver.rule_id)
    assert pack.rule("nil_pool").render() in driver.basis
    steps = [(s["tier"], s["outcome"], s["reason"]) for s in driver.fallback_steps]
    assert [s[:2] for s in steps] == [("book", "absent"), ("sector", "absent"),
                                      ("convention", "rejected")], steps
    assert steps[-1][2] == "nil pool", steps
    assert not projection.assumptions.pools.refused
    with capsys.disabled():
        print("SYNTHETIC %s: %s of 624 rows removed; transport_logistics %s %s (%s); "
              "%d periods projected" % (SYNTHETIC, fmt(removed), driver.tier,
                                        _pct(driver.exact), driver.rule_id.split("#")[-1],
                                        len(projection.periods)))


# ── the pack refuses a malformed map at load ────────────────────────────


def _pack_copy(tmp_path, old, new):
    text = PACK.read_text(encoding="utf-8")
    assert text.count(old) == 1, old
    path = tmp_path / "cost_behaviour.yaml"
    path.write_text(text.replace(old, new), encoding="utf-8")
    return path


def test_a_prefix_under_two_pools_is_a_pack_error_at_load(tmp_path):
    path = _pack_copy(tmp_path, '  transport_logistics: ["624"]', '  transport_logistics: ["624", "605"]')
    with pytest.raises(PackError) as caught:
        load_cost_behaviour(path)
    assert "605" in str(caught.value) and "two pools" in str(caught.value)


def test_a_pooled_prefix_with_no_nature_is_a_pack_error_at_load(tmp_path):
    path = _pack_copy(tmp_path, '  variable: ["605", "624",', '  variable: ["605",')
    with pytest.raises(PackError) as caught:
        load_cost_behaviour(path)
    assert "624" in str(caught.value)


# ── scope and work (TC-12, TC-13) ───────────────────────────────────────


def test_zz_scope_and_work(capsys):
    units = sum(_WORK.values())
    with capsys.disabled():
        print("\nSCOPE forecast-pools (plan/2 B4b, contract 5.6): books %s; "
              "horizon 1 for the year-one checks (2 for the nil shape); no shocks; "
              "SYNTHETIC %s; pack %s" % (", ".join(BOOKS), SYNTHETIC, PACK.relative_to(REPO)))
        print("capped pools per book: %s" % "; ".join(
            "%s %d (%s)" % (n, len(v), ", ".join(v) or "none") for n, v in sorted(_CAPPED.items())))
        print("nil pools per book: %s" % "; ".join(
            "%s %d (%s)" % (n, len(v), ", ".join(v) or "none") for n, v in sorted(_NIL.items())))
        print("checks: %s" % ", ".join("%s %d" % kv for kv in sorted(_WORK.items())))
        print("GATE-WORK forecast-pools units=%d" % units)
    assert set(_CAPPED) == set(BOOKS) and set(_NIL) == set(BOOKS) and set(_SHARES) == set(BOOKS)
    assert units > 0, "no check ran (TC-3)"
    assert "pools.opex_fixed_share" in AssumptionSet.POOL_FACTS
