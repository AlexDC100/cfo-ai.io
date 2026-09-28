"""Company vs sector, on the FILED basis — the serving seam.

Pure: reads a served ``GET /api/period`` body and the committed dataset,
returns the ``sector_benchmark/1`` document. No I/O beyond the dataset
file, no clock, no model.

THE LAW, at this seam: a sector figure is served only with its source,
year and n; fewer than ``min_peers`` peers is ``insufficient_peers`` with
no median; an absent company operand refuses the row (never zero); a
ratio the filed summary does not publish is refused with that reason.

COMPANY SIDE. Where the ratio card's definition equals the filed one
(net margin, ROA, equity ratio, and ROE when its operands show year-end
equity) the company figure IS the served ratio-table row — the page and
the card cannot disagree. Every other row is restated on the filed basis
from the SERVED balance sheet, read through ``FactsGateway`` (section
subtotals and rows of ``canonical_bs``) with its operands printed:

  filed I7 datorii        = non_current_liabilities + current_liabilities
                            (provisions and deferred income are their own
                             sections in canonical_bs, as in the filing)
  filed I4 creante        = the ``ar_*`` rows of current_assets
  filed I3 stocuri        = the ``inventory_*`` rows of current_assets
  filed total assets      = I1 + I2 + I6 = canonical total assets

PERCENTILE. The dataset holds quartiles, not the distribution: a
percentile between them would be an interpolation, i.e. an estimate.
It is refused (``quartiles_only``); the quartile POSITION is served.
``PERCENTILE_MIN_N`` stays declared for the day the dataset carries the
distribution.

The general-SME verdict ladder is NOT touched here: ``ratio_cards`` says,
per census key, whether a sourced sector band exists beside the ladder
(``band_source: sector``) or why not (``band_source: general`` + reason).
"""
from __future__ import annotations

from typing import Any, Dict, List, Mapping, Optional, Tuple

from . import definitions as D
from .dataset import load_dataset, lookup

#: The ratio table's reason for a margin the one margin rule refused
#: (engine.ratios.margin_meaning.MARGIN_NOT_MEANINGFUL, spelled here so this
#: pure seam imports nothing from the ratio layer at module load).
MARGIN_NOT_MEANINGFUL = "margin_not_meaningful"

SCHEMA = "sector_benchmark/1"

#: The row reason for a company figure the engine REFUSED (a refused
#: operand, or a ratio card that refused the same figure). Carries the
#: engine's code as ``cause`` and its sentence (``text_en`` / ``text_ro``).
COMPANY_FIGURE_REFUSED = "company_figure_refused"

#: Ratio-card reasons that say the card LACKED an input, not that the
#: figure was refused: the filed basis may still carry it, so it is
#: restated there (with its operands printed). Every other card refusal is
#: carried onto the page.
CARD_ABSENCE_CODES = frozenset({"operand_absent", "engine_metric_absent"})

#: A percentile needs at least this many peers AND the distribution.
PERCENTILE_MIN_N = 20

#: How far a ratio-card figure may sit from the same ratio restated on the
#: filed basis and still be the SAME number for comparison purposes. The
#: card's table stores percents rounded to two decimals, so the printed
#: figure can sit up to half of the last digit (0.005 pct = 5e-5 as a
#: fraction) from the exact one. A card farther away than this is a
#: different number, not a rounding of the same one, and keeps the general
#: ladder. Served as ``card_agreement_tolerance`` so no surface types it.
CARD_AGREEMENT_TOLERANCE = 5e-5

#: Which way is better, per sourced ratio. ``None`` = no direction: the
#: position is stated, never graded, never in a movement list.
DIRECTION: Dict[str, Optional[str]] = {
    "net_margin": "higher",
    "roe": "higher",
    "roa": "higher",
    "equity_ratio": "higher",
    "liabilities_to_assets": "lower",
    "receivables_days": "lower",
    "inventory_days_on_turnover": "lower",
    "current_asset_share": None,
    "revenue_growth": "higher",
}

#: Sourced key -> the ratio-card (census) key with the SAME definition.
SAME_AS_CARD: Dict[str, str] = {
    "net_margin": "net_margin",
    "roa": "roa",
    "roe": "roe",
    "equity_ratio": "equity_ratio",
}

#: Census keys whose filed counterpart uses a different definition: the
#: card keeps the general ladder and points at the page row.
CARD_DEFINITION_DIFFERS: Dict[str, Tuple[str, str]] = {
    "dso": ("receivables_days",
            "the filing publishes ALL receivables (creante), the card "
            "divides trade receivables"),
    "dio": ("inventory_days_on_turnover",
            "the filing supports only year-end stock on net turnover (the filed "
            "basis); the analysis splits stock by type over the flow that moves "
            "each (engine.ratios.inventory_days) — never compared"),
    "debt_to_assets": ("liabilities_to_assets",
                       "the filing publishes TOTAL liabilities (datorii), "
                       "the card divides financial debt"),
}

#: Company days on NET TURNOVER that refuse where the ONE margin rule
#: refuses (turnover negligible against the company's operating activity).
TURNOVER_DAY_KEYS_REFUSED_WITH_MARGINS = ("inventory_days_on_turnover",)


def _margins_refused(payload: Mapping[str, Any]) -> bool:
    statements = payload.get("statements") if isinstance(payload, Mapping) else None
    verdict = (statements or {}).get("margin_meaning") if isinstance(statements, Mapping) else None
    return isinstance(verdict, Mapping) and verdict.get("status") == "not_meaningful"


_POSITIONS = ("below_p25", "p25_to_median", "median_to_p75", "above_p75")
_AR_PREFIX = "ar_"
_INVENTORY_PREFIX = "inventory_"


def _is_num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and v == v


def _op(name: str, value: Optional[float], source: str,
        refusal: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    op = {"name": name, "value": value, "source": source}
    if refusal is not None:
        # The engine REFUSED this operand (never absent, never zero): the
        # figure on it refuses with the engine's typed reason.
        op["value"] = None
        op["refusal"] = refusal
    return op


def _served_refusal(statements: Mapping[str, Any], block: str, key: str
                    ) -> Optional[Dict[str, Any]]:
    """The engine's typed refusal served at ``statements[block][key]``
    (``assembled_pl.net_income_refusal``, ``assembled_bs.
    total_equity_refusal``), or None. Read off the served body — this seam
    never re-decides a refusal."""
    b = statements.get(block)
    ref = b.get(key) if isinstance(b, Mapping) else None
    if not (isinstance(ref, Mapping) and ref.get("code")):
        return None
    return {"code": ref.get("code"), "text_en": ref.get("text_en"),
            "text_ro": ref.get("text_ro"), "source": "%s.%s" % (block, key)}


def _refused_reason(refusal: Mapping[str, Any], inputs: List[str]) -> Dict[str, Any]:
    """The row reason for a figure the engine refused: its code as the
    cause, its sentence in both languages (the page prints it)."""
    return {"code": COMPANY_FIGURE_REFUSED, "cause": refusal.get("code"),
            "inputs": list(inputs), "text": refusal.get("text_en"),
            "text_en": refusal.get("text_en"), "text_ro": refusal.get("text_ro")}


def _gateway(statements: Mapping[str, Any]):
    from engine.serving.facts import FactsGateway

    cbs = statements.get("canonical_bs")
    if not isinstance(cbs, dict):
        return None
    cur = statements.get("currency")
    gw = FactsGateway.from_envelope(
        {"canonical_bs": cbs},
        currency=cur if isinstance(cur, str) and cur else None)
    if gw is None or gw.tier != FactsGateway.TIER_CANONICAL:
        return None
    return gw


def _fact(gw: Any, method: str, *args: Any) -> Optional[float]:
    from engine.serving.facts import MissingFactError

    if gw is None:
        return None
    try:
        return getattr(gw, method)(*args).to_float()
    except MissingFactError:
        return None


def _row_sum(gw: Any, statements: Mapping[str, Any], prefix: str
             ) -> Tuple[Optional[float], List[str]]:
    """Sum of the served current-asset rows whose id starts with
    ``prefix``; ABSENT (None) when the statement has no such row."""
    cbs = statements.get("canonical_bs") if gw is not None else None
    ids = [str(r.get("id")) for r in (cbs or {}).get("rows") or []
           if isinstance(r, dict) and r.get("section") == "current_assets"
           and str(r.get("id") or "").startswith(prefix)]
    if not ids:
        return None, []
    total = 0.0
    for row_id in ids:
        v = _fact(gw, "statement_line", row_id)
        if v is None:
            return None, ids
        total += v
    return total, ids


def company_filed_basis(payload: Mapping[str, Any]) -> Dict[str, Dict[str, Any]]:
    """The filed-definition operands of one served period body. Each is
    ``{name, value|None, source}``; None is ABSENT, never zero."""
    statements = payload.get("statements")
    statements = statements if isinstance(statements, Mapping) else {}
    gw = _gateway(statements)
    apl = statements.get("assembled_pl")
    apl = apl if isinstance(apl, Mapping) else {}

    def pl(key: str) -> Optional[float]:
        v = apl.get(key)
        return float(v) if _is_num(v) else None

    # The NET RESULT refused (no account 121, net 711 refused) and TOTAL
    # EQUITY short by that refused result (the sheet does not balance
    # without it) are served as refusals beside their figures. Neither is
    # restated here: the build-up without 711 is not the net result, and
    # the equity rows' sum without the year's result is not book equity
    # (critic round 3, 2026-09-28 — this seam built its gateway from
    # `canonical_bs` alone, which cannot see the refusal, and graded an
    # equity ratio of 49.25 % against its sector on the real developer).
    ni_refusal = _served_refusal(statements, "assembled_pl", "net_income_refusal")
    eq_refusal = _served_refusal(statements, "assembled_bs", "total_equity_refusal")
    ncl = _fact(gw, "section_subtotal", "non_current_liabilities")
    cl = _fact(gw, "section_subtotal", "current_liabilities")
    liabilities = None if ncl is None or cl is None else ncl + cl
    receivables, ar_ids = _row_sum(gw, statements, _AR_PREFIX)
    inventory, inv_ids = _row_sum(gw, statements, _INVENTORY_PREFIX)
    return {
        "net_result": _op("net_result", pl("net_income_statutory"),
                          "assembled_pl.net_income_statutory", ni_refusal),
        "net_turnover": _op("net_turnover", pl("revenue"), "assembled_pl.revenue"),
        "equity": _op("equity", _fact(gw, "equity"), "canonical_bs.equity", eq_refusal),
        "total_assets": _op("total_assets", _fact(gw, "total_assets"),
                            "canonical_bs.total_assets"),
        "current_assets": _op("current_assets", _fact(gw, "current_assets"),
                              "canonical_bs.current_assets"),
        "liabilities_filed": _op(
            "liabilities_filed", liabilities,
            "canonical_bs.sections[non_current_liabilities + current_liabilities]"),
        "receivables_all": _op("receivables_all", receivables,
                               "canonical_bs.rows[%s]" % ", ".join(ar_ids)),
        "inventory": _op("inventory", inventory,
                         "canonical_bs.rows[%s]" % ", ".join(inv_ids)),
    }


def _table_row(payload: Mapping[str, Any], key: str) -> Optional[Mapping[str, Any]]:
    am = payload.get("assembled_metrics")
    table = am.get("ratio_table") if isinstance(am, Mapping) else None
    for row in (table.get("rows") if isinstance(table, Mapping) else None) or []:
        if isinstance(row, Mapping) and row.get("key") == key:
            return row
    return None


def _card_states_its_filed_basis(row: Mapping[str, Any]) -> bool:
    """A ratio-table row may stand in for the filed computation only when
    its PRINTED OPERANDS say what it divided. A row whose operands cite
    ``metrics.`` states no basis at all: it is a persisted number, and
    nothing guarantees it shares the account-121 anchor the dashboard
    prints — the defect family measured on production. Such a row is
    refused here and the figure is restated on the filed basis instead.

    This was applied to ROE alone; net_margin, ROA and equity_ratio took
    whatever the table held, and net_margin's table row is built by a
    helper that PREFERS the persisted metric."""
    ops = row.get("operands") or []
    return bool(ops) and not any(
        str(o.get("source") or "").startswith("metrics.") for o in ops
        if isinstance(o, Mapping))


def _div(num: Dict[str, Any], den: Dict[str, Any], scale: float = 1.0
         ) -> Tuple[Optional[float], Optional[Dict[str, Any]]]:
    refused = [o for o in (num, den) if o.get("refusal")]
    if refused:
        return None, _refused_reason(refused[0]["refusal"],
                                     [o["name"] for o in refused])
    if num["value"] is None or den["value"] is None:
        absent = [o["name"] for o in (num, den) if o["value"] is None]
        return None, {"code": "company_operand_absent", "inputs": absent}
    if den["value"] <= 0:
        return None, {"code": "company_nonpositive_denominator",
                      "inputs": [den["name"]]}
    return num["value"] / den["value"] * scale, None


def company_figures(payload: Mapping[str, Any],
                    prior_payload: Optional[Mapping[str, Any]] = None
                    ) -> Dict[str, Dict[str, Any]]:
    """One company figure per sourced ratio key, or a reason."""
    b = company_filed_basis(payload)
    out: Dict[str, Dict[str, Any]] = {}

    def put(key: str, value: Optional[float], reason: Optional[Dict[str, Any]],
            basis: str, operands: List[Dict[str, Any]]) -> None:
        out[key] = {"value": value, "reason": reason, "basis": basis,
                    "operands": operands}

    restated = {
        "net_margin": (b["net_result"], b["net_turnover"], 1.0),
        "roe": (b["net_result"], b["equity"], 1.0),
        "roa": (b["net_result"], b["total_assets"], 1.0),
        "equity_ratio": (b["equity"], b["total_assets"], 1.0),
        "liabilities_to_assets": (b["liabilities_filed"], b["total_assets"], 1.0),
        "receivables_days": (b["receivables_all"], b["net_turnover"], 365.0),
        "inventory_days_on_turnover": (b["inventory"], b["net_turnover"], 365.0),
        "current_asset_share": (b["current_assets"], b["total_assets"], 1.0),
    }
    for key, (num, den, scale) in restated.items():
        card_key = SAME_AS_CARD.get(key)
        row = _table_row(payload, card_key) if card_key else None
        refusal = (row.get("reason") or {}) if row is not None else {}
        if row is not None and row.get("value") is None and \
                refusal.get("code") == MARGIN_NOT_MEANINGFUL:
            # The ONE margin rule (engine.ratios.margin_meaning) refused the
            # card's margin: turnover is negligible against the company's
            # operating activity. The page refuses the same figure for the
            # same reason — never a percent restated from the filed basis
            # beside a card that declined to print one (the page and the
            # card cannot disagree).
            put(key, None, {"code": "company_margin_not_meaningful",
                            "inputs": list(refusal.get("inputs") or [])},
                "ratio_table.%s" % card_key, list(row.get("operands") or []))
            continue
        if row is not None and row.get("value") is None and refusal.get("code") \
                and refusal.get("code") not in CARD_ABSENCE_CODES:
            # The card REFUSED the figure (the engine said no — EBITDA or
            # the net result refused, total equity short by a refused
            # result, a non-positive denominator ...). The page refuses the
            # same figure with the card's reason: a figure restated from
            # the filed basis beside a card that declined it would be the
            # engine's refusal overruled by a second computation. Only a
            # card that merely LACKED an input (CARD_ABSENCE_CODES) is
            # restated from what the filed basis carries.
            put(key, None, {
                "code": COMPANY_FIGURE_REFUSED,
                "cause": refusal.get("cause") or refusal.get("code"),
                "inputs": list(refusal.get("inputs") or []),
                "text": refusal.get("text_en") or refusal.get("text"),
                "text_en": refusal.get("text_en") or refusal.get("text"),
                "text_ro": refusal.get("text_ro")},
                "ratio_table.%s" % card_key, list(row.get("operands") or []))
            continue
        if (row is not None and _is_num(row.get("value"))
                and _card_states_its_filed_basis(row)):
            # Table pct rows are 0-100; the dataset holds fractions.
            put(key, float(row["value"]) / 100.0, None,
                "ratio_table.%s" % card_key, list(row.get("operands") or []))
            continue
        if key in TURNOVER_DAY_KEYS_REFUSED_WITH_MARGINS and _margins_refused(payload):
            # Days ON TURNOVER on a book whose turnover the ONE margin rule
            # ruled negligible against its activity (the developer: 152,463
            # days) describe an incidental line, not the stock: refused with
            # the same verdict (owner spec 2026-09-26 P1, dio_measure §9).
            put(key, None, {"code": "company_turnover_negligible",
                            "inputs": ["statements.margin_meaning"]},
                "restated_on_filed_basis", [num, den])
            continue
        value, reason = _div(num, den, scale)
        put(key, value, reason, "restated_on_filed_basis", [num, den])
        # The card's own figure was not usable as the company side (it
        # states no basis, or there is none). The card may still carry the
        # sector band if what it PRINTS is the same number the filed basis
        # gives — proved here against the served figure, not trusted from a
        # provenance string.
        if row is not None and _is_num(row.get("value")) and value is not None:
            card_value = float(row["value"]) / 100.0
            out[key]["card_value"] = card_value
            out[key]["card_agrees"] = abs(card_value - value) <= CARD_AGREEMENT_TOLERANCE

    now = b["net_turnover"]
    if prior_payload is None:
        put("revenue_growth", None,
            {"code": "prior_period_absent", "inputs": ["prior period"]},
            "restated_on_filed_basis", [now])
    else:
        before = dict(company_filed_basis(prior_payload)["net_turnover"])
        before["name"] = "net_turnover_prior"
        value, reason = _div(now, before)
        put("revenue_growth", None if value is None else value - 1.0, reason,
            "restated_on_filed_basis", [now, before])
    return out


def position_of(value: float, fig: Mapping[str, Any]) -> str:
    if value < fig["p25"]:
        return _POSITIONS[0]
    if value < fig["median"]:
        return _POSITIONS[1]
    if value <= fig["p75"]:
        return _POSITIONS[2]
    return _POSITIONS[3]


def _vs_sector(position: str, direction: Optional[str]) -> Optional[str]:
    if position in _POSITIONS[1:3]:
        return "inside"
    if direction is None:
        return None
    good = _POSITIONS[3] if direction == "higher" else _POSITIONS[0]
    return "better" if position == good else "worse"


def _sector_figure(fig: Mapping[str, Any]) -> Dict[str, Any]:
    keep = ("median", "p25", "p75", "n", "year", "prior_year", "source",
            "filed_lines", "level", "sector_caen", "fallback_from", "dropped",
            "unit")
    return {k: fig[k] for k in keep if k in fig}


def _rows(found: Mapping[str, Any], company: Mapping[str, Dict[str, Any]]
          ) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    definitions = found["ratio_definitions"]
    # Served order = the declared order of DIRECTION (profitability,
    # structure, working capital, growth); an undeclared key follows.
    ordered = [k for k in DIRECTION if k in definitions] + \
              [k for k in definitions if k not in DIRECTION]
    for key in ordered:
        definition = definitions[key]
        fig = found["rows"].get(key)
        comp = company.get(key) or {"value": None, "basis": None, "operands": [],
                                    "reason": {"code": "company_operand_absent",
                                               "inputs": [key]}}
        card_key = SAME_AS_CARD.get(key)
        differs = next((ck for ck, (sk, _t) in CARD_DEFINITION_DIFFERS.items()
                        if sk == key), None)
        row: Dict[str, Any] = {
            "key": key,
            "unit": definition["unit"],
            "direction": DIRECTION.get(key),
            "definition": {
                "formula": definition.get("formula"),
                "company_basis": definition.get("company_basis"),
                "card_key": card_key or differs,
                "differs_from_card": differs is not None or (
                    card_key is not None and comp.get("basis") is not None
                    and not str(comp["basis"]).startswith("ratio_table.")
                    and comp.get("card_agrees") is not True),
            },
            "company": {"value": comp["value"], "basis": comp["basis"],
                        "operands": comp["operands"],
                        "card_value": comp.get("card_value"),
                        "card_agrees": comp.get("card_agrees")},
            "sector": None, "position": None, "vs_sector": None,
            "percentile": None,
            "percentile_reason": {"code": "quartiles_only",
                                  "inputs": ["dataset.quartiles"]},
            "reason": None,
        }
        if fig is None:
            row["status"] = "sector_absent"
            row["reason"] = {"code": "sector_figure_absent", "inputs": [key]}
        elif "median" not in fig:
            row["status"] = "insufficient_peers"
            row["sector"] = _sector_figure(fig)
            row["reason"] = {"code": "insufficient_peers",
                             "inputs": {"n": fig.get("n"),
                                        "min": found["min_peers"]}}
        elif comp["value"] is None:
            # A figure the engine REFUSED is not an absent one: its own
            # status, and the engine's reason beside it.
            refused = (comp.get("reason") or {}).get("code") == COMPANY_FIGURE_REFUSED
            row["status"] = "company_refused" if refused else "company_absent"
            row["sector"] = _sector_figure(fig)
            row["reason"] = comp["reason"]
        else:
            row["status"] = "sourced"
            row["sector"] = _sector_figure(fig)
            row["position"] = position_of(comp["value"], fig)
            row["vs_sector"] = _vs_sector(row["position"], DIRECTION.get(key))
        rows.append(row)
    return rows


def _movements(rows_now: List[Dict[str, Any]],
               rows_prior: Optional[List[Dict[str, Any]]],
               prior_reason: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    if rows_prior is None:
        return {"status": "refused", "reason": prior_reason,
                "improved": [], "deteriorated": [], "compared": 0,
                "of": len(rows_now)}
    before = {r["key"]: r for r in rows_prior}
    improved: List[Dict[str, Any]] = []
    deteriorated: List[Dict[str, Any]] = []
    compared = 0
    for now in rows_now:
        was = before.get(now["key"])
        direction = now["direction"]
        if (was is None or direction is None or now["status"] != "sourced"
                or was["status"] != "sourced"):
            continue
        compared += 1
        i_now = _POSITIONS.index(now["position"])
        i_was = _POSITIONS.index(was["position"])
        if i_now == i_was:
            continue
        better = (i_now > i_was) == (direction == "higher")
        item = {"key": now["key"], "unit": now["unit"],
                "from": was["position"], "to": now["position"],
                "company_prior": was["company"]["value"],
                "company_now": now["company"]["value"],
                "n": now["sector"]["n"], "year": now["sector"]["year"],
                "source": now["sector"]["source"]}
        (improved if better else deteriorated).append(item)
    return {"status": "ok", "reason": None, "improved": improved,
            "deteriorated": deteriorated, "compared": compared,
            "of": len(rows_now)}


def _ratio_cards(found: Optional[Mapping[str, Any]],
                 rows: List[Dict[str, Any]],
                 refusal: Optional[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    """Every census key: a sourced sector band, or the reason the card
    keeps the general ladder (TC-13: full coverage, no silent key)."""
    from engine.ratios.table import CENSUS

    by_key = {r["key"]: r for r in rows}
    refused = (found or {}).get("refused_ratios") or {}
    cards: Dict[str, Dict[str, Any]] = {}
    for key in CENSUS:
        if found is None:
            cards[key] = {"band_source": "general", "reason": refusal}
            continue
        sourced_key = next((sk for sk, ck in SAME_AS_CARD.items() if ck == key), None)
        row = by_key.get(sourced_key) if sourced_key else None
        if row is not None and row["status"] == "sourced" and (
                str(row["company"]["basis"]).startswith("ratio_table.")
                or row["company"].get("card_agrees") is True):
            s = row["sector"]
            cards[key] = {
                "band_source": "sector", "sector_key": sourced_key,
                "unit": row["unit"], "median": s["median"], "p25": s["p25"],
                "p75": s["p75"], "n": s["n"], "year": s["year"],
                "source": s["source"], "sector_caen": s["sector_caen"],
                "level": s["level"], "size_band": found["size_band"],
                "position": row["position"], "vs_sector": row["vs_sector"],
            }
        elif row is not None:
            cards[key] = {"band_source": "general",
                          "reason": row["reason"] or {
                              "code": "definition_differs",
                              "inputs": [sourced_key],
                              "text": "the card's figure is not the filed "
                                      "basis figure for this period"}}
        elif key in CARD_DEFINITION_DIFFERS:
            sk, text = CARD_DEFINITION_DIFFERS[key]
            cards[key] = {"band_source": "general",
                          "reason": {"code": "definition_differs",
                                     "inputs": [sk], "text": text}}
        elif key in refused:
            cards[key] = {"band_source": "general",
                          "reason": {"code": "not_in_filed_summary",
                                     "inputs": [key],
                                     "text": refused[key]["reason"]}}
        else:
            cards[key] = {"band_source": "general",
                          "reason": {"code": "no_filed_counterpart",
                                     "inputs": [key],
                                     "text": "the filed summary has no line "
                                             "for this ratio"}}
    return cards


def _period_block(payload: Mapping[str, Any]) -> Dict[str, Any]:
    period = payload.get("period")
    period = period if isinstance(period, Mapping) else {}
    return {"id": period.get("id"), "period_end": period.get("period_end"),
            "period_start": period.get("period_start")}


def build_sector_benchmark(payload: Mapping[str, Any], *, caen: Optional[str],
                           prior_payload: Optional[Mapping[str, Any]] = None,
                           prior_reason: Optional[Dict[str, Any]] = None,
                           dataset: Optional[Dict[str, Any]] = None
                           ) -> Dict[str, Any]:
    ds = dataset if dataset is not None else load_dataset()
    provenance = ds.get("provenance") or {}
    turnover = company_filed_basis(payload)["net_turnover"]["value"]
    found = lookup(caen, turnover, ds)
    signal = payload.get("industry_signal")
    doc: Dict[str, Any] = {
        "schema": SCHEMA,
        "period": _period_block(payload),
        "prior_period": _period_block(prior_payload) if prior_payload else None,
        "source": provenance.get("citation"),
        "year": ds["year"], "prior_year": ds.get("prior_year"),
        "min_peers": ds["min_peers"],
        "percentile_min_n": PERCENTILE_MIN_N,
        "card_agreement_tolerance": CARD_AGREEMENT_TOLERANCE,
        "size_bands": ds["size_bands"],
        "peer_set": (provenance.get("method") or {}).get("peer_set"),
        "sector_disputed": bool(isinstance(signal, Mapping)
                                and signal.get("block_sector_content")),
    }
    if found["status"] != "ok":
        refusal = {"code": found["reason"], "inputs": [],
                   "text": found.get("detail")}
        doc.update({"status": "refused", "reason": refusal, "caen": caen,
                    "rows": [], "refused": [],
                    "movements": _movements([], None, refusal),
                    "ratio_cards": _ratio_cards(None, [], refusal)})
        doc["coverage"] = _coverage(doc)
        return doc

    rows = _rows(found, company_figures(payload, prior_payload))
    rows_prior = None
    if prior_payload is not None:
        prior_turnover = company_filed_basis(prior_payload)["net_turnover"]["value"]
        found_prior = lookup(caen, prior_turnover, ds)
        if found_prior["status"] == "ok":
            rows_prior = _rows(found_prior, company_figures(prior_payload, None))
        else:
            prior_reason = {"code": found_prior["reason"], "inputs": ["prior period"],
                            "text": found_prior.get("detail")}
    elif prior_reason is None:
        prior_reason = {"code": "prior_period_absent", "inputs": ["prior period"]}
    sector_entry = (ds["sectors"].get(found["caen"])
                    or ds["sectors"].get(found["caen"][:2]) or {})
    doc.update({
        "status": "ok", "reason": None, "caen": found["caen"],
        "sector_label": sector_entry.get("label"),
        "size_band": found["size_band"],
        "company_turnover": turnover,
        "rows": rows,
        "refused": [{"key": k, "reason": {"code": "not_in_filed_summary",
                                          "inputs": [k], "text": v["reason"]}}
                    for k, v in sorted(found["refused_ratios"].items())],
        "movements": _movements(rows, rows_prior, prior_reason),
        "ratio_cards": _ratio_cards(found, rows, None),
    })
    doc["coverage"] = _coverage(doc)
    return doc


def _coverage(doc: Mapping[str, Any]) -> Dict[str, Any]:
    rows = doc.get("rows") or []
    cards = doc.get("ratio_cards") or {}
    return {
        "rows": len(rows),
        "rows_sourced": sum(1 for r in rows if r["status"] == "sourced"),
        "rows_refused": sum(1 for r in rows if r["status"] != "sourced"),
        "cards": len(cards),
        "cards_sector": sum(1 for c in cards.values()
                            if c["band_source"] == "sector"),
        "cards_general": sum(1 for c in cards.values()
                             if c["band_source"] == "general"),
    }


def check_document_law(doc: Mapping[str, Any]) -> List[str]:
    """Every violation in a served document. Empty = lawful. The route
    runs this before answering; a violation is a 500, never a render."""
    problems: List[str] = []
    min_peers = doc.get("min_peers") or D.MIN_PEERS

    def check(where: str, fig: Mapping[str, Any]) -> None:
        has_numbers = any(k in fig for k in ("median", "p25", "p75"))
        n = fig.get("n")
        if not isinstance(n, int) or isinstance(n, bool):
            problems.append("%s: no n" % where)
        if not isinstance(fig.get("year"), int):
            problems.append("%s: no year" % where)
        if not (isinstance(fig.get("source"), str) and fig["source"].strip()):
            problems.append("%s: no source" % where)
        if has_numbers and isinstance(n, int) and n < min_peers:
            problems.append("%s: median on n=%d (< %d)" % (where, n, min_peers))

    for row in doc.get("rows") or []:
        if row.get("sector") is not None:
            check("rows/%s" % row.get("key"), row["sector"])
        if row.get("status") == "sourced" and row.get("sector") is None:
            problems.append("rows/%s: sourced without a sector figure" % row.get("key"))
    for key, card in (doc.get("ratio_cards") or {}).items():
        if card.get("band_source") == "sector":
            check("ratio_cards/%s" % key, card)
        elif not (card.get("reason") or {}).get("code"):
            problems.append("ratio_cards/%s: general without a reason" % key)
    for item in ((doc.get("movements") or {}).get("improved") or []) + \
            ((doc.get("movements") or {}).get("deteriorated") or []):
        check("movements/%s" % item.get("key"), item)
    return problems
