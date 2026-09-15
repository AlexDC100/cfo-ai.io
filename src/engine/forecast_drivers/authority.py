"""WHO PUBLISHES A DRIVER. One concept, one owner, one formula.

THE DEFECT THIS FILE EXISTS TO CLOSE
====================================
Two packages independently derived forecast drivers from the same book
and published them under overlapping names:

  * ``engine.forecast_drivers`` (this package) — the assumption set: a
    versioned pack, named external anchors, a three-way status in which
    ABSENT is a real state, three cases, and a type that cannot emit a
    number without the derivation that produced it;
  * ``engine.forecast.assumptions`` — the projection model's own input
    shape: integer cents, micro-rates, a calendar, a cash floor.

Both read the same served payload. Measured on the committed books, they
disagreed on ``revenue_growth``, ``depreciation_rate``, the gross-margin
/ cost-of-sales share, and capital intensity — and on several of those
BOTH stamped their answer ``derived``, so a reader could be shown two
measured rates for one policy with nothing saying which was which.

THE RESOLUTION
==============
``engine.forecast_drivers`` owns every concept that describes the
COMPANY: anything measured from its book, or defaulted from a named
external anchor when its book cannot answer.

``engine.forecast.assumptions`` owns the concepts that describe the
PROJECTION and not the company: the days basis, the cash floor below
which the funding line draws, the debt schedule. (The horizon is not a
driver at all since plan/2 B2: ``total_years`` and ``monthly_months`` are
request fields ``project()`` takes as arguments, so no concept rules on
them.)

The mechanism is the model's own override channel:
``derive_assumptions(opening, history, **overrides)`` already re-stamps
any keyword it is handed as ``source="caller"``. :func:`model_overrides`
turns one of this package's assumption sets into exactly that mapping,
so the wiring caller hands the model a company it has already measured
instead of asking it to measure one again.

WHY THE MODEL'S KEYS ARE NAMED HERE AND NOT IMPORTED
====================================================
This module names the model's keys as DATA rather than importing
``engine.forecast.assumptions``: an import would point the dependency
the wrong way round, since the model is meant to consume this package
and not the reverse. A declaration is only worth something if something
proves it still matches, so ``tests/engine/test_forecast_drivers.py``
asserts every key named here against the model's real ``KEYS`` and
against its real behaviour on the committed books. This is the same
convention the model itself already uses for the serving contract's
units.

The registry deliberately does NOT enumerate the model's whole key list.
The model may hold keys nobody has ruled on; a stated default on its
side is not a second authority and must not red a gate. What must red is
an unruled key that starts carrying a value MEASURED FROM THE BOOK,
because that is the moment a second authority exists again — and that is
what the gate checks, on real books, rather than on a list.

ONE DERIVATION (plan/2 B3, contract 4)
======================================
Since B3 every shared concept this package publishes is READ from
``engine.forecast``'s own resolution of the same payload (see
``derive.EngineResolution``), so the value that crosses back is the
model's own integer. What crosses therefore carries it UNROUNDED — the
exact micros or micro-days, with the engine's tier, rule id, evidence and
fallback steps — and a hand-over never demotes a book or convention value
to a caller's. ``round_dp`` is a display rounding of this package and
never reaches the model.

An ABSENT concept crosses as an explicit :class:`AbsentHandover` naming
its reason. The model's channel used to DROP a ``None`` and fill the key
from its own default while looking like a hand-over; that check is gone
and a ``None`` is refused. The model takes the absent hand-over as its
book rung refused for the stated reason and continues its ladder (tax
falls to the statutory rate, an absent-legal driver stays absent).

No I/O, no network, no clock. Python 3.9 — no `match`, no `X | Y`.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Sequence, Tuple

__all__ = [
    "AbsentHandover",
    "OWNER_DRIVERS",
    "OWNER_MODEL",
    "STATUSES_OF_CONCEPT",
    "Concept",
    "CONCEPTS",
    "SuppliedValue",
    "RULED_MODEL_KEYS",
    "concept_for_model_key",
    "model_overrides",
    "handover_basis",
    "unrepresentable",
    "blocked_model_keys",
    "model_owned_keys",
    "AuthorityError",
]


class AuthorityError(RuntimeError):
    """A concept could not be routed to exactly one authority."""


class SuppliedValue(float):
    """A number that carries the reason it is that number.

    The crossing used to be a bare ``float``. The model re-stamps
    anything handed to it ``source="caller"``, ``basis="supplied by the
    caller"``, ``derived_from=()`` — so the measurement, the periods and
    the arithmetic behind every crossed driver were deleted ON THE WAY TO
    THE READER, and 10 of 21 drivers reached the wire on the committed
    books saying nothing about where they came from. A projected figure
    that resolves to "supplied by the caller" resolves to nothing, which
    is the one thing this whole package exists to prevent.

    It is a REAL float, deliberately: ``engine.forecast``'s
    ``_exact_fraction`` reads it through ``isinstance(value, float)`` and
    ``str()``, so every arithmetic path, every coercion and every
    serialization behaves exactly as it did before this type existed. A
    consumer that ignores the two extra attributes loses nothing it had;
    a consumer that reads them gains the pedigree. That is what makes the
    receiving change a one-liner instead of a new channel.

    ``pedigree``         the full record, the SAME dict
                         :func:`handover_basis` publishes under this model
                         key. One concept, one value, one reason, whichever
                         of the two routes a consumer took.
    ``pedigree_basis``   this package's own basis sentence for the driver.
    ``pedigree_from``    the served field paths it was measured from.
    ``pedigree_status``  ``derived`` or ``fallback`` — a fallback that
                         crosses restamped as a measurement is the same
                         defect wearing a smaller number.
    """

    __slots__ = ("pedigree",)

    def __new__(cls, value, pedigree):
        # type: (float, Dict[str, Any]) -> "SuppliedValue"
        self = float.__new__(cls, value)
        self.pedigree = pedigree
        return self

    @property
    def pedigree_basis(self):
        # type: () -> str
        """The sentence for the MODEL's key — translated where the two
        names hold different quantities. This is the one a consumer
        stamping the model's assumption must use."""
        return str(self.pedigree.get("basis_for_model_key") or "")

    @property
    def pedigree_from(self):
        # type: () -> Tuple[str, ...]
        return tuple(str(x) for x in (self.pedigree.get("authority") or ()))

    @property
    def pedigree_status(self):
        # type: () -> str
        return str(self.pedigree.get("status") or "")

    @property
    def pedigree_driver_key(self):
        # type: () -> str
        return str(self.pedigree.get("driver_key") or "")

    #: NO ``__repr__`` / ``__str__`` OVERRIDE, and this is not an
    #: oversight. ``engine.forecast.money._exact_fraction`` turns a float
    #: into an exact rational with ``Fraction(str(value))``. A friendlier
    #: repr was written here first and every crossed driver died with
    #: ``ValueError: Invalid literal for Fraction:
    #: 'SuppliedValue(0.025, fallback, revenue_growth)'`` — because
    #: ``float`` takes ``__str__`` from ``__repr__``. The whole point of
    #: this type is that it is indistinguishable from a float to every
    #: consumer that does not ask for the pedigree, and its text is part
    #: of that. `test_hx6` pins it.


class AbsentHandover(object):
    """An ABSENT driver, crossing as an explicit object (contract 4).

    Never a number and never ``None``: ``engine.forecast.assumptions``
    recognises ``is_absent_handover`` and takes the book rung of the model
    key as refused for ``reason``."""

    __slots__ = ("pedigree",)

    is_absent_handover = True

    def __init__(self, pedigree):
        # type: (Dict[str, Any]) -> None
        self.pedigree = pedigree

    @property
    def reason(self):
        # type: () -> str
        return str(self.pedigree.get("basis") or "")

    def __repr__(self):  # pragma: no cover - debugging aid
        return "AbsentHandover(%s)" % (self.pedigree.get("model_key"),)


#: The two publishers. A concept names exactly one of them.
OWNER_DRIVERS = "engine.forecast_drivers"
OWNER_MODEL = "engine.forecast.assumptions"

#: ``supplied``   this package publishes it and the model consumes it
#:               through the override channel; the two carry one value.
#: ``blocked``    this package publishes a value, but the model's key of
#:               the same name means something measurably different, so
#:               handing it over would change a figure the model
#:               currently reproduces from the book. The entry names the
#:               difference and the change that would close it.
#: ``model_only`` a property of the projection, not of the company. The
#:               model owns it outright and this package must never
#:               publish one.
STATUSES_OF_CONCEPT = ("supplied", "blocked", "model_only")


# ──────────────────────────────────────────────────────────────────────
# translations — declared, never implicit
# ──────────────────────────────────────────────────────────────────────

def _identity(value):
    # type: (float) -> float
    return value


def _complement(value):
    # type: (float) -> float
    """A share of revenue read off its complement.

    The engine publishes a gross MARGIN; the model wants the cost-of-
    sales SHARE. They are the same statement about one company written
    two ways, and writing it once here is the point of the file.
    """
    return 1.0 - value


#: name -> (callable, the sentence a surface may print for it).
TRANSLATIONS = {
    "identity": (_identity, "the same quantity under the model's name"),
    "complement": (_complement,
                   "one minus the published margin, which is the cost "
                   "share of the same revenue"),
}


class Concept(object):
    """One economic concept, its single owner, and how it crosses over."""

    __slots__ = ("concept_id", "owner", "status", "driver_key", "model_keys",
                 "translation", "why")

    def __init__(self, concept_id, owner, status, driver_key, model_keys,
                 translation, why):
        # type: (str, str, str, Optional[str], Sequence[str], Optional[str], str) -> None
        if owner not in (OWNER_DRIVERS, OWNER_MODEL):
            raise AuthorityError("unknown owner %r" % (owner,))
        if status not in STATUSES_OF_CONCEPT:
            raise AuthorityError("unknown status %r" % (status,))
        if translation is not None and translation not in TRANSLATIONS:
            raise AuthorityError("unknown translation %r" % (translation,))
        if not why:
            raise AuthorityError(
                "concept %r has no stated reason. An ownership ruling with "
                "no argument behind it is the same silence that let two "
                "authorities exist." % (concept_id,))
        if status == "model_only":
            if owner != OWNER_MODEL or driver_key is not None:
                raise AuthorityError(
                    "concept %r is model_only, so it cannot also be "
                    "published here" % (concept_id,))
        else:
            if owner != OWNER_DRIVERS or not driver_key:
                raise AuthorityError(
                    "concept %r is owned by this package, so it needs the "
                    "driver key it is published under" % (concept_id,))
        self.concept_id = str(concept_id)
        self.owner = str(owner)
        self.status = str(status)
        self.driver_key = driver_key
        self.model_keys = tuple(str(k) for k in model_keys)
        self.translation = translation
        self.why = " ".join(str(why).split())

    def convert(self, value):
        # type: (Optional[float]) -> Optional[float]
        """This package's value in the model's terms. None stays None —
        ABSENT is not a number and must not become one here."""
        if value is None:
            return None
        if self.translation is None:
            raise AuthorityError(
                "concept %r has no declared translation" % (self.concept_id,))
        return TRANSLATIONS[self.translation][0](float(value))

    def convert_exact(self, exact, unit):
        # type: (Optional[int], str) -> Optional[int]
        """The exact integer in the model's terms (plan/2 B3). None stays
        None; the complement of a share is taken in micros, exactly."""
        if exact is None:
            return None
        if self.translation == "identity":
            return int(exact)
        if self.translation == "complement" and unit == "rate":
            return 1000000 - int(exact)
        raise AuthorityError("concept %r cannot translate an exact %s"
                             % (self.concept_id, unit))

    def as_dict(self):
        # type: () -> Dict[str, Any]
        return {
            "concept_id": self.concept_id,
            "owner": self.owner,
            "status": self.status,
            "driver_key": self.driver_key,
            "model_keys": list(self.model_keys),
            "translation": self.translation,
            "why": self.why,
        }


# ──────────────────────────────────────────────────────────────────────
# THE REGISTRY
# ──────────────────────────────────────────────────────────────────────

CONCEPTS = (
    Concept(
        "revenue_growth", OWNER_DRIVERS, "supplied",
        "revenue_growth", ("revenue_growth",), "identity",
        """A book with one period has no measurable rate of change. This
        package says so and falls to a named external anchor, stamped
        fallback; the model asserted 0.0% instead, which is not silence
        but a claim that the company's prices fall in real terms every
        projected year. One concept cannot carry both answers."""),
    Concept(
        "cost_of_sales_share", OWNER_DRIVERS, "supplied",
        "gross_margin", ("cogs_pct_of_revenue",), "complement",
        """The engine already publishes a gross margin through its
        methodology pack, and the rest of the product prints it. The
        model recomputed the cost share from a different cost field, so
        the projection's cost structure and the printed margin were two
        different statements about one company."""),
    Concept(
        "operating_cost_share", OWNER_DRIVERS, "supplied",
        "opex_rate", ("opex_pct_of_revenue",), "identity",
        """This package had a growth RATE for operating cost but no
        LEVEL, so the model had to measure the level itself. The level
        driver now exists here and the model consumes it; without it the
        two packages would go on reading the same field separately, one
        renaming away from disagreeing."""),
    Concept(
        "days_sales_outstanding", OWNER_DRIVERS, "supplied",
        "dso", ("dso_days",), "identity",
        """engine.forecast's formula forecast.dso is the authority (plan/2
        contract 4): receivables over revenue, in micro-days. This package
        reads it and crosses the same integer back."""),
    Concept(
        "days_inventory_outstanding", OWNER_DRIVERS, "supplied",
        "dio", ("dio_cogs_days",), "identity",
        """Days of COST OF SALES, formula forecast.dio_cogs (R8). The ratio
        table divides inventory by total operating expense and is quoted
        beside it, never served under this name. On a book with no cost of
        sales the driver is ABSENT on both sides and inventory is HELD."""),
    Concept(
        "days_payable_outstanding", OWNER_DRIVERS, "supplied",
        "dpo", ("dpo_cogs_days",), "identity",
        """As days_inventory_outstanding, over cost of sales
        (forecast.dpo_cogs), on the same trade-payables operand the ratio
        table uses."""),
    Concept(
        "capital_intensity", OWNER_DRIVERS, "supplied",
        "capex_rate", ("capex_pct_of_revenue",), "identity",
        """Both sides use a depreciation proxy for capital spend, and
        both say so — but from different depreciation fields, so they
        disagreed on real books. The engine's published capex intensity
        wins because it is the number the report already carries, and it
        arrives with the methodology pack's own note that it is a proxy
        pending real period-over-period asset movements."""),
    Concept(
        "effective_tax_rate", OWNER_DRIVERS, "supplied",
        "tax_rate", ("tax_rate",), "identity",
        """The effective rate this book paid, not the statutory headline.
        It crosses ONLY when a class-69 account stands behind the charge
        AND the build-up it sits in reaches the net income filed in
        account 121 — the sum of an empty set is an absence, and a rate
        divided out of a build-up that does not tie is measured across
        the gap. On all four committed books one or both fail, so nothing
        crosses and the model states the statutory rate under its own
        name. Before this was true, retail crossed a 0.0000% stamped
        `derived` over that stated default, the five-year plan paid no
        tax, and the served driver carried NEITHER party's reason. The
        substitution survives because an absent driver cannot cross the
        override channel at all — see unrepresentable()."""),
    Concept(
        "borrowing_rate", OWNER_DRIVERS, "supplied",
        "interest_rate", ("interest_rate_debt", "revolver_rate"), "identity",
        """One measured cost of debt reaches the model twice: as the rate
        on existing borrowings and as the price of the funding line. The
        model already derived them from one figure; this keeps that, with
        the figure owned in one place."""),
    Concept(
        "dividend_policy", OWNER_DRIVERS, "supplied",
        "dividend_payout", ("dividend_payout_pct",), "identity",
        """A declared distribution leaves a balance on dividends payable
        or profit distribution; nothing else is evidence, and the cash
        flow statement's own dividends line is an inference from market
        averages. On every committed book this package is ABSENT and the
        model defaults to 0.0%, which reads as a measured policy of
        paying nothing. See unrepresentable()."""),

    # ── was blocked until plan/2 B3; closed by renaming ───────────────
    Concept(
        "depreciation_rate", OWNER_DRIVERS, "supplied",
        "depreciation_rate", ("depreciation_rate",), "identity",
        """The run-off rate over closing NET BOOK VALUE, engine.forecast's
        rule (plan/2 contract 4, R17): the anchor's charge over its
        closing property, plant, equipment and intangibles, which
        reproduces the anchor's own charge in plan year one. It was
        BLOCKED while this package published the gross-base policy rate
        under the same name; that quantity is now
        depreciation_share_of_gross_depreciable_base, never crosses, and
        this package publishes the engine's rate under this one — two
        numbers with two names."""),

    # ── the projection's own mechanics ───────────────────────────────
    Concept(
        "capitalised_intangible_programme", OWNER_MODEL, "model_only",
        None, ("intangible_additions_pct_of_revenue",), None,
        """Not observable in a trial balance and not defaulted from one:
        the model holds it at nil and says so. Nothing here measures
        it, so there is nothing to disagree with."""),
    Concept(
        "interest_income_rate", OWNER_MODEL, "model_only",
        None, ("interest_income_rate",), None,
        """Interest earned on projected operating cash is a property of
        the projection's own cash path, not of the book."""),
    Concept(
        "cash_floor", OWNER_MODEL, "model_only",
        None, ("min_cash",), None,
        """The balance below which the funding line draws. A modelling
        choice about the plan, not a measurement of the company."""),
    Concept(
        "days_basis", OWNER_MODEL, "model_only",
        None, ("days_basis",), None,
        """The day count every rate-to-period conversion uses. An
        arithmetic convention of the model."""),
)


def _index():
    # type: () -> Dict[str, Concept]
    out = {}  # type: Dict[str, Concept]
    for concept in CONCEPTS:
        for key in concept.model_keys:
            if key in out:
                raise AuthorityError(
                    "model key %r is claimed by two concepts, %r and %r — "
                    "which is the very shape this registry exists to make "
                    "impossible" % (key, out[key].concept_id,
                                    concept.concept_id))
            out[key] = concept
    return out


_BY_MODEL_KEY = _index()

#: Every model key this registry has ruled on, in registry order. It is
#: DERIVED from CONCEPTS rather than typed a second time — a registry
#: whose own key list could disagree with its own entries would be the
#: defect it was written to close.
#:
#: It is deliberately NOT the model's whole key list. The model may hold
#: keys nobody has ruled on yet; the gate's rule is that an unruled key
#: must never carry a value MEASURED FROM THE BOOK, because that is the
#: moment it becomes a second authority. Adding a stated default on the
#: model side is not a divergence and must not red.
RULED_MODEL_KEYS = tuple(
    key for concept in CONCEPTS for key in concept.model_keys)


def concept_for_model_key(model_key):
    # type: (str) -> Optional[Concept]
    return _BY_MODEL_KEY.get(model_key)


def model_owned_keys():
    # type: () -> Tuple[str, ...]
    """Keys the model owns outright, in the registry's order."""
    return tuple(k for k in RULED_MODEL_KEYS
                 if _BY_MODEL_KEY[k].status == "model_only")


def blocked_model_keys():
    # type: () -> Tuple[str, ...]
    """Keys the model must still measure for itself, because this
    package's value under the same name is a different quantity."""
    return tuple(k for k in RULED_MODEL_KEYS
                 if _BY_MODEL_KEY[k].status == "blocked")


# ──────────────────────────────────────────────────────────────────────
# crossing over
# ──────────────────────────────────────────────────────────────────────

def model_overrides(assumption_set):
    # type: (Any) -> Dict[str, Any]
    """This package's drivers in the model's keyword shape.

    Hand the result to ``engine.forecast.derive_assumptions`` (or
    ``project_payload``) and every company concept the model would
    otherwise re-measure arrives already measured, stamped
    ``source="caller"``.

    An ABSENT driver crosses as an explicit :class:`AbsentHandover` naming
    its reason (plan/2 B3, contract 4) — never a number, never ``None``.

    Every value is a :class:`SuppliedValue` — a real float carrying this
    package's own basis, status and served field paths, so the pedigree
    travels WITH the number through the same keyword channel rather than
    beside it in a second dict a caller can forget to render.
    :func:`handover_basis` remains the keyed-by-model-key view of exactly
    the same strings, for a surface that wants the map.
    """
    out = {}  # type: Dict[str, Any]
    for concept in CONCEPTS:
        if concept.status != "supplied":
            continue
        driver = assumption_set.driver(concept.driver_key)
        if driver is None:
            continue
        if driver.value is None:
            for model_key in concept.model_keys:
                out[model_key] = AbsentHandover(
                    _pedigree(concept, driver, model_key))
            continue
        converted = concept.convert(driver.value)
        for model_key in concept.model_keys:
            out[model_key] = SuppliedValue(
                converted, _pedigree(concept, driver, model_key))
    return out


def _pedigree(concept, driver, model_key):
    # type: (Concept, Any, str) -> Dict[str, Any]
    """The record that must travel with a crossed number.

    ONE builder, used by both routes — :func:`model_overrides` attaches
    it to the value, :func:`handover_basis` publishes it as a map. Two
    builders would be the same defect this file exists to end, one level
    down: a surface reading the map and a surface reading the value could
    print two different reasons for one number.

    ``basis`` is this package's own sentence about its own driver, and is
    always exactly that. ``basis_for_model_key`` is the sentence a reader
    holding the MODEL's key may be shown — the same thing when the
    translation is the identity, and the translated statement when it is
    not. The two are separate fields on purpose: `gross_margin` 0.396283
    crosses to `cogs_pct_of_revenue` 0.603717, and printing "the engine's
    own gross margin" beside 0.603717 is precisely the unattributed
    figure this file exists to end.
    """
    basis = driver.basis
    if concept.translation is not None and concept.translation != "identity":
        basis = "%s Under the model's name %s this is %s." % (
            driver.basis, model_key, TRANSLATIONS[concept.translation][1])
    exact = concept.convert_exact(getattr(driver, "exact", None), driver.unit)
    return {
        # plan/2 B3 (contract 4): the unrounded integer and its unit, and
        # the tier pedigree, so the crossing never rounds and never demotes.
        "exact": exact,
        "exact_unit": (None if exact is None
                       else {"rate": "micros", "days": "micro_days"}
                       [driver.unit]),
        "tier": _tier_of(driver),
        "rule_id": getattr(driver, "rule_id", None),
        "evidence": _evidence_of(driver),
        "fallback_steps": [dict(step) for step in
                           (getattr(driver, "fallback_steps", ()) or ())],
        "concept_id": concept.concept_id,
        "driver_key": driver.key,
        "model_key": model_key,
        "label": driver.label,
        "status": driver.status,
        "basis": driver.basis,
        "basis_for_model_key": basis,
        "translation": concept.translation,
        "translation_note": TRANSLATIONS[concept.translation][1],
        "periods_used": list(driver.derivation.periods_used),
        "authority": [i.authority for i in driver.derivation.inputs],
    }


def _tier_of(driver):
    # type: (Any) -> str
    """The tier a crossing driver carries: the engine's own, when the
    concept was read from it; otherwise this package's status in the
    contract 3.4 vocabulary (derived -> book, fallback -> convention,
    absent -> absent)."""
    tier = getattr(driver, "tier", None)
    if tier:
        return str(tier)
    return {"derived": "book", "fallback": "convention",
            "absent": "absent"}[driver.status]


def _evidence_of(driver):
    # type: (Any) -> Any
    """The evidence object the tier requires (contract 3.3)."""
    evidence = getattr(driver, "evidence", None)
    if evidence is not None or getattr(driver, "tier", None):
        return evidence
    derivation = driver.derivation
    if driver.status == "derived":
        method = "cagr" if derivation.method in ("cagr", "yoy") else "level"
        inputs = []
        for item in derivation.inputs:
            field = ("value_minor"
                     if item.authority.startswith(("assembled_pl",
                                                   "canonical_bs"))
                     else "value_micros")
            scale = 100 if field == "value_minor" else 1000000
            inputs.append({"fact": item.name, "period_end": item.period,
                           field: (None if item.value is None
                                   else int(round(item.value * scale))),
                           "authority": item.authority})
        return {"method": method,
                "periods_used": list(derivation.periods_used),
                "inputs": inputs}
    if driver.status == "fallback":
        return {"rule_id": derivation.source, "pack_address": None,
                "evidence": []}
    return None


def handover_basis(assumption_set):
    # type: (Any) -> Dict[str, Dict[str, Any]]
    """The pedigree that must travel WITH :func:`model_overrides`.

    The model re-stamps anything handed to it ``source="caller"`` with
    the basis ``"supplied by the caller"`` — correct from where it sits,
    and a total loss of provenance from where the reader sits. Two of the
    values crossing are ``fallback``, one of them carrying the engine's
    own written warning that it is a proxy; rendered as "supplied by the
    caller" they read as somebody's typed-in guess, which is worse than
    either truth.

    So a surface that consumes the overrides must render THIS beside the
    number instead. Keyed by the model's key, because that is the name
    the surface will have in its hand.
    """
    out = {}  # type: Dict[str, Dict[str, Any]]
    for concept in CONCEPTS:
        if concept.status != "supplied":
            continue
        driver = assumption_set.driver(concept.driver_key)
        if driver is None:
            continue
        for model_key in concept.model_keys:
            out[model_key] = _pedigree(concept, driver, model_key)
    return out


def unrepresentable(assumption_set):
    # type: (Any) -> Tuple[Dict[str, Any], ...]
    """Concepts this package says are ABSENT, named with their reason.

    Until plan/2 B3 the model's shape could not be told about these at
    all. They now cross as :class:`AbsentHandover` objects; this view
    stays so a surface can print each refusal beside whatever rung the
    model's ladder then took.
    """
    out = []  # type: List[Dict[str, Any]]
    for concept in CONCEPTS:
        if concept.status != "supplied":
            continue
        driver = assumption_set.driver(concept.driver_key)
        if driver is None or driver.value is not None:
            continue
        out.append({
            "concept_id": concept.concept_id,
            "driver_key": concept.driver_key,
            "model_keys": list(concept.model_keys),
            "status": driver.status,
            "basis": driver.basis,
        })
    return tuple(out)
