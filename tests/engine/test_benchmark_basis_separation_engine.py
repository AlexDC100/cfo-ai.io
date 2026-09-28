"""BENCHMARK-BASIS-SEPARATION (engine half) — the sector document keeps its
filed basis and never carries the split (owner spec 2026-09-26, inventory days point 3;
design B3: "Sector row key inventory_days_on_turnover: filed stock ÷ the filed net turnover ×
365 on BOTH sides … Never rendered beside the split; keyed by metric
identity").

Filed accounts are abridged: a sector can only be measured as year-end
stock ÷ net turnover. The analysis's inventory days are split by stock type
over the flow that moves each. The two are different measures; a sector
band hung on the split card — or the split restated as the company side of
the filed row — compares them.

The world: create_app() over the tenancy double (signature-verifying
bearers), five periods persisted through the production write path in one
workspace with CAEN 1011 (a sector the bundled dataset measures): the four
corpus books and the frozen Scandia golden (corpus/saga_10_col). Every
document is read from GET /api/period/{id}/sector-benchmark, every split
from GET /api/period/{id}, both un-intercepted.

WHAT THIS REDS ON, AFTER THE REPAIR (TC-11):
  · a ratio card built on the split (dio, inventory_turnover, ccc) served
    with `band_source: sector`, or carrying any quartile field
    (median/p25/p75/n/position/vs_sector);
  · the dio card's reason not `definition_differs` pointing at
    `inventory_days_on_turnover`;
  · the filed row's company figure not filed stock ÷ net turnover × 365
    recomputed here from the served statements (canonical_bs inventory
    rows, net turnover), or resting on any basis but the filed restatement
    (a ratio-table figure, the split's total), or its definition not
    declaring that it differs from the dio card;
  · anything of the split inside the sector document (its schema, its legs,
    its claim policy);
  · the served block's pointer to the filed row not `never_compare`, or the
    two not keyed by different metric identities;
  · the sector document failing its own law (`check_document_law`).

Plant log: docs/engine_book/gates.md "benchmark-basis-separation".
"""
from __future__ import annotations

import json
import types
from typing import Any, Dict

import pytest

import _inventory_gate_books as G
import _real_app_comparatives as RA
import firm_postgrest_double as D

USER = "7b0c0f3e-0000-4000-8000-00000000d3b1"
ORG = "0c0f0000-0000-4000-8000-0000000000d3"
CAEN = "1011"
BOOKS = {"p-agras": "saga_10_col_agras", "p-carniprod": "saga_10_col_carniprod",
         "p-retail": "saga_10_col_retail", "p-realestate": "saga_10_col_realestate",
         "p-frozen": "saga_10_col"}
SPLIT_CARDS = ("dio", "inventory_turnover", "ccc")
QUARTILE_FIELDS = ("median", "p25", "p75", "n", "position", "vs_sector", "sector_key")
ROW = "inventory_days_on_turnover"
OWNER = {"ro": "bază depusă (stoc ÷ cifra de afaceri) — nu aceeași cu zilele de stoc din analiză",
         "en": "filed basis (stock ÷ net turnover) — not the same as the inventory days of this analysis"}
WORK = {"cards": 0, "rows": 0, "docs": 0, "pointers": 0}


@pytest.fixture(scope="module")
def world() -> Dict[str, Any]:
    app = RA.build_app()
    periods = []
    for pid, case in sorted(BOOKS.items()):
        bk = G.corpus_book(case)
        periods.append((types.SimpleNamespace(period=bk.period, line_items=bk.line_items),
                        pid, ORG, "2025-01-01", "2025-12-31"))
    double = RA.seed_double(
        orgs=[{"id": ORG, "name": "Sector separation", "default_currency": "RON", "caen_code": CAEN}],
        memberships=[{"user_id": USER, "org_id": ORG, "role": "owner",
                      "created_at": "2026-01-01T00:00:00+00:00"}],
        periods=periods)
    out: Dict[str, Any] = {}
    with RA.installed(double):
        bearer = D.mint_jwt(USER)
        for pid in sorted(BOOKS):
            doc = RA.get(app, "/api/period/%s/sector-benchmark" % pid, bearer, ORG)
            body = RA.get(app, "/api/period/%s" % pid, bearer, ORG)
            assert doc.status_code == 200 and body.status_code == 200, (pid, doc.status_code, body.status_code)
            out[pid] = {"doc": doc.json(), "body": body.json()}
    return out


@pytest.mark.parametrize("pid", sorted(BOOKS))
def test_no_card_built_on_the_split_carries_a_sector_band(world, pid):
    doc = world[pid]["doc"]
    assert doc["status"] == "ok" and doc["caen"] == CAEN, (pid, doc.get("status"), doc.get("reason"))
    for key in SPLIT_CARDS:
        card = doc["ratio_cards"][key]
        assert card["band_source"] == "general", (pid, key, card)
        leaked = sorted(f for f in QUARTILE_FIELDS if f in card)
        assert not leaked, "%s: the %s card carries sector fields %s" % (pid, key, leaked)
        WORK["cards"] += 1
    dio = doc["ratio_cards"]["dio"]
    assert dio["reason"]["code"] == "definition_differs" and dio["reason"]["inputs"] == [ROW], (pid, dio)


@pytest.mark.parametrize("pid", sorted(BOOKS))
def test_the_filed_row_is_filed_stock_over_net_turnover(world, pid):
    doc, body = world[pid]["doc"], world[pid]["body"]
    row = [r for r in doc["rows"] if r["key"] == ROW][0]
    st = body["statements"]
    company = row["company"]
    assert company["basis"] == "restated_on_filed_basis", (pid, company["basis"])
    assert row["definition"]["differs_from_card"] is True and row["definition"]["card_key"] == "dio", row["definition"]
    stock = G.canonical_inventory(st)
    turnover = st["assembled_pl"]["revenue"]
    names = [op.get("name") for op in company["operands"]]
    assert names == ["inventory", "net_turnover"], (pid, names)
    assert abs(company["operands"][0]["value"] - stock) < 0.005, (pid, company["operands"][0], stock)
    if company["value"] is None:
        # the ONE margin rule ruled the turnover negligible (the developer)
        assert row["status"] == "company_absent", (pid, row["status"])
        assert row["reason"]["code"] == "company_turnover_negligible", (pid, row["reason"])
    else:
        assert abs(company["value"] - stock / turnover * 365.0) < 1e-9, (pid, company["value"], stock, turnover)
    WORK["rows"] += 1


@pytest.mark.parametrize("pid", sorted(BOOKS))
def test_nothing_of_the_split_travels_into_the_sector_document(world, pid):
    doc, body = world[pid]["doc"], world[pid]["body"]
    text = json.dumps(doc, ensure_ascii=False)
    block = G.block_of(body)
    for token in ("inventory_days/1", "finished_goods_wip", "claim_policy", "cost_of_production_sold",
                  "split_and_average", "average_two_year_ends", "year_end_snapshot"):
        assert token not in text, "%s: the sector document carries %r" % (pid, token)
    ptr = block["filed_basis_pointer"]
    assert ptr["sector_row_key"] == ROW and ptr["never_compare"] is True, ptr
    assert ptr["label_ro"] == OWNER["ro"] and ptr["label_en"] == OWNER["en"], ptr
    assert block["schema"] != doc["schema"] and ROW not in {g["key"] for g in block["groups"]}
    from engine.benchmarks_ro import sector as S
    assert S.check_document_law(doc) == [], (pid, S.check_document_law(doc))
    WORK["docs"] += 1
    WORK["pointers"] += 1


def test_the_card_map_never_equates_the_split_with_a_filed_row():
    from engine.benchmarks_ro import sector as S

    assert not set(SPLIT_CARDS) & set(S.SAME_AS_CARD.values()), S.SAME_AS_CARD
    assert S.CARD_DEFINITION_DIFFERS["dio"][0] == ROW
    assert "never compared" in S.CARD_DEFINITION_DIFFERS["dio"][1]
    assert S.DIRECTION.get(ROW) == "lower" and "dio" not in S.DIRECTION


def test_zz_scope():
    print("\nSCOPE benchmark-basis-separation-engine: %s through create_app, GET /api/period/{id}"
          "/sector-benchmark and GET /api/period/{id}, CAEN %s" % (", ".join(sorted(BOOKS.values())), CAEN))
    units = sum(WORK.values())
    print("GATE-WORK benchmark-basis-separation-engine units=%d cards=%d rows=%d docs=%d pointers=%d"
          % (units, WORK["cards"], WORK["rows"], WORK["docs"], WORK["pointers"]))
    assert WORK["cards"] == 3 * len(BOOKS) and WORK["rows"] == len(BOOKS), WORK
