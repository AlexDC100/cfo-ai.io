"""THE LEDGER SUBSTRATE A RADAR DETECTOR READS.

The multi-period lane in ``engine.api.findings.m_series`` builds its
spine from ASSEMBLED STATEMENT LINES — canonical buckets, one number per
line per period. That is the right substrate for "receivables rose three
periods running". It is the wrong one for four of the twelve Radar
families, which are claims about the LEDGER itself:

    round-number concentration   needs every movement, not their sum
    first-digit distribution     needs the population of amounts
    counterparty concentration   needs 411.01 apart from 411.02
    reversal / cutoff            needs the debit and credit SIDES of a
                                 movement, which a net line has already
                                 collapsed

So this module carries the second substrate: the parsed source document,
period by period, at account granularity, with the IR's own ``atom_id``
on every row so a finding can name the evidence it read rather than
gesturing at a bucket.

ABSENT != ZERO, on every slot. ``AccountAtom`` already distinguishes "the
document has no such column" (``None``) from "the document states zero"
(``Money(0)``); this module preserves that distinction all the way to the
detector: :meth:`AccountRow.closing_signed` returns ``None`` when BOTH
sides are absent and never folds an absent column into a zero. A period
missing from the series is a GAP, and a gap TRUNCATES a run rather than
bridging it — the same rule ``m_series`` enforces on its own spine.

WHICH COLUMN BECOMES A MOVEMENT — MEASURED, NOT ASSUMED
The ``saga_10_col`` front end maps ``r_d / r_c`` (rulaj perioada) to
``period_debit / period_credit`` and puts ``st_d / st_c`` (sume totale)
in the document's source_meta instead (``engine/frontends/saga10.py``, its
own column table). On the four real books in ``tests/engine/fixtures/firm``
that rulaj column is ONE MONTH: the class 70 credit side sums to 8.0%,
10.4%, 8.4% and 8.7% of the annual revenue the engine assembles for the
same period. So a movement read here is the movement of whatever window
the document covers, and the window is a FACT the caller supplies as
:attr:`PeriodBook.days_covered` — never 365 by assumption. Reading a
December rulaj as a year overstates every cycle twelvefold.

NO BALANCE SHEET IS REBUILT HERE. Totals a detector compares against
(total assets, revenue) are not summed out of these rows: they arrive as
:class:`BasisTotals`, supplied by the caller from the FactsGateway, and
when they are absent the detector that needs them is NOT APPLICABLE with
the reason stated. Re-deriving a total from ledger rows beside the
engine's own served total is how two numbers for one fact get shipped.

Python 3.9 — no ``match``, no ``X | Y`` unions.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Sequence, Tuple

#: Where a basis figure came from. Stated on the finding, never guessed.
BASIS_SOURCE_GATEWAY = "facts_gateway"
BASIS_SOURCE_CALLER = "caller_supplied"
BASIS_ABSENT = "absent"


def _f(money: Any) -> Optional[float]:
    """A Money (or a plain number) as a float in major units, ABSENT
    preserved. Accepts the IR's ``Money`` without importing it, so this
    module stays usable against a plain-dict projection of a document."""
    if money is None:
        return None
    if isinstance(money, (int, float)) and not isinstance(money, bool):
        return float(money)
    minor = getattr(money, "amount_minor", None)
    if minor is None:
        return None
    scale = getattr(money, "scale", 2)
    return float(minor) / float(10 ** int(scale))


def _sum_present(a: Optional[float], b: Optional[float]) -> Optional[float]:
    """a - b with ABSENT semantics: absent on BOTH sides is ABSENT; absent
    on one side is that side contributing nothing to a stated figure."""
    if a is None and b is None:
        return None
    return float(a or 0.0) - float(b or 0.0)


@dataclass(frozen=True)
class AccountRow:
    """One source account in one period, six slots and its atom id."""

    code: str
    name: str
    atom_id: str
    opening_debit: Optional[float] = None
    opening_credit: Optional[float] = None
    period_debit: Optional[float] = None
    period_credit: Optional[float] = None
    closing_debit: Optional[float] = None
    closing_credit: Optional[float] = None

    @classmethod
    def from_atom(cls, atom: Any) -> "AccountRow":
        return cls(
            code=str(atom.account_code), name=str(atom.label),
            atom_id=str(atom.atom_id),
            opening_debit=_f(atom.opening_debit),
            opening_credit=_f(atom.opening_credit),
            period_debit=_f(atom.period_debit),
            period_credit=_f(atom.period_credit),
            closing_debit=_f(atom.closing_debit),
            closing_credit=_f(atom.closing_credit))

    def closing_signed(self) -> Optional[float]:
        return _sum_present(self.closing_debit, self.closing_credit)

    def opening_signed(self) -> Optional[float]:
        return _sum_present(self.opening_debit, self.opening_credit)

    def movement_signed(self) -> Optional[float]:
        return _sum_present(self.period_debit, self.period_credit)

    def movement_gross(self) -> Optional[float]:
        """Both sides added, not netted. A 4M debit against a 4M credit is
        8M of activity and a zero net — the round-number and first-digit
        families are about the activity."""
        if self.period_debit is None and self.period_credit is None:
            return None
        return abs(float(self.period_debit or 0.0)) + abs(float(self.period_credit or 0.0))

    def movement_debit(self) -> Optional[float]:
        """The debit side of the period alone.

        THE CLOSING-ENTRY TRAP: a class 6 or class 7 account is closed to
        the result account at year end, so its NET movement is zero and its
        GROSS movement is twice its turnover. An expense charge is the
        DEBIT side and revenue recognised is the CREDIT side; a detector
        that wants either must say which, and the pack does."""
        return None if self.period_debit is None else abs(float(self.period_debit))

    def movement_credit(self) -> Optional[float]:
        return None if self.period_credit is None else abs(float(self.period_credit))

    def moved(self) -> bool:
        gross = self.movement_gross()
        return gross is not None and gross > 0.0

    def depth(self) -> int:
        """Analytic depth: 411 is 0, 411.01 is 1. What tells a synthetic
        account from the per-counterparty analytics under it."""
        return self.code.count(".") + (1 if len(self.code.split(".")[0]) > 3 else 0)


@dataclass(frozen=True)
class BasisTotals:
    """The company totals a detector may compare against, and where each
    came from. A total that is ABSENT stays ``None`` — the detector that
    needs it reports NOT APPLICABLE rather than dividing by a guess."""

    total_assets: Optional[float] = None
    revenue: Optional[float] = None
    source: str = BASIS_ABSENT

    def get(self, name: str) -> Optional[float]:
        if name == "total_assets":
            return self.total_assets
        if name == "revenue":
            return self.revenue
        return None

    def label(self, name: str) -> str:
        return {"total_assets": "total assets", "revenue": "revenue"}.get(name, name)


@dataclass(frozen=True)
class Group:
    """The rows a detector's account selector matched, in one period."""

    prefixes: Tuple[str, ...]
    rows: Tuple[AccountRow, ...]

    def present(self) -> bool:
        return bool(self.rows)

    # ── THE AGGREGATES SUM LEAVES, NEVER `self.rows` ─────────────────────
    #
    # A synthetic account's figure IS the sum of its analytics, so a total
    # over both counts the same money twice. `leaves()` twenty lines below
    # has said so since it was written; these five accessors did not read
    # it, and every family that reaches a figure through them — direction,
    # magnitude, decouple, velocity, reversal, dormant, cutoff, and
    # `assetage` through its own `.rows` sum — was doubling.
    #
    # MEASURED, and this is how it was found. `interco` computes its own
    # total over `leaves()` and its related-party figure matched the served
    # `ar_intercompany` row TO THE CENT (RON 7,692,202.74). `assetage`
    # summed `.rows` and reported RON 22,011,353.08 of net book value where
    # the served balance sheet carries RON 11,005,676.54 — EXACTLY twice.
    # The share it fired on (70.5%) looked right the whole time, because a
    # ratio of two doubled numbers is the same ratio. The money was the
    # only thing that gave it away, which is the argument for citing money
    # rather than only a percentage.
    #
    # This matters more on the spine than on a raw parse: `from_series`
    # ADDS the synthetic roll-ups, so a spine-built book always carries
    # both levels.

    def _leaf_sum(self, measure: str) -> Optional[float]:
        vals = [getattr(r, measure)() for r in self.leaves()]
        present = [v for v in vals if v is not None]
        return sum(present) if present else None

    def closing(self) -> Optional[float]:
        return self._leaf_sum("closing_signed")

    def movement(self) -> Optional[float]:
        return self._leaf_sum("movement_signed")

    def movement_gross(self) -> Optional[float]:
        return self._leaf_sum("movement_gross")

    def movement_debit(self) -> Optional[float]:
        return self._leaf_sum("movement_debit")

    def movement_credit(self) -> Optional[float]:
        return self._leaf_sum("movement_credit")

    def atom_ids(self) -> Tuple[str, ...]:
        return tuple(sorted(r.atom_id for r in self.rows))

    def codes(self) -> Tuple[str, ...]:
        out = []  # type: List[str]
        for r in self.rows:
            if r.code not in out:
                out.append(r.code)
        return tuple(sorted(out))

    def leaves(self) -> Tuple[AccountRow, ...]:
        """The rows nothing else in the group extends — the per-counterparty
        analytics where the book carries them, the synthetic account where
        it does not. Summing a synthetic together with its own analytics
        double-counts, so the parents drop out.

        LEAFNESS IS THE PREFIX RELATION, NOT A DEPTH. Taking "the deepest
        rows" looks equivalent and is not: a book carrying 4111.01, 4111.03
        and 4118 has two code shapes at two depths, and 4118 is nobody's
        parent — it is a sibling that the depth rule silently deleted from
        the denominator. Measured on the real carniprod book, that made a
        counterparty's share read 80.1% where the engine's own assembled
        line items say 71.8%.
        """
        if not self.rows:
            return ()
        codes = [r.code for r in self.rows]
        out = []  # type: List[AccountRow]
        for row in self.rows:
            if any(other != row.code and other.startswith(row.code)
                   for other in codes):
                continue
            out.append(row)
        return tuple(out)


@dataclass(frozen=True)
class PeriodBook:
    """One parsed period."""

    period_id: str
    label: str
    ordinal: int
    currency: str
    rows: Tuple[AccountRow, ...] = ()
    year: Optional[int] = None
    month: Optional[int] = None
    snapshot_id: Optional[str] = None
    basis: BasisTotals = BasisTotals()
    source: str = "ledger_doc"
    #: How many days the PERIOD MOVEMENT covers, when the caller knows it.
    #: ABSENT stays absent: a cycle in days is stock over a flow scaled by
    #: the flow's own window, and assuming 365 for a monthly rulaj column
    #: overstates every cycle by a factor of twelve. The detector that
    #: needs this refuses without it.
    days_covered: Optional[int] = None

    @classmethod
    def from_ledger_doc(cls, doc: Any, period_id: str, label: str, ordinal: int,
                        year: Optional[int] = None, month: Optional[int] = None,
                        basis: Optional[BasisTotals] = None,
                        snapshot_id: Optional[str] = None,
                        days_covered: Optional[int] = None) -> "PeriodBook":
        rows = tuple(AccountRow.from_atom(a) for a in doc.atoms)
        return cls(period_id=period_id, label=label, ordinal=ordinal,
                   currency=str(doc.header.currency), rows=rows,
                   year=year, month=month, snapshot_id=snapshot_id,
                   basis=basis or BasisTotals(), days_covered=days_covered)

    def select(self, prefixes: Sequence[str]) -> Group:
        wanted = tuple(str(p) for p in prefixes)
        hits = tuple(r for r in self.rows
                     if any(r.code.startswith(p) for p in wanted))
        return Group(prefixes=wanted, rows=hits)

    def same_period_key(self) -> Optional[Tuple[int, int]]:
        if self.year is None or self.month is None:
            return None
        return (int(self.year), int(self.month))


@dataclass(frozen=True)
class SeriesPoint:
    """One period's reading of one group. ``value is None`` is a GAP."""

    book: "PeriodBook"
    value: Optional[float]


@dataclass(frozen=True)
class BookSeries:
    """The ordered periods, and the readings taken across them."""

    books: Tuple[PeriodBook, ...]
    currency: str

    @classmethod
    def of(cls, books: Sequence[PeriodBook]) -> "BookSeries":
        ordered = tuple(sorted(books, key=lambda b: (b.ordinal, b.period_id)))
        currencies = sorted(set(b.currency for b in ordered if b.currency))
        if len(currencies) > 1:
            raise ValueError(
                "the series mixes %s; movements across a currency change are "
                "FX artefacts, not movements" % " and ".join(currencies))
        return cls(books=ordered, currency=(currencies[0] if currencies else ""))

    def period_count(self) -> int:
        return len(self.books)

    def latest(self) -> Optional[PeriodBook]:
        return self.books[-1] if self.books else None

    def years_covered(self) -> int:
        years = set(b.year for b in self.books if b.year is not None)
        return len(years)

    def labels(self) -> Tuple[str, ...]:
        return tuple(b.label for b in self.books)

    def readings(self, prefixes: Sequence[str], measure: str = "closing"
                 ) -> Tuple[SeriesPoint, ...]:
        """One reading per period. ``measure`` is ``closing``, ``movement``,
        ``movement_gross``, ``debit`` or ``credit``; a period whose selector
        matches no row is a GAP (``None``), never a zero."""
        out = []  # type: List[SeriesPoint]
        for book in self.books:
            group = book.select(prefixes)
            if not group.present():
                out.append(SeriesPoint(book=book, value=None))
                continue
            if measure == "movement":
                value = group.movement()
            elif measure == "movement_gross":
                value = group.movement_gross()
            elif measure == "debit":
                value = group.movement_debit()
            elif measure == "credit":
                value = group.movement_credit()
            else:
                value = group.closing()
            out.append(SeriesPoint(book=book, value=value))
        return tuple(out)

    def contiguous_tail(self, points: Sequence[SeriesPoint]
                        ) -> Tuple[SeriesPoint, ...]:
        """The unbroken run ending at the latest period. A gap truncates."""
        tail = []  # type: List[SeriesPoint]
        for point in reversed(list(points)):
            if point.value is None:
                break
            tail.append(point)
        return tuple(reversed(tail))

    def same_period_last_year(self, points: Sequence[SeriesPoint]
                              ) -> Optional[SeriesPoint]:
        """The latest period's counterpart one calendar year earlier,
        matched on (year, month) — never on "n rows back", which is the
        same period only when the spine is complete and gapless."""
        if not points:
            return None
        latest = points[-1]
        key = latest.book.same_period_key()
        if key is None:
            return None
        want = (key[0] - 1, key[1])
        for point in points:
            if point.value is None:
                continue
            if point.book.same_period_key() == want:
                return point
        return None


__all__ = [
    "AccountRow", "BasisTotals", "BookSeries", "Group", "PeriodBook",
    "SeriesPoint", "BASIS_ABSENT", "BASIS_SOURCE_CALLER",
    "BASIS_SOURCE_GATEWAY",
]
