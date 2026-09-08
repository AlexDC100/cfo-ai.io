"""THE CROSS-PERIOD SPINE — one ledger account, many periods, and every
absence said out loud.

Radar's detectors (lane D) ask one question over and over: *what moved
that should not have?* That question needs a series, and a series is
where four different lies are easiest to tell. This module exists to make
all four structurally impossible rather than merely checked.

    A SERIES THAT SPANS TWO COMPANIES
        An :class:`AccountSeriesSet` carries exactly ONE
        :class:`EntityKey` (workspace + normalized CUI). The series
        objects inside it carry no entity of their own, and there is no
        constructor that takes per-period entities — a period whose CUI
        differs cannot be admitted, and a period whose CUI is ABSENT is
        refused rather than assumed to match. Two companies in one set
        is not rejected, it is unrepresentable.

    A GAP READ AS A ZERO
        A slot is a `Money` or a typed :class:`NotServed`; it is never
        `None` and it is never `0` standing in for "we don't know". A
        period the account does not appear in is an :class:`AccountGap`
        aligned in place, so `points` is never silently shorter than
        `periods`. "No movement" (two equal closings) and "no data" (a
        gap) are different objects, on purpose.

    A MOVEMENT THAT IS AN FX ARTEFACT
        One currency per set, checked at admission
        (:class:`SeriesCurrencyError`). Every figure stays in the
        period's own currency; this module computes no ratio and prints
        no formatted digits, so nothing here can survive a
        display-currency switch with the wrong magnitude (the 1553% and
        Critical-461 laws, `engine.api._ratio_units`).

    A MOVEMENT READ OFF THE WRONG COLUMN
        Measured on the frozen real parses in `corpus/`: the *sume
        totale* pair means CUMULATIVE MOVEMENTS in four of the five
        10-column books and TOTAL-INCLUDING-OPENING in the fifth, and
        the two readings differ by the entire opening balance. So the
        semantics arrive as DATA (`engine.consensus.selfcheck`'s
        `CUMULATIVE_WITH_OPENING` / `CUMULATIVE_MOVEMENTS`), never
        inferred from the numbers, and an undeclared pair yields
        ``NotServed(CUMULATIVE_SEMANTICS_UNKNOWN)`` rather than a guess.

WHAT IS SERVED, AND WHAT IS NOT (measured, 2026-09-08)

  CLOSING per ledger account  is served — the persisted `line_items`
      rows (`statement_line_items`), one per analytic account, carrying
      the mapper's already-signed amount.
  OPENING per ledger account  is NOT served. `canonical_bs` rows carry
      an `opening` key whose value is `None` for every row of every
      committed fixture; the producer says why —
      `canonical_adapter.py:1360`, "prior-period column not plumbed yet".
  MOVEMENTS per ledger account are NOT served: no envelope key carries
      the rulaj pairs and `FactsGateway` has no accessor for them.

Hence two TIERS, mirroring the gateway's own two-tier design, with the
tier stamped on every point:

  ``TIER_SERVED``  from a persisted period. CLOSING only; opening and
                   movements are `NotServed` with the producer named.
  ``TIER_LEDGER``  from the parsed trial-balance rows (the 10-key row
                   shape the RO pack emits, or IR `LedgerDoc` atoms).
                   All three slots — and the layout-conditional identity
                   is checkable.

NO NEW ENGINE MATH. The only arithmetic here is `debit - credit` on a
column pair, which is `engine.consensus.selfcheck`'s own convention
(`st_signed = cents(st_d) - cents(st_c)`) reused rather than re-derived,
and the identity check delegates its FORM to that module's vocabulary.
Nothing is signed by statement convention — that is the mapper's job and
it is bucket-dependent; `Balance.net` is the LEDGER sign (debit-positive)
and says so.

Python 3.9 — no ``match``, no ``X | Y`` unions.
"""

from __future__ import annotations

import hashlib
import json
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import (
    Any, Dict, List, Optional, Sequence, Tuple, Union,
)

from engine.api._firm_import import normalize_cui
from engine.consensus.compare import cents as _cents
from engine.consensus.selfcheck import (
    CUMULATIVE_MOVEMENTS,
    CUMULATIVE_WITH_OPENING,
)
from engine.ir.money import Money

#: Participates in the cache key. Bump when the shape changes.
SERIES_VERSION = "series1"

TIER_SERVED = "served"
TIER_LEDGER = "ledger"

LEVEL_ANALYTIC = "analytic"
LEVEL_SYNTHETIC = "synthetic"

SLOT_OPENING = "opening"
SLOT_MOVEMENTS = "movements"
#: THE RULAJ — the movement booked IN this period, the `r_d`/`r_c` pair.
#:
#: Distinct from `movements` above, which is the *sume totale* pair and is
#: CUMULATIVE. Modelling only the cumulative one was a real gap: every
#: movement-reading detector family (round-number frequency, first-digit
#: conformity, velocity, magnitude, reversal, direction, decouple) needs
#: the PERIOD movement, and none of them could be served through this
#: spine on either tier. Worse, the module's own IR adapter
#: `rows_from_ledger_doc` emitted the rulaj under `r_d`/`r_c` while the
#: builder read only `st_d`/`st_c`, so the one path from real engine data
#: into this spine produced an empty movement slot on EVERY account,
#: always — and nothing called that adapter, so no test walked it.
SLOT_PERIOD = "period"
SLOT_CLOSING = "closing"
SLOTS = (SLOT_OPENING, SLOT_PERIOD, SLOT_MOVEMENTS, SLOT_CLOSING)

#: Why a slot carries no number. A value, never an exception — a caller
#: reads `isinstance(slot, Money)` to ask "do I have a figure", and reads
#: the reason to say why not.
REASON_TIER_SERVED_CLOSING_ONLY = "tier_served_closing_only"
REASON_COLUMN_ABSENT = "column_absent"
REASON_CUMULATIVE_SEMANTICS_UNKNOWN = "cumulative_semantics_unknown"
REASON_ACCOUNT_ABSENT = "account_absent"
REASON_PERIOD_ABSENT = "period_absent"

#: The exact producer that drops each figure, named so a reader can go
#: and look rather than take this module's word for it.
DETAIL_SERVED_CLOSING_ONLY = (
    "the persisted period carries closing balances only: canonical_bs rows "
    "set \"opening\": None (canonical_adapter.py:1360, \"prior-period column "
    "not plumbed yet\") and no envelope key carries the movement pairs"
)
DETAIL_CUMULATIVE_UNKNOWN = (
    "the source carries a cumulative pair whose semantics were not declared; "
    "%s and %s differ by the whole opening balance, so the movement is not a "
    "fact until the front-end says which one this document uses"
    % (CUMULATIVE_WITH_OPENING, CUMULATIVE_MOVEMENTS)
)
DETAIL_COLUMN_ABSENT = "the source document carries no such column pair"

#: Default width of the RAS grade-I synthetic ("4111.02" -> "411"). It is
#: a PARAMETER, not a constant of the world: another jurisdiction passes
#: its own. Note this is a STRUCTURAL prefix and is deliberately NOT the
#: canonical adapter's `account_codes` (which is the RAS->canonical
#: ROUTING prefix, a mapping decision this module does not duplicate).
DEFAULT_SYNTHETIC_WIDTH = 3

#: Separators that begin the analytic suffix of a source account code.
_ANALYTIC_SEPARATORS = (".", "/", "-", " ")

#: How many periods a cross-period detector needs before it may speak.
DEFAULT_COLD_START_PERIODS = 3


# ── Refusals ─────────────────────────────────────────────────────────────


class SeriesError(ValueError):
    """Base for every build-time refusal in this module."""


class EntityUnknownError(SeriesError):
    """A period carries no CUI this build can normalize. ABSENT is not a
    match: a series whose entity is unknown is not a series."""


class EntityMismatchError(SeriesError):
    """A period belongs to a different company than the set. The worst
    thing this module could produce is a trend drawn across two firms."""


class SeriesCurrencyError(SeriesError):
    """Two periods report in different currencies. A movement between
    them is not a movement, it is an FX artefact. (Same refusal, same
    reason as ``m_series.SeriesCurrencyError``; raised here so radar owns
    its own refusal rather than depending on the findings package.)"""


class DuplicatePeriodError(SeriesError):
    """Two periods share a period id or an ordinal — the spine's order
    would not be a total order, and determinism would be a coin toss."""


# ── Absence, typed ───────────────────────────────────────────────────────


@dataclass(frozen=True)
class NotServed:
    """A slot that holds no number, and why. ABSENT != ZERO, stated as a
    type so a consumer cannot accidentally arithmetic it."""

    slot: str
    reason: str
    detail: str

    def to_payload(self) -> Dict[str, Any]:
        return {"slot": self.slot, "reason": self.reason, "detail": self.detail}


def _not_served(slot: str, reason: str, detail: str) -> NotServed:
    return NotServed(slot=slot, reason=reason, detail=detail)


# ── Amounts ──────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Balance:
    """One column PAIR at one point: both legs verbatim, plus their
    debit-positive net.

    ``net`` is the LEDGER sign — `debit - credit`, which is exactly
    ``engine.consensus.selfcheck``'s ``*_signed``. It is NOT the
    statement sign: whether a credit balance prints positive depends on
    the bucket, and that decision belongs to
    ``trial_balance_parser.accounts_to_assemble_shape``, not here."""

    debit: Money
    credit: Money

    @property
    def net(self) -> Money:
        return self.debit - self.credit

    @property
    def currency(self) -> str:
        return self.debit.currency

    def to_payload(self) -> Dict[str, Any]:
        return {"kind": "balance",
                "debit_minor": int(self.debit.amount_minor),
                "credit_minor": int(self.credit.amount_minor),
                "net_minor": int(self.net.amount_minor),
                "currency": self.debit.currency,
                "sign": "debit_positive"}


@dataclass(frozen=True)
class ServedAmount:
    """The served tier's closing figure: the mapper's already-signed
    ``line_items.amount``, with the bucket whose convention set that
    sign carried alongside it. The legs are not recoverable at this tier
    — they die at the mapper boundary — so this is deliberately NOT a
    :class:`Balance`."""

    amount: Money
    bucket: Optional[str] = None

    @property
    def net(self) -> Money:
        return self.amount

    @property
    def currency(self) -> str:
        return self.amount.currency

    def to_payload(self) -> Dict[str, Any]:
        return {"kind": "served_amount",
                "net_minor": int(self.amount.amount_minor),
                "currency": self.amount.currency,
                "bucket": self.bucket,
                "sign": "statement_convention"}


#: What a slot may hold. Python 3.9 — spelled as a Union alias, not `|`.
Slot = Union[Balance, ServedAmount, NotServed]


def slot_money(slot: Slot) -> Optional[Money]:
    """The figure a slot holds, or None when it holds a refusal. The one
    accessor a consumer needs; ``isinstance(slot, NotServed)`` is the
    other half of the same question."""
    if isinstance(slot, NotServed):
        return None
    return slot.net


# ── Provenance ───────────────────────────────────────────────────────────


@dataclass(frozen=True)
class AtomProvenance:
    """Where one point came from: which period, which snapshot, which
    tier, and which source row."""

    period_id: str
    snapshot_key: str
    tier: str
    account_code: str
    snapshot_id: Optional[str] = None
    source_document_id: Optional[str] = None
    row_index: Optional[int] = None

    def to_payload(self) -> Dict[str, Any]:
        return {
            "period_id": self.period_id,
            "snapshot_key": self.snapshot_key,
            "snapshot_id": self.snapshot_id,
            "source_document_id": self.source_document_id,
            "tier": self.tier,
            "account_code": self.account_code,
            "row_index": self.row_index,
        }


# ── Entity ───────────────────────────────────────────────────────────────


#: The identity prefix a workspace-scoped entity carries in place of a
#: CUI. Never a bare workspace id: a CUI and a workspace id must not be
#: comparable, or a workspace whose id happened to normalize as digits
#: could match a real company.
WORKSPACE_IDENTITY_PREFIX = "workspace:"


@dataclass(frozen=True)
class EntityKey:
    """(workspace, CUI). The only identity a set has, and the reason a
    series cannot span two companies."""

    workspace_id: str
    cui: str

    @classmethod
    def of_workspace(cls, workspace_id: Any) -> "EntityKey":
        """The identity for a product where the WORKSPACE is the company.

        `financial_periods` carries no CUI — measured: the table has
        `id, org_id, source_document_id, period_start, period_end,
        currency, extraction_confidence` and nothing else, and no envelope
        provenance block names one either. So on the serving path there is
        no company registration number to key a series on, and
        :meth:`of` refuses (correctly) rather than inventing one.

        This product's answer is architectural and already written down:
        a workspace IS an organization and holds ONE company (root
        CLAUDE.md §16, "Multi-workspace — one workspace per company").
        Two periods in one workspace are therefore the same company by
        construction, and that is the fact this identity states.

        It does NOT weaken :func:`_entity_guard`. The identity is
        `workspace:<id>`, which `normalize_cui` can never produce, so a
        period that DOES carry a real CUI mismatches and the build
        refuses — which is the conservative answer and the one a reader
        wants: a spine must not silently mix a registered company with an
        unregistered one.
        """
        workspace = str(workspace_id or "").strip()
        if not workspace:
            raise EntityUnknownError("a series needs a workspace id")
        return cls(workspace_id=workspace,
                   cui=WORKSPACE_IDENTITY_PREFIX + workspace)

    @classmethod
    def of(cls, workspace_id: Any, cui_raw: Any) -> "EntityKey":
        workspace = str(workspace_id or "").strip()
        if not workspace:
            raise EntityUnknownError("a series needs a workspace id")
        cui = normalize_cui(cui_raw)
        if not cui:
            raise EntityUnknownError(
                "cannot normalize a CUI from %r — a period with no company "
                "identity is not admitted to a series" % (cui_raw,))
        return cls(workspace_id=workspace, cui=cui)

    def to_payload(self) -> Dict[str, Any]:
        return {"workspace_id": self.workspace_id, "cui": self.cui}


# ── The spine ────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class SeriesPeriod:
    """One period on the spine, LABELLED BY FISCAL END.

    ``ordinal`` is the caller's monotonic sort key and the only ordering
    authority — no clock is read here. ``present`` False marks a spine
    hole the caller declared: the period exists and carries no data, and
    every account's `points` carries an :class:`AccountGap` in its
    place."""

    period_id: str
    fiscal_end: str
    ordinal: int
    currency: str
    tier: str
    snapshot_key: str
    snapshot_id: Optional[str] = None
    source_document_id: Optional[str] = None
    present: bool = True
    label: Optional[str] = None

    def display_label(self) -> str:
        return self.label or self.fiscal_end

    def year_month(self) -> Optional[Tuple[int, int]]:
        end = str(self.fiscal_end or "")
        if len(end) >= 7 and end[4] == "-":
            try:
                return (int(end[:4]), int(end[5:7]))
            except ValueError:
                return None
        return None

    def to_payload(self) -> Dict[str, Any]:
        return {
            "period_id": self.period_id,
            "fiscal_end": self.fiscal_end,
            "label": self.display_label(),
            "ordinal": int(self.ordinal),
            "currency": self.currency,
            "tier": self.tier,
            "snapshot_key": self.snapshot_key,
            "snapshot_id": self.snapshot_id,
            "source_document_id": self.source_document_id,
            "present": bool(self.present),
        }


# ── Points and gaps ──────────────────────────────────────────────────────


@dataclass(frozen=True)
class IdentityCheck:
    """Did opening + movements reconcile to closing, and by which of the
    two identities? ``residual_minor == 0`` is exact. Not checkable is a
    stated reason, never a silent pass."""

    checkable: bool
    semantics: Optional[str] = None
    residual_minor: Optional[int] = None
    reason: str = ""

    @property
    def exact(self) -> bool:
        return self.checkable and self.residual_minor == 0

    def to_payload(self) -> Dict[str, Any]:
        return {"checkable": bool(self.checkable), "semantics": self.semantics,
                "residual_minor": self.residual_minor, "exact": self.exact,
                "reason": self.reason}


@dataclass(frozen=True)
class AccountGap:
    """No data for this account in this period. Distinct from a zero
    balance, distinct from a flat run, and it occupies its slot in
    ``points`` so no consumer ever sees a shorter list."""

    period_id: str
    reason: str

    def to_payload(self) -> Dict[str, Any]:
        return {"kind": "gap", "period_id": self.period_id, "reason": self.reason}


@dataclass(frozen=True)
class AccountPoint:
    """One account in one period."""

    period_id: str
    account_code: str
    label: str
    opening: Slot
    movements: Slot
    closing: Slot
    provenance: AtomProvenance
    #: The RULAJ pair. Declared after `provenance` with a default so no
    #: positional constructor call changes meaning; every builder passes
    #: it by keyword.
    period: Slot = None  # type: ignore[assignment]
    #: For a synthetic point: the analytic codes rolled into it, sorted.
    #: Empty on an analytic point.
    contributors: Tuple[str, ...] = ()
    #: The declared cumulative semantics of the source document, when the
    #: caller declared them. None on the served tier and on any document
    #: whose front-end did not say.
    cumulative_semantics: Optional[str] = None

    def __post_init__(self) -> None:
        # A point built without a rulaj slot has not REFUSED one, it has
        # simply not been told — and `None` is not a Slot. Fill it with
        # the refusal that says exactly that, so `slot_money` keeps
        # working and no consumer ever sees a bare None.
        if self.period is None:
            object.__setattr__(self, "period", _not_served(
                SLOT_PERIOD, REASON_COLUMN_ABSENT, DETAIL_COLUMN_ABSENT))

    @property
    def tier(self) -> str:
        return self.provenance.tier

    def has(self, slot: str) -> bool:
        return slot_money(getattr(self, slot)) is not None

    def net(self, slot: str) -> Optional[Money]:
        return slot_money(getattr(self, slot))

    def identity(self) -> IdentityCheck:
        """The layout-conditional movement identity, in integer minor
        units, with the FORM taken from
        ``engine.consensus.selfcheck``'s vocabulary:

            cumulative_with_opening   closing == movements
            cumulative_movements      closing == opening + movements

        Not a re-derivation: the same two identities
        ``selfcheck.movement_leg`` runs, applied to ONE account so the
        residual is attributable rather than a whole-file boolean."""
        opening = self.net(SLOT_OPENING)
        movements = self.net(SLOT_MOVEMENTS)
        closing = self.net(SLOT_CLOSING)
        # A refused slot already carries WHY. Repeat its reason rather
        # than replacing it with a blander one — "no movement figure"
        # would hide the semantics trap that actually caused it.
        for figure, slot in ((movements, self.movements),
                             (closing, self.closing)):
            if figure is None:
                return IdentityCheck(
                    checkable=False,
                    reason=(slot.detail if isinstance(slot, NotServed)
                            else "no figure to check"))
        semantics = self.cumulative_semantics
        if semantics not in (CUMULATIVE_WITH_OPENING, CUMULATIVE_MOVEMENTS):
            return IdentityCheck(
                checkable=False, reason=DETAIL_CUMULATIVE_UNKNOWN)
        if semantics == CUMULATIVE_MOVEMENTS:
            if opening is None:
                return IdentityCheck(
                    checkable=False,
                    semantics=semantics,
                    reason="the %s identity needs an opening figure and there "
                           "is none" % CUMULATIVE_MOVEMENTS)
            expected = opening.amount_minor + movements.amount_minor
        else:
            expected = movements.amount_minor
        return IdentityCheck(checkable=True, semantics=semantics,
                             residual_minor=int(closing.amount_minor - expected),
                             reason="")

    def to_payload(self) -> Dict[str, Any]:
        return {
            "kind": "point",
            "period_id": self.period_id,
            "account_code": self.account_code,
            "label": self.label,
            "opening": _slot_payload(self.opening),
            "period": _slot_payload(self.period),
            "movements": _slot_payload(self.movements),
            "closing": _slot_payload(self.closing),
            "identity": self.identity().to_payload(),
            "contributors": list(self.contributors),
            "cumulative_semantics": self.cumulative_semantics,
            "provenance": self.provenance.to_payload(),
        }


def _slot_payload(slot: Slot) -> Dict[str, Any]:
    if isinstance(slot, NotServed):
        payload = slot.to_payload()
        payload["kind"] = "absent"
        return payload
    return slot.to_payload()


Observation = Union[AccountPoint, AccountGap]


# ── One account across the spine ─────────────────────────────────────────


@dataclass(frozen=True)
class AccountTimeSeries:
    """One account across the whole spine, in the set's own currency,
    with every gap in its place.

    ``points`` is aligned 1:1 and in order with the SET's ``periods``.
    That alignment is the contract: index i of one series and index i of
    another are the same period of the same company, by construction.

    (Namesake note: ``engine.api.findings.m_series.AccountTimeSeries`` is
    a different object — one CANONICAL STATEMENT LINE per period, one
    value each. This one is a LEDGER ACCOUNT with three slots. Both are
    only ever reached module-qualified.)"""

    account_code: str
    level: str
    label: str
    currency: str
    points: Tuple[Observation, ...]

    def at(self, period_id: str) -> Optional[Observation]:
        for point in self.points:
            if point.period_id == period_id:
                return point
        return None

    def present(self) -> Tuple[AccountPoint, ...]:
        return tuple(p for p in self.points if isinstance(p, AccountPoint))

    def gaps(self) -> Tuple[AccountGap, ...]:
        return tuple(p for p in self.points if isinstance(p, AccountGap))

    def n_present(self) -> int:
        return len(self.present())

    def contiguous_tail(self) -> Tuple[AccountPoint, ...]:
        """The longest run of present points ending at the LAST period on
        the spine. A gap anywhere inside truncates it — a movement
        measured across a hole is not a movement."""
        run = []  # type: List[AccountPoint]
        for point in reversed(self.points):
            if not isinstance(point, AccountPoint):
                break
            run.append(point)
        run.reverse()
        return tuple(run)

    def closing_series(self) -> Tuple[Tuple[str, Optional[Money]], ...]:
        """(period_id, closing) for every period, gaps carried as None.
        The None here is the ABSENCE the caller already knows about from
        ``points``; it is never a zero."""
        out = []  # type: List[Tuple[str, Optional[Money]]]
        for point in self.points:
            if isinstance(point, AccountPoint):
                out.append((point.period_id, point.net(SLOT_CLOSING)))
            else:
                out.append((point.period_id, None))
        return tuple(out)

    def to_payload(self) -> Dict[str, Any]:
        return {
            "account_code": self.account_code,
            "level": self.level,
            "label": self.label,
            "currency": self.currency,
            "points": [p.to_payload() for p in self.points],
        }


# ── Cold start ───────────────────────────────────────────────────────────


@dataclass(frozen=True)
class ColdStart:
    """Fewer periods than a cross-period detector needs. A VALUE, so the
    surface can say it plainly instead of showing an empty radar."""

    have: int
    needed: int

    @property
    def statement(self) -> str:
        return ("%d period(s) with data on the spine; cross-period detection "
                "needs %d. Single-period detectors only — no trend is drawn "
                "from this." % (self.have, self.needed))

    def to_payload(self) -> Dict[str, Any]:
        return {"have": int(self.have), "needed": int(self.needed),
                "statement": self.statement}


# ── The set ──────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class AccountSeriesSet:
    """Every account, over one shared spine, for ONE company.

    The spine is shared on purpose: two accounts compared to each other
    are then entity-matched and period-matched by construction rather
    than index by index."""

    entity: EntityKey
    periods: Tuple[SeriesPeriod, ...]
    currency: str
    series: Dict[str, AccountTimeSeries]
    key: str
    cadence_months: Optional[int] = None
    implied_gaps: Tuple[str, ...] = ()
    tier_counts: Dict[str, int] = field(default_factory=dict)
    synthetic_width: int = DEFAULT_SYNTHETIC_WIDTH

    # -- shape ------------------------------------------------------

    def period_count(self) -> int:
        return len(self.periods)

    def periods_with_data(self) -> Tuple[SeriesPeriod, ...]:
        return tuple(p for p in self.periods if p.present)

    def period_ids(self) -> Tuple[str, ...]:
        return tuple(p.period_id for p in self.periods)

    def latest_period(self) -> Optional[SeriesPeriod]:
        return self.periods[-1] if self.periods else None

    def mixed_tiers(self) -> bool:
        """True when the spine mixes served and ledger periods. Their
        ``.net`` signs follow different conventions, so a claim that
        spans both must say so."""
        return len([t for t, n in self.tier_counts.items() if n]) > 1

    # -- access -----------------------------------------------------

    def get(self, account_code: str) -> Optional[AccountTimeSeries]:
        return self.series.get(str(account_code))

    def require(self, account_code: str) -> AccountTimeSeries:
        found = self.get(account_code)
        if found is None:
            raise KeyError("no series for account %r" % (account_code,))
        return found

    def codes(self, level: Optional[str] = None) -> Tuple[str, ...]:
        return tuple(sorted(
            code for code, s in self.series.items()
            if level is None or s.level == level))

    def analytic_codes(self) -> Tuple[str, ...]:
        return self.codes(LEVEL_ANALYTIC)

    def synthetic_codes(self) -> Tuple[str, ...]:
        return self.codes(LEVEL_SYNTHETIC)

    def children_of(self, synthetic_code: str) -> Tuple[str, ...]:
        """The analytic codes that roll up into one synthetic. Both
        levels are retained and separately addressable: 4111.02
        contributes to 411 and is still its own series."""
        target = str(synthetic_code)
        return tuple(sorted(
            code for code, s in self.series.items()
            if s.level == LEVEL_ANALYTIC
            and synthetic_code_of(code, self.synthetic_width) == target))

    # -- cold start -------------------------------------------------

    def cold_start(self, needed: int = DEFAULT_COLD_START_PERIODS
                   ) -> Optional[ColdStart]:
        have = len(self.periods_with_data())
        if have >= int(needed):
            return None
        return ColdStart(have=have, needed=int(needed))

    # -- payload ----------------------------------------------------

    def to_payload(self, include_series: bool = False) -> Dict[str, Any]:
        payload = {
            "version": SERIES_VERSION,
            "key": self.key,
            "entity": self.entity.to_payload(),
            "currency": self.currency,
            "synthetic_width": int(self.synthetic_width),
            "periods": [p.to_payload() for p in self.periods],
            "period_count": self.period_count(),
            "periods_with_data": len(self.periods_with_data()),
            "cadence_months": self.cadence_months,
            "implied_gaps": list(self.implied_gaps),
            "tier_counts": dict(self.tier_counts),
            "mixed_tiers": self.mixed_tiers(),
            "account_count": len(self.series),
            "analytic_count": len(self.analytic_codes()),
            "synthetic_count": len(self.synthetic_codes()),
        }
        cold = self.cold_start()
        payload["cold_start"] = cold.to_payload() if cold else None
        if include_series:
            payload["series"] = dict(
                (code, self.series[code].to_payload())
                for code in sorted(self.series))
        return payload


# ── Account codes: analytic and synthetic ────────────────────────────────


def source_account_code(code: Any) -> str:
    """The source code, whitespace-trimmed, verbatim otherwise. The
    analytic level IS the source code — this module never rewrites what
    the book wrote."""
    return str(code or "").strip()


def synthetic_code_of(code: str, width: int = DEFAULT_SYNTHETIC_WIDTH) -> str:
    """The synthetic an analytic code rolls into: the source code with
    its analytic suffix removed, truncated to ``width``.

    "4111.02" -> "411", "2111.02" -> "211", "1012.01" -> "101".

    STRUCTURAL, jurisdiction-parameterised by ``width``. Deliberately NOT
    the canonical adapter's `account_codes` (the RAS->canonical ROUTING
    prefix): that is a mapping decision owned by the country pack, and
    duplicating it here would create a second authority that drifts."""
    text = source_account_code(code)
    for sep in _ANALYTIC_SEPARATORS:
        index = text.find(sep)
        if index > 0:
            text = text[:index]
    return text[:max(1, int(width))]


# ── Inputs ───────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class LedgerPeriodInput:
    """A period whose PARSED trial-balance rows the caller still has.
    ``rows`` is the RO pack's 10-key row shape (``cont``, ``nume_cont``,
    ``si_d``/``si_c``, ``r_d``/``r_c``, ``st_d``/``st_c``,
    ``sf_d``/``sf_c``); an IR ``LedgerDoc`` is converted with
    :func:`rows_from_ledger_doc`.

    ``cumulative_semantics`` is DATA from the front-end
    (``engine.consensus.selfcheck.CUMULATIVE_*``). None means undeclared,
    and undeclared means the movement slot refuses."""

    period_id: str
    fiscal_end: str
    ordinal: int
    currency: str
    cui: str
    rows: Sequence[Dict[str, Any]]
    snapshot_key: str
    cumulative_semantics: Optional[str] = None
    snapshot_id: Optional[str] = None
    source_document_id: Optional[str] = None
    label: Optional[str] = None

    tier = TIER_LEDGER


@dataclass(frozen=True)
class ServedPeriodInput:
    """A persisted period, as the route already loads it. ``line_items``
    is the ``statement_line_items`` row shape (``ro_account_code``,
    ``ro_account_name``, ``amount``, ``bucket``, ``statement``) — the
    only account-level figure the served tier carries."""

    period_id: str
    fiscal_end: str
    ordinal: int
    currency: str
    cui: str
    line_items: Sequence[Dict[str, Any]]
    snapshot_key: str
    snapshot_id: Optional[str] = None
    source_document_id: Optional[str] = None
    label: Optional[str] = None

    tier = TIER_SERVED


@dataclass(frozen=True)
class AbsentPeriodInput:
    """A period that exists on the spine and carries no data. Handing one
    of these over is how a caller says "March is missing" without
    inventing a March balance."""

    period_id: str
    fiscal_end: str
    ordinal: int
    cui: str
    label: Optional[str] = None

    tier = TIER_SERVED


PeriodInputT = Union[LedgerPeriodInput, ServedPeriodInput, AbsentPeriodInput]


def rows_from_ledger_doc(doc: Any) -> Tuple[Dict[str, Any], ...]:
    """IR ``LedgerDoc`` -> the 10-key row shape, so a caller holding the
    IR can build a ledger-tier period without a second adapter. ABSENT
    slots stay absent: a `None` Money becomes a MISSING KEY, never a 0,
    and :func:`build_from_ledger_rows` reads a missing key as
    ``column_absent``."""
    out = []  # type: List[Dict[str, Any]]
    pairs = (("opening_debit", "si_d"), ("opening_credit", "si_c"),
             ("period_debit", "r_d"), ("period_credit", "r_c"),
             # The *sume totale* pair. Absent on the corpus books (the IR
             # carries None), which is why it is a MISSING KEY here and
             # `column_absent` downstream — the honest answer, and one this
             # adapter used not to give at all: it emitted no `st_*` key
             # while the builder read only `st_*`, so every ledger point
             # built through the IR had an empty movement slot.
             ("total_debit", "st_d"), ("total_credit", "st_c"),
             ("closing_debit", "sf_d"), ("closing_credit", "sf_c"))
    for atom in getattr(doc, "atoms", ()) or ():
        row = {"cont": atom.account_code, "nume_cont": atom.label}
        for ir_field, legacy in pairs:
            money = getattr(atom, ir_field, None)
            if money is not None:
                row[legacy] = money.amount_minor / float(10 ** money.scale)
        out.append(row)
    return tuple(out)


# ── The build ────────────────────────────────────────────────────────────


def _money(currency: str, value: Any) -> Money:
    """A source figure as exact minor units. ``_cents`` is
    ``engine.consensus.compare.cents`` — the same coercion the consensus
    lane uses, reused so this module and that one can never disagree
    about what a cell was worth."""
    return Money.from_minor(currency, _cents(value))


def _has(row: Dict[str, Any], *keys: str) -> bool:
    """A column pair is PRESENT when the source row carries at least one
    of its two keys. A row that carries neither has no such column, and
    the slot refuses with ``column_absent`` rather than reading 0-0=0."""
    for key in keys:
        if key in row and row.get(key) is not None:
            return True
    return False


def _spine(inputs: Sequence[PeriodInputT]) -> Tuple[Tuple[PeriodInputT, ...], str]:
    """Sort, de-duplicate, and settle the one currency. Refuses rather
    than smoothing, every time."""
    ordered = sorted(inputs, key=lambda p: (int(p.ordinal), str(p.period_id)))
    seen_ids = {}  # type: Dict[str, int]
    seen_ordinals = {}  # type: Dict[int, str]
    currency = ""
    for index, period in enumerate(ordered):
        pid = str(period.period_id)
        if pid in seen_ids:
            raise DuplicatePeriodError(
                "period id %r appears twice on the spine (positions %d and %d)"
                % (pid, seen_ids[pid], index))
        seen_ids[pid] = index
        ordinal = int(period.ordinal)
        if ordinal in seen_ordinals:
            raise DuplicatePeriodError(
                "ordinal %d is claimed by both %r and %r — the spine's order "
                "would not be total" % (ordinal, seen_ordinals[ordinal], pid))
        seen_ordinals[ordinal] = pid
        period_currency = str(getattr(period, "currency", "") or "").upper()
        if not period_currency:
            continue
        if not currency:
            currency = period_currency
        elif period_currency != currency:
            raise SeriesCurrencyError(
                "period %r reports in %s and the spine is in %s — a movement "
                "across that boundary is an FX artefact, not a movement"
                % (pid, period_currency, currency))
    return tuple(ordered), currency


def _entity_guard(entity: EntityKey, inputs: Sequence[PeriodInputT]) -> None:
    """Every period is the SAME company or the build refuses. Absent CUI
    is refused too — absence is not agreement."""
    for period in inputs:
        raw = getattr(period, "cui", None)
        # A workspace identity is carried verbatim, never normalized: it
        # is not a registration number and `normalize_cui` would strip it
        # to nothing. It still has to MATCH, so two workspaces cannot be
        # stitched together any more than two companies can.
        if isinstance(raw, str) and raw.startswith(WORKSPACE_IDENTITY_PREFIX):
            cui = raw
        else:
            cui = normalize_cui(raw)
        if not cui:
            raise EntityUnknownError(
                "period %r carries no CUI this build can normalize (%r); a "
                "period with no company identity is not admitted"
                % (period.period_id, getattr(period, "cui", None)))
        if cui != entity.cui:
            raise EntityMismatchError(
                "period %r belongs to CUI %s and the series is for CUI %s — "
                "a series that spans two companies is the one thing this "
                "module must never produce"
                % (period.period_id, cui, entity.cui))


def _cadence(periods: Sequence[SeriesPeriod]
             ) -> Tuple[Optional[int], Tuple[str, ...]]:
    """The spine's cadence in months, and the fiscal ends it implies but
    does not carry.

    Claimed ONLY when it is unambiguous: at least two consecutive gaps
    that all agree. Otherwise None and no implied gap is asserted —
    inventing a cadence would invent a missing month."""
    stamps = []  # type: List[Tuple[int, int]]
    for period in periods:
        ym = period.year_month()
        if ym is None:
            return None, ()
        stamps.append(ym)
    if len(stamps) < 3:
        return None, ()
    deltas = []  # type: List[int]
    for a, b in zip(stamps, stamps[1:]):
        deltas.append((b[0] - a[0]) * 12 + (b[1] - a[1]))
    if any(d <= 0 for d in deltas):
        return None, ()
    step = min(deltas)
    if any(d % step for d in deltas):
        return None, ()
    if len(set(deltas)) == 1:
        return step, ()
    implied = []  # type: List[str]
    for (a, b), delta in zip(zip(stamps, stamps[1:]), deltas):
        for n in range(1, delta // step):
            months = (a[0] * 12 + (a[1] - 1)) + n * step
            implied.append("%04d-%02d" % (months // 12, months % 12 + 1))
    return step, tuple(implied)


def series_key(entity: EntityKey, periods: Sequence[SeriesPeriod],
               synthetic_width: int = DEFAULT_SYNTHETIC_WIDTH) -> str:
    """(entity, every snapshot on the spine, the rollup width, the
    contract version) -> one sha256.

    The per-period ``snapshot_key`` is supplied by the caller, and
    ``engine.radar.serve.snapshot_key(PeriodInput)`` is the intended
    producer: the hashing DISCIPLINE is reused rather than forked
    (canonical JSON, sorted keys, sha256 — identical to
    ``engine.radar.serve._digest``). This module does not import
    ``serve`` because ``serve`` pulls the whole findings engine, and the
    next wave wires the two together in the other direction."""
    material = {
        "version": SERIES_VERSION,
        "entity": entity.to_payload(),
        "synthetic_width": int(synthetic_width),
        "spine": [[p.period_id, int(p.ordinal), p.fiscal_end, p.snapshot_key,
                   p.tier, bool(p.present)] for p in periods],
    }
    blob = json.dumps(material, sort_keys=True, ensure_ascii=False, default=str)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def _period_of(source: PeriodInputT, currency: str) -> SeriesPeriod:
    absent = isinstance(source, AbsentPeriodInput)
    return SeriesPeriod(
        period_id=str(source.period_id),
        fiscal_end=str(source.fiscal_end),
        ordinal=int(source.ordinal),
        currency=str(getattr(source, "currency", "") or currency).upper(),
        tier=str(getattr(source, "tier", TIER_SERVED)),
        snapshot_key=str(getattr(source, "snapshot_key", "") or "absent"),
        snapshot_id=getattr(source, "snapshot_id", None),
        source_document_id=getattr(source, "source_document_id", None),
        present=not absent,
        label=getattr(source, "label", None),
    )


def _ledger_points(source: LedgerPeriodInput, currency: str
                   ) -> Dict[str, Tuple[AccountPoint, str]]:
    """Analytic points for one ledger-tier period, keyed by account code.
    A code that appears on two rows has its pairs SUMMED — the IR allows
    duplicate account codes on purpose (that is diagnosis D5's business,
    not the spine's), and dropping one would lose money."""
    accumulator = {}  # type: Dict[str, Dict[str, Any]]
    for index, row in enumerate(source.rows):
        if not isinstance(row, dict):
            continue
        code = source_account_code(row.get("cont"))
        if not code:
            continue
        entry = accumulator.get(code)
        if entry is None:
            entry = {
                "label": str(row.get("nume_cont") or "").strip(),
                "row_index": index,
                "si": [0, 0, False], "r": [0, 0, False],
                "st": [0, 0, False], "sf": [0, 0, False],
            }
            accumulator[code] = entry
        for pair, dkey, ckey in (("si", "si_d", "si_c"),
                                 ("r", "r_d", "r_c"),
                                 ("st", "st_d", "st_c"),
                                 ("sf", "sf_d", "sf_c")):
            if not _has(row, dkey, ckey):
                continue
            slot = entry[pair]
            slot[0] += _cents(row.get(dkey))
            slot[1] += _cents(row.get(ckey))
            slot[2] = True

    semantics = source.cumulative_semantics
    out = {}  # type: Dict[str, Tuple[AccountPoint, str]]
    for code in sorted(accumulator):
        entry = accumulator[code]

        def _slot(pair: str, slot_name: str) -> Slot:
            legs = entry[pair]
            if not legs[2]:
                return _not_served(slot_name, REASON_COLUMN_ABSENT,
                                   DETAIL_COLUMN_ABSENT)
            return Balance(debit=Money.from_minor(currency, legs[0]),
                           credit=Money.from_minor(currency, legs[1]))

        opening = _slot("si", SLOT_OPENING)
        closing = _slot("sf", SLOT_CLOSING)
        # The rulaj needs no semantics declaration: it is the movement
        # booked in the period, and there is only one reading of it.
        period_slot = _slot("r", SLOT_PERIOD)
        if semantics not in (CUMULATIVE_WITH_OPENING, CUMULATIVE_MOVEMENTS):
            movements = _not_served(SLOT_MOVEMENTS,
                                    REASON_CUMULATIVE_SEMANTICS_UNKNOWN,
                                    DETAIL_CUMULATIVE_UNKNOWN)  # type: Slot
        else:
            movements = _slot("st", SLOT_MOVEMENTS)

        point = AccountPoint(
            period_id=str(source.period_id),
            account_code=code,
            label=entry["label"],
            opening=opening, movements=movements, closing=closing,
            period=period_slot,
            cumulative_semantics=semantics,
            provenance=AtomProvenance(
                period_id=str(source.period_id),
                snapshot_key=str(source.snapshot_key or "absent"),
                tier=TIER_LEDGER,
                account_code=code,
                snapshot_id=source.snapshot_id,
                source_document_id=source.source_document_id,
                row_index=int(entry["row_index"]),
            ),
        )
        out[code] = (point, entry["label"])
    return out


def _served_points(source: ServedPeriodInput, currency: str
                   ) -> Dict[str, Tuple[AccountPoint, str]]:
    """Analytic points for one served-tier period. Closing only, and the
    other two slots say WHY, naming the producer."""
    accumulator = {}  # type: Dict[str, Dict[str, Any]]
    for index, row in enumerate(source.line_items):
        if not isinstance(row, dict):
            continue
        code = source_account_code(row.get("ro_account_code"))
        if not code:
            continue
        entry = accumulator.get(code)
        if entry is None:
            entry = {"label": str(row.get("ro_account_name") or "").strip(),
                     "row_index": index, "minor": 0, "buckets": set()}
            accumulator[code] = entry
        entry["minor"] += _cents(row.get("amount"))
        bucket = row.get("bucket")
        if bucket:
            entry["buckets"].add(str(bucket))

    out = {}  # type: Dict[str, Tuple[AccountPoint, str]]
    for code in sorted(accumulator):
        entry = accumulator[code]
        buckets = sorted(entry["buckets"])
        point = AccountPoint(
            period_id=str(source.period_id),
            account_code=code,
            label=entry["label"],
            opening=_not_served(SLOT_OPENING, REASON_TIER_SERVED_CLOSING_ONLY,
                                DETAIL_SERVED_CLOSING_ONLY),
            movements=_not_served(SLOT_MOVEMENTS,
                                  REASON_TIER_SERVED_CLOSING_ONLY,
                                  DETAIL_SERVED_CLOSING_ONLY),
            period=_not_served(SLOT_PERIOD,
                               REASON_TIER_SERVED_CLOSING_ONLY,
                               DETAIL_SERVED_CLOSING_ONLY),
            closing=ServedAmount(
                amount=Money.from_minor(currency, int(entry["minor"])),
                bucket=("+".join(buckets) if buckets else None)),
            provenance=AtomProvenance(
                period_id=str(source.period_id),
                snapshot_key=str(source.snapshot_key or "absent"),
                tier=TIER_SERVED,
                account_code=code,
                snapshot_id=source.snapshot_id,
                source_document_id=source.source_document_id,
                row_index=int(entry["row_index"]),
            ),
        )
        out[code] = (point, entry["label"])
    return out


def _roll_up(points: Dict[str, Tuple[AccountPoint, str]], currency: str,
             width: int) -> Dict[str, Tuple[AccountPoint, str]]:
    """Synthetic points for one period, summed from that period's own
    analytic points. Both levels are retained: this returns the synthetic
    layer, the caller keeps the analytic one untouched.

    A synthetic slot is served only when EVERY contributor serves it —
    otherwise the sum would silently read an absence as a zero, which is
    the exact defect this module exists to prevent. The refusal carries
    the first contributor's reason, so the reader learns why."""
    groups = {}  # type: Dict[str, List[AccountPoint]]
    for code in sorted(points):
        point = points[code][0]
        groups.setdefault(synthetic_code_of(code, width), []).append(point)

    out = {}  # type: Dict[str, Tuple[AccountPoint, str]]
    for synthetic in sorted(groups):
        members = groups[synthetic]
        first = members[0]

        def _sum(slot_name: str) -> Slot:
            debit = 0
            credit = 0
            served_minor = 0
            kind = None  # type: Optional[str]
            buckets = set()  # type: set
            for member in members:
                slot = getattr(member, slot_name)
                if isinstance(slot, NotServed):
                    return _not_served(slot_name, slot.reason, slot.detail)
                if isinstance(slot, Balance):
                    if kind == "served":
                        return _not_served(
                            slot_name, REASON_COLUMN_ABSENT,
                            "contributors mix ledger legs and served amounts; "
                            "their signs follow different conventions and are "
                            "not summable")
                    kind = "balance"
                    debit += slot.debit.amount_minor
                    credit += slot.credit.amount_minor
                else:
                    if kind == "balance":
                        return _not_served(
                            slot_name, REASON_COLUMN_ABSENT,
                            "contributors mix ledger legs and served amounts; "
                            "their signs follow different conventions and are "
                            "not summable")
                    kind = "served"
                    served_minor += slot.amount.amount_minor
                    if slot.bucket:
                        buckets.add(slot.bucket)
            if kind == "balance":
                return Balance(debit=Money.from_minor(currency, debit),
                               credit=Money.from_minor(currency, credit))
            if kind == "served":
                return ServedAmount(
                    amount=Money.from_minor(currency, served_minor),
                    bucket=("+".join(sorted(buckets)) if buckets else None))
            return _not_served(slot_name, REASON_ACCOUNT_ABSENT,
                               "no contributor carried this slot")

        contributors = tuple(sorted(m.account_code for m in members))
        point = AccountPoint(
            period_id=first.period_id,
            account_code=synthetic,
            label=first.label,
            opening=_sum(SLOT_OPENING),
            period=_sum(SLOT_PERIOD),
            movements=_sum(SLOT_MOVEMENTS),
            closing=_sum(SLOT_CLOSING),
            contributors=contributors,
            cumulative_semantics=first.cumulative_semantics,
            provenance=AtomProvenance(
                period_id=first.provenance.period_id,
                snapshot_key=first.provenance.snapshot_key,
                tier=first.provenance.tier,
                account_code=synthetic,
                snapshot_id=first.provenance.snapshot_id,
                source_document_id=first.provenance.source_document_id,
                row_index=None,
            ),
        )
        out[synthetic] = (point, first.label)
    return out


def build(entity: EntityKey,
          periods: Sequence[PeriodInputT],
          synthetic_width: int = DEFAULT_SYNTHETIC_WIDTH) -> AccountSeriesSet:
    """Assemble the spine. Refuses on a second company, a second
    currency, a duplicate period or an unknown CUI; carries every other
    absence as a value.

    Deterministic: ordering is `(ordinal, period_id)` for periods and
    `sorted()` for account codes, no clock is read and no `hash()` is
    taken, so the same inputs always produce the same set — and the same
    :func:`series_key`."""
    if not isinstance(entity, EntityKey):
        raise SeriesError("build() needs an EntityKey, got %s"
                          % type(entity).__name__)
    inputs = list(periods)
    _entity_guard(entity, inputs)
    ordered, currency = _spine(inputs)
    currency = currency or "RON"

    spine = tuple(_period_of(p, currency) for p in ordered)
    cadence, implied = _cadence(spine)

    per_period = {}  # type: Dict[str, Dict[str, Tuple[AccountPoint, str]]]
    levels = {}  # type: Dict[str, str]
    labels = {}  # type: Dict[str, str]
    tier_counts = {}  # type: Dict[str, int]
    for source in ordered:
        pid = str(source.period_id)
        if isinstance(source, AbsentPeriodInput):
            per_period[pid] = {}
            continue
        tier_counts[str(source.tier)] = tier_counts.get(str(source.tier), 0) + 1
        if isinstance(source, LedgerPeriodInput):
            analytic = _ledger_points(source, currency)
        else:
            analytic = _served_points(source, currency)
        synthetic = _roll_up(analytic, currency, synthetic_width)
        merged = {}  # type: Dict[str, Tuple[AccountPoint, str]]
        for code, value in analytic.items():
            merged[code] = value
            levels[code] = LEVEL_ANALYTIC
            labels.setdefault(code, value[1])
        for code, value in synthetic.items():
            # An analytic code that IS its own synthetic (a 3-digit code
            # written without an analytic suffix) keeps the analytic
            # point: it is the source row, not a sum of one.
            if code in merged:
                continue
            merged[code] = value
            levels[code] = LEVEL_SYNTHETIC
            labels.setdefault(code, value[1])
        per_period[pid] = merged

    series = {}  # type: Dict[str, AccountTimeSeries]
    for code in sorted(levels):
        points = []  # type: List[Observation]
        for period in spine:
            found = per_period.get(period.period_id, {}).get(code)
            if found is None:
                points.append(AccountGap(
                    period_id=period.period_id,
                    reason=(REASON_PERIOD_ABSENT if not period.present
                            else REASON_ACCOUNT_ABSENT)))
            else:
                points.append(found[0])
        series[code] = AccountTimeSeries(
            account_code=code, level=levels[code], label=labels.get(code, ""),
            currency=currency, points=tuple(points))

    return AccountSeriesSet(
        entity=entity, periods=spine, currency=currency, series=series,
        key=series_key(entity, spine, synthetic_width),
        cadence_months=cadence, implied_gaps=implied,
        tier_counts=tier_counts, synthetic_width=int(synthetic_width))


class SeriesCache(object):
    """Bounded, in-process, keyed on :func:`series_key`. Deliberately the
    same shape as ``engine.radar.serve.RadarCache`` — ``get_or_build``,
    ``hits``/``misses``, ``stats()`` — so the wiring wave has one cache
    idiom rather than two.

    Entries are held as the built objects, not as bytes: every type in
    this module is frozen and its containers are tuples, so a hit cannot
    be mutated by its holder. (``RadarCache`` re-parses JSON because its
    payload is a plain dict, which a caller could edit.)"""

    def __init__(self, max_entries: int = 256) -> None:
        self._entries = OrderedDict()  # type: OrderedDict
        self.max_entries = int(max_entries)
        self.hits = 0
        self.misses = 0

    def __len__(self) -> int:
        return len(self._entries)

    def reset_counters(self) -> None:
        self.hits = 0
        self.misses = 0

    def get_or_build(self, entity: EntityKey,
                     periods: Sequence[PeriodInputT],
                     synthetic_width: int = DEFAULT_SYNTHETIC_WIDTH
                     ) -> AccountSeriesSet:
        """The key is formed from the SPINE alone — entity, ordinals,
        fiscal ends, snapshot keys, tiers, presence — so it can be taken
        before any account row is read, and an unchanged spine never
        rebuilds."""
        spine = tuple(_period_of(p, str(getattr(p, "currency", "") or "RON"))
                      for p in sorted(periods,
                                      key=lambda p: (int(p.ordinal),
                                                     str(p.period_id))))
        key = series_key(entity, spine, synthetic_width)
        found = self._entries.get(key)
        if found is not None:
            self.hits += 1
            self._entries.move_to_end(key)
            return found
        self.misses += 1
        built = build(entity, periods, synthetic_width)
        self._entries[key] = built
        while len(self._entries) > self.max_entries:
            self._entries.popitem(last=False)
        return built

    def invalidate(self, key: str) -> None:
        self._entries.pop(key, None)

    def stats(self) -> Dict[str, int]:
        return {"hits": self.hits, "misses": self.misses,
                "entries": len(self._entries)}


def build_from_ledger_rows(entity: EntityKey,
                           periods: Sequence[LedgerPeriodInput],
                           synthetic_width: int = DEFAULT_SYNTHETIC_WIDTH
                           ) -> AccountSeriesSet:
    """:func:`build` narrowed to ledger-tier periods."""
    return build(entity, periods, synthetic_width)


def build_from_served_periods(entity: EntityKey,
                              periods: Sequence[ServedPeriodInput],
                              synthetic_width: int = DEFAULT_SYNTHETIC_WIDTH
                              ) -> AccountSeriesSet:
    """:func:`build` narrowed to served-tier periods."""
    return build(entity, periods, synthetic_width)


__all__ = [
    "CUMULATIVE_MOVEMENTS", "CUMULATIVE_WITH_OPENING",
    "DEFAULT_COLD_START_PERIODS", "DEFAULT_SYNTHETIC_WIDTH",
    "DETAIL_COLUMN_ABSENT", "DETAIL_CUMULATIVE_UNKNOWN",
    "DETAIL_SERVED_CLOSING_ONLY",
    "LEVEL_ANALYTIC", "LEVEL_SYNTHETIC",
    "REASON_ACCOUNT_ABSENT", "REASON_COLUMN_ABSENT",
    "REASON_CUMULATIVE_SEMANTICS_UNKNOWN", "REASON_PERIOD_ABSENT",
    "REASON_TIER_SERVED_CLOSING_ONLY",
    "SERIES_VERSION", "SLOTS", "SLOT_CLOSING", "SLOT_MOVEMENTS",
    "WORKSPACE_IDENTITY_PREFIX",
    "SLOT_PERIOD",
    "SLOT_OPENING", "TIER_LEDGER", "TIER_SERVED",
    "AbsentPeriodInput", "AccountGap", "AccountPoint", "AccountSeriesSet",
    "AccountTimeSeries", "AtomProvenance", "Balance", "ColdStart",
    "DuplicatePeriodError", "EntityKey", "EntityMismatchError",
    "EntityUnknownError", "IdentityCheck", "LedgerPeriodInput", "NotServed",
    "Observation", "SeriesCurrencyError", "SeriesError", "SeriesPeriod",
    "SeriesCache", "ServedAmount", "ServedPeriodInput", "Slot",
    "build", "build_from_ledger_rows", "build_from_served_periods",
    "rows_from_ledger_doc", "series_key", "slot_money",
    "source_account_code", "synthetic_code_of",
]
