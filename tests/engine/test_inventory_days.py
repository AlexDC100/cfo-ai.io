"""INVENTORY DAYS — the ONE served block (engine.ratios.inventory_days,
schema inventory_days/1; owner spec 2026-09-26, inventory days; design B1-B5).

Scandia Food FY2025 printed 48.8 / 52.5 / 95.3 inventory days for one stock
of 55,341,817.75 — three denominators under one name, all on one day. The
block splits the stock by type (materials 301-303/308 over 601+602+603,
finished goods + WIP 331/341/345/348 over the cost of production sold,
merchandise 371/378 over 607, "alte stocuri" inside the total), takes the
average of the fiscal-year opening and the period end where the file
carries the opening, and says what it may claim.

WHAT THIS REDS ON, AFTER THE REPAIR (TC-11):

  · RECONCILIATION — on any committed corpus book, Σ groups + alte stocuri
    (period end) is not the served inventory_net to the cent; or a book
    whose evidence misses a stock account does not REFUSE (`not_reconciled`)
    (constructed plant, below);
  · THE FORMULA — any group's days, or the total's, that is not recomputed
    here from the evidence and the served line items: group stock (on the
    served basis) / its flow x period days; total = all stock / (cost of
    production sold + 607) x period days; cost of production sold = total
    operating expense - 607 - net 711 (0 on a book with no own production);
  · BASIS — a block that calls itself an average without an opening at the
    fiscal-year start for every group, or whose average is not
    (opening + closing) / 2; a snapshot whose label is not "stoc la 31
    decembrie — o singură zi"; a monthly basis without 13 points;
  · REFUSAL — a refused net 711 that does not refuse the finished-goods leg
    and the total with its reason; the corpus developer (no own product sold,
    merchandise with no 607) serving any number; a zero-stock leg serving 0
    days instead of refusing;
  · CLAIM POLICY — `may_call_slow` true on a snapshot or a refused split;
    false on a served split on an average;
  · SEASONALITY — a food / FMCG book (CAEN 10/11/463/471/472 or the fmcg
    workspace key) not flagged on the snapshot and on the two-year-end
    average; flagged on the monthly basis (which removes the effect);
  · SERVED — GET /api/period (the real router over the corpus books) not
    serving `assembled_metrics.inventory_days` equal to
    `statements.inventory_days`.

Every committed book here is the anonymised corpus or a constructed book;
no client book is read.
"""

from __future__ import annotations

import copy
import json
import sys
from pathlib import Path
from typing import Any, Dict, List

import pytest

from engine.ratios import inventory_days as ID

REPO = Path(__file__).resolve().parents[2]
FIRM = REPO / "tests" / "engine" / "fixtures" / "firm"
BOOKS = ("agras", "carniprod", "realestate", "retail")
WORK = {"units": 0, "groups_recomputed": 0, "refusals": 0}


def _fixture(book: str) -> Dict[str, Any]:
    return json.loads((FIRM / ("saga_10_col_%s.json" % book)).read_text(encoding="utf-8"))


def _build(fx: Dict[str, Any], **over: Any) -> Dict[str, Any]:
    st = fx["statements"]
    kwargs = dict(
        line_items=fx["line_items"],
        assembled_pl=st["assembled_pl"],
        served_inventory_net_value=ID.served_inventory_net(
            dict(st, canonical_bs=fx["envelope"]["canonical_bs"])),
        period_days=365.0,
        period_end=fx["period_end"],
    )
    evidence = over.pop("evidence", fx["envelope"].get("inventory_stock"))
    kwargs.update(over)
    return ID.build(evidence, **kwargs)


def _digits(code: str) -> str:
    return "".join(c for c in str(code) if c.isdigit())


# ── reconciliation ─────────────────────────────────────────────────────────


@pytest.mark.parametrize("book", BOOKS)
def test_the_groups_add_up_to_the_served_stock_to_the_cent(book):
    fx = _fixture(book)
    block = _build(fx)
    served = ID.served_inventory_net(dict(fx["statements"], canonical_bs=fx["envelope"]["canonical_bs"]))
    total = sum(g["stock"]["closing"] for g in block["groups"]) + block["other"]["stock"]["closing"]
    assert abs(total - served) < 0.005, (book, total, served)
    assert block["reconciliation"]["status"] == "reconciled", block["reconciliation"]
    # Every class-3 account of the evidence sits in exactly one group.
    listed: List[str] = []
    for part in block["groups"] + [block["other"]]:
        listed += part["accounts"] + part["provision_accounts_present"]
    evidence_codes = [a["code"] for a in fx["envelope"]["inventory_stock"]["accounts"]
                      if a["closing"] or a.get("opening")]
    assert sorted(listed) == sorted(evidence_codes), book
    WORK["units"] += len(evidence_codes)


def test_a_stock_account_missing_from_the_evidence_refuses_the_split():
    """Constructed plant: drop one stock account from the stored evidence —
    the groups no longer add up to the served stock and the block refuses
    rather than serve a split of a different stock."""
    fx = _fixture("agras")
    evidence = copy.deepcopy(fx["envelope"]["inventory_stock"])
    evidence["accounts"] = [a for a in evidence["accounts"] if not _digits(a["code"]).startswith("345")]
    block = _build(fx, evidence=evidence)
    assert block["reconciliation"]["status"] == "not_reconciled"
    assert block["total"]["value"] is None and block["total"]["reason"]["code"] == "not_reconciled"
    assert all(g["value"] is None for g in block["groups"])
    WORK["refusals"] += 1


# ── the formula, recomputed from the evidence ─────────────────────────────


def _flows(line_items: List[Dict[str, Any]]) -> Dict[str, float]:
    out = {"601": 0.0, "602": 0.0, "603": 0.0, "607": 0.0, "own": 0.0}
    for li in line_items:
        if li.get("statement") == "BS":
            continue
        d = _digits(li.get("ro_account_code") or "")
        for c in ("601", "602", "603", "607"):
            if d.startswith(c):
                out[c] += float(li["amount"])
        if d.startswith(("701", "702", "703")):
            out["own"] += float(li["amount"])
    return out


_GROUP_PREFIX = {"materials": (("301", "302", "303", "308"), ("391", "392")),
                 "finished_goods_wip": (("331", "341", "345", "348"), ("393", "394")),
                 "merchandise": (("371", "378"), ("397",))}


@pytest.mark.parametrize("book", ("agras", "carniprod", "retail"))
def test_every_days_figure_is_its_stock_over_its_flow(book):
    fx = _fixture(book)
    block = _build(fx)
    ev = fx["envelope"]["inventory_stock"]
    pl = fx["statements"]["assembled_pl"]
    flows = _flows(fx["line_items"])
    net_711 = pl["inventory_variation"]["value"]
    fg_stock = [a for a in ev["accounts"] if _digits(a["code"]).startswith(_GROUP_PREFIX["finished_goods_wip"][0])]
    no_own_production = (net_711 == 0 and flows["own"] == 0
                         and not any(a["closing"] or a["opening"] for a in fg_stock))
    cps = 0.0 if no_own_production else pl["total_operating_expense"] - flows["607"] - net_711
    assert block["cost_of_production_sold"]["value"] == pytest.approx(cps, abs=0.01), book

    def stock(prefixes, provisions, when):
        return sum(a[when] for a in ev["accounts"]
                   if _digits(a["code"]).startswith(prefixes + provisions))

    flow_of = {"materials": flows["601"] + flows["602"] + flows["603"],
               "finished_goods_wip": cps, "merchandise": flows["607"]}
    for g in block["groups"]:
        prefixes, provisions = _GROUP_PREFIX[g["key"]]
        opening = stock(prefixes, provisions, "opening")
        closing = stock(prefixes, provisions, "closing")
        assert g["stock"]["closing"] == pytest.approx(closing, abs=0.01), (book, g["key"])
        assert g["stock"]["average"] == pytest.approx((opening + closing) / 2, abs=0.01), (book, g["key"])
        if g["value"] is None:
            continue
        assert g["value"] == pytest.approx((opening + closing) / 2 / flow_of[g["key"]] * 365, abs=1e-3), (book, g)
        assert g["closing_value"] == pytest.approx(closing / flow_of[g["key"]] * 365, abs=1e-3), (book, g)
        WORK["groups_recomputed"] += 1
    all_open = sum(a["opening"] for a in ev["accounts"])
    all_close = sum(a["closing"] for a in ev["accounts"])
    total_flow = cps + flows["607"]
    assert block["total"]["value"] == pytest.approx((all_open + all_close) / 2 / total_flow * 365, abs=1e-3)
    assert block["total"]["closing_value"] == pytest.approx(all_close / total_flow * 365, abs=1e-3)
    assert block["inventory_turnover"]["value"] == pytest.approx(365 / block["total"]["value"], abs=1e-3)


# ── basis ─────────────────────────────────────────────────────────────────


def _assert_basis_law(block: Dict[str, Any]) -> None:
    basis = block["basis"]
    parts = block["groups"] + [block["other"]]
    if basis == ID.BASIS_TWO_YEAR_ENDS:
        for p in parts:
            assert p["stock"]["opening"] is not None, "an average with no opening: %s" % p["key"]
            assert p["stock"]["average"] == pytest.approx(
                (p["stock"]["opening"] + p["stock"]["closing"]) / 2, abs=0.01), p["key"]
        assert block["basis_label"]["ro"].startswith("media soldurilor la 1 ianuarie"), block["basis_label"]
    elif basis == ID.BASIS_SNAPSHOT:
        for p in parts:
            assert p["stock"]["average"] == p["stock"]["closing"], p["key"]
        assert block["basis_label"]["ro"].endswith("— o singură zi"), block["basis_label"]
    else:
        assert basis == ID.BASIS_MONTHLY, basis


@pytest.mark.parametrize("book", BOOKS)
def test_an_average_is_an_average_and_a_snapshot_says_so(book):
    fx = _fixture(book)
    block = _build(fx)
    assert block["basis"] == ID.BASIS_TWO_YEAR_ENDS, (book, block["opening"])
    _assert_basis_law(block)
    # The same book with the opening declared absent (a 4-column layout):
    # the snapshot, labelled, never an average of a zero opening.
    evidence = copy.deepcopy(fx["envelope"]["inventory_stock"])
    evidence["opening"] = {"status": "absent", "reason": "si_column_absent", "convention": None}
    for a in evidence["accounts"]:
        a["opening"] = None
    snap = _build(fx, evidence=evidence)
    assert snap["basis"] == ID.BASIS_SNAPSHOT
    assert snap["basis_label"]["ro"] == "stoc la 31 decembrie — o singură zi"
    assert snap["opening"]["reason"]["code"] == "si_column_absent"
    _assert_basis_law(snap)
    WORK["units"] += 2


def test_no_evidence_serves_the_period_end_snapshot_from_the_line_items():
    fx = _fixture("agras")
    block = _build(fx, evidence=None)
    assert block["basis"] == ID.BASIS_SNAPSHOT
    assert block["opening"]["reason"]["code"] == ID.REASON_PREDATES
    assert block["reconciliation"]["status"] == "reconciled"
    assert block["claim_policy"]["may_call_slow"] is False


def test_the_monthly_basis_averages_thirteen_points():
    fx = _fixture("agras")
    base = _build(fx)
    keys = [g["key"] for g in base["groups"]] + [base["other"]["key"]]
    monthly = {k: [float(i) for i in range(13)] for k in keys}
    block = _build(fx, monthly=monthly)
    assert block["basis"] == ID.BASIS_MONTHLY
    for g in block["groups"]:
        assert g["stock"]["average"] == pytest.approx(6.0), g
    assert block["seasonality"]["flagged"] is False
    assert ID.monthly_points_from_periods([base] * 11) is None, "11 months are not a monthly basis"


# ── refusals ──────────────────────────────────────────────────────────────


def test_a_refused_net_711_refuses_finished_goods_and_the_total_with_its_reason():
    fx = _fixture("agras")
    pl = copy.deepcopy(fx["statements"]["assembled_pl"])
    pl["inventory_variation"] = {"value": None, "provenance": None,
                                 "refusal": {"code": "account_121_anchor_absent",
                                             "text_ro": "x", "text_en": "y"}}
    block = _build(fx, assembled_pl=pl)
    fg = [g for g in block["groups"] if g["key"] == "finished_goods_wip"][0]
    assert fg["value"] is None and fg["reason"]["code"] == "stock_variation_refused"
    assert fg["reason"]["cause"]["code"] == "account_121_anchor_absent"
    assert block["total"]["value"] is None and block["total"]["reason"]["code"] == "stock_variation_refused"
    assert block["claim_policy"]["may_call_slow"] is False
    WORK["refusals"] += 1


def test_the_developer_serves_no_inventory_days_at_all():
    block = _build(_fixture("realestate"))
    reasons = dict((g["key"], (g["reason"] or {}).get("code")) for g in block["groups"])
    assert all(g["value"] is None for g in block["groups"]), reasons
    assert reasons["finished_goods_wip"] == "no_own_production_sold", reasons
    assert reasons["merchandise"] == "no_goods_resold", reasons
    assert block["total"]["value"] is None and block["total"]["reason"]["code"] == "a_leg_refused"
    for g in block["groups"]:
        assert g["reason"]["text_ro"] and g["reason"]["text_en"], g["key"]
    WORK["refusals"] += 3


def test_a_leg_with_no_stock_refuses_rather_than_serving_zero_days():
    block = _build(_fixture("retail"))
    fg = [g for g in block["groups"] if g["key"] == "finished_goods_wip"][0]
    assert fg["value"] is None and fg["reason"]["code"] == "no_stock"
    assert block["total"]["value"] is not None, "a leg with no stock does not refuse the total"
    assert block["cost_of_production_sold"]["basis"] == "no_own_production"


# ── claim policy and seasonality ─────────────────────────────────────────


@pytest.mark.parametrize("book", ("agras", "carniprod", "retail"))
def test_the_claim_policy_allows_slow_only_on_the_split_and_an_average(book):
    fx = _fixture(book)
    block = _build(fx)
    assert block["claim_policy"]["may_call_slow"] is True
    assert block["claim_policy"]["reason"] == "split_and_average"
    evidence = copy.deepcopy(fx["envelope"]["inventory_stock"])
    evidence["opening"] = {"status": "absent", "reason": "si_date_undetermined", "convention": "A"}
    snap = _build(fx, evidence=evidence)
    assert snap["claim_policy"]["may_call_slow"] is False
    assert snap["claim_policy"]["reason"] == "snapshot_only"


def test_seasonality_is_flagged_for_food_and_fmcg_on_year_end_bases():
    fx = _fixture("agras")
    for kwargs in ({"caen": "1013"}, {"industry_key": "fmcg"}, {"caen": "4711"}):
        avg = _build(fx, **kwargs)
        assert avg["seasonality"]["flagged"] is True, kwargs
        assert avg["seasonality"]["note_ro"], kwargs
    assert _build(fx, caen="2511")["seasonality"]["flagged"] is False
    assert _build(fx)["seasonality"]["flagged"] is False


# ── served on the real route ─────────────────────────────────────────────


@pytest.fixture(scope="module")
def route_bodies():
    here = str(Path(__file__).resolve().parent)
    if here not in sys.path:
        sys.path.insert(0, here)
    import test_insights_wire as W
    import test_rebuild_net_income_anchor as A
    from _pytest.monkeypatch import MonkeyPatch

    out = {}
    for case_id, case_dir, _p121 in A.ANCHOR_CASES:
        prefix = "saga_10_col_"
        if not case_id.startswith(prefix) or case_id[len(prefix):] not in BOOKS:
            continue
        mp = MonkeyPatch()
        try:
            status, body = W._served_via_route(A._book(case_id, case_dir), mp)
        finally:
            mp.undo()
        assert status == 200, (case_id, status)
        out[case_id[len(prefix):]] = body
    assert set(out) == set(BOOKS), sorted(out)
    return out


@pytest.mark.parametrize("book", BOOKS)
def test_the_route_serves_the_block_once(route_bodies, book):
    body = route_bodies[book]
    block = body["assembled_metrics"]["inventory_days"]
    assert block is not None and block["schema"] == ID.SCHEMA, book
    assert block == body["statements"]["inventory_days"], book
    assert body["statements"]["assembled_canonical_v1"]["inventory_days"] == block, book
    _assert_basis_law(block)
    WORK["units"] += 1


def test_zz_scope():
    print("\nSCOPE inventory-days: corpus books %s (firm fixtures, real write path) + "
          "constructed plants (missing stock account, refused 711, snapshot / monthly bases); "
          "GET /api/period over the real router" % ", ".join(BOOKS))
    print("GATE-WORK inventory-days units=%d groups_recomputed=%d refusals=%d"
          % (WORK["units"], WORK["groups_recomputed"], WORK["refusals"]))
    assert WORK["groups_recomputed"] >= 7, WORK
    assert WORK["refusals"] >= 5, WORK
