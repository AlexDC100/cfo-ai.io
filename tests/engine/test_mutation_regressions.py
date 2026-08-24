"""Killing tests from C1 mutation triage (docs/engine_book/mutation.md).

Every test here exists because a specific mutmut mutant SURVIVED the
battery — i.e. the mutated kernel behavior was observably wrong yet no
test failed. Each test names the mutant id(s) it kills in its docstring
and pins the exact behavior the mutant broke, so the hole stays closed
even if the mutation tool or ids change.

These are ordinary unit tests: they run in the normal battery, not just
under mutation. Keep them import-light (kernel modules only) so the
mutation runner's per-mutant cost stays low.
"""
from __future__ import annotations

import pytest

from engine.ir.money import Money, MoneyCurrencyMismatch, MoneyParseError


def _corrupt(obj, **fields):
    """Post-construction corruption of a frozen dataclass — same
    technique as tests/engine/test_assertion_witnesses.py."""
    for name, value in fields.items():
        object.__setattr__(obj, name, value)
    return obj


# ── engine.ir.money ────────────────────────────────────────────────────


class TestMoneyOrderingBoundary:
    """Kills xǁMoneyǁ__lt____mutmut_1, __le____mutmut_1, __gt____mutmut_1,
    __ge____mutmut_1 (strict/inclusive operator swaps at EQUAL amounts —
    all four survived the battery: nothing ordered two equal Moneys)."""

    def test_ordering_at_equality(self) -> None:
        a = Money.from_minor("RON", 12345)
        b = Money.from_minor("RON", 12345)
        assert not (a < b)
        assert a <= b
        assert not (a > b)
        assert a >= b

    def test_ordering_strict(self) -> None:
        lo = Money.from_minor("RON", 1)
        hi = Money.from_minor("RON", 2)
        assert lo < hi and lo <= hi
        assert hi > lo and hi >= lo
        assert not (hi < lo) and not (hi <= lo)
        assert not (lo > lo)  # irreflexive
        assert lo >= lo and lo <= lo  # reflexive inclusive


class TestMoneyErrorMessageContract:
    """The typed-error texts are part of the debugging surface: they name
    the operation, the offending value/type, and the law being applied.
    Full-string equality kills every message mutant that survived
    (None-payload, XX-wrapping, case flips, type(None) substitutions,
    and the `what`/`op` argument mutants that only show up in messages).

    Kills (all ': survived' in the 2026-08-23 money run):
      x__check_currency__mutmut_{2,4,5,7,12,14,15}
      x__check_int__mutmut_{3,5,6,8}
      x__check_scale__mutmut_{3,6,7,12,14}
      xǁMoneyǁ__post_init____mutmut_{19,22,23}
      xǁMoneyǁ_require_same_unit__mutmut_{2,4,5,7,11,13}
      xǁMoneyǁ__add____mutmut_{3,6,7}   xǁMoneyǁ__sub____mutmut_{3,6,7}
      xǁMoneyǁ__lt____mutmut_{3,6,7}    xǁMoneyǁ__le____mutmut_{3,6,7}
      xǁMoneyǁ__gt____mutmut_{3,6,7}    xǁMoneyǁ__ge____mutmut_{3,6,7}
    """

    def test_currency_type_error_text(self) -> None:
        with pytest.raises(MoneyParseError) as ei:
            Money.from_minor(123, 1)  # type: ignore[arg-type]
        assert str(ei.value) == "currency must be a str ISO-4217 code, got int"

    def test_currency_format_error_text(self) -> None:
        with pytest.raises(MoneyParseError) as ei:
            Money.from_minor("R0N", 1)
        assert str(ei.value) == "currency must be a 3-letter ISO-4217 code, got 'R0N'"

    def test_amount_float_error_text(self) -> None:
        with pytest.raises(MoneyParseError) as ei:
            Money("RON", 1.5, 2)  # type: ignore[arg-type]
        assert str(ei.value) == (
            "amount_minor must be an int, got float — floats/bools never enter Money"
        )

    def test_amount_bool_error_text(self) -> None:
        with pytest.raises(MoneyParseError) as ei:
            Money("RON", True, 2)
        assert str(ei.value) == (
            "amount_minor must be an int, got bool — floats/bools never enter Money"
        )

    def test_scale_type_error_text(self) -> None:
        with pytest.raises(MoneyParseError) as ei:
            Money("RON", 1, "2")  # type: ignore[arg-type]
        assert str(ei.value) == (
            "scale must be an int, got str — floats/bools never enter Money"
        )

    def test_scale_range_error_text(self) -> None:
        with pytest.raises(MoneyParseError) as ei:
            Money.from_minor("RON", 1, scale=12)
        assert str(ei.value) == "scale must be within 0..9, got 12"

    def test_non_money_operand_error_names_op_and_type(self) -> None:
        a = Money.from_minor("RON", 100)
        with pytest.raises(MoneyCurrencyMismatch) as ei:
            a + 5  # type: ignore[operator]
        assert str(ei.value) == "add is defined between Money values only, got int"
        with pytest.raises(MoneyCurrencyMismatch) as ei:
            a - "x"  # type: ignore[operator]
        assert str(ei.value) == "sub is defined between Money values only, got str"
        with pytest.raises(MoneyCurrencyMismatch) as ei:
            a < 5  # type: ignore[operator]
        assert str(ei.value) == "compare is defined between Money values only, got int"

    @pytest.mark.parametrize(
        "op,expected_word",
        [
            (lambda a, b: a + b, "add"),
            (lambda a, b: a - b, "sub"),
            (lambda a, b: a < b, "compare"),
            (lambda a, b: a <= b, "compare"),
            (lambda a, b: a > b, "compare"),
            (lambda a, b: a >= b, "compare"),
        ],
        ids=["add", "sub", "lt", "le", "gt", "ge"],
    )
    def test_cross_unit_error_names_op_and_units(self, op, expected_word) -> None:
        a = Money.from_minor("RON", 100)
        b = Money.from_minor("EUR", 100)
        with pytest.raises(MoneyCurrencyMismatch) as ei:
            op(a, b)
        assert str(ei.value) == (
            "%s across units: RON/scale2 vs EUR/scale2" % expected_word
        )


class TestMoneyAssertMessagePrecision:
    """The A-### assert messages are the documented contract
    (docs/engine_book/assertions.md: the id is the identity). The
    witnesses in test_assertion_witnesses.py match the id SUBSTRING,
    which XX-wrapping / case-flip / argument mutants still satisfy —
    these tests pin the full text.

    Kills xǁMoneyǁ_require_same_unit__mutmut_{21,24,26,27,28,29} (A-001),
    xǁMoneyǁ__neg____mutmut_{4,7} (A-002),
    xǁMoneyǁto_decimal_str__mutmut_{11,13,14} (A-003),
    xǁMoneyǁ__add____mutmut_{20,22,23} (A-004),
    xǁMoneyǁ__sub____mutmut_{20,22,23} (A-005)."""

    def test_a001_message_exact(self) -> None:
        a = Money.from_minor("RON", 100)
        b = _corrupt(Money.from_minor("RON", 100), amount_minor=1.5)
        with pytest.raises(AssertionError) as ei:
            a + b
        assert str(ei.value).startswith(
            "A-001: Money add operands must hold exact int minor units, "
            "got int/float — a non-int amount_minor means the no-float "
            "guarantee was violated after construction"
        )

    def test_a002_message_exact(self) -> None:
        m = _corrupt(Money.from_minor("RON", 100), amount_minor=2.5)
        with pytest.raises(AssertionError) as ei:
            -m
        assert str(ei.value).startswith(
            "A-002: Money.neg requires an exact int amount_minor, got float"
        )

    def test_a003_message_exact(self) -> None:
        m = _corrupt(Money.from_minor("RON", 105), scale=-1)
        with pytest.raises(AssertionError) as ei:
            m.to_decimal_str()
        assert str(ei.value).startswith(
            "A-003: to_decimal_str requires int minor units and scale in "
            "0..9, got amount_minor=105 scale=-1"
        )

    def test_a004_a005_message_exact(self) -> None:
        a = _corrupt(Money.from_minor("RON", 100), currency="ron")
        b = _corrupt(Money.from_minor("RON", 50), currency="ron")
        with pytest.raises(AssertionError) as ei:
            a + b
        assert str(ei.value).startswith(
            "A-004: Money.add must be closed over one (currency, scale): "
            "result RON/scale2 from operands ron/scale2"
        )
        with pytest.raises(AssertionError) as ei:
            a - b
        assert str(ei.value).startswith(
            "A-005: Money.sub must be closed over one (currency, scale): "
            "result RON/scale2 from operands ron/scale2"
        )


class TestMoneyRenderBoundaryAndShape:
    """Kills xǁMoneyǁto_decimal_str__mutmut_9 (the A-003 domain check
    tightened to scale < 9, which would refuse a VALID scale-9 Money)
    and xǁMoneyǁ__post_init____mutmut_{16,17,30,31} (object.__setattr__
    against a wrong attribute name leaves a stray attribute on the
    instance)."""

    def test_scale_nine_renders_and_round_trips(self) -> None:
        m = Money.from_minor("RON", 5, scale=9)
        assert m.to_decimal_str() == "0.000000005"
        assert Money.from_decimal_str("RON", "0.000000005", scale=9) == m
        # And the other domain edge, scale 0:
        assert Money.from_minor("HUF", -1250).to_decimal_str() == "-1250"

    def test_no_stray_attributes_after_construction(self) -> None:
        m = Money("ron", 105, 2)  # denormalized currency on purpose
        assert vars(m) == {"currency": "RON", "amount_minor": 105, "scale": 2}


# ── engine.journal.events ──────────────────────────────────────────────

from pathlib import PurePosixPath  # noqa: E402

from engine.journal.events import (  # noqa: E402
    EVENT_TYPES,
    VOLATILE_PLACEHOLDER,
    canonical_bytes,
    content_hash,
    hash_bytes,
    make_event,
    strip_volatile,
    verify_event,
)
from engine.journal.events import _hash_basis  # noqa: E402


class TestCanonicalBytesContract:
    """The canonical byte form IS the hash-chain identity. The first
    mutation run proved every self-consistent serialization drift
    (sort_keys off, ensure_ascii on, separators changed) survived,
    because make_event and verify_event share canonical_bytes — the
    chain stays internally consistent while the FORMAT silently forks
    from every already-written journal on disk. A pinned golden hash is
    the only defense.

    Kills x_canonical_bytes__mutmut_{3,4,5,7,8,9,10,11} (strict-path
    arg drift), {17} (encode(None) silently downgrades to lossy),
    {18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,34} (the default=str
    fallback path — never exercised by any test before this)."""

    #: sha256 of the canonical bytes of _TRICKY below — the journal's
    #: on-disk identity. If this ever changes INTENTIONALLY, every
    #: existing journal chain breaks: bump EVENT_SCHEMA_VERSION and
    #: migrate, don't just update the constant.
    _TRICKY = {"zulu": 1, "ansamblu": [1, 2, {"ș": "ț"}], "mixt": None}
    _GOLDEN = "7ae8afd67f418f9a61dd90300ffde8e203285db5de689073b55dff23b3d983f8"

    def test_strict_path_golden_bytes_and_hash(self) -> None:
        data, lossy = canonical_bytes(self._TRICKY)
        # exact bytes: sorted keys, compact separators, raw UTF-8
        assert data == '{"ansamblu":[1,2,{"ș":"ț"}],"mixt":null,"zulu":1}'.encode(
            "utf-8"
        )
        assert lossy is False
        digest, lossy2 = content_hash(self._TRICKY)
        assert lossy2 is False
        assert digest == hash_bytes(data)
        assert digest == self._GOLDEN

    def test_lossy_fallback_exact_bytes_and_flag(self) -> None:
        # PurePosixPath is not JSON-serializable -> default=str fallback,
        # flagged lossy, same canonical shape (sorted, compact, UTF-8).
        obj = {"beta": PurePosixPath("a/b"), "alfa": {"ț": PurePosixPath("c")}}
        data, lossy = canonical_bytes(obj)
        assert lossy is True
        assert data == '{"alfa":{"ț":"c"},"beta":"a/b"}'.encode("utf-8")

    def test_plain_payload_is_never_lossy(self) -> None:
        data, lossy = canonical_bytes({"a": [1, "x", None, True]})
        assert lossy is False
        assert data == b'{"a":[1,"x",null,true]}'


class TestJournalEventShape:
    """Kills x_make_event__mutmut_{2,4,5,7,10,11} and
    x_verify_event__mutmut_{4,5,6,12,14,15,16,17,18,19,20,21,22,27,28,
    29,30,31,32,33,34,35,36,37,38} — the event-dict key set, the
    unknown-type error text, and verify_event's three error strings
    (which name the run/seq/hash they complain about; a report that
    prints `None` instead of the offending values is a broken report)."""

    @staticmethod
    def _event(**over):
        kw = dict(
            run_id="rid1",
            seq=5,
            ts="2026-08-23T00:00:00+00:00",
            event_type="RUN_STARTED",
            payload={"k": "v"},
            prev_event_hash=None,
        )
        kw.update(over)
        return make_event(**kw)

    def test_event_key_set_and_schema_version(self) -> None:
        ev = self._event()
        assert set(ev.keys()) == {
            "v", "run_id", "seq", "ts", "type", "payload",
            "prev_event_hash", "event_hash",
        }
        assert ev["v"] == 1
        assert verify_event(ev) is None

    def test_unknown_type_message_exact(self) -> None:
        with pytest.raises(ValueError) as ei:
            self._event(event_type="BOGUS")
        assert str(ei.value) == (
            "unknown journal event type 'BOGUS' (known: %s)"
            % ", ".join(sorted(EVENT_TYPES))
        )
        # the join separator and sorted order are part of the message
        assert "AI_REVIEW_DEGRADED, AI_REVIEW_DONE" in str(ei.value)

    def test_verify_reports_hash_mismatch_with_context(self) -> None:
        ev = self._event()
        ev["event_hash"] = "deadbeef"
        expected = hash_bytes(_hash_basis(ev))
        assert verify_event(ev) == (
            "event_hash mismatch (run rid1 seq 5): stored deadbeef != "
            "recomputed %s" % expected
        )

    def test_verify_reports_unknown_type_with_context(self) -> None:
        ev = self._event()
        ev["type"] = "NOT_A_TYPE"
        ev["event_hash"] = hash_bytes(_hash_basis(ev))  # hash valid again
        assert verify_event(ev) == "unknown event type 'NOT_A_TYPE' (run rid1 seq 5)"

    def test_verify_reports_unreadable_event(self) -> None:
        err = verify_event(["not", "a", "dict"])  # type: ignore[arg-type]
        assert err is not None and err.startswith("event unreadable: ")
        assert "items" in err  # names the actual failure


class TestStripVolatile:
    """Kills x_strip_volatile__mutmut_{1,2,3} — most importantly the
    membership INVERSION (`k in VOLATILE_KEYS` -> `k not in ...`), which
    survived because dedup tests compare two normalizations of the same
    mutant (self-consistent). This pins the absolute output."""

    def test_strips_exactly_the_volatile_keys_recursively(self) -> None:
        obj = {
            "written_at": "2026-01-01T00:00:00Z",
            "keep": {"applied_at": "x", "other": 1},
            "rows": [{"at": "y", "amount": 5}],
        }
        assert strip_volatile(obj) == {
            "written_at": VOLATILE_PLACEHOLDER,
            "keep": {"applied_at": VOLATILE_PLACEHOLDER, "other": 1},
            "rows": [{"at": VOLATILE_PLACEHOLDER, "amount": 5}],
        }


# ── engine.api._reconcile (validator + trigger + placement scope) ──────

import copy  # noqa: E402

from engine.api._reconcile import (  # noqa: E402
    PLACEMENT_BS,
    PLACEMENT_DETAIL_BS,
    PLACEMENT_DETAIL_PL_EXPENSE,
    PLACEMENT_DETAIL_PL_INCOME,
    PLACEMENT_PL,
    SYNTHETIC_ROW_ID,
    SYNTHETIC_ROW_LABEL,
    ReconcileRejected,
    _apply_adjustment,
    _gate_checks,
    _gate_ok,
    _placement_for,
    compute_reconcile_offer,
    validate_proposal,
)


def _cbs(
    *,
    assets: float,
    equity: float,
    liabilities: float,
    current_assets: float = 0.0,
    current_liabilities: float = 0.0,
    rows=None,
    sections=None,
    status: str = "MINOR_DRIFT",
):
    el = round(equity + liabilities, 2)
    return {
        "status": status,
        "difference": round(assets - el, 2),
        "totals": {
            "assets": assets,
            "equity": equity,
            "liabilities": liabilities,
            "equity_plus_liabilities": el,
            "current_assets": current_assets,
            "current_liabilities": current_liabilities,
        },
        "rows": list(rows or []),
        "sections": list(sections or []),
    }


def _reject_payload(code: str, detail: str):
    return {"status": "rejected", "diagnosis": [{"code": code, "detail": detail}]}


class TestGateChecks:
    """Kills x__gate_checks__mutmut_{2..18} (NO_PROVENANCE_HASH payload),
    {42..55} + {29,31} (NOTHING_TO_RECONCILE trigger + payload),
    {32..36,39,40} (BALANCED-status detection), {63..70} (which totals
    key feeds the gate denominator), {82..91} (ABOVE_RECONCILE_GATE
    payload incl. the cents→RON rendering). The rejection payloads are
    the served 409 bodies — exact-dict equality is the contract."""

    def test_missing_provenance_payload_exact(self) -> None:
        cbs = _cbs(assets=1000.0, equity=500.0, liabilities=499.0)
        with pytest.raises(ReconcileRejected) as ei:
            _gate_checks(cbs, None)
        assert ei.value.payload == _reject_payload(
            "NO_PROVENANCE_HASH",
            "envelope has no provenance.content_hash — a reconciliation "
            "could never be keyed to its source",
        )

    def test_zero_difference_payload_exact(self) -> None:
        cbs = _cbs(assets=1000.0, equity=500.0, liabilities=500.0)
        with pytest.raises(ReconcileRejected) as ei:
            _gate_checks(cbs, "hash")
        assert ei.value.payload == _reject_payload(
            "NOTHING_TO_RECONCILE",
            "statement already closes exactly — nothing to fix",
        )

    def test_balanced_status_rejects_even_with_drift(self) -> None:
        cbs = _cbs(assets=1000.0, equity=500.0, liabilities=499.5, status="BALANCED")
        with pytest.raises(ReconcileRejected) as ei:
            _gate_checks(cbs, "hash")
        assert ei.value.payload["diagnosis"][0]["code"] == "NOTHING_TO_RECONCILE"

    def test_one_cent_drift_is_reconcilable(self) -> None:
        cbs = _cbs(assets=1000.0, equity=500.0, liabilities=499.99)
        assert _gate_checks(cbs, "hash") == 1

    def test_gate_denominator_uses_assets_side(self) -> None:
        # diff 1.00 == exactly 0.1% of assets (1000.00) but MORE than
        # 0.1% of E+L (999.00): only the true max() passes.
        cbs = _cbs(assets=1000.0, equity=500.0, liabilities=499.0)
        assert _gate_checks(cbs, "hash") == 100

    def test_gate_denominator_uses_el_side(self) -> None:
        cbs = _cbs(assets=999.0, equity=500.0, liabilities=500.0)
        assert _gate_checks(cbs, "hash") == -100

    def test_above_gate_payload_exact(self) -> None:
        cbs = _cbs(assets=1000.0, equity=500.0, liabilities=495.0)
        with pytest.raises(ReconcileRejected) as ei:
            _gate_checks(cbs, "hash")
        assert ei.value.payload == _reject_payload(
            "ABOVE_RECONCILE_GATE",
            "|difference| 5.00 RON exceeds 0.1% of the balance sheet — "
            "needs a human, not an adjustment",
        )


class TestGateOkBoundary:
    """Kills x__gate_ok__mutmut_8 (guard `or` -> `and`: a ZERO difference
    slips past the guard and `0 * 1000 <= denom` answers True — the gate
    would offer on an already-closed statement) and x__gate_ok__mutmut_13
    (the guard's `return False` flipped to True).

    x__gate_ok__mutmut_9 (`denom <= 0` -> `< 0`) and __mutmut_10
    (`<= 0` -> `<= 1`) are documented equivalents — denom is a max of
    two abs() so it is never negative, and no nonzero diff can ever
    satisfy `|diff| * 1000 <= denom` for denom in {0, 1}, so the guard
    and the ratio check agree on every input (verified by exhaustive
    sweep; see docs/engine_book/mutation.md)."""

    def test_zero_difference_is_not_gateable(self) -> None:
        assert _gate_ok(0, 10000, 10000) is False

    def test_zero_denominator_is_not_gateable(self) -> None:
        assert _gate_ok(5, 0, 0) is False

    def test_exact_permille_boundary_both_sides(self) -> None:
        # 100 * 1000 == 100000: exactly 0.1% passes, against either side
        # of the max(); one cent above refuses.
        assert _gate_ok(100, 100000, 99900) is True
        assert _gate_ok(-100, 99900, 100000) is True
        assert _gate_ok(101, 100000, 99900) is False


class TestComputeReconcileOffer:
    """Kills x_compute_reconcile_offer__mutmut_1 (the `needs_review`
    DEFAULT flipped to True — every legacy no-kwarg call site would
    offer on any sub-threshold drift the auto stage never judged),
    {4,5,6,7,8,9} (status lookup neutered: a BALANCED statement offers),
    {12,13,14,15} (the BALANCED/RECONCILED vocabulary literals),
    16 (the terminal-status early return flipped), and {32..35}/{36..39}
    (which totals key feeds each side of the gate's max() denominator).

    x_compute_reconcile_offer__mutmut_10 (`or ""` -> `or "XXXX"`) is a
    documented equivalent — the fallback status only ever feeds the
    membership probe against ("BALANCED", "RECONCILED"), which contains
    neither sentinel (same family as the seven `or "XXXX"` equivalents
    already documented for this module)."""

    def test_default_kwarg_never_offers(self) -> None:
        # Offer-worthy drift, but the caller did not say needs_review:
        # the legacy call shape must stay silent.
        cbs = _cbs(assets=1000.0, equity=500.0, liabilities=499.0)
        assert compute_reconcile_offer(cbs) is False

    def test_needs_review_offers_on_gated_drift_assets_side(self) -> None:
        # diff 1.00 == exactly 0.1% of assets (the max side); zeroing
        # the assets key (mutants 32..35) collapses the denominator to
        # E+L (999.00) and refuses.
        cbs = _cbs(assets=1000.0, equity=500.0, liabilities=499.0)
        assert compute_reconcile_offer(cbs, needs_review=True) is True

    def test_needs_review_offers_on_gated_drift_el_side(self) -> None:
        # Mirror: E+L is the max side; zeroing the E+L key (mutants
        # 36..39) collapses the denominator to assets (999.00) and
        # refuses.
        cbs = _cbs(assets=999.0, equity=500.0, liabilities=500.0)
        assert compute_reconcile_offer(cbs, needs_review=True) is True

    def test_terminal_statuses_never_offer(self) -> None:
        # A BALANCED/RECONCILED statement must not offer even when the
        # totals still carry a gate-passing residual and the auto stage
        # flagged needs_review.
        for status in ("BALANCED", "RECONCILED"):
            cbs = _cbs(
                assets=1000.0, equity=500.0, liabilities=499.0, status=status
            )
            assert compute_reconcile_offer(cbs, needs_review=True) is False


class TestValidateProposalPrecision:
    """Kills x_validate_proposal__mutmut_{5..19} (INVALID payload),
    {41,51..53,60..69} (zero/above-gate rejection + payload + RON
    rendering), {31..34,36..38} (gate denominator key), {81..84,97}
    (the totals-vs-partition dual close — the validator's core defense),
    {103..106,113..124} (NONZERO_CLOSE payload + value rendering), and
    x__recompute_partition_difference_cents__mutmut_{5..8,10..13,20}
    (partition recompute neutered / sign-inverted — only the exact
    signed detail text distinguishes the inversion)."""

    @staticmethod
    def _closing_cbs():
        # totals diff +1.00; rows partition diff +1.00; amount 100 closes
        # both. Assets 1000.00 vs E+L 999.00: |amount|*1000 == 100000
        # passes against max()=assets but FAILS against E+L alone.
        return _cbs(
            assets=1000.0,
            equity=499.0,
            liabilities=500.0,
            current_liabilities=500.0,
            rows=[
                {"id": "a", "section": "current_assets", "amount": 1000.0},
                {"id": "l", "section": "current_liabilities", "amount": 500.0},
                {"id": "e", "section": "equity", "amount": 499.0},
            ],
            sections=[{"id": "current_liabilities", "subtotal": 500.0}],
        )

    def test_invalid_proposal_payload_exact(self) -> None:
        with pytest.raises(ReconcileRejected) as ei:
            validate_proposal(self._closing_cbs(), {"amount_cents": "abc"})
        assert ei.value.payload == _reject_payload(
            "VALIDATOR_INVALID_PROPOSAL",
            "proposal carries no integer amount_cents",
        )

    def test_zero_amount_rejected_at_gate(self) -> None:
        with pytest.raises(ReconcileRejected) as ei:
            validate_proposal(self._closing_cbs(), {"amount_cents": 0})
        assert ei.value.payload == _reject_payload(
            "VALIDATOR_AMOUNT_ABOVE_GATE",
            "proposed adjustment 0.00 RON is zero or exceeds 0.1% of the "
            "balance sheet",
        )

    def test_oversized_amount_payload_exact(self) -> None:
        with pytest.raises(ReconcileRejected) as ei:
            validate_proposal(self._closing_cbs(), {"amount_cents": 500000})
        assert ei.value.payload == _reject_payload(
            "VALIDATOR_AMOUNT_ABOVE_GATE",
            "proposed adjustment 5000.00 RON is zero or exceeds 0.1% of "
            "the balance sheet",
        )

    def test_exact_close_accepts_against_assets_denominator(self) -> None:
        assert validate_proposal(self._closing_cbs(), {"amount_cents": 100}) == 100

    def test_exact_close_accepts_against_el_denominator(self) -> None:
        # Mirror: E+L is the larger side; assets alone would refuse the
        # 100-cent amount at the 0.1% gate.
        cbs = _cbs(
            assets=999.0,
            equity=500.0,
            liabilities=500.0,
            current_assets=999.0,
            rows=[
                {"id": "a", "section": "current_assets", "amount": 999.0},
                {"id": "l", "section": "current_liabilities", "amount": 500.0},
                {"id": "e", "section": "equity", "amount": 500.0},
            ],
        )
        assert validate_proposal(cbs, {"amount_cents": -100}) == -100

    def test_totals_open_rows_closed_still_rejects(self) -> None:
        # Rows close under the adjustment but the totals do not: the
        # validator must reject — accepting on either check alone is the
        # exact bug the AND-mutant introduces.
        cbs = _cbs(
            assets=1000.0,
            equity=499.0,
            liabilities=500.0,  # totals diff +1.00
            rows=[
                {"id": "a", "section": "current_assets", "amount": 1000.0},
                {"id": "l", "section": "current_liabilities", "amount": 999.5},
            ],  # partition diff +0.50
            sections=[],
        )
        with pytest.raises(ReconcileRejected) as ei:
            validate_proposal(cbs, {"amount_cents": 50})
        assert ei.value.payload == _reject_payload(
            "VALIDATOR_NONZERO_CLOSE",
            "adjusted statement does not close to exactly 0.00: totals "
            "0.50 RON, partition 0.00 RON",
        )

    def test_rows_open_totals_closed_still_rejects_with_signed_detail(self) -> None:
        cbs = _cbs(
            assets=1000.0,
            equity=499.0,
            liabilities=500.0,  # totals diff +1.00 — amount 100 closes it
            rows=[
                {"id": "a", "section": "current_assets", "amount": 1000.0},
                {"id": "l", "section": "current_liabilities", "amount": 998.99},
            ],  # partition diff +1.01 — adjustment leaves +0.01
            sections=[],
        )
        with pytest.raises(ReconcileRejected) as ei:
            validate_proposal(cbs, {"amount_cents": 100})
        # The signed partition value pins the asset-section membership
        # DIRECTION (the `in`->`not in` recompute inversion flips it to
        # -0.01 and a plain nonzero check would never notice).
        assert ei.value.payload == _reject_payload(
            "VALIDATOR_NONZERO_CLOSE",
            "adjusted statement does not close to exactly 0.00: totals "
            "0.00 RON, partition 0.01 RON",
        )

    def test_nonzero_close_render_magnitude_exact(self) -> None:
        # Kills x_validate_proposal__mutmut_122 and __mutmut_124 (the
        # NONZERO_CLOSE cents→RON renders, /100.0 -> /101.0). The 1-cent
        # fixtures above cannot see them: %.2f of 1/101 still rounds to
        # "0.01" and 0 is scaling-invariant. At a full RON on each half
        # the mutants render "0.99"/"-0.99" instead of "1.00"/"-1.00".
        cbs = _cbs(
            assets=10000.0,
            equity=4998.50,
            liabilities=4998.50,  # totals diff +3.00 — amount 200 leaves +1.00
            rows=[
                {"id": "a", "section": "current_assets", "amount": 10000.0},
                {"id": "l", "section": "current_liabilities", "amount": 9999.0},
            ],  # partition diff +1.00 — amount 200 leaves -1.00
            sections=[],
        )
        with pytest.raises(ReconcileRejected) as ei:
            validate_proposal(cbs, {"amount_cents": 200})
        assert ei.value.payload == _reject_payload(
            "VALIDATOR_NONZERO_CLOSE",
            "adjusted statement does not close to exactly 0.00: totals "
            "1.00 RON, partition -1.00 RON",
        )


class TestApplyAdjustmentShape:
    """Kills the x__apply_adjustment survivor families: initial totals
    reads {22..30}, _bump_section append shape {60..66}, synthetic-row
    dict shape {72..75,85,86}, section-targeted insert position
    {94..98,100,102,103}, PL-without-result-row fallback
    {112,139..144,149,150}, sign/branch boundaries {159,174,175,
    183..189,193..195}, and the served/totals key + cents→RON rendering
    set {200,201,210..213,220..231,235,237} — via FULL-DICT equality of
    the applied result in all four scenarios."""

    def test_bs_positive_full_shape(self) -> None:
        cbs = _cbs(
            assets=100.0,
            equity=40.0,
            liabilities=57.5,
            current_assets=30.0,
            current_liabilities=20.0,
            rows=[
                {"id": "fixed", "section": "non_current_assets", "amount": 70.0},
                {"id": "stock", "section": "current_assets", "amount": 30.0},
                {"id": "payables", "section": "current_liabilities", "amount": 20.0},
                {"id": "eq", "section": "equity", "amount": 40.0},
            ],
            # current_liabilities deliberately ABSENT -> append path
            sections=[
                {"id": "current_assets", "subtotal": 30.0},
                {"id": "equity", "subtotal": 40.0},
            ],
        )
        out = _apply_adjustment(copy.deepcopy(cbs), 250, receipt={"r": 1})
        synthetic = {
            "id": SYNTHETIC_ROW_ID,
            "section": "current_liabilities",
            "label_key": "bs.row.%s" % SYNTHETIC_ROW_ID,
            "label": SYNTHETIC_ROW_LABEL,
            "account_codes": [],
            "amount": 2.5,
            "opening": None,
            "leaf_ids": [],
            "synthetic": True,
        }
        assert out == {
            "status": "RECONCILED",
            "difference": 0.0,
            "totals": {
                "assets": 100.0,
                "equity": 40.0,
                "liabilities": 60.0,
                "equity_plus_liabilities": 100.0,
                "current_assets": 30.0,
                "current_liabilities": 22.5,
            },
            "rows": [
                cbs["rows"][0],
                cbs["rows"][1],
                cbs["rows"][2],
                synthetic,  # directly after the LAST current_liabilities row
                cbs["rows"][3],
            ],
            "sections": [
                {"id": "current_assets", "subtotal": 30.0},
                {"id": "equity", "subtotal": 40.0},
                {"id": "current_liabilities", "subtotal": 2.5},
            ],
            "reconciliation": {"r": 1},
        }

    def test_bs_one_cent_goes_to_liabilities_side(self) -> None:
        cbs = _cbs(assets=100.0, equity=50.0, liabilities=49.99)
        out = _apply_adjustment(copy.deepcopy(cbs), 1, receipt=None)
        rows = [r for r in out["rows"] if r.get("synthetic")]
        assert len(rows) == 1 and rows[0]["section"] == "current_liabilities"
        assert rows[0]["amount"] == 0.01
        assert out["difference"] == 0.0

    def test_bs_negative_full_shape(self) -> None:
        cbs = _cbs(
            assets=100.0,
            equity=40.0,
            liabilities=62.5,
            current_assets=30.0,
            current_liabilities=25.0,
            rows=[
                {"id": "fixed", "section": "non_current_assets", "amount": 70.0},
                {"id": "stock", "section": "current_assets", "amount": 30.0},
                {"id": "payables", "section": "current_liabilities", "amount": 25.0},
            ],
            sections=[{"id": "current_assets", "subtotal": 30.0}],
        )
        out = _apply_adjustment(copy.deepcopy(cbs), -250, receipt=None)
        assert [r["id"] for r in out["rows"]] == [
            "fixed", "stock", SYNTHETIC_ROW_ID, "payables",
        ]
        syn = out["rows"][2]
        assert syn["section"] == "current_assets" and syn["amount"] == 2.5
        assert out["sections"] == [{"id": "current_assets", "subtotal": 32.5}]
        assert out["totals"] == {
            "assets": 102.5,
            "equity": 40.0,
            "liabilities": 62.5,
            "equity_plus_liabilities": 102.5,
            "current_assets": 32.5,
            "current_liabilities": 25.0,
        }
        assert out["difference"] == 0.0 and out["status"] == "RECONCILED"

    def test_pl_with_result_row_adjusts_result(self) -> None:
        cbs = _cbs(
            assets=100.0,
            equity=40.0,
            liabilities=57.5,
            rows=[
                {"id": "a", "section": "current_assets", "amount": 100.0},
                {"id": "current_year_profit", "section": "equity", "amount": 10.0},
            ],
            sections=[{"id": "equity", "subtotal": 40.0}],
        )
        out = _apply_adjustment(copy.deepcopy(cbs), 250, receipt=None,
                                placement=PLACEMENT_PL)
        result = out["rows"][1]
        assert result["amount"] == 12.5
        assert result["reconciliation_delta"] == 2.5
        assert result["reconciliation_note"] == SYNTHETIC_ROW_LABEL
        assert all(not r.get("synthetic") for r in out["rows"])
        assert out["sections"] == [{"id": "equity", "subtotal": 42.5}]
        assert out["totals"]["equity"] == 42.5
        assert out["totals"]["equity_plus_liabilities"] == 100.0
        assert out["difference"] == 0.0

    def test_pl_without_result_row_falls_back_to_equity_synthetic(self) -> None:
        cbs = _cbs(
            assets=100.0,
            equity=40.0,
            liabilities=57.5,
            rows=[{"id": "a", "section": "current_assets", "amount": 100.0}],
            sections=[{"id": "current_assets", "subtotal": 100.0}],
        )
        out = _apply_adjustment(copy.deepcopy(cbs), 250, receipt=None,
                                placement=PLACEMENT_PL)
        syn = [r for r in out["rows"] if r.get("synthetic")]
        assert len(syn) == 1
        assert syn[0]["section"] == "equity" and syn[0]["amount"] == 2.5
        assert {"id": "equity", "subtotal": 2.5} in out["sections"]
        assert out["totals"]["equity"] == 42.5
        assert out["difference"] == 0.0


class TestApplyAdjustmentNonClosing:
    """Kills x__apply_adjustment__mutmut_{235,237} and
    x__cents__mutmut_8. Every closing scenario has difference == 0,
    which is invariant under any scaling — only a NON-closing apply
    exposes the cents→RON conversion of the served `difference` (the
    function itself never validates; the validator does)."""

    def test_partial_adjustment_reports_remaining_difference(self) -> None:
        cbs = _cbs(assets=100.0, equity=40.0, liabilities=57.5)  # diff 2.50
        out = _apply_adjustment(copy.deepcopy(cbs), 100, receipt=None)
        assert out["totals"]["equity_plus_liabilities"] == 98.5
        assert out["difference"] == 1.5

    def test_cents_unparseable_falls_back_to_zero(self) -> None:
        from engine.api._reconcile import _cents

        assert _cents("not-a-number") == 0
        assert _cents({"nested": 1}) == 0
        assert _cents(None) == 0
        assert _cents("12.34") == 1234
        assert _cents(-0.005) == 0  # round-half-even at the cent boundary


class TestPlacementFor:
    """Kills x__placement_for__mutmut_{15,18} — the one-cent P&L cause
    must still route to the P&L with the right income/expense side."""

    def test_one_cent_class6_routes_pl(self) -> None:
        assert _placement_for({"target_account": "601"}, 1) == (
            PLACEMENT_PL, PLACEMENT_DETAIL_PL_INCOME,
        )
        assert _placement_for({"target_account": "601"}, -1) == (
            PLACEMENT_PL, PLACEMENT_DETAIL_PL_EXPENSE,
        )

    def test_class7_and_bs_targets(self) -> None:
        assert _placement_for({"target_account": "7588"}, 500) == (
            PLACEMENT_PL, PLACEMENT_DETAIL_PL_INCOME,
        )
        assert _placement_for({"target_account": "4111"}, 500) == (
            PLACEMENT_BS, PLACEMENT_DETAIL_BS,
        )
        assert _placement_for({"target_account": ""}, 500) == (
            PLACEMENT_BS, PLACEMENT_DETAIL_BS,
        )


# ── engine.passes.classify ─────────────────────────────────────────────

import engine.country_packs.ro_romania  # noqa: E402,F401 — registers RomaniaPack
from engine.ir import (  # noqa: E402
    AccountAtom,
    DocHeader,
    LedgerDoc,
    Provenance,
    SourceRef,
)
from engine.packs.runtime import active_pack  # noqa: E402
from engine.passes.classify import (  # noqa: E402
    METHOD_RULE,
    METHOD_UNCLASSIFIED,
    AtomClassification,
    ClassifyError,
    _minor_at,
    _net_signed_minor,
    classify,
    effective_closing_side,
)


def _catom(atom_id, code="5121", **money_slots):
    return AccountAtom(
        atom_id=atom_id,
        account_code=code,
        label="Cont %s" % code,
        provenance=Provenance.mechanical(SourceRef.cell("S", 1, 0)),
        **money_slots,
    )


def _cdoc(*atoms):
    return LedgerDoc(
        header=DocHeader(jurisdiction="RO", currency="RON"), atoms=tuple(atoms)
    )


def _evil_classify_doc(base_atoms, replacement_atoms, swap_from_read):
    """A LedgerDoc whose .atoms swaps to `replacement_atoms` from the
    Nth read on — same TOCTOU technique as test_assertion_witnesses
    (read 1 = LedgerDoc.__post_init__, 2 = the classify loop, 3 = the
    A-025 census re-read, 4 = the A-026 zip)."""
    reads = {"n": 0}

    class EvilDoc(LedgerDoc):
        def __getattribute__(self, name):
            if name == "atoms":
                reads["n"] += 1
                if reads["n"] >= swap_from_read:
                    return replacement_atoms
            return object.__getattribute__(self, name)

    return EvilDoc(
        header=DocHeader(jurisdiction="RO", currency="RON"),
        atoms=tuple(base_atoms),
    )


@pytest.fixture(scope="module")
def ro_pack():
    return active_pack("RO")


class TestClassifyRescaleExact:
    """Kills x__minor_at__mutmut_2 (`return 0` -> 1 for an ABSENT slot —
    every absent Money would contribute one phantom minor unit),
    __mutmut_13 (the rescale exponent `scale - money.scale` ->
    `scale + money.scale`: at equal scales the multiplier becomes
    10^(2*scale) instead of 1 — grossly wrong yet invisible to any
    oracle that only compares two identically-scaled lanes), and
    x__net_signed_minor__mutmut_4 (`return 0` -> 1 for the no-monies
    case) / __mutmut_9 (`total +=` -> `total =`: only the LAST pair's
    contribution survives the sum)."""

    def test_minor_at_exact_values(self) -> None:
        assert _minor_at(None, 2) == 0
        assert _minor_at(Money.from_minor("RON", 123), 2) == 123
        assert _minor_at(Money.from_minor("RON", 123), 3) == 1230
        assert _minor_at(Money.from_minor("RON", -7), 4) == -700

    def test_net_signed_minor_empty_is_zero(self) -> None:
        assert _net_signed_minor(()) == 0
        assert _net_signed_minor(((None, None),)) == 0

    def test_net_signed_minor_accumulates_all_pairs(self) -> None:
        pairs = (
            (Money.from_minor("RON", 100), None),
            (Money.from_minor("RON", 5), Money.from_minor("RON", 2)),
        )
        assert _net_signed_minor(pairs) == 103


class TestClassifySideBoundary:
    """Kills x_effective_closing_side__mutmut_1 (`or` -> `and` on the
    closing-pair presence probe: a ONE-SIDED closing pair — the normal
    shape for RAS trial balances — would fall through to the
    opening+period identity and report None) and __mutmut_9
    (`net > 0` -> `net > 1`: a net closing balance of exactly one minor
    unit loses its side)."""

    def test_one_sided_closing_pair_one_minor_unit(self) -> None:
        assert (
            effective_closing_side(
                _catom("a", closing_debit=Money.from_minor("RON", 1))
            )
            == "debit"
        )
        assert (
            effective_closing_side(
                _catom("b", closing_credit=Money.from_minor("RON", 1))
            )
            == "credit"
        )

    def test_zero_net_and_identity_fallback(self) -> None:
        assert (
            effective_closing_side(
                _catom(
                    "c",
                    closing_debit=Money.from_minor("RON", 5),
                    closing_credit=Money.from_minor("RON", 5),
                )
            )
            is None
        )
        # No closing pair at all -> the opening+period identity.
        assert (
            effective_closing_side(
                _catom(
                    "d",
                    opening_debit=Money.from_minor("RON", 10),
                    period_credit=Money.from_minor("RON", 3),
                )
            )
            == "debit"
        )


class TestClassifyErrorMessageContract:
    """Kills x_classify__mutmut_{2..7} and {9..14} (the two ClassifyError
    input-guard messages: None payload, `%` -> `/` (raises TypeError
    instead of ClassifyError), XX-wraps, case flips, type(None)
    substitutions). The message names the offending type — that is the
    debugging surface, same contract as Money's typed errors."""

    def test_wrong_doc_type_message_exact(self, ro_pack) -> None:
        with pytest.raises(ClassifyError) as ei:
            classify(42, ro_pack)
        assert str(ei.value) == "classify takes a LedgerDoc, got int"

    def test_wrong_pack_type_message_exact(self) -> None:
        with pytest.raises(ClassifyError) as ei:
            classify(_cdoc(_catom("a1", "5121")), "nope")
        assert str(ei.value) == "classify takes a CompiledPack, got str"


class TestClassifyEntryShape:
    """Full-equality pinning of the emitted AtomClassification entries.
    Kills x_classify__mutmut_27/28/36/38 (the UNCLASSIFIED branch's
    side_flipped/closing_side corrupted to None/True/dropped) and
    __mutmut_41 (`flipped = False` -> None in the rule branch).
    x_classify__mutmut_35 (dropping the `side_flipped=False` kwarg) is a
    documented equivalent — False IS the dataclass default, so the
    constructed entry is identical (see mutation.md)."""

    def test_unmatched_atom_entry_exact(self, ro_pack) -> None:
        doc = _cdoc(
            _catom("u1", "9999", closing_debit=Money.from_minor("RON", 500))
        )
        layer = classify(doc, ro_pack)
        assert layer.pack_hash == ro_pack.pack_hash
        assert layer.entries == (
            AtomClassification(
                atom_id="u1",
                account_code="9999",
                line_id=None,
                rule_id=None,
                method=METHOD_UNCLASSIFIED,
                confidence=1.0,
                side_flipped=False,
                closing_side="debit",
            ),
        )

    def test_matched_entry_exact_no_flip_rule(self, ro_pack) -> None:
        # 8035 matches a rule WITHOUT a side_flip: the cleanest probe
        # that the rule branch emits side_flipped=False (not None/True).
        rule = ro_pack.match("8035")
        assert rule is not None and rule.side_flip is None
        doc = _cdoc(
            _catom("m1", "8035", closing_debit=Money.from_minor("RON", 100))
        )
        assert classify(doc, ro_pack).entries == (
            AtomClassification(
                atom_id="m1",
                account_code="8035",
                line_id=rule.line_id,
                rule_id=rule.rule_id,
                method=METHOD_RULE,
                confidence=1.0,
                side_flipped=False,
                closing_side="debit",
            ),
        )

    def test_flip_fires_only_on_the_flip_side(self, ro_pack) -> None:
        rule = ro_pack.match("4111")
        assert rule is not None and rule.side_flip is not None
        flip = _cdoc(
            _catom("f1", "4111", closing_credit=Money.from_minor("RON", 100))
        )
        assert classify(flip, ro_pack).entries[0] == AtomClassification(
            atom_id="f1",
            account_code="4111",
            line_id=rule.side_flip.line_id,
            rule_id=rule.rule_id,
            method=METHOD_RULE,
            confidence=1.0,
            side_flipped=True,
            closing_side="credit",
        )
        noflip = _cdoc(
            _catom("f2", "4111", closing_debit=Money.from_minor("RON", 100))
        )
        entry = classify(noflip, ro_pack).entries[0]
        assert entry.side_flipped is False
        assert entry.line_id == rule.line_id


class TestClassifyAssertMessagePrecision:
    """The A-020..A-026 witness tests match the id SUBSTRING, which
    XX-wraps and case flips still satisfy (the same gap money's A-00x
    messages had). The catalog says the id is the identity — id + exact
    full message is now pinned. Kills x__minor_at__mutmut_8,
    x__net_signed_minor__mutmut_{23,26..31},
    xǁAtomClassificationǁ__post_init____mutmut_{3,10,13,14,16,17,27,29,30},
    x_classify__mutmut_{71,74,82,84,85,86}, and the A-024 domain-clause
    mutants __post_init____mutmut_{21,22} via the boundary
    constructions."""

    def test_a020_message_exact(self) -> None:
        with pytest.raises(AssertionError) as ei:
            _minor_at(Money.from_minor("RON", 5), 1)
        assert str(ei.value) == (
            "A-020: _minor_at target scale 1 must be >= the Money's own "
            "scale 2 — a coarser rescale is lossy and float-producing"
        )

    def test_a021_message_exact(self) -> None:
        bad = _corrupt(Money.from_minor("RON", 100), amount_minor=1.0)
        with pytest.raises(AssertionError) as ei:
            _net_signed_minor(((bad, None),))
        assert str(ei.value) == (
            "A-021: _net_signed_minor must produce an exact int, got float — a "
            "float here means a corrupted Money leaked into the side "
            "computation"
        )

    def test_a022_message_exact(self) -> None:
        with pytest.raises(AssertionError) as ei:
            AtomClassification(
                atom_id="x",
                account_code="1",
                line_id=None,
                rule_id=None,
                method=METHOD_RULE,
                confidence=1.0,
            )
        assert str(ei.value) == (
            "A-022: UNCLASSIFIED marker coherence violated for atom 'x' — "
            "line_id is None while method is 'rule' (line_id None <=> method "
            "'unclassified', never guessed, never dropped)"
        )

    def test_a023_message_exact(self) -> None:
        with pytest.raises(AssertionError) as ei:
            AtomClassification(
                atom_id="x",
                account_code="1",
                line_id=None,
                rule_id=None,
                method="banana",
                confidence=1.0,
            )
        assert str(ei.value) == (
            "A-023: AtomClassification.method must be 'rule' or "
            "'unclassified', got 'banana'"
        )

    def test_a024_message_exact(self) -> None:
        with pytest.raises(AssertionError) as ei:
            AtomClassification(
                atom_id="x",
                account_code="1",
                line_id=None,
                rule_id=None,
                method=METHOD_UNCLASSIFIED,
                confidence="high",
            )
        assert str(ei.value) == (
            "A-024: AtomClassification.confidence must be a number in "
            "[0, 1], got 'high'"
        )

    def test_confidence_domain_boundaries_construct(self) -> None:
        # 0.0 and 1.0 are both LEGAL confidences (A-024 is inclusive):
        # the lower-bound clause mutants (0.0 -> 1.0, <= -> <) must
        # reject these valid constructions and die here.
        for conf in (0.0, 0.5, 1.0):
            entry = AtomClassification(
                atom_id="x",
                account_code="1",
                line_id="ln",
                rule_id="r",
                method=METHOD_RULE,
                confidence=conf,
            )
            assert entry.confidence == conf

    def test_a025_message_exact(self, ro_pack) -> None:
        base = (_catom("a1", "5121"), _catom("a2", "401"))
        grown = base + (_catom("a3", "212"),)
        doc = _evil_classify_doc(base, grown, swap_from_read=3)
        with pytest.raises(AssertionError) as ei:
            classify(doc, ro_pack)
        assert str(ei.value) == (
            "A-025: classify must emit exactly one entry per atom — 2 "
            "entries for 3 atoms (atoms dropped or invented)"
        )

    def test_a026_message_exact(self, ro_pack) -> None:
        base = (_catom("a1", "5121"), _catom("a2", "401"))
        swapped = (base[1], base[0])
        doc = _evil_classify_doc(base, swapped, swap_from_read=3)
        with pytest.raises(AssertionError) as ei:
            classify(doc, ro_pack)
        assert str(ei.value) == (
            "A-026: classify entries must align 1:1 with doc.atoms in "
            "document order — atom_id sequence diverged"
        )


# ── engine.journal.journal (hash-chain scope) ──────────────────────────

import json  # noqa: E402
import re  # noqa: E402
import shutil  # noqa: E402

from engine.journal.journal import (  # noqa: E402
    Journal,
    extract_snapshot_key,
    sanitize_key,
)


def _env(**over):
    base = {
        "provenance": {"content_hash": "fh-1", "source_document_id": "doc-1"},
        "canonical_bs": {
            "mapping_version": "map-7",
            "extraction": {"parser_version": "tbp-5"},
        },
        "pack_provenance": {"pack_hash": "packh-9"},
        "assembled": 1,
        "written_at": "2026-01-01T00:00:00+00:00",  # volatile key
    }
    base.update(over)
    return base


class TestJournalRegistrationAndLinkage:
    """Kills xǁJournalǁbegin_run__mutmut_{1..6,35,36,47..56},
    xǁRunHandleǁ_ensure_registered__mutmut_{5,6,7,20..25},
    xǁJournalǁ_run_path/_index_path__mutmut_4 — the document-index
    entry IS the chain's registration record and the cross-run linkage
    (prev_run_id + tail-seeded prev_event_hash) IS the chain."""

    def test_index_entry_exact_and_cross_run_linkage(self, tmp_path) -> None:
        j = Journal(tmp_path / "j")
        h1 = j.begin_run(file_hash="fh-1", document_id="doc-1", engine_version="e-1")
        h1.emit("PASS_DONE", {"stage": "parse"})
        h2 = j.begin_run(
            file_hash="fh-1", document_id="doc-1", engine_version="e-1",
            run_kind="adhoc",
        )
        entries = j.registered_runs("fh-1")
        assert len(entries) == 2
        started = entries[0].pop("started_at")
        assert re.match(r"\d{4}-\d{2}-\d{2}T", started)
        assert entries[0] == {
            "v": 1,
            "kind": "run",
            "run_id": h1.run_id,
            "file_hash": "fh-1",
            "document_id": "doc-1",
            "run_kind": "pipeline",
            "engine_version": "e-1",
            "prev_run_id": None,
        }
        entries[1].pop("started_at")
        assert entries[1] == {
            "v": 1,
            "kind": "run",
            "run_id": h2.run_id,
            "file_hash": "fh-1",
            "document_id": "doc-1",
            "run_kind": "adhoc",
            "engine_version": "e-1",
            "prev_run_id": h1.run_id,
        }
        # chain linkage: run2's first event links to run1's tail hash
        tail_of_run1 = j.read_run(h1.run_id)[-1]["event_hash"]
        assert j.read_run(h2.run_id)[0]["prev_event_hash"] == tail_of_run1
        # storage layout is part of the chain's addressing
        assert (j.root / "runs" / ("%s.jsonl" % h1.run_id)).is_file()
        assert (j.root / "index" / "fh-1.jsonl").is_file()

    def test_resume_runs_are_provisional_after_a_snapshot(self, tmp_path) -> None:
        j = Journal(tmp_path / "j")
        h1 = j.begin_run(file_hash="fh-1", document_id="d", engine_version="e")
        h1.record_snapshot(_env(), period_id="p1")
        h_resume = j.begin_run(
            file_hash="fh-1", document_id="d", engine_version="e",
            run_kind="resume",
        )
        assert h_resume.provisional is True
        h_adhoc = j.begin_run(
            file_hash="fh-1", document_id="d", engine_version="e",
            run_kind="adhoc",
        )
        assert h_adhoc.provisional is False


class TestJournalFlushSemantics:
    """Kills xǁRunHandleǁflush__mutmut_{2,3,4,5,6,7,8} and
    xǁRunHandleǁemit__mutmut_21 — a provisional run buffers, flush
    promotes IN ORDER exactly once, later emits append directly."""

    def test_provisional_buffers_then_flushes_in_order(self, tmp_path) -> None:
        j = Journal(tmp_path / "j")
        h1 = j.begin_run(file_hash="fh-1", document_id="d", engine_version="e")
        h1.record_snapshot(_env(), period_id="p1")

        h2 = j.begin_run(file_hash="fh-1", document_id="d", engine_version="e")
        assert h2.provisional
        h2.emit("PASS_DONE", {"stage": "classify"})
        run_file = j.root / "runs" / ("%s.jsonl" % h2.run_id)
        assert not run_file.exists()  # buffered, not durable yet
        h2.flush()
        events = j.read_run(h2.run_id)
        assert [e["type"] for e in events] == ["RUN_STARTED", "PASS_DONE"]
        h2.flush()  # idempotent
        assert len(j.read_run(h2.run_id)) == 2
        h2.emit("PASS_DONE", {"stage": "assemble"})  # durable now
        assert len(j.read_run(h2.run_id)) == 3


class TestDuplicateDeliveryContract:
    """Kills xǁRunHandleǁrecord_snapshot__mutmut_{3..34,51,52,69,83..99}
    and xǁRunHandleǁflush__mutmut_1 — the K3 duplicate short-circuit's
    RESULT DICT (both branches) and its detection condition, pinned
    exactly."""

    def test_duplicate_result_dict_exact_both_branches(self, tmp_path) -> None:
        j = Journal(tmp_path / "j")
        h1 = j.begin_run(file_hash="fh-1", document_id="d", engine_version="e")
        r1 = h1.record_snapshot(_env(), period_id="p1")
        assert r1["duplicate"] is False

        h2 = j.begin_run(file_hash="fh-1", document_id="d", engine_version="e")
        dup_env = _env(written_at="2026-02-02T00:00:00+00:00")  # volatile only
        expected = {
            "duplicate": True,
            "snapshot_id": r1["snapshot_id"],
            "content_hash": r1["content_hash"],
            "normalized_hash": r1["normalized_hash"],
            "run_id": h1.run_id,
        }
        assert h2.record_snapshot(dup_env) == expected
        # second call rides the short-circuited early return — same dict
        assert h2.record_snapshot(dup_env) == expected
        # a short-circuited run must never become durable
        h2.flush()
        assert not (j.root / "runs" / ("%s.jsonl" % h2.run_id)).exists()
        snapshots = [
            e for e in j.chain_events("fh-1") if e["type"] == "SNAPSHOT_PERSISTED"
        ]
        assert len(snapshots) == 1

    def test_distinct_state_same_key_is_not_duplicate(self, tmp_path) -> None:
        j = Journal(tmp_path / "j")
        h1 = j.begin_run(file_hash="fh-1", document_id="d", engine_version="e")
        r1 = h1.record_snapshot(_env(), period_id="p1")
        h2 = j.begin_run(file_hash="fh-1", document_id="d", engine_version="e")
        r2 = h2.record_snapshot(_env(assembled=2))  # REAL field changed
        assert r2["duplicate"] is False
        assert r2["snapshot_id"] != r1["snapshot_id"]
        snapshots = [
            e for e in j.chain_events("fh-1") if e["type"] == "SNAPSHOT_PERSISTED"
        ]
        assert len(snapshots) == 2


class TestSnapshotCommitShape:
    """Kills xǁRunHandleǁrecord_snapshot__mutmut_{1,2,109,123..130,
    139..150,164..173} and x_extract_snapshot_key__mutmut_{1..25} —
    the SNAPSHOT_PERSISTED payload, the returned commit dict, the
    period index line, and the dedup key halves, all exact."""

    def test_snapshot_event_payload_and_result_exact(self, tmp_path) -> None:
        from engine.journal.events import canonical_bytes, hash_bytes, normalized_hash

        j = Journal(tmp_path / "j")
        env = _env()
        h1 = j.begin_run(file_hash="fh-1", document_id="doc-1", engine_version="e")
        r1 = h1.record_snapshot(env, period_id="p1")

        exact_hash = hash_bytes(canonical_bytes(env)[0])
        assert set(r1.keys()) == {
            "duplicate", "snapshot_id", "content_hash", "normalized_hash",
            "run_id", "event",
        }
        assert r1["duplicate"] is False
        assert re.fullmatch(r"snap_[0-9a-f]{16}", r1["snapshot_id"])
        assert r1["content_hash"] == exact_hash
        assert r1["normalized_hash"] == normalized_hash(env)
        assert r1["run_id"] == h1.run_id

        payload = r1["event"]["payload"]
        assert payload == {
            "snapshot_id": r1["snapshot_id"],
            "content_hash": exact_hash,
            "normalized_hash": r1["normalized_hash"],
            "period_id": "p1",
            "origin": "pipeline",
            "key": {
                "parser_version": "tbp-5",
                "mapping_version": "map-7",
                "pack_hash": "packh-9",
            },
            "lossy": False,
        }
        # period lookup aid, exact line
        assert {
            "v": 1, "kind": "period", "period_id": "p1", "run_id": h1.run_id,
        } in j.read_index("fh-1")

    def test_extract_snapshot_key_defensive_shapes(self) -> None:
        assert extract_snapshot_key(_env()) == {
            "parser_version": "tbp-5",
            "mapping_version": "map-7",
            "pack_hash": "packh-9",
        }
        assert extract_snapshot_key({}) == {
            "parser_version": None, "mapping_version": None, "pack_hash": None,
        }
        assert extract_snapshot_key("not-a-dict") == {  # type: ignore[arg-type]
            "parser_version": None, "mapping_version": None, "pack_hash": None,
        }


class TestVerifyChainReporting:
    """Kills xǁJournalǁverify_chain__mutmut_{6,7,8,17..21,24,25,27..32,
    40..46,49..52,58..69,74..79,88,93..99,102..108} — the verifier's
    error list is the chain's audit report: every defect names its run,
    seq and offending value, and one defect must never stop the scan."""

    def test_unknown_chain_message_exact(self, tmp_path) -> None:
        j = Journal(tmp_path / "j")
        assert j.verify_chain("ghost") == ["no runs registered for chain ghost"]

    def test_missing_run_file_does_not_stop_the_scan(self, tmp_path) -> None:
        j = Journal(tmp_path / "j")
        h1 = j.begin_run(file_hash="fh-1", document_id="d", engine_version="e")
        h1.emit("PASS_DONE", {"stage": "parse"})
        (j.root / "runs" / ("%s.jsonl" % h1.run_id)).unlink()
        h2 = j.begin_run(file_hash="fh-1", document_id="d", engine_version="e",
                         run_kind="adhoc")
        h2.emit("PASS_DONE", {"stage": "parse"})
        # tamper run2's LAST event so the scan must reach and report it
        run2 = j.root / "runs" / ("%s.jsonl" % h2.run_id)
        lines = run2.read_text(encoding="utf-8").splitlines()
        ev = json.loads(lines[-1])
        ev["event_hash"] = "deadbeef"
        lines[-1] = json.dumps(ev, sort_keys=True, ensure_ascii=False,
                               separators=(",", ":"))
        run2.write_text("\n".join(lines) + "\n", encoding="utf-8")
        from engine.journal.events import _hash_basis, hash_bytes

        expected_recomputed = hash_bytes(_hash_basis(ev))
        errors = j.verify_chain("fh-1")
        assert errors == [
            "run %s registered but has no event file" % h1.run_id,
            "event_hash mismatch (run %s seq 1): stored deadbeef != "
            "recomputed %s" % (h2.run_id, expected_recomputed),
        ]

    def test_corrupt_line_reported_and_chain_recovers(self, tmp_path) -> None:
        j = Journal(tmp_path / "j")
        h = j.begin_run(file_hash="fh-1", document_id="d", engine_version="e")
        first = j.read_run(h.run_id)[0]
        run_path = j.root / "runs" / ("%s.jsonl" % h.run_id)
        with open(str(run_path), "a", encoding="utf-8") as fh:
            fh.write("{this is not json\n")
        h.emit("PASS_DONE", {"stage": "parse"})  # seq 1, prev = first's hash
        errors = j.verify_chain("fh-1")
        assert errors == [
            "run %s: unparseable line" % h.run_id,
            # after a corrupt line the verifier resets its expectation to
            # None; the next (valid) event names its real stored prev.
            "run %s seq 1: prev_event_hash broken link (stored %r != "
            "expected None)" % (h.run_id, first["event_hash"]),
        ]

    def test_seq_gap_message_and_recovery_exact(self, tmp_path) -> None:
        from engine.journal.events import make_event

        j = Journal(tmp_path / "j")
        h = j.begin_run(file_hash="fh-1", document_id="d", engine_version="e")
        first = j.read_run(h.run_id)[0]
        gap = make_event(
            run_id=h.run_id, seq=5, ts="2026-01-01T00:00:00+00:00",
            event_type="PASS_DONE", payload={"stage": "x"},
            prev_event_hash=first["event_hash"],
        )
        nxt = make_event(
            run_id=h.run_id, seq=6, ts="2026-01-01T00:00:01+00:00",
            event_type="PASS_DONE", payload={"stage": "y"},
            prev_event_hash=gap["event_hash"],
        )
        run_path = j.root / "runs" / ("%s.jsonl" % h.run_id)
        with open(str(run_path), "a", encoding="utf-8") as fh:
            for ev in (gap, nxt):
                fh.write(json.dumps(ev, sort_keys=True, ensure_ascii=False,
                                    separators=(",", ":")) + "\n")
        # exactly ONE gap error: 0 -> 5 gaps, then 5 -> 6 is contiguous
        assert j.verify_chain("fh-1") == [
            "run %s: seq gap (expected 1, found 5)" % h.run_id,
        ]

    def test_snapshot_object_missing_and_corrupt_exact(self, tmp_path) -> None:
        j = Journal(tmp_path / "j")
        h = j.begin_run(file_hash="fh-1", document_id="d", engine_version="e")
        r = h.record_snapshot(_env(), period_id="p1")
        digest = r["content_hash"]
        snap_seq = r["event"]["seq"]
        obj_path = j.store._path_for(digest)
        obj_path.unlink()
        assert j.verify_chain("fh-1") == [
            "run %s seq %s: snapshot object %s missing from store"
            % (h.run_id, snap_seq, digest),
        ]
        obj_path.write_bytes(b"garbage bytes")
        assert j.verify_chain("fh-1") == [
            "run %s seq %s: snapshot object %s corrupt: snapshot object "
            "%s failed content re-verification"
            % (h.run_id, snap_seq, digest, digest),
        ]


class TestObserveServing:
    """Kills xǁJournalǁobserve_serving__mutmut_{1,31..33,39..46,57,
    67,68,72..77} — the serve seam's no-op guards, the serve-run's
    registration identity, and the SERVED payload / result shape."""

    def test_first_observation_shape_exact(self, tmp_path) -> None:
        from engine.journal.events import canonical_bytes, hash_bytes, normalized_hash

        j = Journal(tmp_path / "j")
        h = j.begin_run(file_hash="fh-1", document_id="doc-1", engine_version="e")
        env = _env()
        h.record_snapshot(env, period_id="p1")

        out = j.observe_serving(env, envelope_version="v9")
        assert set(out.keys()) == {"run_id", "snapshot", "served_event"}
        assert out["snapshot"] is None  # same era — self-heal not needed
        assert out["served_event"]["payload"] == {
            "envelope_version": "v9",
            "content_hash": hash_bytes(canonical_bytes(env)[0]),
            "normalized_hash": normalized_hash(env),
        }
        serve_entry = [
            e for e in j.registered_runs("fh-1") if e["run_id"] == out["run_id"]
        ][0]
        assert serve_entry["run_kind"] == "serve"
        assert serve_entry["engine_version"] == "serve-observation"
        assert serve_entry["document_id"] == "doc-1"
        # same state again: complete no-op
        assert j.observe_serving(env) is None

    def test_out_of_band_change_self_heals(self, tmp_path) -> None:
        j = Journal(tmp_path / "j")
        h = j.begin_run(file_hash="fh-1", document_id="d", engine_version="e")
        env = _env()
        h.record_snapshot(env, period_id="p1")
        j.observe_serving(env)
        mutated = _env(assembled=99)  # out-of-band mutation, same chain
        out = j.observe_serving(mutated)
        assert out is not None and out["snapshot"] is not None
        assert out["snapshot"]["duplicate"] is False

    def test_noop_guards(self, tmp_path) -> None:
        j = Journal(tmp_path / "j")
        assert j.observe_serving({}) is None
        assert j.observe_serving(["not-a-dict"]) is None  # type: ignore[arg-type]
        assert j.observe_serving({"provenance": {}}) is None
        assert j.list_chains() == []  # nothing was registered by the no-ops


class TestJournalStorageHygiene:
    """Kills x_sanitize_key__mutmut_{6,8,9} and
    xǁJournalǁ_append_line__mutmut_{3,5,7} — key sanitization bounds
    and the append path's ability to recreate a wiped journal tree
    (parents=True is load-bearing for crash resilience)."""

    def test_sanitize_key_bounds(self) -> None:
        assert sanitize_key("a/b c") == "a_b_c"
        assert sanitize_key("") == "_"
        assert len(sanitize_key("x" * 300)) == 200

    def test_append_recreates_wiped_tree(self, tmp_path) -> None:
        root = tmp_path / "j"
        j = Journal(root)
        h = j.begin_run(file_hash="fh-1", document_id="d", engine_version="e")
        shutil.rmtree(str(root))  # simulate external wipe of the whole store
        h.emit("PASS_DONE", {"stage": "parse"})
        assert (root / "runs" / ("%s.jsonl" % h.run_id)).is_file()

    def test_storage_path_literals_case_exact(self, tmp_path) -> None:
        # macOS default APFS is case-insensitive, so an is_file() probe
        # cannot see a "runs" -> "RUNS" drift that WOULD break on the
        # (case-sensitive) production filesystem. Pin the literal path.
        j = Journal(tmp_path / "j")
        assert str(j._run_path("r1")).endswith("/runs/r1.jsonl")
        assert str(j._index_path("fh")).endswith("/index/fh.jsonl")


class TestJournalSecondPass:
    """Second-pass kills for the journal survivors of the first killing
    round: x_normalized_envelope__mutmut_1, xǁJournalǁbegin_run__mutmut_
    {47,48,53..56} (RUN_STARTED payload keys), xǁRunHandleǁflush__mutmut_
    {1,3} (short-circuited runs must never REGISTER; post-flush state),
    xǁRunHandleǁrecord_snapshot__mutmut_{70..79} (duplicate log line),
    {102..104,132..134} (SimulatedCrash messages), {151..160}
    (non-fatal handler texts + DLQ resolution keying)."""

    def test_normalized_envelope_normalizes_the_argument(self) -> None:
        from engine.journal.events import VOLATILE_PLACEHOLDER
        from engine.journal.journal import normalized_envelope

        out = normalized_envelope(_env())
        assert out["written_at"] == VOLATILE_PLACEHOLDER
        assert out["assembled"] == 1

    def test_run_started_payload_exact(self, tmp_path) -> None:
        j = Journal(tmp_path / "j")
        h = j.begin_run(file_hash="fh-1", document_id="doc-1", engine_version="e-1")
        first = j.read_run(h.run_id)[0]
        assert first["type"] == "RUN_STARTED"
        assert first["payload"] == {
            "run_id": h.run_id,
            "file_hash": "fh-1",
            "engine_version": "e-1",
            "document_id": "doc-1",
            "run_kind": "pipeline",
        }

    def test_short_circuited_run_never_registers(self, tmp_path) -> None:
        j = Journal(tmp_path / "j")
        h1 = j.begin_run(file_hash="fh-1", document_id="d", engine_version="e")
        h1.record_snapshot(_env(), period_id="p1")
        h2 = j.begin_run(file_hash="fh-1", document_id="d", engine_version="e")
        h2.record_snapshot(_env(written_at="x"))  # duplicate -> short-circuit
        h2.flush()
        assert [e["run_id"] for e in j.registered_runs("fh-1")] == [h1.run_id]

    def test_flush_leaves_provisional_false(self, tmp_path) -> None:
        j = Journal(tmp_path / "j")
        h1 = j.begin_run(file_hash="fh-1", document_id="d", engine_version="e")
        h1.record_snapshot(_env(), period_id="p1")
        h2 = j.begin_run(file_hash="fh-1", document_id="d", engine_version="e")
        h2.flush()
        assert h2.provisional is False

    def test_duplicate_log_line_exact(self, tmp_path, caplog) -> None:
        import logging

        j = Journal(tmp_path / "j")
        h1 = j.begin_run(file_hash="fh-1", document_id="d", engine_version="e")
        h1.record_snapshot(_env(), period_id="p1")
        h2 = j.begin_run(file_hash="fh-1", document_id="d", engine_version="e")
        with caplog.at_level(logging.INFO, logger="engine.journal"):
            h2.record_snapshot(_env(written_at="x"))
        messages = [r.getMessage() for r in caplog.records]
        assert (
            "[journal] duplicate delivery short-circuited to run %s "
            "(file fh-1)" % h1.run_id
        ) in messages

    def test_simulated_crash_messages_exact(self, tmp_path) -> None:
        from engine.journal.journal import (
            CRASH_AFTER_EVENT_APPEND,
            CRASH_AFTER_OBJECT_WRITE,
            SimulatedCrash,
        )

        j = Journal(tmp_path / "j")
        h = j.begin_run(file_hash="fh-1", document_id="d", engine_version="e")
        with pytest.raises(SimulatedCrash) as ei:
            h.record_snapshot(_env(), crash_after=CRASH_AFTER_OBJECT_WRITE)
        assert str(ei.value) == (
            "crash injected after object write (before journal event)"
        )
        h2 = j.begin_run(file_hash="fh-2", document_id="d", engine_version="e")
        with pytest.raises(SimulatedCrash) as ei:
            h2.record_snapshot(
                _env(provenance={"content_hash": "fh-2"}),
                crash_after=CRASH_AFTER_EVENT_APPEND,
            )
        assert str(ei.value) == (
            "crash injected after journal event (before serving flip)"
        )

    def test_snapshot_resolves_dlq_by_both_keys(self, tmp_path) -> None:
        j = Journal(tmp_path / "j")
        # one dead letter matchable ONLY by document_id, one ONLY by
        # file_hash — a successful snapshot must resolve both halves.
        ha = j.begin_run(file_hash="fh-A", document_id="doc-1", engine_version="e")
        j.record_failure(ha, stage="parse", error_type="Boom", message="boom-1")
        hb = j.begin_run(file_hash="fh-1", document_id=None, engine_version="e")
        j.record_failure(hb, stage="parse", error_type="Boom", message="boom-2")
        assert j.dlq_depth() == 2
        h = j.begin_run(file_hash="fh-1", document_id="doc-1", engine_version="e")
        h.record_snapshot(_env(), period_id="p1")
        assert j.dlq_depth() == 0

    def test_nonfatal_aid_failures_stay_nonfatal_with_exact_logs(
        self, tmp_path, caplog, monkeypatch
    ) -> None:
        import logging

        j = Journal(tmp_path / "j")
        h = j.begin_run(file_hash="fh-1", document_id="d", engine_version="e")

        def boom_index(file_hash, entry):
            if entry.get("kind") == "period":
                raise RuntimeError("index boom")
            return original_append_index(file_hash, entry)

        original_append_index = j._append_index
        monkeypatch.setattr(j, "_append_index", boom_index)
        monkeypatch.setattr(
            j, "resolve_dlq_for",
            lambda **kw: (_ for _ in ()).throw(RuntimeError("dlq boom")),
        )
        with caplog.at_level(logging.ERROR, logger="engine.journal"):
            result = h.record_snapshot(_env(), period_id="p1")
        assert result["duplicate"] is False  # the commit itself succeeded
        messages = [r.getMessage() for r in caplog.records]
        assert "[journal] period index line failed (non-fatal)" in messages
        assert "[journal] dlq resolution failed (non-fatal)" in messages
