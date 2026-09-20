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
ACROSS THE BOOKS (B6 repair): every (driver, op) nudge moves a number on at
least one corpus book, or on a labelled SYNTHETIC request, or is a pool key
every book serves as nil with a zero base. The engine's inert sentence alone
is never enough for a nudge that is dead everywhere.
CANNOT SEE: a lever dead on ONE book and live on another, for a driver not
wired directly to pl.revenue / pl.cost_of_sales (there the engine's inert
sentence is still taken at its word); pool and debt reach steps of their own (levers.yaml#pools
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
#: (driver key, nudge label) -> the books on which that nudge moved a number
_LIVE = {}


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
            _LIVE.setdefault((key, label), [])
            status, answer = _call(name, "POST", body=dict(BASE3, **fragment))
            if status == 422:
                refused.append("%s %s: %s" % (key, label, answer["detail"]["code"]))
                continue
            assert status == 200, (name, key, label, status)
            _LIVE.setdefault((key, label), [])
            if figures_hash(answer) == base_hash:
                continue
            reached = True
            _LIVE[(key, label)].append(name)
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


#: SYNTHETIC liveness (labelled): a nudge no corpus book can carry, shown to
#: move a number on a request that gives it something to act on.
#: (key, nudge) -> (book, the request fragment it is nudged on top of, why)
SYNTHETIC_LIVENESS = {
    ("interest_income_rate", "shock:add_pp"): (
        "agras", {"overrides": {"interest_income_rate": {"values": ["0.02", "0.02", "0.02"]}}},
        "no corpus book measures a rate on cash, so add_pp refuses rate_not_measured "
        "everywhere; SYNTHETIC stated rate 2%"),
}
NIL_POOL_RULE = "packs/forecast/cost_behaviour.yaml#nil_pool"
_SYNTHETIC_RUN = []


def test_zy_every_nudge_is_live_on_some_book_or_the_books_explain_why_not():
    """B6V-2d: the per-book test accepts the ENGINE's inert sentence, and the
    engine's inert nudge is blind to a lever that compiles to nothing. Across
    the corpus that blindness ends: a (driver, op) that moves a number on NO
    book is a dead lever unless (a) a labelled SYNTHETIC request shows it
    moving, or (b) it is a pool key and EVERY book serves that pool as nil
    with a zero base (the book's own evidence, not the inert sentence).

    RED ON: dso_days (or any driver) compiled to a no-op on every book
    (plant, gates.md); a SYNTHETIC row that no longer moves anything.
    CANNOT SEE: a lever dead on ONE book and live on another, for a driver
    not wired directly to pl.revenue / pl.cost_of_sales."""
    assert len(_WORK) == len(BOOKS), "TC-3: the per-book runs did not complete"
    assert len(_LIVE) > 50, "TC-3: %d nudges recorded" % len(_LIVE)
    dead = sorted(k for k, books in _LIVE.items() if not books)
    unexplained = []
    for key, label in dead:
        if (key, label) in SYNTHETIC_LIVENESS:
            book, fragment, _why = SYNTHETIC_LIVENESS[(key, label)]
            on = dict(BASE3, **fragment)
            base = post(book, on)
            nudge = [f for l, f in _nudges(key, base["drivers"][key]) if l == label]
            assert nudge, (key, label)
            merged = json.loads(json.dumps(on))
            for field, value in nudge[0].items():
                if isinstance(value, dict):
                    merged.setdefault(field, {}).update(value)
                else:
                    merged[field] = list(merged.get(field) or []) + list(value)
            assert figures_hash(post(book, merged)) != figures_hash(base), (
                "SYNTHETIC %s %s on %s moves nothing: the lever compiles to nothing"
                % (key, label, book))
            _SYNTHETIC_RUN.append((key, label))
            continue
        pool = key.split(".", 1)[1] if key.startswith(("pool_level.", "pool_fixed_share.")) else None
        nil = pool is not None
        for name in BOOKS if pool else ():
            basis = post(name, BASE3)["drivers"]["pool_fixed_share." + pool]["basis"]
            rule = (basis.get("convention") or {})
            zero = [e for e in rule.get("evidence") or [] if e.get("value_minor") == 0]
            nil = nil and rule.get("rule_id") == NIL_POOL_RULE and bool(zero)
        if not nil:
            unexplained.append("%s %s" % (key, label))
    assert not unexplained, (
        "moves a number on no corpus book, no SYNTHETIC row shows it live and no "
        "book explains it (a lever that compiles to nothing): %s" % ", ".join(unexplained))
    unused = sorted(set(SYNTHETIC_LIVENESS) - set(dead))
    assert not unused, "SYNTHETIC rows for nudges that are live on the corpus: %s" % unused


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
        dead = sorted(k for k, books in _LIVE.items() if not books)
        print("  cross-book: %d (driver, op) nudges, live on a corpus book %d, SYNTHETIC "
              "%d, nil pool on every book %d" % (len(_LIVE), len(_LIVE) - len(dead),
                                                 len(_SYNTHETIC_RUN),
                                                 len(dead) - len(_SYNTHETIC_RUN)))
        print("GATE-WORK forecast-lever-reach units=%d" % sum(w[2] for w in _WORK))
