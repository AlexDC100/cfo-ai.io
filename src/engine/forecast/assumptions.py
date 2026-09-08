"""EVERY DRIVER, AND WHERE IT CAME FROM.

THE PROBLEM THIS FILE EXISTS TO SOLVE
=====================================
Every number the engine has produced so far is a FACT anchored to a
source cell. A forecast is an ASSUMPTION. The engine's credibility
depends on the reader never confusing the two — so no driver in this
package is a bare number. Each is an :class:`Assumption` carrying:

  ``source``  where it came from, from a CLOSED vocabulary:
              ``derived``        measured from this book's own history
              ``caller``         supplied by whoever asked for the plan
              ``engine_default`` neither — the model's stated default
              ``unavailable``    not derivable and not supplied. The
                                 driver carries NO value — never 0 —
                                 and the model either HOLDS the line at
                                 its opening balance or REFUSES the plan

  ``basis``   a sentence naming the figures the value was computed from,
              so a reader can re-derive it by hand

``unavailable`` is the ABSENT != ZERO rule applied to drivers, and it
takes two shapes because there are two kinds of line:

  · the driver governs a BALANCE. A book whose COGS is zero cannot
    yield a DIO; the honest answer is not "DIO = 0 days", which would
    liquidate the entire inventory in the first projected period and
    print the resulting cash as a fact. It is "this book cannot tell
    us, so inventory is HELD at its opening balance until someone
    supplies a DIO" — and the plan says so on its face.

  · the driver governs a P&L FLOW, or a programme the model creates
    itself. There is no balance to hold. A rate the book could not
    measure cannot be silently replaced by 0%, which is an invented
    rate and, for every cost the model charges, the most favourable one
    available — so the plan is REFUSED, naming the driver and what
    would have to be supplied to project it. ``AssumptionSet.micros``
    enforces this at the one seam where the difference is spendable: an
    unavailable rate raises rather than resolving to zero.

A rate that reads 0 because nothing could be measured and a rate that
reads 0 because the book says 0 are different facts, and so are an
absent LINE and an unmeasurable RATE. A book that names no other
operating income has nothing to project a share of, and carrying none
forward is the absence preserved, not an invention — that is an
``engine_default``, and it does not spend the refusal word.

THAT LICENCE ENDS WHERE THE PLAN BEGINS. A default is a statement, and
a statement can be falsified by the plan it is handed to. Ask of every
0 stored here: **can any lever a caller has — an override, or the debt
schedule — make the sentence this branch prints false?**

  · ``other_operating_income_pct_of_revenue`` says the LINE is absent
    from this company's income statement, and ``capex_pct_of_revenue``
    says the book names no depreciation charge to replace. No lever
    gives the BOOK either one, and the base both divide by (revenue) is
    already there. The sentences survive every plan; the 0 stands.

  · ``depreciation_rate`` and ``interest_rate_debt`` said the BALANCE
    each prices was nil. The capital programme buys fixed assets and a
    ``DebtSchedule`` draws debt, so both sentences are false one period
    into a plan that does either, and the 0 is then charged on a real
    balance — undepreciated assets, and interest-free debt. Those two
    are ``unavailable`` carrying nothing, and ``project`` refuses at the
    period where the balance actually appears, exactly as the funding
    line already did for itself.

The difference is not "flow versus balance" and not the source word: it
is whether the plan can create what the rate is spent on.

``None`` is what holds that line, and 0 is what breaks it, so a day
count is stored in MICRO-DAYS (``money.MICRO_DAY``) and never as a whole
day. Rounding a derivation to the nearest day and TRUNCATING a caller's
override are two different rules for one quantity: the first makes a
driver's printed derivation disagree with the value the model spends,
and the second turns ``dso_days=0.5`` into ``0`` — converting the
refusal above into exactly the liquidation it exists to prevent.
``_coerce`` refuses a positive day count that would round to zero, so
zero is only ever something a caller asked for in those words.

An ``unavailable`` RATE is not the number zero either. Where a rate
prices a charge the model creates itself — the funding line — there is
no balance to hold, so ``project.py`` REFUSES rather than charging 0%,
which would be an invented rate and the most favourable one.

WHAT IS DELIBERATELY *NOT* DERIVED
==================================
  · ``revenue_growth`` — one trial balance has no prior period, so
    growth is not a measurable property of this book. Default 0.0%.
    A single-period book that produced a growth rate would be an
    invention dressed as a measurement.
  · ``dividend_payout_pct`` — ``assembled_cf.dividends_paid`` LOOKS
    derivable and is not: on a book with no prior period the cash-flow
    assembly sets it to half of net profit as an approximation (agras:
    dividends_paid −3,766,838.01 == −7,533,676.02 ÷ 2, exactly). Reading
    it back would launder the engine's own guess into the reader's
    history. Default 0.0%.
  · the debt repayment schedule — a trial balance discloses balances,
    not maturities. Debt is held at its opening balance until a
    :class:`DebtSchedule` is supplied.

Python 3.9 — no ``match``, no ``X | Y``.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Sequence, Tuple

from .errors import AssumptionError
from .money import (MICRO, MICRO_DAY, cents_from, days_fmt, days_to_float,
                    micro_days_from, micros_from, mul_div, rate_to_float,
                    to_float)
from .timeline import GRANULARITIES

__all__ = [
    "Assumption",
    "AssumptionSet",
    "DebtMove",
    "DebtSchedule",
    "SOURCES",
    "derive_assumptions",
]

#: The closed source vocabulary. Rendered beside every driver.
SOURCES = ("derived", "caller", "engine_default", "unavailable")

_RATIO = "ratio"
_DAYS = "days"
_MONEY = "money"
_COUNT = "count"
_TEXT = "text"

_UNITS = (_RATIO, _DAYS, _MONEY, _COUNT, _TEXT)


class Assumption(object):
    """One driver: its exact integer value, its unit, and its pedigree."""

    __slots__ = ("key", "unit", "exact", "text", "source", "basis",
                 "derived_from")

    def __init__(self, key: str, unit: str, exact: Optional[int],
                 source: str, basis: str, text: Optional[str] = None,
                 derived_from: Sequence[str] = ()) -> None:
        if unit not in _UNITS:
            raise AssumptionError(key, "unknown unit %r" % (unit,))
        if source not in SOURCES:
            raise AssumptionError(key, "unknown source %r" % (source,))
        self.key = key
        self.unit = unit
        self.exact = exact
        self.text = text
        self.source = source
        self.basis = basis
        #: The served field paths this driver was measured from, so a
        #: reader can walk from the driver back to the actual figure.
        #: Empty when nothing was measured (a default or a refusal).
        self.derived_from = tuple(derived_from)

    @property
    def available(self) -> bool:
        return self.exact is not None or self.text is not None

    def value(self) -> Any:
        """The human-facing value. Never fed back into arithmetic."""
        if self.unit == _TEXT:
            return self.text
        if self.exact is None:
            return None
        if self.unit == _RATIO:
            return rate_to_float(self.exact)
        if self.unit == _MONEY:
            return to_float(self.exact)
        if self.unit == _DAYS:
            return days_to_float(self.exact)
        return self.exact

    def as_dict(self) -> Dict[str, Any]:
        return {
            "key": self.key,
            "unit": self.unit,
            "value": self.value(),
            "source": self.source,
            "basis": self.basis,
            "derived_from": list(self.derived_from),
        }

    #: This package's unit vocabulary -> the fp1 serving contract's
    #: (``engine.forecast_serving.contract.UNITS``). Declared here rather
    #: than imported so the model package never depends on the serving
    #: package; the mapping is asserted against the real contract by
    #: tests/engine/test_forecast_model.py.
    FP1_UNITS = {
        _RATIO: "ratio",
        _DAYS: "days",
        _MONEY: "money_minor",
        _COUNT: "count",
        # A stated rule with no quantity. `year_one_granularity` is one:
        # it is a shape choice a reader of the projection genuinely needs
        # ("year one is monthly"), and it used to be dropped from the
        # served payload entirely because the contract knew only numbers.
        # It now travels as what it is instead of not travelling.
        _TEXT: "convention",
    }

    def as_fp1(self, period_labels: Sequence[str]) -> Optional[Dict[str, Any]]:
        """This driver in the shape ``engine.forecast_serving`` serves.

        None for a driver with no fp1 unit — ``year_one_granularity`` is
        a shape choice, not a quantity, and a contract that only knows
        numbers should not be handed a word dressed as one.
        """
        unit = self.FP1_UNITS.get(self.unit)
        if unit is None:
            return None
        if self.unit == _TEXT:
            # ABSENT, not the word. A `values` map is a schedule of
            # NUMBERS; putting a string in one would hand every consumer
            # a quantity it cannot compute with, and `readProjection`
            # would render it beside figures as though it were one. The
            # word itself belongs in the basis, which is what renders.
            return {
                "id": self.key,
                "label": self.key.replace("_", " "),
                "unit": unit,
                "values": dict((label, None) for label in period_labels),
                "basis": ("%s: %s [%s]"
                          % (self.basis or self.key.replace("_", " "),
                             self.text, self.source)
                          if self.text else
                          "%s [%s]" % (self.basis, self.source)),
                "derived_from": list(self.derived_from),
            }
        value = self.exact if self.unit == _MONEY else self.value()
        return {
            "id": self.key,
            "label": self.key.replace("_", " "),
            "unit": unit,
            "values": dict((label, value) for label in period_labels),
            "basis": "%s [%s]" % (self.basis, self.source),
            "derived_from": list(self.derived_from),
        }

    def __repr__(self):  # pragma: no cover - debugging aid
        return "Assumption(%s=%r, %s)" % (self.key, self.value(), self.source)


class DebtMove(object):
    """One scheduled debt movement, in cents, at one period index."""

    __slots__ = ("period_index", "st_draw", "st_repay", "lt_draw", "lt_repay")

    def __init__(self, period_index: int, st_draw: int = 0, st_repay: int = 0,
                 lt_draw: int = 0, lt_repay: int = 0) -> None:
        self.period_index = int(period_index)
        self.st_draw = int(st_draw)
        self.st_repay = int(st_repay)
        self.lt_draw = int(lt_draw)
        self.lt_repay = int(lt_repay)

    def as_dict(self) -> Dict[str, Any]:
        return {
            "period_index": self.period_index,
            "st_draw": to_float(self.st_draw),
            "st_repay": to_float(self.st_repay),
            "lt_draw": to_float(self.lt_draw),
            "lt_repay": to_float(self.lt_repay),
        }


class DebtSchedule(object):
    """The drawdown / repayment ladder, indexed by period.

    Empty by default and that is the honest default: a trial balance
    carries balances, not maturities, so the model holds debt flat until
    a schedule is supplied rather than inventing an amortisation profile.
    """

    __slots__ = ("_by_index",)

    def __init__(self, moves: Sequence[DebtMove] = ()) -> None:
        by_index = {}  # type: Dict[int, DebtMove]
        for move in moves:
            if move.period_index in by_index:
                raise AssumptionError(
                    "debt_schedule",
                    "two moves given for period index %d — merge them"
                    % (move.period_index,))
            for name in ("st_draw", "st_repay", "lt_draw", "lt_repay"):
                if getattr(move, name) < 0:
                    raise AssumptionError(
                        "debt_schedule",
                        "%s at period %d is negative (%d); draws and "
                        "repayments are both stated as positive amounts"
                        % (name, move.period_index, getattr(move, name)))
            by_index[move.period_index] = move
        self._by_index = by_index

    def at(self, period_index: int) -> DebtMove:
        return self._by_index.get(period_index) or DebtMove(period_index)

    def is_empty(self) -> bool:
        return not self._by_index

    def as_list(self) -> List[Dict[str, Any]]:
        return [self._by_index[i].as_dict() for i in sorted(self._by_index)]


#: key -> (unit, engine default as a raw value, the default's basis).
#: A default is a STATEMENT, not a silence: each one says what it assumes
#: and why the book could not answer.
_DEFAULTS = (
    ("revenue_growth", _RATIO, 0.0,
     "one trial balance has no prior period, so growth is not measurable "
     "from this book; held at 0.0% until supplied"),
    ("cogs_pct_of_revenue", _RATIO, 0.0, ""),
    ("opex_pct_of_revenue", _RATIO, 0.0, ""),
    ("other_operating_income_pct_of_revenue", _RATIO, 0.0,
     "this book names no other operating income, so none is projected"),
    ("dso_days", _DAYS, None, ""),
    ("dio_days", _DAYS, None, ""),
    ("dpo_days", _DAYS, None, ""),
    ("depreciation_rate", _RATIO, 0.0, ""),
    ("capex_pct_of_revenue", _RATIO, 0.0, ""),
    ("intangible_additions_pct_of_revenue", _RATIO, 0.0,
     "no capitalised-intangible programme is observable in a trial "
     "balance; held at 0.0% of revenue until supplied"),
    ("tax_rate", _RATIO, 0.16,
     "the book shows no positive pre-tax result to imply an effective "
     "rate; the Romanian statutory profit-tax rate is used instead"),
    ("interest_rate_debt", _RATIO, 0.0, ""),
    ("revolver_rate", _RATIO, 0.0, ""),
    ("interest_income_rate", _RATIO, None,
     "this book names no interest income, and nothing in it implies a "
     "rate on cash; the projection earns none unless one is supplied"),
    ("interest_income_annual", _MONEY, 0.0,
     "this book names no interest income, so none is carried forward"),
    ("other_financial_income_annual", _MONEY, 0.0,
     "this book names no financial income, so none is carried forward"),
    ("other_financial_expense_annual", _MONEY, 0.0,
     "this book names no financial expense, so none is carried forward"),
    ("dividend_payout_pct", _RATIO, 0.0,
     "a single trial balance carries no observable distribution policy "
     "(the cash-flow assembly's dividend line is itself an "
     "approximation, not a fact); held at 0.0% until supplied"),
    ("min_cash", _MONEY, 0.0,
     "the cash floor below which the funding line draws; 0 means the "
     "plan may run the account to nil but never below it"),
    ("days_basis", _COUNT, 365,
     "days in a year for every rate-to-period conversion"),
    ("horizon_years", _COUNT, 5, "length of the projection"),
)

_RATIO_KEYS = tuple(k for k, u, _d, _b in _DEFAULTS if u == _RATIO)
_DAYS_KEYS = tuple(k for k, u, _d, _b in _DEFAULTS if u == _DAYS)
_MONEY_KEYS = tuple(k for k, u, _d, _b in _DEFAULTS if u == _MONEY)
_COUNT_KEYS = tuple(k for k, u, _d, _b in _DEFAULTS if u == _COUNT)
KEYS = tuple(k for k, _u, _d, _b in _DEFAULTS) + ("year_one_granularity",)


class AssumptionSet(object):
    """Every driver of one projection, each with its pedigree."""

    __slots__ = ("_by_key", "debt_schedule")

    def __init__(self, assumptions: Sequence[Assumption],
                 debt_schedule: Optional[DebtSchedule] = None) -> None:
        by_key = {}  # type: Dict[str, Assumption]
        for item in assumptions:
            by_key[item.key] = item
        missing = sorted(set(KEYS) - set(by_key))
        if missing:
            raise AssumptionError("assumption_set",
                                  "missing driver(s): %s" % ", ".join(missing))
        self._by_key = by_key
        self.debt_schedule = debt_schedule or DebtSchedule()

    def __getitem__(self, key: str) -> Assumption:
        if key not in self._by_key:
            raise AssumptionError(key, "no such driver")
        return self._by_key[key]

    def get(self, key: str) -> Assumption:
        return self[key]

    def micros(self, key: str) -> int:
        item = self[key]
        if item.unit != _RATIO:
            raise AssumptionError(key, "is a %s, not a ratio" % (item.unit,))
        if item.exact is None:
            # ABSENT != ZERO, at the one seam where the difference is
            # spendable. Handing back 0 here is how an ``unavailable``
            # rate — a REFUSAL — became a 0% rate on the numeric path,
            # and 0% is the most favourable rate available for every
            # cost the model charges. A caller that means to handle the
            # refusal itself asks for ``micros_or_none`` and says so.
            raise AssumptionError(
                key,
                "is unavailable, so there is no rate to spend: %s"
                % (item.basis,))
        return item.exact

    def micros_or_none(self, key: str) -> Optional[int]:
        """The rate in micros, or None when the book could not measure it.

        For the call sites that handle the refusal themselves — a rate on
        a balance that may be nil, where no charge arises and no invention
        is made. Every other site uses :meth:`micros` and is refused.
        """
        item = self[key]
        if item.unit != _RATIO:
            raise AssumptionError(key, "is a %s, not a ratio" % (item.unit,))
        return item.exact

    def cents(self, key: str) -> int:
        item = self[key]
        if item.unit != _MONEY:
            raise AssumptionError(key, "is a %s, not money" % (item.unit,))
        return 0 if item.exact is None else item.exact

    def count(self, key: str) -> int:
        item = self[key]
        #: Day counts are DELIBERATELY not accepted here. They are stored
        #: in micro-days, so a caller reaching for ``count("dso_days")``
        #: would get 26,000,000 and spend it as 26 — the two vocabularies
        #: meeting under one name is the shape of defect this package
        #: names in ``project.py``'s ``checks`` comment.
        if item.unit != _COUNT:
            raise AssumptionError(key, "is a %s, not a count" % (item.unit,))
        if item.exact is None:
            raise AssumptionError(key, "is unavailable")
        return item.exact

    def micro_days_or_none(self, key: str) -> Optional[int]:
        """The day driver in MICRO-DAYS (1 day == 1_000_000), or None when
        the book could not measure it and the line it drives is HELD."""
        item = self[key]
        if item.unit != _DAYS:
            raise AssumptionError(key, "is a %s, not a day count" % (item.unit,))
        return item.exact

    def is_available(self, key: str) -> bool:
        """Whether this driver resolves to a value the model may spend.

        ``unavailable`` is a REFUSAL, not the number zero. A rate that
        reads 0 because nothing could be measured and a rate that reads 0
        because the book says 0 are different facts, and a caller about
        to charge something must be able to tell them apart.

        It asks BOTH halves of that question, because the source word and
        the stored value can disagree and the disagreement is exactly
        where a refusal leaks back onto the numeric path. Reading only
        the word made ``engine_default`` carrying a spendable 0 answer
        True, which disarmed ``project``'s in-loop refusal on precisely
        the books that took such a branch; reading only the value would
        call a refusal that still carried a number available.
        """
        item = self[key]
        return item.source != "unavailable" and item.available

    def text(self, key: str) -> str:
        return str(self[key].text)

    def items(self) -> Tuple[Assumption, ...]:
        return tuple(self._by_key[k] for k in KEYS)

    def as_list(self) -> List[Dict[str, Any]]:
        return [item.as_dict() for item in self.items()]

    def unavailable(self) -> Tuple[str, ...]:
        return tuple(k for k in KEYS if self._by_key[k].source == "unavailable")

    def with_overrides(self, **overrides: Any) -> "AssumptionSet":
        """A copy with caller-supplied drivers replacing derived ones.
        Every replaced driver is re-stamped ``source='caller'`` — an
        override never inherits a derivation's pedigree."""
        return _build(self._by_key, overrides, self.debt_schedule)


def _coerce(key: str, unit: str, value: Any) -> Tuple[Optional[int], Optional[str]]:
    if value is None:
        return None, None
    if unit == _RATIO:
        return micros_from(value), None
    if unit == _MONEY:
        return cents_from(value), None
    if unit == _DAYS:
        exact = micro_days_from(value)
        if exact < 0:
            raise AssumptionError(key, "must not be negative, got %r" % (value,))
        if exact == 0 and _is_positive(value):
            raise AssumptionError(
                key,
                "%r is positive but rounds to zero days at this model's "
                "resolution of one millionth of a day. Zero days is the "
                "instruction to liquidate the whole balance into cash in "
                "the first period, and it must never be something a "
                "rounding rule produces — pass 0 explicitly to mean it."
                % (value,))
        return exact, None
    if unit == _COUNT:
        from .money import _exact_fraction
        frac = _exact_fraction(value, "a count", False)
        exact = int(frac)
        if frac != exact:
            raise AssumptionError(
                key, "is a whole count, and %r would silently truncate to %d"
                     % (value, exact))
        if exact < 0:
            raise AssumptionError(key, "must not be negative, got %r" % (value,))
        return exact, None
    return None, str(value)


def _is_positive(value: Any) -> bool:
    """True when the caller's own quantity is above zero, whatever type
    they wrote it in. Read from the value itself, never from the rounded
    integer — the rounded integer is the thing under suspicion."""
    from .money import _exact_fraction
    try:
        return _exact_fraction(value, "a day count", False) > 0
    except (TypeError, ValueError):  # pragma: no cover - _coerce raised first
        return False


def _build(base: Dict[str, Assumption], overrides: Dict[str, Any],
           debt_schedule: Optional[DebtSchedule]) -> AssumptionSet:
    unknown = sorted(set(overrides) - set(KEYS) - {"debt_schedule"})
    if unknown:
        raise AssumptionError("overrides", "unknown driver(s): %s. Known: %s"
                              % (", ".join(unknown), ", ".join(KEYS)))
    schedule = overrides.get("debt_schedule", debt_schedule)
    out = []  # type: List[Assumption]
    for key in KEYS:
        current = base[key]
        if key in overrides and overrides[key] is not None:
            value = overrides[key]
            if key == "year_one_granularity":
                if value not in GRANULARITIES:
                    raise AssumptionError(
                        key, "must be one of %s, got %r"
                        % (", ".join(GRANULARITIES), value))
                out.append(Assumption(key, _TEXT, None, "caller",
                                      "supplied by the caller", text=str(value)))
                continue
            exact, text = _coerce(key, current.unit, value)
            # THE PEDIGREE RIDES THE VALUE ACROSS THE AUTHORITY BOUNDARY.
            #
            # This stamped every override `basis="supplied by the caller"`
            # with an empty `derived_from`, which discarded the derivation
            # ONE LINE AFTER the crossing handed it over. Measured on the
            # wire before this change: 15 of 21 drivers reached the reader
            # with no derivation at all and 9 said "supplied by the caller"
            # — on a feature whose whole premise is that a projected figure
            # resolves to the assumptions behind it. A driver whose basis
            # reads "supplied by the caller" resolves to nothing.
            #
            # `engine.forecast_drivers.model_overrides()` returns
            # `SuppliedValue`, a real `float` subclass carrying the full
            # pedigree, so this is safe by construction: a plain-float
            # caller has neither attribute and behaves exactly as before.
            # Pinned from the other side by `test_hx7` in
            # `tests/engine/test_forecast_drivers.py`, which was an
            # `xfail(strict=True)` until this landed — the two changes have
            # to be in one commit or that marker turns into an XPASS red.
            out.append(Assumption(
                key, current.unit, exact, "caller",
                getattr(value, "pedigree_basis", None) or "supplied by the caller",
                text=text,
                derived_from=getattr(value, "pedigree_from", ())))
        else:
            out.append(current)
    return AssumptionSet(out, schedule)


def _pct_text(rate_micros: Optional[int]) -> str:
    """A rate rendered for a basis sentence, from the same integer the
    model would have spent. ``None`` — no base at all — says so rather
    than printing a number nobody can check."""
    if rate_micros is None:
        return "no measurable rate (there is no cash balance to divide by)"
    return "%.4f%%" % (rate_to_float(rate_micros) * 100.0)


def _pct_basis(label: str, numerator_cents: int, denominator_cents: int,
               numerator_name: str, denominator_name: str) -> str:
    from .money import fmt
    return "%s = %s (%s) / %s (%s), from this book's own period" % (
        label, fmt(numerator_cents), numerator_name,
        fmt(denominator_cents), denominator_name)


def derive_assumptions(opening: Any, history: Any,
                       **overrides: Any) -> AssumptionSet:
    """Measure every driver this book CAN answer; state the rest.

    ``opening`` is an :class:`~engine.forecast.opening.OpeningPosition`,
    ``history`` a :class:`~engine.forecast.history.PlHistory`. Anything
    passed as a keyword overrides the derivation and is stamped
    ``source='caller'``.
    """
    from .money import fmt

    revenue = history.revenue
    cogs = history.cogs
    opex = history.opex
    depreciation = history.depreciation
    days_basis = 365

    def ratio(numerator, denominator):
        if numerator is None or not denominator or denominator <= 0:
            return None
        return mul_div(numerator, MICRO, denominator)

    def days(numerator_cents, flow_cents):
        """A day count in MICRO-DAYS. The derivation and any caller
        override go through the same resolution, so the sentence a
        driver prints and the value the model spends cannot disagree."""
        if numerator_cents is None or not flow_cents or flow_cents <= 0:
            return None
        return mul_div(numerator_cents * MICRO_DAY, days_basis, flow_cents)

    derived = {}  # type: Dict[str, Assumption]

    def put(key, unit, exact, source, basis, derived_from=()):
        derived[key] = Assumption(key, unit, exact, source, basis,
                                  derived_from=derived_from)

    # ── ratios measurable from the source P&L ──────────────────────────
    # An ``unavailable`` RATE is not the number zero. The contract at the
    # top of this file — ``unavailable`` HOLDS the line it drives at its
    # opening balance — is true of the DAY drivers below, which govern a
    # balance. It is not available to the five rates that govern a P&L
    # FLOW or a programme the model creates itself: there is no balance to
    # hold, so a 0 stored behind the refusal is spent, and for a cost it
    # is the most favourable rate that exists. Each branch below therefore
    # separates the two causes, because they are different facts:
    #
    #   · the rate cannot be MEASURED (no base, or no numerator named)
    #     -> the driver carries None, ``micros`` refuses it, and
    #        ``project`` refuses the plan rather than printing a zero cost
    #        against a book that reports one;
    #   · the LINE is genuinely absent, or its base is arithmetically nil
    #     -> 0 is the absence carried forward, not an invented rate. That
    #        is the model's stated default and it says ``engine_default``,
    #        never the refusal word.
    cogs_pct = ratio(cogs, revenue)
    if cogs is None:
        put("cogs_pct_of_revenue", _RATIO, None, "unavailable",
            "this book names no cost of sales, so its share of revenue "
            "cannot be measured. 0% would assert that this company has "
            "no cost of sales at all, which is an invented rate and the "
            "most favourable one; supply cogs_pct_of_revenue to project "
            "this plan")
    elif cogs_pct is None:
        put("cogs_pct_of_revenue", _RATIO, None, "unavailable",
            "this book reports revenue of %s, so cost of sales cannot be "
            "measured as a share of it. 0%% would project no cost of "
            "sales at all against a book that reports %s; supply "
            "cogs_pct_of_revenue to project this plan"
            % (fmt(revenue or 0), fmt(cogs)))
    else:
        put("cogs_pct_of_revenue", _RATIO, cogs_pct, "derived",
            _pct_basis("cost of sales as a share of revenue", cogs, revenue,
                       "assembled_pl.cogs", "assembled_pl.revenue"),
            ("assembled_pl.cogs", "assembled_pl.revenue"))

    opex_pct = ratio(opex, revenue)
    if opex is None:
        put("opex_pct_of_revenue", _RATIO, None, "unavailable",
            "this book names no operating costs, so their share of "
            "revenue cannot be measured. 0% would assert that this "
            "company has no operating costs at all, which is an invented "
            "rate and the most favourable one; supply opex_pct_of_revenue "
            "to project this plan")
    elif opex_pct is None:
        put("opex_pct_of_revenue", _RATIO, None, "unavailable",
            "this book reports revenue of %s, so operating costs cannot "
            "be measured as a share of it. 0%% would project no operating "
            "costs at all against a book that reports %s a year; supply "
            "opex_pct_of_revenue to project this plan"
            % (fmt(revenue or 0), fmt(opex)))
    else:
        put("opex_pct_of_revenue", _RATIO, opex_pct, "derived",
            _pct_basis("operating costs (excluding cost of sales and "
                       "depreciation) as a share of revenue", opex, revenue,
                       "assembled_pl.opex_excluding_cogs_and_da",
                       "assembled_pl.revenue"),
            ("assembled_pl.opex_excluding_cogs_and_da",
             "assembled_pl.revenue"))

    # ── the named OPERATING INCOME the book carries ────────────────────
    # The two operating COSTS above are derived as a share of revenue. An
    # operating INCOME the same statement names, dropped, is not a
    # conservative simplification: it is the difference between the
    # book's own EBITDA and the model's, on every book that has one.
    other_op_income = history.other_operating_income
    ooi_pct = ratio(other_op_income, revenue)
    if other_op_income is None:
        # The ONE of the five where zero is not an invention: the line
        # itself is absent, so there is nothing to project a share of, and
        # carrying none forward is the absence preserved. It says
        # `engine_default` and not `unavailable`, because nothing is being
        # refused and nothing is being held.
        put("other_operating_income_pct_of_revenue", _RATIO, 0,
            "engine_default",
            "this book names no other operating income, so the projection "
            "carries none. Nothing is being refused here: the line is "
            "absent, so there is no share of revenue to measure")
    elif ooi_pct is None:
        put("other_operating_income_pct_of_revenue", _RATIO, None,
            "unavailable",
            "this book reports revenue of %s, so the other operating "
            "income it does report, %s, cannot be measured as a share of "
            "it; supply other_operating_income_pct_of_revenue to project "
            "this plan" % (fmt(revenue or 0), fmt(other_op_income)))
    else:
        put("other_operating_income_pct_of_revenue", _RATIO, ooi_pct,
            "derived",
            _pct_basis("other operating income as a share of revenue",
                       other_op_income, revenue,
                       "assembled_pl.other_operating_income",
                       "assembled_pl.revenue")
            + ". It is projected on the same basis as cost of sales and "
              "operating costs, and is treated as cash in the period",
            ("assembled_pl.other_operating_income", "assembled_pl.revenue"))

    # ── working-capital days ───────────────────────────────────────────
    ar_cents = opening.cents("ar")
    inv_cents = opening.cents("inventory")
    ap_cents = opening.cents("ap")

    dso = days(ar_cents, revenue)
    if dso is None:
        put("dso_days", _DAYS, None, "unavailable",
            "this book reports no revenue, so days-sales-outstanding "
            "cannot be measured; trade receivables are HELD at their "
            "closing balance of %s" % fmt(ar_cents))
    else:
        put("dso_days", _DAYS, dso, "derived",
            "days sales outstanding = %s days = trade receivables %s / "
            "revenue %s x %d days" % (days_fmt(dso), fmt(ar_cents),
                                      fmt(revenue or 0), days_basis),
            ("canonical_bs.rows.trade_receivables_net",
             "assembled_pl.revenue"))

    dio = days(inv_cents, cogs)
    if dio is None:
        put("dio_days", _DAYS, None, "unavailable",
            "this book reports no cost of sales, so days-inventory-"
            "outstanding cannot be measured; inventory is HELD at its "
            "closing balance of %s" % fmt(inv_cents))
    else:
        put("dio_days", _DAYS, dio, "derived",
            "days inventory outstanding = %s days = inventory %s / cost of "
            "sales %s x %d days" % (days_fmt(dio), fmt(inv_cents),
                                    fmt(cogs or 0), days_basis),
            ("canonical_bs.rows.inventory_net", "assembled_pl.cogs"))

    dpo = days(ap_cents, cogs)
    if dpo is None:
        put("dpo_days", _DAYS, None, "unavailable",
            "this book reports no cost of sales, so days-payables-"
            "outstanding cannot be measured; trade payables are HELD at "
            "their closing balance of %s" % fmt(ap_cents))
    else:
        put("dpo_days", _DAYS, dpo, "derived",
            "days payables outstanding = %s days = trade payables %s / cost "
            "of sales %s x %d days" % (days_fmt(dpo), fmt(ap_cents),
                                       fmt(cogs or 0), days_basis),
            ("canonical_bs.rows.trade_payables", "assembled_pl.cogs"))

    # ── fixed assets ───────────────────────────────────────────────────
    nbv = opening.cents("ppe_net") + opening.cents("intangibles_net")
    dep_rate = ratio(depreciation, nbv)
    if nbv <= 0:
        # THE PLAN CAN CREATE THE BASE THIS RATE PRICES, so a 0 that is
        # honest at the opening date is a lie one period later. The
        # capital programme (``capex_pct_of_revenue`` /
        # ``intangible_additions_pct_of_revenue``) buys fixed assets, and
        # a 0% rate carries every one of them through the rest of the
        # horizon undepreciated — raising operating profit in every
        # period and leaving a net book value that only ever grows. The
        # rate is REFUSED, exactly as ``revolver_rate`` is below, and
        # ``project`` charges nothing while the base is nil and refuses
        # at the period where it is not.
        put("depreciation_rate", _RATIO, None, "unavailable",
            "property, plant, equipment and intangibles stand at %s at the "
            "opening date, so this book prices the wearing-out of nothing "
            "and a rate cannot be measured from it. It is not taken to be "
            "0%%: a plan that invests carries every asset it buys through "
            "the rest of the horizon undepreciated. Nothing is charged "
            "while the base stays nil; supply depreciation_rate to project "
            "a plan that builds one"
            % (fmt(nbv),))
    elif depreciation is None:
        put("depreciation_rate", _RATIO, None, "unavailable",
            "this book names no depreciation charge against a depreciable "
            "base of %s, so a rate cannot be measured. 0%% would carry "
            "that base through the whole projection without ever "
            "depreciating it, which raises operating profit in every "
            "period; supply depreciation_rate to project this plan"
            % (fmt(nbv),))
    else:
        put("depreciation_rate", _RATIO, dep_rate, "derived",
            "annual depreciation rate = charge %s / closing net book value "
            "of property, plant, equipment and intangibles %s. The CLOSING "
            "base is used because this book carries no prior period from "
            "which an opening base could be taken, which overstates the "
            "rate on a growing asset base."
            % (fmt(depreciation or 0), fmt(nbv)),
            ("assembled_pl.depreciation", "canonical_bs.rows.ppe_net",
             "canonical_bs.rows.intangibles_net"))

    capex_pct = ratio(depreciation, revenue)
    if depreciation is None:
        put("capex_pct_of_revenue", _RATIO, 0, "engine_default",
            "the maintenance-capital convention sets capital expenditure "
            "to replace the depreciation charge, and this book names no "
            "charge to replace, so the projection spends nothing on "
            "capital. Nothing is being refused: there is no programme to "
            "size")
    elif capex_pct is None:
        put("capex_pct_of_revenue", _RATIO, None, "unavailable",
            "this book reports revenue of %s, so the maintenance-capital "
            "convention — capital expenditure replaces the depreciation "
            "charge of %s — cannot be expressed as a share of it. 0%% "
            "would depreciate the asset base for the whole horizon and "
            "spend nothing replacing it, which flatters cash in every "
            "period; supply capex_pct_of_revenue to project this plan"
            % (fmt(revenue or 0), fmt(depreciation)))
    else:
        put("capex_pct_of_revenue", _RATIO, capex_pct, "derived",
            "maintenance-capital convention: capital expenditure is set to "
            "replace the depreciation charge, %s / revenue %s. A trial "
            "balance discloses no investment plan, so this is a convention, "
            "not a measurement of intent."
            % (fmt(depreciation or 0), fmt(revenue or 0)),
            ("assembled_pl.depreciation", "assembled_pl.revenue"))

    # ── tax ────────────────────────────────────────────────────────────
    # An effective rate is a claim about the COMPANY, and this book states
    # the company's profit twice: the reconstruction (``pretax`` less
    # ``income_tax``) and the legal figure filed in account 121
    # (``net_income_statutory``). The rate is a MEASUREMENT only when
    # spending it on the book's own pre-tax result reproduces the book's
    # own net income — that is, only when the two agree.
    #
    # When they do not, the same payload is saying that the build-up the
    # ratio is taken from does not reach the filed profit. Both halves of
    # the ratio sit inside that build-up, so neither the charge nor the
    # base is established, and the gap is exactly where a misclassified
    # charge would sit. Stamping that ``derived`` — the strongest word in
    # the closed vocabulary — would put a five-year tax rate on top of a
    # figure the engine itself declares unexplained. (``engine.insights``
    # grades this same difference as a finding; one surface calling it
    # unexplained while another silently measures across it is the
    # two-authorities defect, not a difference of opinion.)
    #
    # The demotion is NOT conditioned on the charge being non-nil. A nil
    # charge on a build-up that DOES reproduce the filed profit is a
    # measured nil — the book saying this company was charged no profit
    # tax — and ABSENT != ZERO cuts both ways: reading a measured nil as
    # an absence is the mirror of reading an absence as zero. The gap is
    # the condition that is actually true; ``tax > 0`` was a proxy for it
    # that let every book with a non-nil charge through.
    pretax = history.pretax
    tax = history.income_tax
    filed = history.net_income
    reconstructed = None if (pretax is None or tax is None) else pretax - tax
    #: The part of the distance to account 121 that nothing on this
    #: statement explains — the bridge less its one nameable component,
    #: capitalised own work. A book whose reconstruction reaches the filed
    #: figure once 722 is added HAS reproduced it, and its rate stays
    #: `derived`; only an unattributable difference demotes it.
    gap = history.unexplained_vs_filed()
    if pretax is not None and pretax > 0 and gap is not None and gap == 0:
        put("tax_rate", _RATIO, mul_div(tax, MICRO, pretax), "derived",
            "effective rate implied by this book = tax %s / pre-tax result "
            "%s. The rate is measured rather than defaulted because "
            "spending it on this book's own pre-tax result reproduces this "
            "book's own net income of %s, leaving nothing unexplained "
            "against account 121%s"
            % (fmt(tax), fmt(pretax), fmt(filed),
               "" if tax else ", and the charge it measures is nil: no "
               "profit tax is projected, and Romanian loss carry-forward "
               "is not modelled either way"),
            ("assembled_pl.income_tax", "assembled_pl.pretax",
             "assembled_pl.net_income_statutory"))
    elif pretax is not None and pretax > 0 and gap is not None:
        put("tax_rate", _RATIO, micros_from(0.16), "engine_default",
            "this book's reconstructed result of %s (pre-tax %s less tax "
            "%s) does not reach the %s it filed in account 121, and %s of "
            "that distance is not attributable to any line on this "
            "statement. An effective rate of %s read off two figures inside "
            "that "
            "build-up would be measured ACROSS the gap rather than from "
            "the company, so the Romanian statutory profit-tax rate is "
            "used instead"
            % (fmt(reconstructed), fmt(pretax), fmt(tax), fmt(filed),
               fmt(gap), _pct_text(ratio(tax, pretax))))
    elif pretax is not None and pretax > 0:
        put("tax_rate", _RATIO, micros_from(0.16), "engine_default",
            "this book reports a positive pre-tax result of %s but does "
            "not carry both an income-tax charge and the net income filed "
            "in account 121, so there is nothing to check an effective "
            "rate against; the Romanian statutory profit-tax rate is used "
            "instead" % (fmt(pretax),))
    else:
        put("tax_rate", _RATIO, micros_from(0.16), "engine_default",
            "this book shows no positive pre-tax result to imply an "
            "effective rate; the Romanian statutory profit-tax rate is "
            "used instead")

    # ── financing cost ─────────────────────────────────────────────────
    debt = opening.cents("st_debt") + opening.cents("lt_debt")
    debt_rate = ratio(history.interest_expense, debt)
    if debt <= 0 or history.interest_expense is None:
        if debt <= 0:
            # The same argument as the depreciable base above, and the
            # same one ``revolver_rate`` makes for itself two lines down:
            # THE PLAN CAN CREATE THE BALANCE THIS RATE PRICES. A
            # ``DebtSchedule`` draw is a first-class plan input, and a 0%
            # rate then carries that debt through the whole horizon free
            # of charge — the cheapest money there is. Nothing is charged
            # while the balance stays nil, and ``project`` refuses at the
            # period where it is not.
            put("interest_rate_debt", _RATIO, None, "unavailable",
                "this book carries no interest-bearing debt at the "
                "opening date, so no borrowing rate is observable in it. "
                "It is not taken to be 0%: a plan that draws debt would "
                "carry it free of charge for the whole horizon. Nothing "
                "is charged while the balance stays nil; supply "
                "interest_rate_debt to project a plan that borrows")
        else:
            put("interest_rate_debt", _RATIO, None, "unavailable",
                "this book carries %s of interest-bearing debt at the "
                "opening date and names no interest expense, so a "
                "borrowing rate cannot be measured. 0%% would carry that "
                "debt through the whole projection free of charge; supply "
                "interest_rate_debt to project this plan" % (fmt(debt),))
        put("revolver_rate", _RATIO, None, "unavailable",
            "no borrowing rate is measurable from this book (it carries no "
            "interest expense, or no interest-bearing debt at the opening "
            "date), so the funding line CANNOT be priced. A plan that "
            "draws the line is refused rather than charged 0%; supply "
            "revolver_rate to price it")
    else:
        basis = ("annual rate = interest expense %s / interest-bearing debt "
                 "at the closing date %s"
                 % (fmt(history.interest_expense or 0), fmt(debt)))
        debt_from = ("assembled_pl.interest_expense",
                     "canonical_bs.rows.financial_liabilities_st",
                     "canonical_bs.rows.financial_liabilities_lt")
        put("interest_rate_debt", _RATIO, debt_rate, "derived", basis,
            debt_from)
        put("revolver_rate", _RATIO, debt_rate, "derived",
            "the funding line is priced at this book's own borrowing rate: "
            + basis, debt_from)

    # ── the financial lines the model cannot ROLL, so it HOLDS ─────────
    # Interest on debt is priced off a balance the model rolls forward.
    # The rest of the financial result is not: foreign-exchange movement,
    # income from holdings, discounts. Nothing in a trial balance says any
    # of it scales with trading, so none of it is grown with revenue —
    # each is carried at the source period's own annual amount, and the
    # driver says so. Zero would have been the invention, not the default.
    interest_income = history.interest_income
    if interest_income is None:
        put("interest_income_annual", _MONEY, 0, "unavailable",
            "this book names no interest income, so none is carried into "
            "the projection")
        put("interest_income_rate", _RATIO, None, "unavailable",
            "this book names no interest income, so no rate on cash can "
            "be measured from it; supply interest_income_rate to earn "
            "interest on projected cash")
    else:
        cash_cents = opening.cents("cash")
        put("interest_income_annual", _MONEY, interest_income, "derived",
            "interest income is carried at this book's own annual amount "
            "of %s, HELD flat rather than grown" % (fmt(interest_income),),
            ("assembled_pl.interest_income",))
        # DELIBERATELY not derived as a rate. The only base available is a
        # single CLOSING cash balance, and interest was earned across the
        # whole year on balances the book does not disclose. The implied
        # rate is rendered into the basis below from the same integers, so
        # the reader can see for themselves how far off that base is (on
        # the committed agras book it reads 25.63% on cash). Carrying the
        # amount is a fact; converting it into a rate is a fabrication.
        put("interest_income_rate", _RATIO, None, "unavailable",
            "interest income of %s is carried at its own amount instead of "
            "as a rate: the only base this book offers is the closing cash "
            "balance of %s, which would imply %s on cash and compound onto "
            "a projected balance the company never held. Supply "
            "interest_income_rate to price interest on projected cash "
            "instead — it replaces the carried amount."
            % (fmt(interest_income), fmt(cash_cents),
               _pct_text(ratio(interest_income, cash_cents))),
            ("assembled_pl.interest_income",))

    other_fin_income = history.other_financial_income()
    if other_fin_income is None:
        put("other_financial_income_annual", _MONEY, 0, "unavailable",
            "this book names no financial income, so none is carried into "
            "the projection")
    else:
        put("other_financial_income_annual", _MONEY, other_fin_income,
            "derived",
            "financial income other than interest on cash = financial "
            "income %s less interest income %s, HELD at that annual amount "
            "because nothing in a trial balance says foreign-exchange "
            "movement or income from holdings scales with trading"
            % (fmt(history.financial_income or 0),
               fmt(history.interest_income or 0)),
            ("assembled_pl.financial_income", "assembled_pl.interest_income"))

    other_fin_expense = history.other_financial_expense()
    if other_fin_expense is None:
        put("other_financial_expense_annual", _MONEY, 0, "unavailable",
            "this book names no financial expense, so none is carried into "
            "the projection")
    else:
        put("other_financial_expense_annual", _MONEY, other_fin_expense,
            "derived",
            "financial expense other than interest on debt = total "
            "financial expense %s less interest expense %s, HELD at that "
            "annual amount. Interest itself is not carried here — it is "
            "priced on the debt this model actually rolls forward"
            % (fmt(history.financial_expense_total or 0),
               fmt(history.interest_expense or 0)),
            ("assembled_pl.financial_expense_total",
             "assembled_pl.interest_expense"))

    # ── the ones a single book cannot answer ───────────────────────────
    for key, unit, default, why in _DEFAULTS:
        if key in derived:
            continue
        exact, _text = _coerce(key, unit, default)
        source = "engine_default"
        derived[key] = Assumption(key, unit, exact, source, why)

    derived["year_one_granularity"] = Assumption(
        "year_one_granularity", _TEXT, None, "engine_default",
        "cash timing matters in year one and stops mattering after it, so "
        "year one is projected monthly and later years annually",
        text="monthly")

    return _build(derived, overrides, overrides.get("debt_schedule"))
