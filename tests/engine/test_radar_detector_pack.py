"""R9 — DETECTORS ARE PACK DATA.

THE ARCHITECTURE RULE THIS FILE ENFORCES

    Adding a Radar detector is AUTHORING A ROW OF YAML.
    It requires ZERO changes to src/engine.

That is a claim about the split between families (arithmetic, in the
engine) and detectors (instances, in the pack), and a claim is only worth
the test that can falsify it. So this module writes a brand-new FICTIONAL
detector — ``zz_fictional_probe``, in a fictional jurisdiction's pack
directory — and drives it through the real runner over a real Romanian
book, then asserts the two properties that make the gate permanent rather
than decorative:

  (a) IT SURFACES. The fictional row produces a finding that passes the
      full seven-element contract, with its threshold pointing at the
      YAML line that produced it.
  (b) THE CHANGE SET IS THE YAML. ``src/engine`` contains no occurrence
      of the fictional detector's id or of its jurisdiction token, so the
      engine reached it through pack DATA and not by name.

It also pins the loader's REFUSALS. A pack that is malformed fails at
load, loudly: a detector with no severity is not a detector with a
default severity, and a row naming a family this build does not carry is
refused rather than skipped — a detector an operator believes is running
must be running.

WHAT THIS FILE CANNOT SEE (TC-11): whether the twelve shipped detectors
are well calibrated. That is measured on real books in
``tests/engine/test_radar_detectors.py`` and
``scripts/measure_radar_detectors.py``.

Python 3.9 — no ``match``, no ``X | Y`` unions.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest
import yaml

from engine.api import _company_profile as CP
from engine.frontends.saga10 import Saga10FrontEnd
from engine.radar import detectors as D
from engine.radar.detectors import pack as PK
from engine.radar.detectors import registry as REG
from engine.radar.detectors import run as RUN

REPO = Path(__file__).resolve().parents[2]
ENGINE_TREE = REPO / "src" / "engine"

#: The fictional jurisdiction and detector. Both tokens are chosen so they
#: can never collide with a real one, and both are scanned for below.
ZZ = "zz"
FICTIONAL_ID = "zz_fictional_probe"


def _real_book():
    fixture = REPO / "tests" / "engine" / "fixtures" / "firm" / "saga_10_col_agras.json"
    captured = json.loads(fixture.read_text(encoding="utf-8"))
    statements = captured["statements"]
    source = REPO / "corpus" / "saga_10_col_agras" / "input.xlsx"
    doc, _notes = Saga10FrontEnd().parse(source.read_bytes())
    bs = statements.get("assembled_bs") or {}
    pl = statements.get("assembled_pl") or {}
    book = D.PeriodBook.from_ledger_doc(
        doc, period_id="agras-fy2025", label="FY2025", ordinal=0, year=2025,
        month=12, days_covered=31,
        basis=D.BasisTotals(total_assets=bs.get("total_assets"),
                            revenue=pl.get("revenue"),
                            source="engine-assembled statements"))
    profile = CP.build_company_profile(statements, period_id=book.period_id)
    return book, profile


#: The whole detector, as a reader of the pack would write it. Nothing in
#: the engine knows this id exists.
FICTIONAL_ROW = {
    "id": FICTIONAL_ID,
    "family": "concentration",
    "label": "A fictional probe on the payables book",
    "scope": "trade payables",
    "category": "concentration",
    "severity": "medium",
    "single_period_valid": True,
    "min_periods": 1,
    "basis": "total_assets",
    "citation": "A fictional rule, authored to prove that authoring one "
                "needs no engine change.",
    "accounts": {"subject": ["401"]},
    "params": {"min_share": 0.20, "min_counterparties": 2},
    "why": "For a {profile_label}, {top_code} carries {share} of the {scope} "
           "balance across {count} analytic accounts; {scope} is {share_with} "
           "of {basis_label} as reported and {share_without} once that one "
           "supplier is removed.",
    "actions": [
        {"imperative": "Request a balance confirmation from {top_code}",
         "artefact": "a signed confirmation of the balance and its due dates",
         "provider": "the supplier"},
        {"imperative": "Recompute the payment cycle without that supplier",
         "artefact": "days payable outstanding on the remaining book",
         "provider": "the finance team"},
    ],
}


@pytest.fixture()
def fictional_root(tmp_path):
    """A packs root carrying ONE fictional jurisdiction with ONE fictional
    detector. No file inside the repository is touched."""
    root = tmp_path / "packs"
    (root / ZZ).mkdir(parents=True)
    path = root / ZZ / PK.PACK_FILENAME
    path.write_text(yaml.safe_dump(
        {"schema_version": PK.SCHEMA_VERSION,
         "pack_id": "zz-fictional-v1",
         "detectors": [FICTIONAL_ROW]},
        sort_keys=False, allow_unicode=True), encoding="utf-8")
    PK.invalidate_cache()
    yield root, path
    PK.invalidate_cache()


# ── (a) the fictional detector surfaces ──────────────────────────────────


def test_a_fictional_detector_added_through_yaml_alone_surfaces(fictional_root):
    root, path = fictional_root
    pack = D.load_pack(ZZ, str(root))
    assert pack.ids() == (FICTIONAL_ID,)

    book, profile = _real_book()
    run = D.run_detectors(pack, D.BookSeries.of([book]), profile)
    assert [c.status for c in run.checks] == [RUN.STATUS_FIRED], [
        (c.status, c.reason) for c in run.checks]

    finding = run.findings[0]
    verdict = finding.verdict()
    assert verdict.surfaced, "; ".join(m.render() for m in verdict.missing)
    assert finding.rule_id == FICTIONAL_ID
    assert finding.severity == "medium"
    # The threshold points at the YAML line that produced it, not at a
    # module constant — a reader who disagrees can open that line.
    assert finding.threshold.source == "%s#detectors.%s.params.min_share" % (
        str(path), FICTIONAL_ID)
    body = finding.render().body
    assert "401" in body
    assert "supplier" in body


def test_the_fictional_detector_is_nowhere_in_the_engine_tree():
    """(b) CHANGE-SET CONTAINMENT. If a future contributor admits a
    detector by editing src/engine, this fails."""
    hits = []
    for path in sorted(ENGINE_TREE.rglob("*.py")):
        text = path.read_text(encoding="utf-8")
        for token in (FICTIONAL_ID, "zz_fictional"):
            if token in text:
                hits.append("%s: %s" % (path.relative_to(REPO), token))
    assert not hits, (
        "the fictional detector reached the engine by name: %s" % hits)


def test_the_shipped_pack_needs_no_engine_module_of_its_own():
    """The engine names FAMILIES, never detectors. A module that mentions a
    shipped detector id would mean the pack had stopped being the
    authority on which detectors exist."""
    shipped = D.load_pack("ro", str(REPO / "packs"))
    hits = []
    for path in sorted(ENGINE_TREE.rglob("*.py")):
        text = path.read_text(encoding="utf-8")
        for spec in shipped.detectors:
            if spec.id in text:
                hits.append("%s names %s" % (path.relative_to(REPO), spec.id))
    assert not hits, hits


# ── the loader's refusals ────────────────────────────────────────────────


def _row(**overrides):
    row = dict(FICTIONAL_ROW)
    row.update(overrides)
    return row


def _parse(rows, version=PK.SCHEMA_VERSION):
    return PK.parse_pack({"schema_version": version, "pack_id": "t",
                          "detectors": rows}, "t.yaml", ZZ)


def test_a_detector_that_does_not_answer_the_cold_start_question_is_refused():
    row = _row()
    del row["single_period_valid"]
    with pytest.raises(PK.DetectorPackError) as exc:
        _parse([row])
    assert "single_period_valid" in str(exc.value)


def test_a_detector_with_an_unknown_severity_is_refused_not_defaulted():
    with pytest.raises(PK.DetectorPackError) as exc:
        _parse([_row(severity="quite bad")])
    assert "severity" in str(exc.value)


def test_a_detector_with_no_action_step_is_refused():
    with pytest.raises(PK.DetectorPackError) as exc:
        _parse([_row(actions=[])])
    assert "an observation" in str(exc.value)


def test_a_duplicate_detector_id_is_refused():
    with pytest.raises(PK.DetectorPackError) as exc:
        _parse([_row(), _row()])
    assert "duplicate" in str(exc.value)


def test_a_pack_written_against_another_schema_is_refused():
    with pytest.raises(PK.DetectorPackError) as exc:
        _parse([_row()], version="radar-detectors/99")
    assert "schema_version" in str(exc.value)


def test_a_row_naming_a_family_this_build_does_not_carry_is_refused_not_skipped():
    pack = _parse([_row(family="telepathy")])
    book, profile = _real_book()
    with pytest.raises(REG.UnknownFamilyError) as exc:
        D.run_detectors(pack, D.BookSeries.of([book]), profile)
    assert "telepathy" in str(exc.value)
    assert "must be running" in str(exc.value)


def test_a_missing_pack_file_refuses_rather_than_reading_as_no_detectors(tmp_path):
    with pytest.raises(PK.DetectorPackError) as exc:
        D.load_pack("nowhere", str(tmp_path))
    assert "different claim from having none that fired" in str(exc.value)


def test_a_parameter_the_row_does_not_declare_names_the_file_to_edit():
    pack = _parse([_row()])
    with pytest.raises(PK.DetectorPackError) as exc:
        pack.get(FICTIONAL_ID).number("min_counterparties_typo")
    assert "declares no parameter" in str(exc.value)


def test_the_jurisdiction_is_a_directory_lookup_and_never_a_comparison(tmp_path):
    """Any jurisdiction with a pack directory resolves through the same
    line of code. Nothing in the package enumerates which ones exist."""
    for token in ("zz", "qq", "xx"):
        assert PK.pack_path(token, str(tmp_path)).endswith(
            "%s/%s" % (token, PK.PACK_FILENAME))
    with pytest.raises(PK.DetectorPackError):
        PK.pack_path("", str(tmp_path))
