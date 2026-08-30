"""Narrative-unit gates U1..U6 — one currency per claim, ratios on native
operands, and no digit that a model wrote.

WHY THIS FILE EXISTS
--------------------
Production, 2026-08-30 (severity-max). The Critical note for account 461
rendered:

    Account 461 (Debitori diverși) holds RON 7,692,203 — 19.6% of total
    assets 7.467.122,25 €

One claim, two currencies. The percentage was *correct* and native
(7,692,202.74 / 39,194,178.46, both RON); the harm was that a rendered
sentence made a correct ratio unverifiable and invited a cross-currency
reading of it. `c05eab2` contained the body. This file is the law that
keeps it contained — and that catches the siblings the containment did
not reach.

THE LAWS
--------
U1  MIXED-CURRENCY   a rendered claim carries at most ONE currency.
U2  RATIO UNITS      a ratio is computed on NATIVE operands of identical
                     currency AND scale; its value is INVARIANT under a
                     display-currency change. Conversion never
                     participates in a ratio.
U3E NO TRANSFORMED    a narrative template interpolates the CITED FACT,
    NUMERAL          not a presentation transform of it. `abs(x)` in the
                     prose beside a signed `x` in `facts_cited` is how a
                     figure becomes permanently unconvertible.
U4  CROSS-SURFACE    the same fact is cent- and percent-identical in the
    PARITY           note, in the statement rows it is drawn from, and
                     in the export.
U6  MODEL NUMERALS   AI carries narrative; it never authors digits.

U3 (frontend narrative builders) and U5 (the 461 case pinned in BOTH
display currencies) live in the other two gate files — see
design_review/narrative/GATES.md for the map.

NO NETWORK. Every figure below is REAL production data, captured
read-only on 2026-08-30 from period `11b8e759-70b2-47fd-b08f-3a2c7550c21c`
(org `b2025358…`) and from the full 67-row `alerts` table across 11 orgs
and 13 periods. Synthetic fixtures would not have found the sign trap or
the 461 attribution error; the real bytes did.

THE QUARANTINE IS A RATCHET, NOT AN EXEMPTION
---------------------------------------------
Several laws below are violated by code this lane does not own. Rather
than ship a red battery or a silent skip, each violation is ENUMERATED.
The gate asserts the live violation set equals the quarantine EXACTLY —
so a NEW violation fails immediately, and a FIXED violation ALSO fails
("this is now green; delete its quarantine entry"). The list can only
shrink, and it cannot rot.
"""
from __future__ import annotations

import ast
import io
import os
import re
import tokenize
from typing import Dict, List, Optional, Sequence, Tuple

import pytest

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
LINKIFY_TS = os.path.join(REPO, "frontend", "lib", "linkifyAlertBody.tsx")
PIPELINE_PY = os.path.join(REPO, "src", "engine", "api", "pipeline.py")


# ══════════════════════════════════════════════════════════════════════
# REAL PRODUCTION FIXTURES
# ══════════════════════════════════════════════════════════════════════

PERIOD_ID = "11b8e759-70b2-47fd-b08f-3a2c7550c21c"

#: The four RAS trial-balance rows the engine's own extraction folded into
#: the `ar_intercompany` canonical leaf. `assembled_canonical_v1.leaves
#: .ar_intercompany.ras_line_items_count` is 4 and its
#: `ras_line_items_sum_signed` is 7692202.74 — these are those four rows.
INTERCOMPANY_ROWS = (
    ("4511.01", "Sume de incasat SCR 4511.01", 7536754.90),
    ("461.016", "Debitori diversii afiliati 461.016", 143709.49),
    ("461.06", "Debitori diversii Babeanu Eduard 461.06", 5637.91),
    ("461.07", "Debitori diversii ALBU ADRIAN MICEA 461.07", 6100.44),
)

#: The fact the note cites, verbatim from the persisted alert payload.
FACT_INTERCOMPANY_LOANS = 7692202.74
FACT_TOTAL_ASSETS = 39194178.46
FACT_PCT_OF_ASSETS = 0.19625880786990732

#: `assembled_bs.total_assets` is the sum of SEVEN legacy buckets
#: (chart_of_accounts.py:1331). These are the 108 persisted
#: `statement_line_items` rows that make them up, verbatim.
BS_ASSET_ROWS = (
    ("ar", "4111.01", 4600644.59),
    ("ar", "4111.02", 1270793.58),
    ("ar", "4111.03", 511694.82),
    ("ar", "4111.10", 2190160.47),
    ("ar", "491", -48170.15),
    ("ar", "496", -11738.35),
    ("cash", "5121.01", 16818.29),
    ("cash", "5121.02", 1096.00),
    ("cash", "5121.03", 16954.40),
    ("cash", "5121.07", 470668.87),
    ("cash", "5124.01", 133402.89),
    ("cash", "5125", 1620.00),
    ("cash", "5311.01", 139874.48),
    ("cash", "5311.02", 461.60),
    ("cash", "5311.03", 8915.47),
    ("cash", "5311.04", 546.22),
    ("cash", "5311.05", 1795.30),
    ("cash", "5311.06", 6484.12),
    ("cash", "5311.08", 10208.13),
    ("cash", "5311.09", 157164.49),
    ("cash", "5311.10", 1793.45),
    ("cash", "5311.11", 5914.03),
    ("cash", "5311.12", 17183.29),
    ("cash", "5311.13", 5179.27),
    ("cash", "5311.18", 638.82),
    ("cash", "5311.32", 2900.53),
    ("cash", "5311.33", 2667.21),
    ("cash", "5311.34", 2299.03),
    ("cash", "5311.35", 12048.24),
    ("cash", "5311.38", 3477.91),
    ("cash", "5311.39", 1271.20),
    ("cash", "5311.41", 3880.17),
    ("cash", "5311.42", 0.08),
    ("cash", "5311.43", 613.45),
    ("cash", "5311.44", 2902.90),
    ("cash", "5311.51", 4.84),
    ("cash", "5311.53", 1306.51),
    ("cash", "5311.54", 684.35),
    ("cash", "5311.57", 926.89),
    ("cash", "5311.58", 134699.90),
    ("cash", "5311.60", 28.35),
    ("cash", "542", 1616.36),
    ("intangibles", "2050.01", 5106502.31),
    ("intangibles", "2080.01", 194568.94),
    ("intangibles", "2805.01", -4472847.31),
    ("intangibles", "2808.01", -155133.81),
    ("inventory", "301.201", 3019768.26),
    ("inventory", "301.202", 1680.72),
    ("inventory", "301.203", 633356.80),
    ("inventory", "3021.01", 323980.56),
    ("inventory", "3023.21", 322018.08),
    ("inventory", "3023.22", 7288.23),
    ("inventory", "3024.01", 4342.46),
    ("inventory", "3028.01", 26583.74),
    ("inventory", "3028.02", 1603.53),
    ("inventory", "3028.03", 11712.72),
    ("inventory", "3028.04", 6115.00),
    ("inventory", "3031.01", 10900.82),
    ("inventory", "341.010", 995988.37),
    ("inventory", "345.010", 795942.72),
    ("inventory", "348.102", 661216.57),
    ("inventory", "371.001", 8386.78),
    ("inventory", "371.010", 1812639.13),
    ("inventory", "371.050", 8161.96),
    ("inventory", "371.081", 80581.14),
    ("inventory", "371.093", 154502.36),
    ("inventory", "371.095", -11.52),
    ("inventory", "378.078", 0.63),
    ("inventory", "378.080", 0.17),
    ("inventory", "381.001", 52648.19),
    ("inventory", "398", -6075.00),
    ("otherCurrentAssets", "4091.01", -29588.85),
    ("otherCurrentAssets", "4092.34", 19614.76),
    ("otherCurrentAssets", "4511.01", 7536754.90),
    ("otherCurrentAssets", "461.016", 143709.49),
    ("otherCurrentAssets", "461.06", 5637.91),
    ("otherCurrentAssets", "461.07", 6100.44),
    ("otherCurrentAssets", "471.004", 129399.72),
    ("otherCurrentAssets", "471.008", 20442.81),
    ("otherCurrentAssets", "471.009", 1490.00),
    ("otherCurrentAssets", "473.01", 44835.35),
    ("otherCurrentAssets", "481", -1953.00),
    ("otherCurrentAssets", "5081.01", 906526.42),
    ("otherNonCurrentAssets", "2678.27", 3293.58),
    ("otherNonCurrentAssets", "2678.31", -699.24),
    ("otherNonCurrentAssets", "2678.32", 1300.00),
    ("otherNonCurrentAssets", "2678.33", 60011.46),
    ("otherNonCurrentAssets", "2678.36", 2748.62),
    ("otherNonCurrentAssets", "2678.37", 1250.00),
    ("ppe", "2111.02", 983882.24),
    ("ppe", "2111.04", 17148.67),
    ("ppe", "2111.05", 37484.85),
    ("ppe", "2111.06", 35565.48),
    ("ppe", "2111.07", 205798.25),
    ("ppe", "2111.08", 524083.00),
    ("ppe", "2111.09", 270680.00),
    ("ppe", "2112.01", 498894.23),
    ("ppe", "2121.01", 5604426.88),
    ("ppe", "2121.02", 1046579.00),
    ("ppe", "2131.01", 17528035.29),
    ("ppe", "2132.01", 701762.41),
    ("ppe", "2133.01", 9341916.00),
    ("ppe", "214.001", 554867.72),
    ("ppe", "231.010", 49773.00),
    ("ppe", "2811.01", -434488.49),
    ("ppe", "2812.01", -4094529.08),
    ("ppe", "2813.01", -21362608.76),
    ("ppe", "2814.01", -453821.15),
)

#: The SEVEN legacy buckets `assembled_bs.total_assets` sums, in order
#: (src/engine/country_packs/ro_romania/chart_of_accounts.py:1331).
LEGACY_ASSET_BUCKETS = (
    "cash", "ar", "inventory", "otherCurrentAssets",
    "ppe", "intangibles", "otherNonCurrentAssets",
)

#: The OTHER asset authority on the same period: `canonical_bs` (schema
#: bs_v2), which reports `status: BALANCED`, `difference: 0.0` and a
#: satisfied source-conservation invariant. It totals a DIFFERENT number.
#: Pinned so the divergence cannot drift silently — see U4.
CANONICAL_BS_SECTION_SUBTOTALS = {
    "non_current_assets": 11796444.09,
    "current_assets": 27371337.47,
    "prepaid_expenses": 151332.53,
}
CANONICAL_BS_TOTAL_ASSETS = 39319114.09
#: Exactly what the legacy 7-bucket total omits / double-counts vs
#: canonical, reconciled to the cent (U4).
LEGACY_VS_CANONICAL_BRIDGE = (
    ("4428 tax recoverable, absent from the legacy buckets", -48733.72),
    ("413 unclassified debit, absent from the legacy buckets", -46613.06),
    ("4091.01 supplier debtors, negative in legacy only", -29588.85),
)

#: EVERY distinct (rule, title, body, facts_cited) shape in the live
#: `alerts` table — 28 shapes covering all 67 rows, 11 orgs, 13 periods.
#: `rows` is the live multiplicity, so a census over this tuple is a
#: census over production.
LIVE_ALERT_CORPUS = (
    dict(
        rule='risk_inventory_fx_exposure',
        rows=1,
        title='FX exposure — 71% of cash in foreign currency',
        body='Significant FX cash position. Movements in EUR/RON or USD/RON create P&L volatility. Consider an FX hedging policy or natural-hedge alignment with foreign-currency liabilities.',
        facts={'fx_cash': 7178875.41, 'fx_cash_pct': 0.7090339027239408, 'total_cash': 10124869.04},
    ),
    dict(
        rule='equity_quality_revaluation_reserves',
        rows=1,
        title='Revaluation reserves are 56% of equity',
        body='Account 105 (Rezerve din reevaluare) of RON 60,154,927 represents 56% of total equity RON 106,895,968. This is a non-cash accounting reserve from upward revaluation of property — equity quality is materially lower than the balance sheet suggests for lender / buyer analysis.',
        facts={'pct_of_equity': 0.5627427108443122, 'revaluation_reserves': 60154926.76, 'total_equity': 106895967.91},
    ),
    dict(
        rule='leverage_debt_to_ebitda_high',
        rows=5,
        title='Debt/EBITDA at 6.28× exceeds 6.0× critical threshold for generic',
        body='Bank debt RON 32,986,479 divided by statutory EBITDA RON 5,256,298 = 6.28×, above the 6.0× critical threshold typical for this industry. Covenant breach risk.',
        facts={'bank_debt_total': 32986478.75, 'debt_to_ebitda': 6.275610300522261, 'ebitda_statutory': 5256298.14, 'threshold': 6.0},
    ),
    dict(
        rule='risk_inventory_cash_tight',
        rows=3,
        title='Tight cash liquidity — cash ratio 0.04×',
        body='Cash covers only 4.3% of current liabilities — heavy dependence on revolvers. A 15-day disruption could push the company past covenants or payment terms.',
        facts={'cash': 1255039.17, 'cash_ratio': 0.04329383699487034, 'cur_liab': 28988864.400000002},
    ),
    dict(
        rule='risk_inventory_leverage',
        rows=5,
        title='Elevated leverage — Net Debt/EBITDA 6.0×',
        body='Leverage at 6.0× EBITDA is above the typical 3× safety threshold. Covenant pressure likely; refinancing risk if rates rise. Build a covenant dashboard with the lender.',
        facts={'ebitda': 5256298.14, 'net_debt': 31731439.58, 'net_debt_ebitda': 6.036841658300608},
    ),
    dict(
        rule='risk_inventory_fx_exposure',
        rows=5,
        title='FX exposure — 96% of cash in foreign currency',
        body='Significant FX cash position. Movements in EUR/RON or USD/RON create P&L volatility. Consider an FX hedging policy or natural-hedge alignment with foreign-currency liabilities.',
        facts={'fx_cash': 1205819.75, 'fx_cash_pct': 0.9607825626669485, 'total_cash': 1255039.17},
    ),
    dict(
        rule='equity_quality_revaluation_reserves',
        rows=5,
        title='Revaluation reserves are 41% of equity',
        body='Account 105 (Rezerve din reevaluare) of RON 3,152,071 represents 41% of total equity RON 7,756,589. This is a non-cash accounting reserve from upward revaluation of property — equity quality is materially lower than the balance sheet suggests for lender / buyer analysis.',
        facts={'pct_of_equity': 0.40637339416127255, 'revaluation_reserves': 3152071.46, 'total_equity': 7756589.15},
    ),
    dict(
        rule='ai_council',
        rows=8,
        title='AI Council extraction review: PASS',
        body='No AI members available; consensus is the deterministic baseline. (confidence 90%). This is an advisory review of extraction integrity and does not block the analysis.',
        facts={},
    ),
    dict(
        rule='leverage_debt_to_ebitda_high',
        rows=2,
        title='Debt/EBITDA at 6.62× exceeds 6.0× critical threshold for generic',
        body='Bank debt RON 14,083,316 divided by statutory EBITDA RON 2,127,404 = 6.62×, above the 6.0× critical threshold typical for this industry. Covenant breach risk.',
        facts={'bank_debt_total': 14083315.77, 'debt_to_ebitda': 6.619954534252243, 'ebitda_statutory': 2127403.7, 'threshold': 6.0},
    ),
    dict(
        rule='risk_inventory_leverage',
        rows=2,
        title='Elevated leverage — Net Debt/EBITDA 5.9×',
        body='Leverage at 5.9× EBITDA is above the typical 3× safety threshold. Covenant pressure likely; refinancing risk if rates rise. Build a covenant dashboard with the lender.',
        facts={'ebitda': 2127403.7, 'net_debt': 12588478.959999999, 'net_debt_ebitda': 5.9172967312221925},
    ),
    dict(
        rule='concentration_intercompany_loan',
        rows=1,
        title='Intercompany receivable RON 2,596,892 = 12.9% of total assets',
        body='Account 461 (Debitori diverși) holds RON 2,596,892 due from related parties — 12.9% of total assets RON 20,183,416. Recoverability and intent on settlement should be confirmed. Lenders typically haircut related-party receivables during covenant measurement.',
        facts={'intercompany_loans': 2596892.49, 'pct_of_assets': 0.128664667022001, 'total_assets': 20183415.93},
    ),
    dict(
        rule='fcf_negative_development_phase',
        rows=2,
        title='Free cash flow RON -382,675 — one-time CIP capex',
        body='Operating cash flow RON 1,781,405 minus capex RON 2,164,080 (RON 2,164,080 into account 231 Construction in Progress) produces negative FCF this period. Development-phase drag, not ongoing burn — stabilized FCF should be positive once CIP delivers.',
        facts={'capex_real': -2164079.83, 'capitalized_construction': -2164079.83, 'cash_from_operating': 1781404.53, 'free_cash_flow': -382675.3},
    ),
    dict(
        rule='risk_inventory_affiliate_dep',
        rows=2,
        title='Affiliate income dependency — 50% of net profit',
        body='Affiliate dividends + interest produce 50% of net profit. Concentration risk if any single affiliate stops distributing. Entity-by-entity yield review recommended.',
        facts={'affiliate_dep': 0.502751364435033, 'affiliate_income': 716544.16, 'net_income': 1425245.58},
    ),
    dict(
        rule='risk_inventory_fx_exposure',
        rows=2,
        title='FX exposure — 45% of cash in foreign currency',
        body='Significant FX cash position. Movements in EUR/RON or USD/RON create P&L volatility. Consider an FX hedging policy or natural-hedge alignment with foreign-currency liabilities.',
        facts={'fx_cash': 679102.51, 'fx_cash_pct': 0.45429876054497215, 'total_cash': 1494836.81},
    ),
    dict(
        rule='earnings_quality_capitalized_own_work',
        rows=2,
        title='Capitalized own-work RON 2,164,080 = 79% of rental revenue',
        body='Account 722 (Producția imobilizări corporale) carries RON 2,164,080 of capitalized own-work, mirrored by a roughly equal cost on 628 — net P&L effect is approximately zero. Statutory EBITDA RON 2,127,404 (with 722) vs operational view RON -36,676 (without). Bank covenants typically use the statutory view.',
        facts={'capitalized_own_work_memo': 2164079.83, 'ebitda_operational': -36676.13, 'ebitda_statutory': 2127403.7, 'pct_of_rental_revenue': 0.7935451247676802},
    ),
    dict(
        rule='equity_quality_revaluation_reserves',
        rows=2,
        title='Revaluation reserves are 68% of equity',
        body='Account 105 (Rezerve din reevaluare) of RON 3,980,158 represents 68% of total equity RON 5,823,954. This is a non-cash accounting reserve from upward revaluation of property — equity quality is materially lower than the balance sheet suggests for lender / buyer analysis.',
        facts={'pct_of_equity': 0.6834116195845356, 'revaluation_reserves': 3980157.61, 'total_equity': 5823953.67},
    ),
    dict(
        rule='risk_inventory_cash_tight',
        rows=3,
        title='Tight cash liquidity — cash ratio 0.09×',
        body='Cash covers only 9.0% of current liabilities — heavy dependence on revolvers. A 15-day disruption could push the company past covenants or payment terms.',
        facts={'cash': 1168047.04, 'cash_ratio': 0.09030369285017299, 'cur_liab': 12934654.2},
    ),
    dict(
        rule='concentration_intercompany_loan',
        rows=3,
        title='Intercompany receivable RON 7,692,203 = 19.6% of total assets',
        body='Account 461 (Debitori diverși) holds RON 7,692,203 due from related parties — 19.6% of total assets RON 39,194,178. Recoverability and intent on settlement should be confirmed. Lenders typically haircut related-party receivables during covenant measurement.',
        facts={'intercompany_loans': 7692202.74, 'pct_of_assets': 0.19625880786990732, 'total_assets': 39194178.46},
    ),
    dict(
        rule='risk_inventory_fx_exposure',
        rows=3,
        title='FX exposure — 11% of cash in foreign currency',
        body='Significant FX cash position. Movements in EUR/RON or USD/RON create P&L volatility. Consider an FX hedging policy or natural-hedge alignment with foreign-currency liabilities.',
        facts={'fx_cash': 133402.89, 'fx_cash_pct': 0.11421020338358977, 'total_cash': 1168047.04},
    ),
    dict(
        rule='valuation_ebitda_negative',
        rows=1,
        title='Statutory EBITDA RON -29,038,838 — earnings-based valuation not applicable',
        body='With EBITDA at or below zero, EV/EBITDA multiples produce meaningless values. The platform uses asset-based and revenue-multiple methods for valuation; see the Valuation tab.',
        facts={'ebitda_statutory': -29038838.12},
    ),
    dict(
        rule='risk_inventory_cash_tight',
        rows=1,
        title='Tight cash liquidity — cash ratio 0.04×',
        body='Cash covers only 4.2% of current liabilities — heavy dependence on revolvers. A 15-day disruption could push the company past covenants or payment terms.',
        facts={'cash': 1184400.37, 'cash_ratio': 0.04212375354366455, 'cur_liab': 28117161.23},
    ),
    dict(
        rule='risk_inventory_fx_exposure',
        rows=1,
        title='FX exposure — 15% of cash in foreign currency',
        body='Significant FX cash position. Movements in EUR/RON or USD/RON create P&L volatility. Consider an FX hedging policy or natural-hedge alignment with foreign-currency liabilities.',
        facts={'fx_cash': 177761.55, 'fx_cash_pct': 0.15008569272905578, 'total_cash': 1184400.37},
    ),
    dict(
        rule='equity_quality_revaluation_reserves',
        rows=1,
        title='Revaluation reserves are 66% of equity',
        body='Account 105 (Rezerve din reevaluare) of RON 26,482,578 represents 66% of total equity RON 40,284,135. This is a non-cash accounting reserve from upward revaluation of property — equity quality is materially lower than the balance sheet suggests for lender / buyer analysis.',
        facts={'pct_of_equity': 0.6573947361038429, 'revaluation_reserves': 26482578.12, 'total_equity': 40284134.73},
    ),
    dict(
        rule='risk_inventory_cash_tight',
        rows=1,
        title='Tight cash liquidity — cash ratio 0.06×',
        body='Cash covers only 6.2% of current liabilities — heavy dependence on revolvers. A 15-day disruption could push the company past covenants or payment terms.',
        facts={'cash': 6104239.94, 'cash_ratio': 0.06187205481324556, 'cur_liab': 98659078.94},
    ),
    dict(
        rule='cash_dividends_declared_unpaid',
        rows=1,
        title='RON 4,678,772 dividends declared but not paid in cash',
        body='Account 457 (Dividende de plătit) carries RON 4,678,772 liability. Dividends were debited to retained earnings but no cash distribution occurred. Operating cash flow is positive — could service this if distribution is planned.',
        facts={'cash': 6104239.94, 'cash_from_operating': 54836994.22, 'dividends_payable': 4678772.34},
    ),
    dict(
        rule='risk_inventory_affiliate_dep',
        rows=1,
        title='Affiliate income dependency — 21% of net profit',
        body='Affiliate dividends + interest produce 21% of net profit. Concentration risk if any single affiliate stops distributing. Entity-by-entity yield review recommended.',
        facts={'affiliate_dep': 0.21398992998438993, 'affiliate_income': 7760979.0, 'net_income': 36267963.64},
    ),
    dict(
        rule='risk_inventory_cash_tight',
        rows=2,
        title='Tight cash liquidity — cash ratio 0.04×',
        body='Cash covers only 4.3% of current liabilities — heavy dependence on revolvers. A 15-day disruption could push the company past covenants or payment terms.',
        facts={'cash': 1255039.17, 'cash_ratio': 0.04335638577994105, 'cur_liab': 28947043.150000002},
    ),
    dict(
        rule='concentration_intercompany_loan',
        rows=1,
        title='Intercompany receivable RON 2,596,892 = 12.9% of total assets',
        body='Account 461 (Debitori diverși) holds RON 2,596,892 due from related parties — 12.9% of total assets RON 20,181,887. Recoverability and intent on settlement should be confirmed. Lenders typically haircut related-party receivables during covenant measurement.',
        facts={'intercompany_loans': 2596892.49, 'pct_of_assets': 0.1286744174003016, 'total_assets': 20181886.52},
    ),
)


# ══════════════════════════════════════════════════════════════════════
# THE RENDER CONTRACT — mirrored from TypeScript, and PROVEN in sync
# ══════════════════════════════════════════════════════════════════════
#
# A mirror is exactly the shape that hid twenty defects behind a green
# suite once already (design_review — FakeStore). So this mirror does not
# get to be trusted: `test_u0_render_contract_is_in_sync_with_typescript`
# reads the real `linkifyAlertBody.tsx` and asserts every constant below
# is the one the browser actually runs. Drift fails the gate, loudly,
# with the TS text quoted.

#: `RX` in linkifyAlertBody.tsx. Note what it does NOT consume: a leading
#: minus. That omission is the sign trap — see U1/U3E.
RENDER_RX = re.compile(r"(?:RON\s+)?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?:\s+RON)?")
RENDER_MIN_VALUE = 1000.0
RENDER_TOLERANCE = 0.005

#: The currency tokens a reader can see, and the shapes in which they
#: LABEL A FIGURE. A currency word in prose ("movements in EUR/RON create
#: volatility") is not a unit and must not be counted — U1 is about the
#: unit attached to a number, not about the alphabet. Getting this wrong
#: in either direction is fatal: too loose and the gate cries wolf on
#: every FX sentence, too tight and it misses the "7.467.122,25 €" that
#: started all of this.
_CUR_WORD = {
    "RON": r"RON|lei",
    "EUR": r"EUR|€",
    "USD": r"USD|\$",
}
#: A number, in either grouping convention — `39,194,178.46` (engine,
#: locale-stable) or `7.467.122,25` (a `ro-RO` toLocaleString, which the
#: linkify regex cannot match at all).
_NUM = r"\d[\d.,]*\d|\d"
CURRENCY_TOKENS = tuple(
    (code, re.compile(r"(?:(?:%s)\s*(?:%s))|(?:(?:%s)\s*(?:%s))"
                      % (word, _NUM, _NUM, word)))
    for code, word in sorted(_CUR_WORD.items())
)


def _ts_source() -> str:
    with io.open(LINKIFY_TS, "r", encoding="utf-8") as fh:
        return fh.read()


def _ts_fact_to_source_keys() -> frozenset:
    """The FACT_TO_SOURCE key set as the browser sees it."""
    src = _ts_source()
    start = src.index("export const FACT_TO_SOURCE")
    end = src.index("\n};", start)
    block = src[start:end]
    return frozenset(re.findall(r"^\s{2}([a-z_0-9]+):\s*\{", block, re.M))


def _render(text: str, facts: Dict[str, float]) -> Tuple[List[Tuple[str, float]], List[float]]:
    """Post-`c05eab2` parser contract.

    Returns ``(converted, money_left_literal)``. A token that matched a
    cited fact renders through the currency path (it becomes the DISPLAY
    currency). A token that did not match keeps whatever label the engine
    typed next to it — which is `RON`, always.
    """
    value_to_fact = {}  # type: Dict[int, str]
    for name, value in (facts or {}).items():
        if isinstance(value, (int, float)):
            value_to_fact.setdefault(int(round(float(value))), name)

    converted = []  # type: List[Tuple[str, float]]
    literal = []  # type: List[float]
    for match in RENDER_RX.finditer(text or ""):
        full, num = match.group(0), match.group(1)
        try:
            parsed = float(num.replace(",", ""))
        except ValueError:
            continue
        if parsed < RENDER_MIN_VALUE:
            continue
        hit = None  # type: Optional[str]
        for fact_value, fact_name in value_to_fact.items():
            if abs(fact_value - parsed) < max(1.0, parsed * RENDER_TOLERANCE):
                hit = fact_name
                break
        if hit is not None:
            converted.append((hit, parsed))
        elif "RON" in full or "," in num:
            # Money by evidence: it carries a currency label, or it has
            # the 3-digit grouping the engine's `{x:,.0f}` always emits.
            # Anything else we refuse to call money — ABSENT != ZERO
            # applies to unit inference too.
            literal.append(parsed)
    return converted, literal


SURFACES = {
    # pages/cfo/Alerts.tsx:314-319 — title AND body go through linkify.
    "alerts": {"title": "linkified", "body": "linkified"},
    # components/cfo/StatementNotes.tsx:285 renders `{alert.title}` RAW;
    # :291 linkifies the body. This is the surface the 461 note lives on.
    "notes": {"title": "raw", "body": "linkified"},
}


def _inert_residue(text, facts):
    # type: (str, Dict[str, float]) -> str
    """What is left of the string after the parser has absorbed every
    matched figure AND the `RON` label glued to it. Whatever currency
    token survives here is shown to the reader verbatim, in the source
    currency, beside figures that moved to the display currency."""
    value_to_fact = {}  # type: Dict[int, str]
    for name, value in (facts or {}).items():
        if isinstance(value, (int, float)):
            value_to_fact.setdefault(int(round(float(value))), name)
    out = []
    last = 0
    for match in RENDER_RX.finditer(text or ""):
        num = match.group(1)
        try:
            parsed = float(num.replace(",", ""))
        except ValueError:
            continue
        if parsed < RENDER_MIN_VALUE:
            continue
        matched = any(abs(fv - parsed) < max(1.0, parsed * RENDER_TOLERANCE)
                      for fv in value_to_fact)
        if not matched:
            continue
        out.append((text or "")[last:match.start()])
        last = match.end()
    out.append((text or "")[last:])
    return "".join(out)


def _part_currencies(text, facts, mode):
    # type: (str, Dict[str, float], str) -> frozenset
    """Currencies a reader sees in ONE rendered fragment."""
    seen = set()
    converted, literal = _render(text, facts if mode == "linkified" else {})
    if mode == "linkified" and converted:
        seen.add("<display>")   # whatever the currency toggle says
    if literal:
        seen.add("RON")         # kept the label the engine typed
    # Any currency token still standing in inert text is shown as
    # authored — including one the engine never wrote, e.g. a figure the
    # AI formatted itself.
    residue = _inert_residue(text, facts) if mode == "linkified" else (text or "")
    for code, rx in CURRENCY_TOKENS:
        if rx.search(residue):
            seen.add(code)
    return frozenset(seen)


def claim_currencies(title, body, facts, surface):
    # type: (str, str, Dict[str, float], str) -> frozenset
    """The currencies ONE rendered claim shows. A note is one claim: the
    title states the finding and the body evidences it, side by side in
    a single card. A reader comparing them is comparing one claim."""
    modes = SURFACES[surface]
    return (_part_currencies(title, facts, modes["title"])
            | _part_currencies(body, facts, modes["body"]))


# ══════════════════════════════════════════════════════════════════════
# U0 — the mirror is not allowed to drift
# ══════════════════════════════════════════════════════════════════════

class TestU0ContractInSync(object):
    """The Python mirror of the TS render contract must BE the TS render
    contract. A mirror nobody checks is how a green suite hides an
    outage."""

    def test_u0_regex_floor_and_tolerance_match_the_browser(self):
        src = _ts_source()
        assert "const RX = /(?:RON\\s+)?(\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?)(?:\\s+RON)?/g" in src, (
            "linkifyAlertBody.tsx's RX changed. Update RENDER_RX here in the "
            "same commit, or this whole file is measuring a parser that no "
            "longer exists."
        )
        assert "parsed < 1000" in src, "the 1000 floor moved; RENDER_MIN_VALUE is stale"
        assert "parsed * 0.005" in src, "the 0.5% tolerance moved; RENDER_TOLERANCE is stale"

    def test_u0_regex_still_refuses_a_leading_minus(self):
        # Not a style note: this is WHY every negative money fact is
        # permanently unconvertible and keeps its RON label beside
        # converted siblings. Pinned so a fix to it is a deliberate,
        # visible act rather than a silent one.
        converted, literal = _render("capex RON -2,164,080", {"capex_real": -2164079.83})
        assert converted == [], "a leading minus is now consumed — the sign trap may be fixed"
        assert literal == [2164080.0], "the token still reads as unsigned money"

    def test_u0_corpus_covers_the_whole_live_table(self):
        assert sum(shape["rows"] for shape in LIVE_ALERT_CORPUS) == 67
        assert len(LIVE_ALERT_CORPUS) == 28


# ══════════════════════════════════════════════════════════════════════
# U1 — MIXED-CURRENCY LINT: one currency per rendered claim
# ══════════════════════════════════════════════════════════════════════

#: Live claims that still render two currencies, by (rule, surface).
#: OWNED BY OTHER LANES. Each entry names why and who.
#:
#: This is a RATCHET: the assertion is equality, not containment. A new
#: violation fails. A FIXED violation also fails, with "delete this
#: entry" — so the list cannot rot into a permanent exemption.
U1_QUARANTINE = {
    # THE TITLE. 8 of 17 engine rules put money in the title, and it used
    # to render raw beside a linkified body.
    #
    # STATE, 2026-08-30: the render-surface lane HAS landed the fix —
    # `StatementNotes.tsx` now renders both halves through
    # `narrativeMoney.tsx`'s `NarrativeText`, which resolves NAMED facts
    # from `title_template` / `body_template` instead of guessing money
    # out of rendered text. It is a better fix than this gate asked for.
    #
    # It is also, today, INERT: `NarrativeText` falls back to
    # `linkifyAlertBody` when a row carries no template, and **0 of the 67
    # live alert rows carry one** (verified read-only against prod: every
    # payload holds exactly `facts_cited`, `industry`, `rule_key`). The
    # templates are written by `_ratio_units.templatize` at
    # `stage_validate` time, so they appear only after the engine change
    # is DEPLOYED and each period is REPROCESSED.
    #
    # So these rows still render two currencies for a EUR user right now.
    # They stay quarantined until the data catches up with the code, and
    # this gate fails the day it does — which is exactly the signal the
    # deploy needs. Owner: engine deploy + period reprocess.
    ("cash_dividends_declared_unpaid", "notes"): "raw title (StatementNotes.tsx:285)",
    ("concentration_intercompany_loan", "notes"): "raw title (StatementNotes.tsx:285)",
    ("earnings_quality_capitalized_own_work", "notes"): "raw title (StatementNotes.tsx:285)",
    ("fcf_negative_development_phase", "notes"): "raw title (StatementNotes.tsx:285)",
    # The sign trap: the body prints a NEGATIVE money fact, the regex
    # will not consume the minus, so that figure can never match its
    # fact and never converts. Owner: the engine-rules / linkify lane.
    ("earnings_quality_capitalized_own_work", "alerts"): "sign trap (ebitda_operational is negative)",
    ("fcf_negative_development_phase", "alerts"): "sign trap (capex_real, capitalized_construction are negative)",
}


def _live_u1_violations():
    # type: () -> Dict[Tuple[str, str], int]
    """(rule, surface) -> live row count, for every claim that renders in
    more than one currency."""
    out = {}  # type: Dict[Tuple[str, str], int]
    for shape in LIVE_ALERT_CORPUS:
        for surface in sorted(SURFACES):
            seen = claim_currencies(shape["title"], shape["body"], shape["facts"], surface)
            if len(seen) > 1:
                key = (shape["rule"], surface)
                out[key] = out.get(key, 0) + shape["rows"]
    return out


class TestU1MixedCurrency(object):

    def test_u1_no_new_two_currency_claim_and_no_stale_quarantine(self):
        live = _live_u1_violations()
        new = sorted(set(live) - set(U1_QUARANTINE))
        gone = sorted(set(U1_QUARANTINE) - set(live))
        assert not new, (
            "NEW two-currency claim(s): %s. A rendered claim must carry one "
            "currency. Fix the surface, do not extend U1_QUARANTINE." % (new,)
        )
        assert not gone, (
            "FIXED at last: %s no longer renders two currencies. Delete its "
            "U1_QUARANTINE entry in the same commit — a stale quarantine is "
            "an exemption nobody voted for." % (gone,)
        )

    def test_u1_the_461_body_is_single_currency_after_containment(self):
        shape = _shape("concentration_intercompany_loan", ROW_461)
        assert shape["facts"]["intercompany_loans"] == FACT_INTERCOMPANY_LOANS
        assert shape["facts"]["total_assets"] == FACT_TOTAL_ASSETS
        converted, literal = _render(shape["body"], shape["facts"])
        assert [name for name, _ in converted] == ["intercompany_loans", "total_assets"], (
            "both cited money facts must take the currency path"
        )
        assert literal == [], "no money figure may keep the engine's RON label"

    def test_u1_plant_a_second_currency_trips_the_gate(self):
        # PLANT: the exact live defect text, re-armed — a native RON
        # figure beside a display-converted EUR one, in one sentence.
        shape = _shape("concentration_intercompany_loan", ROW_461)
        planted = shape["body"].replace("RON 39,194,178", "7.467.122,25 \u20ac")
        assert planted != shape["body"], (
            "the plant replaced nothing, so it planted nothing — a plant "
            "that does not arm proves the gate works when it does not")
        seen = claim_currencies(shape["title"], planted, shape["facts"], "alerts")
        assert seen == frozenset(["<display>", "EUR"]), (
            "the gate failed to see two currencies in one claim: %s" % (seen,))

    def test_u1_plant_a_prose_currency_word_is_NOT_a_violation(self):
        # The opposite plant, and just as necessary: "Movements in
        # EUR/RON create P&L volatility" names two currencies and labels
        # no figure. A gate that fails on this would be turned off within
        # a week, and then it would be protecting nothing.
        shape = _shape("risk_inventory_fx_exposure")
        assert "EUR/RON" in shape["body"]
        assert claim_currencies(shape["title"], shape["body"],
                                shape["facts"], "alerts") == frozenset()

    def test_u1_clean_rules_stay_clean(self):
        # Non-vacuity from the other side: rules with no money in prose
        # must report exactly zero currencies, not "one by luck".
        for rule in ("risk_inventory_cash_tight", "risk_inventory_fx_exposure"):
            shape = _shape(rule)
            for surface in SURFACES:
                seen = claim_currencies(shape["title"], shape["body"], shape["facts"], surface)
                assert seen == frozenset(), "%s/%s leaked a currency: %s" % (rule, surface, seen)


def _shape(rule, contains=None):
    # type: (str, Optional[str]) -> Dict
    """One live shape. `contains` pins a SPECIFIC production row when the
    rule fired for several companies — without it, `_shape` hands back
    whichever row sorted first, and a test that thinks it is looking at
    period 11b8e759 is quietly looking at someone else's numbers. That
    is not hypothetical: the first draft of the U1 plant did exactly
    this, its string replacement silently matched nothing, and only the
    plant's own assertion caught it."""
    for shape in LIVE_ALERT_CORPUS:
        if shape["rule"] != rule:
            continue
        if contains is None or contains in (shape["body"] or ""):
            return shape
    raise AssertionError(
        "no live shape for rule %r containing %r" % (rule, contains))


#: The exact production row this lane was pointed at.
ROW_461 = "RON 7,692,203 due from"


# ══════════════════════════════════════════════════════════════════════
# U2 — RATIO UNIT GATE
# ══════════════════════════════════════════════════════════════════════
#
# THE LAW: a ratio is computed on NATIVE operands of identical currency
# AND scale, then displayed. Conversion never participates in a ratio.
#
# Consequence, and the thing the property below actually asserts: the
# ratio a reader sees is INVARIANT under a display-currency change. The
# RON view and the EUR view must show the SAME percentage.

#: The production helper. It landed mid-lane (`_ratio_units`, engine-rules
#: lane) and it is exactly the law U2 exists to assert — so U2 IMPORTS it
#: rather than shipping a second, drifting copy. This gate is that
#: module's acceptance test from the narrative side: everything below is
#: phrased as "what a reader must be able to trust", not "what the
#: implementation happens to do".
#
# Imported defensively, and NOT with a module-level `importorskip`: that
# would skip U1, U3E and U4 as well, and a suite that skips itself into
# silence reports exactly the same green as a suite that passed.
try:
    from engine.api import _ratio_units as _ru
except Exception:  # pragma: no cover — the alarm path
    _ru = None

RATIO_LAW_MISSING = (
    "!!! U2 NOT ENFORCED !!! engine.api._ratio_units is missing, so no type "
    "stops a ratio from being computed across a currency boundary. The 461 "
    "note only LOOKED like it was doing that; without this module nothing "
    "prevents a rule from actually doing it."
)

UnitMismatch = _ru.UnitMismatchError if _ru else None
Quantity = _ru.Quantity if _ru else None
ratio = _ru.ratio if _ru else None


def money(value, currency="RON", scale=1, name=None):
    return _ru.money(value, currency, scale, name)


def convert(quantity, rate, to_currency):
    """DISPLAY conversion — the operation that must never appear inside a
    ratio. Defined here, in the test, deliberately: `_ratio_units` does
    not offer one, and it should not. A module whose whole purpose is to
    keep conversion out of arithmetic has no business exporting a
    converter."""
    return _ru.money(quantity.value / rate, to_currency, quantity.scale,
                     quantity.name)


RON_PER_EUR = 5.2489   # the live rate on the day of the defect


@pytest.mark.skipif(_ru is None, reason=RATIO_LAW_MISSING)
class TestU2RatioUnits(object):

    def test_u2_mismatched_currency_raises(self):
        native = money(FACT_INTERCOMPANY_LOANS, "RON", name="intercompany_loans")
        displayed = convert(money(FACT_TOTAL_ASSETS, "RON", name="total_assets"), RON_PER_EUR, "EUR")
        with pytest.raises(UnitMismatch):
            ratio(native, displayed)

    def test_u2_mismatched_scale_raises(self):
        # `recommendations.expected_cash_impact_kron` receives kRON from
        # two producers and RON from a third, and is read as full units.
        with pytest.raises(UnitMismatch):
            ratio(money(210.0, "RON", scale=1000, name="expected_cash_impact_kron"), money(39194178.46, "RON", name="total_assets"))

    def test_u2_the_live_461_ratio_is_native_and_correct(self):
        pct = ratio(money(FACT_INTERCOMPANY_LOANS, "RON", name="intercompany_loans"),
                    money(FACT_TOTAL_ASSETS, "RON", name="total_assets"))
        assert pct == pytest.approx(FACT_PCT_OF_ASSETS, abs=1e-12), (
            "the engine's own stored pct must be reproducible from its own "
            "two cited operands")
        assert "%.1f" % (pct * 100.0) == "19.6"

    def test_u2_ratio_is_invariant_under_display_currency(self):
        num = money(FACT_INTERCOMPANY_LOANS, "RON", name="intercompany_loans")
        den = money(FACT_TOTAL_ASSETS, "RON", name="total_assets")
        ron_view = ratio(num, den)
        eur_view = ratio(convert(num, RON_PER_EUR, "EUR"),
                         convert(den, RON_PER_EUR, "EUR"))
        assert "%.4f" % ron_view == "%.4f" % eur_view
        assert "%.1f%%" % (ron_view * 100) == "%.1f%%" % (eur_view * 100) == "19.6%"

    def test_u2_plant_a_ratio_computed_post_conversion_is_wrong_and_caught(self):
        # PLANT: exactly the arithmetic the 461 note LOOKED like it was
        # doing — native numerator over converted denominator.
        num = money(FACT_INTERCOMPANY_LOANS, "RON", name="intercompany_loans")
        den_eur = convert(money(FACT_TOTAL_ASSETS, "RON", name="total_assets"), RON_PER_EUR, "EUR")
        with pytest.raises(UnitMismatch):
            ratio(num, den_eur)
        # And if a future 'fix' silences the type, the NUMBER still moves
        # by two orders of magnitude — so the invariance assertion above
        # is not a tautology.
        bogus = num.value / den_eur.value
        assert abs(bogus * 100 - 19.63) > 50

    def test_u2_property_invariance_holds_for_every_rate(self):
        pytest.importorskip("hypothesis")
        from hypothesis import given, settings
        from hypothesis import strategies as st

        amounts = st.floats(min_value=1.0, max_value=1e12,
                            allow_nan=False, allow_infinity=False)
        rates = st.floats(min_value=0.01, max_value=1000.0,
                          allow_nan=False, allow_infinity=False)

        @settings(max_examples=200, deadline=None)
        @given(a=amounts, b=amounts, fx=rates)
        def _prop(a, b, fx):
            native = ratio(money(a, "RON"), money(b, "RON"))
            converted = ratio(convert(money(a, "RON"), fx, "EUR"),
                              convert(money(b, "RON"), fx, "EUR"))
            assert converted == pytest.approx(native, rel=1e-9)
            # ... and converting ONE side is refused, always.
            with pytest.raises(UnitMismatch):
                ratio(money(a, "RON"), convert(money(b, "RON"), fx, "EUR"))

        _prop()


# ══════════════════════════════════════════════════════════════════════
# U3E — a narrative template interpolates the CITED FACT, not a
#       transform of it
# ══════════════════════════════════════════════════════════════════════
#
# U3 proper (numeric interpolation into FRONTEND narrative templates) is
# `scripts/check_narrative_units.mjs`. This is its engine-side sibling,
# and it exists because of a specific live failure mode: a rule that
# prints `abs(x)` while `facts_cited` stores the signed `x` produces a
# numeral that can NEVER be matched back to its fact — so it can never
# convert, and it keeps its RON label beside converted siblings.

#: Presentation transforms found inside a money interpolation in the
#: alert-rule templates. OWNED BY THE ENGINE-RULES LANE. Ratchet, as U1.
U3E_QUARANTINE = {
    "abs(revaluation_reserves)": "R6 prints abs(); facts_cited stores the signed value",
    "abs(cf_capex)": "R9 prints abs(); facts_cited.capex_real is negative",
    "abs(cip_capex)": "R9 prints abs(); facts_cited.capitalized_construction is negative",
    "total_liabilities + total_equity":
        "R1 prints a DERIVED SUM; both addends are cited but their sum is "
        "not, so the figure can never match a fact and can never convert. "
        "Latent — data_quality_bs_imbalance has no live rows today.",
}

_MONEY_FORMAT = re.compile(r":,\.\d+f$")


def _alert_template_interpolations():
    # type: () -> List[Tuple[int, str]]
    """(lineno, expression) for every money-formatted interpolation in a
    `_add(...)` title/body template inside `stage_validate`."""
    with io.open(PIPELINE_PY, "r", encoding="utf-8") as fh:
        tree = ast.parse(fh.read())
    found = []  # type: List[Tuple[int, str]]
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        name = getattr(func, "id", None) or getattr(func, "attr", None)
        if name != "_add":
            continue
        for arg in node.args[3:5]:          # title, body
            for part in ast.walk(arg):
                if not isinstance(part, ast.FormattedValue):
                    continue
                spec = ""
                if part.format_spec is not None:
                    spec = "".join(
                        v.value for v in ast.walk(part.format_spec)
                        if isinstance(v, ast.Constant) and isinstance(v.value, str))
                if not _MONEY_FORMAT.search(":" + spec):
                    continue
                found.append((part.lineno, _unparse(part.value)))
    return found


def _unparse(node):
    # type: (ast.AST) -> str
    # Python 3.9 has ast.unparse; keep a dumb fallback so the gate never
    # dies on the interpreter instead of on the defect.
    try:
        return ast.unparse(node)  # type: ignore[attr-defined]
    except Exception:  # pragma: no cover
        return ast.dump(node)


class TestU3EngineTemplates(object):

    def test_u3e_scan_finds_the_rule_templates_at_all(self):
        found = _alert_template_interpolations()
        assert len(found) >= 20, (
            "the _add() scanner found only %d money interpolations — it has "
            "stopped seeing the rules, so every assertion below is vacuous"
            % len(found))

    def test_u3e_money_interpolations_are_plain_facts(self):
        offenders = {}
        for lineno, expr in _alert_template_interpolations():
            if re.match(r"^[A-Za-z_][A-Za-z_0-9]*$", expr):
                continue                     # a bare name: the fact itself
            offenders.setdefault(expr, []).append(lineno)
        new = sorted(set(offenders) - set(U3E_QUARANTINE))
        gone = sorted(set(U3E_QUARANTINE) - set(offenders))
        assert not new, (
            "money interpolation(s) carrying a presentation transform: %s. "
            "Print the cited fact; if the sign is ugly, fix the fact or the "
            "renderer, not the string." % ({k: offenders[k] for k in new},))
        assert not gone, (
            "%s no longer appears — delete its U3E_QUARANTINE entry." % (gone,))

    def test_u3e_plant_a_transformed_money_interpolation_is_caught(self):
        # PLANT (in-memory, against the real scanner): the same shape as
        # the live R6/R9 offenders, on a name the quarantine does not
        # cover. It must be reported.
        module = ast.parse(
            "def stage_validate():\n"
            "    _add('k', 's', 'c',\n"
            "         f'Total RON {abs(planted_value):,.0f}',\n"
            "         f'body', {})\n")
        calls = [n for n in ast.walk(module) if isinstance(n, ast.Call)
                 and getattr(n.func, "id", None) == "_add"]
        assert calls, "plant did not parse"
        exprs = []
        for part in ast.walk(calls[0].args[3]):
            if isinstance(part, ast.FormattedValue):
                exprs.append(_unparse(part.value))
        assert exprs == ["abs(planted_value)"]
        assert not re.match(r"^[A-Za-z_][A-Za-z_0-9]*$", exprs[0]), (
            "the offender predicate would not have flagged the plant")


# ══════════════════════════════════════════════════════════════════════
# U4 — CROSS-SURFACE PARITY (and Part D, made permanent)
# ══════════════════════════════════════════════════════════════════════
#
# Part D of this lane's brief: recompute account 461's share NATIVELY and
# confirm it against the source trial balance row by row. That check ran
# live against period 11b8e759 on 2026-08-30; the rows it summed are the
# fixtures at the top of this file, so the verification now runs forever
# instead of being an experiment someone has to trust.

class TestU4CrossSurfaceParity(object):

    def test_u4_intercompany_fact_equals_its_source_rows_to_the_cent(self):
        total = round(sum(amount for _, _, amount in INTERCOMPANY_ROWS), 2)
        assert total == FACT_INTERCOMPANY_LOANS, (
            "the note's cited figure must BE the sum of the extracted rows")
        assert len(INTERCOMPANY_ROWS) == 4, (
            "assembled_canonical_v1.leaves.ar_intercompany"
            ".ras_line_items_count is 4")

    def test_u4_total_assets_fact_equals_its_source_rows_to_the_cent(self):
        by_bucket = {}
        for bucket, _code, amount in BS_ASSET_ROWS:
            by_bucket[bucket] = round(by_bucket.get(bucket, 0.0) + amount, 2)
        assert sorted(by_bucket) == sorted(LEGACY_ASSET_BUCKETS)
        total = round(sum(by_bucket[b] for b in LEGACY_ASSET_BUCKETS), 2)
        assert total == FACT_TOTAL_ASSETS, (
            "the note's denominator must BE the sum of the persisted "
            "statement rows the balance sheet and the export both read")

    @pytest.mark.skipif(_ru is None, reason=RATIO_LAW_MISSING)
    def test_u4_the_share_is_percent_identical_on_both_asset_authorities(self):
        # There are TWO total-asset authorities on this period and they
        # do NOT agree (see the next test). The ratio must survive that:
        # if the displayed percentage moved with the denominator's
        # provenance, the note would be unverifiable for a different
        # reason than currency.
        legacy = ratio(money(FACT_INTERCOMPANY_LOANS, "RON", name="intercompany_loans"),
                       money(FACT_TOTAL_ASSETS, "RON", name="total_assets"))
        canonical = ratio(money(FACT_INTERCOMPANY_LOANS, "RON", name="intercompany_loans"),
                          money(CANONICAL_BS_TOTAL_ASSETS, "RON", name="canonical_total_assets"))
        assert "%.1f" % (legacy * 100) == "%.1f" % (canonical * 100) == "19.6"

    def test_u4_the_two_asset_authorities_diverge_by_a_known_amount(self):
        canonical = round(sum(CANONICAL_BS_SECTION_SUBTOTALS.values()), 2)
        assert canonical == CANONICAL_BS_TOTAL_ASSETS
        bridge = round(sum(delta for _why, delta in LEGACY_VS_CANONICAL_BRIDGE), 2)
        assert round(canonical + bridge, 2) == FACT_TOTAL_ASSETS, (
            "the 124,935.63 gap between canonical_bs.totals.assets and "
            "assembled_bs.total_assets must reconcile line by line. If this "
            "fails, one of the two authorities moved and nobody said so.")

    def test_u4_percent_in_prose_matches_the_cited_ratio_fact(self):
        for shape in LIVE_ALERT_CORPUS:
            pct_facts = [(k, v) for k, v in shape["facts"].items()
                         if k.endswith("_pct") or k.startswith("pct_")]
            if not pct_facts:
                continue
            for _name, value in pct_facts:
                rendered = "%.1f%%" % (float(value) * 100.0)
                loose = "%.0f%%" % (float(value) * 100.0)
                blob = (shape["title"] or "") + " " + (shape["body"] or "")
                assert rendered in blob or loose in blob, (
                    "%s prose does not show its own cited ratio %s"
                    % (shape["rule"], rendered))


# ══════════════════════════════════════════════════════════════════════
# U6 — AI carries narrative; it never authors digits
# ══════════════════════════════════════════════════════════════════════
#
# The guard is the ai-boundary lane's (`src/engine/ai/numerals.py`). This
# gate does not re-test their module — it asserts the NARRATIVE-UNITS
# contract binds to it: a model-authored numeral is refused, and a claim
# carrying two currencies is refused, in the shape this lane cares about.
#
# If the module is absent the gate SKIPS LOUDLY rather than passing
# quietly: a silent skip is how a missing guard looks exactly like a
# working one.

try:
    from engine.ai import numerals
except Exception:  # pragma: no cover — the alarm path
    numerals = None

NUMERAL_GUARD_MISSING = (
    "!!! U6 NOT ENFORCED !!! engine.ai.numerals is missing, so nothing stops "
    "a model from writing a digit into narrative. This is the one law in "
    "this file with no fallback. Land the ai-boundary lane, or treat every "
    "AI-authored figure as unverified."
)


@pytest.mark.skipif(numerals is None, reason=NUMERAL_GUARD_MISSING)
class TestU6ModelNumerals(object):

    def _facts(self):
        return {
            "intercompany_loans": numerals.MoneyFact(FACT_INTERCOMPANY_LOANS, "RON"),
            "total_assets": numerals.MoneyFact(FACT_TOTAL_ASSETS, "RON"),
            "loan_share": numerals.RatioFact(FACT_PCT_OF_ASSETS, "ratio"),
            # An account CODE carries digits and is still not a figure —
            # the engine authored it, the model merely names it. Getting
            # this wrong is why the first draft of this gate failed: the
            # guard was right and the test was wrong.
            "account": numerals.LabelFact("461 (Debitori diverși)"),
        }

    def test_u6_placeholder_narrative_resolves_to_engine_digits(self):
        result = numerals.guard(
            "Account {account} holds {intercompany_loans} — {loan_share} of "
            "total assets {total_assets}.",
            self._facts(), fallback="", mode=numerals.MODE_ENFORCE)
        assert result.accepted, result.rejections
        assert "461" in result.text
        assert "7,692,202.74" in result.text
        assert "19.6%" in result.text

    def test_u6_plant_a_model_authored_numeral_is_rejected(self):
        # PLANT: the model does the FX arithmetic itself — the exact
        # thing chat-llm's currency directive asks it to do.
        result = numerals.guard(
            "Account 461 holds RON 7,692,203 — 19.6% of total assets "
            "7,467,122.25 EUR.",
            self._facts(), fallback="deterministic template",
            mode=numerals.MODE_ENFORCE)
        assert not result.accepted, "a bare numeral was accepted as narrative"
        codes = set(r.code for r in result.rejections)
        assert numerals.CODE_BARE_NUMERAL in codes, codes

    def test_u6_two_currencies_in_one_claim_is_a_rejection(self):
        facts = self._facts()
        facts["total_assets_eur"] = numerals.MoneyFact(7467122.25, "EUR")
        result = numerals.guard(
            "Account 461 holds {intercompany_loans} — {loan_share} of total "
            "assets {total_assets_eur}.",
            facts, fallback="deterministic template",
            mode=numerals.MODE_ENFORCE)
        assert not result.accepted, "U1 must hold for AI narrative too"
        codes = set(r.code for r in result.rejections)
        assert numerals.CODE_MIXED_CURRENCY in codes, codes

    def test_u6_absent_is_not_zero(self):
        facts = self._facts()
        facts["ebitda"] = numerals.MoneyFact(None, "RON")
        result = numerals.guard("EBITDA is {ebitda}.", facts,
                                fallback="", mode=numerals.MODE_ENFORCE)
        assert not result.accepted
        assert "0" not in result.text.replace("deterministic", "")
