"""ASSERTION WITNESSES — one triggering test per catalogued assert (C3).

Every always-on assert in the assertion-dense kernel carries an
``A-###`` id in its message and is catalogued in
docs/engine_book/assertions.md. THIS suite is the catalog's proof
column: for each id there is a test here that makes the assert actually
fire (pytest.raises(AssertionError) matching the id), so a future
refactor can never silently delete or dead-code an invariant — the
witness goes red the moment the assert stops guarding.

Because the guarded invariants are true for every reachable public
input (the corpus replay + determinism gates prove the asserts change
no behavior), the witnesses construct the forbidden states INTERNALLY:

  * frozen-dataclass corruption via ``object.__setattr__`` (the same
    escape hatch ``__post_init__`` itself uses) — models a value
    corrupted AFTER construction (pickle/copy/C-extension bugs);
  * impure "evil" subclasses whose attribute reads change between two
    reads of the same field — models TOCTOU on the census/totality
    postconditions;
  * ``monkeypatch`` of internal routing tables/functions — models the
    mapping-table drift the assert exists to catch on day one;
  * for A-034, a genuinely absurd public input (an amount beyond exact
    float cent range) — no internals needed.

Each witness asserts the MATCHING id, so a reshuffle that makes a
different assert fire first is a failure here, not a false green.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
SRC = REPO / "src"
if SRC.is_dir() and str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

import engine.country_packs.ro_romania  # noqa: E402,F401 — registers RomaniaPack
from engine.country_packs.ro_romania import canonical_adapter as ca  # noqa: E402
from engine.ir import (  # noqa: E402
    AccountAtom,
    DocHeader,
    DocumentTotals,
    LedgerDoc,
    Money,
    Provenance,
    SourceRef,
)
from engine.ir import ledgerdoc as ledgerdoc_mod  # noqa: E402
from engine.passes import classify as classify_mod  # noqa: E402
from engine.passes.classify import (  # noqa: E402
    METHOD_RULE,
    METHOD_UNCLASSIFIED,
    AtomClassification,
    _minor_at,
    _net_signed_minor,
    classify,
)
from engine.packs.runtime import active_pack  # noqa: E402


# ── helpers ────────────────────────────────────────────────────────────


def _corrupt(obj, **fields):
    """Post-construction corruption of a frozen dataclass — the exact
    state the integrality asserts exist to catch."""
    for name, value in fields.items():
        object.__setattr__(obj, name, value)
    return obj


def _atom(atom_id: str, code: str = "5121", **money_slots) -> AccountAtom:
    return AccountAtom(
        atom_id=atom_id,
        account_code=code,
        label="Cont %s" % code,
        provenance=Provenance.mechanical(SourceRef.cell("S", 1, 0)),
        **money_slots,
    )


@pytest.fixture(scope="module")
def ro_pack():
    return active_pack("RO")


# ── money.py ───────────────────────────────────────────────────────────


class TestMoneyWitnesses:
    def test_a001_binary_op_integrality(self):
        a = Money.from_minor("RON", 100)
        b = _corrupt(Money.from_minor("RON", 100), amount_minor=1.5)
        with pytest.raises(AssertionError, match="A-001"):
            a + b
        # The same chokepoint guards ordering.
        with pytest.raises(AssertionError, match="A-001"):
            a < b

    def test_a002_neg_integrality(self):
        m = _corrupt(Money.from_minor("RON", 100), amount_minor=2.5)
        with pytest.raises(AssertionError, match="A-002"):
            -m

    def test_a003_to_decimal_str_domain(self):
        m = _corrupt(Money.from_minor("RON", 105), scale=-1)
        with pytest.raises(AssertionError, match="A-003"):
            m.to_decimal_str()
        m2 = _corrupt(Money.from_minor("RON", 105), amount_minor=1.05)
        with pytest.raises(AssertionError, match="A-003"):
            m2.to_decimal_str()

    def test_a004_add_unit_closure(self):
        # Both operands corrupted to the SAME denormalized currency, so
        # the mismatch raise and A-001 both pass; the constructor then
        # normalizes and the closure postcondition catches the drift.
        a = _corrupt(Money.from_minor("RON", 100), currency="ron")
        b = _corrupt(Money.from_minor("RON", 50), currency="ron")
        with pytest.raises(AssertionError, match="A-004"):
            a + b

    def test_a005_sub_unit_closure(self):
        a = _corrupt(Money.from_minor("RON", 100), currency="ron")
        b = _corrupt(Money.from_minor("RON", 50), currency="ron")
        with pytest.raises(AssertionError, match="A-005"):
            a - b


# ── ledgerdoc.py ───────────────────────────────────────────────────────


class TestLedgerDocWitnesses:
    def test_a010_atom_slot_integrality(self):
        bad = _corrupt(Money.from_minor("RON", 100), amount_minor=1.0)
        with pytest.raises(AssertionError, match="A-010"):
            _atom("a1", closing_debit=bad)

    def test_a011_totals_slot_integrality(self):
        bad = _corrupt(Money.from_minor("RON", 100), amount_minor=1.0)
        with pytest.raises(AssertionError, match="A-011"):
            DocumentTotals(closing_debit=bad)

    def test_a012_source_meta_deep_frozen(self, monkeypatch):
        # Neuter the deep-freeze: the postcondition must notice that the
        # "immutable" header now aliases a mutable dict.
        monkeypatch.setattr(
            ledgerdoc_mod, "_deep_freeze", lambda value, path="source_meta": value
        )
        with pytest.raises(AssertionError, match="A-012"):
            DocHeader(jurisdiction="RO", currency="RON", source_meta={"k": 1})

    def test_a013_atom_census_toctou(self):
        reads = {"n": 0}

        class EvilAtom(AccountAtom):
            """atom_id read #2 (the `in seen` membership check) reports a
            ghost id; every other read reports the real one — so the
            duplicate guard misses and the census postcondition must
            catch the overwrite. Read #1 is the atom's own __post_init__
            validation."""

            def __getattribute__(self, name):
                if name == "atom_id":
                    reads["n"] += 1
                    if reads["n"] == 2:
                        return "ghost"
                return object.__getattribute__(self, name)

        first = _atom("a1")
        evil = EvilAtom(
            atom_id="a1",
            account_code="401",
            label="Cont 401",
            provenance=Provenance.mechanical(SourceRef.cell("S", 2, 0)),
        )
        header = DocHeader(jurisdiction="RO", currency="RON")
        with pytest.raises(AssertionError, match="A-013"):
            LedgerDoc(header=header, atoms=(first, evil))


# ── passes/classify.py ─────────────────────────────────────────────────


def _evil_doc(base_atoms, replacement_atoms, swap_from_read):
    """A LedgerDoc whose .atoms swaps to `replacement_atoms` from the
    Nth read on — construction (read 1) and the classify loop see the
    real atoms; the totality postconditions re-read and must notice."""
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


class TestClassifyWitnesses:
    def test_a020_minor_at_scale_monotonicity(self):
        with pytest.raises(AssertionError, match="A-020"):
            _minor_at(Money.from_minor("RON", 5, 2), 0)

    def test_a021_net_signed_minor_integrality(self):
        bad = _corrupt(Money.from_minor("RON", 100), amount_minor=1.0)
        with pytest.raises(AssertionError, match="A-021"):
            _net_signed_minor(((bad, None),))

    def test_a022_unclassified_marker_coherence(self):
        with pytest.raises(AssertionError, match="A-022"):
            AtomClassification(
                atom_id="x", account_code="1", line_id=None, rule_id=None,
                method=METHOD_RULE, confidence=1.0,
            )
        with pytest.raises(AssertionError, match="A-022"):
            AtomClassification(
                atom_id="x", account_code="1", line_id="some_line",
                rule_id=None, method=METHOD_UNCLASSIFIED, confidence=1.0,
            )

    def test_a023_method_vocabulary(self):
        with pytest.raises(AssertionError, match="A-023"):
            AtomClassification(
                atom_id="x", account_code="1", line_id=None, rule_id=None,
                method="banana", confidence=1.0,
            )

    def test_a024_confidence_domain(self):
        with pytest.raises(AssertionError, match="A-024"):
            AtomClassification(
                atom_id="x", account_code="1", line_id=None, rule_id=None,
                method=METHOD_UNCLASSIFIED, confidence=1.5,
            )

    def test_a025_classify_totality(self, ro_pack):
        base = (_atom("a1", "5121"), _atom("a2", "401"))
        grown = base + (_atom("a3", "212"),)
        # Reads: 1 = LedgerDoc.__post_init__, 2 = the classify loop,
        # 3 = the A-025 census re-read (which then sees a grown tuple).
        doc = _evil_doc(base, grown, swap_from_read=3)
        with pytest.raises(AssertionError, match="A-025"):
            classify(doc, ro_pack)

    def test_a026_classify_order_alignment(self, ro_pack):
        base = (_atom("a1", "5121"), _atom("a2", "401"))
        swapped = (base[1], base[0])  # same length, different order
        # Read 3 (A-025 len check) passes on the swapped tuple; read 4
        # (the A-026 zip) sees the misaligned ids.
        doc = _evil_doc(base, swapped, swap_from_read=3)
        with pytest.raises(AssertionError, match="A-026"):
            classify(doc, ro_pack)


# ── country_packs/ro_romania/canonical_adapter.py ──────────────────────


def _li(code, amount, bucket, statement="BS", name=None):
    return {
        "ro_account_code": code,
        "ro_account_name": name or ("Cont %s" % code),
        "amount": amount,
        "bucket": bucket,
        "statement": statement,
    }


class _EvilSectionOrder(list):
    """A list whose __iter__ hides one section id from the Nth iteration
    on, while `in` / `.index()` (C-level, real storage) stay truthful —
    the only way to make the structurally-derived row/total sums diverge
    inside a single build call and prove A-035/A-036 still guard.

    Iteration census inside build_canonical_bs_v2 (locked by these
    witnesses; renumber here if the builder gains/loses an iteration):
      #1 section_cents dict-comprehension
      #2 sections list-comprehension
      #3 assets_cents genexp   #4 equity_cents genexp
      #5 liabilities_cents genexp
    """

    def __init__(self, base, drop, drop_from_iter):
        super().__init__(base)
        self._full = list(base)
        self._drop = drop
        self._from = drop_from_iter
        self._n = 0

    def __iter__(self):
        self._n += 1
        if self._n >= self._from:
            return iter([s for s in self._full if s != self._drop])
        return iter(self._full)


class TestCanonicalBuilderWitnesses:
    def test_a030_section_mapping_closure(self, monkeypatch):
        monkeypatch.setitem(
            ca._LEAF_SECTION_OVERRIDES, "cash_operating", "bogus_section"
        )
        with pytest.raises(AssertionError, match="A-030"):
            ca._section_for_leaf("cash_operating")

    def test_a031_side_partition_disjoint(self, monkeypatch):
        monkeypatch.setattr(
            ca, "_BS_V2_EQUITY_SECTIONS", {"equity", "current_assets"}
        )
        with pytest.raises(AssertionError, match="A-031"):
            ca.build_canonical_bs_v2({"leaves": {}})

    def test_a032_result_row_uniqueness(self, monkeypatch):
        # With the result-leaf exclusion neutered, the kwarg-injected
        # reconstruction leaf ALSO renders as a plain row next to the
        # explicit result row — the double-count A-032 exists to stop.
        monkeypatch.setattr(ca, "_RESULT_LEAF_NAMES", frozenset())
        envelope = ca.assemble_canonical([], current_year_pnl=100.0)
        with pytest.raises(AssertionError, match="A-032"):
            ca.build_canonical_bs_v2(envelope)

    def test_a033_magnitude_non_negative(self, monkeypatch):
        monkeypatch.setattr(
            ca, "_sign_adjusted_magnitude", lambda name, signed: -1.0
        )
        with pytest.raises(AssertionError, match="A-033"):
            ca.assemble_canonical([_li("5121", 10.0, "cash")])

    def test_a034_row_serialization_conservation(self):
        # PUBLIC input, no internals. Float-mediated amounts (unmapped /
        # line_items) quantize through _cents first, which projects onto
        # the float round-trip's fixed points — but the parser-attached
        # closing_result block carries RAW integer cents, so a result
        # beyond exact float cent range (2**62+1 is odd and > 2**53)
        # cannot round-trip through the row's serialized float amount.
        anchor = {
            "totals_row_found": False,
            "pairs": {},
            "anchor_status": "NO_ANCHOR",
            "source_balanced": None,
            "closing_result": {
                "basis": "sf",
                "p121_cents": (2 ** 62) + 1,
                "pl_net_cents": 0,
                "codes": ["121"],
            },
        }
        with pytest.raises(AssertionError, match="A-034"):
            ca.build_canonical_bs_v2({"leaves": {}}, source_anchor=anchor)

    def test_a035_asset_rows_vs_totals(self, monkeypatch):
        monkeypatch.setattr(
            ca, "_BS_V2_SECTION_ORDER",
            _EvilSectionOrder(
                ca._BS_V2_SECTION_ORDER, drop="current_assets",
                drop_from_iter=3,  # assets_cents genexp — see census above
            ),
        )
        line_items = [_li("5121", 100.0, "cash")]
        envelope = ca.assemble_canonical(line_items)
        with pytest.raises(AssertionError, match="A-035"):
            ca.build_canonical_bs_v2(envelope, line_items=line_items)

    def test_a036_el_rows_vs_totals(self, monkeypatch):
        monkeypatch.setattr(
            ca, "_BS_V2_SECTION_ORDER",
            _EvilSectionOrder(
                ca._BS_V2_SECTION_ORDER, drop="current_liabilities",
                drop_from_iter=5,  # liabilities_cents genexp — see census
            ),
        )
        line_items = [_li("401", 100.0, "accountsPayable")]
        envelope = ca.assemble_canonical(line_items)
        with pytest.raises(AssertionError, match="A-036"):
            ca.build_canonical_bs_v2(envelope, line_items=line_items)
