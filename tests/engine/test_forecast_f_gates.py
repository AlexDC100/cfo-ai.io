"""forecast-f1..f5 — the owner's Forecast and Scenarios gates, engine half
(forecast-scenarios-live). F6 (saved scenarios per company) is a frontend
gate: frontend/pages/cfo/__tests__/scenariosSaved.test.tsx.

Every request goes through the REAL ``create_app()`` over the tenancy double
(``_real_app_comparatives``: the production write path parse -> stage_map ->
stage_persist for each book, ES256 bearer verification, PostgREST doubled and
refusing any table or column no migration declares). Books: the four
committed corpus books (agras is files/agras_tb_2025.xlsx, the preliminary
close, not the filed year) and — opt-in, never committed — the owner's
Scandia FY2025 + FY2024 pair named by FORECAST_LOCAL_SCANDIA=<fy2025>,<fy2024>.

F1  year 0 of the forecast IS the latest actuals the dashboard shows: the
    engine's anchor (revenue, EBITDA, net income, cash, total assets,
    equity) equals GET /api/period/{id} to the cent — the dashboard's
    authority (assembled_pl.revenue, the methodology's reported EBITDA,
    net_income_statutory, assembled_bs.cash, canonical_bs totals) — and the
    first projected period's served cf.opening_cash IS that cash.
F2  every forecast year balances (served balance_check all zero, non-empty,
    bs_totals.assets == bs_totals.equity_plus_liabilities) and balance-sheet
    cash equals cash-flow closing cash, for every period and FY aggregate,
    on the forecast AND every scenario template; cash is continuous (each
    period opens on the previous period's close).
F3  the same inputs twice give byte-identical payloads (recompute_ms, the
    one clock, excluded) — in process with the loader cache cleared, and
    across processes under a DIFFERENT hash seed (set-order leaks).
F4  the base scenario is the forecast (block by block); a single-driver
    template or override moves ONLY lines in that driver's served
    consumed_by, every moved figure names the lever, and every line outside
    consumed_by is byte-equal to the base; reset (base again) is the forecast
    exactly, after a template ran (no state leaks through the cache).
F5  no placeholder where a value exists: every served figure is an integer
    amount or a refusal with a sentence, every strip slot is a figure or a
    refusal with a sentence; interest is never zero while the company
    carries debt (a measured debt rate charges every period with a debt
    balance; a book whose rate cannot be measured refuses, never 0%).

CANNOT SEE: what the page paints (vitest: forecastYearZero / scenariosEngine /
scenariosSaved); whether a forecast is a GOOD one.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import pytest
from fastapi.testclient import TestClient

import _real_app_comparatives as RA
import _served_books as SB
import firm_postgrest_double as D

REPO = Path(__file__).resolve().parents[2]
USER = "7b0c0f3e-0000-4000-8000-00000000f1a1"
ORG = "0c0f0000-0000-4000-8000-00000000f1a1"
CUR, PRI = "f-cur", "f-pri"
CORPUS = ("agras", "carniprod", "retail", "realestate")
H5 = {"total_years": 5, "monthly_months": 12}
WORK = {"units": 0, "books": [], "local": "not requested"}


def _local_scandia() -> Optional[Tuple[Path, Path]]:
    raw = os.environ.get("FORECAST_LOCAL_SCANDIA", "").strip()
    if not raw:
        return None
    parts = [Path(p.strip()).expanduser() for p in raw.split(",") if p.strip()]
    if len(parts) != 2 or not all(p.is_file() for p in parts):
        WORK["local"] = "requested but not readable: %s" % raw
        return None
    WORK["local"] = "scandia pair %s + %s" % (parts[0].name, parts[1].name)
    return parts[0], parts[1]


BOOKS = CORPUS + (("scandia_local",) if _local_scandia() else ())
_APP = {}  # type: Dict[str, Any]
_BOOKS = {}  # type: Dict[str, Any]


def _app():
    if "app" not in _APP:
        _APP["app"] = RA.build_app()
    return _APP["app"]


def _periods(name: str):
    """(book, period_id, org_id, start, end) rows for the double."""
    if name not in _BOOKS:
        if name == "scandia_local":
            fy25, fy24 = _local_scandia()
            _BOOKS[name] = (RA.book_from_workbook(fy25, period_end="2025-12-31", key="fg25"),
                            RA.book_from_workbook(fy24, period_end="2024-12-31", key="fg24"))
        else:
            _BOOKS[name] = (SB.book(name), None)
    cur, pri = _BOOKS[name]
    rows = [(cur, CUR, ORG, "2025-01-01", "2025-12-31")]
    if pri is not None:
        rows.append((pri, PRI, ORG, "2024-01-01", "2024-12-31"))
    return rows


class _World(object):
    """One book's workspace over the tenancy double, the real app, a bearer."""

    def __init__(self, name: str, caen: Optional[str] = None) -> None:
        self.name = name
        org = {"id": ORG, "name": name, "default_currency": "RON"}
        if caen:
            org["caen_code"] = caen
        self.double = RA.seed_double(
            orgs=[org],
            memberships=[{"user_id": USER, "org_id": ORG, "role": "owner",
                          "created_at": "2026-01-01T00:00:00+00:00"}],
            periods=_periods(name))

    def __enter__(self) -> "_World":
        from engine.api import _forecast_history
        _forecast_history.clear_cache()
        self._cm = RA.installed(self.double)
        self._cm.__enter__()
        self.jwt = D.mint_jwt(USER)
        self.client = TestClient(_app(), raise_server_exceptions=False)
        self.headers = {"Authorization": "Bearer " + self.jwt, "X-Org-Id": ORG}
        return self

    def __exit__(self, *exc: Any) -> bool:
        from engine.api import _forecast_history
        _forecast_history.clear_cache()
        self._cm.__exit__(*exc)
        return False

    def get(self, path: str) -> Dict[str, Any]:
        r = self.client.get(path, headers=self.headers)
        assert r.status_code == 200, (self.name, path, r.status_code, r.text[:400])
        return r.json()

    def post(self, path: str, body: Dict[str, Any]) -> Tuple[int, Dict[str, Any]]:
        r = self.client.post(path, headers=self.headers, json=body)
        return r.status_code, r.json()

    def forecast(self, horizon: int = 5) -> Dict[str, Any]:
        return self.get("/api/forecast/%s?horizon=%d" % (CUR, horizon))

    def scenario(self, template: str, overrides: Optional[Dict[str, Any]] = None,
                 horizon: Optional[Dict[str, int]] = None) -> Tuple[int, Dict[str, Any]]:
        body = {"template": template, "horizon": dict(horizon or H5)}
        if overrides:
            body["overrides"] = overrides
        return self.post("/api/forecast/%s/scenario" % CUR, body)


def _cents(value: Any) -> Optional[int]:
    if value is None:
        return None
    return int((Decimal(str(value)) * 100).quantize(Decimal(1), rounding=ROUND_HALF_UP))


def _index(body: Dict[str, Any]) -> Dict[Tuple[str, str], Dict[str, Any]]:
    return dict(((f["line"], f["period"]), f) for f in body.get("figures") or [])


def _labels(body: Dict[str, Any]) -> List[str]:
    horizon = body["horizon"]
    return list(horizon["labels"]) + list(horizon.get("labels_annual") or [])


def _served_periods(body: Dict[str, Any]) -> set:
    """The timeline periods this body serves figures for: every one, or on a
    partial refusal (6.5) those before the refusal's own period."""
    return set(f["period"] for f in body.get("figures") or []
               if f["line"] == "bs.cash" and "amount_minor" in f)


def _templates() -> List[str]:
    from engine.forecast.scenario_templates import load_templates
    return [t.id for t in load_templates().templates]


# ── F1 ───────────────────────────────────────────────────────────────────

#: year 0, as the DASHBOARD reads it off GET /api/period/{id}
#: (frontend/lib/canonicalMetrics.ts buildCanonicalMetrics for the P&L and
#: cash, frontend/lib/servedFacts.ts factsFrom for the canonical totals).
def _dashboard_year_zero(period_body: Dict[str, Any]) -> Dict[str, Optional[int]]:
    st = period_body["statements"]
    pl = st.get("assembled_pl") or {}
    bs = st.get("assembled_bs") or {}
    totals = (st.get("canonical_bs") or {}).get("totals") or {}
    method = (((st.get("assembled_canonical_v1") or {}).get("methodology") or {})
              .get("ebitda") or {})
    reported = method.get("reported")
    if reported is None:
        reported = pl.get("ebitda_statutory", pl.get("ebitda"))
    return {"revenue": _cents(pl.get("revenue")), "ebitda": _cents(reported),
            "net_income": _cents(pl.get("net_income_statutory")),
            "cash": _cents(bs.get("cash")),
            "total_assets": _cents(totals.get("assets")),
            "equity": _cents(totals.get("equity"))}


def _engine_year_zero(world: _World) -> Dict[str, Optional[int]]:
    from engine.api import _forecast_history
    from engine.forecast.levers import PlanRequest, project_levers
    payload, prior, context, _h = _forecast_history.load_plan_inputs(world.jwt, ORG, CUR)
    plan, _s = project_levers(payload, prior, PlanRequest(total_years=5), context)
    opening, history = plan.inputs["opening"], plan.inputs["history"]
    return {"revenue": history.revenue, "ebitda": history.ebitda,
            "net_income": history.net_income, "cash": opening.cents("cash"),
            "total_assets": opening.total_assets_cents(),
            "equity": sum(opening.cents(line) for line in (
                "equity_contributed", "equity_reserves", "equity_retained",
                "equity_other"))}


@pytest.mark.parametrize("name", BOOKS)
def test_f1_year_zero_is_the_actuals_the_dashboard_serves(name):
    with _World(name) as world:
        dashboard = _dashboard_year_zero(world.get("/api/period/%s" % CUR))
        engine = _engine_year_zero(world)
        body = world.forecast()
    assert all(v is not None for v in dashboard.values()), (name, dashboard)
    differ = dict((k, (dashboard[k], engine[k])) for k in dashboard if dashboard[k] != engine[k])
    assert not differ, ("%s: year 0 of the forecast is not the served actuals "
                        "(dashboard, engine): %s" % (name, differ))
    first = body["horizon"]["labels"][0]
    opening_cash = _index(body)[("cf.opening_cash", first)]["amount_minor"]
    assert opening_cash == dashboard["cash"], (
        "%s: the first projected period opens on %s, the dashboard shows cash %s"
        % (name, opening_cash, dashboard["cash"]))
    print("F1 %s year0 %s" % (name, json.dumps(dashboard, sort_keys=True)))
    WORK["units"] += len(dashboard) + 1
    WORK["books"].append(name)


# ── F2 ───────────────────────────────────────────────────────────────────

def _f2_check(label: str, body: Dict[str, Any]) -> int:
    checked = 0
    rows = body.get("balance_check") or []
    assert rows, "%s: balance_check is empty (vacuous)" % label
    nonzero = [r for r in rows if r["difference_minor"] != 0]
    assert not nonzero, "%s: periods that do not balance: %s" % (label, nonzero)
    assert body["unbalanced_periods"] == [], (label, body["unbalanced_periods"])
    index = _index(body)
    previous_close = None
    served = _served_periods(body)
    for period in body["horizon"]["labels"]:
        if period not in served:
            # 6.5, a partial refusal: nothing past the refusal's own period
            # is served, and the body says so (refusal.from_period).
            assert body.get("refusal"), "%s: %s is not served and nothing says why" % (label, period)
            continue
        bs_cash = index[("bs.cash", period)].get("amount_minor")
        cf_close = index[("cf.closing_cash", period)].get("amount_minor")
        assets = index[("bs_totals.assets", period)].get("amount_minor")
        el = index[("bs_totals.equity_plus_liabilities", period)].get("amount_minor")
        if bs_cash is None:  # a partial refusal: served through its own cut only
            assert "refused" in index[("bs.cash", period)], (label, period)
            continue
        assert bs_cash == cf_close, (
            "%s %s: balance-sheet cash %s, cash-flow closing cash %s"
            % (label, period, bs_cash, cf_close))
        assert assets == el, "%s %s: assets %s, equity + liabilities %s" % (
            label, period, assets, el)
        opening = index[("cf.opening_cash", period)].get("amount_minor")
        if previous_close is not None:
            assert opening == previous_close, (
                "%s %s opens on %s, the previous period closed on %s"
                % (label, period, opening, previous_close))
        previous_close = cf_close
        checked += 4
    for period in body["horizon"].get("labels_annual") or []:
        if ("bs.cash", period) not in index:
            assert body.get("refusal"), (label, period)
            continue
        bs_cash = index[("bs.cash", period)].get("amount_minor")
        if bs_cash is None:
            continue
        assert bs_cash == index[("cf.closing_cash", period)].get("amount_minor"), (label, period)
        assert index[("bs_totals.assets", period)].get("amount_minor") == index[
            ("bs_totals.equity_plus_liabilities", period)].get("amount_minor"), (label, period)
        checked += 2
    return checked


@pytest.mark.parametrize("name", BOOKS)
def test_f2_every_year_balances_and_cash_ties(name):
    with _World(name) as world:
        checked = _f2_check("%s/forecast h3" % name, world.forecast(3))
        checked += _f2_check("%s/forecast h5" % name, world.forecast(5))
        for template in _templates():
            status, body = world.scenario(template)
            if status != 200:
                assert status == 422 and body["detail"]["code"] in (
                    "days_not_measured", "rate_not_measured", "cost_split_refused",
                    "template_key_not_served"), (name, template, status, body)
                continue
            checked += _f2_check("%s/%s" % (name, template), body)
    WORK["units"] += checked


# ── F3 ───────────────────────────────────────────────────────────────────

def _bytes(body: Dict[str, Any]) -> bytes:
    body = dict(body)
    body.pop("recompute_ms", None)
    return json.dumps(body, sort_keys=True, ensure_ascii=False).encode("utf-8")


_F3_CHILD = r'''
import json, os, sys
sys.path.insert(0, os.environ["F3_REPO"] + "/src")
sys.path.insert(0, os.environ["F3_REPO"] + "/tests/engine")
import test_forecast_f_gates as G
with G._World(os.environ["F3_BOOK"]) as w:
    if os.environ["F3_KIND"] == "get":
        body = w.forecast()
    else:
        status, body = w.scenario(os.environ["F3_KIND"])
body.pop("recompute_ms", None)
sys.stdout.write(json.dumps(body, sort_keys=True, ensure_ascii=False))
'''


@pytest.mark.parametrize("name", CORPUS[:2])
def test_f3_the_same_inputs_give_the_same_bytes(name):
    with _World(name) as world:
        first = _bytes(world.forecast())
    with _World(name) as world:  # a fresh loader cache, a fresh double
        second = _bytes(world.forecast())
        scen_a = _bytes(world.scenario("recession")[1])
        scen_b = _bytes(world.scenario("recession")[1])
    assert first == second, "%s: GET differs between two identical runs" % name
    assert scen_a == scen_b, "%s: the scenario differs between two identical runs" % name
    env = dict(os.environ, F3_REPO=str(REPO), F3_BOOK=name, PYTHONHASHSEED="12345",
               CFO_AI_SKIP_BOOT_VERIFY="1", ENGINE_ACCESS_LOG="0",
               PYTHONPATH=os.pathsep.join([str(REPO / "src"), str(REPO / "tests" / "engine")]))
    for kind, expected in (("get", first), ("recession", scen_a)):
        run = subprocess.run([sys.executable, "-c", _F3_CHILD], env=dict(env, F3_KIND=kind),
                             capture_output=True, cwd=str(REPO), timeout=600)
        assert run.returncode == 0, run.stderr.decode("utf-8", "replace")[-2000:]
        other = json.loads(run.stdout.decode("utf-8"))
        assert _bytes(other) == expected, (
            "%s/%s: another process (PYTHONHASHSEED=12345) served different bytes"
            % (name, kind))
    WORK["units"] += 4


# ── F4 ───────────────────────────────────────────────────────────────────

#: (label, how to ask, the ONE driver it moves, the lever id it serves)
SINGLE_DRIVER = (
    ("revenue_down_10", {"template": "revenue_down_10"}, "volume_index",
     "template:revenue_down_10:1"),
    ("price_pressure", {"template": "price_pressure"}, "price_index",
     "template:price_pressure:1"),
    ("input_cost_inflation", {"template": "input_cost_inflation"}, "input_price_index",
     "template:input_cost_inflation:1"),
    ("dso override", {"template": "base",
                      "overrides": {"dso_days": {"values": ["60", None, None, None, None]}}},
     "dso_days", "override:dso_days"),
    ("payout override", {"template": "base",
                         "overrides": {"dividend_payout_pct": {"values": ["0.5"] * 5}}},
     "dividend_payout_pct", "override:dividend_payout_pct"),
)

#: Lines no revenue, price or working-capital lever may ever move: held
#: balances and the held income (R3). Named, so the gate cannot pass by an
#: empty consumed_by.
NEVER_MOVED_BY_REVENUE = ("pl.other_operating_income", "bs.other_current_assets",
                          "bs.investment_property", "bs.other_non_current_assets",
                          "bs.other_current_liabilities", "bs.other_non_current_liabilities",
                          "bs.equity_contributed", "bs.equity_reserves", "bs.equity_other",
                          "bs.st_debt", "bs.lt_debt", "pl.interest_expense_debt")


@pytest.mark.parametrize("name", CORPUS)
def test_f4_one_driver_moves_only_the_lines_it_drives(name):
    with _World(name) as world:
        base = world.forecast()
        status, scen_base = world.scenario("base")
        assert status == 200
        strip = ("scenario", "body_hash", "recompute_ms")
        assert (dict((k, v) for k, v in base.items() if k not in strip)
                == dict((k, v) for k, v in scen_base.items() if k not in strip)), (
            "%s: the base scenario is not the forecast" % name)
        base_ix = _index(base)
        moved_any = 0
        for label, ask, driver, lever_id in SINGLE_DRIVER:
            status, body = world.post("/api/forecast/%s/scenario" % CUR,
                                      dict(ask, horizon=dict(H5)))
            if status != 200:
                assert body["detail"]["code"] in ("days_not_measured", "rate_not_measured",
                                                  "cost_split_refused"), (name, label, body)
                continue
            declared = set(base["drivers"][driver]["consumed_by"])
            ix = _index(body)
            moved = []
            for key, figure in ix.items():
                before = base_ix[key].get("amount_minor")
                after = figure.get("amount_minor")
                if before == after:
                    continue
                moved.append(key)
                assert key[0] in declared, (
                    "%s/%s moved %s %s (%s -> %s), a line %s does not drive"
                    % (name, label, key[0], key[1], before, after, driver))
                if figure.get("kind") == "projected":
                    assert lever_id in (figure.get("lever_ids") or []), (
                        "%s/%s: %s %s moved and does not name %s"
                        % (name, label, key[0], key[1], lever_id))
            if driver != "dividend_payout_pct":
                for line in NEVER_MOVED_BY_REVENUE:
                    assert all(k[0] != line for k in moved), (name, label, line)
            if not moved:
                # A lever this plan cannot feel (no cost of sales for an
                # input-price move, no profit to distribute): the engine must
                # SAY so on the lever, never leave a dead control unexplained.
                assert base["drivers"][driver]["inert_in_this_plan"], (
                    "%s/%s moved nothing and the engine does not serve %s as inert "
                    "in this plan" % (name, label, driver))
                print("F4 %s/%s moves nothing on this book" % (name, label))
                continue
            moved_any += 1
            WORK["units"] += len(ix)
        # RESET: after every lever above ran, the forecast is the forecast.
        again = world.forecast()
        assert _bytes(again) == _bytes(base), "%s: reset did not return the base exactly" % name
        assert moved_any >= 3, (name, moved_any)


# ── F5 ───────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("name", BOOKS)
def test_f5_no_placeholder_where_a_value_exists_and_debt_is_charged(name):
    with _World(name) as world:
        bodies = [("forecast", world.forecast())]
        for template in ("recession", "working_capital_squeeze"):
            status, body = world.scenario(template)
            if status == 200:
                bodies.append((template, body))
    for label, body in bodies:
        for figure in body["figures"]:
            if "refused" in figure:
                assert (figure["refused"] or {}).get("text"), (name, label, figure)
                continue
            assert isinstance(figure.get("amount_minor"), int), (name, label, figure)
        for slot, value in (body.get("strip") or {}).items():
            if isinstance(value, dict) and "refused" in value:
                assert value["refused"].get("text"), (name, label, slot)
            else:
                assert isinstance(value, dict) and isinstance(
                    (value.get("amount") or value).get("amount_minor"), int), (name, label, slot, value)
        index = _index(body)
        rate = body["drivers"]["interest_rate_debt"]
        served = _served_periods(body)
        for period in body["horizon"]["labels"]:
            if period not in served:
                continue
            debt = sum(index[(line, period)].get("amount_minor") or 0
                       for line in ("bs.st_debt", "bs.lt_debt"))
            if debt <= 0:
                continue
            assert rate["basis"]["tier"] != "absent" or rate["values"][0] is None, (name, label)
            charged = index[("pl.interest_expense_debt", period)].get("amount_minor")
            assert charged not in (None, 0), (
                "%s/%s %s: debt of %s charged %r interest" % (name, label, period, debt, charged))
            WORK["units"] += 1
        WORK["units"] += len(body["figures"])


def test_zz_scope_and_work(capsys):
    with capsys.disabled():
        print("\nSCOPE forecast-f1..f5 (forecast-scenarios-live): books %s (corpus: agras is the "
              "preliminary close, not the filed year); local: %s; routes: GET /api/period, GET "
              "/api/forecast, POST /api/forecast/{id}/scenario, all through create_app over the "
              "tenancy double; templates: %s"
              % (", ".join(BOOKS), WORK["local"], ", ".join(_templates())))
        print("F1 books: %s" % ", ".join(WORK["books"]))
        print("GATE-WORK forecast-f-gates units=%d" % WORK["units"])
    assert WORK["books"], "TC-3: F1 judged no book"
