"""GATE p121-witness — the account-121 cross-check and its D6 diagnosis
still go RED on a real misread after the 711 ruling (design A8).

WHY THIS EXISTS. ``canonical_bs.invariants.p121_cross_check`` compares
account 121 with class 7 − class 6 as the statement reads it, and the BS
diagnosis emits ``D6_121_MISMATCH`` off its ``ok: false``. Before the owner's
ruling of 2026-09-26 the 711 term was the GROSS credit turnover, so the check
failed by 1.5M-191M on every closed manufacturer and ``pdf_positional``
carried a false D6. It now sums the MEASURED net 711 — on a closed book the
account-121 bridge, derived FROM 121 — so on every corpus book the check
closes by construction (golden-change 527d5222). A check that closes on every
book it is run on has no witness: an assembler that bridged ANY remainder
(a misread line, an unread leaf, last year's result left in 121, rows read
by an older parser) would keep it green.

WHAT THIS GATE HOLDS, on net-711-rule's CONSTRUCTED books (synthetic, no
client data) persisted through the REAL write path
(``_deterministic_tb_parsed`` → ``stage_map`` → ``stage_persist``) and
served by the REAL ``GET /api/period``:

  closed_bridge, bridge_with_722   the legitimate fold: ok true, class 7 −
                                   class 6 IS account 121 (the bridge), no D6
  closed_no_activity               a 2,000.00 misread no line names (no 711
                                   postings): ok false, D6 fires
  g4_unread / g5_residual /        the fold REFUSED (711 refused, so it adds
  g6_uncleared / g7_older_parser   nothing): ok false, D6 fires, naming 121
                                   and the class 7 − class 6 it disagrees with

A scope with no witness where ok is false is RED (TC-3).

WHAT IT REDS ON, with the rule in place (TC-11): the cross-check folding the
remainder (class 7 − class 6 set to 121 whenever an anchor exists); a
refused 711 contributing a figure to the check; D6 no longer emitted off
``ok: false``. Plants in docs/engine_book/gates.md "p121-witness".
"""
from __future__ import annotations

from typing import Any, Dict, List

import pytest
from _pytest.monkeypatch import MonkeyPatch

import test_net_711_rule as N
import test_rebuild_net_income_anchor as ANCHOR
from engine.confidence.reconciliation_checks import run_bs_diagnosis

AUTH = {"Authorization": "Bearer test"}

#: The fold the rule makes: the check closes to 121 by construction.
FOLDED = ("closed_bridge", "bridge_with_722")
#: Misreads the statement does NOT explain: the check must stay open.
WITNESSES = ("closed_no_activity", "g4_unread", "g5_residual", "g6_uncleared",
             "g7_older_parser")

WORK: Dict[str, Any] = {"units": 0, "witnesses": [], "folded": []}


def _served_cbs(name: str) -> Dict[str, Any]:
    book = N._persisted(name)
    mp = MonkeyPatch()
    try:
        with ANCHOR._routed(book, mp) as (client, _db):
            resp = client.get("/api/period/%s" % book.period_id, headers=AUTH)
    finally:
        mp.undo()
    assert resp.status_code == 200, resp.text[:400]
    statements = resp.json()["statements"]
    env = statements.get("assembled_canonical_v1") or {}
    cbs = env.get("canonical_bs") or statements.get("canonical_bs") or {}
    assert cbs, "%s: GET /api/period served no canonical_bs" % name
    return {"cbs": cbs, "pl": statements["assembled_pl"]}


def check_folded(name: str, served: Dict[str, Any]) -> List[str]:
    block = served["cbs"]["invariants"]["p121_cross_check"]
    inv = served["pl"].get("inventory_variation") or {}
    problems = []
    if inv.get("provenance") != "account_121_bridge":
        problems.append("%s: 711 is not the bridge (%r)" % (name, inv.get("provenance")))
    if block.get("ok") is not True:
        problems.append("%s: the legitimate fold leaves the check open %r" % (name, block))
    if block.get("p121") is None or abs(block["p121"] - block["cls7_minus_cls6"]) > 0.005:
        problems.append("%s: class 7 - class 6 %r is not account 121 %r on the fold"
                        % (name, block.get("cls7_minus_cls6"), block.get("p121")))
    if any(d.get("code") == "D6_121_MISMATCH" for d in run_bs_diagnosis(served["cbs"])):
        problems.append("%s: D6 fires on the legitimate fold" % name)
    return problems


def check_witness(name: str, served: Dict[str, Any]) -> List[str]:
    block = served["cbs"]["invariants"]["p121_cross_check"]
    pl = served["pl"]
    problems = []
    if block.get("p121") is None or block.get("cls7_minus_cls6") is None:
        return ["%s: the check is not falsifiable (%r)" % (name, block)]
    if block.get("ok") is not False:
        problems.append("%s: a misread the statement does not explain closes the check %r"
                        % (name, block))
    # The class 7 - class 6 side is what the statement MEASURES: the
    # build-up plus every measured named line — a refused 711 adds nothing.
    inv = pl.get("inventory_variation") or {}
    cap = pl.get("capitalized_own_work") or {}
    measured = float(pl["net_income_operational"]) + float(cap.get("value") or 0.0) + (
        float(inv["value"]) if inv.get("value") is not None else 0.0)
    if abs(measured - block["cls7_minus_cls6"]) > 0.005:
        problems.append("%s: class 7 - class 6 %r is not the measured lines %r"
                        % (name, block["cls7_minus_cls6"], round(measured, 2)))
    d6 = [d for d in run_bs_diagnosis(served["cbs"]) if d.get("code") == "D6_121_MISMATCH"]
    if not d6:
        problems.append("%s: D6_121_MISMATCH does not fire on ok:false" % name)
    elif d6[0].get("leaf_ids") != ["121"]:
        problems.append("%s: D6 does not name account 121 (%r)" % (name, d6[0]))
    return problems


@pytest.mark.parametrize("name", FOLDED)
def test_the_legitimate_fold_closes_the_check(name):
    problems = check_folded(name, _served_cbs(name))
    assert not problems, "\n".join(problems)
    WORK["folded"].append(name)
    WORK["units"] += 4


@pytest.mark.parametrize("name", WITNESSES)
def test_a_misread_the_statement_does_not_name_keeps_the_check_open_and_d6_fires(name):
    served = _served_cbs(name)
    problems = check_witness(name, served)
    assert not problems, "\n".join(problems)
    block = served["cbs"]["invariants"]["p121_cross_check"]
    WORK["witnesses"].append("%s (121 %s vs class 7 - class 6 %s)"
                             % (name, block["p121"], block["cls7_minus_cls6"]))
    WORK["units"] += 4


# ── Plants: the checkers must fail on each defect ──────────────────────────


def test_plant_the_check_folds_every_remainder_is_caught():
    """An assembler that bridged ANY remainder: class 7 - class 6 set to 121
    whenever an anchor exists. Every witness closes — the checker must red."""
    caught = []
    for name in WITNESSES:
        served = _served_cbs(name)
        block = served["cbs"]["invariants"]["p121_cross_check"]
        block["cls7_minus_cls6"] = block["p121"]
        block["ok"] = True
        if check_witness(name, served):
            caught.append(name)
    assert caught == list(WITNESSES), "PLANT fold-every-remainder unnoticed on %s" % (
        sorted(set(WITNESSES) - set(caught)))
    WORK["units"] += 1


def test_plant_a_refused_711_that_contributes_its_residual_is_caught():
    """The refused fold still adding its residual to the check."""
    served = _served_cbs("g5_residual")
    inv = served["pl"]["inventory_variation"]
    block = served["cbs"]["invariants"]["p121_cross_check"]
    block["cls7_minus_cls6"] = round(block["cls7_minus_cls6"] + inv["guards"]["G5_residual"], 2)
    assert check_witness("g5_residual", served), "PLANT refused-711-contributes unnoticed"
    WORK["units"] += 1


def test_zz_scope_and_work(capsys):
    with capsys.disabled():
        print("\nSCOPE p121-witness (canonical_bs p121_cross_check + D6, design A8): "
              "%d folded books, %d witnesses" % (len(WORK["folded"]), len(WORK["witnesses"])))
        print("P121-WITNESSES: %s" % "; ".join(WORK["witnesses"]))
        print("GATE-WORK p121-witness units=%d" % WORK["units"])
    assert len(WORK["witnesses"]) == len(WITNESSES), (
        "TC-3: the sweep judged %d of %d witnesses" % (len(WORK["witnesses"]), len(WITNESSES)))
    assert len(WORK["folded"]) == len(FOLDED)
