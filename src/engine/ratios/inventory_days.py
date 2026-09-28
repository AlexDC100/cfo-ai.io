"""INVENTORY DAYS — one served metric, split by stock type, on the average.

THE DEFECT THIS EXISTS FOR (owner spec 2026-09-26, P1)
======================================================
Scandia Food FY2025 printed three "inventory days" for one stock of
55,341,817.75: 48.8 on the Benchmark (÷ net turnover), 52.5 on the Ratios
card (÷ total operating expense) and 95.3 on the Forecast (÷ 601 + 602 +
607, materials and merchandise only). One name, three formulas, one day
(31 December).

THE ONE MEASURE (``packs/ratios/inventory_days.yaml``; design B1-B5)
====================================================================
Each kind of stock is divided by the flow that moves it:

  materials             301 302 303 308 (net of 391/392)  ÷ 601 + 602 + 603
  finished goods + WIP  331 341 345 348 (net of 393/394)  ÷ cost of production sold
  merchandise           371 378         (net of 397)      ÷ 607
  alte stocuri          every other class-3 account, listed, inside the total

  cost of production sold = total operating expense (cost of sales + opex
      + D&A, ``assembled_pl.total_operating_expense``) − 607 − net 711
      (the served "Variația stocurilor de produse"; a refused 711 refuses
      this leg and the total with its reason — never a fallback).
  total = Σ all stock ÷ (cost of production sold + 607) × period days —
      flow-weighted, one money denominator, no double count.

Σ groups + alte stocuri must equal the served ``inventory_net`` to the
cent, or the block refuses (``not_reconciled``).

AVERAGE, NOT SNAPSHOT (B2). The basis is, in order:
  ``average_monthly``        the 12 month-end balances of the fiscal year and
                             its opening exist for this company in the
                             workspace (the caller hands them over);
  ``average_two_year_ends``  (opening ``si`` + closing) ÷ 2, when the stored
                             evidence (``inventory_stock/1``) says the ``si``
                             column is the fiscal-year opening;
  ``year_end_snapshot``      otherwise — labelled "stoc la 31 decembrie — o
                             singură zi".
The food / FMCG seasonality flag stays ON on the snapshot AND on the
two-year-end average (both points are year-ends). The closing-basis split
is served beside the average under ``*_closing`` names: the forecast
projects year-end balances and takes it (an exact year-0 round trip), and
the cash-conversion cycle adds it to the year-end DSO and DPO, so its three
terms sit on one basis.

CLAIM POLICY (B5). ``claim_policy.may_call_slow`` is true only when the split
is served on an average basis; a finding, an insight, the narrator, the chat
or the command bar that calls stock "slow" / "high" must cite the split and
the average. On the snapshot alone the claim is refused.

Pure: no I/O beyond the one pack read, no clock. Python 3.9 — no ``match``,
no ``X | Y``.
"""

from __future__ import annotations

import datetime as _dt
import functools
import os
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

import yaml

__all__ = [
    "SCHEMA",
    "PACK_FILE",
    "BASIS_MONTHLY",
    "BASIS_TWO_YEAR_ENDS",
    "BASIS_SNAPSHOT",
    "AVERAGE_BASES",
    "InventoryDaysPackError",
    "load_pack",
    "group_of",
    "flows_from_line_items",
    "build",
    "build_for_statements",
    "served_block",
    "total_days",
    "closing_total_days",
    "refusal_reason",
    "pack_refusal",
    "monthly_points_from_periods",
]

SCHEMA = "inventory_days/1"

DEFAULT_PACKS_DIR = Path(__file__).resolve().parents[3] / "packs" / "ratios"
PACK_NAME = "inventory_days.yaml"
PACK_FILE = "packs/ratios/%s" % PACK_NAME

BASIS_MONTHLY = "average_monthly"
BASIS_TWO_YEAR_ENDS = "average_two_year_ends"
BASIS_SNAPSHOT = "year_end_snapshot"
AVERAGE_BASES = (BASIS_MONTHLY, BASIS_TWO_YEAR_ENDS)

#: The stored-evidence schema (country_packs/ro_romania/inventory_stock.py).
EVIDENCE_SCHEMA = "inventory_stock/1"
REASON_PREDATES = "period_predates_inventory_measurement"

#: Cent slack for the reconciliation (float representation only).
_CENT = 0.005

_RO_MONTHS = ("ianuarie", "februarie", "martie", "aprilie", "mai", "iunie", "iulie",
              "august", "septembrie", "octombrie", "noiembrie", "decembrie")
_EN_MONTHS = ("January", "February", "March", "April", "May", "June", "July",
              "August", "September", "October", "November", "December")


class InventoryDaysPackError(RuntimeError):
    """packs/ratios/inventory_days.yaml is unusable. Raised, never defaulted."""


def _pack_path() -> Path:
    override = os.environ.get("INVENTORY_DAYS_PACKS_DIR")
    return (Path(override) if override else DEFAULT_PACKS_DIR) / PACK_NAME


def _text(raw: Any, where: str) -> Dict[str, str]:
    if not isinstance(raw, Mapping) or not isinstance(raw.get("ro"), str) \
            or not isinstance(raw.get("en"), str) or not raw["ro"] or not raw["en"]:
        raise InventoryDaysPackError("%s#%s: a ro and an en string are required" % (PACK_FILE, where))
    return {"ro": raw["ro"], "en": raw["en"]}


def _codes(raw: Any, where: str) -> Tuple[str, ...]:
    if not isinstance(raw, list) or not all(isinstance(c, str) and c.isdigit() for c in raw):
        raise InventoryDaysPackError("%s#%s: a list of account-code strings is required"
                                     % (PACK_FILE, where))
    return tuple(raw)


@functools.lru_cache(maxsize=4)
def _load(path: str) -> Dict[str, Any]:
    try:
        raw = yaml.safe_load(Path(path).read_text(encoding="utf-8"))
    except OSError as exc:
        raise InventoryDaysPackError("%s: cannot be read (%s)" % (PACK_FILE, exc))
    if not isinstance(raw, Mapping) or raw.get("schema_version") != 1:
        raise InventoryDaysPackError("%s: schema_version 1 is required" % PACK_FILE)
    groups = []
    seen = set()
    for i, g in enumerate(raw.get("groups") or []):
        where = "groups[%d]" % i
        if not isinstance(g, Mapping) or not isinstance(g.get("key"), str):
            raise InventoryDaysPackError("%s#%s: a keyed mapping is required" % (PACK_FILE, where))
        flow = g.get("flow") if isinstance(g.get("flow"), Mapping) else None
        if flow is None or not isinstance(flow.get("key"), str):
            raise InventoryDaysPackError("%s#%s.flow: a keyed mapping is required" % (PACK_FILE, where))
        stock = _codes(g.get("stock_accounts"), where + ".stock_accounts")
        prov = _codes(g.get("provision_accounts"), where + ".provision_accounts")
        for c in stock + prov:
            if any(c.startswith(o) or o.startswith(c) for o in seen):
                raise InventoryDaysPackError("%s#%s: account %s overlaps another group"
                                             % (PACK_FILE, where, c))
        seen.update(stock + prov)
        groups.append({
            "key": g["key"], "label": _text(g.get("label"), where + ".label"),
            "stock_accounts": stock, "provision_accounts": prov,
            "flow": {"key": flow["key"], "accounts": _codes(flow.get("accounts"), where + ".flow.accounts"),
                     "label": _text(flow.get("label"), where + ".flow.label")},
        })
    if [g["key"] for g in groups] != ["materials", "finished_goods_wip", "merchandise"]:
        raise InventoryDaysPackError("%s#groups: materials, finished_goods_wip, merchandise in order"
                                     % PACK_FILE)
    other = raw.get("other") or {}
    bases = raw.get("bases") or {}
    season = raw.get("seasonality") or {}
    refusals = raw.get("refusals") or {}
    opening_reasons = raw.get("opening_reasons") or {}
    policy = ((raw.get("claim_policy") or {}).get("reasons")) or {}
    return {
        "groups": groups,
        "other": {"key": str(other.get("key") or ""), "label": _text(other.get("label"), "other.label")},
        "own_product_turnover_accounts": _codes(raw.get("own_product_turnover_accounts"),
                                                "own_product_turnover_accounts"),
        "cps_label": _text((raw.get("cost_of_production_sold") or {}).get("label"),
                           "cost_of_production_sold.label"),
        "total_label": _text((raw.get("total") or {}).get("label"), "total.label"),
        "total_flow_label": _text((raw.get("total") or {}).get("flow_label"), "total.flow_label"),
        "bases": dict((k, _text((bases.get(k) or {}).get("label"), "bases.%s.label" % k))
                      for k in (BASIS_MONTHLY, BASIS_TWO_YEAR_ENDS, BASIS_SNAPSHOT)),
        "seasonality": {
            "caen_prefixes": _codes(season.get("caen_prefixes"), "seasonality.caen_prefixes"),
            "industry_keys": tuple(str(k) for k in (season.get("industry_keys") or [])),
            "note": _text(season.get("note"), "seasonality.note"),
        },
        "filed_basis": {
            "sector_row_key": str((raw.get("filed_basis") or {}).get("sector_row_key") or ""),
            "label": _text((raw.get("filed_basis") or {}).get("label"), "filed_basis.label"),
        },
        "refusals": dict((k, _text(v, "refusals.%s" % k)) for k, v in refusals.items()),
        "opening_reasons": dict((k, _text(v, "opening_reasons.%s" % k))
                                for k, v in opening_reasons.items()),
        "policy_reasons": dict((k, _text(v, "claim_policy.reasons.%s" % k)) for k, v in policy.items()),
    }


def load_pack() -> Dict[str, Any]:
    return _load(str(_pack_path()))


# ── small helpers ───────────────────────────────────────────────────────────


def _num(x: Any) -> Optional[float]:
    if isinstance(x, bool) or not isinstance(x, (int, float)):
        return None
    return float(x)


def _nonzero(x: Optional[float]) -> bool:
    """True for a present, non-zero amount. An absent opening (None — the
    file carries no fiscal-year opening) is NOT a zero stock: it simply
    contributes no stock at that date, which is what this asks."""
    return x is not None and x != 0.0


def _r2(x: Optional[float]) -> Optional[float]:
    return None if x is None else round(float(x), 2) + 0.0


def _digits(code: Any) -> str:
    return "".join(ch for ch in str(code or "") if ch.isdigit())


def _q_days(value: Optional[float]) -> Optional[str]:
    """Days at the ratio table's precision for the ``days`` unit —
    ``engine.ratios.table.quantize_display(value, "days")``, the rule the
    Ratios tile prints its headline with. ONE quantization for the metric:
    this block printed one decimal ("30.2") under a tile headline of "30",
    so the tile, the split beneath it, the report, the bank export and the
    command bar carried two strings for one figure."""
    from engine.ratios.table import quantize_display

    return quantize_display(value, "days")


def _reason(pack: Mapping[str, Any], code: str, **extra: Any) -> Dict[str, Any]:
    text = pack["refusals"].get(code)
    if text is None:
        raise InventoryDaysPackError("%s#refusals: no text for %r" % (PACK_FILE, code))
    out = {"code": code, "text_ro": text["ro"], "text_en": text["en"]}
    out.update(extra)
    return out


def group_of(code: Any, pack: Optional[Mapping[str, Any]] = None) -> Optional[Tuple[str, str]]:
    """``(group_key, "stock" | "provision")`` for a class-3 account code;
    ``("other_stock", ...)`` for a class-3 account outside the three groups;
    None outside class 3."""
    pack = pack or load_pack()
    d = _digits(code)
    if not d.startswith("3"):
        return None
    for g in pack["groups"]:
        if d.startswith(g["stock_accounts"]):
            return g["key"], "stock"
        if d.startswith(g["provision_accounts"]):
            return g["key"], "provision"
    return pack["other"]["key"], "provision" if d.startswith("39") else "stock"


def flows_from_line_items(line_items: Iterable[Mapping[str, Any]],
                          pack: Optional[Mapping[str, Any]] = None) -> Dict[str, float]:
    """The flows the split reads, summed from the SERVED P&L line items (the
    engine's own reading of each account — what the P&L tab prints): every
    group flow account (601 / 602 / 603 read separately — 603 is merged with
    604 in the canonical leaf, never here) and the own-product turnover."""
    pack = pack or load_pack()
    wanted = set()
    for g in pack["groups"]:
        wanted.update(g["flow"]["accounts"])
    wanted.update(pack["own_product_turnover_accounts"])
    out = dict((c, 0.0) for c in sorted(wanted))
    for li in line_items or []:
        if not isinstance(li, Mapping):
            continue
        if str(li.get("statement") or "PL").upper() == "BS":
            continue
        d = _digits(li.get("ro_account_code") or li.get("code"))
        amount = _num(li.get("amount"))
        if not d or amount is None:
            continue
        for c in wanted:
            if d.startswith(c):
                out[c] += amount
                break
    return dict((k, round(v, 2) + 0.0) for k, v in out.items())


def _date_words(period_end: Any) -> Tuple[Optional[Dict[str, str]], Optional[Dict[str, str]]]:
    """(start, end) as words — "1 ianuarie" / "31 decembrie" — or (None, None)."""
    try:
        end = _dt.date.fromisoformat(str(period_end)[:10])
    except (TypeError, ValueError):
        return None, None
    start = {"ro": "1 ianuarie", "en": "1 January"}
    endw = {"ro": "%d %s" % (end.day, _RO_MONTHS[end.month - 1]),
            "en": "%d %s" % (end.day, _EN_MONTHS[end.month - 1])}
    return start, endw


def _basis_label(pack: Mapping[str, Any], basis: str, period_end: Any) -> Dict[str, str]:
    start, end = _date_words(period_end)
    start = start or {"ro": "începutul anului", "en": "the start of the year"}
    end = end or {"ro": "sfârșitul perioadei", "en": "the period end"}
    tpl = pack["bases"][basis]
    return {lang: tpl[lang].format(start=start[lang], end=end[lang]) for lang in ("ro", "en")}


def _seasonal(pack: Mapping[str, Any], industry_key: Any, caen: Any) -> bool:
    s = pack["seasonality"]
    if isinstance(industry_key, str) and industry_key in s["industry_keys"]:
        return True
    d = _digits(caen)
    return bool(d) and d.startswith(s["caen_prefixes"])


def _days(stock: Optional[float], flow: Optional[float], period_days: float) -> Optional[float]:
    if stock is None or flow is None or flow <= 0:
        return None
    return round(stock / flow * period_days, 4) + 0.0


# ── the served inventory_net ────────────────────────────────────────────────


def served_inventory_net(statements: Mapping[str, Any]) -> Optional[float]:
    """The stock the balance sheet serves: Σ ``canonical_bs`` inventory rows
    (the forecast's ``inventory_net``) when the served block carries them,
    else ``balanceSheet.inventory`` (the Ratios card's operand). The two are
    equal to the cent on every corpus book."""
    cbs = statements.get("canonical_bs") if isinstance(statements, Mapping) else None
    if not isinstance(cbs, Mapping):
        cv1 = statements.get("assembled_canonical_v1") if isinstance(statements, Mapping) else None
        cbs = cv1.get("canonical_bs") if isinstance(cv1, Mapping) else None
    if isinstance(cbs, Mapping) and isinstance(cbs.get("rows"), list):
        rows = [r for r in cbs["rows"] if isinstance(r, Mapping)
                and str(r.get("id") or "").startswith("inventory_") and _num(r.get("amount")) is not None]
        if rows:
            return round(sum(float(r["amount"]) for r in rows), 2) + 0.0
    bs = statements.get("balanceSheet") if isinstance(statements, Mapping) else None
    return _r2(_num((bs or {}).get("inventory"))) if isinstance(bs, Mapping) else None


# ── the builder ─────────────────────────────────────────────────────────────


def _stock_points(evidence: Optional[Mapping[str, Any]],
                  line_items: Sequence[Mapping[str, Any]],
                  pack: Mapping[str, Any]) -> Tuple[Dict[str, Dict[str, Any]], bool, Dict[str, Any]]:
    """Per group key: {"opening", "closing", "accounts": [...], "provision_accounts": [...]}.

    Closing from the stored evidence when it is measured (the same rows the
    parser read), else from the class-3 line items; opening from the
    evidence only, and only when it is the fiscal-year opening. Returns
    (points, opening_available, opening_state)."""
    keys = [g["key"] for g in pack["groups"]] + [pack["other"]["key"]]
    points = dict((k, {"opening": 0.0, "closing": 0.0, "accounts": [], "provision_accounts": []})
                  for k in keys)
    measured = (isinstance(evidence, Mapping) and evidence.get("schema") == EVIDENCE_SCHEMA
                and evidence.get("measured") is True)
    opening_state: Dict[str, Any]
    if measured:
        op = evidence.get("opening") if isinstance(evidence.get("opening"), Mapping) else {}
        available = op.get("status") == "available"
        opening_state = {"status": "available" if available else "absent",
                         "reason": None if available else op.get("reason"),
                         "convention": op.get("convention"), "source": "tb_si_column"}
        rows = [(a.get("code"), _num(a.get("opening")), _num(a.get("closing")))
                for a in evidence.get("accounts") or [] if isinstance(a, Mapping)]
    else:
        available = False
        reason = None
        if isinstance(evidence, Mapping) and isinstance(evidence.get("opening"), Mapping):
            reason = evidence["opening"].get("reason")
        opening_state = {"status": "absent", "reason": reason or REASON_PREDATES,
                         "convention": None, "source": None}
        rows = []
        for li in line_items or []:
            if not isinstance(li, Mapping):
                continue
            code = li.get("ro_account_code") or li.get("code")
            if not _digits(code).startswith("3") or str(li.get("statement") or "BS").upper() != "BS":
                continue
            rows.append((code, None, _num(li.get("amount"))))
    for code, opening, closing in rows:
        found = group_of(code, pack)
        if found is None:
            continue
        key, kind = found
        p = points[key]
        if closing is not None:
            p["closing"] += closing
        if opening is not None:
            p["opening"] += opening
        bucket = p["provision_accounts"] if kind == "provision" else p["accounts"]
        # A code the file prints on two rows (corpus dup_totals_row: 371
        # twice) is summed above and LISTED once — the printed split names
        # each account one time.
        if (_nonzero(opening) or _nonzero(closing)) and str(code) not in bucket:
            bucket.append(str(code))
    for p in points.values():
        p["opening"] = round(p["opening"], 2) + 0.0 if available else None
        p["closing"] = round(p["closing"], 2) + 0.0
    return points, available, opening_state


def _average(p: Mapping[str, Any], basis: str, monthly: Optional[Mapping[str, Sequence[float]]],
             key: str) -> Optional[float]:
    if basis == BASIS_MONTHLY and monthly is not None:
        pts = list(monthly.get(key) or [])
        return round(sum(pts) / len(pts), 2) + 0.0 if pts else None
    if basis == BASIS_TWO_YEAR_ENDS and p.get("opening") is not None:
        return round((p["opening"] + p["closing"]) / 2.0, 2) + 0.0
    return p["closing"]


def build(evidence: Optional[Mapping[str, Any]], *,
          line_items: Sequence[Mapping[str, Any]],
          assembled_pl: Mapping[str, Any],
          served_inventory_net_value: Optional[float],
          period_days: Optional[float],
          period_days_refusal: Optional[Mapping[str, Any]] = None,
          period_end: Any = None,
          industry_key: Any = None,
          caen: Any = None,
          monthly: Optional[Mapping[str, Sequence[float]]] = None) -> Dict[str, Any]:
    """The ``inventory_days/1`` block. PURE.

    ``monthly`` (optional): per group key (and ``other_stock``) the 13
    balances — the fiscal-year opening and the 12 month-ends — of this
    company's monthly periods (``monthly_points_from_periods``). When given
    the basis is ``average_monthly``."""
    pack = load_pack()
    points, opening_available, opening_state = _stock_points(evidence, line_items, pack)
    flows = flows_from_line_items(line_items, pack)

    if monthly is not None:
        basis = BASIS_MONTHLY
    elif opening_available:
        basis = BASIS_TWO_YEAR_ENDS
    else:
        basis = BASIS_SNAPSHOT
    basis_label = _basis_label(pack, basis, period_end)
    seasonal = _seasonal(pack, industry_key, caen)
    seasonality = {"flagged": bool(seasonal and basis != BASIS_MONTHLY),
                   "note_ro": pack["seasonality"]["note"]["ro"] if seasonal and basis != BASIS_MONTHLY else None,
                   "note_en": pack["seasonality"]["note"]["en"] if seasonal and basis != BASIS_MONTHLY else None}
    opening_reason = None
    if not opening_available:
        code = opening_state.get("reason") or REASON_PREDATES
        text = pack["opening_reasons"].get(code) or pack["opening_reasons"][REASON_PREDATES]
        opening_reason = {"code": code, "text_ro": text["ro"], "text_en": text["en"]}

    # ── cost of production sold ────────────────────────────────────────
    # Total operating expense = cost of sales + operating expenses + D&A,
    # the assembled P&L's own three lines (the same sum it serves as its
    # total; read as its parts so no served total is re-read off the raw
    # assembly — the import boundary's E-ASSEMBLED-TOTAL rule).
    _parts = [_num(assembled_pl.get(k)) for k in ("cogs", "opex_total", "depreciation")]
    toe = None if any(p is None for p in _parts) else round(sum(_parts), 2) + 0.0
    iv = assembled_pl.get("inventory_variation") if isinstance(assembled_pl.get("inventory_variation"), Mapping) else {}
    net_711 = _num(iv.get("value"))
    iv_refusal = iv.get("refusal") if isinstance(iv.get("refusal"), Mapping) else None
    c607 = flows["607"]
    cps_refusal = None
    cps_value = None
    if toe is None:
        cps_refusal = _reason(pack, "no_flow",
                              inputs=["assembled_pl.cogs", "assembled_pl.opex_total", "assembled_pl.depreciation"])
    elif net_711 is None:
        cps_refusal = _reason(pack, "stock_variation_refused",
                              cause=dict(iv_refusal) if iv_refusal else None,
                              inputs=["assembled_pl.inventory_variation"])
    else:
        cps_value = round(toe - c607 - net_711, 2) + 0.0
    # NO OWN PRODUCTION (a shop, a distributor): no finished-goods / WIP stock
    # at either date, no own-product turnover (701-703) and no stock
    # variation — its non-merchandise cost is selling and general cost, not
    # the cost of anything produced, so the cost of production sold is 0
    # (dio_measure.md section 4: the retail book's store cost would
    # otherwise pose as cost of sales and pull its total from 39.2 to 31.4).
    fg_points = points.get("finished_goods_wip") or {}
    own_turnover_probe = round(sum(flows[c] for c in pack["own_product_turnover_accounts"]), 2)
    cps_basis = "total_operating_expense_less_607_less_net_711"
    if (cps_value is not None and net_711 == 0.0 and own_turnover_probe == 0.0
            and not _nonzero(fg_points.get("closing")) and not _nonzero(fg_points.get("opening"))):
        cps_value = 0.0
        cps_basis = "no_own_production"
    cost_of_production_sold = {
        "value": cps_value,
        "basis": cps_basis,
        "label_ro": pack["cps_label"]["ro"], "label_en": pack["cps_label"]["en"],
        "operands": {"total_operating_expense": _r2(toe), "cost_of_goods_resold_607": _r2(c607),
                     "net_711": _r2(net_711), "net_711_provenance": iv.get("provenance")},
        "formula": "total_operating_expense - 607 - net_711",
        "refusal": cps_refusal,
    }

    # ── reconciliation ─────────────────────────────────────────────────
    sum_closing = round(sum(p["closing"] for p in points.values()), 2) + 0.0
    no_lines = not any(p["accounts"] or p["provision_accounts"] for p in points.values())
    served = _r2(served_inventory_net_value)
    reconciled = served is not None and abs(sum_closing - served) < _CENT
    reconciliation = {"served_inventory_net": served, "sum_of_groups_closing": sum_closing,
                      "difference": None if served is None else _r2(sum_closing - served),
                      "status": "reconciled" if reconciled else "not_reconciled"}

    block_refusal = None
    if period_days is None:
        block_refusal = _reason(pack, "period_days_unknown",
                                cause=dict(period_days_refusal) if isinstance(period_days_refusal, Mapping) else None,
                                inputs=["supplementary.periodDays"])
    elif no_lines and not _nonzero(served):
        block_refusal = _reason(pack, "no_stock_lines", inputs=["statement_line_items.class_3"])
    elif not reconciled:
        block_refusal = _reason(pack, "not_reconciled",
                                inputs=["canonical_bs.inventory_net", "inventory_stock.accounts"])
    days_basis = float(period_days) if period_days is not None else None

    # ── groups ─────────────────────────────────────────────────────────
    own_turnover = round(sum(flows[c] for c in pack["own_product_turnover_accounts"]), 2) + 0.0
    groups_out: List[Dict[str, Any]] = []
    leg_refused_with_stock = False
    for g in pack["groups"]:
        p = points[g["key"]]
        avg = _average(p, basis, monthly, g["key"])
        if g["key"] == "finished_goods_wip":
            flow_value = cps_value
        else:
            flow_value = round(sum(flows[c] for c in g["flow"]["accounts"]), 2) + 0.0
        has_stock = _nonzero(p["closing"]) or _nonzero(p["opening"])
        refusal = block_refusal
        if refusal is None:
            if not has_stock:
                refusal = _reason(pack, "no_stock")
            elif g["key"] == "finished_goods_wip" and cps_refusal is not None:
                refusal = cps_refusal
            elif g["key"] == "finished_goods_wip" and own_turnover == 0.0:
                refusal = _reason(pack, "no_own_production_sold", inputs=["701", "702", "703"])
            elif g["key"] == "finished_goods_wip" and (flow_value is None or flow_value <= 0):
                refusal = _reason(pack, "cost_of_production_sold_not_positive",
                                  inputs=["cost_of_production_sold"])
            elif g["key"] == "merchandise" and not _nonzero(flow_value):
                refusal = _reason(pack, "no_goods_resold", inputs=["607"])
            elif flow_value is None or flow_value <= 0:
                refusal = _reason(pack, "no_flow", inputs=list(g["flow"]["accounts"]))
        if refusal is not None and has_stock and block_refusal is None:
            leg_refused_with_stock = True
        value = None if refusal is not None else _days(avg, flow_value, days_basis)
        closing_value = None if refusal is not None else _days(p["closing"], flow_value, days_basis)
        groups_out.append({
            "key": g["key"], "label_ro": g["label"]["ro"], "label_en": g["label"]["en"],
            "stock_accounts": list(g["stock_accounts"]),
            "provision_accounts": list(g["provision_accounts"]),
            "accounts": list(p["accounts"]), "provision_accounts_present": list(p["provision_accounts"]),
            "stock": {"opening": p["opening"], "closing": p["closing"], "average": avg},
            "flow": {"key": g["flow"]["key"], "accounts": list(g["flow"]["accounts"]),
                     "value": flow_value, "label_ro": g["flow"]["label"]["ro"],
                     "label_en": g["flow"]["label"]["en"]},
            "value": value, "value_q": _q_days(value),
            "closing_value": closing_value, "closing_value_q": _q_days(closing_value),
            "reason": refusal,
        })
    op = points[pack["other"]["key"]]
    other_out = {
        "key": pack["other"]["key"], "label_ro": pack["other"]["label"]["ro"],
        "label_en": pack["other"]["label"]["en"],
        "accounts": list(op["accounts"]), "provision_accounts_present": list(op["provision_accounts"]),
        "stock": {"opening": op["opening"], "closing": op["closing"],
                  "average": _average(op, basis, monthly, pack["other"]["key"])},
    }

    # ── total ──────────────────────────────────────────────────────────
    stock_close = sum_closing
    stock_avg_parts = [x["stock"]["average"] for x in groups_out] + [other_out["stock"]["average"]]
    stock_avg = (round(sum(v for v in stock_avg_parts if v is not None), 2) + 0.0
                 if all(v is not None for v in stock_avg_parts) else None)
    total_flow = None if cps_value is None else round(cps_value + c607, 2) + 0.0
    total_refusal = block_refusal
    if total_refusal is None:
        if cps_refusal is not None:
            total_refusal = cps_refusal
        elif leg_refused_with_stock:
            total_refusal = _reason(pack, "a_leg_refused",
                                    legs=[x["key"] for x in groups_out
                                          if x["reason"] is not None and x["reason"]["code"] != "no_stock"])
        elif total_flow is None or total_flow <= 0:
            total_refusal = _reason(pack, "cost_of_production_sold_not_positive",
                                    inputs=["cost_of_production_sold", "607"])
    total_value = None if total_refusal is not None else _days(stock_avg, total_flow, days_basis)
    total_closing = None if total_refusal is not None else _days(stock_close, total_flow, days_basis)
    total = {
        "value": total_value, "value_q": _q_days(total_value), "reason": total_refusal,
        "closing_value": total_closing, "closing_value_q": _q_days(total_closing),
        "label_ro": pack["total_label"]["ro"], "label_en": pack["total_label"]["en"],
        "weighting": "flow",
        "stock": {"closing": stock_close, "average": stock_avg,
                  "opening": (round(sum(x["stock"]["opening"] for x in groups_out)
                                    + other_out["stock"]["opening"], 2) + 0.0)
                  if opening_available else None},
        "flow": {"value": total_flow, "label_ro": pack["total_flow_label"]["ro"],
                 "label_en": pack["total_flow_label"]["en"],
                 "components": {"cost_of_production_sold": cps_value, "cost_of_goods_resold_607": _r2(c607)}},
    }

    split_served = total_refusal is None and all(
        x["reason"] is None or x["reason"]["code"] == "no_stock" for x in groups_out)
    if not split_served:
        policy_code = "split_refused"
    elif basis in AVERAGE_BASES:
        policy_code = "split_and_average"
    else:
        policy_code = "snapshot_only"
    ptext = pack["policy_reasons"][policy_code]
    claim_policy = {"may_call_slow": policy_code == "split_and_average",
                    "requires": ["split_by_stock_type", "average_balance"],
                    "reason": policy_code,
                    "reason_text": {"ro": ptext["ro"], "en": ptext["en"]}}

    inventory_turnover = None
    if total_value is not None and total_value > 0 and days_basis is not None:
        inventory_turnover = round(days_basis / total_value, 4) + 0.0
    return {
        "schema": SCHEMA,
        "status": "served" if total_refusal is None else "refused",
        "basis": basis,
        "basis_label": basis_label,
        "opening": dict(opening_state, reason=opening_reason),
        "seasonality": seasonality,
        "period_days": days_basis,
        "groups": groups_out,
        "other": other_out,
        "cost_of_production_sold": cost_of_production_sold,
        "total": total,
        "inventory_turnover": {"value": inventory_turnover,
                               "value_q": None if inventory_turnover is None else "%.2f" % inventory_turnover,
                               "formula": "period_days / total.value",
                               "reason": total_refusal},
        "ccc_dio_term": {"value": total_closing, "basis": BASIS_SNAPSHOT,
                         "basis_label": _basis_label(pack, BASIS_SNAPSHOT, period_end),
                         "reason": total_refusal},
        "reconciliation": reconciliation,
        "claim_policy": claim_policy,
        "filed_basis_pointer": {"sector_row_key": pack["filed_basis"]["sector_row_key"],
                                "label_ro": pack["filed_basis"]["label"]["ro"],
                                "label_en": pack["filed_basis"]["label"]["en"],
                                "never_compare": True},
        "provenance": {
            "stock": "inventory_stock/1 accounts (sf_d - sf_c; si_d - si_c at the fiscal-year opening)"
                     if opening_state.get("source") else "statement_line_items class 3 (closing)",
            "flows": "statement_line_items (601, 602, 603, 607, 701-703)",
            "total_operating_expense": "assembled_pl.cogs + opex_total + depreciation",
            "net_711": "assembled_pl.inventory_variation",
            "period_days": "supplementary.periodDays",
            "pack": PACK_FILE,
        },
    }


# ── readers ─────────────────────────────────────────────────────────────────


def served_block(statements: Any) -> Optional[Dict[str, Any]]:
    """THE block a served statements dict carries (``statements.
    inventory_days``), or None. Every consumer reads it through here."""
    if not isinstance(statements, Mapping):
        return None
    block = statements.get("inventory_days")
    if isinstance(block, Mapping) and block.get("schema") == SCHEMA:
        return block  # type: ignore[return-value]
    return None


def total_days(statements: Any) -> Optional[float]:
    b = served_block(statements)
    return None if b is None else _num((b.get("total") or {}).get("value"))


def closing_total_days(statements: Any) -> Optional[float]:
    b = served_block(statements)
    return None if b is None else _num((b.get("total") or {}).get("closing_value"))


def refusal_reason(statements: Any) -> Optional[Dict[str, Any]]:
    """The total's reason when it is refused; a synthetic reason when no
    block is served at all (never a fallback formula)."""
    b = served_block(statements)
    if b is None:
        return {"code": "inventory_days_absent", "inputs": ["statements.inventory_days"]}
    reason = (b.get("total") or {}).get("reason")
    return dict(reason) if isinstance(reason, Mapping) else None


def pack_refusal(code: str) -> Dict[str, Any]:
    """``{code, text_ro, text_en}`` for a refusal the pack words
    (``refusals.<code>``) — for a reader that cites a refusal it did not
    build (the forecast's DIO driver when no block is served). Raises
    InventoryDaysPackError on a code the pack does not word."""
    return _reason(load_pack(), code)


def monthly_points_from_periods(month_blocks: Sequence[Mapping[str, Any]]) -> Optional[Dict[str, List[float]]]:
    """Per group key, the 13 balances (opening + 12 month-ends) from the
    served blocks of the 12 monthly periods of one fiscal year, in month
    order. None unless all 12 are present with a measured opening on the
    first (the basis is then not monthly), and every month's split
    reconciles to its balance sheet — a month whose legs do not add up to
    its stock never enters the 13-point average (it served no split of its
    own, so its points are not the served stock)."""
    if len(month_blocks) != 12:
        return None
    for b in month_blocks:
        if not isinstance(b, Mapping) or (b.get("reconciliation") or {}).get("status") != "reconciled":
            return None
    first = month_blocks[0]
    if not isinstance(first, Mapping):
        return None
    keys = [g["key"] for g in first.get("groups") or []] + [((first.get("other") or {}).get("key"))]
    out: Dict[str, List[float]] = {}
    for k in keys:
        series: List[float] = []
        for i, b in enumerate(month_blocks):
            if not isinstance(b, Mapping):
                return None
            items = list(b.get("groups") or []) + [b.get("other") or {}]
            entry = next((x for x in items if isinstance(x, Mapping) and x.get("key") == k), None)
            if entry is None:
                return None
            stock = entry.get("stock") or {}
            if i == 0:
                if _num(stock.get("opening")) is None:
                    return None
                series.append(float(stock["opening"]))
            if _num(stock.get("closing")) is None:
                return None
            series.append(float(stock["closing"]))
        out[str(k)] = series
    return out


def build_for_statements(statements: Mapping[str, Any], *,
                         period_row: Optional[Mapping[str, Any]],
                         line_items: Sequence[Mapping[str, Any]],
                         org: Optional[Mapping[str, Any]] = None,
                         evidence: Optional[Mapping[str, Any]] = None,
                         monthly: Optional[Mapping[str, Sequence[float]]] = None) -> Dict[str, Any]:
    """The block for one served statements dict — the seam every serving
    path calls (``pipeline._attach_inventory_days_block``). ``evidence``
    defaults to the period row's stored ``assembled_canonical_v1.
    inventory_stock``."""
    row = period_row or {}
    if evidence is None:
        env = row.get("assembled_canonical_v1")
        evidence = env.get("inventory_stock") if isinstance(env, Mapping) else None
        if evidence is None and isinstance(env, Mapping):
            # A period written before the evidence existed "is recomputed
            # when reprocessed" — only when its source HOLDS rows. The
            # model's extraction and a statutory return never do: they say
            # the trial balance was not available.
            from engine.country_packs.ro_romania import inventory_stock as _inventory_stock

            cbs = env.get("canonical_bs")
            if _inventory_stock.holds_no_rows(cbs.get("extraction") if isinstance(cbs, Mapping) else None):
                evidence = _inventory_stock.absent_evidence(_inventory_stock.REASON_NO_ROWS)
    apl = statements.get("assembled_pl") if isinstance(statements.get("assembled_pl"), Mapping) else {}
    sup = statements.get("supplementary") if isinstance(statements.get("supplementary"), Mapping) else {}
    raw_days = sup.get("periodDays")
    return build(
        evidence,
        line_items=line_items,
        assembled_pl=apl,
        served_inventory_net_value=served_inventory_net(statements),
        period_days=float(raw_days) if _num(raw_days) is not None else None,
        period_days_refusal=sup.get("periodDaysRefusal") if isinstance(sup.get("periodDaysRefusal"), Mapping) else None,
        period_end=row.get("period_end") or statements.get("periodLabel"),
        industry_key=(org or {}).get("industry_key"),
        caen=(org or {}).get("caen_code"),
        monthly=monthly,
    )
