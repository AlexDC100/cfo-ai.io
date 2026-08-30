"""SINGLE-PERIOD DETECTORS — the shared plumbing.

Every detector in this package answers ONE question about ONE period and
returns either a :class:`engine.api._finding.Finding` carrying all seven
contract elements, or a :class:`engine.api._finding.CheckRecord` saying
what it looked at and why it stayed quiet. There is no third outcome:
a detector that "noticed something" without being able to quantify it
records a check, it does not narrate.

WHAT LIVES HERE
    Reader          the ONE typed reader of a period's canonical views.
                    Returns ``None`` for a value that is not present —
                    never 0.0. ABSENT != ZERO is enforced at the read,
                    so no detector can accidentally compare a hole.
    Ctx             profile + reader + provenance, handed to a detector.
    Bag             an insertion-ordered evidence accumulator that keeps
                    ``facts_cited`` and ``Evidence.figures`` in lockstep,
                    which is what the contract's evidence check verifies.
    share/quotient  every division in this package, routed through
                    ``_ratio_units`` (F5). There is no bare ``a / b`` in
                    any detector module; the guard test proves it.
    build_finding   assembles the Finding with the profile-derived
                    WHY-HERE and CONFIDENCE, so a detector cannot author
                    a company-agnostic rationale by hand.

THREE CONSTRAINTS THAT SHAPE EVERY DETECTOR HERE

1. **A printed money figure must be a fact `_ratio_units` declares as
   money.** ``templatize`` only lifts declared money names into
   ``{{money:…}}``; anything else is left as digits beside a raw
   currency word, and ``Finding.render`` then refuses with
   ``OrphanCurrencyLabelError`` (the generalised Critical-461 defect).
   So a detector may only CITE money it can name — see
   ``_ratio_units._MONEY_FACTS``. Where the natural money figure has no
   declared name (input cost, for one), the detector cites declared
   money anchors and expresses the observation as a share. It never
   prints an undeclared money number.

2. **A money THRESHOLD limit is unprintable for the same reason** — a
   table value like "RON 1,000,000" is nobody's cited fact, so it can
   never bind. :func:`normalised_threshold` therefore expresses an
   absolute money floor as a dimensionless MULTIPLE of itself (observed
   ``39.19×`` against a limit of ``1.00×``), which prints cleanly, keeps
   the comparison mathematically identical, and carries the floor's
   exact currency amount on the payload in
   ``ComparisonBasis.basis_value``. A ZERO money floor is handled by
   comparing the same quantity as a share instead — zero is scale-free.

3. **Pick the band that actually fired.** ``Threshold.holds()`` is
   re-checked by the validator, and a finding whose stated rule did not
   fire is demoted. :func:`fired_band` walks a detector's bands from the
   strictest down and returns the one that genuinely holds.

BOUNDARY NOTE
The canonical sub-views are bound to short locals in ``Reader.__init__``
before any ``total_*`` key is read, for the reason
``_company_profile.py`` documents: ``scripts/check_import_boundary.py``
flags a ``total_*`` read off an expression that still spells
"assembled", and it is right to. Detectors here read shares of totals to
JUDGE a period; they never serve a total to a user.

Python 3.9 — no `match`, no `X | Y` unions.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

from .. import _company_profile as CP
from .. import _finding as F
from .. import _ratio_units

#: Views a :class:`Reader` exposes, in the order ``value()`` searches when
#: a detector does not name one. Explicit-view reads are preferred; the
#: search order exists so a legacy-shaped period still answers.
VIEW_ORDER = ("bs", "pl", "cf", "sub", "legacy_bs", "legacy_pl")


class DetectorInputError(ValueError):
    """A detector asked the reader for something structurally impossible
    (an unknown view). Never raised for a MISSING value — that is
    ``None``, which is an answer."""


# ── The reader ───────────────────────────────────────────────────────────


class Reader(object):
    """The period's own canonical views, read honestly.

    Every accessor returns ``Optional[float]``: ``None`` means the field
    is not in this period's views at all. A detector that treats ``None``
    as zero is a bug — and it is a bug the type makes visible, because
    ``None`` propagates through :func:`share` and
    :func:`ratio_impact_or_none` rather than silently becoming a
    comparison against a hole.
    """

    def __init__(self, statements: Optional[Dict[str, Any]]) -> None:
        stmts = dict(statements or {})
        # Short locals BEFORE any total_* read — see BOUNDARY NOTE.
        bs = dict(stmts.get("assembled_bs") or {})
        pl = dict(stmts.get("assembled_pl") or {})
        cf = dict(stmts.get("assembled_cf") or {})
        sub = dict(stmts.get("subAggregates") or {})
        legacy_bs = dict(stmts.get("balanceSheet") or {})
        legacy_pl = dict(stmts.get("incomeStatement") or {})
        self._views = {
            "bs": bs, "pl": pl, "cf": cf, "sub": sub,
            "legacy_bs": legacy_bs, "legacy_pl": legacy_pl,
        }
        self._supplementary = dict(stmts.get("supplementary") or {})
        self.currency = str(stmts.get("currency") or "RON").upper()

    # -- raw reads -------------------------------------------------------

    def view(self, name: str, key: str) -> Optional[float]:
        """One named view, one key. ``None`` when absent or non-numeric."""
        if name not in self._views:
            raise DetectorInputError(
                "unknown canonical view %r (have %r)" % (name, VIEW_ORDER))
        return _num(self._views[name].get(key))

    def value(self, *keys: str) -> Optional[float]:
        """First numeric hit for any of `keys`, searching the views in
        :data:`VIEW_ORDER`. Used only for keys that are unambiguous
        across views."""
        for key in keys:
            for view_name in VIEW_ORDER:
                found = _num(self._views[view_name].get(key))
                if found is not None:
                    return found
        return None

    def period_days(self) -> Optional[float]:
        """Days in the period. Deliberately NOT defaulted to 365: a
        quarter narrated as a year would treble every day-count metric,
        and inventing the denominator is exactly the fabrication this
        package refuses. Absent means the day-based detectors stay
        quiet."""
        days = _num(self._supplementary.get("periodDays"))
        if days is None or days <= 0:
            return None
        return days

    # -- typed quantities ------------------------------------------------

    def q(self, value: float, name: str) -> _ratio_units.Quantity:
        """An ad-hoc money quantity in the period's currency — for the
        ADJUSTED side of a recomputed ratio, which is a derived number
        rather than a read fact."""
        return _ratio_units.money(float(value), self.currency, name=name)


def _num(raw: Any) -> Optional[float]:
    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        return None
    value = float(raw)
    if value != value or value in (float("inf"), float("-inf")):
        return None
    return value


# ── Ratio helpers — the ONLY arithmetic detectors are allowed ────────────


def quotient(numerator: Optional[_ratio_units.Quantity],
             denominator: Optional[_ratio_units.Quantity]) -> Optional[float]:
    """`numerator / denominator` through the unit law. ``None`` when
    either operand is absent or the denominator is zero — an undefined
    ratio is not a zero one."""
    if numerator is None or denominator is None:
        return None
    return _ratio_units.safe_ratio(numerator, denominator)


def share(reader: Reader, part: Optional[float],
          whole: Optional[float], part_name: str = "part",
          whole_name: str = "whole") -> Optional[float]:
    """A share of a same-currency total, 0..1."""
    if part is None or whole is None:
        return None
    return quotient(reader.q(part, part_name), reader.q(whole, whole_name))


def per_day(amount: Optional[float], days: Optional[float]) -> Optional[float]:
    """An amount spread over the period's length — money per day.

    Not a ratio (the operands have different dimensions), which is why it
    lives here in ONE place rather than as a bare ``/`` inside a
    detector: the guard test asserts no detector module contains a
    division operator at all, so every quotient in this package is either
    a unit-law ratio or this one documented conversion.

    ``days`` is the period's DECLARED length. It is never defaulted — a
    quarter divided as if it were a year treble-counts every day metric.
    """
    if amount is None or not days:
        return None
    return float(amount) / float(days)


# ── Evidence accumulation ────────────────────────────────────────────────


class Bag(object):
    """Cited figures and ``facts_cited``, kept in lockstep and in
    insertion order.

    Order matters twice: ``templatize`` binds a printed token to the
    FIRST cited money fact whose formatted value matches it, and the
    rendered body lists figures in the order they were added. Both are
    deterministic because a dict preserves insertion order — the same
    period always produces the same bytes.
    """

    def __init__(self) -> None:
        self.facts = {}  # type: Dict[str, float]
        self.figures = []  # type: List[F.Figure]

    def money(self, fact: str, value: float, label: str) -> "Bag":
        """Cite a money figure. Refuses an undeclared name, and does not
        PRINT a second figure that carries a value already printed.

        The second rule is subtle and was found by the placeholder gate
        on a real fixture. ``templatize`` binds a printed token to the
        first cited money fact whose formatted value matches it, so two
        facts holding the same amount — EEI's capex outflow and the
        construction spend inside it are byte-identical — both bind to
        the FIRST one. The rendered prose is still numerically right and
        still converts correctly, but the template then cites one fact
        twice and never mentions the other, which is a lie about where
        the number came from.

        Rather than let that happen quietly, the duplicate is kept as a
        fact on the payload and left out of the printed figures. The
        finding loses a sentence it did not need (the share that
        accompanies it already says the two are equal) and keeps a
        template that names exactly the facts it prints.
        """
        if _ratio_units.unit_for_fact(fact) != _ratio_units.UNIT_MONEY:
            raise DetectorInputError(
                "%r is not declared money in _ratio_units, so a printed "
                "figure under that name could never templatize — cite a "
                "declared money fact or express the observation as a share"
                % fact)
        amount = float(value)
        for existing in self.figures:
            if existing.unit == F.UNIT_MONEY and existing.value == amount:
                return self.fact_only(fact, amount)
        return self._add(fact, amount, F.UNIT_MONEY, label)

    def percent(self, fact: str, value: float, label: str) -> "Bag":
        return self._add(fact, float(value), F.UNIT_PERCENT, label)

    def ratio(self, fact: str, value: float, label: str) -> "Bag":
        return self._add(fact, float(value), F.UNIT_RATIO, label)

    def fact_only(self, fact: str, value: float) -> "Bag":
        """A fact the payload should carry but the prose does not print."""
        self.facts[fact] = float(value)
        return self

    def _add(self, fact: str, value: float, unit: str, label: str) -> "Bag":
        declared = _ratio_units.unit_for_fact(fact)
        if declared != _ratio_units.UNIT_UNKNOWN and declared != unit:
            raise DetectorInputError(
                "fact %r is declared %s in _ratio_units but is being cited "
                "as %s" % (fact, declared, unit))
        self.facts[fact] = value
        self.figures.append(F.Figure(fact, value, unit, label))
        return self


# ── Thresholds ───────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Band:
    """One threshold band of a detector: the parameter that judges the
    company, and the severity that band carries when it fires."""

    parameter: str
    severity: str


def fired_band(profile: "CP.CompanyProfile", detector_id: str,
               bands: Sequence[Band], observed: float,
               comparator: str) -> Optional[Tuple[Band, CP.ThresholdSpec]]:
    """The STRICTEST band that genuinely holds, or ``None``.

    Bands are supplied strictest-first. Returning a band whose comparison
    does not hold would produce a finding the contract demotes with "the
    rule did not actually fire" — so the selection happens here once,
    rather than being asserted per detector.
    """
    for band in bands:
        spec = profile.threshold(detector_id, band.parameter)
        if _holds(comparator, observed, spec.value):
            return (band, spec)
    return None


def _holds(comparator: str, observed: float, limit: float) -> bool:
    if comparator == ">":
        return observed > limit
    if comparator == ">=":
        return observed >= limit
    if comparator == "<":
        return observed < limit
    if comparator == "<=":
        return observed <= limit
    if comparator == "!=":
        return observed != limit
    raise DetectorInputError("unknown comparator %r" % comparator)


def threshold(spec: "CP.ThresholdSpec", comparator: str, observed: float,
              unit: str) -> F.Threshold:
    """A :class:`Threshold` built from a catalogue spec. `unit` is passed
    explicitly because a detector may legitimately compare the table's
    number in a normalised form (see :func:`normalised_threshold`); the
    LIMIT is always the table's own value."""
    return F.Threshold(
        rule_id=spec.detector_id, parameter=spec.parameter,
        parameter_label=spec.parameter_label, comparator=comparator,
        limit=float(spec.value), observed=float(observed), unit=unit,
        source=spec.source,
    )


def normalised_threshold(spec: "CP.ThresholdSpec", comparator: str,
                         observed_amount: float) -> Optional[F.Threshold]:
    """An absolute MONEY floor, expressed as a multiple of itself.

    ``Threshold`` renders its limit with ``_format_value``; a money limit
    therefore prints as ``RON 1,000,000``, which is nobody's cited fact
    and so can never bind to a ``{{money:…}}`` placeholder. The finding
    would be demoted for a rendering reason rather than a substantive
    one.

    So the comparison is normalised: observed becomes
    ``amount / floor`` and the limit becomes ``1.00×``. The DECISION is
    unchanged (``amount > floor`` iff ``amount/floor > 1``), the
    ``source`` still names the exact yaml path, and the floor's currency
    amount travels on the payload in ``ComparisonBasis.basis_value``.

    ``None`` when the floor is zero — a zero floor has no multiples; a
    detector in that position compares a share instead.
    """
    floor = float(spec.value)
    if floor == 0:
        return None
    return F.Threshold(
        rule_id=spec.detector_id, parameter=spec.parameter,
        parameter_label=spec.parameter_label, comparator=comparator,
        limit=1.0, observed=float(observed_amount) / floor,
        unit=F.UNIT_RATIO, source=spec.source,
    )


# ── Confidence ───────────────────────────────────────────────────────────


def with_method_caveat(confidence: F.Confidence, text: str) -> F.Confidence:
    """Append a METHOD statement to the profile's confidence position.

    Used where a detector answers a question with a proxy — an aging read
    taken from the allowance share, say. The proxy is stated in the
    comparison basis (that is the method) and the confidence position
    drops out of "high", because a proxy is not a measurement.
    """
    caveat = ((confidence.caveat.rstrip() + " " + text)
              if confidence.caveat else text)
    level = "medium" if confidence.level == "high" else confidence.level
    return replace(confidence, level=level, caveat=caveat)


# ── The detector context ─────────────────────────────────────────────────


@dataclass(frozen=True)
class Ctx:
    """Everything a detector may know. Deliberately small: the period's
    own views, the profile derived from them, and where they came from.
    No clock, no registry lookup, no prior period — a single-period
    detector that reached for any of those would stop being reproducible.
    """

    profile: "CP.CompanyProfile"
    reader: Reader
    period_id: str
    snapshot_id: Optional[str] = None

    @property
    def currency(self) -> str:
        return self.reader.currency

    def applies(self, detector_id: str) -> CP.Applicability:
        return self.profile.applies(detector_id)

    def threshold_spec(self, detector_id: str,
                       parameter: str) -> CP.ThresholdSpec:
        return self.profile.threshold(detector_id, parameter)

    def skipped(self, detector_id: str, reason: str) -> F.CheckRecord:
        return F.CheckRecord(
            rule_id=detector_id, profile_id=self.profile.profile_id,
            note=reason)

    def not_fired(self, detector_id: str, spec: "CP.ThresholdSpec",
                  comparator: str, observed: Optional[float], unit: str,
                  note: str = "") -> F.CheckRecord:
        """A check that RAN and did not fire. Silence is only a claim
        next to these.

        ``observed`` may be ``None`` — a rule whose PRECONDITION failed
        (free cash flow was positive, so the development split was never
        formed) genuinely has no observation for its parameter, and
        writing 0.0 there would be the same fabricated zero this package
        refuses everywhere else.
        """
        return F.CheckRecord(
            rule_id=detector_id, parameter=spec.parameter,
            comparator=comparator, limit=float(spec.value),
            observed=(None if observed is None else float(observed)),
            unit=unit, fired=False,
            profile_id=self.profile.profile_id, note=note)


# ── Finding assembly ─────────────────────────────────────────────────────


def build_finding(ctx: Ctx, detector_id: str, severity: str,
                  accounts: Sequence[F.Account], scope: str, bag: Bag,
                  comparison: F.ComparisonBasis,
                  threshold_element: F.Threshold,
                  impact: Optional[F.Impact],
                  steps: Sequence[F.ActionStep],
                  extra_caveats: Sequence[str] = (),
                  method_caveat: str = "") -> F.Finding:
    """Assemble the Finding.

    WHY-HERE and CONFIDENCE come from the profile, never from the
    detector: the catalogue owns the sentence that makes a finding about
    THIS company, and a detector that wrote its own would be free to
    write one that reads identically for any other.

    ``impact`` may be ``None``. That is not an escape hatch — it demotes
    the finding, which is the correct disposition for a rule that fired
    but could not quantify a consequence, and the demotion reason says
    so explicitly on the "All checks" row.
    """
    profile = ctx.profile
    line_refs = tuple(a.code for a in accounts)
    confidence = profile.confidence(detector_id, tuple(extra_caveats))
    if method_caveat:
        confidence = with_method_caveat(confidence, method_caveat)
    return F.Finding(
        rule_id=detector_id,
        severity=severity,
        category=profile.category_for(detector_id),
        currency=ctx.currency,
        subject=F.Subject(accounts=tuple(accounts), scope=scope),
        evidence=F.Evidence(
            figures=tuple(bag.figures),
            provenance=profile.provenance_for(line_refs),
            comparison_basis=comparison,
        ),
        threshold=threshold_element,
        impact=impact,
        why_here=profile.why_here(detector_id, scope=scope),
        action=F.Action(steps=tuple(steps)),
        confidence=confidence,
        profile_id=profile.profile_id,
        profile_fingerprint=profile.fingerprint(),
        facts_cited=dict(bag.facts),
    )


def ratio_impact_or_none(metric: str, metric_label: str,
                         numerator: Optional[_ratio_units.Quantity],
                         denominator: Optional[_ratio_units.Quantity],
                         adjusted_numerator: Optional[_ratio_units.Quantity] = None,
                         adjusted_denominator: Optional[_ratio_units.Quantity] = None,
                         unit: str = F.UNIT_RATIO) -> Optional[F.Impact]:
    """:func:`_finding.ratio_impact`, refusing rather than raising.

    An undefined quotient means the consequence cannot be quantified for
    this period. Returning ``None`` lets the finding demote with a stated
    reason instead of the detector swallowing an exception and inventing
    a number.
    """
    if numerator is None or denominator is None:
        return None
    try:
        return F.ratio_impact(
            metric, metric_label, numerator, denominator,
            adjusted_numerator=adjusted_numerator,
            adjusted_denominator=adjusted_denominator, unit=unit)
    except (_ratio_units.UndefinedRatioError, _ratio_units.UnitMismatchError):
        return None


def whole_days_impact(metric: str, metric_label: str, reader: Reader,
                      held_days: Optional[float], target_days: Optional[float],
                      unit_cost: Optional[float],
                      unit_cost_name: str) -> Optional[F.Impact]:
    """A day-count impact whose printed delta is the printed difference.

    ``Impact.render`` formats a day count as ``%.0f`` and its delta
    independently, so 4.24 days moving to 5.63 days prints as "from 4
    days to 6 days (+1 days)" — three numbers that do not add up, which
    costs the reader more trust than the precision was worth. Both
    endpoints are therefore rounded to whole days BEFORE the quotient is
    taken, and the quotient still runs through ``_ratio_units`` on
    same-currency operands.

    ``None`` when the two round to the same day: a consequence smaller
    than one day is not a consequence, and the caller falls back to a
    finer unit rather than printing a zero delta.
    """
    if held_days is None or target_days is None or not unit_cost:
        return None
    held = float(round(held_days))
    target = float(round(target_days))
    if held == target:
        return None
    return ratio_impact_or_none(
        metric, metric_label,
        numerator=reader.q(held * unit_cost, "days_held_at_unit_cost"),
        denominator=reader.q(unit_cost, unit_cost_name),
        adjusted_numerator=reader.q(target * unit_cost,
                                    "days_target_at_unit_cost"),
        unit=F.UNIT_DAYS)


def headroom_impact_or_none(metric: str, metric_label: str,
                            observed: float,
                            limit: float) -> Optional[F.Impact]:
    """A dimensionless headroom. Money headrooms are deliberately NOT
    supported: ``Impact`` requires both endpoints of a money impact to be
    cited facts, and a threshold amount is not one."""
    if observed == limit:
        return None
    return F.headroom_impact(
        metric, metric_label,
        _ratio_units.ratio_q(float(observed), name=metric),
        _ratio_units.ratio_q(float(limit), name=metric + "_limit"))


# ── Registry ─────────────────────────────────────────────────────────────

#: A detector takes the context and returns everything it produced: zero
#: or one Finding, and the checks that record what it examined.
DetectorFn = Callable[[Ctx], "Outcome"]


@dataclass(frozen=True)
class Outcome:
    """What one detector produced. A detector ALWAYS produces at least
    one check — running and staying quiet is a result, not an absence."""

    checks: Tuple[F.CheckRecord, ...] = ()
    finding: Optional[F.Finding] = None


def found(finding: F.Finding) -> Outcome:
    return Outcome(checks=(), finding=finding)


def quiet(*checks: F.CheckRecord) -> Outcome:
    return Outcome(checks=tuple(checks), finding=None)


def build_registry(modules: Sequence[Any]) -> Dict[str, DetectorFn]:
    """Merge each module's ``DETECTORS`` map, refusing a duplicate id.

    Two modules claiming the same detector would mean the same rule ran
    twice with two different sets of evidence — the "15 duplicate
    critical alerts" failure mode in its modern form.
    """
    registry = {}  # type: Dict[str, DetectorFn]
    for module in modules:
        for detector_id, fn in sorted(getattr(module, "DETECTORS").items()):
            if detector_id in registry:
                raise DetectorInputError(
                    "detector %r is claimed by more than one module (%s)"
                    % (detector_id, module.__name__))
            registry[detector_id] = fn
    return registry


__all__ = [
    "Bag", "Band", "Ctx", "DetectorInputError", "Outcome", "Reader",
    "VIEW_ORDER", "build_finding", "build_registry", "fired_band", "found",
    "headroom_impact_or_none", "normalised_threshold", "quiet", "quotient",
    "ratio_impact_or_none", "share", "threshold", "whole_days_impact",
    "with_method_caveat",
]
