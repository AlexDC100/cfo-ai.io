"""DETAIL LEVEL as a first-class fact, and what two of them permit.

A trial balance is a book kept at a chosen depth. The same company, the
same twelve months, can be handed over as 247 rows of grade-II synthetic
accounts (the extract that goes to the bank, the auditor, ONRC) or as 809
rows of per-counterparty analytics (the internal export). Both are true;
neither is more true. Romanian practice issues both routinely, and a
client who sends two years of a business will very often send one of
each.

WHY THIS MODULE EXISTS. Put those two books side by side without knowing
which is which and the product invents history. The measured case, on the
two real Scandia books: exactly one classification bucket is present in
the analytic year and absent in the synthetic year — the doubtful-
receivable family. A column model that reads an absent line as a zero
reports that doubtful receivables were eliminated in full, or appeared
from nothing, depending on which year you put in the prior column. Both
readings are fabrications, and both read as NEWS.

So detail level is detected per period, and the comparison is only ever
struck at a level BOTH periods actually carry.

THE VOCABULARY IS JURISDICTION-BLIND. Synthetic-vs-analytic is a
double-entry idea, not a Romanian one; Hungary's szamlatukor splits the
same way. Where the boundary falls — how many digits make a synthetic
account — is a chart-of-accounts fact and lives in the country pack. The
pack imports these names; this module never imports a pack.

Python 3.9 — no `match`, no `X | Y` unions.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, Tuple

__all__ = [
    "SYNTHETIC",
    "ANALYTIC",
    "MIXED",
    "INDETERMINATE",
    "LEVELS",
    "effective_level",
    "carries_analytic_detail",
    "Comparability",
    "assess_comparability",
]

#: Every row sits on a synthetic account — the rolled-up chart. Statement
#: lines are complete; breakdowns below the synthetic boundary are not in
#: the book at all.
SYNTHETIC = "synthetic"

#: Every row sits on an analytic account — the working chart, one row per
#: counterparty / contract / cost centre.
ANALYTIC = "analytic"

#: Both kinds present in material quantity. A mixed book carries analytic
#: detail for SOME accounts, which is precisely why it cannot be RELIED on
#: to carry it for the one you are about to read. Mixed floors to
#: synthetic for every comparability decision — see `effective_level`.
MIXED = "mixed"

#: No usable account codes. Not a level: a refusal. Never silently read as
#: synthetic, because "we could not tell" and "it is the coarse one" are
#: different facts and only one of them permits a comparison.
INDETERMINATE = "indeterminate"

LEVELS: Tuple[str, ...] = (SYNTHETIC, ANALYTIC, MIXED, INDETERMINATE)


def effective_level(level: str) -> Optional[str]:
    """The level a book can be RELIED on to carry, or None.

    ANALYTIC stays analytic. SYNTHETIC stays synthetic. MIXED floors to
    SYNTHETIC — a book that carries analytics for some accounts tells you
    nothing about the account you are reading. INDETERMINATE, and any
    token not in `LEVELS`, is None: an unknown level is not a coarse
    level.
    """
    if level == ANALYTIC:
        return ANALYTIC
    if level == SYNTHETIC or level == MIXED:
        return SYNTHETIC
    return None


def carries_analytic_detail(level: str) -> bool:
    """True only for a book that is analytic THROUGHOUT."""
    return effective_level(level) == ANALYTIC


@dataclass(frozen=True)
class Comparability:
    """What two periods at these two detail levels permit.

    `statement_lines` and `analytic_detail` are deliberately separate
    verdicts. The common real case — one synthetic year against one
    analytic year — is TRUE for the first and FALSE for the second, and
    collapsing them into one boolean would either throw away the year-on-
    year statement comparison the client asked for or serve breakdowns
    that only one of the two years can support.
    """

    comparable: bool
    #: The level the comparison is struck at, or None when there is none.
    level: Optional[str]
    current_level: str
    prior_level: str
    #: Statement-line YoY (revenue, EBITDA, total assets, …) may proceed.
    statement_lines: bool
    #: Figures that only exist below the synthetic boundary may proceed.
    analytic_detail: bool
    reason: str


def assess_comparability(current_level: str, prior_level: str) -> Comparability:
    """THE COMPARABILITY RULE.

    Two periods at different detail levels are comparable at the SYNTHETIC
    level only.

    Statement-line year-on-year proceeds across a level difference because
    the roll-up is lossless: measured on the real 809-row analytic book,
    0 of 809 accounts change classification bucket or sign when their code
    is truncated from analytic depth to the synthetic boundary. A
    statement line is a sum over buckets, so a sum that survives the
    truncation of every one of its terms survives the truncation.

    Anything that needs a row the coarse book does not contain does not
    proceed. There is no partial credit and no estimate: the answer is
    that this period was not disclosed at that detail level.

    An INDETERMINATE level on either side yields no comparison at all.
    """
    cur = effective_level(current_level)
    pri = effective_level(prior_level)

    if cur is None or pri is None:
        unknown = []
        if cur is None:
            unknown.append("current=%r" % (current_level,))
        if pri is None:
            unknown.append("prior=%r" % (prior_level,))
        return Comparability(
            comparable=False,
            level=None,
            current_level=current_level,
            prior_level=prior_level,
            statement_lines=False,
            analytic_detail=False,
            reason=(
                "detail level could not be established (%s); no comparison "
                "is struck — an undetermined level is not a coarse level"
                % ", ".join(unknown)
            ),
        )

    both_analytic = cur == ANALYTIC and pri == ANALYTIC
    level = ANALYTIC if both_analytic else SYNTHETIC

    if both_analytic:
        reason = (
            "both periods are analytic throughout; the comparison is struck "
            "at the analytic level and every disclosed breakdown may move"
        )
    else:
        reason = (
            "comparison struck at the synthetic level (current=%s, "
            "prior=%s): statement lines roll up losslessly across the "
            "difference, figures that exist only below the synthetic "
            "boundary do not" % (current_level, prior_level)
        )

    return Comparability(
        comparable=True,
        level=level,
        current_level=current_level,
        prior_level=prior_level,
        statement_lines=True,
        analytic_detail=both_analytic,
        reason=reason,
    )
