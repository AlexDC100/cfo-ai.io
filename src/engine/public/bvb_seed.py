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
from typing import Any, Dict, Optional


_LAST_UPDATED = "2024-12-31"  # FY2024 statutory year-end

# When each table was TAKEN — the row's ``lastUpdated``. Until 2026-09-04
# it was ``datetime.now()`` evaluated at import: the PROCESS CLOCK at
# engine boot, so 72 company cards read "computed <container start>" for
# figures that were months old, and the stamp moved on every restart. A
# seed's data timestamp is the day the seed was taken; it does not move.
#   · BET-20 seed: composition, weights and market caps retrieved
#     2026-05-29 (module docstring; the table header below).
#   · Regulated-market listing rows: retrieved 2026-07-23 (their table
#     header) — listing-only, no market cap, so the date stamps the
#     identity fields alone.
# The ANAF overlay at the bottom fills P&L / balance fields from a cache
# that carries its own per-ticker ``fetched_at``; it never touches the
# seeded market cap, which is the figure the FE dates by this stamp, and
# the FE dates a revenue by its fiscal PERIOD, not by any timestamp.
_SEED_RETRIEVED_AT = "2026-05-29"
_LISTING_RETRIEVED_AT = "2026-07-23"


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
    country: str = "RO",
    retrieved_at: str = _SEED_RETRIEVED_AT,
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

    # Price policy (changed 2026-07-23): the old _synth_price heuristic
    # (market cap ÷ notional 1B shares) produced numbers wildly off the
    # real quote for most names (TLV synth 0.55 vs. real ~37 RON) — worse
    # than showing nothing next to a REAL price chart. Seed rows now ship
    # price=None; universe_service enriches BVB rows with live quotes from
    # the Yahoo spark batch endpoint (providers/yahoo_bvb.py) at serve time.

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
    ev_raw = (mc_raw + (nd_raw or 0)) if mc_raw is not None else None

    # Derive the EV-based ratios when both inputs are curated and the
    # explicit override wasn't provided — fills EV/EBITDA and
    # Net Debt/EBITDA on rows that only stated the raw components.
    if ev_ebitda is None and ev_raw is not None and ebitda:
        ev_ebitda = round(ev_raw / ebitda, 1)
    if nd_to_ebitda is None and nd_raw is not None and ebitda:
        nd_to_ebitda = round(nd_raw / ebitda, 2)

    return {
        "ticker": ticker,
        "companyName": name,
        "exchange": "BVB",
        "sector": sector,
        "industry": industry,
        "country": country,
        "currency": "RON",
        "mode": "seed",
        "price": None,
        "marketCap": mc_raw,
        "enterpriseValue": ev_raw,
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
        "lastUpdated": retrieved_at,
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


# ── Regulated-market full-listing coverage (m.bvb.ro · 2026-07-23) ──────
# Every OTHER company on the BVB regulated (main) market beyond the BET-20
# seed above — 68 rows (88 listed in total), so the Romania-only universe
# shows ALL listed companies, not just index constituents. These rows are LISTING-ONLY:
# ticker / name / sector / industry with NO financials (the FE renders
# missing fields as "—", never 0 — same coverage policy as the BET seed).
# Financial back-fill comes from a live provider (candidates researched
# 2026-07-23: EODHD fundamentals for .RO tickers, FinancialReports.eu EU
# feed, easybiny.com free BVB prices, ANAF /bilant for statutory RO
# financials by CUI) or the operator's admin upload path.
#
# Tickers namespaced ".BVB" where the bare symbol collides with the
# NASDAQ DEFAULT_UNIVERSE (same convention as EL.BVB above):
#   STZ.BVB (Sinteza vs Constellation Brands) · ARM.BVB (Armătura vs Arm).

def _listing(ticker: str, name: str, sector: str, industry: str, country: str = "RO") -> Dict[str, Any]:
    return _row(ticker=ticker, name=name, sector=sector, industry=industry,
                confidence=0.5, country=country, retrieved_at=_LISTING_RETRIEVED_AT)


_BVB_REGS_TABLE: Dict[str, Dict[str, Any]] = {
    row["ticker"]: row for row in [
        _listing("BRK", "SSIF BRK Financial Group S.A.", "Financials", "Brokerage"),
        _listing("EAI", "Electro-Alfa International S.A.", "Industrials", "Electrical equipment"),
        _listing("OIL", "Oil Terminal S.A.", "Energy", "Oil storage & terminals"),
        _listing("ROC1", "ROCA Industry HoldingRock1 S.A.", "Industrials", "Building-materials holding"),
        _listing("IMP", "Impact Developer & Contractor S.A.", "Real Estate", "Residential development"),
        _listing("TRIP", "Christian '76 Tour S.A.", "Consumer Discretionary", "Travel & tourism"),
        _listing("AROBS", "AROBS Transilvania Software S.A.", "Technology", "Software"),
        _listing("COTE", "Conpet S.A.", "Energy", "Oil pipeline transport"),
        _listing("PBK", "Patria Bank S.A.", "Financials", "Banking"),
        _listing("ALT", "Altur S.A.", "Industrials", "Auto components"),
        _listing("SNO", "Șantierul Naval Orșova S.A.", "Industrials", "Shipbuilding"),
        _listing("STZ.BVB", "Sinteza S.A.", "Materials", "Chemicals"),
        _listing("CRC", "Chimcomplex S.A. Borzești", "Materials", "Chemicals"),
        _listing("BVB", "Bursa de Valori București S.A.", "Financials", "Securities exchange"),
        _listing("LONG", "Longshield Investment Group S.A.", "Financials", "Investment holding"),
        _listing("CMP", "Compa S.A.", "Industrials", "Auto components"),
        _listing("TBK", "Transilvania Broker de Asigurare S.A.", "Financials", "Insurance brokerage"),
        _listing("ARS", "Aerostar S.A.", "Industrials", "Aerospace & defense"),
        _listing("PTR", "Rompetrol Well Services S.A.", "Energy", "Oilfield services"),
        _listing("LION", "Lion Capital S.A.", "Financials", "Investment fund"),
        _listing("IARV", "IAR S.A. Brașov", "Industrials", "Aerospace & defense"),
        _listing("VNC", "Vrancart S.A.", "Materials", "Paper & packaging"),
        _listing("RMAH", "Farmaceutica Remedia S.A.", "Healthcare", "Pharma distribution"),
        _listing("EVER", "Evergent Investments S.A.", "Financials", "Investment fund"),
        _listing("WINE", "Purcari Wineries PLC", "Consumer Defensive", "Wine & spirits"),
        _listing("ENP", "Compania Energopetrol S.A.", "Energy", "Oilfield services"),
        _listing("BRM", "Bermas S.A.", "Consumer Defensive", "Brewing"),
        _listing("EFO", "Turism, Hoteluri, Restaurante Marea Neagră S.A.", "Consumer Discretionary", "Hotels & leisure"),
        _listing("SMTL", "Simtel Team S.A.", "Industrials", "Solar EPC & engineering"),
        _listing("COMI", "Condmag S.A.", "Industrials", "Pipeline construction"),
        _listing("BNET", "Bittnet Systems S.A.", "Technology", "IT services"),
        _listing("TRANSI", "Transilvania Investments Alliance S.A.", "Financials", "Investment fund"),
        _listing("EBS", "Erste Group Bank AG", "Financials", "Banking", country="AT"),
        _listing("BIO", "Biofarm S.A.", "Healthcare", "Pharmaceuticals"),
        _listing("SAFE", "Safetech Innovations S.A.", "Technology", "Cybersecurity"),
        _listing("AAG", "AAGES S.A.", "Industrials", "Electrical equipment"),
        _listing("ROCE", "Romcarbon S.A.", "Materials", "Plastics & recycling"),
        _listing("RPH", "Ropharma S.A.", "Healthcare", "Pharmacy retail"),
        _listing("RRC", "Rompetrol Rafinare S.A.", "Energy", "Refining & marketing"),
        _listing("CMF", "Comelf S.A.", "Industrials", "Metal structures & machinery"),
        _listing("INFINITY", "Infinity Capital Investments S.A.", "Financials", "Investment fund"),
        _listing("PREB", "Prebet Aiud S.A.", "Materials", "Concrete products"),
        _listing("ALR", "Alro S.A.", "Materials", "Aluminium"),
        _listing("ALU", "Alumil Rom Industry S.A.", "Materials", "Aluminium systems"),
        _listing("UAM", "UAMT S.A.", "Industrials", "Auto components"),
        _listing("TBM", "Turbomecanica S.A.", "Industrials", "Aero engines & components"),
        _listing("CBC", "Carbochim S.A.", "Materials", "Abrasives"),
        _listing("GREEN", "Green Tech International S.A.", "Materials", "Plastics recycling"),
        _listing("CMCM", "COMCM S.A. Constanța", "Materials", "Construction materials"),
        _listing("BUCV", "Bucur S.A.", "Consumer Defensive", "Wholesale & distribution"),
        _listing("SOCP", "Socep S.A.", "Industrials", "Port operations"),
        _listing("ELMA", "Electromagnetica S.A.", "Industrials", "Electrical equipment"),
        _listing("ARM.BVB", "Armătura S.A.", "Industrials", "Valves & fittings"),
        _listing("BCM", "Casa de Bucovina-Club de Munte S.A.", "Consumer Discretionary", "Hotels & leisure"),
        _listing("ECT", "Grupul Industrial Electrocontact S.A.", "Industrials", "Electrical components"),
        _listing("ELJ", "Electroaparataj S.A.", "Industrials", "Electrical equipment"),
        _listing("ARTE", "Artego S.A.", "Materials", "Rubber products"),
        _listing("MECF", "Mecanica Ceahlău S.A.", "Industrials", "Agricultural machinery"),
        _listing("ELGS", "AETA S.A.", "Consumer Discretionary", "Household appliances"),
        _listing("CNTE", "Conted S.A.", "Consumer Discretionary", "Apparel manufacturing"),
        _listing("MFC", "MF Capital S.A.", "Financials", "Investment holding"),
        _listing("PPL", "Promateris S.A.", "Materials", "Bioplastics & packaging"),
        _listing("PREH", "Prefab S.A.", "Materials", "Prefab concrete"),
        _listing("CAOR", "SIF Hoteluri S.A.", "Consumer Discretionary", "Hotels & leisure"),
        _listing("NAPO", "Societatea de Construcții Napoca S.A.", "Industrials", "Construction"),
        _listing("UZT", "Uztel S.A.", "Industrials", "Oilfield equipment"),
        _listing("MCAB", "Romcab S.A.", "Industrials", "Cables & wiring"),
        _listing("VESY", "VES S.A.", "Consumer Discretionary", "Household goods"),
    ]
}


# ── ANAF Bilanț overlay ─────────────────────────────────────────────────
# scripts/backfill_bvb_anaf.py fetches statutory filings from the free ANAF
# web service (providers/anaf_bilant.py) for every ticker in bvb_cui_map.py
# and writes bvb_anaf_cache.json next to this file. The overlay is
# FILL-ONLY: a field is written only when the row's current value is None,
# so the BET-20's curated CONSOLIDATED annual-report figures are never
# replaced by the standalone statutory filing (they differ for groups).

def _apply_anaf_cache() -> None:
    import json as _json
    from pathlib import Path as _Path

    cache_path = _Path(__file__).with_name("bvb_anaf_cache.json")
    if not cache_path.exists():
        return
    try:
        cache = _json.loads(cache_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return

    for table in (_BVB_TABLE, _BVB_REGS_TABLE):
        for ticker, row in table.items():
            entry = cache.get(ticker) or {}
            fields = dict(entry.get("fields") or {})
            if not fields:
                continue
            # Holding-parent guard: for group parents (Electrica etc.) the
            # STANDALONE statutory P&L is management fees, not the group's
            # business — e.g. EL.BVB files ~11M RON revenue against a ~5B
            # market cap, which would render a 600% net margin. When the
            # curated market cap dwarfs the ANAF revenue (<1%), drop the
            # P&L fields and keep only balance items (equity / cash).
            mc = row.get("marketCap")
            anaf_rev = fields.get("revenue")
            if mc and anaf_rev and anaf_rev < mc * 0.01:
                for k in ("revenue", "netIncome", "netMargin", "roa", "debtToEquity"):
                    fields.pop(k, None)
            if not fields:
                continue
            revenue_from_anaf = False
            filled = False
            for key, val in fields.items():
                if key in ("latestPeriod", "latestPeriodEnd"):
                    continue
                if row.get(key) is None:
                    row[key] = val
                    filled = True
                    if key == "revenue":
                        revenue_from_anaf = True
            if not filled:
                continue
            # Only rows whose P&L now COMES from ANAF get the filing's
            # period label; curated rows keep their annual-report period.
            if revenue_from_anaf and fields.get("latestPeriod"):
                row["latestPeriod"] = f"{fields['latestPeriod']} · ANAF"
                row["latestPeriodEnd"] = fields.get(
                    "latestPeriodEnd", row.get("latestPeriodEnd")
                )
            row["confidence"] = max(float(row.get("confidence") or 0), 0.65)


_apply_anaf_cache()


# ── Public accessors ────────────────────────────────────────────────────

def get_bvb_snapshot(ticker: str) -> Optional[Dict[str, Any]]:
    """Look up a BVB seed snapshot by ticker (BET-20 seed OR the
    regulated-market listing rows). Returns None when not BVB-listed."""
    t = ticker.upper()
    return _BVB_TABLE.get(t) or _BVB_REGS_TABLE.get(t)


def bvb_universe() -> Dict[str, Dict[str, Any]]:
    """All BVB rows (BET-20 seed first, then the rest of the regulated
    market), keyed by ticker."""
    return {**_BVB_TABLE, **_BVB_REGS_TABLE}


def bvb_tickers() -> list[str]:
    """All BVB tickers — BET-20 first, then the regulated-market rest."""
    return list(_BVB_TABLE.keys()) + list(_BVB_REGS_TABLE.keys())


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
        for t, row in bvb_universe().items()
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
        clash = (set(_BVB_TABLE.keys()) | set(_BVB_REGS_TABLE.keys())) & nasdaq_tickers
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
assert len(_BVB_REGS_TABLE) == 68, (
    f"BVB regulated-market listing table must cover the 68 non-BET main-market "
    f"companies (88 listed total on m.bvb.ro as of 2026-07-23; currently "
    f"{len(_BVB_REGS_TABLE)})"
)
assert not (set(_BVB_TABLE) & set(_BVB_REGS_TABLE)), (
    "A ticker appears in BOTH the BET-20 seed and the listing table — "
    "remove it from the listing table."
)


__all__ = [
    "get_bvb_snapshot",
    "bvb_universe",
    "bvb_tickers",
    "bvb_universe_meta",
]
