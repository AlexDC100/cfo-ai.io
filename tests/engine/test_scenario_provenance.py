"""scenario-provenance (S6) and forecast-provenance's lever half (plan/2 B6,
plan_contract_v2 3.6): every projected figure names the levers that moved it,
and removing a named lever changes it.

Through the real route on the four corpus books, over EVERY lever kind B6
accepts: a shock, a group of shocks (group_id), an override, a behaviour
override and a debt row. For each lever L the request is re-POSTed WITHOUT L
(the removal run, made by the test through the route, never read from the
response under test).

REDS ON (TC-11): a figure that lists L and does not change when L is removed;
a figure that changes when L is removed and does not list L; a figure that
differs from the base run and lists no lever; a lever id on the wire that the
request did not send; a series point whose lever_ids disagree with its
figures'; zero figures carrying a lever (TC-3).
CANNOT SEE: slot, track and contribution figures (B8), case and spread levers
(B11), saved cases (B15).

Python 3.9 - no ``match``, no ``X | Y`` unions.
"""
from __future__ import annotations

import pytest

from forecast_recompute_harness import (BOOKS, _call, amounts, levered_for, post,
                                        without)

_WORK = []


@pytest.mark.parametrize("name", BOOKS)
def test_every_named_lever_moves_its_figure_and_every_moved_figure_names_it(name):
    body, LEVER_IDS = levered_for(name)
    full = post(name, body)
    served = amounts(full)
    listed = dict(((f["line"], f["period"]), (tuple(f.get("lever_ids") or ()), f.get("joint")))
                  for f in full["figures"])
    assert set(i for ids, _j in listed.values() for i in ids) <= set(LEVER_IDS), (
        "a lever id on the wire the request never sent")
    removed = {}
    for lever in LEVER_IDS:
        status, answer = _call(name, "POST", body=without(body, lever))
        # A plan the engine REFUSES without the lever (the debt row with no
        # stated rate on a book that cannot price debt) is a plan the lever
        # changed everywhere: it reaches every figure (3.6, as the engine's
        # own removal run reads it).
        assert status in (200, 422), (name, lever, status)
        removed[lever] = amounts(answer) if status == 200 else {}
    base = amounts(post(name, {"horizon": body["horizon"]}))
    checked = carrying = 0
    for cell, amount in served.items():
        if amount is None:
            continue
        ids, joint = listed[cell]
        moved_by = [lever for lever in LEVER_IDS if removed[lever].get(cell) != amount]
        if joint:
            assert not moved_by and ids, (name, cell, ids)
        else:
            assert sorted(ids) == sorted(moved_by), (
                "%s %s lists %s; removing each lever in turn changes it for %s"
                % (name, cell, list(ids), moved_by))
        if amount != base.get(cell):
            assert ids, "%s %s differs from the base run and names no lever" % (name, cell)
        carrying += 1 if ids else 0
        checked += 1
    assert carrying > 100, "TC-3: %d figures carry a lever on %s" % (carrying, name)
    for key, points in full["series"].items():
        for point in points:
            assert set(point.get("lever_ids") or ()) <= set(LEVER_IDS), (key, point)
    _WORK.append((name, checked, carrying))


def test_zz_scope_and_work(capsys):
    assert len(_WORK) == len(BOOKS), "TC-3: not every book ran"
    with capsys.disabled():
        print("\nSCOPE scenario-provenance (plan/2 B6, gate row S6): books %s; "
              "total_years 3, monthly_months 12; lever kinds shock, shock group, "
              "override, behaviour override, debt row; SYNTHETIC debt rate 8%% "
              "where the book cannot price debt; removal runs re-POSTed by the "
              "test" % (", ".join(BOOKS),))
        for name, checked, carrying in _WORK:
            print("  %s: figures checked %d, carrying a lever %d" % (name, checked, carrying))
        print("GATE-WORK scenario-provenance units=%d" % sum(w[1] for w in _WORK))
