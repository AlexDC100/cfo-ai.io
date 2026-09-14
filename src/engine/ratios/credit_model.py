"""The credit model — every calculated_metrics row, from one period's statements.

This is the arithmetic `pipeline.stage_compute` used to carry inline:
headline figures, the F1.d ratio rows, Altman Z'' (emerging-markets
variant) with X1..X4, the seven credit sub-scores, the composite and the
letter it maps to. It was moved here VERBATIM (2026-09-13, wave
ratios-b1) so that ONE pure function can be run on any period's served
statements — the current period and a prior alike — without a database.

PURE BY CONTRACT. `compute_period_metrics` reads its arguments and
returns rows. It opens no client, reads no clock, and writes nothing;
`stage_compute` keeps the persist block (delete + insert into
`calculated_metrics`) and delegates here for everything else.
`tests/engine/test_credit_model_pure.py` runs it with the Supabase admin
client stubbed to raise and holds its rows byte-identical to the rows
`stage_compute` inserted before the extraction.

ONE LADDER. `CREDIT_LETTER_LADDER` is the only statement of the
composite -> letter mapping. `composite_to_letter_grade` walks it and
`letter_grade_bands` serves it; `pipeline._composite_to_letter_grade`
and the `letter_grade_bands` field of `GET /api/period/{id}` both read
it. Before this module they were two copies that happened to agree.
`tests/engine/test_credit_ladder_single_source.py` keeps it one.

REVISION. `CREDIT_MODEL_REVISION` names this arithmetic. It is emitted
as a `credit_model_revision` row so a persisted composite can be dated
against the model that produced it. Change the weights, a sub-score
mapping, the Altman coefficients or the ladder and the revision moves
with them.

ABSENT IS NEVER ZERO (revision 2, 2026-09-15, ruling Q2). Revision 1 read a
book with no current liabilities as liquidity sub-score 0.0 (`if
current_liab > 0 else 0` on all three ratios) and divided Altman X4 by
`max(total_liabilities, 1)`: `saga_compact_6_col`, whose liabilities are all
zero, served X4 1500.0, Z'' 1584.89, liquidity 0.0 and composite 88.5 AA.
Revision 2 REFUSES instead: current liabilities not positive -> the
liquidity sub-score refuses (`current_liabilities_not_positive`); total
liabilities not positive -> X4 refuses, so Z'' and the Altman sub-score
refuse (`total_liabilities_not_positive`). The composite is the weighted
sum over the sub-scores that computed, with their weights renormalised to
sum to one (`applied_composite_weights`); `credit_block` serves the refused
sub-scores with their reasons and the weights the composite actually used.
A book with no refusal is computed by the same expression as revision 1,
byte for byte.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

#: The revision of the arithmetic below. Bump it on ANY change to what a
#: row means: a weight, a sub-score mapping, an Altman coefficient, a
#: ladder rung, a ratio's numerator or denominator.
CREDIT_MODEL_REVISION = 2

#: The calculated_metrics row name that carries `CREDIT_MODEL_REVISION`.
CREDIT_MODEL_REVISION_METRIC = "credit_model_revision"

#: Composite score -> letter grade (F1.h, SPEC section 10). Ordered from
#: the highest floor down; a composite takes the first grade whose floor
#: it reaches, and anything below every floor takes the last grade.
CREDIT_LETTER_LADDER: Tuple[Tuple[int, str], ...] = (
    (90, "AAA"),
    (80, "AA"),
    (70, "A"),
    (60, "BBB"),
    (50, "BB"),
    (40, "B"),
    (25, "CCC"),
    (0, "CC"),
)


#: Composite weights, by sub-score. The ONE statement: the composite below
#: multiplies by these and `GET /api/period` serves them
#: (`assembled_metrics.credit.composite_weights`). Before 2026-09-14 the
#: served weights were a second literal dict in `get_period`.
CREDIT_COMPOSITE_WEIGHTS: Dict[str, float] = {
    "altman": 0.30,
    "profitability": 0.20,
    "leverage": 0.15,
    "coverage": 0.10,
    "dscr": 0.10,
    "liquidity": 0.10,
    "equity": 0.05,
}

#: Altman Z'' zones (CLAUDE.md Appendix A section 7): safe from 2.60, grey
#: from 1.10, distress below. The sub-score mapping and `altman_zone` both
#: read these.
ALTMAN_SAFE_FROM = 2.60
ALTMAN_GREY_FROM = 1.10

#: The sub-score rows, keyed as the served `subscores` block keys them.
CREDIT_SUBSCORE_METRICS: Tuple[Tuple[str, str], ...] = (
    ("altman", "credit_subscore_altman"),
    ("profitability", "credit_subscore_profitability"),
    ("leverage", "credit_subscore_leverage"),
    ("coverage", "credit_subscore_coverage"),
    ("dscr", "credit_subscore_dscr"),
    ("liquidity", "credit_subscore_liquidity"),
    ("equity", "credit_subscore_equity"),
)

#: The reason a period carries no credit composite: the model names a
#: missing operand (today: total assets not positive, so no Altman).
CREDIT_INPUTS_ABSENT = "credit_inputs_absent"

#: Why a single sub-score refuses while the composite is still computed.
CURRENT_LIABILITIES_NOT_POSITIVE = "current_liabilities_not_positive"
TOTAL_LIABILITIES_NOT_POSITIVE = "total_liabilities_not_positive"
CREDIT_SUBSCORE_REFUSAL_CODES: Tuple[str, ...] = (
    CURRENT_LIABILITIES_NOT_POSITIVE,
    TOTAL_LIABILITIES_NOT_POSITIVE,
)

_CURRENT_LIABILITY_INPUTS = ("balanceSheet.accountsPayable", "balanceSheet.shortTermDebt",
                             "balanceSheet.otherCurrentLiabilities")

#: sub-score -> the refusal its row carries when it is absent beside a
#: computed composite. These are the ONLY two ways a sub-score refuses in
#: revision 2 (every other sub-score is computed whenever total assets are
#: positive), so a None sub-score row names its reason without guessing.
CREDIT_SUBSCORE_REFUSALS: Dict[str, Dict[str, Any]] = {
    "liquidity": {"code": CURRENT_LIABILITIES_NOT_POSITIVE,
                  "inputs": list(_CURRENT_LIABILITY_INPUTS)},
    "altman": {"code": TOTAL_LIABILITIES_NOT_POSITIVE,
               "inputs": list(_CURRENT_LIABILITY_INPUTS) + [
                   "balanceSheet.longTermDebt", "balanceSheet.otherNonCurrentLiabilities"]},
}


def applied_composite_weights(computed: Any) -> Dict[str, float]:
    """The weights the composite multiplies by, over the sub-scores that
    `computed` names. All seven computed -> `CREDIT_COMPOSITE_WEIGHTS`
    verbatim (no division, so a book with no refusal is byte-identical to
    revision 1); otherwise each computed weight divided by the sum of the
    computed weights, in the table's order."""
    keys = [k for k in CREDIT_COMPOSITE_WEIGHTS if k in set(computed)]
    if len(keys) == len(CREDIT_COMPOSITE_WEIGHTS):
        return dict(CREDIT_COMPOSITE_WEIGHTS)
    total = sum(CREDIT_COMPOSITE_WEIGHTS[k] for k in keys)
    if total <= 0:
        return {}
    return {k: CREDIT_COMPOSITE_WEIGHTS[k] / total for k in keys}


def altman_zone(z: Optional[float]) -> Optional[str]:
    """`safe` / `grey` / `distress` for a served Z'' (None stays None)."""
    if z is None:
        return None
    if z >= ALTMAN_SAFE_FROM:
        return "safe"
    if z >= ALTMAN_GREY_FROM:
        return "grey"
    return "distress"


def composite_to_letter_grade(composite: float) -> str:
    """The letter for a composite score, read off `CREDIT_LETTER_LADDER`.

    A composite below the lowest floor (negative is reachable: the
    liquidity sub-score is not clamped below zero) and a NaN both take
    the last rung, exactly as the if-chain this replaces did.
    """
    ladder = CREDIT_LETTER_LADDER
    for floor, grade in ladder:
        if composite >= floor:
            return grade
    return ladder[-1][1]


def letter_grade_bands() -> List[Dict[str, Any]]:
    """The ladder in the served shape: `[{"min": floor, "grade": letter}]`."""
    return [{"min": floor, "grade": grade} for floor, grade in CREDIT_LETTER_LADDER]


def compute_period_metrics(
    statements: Dict[str, Any],
    source_data_quality: Optional[Dict[str, Any]] = None,
) -> List[Dict[str, Any]]:
    """Every calculated_metrics row for one period, as `{name, value, unit,
    direction}` dicts, in the order `stage_compute` persists them.

    `statements` is the assembled statements block (`balanceSheet`,
    `incomeStatement`, `assembled_pl`, ...). `source_data_quality` is the
    TB fast-path telemetry block, or None when the extraction carried none.
    """
    s = statements
    bs = s["balanceSheet"]
    pl = s["incomeStatement"]

    revenue = pl["revenue"]
    cogs = pl["costOfGoodsSold"]
    opex = pl["operatingExpenses"]
    depreciation = pl["depreciationAmortization"]
    interest = pl["interestExpense"]
    other_inc = pl["otherIncome"]
    fin_inc = pl["financialIncome"]
    fin_exp = pl["financialExpense"]
    tax = pl["taxExpense"]
    # Inventory variation memo (RAS 711) — non-cash; EXCLUDED from cash EBITDA.
    # `other_inc` no longer contains it after the _ro_coa.py mapping fix; this
    # field is surfaced separately so the statutory-view metric can re-add it.
    inv_var_memo = pl.get("inventoryVariationMemo", 0.0)

    gross_profit = revenue - cogs
    operating_profit = gross_profit - opex - depreciation + other_inc
    ebitda = operating_profit + depreciation  # CASH view — primary
    ebitda_statutory_with_711 = ebitda + inv_var_memo  # IFRS / total-production view
    pretax = operating_profit + fin_inc - fin_exp - interest
    net_income = pretax - tax  # OPERATIONAL view — excludes account 722

    # ── Statutory net profit (anchors to account 121 closing balance) ──
    # Two valid views of "net profit" coexist in Romanian books:
    #   · net_income_operational — excludes 722 capitalized own-work. The
    #     "cash earnings" view a buyer or lender uses for EV / coverage.
    #   · net_income_statutory   — includes 722. This is what account 121
    #     closes to at year-end, what gets FILED with ANAF, and what a
    #     Romanian CFO sees on their own legal accounts.
    # Both are correct. We persist BOTH metrics so neither view is hidden;
    # the briefing + P&L tab default to the statutory figure (it's the
    # number a Romanian CFO recognizes from their filed accounts), and
    # operational stays available for valuation work.
    # For Scandia: 722 = ~2.21M → statutory 36.79M, operational 34.57M.
    # The values come from the canonical pl assembly (`_ro_coa.py`),
    # which already separates the two; pulling from there keeps the
    # arithmetic in ONE place rather than re-deriving here.
    capitalized_own_work = float(pl.get("capitalizedOwnWork", 0) or 0)
    # 2026-09-06 — the paragraph above has said "the values come from the
    # canonical pl assembly, which already separates the two; pulling from
    # there keeps the arithmetic in ONE place rather than re-deriving
    # here" since it was written. The code did not do that: it re-derived
    # `net_income + 722` and never saw the account-121 anchor the
    # canonical assembly applies (chart_of_accounts.py, rule F3.7d). So
    # ONE served response carried two numbers under one name —
    #
    #   book        assembled_pl.net_income_statutory   metrics.net_income_statutory
    #   agras                        7,533,676.02                    14,106,102.03
    #   carniprod                    1,435,533.59                     5,843,449.04
    #   realestate                    -801,604.14                   -30,391,418.38
    #   retail                       3,205,212.62                     1,161,957.98
    #
    # — and net_margin, roa, roe, free_cash_flow and the profitability
    # sub-score of the credit composite were all built on the right-hand
    # column while the report's headline stated the left-hand one.
    #
    # The intent is now the code, on the F3.15 `core_ebitda` precedent
    # below: the canonical assembly is the single source of truth and
    # this function is a READER. The local arithmetic survives only as
    # the fallback for an envelope that carries no canonical P&L (a
    # non-RO pack, or a pre-F1.a cached re-assembly) — where there is no
    # anchor to miss either.
    pl_canonical = s.get("assembled_pl") or {}
    if not isinstance(pl_canonical, dict):
        pl_canonical = {}

    def _canonical(name: str, fallback: float) -> float:
        value = pl_canonical.get(name)
        return fallback if value is None else float(value)

    net_income_statutory = _canonical(
        "net_income_statutory", net_income + capitalized_own_work
    )
    # Companion statutory views — symmetric with net_income_statutory.
    # ebitda_statutory  = cash EBITDA + 722 (includes capitalized own-work);
    # total_operating_revenue is the OPERATING revenue line the report's
    # build-up and the KPI tiles state (revenue + discounts received);
    # the total-production view that re-adds 722 + 711 + other income is a
    # DIFFERENT figure and now says so in its own name rather than
    # answering to `total_operating_revenue` as well.
    # Surfacing as named metrics so regression checks can query by exact name.
    ebitda_statutory = ebitda + capitalized_own_work
    total_operating_revenue_statutory = _canonical(
        "total_operating_revenue_statutory",
        revenue + capitalized_own_work + inv_var_memo + other_inc,
    )
    total_operating_revenue = _canonical(
        "total_operating_revenue", total_operating_revenue_statutory
    )

    current_assets = bs["cash"] + bs["accountsReceivable"] + bs["inventory"] + bs["otherCurrentAssets"]
    non_current_assets = bs["propertyPlantEquipment"] + bs["intangibles"] + bs["otherNonCurrentAssets"]
    total_assets = current_assets + non_current_assets

    current_liab = bs["accountsPayable"] + bs["shortTermDebt"] + bs["otherCurrentLiabilities"]
    non_current_liab = bs["longTermDebt"] + bs["otherNonCurrentLiabilities"]
    total_debt = bs["shortTermDebt"] + bs["longTermDebt"]
    total_equity = bs["shareCapital"] + bs["retainedEarnings"] + bs["otherEquity"]

    def safe(num: float, denom: float) -> Optional[float]:
        return None if denom == 0 else round(num / denom, 4)

    metrics: List[Dict[str, Any]] = [
        {"name": "revenue",            "value": round(revenue, 2),         "unit": "RON",   "direction": "higher"},
        {"name": "gross_profit",       "value": round(gross_profit, 2),    "unit": "RON",   "direction": "higher"},
        {"name": "ebitda",             "value": round(ebitda, 2),          "unit": "RON",   "direction": "higher"},
        # Explicit cash + statutory views so consumers don't need to recompute.
        {"name": "ebitda_cash",        "value": round(ebitda, 2),          "unit": "RON",   "direction": "higher"},
        {"name": "ebitda_statutory_with_711", "value": round(ebitda_statutory_with_711, 2), "unit": "RON", "direction": "higher"},
        {"name": "inventory_variation_memo",  "value": round(inv_var_memo, 2),               "unit": "RON", "direction": "neutral"},
        {"name": "operating_profit",   "value": round(operating_profit, 2),"unit": "RON",   "direction": "higher"},
        # `net_income` (existing) is the OPERATIONAL view — kept under the
        # existing key for back-compat. Old FE / briefing consumers see the
        # same number they always did. NEW callers should prefer the
        # explicit `net_income_statutory` (matches account 121 / oracle) or
        # `net_income_operational` (alias of net_income).
        {"name": "net_income",         "value": round(net_income, 2),      "unit": "RON",   "direction": "higher"},
        {"name": "net_income_operational", "value": round(net_income, 2),  "unit": "RON",   "direction": "higher"},
        {"name": "net_income_statutory",   "value": round(net_income_statutory, 2), "unit": "RON", "direction": "higher"},
        {"name": "ebitda_statutory",       "value": round(ebitda_statutory, 2),     "unit": "RON", "direction": "higher"},
        {"name": "total_operating_revenue","value": round(total_operating_revenue, 2),"unit": "RON","direction": "higher"},
        # The total-production view (revenue + 722 + 711 + other income),
        # under a name that means it. Until 2026-09-06 this number WAS
        # `total_operating_revenue` here while `assembled_pl` served the
        # operating line under the same name — agras 311,058,756.52 in one
        # half of the response and 118,576,819.64 in the other.
        {"name": "total_operating_revenue_statutory", "value": round(total_operating_revenue_statutory, 2), "unit": "RON", "direction": "higher"},
        {"name": "capitalized_own_work_memo", "value": round(capitalized_own_work, 2), "unit": "RON", "direction": "neutral"},
        {"name": "gross_margin",       "value": safe(gross_profit, revenue),"unit": "ratio","direction": "higher"},
        {"name": "ebitda_margin",      "value": safe(ebitda, revenue),     "unit": "ratio", "direction": "higher"},
        # ── Every ratio with net income in it reads the ANCHOR ─────────
        # net_margin / roa / roe / free_cash_flow below all take
        # `net_income_statutory` — account 121, the figure the KPI tile,
        # the dashboard headline, the chat context and the P&L build-up
        # all state. A ratio on the reconstruction would put a second net
        # income on the same page under a percent sign, which is exactly
        # what section 5 did (agras ROE 59.0% beside the tile's 31.5%).
        # `net_income` / `net_income_operational` above keep the
        # reconstruction, under names that say so.
        {"name": "net_margin",         "value": safe(net_income_statutory, revenue), "unit": "ratio", "direction": "higher"},
        {"name": "total_assets",       "value": round(total_assets, 2),    "unit": "RON",   "direction": "neutral"},
        {"name": "total_debt",         "value": round(total_debt, 2),      "unit": "RON",   "direction": "lower"},
        {"name": "total_equity",       "value": round(total_equity, 2),    "unit": "RON",   "direction": "higher"},
        {"name": "current_ratio",      "value": safe(current_assets, current_liab), "unit": "ratio", "direction": "higher"},
        {"name": "debt_to_equity",     "value": safe(total_debt, total_equity),     "unit": "ratio", "direction": "lower"},
        {"name": "debt_to_ebitda",     "value": safe(total_debt, ebitda),           "unit": "ratio", "direction": "lower"},
        {"name": "interest_coverage",  "value": safe(ebitda, interest),             "unit": "ratio", "direction": "higher"},
        {"name": "roa",                "value": safe(net_income_statutory, total_assets),  "unit": "ratio", "direction": "higher"},
        {"name": "roe",                "value": safe(net_income_statutory, total_equity),  "unit": "ratio", "direction": "higher"},
        {"name": "roic",               "value": safe(operating_profit * (1 - 0.16), max(total_debt + total_equity, 1)), "unit": "ratio", "direction": "higher"},
        {"name": "cash",               "value": round(bs["cash"], 2),              "unit": "RON",   "direction": "higher"},
        {"name": "free_cash_flow",     "value": round(net_income_statutory + depreciation, 2),"unit": "RON",  "direction": "higher"},
    ]

    # F3.11 — F3.9 source-data quality telemetry. Persisted as numeric
    # metrics so the FE can pick them up via remotePeriod.metrics without
    # a DB-schema migration (financial_periods has no metadata JSONB).
    # Two metrics — pct + abs — plus the warn flag derived FE-side from
    # pct > 2.0. Only emitted when the upstream stage_extract attached
    # source_data_quality (TB fast-paths; Claude-extracted path falls back
    # to None and skips these metrics entirely — `assembled.get(...) or {}`
    # makes the absence safe). See chart_of_accounts.assemble_statements
    # and pack.compute_source_imbalance for the upstream wiring.
    # F3.14 (3b) — Adjusted EBITDA + reconciliation components, read from
    # canonical assembled_pl (where the engine already computed them per
    # ADR_F3_14_DEFERRED_ITEMS.md). Operating EBITDA stays the headline;
    # adjusted_ebitda sits next to it on the dashboard with the two
    # subtracted lines (758 + 781) shown as the reconciliation bridge.
    pl_canonical_for_adj = s.get("assembled_pl") or {}
    if isinstance(pl_canonical_for_adj, dict):
        adj_ebitda_val = pl_canonical_for_adj.get("adjusted_ebitda")
        oi_758_val = pl_canonical_for_adj.get("other_income_758", 0) or 0
        oi_781_val = pl_canonical_for_adj.get("other_income_781_reversals", 0) or 0
        if adj_ebitda_val is None:
            # Fallback: compute from `ebitda` (cash view) − 758 − 781 if
            # canonical hasn't surfaced it yet (older cached fixtures).
            adj_ebitda_val = ebitda - float(oi_758_val) - float(oi_781_val)
        metrics.extend([
            {"name": "adjusted_ebitda",               "value": round(float(adj_ebitda_val), 2),
             "unit": "RON",   "direction": "higher"},
            {"name": "other_income_758",              "value": round(float(oi_758_val), 2),
             "unit": "RON",   "direction": "neutral"},
            {"name": "other_income_781_reversals",    "value": round(float(oi_781_val), 2),
             "unit": "RON",   "direction": "neutral"},
        ])

    sq = source_data_quality or {}
    if sq:
        metrics.extend([
            {"name": "source_imbalance_pct", "value": round(float(sq.get("raw_imbalance_pct") or 0.0), 4),
             "unit": "ratio", "direction": "lower"},
            {"name": "source_imbalance_abs", "value": round(float(sq.get("raw_imbalance_abs") or 0.0), 2),
             "unit": "RON", "direction": "lower"},
            {"name": "source_closing_debit_sum",  "value": round(float(sq.get("sum_closing_debit") or 0.0), 2),
             "unit": "RON", "direction": "neutral"},
            {"name": "source_closing_credit_sum", "value": round(float(sq.get("sum_closing_credit") or 0.0), 2),
             "unit": "RON", "direction": "neutral"},
        ])

    # ── F1.d additions (SPEC §3) — every ratio the FE displays, emitted
    # once here so the Tier-1 FE recompute sites in
    # AUDIT_FE_CANONICAL_CONFORMANCE.md can become pure readers (F3).
    # Each row consumes values that are now on assembled_pl / assembled_bs
    # (F1.a / F1.b), or that are already in scope as locals from the
    # stage_compute body. No new math; every field is either a ratio of
    # existing canonical values or a direct alias.
    ar = bs.get("accountsReceivable", 0.0)
    inventory = bs.get("inventory", 0.0)
    ap = bs.get("accountsPayable", 0.0)
    st_debt = bs.get("shortTermDebt", 0.0)
    lt_debt = bs.get("longTermDebt", 0.0)
    # `total_operating_expense` per the B1 closure: full opex (cogs + opex
    # + D&A), NOT narrow COGS. Mirrors the same value emitted on
    # assembled_pl in F1.a.
    total_operating_expense = cogs + pl.get("operatingExpenses", 0.0) + depreciation
    # F3.15 Chunk 1 — `core_ebitda` is now READ from the canonical
    # `assembled_pl.core_ebitda` field, NOT recomputed locally. The
    # canonical definition (chart_of_accounts.py:1418) is `ebitda_statutory
    # − 758 − 781` (per-account from line_items). The prior local
    # redefinition `ebitda_statutory − pl["otherIncome"]` quietly diverged
    # whenever otherIncome contained items beyond 758/781 (e.g., F3.10
    # semantic-fallback-routed accounts named "venituri din subventii"
    # → otherIncome, or any 74/75/77/78 catchall hits from F3.8). The
    # two definitions agreed when otherIncome ≡ {758, 781}, drifted
    # otherwise. F3.15 fix: canonical chart_of_accounts is the single
    # source of truth; pipeline becomes a reader. Fall back to the
    # local arithmetic only when the canonical field is missing (pre-
    # F3.14 cached re-assemblies that bypass the F1.a code path).
    pl_canonical_for_core = s.get("assembled_pl") or {}
    if isinstance(pl_canonical_for_core, dict) and "core_ebitda" in pl_canonical_for_core:
        core_ebitda = float(pl_canonical_for_core.get("core_ebitda") or 0.0)
    else:
        # Fallback: narrow definition matching chart_of_accounts.py:1418
        # exactly (the two named-account sums), so even the fallback path
        # agrees with the canonical answer.
        oi_758_fb = float(pl_canonical_for_core.get("other_income_758", 0.0) if isinstance(pl_canonical_for_core, dict) else 0.0)
        oi_781_fb = float(pl_canonical_for_core.get("other_income_781_reversals", 0.0) if isinstance(pl_canonical_for_core, dict) else 0.0)
        core_ebitda = ebitda_statutory - oi_758_fb - oi_781_fb
    net_debt = total_debt - bs.get("cash", 0.0)

    metrics.extend([
        # Liquidity
        {"name": "quick_ratio",          "value": safe(bs.get("cash", 0.0) + ar, current_liab),       "unit": "ratio", "direction": "higher"},
        {"name": "cash_ratio",           "value": safe(bs.get("cash", 0.0), current_liab),            "unit": "ratio", "direction": "higher"},
        {"name": "working_capital",      "value": round(current_assets - current_liab, 2),            "unit": "RON",   "direction": "higher"},
        {"name": "net_debt",             "value": round(net_debt, 2),                                 "unit": "RON",   "direction": "lower"},
        {"name": "net_debt_to_ebitda",   "value": safe(net_debt, ebitda_statutory),                   "unit": "ratio", "direction": "lower"},
        # Leverage
        {"name": "equity_ratio",         "value": safe(total_equity, total_assets),                   "unit": "ratio", "direction": "higher"},
        {"name": "debt_to_assets",       "value": safe(total_debt, total_assets),                     "unit": "ratio", "direction": "lower"},
        {"name": "lt_debt_to_equity",    "value": safe(lt_debt, total_equity),                        "unit": "ratio", "direction": "lower"},
        # Coverage
        {"name": "ebitda_to_interest",   "value": safe(ebitda_statutory, interest),                   "unit": "ratio", "direction": "higher"},
        {"name": "dscr",                 "value": safe(ebitda_statutory, interest + st_debt),         "unit": "ratio", "direction": "higher"},
        # 8-year amortization proxy for LT principal — methodology cheat
        # sheet calls this the "DSCR with LT principal" view.
        {"name": "dscr_with_lt_principal","value": safe(ebitda_statutory, interest + lt_debt / 8.0),   "unit": "ratio", "direction": "higher"},
        # Efficiency
        {"name": "asset_turnover",       "value": safe(revenue, total_assets),                        "unit": "ratio", "direction": "higher"},
        {"name": "dso",                  "value": safe(ar * 365, revenue),                            "unit": "days",  "direction": "lower"},
        {"name": "dio",                  "value": safe(inventory * 365, total_operating_expense),     "unit": "days",  "direction": "lower"},
        {"name": "dpo",                  "value": safe(ap * 365, total_operating_expense),            "unit": "days",  "direction": "higher"},
        # CCC composes the three above. None-safe in the FE; here we
        # surface only when all three components are computable.
        {"name": "ccc",                  "value": (
            None if (current_liab == 0 or revenue == 0 or total_operating_expense == 0)
            else round(
                (ar * 365 / revenue)
                + (inventory * 365 / total_operating_expense)
                - (ap * 365 / total_operating_expense),
                4,
            )
        ), "unit": "days", "direction": "lower"},
        {"name": "inventory_turnover",   "value": safe(total_operating_expense, inventory),           "unit": "ratio", "direction": "higher"},
        # Margins — operating_margin (operational EBIT) + core_ebitda_margin.
        # `operating_margin` here uses `operating_profit` (= OPERATIONAL
        # EBIT, 722-excluded). The statutory operating margin would use
        # `ebit_statutory` if we surfaced it; not in this batch.
        {"name": "operating_margin",     "value": safe(operating_profit, revenue),                    "unit": "ratio", "direction": "higher"},
        {"name": "core_ebitda_margin",   "value": safe(core_ebitda, revenue),                         "unit": "ratio", "direction": "higher"},
        # Core EBITDA itself — surfaced as a RON figure so the FE can
        # render the dual-basis card without recomputing.
        {"name": "core_ebitda",          "value": round(core_ebitda, 2),                              "unit": "RON",   "direction": "higher"},
    ])

    # ── Altman Z″ score (emerging-markets variant) + composite credit ──
    # Ported from archive/calibration_toolkit/financial_analysis.py build_credit_score().
    # The Z″ formula uses BOOK retained earnings (not net income), so this
    # is robust against a single-year loss; the composite score blends Z″
    # with profitability, leverage, coverage, DSCR, liquidity, and equity
    # ratio into a single 0-100 number, mapped to a letter grade A-D.
    # Surfaced on the dashboard's CreditScoreCard so the user sees one
    # headline trust signal before drilling into individual ratios.
    altman_z = None
    composite = None
    letter_grade = None
    if total_assets > 0:
        x1 = (current_assets - current_liab) / total_assets
        x2 = bs["retainedEarnings"] / total_assets
        x3 = operating_profit / total_assets
        # X4 = book equity / total liabilities. Revision 2: no liabilities
        # is ABSENT, not a divisor of 1 — X4, Z'' and the Altman sub-score
        # refuse (`total_liabilities_not_positive`). Revision 1 divided by
        # max(liabilities, 1) and served X4 1500.0 / Z'' 1584.89 on a book
        # with no liabilities at all.
        total_liab = current_liab + non_current_liab
        x4 = (total_equity / total_liab) if total_liab > 0 else None
        altman_subscore = None
        if x4 is not None:
            altman_z = 6.56 * x1 + 3.26 * x2 + 6.72 * x3 + 1.05 * x4

            # Map Z″ to a 0-100 sub-score with the same three-zone reading the
            # methodology uses (>2.60 safe, 1.10-2.60 grey, <1.10 distress).
            if altman_z >= ALTMAN_SAFE_FROM:
                altman_subscore = min(100, 70 + (altman_z - ALTMAN_SAFE_FROM) * 15)
            elif altman_z >= ALTMAN_GREY_FROM:
                altman_subscore = 40 + (altman_z - ALTMAN_GREY_FROM) * 20
            else:
                altman_subscore = max(0, altman_z * 36)

        # Profitability sub-score: blend ROE + net margin. ROE weighted 0.5×
        # to keep margin-led growth companies from looking weak.
        # Both take the ANCHOR — the same figure the `roe` and `net_margin`
        # metrics above now carry. A composite grade built on the
        # reconstruction while the page shows the filed figure is a
        # verdict on a number the reader is never given: agras scored 59.3
        # on profitability from 14.1M, where the filed 7.5M scores 31.7.
        roe_val = net_income_statutory / total_equity if total_equity > 0 else 0
        net_margin_val = net_income_statutory / revenue if revenue > 0 else 0
        prof_subscore = min(100, max(0, (roe_val * 100 * 0.5 + net_margin_val * 100 * 5) / 1.5))

        # Leverage sub-score (lower Net Debt/EBITDA = higher score). The
        # net_debt_ebitda formula uses CASH ebitda not statutory.
        net_debt = total_debt - bs["cash"]
        nde = net_debt / ebitda if ebitda > 0 else 999
        if nde <= 0:
            lev_subscore = 100
        elif nde <= 1.5:
            lev_subscore = 90
        elif nde <= 3.0:
            lev_subscore = 70
        elif nde <= 5.0:
            lev_subscore = 50
        else:
            lev_subscore = max(0, 50 - (nde - 5) * 10)

        # Interest coverage sub-score: EBIT / interest. 999 sentinel when
        # there's no interest (zero-debt company).
        ic = (operating_profit / interest) if interest > 0 else 999
        if ic >= 8:
            ic_subscore = 95
        elif ic >= 4:
            ic_subscore = 80
        elif ic >= 2:
            ic_subscore = 60
        elif ic >= 1:
            ic_subscore = 40
        else:
            ic_subscore = max(0, ic * 30)

        # DSCR — EBITDA / (interest + LT debt principal / 8 years).
        dscr = (ebitda / (interest + bs["longTermDebt"] / 8)) if interest > 0 else 999
        if dscr >= 2:
            dscr_subscore = 90
        elif dscr >= 1.25:
            dscr_subscore = 70
        else:
            dscr_subscore = max(0, dscr * 50)

        # Liquidity sub-score: blend of current / quick / cash ratios.
        # Revision 2: with no current liabilities the three ratios have no
        # base, so the sub-score REFUSES (`current_liabilities_not_positive`)
        # — revision 1 read each ratio as 0 and scored liquidity 0.0.
        liq_subscore = None
        if current_liab > 0:
            cur_ratio = current_assets / current_liab
            quick_ratio = (current_assets - bs["inventory"]) / current_liab
            cash_ratio = bs["cash"] / current_liab
            liq_subscore = (
                min(100, cur_ratio * 50) + min(100, quick_ratio * 80) + min(100, cash_ratio * 250)
            ) / 3

        # Equity ratio sub-score.
        eq_subscore = min(100, (total_equity / total_assets) * 200) if total_assets > 0 else 0

        # Composite — the methodology's weights over the sub-scores that
        # computed, renormalised when one refused (`applied_composite_weights`).
        # With all seven computed this is revision 1's sum, term for term.
        subscore_values = {
            "altman": altman_subscore, "profitability": prof_subscore,
            "leverage": lev_subscore, "coverage": ic_subscore, "dscr": dscr_subscore,
            "liquidity": liq_subscore, "equity": eq_subscore,
        }
        weights = applied_composite_weights(
            [k for k, v in subscore_values.items() if v is not None])
        composite = 0
        for key, weight in weights.items():
            composite = composite + weight * subscore_values[key]

        letter_grade = composite_to_letter_grade(composite)

        # Surface Altman + composite + sub-scores as calculated_metrics so the
        # CreditScoreCard renders without a separate DB query.
        def _r(v: Optional[float], places: int) -> Optional[float]:
            # A refused operand serves its row with value None: absent,
            # never a stale figure and never zero.
            return None if v is None else round(v, places)

        metrics.extend([
            {"name": "altman_z_score",       "value": _r(altman_z, 2),            "unit": "ratio", "direction": "higher"},
            {"name": "altman_x1",            "value": round(x1, 4),               "unit": "ratio", "direction": "higher"},
            {"name": "altman_x2",            "value": round(x2, 4),               "unit": "ratio", "direction": "higher"},
            {"name": "altman_x3",            "value": round(x3, 4),               "unit": "ratio", "direction": "higher"},
            {"name": "altman_x4",            "value": _r(x4, 4),                  "unit": "ratio", "direction": "higher"},
            {"name": "credit_composite",     "value": round(composite, 1),        "unit": "score", "direction": "higher"},
            {"name": "credit_subscore_altman",       "value": _r(altman_subscore, 1),     "unit": "score", "direction": "higher"},
            {"name": "credit_subscore_profitability","value": round(prof_subscore, 1),    "unit": "score", "direction": "higher"},
            {"name": "credit_subscore_leverage",     "value": round(lev_subscore, 1),     "unit": "score", "direction": "higher"},
            {"name": "credit_subscore_coverage",     "value": round(ic_subscore, 1),      "unit": "score", "direction": "higher"},
            {"name": "credit_subscore_dscr",         "value": round(dscr_subscore, 1),    "unit": "score", "direction": "higher"},
            {"name": "credit_subscore_liquidity",    "value": _r(liq_subscore, 1),        "unit": "score", "direction": "higher"},
            {"name": "credit_subscore_equity",       "value": round(eq_subscore, 1),      "unit": "score", "direction": "higher"},
        ])
        logger.info(
            "[pipeline] credit: Altman Z″=%s composite=%.0f → grade %s",
            "refused" if altman_z is None else "%.2f" % altman_z, composite, letter_grade,
        )

    # ── The revision stamp (2026-09-13) ────────────────────────────────
    # One row naming the model revision this arithmetic IS, so a
    # persisted composite can later be dated against the model that
    # produced it. Rows persisted before this stamp carry none and read
    # as "revision unknown" — they are never backfilled, because a
    # backfill would overwrite the as-filed evidence.
    metrics.append(
        {"name": CREDIT_MODEL_REVISION_METRIC, "value": CREDIT_MODEL_REVISION,
         "unit": "revision", "direction": "neutral"}
    )
    return metrics


def _rows_by_name(rows: Any) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    for row in rows or []:
        if isinstance(row, dict) and isinstance(row.get("name"), str):
            out[row["name"]] = row.get("value")
    return out


def _num(v: Any) -> Optional[float]:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    return float(v)


#: Every `calculated_metrics` row the credit model owns: what a served
#: credit card reads (financialValuation.ts `mergeEngineEnvelope` takes
#: these rows FIRST and the credit envelope only where a row is absent).
CREDIT_FAMILY_METRICS: Tuple[str, ...] = (
    "altman_z_score", "altman_x1", "altman_x2", "altman_x3", "altman_x4",
    "credit_composite",
) + tuple(name for _k, name in CREDIT_SUBSCORE_METRICS) + (CREDIT_MODEL_REVISION_METRIC,)


def serve_credit_rows(
    persisted_rows: Optional[List[Dict[str, Any]]],
    serve_rows: List[Dict[str, Any]],
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """`(served_rows, as_filed_rows)` for a response whose credit envelope
    is the serve-time model.

    A card that read the persisted composite beside a letter banded from
    the serve-time composite would print two models as one verdict, so
    the credit-family rows are served from `serve_rows` too: a persisted
    row keeps its position and takes the serve-time value; a persisted
    row the serve-time model does not emit is DROPPED (absent stays
    absent, never the stale figure). Nothing is appended: a period with no
    persisted credit row serves none, and every card then reads the
    envelope, which is the same serve-time result (and a period with no
    persisted rows at all keeps serving `metrics: []`, which the ratio
    fallbacks are keyed on). Every other row is untouched.
    `as_filed_rows` are the persisted credit-family rows, verbatim — the
    as-filed evidence `credit_block` discloses from."""
    family = set(CREDIT_FAMILY_METRICS)
    serve_by_name = {r["name"]: r for r in serve_rows
                     if isinstance(r, dict) and r.get("name") in family}
    served: List[Dict[str, Any]] = []
    as_filed: List[Dict[str, Any]] = []
    seen = set()
    for row in persisted_rows or []:
        name = row.get("name") if isinstance(row, dict) else None
        if name not in family:
            served.append(row)
            continue
        as_filed.append(dict(row))
        replacement = serve_by_name.get(name)
        if replacement is None or name in seen:
            continue
        seen.add(name)
        served.append(dict(row, value=replacement.get("value"), unit=replacement.get("unit"),
                           direction=replacement.get("direction")))
    return served, as_filed


def _refused_subscores(subscores: Dict[str, Optional[float]]) -> Dict[str, Dict[str, Any]]:
    """Every absent sub-score beside a computed composite, with the reason
    `CREDIT_SUBSCORE_REFUSALS` names for it (`credit_inputs_absent` for a
    sub-score the model has no refusal rule for)."""
    out: Dict[str, Dict[str, Any]] = {}
    for key, value in subscores.items():
        if value is None:
            refusal = CREDIT_SUBSCORE_REFUSALS.get(key) or {
                "code": CREDIT_INPUTS_ABSENT, "inputs": ["credit_model.%s" % key]}
            out[key] = {"code": refusal["code"], "inputs": list(refusal["inputs"])}
    return out


def as_filed_applied_weights(
    rows: Optional[List[Dict[str, Any]]],
) -> Tuple[Dict[str, float], Dict[str, Dict[str, Any]]]:
    """The weights a PERSISTED composite was multiplied by, and the
    sub-scores it was scored without — read off the persisted rows, for the
    `basis: as_filed` credit envelope (served when the serve-time model
    cannot run).

    Revision 2 or later with a composite: `applied_composite_weights` over
    the persisted sub-score rows that carry a value, and the absent ones as
    refused with their model reason — the same two fields `credit_block`
    serves. A composite persisted before revision 2 (stamp 1 or no stamp)
    was multiplied by the model table whatever its rows carry, so it serves
    the model table and no refusal: renormalising it here would state a
    weighting that composite never had. No composite -> the model table."""
    m = _rows_by_name(rows)
    composite = _num(m.get("credit_composite"))
    revision = _num(m.get(CREDIT_MODEL_REVISION_METRIC))
    if composite is None or revision is None or revision < 2:
        return dict(CREDIT_COMPOSITE_WEIGHTS), {}
    subscores = {k: _num(m.get(name)) for k, name in CREDIT_SUBSCORE_METRICS}
    return (applied_composite_weights([k for k, v in subscores.items() if v is not None]),
            _refused_subscores(subscores))


def credit_block(
    rows: List[Dict[str, Any]],
    as_filed_rows: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    """The served CreditBlock for one period, read off ITS OWN
    `compute_period_metrics` rows (the serve-time model), with the
    persisted `calculated_metrics` rows as the as-filed evidence.

    Values are the model's stored rows (Z'' at 2dp, composite and
    sub-scores at 1dp); the zone and the letter are read off those same
    printed figures, so the zone beside a 2.60 never disagrees with it.

    Revision 2: `refused_subscores` names every sub-score that refused
    beside a computed composite, with its reason
    (`CREDIT_SUBSCORE_REFUSALS`); `weights` are the weights the composite
    multiplied by (`applied_composite_weights` over the sub-scores that
    computed — the model table itself when none refused) and
    `model_weights` the table they were renormalised from.
    `as_filed` is served ONLY when the persisted composite, Z'' or letter
    differs from the served one at that same precision (after a
    reanalyze, which never recomputes metrics, or for rows persisted
    before a model change); persisted rows with no revision stamp print
    revision "unknown". No persisted rows at all -> `as_filed` null and
    `as_filed_differs` false: nothing was filed to differ from.
    """
    m = _rows_by_name(rows)
    z = _num(m.get("altman_z_score"))
    composite = _num(m.get("credit_composite"))
    letter = None if composite is None else composite_to_letter_grade(composite)
    subscores = {k: _num(m.get(name)) for k, name in CREDIT_SUBSCORE_METRICS}
    refused_subscores: Dict[str, Dict[str, Any]] = (
        _refused_subscores(subscores) if composite is not None else {})
    block: Dict[str, Any] = {
        "revision": CREDIT_MODEL_REVISION,
        "altman": {
            "z": z,
            "x1": _num(m.get("altman_x1")),
            "x2": _num(m.get("altman_x2")),
            "x3": _num(m.get("altman_x3")),
            "x4": _num(m.get("altman_x4")),
            "zone": altman_zone(z),
            "thresholds": {"grey_from": ALTMAN_GREY_FROM, "safe_from": ALTMAN_SAFE_FROM},
        },
        "subscores": subscores,
        "refused_subscores": refused_subscores,
        "weights": (applied_composite_weights([k for k, v in subscores.items() if v is not None])
                    if composite is not None else dict(CREDIT_COMPOSITE_WEIGHTS)),
        "model_weights": dict(CREDIT_COMPOSITE_WEIGHTS),
        "composite": composite,
        "letter": letter,
        "ladder": letter_grade_bands(),
        "reason": None if composite is not None else {
            "code": CREDIT_INPUTS_ABSENT, "inputs": ["balanceSheet.total_assets"]},
        "as_filed": None,
        "as_filed_differs": False,
    }
    filed = _rows_by_name(as_filed_rows)
    if not filed:
        return block
    f_z = _num(filed.get("altman_z_score"))
    f_c = _num(filed.get("credit_composite"))
    f_l = None if f_c is None else composite_to_letter_grade(f_c)
    f_rev = _num(filed.get(CREDIT_MODEL_REVISION_METRIC))

    def _q(v: Optional[float], places: int) -> Optional[str]:
        return None if v is None else "%.*f" % (places, round(v, places))

    differs = (_q(f_z, 2) != _q(z, 2)) or (_q(f_c, 1) != _q(composite, 1)) or (f_l != letter)
    block["as_filed_differs"] = bool(differs)
    if differs:
        block["as_filed"] = {
            "composite": f_c,
            "altman_z": f_z,
            "letter": f_l,
            "credit_model_revision": int(f_rev) if f_rev is not None else "unknown",
        }
    return block
