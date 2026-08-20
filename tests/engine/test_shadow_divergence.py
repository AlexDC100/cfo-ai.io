"""SHADOW consistency gate — classify pass == production composition.

Post-Phase-3: production classification is pack-driven, so both lanes
read the SAME CompiledPack through two different CODE PATHS; zero
divergence pins the front-end IR + classify pass against the production
parser/assembler composition (see engine/passes/shadow.py). Locks, over
the SAME inputs:

  · every DETERMINISTIC golden-corpus case (15): the pass lane
    (engine.passes.classify over the front-end IR) reproduces the
    production classification (RomaniaPack.assemble_parsed_tb) with ZERO
    divergence — per-account line assignment AND per-section subtotals
    in cents (comparable form: engine/passes/shadow.py docstring);
  · the RO LLM-fallback corpus case: the mocked extract rows through
    assemble_statements vs pack rule lookup — zero divergence;
  · the HU AI-lane corpus case: WIRED at the Phase-4 cutover (the HU
    pack exists now) — the mocked classify assignments vs the resolved
    HU pack: every line_id a statement-map leaf, and pack code rules
    (notable exacts / confirmed overlays) agree with the model output
    (engine.passes.shadow.shadow_compare_hu_assignments). A pack root
    WITHOUT an HU pack still yields the explicit skip, asserted too;
  · a PROPERTY-SUITE shadow variant: 50 seeded TBs from the existing
    closing-identity generator (tests/engine/test_identity_property.py
    _generate_tb — contra families, bifunctionals on BOTH sides, the
    parser-layer flip families, price differentials, unmapped codes,
    class-8 memo rows, pre/post/mixed closing states) through BOTH
    lanes — zero divergence on every one;
  · classify() contract: {atom_id -> line_id, method 'rule', rule_id,
    confidence 1.0}, unclassified marker, and assignment parity with
    CompiledPack.target_line;
  · the SHADOW_CLASSIFY=1 pipeline probe: logs only — the parsed
    payload is byte-identical with the flag on/off and tb_rows are
    never mutated.

The corpus-case runner is imported FROM scripts/shadow_report.py (by
path — tests/engine is not a package), so the pytest gate and the
operator report can never drift apart.
"""
from __future__ import annotations

import copy
import importlib.util
import logging
import sys
from pathlib import Path

import pytest
import yaml

import engine.country_packs.ro_romania  # noqa: F401 — registers RomaniaPack
from engine.core.country_pack_registry import get_pack
from engine.country_packs.ro_romania import trial_balance_parser as tbp
from engine.ir import DocHeader, LedgerDoc, Money, Provenance, SourceRef, AccountAtom
from engine.packs import load_pack
from engine.passes import (
    METHOD_RULE,
    METHOD_UNCLASSIFIED,
    classify,
)
from engine.passes.shadow import (
    UNCLASSIFIED,
    load_ro_pack,
    render_result,
    shadow_compare_tb,
)

REPO = Path(__file__).resolve().parents[2]
CORPUS = REPO / "corpus"
PACK_DIR = REPO / "packs" / "ro" / "omfp1802-v1"
REPORT_SCRIPT = REPO / "scripts" / "shadow_report.py"
PROPERTY_SUITE = Path(__file__).resolve().parent / "test_identity_property.py"


def load_module_from_path(name: str, path: Path):
    """Script/module loader by path (tests/engine is not a package) —
    same pattern as test_ro_pack.py / test_corpus_replay.py."""
    cached = sys.modules.get(name)
    if cached is not None:
        return cached
    spec = importlib.util.spec_from_file_location(name, str(path))
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def ro_pack():
    return load_pack(PACK_DIR)


@pytest.fixture(scope="module")
def reporter():
    return load_module_from_path("_shadow_report_under_test", REPORT_SCRIPT)


@pytest.fixture(scope="module")
def prop_gen():
    return load_module_from_path("_identity_property_generators", PROPERTY_SUITE)


def _discover_cases():
    det, llm_ro, llm_hu = [], [], []
    for case_dir in sorted(CORPUS.iterdir()):
        meta_path = case_dir / "meta.yaml"
        if not case_dir.is_dir() or not meta_path.is_file():
            continue
        parser = str(yaml.safe_load(meta_path.read_text(encoding="utf-8"))["expected_parser"])
        if parser in ("saga_10_col", "saga_compact_6_col", "generic_4_col",
                      "csv", "pdf_positional"):
            det.append(case_dir.name)
        elif parser == "ro_llm_fallback":
            llm_ro.append(case_dir.name)
        elif parser == "hu_ai_lane":
            llm_hu.append(case_dir.name)
        else:  # pragma: no cover — new lane must be wired deliberately
            raise AssertionError("unknown expected_parser %r in %s" % (parser, case_dir))
    return det, llm_ro, llm_hu


DET_CASES, LLM_RO_CASES, LLM_HU_CASES = _discover_cases()


def test_corpus_coverage_is_exhaustive():
    """Every corpus case is claimed by exactly one branch of this gate —
    a new expected_parser value must be wired here deliberately."""
    assert len(DET_CASES) == 15, DET_CASES
    assert LLM_RO_CASES == ["llm_fallback_scanned_pdf"]
    assert LLM_HU_CASES == ["hu_ai_lane"]


# ── the corpus gate: zero divergence, every case ───────────────────────


@pytest.mark.parametrize("case_id", DET_CASES)
def test_corpus_deterministic_zero_divergence(case_id, reporter, ro_pack):
    outcome = reporter.run_case_shadow(CORPUS / case_id, pack=ro_pack)
    assert outcome.kind == "compared"
    assert outcome.report is not None
    assert outcome.report.green, "\n" + render_result(outcome.report)
    # a green case still compared REAL content
    assert outcome.report.accounts_compared > 0


@pytest.mark.parametrize("case_id", LLM_RO_CASES)
def test_corpus_ro_llm_fallback_zero_divergence(case_id, reporter, ro_pack):
    outcome = reporter.run_case_shadow(CORPUS / case_id, pack=ro_pack)
    assert outcome.kind == "compared"
    assert outcome.report is not None
    assert outcome.report.lane == "llm_accounts"
    assert outcome.report.green, "\n" + render_result(outcome.report)
    assert outcome.report.accounts_compared > 0


@pytest.mark.parametrize("case_id", LLM_HU_CASES)
def test_corpus_hu_ai_lane_pack_agreement(case_id, reporter):
    """Phase 4: the HU pack exists — the shadow COMPARES the case's
    mocked classify assignments against it: every assigned line_id is a
    statement-map leaf, and every code a pack rule covers classifies to
    the SAME line the mock (and with it the golden) pins."""
    outcome = reporter.run_case_shadow(CORPUS / case_id)
    assert outcome.kind == "compared"
    assert outcome.report is not None
    assert outcome.report.lane == "llm_hu_pack"
    assert outcome.report.green, "\n" + render_result(outcome.report)
    assert outcome.report.accounts_compared == 14  # every mocked assignment


@pytest.mark.parametrize("case_id", LLM_HU_CASES)
def test_corpus_hu_ai_lane_skips_explicitly_without_pack(case_id, reporter,
                                                         tmp_path, monkeypatch):
    """A pack root WITHOUT an HU pack (e.g. a stripped deploy) must
    still say so EXPLICITLY — never a silent pass."""
    import shutil as _shutil

    from engine.packs.runtime import invalidate_pack_cache

    root = tmp_path / "packs"
    _shutil.copytree(REPO / "packs" / "ro", root / "ro")
    monkeypatch.setenv("ENGINE_PACKS_ROOT", str(root))
    invalidate_pack_cache()
    try:
        outcome = reporter.run_case_shadow(CORPUS / case_id)
    finally:
        monkeypatch.delenv("ENGINE_PACKS_ROOT", raising=False)
        invalidate_pack_cache()
    assert outcome.kind == "skipped_no_pack"
    assert "HU" in outcome.reason
    assert outcome.green  # skip is green-with-note, never a divergence


# ── property-suite shadow variant: ~50 seeded TBs, both paths ──────────


@pytest.mark.parametrize("case_index", list(range(0, 200, 4)))
def test_property_tbs_zero_divergence(case_index, prop_gen, ro_pack):
    rows, file_totals, _has_unmapped = prop_gen._generate_tb(case_index)
    tb = tbp.TrialBalanceParseResult(
        rows,
        extraction={
            "method": "deterministic",
            "parser_version": tbp.PARSER_VERSION,
            "source_format": "saga_10_col",
            "number_locale": "anglo",
            "sheet": "TB_shadow_property",
            "header_row_index": 0,
        },
        source_anchor=tbp.compute_source_anchor(
            rows,
            file_totals=file_totals,
            pairs_present=None,
            totals_row_index=None if file_totals is None else 0,
            synthesized_sf=False,
        ),
    )
    get_pack("RO").attach_closing_result(tb)
    result = shadow_compare_tb(tb, ro_pack, case_id="prop_%03d" % case_index)
    assert result.green, "\n" + render_result(result)


# ── classify() contract ────────────────────────────────────────────────


def _money(v):
    """Two-decimal string -> exact Money, via the positional constructor
    (currency, amount_minor, scale) — string math, no floats."""
    if v is None:
        return None
    text = str(v)
    sign = -1 if text.startswith("-") else 1
    units, _, frac = text.lstrip("-").partition(".")
    minor = sign * (int(units) * 100 + int((frac + "00")[:2]))
    return Money("RON", minor, 2)


def _atom(atom_id, code, label="", sf_d=None, sf_c=None):
    def money(v):
        return _money(v)
    return AccountAtom(
        atom_id=atom_id,
        account_code=code,
        label=label or ("Cont %s" % code),
        provenance=Provenance.mechanical(SourceRef.pipeline_stage("test:shadow")),
        closing_debit=money(sf_d),
        closing_credit=money(sf_c),
    )


def _doc(atoms):
    return LedgerDoc(
        header=DocHeader(jurisdiction="RO", currency="RON"),
        atoms=tuple(atoms),
    )


def test_classify_layer_contract(ro_pack):
    doc = _doc([
        _atom("a1", "5121", sf_d="100.00", sf_c="0.00"),    # cash, natural side
        _atom("a2", "5121", sf_d="0.00", sf_c="250.00"),    # overdraft -> stDebt
        _atom("a3", "4111", sf_d="0.00", sf_c="10.00"),     # advance received
        _atom("a4", "418", sf_d="0.00", sf_c="37.00"),      # parser-layer flip family
        _atom("a5", "1687", sf_d="0.00", sf_c="5.00"),      # carrier family
        _atom("a6", "121", sf_d="0.00", sf_c="99.00"),      # result control
        _atom("a7", "581", sf_d="0.00", sf_c="0.00"),       # transit, zero
        _atom("a8", "8033", sf_d="7.00", sf_c="0.00"),      # off-balance memo
        _atom("a9", "4675", sf_d="3.00", sf_c="0.00"),      # no rule -> unclassified
    ])
    layer = classify(doc, ro_pack)
    assert layer.pack_hash == ro_pack.pack_hash
    assert len(layer.entries) == len(doc.atoms)
    by_id = layer.by_atom_id()

    # the spec'd mapping: atom_id -> line_id, method 'rule', rule_id, 1.0
    e = by_id["a1"]
    assert (e.line_id, e.method, e.confidence) == ("cash", METHOD_RULE, 1.0)
    assert e.rule_id and not e.side_flipped
    assert by_id["a2"].line_id == "stDebt" and by_id["a2"].side_flipped
    assert by_id["a3"].line_id == "otherCurrentLiab" and by_id["a3"].side_flipped
    assert by_id["a4"].line_id == "otherCurrentLiab" and by_id["a4"].side_flipped
    assert by_id["a5"].line_id == "otherCurrentLiab" and by_id["a5"].side_flipped
    assert by_id["a6"].line_id == "ignore_control"
    assert by_id["a7"].line_id == "ignore_transit"
    assert by_id["a7"].closing_side is None  # zero balance: side undefined
    assert by_id["a8"].line_id == "ignore_offbalance"
    unc = by_id["a9"]
    assert unc.line_id is None and unc.rule_id is None
    assert unc.method == METHOD_UNCLASSIFIED and unc.confidence == 1.0
    assert layer.unclassified_count == 1
    assert layer.classified_count == len(doc.atoms) - 1

    # assignment parity with the pack's own resolver
    for entry in layer.entries:
        expected = ro_pack.target_line(entry.account_code, entry.closing_side)
        assert entry.line_id == expected, entry


def test_classify_layout_b_side_from_opening_period_identity(ro_pack):
    """Closing ABSENT (Layout B): the side comes from the si+rl identity
    — a 5121 whose movements net to credit is an overdraft."""
    money = _money
    atom = AccountAtom(
        atom_id="b1",
        account_code="5121",
        label="Banca",
        provenance=Provenance.mechanical(SourceRef.pipeline_stage("test:shadow")),
        opening_debit=money("100.00"),
        opening_credit=money("0.00"),
        period_debit=money("20.00"),
        period_credit=money("400.00"),
        # closing slots ABSENT on purpose
    )
    layer = classify(_doc([atom]), ro_pack)
    entry = layer.entries[0]
    assert entry.closing_side == "credit"
    assert entry.line_id == "stDebt" and entry.side_flipped


# ── the SHADOW_CLASSIFY=1 probe: logs only, mutates nothing ────────────


def test_pipeline_probe_is_log_only_and_default_off(monkeypatch, caplog):
    from engine.api import pipeline as _pipeline

    input_path = CORPUS / "saga_10_col" / "input.xlsx"
    content = input_path.read_bytes()
    pack = get_pack("RO")
    tb_rows = pack.parse_trial_balance(content, input_path.name)
    shaped = pack.accounts_to_assemble_shape(tb_rows)
    doc = {"id": "doc-shadow-probe", "original_filename": input_path.name}
    anchor = pack.compute_statutory_net_profit_anchor(tb_rows)
    quality = pack.compute_source_imbalance(tb_rows)

    rows_before = copy.deepcopy([dict(r) for r in tb_rows])

    monkeypatch.delenv("SHADOW_CLASSIFY", raising=False)
    parsed_off = _pipeline._deterministic_tb_parsed(doc, tb_rows, shaped, anchor, quality)

    monkeypatch.setenv("SHADOW_CLASSIFY", "1")
    with caplog.at_level(logging.INFO, logger="engine.passes.shadow"):
        parsed_on = _pipeline._deterministic_tb_parsed(doc, tb_rows, shaped, anchor, quality)

    # the probe LOGS (green on the golden corpus) and changes NOTHING
    assert any("[shadow_classify]" in r.getMessage() for r in caplog.records)
    assert any("GREEN" in r.getMessage() for r in caplog.records
               if "[shadow_classify]" in r.getMessage())
    assert parsed_on == parsed_off
    assert [dict(r) for r in tb_rows] == rows_before
