"""THE CREDIT SERVING BOUNDARY, gated on the REAL app (owner, 2026-09-20:
"the credit range gate goes at the serving boundary so no fallback can
bypass it; plant a model-failure path serving an exploded value -> RED").

`engine.ratios.credit_boundary.enforce_credit_boundary` is the one function
applied to the credit content of every response as it leaves the engine.
This file drives `engine.api.create_app()` (the object `python -m engine
serve` runs) over the tenancy double, with a period whose PERSISTED
revision-1 rows carry Altman X4 1500 / Z'' 1584.89 / composite 88.5 AA
(what revision 1 filed for `saga_compact_6_col`, measured 2026-09-14), and
breaks the model in every way the route has a fallback for.

WHAT THIS REDS ON, after the repair (TC-11): any of the exploded figures,
an Altman zone or a letter anywhere in a served body outside a `withdrawn`
/ `withheld` record, on GET /api/period, GET /api/period/{id}/comparatives
(either side) or the briefing narrator's payload, when the credit model
raises, returns nothing, the ratio table raises, or the period is healthy;
a body that withholds without `credit_out_of_range`; a credit-family reader
in `src/engine/api` that is not behind the boundary.

THE PLANT IS IN THE SUITE: `test_with_the_boundary_bypassed_the_failure_path
_serves_the_exploded_value` replaces the boundary with the identity and
asserts the route then serves 1584.89 - the day that stops being true, the
route has a second authority and this gate no longer measures the boundary.

WHAT IT CANNOT SEE (TC-13): whether an in-range figure is the right figure
(ratio-credit-model's golden); the domain half of the law on a payload
whose statements are absent; the FE reader (creditRefusedSubscores.test.tsx
re-reads the served ranges); a response built outside `src/engine/api`.
"""
from __future__ import annotations

import copy
import json
import re
from pathlib import Path
from typing import Any, Dict, List

import pytest

import _real_app_comparatives as RA
import firm_postgrest_double as D
import served_range_law as LAW
import test_served_range as SR

REPO = Path(__file__).resolve().parents[2]
USER = "7b0c0f3e-0000-4000-8000-00000000cb01"
ORG = "0c0f0000-0000-4000-8000-0000000000cb"
EXPLODED, HEALTHY = "p-compact-rev1", "p-agras-healthy"
FIGURES = ("1584.89", "1500.0", "88.5")

#: How the model is broken, per failure path. Each is a seam the route has a
#: fallback for; none of them is the boundary.
FAILURES = {
    "compute_period_metrics raises": ("engine.ratios.credit_model", "compute_period_metrics", "raise"),
    "serve_time_metric_rows returns None": ("engine.ratios.table", "serve_time_metric_rows", "none"),
    "build_ratio_table raises": ("engine.ratios.table", "build_ratio_table", "raise"),
}


def _boom(*_a, **_k):
    raise RuntimeError("planted model failure")


@pytest.fixture(scope="module")
def app():
    return RA.build_app()


@pytest.fixture()
def world(app):
    import _served_books as SB
    import test_rebuild_net_income_anchor as ANCHOR

    compact = ANCHOR._Book(SR.COMPACT)
    double = RA.seed_double(
        orgs=[{"id": ORG, "name": "Boundary Entity", "default_currency": "RON"}],
        memberships=[{"user_id": USER, "org_id": ORG, "role": "owner", "created_at": "2026-01-01T00:00:00+00:00"}],
        periods=[(compact, EXPLODED, ORG, "2024-01-01", "2024-12-31"),
                 (SB.book("agras"), HEALTHY, ORG, "2025-01-01", "2025-12-31")])
    with RA.installed(double):
        bearer = D.mint_jwt(USER)
        RA.seed_metrics(app, double, (HEALTHY,), ORG, bearer)
        statements = RA.get(app, "/api/period/%s" % EXPLODED, bearer, ORG).json()["statements"]
        mcols = set(double.columns["calculated_metrics"])
        for m in SR._revision_1_rows(statements):
            double.add("calculated_metrics", {k: v for k, v in dict(m, period_id=EXPLODED, org_id=ORG).items()
                                              if k in mcols})
        yield double


def _break(mp: pytest.MonkeyPatch, failure: str) -> None:
    import importlib

    module, name, how = FAILURES[failure]
    mp.setattr(importlib.import_module(module), name, _boom if how == "raise" else (lambda *_a, **_k: None))


def _strip_records(node: Any) -> Any:
    """The body with every `withdrawn` / `withheld` / `credit_boundary`
    record removed: what is SERVED AS A FIGURE, as opposed to what is
    disclosed as withheld."""
    if isinstance(node, dict):
        return {k: _strip_records(v) for k, v in node.items()
                if k not in ("withdrawn", "withheld", "credit_boundary", "statements", "prior_statements",
                             "line_items", "prior_line_items")}
    if isinstance(node, list):
        return [_strip_records(v) for v in node]
    return node


def _credit_text(body: Dict[str, Any]) -> str:
    """Every credit-bearing part of a body, as text."""
    served = _strip_records(body)
    parts: List[Any] = []
    am = served.get("assembled_metrics") or {}
    parts += [am.get("credit"), (am.get("ratio_table") or {}).get("credit"),
              [r for r in served.get("metrics") or [] if _is_credit_row(r)],
              [r for r in served.get("credit_metrics_as_filed") or [] if _is_credit_row(r)],
              [r for r in served.get("prior_metrics") or [] if _is_credit_row(r)]]
    ratios = served.get("ratios") or {}
    parts += [ratios.get("composites"), ratios.get("subscores"), ratios.get("credit")]
    return json.dumps(parts, sort_keys=True)


def _is_credit_row(r: Any) -> bool:
    return isinstance(r, dict) and str(r.get("name", "")).startswith(("altman_", "credit_"))


def _assert_no_exploded_figure(where: str, body: Dict[str, Any]) -> None:
    text = _credit_text(body)
    for fig in FIGURES:
        assert not re.search(r"(?<![\d.])%s(?![\d])" % re.escape(fig), text), (
            "%s: the exploded figure %s is served as a figure" % (where, fig))


def _assert_period_refuses(where: str, body: Dict[str, Any]) -> None:
    env = body["assembled_metrics"]["credit"]
    _assert_no_exploded_figure(where, body)
    assert env["altman_z_score"] is None and env["altman_components"]["x4"] is None, (where, env)
    assert env.get("altman_zone") is None, (where, env.get("altman_zone"))
    assert env["composite_score"] is None and env["letter_grade"] is None, (where, env)
    assert env["subscores"]["altman"] is None, where
    rows = {r["name"]: r["value"] for r in body["metrics"]}
    for name in ("altman_z_score", "altman_x4", "credit_subscore_altman", "credit_composite"):
        assert rows[name] is None, (where, name, rows[name])
    table = (body["assembled_metrics"].get("ratio_table") or {}).get("credit")
    if table is not None:
        assert table["altman"]["z"] is None and table["altman"]["zone"] is None, where
        assert table["composite"] is None and table["letter"] is None, where
    codes = json.dumps(body["assembled_metrics"], sort_keys=True)
    assert "credit_out_of_range" in codes, "%s: nothing says credit_out_of_range" % where


# ── the required plant: a model-failure path serving an exploded value ───────


@pytest.mark.parametrize("failure", sorted(FAILURES))
def test_a_model_failure_path_serves_no_exploded_figure_no_zone_and_no_letter(app, world, failure):
    mp = pytest.MonkeyPatch()
    try:
        _break(mp, failure)
        resp = RA.get(app, "/api/period/%s" % EXPLODED, D.mint_jwt(USER), ORG)
    finally:
        mp.undo()
    assert resp.status_code == 200, (failure, resp.status_code, resp.text[:300])
    body = resp.json()
    assert body["assembled_metrics"]["credit"]["basis"] == "as_filed", failure
    _assert_period_refuses(failure, body)
    withdrawn = {w["figure"]: w for w in body["assembled_metrics"]["credit"]["withdrawn"]}
    assert (withdrawn["altman_z_score"]["value"], withdrawn["altman_x4"]["value"],
            withdrawn["credit_composite"]["value"]) == (1584.89, 1500.0, 88.5), failure
    assert withdrawn["altman_z_score"]["code"] == withdrawn["altman_x4"]["code"] == "credit_out_of_range"


@pytest.mark.parametrize("failure", sorted(FAILURES))
def test_with_the_boundary_bypassed_the_failure_path_serves_the_exploded_value(app, world, failure):
    """THE PLANT, kept in the suite: with `enforce_credit_boundary` replaced
    by the identity, the very request above serves the persisted 1584.89.
    That is what makes the gate above a measurement of the BOUNDARY and not
    of some earlier per-path check."""
    from engine.ratios import credit_boundary as CB

    mp = pytest.MonkeyPatch()
    try:
        _break(mp, failure)
        mp.setattr(CB, "enforce_credit_boundary", lambda payload, **_k: payload)
        body = RA.get(app, "/api/period/%s" % EXPLODED, D.mint_jwt(USER), ORG).json()
    finally:
        mp.undo()
    rows = {r["name"]: r["value"] for r in body["metrics"]}
    assert (rows["altman_z_score"], rows["altman_x4"], rows["credit_composite"]) == (1584.89, 1500.0, 88.5), (
        "the boundary was bypassed and the route still withheld: a second authority serves this path")
    with pytest.raises(AssertionError):
        _assert_period_refuses(failure, body)


def test_the_switched_path_serves_the_filed_figures_only_as_withheld_records(app, world):
    """No failure: the serve-time model runs. The persisted revision-1 rows
    move to `credit_metrics_as_filed` - where 1584.89 used to be served
    verbatim. The boundary withholds it there too, as a record."""
    body = RA.get(app, "/api/period/%s" % EXPLODED, D.mint_jwt(USER), ORG).json()
    assert body["assembled_metrics"]["credit"]["basis"] == "serve"
    _assert_no_exploded_figure("switched", body)
    filed = {r["name"]: r for r in body["credit_metrics_as_filed"]}
    assert filed["altman_z_score"]["value"] is None
    held = filed["altman_z_score"]["withheld"]
    assert (held["code"], held["value"]) == ("credit_out_of_range", 1584.89) and "altman_x4" in held["text"], held
    assert filed["altman_x4"]["withheld"]["value"] == 1500.0
    # in range and still not a score: liquidity 0.0 on a book with no current
    # liabilities was a substituted operand (the whole law, not only range)
    assert filed["credit_subscore_liquidity"]["value"] is None
    assert filed["credit_subscore_liquidity"]["withheld"]["code"] == "current_liabilities_not_positive"
    # the as-filed disclosure still names what was filed, by value
    disclosed = {w["figure"]: w["value"] for w in body["assembled_metrics"]["credit"]["as_filed"]["withdrawn"]}
    assert disclosed == {"altman_z_score": 1584.89, "credit_composite": 88.5}, disclosed
    assert body["credit_boundary"]["code"] == "credit_out_of_range"
    assert {w["figure"] for w in body["credit_boundary"]["withdrawn"]} >= {"altman_z_score", "altman_x4",
                                                                           "credit_composite"}


def test_a_healthy_period_leaves_the_boundary_untouched(app, world):
    """Non-vacuity of the withdrawal, and the blast radius: on a healthy
    book the boundary changes nothing (identity bypass -> the same body)."""
    from engine.ratios import credit_boundary as CB

    bearer = D.mint_jwt(USER)
    gated = RA.get(app, "/api/period/%s" % HEALTHY, bearer, ORG).json()
    assert "credit_boundary" not in gated
    env = gated["assembled_metrics"]["credit"]
    assert env["composite_score"] is not None and env["letter_grade"] and env["altman_z_score"] is not None
    mp = pytest.MonkeyPatch()
    try:
        mp.setattr(CB, "enforce_credit_boundary", lambda payload, **_k: payload)
        raw = RA.get(app, "/api/period/%s" % HEALTHY, bearer, ORG).json()
    finally:
        mp.undo()
    assert raw == gated


@pytest.mark.parametrize("failure", [None] + sorted(FAILURES))
def test_the_comparatives_prior_serves_no_exploded_figure(app, world, failure):
    """GET /api/period/{id}/comparatives with the exploded period as the
    PRIOR, healthy and with the model broken: no figure, no zone, no letter
    on the prior side of any composite, in the prior block or in
    `prior_metrics`."""
    mp = pytest.MonkeyPatch()
    try:
        if failure:
            _break(mp, failure)
        resp = RA.get(app, "/api/period/%s/comparatives?prior=%s" % (HEALTHY, EXPLODED), D.mint_jwt(USER), ORG)
    finally:
        mp.undo()
    if failure and FAILURES[failure][2] == "raise":
        # The comparatives composer rebuilds the table for both sides and
        # has NO fallback: a raising model fails the comparison (500, no
        # body). Measured here so a future fallback on this route is gated
        # the day it is written: it may answer 200 only without the figure.
        assert resp.status_code == 500 or "1584.89" not in resp.text, (failure, resp.status_code)
        assert "1584.89" not in resp.text, failure
        return
    assert resp.status_code == 200, (failure, resp.status_code, resp.text[:300])
    doc = resp.json()
    _assert_no_exploded_figure("comparatives/%s" % failure, doc)
    ratios = doc.get("ratios")
    if isinstance(ratios, dict):
        comps = {c["key"]: c for c in ratios["composites"]}
        for key in ("altman_z", "credit_composite", "letter_grade"):
            assert comps[key]["prior"]["value"] is None and comps[key]["prior"]["band"] is None, (failure, key)
        assert ratios["credit"]["prior"]["altman"]["zone"] is None and ratios["credit"]["prior"]["letter"] is None


# ── the independent law, on every surface of every path ─────────────────────


def _assert_the_law_holds_on_every_surface(where: str, body: Dict[str, Any], statements: Dict[str, Any]) -> int:
    """`served_range_law` (which imports nothing from the product) over
    everything `body` serves: every figure absent, or inside its domain and
    its bound on ITS period's statements; no zone without a Z'', no letter
    without a composite."""
    ops = {side: LAW.operands(st) for side, st in statements.items()}
    rows = {r.key: r for r in LAW.LAW}
    figures = LAW.served_figures(body)
    for surface, key, v in figures:
        o = ops[LAW.side_of(surface)]
        assert LAW.persisted_figure_may_be_served(rows[key], v, o), (
            "%s: %s serves %s = %r outside the law (domain %s, bound %s)"
            % (where, surface, key, v, rows[key].domain(o), rows[key].bound_text(o)))
    for surface, rests_on, minted in LAW.zones_and_letters(body):
        assert rests_on is not None or minted is None, (
            "%s: %s mints %r beside no figure" % (where, surface, minted))
    return len(figures)


@pytest.mark.parametrize("failure", [None] + sorted(FAILURES))
@pytest.mark.parametrize("period", [EXPLODED, HEALTHY])
def test_the_independent_law_holds_on_every_surface_of_every_path(app, world, failure, period):
    mp = pytest.MonkeyPatch()
    try:
        if failure:
            _break(mp, failure)
        body = RA.get(app, "/api/period/%s" % period, D.mint_jwt(USER), ORG).json()
    finally:
        mp.undo()
    measured = _assert_the_law_holds_on_every_surface(
        "%s/%s" % (period, failure), body, {"current": body["statements"]})
    assert measured >= 2 * len(LAW.LAW), measured  # the envelope and metrics[] at the least


@pytest.mark.parametrize("failure", [None, "serve_time_metric_rows returns None"])
def test_the_independent_law_holds_on_the_comparatives_prior(app, world, failure):
    bearer = D.mint_jwt(USER)
    statements = {"current": RA.get(app, "/api/period/%s" % HEALTHY, bearer, ORG).json()["statements"],
                  "prior": RA.get(app, "/api/period/%s" % EXPLODED, bearer, ORG).json()["statements"]}
    mp = pytest.MonkeyPatch()
    try:
        if failure:
            _break(mp, failure)
        resp = RA.get(app, "/api/period/%s/comparatives?prior=%s" % (HEALTHY, EXPLODED), bearer, ORG)
    finally:
        mp.undo()
    assert resp.status_code == 200, resp.text[:300]
    doc = resp.json()
    measured = _assert_the_law_holds_on_every_surface("comparatives/%s" % failure, doc, statements)
    assert measured >= len(LAW.LAW), measured
    assert any(s.startswith("prior_metrics") for s, _k, _v in LAW.served_figures(doc))


def test_the_narrator_payload_passes_the_boundary(monkeypatch):
    """POST /api/period/{id}/briefing/regenerate hands `stage_narrate` the
    persisted rows verbatim; `stage_narrate` builds the model payload
    through `credit_boundary.enforce_metric_rows`. With that bypassed the
    payload carries the filed Z'' 1584.89 (the in-suite plant)."""
    import sys
    import types

    import test_rebuild_net_income_anchor as ANCHOR
    from engine.api import pipeline as P
    from engine.ratios import credit_boundary as CB

    bk = ANCHOR._Book(SR.COMPACT)
    assembled = copy.deepcopy(bk.persist_assembled)
    filed = [dict(r) for r in SR._revision_1_rows(assembled["statements"])]

    def narrated() -> str:
        captured: Dict[str, Any] = {}

        class _Messages:
            def create(self, **kwargs):
                captured.update(kwargs)
                raise RuntimeError("stub: payload captured")

        class _Anthropic:
            def __init__(self, **_kw):
                self.messages = _Messages()

        monkeypatch.setenv("ANTHROPIC_API_KEY", "test-not-a-key")
        monkeypatch.setitem(sys.modules, "anthropic", types.SimpleNamespace(Anthropic=_Anthropic))
        P.stage_narrate(bk.doc, assembled, copy.deepcopy(filed), {"industry_key": "generic"},
                        period_id="p-test", parsed=bk.parsed)
        return captured["messages"][0]["content"]

    content = narrated()
    handed = {m["name"]: m["value"] for m in json.loads(content)["metrics"]}
    assert "1584.89" not in content and handed["altman_z_score"] is None and handed["credit_composite"] is None
    monkeypatch.setattr(CB, "enforce_metric_rows", lambda rows, _st, **_k: rows)
    assert "1584.89" in narrated(), "the narrator has a second authority: the boundary was bypassed and it still withheld"


# ── the function itself, shape by shape (whatever produced the payload) ──────


def _exploded_envelope() -> Dict[str, Any]:
    return {"altman_z_score": 1584.89, "altman_variant": "Z\"",
            "altman_components": {"x1": 0.2, "x2": 0.1, "x3": 0.05, "x4": 1500.0},
            "altman_zone": "safe", "composite_score": 88.5, "letter_grade": "AA",
            "subscores": {"altman": 100.0, "profitability": 60.0, "leverage": 90.0, "coverage": 80.0,
                          "dscr": 90.0, "liquidity": 70.0, "equity": 100.0},
            "refused_subscores": {}, "reason": None, "basis": "serve"}


def test_an_envelope_from_anywhere_is_read_against_the_law():
    """A cache, a future route, a hand-built fallback: the boundary finds a
    credit envelope by its shape under any key."""
    from engine.ratios import credit_boundary as CB

    out = CB.enforce_credit_boundary({"some_future_key": {"cached": _exploded_envelope()}}, surface="period")
    env = out["some_future_key"]["cached"]
    assert env["altman_z_score"] is None and env["altman_components"]["x4"] is None
    assert env["altman_zone"] is None and env["composite_score"] is None and env["letter_grade"] is None
    assert env["subscores"]["altman"] is None and env["subscores"]["leverage"] == 90.0
    assert env["refused_subscores"]["altman"]["code"] == "credit_out_of_range"
    assert env["reason"]["code"] == "credit_component_undefined"
    assert isinstance(env["ranges"], dict) and env["ranges"]["altman_x4"]["max"] == 100
    assert {w["figure"]: w["value"] for w in env["withdrawn"]} == {
        "altman_z_score": 1584.89, "altman_x4": 1500.0, "credit_subscore_altman": 100.0, "credit_composite": 88.5}
    assert out["credit_boundary"]["withdrawn"][0]["where"] == "some_future_key.cached"


@pytest.mark.parametrize("plant,expect_null", [
    ({"composite_score": 140.0}, ("composite_score", "letter_grade")),
    ({"composite_score": -5.0}, ("composite_score", "letter_grade")),
    ({"composite_score": float("nan")}, ("composite_score", "letter_grade")),
    ({"composite_score": float("inf")}, ("composite_score", "letter_grade")),
    ({"composite_score": "88.5"}, ("composite_score", "letter_grade")),
    ({"altman_z_score": float("inf")}, ("altman_z_score", "altman_zone", "composite_score", "letter_grade")),
])
def test_a_figure_outside_its_range_or_not_finite_takes_its_zone_and_letter_with_it(plant, expect_null):
    from engine.ratios import credit_boundary as CB

    env = dict(_exploded_envelope(), altman_z_score=3.1, composite_score=80.0)
    env["altman_components"] = dict(env["altman_components"], x4=1.2)
    env.update(plant)
    out = CB.enforce_credit_boundary({"assembled_metrics": {"credit": env}}, surface="period")
    got = out["assembled_metrics"]["credit"]
    for key in expect_null:
        assert got[key] is None, (plant, key, got[key])
    json.dumps(out, allow_nan=False)  # what leaves is serialisable
    assert "credit_out_of_range" in json.dumps(got)


def test_a_lawful_envelope_is_returned_untouched():
    from engine.ratios import credit_boundary as CB

    env = dict(_exploded_envelope(), altman_z_score=3.1, composite_score=80.0)
    env["altman_components"] = dict(env["altman_components"], x4=1.2)
    env["ranges"] = {"kept": True}
    before = copy.deepcopy(env)
    out = CB.enforce_credit_boundary({"assembled_metrics": {"credit": env}}, surface="period")
    assert out == {"assembled_metrics": {"credit": before}}


def test_a_comparatives_side_outside_its_range_refuses_and_mints_no_movement():
    from engine.ratios import credit_boundary as CB

    def side(v, q, band="healthy"):
        return {"value": v, "value_q": q, "band": band, "band_status": "graded", "ladder": None,
                "ladder_floor": None, "reason": None,
                "operands": [{"name": x, "value": val} for x, val in
                             (("x1", 0.2), ("x2", 0.1), ("x3", 0.05), ("x4", 1500.0 if v > 100 else 1.2))]}

    def row(key, unit, cur, pri):
        return {"key": key, "display_unit": unit, "higher_is_better": True, "current": cur, "prior": pri,
                "delta": {"value": "1"}, "movement": {"status": "crossed_down", "from": "healthy", "to": "watch"},
                "finding_id": "f-1"}

    score = lambda v, q: {"value": v, "value_q": q, "band": None, "band_status": "not_banded",  # noqa: E731
                          "ladder": None, "ladder_floor": None, "operands": [], "reason": None}
    letter = lambda v, q: dict(score(v, q), band=q, band_status="graded")  # noqa: E731
    doc = {"ratios": {"composites": [
        row("altman_z", "z", side(3.1, "3.10"), side(1584.89, "1584.89")),
        row("credit_composite", "score", score(80.0, "80.0"), score(88.5, "88.5")),
        row("letter_grade", "grade", letter(80.0, "AA"), letter(88.5, "AA")),
    ]}}
    out = CB.enforce_credit_boundary(doc, surface="comparatives")
    comps = {c["key"]: c for c in out["ratios"]["composites"]}
    for key in comps:
        pri = comps[key]["prior"]
        assert pri["value"] is None and pri["value_q"] is None and pri["band"] is None, (key, pri)
        assert pri["reason"]["code"] == "credit_out_of_range"
        assert comps[key]["movement"]["status"] == "not_comparable" and comps[key]["finding_id"] is None
        assert comps[key]["delta"]["value"] is None
        assert comps[key]["current"]["value"] is not None, key  # the lawful side is kept


def test_the_boundary_fails_closed(monkeypatch):
    """The check itself breaking is a model failure too: nothing unchecked
    is served."""
    from engine.ratios import credit_boundary as CB

    monkeypatch.setattr(CB.CM, "withhold_out_of_range", lambda *_a, **_k: (_ for _ in ()).throw(RuntimeError("x")))
    out = CB.enforce_credit_boundary(
        {"assembled_metrics": {"credit": _exploded_envelope()},
         "metrics": [{"name": "altman_z_score", "value": 1584.89}, {"name": "revenue", "value": 10.0}]},
        surface="period")
    env = out["assembled_metrics"]["credit"]
    assert env["altman_z_score"] is None and env["composite_score"] is None and env["letter_grade"] is None
    assert env["reason"]["code"] == "credit_inputs_absent"
    assert out["metrics"] == [{"name": "altman_z_score", "value": None}, {"name": "revenue", "value": 10.0}]


def test_the_narrator_rows_fail_closed(monkeypatch):
    """credit2 repair (low, plant M7b): `enforce_metric_rows`' own except
    branch. `lawful_persisted_rows` breaking must withhold the credit family
    from the narrator's rows, never hand them over raw.
    REDS ON after the repair: the branch planted open (`return [dict(r) for
    r in rows]`) -> the 1584.89 row reaches the narrator.
    CANNOT SEE: a consumer that reads persisted rows without calling
    `enforce_metric_rows` at all (the api-layer census below)."""
    from engine.ratios import credit_boundary as CB

    monkeypatch.setattr(CB.CM, "lawful_persisted_rows", _boom)
    rows = [{"name": "altman_z_score", "value": 1584.89}, {"name": "altman_x4", "value": 1500.0},
            {"name": "credit_composite", "value": 88.5}, {"name": "revenue", "value": 10.0}]
    out = CB.enforce_metric_rows(rows, {"balanceSheet": {}})
    by = {r["name"]: r["value"] for r in out}
    assert by == {"altman_z_score": None, "altman_x4": None, "credit_composite": None, "revenue": 10.0}
    assert rows[0]["value"] == 1584.89  # new rows: the caller's are not mutated


# ── the contract BY SHAPE (credit2 repair, low): one test per gap ────────────
#
# Each test below was RED before its repair (the probe served the figure
# unchanged) and is plant-proven in docs/engine_book/gates.md.


def _lawful_envelope() -> Dict[str, Any]:
    env = dict(_exploded_envelope(), altman_z_score=3.1, composite_score=80.0, letter_grade="A")
    env["altman_components"] = dict(env["altman_components"], x4=1.2)
    return env


def test_shape_a_an_envelope_without_altman_components_is_still_an_envelope():
    from engine.ratios import credit_boundary as CB

    env = {"composite_score": 250, "letter_grade": "AAA", "altman_z_score": 1584.89, "altman_zone": "safe"}
    out = CB.enforce_credit_boundary({"cache": env}, surface="period")["cache"]
    assert out["composite_score"] is None and out["letter_grade"] is None
    assert out["altman_z_score"] is None and out["altman_zone"] is None
    assert "credit_out_of_range" in json.dumps(out)


@pytest.mark.parametrize("how", ["null sub-score", "listed refusal"])
def test_shape_b_no_composite_and_no_letter_beside_a_component_that_did_not_score(how):
    """R-COMPOSITE held by the boundary itself: never renormalised,
    whatever composed the figure."""
    from engine.ratios import credit_boundary as CB

    env = _lawful_envelope()
    if how == "null sub-score":
        env["subscores"]["coverage"] = None
    else:
        env["refused_subscores"] = {"coverage": {"code": "interest_expense_not_positive", "component": "coverage",
                                                 "inputs": [], "text": "x"}}
    block = {"altman": {"z": 3.1, "zone": "safe", "x1": 0.2, "x2": 0.1, "x3": 0.05, "x4": 1.2},
             "subscores": dict(env["subscores"]), "composite": 80.7, "letter": "AA",
             "refused_subscores": dict(env["refused_subscores"])}
    rows = [{"name": "credit_composite", "value": 97.5}, {"name": "credit_subscore_coverage", "value": None},
            {"name": "credit_subscore_altman", "value": 100.0}]
    out = CB.enforce_credit_boundary({"assembled_metrics": {"credit": env, "ratio_table": {"credit": block}},
                                      "metrics": rows}, surface="period")
    got = out["assembled_metrics"]["credit"]
    assert got["composite_score"] is None and got["letter_grade"] is None, how
    assert got["reason"]["code"] == "credit_component_undefined"
    assert "coverage" in got["refused_subscores"]
    assert got["altman_z_score"] == 3.1 and got["altman_zone"] == "safe"  # what scored is kept
    blk = out["assembled_metrics"]["ratio_table"]["credit"]
    assert blk["composite"] is None and blk["letter"] is None and blk["altman"]["z"] == 3.1
    if how == "null sub-score":
        assert {r["name"]: r["value"] for r in out["metrics"]}["credit_composite"] is None
        assert out["metrics"][0]["withheld"]["code"] == "credit_component_undefined"
    codes = {w["figure"]: w["code"] for w in out["credit_boundary"]["withdrawn"]}
    assert codes["credit_composite"] == "credit_component_undefined"


def test_shape_c_every_row_of_a_name_is_read_not_the_last():
    from engine.ratios import credit_boundary as CB

    rows = [{"name": "altman_z_score", "value": 1584.89}, {"name": "altman_x4", "value": 1500.0},
            {"name": "altman_x2", "value": 0.1}, {"name": "altman_x3", "value": 0.05},
            {"name": "altman_z_score", "value": 3.1}, {"name": "altman_x4", "value": 1.2}]
    out = CB.enforce_credit_boundary({"metrics": rows}, surface="period")
    assert "1584.89" not in json.dumps([r["value"] for r in out["metrics"]])
    assert [r["value"] for r in out["metrics"] if r["name"] in ("altman_z_score", "altman_x4")] == [None] * 4


def _cmp_side(v, q, operands=()):
    return {"value": v, "value_q": q, "band": None, "band_status": "not_banded", "ladder": None,
            "ladder_floor": None, "reason": None, "operands": [{"name": n, "value": x} for n, x in operands]}


def _cmp_row(key, cur, pri):
    return {"key": key, "display_unit": "score", "higher_is_better": True, "current": cur, "prior": pri,
            "delta": {"value": "1"}, "movement": {"status": "crossed_down"}, "finding_id": "f-1"}


def test_shape_d_compare_rows_are_read_per_row_and_a_breach_reaches_the_sibling_list():
    from engine.ratios import credit_boundary as CB

    xs = (("x1", 0.2), ("x2", 0.1), ("x3", 0.05))
    doc = {"ratios": {
        "composites": [
            {"key": "ebitda_margin", "current": {"value": 0.1}, "prior": {"value": 0.2}},  # not a credit row
            _cmp_row("credit_composite", _cmp_side(80.0, "80.0"), _cmp_side(250.0, "250.0")),
            _cmp_row("altman_z", _cmp_side(3.1, "3.10", xs + (("x4", 1.2),)),
                     _cmp_side(1584.89, "1584.89", xs + (("x4", 1500.0),))),
        ],
        "subscores": [_cmp_row("credit_subscore_altman", _cmp_side(100.0, "100.0"), _cmp_side(100.0, "100.0")),
                      _cmp_row("credit_subscore_leverage", _cmp_side(90.0, "90.0"), _cmp_side(90.0, "90.0"))],
    }}
    out = CB.enforce_credit_boundary(doc, surface="comparatives")["ratios"]
    comps = {c["key"]: c for c in out["composites"]}
    subs = {c["key"]: c for c in out["subscores"]}
    assert comps["credit_composite"]["prior"]["value"] is None  # a mixed list is no longer skipped whole
    assert comps["altman_z"]["prior"]["value"] is None
    assert subs["credit_subscore_altman"]["prior"]["value"] is None  # the Altman breach reached the sibling list
    assert subs["credit_subscore_altman"]["prior"]["reason"]["inputs"] == ["altman_x4"]
    assert subs["credit_subscore_leverage"]["prior"]["value"] == 90.0  # a component that scored is kept
    assert all(c["current"]["value"] is not None for c in list(comps.values())[1:] + list(subs.values()))
    assert comps["ebitda_margin"] == {"key": "ebitda_margin", "current": {"value": 0.1}, "prior": {"value": 0.2}}


def test_shape_e_a_filed_z_is_read_against_the_bound_beside_it():
    from engine.ratios import credit_boundary as CB

    def block(z):
        return {"altman": {"z": 3.1, "zone": "safe", "x1": 0.2, "x2": 0.1, "x3": 0.05, "x4": 1.2},
                "subscores": {"altman": 100.0}, "composite": 80.0, "letter": "A",
                "as_filed": {"composite": 80.7, "altman_z": z, "letter": "A", "withdrawn": []}}

    out = CB.enforce_credit_boundary({"credit": block(1584.89)}, surface="period")["credit"]
    assert out["as_filed"]["altman_z"] is None
    assert out["as_filed"]["withdrawn"][0]["code"] == "credit_out_of_range"
    assert out["altman"]["z"] == 3.1 and out["composite"] == 80.0  # the served side is lawful and kept
    kept = CB.enforce_credit_boundary({"credit": block(2.9)}, surface="period")["credit"]
    assert kept["as_filed"]["altman_z"] == 2.9 and kept["as_filed"]["withdrawn"] == []


# ── the comparatives chokepoint, BEHAVIOURALLY (credit2 repair, low, M8) ─────


def test_the_comparatives_composer_itself_exploding_is_refused_at_the_boundary(app, world, monkeypatch):
    """get_period's boundary gates the two period bodies the composer READS;
    it cannot gate what the composer WRITES. Here the composer itself
    produces an exploded prior side (composite 250, Z'' 1584.89 on X4 1500)
    from lawful inputs, and only the comparatives boundary stands between it
    and the response.
    REDS ON after the repair: the route returning `compare_payloads(...)`
    raw (plant M8) -> the served prior carries 250 / 1584.89.
    CANNOT SEE: an exploded figure the composer writes under a shape the
    boundary does not recognise (the shape tests above)."""
    from engine.comparatives import ratio_compare as RC

    real = RC._composite_rows

    def exploding(cur_credit, pri_credit):
        composites, subscores = real(cur_credit, pri_credit)
        for row in composites:
            if row["key"] == "credit_composite":
                row["prior"] = dict(row["current"], value=250.0, value_q="250.0")
            if row["key"] == "altman_z":
                row["prior"] = dict(row["current"], value=1584.89, value_q="1584.89", operands=[
                    {"name": "x1", "value": 0.2}, {"name": "x2", "value": 0.1},
                    {"name": "x3", "value": 0.05}, {"name": "x4", "value": 1500.0}])
        return composites, subscores

    monkeypatch.setattr(RC, "_composite_rows", exploding)
    resp = RA.get(app, "/api/period/%s/comparatives?prior=%s" % (HEALTHY, EXPLODED), D.mint_jwt(USER), ORG)
    assert resp.status_code == 200, resp.text[:300]
    doc = resp.json()
    comps = {c["key"]: c for c in doc["ratios"]["composites"]}
    for key in ("altman_z", "credit_composite"):
        pri = comps[key]["prior"]
        assert pri["value"] is None and pri["value_q"] is None, (key, pri)
        assert pri["reason"]["code"] == "credit_out_of_range", (key, pri)
        assert comps[key]["movement"]["status"] == "not_comparable"
    assert comps["altman_z"]["current"]["value"] is not None  # the lawful side is kept
    assert {w["figure"] for w in doc["credit_boundary"]["withdrawn"]} >= {"altman_z.prior", "credit_composite.prior"}
    assert doc["credit_boundary"]["surface"] == "comparatives"


def test_an_unknown_surface_is_refused():
    from engine.ratios import credit_boundary as CB

    with pytest.raises(ValueError):
        CB.enforce_credit_boundary({}, surface="export")


# ── the census: no credit reader in the API layer outside the boundary ───────

#: Files under src/engine/api that name a credit-family figure, and why each
#: is not a serving surface of its own. A NEW file here is a new surface:
#: route its response through the boundary, add it to `SURFACES`, then list
#: it.
CREDIT_READERS = {
    "pipeline.py": "GET /api/period, /comparatives, /attention and stage_narrate: all four call the boundary (asserted below)",
    "_pricing_tiers.py": "plan feature copy: names the feature, serves no figure",
    "findings/c_bands.py": "band findings over ratio_table rows that already passed the boundary's block check",
}


def test_every_credit_reader_in_the_api_layer_is_behind_the_boundary():
    rx = re.compile(r"altman|credit_composite|letter_grade|credit_subscore")
    api = REPO / "src" / "engine" / "api"
    readers = sorted(str(p.relative_to(api)) for p in api.rglob("*.py") if rx.search(p.read_text(encoding="utf-8")))
    assert readers == sorted(CREDIT_READERS), (
        "credit-family readers in src/engine/api moved: %s" % sorted(set(readers) ^ set(CREDIT_READERS)))
    src = (api / "pipeline.py").read_text(encoding="utf-8")
    assert src.count('_credit_boundary.enforce_credit_boundary(_period_body, surface="period")') == 1
    assert 'surface="comparatives")' in src
    # /attention re-serves comparatives rows (the composite letter among
    # them) and leaves through its own surface
    assert '_credit_boundary.enforce_credit_boundary(doc, surface="attention")' in src
    assert "_credit_boundary.enforce_metric_rows(metrics, assembled[\"statements\"])" in src
    # and no credit-family value is read off the persisted rows in the route
    assert "withhold_persisted" not in src and "lawful_persisted_rows" not in src
    # Capsule tools serve no credit fact (owner's list: "Capsule tools that
    # return credit facts" - there are none; this reds the day one appears)
    assert not rx.search((api / "_capsule_tools.py").read_text(encoding="utf-8"))
