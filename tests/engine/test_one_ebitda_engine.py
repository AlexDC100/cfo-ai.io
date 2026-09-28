"""GATE one-ebitda-engine — every ENGINE surface serves THE ONE EBITDA
(design A8, the engine half of `one-ebitda`).

RULING (owner, 2026-09-26): 711 ("Variația stocurilor de produse") and 72x
inside EBITDA and the operating result, with their sign; one definition
across dashboard, report, benchmark and forecast.

INCIDENT. Before the ruling the engine served several EBITDAs at once:
`ebitda_statutory` (incl. 722), `ebitda_operational` (excl. 722),
`ebitda_operating_view` (incl. 722 + 767), `ebitda_statutory_with_711` (the
GROSS 711 memo: 98.9 %-191.0 % margins on every closed manufacturer), the
methodology YAML's `reported` (711 outside) behind FactsGateway, the
Capsule and the firm covenants, and the valuation's revision-2 fallback
that rebuilt a second EBITDA from the incomeStatement mirror on 0.0. Each
consumer picked one; the developer was a 29.5M covenant breach on one
surface and thin headroom on another.

LAW. On every book whose EBITDA the engine SERVES (four corpus books, four
CONSTRUCTED books), every engine surface below carries `assembled_pl.ebitda`
(and `operating_result` for the EBIT surfaces) to the cent: the legacy
aliases, the served reconciliation line and its one-line bridge, the GET
/api/period metrics block, the stored metric rows, the ratio table's
operands, the credit model, the methodology views, FactsGateway (Capsule
get_facts / advisory / radar), the valuation, the Section 9 benchmark, the
forecast's year 0, and the confidence roll-up identity.

REDS ON (TC-11): any engine surface carrying a figure other than the served
EBITDA on any served book — a second formula (the build-up before 711/72x,
the gross memo, a legacy alias computed apart) anywhere; a scope where no
book's build-up differs from its EBITDA (vacuous, TC-3).
CANNOT SEE: whether the served figure is right (net-711-rule); a refused
EBITDA (refusal-carries-engine); the denominator of a margin
(turnover-denominator-engine); the browser (the frontend `one-ebitda` gate).
"""
from __future__ import annotations

from typing import Any, Dict, List

import pytest

from _one_definition_served import (
    CENT, EBIT_SURFACES, EBITDA_SURFACES, SERVED_BOOKS, Refused, served)

WORK: Dict[str, Any] = {"checks": 0, "books": []}


def test_one_ebitda_the_witnesses_exist(capsys):
    """Non-vacuity: a surface that served the build-up (711 / 72x outside)
    would serve a DIFFERENT number on these books."""
    differing = []
    for name in SERVED_BOOKS:
        apl = served(name).apl
        assert apl.get("ebitda") is not None, "%s: expected a served EBITDA" % name
        if abs(apl["ebitda"] - apl["ebitda_before_stock_variation"]) > 1.0:
            differing.append(name)
    with capsys.disabled():
        print("\nSCOPE one-ebitda-engine: %d served books (%s); the build-up before 711/72x "
              "differs from EBITDA on %d: %s"
              % (len(SERVED_BOOKS), ", ".join(SERVED_BOOKS), len(differing), ", ".join(differing)))
    assert len(differing) >= 5, differing
    assert {"bridge_with_722", "agras", "realestate"} <= set(differing), differing


@pytest.mark.parametrize("name", SERVED_BOOKS)
def test_one_ebitda_every_engine_surface_serves_the_served_figure(name):
    b = served(name)
    want_ebitda = b.apl["ebitda"]
    want_ebit = b.apl["operating_result"]
    problems: List[str] = []
    for surfaces, want, what in ((EBITDA_SURFACES, want_ebitda, "EBITDA"),
                                 (EBIT_SURFACES, want_ebit, "EBIT")):
        for label, read in surfaces:
            got = read(b)
            WORK["checks"] += 1
            if isinstance(got, Refused) or got is None:
                problems.append("%s: %s refuses (%r) where the engine serves %s %s"
                                % (name, label, got, what, want))
            elif abs(float(got) - float(want)) > CENT:
                problems.append("%s: %s carries %.2f, the served %s is %.2f (delta %.2f)"
                                % (name, label, float(got), what, float(want),
                                   float(got) - float(want)))
    # The confidence roll-up identity must also PASS on the one definition.
    check = b.checks.get("ebitda_rollup")
    if check is None or not check.passed:
        problems.append("%s: the ebitda_rollup identity %s" % (
            name, "was not emitted" if check is None else "failed: %r" % (check.to_dict(),)))
    WORK["books"].append(name)
    assert not problems, "\n".join(problems)


def test_one_ebitda_zz_work(capsys):
    with capsys.disabled():
        print("\nONE-EBITDA-ENGINE surfaces: %d EBITDA + %d EBIT per book; books judged: %s"
              % (len(EBITDA_SURFACES), len(EBIT_SURFACES), ", ".join(WORK["books"])))
        print("GATE-WORK one-ebitda-engine units=%d" % WORK["checks"])
    assert len(WORK["books"]) == len(SERVED_BOOKS), WORK["books"]
    assert WORK["checks"] >= len(SERVED_BOOKS) * (len(EBITDA_SURFACES) + len(EBIT_SURFACES))
