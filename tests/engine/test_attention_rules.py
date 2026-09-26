"""attention/1 — the declared rules of "Ce contează acum", held on served
documents (design C1, owner spec 2026-09-26).

The inputs are what the engine SERVES: the committed comparatives capture
(`frontend/lib/__tests__/fixtures/comparatives/pair_served.json`, the pair the
comparatives-route gate proves is what the route serves), the committed
sector-benchmark captures, and GET /api/period bodies of the corpus books read
back through the real router (`_served_books`). Where a rule needs a case the
corpus does not hold, the pair is CONSTRUCTED from the served one by changing
exactly the fields the rule reads, and the test says which.

WHAT IT REDS ON, AFTER THE REPAIR (TC-11):
  * a verdict-less reclassification (Other equity) filling the movement slot,
    or any slot filled by a line outside the pack's statutory results;
  * the composite letter as the biggest movement, or as an improvement
    without the rung it crossed and the finding that states it;
  * a band crossing ranked ahead of a statutory result improving;
  * "Net result (account 121)" on a period whose net result is not account 121;
  * a refused EBITDA ranked as a movement;
  * an inventory-days crossing claimed on a year-end snapshot; the filed-basis
    inventory row printed with a verdict word or without its basis label;
  * two complementary sector rows, or a sector row repeating the movement,
    both shown;
  * a filler: a slot filled below its materiality basis or from a family the
    mode does not read; an empty slot without its reason;
  * a percentage across zero or a sign change;
  * an action that does not follow the company's state;
  * a sector or ratio subject whose name differs from the one the frontend
    prints for the same metric;
  * the same-length prior rule choosing another length, a later period, or
    a period nondeterministically.

WHAT IT CANNOT SEE: the route's wall and its sources through the real app
(test_attention_route_real_app.py); that nothing unserved reaches the document
(test_attention_served_only.py).
"""
from __future__ import annotations

import copy
import json
import random
from pathlib import Path

import pytest

from engine.attention import compose_attention, load_pack, same_length_prior
from engine.attention.sources import cut_of, year_back
from engine.comparatives.analysis import MATERIALITY_FLOOR
from engine.serving.change_kind import classify

REPO = Path(__file__).resolve().parents[2]
FIX = REPO / "frontend" / "lib" / "__tests__" / "fixtures"
PAIR = FIX / "comparatives" / "pair_served.json"
SECTOR = FIX / "sectorBenchmark" / "served_pair.json"
LOCALES = REPO / "frontend" / "i18n" / "locales"

PRIOR_FOUND = {"rule": "same_company_previous_period_same_length", "requested": "auto",
               "status": "found", "period_id": "period-prior", "period_start": "2024-01-01",
               "period_end": "2024-12-31", "reason": None,
               "available_period_id": None, "available_period_end": None}
PRIOR_ABSENT = dict(PRIOR_FOUND, status="absent", period_id=None, period_start=None,
                    period_end=None, reason={"code": "no_same_length_prior", "inputs": []})

STATUTORY = ("pl.revenue", "pl.ebitda", "pl.ebit", "pl.net_income", "bs.cash", "bs.total_debt")


def _pair():
    doc = json.loads(PAIR.read_text(encoding="utf-8"))
    return doc["current_body"], doc["comparatives"]


def _sector(which="with_prior"):
    return json.loads(SECTOR.read_text(encoding="utf-8"))[which]


def _compose(cur, **kw):
    kw.setdefault("prior", PRIOR_FOUND)
    kw.setdefault("features", {"forecast": "active"})
    return compose_attention(cur, **kw)


def _col(cmp, key):
    return next(c for c in cmp["columns"] if c["key"] == key)


def _set_col(cmp, key, current, prior):
    """Construct one column the way the column model writes it."""
    c = _col(cmp, key)
    kind = classify(prior, current, 0.005)
    c.update(current=current, prior=prior, delta=round(current - prior, 2),
             status="compared", change_kind=kind.kind,
             delta_pct=(round((current - prior) / abs(prior), 6)
                        if kind.kind == "compared" and abs(prior) >= 0.005 else None))


def _quiet_statutory(cmp):
    """Every statutory result moves below the materiality floor."""
    for key in STATUTORY:
        c = _col(cmp, key)
        base = c["current"] if c["current"] is not None else 1000.0
        _set_col(cmp, key, base, base - 1.0)


def _items(doc):
    return [(i["slot"], i["family"], i["key"]) for i in doc["items"]]


def _walk_strings(node):
    if isinstance(node, dict):
        for v in node.values():
            yield from _walk_strings(v)
    elif isinstance(node, list):
        for v in node:
            yield from _walk_strings(v)
    elif isinstance(node, str):
        yield node


# ── the pack ─────────────────────────────────────────────────────────────


def test_the_pack_loads_and_every_served_string_is_bilingual():
    pack = load_pack()
    texts = []
    for line in pack["statement_lines"]:
        texts.append(line["subject"])
    texts += list(pack["sector"]["subjects"].values())
    texts += list(pack["sector"]["basis_labels"].values())
    texts += list(pack["ratio_band"]["subjects"].values())
    texts += [d["subject"] for d in pack["insights"]["detectors"].values()]
    texts += [a["label"] for a in pack["actions"].values()]
    texts += list(pack["caveats"].values())
    assert len(texts) >= 60, len(texts)
    for t in texts:
        assert set(t) == {"ro", "en"} and t["ro"].strip() and t["en"].strip(), t
    ro = " ".join(t["ro"] for t in texts)
    # Romanian copy carries its diacritics (the owner's rule for RO strings).
    for ch in "ăâîșț":
        assert ch in ro, ch
    assert "ş" not in ro and "ţ" not in ro, "cedilla forms, not comma-below"


def test_sector_and_ratio_subjects_are_the_frontends_own_names():
    """One metric, one name: the bar says what the benchmark page and the
    Ratios tab say for the same key, in both languages."""
    pack = load_pack()
    for lang in ("ro", "en"):
        loc = json.loads((LOCALES / ("%s.json" % lang)).read_text(encoding="utf-8"))
        sector_fe = loc["benchmarkPage"]["sector"]["ratio"]
        ratio_fe = loc["statements"]["ratioCmp"]["label"]
        for key, text in pack["sector"]["subjects"].items():
            assert sector_fe.get(key) == text[lang], (lang, key, sector_fe.get(key), text[lang])
        for key, text in pack["ratio_band"]["subjects"].items():
            assert ratio_fe.get(key) == text[lang], (lang, key, ratio_fe.get(key), text[lang])


def test_the_rules_the_document_serves_are_the_packs():
    cur, cmp = _pair()
    doc = _compose(cur, comparatives=cmp, sector=_sector())
    pack = load_pack()
    assert doc["schema"] == "attention/1"
    assert doc["rules"]["slots"] == pack["slots"]
    assert doc["rules"]["statement_lines"] == [l["key"] for l in pack["statement_lines"]]
    assert doc["rules"]["statement_line_floor"] == MATERIALITY_FLOOR
    assert doc["rules"]["improvement_family_order"] == pack["improvement_family_order"]
    assert doc["rules"]["insight_material_levels"] == pack["insights"]["material_levels"]


# ── the movement slot ─────────────────────────────────────────────────────


def test_other_equity_is_never_the_biggest_movement_on_the_served_pair():
    """The served pair's own movers rank Other equity first (a
    reclassification with no verdict) — the empty state must not."""
    cur, cmp = _pair()
    assert cmp["movers"]["top"][0]["key"] == "bs.other_equity", cmp["movers"]["top"][0]
    doc = _compose(cur, comparatives=cmp, sector=_sector())
    assert doc["mode"] == "with_prior"
    keys = [i["key"] for i in doc["items"] if i["family"] == "statement_line"]
    assert keys and set(keys) <= set(STATUTORY), keys
    movement = [i for i in doc["items"] if i["slot"] == "movement"]
    assert movement and movement[0]["key"] in STATUTORY
    # the biggest of the statutory results, on the served materiality basis
    eligible = [c for c in doc["considered"]["statement_lines"] if c["eligible"]]
    top = max(eligible, key=lambda c: c["materiality"]["share"])
    assert movement[0]["key"] == top["key"]


def test_a_reclassification_alone_leaves_the_movement_slot_empty_never_filled():
    cur, cmp = _pair()
    cmp = copy.deepcopy(cmp)
    _quiet_statutory(cmp)
    _set_col(cmp, "bs.other_equity", 500_000_000.0, 1.0)
    cmp["ratios"]["band_movements"]["improved"] = []
    doc = _compose(cur, comparatives=cmp, sector=_sector())
    assert not [i for i in doc["items"] if i["slot"] in ("movement", "improvement")], _items(doc)
    slots = {u["slot"]: u["reason"]["code"] for u in doc["unfilled"]}
    assert slots == {"movement": "no_material_statutory_movement",
                     "improvement": "no_improvement"}, slots
    assert len(doc["items"]) == 1  # the sector row, and nothing standing in for the rest
    for c in doc["considered"]["statement_lines"]:
        assert c["reason"]["code"] == "below_materiality_floor", c


def test_the_composite_letter_is_never_the_biggest_movement():
    cur, cmp = _pair()
    cmp = copy.deepcopy(cmp)
    _quiet_statutory(cmp)
    bm = cmp["ratios"]["band_movements"]
    bm["improved"] = ["letter_grade"] + [k for k in bm["improved"] if k != "letter_grade"]
    doc = _compose(cur, comparatives=cmp, sector=_sector())
    assert not [i for i in doc["items"] if i["slot"] == "movement"]
    imp = [i for i in doc["items"] if i["slot"] == "improvement"]
    assert imp and imp[0]["key"] == "letter_grade" and imp[0]["family"] == "ratio_band"
    because = imp[0]["because"]
    assert because["rung_crossed"] and because["finding_id"], because
    assert because["composite_row"]["key"] == "credit_composite"


def test_the_letter_without_its_reason_is_not_an_improvement():
    cur, cmp = _pair()
    cmp = copy.deepcopy(cmp)
    _quiet_statutory(cmp)
    bm = cmp["ratios"]["band_movements"]
    bm["improved"] = ["letter_grade"] + [k for k in bm["improved"] if k != "letter_grade"]
    for row in cmp["ratios"]["composites"]:
        if row["key"] == "letter_grade":
            row["finding_id"] = None
    doc = _compose(cur, comparatives=cmp, sector=_sector())
    letter = next(c for c in doc["considered"]["ratio_bands"] if c["key"] == "letter_grade")
    assert letter["eligible"] is False and letter["reason"]["code"] == "letter_without_its_reason"
    imp = [i for i in doc["items"] if i["slot"] == "improvement"]
    assert imp and imp[0]["key"] != "letter_grade"
    # and it is the next band move in the SERVED rank order
    first_eligible = next(c for c in doc["considered"]["ratio_bands"] if c["eligible"])
    assert imp[0]["key"] == first_eligible["key"]


def test_a_statutory_result_improving_comes_before_a_band_crossing():
    cur, cmp = _pair()
    assert cmp["ratios"]["band_movements"]["improved"], "the pair must carry band crossings"
    doc = _compose(cur, comparatives=cmp, sector=_sector())
    imp = [i for i in doc["items"] if i["slot"] == "improvement"]
    assert imp and imp[0]["family"] == "statement_line" and imp[0]["verdict"] == "improved", imp


def test_net_result_names_account_121_only_when_both_periods_are_anchored():
    cur, cmp = _pair()
    cmp = copy.deepcopy(cmp)
    _quiet_statutory(cmp)
    _set_col(cmp, "pl.net_income", 90_000_000.0, 1_000_000.0)  # would dominate
    doc = _compose(cur, comparatives=cmp, sector=_sector())
    assert doc["items"][0]["key"] == "pl.net_income"
    assert doc["items"][0]["anchor"] == {"current": "anchored", "prior": "anchored"}
    cmp["prior_statements"]["assembled_pl"]["net_income_anchor_status"] = "absent"
    doc = _compose(cur, comparatives=cmp, sector=_sector())
    assert "pl.net_income" not in [i["key"] for i in doc["items"]]
    ni = next(c for c in doc["considered"]["statement_lines"] if c["key"] == "pl.net_income")
    assert ni["reason"]["code"] == "net_result_not_account_121", ni


def test_a_refused_ebitda_is_not_a_movement():
    """EBITDA is read through `sources.served_ebitda` only; a served refusal
    (design A: net 711 refused) keeps it out of every slot."""
    cur, cmp = _pair()
    cmp = copy.deepcopy(cmp)
    cur = copy.deepcopy(cur)
    _quiet_statutory(cmp)
    _set_col(cmp, "pl.ebitda", 80_000_000.0, 1_000_000.0)
    assert _compose(cur, comparatives=cmp, sector=_sector())["items"][0]["key"] == "pl.ebitda"
    cur["statements"]["assembled_pl"]["ebitda_refusal"] = {"code": "net_711_refused",
                                                           "inputs": ["711"]}
    doc = _compose(cur, comparatives=cmp, sector=_sector())
    assert "pl.ebitda" not in [i["key"] for i in doc["items"]]
    e = next(c for c in doc["considered"]["statement_lines"] if c["key"] == "pl.ebitda")
    assert e["reason"]["code"] == "net_711_refused" and e["reason"]["side"] == "current", e


def test_a_change_across_zero_or_sign_carries_no_percentage():
    cur, cmp = _pair()
    cmp = copy.deepcopy(cmp)
    _quiet_statutory(cmp)
    _set_col(cmp, "pl.ebit", -40_000_000.0, 6_100_000.0)
    doc = _compose(cur, comparatives=cmp, sector=_sector())
    item = doc["items"][0]
    assert item["key"] == "pl.ebit" and item["verdict"] == "deteriorated"
    col = item["figure"]["column"]
    assert col["change_kind"] == "flip_to_negative" and col["delta_pct"] is None, col


# ── inventory days ───────────────────────────────────────────────────────


def _with_dio_crossing(cmp):
    cmp = copy.deepcopy(cmp)
    _quiet_statutory(cmp)
    row = next(r for r in cmp["ratios"]["rows"] if r["key"] == "dio")
    row["movement"] = dict(row["movement"] or {}, status="crossed_up", **{"from": "watch", "to": "healthy"},
                           rungs_crossed=1)
    cmp["ratios"]["band_movements"]["improved"] = ["dio"]
    return cmp


def test_inventory_days_never_claim_speed_on_a_year_end_snapshot():
    cur, cmp = _pair()
    doc = _compose(cur, comparatives=_with_dio_crossing(cmp), sector=_sector())
    assert "dio" not in [i["key"] for i in doc["items"]]
    dio = next(c for c in doc["considered"]["ratio_bands"] if c["key"] == "dio")
    assert dio["reason"]["code"] == "inventory_days_claim_not_allowed", dio
    assert doc["rules"]["inventory_days_claim_policy"]["may_call_slow"] is False
    assert doc["rules"]["inventory_days_claim_policy"]["reason"] == "single_basis_year_end_snapshot"


def test_a_served_inventory_days_block_that_allows_the_claim_is_read_instead():
    """Forward: once `assembled_metrics.inventory_days` (split + average) is
    served, its own claim policy decides — read through the one adapter."""
    cur, cmp = _pair()
    cur = copy.deepcopy(cur)
    cur["assembled_metrics"]["inventory_days"] = {
        "schema": "inventory_days/1", "basis": "average_two_year_ends",
        "total": {"value": 40.0, "value_q": "40", "reason": None},
        "claim_policy": {"may_call_slow": True, "requires": [], "reason": "split_and_average"}}
    doc = _compose(cur, comparatives=_with_dio_crossing(cmp), sector=_sector())
    assert [i["key"] for i in doc["items"] if i["slot"] == "improvement"] == ["dio"]


def test_the_filed_basis_inventory_row_is_a_position_never_a_verdict():
    cur, cmp = _pair()
    sector = copy.deepcopy(_sector())
    for row in sector["rows"]:
        if row["key"] == "inventory_days_on_turnover":
            row["position"], row["vs_sector"] = "above_p75", "worse"
            row["company"]["value"] = row["sector"]["p75"] * 3
        elif row["vs_sector"] == "worse":
            row["vs_sector"] = "inside"
    doc = _compose(cur, comparatives=cmp, sector=sector)
    item = next(i for i in doc["items"] if i["slot"] == "worst_vs_sector")
    assert item["key"] == "inventory_days_on_turnover"
    assert item["verdict"] is None
    assert item["claim_policy"] == {"may_call_slow": False, "verdict_word": False,
                                    "reason": "filed_basis_position_only"}
    assert item["basis_label"]["ro"] == ("bază depusă (stoc ÷ cifra de afaceri) — nu aceeași "
                                         "cu zilele de stoc din analiză")
    blob = " ".join(_walk_strings(item)).lower()
    for word in ("slow", "lent", "high stock"):
        assert word not in blob, word


# ── the sector slot ──────────────────────────────────────────────────────


def _worse(row, factor):
    lo, hi = row["sector"]["p25"], row["sector"]["p75"]
    if row["direction"] == "higher":
        row["position"], row["company"]["value"] = "below_p25", lo - factor * (hi - lo)
    else:
        row["position"], row["company"]["value"] = "above_p75", hi + factor * (hi - lo)
    row["vs_sector"] = "worse"


def test_complementary_sector_rows_are_one_claim():
    cur, cmp = _pair()
    sector = copy.deepcopy(_sector())
    for row in sector["rows"]:
        if row["key"] == "equity_ratio":
            _worse(row, 0.4)
        elif row["key"] == "liabilities_to_assets":
            _worse(row, 0.9)
        elif row["vs_sector"] == "worse":
            row["vs_sector"] = "inside"
    doc = _compose(cur, comparatives=cmp, sector=sector)
    shown = [i["key"] for i in doc["items"] if i["family"] == "sector_row"]
    assert shown == ["liabilities_to_assets"], shown
    eligible = {c["key"] for c in doc["considered"]["sector_rows"] if c["eligible"]}
    assert {"equity_ratio", "liabilities_to_assets"} <= eligible
    assert doc["rules"]["sector_identities"]["equity_ratio"] == \
        doc["rules"]["sector_identities"]["liabilities_to_assets"]


def test_a_sector_row_repeating_the_movement_is_not_shown_twice():
    cur, cmp = _pair()
    cmp = copy.deepcopy(cmp)
    _quiet_statutory(cmp)
    _set_col(cmp, "pl.revenue", 100_000_000.0, 150_000_000.0)
    sector = copy.deepcopy(_sector())
    for row in sector["rows"]:
        if row["key"] == "revenue_growth":
            _worse(row, 2.0)
    doc = _compose(cur, comparatives=cmp, sector=sector)
    assert doc["items"][0]["key"] == "pl.revenue"
    assert "revenue_growth" not in [i["key"] for i in doc["items"]]
    assert {"family": "sector_row", "key": "revenue_growth", "identity": "turnover",
            "reason": "identity_already_shown"} in doc["deduped"]


def test_a_refused_sector_says_why_and_offers_the_caen_action():
    cur, cmp = _pair()
    refused = {"schema": "sector_benchmark/1", "status": "refused",
               "reason": {"code": "caen_absent", "inputs": [], "text": None}, "rows": []}
    doc = _compose(cur, comparatives=cmp, sector=refused)
    assert {"slot": "worst_vs_sector", "reason": {"code": "caen_absent", "inputs": [],
                                                  "text": None}} in doc["unfilled"]
    assert [a["key"] for a in doc["actions"]][-1] == "set_industry"
    assert doc["sources"]["sector_benchmark"]["status"] == "refused"


def test_a_disputed_sector_is_not_read():
    cur, cmp = _pair()
    sector = dict(copy.deepcopy(_sector()), sector_disputed=True)
    doc = _compose(cur, comparatives=cmp, sector=sector)
    assert not [i for i in doc["items"] if i["family"] == "sector_row"]
    assert any(u["reason"]["code"] == "sector_disputed" for u in doc["unfilled"])


# ── the single-period mode ───────────────────────────────────────────────


@pytest.fixture(scope="module")
def served():
    import _served_books as SB
    from engine.benchmarks_ro.sector import build_sector_benchmark

    out = {}
    for name in ("agras", "carniprod", "realestate", "retail"):
        body = SB.served_body(name)
        out[name] = (body, build_sector_benchmark(body, caen="1011"))
    return out


def test_a_single_period_company_fills_the_slots_from_its_findings(served):
    body, sector = served["agras"]
    doc = _compose(body, prior=PRIOR_ABSENT, sector=sector)
    assert doc["mode"] == "single_period"
    assert [i["slot"] for i in doc["items"]] == ["finding", "worst_vs_sector", "finding"]
    findings = [i for i in doc["items"] if i["family"] == "insight"]
    served_ids = [i["id"] for i in sorted(body["statements"]["insights"]["insights"],
                                          key=lambda i: i["rank"])]
    # in the served rank order, material levels only
    assert [f["key"] for f in findings] == [k for k in served_ids if k in [f["key"] for f in findings]]
    for f in findings:
        assert f["severity"]["level"] in ("critical", "high", "medium")
        assert f["figure"]["measure"]["key"] == load_pack()["insights"]["detectors"][f["key"]]["headline"]
    assert [c["key"] for c in doc["caveats"]] == ["single_period"]
    assert doc["actions"][0]["key"] == "add_prior_year"
    assert doc["actions"][0]["target"]["period_end"] == "2024-12-31"


def test_fewer_material_findings_mean_fewer_items_never_a_filler(served):
    body, sector = served["carniprod"]
    doc = _compose(body, prior=PRIOR_ABSENT, sector=sector)
    assert len(doc["items"]) < 3, _items(doc)
    assert doc["unfilled"], "an empty slot must say why"
    for u in doc["unfilled"]:
        assert u["reason"] and u["reason"]["code"], u
    for c in doc["considered"]["insights"]:
        if not c["eligible"]:
            assert c["reason"]["code"] in ("below_material_level", "excluded_data_quality",
                                           "headline_measure_absent"), c


def test_data_quality_findings_are_not_business_items(served):
    body, sector = served["realestate"]
    ranked = {i["id"]: i["severity"]["level"] for i in body["statements"]["insights"]["insights"]}
    assert ranked["reconstruction_gap"] == "critical"  # the corpus case the rule is about
    doc = _compose(body, prior=PRIOR_ABSENT, sector=sector)
    assert "reconstruction_gap" not in [i["key"] for i in doc["items"]]
    rg = next(c for c in doc["considered"]["insights"] if c["key"] == "reconstruction_gap")
    assert rg["reason"]["code"] == "excluded_data_quality"


def test_the_empty_state_differs_between_two_companies(served):
    """Swap test at the source: two companies on the same fixture shape
    serve different items — figures (S1) and, numerals masked, subjects
    and keys (S2)."""
    docs = {n: _compose(served[n][0], prior=PRIOR_ABSENT, sector=served[n][1])
            for n in ("agras", "retail")}

    def figures(doc):
        out = []
        for i in doc["items"]:
            f = i["figure"]
            out.append(json.dumps(f.get("measure") or f.get("row") or f.get("column"), sort_keys=True))
        return out

    def masked(doc):
        return [(i["slot"], i["key"], i["subject"]["ro"]) for i in doc["items"]]

    a, b = docs["agras"], docs["retail"]
    assert a["items"] and b["items"]
    assert len(set(figures(a)) & set(figures(b))) <= len(figures(a)) // 2
    assert masked(a) != masked(b), (masked(a), masked(b))


# ── determinism and actions ──────────────────────────────────────────────


def test_the_document_is_deterministic_and_order_blind():
    cur, cmp = _pair()
    sector = _sector()
    one = json.dumps(_compose(cur, comparatives=cmp, sector=sector), sort_keys=True)
    two = json.dumps(_compose(copy.deepcopy(cur), comparatives=copy.deepcopy(cmp),
                              sector=copy.deepcopy(sector)), sort_keys=True)
    assert one == two
    rng = random.Random(7)
    cmp2, sector2 = copy.deepcopy(cmp), copy.deepcopy(sector)
    rng.shuffle(cmp2["columns"])
    rng.shuffle(sector2["rows"])
    shuffled = _compose(cur, comparatives=cmp2, sector=sector2)
    assert json.dumps(shuffled["items"], sort_keys=True) == \
        json.dumps(json.loads(one)["items"], sort_keys=True)


def test_actions_follow_the_companys_state():
    cur, cmp = _pair()
    sector = _sector()
    keys = lambda doc: [a["key"] for a in doc["actions"]]  # noqa: E731
    assert keys(_compose(cur, comparatives=cmp, sector=sector)) == ["compare_prior", "bank_export"]
    two_back = dict(PRIOR_FOUND, period_end="2023-12-31")
    assert keys(_compose(cur, prior=two_back, comparatives=cmp, sector=sector))[0] == \
        "compare_previous_period"
    assert keys(_compose(cur, comparatives=cmp, sector=sector, features={"forecast": "coming_soon"})) \
        == ["compare_prior", "cfo_report_pdf"]
    off = dict(PRIOR_FOUND, status="off", period_id=None, period_start=None, period_end=None,
               available_period_id="period-prior", available_period_end="2024-12-31")
    doc = _compose(cur, prior=off, sector=sector)
    assert doc["mode"] == "single_period" and keys(doc)[0] == "compare_prior"
    assert doc["actions"][0]["target"]["prior_period_id"] == "period-prior"
    assert [c["key"] for c in doc["caveats"]] == ["comparison_off"]
    doc = _compose(cur, prior=PRIOR_ABSENT, sector=sector)
    assert keys(doc) == ["add_prior_year", "bank_export"]
    for doc in (_compose(cur, comparatives=cmp, sector=sector),):
        assert 2 <= len(doc["actions"]) <= 3
        for a in doc["actions"]:
            assert set(a["label"]) == {"ro", "en"}


# ── the same-length prior (the dashboard's default comparison) ───────────


def _p(pid, start, end):
    return {"id": pid, "period_start": start, "period_end": end}


def test_the_prior_is_the_same_companys_previous_period_of_the_same_length():
    cur = _p("c", "2025-01-01", "2025-12-31")
    periods = [_p("nov25", "2025-01-01", "2025-11-30"), _p("dec24", "2024-01-01", "2024-12-31"),
               _p("dec23", "2023-01-01", "2023-12-31"), _p("dec26", "2026-01-01", "2026-12-31")]
    assert same_length_prior(periods, cur)["id"] == "dec24"
    # a November close is eleven months, never the default for a December
    assert same_length_prior([periods[0]], cur) is None
    # the nearest earlier one, and never a later one
    assert same_length_prior([periods[2], periods[3]], cur)["id"] == "dec23"
    ytd = _p("aug25", "2025-01-01", "2025-08-31")
    assert same_length_prior([_p("aug24", "2024-01-01", "2024-08-31"),
                              _p("dec24", "2024-01-01", "2024-12-31")], ytd)["id"] == "aug24"


def test_the_prior_rule_reads_month_ends_starts_and_ties_deterministically():
    feb = _p("feb25", "2025-01-01", "2025-02-28")
    assert same_length_prior([_p("feb24", "2024-01-01", "2024-02-29")], feb)["id"] == "feb24"
    assert cut_of("2024-02-29") == cut_of("2025-02-28") == "02-end"
    # starts compared when both are known: a 12-month window is not a year-to-date
    assert same_length_prior([_p("roll", "2024-07-01", "2024-12-31")],
                             _p("c", "2025-01-01", "2025-12-31")) is None
    assert same_length_prior([_p("nostart", None, "2024-12-31")],
                             _p("c", "2025-01-01", "2025-12-31"))["id"] == "nostart"
    twins = [_p("b", "2024-01-01", "2024-12-31"), _p("a", "2024-01-01", "2024-12-31")]
    assert same_length_prior(twins, _p("c", "2025-01-01", "2025-12-31"))["id"] == "a"
    assert same_length_prior(list(reversed(twins)), _p("c", "2025-01-01", "2025-12-31"))["id"] == "a"
    assert year_back("2025-12-31") == "2024-12-31"
    assert year_back("2025-02-28") == "2024-02-29"
    assert year_back("2024-02-29") == "2023-02-28"
    assert year_back("2025-08-15") == "2024-08-15"
    assert year_back("not a date") is None
