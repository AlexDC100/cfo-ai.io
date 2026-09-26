"""GET /api/period/{id}/attention, UN-INTERCEPTED, on the real app.

The command bar prefetches this route on every (workspace, period) change and
its hermetic harness answers it from a file — an intercepted route is a route
with no gate (CLAUDE.md 22). This gate builds `engine.api.create_app()` (the
object `python -m engine serve` runs) over the projection-faithful tenancy
double (`firm_postgrest_double`: refuses a column no migration declares,
verifies ES256 bearers against the session JWKS), carries committed corpus
books through the production write seam as periods of two workspaces, and
asks with a real bearer. Only the network is doubled — and the network is
switched OFF for the whole run, so a model call would fail the request.

WHAT IT REDS ON, AFTER THE REPAIR (TC-11):
  * the route unmounted / renamed / its query binding broken;
  * the default comparison not being the same company's previous period of
    the same length: an eleven-month period, a period with no live
    document, a later period, or another workspace's period chosen;
  * the served document differing from `compose_attention` over the three
    documents the SAME app serves (GET /api/period, /comparatives with that
    prior, /sector-benchmark) — a second composition, or a source the
    served surfaces do not print;
  * `prior=none` not switching the comparison off, or losing the way back;
  * an explicit prior from another workspace served (not 404), the current
    period as its own prior (not 400);
  * the wall: a forged bearer (not 401), a caller outside the workspace
    (not 403), a current period of another workspace (not 404);
  * a single-period company served anything but its own findings and sector
    position;
  * any outbound network call (a model call) during the request.

WHAT IT CANNOT SEE: whether the ranking is right (test_attention_rules.py),
the sentinel law (test_attention_served_only.py), row-level security (the
double does not model RLS — the org filter in every select is what is proven).
"""
from __future__ import annotations

import json

import pytest

import _real_app_comparatives as RA
import firm_postgrest_double as D

USER = "7b0c0f3e-0000-4000-8000-00000000a7e1"
OUTSIDER = "7b0c0f3e-0000-4000-8000-00000000a7e2"
ORG = "0c0f0000-0000-4000-8000-00000000a7e1"
OTHER_ORG = "0c0f0000-0000-4000-8000-00000000a7e2"
CUR, PRI = "p-cur-dec2025", "p-pri-dec2024"
NOV = "p-cur-nov2025"          # eleven months: never the default for a December
NODOC = "p-a-dec2024-nodoc"     # same length, sorts first, but no live document
FOREIGN = "p-foreign-dec2024"   # same length, nearer by id, another workspace
CAEN = "1011"


@pytest.fixture(scope="module")
def app():
    return RA.build_app()


def _doc(i, org, pid):
    return {"id": "d-%s" % i, "org_id": org, "period_id": pid, "scope": "financial",
            "status": "analyzed", "storage_path": "o/%s.xlsx" % i,
            "original_filename": "%s.xlsx" % i, "size_bytes": 1}


@pytest.fixture()
def world(app, monkeypatch):
    import _served_books as SB

    double = RA.seed_double(
        orgs=[{"id": ORG, "name": "Corpus Entity", "default_currency": "RON", "caen_code": CAEN},
              {"id": OTHER_ORG, "name": "Another Workspace", "default_currency": "RON"}],
        memberships=[{"user_id": USER, "org_id": ORG, "role": "owner",
                      "created_at": "2026-01-01T00:00:00+00:00"},
                     {"user_id": OUTSIDER, "org_id": OTHER_ORG, "role": "owner",
                      "created_at": "2026-01-01T00:00:00+00:00"}],
        periods=[(SB.book("agras"), CUR, ORG, "2025-01-01", "2025-12-31"),
                 (SB.book("carniprod"), PRI, ORG, "2024-01-01", "2024-12-31"),
                 (SB.book("retail"), NOV, ORG, "2025-01-01", "2025-11-30"),
                 (SB.book("retail"), NODOC, ORG, "2024-01-01", "2024-12-31"),
                 (SB.book("retail"), FOREIGN, OTHER_ORG, "2024-01-01", "2024-12-31")])
    for i, (org, pid) in enumerate(((ORG, CUR), (ORG, PRI), (ORG, NOV), (OTHER_ORG, FOREIGN))):
        double.add("documents", _doc(i, org, pid))
    # A soft-deleted document does not make a period listable.
    double.add("documents", dict(_doc(9, ORG, NODOC), deleted_at="2026-09-01T00:00:00+00:00"))
    with RA.installed(double):
        RA.seed_metrics(app, double, (CUR, PRI, NOV, NODOC), ORG, D.mint_jwt(USER))
        RA.seed_metrics(app, double, (FOREIGN,), OTHER_ORG, D.mint_jwt(OUTSIDER))
        # THE NETWORK IS OFF from here: a model call cannot succeed. The real
        # transports (what the Anthropic SDK and every HTTP client ride) and
        # the socket layer refuse; the TestClient's in-process transport is
        # neither, so the request itself still reaches the app.
        import socket

        import httpx

        def _no_network(*_a, **_k):
            raise AssertionError("the attention route made an outbound network call")

        monkeypatch.setattr(httpx.HTTPTransport, "handle_request", _no_network)
        monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", _no_network)
        monkeypatch.setattr(socket, "create_connection", _no_network)
        monkeypatch.setattr(socket.socket, "connect", _no_network)
        yield double


def _get(app, path, bearer=None, org=ORG):
    return RA.get(app, path, bearer or D.mint_jwt(USER), org)


def _served(app, path="/api/period/%s/attention" % CUR):
    resp = _get(app, path)
    assert resp.status_code == 200, (resp.status_code, resp.text[:600])
    return resp.json()


def test_the_route_serves_the_company_against_its_same_length_prior(app, world):
    doc = _served(app)
    assert doc["schema"] == "attention/1"
    assert doc["prior"]["status"] == "found" and doc["prior"]["period_id"] == PRI, doc["prior"]
    assert doc["prior"]["rule"] == "same_company_previous_period_same_length"
    assert doc["mode"] == "with_prior"
    assert doc["period"]["id"] == CUR
    assert 2 <= len(doc["items"]) <= 3, [i["key"] for i in doc["items"]]
    assert doc["sources"]["comparatives"] == {"status": "served", "prior_period_id": PRI,
                                              "reason": None}
    assert doc["sources"]["sector_benchmark"]["caen"] == CAEN
    for item in doc["items"]:
        assert item["evidence"]["kind"] in ("statement", "ratio", "benchmark_row", "account")
    # every CANDIDATE read (periods by close date, documents by period) carried
    # the organization in its filter — and there were such reads
    candidate_reads = [(t, f) for _op, t, f, _c in world.selects()
                       if (t == "financial_periods" and "period_end" in f)
                       or (t == "documents" and "period_id" in f)]
    assert {t for t, _f in candidate_reads} == {"financial_periods", "documents"}, candidate_reads
    for table, filters in candidate_reads:
        assert filters.get("org_id") == "eq.%s" % ORG, (table, filters)


def test_the_route_composes_exactly_what_the_same_app_serves(app, world):
    """No second composition: the document is `compose_attention` over the
    period body, the comparatives document for the chosen prior and the
    sector document — each fetched here through its OWN route."""
    from engine.api import _features
    from engine.attention import compose_attention

    doc = _served(app)
    body = _get(app, "/api/period/%s" % CUR).json()
    cmp = _get(app, "/api/period/%s/comparatives?prior=%s" % (CUR, PRI)).json()
    sector = _get(app, "/api/period/%s/sector-benchmark" % CUR).json()
    features = {k: v.get("status") for k, v in _features.served_registry().items()}
    again = compose_attention(body, prior=doc["prior"], comparatives=cmp, sector=sector,
                              features=features)
    assert json.dumps(doc, sort_keys=True) == json.dumps(again, sort_keys=True)


def test_prior_none_switches_the_comparison_off_and_keeps_the_way_back(app, world):
    doc = _served(app, "/api/period/%s/attention?prior=none" % CUR)
    assert doc["prior"]["status"] == "off" and doc["prior"]["period_id"] is None
    assert doc["prior"]["available_period_id"] == PRI
    assert doc["mode"] == "single_period"
    assert doc["actions"][0]["key"] == "compare_prior"
    assert doc["actions"][0]["target"]["prior_period_id"] == PRI
    assert [c["key"] for c in doc["caveats"]] == ["comparison_off"]


def test_an_explicit_prior_is_read_inside_the_workspace_only(app, world):
    ok = _served(app, "/api/period/%s/attention?prior=%s" % (CUR, NOV))
    assert ok["prior"]["status"] == "found" and ok["prior"]["period_id"] == NOV
    assert ok["actions"][0]["key"] == "compare_previous_period"
    resp = _get(app, "/api/period/%s/attention?prior=%s" % (CUR, FOREIGN))
    assert resp.status_code == 404, (resp.status_code, resp.text[:300])
    assert resp.json()["detail"]["code"] == "period_not_in_workspace"
    assert "items" not in resp.text
    resp = _get(app, "/api/period/%s/attention?prior=%s" % (CUR, CUR))
    assert resp.status_code == 400 and resp.json()["detail"]["code"] == "same_period", resp.text[:300]


def test_a_single_period_company_is_served_from_its_own_findings(app, world):
    doc = _served(app, "/api/period/%s/attention" % PRI)
    assert doc["prior"]["status"] == "absent", doc["prior"]
    assert doc["prior"]["reason"]["code"] == "no_same_length_prior"
    assert doc["mode"] == "single_period"
    assert {i["family"] for i in doc["items"]} <= {"insight", "sector_row"}
    assert any(i["family"] == "insight" for i in doc["items"])
    assert doc["actions"][0]["key"] == "add_prior_year"
    assert doc["actions"][0]["target"]["period_end"] == "2023-12-31"


def test_a_forged_bearer_is_refused(app, world):
    resp = _get(app, "/api/period/%s/attention" % CUR, D.forged_jwt(USER))
    assert resp.status_code == 401, (resp.status_code, resp.text[:300])
    assert "items" not in resp.text


def test_a_workspace_the_caller_does_not_belong_to_is_refused(app, world):
    resp = _get(app, "/api/period/%s/attention" % CUR, D.mint_jwt(OUTSIDER))
    assert resp.status_code == 403, (resp.status_code, resp.text[:300])
    assert "items" not in resp.text


def test_a_current_period_from_another_workspace_is_not_found(app, world):
    resp = _get(app, "/api/period/%s/attention" % FOREIGN)
    assert resp.status_code == 404, (resp.status_code, resp.text[:300])
    assert resp.json()["detail"]["code"] == "period_not_in_workspace"
    assert "items" not in resp.text and "Another Workspace" not in resp.text
