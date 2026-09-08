"""``GET /api/forecast/{period_id}`` — the route that made the forecast
reachable, and the guarantees it must keep on the way out.

WHY THIS FILE EXISTS
====================
`engine/forecast` and `engine/forecast_serving` were complete, tested and
UNREACHABLE. No router mounted them, no page rendered them, no menu row
pointed anywhere. The owner found it by looking for the feature in the
product and not seeing it — which is the only way an unreachable feature
is ever found.

Worse, when the two halves were finally joined they did not fit: the
producer emitted no `line_assumptions`, so `fp1_from_forecast_v1`
attached no attribution, so the contract's `figure_names_no_assumption`
refused the WHOLE payload — on agras, carniprod, retail and realestate,
at 3 years and at 5. The fp1 lane had only ever been exercised against a
hand-built 5-line fixture with 3 drivers. A shape nobody feeds back is a
shape nobody has read.

WHAT THIS REDS ON (TC-11)
  · the route disappearing from the real app, or changing method;
  · an unauthenticated call being answered;
  · a horizon the engine does not offer being CLAMPED instead of refused;
  · the response carrying a figure without the `projected` marker;
  · any projected figure carrying actual provenance (a snapshot id, a
    line id, a source cell) — the central invariant of the feature;
  · the payload failing to read back through its own contract.

WHAT IT CANNOT SEE
  · what the page paints. `frontend/pages/cfo/Forecast.tsx` is a
    different code path and has its own gate.
  · whether the projected numbers are GOOD. They are arithmetic over
    stated drivers; `test_forecast_model.py` owns their correctness.

Python 3.9 — no ``match``, no ``X | Y`` unions.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from engine.forecast import project_payload
from engine.forecast_serving import boundary, contract
from engine.forecast_serving.adapter import fp1_from_forecast_v1
from engine.forecast_serving.gateway import ProjectionGateway

REPO = Path(__file__).resolve().parents[2]
BOOKS = ("agras", "carniprod", "retail", "realestate")


def _book(name):
    return json.loads(
        (REPO / "tests" / "engine" / "fixtures" / "firm"
         / ("saga_10_col_%s.json" % name)).read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def app():
    """The REAL app. Same env shape as `test_route_bindings.py`'s fixture,
    including its refusal to build against a non-manifest Supabase URL —
    "never point test-mode at production" is a standing rule here, and the
    junk-workspace incident is why."""
    os.environ.setdefault("VITE_SUPABASE_URL", "https://test.supabase.co")
    os.environ.setdefault("VITE_SUPABASE_ANON_KEY", "test-anon")
    os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test-service")
    os.environ["CFO_AI_SKIP_BOOT_VERIFY"] = "1"
    assert ("supabase.co" in os.environ["VITE_SUPABASE_URL"]
            and "test." in os.environ["VITE_SUPABASE_URL"]), (
        "refusing to build the app against a non-manifest Supabase URL")
    from engine.api.server import create_app
    return create_app()


def test_the_route_is_mounted_on_the_real_app(app):
    """RED ON: the router being unmounted again — which is the state the
    whole feature shipped in."""
    paths = [(r.path, sorted(getattr(r, "methods", ()) or ()))
             for r in app.routes]
    assert ("/api/forecast/{period_id}", ["GET"]) in paths, (
        "the forecast route is not on the app; every projection is "
        "unreachable again. Mounted routes: %r"
        % sorted(p for p, _m in paths))


def test_an_anonymous_call_is_refused(app):
    """RED ON: the projection of one workspace's book being readable
    without a session."""
    client = TestClient(app)
    res = client.get("/api/forecast/00000000-0000-0000-0000-000000000000")
    assert res.status_code == 401, (res.status_code, res.text)


def test_a_horizon_the_engine_does_not_offer_is_refused_by_name(app):
    """RED ON: a horizon being CLAMPED. Serving three years to someone who
    asked for seven, silently, is the class of defect this repo keeps
    finding — and the number of years is on the page the reader signs.

    NOTE ON ORDER, so the next reader knows it is a decision: the horizon
    is validated BEFORE the bearer is resolved, so this 422 reaches a
    caller whose token is junk. It discloses only which horizons the
    product offers, which is already in the shipped frontend bundle, and
    it reads no row. Nothing behind this route is touched until
    `resolve_org` has proved membership.
    """
    from engine.api._forecast_routes import ALLOWED_HORIZONS

    client = TestClient(app)
    res = client.get(
        "/api/forecast/00000000-0000-0000-0000-000000000000?horizon=7",
        headers={"Authorization": "Bearer irrelevant-the-check-is-first"})
    assert res.status_code == 422, (res.status_code, res.text)
    detail = res.json().get("detail", "")
    assert "7" in detail and "will not quietly serve" in detail, detail
    for allowed in ALLOWED_HORIZONS:
        assert str(allowed) in detail, detail


@pytest.mark.parametrize("name", BOOKS)
@pytest.mark.parametrize("horizon", (3, 5))
def test_every_real_book_produces_a_servable_projection(name, horizon):
    """THE MEASUREMENT THE ROUTE STANDS ON.

    Before `line_assumptions`, this raised `ProjectionContractError` on
    all eight combinations. RED ON: any real book losing its projection,
    any figure arriving unattributed, or a period that stops balancing.
    """
    projection = project_payload(_book(name), horizon_years=horizon)
    gateway = ProjectionGateway(fp1_from_forecast_v1(projection.as_dict()))
    payload = gateway.as_dict()

    assert payload["unbalanced_periods"] == [], payload["unbalanced_periods"]
    assert len(payload["horizon"]) >= horizon
    assert len(payload["figures"]) > 500, len(payload["figures"])
    refused = [f for f in payload["figures"] if f.get("refused")]
    assert refused == [], refused[:2]
    for figure in payload["figures"]:
        assert figure.get("projected") is True, figure
        assert figure.get("basis"), figure


@pytest.mark.parametrize("name", BOOKS)
def test_no_projected_figure_carries_actual_provenance(name):
    """THE CENTRAL INVARIANT. A projected number that names a source cell
    is a fabricated fact — and the affordance over it would promise the
    reader a jump into a book that says no such thing.

    RED ON: a snapshot id, line id or source cell reaching any figure.
    """
    projection = project_payload(_book(name), horizon_years=3)
    payload = ProjectionGateway(
        fp1_from_forecast_v1(projection.as_dict())).as_dict()
    offenders = boundary.actual_provenance_on_projection(payload)
    assert offenders == [], offenders
    # The projection AS A WHOLE names the book it stands on. That is the
    # one sanctioned pointer, and it lives above every figure.
    assert "base_period" in payload


@pytest.mark.parametrize("name", BOOKS)
def test_the_served_payload_reads_back_through_its_own_contract(name):
    """RED ON: the wire form drifting from the shape the contract reads.

    Wave 1 shipped exactly that defect — `as_dict()` was inspected seven
    times and never once fed back in, and the served bytes did not parse:
    30 broken clauses and 15 em-dashes.
    """
    projection = project_payload(_book(name), horizon_years=3)
    payload = ProjectionGateway(
        fp1_from_forecast_v1(projection.as_dict())).as_dict()
    assert contract.clause_violations(payload) == []
    again = ProjectionGateway.from_payload(payload)
    assert again is not None
    assert again.as_dict() == payload, (
        "the payload does not survive a round trip through its own reader")


def test_every_projected_line_names_a_driver_or_a_stated_convention():
    """RED ON: a line reaching a reader as a number with no reason.

    The map lives beside the arithmetic in `engine.forecast.project` and
    asserts its own coverage at IMPORT — a line added without an entry
    would otherwise take the whole projection down at the contract, which
    is how the map came to be written.
    """
    import importlib
    P = importlib.import_module("engine.forecast.project")
    from engine.forecast.assumptions import KEYS

    known = set(KEYS) | set(cid for cid, _b in P.FP1_CONVENTIONS)
    assert P.LINE_ASSUMPTIONS, "the attribution map is empty"
    for line in sorted(P.LINE_ASSUMPTIONS):
        ids = P.LINE_ASSUMPTIONS[line]
        assert ids, "%s names no reason" % line
        assert set(ids) <= known, (line, sorted(set(ids) - known))

    # And it covers what the model actually emits — the same assertion the
    # module runs at import, restated here so a `try/except ImportError`
    # somewhere upstream cannot swallow it.
    P._assert_attribution_covers_every_line()


def test_a_convention_is_served_without_a_number():
    """RED ON: a convention arriving with a value. `held at the opening
    balance` is a stated rule, not a quantity; a number beside it would
    read as a rate the model applies and there is none."""
    projection = project_payload(_book("agras"), horizon_years=3)
    payload = ProjectionGateway(
        fp1_from_forecast_v1(projection.as_dict())).as_dict()
    conventions = [a for a in payload["assumptions"]
                   if a["unit"] == "convention"]
    assert conventions, "no convention reached the served drivers"
    ids = set(a["id"] for a in conventions)
    assert "held_at_opening_balance" in ids, sorted(ids)
    for a in conventions:
        assert a["basis"].strip(), a["id"]
        assert set(a["values"].values()) == {None}, (
            "%s carries a number; a convention has none" % a["id"])
