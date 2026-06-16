"""Public-company universe — the 200+ ticker default set that hydrates
the ``/public-companies`` table on first load.

PUB-200 upgrade — grew from 57 to 202 tickers across 12 sectors. Sector
keys mirror Sharadar's `sector` taxonomy (the same field the SF1
normalizer emits), so a row from the live feed and a row from this
static const land in the same bucket.

Single source of truth. Edits welcome — keep the file flat (no imports)
so it can be loaded by both the API layer and ad-hoc scripts without an
import-time cost.

Sector keys (12 buckets):
  Technology · Semiconductors · Communication · Consumer Discretionary ·
  Consumer Defensive · Healthcare · Financials · Industrials · Energy ·
  Utilities · Real Estate · Materials

Industry sub-tags exposed via `industry_for(ticker)` for the metric
quick-filter chips (Software / Payments / Aerospace / Pharma / etc).
"""

from __future__ import annotations
from typing import Dict, List, Optional, Tuple

# ── The universe ─────────────────────────────────────────────────────────
# Format: (ticker, display_name, sector)
# Order is preserved for fallback display when no sort is applied.
DEFAULT_UNIVERSE: List[Tuple[str, str, str]] = [
    # ── Technology (16) ──
    ("AAPL",  "Apple Inc.",                          "Technology"),
    ("MSFT",  "Microsoft Corp.",                     "Technology"),
    ("ORCL",  "Oracle Corp.",                        "Technology"),
    ("CRM",   "Salesforce Inc.",                     "Technology"),
    ("ADBE",  "Adobe Inc.",                          "Technology"),
    ("CSCO",  "Cisco Systems Inc.",                  "Technology"),
    ("IBM",   "International Business Machines",     "Technology"),
    ("NOW",   "ServiceNow Inc.",                     "Technology"),
    ("INTU",  "Intuit Inc.",                         "Technology"),
    ("ACN",   "Accenture plc",                       "Technology"),
    ("SAP",   "SAP SE",                              "Technology"),
    ("SNPS",  "Synopsys Inc.",                       "Technology"),
    ("CDNS",  "Cadence Design Systems Inc.",         "Technology"),
    ("PANW",  "Palo Alto Networks Inc.",             "Technology"),
    ("FTNT",  "Fortinet Inc.",                       "Technology"),
    ("WDAY",  "Workday Inc.",                        "Technology"),
    ("TEAM",  "Atlassian Corp.",                     "Technology"),
    ("DDOG",  "Datadog Inc.",                        "Technology"),
    ("SNOW",  "Snowflake Inc.",                      "Technology"),

    # ── Semiconductors (18) ──
    ("NVDA",  "NVIDIA Corp.",                        "Semiconductors"),
    ("AVGO",  "Broadcom Inc.",                       "Semiconductors"),
    ("AMD",   "Advanced Micro Devices Inc.",         "Semiconductors"),
    ("INTC",  "Intel Corp.",                         "Semiconductors"),
    ("QCOM",  "Qualcomm Inc.",                       "Semiconductors"),
    ("TXN",   "Texas Instruments Inc.",              "Semiconductors"),
    ("MU",    "Micron Technology Inc.",              "Semiconductors"),
    ("ASML",  "ASML Holding N.V.",                   "Semiconductors"),
    ("TSM",   "Taiwan Semiconductor Mfg.",           "Semiconductors"),
    ("ARM",   "Arm Holdings plc",                    "Semiconductors"),
    ("MRVL",  "Marvell Technology Inc.",             "Semiconductors"),
    ("MCHP",  "Microchip Technology Inc.",           "Semiconductors"),
    ("ADI",   "Analog Devices Inc.",                 "Semiconductors"),
    ("NXPI",  "NXP Semiconductors N.V.",             "Semiconductors"),
    ("AMAT",  "Applied Materials Inc.",              "Semiconductors"),
    ("LRCX",  "Lam Research Corp.",                  "Semiconductors"),
    ("ON",    "ON Semiconductor Corp.",              "Semiconductors"),
    ("SWKS",  "Skyworks Solutions Inc.",             "Semiconductors"),

    # ── Communication (13) ──
    ("GOOGL", "Alphabet Inc. (Class A)",             "Communication"),
    ("META",  "Meta Platforms Inc.",                 "Communication"),
    ("NFLX",  "Netflix Inc.",                        "Communication"),
    ("DIS",   "Walt Disney Co.",                     "Communication"),
    ("CMCSA", "Comcast Corp.",                       "Communication"),
    ("TMUS",  "T-Mobile US Inc.",                    "Communication"),
    ("VZ",    "Verizon Communications Inc.",         "Communication"),
    ("T",     "AT&T Inc.",                           "Communication"),
    ("CHTR",  "Charter Communications Inc.",         "Communication"),
    ("SPOT",  "Spotify Technology S.A.",             "Communication"),
    ("EA",    "Electronic Arts Inc.",                "Communication"),
    ("WBD",   "Warner Bros. Discovery Inc.",         "Communication"),
    ("MTCH",  "Match Group Inc.",                    "Communication"),

    # ── Consumer Discretionary (20) ──
    ("AMZN",  "Amazon.com Inc.",                     "Consumer Discretionary"),
    ("TSLA",  "Tesla Inc.",                          "Consumer Discretionary"),
    ("HD",    "Home Depot Inc.",                     "Consumer Discretionary"),
    ("MCD",   "McDonald's Corp.",                    "Consumer Discretionary"),
    ("NKE",   "NIKE Inc.",                           "Consumer Discretionary"),
    ("SBUX",  "Starbucks Corp.",                     "Consumer Discretionary"),
    ("BKNG",  "Booking Holdings Inc.",               "Consumer Discretionary"),
    ("LOW",   "Lowe's Companies Inc.",               "Consumer Discretionary"),
    ("TJX",   "TJX Companies Inc.",                  "Consumer Discretionary"),
    ("LULU",  "Lululemon Athletica Inc.",            "Consumer Discretionary"),
    ("ROST",  "Ross Stores Inc.",                    "Consumer Discretionary"),
    ("F",     "Ford Motor Co.",                      "Consumer Discretionary"),
    ("GM",    "General Motors Co.",                  "Consumer Discretionary"),
    ("ABNB",  "Airbnb Inc.",                         "Consumer Discretionary"),
    ("MAR",   "Marriott International Inc.",         "Consumer Discretionary"),
    ("RCL",   "Royal Caribbean Cruises Ltd.",        "Consumer Discretionary"),
    ("CMG",   "Chipotle Mexican Grill Inc.",         "Consumer Discretionary"),
    ("ORLY",  "O'Reilly Automotive Inc.",            "Consumer Discretionary"),
    ("YUM",   "Yum! Brands Inc.",                    "Consumer Discretionary"),
    ("CCL",   "Carnival Corp.",                      "Consumer Discretionary"),

    # ── Consumer Defensive (17) ──
    ("KO",    "Coca-Cola Co.",                       "Consumer Defensive"),
    ("PEP",   "PepsiCo Inc.",                        "Consumer Defensive"),
    ("WMT",   "Walmart Inc.",                        "Consumer Defensive"),
    ("PG",    "Procter & Gamble Co.",                "Consumer Defensive"),
    ("COST",  "Costco Wholesale Corp.",              "Consumer Defensive"),
    ("MDLZ",  "Mondelez International Inc.",         "Consumer Defensive"),
    ("CL",    "Colgate-Palmolive Co.",               "Consumer Defensive"),
    ("PM",    "Philip Morris International Inc.",    "Consumer Defensive"),
    ("MO",    "Altria Group Inc.",                   "Consumer Defensive"),
    ("KMB",   "Kimberly-Clark Corp.",                "Consumer Defensive"),
    ("GIS",   "General Mills Inc.",                  "Consumer Defensive"),
    ("HSY",   "Hershey Co.",                         "Consumer Defensive"),
    ("STZ",   "Constellation Brands Inc.",           "Consumer Defensive"),
    ("EL",    "Estée Lauder Companies Inc.",         "Consumer Defensive"),
    ("TGT",   "Target Corp.",                        "Consumer Defensive"),
    ("KR",    "Kroger Co.",                          "Consumer Defensive"),
    ("SYY",   "Sysco Corp.",                         "Consumer Defensive"),

    # ── Healthcare (24) ──
    ("UNH",   "UnitedHealth Group Inc.",             "Healthcare"),
    ("JNJ",   "Johnson & Johnson",                   "Healthcare"),
    ("LLY",   "Eli Lilly and Co.",                   "Healthcare"),
    ("ABBV",  "AbbVie Inc.",                         "Healthcare"),
    ("MRK",   "Merck & Co. Inc.",                    "Healthcare"),
    ("PFE",   "Pfizer Inc.",                         "Healthcare"),
    ("TMO",   "Thermo Fisher Scientific Inc.",       "Healthcare"),
    ("ISRG",  "Intuitive Surgical Inc.",             "Healthcare"),
    ("ABT",   "Abbott Laboratories",                 "Healthcare"),
    ("DHR",   "Danaher Corp.",                       "Healthcare"),
    ("BMY",   "Bristol-Myers Squibb Co.",            "Healthcare"),
    ("AMGN",  "Amgen Inc.",                          "Healthcare"),
    ("GILD",  "Gilead Sciences Inc.",                "Healthcare"),
    ("MDT",   "Medtronic plc",                       "Healthcare"),
    ("CVS",   "CVS Health Corp.",                    "Healthcare"),
    ("CI",    "Cigna Group",                         "Healthcare"),
    ("REGN",  "Regeneron Pharmaceuticals Inc.",      "Healthcare"),
    ("VRTX",  "Vertex Pharmaceuticals Inc.",         "Healthcare"),
    ("BSX",   "Boston Scientific Corp.",             "Healthcare"),
    ("ELV",   "Elevance Health Inc.",                "Healthcare"),
    ("NVO",   "Novo Nordisk A/S",                    "Healthcare"),
    ("AZN",   "AstraZeneca plc",                     "Healthcare"),
    ("ZTS",   "Zoetis Inc.",                         "Healthcare"),
    ("HUM",   "Humana Inc.",                         "Healthcare"),

    # ── Financials (24) ──
    ("JPM",   "JPMorgan Chase & Co.",                "Financials"),
    ("BAC",   "Bank of America Corp.",               "Financials"),
    ("WFC",   "Wells Fargo & Co.",                   "Financials"),
    ("GS",    "Goldman Sachs Group Inc.",            "Financials"),
    ("MS",    "Morgan Stanley",                      "Financials"),
    ("V",     "Visa Inc.",                           "Financials"),
    ("MA",    "Mastercard Inc.",                     "Financials"),
    ("AXP",   "American Express Co.",                "Financials"),
    ("BLK",   "BlackRock Inc.",                      "Financials"),
    ("SCHW",  "Charles Schwab Corp.",                "Financials"),
    ("USB",   "U.S. Bancorp",                        "Financials"),
    ("PNC",   "PNC Financial Services Group",        "Financials"),
    ("TFC",   "Truist Financial Corp.",              "Financials"),
    ("COF",   "Capital One Financial Corp.",         "Financials"),
    ("CB",    "Chubb Ltd.",                          "Financials"),
    ("MET",   "MetLife Inc.",                        "Financials"),
    ("AIG",   "American International Group Inc.",   "Financials"),
    ("AON",   "Aon plc",                             "Financials"),
    ("MMC",   "Marsh & McLennan Cos.",               "Financials"),
    ("SPGI",  "S&P Global Inc.",                     "Financials"),
    ("ICE",   "Intercontinental Exchange Inc.",      "Financials"),
    ("CME",   "CME Group Inc.",                      "Financials"),
    ("FI",    "Fiserv Inc.",                         "Financials"),
    ("TROW",  "T. Rowe Price Group Inc.",            "Financials"),

    # ── Industrials (21) ──
    ("CAT",   "Caterpillar Inc.",                    "Industrials"),
    ("GE",    "GE Aerospace",                        "Industrials"),
    ("HON",   "Honeywell International Inc.",        "Industrials"),
    ("BA",    "Boeing Co.",                          "Industrials"),
    ("UPS",   "United Parcel Service Inc.",          "Industrials"),
    ("DE",    "Deere & Co.",                         "Industrials"),
    ("LMT",   "Lockheed Martin Corp.",               "Industrials"),
    ("RTX",   "RTX Corp.",                           "Industrials"),
    ("NOC",   "Northrop Grumman Corp.",              "Industrials"),
    ("GD",    "General Dynamics Corp.",              "Industrials"),
    ("LHX",   "L3Harris Technologies Inc.",          "Industrials"),
    ("MMM",   "3M Co.",                              "Industrials"),
    ("ETN",   "Eaton Corp. plc",                     "Industrials"),
    ("ITW",   "Illinois Tool Works Inc.",            "Industrials"),
    ("EMR",   "Emerson Electric Co.",                "Industrials"),
    ("PH",    "Parker-Hannifin Corp.",               "Industrials"),
    ("ROK",   "Rockwell Automation Inc.",            "Industrials"),
    ("FDX",   "FedEx Corp.",                         "Industrials"),
    ("UNP",   "Union Pacific Corp.",                 "Industrials"),
    ("CSX",   "CSX Corp.",                           "Industrials"),
    ("LUV",   "Southwest Airlines Co.",              "Industrials"),

    # ── Energy (12) ──
    ("XOM",   "Exxon Mobil Corp.",                   "Energy"),
    ("CVX",   "Chevron Corp.",                       "Energy"),
    ("COP",   "ConocoPhillips",                      "Energy"),
    ("EOG",   "EOG Resources Inc.",                  "Energy"),
    ("MPC",   "Marathon Petroleum Corp.",            "Energy"),
    ("PSX",   "Phillips 66",                         "Energy"),
    ("VLO",   "Valero Energy Corp.",                 "Energy"),
    ("OXY",   "Occidental Petroleum Corp.",          "Energy"),
    ("SLB",   "Schlumberger Ltd.",                   "Energy"),
    ("KMI",   "Kinder Morgan Inc.",                  "Energy"),
    ("WMB",   "Williams Cos. Inc.",                  "Energy"),
    ("OKE",   "ONEOK Inc.",                          "Energy"),

    # ── Utilities (12) ──
    ("NEE",   "NextEra Energy Inc.",                 "Utilities"),
    ("DUK",   "Duke Energy Corp.",                   "Utilities"),
    ("SO",    "Southern Co.",                        "Utilities"),
    ("AEP",   "American Electric Power Co.",         "Utilities"),
    ("EXC",   "Exelon Corp.",                        "Utilities"),
    ("SRE",   "Sempra",                              "Utilities"),
    ("D",     "Dominion Energy Inc.",                "Utilities"),
    ("XEL",   "Xcel Energy Inc.",                    "Utilities"),
    ("PEG",   "Public Service Enterprise Group",     "Utilities"),
    ("ED",    "Consolidated Edison Inc.",            "Utilities"),
    ("AWK",   "American Water Works Co.",            "Utilities"),
    ("ETR",   "Entergy Corp.",                       "Utilities"),

    # ── Real Estate (12) ──
    ("PLD",   "Prologis Inc.",                       "Real Estate"),
    ("AMT",   "American Tower Corp.",                "Real Estate"),
    ("EQIX",  "Equinix Inc.",                        "Real Estate"),
    ("SPG",   "Simon Property Group Inc.",           "Real Estate"),
    ("O",     "Realty Income Corp.",                 "Real Estate"),
    ("PSA",   "Public Storage",                      "Real Estate"),
    ("WELL",  "Welltower Inc.",                      "Real Estate"),
    ("AVB",   "AvalonBay Communities Inc.",          "Real Estate"),
    ("EQR",   "Equity Residential",                  "Real Estate"),
    ("DLR",   "Digital Realty Trust Inc.",           "Real Estate"),
    ("VICI",  "VICI Properties Inc.",                "Real Estate"),
    ("EXR",   "Extra Space Storage Inc.",            "Real Estate"),
    ("CCI",   "Crown Castle Inc.",                   "Real Estate"),

    # ── Materials (10) ──
    ("LIN",   "Linde plc",                           "Materials"),
    ("APD",   "Air Products & Chemicals Inc.",       "Materials"),
    ("SHW",   "Sherwin-Williams Co.",                "Materials"),
    ("ECL",   "Ecolab Inc.",                         "Materials"),
    ("FCX",   "Freeport-McMoRan Inc.",               "Materials"),
    ("NEM",   "Newmont Corp.",                       "Materials"),
    ("NUE",   "Nucor Corp.",                         "Materials"),
    ("MLM",   "Martin Marietta Materials Inc.",      "Materials"),
    ("VMC",   "Vulcan Materials Co.",                "Materials"),
    ("DOW",   "Dow Inc.",                            "Materials"),
]

# ── Industry sub-tags ────────────────────────────────────────────────────
# Optional finer-grained classification used by the metric quick-filter
# chips on the FE ("Software", "Payments / Fintech", "Aerospace", "Pharma").
# Tickers not in the map render as the bare sector. Mirrors the spec §3
# coverage list. Keys must be a subset of DEFAULT_UNIVERSE tickers.
INDUSTRY: Dict[str, str] = {
    # Software (Tech subset)
    "MSFT": "Software", "ORCL": "Software", "CRM": "Software", "ADBE": "Software",
    "NOW": "Software", "INTU": "Software", "SAP": "Software", "WDAY": "Software",
    "SNPS": "Software", "CDNS": "Software", "PANW": "Software", "FTNT": "Software",
    # Payments / Fintech (Financials subset)
    "V": "Payments / Fintech", "MA": "Payments / Fintech", "AXP": "Payments / Fintech",
    "SPGI": "Payments / Fintech", "ICE": "Payments / Fintech", "CME": "Payments / Fintech",
    # Aerospace (Industrials subset)
    "BA": "Aerospace", "LMT": "Aerospace", "RTX": "Aerospace", "NOC": "Aerospace",
    "GD": "Aerospace", "LHX": "Aerospace", "GE": "Aerospace",
    # Automobiles (Consumer Discretionary subset)
    "TSLA": "Automobiles", "F": "Automobiles", "GM": "Automobiles",
    # Pharma (Healthcare subset)
    "JNJ": "Pharma", "LLY": "Pharma", "ABBV": "Pharma", "MRK": "Pharma",
    "PFE": "Pharma", "BMY": "Pharma", "AMGN": "Pharma", "GILD": "Pharma",
    "REGN": "Pharma", "VRTX": "Pharma", "NVO": "Pharma", "AZN": "Pharma",
    # Retail (Consumer Defensive subset)
    "WMT": "Retail", "COST": "Retail", "TGT": "Retail", "HD": "Retail",
    "LOW": "Retail", "TJX": "Retail", "ROST": "Retail",
}


# ── Sanity checks ────────────────────────────────────────────────────────

def _assert_unique() -> None:
    """Catch duplicates at import time so a careless edit fails loud."""
    seen: set[str] = set()
    for t, _name, _sec in DEFAULT_UNIVERSE:
        if t in seen:
            raise ValueError(f"Duplicate ticker in DEFAULT_UNIVERSE: {t!r}")
        seen.add(t)


def _assert_industry_keys_valid() -> None:
    """Every INDUSTRY key must exist in DEFAULT_UNIVERSE."""
    tickers = {t for t, _n, _s in DEFAULT_UNIVERSE}
    orphans = [k for k in INDUSTRY if k not in tickers]
    if orphans:
        raise ValueError(f"INDUSTRY keys not in DEFAULT_UNIVERSE: {orphans}")


_assert_unique()
_assert_industry_keys_valid()
assert len(DEFAULT_UNIVERSE) >= 200, (
    f"DEFAULT_UNIVERSE must hold ≥200 tickers per PUB-200 upgrade spec §3 "
    f"(currently {len(DEFAULT_UNIVERSE)})"
)


# ── Public accessors ─────────────────────────────────────────────────────

def universe_tickers() -> List[str]:
    """Plain list of tickers in display order."""
    return [t for t, _n, _s in DEFAULT_UNIVERSE]


def universe_meta() -> Dict[str, Dict[str, Optional[str]]]:
    """Map ticker → {name, sector, industry}. Used by the universe service
    to backfill display name + sector when the live feed omits one and
    by the FE chip filter row for finer-grained groupings."""
    return {
        t: {"name": n, "sector": s, "industry": INDUSTRY.get(t)}
        for t, n, s in DEFAULT_UNIVERSE
    }


def industry_for(ticker: str) -> Optional[str]:
    """Industry sub-tag for the metric quick-filter chips. Returns None
    when the ticker has no finer-grained classification."""
    return INDUSTRY.get(ticker)


def sectors() -> List[str]:
    """De-duplicated, display-ordered sector list for the chip filter row.
    "All" is rendered by the FE — not included here."""
    seen: List[str] = []
    for _t, _n, sec in DEFAULT_UNIVERSE:
        if sec not in seen:
            seen.append(sec)
    return seen


def industries() -> List[str]:
    """De-duplicated industry sub-tags for the finer-grained FE chips."""
    seen: List[str] = []
    for v in INDUSTRY.values():
        if v not in seen:
            seen.append(v)
    return seen


__all__ = [
    "DEFAULT_UNIVERSE", "INDUSTRY",
    "universe_tickers", "universe_meta", "industry_for",
    "sectors", "industries",
]
