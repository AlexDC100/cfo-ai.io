"""IR invariants over the golden corpus — N1, N2 coverage closure, N6.

Companion to tests/engine/test_frontends.py (the Phase-1 N2 keystone
suite). That file proves the FORWARD direction corpus-wide
(parser-direct legacy structures == derive_legacy(front_end.parse));
this file locks the IR's own stability guarantees over the SAME inputs:

  N1 — for EVERY corpus input parsed via its front-end:
       · the 'ir1' wire shape round-trips byte-stably
         (serialize → deserialize → serialize is byte-identical),
       · content_hash is stable across two independent runs of the
         same bytes AND across the round trip,
       · the ROUND-TRIPPED doc derives the identical legacy view
         (closing the reverse direction test_frontends only spot-checks
         on four cases),
       · the scanned-PDF case — where parse() must FAIL — fails
         deterministically (identical typed error twice).

  N2 coverage closure — an explicit census that the two suites together
       exercise all 17 corpus cases and both directions, so a new
       corpus case must be wired in deliberately.

  N6 — currency-scale fixtures: HUF(0) / RON(2) / KWD(3) Money flows
       through serialize/deserialize with no scale corruption, and a
       mixed-currency atom set is rejected by the front-end contract
       guard (`engine.frontends.registry.require_single_currency`) with
       the typed FrontEndError.

NO LIVE API CALLS: the AI-lane case adapts the recorded strict-JSON
mock response bytes; no client is ever constructed.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, List, Tuple

import pytest
import yaml

import engine.country_packs.ro_romania  # noqa: F401 — registers RomaniaPack
from engine.country_packs.ro_romania import pdf_ingester as _pdf
from engine.frontends import derive_legacy, resolve_front_end
from engine.frontends.registry import require_single_currency
from engine.frontends.saga10 import FrontEndError
from engine.ir import (
    AccountAtom,
    DocHeader,
    DocumentTotals,
    LedgerDoc,
    Money,
    Provenance,
    SourceRef,
    content_hash,
    deserialize,
    serialize,
)


REPO = Path(__file__).resolve().parents[2]
CORPUS = REPO / "corpus"

DETERMINISTIC_PARSERS = (
    "saga_10_col", "saga_compact_6_col", "generic_4_col", "csv", "pdf_positional",
)


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


def _input_path(case_id: str) -> Path:
    candidates = sorted((CORPUS / case_id).glob("input.*"))
    assert len(candidates) == 1
    return candidates[0]


def _blob(doc: LedgerDoc) -> str:
    """The doc's canonical wire bytes (ascii canonical JSON — the same
    normalization content_hash uses, minus the volatile-key strip)."""
    return json.dumps(
        serialize(doc), sort_keys=True, separators=(",", ":"), ensure_ascii=True
    )


def _canon(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, ensure_ascii=False, allow_nan=False)


def _hu_mock_case() -> Tuple[bytes, dict]:
    """The AI-lane corpus case as front-end input: the recorded extract
    mock IS the document being adapted (no model, ever); the currency
    comes from the recorded format_detect response, like production."""
    mocks = json.loads(
        (CORPUS / "hu_ai_lane" / "mock_model_responses.json").read_text(
            encoding="utf-8"
        )
    )
    currency = str(json.loads(mocks["format_detect"])["currency"])
    hints = {"jurisdiction": "HU", "currency": currency, "filename": "input.csv"}
    return mocks["extract"].encode("utf-8"), hints


# ── N2 coverage closure ────────────────────────────────────────────────


def test_n2_and_n1_cover_all_seventeen_corpus_cases() -> None:
    """The corpus census: 17 cases, every one exercised by BOTH suites —
    the deterministic sweep (15), the AI-lane extract case, and the
    scanned-PDF failure case. Growing the corpus (or introducing a new
    expected_parser value) must extend the suites deliberately; it can
    never fall through silently."""
    assert len(ALL_CASES) == 17, "corpus changed size — extend the IR suites"
    parsers = {p for _, p in ALL_CASES}
    assert parsers == set(DETERMINISTIC_PARSERS) | {"hu_ai_lane", "ro_llm_fallback"}
    assert len(DET_CASES) == 15
    non_det = {c for c, p in ALL_CASES if p not in DETERMINISTIC_PARSERS}
    assert non_det == {"hu_ai_lane", "llm_fallback_scanned_pdf"}


# ── N1: round-trip byte-stability + content_hash stability, all lanes ──


@pytest.mark.parametrize("case_id,parser", DET_CASES, ids=[c for c, _ in DET_CASES])
def test_n1_roundtrip_and_hash_stability_deterministic(case_id: str, parser: str) -> None:
    input_path = _input_path(case_id)
    content = input_path.read_bytes()
    hints = {"filename": input_path.name}
    front_end = resolve_front_end(parser)

    doc_a, _ = front_end.parse(content, dict(hints))
    doc_b, _ = front_end.parse(content, dict(hints))  # second run, same bytes

    # Wire round trip is byte-identical.
    payload = serialize(doc_a)
    blob = _blob(doc_a)
    round_tripped = deserialize(payload)
    assert _blob(round_tripped) == blob

    # Two independent runs of the same bytes serialize AND hash identically.
    assert _blob(doc_b) == blob
    assert content_hash(doc_a) == content_hash(doc_b)
    assert content_hash(round_tripped) == content_hash(doc_a)

    # Contract: one currency per front-end-emitted document.
    require_single_currency(doc_a)

    # Reverse direction, corpus-wide: the ROUND-TRIPPED doc derives the
    # identical legacy view (rows + extraction + recomputed anchor).
    view_direct = derive_legacy(doc_a)
    view_rt = derive_legacy(round_tripped)
    assert _canon([dict(r) for r in view_rt.tb_rows]) == \
        _canon([dict(r) for r in view_direct.tb_rows])
    assert _canon(view_rt.tb_rows.extraction) == _canon(view_direct.tb_rows.extraction)
    assert _canon(view_rt.tb_rows.source_anchor) == \
        _canon(view_direct.tb_rows.source_anchor)


def test_n1_roundtrip_and_hash_stability_hu_ai_lane() -> None:
    """N1 for the AI-lane extract front-end over the corpus mock bytes
    (mapping fidelity against run_extract is the N2 half, pinned in
    test_frontends.test_n2_equivalence_hu_ai_lane_extract)."""
    data, hints = _hu_mock_case()
    front_end = resolve_front_end("llm_extract")

    doc_a, _ = front_end.parse(data, dict(hints))
    doc_b, _ = front_end.parse(data, dict(hints))

    payload = serialize(doc_a)
    blob = _blob(doc_a)
    round_tripped = deserialize(payload)
    assert _blob(round_tripped) == blob
    assert _blob(doc_b) == blob
    assert content_hash(doc_a) == content_hash(doc_b)
    assert content_hash(round_tripped) == content_hash(doc_a)

    require_single_currency(doc_a)
    assert doc_a.header.currency == "HUF"

    view_direct = derive_legacy(doc_a)
    view_rt = derive_legacy(round_tripped)
    assert _canon(view_rt.rows) == _canon(view_direct.rows)
    assert _canon(view_rt.totals_debit) == _canon(view_direct.totals_debit)
    assert _canon(view_rt.totals_credit) == _canon(view_direct.totals_credit)


def test_n1_scanned_pdf_failure_is_deterministic() -> None:
    """The corpus case whose parse MUST fail (image-only PDF, no text
    layer): N1 stability here means the refusal itself is stable — the
    identical typed error, with the identical canonical user_message,
    on two runs of the same bytes."""
    input_path = _input_path("llm_fallback_scanned_pdf")
    content = input_path.read_bytes()
    front_end = resolve_front_end("pdf_positional")

    with pytest.raises(_pdf.PdfIngestError) as first:
        front_end.parse(content, {"filename": input_path.name})
    with pytest.raises(_pdf.PdfIngestError) as second:
        front_end.parse(content, {"filename": input_path.name})
    assert first.value.user_message == second.value.user_message
    assert str(first.value) == str(second.value)


# ── N6: currency scales through the IR + the mixed-currency guard ──────


def _mech_atom(atom_id: str, code: str, **slots: Any) -> AccountAtom:
    return AccountAtom(
        atom_id=atom_id,
        account_code=code,
        label="acct %s" % code,
        provenance=Provenance.mechanical(SourceRef.pipeline_stage("test:n6")),
        **slots
    )


# (currency, decimal text, expected minor units, expected scale)
_SCALE_FIXTURES = [
    ("RON", "1234.56", 123456, 2),
    ("HUF", "37600000", 37600000, 0),
    ("KWD", "12.345", 12345, 3),
]


@pytest.mark.parametrize(
    "currency,text,minor,scale", _SCALE_FIXTURES,
    ids=["%s_scale%d" % (c, s) for c, _, _, s in _SCALE_FIXTURES],
)
def test_n6_currency_scale_flows_through_ir_uncorrupted(
    currency: str, text: str, minor: int, scale: int
) -> None:
    """HUF(0) / RON(2) / KWD(3) Money survives serialize → deserialize
    with amount_minor AND scale verbatim — no re-scaling, no drift —
    and displays back to the exact source decimal string."""
    money = Money.from_decimal_str(currency, text)
    assert (money.amount_minor, money.scale) == (minor, scale)

    doc = LedgerDoc(
        header=DocHeader(
            jurisdiction="RO",
            currency=currency,
            document_totals=DocumentTotals(
                closing_debit=money, closing_credit=Money.zero(currency)
            ),
        ),
        atoms=(
            _mech_atom(
                "a1", "5121",
                closing_debit=money,
                closing_credit=Money.zero(currency),
            ),
        ),
    )
    require_single_currency(doc)

    payload = serialize(doc)
    wire = payload["atoms"][0]["closing_debit"]
    assert wire == {"currency": currency, "amount_minor": minor, "scale": scale}
    zero_wire = payload["atoms"][0]["closing_credit"]
    assert zero_wire == {"currency": currency, "amount_minor": 0, "scale": scale}
    assert payload["header"]["document_totals"]["closing_debit"] == wire

    round_tripped = deserialize(payload)
    atom = round_tripped.atoms[0]
    assert atom.closing_debit == money
    assert (atom.closing_debit.amount_minor, atom.closing_debit.scale) == (minor, scale)
    assert atom.closing_debit.to_decimal_str() == text
    assert atom.closing_credit == Money.zero(currency)
    totals = round_tripped.header.document_totals
    assert totals.closing_debit == money

    assert _blob(round_tripped) == _blob(doc)
    assert content_hash(round_tripped) == content_hash(doc)


def test_n6_mixed_scale_same_currency_stays_legal() -> None:
    """The per-document scale override is real: one HUF document may
    carry scale-0 whole-forint cells AND a scale-2 fractional cell
    (float_to_money's documented hook). The guard must NOT reject it —
    it polices currency, never scale."""
    doc = LedgerDoc(
        header=DocHeader(jurisdiction="HU", currency="HUF"),
        atoms=(
            _mech_atom("a1", "381", closing_debit=Money.from_minor("HUF", 37600000)),
            _mech_atom("a2", "384", closing_debit=Money.from_minor("HUF", 12345, scale=2)),
        ),
    )
    require_single_currency(doc)  # must not raise
    round_tripped = deserialize(serialize(doc))
    assert round_tripped.atoms[0].closing_debit.scale == 0
    assert round_tripped.atoms[1].closing_debit.scale == 2
    assert _blob(round_tripped) == _blob(doc)


def test_n6_mixed_currency_atom_set_rejected_typed() -> None:
    """A mixed-currency atom set violates the front-end contract and is
    rejected with the typed FrontEndError naming the offender."""
    doc = LedgerDoc(
        header=DocHeader(jurisdiction="RO", currency="RON"),
        atoms=(
            _mech_atom("a1", "5121", closing_debit=Money.from_decimal_str("RON", "10.00")),
            _mech_atom("a2", "401", closing_credit=Money.from_decimal_str("HUF", "5")),
        ),
    )
    with pytest.raises(FrontEndError, match="mixed-currency"):
        require_single_currency(doc)
    with pytest.raises(FrontEndError, match=r"a2\.closing_credit carries HUF"):
        require_single_currency(doc)


def test_n6_mixed_currency_document_totals_rejected_typed() -> None:
    """The guard covers the verbatim totals row too, not just atoms."""
    doc = LedgerDoc(
        header=DocHeader(
            jurisdiction="RO",
            currency="RON",
            document_totals=DocumentTotals(
                closing_debit=Money.from_decimal_str("KWD", "1.000")
            ),
        ),
        atoms=(
            _mech_atom("a1", "5121", closing_debit=Money.from_decimal_str("RON", "10.00")),
        ),
    )
    with pytest.raises(FrontEndError, match="document_totals.closing_debit carries KWD"):
        require_single_currency(doc)


def test_n6_guard_rejects_non_ledgerdoc() -> None:
    with pytest.raises(FrontEndError, match="takes a LedgerDoc"):
        require_single_currency({"header": {}})
