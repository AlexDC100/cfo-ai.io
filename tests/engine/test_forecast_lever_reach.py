"""forecast-lever-reach (plan/2 B6, plan_contract_v2 section 12): the
complete-and-unreachable guard. Every served driver either MOVES a served
number when it is nudged through the real route, or the response says, in the
engine's words, that it moves nothing in this plan.

For every driver key of every corpus book, and every op the registry allows
for it, the test POSTs the default request and a nudged one. The nudge is the
driver's own served ``reach_step``, sent the only way its ``set_via`` permits:
an override (default + step per plan year, or ``probe_value`` where the default
is null), a shock with the op under test, or a behaviour override.

REDS ON (TC-11): a nudge that changes no figure, series point or summary
amount on a driver the response does not mark inert (a lever wired to
nothing); a driver marked inert whose nudge DOES move a number; changed lines
outside the driver's consumed_by; a driver with no consumer; a not_settable or
unreachable key with no inert sentence and no refusal naming why; a driver
without its tier; zero drivers or ops exercised (TC-3).
CANNOT SEE: pool and debt reach steps of their own (levers.yaml#pools
.reach_step and #debt.reach_step are not packed in B6; the pool keys are
nudged by their registry reach_step and the debt rows are covered by
scenario-provenance); block-field consumers (B12 dcf).

Python 3.9 - no ``match``, no ``X | Y`` unions.
"""
from __future__ import annotations

import json
from fractions import Fraction

import pytest

from forecast_recompute_harness import BASE3, BOOKS, _call, amounts, figures_hash, post

SCALE = {"ratio_micros": 1000000, "index_micros": 1000000, "micro_days": 1000000,
         "money_minor": 100}
_WORK = []


def _dec(value):
    value = Fraction(value)
    digits = 0
    while (value * 10 ** digits).denominator != 1:
        digits += 1
    whole = value * 10 ** digits
    text = str(abs(whole.numerator)).rjust(digits + 1, "0")
    text = text if digits == 0 else "%s.%s" % (text[:-digits], text[-digits:])
    return ("-" if value < 0 else "") + text


def _nudges(key, d):
    """[(label, request fragment)] for one driver, one per allowed op."""
    step = Fraction(d["reach_step"])
    scale = SCALE[d["unit"]]
    default = d["values"][0]
    out = []
    if d["set_via"] == "overrides":
        top = d["bounds"]["max"]
        from engine.forecast.levers_pack import plan_pack
        entry = plan_pack().entry(key)
        values = []
        for v in d["values"]:
            if v is None:
                # 12: a driver whose default is null is set to its packed
                # probe_value (the response does not serve it)
                values.append(None if entry is None else _dec(entry.probe_value))
            else:
                now = Fraction(v, scale)
                up = now + step
                values.append(_dec(now - step if top is not None and up > Fraction(top) else up))
        if any(v is not None for v in values):
            out.append(("override", {"overrides": {key: {"values": values}}}))
    if d["set_via"] == "behaviour_overrides":
        now = Fraction(default, scale)
        share = now + step if now + step <= 1 else now - step
        out.append(("behaviour", {"behaviour_overrides": [
            {"pool": key.split(".", 1)[1], "fixed_share": _dec(share)}]}))
    for op in d["allowed_ops"]:
        if key == "revenue_growth":
            source = "template:reach"
        else:
            source = "template:reach" if op == "growth_pp" else "user"
        if op == "set":
            if default is None:
                continue
            now = Fraction(default, scale)
            top = d["bounds"]["max"]
            value = now - step if top is not None and now + step > Fraction(top) else now + step
        else:
            value = step
        out.append(("shock:%s" % op, {"shocks": [
            {"id": "reach:%s" % op, "driver_key": key, "op": op, "value": _dec(value),
             "source": source}]}))
    return out


@pytest.mark.parametrize("name", BOOKS)
def test_every_driver_moves_a_number_or_says_why_not(name):
    base = post(name, BASE3)
    base_hash, base_amounts = figures_hash(base), amounts(base)
    moved, inert, refused, ops = [], [], [], 0
    assert base["drivers"], "TC-3"
    for key, d in base["drivers"].items():
        assert d["basis"]["tier"], (name, key)
        assert d["consumed_by"], "%s: %s has no consumer" % (name, key)
        sentence = d["inert_in_this_plan"]
        nudges = _nudges(key, d)
        reached = False
        for label, fragment in nudges:
            ops += 1
            status, answer = _call(name, "POST", body=dict(BASE3, **fragment))
            if status == 422:
                refused.append("%s %s: %s" % (key, label, answer["detail"]["code"]))
                continue
            assert status == 200, (name, key, label, status)
            if figures_hash(answer) == base_hash:
                continue
            reached = True
            now = amounts(answer)
            changed = set(line for (line, _p), v in now.items()
                          if base_amounts.get((line, _p)) != v)
            assert changed <= set(d["consumed_by"]), (
                "%s: nudging %s (%s) moved %s, outside its consumed_by"
                % (name, key, label, sorted(changed - set(d["consumed_by"]))))
        if reached:
            assert sentence is None, (
                "%s: %s is served as inert (%r) and its nudge moves a number"
                % (name, key, sentence["text"]))
            moved.append(key)
        else:
            # An inert sentence is the ENGINE's word, and the engine's own
            # nudge can be wrong in the same way the route is (a lever that
            # compiles to nothing reads as "moves nothing"). So inertness is
            # accepted only where the book explains it: a driver the registry
            # wires DIRECTLY to a line (levers.yaml consumers) cannot be inert
            # while that line carries an amount in the base plan, unless it
            # is a fixed share (which acts only when revenue moves).
            from engine.forecast.levers_pack import plan_pack
            entry = plan_pack().entry(key)
            direct = () if entry is None else entry.consumers
            live = [line for line in direct if line in ("pl.revenue", "pl.cost_of_sales")
                    and any(v for (l, _p), v in base_amounts.items() if l == line)]
            assert not live or key.startswith("pool_fixed_share."), (
                "%s: %s is served as inert while %s carries an amount in the base "
                "plan: the lever compiles to nothing" % (name, key, ", ".join(live)))
            assert sentence is not None and sentence["text"].strip(), (
                "%s: %s moved nothing through the route (%s) and the response does "
                "not say so: a lever wired to nothing"
                % (name, key, [l for l, _f in nudges] or "no way to send it"))
            inert.append("%s (%s)" % (key, sentence["text"]))
    assert moved, "TC-3: no driver moved anything on %s" % name
    _WORK.append((name, len(base["drivers"]), ops, moved, inert, refused))


def test_zz_scope_and_work(capsys):
    assert len(_WORK) == len(BOOKS)
    with capsys.disabled():
        print("\nSCOPE forecast-lever-reach (plan/2 B6, contract 12): books %s; 3y/12m; "
              "every driver key x every allowed op, nudged by its served reach_step "
              "through POST recompute" % ", ".join(BOOKS))
        for name, declared, ops, moved, inert, refused in _WORK:
            print("  %s: levers declared %d, nudges sent %d, moved figures %d, inert %d, "
                  "nudges refused %d" % (name, declared, ops, len(moved), len(inert),
                                         len(refused)))
            for line in inert:
                print("    inert: %s" % line)
            for line in sorted(set(refused)):
                print("    refused: %s" % line)
        print("GATE-WORK forecast-lever-reach units=%d" % sum(w[2] for w in _WORK))
