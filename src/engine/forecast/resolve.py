"""The resolver seam (plan/2 B5, plan_contract_v2 3.4, 1.4).

One place resolves a book's driver defaults for ``project_plan``. Today it is
``derive_assumptions`` over the anchor alone: the BOOK rung of every ladder
that would read a prior period records "prior periods are not read in this
build" (that sentence is written by the ladders themselves, in
assumptions.py and pools.py). B7 replaces the body of this function with the
history-reading resolvers; nothing else in the engine changes when it does.

Python 3.9 - no ``match``, no ``X | Y``.
"""

from __future__ import annotations

from typing import Any, Dict, Mapping, Sequence, Tuple

from .assumptions import AssumptionSet, BookContext, derive_assumptions
from .errors import AssumptionError

__all__ = ["HISTORY_NOT_READ", "resolve_defaults"]

#: The note of contract 1.4 served until B7 lands.
HISTORY_NOT_READ = {"code": "history_not_read",
                    "text": "prior periods are not read in this build"}


def resolve_defaults(opening: Any, history: Any, context: BookContext,
                     prior_periods: Sequence[Mapping[str, Any]],
                     assumption_overrides: Dict[str, Any]
                     ) -> Tuple[AssumptionSet, Tuple[str, ...]]:
    """The resolved defaults and the resolver's notes.

    ``prior_periods`` must be empty in this build: a caller that passes one
    believes it is being read, and it is not. Refused by name rather than
    silently ignored."""
    if prior_periods:
        raise AssumptionError(
            "prior_periods",
            "%d prior period(s) were passed and %s"
            % (len(prior_periods), HISTORY_NOT_READ["text"]))
    assumptions = derive_assumptions(opening, history, context=context,
                                     **assumption_overrides)
    return assumptions, (HISTORY_NOT_READ["text"],)
