"""SINGLE-PERIOD DETECTORS — under test, on the real books.

The measured baseline this package replaces (design_review/findings/
BASELINE.md, taken from production): 59 rule-authored findings, 47 of
them with no imperative verb, 34 with fewer than two figures, 11 rules
firing, 5 of them through banned boilerplate, and the worked 461 note
scoring 1.5 of the seven contract elements.

So the assertions here are not "the code runs". They are the baseline's
own failure modes, turned into gates:

  1. COVERAGE      every catalogued detector is implemented, exactly
                   once, by exactly one module — the failure mode that
                   let `asset_maturity` read a field that does not exist
                   and never fire on any company for months.
  2. THE LAW       every finding that reaches a reader carries all seven
                   elements, two figures, an imperative verb, an account
                   code and no boilerplate. Measured on real fixtures,
                   not on a hand-built example.
  3. NOT GENERIC   the same rule firing on two companies produces two
                   different sentences, with two different thresholds
                   where the profile tunes them.
  4. THE 461 CASE  the note the whole contract was designed around,
                   produced by the real detector from the real fixture,
                   with the native 19.6% unchanged and the lender's
                   haircut recomputed.
  5. ABSENT != 0   a rule whose input does not exist REFUSES and names
                   the field; it never computes a zero and calls it an
                   answer.
  6. SILENCE       a quiet period says what it checked.
  7. DETERMINISM   same statements, same bytes — twice, and through the
                   template round-trip.
  8. NO LADDER     the N7 guard, extended over this lane: no quoted
                   profile id, no comparison against one, no bare
                   division, no AI import.

The `m_*` modules that share this package belong to the multi-period
lane and are neither exercised nor guarded here.

Python 3.9 — no `match`, no `X | Y` unions.
"""

from __future__ import annotations

import ast
import copy
import json
from pathlib import Path

import pytest

from engine.api import _company_profile as CP
from engine.api import _finding as F
from engine.api import _ratio_units
from engine.api import findings
from engine.api.findings import _base
from engine.api.findings import s_engine

REPO = Path(__file__).resolve().parents[2]
PACKAGE = REPO / "src" / "engine" / "api" / "findings"
FIXTURES = (REPO / "src" / "engine" / "country_packs" / "ro_romania"
            / "fixtures" / "regression_baselines")

#: Every regression fixture, by the profile it resolves to. Listed so a
#: fixture added to the tree without being run here is visible.
FIXTURE_NAMES = (
    "scandia_fy2025",
    "agras_fy2025",
    "eei_dec_2025",
    "carniprod_fy2025",
    "sibiu_dec_2019",
    "scandia_realestate_fy2025",
    "scandia_retail_fy2025",
)

#: The live body of the note this package replaces, quoted from
#: BASELINE.md. Kept so the improvement is DEMONSTRATED rather than
#: asserted in the abstract.
LEGACY_461_BODY = (
    "Account 461 (Debitori diversi) holds RON 7,692,203 due from related "
    "parties - 19.6% of total assets RON 39,194,178. Recoverability and "
    "intent on settlement should be confirmed. Lenders typically haircut "
    "related-party receivables during covenant measurement."
)


def _statements(name):
    with open(str(FIXTURES / (name + ".json")), encoding="utf-8") as fh:
        return json.load(fh)["assembled"]["statements"]


def _run(name, **kwargs):
    return s_engine.run_single_period(
        _statements(name), period_id="p-" + name,
        snapshot_id="snap-" + name, **kwargs)


@pytest.fixture(scope="module")
def results():
    return dict((name, _run(name)) for name in FIXTURE_NAMES)


def _surfaced_rows(results):
    rows = []
    for name in FIXTURE_NAMES:
        for row in results[name].surfaced():
            rows.append((name, row))
    return rows


# ══ 1. COVERAGE ═══════════════════════════════════════════════════════════


def test_the_package_re_exports_the_single_period_runner():
    """`__init__` is kept thin so the multi-period lane can extend this
    package without either side rewriting the other's entry point — but
    the common call still has to work."""
    assert findings.run_single_period is s_engine.run_single_period
    assert findings.DETECTORS is s_engine.DETECTORS


def test_every_catalogued_detector_is_implemented():
    """The catalogue is the registry. A registered detector with no
    implementation is a rule the operator believes is running."""
    findings.assert_full_coverage()
    catalogued = set(CP.load_catalog().detectors)
    assert set(findings.DETECTORS) == catalogued
    assert len(catalogued) == 17


def test_coverage_gate_is_not_vacuous(monkeypatch):
    """A gate that cannot fail is decoration."""
    monkeypatch.setitem(findings.DETECTORS, "not_a_detector", lambda ctx: None)
    with pytest.raises(findings.DetectorCoverageError):
        findings.assert_full_coverage()


def test_each_detector_is_claimed_by_exactly_one_module():
    seen = {}
    for module in findings.MODULES:
        for detector_id in module.DETECTORS:
            assert detector_id not in seen, (
                "%s is claimed by %s and %s — one rule, two sets of evidence"
                % (detector_id, seen.get(detector_id), module.__name__))
            seen[detector_id] = module.__name__
    assert len(seen) == len(findings.DETECTORS)


def test_a_duplicate_claim_is_refused():
    class _A(object):
        __name__ = "a"
        DETECTORS = {"liquidity_cash_tight": lambda ctx: None}

    class _B(object):
        __name__ = "b"
        DETECTORS = {"liquidity_cash_tight": lambda ctx: None}

    with pytest.raises(_base.DetectorInputError):
        _base.build_registry((_A(), _B()))


def test_every_detector_runs_on_every_fixture_and_records_a_check(results):
    """A detector that neither fires nor records is invisible. Every one
    of the seventeen must leave a row on every period."""
    for name in FIXTURE_NAMES:
        rule_ids = set(row["rule_id"] for row in results[name].all_checks())
        assert rule_ids == set(findings.DETECTORS), name


# ══ 2. THE ANTI-GENERIC LAW, MEASURED ON REAL BOOKS ═══════════════════════


def test_the_fixtures_actually_produce_findings(results):
    """A law satisfied by producing nothing is not a law."""
    total = sum(len(results[name].surfaced()) for name in FIXTURE_NAMES)
    assert total >= 20, total
    assert all(results[name].surfaced() for name in FIXTURE_NAMES)


def test_nothing_produced_on_the_real_fixtures_is_demoted(results):
    """Demotion is the contract's safety net, not this package's normal
    exit. A detector that fires must be able to carry the seven."""
    demoted = []
    for name in FIXTURE_NAMES:
        for row in results[name].demoted():
            demoted.append("%s/%s: %s" % (name, row["rule_key"],
                                          "; ".join(row["demotion_reasons"])))
    assert not demoted, "\n".join(demoted)


def test_every_surfaced_finding_carries_all_seven_elements(results):
    for name, row in _surfaced_rows(results):
        for element in F.CONTRACT_ELEMENTS:
            assert row["contract_elements"][element] is not None, (
                name, row["rule_key"], element)


def test_every_surfaced_finding_carries_at_least_two_figures(results):
    """34 of the baseline's 59 carried fewer than two."""
    for name, row in _surfaced_rows(results):
        figures = row["contract_elements"]["evidence"]["figures"]
        assert len(figures) >= F.MIN_FIGURES, (name, row["rule_key"])
        text = row["title"] + " " + row["body"]
        assert len(F._NUMBER_RX.findall(text)) >= 2, (name, row["rule_key"])


def test_every_surfaced_finding_carries_an_imperative_verb(results):
    """47 of the baseline's 59 carried none."""
    for name, row in _surfaced_rows(results):
        steps = row["contract_elements"]["action"]["steps"]
        assert steps, (name, row["rule_key"])
        low = (row["title"] + " " + row["body"]).lower()
        for step in steps:
            verb = step["imperative"].split(" ", 1)[0].strip(",.;:").lower()
            assert verb in F.IMPERATIVE_VERBS, (name, row["rule_key"], verb)
            assert verb not in F.WEAK_LEAD_VERBS, (name, row["rule_key"], verb)
            assert verb in low
            assert step["artefact"].strip() and step["provider"].strip()


def test_no_surfaced_finding_uses_banned_phrasing(results):
    """5 of the baseline's 11 firing rules did."""
    for name, row in _surfaced_rows(results):
        low = (row["title"] + " " + row["body"]).lower()
        for phrase in F.BANNED_PHRASES:
            assert phrase not in low, (name, row["rule_key"], phrase)


def test_every_surfaced_finding_names_a_ledger_account(results):
    for name, row in _surfaced_rows(results):
        accounts = row["contract_elements"]["subject"]["accounts"]
        assert accounts, (name, row["rule_key"])
        codes = [a["code"] for a in accounts]
        text = row["title"] + " " + row["body"]
        assert any(code in text for code in codes), (name, row["rule_key"])
        for account in accounts:
            assert account["name"].strip(), (name, row["rule_key"])


def test_every_surfaced_finding_quantifies_a_consequence(results):
    """IMPACT is the element the baseline never had: it observed, and
    stopped. Every surfaced finding here recomputes something, and the
    recomputation moves."""
    for name, row in _surfaced_rows(results):
        impact = row["contract_elements"]["impact"]
        assert impact["kind"] in F.IMPACT_KINDS, (name, row["rule_key"])
        assert impact["delta"] != 0, (name, row["rule_key"])
        assert impact["baseline"] != impact["adjusted"], (name, row["rule_key"])
        assert impact["metric_label"].strip()


def test_every_surfaced_finding_states_its_threshold_and_it_holds(results):
    for name, row in _surfaced_rows(results):
        threshold = row["contract_elements"]["threshold"]
        assert threshold["source"].startswith("profiles.yaml#detectors."), (
            name, row["rule_key"])
        assert threshold["rule_id"] == row["rule_key"]
        rebuilt = F.Threshold(**threshold)
        assert rebuilt.holds(), (name, row["rule_key"])
        assert threshold["parameter_label"] in row["title"]


def test_every_surfaced_finding_states_where_its_figures_came_from(results):
    for name, row in _surfaced_rows(results):
        provenance = row["contract_elements"]["evidence"]["provenance"]
        assert provenance["period_id"] == "p-" + name
        assert provenance["snapshot_id"] == "snap-" + name
        assert provenance["line_refs"], (name, row["rule_key"])
        basis = row["contract_elements"]["evidence"]["comparison_basis"]
        assert basis["kind"] in F.COMPARISON_BASIS_KINDS
        assert basis["description"].strip()


def test_every_surfaced_finding_states_a_confidence_position(results):
    for name, row in _surfaced_rows(results):
        confidence = row["contract_elements"]["confidence"]
        assert confidence["level"] in F.CONFIDENCE_LEVELS
        assert confidence["basis"].strip()
        if confidence["level"] in ("medium", "low"):
            assert confidence["caveat"].strip(), (name, row["rule_key"])


# ══ 3. NOT GENERIC — the same rule says different things ═════════════════


def test_the_same_rule_on_two_companies_produces_two_sentences(results):
    """"Any sentence that would read identically for a different company"
    is the banned case. Measured across every rule that fires more than
    once."""
    bodies = {}
    for name, row in _surfaced_rows(results):
        bodies.setdefault(row["rule_key"], {})[name] = row["body"]
    shared = dict((rule, by_company) for rule, by_company in bodies.items()
                  if len(by_company) > 1)
    assert shared, "no rule fired on more than one fixture — test is vacuous"
    for rule, by_company in shared.items():
        texts = list(by_company.values())
        assert len(set(texts)) == len(texts), rule


def test_profile_tuning_actually_changes_the_number_that_judges(results):
    """A property vehicle and a food manufacturer are not graded on the
    same cash floor. The baseline graded them identically unless somebody
    remembered to add an elif."""
    limits = {}
    for name in FIXTURE_NAMES:
        for check in results[name].all_checks():
            if check["rule_id"] == "liquidity_cash_tight" and check["limit"]:
                limits[name] = check["limit"]
    assert len(set(limits.values())) > 1, limits
    assert limits["scandia_fy2025"] == pytest.approx(0.12)
    assert limits["carniprod_fy2025"] == pytest.approx(0.10)


def test_the_why_here_is_anchored_to_this_company(results):
    for name, row in _surfaced_rows(results):
        why = row["contract_elements"]["why_here"]
        assert why["profile_id"] == row["profile_id"]
        assert why["signals"], (name, row["rule_key"])
        low = why["rationale"].lower()
        assert any(anchor.lower() in low for anchor in why["anchors"]), (
            name, row["rule_key"])
        assert why["profile_label"].lower() in low


# ══ 4. THE 461 CASE, FROM THE REAL DETECTOR ══════════════════════════════


def _the_461_row(results):
    for row in results["agras_fy2025"].surfaced():
        if row["rule_key"] == "concentration_related_party":
            return row
    raise AssertionError("the 461 finding did not surface on agras_fy2025")


def test_the_live_461_body_fails_the_contract_it_is_being_replaced_by():
    low = LEGACY_461_BODY.lower()
    assert "should be confirmed" in low          # banned hedge
    assert "lenders typically" in low            # true of any company
    leading = set(word.strip(".,").lower() for word in LEGACY_461_BODY.split())
    assert not (leading & F.IMPERATIVE_VERBS)    # nothing to do


def test_the_461_finding_scores_seven_of_seven(results):
    row = _the_461_row(results)
    assert row["surfaced"] is True
    assert row["missing_elements"] == []
    for element in F.CONTRACT_ELEMENTS:
        assert row["contract_elements"][element] is not None, element


def test_the_461_native_arithmetic_is_unchanged(results):
    """19.63% of total assets, native over native — the number was never
    the defect. 7,692,202.74 / 39,194,178.46."""
    row = _the_461_row(results)
    assert row["facts_cited"]["intercompany_loans"] == pytest.approx(7692202.74)
    assert row["facts_cited"]["total_assets"] == pytest.approx(39194178.46)
    assert row["facts_cited"]["pct_of_assets"] == pytest.approx(0.1962588, rel=1e-6)
    assert "19.6%" in row["title"]
    assert "RON 7,692,203" in row["body"]


def test_the_461_finding_recomputes_the_lender_haircut(results):
    """The old note SAID lenders haircut related-party receivables. This
    one performs the haircut and prints both sides."""
    row = _the_461_row(results)
    impact = row["contract_elements"]["impact"]
    assert impact["kind"] == "recomputed_ratio"
    assert impact["baseline"] == pytest.approx(2.1181652, rel=1e-6)
    assert impact["adjusted"] == pytest.approx(1.5234680, rel=1e-6)
    assert "2.12×" in row["body"] and "1.52×" in row["body"]


def test_the_461_finding_cites_the_band_that_actually_fired(results):
    """19.63% clears the elevated band (10%) and does NOT clear the high
    band (20%). Citing the high band would be a finding whose stated rule
    did not fire."""
    row = _the_461_row(results)
    threshold = row["contract_elements"]["threshold"]
    assert threshold["parameter"] == "share_of_assets_medium"
    assert threshold["limit"] == pytest.approx(0.10)
    assert row["severity"] == "medium"


def test_the_461_finding_names_the_pack_account_family(results):
    row = _the_461_row(results)
    codes = [a["code"] for a in row["contract_elements"]["subject"]["accounts"]]
    assert codes[0] == "461"
    assert set(codes) == set(["461", "451", "452", "455"])


def test_the_related_party_family_matches_the_country_pack():
    """A copy of pack data needs a leash. If the adapter ever routes a
    different set of accounts into `ar_intercompany`, this fails rather
    than the subject quietly naming the wrong ledger."""
    from engine.country_packs.ro_romania import canonical_adapter

    from engine.api.findings import s_interco
    pack = set(code for code, bucket in canonical_adapter._RAS_TO_CANONICAL
               if bucket == "ar_intercompany")
    module = set(a.code for a in s_interco.RELATED_PARTY_ACCOUNTS)
    assert module == pack


# ══ 5. ABSENT != ZERO ════════════════════════════════════════════════════


def test_asset_maturity_refuses_and_names_the_missing_fields(results):
    """The rule this replaces divided a field that does not exist by one
    that does, got 0.0, and never fired on any company. This one says so."""
    for name in ("scandia_fy2025", "agras_fy2025", "carniprod_fy2025"):
        rows = [c for c in results[name].all_checks()
                if c["rule_id"] == "asset_maturity"]
        assert len(rows) == 1, name
        note = rows[0]["note"]
        assert rows[0]["fired"] is False
        assert rows[0]["observed"] is None, "a missing input is not a zero"
        assert "ppe_gross" in note or "scoped to" in note
    scandia = [c for c in results["scandia_fy2025"].all_checks()
               if c["rule_id"] == "asset_maturity"][0]
    assert "not run" in scandia["note"]
    assert "no proxy was substituted" in scandia["note"]


def test_asset_maturity_starts_speaking_the_day_the_fields_land():
    """The refusal is not a stub. Add the two canonical fields the rule
    needs to a real book and it produces a complete finding with no code
    change — which is what makes "not run, and here is the field" an
    honest answer rather than an excuse.
    """
    statements = copy.deepcopy(_statements("carniprod_fy2025"))
    statements["assembled_bs"]["ppe_gross"] = 200000000.0
    statements["assembled_bs"]["ppe_accumulated_depreciation"] = 130000000.0
    result = findings.run_single_period(
        statements, period_id="p-gross", snapshot_id="snap-gross")
    rows = [r for r in result.surfaced() if r["rule_key"] == "asset_maturity"]
    assert rows, [r["rule_key"] for r in result.surfaced()]
    row = rows[0]
    assert row["missing_elements"] == []
    assert row["contract_elements"]["threshold"]["observed"] == pytest.approx(0.65)
    assert "281" in row["body"]
    assert row["contract_elements"]["impact"]["delta"] != 0


def test_one_raising_detector_does_not_take_the_other_sixteen_down(monkeypatch):
    """Swallowing a failure is how a subsystem stays green while
    producing nothing. Losing sixteen findings to one bug is no better.
    The failure becomes a visible row on the checks list."""
    def _explode(ctx):
        raise ZeroDivisionError("a bug in a detector")

    monkeypatch.setitem(findings.DETECTORS, "liquidity_cash_tight", _explode)
    result = _run("scandia_fy2025")
    rules = set(row["rule_key"] for row in result.surfaced())
    assert "liquidity_cash_tight" not in rules
    assert len(rules) >= 3, rules
    row = [c for c in result.all_checks()
           if c["rule_id"] == "liquidity_cash_tight"][0]
    assert row["fired"] is False
    assert "the detector raised" in row["note"]
    assert "ZeroDivisionError" in row["note"]


def test_a_period_stripped_of_its_views_produces_checks_not_findings():
    """Nothing to read is not nothing to say — but it is certainly not a
    finding."""
    result = findings.run_single_period(
        {"currency": "RON"}, period_id="p-empty", snapshot_id="snap-empty")
    assert result.surfaced() == []
    checks = result.all_checks()
    assert set(c["rule_id"] for c in checks) == set(findings.DETECTORS)
    assert all(c["fired"] is False for c in checks)
    assert all(c["note"] for c in checks)


def test_the_reader_returns_none_for_an_absent_field_never_zero():
    reader = _base.Reader(_statements("agras_fy2025"))
    assert reader.view("bs", "total_assets") == pytest.approx(39194178.46)
    assert reader.view("bs", "no_such_field") is None
    assert reader.value("no_such_field_anywhere") is None
    assert reader.view("pl", "approximation_notes_that_are_not_numbers") is None


def test_a_missing_period_length_suppresses_the_day_metrics():
    """A quarter divided as if it were a year treble-counts, so the day
    count is dropped rather than guessed — and the finding still lands,
    with the same consequence restated as a share of the period's cost.
    Degrading the UNIT is acceptable; degrading the specificity is not.
    """
    statements = copy.deepcopy(_statements("scandia_fy2025"))
    statements["supplementary"] = {}
    result = findings.run_single_period(
        statements, period_id="p-nodays", snapshot_id="snap-nodays")
    rows = [r for r in result.surfaced()
            if r["rule_key"] == "liquidity_cash_tight"]
    assert rows, "the cash finding must still surface without a day count"
    row = rows[0]
    assert " days" not in row["body"]
    assert row["contract_elements"]["impact"]["unit"] == F.UNIT_PERCENT
    assert row["contract_elements"]["impact"]["delta"] != 0
    assert _base.per_day(1000.0, None) is None
    assert _base.per_day(1000.0, 0) is None


def test_participation_income_is_not_read_out_of_floating_residue(results):
    """Two fixtures leave -2.9e-11 in class 76 once interest and FX come
    out. That is float residue, not income, and the rule must not read a
    concentration from it."""
    for name in ("carniprod_fy2025", "scandia_realestate_fy2025"):
        rows = [c for c in results[name].all_checks()
                if c["rule_id"] == "affiliate_income_dependency"]
        assert rows[0]["fired"] is False, name
        assert "no positive residue" in rows[0]["note"], name


# ══ 6. SILENCE IS VALID ══════════════════════════════════════════════════


def test_a_quiet_period_states_what_it_checked():
    """Derived from sibiu_dec_2019 — the quietest real fixture — by
    zeroing the foreign-currency cash component, which is its only
    surfacing finding. Everything else is the real book.
    """
    statements = copy.deepcopy(_statements("sibiu_dec_2019"))
    statements["assembled_bs"]["cash_fx_component"] = 0.0
    statements["subAggregates"]["cash_fx"] = 0.0
    result = findings.run_single_period(
        statements, period_id="p-quiet", snapshot_id="snap-quiet")
    assert result.surfaced() == []
    statement = result.silence_statement()
    assert statement is not None
    assert statement["material_findings"] == 0
    assert statement["checks_performed"] == len(findings.DETECTORS)
    assert len(statement["checks"]) == len(findings.DETECTORS)
    assert "No finding met the seven-element contract" in statement["statement"]
    # Not filler: every row carries the rule and, where one was formed,
    # its parameter and the observed value.
    fired = [c for c in statement["checks"] if c["fired"]]
    assert fired == []
    measured = [c for c in statement["checks"] if c["observed"] is not None]
    assert len(measured) >= 5
    for check in measured:
        assert check["parameter"] and check["limit"] is not None


def test_a_period_with_a_finding_has_no_silence_statement(results):
    assert results["agras_fy2025"].silence_statement() is None


# ══ 7. DETERMINISM AND THE MONEY PATH ════════════════════════════════════


def test_the_same_statements_produce_the_same_bytes():
    first = json.dumps(_run("scandia_fy2025").payloads(), sort_keys=True,
                       ensure_ascii=False)
    second = json.dumps(_run("scandia_fy2025").payloads(), sort_keys=True,
                        ensure_ascii=False)
    assert first == second


def test_every_template_round_trips_to_its_own_plain_text(results):
    """`render_native(templatize(text)) == text`, byte for byte. The
    stored fallback and the template cannot disagree."""
    for name, row in _surfaced_rows(results):
        facts = row["facts_cited"]
        currency = row["source_currency"]
        assert _ratio_units.render_native(
            row["title_template"], facts, currency) == row["title"], (
                name, row["rule_key"])
        assert _ratio_units.render_native(
            row["body_template"], facts, currency) == row["body"], (
                name, row["rule_key"])


def test_every_money_figure_reaches_a_typed_placeholder(results):
    """The Critical-461 defect in its general form: a currency word that
    stays native beside a figure that converts. Every money figure cited
    must appear in the template as a placeholder, and no bare currency
    label may survive."""
    for name, row in _surfaced_rows(results):
        template = row["title_template"] + " " + row["body_template"]
        currency = row["source_currency"]
        money_facts = [fig["fact"] for fig
                       in row["contract_elements"]["evidence"]["figures"]
                       if fig["unit"] == F.UNIT_MONEY]
        placeholders = _ratio_units.placeholder_names(template)
        for fact in money_facts:
            assert fact in placeholders, (name, row["rule_key"], fact)
        # The renderer's own adjacency test, re-run on the shipped row.
        # Prose that merely MENTIONS the currency ("a company reporting
        # in RON carries this position at the closing rate") is fine; a
        # currency word touching a number, or touching a placeholder, is
        # the Critical-461 defect.
        assert not F._orphan_currency_labels(template, currency), (
            name, row["rule_key"])
        assert "|bare" not in template, (name, row["rule_key"])


def test_every_cited_fact_declares_a_unit(results):
    for name, row in _surfaced_rows(results):
        units = row["fact_units"]
        for fig in row["contract_elements"]["evidence"]["figures"]:
            assert units[fig["fact"]] == fig["unit"], (name, fig["fact"])
            assert units[fig["fact"]] != _ratio_units.UNIT_UNKNOWN
        for fact, unit in units.items():
            if unit == F.UNIT_MONEY:
                assert _ratio_units.unit_for_fact(fact) == F.UNIT_MONEY, fact


def test_a_ratio_or_percent_fact_is_never_marked_as_money(results):
    for name, row in _surfaced_rows(results):
        for fact, unit in row["fact_units"].items():
            if fact.endswith(("_share", "_pct", "_margin", "_ratio", "_x")):
                assert unit != F.UNIT_MONEY, (name, fact)


def test_two_money_facts_with_the_same_value_are_never_printed_twice():
    """Found by the placeholder gate on EEI, where the capex outflow and
    the construction spend inside it are byte-identical. Both tokens bind
    to the first fact, so the template would cite one twice and never
    name the other."""
    bag = (_base.Bag()
           .money("capex_real", -2164079.83, "capex outflow")
           .money("capitalized_construction", -2164079.83, "of which 231"))
    printed = [fig.fact for fig in bag.figures]
    assert printed == ["capex_real"]
    assert bag.facts["capitalized_construction"] == pytest.approx(-2164079.83)


def test_the_bag_refuses_an_undeclared_money_name():
    """An undeclared money figure would print as digits beside a raw
    currency word and never convert. It is refused at construction, not
    discovered at render."""
    bag = _base.Bag()
    with pytest.raises(_base.DetectorInputError):
        bag.money("cost_of_goods_sold", 1.0, "COGS")
    with pytest.raises(_base.DetectorInputError):
        bag.percent("total_assets", 0.5, "declared money, cited as percent")


def test_a_money_threshold_limit_is_normalised_rather_than_printed(results):
    """The pack's absolute floors cannot be rendered as currency — the
    limit is nobody's cited fact, so nothing can bind it. They print as a
    multiple of themselves, and the exact amount travels on the payload."""
    row = [r for r in results["scandia_fy2025"].surfaced()
           if r["rule_key"] == "cash_dividends_declared_unpaid"][0]
    threshold = row["contract_elements"]["threshold"]
    assert threshold["unit"] == F.UNIT_RATIO
    assert threshold["limit"] == pytest.approx(1.0)
    assert threshold["source"].endswith("min_amount")
    basis = row["contract_elements"]["evidence"]["comparison_basis"]
    assert basis["basis_value"] == pytest.approx(1000.0)
    assert basis["basis_unit"] == F.UNIT_MONEY
    assert row["facts_cited"]["dividends_payable"] == pytest.approx(4678772.34)


def test_a_day_impact_prints_a_delta_that_matches_its_endpoints(results):
    """4.24 days moving to 5.63 days printed as "from 4 days to 6 days
    (+1 days)" — three numbers that do not add up. Both endpoints are
    rounded before the quotient so they do."""
    seen = 0
    for name, row in _surfaced_rows(results):
        impact = row["contract_elements"]["impact"]
        if impact["unit"] != F.UNIT_DAYS:
            continue
        seen += 1
        assert impact["baseline"] == pytest.approx(round(impact["baseline"]))
        assert impact["adjusted"] == pytest.approx(round(impact["adjusted"]))
        assert impact["delta"] == pytest.approx(
            impact["adjusted"] - impact["baseline"])
    assert seen >= 3


def test_the_whole_day_helper_refuses_a_sub_day_consequence():
    reader = _base.Reader(_statements("agras_fy2025"))
    assert _base.whole_days_impact(
        "m", "M", reader, held_days=4.1, target_days=4.2,
        unit_cost=1000.0, unit_cost_name="daily") is None


# ══ 8. NO LADDER — the N7 guard, extended over this lane ═════════════════
#
# Scanned: the single-period modules and their shared plumbing. The
# `m_*` modules in the same package belong to the multi-period lane and
# carry their own guards — a test that failed here because of a file
# this lane does not own would report the wrong lane's defect.

GUARDED_FILES = tuple(sorted(
    list(PACKAGE.glob("s_*.py")) + [PACKAGE / "_base.py",
                                    PACKAGE / "__init__.py"]))


def _guarded_tokens():
    catalog = CP.load_catalog()
    tokens = set(p.id for p in catalog.structural_profiles)
    tokens |= set(b.id for b in catalog.size_bands)
    tokens |= set(f.id for f in catalog.financing_contexts)
    return tokens


def _prose_nodes(tree):
    out = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant) \
                and isinstance(node.value.value, str):
            out.add(id(node.value))
    return out


def _quoted_profile_ids(source, tokens):
    tree = ast.parse(source)
    prose = _prose_nodes(tree)
    hits = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Constant) or not isinstance(node.value, str):
            continue
        if id(node) in prose:
            continue
        if node.value.strip() in tokens:
            hits.append((node.lineno, node.value))
    return hits


def test_the_scan_set_is_non_empty():
    """If the glob ever stops finding anything the guard passes for the
    wrong reason."""
    assert len(GUARDED_FILES) >= 10, GUARDED_FILES
    assert all(path.exists() for path in GUARDED_FILES)


def test_no_detector_module_quotes_a_profile_id():
    """Profile names live in profiles.yaml, reached through the profile
    accessors. A quoted id here is the first vertebra of the if/elif
    ladder the table exists to remove."""
    tokens = _guarded_tokens()
    violations = []
    for path in GUARDED_FILES:
        for lineno, value in _quoted_profile_ids(path.read_text(encoding="utf-8"),
                                                 tokens):
            violations.append("%s:%d quotes %r"
                              % (path.relative_to(REPO), lineno, value))
    assert not violations, "\n".join(violations)


def test_the_profile_guard_is_not_vacuous():
    assert _quoted_profile_ids('X = "property_rental"\n', _guarded_tokens())
    assert not _quoted_profile_ids(
        '"""A property_rental vehicle is graded differently."""\n',
        _guarded_tokens())


def test_no_detector_module_divides_by_hand():
    """F5: every ratio goes through `_ratio_units`. The one dimensional
    conversion this package needs (money per day) lives in `_base
    .per_day`, so a division operator inside a detector module is a
    quotient that escaped the unit law."""
    violations = []
    for path in sorted(PACKAGE.glob("s_*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Div):
                violations.append("%s:%d" % (path.name, node.lineno))
    assert not violations, violations


def test_the_division_guard_is_not_vacuous():
    tree = ast.parse("x = a / b\n")
    assert [n for n in ast.walk(tree)
            if isinstance(n, ast.BinOp) and isinstance(n.op, ast.Div)]


def test_no_ai_client_reaches_the_numeric_path():
    """Detection AND quantification are deterministic. The package must
    work with credits absent, so it may not import a model client at
    all."""
    banned = ("anthropic", "openai", "_ai_council", "ai_analyzer",
              "ai_orchestrator")
    for path in GUARDED_FILES:
        source = path.read_text(encoding="utf-8")
        tree = ast.parse(source)
        for node in ast.walk(tree):
            names = []
            if isinstance(node, ast.Import):
                names = [alias.name for alias in node.names]
            elif isinstance(node, ast.ImportFrom):
                names = [node.module or ""]
            for name in names:
                for token in banned:
                    assert token not in name, (path.name, name)


def test_the_advisory_seam_leaves_every_number_where_it_was(results):
    """AI explains; it does not compute. Exercised on a real finding
    rather than a constructed one."""
    finding = results["agras_fy2025"].finding_set.surfaced[0]
    before = finding.to_payload()
    reworded = F.apply_advisory_narrative(
        finding,
        rationale=finding.why_here.rationale + " Group treasury funds it.",
        action_steps=finding.action.steps)
    after = reworded.to_payload()
    assert after["narrative_source"] == "advisory"
    assert after["surfaced"] is True
    assert after["facts_cited"] == before["facts_cited"]
    assert after["contract_elements"]["evidence"] == \
        before["contract_elements"]["evidence"]
    assert after["contract_elements"]["threshold"] == \
        before["contract_elements"]["threshold"]
    assert after["contract_elements"]["impact"] == \
        before["contract_elements"]["impact"]
    assert after["severity"] == before["severity"]
    assert "Group treasury funds it." in after["body"]


def test_the_advisory_seam_cannot_launder_a_hedge(results):
    """A model that writes the banned phrasing back into the rationale
    demotes the finding instead of rescuing it."""
    finding = results["agras_fy2025"].finding_set.surfaced[0]
    hedged = F.apply_advisory_narrative(
        finding,
        rationale=finding.why_here.rationale + " This should be monitored.")
    payload = hedged.to_payload()
    assert payload["surfaced"] is False
    assert F.ELEMENT_PROSE in payload["missing_elements"]


def test_a_moved_number_is_visible_to_the_seams_fingerprint(results):
    """The guard the seam relies on is not decoration: change a number
    and the fingerprint changes."""
    from dataclasses import replace

    finding = results["agras_fy2025"].finding_set.surfaced[0]
    moved = replace(finding, facts_cited=dict(
        finding.facts_cited, total_assets=1.0))
    assert F._numeric_fingerprint(moved) != F._numeric_fingerprint(finding)


# ══ 9. THE STATUTORY CHECKS CARRY THEIR ARTICLE ══════════════════════════


def test_every_statute_this_package_claims_reaches_the_prose(results):
    """A compliance finding without its article is an opinion."""
    from engine.api.findings import s_compliance

    row = [r for r in results["scandia_fy2025"].surfaced()
           if r["rule_key"] == "cash_dividends_declared_unpaid"][0]
    citation = s_compliance.RO_STATUTES["dividend_payment"].citation
    assert citation in row["body"]
    assert "six months" in row["body"]


def test_the_equity_floor_finding_cites_its_article():
    """Derived from agras_fy2025 by writing DOWN book equity to below
    half of the registered capital — one field changed, on a real book,
    because no regression fixture is in breach of art. 153^24 today."""
    statements = copy.deepcopy(_statements("agras_fy2025"))
    statements["assembled_bs"]["total_equity"] = 1000000.0
    result = findings.run_single_period(
        statements, period_id="p-thin", snapshot_id="snap-thin")
    rows = [r for r in result.surfaced()
            if r["rule_key"] == "equity_below_half_capital"]
    assert rows, [r["rule_key"] for r in result.surfaced()]
    row = rows[0]
    assert row["severity"] == "high"
    assert "art. 153^24 of Legea 31/1990" in row["body"]
    assert "Convene the general meeting" in row["body"]
    threshold = row["contract_elements"]["threshold"]
    assert threshold["comparator"] == "<"
    assert threshold["limit"] == pytest.approx(0.5)
    assert threshold["observed"] == pytest.approx(1000000.0 / 8795850.0)
    impact = row["contract_elements"]["impact"]
    assert impact["adjusted"] > impact["baseline"], "the remedy must improve it"


def test_negative_equity_is_a_different_severity_from_thin_equity():
    statements = copy.deepcopy(_statements("agras_fy2025"))
    statements["assembled_bs"]["total_equity"] = -5000000.0
    result = findings.run_single_period(
        statements, period_id="p-neg", snapshot_id="snap-neg")
    row = [r for r in result.surfaced()
           if r["rule_key"] == "equity_below_half_capital"][0]
    assert row["severity"] == "critical"


def test_a_zero_turnover_extract_is_caught_and_normalised():
    """Derived from agras_fy2025 by zeroing the turnover line — the
    extraction defect this rule exists for, which no clean fixture
    carries."""
    statements = copy.deepcopy(_statements("agras_fy2025"))
    statements["assembled_pl"]["revenue"] = 0.0
    statements["assembled_pl"]["capitalized_own_work_memo"] = 0.0
    result = findings.run_single_period(
        statements, period_id="p-norev", snapshot_id="snap-norev")
    rows = [r for r in result.surfaced() if r["rule_key"] == "data_quality_pnl_zero"]
    assert rows, [r["rule_key"] for r in result.surfaced()]
    row = rows[0]
    assert row["severity"] == "critical"
    threshold = row["contract_elements"]["threshold"]
    assert threshold["unit"] == F.UNIT_RATIO
    assert threshold["limit"] == pytest.approx(1.0)
    assert threshold["observed"] == pytest.approx(39194178.46 / 1000000.0)
    basis = row["contract_elements"]["evidence"]["comparison_basis"]
    assert basis["basis_value"] == pytest.approx(1000000.0)
    assert "RON 0" in row["body"]


# ══ 10. THE RESULT OBJECT ════════════════════════════════════════════════


def test_payloads_are_ordered_most_severe_first(results):
    order = ["critical", "high", "medium", "low", "info"]
    for name in FIXTURE_NAMES:
        ranks = [order.index(row["severity"]) for row in results[name].payloads()]
        assert ranks == sorted(ranks), name


def test_the_profile_that_qualified_each_finding_is_recorded(results):
    for name in FIXTURE_NAMES:
        expected = results[name].profile.profile_id
        fingerprint = results[name].profile.fingerprint()
        for row in results[name].payloads():
            assert row["profile_id"] == expected
            assert row["profile_fingerprint"] == fingerprint
            assert row["narrative_source"] == "deterministic"


def test_every_row_carries_a_category_the_catalogue_declares(results):
    catalog = CP.load_catalog()
    for name, row in _surfaced_rows(results):
        assert row["category"] == catalog.detector(row["rule_key"]).category
