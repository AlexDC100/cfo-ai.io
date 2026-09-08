"""UPSIDE and DOWNSIDE, derived from data rather than from taste.

WHY NOT A FIXED PERCENTAGE ON EVERY DRIVER
==========================================
A flat +/-20% on everything is not a case, it is a gesture: it asserts
that a company's revenue, its collection period and its tax rate are all
equally uncertain and uncertain in the same proportion, which is true of
no company. Worse, it invents the one number nobody can audit — the 20%.

Every bound below is a number that already exists in this company's own
report.

THE LADDER
==========
1. `observed_range` — THREE OR MORE actuals periods. The upside and the
   downside are the best and the worst this company ACTUALLY achieved.
   Nothing beats a company's own record, and no external band is needed.

2. `band_and_macro` — fewer than three periods, so the company's own
   volatility cannot be measured at all.
     · Level drivers walk the STRONG and WATCH rungs of
       `statements.assembled_bands` — the SAME rungs the report's own
       verdict grades this company on. The downside therefore lands
       exactly where the product already says "watch this", and the
       upside exactly where it already says "strong". No new threshold
       is introduced anywhere; TC-10 is satisfied because the case bound
       IS the verdict threshold, rendered from the same table.
     · Rate drivers use the macro anchor's OWN published tolerance band
       (the central bank's +/-1pp), not a chosen spread.

WHAT DOES NOT MOVE, AND WHY
===========================
Drivers with `case_rule: hold` are identical in all three cases: capex,
headcount, dividend policy, the tax rate, the contracted rate on drawn
debt, the fixed/variable cost split, cost inflation. A case is a
statement about TRADING CONDITIONS. Those are management decisions and
signed contracts, and moving them alongside trading conditions would
change two things at once, which is exactly what makes a three-case view
uninterpretable: the reader could no longer tell whether the downside is
bad trading or bad management.

CLAMPING
========
An upside is never worse than the base and a downside never better. When
a company already collects faster than the strong rung, the upside says
so and claims no improvement — "no improvement assumed; the company is
already inside the strong rung" is a better sentence to put in front of a
credit committee than a fabricated gain.

Python 3.9 — no `match`, no `X | Y`.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Sequence, Tuple

from .derive import _span_years, build_base_set
from .packdata import DriverSpec, ForecastPack
from .reader import ActualsPeriod
from .types import (AssumptionSet, Derivation, DerivationInput, Driver,
                    DriverError)

__all__ = ["build_cases", "DISPERSION_OBSERVED", "DISPERSION_BAND"]

DISPERSION_OBSERVED = "observed_range"
DISPERSION_BAND = "band_and_macro"

#: Three periods give two observed changes, which is the fewest that can
#: show a range rather than a single point. Two periods give exactly one
#: change, and one observation has no spread.
_MIN_PERIODS_FOR_OBSERVED = 3


def _hold_derivation(base_driver, case_kind):
    # type: (Driver, str) -> Derivation
    d = base_driver.derivation
    note = (
        "Held at the base value in every case: this is a management "
        "decision or a signed contract, not a trading condition. Moving it "
        "with the trading cases would change two things at once and the "
        "reader could no longer tell bad trading from bad management."
    )
    if d.note:
        note = "%s %s" % (d.note, note)
    return Derivation(method="hold", method_label=d.method_label,
                      periods_used=d.periods_used, inputs=d.inputs,
                      source=d.source, note=note)


def _clone(base_driver, value, derivation, status=None):
    # type: (Driver, Optional[float], Derivation, Optional[str]) -> Driver
    return Driver(
        key=base_driver.key, label=base_driver.label, unit=base_driver.unit,
        kind=base_driver.kind,
        favourable_direction=base_driver.favourable_direction,
        value=value,
        status=(status or base_driver.status) if value is not None else "absent",
        derivation=derivation, case_rule=base_driver.case_rule,
        why=base_driver.why)


def _favourable_pick(direction, candidate, base_value, want_upside):
    # type: (str, Optional[float], float, bool) -> Optional[float]
    """Clamp a candidate bound so an upside is never worse than base and a
    downside never better. Returns None when there is no candidate."""
    if candidate is None:
        return None
    higher_is_better = (direction == "up")
    if want_upside:
        return max(base_value, candidate) if higher_is_better \
            else min(base_value, candidate)
    return min(base_value, candidate) if higher_is_better \
        else max(base_value, candidate)


def _band_traverse(base_driver, spec, pack, newest, want_upside):
    # type: (Driver, DriverSpec, ForecastPack, ActualsPeriod, bool) -> Driver
    band = newest.band(spec.band_key)
    base_value = base_driver.value
    if band is None or base_value is None:
        note = (
            "No verdict band for %r in this book, so there is no rung to "
            "walk to and the case holds the base value." % (spec.band_key,)
        )
        return _clone(base_driver, base_value,
                      Derivation("hold_no_band", base_driver.derivation.method_label,
                                 base_driver.derivation.periods_used,
                                 base_driver.derivation.inputs,
                                 base_driver.derivation.source, note),
                      status=base_driver.status)

    rung = band.strong if want_upside else band.watch
    rung_name = "strong" if want_upside else "watch"

    # THE BAND'S OWN WIDTH CAPS THE MOVE.
    #
    # Measured on the committed realestate book: gross margin is 100.0% —
    # a rental business books no COGS — and walking straight to the watch
    # rung produced a downside of 15.0%, an 85-point collapse presented as
    # a case. The band's own disclosure says it is a general-SME default
    # "not calibrated to the resolved industry", so for a company sitting
    # far outside it the rung is not a bound, it is a different business.
    #
    # The span the report itself treats as this ratio's whole spectrum is
    # strong-to-watch. A single case step may not exceed it. This is still
    # entirely band-derived — no chosen constant enters — and it leaves
    # every in-band company untouched: agras gross margin 39.63% -> 15.0%
    # is unchanged by the cap, because the move was already inside it.
    width = None
    if band.strong is not None and band.watch is not None:
        width = abs(band.strong - band.watch)

    capped = rung
    if capped is not None and width is not None:
        higher_is_better = (base_driver.favourable_direction == "up")
        improving = want_upside
        if higher_is_better == improving:
            # the bound lies ABOVE the base numerically
            capped = min(capped, base_value + width)
        else:
            # the bound lies BELOW the base numerically
            capped = max(capped, base_value - width)

    picked = _favourable_pick(base_driver.favourable_direction, capped,
                              base_value, want_upside)
    if picked is None:
        picked = base_value
    width_capped = (
        capped is not None and rung is not None
        and abs(capped - rung) > 1e-12
        and abs(picked - base_value) > 1e-12
    )

    inputs = [
        DerivationInput("base", newest.period_end, base_value,
                        base_driver.derivation.inputs[0].authority
                        if base_driver.derivation.inputs else "book"),
        DerivationInput("band_strong", newest.period_end, band.strong,
                        "assembled_bands.bands.%s.strong" % band.key),
        DerivationInput("band_healthy", newest.period_end, band.healthy,
                        "assembled_bands.bands.%s.healthy" % band.key),
        DerivationInput("band_watch", newest.period_end, band.watch,
                        "assembled_bands.bands.%s.watch" % band.key),
    ]

    unchanged = abs(picked - base_value) < 1e-12
    if unchanged:
        note = (
            "No change assumed: the company is already at or beyond the %s "
            "rung of the band its own verdict is graded on."
            % (rung_name,)
        )
    elif width_capped:
        # IT DID NOT REACH THE RUNG, SO IT MUST NOT CLAIM TO.
        #
        # This branch used to prepend the cap explanation to the "Walked to
        # the WATCH rung" sentence, which left the note asserting a landing
        # place the number contradicted: on the agras book the downside DSO
        # reads 71.21 days while the watch rung is 75. A basis that
        # disagrees with the value beside it is the precise confusion this
        # lane exists to prevent, so the sentence is replaced rather than
        # decorated.
        #
        # TC-10: the width is RENDERED FROM THE BAND, never written as
        # prose, so a reader can check the arithmetic against the same
        # rungs carried in this driver's own inputs.
        note = (
            "Capped short of the %s rung (%s). The company sits outside this "
            "band, so the rung is not a bound for it; the move is one "
            "band-width — the %s-to-%s span of %s this report treats as the "
            "ratio's whole spectrum — from the measured base. The HEALTHY "
            "rung is carried in the inputs."
            % (rung_name, _plain_number(rung, spec.unit),
               "strong", "watch", _plain_number(width, spec.unit))
        )
    elif want_upside:
        note = (
            "Walked to the STRONG rung of the band this ratio's own verdict "
            "is graded on. The milder HEALTHY rung is carried in the inputs."
        )
    else:
        note = (
            "Walked to the WATCH rung — the level at which this report "
            "already flags the ratio for attention. This is a stress bound, "
            "not a central expectation; the milder HEALTHY rung is carried "
            "in the inputs."
        )
    disclosure = newest.bands_disclosure
    if disclosure:
        note = "%s Band source: %s" % (note, disclosure)

    # STATUS. A value that MOVED to a band rung is no longer a measurement
    # of this company — the band's own disclosure calls it a general-SME
    # default. Keeping `derived` would have let the downside gross margin
    # of 15% present as measured, which is the exact confusion this lane
    # exists to prevent. A value that was CLAMPED back to base is still
    # the measured one and keeps the base's status.
    status = base_driver.status if unchanged else "fallback"

    # The LEADING CLAUSE of the rendered basis. It has to describe where
    # the number actually landed: a capped move did not land on a rung, so
    # naming the rung here would put the same contradiction back into the
    # first half of the sentence that the note above just removed from the
    # second half.
    if width_capped:
        label = ("one band-width of this report's own verdict band, short "
                 "of the %s rung" % (rung_name,))
    else:
        label = ("the %s rung of this report's own verdict band"
                 % (rung_name,))

    return _clone(
        base_driver, _round(pack, spec.unit, picked),
        Derivation(
            method="band_traverse",
            method_label=label,
            periods_used=(newest.period_end,), inputs=inputs,
            source=base_driver.derivation.source, note=note),
        status=status)


def _macro_band(base_driver, spec, pack, newest, want_upside):
    # type: (Driver, DriverSpec, ForecastPack, ActualsPeriod, bool) -> Driver
    base_value = base_driver.value
    if base_value is None or not spec.macro_anchor:
        return _clone(base_driver, base_value,
                      _hold_derivation(base_driver, "case"))
    anchor = pack.anchor(spec.macro_anchor)
    half = anchor.band_half_width
    higher_is_better = (base_driver.favourable_direction == "up")
    if want_upside:
        value = base_value + half if higher_is_better else base_value - half
    else:
        value = base_value - half if higher_is_better else base_value + half
    note = (
        "Spread taken from the anchor's OWN published tolerance band "
        "(+/-%s), not from a chosen percentage. Source: %s."
        % (_pct(half), anchor.source)
    )
    inputs = list(base_driver.derivation.inputs) + [
        DerivationInput("band_half_width", anchor.stated_as_of, half, "pack"),
    ]
    return _clone(
        base_driver, _round(pack, spec.unit, value),
        Derivation(method="macro_band",
                   method_label="the macro anchor's own tolerance band",
                   periods_used=base_driver.derivation.periods_used,
                   inputs=inputs,
                   source="pack:%s@%s" % (pack.macro_pack_id,
                                          pack.macro_pack_version),
                   note=note),
        status="fallback")


def _observed_level(base_driver, spec, pack, observations, want_upside):
    # type: (Driver, DriverSpec, ForecastPack, Sequence[Tuple[str, float]], bool) -> Optional[Driver]
    """Best/worst value this company actually recorded. None when it never
    recorded enough of them."""
    if len(observations) < _MIN_PERIODS_FOR_OBSERVED:
        return None
    values = [v for _pe, v in observations]
    higher_is_better = (base_driver.favourable_direction == "up")
    if want_upside:
        picked = max(values) if higher_is_better else min(values)
    else:
        picked = min(values) if higher_is_better else max(values)
    which = "best" if want_upside else "worst"
    inputs = [
        DerivationInput(spec.key, pe, v, spec.authority)
        for pe, v in observations
    ]
    note = (
        "The %s value this company actually recorded across %d periods. Its "
        "own record, so no external band is used." % (which, len(values))
    )
    return _clone(
        base_driver, _round(pack, spec.unit, picked),
        Derivation(method="observed_range",
                   method_label="this company's %s recorded %s"
                                % (which, spec.label.lower()),
                   periods_used=tuple(pe for pe, _v in observations),
                   inputs=inputs, source="book", note=note),
        status=base_driver.status)


def _observed_steps(base_driver):
    # type: (Driver) -> Tuple[Tuple[str, float], ...]
    """The individual year-on-year changes behind a compound rate.

    Reconstructed from the base driver's OWN derivation inputs — the
    series it actually consumed — so a case bound cannot be computed from
    a different series than the base was.
    """
    inputs = base_driver.derivation.inputs
    if base_driver.derivation.method not in ("cagr", "yoy") or len(inputs) < 2:
        return ()
    steps = []  # type: List[Tuple[str, float]]
    for index in range(1, len(inputs)):
        prev = inputs[index - 1]
        cur = inputs[index]
        if prev.value is None or cur.value is None or prev.value <= 0.0:
            continue
        years = _span_years(prev.period, cur.period)
        if years is None or years <= 0.0:
            continue
        steps.append((cur.period, (cur.value / prev.value) ** (1.0 / years) - 1.0))
    return tuple(steps)


def _observed_rate(base_driver, spec, pack, want_upside):
    # type: (Driver, DriverSpec, ForecastPack, bool) -> Optional[Driver]
    steps = _observed_steps(base_driver)
    if len(steps) < 2:
        return None
    values = [v for _pe, v in steps]
    higher_is_better = (base_driver.favourable_direction == "up")
    if want_upside:
        picked = max(values) if higher_is_better else min(values)
    else:
        picked = min(values) if higher_is_better else max(values)
    which = "best" if want_upside else "worst"
    note = (
        "The %s year-on-year change this company actually recorded across "
        "%d observed changes. Its own record, so no macro band is used."
        % (which, len(values))
    )
    inputs = [
        DerivationInput("yoy_change", pe, v, spec.authority)
        for pe, v in steps
    ]
    return _clone(
        base_driver, _round(pack, spec.unit, picked),
        Derivation(method="observed_range",
                   method_label="this company's %s recorded year-on-year "
                                "change" % which,
                   periods_used=tuple(pe for pe, _v in steps),
                   inputs=inputs, source="book", note=note),
        status="derived")


def _round(pack, unit, value):
    # type: (ForecastPack, str, Optional[float]) -> Optional[float]
    if value is None:
        return None
    return round(float(value), pack.round_for(unit))


def _pct(value):
    # type: (float) -> str
    text = "%.3f" % (value * 100.0)
    text = text.rstrip("0").rstrip(".")
    return "%spp" % text


def _plain_number(value, unit):
    # type: (Optional[float], str) -> str
    """Render a band rung or a band width in the unit the reader sees it
    in, so the sentence and the number beside it agree.

    TC-10: this exists so a threshold is never TYPED into a note. Every
    cutoff a note mentions is rendered here from the same band the verdict
    used, and the rungs it was rendered from stay in the driver's own
    `derivation.inputs` for anyone checking the arithmetic.
    """
    if value is None:
        return "not carried"
    if unit == "rate":
        text = "%.4f" % (value * 100.0)
        return "%s%%" % text.rstrip("0").rstrip(".")
    if unit == "days":
        text = "%.4f" % value
        return "%s days" % text.rstrip("0").rstrip(".")
    text = "%.4f" % value
    return text.rstrip("0").rstrip(".")


def build_cases(base, history, pack):
    # type: (AssumptionSet, Sequence[ActualsPeriod], ForecastPack) -> Tuple[Tuple[AssumptionSet, AssumptionSet], str, str, str]
    """Return ((upside, downside), dispersion_method, label, note)."""
    if not history:
        raise DriverError("cases need at least one actuals period")
    newest = history[-1]

    # Per-period level observations, produced by running the SAME base
    # builder over each prefix of the history. Reusing the builder rather
    # than a second extraction table is deliberate: a case bound and a
    # base value can never come from different rules.
    level_observations = {}  # type: Dict[str, List[Tuple[str, float]]]
    if len(history) >= _MIN_PERIODS_FOR_OBSERVED:
        for index in range(len(history)):
            partial = build_base_set(history[:index + 1], pack)
            period_end = history[index].period_end
            for driver in partial.drivers:
                if driver.kind != "level" or driver.value is None:
                    continue
                if driver.status == "absent":
                    continue
                level_observations.setdefault(driver.key, []).append(
                    (period_end, driver.value))

    used_observed = [False]

    def _one(want_upside):
        # type: (bool) -> List[Driver]
        out = []  # type: List[Driver]
        for base_driver in base.drivers:
            spec = pack.driver(base_driver.key)
            if spec is None:
                raise DriverError("no pack spec for driver %r"
                                  % (base_driver.key,))
            if base_driver.value is None:
                # Absent stays absent in every case. A case does not
                # conjure a driver the book never carried.
                out.append(base_driver)
                continue
            if spec.case_rule == "hold":
                out.append(_clone(base_driver, base_driver.value,
                                  _hold_derivation(base_driver, "case")))
                continue

            observed = None  # type: Optional[Driver]
            if base_driver.kind == "rate":
                observed = _observed_rate(base_driver, spec, pack, want_upside)
            else:
                observed = _observed_level(
                    base_driver, spec, pack,
                    level_observations.get(base_driver.key, ()), want_upside)
            if observed is not None:
                used_observed[0] = True
                out.append(observed)
                continue

            if spec.case_rule == "band_traverse":
                out.append(_band_traverse(base_driver, spec, pack, newest,
                                          want_upside))
            elif spec.case_rule == "macro_band":
                out.append(_macro_band(base_driver, spec, pack, newest,
                                       want_upside))
            else:
                raise DriverError("unhandled case_rule %r" % (spec.case_rule,))
        return out

    upside_drivers = _one(True)
    downside_drivers = _one(False)

    if used_observed[0]:
        method = DISPERSION_OBSERVED
        label = "this company's own recorded best and worst"
        note = (
            "The workspace holds %d actuals periods, so the cases are the "
            "best and the worst this company actually recorded. No external "
            "band is used for any driver that had enough of its own history."
            % (len(history),)
        )
    else:
        method = DISPERSION_BAND
        label = "the report's own verdict bands, and the macro anchor's band"
        note = (
            "The workspace holds %d actuals period%s, which is not enough to "
            "measure this company's own volatility. Level drivers are walked "
            "to the STRONG and WATCH rungs of the verdict bands this same "
            "report grades them on; rate drivers use the macro anchor's own "
            "published tolerance band. Load a second and third period and "
            "every one of these bounds is replaced by this company's own "
            "record." % (len(history), "" if len(history) == 1 else "s")
        )

    upside_basis = (
        "Trading drivers at their favourable bound (%s); management "
        "decisions and contracts held at base so only trading conditions "
        "differ between the cases." % (label,)
    )
    downside_basis = (
        "Trading drivers at their unfavourable bound (%s); management "
        "decisions and contracts held at base so only trading conditions "
        "differ between the cases." % (label,)
    )

    upside = AssumptionSet("upside", "Upside", upside_basis, upside_drivers)
    downside = AssumptionSet("downside", "Downside", downside_basis,
                             downside_drivers)
    return (upside, downside), method, label, note
