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
  · PARITY OF VALUES — any shared key on any book × {served, disputed,
    perturbed} where the engine's `value_q` is not the FE's printed digits
    (`formatRatio` output), or where
    one side refuses and the other does not, or the refusal kinds differ
    (FE `missing` ↔ `operand_absent`/`user_input_absent`, FE
    `undefined_ratio` ↔ `zero_denominator`);
  · PRECEDENCE — a key whose declared `PRECEDENCE` (`mOr` / `bsOr` /
    `metric_only` / `user_input`) is not what `computeRatios` does in the
    perturbed capture (every served metric × 1.37), or an engine row whose
    operands contradict it. On the unperturbed books 16 of 21 precedence
    choices are invisible; ×1.37 makes every one with both sides visible;
  · ONE KEY, ONE FORMULA — on the REAL `GET /api/period` body (no metric
    rows), any `mOr` key whose fallback does not reproduce the served
    metric of the same book to the metric's stored rounding, a net margin
    that does not divide `assembled_pl.net_income_statutory`, an interest
    coverage that reads depreciation (EBIT basis), or a DSCR that does not
    divide `assembled_pl.ebitda_statutory`;
  · METRIC-ONLY ROWS — a value that is not the served metric (× 100 on
    pct rows), a verdict that is not the pack ladder's on the raw metric;
  · SIGN WITHHOLDING — a census key outside `SIGN_EXEMPT` whose declared
    denominator, made negative, does not withhold the band with that
    denominator named (realestate's real −0.60× net debt / EBITDA among
    them), or a key both guarded and exempt;
  · GRADING BOUNDARY — a value exactly on a rung not taking that rung, in
    either direction (strict comparison);
  · LEGACY TIER — a period without `canonical_bs` that does not read the
    served `assembled_bs` grand totals (labelled `assembled_bs.*`), that
    reads the methodology round-trip, or that does not refuse when the
    grand-total triple is incomplete;
  · PARITY OF VERDICTS — any verdict difference NOT listed in
    `MEASURED_VERDICT_DIFFERENCES`, any listed difference that no longer
    occurs, a listed key outside `DIVERGENT_LADDER_KEYS`, or a
    `DIVERGENT_LADDER_KEYS` member whose FE ladder now equals the pack's
    (the divergence was repaired but is still declared);
  · QUANTIZATION — a display string that is not ROUND_HALF_UP of the exact
    binary value at the unit's precision (banker's rounding, repr-based
    rounding and float formatting each red on the tie table);
  · LADDER UNITS — a pct row whose rungs are not the pack fraction × 100,
    or any rung not served as a string; a pack key never observed graded
    in the battery (TC-3); a ladder on ANY row that is not `graded` (a
    withheld badge must not carry the cutoff it was withheld from, TC-10);
  · CLOSED ENUMS AND COVERAGE (TC-12) — a reason code outside
    `REASON_CODES`, a band status outside `BAND_STATUSES`, a coverage
    block that does not tie to its rows;
  · SECTOR WITHHOLDING — a disputed book on which the set of
    sector-withheld keys is not exactly `T.SECTOR_WITHHELD_KEYS` (among
    the keys with a value), a declared set that is not the FE set plus
    the three metric-only keys whose `SECTOR_SIBLING_OF` is in it, or a
    served book whose rows are sector-withheld;
  · DETERMINISM — two builds of one payload that are not byte-equal, or a
    clock import in the module.

SCOPE (TC-13): the four firm books (agras, carniprod, realestate, retail)
× {served, disputed, perturbed}: 12 tables × 22 shared keys = 264 value
comparisons; verdict comparisons over {served, disputed} only (the
perturbed variant exists to expose precedence, not to grade). The
no-metric gate runs the same four books through the real route harness
of `test_insights_wire`. The six metric-only census keys have no FE row
and are held to the served metric and the pack ladder directly. `adjusted_dscr` refuses
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
from _pytest.monkeypatch import MonkeyPatch

from engine.country_packs.ro_romania.chart_of_accounts import _GENERAL_SME_BAND_DEFINITIONS
from engine.ratios import margin_meaning as MM
from engine.ratios import table as T

REPO = Path(__file__).resolve().parents[2]
FIRM = REPO / "tests" / "engine" / "fixtures" / "firm"
PARITY = REPO / "tests" / "engine" / "fixtures" / "ratio_parity"
BOOKS = ("agras", "carniprod", "realestate", "retail")
VARIANTS = ("served", "disputed", "perturbed")
VERDICT_VARIANTS = ("served", "disputed")

#: `ratioParityCapture.test.ts METRIC_PERTURBATION` — the same factor, so
#: both runtimes multiply the same double by the same double.
METRIC_PERTURBATION = 1.37

#: `pipeline.stage_compute` stores every ratio metric through
#: `round(x, 4)`; asserted against the served metrics below, not assumed.
METRIC_STORED_DECIMALS = 4

#: The FE ladders that disagree with the pack rung for rung (critic
#: verified fact 2). Declared, not repaired: which side is right is an
#: owner ruling, and it lands in the pack table.
DIVERGENT_LADDER_KEYS = frozenset({"dpo", "ccc", "asset_turnover", "debt_to_assets"})

#: Every verdict the divergence changes on the committed books, MEASURED
#: (book, variant, engine key) -> (engine verdict, FE verdict). Moving the
#: badge to the pack changes exactly these, and nothing else.
#:
#: BAND RULING 2026-09-14 (ratios B4 step 1; CLAUDE.md Appendix A section 5).
#: The pack table is the one band authority. debt_to_assets and
#: asset_turnover keep the pack rungs (the methodology's "<40%" and
#: "1.0-1.5x" support them); ccc keeps pack watch 90; dpo keeps its watch
#: rung 30 but floors at `watch` (the methodology names no DPO failure
#: threshold). So the agras (27 days) and retail (29 days) dpo rows, which
#: graded critical on the pack before the floor, now agree with the FE, and
#: the ONE verdict the switch still moves is retail debt_to_assets 39.7%,
#: FE strong -> pack healthy. On the Scandia FY2025 book the switch moves
#: no verdict (measured in ratios wave r1; no FE capture of it is committed).
MEASURED_VERDICT_DIFFERENCES: Dict[Tuple[str, str, str], Tuple[str, str]] = {
    ("retail", "served", "debt_to_assets"): ("healthy", "strong"),
    ("retail", "disputed", "debt_to_assets"): ("healthy", "strong"),
}

#: THE ONE EBITDA, WAS PENDING ON THE FRONTEND (owner ruling 2026-09-26, design
#: A7; resolved by the F2 stage — see below). The engine's EBITDA is the assembled one — net 711 ("Variația
#: stocurilor de produse") and net 72x inside (`credit_model.
#: operating_figures`). `computeRatios` still rebuilds EBITDA in the browser
#: (until F2) from the incomeStatement mirror WITHOUT them and let its own division win
#: for debt_to_ebitda (`bsOr`), so on the two committed books that post to
#: 711 with debt it prints the pre-ruling figure. MEASURED (book, variant,
#: key) -> (engine printed, FE printed). The FE stage deletes the browser
#: EBITDA arithmetic; every entry then reds here as "declared but gone" and
#: is removed. Any OTHER value difference is still a red.
ONE_EBITDA_FE_PENDING: Dict[Tuple[str, str, str], Tuple[str, str]] = {}
# EMPTIED by the FE stage (F2, 2026-09-27): `computeRatios` now divides the
# SERVED one EBITDA (frontend/lib/servedOneEbitda.plLevelsOf), so agras
# prints 0.31 and the developer 33.67 — the engine's figures. The six
# entries ((agras 0.31 vs 0.34), (realestate 33.67 vs -0.64) × three
# variants) reddened here as "declared but gone", as designed, and were
# removed. Any value difference is a red again.

#: ...and the verdict that difference moved — gone with it.
ONE_EBITDA_FE_PENDING_VERDICTS: Dict[Tuple[str, str, str], Tuple[str, str]] = {}


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
    factor = METRIC_PERTURBATION if variant == "perturbed" else None
    payload: Dict[str, Any] = {
        "statements": statements,
        "metrics": [{"name": k, "value": (v * factor if (factor is not None and v is not None) else v)}
                    for k, v in sorted(_SERVED_METRICS[book].items())],
        "period": {"id": "gate-%s" % book, "period_end": fixture.get("period_end"), "currency": "RON"},
    }
    if variant == "disputed":
        key = _WORKSPACE["books"][book]["disputes"]
        payload["industry_signal"] = _SIGNALS[book][key]
    return payload


@pytest.fixture(scope="module")
def tables() -> Dict[Tuple[str, str], Dict[str, Any]]:
    return {(b, v): T.build_ratio_table(payload_for(b, v)) for b in BOOKS for v in VARIANTS}


#: The one committed book whose margins the margin rule refuses
#: (engine.ratios.margin_meaning: turnover 0.6% of its operating activity).
MARGIN_REFUSED_BOOKS = frozenset({"realestate"})


def _margin_refused(table: Dict[str, Any]) -> frozenset:
    """The census keys the margin rule refused on this table."""
    return frozenset(r["key"] for r in table["rows"]
                     if (r.get("reason") or {}).get("code") == MM.MARGIN_NOT_MEANINGFUL)


def services_shaped_payload() -> Dict[str, Any]:
    """TC-3 COVERAGE FOR ``withheld_basis`` / ``no_cost_of_sales``. SYNTHETIC,
    labelled: the retail book with its cost of sales reported inside its
    operating expenses — the shape of a services company, meaningful
    turnover and no cost of sales — and no served gross-margin metric, so the
    table divides its own statements. Until the margin rule (2026-09-26) the
    developer's gross margin reached this branch; since it, the developer's
    margins are refused as not meaningful, so no committed book does, and a
    battery without it would check ``withheld_basis`` vacuously."""
    payload = payload_for("retail", "served")
    st = payload["statements"]
    inc = dict(st["incomeStatement"])
    inc["operatingExpenses"] = inc["operatingExpenses"] + inc["costOfGoodsSold"]
    inc["costOfGoodsSold"] = 0.0
    st["incomeStatement"] = inc
    payload["metrics"] = [m for m in payload["metrics"] if m["name"] != "gross_margin"]
    return payload


def negative_equity_payload() -> Dict[str, Any]:
    """TC-3 COVERAGE FOR ``withheld_sign`` / ``negative_denominator``.
    SYNTHETIC, labelled: ``synthetic_negative_equity`` — a declared synthetic
    trial balance (equity at -20% of capital) run through the REAL engine by
    ``fixtures/firm/capture.py``, served with its own ``stage_compute`` rows.
    Until the 711 ruling (2026-09-26) the developer's negative EBITDA was the
    committed witness for a negative denominator; its one EBITDA is positive
    since, so the battery needs a book whose denominators really are
    negative (equity and EBITDA both)."""
    from engine.ratios.credit_model import compute_period_metrics

    fixture = _json(FIRM / "synthetic_negative_equity.json")
    statements = dict(fixture["statements"])
    statements["canonical_bs"] = fixture["envelope"]["canonical_bs"]
    statements["assembled_canonical_v1"] = fixture["envelope"]
    rows = compute_period_metrics(copy.deepcopy(fixture["statements"]))
    return {"statements": statements,
            "metrics": [{"name": r["name"], "value": r["value"]} for r in rows],
            "period": {"id": "gate-negative-equity", "period_end": fixture.get("period_end"),
                       "currency": "RON"}}


@pytest.fixture(scope="module")
def coverage_tables(tables) -> Dict[Tuple[str, str], Dict[str, Any]]:
    """The battery the coverage checks walk: every committed table, plus the
    services-shaped retail table (see ``services_shaped_payload``) and the
    synthetic negative-equity book (see ``negative_equity_payload``)."""
    out = dict(tables)
    out[("retail", "services_shaped")] = T.build_ratio_table(services_shaped_payload())
    out[("negative_equity", "synthetic")] = T.build_ratio_table(negative_equity_payload())
    return out


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


def test_every_row_carries_higher_is_better_and_it_is_the_packs(coverage_tables):
    statuses = set()
    for (book, variant), table in coverage_tables.items():
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
    pending_seen: Dict[Tuple[str, str, str], Tuple[Any, Any]] = {}
    for (book, variant), table in sorted(tables.items()):
        rows = _rows(table)
        fe_rows = captures[book]["variants"][variant]
        for key, fe_key in sorted(T.FE_KEY_OF.items()):
            row, fe = rows[key], fe_rows[fe_key]
            compared += 1
            if (book, variant, key) in ONE_EBITDA_FE_PENDING:
                pending_seen[(book, variant, key)] = (row["value_q"], fe["printed"])
                continue
            if fe["printed"] != row["value_q"]:
                failures.append("%s/%s %s: engine %r, FE printed %r (engine value %r from %s)" % (
                    book, variant, key, row["value_q"], fe["printed"], row["value"],
                    [o["source"] for o in row["operands"]]))
                continue
            if fe["value"] is None:
                kind = fe["absence"]["kind"]
                expected = {"undefined_ratio": {"zero_denominator"},
                            "missing": {"operand_absent", "user_input_absent"},
                            # the margin rule (engine.ratios.margin_meaning):
                            # the FE honours the served verdict, the table
                            # decides it over the same statements
                            "not_meaningful": {"margin_not_meaningful"},
                            # an ENGINE refusal both sides print with its
                            # reason: the one EBITDA, or the one
                            # inventory-days block (engine.ratios.inventory_days)
                            "refused": {"ebitda_refused", "inventory_days_refused"}}[kind]
                if row["reason"]["code"] not in expected:
                    failures.append("%s/%s %s: FE refused as %s, engine as %s" % (
                        book, variant, key, kind, row["reason"]["code"]))
            elif fe["value"] == row["value"]:
                bit_equal += 1
    assert compared == len(BOOKS) * len(VARIANTS) * 22
    assert not failures, "ENGINE ≠ PRINTED FE VALUE:\n  " + "\n  ".join(failures)
    assert pending_seen == ONE_EBITDA_FE_PENDING, (
        "the declared one-EBITDA FE divergence changed (the FE caught up, or moved):\n  measured %s\n"
        "  declared %s" % (sorted(pending_seen.items()), sorted(ONE_EBITDA_FE_PENDING.items())))
    # TC-3 — the comparison must have met valued rows, not only refusals.
    # 225 since the one-EBITDA ruling: the FE now divides the served
    # (cent-rounded) EBITDA, so the pending rows compare again.
    assert bit_equal >= 225, "only %d of %d comparisons carried a value" % (bit_equal, compared)


def test_verdicts_match_except_the_declared_ladder_divergence(tables, captures):
    measured: Dict[Tuple[str, str, str], Tuple[str, str]] = {}
    for (book, variant), table in tables.items():
        if variant not in VERDICT_VARIANTS:
            continue
        rows = _rows(table)
        for key, fe_key in T.FE_KEY_OF.items():
            ev, fv = _fe_verdict(rows[key]), captures[book]["variants"][variant][fe_key]["verdict"]
            if ev != fv:
                measured[(book, variant, key)] = (ev, fv)
    declared = dict(MEASURED_VERDICT_DIFFERENCES, **{})
    declared.update(ONE_EBITDA_FE_PENDING_VERDICTS)
    assert measured == declared, (
        "verdict differences changed.\n  undeclared: %s\n  declared but gone: %s" % (
            sorted(set(measured.items()) - set(declared.items())),
            sorted(set(declared.items()) - set(measured.items()))))
    measured = dict((k, v) for k, v in measured.items() if k not in ONE_EBITDA_FE_PENDING_VERDICTS)
    assert {k for (_, _, k) in measured} <= DIVERGENT_LADDER_KEYS

    # The declared set is exactly the keys whose FE ladder differs from the
    # served pack ladder, in the row's display unit (TC-3 both directions).
    fe_ladders: Dict[str, Dict[str, float]] = {}
    engine_ladders: Dict[str, Dict[str, str]] = {}
    for table in tables.values():
        for r in table["rows"]:
            if r["ladder"] is not None:
                engine_ladders.setdefault(r["key"], r["ladder"])
    for book in BOOKS:
        for variant in VERDICT_VARIANTS:
            for fe_key, fe in captures[book]["variants"][variant].items():
                if fe["ladder"] is not None:
                    fe_ladders.setdefault(fe_key, fe["ladder"])
    divergent = set()
    for key, fe_key in T.FE_KEY_OF.items():
        if fe_key not in fe_ladders:
            continue
        pack = {n: float(v) for n, v in (engine_ladders.get(key) or {}).items()}
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
    seen: Dict[str, Dict[str, Any]] = {}
    for table in tables.values():
        for row in table["rows"]:
            if row["band_status"] != "graded":
                # TC-10 — a withheld or refused badge carries no cutoff.
                assert row["ladder"] is None, "%s (%s) serves a ladder %r" % (
                    row["key"], row["band_status"], row["ladder"])
                continue
            seen.setdefault(row["key"], row)
    checked = 0
    for key, band in _GENERAL_SME_BAND_DEFINITIONS.items():
        assert key in seen, "pack key %s is never graded in the battery — its ladder is unobserved" % key
        row = seen[key]
        scale = Decimal(100) if row["display_unit"] == "pct" else Decimal(1)
        for name in ("strong", "healthy", "watch"):
            served = row["ladder"][name]
            assert isinstance(served, str), "%s.%s served as %r" % (key, name, served)
            assert Decimal(served) == Decimal(repr(float(band[name]))) * scale, (
                "%s.%s served %s, pack %r in %s" % (key, name, served, band[name], row["display_unit"]))
            checked += 1
    assert checked == 3 * len(_GENERAL_SME_BAND_DEFINITIONS)


def test_a_withheld_row_carries_no_ladder_even_where_the_pack_bands_it(coverage_tables):
    """TC-3 for the rule above: the battery must contain withheld rows of a
    pack-banded key, or `ladder is None` was only ever checked on keys the
    pack does not band."""
    withheld_banded = [
        (b, v, r["key"], r["band_status"]) for (b, v), t in coverage_tables.items() for r in t["rows"]
        if r["band_status"] in ("ungraded_sector", "withheld_sign", "withheld_basis")
        and r["key"] in _GENERAL_SME_BAND_DEFINITIONS]
    statuses = {w[3] for w in withheld_banded}
    assert statuses == {"ungraded_sector", "withheld_sign", "withheld_basis"}, statuses


# ── enums, coverage, sector withholding ─────────────────────────────────────


def test_reason_codes_and_statuses_are_closed_and_coverage_ties(coverage_tables):
    seen_codes = set()
    for (book, variant), table in coverage_tables.items():
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
                   "negative_denominator", "no_cost_of_sales", "margin_not_meaningful"):
        assert needed in seen_codes, "reason %s never produced — its branch is untested" % needed
    # the margin rule refuses exactly the pack's margin keys, on exactly the
    # book it was measured to refuse, in every variant
    for (book, variant), table in coverage_tables.items():
        refused_by_rule = _margin_refused(table)
        if book in MARGIN_REFUSED_BOOKS:
            assert refused_by_rule == frozenset(MM.margin_keys()), (book, variant, sorted(refused_by_rule))
        else:
            assert not refused_by_rule, (book, variant, sorted(refused_by_rule))


#: The sector-withheld set, declared (not derived from the module): the
#: FE's six plus the metric-only keys whose FE sibling is one of them.
DECLARED_SECTOR_WITHHELD = frozenset({
    "gross_margin", "ebitda_margin", "net_margin", "dio", "dso", "asset_turnover",
    "operating_margin", "core_ebitda_margin", "inventory_turnover",
})


def test_the_sector_withheld_set_is_declared_and_follows_the_sibling_rule():
    assert T.SECTOR_WITHHELD_KEYS == DECLARED_SECTOR_WITHHELD, sorted(
        T.SECTOR_WITHHELD_KEYS ^ DECLARED_SECTOR_WITHHELD)
    # Keys with no FE row: the engine-metric-only ones and inventory
    # turnover (read from the served inventory-days block on both sides).
    metric_only = {k for k, p in T.PRECEDENCE.items()
                   if p == "metric_only" or (p == "served_block" and k not in T.FE_KEY_OF)}
    assert set(T.SECTOR_SIBLING_OF) == metric_only, "every metric-only key declares a sibling"
    for key, sibling in T.SECTOR_SIBLING_OF.items():
        assert sibling in T.FE_KEY_OF, "%s's sibling %s is not an FE row" % (key, sibling)
        assert T._SPEC_BY_KEY[key].group == T._SPEC_BY_KEY[sibling].group, (key, sibling)
        assert (key in DECLARED_SECTOR_WITHHELD) == (sibling in T.SECTOR_CALIBRATED_RATIOS), (key, sibling)


def test_sector_withholding_follows_the_payload_signal(tables):
    for book in BOOKS:
        served, disputed = _rows(tables[(book, "served")]), _rows(tables[(book, "disputed")])
        valued = {k for k in T.CENSUS if disputed[k]["value"] is not None}
        withheld = {k for k in T.CENSUS if disputed[k]["band_status"] == "ungraded_sector"}
        assert withheld == DECLARED_SECTOR_WITHHELD & valued, (
            "%s disputed: withheld %s, declared %s" % (
                book, sorted(withheld), sorted(DECLARED_SECTOR_WITHHELD & valued)))
        # TC-3 — the metric-only members must have been met with a value —
        # or, on the book the margin rule refuses, refused as not
        # meaningful (a margin with no value has no band to withhold).
        refused_by_rule = _margin_refused(tables[(book, "disputed")])
        # ... or refused by the ONE inventory-days block (the developer: no
        # own product sold, merchandise with no 607 — every leg refuses).
        refused_by_block = {k for k in T.CENSUS
                            if (disputed[k]["reason"] or {}).get("code") == "inventory_days_refused"}
        assert {"operating_margin", "core_ebitda_margin", "inventory_turnover"} <= (
            valued | refused_by_rule | refused_by_block), book
        assert bool(refused_by_rule) == (book in MARGIN_REFUSED_BOOKS), (book, sorted(refused_by_rule))
        for key in T.CENSUS:
            assert served[key]["band_status"] != "ungraded_sector", (book, key)


def test_a_source_that_declares_absence_refuses_every_row():
    payload = payload_for("agras", "served")
    payload["statements"]["absentInputs"] = ["interestExpense"]
    table = T.build_ratio_table(payload)
    assert table["coverage"]["served"] == 0
    assert set(table["coverage"]["refused"].values()) == {"source_declares_absence"}
    for row in table["rows"]:
        assert isinstance(row.get("higher_is_better"), bool), row["key"]
        assert row["ladder"] is None, row["key"]


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


# ── precedence: the declared table is what computeRatios does ─────────────


def _metric(book: str, key: str) -> Any:
    return _SERVED_METRICS[book].get(key)


#: `served_block` keys that COMPOSE the block's term with two FE rows:
#: key -> (added row, subtracted row).
SERVED_BLOCK_COMPOSITES = {"ccc": ("dso", "dpo")}


def test_declared_precedence_is_what_computeRatios_does_under_perturbed_metrics(tables, captures):
    """The perturbed capture multiplies every served metric by 1.37. A key
    the FE takes from the metric first moves to metric × 1.37 exactly; a
    key it takes from the printed statements first does not move at all.
    The declared `PRECEDENCE` must say which, key by key, and the engine
    rows must read the same side."""
    observed = {"mOr": 0, "bsOr": 0, "served_block": 0}
    failures: List[str] = []
    for book in BOOKS:
        served = captures[book]["variants"]["served"]
        pert = captures[book]["variants"]["perturbed"]
        engine = _rows(tables[(book, "perturbed")])
        refused_by_rule = _margin_refused(tables[(book, "perturbed")])
        for key, fe_key in T.FE_KEY_OF.items():
            decl = T.PRECEDENCE[key]
            metric = _metric(book, key)
            s_row, p_row, e_row = served[fe_key], pert[fe_key], engine[key]
            sources = [o["source"] for o in e_row["operands"]]
            if key in refused_by_rule:
                # The margin rule refuses before any precedence applies:
                # both sides refuse, and neither side's source is chosen.
                if p_row["value"] is not None or (p_row["absence"] or {}).get("kind") != "not_meaningful":
                    failures.append("%s %s refused by the margin rule, FE perturbed %r" % (
                        book, key, p_row["value"]))
                continue
            if decl == "mOr" and metric is not None:
                scale = 100.0 if T._SPEC_BY_KEY[key].display_unit == "pct" else 1.0
                expected = (metric * METRIC_PERTURBATION) * scale if scale != 1.0 else metric * METRIC_PERTURBATION
                if p_row["value"] != expected:
                    failures.append("%s %s declared mOr, FE perturbed %r != metric×1.37 %r" % (
                        book, key, p_row["value"], expected))
                if sources != ["metrics." + key]:
                    failures.append("%s %s declared mOr, engine read %s" % (book, key, sources))
                observed["mOr"] += 1
            elif decl == "bsOr" and s_row["value"] is not None and metric is not None:
                if p_row["value"] != s_row["value"]:
                    failures.append("%s %s declared bsOr, FE moved with the metric: %r -> %r" % (
                        book, key, s_row["value"], p_row["value"]))
                if any(src.startswith("metrics.") for src in sources):
                    failures.append("%s %s declared bsOr, engine read %s" % (book, key, sources))
                observed["bsOr"] += 1
            elif decl == "served_block" and key in SERVED_BLOCK_COMPOSITES:
                # The CCC: the block's PERIOD-END term plus the FE's own DSO
                # and DPO rows as they themselves are read (perturbed with
                # them) — the inventory term never moves with a metric.
                plus, minus = SERVED_BLOCK_COMPOSITES[key]
                block = payload_for(book, "served")["statements"]["inventory_days"]
                closing = block["total"]["closing_value"]
                if closing is None or pert[plus]["value"] is None or pert[minus]["value"] is None:
                    expected = None
                else:
                    expected = pert[plus]["value"] + closing - pert[minus]["value"]
                if (expected is None) != (p_row["value"] is None) or (
                        expected is not None and abs(p_row["value"] - expected) > 1e-9):
                    failures.append("%s %s declared served_block, FE perturbed %r != %s + block %r - %s = %r"
                                    % (book, key, p_row["value"], plus, closing, minus, expected))
                if "inventory_days.total.closing_value" not in sources:
                    failures.append("%s %s declared served_block, engine read %s" % (book, key, sources))
                observed["served_block"] += 1
            elif decl == "served_block":
                # Both sides read the ONE inventory-days block: perturbing
                # the metric rows moves neither, and the engine reads no
                # metric row and no statement division for the block's term.
                if p_row["value"] != s_row["value"]:
                    failures.append("%s %s declared served_block, FE moved with the metric: %r -> %r" % (
                        book, key, s_row["value"], p_row["value"]))
                if not any(src.startswith("inventory_days.") for src in sources):
                    failures.append("%s %s declared served_block, engine read %s" % (book, key, sources))
                if any(src == "metrics." + key for src in sources):
                    failures.append("%s %s declared served_block, engine read its metric %s" % (
                        book, key, sources))
                observed["served_block"] += 1
            elif decl == "user_input":
                assert p_row["value"] is None and e_row["value"] is None, (book, key)
    assert not failures, "PRECEDENCE:\n  " + "\n  ".join(failures)
    # TC-3 — every declared choice met on at least one book with both sides.
    declared_mor = {k for k, p in T.PRECEDENCE.items() if p == "mOr"}
    declared_bsor = {k for k, p in T.PRECEDENCE.items() if p == "bsOr"}
    met_mor = {k for b in BOOKS for k in declared_mor if _metric(b, k) is not None}
    met_bsor = {k for b in BOOKS for k in declared_bsor if _metric(b, k) is not None}
    assert met_mor == declared_mor, sorted(declared_mor - met_mor)
    assert met_bsor == declared_bsor, sorted(declared_bsor - met_bsor)
    # dio and ccc left `mOr` for `served_block` (the inventory-days ruling):
    # measured 26 mOr / 44 bsOr / 8 served_block (2 FE rows x 4 books). dpo
    # then left `mOr` for `bsOr` (the ONE DPO on the period's day count,
    # computed first as DSO is): measured 22 mOr / 48 bsOr / 8 served_block.
    assert observed["mOr"] >= 22 and observed["bsOr"] >= 48, observed
    assert observed["served_block"] == len(BOOKS) * sum(
        1 for k, p in T.PRECEDENCE.items() if p == "served_block" and k in T.FE_KEY_OF), observed


# ── one key, one formula: the no-metric route body ──────────────────────────


@pytest.fixture(scope="module")
def route_bodies() -> Dict[str, Dict[str, Any]]:
    """GET /api/period/{id} for the four firm books through the REAL router
    (`test_insights_wire._served_via_route`: corpus → stage_map →
    stage_persist → the route over the projection-faithful double). The
    body carries no metric rows, so every `mOr` key takes its fallback."""
    import sys
    here = str(Path(__file__).resolve().parent)
    if here not in sys.path:
        sys.path.insert(0, here)
    import test_insights_wire as W
    import test_rebuild_net_income_anchor as A

    out: Dict[str, Dict[str, Any]] = {}
    for case_id, case_dir, _p121 in A.ANCHOR_CASES:
        prefix = "saga_10_col_"
        if not case_id.startswith(prefix) or case_id[len(prefix):] not in BOOKS:
            continue
        mp = MonkeyPatch()
        try:
            status, body = W._served_via_route(A._book(case_id, case_dir), mp)
        finally:
            mp.undo()
        assert status == 200, (case_id, status)
        out[case_id[len(prefix):]] = body
    assert set(out) == set(BOOKS), sorted(out)
    return out


def test_the_served_metrics_carry_the_rounding_the_tolerance_assumes():
    for book in BOOKS:
        for key, p in T.PRECEDENCE.items():
            v = _metric(book, key)
            if p == "mOr" and v is not None:
                assert -Decimal(repr(v)).as_tuple().exponent <= METRIC_STORED_DECIMALS, (book, key, v)


def test_a_period_with_no_metric_rows_serves_the_metrics_own_formula(route_bodies):
    tolerance = 0.5 * 10 ** -METRIC_STORED_DECIMALS + 1e-12
    failures: List[str] = []
    compared = 0
    for book in BOOKS:
        body = route_bodies[book]
        assert not body.get("metrics"), "%s: the route body carries metric rows — the fallback is not exercised" % book
        table = T.build_ratio_table(body)
        rows = _rows(table)
        refused_by_rule = _margin_refused(table)
        assert bool(refused_by_rule) == (book in MARGIN_REFUSED_BOOKS), (book, sorted(refused_by_rule))
        for key, p in T.PRECEDENCE.items():
            if p != "mOr":
                continue
            metric, row = _metric(book, key), rows[key]
            if metric is None:
                continue
            if key in refused_by_rule:
                # Refused by the margin rule, on the route's own verdict:
                # checked against the rule instead of the metric's formula
                # (both are the authority for this key on this book), so it
                # counts as compared.
                if body["statements"]["margin_meaning"]["status"] != MM.NOT_MEANINGFUL:
                    failures.append("%s %s refused by the margin rule the route did not serve" % (book, key))
                compared += 1
                continue
            if row["value"] is None:
                failures.append("%s %s: metric %r served, the fallback refused %s" % (book, key, metric, row["reason"]))
                continue
            scale = 100.0 if row["display_unit"] == "pct" else 1.0
            compared += 1
            if abs(row["value"] / scale - metric) > tolerance:
                failures.append("%s %s: fallback %r is not the metric %r (formula differs)" % (
                    book, key, row["value"] / scale, metric))
        sources = lambda k: [o["source"] for o in rows[k]["operands"]]  # noqa: E731
        if "assembled_pl.net_income_statutory" not in sources("net_margin") \
                or "incomeStatement.taxExpense" in sources("net_margin"):
            failures.append("%s net_margin numerator is not the anchor: %s" % (book, sources("net_margin")))
        # Interest coverage is EBIT ÷ interest (the methodology, CLAUDE.md
        # Appendix A section 5), and EBIT is THE one operating result the
        # assembled P&L serves (711 and 72x inside) — never an EBIT rebuilt
        # here from the incomeStatement mirror. EBITDA ÷ interest is the
        # separate ebitda_to_interest row (metric-only), which must not read
        # the operating result.
        if rows["interest_coverage"]["value"] is not None and (
                "assembled_pl.operating_result" not in sources("interest_coverage")
                or "incomeStatement.interestExpense" not in sources("interest_coverage")):
            failures.append("%s interest_coverage is not the one EBIT ÷ interest: %s" % (
                book, sources("interest_coverage")))
        if rows["ebitda_to_interest"]["value"] is not None and (
                "assembled_pl.operating_result" in sources("ebitda_to_interest")):
            failures.append("%s ebitda_to_interest reads the operating result: %s" % (
                book, sources("ebitda_to_interest")))
        # The DSCRs divide THE one EBITDA — until the ruling a second,
        # "statutory" EBITDA read through a fallback chain.
        for key in ("dscr", "dscr_with_lt_principal"):
            if "assembled_pl.ebitda" not in sources(key) or any(
                    s.startswith("incomeStatement.") and s != "incomeStatement.interestExpense"
                    for s in sources(key)):
                failures.append("%s %s does not divide the one EBITDA: %s" % (book, key, sources(key)))
        # INVENTORY DAYS: the route's rows are the route's OWN served block
        # (statements.inventory_days) — its value on its basis, the CCC on the
        # period-end term, or the block's refusal; never a division here.
        block = body["statements"].get("inventory_days")
        if not isinstance(block, dict):
            failures.append("%s: the route serves no inventory_days block" % book)
            continue
        total = block["total"]
        for key, expected in (("dio", total["value"]),
                              ("inventory_turnover", block["inventory_turnover"]["value"])):
            compared += 1
            if rows[key]["value"] != expected:
                failures.append("%s %s: %r is not the served block's %r" % (
                    book, key, rows[key]["value"], expected))
            if expected is None and rows[key]["reason"]["code"] != "inventory_days_refused":
                failures.append("%s %s refused as %s, not the block's refusal" % (
                    book, key, rows[key]["reason"]["code"]))
        compared += 1
        if total["closing_value"] is None:
            if rows["ccc"]["value"] is not None:
                failures.append("%s ccc served beside a refused block: %r" % (book, rows["ccc"]["value"]))
        elif "inventory_days.total.closing_value" not in sources("ccc"):
            failures.append("%s ccc does not add the block's period-end term: %s" % (book, sources("ccc")))
    assert not failures, "ONE KEY, TWO FORMULAS:\n  " + "\n  ".join(failures)
    assert compared >= 35, compared


# ── metric-only rows ────────────────────────────────────────────────────────


def _pack_verdict(raw: float, band: Dict[str, Any]) -> str:
    """The pack ladder applied to the RAW metric (fractions for margins),
    independently of the module's display-unit conversion."""
    higher = band["direction"] == "higher"
    for name in ("strong", "healthy", "watch"):
        if (raw >= band[name]) if higher else (raw <= band[name]):
            return name
    return "critical"


def test_metric_only_rows_are_the_served_metric_graded_on_the_pack(tables):
    graded = 0
    for (book, variant), table in tables.items():
        if variant != "served":
            continue
        rows = _rows(table)
        refused_by_rule = _margin_refused(table)
        for key, p in T.PRECEDENCE.items():
            if p != "metric_only":
                continue
            row, metric = rows[key], _metric(book, key)
            if key in refused_by_rule:
                # A margin the rule refuses is served as the refusal, never
                # as the metric: no value, no band, the share and threshold.
                assert book in MARGIN_REFUSED_BOOKS, (book, key)
                assert row["value"] is None and row["band_status"] == "refused", (book, key, row)
                assert row["reason"]["threshold"] == MM.margin_meaning_pack().share_below_text, row["reason"]
                continue
            if metric is None:
                assert row["value"] is None and row["reason"] == {
                    "code": "engine_metric_absent", "inputs": ["metrics." + key]}, (book, key, row)
                continue
            expected = metric * 100 if row["display_unit"] == "pct" else metric
            assert row["value"] == expected, (book, key, row["value"], expected)
            assert row["operands"] == [{"name": key, "value": metric, "source": "metrics." + key}]
            if row["band_status"] == "graded":
                assert row["band"] == _pack_verdict(metric, _GENERAL_SME_BAND_DEFINITIONS[key]), (
                    book, key, metric, row["band"])
                graded += 1
        # Inventory turnover left the metric-only rows for the ONE served
        # block (the inventory-days ruling): its row is the block's figure,
        # graded on the same pack ladder the metric row was.
        row = rows["inventory_turnover"]
        value = payload_for(book, "served")["statements"]["inventory_days"]["inventory_turnover"]["value"]
        assert row["value"] == value, (book, row["value"], value)
        if row["band_status"] == "graded":
            assert row["band"] == _pack_verdict(value, _GENERAL_SME_BAND_DEFINITIONS["inventory_turnover"]), (
                book, value, row["band"])
            graded += 1
    assert graded >= 18, graded
    # The developer's net debt / EBITDA divides THE one EBITDA (the ruling
    # turned it from -29.0M to +0.55M): graded on it, no longer withheld
    # on the sign of the EBITDA without 711. The sign guard itself is held
    # on a planted negative EBITDA (SIGN_CASES "net_debt_to_ebitda").
    re = _rows(tables[("realestate", "served")])["net_debt_to_ebitda"]
    assert re["band_status"] == "graded" and re["value"] == _metric("realestate", "net_debt_to_ebitda"), re


# ── sign withholding, key by key ────────────────────────────────────────────

#: Census keys whose ladder is applied whatever the sign of their
#: denominator — a negative NUMERATOR over a positive base is a true
#: distress reading (`computeRatios`' "NOT LISTED, DELIBERATELY" set, plus
#: the metric-only coverage twin and the composite ccc).
SIGN_EXEMPT = frozenset({"interest_coverage", "ebitda_to_interest", "dscr", "dscr_with_lt_principal",
                         "adjusted_dscr", "ccc"})


def _neg_total(concept: str):
    orig = T._gateway_totals

    def patched(statements):
        out = dict(orig(statements))
        out[concept] = (-1.0e12, "canonical_bs." + concept)
        return out
    return patched


def _set(path: Tuple[str, str], value: float):
    def edit(payload):
        payload["statements"][path[0]] = dict(payload["statements"][path[0]])
        payload["statements"][path[0]][path[1]] = value
    return edit


def _set_block(path: Tuple[str, ...], value: float):
    def edit(payload):
        block = copy.deepcopy(payload["statements"]["inventory_days"])
        node = block
        for k in path[:-1]:
            node = node[k]
        node[path[-1]] = value
        payload["statements"] = dict(payload["statements"], inventory_days=block)
    return edit


#: (case id, book, payload edit or None, gateway concept made negative or
#: None, {key: named input or None when the denominator is a composite}).
SIGN_CASES = (
    ("current_liabilities", "agras", None, "current_liabilities",
     {"current_ratio": "canonical_bs.current_liabilities", "quick_ratio": "canonical_bs.current_liabilities",
      "cash_ratio": "canonical_bs.current_liabilities"}),
    ("revenue", "agras", _set(("incomeStatement", "revenue"), -1.0e12), None,
     {"gross_margin": "incomeStatement.revenue", "ebitda_margin": "incomeStatement.revenue",
      "net_margin": "incomeStatement.revenue", "dso": "incomeStatement.revenue"}),
    ("total_assets", "agras", None, "total_assets",
     {"roa": "canonical_bs.total_assets", "debt_to_assets": "canonical_bs.total_assets",
      "equity_ratio": "canonical_bs.total_assets", "asset_turnover": "canonical_bs.total_assets"}),
    ("equity", "agras", None, "equity",
     {"roe": "canonical_bs.equity", "debt_to_equity": "canonical_bs.equity",
      "lt_debt_to_equity": "canonical_bs.equity", "roic": None}),
    # THE ONE EBITDA (2026-09-26): a negative served EBITDA, planted on the
    # assembled P&L the table reads (the developer's was the committed
    # negative until the ruling turned it positive).
    ("ebitda", "agras", _set(("assembled_pl", "ebitda"), -1.0e12), None,
     {"debt_to_ebitda": "assembled_pl.ebitda"}),
    ("operating_expense", "agras", _set(("incomeStatement", "operatingExpenses"), -1.0e12), None,
     {"dpo": None}),
    # INVENTORY DAYS read the ONE served block (engine.ratios.inventory_days):
    # its sign denominators are the block's own total flow and average stock
    # (the block refuses a non-positive flow itself; the plant keeps the
    # value and turns the operand negative, so only the guard can react).
    ("inventory_flow", "agras", _set_block(("total", "flow", "value"), -1.0e12), None,
     {"dio": "inventory_days.total.flow.value"}),
    ("net_debt_to_ebitda", "agras", _set(("assembled_pl", "ebitda"), -1.0e12), None,
     {"net_debt_to_ebitda": "assembled_pl.ebitda"}),
    ("apl_revenue", "agras", _set(("assembled_pl", "revenue"), -1.0e12), None,
     {"operating_margin": "assembled_pl.revenue", "core_ebitda_margin": "assembled_pl.revenue"}),
    ("inventory", "agras", _set_block(("total", "stock", "average"), -1.0e12), None,
     {"inventory_turnover": "inventory_days.total.stock.average"}),
)


def test_every_census_key_is_either_sign_guarded_or_declared_exempt():
    guarded = set()
    for _cid, _b, _e, _c, keys in SIGN_CASES:
        guarded |= set(keys)
    assert not guarded & SIGN_EXEMPT, sorted(guarded & SIGN_EXEMPT)
    assert guarded | SIGN_EXEMPT == set(T.CENSUS), sorted(set(T.CENSUS) - guarded - SIGN_EXEMPT)


@pytest.mark.parametrize("case_id,book,edit,concept,keys", SIGN_CASES, ids=[c[0] for c in SIGN_CASES])
def test_a_negative_denominator_withholds_the_band_and_names_it(case_id, book, edit, concept, keys, monkeypatch):
    payload = payload_for(book, "served")
    if edit is not None:
        edit(payload)
    if concept is not None:
        monkeypatch.setattr(T, "_gateway_totals", _neg_total(concept))
    rows = _rows(T.build_ratio_table(payload))
    for key, named in keys.items():
        row = rows[key]
        assert row["value"] is not None, (case_id, key, row["reason"])
        assert row["band_status"] == "withheld_sign", (case_id, key, row["band_status"], row["value"])
        assert row["band"] is None and row["ladder"] is None, (case_id, key)
        assert row["reason"]["code"] == "negative_denominator", (case_id, key)
        if named is not None:
            assert row["reason"]["inputs"] == [named], (case_id, key, row["reason"])


# ── the grading boundary ────────────────────────────────────────────────────

#: (ladder, higher_is_better, value, band). A value exactly on a rung takes
#: that rung, in both directions; one step past the last rung is the floor.
BOUNDARY_CASES = (
    ({"strong": "2", "healthy": "1.5", "watch": "1"}, True, 2.0, "strong"),
    ({"strong": "2", "healthy": "1.5", "watch": "1"}, True, 1.5, "healthy"),
    ({"strong": "2", "healthy": "1.5", "watch": "1"}, True, 1.0, "watch"),
    ({"strong": "2", "healthy": "1.5", "watch": "1"}, True, 0.99, "critical"),
    ({"strong": "30", "healthy": "60", "watch": "100"}, False, 30.0, "strong"),
    ({"strong": "30", "healthy": "60", "watch": "100"}, False, 60.0, "healthy"),
    ({"strong": "30", "healthy": "60", "watch": "100"}, False, 100.0, "watch"),
    ({"strong": "30", "healthy": "60", "watch": "100"}, False, 100.5, "critical"),
)


@pytest.mark.parametrize("ladder,higher,value,band", BOUNDARY_CASES)
def test_a_value_on_a_rung_takes_that_rung(ladder, higher, value, band):
    assert T._grade(value, ladder, higher) == band


def test_the_dpo_floor_is_pack_data_and_the_grader_reads_it(tables):
    """A DPO below the watch rung grades watch, never critical, because the
    PACK DEFINITION says so — not because the grader special-cases a key.

    Reds AFTER the ruling on: the floor leaving the dpo definition (the
    agras 27-day and retail 29-day rows go critical here AND in the verdict
    gate above), a second key declaring a floor nobody ruled, the grader
    ignoring a declared floor, or a floor outside LADDER_FLOORS being
    accepted silently."""
    floors = {k: v["floor"] for k, v in _GENERAL_SME_BAND_DEFINITIONS.items() if "floor" in v}
    assert floors == {"dpo": "watch"}, floors
    assert _GENERAL_SME_BAND_DEFINITIONS["dpo"]["watch"] == 30, "the watch rung forecast traversal walks to moved"
    ladder = {"strong": "60", "healthy": "45", "watch": "30"}
    assert T._grade(27.0, ladder, True, T.ladder_floor({"floor": "watch"}, ladder)) == "watch"
    assert T._grade(27.0, ladder, True, T.ladder_floor({}, ladder)) == "critical"
    with pytest.raises(ValueError):
        T.ladder_floor({"floor": "strong"}, ladder)
    seen = 0
    for book in ("agras", "retail"):
        for variant in VERDICT_VARIANTS:
            row = _rows(tables[(book, variant)])["dpo"]
            assert row["band_status"] == "graded" and float(row["value"]) < 30, (book, variant, row)
            assert row["band"] == "watch", "%s/%s dpo %s days grades %s below the floor" % (
                book, variant, row["value_q"], row["band"])
            seen += 1
    assert seen == 4


def _regrade_from_the_served_row(row: Dict[str, Any]) -> str:
    """The band a reader holding ONLY the served row would print: the first
    rung (strong, healthy, watch — best first) the value reaches in the
    row's direction, else the served `ladder_floor`. Spelled here, not
    borrowed from the grader, so a grader and a row that agree by sharing a
    mistake still meet a second reading."""
    value = float(row["value"])
    for name in ("strong", "healthy", "watch"):
        if name not in row["ladder"]:
            continue
        rung = float(row["ladder"][name])
        if (value >= rung) if row["higher_is_better"] else (value <= rung):
            return name
    return row["ladder_floor"]


def _served_graded_rows(tables) -> List[Tuple[str, Dict[str, Any]]]:
    import sys
    here = str(Path(__file__).resolve().parent)
    if here not in sys.path:
        sys.path.insert(0, here)
    import _served_books as SB

    out = [("%s/%s" % bv, r) for bv, t in tables.items() for r in t["rows"] if r["band_status"] == "graded"]
    for name in SB.ALL_BOOKS:
        table = SB.served_body(name)["assembled_metrics"]["ratio_table"]
        out += [("%s/route" % name, r) for r in table["rows"] if r["band_status"] == "graded"]
    return out


def test_every_graded_row_regrades_from_its_served_ladder_and_floor_alone(tables):
    """TC-10: the served document is enough to reproduce its own verdict.

    Reds AFTER the repair on: a graded row serving no `ladder_floor` or one
    outside LADDER_FLOORS; any graded row — firm fixtures in every variant,
    and the REAL GET /api/period ratio_table of the four corpus books and
    the Scandia baseline — whose served band is not what its served ladder
    plus served floor give (the agras and retail dpo rows below watch 30 are
    the rows a ladder-only reading gets wrong); the battery no longer
    meeting a row that sits past its last rung on a declared floor (TC-3);
    or a row that is not graded serving a floor."""
    rows = _served_graded_rows(tables)
    missing = sorted({(where, r["key"]) for where, r in rows if r.get("ladder_floor") not in T.LADDER_FLOORS})
    assert not missing, "graded rows serving no floor: %s" % missing[:12]
    wrong = sorted((where, r["key"], r["value_q"], r["band"], _regrade_from_the_served_row(r))
                   for where, r in rows if _regrade_from_the_served_row(r) != r["band"])
    assert not wrong, "served band is not the served ladder + floor (where, key, value, band, regrade): %s" % wrong
    past_last_on_declared = sorted({(where, r["key"]) for where, r in rows
                                    if r["ladder_floor"] == "watch" and r["band"] == "watch"
                                    and "watch" in r["ladder"]
                                    and not ((float(r["value"]) >= float(r["ladder"]["watch"]))
                                             if r["higher_is_better"]
                                             else (float(r["value"]) <= float(r["ladder"]["watch"])))})
    assert {w.split("/")[0] for w, k in past_last_on_declared if k == "dpo"} >= {"agras", "retail"}, (
        past_last_on_declared)
    for table in tables.values():
        for r in table["rows"]:
            if r["band_status"] != "graded":
                assert r["ladder_floor"] is None, (r["key"], r["band_status"], r["ladder_floor"])


# ── the legacy tier ─────────────────────────────────────────────────────────


def _legacy_payload() -> Dict[str, Any]:
    payload = copy.deepcopy(payload_for("agras", "served"))
    st = payload["statements"]
    del st["canonical_bs"]
    # The re-assembled methodology round-trip, deliberately drifted: a
    # table that read it would divide these.
    cv1 = copy.deepcopy(st["assembled_canonical_v1"])
    cv1.pop("canonical_bs", None)
    totals = (cv1.get("methodology") or {}).get("totals") or {}
    for k in list(totals):
        if isinstance(totals[k], (int, float)):
            totals[k] = totals[k] * 1.10
    st["assembled_canonical_v1"] = cv1
    return payload


def test_a_legacy_period_reads_the_served_assembled_bs_totals():
    payload = _legacy_payload()
    ab = payload["statements"]["assembled_bs"]
    row = _rows(T.build_ratio_table(payload))["current_ratio"]
    assert [o["source"] for o in row["operands"]] == [
        "assembled_bs.total_current_assets", "assembled_bs.total_current_liabilities"], row["operands"]
    assert row["value"] == ab["total_current_assets"] / ab["total_current_liabilities"]
    eq = _rows(T.build_ratio_table(payload))["equity_ratio"]
    assert eq["value"] == ab["total_equity"] / ab["total_assets"] * 100
    assert "assembled_bs.total_equity" in [o["source"] for o in eq["operands"]]


def test_a_legacy_period_without_the_grand_total_triple_refuses_the_totals():
    payload = _legacy_payload()
    payload["metrics"] = []
    del payload["statements"]["assembled_bs"]["total_liabilities"]
    rows = _rows(T.build_ratio_table(payload))
    for key, inputs in (("current_ratio", {"assembled_bs.total_current_assets",
                                           "assembled_bs.total_current_liabilities"}),
                        ("equity_ratio", {"assembled_bs.total_equity", "assembled_bs.total_assets"})):
        row = rows[key]
        assert row["value"] is None and row["reason"]["code"] == "operand_absent", (key, row)
        assert set(row["reason"]["inputs"]) == inputs, (key, row["reason"])


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
