"""THE PERIOD SPINE — one line, many periods, gaps stated out loud.

Everything in the multi-period lane reads this module and nothing else for
its history. It exists to make three failures structurally impossible:

    A FABRICATED TREND
        The analyses do not take a list of numbers. They take a
        :class:`History`, and a `History` cannot be constructed from
        fewer points than the analysis declares it needs — the
        constructor raises :class:`NeedsHistoryError`. There is no code
        path that computes a slope, a median or a year-over-year move
        from one period, because there is no object to compute it from.

    A GAP READ AS A ZERO
        An :class:`Observation` whose value is absent carries ``None``,
        never ``0.0``. `present()` skips it, `gaps()` names it, and every
        window is built from CONTIGUOUS present points — a hole breaks a
        run rather than being bridged. ABSENT != ZERO, in a series
        exactly as on a balance sheet.

    AN ENTITY MISMATCH
        A series is keyed by a CANONICAL line, is carried in the period's
        OWN currency, and refuses to admit a period whose currency
        differs. Comparing December's RON receivable to a EUR restatement
        of the same account is a unit error, and `_ratio_units` is the
        authority that says so.

COLD START IS A RESULT, NOT AN ABSENCE
:class:`NeedsHistory` is a typed value carrying, per analysis, how many
periods it needs and how many it got. A single-period upload therefore
answers "these seven analyses need a second comparable period, and this
one needs two years" — which is a claim a reader can act on, unlike
silence and unlike a trend drawn through one point.

WHAT IS AND IS NOT MONEY
`LineSpec.money_fact` is the name under which a line's magnitude may be
PRINTED, and it must be a name `_ratio_units` declares as money. A
canonical line the registry does not declare (inventory, payables, COGS)
carries ``None`` and is never rendered as a currency figure — its
findings speak in shares, days and counts instead. That is the registry's
rule applied honestly rather than worked around: a money number whose
name is undeclared would print a currency word that never converts.

Python 3.9 — no `match`, no `X | Y` unions.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Sequence, Tuple

from .. import _finding as F
from .. import _ratio_units


# ── Refusals ─────────────────────────────────────────────────────────────


class NeedsHistoryError(ValueError):
    """An analysis was handed fewer comparable periods than it declares it
    needs. Raised by the window constructors, so the weak computation
    never happens — the caller converts it into a
    :class:`AnalysisRequirement` row instead."""

    def __init__(self, analysis_id: str, needed: int, have: int,
                 detail: str = "") -> None:
        self.analysis_id = analysis_id
        self.needed = needed
        self.have = have
        self.detail = detail
        ValueError.__init__(self, (
            "%s needs %d comparable period(s) and has %d%s"
            % (analysis_id, needed, have, ("; " + detail) if detail else "")))


class SeriesCurrencyError(ValueError):
    """Two periods of the same line report in different currencies. A
    movement between them is not a movement, it is an FX artefact."""


# ── Directions, roles, kinds ─────────────────────────────────────────────

DIRECTION_UP = "up"          # rising is the adverse direction
DIRECTION_DOWN = "down"      # falling is the adverse direction
DIRECTION_NONE = "none"      # direction carries no verdict for this line

ROLE_SUBJECT = "subject"     # may be the subject of a finding
ROLE_BASIS = "basis"         # a denominator only (no ledger code of its own)

KIND_STOCK = "stock"         # a balance at a date
KIND_FLOW = "flow"           # an amount earned or spent across the period

SIDE_ASSET = "asset"
SIDE_CONTRA_ASSET = "contra_asset"
SIDE_LIABILITY = "liability"
SIDE_EQUITY = "equity"
SIDE_PL = "pl"

#: Used to annualise a working-capital cycle when the spine does not say
#: how many days a period covers. It is an ASSUMPTION, and every finding
#: that relies on it carries a caveat saying so — a monthly flow
#: annualised at 365 would overstate a cycle twelvefold, which is exactly
#: the kind of silent wrongness this lane exists to remove.
DAYS_IN_YEAR = 365

BASIS_ASSETS = "total_assets"
BASIS_REVENUE = "revenue"
BASIS_EQUITY = "total_equity"

#: The canonical sub-views a line may be read from, searched in this
#: order. `subAggregates` last: it is the memo layer, and a value that
#: appears in both should be taken from the statement view.
VIEW_ORDER = ("assembled_bs", "assembled_pl", "assembled_cf", "subAggregates")


# ── The period spine ─────────────────────────────────────────────────────


@dataclass(frozen=True)
class PeriodRef:
    """One period on the spine.

    `ordinal` is the caller's monotonic sort key and the ONLY ordering
    authority — no date parsing happens in this module and no clock is
    read, so the same inputs always produce the same spine. `year` and
    `month` are optional and exist for one purpose: same-period-last-year
    matching. When either is absent, the seasonal analysis reports that
    it could not identify a comparable period rather than falling back to
    "twelve rows earlier", which is only the same month if the spine
    happens to be monthly and complete.
    """

    period_id: str
    label: str
    ordinal: int
    year: Optional[int] = None
    month: Optional[int] = None
    snapshot_id: Optional[str] = None
    #: How many days of trading the period's FLOW lines cover. `None`
    #: means the spine does not say, and a cycle computed from it is
    #: annualised at `DAYS_IN_YEAR` with a caveat attached rather than
    #: quietly assuming a full year.
    days_covered: Optional[int] = None

    def same_period_key(self) -> Optional[Tuple[int, int]]:
        if self.year is None or self.month is None:
            return None
        return (int(self.year), int(self.month))


@dataclass(frozen=True)
class Observation:
    """One reading of one line in one period. `value is None` is a GAP —
    the line was not carried by that period's views. It is not zero and
    it never becomes zero."""

    period: PeriodRef
    value: Optional[float]
    source: str = ""

    def is_gap(self) -> bool:
        return self.value is None


@dataclass(frozen=True)
class LineSpec:
    """What a canonical line IS, for the purpose of reading it across
    periods. The default table below is Romanian (the account codes are
    RAS); a different jurisdiction passes its own table to
    :func:`build_series_set` rather than editing this one."""

    key: str
    label: str
    accounts: Tuple[F.Account, ...]
    names: Tuple[str, ...]
    role: str = ROLE_SUBJECT
    statement: Optional[str] = None
    adverse_direction: str = DIRECTION_NONE
    #: Name under which the magnitude may be printed as money, or None
    #: when `_ratio_units` does not declare one — see the module note.
    money_fact: Optional[str] = None
    basis: str = BASIS_ASSETS
    kind: str = KIND_STOCK
    #: Which side of the book the line sits on. Dormancy, for instance,
    #: is a claim about an ASSET nobody collected; the same run of
    #: unchanged periods on a payable is a supplier who has not invoiced.
    side: str = SIDE_ASSET
    #: Whether "this has not moved for N periods" is a FINDING for this
    #: line. It is for a receivable, a stock balance or a stalled
    #: construction account — each of those is a claim or a good that
    #: should have turned over. It is not for cash (a settlement account
    #: sitting flat is a bank statement, not an aging problem) and not for
    #: participations (a holding is supposed to keep holding). Without
    #: this flag the analysis produces a technically-true, useless row —
    #: which is the exact failure mode this whole lane replaces.
    dormancy: bool = True
    views: Tuple[str, ...] = VIEW_ORDER

    def scope_key(self) -> str:
        return "+".join(a.code for a in self.accounts) or self.key


@dataclass(frozen=True)
class AccountTimeSeries:
    """One canonical line across the whole spine, in the period's own
    currency, with every gap explicit."""

    spec: LineSpec
    currency: str
    observations: Tuple[Observation, ...]

    # -- identity ---------------------------------------------------

    @property
    def key(self) -> str:
        return self.spec.key

    @property
    def label(self) -> str:
        return self.spec.label

    @property
    def accounts(self) -> Tuple[F.Account, ...]:
        return self.spec.accounts

    # -- shape ------------------------------------------------------

    def present(self) -> Tuple[Observation, ...]:
        return tuple(o for o in self.observations if not o.is_gap())

    def gaps(self) -> Tuple[PeriodRef, ...]:
        return tuple(o.period for o in self.observations if o.is_gap())

    def n_present(self) -> int:
        return len(self.present())

    def at(self, period_id: str) -> Optional[Observation]:
        for o in self.observations:
            if o.period.period_id == period_id:
                return o
        return None

    def latest(self) -> Optional[Observation]:
        present = self.present()
        return present[-1] if present else None

    def contiguous_tail(self) -> Tuple[Observation, ...]:
        """The longest run of present observations ending at the LAST
        period on the spine. A gap anywhere inside the run truncates it —
        a movement measured across a hole is not a movement."""
        run = []  # type: List[Observation]
        for obs in reversed(self.observations):
            if obs.is_gap():
                break
            run.append(obs)
        run.reverse()
        return tuple(run)


@dataclass(frozen=True)
class SeriesSet:
    """Every line, over one shared spine. The spine is shared on purpose:
    two lines compared to each other (COGS against revenue, receivables
    against turnover) are then guaranteed to be entity-matched period by
    period rather than index by index."""

    periods: Tuple[PeriodRef, ...]
    currency: str
    series: Dict[str, AccountTimeSeries]

    def period_count(self) -> int:
        return len(self.periods)

    def latest_period(self) -> Optional[PeriodRef]:
        return self.periods[-1] if self.periods else None

    def get(self, key: str) -> Optional[AccountTimeSeries]:
        return self.series.get(key)

    def require(self, key: str) -> AccountTimeSeries:
        if key not in self.series:
            raise KeyError("no series for canonical line %r" % key)
        return self.series[key]

    def subject_keys(self) -> Tuple[str, ...]:
        return tuple(k for k in sorted(self.series)
                     if self.series[k].spec.role == ROLE_SUBJECT)

    def years_covered(self) -> int:
        years = set()
        for p in self.periods:
            if p.year is not None:
                years.add(int(p.year))
        return len(years)

    def provenance_for(self, line_refs: Tuple[str, ...] = (),
                       source: str = "assembled_canonical_v1"
                       ) -> F.Provenance:
        """Provenance naming the LATEST period and the ledger lines the
        finding actually cites. The contract demotes a finding whose
        evidence names neither a snapshot nor a line, so a measurement
        that carries no account codes cannot silently pass."""
        latest = self.latest_period()
        return F.Provenance(
            period_id=(latest.period_id if latest else ""),
            snapshot_id=(latest.snapshot_id if latest else None),
            line_refs=tuple(line_refs),
            source=source,
        )


# ── The window types — where cold start is enforced ──────────────────────


@dataclass(frozen=True)
class History:
    """A CONTIGUOUS run of present observations, long enough for the
    analysis that asked for it.

    This is the only way into the arithmetic. `of()` refuses rather than
    returning a short window, so an analysis cannot quietly do its best
    with one point: the refusal is caught one level up and becomes an
    `AnalysisRequirement` row that says what was missing.
    """

    series: AccountTimeSeries
    points: Tuple[Observation, ...]

    @classmethod
    def of(cls, series: AccountTimeSeries, analysis_id: str,
           min_points: int = 2) -> "History":
        if min_points < 2:
            raise ValueError(
                "a multi-period window of fewer than 2 points is a single "
                "period wearing a series' clothes (%s asked for %d)"
                % (analysis_id, min_points))
        run = series.contiguous_tail()
        if len(run) < min_points:
            raise NeedsHistoryError(
                analysis_id, min_points, len(run),
                "%s has %d contiguous period(s) at the end of the spine and "
                "%d gap(s)" % (series.key, len(run), len(series.gaps())))
        return cls(series=series, points=run)

    # -- readings ---------------------------------------------------

    def values(self) -> Tuple[float, ...]:
        return tuple(float(o.value) for o in self.points)  # type: ignore[arg-type]

    def periods(self) -> Tuple[PeriodRef, ...]:
        return tuple(o.period for o in self.points)

    def latest(self) -> float:
        return float(self.points[-1].value)  # type: ignore[arg-type]

    def previous(self) -> float:
        return float(self.points[-2].value)  # type: ignore[arg-type]

    def first(self) -> float:
        return float(self.points[0].value)  # type: ignore[arg-type]

    def latest_period(self) -> PeriodRef:
        return self.points[-1].period

    def previous_period(self) -> PeriodRef:
        return self.points[-2].period

    def first_period(self) -> PeriodRef:
        return self.points[0].period

    def movements(self) -> Tuple[float, ...]:
        """Period-over-period differences across the contiguous run. A
        run of n points yields n-1 movements, and every one of them
        spans two ADJACENT periods."""
        vals = self.values()
        return tuple(vals[i] - vals[i - 1] for i in range(1, len(vals)))

    def __len__(self) -> int:
        return len(self.points)


@dataclass(frozen=True)
class PairedHistory:
    """Two lines over the SAME contiguous periods. Built by intersecting
    the two spines, so a decoupling claim ("cost rose while revenue
    fell") can never compare period t of one line with period t-1 of the
    other."""

    left: AccountTimeSeries
    right: AccountTimeSeries
    points: Tuple[Tuple[PeriodRef, float, float], ...]

    @classmethod
    def of(cls, left: AccountTimeSeries, right: AccountTimeSeries,
           analysis_id: str, min_points: int = 2) -> "PairedHistory":
        if left.currency != right.currency:
            raise SeriesCurrencyError(
                "%s reports in %s and %s in %s; a quotient across them is an "
                "FX artefact, not a ratio"
                % (left.key, left.currency, right.key, right.currency))
        rows = []  # type: List[Tuple[PeriodRef, float, float]]
        right_by_id = dict((o.period.period_id, o) for o in right.observations)
        for obs in left.observations:
            other = right_by_id.get(obs.period.period_id)
            if obs.is_gap() or other is None or other.is_gap():
                rows = []          # a hole breaks the run, it does not bridge it
                continue
            rows.append((obs.period, float(obs.value), float(other.value)))
        if len(rows) < min_points:
            raise NeedsHistoryError(
                analysis_id, min_points, len(rows),
                "%s and %s share %d contiguous period(s)"
                % (left.key, right.key, len(rows)))
        return cls(left=left, right=right, points=tuple(rows))

    def latest(self) -> Tuple[PeriodRef, float, float]:
        return self.points[-1]

    def previous(self) -> Tuple[PeriodRef, float, float]:
        return self.points[-2]

    def __len__(self) -> int:
        return len(self.points)


@dataclass(frozen=True)
class YearOverYear:
    """The latest period and its same-month counterpart a year earlier.

    Matched on (year, month) — never on "twelve rows back", which is the
    same period only when the spine is monthly AND complete AND has no
    gaps. When the spine does not carry year/month, this refuses, and the
    seasonal analysis says so instead of comparing December to March.
    """

    series: AccountTimeSeries
    current: Observation
    prior_year: Observation

    @classmethod
    def of(cls, series: AccountTimeSeries, analysis_id: str) -> "YearOverYear":
        latest = series.latest()
        if latest is None:
            raise NeedsHistoryError(analysis_id, 2, 0,
                                    "%s has no present observation" % series.key)
        key = latest.period.same_period_key()
        if key is None:
            raise NeedsHistoryError(
                analysis_id, 2, series.n_present(),
                "the spine does not carry a calendar year and month, so no "
                "same-period-last-year counterpart can be identified")
        want = (key[0] - 1, key[1])
        for obs in series.observations:
            if obs.is_gap():
                continue
            if obs.period.same_period_key() == want:
                return cls(series=series, current=latest, prior_year=obs)
        raise NeedsHistoryError(
            analysis_id, 2, series.n_present(),
            "no observation for %d-%02d, the same period one year before %s"
            % (want[0], want[1], latest.period.label))


# ── Cold start, as a typed result ────────────────────────────────────────


@dataclass(frozen=True)
class AnalysisRequirement:
    """One analysis's history bill. Satisfied or not, it is reported —
    the unsatisfied ones are the whole point of the cold-start result."""

    analysis_id: str
    label: str
    needs_periods: int
    needs_years: int
    have_periods: int
    have_years: int
    satisfied: bool
    reason: str = ""

    def to_payload(self) -> Dict[str, Any]:
        return {
            "analysis_id": self.analysis_id, "label": self.label,
            "needs_periods": self.needs_periods, "needs_years": self.needs_years,
            "have_periods": self.have_periods, "have_years": self.have_years,
            "satisfied": self.satisfied, "reason": self.reason,
        }


@dataclass(frozen=True)
class NeedsHistory:
    """The cold-start answer. Not an error and not an empty list — a
    statement of which analyses are waiting on what."""

    period_count: int
    year_count: int
    period_labels: Tuple[str, ...]
    requirements: Tuple[AnalysisRequirement, ...]

    def blocked(self) -> Tuple[AnalysisRequirement, ...]:
        return tuple(r for r in self.requirements if not r.satisfied)

    def statement(self) -> str:
        """The cold-start sentence, naming every waiting analysis and its
        bill. Deliberately explicit: "not enough data" tells a reader
        nothing they can act on, while "the cycle analysis needs a third
        period" tells them exactly which upload to go and find."""
        blocked = self.blocked()
        have = ", ".join(self.period_labels) if self.period_labels else "none"
        opening = ("This upload carries %s (%s) across %s."
                   % (_plural(self.period_count, "period"), have,
                      _plural(self.year_count, "calendar year")))
        if not blocked:
            return ("%s Every multi-period analysis has the history it needs."
                    % opening)
        bills = []  # type: List[str]
        for req in sorted(blocked, key=lambda r: (r.needs_periods, r.label)):
            bill = "%s (needs %s" % (req.label,
                                     _plural(req.needs_periods, "comparable period"))
            if req.needs_years:
                bill += ", %s" % _plural(req.needs_years, "calendar year")
            bills.append(bill + ")")
        return ("%s %d of %d multi-period analyses cannot run yet: %s. No "
                "trend, no median and no year-over-year figure was computed "
                "from this period."
                % (opening, len(blocked), len(self.requirements),
                   "; ".join(bills)))

    def to_payload(self) -> Dict[str, Any]:
        return {
            "period_count": self.period_count,
            "year_count": self.year_count,
            "period_labels": list(self.period_labels),
            "statement": self.statement(),
            "requirements": [r.to_payload() for r in self.requirements],
            "blocked": [r.analysis_id for r in self.blocked()],
        }


# ── The default Romanian line table ──────────────────────────────────────
#
# Account codes are RAS (OMFP 1802) and mirror the mapping documented in
# `country_packs/ro_romania/chart_of_accounts.py`. They are here because
# the Finding contract demands a ledger code on the page — a sentence
# with no code is a sentence about no particular book — and because a
# jurisdiction swap replaces this table wholesale rather than editing it.
#
# `money_fact` is filled ONLY where `_ratio_units` declares the name as
# money. The blanks are deliberate and load-bearing: inventory, payables
# and COGS have no declared money name, so their findings speak in days
# and shares. Inventing a name here would print a currency word that the
# display path never converts.


def _plural(count: int, noun: str) -> str:
    """"1 period" / "3 periods". Small, and it earns its place: the
    cold-start statement is the ONLY output a single-period upload gets,
    so "2 analysis/analyses" is the whole impression it leaves."""
    n = int(count)
    return "%d %s%s" % (n, noun, "" if n == 1 else "s")


def _acct(code: str, name: str, statement: Optional[str] = None,
          bucket: Optional[str] = None) -> F.Account:
    return F.Account(code=code, name=name, statement=statement, bucket=bucket)


DEFAULT_LINES = (
    # ── P&L ──────────────────────────────────────────────────────────
    LineSpec(
        key="revenue", label="Revenue",
        accounts=(_acct("70", "Cifra de afaceri", "PL", "revenue"),),
        names=("revenue",), statement="PL",
        adverse_direction=DIRECTION_DOWN, money_fact="revenue",
        basis=BASIS_REVENUE, kind=KIND_FLOW, side=SIDE_PL),
    LineSpec(
        key="cogs", label="Cost of goods sold",
        accounts=(_acct("60", "Cheltuieli privind stocurile", "PL", "cogs"),),
        names=("cogs", "cost_of_goods_sold"), statement="PL",
        adverse_direction=DIRECTION_UP, money_fact=None,
        basis=BASIS_REVENUE, kind=KIND_FLOW, side=SIDE_PL),
    LineSpec(
        key="opex_third_party", label="Third-party operating expense",
        accounts=(_acct("62", "Cheltuieli cu servicii executate de terti",
                        "PL", "opex_third_party"),),
        names=("opex_third_party",), statement="PL",
        adverse_direction=DIRECTION_UP, money_fact=None,
        basis=BASIS_REVENUE, kind=KIND_FLOW, side=SIDE_PL),
    LineSpec(
        key="depreciation", label="Depreciation and amortisation",
        accounts=(_acct("681", "Cheltuieli de exploatare privind amortizarile",
                        "PL", "depreciation"),),
        names=("depreciation",), statement="PL",
        adverse_direction=DIRECTION_NONE, money_fact=None,
        basis=BASIS_REVENUE, kind=KIND_FLOW, side=SIDE_PL),
    LineSpec(
        key="interest_expense", label="Interest expense",
        accounts=(_acct("666", "Cheltuieli privind dobanzile", "PL",
                        "interest_expense"),),
        names=("interest_expense",), statement="PL",
        adverse_direction=DIRECTION_UP, money_fact=None,
        basis=BASIS_REVENUE, kind=KIND_FLOW, side=SIDE_PL),
    LineSpec(
        key="ebitda", label="EBITDA (statutory)",
        accounts=(), names=("ebitda_statutory", "ebitda"), role=ROLE_BASIS,
        statement="PL", adverse_direction=DIRECTION_DOWN,
        money_fact="ebitda_statutory", basis=BASIS_REVENUE, kind=KIND_FLOW, side=SIDE_PL),
    LineSpec(
        key="net_income", label="Net income (statutory)",
        accounts=(_acct("121", "Profit sau pierdere", "PL", "net_income"),),
        names=("net_income_statutory", "net_income_operational"), statement="PL",
        adverse_direction=DIRECTION_DOWN, money_fact="net_income",
        basis=BASIS_REVENUE, kind=KIND_FLOW, side=SIDE_PL),

    # ── Balance sheet ────────────────────────────────────────────────
    LineSpec(
        key="ar_net", label="Trade receivables (net)",
        accounts=(_acct("411", "Clienti", "BS", "ar_net"),),
        names=("ar_net", "accounts_receivable"), statement="BS",
        adverse_direction=DIRECTION_UP, money_fact="trade_rec",
        basis=BASIS_ASSETS, kind=KIND_STOCK, side=SIDE_ASSET),
    LineSpec(
        key="ar_intercompany", label="Related-party receivable",
        accounts=(_acct("461", "Debitori diversi", "BS", "ar_intercompany"),),
        names=("ar_intercompany", "intercompany_loans"), statement="BS",
        adverse_direction=DIRECTION_UP, money_fact="intercompany_loans",
        basis=BASIS_ASSETS, kind=KIND_STOCK, side=SIDE_ASSET),
    LineSpec(
        key="ar_provisions", label="Receivables allowance",
        accounts=(_acct("491", "Ajustari pentru deprecierea creantelor", "BS",
                        "ar_provisions"),),
        names=("ar_provisions",), statement="BS",
        adverse_direction=DIRECTION_UP, money_fact="rec_provisions",
        basis=BASIS_ASSETS, kind=KIND_STOCK, side=SIDE_CONTRA_ASSET),
    LineSpec(
        key="inventory", label="Inventory",
        accounts=(_acct("3", "Stocuri", "BS", "inventory"),),
        names=("inventory",), statement="BS",
        adverse_direction=DIRECTION_UP, money_fact=None,
        basis=BASIS_ASSETS, kind=KIND_STOCK, side=SIDE_ASSET),
    LineSpec(
        key="accounts_payable", label="Trade payables",
        accounts=(_acct("401", "Furnizori", "BS", "accounts_payable"),),
        names=("accounts_payable", "ap"), statement="BS",
        adverse_direction=DIRECTION_UP, money_fact=None,
        basis=BASIS_ASSETS, kind=KIND_STOCK, side=SIDE_LIABILITY),
    LineSpec(
        key="cash", label="Cash and equivalents",
        accounts=(_acct("512", "Conturi la banci", "BS", "cash"),),
        names=("cash",), statement="BS",
        adverse_direction=DIRECTION_DOWN, money_fact="cash",
        basis=BASIS_ASSETS, kind=KIND_STOCK, side=SIDE_ASSET, dormancy=False),
    LineSpec(
        key="total_debt", label="Interest-bearing debt",
        accounts=(_acct("162", "Credite bancare pe termen lung", "BS", "lt_debt"),
                  _acct("519", "Credite bancare pe termen scurt", "BS", "st_debt")),
        names=("total_debt",), statement="BS",
        adverse_direction=DIRECTION_UP, money_fact="bank_debt_total",
        basis=BASIS_ASSETS, kind=KIND_STOCK, side=SIDE_LIABILITY),
    LineSpec(
        key="ppe_under_construction", label="Construction in progress",
        accounts=(_acct("231", "Imobilizari corporale in curs", "BS",
                        "ppe_under_construction"),),
        names=("ppe_under_construction",), statement="BS",
        adverse_direction=DIRECTION_NONE, money_fact=None,
        basis=BASIS_ASSETS, kind=KIND_STOCK, side=SIDE_ASSET),
    LineSpec(
        key="investments", label="Participations and long-term investments",
        accounts=(_acct("261", "Actiuni detinute la entitati afiliate", "BS",
                        "investments"),),
        names=("investments",), statement="BS",
        adverse_direction=DIRECTION_NONE, money_fact=None,
        basis=BASIS_ASSETS, kind=KIND_STOCK, side=SIDE_ASSET, dormancy=False),
    LineSpec(
        key="ap_dividends", label="Declared dividends payable",
        accounts=(_acct("457", "Dividende de plata", "BS", "ap_dividends"),),
        names=("ap_dividends",), statement="BS",
        adverse_direction=DIRECTION_UP, money_fact="dividends_payable",
        basis=BASIS_ASSETS, kind=KIND_STOCK, side=SIDE_LIABILITY),
    LineSpec(
        key="revaluation_reserves", label="Revaluation reserve",
        accounts=(_acct("105", "Rezerve din reevaluare", "BS",
                        "revaluation_reserves"),),
        names=("revaluation_reserves",), statement="BS",
        adverse_direction=DIRECTION_NONE, money_fact="revaluation_reserves",
        basis=BASIS_EQUITY, kind=KIND_STOCK, side=SIDE_EQUITY),

    # ── Bases (denominators only — no ledger code, never a subject) ───
    LineSpec(
        key="total_assets", label="Total assets",
        accounts=(), names=("total_assets",), role=ROLE_BASIS, statement="BS",
        money_fact="total_assets", basis=BASIS_ASSETS, kind=KIND_STOCK, side=SIDE_ASSET),
    LineSpec(
        key="total_equity", label="Total equity",
        accounts=(), names=("total_equity",), role=ROLE_BASIS, statement="BS",
        money_fact="total_equity", basis=BASIS_EQUITY, kind=KIND_STOCK, side=SIDE_EQUITY),
    LineSpec(
        key="total_liabilities", label="Total liabilities",
        accounts=(), names=("total_liabilities",), role=ROLE_BASIS,
        statement="BS", money_fact="total_liabilities", basis=BASIS_ASSETS,
        kind=KIND_STOCK, side=SIDE_LIABILITY),
    LineSpec(
        key="total_current_assets", label="Current assets",
        accounts=(), names=("total_current_assets",), role=ROLE_BASIS,
        statement="BS", money_fact=None, basis=BASIS_ASSETS, kind=KIND_STOCK, side=SIDE_ASSET),
    LineSpec(
        key="total_current_liabilities", label="Current liabilities",
        accounts=(), names=("total_current_liabilities",), role=ROLE_BASIS,
        statement="BS", money_fact="cur_liab", basis=BASIS_ASSETS,
        kind=KIND_STOCK, side=SIDE_LIABILITY),
)

LINES_BY_KEY = dict((spec.key, spec) for spec in DEFAULT_LINES)


# ── The builder ──────────────────────────────────────────────────────────


def _read_line(statements: Dict[str, Any], spec: LineSpec
               ) -> Tuple[Optional[float], str]:
    """One line, one period. Returns (value, source) with value None when
    the period's views simply do not carry it — a GAP, which is not the
    same claim as a zero balance and is never converted into one."""
    for view in spec.views:
        block = statements.get(view)
        if not isinstance(block, dict):
            continue
        for name in spec.names:
            if name not in block:
                continue
            value = block[name]
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                continue
            return float(value), "%s.%s" % (view, name)
    return None, ""


def build_series_set(periods: Sequence[PeriodRef],
                     statements_by_period: Dict[str, Dict[str, Any]],
                     lines: Sequence[LineSpec] = DEFAULT_LINES,
                     currency: Optional[str] = None) -> SeriesSet:
    """Assemble the spine.

    `statements_by_period` maps `period_id` -> `assembled["statements"]`.
    Periods are sorted by `ordinal`; a period with no statements yields a
    GAP on every line rather than being dropped, because "we have no data
    for March" and "March is not part of this company's history" are
    different claims and only the first one is true.

    Currency is taken from the periods themselves and must agree. A
    disagreement raises `SeriesCurrencyError` — silently comparing a RON
    period with a EUR one produces movements that are pure FX.
    """
    ordered = tuple(sorted(periods, key=lambda p: (p.ordinal, p.period_id)))
    currencies = []  # type: List[str]
    for p in ordered:
        stmts = statements_by_period.get(p.period_id) or {}
        cur = str(stmts.get("currency") or "").upper()
        if cur:
            currencies.append(cur)
    resolved = (currency or "").upper() or (currencies[0] if currencies else "RON")
    for cur in currencies:
        if cur != resolved:
            raise SeriesCurrencyError(
                "the spine mixes %s and %s; movements across a currency change "
                "are FX artefacts, not movements" % (resolved, cur))

    series = {}  # type: Dict[str, AccountTimeSeries]
    for spec in lines:
        obs = []  # type: List[Observation]
        for p in ordered:
            stmts = statements_by_period.get(p.period_id) or {}
            value, source = _read_line(stmts, spec)
            obs.append(Observation(period=p, value=value, source=source))
        series[spec.key] = AccountTimeSeries(
            spec=spec, currency=resolved, observations=tuple(obs))
    return SeriesSet(periods=ordered, currency=resolved, series=series)


__all__ = [
    "AccountTimeSeries", "AnalysisRequirement", "History", "LineSpec",
    "NeedsHistory", "NeedsHistoryError", "Observation", "PairedHistory",
    "PeriodRef", "SeriesCurrencyError", "SeriesSet", "YearOverYear",
    "build_series_set", "DEFAULT_LINES", "LINES_BY_KEY", "VIEW_ORDER",
    "DIRECTION_UP", "DIRECTION_DOWN", "DIRECTION_NONE",
    "ROLE_SUBJECT", "ROLE_BASIS", "KIND_STOCK", "KIND_FLOW",
    "SIDE_ASSET", "SIDE_CONTRA_ASSET", "SIDE_LIABILITY", "SIDE_EQUITY",
    "SIDE_PL", "DAYS_IN_YEAR",
    "BASIS_ASSETS", "BASIS_REVENUE", "BASIS_EQUITY",
]
