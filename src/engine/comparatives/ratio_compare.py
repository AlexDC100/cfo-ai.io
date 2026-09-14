"""TWO PERIODS' RATIOS, side by side — served once, read by every surface.

The engine is the one authority for ratio values, bands, deltas, band
movements and credit composites for BOTH periods (critic
authority_decision). This module composes the two-period block
`GET /api/period/{id}/comparatives` serves as `ratios`, from the two
payloads `get_period` served for the two periods. It does no reading of
its own: each side is `engine.ratios.table.build_ratio_table` over that
side's served payload with `serve_time_metrics=True`, which runs
`engine.ratios.credit_model.compute_period_metrics` on that side's served
statements. So the prior's composite exists even when the prior carries no
persisted `calculated_metrics` row, and both sides are scored under ONE
`CREDIT_MODEL_REVISION` and ONE band table.

── WHAT A ROW SAYS ───────────────────────────────────────────────────────

  current / prior  the per-period table's side, verbatim (value at full
                   precision, value_q quantized, band, band_status, ladder,
                   operands, reason).
  delta            computed from the QUANTIZED sides, so printed prior plus
                   printed delta equals printed current: the document ties
                   to itself. Units: turns (x), pp (pct), days, z, points
                   (score), notches (letter). `pct_change` on turns rows
                   only, null when the quantized prior is zero. A delta that
                   quantizes to zero is favourable `none`.
  movement         band ranks critical 0, watch 1, healthy 2, strong 3 (the
                   letter ladder's own index for letter_grade); the last
                   rung passed in the direction of travel; the distance past
                   it; the width of the band arrived in (`closed` between
                   two rungs, else the `adjacent` closed band's width); the
                   distance as a fraction of that width; and materiality.
                   A movement needs BOTH sides graded on the same ladder;
                   otherwise `not_comparable` with the reason.

── MATERIALITY (the per-key basis table, printed on the payload) ─────────

A crossing is worth money: how far the numerator sits past the rung,
holding the denominator the table divided by. For a ratio r = N / D with
rung R, that is |r - R| * |D| / scale (scale 1 for x, 100 for pct, the
period's day count for days). `share` divides it by the base of the
statement the NUMERATOR belongs to: total assets for a balance-sheet
numerator (liquidity, leverage, working-capital days, net debt / EBITDA),
revenue for a P&L numerator (margins, returns, coverage, turnover). ccc
(a sum of three day counts) and adjusted_dscr (a user input) have no money
denominator and carry no materiality. `MATERIALITY_BASES` is that table;
it is served as `band_movements.rank_basis.bases`. No floor is ruled:
`materiality_floor` is served null, and nothing is hidden for being small.

── RANKING ───────────────────────────────────────────────────────────────

`RANK_ORDER`: |rungs crossed| desc, distance fraction desc (nulls last),
materiality share desc (nulls last), key asc. Served as
`band_movements.rank_basis.order`.

── COMPOSITES ────────────────────────────────────────────────────────────

altman_z: band read from the served zone (safe -> healthy, grey -> watch,
distress -> critical), never re-banded. letter_grade: band is the letter,
ladder is CREDIT_LETTER_LADDER, movement in notches. credit_composite and
the seven sub-scores carry deltas in points but no band of their own: the
letter grades the composite, so they are `not_comparable` with
`graded_by_letter` / `not_in_pack_bands`, and sub-scores are never listed
as movements.

── PIOTROSKI ─────────────────────────────────────────────────────────────

The current side is computed WITH the loaded prior (checks 5-9 evaluate).
The prior side is the prior's served block, capped at 4 because ITS prior
is not loaded, with that cap stated. Unequal check counts are not a
like-for-like score, so Piotroski is excluded from band movements. The
check function is the country pack's and is INJECTED by the caller
(`engine.api._comparatives`): this package imports no pack (E8).

── SECTOR WITHHOLDING ────────────────────────────────────────────────────

`industry_signal` is served per payload. The same company's two years are
graded on the same sector decision: when EITHER side's signal blocks
sector content, BOTH sides withhold exactly the table's
`SECTOR_WITHHELD_KEYS` (the calibrated six plus their declared siblings).

── STAMPS AND EFFECTIVE-DATING ───────────────────────────────────────────

Each side carries its table's stamps (credit_model_revision, bands source
and table_sha256, pack_provenance from that period's PERSISTED envelope,
assembled_at serve). Bands and the credit model are in-code tables with no
effective date, so both periods are graded and scored under the CURRENT
revision: restated comparatives. That is the retrospective-restatement
CONVENTION, stated as `effective_dating`, not an engine fact.

Findings: `band_movements.findings` and every row's `finding_id` are
served empty / null here; the seven-element crossing findings are the
next batch (B5).

Pure over its inputs: no clock, no I/O, deterministic JSON.
"""
from __future__ import annotations

import copy
from decimal import ROUND_HALF_UP, Decimal
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence, Tuple

from engine.ratios import credit_model as CM
from engine.ratios import table as T

COMPARE_TABLE_VERSION = "ratio_compare.v1"

#: Codes a served delta carries when it has no value, or no direction.
DELTA_REASON_CODES: Tuple[str, ...] = (
    "current_refused",
    "prior_refused",
    "both_refused",
    "direction_withheld",
)

#: Codes a `not_comparable` movement carries beyond the table's own band
#: codes (sector_unconfirmed, negative_denominator, no_cost_of_sales,
#: not_in_pack_bands), which a movement reuses verbatim.
MOVEMENT_REASON_CODES: Tuple[str, ...] = (
    "current_refused",
    "prior_refused",
    "both_refused",
    "ladder_differs",
    "graded_by_letter",
)

#: Codes the composite rows and the Piotroski block carry.
COMPOSITE_REASON_CODES: Tuple[str, ...] = (
    "credit_inputs_absent",
    "graded_by_letter",
    "piotroski_prior_capped",
)

DELTA_UNIT_OF = {"x": "turns", "pct": "pp", "days": "days", "z": "z", "score": "points",
                 "grade": "notches"}

DISPLAY_DIGITS = dict(T.DISPLAY_DIGITS)

RANK_ORDER: Tuple[str, ...] = (
    "abs(rungs_crossed) desc",
    "distance_fraction desc nulls last",
    "materiality.share desc nulls last",
    "key asc",
)

BAND_OF_ZONE = {"safe": "healthy", "grey": "watch", "distress": "critical"}

_BS, _PL = "balance_sheet", "income_statement"

#: key -> (statement the numerator belongs to, base the share divides by).
#: Keys absent here carry no materiality (no single money denominator).
MATERIALITY_BASES: Dict[str, Dict[str, str]] = {
    k: {"numerator_statement": st, "base": "total_assets" if st == _BS else "revenue"}
    for k, st in (
        ("current_ratio", _BS), ("quick_ratio", _BS), ("cash_ratio", _BS),
        ("debt_to_ebitda", _BS), ("debt_to_equity", _BS), ("equity_ratio", _BS),
        ("debt_to_assets", _BS), ("net_debt_to_ebitda", _BS), ("lt_debt_to_equity", _BS),
        ("dso", _BS), ("dio", _BS), ("dpo", _BS),
        ("gross_margin", _PL), ("ebitda_margin", _PL), ("net_margin", _PL),
        ("operating_margin", _PL), ("core_ebitda_margin", _PL),
        ("roa", _PL), ("roe", _PL), ("roic", _PL),
        ("interest_coverage", _PL), ("ebitda_to_interest", _PL),
        ("dscr", _PL), ("dscr_with_lt_principal", _PL),
        ("asset_turnover", _PL), ("inventory_turnover", _PL),
    )
}

PiotroskiChecks = Callable[..., Dict[str, Any]]


# ── decimals ─────────────────────────────────────────────────────────────────


def _signed(d: Decimal) -> str:
    text = format(d, "f")
    if d > 0:
        return "+" + text
    if d == 0:
        return text.lstrip("-")
    return text


def _q(d: Decimal, places: int) -> Decimal:
    return d.quantize(Decimal(1).scaleb(-places), rounding=ROUND_HALF_UP)


def _dec(text: Optional[str]) -> Optional[Decimal]:
    return None if text is None else Decimal(text)


# ── sides ────────────────────────────────────────────────────────────────────


_SIDE_KEYS = ("value", "value_q", "band", "band_status", "ladder", "operands", "reason")


def _side(row: Mapping[str, Any]) -> Dict[str, Any]:
    return {k: copy.deepcopy(row.get(k)) for k in _SIDE_KEYS}


def _has_value(side: Mapping[str, Any]) -> bool:
    return side.get("value_q") is not None


# ── delta ────────────────────────────────────────────────────────────────────


def _delta(cur: Mapping[str, Any], pri: Mapping[str, Any], display_unit: str,
           higher_is_better: bool) -> Dict[str, Any]:
    unit = DELTA_UNIT_OF[display_unit]
    out: Dict[str, Any] = {"value": None, "unit": unit, "pct_change": None,
                           "favourable": None, "reason_code": None}
    if not _has_value(cur) or not _has_value(pri):
        out["reason_code"] = ("both_refused" if not _has_value(cur) and not _has_value(pri)
                              else "current_refused" if not _has_value(cur) else "prior_refused")
        return out
    if display_unit == "grade":
        ranks = _letter_ranks()
        steps = ranks[cur["value_q"]] - ranks[pri["value_q"]]
        d = Decimal(steps)
    else:
        d = Decimal(cur["value_q"]) - Decimal(pri["value_q"])
        d = _q(d, DISPLAY_DIGITS[display_unit])
        if unit == "turns":
            base = Decimal(pri["value_q"])
            if base != 0:
                out["pct_change"] = _signed(_q(d / abs(base) * 100, 1))
    out["value"] = _signed(d)
    if "withheld_sign" in (cur.get("band_status"), pri.get("band_status")):
        # The ladder's direction assumes a positive denominator; on a side
        # where it is negative, a higher value is not "better".
        out["reason_code"] = "direction_withheld"
        return out
    if d == 0:
        out["favourable"] = "none"
    else:
        out["favourable"] = "improved" if (d > 0) == higher_is_better else "deteriorated"
    return out


# ── rungs, bands, widths ─────────────────────────────────────────────────────


def _letter_ranks() -> Dict[str, int]:
    ladder = CM.CREDIT_LETTER_LADDER
    return {grade: len(ladder) - 1 - i for i, (_floor, grade) in enumerate(ladder)}


def _intervals(ladder: Mapping[str, str], floor: str) -> List[Tuple[str, Decimal, Optional[Decimal]]]:
    """(band, entry rung, the next better band's entry rung), best band
    first. The floor band has no entry rung (None) — a rung whose band IS
    the floor is absorbed (DPO's watch 30 does not bound its watch band).
    Direction never enters: the table already graded each side with
    `higher_is_better`, and a rung, a distance and a width are the same
    magnitudes read up or down the number line."""
    present = [n for n in ("strong", "healthy", "watch") if n in ladder and n != floor]
    out: List[Tuple[str, Decimal, Optional[Decimal]]] = []
    upper: Optional[Decimal] = None
    for name in present:
        rung = Decimal(ladder[name])
        out.append((name, rung, upper))
        upper = rung
    out.append((floor, None, upper))  # type: ignore[arg-type]
    return out


def _crossing(to_band: str, from_band: str, value: float, ladder: Mapping[str, str],
              floor: str, digits: int) -> Dict[str, Any]:
    bands = _intervals(ladder, floor)
    by_name = {b[0]: b for b in bands}
    names = [b[0] for b in bands]
    up = T.BAND_RANK[to_band] > T.BAND_RANK[from_band]
    if up:
        rung_band = to_band
    else:
        # the band just above `to` on the ladder that was passed through
        rung_band = names[names.index(to_band) - 1]
    rung = by_name[rung_band][1]
    out: Dict[str, Any] = {"rung_crossed": None, "distance_past_rung": None, "band_width": None,
                           "band_width_basis": None, "distance_fraction": None,
                           "_distance_exact": None}
    if rung is None:
        return out
    distance = abs(Decimal(value) - rung)
    out["rung_crossed"] = {"name": rung_band, "value": format(rung.normalize(), "f")}
    out["distance_past_rung"] = format(_q(distance, digits), "f")
    out["_distance_exact"] = distance

    def width_of(name: str) -> Optional[Decimal]:
        _n, lo, hi = by_name[name]
        return None if lo is None or hi is None else abs(hi - lo)

    width = width_of(to_band)
    basis = "closed"
    if width is None:
        basis = "adjacent"
        i = names.index(to_band)
        neighbours = [names[j] for j in (i - 1, i + 1) if 0 <= j < len(names)]
        width = next((w for w in (width_of(n) for n in neighbours) if w is not None), None)
    if width is None or width == 0:
        return out
    out["band_width"] = format(_q(width, digits), "f")
    out["band_width_basis"] = basis
    out["distance_fraction"] = format(_q(distance / width, 3), "f")
    return out


def _letter_crossing(to_letter: str, from_letter: str, composite: float) -> Dict[str, Any]:
    ladder = list(CM.CREDIT_LETTER_LADDER)  # highest floor first
    ranks = _letter_ranks()
    up = ranks[to_letter] > ranks[from_letter]
    index = {g: i for i, (_f, g) in enumerate(ladder)}
    i_to = index[to_letter]
    rung_i = i_to if up else i_to - 1
    floor_value, rung_grade = ladder[rung_i]
    distance = abs(Decimal(composite) - Decimal(floor_value))
    out: Dict[str, Any] = {
        "rung_crossed": {"name": rung_grade, "value": str(floor_value)},
        "distance_past_rung": format(_q(distance, 1), "f"),
        "band_width": None, "band_width_basis": None, "distance_fraction": None,
        "_distance_exact": distance,
    }

    def width_of(i: int) -> Optional[Decimal]:
        if i <= 0 or i >= len(ladder):
            return None  # AAA is open above; the last rung is the floor
        return Decimal(ladder[i - 1][0]) - Decimal(ladder[i][0])

    width, basis = width_of(i_to), "closed"
    if width is None:
        basis = "adjacent"
        width = width_of(i_to + 1) if i_to == 0 else width_of(i_to - 1)
    if width:
        out["band_width"] = format(_q(width, 1), "f")
        out["band_width_basis"] = basis
        out["distance_fraction"] = format(_q(distance / width, 3), "f")
    return out


# ── movement ─────────────────────────────────────────────────────────────────


def _not_comparable(code: str) -> Dict[str, Any]:
    return {"status": "not_comparable", "from": None, "to": None, "rungs_crossed": 0,
            "rung_crossed": None, "distance_past_rung": None, "band_width": None,
            "band_width_basis": None, "distance_fraction": None, "materiality": None,
            "reason_code": code}


def _ungraded_code(cur: Mapping[str, Any], pri: Mapping[str, Any]) -> Optional[str]:
    if not _has_value(cur) or not _has_value(pri):
        return ("both_refused" if not _has_value(cur) and not _has_value(pri)
                else "current_refused" if not _has_value(cur) else "prior_refused")
    for side in (cur, pri):
        if side.get("band_status") != "graded":
            return (side.get("reason") or {}).get("code") or "not_in_pack_bands"
    return None


def _materiality(key: str, distance: Optional[Decimal], display_unit: str,
                 denominators: Mapping[str, Mapping[str, Any]],
                 bases: Mapping[str, Any], period_days: float) -> Optional[Dict[str, Any]]:
    spec = MATERIALITY_BASES.get(key)
    den = (denominators.get(key) or {}).get("value")
    if spec is None or distance is None or den is None:
        return None
    base_value = bases.get(spec["base"])
    scale = {"x": Decimal(1), "pct": Decimal(100)}.get(display_unit)
    if display_unit == "days":
        scale = Decimal(repr(period_days))
    if scale is None:
        return None
    headroom = distance * abs(Decimal(den)) / scale
    share = None
    if base_value is not None and base_value > 0:
        share = format(_q(headroom / Decimal(base_value), 4), "f")
    return {
        "basis_key": spec["base"],
        "basis_value": None if base_value is None else format(_q(Decimal(base_value), 2), "f"),
        "headroom_money": format(_q(headroom, 2), "f"),
        "share": share,
    }


def _movement(key: str, cur: Mapping[str, Any], pri: Mapping[str, Any], display_unit: str,
              floor: str, denominators: Mapping[str, Any],
              bases: Mapping[str, Any], period_days: float) -> Dict[str, Any]:
    code = _ungraded_code(cur, pri)
    if code is not None:
        return _not_comparable(code)
    if cur.get("ladder") != pri.get("ladder"):
        return _not_comparable("ladder_differs")
    frm, to = pri["band"], cur["band"]
    rungs = T.BAND_RANK[to] - T.BAND_RANK[frm]
    out = _not_comparable("")
    out.update({"from": frm, "to": to, "rungs_crossed": rungs, "reason_code": None})
    if rungs == 0:
        out["status"] = "same_band"
        return out
    out["status"] = "crossed_up" if rungs > 0 else "crossed_down"
    cross = _crossing(to, frm, float(cur["value"]), cur["ladder"], floor,
                      DISPLAY_DIGITS[display_unit])
    distance = cross.pop("_distance_exact")
    out.update(cross)
    out["materiality"] = _materiality(key, distance, display_unit, denominators, bases, period_days)
    return out


# ── the composites ───────────────────────────────────────────────────────────


def _composite_rows(cur_credit: Mapping[str, Any], pri_credit: Mapping[str, Any]
                    ) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    def refused(credit: Mapping[str, Any]) -> Dict[str, Any]:
        reason = credit.get("reason") or {"code": CM.CREDIT_INPUTS_ABSENT, "inputs": []}
        return {"value": None, "value_q": None, "band": None, "band_status": "refused",
                "ladder": None, "operands": [], "reason": copy.deepcopy(reason)}

    def z_side(credit: Mapping[str, Any]) -> Dict[str, Any]:
        altman = credit.get("altman") or {}
        z = altman.get("z")
        if z is None:
            return refused(credit)
        th = altman.get("thresholds") or {}
        return {
            "value": z, "value_q": T.quantize_display(z, "z"),
            "band": BAND_OF_ZONE[altman["zone"]], "band_status": "graded",
            "ladder": {"healthy": format(Decimal(repr(th["safe_from"])), "f"),
                       "watch": format(Decimal(repr(th["grey_from"])), "f")},
            "operands": [{"name": x, "value": altman.get(x), "source": "credit_model.altman_%s" % x}
                         for x in ("x1", "x2", "x3", "x4")],
            "reason": None,
        }

    def score_side(credit: Mapping[str, Any], value: Optional[float], source: str) -> Dict[str, Any]:
        if value is None:
            return refused(credit)
        return {"value": value, "value_q": T.quantize_display(value, "score"), "band": None,
                "band_status": "not_banded", "ladder": None,
                "operands": [{"name": source, "value": value, "source": "credit_model." + source}],
                "reason": {"code": "graded_by_letter", "inputs": ["letter_grade"]}}

    def letter_side(credit: Mapping[str, Any]) -> Dict[str, Any]:
        letter = credit.get("letter")
        if letter is None:
            return refused(credit)
        return {"value": credit.get("composite"), "value_q": letter, "band": letter,
                "band_status": "graded", "ladder": CM.letter_grade_bands(),
                "operands": [{"name": "credit_composite", "value": credit.get("composite"),
                              "source": "credit_model.credit_composite"}],
                "reason": None}

    def row(key: str, unit: str, cur: Dict[str, Any], pri: Dict[str, Any]) -> Dict[str, Any]:
        return {"key": key, "group": "distress" if key == "altman_z" else "credit",
                "label_key": "ratioTable.%s.label" % key, "formula_key": "ratioTable.%s.formula" % key,
                "display_unit": unit, "higher_is_better": True, "current": cur, "prior": pri,
                "delta": _delta(cur, pri, unit, True), "movement": None, "finding_id": None}

    composites: List[Dict[str, Any]] = []
    z_row = row("altman_z", "z", z_side(cur_credit), z_side(pri_credit))
    code = _ungraded_code(z_row["current"], z_row["prior"])
    if code is not None:
        z_row["movement"] = _not_comparable(code)
    else:
        frm, to = z_row["prior"]["band"], z_row["current"]["band"]
        rungs = T.BAND_RANK[to] - T.BAND_RANK[frm]
        mv = _not_comparable("")
        mv.update({"from": frm, "to": to, "rungs_crossed": rungs, "reason_code": None,
                   "status": "same_band" if rungs == 0 else ("crossed_up" if rungs > 0 else "crossed_down")})
        if rungs:
            cross = _crossing(to, frm, float(z_row["current"]["value"]), z_row["current"]["ladder"],
                              "critical", DISPLAY_DIGITS["z"])
            cross.pop("_distance_exact")
            mv.update(cross)
        z_row["movement"] = mv
    composites.append(z_row)

    c_row = row("credit_composite", "score",
                score_side(cur_credit, cur_credit.get("composite"), "credit_composite"),
                score_side(pri_credit, pri_credit.get("composite"), "credit_composite"))
    c_row["movement"] = _not_comparable(_ungraded_code(c_row["current"], c_row["prior"])
                                        or "graded_by_letter")
    composites.append(c_row)

    l_row = row("letter_grade", "grade", letter_side(cur_credit), letter_side(pri_credit))
    code = _ungraded_code(l_row["current"], l_row["prior"])
    if code is not None:
        l_row["movement"] = _not_comparable(code)
    else:
        ranks = _letter_ranks()
        frm, to = l_row["prior"]["band"], l_row["current"]["band"]
        steps = ranks[to] - ranks[frm]
        mv = _not_comparable("")
        mv.update({"from": frm, "to": to, "rungs_crossed": steps, "reason_code": None,
                   "status": "same_band" if steps == 0 else ("crossed_up" if steps > 0 else "crossed_down")})
        if steps:
            cross = _letter_crossing(to, frm, float(cur_credit["composite"]))
            cross.pop("_distance_exact")
            mv.update(cross)
        l_row["movement"] = mv
    composites.append(l_row)

    subscores: List[Dict[str, Any]] = []
    for short, _metric in CM.CREDIT_SUBSCORE_METRICS:
        key = "credit_subscore_%s" % short
        cur_v = (cur_credit.get("subscores") or {}).get(short)
        pri_v = (pri_credit.get("subscores") or {}).get(short)
        cur_s = score_side(cur_credit, cur_v, key)
        pri_s = score_side(pri_credit, pri_v, key)
        for s_ in (cur_s, pri_s):
            if s_["band_status"] == "not_banded":
                s_["reason"] = {"code": "not_in_pack_bands", "inputs": [key]}
        r = row(key, "score", cur_s, pri_s)
        r["group"] = "credit"
        r["movement"] = _not_comparable(_ungraded_code(cur_s, pri_s) or "not_in_pack_bands")
        subscores.append(r)
    return composites, subscores


# ── Piotroski ────────────────────────────────────────────────────────────────


def _piotroski_views(statements: Mapping[str, Any]) -> Dict[str, Optional[float]]:
    pl = statements.get("assembled_pl") if isinstance(statements.get("assembled_pl"), dict) else {}
    bs = statements.get("assembled_bs") if isinstance(statements.get("assembled_bs"), dict) else {}
    cf = statements.get("assembled_cf") if isinstance(statements.get("assembled_cf"), dict) else {}

    def n(bag: Mapping[str, Any], key: str) -> Optional[float]:
        v = bag.get(key)
        return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else None

    return {
        "net_income_statutory": n(pl, "net_income_statutory"),
        "total_assets": n(bs, "total_assets"),
        "cash_from_operating": n(cf, "cash_from_operating"),
        "revenue": n(pl, "revenue"),
        "long_term_debt": n(bs, "lt_debt"),
        "share_capital": n(bs, "share_capital"),
        "operating_ebit": n(pl, "operating_ebit"),
    }


def _piotroski_block(cur_st: Mapping[str, Any], pri_st: Mapping[str, Any],
                     checks: Optional[PiotroskiChecks]) -> Dict[str, Any]:
    prior_served = pri_st.get("assembled_piotroski")
    block: Dict[str, Any] = {
        "current": None,
        "prior": copy.deepcopy(prior_served) if isinstance(prior_served, dict) else None,
        "prior_capped": True,
        "reason_code": "piotroski_prior_capped",
        "excluded_from_band_movements": True,
        "current_reason": None,
    }
    cur = _piotroski_views(cur_st)
    pri = _piotroski_views(pri_st)
    base = ("net_income_statutory", "total_assets", "cash_from_operating")
    if checks is None:
        block["current_reason"] = {"code": "operand_absent", "inputs": ["piotroski_checks"]}
        return block
    missing = [k for k in base if cur[k] is None]
    if missing:
        block["current_reason"] = {"code": "operand_absent", "inputs": ["assembled.%s" % k for k in missing]}
        return block
    currency = cur_st.get("currency") if isinstance(cur_st.get("currency"), str) else ""
    block["current"] = checks(
        net_income_statutory=cur["net_income_statutory"],
        total_assets=cur["total_assets"],
        cash_from_operating=cur["cash_from_operating"],
        prior={k: v for k, v in pri.items() if v is not None},
        currency=currency,
        current={k: cur[k] for k in ("revenue", "long_term_debt", "share_capital", "operating_ebit")
                 if cur[k] is not None},
    )
    return block


# ── the block ────────────────────────────────────────────────────────────────


def _blocking_signal(payload: Mapping[str, Any]) -> Optional[Dict[str, Any]]:
    for candidate in (payload.get("industry_signal"),
                      (payload.get("statements") or {}).get("industry_signal")):
        if isinstance(candidate, dict) and candidate.get("block_sector_content") is True \
                and isinstance(candidate.get("agreement"), str) and isinstance(candidate.get("verdict"), str):
            return candidate
    return None


def _period_days(statements: Mapping[str, Any]) -> float:
    sup = statements.get("supplementary") if isinstance(statements.get("supplementary"), dict) else {}
    v = sup.get("periodDays")
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0 else 365.0


def _bases(denominators: Mapping[str, Mapping[str, Any]]) -> Dict[str, Any]:
    """The two statement bases a share divides by, read off the table's own
    denominators: total assets is what roa divides, revenue what
    gross_margin divides — the same figures, from the same source."""
    ta = denominators.get("roa") or {}
    rev = denominators.get("gross_margin") or {}
    return {"total_assets": ta.get("value"), "revenue": rev.get("value"),
            "sources": {"total_assets": ta.get("source"), "revenue": rev.get("source")}}


def _stamp_differences(cur: Mapping[str, Any], pri: Mapping[str, Any]) -> List[str]:
    out = []
    for field in ("ratio_table_version", "credit_model_revision", "metrics_basis", "currency",
                  "pack_provenance", "methodology_version"):
        if cur.get(field) != pri.get(field):
            out.append(field)
    for field in ("source", "table_sha256"):
        if (cur.get("bands") or {}).get(field) != (pri.get("bands") or {}).get(field):
            out.append("bands." + field)
    return out


def _rank_key(row: Mapping[str, Any]) -> Tuple[Any, ...]:
    mv = row["movement"]
    frac = mv.get("distance_fraction")
    share = (mv.get("materiality") or {}).get("share")
    return (-abs(mv["rungs_crossed"]),
            0 if frac is not None else 1, -Decimal(frac) if frac is not None else 0,
            0 if share is not None else 1, -Decimal(share) if share is not None else 0,
            row["key"])


def compare_ratio_tables(
    current_payload: Mapping[str, Any],
    prior_payload: Mapping[str, Any],
    *,
    current_label: str,
    prior_label: str,
    piotroski_checks: Optional[PiotroskiChecks] = None,
) -> Dict[str, Any]:
    """The two-period ratio block for two served `get_period` payloads."""
    cur_payload = dict(current_payload)
    pri_payload = dict(prior_payload)
    blocking = _blocking_signal(cur_payload) or _blocking_signal(pri_payload)
    withheld_by = [side for side, p in (("current", cur_payload), ("prior", pri_payload))
                   if _blocking_signal(p) is not None]
    if blocking is not None:
        cur_payload["industry_signal"] = blocking
        pri_payload["industry_signal"] = blocking

    cur_t = T.build_ratio_table(cur_payload, serve_time_metrics=True)
    pri_t = T.build_ratio_table(pri_payload, serve_time_metrics=True)
    cur_st = cur_payload.get("statements") if isinstance(cur_payload.get("statements"), dict) else {}
    pri_st = pri_payload.get("statements") if isinstance(pri_payload.get("statements"), dict) else {}
    denominators = T.ratio_denominators(cur_payload, serve_time_metrics=True)
    bases = _bases(denominators)
    days = _period_days(cur_st)
    bands, _stamp = T._served_bands(cur_st)

    pri_rows = {r["key"]: r for r in pri_t["rows"]}
    rows: List[Dict[str, Any]] = []
    for cr in cur_t["rows"]:
        pr = pri_rows[cr["key"]]
        cur_s, pri_s = _side(cr), _side(pr)
        band_def = bands.get(T._SPEC_BY_KEY[cr["key"]].band_key or "")
        floor = T.ladder_floor(band_def, cr.get("ladder") or {}) if band_def is not None else "critical"
        rows.append({
            "key": cr["key"], "group": cr["group"], "label_key": cr["label_key"],
            "formula_key": cr["formula_key"], "display_unit": cr["display_unit"],
            "higher_is_better": cr["higher_is_better"],
            "current": cur_s, "prior": pri_s,
            "delta": _delta(cur_s, pri_s, cr["display_unit"], cr["higher_is_better"]),
            "movement": _movement(cr["key"], cur_s, pri_s, cr["display_unit"],
                                  floor, denominators, bases, days),
            "finding_id": None,
        })

    composites, subscores = _composite_rows(cur_t["credit"], pri_t["credit"])

    movable = rows + [r for r in composites if r["key"] != "credit_composite"]
    improved = sorted((r for r in movable if r["movement"]["status"] == "crossed_up"), key=_rank_key)
    deteriorated = sorted((r for r in movable if r["movement"]["status"] == "crossed_down"), key=_rank_key)
    unchanged = sorted(({"key": r["key"], "band": r["movement"]["to"]}
                        for r in movable if r["movement"]["status"] == "same_band"),
                       key=lambda x: x["key"])
    not_comparable = sorted(({"key": r["key"], "reason_code": r["movement"]["reason_code"]}
                             for r in rows + composites if r["movement"]["status"] == "not_comparable"),
                            key=lambda x: x["key"])

    comparable_model = (cur_t["stamps"]["credit_model_revision"] == pri_t["stamps"]["credit_model_revision"]
                        and cur_t["stamps"]["bands"]["table_sha256"] == pri_t["stamps"]["bands"]["table_sha256"])

    return {
        "table_version": COMPARE_TABLE_VERSION,
        "current_label": current_label,
        "prior_label": prior_label,
        "stamps": {
            "current": copy.deepcopy(cur_t["stamps"]),
            "prior": copy.deepcopy(pri_t["stamps"]),
            "comparable_model": comparable_model,
            "differences": _stamp_differences(cur_t["stamps"], pri_t["stamps"]),
            "effective_dating": {
                "basis": "restated_under_current_revision",
                "is_convention": True,
            },
            "sector_withheld_by": withheld_by,
        },
        "rows": rows,
        "composites": composites,
        "subscores": subscores,
        "piotroski": _piotroski_block(cur_st, pri_st, piotroski_checks),
        "credit": {"current": copy.deepcopy(cur_t["credit"]), "prior": copy.deepcopy(pri_t["credit"])},
        "band_movements": {
            "rank_basis": {
                "order": list(RANK_ORDER),
                "sentence_key": "statements.ratioCmp.rankBasis",
                "materiality_floor": None,
                "bases": copy.deepcopy(MATERIALITY_BASES),
            },
            "improved": [r["key"] for r in improved],
            "deteriorated": [r["key"] for r in deteriorated],
            "unchanged": unchanged,
            "not_comparable": not_comparable,
            "findings": [],
        },
        "coverage": {
            "census_count": len(T.CENSUS),
            "census": list(T.CENSUS),
            "both_sides": sum(1 for r in rows if _has_value(r["current"]) and _has_value(r["prior"])),
            "prior_refused": dict(pri_t["coverage"]["refused"]),
            "current_refused": dict(cur_t["coverage"]["refused"]),
        },
    }
