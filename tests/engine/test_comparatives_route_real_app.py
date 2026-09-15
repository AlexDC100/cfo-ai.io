"""GET /api/period/{id}/comparatives, UN-INTERCEPTED, on the real app.

Every frontend ratio gate renders a committed capture, and the hermetic
Playwright harness answers the route from a file: no gate had ever sent a
request to the route the dashboard and the exports actually call. An
intercepted route is a route with no gate (CLAUDE.md 22), and the earlier
route test (`test_comparatives_route.py::_route_over_two_books`) mounts
one router on a bare `FastAPI()` with `_org.resolve_org` stubbed, so the
app's middleware, the identity wall and the membership check were never in
the path.

This gate builds `engine.api.create_app()` itself (the object `python -m
engine serve` runs), points `_supabase.per_user` and `_supabase.admin` at
the projection-faithful tenancy double (`firm_postgrest_double`: it
refuses a column the migrations do not declare, and it VERIFIES bearer
signatures against the session's test JWKS), seeds two committed corpus
books as two periods of one workspace through the production write seam
(`_served_books.book`: parse -> stage_map -> stage_persist), and asks for
the comparison with a real ES256 bearer. Nothing on the request path is
stubbed but the network.

WHAT IT REDS ON, AFTER THE REPAIR (TC-11):
  · the route unmounted, renamed, or no longer reachable through
    create_app (404 / 405), or its query binding broken (422);
  · the served document without its `ratios` block, a census row or a
    composite missing, or a prior Altman Z'', composite score or letter
    grade that is not a number on a pair whose prior scores;
  · the route's `ratios` differing from `compare_payloads` over the two
    GET /api/period bodies the SAME app serves (a second composition on
    the route, or a period body the route reads differently from the
    dashboard);
  · the committed frontend fixture (`pair_served.json`, what the byte-match
    and Ratios-tab gates render) printing a different quantized figure,
    band or movement from what this route serves for the same pair;
  · the workspace's CAEN not reaching the band findings (ruling Q6);
  · the wall: a forged bearer served (not 401), a member asking for a
    workspace they do not belong to served (not 403), a prior period of
    another workspace served (not 404 period_not_in_workspace).

WHAT IT CANNOT SEE: whether the ratios are right (test_ratio_compare.py,
test_comparatives_bands.py own that); the frontend's reading of the
response (ratioTableByteMatch.test.tsx and ratioCompareTab.test.tsx).
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

import _real_app_comparatives as RA
import firm_postgrest_double as D

REPO = Path(__file__).resolve().parents[2]
FE_FIXTURE = REPO / "frontend" / "lib" / "__tests__" / "fixtures" / "comparatives" / "pair_served.json"

USER = "7b0c0f3e-0000-4000-8000-00000000c0a1"
OUTSIDER = "7b0c0f3e-0000-4000-8000-00000000c0a2"
ORG = "0c0f0000-0000-4000-8000-0000000000a1"
OTHER_ORG = "0c0f0000-0000-4000-8000-0000000000b2"
CUR, PRI, FOREIGN = "p-agras-dec2025", "p-carniprod-dec2024", "p-retail-foreign"
CAEN = "1011"


@pytest.fixture(scope="module")
def app():
    return RA.build_app()


@pytest.fixture()
def world(app):
    import _served_books as SB

    double = RA.seed_double(
        orgs=[{"id": ORG, "name": "Corpus Entity", "default_currency": "RON", "caen_code": CAEN},
              {"id": OTHER_ORG, "name": "Another Workspace", "default_currency": "RON"}],
        memberships=[{"user_id": USER, "org_id": ORG, "role": "owner", "created_at": "2026-01-01T00:00:00+00:00"},
                     {"user_id": OUTSIDER, "org_id": OTHER_ORG, "role": "owner",
                      "created_at": "2026-01-01T00:00:00+00:00"}],
        periods=[(SB.book("agras"), CUR, ORG, "2025-01-01", "2025-12-31"),
                 (SB.book("carniprod"), PRI, ORG, "2024-01-01", "2024-12-31"),
                 (SB.book("retail"), FOREIGN, OTHER_ORG, "2024-01-01", "2024-12-31")])
    with RA.installed(double):
        # Analysed periods: the metric rows stage_compute persists, so the
        # bodies carry credit_metrics_as_filed as a real period's do.
        RA.seed_metrics(app, double, (CUR, PRI), ORG, D.mint_jwt(USER))
        RA.seed_metrics(app, double, (FOREIGN,), OTHER_ORG, D.mint_jwt(OUTSIDER))
        yield double


_get = RA.get


def _served(app, bearer=None):
    resp = _get(app, "/api/period/%s/comparatives?prior=%s" % (CUR, PRI), bearer or D.mint_jwt(USER), ORG)
    assert resp.status_code == 200, (resp.status_code, resp.text[:600])
    return resp.json()


def test_the_route_serves_every_ratio_and_a_numeric_prior_for_every_composite(app, world):
    doc = _served(app)
    ratios = doc.get("ratios")
    assert isinstance(ratios, dict), sorted(doc)
    from engine.ratios.table import CENSUS

    keys = [r["key"] for r in ratios["rows"]]
    assert keys == list(CENSUS), keys
    comps = {c["key"]: c for c in ratios["composites"]}
    assert list(comps) == ["altman_z", "credit_composite", "letter_grade"], list(comps)
    for key, row in comps.items():
        assert row["prior"]["value_q"] is not None, (key, row["prior"])
    float(comps["altman_z"]["prior"]["value_q"])
    bm = ratios["band_movements"]
    assert bm["improved"] and bm["deteriorated"], bm
    for f in bm["findings"]:
        assert f["contract_elements"]["confidence"]["basis"].endswith("resolved from caen+structure"), (
            f["ratio_key"], f["contract_elements"]["confidence"]["basis"])


def test_the_route_composes_the_two_bodies_the_same_app_serves(app, world):
    from engine.api import _comparatives as C

    doc = _served(app)
    bearer = D.mint_jwt(USER)
    bodies = []
    for pid in (CUR, PRI):
        resp = _get(app, "/api/period/%s" % pid, bearer, ORG)
        assert resp.status_code == 200, resp.text[:400]
        bodies.append(resp.json())
    rows = {r["id"]: r for r in world.rows("financial_periods")}
    again = C.compare_payloads(bodies[0], bodies[1], current_row=rows[CUR], prior_row=rows[PRI], caen=CAEN)
    assert json.dumps(doc["ratios"], sort_keys=True) == json.dumps(again["ratios"], sort_keys=True)


def test_the_committed_frontend_fixture_is_what_this_route_serves_for_the_pair(app, world):
    """The byte-match and Ratios-tab gates render `pair_served.json`; it was
    composed off the route (period labels set by hand). Every figure, band,
    change and movement it carries must be what the route serves."""
    served = _served(app)["ratios"]
    fixture = json.loads(FE_FIXTURE.read_text(encoding="utf-8"))["comparatives"]["ratios"]

    def printed(block):
        out = {}
        for row in block["rows"] + block["composites"]:
            out[row["key"]] = (row["current"]["value_q"], row["prior"]["value_q"],
                               row["current"]["band"], row["prior"]["band"],
                               row["delta"]["value"], row["delta"].get("pct_change"),
                               row["movement"]["status"])
        return out

    assert printed(served) == printed(fixture)
    for bucket in ("improved", "deteriorated", "unchanged", "not_comparable"):
        assert served["band_movements"][bucket] == fixture["band_movements"][bucket], bucket


def test_a_forged_bearer_is_refused(app, world):
    resp = _get(app, "/api/period/%s/comparatives?prior=%s" % (CUR, PRI), D.forged_jwt(USER), ORG)
    assert resp.status_code == 401, (resp.status_code, resp.text[:300])
    assert "ratios" not in resp.text


def test_a_workspace_the_caller_does_not_belong_to_is_refused(app, world):
    resp = _get(app, "/api/period/%s/comparatives?prior=%s" % (CUR, PRI), D.mint_jwt(OUTSIDER), ORG)
    assert resp.status_code == 403, (resp.status_code, resp.text[:300])
    assert "ratios" not in resp.text


def test_a_prior_from_another_workspace_is_not_found(app, world):
    resp = _get(app, "/api/period/%s/comparatives?prior=%s" % (CUR, FOREIGN), D.mint_jwt(USER), ORG)
    assert resp.status_code == 404, (resp.status_code, resp.text[:300])
    assert resp.json()["detail"]["code"] == "period_not_in_workspace", resp.text[:300]
    assert "ratios" not in resp.text
