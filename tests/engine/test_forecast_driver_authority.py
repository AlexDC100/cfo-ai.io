"""forecast-authority — one concept, one value (plan_contract_v2 section 4; B3).

For every concept ``engine.forecast`` and ``engine.forecast_drivers`` share,
on the four committed books, the two packages hold the SAME integer: the
exact micros or micro-days, never a display rounding, and the same tier.
The shared set is read from the authority registry
(``engine.forecast_drivers.authority.CONCEPTS``, status ``supplied``) plus
the macro anchor both cite, so a concept added to the registry is covered
the day it is added.

WHAT THIS GATE REDS ON AFTER THE REPAIR (TC-11)
-----------------------------------------------
* any shared concept on any corpus book where the drivers package's exact
  integer (translated to the model's key) differs from the model's by one
  unit, naming the concept, model key and book (the plant: move derive.py's
  dio by one micro-day);
* a shared concept whose drivers value carries no exact integer while the
  model measured it — a display rounding crossing where the integer should;
* the drivers package holding a value where the model's book rung refused
  (or the reverse): two answers about one book;
* a tier that differs between the two packages for one concept;
* the macro anchor cited under two series ids or two values;
* the renamed gross-base depreciation share crossing to the model, or any
  blocked concept remaining (contract 4: blocked_model_keys is emptied);
* zero concepts compared (TC-3).

* a shared concept whose model value MOVES when the drivers package's
  hand-over is applied (``model_overrides``): the drivers path and the GET
  path projecting different values for one book (the B3 repair's
  tax_rate: an absent hand-over that took the statutory rung where GET
  measured 0%);
* on the SYNTHETIC tying books (retail with its account-121 gap removed,
  with and without a nil class-69 account), any of the above — the shape
  on which a second tax rule disagrees with the engine's (the plant:
  restore forecast_drivers' class-69 attribution rule; it reds naming
  effective_tax_rate and the book).

IT CANNOT SEE: whether the engine's derivation is itself right (the model's
own gates own that); multi-period CAGR agreement (B7 loads history); any
constructed shape other than the two SYNTHETIC tying books.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

from engine.forecast.project import assumptions_for_payload
from engine.forecast_drivers import build_case_set, load_pack
from engine.forecast_drivers.authority import (CONCEPTS, blocked_model_keys,
                                               model_overrides)

REPO = Path(__file__).resolve().parents[2]
FIRM = REPO / "tests" / "engine" / "fixtures" / "firm"
BOOKS = ("agras", "carniprod", "realestate", "retail")

_WORK = {"comparisons": 0, "concepts": set(), "books": set(),
         "synthetic": set()}


@pytest.fixture(autouse=True)
def _no_access_log(monkeypatch):
    monkeypatch.setenv("ENGINE_ACCESS_LOG", "0")


def load(name):
    return json.loads((FIRM / ("saga_10_col_%s.json" % name)).read_text())


def compare_book(name, payload, base=None):
    """(comparisons, reds) for one book: every shared concept's integers."""
    base = base or build_case_set([payload]).case("base")
    model = assumptions_for_payload(payload)
    reds = []
    comparisons = 0
    for concept in CONCEPTS:
        # plan/2 B4b: `read` concepts (the pool facts forecast_drivers reads
        # off the engine, contract 4) are compared like supplied ones —
        # one integer, one tier, on both paths; they hand nothing over.
        if concept.status not in ("supplied", "read"):
            continue
        driver = base.driver(concept.driver_key)
        assert driver is not None, concept.driver_key
        for model_key in concept.model_keys:
            ours = model[model_key]
            comparisons += 1
            tag = "%s %s (%s)" % (name, concept.concept_id, model_key)
            if driver.value is None:
                if ours.tier == "book":
                    reds.append("%s: drivers ABSENT, model measured %r"
                                % (tag, ours.exact))
                continue
            if ours.tier != "book" and driver.status == "derived" \
                    and getattr(driver, "tier", None) in (None, "book"):
                reds.append("%s: drivers derived %r, model's book rung "
                            "refused (tier %s)" % (tag, driver.value, ours.tier))
                continue
            if driver.exact is None:
                if ours.exact is not None and ours.tier == "book":
                    reds.append("%s: drivers carries no exact integer for a "
                                "value the model measured" % (tag,))
                continue
            theirs = concept.convert_exact(driver.exact, driver.unit)
            if theirs != ours.exact:
                reds.append("%s: drivers %r, model %r (delta %+d)"
                            % (tag, theirs, ours.exact,
                               (theirs or 0) - (ours.exact or 0)))
            if driver.tier != ours.tier:
                reds.append("%s: tier drivers %s, model %s"
                            % (tag, driver.tier, ours.tier))
    # the hand-over must not move what the model holds: the drivers path
    # (model_overrides applied) and the GET path (the model alone) hold one
    # tier and one integer for every shared concept (contract 4)
    after = assumptions_for_payload(payload, **model_overrides(base))
    for concept in CONCEPTS:
        # plan/2 B4b: `read` concepts (the pool facts forecast_drivers reads
        # off the engine, contract 4) are compared like supplied ones —
        # one integer, one tier, on both paths; they hand nothing over.
        if concept.status not in ("supplied", "read"):
            continue
        for model_key in concept.model_keys:
            comparisons += 1
            ours, crossed = model[model_key], after[model_key]
            if (crossed.tier, crossed.exact) != (ours.tier, ours.exact):
                reds.append("%s %s (%s): the hand-over moves the model from "
                            "%s %r to %s %r"
                            % (name, concept.concept_id, model_key, ours.tier,
                               ours.exact, crossed.tier, crossed.exact))
    # the macro anchor both packages cite (contract 4)
    comparisons += 1
    growth = model["revenue_growth"]
    anchor = load_pack().anchor("inflation")
    if growth.tier == "macro":
        if growth.evidence["series_id"] != anchor.series_id:
            reds.append("%s macro_anchor: series_id model %r, drivers %r"
                        % (name, growth.evidence["series_id"],
                           anchor.series_id))
        if growth.exact != int(anchor.series.value * 1000000):
            reds.append("%s macro_anchor: value model %r, drivers %r"
                        % (name, growth.exact, anchor.value))
    return comparisons, reds


@pytest.mark.parametrize("name", BOOKS)
def test_every_shared_concept_holds_one_integer_on_the_book(name):
    comparisons, reds = compare_book(name, load(name))
    _WORK["comparisons"] += comparisons
    _WORK["books"].add(name)
    for concept in CONCEPTS:
        if concept.status in ("supplied", "read"):
            _WORK["concepts"].add(concept.concept_id)
    _WORK["concepts"].add("macro_anchor")
    assert comparisons > 0
    assert not reds, "\n".join(reds)


def tying_retail(with_charge_account):
    """SYNTHETIC: the retail book with its account-121 gap removed (the
    filed balance moved to the reconstruction, so the book ties with a nil
    charge), optionally with a nil class-69 account in its chart. The shape
    test_forecast_drivers.py _retail_that_ties builds, restated here so this
    gate does not import another test module."""
    payload = copy.deepcopy(load("retail"))
    pl = payload["statements"]["assembled_pl"]
    reconstructed = round(pl["pretax"] - pl["income_tax"], 2)
    pl["net_income_statutory"] = reconstructed
    pl["net_income_unexplained_vs_121"] = 0.0
    pl["net_income_reconciliation_to_121"] = 0.0
    block = payload["envelope"]["canonical_bs"]["invariants"][
        "p121_cross_check"]
    block["p121"] = reconstructed
    block["cls7_minus_cls6"] = round(
        reconstructed + (pl.get("capitalized_own_work_memo") or 0.0)
        + (pl.get("inventory_variation_memo") or 0.0), 2)
    block["ok"] = True
    if with_charge_account:
        payload["line_items"].append({
            "ro_account_code": "691",
            "label": "Cheltuieli cu impozitul pe profit",
            "amount": 0.0, "is_derived": False})
    return payload


SYNTHETIC = {"SYNTHETIC retail-ties-no-class-69": False,
             "SYNTHETIC retail-ties-nil-class-69": True}


@pytest.mark.parametrize("label", sorted(SYNTHETIC))
def test_a_tying_book_holds_one_tax_rate_on_both_paths(label):
    """SYNTHETIC (TC-13): no corpus book ties to account 121, so the tax
    rule's disagreement shape is built. Both packages, and the model after
    the hand-over, hold the engine's measured nil rate."""
    payload = tying_retail(SYNTHETIC[label])
    comparisons, reds = compare_book(label, payload)
    _WORK["comparisons"] += comparisons
    _WORK["synthetic"].add(label)
    model = assumptions_for_payload(payload)["tax_rate"]
    assert (model.tier, model.exact) == ("book", 0), (label, model.tier,
                                                      model.exact)
    assert not reds, "\n".join(reds)


def test_the_plant_one_micro_day_on_dio_reds_naming_concept_and_book(
        monkeypatch):
    """Contract section 4's plant, held in the file: move derive.py's dio by
    one micro-day and the comparison reds naming the concept and book."""
    from engine.forecast_drivers import derive

    real = derive._from_engine

    def planted(spec, pack, period, engine, model_key, method_label,
                complement=False):
        driver = real(spec, pack, period, engine, model_key, method_label,
                      complement=complement)
        if model_key == "dio_cogs_days" and driver.exact is not None:
            driver.exact += 1
        return driver

    monkeypatch.setattr(derive, "_from_engine", planted)
    _comparisons, reds = compare_book("agras", load("agras"))
    assert any("agras days_inventory_outstanding (dio_cogs_days)" in r
               and "delta +1" in r for r in reds), reds


def test_no_blocked_concept_remains_and_the_gross_share_never_crosses():
    assert blocked_model_keys() == ()
    keys = set(c.driver_key for c in CONCEPTS if c.driver_key)
    assert "depreciation_share_of_gross_depreciable_base" not in keys
    base = build_case_set([load("agras")]).case("base")
    crossed = model_overrides(base)
    share = base.driver("depreciation_share_of_gross_depreciable_base")
    rate = base.driver("depreciation_rate")
    assert share is not None and rate is not None
    assert crossed["depreciation_rate"].pedigree["exact"] == rate.exact
    assert share.value != rate.value, (
        "the gross-base share and the NBV run-off rate coincide on agras; "
        "the rename would be unobservable")


def test_the_crossing_is_exact_and_never_demotes_a_tier():
    """What crosses carries the unrounded integer and the engine's tier; the
    model then holds that integer and tier (contract 4)."""
    payload = load("agras")
    base = build_case_set([payload]).case("base")
    crossed = model_overrides(base)
    after = assumptions_for_payload(payload, **crossed)
    before = assumptions_for_payload(payload)
    checked = 0
    for key, value in sorted(crossed.items()):
        pedigree = value.pedigree
        if pedigree["exact"] is None:
            continue
        assert after[key].exact == before[key].exact == pedigree["exact"], key
        assert after[key].tier == before[key].tier == pedigree["tier"], key
        checked += 1
    assert checked >= 9, checked


def test_zz_scope_and_work(capsys):
    with capsys.disabled():
        print("\nSCOPE forecast-authority (plan/2 B3, contract 4): books %s; "
              "one period each (history is B7); SYNTHETIC books %s; shared "
              "concepts from authority.CONCEPTS (status supplied or read) plus the "
              "macro anchor; each concept compared alone and after the "
              "hand-over" % (", ".join(BOOKS),
                             ", ".join(sorted(_WORK["synthetic"]))))
        print("covered concepts %d: %s" % (len(_WORK["concepts"]),
                                           ", ".join(sorted(_WORK["concepts"]))))
        print("GATE-WORK forecast-authority units=%d" % _WORK["comparisons"])
    assert _WORK["books"] == set(BOOKS)
    assert _WORK["synthetic"] == set(SYNTHETIC), _WORK["synthetic"]
    assert _WORK["comparisons"] > 0 and _WORK["concepts"], "nothing compared"
