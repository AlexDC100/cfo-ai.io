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
  book is printed).

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
    "cogs_pct_of_revenue": ("book", "absent"),
    "opex_pct_of_revenue": ("book", "absent"),
    "other_operating_income_pct_of_revenue": ("book", "convention", "absent"),
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

_WORK = {"drivers": 0, "absent_projections": 0, "responses": 0}
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
    if item.tier not in LADDERS.get(item.key, ()):
        bad.append("tier %s is not on the 3.4 ladder %s"
                   % (item.tier, LADDERS.get(item.key)))
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
        for why in pedigree_violations(item):
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


@pytest.mark.parametrize("name", BOOKS)
def test_an_unmeasured_rate_with_no_statutory_record_refuses_the_plan(name):
    """R16 through the engine: every corpus book's effective rate is not
    measured (none reproduces its filed profit), so a jurisdiction with no
    packed statutory record — or none recorded — refuses by name."""
    from engine.forecast.project import assumptions_for_payload

    rung = assumptions_for_payload(load(name))["tax_rate"]
    assert rung.tier == "macro", (name, rung.tier)
    assert rung.evidence["kind"] == "statutory"
    for jurisdiction, expected in (("HU", "jurisdiction HU"),
                                   (None, "the jurisdiction of this book is "
                                          "not recorded")):
        with pytest.raises(NoStatutoryTaxRate) as caught:
            project_payload(_with_jurisdiction(name, jurisdiction),
                            horizon_years=3)
        assert caught.value.code == "no_statutory_tax_rate"
        assert expected in str(caught.value), str(caught.value)
        # a caller who states the rate is projected at it
        stated = project_payload(_with_jurisdiction(name, jurisdiction),
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
        project_payload(load("agras"), horizon_years=3)
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

    monkeypatch.setattr(_org, "resolve_org", lambda jwt, org: ("u", "o"))
    monkeypatch.setattr(FR, "_load_period", _load)
    client = TestClient(create_app(), raise_server_exceptions=False)
    res = client.get("/api/forecast/p-hu?horizon=3",
                     headers={"Authorization": "Bearer t"})
    assert res.status_code == 422, (res.status_code, res.text[:300])
    assert "jurisdiction HU" in res.json()["detail"]
    monkeypatch.setattr(FR, "_load_period",
                        lambda jwt, org_id, period_id: dict(
                            _load(jwt, org_id, period_id),
                            envelope=load("agras")["envelope"],
                            statements=load("agras")["statements"]))
    assert client.get("/api/forecast/p-ro?horizon=3",
                      headers={"Authorization": "Bearer t"}).status_code == 200


def test_zz_scope_and_work(capsys):
    with capsys.disabled():
        print("\nSCOPE forecast-defaults (engine half, plan/2 B3): books %s; "
              "horizons %s; through project_payload (project()); no "
              "SYNTHETIC pair (history is B7); Scandia not run in the "
              "battery (local harness only)" % (", ".join(BOOKS),
                                                 ", ".join(map(str, HORIZONS))))
        print("jurisdiction source per corpus book: %s" % "; ".join(
            "%s %s=%s" % (n, s, v)
            for n, (s, v) in sorted(_JURISDICTIONS.items())))
        print("responses %d; drivers checked %d; responses with an absent "
              "driver that projected %d"
              % (_WORK["responses"], _WORK["drivers"],
                 _WORK["absent_projections"]))
        print("GATE-WORK forecast-defaults units=%d" % _WORK["drivers"])
    assert len(_JURISDICTIONS) == len(BOOKS)
    assert _WORK["drivers"] > 0, "no driver was checked (TC-3)"
    assert _WORK["absent_projections"] > 0, (
        "no projection carried an absent driver, so 'an absent driver "
        "still projects' was never exercised (TC-3)")
