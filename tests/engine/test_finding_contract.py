"""THE ANTI-GENERIC LAW, under test.

The baseline this replaces was measured in production
(design_review/findings/BASELINE.md): 59 rule-authored findings, 47 with
no imperative verb, 34 with fewer than two figures, and the worked 461
example scoring 1.5 of the 7 contract elements. These tests fix the
contract so that shape cannot come back:

  * a finding missing ANY of the seven is DEMOTED, one test per element;
  * demotion is the DEFAULT — there is no constructor argument, no
    attribute and no serializer that can surface an unvalidated finding;
  * the prose gates (>= 2 figures, >= 1 imperative verb, no boilerplate,
    an account code on the page) run on the RENDERED text;
  * the render round-trips through `_ratio_units.templatize` byte-for-byte,
    so the F5 typed-placeholder contract still holds;
  * the advisory seam can re-word and cannot compute.

Python 3.9 — no `match`, no `X | Y` unions.
"""

from __future__ import annotations

import json
from dataclasses import replace

import pytest

from engine.api import _finding as F
from engine.api import _ratio_units


# ── The worked case: the 461 note, rebuilt to the contract ──────────────
#
# Same company and same figures as the BASELINE.md example (Agras FY2025,
# account 461 holding RON 7,692,202.74 against RON 39,194,178.46 of total
# assets = 19.63%), so the before/after is a like-for-like comparison.

RELATED_PARTY = 7692202.74
TOTAL_ASSETS = 39194178.46
TOTAL_EQUITY = 21500000.0
OBSERVED_SHARE = RELATED_PARTY / TOTAL_ASSETS          # 0.19627...
LIMIT_SHARE = 0.10

#: The body that is live in production today, quoted from BASELINE.md.
#: Kept here so the test suite can demonstrate WHY it fails rather than
#: asserting the improvement in the abstract.
LEGACY_461_BODY = (
    "Account 461 (Debitori diversi) holds RON 7,692,203 due from related "
    "parties - 19.6% of total assets RON 39,194,178. Recoverability and "
    "intent on settlement should be confirmed. Lenders typically haircut "
    "related-party receivables during covenant measurement."
)


def _facts():
    return {
        "intercompany_loans": RELATED_PARTY,
        "total_assets": TOTAL_ASSETS,
        "total_equity": TOTAL_EQUITY,
        "pct_of_assets": OBSERVED_SHARE,
    }


def _complete_finding(**overrides):
    facts = _facts()
    figures = (
        F.Figure("intercompany_loans", RELATED_PARTY, F.UNIT_MONEY,
                 "related-party balance on 461"),
        F.Figure("total_assets", TOTAL_ASSETS, F.UNIT_MONEY, "total assets"),
        F.Figure("pct_of_assets", OBSERVED_SHARE, F.UNIT_PERCENT,
                 "share of total assets"),
    )
    # A RECOMPUTED RATIO, not a money delta: the equity ratio with the
    # related-party balance removed from both sides. Dimensionless, so it
    # is invariant under the display currency, and it is the number a
    # lender actually recomputes.
    impact = F.ratio_impact(
        "equity_ratio_ex_related_party",
        "Equity ratio after a full related-party haircut",
        numerator=_ratio_units.money(TOTAL_EQUITY, "RON", name="total_equity"),
        denominator=_ratio_units.money(TOTAL_ASSETS, "RON", name="total_assets"),
        adjusted_numerator=_ratio_units.money(
            TOTAL_EQUITY - RELATED_PARTY, "RON", name="equity_ex_related_party"),
        adjusted_denominator=_ratio_units.money(
            TOTAL_ASSETS - RELATED_PARTY, "RON", name="assets_ex_related_party"),
        unit=F.UNIT_PERCENT,
    )
    base = dict(
        rule_id="concentration_related_party",
        severity="high",
        category="data_quality",
        currency="RON",
        subject=F.Subject(
            accounts=(F.Account("461", "Debitori diversi", "BS", "ar_intercompany"),),
            scope="Related-party receivable on 461",
        ),
        evidence=F.Evidence(
            figures=figures,
            provenance=F.Provenance(period_id="11b8e759", snapshot_id="snap-agras",
                                    line_refs=("461",)),
            comparison_basis=F.ComparisonBasis(
                kind="self_total",
                description="measured against the company's own total assets "
                            "for the same period",
                basis_value=TOTAL_ASSETS, basis_unit=F.UNIT_MONEY),
        ),
        threshold=F.Threshold(
            rule_id="concentration_related_party",
            parameter="share_of_assets_high",
            parameter_label="related-party share of total assets (high)",
            comparator=">", limit=LIMIT_SHARE, observed=OBSERVED_SHARE,
            unit=F.UNIT_PERCENT,
            source="profiles.yaml#detectors.concentration_related_party"
                   ".thresholds.default.share_of_assets_high",
        ),
        impact=impact,
        why_here=F.WhyHere(
            profile_id="inventory_operator",
            profile_label="mid-size inventory-heavy operator",
            rationale=(
                "For a mid-size inventory-heavy operator this balance is capital "
                "lent inside the group rather than trade credit, and the lending "
                "bank's credit committee haircuts it in full when measuring the "
                "covenants."),
            signals=("related_party", "bank_debt"),
            anchors=("mid-size inventory-heavy operator", "inventory-heavy operator"),
        ),
        action=F.Action(steps=(
            F.ActionStep(
                imperative="Pull the 461 sub-ledger by counterparty with "
                           "settlement dates",
                artefact="461 aging schedule per related entity",
                provider="the group financial controller",
                horizon="before the next covenant certificate"),
            F.ActionStep(
                imperative="Recompute the gearing covenant with the 461 balance "
                           "excluded",
                artefact="restated covenant calculation",
                provider="the treasury team"),
        )),
        confidence=F.Confidence(
            level="medium",
            basis="profile inventory_operator/band_mid/fin_related_party_funded "
                  "resolved from structure",
            caveat="Cash-flow lines are indirect-method approximations because "
                   "no prior period was supplied."),
        profile_id="inventory_operator",
        profile_fingerprint="a1b2c3d4",
        facts_cited=facts,
    )
    base.update(overrides)
    return F.Finding(**base)


# ── 1. The complete finding surfaces, and carries all seven ─────────────


def test_complete_finding_surfaces():
    f = _complete_finding()
    verdict = f.verdict()
    assert verdict.surfaced, verdict.reasons()
    assert verdict.missing == ()


def test_surfaced_payload_carries_every_element_and_the_templates():
    payload = _complete_finding().to_payload()
    assert payload["surfaced"] is True
    assert payload["demoted"] is False
    for element in F.CONTRACT_ELEMENTS:
        assert payload["contract_elements"][element] is not None, element
    assert payload["title"] and payload["body"]
    assert "{{money:" in payload["body_template"]
    assert payload["fact_units"]["intercompany_loans"] == F.UNIT_MONEY
    assert payload["fact_units"]["pct_of_assets"] == F.UNIT_PERCENT
    assert payload["profile_id"] == "inventory_operator"


def test_rendered_body_states_all_seven_in_prose():
    r = _complete_finding().render()
    text = r.title + " " + r.body
    assert "461" in text                                  # subject
    assert "RON 7,692,203" in text                        # evidence
    assert "concentration_related_party" in text          # threshold: the rule
    assert "10.0%" in text and "19.6%" in text            # threshold: limit + observed
    assert "Equity ratio after a full related-party haircut" in text  # impact
    assert "54.9%" in text and "43.8%" in text                        # ...recomputed
    assert "inventory-heavy operator" in text             # why-here
    assert "Pull the 461 sub-ledger" in text              # action
    assert "Confidence medium" in text                    # confidence


# ── 2. Missing ANY element demotes — one case per element ───────────────


@pytest.mark.parametrize("element", list(F.CONTRACT_ELEMENTS))
def test_missing_element_demotes(element):
    f = _complete_finding(**{element: None})
    verdict = f.verdict()
    assert not verdict.surfaced
    assert element in verdict.missing_elements(), verdict.reasons()
    payload = f.to_payload()
    assert payload["demoted"] is True
    assert payload["title"] is None and payload["body"] is None
    # ...and it degrades to the raw "All checks" row, not to silence.
    assert payload["check_summary"]["rule_id"] == "concentration_related_party"


def test_bare_finding_is_demoted_with_every_element_missing():
    f = F.Finding(rule_id="r", severity="high", category="data_quality",
                  currency="RON")
    verdict = f.verdict()
    assert not verdict.surfaced
    assert set(verdict.missing_elements()) == set(F.CONTRACT_ELEMENTS)


# ── 3. Demotion is the DEFAULT — it cannot be bypassed ──────────────────


def test_surfaced_is_not_a_field_and_cannot_be_passed_in():
    """The single most important structural property: a caller cannot
    ASSERT that a finding is complete. Only `validate()` can."""
    assert "surfaced" not in F.Finding.__dataclass_fields__
    assert "demoted" not in F.Finding.__dataclass_fields__
    with pytest.raises(TypeError):
        F.Finding(rule_id="r", severity="high", category="c", currency="RON",
                  surfaced=True)  # type: ignore[call-arg]


def test_finding_is_frozen_so_a_verdict_cannot_be_stamped_onto_it():
    f = _complete_finding()
    with pytest.raises(Exception):
        f.severity = "info"  # type: ignore[misc]


def test_the_only_serializer_recomputes_the_verdict():
    """`to_payload` is the one exit, and it validates on the way out."""
    incomplete = _complete_finding(action=None)
    payload = incomplete.to_payload()
    assert payload["surfaced"] is False
    assert F.ELEMENT_ACTION in payload["missing_elements"]
    assert payload["demotion_reasons"]


# ── 4. The prose gates ──────────────────────────────────────────────────


def test_banned_phrasing_demotes():
    f = _complete_finding(why_here=replace(
        _complete_finding().why_here,
        rationale="For a mid-size inventory-heavy operator this should be monitored."))
    verdict = f.verdict()
    assert not verdict.surfaced
    assert F.ELEMENT_PROSE in verdict.missing_elements()
    assert any("should be monitored" in r for r in verdict.reasons())


@pytest.mark.parametrize("phrase", [
    "should be monitored", "may warrant review", "consider evaluating",
    "best practice suggests",
])
def test_the_four_named_bans_are_all_enforced(phrase):
    assert phrase in F.BANNED_PHRASES


def test_fewer_than_two_figures_demotes():
    base = _complete_finding()
    one_figure = replace(base.evidence, figures=(base.evidence.figures[0],))
    verdict = _complete_finding(evidence=one_figure).verdict()
    assert not verdict.surfaced
    assert F.ELEMENT_EVIDENCE in verdict.missing_elements()


def test_non_committal_lead_verb_demotes():
    """'Review the aging schedule' is the banned sentence with the hedge
    removed. It is still not an action."""
    weak = F.Action(steps=(F.ActionStep(
        imperative="Review the 461 aging schedule",
        artefact="461 aging schedule", provider="the controller"),))
    verdict = _complete_finding(action=weak).verdict()
    assert not verdict.surfaced
    assert F.ELEMENT_ACTION in verdict.missing_elements()
    assert any("non-committal" in r for r in verdict.reasons())


def test_action_step_without_a_provider_demotes():
    orphan = F.Action(steps=(F.ActionStep(
        imperative="Pull the 461 sub-ledger", artefact="461 aging schedule",
        provider=""),))
    verdict = _complete_finding(action=orphan).verdict()
    assert not verdict.surfaced
    assert any("provider" in r for r in verdict.reasons())


def test_why_here_that_names_no_anchor_demotes():
    """The operational form of 'a sentence that would read identically for
    a different company'."""
    generic = replace(
        _complete_finding().why_here,
        rationale="Related-party balances are a common source of credit risk.")
    verdict = _complete_finding(why_here=generic).verdict()
    assert not verdict.surfaced
    assert F.ELEMENT_WHY_HERE in verdict.missing_elements()
    assert any("identically for another company" in r for r in verdict.reasons())


def test_subject_without_a_ledger_code_demotes():
    nameless = F.Subject(accounts=(F.Account("related parties", "misc"),),
                         scope="Related-party receivable")
    verdict = _complete_finding(subject=nameless).verdict()
    assert not verdict.surfaced
    assert F.ELEMENT_SUBJECT in verdict.missing_elements()


# ── 5. The evidence and threshold have to be TRUE, not merely present ───


def test_figure_disagreeing_with_facts_cited_demotes():
    base = _complete_finding()
    lying = replace(base.evidence, figures=(
        replace(base.evidence.figures[0], value=RELATED_PARTY * 2),
    ) + base.evidence.figures[1:])
    verdict = _complete_finding(evidence=lying).verdict()
    assert not verdict.surfaced
    assert any("disagrees with facts_cited" in r for r in verdict.reasons())


def test_threshold_that_did_not_actually_fire_demotes():
    base = _complete_finding()
    not_fired = replace(base.threshold, limit=0.95)
    verdict = _complete_finding(threshold=not_fired).verdict()
    assert not verdict.surfaced
    assert any("did not actually fire" in r for r in verdict.reasons())


def test_threshold_without_a_source_address_demotes():
    base = _complete_finding()
    verdict = _complete_finding(threshold=replace(base.threshold, source="")).verdict()
    assert not verdict.surfaced
    assert any("where its parameter came from" in r for r in verdict.reasons())


def test_zero_delta_impact_is_not_a_consequence():
    flat = F.Impact(kind="money_delta", metric="m", metric_label="Book equity",
                    baseline=100.0, adjusted=100.0, delta=0.0,
                    unit=F.UNIT_MONEY, currency="RON")
    verdict = _complete_finding(impact=flat).verdict()
    assert not verdict.surfaced
    assert any("not a consequence" in r for r in verdict.reasons())


def test_provenance_without_a_source_demotes():
    base = _complete_finding()
    orphan = replace(base.evidence, provenance=F.Provenance(period_id="p1"))
    verdict = _complete_finding(evidence=orphan).verdict()
    assert not verdict.surfaced
    assert any("neither a snapshot nor a line" in r for r in verdict.reasons())


def test_confidence_position_is_mandatory_but_the_caveat_is_not():
    clean = F.Confidence(level="high", basis="all inputs present", caveat=None)
    assert _complete_finding(confidence=clean).verdict().surfaced
    hedged = F.Confidence(level="low", basis="x", caveat="")
    assert not _complete_finding(confidence=hedged).verdict().surfaced


# ── 6. Impact arithmetic goes through the ratio law ─────────────────────


def test_money_impact_refuses_a_currency_boundary():
    with pytest.raises(_ratio_units.UnitMismatchError):
        F.money_impact("m", "Equity",
                       baseline=_ratio_units.money(100.0, "RON"),
                       adjusted=_ratio_units.money(90.0, "EUR"))


def test_money_impact_refuses_a_scale_boundary():
    with pytest.raises(_ratio_units.UnitMismatchError):
        F.money_impact("m", "Equity",
                       baseline=_ratio_units.money(100.0, "RON", scale=1),
                       adjusted=_ratio_units.money(90.0, "RON", scale=1000))


def test_ratio_impact_recomputes_through_the_ratio_law():
    impact = F.ratio_impact(
        "net_debt_ebitda", "Net Debt/EBITDA",
        numerator=_ratio_units.money(100.0, "RON"),
        denominator=_ratio_units.money(20.0, "RON"),
        adjusted_denominator=_ratio_units.money(10.0, "RON"))
    assert impact.baseline == pytest.approx(5.0)
    assert impact.adjusted == pytest.approx(10.0)
    assert impact.delta == pytest.approx(5.0)
    assert impact.unit == F.UNIT_RATIO


def test_ratio_impact_refuses_an_undefined_denominator():
    with pytest.raises(_ratio_units.UndefinedRatioError):
        F.ratio_impact("x", "X",
                       numerator=_ratio_units.money(1.0, "RON"),
                       denominator=_ratio_units.money(0.0, "RON"))


def test_headroom_impact_reads_as_the_breach():
    impact = F.headroom_impact(
        "dte_headroom", "Debt/EBITDA against the covenant alarm",
        observed=_ratio_units.ratio_q(7.4), limit=_ratio_units.ratio_q(6.0))
    assert impact.delta == pytest.approx(1.4)


# ── 7. The F5 typed-placeholder contract still holds ────────────────────


def test_render_round_trips_byte_for_byte():
    f = _complete_finding()
    r = f.render()
    assert _ratio_units.render_native(r.body_template, f.facts_cited, "RON") == r.body
    assert _ratio_units.render_native(r.title_template, f.facts_cited, "RON") == r.title


def test_money_figures_become_placeholders_and_dimensionless_ones_do_not():
    r = _complete_finding().render()
    names = _ratio_units.placeholder_names(r.body_template)
    assert "intercompany_loans" in names
    assert "total_assets" in names
    assert "pct_of_assets" not in names          # a percentage never converts
    assert "19.6%" in r.body_template            # ...so it stays as printed


def test_render_is_deterministic():
    a, b = _complete_finding().render(), _complete_finding().render()
    assert (a.title, a.body, a.title_template, a.body_template) == \
           (b.title, b.body, b.title_template, b.body_template)
    assert json.dumps(_complete_finding().to_payload(), sort_keys=True) == \
           json.dumps(_complete_finding().to_payload(), sort_keys=True)


def test_an_undeclared_unit_refuses_to_render():
    with pytest.raises(F.UnknownUnitError):
        F._format_value(1.0, F.UNIT_UNKNOWN, "RON")


# ── 8. The advisory seam: re-word yes, compute no ───────────────────────


def test_advisory_may_reword_the_rationale_and_the_finding_still_surfaces():
    f = _complete_finding()
    out = F.apply_advisory_narrative(
        f,
        rationale="Because this is a mid-size inventory-heavy operator funded "
                  "in part by its own group, the 461 balance sits between the "
                  "company and its bank covenants.")
    assert out.verdict().surfaced
    assert out.narrative_source == "advisory"
    assert out.facts_cited == f.facts_cited


def test_advisory_cannot_launder_a_banned_phrase_back_in():
    f = _complete_finding()
    out = F.apply_advisory_narrative(
        f, rationale="For a mid-size inventory-heavy operator this may warrant review.")
    assert not out.verdict().surfaced


def test_advisory_seam_exposes_no_numeric_field():
    """Structural proof the model cannot compute: the seam's signature has
    only prose parameters."""
    import inspect
    params = set(inspect.signature(F.apply_advisory_narrative).parameters)
    assert params == {"finding", "rationale", "action_steps"}


def test_numeric_fingerprint_is_sensitive_to_every_number_it_guards():
    """A guard that cannot notice is decoration. Move each numeric field
    in turn and require the fingerprint to change."""
    f = _complete_finding()
    base = F._numeric_fingerprint(f)
    mutations = [
        replace(f, facts_cited=dict(f.facts_cited, total_assets=1.0)),
        replace(f, evidence=replace(f.evidence, figures=(
            replace(f.evidence.figures[0], value=1.0),) + f.evidence.figures[1:])),
        replace(f, threshold=replace(f.threshold, limit=0.99)),
        replace(f, threshold=replace(f.threshold, observed=0.99)),
        replace(f, impact=replace(f.impact, adjusted=1.0)),
        replace(f, severity="info"),
        replace(f, profile_id="property_rental"),
    ]
    for mutated in mutations:
        assert F._numeric_fingerprint(mutated) != base


def test_advisory_raises_when_a_number_moves(monkeypatch):
    f = _complete_finding()
    calls = {"n": 0}

    def _drifting(_finding_obj):
        calls["n"] += 1
        return "before" if calls["n"] == 1 else "after"

    monkeypatch.setattr(F, "_numeric_fingerprint", _drifting)
    with pytest.raises(F.NarrativeMutationError):
        F.apply_advisory_narrative(f, rationale="anything")


# ── 9. Silence is valid, and demotion has a floor ───────────────────────


def test_silence_lists_what_was_checked():
    fs = F.FindingSet(profile_id="service_operator", profile_fingerprint="ff")
    fs.record_check(F.CheckRecord(
        rule_id="liquidity_cash_tight", parameter="cash_ratio_low",
        comparator="<", limit=0.10, observed=0.42, unit=F.UNIT_RATIO,
        fired=False, profile_id="service_operator"))
    fs.record_check(F.CheckRecord(
        rule_id="leverage_debt_to_ebitda", parameter="high", comparator=">",
        limit=3.0, observed=0.4, unit=F.UNIT_RATIO, fired=False,
        profile_id="service_operator"))
    statement = fs.silence_statement()
    assert statement is not None
    assert statement["material_findings"] == 0
    assert statement["checks_performed"] == 2
    assert [c["rule_id"] for c in statement["checks"]] == [
        "liquidity_cash_tight", "leverage_debt_to_ebitda"]
    assert "check(s) ran" in statement["statement"]


def test_silence_is_not_claimed_when_something_surfaced():
    fs = F.FindingSet()
    fs.add(_complete_finding())
    assert fs.silence_statement() is None
    assert len(fs.surfaced) == 1 and not fs.demoted


def test_a_demoted_finding_still_reaches_the_all_checks_list():
    fs = F.FindingSet()
    fs.add(_complete_finding(action=None))
    assert not fs.surfaced and len(fs.demoted) == 1
    row = fs.all_checks()[0]
    assert row["rule_id"] == "concentration_related_party"
    assert row["observed"] == pytest.approx(OBSERVED_SHARE)
    assert row["fired"] is True
    assert row["note"].startswith("demoted:")


# ── 10. The baseline, as evidence ───────────────────────────────────────


def test_the_live_461_body_fails_the_contract_it_is_being_replaced_by():
    """BASELINE.md scores the production note at 1.5 of 7. These are the
    two failures the prose gates alone would have caught."""
    low = LEGACY_461_BODY.lower()
    assert any(p in low for p in F.BANNED_PHRASES), \
        "the legacy body's 'should be confirmed' must trip the ban list"
    leading_words = set(w.strip(".,").lower() for w in LEGACY_461_BODY.split())
    assert not (leading_words & F.IMPERATIVE_VERBS), \
        "the legacy body contains no imperative verb — that is the 80% finding"


def test_the_rebuilt_461_finding_scores_seven_of_seven():
    f = _complete_finding()
    assert f.verdict().surfaced
    body = f.render().body.lower()
    assert not any(p in body for p in F.BANNED_PHRASES)
    assert any(step.lead_verb() in F.IMPERATIVE_VERBS for step in f.action.steps)


# ── 11. The lexicons are coherent ───────────────────────────────────────


def test_weak_verbs_and_imperative_verbs_do_not_overlap():
    assert not (F.WEAK_LEAD_VERBS & F.IMPERATIVE_VERBS)


def test_every_gate_name_is_reachable():
    assert set(F.ALL_GATES) == set(F.CONTRACT_ELEMENTS) | {F.ELEMENT_PROSE}
    assert len(F.CONTRACT_ELEMENTS) == 7


# ── 12. The orphan-currency-label guard ─────────────────────────────────
#
# The generalised Critical-461 defect: a currency WORD that stays native
# while the figure beside it converts. It is caught in the rendered
# TEMPLATE, before anything is stored, and it demotes rather than ships.


def test_a_money_threshold_whose_limit_is_not_a_cited_fact_demotes():
    """'fires when ... is above RON 1,000,000' — the limit is a rule
    parameter, not a period fact, so `templatize` cannot bind it and the
    word RON would survive a EUR render."""
    base = _complete_finding()
    money_threshold = replace(
        base.threshold, parameter="min_assets",
        parameter_label="material asset-base floor",
        unit=F.UNIT_MONEY, limit=1000000.0, observed=TOTAL_ASSETS)
    verdict = _complete_finding(threshold=money_threshold).verdict()
    assert not verdict.surfaced
    assert F.ELEMENT_PROSE in verdict.missing_elements()
    assert any("unbound money figure" in r for r in verdict.reasons())


def test_orphan_guard_recognises_all_four_signatures():
    hits = F._orphan_currency_labels("RON {{money:x|bare}}", "RON")
    reasons = " ".join(hits)
    assert "label before a placeholder" in reasons
    assert "stripped of its label" in reasons
    assert F._orphan_currency_labels("{{money:x}} RON", "RON")
    assert F._orphan_currency_labels("holds RON 7,692,203 today", "RON")


def test_orphan_guard_leaves_prose_that_merely_names_the_currency_alone():
    """The catalogue's FX copy legitimately says 'reporting in RON'. An
    over-eager guard would demote every FX finding ever written."""
    assert F._orphan_currency_labels(
        "A property-rental vehicle reporting in RON carries this position "
        "at the closing rate.", "RON") == []


def test_orphan_guard_is_not_vacuous_on_the_real_render():
    """Feed the renderer the exact adjacency that produced the live
    defect — a bare account code immediately before a money label — and
    require the guard to trip."""
    template = "balance on 461 RON {{money:intercompany_loans|bare}}"
    assert F._orphan_currency_labels(template, "RON")


# ── 13. Money impacts must cite both endpoints as facts ─────────────────


def test_money_impact_endpoints_are_taken_from_the_quantity_names():
    impact = F.money_impact(
        "net_debt_after_cash", "Debt net of cash",
        baseline=_ratio_units.money(1000.0, "RON", name="bank_debt_total"),
        adjusted=_ratio_units.money(800.0, "RON", name="net_debt"))
    assert impact.baseline_fact == "bank_debt_total"
    assert impact.adjusted_fact == "net_debt"


def test_money_impact_surfaces_when_both_endpoints_are_cited_money_facts():
    facts = dict(_facts())
    facts.update({"bank_debt_total": 1000.0, "net_debt": 800.0})
    impact = F.money_impact(
        "net_debt_after_cash", "Debt net of cash",
        baseline=_ratio_units.money(1000.0, "RON", name="bank_debt_total"),
        adjusted=_ratio_units.money(800.0, "RON", name="net_debt"))
    verdict = _complete_finding(impact=impact, facts_cited=facts).verdict()
    assert verdict.surfaced, verdict.reasons()


def test_money_impact_with_an_undeclared_endpoint_demotes():
    """`_ratio_units` is the authority on what money is. An endpoint it
    does not declare would render as unconvertible digits."""
    facts = dict(_facts())
    facts["equity_ex_related_party"] = TOTAL_EQUITY - RELATED_PARTY
    impact = F.money_impact(
        "equity_after_haircut", "Book equity after the haircut",
        baseline=_ratio_units.money(TOTAL_EQUITY, "RON", name="total_equity"),
        adjusted=_ratio_units.money(TOTAL_EQUITY - RELATED_PARTY, "RON",
                                    name="equity_ex_related_party"))
    verdict = _complete_finding(impact=impact, facts_cited=facts).verdict()
    assert not verdict.surfaced
    assert any("does not declare as money" in r for r in verdict.reasons())


def test_money_impact_with_an_uncited_endpoint_demotes():
    impact = F.money_impact(
        "net_debt_after_cash", "Debt net of cash",
        baseline=_ratio_units.money(1000.0, "RON", name="bank_debt_total"),
        adjusted=_ratio_units.money(800.0, "RON", name="net_debt"))
    verdict = _complete_finding(impact=impact).verdict()   # facts unchanged
    assert not verdict.surfaced
    assert any("not in facts_cited" in r for r in verdict.reasons())


def test_money_impact_without_named_operands_demotes():
    impact = F.money_impact(
        "x", "X",
        baseline=_ratio_units.money(1000.0, "RON"),
        adjusted=_ratio_units.money(800.0, "RON"))
    verdict = _complete_finding(impact=impact).verdict()
    assert not verdict.surfaced
    assert any("which fact holds its baseline" in r for r in verdict.reasons())


def test_a_money_impact_does_not_print_a_third_uncited_figure():
    """The delta of two facts is not itself a fact. Printing it would put
    an unconvertible money number beside two converted ones."""
    facts = dict(_facts())
    facts.update({"bank_debt_total": 1000.0, "net_debt": 800.0})
    impact = F.money_impact(
        "net_debt_after_cash", "Debt net of cash",
        baseline=_ratio_units.money(1000.0, "RON", name="bank_debt_total"),
        adjusted=_ratio_units.money(800.0, "RON", name="net_debt"))
    body = _complete_finding(impact=impact, facts_cited=facts).render().body
    assert "Debt net of cash moves from RON 1,000 to RON 800." in body
    assert "-RON 200" not in body
    assert impact.delta == pytest.approx(-200.0)   # still on the payload


# ── ActionStep language stamp ────────────────────────────────────────────
#
# A Romanian step spliced with the English joiner produced "…, from
# controlorul financiar": half-translated, and plausible enough to ship.
# The language travels with the words now, not with the code path.

def test_english_step_renders_with_the_english_joiner():
    step = F.ActionStep("Obtain the aging schedule",
                        "counterparty balances", "the financial controller")
    assert step.render() == (
        "Obtain the aging schedule — counterparty balances, "
        "from the financial controller.")


def test_english_is_the_default_so_every_detector_is_byte_identical():
    assert F.ActionStep("A", "b", "c").lang == "en"
    assert F.ActionStep("A", "b", "c").render() == "A — b, from c."


def test_romanian_step_renders_with_the_romanian_joiner():
    step = F.ActionStep("Obține balanța pe vechimi",
                        "soldurile pe contrapartidă",
                        "controlorul financiar", lang="ro")
    rendered = step.render()
    assert "de la controlorul financiar" in rendered
    assert " from " not in rendered


def test_horizon_placement_is_unchanged_in_both_languages():
    en = F.ActionStep("A", "b", "c", horizon="within 2 weeks").render()
    ro = F.ActionStep("A", "b", "c", horizon="în 2 săptămâni",
                      lang="ro").render()
    assert en == "A — b, from c (within 2 weeks)."
    assert ro == "A — b, de la c (în 2 săptămâni)."


def test_unknown_language_refuses_rather_than_falling_back_to_english():
    # ABSENT is not "the English one". A half-rendered sentence reads as
    # correct, which is why this must raise instead of degrade.
    with pytest.raises(ValueError) as exc:
        F.ActionStep("A", "b", "c", lang="hu").render()
    assert "_JOINERS" in str(exc.value)
