"""THE fp1 PAYLOAD THESE GATES ARE MEASURED ON - built from a real book.

TC-1: this is not a hand-typed fixture. Every base figure below is READ
AT TEST TIME out of ``tests/engine/fixtures/firm/saga_10_col_agras.json``
- a real Romanian trial balance through the real engine - by the real
``engine.insights.book.Book`` reader, which takes its balance-sheet
totals from ``envelope.canonical_bs.totals`` (the canonical authority,
not the legacy ``assembled_bs``).

Measured on that book, 2026-09-08::

    total_assets              39,319,114.09 RON
    total_equity              23,924,083.72 RON
    total_liabilities         15,395,030.37 RON
    total_current_assets      27,371,337.47 RON
    total_current_liabilities 13,012,976.77 RON
    revenue                  118,576,819.64 RON
    ebitda                    18,420,491.28 RON

THIS FILE HOLDS THE STAND-IN ONLY. THE REAL PATH IS NOT A FIXTURE.
------------------------------------------------------------------
``projection_payload()`` is a STAND-IN: flat declared drivers, integer
minor arithmetic, a balance sheet that closes by construction. It is not
a forecast engine and does not pretend to be one. It exists because the
boundary needs payloads the gates can BREAK on demand - a figure with no
assumptions, a source cell planted on a figure, one cent of imbalance -
and a real projection engine will not produce those on request.

It used to have a sibling here, ``engine_projection_payload()``, which
ran the real engine and RESHAPED its output into fp1 so the gates could
read it. That sibling is gone, and its removal is the point:

  it was a mirror double standing where the real producer belonged, and
  it hid the defect the gates existed to catch.

``engine.forecast`` does not emit fp1. It emits ``schema:
"forecast_v1"`` - bare floats, no ``kind``, no ``projected`` marker.
Every "measured on the real projection" test in the wave-1 suite reached
the boundary through this file's reshape, so the boundary was measured
against a shape it already recognised. MEASURED with the reshape removed:
a real 16-period agras projection pasted into a real served envelope gave
``projection_leaks_into_actuals -> 0 paths`` and
``assert_no_projection_in_actuals -> PASSED``.

The reshape now lives in the SHIPPED tree as
``engine.forecast_serving.adapter.fp1_from_forecast_v1`` - a real,
importable, non-test conversion the product uses - and the gates call
that. What they exercise is what ships.

The other thing that went with it: its ``attribute_assumptions=True``
flag, which attached all 17 declared drivers to all 496 figures so the
served path could be "exercised". Its own docstring called that
"dishonest attribution". A gate that has to falsify its input to go green
is measuring the falsification.

WHAT THE GATES CANNOT SEE (TC-11)
---------------------------------
Whether lane M's projection arithmetic is right. These gates prove that
a projected figure cannot be mistaken for an actual, that it resolves to
its assumptions, and that no model authored it. They prove nothing about
whether the growth rate is sensible or the balance sheet closes for the
right reason - only that an unbalanced year is reported as one.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

REPO = Path(__file__).resolve().parents[2]
FIRM = REPO / "tests" / "engine" / "fixtures" / "firm"
if str(REPO / "src") not in sys.path:
    sys.path.insert(0, str(REPO / "src"))

from engine.insights.book import Book  # noqa: E402

#: The three projected years. Labels only - no clock is read anywhere in
#: this file, so the payload is the same bytes on any day.
HORIZON = ("FY+1", "FY+2", "FY+3")

#: The declared drivers. Each states its basis in prose, because
#: ``contract.CLAUSE_ASSUMPTION_BASIS`` refuses one that does not: a
#: driver a reader cannot interrogate is a number with an opinion
#: attached.
DRIVERS = (
    {
        "id": "revenue_growth",
        "label": "Revenue growth",
        "unit": "pct",
        "values": {"FY+1": 0.08, "FY+2": 0.06, "FY+3": 0.05},
        "basis": "Held flat at the operator's stated plan; not fitted to "
                 "history, and stated as a plan figure rather than a "
                 "measurement.",
        "derived_from": ["assembled_pl.revenue"],
    },
    {
        "id": "ebitda_margin",
        "label": "EBITDA margin",
        "unit": "ratio",
        "values": {"FY+1": 0.155, "FY+2": 0.155, "FY+3": 0.155},
        "basis": "Base-year margin carried forward unchanged, so any "
                 "movement in projected EBITDA comes from revenue alone.",
        "derived_from": ["assembled_pl.ebitda", "assembled_pl.revenue"],
    },
    {
        "id": "asset_intensity",
        "label": "Assets per unit of revenue",
        "unit": "ratio",
        "values": {"FY+1": 0.3316, "FY+2": 0.3316, "FY+3": 0.3316},
        "basis": "Base-year total assets over base-year revenue, held "
                 "constant; the balance sheet therefore grows with the "
                 "top line and nothing else.",
        "derived_from": ["canonical_bs.totals.assets", "assembled_pl.revenue"],
    },
)


def base_book(name: str = "agras") -> Book:
    """The real committed book the projection stands on."""
    payload = json.loads((FIRM / ("saga_10_col_%s.json" % name)).read_text())
    return Book(payload)


def _minor(value: Optional[float]) -> Optional[int]:
    """Integer minor units, or None. ABSENT != ZERO: a base figure the
    book does not carry cannot be projected, and this returns None so the
    caller declines to emit a figure rather than emitting a zero."""
    if value is None:
        return None
    return int(round(value * 100.0))


def projection_payload(name: str = "agras",
                       unbalance_minor: int = 0) -> Dict[str, Any]:
    """One fp1 payload built off the real book.

    ``unbalance_minor`` deliberately breaks the balance check on the LAST
    projected year - used by the gate that proves an unbalanced year is
    reported as a hard error rather than swallowed as rounding.
    """
    book = base_book(name)
    revenue_0 = _minor(book.pl("revenue"))
    assets_0 = _minor(book.bs("total_assets"))
    equity_0 = _minor(book.bs("total_equity"))
    if revenue_0 is None or assets_0 is None or equity_0 is None:
        raise AssertionError(
            "book %r does not carry the base figures this fixture projects "
            "from; ABSENT != ZERO, so no payload is produced" % name
        )

    growth = DRIVERS[0]["values"]
    margin = DRIVERS[1]["values"]
    intensity = DRIVERS[2]["values"]

    figures = []  # type: List[Dict[str, Any]]
    balance_check = []  # type: List[Dict[str, Any]]
    revenue = revenue_0
    for index, period in enumerate(HORIZON):
        # Integer minor arithmetic throughout: the projected balance
        # sheet has to close to the cent, and a float sum of five figures
        # does not reproduce.
        revenue = revenue + (revenue * int(round(growth[period] * 10000))) // 10000
        ebitda = (revenue * int(round(margin[period] * 10000))) // 10000
        assets = (revenue * int(round(intensity[period] * 10000))) // 10000
        # Equity absorbs retained EBITDA; liabilities are the plug, which
        # is what makes the sheet close by construction here.
        equity = equity_0 + ebitda * (index + 1)
        liabilities = assets - equity
        for line, amount, ids, formula in (
            ("revenue", revenue, ["revenue_growth"],
             "prior.revenue * (1 + revenue_growth)"),
            ("ebitda", ebitda, ["revenue_growth", "ebitda_margin"],
             "revenue * ebitda_margin"),
            ("total_assets", assets, ["revenue_growth", "asset_intensity"],
             "revenue * asset_intensity"),
            ("total_equity", equity, ["ebitda_margin"],
             "base.equity + cumulative ebitda"),
            ("total_liabilities", liabilities,
             ["revenue_growth", "asset_intensity", "ebitda_margin"],
             "total_assets - total_equity"),
        ):
            figures.append({
                "line": line,
                "period": period,
                "amount_minor": int(amount),
                "assumption_ids": list(ids),
                "formula": formula,
            })
        difference = assets - (equity + liabilities)
        if period == HORIZON[-1]:
            difference += int(unbalance_minor)
        balance_check.append({
            "period": period,
            "difference_minor": int(difference),
        })

    return {
        "kind": "projection",
        "contract": "fp1",
        "currency": book.currency,
        "base_period": {
            "label": book.period_label or "base",
            # The projection as a whole stands on one book, and the
            # reader has to be able to see which. This is the ONLY
            # source reference in the payload, and it is at the
            # projection level - never on a figure.
            "snapshot_id": "saga_10_col_%s" % name,
        },
        "horizon": list(HORIZON),
        "assumptions": [dict(d) for d in DRIVERS],
        "figures": figures,
        "balance_check": balance_check,
    }


# ── the SERVED wire form, committed so the FE gate reads the real bytes ──


def served_wire_payload(**kwargs: Any) -> Dict[str, Any]:
    """What ``ProjectionGateway`` actually puts on the wire for the payload
    above — i.e. what a frontend would really receive.

    This exists because of what its absence cost. The engine suite called
    ``as_dict()`` seven times and never fed it back; the TypeScript suite
    only ever handed ``readProjection`` a hand-written INPUT-shaped payload.
    So the SERVED shape was the one thing no gate on either side ever read,
    and it did not parse: measured, ``from_payload`` raised on 30 clauses and
    the real shipped ``readProjection`` refused all 15 figures with
    ``no_assumptions_behind_it``, which ``ProjectedAmount`` paints as an
    em-dash. Every projected figure would have rendered "—" while the engine
    held the number and considered it served.

    Committed to ``fixtures/forecast/fp1_agras_served.json`` so both halves
    are measured on IDENTICAL BYTES rather than on two hand-kept copies.
    """
    from engine.forecast_serving import ProjectionGateway  # noqa: E402

    gateway = ProjectionGateway.from_payload(projection_payload(**kwargs))
    if gateway is None:  # pragma: no cover - the payload is a projection
        raise AssertionError("the stand-in payload stopped being a projection")
    return gateway.as_dict()
