"""Romania pack parameters: the declared figures a verdict is computed with.

THIS MODULE IS DATA. Every value below is a figure some engine refusal or
substitution rule reads, and every message that states the figure renders
it from HERE (TC-10: no cutoff is written as prose). Each entry carries the
source it is taken from, so a served label can cite it.

Nothing here is a measurement of a book. A rule that uses one of these
values in place of a figure the book did not yield must say so on the
served block (kd_source / tax_source / periodDaysBasis) — a declared
assumption is not a floor, and it is never silent.
"""
from __future__ import annotations

from typing import Tuple

#: Romanian statutory profit-tax rate (impozit pe profit).
STATUTORY_PROFIT_TAX_RATE: float = 0.16
STATUTORY_PROFIT_TAX_SOURCE: str = (
    "Legea 227/2015 privind Codul fiscal, art. 17 (cota de impozit pe profit 16%)"
)

#: The methodology's cost-of-debt assumption for a Romanian SME, stated
#: AFTER tax, used by the DCF only when a book's own implied rate
#: (interest expense / debt) is not measurable.
METHODOLOGY_KD_AFTER_TAX_RANGE: Tuple[float, float] = (0.055, 0.075)
METHODOLOGY_KD_SOURCE: str = (
    "CLAUDE.md Appendix A section 4, Section 6 (DCF WACC build-up): "
    "cost of debt 5.5-7.5% after tax for a Romanian SME"
)

#: Start of the financial year the trial balance's cumulative (year-to-date)
#: movements run from. The accounting law sets the financial year to the
#: calendar year as the rule; an entity on a different financial year is the
#: exception the law allows and cannot be read off a trial balance.
FISCAL_YEAR_START_MONTH: int = 1
FISCAL_YEAR_START_DAY: int = 1
FISCAL_YEAR_START_SOURCE: str = (
    "Legea contabilității 82/1991, art. 27 (exercițiul financiar coincide, "
    "de regulă, cu anul calendaristic)"
)

#: Period-detection signals that do NOT establish a period end. A period
#: filed under one of these was filed somewhere because it had to be, not
#: because anything read its date (pipeline.resolve_period_end_for_persist).
UNESTABLISHED_PERIOD_SIGNALS: Tuple[str, ...] = ("fallback_today",)
