"""FORECAST DRIVERS — the assumption set, defaulted from a company's own
actuals, with every default carrying the derivation that produced it.

The one entry point:

    from engine.forecast_drivers import build_case_set

    case_set = build_case_set(history)   # served payloads, OLDEST FIRST
    base     = case_set.case("base")
    growth   = base.value("revenue_growth")     # Optional[float]
    driver   = base.driver("revenue_growth")
    print(driver.value, driver.basis)           # 0.025  "no company history
                                                # - inflation anchor, from
                                                # 2025-12-31. ..."

WHAT THIS MODULE IS FOR
=======================
Every number this engine has produced so far is a FACT anchored to a
source cell. A forecast is an ASSUMPTION, and the product's credibility
depends on a reader never confusing the two. This module produces the
assumptions and makes them impossible to emit without their basis:
`Driver` cannot be constructed without a `Derivation`, and `Driver.basis`
is GENERATED from that derivation rather than passed alongside it, so the
sentence and the number cannot drift apart.

`status` is the honest three-way answer, and callers must branch on all
three: `derived` (measured from this company), `fallback` (a usable
number from outside its history, or from a source that declares itself an
approximation), `absent` (`value is None` — the payload carries no
source). ABSENT != ZERO: a company with no debt has no interest rate.

NO AI PRODUCES ANY NUMBER HERE. There is no model call in this package,
no import of one, and no place for one: every value is either read from
the served envelope, computed from two values read from it, or read from
a YAML pack with a named external source.

Determinism: no clocks, no `hash()`, no `set` iteration in any output.
Drivers emit in pack declaration order, cases in (base, upside,
downside), periods chronologically, and every value is rounded once at
emit by a rule the pack declares. Two runs on one payload produce
byte-identical `as_dict()`.

Python 3.9 — no `match`, no `X | Y`.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Sequence

from .authority import (CONCEPTS, RULED_MODEL_KEYS, AuthorityError, Concept,
                        SuppliedValue, blocked_model_keys,
                        concept_for_model_key, handover_basis,
                        model_overrides, model_owned_keys, unrepresentable)
from .cases import DISPERSION_BAND, DISPERSION_OBSERVED, build_cases
from .derive import build_base_set
from .packdata import (DriverSpec, ForecastPack, MacroAnchor, PackError,
                       load_pack)
from .reader import ActualsPeriod, Band
from .types import (CASE_KINDS, STATUSES, AssumptionSet, CaseSet, Derivation,
                    DerivationInput, Driver, DriverError)

__all__ = [
    "build_case_set", "driver_keys",
    "CaseSet", "AssumptionSet", "Driver", "Derivation", "DerivationInput",
    "ActualsPeriod", "Band",
    "ForecastPack", "DriverSpec", "MacroAnchor", "load_pack",
    "PackError", "DriverError",
    "STATUSES", "CASE_KINDS", "DISPERSION_OBSERVED", "DISPERSION_BAND",
    "CONCEPTS", "RULED_MODEL_KEYS", "Concept", "AuthorityError",
    "concept_for_model_key", "model_overrides", "unrepresentable",
    "handover_basis", "SuppliedValue",
    "blocked_model_keys", "model_owned_keys",
]


def driver_keys(pack=None):
    # type: (Optional[ForecastPack]) -> Sequence[str]
    """The frozen, ordered driver keys. Pack declaration order IS the
    render order."""
    return (pack or load_pack()).driver_keys


def build_case_set(history, pack=None):
    # type: (Sequence[Dict[str, Any]], Optional[ForecastPack]) -> CaseSet
    """Base, upside and downside from a workspace's actuals.

    `history` is a list of served payloads — the same dicts the insight
    `Book` takes — ORDERED OLDEST FIRST. A single-period history is legal
    and is the common case today; the rate drivers say so rather than
    quietly defaulting to no growth.

    Raises `DriverError` on an empty history: a forecast with no actuals
    behind it has nothing to be traceable to, and returning an empty set
    would let one be built anyway.
    """
    resolved = pack or load_pack()
    if not history:
        raise DriverError(
            "a forecast needs at least one actuals period; a projection "
            "with no book behind it cannot be traced to any fact")

    periods = []  # type: List[ActualsPeriod]
    for payload in history:
        periods.append(ActualsPeriod(payload))
    # Chronological, by the period end the payload itself carries. Sorting
    # here rather than trusting the caller means a mis-ordered history
    # cannot silently invert a growth rate.
    periods.sort(key=lambda p: (p.period_end, p.period_start))

    base = build_base_set(periods, resolved)
    (upside, downside), method, label, note = build_cases(
        base, periods, resolved)

    newest = periods[-1]
    provenance = {
        "actuals_periods": [p.provenance() for p in periods],
        "newest_period_end": newest.period_end,
        "period_count": len(periods),
        "currency": newest.currency,
        "pack_id": resolved.pack_id,
        "pack_version": resolved.pack_version,
        "macro_pack_id": resolved.macro_pack_id,
        "macro_pack_version": resolved.macro_pack_version,
        "driver_schema_version": resolved.schema_version,
        "bands_source": newest.bands_source,
        "bands_disclosure": newest.bands_disclosure,
    }
    return CaseSet((base, upside, downside), provenance, method, label, note)
