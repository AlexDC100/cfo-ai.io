"""forecast-cockpit — the owner's Forecast COCKPIT, engine half
(forecast-scenarios-live, owner-approved spec "Forecast as an interactive
cockpit"; pack packs/forecast/cockpit.yaml, module engine.forecast.cockpit,
routes POST /api/forecast/{period_id}/cockpit and .../cockpit/export).

Every request goes through the REAL ``create_app()`` over the tenancy double
(``_real_app_comparatives``: the production write path parse -> stage_map ->
stage_persist for each book, ES256 bearer verification, PostgREST doubled and
refusing any table or column no migration declares — org_prefs included).
Books: the four committed corpus books (agras is files/agras_tb_2025.xlsx, the
preliminary close, NOT the filed year) and — opt-in, never committed — the
owner's Scandia FY2025 + FY2024 pair named by
FORECAST_LOCAL_SCANDIA=<fy2025>,<fy2024>.

THE PAGE DOES NO MATH: a slider sends a lever id and a decimal string; the
engine compiles it onto its own drivers and runs project_levers. These gates
hold what the engine serves the page:

F1  year 0 of the cockpit (base_period) IS the dashboard's actuals to the
    cent (revenue, EBITDA, net income, cash, total assets, equity).
F2  every plan year of every case AND of every slider at its min and at its
    max balances (assets == equity + liabilities) and its balance-sheet cash
    is its cash-flow closing cash; cash never below the floor.
F3  the same request twice gives the same bytes (cache cleared between),
    and a second process under another hash seed agrees.
F4  the base case IS the forecast: every statement line of every plan year
    equals the forecast GET's served FY figure, and the base compiles to no
    engine request at all; one lever moves only lines its engine drivers
    drive (the forecast's own served consumed_by); reset gives the base back
    byte for byte.
F5  no placeholder where a value exists: every projected figure is an
    integer amount (or a refusal with a sentence); interest is charged in
    every plan year that carries debt; a drawn credit line charges interest
    and the four numbers show it.
F6  a saved case is read from THE RESOLVED COMPANY's own prefs row: it
    survives a new client (reload), it is not found from another company,
    and an entry naming another company is refused, never computed.
F7  the growth default is the company's own history when a comparable prior
    is loaded (tier book, both turnovers named), the sector median for a
    one-year company with a CAEN (tier sector, stamped), the BNR anchor with
    its sentence otherwise — never a silent flat 0%; editable (a set value
    is what projects).
F8  below the floor the engine draws a credit line WITH interest, never
    negative cash; the four numbers name the need, its month and its
    interest; the chart marks the gap.
F9  the bridge from base (revenue -> EBITDA -> working capital -> capex ->
    interest and tax -> dividends -> debt -> cash) sums EXACTLY to the change
    in closing cash for every case, every probed lever set and every
    scenario template — Recession included, whose cash never goes negative.
LATENCY: a slider move answers through the real route inside the pack's
    budget (packs/forecast/levers.yaml#latency.chart_inprocess_p50_ms) at p95.

CANNOT SEE: what the page paints (the frontend gates), network latency to
Supabase in production, whether a forecast is a GOOD one.
"""
from __future__ import annotations

import copy
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import pytest
from fastapi.testclient import TestClient

import _real_app_comparatives as RA
import _served_books as SB
import firm_postgrest_double as D

REPO = Path(__file__).resolve().parents[2]
USER = "7b0c0f3e-0000-4000-8000-00000000c0c1"
ORG = "0c0f0000-0000-4000-8000-00000000c0c1"
ORG_B = "0c0f0000-0000-4000-8000-00000000c0c2"
CUR, PRI, CUR_B = "c-cur", "c-pri", "c-cur-b"
CORPUS = ("agras", "carniprod", "retail", "realestate")
WORK = {"units": 0, "books": [], "local": "not requested", "latency": {}}


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


def _columns() -> Dict[str, List[str]]:
    cols = RA.migration_columns()
    text = (REPO / "supabase" / "schema_phase_prefs.sql").read_text(encoding="utf-8")
    cols.update(dict((t, c) for t, c in D.parse_table_columns(text).items() if t == "org_prefs"))
    assert "org_prefs" in cols, "schema_phase_prefs.sql no longer declares org_prefs"
    return cols


def _scaled(bk: Any, factor: float) -> Any:
    """The same book with every line item scaled: a linear scaling keeps the
    trial balance balanced, so the prior rebuilds through the real assembly."""
    out = copy.deepcopy(bk)
    for row in out.line_items:
        row["amount"] = round(float(row["amount"]) * factor, 2)
    return out


def _book_pair(name: str) -> Tuple[Any, Optional[Any]]:
    if name not in _BOOKS:
        if name == "scandia_local":
            fy25, fy24 = _local_scandia()
            _BOOKS[name] = (RA.book_from_workbook(fy25, period_end="2025-12-31", key="ck25"),
                            RA.book_from_workbook(fy24, period_end="2024-12-31", key="ck24"))
        elif name == "agras_history":
            _BOOKS[name] = (SB.book("agras"), _scaled(SB.book("agras"), 0.8))
        elif name == "agras_doubled":
            _BOOKS[name] = (SB.book("agras"), _scaled(SB.book("agras"), 0.5))
        else:
            _BOOKS[name] = (SB.book(name), None)
    return _BOOKS[name]


class _World(object):
    """One book's workspace (and optionally a second company holding the same
    book) over the tenancy double, the real app, one bearer."""

    def __init__(self, name: str, caen: Optional[str] = None,
                 prefs: Optional[Dict[str, Dict[str, Any]]] = None,
                 second_org: bool = False) -> None:
        self.name = name
        cur, pri = _book_pair(name)
        orgs = [dict({"id": ORG, "name": name, "default_currency": "RON"},
                     **({"caen_code": caen} if caen else {}))]
        members = [{"user_id": USER, "org_id": ORG, "role": "owner",
                    "created_at": "2026-01-01T00:00:00+00:00"}]
        periods = [(cur, CUR, ORG, "2025-01-01", "2025-12-31")]
        if pri is not None:
            periods.append((pri, PRI, ORG, "2024-01-01", "2024-12-31"))
        if second_org:
            orgs.append({"id": ORG_B, "name": name + " (b)", "default_currency": "RON"})
            members.append({"user_id": USER, "org_id": ORG_B, "role": "owner",
                            "created_at": "2026-01-02T00:00:00+00:00"})
            periods.append((cur, CUR_B, ORG_B, "2025-01-01", "2025-12-31"))
        double = D.PostgrestDouble(columns=_columns())
        for org in orgs:
            double.add("organizations", dict(org))
        for m in members:
            double.add("memberships", dict(m))
        fp_cols = set(double.columns["financial_periods"])
        li_cols = set(double.columns["statement_line_items"])
        for bk, pid, org_id, start, end in periods:
            row = dict((k, v) for k, v in bk.period.items() if k in fp_cols)
            row.update(id=pid, org_id=org_id, period_start=start, period_end=end)
            double.add("financial_periods", row)
            for li in bk.line_items:
                double.add("statement_line_items",
                           dict((k, v) for k, v in dict(li, period_id=pid).items() if k in li_cols))
        for org_id, bag in (prefs or {}).items():
            double.add("org_prefs", {"org_id": org_id, "prefs": bag,
                                     "updated_at": "2026-09-21T00:00:00+00:00"})
        self.double = double

    def __enter__(self) -> "_World":
        from engine.api import _forecast_history
        _forecast_history.clear_cache()
        self._cm = RA.installed(self.double)
        self._cm.__enter__()
        self.jwt = D.mint_jwt(USER)
        self.client = TestClient(_app(), raise_server_exceptions=False)
        return self

    def __exit__(self, *exc: Any) -> bool:
        from engine.api import _forecast_history
        _forecast_history.clear_cache()
        self._cm.__exit__(*exc)
        return False

    def headers(self, org: str = ORG) -> Dict[str, str]:
        return {"Authorization": "Bearer " + self.jwt, "X-Org-Id": org}

    def get(self, path: str, org: str = ORG) -> Dict[str, Any]:
        r = self.client.get(path, headers=self.headers(org))
        assert r.status_code == 200, (self.name, path, r.status_code, r.text[:400])
        return r.json()

    def cockpit(self, body: Optional[Dict[str, Any]] = None, period: str = CUR,
                org: str = ORG, route: str = "cockpit") -> Tuple[int, Dict[str, Any]]:
        r = self.client.post("/api/forecast/%s/%s" % (period, route),
                             headers=self.headers(org), json=body or {})
        return r.status_code, r.json()

    def ok(self, body: Optional[Dict[str, Any]] = None, **kw: Any) -> Dict[str, Any]:
        status, out = self.cockpit(body, **kw)
        assert status == 200, (self.name, body, status, json.dumps(out)[:600])
        return out


def _bytes(body: Dict[str, Any]) -> bytes:
    body = dict(body)
    body.pop("recompute_ms", None)
    return json.dumps(body, sort_keys=True, ensure_ascii=False).encode("utf-8")


def _rows(body: Dict[str, Any]) -> Dict[Tuple[str, str], int]:
    out = {}  # type: Dict[Tuple[str, str], int]
    for section in ("pl", "bs", "cf"):
        for row in body["statements"][section]:
            for value in row["values"]:
                out[(row["line"], value["period"])] = value["amount_minor"]
    return out


def _pack():
    from engine.forecast.cockpit import cockpit_pack
    return cockpit_pack()


def _extremes() -> List[Tuple[str, Dict[str, Any]]]:
    """Every lever at its min and at its max, one at a time, plus the adverse
    corner (every lever that hurts, at once)."""
    out = []
    for spec in _pack().levers:
        for end, value in (("min", spec.low), ("max", spec.high)):
            text = _dec(value)
            levers = {spec.id: text}
            if spec.id == "eur_ron":
                levers["imported_share"] = "1"
            out.append(("%s=%s" % (spec.id, end), {"levers": levers}))
    out.append(("adverse corner", {"case_id": "pesimist", "levers": {
        "revenue_growth": "-0.30", "raw_material_price": "0.50", "wage_growth": "0.20",
        "energy_price": "1.00", "eur_ron": "0.30", "imported_share": "1",
        "dso_days": "365", "dio_days": "365", "dpo_days": "0", "capex": "0.30",
        "interest_rate": "0.25", "dividend_payout": "1"}}))
    return out


def _dec(value: Any) -> str:
    from engine.forecast.cockpit import _exact_decimal
    return _exact_decimal(value)


#: The codes a lever set may be refused with on a book whose readings cannot
#: carry it — each a sentence the engine serves by name, never a 500.
REFUSED_BY_NAME = ("cost_split_refused", "days_not_measured", "rate_not_measured",
                   "lever_not_measured", "out_of_bounds", "funding_line_unpriceable")


# ── F1 ───────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("name", BOOKS)
def test_c_f1_year_zero_is_the_actuals_the_dashboard_serves(name):
    import test_forecast_f_gates as G
    with _World(name) as world:
        dashboard = G._dashboard_year_zero(world.get("/api/period/%s" % CUR))
        body = world.ok()
    figures = body["base_period"]["figures"]
    served = dict((k, figures[k].get("amount_minor")) for k in dashboard)
    assert all(v is not None for v in dashboard.values()), (name, dashboard)
    differ = dict((k, (dashboard[k], served[k])) for k in dashboard if dashboard[k] != served[k])
    assert not differ, "%s: cockpit year 0 is not the served actuals (dashboard, cockpit): %s" % (
        name, differ)
    assert all(figures[k]["kind"] == "actual" for k in dashboard), figures
    first = [p for p in body["chart"]["cash"] if p["kind"] == "projected"][0]
    year0 = body["chart"]["cash"][0]
    assert year0["kind"] == "actual" and year0["cash_minor"] == dashboard["cash"]
    # the first projected month opens on that cash (the statements' opening)
    opening = [r for r in body["statements"]["cf"] if r["line"] == "cf.opening_cash"][0]
    assert opening["values"][0]["amount_minor"] == dashboard["cash"], (name, opening)
    assert body["chart"]["ebitda"][0]["amount_minor"] == dashboard["ebitda"]
    print("C-F1 %s year0 %s" % (name, json.dumps(dashboard, sort_keys=True)))
    WORK["units"] += len(dashboard) + 3
    WORK["books"].append(name)


# ── F2 ───────────────────────────────────────────────────────────────────

def _f2(label: str, body: Dict[str, Any]) -> int:
    rows = _rows(body)
    checked = 0
    for year in body["horizon"]["years"]:
        assets = rows[("bs_totals.assets", year)]
        el = rows[("bs_totals.equity_plus_liabilities", year)]
        assert assets == el, "%s %s: assets %d, equity + liabilities %d" % (label, year, assets, el)
        bs_cash, cf_cash = rows[("bs.cash", year)], rows[("cf.closing_cash", year)]
        assert bs_cash == cf_cash, "%s %s: bs cash %d, cf closing cash %d" % (
            label, year, bs_cash, cf_cash)
        assert bs_cash >= body["funding_line"]["floor_minor"], (label, year, bs_cash)
        checked += 3
    previous = None
    for point in body["chart"]["cash"]:
        assert point["cash_minor"] >= 0, (label, point)
        if point["kind"] == "projected":
            assert point["cash_before_funding_minor"] == point["cash_minor"] - point["funding_line_minor"]
        checked += 1
    years = body["horizon"]["years"]
    for i in range(1, len(years)):
        opening = rows[("cf.opening_cash", years[i])]
        closing = rows[("cf.closing_cash", years[i - 1])]
        assert opening == closing, "%s: %s opens on %d, %s closed on %d" % (
            label, years[i], opening, years[i - 1], closing)
        checked += 1
    return checked


@pytest.mark.parametrize("name", BOOKS)
def test_c_f2_every_year_balances_in_every_case_and_at_every_slider_extreme(name):
    refused = []
    with _World(name) as world:
        checked = 0
        for case in ("base", "optimist", "pesimist"):
            checked += _f2("%s/%s" % (name, case), world.ok({"case_id": case}))
        for label, body in _extremes():
            status, out = world.cockpit(body)
            if status != 200:
                code = (out.get("detail") or {}).get("code")
                assert status == 422 and code in REFUSED_BY_NAME, (name, label, status, out)
                assert (out["detail"].get("text") or "").strip(), (name, label, out)
                refused.append("%s (%s)" % (label, code))
                continue
            checked += _f2("%s/%s" % (name, label), out)
    print("C-F2 %s: %d checks; refused by name: %s" % (name, checked, refused or "none"))
    assert checked > 0
    WORK["units"] += checked


# ── F3 ───────────────────────────────────────────────────────────────────

_F3_CHILD = r'''
import json, os, sys
sys.path.insert(0, os.environ["F3_REPO"] + "/src")
sys.path.insert(0, os.environ["F3_REPO"] + "/tests/engine")
import test_forecast_cockpit as C
with C._World(os.environ["F3_BOOK"]) as w:
    body = w.ok(json.loads(os.environ["F3_BODY"]))
body.pop("recompute_ms", None)
sys.stdout.write(json.dumps(body, sort_keys=True, ensure_ascii=False))
'''


@pytest.mark.parametrize("name", CORPUS[:2])
def test_c_f3_the_same_inputs_give_the_same_bytes(name):
    request = {"case_id": "pesimist", "levers": {"dso_days": "60", "energy_price": "0.2"}}
    with _World(name) as world:
        first = world.ok(request)
    with _World(name) as world:
        second = world.ok(request)
    assert _bytes(first) == _bytes(second), "%s: two identical requests differ" % name
    env = dict(os.environ, F3_REPO=str(REPO), F3_BOOK=name, F3_BODY=json.dumps(request),
               PYTHONHASHSEED="12345", CFO_AI_SKIP_BOOT_VERIFY="1", ENGINE_ACCESS_LOG="0",
               PYTHONPATH=os.pathsep.join([str(REPO / "src"), str(REPO / "tests" / "engine")]))
    out = subprocess.run([sys.executable, "-c", _F3_CHILD], env=env, capture_output=True,
                         timeout=600)
    assert out.returncode == 0, out.stderr.decode("utf-8", "replace")[-2000:]
    other = json.loads(out.stdout.decode("utf-8"))
    assert json.dumps(other, sort_keys=True, ensure_ascii=False).encode("utf-8") == _bytes(first), (
        "%s: another process under another hash seed serves other bytes" % name)
    assert first["pins"]["body_hash"] == other["pins"]["body_hash"]
    WORK["units"] += 3


# ── F4 ───────────────────────────────────────────────────────────────────

#: one lever at a time, a value that moves it off its default on any book
SINGLE_LEVERS = (
    ("revenue_growth", "0.08"), ("inflation", "0.06"), ("raw_material_price", "0.10"),
    ("wage_growth", "0.09"), ("energy_price", "0.30"), ("dso_days", "70"),
    ("dio_days", "20"), ("dpo_days", "20"), ("capex", "0.06"), ("interest_rate", "0.09"),
    ("dividend_payout", "0.5"),
)


def _consumed(forecast: Dict[str, Any], drivers: List[str]) -> set:
    lines = set()
    for driver in drivers:
        served = forecast["drivers"].get(driver)
        assert served is not None, "the forecast serves no driver %s" % driver
        lines.update(served["consumed_by"])
    return lines


@pytest.mark.parametrize("name", CORPUS)
def test_c_f4_the_base_case_is_the_forecast_and_one_lever_moves_only_its_lines(name):
    pack = _pack()
    with _World(name) as world:
        forecast = world.get("/api/forecast/%s?horizon=%d" % (CUR, pack.total_years))
        base = world.ok()
        if base["funding_line"]["priced_at"] == "reference":
            # the base plan draws a credit line this book cannot price: the
            # forecast refuses from that period, the cockpit prices it at
            # the stated reference rate and moves nothing else
            assert forecast.get("refusal"), (name, "priced at the reference, yet the forecast serves")
            assert list(base["engine_request"]["overrides"]) == ["revolver_rate"], base["engine_request"]
            assert base["engine_request"]["shocks"] == []
            print("C-F4 %s: the base draws an unpriceable line; priced at the reference" % name)
            return
        assert base["engine_request"] == {"overrides": {}, "shocks": []}, base["engine_request"]
        served = dict(((f["line"], f["period"]), f.get("amount_minor"))
                      for f in forecast["figures"])
        rows = _rows(base)
        compared = 0
        for (line, period), amount in rows.items():
            if line.startswith("bs_totals.current"):
                continue
            want = served.get((line, period))
            assert want is not None, "%s: the forecast serves no %s %s" % (name, line, period)
            assert amount == want, "%s: base case %s %s = %d, the forecast serves %d" % (
                name, line, period, amount, want)
            compared += 1
        moved_any = 0
        for lever_id, value in SINGLE_LEVERS:
            spec = pack.by_id[lever_id]
            status, body = world.cockpit({"levers": {lever_id: value}})
            if status != 200:
                assert body["detail"]["code"] in REFUSED_BY_NAME, (name, lever_id, body)
                continue
            allowed = _consumed(forecast, list(spec.drivers))
            moved = sorted(set(line for (line, period), amount in _rows(body).items()
                               if rows[(line, period)] != amount))
            outside = [l for l in moved if l not in allowed and not l.startswith("bs_totals.")]
            assert not outside, "%s: %s moved %s, lines its drivers %s do not drive" % (
                name, lever_id, outside, spec.drivers)
            if moved:
                moved_any += 1
            else:
                lever = [l for l in body["levers"] if l["id"] == lever_id][0]
                inert = lever.get("inert") or lever.get("locked")
                # a lever this plan cannot feel must SAY so, or be a driver
                # the forecast itself serves as inert in this plan
                assert inert or all(forecast["drivers"][d]["inert_in_this_plan"]
                                    for d in spec.drivers), (
                    "%s: %s moved nothing and nothing says why" % (name, lever_id))
            WORK["units"] += len(moved) + 1
        again = world.ok()
    assert _bytes(again) == _bytes(base), "%s: reset did not give the base back exactly" % name
    assert moved_any >= 6, (name, moved_any)
    WORK["units"] += compared


def _line(body: Dict[str, Any], line: str) -> List[int]:
    rows = _rows(body)
    return [rows[(line, y)] for y in body["horizon"]["years"]]


@pytest.mark.parametrize("name", ("agras", "carniprod"))
def test_c_f4_each_lever_moves_its_lines_by_what_its_basis_states(name):
    """A lever does what its basis says, in size, not only in which lines it
    touches: growth compounds the year-0 revenue; inflation moves the FIXED
    part of operating cost; a wage growth moves the personnel pool to
    (1 + w)^n of its year-0 amount; a raw-material move reaches cost of
    sales by its measured share; energy moves its own pool; a payout pays
    that share of a year's profit. Tolerances are the engine's own rounding:
    a pool level is held in millionths, a year in twelve monthly slices."""
    from fractions import Fraction
    from engine.forecast.money import apply_rate
    from engine.forecast.project import _round
    with _World(name) as world:
        base = world.ok()
        levers = dict((l["id"], l) for l in base["levers"])
        rev0 = base["base_period"]["figures"]["revenue"]["amount_minor"]
        i0 = Fraction(levers["inflation"]["value"])
        pools = dict((p["pool"], p) for p in base["cost_behaviour"])
        fixed = sum(Fraction(p["base_minor"] * p["fixed_share_ppm"], 1000000)
                    for p in base["cost_behaviour"] if p["pool"] != "cost_of_sales")

        def near(got: int, want: Fraction, scale: int, n: int, label: str) -> None:
            slack = Fraction(abs(scale) * 5 * n, 1000000) + 1200
            assert abs(got - want) <= slack, "%s: moved %d, its basis says %s (slack %s)" % (
                label, got, float(want), float(slack))

        g = Fraction("0.07")
        grown = world.ok({"levers": {"revenue_growth": "0.07"}})
        for n, amount in enumerate(_line(grown, "pl.revenue"), start=1):
            assert amount == _round(rev0 * (1 + g) ** n), (name, "growth", n, amount)
        i1 = Fraction("0.06")
        hot = world.ok({"levers": {"inflation": "0.06"}})
        for n, (a, b) in enumerate(zip(_line(hot, "pl.operating_costs"),
                                       _line(base, "pl.operating_costs")), start=1):
            near(b - a, fixed * ((1 + i1) ** n - (1 + i0) ** n), int(fixed), n,
                 "%s inflation year %d" % (name, n))
        personnel = levers["wage_growth"]["source"]["facts"]["personnel_minor"]
        if personnel:
            w = Fraction("0.09")
            paid = world.ok({"levers": {"wage_growth": "0.09"}})
            for n, (a, b) in enumerate(zip(_line(paid, "pl.operating_costs"),
                                           _line(base, "pl.operating_costs")), start=1):
                near(b - a, personnel * ((1 + w) ** n - (1 + i0) ** n), personnel, n,
                     "%s wages year %d" % (name, n))
        facts = levers["raw_material_price"]["source"]["facts"]
        if facts["raw_material_minor"]:
            share = Fraction(facts["raw_material_minor"], facts["cost_of_sales_minor"])
            dear = world.ok({"levers": {"raw_material_price": "0.10"}})
            for n, (a, b) in enumerate(zip(_line(dear, "pl.cost_of_sales"),
                                           _line(base, "pl.cost_of_sales")), start=1):
                near(b - a, -b * share * Fraction("0.10"), b, n, "%s raw materials year %d" % (name, n))
        energy = pools.get("energy_utilities")
        if energy and energy["base_minor"] > 0 and energy["fixed_share_ppm"] == 0:
            hot = world.ok({"levers": {"energy_price": "0.30"}})
            for n, (a, b, r) in enumerate(zip(_line(hot, "pl.operating_costs"),
                                              _line(base, "pl.operating_costs"),
                                              _line(base, "pl.revenue")), start=1):
                pool_now = Fraction(energy["base_minor"] * r, rev0)
                near(b - a, pool_now * Fraction("0.30"), energy["base_minor"], n,
                     "%s energy year %d" % (name, n))
        paying = world.ok({"levers": {"dividend_payout": "0.5"}})
        for net, paid in zip(_line(paying, "pl.net_income"), _line(paying, "cf.dividends_paid")):
            if net > 0:
                assert -paid == apply_rate(net, 500000) or -paid < apply_rate(net, 500000), (
                    name, net, paid)
    WORK["units"] += 30


# ── F5 ───────────────────────────────────────────────────────────────────

def _walk_figures(node: Any, path: str = "$"):
    if isinstance(node, dict):
        if node.get("kind") == "projected":
            yield path, node
        for key, child in node.items():
            for item in _walk_figures(child, "%s.%s" % (path, key)):
                yield item
    elif isinstance(node, list):
        for i, child in enumerate(node):
            for item in _walk_figures(child, "%s[%d]" % (path, i)):
                yield item


@pytest.mark.parametrize("name", BOOKS)
def test_c_f5_no_placeholder_interest_on_debt_and_on_a_drawn_line(name):
    checked = 0
    with _World(name) as world:
        bodies = [(case, world.ok({"case_id": case})) for case in ("base", "optimist", "pesimist")]
        status, squeeze = world.cockpit({"levers": {"dso_days": "300", "revenue_growth": "-0.25"}})
        if status == 200:
            bodies.append(("squeeze", squeeze))
    for label, body in bodies:
        for path, figure in _walk_figures(body):
            has = [k for k in figure if k.endswith("_minor") or k == "value_micros"]
            assert has or figure.get("refused"), "%s/%s %s: a projected figure with no value" % (
                name, label, path)
            for key in has:
                if key == "value_micros" and figure.get("status") == "not_applicable":
                    continue
                assert isinstance(figure[key], int), "%s/%s %s.%s = %r" % (
                    name, label, path, key, figure[key])
            checked += 1
        rows = _rows(body)
        years = body["horizon"]["years"]
        for i, year in enumerate(years):
            debt = rows[("bs.st_debt", year)] + rows[("bs.lt_debt", year)]
            if debt > 0:
                assert rows[("pl.interest_expense_debt", year)] < 0, (
                    "%s/%s %s: debt %d charged no interest" % (name, label, year, debt))
            revolver_open = rows[("bs.revolver", years[i - 1])] if i else 0
            if revolver_open > 0:
                assert rows[("pl.interest_expense_funding_line", year)] < 0, (
                    "%s/%s %s: a credit line of %d open all year charged no interest"
                    % (name, label, year, revolver_open))
            checked += 2
        # the four numbers ARE readings of the statements they sit above
        numbers = body["numbers"]
        final = years[-1]
        assert numbers["ebitda_final_year"]["figure"]["amount_minor"] == rows[("pl.ebitda", final)]
        fcf = sum(rows[("cf.cash_from_operating", y)] + rows[("cf.cash_from_investing", y)]
                  for y in years)
        assert numbers["cumulative_fcf"]["figure"]["amount_minor"] == fcf, (name, label)
        y1 = years[0]
        numerator = rows[("pl.ebitda", y1)]
        denominator = (-(rows[("pl.interest_expense_debt", y1)]
                         + rows[("pl.interest_expense_funding_line", y1)])
                       + rows[("bs.st_debt", y1)] + rows[("bs.revolver", y1)])
        dscr = numbers["dscr_year_one"]
        assert dscr["numerator"]["amount_minor"] == numerator, (name, label, dscr)
        assert dscr["denominator"]["amount_minor"] == denominator, (
            "%s/%s: DSCR divides by %d; interest + short-term debt + the credit line is %d"
            % (name, label, dscr["denominator"]["amount_minor"], denominator))
        if denominator > 0:
            from fractions import Fraction
            from engine.forecast.cockpit import _ppm
            assert dscr["value_micros"] == _ppm(Fraction(numerator, denominator))
        checked += 3
        cash = body["numbers"]["cash"]
        if cash["kind"] == "funding_need":
            assert cash["funding_interest"]["amount_minor"] > 0, (name, label, cash)
            assert cash["display"]["ro"]["interest"] and cash["display"]["en"]["interest"]
        dscr = body["numbers"]["dscr_year_one"]
        assert dscr["status"] in ("above", "below", "not_applicable")
        if dscr["status"] != "not_applicable":
            assert dscr["display"]["ro"]["value"] and dscr["display"]["en"]["value"]
        for lang in ("ro", "en"):
            assert body["sentence"][lang].strip(), (name, label, lang)
        for lever in body["levers"]:
            assert lever["basis"]["ro"].strip() and lever["basis"]["en"].strip(), (
                "%s: lever %s shows no basis" % (name, lever["id"]))
            checked += 1
    WORK["units"] += checked


# ── F6 ───────────────────────────────────────────────────────────────────

def _bag(org_id: str, entries: List[Dict[str, Any]]) -> Dict[str, Any]:
    return {_pack().saved["prefs_key"]: entries}


def test_c_f6_a_saved_case_belongs_to_its_company_and_survives_reload():
    levers = {"inflation": "0.05", "dso_days": "55"}
    prefs = {
        ORG: _bag(ORG, [
            {"id": "c1", "name": "Banca Transilvania", "orgId": ORG, "levers": levers,
             "savedAt": "2026-09-21T10:00:00Z"},
            # written into A's bag while naming B: never computed on A
            {"id": "c3", "name": "stray", "orgId": ORG_B, "levers": levers,
             "savedAt": "2026-09-21T10:00:00Z"},
        ]),
        ORG_B: _bag(ORG_B, [
            {"id": "c2", "name": "only on B", "orgId": ORG_B, "levers": levers,
             "savedAt": "2026-09-21T10:00:00Z"}]),
    }
    with _World("agras", prefs=prefs, second_org=True) as world:
        saved = world.ok({"case_id": "saved:c1"})
        assert saved["case"]["id"] == "saved:c1" and saved["case"]["name"] == "Banca Transilvania"
        assert "„Banca Transilvania”" in saved["sentence"]["ro"], saved["sentence"]["ro"]
        # the saved case IS its lever set, computed by the engine today
        direct = world.ok({"levers": levers})
        assert _rows(saved) == _rows(direct)
        assert saved["numbers"] == direct["numbers"]
        status, other = world.cockpit({"case_id": "saved:c2"})
        assert status == 404 and other["detail"]["code"] == "case_not_found", other
        status, stray = world.cockpit({"case_id": "saved:c3"})
        assert status == 422 and stray["detail"]["code"] == "case_of_another_company", stray
        status, from_b = world.cockpit({"case_id": "saved:c1"}, period=CUR_B, org=ORG_B)
        assert status == 404 and from_b["detail"]["code"] == "case_not_found", from_b
        on_b = world.ok({"case_id": "saved:c2"}, period=CUR_B, org=ORG_B)
        assert on_b["case"]["name"] == "only on B"
        status, cross = world.cockpit({"case_id": "base"}, period=CUR, org=ORG_B)
        assert status == 404, "a period of company A answered under company B: %s" % status
        # reload: a fresh client over the same stored prefs gives the same bytes
        world.client = TestClient(_app(), raise_server_exceptions=False)
        again = world.ok({"case_id": "saved:c1"})
    assert _bytes(again) == _bytes(saved), "a saved case did not survive a reload byte for byte"
    WORK["units"] += 8


# ── F7 ───────────────────────────────────────────────────────────────────

def _lever(body: Dict[str, Any], lever_id: str) -> Dict[str, Any]:
    return [l for l in body["levers"] if l["id"] == lever_id][0]


def test_c_f7_growth_default_is_the_books_own_history_then_the_sector_never_a_silent_zero():
    from fractions import Fraction
    # a comparable prior year (the same book, four fifths the size)
    with _World("agras_history") as world:
        body = world.ok()
    growth = _lever(body, "revenue_growth")
    assert growth["source"]["tier"] == "book", growth["source"]
    assert Fraction(growth["value"]) == Fraction(growth["default"]) != 0
    assert growth["measured"] is True
    assert "2024→2025" in growth["basis"]["ro"] and "istoric" in growth["basis"]["ro"], growth["basis"]
    assert "history" in growth["basis"]["en"]
    # a history outside the pack's slider range (the book doubled in a year):
    # the served range holds it, and sending it back is the base itself
    with _World("agras_doubled") as world:
        body = world.ok()
        growth = _lever(body, "revenue_growth")
        assert Fraction(growth["default"]) > Fraction(_pack().by_id["revenue_growth"].high)
        assert Fraction(growth["range"]["max"]) == Fraction(growth["default"])
        back = world.ok({"levers": {"revenue_growth": growth["default"]}})
        assert back["engine_request"] == {"overrides": {}, "shocks": []}
        assert _rows(back) == _rows(body)
    # one year, a CAEN: the sector median, stamped with its sector and count
    with _World("agras", caen="1011") as world:
        body = world.ok()
        edited = world.ok({"levers": {"revenue_growth": "0.07"}})
    growth = _lever(body, "revenue_growth")
    assert growth["source"]["tier"] == "sector", growth["source"]
    sector = growth["source"]["sector"]
    assert Fraction(growth["value"]) == Fraction(sector["p50"], 1000000) != 0
    assert "CAEN 1011" in growth["basis"]["ro"] and str(sector["n"]) in growth["basis"]["ro"]
    # editable: the set value is what projects
    assert _lever(edited, "revenue_growth")["value"] == "0.07"
    assert _lever(edited, "revenue_growth")["origin"] == "user"
    y0 = body["base_period"]["figures"]["revenue"]["amount_minor"]
    first = [r for r in edited["statements"]["pl"] if r["line"] == "pl.revenue"][0]["values"][0]
    from engine.forecast.project import _round
    assert first["amount_minor"] == _round(Fraction(y0) * Fraction(107, 100)), (first, y0)
    # one year, no CAEN: the BNR anchor with its sentence, never a silent 0
    with _World("agras") as world:
        body = world.ok()
    growth = _lever(body, "revenue_growth")
    assert growth["source"]["tier"] == "macro", growth["source"]
    assert Fraction(growth["value"]) != 0
    assert "BNR" in growth["basis"]["ro"] and "CAEN" in growth["basis"]["ro"], growth["basis"]
    for lever in body["levers"]:
        if lever["value"] in ("0", None) and not lever["measured"]:
            # a nil default is stated in its own basis, never silent
            assert lever["basis"]["ro"].strip() and lever["basis"]["en"].strip(), lever
    WORK["units"] += 12


# ── F8 ───────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("name", CORPUS)
def test_c_f8_below_the_floor_the_engine_draws_a_priced_credit_line(name):
    squeeze = {"levers": {"dso_days": "300", "revenue_growth": "-0.25", "dividend_payout": "1"}}
    with _World(name) as world:
        status, body = world.cockpit(squeeze)
    if status != 200:
        assert body["detail"]["code"] in REFUSED_BY_NAME, (name, body)
        print("C-F8 %s refused by name: %s" % (name, body["detail"]["code"]))
        return
    cash = body["numbers"]["cash"]
    assert cash["kind"] == "funding_need", (name, cash)
    peak = max(p["funding_line_minor"] for p in body["chart"]["cash"])
    assert cash["figure"]["amount_minor"] == peak > 0
    assert all(p["cash_minor"] >= 0 for p in body["chart"]["cash"]), name
    assert body["chart"]["funding_gap"] is True
    assert any(p["gap"] for p in body["chart"]["cash"])
    first = [p for p in body["chart"]["cash"] if p["funding_line_minor"] > 0][0]
    assert cash["first_period"] == first["period"], (cash["first_period"], first["period"])
    for lang in ("ro", "en"):
        assert cash["display"][lang]["amount"] in body["sentence"][lang], body["sentence"][lang]
        assert cash["display"][lang]["when"] in body["sentence"][lang]
    rows = _rows(body)
    interest = sum(-rows[("pl.interest_expense_funding_line", y)] for y in body["horizon"]["years"])
    assert interest == cash["funding_interest"]["amount_minor"] > 0
    assert body["engine_request"]["overrides"].get("min_cash") is None
    print("C-F8 %s: need %s from %s, interest %s" % (
        name, cash["display"]["en"]["amount"], cash["first_period"],
        cash["display"]["en"]["interest"]))
    WORK["units"] += 6


# ── F9 ───────────────────────────────────────────────────────────────────

def _f9(label: str, bridge: Dict[str, Any]) -> None:
    steps = dict((s["id"], s["figure"]["amount_minor"]) for s in bridge["steps"])
    assert bridge["sums_exactly"] is True
    assert steps["revenue"] + steps["costs"] == steps["ebitda"], (label, steps)
    parts = sum(v for k, v in steps.items() if k not in ("ebitda", "cash"))
    assert parts == steps["cash"], "%s: the bridge sums to %d, cash moved %d" % (
        label, parts, steps["cash"])
    moved = (bridge["closing_cash_case"]["amount_minor"]
             - bridge["closing_cash_base"]["amount_minor"])
    assert moved == steps["cash"], (label, moved, steps["cash"])


@pytest.mark.parametrize("name", BOOKS)
def test_c_f9_every_bridge_from_base_sums_exactly_and_recession_cash_is_never_negative(name):
    from engine.api import _forecast_history
    from engine.forecast.cockpit import bridge as make_bridge
    from engine.forecast.levers import PlanRequest, project_levers
    from engine.forecast.scenario_templates import load_templates
    with _World(name) as world:
        base = world.ok()
        for window in ("year_one", "horizon"):
            _f9("%s/base/%s" % (name, window), base["bridge"][window])
            assert all(s["figure"]["amount_minor"] == 0 for s in base["bridge"][window]["steps"])
        for label, body in [("optimist", {"case_id": "optimist"}),
                            ("pesimist", {"case_id": "pesimist"}),
                            ("mix", {"levers": {"revenue_growth": "-0.05", "dso_days": "90",
                                                "capex": "0.08", "dividend_payout": "0.4",
                                                "interest_rate": "0.12"}})]:
            status, out = world.cockpit(body)
            if status != 200:
                assert status == 422 and isinstance(out.get("detail"), dict) and \
                    out["detail"]["code"] in REFUSED_BY_NAME, (name, label, status, out)
                continue
            for window in ("year_one", "horizon"):
                _f9("%s/%s/%s" % (name, label, window), out["bridge"][window])
            WORK["units"] += 2
        # every scenario template of the Scenarios page, through the same
        # bridge (the old client-side Recession printed cash of -107.6M)
        payload, prior, context, _h = _forecast_history.load_plan_inputs(world.jwt, ORG, CUR)
        for template in [t.id for t in load_templates().templates]:
            try:
                plan, _s = project_levers(payload, prior, PlanRequest(total_years=5), context,
                                          template_id=template)
            except Exception as exc:  # a template the book refuses by name
                assert getattr(exc, "code", None) in REFUSED_BY_NAME + ("template_key_not_served",), (
                    name, template, exc)
                continue
            if plan.projection.shortfall is not None:
                continue
            lowest = min(p.bs["cash"] for p in plan.projection.periods)
            assert lowest >= 0, "%s/%s: cash reaches %d" % (name, template, lowest)
            b = make_bridge(plan.base, plan.projection, "horizon")
            _f9("%s/template %s" % (name, template), b)
            if template == "recession":
                steps = dict((s["id"], s["figure"]["amount_minor"]) for s in b["steps"])
                print("C-F9 %s recession vs base, horizon: %s; lowest cash %d" % (
                    name, json.dumps(steps, sort_keys=True), lowest))
            WORK["units"] += 1


def test_c_f9_a_bridge_that_does_not_close_is_never_served():
    """The bridge's own guard: a step that stops summing to the cash move
    raises rather than serving a bridge that does not close."""
    from engine.forecast import cockpit as C

    class _P(object):
        def __init__(self, pl, cf, bs, year=1):
            import types
            self.pl, self.cf, self.bs = pl, cf, bs
            self.period = types.SimpleNamespace(year_offset=year, label="2026-01")

    pl = dict((k, 0) for k in ("revenue", "cost_of_sales", "operating_costs",
                               "other_operating_income", "ebitda", "interest_expense_debt",
                               "interest_expense_funding_line", "interest_income",
                               "other_financial_income", "other_financial_expense",
                               "income_tax"))
    cf = dict((k, 0) for k in ("change_in_receivables", "change_in_inventory",
                               "change_in_payables", "cash_from_investing", "dividends_paid",
                               "debt_drawdowns", "debt_repayments", "funding_line_movement",
                               "cash_from_operating", "opening_cash"))
    base = type("B", (), {"periods": (_P(dict(pl), dict(cf), {"cash": 100}),)})
    case = type("B", (), {"periods": (_P(dict(pl), dict(cf), {"cash": 105}),)})
    with pytest.raises(C.BridgeError):
        C.bridge(base, case, "horizon")
    WORK["units"] += 1


# ── the routes ───────────────────────────────────────────────────────────

def test_c_routes_bind_bodies_refuse_by_name_and_serve_the_export():
    from engine.api import _forecast_routes as FR
    assert FR.CockpitRequestBody.__module__ == FR.__name__
    assert FR.CockpitRequestBody.__qualname__ == "CockpitRequestBody"
    paths = [(r.path, sorted(getattr(r, "methods", ()) or ())) for r in _app().routes]
    assert ("/api/forecast/{period_id}/cockpit", ["POST"]) in paths
    assert ("/api/forecast/{period_id}/cockpit/export", ["POST"]) in paths
    with _World("agras") as world:
        r = world.client.post("/api/forecast/%s/cockpit" % CUR, json={})
        assert r.status_code == 401
        for body, code in (({"levers": {"nope": "1"}}, "unknown_lever"),
                           ({"levers": {"inflation": 0.05}}, "invalid_request"),
                           ({"levers": {"inflation": "5%"}}, "not_decimal"),
                           ({"levers": {"inflation": "0.99"}}, "lever_out_of_range"),
                           ({"levers": {"raw_material_price": ["0.1", "0.1"]}}, "lever_scalar"),
                           ({"levers": {"inflation": ["0.03", "0.03"]}}, "lever_length"),
                           ({"case_id": "doomsday"}, "unknown_case"),
                           ({"surprise": 1}, "invalid_request")):
            status, out = world.cockpit(body)
            assert status == 422, (body, status, out)
            assert out["detail"]["code"] == code, (body, out)
            assert "query" not in json.dumps(out["detail"]), out
        status, out = world.cockpit({}, period="no-such-period")
        assert status == 404
        status, out = world.cockpit({}, org="0c0f0000-0000-4000-8000-0000000000ff")
        assert status == 403, (status, out)
        export = world.ok({"case_id": "pesimist"}, route="cockpit/export")
    doc, page = export["document"], export["assumptions_page"]
    assert doc["kind"] == "bank_forecast" and export["cockpit"]["case"]["id"] == "pesimist"
    assert doc["sentence"] == export["cockpit"]["sentence"]
    assert [l["id"] for l in page["levers"]] == [s.id for s in _pack().levers]
    assert all(l["basis"]["ro"] and l["basis"]["en"] for l in page["levers"])
    assert page["case"]["basis"]["ro"] and "BNR" in page["case"]["basis"]["ro"]
    assert page["dscr"]["threshold"] and page["cost_behaviour"] and page["conventions"]
    ids = set(s["series_id"] for s in page["sources"])
    assert "ro.bnr.raport_inflatie.2026_08" in ids and "ro.ins.ippi.industria_prelucratoare.anual" in ids
    for source in page["sources"]:
        if source.get("kind") != "sector dataset":
            assert source.get("published") and source.get("source"), source
    WORK["units"] += 14


# ── latency ──────────────────────────────────────────────────────────────

@pytest.mark.parametrize("name", CORPUS[:1] + (("scandia_local",) if _local_scandia() else ()))
def test_c_latency_a_slider_move_answers_inside_the_budget(name):
    from engine.forecast.levers_pack import serving_pack
    budget = int(serving_pack().latency["chart_inprocess_p50_ms"])
    from fractions import Fraction
    moves = [{"levers": {"revenue_growth": _dec(Fraction(step - 10, 200)),
                         "raw_material_price": _dec(Fraction(step, 100))}}
             for step in range(20)]
    with _World(name) as world:
        world.ok()  # the first open loads the book; a slider move is what is timed
        times = []
        for body in moves:
            started = time.perf_counter()
            world.ok(body)
            times.append((time.perf_counter() - started) * 1000)
    times.sort()
    p50 = times[len(times) // 2]
    p95 = times[int(len(times) * 0.95) - 1]
    WORK["latency"][name] = (round(p50, 1), round(p95, 1))
    print("C-LATENCY %s: p50 %.1f ms, p95 %.1f ms over %d slider moves (budget %d ms)" % (
        name, p50, p95, len(times), budget))
    assert p95 < budget, (name, p95, budget)
    WORK["units"] += len(times)


#: The committed engine bytes the frontend's cockpit gates read
#: (scripts/gen_cockpit_fixtures.py): name, route, body.
FIXTURE_REQUESTS = (
    ("base", "cockpit", {}),
    ("pesimist", "cockpit", {"case_id": "pesimist"}),
    ("funding", "cockpit", {"levers": {"dso_days": "300", "revenue_growth": "-0.25",
                                       "dividend_payout": "1"}}),
    ("export", "cockpit/export", {"case_id": "pesimist"}),
)


def test_c_the_committed_cockpit_fixtures_are_what_the_route_serves():
    """The frontend's cockpit gates read these bytes; a stale copy would
    let the page be tested against a cockpit the engine no longer serves."""
    fixtures = REPO / "tests" / "engine" / "fixtures" / "forecast"
    with _World("agras") as world:
        for name, route, body in FIXTURE_REQUESTS:
            served = world.ok(body, route=route)
            on_disk = json.loads((fixtures / ("cockpit_agras_%s.json" % name)).read_text("utf-8"))
            pins = (served.get("cockpit") or served)["pins"]["body_hash"]
            disk = (on_disk.get("cockpit") or on_disk)["pins"]["body_hash"]
            assert disk == pins, (
                "cockpit_agras_%s.json is stale; regenerate it with "
                "scripts/gen_cockpit_fixtures.py" % name)
    WORK["units"] += len(FIXTURE_REQUESTS)


def test_zz_scope_and_work(capsys):
    with capsys.disabled():
        print("\nSCOPE forecast-cockpit (forecast-scenarios-live): books %s (corpus: agras is the "
              "preliminary close, not the filed year); local: %s; routes: POST "
              "/api/forecast/{id}/cockpit and /cockpit/export, GET /api/period, GET "
              "/api/forecast, all through create_app over the tenancy double; levers: %s; "
              "latency (p50, p95 ms): %s"
              % (", ".join(BOOKS), WORK["local"], ", ".join(s.id for s in _pack().levers),
                 json.dumps(WORK["latency"], sort_keys=True)))
        print("C-F1 books: %s" % ", ".join(WORK["books"]))
        print("GATE-WORK forecast-cockpit units=%d" % WORK["units"])
    assert WORK["books"], "TC-3: F1 judged no book"
