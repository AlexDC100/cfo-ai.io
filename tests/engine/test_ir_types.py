"""Phase 0 IR type gates — engine.ir (Money / LedgerDoc / schema 'ir1').

Locks the operator-spec guarantees for the compiler-restructure IR:

  * Money: exact integer minor units, algebra closed over ONE
    (currency, scale) — mixed operations raise MoneyCurrencyMismatch;
    NO floats on the value path (source-inspection guard + string
    constructors only in these tests).
  * Currency scale data: RON/EUR/USD/GBP=2, HUF=0, KWD/BHD/OMR=3,
    default 2, explicit per-document override wins.
  * ABSENT (None) vs ZERO (Money(0)): semantically distinct and
    preserved through serialize/deserialize (key omitted when absent,
    null rejected).
  * Immutability: frozen dataclasses + tuple atoms + deep-frozen
    source_meta — every mutation path raises.
  * schema 'ir1': round-trip serialize(deserialize(serialize(x)))
    byte-identical; content_hash stable across runs AND processes,
    insensitive to the volatile source_meta exclusions, sensitive to
    any content change.

This suite imports ONLY engine.ir — Phase 0 touches no parser, no
pipeline, no corpus.
"""
from __future__ import annotations

import ast
import dataclasses
import inspect
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

import engine.ir.money as money_module
from engine.ir import (
    CURRENCY_SCALES,
    DEFAULT_SCALE,
    IR_VERSION,
    MONEY_FIELDS,
    VOLATILE_SOURCE_META_KEYS,
    AccountAtom,
    DocHeader,
    DocumentTotals,
    LedgerDoc,
    LedgerDocError,
    Money,
    MoneyCurrencyMismatch,
    MoneyError,
    MoneyParseError,
    Provenance,
    SchemaError,
    SourceRef,
    content_hash,
    deserialize,
    scale_for_currency,
    serialize,
)

SRC_DIR = Path(__file__).resolve().parents[2] / "src"


# ── helpers (string/int constructors ONLY — no float literals for money) ──


def _prov() -> Provenance:
    return Provenance.mechanical(SourceRef.cell("Sheet1", 1, 1))


def _atom(atom_id="a1", code="5121", label="Conturi la banci in lei", **slots):
    return AccountAtom(
        atom_id=atom_id, account_code=code, label=label, provenance=_prov(), **slots
    )


def _doc(currency="RON", atoms=None, source_meta=None, totals=None):
    if atoms is None:
        atoms = (
            _atom(closing_debit=Money.from_decimal_str(currency, "1234.56", scale=2)),
        )
    return LedgerDoc(
        header=DocHeader(
            jurisdiction="RO",
            currency=currency,
            period_start="2025-01-01",
            period_end="2025-12-31",
            document_totals=totals,
            source_meta=source_meta if source_meta is not None else {},
        ),
        atoms=atoms,
    )


# ── currency scale data ──────────────────────────────────────────────────


class TestCurrencyScales:
    def test_operator_spec_values(self):
        assert CURRENCY_SCALES["RON"] == 2
        assert CURRENCY_SCALES["EUR"] == 2
        assert CURRENCY_SCALES["USD"] == 2
        assert CURRENCY_SCALES["GBP"] == 2
        assert CURRENCY_SCALES["HUF"] == 0
        assert CURRENCY_SCALES["KWD"] == 3
        assert CURRENCY_SCALES["BHD"] == 3
        assert CURRENCY_SCALES["OMR"] == 3

    def test_unknown_code_defaults_to_two(self):
        assert DEFAULT_SCALE == 2
        assert scale_for_currency("ZZZ") == 2

    def test_explicit_override_wins(self):
        # Per-document override hook: explicit scale beats the table.
        assert scale_for_currency("HUF", override=2) == 2
        assert scale_for_currency("RON", override=0) == 0
        assert Money.from_minor("HUF", 5, scale=2).scale == 2
        assert Money.from_decimal_str("HUF", "5.25", scale=2).amount_minor == 525

    def test_invalid_override_rejected(self):
        with pytest.raises(MoneyParseError):
            scale_for_currency("RON", override=-1)
        with pytest.raises(MoneyParseError):
            scale_for_currency("RON", override=True)


# ── Money construction + parse ───────────────────────────────────────────


class TestMoneyConstruction:
    def test_from_minor_uses_table_scale(self):
        m = Money.from_minor("RON", 123456)
        assert (m.currency, m.amount_minor, m.scale) == ("RON", 123456, 2)
        assert Money.from_minor("HUF", 1250).scale == 0
        assert Money.from_minor("KWD", 1234).scale == 3

    def test_currency_normalized_uppercase(self):
        assert Money("ron", 1, 2).currency == "RON"

    def test_bad_currency_rejected(self):
        # Shape validation (3 ISO letters), not a registry allowlist —
        # lowercase input normalizes ("lei" -> "LEI" is accepted).
        for bad in ("RONI", "R1N", "", "RO", "R N", 123, None):
            with pytest.raises(MoneyError):
                Money(bad, 1, 2)

    def test_float_amount_rejected(self):
        with pytest.raises(MoneyParseError):
            Money("RON", 1.5, 2)  # type: ignore[arg-type]

    def test_bool_amount_rejected(self):
        with pytest.raises(MoneyParseError):
            Money("RON", True, 2)  # type: ignore[arg-type]

    def test_bad_scale_rejected(self):
        with pytest.raises(MoneyParseError):
            Money("RON", 1, -1)
        with pytest.raises(MoneyParseError):
            Money("RON", 1, 10)
        with pytest.raises(MoneyParseError):
            Money("RON", 1, 2.0)  # type: ignore[arg-type]

    def test_zero_constructor(self):
        z = Money.zero("HUF")
        assert z.amount_minor == 0 and z.scale == 0 and z.is_zero()


class TestMoneyDecimalStr:
    def test_basic_ron(self):
        assert Money.from_decimal_str("RON", "1234.56").amount_minor == 123456
        assert Money.from_decimal_str("RON", "-0.05").amount_minor == -5
        assert Money.from_decimal_str("RON", "0").amount_minor == 0
        assert Money.from_decimal_str("RON", "+12.34").amount_minor == 1234

    def test_scale_zero_and_three(self):
        assert Money.from_decimal_str("HUF", "1250").amount_minor == 1250
        assert Money.from_decimal_str("HUF", "1250.00").amount_minor == 1250
        assert Money.from_decimal_str("KWD", "1.234").amount_minor == 1234
        assert Money.from_decimal_str("KWD", "-0.007").amount_minor == -7

    def test_short_fraction_padded(self):
        assert Money.from_decimal_str("RON", "12.5").amount_minor == 1250

    def test_excess_zeros_exact(self):
        assert Money.from_decimal_str("RON", "12.500").amount_minor == 1250

    def test_excess_nonzero_never_rounds(self):
        with pytest.raises(MoneyParseError):
            Money.from_decimal_str("RON", "12.505")
        with pytest.raises(MoneyParseError):
            Money.from_decimal_str("HUF", "12.5")

    def test_locale_forms_rejected(self):
        for bad in ("1,234.56", "1.234,56", "12.", ".5", "", "abc", "1 234"):
            with pytest.raises(MoneyParseError):
                Money.from_decimal_str("RON", bad)
        with pytest.raises(MoneyParseError):
            Money.from_decimal_str("RON", 1234)  # type: ignore[arg-type]

    @pytest.mark.parametrize(
        "currency,scale,text",
        [
            ("RON", 2, "1234.56"),
            ("RON", 2, "-0.05"),
            ("RON", 2, "0.00"),
            ("HUF", 0, "1250"),
            ("HUF", 0, "-3"),
            ("HUF", 0, "0"),
            ("KWD", 3, "1.234"),
            ("KWD", 3, "-0.007"),
            ("KWD", 3, "0.000"),
        ],
    )
    def test_display_round_trip(self, currency, scale, text):
        m = Money.from_decimal_str(currency, text)
        assert m.scale == scale
        assert m.to_decimal_str() == text.lstrip("+")
        assert Money.from_decimal_str(currency, m.to_decimal_str()) == m

    def test_display_padding(self):
        assert Money.from_minor("RON", -5).to_decimal_str() == "-0.05"
        assert Money.from_minor("KWD", 7).to_decimal_str() == "0.007"
        assert Money.zero("RON").to_decimal_str() == "0.00"
        assert Money.zero("HUF").to_decimal_str() == "0"


# ── Money algebra ────────────────────────────────────────────────────────


class TestMoneyArithmetic:
    def test_same_unit_algebra(self):
        a = Money.from_decimal_str("RON", "10.00")
        b = Money.from_decimal_str("RON", "2.50")
        assert (a + b).amount_minor == 1250
        assert (a - b).amount_minor == 750
        assert (-b).amount_minor == -250
        assert -(-b) == b
        assert b < a and b <= a and a > b and a >= b
        assert -Money.zero("RON") == Money.zero("RON")

    def test_mixed_currency_raises(self):
        ron = Money.from_decimal_str("RON", "1.00")
        eur = Money.from_decimal_str("EUR", "1.00")
        for op in (
            lambda: ron + eur,
            lambda: ron - eur,
            lambda: ron < eur,
            lambda: ron <= eur,
            lambda: ron > eur,
            lambda: ron >= eur,
        ):
            with pytest.raises(MoneyCurrencyMismatch):
                op()

    def test_mixed_scale_same_currency_raises(self):
        a = Money.from_minor("RON", 100, scale=2)
        b = Money.from_minor("RON", 100, scale=0)
        with pytest.raises(MoneyCurrencyMismatch):
            a + b
        with pytest.raises(MoneyCurrencyMismatch):
            a < b

    def test_non_money_operand_raises(self):
        with pytest.raises(MoneyCurrencyMismatch):
            Money.from_minor("RON", 100) + 100  # type: ignore[operator]

    def test_equality_never_raises(self):
        # == across units is simply False (safe for dict/set membership).
        ron = Money.from_minor("RON", 100)
        eur = Money.from_minor("EUR", 100)
        assert ron != eur
        assert Money.from_minor("RON", 0, scale=2) != Money.from_minor("RON", 0, scale=0)
        assert ron == Money.from_minor("RON", 100)
        assert len({ron, eur, Money.from_minor("RON", 100)}) == 2  # hashable


# ── the no-float guarantee ───────────────────────────────────────────────


class TestNoFloatGuarantee:
    def test_money_module_has_no_float_call_on_value_path(self):
        # Grep-style guard per the operator spec: the module source must
        # not contain a float-constructor call anywhere.
        src = inspect.getsource(money_module)
        assert "float(" not in src, (
            "engine.ir.money must never construct a float — parse and "
            "display are string math only"
        )
        # And no decimal-module dependency either (AST, not prose grep).
        tree = ast.parse(src)
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                assert not any(a.name.split(".")[0] == "decimal" for a in node.names)
            if isinstance(node, ast.ImportFrom):
                assert (node.module or "").split(".")[0] != "decimal"

    def test_serialization_carries_only_ints(self):
        payload = Money.from_decimal_str("RON", "1234.56").to_dict()
        assert payload == {"currency": "RON", "amount_minor": 123456, "scale": 2}
        assert isinstance(payload["amount_minor"], int)
        assert isinstance(payload["scale"], int)
        assert Money.from_dict(payload) == Money.from_minor("RON", 123456)

    def test_from_dict_rejects_floats_and_drift(self):
        with pytest.raises(MoneyParseError):
            Money.from_dict({"currency": "RON", "amount_minor": 1234.0, "scale": 2})
        with pytest.raises(MoneyParseError):
            Money.from_dict({"currency": "RON", "amount_minor": 1, "scale": 2.0})
        with pytest.raises(MoneyParseError):
            Money.from_dict({"currency": "RON", "amount_minor": 1})
        with pytest.raises(MoneyParseError):
            Money.from_dict(
                {"currency": "RON", "amount_minor": 1, "scale": 2, "extra": 1}
            )
        with pytest.raises(MoneyParseError):
            Money.from_dict({"currency": "RON", "amount_minor": "1", "scale": 2})


# ── provenance ───────────────────────────────────────────────────────────


class TestProvenance:
    def test_three_source_ref_shapes(self):
        cell = SourceRef.cell("Sheet1", 12, 8)
        assert (cell.sheet, cell.row, cell.col) == ("Sheet1", 12, 8)
        pdf = SourceRef.pdf(3, (10, 20, 110, 32))
        assert pdf.page == 3
        assert pdf.bbox == (10.0, 20.0, 110.0, 32.0)  # ints canonicalized
        assert all(isinstance(c, float) for c in pdf.bbox)
        stage = SourceRef.pipeline_stage("auto_reconcile")
        assert stage.stage == "auto_reconcile"

    def test_mixed_or_empty_shape_rejected(self):
        with pytest.raises(LedgerDocError):
            SourceRef()
        with pytest.raises(LedgerDocError):
            SourceRef(sheet="S", row=1, col=1, stage="x")
        with pytest.raises(LedgerDocError):
            SourceRef(page=1, bbox=(1, 2, 3, 4), sheet="S", row=0, col=0)
        with pytest.raises(LedgerDocError):
            SourceRef(sheet="S", row=1)  # incomplete cell shape
        with pytest.raises(LedgerDocError):
            SourceRef.pdf(1, (1, 2, 3))  # bbox must be 4 numbers

    def test_mechanical_is_exact(self):
        p = Provenance.mechanical(SourceRef.cell("S", 0, 0))
        assert p.method == "mechanical"
        assert p.confidence == 1.0 and isinstance(p.confidence, float)
        assert p.needs_review is False
        with pytest.raises(LedgerDocError):
            Provenance(
                source_ref=SourceRef.cell("S", 0, 0),
                method="mechanical",
                confidence=0.9,
            )

    def test_llm_confidence_bounds(self):
        p = Provenance(
            source_ref=SourceRef.pdf(0, (0, 0, 1, 1)),
            method="llm",
            confidence=0.85,
            needs_review=True,
        )
        assert p.confidence == 0.85 and p.needs_review is True
        # int confidence canonicalized to float (json byte-stability)
        q = Provenance(source_ref=SourceRef.cell("S", 0, 0), method="llm", confidence=1)
        assert isinstance(q.confidence, float)
        with pytest.raises(LedgerDocError):
            Provenance(source_ref=SourceRef.cell("S", 0, 0), method="llm", confidence=1.5)
        with pytest.raises(LedgerDocError):
            Provenance(source_ref=SourceRef.cell("S", 0, 0), method="ocr", confidence=1.0)


# ── ABSENT vs ZERO ───────────────────────────────────────────────────────


class TestAbsentVsZero:
    def test_atom_distinction_survives_round_trip(self):
        atom = _atom(
            closing_debit=Money.zero("RON"),  # ZERO — the document states 0
            # closing_credit ABSENT — the document has no such column
        )
        doc = _doc(atoms=(atom,))
        payload = serialize(doc)
        a0 = payload["atoms"][0]
        assert "closing_debit" in a0
        assert a0["closing_debit"]["amount_minor"] == 0
        assert "closing_credit" not in a0  # omitted, never null
        assert "opening_debit" not in a0

        back = deserialize(payload).atoms[0]
        assert back.closing_debit == Money.zero("RON")
        assert back.closing_credit is None
        assert back.opening_debit is None

    def test_null_amount_slot_rejected(self):
        payload = serialize(_doc())
        payload["atoms"][0]["closing_credit"] = None
        with pytest.raises(SchemaError):
            deserialize(payload)

    def test_document_totals_partial_pairs(self):
        t = DocumentTotals(
            closing_debit=Money.from_decimal_str("RON", "39194178.46"),
            closing_credit=Money.from_decimal_str("RON", "39194178.46"),
        )
        doc = _doc(totals=t)
        payload = serialize(doc)
        dt = payload["header"]["document_totals"]
        assert set(dt.keys()) == {"closing_debit", "closing_credit"}
        back = deserialize(payload)
        assert back.header.document_totals.closing_debit.amount_minor == 3919417846
        assert back.header.document_totals.opening_debit is None

    def test_totals_absent_vs_empty(self):
        # ABSENT totals row: key omitted entirely.
        no_totals = serialize(_doc(totals=None))
        assert "document_totals" not in no_totals["header"]
        assert deserialize(no_totals).header.document_totals is None
        # Present-but-empty totals object: {} round-trips to all-None slots.
        empty = serialize(_doc(totals=DocumentTotals()))
        assert empty["header"]["document_totals"] == {}
        back = deserialize(empty).header.document_totals
        assert back is not None
        assert all(getattr(back, f) is None for f in MONEY_FIELDS)


# ── immutability ─────────────────────────────────────────────────────────


class TestImmutability:
    def test_money_frozen(self):
        m = Money.from_minor("RON", 1)
        with pytest.raises(dataclasses.FrozenInstanceError):
            m.amount_minor = 2  # type: ignore[misc]

    def test_atom_and_doc_frozen(self):
        doc = _doc()
        with pytest.raises(dataclasses.FrozenInstanceError):
            doc.atoms = ()  # type: ignore[misc]
        with pytest.raises(dataclasses.FrozenInstanceError):
            doc.header.currency = "EUR"  # type: ignore[misc]
        with pytest.raises(dataclasses.FrozenInstanceError):
            doc.atoms[0].closing_debit = None  # type: ignore[misc]
        with pytest.raises(dataclasses.FrozenInstanceError):
            doc.atoms[0].provenance.confidence = 0.1  # type: ignore[misc]

    def test_atoms_are_tuple_even_from_list(self):
        doc = _doc(atoms=[_atom()])
        assert isinstance(doc.atoms, tuple)
        assert not hasattr(doc.atoms, "append")

    def test_source_meta_deep_frozen(self):
        doc = _doc(source_meta={"a": 1, "nested": {"k": [1, 2]}, "lst": [3]})
        with pytest.raises(TypeError):
            doc.header.source_meta["a"] = 2  # type: ignore[index]
        with pytest.raises(TypeError):
            doc.header.source_meta["nested"]["k"] = ()  # type: ignore[index]
        assert doc.header.source_meta["nested"]["k"] == (1, 2)  # list -> tuple
        assert isinstance(doc.header.source_meta["lst"], tuple)

    def test_source_meta_no_aliasing_with_caller(self):
        meta = {"a": {"b": 1}}
        doc = _doc(source_meta=meta)
        meta["a"]["b"] = 999  # caller mutates its own dict afterwards
        assert doc.header.source_meta["a"]["b"] == 1

    def test_non_json_source_meta_rejected(self):
        with pytest.raises(LedgerDocError):
            _doc(source_meta={"blob": b"bytes"})
        with pytest.raises(LedgerDocError):
            _doc(source_meta={1: "non-str-key"})  # type: ignore[dict-item]


# ── LedgerDoc construction rules ─────────────────────────────────────────


class TestLedgerDocValidation:
    def test_duplicate_atom_id_rejected(self):
        with pytest.raises(LedgerDocError):
            _doc(atoms=(_atom(atom_id="x"), _atom(atom_id="x", code="401")))

    def test_duplicate_account_code_allowed(self):
        # Duplicate CODES are legal source content (diagnosis D5's business).
        doc = _doc(atoms=(_atom(atom_id="x1"), _atom(atom_id="x2")))
        assert len(doc.atoms) == 2

    def test_wrong_member_types_rejected(self):
        with pytest.raises(LedgerDocError):
            LedgerDoc(header={"jurisdiction": "RO"}, atoms=())  # type: ignore[arg-type]
        with pytest.raises(LedgerDocError):
            _doc(atoms=(_atom(), "not-an-atom"))  # type: ignore[arg-type]
        with pytest.raises(LedgerDocError):
            _atom(closing_debit=1234)  # type: ignore[arg-type]

    def test_header_normalization_and_version(self):
        doc = _doc()
        assert doc.header.jurisdiction == "RO"
        assert doc.header.currency == "RON"
        assert doc.header.ir_version == IR_VERSION == "ir1"
        with pytest.raises(LedgerDocError):
            DocHeader(jurisdiction="RO", currency="RON", ir_version="ir2")


# ── round-trip byte-stability ────────────────────────────────────────────


def _rich_doc(currency, amount_texts):
    atoms = []
    for i, text in enumerate(amount_texts):
        atoms.append(
            AccountAtom(
                atom_id="a%04d" % i,
                account_code=str(1010 + i),
                label="Cont %d — ășțî" % i,  # diacritics exercise ensure_ascii
                provenance=(
                    _prov()
                    if i % 2 == 0
                    else Provenance(
                        source_ref=SourceRef.pdf(i, (1, 2.5, 3, 4)),
                        method="llm",
                        confidence=0.85,
                        needs_review=True,
                    )
                ),
                opening_debit=Money.from_decimal_str(currency, text),
                closing_debit=Money.from_decimal_str(currency, text),
                closing_credit=Money.zero(currency),
            )
        )
    return _doc(
        currency=currency,
        atoms=tuple(atoms),
        source_meta={"original_filename": "b.xlsx", "sheet": "Doc", "n": [1, {"d": 2}]},
        totals=DocumentTotals(
            closing_debit=Money.from_decimal_str(currency, amount_texts[0]),
            closing_credit=Money.from_decimal_str(currency, amount_texts[0]),
        ),
    )


class TestRoundTrip:
    @pytest.mark.parametrize(
        "currency,amounts",
        [
            ("RON", ["1234.56", "-0.05", "0.00", "39194178.46"]),  # scale 2
            ("HUF", ["1250", "-3", "0", "987654321"]),             # scale 0
            ("KWD", ["1.234", "-0.007", "0.000", "55.001"]),       # scale 3
        ],
    )
    def test_serialize_deserialize_byte_identical(self, currency, amounts):
        doc = _rich_doc(currency, amounts)
        s1 = serialize(doc)
        s2 = serialize(deserialize(s1))
        # Byte-identical both in construction order and canonicalized.
        assert json.dumps(s1) == json.dumps(s2)
        assert json.dumps(s1, sort_keys=True) == json.dumps(s2, sort_keys=True)
        # And the round-tripped VALUE equals the original document.
        assert deserialize(s1) == doc

    def test_serialize_result_is_json_safe_and_unaliased(self):
        doc = _doc(source_meta={"nested": {"k": [1]}})
        payload = serialize(doc)
        json.dumps(payload)  # no mappingproxy/tuple leaks
        payload["header"]["source_meta"]["nested"]["k"].append(2)  # mutate copy
        assert doc.header.source_meta["nested"]["k"] == (1,)  # doc untouched


# ── schema strictness ────────────────────────────────────────────────────


class TestSchemaStrictness:
    def test_unknown_keys_rejected_everywhere(self):
        base = serialize(_doc())
        for mutate in (
            lambda p: p.update({"extra": 1}),
            lambda p: p["header"].update({"extra": 1}),
            lambda p: p["atoms"][0].update({"extra": 1}),
            lambda p: p["atoms"][0]["provenance"].update({"extra": 1}),
            lambda p: p["atoms"][0]["provenance"]["source_ref"].update({"x": 1}),
        ):
            payload = json.loads(json.dumps(base))
            mutate(payload)
            with pytest.raises(SchemaError):
                deserialize(payload)

    def test_missing_required_keys_rejected(self):
        for drop in ("header", "atoms"):
            payload = serialize(_doc())
            del payload[drop]
            with pytest.raises(SchemaError):
                deserialize(payload)
        payload = serialize(_doc())
        del payload["atoms"][0]["provenance"]
        with pytest.raises(SchemaError):
            deserialize(payload)

    def test_foreign_ir_version_rejected(self):
        payload = serialize(_doc())
        payload["header"]["ir_version"] = "ir2"
        with pytest.raises(SchemaError):
            deserialize(payload)

    def test_malformed_nodes_rejected(self):
        payload = serialize(_doc())
        payload["atoms"] = "not-a-list"
        with pytest.raises(SchemaError):
            deserialize(payload)
        payload = serialize(_doc())
        payload["atoms"][0]["closing_debit"] = {"currency": "RON", "amount_minor": "1", "scale": 2}
        with pytest.raises(SchemaError):
            deserialize(payload)


# ── content hash ─────────────────────────────────────────────────────────

_META = {
    "original_filename": "balanta_dec_2025.xlsx",
    "parser_version": "tb_parser_v5",
    # volatile keys (excluded from the hash):
    "ingested_at": "2026-08-19T10:00:00Z",
    "storage_path": "documents/org1/doc1.xlsx",
    "job_id": "job-123",
}


class TestContentHash:
    def test_stable_across_independent_constructions(self):
        h1 = content_hash(_doc(source_meta=dict(_META)))
        h2 = content_hash(_doc(source_meta=dict(_META)))
        assert h1 == h2
        assert len(h1) == 64 and set(h1) <= set("0123456789abcdef")

    def test_stable_across_serialize_round_trip(self):
        doc = _rich_doc("RON", ["1234.56", "-0.05"])
        assert content_hash(deserialize(serialize(doc))) == content_hash(doc)

    def test_insensitive_to_volatile_source_meta(self):
        base = content_hash(_doc(source_meta=dict(_META)))
        changed = dict(_META, ingested_at="2099-01-01T00:00:00Z",
                       storage_path="elsewhere/x.xlsx", job_id="job-999")
        assert content_hash(_doc(source_meta=changed)) == base
        # Absence of a volatile key hashes the same as any value of it.
        dropped = {k: v for k, v in _META.items()
                   if k not in ("ingested_at", "storage_path", "job_id")}
        assert content_hash(_doc(source_meta=dropped)) == base

    def test_sensitive_to_non_volatile_meta(self):
        base = content_hash(_doc(source_meta=dict(_META)))
        renamed = dict(_META, original_filename="other_file.xlsx")
        assert content_hash(_doc(source_meta=renamed)) != base

    def test_sensitive_to_amount_change(self):
        a = _doc(atoms=(_atom(closing_debit=Money.from_minor("RON", 123456)),))
        b = _doc(atoms=(_atom(closing_debit=Money.from_minor("RON", 123457)),))
        assert content_hash(a) != content_hash(b)

    def test_sensitive_to_label_zero_vs_absent_and_order(self):
        base = _doc(atoms=(_atom(closing_debit=Money.from_minor("RON", 1)),))
        relabel = _doc(atoms=(_atom(label="Alt nume",
                                    closing_debit=Money.from_minor("RON", 1)),))
        assert content_hash(base) != content_hash(relabel)
        zero = _doc(atoms=(_atom(closing_debit=Money.from_minor("RON", 1),
                                 closing_credit=Money.zero("RON")),))
        assert content_hash(base) != content_hash(zero)  # ZERO != ABSENT
        two_ab = _doc(atoms=(_atom(atom_id="x1"), _atom(atom_id="x2", code="401")))
        two_ba = _doc(atoms=(_atom(atom_id="x2", code="401"), _atom(atom_id="x1")))
        assert content_hash(two_ab) != content_hash(two_ba)  # row order is content

    def test_volatile_exclusion_list_documented_entries(self):
        assert {"ingested_at", "storage_path", "job_id"} <= VOLATILE_SOURCE_META_KEYS
        assert "original_filename" not in VOLATILE_SOURCE_META_KEYS


# ── cross-process determinism ────────────────────────────────────────────

_FIXED_DOC_SRC = """
from engine.ir import (Money, LedgerDoc, DocHeader, DocumentTotals,
                       AccountAtom, Provenance, SourceRef)
doc = LedgerDoc(
    header=DocHeader(
        jurisdiction="RO", currency="RON",
        period_start="2025-01-01", period_end="2025-12-31",
        document_totals=DocumentTotals(
            closing_debit=Money.from_decimal_str("RON", "39194178.46"),
            closing_credit=Money.from_decimal_str("RON", "39194178.46"),
        ),
        source_meta={"original_filename": "balanta.xlsx",
                     "parser_version": "tb_parser_v5",
                     "ingested_at": "2026-08-19T10:00:00Z"},
    ),
    atoms=(
        AccountAtom(
            atom_id="a0001", account_code="5121",
            label="Conturi la banci in lei",
            provenance=Provenance.mechanical(SourceRef.cell("Sheet1", 12, 8)),
            closing_debit=Money.from_decimal_str("RON", "1234.56"),
        ),
        AccountAtom(
            atom_id="a0002", account_code="401", label="Furnizori",
            provenance=Provenance(
                source_ref=SourceRef.pdf(3, (10, 20.5, 110, 32)),
                method="llm", confidence=0.85, needs_review=True,
            ),
            closing_credit=Money.from_decimal_str("RON", "1234.56"),
        ),
    ),
)
"""


class TestCrossProcessDeterminism:
    def test_content_hash_identical_in_fresh_interpreter(self):
        ns: dict = {}
        exec(compile(_FIXED_DOC_SRC, "<fixed_doc>", "exec"), ns)
        local_hash = content_hash(ns["doc"])

        code = _FIXED_DOC_SRC + (
            "\nfrom engine.ir import content_hash\nprint(content_hash(doc))\n"
        )
        env = dict(os.environ)
        env["PYTHONPATH"] = str(SRC_DIR) + os.pathsep + env.get("PYTHONPATH", "")
        env["PYTHONHASHSEED"] = "random"  # hash-seed independence, explicitly
        out = subprocess.run(
            [sys.executable, "-c", code],
            capture_output=True, text=True, env=env, timeout=60,
        )
        assert out.returncode == 0, out.stderr
        assert out.stdout.strip() == local_hash
