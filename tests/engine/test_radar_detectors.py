"""THE TWELVE RADAR DETECTOR FAMILIES, ON REAL BOOKS.

Every number in this file comes from a real Romanian trial balance:
``corpus/saga_10_col_<case>/input.xlsx`` parsed by the production
``saga_10_col`` front end, with the totals a share is taken of read from
the engine-assembled statements captured in
``tests/engine/fixtures/firm/saga_10_col_<case>.json`` (TC-1). Nothing
here is a hand-written fixture.

WHAT THIS FILE CAN AND CANNOT SEE (TC-11)
It reds on: a detector that fires without a quantified impact; a
cold-start run that lets a cross-period family speak; a gap read as a
zero; a distribution family that drops its signal wording; a threshold
that stops coming from the pack; a seasonal build presented as a trend; a
dispersion computed from too few movements; a cycle in days computed
without knowing how many days the movement covers; and the prefix-leaf
rule whose absence made a real counterparty share read 80.1% where the
engine's own line items say 71.8%.

It cannot see: whether a detector is USEFUL. Fire rates over four books
are reported by ``scripts/measure_radar_detectors.py`` with their
intervals — and that script says "N INSUFFICIENT to certify" rather than
printing a rate this checkout cannot support. No second real period of
the same company exists here, so the seven cross-period families are
exercised on spines DERIVED from one real book, exactly the way
``tests/engine/test_findings_multi_period.py`` builds its own: every
denominator is a real number from a real book and one line is moved
period to period.

Python 3.9 — no ``match``, no ``X | Y`` unions.
"""
from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path

import pytest

from engine.api import _company_profile as CP
from engine.api import _finding as F
from engine.frontends.saga10 import Saga10FrontEnd
from engine.radar import detectors as D
from engine.radar.detectors import fam_static as FS
from engine.radar.detectors import result as RES
from engine.radar.detectors import run as RUN

REPO = Path(__file__).resolve().parents[2]
PACKS = str(REPO / "packs")
JUR = "ro"

_CACHE = {}


def load_case(name):
    """One real book: the parsed source document plus the engine's own
    assembled totals for the same period."""
    if name in _CACHE:
        return _CACHE[name]
    fixture = REPO / "tests" / "engine" / "fixtures" / "firm" / (
        "saga_10_col_%s.json" % name)
    captured = json.loads(fixture.read_text(encoding="utf-8"))
    statements = captured["statements"]
    source = REPO / "corpus" / ("saga_10_col_%s" % name) / "input.xlsx"
    doc, _notes = Saga10FrontEnd().parse(source.read_bytes())
    bs = statements.get("assembled_bs") or {}
    pl = statements.get("assembled_pl") or {}
    book = D.PeriodBook.from_ledger_doc(
        doc, period_id="%s-fy2025" % name, label="FY2025", ordinal=0,
        year=2025, month=12, days_covered=31,
        basis=D.BasisTotals(total_assets=bs.get("total_assets"),
                            revenue=pl.get("revenue"),
                            source="engine-assembled statements, %s" % fixture.name))
    profile = CP.build_company_profile(statements, period_id=book.period_id)
    _CACHE[name] = (book, profile, captured)
    return _CACHE[name]


@pytest.fixture(scope="module")
def pack():
    return D.load_pack(JUR, PACKS)


def _spine(base, periods, mutate=None, days=30):
    """A derived spine: N periods of the SAME real book, with one line
    moved. Every other atom is byte-identical to the real one."""
    books = []
    for i, (year, month) in enumerate(periods):
        rows = tuple(mutate(r, i) for r in base.rows) if mutate else base.rows
        books.append(D.PeriodBook(
            period_id="p%d" % i, label="%04d-%02d" % (year, month), ordinal=i,
            currency=base.currency, rows=rows, year=year, month=month,
            basis=base.basis, days_covered=days))
    return D.BookSeries.of(books)


MONTHS6 = [(2025, m) for m in (7, 8, 9, 10, 11, 12)]


def _scaler(prefix, factors, fields=("closing_debit", "closing_credit",
                                     "period_debit", "period_credit")):
    def _mutate(row, i):
        if not row.code.startswith(prefix):
            return row
        factor = factors[i]
        kw = dict((f, getattr(row, f) * factor) for f in fields
                  if getattr(row, f) is not None)
        return replace(row, **kw)
    return _mutate


# ── the pack and the registry ────────────────────────────────────────────


def test_the_pack_declares_all_twelve_families_and_every_one_is_implemented(pack):
    families = sorted(set(spec.family for spec in pack.detectors))
    assert families == sorted(D.registered()), (
        "the pack and the registry disagree: pack %r, registry %r"
        % (families, sorted(D.registered())))
    assert len(families) == 12
    assert len(pack.detectors) == 12


def test_every_declared_detector_answers_the_cold_start_question(pack):
    """`single_period_valid` is required by the loader, so this asserts the
    SHAPE of the answer rather than the loader's diligence: the four
    families the product runs on a first upload are the ones that can be
    computed from one book."""
    single = sorted(s.family for s in pack.detectors if s.single_period_valid)
    assert single == ["assetage", "benford", "concentration", "interco", "round"]


def test_every_threshold_states_the_pack_line_that_produced_it(pack):
    book, profile, _c = load_case("agras")
    run = D.run_detectors(pack, D.BookSeries.of([book]), profile)
    sources = [r.parameter_source for r in run.results if r.applicable]
    assert sources, "no detector produced a reading on a real book"
    for source in sources:
        assert source.endswith(".params.%s" % source.rsplit(".", 1)[-1])
        assert "packs/%s/detectors.yaml#detectors." % JUR in source.replace("\\", "/")


# ── real books ───────────────────────────────────────────────────────────


@pytest.mark.parametrize("case", ["agras", "carniprod", "realestate", "retail"])
def test_every_finding_from_a_real_book_passes_the_seven_element_contract(pack, case):
    book, profile, _c = load_case(case)
    run = D.run_detectors(pack, D.BookSeries.of([book]), profile)
    for finding in run.findings:
        verdict = finding.verdict()
        assert verdict.surfaced, (
            "%s on %s is incomplete: %s"
            % (finding.rule_id, case,
               "; ".join(m.render() for m in verdict.missing)))
        rendered = finding.render()
        assert any(a.code in rendered.body for a in finding.subject.accounts)


def test_the_measured_finding_set_on_the_real_agras_book(pack):
    """The recorded expectation (TC-6). These four rows are what the pack
    and the engine say about one real book; a change to either moves this
    line and has to be argued for."""
    book, profile, _c = load_case("agras")
    run = D.run_detectors(pack, D.BookSeries.of([book]), profile)
    fired = sorted(c.detector_id for c in run.checks if c.status == RUN.STATUS_FIRED)
    assert fired == ["ro_asset_age", "ro_first_digit_conformity",
                     "ro_receivable_concentration", "ro_related_party_exposure"]
    by_id = dict((r.detector_id, r) for r in run.results)
    assert round(by_id["ro_receivable_concentration"].observed, 3) == 0.537
    assert round(by_id["ro_related_party_exposure"].observed, 3) == 0.196
    assert round(by_id["ro_asset_age"].observed, 3) == 0.705


def test_a_counterparty_share_counts_every_sibling_not_only_the_deepest(pack):
    """THE PREFIX-LEAF RULE, pinned on the book that exposed it.

    carniprod carries 4111.01, 4111.03, 4111.21 AND 4118. Taking "the
    deepest rows" drops 4118 — nobody's parent, a sibling — and the
    largest counterparty's share reads 80.1%. The engine's own assembled
    line items say 71.8%, and so does the prefix rule.
    """
    book, _p, captured = load_case("carniprod")
    group = book.select(["411"])
    codes = sorted(r.code for r in group.leaves())
    assert "4118" in codes, codes
    total = sum(abs(r.closing_signed() or 0.0) for r in group.leaves())
    top = max(abs(r.closing_signed() or 0.0) for r in group.leaves())
    assert round(top / total, 3) == 0.718

    items = [i for i in captured["line_items"]
             if str(i.get("ro_account_code", "")).startswith("411")]
    oracle_total = sum(abs(float(i["amount"])) for i in items)
    oracle_top = max(abs(float(i["amount"])) for i in items)
    assert round(oracle_top / oracle_total, 3) == 0.718


# ── the laws ─────────────────────────────────────────────────────────────


def test_cold_start_runs_only_single_period_detectors_and_claims_no_trend(pack):
    book, profile, _c = load_case("agras")
    run = D.run_detectors(pack, D.BookSeries.of([book]), profile)
    assert run.cold_start is True
    for detector_id in run.ran:
        assert pack.get(detector_id).single_period_valid, detector_id
    assert len(run.waiting) == 7
    statement = run.statement()
    assert "No trend is claimed from this history." in statement
    assert "waiting on history" in statement
    for result in run.results:
        assert pack.get(result.detector_id).single_period_valid


def test_the_cold_start_gate_holds_a_detector_that_asks_for_only_one_period(pack):
    """THE COLD-START RULE, ON ITS OWN.

    The shipped rows all declare `min_periods` of 3 or more, so on those
    the history bill alone would hold them and a test written against the
    shipped pack passes with the cold-start rule DELETED — a gate that
    gates nothing (a planted deletion of the rule left the shipped-pack
    assertion green, which is how this test came to exist). The rule only
    carries weight for a row that asks for less history than a
    cross-period claim needs, so that is the row this drives.
    """
    from engine.radar.detectors import pack as PK

    row = {
        "id": "greedy_cross_period_probe",
        "family": "direction",
        "label": "A cross-period detector that asks for one period",
        "scope": "trade receivables",
        "category": "liquidity",
        "severity": "medium",
        "single_period_valid": False,
        "min_periods": 1,
        "basis": "total_assets",
        "citation": "authored to drive the cold-start rule on its own",
        "accounts": {"subject": ["411"]},
        "params": {"measure": "closing", "min_run": 1,
                   "adverse_direction": "up", "min_move_share": 0.0},
        "why": "For a {profile_label}, {codes} moved up.",
        "actions": [{"imperative": "Pull the aged balance for {codes}",
                     "artefact": "the aging schedule",
                     "provider": "the receivables ledger"}],
    }
    greedy = PK.parse_pack(
        {"schema_version": PK.SCHEMA_VERSION, "pack_id": "t",
         "detectors": [row]}, "t.yaml", "zz")
    book, profile, _c = load_case("agras")
    run = D.run_detectors(greedy, D.BookSeries.of([book]), profile)
    assert [c.status for c in run.checks] == [RUN.STATUS_WAITING], [
        (c.status, c.reason) for c in run.checks]
    assert "before any cross-period claim is made" in run.checks[0].reason
    assert not run.results and not run.findings


def test_a_detector_that_fires_without_a_quantified_impact_is_refused():
    with pytest.raises(RES.UnquantifiedFindingError) as exc:
        RES.DetectorResult(detector_id="x", family="round", fired=True,
                           reason="something looks odd")
    assert "not finished" in str(exc.value)


def test_a_gap_truncates_a_run_and_is_never_read_as_a_zero(pack):
    """ABSENT != ZERO. A period whose selector matches no account is a
    GAP: the contiguous tail stops there, and the missing reading does not
    become a zero balance that would look like a collapse."""
    base, profile, _c = load_case("agras")
    series = _spine(base, MONTHS6, _scaler("411", [0.5, 0.6, 0.7, 0.8, 0.9, 1.0]))
    stripped = list(series.books)
    stripped[2] = replace(stripped[2], rows=tuple(
        r for r in stripped[2].rows if not r.code.startswith("411")))
    gapped = D.BookSeries.of(stripped)
    points = gapped.readings(["411"], "closing")
    assert points[2].value is None
    tail = gapped.contiguous_tail(points)
    assert len(tail) == 3
    assert all(p.value is not None for p in tail)
    run = D.run_detectors(pack, gapped, profile, only=["ro_receivables_direction"])
    assert [c.status for c in run.checks] == [RUN.STATUS_NOT_APPLICABLE]
    assert "contiguous" in run.checks[0].reason


def test_a_missing_basis_is_not_applicable_with_a_reason_not_a_zero_share(pack):
    base, profile, _c = load_case("agras")
    blind = replace(base, basis=D.BasisTotals())
    series = D.BookSeries.of([blind])
    run = D.run_detectors(pack, series, profile, only=["ro_related_party_exposure"])
    check = run.checks[0]
    assert check.status == RUN.STATUS_NOT_APPLICABLE
    assert "not served for this period" in check.reason
    assert not run.findings


def test_a_dispersion_needs_the_history_the_pack_declares(pack):
    """A MAD from two movements is not a measurement of spread. The guard
    refuses and names the bill."""
    base, profile, _c = load_case("agras")
    four = _spine(base, MONTHS6[:4], _scaler("3", [0.8, 0.81, 0.8, 1.0]))
    run = D.run_detectors(pack, four, profile, only=["ro_inventory_magnitude"])
    assert run.checks[0].status == RUN.STATUS_WAITING
    six = _spine(base, MONTHS6, _scaler("3", [0.8, 0.81, 0.8, 0.81, 0.8, 1.0]))
    run6 = D.run_detectors(pack, six, profile, only=["ro_inventory_magnitude"])
    assert run6.checks[0].status == RUN.STATUS_FIRED
    assert "median absolute deviations" in run6.checks[0].reason


def test_a_cycle_in_days_refuses_without_the_window_the_flow_covers(pack):
    base, profile, _c = load_case("agras")
    series = _spine(base, MONTHS6, _scaler("411", [0.5] * 5 + [3.0]), days=30)
    fired = D.run_detectors(pack, series, profile, only=["ro_collection_velocity"])
    assert fired.checks[0].status == RUN.STATUS_FIRED
    blind = D.BookSeries.of([replace(b, days_covered=None) for b in series.books])
    run = D.run_detectors(pack, blind, profile, only=["ro_collection_velocity"])
    assert run.checks[0].status == RUN.STATUS_NOT_APPLICABLE
    assert "how many days its movement covers" in run.checks[0].reason


def test_a_seasonal_build_is_not_reported_as_a_trend_break(pack):
    """With two calendar years on the spine and a same-(year, month)
    counterpart present, the reference for a trend claim is THAT period.
    A December build that repeats last December is a season."""
    base, profile, _c = load_case("agras")
    months = [(2024, 11), (2024, 12), (2025, 9), (2025, 10), (2025, 11), (2025, 12)]
    # Rising through the run, but December 2024 already stood where
    # December 2025 does: the same period a year earlier does not agree.
    factors = [0.60, 1.05, 0.70, 0.80, 0.90, 1.00]
    series = _spine(base, months, _scaler("411", factors))
    run = D.run_detectors(pack, series, profile, only=["ro_receivables_direction"])
    assert run.checks[0].status == RUN.STATUS_CLEAR
    assert "same period one year earlier (2024-12)" in run.results[0].reason

    # The same rising run inside ONE calendar year has no counterpart, so
    # the prior period is the reference and the run stands.
    one_year = _spine(base, MONTHS6, _scaler("411", [0.55, 0.62, 0.71, 0.80, 0.90, 1.0]))
    run2 = D.run_detectors(pack, one_year, profile, only=["ro_receivables_direction"])
    assert run2.checks[0].status == RUN.STATUS_FIRED
    assert "the prior period (2025-11)" in run2.results[0].reason


def test_the_two_distribution_families_report_a_signal_and_never_an_accusation(pack):
    book, profile, _c = load_case("agras")
    run = D.run_detectors(pack, D.BookSeries.of([book]), profile,
                          only=["ro_first_digit_conformity",
                                "ro_round_amount_concentration"])
    for spec_id in ("ro_first_digit_conformity", "ro_round_amount_concentration"):
        spec = pack.get(spec_id)
        assert spec.signal_only is True
        assert spec.severity == "low"
    for result in run.results:
        assert FS.SIGNAL_SENTENCE in result.reason
    for finding in run.findings:
        body = finding.render().body
        assert FS.SIGNAL_SENTENCE in body
        for word in ("fraud", "fraudulent", "manipulation", "falsified",
                     "suspicious"):
            assert word not in body.lower(), word


def test_the_first_digit_band_scales_with_the_population_it_measures():
    """A fixed conformity cutoff calibrated on large populations calls
    every small book non-conformant: at n=250 a perfectly Benford
    population already deviates by 0.0149 through sampling alone."""
    assert round(FS.expected_null_mad(250), 4) == 0.0149
    assert FS.expected_null_mad(10000) < FS.expected_null_mad(250)
    with pytest.raises(ValueError):
        FS.expected_null_mad(0)


def test_the_same_books_and_pack_always_produce_the_same_findings(pack):
    book, profile, _c = load_case("retail")
    series = D.BookSeries.of([book])
    first = D.run_detectors(pack, series, profile)
    second = D.run_detectors(pack, series, profile)

    def _shape(run):
        return [(f.rule_id, f.severity,
                 tuple(a.code for a in f.subject.accounts),
                 round(f.threshold.observed, 10),
                 round(f.impact.adjusted, 10),
                 f.render().body)
                for f in D.surfaced(run)]

    assert _shape(first) == _shape(second)
    assert [c.to_payload() for c in first.checks] == [c.to_payload() for c in second.checks]


def test_every_finding_names_the_atoms_it_read_and_the_subject_comes_first(pack):
    book, profile, _c = load_case("agras")
    run = D.run_detectors(pack, D.BookSeries.of([book]), profile)
    assert run.findings
    for finding in run.findings:
        refs = finding.evidence.provenance.line_refs
        assert refs, finding.rule_id
        codes = set(a.code for a in finding.subject.accounts)
        first_code = refs[0].split(":", 1)[1]
        assert first_code in codes, (finding.rule_id, refs[0], codes)
        assert finding.evidence.provenance.source == "ledger_atoms_v1"


def test_every_check_that_ran_is_recorded_whether_it_fired_or_not(pack):
    book, profile, _c = load_case("realestate")
    run = D.run_detectors(pack, D.BookSeries.of([book]), profile)
    assert len(run.checks) == len(pack.detectors)
    statuses = set(c.status for c in run.checks)
    assert RUN.STATUS_WAITING in statuses
    assert RUN.STATUS_CLEAR in statuses
    for check in run.checks:
        assert check.reason.strip(), check.detector_id
