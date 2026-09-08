"""Typed refusals. A forecast that cannot be produced honestly is not
produced at all — it never degrades into a number with a footnote.

Every one of these carries the figures the reader needs to act: which
period, which line, by how much. None of them is ever caught inside this
package and turned into a default.
"""

from __future__ import annotations

from typing import Optional

__all__ = [
    "ForecastError",
    "OpeningPositionError",
    "BalanceViolation",
    "AssumptionError",
]


class ForecastError(Exception):
    """Base class — a projection was refused."""


class OpeningPositionError(ForecastError):
    """The opening position could not be taken from the source period's
    CLOSING balances without loss. Raised when the partition of the
    served canonical balance sheet does not reproduce the served totals
    to the cent, or when the serving carries no balance sheet at all."""

    def __init__(self, message: str, *, side: Optional[str] = None,
                 delta_cents: Optional[int] = None) -> None:
        ForecastError.__init__(self, message)
        self.side = side
        self.delta_cents = delta_cents


class BalanceViolation(ForecastError):
    """A projected period did not close. THE HARD ERROR.

    Assets − (equity + liabilities) was not zero for ``period_label``,
    by ``delta_cents``. There is no tolerance band and no annotation
    path: the projection is refused, and the message names the period
    and the amount so the cause is findable.
    """

    def __init__(self, period_label: str, delta_cents: int,
                 assets_cents: int, equity_plus_liabilities_cents: int) -> None:
        from .money import fmt
        ForecastError.__init__(
            self,
            "projected period %s does not balance: assets %s − "
            "(equity + liabilities) %s = %s (must be exactly 0)"
            % (period_label, fmt(assets_cents),
               fmt(equity_plus_liabilities_cents), fmt(delta_cents)),
        )
        self.period_label = period_label
        self.delta_cents = int(delta_cents)
        self.assets_cents = int(assets_cents)
        self.equity_plus_liabilities_cents = int(equity_plus_liabilities_cents)


class AssumptionError(ForecastError):
    """An assumption was supplied that the model cannot honour (a
    negative day count, a horizon of zero years, an unknown
    granularity). Naming the key rather than silently clamping it."""

    def __init__(self, key: str, message: str) -> None:
        ForecastError.__init__(self, "assumption %r: %s" % (key, message))
        self.key = key
