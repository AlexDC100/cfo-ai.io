"""GET /api/period/{id}/sector-benchmark, UN-INTERCEPTED, on the real app.

Built on the comparatives real-app harness: `create_app()`, the
projection-faithful tenancy double with signature-verifying bearers, two
corpus books persisted through the production write seam as two periods
of one workspace, a third book in another workspace.

WHAT IT REDS ON, AFTER THE REPAIR (TC-11):
  · the route unmounted / renamed / its binding broken (404, 405, 422);
  · THE LAW: a sector figure (row, ratio card or movement item) served
    without source, year or n, or a median on fewer than min_peers peers;
  · a census key with neither a sector band nor a stated reason (TC-13);
  · the company figure of a same-definition row differing from the
    ratio-table row the SAME app serves in GET /api/period (a second
    assembly path for a lender-facing figure);
  · a company figure resting on a PERSISTED metric — a number that states
    no basis, so nothing holds it to the account-121 anchor — or a ratio
    card keeping its sector band while what it prints is a different
    number from the filed-basis figure the band was positioned against;
  · an absent company operand served as a number (absent != zero);
  · the prior period found outside the workspace, or the movement list
    served without a prior;
  · the wall: forged bearer (not 401), non-member workspace (not 403),
    a period of another workspace through the path parameter (not 404).

WHAT IT CANNOT SEE: whether the dataset's medians are right
(test_benchmarks_ro.py owns that); the frontend's reading of the document
(sectorBenchmark.test.tsx).
"""
from __future__ import annotations

import copy

import pytest

import _real_app_comparatives as RA
import firm_postgrest_double as D

USER = "7b0c0f3e-0000-4000-8000-00000000c0a1"
OUTSIDER = "7b0c0f3e-0000-4000-8000-00000000c0a2"
ORG = "0c0f0000-0000-4000-8000-0000000000a1"
OTHER_ORG = "0c0f0000-0000-4000-8000-0000000000b2"
CUR, PRI, FOREIGN = "p-agras-dec2025", "p-carniprod-dec2024", "p-retail-foreign"
CAEN = "1011"
PATH = "/api/period/%s/sector-benchmark"


@pytest.fixture(scope="module")
def app():
    return RA.build_app()


@pytest.fixture()
def world(app):
    import _served_books as SB

    double = RA.seed_double(
        orgs=[{"id": ORG, "name": "Corpus Entity", "default_currency": "RON", "caen_code": CAEN},
              {"id": OTHER_ORG, "name": "Another Workspace", "default_currency": "RON",
               "caen_code": CAEN}],
        memberships=[{"user_id": USER, "org_id": ORG, "role": "owner", "created_at": "2026-01-01T00:00:00+00:00"},
                     {"user_id": OUTSIDER, "org_id": OTHER_ORG, "role": "owner",
                      "created_at": "2026-01-01T00:00:00+00:00"}],
        periods=[(SB.book("agras"), CUR, ORG, "2025-01-01", "2025-12-31"),
                 (SB.book("carniprod"), PRI, ORG, "2024-01-01", "2024-12-31"),
                 (SB.book("retail"), FOREIGN, OTHER_ORG, "2024-01-01", "2024-12-31")])
    with RA.installed(double):
        RA.seed_metrics(app, double, (CUR, PRI), ORG, D.mint_jwt(USER))
        RA.seed_metrics(app, double, (FOREIGN,), OTHER_ORG, D.mint_jwt(OUTSIDER))
        yield double


def _served(app, period=CUR):
    resp = RA.get(app, PATH % period, D.mint_jwt(USER), ORG)
    assert resp.status_code == 200, (resp.status_code, resp.text[:600])
    return resp.json()


def test_every_served_sector_figure_carries_source_year_and_n(app, world):
    from engine.benchmarks_ro import sector as S

    doc = _served(app)
    assert doc["schema"] == S.SCHEMA and doc["status"] == "ok", doc.get("reason")
    assert doc["caen"] == CAEN and doc["size_band"]["key"], doc["size_band"]
    assert doc["source"].startswith("Ministerul Finantelor - situatii financiare anuale")
    assert S.check_document_law(doc) == []
    sourced = [r for r in doc["rows"] if r["status"] == "sourced"]
    assert sourced, [r["status"] for r in doc["rows"]]
    for row in sourced:
        s = row["sector"]
        assert isinstance(s["n"], int) and s["n"] >= doc["min_peers"], row["key"]
        assert s["year"] == doc["year"], row["key"]
        # growth cites both years; every other figure cites the dataset year
        assert s["source"].startswith("Ministerul Finantelor - situatii financiare anuale"), row["key"]
        assert ("FY%d" % doc["year"]) in s["source"] and "CC-BY-4.0" in s["source"], row["key"]
        assert s["filed_lines"], row["key"]
        assert row["position"] in ("below_p25", "p25_to_median", "median_to_p75", "above_p75")
        # quartiles only: a percentile would be an interpolation
        assert row["percentile"] is None and row["percentile_reason"]["code"] == "quartiles_only"
    for row in doc["rows"]:
        if row["status"] != "sourced":
            assert row["reason"] and row["reason"]["code"], row["key"]
            assert row["position"] is None and row["vs_sector"] is None, row["key"]


def test_every_census_key_has_a_sector_band_or_a_stated_reason(app, world):
    from engine.ratios.table import CENSUS

    cards = _served(app)["ratio_cards"]
    assert list(cards) == list(CENSUS)
    kinds = {k: c["band_source"] for k, c in cards.items()}
    assert set(kinds.values()) <= {"sector", "general"}
    assert kinds["net_margin"] == "sector" and kinds["equity_ratio"] == "sector", kinds
    for key in ("dio", "dso", "debt_to_assets"):
        assert cards[key]["reason"]["code"] == "definition_differs", (key, cards[key])
    for key in ("gross_margin", "ebitda_margin", "dpo", "current_ratio"):
        assert cards[key]["reason"]["code"] == "not_in_filed_summary", (key, cards[key])
    for key, card in cards.items():
        if card["band_source"] == "general":
            assert card["reason"]["code"], key


def test_the_company_side_is_the_ratio_table_the_same_app_serves(app, world):
    doc = _served(app)
    body = RA.get(app, "/api/period/%s" % CUR, D.mint_jwt(USER), ORG).json()
    table = {r["key"]: r for r in body["assembled_metrics"]["ratio_table"]["rows"]}
    rows = {r["key"]: r for r in doc["rows"]}
    checked = 0
    for key in ("roa", "equity_ratio"):
        if table[key]["value"] is None:
            continue
        assert rows[key]["company"]["basis"] == "ratio_table.%s" % key
        assert rows[key]["company"]["value"] == pytest.approx(table[key]["value"] / 100.0, abs=1e-12)
        checked += 1
    assert checked >= 2

    # net_margin's table row is built from the PERSISTED metric, which
    # states no basis. It is restated here on the filed basis — the same
    # account-121 anchored net income and revenue the dashboard prints —
    # and the card keeps its sector band only because what the card PRINTS
    # is proved to be that same number, within the served tolerance.
    nm = rows["net_margin"]["company"]
    assert nm["basis"] == "restated_on_filed_basis"
    assert [o["name"] for o in nm["operands"]] == ["net_result", "net_turnover"]
    assert [o["source"] for o in nm["operands"]] == [
        "assembled_pl.net_income_statutory", "assembled_pl.revenue"]
    pl = body["statements"]["assembled_pl"]
    anchored = pl["net_income_statutory"] / pl["revenue"]
    assert nm["value"] == pytest.approx(anchored, abs=1e-12)
    assert nm["card_agrees"] is True
    assert abs(nm["card_value"] - nm["value"]) <= doc["card_agreement_tolerance"]
    assert rows["net_margin"]["definition"]["differs_from_card"] is False
    assert doc["ratio_cards"]["net_margin"]["band_source"] == "sector"
    restated = rows["inventory_days_on_turnover"]
    assert restated["company"]["basis"] == "restated_on_filed_basis"
    assert restated["definition"]["differs_from_card"] is True
    assert restated["definition"]["card_key"] == "dio"
    names = [o["name"] for o in restated["company"]["operands"]]
    assert names == ["inventory", "net_turnover"], names


def test_no_company_figure_rests_on_a_persisted_metric(app, world):
    """THE BASIS RULE. A served company figure is either the ratio-table
    row whose own printed operands come from the canonical statements, or
    it is restated here on the filed basis. It is NEVER a persisted metric:
    that number states no basis, so nothing guarantees it shares the
    account-121 anchor the dashboard prints — the exact defect family
    measured on production. The guard existed for ROE only; the other
    same-definition rows took whatever the table held.

    Reds on: any served row whose operands cite `metrics.`.
    """
    doc = _served(app)
    offenders = []
    for row in doc["rows"]:
        for operand in row["company"]["operands"] or []:
            source = str((operand or {}).get("source") or "")
            if source.startswith("metrics."):
                offenders.append((row["key"], row["company"]["basis"], source))
    assert offenders == [], offenders


def test_the_prior_period_is_found_in_the_workspace_and_feeds_the_movements(app, world):
    doc = _served(app)
    assert doc["prior_period"]["id"] == PRI
    assert doc["movements"]["status"] == "ok"
    rows = {r["key"]: r for r in doc["rows"]}
    assert rows["revenue_growth"]["company"]["value"] is not None
    # the prior period itself has no period a year before it
    older = _served(app, PRI)
    assert older["prior_period"] is None
    assert older["movements"]["status"] == "refused"
    assert older["movements"]["reason"]["code"] == "prior_period_absent"
    assert older["movements"]["improved"] == [] and older["movements"]["deteriorated"] == []
    growth = {r["key"]: r for r in older["rows"]}["revenue_growth"]
    assert growth["status"] == "company_absent" and growth["company"]["value"] is None
    assert growth["reason"]["code"] == "prior_period_absent"


def test_a_forged_bearer_is_refused(app, world):
    resp = RA.get(app, PATH % CUR, D.forged_jwt(USER), ORG)
    assert resp.status_code == 401, (resp.status_code, resp.text[:300])
    assert "median" not in resp.text


def test_a_workspace_the_caller_does_not_belong_to_is_refused(app, world):
    resp = RA.get(app, PATH % CUR, D.mint_jwt(OUTSIDER), ORG)
    assert resp.status_code == 403, (resp.status_code, resp.text[:300])
    assert "median" not in resp.text


def test_a_period_from_another_workspace_is_not_found(app, world):
    resp = RA.get(app, PATH % FOREIGN, D.mint_jwt(USER), ORG)
    assert resp.status_code == 404, (resp.status_code, resp.text[:300])
    assert resp.json()["detail"]["code"] == "period_not_in_workspace", resp.text[:300]
    assert "median" not in resp.text


# ── the pure seam: planted documents ─────────────────────────────────────────


def _doc_for(app, world):
    return _served(app)


def test_a_figure_without_n_year_or_source_is_a_violation(app, world):
    from engine.benchmarks_ro import sector as S

    base = _doc_for(app, world)
    for field in ("n", "year", "source"):
        doc = copy.deepcopy(base)
        row = next(r for r in doc["rows"] if r["status"] == "sourced")
        del row["sector"][field]
        assert any(row["key"] in p for p in S.check_document_law(doc)), field
        doc = copy.deepcopy(base)
        card = next(c for c in doc["ratio_cards"].values() if c["band_source"] == "sector")
        del card[field]
        assert S.check_document_law(doc), field


def test_fewer_than_min_peers_serves_words_not_a_median(app, world):
    from engine.benchmarks_ro import load_dataset
    from engine.benchmarks_ro import sector as S

    body = RA.get(app, "/api/period/%s" % CUR, D.mint_jwt(USER), ORG).json()
    ds = copy.deepcopy(load_dataset())
    band = _served(app)["size_band"]["key"]
    for sector_key in (CAEN, CAEN[:2]):
        fig = ds["sectors"][sector_key]["cells"][band]["figures"]["net_margin"]
        for k in ("median", "p25", "p75"):
            fig.pop(k, None)
        fig["n"], fig["insufficient_peers"] = 4, True
    doc = S.build_sector_benchmark(body, caen=CAEN, dataset=ds)
    row = {r["key"]: r for r in doc["rows"]}["net_margin"]
    assert row["status"] == "insufficient_peers"
    assert "median" not in row["sector"] and row["sector"]["n"] == 4
    assert row["reason"] == {"code": "insufficient_peers", "inputs": {"n": 4, "min": 5}}
    assert doc["ratio_cards"]["net_margin"]["band_source"] == "general"
    assert S.check_document_law(doc) == []


def test_an_absent_company_operand_refuses_the_row_never_zero(app, world):
    from engine.benchmarks_ro import sector as S

    body = RA.get(app, "/api/period/%s" % CUR, D.mint_jwt(USER), ORG).json()
    cbs = body["statements"]["canonical_bs"]
    cbs["rows"] = [r for r in cbs["rows"] if not str(r.get("id", "")).startswith("inventory_")]
    doc = S.build_sector_benchmark(body, caen=CAEN)
    row = {r["key"]: r for r in doc["rows"]}["inventory_days_on_turnover"]
    assert row["status"] == "company_absent" and row["company"]["value"] is None
    assert row["reason"] == {"code": "company_operand_absent", "inputs": ["inventory"]}


def test_an_unknown_sector_is_refused_and_every_card_stays_general(app, world):
    from engine.benchmarks_ro import sector as S
    from engine.ratios.table import CENSUS

    body = RA.get(app, "/api/period/%s" % CUR, D.mint_jwt(USER), ORG).json()
    for caen, code in (("6201", "sector_not_in_dataset"), (None, "caen_absent")):
        doc = S.build_sector_benchmark(body, caen=caen)
        assert doc["status"] == "refused" and doc["reason"]["code"] == code
        assert doc["rows"] == [] and list(doc["ratio_cards"]) == list(CENSUS)
        assert all(c["band_source"] == "general" and c["reason"]["code"] == code
                   for c in doc["ratio_cards"].values())


# ── the committed frontend fixture is what this route serves ────────────────

FE_FIXTURE = (RA.Path(__file__).resolve().parents[2] / "frontend" / "lib" / "__tests__"
              / "fixtures" / "sectorBenchmark" / "served_pair.json")


def test_the_committed_frontend_fixture_is_what_this_route_serves(app, world):
    """sectorBenchmark.test.tsx and the page/report byte-match render this
    file. Regenerate: SECTOR_BENCHMARK_WRITE_FIXTURE=1 pytest <this file>."""
    import json
    import os

    served = {"with_prior": _served(app), "without_prior": _served(app, PRI)}
    text = json.dumps(served, indent=1, sort_keys=True, ensure_ascii=False) + "\n"
    if os.environ.get("SECTOR_BENCHMARK_WRITE_FIXTURE") == "1":
        FE_FIXTURE.parent.mkdir(parents=True, exist_ok=True)
        FE_FIXTURE.write_text(text, encoding="utf-8")
    assert FE_FIXTURE.read_text(encoding="utf-8") == text
