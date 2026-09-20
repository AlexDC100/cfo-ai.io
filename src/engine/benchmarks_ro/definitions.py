"""Declared data for the Romanian sourced sector benchmark.

Everything a reader could mistake for a rule written in prose lives here
as DATA (TC-10): the size-band cut-offs, the minimum peer count, the
ratio definitions with the exact filed lines they read, and the list of
ratios the summary-level filing cannot support (with the reason).

THE LAW (owner, 2026-09-20): no benchmark figure renders without SOURCE,
YEAR and N. A cell with fewer than MIN_PEERS peers says "insufficient
peers" and carries no median. Absent is never zero. A ratio the filed
summary does not carry is REFUSED with that reason, never approximated.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

SCHEMA = "ro_sector_benchmarks/1"

#: Minimum number of peers before a median may be published.
MIN_PEERS = 5

PUBLISHER = "Ministerul Finantelor"
LICENSE = "CC-BY-4.0"


def source_label(years: Tuple[int, ...]) -> str:
    """The exact citation, e.g. "Ministerul Finantelor - situatii
    financiare anuale, published on data.gov.ro, FY2024, CC-BY-4.0"."""
    fy = " and ".join("FY%d" % y for y in sorted(years))
    return (
        "Ministerul Finantelor - situatii financiare anuale, "
        "published on data.gov.ro, %s, %s" % (fy, LICENSE)
    )


#: Size bands by FILED net turnover (Cifra de afaceri neta, I13), whole
#: RON. Membership: min_ron <= turnover < max_ron (max_ron None = open).
#: Declared as data; every surface prints these cut-offs from here.
SIZE_BANDS: List[Dict[str, Any]] = [
    {"key": "lt_1m", "min_ron": 1, "max_ron": 1_000_000},
    {"key": "1m_10m", "min_ron": 1_000_000, "max_ron": 10_000_000},
    {"key": "10m_50m", "min_ron": 10_000_000, "max_ron": 50_000_000},
    {"key": "50m_250m", "min_ron": 50_000_000, "max_ron": 250_000_000},
    {"key": "gte_250m", "min_ron": 250_000_000, "max_ron": None},
]

#: The pseudo-band holding every filer with a positive filed turnover.
ALL_SIZES = "all_sizes"

# Filed lines, verbatim from the portal's companion spec (no diacritics).
L_I1 = "ACTIVE IMOBILIZATE - TOTAL (I1)"
L_I2 = "ACTIVE CIRCULANTE - TOTAL (I2)"
L_I3 = "Stocuri (I3)"
L_I4 = "Creante (I4)"
L_I6 = "CHELTUIELI IN AVANS (I6)"
L_I7 = "DATORII (I7)"
L_I10 = "CAPITALURI - TOTAL (I10)"
L_I13 = "Cifra de afaceri neta (I13)"
L_I18 = "Profit net (I18)"
L_I19 = "Pierdere neta (I19)"

_TA = [L_I1, L_I2, L_I6]
_NET = [L_I18, L_I19]

#: Ratios the filed summary supports. ``unit``: "fraction" (0.05 = 5%)
#: or "days". ``company_basis`` states how the company-side figure must
#: be computed for a like-with-like comparison, and where the ratio card
#: differs.
RATIOS: Dict[str, Dict[str, Any]] = {
    "net_margin": {
        "unit": "fraction",
        "formula": "(I18 - I19) / I13",
        "filed_lines": _NET + [L_I13],
        "company_basis": "net result / net turnover; same definition as "
                         "the ratio card",
    },
    "roe": {
        "unit": "fraction",
        "formula": "(I18 - I19) / I10, year-end equity, I10 > 0",
        "filed_lines": _NET + [L_I10],
        "company_basis": "net result / YEAR-END equity. The ratio card "
                         "uses average equity when a prior period exists; "
                         "the company figure must be restated on year-end "
                         "equity before it is set beside this band",
    },
    "roa": {
        "unit": "fraction",
        "formula": "(I18 - I19) / (I1 + I2 + I6)",
        "filed_lines": _NET + _TA,
        "company_basis": "net result / year-end total assets",
    },
    "equity_ratio": {
        "unit": "fraction",
        "formula": "I10 / (I1 + I2 + I6)",
        "filed_lines": [L_I10] + _TA,
        "company_basis": "total equity / total assets; same definition "
                         "as the ratio card",
    },
    "liabilities_to_assets": {
        "unit": "fraction",
        "formula": "I7 / (I1 + I2 + I6)",
        "filed_lines": [L_I7] + _TA,
        "company_basis": "TOTAL liabilities (datorii) / total assets. "
                         "Deferred income (I8) and provisions (I9) sit "
                         "outside I7. This is NOT the ratio card's debt / "
                         "assets, which reads financial debt only",
    },
    "receivables_days": {
        "unit": "days",
        "formula": "I4 / I13 x 365",
        "filed_lines": [L_I4, L_I13],
        "company_basis": "ALL receivables (creante) / net turnover x 365, "
                         "not trade receivables only",
    },
    "inventory_days_on_turnover": {
        "unit": "days",
        "formula": "I3 / I13 x 365",
        "filed_lines": [L_I3, L_I13],
        "company_basis": "inventory / NET TURNOVER x 365. The ratio card's "
                         "DIO divides by operating cost; the two are not "
                         "comparable. Restate the company figure on "
                         "turnover or refuse the comparison",
    },
    "current_asset_share": {
        "unit": "fraction",
        "formula": "I2 / (I1 + I2 + I6)",
        "filed_lines": [L_I2] + _TA,
        "company_basis": "current assets / total assets",
    },
    "revenue_growth": {
        "unit": "fraction",
        "formula": "I13 (year) / I13 (prior year) - 1, joined by CUI, "
                   "prior I13 > 0",
        "filed_lines": [L_I13],
        "company_basis": "net turnover growth year on year",
        "needs_prior_year": True,
    },
}

_NOT_FILED = "the summary-level filing does not publish %s"

#: Ratios REFUSED, with the reason. Never approximated.
REFUSED_RATIOS: Dict[str, Dict[str, str]] = {
    "gross_margin": {"reason": _NOT_FILED % "cost of goods sold"},
    "ebitda_margin": {"reason": _NOT_FILED % "operating result or "
                                             "depreciation"},
    "ebit_margin": {"reason": _NOT_FILED % "operating result"},
    "dpo": {"reason": _NOT_FILED % "trade payables or cost of goods sold"},
    "dio": {"reason": _NOT_FILED % "operating cost; see "
                                   "inventory_days_on_turnover"},
    "ccc": {"reason": _NOT_FILED % "trade payables or cost of goods sold"},
    "interest_coverage": {"reason": _NOT_FILED % "interest expense"},
    "dscr": {"reason": _NOT_FILED % "interest expense or debt service"},
    "net_debt_ebitda": {"reason": _NOT_FILED % "financial debt or EBITDA"},
    "debt_to_equity": {"reason": _NOT_FILED % "financial debt (I7 is total "
                                              "liabilities)"},
    "debt_to_assets": {"reason": _NOT_FILED % "financial debt; see "
                                              "liabilities_to_assets"},
    "current_ratio": {"reason": _NOT_FILED % "current liabilities (I7 is "
                                             "total liabilities)"},
    "quick_ratio": {"reason": _NOT_FILED % "current liabilities"},
    "cash_ratio": {"reason": _NOT_FILED % "current liabilities"},
}


def normalize_caen(caen: Optional[Any]) -> Optional[str]:
    """Four-digit CAEN class. The mass files drop the leading zero
    ("111" is 0111). Anything that is not 1-4 digits is None."""
    text = str(caen).strip() if caen is not None else ""
    if not text.isdigit() or len(text) > 4 or int(text) == 0:
        return None
    return text.zfill(4)


def size_band_key(turnover_ron: Optional[Any]) -> Optional[str]:
    """Band key for a filed turnover, or None when the turnover is
    absent or not positive (a size band is never guessed)."""
    if turnover_ron is None:
        return None
    try:
        value = int(turnover_ron)
    except (TypeError, ValueError):
        return None
    for band in SIZE_BANDS:
        upper = band["max_ron"]
        if value >= band["min_ron"] and (upper is None or value < upper):
            return band["key"]
    return None
