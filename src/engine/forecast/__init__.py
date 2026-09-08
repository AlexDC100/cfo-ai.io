"""Driver-based three-statement projection over the engine's own books.

A forecast is an ASSUMPTION and every other number this engine prints is
a FACT anchored to a source cell. The package keeps the two apart on
purpose: the opening position is read from the CANONICAL balance sheet
through the facts gateway and proved to reproduce it to the cent
(``opening.py``); every driver carries its source and the sentence it
was derived from (``assumptions.py``); and every projected period is
required to balance EXACTLY or the projection is refused
(``project.py``).

    from engine.forecast import project_payload
    projection = project_payload(payload, revenue_growth=0.08)

No AI produces a projected number here — there is no model call in this
package and no path by which one could reach a figure.

Python 3.9 — no ``match``, no ``X | Y``.
"""

from __future__ import annotations

from .assumptions import (Assumption, AssumptionSet, DebtMove, DebtSchedule,
                          derive_assumptions)
from .errors import (AssumptionError, BalanceViolation, ForecastError,
                     OpeningPositionError)
from .history import PlHistory, pl_history_from_payload
from .money import fmt, to_float
from .opening import ASSET_LINES, EL_LINES, LINES, OpeningPosition
from .project import (CF_LINES, PL_LINES, ProjectedPeriod, Projection, project,
                      project_payload)
from .render import render_text
from .timeline import Period, build_timeline

__all__ = [
    "ASSET_LINES",
    "Assumption",
    "AssumptionError",
    "AssumptionSet",
    "BalanceViolation",
    "CF_LINES",
    "DebtMove",
    "DebtSchedule",
    "EL_LINES",
    "ForecastError",
    "LINES",
    "OpeningPosition",
    "OpeningPositionError",
    "PL_LINES",
    "Period",
    "PlHistory",
    "ProjectedPeriod",
    "Projection",
    "build_timeline",
    "derive_assumptions",
    "fmt",
    "pl_history_from_payload",
    "project",
    "project_payload",
    "render_text",
    "to_float",
]
