"""The valuation reads THE ONE EBITDA (owner ruling 2026-09-26: net 711
"Variația stocurilor de produse" and net 72x inside EBITDA and the operating
result; 767 financial) — design A6 "Valuation".

What this file reds on:

* EV/EBITDA reading any EBITDA other than the assembled P&L's `ebitda`
  (the retired `ebitda_statutory` read, or the revision-2 fallback that
  RECOMPUTED a second EBITDA from the incomeStatement mirror when the served
  figure was 0.0 — a refused EBITDA would fall through to another
  definition);
* a refused EBITDA serving any EV/EBITDA figure (it must refuse, with the
  stock-variation cause, and the primary method must say why);
* the developer's valuation moving because of the ruling: routing is by the
  company (sector, the ONE margin rule), not by the sign of its EBITDA, whose
  sign the ruling flipped (-29.0M -> +0.55M). Its primary value is pinned to
  the figure measured on the base commit 69fb9621;
* the NAV cap-rate NOI proxy stopping being EBITDA − net 711, or losing its
  "NOI (aproximare)" label;
* a saved user override losing the definition it was typed under: the save
  route stamps it, and a row saved before the stamp (NULL) is served flagged
  "salvat sub definiția anterioară a EBITDA".
"""
from __future__ import annotations

import copy
import re
from pathlib import Path
from typing import Any, Dict

import pytest

from engine.api import _valuation as V
from engine.country_packs.ro_romania.chart_of_accounts import EBITDA_DEFINITION_REVISION

import test_rebuild_net_income_anchor as ANCHOR

REPO = Path(__file__).resolve().parents[2]
AUTH = {"Authorization": "Bearer test"}


def _stub_benchmarks(key):  # noqa: ARG001
    return {"industry_key_used": "generic", "industry_key_requested": key or "generic",
            "ev_ebitda": {"p25": 6.0, "p50": 8.0, "p75": 10.0, "source": "stub", "as_of_date": None},
            "ev_revenue": {"p25": 0.5, "p50": 0.8, "p75": 1.2, "source": "stub", "as_of_date": None}}


def _book(name: str):
    return ANCHOR._book("saga_10_col_%s" % name, REPO / "corpus" / ("saga_10_col_%s" % name))


_SERVED: Dict[str, Dict[str, Any]] = {}


def _served_statements(name: str, monkeypatch) -> Dict[str, Any]:
    """The statements GET /api/period serves for a corpus book (the real
    write path persisted it; the real route rebuilt it)."""
    if name not in _SERVED:
        bk = _book(name)
        with ANCHOR._routed(bk, monkeypatch) as (client, _db):
            resp = client.get("/api/period/%s" % bk.period_id, headers=AUTH)
        assert resp.status_code == 200, resp.text[:400]
        _SERVED[name] = resp.json()["statements"]
    return copy.deepcopy(_SERVED[name])


def _value(statements: Dict[str, Any], industry_key=None, **kw) -> Dict[str, Any]:
    return V.compute_valuation(industry_key=industry_key, statements=statements, **kw)


@pytest.fixture(autouse=True)
def _stubbed(monkeypatch):
    monkeypatch.setattr(V, "load_valuation_benchmarks", _stub_benchmarks)


# ── The one EBITDA ─────────────────────────────────────────────────────────


@pytest.mark.parametrize("name", ["agras", "carniprod", "retail"])
def test_ev_ebitda_multiplies_the_one_ebitda_the_assembler_serves(name, monkeypatch):
    st = _served_statements(name, monkeypatch)
    apl = st["assembled_pl"]
    assert apl["ebitda_definition"] == EBITDA_DEFINITION_REVISION
    out = _value(st)
    assert out["ebitda_used"] == pytest.approx(apl["ebitda"], abs=0.01)
    assert out["ebitda"] == pytest.approx(apl["ebitda"], abs=0.01)
    # The legacy names are aliases of it — never a second figure.
    for alias in ("ebitda_statutory", "ebitda_operational", "ebitda_operating_view"):
        assert out[alias] == out["ebitda"], alias
    assert out["ebitda_definition"] == EBITDA_DEFINITION_REVISION
    assert out["ebitda_refusal"] is None
    assert out["routing"]["basis"] == "ev_ebitda"
    assert out["primary_method"] == "ev_ebitda"
    net_debt = out["total_debt_used"] - out["cash_used"]
    assert out["equity_ebitda_p50"] == pytest.approx(apl["ebitda"] * 8.0 - net_debt, abs=0.05)


def test_the_measured_net_711_is_inside_the_multiple(monkeypatch):
    """agras (a closed manufacturer, net 711 off the 121 bridge): the
    EV/EBITDA equity is the one EBITDA's, which differs from the pre-ruling
    figure by exactly net 711 x the multiple."""
    st = _served_statements("agras", monkeypatch)
    apl = st["assembled_pl"]
    net_711 = apl["inventory_variation"]["value"]
    assert net_711 == pytest.approx(1_071_687.03, abs=0.01)
    assert apl["ebitda"] == pytest.approx(11_848_065.27, abs=0.01)
    out = _value(st)
    before = apl["ebitda_before_stock_variation"] + apl["capitalized_own_work"]["value"]
    assert out["ebitda_used"] - before == pytest.approx(net_711, abs=0.01)


# ── A refused EBITDA refuses EV/EBITDA; no fallback to another figure ─────


def _refused(st: Dict[str, Any]) -> Dict[str, Any]:
    apl = st["assembled_pl"]
    for k in ("ebitda", "ebit", "operating_result", "gross_profit", "ebitda_statutory",
              "ebitda_operational", "ebitda_operating_view", "operating_ebitda"):
        apl[k] = None
    apl["inventory_variation"] = {"value": None, "provenance": None}
    apl["ebitda_refusal"] = {"code": "mixed_book_state",
                             "text_ro": "balanța nu este nici închisă, nici deschisă",
                             "text_en": "the trial balance is neither closed nor open",
                             "fields": ["ebitda", "ebit"]}
    return st


def test_a_refused_ebitda_refuses_every_ev_ebitda_figure_with_its_cause(monkeypatch):
    out = _value(_refused(_served_statements("agras", monkeypatch)))
    assert out["ebitda_used"] is None and out["ebitda"] is None
    for k in ("ev_ebitda_p25", "ev_ebitda_p50", "ev_ebitda_p75",
              "equity_ebitda_p25", "equity_ebitda_p50", "equity_ebitda_p75"):
        assert out[k] is None, k
    assert out["ebitda_refusal"]["code"] == "ebitda_refused"
    assert out["ebitda_refusal"]["cause"] == "mixed_book_state"
    assert out["routing"]["basis"] == "ebitda_refused"
    assert out["primary_method"] == "asset_based"
    assert any("EV/EBITDA is refused" in w and "neither closed nor open" in w
               for w in out["method_warnings"])
    assert out["noi_approximation"]["value"] is None
    assert out["noi_approximation"]["refusal"]["cause"] == "mixed_book_state"
    # Never an EBITDA-multiple equity on the football field.
    assert all("EBITDA" not in row["method"] for row in out["football_field"])


def test_a_zero_ebitda_is_a_zero_not_a_second_definition(monkeypatch):
    """Revision 2 recomputed a statutory EBITDA from the incomeStatement
    mirror whenever the served figure was 0.0 — a real zero was replaced by
    another definition. Now a served 0.00 is the figure."""
    st = _served_statements("agras", monkeypatch)
    st["assembled_pl"]["ebitda"] = 0.0
    out = _value(st)
    assert out["ebitda_used"] == 0.0
    assert out["routing"]["basis"] == "ebitda_not_positive"


def test_a_user_override_stands_over_a_refused_ebitda(monkeypatch):
    """The user's typed EBITDA is theirs: it is used (and stamped)."""
    out = _value(_refused(_served_statements("agras", monkeypatch)),
                 user_assumptions={"ebitda_used": 9_000_000.0,
                                   "ebitda_definition": EBITDA_DEFINITION_REVISION})
    assert out["ebitda_used"] == 9_000_000.0
    assert out["equity_ebitda_p50"] is not None
    assert out["user_override_definition"]["saved_under_previous_definition"] is False


def test_an_override_of_debt_or_the_multiple_alone_keeps_the_ebitda_refused(monkeypatch):
    """The Valuation tab saves the fields the user moved; on a refused
    period the EBITDA is sent as null (frontend/components/cfo/__tests__/
    valuationRefusedOverride.test.tsx). A null EBITDA in the saved row is
    NOT an override: the refusal stands, routed and worded as refused —
    never a 0.00 that routes on `ebitda_not_positive`."""
    out = _value(_refused(_served_statements("agras", monkeypatch)),
                 user_assumptions={"ebitda_used": None, "multiple_used": 9.0,
                                   "debt_used": 5_000.0, "cash_used": None,
                                   "ebitda_definition": EBITDA_DEFINITION_REVISION})
    assert out["ebitda_used"] is None
    assert out["routing"]["basis"] == "ebitda_refused"
    assert out["ebitda_refusal"]["cause"] == "mixed_book_state"
    assert out["equity_ebitda_p50"] is None
    assert not any("EBITDA = 0" in w for w in out["method_warnings"])


# ── The developer: routed by the company, its value unmoved ───────────────

#: Primary value measured on the base commit 69fb9621 (EBITDA -29,038,838.12,
#: asset-based because EBITDA <= 0) through the same corpus book, route and
#: stub multiples — and after the ruling (EBITDA +550,976.12, asset-based
#: because turnover is 0.6% of activity). It must not move.
DEVELOPER_PRIMARY_EQUITY = 40_284_134.73


def test_the_developer_is_valued_on_its_assets_by_the_margin_rule_not_by_its_ebitda_sign(monkeypatch):
    st = _served_statements("realestate", monkeypatch)
    apl = st["assembled_pl"]
    assert apl["ebitda"] == pytest.approx(550_976.12, abs=0.01)  # positive by ruling
    out = _value(st)
    assert out["routing"] == {"basis": "margin_not_meaningful", "margin_not_meaningful": True,
                              "is_cre_industry": False}
    assert out["primary_method"] == "asset_based"
    assert out["primary_equity_value"] == pytest.approx(DEVELOPER_PRIMARY_EQUITY, abs=0.01)
    assert out["confidence"] == "low"
    assert any("Valued on its assets, not on an earnings multiple" in w
               for w in out["method_warnings"])


def test_a_sector_real_estate_company_routes_by_its_sector(monkeypatch):
    out = _value(_served_statements("agras", monkeypatch), industry_key="real_estate_commercial")
    assert out["routing"]["basis"] == "sector_real_estate"
    assert out["primary_method"] == "asset_based"


# ── NAV cap-rate NOI proxy ──────────────────────────────────────────────────


def test_the_noi_proxy_is_ebitda_less_the_stock_variation(monkeypatch):
    """The developer's NOI proxy equals its pre-ruling EBITDA (the stock
    variation is not rental income): the NAV cap-rate figure does not move
    because of 711. 72x stays in, as the cascade has always read it."""
    st = _served_statements("realestate", monkeypatch)
    apl = st["assembled_pl"]
    noi = _value(st)["noi_approximation"]
    assert noi["value"] == pytest.approx(apl["ebitda"] - apl["inventory_variation"]["value"], abs=0.01)
    assert noi["value"] == pytest.approx(-29_038_838.12, abs=0.01)
    assert noi["label"] == {"ro": "NOI (aproximare)", "en": "NOI (approximation)"}
    assert "Variația stocurilor de produse" in noi["note"]["en"]
    assert noi["components"]["capitalized_own_work"] == apl["capitalized_own_work"]["value"]


# ── User overrides and the definition they were typed under ──────────────


def test_override_status_flags_a_row_saved_under_an_earlier_definition():
    assert V.override_definition_status(None) is None
    assert V.override_definition_status({"notes": "only a note"}) is None
    old = V.override_definition_status({"ebitda_used": 1.0})
    assert old["saved_under"] is None and old["saved_under_previous_definition"] is True
    assert old["flag"]["ro"] == "salvat sub definiția anterioară a EBITDA"
    stale = V.override_definition_status({"multiple_used": 7.0, "ebitda_definition": "ebitda/1"})
    assert stale["flag"] is not None
    now = V.override_definition_status({"ebitda_used": 1.0,
                                        "ebitda_definition": EBITDA_DEFINITION_REVISION})
    assert now["saved_under_previous_definition"] is False and now["flag"] is None


def _routed_with_saves(monkeypatch, bk):
    ctx = ANCHOR._routed(bk, monkeypatch)
    client, db = ctx.__enter__()
    db.tables.setdefault("user_valuation_assumptions", [])
    db.get_user = lambda _jwt: {"id": ANCHOR.REANALYZE_USER}
    db.upsert = lambda table, row, on_conflict=None: db.insert(table, row)
    return ctx, client, db


def test_saving_an_override_stamps_it_and_get_serves_it_current(monkeypatch):
    bk = _book("agras")
    ctx, client, db = _routed_with_saves(monkeypatch, bk)
    try:
        resp = client.put("/api/period/%s/valuation-assumptions" % bk.period_id,
                          json={"ebitda_used": 10_000_000.0, "ebitda_definition": "forged"},
                          headers=ANCHOR._member_bearer())
        assert resp.status_code == 200, resp.text[:400]
        rows = db.tables["user_valuation_assumptions"]
        assert len(rows) == 1
        # Stamped by the engine, never taken from the body.
        assert rows[0]["ebitda_definition"] == EBITDA_DEFINITION_REVISION
        val = client.get("/api/period/%s" % bk.period_id, headers=AUTH).json()["valuation"]
    finally:
        ctx.__exit__(None, None, None)
    assert val["user_assumptions"]["definition"]["saved_under_previous_definition"] is False
    assert val["inputs"]["ebitda_used"] == 10_000_000.0
    assert val["ebitda_definition"] == EBITDA_DEFINITION_REVISION
    assert val["noi_approximation"]["label"]["ro"] == "NOI (aproximare)"
    assert val["routing"]["basis"] == "ev_ebitda"


def test_a_row_saved_before_the_stamp_is_served_flagged(monkeypatch):
    bk = _book("agras")
    ctx, client, db = _routed_with_saves(monkeypatch, bk)
    try:
        resp = client.put("/api/period/%s/valuation-assumptions" % bk.period_id,
                          json={"ebitda_used": 10_000_000.0}, headers=ANCHOR._member_bearer())
        assert resp.status_code == 200, resp.text[:400]
        db.tables["user_valuation_assumptions"][0].pop("ebitda_definition")  # a pre-ruling row
        val = client.get("/api/period/%s" % bk.period_id, headers=AUTH).json()["valuation"]
    finally:
        ctx.__exit__(None, None, None)
    status = val["user_assumptions"]["definition"]
    assert status["saved_under"] is None
    assert status["flag"] == {"ro": "salvat sub definiția anterioară a EBITDA",
                              "en": "saved under the previous EBITDA definition"}
    # The user's figure still applies — the flag says what it was typed against.
    assert val["inputs"]["ebitda_used"] == 10_000_000.0


def test_the_stamp_column_has_its_migration():
    sql = (REPO / "supabase" / "schema_phase_valuation_ebitda_definition.sql").read_text(encoding="utf-8")
    bare = "\n".join(line.split("--", 1)[0] for line in sql.splitlines())
    assert re.search(r"alter\s+table\s+public\.user_valuation_assumptions\s+add\s+column\s+if\s+not\s+exists"
                     r"\s+ebitda_definition\s+text", bare, re.I)
    assert bare.strip().endswith("NOTIFY pgrst, 'reload schema';")


# ── A STORED valuations ROW is never the valuation's EBITDA (critic, 2026-09-27) ──
#
# Production's `valuations` table held six rows the engine wrote under the
# previous definition (9507d2ee 54,534,488.97; ce72e080 54,443,833.33; fc85d50d
# 220,162.84; b1aa4152 2,127,403.70; 06ffa6e8 -29,038,838.12 asset-based;
# 267eefaa 10,207,627.66). When GET /api/period's fresh recompute failed,
# `_serialize_valuation` served such a row as it stood: its old `ebitda_used`,
# EV/EBITDA primary, beside a P&L serving the one EBITDA or a refusal; the
# briefing regenerate route handed the row to the narrator. The law: a stored
# row whose `ebitda_used` is not the served EBITDA (or the user's own typed
# override), or any stored row over a REFUSED EBITDA, is never used as EBITDA
# and never makes EV/EBITDA primary — the tab recomputes on the served figures
# (over the row's peer multiples when the benchmark table is unreachable) or
# refuses with the reason.

#: agras's EBITDA before the ruling (net 711 outside) — the stored row's.
PRE_RULING_AGRAS_EBITDA = 10_776_378.24


def _stored_row(bk, ebitda_used: float) -> Dict[str, Any]:
    """An engine-written valuations row (the columns persist_valuation
    writes) on `ebitda_used`, EV/EBITDA primary over peer multiples
    6 / 8 / 10."""
    e = ebitda_used
    return {"period_id": bk.period_id, "org_id": bk.org["id"], "primary_method": "ev_ebitda",
            "ebitda_used": e, "revenue_used": 1_000_000.0, "total_debt_used": 0.0, "cash_used": 0.0,
            "multiple_ebitda_p25": 6.0, "multiple_ebitda_p50": 8.0, "multiple_ebitda_p75": 10.0,
            "ev_ebitda_p25": e * 6, "ev_ebitda_p50": e * 8, "ev_ebitda_p75": e * 10,
            "equity_ebitda_p25": e * 6, "equity_ebitda_p50": e * 8, "equity_ebitda_p75": e * 10,
            "multiple_revenue_p25": 0.5, "multiple_revenue_p50": 0.8, "multiple_revenue_p75": 1.2,
            "ev_revenue_equity_p25": 500_000.0, "ev_revenue_equity_p50": 800_000.0,
            "ev_revenue_equity_p75": 1_200_000.0, "dcf_wacc": 0.14, "dcf_terminal_growth": 0.03,
            "dcf_enterprise_value": 1.0, "dcf_equity_value": 1.0, "dcf_sensitivity_low": 1.0,
            "dcf_sensitivity_high": 1.0, "confidence": "high", "multiples_source": "stored",
            "multiples_as_of_date": None}


def _get_valuation(bk, monkeypatch, row: Dict[str, Any],
                   user_row: Any = None) -> Dict[str, Any]:
    ctx = ANCHOR._routed(bk, monkeypatch)
    client, db = ctx.__enter__()
    try:
        db.tables["valuations"].append(dict(row))
        db.tables.setdefault("user_valuation_assumptions", [])
        if user_row is not None:
            db.tables["user_valuation_assumptions"].append(dict(user_row))
            # The world says WHO the caller is: since the tenancy hotfix
            # (2026-10-02) the route reads the CALLER'S row — user id in the
            # filter — not "the row of this period"
            # (test_valuation_overrides_tenancy.py holds that law).
            db.get_user = lambda _jwt: {"id": user_row["user_id"]}
        resp = client.get("/api/period/%s" % bk.period_id, headers=AUTH)
    finally:
        ctx.__exit__(None, None, None)
    assert resp.status_code == 200, resp.text[:400]
    return resp.json()


def _benchmark_table_down(monkeypatch):
    def down(_key):
        raise RuntimeError("industry_benchmarks unreachable")
    monkeypatch.setattr(V, "load_valuation_benchmarks", down)


def _recompute_fails(monkeypatch):
    def boom(**_kw):
        raise RuntimeError("valuation recompute failed")
    monkeypatch.setattr(V, "compute_valuation", boom)


def test_a_stored_row_on_the_previous_ebitda_is_recomputed_on_the_served_one(monkeypatch):
    """The benchmark table unreachable: the SAME recompute over the row's
    peer multiples (benchmark data), on the served one EBITDA — never the
    row's old EBITDA and its EV/EBITDA equity."""
    bk = _book("agras")
    _benchmark_table_down(monkeypatch)
    body = _get_valuation(bk, monkeypatch, _stored_row(bk, PRE_RULING_AGRAS_EBITDA))
    val, apl = body["valuation"], body["statements"]["assembled_pl"]
    assert val["inputs"]["ebitda_used"] == pytest.approx(apl["ebitda"], abs=0.01)
    assert val["inputs"]["ebitda_used"] != pytest.approx(PRE_RULING_AGRAS_EBITDA, abs=1.0)
    assert val["ebitda_definition"] == EBITDA_DEFINITION_REVISION
    net_debt = val["inputs"]["total_debt_used"] - val["inputs"]["cash_used"]
    assert val["primary"]["equity_p50"] == pytest.approx(apl["ebitda"] * 8.0 - net_debt, abs=0.05)
    assert val["routing"]["basis"] == "ev_ebitda"


def test_a_stored_row_on_the_previous_ebitda_is_refused_when_nothing_recomputes(monkeypatch):
    bk = _book("agras")
    _recompute_fails(monkeypatch)
    body = _get_valuation(bk, monkeypatch, _stored_row(bk, PRE_RULING_AGRAS_EBITDA))
    val = body["valuation"]
    assert val["inputs"]["ebitda_used"] is None
    assert val["ebitda_refusal"]["cause"] == V.STORED_ROW_OTHER_EBITDA
    assert "10.78M RON" in val["ebitda_refusal"]["text_en"]
    assert val["primary_method"] == "refused" and val["primary_method"] != "ev_ebitda"
    for k in ("equity_p25", "equity_p50", "equity_p75", "ev_p25", "ev_p50", "ev_p75"):
        assert val["primary"][k] is None, k
    assert val["primary_equity_value"] is None
    assert not any("EBITDA" in (r.get("method") or "") for r in val["football_field"])


def test_a_stored_row_never_stands_in_for_a_refused_ebitda(monkeypatch):
    """The constructed `unanchored` book (net 711 refused: account 121
    absent): whatever number a stored row carries, it is not the EBITDA."""
    import test_net_711_rule as N

    bk = N._persisted("unanchored")
    _recompute_fails(monkeypatch)
    body = _get_valuation(bk, monkeypatch, _stored_row(bk, 250_000.0))
    val = body["valuation"]
    assert body["statements"]["assembled_pl"]["ebitda"] is None
    assert val["inputs"]["ebitda_used"] is None
    assert val["ebitda_refusal"]["cause"] == "account_121_anchor_absent"
    assert val["primary_method"] == "refused"
    assert val["primary"]["equity_p50"] is None


def test_a_stored_row_the_users_override_produced_stands_flagged(monkeypatch):
    """A row persisted on the EBITDA the USER typed is the user's figure:
    served, and flagged when typed under the previous definition."""
    bk = _book("agras")
    _recompute_fails(monkeypatch)
    user_row = {"user_id": ANCHOR.REANALYZE_USER, "period_id": bk.period_id,
                "ebitda_used": 10_000_000.0, "multiple_used": None, "debt_used": None,
                "cash_used": None}
    body = _get_valuation(bk, monkeypatch, _stored_row(bk, 10_000_000.0), user_row=user_row)
    val = body["valuation"]
    assert val["inputs"]["ebitda_used"] == 10_000_000.0
    assert val["primary_method"] == "ev_ebitda"
    assert val["user_assumptions"]["definition"]["flag"]["ro"] == "salvat sub definiția anterioară a EBITDA"


def test_a_stored_row_on_the_users_override_stands_over_a_refused_ebitda(monkeypatch):
    """As in `compute_valuation`, the EBITDA the USER typed stands over a
    refused one: a stored row persisted on it is served, flagged."""
    import test_net_711_rule as N

    bk = N._persisted("unanchored")
    _recompute_fails(monkeypatch)
    user_row = {"user_id": ANCHOR.REANALYZE_USER, "period_id": bk.period_id,
                "ebitda_used": 250_000.0, "multiple_used": None, "debt_used": None,
                "cash_used": None}
    val = _get_valuation(bk, monkeypatch, _stored_row(bk, 250_000.0), user_row=user_row)["valuation"]
    assert val["inputs"]["ebitda_used"] == 250_000.0
    assert val["primary_method"] == "ev_ebitda"
    assert val["user_assumptions"]["definition"]["flag"] is not None


def test_the_briefing_regenerate_never_cites_a_stored_row_on_the_previous_ebitda(monkeypatch):
    from engine.api import pipeline as P

    bk = _book("agras")
    seen = []

    def narrate(doc, assembled, metrics, org, period_id, **kw):  # noqa: ARG001
        seen.append((kw.get("valuation"), assembled["statements"]["assembled_pl"]["ebitda"]))
        return {"briefing": "stub"}

    monkeypatch.setattr(P, "stage_narrate", narrate)
    ctx = ANCHOR._routed(bk, monkeypatch)
    client, db = ctx.__enter__()
    try:
        db.upsert = lambda table, row, on_conflict=None, **_kw: db.insert(table, row)
        db.tables.setdefault("user_valuation_assumptions", [])
        db.tables["valuations"].append(_stored_row(bk, PRE_RULING_AGRAS_EBITDA))
        resp = client.post("/api/period/%s/briefing/regenerate" % bk.period_id,
                           headers=ANCHOR._member_bearer())
        assert resp.status_code == 200, resp.text[:400]
        _recompute_fails(monkeypatch)
        resp = client.post("/api/period/%s/briefing/regenerate" % bk.period_id,
                           headers=ANCHOR._member_bearer())
        assert resp.status_code == 200, resp.text[:400]
    finally:
        ctx.__exit__(None, None, None)
    (recomputed, served), (withheld, _served) = seen
    assert recomputed["ebitda_used"] == pytest.approx(served, abs=0.01)
    assert recomputed["ebitda_used"] != pytest.approx(PRE_RULING_AGRAS_EBITDA, abs=1.0)
    assert withheld["ebitda_used"] is None and withheld["equity_ebitda_p50"] is None
    assert withheld["primary_method"] == "refused"


@pytest.mark.parametrize("book,stored_key", [("agras", "food_manufacturing"), ("realestate", "generic")])
def test_one_valuation_choice_one_industry_key(book, stored_key, monkeypatch):
    """GET /api/period and the briefing regenerate route choose the served
    valuation on ONE industry key — the persist path's effective key
    (`_effective_industry`: the org's stored key, else the classifier's
    reading of the period). GET read `statements["industry"]`, the org's
    DISPLAY NAME, which no multiples table knows; the regenerate route
    passed the raw stored key (critic round 3, 2026-09-28): two keys, and
    for a sector the router reads (real estate) two valuation methods for
    one period. Reds on the two routes disagreeing, or on either missing
    the persist path's key. Non-vacuity: the display name differs from the
    key; on the developer stored as "generic" the effective key is the
    classifier's (the regenerate route's raw "generic" would differ)."""
    from engine.api import pipeline as P

    bk = _book(book)
    seen = []
    real = V.compute_valuation

    def spy(**kw):
        seen.append(kw.get("industry_key"))
        return real(**kw)

    monkeypatch.setattr(V, "compute_valuation", spy)
    monkeypatch.setattr(P, "stage_narrate", lambda *a, **k: {"briefing": "stub"})  # noqa: ARG005
    ctx = ANCHOR._routed(bk, monkeypatch)
    client, db = ctx.__enter__()
    try:
        org = db.tables["organizations"][0]
        org.update(industry_key=stored_key,
                   industry_display_name="Denumirea afișată a sectorului")
        db.upsert = lambda table, row, on_conflict=None, **_kw: db.insert(table, row)
        db.tables.setdefault("user_valuation_assumptions", [])
        db.tables["valuations"].append(_stored_row(bk, 1_000_000.0))
        resp = client.get("/api/period/%s" % bk.period_id, headers=AUTH)
        assert resp.status_code == 200, resp.text[:400]
        served_statements = resp.json()["statements"]
        get_keys = list(seen)
        del seen[:]
        resp = client.post("/api/period/%s/briefing/regenerate" % bk.period_id,
                           headers=ANCHOR._member_bearer())
        assert resp.status_code == 200, resp.text[:400]
        regen_keys = list(seen)
    finally:
        ctx.__exit__(None, None, None)
    expected = P._effective_industry(org, {"statements": served_statements,
                                           "lineItems": bk.line_items})[2]
    assert expected not in (None, "generic", org["industry_display_name"]), expected
    assert get_keys and set(get_keys) == {expected}, get_keys
    assert regen_keys and set(regen_keys) == {expected}, regen_keys
