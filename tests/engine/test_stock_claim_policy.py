"""STOCK-CLAIM-POLICY — stock is never called slow on a single period-end
balance; where it is, the claim cites the split and the average (owner spec
2026-09-26, inventory days point 5: "Findings and the command bar never call stock
'slow' on the snapshot alone; the claim cites the split and the average";
design B5).

The served block carries `claim_policy` {may_call_slow, requires, reason}:
true only when the split by stock type is served AND it rests on an average
balance. A band finding that says inventory days WORSENED (dio, inventory
turnover) is a claim that the stock is slow.

The books: the corpus Agras FY2025 through the REAL write path, and the same
workbook with 20,000,000 / 60,000,000 of materials bought on credit and
still in stock at 31 December (tmp variants: the trial balance balances,
the P&L does not move, only the stock) — served by GET /api/period and
compared by the served comparatives (`_comparatives.compare_payloads`, the
function GET /api/period/{id}/comparatives renders). Each pair is read on
the average (the file's own opening) and as the one-day snapshot (the same
periods written before the evidence existed — every period in production
today).

WHAT THIS REDS ON, AFTER THE REPAIR (TC-11):

  · on the SNAPSHOT pair, any dio / inventory_turnover finding that says the
    stock worsened (the ratio's band move is still served in the table —
    the figure moved — but no finding claims it);
  · on the AVERAGE pair, no such finding (the policy must not silence a
    lawful claim), or one whose basis does not cite every served leg with
    its days AND the average's label, or whose structured `inventory_claim`
    is not the served block's legs, total and basis;
  · a band move across two different bases served as a movement (it must be
    `basis_differs`), or a finding written on it;
  · a DELTA served across two different bases (value, percentage or
    direction — it must be refused with `basis_differs`: Scandia FY2025
    against its stored FY2024 printed "+6 days, deteriorated" in the
    comparatives while the row's own sentence called it the change of
    basis), or the cycle's delta refused (both of its sides add the
    period-end split), or a delta withheld on a pair on ONE basis;
  · an IMPROVEMENT withheld on the snapshot (it calls nothing slow);
  · the served block, FactsGateway, or the narrator's compact block giving a
    snapshot `may_call_slow` true, or the narrator's system prompt without
    the claim rule;
  · any served text of a snapshot period (insights, findings, the narrative
    fields of GET /api/period — the block's own policy text excluded) that
    calls the stock slow, excessive or "lent".

Plant log: docs/engine_book/gates.md "stock-claim-policy".
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Dict, List, Tuple

import pytest

import _inventory_gate_books as G

CLAIM_KEYS = ("dio", "inventory_turnover")
WORK = {"withheld": 0, "cited": 0, "surfaces": 0, "texts": 0}
STRINGS = {"scanned": 0}
_PAIRS: Dict[str, Any] = {}

#: A claim that the stock is slow / excessive, EN or RO.
SLOW = re.compile(r"\b(slow(er|ly|-moving)?|sluggish|excess(ive)?|overstock(ed)?|"
                  r"lent[ăae]?|lente|prea mare|supra-?stoc(are)?)\b", re.IGNORECASE)


@pytest.fixture(scope="module")
def books(tmp_path_factory) -> Dict[str, Any]:
    tmp = tmp_path_factory.mktemp("stock_claim")
    base = G.corpus_book("saga_10_col_agras")
    out = {"base": base}
    for delta in (20_000_000.0, 60_000_000.0):
        path = G.with_stock_moved("saga_10_col_agras", tmp, delta, name="stock")
        out["plus_%d" % int(delta / 1e6)] = G.book_from_path(path, key="agras-plus-%d" % int(delta / 1e6))
    return out


def _compare(cur_bk: Any, pri_bk: Any, *, snapshot_cur: bool, snapshot_pri: bool) -> Tuple[Dict, Dict, Dict]:
    from engine.api._comparatives import compare_payloads

    cur_bk = G.predates(cur_bk) if snapshot_cur else cur_bk
    pri_bk = G.predates(pri_bk) if snapshot_pri else pri_bk
    cur, pri = G.served(cur_bk), G.served(pri_bk)
    doc = compare_payloads(cur, pri, current_row=cur_bk.period, prior_row=pri_bk.period, caen=None)
    return doc["ratios"], cur, pri


def _claims(ratios: Dict[str, Any], direction: str) -> List[Dict[str, Any]]:
    return [f for f in ratios["band_movements"]["findings"]
            if f.get("ratio_key") in CLAIM_KEYS and f.get("direction") == direction]


def _row(ratios: Dict[str, Any], key: str) -> Dict[str, Any]:
    return [r for r in ratios["rows"] if r["key"] == key][0]


@pytest.mark.parametrize("variant", ("plus_20", "plus_60"))
def test_the_snapshot_never_calls_the_stock_slow(books, variant):
    ratios, cur, _pri = _compare(books[variant], books["base"], snapshot_cur=True, snapshot_pri=True)
    block = G.block_of(cur)
    assert block["basis"] == "year_end_snapshot", block["basis"]
    policy = block["claim_policy"]
    assert policy["may_call_slow"] is False and policy["reason"] == "snapshot_only", policy
    moved = [k for k in CLAIM_KEYS if _row(ratios, k)["movement"]["status"] == "crossed_down"]
    assert moved, "%s: the constructed stock rise moved no inventory band — the plant is vacuous" % variant
    claims = _claims(ratios, "deteriorated")
    assert not claims, "%s: stock called slow on one balance: %s" % (
        variant, [(f["ratio_key"], f.get("title")) for f in claims])
    WORK["withheld"] += len(moved)


@pytest.mark.parametrize("variant", ("plus_20", "plus_60"))
def test_on_the_average_the_claim_cites_every_leg_and_the_basis(books, variant):
    ratios, cur, _pri = _compare(books[variant], books["base"], snapshot_cur=False, snapshot_pri=False)
    block = G.block_of(cur)
    assert block["basis"] == "average_two_year_ends" and block["claim_policy"]["may_call_slow"] is True
    moved = [k for k in CLAIM_KEYS if _row(ratios, k)["movement"]["status"] == "crossed_down"]
    claims = _claims(ratios, "deteriorated")
    assert sorted(f["ratio_key"] for f in claims) == sorted(moved) and moved, (
        variant, moved, [f["ratio_key"] for f in claims])
    legs = [g for g in block["groups"] if g["value_q"] is not None]
    assert legs, "the split serves no leg"
    for f in claims:
        basis = f["contract_elements"]["evidence"]["comparison_basis"]["description"]
        for g in legs:
            cite = "%s %s days" % (g["label_en"].lower(), g["value_q"])
            assert cite in basis, "%s: the claim does not cite %r: %s" % (f["ratio_key"], cite, basis)
        assert block["basis_label"]["en"] in basis, (f["ratio_key"], basis)
        assert "total %s days" % block["total"]["value_q"] in basis, basis
        assert basis in f["body"], "the cited basis is not in the finding's body"
        claim = f["inventory_claim"]
        assert claim["basis"] == block["basis"] and claim["basis_label"] == block["basis_label"], claim
        assert claim["legs"] == [{"key": g["key"], "label_ro": g["label_ro"], "label_en": g["label_en"],
                                  "days_q": g["value_q"]} for g in legs], claim["legs"]
        assert claim["total_days_q"] == block["total"]["value_q"], claim
        assert claim["sentence_ro"] and block["basis_label"]["ro"] in claim["sentence_ro"], claim
        WORK["cited"] += 1


def test_a_move_between_two_bases_is_not_a_movement(books):
    ratios, _cur, _pri = _compare(books["plus_60"], books["base"], snapshot_cur=False, snapshot_pri=True)
    for key in CLAIM_KEYS:
        row = _row(ratios, key)
        assert row["basis"] == {"current": "average_two_year_ends", "prior": "year_end_snapshot"}, row["basis"]
        assert row["movement"]["status"] == "not_comparable", (key, row["movement"])
        assert row["movement"]["reason_code"] == "basis_differs", (key, row["movement"])
        # NO DELTA EITHER (2026-09-27): the difference of an average and a
        # single year-end is the change of basis, not of the stock — a
        # served "+6 days, deteriorated" printed a coloured verdict the
        # movement sentence beside it disowned.
        d = row["delta"]
        assert d["value"] is None and d["pct_change"] is None and d["favourable"] is None, (key, d)
        assert d["reason_code"] == "basis_differs", (key, d)
    # the cycle adds the PERIOD-END split on both sides: one basis, a delta
    ccc = _row(ratios, "ccc")
    assert "basis" not in ccc and ccc["delta"]["value"] is not None, ccc["delta"]
    assert not _claims(ratios, "deteriorated") and not _claims(ratios, "improved")
    WORK["withheld"] += len(CLAIM_KEYS) * 2
    # the control: the same pair on ONE basis keeps its delta and direction
    same, _c, _p = _compare(books["plus_60"], books["base"], snapshot_cur=True, snapshot_pri=True)
    for key in CLAIM_KEYS:
        d = _row(same, key)["delta"]
        assert d["value"] is not None and d["favourable"] in ("improved", "deteriorated", "none"), (key, d)
    WORK["withheld"] += len(CLAIM_KEYS)


def test_an_improvement_on_the_snapshot_is_not_withheld(books):
    """The policy withholds a SLOW claim, not every inventory finding: the
    reverse pair (the stock falls back) on the snapshot keeps its
    improvement."""
    ratios, _cur, _pri = _compare(books["base"], books["plus_60"], snapshot_cur=True, snapshot_pri=True)
    up = [k for k in CLAIM_KEYS if _row(ratios, k)["movement"]["status"] == "crossed_up"]
    assert up and sorted(f["ratio_key"] for f in _claims(ratios, "improved")) == sorted(up), up
    for f in _claims(ratios, "improved"):
        assert "inventory_claim" not in f, "an improvement is not a slow claim"


@pytest.mark.parametrize("variant", ("base", "plus_60"))
def test_every_policy_surface_agrees_with_the_block(books, variant):
    from engine.api import pipeline as P
    from engine.serving.facts import FactsGateway

    for snapshot in (False, True):
        bk = G.predates(books[variant]) if snapshot else books[variant]
        body = G.served(bk)
        block = G.block_of(body)
        st = body["statements"]
        want = block["claim_policy"]["may_call_slow"]
        assert want is (not snapshot), (variant, snapshot, block["claim_policy"])
        gw = FactsGateway.from_envelope(st["assembled_canonical_v1"], currency="RON")
        assert gw.inventory_days()["claim_policy"] == block["claim_policy"]
        narr = P._narrate_inventory_days(st)
        assert narr["claim_policy"]["may_call_slow"] is want, narr["claim_policy"]
        assert narr["claim_policy"]["reason"] == block["claim_policy"]["reason_text"]["en"]
        WORK["surfaces"] += 3
    src = Path(P.__file__).read_text(encoding="utf-8")
    assert "You MAY call stock slow, high or" in src and "`inventory_days.claim_policy.may_call_slow`" in src, (
        "the narrator's system prompt lost the claim rule")
    # The rule sits AFTER the industry-threshold list, never inside it: it
    # was inserted between the FMCG and Manufacturing bullets, so the
    # Manufacturing threshold read as part of the inventory rule.
    rule = src.index("INVENTORY DAYS — ONE MEASURE, AND A CLAIM POLICY")
    thresholds = src.index("CRITICAL: Apply industry-appropriate thresholds.")
    manufacturing = src.index(" - Manufacturing: capex intensity, fixed-cost leverage are normal.")
    assert thresholds < manufacturing < rule, (
        "the INVENTORY DAYS rule sits inside the industry-threshold list")


def _texts(obj: Any, path: str = "") -> List[Tuple[str, str]]:
    """Every string of a served body, with its path — the block itself (its
    own policy sentence says stock 'cannot be called slow') excluded."""
    out: List[Tuple[str, str]] = []
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k in ("inventory_days", "claim_policy"):
                continue
            out += _texts(v, "%s.%s" % (path, k))
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            out += _texts(v, "%s[%d]" % (path, i))
    elif isinstance(obj, str):
        out.append((path, obj))
    return out


@pytest.mark.parametrize("variant", ("plus_20", "plus_60"))
def test_no_served_text_of_a_snapshot_period_calls_the_stock_slow(books, variant):
    ratios, cur, _pri = _compare(books[variant], books["base"], snapshot_cur=True, snapshot_pri=True)
    served = {"period": cur, "comparatives": ratios}
    hits = [(p, t[:160]) for p, t in _texts(served) if SLOW.search(t)
            and re.search(r"stock|inventor|stoc", t, re.IGNORECASE)]
    assert not hits, "%s: a snapshot period calls its stock slow: %s" % (variant, hits[:5])
    WORK["texts"] += 2  # the period and its comparatives, every string
    STRINGS["scanned"] += len(_texts(served))


def test_the_scan_sees_a_planted_slow_claim():
    """Non-vacuity of the text scan."""
    planted = {"insights": [{"claim": "Stock is slow-moving: inventory days rose to 137."}],
               "x": {"inventory_days": {"claim_policy": {"reason_text": "stock cannot be called slow"}}}}
    hits = [p for p, t in _texts(planted) if SLOW.search(t) and re.search(r"stock|inventor|stoc", t, re.I)]
    assert hits == [".insights[0].claim"], hits
    assert SLOW.search("stocurile se rotesc lent")


def test_zz_scope():
    print("\nSCOPE stock-claim-policy: corpus agras + tmp variants (+20,000,000 / +60,000,000 materials "
          "on credit) through the real write path, GET /api/period and the served comparatives; "
          "average, snapshot and mixed-basis pairs")
    units = sum(WORK.values())
    print("GATE-WORK stock-claim-policy units=%d withheld=%d cited=%d surfaces=%d texts=%d strings=%d"
          % (units, WORK["withheld"], WORK["cited"], WORK["surfaces"], WORK["texts"], STRINGS["scanned"]))
    assert WORK["withheld"] >= 4 and WORK["cited"] >= 4 and WORK["surfaces"] >= 12, WORK
    assert STRINGS["scanned"] >= 5000, STRINGS
