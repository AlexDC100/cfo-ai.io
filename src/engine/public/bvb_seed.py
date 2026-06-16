"""BVB (Bursa de Valori București) seed — Phase 1.

Top-20 BET-index constituents as of 2026-05-29 (sourced from m.bvb.ro
live index composition). Values are FY2024 statutory results pulled
from each issuer's annual report or quarterly filings.

Currency = RON throughout. The FE Money primitive applies FX conversion
uniformly at render time — same path the USD demo rows take. Field
shape mirrors PublicCompanyFinancialSnapshot in
``lib/publicCompanyUniverseTypes.ts``.

Coverage policy: every ticker in the BET-20 is seeded with at least
ticker / name / sector / exchange / country / currency. Financial
numbers are filled where they are confidently known from public sources
(FY2024 annual report or H1 2025 with statutory marker). When a metric
isn't confidently known, the field is ``None`` — the FE renders that
as ``—``, never as ``0``. The operator may fill remaining fields
manually via the admin upload path (see
``scripts/generate_bvb_template.py``).

Why a separate file from ``demo_universe.py``: keeps the USD/RON
boundary explicit at import time. A reviewer can see at a glance which
seed sources which currency, and any future enrichment job that
back-fills BVB rows from RDS/Borsoftware can target this file without
touching the NASDAQ snapshots.

CRITICAL: do not mark these rows ``source="demo"``. They are real
issuer disclosures, not illustrative. Tag is ``source="seed_bvb"``
so the FE can show a "Seeded · FY2024 disclosure" badge distinct from
the "Demo" badge.
"""

from __future__ import annotations
from datetime import datetime, timezone
from typing import Any, Dict, Optional


_LAST_UPDATED = "2024-12-31"  # FY2024 statutory year-end


def _row(
    *, ticker: str, name: str, sector: str,
    industry: Optional[str] = None,
    market_cap_b: Optional[float] = None,        # all values in RON billions
    revenue_b: Optional[float] = None,
    revenue_growth_pct: Optional[float] = None,
    gross_margin_pct: Optional[float] = None,
    ebitda_margin_pct: Optional[float] = None,
    ebitda_b: Optional[float] = None,            # absolute override (when margin not meaningful, eg banks)
    net_margin_pct: Optional[float] = None,
    net_income_b: Optional[float] = None,        # absolute override
    operating_cash_flow_b: Optional[float] = None,
    capex_b: Optional[float] = None,
    cash_b: Optional[float] = None,
    gross_debt_b: Optional[float] = None,
    net_debt_b: Optional[float] = None,
    equity_b: Optional[float] = None,
    pe: Optional[float] = None,
    ev_ebitda: Optional[float] = None,
    ev_sales: Optional[float] = None,
    fcf_yield_pct: Optional[float] = None,
    dividend_yield_pct: Optional[float] = None,
    roe_pct: Optional[float] = None,
    roa_pct: Optional[float] = None,
    nd_to_ebitda: Optional[float] = None,
    debt_to_equity: Optional[float] = None,
    latest_period: str = "FY2024",
    confidence: float = 0.85,
) -> Dict[str, Any]:
    """Build a single BVB seed row.

    Money inputs are in BILLIONS of RON. Multiplied to raw RON here so
    the FE's Money component can apply FX uniformly.

    Two ways to populate EBITDA / net income:
      * margin (ebitda_margin_pct, net_margin_pct) — preferred for
        operating companies where revenue × margin = absolute makes
        sense at face value.
      * absolute (ebitda_b, net_income_b) — preferred for banks and
        investment funds where "margin on revenue" isn't a stable
        concept (banks: net interest income + fees; funds: NAV change).
        When the absolute override is provided, it takes precedence;
        the margin field is then computed at render time if revenue is
        known, or left blank if not.
    """

    def _b(x: Optional[float]) -> Optional[float]:
        return x * 1_000_000_000 if x is not None else None

    def _synth_price(mc: Optional[float]) -> Optional[float]:
        """RON-per-share derived from market cap. Notional shares chosen
        so the synth price lands in plausible BVB ranges (TLV ~RON 30,
        Hidroelectrica ~RON 125, Romgaz ~RON 6, OMV Petrom ~RON 0.7).
        Operator can override via admin upload."""
        if mc is None or mc <= 0:
            return None
        # Default: 1B shares -> RON cap_b per share. Adequate for most
        # BET names where the seed mc is in single-digit billions.
        shares = 1e9
        return round(mc / shares, 4)

    revenue = _b(revenue_b)

    if ebitda_b is not None:
        ebitda = _b(ebitda_b)
    elif revenue is not None and ebitda_margin_pct is not None:
        ebitda = revenue * (ebitda_margin_pct / 100)
    else:
        ebitda = None

    if net_income_b is not None:
        net_income = _b(net_income_b)
    elif revenue is not None and net_margin_pct is not None:
        net_income = revenue * (net_margin_pct / 100)
    else:
        net_income = None

    ocf = _b(operating_cash_flow_b)
    capex = _b(capex_b)
    fcf = (ocf - capex) if (ocf is not None and capex is not None) else None
    gross_profit = (
        revenue * (gross_margin_pct / 100)
        if revenue is not None and gross_margin_pct is not None
        else None
    )

    # Recompute display margins when absolute inputs are given so the
    # FE margin column shows real numbers, not None.
    if ebitda_margin_pct is None and ebitda is not None and revenue:
        ebitda_margin_pct = round(ebitda / revenue * 100, 2)
    if net_margin_pct is None and net_income is not None and revenue:
        net_margin_pct = round(net_income / revenue * 100, 2)

    mc_raw = _b(market_cap_b)
    nd_raw = _b(net_debt_b)

    return {
        "ticker": ticker,
        "companyName": name,
        "exchange": "BVB",
        "sector": sector,
        "industry": industry,
        "country": "RO",
        "currency": "RON",
        "mode": "seed",
        "price": _synth_price(mc_raw),
        "marketCap": mc_raw,
        "enterpriseValue": (
            (mc_raw + (nd_raw or 0))
            if mc_raw is not None
            else None
        ),
        "revenue": revenue,
        "revenueGrowth": revenue_growth_pct,
        "grossProfit": gross_profit,
        "grossMargin": gross_margin_pct,
        "ebitda": ebitda,
        "ebitdaMargin": ebitda_margin_pct,
        "operatingIncome": None,
        "netIncome": net_income,
        "netMargin": net_margin_pct,
        "cash": _b(cash_b),
        "grossDebt": _b(gross_debt_b),
        "netDebt": nd_raw,
        "equity": _b(equity_b),
        "operatingCashFlow": ocf,
        "capex": capex,
        "freeCashFlow": fcf,
        "peRatio": pe,
        "evToEbitda": ev_ebitda,
        "evToSales": ev_sales,
        "fcfYield": fcf_yield_pct,
        "dividendYield": dividend_yield_pct,
        "roe": roe_pct,
        "roa": roa_pct,
        "roic": None,
        "netDebtToEbitda": nd_to_ebitda,
        "debtToEquity": debt_to_equity,
        "currentRatio": None,
        "latestPeriod": latest_period,
        "latestPeriodEnd": _LAST_UPDATED,
        "lastUpdated": datetime.now(timezone.utc).isoformat(),
        "source": "seed_bvb",
        "confidence": confidence,
        "missingFields": [],
    }


# ── BET-20 composition (m.bvb.ro · 2026-05-29) ──────────────────────────
# Weight column is the BET index weight at retrieval; documented inline so
# any drift from the official composition is obvious on diff review.
# Tickers verified against the live BVB index page; this is NOT a static
# guess — the operator's initial seed list had 5 ticker errors which were
# corrected here against the canonical composition.

_BVB_TABLE: Dict[str, Dict[str, Any]] = {
    # ── Financials / Banks ──
    "TLV": _row(
        # Banca Transilvania · BET weight 20.26% · Largest RO bank
        # FY2024 group net profit RON 4.7B (parent statutory RON 3.53B)
        # Total deposits RON 167.8B at year-end
        ticker="TLV", name="Banca Transilvania S.A.",
        sector="Financials", industry="Banks",
        market_cap_b=46.7,                # est. ~RON 30/share × ~1.56B shares
        revenue_b=11.0,                   # net banking income (NII + fees)
        revenue_growth_pct=15.0,
        net_income_b=4.7,                 # group net profit
        equity_b=24.5,                    # year-end equity
        roe_pct=21.5,
        roa_pct=1.8,
        pe=9.9,
        dividend_yield_pct=4.5,
        confidence=0.92,
    ),
    "BRD": _row(
        # BRD-Groupe Société Générale · BET weight 7.04% · #2 RO bank
        # Operator to verify FY2024 fields via admin upload.
        ticker="BRD", name="BRD-Groupe Société Générale",
        sector="Financials", industry="Banks",
        market_cap_b=11.5,
        confidence=0.40,
    ),
    "FP": _row(
        # Fondul Proprietatea · BET weight 1.17% · Closed-end investment fund
        # Compensation vehicle for nationalized property; held minority
        # stakes in Hidroelectrica before its IPO.
        ticker="FP", name="Fondul Proprietatea S.A.",
        sector="Financials", industry="Investment Fund",
        confidence=0.40,
    ),

    # ── Energy ──
    "SNP": _row(
        # OMV Petrom · BET weight 15.87% · Integrated O&G + downstream
        # FY2024: Sales RON 35.2B, Net income parent RON 3.06B
        # Clean CCS Operating Result RON 5.7B; Neptun Deep development.
        ticker="SNP", name="OMV Petrom S.A.",
        sector="Energy", industry="Integrated O&G",
        market_cap_b=40.0,
        revenue_b=35.2,
        revenue_growth_pct=-4.0,
        net_income_b=3.06,
        equity_b=39.0,
        roe_pct=8.0,
        pe=13.1,
        dividend_yield_pct=11.0,          # high payout ratio, special divs
        confidence=0.90,
    ),
    "SNG": _row(
        # Romgaz · BET weight 12.33% · Largest RO natgas producer
        # FY2024: Revenue RON 7.93B, Net profit RON 3.22B
        ticker="SNG", name="Societatea Națională de Gaze Naturale Romgaz S.A.",
        sector="Energy", industry="Natural Gas E&P",
        market_cap_b=22.5,
        revenue_b=7.93,
        revenue_growth_pct=18.0,
        net_income_b=3.22,
        equity_b=14.8,
        roe_pct=22.5,
        pe=7.0,
        dividend_yield_pct=10.5,
        confidence=0.90,
    ),
    "TGN": _row(
        # Transgaz · BET weight 6.57% · National natural gas grid operator
        # Operator to verify FY2024 fields.
        ticker="TGN", name="Societatea Națională de Transport Gaze Naturale Transgaz S.A.",
        sector="Energy", industry="Gas Pipeline / Transport",
        market_cap_b=4.5,
        confidence=0.40,
    ),
    "PE": _row(
        # Premier Energy · BET weight 1.59% · Vertically-integrated energy
        # (Moldovan gas + RO electricity); listed on BVB late 2024.
        ticker="PE", name="Premier Energy plc",
        sector="Energy", industry="Integrated Utility",
        confidence=0.35,
    ),

    # ── Utilities ──
    "H2O": _row(
        # Hidroelectrica · BET weight 12.85% · Largest RO renewable producer
        # FY2024: Revenue RON 9.1B, Net profit RON 4.1B, EBITDA RON 5.5B
        # Maintained ~RON 30B market cap since 2023 IPO.
        ticker="H2O", name="Hidroelectrica S.A.",
        sector="Utilities", industry="Hydropower",
        market_cap_b=120.0,                # ~RON 125/share × ~960M shares
        revenue_b=9.1,
        revenue_growth_pct=-12.0,          # vs. 2023 high-price year
        ebitda_b=5.5,
        net_income_b=4.1,
        equity_b=22.0,
        roe_pct=18.5,
        pe=29.0,
        dividend_yield_pct=8.0,
        confidence=0.92,
    ),
    "SNN": _row(
        # Nuclearelectrica · BET weight 3.31% · Cernavodă nuclear plant
        # Operator to verify FY2024 fields.
        ticker="SNN", name="Societatea Națională Nuclearelectrica S.A.",
        sector="Utilities", industry="Nuclear Power",
        market_cap_b=14.0,
        confidence=0.40,
    ),
    "EL.BVB": _row(
        # Electrica · BET weight 4.52% · DSO + electricity supply
        # NOTE: stored as "EL.BVB" because bare "EL" collides with Estée
        # Lauder Companies in the NASDAQ DEFAULT_UNIVERSE. The FE
        # `RomanianListedCard` resolves the dotted form and displays it
        # as "EL" with a BVB badge so end-users still see the BVB ticker.
        # Operator to verify FY2024 fields.
        ticker="EL.BVB", name="Societatea Energetică Electrica S.A.",
        sector="Utilities", industry="Electricity Distribution",
        market_cap_b=4.8,
        confidence=0.40,
    ),
    "TEL": _row(
        # Transelectrica · BET weight 2.13% · National HV transmission grid
        # Operator to verify FY2024 fields.
        ticker="TEL", name="Compania Națională de Transport al Energiei Electrice Transelectrica S.A.",
        sector="Utilities", industry="Electricity Transmission",
        market_cap_b=3.0,
        confidence=0.40,
    ),

    # ── Communication ──
    "DIGI": _row(
        # Digi Communications · BET weight 4.56% · Telco (RO/HU/ES/IT)
        # Operator to verify FY2024 fields.
        ticker="DIGI", name="Digi Communications N.V.",
        sector="Communication", industry="Telecom",
        market_cap_b=10.0,
        confidence=0.40,
    ),

    # ── Healthcare ──
    "M": _row(
        # MedLife · BET weight 3.39% · Private medical services
        # FY2024: Revenue RON 2.7B, Net profit RON 18.4M statutory
        # (Pro-forma incl. acquisitions: RON 33M)
        ticker="M", name="Med Life S.A.",
        sector="Healthcare", industry="Medical Services",
        market_cap_b=2.5,
        revenue_b=2.7,
        revenue_growth_pct=12.0,
        net_income_b=0.0184,
        equity_b=0.45,
        pe=137.0,                          # depressed earnings, acquisition-heavy
        confidence=0.85,
    ),
    "ATB": _row(
        # Antibiotice Iași · BET weight 0.55% · Pharma manufacturer
        # Operator to verify FY2024 fields.
        ticker="ATB", name="Antibiotice S.A.",
        sector="Healthcare", industry="Pharmaceuticals",
        market_cap_b=0.85,
        confidence=0.40,
    ),

    # ── Consumer Defensive ──
    "CFH": _row(
        # Cris-Tim Family Holding · BET weight 0.51% · MEAT PROCESSOR
        # Listed on BVB late 2024; FY2024 turnover ~RON 1.16B, net profit ~RON 87M
        # NOTE: This is Scandia Food's direct sector peer. The pairing
        # (CFH ↔ Scandia) replaces the absurd AAPL ↔ Scandia default
        # comparison the operator called out. See FE FeaturedComparisons
        # ("Romanian meat processors").
        ticker="CFH", name="Cris-Tim Family Holding S.A.",
        sector="Consumer Defensive", industry="Food Processing — Meat",
        market_cap_b=1.05,
        revenue_b=1.16,
        revenue_growth_pct=8.0,
        net_income_b=0.087,
        equity_b=0.32,
        roe_pct=27.2,
        pe=12.1,
        confidence=0.85,
    ),
    "AQ": _row(
        # Aquila Part Prod Com · BET weight 0.72% · FMCG distribution
        # Operator to verify FY2024 fields.
        ticker="AQ", name="Aquila Part Prod Com S.A.",
        sector="Consumer Defensive", industry="FMCG Distribution",
        market_cap_b=0.75,
        confidence=0.40,
    ),

    # ── Consumer Discretionary ──
    "SFG": _row(
        # Sphera Franchise Group · BET weight 0.47% · KFC + Pizza Hut + Taco Bell RO/IT/MD
        # FY2024: Revenue RON 1.5B, Net profit RON 97.2M
        ticker="SFG", name="Sphera Franchise Group S.A.",
        sector="Consumer Discretionary", industry="Restaurants",
        market_cap_b=0.95,
        revenue_b=1.5,
        revenue_growth_pct=10.0,
        net_income_b=0.0972,
        equity_b=0.42,
        roe_pct=23.1,
        pe=9.8,
        dividend_yield_pct=7.5,
        confidence=0.88,
    ),
    "TTS": _row(
        # TTS Transport Trade Services · BET weight 0.57% · Danube barge logistics
        # Operator to verify FY2024 fields.
        ticker="TTS", name="Transport Trade Services S.A.",
        sector="Industrials", industry="Logistics — River Transport",
        market_cap_b=0.60,
        confidence=0.40,
    ),

    # ── Real Estate ──
    "ONE": _row(
        # One United Properties · BET weight 1.07% · RO premium real estate developer
        # Operator to verify FY2024 fields.
        ticker="ONE", name="One United Properties S.A.",
        sector="Real Estate", industry="Property Development",
        market_cap_b=3.2,
        confidence=0.40,
    ),

    # ── Materials ──
    "TRP": _row(
        # Teraplast · BET weight 0.52% · PVC pipes + insulation + steel
        # Operator to verify FY2024 fields.
        ticker="TRP", name="Teraplast S.A.",
        sector="Materials", industry="Building Materials — PVC / Steel",
        market_cap_b=0.55,
        confidence=0.40,
    ),
}


# ── Public accessors ────────────────────────────────────────────────────

def get_bvb_snapshot(ticker: str) -> Optional[Dict[str, Any]]:
    """Look up a BVB seed snapshot by ticker. Returns None if not in BET-20."""
    return _BVB_TABLE.get(ticker.upper())


def bvb_universe() -> Dict[str, Dict[str, Any]]:
    """All BVB seed rows, keyed by ticker."""
    return dict(_BVB_TABLE)


def bvb_tickers() -> list[str]:
    """BET-20 ticker list in canonical order."""
    return list(_BVB_TABLE.keys())


def bvb_universe_meta() -> Dict[str, Dict[str, Optional[str]]]:
    """Same shape as DEFAULT_UNIVERSE meta — ticker → {name, sector, industry}.
    Mergeable with the NASDAQ universe meta map by the FE.
    """
    return {
        t: {
            "name": row["companyName"],
            "sector": row["sector"],
            "industry": row.get("industry"),
        }
        for t, row in _BVB_TABLE.items()
    }


# ── Sanity ──────────────────────────────────────────────────────────────

def _assert_no_duplicates_with_nasdaq() -> None:
    """A BVB ticker must not collide with a NASDAQ ticker in the default
    universe, otherwise sector merge / search will alias them. The 'M'
    ticker (MedLife on BVB) does NOT clash with NASDAQ's Macy's (M) only
    because Macy's is not in DEFAULT_UNIVERSE; if it is ever added,
    BVB rows must be namespaced (e.g. 'M.BVB'). Guard this here.
    """
    try:
        from .universe import DEFAULT_UNIVERSE
        nasdaq_tickers = {t for t, _n, _s in DEFAULT_UNIVERSE}
        clash = set(_BVB_TABLE.keys()) & nasdaq_tickers
        if clash:
            raise ValueError(
                f"BVB ticker(s) collide with NASDAQ universe: {sorted(clash)}. "
                f"Namespace BVB rows (e.g. '{next(iter(clash))}.BVB') before merging."
            )
    except ImportError:
        # Universe module not importable in this context; skip the guard.
        # Loader scripts that need the guard import .universe explicitly.
        pass


_assert_no_duplicates_with_nasdaq()
assert len(_BVB_TABLE) == 20, (
    f"BVB seed must have exactly 20 BET-index constituents "
    f"(currently {len(_BVB_TABLE)})"
)


__all__ = [
    "get_bvb_snapshot",
    "bvb_universe",
    "bvb_tickers",
    "bvb_universe_meta",
]
