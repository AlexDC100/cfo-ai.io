"""Romanian Chart of Accounts (OMFP-1802) → standardized statements.

Direct port of scandi-desk-main/src/lib/trialBalanceParser.ts mapping table.
Takes the LLM's extracted accounts and rolls them up into BS / PL buckets.

Buckets (must match the TS Statements interface so the frontend renders without
remapping):
  Balance sheet:
    cash, ar, inventory, otherCurrentAssets,
    ppe, intangibles, otherNonCurrentAssets,
    ap, stDebt, otherCurrentLiab,
    ltDebt, otherNonCurrentLiab,
    shareCapital, retainedEarnings, otherEquity
  P&L:
    revenue, cogs, operatingExpenses, depreciation,
    interestExpense, otherIncome, financialIncome, financialExpense, taxExpense
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Optional


@dataclass
class MappingRule:
    prefix: str
    bucket: str
    sign: int  # 1 or -1
    description: str


_RULES: List[MappingRule] = [
    # Class 1 — capital & long-term
    MappingRule("1012", "shareCapital", 1, "Capital subscris vărsat"),
    MappingRule("101", "shareCapital", 1, "Capital subscris"),
    MappingRule("104", "otherEquity", 1, "Prime de capital"),
    MappingRule("105", "otherEquity", 1, "Rezerve din reevaluare"),
    MappingRule("1061", "otherEquity", 1, "Rezerve legale"),
    MappingRule("106", "otherEquity", 1, "Rezerve"),
    MappingRule("117", "retainedEarnings", 1, "Rezultatul reportat"),
    MappingRule("121", "retainedEarnings", 1, "Profit/pierdere curentă"),
    MappingRule("129", "retainedEarnings", -1, "Repartizare profit"),
    MappingRule("151", "otherCurrentLiab", 1, "Provizioane"),
    MappingRule("162", "ltDebt", 1, "Credite bancare termen lung"),
    MappingRule("166", "ltDebt", 1, "Datorii financiare TL"),
    MappingRule("167", "ltDebt", 1, "Alte împrumuturi"),
    MappingRule("168", "interestExpense", 1, "Dobânzi de plătit"),
    MappingRule("16", "ltDebt", 1, "Împrumuturi termen lung"),
    # Class 2 — fixed assets
    MappingRule("201", "intangibles", 1, "Cheltuieli de constituire"),
    MappingRule("203", "intangibles", 1, "Cheltuieli de dezvoltare"),
    MappingRule("205", "intangibles", 1, "Concesiuni, brevete"),
    MappingRule("208", "intangibles", 1, "Alte imobilizări necorporale"),
    MappingRule("212", "ppe", 1, "Construcții"),
    MappingRule("213", "ppe", 1, "Echipamente"),
    MappingRule("215", "ppe", 1, "Investiții imobiliare"),
    MappingRule("21", "ppe", 1, "Imobilizări corporale"),
    MappingRule("232", "ppe", 1, "Avansuri imobilizări"),
    MappingRule("23", "ppe", 1, "Imobilizări în curs"),
    MappingRule("267", "otherNonCurrentAssets", 1, "Creanțe imobilizate"),
    MappingRule("26", "otherNonCurrentAssets", 1, "Imobilizări financiare"),
    MappingRule("28", "ppe", -1, "Amortizare imobilizări (contra-asset)"),
    MappingRule("29", "ppe", -1, "Ajustări depreciere imobilizări"),
    # Class 3 — inventory
    MappingRule("371", "inventory", 1, "Mărfuri"),
    MappingRule("345", "inventory", 1, "Produse finite"),
    MappingRule("3", "inventory", 1, "Stocuri"),
    # Class 4 — third parties
    MappingRule("401", "ap", 1, "Furnizori"),
    MappingRule("403", "ap", 1, "Efecte de plătit"),
    MappingRule("404", "ap", 1, "Furnizori imobilizări"),
    MappingRule("408", "ap", 1, "Furnizori facturi nesosite"),
    MappingRule("409", "otherCurrentAssets", 1, "Avansuri către furnizori"),
    MappingRule("4111", "ar", 1, "Clienți"),
    MappingRule("411", "ar", 1, "Clienți"),
    MappingRule("418", "ar", 1, "Clienți facturi de întocmit"),
    MappingRule("419", "otherCurrentLiab", 1, "Avansuri de la clienți"),
    MappingRule("421", "otherCurrentLiab", 1, "Personal salarii"),
    MappingRule("423", "otherCurrentLiab", 1, "Personal ajutoare"),
    MappingRule("425", "otherCurrentLiab", 1, "Avansuri salarii"),
    MappingRule("426", "otherCurrentLiab", 1, "Drepturi neplătite"),
    MappingRule("43", "otherCurrentLiab", 1, "Asigurări sociale"),
    MappingRule("441", "taxExpense", 1, "Impozit pe profit"),
    MappingRule("442", "otherCurrentLiab", 1, "TVA"),
    MappingRule("444", "otherCurrentLiab", 1, "Impozit salarii"),
    MappingRule("446", "otherCurrentLiab", 1, "Alte impozite"),
    MappingRule("448", "otherCurrentLiab", 1, "Alte datorii fiscale"),
    MappingRule("455", "otherCurrentLiab", 1, "Asociați conturi curente"),
    MappingRule("456", "shareCapital", 1, "Decontări acționari"),
    MappingRule("457", "otherCurrentLiab", 1, "Dividende de plată"),
    MappingRule("461", "otherCurrentAssets", 1, "Debitori diverși"),
    MappingRule("462", "otherCurrentLiab", 1, "Creditori diverși"),
    MappingRule("47", "otherCurrentAssets", 1, "Conturi de regularizare active"),
    MappingRule("48", "otherCurrentAssets", 1, "Decontări în cadrul unității"),
    # Class 5 — cash & bank
    MappingRule("509", "stDebt", 1, "Vărsăminte de efectuat"),
    MappingRule("5121", "cash", 1, "Conturi curente bancă RON"),
    MappingRule("5124", "cash", 1, "Conturi curente bancă valută"),
    MappingRule("512", "cash", 1, "Conturi curente la bănci"),
    MappingRule("519", "stDebt", 1, "Credite bancare termen scurt"),
    MappingRule("531", "cash", 1, "Casa"),
    MappingRule("5311", "cash", 1, "Casa în lei"),
    MappingRule("5", "cash", 1, "Trezorerie"),
    # Class 6 — expenses
    MappingRule("601", "cogs", 1, "Cheltuieli cu materii prime"),
    MappingRule("602", "cogs", 1, "Materiale consumabile"),
    MappingRule("60", "cogs", 1, "Cheltuieli cu materii prime"),
    MappingRule("61", "operatingExpenses", 1, "Lucrări terți"),
    MappingRule("628", "operatingExpenses", 1, "Servicii executate de terți"),
    MappingRule("62", "operatingExpenses", 1, "Alte servicii terți"),
    MappingRule("635", "operatingExpenses", 1, "Impozite și taxe"),
    MappingRule("63", "operatingExpenses", 1, "Cheltuieli impozite"),
    MappingRule("641", "operatingExpenses", 1, "Cheltuieli cu salariile"),
    MappingRule("64", "operatingExpenses", 1, "Cheltuieli personal"),
    MappingRule("65", "operatingExpenses", 1, "Alte cheltuieli exploatare"),
    MappingRule("666", "interestExpense", 1, "Dobânzi"),
    MappingRule("665", "financialExpense", 1, "Diferențe de curs"),
    MappingRule("66", "financialExpense", 1, "Cheltuieli financiare"),
    MappingRule("67", "operatingExpenses", 1, "Cheltuieli extraordinare"),
    MappingRule("681", "depreciation", 1, "Cheltuieli amortizări"),
    MappingRule("68", "depreciation", 1, "Cheltuieli amortizări"),
    MappingRule("691", "taxExpense", 1, "Impozit pe profit"),
    MappingRule("69", "taxExpense", 1, "Impozit pe profit"),
    # Class 7 — income
    MappingRule("704", "revenue", 1, "Venituri din lucrări/servicii"),
    MappingRule("706", "revenue", 1, "Venituri redevențe/chirii"),
    MappingRule("707", "revenue", 1, "Venituri din vânzarea mărfurilor"),
    MappingRule("70", "revenue", 1, "Venituri din vânzări"),
    MappingRule("711", "otherIncome", 1, "Variația stocurilor"),
    MappingRule("722", "otherIncome", 1, "Producția imobilizări"),
    MappingRule("74", "otherIncome", 1, "Subvenții"),
    MappingRule("758", "otherIncome", 1, "Alte venituri exploatare"),
    MappingRule("75", "otherIncome", 1, "Alte venituri exploatare"),
    MappingRule("761", "financialIncome", 1, "Venituri din participații"),
    MappingRule("766", "financialIncome", 1, "Venituri din dobânzi"),
    MappingRule("76", "financialIncome", 1, "Venituri financiare"),
]

# Sort longest-prefix-first so most specific wins.
_RULES_SORTED = sorted(_RULES, key=lambda r: -len(r.prefix))


def bucket_for(code: str) -> Optional[MappingRule]:
    for rule in _RULES_SORTED:
        if code.startswith(rule.prefix):
            return rule
    return None


# Empty Statements skeleton matching the TS interface.

def _empty_bs() -> Dict[str, float]:
    return {
        "cash": 0.0, "accountsReceivable": 0.0, "inventory": 0.0, "otherCurrentAssets": 0.0,
        "propertyPlantEquipment": 0.0, "intangibles": 0.0, "otherNonCurrentAssets": 0.0,
        "accountsPayable": 0.0, "shortTermDebt": 0.0, "otherCurrentLiabilities": 0.0,
        "longTermDebt": 0.0, "otherNonCurrentLiabilities": 0.0,
        "shareCapital": 0.0, "retainedEarnings": 0.0, "otherEquity": 0.0,
    }


def _empty_pl() -> Dict[str, float]:
    # Field names mirror the TS IncomeStatement interface so the frontend's
    # computeRatios() can read this dict directly without remapping.
    return {
        "revenue": 0.0, "costOfGoodsSold": 0.0, "operatingExpenses": 0.0,
        "depreciationAmortization": 0.0, "interestExpense": 0.0,
        "otherIncome": 0.0, "financialIncome": 0.0, "financialExpense": 0.0,
        "taxExpense": 0.0,
    }


# Bucket key (TS) → Statements field (TS). Same values both layers.
_BUCKET_TO_BS_FIELD = {
    "cash": "cash",
    "ar": "accountsReceivable",
    "inventory": "inventory",
    "otherCurrentAssets": "otherCurrentAssets",
    "ppe": "propertyPlantEquipment",
    "intangibles": "intangibles",
    "otherNonCurrentAssets": "otherNonCurrentAssets",
    "ap": "accountsPayable",
    "stDebt": "shortTermDebt",
    "otherCurrentLiab": "otherCurrentLiabilities",
    "ltDebt": "longTermDebt",
    "otherNonCurrentLiab": "otherNonCurrentLiabilities",
    "shareCapital": "shareCapital",
    "retainedEarnings": "retainedEarnings",
    "otherEquity": "otherEquity",
}

_BUCKET_TO_PL_FIELD = {
    "revenue": "revenue",
    "cogs": "costOfGoodsSold",
    "operatingExpenses": "operatingExpenses",
    "depreciation": "depreciationAmortization",
    "interestExpense": "interestExpense",
    "otherIncome": "otherIncome",
    "financialIncome": "financialIncome",
    "financialExpense": "financialExpense",
    "taxExpense": "taxExpense",
}


def assemble_statements(
    accounts: List[Dict[str, object]],
    *,
    company_name: str = "Imported entity",
    currency: str = "RON",
    period_label: str = "Imported period",
    industry: Optional[str] = None,
) -> Dict[str, object]:
    """Roll account-level amounts into BS + PL totals.

    Returns a Statements-shaped dict that matches the TS interface so the
    frontend can render it directly without re-mapping.
    """
    bs = _empty_bs()
    pl = _empty_pl()
    line_items: List[Dict[str, object]] = []
    unmapped: List[Dict[str, object]] = []

    for raw in accounts:
        code = str(raw.get("code", "")).strip()
        name = str(raw.get("name", "")).strip()
        try:
            amount = float(raw.get("amount", 0) or 0)
        except (TypeError, ValueError):
            continue
        if not code or amount == 0:
            continue
        rule = bucket_for(code)
        if not rule:
            unmapped.append({"code": code, "name": name, "amount": amount})
            continue
        signed = amount * rule.sign
        if rule.bucket in _BUCKET_TO_BS_FIELD:
            bs[_BUCKET_TO_BS_FIELD[rule.bucket]] += signed
            statement = "BS"
        elif rule.bucket in _BUCKET_TO_PL_FIELD:
            pl[_BUCKET_TO_PL_FIELD[rule.bucket]] += signed
            statement = "PL"
        else:
            continue
        line_items.append({
            "statement": statement,
            "bucket": rule.bucket,
            "ro_account_code": code,
            "ro_account_name": name,
            "amount": signed,
            "is_derived": False,
        })

    # Round to 2 decimal places to keep persisted numbers tidy.
    bs = {k: round(v, 2) for k, v in bs.items()}
    pl = {k: round(v, 2) for k, v in pl.items()}

    statements = {
        "companyName": company_name,
        "industry": industry,
        "currency": currency,
        "periodLabel": period_label,
        "balanceSheet": bs,
        "incomeStatement": pl,
        # Required by the TS Statements interface — computeRatios() reads
        # supplementary.periodDays. Empty defaults are fine; real values would
        # come from a follow-up "enrichment" stage (employee count, lease
        # obligations, market value of property — the user can fill these in
        # via the Settings UI later).
        "supplementary": {
            "periodDays": 365,
        },
    }
    return {
        "statements": statements,
        "lineItems": line_items,
        "unmapped": unmapped,
    }
