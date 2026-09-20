"""forecast-defaults, engine half (plan_contract_v2 F3, 3.3, 3.4, R16; B3).

Every driver of every projection the engine makes on the four committed
books carries a tier from its own 3.4 ladder, the evidence that tier
requires, and a fallback step for every rung it did not take. Measured
through ``project()`` (``project_payload``), never on hand-built drivers.

WHAT THIS GATE REDS ON AFTER THE REPAIR (TC-11)
-----------------------------------------------
* a tier outside the six of 3.3, or a tier the driver's 3.4 ladder does not
  contain (the LADDERS table below, the contract's ladder written as data);
* evidence that does not match the tier (book without method, periods and
  inputs; macro without its series id, source, stated_as_of or with a
  fetched_at; convention without rule id, pack address and evidence list;
  absent carrying a value or evidence, or no fallback step);
* a driver OUTSIDE the absent-legal list of 3.3 ending absent on a corpus
  book (``engine.forecast.assumptions.ABSENT_LEGAL``, the list the model
  reads through ``micros_or_none``);
* a projection whose drivers include an absent one that does not project
  (the count of such projections is printed, and 0 reds, TC-3);
* a revenue_growth of zero that is not the convention rung with its
  fallback steps (a silent zero);
* a tier that moves when a rung's SENTENCE is reworded (the tier is set at
  the put() site, never inferred from text);
* a book whose effective tax rate is not measured, in a jurisdiction with
  no packed statutory rate (or with no recorded jurisdiction), that
  projects instead of refusing with ``no_statutory_tax_rate`` — through the
  engine and through GET /api/forecast as a 422;
* a corpus book whose jurisdiction is not recorded (0.3; the source per
  book is printed);
* the jurisdiction read from anywhere but pack_provenance, then ai_audit,
  then nowhere (0.3): an envelope carrying only ai_audit.jurisdiction that
  does not reach the macro and statutory rungs, or ai_audit read before
  pack_provenance when both are present;
* a driver whose fallback_steps do not record every rung its 3.4 ladder
  passed over, in order, for the tier it ended on (the STEPS table below):
  a tax macro rung with no book-absent step, a payout or held money
  convention rung with no book-absent step, a capex terminal rung with no
  rejected maintenance step;
* a statutory tax rung whose integer is not the pack record's value (the
  record's value is changed in a tmp copy of ro_macro.yaml and the rung
  must follow it: a code literal equal to today's pack value reds);
* a working-capital basis that quotes a days value under the ratio table's
  name that is not the served ratio table's own value (engine.ratios.table,
  inventory or trade payables x period days / total operating expense)
  on the corpus books, checked against
  tests/engine/fixtures/firm/served_metrics.json at that file's own
  rounding, or that quotes methodology.ratios (which divides by cost of
  sales) at all.

IT CANNOT SEE: the served bytes (B6 extends this gate over fp1.2 in
test_forecast_defaults_f3.py); the book-history and sector rungs (B7, and no
sector store exists); whether a macro anchor is still the published figure.
"""

from __future__ import annotations

import copy
import json
import os
from pathlib import Path

import pytest

from engine.forecast import project_payload
from engine.forecast.assumptions import (ABSENT_LEGAL, KEYS, OUTCOMES, TIERS,
                                         NoStatutoryTaxRate, jurisdiction_of)

REPO = Path(__file__).resolve().parents[2]
FIRM = REPO / "tests" / "engine" / "fixtures" / "firm"
BOOKS = ("agras", "carniprod", "realestate", "retail")
HORIZONS = (3, 5)

#: Contract 3.4, the default ladder of each driver (layer 1 of 2.5), as the
#: set of tiers a resolved default may END on. User is not a default tier.
#: The three pre-B4 share keys are on the book rung, else absent (their
#: refusal refuses the plan); B4 removes them.
LADDERS = {
    "revenue_growth": ("book", "sector", "macro", "convention"),
    # plan/2 B4b (3.4): inflation is macro then convention; the cost shares
    # left KEYS for the pools; other operating income is HELD (5.5).
    "inflation": ("macro", "convention"),
    "other_operating_income_annual": ("book", "convention"),
    "dso_days": ("book", "absent"),
    "dio_cogs_days": ("book", "absent"),
    "dpo_cogs_days": ("book", "absent"),
    "depreciation_rate": ("book", "absent"),
    "capex_pct_of_revenue": ("convention",),
    "intangible_additions_pct_of_revenue": ("convention",),
    "tax_rate": ("book", "macro", "absent"),
    "interest_rate_debt": ("book", "absent"),
    "revolver_rate": ("book", "absent"),
    "interest_income_rate": ("book", "absent"),
    "interest_income_annual": ("book", "convention"),
    "other_financial_income_annual": ("book", "convention"),
    "other_financial_expense_annual": ("book", "convention"),
    "dividend_payout_pct": ("convention",),
    "min_cash": ("convention",),
    "days_basis": ("convention",),
}

#: Contract 3.4, the rungs a driver PASSED OVER before the tier it ended
#: on, in order, as (tier, outcome) — keyed (driver, end tier, rule), where
#: rule is None unless one end tier has two rungs (capex). A driver ending
#: on a (key, tier, rule) this table does not name reds: the table is the
#: ladder written as data, so a new rung must be added here to pass.
_ABSENT = ("book", "absent")
STEPS = {
    ("revenue_growth", "macro", None): (_ABSENT, ("sector", "absent")),
    ("revenue_growth", "convention", None): (_ABSENT, ("sector", "absent"),
                                             ("macro", "absent")),
    ("tax_rate", "book", None): (),
    ("tax_rate", "macro", None): (_ABSENT,),
    ("tax_rate", "absent", None): (_ABSENT, ("macro", "absent")),
    ("dividend_payout_pct", "convention", None): (_ABSENT,),
    ("inflation", "macro", None): (),
    ("inflation", "convention", None): (("macro", "absent"),),
    ("capex_pct_of_revenue", "convention",
     "packs/forecast/levers.yaml#capex_maintenance_replaces_depreciation"): (),
    ("capex_pct_of_revenue", "convention",
     "packs/forecast/levers.yaml#capex_pct_of_revenue.terminal_rung"): (
        ("convention", "rejected"),),
    ("intangible_additions_pct_of_revenue", "convention", None): (),
    ("min_cash", "convention", None): (),
    ("days_basis", "convention", None): (),
}
for _key in ("interest_income_annual", "other_financial_income_annual",
             "other_financial_expense_annual",
             "other_operating_income_annual"):
    STEPS[(_key, "book", None)] = ()
    STEPS[(_key, "convention", None)] = (_ABSENT,)
for _key in ("dso_days", "dio_cogs_days", "dpo_cogs_days", "depreciation_rate",
             "interest_rate_debt", "revolver_rate", "interest_income_rate"):
    STEPS[(_key, "book", None)] = ()
    STEPS[(_key, "absent", None)] = (_ABSENT,)


#: plan/2 B4b (contract 3a.2, 5.2): the per-book POOL drivers, expanded
#: from the two levers.yaml templates over the pools the book serves. Every
#: pool_fixed_share.<pool> ends on convention in this build (the book
#: two_point_fit rung lands in B7; sector is absent), and the rung it ends
#: on is named by its rule: the ladder is keyed by the pack rule, because
#: one tier (convention) has six rungs a pool may end on. pool_level.<opex
#: pool> ends on the neutral index rung (levers.yaml#index_neutral).
_POOL_PACK = "packs/forecast/cost_behaviour.yaml#"
_POOL_PASSED = (_ABSENT, ("sector", "absent"))
POOL_LADDERS = {
    "pool_fixed_share.": ("convention",),
    "pool_level.": ("convention",),
}
POOL_STEPS = {
    # cost_of_sales: fixed by convention, no ladder climbed (5.2)
    (_POOL_PACK + "cogs_variable"): (),
    # the classification rung, after book and sector were passed over
    (_POOL_PACK + "classification"): _POOL_PASSED,
    (_POOL_PACK + "unallocated_follows_allocated"): _POOL_PASSED,
    # rung 0 and the cap: the classification rung is REJECTED by name
    (_POOL_PACK + "nil_pool"): _POOL_PASSED + (("convention", "rejected"),),
    (_POOL_PACK + "negative_pool"): _POOL_PASSED + (("convention", "rejected"),),
    (_POOL_PACK + "variable_base_max_share_of_revenue"):
        _POOL_PASSED + (("convention", "rejected"),),
    # a split that refused by name: one pool operating_costs
    (_POOL_PACK + "max_unallocated_share"): _POOL_PASSED + (("convention", "rejected"),),
    (_POOL_PACK + "no_line_items"): _POOL_PASSED + (("convention", "rejected"),),
    (_POOL_PACK + "rows_disagree"): _POOL_PASSED + (("convention", "rejected"),),
    "packs/forecast/levers.yaml#index_neutral": (),
}


def _pool_template(key):
    for prefix in POOL_LADDERS:
        if key.startswith(prefix):
            return prefix
    return None


def ladder_of(key):
    """The 3.4 ladder of a driver: KEYS by name, pool drivers by template."""
    template = _pool_template(key)
    if template is not None:
        return POOL_LADDERS[template]
    return LADDERS.get(key, ())


def step_violations(item):
    """The rungs this driver passed over, against the STEPS table."""
    if _pool_template(item.key) is not None:
        expected = POOL_STEPS.get(item.rule_id)
        got = tuple((step["tier"], step["outcome"])
                    for step in item.fallback_steps)
        if expected is None:
            return ["ends on %s (rule %s), a pool rung the POOL_STEPS table "
                    "does not name" % (item.tier, item.rule_id)]
        if got != expected:
            return ["fallback_steps %s, the pool ladder passed over %s"
                    % (list(got), list(expected))]
        return []
    rule = item.rule_id if item.key == "capex_pct_of_revenue" else None
    expected = STEPS.get((item.key, item.tier, rule))
    got = tuple((step["tier"], step["outcome"])
                for step in item.fallback_steps)
    if expected is None:
        return ["ends on %s (rule %s), a rung the STEPS table does not name"
                % (item.tier, rule)]
    if got != expected:
        return ["fallback_steps %s, the ladder passed over %s"
                % (list(got), list(expected))]
    return []


_WORK = {"drivers": 0, "absent_projections": 0, "responses": 0,
         "step_shapes": 0, "ratio_quotes": 0}
_JURISDICTIONS = {}


@pytest.fixture(autouse=True)
def _no_access_log(monkeypatch):
    monkeypatch.setenv("ENGINE_ACCESS_LOG", "0")


def load(name):
    return json.loads((FIRM / ("saga_10_col_%s.json" % name)).read_text())


def pedigree_violations(item):
    """Every way one driver breaks the 3.3 BASIS invariants or its ladder."""
    bad = []
    if item.tier not in TIERS:
        bad.append("tier %r is not one of the six" % (item.tier,))
    if item.tier not in ladder_of(item.key):
        bad.append("tier %s is not on the 3.4 ladder %s"
                   % (item.tier, ladder_of(item.key)))
    ev = item.evidence
    if item.tier == "book":
        if not (isinstance(ev, dict) and ev.get("method") in
                ("cagr", "level", "two_point_fit", "band_traverse")
                and ev.get("periods_used") and ev.get("inputs")):
            bad.append("book evidence malformed: %r" % (ev,))
        else:
            for row in ev["inputs"]:
                values = [k for k in ("value_minor", "value_micros",
                                      "value_micro_days") if k in row]
                if not row.get("fact") or len(values) != 1 \
                        or not isinstance(row[values[0]], int):
                    bad.append("book input malformed: %r" % (row,))
    elif item.tier == "macro":
        if not isinstance(ev, dict):
            bad.append("macro tier without evidence")
        else:
            if not ev.get("series_id") or not ev.get("source") \
                    or not ev.get("stated_as_of"):
                bad.append("macro evidence lacks series_id/source/"
                           "stated_as_of: %r" % (ev,))
            if ev.get("kind") not in ("pack_anchor", "statutory"):
                bad.append("macro kind %r" % (ev.get("kind"),))
            if ev.get("fetched_at") is not None:
                bad.append("a pack anchor carries fetched_at")
            if "source_url" not in ev or "series_content_digest" not in ev:
                bad.append("macro evidence lacks source_url or digest keys")
    elif item.tier == "convention":
        if not (isinstance(ev, dict) and ev.get("rule_id")
                and "pack_address" in ev
                and isinstance(ev.get("evidence"), list)):
            bad.append("convention evidence malformed: %r" % (ev,))
        elif item.rule_id != ev["rule_id"]:
            bad.append("rule_id %r disagrees with evidence %r"
                       % (item.rule_id, ev["rule_id"]))
    elif item.tier == "absent":
        if item.exact is not None or ev is not None:
            bad.append("absent carries a value or evidence")
        if not item.fallback_steps:
            bad.append("absent with no fallback step")
    if item.tier in ("book", "macro", "convention") and item.exact is None:
        bad.append("tier %s carries no value" % item.tier)
    for step in item.fallback_steps:
        if step.get("tier") not in TIERS or step.get("outcome") not in OUTCOMES \
                or not str(step.get("reason") or "").strip():
            bad.append("fallback step malformed: %r" % (step,))
    if item.tier == "user":
        bad.append("a default resolved to tier user")
    return bad


@pytest.mark.parametrize("name", BOOKS)
def test_every_corpus_book_records_its_jurisdiction(name):
    value, source = jurisdiction_of(load(name)["envelope"])
    _JURISDICTIONS[name] = (source, value)
    assert value is not None and source is not None, (
        "%s: the anchor envelope records no jurisdiction (pack_provenance "
        "or ai_audit), so no macro or statutory rung can apply" % (name,))


@pytest.mark.parametrize("horizon", HORIZONS)
@pytest.mark.parametrize("name", BOOKS)
def test_every_driver_carries_a_tier_from_its_ladder_with_its_evidence(
        name, horizon):
    projection = project_payload(load(name), horizon_years=horizon)
    _WORK["responses"] += 1
    reds = []
    absent = []
    for item in projection.assumptions.items():
        _WORK["drivers"] += 1
        for why in pedigree_violations(item) + step_violations(item):
            reds.append("%s h%d %s: %s" % (name, horizon, item.key, why))
        if item.tier == "absent":
            absent.append(item.key)
            if item.key not in ABSENT_LEGAL:
                reds.append("%s h%d %s ends absent and is not absent-legal "
                            "(3.3)" % (name, horizon, item.key))
    if absent:
        # the response carries an absent driver and PROJECTED (it is here)
        assert len(projection.periods) > 0
        _WORK["absent_projections"] += 1
    assert set(LADDERS) == set(KEYS), (
        "the ladder table and KEYS disagree: %s"
        % sorted(set(LADDERS) ^ set(KEYS)))
    assert not reds, "\n".join(reds)


@pytest.mark.parametrize("name", BOOKS)
def test_no_revenue_growth_reaches_a_plan_as_a_silent_zero(name):
    payload = load(name)
    for variant in ("recorded", "not recorded"):
        if variant == "not recorded":
            payload = copy.deepcopy(payload)
            payload["envelope"].pop("pack_provenance", None)
            payload["envelope"].pop("ai_audit", None)
        from engine.forecast.project import assumptions_for_payload
        growth = assumptions_for_payload(payload)["revenue_growth"]
        steps = [s["tier"] for s in growth.fallback_steps]
        assert steps[:2] == ["book", "sector"], (name, variant, steps)
        if growth.exact == 0:
            assert growth.tier == "convention", (name, variant, growth.tier)
            assert "macro" in steps, (name, variant, steps)
        if variant == "recorded":
            assert growth.tier == "macro" and growth.exact != 0, (
                name, growth.tier, growth.exact)
        else:
            assert growth.tier == "convention", (name, growth.tier)


#: Built shapes the corpus books never end on (TC-3: each is asserted to
#: reach the rung it names): no depreciation charge (capex terminal rung),
#: and no interest income, financial income or financial expense line (the
#: held money drivers' convention rungs).
SHAPES = {
    "agras without a depreciation charge": (
        {"depreciation": None}, "capex_pct_of_revenue", "convention",
        "packs/forecast/levers.yaml#capex_pct_of_revenue.terminal_rung"),
    "agras without interest income": (
        {"interest_income": None}, "interest_income_annual", "convention",
        None),
    "agras without financial income": (
        {"financial_income": None}, "other_financial_income_annual",
        "convention", None),
    "agras without financial expense": (
        {"financial_expense_total": None}, "other_financial_expense_annual",
        "convention", None),
}


@pytest.mark.parametrize("shape", sorted(SHAPES))
def test_every_rung_passed_over_is_recorded_on_the_built_shapes(shape):
    from engine.forecast.project import assumptions_for_payload

    fields, key, tier, rule = SHAPES[shape]
    payload = copy.deepcopy(load("agras"))
    payload["statements"]["assembled_pl"].update(fields)
    assumptions = assumptions_for_payload(payload)
    item = assumptions[key]
    assert item.tier == tier and (rule is None or item.rule_id == rule), (
        "%s: the shape no longer reaches %s %s (got %s %s), so it proves "
        "nothing" % (shape, key, tier, item.tier, item.rule_id))
    reds = []
    for driver in assumptions.items():
        for why in pedigree_violations(driver) + step_violations(driver):
            reds.append("%s %s: %s" % (shape, driver.key, why))
    _WORK["step_shapes"] += 1
    assert not reds, "\n".join(reds)


def test_the_jurisdiction_is_read_from_pack_provenance_then_ai_audit():
    """Contract 0.3, both orders: an AI-lane envelope carries its
    jurisdiction only in ai_audit, and pack_provenance wins when both
    record one."""
    from engine.forecast.project import assumptions_for_payload

    lane = copy.deepcopy(load("agras"))
    lane["envelope"].pop("pack_provenance", None)
    lane["envelope"]["ai_audit"] = {"jurisdiction": "RO"}
    assert jurisdiction_of(lane["envelope"]) == ("RO", "ai_audit")
    drivers = assumptions_for_payload(lane)
    assert drivers["revenue_growth"].tier == "macro"
    assert drivers["tax_rate"].tier == "macro"
    assert drivers["tax_rate"].evidence["kind"] == "statutory"

    both = copy.deepcopy(load("agras"))
    both["envelope"]["ai_audit"] = {"jurisdiction": "HU"}
    assert both["envelope"]["pack_provenance"]["jurisdiction"] == "RO"
    assert jurisdiction_of(both["envelope"]) == ("RO", "pack_provenance")
    assert assumptions_for_payload(both)["tax_rate"].tier == "macro"
    reversed_ = copy.deepcopy(both)
    reversed_["envelope"]["pack_provenance"]["jurisdiction"] = "HU"
    reversed_["envelope"]["ai_audit"] = {"jurisdiction": "RO"}
    assert jurisdiction_of(reversed_["envelope"]) == ("HU", "pack_provenance")
    with pytest.raises(NoStatutoryTaxRate):
        project_payload(reversed_, horizon_years=3)


def test_the_statutory_rung_holds_the_pack_records_value(monkeypatch,
                                                         tmp_path):
    """TC-10: the statutory integer follows the pack record. The record's
    value is changed in a tmp copy of ro_macro.yaml; a code literal equal
    to today's pack value would keep the old integer and red."""
    import yaml

    from engine.forecast import assumptions as A
    from engine.forecast import levers_pack
    from engine.forecast.money import micros_from
    from engine.forecast.project import assumptions_for_payload

    real = levers_pack.macro_pack()
    raw = yaml.safe_load(open(real.path, encoding="utf-8"))
    today = raw["statutory"]["profit_tax_rate"]["value"]
    moved = round(today + 0.03, 4)
    raw["statutory"]["profit_tax_rate"]["value"] = moved
    target = tmp_path / "ro_macro.yaml"
    target.write_text(yaml.safe_dump(raw, sort_keys=False), encoding="utf-8")
    monkeypatch.setattr(A, "macro_pack",
                        lambda: levers_pack.macro_pack(str(target)))
    rung = assumptions_for_payload(load("agras"))["tax_rate"]
    assert rung.tier == "macro"
    assert rung.exact == micros_from(str(moved)) != micros_from(str(today)), (
        "the statutory rung holds %r with the pack record at %s (was %s)"
        % (rung.exact, moved, today))


def _served_metrics():
    return json.loads((FIRM / "served_metrics.json").read_text("utf-8"))


def _decimal_places(value):
    text = repr(float(value))
    return len(text.split(".")[1]) if "." in text else 0


@pytest.mark.parametrize("name", BOOKS)
def test_the_days_basis_quotes_the_served_ratio_tables_own_value(name):
    """Contract 4 / R8: the dio and dpo basis quotes the ratio table's own
    value — engine.ratios.table, over total operating expense — never the
    methodology pack's ratio, which divides by cost of sales. Checked
    against the served metrics at their own rounding (the finest decimal
    places the served dio/dpo values carry across the corpus)."""
    from engine.forecast.money import MICRO_DAY
    from engine.forecast.project import assumptions_for_payload

    served = _served_metrics()
    places = max(_decimal_places(served[b][k]) for b in BOOKS
                 for k in ("dio", "dpo") if served[b].get(k) is not None)
    tolerance = 0.5 * 10 ** -places + 0.5 / MICRO_DAY
    drivers = assumptions_for_payload(load(name))
    reds = []
    for key, table_key in (("dio_cogs_days", "dio"),
                           ("dpo_cogs_days", "dpo")):
        item = drivers[key]
        if "methodology.ratios" in item.basis:
            reds.append("%s %s quotes methodology.ratios" % (name, key))
        if item.tier != "book":
            continue
        quotes = [row for row in item.evidence["inputs"]
                  if row["fact"] == "ratio_table.%s" % table_key]
        if len(quotes) != 1:
            reds.append("%s %s quotes the ratio table %d times"
                        % (name, key, len(quotes)))
            continue
        quoted = quotes[0]["value_micro_days"] / MICRO_DAY
        want = served[name][table_key]
        _WORK["ratio_quotes"] += 1
        if abs(quoted - want) > tolerance:
            reds.append("%s %s quotes ratio_table.%s = %.6f, the served ratio "
                        "table reads %s (tolerance %.7f, %d places)"
                        % (name, key, table_key, quoted, want, tolerance,
                           places))
    assert not reds, "\n".join(reds)


def test_the_served_tier_never_follows_the_sentence(monkeypatch):
    """Plant, held in the file (contract 3.4): reword the capex sentence
    and the resolved tier and rule id must not move."""
    from engine.forecast import assumptions as A
    from engine.forecast.levers_pack import Rung, capex_rules

    before = project_payload(load("agras"), horizon_years=3).assumptions[
        "capex_pct_of_revenue"]
    maintenance, no_charge, nil_revenue = capex_rules()
    # Every tier word and every rule word is gone from the rewording, so a
    # tier inferred from any word of the sentence moves.
    reworded = Rung(maintenance.rule_id, maintenance.value,
                    "capital spend tracks {amount} in this plan")
    for word in ("convention", "book", "macro", "measure", "derived",
                 "absent", "user", "sector", "rule"):
        assert word not in reworded.sentence
    monkeypatch.setattr(A, "capex_rules",
                        lambda: (reworded, no_charge, nil_revenue))
    after = project_payload(load("agras"), horizon_years=3).assumptions[
        "capex_pct_of_revenue"]
    assert after.basis != before.basis
    assert (after.tier, after.rule_id, after.exact) == (
        before.tier, before.rule_id, before.exact)


def _with_jurisdiction(name, jurisdiction):
    payload = copy.deepcopy(load(name))
    envelope = payload["envelope"]
    envelope.pop("ai_audit", None)
    if jurisdiction is None:
        envelope.pop("pack_provenance", None)
    else:
        envelope["pack_provenance"] = dict(envelope.get("pack_provenance")
                                           or {}, jurisdiction=jurisdiction)
    return payload


def _with_a_gap_to_121(payload):
    """The unmeasured precondition BUILT, not borrowed from the corpus: the
    filed account-121 balance is moved one currency unit away from the
    reconstruction plus capitalised own work, so the engine's effective-rate
    rule cannot measure a rate whatever a future statements repair does to
    the committed book."""
    pl = payload["statements"]["assembled_pl"]
    block = payload["envelope"]["canonical_bs"]["invariants"][
        "p121_cross_check"]
    block["p121"] = round(pl["pretax"] - pl["income_tax"]
                          + (pl.get("capitalized_own_work_memo") or 0.0)
                          + 1.0, 2)
    return payload


@pytest.mark.parametrize("name", BOOKS)
def test_an_unmeasured_rate_with_no_statutory_record_refuses_the_plan(name):
    """R16 through the engine, on a copy of each corpus book whose account
    121 is forced one unit away from its reconstruction (so the effective
    rate is not measured by construction): a jurisdiction with no packed
    statutory record — or none recorded — refuses by name."""
    from engine.forecast.project import assumptions_for_payload

    rung = assumptions_for_payload(
        _with_a_gap_to_121(copy.deepcopy(load(name))))["tax_rate"]
    assert rung.tier == "macro", (name, rung.tier)
    assert rung.evidence["kind"] == "statutory"
    for jurisdiction, expected in (("HU", "jurisdiction HU"),
                                   (None, "the jurisdiction of this book is "
                                          "not recorded")):
        with pytest.raises(NoStatutoryTaxRate) as caught:
            project_payload(_with_a_gap_to_121(
                _with_jurisdiction(name, jurisdiction)), horizon_years=3)
        assert caught.value.code == "no_statutory_tax_rate"
        assert expected in str(caught.value), str(caught.value)
        # a caller who states the rate is projected at it
        stated = project_payload(_with_a_gap_to_121(
            _with_jurisdiction(name, jurisdiction)),
                                 horizon_years=3, tax_rate="0.16",
                                 revolver_rate="0.09")
        assert stated.assumptions["tax_rate"].tier == "user"


def test_deleting_the_statutory_record_refuses_a_romanian_book(monkeypatch):
    """Plant, held in the file (contract 26.2 F3): with the statutory record
    gone, an RO book whose rate is not measured refuses rather than falling
    to an assumed rate."""
    from engine.forecast import assumptions as A

    real = A.macro_pack()

    class _NoStatutory(object):
        jurisdiction = real.jurisdiction
        anchors = real.anchors
        statutory = {}

        def anchor(self, key, jurisdiction):
            return real.anchor(key, jurisdiction)

        def statutory_rate(self, key, jurisdiction):
            return None

    monkeypatch.setattr(A, "macro_pack", lambda: _NoStatutory())
    with pytest.raises(NoStatutoryTaxRate) as caught:
        project_payload(_with_a_gap_to_121(copy.deepcopy(load("agras"))),
                        horizon_years=3)
    assert "no statutory profit-tax rate is packed for jurisdiction RO" \
        in str(caught.value)


def test_the_route_answers_the_refusal_as_422(monkeypatch):
    """R16 through GET /api/forecast on the real app: the engine refusal
    carries its code and the route answers 422 with the engine sentence."""
    os.environ.setdefault("VITE_SUPABASE_URL", "https://test.supabase.co")
    os.environ.setdefault("VITE_SUPABASE_ANON_KEY", "test-anon")
    os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test-service")
    os.environ["CFO_AI_SKIP_BOOT_VERIFY"] = "1"
    assert "test." in os.environ["VITE_SUPABASE_URL"]
    from fastapi.testclient import TestClient

    from engine.api import _forecast_routes as FR
    from engine.api import _org
    from engine.api.server import create_app

    hungarian = _with_jurisdiction("agras", "HU")

    def _load(jwt, org_id, period_id):
        return {"envelope": hungarian["envelope"],
                "statements": hungarian["statements"],
                "period_end": hungarian["period_end"],
                "period_label": "FY2025", "currency": "RON",
                "company_name": None}

    # plan/2 B5 (28.3 B5 "Retires", the same move as test_forecast_route.py):
    # the route's loader is _forecast_history.load_plan_inputs, which hands
    # back (anchor payload, prior periods, PlanContext, history block). The
    # context is left None so the jurisdiction is read from the envelope
    # under test, as project_plan documents.
    from engine.api import _forecast_history as FH
    assert not hasattr(FR, "_load_period")

    def _inputs(payload):
        return lambda jwt, org_id, period_id: (payload, [], None, {})

    monkeypatch.setattr(_org, "resolve_org", lambda jwt, org: ("u", "o"))
    monkeypatch.setattr(FH, "load_plan_inputs", _inputs(_load(None, None, None)))
    client = TestClient(create_app(), raise_server_exceptions=False)
    res = client.get("/api/forecast/p-hu?horizon=3",
                     headers={"Authorization": "Bearer t"})
    assert res.status_code == 422, (res.status_code, res.text[:300])
    assert "jurisdiction HU" in res.json()["detail"]
    monkeypatch.setattr(FH, "load_plan_inputs", _inputs(dict(
        _load(None, None, None), envelope=load("agras")["envelope"],
        statements=load("agras")["statements"])))
    assert client.get("/api/forecast/p-ro?horizon=3",
                      headers={"Authorization": "Bearer t"}).status_code == 200


def test_zz_scope_and_work(capsys):
    with capsys.disabled():
        print("\nSCOPE forecast-defaults (engine half, plan/2 B3): books %s; "
              "horizons %s; through project_payload (project()); no "
              "SYNTHETIC pair (history is B7); SYNTHETIC built copies of "
              "agras (no depreciation charge; no interest income; no "
              "financial income; no financial expense; jurisdiction only in "
              "ai_audit; ai_audit beside pack_provenance) and of each book "
              "(account 121 forced one unit off its reconstruction); "
              "Scandia not run in the battery (local harness only)" % (", ".join(BOOKS),
                                                 ", ".join(map(str, HORIZONS))))
        print("jurisdiction source per corpus book: %s" % "; ".join(
            "%s %s=%s" % (n, s, v)
            for n, (s, v) in sorted(_JURISDICTIONS.items())))
        print("responses %d; drivers checked %d; responses with an absent "
              "driver that projected %d; built step shapes %d; ratio-table "
              "quotes checked %d"
              % (_WORK["responses"], _WORK["drivers"],
                 _WORK["absent_projections"], _WORK["step_shapes"],
                 _WORK["ratio_quotes"]))
        local = os.environ.get("PLAN_LOCAL_XLSX")
        if local:
            # Opt-in, local only (contract 10): the Scandia book is never
            # committed; its jurisdiction source is printed, nothing else.
            import importlib.util
            spec = importlib.util.spec_from_file_location(
                "measure_plan_blast_radius",
                str(REPO / "scripts" / "measure_plan_blast_radius.py"))
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            book = module._local_book(Path(local))
            value, source = jurisdiction_of(book.get("envelope"))
            print("jurisdiction source, local book %s: %s=%s"
                  % (Path(local).name, source, value))
        else:
            print("jurisdiction source, local Scandia: not run (set "
                  "PLAN_LOCAL_XLSX to a local trial balance to print it)")
        print("GATE-WORK forecast-defaults units=%d" % _WORK["drivers"])
    assert len(_JURISDICTIONS) == len(BOOKS)
    assert _WORK["drivers"] > 0, "no driver was checked (TC-3)"
    assert _WORK["step_shapes"] == len(SHAPES), _WORK["step_shapes"]
    assert _WORK["ratio_quotes"] > 0, "no ratio-table quote was checked (TC-3)"
    assert _WORK["absent_projections"] > 0, (
        "no projection carried an absent driver, so 'an absent driver "
        "still projects' was never exercised (TC-3)")
