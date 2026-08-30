"""F1–F9 — THE GATES THE FINDINGS REBUILD IS ALLOWED TO SHIP THROUGH.

`design_review/findings/BASELINE.md` measured the surface this replaces:
59 rule-authored findings live, 47 of them (80%) with no imperative verb,
34 (58%) citing fewer than two figures, 5 carrying banned boilerplate, and
the worked 461 note scoring 1.5 of the seven contract elements. None of
that was caught by a test, because there was no test that could express
it. This file is that test.

Nine gates. Every one of them has a PLANT — a deliberate defect proven to
trip it, then reverted — because a gate nobody has watched fail is a gate
nobody knows works. Each plant is named in `design_review/findings/
GATES.md` next to the gate it exercises.

    F1 CONTRACT      seven elements, or demoted. All seven, one at a time.
    F2 SPECIFICITY   banned phrasing, two figures, one imperative verb,
                     one ledger code, and the SWAP TEST — the same rule on
                     another company must not be the same sentence.
    F3 APPLICABILITY a profile-gated detector never fires out of profile.
    F4 MATERIALITY   0.3% of the balance sheet is not a recommendation,
                     whatever severity it is labelled with.
    F5 UNIT LAW      every ratio native-unit; the same findings and the
                     same percentages whether the book reports RON or EUR.
    F6 COLD START    one period yields single-period findings plus an
                     explicit needs-more-history note, and nothing else.
    F7 DETERMINISM   the same snapshot, the same bytes — AI reachable or
                     not.
    F8 SILENCE       a clean book says "nothing material" AND what it
                     checked. Never filler.
    F9 NO MODEL      no model in the numeric path, at construction or at
                     runtime, and no model numeral in the prose.

The lint half of F2 lives in `scripts/check_finding_specificity.py` and is
IMPORTED here rather than re-implemented, so the battery gate and this
suite cannot drift into disagreeing about what "specific" means.

Python 3.9 — no `match`, no `X | Y` unions.
"""

from __future__ import annotations

import ast
import copy
import dataclasses
import importlib
import inspect
import json
import sys
import warnings
from pathlib import Path

import pytest
import yaml

from engine.api import _company_profile as CP
from engine.api import _finding as F
from engine.api import _finding_rank as R
from engine.api import _ratio_units
from engine.api.findings import _base
from engine.api.findings import m_detect as D
from engine.api.findings import m_engine as E
from engine.api.findings import m_policy as P
from engine.api.findings import m_series as S
from engine.api.findings import s_engine

REPO = Path(__file__).resolve().parents[2]
PACKAGE = REPO / "src" / "engine" / "api" / "findings"
FIXTURES = (REPO / "src" / "engine" / "country_packs" / "ro_romania"
            / "fixtures" / "regression_baselines")

# The F2 lint is one implementation, shared with the battery gate.
_SCRIPTS = REPO / "scripts"
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))
import check_finding_specificity as LINT  # noqa: E402

#: Every committed regression fixture. `scandia_frozen_fy2025` is
#: included because it is one of the three production workspaces the
#: BEFORE/AFTER table is drawn from; a gate that skipped it would not
#: cover a case the delivery document claims.
FIXTURE_NAMES = LINT.FIXTURE_NAMES

#: A book with nothing wrong with it — coherent totals, comfortable
#: cover, an allowance that is a rounding item, no related-party lending
#: worth naming. Written here rather than committed as a fixture because
#: its whole purpose is to carry no finding: it is the ABSENCE of a
#: signal, and a JSON file full of unremarkable numbers is harder to read
#: as an assertion than the dict that produced it.
CLEAN_STATEMENTS = {
    "currency": "RON",
    "assembled_bs": {
        "total_assets": 50000000.0, "total_equity": 30000000.0,
        "total_liabilities": 20000000.0, "total_current_assets": 23000000.0,
        "total_current_liabilities": 12000000.0,
        "total_non_current_assets": 27000000.0,
        "total_non_current_liabilities": 8000000.0,
        "cash": 6000000.0, "cash_fx_component": 100000.0,
        "ar_net": 9000000.0, "ar_provisions": 300000.0,
        "ar_intercompany": 1000000.0, "inventory": 8000000.0,
        "ppe_net": 25000000.0, "property_plant_equipment": 25000000.0,
        "accounts_payable": 7000000.0, "ap_dividends": 0.0,
        "total_debt": 4000000.0, "lt_debt": 3000000.0, "st_debt": 1000000.0,
        "share_capital": 5000000.0, "retained_earnings": 24000000.0,
        "revaluation_reserves": 1000000.0, "bs_balance_delta": 0.0,
    },
    "assembled_pl": {
        "revenue": 60000000.0, "cogs": 18000000.0,
        "ebitda_statutory": 9000000.0, "ebitda_operational": 9000000.0,
        "net_income_statutory": 5000000.0, "depreciation": 2000000.0,
        "interest_expense": 200000.0, "interest_income": 80000.0,
        "financial_income": 200000.0, "fx_gain": 20000.0, "fx_loss": 10000.0,
        "capitalized_own_work_memo": 0.0, "opex_third_party": 6000000.0,
    },
    "assembled_cf": {
        "cash_from_operating": 7000000.0, "capex_real": -2000000.0,
        "capitalized_construction": 0.0, "free_cash_flow": 5000000.0,
        "is_approximated": False,
    },
    "subAggregates": {},
}


# ── shared helpers ───────────────────────────────────────────────────────


def statements(name):
    return LINT.statements_for(name)


def run(name, **kwargs):
    return s_engine.run_single_period(
        statements(name), period_id="p-" + name,
        snapshot_id="snap-" + name, **kwargs)


@pytest.fixture(scope="module")
def results():
    return dict((name, run(name)) for name in FIXTURE_NAMES)


def surfaced_pairs(results):
    """(fixture, payload) for every surfaced finding, over every book."""
    out = []
    for name in FIXTURE_NAMES:
        for row in results[name].surfaced():
            out.append((name, row))
    return out


def a_finding(results, name="agras_fy2025", rule_id="concentration_related_party"):
    """One real, surfaced Finding OBJECT (not its payload) — the subject
    of most plants. Defaults to the 461 case, which is the note the whole
    contract was designed around."""
    for finding in results[name].finding_set.surfaced:
        if finding.rule_id == rule_id:
            return finding
    raise AssertionError("%s did not surface %s" % (name, rule_id))


def fresh_catalog():
    """A private ProfileCatalog, so a plant that widens a detector's
    scope cannot leak into the module-level cache every other test in
    this session reads."""
    with open(str(CP.DEFAULT_PROFILES_PATH), encoding="utf-8") as fh:
        return CP.ProfileCatalog(yaml.safe_load(fh), origin="test-plant")


# ══ F1 — THE CONTRACT ════════════════════════════════════════════════════
#
# Every surfaced finding carries all seven elements; missing any one
# demotes it. `surfaced` is not settable, so the gate is really about the
# validator being the ONLY definition of complete.


def test_f1_every_surfaced_finding_carries_all_seven_elements(results):
    pairs = surfaced_pairs(results)
    assert pairs, "no fixture surfaced anything — the gate would be vacuous"
    for name, row in pairs:
        where = "%s/%s" % (name, row["rule_key"])
        assert row["missing_elements"] == [], "%s: %s" % (where, row["demotion_reasons"])
        elements = row["contract_elements"]
        for element in F.CONTRACT_ELEMENTS:
            assert elements.get(element) is not None, "%s lacks %s" % (where, element)
        # The elements are not decorative: each one has to carry content.
        assert elements["subject"]["accounts"], where
        assert len(elements["evidence"]["figures"]) >= F.MIN_FIGURES, where
        assert elements["evidence"]["provenance"]["period_id"], where
        assert elements["evidence"]["comparison_basis"]["kind"] in \
            F.COMPARISON_BASIS_KINDS, where
        assert elements["threshold"]["source"].startswith("profiles.yaml#"), where
        assert elements["impact"]["kind"] in F.IMPACT_KINDS, where
        assert elements["why_here"]["signals"], where
        assert elements["action"]["steps"], where
        assert elements["confidence"]["level"] in F.CONFIDENCE_LEVELS, where


def test_f1_plant_stripping_any_one_element_demotes_the_finding(results):
    """PLANT F1. Take a real surfaced finding and remove one element at a
    time. Each removal must demote it AND name the element — a demotion
    whose reason is unreadable is a demotion nobody can fix."""
    finding = a_finding(results)
    assert finding.verdict().surfaced, "the control did not surface"
    for element in F.CONTRACT_ELEMENTS:
        planted = dataclasses.replace(finding, **{element: None})
        verdict = planted.verdict()
        assert not verdict.surfaced, "removing %s still surfaced" % element
        assert element in verdict.missing_elements(), verdict.reasons()
        payload = planted.to_payload()
        assert payload["surfaced"] is False and payload["demoted"] is True
        assert payload["title"] is None and payload["body"] is None
        # ...and it lands on the raw All-checks list with its numbers.
        assert payload["check_summary"]["rule_id"]
    # Reverted: the untouched finding is unchanged.
    assert finding.verdict().surfaced


def test_f1_plant_a_rule_that_did_not_fire_cannot_be_narrated(results):
    """PLANT F1b. The subtler half of the contract: a finding whose
    THRESHOLD does not actually hold is demoted, so a detector cannot pick
    a dramatic band and narrate it anyway."""
    finding = a_finding(results)
    inverted = dataclasses.replace(
        finding,
        threshold=dataclasses.replace(finding.threshold,
                                      limit=finding.threshold.observed * 10.0))
    verdict = inverted.verdict()
    assert not verdict.surfaced
    assert F.ELEMENT_THRESHOLD in verdict.missing_elements()
    assert any("did not actually fire" in r for r in verdict.reasons())


def test_f1_surfaced_is_a_verdict_not_a_field():
    """There is no way to ASK for a surfaced finding. If this ever
    becomes settable, every other gate here is decorative."""
    assert "surfaced" not in F.Finding.__dataclass_fields__
    with pytest.raises((TypeError, AttributeError)):
        F.Finding(rule_id="x", severity="high", category="liquidity",
                  currency="RON", surfaced=True)  # type: ignore[call-arg]


# ══ F2 — SPECIFICITY ═════════════════════════════════════════════════════


def test_f2_the_four_phrases_the_law_names_are_in_the_engines_own_list():
    """The lint and the runtime demotion must share one list. If the
    engine's list is ever trimmed below the law, this fails before the
    lint quietly stops catching anything."""
    low = tuple(p.lower() for p in F.BANNED_PHRASES)
    for phrase in LINT.LAW_BANNED_PHRASES:
        assert any(phrase.startswith(b) or b in phrase for b in low), phrase


def test_f2_no_surfaced_finding_trips_the_prose_lint(results):
    violations = []
    for name, row in surfaced_pairs(results):
        text = "%s\n%s" % (row["title"], row["body"])
        violations.extend(LINT.lint_text("%s/%s" % (name, row["rule_key"]), text))
    assert not violations, "\n".join(v.render() for v in violations)


def test_f2_every_surfaced_finding_scores_the_full_seven(results):
    """The BASELINE.md ruler, applied to the rebuilt surface. The legacy
    461 note scored 1.5; nothing here is allowed below 7."""
    scores = []
    for name in FIXTURE_NAMES:
        anchors = results[name].profile.anchors()
        for row in results[name].surfaced():
            text = "%s\n%s" % (row["title"], row["body"])
            score = LINT.score_text(text, anchors)
            scores.append(score.total())
            assert score.total() == LINT.SPECIFICITY_MAX, (
                "%s/%s scored %.2f — %s"
                % (name, row["rule_key"], score.total(),
                   ", ".join(score.missing())))
    assert len(scores) >= 20, "too few findings measured to call it a distribution"


def test_f2_plant_the_scorer_and_the_swap_test_can_fail():
    """PLANT F2a. Prove the ruler before trusting the measurement: the
    legacy 461 body must still score exactly the 1.5 the baseline audit
    recorded, and two production bodies that differ only in one
    percentage must fail the swap test."""
    assert LINT.self_test() == []
    assert LINT.score_text(LINT.LEGACY_461_BODY).total() == LINT.LEGACY_461_SCORE


def test_f2_plant_a_hedge_written_back_into_the_rationale_demotes(results):
    """PLANT F2b. The banned-phrase gate, exercised through the only seam
    that can reach the prose — an advisory rewrite. A model that writes
    the baseline's own sentence back in does not launder the finding; it
    demotes it."""
    finding = a_finding(results)
    hedged = F.apply_advisory_narrative(
        finding,
        rationale="For a mid-size inventory-heavy operator this balance "
                  "should be monitored.")
    assert not hedged.verdict().surfaced
    assert F.ELEMENT_PROSE in hedged.verdict().missing_elements()
    assert finding.verdict().surfaced, "the control was mutated — replace() leaked"


def test_f2_swap_test_same_rule_on_two_companies_is_two_different_claims(results):
    """The swap test proper. For every rule that fires on more than one
    book: at least half the cited numbers must differ (S1), and with the
    numerals masked the two renderings must STILL differ (S2) — so the
    sentence carries something that identifies the book rather than being
    one template with the numbers swapped."""
    by_rule = {}
    for name, row in surfaced_pairs(results):
        text = "%s\n%s" % (row["title"], row["body"])
        by_rule.setdefault(row["rule_key"], []).append((name, text))
    multi = dict((k, v) for k, v in by_rule.items() if len(v) > 1)
    assert multi, "no rule fired on two books — the swap test would be vacuous"
    failures = []
    for rule_id in sorted(multi):
        members = multi[rule_id]
        for i in range(len(members) - 1):
            (ln, lt), (rn, rt) = members[i], members[i + 1]
            swap = LINT.swap_test(rule_id, ln, lt, rn, rt)
            if not swap.passed():
                failures.append(swap.render())
    assert not failures, "\n".join(failures)


def test_f2_plant_swap_test_rejects_the_production_bodies(results):
    """PLANT F2c. The same swap test, over the LIVE bodies this rebuild
    replaces. `risk_inventory_fx_exposure` shipped one body to every
    company it fired on; `risk_inventory_cash_tight` shipped one that
    differed by a single percentage. Both must fail here, or the gate
    that passes the rebuilt findings is proving nothing."""
    fx = ("Significant FX cash position. Movements in EUR/RON or USD/RON "
          "create P&L volatility. Consider an FX hedging policy or "
          "natural-hedge alignment with foreign-currency liabilities.")
    clone = LINT.swap_test("risk_inventory_fx_exposure", "b967905e", fx,
                           "11b8e759", fx)
    assert not clone.passed()
    assert clone.masked_identical

    tight = ("Cash covers only %s of current liabilities — heavy dependence "
             "on revolvers. A 15-day disruption could push the company past "
             "covenants or payment terms.")
    near = LINT.swap_test("risk_inventory_cash_tight",
                          "b967905e", tight % "4.3%", "11b8e759", tight % "9.0%")
    assert near.divergence >= LINT.SWAP_MIN_FIGURE_DIVERGENCE, (
        "this pair is meant to PASS S1 — it is the case S2 exists for")
    assert not near.passed() and near.masked_identical

    # ...and the rebuilt renderings of the SAME two books pass.
    left = "%s\n%s" % tuple(
        [results["agras_fy2025"].surfaced()[0][k] for k in ("title", "body")])
    right = "%s\n%s" % tuple(
        [results["eei_dec_2025"].surfaced()[0][k] for k in ("title", "body")])
    assert not LINT.swap_test("rebuilt", "agras", left, "eei", right).masked_identical


# ══ F3 — APPLICABILITY ═══════════════════════════════════════════════════


def test_f3_no_surfaced_rule_is_out_of_its_catalogued_profile(results):
    """A profile-gated detector never fires out of profile. Measured
    against profiles.yaml, which is the only place a scope is written
    down."""
    catalog = CP.load_catalog()
    for name in FIXTURE_NAMES:
        profile_id = results[name].profile.profile_id
        applicable = set(results[name].profile.applicable_detector_ids())
        for row in results[name].surfaced():
            rule_id = row["rule_key"]
            spec = catalog.detector(rule_id)
            assert spec.applies_to_all() or profile_id in spec.profiles, (
                "%s surfaced %s, scoped to %r, on a %s book"
                % (name, rule_id, spec.profiles, profile_id))
            assert rule_id in applicable, "%s/%s" % (name, rule_id)


def test_f3_an_inventory_rule_does_not_run_on_a_service_company(results):
    """The concrete case the law names. `input_cost_exposure` is scoped to
    the inventory- and asset-heavy profiles; Sibiu is a service operator.
    The rule must not fire — and must SAY why, on the checks list, rather
    than vanishing."""
    result = results["sibiu_dec_2019"]
    assert result.profile.profile_id == "service_operator"
    assert "input_cost_exposure" not in [r["rule_key"] for r in result.surfaced()]
    assert "input_cost_exposure" not in result.profile.applicable_detector_ids()
    notes = [c["note"] for c in result.all_checks()
             if c["rule_id"] == "input_cost_exposure"]
    assert notes and "scoped to" in notes[0] and "service_operator" in notes[0]
    # ...and the rule genuinely never ran: no observation was formed.
    observed = [c["observed"] for c in result.all_checks()
                if c["rule_id"] == "input_cost_exposure"]
    assert observed == [None]


def test_f3_plant_widening_the_scope_makes_the_rule_fire_out_of_profile():
    """PLANT F3. Widen `input_cost_exposure` to service companies in a
    PRIVATE catalogue and tune its ceiling below Sibiu's observed share.
    The rule then fires on a service book — and the F3 gate, measured
    against the REAL profiles.yaml, must reject it. Reverted by
    construction: the plant lives in a throwaway catalogue, never in the
    cached one."""
    catalog = fresh_catalog()
    spec = catalog.detectors["input_cost_exposure"]
    by_profile = dict(spec.by_profile)
    by_profile["service_operator"] = {"share_of_revenue_high": 0.10}
    catalog.detectors["input_cost_exposure"] = dataclasses.replace(
        spec, profiles=tuple(spec.profiles) + ("service_operator",),
        by_profile=by_profile)

    planted = run("sibiu_dec_2019", catalog=catalog)
    assert planted.profile.profile_id == "service_operator"
    fired = [r["rule_key"] for r in planted.surfaced()]
    assert "input_cost_exposure" in fired, (
        "the plant did not fire, so it does not exercise the gate")

    real = CP.load_catalog()
    out_of_profile = [
        r["rule_key"] for r in planted.surfaced()
        if not real.detector(r["rule_key"]).applies_to_all()
        and planted.profile.profile_id not in real.detector(r["rule_key"]).profiles]
    assert out_of_profile == ["input_cost_exposure"]

    # Reverted: the real catalogue is untouched and the rule is silent.
    assert "service_operator" not in real.detector("input_cost_exposure").profiles
    assert "input_cost_exposure" not in [
        r["rule_key"] for r in run("sibiu_dec_2019").surfaced()]


# ══ F4 — MATERIALITY ═════════════════════════════════════════════════════


def _rank_input(finding, share_of_assets, basis_value, severity="critical",
                policy=None):
    policy = policy or R.MaterialityPolicy.default()
    verdict = R.assess_materiality(
        policy, "total_assets", "total assets", basis_value,
        amount=share_of_assets * basis_value, currency=finding.currency)
    return R.RankInput(finding=dataclasses.replace(finding, severity=severity),
                       materiality=verdict, root_cause="461",
                       scope_key="461", persistence=1)


def test_f4_plant_a_critical_item_worth_three_tenths_of_a_percent_is_not_advice(results):
    """PLANT F4. Label an item CRITICAL and make it worth 0.3% of the
    balance sheet. Materiality runs FIRST and before ranking, so the
    severity label buys it nothing: it may appear as an info row, and it
    must never be a recommendation.

    This is the baseline's ordering failure inverted — there, a `high`
    note about a rounding difference outranked a `medium` note about
    19.6% of the balance sheet."""
    finding = a_finding(results)
    basis = results["agras_fy2025"].profile.figures["total_assets"]
    item = _rank_input(finding, 0.003, basis, severity="critical")

    assert item.materiality.tier == R.TIER_INFO
    assert not item.materiality.is_material()

    report = R.rank_findings([item])
    assert report.surfaced == (), "a 0.3% item surfaced as a recommendation"
    assert len(report.info) == 1
    row = report.info[0]
    assert row.recommendation is False
    assert row.disposition == R.DISPOSITION_INFO
    assert row.effective_severity == "info", (
        "the critical LABEL survived materiality")
    assert report.counts["info"] == 1

    # Control, same finding, same severity, 5% of the balance sheet.
    material = _rank_input(finding, 0.05, basis, severity="critical")
    assert material.materiality.tier == R.TIER_MATERIAL
    control = R.rank_findings([material])
    assert len(control.surfaced) == 1 and control.surfaced[0].recommendation is True


def test_f4_arithmetically_invisible_items_do_not_even_reach_the_info_row(results):
    finding = a_finding(results)
    basis = results["agras_fy2025"].profile.figures["total_assets"]
    item = _rank_input(finding, 0.0001, basis, severity="critical")
    assert item.materiality.tier == R.TIER_IMMATERIAL
    report = R.rank_findings([item])
    assert report.surfaced == () and report.info == ()
    assert report.counts["immaterial"] == 1
    assert any("below the materiality floor" in (c.get("note") or "")
               for c in report.checks)


def test_f4_materiality_refuses_rather_than_defaults_when_the_basis_is_absent():
    """A materiality decision taken against an unknown denominator is not
    a materiality decision. ABSENT is not ZERO, and it is not "pass"."""
    policy = R.MaterialityPolicy.default()
    for basis in (None, 0):
        with pytest.raises(R.MaterialityBasisMissing):
            R.assess_materiality(policy, "total_assets", "total assets",
                                 basis, amount=1000.0, currency="RON")


# ══ F5 — THE UNIT LAW ════════════════════════════════════════════════════


def test_f5_every_cited_figure_threshold_and_impact_declares_a_unit(results):
    for name, row in surfaced_pairs(results):
        where = "%s/%s" % (name, row["rule_key"])
        units = row["fact_units"]
        for figure in row["contract_elements"]["evidence"]["figures"]:
            assert figure["unit"] != F.UNIT_UNKNOWN, where
            declared = _ratio_units.unit_for_fact(figure["fact"])
            if declared != F.UNIT_UNKNOWN:
                assert declared == figure["unit"], "%s/%s" % (where, figure["fact"])
            assert units.get(figure["fact"]) == figure["unit"], where
        assert row["contract_elements"]["threshold"]["unit"] != F.UNIT_UNKNOWN, where
        assert row["contract_elements"]["impact"]["unit"] != F.UNIT_UNKNOWN, where


def test_f5_money_never_reaches_the_template_as_digits(results):
    """The generalised Critical-461 defect. Every money figure in the
    rendered template is a named placeholder; a bare currency label beside
    a number would convert on one side of the sentence and not the other.

    The adjacency rule is the engine's own — prose that merely MENTIONS
    the currency ("a company reporting in RON carries this position at the
    closing rate") is not a defect, and a gate that flagged it would be
    demanding the sentence stop naming the reporting currency at all."""
    for name, row in surfaced_pairs(results):
        where = "%s/%s" % (name, row["rule_key"])
        for template in (row["title_template"], row["body_template"]):
            orphans = F._orphan_currency_labels(template, row["source_currency"])
            assert orphans == [], "%s: %s" % (where, orphans)
        # Every declared-money fact that is PRINTED is printed as a
        # placeholder, so the display layer converts all of it or none.
        printed = [f["fact"] for f in row["contract_elements"]["evidence"]["figures"]
                   if f["unit"] == F.UNIT_MONEY]
        assert printed, where
        for fact in printed:
            assert "{{money:%s}}" % fact in row["body_template"], \
                "%s: %s printed outside a placeholder" % (where, fact)
        # ...and no dimensionless fact was smuggled into the money path,
        # which is what would hand a percentage to a currency converter.
        for fact, unit in row["fact_units"].items():
            if unit != F.UNIT_MONEY:
                assert "{{money:%s}}" % fact not in row["body_template"], \
                    "%s: %s is %s but renders as money" % (where, fact, unit)


def test_f5_the_same_book_reported_in_eur_yields_the_same_findings(results):
    """The unit law, end to end. Relabel the reporting currency and
    nothing about the ANALYSIS may move: the same rules fire, in the same
    order, on the same observations, against the same limits, with the
    same percentages — and the template comes out byte-identical, because
    every money figure in it is a placeholder rather than a numeral."""
    for name in FIXTURE_NAMES:
        native = results[name]
        other = copy.deepcopy(statements(name))
        other["currency"] = "EUR"
        swapped = s_engine.run_single_period(
            other, period_id="p-" + name, snapshot_id="snap-" + name)

        assert [r["rule_key"] for r in swapped.surfaced()] == \
            [r["rule_key"] for r in native.surfaced()], name
        for a, b in zip(native.surfaced(), swapped.surfaced()):
            where = "%s/%s" % (name, a["rule_key"])
            assert a["facts_cited"] == b["facts_cited"], where
            assert a["fact_units"] == b["fact_units"], where
            assert a["title_template"] == b["title_template"], where
            assert a["body_template"] == b["body_template"], where
            for key in ("limit", "observed", "unit"):
                assert a["contract_elements"]["threshold"][key] == \
                    b["contract_elements"]["threshold"][key], where
            for key in ("baseline", "adjusted", "delta", "unit"):
                assert a["contract_elements"]["impact"][key] == \
                    b["contract_elements"]["impact"][key], where
            assert a["source_currency"] == "RON" and b["source_currency"] == "EUR"


def test_f5_plant_a_figure_cited_under_the_wrong_unit_demotes(results):
    """PLANT F5a. Declare a percentage as money. The registry is the
    authority on what money is, so the finding is demoted rather than
    rendered — which is what stops a dimensionless number from being
    handed to a currency converter."""
    finding = a_finding(results)
    figures = list(finding.evidence.figures)
    swapped = None
    for i, figure in enumerate(figures):
        if figure.unit == F.UNIT_PERCENT:
            swapped = i
            figures[i] = dataclasses.replace(figure, unit=F.UNIT_MONEY)
            break
    assert swapped is not None, "the control finding cites no percentage"
    planted = dataclasses.replace(
        finding, evidence=dataclasses.replace(finding.evidence,
                                              figures=tuple(figures)))
    verdict = planted.verdict()
    assert not verdict.surfaced
    assert F.ELEMENT_EVIDENCE in verdict.missing_elements()
    assert any("declared" in r and "cited as" in r for r in verdict.reasons())
    assert finding.verdict().surfaced


def test_f5_plant_a_money_numeral_the_template_cannot_bind_is_refused(results):
    """PLANT F5b. The 461 defect itself: a currency label sitting beside a
    number that is nobody's cited fact. At display time the figure
    converts and the word does not — one claim, two currencies. The
    renderer refuses, and the finding is demoted."""
    finding = a_finding(results)
    planted = F.apply_advisory_narrative(
        finding,
        rationale="For a mid-size inventory-heavy operator the exposure is "
                  "RON 9,999,999 at the balance-sheet date.")
    with pytest.raises(F.OrphanCurrencyLabelError):
        planted.render()
    verdict = planted.verdict()
    assert not verdict.surfaced and F.ELEMENT_PROSE in verdict.missing_elements()
    assert finding.verdict().surfaced


# ══ F6 — COLD START ══════════════════════════════════════════════════════


def _period(ordinal, year, snapshot="snap-cold"):
    return S.PeriodRef(period_id="cold-%d" % ordinal, label="P%d" % ordinal,
                       ordinal=ordinal, year=year, month=12,
                       snapshot_id=snapshot, days_covered=365)


def _one_period_spine(name="agras_fy2025"):
    period = _period(0, 2025)
    return S.build_series_set([period], {period.period_id: statements(name)})


def _two_period_spine(name="agras_fy2025"):
    first, second = _period(0, 2024), _period(1, 2025)
    stmts = statements(name)
    older = copy.deepcopy(stmts)
    older["assembled_bs"]["ar_intercompany"] = \
        stmts["assembled_bs"]["ar_intercompany"] * 0.4
    return S.build_series_set([first, second],
                              {first.period_id: older, second.period_id: stmts})


def test_f6_one_period_yields_single_period_findings_and_a_history_note():
    """A one-period workspace gets the single-period lane in full, and
    from the multi-period lane it gets a REFUSAL naming every analysis
    that is waiting — not an empty list, and not a slope through one
    point."""
    name = "agras_fy2025"
    single = run(name)
    assert single.surfaced(), "the single-period lane produced nothing"

    profile = CP.build_company_profile(statements(name), period_id="cold-0",
                                       snapshot_id="snap-cold")
    result = E.analyse_multi_period(_one_period_spine(name), profile)

    assert result.cold_start() is True
    assert result.report is None, "a multi-period report was built from one period"
    assert result.needs_history is not None
    needs = result.needs_history
    assert needs.period_count == 1
    waiting = set(r.analysis_id for r in needs.blocked())
    assert waiting == set(P.ANALYSES), (
        "the note does not name every waiting analysis: %r" % (waiting,))
    statement = needs.statement()
    assert statement and "1 period" in statement
    for phrase in LINT.LAW_BANNED_PHRASES:
        assert phrase not in statement.lower()
    # Every waiting analysis is on the checks list with its own numbers.
    checks = result.finding_set.all_checks()
    assert set(c["rule_id"] for c in checks) == set(P.ANALYSES)
    for check in checks:
        assert check["fired"] is False
        assert check["observed"] == 1.0 and check["limit"] >= 2.0


def test_f6_plant_a_trend_computed_on_one_period_must_fail():
    """PLANT F6. Reach past the cold-start branch and ask for a trend on
    a single point. The window refuses to be built — F6 is enforced by
    SHAPE, not by remembering to check."""
    spine = _one_period_spine()
    target = [k for k in spine.subject_keys()
              if spine.require(k).spec.adverse_direction != S.DIRECTION_NONE][0]
    params = {"min_slope": 0.05, "min_r2": 0.5}
    with pytest.raises(S.NeedsHistoryError):
        D.trend(spine, target, params)
    with pytest.raises(S.NeedsHistoryError):
        S.History.of(spine.require(target), P.M_TREND.id,
                     min_points=P.ANALYSES[P.M_TREND.id].min_periods)
    # Reverted: with two periods the same call is answerable.
    two = _two_period_spine()
    assert two.period_count() == 2
    S.History.of(two.require(target), P.M_DIRECTION.id, min_points=2)


def test_f6_a_second_period_lifts_the_refusal():
    """The control. If the cold-start branch never lifted, F6 would pass
    by breaking the feature."""
    profile = CP.build_company_profile(statements("agras_fy2025"),
                                       period_id="cold-1",
                                       snapshot_id="snap-cold")
    result = E.analyse_multi_period(_two_period_spine(), profile)
    assert result.cold_start() is False
    assert result.needs_history is None
    assert result.report is not None


# ══ F7 — DETERMINISM ═════════════════════════════════════════════════════


def _payload_of(name, **kwargs):
    result = run(name, **kwargs)
    return json.dumps({
        "profile": result.profile.to_payload(),
        "rows": result.payloads(),
        "checks": result.all_checks(),
        "silence": result.silence_statement(),
    }, sort_keys=True, ensure_ascii=False)


class _BlockAI(object):
    """An import hook that makes every AI SDK unreachable. Used to prove
    the lane is fully useful with AI unavailable — the claim, tested,
    rather than asserted."""

    BLOCKED = ("anthropic", "openai")

    def find_module(self, fullname, path=None):  # py2-style, still honoured
        return self if self.find_spec(fullname, path) is not None else None

    def find_spec(self, fullname, path=None, target=None):
        head = fullname.split(".")[0]
        if head in self.BLOCKED:
            raise ImportError(
                "AI SDK %r is deliberately unreachable in this test" % fullname)
        return None


def test_f7_the_same_snapshot_yields_the_same_bytes(results):
    for name in FIXTURE_NAMES:
        first = _payload_of(name)
        second = _payload_of(name)
        assert first == second, name


def test_f7_identical_with_ai_reachable_and_with_ai_blocked(monkeypatch):
    """Ids, order and every rendered byte are the same whether an AI SDK
    is importable and credentialled or not. Both directions: a key
    PRESENT must not change anything either."""
    name = "eei_dec_2025"
    baseline = _payload_of(name)

    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test-not-a-real-key")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-not-a-real-key")
    assert _payload_of(name) == baseline, "a credential changed the findings"

    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    hook = _BlockAI()
    sys.meta_path.insert(0, hook)
    try:
        for module in [m for m in list(sys.modules)
                       if m.split(".")[0] in _BlockAI.BLOCKED]:
            sys.modules.pop(module, None)
        with pytest.raises(ImportError):
            importlib.import_module("anthropic")
        assert _payload_of(name) == baseline, "the lane needs an AI SDK to run"
    finally:
        sys.meta_path.remove(hook)


def test_f7_ordering_is_total_and_reproducible(results):
    """Order is part of the output. Two runs that agree on the set but
    not the sequence would still move a reader's attention."""
    for name in FIXTURE_NAMES:
        once = [r["rule_key"] for r in run(name).payloads()]
        twice = [r["rule_key"] for r in run(name).payloads()]
        assert once == twice, name
        assert once == sorted(
            once, key=lambda k: (_severity_rank(results[name], k), k)), name


def _severity_rank(result, rule_key):
    for row in result.payloads():
        if row["rule_key"] == rule_key:
            return R.SEVERITY_RANK.get(row["severity"], 99)
    return 99


def test_f7_plant_one_moved_input_changes_the_output():
    """PLANT F7. Perturb a single balance and the bytes must move. A
    determinism gate that cannot see a real change is measuring nothing."""
    name = "agras_fy2025"
    baseline = _payload_of(name)
    moved = copy.deepcopy(statements(name))
    moved["assembled_bs"]["ar_intercompany"] = \
        moved["assembled_bs"]["ar_intercompany"] * 1.5
    planted = json.dumps(
        s_engine.run_single_period(moved, period_id="p-" + name,
                                   snapshot_id="snap-" + name).payloads(),
        sort_keys=True, ensure_ascii=False)
    assert planted not in baseline
    assert _payload_of(name) == baseline, "the plant leaked into the fixture"


# ══ F8 — SILENCE ═════════════════════════════════════════════════════════


def test_f8_a_clean_book_says_nothing_material_and_what_it_checked():
    result = s_engine.run_single_period(
        copy.deepcopy(CLEAN_STATEMENTS), period_id="clean-1",
        snapshot_id="snap-clean")
    assert result.surfaced() == []
    assert result.demoted() == []

    silence = result.silence_statement()
    assert silence is not None, "a clean book produced no statement at all"
    assert silence["material_findings"] == 0
    checks = silence["checks"]
    assert len(checks) == len(result.profile.detector_ids()) == 17
    assert silence["checks_performed"] == len(checks)
    assert str(len(checks)) in silence["statement"]

    # It is a CLAIM, not filler: most checks carry the number they judged.
    measured = [c for c in checks if c["observed"] is not None]
    assert len(measured) >= 12, [c["rule_id"] for c in checks]
    for check in measured:
        assert check["fired"] is False
        assert check["parameter"] and check["comparator"]
        assert check["limit"] is not None
        assert check["unit"] != F.UNIT_UNKNOWN
    # ...and every detector that did NOT measure says why.
    for check in checks:
        if check["observed"] is None:
            assert (check["note"] or "").strip(), check["rule_id"]

    low = silence["statement"].lower()
    for phrase in tuple(LINT.LAW_BANNED_PHRASES) + tuple(F.BANNED_PHRASES):
        assert phrase not in low, phrase
    assert "no finding met the seven-element contract" in low


def test_f8_plant_one_breach_ends_the_silence():
    """PLANT F8. Write two thirds of book equity up out of a revaluation.
    Exactly one rule fires, the silence statement becomes `None` — silence
    is a verdict about the checks, not a default — and the checks list is
    still complete."""
    planted = copy.deepcopy(CLEAN_STATEMENTS)
    planted["assembled_bs"]["revaluation_reserves"] = 18000000.0
    result = s_engine.run_single_period(planted, period_id="clean-1",
                                        snapshot_id="snap-clean")
    fired = [r["rule_key"] for r in result.surfaced()]
    assert fired == ["equity_quality_revaluation_reserves"], fired
    assert result.silence_statement() is None
    assert len(result.all_checks()) == 17

    # Reverted.
    control = s_engine.run_single_period(
        copy.deepcopy(CLEAN_STATEMENTS), period_id="clean-1",
        snapshot_id="snap-clean")
    assert control.silence_statement() is not None


def test_f8_silence_carries_no_finding_shaped_prose():
    """The failure this replaces is a "nothing to report" card that reads
    like a finding. The statement has no title, no body and no severity —
    there is nothing for a surface to render as an insight."""
    result = s_engine.run_single_period(
        copy.deepcopy(CLEAN_STATEMENTS), period_id="clean-1",
        snapshot_id="snap-clean")
    silence = result.silence_statement()
    for key in ("title", "body", "severity", "recommendation"):
        assert key not in silence


# ══ F9 — NO MODEL IN THE NUMERIC PATH ════════════════════════════════════

#: Every module of the deterministic lane. F9 is a claim about all of
#: them, so the list is derived from the tree rather than typed out.
LANE_FILES = tuple(sorted(
    [REPO / "src" / "engine" / "api" / "_finding.py",
     REPO / "src" / "engine" / "api" / "_company_profile.py",
     REPO / "src" / "engine" / "api" / "_finding_rank.py"]
    + sorted(PACKAGE.glob("*.py"))))

AI_ROOTS = ("anthropic", "openai", "engine.ai", "engine.passes.movement_review",
            "engine.interp", "engine.consensus")


def _imported_names(path):
    tree = ast.parse(path.read_text(encoding="utf-8"))
    names = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names.extend(a.name for a in node.names)
        elif isinstance(node, ast.ImportFrom):
            names.append(node.module or "")
    return names


def test_f9_the_lane_imports_no_model_at_construction():
    """Construction-time. Not one module in the deterministic lane may
    reach an AI SDK or an AI subsystem — including transitively through
    the engine's own advisory packages."""
    assert len(LANE_FILES) >= 15, "the file list went stale"
    offenders = []
    for path in LANE_FILES:
        for name in _imported_names(path):
            for root in AI_ROOTS:
                if name == root or name.startswith(root + "."):
                    offenders.append("%s imports %s" % (path.name, name))
    assert not offenders, offenders


def test_f9_no_lane_module_constructs_a_client():
    """A model call needs a client. None of these files may name one —
    the textual scan catches an SDK reached through a late import, which
    the AST import scan above cannot see."""
    banned = ("Anthropic(", "OpenAI(", "messages.create", "chat.completions",
              "ANTHROPIC_API_KEY", "OPENAI_API_KEY")
    offenders = []
    for path in LANE_FILES:
        text = path.read_text(encoding="utf-8")
        for token in banned:
            if token in text:
                offenders.append("%s contains %r" % (path.name, token))
    assert not offenders, offenders


def test_f9_the_advisory_seam_takes_prose_and_nothing_else():
    """Runtime. The ONE entry point a model may use accepts a rationale
    and action steps — no figure, no threshold, no severity, no profile.
    A model cannot write a number here because there is no parameter to
    write one into."""
    signature = inspect.signature(F.apply_advisory_narrative)
    assert list(signature.parameters) == ["finding", "rationale", "action_steps"]
    assert signature.parameters["rationale"].default is None
    assert signature.parameters["action_steps"].default is None


def test_f9_the_numeric_fingerprint_has_teeth(results):
    """The guard behind that seam: any numeric move is detectable. Proven
    on the fingerprint directly, because the seam's own signature makes a
    numeric argument unrepresentable."""
    finding = a_finding(results)
    before = F._numeric_fingerprint(finding)
    assert before == F._numeric_fingerprint(finding)
    for mutant in (
        dataclasses.replace(finding, severity="low"),
        dataclasses.replace(finding, profile_id="something_else"),
        dataclasses.replace(finding, facts_cited=dict(
            finding.facts_cited, total_assets=1.0)),
        dataclasses.replace(finding, threshold=dataclasses.replace(
            finding.threshold, limit=finding.threshold.limit + 0.01)),
        dataclasses.replace(finding, impact=dataclasses.replace(
            finding.impact, adjusted=finding.impact.adjusted + 0.001,
            delta=finding.impact.delta + 0.001)),
    ):
        assert F._numeric_fingerprint(mutant) != before


def test_f9_a_prose_only_rewrite_moves_no_number(results):
    finding = a_finding(results)
    rewritten = F.apply_advisory_narrative(
        finding,
        rationale="For a mid-size inventory-heavy operator, money lent "
                  "inside the group is capital the entity cannot call back "
                  "on a date it controls.",
        action_steps=(
            F.ActionStep(imperative="Pull the 461 sub-ledger by counterparty",
                         artefact="settlement schedule per related entity",
                         provider="the group financial controller",
                         horizon="before the next covenant certificate"),
            F.ActionStep(imperative="Recompute the gearing covenant without 461",
                         artefact="restated covenant calculation",
                         provider="the treasury team"),
        ))
    assert rewritten.verdict().surfaced
    assert rewritten.narrative_source == "advisory"
    assert rewritten.facts_cited == finding.facts_cited
    assert F._numeric_fingerprint(rewritten) == F._numeric_fingerprint(finding)
    assert rewritten.render().body_template != finding.render().body_template
    # ...and every figure still renders identically.
    for figure in rewritten.evidence.figures:
        assert figure.render(rewritten.currency) in rewritten.render().body


#: Names the ai-sharpening lane may land the bare-numeral guard under.
#: A model rewrite that carries a CURRENCY label is already refused (see
#: the F5b plant, which is a real gate today). A bare numeral — "grown
#: 47% since last year" — is a number the engine never computed and is
#: NOT refused today. That guard is the ai-sharpening lane's; this probe
#: adopts it the moment it lands.
_NUMERAL_GUARD_CANDIDATES = (
    ("engine.api._finding", "assert_no_new_numerals"),
    ("engine.api._finding", "advisory_numeral_guard"),
    ("engine.api._finding_advisory", "apply_advisory_narrative"),
    ("engine.api.findings.ai_narrative", "apply_advisory_narrative"),
)


def _numeral_guard():
    for module_name, attr in _NUMERAL_GUARD_CANDIDATES:
        try:
            module = importlib.import_module(module_name)
        except ImportError:
            continue
        guard = getattr(module, attr, None)
        if guard is not None:
            return "%s.%s" % (module_name, attr), guard
    return None, None


def test_f9_no_model_numeral_survives_into_the_prose(results):
    """F9's last mile, and the one that is NOT closed in this lane.

    A model rewrite that writes a MONEY numeral is refused today — the
    currency label cannot bind to a placeholder and the render raises
    (proven by the F5b plant). A model rewrite that writes a BARE numeral
    is not: `apply_advisory_narrative` fingerprints the cited facts, the
    threshold and the impact, and a percentage invented inside the
    rationale text moves none of them.

    Until the ai-sharpening lane lands a numeral guard, this test SKIPS
    LOUDLY rather than passing quietly — a green tick here would claim
    F9 is closed when it is not.
    """
    finding = a_finding(results)
    name, guard = _numeral_guard()
    invented = ("For a mid-size inventory-heavy operator this balance has "
                "grown 47% since the prior year.")
    if guard is None:
        planted = F.apply_advisory_narrative(finding, rationale=invented)
        still_surfaces = planted.verdict().surfaced
        message = (
            "F9-OPEN: no advisory numeral guard is installed (looked for %s). "
            "A bare model numeral in the why-here rationale reaches a reader "
            "today: surfaced=%s. The currency-bearing case IS refused (see "
            "test_f5_plant_a_money_numeral_the_template_cannot_bind_is_refused). "
            "This gate adopts the guard automatically once the ai-sharpening "
            "lane lands one under any of those names."
            % (", ".join("%s.%s" % c for c in _NUMERAL_GUARD_CANDIDATES),
               still_surfaces))
        warnings.warn(message, UserWarning)
        pytest.skip(message)
    planted = F.apply_advisory_narrative(finding, rationale=invented)
    assert not planted.verdict().surfaced, (
        "%s is installed but a bare model numeral still surfaces" % name)


def test_f9_the_lane_is_fully_useful_with_no_credentials(monkeypatch):
    """"Fully useful with AI unavailable" as a measurement: with every
    credential removed, the lane still surfaces findings that pass the
    whole contract."""
    for key in ("ANTHROPIC_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_AUTH_TOKEN"):
        monkeypatch.delenv(key, raising=False)
    total = 0
    for name in FIXTURE_NAMES:
        result = run(name)
        for row in result.surfaced():
            assert row["narrative_source"] == "deterministic"
            assert row["missing_elements"] == []
            total += 1
    assert total >= 20, total
