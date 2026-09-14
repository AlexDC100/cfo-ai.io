"""S7 SIGN FLIPS — the one classifier, its truth table, its consumers.

plan_contract_v2 section 7, R21, 26.2 S7; battery gate ``sign-flip``.

Defect 0.4: a sign flip rendered as a multiplier (Scenarios cash 6.1M to
-107.6M shown as "-19x") or a percent (Recession EBITDA 54.444M to
-20.257M shown as "-137.2%"). The repair is one classifier per runtime,
both held to one truth table:

  · src/engine/serving/change_kind.py           (this file)
  · frontend/lib/changeKind.ts                   (frontend/lib/__tests__/changeKind.test.ts)
  · tests/fixtures/contracts/change_kind_truth_table.json

After the repair this reds on (TC-11): a fixture row the Python classifier
classifies differently; a delta_pct on any kind other than compared with a
non-zero base; the pack and the TS pack disagreeing; the rounded-money
floor drifting from comparatives' PCT_BASE_FLOOR; a converted consumer
that stops importing the classifier; a truth table that stops enumerating
every sign pair with null and zero on both sides (TC-3).

It cannot see: what a page renders (signFlip.test.tsx, vitest) or whether
the TS classifier agrees (changeKind.test.ts, vitest) — the fixture is the
join, and the S7 row is those three together.

Python 3.9 — no ``match``, no ``X | Y`` unions.
"""
from __future__ import annotations

import json
import re
from collections import Counter
from decimal import Decimal
from fractions import Fraction
from pathlib import Path

import pytest
import yaml

from engine.comparatives.columns import PCT_BASE_FLOOR
from engine.serving import change_kind as CK

REPO = Path(__file__).resolve().parents[2]
TRUTH = REPO / "tests" / "fixtures" / "contracts" / "change_kind_truth_table.json"
PACK = REPO / "packs" / "serving" / "change_kind.yaml"
TS_PACK = REPO / "frontend" / "lib" / "changeKindPack.json"

#: Contract section 7 "Consumers converted in the same change (B1)", verbatim.
CONSUMERS = (
    "frontend/lib/learning/computeDeltas.ts",
    "frontend/lib/amountFormat.ts",
    "frontend/components/instrument/Amount.tsx",
    "frontend/components/ui/Money.tsx",
    "frontend/components/period/DeltaBadge.tsx",
    "frontend/components/scenarios/ScenarioComparison.tsx",
    "frontend/components/comparison/VarianceTable.tsx",
    "frontend/components/comparison/KpiVarianceStrip.tsx",
    "frontend/lib/comparison/buildVariance.ts",
    "frontend/components/cfo/KeyMetricsRow.tsx",
    "frontend/components/cfo/simple/StoryOverview.tsx",
    "frontend/lib/comparatives.ts",
    "frontend/components/cfo/ComparativeCells.tsx",
    "src/engine/comparatives/columns.py",
)


def _truth():
    return json.loads(TRUTH.read_text(encoding="utf-8"))


def _category(value, floor):
    if value is None:
        return "null"
    v = Fraction(value)
    if v == 0 or abs(v) < Fraction(floor):
        return "zero"
    return "pos" if v > 0 else "neg"


def test_the_python_classifier_matches_every_truth_table_row():
    doc = _truth()
    rows = doc["rows"]
    assert len(rows) >= 60, "the truth table shrank to %d rows (TC-3)" % len(rows)
    mismatches = []
    for i, row in enumerate(rows):
        got = CK.classify(row["base"], row["plan"], row["zero_floor"])
        if (got.kind, got.delta_pct) != (row["kind"], row["delta_pct"]):
            mismatches.append("row %d %s base=%r plan=%r floor=%r: want (%s, %r), got (%s, %r)"
                              % (i, row["group"], row["base"], row["plan"], row["zero_floor"],
                                 row["kind"], row["delta_pct"], got.kind, got.delta_pct))
    assert not mismatches, "\n".join(mismatches)
    kinds = Counter(r["kind"] for r in rows)
    assert set(kinds) == set(CK.KINDS), "the table must exercise all seven kinds: %s" % kinds
    print("SIGN-FLIP truth table (python): %d rows, kinds %s"
          % (len(rows), ", ".join("%s=%d" % kv for kv in sorted(kinds.items()))))
    print("GATE-WORK sign-flip units=%d label=truth-table-rows-python" % len(rows))


def test_the_truth_table_enumerates_every_sign_pair_with_null_and_zero_on_both_sides():
    """TC-3 for the fixture itself: a table that lost its null or zero rows
    would still pass the classifier check above."""
    rows = _truth()["rows"]
    want = set((b, p) for b in ("null", "neg", "zero", "pos")
               for p in ("null", "neg", "zero", "pos"))
    for group, floor in (("minor_units_floor_0", 0), ("rounded_money_floor_0.005", 0.005)):
        pairs = set((_category(r["base"], floor), _category(r["plan"], floor))
                    for r in rows if r["group"] == group)
        missing = sorted(want - pairs)
        assert not missing, "%s is missing sign pairs %s" % (group, missing)
    # the rounded-money group must also carry values INSIDE the floor on
    # both signs, or "within the floor" is only ever tested at exactly 0
    inside = [r for r in rows if r["group"] == "rounded_money_floor_0.005"
              and any(v is not None and v != 0 and abs(v) < 0.005
                      for v in (r["base"], r["plan"]))]
    signs = set((v > 0) for r in inside for v in (r["base"], r["plan"])
                if v is not None and v != 0 and abs(v) < 0.005)
    assert signs == {True, False}, "sub-floor values of both signs are required"


def test_delta_pct_exists_only_for_compared_with_a_non_zero_base():
    for row in _truth()["rows"]:
        got = CK.classify(row["base"], row["plan"], row["zero_floor"])
        base_zero = _category(row["base"], row["zero_floor"]) in ("zero", "null")
        if got.kind == CK.COMPARED and not base_zero:
            assert got.delta_pct is not None, row
            assert re.match(r"^-?\d+\.\d{%d}$" % CK.load_pack().delta_pct_places,
                            got.delta_pct), got.delta_pct
        else:
            assert got.delta_pct is None, row


def test_the_measured_defect_pairs_classify_as_words():
    """Defect 0.4 as measured on Scandia FY2025 (26.2 S7)."""
    cash = CK.classify(6104815.29, -107630000.0, PCT_BASE_FLOOR)
    ebitda = CK.classify(54444000.0, -20257000.0, PCT_BASE_FLOOR)
    minor = CK.classify(610481529, -10763000000, 0)
    for got in (cash, ebitda, minor):
        assert got.kind == CK.FLIP_TO_NEGATIVE and got.delta_pct is None
    assert CK.classify(-20257000.0, 54444000.0, PCT_BASE_FLOOR).kind == CK.FLIP_TO_POSITIVE


def test_the_pack_and_the_ts_pack_agree():
    pack = yaml.safe_load(PACK.read_text(encoding="utf-8"))
    ts = json.loads(TS_PACK.read_text(encoding="utf-8"))
    loaded = CK.load_pack()
    assert ts["schema"] == pack["schema"] == CK.PACK_SCHEMA
    assert ts["delta_pct_places"] == pack["delta_pct_places"] == loaded.delta_pct_places
    assert (ts["rounded_money_zero_floor"] == pack["rounded_money_zero_floor"]
            == loaded.rounded_money_zero_floor)
    assert _truth()["delta_pct_places"] == loaded.delta_pct_places, (
        "the truth table was authored at a different delta_pct_places; re-author it")
    print("SIGN-FLIP packs agree: delta_pct_places=%d rounded_money_zero_floor=%s"
          % (loaded.delta_pct_places, loaded.rounded_money_zero_floor))


def test_the_rounded_money_floor_is_the_comparatives_floor():
    """TC-10: the TS consumers read the floor from the pack; the pack must
    say what the Python authority (comparatives' PCT_BASE_FLOOR) says."""
    assert Decimal(CK.load_pack().rounded_money_zero_floor) == Decimal(repr(PCT_BASE_FLOOR))


def test_the_places_come_from_the_pack(tmp_path):
    raw = yaml.safe_load(PACK.read_text(encoding="utf-8"))
    raw["delta_pct_places"] = 2
    other = tmp_path / "change_kind.yaml"
    other.write_text(yaml.safe_dump(raw), encoding="utf-8")
    places = CK.load_pack(str(other)).delta_pct_places
    assert CK.classify(3, 5, 0, places=places).delta_pct == "0.67"


@pytest.mark.parametrize("field,value", [
    ("delta_pct_places", -1), ("delta_pct_places", "6"), ("delta_pct_places", True),
    ("rounded_money_zero_floor", 0.005), ("rounded_money_zero_floor", "-0.005"),
    ("schema", "change_kind/0"),
])
def test_a_malformed_pack_raises(tmp_path, field, value):
    raw = yaml.safe_load(PACK.read_text(encoding="utf-8"))
    raw[field] = value
    bad = tmp_path / "bad.yaml"
    bad.write_text(yaml.safe_dump(raw), encoding="utf-8")
    with pytest.raises(CK.ChangeKindPackError):
        CK.load_pack(str(bad))


@pytest.mark.parametrize("value", [float("nan"), float("inf"), True, "12", [1]])
def test_a_non_number_is_refused_never_classified(value):
    with pytest.raises((TypeError, ValueError)):
        CK.classify(value, 1, 0)
    with pytest.raises((TypeError, ValueError)):
        CK.classify(1, value, 0)


def test_every_converted_consumer_imports_the_one_classifier():
    """Contract 7's consumer list. A consumer that computes its own sign
    logic instead of importing the classifier is the second calculator
    defect 0.4 grew from. A TS consumer imports lib/changeKind directly or
    through lib/learning/computeDeltas (whose delta() is the classifier's
    one money wrapper and must itself import it); no consumer divides a
    difference by its own |base| (the reverted delta() shape)."""
    missing, own_ratio = [], []
    wrapper = (REPO / "frontend/lib/learning/computeDeltas.ts").read_text(encoding="utf-8")
    assert re.search(r'from\s+"@/lib/changeKind"', wrapper), (
        "computeDeltas.ts no longer imports the classifier")
    for rel in CONSUMERS:
        text = (REPO / rel).read_text(encoding="utf-8")
        if rel.endswith(".py"):
            ok = "engine.serving.change_kind" in text
        else:
            ok = bool(re.search(r'from\s+"@/lib/(changeKind|learning/computeDeltas)"', text)
                      or rel.endswith("computeDeltas.ts"))
            if re.search(r"\)\s*/\s*Math\.abs\(", text):
                own_ratio.append(rel)
        if not ok:
            missing.append(rel)
    assert not missing, "consumers not importing the classifier: %s" % missing
    assert not own_ratio, ("consumers computing their own (a - b) / |b|: %s"
                           % own_ratio)
    print("SIGN-FLIP consumers importing the classifier: %d of %d"
          % (len(CONSUMERS) - len(missing), len(CONSUMERS)))
    print("GATE-WORK sign-flip units=%d label=converted-consumers" % len(CONSUMERS))
    print("SCOPE sign-flip: truth table rows in integer minor units (floor 0) and "
          "rounded major-unit money (floor %s), the two measured defect pairs "
          "(Scandia FY2025 cash and EBITDA, printed as aggregates only), %d "
          "converted consumers; comparatives columns over the committed "
          "regression-baseline envelopes (scandia_fy2025 analytic, its "
          "condensed roll-up, eei_dec_2025 synthetic) and hand-built "
          "envelopes (test_comparatives.py); no forecast book (compare_base rows and "
          "waterfall steps join at B8)" % (CK.load_pack().rounded_money_zero_floor,
                                          len(CONSUMERS)))
