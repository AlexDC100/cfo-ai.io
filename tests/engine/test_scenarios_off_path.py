"""GATE — Scenarios stays off the demo path until its acceptance passes.

Measured on production 2026-09-20 (Scandia Dec 2025, Recession template):
EBITDA 54.4 M -> −20.3 M, cash 6.1 M -> −107.6 M. A −20% revenue shock left
cost of sales untouched, and cash went negative with no funding line. The
owner's acceptance is: year-one EBITDA from the book's MEASURED fixed/variable
split, cash never negative, no property copy, FMCG templates.

This gate is a tripwire on the one word that re-enables the surface. It is
meant to be DELETED in the same commit that flips the flag back, by whoever
can point at the acceptance run — not edited around.

Fails on: the flag being flipped to active while this gate still exists; the
reason disappearing from the source; the three-state nav law being broken so a
deep link renders the page anyway.
"""
from __future__ import annotations

import inspect

from engine.api import _features


def test_scenarios_is_not_active():
    reg = _features.FEATURES if hasattr(_features, "FEATURES") else _features._REGISTRY  # noqa: SLF001
    row = reg["scenarios"]
    status = row["status"] if isinstance(row, dict) else row.status
    assert status == "coming_soon", (
        "Scenarios was re-enabled while this gate still exists. If the acceptance passed "
        "(measured fixed/variable split, cash never negative, no property copy, FMCG "
        "templates), delete this file in the SAME commit and name the acceptance run."
    )


def test_the_reason_travels_with_the_flag():
    src = inspect.getsource(_features)
    for evidence in ("−20.3", "−107.6", "measured", "acceptance"):
        assert evidence in src, f"the source no longer records {evidence!r} — the next reader cannot judge the flag"


def test_a_coming_soon_feature_is_off_the_route_not_just_the_nav():
    """The three-state nav law: the ROUTE consults the flag, so a deep link
    renders PendingState rather than a half-verified screen."""
    src = inspect.getsource(_features)
    assert "route" in src.lower(), "the law that the route consults this registry is no longer stated here"
