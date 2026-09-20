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

  · ``other_operating_income_annual`` (plan/2 B4b, held) says the LINE is absent
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

TIER PEDIGREE (plan_contract_v2 3.3, 3.4)
=========================================
The source word above is the legacy vocabulary. Every driver also carries
a ``tier`` — book, sector, macro, user, convention or absent — and the
evidence that tier requires, set explicitly at every ``put()`` call site
and never inferred from the basis sentence. Each driver resolves down its
own ladder (3.4); every rung it did NOT take is recorded in
``fallback_steps`` with the reason, so a zero that came from a terminal
convention rung is never a silent zero.

  · ``revenue_growth`` — one trial balance has no prior period, so the
    book rung is absent ("prior periods are not read in this build"), the
    sector rung is absent, and growth takes the MACRO anchor for a period
    whose jurisdiction is Romania (``packs/forecast/ro_macro.yaml``), else
    the convention rung ``levers.yaml#revenue_growth.terminal_rung``.
  · ``dividend_payout_pct`` — ``assembled_cf.dividends_paid`` LOOKS
    derivable and is not: on a book with no prior period the cash-flow
    assembly sets it to half of net profit as an approximation (agras:
    dividends_paid −3,766,838.01 == −7,533,676.02 ÷ 2, exactly). The book
    rung is absent and the convention rung projects no distribution.
  · ``tax_rate`` — the book's effective rate where it reproduces the filed
    profit, else the jurisdiction's STATUTORY rate from the macro pack,
    else the plan is REFUSED (``NoStatutoryTaxRate``): no rate is assumed.
  · the debt repayment schedule — a trial balance discloses balances,
    not maturities. Debt is held at its opening balance until a
    :class:`DebtSchedule` is supplied.

Python 3.9 — no ``match``, no ``X | Y``.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Sequence, Tuple

from .errors import AssumptionError
from .pools import (FIXED_SHARE_PREFIX, LEVEL_PREFIX, PoolSplit, split_pools,
                    split_for_payload)
from .levers_pack import (capex_rules, dividend_book_rung_absent, index_neutral, macro_pack,
                          min_cash_default, terminal_rung)
from .money import (MICRO, MICRO_DAY, cents_from, days_fmt, days_to_float,
                    micro_days_from, micros_from, mul_div, rate_to_float,
                    to_float)

__all__ = [
    "ABSENT_LEGAL",
    "Assumption",
    "AssumptionSet",
    "BookContext",
    "DebtMove",
    "DebtSchedule",
    "NoStatutoryTaxRate",
    "OUTCOMES",
    "SOURCES",
    "TIERS",
    "derive_assumptions",
    "jurisdiction_of",
]

#: The closed source vocabulary. Rendered beside every driver.
SOURCES = ("derived", "caller", "engine_default", "unavailable")

#: The tier vocabulary of plan_contract_v2 3.3. Six, and only six.
TIERS = ("book", "sector", "macro", "user", "convention", "absent")

#: The outcome vocabulary of a fallback step (contract 3.3).
OUTCOMES = ("used", "absent", "below_min_n", "stale", "span_mismatch",
            "rejected")

#: The drivers that may END their ladder absent (contract 3.3): the ones
#: ``project`` reads through ``micros_or_none`` / ``micro_days_or_none``
#: and so HOLDS or refuses at the period a balance appears. Every other
#: driver ends on a non-null rung, or its absence refuses the plan.
#: (``equity_premium`` and ``g_terminal`` join when B12 adds them.)
ABSENT_LEGAL = ("depreciation_rate", "interest_rate_debt", "revolver_rate",
                "interest_income_rate", "dso_days", "dio_cogs_days",
                "dpo_cogs_days")

#: The legacy source word -> tier, as contract 3.4 maps the vocabularies.
#: Used ONLY when an Assumption is built without an explicit tier (a test
#: forging one); every ``put()`` in :func:`derive_assumptions` passes its
#: tier by name.
_TIER_OF_SOURCE = {"derived": "book", "caller": "user",
                   "engine_default": "convention", "unavailable": "absent"}

#: Reasons recorded on rungs no book of this build can reach. Contract
#: text (1.4, 3.4), and each is the sentence of the rung it names.
_HISTORY_NOT_READ = "prior periods are not read in this build"
_NO_SECTOR_SOURCE = "no sector source loaded"
_JURISDICTION_NOT_RECORDED = "the jurisdiction of this book is not recorded"

_RATIO = "ratio"
_DAYS = "days"
_MONEY = "money"
_COUNT = "count"
_TEXT = "text"

_UNITS = (_RATIO, _DAYS, _MONEY, _COUNT, _TEXT)


class NoStatutoryTaxRate(AssumptionError):
    """R16: the book's effective tax rate is not measured and no statutory
    rate is packed for the period's jurisdiction (or the jurisdiction is
    not recorded). The plan is refused rather than taxed at an assumed
    rate. ``code`` is the refusal code the route serves (contract 3.4)."""

    code = "no_statutory_tax_rate"

    def __init__(self, message: str, jurisdiction: Optional[str]) -> None:
        AssumptionError.__init__(self, "tax_rate", message)
        self.jurisdiction = jurisdiction


def jurisdiction_of(envelope: Any) -> Tuple[Optional[str], Optional[str]]:
    """The period's jurisdiction and where it was read (contract 0.3):
    ``envelope.pack_provenance.jurisdiction``, else
    ``envelope.ai_audit.jurisdiction``, else (None, None). Never guessed
    from a currency or a company name."""
    env = envelope if isinstance(envelope, dict) else {}
    for block in ("pack_provenance", "ai_audit"):
        body = env.get(block)
        value = body.get("jurisdiction") if isinstance(body, dict) else None
        if isinstance(value, str) and value.strip():
            return value.strip(), block
    return None, None


class BookContext(object):
    """What a driver ladder needs from the book beyond its opening position
    and P&L: the period's jurisdiction (0.3) and the ratio table's own days
    rows, which a working-capital basis quotes beside the engine's driver
    (contract 4, R8). Frozen; built once per payload."""

    __slots__ = ("jurisdiction", "jurisdiction_source", "ratio_table", "pools")

    #: The ratio-table rows a days basis quotes: engine.ratios.table's own
    #: keys (its _Spec ids), never the methodology pack's ratios, which
    #: divide by cost of sales and are a different quantity (R8).
    RATIO_TABLE_DAYS = ("dio", "dpo")

    def __init__(self, jurisdiction: Optional[str] = None,
                 jurisdiction_source: Optional[str] = None,
                 ratio_table: Optional[Dict[str, Any]] = None,
                 pools: Optional[PoolSplit] = None) -> None:
        object.__setattr__(self, "jurisdiction", jurisdiction)
        object.__setattr__(self, "jurisdiction_source", jurisdiction_source)
        object.__setattr__(self, "ratio_table", dict(ratio_table or {}))
        #: The anchor's cost pools split from its line items (plan/2 B4b,
        #: 5.1); None when the payload carried none.
        object.__setattr__(self, "pools", pools)

    def __setattr__(self, name, value):  # pragma: no cover - frozen
        raise AttributeError("BookContext is frozen")

    @classmethod
    def from_payload(cls, payload: Dict[str, Any]) -> "BookContext":
        envelope = payload.get("envelope") if isinstance(payload, dict) else None
        envelope = envelope if isinstance(envelope, dict) else (
            payload if isinstance(payload, dict) else {})
        jurisdiction, source = jurisdiction_of(envelope)
        return cls(jurisdiction, source, ratio_table_days(payload),
                   split_for_payload(payload) if isinstance(payload, dict) else None)

    def ratio_row(self, key: str) -> Optional[Dict[str, Any]]:
        """The ratio table's row for ``key`` when it carries a value."""
        entry = self.ratio_table.get(key)
        value = entry.get("value") if isinstance(entry, dict) else None
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return None
        return entry


def ratio_table_days(payload: Any) -> Dict[str, Dict[str, Any]]:
    """The ratio table's dio and dpo rows for this payload, computed by
    ``engine.ratios.table.build_ratio_table`` itself (the table the product
    serves), so the quoted value is that table's value and its operands are
    the operands it divided — inventory or trade payables times the period's
    days, over total operating expense. Built from the payload's statements
    only (a forecast payload carries no served metrics); {} when the payload
    carries no statements."""
    if not isinstance(payload, dict):
        return {}
    statements = payload.get("statements")
    envelope = payload.get("envelope")
    if not isinstance(statements, dict) or not isinstance(envelope, dict):
        return {}
    from engine.ratios.table import build_ratio_table

    served = dict(statements)
    if isinstance(envelope.get("canonical_bs"), dict):
        served["canonical_bs"] = envelope["canonical_bs"]
    served["assembled_canonical_v1"] = envelope
    table = build_ratio_table({"statements": served})
    rows = {}
    for row in table.get("rows") or ():
        if isinstance(row, dict) and row.get("key") in \
                BookContext.RATIO_TABLE_DAYS:
            rows[row["key"]] = {"key": row["key"], "value": row.get("value"),
                                "operands": list(row.get("operands") or ())}
    return rows


def _ratio_table_quote(key: str, micro_days: int,
                       operands: Sequence[Dict[str, Any]]) -> str:
    """The ratio table's own days value, rendered from the operands that
    table divided (contract 4, R8): the first operand is the balance, the
    ``period_days`` operand the day count, and every other operand a part
    of its denominator, total operating expense. Nothing here names a
    denominator the quoted number was not divided by."""
    from .money import fmt

    def plain(name):
        return "".join(" " + c.lower() if c.isupper() else c
                       for c in str(name)).replace("_", " ").strip()

    balance = operands[0] if operands else None
    day_count = [o for o in operands if o.get("name") == "period_days"]
    parts = [o for o in operands[1:] if o.get("name") != "period_days"]
    if (balance is None or len(day_count) != 1 or not parts
            or any(not isinstance(o.get("value"), (int, float))
                   or isinstance(o.get("value"), bool)
                   for o in [balance] + day_count + parts)):
        return ("Beside it, the ratio table's %s (engine.ratios.table) reads "
                "%s days" % (key, days_fmt(micro_days)))
    denominator = sum(cents_from(o["value"]) for o in parts)
    return ("Beside it, the ratio table's %s (engine.ratios.table) reads %s "
            "days = %s %s x %s days / total operating expense %s (%s); that "
            "table divides by total operating expense, not cost of sales, so "
            "its value is quoted here and never served under this driver's "
            "name" % (key, days_fmt(micro_days), plain(balance["name"]),
                      fmt(cents_from(balance["value"])),
                      days_fmt(micro_days_from(day_count[0]["value"])),
                      fmt(denominator),
                      " + ".join(plain(o["name"]) for o in parts)))


def _step(tier: str, outcome: str, reason: str) -> Dict[str, str]:
    """One rung not taken (or, for ``used``, taken), with its sentence."""
    if tier not in TIERS:
        raise AssumptionError("fallback_steps", "unknown tier %r" % (tier,))
    if outcome not in OUTCOMES:
        raise AssumptionError("fallback_steps",
                              "unknown outcome %r" % (outcome,))
    if not str(reason or "").strip():
        raise AssumptionError("fallback_steps",
                              "a %s step with no reason" % (tier,))
    return {"tier": tier, "outcome": outcome, "reason": str(reason)}


class Assumption(object):
    """One driver: its exact integer value, its unit, and its pedigree."""

    __slots__ = ("key", "unit", "exact", "text", "source", "basis",
                 "derived_from", "tier", "rule_id", "evidence",
                 "fallback_steps", "original")

    def __init__(self, key: str, unit: str, exact: Optional[int],
                 source: str, basis: str, text: Optional[str] = None,
                 derived_from: Sequence[str] = (), *,
                 tier: Optional[str] = None, rule_id: Optional[str] = None,
                 evidence: Optional[Dict[str, Any]] = None,
                 fallback_steps: Sequence[Dict[str, str]] = (),
                 original: Optional["Assumption"] = None) -> None:
        if unit not in _UNITS:
            raise AssumptionError(key, "unknown unit %r" % (unit,))
        if source not in SOURCES:
            raise AssumptionError(key, "unknown source %r" % (source,))
        resolved_tier = tier if tier is not None else _TIER_OF_SOURCE[source]
        if resolved_tier not in TIERS:
            raise AssumptionError(key, "unknown tier %r" % (resolved_tier,))
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
        #: contract 3.3/3.4 pedigree. ``tier`` is set by name at every
        #: ``put()``; ``evidence`` is the object the tier requires (book:
        #: {method, periods_used, inputs}; macro: the pack series evidence;
        #: convention: {rule_id, pack_address, evidence}); ``original`` is
        #: the value a user tier replaced.
        self.tier = resolved_tier
        self.rule_id = rule_id
        self.evidence = evidence
        self.fallback_steps = tuple(fallback_steps)
        self.original = original

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
            "tier": self.tier,
            "rule_id": self.rule_id,
            "fallback_steps": [dict(step) for step in self.fallback_steps],
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
        # A stated rule with no quantity. No driver carries one since
        # `year_one_granularity` left KEYS (plan/2 B2: the horizon is a
        # request field, never a driver); the mapping stays so a word is
        # never served dressed as a number if one is added.
        _TEXT: "convention",
    }

    def as_fp1(self, period_labels: Sequence[str]) -> Optional[Dict[str, Any]]:
        """This driver in the shape ``engine.forecast_serving`` serves.

        None for a driver with no fp1 unit — a contract that only knows
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
        return "Assumption(%s=%r, %s/%s)" % (self.key, self.value(),
                                             self.source, self.tier)


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


#: key -> unit, in served order. Since plan/2 B3 a key carries NO default
#: here: every driver is resolved by name down its own ladder in
#: :func:`derive_assumptions` (contract 3.4), each rung's value and sentence
#: read from ``packs/forecast/levers.yaml`` or ``ro_macro.yaml``. A key the
#: derivation forgets to resolve refuses at the end of it rather than
#: falling through to a number typed beside its name.
#:
#: ``dio_cogs_days`` and ``dpo_cogs_days`` were ``dio_days`` / ``dpo_days``
#: (contract R8, B3): both are days of COST OF SALES, while the ratio table
#: divides inventory and payables by total operating expense, so one name
#: would have shown two values.
_DEFAULTS = (
    ("revenue_growth", _RATIO),
    # plan/2 B4b: inflation moves the FIXED part of every opex pool (5.3);
    # cogs_pct_of_revenue and opex_pct_of_revenue left KEYS — cost of
    # sales and operating costs are POOLS split from the anchor's line
    # items (section 5), served as pool_fixed_share.<pool> and
    # pool_level.<opex pool> per book; other_operating_income_annual is
    # the renamed other_operating_income_pct_of_revenue: the anchor's own
    # amount, HELD (5.5), never a share of revenue.
    ("inflation", _RATIO),
    ("other_operating_income_annual", _MONEY),
    ("dso_days", _DAYS),
    ("dio_cogs_days", _DAYS),
    ("dpo_cogs_days", _DAYS),
    ("depreciation_rate", _RATIO),
    ("capex_pct_of_revenue", _RATIO),
    ("intangible_additions_pct_of_revenue", _RATIO),
    ("tax_rate", _RATIO),
    ("interest_rate_debt", _RATIO),
    ("revolver_rate", _RATIO),
    ("interest_income_rate", _RATIO),
    ("interest_income_annual", _MONEY),
    ("other_financial_income_annual", _MONEY),
    ("other_financial_expense_annual", _MONEY),
    ("dividend_payout_pct", _RATIO),
    ("min_cash", _MONEY),
    ("days_basis", _COUNT),
)

_RATIO_KEYS = tuple(k for k, u in _DEFAULTS if u == _RATIO)
_DAYS_KEYS = tuple(k for k, u in _DEFAULTS if u == _DAYS)
_MONEY_KEYS = tuple(k for k, u in _DEFAULTS if u == _MONEY)
_COUNT_KEYS = tuple(k for k, u in _DEFAULTS if u == _COUNT)
_UNIT_OF = dict(_DEFAULTS)


def is_pool_key(key: str) -> bool:
    """A per-book pool driver (plan/2 B4b, 3a.2): pool_fixed_share.<pool>
    or pool_level.<opex pool>, expanded per book from the two template
    entries of packs/forecast/levers.yaml."""
    return key.startswith(FIXED_SHARE_PREFIX) or key.startswith(LEVEL_PREFIX)


def unit_of(key: str) -> str:
    if key in _UNIT_OF:
        return _UNIT_OF[key]
    if is_pool_key(key):
        return _RATIO
    raise AssumptionError(key, "no such driver")
#: Every driver. The horizon is NOT one: ``total_years`` and
#: ``monthly_months`` are request fields that ``project()`` takes as
#: arguments (plan_contract_v2 2.2), so no override can move them and no
#: lever-reach nudge can reach them. ``days_basis`` stays only as the
#: source of the days_basis convention (3.5).
KEYS = tuple(k for k, _u in _DEFAULTS)


class AssumptionSet(object):
    """Every driver of one projection, each with its pedigree."""

    __slots__ = ("_by_key", "debt_schedule", "pools", "_pool_keys")

    def __init__(self, assumptions: Sequence[Assumption],
                 debt_schedule: Optional[DebtSchedule] = None,
                 pools: Optional[PoolSplit] = None) -> None:
        by_key = {}  # type: Dict[str, Assumption]
        pool_keys = []  # type: List[str]
        for item in assumptions:
            by_key[item.key] = item
            if item.key not in _UNIT_OF:
                if not is_pool_key(item.key):
                    raise AssumptionError(item.key, "no such driver")
                pool_keys.append(item.key)
        missing = sorted(set(KEYS) - set(by_key))
        if missing:
            raise AssumptionError("assumption_set",
                                  "missing driver(s): %s" % ", ".join(missing))
        self._by_key = by_key
        self.debt_schedule = debt_schedule or DebtSchedule()
        #: The anchor's cost pools (plan/2 B4b, section 5): the bases the
        #: pool_fixed_share.* / pool_level.* drivers apply to. None on a
        #: set built without a book (a forged set in a test); project()
        #: then refuses the split by name (#no_line_items).
        self.pools = pools
        self._pool_keys = tuple(pool_keys)

    #: The pool FACTS the model publishes for engine.forecast_drivers
    #: (contract 4, plan/2 B4b): measured from the anchor's line items by
    #: the pool split, read by key like a driver, never overridable and
    #: never served in KEYS. ``pools.cost_of_sales_share`` is the
    #: cost_of_sales pool base over revenue; ``pools.operating_cost_share``
    #: the opex pools' sum over revenue; ``pools.opex_fixed_share`` the
    #: amount-weighted fixed share of the served opex pools.
    POOL_FACTS = ("pools.cost_of_sales_share", "pools.operating_cost_share",
                  "pools.opex_fixed_share")

    def __getitem__(self, key: str) -> Assumption:
        if key not in self._by_key:
            if key in self.POOL_FACTS:
                return self._pool_fact(key)
            raise AssumptionError(key, "no such driver")
        return self._by_key[key]

    def _pool_fact(self, key: str) -> Assumption:
        from .money import fmt

        pools = self.pools
        if pools is None:
            why = "this set was built without a book, so no pool split exists"
            return Assumption(key, _RATIO, None, "unavailable", why, tier="absent",
                              fallback_steps=(_step("book", "absent", why),))
        revenue = pools.revenue_cents
        if key == "pools.opex_fixed_share":
            share = pools.aggregate_fixed_share_micros()
            if share is None:
                why = ("the pooled operating-cost base of this book is not "
                       "positive, so no fixed share can be weighted")
                return Assumption(key, _RATIO, None, "unavailable", why, tier="absent",
                                  fallback_steps=(_step("book", "absent", why),))
            pooled = [p for p in pools.opex if p.base_cents > 0]
            rule_ids = sorted(set(p.rule_id for p in pooled))
            return Assumption(
                key, _RATIO, share, "engine_default",
                "the amount-weighted fixed share of this book's operating-cost "
                "pools (%s), each pool's share resolved down its own ladder "
                "(%s)" % (", ".join("%s %s of which %s fixed"
                                    % (p.name, fmt(p.base_cents),
                                       fmt(mul_div(p.base_cents, p.fixed_share_micros, MICRO)))
                                    for p in pooled), "; ".join(rule_ids)),
                tuple("line_items.%s" % p.name for p in pooled),
                tier="convention", rule_id=rule_ids[0] if rule_ids else None,
                evidence={"rule_id": rule_ids[0] if rule_ids else None,
                          "pack_address": rule_ids[0] if rule_ids else None,
                          "evidence": [{"fact": "line_items.%s" % p.name,
                                        "value_minor": p.base_cents,
                                        "fixed_share_micros": p.fixed_share_micros}
                                       for p in pooled]})
        if key == "pools.cost_of_sales_share":
            base, fact = pools.cost_of_sales.base_cents, "line_items.cogs"
            label = "cost of sales (the cost_of_sales pool base)"
        else:
            base, fact = pools.opex_sum_cents, "line_items.operating_costs"
            label = "operating costs (the sum of the operating-cost pools)"
        absent = [p.absent_reason for p in (
            (pools.cost_of_sales,) if key == "pools.cost_of_sales_share"
            else pools.opex) if p.absent_reason is not None]
        if absent:
            return Assumption(key, _RATIO, None, "unavailable", absent[0], tier="absent",
                              fallback_steps=(_step("book", "absent", absent[0]),))
        if revenue <= 0:
            why = ("this book reports revenue of %s, so %s cannot be measured "
                   "as a share of it" % (fmt(revenue), label))
            return Assumption(key, _RATIO, None, "unavailable", why, tier="absent",
                              fallback_steps=(_step("book", "absent", why),))
        share = mul_div(base, MICRO, revenue)
        return Assumption(
            key, _RATIO, share, "derived",
            _pct_basis("%s as a share of revenue" % label, base, revenue, fact,
                       "assembled_pl.revenue"),
            (fact, "assembled_pl.revenue"), tier="book",
            evidence={"method": "level", "periods_used": [],
                      "inputs": [{"fact": fact, "value_minor": base, "authority": "line_items"},
                                 {"fact": "assembled_pl.revenue", "value_minor": revenue,
                                  "authority": "assembled_pl"}]})

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

    def keys(self) -> Tuple[str, ...]:
        """Every driver of this set: KEYS in served order, then this
        book's expanded pool keys (pool_fixed_share.cost_of_sales, the
        opex pools' fixed shares, then their levels — 3a.2)."""
        return tuple(KEYS) + self._pool_keys

    def pool_keys(self) -> Tuple[str, ...]:
        return self._pool_keys

    def items(self) -> Tuple[Assumption, ...]:
        return tuple(self._by_key[k] for k in self.keys())

    def as_list(self) -> List[Dict[str, Any]]:
        return [item.as_dict() for item in self.items()]

    def unavailable(self) -> Tuple[str, ...]:
        return tuple(k for k in self.keys() if self._by_key[k].source == "unavailable")

    def with_overrides(self, **overrides: Any) -> "AssumptionSet":
        """A copy with caller-supplied drivers replacing derived ones.
        Every replaced driver is re-stamped ``source='caller'`` — an
        override never inherits a derivation's pedigree."""
        return _build(self._by_key, overrides, self.debt_schedule, self.pools)


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


def _is_absent_handover(value: Any) -> bool:
    """An explicit ABSENT crossing from ``engine.forecast_drivers``
    (``authority.AbsentHandover``). Duck-typed so this package never imports
    that one (contract 4: the model is the consumer)."""
    return bool(getattr(value, "is_absent_handover", False))


def _handover_tier(value: Any) -> Optional[Dict[str, Any]]:
    """The tier pedigree a crossed value carries, or None for a plain
    caller value. A hand-over never demotes a book, macro or convention
    value to a user one (contract 4)."""
    pedigree = getattr(value, "pedigree", None)
    if not isinstance(pedigree, dict):
        return None
    tier = pedigree.get("tier")
    if tier not in ("book", "macro", "convention"):
        return None
    return pedigree


def _exact_of_handover(key: str, unit: str, value: Any) -> Optional[int]:
    """The UNROUNDED integer a hand-over carries (micros or micro-days),
    so the crossing never goes through a display rounding (contract 4)."""
    pedigree = getattr(value, "pedigree", None)
    if not isinstance(pedigree, dict) or "exact" not in pedigree:
        return None
    exact = pedigree.get("exact")
    want = {_RATIO: "micros", _DAYS: "micro_days", _MONEY: "minor"}.get(unit)
    if pedigree.get("exact_unit") != want or isinstance(exact, bool) \
            or not isinstance(exact, int):
        raise AssumptionError(
            key, "a hand-over carries %r in %r, and this driver holds %s"
                 % (exact, pedigree.get("exact_unit"), want))
    return exact


def _build(base: Dict[str, Assumption], overrides: Dict[str, Any],
           debt_schedule: Optional[DebtSchedule],
           pools: Optional[PoolSplit] = None) -> AssumptionSet:
    keys = tuple(KEYS) + tuple(k for k in base if k not in _UNIT_OF)
    unknown = sorted(set(overrides) - set(keys) - {"debt_schedule"})
    if unknown:
        raise AssumptionError("overrides", "unknown driver(s): %s. Known: %s"
                              % (", ".join(unknown), ", ".join(keys)))
    schedule = overrides.get("debt_schedule", debt_schedule)
    out = []  # type: List[Assumption]
    for key in keys:
        current = base[key]
        if key not in overrides:
            out.append(current)
            continue
        value = overrides[key]
        if value is None:
            # plan/2 B3 (contract 4): the None check that DROPPED a None
            # here is gone. A dropped None looked like a hand-over and
            # behaved like a silence — the model kept its own default under
            # the caller's name. ABSENT crosses as an explicit object that
            # says why; None is not a value and is refused.
            raise AssumptionError(
                key, "None is not a driver value. An absent driver crosses "
                     "as an explicit absent hand-over naming its reason; "
                     "omit the key to keep this book's own resolution")
        if _is_absent_handover(value):
            out.append(_absent_over(current, value))
            continue
        exact = _exact_of_handover(key, current.unit, value)
        text = None
        if exact is None:
            exact, text = _coerce(key, current.unit, value)
        pedigree = _handover_tier(value)
        # THE PEDIGREE RIDES THE VALUE ACROSS THE AUTHORITY BOUNDARY.
        #
        # This stamped every override `basis="supplied by the caller"`
        # with an empty `derived_from`, which discarded the derivation
        # ONE LINE AFTER the crossing handed it over. Measured on the
        # wire before this change: 15 of 21 drivers reached the reader
        # with no derivation at all and 9 said "supplied by the caller".
        # `engine.forecast_drivers.model_overrides()` returns
        # `SuppliedValue`, a real `float` subclass carrying the full
        # pedigree, so this is safe by construction: a plain-float
        # caller has neither attribute and behaves exactly as before.
        if pedigree is not None:
            out.append(Assumption(
                key, current.unit, exact, "caller",
                getattr(value, "pedigree_basis", None) or current.basis,
                text=text, derived_from=getattr(value, "pedigree_from", ()),
                tier=pedigree["tier"], rule_id=pedigree.get("rule_id"),
                evidence=pedigree.get("evidence"),
                fallback_steps=tuple(pedigree.get("fallback_steps") or ())))
            continue
        out.append(Assumption(
            key, current.unit, exact, "caller",
            getattr(value, "pedigree_basis", None) or "supplied by the caller",
            text=text,
            derived_from=getattr(value, "pedigree_from", ()),
            tier="user", original=current,
            fallback_steps=current.fallback_steps))
    return AssumptionSet(out, schedule, pools)


def _absent_over(current: Assumption, handover: Any) -> Assumption:
    """An absent hand-over applied to an already-resolved driver.

    Outside :func:`derive_assumptions` there is no ladder to continue down,
    so this can only RECORD the authority's refusal against a value that
    did not come from the book rung. Displacing a BOOK value needs the
    ladder (tax falls to its statutory rung, an absent-legal driver to
    absent), and is refused here rather than guessed."""
    reason = str(getattr(handover, "reason", "") or "").strip()
    if current.tier == "book":
        raise AssumptionError(
            current.key,
            "an absent hand-over over a value measured from the book must "
            "be passed to derive_assumptions, which continues the ladder; "
            "it cannot be applied to an already-resolved set")
    step = _step("book", "absent", reason or "the driver authority "
                 "published no value for this book")
    return Assumption(
        current.key, current.unit, current.exact, current.source,
        current.basis, text=current.text, derived_from=current.derived_from,
        tier=current.tier, rule_id=current.rule_id,
        evidence=current.evidence,
        fallback_steps=(step,) + tuple(
            s for s in current.fallback_steps
            if not (s["tier"] == "book" and s["outcome"] == "absent")),
        original=current.original)


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


def _pct4(rate_micros: int) -> str:
    """A rate for a sentence, rendered from the integer the model holds."""
    return "%.4f%%" % (rate_to_float(rate_micros) * 100.0)


def _micros_of(value: Any) -> int:
    """An exact pack rational in micros; refused if it is not exact there."""
    from fractions import Fraction
    scaled = Fraction(value) * MICRO
    if scaled.denominator != 1:
        raise AssumptionError("pack", "%s is not exact in micros" % (value,))
    return int(scaled)


def _cents_of(value: Any) -> int:
    from fractions import Fraction
    scaled = Fraction(value) * 100
    if scaled.denominator != 1:
        raise AssumptionError("pack", "%s is not exact in minor units"
                              % (value,))
    return int(scaled)


def derive_assumptions(opening: Any, history: Any, *,
                       context: Optional[BookContext] = None,
                       **overrides: Any) -> AssumptionSet:
    """Measure every driver this book CAN answer; resolve the rest down
    their ladders (contract 3.4).

    ``opening`` is an :class:`~engine.forecast.opening.OpeningPosition`,
    ``history`` a :class:`~engine.forecast.history.PlHistory`, ``context``
    the :class:`BookContext` (jurisdiction, ratio table). With no context
    the jurisdiction is NOT recorded, so no macro or statutory rung applies
    and a tax rate the book cannot measure refuses the plan (0.3, R16).
    Anything passed as a keyword overrides the resolution and is stamped
    ``source='caller'``; an explicit absent hand-over from the driver
    authority removes the book rung for its key and the ladder continues.
    """
    from .money import fmt

    context = context or BookContext()
    jurisdiction = context.jurisdiction
    macro = macro_pack()

    #: The driver authority's explicit ABSENT crossings (contract 4): the
    #: book rung of each named key is taken as absent for the stated
    #: reason, and the ladder continues. They are not overrides.
    authority_absent = {}  # type: Dict[str, str]
    for key in list(overrides):
        if _is_absent_handover(overrides[key]):
            if key not in KEYS:
                raise AssumptionError("overrides", "unknown driver(s): %s"
                                      % (key,))
            authority_absent[key] = str(
                getattr(overrides[key], "reason", "") or
                "the driver authority published no value for this book")
            del overrides[key]

    revenue = history.revenue
    cogs = history.cogs
    opex = history.opex
    depreciation = history.depreciation
    days_basis = 365
    period_end = str(getattr(opening, "period_end", "") or "")

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

    def book(*inputs):
        """The BASIS book evidence of a level read from this period
        (contract 3.3): each input is (fact, value, value-field)."""
        return {"method": "level", "periods_used": [period_end],
                "inputs": [{"fact": fact, "period_end": period_end,
                            field: value,
                            "authority": fact.split(".")[0]}
                           for fact, value, field in inputs]}

    def convention(rule_id, *facts):
        return {"rule_id": rule_id,
                "pack_address": rule_id if rule_id.startswith("packs/")
                else None,
                "evidence": [{"fact": fact, field: value}
                             for fact, value, field in facts]}

    def jurisdiction_reason(what):
        if jurisdiction is None:
            return _JURISDICTION_NOT_RECORDED
        return "no %s is packed for jurisdiction %s" % (what, jurisdiction)

    derived = {}  # type: Dict[str, Assumption]

    def put(key, unit, exact, source, basis, derived_from=(), *, tier,
            rule_id=None, evidence=None, steps=()):
        if key in derived:
            raise AssumptionError(key, "resolved twice")
        if unit != unit_of(key):
            raise AssumptionError(key, "resolved as %s, declared %s"
                                  % (unit, unit_of(key)))
        steps = tuple(steps)
        if key in authority_absent and not any(
                s["tier"] == "book" for s in steps):
            steps = (_step("book", "absent", authority_absent[key]),) + steps
        _check_pedigree(key, exact, tier, evidence, steps)
        derived[key] = Assumption(key, unit, exact, source, basis,
                                  derived_from=derived_from, tier=tier,
                                  rule_id=rule_id, evidence=evidence,
                                  fallback_steps=steps)

    def refused_by_authority(key):
        """The book rung of ``key`` was published ABSENT by the driver
        authority, so a measurement here would be a second authority."""
        return key in authority_absent

    # ── the cost POOLS of this book (plan/2 B4b, contract 5) ───────────
    # Cost of sales and operating costs are no longer shares of revenue:
    # each is a pool split from the anchor's line items, with a fixed
    # share resolved down its own ladder (pools.py). The engine is the one
    # authority for the split; engine.forecast_drivers reads it (contract
    # 4). A context with no split (a caller that built no payload) refuses
    # the split BY NAME — one pool that follows volume in full, the rule's
    # own sentence as its basis — never a guessed split.
    pools = getattr(context, "pools", None)
    if pools is None:
        # ABSENT != ZERO: an absent cogs / opex total is handed on as None
        # and the pool it would have priced is served absent (refused).
        pools = split_pools(None, opex_total_cents=opex, cogs_total_cents=cogs,
                            revenue_cents=revenue or 0)
    index_rung = index_neutral()

    def put_pool(key, pool):
        if pool.absent_reason is not None:
            # ABSENT != ZERO (plan/2 B4 repair): a refusal carries nothing.
            put(key, _RATIO, None, "unavailable", pool.absent_reason,
                tier="absent",
                steps=(_step("book", "absent", pool.absent_reason),))
            return
        put(key, _RATIO, pool.fixed_share_micros, "engine_default",
            "%s: %s (anchor base %s)" % (pool.name, pool.sentence,
                                          fmt(pool.base_cents)),
            tier=pool.tier, rule_id=pool.rule_id, evidence=pool.evidence,
            steps=pool.fallback_steps)

    # ── the named OPERATING INCOME the book carries, HELD (5.5) ────────
    # The anchor's own amount, tier book: it scales with neither volume,
    # growth nor inflation and is sliced by days. Renamed from
    # other_operating_income_pct_of_revenue (3a.2); the convention that it
    # followed revenue is retired with the rename.
    other_op_income = history.other_operating_income
    if other_op_income is None:
        rung = terminal_rung("other_operating_income_annual")
        why = ("assembled_pl.other_operating_income is not carried by this "
               "book")
        put("other_operating_income_annual", _MONEY, _cents_of(rung.value),
            "engine_default", rung.sentence, tier="convention",
            rule_id=rung.rule_id, evidence=convention(rung.rule_id),
            steps=(_step("book", "absent", why),))
    else:
        put("other_operating_income_annual", _MONEY, int(other_op_income),
            "derived",
            "other operating income held at this book's own amount of %s: "
            "it scales with neither volume, growth nor inflation, and is "
            "spread across each plan year by days" % fmt(other_op_income),
            ("assembled_pl.other_operating_income",),
            tier="book", evidence=book(
                ("assembled_pl.other_operating_income", other_op_income,
                 "value_minor")))

    # ── working-capital days ───────────────────────────────────────────
    # contract 4 / R8: engine.forecast's formulas are the authority
    # (forecast.dso, forecast.dio_cogs, forecast.dpo_cogs). Inventory and
    # payables are days of COST OF SALES; the ratio table divides both by
    # total operating expense, so its own value is quoted beside them as a
    # book input rather than served under the same name.
    ar_cents = opening.cents("ar")
    inv_cents = opening.cents("inventory")
    ap_cents = opening.cents("ap")

    def day_driver(key, formula_id, balance, balance_fact, flow, flow_fact,
                   what, flow_word, ratio_key):
        measured = days(balance, flow)
        if measured is None or refused_by_authority(key):
            why = ("this book reports no %s, so %s cannot be measured; %s "
                   "HELD at %s closing balance of %s"
                   % (flow_word, what,
                      "trade receivables are" if key == "dso_days" else
                      ("inventory is" if key == "dio_cogs_days"
                       else "trade payables are"),
                      "their" if key != "dio_cogs_days" else "its",
                      fmt(balance)))
            if refused_by_authority(key):
                why = authority_absent[key]
            put(key, _DAYS, None, "unavailable", why, tier="absent",
                rule_id=formula_id, steps=(_step("book", "absent", why),))
            return
        row = context.ratio_row(ratio_key) if ratio_key else None
        inputs = [(balance_fact, balance, "value_minor"),
                  (flow_fact, flow, "value_minor")]
        quoted = ""
        if row is not None:
            table_micro_days = micro_days_from(row["value"])
            inputs.append(("ratio_table.%s" % ratio_key, table_micro_days,
                           "value_micro_days"))
            quoted = ". " + _ratio_table_quote(ratio_key, table_micro_days,
                                               row["operands"])
        put(key, _DAYS, measured, "derived",
            "%s = %s days = %s %s / %s %s x %d days (%s)%s"
            % (what, days_fmt(measured), balance_fact.split(".")[-1]
               .replace("_", " "), fmt(balance), flow_word, fmt(flow),
               days_basis, formula_id, quoted),
            (balance_fact, flow_fact), tier="book", rule_id=formula_id,
            evidence=book(*inputs))

    day_driver("dso_days", "forecast.dso", ar_cents,
               "canonical_bs.rows.trade_receivables_net", revenue,
               "assembled_pl.revenue", "days sales outstanding", "revenue",
               None)
    day_driver("dio_cogs_days", "forecast.dio_cogs", inv_cents,
               "canonical_bs.rows.inventory_net", cogs, "assembled_pl.cogs",
               "days inventory outstanding, in days of cost of sales",
               "cost of sales", "dio")
    day_driver("dpo_cogs_days", "forecast.dpo_cogs", ap_cents,
               "canonical_bs.rows.trade_payables", cogs, "assembled_pl.cogs",
               "days payables outstanding, in days of cost of sales",
               "cost of sales", "dpo")

    # ── fixed assets ───────────────────────────────────────────────────
    nbv = opening.cents("ppe_net") + opening.cents("intangibles_net")
    dep_rate = ratio(depreciation, nbv)
    if nbv <= 0:
        # THE PLAN CAN CREATE THE BASE THIS RATE PRICES, so a 0 that is
        # honest at the opening date is a lie one period later. The rate is
        # REFUSED, and ``project`` charges nothing while the base is nil
        # and refuses at the period where it is not.
        why = ("property, plant, equipment and intangibles stand at %s at "
               "the opening date, so this book prices the wearing-out of "
               "nothing and a rate cannot be measured from it. It is not "
               "taken to be 0%%: a plan that invests carries every asset it "
               "buys through the rest of the horizon undepreciated. Nothing "
               "is charged while the base stays nil; supply depreciation_rate "
               "to project a plan that builds one" % (fmt(nbv),))
        put("depreciation_rate", _RATIO, None, "unavailable", why,
            tier="absent", steps=(_step("book", "absent", why),))
    elif depreciation is None or refused_by_authority("depreciation_rate"):
        why = ("this book names no depreciation charge against a depreciable "
               "base of %s, so a rate cannot be measured. 0%% would carry "
               "that base through the whole projection without ever "
               "depreciating it, which raises operating profit in every "
               "period; supply depreciation_rate to project this plan"
               % (fmt(nbv),))
        put("depreciation_rate", _RATIO, None, "unavailable", why,
            tier="absent", steps=(_step("book", "absent", why),))
    else:
        put("depreciation_rate", _RATIO, dep_rate, "derived",
            "annual depreciation rate = charge %s / closing net book value "
            "of property, plant, equipment and intangibles %s. The CLOSING "
            "base is used because this book carries no prior period from "
            "which an opening base could be taken, which overstates the "
            "rate on a growing asset base."
            % (fmt(depreciation or 0), fmt(nbv)),
            ("assembled_pl.depreciation", "canonical_bs.rows.ppe_net",
             "canonical_bs.rows.intangibles_net"),
            tier="book", rule_id="forecast.depreciation_rate_closing_nbv",
            evidence=book(
                ("assembled_pl.depreciation", depreciation, "value_minor"),
                ("canonical_bs.rows.ppe_net", opening.cents("ppe_net"),
                 "value_minor"),
                ("canonical_bs.rows.intangibles_net",
                 opening.cents("intangibles_net"), "value_minor")))

    # ── capital expenditure (contract 3.4: never absent) ───────────────
    maintenance, no_charge, nil_revenue = capex_rules()
    capex_pct = ratio(depreciation, revenue)
    if depreciation is None:
        put("capex_pct_of_revenue", _RATIO, _micros_of(no_charge.value),
            "engine_default", no_charge.sentence, tier="convention",
            rule_id=no_charge.rule_id, evidence=convention(no_charge.rule_id),
            steps=(_step("convention", "rejected",
                         "%s: this book names no depreciation charge"
                         % (maintenance.rule_id,)),))
    elif capex_pct is None:
        # A nil revenue stays nil under every lever, so no rate could size
        # a spend: the terminal rung spends nothing and says what runs down.
        put("capex_pct_of_revenue", _RATIO, _micros_of(nil_revenue.value),
            "engine_default",
            nil_revenue.sentence.replace("{amount}", fmt(depreciation)),
            tier="convention", rule_id=nil_revenue.rule_id,
            evidence=convention(
                nil_revenue.rule_id,
                ("assembled_pl.depreciation", depreciation, "value_minor"),
                ("assembled_pl.revenue", revenue or 0, "value_minor")),
            steps=(_step("convention", "rejected",
                         "%s: this book reports revenue of %s"
                         % (maintenance.rule_id, fmt(revenue or 0))),))
    else:
        put("capex_pct_of_revenue", _RATIO, capex_pct, "derived",
            maintenance.sentence.replace("{amount}", fmt(depreciation)),
            ("assembled_pl.depreciation", "assembled_pl.revenue"),
            tier="convention", rule_id=maintenance.rule_id,
            evidence=convention(
                maintenance.rule_id,
                ("assembled_pl.depreciation", depreciation, "value_minor"),
                ("assembled_pl.revenue", revenue, "value_minor")))

    rung = terminal_rung("intangible_additions_pct_of_revenue")
    put("intangible_additions_pct_of_revenue", _RATIO, _micros_of(rung.value),
        "engine_default", rung.sentence, tier="convention",
        rule_id=rung.rule_id, evidence=convention(rung.rule_id))

    # ── tax (R16) ──────────────────────────────────────────────────────
    # An effective rate is a claim about the COMPANY, and this book states
    # the company's profit twice: the reconstruction (``pretax`` less
    # ``income_tax``) and the legal figure filed in account 121. The rate
    # is a MEASUREMENT only when spending it on the book's own pre-tax
    # result reproduces the book's own net income. When it does not, the
    # book rung is absent for that stated reason and the ladder takes the
    # jurisdiction's STATUTORY rate; with no packed statutory record the
    # plan is refused (NoStatutoryTaxRate) — no rate is assumed.
    pretax = history.pretax
    tax = history.income_tax
    filed = history.net_income
    reconstructed = None if (pretax is None or tax is None) else pretax - tax
    #: The part of the distance to account 121 that nothing on this
    #: statement explains — the bridge less its one nameable component,
    #: capitalised own work.
    gap = history.unexplained_vs_filed()
    measured = (pretax is not None and pretax > 0 and gap is not None
                and gap == 0 and not refused_by_authority("tax_rate"))
    if measured:
        put("tax_rate", _RATIO, mul_div(tax, MICRO, pretax), "derived",
            "effective rate implied by this book = tax %s / pre-tax result "
            "%s. The rate is measured rather than defaulted because "
            "spending it on this book's own pre-tax result reproduces this "
            "book's own net income of %s, leaving nothing unexplained "
            "against account 121%s"
            % (fmt(tax), fmt(pretax), fmt(filed),
               "" if tax else ", and the charge it measures is nil: no "
               "profit tax is projected, and loss carry-forward is not "
               "modelled either way"),
            ("assembled_pl.income_tax", "assembled_pl.pretax",
             "assembled_pl.net_income_statutory"),
            tier="book", rule_id="forecast.effective_tax_rate",
            evidence=book(("assembled_pl.income_tax", tax, "value_minor"),
                          ("assembled_pl.pretax", pretax, "value_minor"),
                          ("assembled_pl.net_income_statutory", filed,
                           "value_minor")))
    else:
        if refused_by_authority("tax_rate"):
            why = authority_absent["tax_rate"]
        elif pretax is not None and pretax > 0 and gap is not None:
            why = ("this book's reconstructed result of %s (pre-tax %s less "
                   "tax %s) does not reach the %s it filed in account 121, "
                   "and %s of that distance is not attributable to any line "
                   "on this statement. An effective rate of %s read off two "
                   "figures inside that build-up would be measured ACROSS "
                   "the gap rather than from the company"
                   % (fmt(reconstructed), fmt(pretax), fmt(tax), fmt(filed),
                      fmt(gap), _pct_text(ratio(tax, pretax))))
        elif pretax is not None and pretax > 0:
            why = ("this book reports a positive pre-tax result of %s but "
                   "does not carry both an income-tax charge and the net "
                   "income filed in account 121, so there is nothing to "
                   "check an effective rate against" % (fmt(pretax),))
        else:
            why = ("this book shows no positive pre-tax result to imply an "
                   "effective rate")
        steps = [_step("book", "absent", why)]
        statutory = macro.statutory_rate("profit_tax_rate", jurisdiction)
        if statutory is not None:
            rate = _micros_of(statutory.value)
            put("tax_rate", _RATIO, rate, "engine_default",
                "%s, so the statutory profit-tax rate of %s for "
                "jurisdiction %s (%s) is used instead"
                % (why, _pct4(rate), jurisdiction, statutory.source),
                tier="macro", rule_id=statutory.pack_address,
                evidence=statutory.evidence(), steps=steps)
        else:
            reason = jurisdiction_reason("statutory profit-tax rate")
            steps.append(_step("macro", "absent", reason))
            put("tax_rate", _RATIO, None, "unavailable",
                "%s, and %s, so no tax rate can be assumed and the plan is "
                "refused; supply tax_rate to project it" % (why, reason),
                tier="absent", steps=steps)

    # ── financing cost ─────────────────────────────────────────────────
    debt = opening.cents("st_debt") + opening.cents("lt_debt")
    debt_rate = ratio(history.interest_expense, debt)
    if (debt <= 0 or history.interest_expense is None
            or refused_by_authority("interest_rate_debt")):
        if refused_by_authority("interest_rate_debt"):
            why = authority_absent["interest_rate_debt"]
        elif debt <= 0:
            # THE PLAN CAN CREATE THE BALANCE THIS RATE PRICES. A
            # ``DebtSchedule`` draw is a first-class plan input, and a 0%
            # rate then carries that debt through the whole horizon free of
            # charge. Nothing is charged while the balance stays nil, and
            # ``project`` refuses at the period where it is not.
            why = ("this book carries no interest-bearing debt at the "
                   "opening date, so no borrowing rate is observable in it. "
                   "It is not taken to be 0%: a plan that draws debt would "
                   "carry it free of charge for the whole horizon. Nothing "
                   "is charged while the balance stays nil; supply "
                   "interest_rate_debt to project a plan that borrows")
        else:
            why = ("this book carries %s of interest-bearing debt at the "
                   "opening date and names no interest expense, so a "
                   "borrowing rate cannot be measured. 0%% would carry that "
                   "debt through the whole projection free of charge; supply "
                   "interest_rate_debt to project this plan" % (fmt(debt),))
        put("interest_rate_debt", _RATIO, None, "unavailable", why,
            tier="absent", steps=(_step("book", "absent", why),))
        why = ("no borrowing rate is measurable from this book (it carries "
               "no interest expense, or no interest-bearing debt at the "
               "opening date), so the funding line CANNOT be priced. A plan "
               "that draws the line is refused rather than charged 0%; "
               "supply revolver_rate to price it")
        put("revolver_rate", _RATIO, None, "unavailable", why,
            tier="absent", steps=(_step("book", "absent", why),))
    else:
        basis = ("annual rate = interest expense %s / interest-bearing debt "
                 "at the closing date %s"
                 % (fmt(history.interest_expense or 0), fmt(debt)))
        debt_from = ("assembled_pl.interest_expense",
                     "canonical_bs.rows.financial_liabilities_st",
                     "canonical_bs.rows.financial_liabilities_lt")
        evidence = book(
            ("assembled_pl.interest_expense", history.interest_expense,
             "value_minor"),
            ("canonical_bs.rows.financial_liabilities_st",
             opening.cents("st_debt"), "value_minor"),
            ("canonical_bs.rows.financial_liabilities_lt",
             opening.cents("lt_debt"), "value_minor"))
        put("interest_rate_debt", _RATIO, debt_rate, "derived", basis,
            debt_from, tier="book", rule_id="forecast.borrowing_rate",
            evidence=evidence)
        put("revolver_rate", _RATIO, debt_rate, "derived",
            "the funding line is priced at this book's own borrowing rate: "
            + basis, debt_from, tier="book", rule_id="forecast.borrowing_rate",
            evidence=evidence)

    # ── the financial lines the model cannot ROLL, so it HOLDS ─────────
    # Each is carried at the source period's own annual amount (tier
    # book), or — when the book names no such line — the convention
    # terminal rung carries none (contract 3.4: never absent).
    interest_income = history.interest_income
    if interest_income is None:
        rung = terminal_rung("interest_income_annual")
        put("interest_income_annual", _MONEY, _cents_of(rung.value),
            "engine_default", rung.sentence, tier="convention",
            rule_id=rung.rule_id, evidence=convention(rung.rule_id),
            steps=(_step("book", "absent", "assembled_pl.interest_income "
                         "is not carried by this book"),))
        why = ("this book names no interest income, so no rate on cash can "
               "be measured from it; supply interest_income_rate to earn "
               "interest on projected cash")
        put("interest_income_rate", _RATIO, None, "unavailable", why,
            tier="absent", steps=(_step("book", "absent", why),))
    else:
        cash_cents = opening.cents("cash")
        put("interest_income_annual", _MONEY, interest_income, "derived",
            "interest income is carried at this book's own annual amount "
            "of %s, HELD flat rather than grown" % (fmt(interest_income),),
            ("assembled_pl.interest_income",), tier="book",
            evidence=book(("assembled_pl.interest_income", interest_income,
                           "value_minor")))
        # DELIBERATELY not derived as a rate. The only base available is a
        # single CLOSING cash balance, and interest was earned across the
        # whole year on balances the book does not disclose.
        why = ("interest income of %s is carried at its own amount instead "
               "of as a rate: the only base this book offers is the closing "
               "cash balance of %s, which would imply %s on cash and "
               "compound onto a projected balance the company never held. "
               "Supply interest_income_rate to price interest on projected "
               "cash instead — it replaces the carried amount."
               % (fmt(interest_income), fmt(cash_cents),
                  _pct_text(ratio(interest_income, cash_cents))))
        put("interest_income_rate", _RATIO, None, "unavailable", why,
            ("assembled_pl.interest_income",), tier="absent",
            steps=(_step("book", "absent", why),))

    other_fin_income = history.other_financial_income()
    if other_fin_income is None:
        rung = terminal_rung("other_financial_income_annual")
        put("other_financial_income_annual", _MONEY, _cents_of(rung.value),
            "engine_default", rung.sentence, tier="convention",
            rule_id=rung.rule_id, evidence=convention(rung.rule_id),
            steps=(_step("book", "absent", "assembled_pl.financial_income "
                         "is not carried by this book"),))
    else:
        put("other_financial_income_annual", _MONEY, other_fin_income,
            "derived",
            "financial income other than interest on cash = financial "
            "income %s less interest income %s, HELD at that annual amount "
            "because nothing in a trial balance says foreign-exchange "
            "movement or income from holdings scales with trading"
            % (fmt(history.financial_income or 0),
               fmt(history.interest_income or 0)),
            ("assembled_pl.financial_income", "assembled_pl.interest_income"),
            tier="book", evidence=book(
                ("assembled_pl.financial_income", history.financial_income,
                 "value_minor"),
                ("assembled_pl.interest_income",
                 history.interest_income or 0, "value_minor")))

    other_fin_expense = history.other_financial_expense()
    if other_fin_expense is None:
        rung = terminal_rung("other_financial_expense_annual")
        put("other_financial_expense_annual", _MONEY, _cents_of(rung.value),
            "engine_default", rung.sentence, tier="convention",
            rule_id=rung.rule_id, evidence=convention(rung.rule_id),
            steps=(_step("book", "absent", "assembled_pl."
                         "financial_expense_total is not carried by this "
                         "book"),))
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
             "assembled_pl.interest_expense"),
            tier="book", evidence=book(
                ("assembled_pl.financial_expense_total",
                 history.financial_expense_total, "value_minor"),
                ("assembled_pl.interest_expense",
                 history.interest_expense or 0, "value_minor")))

    # ── the ones a single book cannot answer: their ladders ────────────
    # revenue_growth (3.4): book cagr -> sector -> macro pack_anchor ->
    # convention terminal rung. Never a silent zero.
    growth_steps = [_step("book", "absent", authority_absent.get(
                        "revenue_growth", _HISTORY_NOT_READ)),
                    _step("sector", "absent", _NO_SECTOR_SOURCE)]
    anchor = macro.anchor("inflation", jurisdiction)
    if anchor is not None:
        growth = _micros_of(anchor.value)
        put("revenue_growth", _RATIO, growth, "engine_default",
            "no comparable book history is loaded, so revenue grows at the "
            "%s of %s for jurisdiction %s (%s, stated as of %s): a nominal "
            "continuation at constant real volume"
            % (anchor.label.lower(), _pct4(growth), jurisdiction,
               anchor.source, anchor.stated_as_of),
            tier="macro", rule_id=anchor.pack_address,
            evidence=anchor.evidence(), steps=growth_steps)
    else:
        rung = terminal_rung("revenue_growth")
        growth_steps.append(_step("macro", "absent",
                                  jurisdiction_reason("macro anchor")))
        put("revenue_growth", _RATIO, _micros_of(rung.value),
            "engine_default", rung.sentence, tier="convention",
            rule_id=rung.rule_id, evidence=convention(rung.rule_id),
            steps=growth_steps)

    # inflation (3.4): macro pack_anchor for the jurisdiction, else the
    # convention terminal rung. It moves the FIXED part of every opex pool
    # (5.3); the same anchor is revenue_growth's macro rung above, so a
    # nominal plan grows fixed and variable costs alike at neutral volume.
    if anchor is not None:
        inflation = _micros_of(anchor.value)
        put("inflation", _RATIO, inflation, "engine_default",
            "fixed costs follow the %s of %s for jurisdiction %s (%s, "
            "stated as of %s)"
            % (anchor.label.lower(), _pct4(inflation), jurisdiction,
               anchor.source, anchor.stated_as_of),
            tier="macro", rule_id=anchor.pack_address,
            evidence=anchor.evidence())
    else:
        rung = terminal_rung("inflation")
        put("inflation", _RATIO, _micros_of(rung.value), "engine_default",
            rung.sentence, tier="convention", rule_id=rung.rule_id,
            evidence=convention(rung.rule_id),
            steps=(_step("macro", "absent",
                         jurisdiction_reason("macro anchor")),))

    rung = terminal_rung("dividend_payout_pct")
    put("dividend_payout_pct", _RATIO, _micros_of(rung.value),
        "engine_default", rung.sentence, tier="convention",
        rule_id=rung.rule_id, evidence=convention(rung.rule_id),
        steps=(_step("book", "absent", dividend_book_rung_absent()),))

    rule = min_cash_default()
    put("min_cash", _MONEY, _cents_of(rule.value), "engine_default",
        rule.sentence, tier="convention", rule_id=rule.rule_id,
        evidence=convention(rule.rule_id))

    put("days_basis", _COUNT, days_basis, "engine_default",
        "days in a year for every rate-to-period conversion",
        tier="convention", rule_id="days_basis",
        evidence=convention("days_basis"))

    missing = [key for key in KEYS if key not in derived]
    if missing:
        raise AssumptionError(
            "assumption_set", "no ladder resolved %s — a driver with no "
            "rung would ship as a silent default" % (", ".join(missing),))

    # The per-book pool drivers, after KEYS (3a.2 order): fixed shares over
    # cost_of_sales first then the served opex pools, then the opex pools'
    # levels at the neutral index rung.
    for pool in pools.pools():
        put_pool(FIXED_SHARE_PREFIX + pool.name, pool)
    for pool in pools.opex:
        put(LEVEL_PREFIX + pool.name, _RATIO, MICRO, "engine_default",
            "%s: %s" % (pool.name, index_rung.sentence), tier="convention",
            rule_id=index_rung.rule_id, evidence=convention(index_rung.rule_id))

    return _build(derived, overrides, overrides.get("debt_schedule"), pools)


def _check_pedigree(key: str, exact: Optional[int], tier: str,
                    evidence: Optional[Dict[str, Any]],
                    steps: Sequence[Dict[str, str]]) -> None:
    """The BASIS invariants of contract 3.3, enforced where a tier is set.

    book, macro and convention carry exactly their evidence object; absent
    carries no value, no evidence and at least one fallback step, and only
    a driver of the absent-legal list may end there without refusing."""
    if tier in ("book", "macro", "convention"):
        if not isinstance(evidence, dict):
            raise AssumptionError(key, "tier %s requires its evidence" % tier)
        needed = {"book": ("method", "periods_used", "inputs"),
                  "macro": ("series_id", "kind", "source", "source_url",
                            "stated_as_of", "fetched_at",
                            "series_content_digest"),
                  "convention": ("rule_id", "pack_address", "evidence")}[tier]
        lacking = [field for field in needed if field not in evidence]
        if lacking:
            raise AssumptionError(key, "tier %s evidence lacks %s"
                                  % (tier, ", ".join(lacking)))
        if exact is None:
            raise AssumptionError(key, "tier %s carries no value" % tier)
    elif tier == "absent":
        if exact is not None or evidence is not None or not steps:
            raise AssumptionError(
                key, "tier absent carries no value and no evidence, and "
                     "states at least one fallback step")
    else:
        raise AssumptionError(key, "a derivation never resolves tier %r"
                              % (tier,))
