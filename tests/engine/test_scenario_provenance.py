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
request did not send; a SERIES point (3.7) that lists L and does not change
when L is removed, or changes and does not list L, re-derived by the same
removal re-POSTs (fcf_cumulative after a shock's window has ended is the case
that found it: the later months' fcf figures name no lever, the running sum
still carries the early months); zero figures or zero series points carrying
a lever (TC-3).
TWO requests per book: LEVERED (every lever kind) and WINDOWED (one shock
with end_month 3, so a derived value outlives the lever's own figures).
CANNOT SEE: slot, track and contribution figures (B8), case and spread levers
(B11), saved cases (B15).

Python 3.9 - no ``match``, no ``X | Y`` unions.
"""
from __future__ import annotations

import pytest

from forecast_recompute_harness import (BASE3, BOOKS, _call, amounts, levered_for,
                                        post, without)

_WORK = []
WINDOWED = dict(BASE3, shocks=[
    {"id": "rail:volume_index", "driver_key": "volume_index", "op": "level_pct",
     "value": "-0.20", "start_month": 1, "ramp_months": 0, "end_month": 3}])


def _points(answer):
    return dict(((key, p["period"]), p.get("amount_minor"))
                for key, points in (answer.get("series") or {}).items() for p in points)


@pytest.mark.parametrize("name", BOOKS)
def test_every_named_lever_moves_its_figure_and_every_moved_figure_names_it(name):
    body, lever_ids = levered_for(name)
    _check(name, body, lever_ids, 100)


@pytest.mark.parametrize("name", BOOKS)
def test_a_value_that_outlives_its_levers_window_still_names_it(name):
    _check(name + "/windowed", WINDOWED, ("rail:volume_index",), 1, book=name)


def _check(label, body, LEVER_IDS, floor, book=None):
    name = book or label
    full = post(name, body)
    served = amounts(full)
    listed = dict(((f["line"], f["period"]), (tuple(f.get("lever_ids") or ()), f.get("joint")))
                  for f in full["figures"])
    assert set(i for ids, _j in listed.values() for i in ids) <= set(LEVER_IDS), (
        "a lever id on the wire the request never sent")
    removed = {}
    removed_points = {}
    for lever in LEVER_IDS:
        status, answer = _call(name, "POST", body=without(body, lever))
        # A plan the engine REFUSES without the lever (the debt row with no
        # stated rate on a book that cannot price debt) is a plan the lever
        # changed everywhere: it reaches every figure (3.6, as the engine's
        # own removal run reads it).
        assert status in (200, 422), (name, lever, status)
        removed[lever] = amounts(answer) if status == 200 else {}
        removed_points[lever] = _points(answer) if status == 200 else {}
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
    assert carrying >= floor, "TC-3: %d figures carry a lever on %s" % (carrying, label)
    base_points = _points(post(name, {"horizon": body["horizon"]}))
    series_carrying = 0
    for key, points in full["series"].items():
        for point in points:
            ids = tuple(point.get("lever_ids") or ())
            assert set(ids) <= set(LEVER_IDS), (key, point)
            if "amount_minor" not in point:
                continue
            cell = (key, point["period"])
            moved_by = [lever for lever in LEVER_IDS
                        if removed_points[lever].get(cell) != point["amount_minor"]]
            if point.get("joint"):
                assert not moved_by and ids, (label, cell, ids)
            else:
                assert sorted(ids) == sorted(moved_by), (
                    "%s series %s lists %s; removing each lever in turn changes it for %s"
                    % (label, cell, list(ids), moved_by))
            if point["amount_minor"] != base_points.get(cell):
                assert ids, "%s series %s differs from the base run and names no lever" % (
                    label, cell)
            series_carrying += 1 if ids else 0
            checked += 1
    assert series_carrying >= floor, "TC-3: %d series points carry a lever on %s" % (
        series_carrying, label)
    _WORK.append((label, checked, carrying + series_carrying))


def test_zz_scope_and_work(capsys):
    assert len(_WORK) == 2 * len(BOOKS), "TC-3: not every book ran both requests"
    with capsys.disabled():
        print("\nSCOPE scenario-provenance (plan/2 B6, gate row S6): books %s; "
              "total_years 3, monthly_months 12; lever kinds shock, shock group, "
              "override, behaviour override, debt row; SYNTHETIC debt rate 8%% "
              "where the book cannot price debt; removal runs re-POSTed by the "
              "test; figures AND series points re-derived; a second WINDOWED request "
              "(volume -20%%, months 1-3)" % (", ".join(BOOKS),))
        for name, checked, carrying in _WORK:
            print("  %s: figures and series points checked %d, carrying a lever %d" % (name, checked, carrying))
        print("GATE-WORK scenario-provenance units=%d" % sum(w[1] for w in _WORK))
