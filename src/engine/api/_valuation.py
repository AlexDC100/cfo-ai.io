"""EBITDA-multiple valuation engine.

This is the deterministic-math companion to stage_narrate. Opus 4.7 writes
rationale text but never the numbers (same architectural rule as Phase I:
ratios are math, narrative is LLM).

PRIMARY METHOD — EV/EBITDA:
    EV       = EBITDA × multiple
    Equity   = EV − total_debt + cash

We materialize three scenarios per industry: P25 / P50 / P75 of the peer
multiple distribution (Damodaran 2026, EU). P50 is the headline.

CROSS-CHECKS:
    EV/Revenue × revenue   → equity (for revenue-led businesses)
    DCF (FCF + WACC + Gordon terminal) → equity (intrinsic)

CONFIDENCE:
    low      — EBITDA ≤ 0, or ebitda_margin < 5%, or generic industry fallback
    medium   — EBITDA positive but margin 5–10%, OR using an aliased industry
               key (e.g. 'fmcg_distribution' falling back to 'fmcg')
    high     — EBITDA positive, margin ≥ 10%, exact industry_key match

The football_field block lists each method with its low/mid/high equity
value so the dashboard can render a horizontal-bar chart.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional, Tuple

from . import _supabase


logger = logging.getLogger(__name__)


# ─── Benchmark loader ───────────────────────────────────────────────────────


# Some industry keys are coarser than the benchmark seed; fall back through a
# short chain before landing on 'generic'. Keeps low-cardinality industry keys
# from accidentally hitting the wide 'generic' band.
_INDUSTRY_FALLBACK = {
    "real_estate_office": "real_estate_commercial",
    "real_estate_retail": "real_estate_commercial",
    "real_estate_industrial": "real_estate_commercial",
    "real_estate_logistics": "real_estate_commercial",
    "real_estate_mixed": "real_estate",
    "fmcg_food": "fmcg",
    "fmcg_beverage": "fmcg",
    "saas_b2b": "b2b_saas",
    "saas_b2c": "saas",
    "ecom": "e_commerce",
    "logistics_trucking": "transport_logistics",
    "construction_residential": "construction",
    "construction_commercial": "construction",
    "energy": "energy_utilities",
    "utilities": "energy_utilities",
}


def _candidate_keys(industry_key: Optional[str]) -> List[str]:
    """Resolution chain for one industry_key → list of keys to try in order."""
    key = (industry_key or "generic").lower().strip()
    chain: List[str] = [key]
    aliased = _INDUSTRY_FALLBACK.get(key)
    if aliased and aliased not in chain:
        chain.append(aliased)
    if "generic" not in chain:
        chain.append("generic")
    return chain


def load_valuation_benchmarks(industry_key: Optional[str]) -> Dict[str, Any]:
    """Return both EV/EBITDA and EV/Revenue benchmarks for the resolved
    industry, plus which key actually matched.

    Output shape:
      {
        "industry_key_used": "fmcg",
        "industry_key_requested": "fmcg_distribution",
        "ev_ebitda":  {"p25": 6.0, "p50": 8.5, "p75": 11.0, "source": "...", "as_of_date": "..."},
        "ev_revenue": {"p25": 0.3, "p50": 0.5, "p75": 0.8,  "source": "...", "as_of_date": "..."},
      }
    """
    requested = (industry_key or "generic").lower().strip()
    chain = _candidate_keys(industry_key)

    with _supabase.admin() as client:
        rows = client.select(
            "industry_benchmarks",
            filters={
                "metric_name": "in.(ev_ebitda_multiple,ev_revenue_multiple)",
                "industry_key": f"in.({','.join(chain)})",
            },
        )

    by_key: Dict[str, Dict[str, Dict[str, Any]]] = {}
    for r in rows:
        by_key.setdefault(r["industry_key"], {})[r["metric_name"]] = r

    industry_key_used: Optional[str] = None
    for candidate in chain:
        if candidate in by_key and "ev_ebitda_multiple" in by_key[candidate]:
            industry_key_used = candidate
            break
    if industry_key_used is None:
        # Defensive — schema seed guarantees 'generic' exists, but if a fresh
        # install ever drops it we return all-None and the caller emits a
        # low-confidence valuation.
        return {
            "industry_key_used": None,
            "industry_key_requested": requested,
            "ev_ebitda": None,
            "ev_revenue": None,
        }

    def pack(metric: Dict[str, Any] | None) -> Optional[Dict[str, Any]]:
        if metric is None:
            return None
        return {
            "p25": float(metric["p25"]) if metric.get("p25") is not None else None,
            "p50": float(metric["p50"]) if metric.get("p50") is not None else None,
            "p75": float(metric["p75"]) if metric.get("p75") is not None else None,
            "source": metric.get("source"),
            "as_of_date": str(metric.get("as_of_date")) if metric.get("as_of_date") else None,
        }

    return {
        "industry_key_used": industry_key_used,
        "industry_key_requested": requested,
        "ev_ebitda": pack(by_key[industry_key_used].get("ev_ebitda_multiple")),
        "ev_revenue": pack(by_key[industry_key_used].get("ev_revenue_multiple")),
    }


# ─── DCF cross-check ─────────────────────────────────────────────────────────


def _dcf_cross_check(
    *,
    ebitda: float,
    depreciation: float,
    net_income: float,
    total_debt: float,
    cash: float,
    revenue: float,
    interest_expense: float,
    tax_expense: float,
    pretax: float,
    total_equity: float = 0.0,
    real_capex: float = 0.0,
    net_wc_change: float = 0.0,
    use_stabilized_fcf: bool = False,
) -> Dict[str, Any]:
    """5-year FCF growth + Gordon terminal, ROMANIA-CORRECTED inputs.

    WACC inputs reflect Romanian risk environment (2025-26):
      • Rf  = 6.75% — Romanian 10Y sovereign in RON
      • ERP = 7.50% — Romania mature EM premium (Damodaran)
      • Beta = 1.00 — sector-typical for leveraged real estate
    These replace the Western European defaults (4.5% / 5.5%) that previously
    produced WACC ~6.26% and crushed the DCF for any RON-denominated entity.

    Growth assumptions also corrected for mature CRE rental businesses:
      • Forecast growth (years 1-5): 3.5% (CPI + small lease-up)
      • Terminal growth:             3.0% (mature CRE indexation)

    `total_equity` is now passed in from the canonical BS view — replaces
    the previous `revenue * 0.5` placeholder that systematically miscalibrated
    the D/V capital-structure weights.

    `use_stabilized_fcf=True` substitutes maintenance capex (≈ D&A) for the
    one-time CIP capex when valuing a development-phase business.

    Returns three scenarios (optimistic / central / conservative) plus the
    central WACC components for the FE to surface in the methodology table.
    """
    # ── Romania-corrected WACC inputs ────────────────────────────────────
    rf = 0.0675
    erp = 0.075
    beta = 1.0
    cost_of_equity = rf + beta * erp  # 14.25%

    implied_tax = (tax_expense / pretax) if pretax > 0 else 0.0
    tax_rate = max(0.0, min(0.25, implied_tax))

    implied_kd = (interest_expense / total_debt) if total_debt > 0 else 0.0
    # Pre-tax Kd floor at 5.0% — accounts for currency-risk premium when
    # the lender carries EUR debt against RON cash flow (the EEI pattern).
    kd_pre = max(0.050, implied_kd)
    kd_after = kd_pre * (1 - tax_rate)

    # Real total equity from canonical BS — no more `revenue * 0.5` proxy.
    debt = max(total_debt, 0.0)
    equity_book = max(total_equity, 1.0)
    wd = debt / (debt + equity_book) if (debt + equity_book) > 0 else 0.0
    we = 1.0 - wd
    wacc_central = we * cost_of_equity + wd * kd_after

    # ── Stabilized FCF for perpetuity ────────────────────────────────────
    cfo = net_income + depreciation + net_wc_change
    if use_stabilized_fcf or real_capex == 0.0:
        # Stabilized: maintenance capex ≈ D&A → FCF ≈ NI + ΔWC.
        base_fcf = max(net_income + net_wc_change, 0.0)
    else:
        base_fcf = max(cfo + real_capex, 0.0)

    horizon = 5
    g_forecast = 0.035          # 3.5% over years 1-5 (CPI + lease-up)
    g_terminal = 0.030          # 3.0% mature CRE indexation

    def _dcf_at(wacc: float) -> Dict[str, float]:
        """Run a single DCF at the given WACC; return EV and equity."""
        if wacc <= g_terminal:
            wacc = g_terminal + 0.005  # avoid blow-up
        total_pv = 0.0
        last = base_fcf
        for y in range(1, horizon + 1):
            fcf = base_fcf * ((1 + g_forecast) ** y)
            total_pv += fcf / ((1 + wacc) ** y)
            last = fcf
        # Gordon terminal: TV uses FCF_{N+1} = last × (1 + g_T)
        tv_undisc = (last * (1 + g_terminal)) / (wacc - g_terminal)
        tv_pv = tv_undisc / ((1 + wacc) ** horizon)
        ev = total_pv + tv_pv
        net_debt = total_debt - cash
        return {
            "wacc": wacc,
            "explicit_pv": total_pv,
            "terminal_pv": tv_pv,
            "enterprise_value": ev,
            "net_debt": net_debt,
            "equity_value": ev - net_debt,
        }

    # ── Three scenarios with WACC shifts ────────────────────────────────
    central = _dcf_at(wacc_central)
    optimistic = _dcf_at(max(wacc_central - 0.01, g_terminal + 0.005))   # −100 bps
    conservative = _dcf_at(wacc_central + 0.015)                          # +150 bps

    return {
        "wacc": round(wacc_central, 4),
        "wacc_components": {
            "rf": rf,
            "erp": erp,
            "beta": beta,
            "cost_of_equity": round(cost_of_equity, 4),
            "cost_of_debt_pre_tax": round(kd_pre, 4),
            "cost_of_debt_after_tax": round(kd_after, 4),
            "tax_rate": round(tax_rate, 4),
            "weight_equity": round(we, 4),
            "weight_debt": round(wd, 4),
            "total_equity_used": round(equity_book, 2),
            "total_debt_used": round(debt, 2),
        },
        "forecast_growth": g_forecast,
        "terminal_growth": g_terminal,
        "base_fcf": round(base_fcf, 2),
        "enterprise_value": round(central["enterprise_value"], 2),
        "equity_value": round(central["equity_value"], 2),
        # The optimistic / conservative bookends become the FE
        # sensitivity_low / sensitivity_high band.
        "sensitivity_low": round(conservative["equity_value"], 2),
        "sensitivity_high": round(optimistic["equity_value"], 2),
        # Full per-scenario detail for the FE 3-scenario table.
        "scenarios": [
            {
                "label": "Optimistic",
                "wacc": round(optimistic["wacc"], 4),
                "enterprise_value": round(optimistic["enterprise_value"], 2),
                "net_debt": round(optimistic["net_debt"], 2),
                "equity_value": round(optimistic["equity_value"], 2),
            },
            {
                "label": "Central",
                "wacc": round(central["wacc"], 4),
                "enterprise_value": round(central["enterprise_value"], 2),
                "net_debt": round(central["net_debt"], 2),
                "equity_value": round(central["equity_value"], 2),
            },
            {
                "label": "Conservative",
                "wacc": round(conservative["wacc"], 4),
                "enterprise_value": round(conservative["enterprise_value"], 2),
                "net_debt": round(conservative["net_debt"], 2),
                "equity_value": round(conservative["equity_value"], 2),
            },
        ],
    }


# ─── Compute (the actual valuation) ──────────────────────────────────────────


def _safe(n: Optional[float], default: float = 0.0) -> float:
    return default if n is None else float(n)


def compute_valuation(
    *,
    industry_key: Optional[str],
    statements: Dict[str, Any],
    user_assumptions: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Build the valuation payload.

    `statements` is the assembled blob (same shape stage_compute consumes):
      { balanceSheet: {...}, incomeStatement: {...} }
    `user_assumptions` is an optional row from user_valuation_assumptions —
    overrides ebitda / multiple / debt / cash if present.
    """
    bs = statements.get("balanceSheet", {})
    pl = statements.get("incomeStatement", {})
    # ── CANONICAL VIEWS — single source of truth ─────────────────────────
    # The Valuation engine MUST read from `assembled_pl` / `assembled_bs` /
    # `assembled_cf`, never derive EBITDA from `revenue − operatingExpenses`
    # (that path produces the operational view, which is negative for EEI
    # and gives the −12.92M nonsense valuation). Statutory EBITDA is the
    # primary; real CapEx (CIP additions) replaces the D&A fallback.
    pl_canonical = statements.get("assembled_pl", {}) or {}
    bs_canonical = statements.get("assembled_bs", {}) or {}
    cf_canonical = statements.get("assembled_cf", {}) or {}

    revenue = _safe(pl.get("revenue"))
    cogs = _safe(pl.get("costOfGoodsSold"))
    opex = _safe(pl.get("operatingExpenses"))
    depreciation = _safe(pl_canonical.get("depreciation", pl.get("depreciationAmortization")))
    interest = _safe(pl_canonical.get("interest_expense", pl.get("interestExpense")))
    other_inc = _safe(pl.get("otherIncome"))
    fin_inc = _safe(pl.get("financialIncome"))
    fin_exp = _safe(pl.get("financialExpense"))
    tax = _safe(pl_canonical.get("tax", pl.get("taxExpense")))

    # EBITDA — statutory view is the PRIMARY (Romanian books, 722 included).
    # ebitda_computed kept for confidence/margin math against revenue only.
    ebitda_statutory = _safe(pl_canonical.get("ebitda_statutory"))
    if ebitda_statutory == 0.0:
        # Fallback for pre-canonical callers — compute statutory inline.
        gross_profit = revenue - cogs
        capitalized = _safe(pl.get("capitalizedOwnWork"))
        ebitda_statutory = gross_profit - opex + other_inc + capitalized

    ebitda_computed = ebitda_statutory
    operating_profit = ebitda_statutory - depreciation
    pretax = _safe(pl_canonical.get("pretax",
                                    operating_profit + fin_inc - fin_exp - interest))
    net_income = _safe(pl_canonical.get("net_income_statutory", pretax - tax))

    cash = _safe(bs_canonical.get("cash", bs.get("cash")))
    total_debt = _safe(bs_canonical.get("total_debt",
                                        _safe(bs.get("shortTermDebt")) + _safe(bs.get("longTermDebt"))))
    # Total equity from the BS — needed for the asset-based fallback when
    # EV/EBITDA is methodologically inappropriate (CRE, negative EBITDA).
    total_equity = _safe(bs_canonical.get("total_equity",
        _safe(bs.get("shareCapital"))
        + _safe(bs.get("retainedEarnings"))
        + _safe(bs.get("otherEquity"))
    ))
    total_assets = _safe(bs_canonical.get("total_assets",
        cash
        + _safe(bs.get("accountsReceivable"))
        + _safe(bs.get("inventory"))
        + _safe(bs.get("otherCurrentAssets"))
        + _safe(bs.get("propertyPlantEquipment"))
        + _safe(bs.get("intangibles"))
        + _safe(bs.get("otherNonCurrentAssets"))
    ))
    # Investment property book value — for the CRE markup range on
    # asset-based valuation. Canonical view exposes it; legacy BS doesn't.
    investment_property_book = _safe(bs_canonical.get("ppe_net",
                                                       bs.get("propertyPlantEquipment", 0)))

    # User overrides (Step 4)
    ua = user_assumptions or {}
    ebitda_used = _safe(ua.get("ebitda_used"), ebitda_computed)
    total_debt_used = _safe(ua.get("debt_used"), total_debt)
    cash_used = _safe(ua.get("cash_used"), cash)

    benchmarks = load_valuation_benchmarks(industry_key)
    ebitda_bm = benchmarks["ev_ebitda"]
    revenue_bm = benchmarks["ev_revenue"]
    industry_used = benchmarks["industry_key_used"]
    industry_requested = benchmarks["industry_key_requested"]

    # ── Methodology guard ────────────────────────────────────────────────
    # EV/EBITDA is mathematically defined for any EBITDA but produces
    # nonsense when EBITDA is negative (a positive multiple × negative
    # EBITDA = negative EV = "company worth less than its debt by definition",
    # which is a fact about the formula not about the company). It's also
    # the wrong method for commercial real estate, where value derives from
    # the property asset and NOI / cap rate, not from operating earnings.
    #
    # Rule:
    #   - EBITDA ≤ 0  → demote EV/EBITDA, switch primary to asset_based
    #   - industry is CRE → demote EV/EBITDA, switch primary to asset_based
    # In both cases EV/EBITDA stays in the response (auditable) but is NOT
    # the primary method and is NOT shown on the football field.
    cre_industries = {"real_estate_commercial", "real_estate", "real_estate_office",
                      "real_estate_retail", "real_estate_industrial",
                      "real_estate_logistics", "real_estate_mixed"}
    is_cre = (industry_used in cre_industries) or (industry_requested in cre_industries)
    ebitda_unusable = ebitda_used <= 0

    # ── PRIMARY: EV/EBITDA (default) ─────────────────────────────────────
    primary_method = "ev_ebitda"
    if is_cre or ebitda_unusable:
        primary_method = "asset_based"
    multiple_p25 = (ebitda_bm or {}).get("p25") if ebitda_bm else None
    multiple_p50 = (ebitda_bm or {}).get("p50") if ebitda_bm else None
    multiple_p75 = (ebitda_bm or {}).get("p75") if ebitda_bm else None

    # User-supplied multiple overrides P50 only (the slider position).
    multiple_override = ua.get("multiple_used")
    if multiple_override is not None:
        multiple_p50 = float(multiple_override)

    def equity_from_multiple(m: Optional[float]) -> Optional[float]:
        if m is None:
            return None
        ev = ebitda_used * m
        return round(ev - total_debt_used + cash_used, 2)

    def ev_from_multiple(m: Optional[float]) -> Optional[float]:
        if m is None:
            return None
        return round(ebitda_used * m, 2)

    equity_ebitda_p25 = equity_from_multiple(multiple_p25)
    equity_ebitda_p50 = equity_from_multiple(multiple_p50)
    equity_ebitda_p75 = equity_from_multiple(multiple_p75)
    ev_ebitda_p25 = ev_from_multiple(multiple_p25)
    ev_ebitda_p50 = ev_from_multiple(multiple_p50)
    ev_ebitda_p75 = ev_from_multiple(multiple_p75)

    # ── CROSS-CHECK 1: EV/Revenue ─────────────────────────────────────────
    rev_p25 = (revenue_bm or {}).get("p25") if revenue_bm else None
    rev_p50 = (revenue_bm or {}).get("p50") if revenue_bm else None
    rev_p75 = (revenue_bm or {}).get("p75") if revenue_bm else None

    def equity_from_rev_multiple(m: Optional[float]) -> Optional[float]:
        if m is None or revenue <= 0:
            return None
        ev = revenue * m
        return round(ev - total_debt_used + cash_used, 2)

    ev_rev_equity_p25 = equity_from_rev_multiple(rev_p25)
    ev_rev_equity_p50 = equity_from_rev_multiple(rev_p50)
    ev_rev_equity_p75 = equity_from_rev_multiple(rev_p75)

    # ── CROSS-CHECK 2: DCF ───────────────────────────────────────────────
    # CRE companies in development phase have real one-time CIP capex that
    # would crush the DCF if treated as recurring. Use stabilized FCF for
    # the perpetuity (maintenance capex ≈ D&A).
    real_capex = _safe(cf_canonical.get("capex_real", 0.0))
    net_wc_change = _safe(cf_canonical.get("net_wc_change", 0.0))
    use_stabilized = is_cre and abs(real_capex) > depreciation * 2
    dcf = _dcf_cross_check(
        ebitda=ebitda_used,
        depreciation=depreciation,
        net_income=net_income,
        total_debt=total_debt_used,
        cash=cash_used,
        revenue=revenue,
        interest_expense=interest,
        tax_expense=tax,
        pretax=pretax,
        # Thread the REAL book equity from the canonical BS view so the
        # WACC capital-structure weights are calibrated correctly. The
        # prior `revenue * 0.5` placeholder produced over-weighted equity
        # and under-stated WACC for any RON-denominated entity.
        total_equity=total_equity,
        real_capex=real_capex,
        net_wc_change=net_wc_change,
        use_stabilized_fcf=use_stabilized,
    )

    # ── FCF BREAKDOWN for the Valuation tab tiles ────────────────────────
    # Mirrors the visible "Free cash flow" row on the Valuation tab. The
    # FE reads these verbatim — no client-side capex inference.
    cfo_value = round(net_income + depreciation + net_wc_change, 2)
    fcf_value = round(cfo_value + real_capex, 2)
    fcf_breakdown = {
        "net_income": round(net_income, 2),
        "depreciation": round(depreciation, 2),
        "net_wc_change": round(net_wc_change, 2),
        "cash_from_operating": cfo_value,
        "capex_real": round(real_capex, 2),
        "free_cash_flow": fcf_value,
        "is_development_phase": bool(use_stabilized),
        "stabilized_fcf": round(max(net_income + net_wc_change, 0.0), 2),
    }

    # ── Confidence ───────────────────────────────────────────────────────
    ebitda_margin = (ebitda_used / revenue) if revenue > 0 else 0.0
    if ebitda_used <= 0 or industry_used in (None, "generic", "other", "unknown"):
        confidence = "low"
    elif ebitda_margin < 0.05:
        confidence = "low"
    elif ebitda_margin < 0.10 or industry_used != industry_requested:
        confidence = "medium"
    else:
        confidence = "high"

    # ── Asset-based valuation (primary for CRE / negative-EBITDA) ────────
    # Book equity is the conservative anchor: total assets at cost less
    # accumulated depreciation minus total liabilities. For CRE this is
    # typically conservative relative to fair value; the briefing should
    # frame the gap (Step 7 — "Book LTV is X based on depreciated cost;
    # market LTV is likely lower").
    asset_based_equity = round(total_equity, 2)
    asset_based_label = (
        "Asset-based — investment property + other assets − debt − other liab. "
        "(book value; market value typically higher for stabilized CRE)"
        if is_cre
        else "Asset-based — book equity (EV/EBITDA disabled because EBITDA ≤ 0)"
    )

    # ── Football field ──────────────────────────────────────────────────
    football_field: List[Dict[str, Any]] = []

    # If asset_based is primary, lead with it. For CRE, expose the IP
    # markup range explicitly (1.2× to 1.5× book) — Bucharest commercial
    # market typically trades stabilized assets above depreciated book.
    # NAV bands are computed for EVERY industry — even manufacturers benefit
    # from seeing book equity as a downside floor. The variant logic only
    # differs in how the upper bound is set:
    #   · CRE w/ investment property: book + 20-50% IP markup (Bucharest mkt)
    #   · other asset-based primary:  ±15% sensitivity around book equity
    #   · non-asset-based primary:    ±15% sensitivity around book equity
    asset_based_subtitle = (
        f"Book equity {_fmt_ron(asset_based_equity)} = total assets {_fmt_ron(total_assets)} "
        f"− total liabilities {_fmt_ron(total_assets - asset_based_equity)}. ±15% sensitivity."
    )
    if is_cre and investment_property_book > 0:
        ip_adj_low = investment_property_book * 0.2   # +20% over book
        ip_adj_high = investment_property_book * 0.5  # +50% over book
        asset_based_low = round(asset_based_equity + ip_adj_low, 2)
        asset_based_high = round(asset_based_equity + ip_adj_high, 2)
        asset_based_subtitle = (
            f"Book equity {_fmt_ron(asset_based_equity)}; investment property "
            f"({_fmt_ron(investment_property_book)}) marked up to 1.2-1.5× book "
            f"= +{_fmt_ron(ip_adj_low)} to +{_fmt_ron(ip_adj_high)} adjustment."
        )
    else:
        asset_based_low = round(asset_based_equity * 0.85, 2)
        asset_based_high = round(asset_based_equity * 1.15, 2)

    # Always include NAV on the football field. It's primary for asset-heavy
    # industries (CRE, holdings) and a cross-check / downside floor for
    # operating businesses. Showing it for every customer prevents the
    # "where's NAV?" question that surfaced from a holding-company user.
    football_field.append({
        "method": "Asset-based — net asset value",
        "primary": primary_method == "asset_based",
        "low": asset_based_low,
        "mid": round((asset_based_low + asset_based_high) / 2, 2),
        "high": asset_based_high,
        "subtitle": asset_based_subtitle,
    })

    # Only include EV/EBITDA on the football field if it's the primary
    # method (not demoted). It still appears in the response payload so
    # the dashboard can show it as auditable detail under "All methods
    # considered", but it doesn't headline.
    if equity_ebitda_p25 is not None and primary_method == "ev_ebitda":
        football_field.append({
            "method": "EV / EBITDA (peers)",
            "primary": True,
            "low": equity_ebitda_p25,
            "mid": equity_ebitda_p50,
            "high": equity_ebitda_p75,
            "subtitle": f"{multiple_p25}× — {multiple_p50}× — {multiple_p75}×" if multiple_p25 else None,
        })
    # EV/Revenue is a useful cross-check for revenue-led businesses
    # (manufacturers, wholesale, services). It's NOT meaningful when the
    # primary method is asset-based (CRE) — the cash flows that justify a
    # revenue multiple aren't structurally present in a holding/property
    # company. Industry routing: include only when primary is EV/EBITDA or
    # EV/Revenue itself.
    if ev_rev_equity_p25 is not None and primary_method != "asset_based":
        football_field.append({
            "method": "EV / Revenue (peers)",
            "primary": False,
            "low": ev_rev_equity_p25,
            "mid": ev_rev_equity_p50,
            "high": ev_rev_equity_p75,
            "subtitle": f"{rev_p25}× — {rev_p50}× — {rev_p75}×" if rev_p25 else None,
        })
    # DCF is intentionally NOT appended to football_field for public display.
    # Romanian SMEs with 5-year noisy historicals produce WACC estimates that
    # vary widely and aren't defensible to a CFO. We still compute + persist
    # `dcf` on the response payload so future industries (e.g. growth-stage
    # SaaS) can opt back in without recomputing. The frontend's render layer
    # also filters DCF by method-name as defense in depth.

    if primary_method == "asset_based":
        formula_text = (
            f"Equity = Total assets ({_fmt_ron(total_assets)}) "
            f"− Debt ({_fmt_ron(total_debt_used)}) − Other liabilities "
            f"= Book equity ({_fmt_ron(asset_based_equity)})"
        )
    else:
        formula_text = (
            f"Equity = EBITDA ({_fmt_ron(ebitda_used)}) × Multiple ({multiple_p50}×) "
            f"− Debt ({_fmt_ron(total_debt_used)}) + Cash ({_fmt_ron(cash_used)})"
            if multiple_p50 is not None
            else "Insufficient benchmark data — manual multiple required."
        )

    # Methodology warnings — surfaced on the Valuation tab + briefing.
    method_warnings: List[str] = []
    if ebitda_unusable:
        method_warnings.append(
            f"EV/EBITDA is mathematically undefined for a useful valuation when EBITDA "
            f"is negative or zero (EBITDA = {_fmt_ron(ebitda_used)}). "
            f"Primary method switched to asset-based (book equity)."
        )
    if is_cre:
        method_warnings.append(
            "For commercial real estate, value derives from the property asset and "
            "NOI / cap rate, not from operating earnings. EV/EBITDA is not an appropriate "
            "primary method for this industry — using asset-based equity instead."
        )

    # ── Primary equity value + range — sourced from the right method ─────
    if primary_method == "asset_based":
        primary_equity_value = round((asset_based_low + asset_based_high) / 2, 2)
        primary_equity_low = asset_based_low
        primary_equity_high = asset_based_high
        primary_label = (
            "Net asset value (book equity + RE markup)" if is_cre
            else "Net asset value (book equity)"
        )
    else:
        primary_equity_value = equity_ebitda_p50
        primary_equity_low = equity_ebitda_p25
        primary_equity_high = equity_ebitda_p75
        primary_label = "EV / EBITDA (peer multiple)"

    return {
        "primary_method": primary_method,
        "primary_label": primary_label,
        "primary_equity_value": primary_equity_value,
        "primary_equity_low": primary_equity_low,
        "primary_equity_high": primary_equity_high,
        "method_warnings": method_warnings,
        # Asset-based payload (always computed; shown when primary)
        "asset_based_equity": asset_based_equity,
        "asset_based_label": asset_based_label,
        "total_assets_used": round(total_assets, 2),
        "total_equity_used": round(total_equity, 2),
        "is_cre_industry": is_cre,
        "ebitda_unusable": ebitda_unusable,
        # Inputs (auditable)
        "ebitda_used": round(ebitda_used, 2),
        "revenue_used": round(revenue, 2),
        "total_debt_used": round(total_debt_used, 2),
        "cash_used": round(cash_used, 2),
        # EBITDA multiple primary
        "multiple_ebitda_p25": multiple_p25,
        "multiple_ebitda_p50": multiple_p50,
        "multiple_ebitda_p75": multiple_p75,
        "ev_ebitda_p25": ev_ebitda_p25,
        "ev_ebitda_p50": ev_ebitda_p50,
        "ev_ebitda_p75": ev_ebitda_p75,
        "equity_ebitda_p25": equity_ebitda_p25,
        "equity_ebitda_p50": equity_ebitda_p50,
        "equity_ebitda_p75": equity_ebitda_p75,
        # EV/Revenue cross-check
        "multiple_revenue_p25": rev_p25,
        "multiple_revenue_p50": rev_p50,
        "multiple_revenue_p75": rev_p75,
        "ev_revenue_equity_p25": ev_rev_equity_p25,
        "ev_revenue_equity_p50": ev_rev_equity_p50,
        "ev_revenue_equity_p75": ev_rev_equity_p75,
        # DCF cross-check
        "dcf_wacc": dcf["wacc"],
        "dcf_forecast_growth": dcf.get("forecast_growth"),
        "dcf_terminal_growth": dcf["terminal_growth"],
        "dcf_base_fcf": dcf.get("base_fcf"),
        "dcf_enterprise_value": dcf["enterprise_value"],
        "dcf_equity_value": dcf["equity_value"],
        "dcf_sensitivity_low": dcf["sensitivity_low"],
        "dcf_sensitivity_high": dcf["sensitivity_high"],
        # New: Romania-corrected WACC components + 3-scenario table for
        # the FE to render the methodology breakdown and the sensitivity
        # band (optimistic / central / conservative).
        "dcf_wacc_components": dcf.get("wacc_components"),
        "dcf_scenarios": dcf.get("scenarios"),
        # FCF breakdown — the Valuation tab renders these tiles verbatim.
        # Real CapEx (CIP additions), NOT D&A. Statutory net income
        # (positive), NOT operational (negative). See spec rule 2.
        "fcf_breakdown": fcf_breakdown,
        # Three EBITDA views — surfaced so the FE can show the user which
        # one EV/EBITDA used.
        "ebitda_statutory": _safe(pl_canonical.get("ebitda_statutory")),
        "ebitda_operational": _safe(pl_canonical.get("ebitda_operational")),
        "ebitda_operating_view": _safe(pl_canonical.get("ebitda_operating_view")),
        # Quality + provenance
        "confidence": confidence,
        "multiples_source": (ebitda_bm or {}).get("source") if ebitda_bm else None,
        "multiples_as_of_date": (ebitda_bm or {}).get("as_of_date") if ebitda_bm else None,
        "industry_key_used": industry_used,
        "industry_key_requested": industry_requested,
        # Presentation
        "formula_text": formula_text,
        "football_field": football_field,
    }


def _fmt_ron(n: float) -> str:
    sign = "-" if n < 0 else ""
    a = abs(n)
    if a >= 1_000_000:
        return f"{sign}{a/1_000_000:.2f}M RON"
    if a >= 1_000:
        return f"{sign}{a/1_000:.0f}K RON"
    return f"{sign}{a:.0f} RON"


# ─── Persistence ────────────────────────────────────────────────────────────


def persist_valuation(period_id: str, org_id: str, result: Dict[str, Any]) -> None:
    """Upsert one valuations row per period. Idempotent — re-running the
    pipeline overwrites prior values."""
    row = {
        "period_id": period_id,
        "org_id": org_id,
        "primary_method": result["primary_method"],
        "ebitda_used": result["ebitda_used"],
        "revenue_used": result["revenue_used"],
        "total_debt_used": result["total_debt_used"],
        "cash_used": result["cash_used"],
        "multiple_ebitda_p25": result["multiple_ebitda_p25"],
        "multiple_ebitda_p50": result["multiple_ebitda_p50"],
        "multiple_ebitda_p75": result["multiple_ebitda_p75"],
        "ev_ebitda_p25": result["ev_ebitda_p25"],
        "ev_ebitda_p50": result["ev_ebitda_p50"],
        "ev_ebitda_p75": result["ev_ebitda_p75"],
        "equity_ebitda_p25": result["equity_ebitda_p25"],
        "equity_ebitda_p50": result["equity_ebitda_p50"],
        "equity_ebitda_p75": result["equity_ebitda_p75"],
        "multiple_revenue_p25": result["multiple_revenue_p25"],
        "multiple_revenue_p50": result["multiple_revenue_p50"],
        "multiple_revenue_p75": result["multiple_revenue_p75"],
        "ev_revenue_equity_p25": result["ev_revenue_equity_p25"],
        "ev_revenue_equity_p50": result["ev_revenue_equity_p50"],
        "ev_revenue_equity_p75": result["ev_revenue_equity_p75"],
        "dcf_wacc": result["dcf_wacc"],
        "dcf_terminal_growth": result["dcf_terminal_growth"],
        "dcf_enterprise_value": result["dcf_enterprise_value"],
        "dcf_equity_value": result["dcf_equity_value"],
        "dcf_sensitivity_low": result["dcf_sensitivity_low"],
        "dcf_sensitivity_high": result["dcf_sensitivity_high"],
        "confidence": result["confidence"],
        "multiples_source": result["multiples_source"],
        "multiples_as_of_date": result["multiples_as_of_date"],
    }
    with _supabase.admin() as client:
        client.upsert("valuations", row, on_conflict="period_id")
