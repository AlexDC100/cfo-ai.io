"""Phase-1 front-end adapters — N2 equivalence over the golden corpus.

THE KEYSTONE SUITE of the compiler restructure's Phase 1: for every
corpus input, the legacy structures the current pipeline consumes must
be reproducible BIT-FOR-BIT from the LedgerDoc IR emitted by the
front-end adapters:

    parser-direct legacy structures == derive_legacy(front_end.parse(bytes))

Compared per deterministic case (canonical JSON, floats via their exact
shortest repr — a single ulp of drift fails):

  * the 10-key tb_rows dicts,
  * the `.extraction` block,
  * the `.source_anchor` block (recomputed by the REAL
    compute_source_anchor from reconstructed inputs, then enriched by
    the REAL pack attach_closing_result seam),
  * the assemble-shape accounts + unmapped/excluded telemetry,
  * the statutory 121 anchor and the source-imbalance telemetry.

The AI-lane corpus case compares the llm front-end against the REAL
`run_extract` coercion (through the lane's injectable-client seam,
zero live calls); the scanned-PDF fallback case proves FAILURE
equivalence (the wrapped ingester refuses the bytes with the identical
canonical error through both paths — the RO freeform LLM fallback that
then engages in production is NOT a Phase-1 front-end; its adapter
lands with the cutover phase).

Also here (Part B item 6): the mixed-provenance groundwork test for
`engine.ir.has_llm_atoms` — the data-keyed hook the 'llm => never
BALANCED' serving cap re-keys onto at cutover.

NO LIVE API CALLS anywhere in this suite: model-adjacent paths run
exclusively through scripted/echo clients.
"""
from __future__ import annotations

import json
from dataclasses import asdict
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Dict, List, Tuple

import pytest
import yaml

import engine.country_packs.ro_romania  # noqa: F401 — registers RomaniaPack
from engine.core.country_pack_registry import get_pack
from engine.country_packs.ro_romania import pdf_ingester as _pdf
from engine.country_packs.ro_romania import trial_balance_parser as tbp
from engine.ai_lane import extract as _extract_mod
from engine.ai_lane import format_detect as _format_mod

from engine.frontends import (
    FRONT_ENDS,
    FrontEndError,
    derive_legacy,
    float_to_money,
    front_end_specs,
    money_to_float,
    resolve_front_end,
)
from engine.frontends.saga10 import repr_of
from engine.ir import (
    AccountAtom,
    DocHeader,
    LedgerDoc,
    Money,
    Provenance,
    SourceRef,
    content_hash,
    deserialize,
    has_llm_atoms,
    serialize,
)


REPO = Path(__file__).resolve().parents[2]
CORPUS = REPO / "corpus"

DETERMINISTIC_PARSERS = (
    "saga_10_col", "saga_compact_6_col", "generic_4_col", "csv", "pdf_positional",
)


def _canon(obj: Any) -> str:
    """Canonical JSON for bit-exact comparison. Floats serialize via
    their shortest repr, so a single ulp of drift is a diff; allow_nan
    False makes any NaN/inf leak a loud failure."""
    return json.dumps(obj, sort_keys=True, ensure_ascii=False, allow_nan=False)


def _discover() -> List[Tuple[str, str]]:
    cases: List[Tuple[str, str]] = []
    for case_dir in sorted(CORPUS.iterdir()):
        if not case_dir.is_dir() or case_dir.name.startswith("_"):
            continue
        meta_path = case_dir / "meta.yaml"
        if not meta_path.is_file():
            continue
        meta = yaml.safe_load(meta_path.read_text(encoding="utf-8"))
        cases.append((case_dir.name, str(meta["expected_parser"])))
    return cases


ALL_CASES = _discover()
DET_CASES = [(c, p) for c, p in ALL_CASES if p in DETERMINISTIC_PARSERS]

# Corpus cases that produce no LedgerDoc IR at all. The public-summary
# lane reads summary-level PUBLISHED FILINGS (revenue/net result/
# employees), not a trial balance: it has no front-end, no IR, and no
# cents to sweep, so it is out of scope for both the N2 equivalence
# sweep and the N1 round-trip suite. Named explicitly — per the census
# doctrine, a new expected_parser must be wired deliberately here rather
# than fall through silently.
NON_IR_PARSERS = {"public_summary"}
TB_CASES = [(c, p) for c, p in ALL_CASES if p not in NON_IR_PARSERS]


def test_corpus_is_fully_covered():
    """Every corpus case is accounted for by exactly one branch — the
    deterministic N2 sweep, the AI-lane extract case, the scanned-PDF
    failure-equivalence case, or the explicit no-IR exclusion. A new
    expected_parser value must be wired here deliberately, never
    skipped silently."""
    assert len(ALL_CASES) == 18, "corpus changed size — extend this suite"
    assert len(TB_CASES) == 17, "trial-balance corpus changed size"
    covered = (set(DETERMINISTIC_PARSERS) | {"hu_ai_lane", "ro_llm_fallback"}
               | NON_IR_PARSERS)
    assert {p for _, p in ALL_CASES} <= covered
    assert {p for _, p in TB_CASES} <= covered - NON_IR_PARSERS


def _input_path(case_id: str) -> Path:
    candidates = sorted((CORPUS / case_id).glob("input.*"))
    assert len(candidates) == 1
    return candidates[0]


def _parse_direct(parser: str, content: bytes, name: str) -> Any:
    pack = get_pack("RO")
    if parser == "csv":
        return pack.parse_trial_balance_csv(content, name)
    return pack.parse_trial_balance(content, name)


# ── N2 equivalence: deterministic lanes, full corpus ───────────────────


@pytest.mark.parametrize(
    "case_id,parser", DET_CASES, ids=[c for c, _ in DET_CASES]
)
def test_n2_equivalence_deterministic(case_id: str, parser: str) -> None:
    input_path = _input_path(case_id)
    content = input_path.read_bytes()
    pack = get_pack("RO")

    direct = _parse_direct(parser, content, input_path.name)

    front_end = resolve_front_end(parser)
    doc, diagnostics = front_end.parse(content, {"filename": input_path.name})
    view = derive_legacy(doc)

    # 1. tb_rows — the 10-key dicts, bit-for-bit.
    assert _canon([dict(r) for r in view.tb_rows]) == _canon([dict(r) for r in direct])

    # 2. extraction block.
    assert _canon(view.tb_rows.extraction) == _canon(direct.extraction)

    # 3. source_anchor — recomputed from the reconstructed inputs by the
    #    REAL compute_source_anchor + the REAL pack closing_result seam,
    #    compared against the parser-direct anchor verbatim (this is
    #    what proves the anchor INPUTS were captured faithfully).
    assert _canon(view.tb_rows.source_anchor) == _canon(direct.source_anchor)

    # 4. assemble-shape rows + census telemetry.
    direct_shape = pack.accounts_to_assemble_shape(direct)
    derived_shape = view.assemble_shape
    assert _canon(list(derived_shape)) == _canon(list(direct_shape))
    assert _canon(derived_shape.unmapped) == _canon(direct_shape.unmapped)
    assert _canon(derived_shape.excluded) == _canon(direct_shape.excluded)

    # 5. the two other pack-seam consumers of tb_rows.
    assert _canon(pack.compute_statutory_net_profit_anchor(view.tb_rows)) == _canon(
        pack.compute_statutory_net_profit_anchor(direct)
    )
    assert _canon(pack.compute_source_imbalance(view.tb_rows)) == _canon(
        pack.compute_source_imbalance(direct)
    )

    # Contract sanity: mechanical lane, no llm atoms, diagnostics present.
    assert not has_llm_atoms(doc)
    assert doc.header.source_meta["front_end"].endswith("@" + tbp.PARSER_VERSION)
    assert any(d["code"] == "cell_provenance_unavailable" for d in diagnostics)


@pytest.mark.parametrize(
    "case_id,parser",
    [(c, p) for c, p in DET_CASES if c in ("saga_10_col", "generic_4_col",
                                           "saga_compact_6_col", "csv")],
    ids=[c for c, _ in DET_CASES if c in ("saga_10_col", "generic_4_col",
                                          "saga_compact_6_col", "csv")],
)
def test_ir_serialization_roundtrip_and_determinism(case_id: str, parser: str) -> None:
    """The built docs live in the 'ir1' wire shape: serialize →
    deserialize → serialize is byte-identical, and two independent
    parses of the same bytes hash identically (content_hash)."""
    input_path = _input_path(case_id)
    content = input_path.read_bytes()
    front_end = resolve_front_end(parser)

    doc_a, _ = front_end.parse(content, {"filename": input_path.name})
    doc_b, _ = front_end.parse(content, {"filename": input_path.name})

    payload = serialize(doc_a)
    blob = json.dumps(payload, sort_keys=True)
    assert json.dumps(serialize(deserialize(payload)), sort_keys=True) == blob
    assert content_hash(doc_a) == content_hash(doc_b)
    # And the round-tripped doc still derives the same legacy rows.
    assert _canon([dict(r) for r in derive_legacy(deserialize(payload)).tb_rows]) == \
        _canon([dict(r) for r in derive_legacy(doc_a).tb_rows])


def test_float_noise_rides_diagnosed_override() -> None:
    """The corpus realestate workbook stores genuine float noise in a
    true numeric cell (21200.02000000002 — 11 fractional digits, beyond
    Money's scale ceiling). The adapter must diagnose it, carry the
    exact repr in source_meta, and STILL reproduce the legacy float
    bit-for-bit (asserted by the N2 sweep; here we pin the mechanism)."""
    input_path = _input_path("saga_10_col_realestate")
    doc, diagnostics = resolve_front_end("saga_10_col").parse(
        input_path.read_bytes(), {"filename": input_path.name}
    )
    overrides = doc.header.source_meta["float_repr_overrides"]
    flat = {
        (atom_id, field): text
        for atom_id, fields in overrides.items()
        for field, text in fields.items()
    }
    assert ("r00020:231102", "si_d") in flat
    assert flat[("r00020:231102", "si_d")] == "21200.02000000002"
    assert any(d["code"] == "float_repr_override" for d in diagnostics)


# ── ABSENT vs ZERO semantics ───────────────────────────────────────────


def test_generic4_absent_pairs_and_present_zero() -> None:
    """generic_4_col carries ONLY the closing pair: opening/period slots
    must be ABSENT (None) — the format lacks those columns — while a
    stated 0,00 closing cell must be ZERO Money, never None."""
    csv_bytes = (
        "Cont;Denumire cont;Debit;Credit\n"
        "1012;Capital subscris varsat;0,00;5000,00\n"
        "5121;Conturi la banci in lei;5000,00;0,00\n"
        "TOTAL;;5000,00;5000,00\n"
    ).encode("utf-8")
    doc, _ = resolve_front_end("csv").parse(csv_bytes, {"filename": "mini.csv"})
    assert doc.header.source_meta["extraction"]["source_format"] == "generic_4_col"

    by_code = {a.account_code: a for a in doc.atoms}
    capital = by_code["1012"]
    # Format lacks opening + period pairs → ABSENT.
    assert capital.opening_debit is None and capital.opening_credit is None
    assert capital.period_debit is None and capital.period_credit is None
    # Present-but-zero → ZERO Money; stated value → exact Money.
    assert capital.closing_debit == Money.zero("RON")
    assert capital.closing_credit == Money.from_decimal_str("RON", "5000.00")
    # No cumulative side-channel for a closing-only format.
    assert dict(doc.header.source_meta["rc_pair"]) == {}
    assert doc.header.source_meta["pairs_present"]["si"] is False
    assert doc.header.source_meta["pairs_present"]["sf"] is True

    # The file's own totals row rides document_totals verbatim (closing pair).
    totals = doc.header.document_totals
    assert totals is not None
    assert totals.closing_debit == Money.from_decimal_str("RON", "5000.00")
    assert totals.opening_debit is None  # totals row has no opening columns


def test_saga6_closing_is_absent_pre_synthesis() -> None:
    """Layout B has no Solduri-finale block: the parser synthesizes sf
    from the si+rl identity. In the IR the closing slots are ABSENT and
    the synthesis is re-derived — proven lossless by the N2 sweep; here
    we pin the encoding itself."""
    input_path = _input_path("saga_compact_6_col")
    doc, _ = resolve_front_end("saga_compact_6_col").parse(
        input_path.read_bytes(), {"filename": input_path.name}
    )
    assert doc.header.source_meta["synthesized_sf"] is True
    assert all(a.closing_debit is None and a.closing_credit is None for a in doc.atoms)
    # The si/rl pairs ARE carried (the format has them).
    assert all(a.opening_debit is not None and a.period_debit is not None
               for a in doc.atoms)
    # The cumulative pair rides the side-channel for value-bearing rows.
    assert len(doc.header.source_meta["rc_pair"]) > 0


def test_pdf_carries_split_rulaj_pairs() -> None:
    """The PDF lane's legacy r_d/r_c are FLOAT SUMS (prec + cur) that
    are frequently not exact-decimal-representable; the adapter must
    carry the file's own two pairs (cur in the period slots, prec in
    the side-channel) so derive_legacy reproduces the sum bit-for-bit
    by redoing the identical addition (asserted by the N2 sweep)."""
    input_path = _input_path("pdf_positional")
    doc, _ = resolve_front_end("pdf_positional").parse(
        input_path.read_bytes(), {"filename": input_path.name}
    )
    meta = doc.header.source_meta
    assert len(meta["rulaj_prec"]) > 0
    assert len(meta["rc_pair"]) > 0
    assert meta["pairs_present"] is None  # legacy anchor ran with defaults
    assert doc.header.document_totals is None  # PDF totals lines are skip-filtered
    assert meta["extraction"]["source_format"] == "pdf_positional"


# ── AI-lane extract case (hu_ai_lane) ──────────────────────────────────


class _ScriptedClient:
    """The lane's injectable-client seam (mirrors corpus_replay's
    ScriptedLaneClient): responses consumed in call order."""

    def __init__(self, responses: List[str]) -> None:
        outer = self

        class _Messages:
            def __init__(self) -> None:
                self.calls: List[Dict[str, Any]] = []

            def create(self, **kwargs: Any) -> Any:
                self.calls.append(kwargs)
                if not outer._responses:
                    raise AssertionError("scripted client ran out of responses")
                return SimpleNamespace(content=[
                    SimpleNamespace(type="text", text=outer._responses.pop(0))
                ])

        self._responses = list(responses)
        self.messages = _Messages()


def test_n2_equivalence_hu_ai_lane_extract() -> None:
    """N2 for the AI lane's extract stage: the recorded strict-JSON
    response parsed by the REAL run_extract (scripted client, zero live
    calls) vs derive_legacy(llm front-end over the same bytes)."""
    case_dir = CORPUS / "hu_ai_lane"
    mocks = json.loads(
        (case_dir / "mock_model_responses.json").read_text(encoding="utf-8")
    )

    client = _ScriptedClient([mocks["format_detect"], mocks["extract"]])
    fmt = _format_mod.run_format_detect(
        "", jurisdiction="HU", filename="input.csv", client=client
    )
    extract_result = _extract_mod.run_extract(
        "", fmt, jurisdiction="HU", filename="input.csv", client=client
    )
    direct_rows = [asdict(r) for r in extract_result.rows]

    front_end = resolve_front_end("llm_extract")
    doc, diagnostics = front_end.parse(
        mocks["extract"].encode("utf-8"),
        {"jurisdiction": "HU", "currency": fmt.currency, "filename": "input.csv"},
    )
    view = derive_legacy(doc)

    assert _canon(view.rows) == _canon(direct_rows)
    assert _canon(view.totals_debit) == _canon(extract_result.totals_debit)
    assert _canon(view.totals_credit) == _canon(extract_result.totals_credit)

    # Provenance: every atom is llm — the mixed-provenance cap hook fires.
    assert has_llm_atoms(doc)
    assert all(a.provenance.method == "llm" for a in doc.atoms)
    assert doc.header.currency == "HUF"
    # The file's own totals row rides document_totals verbatim.
    assert doc.header.document_totals is not None
    assert money_to_float(doc.header.document_totals.closing_debit) == \
        extract_result.totals_debit
    assert any(d["code"] == "cell_provenance_unavailable" for d in diagnostics)


def test_llm_extract_row_form_mapping() -> None:
    """The documented row->atom mapping: debit/credit are closing sides
    (null → ABSENT, 0 → ZERO); balance-only rows land on the closing
    side their sign selects and reconstruct verbatim; degenerate
    both-form rows lose nothing; all-null rows carry no Money at all."""
    payload = {
        "rows": [
            {"code": "1", "label": "sides", "debit": 100.5, "credit": None, "balance": None},
            {"code": "2", "label": "zero-side", "debit": 0, "credit": 7.25, "balance": None},
            {"code": "3", "label": "bal-pos", "debit": None, "credit": None, "balance": 12.75},
            {"code": "4", "label": "bal-neg", "debit": None, "credit": None, "balance": -3.5},
            {"code": "5", "label": "both", "debit": 1.0, "credit": None, "balance": 9.0},
            {"code": "6", "label": "empty", "debit": None, "credit": None, "balance": None},
        ],
        "totals_row": {"debit": 101.5, "credit": 7.25},
    }
    doc, _ = resolve_front_end("llm_extract").parse(
        json.dumps(payload).encode("utf-8"), {"jurisdiction": "HU", "currency": "EUR"}
    )
    by_code = {a.account_code: a for a in doc.atoms}
    assert by_code["1"].closing_debit == Money.from_decimal_str("EUR", "100.5")
    assert by_code["1"].closing_credit is None            # null side → ABSENT
    assert by_code["2"].closing_debit == Money.zero("EUR")  # stated 0 → ZERO
    assert by_code["3"].closing_debit == Money.from_decimal_str("EUR", "12.75")
    assert by_code["3"].closing_credit is None
    assert by_code["4"].closing_credit == Money.from_decimal_str("EUR", "3.5")
    assert by_code["4"].closing_debit is None
    assert by_code["6"].closing_debit is None and by_code["6"].closing_credit is None

    view = derive_legacy(doc)
    assert view.rows == [
        {"code": "1", "label": "sides", "debit": 100.5, "credit": None, "balance": None},
        {"code": "2", "label": "zero-side", "debit": 0.0, "credit": 7.25, "balance": None},
        {"code": "3", "label": "bal-pos", "debit": None, "credit": None, "balance": 12.75},
        {"code": "4", "label": "bal-neg", "debit": None, "credit": None, "balance": -3.5},
        {"code": "5", "label": "both", "debit": 1.0, "credit": None, "balance": 9.0},
        {"code": "6", "label": "empty", "debit": None, "credit": None, "balance": None},
    ]
    assert view.totals_debit == 101.5 and view.totals_credit == 7.25


# ── Scanned-PDF fallback case: FAILURE equivalence ─────────────────────


def test_scanned_pdf_fails_identically_through_both_paths() -> None:
    """The image-only PDF has no text layer: the deterministic ingester
    refuses it. The front-end must fail with the IDENTICAL canonical
    error (raised by the parser itself — the failure paths delegate),
    which is exactly the condition under which production then engages
    the RO freeform LLM fallback. That fallback (a {code, name, amount}
    payload, bucket-signed — NOT the extract-stage schema) is not a
    Phase-1 front-end; its adapter lands at cutover."""
    input_path = _input_path("llm_fallback_scanned_pdf")
    content = input_path.read_bytes()
    pack = get_pack("RO")

    with pytest.raises(tbp.ParseError) as direct_error:
        pack.parse_trial_balance(content, input_path.name)
    with pytest.raises(_pdf.PdfIngestError) as frontend_error:
        resolve_front_end("pdf_positional").parse(content, {"filename": input_path.name})
    assert frontend_error.value.user_message == direct_error.value.user_message


# ── Mixed-provenance cap groundwork (Part B item 6) ────────────────────


def _atom(atom_id: str, code: str, method: str) -> AccountAtom:
    return AccountAtom(
        atom_id=atom_id,
        account_code=code,
        label="acc %s" % code,
        provenance=Provenance(
            source_ref=SourceRef.pipeline_stage("test"),
            method=method,
            confidence=1.0 if method == "mechanical" else 0.6,
        ),
        closing_debit=Money.from_minor("RON", 1000),
    )


def test_has_llm_atoms_flags_single_llm_atom_among_mechanical() -> None:
    """Data-keyed never-BALANCED groundwork: ONE llm atom among
    mechanical ones flips the document — the serving cap re-key at
    cutover keys off this helper instead of a lane-level method stamp."""
    header = DocHeader(jurisdiction="RO", currency="RON")
    mixed = LedgerDoc(header=header, atoms=(
        _atom("a1", "5121", "mechanical"),
        _atom("a2", "401", "llm"),
        _atom("a3", "1012", "mechanical"),
    ))
    assert has_llm_atoms(mixed) is True

    all_mechanical = LedgerDoc(header=header, atoms=(
        _atom("a1", "5121", "mechanical"),
        _atom("a3", "1012", "mechanical"),
    ))
    assert has_llm_atoms(all_mechanical) is False
    assert has_llm_atoms(LedgerDoc(header=header)) is False


# ── Registry ───────────────────────────────────────────────────────────


def test_registry_ids_and_specs() -> None:
    assert set(FRONT_ENDS) == {
        "saga_10_col", "saga_compact_6_col", "generic_4_col",
        "csv", "pdf_positional", "llm_extract", "map_guided",
    }
    specs = front_end_specs()
    for format_id in ("saga_10_col", "saga_compact_6_col", "generic_4_col",
                      "csv", "pdf_positional"):
        assert specs[format_id] == "%s@%s" % (format_id, tbp.PARSER_VERSION)
    assert specs["llm_extract"].startswith("llm_extract@")
    # map_guided versions independently of the classic parser: its
    # "parser" is the mechanical map executor, not tb_parser.
    assert specs["map_guided"] == "map_guided@map_guided_v1"
    for format_id, front_end in FRONT_ENDS.items():
        assert front_end.format_id == format_id
        assert resolve_front_end(format_id) is front_end


def test_resolve_front_end_unknown_id() -> None:
    with pytest.raises(FrontEndError, match="statutory_f30_f10"):
        resolve_front_end("statutory_f30_f10")


# ── Exact float bridge unit coverage ───────────────────────────────────


def test_float_to_money_exact_paths() -> None:
    for text, minor, scale in [
        ("1234.56", 123456, 2),
        ("0.0", 0, 2),
        ("-0.05", -5, 2),
        ("21200.0", 2120000, 2),
        ("0.123456789", 123456789, 9),   # 9 frac digits still exact
    ]:
        value = float(text)
        money, override = float_to_money(value, "RON")
        assert override is None
        assert (money.amount_minor, money.scale) == (minor, scale)
        assert money_to_float(money) == value
        assert repr(money_to_float(money)) == repr(value)


def test_float_to_money_currency_scale_floor() -> None:
    # HUF is a 0-decimal currency: integral values stay scale 0 …
    money, override = float_to_money(37600000.0, "HUF")
    assert override is None and (money.amount_minor, money.scale) == (37600000, 0)
    # … but a fractional value overrides the table scale (per-document hook).
    money, override = float_to_money(123.45, "HUF")
    assert override is None and (money.amount_minor, money.scale) == (12345, 2)


def test_float_to_money_override_paths() -> None:
    # Genuine float noise beyond scale 9 → scale-9 Money + exact repr.
    noisy = 21200.02000000002
    money, override = float_to_money(noisy, "RON")
    assert override == "21200.02000000002"
    assert money.scale == 9
    assert money_to_float(money) == 21200.02  # closest sane value
    assert float(override) == noisy           # the bridge restores the bit pattern

    # Negative zero cannot be integer Money → ZERO + '-0.0' override.
    money, override = float_to_money(-0.0, "RON")
    assert override == "-0.0"
    assert money == Money.zero("RON")
    assert repr(float(override)) == "-0.0"

    # Scientific-notation reprs expand exactly.
    tiny = 1.5e-05
    money, override = float_to_money(tiny, "RON")
    assert override is None and (money.amount_minor, money.scale) == (15, 6)
    assert money_to_float(money) == tiny
    assert repr_of(1e16) == "10000000000000000"
