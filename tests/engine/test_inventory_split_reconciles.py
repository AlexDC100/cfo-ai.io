"""INVENTORY-SPLIT-RECONCILES — the split by stock type adds up to the
balance sheet's stock, to the cent, on every served book (owner spec
2026-09-26, inventory days point 1; design B1: "Σ groups + other = served inventory_net
to the cent (gate it; refuse if not)").

The block (`engine.ratios.inventory_days`) prints three legs and "alte
stocuri" beside ONE balance-sheet stock. If an account falls out of the
split, the legs describe a different stock from the one the balance sheet
serves, and every day figure built on them is wrong while looking precise.

WHAT THIS REDS ON, AFTER THE REPAIR (TC-11) — on the ten corpus books that
carry stock (185 class-3 accounts), each through the REAL write path and GET
/api/period, read against the gate's OWN parse of the trial balance (never
the stored evidence the block was built from):

  · the served inventory_net (Σ canonical_bs inventory rows) is not Σ
    (sf_d - sf_c) of the file's class-3 accounts, to the cent;
  · Σ legs + alte stocuri (period end) is not that stock, to the cent — or
    the block says `reconciled` with a non-zero difference;
  · where the file carries the fiscal-year opening, Σ legs + alte stocuri
    (opening) is not Σ (si_d - si_c) of the same accounts;
  · a non-zero class-3 account of the file is missing from the split, or
    listed twice, or listed in a part the ruling does not give it (the
    owner's literal groups, restated in `_inventory_gate_books.OWNER_*`: a
    39x provision nets against ITS group — 391/392 materials, 393/394
    finished goods, 397 merchandise, the rest alte stocuri);
  · a part's stock is not the sum of the file's balances of the accounts it
    lists (an amount booked to the wrong part);
  · a split that does NOT reconcile is served with days instead of refusing
    (`not_reconciled`, constructed below by dropping one stored account);
  · a book with no stock lines serves any number.

Plant log: docs/engine_book/gates.md "inventory-split-reconciles".
"""

from __future__ import annotations

import copy
from typing import Any, Dict, List

import pytest

import _inventory_gate_books as G

CENT = 0.005
WORK = {"books": 0, "accounts": 0, "openings": 0, "refusals": 0}


def _parts(block: Dict[str, Any]) -> List[Dict[str, Any]]:
    return list(block["groups"]) + [block["other"]]


@pytest.mark.parametrize("case", G.STOCK_BOOKS)
def test_the_split_adds_up_to_the_balance_sheet_stock_to_the_cent(case):
    body = G.served(G.corpus_book(case), cache_key=case)
    block = G.block_of(body)
    leaves = G.class3_leaves(G.parsed_rows(case))
    file_closing = round(sum(c for _o, c in leaves.values()), 2)
    served = G.canonical_inventory(body["statements"])
    assert abs(served - file_closing) < CENT, (
        "%s: the balance sheet serves %.2f of stock, the file's class-3 accounts close at %.2f"
        % (case, served, file_closing))
    parts_closing = round(sum(p["stock"]["closing"] for p in _parts(block)), 2)
    assert abs(parts_closing - served) < CENT, (
        "%s: legs + alte stocuri = %.2f beside a served stock of %.2f" % (case, parts_closing, served))
    rec = block["reconciliation"]
    assert rec["status"] == "reconciled" and abs(rec["difference"]) < CENT, (case, rec)
    assert abs(rec["served_inventory_net"] - served) < CENT, (case, rec, served)
    if block["opening"]["status"] == "available":
        file_opening = round(sum(o for o, _c in leaves.values()), 2)
        parts_opening = round(sum(p["stock"]["opening"] for p in _parts(block)), 2)
        assert abs(parts_opening - file_opening) < CENT, (
            "%s: legs + alte stocuri at the opening = %.2f, the file's = %.2f"
            % (case, parts_opening, file_opening))
        WORK["openings"] += 1
    WORK["books"] += 1


@pytest.mark.parametrize("case", G.STOCK_BOOKS)
def test_every_stock_account_sits_in_exactly_one_part_the_ruling_gives_it(case):
    block = G.block_of(G.served(G.corpus_book(case), cache_key=case))
    leaves = G.class3_leaves(G.parsed_rows(case))
    listed: Dict[str, List[str]] = {}
    for p in _parts(block):
        for code in p["accounts"]:
            listed.setdefault(code, []).append("%s/stock" % p["key"])
        for code in p["provision_accounts_present"]:
            listed.setdefault(code, []).append("%s/provision" % p["key"])
    live = {code for code, (o, c) in leaves.items()
            if abs(c) >= CENT or (block["opening"]["status"] == "available" and abs(o) >= CENT)}
    missing = sorted(live - set(listed))
    assert not missing, "%s: stock accounts missing from the split: %s" % (case, missing)
    twice = sorted(code for code, where in listed.items() if len(where) > 1)
    assert not twice, "%s: listed in two parts: %s" % (case, {c: listed[c] for c in twice})
    stray = sorted(set(listed) - set(leaves))
    assert not stray, "%s: the split lists accounts the file does not carry: %s" % (case, stray)
    for code, where in sorted(listed.items()):
        key, kind = G.owner_group(code)
        assert where == ["%s/%s" % (key, kind)], (
            "%s: account %s is in %s; the ruling gives it %s/%s" % (case, code, where[0], key, kind))
    # Each part's stock is the file's balances of exactly the accounts it lists.
    for p in _parts(block):
        codes = p["accounts"] + p["provision_accounts_present"]
        want = round(sum(leaves[c][1] for c in codes), 2)
        assert abs(p["stock"]["closing"] - want) < CENT, (case, p["key"], p["stock"]["closing"], want)
        if p["stock"]["opening"] is not None:
            want_o = round(sum(leaves[c][0] for c in codes), 2)
            assert abs(p["stock"]["opening"] - want_o) < CENT, (case, p["key"], p["stock"]["opening"], want_o)
    WORK["accounts"] += len(live)


def test_the_owners_own_book_reconciles_to_its_stock_to_the_cent():
    """Scandia Food FY2025 as its committed capture stores it (no workbook:
    the persisted line items and envelope): the split of its 55,341,817.75
    of stock adds up to the balance sheet's stock to the cent, every class-3
    line item in the part the ruling gives it."""
    import _served_books as SB

    body = SB.served_body("scandia_baseline")
    block = G.block_of(body)
    served = G.canonical_inventory(body["statements"])
    assert abs(served - 55341817.75) < CENT, served
    parts_closing = round(sum(p["stock"]["closing"] for p in _parts(block)), 2)
    assert abs(parts_closing - served) < CENT, (parts_closing, served)
    assert block["reconciliation"]["status"] == "reconciled", block["reconciliation"]
    bs_lines = {}
    for li in SB.book("scandia_baseline").line_items:
        code = str(li.get("ro_account_code") or "")
        if str(li.get("statement") or "").upper() == "BS" and G.digits(code).startswith("3"):
            bs_lines[code] = bs_lines.get(code, 0.0) + float(li.get("amount") or 0.0)
    assert abs(round(sum(bs_lines.values()), 2) - served) < CENT, (sum(bs_lines.values()), served)
    for p in _parts(block):
        for code in p["accounts"]:
            assert G.owner_group(code) == (p["key"], "stock"), (code, p["key"])
        for code in p["provision_accounts_present"]:
            assert G.owner_group(code) == (p["key"], "provision"), (code, p["key"])
        want = round(sum(bs_lines.get(c, 0.0) for c in p["accounts"] + p["provision_accounts_present"]), 2)
        assert abs(p["stock"]["closing"] - want) < CENT, (p["key"], p["stock"]["closing"], want)
    live = {c for c, v in bs_lines.items() if abs(v) >= CENT}
    listed = {c for p in _parts(block) for c in p["accounts"] + p["provision_accounts_present"]}
    assert live == listed, (sorted(live - listed), sorted(listed - live))
    WORK["books"] += 1
    WORK["accounts"] += len(live)


def test_a_split_that_does_not_reconcile_refuses_rather_than_serving_days():
    """Constructed plant on the frozen Scandia golden (saga_10_col: three
    groups, three provisions, four alte-stocuri accounts): drop ONE stored
    stock account — a provision, then a stock line — from the period's
    evidence and serve it again. The legs no longer add up to the balance
    sheet's stock; the block refuses every figure with `not_reconciled`."""
    bk = G.corpus_book("saga_10_col")
    evidence = bk.period["assembled_canonical_v1"]["inventory_stock"]
    for drop in ("39", "345"):
        period = copy.deepcopy(bk.period)
        ev = period["assembled_canonical_v1"]["inventory_stock"]
        before = len(ev["accounts"])
        dropped = [a for a in ev["accounts"] if G.digits(a["code"]).startswith(drop)][:1]
        assert dropped and dropped[0]["closing"], (drop, evidence["accounts"][:3])
        ev["accounts"] = [a for a in ev["accounts"] if a is not dropped[0]]
        assert len(ev["accounts"]) == before - 1
        period["assembled_canonical_v1"].pop("inventory_days", None)
        planted = G.with_org(bk)
        planted.period = period
        block = G.block_of(G.served(planted))
        assert block["reconciliation"]["status"] == "not_reconciled", (drop, block["reconciliation"])
        assert abs(block["reconciliation"]["difference"] + dropped[0]["closing"]) < CENT, (
            drop, block["reconciliation"], dropped[0])
        assert block["total"]["value"] is None and block["total"]["reason"]["code"] == "not_reconciled"
        assert all(g["value"] is None and g["closing_value"] is None for g in block["groups"]), drop
        assert block["claim_policy"]["may_call_slow"] is False
        assert block["total"]["reason"]["text_ro"] and block["total"]["reason"]["text_en"]
        WORK["refusals"] += 1


@pytest.mark.parametrize("case", G.NO_STOCK_BOOKS)
def test_a_book_without_stock_serves_no_days(case):
    block = G.block_of(G.served(G.corpus_book(case), cache_key=case))
    assert not G.class3_leaves(G.parsed_rows(case)) or all(
        abs(c) < CENT for _o, c in G.class3_leaves(G.parsed_rows(case)).values()), case
    assert block["total"]["value"] is None and block["total"]["reason"]["code"] == "no_stock_lines", (
        case, block["total"])
    assert all(g["value"] is None for g in block["groups"]), case
    WORK["refusals"] += 1


def test_zz_scope():
    print("\nSCOPE inventory-split-reconciles: corpus books %s through the real write path and "
          "GET /api/period, against the gate's own parse of each file"
          % ", ".join(G.STOCK_BOOKS))
    print("GATE-WORK inventory-split-reconciles units=%d books=%d openings=%d refusals=%d"
          % (WORK["accounts"] + WORK["books"] + WORK["openings"] + WORK["refusals"],
             WORK["books"], WORK["openings"], WORK["refusals"]))
    assert WORK["books"] == len(G.STOCK_BOOKS) + 1, WORK
    assert WORK["accounts"] >= 150, WORK
    assert WORK["refusals"] >= 7, WORK
