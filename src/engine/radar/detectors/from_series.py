"""THE JOIN: the detector families read the SPINE, not a parallel model.

WHY THIS MODULE EXISTS
======================
Parts A and B of Radar landed in one commit and were not connected. Part
A (``engine.radar.series``) is the ``AccountTimeSeries`` spine: two tiers,
typed refusals, the ``si + st == sf`` cumulative-semantics guard, and a
measured identity that is EXACTLY zero on every account of every corpus
book. Part B (``engine.radar.detectors``) reads
``detectors.book.PeriodBook``, which parses ``doc.atoms`` directly.

Nothing in ``src/`` imported ``series.py``. The commit message said "the
cross-period spine and twelve detectors" as though the second read the
first; it did not, and calling them joined was wrong.

The gap was not cosmetic. ``PeriodBook`` had NO served-tier constructor
at all, so the serving lane — which holds ``statement_line_items``, never
a parsed ledger doc — could not build a ``BookSeries`` and therefore
could not run a detector. That is why the detectors shipped with no
production caller. And a naive served constructor would have walked
straight back into the D4 defect from the other side: served line items
carry a closing amount and NOTHING else, so a row built from them with
zero-filled movement slots would let every movement-reading detector
report a confident 0.0.

WHAT THE SPINE ENFORCES THAT A DIRECT ADAPTER WOULD NOT
=======================================================
· TIER. A served period carries closing only, and says so with a typed
  ``NotServed(tier_served_closing_only)`` in the opening and movement
  slots rather than a zero. This module turns that refusal into ``None``
  on the row, which is what ``AccountRow``'s accessors already mean by
  absent — so a movement-reading detector on a served book returns
  ``na()`` naming the missing column instead of a false zero.
· SIGN CONVENTION. The ledger tier's ``net`` is debit-positive
  (``debit - credit``); the served tier's is the mapper's already-signed
  statement amount. They are different conventions and the spine keeps
  them apart. A row is built from ONE tier's convention, never a mix.
· GAPS. A period where an account does not appear is an ``AccountGap``,
  not a shorter list — which is exactly what ``BookSeries.readings``
  needs so ``contiguous_tail`` can truncate at a hole (see the dormant
  family's repair).
· CUMULATIVE SEMANTICS. Where the front end declared none, the spine
  refuses the movement slot rather than guessing which of the two
  readings the ``sume totale`` column carries — the two differ by the
  entire opening balance, and 129 carniprod accounts read the other way
  from every other book.

Python 3.9 — no ``match``, no ``X | Y`` unions.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Sequence, Tuple

from .. import series as S
from . import book as B

__all__ = ["book_series_from_spine", "period_books_from_spine",
           "SpineJoinError"]


class SpineJoinError(ValueError):
    """The spine cannot produce books a detector could read."""


def _leg_pair(slot: "S.Slot") -> Tuple[Optional[float], Optional[float]]:
    """One spine slot as the (debit, credit) pair ``AccountRow`` holds.

    A REFUSAL BECOMES ``(None, None)`` — absent, which every accessor on
    ``AccountRow`` already propagates as absent. It never becomes
    ``(0.0, 0.0)``: that is the substitution D4 made, and it is the one
    substitution a balance-sheet reader can never make.

    The served tier's legs are not recoverable — they die at the mapper
    boundary — so its already-signed amount is carried on the side its
    sign indicates. That keeps ``closing_signed()`` (debit minus credit)
    returning the statement figure unchanged, which is what every
    detector reads.
    """
    if isinstance(slot, S.NotServed):
        return (None, None)
    if isinstance(slot, S.ServedAmount):
        minor = int(slot.net.amount_minor)
        value = minor / 100.0
        return (value, None) if minor >= 0 else (None, -value)
    # Balance: both legs verbatim, in units.
    return (int(slot.debit.amount_minor) / 100.0,
            int(slot.credit.amount_minor) / 100.0)


def _row_from_point(point: "S.AccountPoint") -> "B.AccountRow":
    opening_d, opening_c = _leg_pair(point.opening)
    # THE RULAJ, not the *sume totale*. `AccountRow.period_debit/credit`
    # means the movement booked IN this period — every detector's
    # arithmetic assumes it, and `book.py` records the measurement that
    # made the distinction load-bearing: class-70 credit in the rulaj is
    # 8.0-10.4% of annual revenue across the corpus, because the column
    # is ONE MONTH. `point.movements` is the cumulative pair and is a
    # different figure; mapping it here would silently multiply every
    # movement-based finding by the year.
    move_d, move_c = _leg_pair(point.period)
    close_d, close_c = _leg_pair(point.closing)
    return B.AccountRow(
        code=str(point.account_code),
        name=str(point.label),
        # A STABLE, ADDRESSABLE ID. The spine's provenance names the
        # period, the snapshot and the row; a finding's `atom_ids` has to
        # walk back to exactly one source row, so the id is those three
        # joined rather than the bare code — two periods carry the same
        # account and must not collide.
        atom_id="%s:%s" % (point.provenance.period_id, point.account_code),
        opening_debit=opening_d, opening_credit=opening_c,
        period_debit=move_d, period_credit=move_c,
        closing_debit=close_d, closing_credit=close_c)


def period_books_from_spine(
        spine: "S.AccountSeriesSet",
        basis_by_period: Optional[Dict[str, "B.BasisTotals"]] = None,
        days_by_period: Optional[Dict[str, Optional[int]]] = None,
        ) -> List["B.PeriodBook"]:
    """One :class:`PeriodBook` per period of the spine, in spine order.

    ``basis_by_period`` and ``days_by_period`` come from the CALLER,
    because neither is the spine's to know: a share is taken of an
    engine-assembled total, and how many days a movement column covers is
    a fact about the source document. Both default to absent, and the
    detectors that need them refuse by name rather than assuming — the
    ``rulaj`` column is ONE MONTH on these books, not a year, and
    assuming 365 overstated every cycle by a factor of twelve.
    """
    if spine.mixed_tiers():
        raise SpineJoinError(
            "this spine mixes %s periods; the two tiers sign their figures "
            "by different conventions (ledger: debit minus credit; served: "
            "the mapper's statement sign), so a detector reading across them "
            "would compare a positive to a negative and call the difference a "
            "movement" % " and ".join(
                sorted(t for t, n in spine.tier_counts.items() if n)))

    basis_by_period = basis_by_period or {}
    days_by_period = days_by_period or {}

    books = []  # type: List[B.PeriodBook]
    for index, period in enumerate(spine.periods):
        rows = []  # type: List[B.AccountRow]
        for code in sorted(spine.series):
            observation = spine.series[code].at(period.period_id)
            # A GAP IS NOT A ROW. An account absent from this period must
            # not appear in this book at all — that is what lets
            # `BookSeries.readings` return None for it and
            # `contiguous_tail` break a run at the hole.
            if observation is None or isinstance(observation, S.AccountGap):
                continue
            rows.append(_row_from_point(observation))
        books.append(B.PeriodBook(
            period_id=period.period_id,
            label=period.label or period.fiscal_end or period.period_id,
            ordinal=int(period.ordinal if period.ordinal is not None else index),
            currency=spine.currency,
            rows=tuple(rows),
            # `SeriesPeriod` derives (year, month) from its FISCAL END and
            # returns None when the string cannot say — no clock, no guess.
            year=(period.year_month() or (None, None))[0],
            month=(period.year_month() or (None, None))[1],
            snapshot_id=period.snapshot_id,
            basis=basis_by_period.get(period.period_id) or B.BasisTotals(),
            source="radar.series/%s" % period.tier,
            days_covered=days_by_period.get(period.period_id)))
    return books


def book_series_from_spine(
        spine: "S.AccountSeriesSet",
        basis_by_period: Optional[Dict[str, "B.BasisTotals"]] = None,
        days_by_period: Optional[Dict[str, Optional[int]]] = None,
        ) -> "B.BookSeries":
    """The spine as the series the detector families read."""
    books = period_books_from_spine(spine, basis_by_period, days_by_period)
    if not books:
        raise SpineJoinError(
            "this spine carries no period, so there is nothing to detect over")
    return B.BookSeries.of(books)
