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

WHAT IT REDS ON, AFTER THE REPAIR (TC-11):
  · `metrics[]`, `assembled_metrics.ratios.coverage` and `ratio_table`
    disagreeing on `interest_coverage` (at the table's own quantum);
  · the served figure being the legacy EBITDA one;
  · the filed figure not disclosed, verbatim, in `credit_metrics_as_filed`;
  · `ebitda_to_interest` (NOT revised) being touched.

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
    assert metrics["ebitda_to_interest"] == legacy
    assert body["assembled_metrics"]["ratios"]["coverage"]["ebitda_to_interest"] == legacy
    assert "ebitda_to_interest" not in filed
