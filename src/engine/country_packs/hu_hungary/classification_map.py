"""HU pack — classification MAPPING DATA for the AI lane's classify
prompts (Act C of 2000 on Accounting / Számviteli törvény chart logic).

This is NOT a deterministic parser and deliberately does NOT touch the
skeleton `chart_of_accounts._RULES` (which stays empty until the pack is
calibrated on real fixtures). It encodes the SZL class structure + the
notable számlatükör accounts as prompt-consumable text so the LLM
classify stage maps Hungarian accounts onto the canonical statement-line
vocabulary with the statutory chart logic in front of it.

Consumed by `engine.ai_lane.classify` — keep additions prompt-oriented
(short, factual, no parsing logic).
"""
from __future__ import annotations

from typing import Dict, Tuple

# Class digit → (Hungarian name, routing guidance). Follows the standard
# számlatükör of Act C of 2000: classes 1-4 are the balance sheet,
# class 5 is costs by nature, classes 6-7 are OPTIONAL internal
# management accounting (cost centres / cost bearers), class 8 is
# expenses, class 9 is revenues, and 0 is off-balance memo.
HU_CLASS_MAP: Dict[str, Tuple[str, str]] = {
    "1": (
        "Befektetett eszközök",
        "non-current assets: intangibles (11x), property/plant/equipment "
        "(12x-14x incl. accumulated depreciation on 129/139/149 credit "
        "side), investments in progress (16x), long-term financial assets "
        "(17x-19x)",
    ),
    "2": (
        "Készletek",
        "inventories: raw materials (21x-22x), work in progress (23x), "
        "finished goods (25x), goods for resale (26x-28x), advances on "
        "inventories ((26)8x/28x per chart)",
    ),
    "3": (
        "Követelések, pénzügyi eszközök és aktív időbeli elhatárolások",
        "current assets: trade receivables (31x), receivables from "
        "employees/other (36x), securities (37x), CASH AND BANK (38x: 381 "
        "pénztár = petty cash, 384 elszámolási betétszámla = bank "
        "account), deferred/accrued assets (39x). 368/466 VAT recoverable "
        "is an asset-side tax receivable.",
    ),
    "4": (
        "Források",
        "equity and liabilities: equity (41x: 411 jegyzett tőke = share "
        "capital, 412 tőketartalék = share premium, 413 eredménytartalék "
        "= retained earnings, 414 lekötött tartalék, 417/419 mérleg "
        "szerinti / adózott eredmény = current-year result), provisions "
        "(42x), subordinated + long-term liabilities (43x-44x), trade "
        "payables (454-455 szállítók), other short-term liabilities "
        "(46x-47x incl. 467 fizetendő áfa = VAT payable, 462 personnel, "
        "463-464 tax authorities), passive accruals (48x), and 49x "
        "technical opening/closing accounts (491 nyitómérleg számla — "
        "CONTROL, exclude from the statement).",
    ),
    "5": (
        "Költségnemek",
        "costs by nature (P&L expense side in a pre-closing TB): material "
        "costs (51x), services (52x-53x), payroll (54x), social "
        "contributions (56x), depreciation (57x), capitalized own "
        "performance offsets (58x), cost reallocations (59x)",
    ),
    "6": (
        "Költséghelyek (opcionális)",
        "OPTIONAL management-accounting cost centres — technical mirror "
        "of class 5; normally excluded as control accounts",
    ),
    "7": (
        "Költségviselők (opcionális)",
        "OPTIONAL management-accounting cost bearers — technical mirror "
        "of class 5; normally excluded as control accounts",
    ),
    "8": (
        "Ráfordítások",
        "expenses: cost of goods sold / own performance (81x-83x when the "
        "entity books by cost-of-sales method), other expenses (86x), "
        "financial expenses (87x), extraordinary/tax items (88x-89x incl. "
        "891 társasági adó = income tax)",
    ),
    "9": (
        "Bevételek",
        "revenues: net sales domestic/export (91x-92x), other operating "
        "income (96x), financial income (97x), extraordinary income (98x)",
    ),
    "0": (
        "Nyilvántartási számlák",
        "off-balance memo accounts — exclude from the statement",
    ),
}

# Notable individual accounts the classify prompt should recognize on
# sight (code → short English gloss).
HU_NOTABLE_ACCOUNTS: Dict[str, str] = {
    "113": "concessions and similar rights (intangible asset)",
    "114": "intellectual property (intangible asset)",
    "123": "buildings (PP&E)",
    "131": "technical machinery and equipment (PP&E)",
    "211": "raw materials (inventory)",
    "251": "finished goods (inventory)",
    "261": "goods for resale (inventory)",
    "311": "domestic trade receivables (vevők)",
    "381": "petty cash (pénztár)",
    "384": "bank current account (elszámolási betétszámla)",
    "411": "share capital (jegyzett tőke)",
    "412": "share premium / capital reserve (tőketartalék)",
    "413": "retained earnings (eredménytartalék)",
    "419": "current-year after-tax result (adózott/mérleg szerinti eredmény)",
    "454": "domestic trade payables (szállítók)",
    "462": "personnel payables",
    "466": "input VAT recoverable (előzetesen felszámított áfa) — asset",
    "467": "output VAT payable (fizetendő áfa) — liability",
    "491": "opening balance sheet account (nyitómérleg) — control, exclude",
    "811": "material-type expenses (anyagjellegű ráfordítások)",
    "911": "net domestic sales revenue (belföldi értékesítés árbevétele)",
}


def classify_prompt_block() -> str:
    """The HU chart-logic block injected into the classify prompt."""
    lines = [
        "HUNGARIAN CHART LOGIC (számlatükör, Act C of 2000). The FIRST "
        "DIGIT of each account code names its class:",
    ]
    for digit in sorted(HU_CLASS_MAP):
        name, guidance = HU_CLASS_MAP[digit]
        lines.append("  class %s — %s: %s" % (digit, name, guidance))
    lines.append("Notable accounts:")
    for code in sorted(HU_NOTABLE_ACCOUNTS):
        lines.append("  %s = %s" % (code, HU_NOTABLE_ACCOUNTS[code]))
    lines.append(
        "Classes 6/7 (management accounting), 49x opening/closing and "
        "class 0 memo accounts must be classified as `excluded_control`."
    )
    return "\n".join(lines)
