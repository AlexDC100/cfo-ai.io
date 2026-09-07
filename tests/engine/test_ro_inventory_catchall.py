"""N5 — A CLASS-LEVEL CATCH-ALL MAY NOT ABSORB AN ACCOUNT SILENTLY.

WHAT THIS FILE IS ABOUT
=======================
`canonical_adapter._RAS_TO_CANONICAL` resolves an account to a canonical
row by LONGEST PREFIX. Its last class-3 entry is a one-character floor,
`("3", "inventory_raw_materials")`. Anything in class 3 that matched no
specific rule therefore arrived in the balance sheet labelled **Raw
materials**, and the only trace was the bare `"3"` that
`_matched_ras_prefix` put in the row's `account_codes` — which is
exactly the tell the owner spotted in the deployed Agras report:

    Raw materials (3, 301)      RON 4,316,023.15

Measured on the committed corpus BEFORE the repair (the amounts are the
accounts' own signed balances, from
`corpus/<case>/expected/classification.json`):

    saga_10_col_retail    378.51 … 378.98 (22 accounts)  -1,229,164.37
    saga_10_col_agras     348.102 661,216.57 · 378.078 0.63 · 378.080 0.17
    saga_10_col_carniprod 348 -357,303.26
    saga_10_col           346101 9,981.30 · 348101 455,356.00

The retail book is the one that shows what the defect costs a reader: it
printed a row reading `Raw materials (3)  RON -1,229,164.37` — a NEGATIVE
raw-materials line, on a retailer holding no raw materials, made entirely
of the price differential held against `371` merchandise. After the
repair that row does not exist and merchandise for resale is stated at
cost (7,917,059.01 - 1,229,164.37 = 6,687,894.64).

WHAT THIS GATE REDS ON, AFTER THE REPAIR (TC-11)
================================================
1. `test_no_corpus_row_carries_a_class_level_account_code` — any served
   row in ANY corpus case whose `account_codes` carries a bare
   one-character class digit. That is the fingerprint of a class-level
   catch-all absorption, whatever class it happens in, and the failure
   message names the row, the code, the amount and the leaf accounts, so
   the reader is told WHICH account was swallowed and for HOW MUCH
   instead of being left with the bare `(3)`.
2. `test_the_price_differential_family_routes_to_the_stock_it_adjusts` —
   308/348/378/388 (and the 34x product family) moving back onto the
   catch-all, or onto the wrong sibling.
3. `test_the_catchall_is_still_the_floor_and_is_the_only_one` — a second
   one-character rule appearing in the canonical table, or the class-3
   floor being deleted (deleting it would route unknown class-3 stock to
   `unclassified_debit`, which takes real inventory OUT of
   `inventory_net` and moves DIO / quick ratio / inventory turnover with
   it — a bigger change than this repair, and not one to make by
   accident).
4. `test_the_repair_moved_nothing_into_or_out_of_inventory` — the sum of
   the inventory leaves per book, which the repair must leave untouched
   because it only moves amounts between siblings of one aggregate.

WHAT IT CANNOT SEE
==================
* Whether the destinations are the RIGHT ones under OMFP 1802. It pins
  that 378 lands with 371 and 348 with 345; it cannot tell you that is
  what the standard says. The plan-de-conturi reading is recorded in the
  comment beside the rules, not proven here.
* Any book that is not in the corpus. 32x (stocuri în curs de
  aprovizionare) and 36x (active biologice) are still on the floor by a
  stated decision; the FIRST corpus case that carries one turns gate 1
  red, which is the intended behaviour — the choice gets made with a
  real book in hand rather than defaulted to "Raw materials".
* The RENDERED report. This asserts over the served envelope; the row
  label a reader sees is the frontend's job.

Python 3.9 — no `match`, no `X | Y`.
"""

from __future__ import annotations

import json
import os
from typing import Any, Dict, List

import pytest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CORPUS = os.path.join(REPO_ROOT, "corpus")

#: The result row builds its `account_codes` by TRUNCATING every
#: contributing code to one character on purpose
#: (`canonical_adapter.py`, `result_prefixes`), so a one-character code
#: there is the documented shape and not an absorption. Measured: it is
#: the only place in the corpus where a one-character code is legitimate
#: (`saga_compact_6_col` → `current_year_profit` codes `['6', '7']`).
_TRUNCATING_ROWS = ("current_year_profit", "current_year_loss")

#: Every inventory leaf. The repair moves amounts BETWEEN these; the sum
#: is what must not move.
_INVENTORY_LEAVES = (
    "inventory_raw_materials",
    "inventory_consumables",
    "inventory_wip",
    "inventory_finished_goods",
    "inventory_merchandise_resale",
    "inventory_packaging",
    "inventory_at_third_parties",
    "inventory_provisions",
)

#: The inventory total per case as it stood BEFORE the repair, read off
#: the pre-repair goldens. The repair is a re-partition, so these are
#: also the totals after it.
_INVENTORY_TOTAL_BEFORE = {
    "saga_10_col": 12315518.61,
    "saga_10_col_agras": 8933332.42,
    "saga_10_col_carniprod": 9796026.80,
    "saga_10_col_realestate": 67821213.71,
    "saga_10_col_retail": 6795205.57,
}


def _cases() -> List[str]:
    out = []
    for name in sorted(os.listdir(CORPUS)):
        served = os.path.join(CORPUS, name, "expected", "served_envelope.json")
        if os.path.isfile(served):
            out.append(name)
    return out


def _rows(case: str) -> List[Dict[str, Any]]:
    path = os.path.join(CORPUS, case, "expected", "served_envelope.json")
    with open(path, "r", encoding="utf-8") as handle:
        return list(json.load(handle).get("rows") or [])


@pytest.mark.parametrize("case", _cases())
def test_no_corpus_row_carries_a_class_level_account_code(case):
    """A bare class digit in `account_codes` means a catch-all absorbed
    an account into a row that names a DIFFERENT thing."""
    offences = []
    for row in _rows(case):
        if row.get("id") in _TRUNCATING_ROWS:
            continue
        for code in row.get("account_codes") or []:
            if len(str(code)) == 1:
                offences.append(
                    "row %r (%r) carries the class-level code %r for "
                    "%s — the accounts it actually holds are %s. A "
                    "class-level catch-all absorbed at least one of them, "
                    "so the row's label names a stock family the account "
                    "does not belong to."
                    % (row.get("id"), row.get("label"), str(code),
                       format(row.get("amount"), ",.2f"),
                       ", ".join(str(x) for x in (row.get("leaf_ids") or [])))
                )
    assert not offences, "%s: %s" % (case, "\n  ".join(offences))


def test_the_price_differential_family_routes_to_the_stock_it_adjusts():
    """308/348/378/388 adjust their OWN stock family, not raw materials."""
    from engine.country_packs.ro_romania.canonical_adapter import (
        _RAS_TO_CANONICAL_SORTED,
    )

    def resolve(code):
        for prefix, canonical in _RAS_TO_CANONICAL_SORTED:
            if code.startswith(prefix):
                return prefix, canonical
        return None, None

    expected = {
        # the differential family — the accounts measured on the corpus
        "308": "inventory_raw_materials",
        "348": "inventory_finished_goods",
        "348.102": "inventory_finished_goods",   # agras, 661,216.57
        "348101": "inventory_finished_goods",    # saga_10_col, 455,356.00
        "378": "inventory_merchandise_resale",
        "378.51": "inventory_merchandise_resale",  # retail, one of 22
        "378.080": "inventory_merchandise_resale",  # agras, 0.17
        "388": "inventory_packaging",
        # the 34x products family the differential attaches to
        "346101": "inventory_finished_goods",    # saga_10_col, 9,981.30
        "347": "inventory_finished_goods",
        "345": "inventory_finished_goods",
        # unchanged neighbours, so the repair cannot have widened
        "301": "inventory_raw_materials",
        "302": "inventory_consumables",
        "371": "inventory_merchandise_resale",
        "381": "inventory_packaging",
        "398": "inventory_provisions",
    }
    wrong = []
    for code, want in sorted(expected.items()):
        prefix, got = resolve(code)
        if got != want or prefix == "3":
            wrong.append(
                "%s resolved through prefix %r to %r; expected %r%s"
                % (code, prefix, got, want,
                   " (it fell through to the class-3 catch-all)"
                   if prefix == "3" else "")
            )
    assert not wrong, "\n  ".join(wrong)


def test_the_catchall_is_still_the_floor_and_is_the_only_one():
    from engine.country_packs.ro_romania.canonical_adapter import (
        _RAS_TO_CANONICAL,
    )

    single = [(p, c) for p, c in _RAS_TO_CANONICAL if len(p) == 1]
    assert single == [("3", "inventory_raw_materials")], (
        "the canonical table's one-character rules are %r. Exactly one is "
        "expected: the class-3 floor. A NEW one-character rule is a new "
        "silent absorber; REMOVING this one sends unknown class-3 stock "
        "to `unclassified_debit`, which takes real inventory out of "
        "inventory_net and moves DIO, quick ratio and inventory turnover "
        "with it." % (single,)
    )


@pytest.mark.parametrize("case", sorted(_INVENTORY_TOTAL_BEFORE))
def test_the_repair_moved_nothing_into_or_out_of_inventory(case):
    """The re-partition is inside `inventory_net`; the aggregate holds."""
    total = 0.0
    seen = False
    for row in _rows(case):
        if row.get("id") in _INVENTORY_LEAVES:
            total += float(row.get("amount") or 0.0)
            seen = True
    expected = _INVENTORY_TOTAL_BEFORE[case]
    assert seen, "%s carries no inventory rows at all" % case
    assert abs(total - expected) < 0.005, (
        "%s inventory_net is %s; before the class-3 repair it was %s. The "
        "repair only re-partitions amounts between inventory leaves — a "
        "moved total means something entered or left the aggregate."
        % (case, format(total, ",.2f"), format(expected, ",.2f"))
    )
