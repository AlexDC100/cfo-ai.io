"""THE COMPANY PROFILE — under test, including the N7-style guard.

Three jobs here:

  1. The profile is DERIVED from the period's own data and is
     deterministic — the same statements always produce the same profile,
     the same thresholds and the same fingerprint. Exercised against the
     real regression fixtures (Scandia, EEI, Agras, Carniprod, Sibiu), not
     synthetic dictionaries, so a classifier that only works on invented
     shapes fails here.

  2. ABSENT != ZERO. A missing input yields UNKNOWN, a profile that
     matches nothing yields the catalogue's declared fallback with a
     caveat, and neither is ever a silent 0.0 that would let a tuned
     threshold judge a company nobody classified.

  3. THE N7 GUARD. Profile names, applicability and thresholds live in
     `profiles.yaml`. A quoted profile id in a detector module — or a
     comparison against one — is the first vertebra of the if/elif ladder
     this design exists to remove, and the guard fails the build on
     either. It is fed a poisoned file to prove it can fail.

Python 3.9 — no `match`, no `X | Y` unions.
"""

from __future__ import annotations

import ast
import json
from pathlib import Path

import pytest
import yaml

from engine.api import _company_profile as CP
from engine.api import _finding as F

REPO = Path(__file__).resolve().parents[2]
FIXTURES = (REPO / "src" / "engine" / "country_packs" / "ro_romania"
            / "fixtures" / "regression_baselines")


def _statements(fixture_name):
    with open(str(FIXTURES / (fixture_name + ".json")), encoding="utf-8") as fh:
        return json.load(fh)["assembled"]["statements"]


def _profile(fixture_name, **kwargs):
    return CP.build_company_profile(
        _statements(fixture_name), period_id="fx-" + fixture_name, **kwargs)


# ── 1. The catalogue loads and validates ────────────────────────────────


def test_catalog_loads_from_the_pack():
    cat = CP.load_catalog()
    assert cat.version == "ro_profiles_v1"
    assert cat.currency == "RON"
    assert cat.detectors and cat.structural_profiles and cat.size_bands
    assert cat.financing_contexts and cat.signals


def test_catalog_is_cached_by_path_and_mtime():
    assert CP.load_catalog() is CP.load_catalog()


def test_every_detector_declares_a_unit_and_a_label_for_every_threshold():
    cat = CP.load_catalog()
    for spec in cat.detectors.values():
        assert set(spec.units) == set(spec.default) == set(spec.labels), spec.id
        for key, unit in spec.units.items():
            assert unit in CP._UNIT_BY_NAME.values(), (spec.id, key)


def test_exactly_one_structural_profile_is_the_declared_fallback():
    cat = CP.load_catalog()
    fallbacks = [p for p in cat.structural_profiles if p.fallback]
    assert len(fallbacks) == 1
    assert cat.fallback_profile is fallbacks[0]


# -- and the loader's validation is not decoration ----------------------


def _write_catalog(tmp_path, mutate):
    with open(str(CP.DEFAULT_PROFILES_PATH), encoding="utf-8") as fh:
        raw = yaml.safe_load(fh)
    mutate(raw)
    target = tmp_path / "profiles.yaml"
    with open(str(target), "w", encoding="utf-8") as fh:
        yaml.safe_dump(raw, fh, allow_unicode=True)
    return str(target)


def test_loader_rejects_an_undeclared_threshold_unit(tmp_path):
    def mutate(raw):
        raw["detectors"][0]["thresholds"]["units"] = dict(
            (k, "furlongs") for k in raw["detectors"][0]["thresholds"]["units"])
    with pytest.raises(CP.CatalogError):
        CP.load_catalog(_write_catalog(tmp_path, mutate))


def test_loader_rejects_a_threshold_without_a_label(tmp_path):
    def mutate(raw):
        raw["detectors"][0]["thresholds"]["labels"] = {}
    with pytest.raises(CP.CatalogError):
        CP.load_catalog(_write_catalog(tmp_path, mutate))


def test_loader_rejects_an_override_for_an_unknown_profile(tmp_path):
    def mutate(raw):
        raw["detectors"][0]["thresholds"]["by_profile"] = {
            "not_a_profile": dict(raw["detectors"][0]["thresholds"]["default"])}
    with pytest.raises(CP.CatalogError):
        CP.load_catalog(_write_catalog(tmp_path, mutate))


def test_loader_rejects_a_structural_rule_on_an_unknown_metric(tmp_path):
    def mutate(raw):
        raw["structural_profiles"][0]["requires"]["moon_phase_min"] = 0.5
    with pytest.raises(CP.CatalogError):
        CP.load_catalog(_write_catalog(tmp_path, mutate))


def test_loader_rejects_a_detector_with_no_why_here_copy(tmp_path):
    def mutate(raw):
        raw["detectors"][0]["why_here"] = {}
    with pytest.raises(CP.CatalogError):
        CP.load_catalog(_write_catalog(tmp_path, mutate))


def test_loader_rejects_two_fallback_profiles(tmp_path):
    def mutate(raw):
        raw["structural_profiles"][0]["fallback"] = True
    with pytest.raises(CP.CatalogError):
        CP.load_catalog(_write_catalog(tmp_path, mutate))


# ── 2. Real companies classify to distinguishable profiles ──────────────


@pytest.mark.parametrize("fixture,structure,band,financing", [
    ("scandia_fy2025", "inventory_operator", "band_large", "fin_bank_levered"),
    ("agras_fy2025", "inventory_operator", "band_mid", "fin_related_party_funded"),
    ("eei_dec_2025", "property_rental", "band_small", "fin_bank_levered"),
    ("carniprod_fy2025", "asset_operator", "band_mid", "fin_unlevered"),
    ("sibiu_dec_2019", "service_operator", "band_small", "fin_unlevered"),
])
def test_real_fixtures_classify(fixture, structure, band, financing):
    p = _profile(fixture)
    assert p.structure.id == structure
    assert p.size_band.id == band
    assert p.financing.id == financing


def test_the_same_rule_gets_a_different_limit_for_a_different_company():
    """The whole point of the table: EEI and Scandia are not graded on the
    same Debt/EBITDA ceiling."""
    eei = _profile("eei_dec_2025").threshold("leverage_debt_to_ebitda", "critical")
    scandia = _profile("scandia_fy2025").threshold("leverage_debt_to_ebitda", "critical")
    assert eei.value == 12.0 and eei.tuned
    assert scandia.value == 6.0 and scandia.tuned
    assert eei.value != scandia.value


def test_a_fixture_that_matches_no_profile_says_so_rather_than_guessing():
    p = _profile("scandia_realestate_fy2025")
    assert p.structure.id == CP.load_catalog().fallback_profile.id
    assert CP.CAVEAT_UNCLASSIFIED in p.caveat_ids
    assert p.confidence().level in ("medium", "low")
    assert "did not resolve to a structural profile" in (p.confidence().caveat or "")


# ── 3. Determinism ──────────────────────────────────────────────────────


def test_profile_is_deterministic():
    a, b = _profile("agras_fy2025"), _profile("agras_fy2025")
    assert a.to_payload() == b.to_payload()
    assert a.fingerprint() == b.fingerprint()


def test_different_companies_get_different_fingerprints():
    assert _profile("agras_fy2025").fingerprint() != \
           _profile("eei_dec_2025").fingerprint()


def test_no_clock_or_environment_enters_the_profile():
    payload = _profile("agras_fy2025").to_payload()
    blob = json.dumps(payload, sort_keys=True)
    # The payload's key set is fixed and contains no timestamp, no path
    # and no environment value, so two runs on two machines agree.
    assert set(payload) == {
        "catalog_version", "period_id", "currency", "profile_id",
        "profile_label", "composite_id", "size_band", "structure",
        "sector_source", "sector_label", "caen", "financing", "signals",
        "metrics", "caveats"}
    assert blob == json.dumps(_profile("agras_fy2025").to_payload(), sort_keys=True)


# ── 4. ABSENT != ZERO ───────────────────────────────────────────────────


def test_an_empty_period_falls_back_and_says_it_could_not_classify():
    p = CP.build_company_profile({}, period_id="empty")
    assert p.structure.id == CP.load_catalog().fallback_profile.id
    assert CP.CAVEAT_UNCLASSIFIED in p.caveat_ids
    assert all(v is None for v in p.metrics.values())


def test_a_signal_with_no_source_fact_is_unknown_not_absent():
    """No canonical lease field exists yet. 'We do not know' is the honest
    answer; 'there are no leases' would be a fabricated one."""
    p = _profile("scandia_fy2025")
    lease = p.signal("lease_obligations")
    assert lease.state == CP.STATE_UNKNOWN
    assert not p.has_signal("lease_obligations")
    assert "none of" in lease.basis


def test_a_signal_present_at_zero_is_absent_not_unknown():
    p = _profile("carniprod_fy2025")
    debt = p.signal("bank_debt")
    assert debt.state == CP.STATE_ABSENT
    assert debt.value == 0.0
    assert "read from" in debt.basis


def test_an_unknown_metric_never_satisfies_a_requirement():
    assert CP._requirements_met({"ppe_share_of_assets_min": 0.0},
                                {"ppe_share_of_assets": None}) is False
    assert CP._requirements_met({"ppe_share_of_assets_max": 1.0},
                                {"ppe_share_of_assets": None}) is False


def test_a_share_of_an_absent_total_is_none_not_zero():
    assert CP._share(10.0, None, "RON") is None
    assert CP._share(None, 10.0, "RON") is None
    assert CP._share(10.0, 0.0, "RON") is None       # undefined, not nil


def test_ppe_share_never_exceeds_the_asset_base():
    """`ppe_net` is already the tangible total; `ppe_investment_net` and
    `ppe_under_construction` sit INSIDE it. Summing them put EEI's PP&E
    share at 157% of assets and mis-scored every asset-weight rule."""
    for fixture in ("eei_dec_2025", "scandia_fy2025", "carniprod_fy2025"):
        share = _profile(fixture).metrics["ppe_share_of_assets"]
        assert share is not None and 0.0 <= share <= 1.05, (fixture, share)


# ── 5. Threshold resolution carries its own address ─────────────────────


def test_a_tuned_threshold_records_the_by_profile_path():
    spec = _profile("eei_dec_2025").threshold("leverage_debt_to_ebitda", "high")
    assert spec.tuned
    assert spec.source == (
        "profiles.yaml#detectors.leverage_debt_to_ebitda.thresholds"
        ".by_profile.property_rental.high")
    assert spec.unit == F.UNIT_RATIO
    assert spec.parameter_label == "Debt/EBITDA comfort ceiling"


def test_an_untuned_threshold_records_the_default_path():
    spec = _profile("sibiu_dec_2019").threshold("liquidity_cash_tight",
                                                "cash_ratio_low")
    assert not spec.tuned
    assert spec.source.endswith(".thresholds.default.cash_ratio_low")


def test_thresholds_returns_the_whole_parameter_set():
    specs = _profile("agras_fy2025").thresholds("concentration_related_party")
    assert sorted(specs) == ["share_of_assets_high", "share_of_assets_medium"]
    assert specs["share_of_assets_high"].unit == F.UNIT_PERCENT


def test_an_unregistered_detector_refuses_rather_than_defaulting():
    with pytest.raises(CP.UnknownDetectorError):
        _profile("agras_fy2025").threshold("invented_detector", "high")


def test_an_undeclared_parameter_refuses():
    with pytest.raises(CP.UnknownThresholdError):
        _profile("agras_fy2025").threshold("leverage_debt_to_ebitda", "invented")


# ── 6. Applicability ────────────────────────────────────────────────────


def test_a_detector_needing_an_absent_signal_does_not_run():
    verdict = _profile("carniprod_fy2025").applies("leverage_debt_to_ebitda")
    assert not verdict.applies
    assert "bank_debt" in verdict.reason


def test_a_detector_scoped_to_other_profiles_does_not_run():
    verdict = _profile("eei_dec_2025").applies("input_cost_exposure")
    assert not verdict.applies
    assert "scoped to" in verdict.reason


def test_a_detector_needing_an_unknown_signal_runs_with_a_caveat():
    """Blocking on UNKNOWN would silently drop findings for books that
    simply do not carry the field; asserting absence would be worse."""
    stmts = dict(_statements("agras_fy2025"))
    bs = dict(stmts["assembled_bs"])
    bs.pop("ar_intercompany", None)
    stmts["assembled_bs"] = bs
    stmts["subAggregates"] = {}
    p = CP.build_company_profile(stmts, period_id="no-rp")
    assert p.signal("related_party").state == CP.STATE_UNKNOWN
    verdict = p.applies("concentration_related_party")
    assert verdict.applies
    assert CP.CAVEAT_SIGNAL_UNKNOWN in verdict.caveats
    assert p.confidence("concentration_related_party").level in ("medium", "low")


def test_an_all_profiles_detector_runs_everywhere():
    for fixture in ("agras_fy2025", "eei_dec_2025", "carniprod_fy2025"):
        assert _profile(fixture).applies("data_quality_bs_imbalance").applies


# ── 7. The profile composes with the Finding contract ───────────────────


def test_profile_why_here_passes_the_finding_contract():
    """The integration that matters: a why-here built from catalogue copy
    against a real company satisfies the anti-generic validator, without
    a detector writing a sentence by hand."""
    p = _profile("agras_fy2025", snapshot_id="snap-agras")
    why = p.why_here("concentration_related_party",
                     scope="Related-party receivable on 461")
    assert isinstance(why, F.WhyHere)
    assert why.profile_id == p.profile_id
    assert why.anchors and any(a.lower() in why.rationale.lower()
                               for a in why.anchors)
    assert "{" not in why.rationale                       # every token resolved

    facts = {"intercompany_loans": 7692202.74, "total_assets": 39194178.46,
             "pct_of_assets": 0.19627}
    # 19.63% clears the `medium` band (10%) and does NOT clear `high`
    # (20%). Picking the wrong one is caught by the threshold check —
    # "the rule did not actually fire" — which is how this test was
    # written correctly the second time.
    limit = p.threshold("concentration_related_party", "share_of_assets_medium")
    finding = F.Finding(
        rule_id="concentration_related_party", severity="medium",
        category="data_quality", currency=p.currency,
        subject=F.Subject(
            accounts=(F.Account("461", "Debitori diversi", "BS"),),
            scope="Related-party receivable on 461"),
        evidence=F.Evidence(
            figures=(
                F.Figure("intercompany_loans", 7692202.74, F.UNIT_MONEY,
                         "related-party balance"),
                F.Figure("total_assets", 39194178.46, F.UNIT_MONEY, "total assets"),
                F.Figure("pct_of_assets", 0.19627, F.UNIT_PERCENT,
                         "share of total assets"),
            ),
            provenance=p.provenance_for(("461",)),
            comparison_basis=F.ComparisonBasis(
                kind="profile_threshold",
                description="compared with the %s limit for a %s"
                            % (limit.parameter_label, p.profile_label))),
        threshold=F.Threshold(
            rule_id="concentration_related_party", parameter=limit.parameter,
            parameter_label=limit.parameter_label, comparator=">",
            limit=limit.value, observed=0.19627, unit=limit.unit,
            source=limit.source),
        impact=F.ratio_impact(
            "equity_ratio_ex_related_party", "Equity ratio after the haircut",
            numerator=CP._ratio_units.money(21500000.0, "RON"),
            denominator=CP._ratio_units.money(39194178.46, "RON"),
            adjusted_numerator=CP._ratio_units.money(13807797.26, "RON"),
            adjusted_denominator=CP._ratio_units.money(31501975.72, "RON"),
            unit=F.UNIT_PERCENT),
        why_here=why,
        action=F.Action(steps=(F.ActionStep(
            imperative="Pull the 461 sub-ledger by counterparty",
            artefact="461 aging schedule per related entity",
            provider="the group financial controller"),)),
        confidence=p.confidence("concentration_related_party"),
        profile_id=p.profile_id, profile_fingerprint=p.fingerprint(),
        facts_cited=facts,
    )
    verdict = finding.verdict()
    assert verdict.surfaced, verdict.reasons()
    assert p.profile_label in finding.render().body


def test_profile_confidence_is_a_stated_position_even_when_clean():
    p = CP.build_company_profile(
        {"assembled_bs": {"total_assets": 100.0, "inventory": 30.0,
                          "bs_balance_delta": 0.0},
         "assembled_pl": {"revenue": 100.0}},
        period_id="clean")
    conf = p.confidence()
    assert conf.level in ("high", "medium", "low")
    assert conf.basis


def test_why_here_falls_back_to_default_copy_for_an_unlisted_profile():
    default_user = _profile("agras_fy2025").why_here("concentration_related_party")
    override_user = _profile("eei_dec_2025").why_here("concentration_related_party")
    assert default_user.rationale != override_user.rationale


# ── 8. THE N7 GUARD — profile names live in the table, nowhere else ──────
#
# Scanned: the modules that hold (or will hold) deterministic detectors.
# `pipeline.py` is where `stage_validate`'s rules live today; the
# `_detectors` package is where the detector lanes put theirs. Discovered
# by glob, so a new detector module comes under the guard the moment it
# lands rather than when someone remembers to list it.

DETECTOR_SCAN_PATHS = tuple(sorted(
    [REPO / "src" / "engine" / "api" / "pipeline.py"]
    + sorted((REPO / "src" / "engine" / "api" / "_detectors").rglob("*.py"))
    + sorted((REPO / "src" / "engine" / "api").glob("_detector_*.py"))
))

#: The reader and the contract are exempt: one parses the table, the
#: other never mentions a profile at all.
GUARD_EXEMPT = {"_company_profile.py", "_finding.py"}


def _guarded_tokens():
    cat = CP.load_catalog()
    tokens = set(p.id for p in cat.structural_profiles)
    tokens |= set(b.id for b in cat.size_bands)
    tokens |= set(f.id for f in cat.financing_contexts)
    return tokens


def _prose_nodes(tree):
    """Docstrings and bare string expressions, so comments-in-disguise
    never trip the guard."""
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


def _profile_comparisons(source):
    tree = ast.parse(source)
    hits = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Compare):
            continue
        operands = [node.left] + list(node.comparators)
        names = []
        for operand in operands:
            if isinstance(operand, ast.Name):
                names.append(operand.id)
            elif isinstance(operand, ast.Attribute):
                names.append(operand.attr)
        has_string = any(isinstance(o, ast.Constant) and isinstance(o.value, str)
                         for o in operands)
        if has_string and any(
                n in ("profile", "profile_id", "structure", "size_band",
                      "composite_id", "financing") for n in names):
            hits.append(node.lineno)
    return hits


def test_n7_no_quoted_profile_id_in_a_detector_module():
    tokens = _guarded_tokens()
    violations = []
    for path in DETECTOR_SCAN_PATHS:
        if path.name in GUARD_EXEMPT or not path.exists():
            continue
        source = path.read_text(encoding="utf-8")
        for lineno, value in _quoted_profile_ids(source, tokens):
            violations.append("%s:%d quotes profile id %r"
                              % (path.relative_to(REPO), lineno, value))
    assert not violations, (
        "N7 violation — profile names belong in profiles.yaml, reached "
        "through _company_profile.py accessors:\n" + "\n".join(violations))


def test_n7_no_profile_comparison_in_a_detector_module():
    violations = []
    for path in DETECTOR_SCAN_PATHS:
        if path.name in GUARD_EXEMPT or not path.exists():
            continue
        for lineno in _profile_comparisons(path.read_text(encoding="utf-8")):
            violations.append("%s:%d compares a profile against a string literal"
                              % (path.relative_to(REPO), lineno))
    assert not violations, (
        "N7 violation — branch on profile.applies(detector) and "
        "profile.threshold(detector, parameter), never on a profile id:\n"
        + "\n".join(violations))


def test_n7_guard_is_not_vacuous():
    """A guard that cannot fail is decoration. Feed it both poisons."""
    tokens = _guarded_tokens()
    poison_literal = "X = \"property_rental\"\n"
    assert _quoted_profile_ids(poison_literal, tokens)
    poison_branch = "if profile_id == \"property_rental\":\n    pass\n"
    assert _profile_comparisons(poison_branch)


def test_n7_guard_ignores_prose_and_docstrings():
    benign = '"""A property_rental vehicle is graded differently."""\n'
    assert not _quoted_profile_ids(benign, _guarded_tokens())


def test_n7_scan_set_is_non_empty():
    """If the glob ever stops finding anything the guard passes for the
    wrong reason."""
    assert [p for p in DETECTOR_SCAN_PATHS if p.exists()]


def test_the_reader_itself_quotes_no_profile_id():
    """`_company_profile.py` parses the table; it must not embed it."""
    source = (REPO / "src" / "engine" / "api" / "_company_profile.py").read_text(
        encoding="utf-8")
    assert not _quoted_profile_ids(source, _guarded_tokens())


# ── 9. The catalogue's copy is company-aware by construction ────────────


def test_every_why_here_template_carries_a_company_anchor():
    """`{profile_label}` is what stops a rationale reading identically for
    a different company. Missing it, the Finding validator would demote
    every finding the detector produces — this catches it in the table
    instead of at runtime."""
    cat = CP.load_catalog()
    missing = []
    for spec in cat.detectors.values():
        if "{profile_label}" not in spec.why_here_default:
            missing.append("%s.default" % spec.id)
        for pid, copy in spec.why_here_by_profile.items():
            if "{profile_label}" not in copy:
                missing.append("%s.by_profile.%s" % (spec.id, pid))
    assert not missing, "why-here copy without {profile_label}: %r" % missing


def test_no_why_here_template_uses_banned_phrasing():
    cat = CP.load_catalog()
    offenders = []
    for spec in cat.detectors.values():
        texts = [spec.why_here_default] + list(spec.why_here_by_profile.values())
        for text in texts:
            low = text.lower()
            for phrase in F.BANNED_PHRASES:
                if phrase in low:
                    offenders.append((spec.id, phrase))
    assert not offenders, offenders


def test_every_rendered_why_here_resolves_all_its_tokens():
    p = _profile("agras_fy2025")
    for detector_id in sorted(CP.load_catalog().detectors):
        rationale = p.why_here(detector_id, scope="the balance").rationale
        assert "{" not in rationale and "}" not in rationale, detector_id
        assert p.profile_label in rationale, detector_id


def test_the_bare_profile_provenance_is_not_enough_for_a_finding():
    """The profile knows the period; only the detector knows which lines
    it read. Handing the bare provenance to a Finding demotes it, and
    `provenance_for` is the one-line fix."""
    p = _profile("agras_fy2025", snapshot_id="snap-agras")
    assert p.provenance.line_refs == ()
    assert p.provenance_for(("461", "4111")).line_refs == ("461", "4111")
    assert p.provenance_for(("461",)).period_id == p.provenance.period_id
    assert p.provenance_for(("461",)).snapshot_id == "snap-agras"


# ── 10. The detector roster is data too ─────────────────────────────────


def test_category_comes_from_the_table_not_from_code():
    p = _profile("agras_fy2025")
    assert p.category_for("leverage_debt_to_ebitda") == "leverage"
    assert p.category_for("liquidity_cash_tight") == "liquidity"
    with pytest.raises(CP.UnknownDetectorError):
        p.category_for("invented_detector")


def test_detector_ids_are_stable_and_complete():
    p = _profile("agras_fy2025")
    ids = p.detector_ids()
    assert ids == tuple(sorted(ids))
    assert set(ids) == set(CP.load_catalog().detectors)
    assert p.detector_ids() == _profile("eei_dec_2025").detector_ids()


def test_applicable_detectors_differ_by_company_and_the_rest_are_explained():
    agras = _profile("agras_fy2025")
    carniprod = _profile("carniprod_fy2025")
    assert set(agras.applicable_detector_ids()) != \
           set(carniprod.applicable_detector_ids())
    for detector_id in carniprod.detector_ids():
        verdict = carniprod.applies(detector_id)
        assert verdict.reason, detector_id       # never a silent skip
