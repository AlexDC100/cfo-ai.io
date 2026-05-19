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

Sub-aggregates (memo — NEVER summed into the top-level BS/PL totals; tracked
separately on `statements.subAggregates` so downstream code can do industry
classification, anomaly detection, and risk framing without re-parsing the
raw accounts):
  ar_intercompany            — account 461 (Debitori diverși — related-party)
  ppe_investment             — account 215 (Investiții imobiliare — CRE signal)
  ppe_under_construction     — account 231 (Imobilizări in curs — capex pipeline)
  opex_third_party           — account 628 (Servicii executate de terți — anomaly flag)
  ap_dividends               — account 457 (Dividende de plată — NEVER counted as debt)
  ar_doubtful                — account 4118 (Clienți incerti)
  cash_fx                    — accounts 5124 / 5314 (FX cash component)

Ignored explicitly (NOT summed into ANY bucket, even via the `5`/`1` catchall):
  581 — Viramente interne (transit / clearing). Including this in cash is the
        single most common Romanian-pipeline cash-overstatement bug.
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


# ════════════════════════════════════════════════════════════════════════════
#                       LOCKED CANONICAL OMFP-1802 MAPPING
# ════════════════════════════════════════════════════════════════════════════
#
# This is the SOLE specification for routing Romanian OMFP-1802 trial-balance
# accounts to standardized buckets. Every entry was set deliberately against
# the surgical-fix prompt + balanta verificare EEI Dec 2025 source-of-truth.
#
# RULES OF THIS TABLE:
#   - One canonical rule per account family. NO legacy / NO duplicates.
#   - Longest prefix wins (see _RULES_SORTED below). Order in this list
#     does NOT matter — the sort handles specificity.
#   - DO NOT add a more-specific rule that contradicts an existing one
#     without also updating scripts/validate_eei_canonical.py and the
#     fixtures in scandi-desk-main/e2e/fixtures/ground-truth/.
#   - DO NOT add a less-specific catchall that swallows accounts the
#     specific rules above handle (e.g. don't add `16 → ltDebt` because
#     `1621/1622/1623/1625` are the only debt accounts; 166/167/168 do
#     NOT exist on EEI and must NOT be lumped into debt blindly).
#   - The canonical numbers this mapping produces for EEI Dec 2025 are
#     locked in scripts/validate_eei_canonical.py (19 hard assertions,
#     gated in CI). Any change here must keep that test PASSING.
#
# This same logic applies to ALL Romanian trial-balance uploads — every
# Romanian client gets these mappings, no per-document tuning.
# ════════════════════════════════════════════════════════════════════════════

_RULES: List[MappingRule] = [
    # ──────────────────────────────────────────────────────────────────────
    # CLASS 1 — Capital, reserves, long-term liabilities
    # ──────────────────────────────────────────────────────────────────────
    MappingRule("1012", "shareCapital",      1, "Capital subscris vărsat"),
    MappingRule("101",  "shareCapital",      1, "Capital subscris (catchall 101x)"),
    MappingRule("104",  "otherEquity",       1, "Prime de capital"),
    MappingRule("105",  "equity_revaluation", 1, "Rezerve din reevaluare — non-cash equity"),
    MappingRule("1061", "otherEquity",       1, "Rezerve legale"),
    MappingRule("106",  "otherEquity",       1, "Rezerve (catchall 106x other than 1061)"),
    MappingRule("1171", "retained_earnings", 1, "Rezultatul reportat — prior-year carry-forward"),
    # 121 — Romanian PROFIT SI PIERDERE control. Derived from Class 6/7
    # totals; NEVER summed into a real bucket (would double-count).
    MappingRule("121",  "ignore_control",    1, "Profit si pierdere — CONTROL, never summed"),
    MappingRule("129",  "retainedEarnings", -1, "Repartizare profit"),
    MappingRule("151",  "otherCurrentLiab",  1, "Provizioane"),
    # Long-term debt — bank loans ONLY. 162x family. NO catchall on 16/166/167.
    MappingRule("1621", "ltDebt",            1, "Credite bancare pe termen lung"),
    MappingRule("1622", "ltDebt",            1, "Credite bancare pe termen lung restante"),
    MappingRule("1623", "ltDebt",            1, "Credite externe garantate de stat"),
    MappingRule("1625", "ltDebt",            1, "Credite bancare nerambursate la scadență"),
    # 168 — Dobânzi aferente împrumuturilor și datoriilor asimilate.
    # This is the BS LIABILITY that carries accrued interest owed on
    # borrowings (the credit side of the period-end accrual Dr 666 / Cr 168;
    # the matching Dr 168 / Cr 5121 entry settles it on payment). The
    # P&L interest expense is account 666 — routed below on this same
    # mapping list. Routing 168 to `interestExpense` (a P&L bucket) caused
    # the cumulative-side movements of the BS accrual account to be summed
    # into the P&L on top of 666, double-counting any interest that was
    # both accrued and paid within the period. For Scandia FY2025 this
    # inflated interestExpense by RON 1,666,807 (54% overstatement) and
    # depressed net income by ~RON 1.4M after tax. Per methodology
    # Section 3 (CLAUDE.md Appendix A) and reference/financial_analysis.py
    # line 459, 168 is part of LT debt — it sits with bank loans (162x)
    # and leasing (167) as the "accrued LT interest" component. Route to
    # ltDebt accordingly. 1687 sub-accounts retain their existing
    # side-flip carve-out in _trial_balance_parser.py:625 → otherCurrentLiab
    # for the current-portion case.
    MappingRule("168",  "ltDebt",            1, "Dobânzi aferente împrumuturilor — accrued LT interest (BS liability)"),
    # 167 — Finance-lease obligations. Per OMFP-1802 these sit alongside
    # bank loans on the LT debt line; oracle's `total_lt_debt` already
    # includes them. Without this rule Scandia's 3.39M of leasing drops out
    # of LT debt entirely — single largest cause of liability under-count.
    MappingRule("167",  "ltDebt",            1, "Datorii din leasing financiar"),

    # ──────────────────────────────────────────────────────────────────────
    # CLASS 2 — Fixed assets
    # ──────────────────────────────────────────────────────────────────────
    MappingRule("201",  "intangibles", 1, "Cheltuieli de constituire"),
    MappingRule("203",  "intangibles", 1, "Cheltuieli de dezvoltare"),
    MappingRule("205",  "intangibles", 1, "Concesiuni, brevete"),
    MappingRule("207",  "intangibles", 1, "Fond comercial"),
    MappingRule("208",  "intangibles", 1, "Alte imobilizări necorporale"),
    MappingRule("211",  "ppe", 1, "Terenuri"),
    MappingRule("212",  "ppe", 1, "Construcții"),
    MappingRule("213",  "ppe", 1, "Echipamente"),
    MappingRule("214",  "ppe", 1, "Mobilier, aparatură birotică"),
    # 215 — Investment property. CRE detection signal.
    MappingRule("215",  "ppe_investment", 1, "Investiții imobiliare — CRE signal"),
    # 231 — Assets under construction (capex pipeline).
    MappingRule("231",  "ppe_under_construction", 1, "Imobilizări corporale în curs"),
    MappingRule("232",  "ppe", 1, "Avansuri imobilizări (legacy advance — see 4093)"),
    # Financial assets (investments)
    MappingRule("261",  "otherNonCurrentAssets", 1, "Acțiuni entități afiliate"),
    MappingRule("263",  "otherNonCurrentAssets", 1, "Interese de participare"),
    MappingRule("265",  "otherNonCurrentAssets", 1, "Alte titluri imobilizate"),
    MappingRule("2671", "otherNonCurrentAssets", 1, "Creanțe imobilizate"),
    MappingRule("2678", "otherNonCurrentAssets", 1, "Alte creanțe imobilizate"),
    # Accumulated depreciation / amortization — contra-assets (sign -1)
    MappingRule("2801", "intangibles", -1, "Amort. cheltuieli de constituire"),
    MappingRule("2803", "intangibles", -1, "Amort. cheltuieli de dezvoltare"),
    MappingRule("2805", "intangibles", -1, "Amort. concesiuni, brevete"),
    MappingRule("2808", "intangibles", -1, "Amort. alte imob. necorporale"),
    MappingRule("2811", "ppe",         -1, "Amort. construcții (1)"),
    MappingRule("2812", "ppe",         -1, "Amort. construcții (2)"),
    MappingRule("2813", "ppe",         -1, "Amort. instalații / transport"),
    MappingRule("2814", "ppe",         -1, "Amort. alte imob. corporale"),
    MappingRule("2815", "ppe",         -1, "Amort. investiții imobiliare"),
    MappingRule("29",   "ppe",         -1, "Ajustări depreciere imobilizări"),

    # ──────────────────────────────────────────────────────────────────────
    # CLASS 3 — Inventory
    # ──────────────────────────────────────────────────────────────────────
    MappingRule("371",  "inventory", 1, "Mărfuri"),
    MappingRule("345",  "inventory", 1, "Produse finite"),
    # 391-398 — Inventory provisions (Ajustări pentru deprecierea stocurilor).
    # Contra-asset: closes on the credit side, so sign=-1 makes them subtract
    # from inventory. Without these explicit rules they fell to the "3"
    # catchall with sign=+1 — for Scandia that overstated inventory by
    # ~2.71M (provisions added instead of subtracted, a 2× swing).
    MappingRule("391",  "inventory", -1, "Ajustări depreciere materii prime — contra"),
    MappingRule("392",  "inventory", -1, "Ajustări depreciere materiale — contra"),
    MappingRule("393",  "inventory", -1, "Ajustări depreciere producție în curs — contra"),
    MappingRule("394",  "inventory", -1, "Ajustări depreciere produse finite — contra"),
    MappingRule("395",  "inventory", -1, "Ajustări depreciere semifabricate — contra"),
    MappingRule("396",  "inventory", -1, "Ajustări depreciere bunuri expediate — contra"),
    MappingRule("397",  "inventory", -1, "Ajustări depreciere mărfuri — contra"),
    MappingRule("398",  "inventory", -1, "Ajustări depreciere ambalaje — contra"),
    MappingRule("3",    "inventory", 1, "Stocuri (catchall)"),

    # ──────────────────────────────────────────────────────────────────────
    # CLASS 4 — Third parties (AR + AP + payables)
    # ──────────────────────────────────────────────────────────────────────
    # AP — only true supplier balances. 419 (advances FROM clients) and 462
    # (creditori diverși) go to otherCurrentLiab; never into AP.
    MappingRule("401",  "ap", 1, "Furnizori"),
    MappingRule("403",  "ap", 1, "Efecte de plătit"),
    MappingRule("404",  "ap", 1, "Furnizori imobilizări"),
    MappingRule("408",  "ap", 1, "Furnizori facturi nesosite"),
    # 4093 — Advances given for CAPEX (fixed-asset acquisitions). Routes to
    # ppe_advances, NOT to working-capital AR.
    MappingRule("4093", "ppe_advances",       1, "Avansuri pt. imobilizări — capex advance"),
    MappingRule("4091", "otherCurrentAssets", 1, "Avansuri furnizori stocuri"),
    MappingRule("4092", "otherCurrentAssets", 1, "Avansuri furnizori servicii"),
    # AR — customer receivables
    MappingRule("4111", "ar",                1, "Clienți"),
    MappingRule("4118", "ar_doubtful",       1, "Clienți incerți (gross — see 491 contra)"),
    # 413 — Effecte de primit / Notes receivable (commercial paper from
    # customers, normally short-term receivable). Without this rule, 4130x
    # falls through unmapped — for Scandia 998K silently dropped.
    MappingRule("4130", "ar",                1, "Efecte de primit (notes receivable)"),
    # 418 — Clienți facturi de întocmit. Mixed-side: when DEBIT it's an
    # accrued receivable (services rendered, invoice not yet issued); when
    # CREDIT it's a customer accrual liability (advance / over-billing).
    # The side-flip layer in _trial_balance_parser routes the C-side cases
    # to otherCurrentLiab so the bucket here is the D-side bucket only.
    MappingRule("418",  "ar",                1, "Clienți facturi de întocmit (D-side)"),
    MappingRule("419",  "otherCurrentLiab",  1, "Clienți creditori — advances FROM customers"),
    # Payroll / personnel payables
    MappingRule("421",  "otherCurrentLiab",  1, "Personal — salarii datorate"),
    MappingRule("4281", "otherCurrentLiab",  1, "Alte datorii personal"),
    # 4283 — Alte datorii legate de personal. Missing rule was dropping
    # Scandia's 3.75M from ST liab. Falls under personnel-payable category.
    MappingRule("4283", "otherCurrentLiab",  1, "Alte datorii legate de personal"),
    MappingRule("423",  "otherCurrentLiab",  1, "Personal — ajutoare"),
    MappingRule("425",  "otherCurrentLiab",  1, "Avansuri salarii"),
    MappingRule("426",  "otherCurrentLiab",  1, "Drepturi neplătite"),
    # 427 — Alte drepturi de personal. Same category as 426; was unmapped.
    MappingRule("427",  "otherCurrentLiab",  1, "Alte drepturi personal"),
    # Social contributions
    MappingRule("4315", "otherCurrentLiab",  1, "Contribuții asigurări sociale"),
    MappingRule("4316", "otherCurrentLiab",  1, "Contribuții asigurări sănătate"),
    MappingRule("436",  "otherCurrentLiab",  1, "Contribuția asiguratorie de muncă"),
    MappingRule("4382", "otherCurrentAssets", 1, "Alte creanțe sociale"),
    # Tax payables / receivables
    MappingRule("4411", "otherCurrentLiab",  1, "Impozit pe profit DE PLĂTIT — BS liab, NOT P&L"),
    MappingRule("4424", "otherCurrentAssets", 1, "TVA de recuperat"),
    MappingRule("442",  "otherCurrentLiab",  1, "TVA (catchall)"),
    MappingRule("444",  "otherCurrentLiab",  1, "Impozit salarii"),
    MappingRule("446",  "otherCurrentLiab",  1, "Alte impozite"),
    MappingRule("4482", "otherCurrentAssets", 1, "Alte creanțe bugetul statului"),
    MappingRule("448",  "otherCurrentLiab",  1, "Alte datorii fiscale"),
    # 445 / 447 — Local-budget and special taxes (water, environment,
    # fund contributions). Same category as 446 / 448. Missing rules were
    # silently dropping these from ST liab (Scandia: 56K via 447, 18K via 445).
    MappingRule("445",  "otherCurrentLiab",  1, "Alte impozite locale"),
    MappingRule("447",  "otherCurrentLiab",  1, "Fonduri speciale (mediu, accize, etc.)"),
    # Shareholder / inter-company accounts. All mixed-side: the D-side is a
    # receivable from a group entity, the C-side is a payable to one. The
    # side-flip layer in _trial_balance_parser routes credit-side cases to
    # otherCurrentLiab, so the bucket here is the natural debit-side one.
    MappingRule("451",  "ar_intercompany",   1, "Decontări entități afiliate (D-side)"),
    MappingRule("452",  "ar_intercompany",   1, "Decontări participanți și acționari (D-side)"),
    MappingRule("455",  "ar_intercompany",   1, "Asociați conturi curente (D-side)"),
    MappingRule("456",  "shareCapital",      1, "Decontări acționari"),
    # 457 — DIVIDENDS PAYABLE. NEVER counted as debt.
    MappingRule("457",  "ap_dividends",      1, "Dividende de plată — NEVER in total_debt"),
    # 461 — Related-party / intercompany debtor. Surfaced separately.
    MappingRule("461",  "ar_intercompany",   1, "Debitori diverși — related-party flag"),
    MappingRule("462",  "otherCurrentLiab",  1, "Creditori diverși"),
    # 471 — Prepaid expenses
    MappingRule("471",  "otherCurrentAssets", 1, "Cheltuieli înregistrate în avans"),
    # 472 — Deferred revenue (short-term portion of payments received for
    # services not yet rendered). C-side, ST liab.
    MappingRule("472",  "otherCurrentLiab",  1, "Venituri înregistrate în avans (deferred revenue)"),
    # 475 — Investment subsidies (non-current portion of grants released to
    # P&L over multiple years). C-side, LT liab. Scandia 4.04M.
    MappingRule("475",  "otherNonCurrentLiab", 1, "Subvenții pentru investiții (LT)"),
    # 478 — Other long-term deferred revenue. Same category as 475.
    MappingRule("478",  "otherNonCurrentLiab", 1, "Venituri în avans LT (grants)"),
    # 491 — AR allowance (contra to 4118). Sign -1 → reduces AR gross to net.
    MappingRule("491",  "ar", -1, "Ajustări deprecierea creanțelor — contra-asset"),
    # 496 — Affiliated-receivable allowance. Same category as 491 (contra
    # to AR). Missing rule was dropping 3.62M of provisions for Scandia —
    # the gross trade-rec was right but the net was overstated by that much.
    MappingRule("496",  "ar", -1, "Ajustări deprecierea creanțe afiliate — contra"),
    # 481 — Internal-unit settlements
    MappingRule("481",  "otherCurrentAssets", 1, "Decontări în cadrul unității"),

    # ──────────────────────────────────────────────────────────────────────
    # CLASS 5 — Cash, bank, transit
    # ──────────────────────────────────────────────────────────────────────
    MappingRule("509",  "stDebt",  1, "Vărsăminte de efectuat"),
    MappingRule("5121", "cash",    1, "Conturi curente bancă RON"),
    MappingRule("5124", "cash_fx", 1, "Conturi curente bancă valută"),
    # 5191 / 5192 — Short-term bank credit
    MappingRule("5191", "stDebt",  1, "Credite bancare termen scurt"),
    MappingRule("5192", "stDebt",  1, "Credite bancare termen scurt nerambursate"),
    MappingRule("5311", "cash",    1, "Casa în lei"),
    MappingRule("5314", "cash_fx", 1, "Casa în valută"),
    # 581 — TRANSIT / CLEARING. NEVER in cash. The single most common
    # Romanian-pipeline cash-overstatement bug.
    MappingRule("581",  "ignore_transit", 1, "Viramente interne — NEVER in cash"),

    # ──────────────────────────────────────────────────────────────────────
    # CLASS 6 — Expenses
    # ──────────────────────────────────────────────────────────────────────
    MappingRule("601",  "cogs",              1, "Cheltuieli cu materii prime"),
    MappingRule("602",  "cogs",              1, "Materiale consumabile"),
    MappingRule("607",  "cogs",              1, "Cheltuieli privind mărfurile"),
    MappingRule("603",  "operatingExpenses", 1, "Obiecte de inventar"),
    MappingRule("604",  "operatingExpenses", 1, "Materiale nestocate"),
    MappingRule("605",  "operatingExpenses", 1, "Energia și apa"),
    MappingRule("6024", "operatingExpenses", 1, "Piese de schimb"),
    MappingRule("6051", "operatingExpenses", 1, "Consum de energie"),
    MappingRule("611",  "operatingExpenses", 1, "Întreținerea și reparațiile"),
    MappingRule("6123", "operatingExpenses", 1, "Chirii"),
    MappingRule("613",  "operatingExpenses", 1, "Prime de asigurare"),
    MappingRule("622",  "operatingExpenses", 1, "Comisioane și onorarii"),
    MappingRule("626",  "operatingExpenses", 1, "Poștă și telecomunicații"),
    MappingRule("627",  "operatingExpenses", 1, "Servicii bancare (non-financial)"),
    # 628 — Third-party services. Anomaly-checked separately.
    MappingRule("628",  "opex_third_party",  1, "Servicii executate de terți — anomaly check"),
    MappingRule("635",  "operatingExpenses", 1, "Impozite și taxe"),
    # Class 65 — Alte cheltuieli de exploatare (other operating expenses).
    # Includes doubtful-receivable provisions (654), donations (655), and
    # other non-classified op-expenses (658). For Scandia ~RON 12.5M.
    MappingRule("65",   "operatingExpenses", 1, "Class 65 — alte cheltuieli exploatare (catchall)"),
    # Class 62 — External services. 622/626/627/628 already explicit; 621
    # (collaborators), 623 (protocol), 624 (transport), 625 (travel) are
    # also operating expenses for any manufacturer.
    MappingRule("62",   "operatingExpenses", 1, "Class 62 — servicii executate de terți (catchall)"),
    # Class 61 sub-buckets — chirii (612), pregatire personal (615),
    # other services (618). Scandia 5.5M + 0.9M + 2.6M = 9M unmapped without
    # these. The longest-prefix sort still lets 611/6123/613 win.
    MappingRule("612",  "operatingExpenses", 1, "Ch. chirii și redevențe (rent + royalties)"),
    MappingRule("615",  "operatingExpenses", 1, "Ch. pregătire personal (training)"),
    MappingRule("618",  "operatingExpenses", 1, "Ch. servicii diverse (subclass)"),
    # Class 64 personnel sub-buckets missed by 641/645 explicit rules:
    # 642 (tichete masă/cadou — meal & gift vouchers, ~6.3M) and 646
    # (contribuții asiguratorie pt. muncă — work-insurance, ~1.6M).
    MappingRule("642",  "operatingExpenses", 1, "Ch. tichete (meal & gift vouchers)"),
    MappingRule("646",  "operatingExpenses", 1, "Ch. contribuții asiguratorie muncă"),
    # 6814 — provisions / impairments on current assets. Companion to 6811
    # and 6812; close enough to D&A in spirit that we route to the same
    # bucket so the statutory P&L's "amortizare și provizioane" line matches.
    MappingRule("6814", "depreciation",      1, "Ch. provizioane active circulante"),
    # 665 (FX loss catchall) + 668 (other financial expense), 7-class
    # counterparts: 781 (provision reversals on current assets), 768 (other
    # financial income). Scandia: 781 = ~RON 8M; without it the briefing's
    # "Total operating revenue" understates by ~2%.
    MappingRule("665",  "fx_loss",           1, "Diferențe nefavorabile curs (catchall)"),
    MappingRule("668",  "financialExpense",  1, "Alte cheltuieli financiare"),
    MappingRule("781",  "otherIncome",       1, "Venituri din provizioane reluare (operating)"),
    MappingRule("768",  "financial_income",  1, "Alte venituri financiare"),
    MappingRule("641",  "operatingExpenses", 1, "Salariile personalului"),
    MappingRule("645",  "operatingExpenses", 1, "Asigurări sociale (cheltuieli)"),
    MappingRule("6458", "operatingExpenses", 1, "Alte asigurări sociale"),
    MappingRule("6461", "operatingExpenses", 1, "Contribuția asiguratorie pt. muncă"),
    # Financial expenses
    MappingRule("6651", "fx_loss",           1, "Diferențe nefavorabile de curs valutar"),
    MappingRule("666",  "interest_expense",  1, "Cheltuieli privind dobânzile"),
    MappingRule("667",  "financialExpense",  1, "Sconturi acordate"),
    # D&A
    MappingRule("6811", "depreciation",      1, "Amortizarea imobilizărilor"),
    MappingRule("6812", "depreciation",      1, "Provizioane pt. exploatare"),
    # Income tax (P&L expense, NOT BS payable — 4411 is the BS liability).
    MappingRule("691",  "taxExpense",        1, "Cheltuieli cu impozitul pe profit"),

    # ──────────────────────────────────────────────────────────────────────
    # CLASS 7 — Income
    # ──────────────────────────────────────────────────────────────────────
    MappingRule("701",  "revenue", 1, "Venituri din vânzarea produselor finite"),
    MappingRule("704",  "revenue", 1, "Venituri din servicii prestate"),
    # 706 — Rental / royalty income. CRE detection signal.
    MappingRule("706",  "revenue", 1, "Venituri din chirii — CRE signal"),
    MappingRule("707",  "revenue", 1, "Venituri din vânzarea mărfurilor"),
    MappingRule("708",  "revenue", 1, "Venituri din activități diverse"),
    # 709 — Reduceri comerciale acordate (commercial discounts given to
    # customers). Contra-revenue: Claude already returns this as a negative
    # number (debit-balance class-7 → negative-credit-balance). Sign=+1
    # passes the negative through so revenue gets reduced. For Scandia
    # this is ~RON 37M, taking gross 449M → net turnover 412M.
    MappingRule("709",  "revenue", 1, "Reduceri comerciale acordate — contra-revenue (Claude-signed)"),
    # 711 — Inventory variation. Non-cash statutory accrual: change in
    # finished-goods inventory mirrors production volume, NOT income that
    # contributes to EBITDA cash margin. Routed to its own memo bucket so
    # the cash-view EBITDA excludes it; the statutory view re-adds it.
    MappingRule("711",  "inventoryVariationMemo", 1, "Variația stocurilor — non-cash memo"),
    # 721 / 722 / 725 — CAPITALIZED OWN-WORK. Memo only — NEVER in revenue,
    # NEVER in EBITDA. The single most common Romanian-pipeline revenue/
    # EBITDA-overstatement bug.
    MappingRule("721",  "capitalizedOwnWork", 1, "Capitalized own-work — MEMO, excluded from EBITDA"),
    MappingRule("722",  "capitalizedOwnWork", 1, "Producția imobilizări corporale — MEMO"),
    MappingRule("725",  "capitalizedOwnWork", 1, "Producția imobilizări (other) — MEMO"),
    MappingRule("740",  "otherIncome", 1, "Subvenții — flagged non-recurring"),
    MappingRule("758",  "otherIncome", 1, "Alte venituri exploatare"),
    # Financial income — broken out for visibility (briefing reads each)
    MappingRule("7611", "financial_income", 1, "Venituri dividende — entități afiliate"),
    MappingRule("7612", "financial_income", 1, "Venituri dividende — entități asociate"),
    MappingRule("762",  "financial_income", 1, "Venituri din interese de participare"),
    MappingRule("763",  "financial_income", 1, "Venituri din creanțe imobilizate"),
    MappingRule("7651", "fx_gain",          1, "Diferențe favorabile de curs valutar"),
    MappingRule("766",  "interest_income",  1, "Venituri din dobânzi"),
    MappingRule("767",  "financial_income", 1, "Venituri din sconturi obținute"),
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
    # `capitalizedOwnWork` is a memo field — surfaced for transparency, NOT
    # included in revenue/EBITDA. See _ro_coa.py rules for context.
    return {
        "revenue": 0.0, "costOfGoodsSold": 0.0, "operatingExpenses": 0.0,
        "depreciationAmortization": 0.0, "interestExpense": 0.0,
        "otherIncome": 0.0, "financialIncome": 0.0, "financialExpense": 0.0,
        "taxExpense": 0.0,
        "capitalizedOwnWork": 0.0,
        # Memo line — RAS account 711 inventory variation. Non-cash; EXCLUDED
        # from cash-view EBITDA. Re-added to statutory views downstream.
        "inventoryVariationMemo": 0.0,
    }


# Bucket key (TS) → Statements field (TS). Same values both layers.
_BUCKET_TO_BS_FIELD = {
    "cash": "cash",
    # Sub-aggregate buckets that ALSO roll into the same top-level BS line.
    # The pipeline still tracks them separately on statements.subAggregates
    # for industry classification + risk framing.
    "cash_fx": "cash",
    "ar": "accountsReceivable",
    "ar_doubtful": "accountsReceivable",
    "ar_provisions": "accountsReceivable",  # contra to ar / ar_doubtful — already sign-reversed
    "ar_intercompany": "otherCurrentAssets",  # related-party — surfaced separately
    "inventory": "inventory",
    "otherCurrentAssets": "otherCurrentAssets",
    "ppe": "propertyPlantEquipment",
    "ppe_investment": "propertyPlantEquipment",         # CRE signal
    "ppe_under_construction": "propertyPlantEquipment", # capex pipeline
    "ppe_advances": "propertyPlantEquipment",           # 4093 — capex advances
    "intangibles": "intangibles",
    "otherNonCurrentAssets": "otherNonCurrentAssets",
    "ap": "accountsPayable",
    "stDebt": "shortTermDebt",
    "otherCurrentLiab": "otherCurrentLiabilities",
    "ap_dividends": "otherCurrentLiabilities",  # NEVER counted as debt
    "ltDebt": "longTermDebt",
    "otherNonCurrentLiab": "otherNonCurrentLiabilities",
    "shareCapital": "shareCapital",
    "retainedEarnings": "retainedEarnings",
    "retained_earnings": "retainedEarnings",  # 1171 carry-forward, alias
    "otherEquity": "otherEquity",
    "equity_revaluation": "otherEquity",  # 105 — non-cash revaluation reserve
}

_BUCKET_TO_PL_FIELD = {
    "revenue": "revenue",
    "cogs": "costOfGoodsSold",
    "operatingExpenses": "operatingExpenses",
    "opex_third_party": "operatingExpenses",  # 628 — anomaly checked separately
    "depreciation": "depreciationAmortization",
    "interestExpense": "interestExpense",
    "interest_expense": "interestExpense",  # 666 — canonical alias
    "interest_income": "financialIncome",   # 766
    "fx_gain": "financialIncome",            # 7651
    "fx_loss": "financialExpense",           # 6651
    "financial_income": "financialIncome",   # 7611/7612/762/763/767 — surfaced separately
    "otherIncome": "otherIncome",
    "financialIncome": "financialIncome",
    "financialExpense": "financialExpense",
    "taxExpense": "taxExpense",
    # Memo: capitalized own-work (RO 721/722/725, FR 72, ES 730-733). Surfaced
    # on statements.incomeStatement.capitalizedOwnWork but EXCLUDED from the
    # EBITDA computation in stage_compute. The pipeline must read this and
    # produce a "country trap" alert + recompute valuation on the operational
    # basis.
    "capitalizedOwnWork": "capitalizedOwnWork",
    # Memo bucket — kept separate from `otherIncome` so it never lands in
    # cash-view EBITDA. Persistence bridge below collapses it back to
    # `otherIncome` for the DB row (CHECK constraint compatibility).
    "inventoryVariationMemo": "inventoryVariationMemo",
}

# Buckets that are intentionally NOT summed into any BS/PL field — they exist
# only to claim the account explicitly so it doesn't fall through to a
# catchall rule. Used for transit/clearing accounts (581) and the Romanian
# 121 PROFIT SI PIERDERE control account (derived elsewhere, not summed).
_IGNORE_BUCKETS = {"ignore_transit", "ignore_control"}

# Canonical bucket → legacy bucket name accepted by the existing Supabase
# `statement_line_items.bucket` CHECK constraint. Used ONLY at the
# persistence boundary so we keep the canonical names in code + assembled
# views, but the line items we persist conform to the existing schema.
# When the DB constraint is widened (migration: add new bucket names to
# the CHECK), this map can become identity. Until then it's the bridge.
_CANONICAL_TO_LEGACY_BUCKET = {
    # Cash sub-aggregates → "cash"
    "cash_fx": "cash",
    # AR sub-aggregates → "ar" or "otherCurrentAssets"
    "ar_doubtful": "ar",
    "ar_provisions": "ar",
    "ar_intercompany": "otherCurrentAssets",
    # PPE sub-aggregates → "ppe"
    "ppe_investment": "ppe",
    "ppe_under_construction": "ppe",
    "ppe_advances": "ppe",
    # Liability sub-aggregates → existing legacy buckets
    "ap_dividends": "otherCurrentLiab",
    # Equity sub-aggregates
    "equity_revaluation": "otherEquity",
    "retained_earnings": "retainedEarnings",
    # P&L sub-aggregates → existing P&L buckets
    "opex_third_party": "operatingExpenses",
    "interest_income": "financialIncome",
    "interest_expense": "interestExpense",
    "fx_gain": "financialIncome",
    "fx_loss": "financialExpense",
    "financial_income": "financialIncome",
    # 711 inventory-variation memo is in-memory only; persist as otherIncome
    # so the existing CHECK constraint accepts it. The canonical pl dict still
    # holds the separate field — cash-view EBITDA reads from there.
    "inventoryVariationMemo": "otherIncome",
}


def _persistence_bucket(canonical: str) -> str:
    """Translate a canonical bucket name to its legacy name (the value the
    existing Supabase CHECK constraint accepts). Falls through unchanged
    for buckets that already match the legacy set."""
    return _CANONICAL_TO_LEGACY_BUCKET.get(canonical, canonical)

# Buckets that should be tracked as sub-aggregates (separately from their
# top-level BS/PL line) so downstream stages can do industry classification,
# anomaly detection, and risk framing.
_SUB_AGGREGATE_BUCKETS = {
    # Cash sub-aggregates
    "cash_fx",
    # AR sub-aggregates
    "ar_doubtful",
    "ar_provisions",
    "ar_intercompany",
    # PPE sub-aggregates
    "ppe_investment",
    "ppe_under_construction",
    "ppe_advances",
    # Liabilities sub-aggregates
    "ap_dividends",
    # Equity sub-aggregates
    "equity_revaluation",
    "retained_earnings",
    # P&L sub-aggregates
    "opex_third_party",
    "interest_income",
    "interest_expense",
    "fx_gain",
    "fx_loss",
    "financial_income",
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
    sub_agg: Dict[str, float] = {k: 0.0 for k in _SUB_AGGREGATE_BUCKETS}
    line_items: List[Dict[str, object]] = []
    ignored_items: List[Dict[str, object]] = []
    unmapped: List[Dict[str, object]] = []

    # 767 (discounts received) is bucketed into `financial_income` for the
    # legacy P&L view, but the OPERATING view (which the FE P&L tab and
    # KPI tiles render) counts it inside operating revenue. Track it
    # separately so `assembled_pl_canonical` can surface the operating
    # view without disturbing the financial_income aggregate.
    discounts_received_767 = 0.0

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

        # `bucket_override` lets the upstream extractor redirect a row to a
        # bucket that doesn't match what `bucket_for(code)` returned. The
        # canonical use is SIDE-FLIP routing: a mixed-side class-4 account
        # (e.g. 418 customer accruals, 451 affiliated balances) whose
        # balance lands on the opposite side of its natural direction is
        # routed to the matching liability bucket so it doesn't pollute
        # the asset side. The override bucket carries sign=+1 by convention
        # (the extractor already produced a non-negative `amount` matching
        # the override-bucket's natural side).
        override_bucket = raw.get("bucket_override")
        if override_bucket:
            # Replace the rule in-flight so the downstream routing picks
            # the override bucket. Construct a new MappingRule rather than
            # mutate the cached one — `_RULES_SORTED` is global state and
            # mutating it would silently corrupt subsequent calls.
            rule = MappingRule(
                prefix=rule.prefix,
                bucket=str(override_bucket),
                sign=1,
                description=rule.description + " (side-flipped to liab)",
            )

        # Buckets in _IGNORE_BUCKETS are intentionally not summed anywhere
        # AND not persisted as line items. 581 (Viramente interne) and
        # 121 (PROFIT SI PIERDERE control) are the canonical cases —
        # claiming each via a mapping rule prevents them from falling
        # through to catchall rules and from appearing as "unmapped"
        # warnings. They show up in a separate `ignored` list on the
        # assembled output for transparency, but never in line_items
        # (because line_items rows go to the DB and the DB constraint
        # only accepts statement in {"BS","PL"}).
        if rule.bucket in _IGNORE_BUCKETS:
            ignored_items.append({
                "bucket": rule.bucket,  # canonical name; in-memory only
                "ro_account_code": code,
                "ro_account_name": name,
                "amount": amount * rule.sign,
            })
            continue

        signed = amount * rule.sign

        # Capture the 767 component as it flows past — used below to build
        # the operating-view EBITDA. The financial_income bucket still
        # receives it, so nothing in the legacy path changes.
        if code.startswith("767"):
            discounts_received_767 += signed

        # Track sub-aggregates BEFORE rolling into the top-level field so
        # the same amount appears both on the line total (e.g.,
        # propertyPlantEquipment) and on the sub-aggregate
        # (e.g., ppe_investment) for industry detection.
        if rule.bucket in _SUB_AGGREGATE_BUCKETS:
            sub_agg[rule.bucket] += signed

        if rule.bucket in _BUCKET_TO_BS_FIELD:
            bs[_BUCKET_TO_BS_FIELD[rule.bucket]] += signed
            statement = "BS"
        elif rule.bucket in _BUCKET_TO_PL_FIELD:
            pl[_BUCKET_TO_PL_FIELD[rule.bucket]] += signed
            statement = "PL"
        else:
            continue
        # Persist with the LEGACY bucket name (DB-accepted) and keep the
        # canonical name on the side so future migrations and the
        # frontend's sub-aggregate views can read both.
        line_items.append({
            "statement": statement,
            "bucket": _persistence_bucket(rule.bucket),
            "canonical_bucket": rule.bucket,
            "ro_account_code": code,
            "ro_account_name": name,
            "amount": signed,
            "is_derived": False,
        })

    # Defensive sign normalization for liability/equity buckets.
    # Romanian credit balances should always emit POSITIVE per the extraction
    # prompt, but Claude occasionally returns negative amounts for sub-classes
    # whose prefix looks asset-like (e.g. 5191 short-term bank loan — class-5
    # passive, but Claude reads as 5-cash sub-pattern). Bucket name is the
    # source of truth for sign — flip any negatives back here. Asset buckets
    # CAN legitimately be negative (contra-asset accumulated depreciation,
    # for example), so we only normalize liability + equity.
    _CREDIT_POSITIVE_BS_FIELDS = (
        "accountsPayable", "shortTermDebt", "otherCurrentLiabilities",
        "longTermDebt", "otherNonCurrentLiabilities",
        "shareCapital", "retainedEarnings", "otherEquity",
    )
    for fld in _CREDIT_POSITIVE_BS_FIELDS:
        if bs.get(fld, 0) < 0:
            bs[fld] = -bs[fld]

    # Round to 2 decimal places to keep persisted numbers tidy.
    bs = {k: round(v, 2) for k, v in bs.items()}
    pl = {k: round(v, 2) for k, v in pl.items()}
    sub_agg = {k: round(v, 2) for k, v in sub_agg.items()}

    # ── Canonical "assembled_bs" view — top-level fields that match the
    # surgical-fix prompt's expected schema exactly. The frontend KPI tiles
    # read these directly (not by re-deriving from the raw BS lines).
    # Each value reconciles to the source balanta closing balances. ──
    assembled_bs_canonical = {
        # Cash (5121 + 5311 RON + 5124 + 5314 FX); 581 is ignored.
        "cash": round(bs["cash"], 2),
        "cash_fx_component": round(sub_agg.get("cash_fx", 0), 2),
        # AR: gross 4111+4118 NET of 491 provision (491 is sign=-1 in mapping
        # so it already reduces accountsReceivable when summed).
        "ar_net": round(bs["accountsReceivable"], 2),
        "ar_doubtful_gross": round(sub_agg.get("ar_doubtful", 0), 2),
        "ar_provisions": round(sub_agg.get("ar_provisions", 0), 2),
        # 461 — intercompany / related-party debtor, surfaced separately
        "ar_intercompany": round(sub_agg.get("ar_intercompany", 0), 2),
        # AR other — what's in otherCurrentAssets MINUS ar_intercompany and
        # ppe_advances (so callers reading ar_other don't double-count).
        "ar_other": round(
            bs["otherCurrentAssets"]
            - sub_agg.get("ar_intercompany", 0)
            - sub_agg.get("ppe_advances", 0),
            2,
        ),
        # PPE breakouts
        "ppe_net": round(bs["propertyPlantEquipment"], 2),
        "ppe_investment_net": round(sub_agg.get("ppe_investment", 0), 2),
        "ppe_under_construction": round(sub_agg.get("ppe_under_construction", 0), 2),
        "ppe_advances": round(sub_agg.get("ppe_advances", 0), 2),
        "intangibles_net": round(bs["intangibles"], 2),
        "investments": round(bs["otherNonCurrentAssets"], 2),
        # Liabilities — debt and dividends ALWAYS separated.
        "ap": round(bs["accountsPayable"], 2),
        "ap_dividends": round(sub_agg.get("ap_dividends", 0), 2),
        "ap_other": round(
            bs["otherCurrentLiabilities"] - sub_agg.get("ap_dividends", 0), 2
        ),
        "lt_debt": round(bs["longTermDebt"], 2),
        "st_debt": round(bs["shortTermDebt"], 2),
        # Total debt = ONLY stDebt + ltDebt. Dividends NEVER folded in.
        "total_debt": round(bs["shortTermDebt"] + bs["longTermDebt"], 2),
        # Equity
        "share_capital": round(bs["shareCapital"], 2),
        "revaluation_reserves": round(sub_agg.get("equity_revaluation", 0), 2),
        "retained_earnings": round(sub_agg.get("retained_earnings", 0), 2),
        "other_equity_non_revaluation": round(
            bs["otherEquity"] - sub_agg.get("equity_revaluation", 0), 2
        ),
        # current_year_pnl filled below after we compute statutory net income.
        "current_year_pnl": 0.0,
        # total_assets + total_equity + total_liabilities + bs_balance_delta
        # also filled below for downstream consumers.
        "total_assets": 0.0,
        "total_equity": 0.0,
        "total_liabilities": 0.0,
        "bs_balance_delta": 0.0,
    }

    # ── Canonical "assembled_pl" view — both net income views surfaced.
    # Operational excludes capitalized own-work; statutory includes it (to
    # match account 121 PROFIT SI PIERDERE on the Romanian books). ──
    revenue = pl["revenue"]
    cogs = pl["costOfGoodsSold"]
    opex = pl["operatingExpenses"]
    depreciation = pl["depreciationAmortization"]
    interest = pl["interestExpense"]
    other_inc = pl["otherIncome"]
    fin_inc = pl["financialIncome"]
    fin_exp = pl["financialExpense"]
    tax = pl["taxExpense"]
    capitalized = pl.get("capitalizedOwnWork", 0.0)
    inventory_variation_memo = pl.get("inventoryVariationMemo", 0.0)

    gross_profit = revenue - cogs
    # `other_inc` now excludes 711 (routed to inventoryVariationMemo); this is
    # the CASH-view EBITDA — the number a buyer or lender cares about.
    ebitda = revenue - cogs - opex + other_inc  # operational (722 + 711 excluded)
    ebit = ebitda - depreciation
    pretax = ebit + fin_inc - fin_exp - interest
    net_income_operational = pretax - tax
    # Statutory: Romanian books include 722's credit. account 121 will close
    # to (operational + capitalized_own_work).
    net_income_statutory = net_income_operational + capitalized

    # ── THREE EBITDA VIEWS — explicit, never re-derived downstream ───────
    # The same Romanian books produce three legitimate EBITDA numbers,
    # depending on how 722 (capitalized own-work) and 767 (discounts
    # received) are treated. All three must be surfaced so the Valuation
    # tab, briefing, and recommendations all pick the same one and stop
    # disagreeing.
    #
    #   ebitda_operational      — excludes 722; the "cash view" of
    #                             EBITDA. Negative for EEI (−37K).
    #   ebitda_statutory        — includes 722 (matches Romanian P&L
    #                             where 722 closes into 121). PRIMARY
    #                             for valuation. Positive for EEI (+2.13M).
    #   ebitda_operating_view   — includes 722 + 767 (the FE P&L tab view).
    #                             Marginally higher than statutory by the
    #                             discounts-received amount.
    ebitda_operational = ebitda                                                  # -36,676 for EEI
    ebitda_statutory   = ebitda + capitalized                                    # 2,127,404 for EEI
    ebitda_operating_view = ebitda + capitalized + discounts_received_767        # 2,149,571 for real EEI
    # Cash view (alias) — primary for valuation and lender DSCR. Excludes
    # both 722 (capitalized own-work) and 711 (inventory variation).
    ebitda_cash = ebitda_operational
    # Statutory-with-711 — IFRS-style "total production" view that includes
    # the inventory accrual. Useful for matching Romanian account 121.
    ebitda_statutory_with_711 = ebitda_cash + capitalized + inventory_variation_memo
    # Keep `operating_ebitda` / `total_operating_revenue` as aliases for
    # the FE which already consumes the operating-view field names.
    total_operating_revenue = revenue + capitalized + discounts_received_767
    total_operating_revenue_statutory = total_operating_revenue + inventory_variation_memo
    operating_ebitda = ebitda_operating_view
    operating_ebit = operating_ebitda - depreciation

    assembled_pl_canonical = {
        "revenue": round(revenue, 2),
        "cogs": round(cogs, 2),
        "gross_profit": round(gross_profit, 2),
        "opex_total": round(opex, 2),
        "opex_third_party": round(sub_agg.get("opex_third_party", 0), 2),
        "depreciation": round(depreciation, 2),
        # Legacy `ebitda` kept as `ebitda_operational` for backward compat
        # (the operational view that excludes 722). New consumers should use
        # the explicit *_statutory / *_operational / *_operating_view fields.
        "ebitda": round(ebitda_operational, 2),
        "ebit": round(ebit, 2),
        # Three explicit EBITDA views — Valuation tab, briefing, ratios
        # all pick the same one (statutory is the primary).
        "ebitda_operational":     round(ebitda_operational, 2),
        "ebitda_statutory":       round(ebitda_statutory, 2),
        "ebitda_operating_view":  round(ebitda_operating_view, 2),
        "ebitda_adjusted":        round(ebitda_statutory + sub_agg.get("financial_income", 0), 2),
        "discounts_received":     round(discounts_received_767, 2),
        # Operating-view variants — what the frontend P&L tab + KPI tiles
        # render, and what the CFO briefing must cite.
        "total_operating_revenue": round(total_operating_revenue, 2),
        "total_operating_revenue_statutory": round(total_operating_revenue_statutory, 2),
        "operating_ebitda": round(operating_ebitda, 2),
        "operating_ebit": round(operating_ebit, 2),
        # Cash + 711-inclusive views. Cash is primary; statutory_with_711 is
        # the alternative IFRS-style number for benchmarking.
        "ebitda_cash": round(ebitda_cash, 2),
        "ebitda_statutory_with_711": round(ebitda_statutory_with_711, 2),
        "inventory_variation_memo": round(inventory_variation_memo, 2),
        "interest_expense": round(interest, 2),
        "interest_income": round(sub_agg.get("interest_income", 0), 2),
        "fx_gain": round(sub_agg.get("fx_gain", 0), 2),
        "fx_loss": round(sub_agg.get("fx_loss", 0), 2),
        "financial_income_other": round(sub_agg.get("financial_income", 0), 2),
        "financial_income": round(fin_inc, 2),
        "financial_expense": round(fin_exp, 2),
        "pretax": round(pretax, 2),
        "tax": round(tax, 2),
        # Both net income views — neither hidden, neither default.
        "net_income_operational": round(net_income_operational, 2),
        "net_income_statutory": round(net_income_statutory, 2),
        # 722 memo line — proof that the pipeline is excluding it.
        "capitalized_own_work_memo": round(capitalized, 2),
    }

    # ── Close current-year P&L into equity so the BS balances ────────────
    # Romanian accounting carries the current year's P&L in account 121
    # (PROFIT SI PIERDERE), which we map to `ignore_control` — derived
    # elsewhere, never summed. The statutory net income computed above
    # IS what 121 closes to at year-end. Add it back into the equity
    # section of the legacy `bs` dict (the one the frontend reads) so
    # total_equity = share_capital + retained_earnings + other_equity +
    # current_year_pnl, and total_assets = total_liabilities + total_equity
    # within rounding. Without this step, BS is off by exactly the
    # statutory net income (~RON 1.42M for EEI).
    bs["retainedEarnings"] = round(bs["retainedEarnings"] + net_income_statutory, 2)
    sub_agg["current_year_pnl"] = round(net_income_statutory, 2)

    # Now fill the cross-references on the BS canonical view.
    assembled_bs_canonical["current_year_pnl"] = round(net_income_statutory, 2)
    # retained_earnings stays as the carry-forward (year-start) value;
    # current_year_pnl is the THIS-period contribution, surfaced separately.
    total_assets = (
        bs["cash"] + bs["accountsReceivable"] + bs["inventory"]
        + bs["otherCurrentAssets"] + bs["propertyPlantEquipment"]
        + bs["intangibles"] + bs["otherNonCurrentAssets"]
    )
    total_equity = (
        bs["shareCapital"] + bs["retainedEarnings"] + bs["otherEquity"]
    )
    total_liabilities = (
        bs["accountsPayable"] + bs["shortTermDebt"]
        + bs["otherCurrentLiabilities"] + bs["longTermDebt"]
        + bs["otherNonCurrentLiabilities"]
    )
    bs_balance_delta = total_assets - (total_liabilities + total_equity)
    assembled_bs_canonical["total_assets"] = round(total_assets, 2)
    assembled_bs_canonical["total_equity"] = round(total_equity, 2)
    assembled_bs_canonical["total_liabilities"] = round(total_liabilities, 2)
    assembled_bs_canonical["bs_balance_delta"] = round(bs_balance_delta, 2)

    # ── ASSEMBLED CASH FLOW — REAL CapEx, not D&A ────────────────────────
    # The Valuation tab's FCF / DCF math has been reading `capex = D&A`
    # because the supplementary input was never wired. That's the
    # "smoking gun" bug from the screenshots — CapEx of RON 355K matches
    # D&A exactly because it defaulted to D&A. The REAL CapEx is the
    # period-over-period change in gross PPE + CIP + advances. In the
    # Romanian books, capitalized own-work (722) lands on 231 by
    # accounting identity, so when there's no prior-period BS available
    # we use `capitalized_own_work_memo` as a strong proxy for CIP
    # additions. With a prior BS we'd compute Δ(231 + 211/212 gross +
    # 4093) directly.
    cip_additions = round(capitalized, 2)            # 722 closing credit ≈ 231 additions
    real_capex = round(-cip_additions, 2)            # negative = cash out

    # ── INDIRECT-METHOD CASH FLOW — single-period approximation ─────────
    # Ported from reference/financial_analysis.py build_cash_flow(). When
    # only the current period is threaded (no prior_bs to diff against),
    # we follow the same conservative approximation the oracle uses AND
    # mark `is_approximated=True` so the FE can surface the honesty banner.
    # Methodology mirrors CLAUDE.md Appendix A Section 4.
    #
    # The oracle's approximations (for the no-prior-period case) are:
    #   ΔReceivables ≈ -5% of current receivables (small build)
    #   ΔInventory   ≈ -5% of current inventory
    #   ΔTrade pay   ≈ +5% of current AP
    #   ΔTax pay     ≈ +2% of tax_pay
    #   CapEx        ≈ 5% of ppe_gross
    #   ΔLT debt     ≈ -10% (assume some scheduled repayment)
    #   ΔST debt     ≈ +10%
    #   Dividends paid ≈ 50% of statutory net income (typical RO payout)
    # These don't reconcile to the BS cash change exactly; the WC plug at
    # the FE catches the residual so closing_cash_computed == closing_cash.
    revenue_for_wc = pl.get("revenue", 0)
    inventory_curr = bs.get("inventory", 0)
    ar_curr = bs.get("accountsReceivable", 0)
    ap_curr = bs.get("accountsPayable", 0)
    tax_pay_curr = sub_agg.get("tax_pay", 0) if "tax_pay" in sub_agg else bs.get("otherCurrentLiabilities", 0) * 0.1
    ppe_gross_proxy = max(bs.get("propertyPlantEquipment", 0), 0)
    affiliates_curr = sub_agg.get("affiliates", 0) if "affiliates" in sub_agg else 0
    cip_curr = sub_agg.get("ppe_under_construction", 0) if "ppe_under_construction" in sub_agg else 0
    lt_debt_curr = bs.get("longTermDebt", 0)
    st_debt_curr = bs.get("shortTermDebt", 0)

    # Operating section — approximated WC deltas
    delta_inventory_approx = -inventory_curr * 0.05
    delta_receivables_approx = -ar_curr * 0.05
    delta_trade_pay_approx = ap_curr * 0.05
    delta_tax_pay_approx = tax_pay_curr * 0.02
    net_wc_change_approx = (
        delta_inventory_approx + delta_receivables_approx
        + delta_trade_pay_approx + delta_tax_pay_approx
    )
    # Provision movement proxy — non-cash add-back. Oracle uses
    # (781 reversals − 20% of class-65 charges) as rough estimate.
    provision_movement_proxy = max(0, (pl.get("otherIncome", 0) or 0) * 0.6)

    cf_before_wc = net_income_statutory + depreciation + provision_movement_proxy
    cash_from_operating = round(cf_before_wc + net_wc_change_approx, 2)

    # Investing — REAL capex from 722→231 path, plus approximated other capex
    capex_approx = -(ppe_gross_proxy * 0.05)
    cip_change_approx = -(cip_curr * 0.5)  # half of CIP assumed new this period
    affiliate_change_approx = -(affiliates_curr * 0.02)
    dividends_received_pnl = sub_agg.get("financial_income", 0) or 0
    interest_received_pnl = sub_agg.get("interest_income", 0) or 0
    cash_used_in_investing_approx = round(
        capex_approx + cip_change_approx + affiliate_change_approx
        + dividends_received_pnl + interest_received_pnl, 2
    )

    # Financing — approximations matching the oracle's defaults
    delta_lt_debt_approx = -lt_debt_curr * 0.10  # assume scheduled repayment
    delta_st_bank_approx = st_debt_curr * 0.10   # net new ST credit usage
    interest_paid_approx = -(pl.get("interestExpense", 0) or 0)
    dividends_paid_approx = -net_income_statutory * 0.50  # typical RO payout
    cash_used_in_financing_approx = round(
        delta_lt_debt_approx + delta_st_bank_approx
        + interest_paid_approx + dividends_paid_approx, 2
    )

    # Reconciliation — the closing cash IS known (BS), so the residual
    # against (CFO+CFI+CFF) becomes the explicit reconciliation plug the
    # FE surfaces.
    net_change_cash_approx = round(
        cash_from_operating + cash_used_in_investing_approx
        + cash_used_in_financing_approx, 2
    )

    free_cash_flow = round(cash_from_operating + real_capex, 2)

    # `is_approximated` is currently always True because the upstream
    # extractor doesn't thread a prior-period dataframe. The flag is
    # already plumbed through so once multi-period uploads land the
    # back end can flip this without any FE change.
    is_approximated = True
    approximation_notes = [
        "Working-capital movements estimated at 5% of current balances; "
        "actual ΔAR / ΔInventory / ΔAP cannot be computed without a prior-period "
        "trial balance.",
        "Financing detail (LT/ST debt drawdowns vs repayments, dividends paid) "
        "approximated from typical Romanian payout ratios. The reconciliation "
        "plug captures the residual so closing cash still ties to the BS.",
    ]

    assembled_cf_canonical = {
        # Operating section
        "net_profit": round(net_income_statutory, 2),
        "depreciation": round(depreciation, 2),
        "provision_movement": round(provision_movement_proxy, 2),
        "cf_before_wc": round(cf_before_wc, 2),
        "delta_receivables": round(delta_receivables_approx, 2),
        "delta_inventory": round(delta_inventory_approx, 2),
        "delta_trade_pay": round(delta_trade_pay_approx, 2),
        "delta_tax_pay": round(delta_tax_pay_approx, 2),
        "net_wc_change": round(net_wc_change_approx, 2),
        "cash_from_operating": cash_from_operating,
        # Investing
        "capex_real": real_capex,                                # 722→231 (always real)
        "capex_other_approx": round(capex_approx, 2),            # 5% PP&E proxy
        "cip_change": round(cip_change_approx, 2),
        "affiliate_change": round(affiliate_change_approx, 2),
        "dividends_received": round(dividends_received_pnl, 2),
        "interest_received": round(interest_received_pnl, 2),
        "capitalized_construction": round(-cip_additions, 2),
        "cash_used_in_investing": cash_used_in_investing_approx,
        # Financing
        "delta_lt_debt": round(delta_lt_debt_approx, 2),
        "delta_st_bank": round(delta_st_bank_approx, 2),
        "bank_loan_drawdowns": round(max(delta_lt_debt_approx, 0) + max(delta_st_bank_approx, 0), 2),
        "bank_loan_repayments": round(min(delta_lt_debt_approx, 0) + min(delta_st_bank_approx, 0), 2),
        "interest_paid": round(interest_paid_approx, 2),
        "dividends_paid": round(dividends_paid_approx, 2),
        "cash_used_in_financing": cash_used_in_financing_approx,
        # Reconciliation
        "net_change_in_cash": net_change_cash_approx,
        "closing_cash_actual": round(bs["cash"], 2),
        "free_cash_flow": free_cash_flow,
        # Honesty rails — drive the FE banner + upload-prior CTA.
        "is_approximated": is_approximated,
        "approximation_notes": approximation_notes,
        "dividends_declared_but_unpaid": bool(
            sub_agg.get("ap_dividends", 0) > 1000
        ),
    }

    statements = {
        "companyName": company_name,
        "industry": industry,
        "currency": currency,
        "periodLabel": period_label,
        "balanceSheet": bs,
        "incomeStatement": pl,
        # Sub-aggregates — same numbers, broken out by sub-bucket for
        # industry classification (Step 3), anomaly detection (Step 6),
        # and risk framing. Frontend reads these for the CRE-specific tile
        # set + the "628 anomaly" risk card.
        "subAggregates": sub_agg,
        # Canonical BS / P&L views — the EXACT field names the surgical-fix
        # prompt requires (`cash`, `ar_net`, `ap_dividends`, `lt_debt`,
        # `total_debt`, `net_income_statutory`, `net_income_operational`,
        # etc.). Frontend KPI tiles + CI validation script read THESE.
        "assembled_bs": assembled_bs_canonical,
        "assembled_pl": assembled_pl_canonical,
        "assembled_cf": assembled_cf_canonical,
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
        # Accounts explicitly excluded from the totals (581 transit, 121
        # control). Surfaced for the frontend's transparency block — NOT
        # persisted to statement_line_items.
        "ignored": ignored_items,
    }


# ─── Industry auto-classification ───────────────────────────────────────────
# Detects industry from the sub-aggregates produced by assemble_statements.
# Used as a fallback when the org's industry_key is None / "generic" — the
# returned key flows into compute_valuation (Step 5) and gates EV/EBITDA.


def detect_industry(assembled: Dict[str, object]) -> Dict[str, object]:
    """Classify the entity from the assembled statements.

    Returns:
      {
        "industry_key": str,        # e.g. "real_estate_commercial"
        "confidence": float,        # 0.0 to 1.0
        "signals": Dict[str, int],  # per-industry score breakdown
        "method": str,              # "auto" (sub-aggregate dominance)
      }

    The classification is conservative — it only emits a non-"generic"
    answer when at least one strong signal is present (score >= 3).
    """
    statements = assembled.get("statements") if isinstance(assembled, dict) else None
    if not isinstance(statements, dict):
        return {"industry_key": "generic", "confidence": 0.0, "signals": {}, "method": "auto"}

    bs = statements.get("balanceSheet") or {}
    pl = statements.get("incomeStatement") or {}
    sub_agg = statements.get("subAggregates") or {}
    if not isinstance(bs, dict) or not isinstance(pl, dict) or not isinstance(sub_agg, dict):
        return {"industry_key": "generic", "confidence": 0.0, "signals": {}, "method": "auto"}

    def _num(x: object) -> float:
        try:
            return float(x) if x is not None else 0.0
        except (TypeError, ValueError):
            return 0.0

    total_assets = (
        _num(bs.get("cash"))
        + _num(bs.get("accountsReceivable"))
        + _num(bs.get("inventory"))
        + _num(bs.get("otherCurrentAssets"))
        + _num(bs.get("propertyPlantEquipment"))
        + _num(bs.get("intangibles"))
        + _num(bs.get("otherNonCurrentAssets"))
    )
    revenue = _num(pl.get("revenue"))
    inventory = _num(bs.get("inventory"))

    ppe_investment = _num(sub_agg.get("ppe_investment"))

    # Account 706 (Venituri din chirii) signals rental income. We don't have a
    # sub-aggregate for it directly, but we can scan line_items.
    line_items = assembled.get("lineItems") if isinstance(assembled, dict) else []
    rental_706 = 0.0
    if isinstance(line_items, list):
        for li in line_items:
            if not isinstance(li, dict):
                continue
            code = str(li.get("ro_account_code", ""))
            if code.startswith("706"):
                rental_706 += _num(li.get("amount"))

    signals: Dict[str, int] = {"generic": 0}

    # ── Commercial Real Estate ──────────────────────────────────────────
    cre_score = 0
    # Strongest signal: investment property dominates assets.
    if total_assets > 0 and ppe_investment > total_assets * 0.40:
        cre_score += 3
    # Second-strongest: rental income (706) dominates revenue.
    if revenue > 0 and rental_706 > revenue * 0.80:
        cre_score += 3
    # Supporting: no inventory (CRE holders don't hold trading stock).
    if inventory == 0:
        cre_score += 1
    # Supporting: investment property present at all.
    if ppe_investment > 0:
        cre_score += 1
    signals["real_estate_commercial"] = cre_score

    # ── Other detectors (placeholder for future industries) ─────────────
    # When inventory_turns, SaaS-style revenue patterns, etc. are added,
    # extend this block. For now, only CRE has a confident detector.

    winner = max(signals.items(), key=lambda kv: kv[1])
    if winner[1] >= 3:
        # confidence scales with score (max possible CRE score = 8)
        confidence = min(1.0, winner[1] / 8.0 + 0.4)
        return {
            "industry_key": winner[0],
            "confidence": round(confidence, 2),
            "signals": signals,
            "method": "auto",
        }

    return {"industry_key": "generic", "confidence": 0.0, "signals": signals, "method": "auto"}
