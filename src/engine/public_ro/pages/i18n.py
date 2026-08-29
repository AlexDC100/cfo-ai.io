"""RO/EN string dictionaries for the public company pages (lane 3).

Plain dicts, no gettext, no runtime fallback magic: every key MUST exist
in both languages — tests/engine/test_public_pages.py asserts key parity,
so a missing translation is a red test, not a silent English leak.

Wording discipline (mission PS rules):
  - Health flags are FACTUAL ("a raportat capitaluri negative in 2024"),
    never judgments ("risky", "distressed").
  - The equity KPI is CAPITALURI TOTALE (canonical i10) labeled honestly —
    the summary file has NO separate "capitaluri proprii" column.
  - Locked-card copy carries the conversion line verbatim (PS5): it must
    never contain a digit (the render test regexes for that).
"""
from __future__ import annotations

from typing import Dict

STRINGS: Dict[str, Dict[str, str]] = {
    "ro": {
        # header / chrome
        "title_suffix": "analiza financiara",
        "trust_chip": "Date publice MF · nivel sumar",
        "cui_label": "CUI",
        "caen_label": "CAEN",
        "county_label": "Judet",
        "filing_years": "Ani cu raportari",
        "sector_label": "Sector",
        # KPI band
        "kpi_revenue": "Cifra de afaceri neta",
        "kpi_net_result": "Rezultat net",
        "kpi_net_margin": "Marja neta",
        "kpi_equity": "Capitaluri totale",
        "kpi_equity_note": "total capitaluri raportate, nu strict capitaluri proprii",
        "kpi_liabilities": "Datorii",
        "kpi_employees": "Salariati (numar mediu)",
        "kpi_vs": "fata de",
        "kpi_na": "nedisponibil",
        # sections
        "sec_trends": "Evolutie multianuala",
        "sec_health": "Semnale factuale",
        "sec_health_none": "Nicio abatere factuala detectata in seriile raportate.",
        "flag_negative_equity": "A raportat capitaluri totale negative in {year}.",
        "flag_loss_years": (
            "A raportat pierdere neta in {count} ani consecutivi"
            " ({year_from}–{year_to})."
        ),
        "flag_debt_spike": (
            "Datoriile au crescut cu {pct} in {year} fata de anul anterior."
        ),
        "flag_revenue_drop": "Cifra de afaceri a scazut cu {pct} in {year}.",
        "flag_employee_drop": (
            "Numarul mediu de salariati a scazut cu {pct} in {year}."
        ),
        "sec_ratios": "Indicatori calculabili",
        "sec_locked": "Indicatori care necesita balanta completa",
        "sec_position": "Pozitia in sector",
        "sec_narrative": "Pe scurt",
        "sec_cta": "Analiza completa",
        # ratios
        "ratio_net_margin": "Marja neta",
        "ratio_debt_to_capital": "Datorii / Capitaluri totale",
        "ratio_revenue_per_employee": "Cifra de afaceri / salariat",
        # locked ratio labels (NO digits allowed in any of these)
        "locked_ebitda": "Marja EBITDA",
        "locked_current_ratio": "Lichiditate curenta",
        "locked_dso": "Durata medie de incasare (DSO)",
        "locked_dio": "Rotatia stocurilor (DIO)",
        "locked_interest_cover": "Acoperirea dobanzii",
        "locked_ocf": "Cash flow operational",
        "locked_note": (
            "Necesita balanta de verificare completa — incarca o balanta"
            " pentru a debloca."
        ),
        # percentile bars
        "pos_revenue": "Cifra de afaceri",
        "pos_net_result": "Rezultat net",
        "pos_employees": "Salariati",
        "pos_caption": "Percentila estimata in sectorul CAEN, an",
        "pos_pctile": "percentila",
        # CTA
        "cta_headline": "Vrei analiza CFO completa a acestei companii?",
        "cta_body": (
            "Incarca balanta de verificare si primesti bilantul canonic,"
            " indicatorii de lichiditate si raportul complet."
        ),
        "cta_button": "Creeaza cont gratuit",
        "cta_accountant": "Sunt contabil — cere raportul complet",
        # footer
        # Standing label for an operator annotation. Shown ALONE when
        # the operator recorded no note — the page never invents a
        # sentence about the company to fill the box.
        "notice_annotated": "Aceste date sunt contestate de companie.",
        "notice_annotated_src": "Notă operator",
        "footer_takedown": "Solicita corectarea sau eliminarea datelor",
        "footer_generated": "Pagina generata determinist din setul de date",
        # index / search
        "index_title": "Companii din Romania — date financiare publice",
        "search_placeholder": "Cauta dupa nume sau CUI",
        "search_button": "Cauta",
        "search_empty": (
            "Nicio companie gasita. Incearca alt nume sau un CUI exact —"
            " ori incarca o balanta pentru propria companie."
        ),
        "search_invite": (
            "Cauta oricare companie romaneasca dupa nume sau CUI pentru"
            " un sumar financiar din datele publice ale Ministerului"
            " Finantelor."
        ),
        "search_results_for": "Rezultate pentru",
        # errors
        "err_404_title": "Companie negasita",
        "err_404_body": (
            "Nu exista date publice publicabile pentru aceasta adresa."
            " Verifica CUI-ul sau cauta compania dupa nume."
        ),
        "err_410_title": "Date eliminate",
        "err_410_body": (
            "Datele acestei companii au fost eliminate la cerere,"
            " conform procedurii de eliminare."
        ),
        "err_back": "Inapoi la cautare",
        # narrative
        "narr_reported": "a raportat in",
        "narr_revenue_of": "o cifra de afaceri neta de",
        "narr_net_result_of": "si un rezultat net de",
        "narr_employees_with": "cu un numar mediu de",
        "narr_employees_word": "salariati",
        "narr_source": (
            "Datele provin din situatiile financiare anuale publicate de"
            " Ministerul Finantelor pe data.gov.ro — nivel sumar, nu"
            " balanta completa."
        ),
        "meta_desc_prefix": "Date financiare publice pentru",
    },
    "en": {
        "title_suffix": "financial analysis",
        "trust_chip": "MF public data · summary level",
        "cui_label": "CUI",
        "caen_label": "CAEN",
        "county_label": "County",
        "filing_years": "Years on record",
        "sector_label": "Sector",
        "kpi_revenue": "Net turnover",
        "kpi_net_result": "Net result",
        "kpi_net_margin": "Net margin",
        "kpi_equity": "Total capital",
        "kpi_equity_note": "total reported capital, not strictly shareholders' equity",
        "kpi_liabilities": "Liabilities",
        "kpi_employees": "Employees (average)",
        "kpi_vs": "vs",
        "kpi_na": "not available",
        "sec_trends": "Multi-year trend",
        "sec_health": "Factual signals",
        "sec_health_none": "No factual deviations detected in the reported series.",
        "flag_negative_equity": "Reported negative total capital in {year}.",
        "flag_loss_years": (
            "Reported a net loss in {count} consecutive years"
            " ({year_from}–{year_to})."
        ),
        "flag_debt_spike": (
            "Liabilities increased by {pct} in {year} versus the prior year."
        ),
        "flag_revenue_drop": "Net turnover fell by {pct} in {year}.",
        "flag_employee_drop": (
            "The average employee count fell by {pct} in {year}."
        ),
        "sec_ratios": "Computable ratios",
        "sec_locked": "Ratios that require the full trial balance",
        "sec_position": "Sector position",
        "sec_narrative": "At a glance",
        "sec_cta": "Full analysis",
        "ratio_net_margin": "Net margin",
        "ratio_debt_to_capital": "Liabilities / Total capital",
        "ratio_revenue_per_employee": "Revenue per employee",
        "locked_ebitda": "EBITDA margin",
        "locked_current_ratio": "Current ratio",
        "locked_dso": "Days sales outstanding (DSO)",
        "locked_dio": "Days inventory outstanding (DIO)",
        "locked_interest_cover": "Interest coverage",
        "locked_ocf": "Operating cash flow",
        "locked_note": (
            "Requires the full trial balance — upload one to unlock."
        ),
        "pos_revenue": "Net turnover",
        "pos_net_result": "Net result",
        "pos_employees": "Employees",
        "pos_caption": "Estimated percentile within the CAEN sector, year",
        "pos_pctile": "percentile",
        "cta_headline": "Want the full CFO-grade analysis of this company?",
        "cta_body": (
            "Upload the trial balance to get the canonical balance sheet,"
            " liquidity ratios and the full report."
        ),
        "cta_button": "Create a free account",
        "cta_accountant": "I'm an accountant — request the full report",
        "notice_annotated": "This data is disputed by the company.",
        "notice_annotated_src": "Operator note",
        "footer_takedown": "Request a correction or removal of this data",
        "footer_generated": "Page rendered deterministically from dataset",
        "index_title": "Romanian companies — public financial data",
        "search_placeholder": "Search by name or CUI",
        "search_button": "Search",
        "search_empty": (
            "No company found. Try another name or an exact CUI — or"
            " upload a trial balance for your own company."
        ),
        "search_invite": (
            "Search any Romanian company by name or CUI for a financial"
            " summary built from the Ministry of Finance open data."
        ),
        "search_results_for": "Results for",
        "err_404_title": "Company not found",
        "err_404_body": (
            "There is no publishable public data at this address."
            " Check the CUI or search the company by name."
        ),
        "err_410_title": "Data removed",
        "err_410_body": (
            "This company's data has been removed on request, per the"
            " takedown procedure."
        ),
        "err_back": "Back to search",
        "narr_reported": "reported in",
        "narr_revenue_of": "net turnover of",
        "narr_net_result_of": "and a net result of",
        "narr_employees_with": "with an average of",
        "narr_employees_word": "employees",
        "narr_source": (
            "Data comes from the annual financial statements published by"
            " the Romanian Ministry of Finance on data.gov.ro — summary"
            " level, not a full trial balance."
        ),
        "meta_desc_prefix": "Public financial data for",
    },
}

LANGS = ("ro", "en")


def t(lang: str, key: str) -> str:
    """Strict lookup — KeyError over silent fallback (parity is tested)."""
    return STRINGS[lang][key]
