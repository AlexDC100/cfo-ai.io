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

ABSENT IS NEVER ZERO, AND NEVER A FLOOR (revision 2, 2026-09-15, rulings
Q2 corrected, R-COMPOSITE, R-D4). Revision 1 read a book with no current
liabilities as liquidity sub-score 0.0 (`if current_liab > 0 else 0` on all
three ratios) and divided Altman X4 by `max(total_liabilities, 1)`:
`saga_compact_6_col`, whose liabilities are all zero, served X4 1500.0, Z''
1584.89, liquidity 0.0 and composite 88.5 AA. Revision 2 REFUSES instead:

  · current liabilities not positive -> the liquidity sub-score refuses
    (`current_liabilities_not_positive`);
  · total liabilities below the pack's materiality share of total assets
    (`packs/credit/model.yaml`, 1%) -> X4 refuses, so Z'', the zone and the
    Altman sub-score refuse (`total_liabilities_below_materiality`);
  · any sub-score refused -> the COMPOSITE AND THE LETTER REFUSE
    (`credit_component_undefined`), and the refusal lists every refused
    component with its code, inputs and text.

⚠ THE WEIGHTS ARE NEVER REDISTRIBUTED. An earlier cut of this revision
renormalised the weights over the sub-scores that computed and still served
a composite and a letter. Measured on the real GET /api/period route:
`corpus/imbalance_03pct` (cash 1,000,000, share capital 997,000, no
liabilities, empty P&L) served 39.2 CCC over 60% of the model, and a book
with 1 RON of liabilities served Z'' 10,416.74 "safe" and 63.5 BBB. A
composite scored over part of its model is a different model wearing its
name. A book with no refusal is computed by the same expression as
revision 1, byte for byte.
"""

from __future__ import annotations

import logging
import math
from decimal import Decimal
from typing import Any, Dict, List, Mapping, Optional, Tuple

from engine.ratios.credit_pack import CREDIT_PACK_FILE, credit_pack, share_percent, x4_materiality_share

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
#: served weights were a second literal dict in `get_period`. They are
#: NEVER renormalised: a composite with a refused component refuses.
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

#: The reason a period carries no credit composite at all: the model did
#: not run (total assets not positive).
CREDIT_INPUTS_ABSENT = "credit_inputs_absent"

#: Why a single sub-score refuses (revision 2). Any one makes the composite
#: refuse. The first four are PREDICATES over the statements (one function,
#: `component_refusals`, decides them for the model and for the served
#: block alike); the fifth is found AFTER composition, when a computed value
#: lies outside its pack-declared range (R-RANGE).
CURRENT_LIABILITIES_NOT_POSITIVE = "current_liabilities_not_positive"
TOTAL_LIABILITIES_BELOW_MATERIALITY = "total_liabilities_below_materiality"
REVENUE_NOT_POSITIVE = "revenue_not_positive"
INTEREST_EXPENSE_NOT_POSITIVE = "interest_expense_not_positive"
CREDIT_OUT_OF_RANGE = "credit_out_of_range"
CREDIT_SUBSCORE_REFUSAL_CODES: Tuple[str, ...] = (
    CURRENT_LIABILITIES_NOT_POSITIVE,
    TOTAL_LIABILITIES_BELOW_MATERIALITY,
    REVENUE_NOT_POSITIVE,
    INTEREST_EXPENSE_NOT_POSITIVE,
    CREDIT_OUT_OF_RANGE,
)

#: Why the composite and the letter refuse when a component is undefined.
CREDIT_COMPONENT_UNDEFINED = "credit_component_undefined"

# ── the credit pack (packs/credit/model.yaml) ────────────────────────────────
#
# Every threshold, rung and range is pack DATA, read by
# `engine.ratios.credit_pack` — the one module allowed to open it, so this
# module stays free of files, clients and clocks
# (`test_credit_model_pure.test_the_credit_model_imports_no_client`).

_CURRENT_LIABILITY_INPUTS = ("balanceSheet.accountsPayable", "balanceSheet.shortTermDebt",
                             "balanceSheet.otherCurrentLiabilities")

_TOTAL_LIABILITY_INPUTS = _CURRENT_LIABILITY_INPUTS + (
    "balanceSheet.longTermDebt", "balanceSheet.otherNonCurrentLiabilities")

_DEBT_INPUTS = ("balanceSheet.shortTermDebt", "balanceSheet.longTermDebt")

#: The inputs each predicate refusal names.
_REFUSAL_INPUTS: Dict[str, List[str]] = {
    CURRENT_LIABILITIES_NOT_POSITIVE: list(_CURRENT_LIABILITY_INPUTS),
    TOTAL_LIABILITIES_BELOW_MATERIALITY: list(_TOTAL_LIABILITY_INPUTS) + ["balanceSheet.total_assets"],
    REVENUE_NOT_POSITIVE: ["incomeStatement.revenue"],
    INTEREST_EXPENSE_NOT_POSITIVE: ["incomeStatement.interestExpense"] + list(_DEBT_INPUTS)
    + ["incomeStatement.operating_profit"],
}


def _operands(bs: Dict[str, Any], interest: float, ebit: float, ebitda: float,
              revenue: float) -> Dict[str, Any]:
    """The primitives every predicate below reads, from the statements'
    leaves — the SAME arithmetic `compute_period_metrics` uses for its
    rows, so a predicate and a row cannot disagree about an operand."""
    current_assets = bs["cash"] + bs["accountsReceivable"] + bs["inventory"] + bs["otherCurrentAssets"]
    non_current_assets = bs["propertyPlantEquipment"] + bs["intangibles"] + bs["otherNonCurrentAssets"]
    total_assets = current_assets + non_current_assets
    current_liab = bs["accountsPayable"] + bs["shortTermDebt"] + bs["otherCurrentLiabilities"]
    total_liab = current_liab + bs["longTermDebt"] + bs["otherNonCurrentLiabilities"]
    total_debt = bs["shortTermDebt"] + bs["longTermDebt"]
    total_equity = bs["shareCapital"] + bs["retainedEarnings"] + bs["otherEquity"]
    return {
        "total_assets": total_assets,
        "current_liab_positive": current_liab > 0,
        "total_liab": total_liab,
        "tl_material": (total_liab > 0 and Decimal(repr(float(total_liab)))
                        >= x4_materiality_share() * Decimal(repr(float(total_assets)))),
        "total_debt": total_debt,
        "interest_positive": interest > 0,
        "interest_zero": interest == 0,
        "ebit": ebit,
        "ebitda": ebitda,
        "net_debt": total_debt - bs["cash"],
        "total_equity": total_equity,
        "equity_ratio": (total_equity / total_assets) if total_assets > 0 else None,
        "revenue": revenue,
    }


def statement_operands(statements: Mapping[str, Any]) -> Optional[Dict[str, Any]]:
    """`_operands` from a served statements block — the entry point a
    served block uses to run the SAME predicates the model ran.

    None when the block does not carry both statements with every leaf the
    operands read. There is NO fallback to the model's own rows: a row
    absent from persisted rows is absent, never 0.0, and a rung declared
    from a 0.0 that was never measured is a labelled top rung on a book
    with debt (the B8 verifier's probe: agras with its total_debt row
    removed was declared "no interest-bearing debt"). With no operands,
    nothing is declared and every withheld row refuses as
    `credit_inputs_absent`."""
    if not isinstance(statements, Mapping):
        return None
    bs = statements.get("balanceSheet")
    pl = statements.get("incomeStatement")
    if not isinstance(bs, Mapping) or not isinstance(pl, Mapping):
        return None
    try:
        gross_profit = pl["revenue"] - pl["costOfGoodsSold"]
        ebit = gross_profit - pl["operatingExpenses"] - pl["depreciationAmortization"] + pl["otherIncome"]
        return _operands(bs, pl["interestExpense"], ebit, ebit + pl["depreciationAmortization"], pl["revenue"])
    except (KeyError, TypeError):
        return None


def component_refusals(ops: Dict[str, Any]) -> Dict[str, str]:
    """THE predicate: which sub-scores refuse on these operands, by code.
    Run by the model to decide, and by the served block to label — one
    function, so the two cannot disagree.

      liquidity     current liabilities not positive            (Q2)
      altman        total liabilities below the pack share of TA (R-D4)
      profitability revenue not positive                        (R-D2)
      coverage/dscr interest not positive, and not the R-D1 rung
                    (debt == 0, interest == 0, EBIT > 0)        (R-D1)

    A refusal after composition (`credit_out_of_range`) is not a predicate;
    the block finds it on the rows."""
    out: Dict[str, str] = {}
    if not ops["current_liab_positive"]:
        out["liquidity"] = CURRENT_LIABILITIES_NOT_POSITIVE
    if not ops["tl_material"]:
        out["altman"] = TOTAL_LIABILITIES_BELOW_MATERIALITY
    if not ops["revenue"] > 0:
        out["profitability"] = REVENUE_NOT_POSITIVE
    if not ops["interest_positive"] and "coverage" not in declared_rungs(ops):
        out["coverage"] = INTEREST_EXPENSE_NOT_POSITIVE
        out["dscr"] = INTEREST_EXPENSE_NOT_POSITIVE
    return out


def declared_rungs(ops: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    """Which sub-scores take a DECLARED rung on these operands, with the
    pack's rung (`{rung, score, when, label, source, file}`) — stated, not
    measured, and served labelled so no surface prints it as a measurement.

      coverage, dscr  no interest-bearing debt: debt == 0, interest == 0
                      and EBIT > 0, all measured                   (R-D1)
      leverage        EBITDA <= 0 with net debt > 0, both measured (R-D3)
      equity          equity ratio <= 0, measured                  (R-D2)
    """
    pack = credit_pack()["declared_rungs"]
    out: Dict[str, Dict[str, Any]] = {}
    if ops["total_debt"] == 0 and ops["interest_zero"] and ops["ebit"] > 0:
        out["coverage"] = dict(pack["coverage"])
        out["dscr"] = dict(pack["dscr"])
    if ops["net_debt"] > 0 and not ops["ebitda"] > 0:
        out["leverage"] = dict(pack["leverage"])
    if ops["equity_ratio"] is not None and ops["equity_ratio"] <= 0:
        out["equity"] = dict(pack["equity"])
    return out


def profitability_disclosure(ops: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """R-D2: with book equity not positive and revenue positive, ROE is
    undefined and the sub-score is the net-margin term alone — the pack's
    disclosed variant, served on the block."""
    if ops["revenue"] > 0 and ops["total_equity"] <= 0:
        return dict(credit_pack()["profitability_roe_undefined"])
    return None


def credit_ranges(x2: Optional[float] = None, x3: Optional[float] = None) -> Dict[str, Any]:
    """The pack-declared ranges every served score is read against, with
    the Z'' bound DERIVED for this book from the bounded components (X1's
    and X4's pack maxima) and the book's own measured X2 and X3, printed
    with its derivation (R-RANGE). `altman_z.bound` is None when X2 or X3
    is not given."""
    r = credit_pack()["ranges"]
    x1_max, x4_max = r["altman_x1"]["max"], r["altman_x4"]["max"]
    bound = None
    if x2 is not None and x3 is not None and math.isfinite(x2) and math.isfinite(x3):
        bound = 6.56 * x1_max + 3.26 * x2 + 6.72 * x3 + 1.05 * x4_max
    return {
        "subscore": dict(r["subscore"]),
        "composite": dict(r["composite"]),
        "altman_x1": dict(r["altman_x1"]),
        "altman_x4": dict(r["altman_x4"]),
        "altman_z": dict(r["altman_z"], bound=bound,
                         derivation=None if bound is None else
                         "6.56 x %s + 3.26 x %s + 6.72 x %s + 1.05 x %s = %s"
                         % (format(x1_max, "g"), format(x2, "g"), format(x3, "g"), format(x4_max, "g"),
                            format(bound, ".4f"))),
    }


def _in_range(v: Optional[float], lo: Optional[float], hi: Optional[float]) -> bool:
    if v is None or isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
        return False
    return (lo is None or v >= lo) and (hi is None or v <= hi)


def score_out_of_range(v: Optional[float], which: str = "subscore") -> bool:
    """True when a computed sub-score or composite is not finite or lies
    outside its pack range. None is not out of range — it is absent."""
    if v is None:
        return False
    r = credit_pack()["ranges"][which]
    return not _in_range(v, r["min"], r["max"])


def altman_out_of_range(x1: Optional[float], x2: Optional[float], x3: Optional[float],
                        x4: Optional[float], z: Optional[float]) -> Optional[str]:
    """The first Altman figure outside its declared range (`altman_x1`,
    `altman_x2`, `altman_x3`, `altman_x4` or `altman_z_score`), or None when
    all are in range. Absent figures are not checked."""
    ranges = credit_ranges(x2, x3)
    if x1 is not None and not _in_range(x1, None, ranges["altman_x1"]["max"]):
        return "altman_x1"
    for name, v in (("altman_x2", x2), ("altman_x3", x3)):
        if v is not None and not _in_range(v, None, None):
            return name
    if x4 is not None and not _in_range(x4, None, ranges["altman_x4"]["max"]):
        return "altman_x4"
    if z is not None and not _in_range(z, None, ranges["altman_z"]["bound"]):
        return "altman_z_score"
    return None


def subscore_refusal(key: str, code: Optional[str] = None,
                     out_of_range_input: Optional[str] = None) -> Dict[str, Any]:
    """The served refusal of one sub-score: `{code, component, inputs, text}`
    and, for the Altman materiality refusal, the pack materiality it was
    read against (`materiality: {share, basis, source, file}`) — the
    threshold rendered from the pack, never written as prose (TC-10). A
    `credit_out_of_range` refusal names the figure that left its range and
    the range it was read against."""
    code = code or CREDIT_INPUTS_ABSENT
    out: Dict[str, Any] = {"code": code, "component": key,
                           "inputs": list(_REFUSAL_INPUTS.get(code, ["credit_model.%s" % key]))}
    if code == TOTAL_LIABILITIES_BELOW_MATERIALITY:
        pack = credit_pack()
        out["materiality"] = {"share": format(pack["share"], "f"), "basis": pack["basis"],
                              "source": pack["source"], "file": pack["file"]}
        out["text"] = (
            "Altman Z'' is not scored: total liabilities are below %s of total assets for this "
            "period (%s), so X4 (equity / total liabilities) is not defined, and neither are "
            "Z'', its zone or the Altman component." % (share_percent(pack["share"]), pack["file"]))
    elif code == CURRENT_LIABILITIES_NOT_POSITIVE:
        out["text"] = ("The liquidity component is not scored: current liabilities are not positive "
                       "for this period, so the current, quick and cash ratios have no base.")
    elif code == REVENUE_NOT_POSITIVE:
        out["text"] = ("The profitability component is not scored: revenue is not positive for this "
                       "period, so net margin (and with it the blend) is not defined.")
    elif code == INTEREST_EXPENSE_NOT_POSITIVE:
        rung = credit_pack()["declared_rungs"]["coverage"]
        out["text"] = (
            "The %s component is not scored: interest expense is not positive for this period, so "
            "%s is not measured, and the declared rung does not apply (it applies only when %s; %s)."
            % ("interest-coverage" if key == "coverage" else "DSCR",
               "EBIT / interest" if key == "coverage" else "EBITDA / debt service",
               rung["when"], rung["file"]))
    elif code == CREDIT_OUT_OF_RANGE:
        figure = out_of_range_input or "credit_subscore_%s" % key
        out["inputs"] = [figure]
        ranges = credit_pack()["ranges"]
        if figure == "credit_composite":
            r = ranges["composite"]
            rng = "[%g, %g]" % (r["min"], r["max"])
        elif figure == "altman_x1":
            rng = "<= %g" % ranges["altman_x1"]["max"]
        elif figure == "altman_x4":
            rng = "<= %g (%s)" % (ranges["altman_x4"]["max"], ranges["altman_x4"]["max_is"])
        elif figure == "altman_z_score":
            rng = "finite and <= %s" % ranges["altman_z"]["bound_is"]
        elif figure in ("altman_x2", "altman_x3"):
            rng = "finite"
        else:
            r = ranges["subscore"]
            rng = "[%g, %g]" % (r["min"], r["max"])
        out["range"] = rng
        out["text"] = ("The %s component is not scored: %s lies outside its declared range (%s; %s), "
                       "so the value is withheld rather than served." % (key, figure, rng, CREDIT_PACK_FILE))
    else:
        out["text"] = "The %s component is not scored: the model's inputs for it were not filed." % key
    return out


def composite_refusal(refused: Dict[str, Dict[str, Any]]) -> Dict[str, Any]:
    """The composite's (and the letter's) refusal when components refused:
    `{code: credit_component_undefined, inputs, components: [...]}`, every
    refused component listed in the model's order with its own refusal.
    The weights are not redistributed, so there is no composite to state."""
    components = [dict(refused[k], code=CREDIT_COMPONENT_UNDEFINED, cause=refused[k]["code"])
                  for k in CREDIT_COMPOSITE_WEIGHTS if k in refused]
    return {
        "code": CREDIT_COMPONENT_UNDEFINED,
        "inputs": ["credit_model.%s" % c["component"] for c in components],
        "components": components,
        "text": "No composite and no letter: the model's weights are not redistributed over the "
                "components that scored, and %s did not score. %s" % (
                    " and ".join(c["component"] for c in components),
                    " ".join(c["text"] for c in components)),
    }


def composite_out_of_range_refusal(composite: Optional[float]) -> Dict[str, Any]:
    """The composite's refusal when it was composed and left its range."""
    r = credit_pack()["ranges"]["composite"]
    return {
        "code": CREDIT_OUT_OF_RANGE,
        "inputs": ["credit_composite"],
        "range": "[%g, %g]" % (r["min"], r["max"]),
        "components": [],
        "text": "No composite and no letter: the composed value%s lies outside the model's declared "
                "range [%g, %g] (%s), so it is withheld." % (
                    "" if composite is None else " %r" % composite, r["min"], r["max"], CREDIT_PACK_FILE),
    }


def altman_zone(z: Optional[float]) -> Optional[str]:
    """`safe` / `grey` / `distress` for a served Z'' (None stays None)."""
    if z is None:
        return None
    if z >= ALTMAN_SAFE_FROM:
        return "safe"
    if z >= ALTMAN_GREY_FROM:
        return "grey"
    return "distress"


def composite_to_letter_grade(composite: Optional[float]) -> Optional[str]:
    """The letter for a composite score, read off `CREDIT_LETTER_LADDER` —
    or NONE.

    A letter is minted only from a composite that exists and lies inside
    the pack's composite range (R-RANGE). None, NaN, infinity and any value
    outside [min, max] return None: revision 1 mapped NaN and a negative
    composite to the last rung ("CC"), which printed a letter for a score
    the model never validly produced (synthetic_negative_equity: -2.9 CC).
    """
    if composite is None or isinstance(composite, bool) or not isinstance(composite, (int, float)):
        return None
    if score_out_of_range(float(composite), "composite"):
        return None
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
        # Interest coverage = EBIT / interest expense — the methodology's
        # definition (CLAUDE.md Appendix A, section 5: "Interest coverage |
        # EBIT / Interest expense"), the basis the coverage sub-score below
        # already banded on. EBITDA / interest is the SEPARATE
        # `ebitda_to_interest` row; until 2026-09-19 both rows divided
        # EBITDA and printed one figure under two names (17.70x twice on
        # Scandia FY2025; on EBIT it is 13.27x).
        {"name": "interest_coverage",  "value": safe(operating_profit, interest),   "unit": "ratio", "direction": "higher"},
        {"name": "roa",                "value": safe(net_income_statutory, total_assets),  "unit": "ratio", "direction": "higher"},
        {"name": "roe",                "value": safe(net_income_statutory, total_equity),  "unit": "ratio", "direction": "higher"},
        # ROIC = NOPAT / invested capital (debt + equity), DEFINED only for
        # positive invested capital (ruling R-OTHER, C1.9). Revision 1 floored
        # the divisor at 1 RON: the agras book with its balance sheet zeroed
        # served ROIC 12,990,721.7 (1,299,072,170.8%, graded strong).
        {"name": "roic",               "value": (None if total_debt + total_equity <= 0
                                                 else safe(operating_profit * (1 - 0.16), total_debt + total_equity)), "unit": "ratio", "direction": "higher"},
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
    #
    # REVISION 2 — absent is never zero, and never a floor. The ONE
    # predicate `component_refusals` decides which sub-scores refuse, the
    # ONE table `declared_rungs` which take a pack-declared rung, and the
    # pack ranges are checked on every figure after it is computed
    # (`credit_out_of_range`). A refused figure serves its row with value
    # None; the served block (`credit_block`) runs the same predicate over
    # the same statements to label each absence. A book with nothing
    # refused and no rung is computed by the same expressions as revision
    # 1, byte for byte.
    altman_z = None
    composite = None
    letter_grade = None
    if total_assets > 0:
        ops = _operands(bs, interest, operating_profit, ebitda, revenue)
        refusals = component_refusals(ops)
        rungs = declared_rungs(ops)

        x1: Optional[float] = (current_assets - current_liab) / total_assets
        x2: Optional[float] = bs["retainedEarnings"] / total_assets
        x3: Optional[float] = operating_profit / total_assets
        # X4 = book equity / total liabilities — DEFINED only when total
        # liabilities reach the pack's materiality share of total assets
        # (R-D4, `packs/credit/model.yaml`). Revision 1 divided by
        # max(liabilities, 1) and served X4 1500.0 / Z'' 1584.89 on a book
        # with no liabilities at all; a `> 0` guard still served Z''
        # 10,416.74 "safe" on a book carrying 1 RON of liabilities.
        x4: Optional[float] = None
        altman_subscore: Optional[float] = None
        if "altman" not in refusals:
            x4 = total_equity / ops["total_liab"]
            altman_z = 6.56 * x1 + 3.26 * x2 + 6.72 * x3 + 1.05 * x4
        # R-RANGE: every Altman figure against its declared range. The
        # offending figure is withheld (X1 alone; X4 with Z''; Z'' alone).
        bad = altman_out_of_range(x1, x2, x3, x4, altman_z)
        if bad is not None:
            if bad == "altman_x1":
                x1 = None
            elif bad == "altman_x2":
                x2 = None
            elif bad == "altman_x3":
                x3 = None
            elif bad == "altman_x4":
                x4 = None
            altman_z = None
        if altman_z is not None:
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
        # R-D2: revenue not positive -> refused; equity not positive with
        # revenue positive -> the net-margin term alone, disclosed
        # (`profitability_disclosure`). Revision 1 read both as 0.
        prof_subscore: Optional[float] = None
        if "profitability" not in refusals:
            net_margin_val = net_income_statutory / revenue
            if total_equity > 0:
                roe_val = net_income_statutory / total_equity
                prof_subscore = min(100, max(0, (roe_val * 100 * 0.5 + net_margin_val * 100 * 5) / 1.5))
            else:
                prof_subscore = min(100, max(0, (net_margin_val * 100 * 5) / 1.5))

        # Leverage sub-score (lower Net Debt/EBITDA = higher score). The
        # net_debt_ebitda formula uses CASH ebitda not statutory.
        # R-D3: net debt <= 0 is measured net cash and scores 100 whatever
        # EBITDA's sign; net debt > 0 with EBITDA <= 0 takes the pack's
        # declared rung 0, labelled. Revision 1 read EBITDA <= 0 as a 999
        # sentinel (score 0) even on a net-cash book.
        net_debt = total_debt - bs["cash"]
        if "leverage" in rungs:
            lev_subscore = rungs["leverage"]["score"]
        elif net_debt <= 0:
            lev_subscore = 100
        else:
            nde = net_debt / ebitda
            if nde <= 1.5:
                lev_subscore = 90
            elif nde <= 3.0:
                lev_subscore = 70
            elif nde <= 5.0:
                lev_subscore = 50
            else:
                lev_subscore = max(0, 50 - (nde - 5) * 10)

        # Interest coverage sub-score: EBIT / interest, measured when
        # interest is positive. R-D1: no interest-bearing debt (debt == 0,
        # interest == 0, EBIT > 0, all measured) takes the pack's declared
        # top rung, labelled; any other zero / absent interest state
        # REFUSES. Revision 1 read every zero-interest state as a 999
        # sentinel (score 95), loss-making indebted books included.
        ic_subscore: Optional[float] = None
        if "coverage" in rungs:
            ic_subscore = rungs["coverage"]["score"]
        elif "coverage" not in refusals:
            ic = operating_profit / interest
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

        # DSCR — EBITDA / (interest + LT debt principal / 8 years), on the
        # same R-D1 rule as coverage.
        dscr_subscore: Optional[float] = None
        if "dscr" in rungs:
            dscr_subscore = rungs["dscr"]["score"]
        elif "dscr" not in refusals:
            dscr = ebitda / (interest + bs["longTermDebt"] / 8)
            if dscr >= 2:
                dscr_subscore = 90
            elif dscr >= 1.25:
                dscr_subscore = 70
            else:
                dscr_subscore = max(0, dscr * 50)

        # Liquidity sub-score: blend of current / quick / cash ratios.
        # Revision 2: with no current liabilities the three ratios have no
        # base, so the sub-score REFUSES (`current_liabilities_not_positive`)
        # — revision 1 read each ratio as 0 and scored liquidity 0.0. A
        # negative ratio term (a negative asset leaf) is out of the
        # sub-score's domain and refuses (`credit_out_of_range`).
        liq_subscore: Optional[float] = None
        liq_out_of_range: Optional[str] = None
        if "liquidity" not in refusals:
            cur_ratio = current_assets / current_liab
            quick_ratio = (current_assets - bs["inventory"]) / current_liab
            cash_ratio = bs["cash"] / current_liab
            for term_name, term in (("current_ratio", cur_ratio), ("quick_ratio", quick_ratio),
                                    ("cash_ratio", cash_ratio)):
                if term < 0 and liq_out_of_range is None:
                    liq_out_of_range = term_name
            if liq_out_of_range is None:
                liq_subscore = (
                    min(100, cur_ratio * 50) + min(100, quick_ratio * 80) + min(100, cash_ratio * 250)
                ) / 3

        # Equity ratio sub-score. R-D2: equity ratio <= 0 takes the pack's
        # declared rung 0, labelled (revision 1 had no lower bound: -500.0
        # on synthetic_negative_equity, which drove the composite to -2.9).
        if "equity" in rungs:
            eq_subscore = rungs["equity"]["score"]
        else:
            eq_subscore = min(100, (total_equity / total_assets) * 200)

        # R-RANGE: every sub-score against the pack's [min, max] after it is
        # computed; a value outside it is withheld, and the composite refuses.
        subscore_values: Dict[str, Optional[float]] = {
            "altman": altman_subscore, "profitability": prof_subscore,
            "leverage": lev_subscore, "coverage": ic_subscore, "dscr": dscr_subscore,
            "liquidity": liq_subscore, "equity": eq_subscore,
        }
        for key in CREDIT_COMPOSITE_WEIGHTS:
            if score_out_of_range(subscore_values[key]):
                subscore_values[key] = None

        # Composite — the methodology's weights, term for term (revision 1's
        # sum). ANY refused sub-score -> NO composite and NO letter
        # (R-COMPOSITE): the weights are never redistributed over the rest.
        # A composite outside its range is withheld too, and mints no letter.
        if all(subscore_values[k] is not None for k in CREDIT_COMPOSITE_WEIGHTS):
            composite = 0
            for key, weight in CREDIT_COMPOSITE_WEIGHTS.items():
                composite = composite + weight * subscore_values[key]
            if score_out_of_range(composite, "composite"):
                composite = None
            letter_grade = composite_to_letter_grade(composite)

        # Surface Altman + composite + sub-scores as calculated_metrics so the
        # CreditScoreCard renders without a separate DB query.
        def _r(v: Optional[float], places: int) -> Optional[float]:
            # A refused operand serves its row with value None: absent,
            # never a stale figure and never zero.
            return None if v is None else round(v, places)

        metrics.extend([
            {"name": "altman_z_score",       "value": _r(altman_z, 2),            "unit": "ratio", "direction": "higher"},
            {"name": "altman_x1",            "value": _r(x1, 4),                  "unit": "ratio", "direction": "higher"},
            {"name": "altman_x2",            "value": _r(x2, 4),                  "unit": "ratio", "direction": "higher"},
            {"name": "altman_x3",            "value": _r(x3, 4),                  "unit": "ratio", "direction": "higher"},
            {"name": "altman_x4",            "value": _r(x4, 4),                  "unit": "ratio", "direction": "higher"},
            {"name": "credit_composite",     "value": _r(composite, 1),           "unit": "score", "direction": "higher"},
        ] + [
            {"name": name, "value": _r(subscore_values[key], 1), "unit": "score", "direction": "higher"}
            for key, name in CREDIT_SUBSCORE_METRICS
        ])
        logger.info(
            "[pipeline] credit: Altman Z″=%s composite=%s → grade %s",
            "refused" if altman_z is None else "%.2f" % altman_z,
            "refused" if composite is None else "%.0f" % composite, letter_grade,
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


#: Rows whose DEFINITION was revised after periods were persisted under
#: the old one. `interest_coverage` divided EBITDA until 2026-09-19 and is
#: EBIT / interest since (the stated methodology; `ebitda_to_interest` is
#: the EBITDA row). A reanalyze never recomputes metrics, so a period
#: persisted before the change still carries the EBITDA figure under this
#: name, while `ratio_table` serves the EBIT one: two figures, one key,
#: and on a book whose EBIT and EBITDA straddle zero a SIGN FLIP between
#: two surfaces of one period. These rows are therefore served from the
#: serve-time model exactly like the credit family, and the filed value
#: is disclosed, verbatim, in `credit_metrics_as_filed`.
DEFINITION_REVISED_METRICS: Tuple[str, ...] = ("interest_coverage",)

#: Every persisted row a serve-basis response replaces.
SERVE_REPLACED_METRICS: Tuple[str, ...] = CREDIT_FAMILY_METRICS + DEFINITION_REVISED_METRICS


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
    fallbacks are keyed on). The definition-revised rows
    (`DEFINITION_REVISED_METRICS`) are replaced the same way, so one key
    carries one figure on every surface of the response. Every other row
    is untouched.
    `as_filed_rows` are the persisted rows that were replaced, verbatim —
    the as-filed evidence `credit_block` discloses from."""
    family = set(SERVE_REPLACED_METRICS)
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


def _refused_subscores(rows_by_name: Dict[str, Any],
                       statements: Mapping[str, Any]) -> Dict[str, Dict[str, Any]]:
    """Every sub-score whose row the model EMITTED with no value, with its
    refusal (`subscore_refusal`). The reason is the ONE predicate
    (`component_refusals`) run over the statements the rows came from —
    `statements` is REQUIRED; there is no operands-from-rows fallback
    (an absent row read as 0.0 declared rungs the book never earned). A
    row absent with no predicate refusing it, and no declared rung, left
    its range after composition (`credit_out_of_range`), and the figure
    that left it is named from the rows. With statements the operands
    cannot be read from, every withheld row refuses as
    `credit_inputs_absent`. A row that is missing altogether is not a
    component refusal: the model did not run (total assets not positive)."""
    ops = statement_operands(statements)
    predicate = component_refusals(ops) if ops is not None else {}
    out: Dict[str, Dict[str, Any]] = {}
    for key, name in CREDIT_SUBSCORE_METRICS:
        if name not in rows_by_name or _num(rows_by_name.get(name)) is not None:
            continue
        if ops is None:
            out[key] = subscore_refusal(key, CREDIT_INPUTS_ABSENT)
            continue
        if key in predicate:
            out[key] = subscore_refusal(key, predicate[key])
            continue
        out[key] = subscore_refusal(key, CREDIT_OUT_OF_RANGE, _out_of_range_figure(key, rows_by_name))
    return out


def _out_of_range_figure(key: str, m: Dict[str, Any]) -> str:
    """Which figure of a component left its range, read off the rows the
    model withheld: the Altman figure the model nulled (X1 alone, X4 with
    Z'', or Z'' alone), a negative liquidity term, else the sub-score."""
    if key == "altman":
        for name in ("altman_x1", "altman_x2", "altman_x3", "altman_x4"):
            if name in m and _num(m.get(name)) is None:
                return name
        return "altman_z_score"
    if key == "liquidity":
        for name in ("current_ratio", "quick_ratio", "cash_ratio"):
            v = _num(m.get(name))
            # a negative term rounded to the row's precision prints -0.0:
            # the sign is the evidence, so read it, not `v < 0`
            if v is not None and math.copysign(1.0, v) < 0:
                return name
    return "credit_subscore_%s" % key


def _served_out_of_range(rows_by_name: Dict[str, Any]) -> Dict[str, str]:
    """THE INDEPENDENT RE-CHECK ON THE ROWS (R-RANGE, every surface): a
    served sub-score outside the pack range, an Altman figure outside its
    bound, or a composite outside its range — read off the rows as served,
    whatever produced them. `{component or "composite": figure}`."""
    out: Dict[str, str] = {}
    for key, name in CREDIT_SUBSCORE_METRICS:
        v = _num(rows_by_name.get(name))
        if v is not None and score_out_of_range(v):
            out[key] = name
    bad = altman_out_of_range(_num(rows_by_name.get("altman_x1")), _num(rows_by_name.get("altman_x2")),
                              _num(rows_by_name.get("altman_x3")), _num(rows_by_name.get("altman_x4")),
                              _num(rows_by_name.get("altman_z_score")))
    if bad is not None and "altman" not in out:
        out["altman"] = bad
    c = _num(rows_by_name.get("credit_composite"))
    if c is not None and score_out_of_range(c, "composite"):
        out["composite"] = "credit_composite"
    return out


def credit_reason(rows_by_name: Dict[str, Any],
                  refused: Dict[str, Dict[str, Any]],
                  composite: Optional[float] = None) -> Optional[Dict[str, Any]]:
    """Why this period carries no composite: a refused component
    (`credit_component_undefined`, every component listed), a composed
    value outside its range (`credit_out_of_range`), or a model that did
    not run (`credit_inputs_absent`). None beside a composite."""
    if composite is not None:
        return None
    if refused:
        return composite_refusal(refused)
    if any(name in rows_by_name for _k, name in CREDIT_SUBSCORE_METRICS):
        # every component scored, the composite did not: it left its range
        return composite_out_of_range_refusal(_num(rows_by_name.get("credit_composite")))
    return {"code": CREDIT_INPUTS_ABSENT, "inputs": ["balanceSheet.total_assets"]}


def credit_block(
    rows: List[Dict[str, Any]],
    statements: Mapping[str, Any],
    as_filed_rows: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    """The served CreditBlock for one period, read off ITS OWN
    `compute_period_metrics` rows (the serve-time model), with the
    persisted `calculated_metrics` rows as the as-filed evidence.

    Values are the model's stored rows (Z'' at 2dp, composite and
    sub-scores at 1dp); the zone and the letter are read off those same
    printed figures, so the zone beside a 2.60 never disagrees with it.

    Revision 2: `refused_subscores` names every sub-score the model refused,
    with its `{code, component, inputs, text}` — the reason found by running
    the model's own predicate over `statements` (REQUIRED: the rows-only
    fallback that read an absent row as 0.0 is gone) — and the block RE-CHECKS every served figure against the
    pack ranges (`ranges`), withholding any that left them; any refusal
    leaves the composite and the letter null, and `reason` lists every
    refused component. `declared_rungs` labels each sub-score the model
    STATED rather than measured (R-D1/D2/D3), `profitability_disclosure`
    says when ROE was dropped from the blend (R-D2). `weights` are the model
    table, always — never renormalised.
    `as_filed` is served ONLY when the persisted composite, Z'' or letter
    differs from the served one at that same precision (after a
    reanalyze, which never recomputes metrics, or for rows persisted
    before a model change); a persisted figure outside its range is
    WITHDRAWN (null, named in `as_filed.withdrawn`), never reprinted;
    persisted rows with no revision stamp print revision "unknown". No
    persisted rows at all -> `as_filed` null and `as_filed_differs` false:
    nothing was filed to differ from.
    """
    m = dict(_rows_by_name(rows))
    # The independent re-check: a served figure outside its range is
    # withheld here whatever produced the rows.
    served_bad = _served_out_of_range(m)
    for key, figure in served_bad.items():
        if key == "composite":
            m["credit_composite"] = None
            continue
        m["credit_subscore_%s" % key] = None
        if key == "altman":
            m[figure] = None
            m["altman_z_score"] = None
    if served_bad and any(k != "composite" for k in served_bad):
        m["credit_composite"] = None
    z = _num(m.get("altman_z_score"))
    composite = _num(m.get("credit_composite"))
    letter = composite_to_letter_grade(composite)
    subscores = {k: _num(m.get(name)) for k, name in CREDIT_SUBSCORE_METRICS}
    refused_subscores = _refused_subscores(m, statements)
    ops = statement_operands(statements)
    # No operands -> nothing is declared: a rung is stated only over
    # measured operands (R-D1: debt == 0, interest == 0, EBIT > 0, all read).
    rungs = ({k: v for k, v in declared_rungs(ops).items() if subscores.get(k) is not None}
             if ops is not None else {})
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
        "declared_rungs": rungs,
        "profitability_disclosure": (profitability_disclosure(ops)
                                     if ops is not None and subscores.get("profitability") is not None
                                     else None),
        "weights": dict(CREDIT_COMPOSITE_WEIGHTS),
        "ranges": credit_ranges(_num(m.get("altman_x2")), _num(m.get("altman_x3"))),
        "composite": composite,
        "letter": letter,
        "ladder": letter_grade_bands(),
        "reason": credit_reason(m, refused_subscores, composite),
        "as_filed": None,
        "as_filed_differs": False,
    }
    filed = _rows_by_name(as_filed_rows)
    if not filed:
        return block
    f_z = _num(filed.get("altman_z_score"))
    f_c = _num(filed.get("credit_composite"))
    f_rev = _num(filed.get(CREDIT_MODEL_REVISION_METRIC))
    # What was FILED, before any withdrawal: a filed 1584.89 beside a
    # served None differs, and the withdrawal note must be served — a
    # comparison after nulling read "None == None" and dropped it.
    filed_z, filed_c = f_z, f_c
    withdrawn: List[Dict[str, Any]] = []
    filed_bad = _served_out_of_range(filed)
    rev_word = "revision %d" % int(f_rev) if f_rev is not None else "an unknown revision"
    if f_z is not None and ("altman" in filed_bad):
        withdrawn.append({"figure": "altman_z_score", "value": f_z,
                          "text": "withdrawn: computed under %s on a substituted operand (%s outside its range)"
                                  % (rev_word, filed_bad["altman"])})
        f_z = None
    if f_c is not None and filed_bad:
        withdrawn.append({"figure": "credit_composite", "value": f_c,
                          "text": "withdrawn: computed under %s on a substituted operand (%s outside its range)"
                                  % (rev_word, ", ".join(sorted(set(filed_bad.values()))))})
        f_c = None
    f_l = composite_to_letter_grade(f_c)

    def _q(v: Optional[float], places: int) -> Optional[str]:
        return None if v is None else "%.*f" % (places, round(v, places))

    differs = ((_q(filed_z, 2) != _q(z, 2)) or (_q(filed_c, 1) != _q(composite, 1))
               or (composite_to_letter_grade(filed_c) != letter) or bool(withdrawn))
    block["as_filed_differs"] = bool(differs)
    if differs:
        block["as_filed"] = {
            "composite": f_c,
            "altman_z": f_z,
            "letter": f_l,
            "credit_model_revision": int(f_rev) if f_rev is not None else "unknown",
            "withdrawn": withdrawn,
        }
    return block


def serve_credit_envelope(block: Dict[str, Any]) -> Dict[str, Any]:
    """The GET /api/period `assembled_metrics.credit` envelope for a period
    whose serve-time model ran, projected from its `credit_block` — the one
    builder, so the route and every captured FE fixture carry the same
    shape. `composite_weights` are the model table (never renormalised);
    `refused_subscores` says why each absent sub-score is absent, `reason`
    why the composite and the letter are absent (listing every refused
    component), `declared_rungs` which sub-scores were stated rather than
    measured and `ranges` the bounds every figure was read against —
    without them the FE could only print a bare "not reported" where the
    verdict would be."""
    alt = block.get("altman") or {}
    return {
        "altman_z_score": alt.get("z"),
        "altman_variant": "Z\"",
        "altman_components": {x: alt.get(x) for x in ("x1", "x2", "x3", "x4")},
        "altman_zone": alt.get("zone"),
        "composite_score": block.get("composite"),
        "letter_grade": block.get("letter"),
        "letter_grade_bands": block.get("ladder"),
        "composite_weights": block.get("weights"),
        "refused_subscores": block.get("refused_subscores"),
        "declared_rungs": block.get("declared_rungs"),
        "profitability_disclosure": block.get("profitability_disclosure"),
        "ranges": block.get("ranges"),
        "subscores": block.get("subscores"),
        "credit_model_revision": block.get("revision"),
        "basis": "serve",
        "reason": block.get("reason"),
        "as_filed": block.get("as_filed"),
        "as_filed_differs": block.get("as_filed_differs"),
    }
