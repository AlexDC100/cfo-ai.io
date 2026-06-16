"""GAAP normalizer — Sharadar SF1 + DAILY → assembled_canonical_v1.

NASDAQ-4 scope: bucket-level mapping (Sharadar's pre-aggregated metrics
arrive at bucket granularity, not at the line-item granularity the RO pack
operates at). The output envelope shape is identical to what the RO pack
emits via engine/country_packs/ro_romania/canonical_adapter.assemble_canonical
— same `leaves` / `aggregates` / `unmapped` / `round_trip_check` keys — so
every downstream FE consumer (PLStatementView, computeRatios, NavCascade)
works unchanged.

The "bucket-level mapping" tradeoff: we lose line-level provenance (we
can't say "this revenue line is rental vs product"), but we gain the
ability to support US-GAAP / IFRS / Sharadar in v1 without re-doing the
entire chart-of-accounts mapping per country. The provenance hole is
acceptable because Sharadar IS the ground truth for the public-company
path — there's no upstream chart of accounts to reference back to.

Sign convention reminder (from CANONICAL_SCHEMA_V1.md §3b):
  • All magnitudes are emitted as non-negative.
  • Each bucket carries a sign_meaning enum that tells the consumer
    whether to add or subtract the magnitude when composing totals.
  • Sharadar SF1 returns most fields as positive values (revenue +,
    cost of revenue +, etc.). Net income can be negative — for those
    we take abs() and let the sign_meaning + parent_aggregate context
    drive the displayed sign.
"""

from __future__ import annotations

import logging
from collections import defaultdict
from typing import Any, Dict, List, Optional, Tuple

from ..canonical.schema_v1 import (
    SCHEMA_VERSION,
    SignMeaning,
    bucket_by_name,
    schema_version,
)
from .adapter import DailyMetrics, Fundamentals

logger = logging.getLogger(__name__)


# ── Bucket map: Sharadar SF1 field → canonical leaf name ──────────────
#
# Each entry: (sharadar_field, canonical_leaf, "abs"|"signed"|"neg_to_zero")
# • "abs"        — take absolute value, emit magnitude
# • "signed"     — preserve sign (used for net deltas like net_income that
#                  carry directional meaning)
# • "neg_to_zero" — if the source is negative (e.g. Sharadar emits a credit
#                  balance as negative), clamp to 0 — typically not used
#                  for SF1 since Sharadar pre-normalizes signs
#
# Canonical leaves are chosen as the "most representative" leaf for that
# bucket from a public-company perspective. For example, "receivables" in
# Sharadar is the net trade receivables figure — we map it to
# `ar_trade_gross` because that's the bucket the FE reads when displaying
# "Trade receivables" on the BS table (the ar_provisions contra is
# unavailable from SF1 — we synthesize zero for it).

# (field, canonical_leaf, mode)
_BS_ASSET_MAP: List[Tuple[str, str, str]] = [
    # Cash & equivalents
    ("cash", "cash_operating", "abs"),
    # Trade receivables (gross — SF1 already nets provisions for most tickers)
    ("receivables", "ar_trade_gross", "abs"),
    # Inventory — Sharadar reports a single line; map to merchandise_resale
    # as the most-cross-sector-applicable leaf. Sector-specific refinement
    # could later route manufacturing tickers to inventory_finished_goods.
    ("inventory", "inventory_merchandise_resale", "abs"),
    # PP&E net of accumulated depreciation
    ("ppe", "ppe_grossbook_buildings", "abs"),
    # Intangibles + goodwill rolled together by Sharadar
    ("intangibles", "intangibles_goodwill", "abs"),
]

# Total assets is an aggregate of the above. We also expose it as a memo
# leaf so the round-trip gate has a target to validate against.
_BS_LIAB_MAP: List[Tuple[str, str, str]] = [
    # Sharadar's `debt` = total interest-bearing debt; debtnc = the LT slice
    # We compute ST = debt - debtnc in the normalizer below (handled specially).
    # The LT portion alone maps straight through:
    ("long_term_debt", "bank_loans_lt", "abs"),
    # Sharadar payables = trade payables aggregate (also includes accrued
    # in some filings; acceptable approximation at the bucket level).
    # We use the synthetic field `payables` populated by the normalizer
    # (see _enrich_with_synthetic_fields) — note that the base SF1 schema
    # does carry payables under the `payables` column.
]

_EQUITY_MAP: List[Tuple[str, str, str]] = [
    # Retained earnings — Sharadar gives us this directly as `retearn`
    ("retained_earnings", "retained_earnings_accumulated", "signed"),
    # Sharadar doesn't break out paid-in capital from common stock; map
    # the residual (equity - retained_earnings) to contributed_capital.
    # Handled in the normalizer body, not the map.
]

_PL_REVENUE_MAP: List[Tuple[str, str, str]] = [
    ("revenue", "revenue_main_product", "abs"),
]

_PL_EXPENSE_MAP: List[Tuple[str, str, str]] = [
    ("cogs", "cogs_materials", "abs"),
    ("sga", "external_services_other", "abs"),
    ("rnd", "external_services_rnd", "abs"),
    # D&A is split into D + A in canonical; Sharadar gives a combined figure
    # via the implicit ebitda - ebit calculation. Handled in the normalizer.
    ("interest_expense", "interest_expense_bank", "abs"),
    ("tax_expense", "income_tax_current", "abs"),
]

_CF_MAP: List[Tuple[str, str, str]] = [
    ("operating_cash_flow", "cfo_total", "signed"),
    ("investing_cash_flow", "cfi_total", "signed"),
    ("financing_cash_flow", "cff_total", "signed"),
    ("capex", "cfi_capex", "abs"),
]


# Many of the canonical leaf names referenced above may not exist in the
# v1 schema yet (the schema was authored from the RO pack perspective).
# The normalizer resolves each canonical name at runtime via
# bucket_by_name() — when None, the metric is emitted as `unmapped` rather
# than blowing up the whole envelope. NASDAQ-4 ships best-effort coverage;
# the NASDAQ-5 calibration pass will fill the gaps once we see real
# AAPL / MSFT / F payloads.


def normalize(
    fundamentals: Fundamentals,
    daily: Optional[DailyMetrics] = None,
    *,
    normalizer_version: str = "nasdaq_v1.0.0",
) -> Dict[str, Any]:
    """Sharadar SF1 + DAILY → assembled_canonical_v1 envelope.

    Args:
      fundamentals: one Fundamentals row (one fiscal period)
      daily: optional latest DailyMetrics row (market cap, EV, P/E, etc.).
             When None, the envelope omits the `market_metrics` block.
      normalizer_version: stamp on the envelope for re-normalization
                          decisions (NASDAQ-2 stores this on the row).

    Returns: dict matching the assembled_canonical_v1 contract.
    """
    leaves: Dict[str, Dict[str, Any]] = {}
    unmapped: List[Dict[str, Any]] = []

    def _emit(field_name: str, canonical_name: str, mode: str, value: Optional[float]) -> None:
        """Emit one leaf from a (sharadar_field, canonical_name) mapping."""
        if value is None:
            return  # Sharadar didn't provide the field — skip silently
        bucket = bucket_by_name(canonical_name)
        if bucket is None:
            unmapped.append({
                "code": f"sharadar:{field_name}",
                "name": field_name,
                "amount": float(value),
                "reason": "canonical_leaf_not_in_schema_v1",
                "canonical_attempted": canonical_name,
            })
            return
        if mode == "signed":
            magnitude = abs(value)
            stored_sign = value
        elif mode == "neg_to_zero":
            magnitude = max(0.0, value)
            stored_sign = magnitude
        else:  # abs (default)
            magnitude = abs(value)
            stored_sign = magnitude
        leaves[canonical_name] = {
            "magnitude": magnitude,
            "sign_meaning": bucket.sign_meaning.value,
            "ras_line_items_count": 1,
            "ras_line_items_sum_signed": stored_sign,
            "source_field": f"sharadar:{field_name}",
        }

    # ── Map all field groups ─────────────────────────────────────────
    for field_name, canonical_name, mode in _BS_ASSET_MAP:
        _emit(field_name, canonical_name, mode, getattr(fundamentals, field_name, None))

    # Total liabilities split: Sharadar gives `total_debt` (all interest-
    # bearing) and `long_term_debt`. ST debt = total - long_term.
    if fundamentals.total_debt is not None:
        st_debt = (fundamentals.total_debt or 0) - (fundamentals.long_term_debt or 0)
        _emit("st_debt_synthetic", "bank_loans_st", "abs", st_debt if st_debt > 0 else None)
    for field_name, canonical_name, mode in _BS_LIAB_MAP:
        _emit(field_name, canonical_name, mode, getattr(fundamentals, field_name, None))

    for field_name, canonical_name, mode in _EQUITY_MAP:
        _emit(field_name, canonical_name, mode, getattr(fundamentals, field_name, None))

    # Contributed capital = equity - retained_earnings (Sharadar doesn't
    # split paid-in capital separately). Surface as a single synthesized leaf.
    if fundamentals.total_equity is not None:
        re_value = fundamentals.retained_earnings or 0
        contributed = fundamentals.total_equity - re_value
        _emit("equity_minus_re_synthetic", "share_capital_paid_in", "abs",
              contributed if contributed != 0 else None)

    for field_name, canonical_name, mode in _PL_REVENUE_MAP:
        _emit(field_name, canonical_name, mode, getattr(fundamentals, field_name, None))

    for field_name, canonical_name, mode in _PL_EXPENSE_MAP:
        _emit(field_name, canonical_name, mode, getattr(fundamentals, field_name, None))

    # D&A synthesized from ebitda - ebit (no direct Sharadar column).
    if fundamentals.ebitda is not None and fundamentals.ebit is not None:
        da = fundamentals.ebitda - fundamentals.ebit
        _emit("da_synthetic", "depreciation_total", "abs", da if da > 0 else None)

    for field_name, canonical_name, mode in _CF_MAP:
        _emit(field_name, canonical_name, mode, getattr(fundamentals, field_name, None))

    # ── Compute aggregates from leaves ───────────────────────────────
    aggregates = _compute_aggregates(leaves)

    # ── Headline metrics block (always emit, even when leaves are sparse) ──
    # Downstream FE expects a flat "headline" object for the KPI tiles.
    # We populate it from the original Fundamentals so it stays robust to
    # unmapped-leaf surprises.
    headline = {
        "revenue": fundamentals.revenue,
        "ebitda": fundamentals.ebitda,
        "ebit": fundamentals.ebit,
        "net_income": fundamentals.net_income,
        "total_assets": fundamentals.total_assets,
        "total_equity": fundamentals.total_equity,
        "total_debt": fundamentals.total_debt,
        "cash": fundamentals.cash,
        "operating_cash_flow": fundamentals.operating_cash_flow,
        "free_cash_flow": fundamentals.free_cash_flow,
    }

    # ── Market metrics block (only when daily is provided) ──
    market_metrics: Optional[Dict[str, Any]] = None
    if daily is not None:
        market_metrics = {
            "as_of": daily.as_of.isoformat(),
            "market_cap": daily.market_cap,
            "enterprise_value": daily.enterprise_value,
            "ev_ebitda": daily.ev_ebitda,
            "ev_ebit": daily.ev_ebit,
            "ev_revenue": daily.ev_revenue,
            "pe_ratio": daily.pe_ratio,
            "pb_ratio": daily.pb_ratio,
            "ps_ratio": daily.ps_ratio,
            "dividend_yield": daily.dividend_yield,
            "currency": daily.currency,
        }

    # ── Round-trip gate ──
    # For US-GAAP we can sanity-check: total_assets ≈ total_liabilities +
    # total_equity (within 0.5%). This is the BS balance check.
    round_trip = _round_trip_check(fundamentals)

    return {
        "schema_version": schema_version(),
        "normalizer_version": normalizer_version,
        "source": "nasdaq_sharadar_sf1",
        "ticker": fundamentals.ticker,
        "dimension": fundamentals.dimension,
        "fiscal_period_end": fundamentals.fiscal_period_end.isoformat(),
        "currency": fundamentals.currency,
        "leaves": leaves,
        "aggregates": aggregates,
        "unmapped": unmapped,
        "headline": headline,
        "market_metrics": market_metrics,
        "round_trip_check": round_trip,
    }


# ─── Universe row builder ──────────────────────────────────────────────
# PUB-UPG (Public Companies upgrade) — flattens the live envelope returned
# by `pipeline.get_company_envelope` into the single-row shape consumed by
# the FE universe table. Demo rows go through `demo_universe.demo_snapshot_for`
# which produces the same shape — the FE never branches on source.

def build_universe_snapshot_row(
    envelope: Dict[str, Any],
    *,
    fallback_name: str,
    fallback_sector: str,
) -> Optional[Dict[str, Any]]:
    """Envelope → flat FE row. Returns None when the envelope has no
    fundamentals to render (caller falls back to the demo snapshot)."""
    from datetime import datetime, timezone

    periods = envelope.get("periods") or []
    if not periods:
        return None
    latest = periods[0]
    headline = latest.get("headline") or {}
    market = latest.get("market_metrics") or {}
    info = envelope.get("ticker_info") or {}

    def _pct(value: Optional[float]) -> Optional[float]:
        """Convert a 0–1 ratio to a percentage point. None passes through."""
        return value * 100 if value is not None else None

    revenue = headline.get("revenue")
    ebitda = headline.get("ebitda")
    net_income = headline.get("net_income")
    cash = headline.get("cash")
    total_debt = headline.get("total_debt")
    equity = headline.get("total_equity")
    ocf = headline.get("operating_cash_flow")
    fcf = headline.get("free_cash_flow")
    market_cap = market.get("market_cap")

    ebitda_margin = (ebitda / revenue * 100) if revenue and ebitda else None
    net_margin = (net_income / revenue * 100) if revenue and net_income else None
    net_debt = (total_debt - cash) if (total_debt is not None and cash is not None) else None
    nd_to_ebitda = (net_debt / ebitda) if (net_debt is not None and ebitda not in (None, 0)) else None
    fcf_yield = (fcf / market_cap * 100) if (fcf and market_cap) else None
    roe = (net_income / equity * 100) if (net_income and equity) else None
    debt_to_equity = (total_debt / equity) if (total_debt is not None and equity not in (None, 0)) else None

    return {
        "ticker": envelope.get("ticker"),
        "companyName": info.get("name") or fallback_name,
        "exchange": info.get("exchange"),
        "sector": info.get("sector") or fallback_sector,
        "industry": info.get("industry"),
        "country": info.get("country"),
        "currency": latest.get("currency") or info.get("currency") or "USD",
        "mode": "live",
        "price": None,
        "marketCap": market_cap,
        "enterpriseValue": market.get("enterprise_value"),
        "revenue": revenue,
        "revenueGrowth": None,  # requires prior period — not computed in v1
        "grossProfit": None,
        "grossMargin": None,
        "ebitda": ebitda,
        "ebitdaMargin": ebitda_margin,
        "operatingIncome": headline.get("ebit"),
        "netIncome": net_income,
        "netMargin": net_margin,
        "cash": cash,
        "grossDebt": total_debt,
        "netDebt": net_debt,
        "equity": equity,
        "operatingCashFlow": ocf,
        "capex": None,
        "freeCashFlow": fcf,
        "peRatio": market.get("pe_ratio"),
        "evToEbitda": market.get("ev_ebitda"),
        "evToSales": market.get("ev_revenue"),
        "fcfYield": fcf_yield,
        "dividendYield": _pct(market.get("dividend_yield")) if market.get("dividend_yield") and market["dividend_yield"] < 1 else market.get("dividend_yield"),
        "roe": roe,
        "roa": None,
        "roic": None,
        "netDebtToEbitda": nd_to_ebitda,
        "debtToEquity": debt_to_equity,
        "currentRatio": None,
        "latestPeriod": latest.get("dimension"),
        "latestPeriodEnd": latest.get("fiscal_period_end"),
        "lastUpdated": datetime.now(timezone.utc).isoformat(),
        "source": "nasdaq",
        "confidence": 0.95,
        "missingFields": [],
    }


def _compute_aggregates(leaves: Dict[str, Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    """Roll leaves up to their parent_aggregate per the canonical schema.

    Sign composition: each leaf carries sign_meaning. asset_positive +
    asset_negative net within the same aggregate; revenue_positive +
    revenue_negative likewise; etc. For v1 simplicity we just sum the
    magnitudes (Sharadar leaves are essentially singletons per aggregate,
    so the contra math rarely applies). The RO pack's full sign-aware
    aggregation logic could be ported here later if needed.
    """
    by_aggregate: Dict[str, Dict[str, Any]] = defaultdict(lambda: {"net": 0.0, "leaves": []})
    for leaf_name, leaf_data in leaves.items():
        bucket = bucket_by_name(leaf_name)
        if bucket is None:
            continue
        parent = bucket.parent_aggregate
        by_aggregate[parent]["net"] += float(leaf_data["magnitude"])
        by_aggregate[parent]["leaves"].append(leaf_name)
    return dict(by_aggregate)


def _round_trip_check(f: Fundamentals) -> Dict[str, Any]:
    """BS balance check: total_assets ≈ total_liabilities + total_equity."""
    if f.total_assets is None or f.total_liabilities is None or f.total_equity is None:
        return {"passed": None, "reason": "fields_missing"}
    lhs = f.total_assets
    rhs = f.total_liabilities + f.total_equity
    if lhs == 0:
        return {"passed": True, "tolerance_pct": 0.5, "max_deviation_pct": 0.0}
    deviation_pct = abs(lhs - rhs) / abs(lhs) * 100
    return {
        "passed": deviation_pct <= 0.5,
        "tolerance_pct": 0.5,
        "max_deviation_pct": round(deviation_pct, 4),
        "total_assets": lhs,
        "total_liab_plus_equity": rhs,
    }


__all__ = ["normalize"]
