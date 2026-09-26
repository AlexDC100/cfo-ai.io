"""GET /api/period, UN-INTERCEPTED, over a period persisted BEFORE a row's
definition was revised: one key carries one figure on every surface.

`interest_coverage` divided EBITDA until 2026-09-19 and is EBIT / interest
since (the stated methodology; `ebitda_to_interest` is the EBITDA row). A
reanalyze never recomputes metrics, so every period analysed before the
change still holds the EBITDA figure under that name. Before the repair
the real route served, in ONE body, the persisted EBITDA figure in
`metrics[]` and `assembled_metrics.ratios.coverage`, and the serve-time
EBIT figure in `assembled_metrics.ratio_table` — agras 66.28 beside 55.64,
and on the retail book +0.09 beside -0.52: a sign flip between two
surfaces of one period (B8 repair-round verifier, medium).

The seed is the production write seam (parse -> stage_map -> stage_persist
-> stage_compute) on `create_app()` over the projection-faithful tenancy
double; the legacy state is made by setting the persisted row to the
period's own `ebitda_to_interest` — exactly what the pre-revision
stage_compute wrote.

THE ONE EBITDA (revision 3, owner ruling 2026-09-26). Every row built on
EBITDA or the operating result was revised with the ruling (net 711 and net
72x inside), `ebitda_to_interest` included, and three rows were retired
(the gross 711 credit turnover and the totals built on it). A period
persisted under revision 2 therefore holds the EBITDA WITHOUT 711 / 72x
under those names: the route serves every one of them from the serve-time
model, drops the retired rows, and discloses the filed figures verbatim.

WHAT IT REDS ON, AFTER THE REPAIR (TC-11):
  · `metrics[]`, `assembled_metrics.ratios.coverage` and `ratio_table`
    disagreeing on `interest_coverage` (at the table's own quantum);
  · the served figure being the legacy EBITDA one;
  · the filed figure not disclosed, verbatim, in `credit_metrics_as_filed`;
  · a revision-2 EBITDA row (the EBITDA without 711 / 72x) served under any
    one-EBITDA name, in `metrics[]` or the typed ratios block; a retired row
    (`ebitda_statutory_with_711`, `inventory_variation_memo`,
    `total_operating_revenue_statutory`) served at all.

WHAT IT CANNOT SEE: whether EBIT / interest is computed correctly
(test_credit_model_pure.py::test_interest_coverage_divides_ebit... owns
that); the frontend's reading of the body.
"""
from __future__ import annotations

import pytest

import _real_app_comparatives as RA
import _served_books as SB
import firm_postgrest_double as D

USER = "7b0c0f3e-0000-4000-8000-00000000c0a1"
ORG = "0c0f0000-0000-4000-8000-0000000000a1"

# Books that carry interest expense, so both coverage rows are numbers and
# EBIT != EBITDA. retail is the sign-flip book.
BOOKS = ("agras", "retail", "realestate")


@pytest.fixture(scope="module")
def app():
    return RA.build_app()


def _legacy_body(app, name):
    """(body, filed_legacy_value, ebitda_row_value) for one book whose
    persisted interest_coverage row is on the pre-revision EBITDA basis."""
    pid = "p-%s" % name
    double = RA.seed_double(
        orgs=[{"id": ORG, "name": "Corpus", "default_currency": "RON", "caen_code": "1011"}],
        memberships=[{"user_id": USER, "org_id": ORG, "role": "owner",
                      "created_at": "2026-01-01T00:00:00+00:00"}],
        periods=[(SB.book(name), pid, ORG, "2025-01-01", "2025-12-31")])
    with RA.installed(double):
        jwt = D.mint_jwt(USER)
        RA.seed_metrics(app, double, (pid,), ORG, jwt)
        rows = {r["name"]: r for r in double.tables["calculated_metrics"]
                if r.get("period_id") == pid}
        fresh = rows["interest_coverage"]["value"]
        legacy = rows["ebitda_to_interest"]["value"]
        assert fresh is not None and legacy is not None
        assert round(fresh, 2) != round(legacy, 2), "book cannot tell the two bases apart"
        rows["interest_coverage"]["value"] = legacy
        resp = RA.get(app, "/api/period/%s" % pid, jwt, ORG)
        assert resp.status_code == 200, resp.text
        return resp.json(), legacy, fresh


@pytest.mark.parametrize("name", BOOKS)
def test_a_legacy_ebitda_basis_row_is_served_as_one_figure_on_every_surface(app, name):
    body, legacy, fresh = _legacy_body(app, name)
    metrics = {r["name"]: r["value"] for r in body["metrics"]}
    am = body["assembled_metrics"]
    typed = am["ratios"]["coverage"]["interest_coverage"]
    table = {r["key"]: r for r in am["ratio_table"]["rows"]}["interest_coverage"]
    assert table["value_q"] is not None

    q = float(table["value_q"])
    assert round(metrics["interest_coverage"], 2) == q, (
        "%s: metrics[] serves %r, ratio_table serves %r under ONE key"
        % (name, metrics["interest_coverage"], table["value_q"]))
    assert round(typed, 2) == q, (
        "%s: assembled_metrics.ratios.coverage serves %r, ratio_table %r"
        % (name, typed, table["value_q"]))
    # ... and the one figure is the revised definition, not the filed one.
    assert round(metrics["interest_coverage"], 2) == round(fresh, 2)
    assert round(metrics["interest_coverage"], 2) != round(legacy, 2)


@pytest.mark.parametrize("name", BOOKS)
def test_the_filed_figure_is_disclosed_verbatim_and_the_ebitda_row_is_untouched(app, name):
    body, legacy, _fresh = _legacy_body(app, name)
    filed = {r["name"]: r["value"] for r in (body.get("credit_metrics_as_filed") or [])}
    assert filed.get("interest_coverage") == legacy
    metrics = {r["name"]: r["value"] for r in body["metrics"]}
    # `ebitda_to_interest` is itself revised since the one-EBITDA ruling: it
    # is served from the serve-time model (here the same figure, the seed
    # being fresh) and its persisted row is disclosed as filed.
    assert metrics["ebitda_to_interest"] == legacy
    assert body["assembled_metrics"]["ratios"]["coverage"]["ebitda_to_interest"] == legacy
    assert filed.get("ebitda_to_interest") == legacy


#: The one-EBITDA rows a revision-2 filing held on the definition WITHOUT
#: 711 / 72x, and the retired rows it held at all.
_REV2_ROWS = ("ebitda", "ebitda_cash", "ebitda_statutory", "operating_profit", "ebitda_margin",
              "debt_to_ebitda", "dscr", "ebitda_to_interest", "operating_margin")
_RETIRED = ("ebitda_statutory_with_711", "inventory_variation_memo", "total_operating_revenue_statutory")


def _revision_2_body(app, name):
    """A period persisted by revision 2: its one-EBITDA rows hold the
    EBITDA WITHOUT 711 / 72x, the retired rows are present (the gross 711
    credit turnover), the stamp says 2."""
    pid = "p-rev2-%s" % name
    double = RA.seed_double(
        orgs=[{"id": ORG, "name": "Corpus", "default_currency": "RON", "caen_code": "1011"}],
        memberships=[{"user_id": USER, "org_id": ORG, "role": "owner",
                      "created_at": "2026-01-01T00:00:00+00:00"}],
        periods=[(SB.book(name), pid, ORG, "2025-01-01", "2025-12-31")])
    with RA.installed(double):
        jwt = D.mint_jwt(USER)
        RA.seed_metrics(app, double, (pid,), ORG, jwt)
        rows = [r for r in double.tables["calculated_metrics"] if r.get("period_id") == pid]
        by = {r["name"]: r for r in rows}
        fresh = {k: by[k]["value"] for k in _REV2_ROWS}
        apl = SB.served_body(name)["statements"]["assembled_pl"]
        before = apl["ebitda_before_stock_variation"]
        filed = {"ebitda": before, "ebitda_cash": before, "ebitda_statutory": before,
                 "operating_profit": before - apl["depreciation"], "ebitda_margin": 0.0001,
                 "debt_to_ebitda": 99.0, "dscr": 0.01, "ebitda_to_interest": 0.02,
                 "operating_margin": 0.0002}
        for k, v in filed.items():
            by[k]["value"] = v
        by["credit_model_revision"]["value"] = 2
        for k, v in (("ebitda_statutory_with_711", 123456789.0), ("inventory_variation_memo", 987654321.0),
                     ("total_operating_revenue_statutory", 555555555.0)):
            double.tables["calculated_metrics"].append(dict(by["revenue"], name=k, value=v))
        resp = RA.get(app, "/api/period/%s" % pid, jwt, ORG)
        assert resp.status_code == 200, resp.text
        return resp.json(), filed, fresh


@pytest.mark.parametrize("name", ("agras", "realestate"))
def test_a_revision_2_filing_serves_the_one_ebitda_and_no_retired_row(app, name):
    body, filed, fresh = _revision_2_body(app, name)
    metrics = {r["name"]: r["value"] for r in body["metrics"]}
    as_filed = {r["name"]: r["value"] for r in (body.get("credit_metrics_as_filed") or [])}
    apl = body["statements"]["assembled_pl"]
    assert metrics["ebitda"] == apl["ebitda"] != filed["ebitda"], (metrics["ebitda"], apl["ebitda"])
    for k in _REV2_ROWS:
        assert metrics[k] == fresh[k], (name, k, metrics[k], fresh[k], filed[k])
        assert as_filed.get(k) == filed[k], (name, k, as_filed.get(k))
    for k in _RETIRED:
        assert k not in metrics, (name, k)
        assert k in as_filed, (name, k)
    typed = body["assembled_metrics"]["ratios"]
    assert typed["profitability"]["ebitda_margin"] == fresh["ebitda_margin"]
    assert typed["leverage"]["debt_to_ebitda"] == fresh["debt_to_ebitda"]
    assert typed["coverage"]["dscr"] == fresh["dscr"]
