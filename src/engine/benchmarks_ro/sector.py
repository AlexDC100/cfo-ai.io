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

SCHEMA = "sector_benchmark/1"

#: A percentile needs at least this many peers AND the distribution.
PERCENTILE_MIN_N = 20

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
            "the filing supports inventory days on net turnover, the card "
            "divides by operating cost"),
    "debt_to_assets": ("liabilities_to_assets",
                       "the filing publishes TOTAL liabilities (datorii), "
                       "the card divides financial debt"),
}

_POSITIONS = ("below_p25", "p25_to_median", "median_to_p75", "above_p75")
_AR_PREFIX = "ar_"
_INVENTORY_PREFIX = "inventory_"


def _is_num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and v == v


def _op(name: str, value: Optional[float], source: str) -> Dict[str, Any]:
    return {"name": name, "value": value, "source": source}


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

    ncl = _fact(gw, "section_subtotal", "non_current_liabilities")
    cl = _fact(gw, "section_subtotal", "current_liabilities")
    liabilities = None if ncl is None or cl is None else ncl + cl
    receivables, ar_ids = _row_sum(gw, statements, _AR_PREFIX)
    inventory, inv_ids = _row_sum(gw, statements, _INVENTORY_PREFIX)
    return {
        "net_result": _op("net_result", pl("net_income_statutory"),
                          "assembled_pl.net_income_statutory"),
        "net_turnover": _op("net_turnover", pl("revenue"), "assembled_pl.revenue"),
        "equity": _op("equity", _fact(gw, "equity"), "canonical_bs.equity"),
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


def _roe_is_year_end(row: Mapping[str, Any]) -> bool:
    """The card's ROE is like-with-like only when its printed operands
    show it divided the year-end equity total (not a persisted metric,
    whose basis the row does not state)."""
    ops = row.get("operands") or []
    return bool(ops) and not any(
        str(o.get("source") or "").startswith("metrics.") for o in ops
        if isinstance(o, Mapping))


def _div(num: Dict[str, Any], den: Dict[str, Any], scale: float = 1.0
         ) -> Tuple[Optional[float], Optional[Dict[str, Any]]]:
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
        if (row is not None and _is_num(row.get("value"))
                and (key != "roe" or _roe_is_year_end(row))):
            # Table pct rows are 0-100; the dataset holds fractions.
            put(key, float(row["value"]) / 100.0, None,
                "ratio_table.%s" % card_key, list(row.get("operands") or []))
            continue
        value, reason = _div(num, den, scale)
        put(key, value, reason, "restated_on_filed_basis", [num, den])

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
    for key, definition in found["ratio_definitions"].items():
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
                    and not str(comp["basis"]).startswith("ratio_table.")),
            },
            "company": {"value": comp["value"], "basis": comp["basis"],
                        "operands": comp["operands"]},
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
            row["status"] = "company_absent"
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
        if row is not None and row["status"] == "sourced" and \
                str(row["company"]["basis"]).startswith("ratio_table."):
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
                              "text": "the card's figure is not on the filed "
                                      "basis for this period"}}
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
