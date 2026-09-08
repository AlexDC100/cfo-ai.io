"""forecast_v1 -> fp1 — THE ONE PLACE THE PRODUCER'S BYTES BECOME SERVABLE.

WHY THIS FILE EXISTS AT ALL
===========================
Because for the whole of wave 1 it did not, and the gates did not notice.

``engine.forecast`` emits ``schema: "forecast_v1"`` — bare floats in major
units, no ``kind``, no ``projected`` marker, no per-figure attribution.
``engine.forecast_serving`` reads ``fp1`` — integer minor units, a
``kind`` discriminant, a marker on every figure. Nothing in the shipped
tree turned one into the other. The only thing that did was
``tests/engine/forecast_boundary_fixture.engine_projection_payload()``: a
TEST-ONLY adapter that reshaped the producer into the shape the gate was
already looking for, and then the gate was pointed at that.

A mirror double standing in where the real producer belongs is this
repo's documented failure mode. It is written down twice — the
``FakeStore`` note in ``CLAUDE.md`` §21 ("doubles hid two total outages
behind 244 green tests and a 19-gate battery") and the memory entry "Fake
stores hid 20+ defects". Here it hid this: with the reshape removed and a
real ``Projection.as_dict()`` pasted into a real served envelope,
``projection_leaks_into_actuals`` returned ZERO paths and
``assert_no_projection_in_actuals`` PASSED. The gate could not see the
thing it exists to see.

So the adapter moves into the shipped tree, the fixture's copy is gone,
and the gate now runs on the producer's own bytes.

WHY IT DOES NOT IMPORT ``engine.forecast``
------------------------------------------
It takes a DICT, not a ``Projection``. The boundary must not import the
producer it bounds — a boundary that lives inside the thing it bounds is
not a boundary, and ``scripts/check_forecast_boundary.mjs`` reds if this
package reaches across. Taking the serialized form costs nothing (the
producer already emits it, gated JSON-round-trippable by lane M's own
suite) and buys the independence.

WHAT IT REFUSES RATHER THAN INVENTS
-----------------------------------
ATTRIBUTION. fp1 requires every figure to name the drivers behind it
(``CLAUSE_FIGURE_ASSUMPTIONS``), and ``forecast_v1`` states no link
between its drivers and its figures — it emits both and no edge between
them. The honest answer is an empty ``assumption_ids``, which makes
:func:`~engine.forecast_serving.contract.clause_violations` refuse the
whole payload and serve NO number at all.

It would have been one line to attach every declared driver to every
figure. The test fixture had exactly that line, behind a flag its own
docstring called "itself dishonest attribution". It is not here. A figure
that claims seventeen drivers stand behind it when the model never said
so is a false provenance, and a false provenance is worse than a refusal
— the refusal is legible and the false one is not.

When the producer starts stating attribution it puts it under
:data:`ATTRIBUTION_KEY` and this adapter reads it. Nothing else changes,
and the invariant gate is already written so it holds in both worlds.

ABSENT != ZERO, AT THE UNIT BOUNDARY
------------------------------------
``forecast_v1`` carries major-unit floats; fp1 carries integer minor
units, because a projected balance sheet has to close to the cent and a
float sum of five figures does not reproduce. :func:`exact_minor` REFUSES
a value it cannot convert exactly — it returns ``None``, the figure is
not emitted, and the reader gets ``not_projected`` rather than a number
that is off by a cent. Measured over all four committed books, every
period, every line: 3,136 values, 0 inexact conversions, largest
magnitude 2.2e10 (float64 is exact to 9.0e15, so the headroom is five
orders of magnitude).

Python 3.9. No I/O, no network, no model, no clock. Deterministic: every
ordering is the producer's declared order or a sort on a declared key.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

from .contract import PRODUCER_SCHEMAS

__all__ = [
    "ATTRIBUTION_KEY",
    "FIGURE_SECTIONS",
    "ForecastAdapterError",
    "exact_minor",
    "fp1_from_forecast_v1",
    "is_forecast_v1",
]

#: Where the producer states which drivers stand behind which line.
#:
#: A map of fp1 line id -> list of assumption id, at the root of the
#: ``forecast_v1`` payload, e.g.::
#:
#:     "line_assumptions": {"pl.revenue": ["revenue_growth"],
#:                          "bs.ar": ["dso_days", "revenue_growth"]}
#:
#: Absent today. Named here so the producer has ONE key to fill and this
#: adapter has ONE key to read — the alternative is each side inventing
#: its own and the link silently never forming, which is the shape of
#: every defect this lane has found so far.
ATTRIBUTION_KEY = "line_assumptions"

#: The three statement bags a ``forecast_v1`` period carries, and the fp1
#: line-id prefix each becomes.
#:
#: The prefixes are NOT decoration. ``net_income`` and ``depreciation``
#: appear in both ``pl`` and ``cf``; flattened into one namespace they
#: collide, two different figures answer to one line id, and fp1 refuses
#: the payload as ``figure_declared_twice`` — correctly, since "one
#: concept, one value" is exactly what a collision breaks. The prefixes
#: are the producer's own: ``engine.forecast.Projection.series()`` already
#: keys on ``pl.`` / ``bs.`` / ``cf.``, so this is that vocabulary read
#: back, not a second one invented here.
FIGURE_SECTIONS = ("pl", "bs", "cf")

#: The derived totals a period carries beside its lines. Emitted under
#: their own prefix for the same anti-collision reason.
TOTALS_SECTION = "bs_totals"


class ForecastAdapterError(ValueError):
    """A payload that claims to be ``forecast_v1`` and cannot be read.

    Raised, not returned: the producer wrote it, so an unreadable one is
    a producer defect, and reshaping half of it would put a projected
    figure on the wire with part of its context missing.
    """


def is_forecast_v1(payload: Any) -> bool:
    """Does this dict carry the projection engine's own schema stamp?

    Keyed on the VALUE. The key ``schema`` alone would match
    ``envelope.canonical_bs.schema == "bs_v2"``, which is on every
    committed book and is ACTUALS.
    """
    return (isinstance(payload, dict)
            and payload.get("schema") in PRODUCER_SCHEMAS)


def exact_minor(value: Any) -> Optional[int]:
    """Integer minor units, or ``None`` when the conversion is not exact.

    ``None`` is a refusal, never a zero. The caller declines to emit the
    figure, and the reader is told the projection does not carry that
    line — which is a different fact from "that line is zero", and the
    only one of the two that is true.
    """
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, int):
        return value * 100
    if not isinstance(value, float):
        return None
    if value != value or value in (float("inf"), float("-inf")):
        return None
    minor = int(round(value * 100.0))
    # The round trip is the proof, not the arithmetic: reconstruct the
    # major-unit float and require it back byte-for-byte. A value that
    # was never a clean 2-decimal quantity fails here and is refused.
    if minor / 100.0 != value:
        return None
    return minor


def _periods(payload: Dict[str, Any]) -> List[Dict[str, Any]]:
    raw = payload.get("periods")
    if not isinstance(raw, list) or not raw:
        raise ForecastAdapterError(
            "a forecast_v1 payload with no periods projects nothing; there "
            "is no horizon to serve"
        )
    out = []  # type: List[Dict[str, Any]]
    for entry in raw:
        if not isinstance(entry, dict):
            raise ForecastAdapterError(
                "periods[] carries a %s, not an object" % type(entry).__name__)
        out.append(entry)
    return out


def _label(period: Dict[str, Any], index: int) -> str:
    meta = period.get("period")
    if isinstance(meta, dict):
        label = str(meta.get("label") or "")
        if label:
            return label
    raise ForecastAdapterError(
        "periods[%d] states no label; a projected figure has to name the "
        "year it belongs to, and an index is not a year" % index)


def _attribution(payload: Dict[str, Any]) -> Dict[str, List[str]]:
    raw = payload.get(ATTRIBUTION_KEY)
    if not isinstance(raw, dict):
        return {}
    out = {}  # type: Dict[str, List[str]]
    for line in sorted(str(k) for k in raw):
        ids = raw[line]
        if isinstance(ids, (list, tuple)):
            out[line] = [str(i) for i in ids]
    return out


def fp1_from_forecast_v1(payload: Any) -> Dict[str, Any]:
    """One ``forecast_v1`` projection, in the shape this namespace serves.

    The output goes straight into
    :class:`~engine.forecast_serving.gateway.ProjectionGateway` — which
    will REFUSE it while the producer states no attribution, and that
    refusal is the honest answer, not a gap to paper over.
    """
    if not is_forecast_v1(payload):
        raise ForecastAdapterError(
            "not a forecast_v1 payload: schema is %r, this adapter reads %s"
            % ((payload or {}).get("schema")
               if isinstance(payload, dict) else payload,
               ", ".join(PRODUCER_SCHEMAS)))

    opening = payload.get("opening")
    if not isinstance(opening, dict):
        raise ForecastAdapterError(
            "a projection with no opening position stands on nothing; the "
            "reader cannot be told which book it came from")

    currency = str(opening.get("currency") or "")
    periods = _periods(payload)
    attribution = _attribution(payload)

    horizon = []  # type: List[str]
    figures = []  # type: List[Dict[str, Any]]
    balance_check = []  # type: List[Dict[str, Any]]

    for index, period in enumerate(periods):
        label = _label(period, index)
        horizon.append(label)

        sections = []  # type: List[Tuple[str, Dict[str, Any]]]
        for name in FIGURE_SECTIONS:
            bag = period.get(name)
            if isinstance(bag, dict):
                sections.append((name, bag))
        totals = period.get(TOTALS_SECTION)
        if isinstance(totals, dict):
            sections.append((TOTALS_SECTION, totals))

        for name, bag in sections:
            # sorted(): the producer's bags are plain dicts, and a sort on
            # a declared key is the only ordering that survives a change
            # of insertion order. Same input, same bytes.
            for key in sorted(str(k) for k in bag):
                minor = exact_minor(bag[key])
                if minor is None:
                    # Refused, not zeroed. See `exact_minor`.
                    continue
                line = "%s.%s" % (name, key)
                figures.append({
                    "line": line,
                    "period": label,
                    "amount_minor": minor,
                    # [] when the producer states nothing. The contract
                    # then refuses the payload and no number is served.
                    "assumption_ids": list(attribution.get(line, ())),
                    "formula": "",
                })

        assets = equity_liab = None  # type: Optional[int]
        if isinstance(totals, dict):
            assets = exact_minor(totals.get("assets"))
            equity_liab = exact_minor(totals.get("equity_plus_liabilities"))
        balance_check.append({
            "period": label,
            # Computed here from the two served totals rather than copied
            # from the producer's own `checks.balance_delta`, so this is
            # an INDEPENDENT read of whether the sheet closes. A check
            # that only repeats the producer's opinion of itself proves
            # nothing. `None` when either total is missing: ABSENT, which
            # `balance_check()` reports as not balancing, because a year
            # nobody can check is not a year that closed.
            "difference_minor": (assets - equity_liab
                                 if assets is not None
                                 and equity_liab is not None else None),
        })

    raw_assumptions = payload.get("fp1_assumptions")
    assumptions = ([dict(a) for a in raw_assumptions
                    if isinstance(a, dict)]
                   if isinstance(raw_assumptions, list) else [])

    return {
        "kind": "projection",
        "contract": "fp1",
        "currency": currency,
        "base_period": {
            # The ONE source reference in the payload, and it sits at the
            # projection level: the projection as a whole stands on this
            # book, and no single projected number came out of a cell in
            # it.
            "label": str(opening.get("period_end") or ""),
            "snapshot_id": (str(opening.get("snapshot_id"))
                            if opening.get("snapshot_id") else None),
        },
        "horizon": horizon,
        "assumptions": assumptions,
        "figures": figures,
        "balance_check": balance_check,
    }
