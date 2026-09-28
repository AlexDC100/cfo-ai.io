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

THE ONE EBITDA (revision 3, 2026-09-26, owner ruling on account 711).
Every row built on EBITDA or the operating result — EBITDA itself, EBIT
(`operating_profit`), gross profit, the margins over turnover, Debt /
EBITDA, interest coverage, EBITDA / interest, both DSCRs, ROIC, core and
adjusted EBITDA, and the credit components that divide them (Altman X3,
leverage, coverage, DSCR) — reads ONE figure: `operating_figures`, which
reads the assembled P&L's one definition (net 711 "Variația stocurilor de
produse" and net 72x inside, 767 financial). Revision 2 built EBITDA from
the legacy `incomeStatement` mirror WITHOUT 711 and 72x and a second,
"statutory" EBITDA with 72x for the DSCRs, and persisted the GROSS 711
credit turnover as `ebitda_statutory_with_711` (98.9 %-191.0 % margins on
every closed manufacturer). Those rows are retired; the legacy names are
aliases of the one figure. When the assembled P&L REFUSES the one EBITDA
(the stock variation could not be measured on a book that posts to 711),
every one of those rows is None and the components that need it refuse
with `ebitda_refused`, naming the stock-variation cause — never a fallback
to the definition without 711, never 0.
"""

from __future__ import annotations

import logging
import math
from decimal import Decimal
from typing import Any, Dict, List, Mapping, Optional, Tuple

from engine.country_packs.ro_romania import stock_variation as _stock_variation
from engine.ratios.credit_pack import CREDIT_PACK_FILE, credit_pack, share_percent, x4_materiality_share

logger = logging.getLogger(__name__)

#: The revision of the arithmetic below. Bump it on ANY change to what a
#: row means: a weight, a sub-score mapping, an Altman coefficient, a
#: ladder rung, a ratio's numerator or denominator.
#: 3 (2026-09-26): the ONE EBITDA — every EBITDA / EBIT row reads
#: `operating_figures` (net 711 and net 72x inside, 767 financial).
#: 4 (2026-09-28, owner rulings R2 / R3): the one EBITDA leaves the 6812 /
#: 6814 charges AND the 7812 / 7814 reversals outside (net provisions, its
#: own line; EBIT unchanged) and net turnover holds 7411 — the EBITDA-built
#: rows, the margins and every turnover denominator move with it.
CREDIT_MODEL_REVISION = 4

#: The first revision whose EBITDA-family rows carry the CURRENT one
#: definition (chart_of_accounts.EBITDA_DEFINITION_REVISION). A persisted
#: set of rows stamped below it (or unstamped) carries an earlier
#: definition under the same names — without 711 / 72x (below 3), or with
#: the 7812 / 7814 reversals inside and 7411 outside turnover (3) — and a
#: reader of stored rows (the Section 9 benchmark) refuses those figures
#: rather than grade them.
ONE_EBITDA_REVISION = 4

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
#: The one EBITDA / operating result is REFUSED on these statements (the
#: stock variation, account 711, could not be measured on a book that posts
#: to it): Altman X3, coverage, DSCR and — with net debt — leverage have no
#: operand. The refusal carries the stock-variation cause beside the code.
EBITDA_REFUSED = "ebitda_refused"
CREDIT_SUBSCORE_REFUSAL_CODES: Tuple[str, ...] = (
    CURRENT_LIABILITIES_NOT_POSITIVE,
    TOTAL_LIABILITIES_BELOW_MATERIALITY,
    REVENUE_NOT_POSITIVE,
    INTEREST_EXPENSE_NOT_POSITIVE,
    CREDIT_OUT_OF_RANGE,
    EBITDA_REFUSED,
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

#: The inputs a refused one-EBITDA names (the assembled P&L's own fields).
_EBITDA_INPUTS = ["assembled_pl.ebitda", "assembled_pl.operating_result",
                  "assembled_pl.inventory_variation"]

#: The inputs each predicate refusal names.
_REFUSAL_INPUTS: Dict[str, List[str]] = {
    CURRENT_LIABILITIES_NOT_POSITIVE: list(_CURRENT_LIABILITY_INPUTS),
    TOTAL_LIABILITIES_BELOW_MATERIALITY: list(_TOTAL_LIABILITY_INPUTS) + ["balanceSheet.total_assets"],
    REVENUE_NOT_POSITIVE: ["incomeStatement.revenue"],
    INTEREST_EXPENSE_NOT_POSITIVE: ["incomeStatement.interestExpense"] + list(_DEBT_INPUTS)
    + ["incomeStatement.operating_profit"],
    EBITDA_REFUSED: list(_EBITDA_INPUTS),
}


# ── THE ONE EBITDA, read — never re-derived ─────────────────────────────────

#: Half a cent: below it a 711 memo is "no postings".
_ZERO = 0.005


def _fnum(v: Any) -> Optional[float]:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    f = float(v)
    return f if math.isfinite(f) else None


def _ebitda_refusal(cause: Optional[str], text_ro: Optional[str], text_en: Optional[str],
                    inputs: Optional[List[str]] = None) -> Dict[str, Any]:
    """The typed refusal every EBITDA-family figure carries: the code, the
    stock-variation cause beside it, and its sentence in both languages."""
    return {"code": EBITDA_REFUSED, "cause": cause, "text_ro": text_ro, "text_en": text_en,
            "inputs": list(inputs or _EBITDA_INPUTS)}


def equity_completeness_refusal(statements: Mapping[str, Any]) -> Optional[Dict[str, Any]]:
    """The assembler's completeness refusal beside total equity
    (`assembled_bs.total_equity_refusal`), or None. Served when the NET
    RESULT is refused (no account 121, net 711 refused) and the sheet does
    not balance without it: total equity is short by the missing result,
    so Altman X2, the equity sub-score and every ratio on total equity
    refuse with the net result's typed reason (never read the missing
    result as 0)."""
    abs_ = statements.get("assembled_bs") if isinstance(statements, Mapping) else None
    ref = abs_.get("total_equity_refusal") if isinstance(abs_, Mapping) else None
    if isinstance(ref, Mapping) and ref.get("code"):
        return dict(ref)
    return None


def operating_figures(statements: Mapping[str, Any]) -> Dict[str, Any]:
    """THE one EBITDA and operating result a statements block serves, with
    the components the ruling places inside it and the typed refusal.

    `{ebitda, ebit, gross_profit, ebitda_before_stock_variation,
    inventory_variation, capitalized_own_work, refusal, source,
    definition}` — every figure a float or None.

    ASSEMBLED (every RO statements block the pipeline, the serve path and
    every rebuild produce): read from `assembled_pl` — `ebitda`,
    `operating_result`, `gross_profit`, `ebitda_before_stock_variation`,
    `inventory_variation.value` (net 711), `capitalized_own_work.value`
    (net 72x) and `ebitda_refusal`. Nothing is recomputed: the assembler
    (`chart_of_accounts.assemble_statements`) is the one authority.

    LEGACY (a statements block assembled before the ruling — no
    `assembled_pl.ebitda_definition` — e.g. a committed fixture): the same
    definition from the `incomeStatement` leaves, and only where it is
    KNOWN: a book with no 711 line (`inventoryVariationMemo` zero or
    absent) has a net 711 of exactly 0 and its EBITDA is the build-up plus
    net 72x; a book that posts to 711 carried only the GROSS credit
    turnover there, which is not the variation, so the one EBITDA REFUSES
    (`period_predates_stock_variation_measurement`) — never the build-up
    without 711.

    Raises KeyError / TypeError on a legacy block missing a core P&L leaf
    (the model's contract: a missing operand is named, never zeroed)."""
    apl = statements.get("assembled_pl") if isinstance(statements, Mapping) else None
    if isinstance(apl, Mapping) and "ebitda_definition" in apl:
        inv = apl.get("inventory_variation")
        cap = apl.get("capitalized_own_work")
        out: Dict[str, Any] = {
            "ebitda": _fnum(apl.get("ebitda")),
            "ebit": _fnum(apl.get("operating_result", apl.get("ebit"))),
            "gross_profit": _fnum(apl.get("gross_profit")),
            "ebitda_before_stock_variation": _fnum(apl.get("ebitda_before_stock_variation")),
            "inventory_variation": _fnum(inv.get("value")) if isinstance(inv, Mapping) else None,
            "capitalized_own_work": (_fnum(cap.get("value")) if isinstance(cap, Mapping)
                                     else _fnum(apl.get("capitalized_own_work_memo"))),
            "refusal": None,
            # The NET RESULT refused with 711 (no account 121 to stand in
            # for the unmeasured variation) — the assembler's own block.
            "net_income_refusal": None,
            "source": "assembled_pl",
            "definition": apl.get("ebitda_definition"),
        }
        ni_ref = apl.get("net_income_refusal")
        if isinstance(ni_ref, Mapping):
            out["net_income_refusal"] = _ebitda_refusal(
                ni_ref.get("code"), ni_ref.get("text_ro"), ni_ref.get("text_en"),
                ["assembled_pl.net_income_statutory", "assembled_pl.inventory_variation"])
        served = apl.get("ebitda_refusal")
        if isinstance(served, Mapping):
            out["refusal"] = _ebitda_refusal(served.get("code"), served.get("text_ro"),
                                             served.get("text_en"))
        elif out["ebitda"] is None or out["ebit"] is None:
            out["refusal"] = _ebitda_refusal(
                "ebitda_not_served", "EBITDA nu este prezent în contul de profit și pierdere asamblat",
                "EBITDA is not served on the assembled P&L")
        if out["refusal"] is not None:
            out["ebitda"] = out["ebit"] = out["gross_profit"] = None
        return out

    pl = statements["incomeStatement"]
    revenue = float(pl["revenue"])
    cogs = float(pl["costOfGoodsSold"])
    before = revenue - cogs - float(pl["operatingExpenses"]) + float(pl["otherIncome"])
    depreciation = float(pl["depreciationAmortization"])
    cap = float(pl.get("capitalizedOwnWork", 0) or 0)
    memo = _fnum(pl.get("inventoryVariationMemo")) or 0.0
    out = {
        "ebitda": None, "ebit": None, "gross_profit": None,
        "ebitda_before_stock_variation": before,
        "inventory_variation": None,
        "capitalized_own_work": cap,
        "refusal": None,
        "net_income_refusal": None,
        "source": "incomeStatement",
        "definition": None,
    }
    if abs(memo) >= _ZERO:
        ro, en = _stock_variation.refusal_text(_stock_variation.REASON_PREDATES)
        out["refusal"] = _ebitda_refusal(_stock_variation.REASON_PREDATES, ro, en,
                                         ["incomeStatement.inventoryVariationMemo"])
        return out
    out["inventory_variation"] = 0.0
    out["ebitda"] = before + cap
    out["ebit"] = out["ebitda"] - depreciation
    out["gross_profit"] = revenue - cogs
    return out


def _operands(bs: Dict[str, Any], interest: float, ebit: Optional[float], ebitda: Optional[float],
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
        # The ONE EBITDA / operating result (revision 3) — the same figures
        # `compute_period_metrics` divides, refusal included.
        figures = operating_figures(statements)
        ops = _operands(bs, pl["interestExpense"], figures["ebit"], figures["ebitda"], pl["revenue"])
    except (KeyError, TypeError):
        return None
    ops["ebitda_refusal"] = figures["refusal"]
    ops["net_income_refused"] = figures.get("net_income_refusal") is not None
    ops["equity_incomplete"] = equity_completeness_refusal(statements)
    return ops


def component_refusals(ops: Dict[str, Any]) -> Dict[str, str]:
    """THE predicate: which sub-scores refuse on these operands, by code.
    Run by the model to decide, and by the served block to label — one
    function, so the two cannot disagree.

      liquidity     current liabilities not positive            (Q2)
      altman        total liabilities below the pack share of TA (R-D4);
                    else the operating result refused (X3)      (rev. 3)
      profitability revenue not positive                        (R-D2)
      coverage/dscr the operating result refused (EBIT / EBITDA
                    have no value, so neither does the rung's
                    EBIT > 0 test)                              (rev. 3);
                    else interest not positive, and not the R-D1
                    rung (debt == 0, interest == 0, EBIT > 0)   (R-D1)
      leverage      EBITDA refused with net debt > 0            (rev. 3)
      equity        total equity excludes a refused year's result
                    (`equity_completeness_refusal`); Altman too,
                    X2 having no numerator                       (rev. 3)

    A refusal after composition (`credit_out_of_range`) is not a predicate;
    the block finds it on the rows."""
    out: Dict[str, str] = {}
    ebit_refused = ops.get("ebit") is None
    if not ops["current_liab_positive"]:
        out["liquidity"] = CURRENT_LIABILITIES_NOT_POSITIVE
    if not ops["tl_material"]:
        out["altman"] = TOTAL_LIABILITIES_BELOW_MATERIALITY
    elif ebit_refused or ops.get("equity_incomplete"):
        # X3 has no operand; or X2 has none — total equity excludes the
        # refused year's result (`equity_completeness_refusal`).
        out["altman"] = EBITDA_REFUSED
    if not ops["revenue"] > 0:
        out["profitability"] = REVENUE_NOT_POSITIVE
    elif ops.get("net_income_refused"):
        # ROE and the net margin read the NET RESULT, refused with 711 when
        # there is no account 121 (the build-up lacks the unmeasured
        # variation). The cause beside the code is the stock variation's.
        out["profitability"] = EBITDA_REFUSED
    if ebit_refused or ops.get("ebitda") is None:
        out["coverage"] = EBITDA_REFUSED
        out["dscr"] = EBITDA_REFUSED
    elif not ops["interest_positive"] and "coverage" not in declared_rungs(ops):
        out["coverage"] = INTEREST_EXPENSE_NOT_POSITIVE
        out["dscr"] = INTEREST_EXPENSE_NOT_POSITIVE
    if ops.get("ebitda") is None and ops["net_debt"] > 0:
        out["leverage"] = EBITDA_REFUSED
    if ops.get("equity_incomplete"):
        # Total equity excludes the year's result, refused with 711 (no
        # account 121; the sheet does not balance without it): the equity
        # ratio has no numerator. The cause is the net result's.
        out["equity"] = EBITDA_REFUSED
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
    # A refused EBIT / EBITDA (None) is not measured: no rung is declared
    # over it (`component_refusals` refuses those components instead).
    ebit, ebitda = ops.get("ebit"), ops.get("ebitda")
    if ops["total_debt"] == 0 and ops["interest_zero"] and ebit is not None and ebit > 0:
        out["coverage"] = dict(pack["coverage"])
        out["dscr"] = dict(pack["dscr"])
    if ops["net_debt"] > 0 and ebitda is not None and not ebitda > 0:
        out["leverage"] = dict(pack["leverage"])
    if ops["equity_ratio"] is not None and ops["equity_ratio"] <= 0 \
            and not ops.get("equity_incomplete"):
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
    if z is not None and (ranges["altman_z"]["bound"] is None
                          or not _in_range(z, None, ranges["altman_z"]["bound"])):
        # R-RANGE is absolute: a Z'' whose bound cannot be derived (no X2 or
        # X3 beside it - a filing persisted before the components were
        # stored) has not been read against its range, and an unread figure
        # is not served. A filed 1584.89 with no X rows once passed here.
        return "altman_z_score"
    return None


#: What each component divides the refused figure into (EBITDA_REFUSED).
_EBITDA_REFUSED_OPERAND = {
    "altman": "X3 (operating result / total assets)",
    "coverage": "EBIT / interest",
    "dscr": "EBITDA / debt service",
    "leverage": "net debt / EBITDA",
    "equity": "the equity ratio (total equity excludes the year's result, refused with them)",
}


def subscore_refusal(key: str, code: Optional[str] = None,
                     out_of_range_input: Optional[str] = None,
                     bound_underivable: bool = False,
                     cause: Optional[Mapping[str, Any]] = None) -> Dict[str, Any]:
    """The served refusal of one sub-score: `{code, component, inputs, text}`
    and, for the Altman materiality refusal, the pack materiality it was
    read against (`materiality: {share, basis, source, file}`) — the
    threshold rendered from the pack, never written as prose (TC-10). A
    `credit_out_of_range` refusal names the figure that left its range and
    the range it was read against. An `ebitda_refused` refusal carries the
    stock-variation cause (`ebitda_refusal: {code, text_ro, text_en}`) —
    `cause` is the one-EBITDA refusal `operating_figures` read."""
    code = code or CREDIT_INPUTS_ABSENT
    out: Dict[str, Any] = {"code": code, "component": key,
                           "inputs": list(_REFUSAL_INPUTS.get(code, ["credit_model.%s" % key]))}
    if code == EBITDA_REFUSED:
        c = dict(cause or {})
        # The stock-variation cause (never under `cause`, which the
        # composite's component list uses for the component's own code).
        out["ebitda_refusal"] = {"code": c.get("cause"), "text_ro": c.get("text_ro"),
                                 "text_en": c.get("text_en")}
        if c.get("inputs"):
            out["inputs"] = list(c["inputs"])
        tail = (" — " + c["text_en"]) if c.get("text_en") else ""
        if key == "equity":
            # Its OWN cause (critic round 3, 2026-09-28): the equity ratio
            # is refused because total equity excludes the refused year's
            # result — not because EBITDA is.
            out["text"] = (
                "The equity component is not scored: total equity excludes the year's result, "
                "which is refused for this period, so the equity ratio is not defined%s." % tail)
        elif key == "profitability":
            # ROE and the net margin read the NET RESULT, refused with the
            # stock variation when there is no account 121.
            out["text"] = (
                "The profitability component is not scored: the net result is refused for this "
                "period, so ROE and the net margin are not defined%s." % tail)
        else:
            out["text"] = (
                "The %s component is not scored: EBITDA and the operating result are refused for "
                "this period, so %s is not defined%s." % (
                    "interest-coverage" if key == "coverage" else ("DSCR" if key == "dscr" else key),
                    _EBITDA_REFUSED_OPERAND.get(key, "the component's operand"), tail))
    elif code == TOTAL_LIABILITIES_BELOW_MATERIALITY:
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
        if bound_underivable:
            out["text"] = ("The %s component is not scored: %s was filed with no X2 and X3 beside it, so its "
                           "bound (%s; %s) cannot be derived and the value cannot be read against its range; "
                           "it is withheld rather than served." % (key, figure, rng, CREDIT_PACK_FILE))
        else:
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

    # ── THE ONE EBITDA (revision 3, owner ruling 2026-09-26) ────────────
    # EBITDA, EBIT (`operating_profit`) and gross profit are READ from the
    # assembled P&L (`operating_figures`): net 711 ("Variația stocurilor de
    # produse", beside cost of sales, signed) and net 72x (own work
    # capitalised) inside, 767 financial. None when the assembly refuses
    # them — and then every row below that divides them is None too.
    # Revision 2 built a "cash" EBITDA here without 711 / 72x, a second
    # "statutory" one with 72x for the DSCRs, and persisted the GROSS 711
    # credit turnover as `ebitda_statutory_with_711`.
    figures = operating_figures(s)
    ebitda = figures["ebitda"]
    operating_profit = figures["ebit"]
    gross_profit = figures["gross_profit"]
    ebitda_refusal = figures["refusal"]
    # The class-6/7 build-up BEFORE 711 and 72x — what `net_income` /
    # `net_income_operational` have always named (the reconstruction the
    # account-121 anchor is measured against). Unchanged arithmetic.
    ebitda_before = revenue - cogs - opex + other_inc
    pretax = ebitda_before - depreciation + fin_inc - fin_exp - interest
    net_income = pretax - tax  # OPERATIONAL view — excludes 711 and 72x

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

    # REFUSED (None) when the assembly refused the net result — no
    # account 121 and a refused net 711 (`assembled_pl.net_income_refusal`).
    # `_canonical` reads a served None as "not surfaced" and would put the
    # build-up WITHOUT 711 back under the statutory name; it must not.
    net_income_statutory: Optional[float]
    net_income_buildup: Optional[float] = (
        None if figures.get("net_income_refusal") is not None else round(net_income, 2))
    if figures.get("net_income_refusal") is not None:
        net_income_statutory = None
    else:
        net_income_statutory = _canonical(
            "net_income_statutory", net_income + capitalized_own_work
        )
    # The legacy EBITDA names are ALIASES of the one figure: no row carries
    # a second EBITDA. `total_operating_revenue` is the assembled
    # venituri din exploatare without 711 (turnover + other operating
    # income + 72x) — a figure, never a margin denominator. The
    # total-production view (`total_operating_revenue_statutory`, which
    # added the gross 711 credit turnover) is retired.
    ebitda_statutory = ebitda
    total_operating_revenue = _canonical(
        "total_operating_revenue", revenue + other_inc + capitalized_own_work
    )

    current_assets = bs["cash"] + bs["accountsReceivable"] + bs["inventory"] + bs["otherCurrentAssets"]
    non_current_assets = bs["propertyPlantEquipment"] + bs["intangibles"] + bs["otherNonCurrentAssets"]
    total_assets = current_assets + non_current_assets

    current_liab = bs["accountsPayable"] + bs["shortTermDebt"] + bs["otherCurrentLiabilities"]
    non_current_liab = bs["longTermDebt"] + bs["otherNonCurrentLiabilities"]
    total_debt = bs["shortTermDebt"] + bs["longTermDebt"]
    total_equity = bs["shareCapital"] + bs["retainedEarnings"] + bs["otherEquity"]
    # Total equity as a RATIO OPERAND: None when it excludes a refused
    # year's result (`equity_completeness_refusal` — no account 121, net
    # 711 refused, the sheet short by the missing result). Every row that
    # divides or reports total equity refuses with it; the model's X2 and
    # equity sub-score below refuse through `component_refusals`.
    equity_incomplete = equity_completeness_refusal(s)
    equity_operand: Optional[float] = None if equity_incomplete is not None else total_equity

    def safe(num: Optional[float], denom: Optional[float]) -> Optional[float]:
        # A refused operand (None) refuses the ratio — never a 0.
        if num is None or denom is None or denom == 0:
            return None
        return round(num / denom, 4)

    def money(v: Optional[float]) -> Optional[float]:
        return None if v is None else round(v, 2)

    metrics: List[Dict[str, Any]] = [
        {"name": "revenue",            "value": round(revenue, 2),         "unit": "RON",   "direction": "higher"},
        {"name": "gross_profit",       "value": money(gross_profit),       "unit": "RON",   "direction": "higher"},
        # THE ONE EBITDA. `ebitda_cash` and `ebitda_statutory` below are
        # aliases of it (revision 3): one figure under every legacy name.
        {"name": "ebitda",             "value": money(ebitda),             "unit": "RON",   "direction": "higher"},
        {"name": "ebitda_cash",        "value": money(ebitda),             "unit": "RON",   "direction": "higher"},
        {"name": "operating_profit",   "value": money(operating_profit),   "unit": "RON",   "direction": "higher"},
        # `net_income` (existing) is the OPERATIONAL view — kept under the
        # existing key for back-compat. Old FE / briefing consumers see the
        # same number they always did. NEW callers should prefer the
        # explicit `net_income_statutory` (matches account 121 / oracle) or
        # `net_income_operational` (alias of net_income).
        # REFUSED (None) when the assembly refused the net result (no
        # account 121, net 711 refused): the build-up here lacks the
        # refused 711, so it is short by exactly the unmeasured variation
        # (the developer with no 121: -30,391,418.38 where 121 closes at
        # -801,604.14). Served under these names it reached the briefing
        # narrator and the Ask-CFO chat beside the refused net result
        # (critic round 3, 2026-09-28).
        {"name": "net_income",         "value": net_income_buildup,        "unit": "RON",   "direction": "higher"},
        {"name": "net_income_operational", "value": net_income_buildup,    "unit": "RON",   "direction": "higher"},
        {"name": "net_income_statutory",   "value": money(net_income_statutory), "unit": "RON", "direction": "higher"},
        {"name": "ebitda_statutory",       "value": money(ebitda_statutory),        "unit": "RON", "direction": "higher"},
        {"name": "total_operating_revenue","value": round(total_operating_revenue, 2),"unit": "RON","direction": "higher"},
        {"name": "capitalized_own_work_memo", "value": round(capitalized_own_work, 2), "unit": "RON", "direction": "neutral"},
        # The two components the ruling places inside EBITDA, beside the
        # build-up before them: EBITDA = ebitda_before_stock_variation +
        # inventory_variation (net 711) + capitalized_own_work_memo (net
        # 72x). Net 711 is None when it was refused.
        {"name": "inventory_variation", "value": money(figures["inventory_variation"]), "unit": "RON", "direction": "neutral"},
        {"name": "ebitda_before_stock_variation", "value": money(figures["ebitda_before_stock_variation"]),
         "unit": "RON", "direction": "higher"},
        # The margin rule's ACTIVITY basis (engine.ratios.margin_meaning:
        # cost of sales + operating expenses + depreciation — the same sum
        # as assembled_pl.total_operating_expense), persisted beside turnover
        # so a reader of stored rows (the Section 9 benchmark) asks the ONE
        # margin rule instead of printing a margin it cannot judge.
        {"name": "total_operating_expense", "value": round(cogs + opex + depreciation, 2),
         "unit": "RON", "direction": "neutral"},
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
        {"name": "total_equity",       "value": money(equity_operand),     "unit": "RON",   "direction": "higher"},
        {"name": "current_ratio",      "value": safe(current_assets, current_liab), "unit": "ratio", "direction": "higher"},
        {"name": "debt_to_equity",     "value": safe(total_debt, equity_operand),   "unit": "ratio", "direction": "lower"},
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
        {"name": "roic",               "value": (None if equity_operand is None or total_debt + equity_operand <= 0
                                                 or operating_profit is None
                                                 else safe(operating_profit * (1 - 0.16), total_debt + equity_operand)), "unit": "ratio", "direction": "higher"},
        {"name": "cash",               "value": round(bs["cash"], 2),              "unit": "RON",   "direction": "higher"},
        {"name": "free_cash_flow",     "value": (None if net_income_statutory is None
                                                 else round(net_income_statutory + depreciation, 2)),
         "unit": "RON",  "direction": "higher"},
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
        oi_758_val = pl_canonical_for_adj.get("other_income_758", 0) or 0
        oi_781_val = pl_canonical_for_adj.get("other_income_781_reversals", 0) or 0
        # On the ONE EBITDA, and refused with it. A key the canonical P&L
        # SERVES as None (refused) stays None: the revision-2 fallback read
        # a None here as "not surfaced yet" and printed the EBITDA without
        # 711 / 72x in its place — a second definition under the name.
        if ebitda_refusal is not None:
            adj_ebitda_val = None
        elif "adjusted_ebitda" in pl_canonical_for_adj:
            adj_ebitda_val = _fnum(pl_canonical_for_adj.get("adjusted_ebitda"))
        else:
            # A canonical P&L assembled before F3.14 surfaced it: the same
            # strip on the one EBITDA.
            adj_ebitda_val = ebitda - float(oi_758_val) - float(oi_781_val)
        metrics.extend([
            {"name": "adjusted_ebitda",               "value": money(adj_ebitda_val),
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
    if ebitda_refusal is not None:
        # Refused with the one EBITDA — never `or 0.0` (revision 2 turned a
        # served None into a 0.00 core EBITDA and a 0.0% margin).
        core_ebitda = None
    elif isinstance(pl_canonical_for_core, dict) and "core_ebitda" in pl_canonical_for_core:
        core_ebitda = _fnum(pl_canonical_for_core.get("core_ebitda"))
    else:
        # Fallback: narrow definition matching chart_of_accounts.py:1418
        # exactly (the two named-account sums), so even the fallback path
        # agrees with the canonical answer.
        oi_758_fb = float(pl_canonical_for_core.get("other_income_758", 0.0) if isinstance(pl_canonical_for_core, dict) else 0.0)
        oi_781_fb = float(pl_canonical_for_core.get("other_income_781_reversals", 0.0) if isinstance(pl_canonical_for_core, dict) else 0.0)
        core_ebitda = ebitda_statutory - oi_758_fb - oi_781_fb
    net_debt = total_debt - bs.get("cash", 0.0)

    # ── INVENTORY DAYS — READ from the one served block
    # (engine.ratios.inventory_days, owner spec 2026-09-26 P1): the split by
    # stock type over the flow that moves each stock, on the average
    # balance. Never inventory x 365 / total operating expense again (the
    # Ratios card's 52.5 on Scandia FY2025 beside the Benchmark's 48.8 and
    # the Forecast's 95.3). A statements block without the block, or with a
    # refused total, carries None — never a fallback formula. The CCC adds
    # the split total on the PERIOD-END basis to the period-end DSO and DPO,
    # so its three terms sit on one basis.
    # (Read here as data — the model imports no engine module; the block's
    # schema is the contract, `engine.ratios.inventory_days.served_block`.)
    _inv_raw = s.get("inventory_days")
    _inv_block = (_inv_raw if isinstance(_inv_raw, dict)
                  and _inv_raw.get("schema") == "inventory_days/1" else None)
    _inv_total = (_inv_block or {}).get("total") or {}
    dio_days = _fnum(_inv_total.get("value")) if _inv_block is not None else None
    # ONE DAY-COUNT RULE for dso / dpo / ccc — the ratio table's
    # (engine.ratios.table._day_count), restated here because this module is
    # held to a pure import set (tests/engine/test_credit_model_pure.py) and
    # may not import the table: the served `supplementary.periodDays`, else
    # the 365-day default the table names `constant.period_days_default`. A
    # hard-coded 365 in the products put the cycle's DPO on a different day
    # count from its DSO and the split's DIO on every leap year (366) and
    # every year-to-date month. one-metric-one-formula holds the two rules
    # to one figure on 366- and 181-day periods.
    _sup = s.get("supplementary") if isinstance(s.get("supplementary"), dict) else {}
    period_days = _fnum(_sup.get("periodDays"))
    if period_days is None:
        period_days = 365.0
    dio_days_closing = _fnum(_inv_total.get("closing_value")) if _inv_block is not None else None
    inventory_turnover = (_fnum(((_inv_block or {}).get("inventory_turnover") or {}).get("value"))
                          if _inv_block is not None else None)

    metrics.extend([
        # Liquidity
        {"name": "quick_ratio",          "value": safe(bs.get("cash", 0.0) + ar, current_liab),       "unit": "ratio", "direction": "higher"},
        {"name": "cash_ratio",           "value": safe(bs.get("cash", 0.0), current_liab),            "unit": "ratio", "direction": "higher"},
        {"name": "working_capital",      "value": round(current_assets - current_liab, 2),            "unit": "RON",   "direction": "higher"},
        {"name": "net_debt",             "value": round(net_debt, 2),                                 "unit": "RON",   "direction": "lower"},
        {"name": "net_debt_to_ebitda",   "value": safe(net_debt, ebitda),                             "unit": "ratio", "direction": "lower"},
        # Leverage
        {"name": "equity_ratio",         "value": safe(equity_operand, total_assets),                 "unit": "ratio", "direction": "higher"},
        {"name": "debt_to_assets",       "value": safe(total_debt, total_assets),                     "unit": "ratio", "direction": "lower"},
        {"name": "lt_debt_to_equity",    "value": safe(lt_debt, equity_operand),                      "unit": "ratio", "direction": "lower"},
        # Coverage
        {"name": "ebitda_to_interest",   "value": safe(ebitda, interest),                             "unit": "ratio", "direction": "higher"},
        {"name": "dscr",                 "value": safe(ebitda, interest + st_debt),                   "unit": "ratio", "direction": "higher"},
        # 8-year amortization proxy for LT principal — methodology cheat
        # sheet calls this the "DSCR with LT principal" view.
        {"name": "dscr_with_lt_principal","value": safe(ebitda, interest + lt_debt / 8.0),             "unit": "ratio", "direction": "higher"},
        # Efficiency
        {"name": "asset_turnover",       "value": safe(revenue, total_assets),                        "unit": "ratio", "direction": "higher"},
        {"name": "dso",                  "value": safe(ar * period_days, revenue),                    "unit": "days",  "direction": "lower"},
        {"name": "dio",                  "value": dio_days,                                           "unit": "days",  "direction": "lower"},
        {"name": "dpo",                  "value": safe(ap * period_days, total_operating_expense),    "unit": "days",  "direction": "higher"},
        # CCC = DSO + the split inventory days ON THE PERIOD-END BASIS − DPO:
        # three period-end terms on ONE day count. Refused (None) with the
        # inventory days.
        {"name": "ccc",                  "value": (
            None if (current_liab == 0 or revenue == 0 or total_operating_expense == 0
                     or dio_days_closing is None)
            else round(
                (ar * period_days / revenue)
                + dio_days_closing
                - (ap * period_days / total_operating_expense),
                4,
            )
        ), "unit": "days", "direction": "lower"},
        # Period days / the split total (the block's own figure).
        {"name": "inventory_turnover",   "value": inventory_turnover,                                 "unit": "ratio", "direction": "higher"},
        # Margins over TURNOVER — operating_margin (the one operating
        # result, 711 and 72x inside) + core_ebitda_margin.
        {"name": "operating_margin",     "value": safe(operating_profit, revenue),                    "unit": "ratio", "direction": "higher"},
        {"name": "core_ebitda_margin",   "value": safe(core_ebitda, revenue),                         "unit": "ratio", "direction": "higher"},
        # Core EBITDA itself — surfaced as a RON figure so the FE can
        # render the dual-basis card without recomputing.
        {"name": "core_ebitda",          "value": money(core_ebitda),                                 "unit": "RON",   "direction": "higher"},
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
        ops["ebitda_refusal"] = ebitda_refusal
        ops["net_income_refused"] = net_income_statutory is None
        ops["equity_incomplete"] = equity_incomplete
        refusals = component_refusals(ops)
        rungs = declared_rungs(ops)

        x1: Optional[float] = (current_assets - current_liab) / total_assets
        # X2 = the cumulative book (retained earnings + the year's result)
        # / total assets — refused when the year's result is refused and
        # the sheet does not carry it (`equity_completeness_refusal`).
        x2: Optional[float] = (None if equity_incomplete is not None
                               else bs["retainedEarnings"] / total_assets)
        # X3 on the ONE operating result; refused with it (Altman then
        # refuses as `ebitda_refused`).
        x3: Optional[float] = (None if operating_profit is None
                               else operating_profit / total_assets)
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

        # Leverage sub-score (lower Net Debt/EBITDA = higher score), on the
        # ONE EBITDA (revision 3; revision 2 divided the EBITDA without 711
        # and 72x). Refused with it when net debt is positive.
        # R-D3: net debt <= 0 is measured net cash and scores 100 whatever
        # EBITDA's sign; net debt > 0 with EBITDA <= 0 takes the pack's
        # declared rung 0, labelled. Revision 1 read EBITDA <= 0 as a 999
        # sentinel (score 0) even on a net-cash book.
        net_debt = total_debt - bs["cash"]
        lev_subscore: Optional[float]
        if "leverage" in refusals:
            lev_subscore = None
        elif "leverage" in rungs:
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
        eq_subscore: Optional[float]
        if "equity" in refusals:
            eq_subscore = None
        elif "equity" in rungs:
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
#:
#: THE ONE EBITDA (revision 3, 2026-09-26). Every row built on EBITDA or
#: the operating result was revised with it (711 and 72x inside, 767
#: financial), so a period persisted under revision 2 carries the EBITDA
#: WITHOUT 711 / 72x under these names: each is served from the
#: serve-time model. The three rows revision 3 RETIRED
#: (`ebitda_statutory_with_711`, `inventory_variation_memo`,
#: `total_operating_revenue_statutory` — the gross 711 credit turnover and
#: the totals built on it) are listed too: the serve-time model does not
#: emit them, so `serve_credit_rows` DROPS the persisted copy rather than
#: serve a figure the definition no longer has.
ONE_EBITDA_REVISED_METRICS: Tuple[str, ...] = (
    "gross_profit", "ebitda", "ebitda_cash", "ebitda_statutory", "operating_profit",
    "total_operating_revenue", "gross_margin", "ebitda_margin", "debt_to_ebitda", "roic",
    "net_debt_to_ebitda", "ebitda_to_interest", "dscr", "dscr_with_lt_principal",
    "operating_margin", "core_ebitda", "core_ebitda_margin", "adjusted_ebitda",
    "inventory_variation", "ebitda_before_stock_variation",
)
#: Rows revision 3 added that carry no EBITDA (a stored-row reader's
#: operands): absent from a revision-2 filing, never back-filled.
REVISION_3_ADDED_METRICS: Tuple[str, ...] = ("total_operating_expense",)
RETIRED_METRICS: Tuple[str, ...] = (
    "ebitda_statutory_with_711", "inventory_variation_memo", "total_operating_revenue_statutory",
)
#: The rows the inventory-days ruling (owner spec 2026-09-26 P1) revised:
#: a period persisted before it carries inventory / total operating expense
#: under `dio`, a CCC built on that, and its inverse under
#: `inventory_turnover`. Each is served from the serve-time model, which
#: reads the ONE block (`engine.ratios.inventory_days`).
INVENTORY_DAYS_REVISED_METRICS: Tuple[str, ...] = ("dio", "ccc", "inventory_turnover")
#: The rows the one-day-count repair revised (2026-09-27): DSO and DPO on
#: the served period's day count (`supplementary.periodDays`), as the ratio
#: table and the trade-float insight compute them. A row persisted before
#: the repair — or at write time, where the statements carry no
#: `supplementary` — was multiplied by 365; on a leap year or a
#: year-to-date month it is replaced by the serve-time row, so `metrics[]`,
#: `assembled_metrics.ratios` and the ratio table carry one DPO.
DAY_COUNT_REVISED_METRICS: Tuple[str, ...] = ("dso", "dpo")
#: The rows the owner's rulings of 2026-09-28 revised beyond the EBITDA
#: family above (revision 4): `other_income_781_reversals` is the 781 still
#: INSIDE EBITDA (R2 — the 7812 / 7814 reversals are on the net-provisions
#: line), and net turnover holds 7411 (R3), so `revenue` and the rows that
#: divide it outside the EBITDA family (`net_margin`, `asset_turnover`) are
#: read another way. A period persisted under revision 3 carries the
#: previous figures under these names: each is served from the serve-time
#: model.
RULINGS_2_REVISED_METRICS: Tuple[str, ...] = (
    "other_income_781_reversals", "revenue", "net_margin", "asset_turnover",
)
DEFINITION_REVISED_METRICS: Tuple[str, ...] = (
    ("interest_coverage",) + ONE_EBITDA_REVISED_METRICS + RETIRED_METRICS
    + INVENTORY_DAYS_REVISED_METRICS + DAY_COUNT_REVISED_METRICS
    + RULINGS_2_REVISED_METRICS)

#: Every persisted row a serve-basis response replaces.
SERVE_REPLACED_METRICS: Tuple[str, ...] = CREDIT_FAMILY_METRICS + DEFINITION_REVISED_METRICS


#: Rows `compute_period_metrics` REFUSES (value None) when the assembly
#: refused the NET RESULT (`assembled_pl.net_income_refusal`: no account
#: 121, net 711 refused) — the build-up without the refused 711 under its
#: own names, and every ratio on the net result.
NET_RESULT_REFUSED_METRICS: Tuple[str, ...] = (
    "net_income", "net_income_operational", "net_income_statutory",
    "net_margin", "roa", "roe", "free_cash_flow",
)
#: Rows it refuses when TOTAL EQUITY excludes that refused result
#: (`assembled_bs.total_equity_refusal`). The credit family's X2 and equity
#: sub-score are withheld by `withhold_persisted`; `roic` (on the refused
#: EBIT too) is a definition-revised row the serve-time model replaces, and
#: is left out here so `credit_metrics_as_filed` stays verbatim.
EQUITY_INCOMPLETE_METRICS: Tuple[str, ...] = (
    "total_equity", "equity_ratio", "debt_to_equity", "lt_debt_to_equity",
)


def withhold_refused_result_rows(rows: Any, statements: Mapping[str, Any]
                                 ) -> List[Dict[str, Any]]:
    """PERSISTED metric rows with every row the model now refuses on these
    statements carried as refused (value None): the net-result rows when
    the net result is refused, the equity rows when total equity excludes
    it. A period persisted before the refusal existed still holds the
    numbers under these names, and `GET /api/period` (`metrics[]`, which
    the Ask-CFO chat prints as "Headline metrics") and the briefing
    narrator (`enforce_metric_rows`) would otherwise hand them on beside
    the refusal. New rows; the input is not mutated."""
    out = [dict(r) for r in (rows or []) if isinstance(r, dict)]
    withheld = set()
    apl = statements.get("assembled_pl") if isinstance(statements, Mapping) else None
    if isinstance(apl, Mapping) and isinstance(apl.get("net_income_refusal"), Mapping):
        withheld.update(NET_RESULT_REFUSED_METRICS)
    if equity_completeness_refusal(statements) is not None:
        withheld.update(EQUITY_INCOMPLETE_METRICS)
    if withheld:
        for r in out:
            if r.get("name") in withheld:
                r["value"] = None
    return out


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
            out[key] = subscore_refusal(key, predicate[key], cause=ops.get("ebitda_refusal"))
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


def z_bound_underivable(rows_by_name: Mapping[str, Any]) -> bool:
    """True when the rows carry a Z'' and not the X2 and X3 its bound is
    derived from: the figure cannot be read against its range."""
    return (_num(rows_by_name.get("altman_z_score")) is not None
            and (_num(rows_by_name.get("altman_x2")) is None or _num(rows_by_name.get("altman_x3")) is None))


def withhold_out_of_range(rows_by_name: Mapping[str, Any]) -> Tuple[Dict[str, Any], Dict[str, str]]:
    """`(checked_rows, breaches)`: the rows with every figure outside its
    pack range WITHHELD (R-RANGE, absolute, every surface) — the sub-score
    of a breaching component, the Altman figure that breached together with
    Z'', and the composite whenever anything breached (R-COMPOSITE: no
    composite over a component that did not score). `breaches` is
    `_served_out_of_range`'s `{component or "composite": figure}`. The ONE
    withdrawal, used by the serve-time block and by get_period's
    `basis: as_filed` envelope alike — the as-filed branch once served a
    persisted revision-1 Z'' 1584.89 / X4 1500 raw beside composite 80.7 AA
    while the same body's ratio table refused."""
    m = dict(rows_by_name)
    bad = _served_out_of_range(m)
    for key, figure in bad.items():
        if key == "composite":
            m["credit_composite"] = None
            continue
        m["credit_subscore_%s" % key] = None
        if key == "altman":
            m[figure] = None
            m["altman_z_score"] = None
    if any(k != "composite" for k in bad):
        m["credit_composite"] = None
    return m, bad


def withhold_persisted(rows_by_name: Mapping[str, Any], statements: Mapping[str, Any]
                       ) -> Tuple[Dict[str, Any], Dict[str, Dict[str, Any]], List[Dict[str, Any]]]:
    """`(checked_rows, refused_subscores, withdrawn)` for PERSISTED rows that
    are about to be served as they were filed (get_period's `basis:
    as_filed` envelope and its `metrics[]` rows, when the serve-time model
    cannot run or the ratio table failed). Nothing recomputed these rows,
    so the whole law is applied to them here, in one place:

      range      `withhold_out_of_range` (R-RANGE; a Z'' with no derivable
                 bound included);
      domain     a sub-score the model's own predicate refuses on THESE
                 statements is not served because an earlier revision filed
                 one (revision 1 filed liquidity 0.0 on a book with no
                 current liabilities: a substituted operand, not a score) -
                 with Altman, X4 and Z'' go with it. With statements the
                 operands cannot be read from, the domain is not evaluated;
      composite  none beside a refused component, so no letter (R-COMPOSITE:
                 never renormalised).

    `withdrawn` names every figure that was filed and is not served:
    `{figure, value, code, text}`. A filed figure is never reprinted
    outside this list."""
    filed = dict(rows_by_name)
    m, bad = withhold_out_of_range(filed)
    ops = statement_operands(statements)
    predicate = component_refusals(ops) if ops is not None else {}
    for key in predicate:
        name = "credit_subscore_%s" % key
        if name in m:
            m[name] = None
        if key == "altman":
            for figure in ("altman_x4", "altman_z_score"):
                if figure in m:
                    m[figure] = None
    if ops is not None and ops.get("equity_incomplete") and "altman_x2" in m:
        # X2's numerator (the cumulative book) excludes the refused year's
        # result: a filed X2 is not served over it.
        m["altman_x2"] = None
    refused = _refused_subscores(m, statements)
    for key, figure in bad.items():
        if key != "composite" and key not in predicate:
            refused[key] = subscore_refusal(
                key, CREDIT_OUT_OF_RANGE, figure,
                bound_underivable=(figure == "altman_z_score" and z_bound_underivable(filed)))
    if refused and "credit_composite" in m:
        m["credit_composite"] = None
    withdrawn: List[Dict[str, Any]] = []
    for name in CREDIT_FAMILY_METRICS:
        was = _num(filed.get(name))
        if was is None or _num(m.get(name)) is not None:
            continue
        if name == "credit_composite":
            code = CREDIT_COMPONENT_UNDEFINED if refused else CREDIT_OUT_OF_RANGE
            why = ("composed over %s, which did not score" % " and ".join(k for k in CREDIT_COMPOSITE_WEIGHTS if k in refused)
                   if refused else "outside the model's declared range")
        else:
            key = "altman" if name.startswith("altman_") else name[len("credit_subscore_"):]
            if key in bad:
                # the filed figure (or the figure its component rests on)
                # left its range: that is why THIS value is withdrawn, even
                # where the component also has no domain on this period
                code = CREDIT_OUT_OF_RANGE
                why = ("%s was filed with no X2 and X3 to derive its bound from" % bad[key]
                       if bad[key] == "altman_z_score" and z_bound_underivable(filed)
                       else "%s lies outside its declared range" % bad[key])
            else:
                code = (refused.get(key) or {}).get("code") or CREDIT_INPUTS_ABSENT
                why = "the %s component is not defined on this period" % key
        withdrawn.append({"figure": name, "value": was, "code": code,
                          "text": "withdrawn as filed: %s (%s)" % (why, CREDIT_PACK_FILE)})
    return m, refused, withdrawn


def lawful_persisted_rows(rows: Any, statements: Mapping[str, Any]) -> List[Dict[str, Any]]:
    """PERSISTED metric rows with every credit-family figure the law does
    not allow withheld (value None) - `withhold_persisted` over the rows,
    and, when the pack cannot be read, the whole family (no pack, no range
    to read a figure against). For any consumer handed persisted rows that
    is not the period envelope: the briefing narrator was given a filed
    Z'' 1584.89 to write prose from."""
    from engine.ratios.credit_pack import CreditPackError

    # The net-result and equity rows the model refuses on these statements
    # are refused here too (a period persisted before the refusal holds
    # the numbers).
    out = withhold_refused_result_rows(rows, statements)
    by_name = _rows_by_name(out)
    try:
        checked, _refused, _withdrawn = withhold_persisted(by_name, statements)
    except CreditPackError:
        checked = {n: (v if n == CREDIT_MODEL_REVISION_METRIC or n not in CREDIT_FAMILY_METRICS else None)
                   for n, v in by_name.items()}
    family = set(CREDIT_FAMILY_METRICS)
    for r in out:
        if r.get("name") in family:
            r["value"] = checked.get(r["name"])
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
    # The independent re-check: a served figure outside its range is
    # withheld here whatever produced the rows.
    m, _served_bad = withhold_out_of_range(_rows_by_name(rows))
    z = _num(m.get("altman_z_score"))
    subscores = {k: _num(m.get(name)) for k, name in CREDIT_SUBSCORE_METRICS}
    refused_subscores = _refused_subscores(m, statements)
    # R-COMPOSITE, held by the block itself and not only by the model that
    # feeds it: rows carrying a null sub-score beside an intact composite
    # once served 80.7 AA while `refused_subscores` listed the component.
    if refused_subscores:
        m["credit_composite"] = None
    composite = _num(m.get("credit_composite"))
    letter = composite_to_letter_grade(composite)
    ops = statement_operands(statements)
    # No operands -> nothing is declared: a rung is stated only over
    # measured operands (R-D1: debt == 0, interest == 0, EBIT > 0, all read).
    rungs = ({k: v for k, v in declared_rungs(ops).items() if subscores.get(k) is not None}
             if ops is not None else {})
    # X2 refused beside its value, with the net result's reason, when
    # total equity excludes the refused year's result: the reader prints
    # "refused — <reason>", never a bare dash or the carry-forward alone.
    x2_refusal = _x2_refusal(ops)
    if x2_refusal is not None:
        m["altman_x2"] = None
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
    if x2_refusal is not None:
        block["altman"]["component_refusals"] = {"x2": x2_refusal}
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
    unread_z = filed_bad.get("altman") == "altman_z_score" and z_bound_underivable(filed)
    if f_z is not None and ("altman" in filed_bad):
        withdrawn.append({"figure": "altman_z_score", "value": f_z,
                          "text": ("withdrawn: filed under %s with no X2 and X3 beside it, so it cannot be read "
                                   "against its range" % rev_word) if unread_z else
                                  "withdrawn: computed under %s on a substituted operand (%s outside its range)"
                                  % (rev_word, filed_bad["altman"])})
        f_z = None
    if f_c is not None and filed_bad:
        withdrawn.append({"figure": "credit_composite", "value": f_c,
                          "text": ("withdrawn: composed under %s over a Z'' that cannot be read against its "
                                   "range" % rev_word) if unread_z and len(filed_bad) == 1 else
                                  "withdrawn: computed under %s on a substituted operand (%s outside its range)"
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


def _x2_refusal(ops: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """Altman X2's refusal on these operands: the completeness refusal
    beside total equity (the year's result refused and missing from the
    sheet), carried as the component's own `{code, cause, text_ro,
    text_en, inputs}` — None when X2 has its numerator."""
    ref = (ops or {}).get("equity_incomplete")
    if not ref:
        return None
    return {"code": EBITDA_REFUSED, "cause": ref.get("code"),
            "text_ro": ref.get("text_ro"), "text_en": ref.get("text_en"),
            "inputs": ["balanceSheet.retainedEarnings", "assembled_bs.current_year_pnl",
                       "assembled_bs.total_equity_refusal"]}


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
        **({"altman_component_refusals": alt["component_refusals"]}
           if alt.get("component_refusals") else {}),
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
