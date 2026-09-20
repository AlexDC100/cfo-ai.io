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


def test_the_route_resolves_the_workspace_and_scopes_the_read_to_it(app, monkeypatch):
    """THE MEMBERSHIP GATE, exercised rather than read.

    `resolve_org` returns `(user_id, org_id)` — BOTH. Bound as one name it
    becomes the tuple, `"eq.%s" % org_id` renders
    `eq.('uid', 'orgid')`, PostgREST is handed a filter that matches
    nothing, and the route answers 404 to every caller while reading as
    "no such period". It shipped that way until the FC1 table census
    pointed at the module and the unpack was read properly.

    RED ON: the org resolution being dropped, its result mis-bound, or the
    period read losing its org_id filter.
    """
    from engine.api import _forecast_routes as FR

    seen = {}

    def _fake_resolve(jwt, requested):
        seen["jwt"] = jwt
        seen["requested"] = requested
        return ("user-1", "org-7")

    def _fake_load(jwt, org_id, period_id):
        seen["org_id"] = org_id
        seen["period_id"] = period_id
        raise AssertionError("stop here — the scoping is what is under test")

    from engine.api import _org
    monkeypatch.setattr(_org, "resolve_org", _fake_resolve)
    # plan/2 B5 (28.3 B5 "Retires"): the route's loader moved to
    # _forecast_history.load_plan_inputs; the canary name is unchanged.
    from engine.api import _forecast_history as FH
    assert not hasattr(FR, "_load_period")
    monkeypatch.setattr(FH, "load_plan_inputs", _fake_load)

    client = TestClient(app, raise_server_exceptions=False)
    client.get("/api/forecast/p-1?horizon=3",
               headers={"Authorization": "Bearer token-abc",
                        "X-Org-Id": "org-7"})
    assert seen.get("jwt") == "token-abc"
    assert seen.get("requested") == "org-7"
    assert seen.get("org_id") == "org-7", (
        "the period read was scoped to %r; a tuple here means every filter "
        "matches nothing and the route 404s for everyone"
        % (seen.get("org_id"),))
    assert isinstance(seen.get("org_id"), str)
    assert seen.get("period_id") == "p-1"


def test_the_period_read_filters_on_the_resolved_workspace():
    """RED ON: `load_plan_inputs` (the route's loader since plan/2 B5,
    over pipeline.load_period_rows) reading a period by id alone. RLS is the
    first lock and the org_id filter is the second; a route that drops the
    second is relying on a policy it does not itself state."""
    from engine.api import _forecast_history as FH

    calls = []

    class _Client(object):
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def select(self, table, **kw):
            calls.append((table, kw.get("filters") or {}))
            return []

    class _Supabase(object):
        @staticmethod
        def per_user(jwt):
            return _Client()

    from engine.api import _supabase as real
    original = real.per_user
    real.per_user = _Supabase.per_user
    try:
        with pytest.raises(Exception):
            FH.load_plan_inputs("jwt", "org-7", "p-1")
    finally:
        real.per_user = original

    assert calls, "no table was read at all"
    table, filters = calls[0]
    assert table == "financial_periods"
    assert filters.get("org_id") == "eq.org-7", filters
    assert filters.get("id") == "eq.p-1", filters


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

    # plan/2 B4b (28.3 B4): the known set is KEYS, FP1_CONVENTIONS and the
    # two pool template keys declared in levers.yaml, whose per-book
    # expansions (pool_fixed_share.<pool>, pool_level.<opex pool>) the
    # attribution may name.
    from engine.forecast.levers_pack import pool_templates
    templates = set(t["id"] for t in pool_templates().values())
    assert templates == {"pool_fixed_share.*", "pool_level.*"}, templates
    # plan/2 B5 (28.3 B5): the three index keys join the attribution
    # project_plan reads; the fp1 view drops them (checked below).
    known = (set(KEYS) | set(cid for cid, _b in P.FP1_CONVENTIONS) | templates
             | set(P.INDEX_KEYS))
    assert set(P.INDEX_KEYS) == {"volume_index", "price_index", "input_price_index"}
    assert "volume_index" in P.LINE_ASSUMPTIONS["pl.revenue"]
    assert "input_price_index" in P.LINE_ASSUMPTIONS["pl.cost_of_sales"]
    assert P.LINE_ASSUMPTIONS, "the attribution map is empty"
    for line in sorted(P.LINE_ASSUMPTIONS):
        ids = P.LINE_ASSUMPTIONS[line]
        assert ids, "%s names no reason" % line
        unknown = set(i for i in ids if i not in known and not P.is_pool_id(i))
        assert not unknown, (line, sorted(unknown))

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


# ── plan/2 B4b (contract 28.3 B4): the GET answers on every book at every
# horizon with the pool drivers expanded ────────────────────────────────


def _measure():
    import sys
    scripts = str(REPO / "scripts")
    if scripts not in sys.path:
        sys.path.insert(0, scripts)
    import measure_plan_blast_radius as M
    return M


def _call(name, method, horizon=5, body=None, mutate=None):
    """GET or POST through create_app and the route's own loader, rebuild,
    engine, fp1.2 builder and boundary guard, with the org and per-user seams
    replaced as scripts/measure_plan_blast_radius replaces them."""
    from engine.api import _forecast_history, _org, _supabase
    M = _measure()
    book = M._corpus_book(name)
    if mutate is not None:
        mutate(book)
    period_id, org_id = "route-period-%s" % name, "route-org-%s" % name
    saved = (_org.resolve_org, _supabase.per_user)
    _org.resolve_org = lambda jwt, requested: ("route-user", org_id)
    _supabase.per_user = lambda jwt: M._RowServer(book, period_id, org_id)
    _forecast_history.clear_cache()
    try:
        client = TestClient(M._app(), raise_server_exceptions=False)
        headers = {"Authorization": "Bearer route", "X-Org-Id": org_id}
        if method == "GET":
            res = client.get("/api/forecast/%s?horizon=%d" % (period_id, horizon),
                             headers=headers, follow_redirects=False)
        else:
            res = client.post("/api/forecast/%s/recompute" % period_id,
                              headers=headers, json=body, follow_redirects=False)
    finally:
        _org.resolve_org, _supabase.per_user = saved
        _forecast_history.clear_cache()
    return res.status_code, res.json()


@pytest.mark.parametrize("horizon", (3, 5))
@pytest.mark.parametrize("name", BOOKS)
def test_get_through_the_real_app_answers_200_with_no_clause_violation(name, horizon):
    """fp1.2 (plan/2 B6). RED ON: the GET not answering 200 on a corpus book;
    a body that breaks an fp1.2 clause (a figure naming an id that resolves
    in neither drivers nor conventions, an empty formula, a tier without its
    evidence, a float anywhere); a pool template token (``.*``) reaching the
    wire; the statement line items not reaching the engine (the refused
    single pool served through the real app — complete and unreachable)."""
    from engine.forecast_serving import plan_response
    status, body = _call(name, "GET", horizon)
    assert status == 200, (name, horizon, status, str(body)[:400])
    assert body["contract"] == "fp1.2"
    checked = dict((k, v) for k, v in body.items()
                   if k not in ("body_hash", "recompute_ms"))
    assert plan_response.clause_violations(checked) == [], (name, horizon)
    assert body["body_hash"] == plan_response.body_hash(body)
    assert isinstance(body["recompute_ms"], int)
    ids = set(body["drivers"])
    assert list(body["driver_order"]) == [k for k in body["driver_order"] if k in ids]
    assert not any(i.endswith(".*") for i in ids), sorted(ids)
    assert "pool_fixed_share.personnel" in ids, sorted(ids)
    assert "pool_fixed_share.operating_costs" not in ids, (
        "%s h%d serves the REFUSED single pool through the real app" % (name, horizon))
    assert "cost_behaviour.yaml#no_line_items" not in json.dumps(body["drivers"])
    assert body["unbalanced_periods"] == []
    assert len(body["horizon"]["labels"]) == 12 + horizon - 1
    assert body["horizon"]["served_through"] == body["horizon"]["labels"][-1]
    assert len(body["figures"]) > 500
    for figure in body["figures"]:
        assert figure["kind"] in ("projected", "projected_aggregate"), figure
        assert "basis" not in figure, "per-figure basis prose is back on the wire"
    assert set(body["conventions"]) >= {
        "held_at_opening_balance", "interest_charged_on_opening_balance",
        "tax_accrued_year_to_date", "tax_no_loss_carry_forward",
        "wc_unwind_ramp", "debt_timing", "days_basis"}


@pytest.mark.parametrize("horizon", (3, 5))
@pytest.mark.parametrize("name", BOOKS)
def test_get_equals_post_with_the_default_body(name, horizon):
    """1.2: GET ?horizon=h IS a POST of {"horizon": {"total_years": h,
    "monthly_months": 12}}. RED ON: a second code path behind either verb
    (the body_hash differs), or lever_set_hash differing between them."""
    _s, got = _call(name, "GET", horizon)
    status, posted = _call(name, "POST", body={
        "horizon": {"total_years": horizon, "monthly_months": 12}})
    assert status == 200, str(posted)[:300]
    assert got["body_hash"] == posted["body_hash"], (name, horizon)
    assert got["lever_set_hash"] == posted["lever_set_hash"]


def test_the_post_body_binds_at_module_scope(app):
    """CLAUDE.md 22. RED ON: PlanRequestBody (or any model it nests) defined
    inside the router factory, where a future-annotations module binds it as
    a QUERY parameter and every body answers 422 loc [query, body]."""
    from engine.api import _forecast_routes as FR
    for name in ("PlanRequestBody", "HorizonBody", "ShockBody", "OverrideBody",
                 "BehaviourOverrideBody", "DebtRowBody", "SpreadBody"):
        assert getattr(FR, name).__module__ == FR.__name__
        assert getattr(FR, name).__qualname__ == name, "nested: %s" % name
    paths = [(r.path, sorted(getattr(r, "methods", ()) or ())) for r in app.routes]
    assert ("/api/forecast/{period_id}/recompute", ["POST"]) in paths
    assert not any(p.endswith("/scenario") for p, _m in paths)
    status, body = _call("agras", "POST", body={"horizon": {"total_years": 3}})
    assert status == 200, str(body)[:300]
    assert "query" not in json.dumps(body.get("detail", ""))


@pytest.mark.parametrize("body,code,field", [
    ({"horizon": {"total_years": 3}, "case": "upside"}, "not_served_in_this_build", "case"),
    ({"horizon": {"total_years": 3}, "want": ["tornado"]}, "unknown_want_key", "tornado"),
    ({"horizon": {"total_years": 3}, "surface": "cockpit"}, "invalid_request", "surface"),
    ({"horizon": {"total_years": 9}}, "total_years_out_of_range", "horizon.total_years"),
    ({}, "horizon_required", "horizon"),
    ({"horizon": {"total_years": 3},
      "shocks": [{"id": "rail:volume_index", "driver_key": "volume_index",
                  "op": "level_pct", "value": -0.2}]}, "invalid_request", "shocks.0.value"),
    ({"horizon": {"total_years": 3},
      "shocks": [{"id": "override:x", "driver_key": "volume_index",
                  "op": "level_pct", "value": "-0.2"}]}, "reserved_shock_id", "override:x"),
    ({"horizon": {"total_years": 3},
      "shocks": [{"id": "rail:revenue_growth", "driver_key": "revenue_growth",
                  "op": "add_pp", "value": "0.01"}]},
     "growth_change_is_an_override", "rail:revenue_growth"),
])
def test_an_invalid_request_is_422_with_code_text_and_field(body, code, field):
    """3.11. RED ON: a float accepted where a decimal string belongs, an
    unknown field or an unlanded field served, a reserved id accepted from a
    client, or a refusal leaving without its {code, text, field}."""
    status, answer = _call("agras", "POST", body=body)
    assert status == 422, (status, str(answer)[:300])
    detail = answer["detail"]
    assert detail["code"] == code, detail
    assert detail["field"] == field, detail
    assert detail["text"].strip()


# ── 6.5 through the route (retires the B5 pin "answers 422 never a partial
# fp1": fp1.2 carries refusal and served_through, so the partial serve is
# now the contract) ─────────────────────────────────────────────────────


def test_a_base_plan_that_draws_an_unpriceable_line_is_served_partially_and_says_so(
        monkeypatch):
    """SYNTHETIC: carniprod (which prices no revolver) with resolved defaults
    that make its BASE plan draw: payout 95%, a 2M cash floor, capex 20% of
    revenue. No corpus book's base plan draws.

    RED ON: a truncated plan served with no refusal or served_through; a
    period after the refusal served as a number or a zero; an FY aggregate of
    a partly served year served as a total; the refusal naming neither the
    period nor the amount."""
    import engine.forecast.levers as levers
    real = levers.resolve_defaults

    def stressed(opening, history, context, prior, overrides):
        from engine.forecast.assumptions import Assumption
        forced = dict(overrides)
        forced.update(dividend_payout_pct=0.95, min_cash=2000000.0,
                      capex_pct_of_revenue=0.20)
        resolved, notes = real(opening, history, context, prior, forced)
        # The caller channel stamps tier "user" with no original, which no
        # request can produce and the fp1.2 clause rightly refuses. The
        # SYNTHETIC defaults are re-stamped as a labelled convention.
        for key in ("dividend_payout_pct", "min_cash", "capex_pct_of_revenue"):
            was = resolved.get(key)
            resolved._by_key[key] = Assumption(
                key, was.unit, was.exact, "engine_default",
                "SYNTHETIC stress default", tier="convention",
                rule_id="tests#synthetic_stress",
                evidence={"rule_id": "tests#synthetic_stress",
                          "pack_address": "tests#synthetic_stress", "evidence": []})
        return resolved, notes

    status, whole = _call("carniprod", "GET", 5)
    assert status == 200, "TC-3: carniprod's own base plan no longer serves"
    assert whole["refusal"] is None
    monkeypatch.setattr(levers, "resolve_defaults", stressed)
    status, body = _call("carniprod", "GET", 5)
    assert status == 200, (status, str(body)[:300])
    refusal = body["refusal"]
    assert refusal and refusal["driver_key"] == "revolver_rate", refusal
    assert refusal["shortfall_minor"] > 0
    labels = body["horizon"]["labels"]
    assert refusal["from_period"] in labels
    cut = labels.index(refusal["from_period"])
    assert body["horizon"]["served_through"] == labels[cut - 1]
    served = set(f["period"] for f in body["figures"] if "amount_minor" in f)
    assert not served & set(labels[cut:]), "a period after the refusal is served"
    fy = body["horizon"]["labels_annual"][0]
    aggregates = [f for f in body["figures"] if f["period"] == fy]
    assert aggregates and all("refused" in f and "amount_minor" not in f
                              for f in aggregates), aggregates[:1]
    assert fy not in [b["period"] for b in body["balance_check"]]
    for point in body["series"]["closing_cash"][cut:]:
        assert "refused" in point and "amount_minor" not in point, point
    assert "refused" in body["summary"]["peak_funding_gap"]
    text = refusal["sentence"]["text"]
    assert "cannot price" in text or "funding line" in text, text


def test_a_refusal_that_begins_in_the_first_period_is_200_with_nothing_served():
    """plan/2 B6 repair (B6V-2a): carniprod opens with about 10.0M RON cash
    and prices no funding line; a 12M cash floor draws in the FIRST plan
    month, so zero periods are served. Contract 6.5: 200 with the refusal.

    RED ON: a 500 (strip.py indexed periods[-1] of an empty tuple); a
    from_period other than the first label; a served_through; any series
    point or strip field served as a number; a figure carrying an amount.
    AFTER THE REPAIR (TC-11) it fails on exactly those; it cannot see a
    refusal that begins later (the partial test above holds that)."""
    request = {"horizon": {"total_years": 3, "monthly_months": 12},
               "overrides": {"min_cash": {"values": ["12000000"]}}}
    for want in (None, ["strip"], ["figures", "series", "summary", "strip"]):
        body = dict(request) if want is None else dict(request, want=want)
        status, answer = _call("carniprod", "POST", body=body)
        assert status == 200, (want, status, str(answer)[:300])
        labels = answer["horizon"]["labels"]
        assert answer["refusal"]["from_period"] == labels[0], answer["refusal"]
        assert answer["horizon"]["served_through"] is None
        sentence = answer["refusal"]["sentence"]
        for name, field in answer["strip"].items():
            assert "refused" in field and "amount_minor" not in field, (name, field)
        for name in ("peak_funding_gap", "cumulative_fcf", "closing_cash"):
            assert answer["strip"][name]["refused"] == sentence, name
        if want is None or "series" in want:
            points = [p for series in answer["series"].values() for p in series]
            assert points and all("refused" in p and "amount_minor" not in p
                                  for p in points)
        if want is None or "figures" in want:
            assert answer["figures"] and not [
                f for f in answer["figures"] if "amount_minor" in f]
        if want is None or "summary" in want:
            assert answer["summary"]["cash_trough"] is None
