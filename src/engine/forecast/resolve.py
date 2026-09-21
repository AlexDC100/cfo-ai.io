"""The resolver seam (plan/2 B5, plan_contract_v2 3.4, 1.4; B7).

One place resolves a book's driver defaults for ``project_plan``.

Until B7 this function REFUSED any prior period by name, and every BOOK rung
that would read one recorded "prior periods are not read in this build". It
now reads exactly one thing from the history the loader hands it: the
comparable prior period's own turnover, which is what the ``revenue_growth``
ladder's book rung is measured from. Everything else still resolves from the
anchor alone, and every pool rung still records the note (pools.py rung 1 is
a multi-period fit this build does not run).

The ELIGIBILITY verdict is NOT taken here. ``engine.api._forecast_history``
decides which prior periods are comparable and hands over only those; a
period that arrives here is one the loader has already vouched for. That
keeps one authority for "is this a comparable period", so a ladder cannot
quietly widen it.

Python 3.9 - no ``match``, no ``X | Y``.
"""

from __future__ import annotations

from typing import Any, Dict, Mapping, Optional, Sequence, Tuple

from .assumptions import AssumptionSet, BookContext, derive_assumptions
from .errors import AssumptionError
from .history import pl_history_from_payload

__all__ = ["HISTORY_NOT_READ", "HISTORY_READ", "resolve_defaults"]

#: The note of contract 1.4, served for every rung this build still cannot
#: reach a prior period for (the pools' multi-period fit, B7+).
HISTORY_NOT_READ = {"code": "history_not_read",
                    "text": "prior periods are not read in this build"}

#: ...and the note served when one WAS read. Its text names the period, so
#: the reader of the plan can see which book the growth was measured against
#: without opening the driver's basis.
HISTORY_READ = {"code": "history_read",
                "text": "revenue growth is measured against the prior "
                        "period ending %s; every other driver is resolved "
                        "from the anchor alone"}


def _prior_revenue(prior: Mapping[str, Any]) -> Tuple[Optional[int], Optional[str]]:
    """(revenue in cents, period_end) of one handed-over prior period, read
    through the SAME authority the anchor's P&L is read through
    (``assembled_pl``), so the two turnovers a growth quotes cannot come
    from two different readers."""
    period_end = prior.get("period_end")
    period_end = str(period_end) if period_end else None
    revenue = pl_history_from_payload(dict(prior)).revenue
    return revenue, period_end


def resolve_defaults(opening: Any, history: Any, context: BookContext,
                     prior_periods: Sequence[Mapping[str, Any]],
                     assumption_overrides: Dict[str, Any]
                     ) -> Tuple[AssumptionSet, Tuple[str, ...]]:
    """The resolved defaults and the resolver's notes.

    ``prior_periods`` is what the loader vouched for, most recent first. At
    most the FIRST is read: a single-year growth is a two-point reading, and
    a third point would be a fit this build does not run. More than one is
    refused BY NAME rather than silently truncated — a caller that passes
    three believes three are being read."""
    if len(prior_periods) > 1:
        raise AssumptionError(
            "prior_periods",
            "%d prior period(s) were passed and this build reads at most "
            "one (the two-point growth of the revenue_growth ladder)"
            % (len(prior_periods),))
    if not prior_periods:
        assumptions = derive_assumptions(opening, history, context=context,
                                         **assumption_overrides)
        return assumptions, (HISTORY_NOT_READ["text"],)

    revenue, period_end = _prior_revenue(prior_periods[0])
    context = context.with_prior(revenue, period_end)
    assumptions = derive_assumptions(opening, history, context=context,
                                     **assumption_overrides)
    if revenue is None or period_end is None:
        # ABSENT != ZERO: the period was comparable but carries no turnover
        # this reader can see. The ladder has already recorded why on the
        # driver; the resolver's note stays the "not read" one so nothing
        # claims a measurement that did not happen.
        return assumptions, (HISTORY_NOT_READ["text"],)
    return assumptions, (HISTORY_READ["text"] % period_end,)
