"""THE ENGINE RATIO TABLE — one period, served operands, pack bands.

`engine.ratios.table.build_ratio_table` is to become the one authority for
ratio values and bands on every surface. Before any surface reads it, its
numbers must be the numbers users already see: the quantized value must
equal what `computeRatios` prints, to the printed digit, on every shared
key of the four committed firm books (critic rule f). The FE half of that
comparison is captured by `frontend/lib/__tests__/ratioParityCapture.test.ts`
into `tests/engine/fixtures/ratio_parity/<book>.json` over the SAME three
committed files this gate composes the payload from.

WHAT THIS REDS ON, AFTER THE REPAIR (TC-11):

  · CENSUS (TC-13) — a `computeRatios` row with no census key, a
    pack-banded key with no census key, or a census key that is neither;
  · DIRECTION — a row of any status (refused and withheld included)
    without a boolean `higher_is_better`, or one that disagrees with the
    pack's band direction; the battery must contain refused and withheld
    rows or the check is vacuous (TC-3);
  · PARITY OF VALUES — any shared key on any book × {served, disputed}
    where the engine's `value_q` is not the FE's printed digits, or where
    one side refuses and the other does not, or the refusal kinds differ
    (FE `missing` ↔ `operand_absent`/`user_input_absent`, FE
    `undefined_ratio` ↔ `zero_denominator`);
  · PARITY OF VERDICTS — any verdict difference NOT listed in
    `MEASURED_VERDICT_DIFFERENCES`, any listed difference that no longer
    occurs, a listed key outside `DIVERGENT_LADDER_KEYS`, or a
    `DIVERGENT_LADDER_KEYS` member whose FE ladder now equals the pack's
    (the divergence was repaired but is still declared);
  · QUANTIZATION — a display string that is not ROUND_HALF_UP of the exact
    binary value at the unit's precision (banker's rounding, repr-based
    rounding and float formatting each red on the tie table);
  · LADDER UNITS — a pct row whose rungs are not the pack fraction × 100,
    or any rung not served as a string;
  · CLOSED ENUMS AND COVERAGE (TC-12) — a reason code outside
    `REASON_CODES`, a band status outside `BAND_STATUSES`, a coverage
    block that does not tie to its rows;
  · SECTOR WITHHOLDING — a disputed book whose sector-calibrated rows are
    graded, a served book whose rows are sector-withheld;
  · DETERMINISM — two builds of one payload that are not byte-equal, or a
    clock import in the module.

SCOPE (TC-13): the four firm books (agras, carniprod, realestate, retail)
× {served, disputed}: 8 tables × 22 shared keys = 176 value comparisons.
The six metric-only census keys have no FE row and are covered by the
census, direction, enum and coverage checks only. `adjusted_dscr` refuses
on every book (no lease input is supplied), so its FE ladder is not
observable here and it is out of the ladder-divergence comparison.
"""

from __future__ import annotations

import ast
import copy
import json
from decimal import Decimal
from pathlib import Path
from typing import Any, Dict, List, Tuple

import pytest

from engine.country_packs.ro_romania.chart_of_accounts import _GENERAL_SME_BAND_DEFINITIONS
from engine.ratios import table as T

REPO = Path(__file__).resolve().parents[2]
FIRM = REPO / "tests" / "engine" / "fixtures" / "firm"
PARITY = REPO / "tests" / "engine" / "fixtures" / "ratio_parity"
BOOKS = ("agras", "carniprod", "realestate", "retail")
VARIANTS = ("served", "disputed")

#: The FE ladders that disagree with the pack rung for rung (critic
#: verified fact 2). Declared, not repaired: which side is right is an
#: owner ruling, and it lands in the pack table.
DIVERGENT_LADDER_KEYS = frozenset({"dpo", "ccc", "asset_turnover", "debt_to_assets"})

#: Every verdict the divergence changes on the committed books, MEASURED
#: (book, variant, engine key) -> (engine verdict, FE verdict). Moving the
#: badge to the pack changes exactly these, and nothing else.
MEASURED_VERDICT_DIFFERENCES: Dict[Tuple[str, str, str], Tuple[str, str]] = {
    ("agras", "served", "dpo"): ("critical", "watch"),
    ("agras", "disputed", "dpo"): ("critical", "watch"),
    ("retail", "served", "dpo"): ("critical", "watch"),
    ("retail", "disputed", "dpo"): ("critical", "watch"),
    ("retail", "served", "debt_to_assets"): ("healthy", "strong"),
    ("retail", "disputed", "debt_to_assets"): ("healthy", "strong"),
}


# ── the served payload, composed exactly as exportBooks.ts composes it ──────


def _json(path: Path) -> Any:
    return json.loads(path.read_text("utf-8"))


_SERVED_METRICS = _json(FIRM / "served_metrics.json")
_SIGNALS = _json(FIRM / "industry_signal.json")
_WORKSPACE = _json(FIRM / "workspace_industry.json")


def payload_for(book: str, variant: str) -> Dict[str, Any]:
    fixture = _json(FIRM / ("saga_10_col_%s.json" % book))
    statements = dict(fixture["statements"])
    statements["canonical_bs"] = fixture["envelope"]["canonical_bs"]
    statements["assembled_canonical_v1"] = fixture["envelope"]
    payload: Dict[str, Any] = {
        "statements": statements,
        "metrics": [{"name": k, "value": v} for k, v in sorted(_SERVED_METRICS[book].items())],
        "period": {"id": "gate-%s" % book, "period_end": fixture.get("period_end"), "currency": "RON"},
    }
    if variant == "disputed":
        key = _WORKSPACE["books"][book]["disputes"]
        payload["industry_signal"] = _SIGNALS[book][key]
    return payload


@pytest.fixture(scope="module")
def tables() -> Dict[Tuple[str, str], Dict[str, Any]]:
    return {(b, v): T.build_ratio_table(payload_for(b, v)) for b in BOOKS for v in VARIANTS}


@pytest.fixture(scope="module")
def captures() -> Dict[str, Dict[str, Any]]:
    out = {}
    for book in BOOKS:
        path = PARITY / ("%s.json" % book)
        assert path.is_file(), "%s missing — run ratioParityCapture.test.ts with CAPTURE=1" % path
        out[book] = _json(path)
    return out


def _rows(table: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    return {r["key"]: r for r in table["rows"]}


def _fe_verdict(row: Dict[str, Any]) -> str:
    if row["band_status"] == "graded":
        return row["band"]
    return "unknown" if row["band_status"] == "refused" else "ungraded"


# ── census ──────────────────────────────────────────────────────────────────


def test_census_is_every_fe_row_plus_every_pack_banded_key(tables, captures):
    fe_keys = set(captures["agras"]["variants"]["served"])
    assert len(fe_keys) == 22, "computeRatios emits %d rows, the census was declared over 22" % len(fe_keys)
    census = set(T.CENSUS)
    mapped_fe = {T.FE_KEY_OF[k] for k in census if k in T.FE_KEY_OF}
    assert mapped_fe == fe_keys, "FE rows without a census key: %s; census FE keys the FE no longer emits: %s" % (
        sorted(fe_keys - mapped_fe), sorted(mapped_fe - fe_keys))
    pack = set(_GENERAL_SME_BAND_DEFINITIONS)
    assert pack <= census, "pack-banded keys the table does not serve: %s" % sorted(pack - census)
    stray = census - pack - set(T.FE_KEY_OF)
    assert not stray, "census keys that are neither an FE row nor pack-banded: %s" % sorted(stray)
    assert len(T.CENSUS) == len(census), "census lists a key twice"
    for table in tables.values():
        assert [r["key"] for r in table["rows"]] == list(T.CENSUS)
        assert table["census"] == list(T.CENSUS)
        assert table["coverage"]["census_count"] == len(T.CENSUS)


# ── direction ───────────────────────────────────────────────────────────────


def test_every_row_carries_higher_is_better_and_it_is_the_packs(tables):
    statuses = set()
    for (book, variant), table in tables.items():
        for row in table["rows"]:
            statuses.add(row["band_status"])
            assert isinstance(row.get("higher_is_better"), bool), (
                "%s/%s %s (%s) carries no boolean higher_is_better" % (
                    book, variant, row["key"], row["band_status"]))
            band = _GENERAL_SME_BAND_DEFINITIONS.get(row["key"])
            if band is not None:
                assert row["higher_is_better"] == (band["direction"] == "higher"), (
                    "%s direction disagrees with the pack" % row["key"])
    # TC-3 — the check must have met the rows that lose a ladder.
    for needed in ("refused", "graded", "ungraded_sector", "withheld_sign", "withheld_basis"):
        assert needed in statuses, "no %s row in the battery — the direction check is vacuous for it" % needed


def test_the_direction_survives_a_refusal_built_from_nothing():
    table = T.build_ratio_table({"statements": {}, "metrics": []})
    assert table["coverage"]["served"] == 0
    for row in table["rows"]:
        assert row["band_status"] == "refused"
        assert isinstance(row.get("higher_is_better"), bool), row["key"]


# ── parity with computeRatios ───────────────────────────────────────────────


def test_engine_value_is_the_printed_fe_value_on_every_shared_key(tables, captures):
    compared = 0
    bit_equal = 0
    failures: List[str] = []
    for (book, variant), table in sorted(tables.items()):
        rows = _rows(table)
        fe_rows = captures[book]["variants"][variant]
        for key, fe_key in sorted(T.FE_KEY_OF.items()):
            row, fe = rows[key], fe_rows[fe_key]
            compared += 1
            if fe["printed"] != row["value_q"]:
                failures.append("%s/%s %s: engine %r, FE printed %r (engine value %r from %s)" % (
                    book, variant, key, row["value_q"], fe["printed"], row["value"],
                    [o["source"] for o in row["operands"]]))
                continue
            if fe["value"] is None:
                kind = fe["absence"]["kind"]
                expected = {"undefined_ratio": {"zero_denominator"},
                            "missing": {"operand_absent", "user_input_absent"}}[kind]
                if row["reason"]["code"] not in expected:
                    failures.append("%s/%s %s: FE refused as %s, engine as %s" % (
                        book, variant, key, kind, row["reason"]["code"]))
            elif fe["value"] == row["value"]:
                bit_equal += 1
    assert compared == len(BOOKS) * len(VARIANTS) * 22
    assert not failures, "ENGINE ≠ PRINTED FE VALUE:\n  " + "\n  ".join(failures)
    # TC-3 — the comparison must have met valued rows, not only refusals.
    assert bit_equal >= 150, "only %d of %d comparisons carried a value" % (bit_equal, compared)


def test_verdicts_match_except_the_declared_ladder_divergence(tables, captures):
    measured: Dict[Tuple[str, str, str], Tuple[str, str]] = {}
    for (book, variant), table in tables.items():
        rows = _rows(table)
        for key, fe_key in T.FE_KEY_OF.items():
            ev, fv = _fe_verdict(rows[key]), captures[book]["variants"][variant][fe_key]["verdict"]
            if ev != fv:
                measured[(book, variant, key)] = (ev, fv)
    assert measured == MEASURED_VERDICT_DIFFERENCES, (
        "verdict differences changed.\n  undeclared: %s\n  declared but gone: %s" % (
            sorted(set(measured.items()) - set(MEASURED_VERDICT_DIFFERENCES.items())),
            sorted(set(MEASURED_VERDICT_DIFFERENCES.items()) - set(measured.items()))))
    assert {k for (_, _, k) in measured} <= DIVERGENT_LADDER_KEYS

    # The declared set is exactly the keys whose FE ladder differs from the
    # served pack ladder, in the row's display unit (TC-3 both directions).
    fe_ladders: Dict[str, Dict[str, float]] = {}
    for book in BOOKS:
        for variant in VARIANTS:
            for fe_key, fe in captures[book]["variants"][variant].items():
                if fe["ladder"] is not None:
                    fe_ladders.setdefault(fe_key, fe["ladder"])
    engine_ladders = {r["key"]: r["ladder"] for r in tables[("agras", "served")]["rows"]}
    divergent = set()
    for key, fe_key in T.FE_KEY_OF.items():
        if fe_key not in fe_ladders:
            continue
        pack = {n: float(v) for n, v in (engine_ladders[key] or {}).items()}
        if pack != {n: float(v) for n, v in fe_ladders[fe_key].items()}:
            divergent.add(key)
    assert "adjusted_dscr" not in fe_ladders, "adjusted_dscr now grades on a book — bring it into scope"
    assert divergent == DIVERGENT_LADDER_KEYS, (
        "ladder divergence is %s, declared %s" % (sorted(divergent), sorted(DIVERGENT_LADDER_KEYS)))


# ── quantization ────────────────────────────────────────────────────────────


#: (value, display unit, printed). Exact binary ties decide half-up vs
#: half-even; 2.675 / 1.005 are NOT ties in binary and decide exact-value
#: vs repr rounding. Every printed string is what Number.toFixed prints.
QUANTIZE_CASES = (
    (0.125, "x", "0.13"),
    (0.375, "x", "0.38"),
    (-0.125, "x", "-0.13"),
    (2.5, "days", "3"),
    (0.5, "days", "1"),
    (-2.5, "days", "-3"),
    (0.25, "pct", "0.3"),
    (4.25, "score", "4.3"),
    (2.675, "x", "2.67"),
    (1.005, "x", "1.00"),
    (-0.0, "x", "0.00"),
    (-0.004, "x", "-0.00"),
    (845.4999, "days", "845"),
    (1.125, "z", "1.13"),
)


@pytest.mark.parametrize("value,unit,printed", QUANTIZE_CASES)
def test_quantization_is_half_up_on_the_exact_binary_value(value, unit, printed):
    assert T.quantize_display(value, unit) == printed


def test_quantization_does_not_overflow_the_decimal_context():
    printed = T.quantize_display(1e25, "x")
    assert printed == "10000000000000000905969664.00"


def test_every_served_value_q_is_the_quantizer_of_its_value(tables):
    for table in tables.values():
        for row in table["rows"]:
            if row["value"] is None:
                assert row["value_q"] is None
                continue
            assert isinstance(row["value_q"], str)
            assert row["value_q"] == T.quantize_display(row["value"], row["display_unit"])
            places = T.DISPLAY_DIGITS[row["display_unit"]]
            assert -Decimal(row["value_q"]).as_tuple().exponent == places


# ── ladders in display units ────────────────────────────────────────────────


def test_ladders_are_the_pack_rungs_in_display_units_as_strings(tables):
    rows = _rows(tables[("agras", "served")])
    checked = 0
    for key, band in _GENERAL_SME_BAND_DEFINITIONS.items():
        row = rows[key]
        scale = Decimal(100) if row["display_unit"] == "pct" else Decimal(1)
        for name in ("strong", "healthy", "watch"):
            served = row["ladder"][name]
            assert isinstance(served, str), "%s.%s served as %r" % (key, name, served)
            assert Decimal(served) == Decimal(repr(float(band[name]))) * scale, (
                "%s.%s served %s, pack %r in %s" % (key, name, served, band[name], row["display_unit"]))
            checked += 1
    assert checked == 3 * len(_GENERAL_SME_BAND_DEFINITIONS)
    assert rows["adjusted_dscr"]["ladder"] is None


# ── enums, coverage, sector withholding ─────────────────────────────────────


def test_reason_codes_and_statuses_are_closed_and_coverage_ties(tables):
    seen_codes = set()
    for (book, variant), table in tables.items():
        cov = table["coverage"]
        served_keys = set()
        for row in table["rows"]:
            assert row["band_status"] in T.BAND_STATUSES
            if row["reason"] is not None:
                assert row["reason"]["code"] in T.REASON_CODES, row["reason"]
                assert isinstance(row["reason"]["inputs"], list)
                seen_codes.add(row["reason"]["code"])
            if row["band_status"] == "refused":
                assert row["value"] is None and row["reason"] is not None
                assert cov["refused"][row["key"]] == row["reason"]["code"]
            else:
                served_keys.add(row["key"])
                assert row["value"] is not None
            if row["band_status"] == "graded":
                assert row["band"] in T.BAND_RANK and row["ladder"] and row["reason"] is None
            else:
                assert row["band"] is None
                if row["band_status"] != "refused":
                    assert cov["band_withheld"][row["key"]] == row["reason"]["code"]
        assert cov["served"] == len(served_keys)
        assert cov["served"] + len(cov["refused"]) == cov["census_count"]
        assert set(cov["band_withheld"]) <= served_keys
    for needed in ("zero_denominator", "user_input_absent", "engine_metric_absent", "sector_unconfirmed",
                   "negative_denominator", "no_cost_of_sales"):
        assert needed in seen_codes, "reason %s never produced — its branch is untested" % needed


def test_sector_withholding_follows_the_payload_signal(tables):
    for book in BOOKS:
        served, disputed = _rows(tables[(book, "served")]), _rows(tables[(book, "disputed")])
        for key in T.CENSUS:
            if key in T.SECTOR_CALIBRATED_RATIOS and disputed[key]["value"] is not None:
                assert disputed[key]["band_status"] == "ungraded_sector", (book, key)
            else:
                assert disputed[key]["band_status"] != "ungraded_sector", (book, key)
            assert served[key]["band_status"] != "ungraded_sector", (book, key)


def test_a_source_that_declares_absence_refuses_every_row():
    payload = payload_for("agras", "served")
    payload["statements"]["absentInputs"] = ["interestExpense"]
    table = T.build_ratio_table(payload)
    assert table["coverage"]["served"] == 0
    assert set(table["coverage"]["refused"].values()) == {"source_declares_absence"}


def test_a_prior_with_no_metric_rows_still_computes_from_statements():
    """The comparatives fixture shape (`metrics: []`): the FE fallback
    arithmetic answers, and only the metric-only keys refuse."""
    payload = payload_for("agras", "served")
    payload["metrics"] = []
    table = T.build_ratio_table(payload)
    refused = table["coverage"]["refused"]
    assert set(k for k, c in refused.items() if c == "engine_metric_absent") == {
        s for s, p in T.PRECEDENCE.items() if p == "metric_only"}
    assert _rows(table)["dpo"]["value"] is not None
    assert [o["source"] for o in _rows(table)["dpo"]["operands"]][0] == "balanceSheet.accountsPayable"


# ── stamps and determinism ──────────────────────────────────────────────────


def test_stamps_name_the_band_table_and_the_pack(tables):
    stamps = tables[("agras", "served")]["stamps"]
    assert stamps["ratio_table_version"] == T.TABLE_VERSION
    assert stamps["bands"]["source"] == "general_sme_fallback"
    assert stamps["bands"]["origin"] == "served"
    assert len(stamps["bands"]["table_sha256"]) == 64
    assert stamps["pack_provenance"]["pack"] == "omfp1802@v1"
    assert stamps["assembled_at"] == "serve"
    assert tables[("retail", "disputed")]["stamps"]["bands"]["table_sha256"] == stamps["bands"]["table_sha256"]
    bare = T.build_ratio_table({"statements": {}, "metrics": []})["stamps"]["bands"]
    assert bare["origin"] == "pack_default" and bare["table_sha256"] == stamps["bands"]["table_sha256"]


def test_the_table_is_deterministic_json_and_reads_no_clock():
    payload = payload_for("realestate", "disputed")
    first = T.ratio_table_json(T.build_ratio_table(copy.deepcopy(payload)))
    second = T.ratio_table_json(T.build_ratio_table(copy.deepcopy(payload)))
    assert first == second
    tree = ast.parse(Path(T.__file__).read_text("utf-8"))
    imported = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported.update(a.name.split(".")[0] for a in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            imported.add(node.module.split(".")[0])
    assert not imported & {"datetime", "time", "random", "uuid"}, imported
