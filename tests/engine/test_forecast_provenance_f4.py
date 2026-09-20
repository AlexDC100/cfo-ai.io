"""forecast-provenance (F4, plan/2 B6, plan_contract_v2 3.2-3.7): every
projected figure and series point resolves to the drivers and conventions
that produced it, valued for its own period.

Through the real route on the four corpus books, base and levered.

REDS ON (TC-11): a figure or series point naming an id that resolves in
neither ``drivers`` nor ``conventions``; a figure with no id or no formula;
per-figure basis prose back on the wire; a driver served without its tier, or
with a tier whose required evidence object is missing or a second one present
(3.3); a per-year driver whose values do not cover the horizon's plan years; a
figure naming a driver the same response marks inert; a user-tier driver
without its original; a driver whose consumed_by omits a line that names it.
CANNOT SEE: whether a driver's VALUE is right (forecast-authority,
forecast-defaults); lever ids (scenario-provenance).

Python 3.9 - no ``match``, no ``X | Y`` unions.
"""
from __future__ import annotations

import pytest

from forecast_recompute_harness import BASE3, BOOKS, levered_for, post

EVIDENCE = ("book", "sector", "macro", "convention")
_WORK = []


def _check(name, body, years):
    drivers, conventions = body["drivers"], body["conventions"]
    assert list(body["driver_order"]) == list(drivers), name
    n = 0
    for key, d in drivers.items():
        basis = d["basis"]
        present = [e for e in EVIDENCE if basis.get(e) is not None]
        if basis["tier"] in EVIDENCE:
            assert present == [basis["tier"]], (name, key, basis["tier"], present)
        elif basis["tier"] == "user":
            assert not present and basis["original"] and basis["source"], (name, key)
        else:
            assert basis["tier"] == "absent" and not present, (name, key)
            assert all(v is None for v in d["values"]) and basis["fallback_steps"], (name, key)
        assert basis["sentence"]["text"].strip(), (name, key)
        assert len(d["values"]) == (years if d["shape"] == "per_year" else 1), (name, key)
        n += 1
    used = {}
    for f in body["figures"]:
        if "refused" in f:
            continue
        assert f["driver_ids"] and f["formula"].strip() and "basis" not in f, (name, f["line"])
        for i in f["driver_ids"]:
            assert i in drivers or i in conventions, (name, f["line"], i)
            if i in drivers:
                assert drivers[i]["inert_in_this_plan"] is None, (
                    "%s: %s names %s, which this response marks inert" % (name, f["line"], i))
                used.setdefault(i, set()).add(f["line"])
        n += 1
    for key, lines in used.items():
        assert lines <= set(drivers[key]["consumed_by"]), (name, key, sorted(
            lines - set(drivers[key]["consumed_by"])))
    for key, points in body["series"].items():
        for p in points:
            for i in p.get("driver_ids") or ():
                assert i in drivers or i in conventions, (name, key, i)
            n += 1
    return n


@pytest.mark.parametrize("name", BOOKS)
def test_every_figure_and_point_resolves_and_every_driver_carries_its_tier(name):
    levered, _ids = levered_for(name)
    n = _check(name, post(name, BASE3), 3) + _check(name, post(name, levered), 3)
    body = post(name, levered)
    user = [k for k, d in body["drivers"].items() if d["basis"]["tier"] == "user"]
    assert "dividend_payout_pct" in user and "pool_fixed_share.personnel" in user, user
    for key in user:
        original = body["drivers"][key]["basis"]["original"]
        assert original["values"] and original["basis"]["tier"] != "user", key
    _WORK.append(n)


def test_zz_scope_and_work(capsys):
    assert len(_WORK) == len(BOOKS)
    with capsys.disabled():
        print("\nSCOPE forecast-provenance (plan/2 B6, gate row F4): books %s; base and "
              "levered 3y/12m; drivers, figures and series points resolved"
              % ", ".join(BOOKS))
        print("GATE-WORK forecast-provenance units=%d" % sum(_WORK))
