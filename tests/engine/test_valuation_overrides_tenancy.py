"""GATE valuation-overrides-tenancy — A MEMBER IS NEVER SERVED ANOTHER
MEMBER'S VALUATION OVERRIDES.

THE DEFECT (live in production until the hotfix of 2026-10-02).
`user_valuation_assumptions` is a per-USER table (key `user_id` +
`period_id`): two members of one workspace each save their own EBITDA /
multiple / debt / cash for the same period. Two routes read it with the
SERVICE ROLE by `period_id` alone and took the first row:

  · POST /api/period/{id}/valuation/recompute — any member who could see the
    period was answered a valuation computed on whichever member's row the
    database returned first;
  · POST /api/period/{id}/briefing/regenerate — the same row was handed to
    the narrator and the briefing, ONE row the whole workspace reads, was
    written on it.

GET /api/period/{id} read the table through the caller's client by period
alone: correct only as long as a row-level policy this repository does not
define keeps other members' rows out.

THE LAW. Through the REAL routes, with two members A and B of ONE workspace
on ONE period:
  1. B's saved figures never reach A — not in A's recompute, not in A's GET,
     whichever row the table returns first, and WHETHER OR NOT row-level
     security hides B's row from A's client (the per-user client of this
     world returns every row: the code's own filter is the wall under test).
  2. A's own saved row still applies to A; B's to B (the positive control —
     a fix that drops every override would pass 1 alone).
  3. The briefing is workspace-wide: the narrator is handed the ENGINE'S
     valuation, no member's override, whoever regenerates it (owner ruling
     2026-10-02: "the engine's result is shared, overrides are per user
     only").
  4. No route reads the table under the service role, and no read of it
     omits the user from the filter (the double records every select).
  5. The SHARED `valuations` row (one per period, read by every member) is
     persisted on the ENGINE'S figures: a save writes none of the saver's
     EBITDA / multiple / debt / cash into it, so no fallback that reads the
     row (`row_benchmarks`, `lawful_stored_row`) can hand them to another
     member — proven with the benchmark table down on the other member's GET.
  6. The regenerate route's period-keyed service-role reads name the TENANT:
     the narrator's document is the period's own source document, never the
     first row carrying this `period_id` (a member of another workspace can
     write that column on their own rows), and a foreign `calculated_metrics`
     or `valuations` row on the period never reaches the narrator.

REDS ON, with the defect repaired (TC-11): any route or helper reading
`user_valuation_assumptions` with the admin client; a per-user read of it
without `user_id` in the filter; the regenerate route passing any member's
override to the narrator; the caller's own row no longer applying; the PUT
route persisting a saver's figure into the shared row; a regenerate read of
`documents` / `calculated_metrics` / `valuations` without `org_id`, or one
that takes a foreign row.
CANNOT SEE: the tables' real row-level policies (no DDL in the repo for
`valuations` / `user_valuation_assumptions`); rows ALREADY persisted on a
member's override before this fix (production held none on 2026-10-02: the
override table was empty); figures a browser computes from the served
payload.

PLANT LOG: docs/engine_book/gates.md "valuation-overrides-tenancy".
"""
from __future__ import annotations

import contextlib
from pathlib import Path
from typing import Any, Dict, List, Tuple

import pytest

import test_rebuild_net_income_anchor as ANCHOR
from engine.api import _jwt
from engine.api import _valuation as V
from engine.api import pipeline as P
from firm_postgrest_double import mint_jwt

REPO = Path(__file__).resolve().parents[2]
USER_A = ANCHOR.REANALYZE_USER
USER_B = "00000000-0000-4000-8000-0000000000b2"
TABLE = "user_valuation_assumptions"

#: Figures no engine computation yields on the agras book — each is B's or A's
#: alone, so finding one in a response says whose row was read.
B_ROW = {"ebitda_used": 99_000_000.0, "multiple_used": 19.5, "debt_used": 1_111_111.0, "cash_used": 2_222_222.0}
A_ROW = {"ebitda_used": 5_000_000.0, "multiple_used": 3.5, "debt_used": 3_333_333.0, "cash_used": 4_444_444.0}


def _stub_benchmarks(key):  # noqa: ARG001
    return {"industry_key_used": "generic", "industry_key_requested": key or "generic",
            "ev_ebitda": {"p25": 6.0, "p50": 8.0, "p75": 10.0, "source": "stub", "as_of_date": None},
            "ev_revenue": {"p25": 0.5, "p50": 0.8, "p75": 1.2, "source": "stub", "as_of_date": None}}


@pytest.fixture(autouse=True)
def _benchmarks(monkeypatch):
    monkeypatch.setattr(V, "load_valuation_benchmarks", _stub_benchmarks)


OTHER_ORG = "99999999-9999-4999-8999-999999999999"

#: The EXPLICIT regenerate body (hotfix 2026-10-02, owner ruling "explicit,
#: metered action"). The bodiless shape these tests used to POST is inert now
#: — it answers the stored briefing and never reaches the narrator, so every
#: law below about what the narrator is handed would hold vacuously on it.
EXPLICIT_REGENERATE = {"intent": "user"}


def _bearer(user_id: str) -> Dict[str, str]:
    return {"Authorization": "Bearer %s" % mint_jwt(user_id, "%s@example.test" % user_id[-4:])}


class _CallerClient:
    """The caller's own client over the shared tables: it knows WHO the
    caller is (the real signature verification) and — deliberately — applies
    NO row-level security, so a read that names no user returns every
    member's row. Every select is recorded with the client it came through."""

    def __init__(self, db: Any, jwt: str, log: List[Tuple[str, str, Dict[str, Any]]]) -> None:
        self._db, self._jwt, self._log = db, jwt, log

    def get_user(self, jwt: str) -> Dict[str, Any]:
        return _jwt.verified_identity(jwt)

    def select(self, table: str, **kw: Any):
        self._log.append(("per_user", table, dict(kw.get("filters") or {})))
        return self._db.select(table, **kw)

    def upsert(self, table: str, row: Dict[str, Any], on_conflict: Any = None, **_kw: Any):
        keys = [k.strip() for k in (on_conflict or "").split(",") if k.strip()]
        rows = self._db.tables.setdefault(table, [])
        for existing in rows:
            if keys and all(str(existing.get(k)) == str(row.get(k)) for k in keys):
                existing.update(row)
                return [existing]
        rows.append(dict(row))
        return [row]

    def __getattr__(self, name: str) -> Any:
        return getattr(self._db, name)


class _AdminClient:
    """The service role: sees everything; every select is recorded."""

    def __init__(self, db: Any, log: List[Tuple[str, str, Dict[str, Any]]]) -> None:
        self._db, self._log = db, log

    def select(self, table: str, **kw: Any):
        self._log.append(("admin", table, dict(kw.get("filters") or {})))
        return self._db.select(table, **kw)

    def upsert(self, table: str, row: Any, on_conflict: Any = None, **_kw: Any):
        keys = [k.strip() for k in (on_conflict or "").split(",") if k.strip()]
        rows = self._db.tables.setdefault(table, [])
        for existing in rows:
            if keys and isinstance(row, dict) and all(str(existing.get(k)) == str(row.get(k)) for k in keys):
                existing.clear(); existing.update(row)
                return [existing]
        return self._db.insert(table, row)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._db, name)


@contextlib.contextmanager
def _world(monkeypatch, seed: List[Dict[str, Any]]):
    """The real pipeline router over the agras book, two members of its
    workspace, and `seed` as the override table IN THAT ORDER (the order is
    what "the first row" depended on)."""
    bk = ANCHOR._book("saga_10_col_agras", REPO / "corpus" / "saga_10_col_agras")
    log: List[Tuple[str, str, Dict[str, Any]]] = []
    narrated: List[Dict[str, Any]] = []

    def narrate(doc, assembled, metrics, org, period_id, **kw):  # noqa: ARG001
        narrated.append({"valuation": kw.get("valuation"), "doc": doc, "metrics": metrics,
                         "served_ebitda": assembled["statements"]["assembled_pl"]["ebitda"]})
        return {"briefing": "stub"}

    monkeypatch.setattr(P, "stage_narrate", narrate)
    with ANCHOR._routed(bk, monkeypatch) as (client, db):
        db.tables["memberships"].append({"user_id": USER_B, "org_id": bk.org["id"], "role": "member"})
        db.tables[TABLE] = [dict(r, period_id=bk.period_id) for r in seed]
        # A stored valuations row, so the regenerate route values at all.
        db.tables["valuations"].append({"period_id": bk.period_id, "org_id": bk.org["id"],
                                        "primary_method": "ev_ebitda", "ebitda_used": 1.0})

        @contextlib.contextmanager
        def per_user(jwt: str, *_a: Any, **_k: Any):
            yield _CallerClient(db, jwt, log)

        @contextlib.contextmanager
        def admin(*_a: Any, **_k: Any):
            yield _AdminClient(db, log)

        monkeypatch.setattr(P._supabase, "per_user", per_user)
        monkeypatch.setattr(P._supabase, "admin", admin)
        yield client, db, bk, log, narrated


def _row(user_id: str, figures: Dict[str, float]) -> Dict[str, Any]:
    return {"user_id": user_id, **figures, "notes": None, "ebitda_definition": None}


def _figures(valuation: Dict[str, Any]) -> Dict[str, Any]:
    """The four override-bearing figures of a FLAT `compute_valuation` dict."""
    return {"ebitda_used": valuation.get("ebitda_used"), "multiple_used": valuation.get("multiple_ebitda_p50"),
            "debt_used": valuation.get("total_debt_used"), "cash_used": valuation.get("cash_used")}


def _carries(figures: Dict[str, Any], row: Dict[str, float]) -> List[str]:
    return [k for k, v in row.items() if figures.get(k) is not None and abs(float(figures[k]) - v) < 0.005]


def _recompute(client, bk, user: str) -> Dict[str, Any]:
    resp = client.post("/api/period/%s/valuation/recompute" % bk.period_id, json={}, headers=_bearer(user))
    assert resp.status_code == 200, resp.text[:400]
    return resp.json()["valuation"]


def _served(client, bk, user: str) -> Dict[str, Any]:
    resp = client.get("/api/period/%s" % bk.period_id, headers=_bearer(user))
    assert resp.status_code == 200, resp.text[:400]
    return resp.json()["valuation"]


# ── 1. another member's row never reaches the caller ──────────────────────

@pytest.mark.parametrize("order", ["b_first", "a_first"])
def test_recompute_never_serves_another_members_overrides(order, monkeypatch):
    """B saved overrides; A saved none (b_first) or A's row sits first
    (a_first). A's recompute carries none of B's figures either way."""
    seed = [_row(USER_B, B_ROW)] if order == "b_first" else [_row(USER_A, A_ROW), _row(USER_B, B_ROW)]
    with _world(monkeypatch, seed) as (client, _db, bk, _log, _n):
        engine = _figures(_recompute(client, bk, USER_A))
    assert _carries(engine, B_ROW) == [], "A was served B's figures: %s" % engine
    if order == "b_first":
        # Non-vacuity: A holds no row, so A's figures are the engine's own.
        assert _carries(engine, A_ROW) == []
        assert engine["ebitda_used"] is not None and engine["ebitda_used"] > 0


def test_get_period_never_serves_another_members_overrides(monkeypatch):
    with _world(monkeypatch, [_row(USER_B, B_ROW)]) as (client, _db, bk, _log, _n):
        val = _served(client, bk, USER_A)
    assert val["user_assumptions"] is None, val["user_assumptions"]
    inputs = val["inputs"]
    assert abs(inputs["ebitda_used"] - B_ROW["ebitda_used"]) > 1.0
    assert abs(inputs["total_debt_used"] - B_ROW["debt_used"]) > 0.005
    assert abs(inputs["cash_used"] - B_ROW["cash_used"]) > 0.005


def test_a_saved_override_through_the_real_put_stays_with_its_owner(monkeypatch):
    """The whole path: B saves through PUT; A then recomputes and reads."""
    with _world(monkeypatch, []) as (client, db, bk, _log, _n):
        resp = client.put("/api/period/%s/valuation-assumptions" % bk.period_id,
                          json=dict(B_ROW), headers=_bearer(USER_B))
        assert resp.status_code == 200, resp.text[:400]
        stored = db.tables[TABLE]
        assert [r["user_id"] for r in stored] == [USER_B]
        a_recompute = _figures(_recompute(client, bk, USER_A))
        a_get = _served(client, bk, USER_A)
        b_recompute = _figures(_recompute(client, bk, USER_B))
    assert _carries(a_recompute, B_ROW) == [], a_recompute
    assert a_get["user_assumptions"] is None
    assert sorted(_carries(b_recompute, B_ROW)) == sorted(B_ROW), b_recompute


# ── 2. the caller's own row still applies (positive control) ──────────────

@pytest.mark.parametrize("order", ["own_first", "own_last"])
def test_each_member_is_served_their_own_overrides(order, monkeypatch):
    seed = [_row(USER_A, A_ROW), _row(USER_B, B_ROW)]
    if order == "own_last":
        seed.reverse()
    with _world(monkeypatch, seed) as (client, _db, bk, _log, _n):
        a = _figures(_recompute(client, bk, USER_A))
        b = _figures(_recompute(client, bk, USER_B))
        a_get = _served(client, bk, USER_A)
        b_get = _served(client, bk, USER_B)
    assert sorted(_carries(a, A_ROW)) == sorted(A_ROW) and _carries(a, B_ROW) == [], a
    assert sorted(_carries(b, B_ROW)) == sorted(B_ROW) and _carries(b, A_ROW) == [], b
    assert a_get["user_assumptions"]["ebitda_used"] == A_ROW["ebitda_used"]
    assert b_get["user_assumptions"]["ebitda_used"] == B_ROW["ebitda_used"]
    assert a_get["inputs"]["ebitda_used"] == A_ROW["ebitda_used"]
    assert b_get["inputs"]["ebitda_used"] == B_ROW["ebitda_used"]


# ── 3. the shared briefing carries no member's override ───────────────────

@pytest.mark.parametrize("caller", [USER_A, USER_B])
def test_the_briefing_is_narrated_on_the_engines_valuation_whoever_regenerates(caller, monkeypatch):
    with _world(monkeypatch, [_row(USER_B, B_ROW), _row(USER_A, A_ROW)]) as (client, _db, bk, _log, narrated):
        resp = client.post("/api/period/%s/briefing/regenerate" % bk.period_id, json=EXPLICIT_REGENERATE,
                           headers=_bearer(caller))
        assert resp.status_code == 200, resp.text[:400]
    assert len(narrated) == 1
    handed = narrated[0]["valuation"]
    assert handed is not None, "the narrator was handed no valuation: the law would hold vacuously"
    figures = _figures(handed)
    assert _carries(figures, B_ROW) == [] and _carries(figures, A_ROW) == [], figures
    # …and it IS the engine's: the one EBITDA of the served P&L.
    assert handed["ebitda_used"] == pytest.approx(narrated[0]["served_ebitda"], abs=0.01)


# ── 4. how the table is read, on every route ──────────────────────────────

def test_the_override_table_is_never_read_under_the_service_role_or_without_the_user(monkeypatch):
    with _world(monkeypatch, [_row(USER_B, B_ROW), _row(USER_A, A_ROW)]) as (client, _db, bk, log, _n):
        _served(client, bk, USER_A)
        _recompute(client, bk, USER_A)
        resp = client.post("/api/period/%s/briefing/regenerate" % bk.period_id, json=EXPLICIT_REGENERATE,
                           headers=_bearer(USER_A))
        assert resp.status_code == 200, resp.text[:400]
    reads = [(who, filters) for who, table, filters in log if table == TABLE]
    assert reads, "no read of the override table was recorded: the scan is vacuous"
    assert [who for who, _f in reads if who == "admin"] == [], reads
    for _who, filters in reads:
        assert filters.get("user_id") == "eq.%s" % USER_A, filters
        assert filters.get("period_id") == "eq.%s" % bk.period_id, filters
    print("GATE-WORK valuation-overrides-tenancy reads=%d" % len(reads))


# ── 5. the shared valuations row is the engine's, whoever saves ───────────

def _shared_row(db, bk) -> Dict[str, Any]:
    rows = [r for r in db.tables["valuations"] if str(r.get("period_id")) == str(bk.period_id)]
    assert len(rows) == 1, "one valuations row per period, found %d" % len(rows)
    return rows[0]


def test_a_save_persists_the_engines_figures_in_the_shared_row(monkeypatch):
    with _world(monkeypatch, []) as (client, db, bk, _log, _n):
        resp = client.delete("/api/period/%s/valuation-assumptions" % bk.period_id, headers=_bearer(USER_A))
        assert resp.status_code == 200, resp.text[:400]
        engine_row = dict(_shared_row(db, bk))          # the no-override persist
        resp = client.put("/api/period/%s/valuation-assumptions" % bk.period_id,
                          json=dict(B_ROW), headers=_bearer(USER_B))
        assert resp.status_code == 200, resp.text[:400]
        after = dict(_shared_row(db, bk))
        saved = [r for r in db.tables[TABLE] if r["user_id"] == USER_B]
    # Non-vacuity: the save landed, and the engine row is a real valuation.
    assert len(saved) == 1 and saved[0]["ebitda_used"] == B_ROW["ebitda_used"]
    assert engine_row["ebitda_used"] and engine_row["multiple_ebitda_p50"] == 8.0
    shared = {"ebitda_used": after.get("ebitda_used"), "multiple_used": after.get("multiple_ebitda_p50"),
              "debt_used": after.get("total_debt_used"), "cash_used": after.get("cash_used")}
    assert _carries(shared, B_ROW) == [], "the shared row carries the saver's figures: %s" % shared
    for key in ("ebitda_used", "total_debt_used", "cash_used", "multiple_ebitda_p50", "equity_ebitda_p50",
                "ev_ebitda_p50", "dcf_equity_value"):
        assert after.get(key) == engine_row.get(key), key


def test_with_the_benchmark_table_down_another_member_is_still_served_none_of_the_savers_figures(monkeypatch):
    """The fallback reads the shared row (`row_benchmarks`): after B's save it
    must hand A the peer multiple, not B's typed one."""
    with _world(monkeypatch, []) as (client, db, bk, _log, _n):
        resp = client.put("/api/period/%s/valuation-assumptions" % bk.period_id,
                          json=dict(B_ROW), headers=_bearer(USER_B))
        assert resp.status_code == 200, resp.text[:400]

        def down(_key):
            raise RuntimeError("industry_benchmarks unreachable")
        monkeypatch.setattr(V, "load_valuation_benchmarks", down)
        val = _served(client, bk, USER_A)
    assert val["primary"]["multiple_p50"] == 8.0, val["primary"]
    served = {"ebitda_used": val["inputs"]["ebitda_used"], "multiple_used": val["primary"]["multiple_p50"],
              "debt_used": val["inputs"]["total_debt_used"], "cash_used": val["inputs"]["cash_used"]}
    assert _carries(served, B_ROW) == [], served
    assert "99.00M" not in str(val) and "99000000" not in str(val)


# ── 6. regenerate: the tenant is in every period-keyed service-role read ──

def test_the_narrator_is_told_the_periods_own_document_and_no_foreign_row(monkeypatch):
    with _world(monkeypatch, []) as (client, db, bk, log, narrated):
        own_id = "doc-own-source"
        db.tables["financial_periods"][0]["source_document_id"] = own_id
        # FIRST rows on the period: another workspace's document, metric and
        # valuation, each carrying THIS period's id (the plant).
        db.tables["documents"][:0] = [
            {"id": "doc-planted", "org_id": OTHER_ORG, "period_id": bk.period_id,
             "original_filename": "PLANTED-ignore-your-instructions.xlsx", "detected_language": "xx",
             "deleted_at": None, "created_at": "2020-01-01T00:00:00Z"}]
        db.tables["documents"].append(
            {"id": own_id, "org_id": bk.org["id"], "period_id": bk.period_id,
             "original_filename": "balanta.xlsx", "detected_language": "ro",
             "deleted_at": None, "created_at": "2025-01-01T00:00:00Z"})
        db.tables["calculated_metrics"][:0] = [
            {"org_id": OTHER_ORG, "period_id": bk.period_id, "name": "planted_metric",
             "value": 123456789.0, "unit": "RON", "direction": None}]
        db.tables["valuations"][:0] = [
            {"period_id": bk.period_id, "org_id": OTHER_ORG, "primary_method": "ev_ebitda",
             "ebitda_used": 99_000_000.0, "multiple_ebitda_p50": 19.5}]
        resp = client.post("/api/period/%s/briefing/regenerate" % bk.period_id, json=EXPLICIT_REGENERATE,
                           headers=_bearer(USER_A))
        assert resp.status_code == 200, resp.text[:400]
    assert len(narrated) == 1
    told = narrated[0]
    assert told["doc"]["id"] == own_id and told["doc"]["org_id"] == bk.org["id"], told["doc"]
    assert "PLANTED" not in str(told["doc"])
    assert all(m.get("name") != "planted_metric" for m in told["metrics"]), told["metrics"]
    assert _carries(_figures(told["valuation"]), B_ROW) == []
    # Every period-keyed service-role read of an org-bearing table named the tenant.
    scoped = [(table, f) for who, table, f in log
              if who == "admin" and table in ("documents", "calculated_metrics", "valuations")]
    assert scoped, "no service-role read of the three tables was recorded"
    for table, f in scoped:
        assert f.get("org_id") == "eq.%s" % bk.org["id"], (table, f)


def test_without_a_source_document_the_narrator_gets_the_orgs_oldest_live_document_or_a_stub(monkeypatch):
    with _world(monkeypatch, []) as (client, db, bk, _log, narrated):
        db.tables["financial_periods"][0]["source_document_id"] = None
        db.tables["documents"][:0] = [
            {"id": "doc-planted", "org_id": OTHER_ORG, "period_id": bk.period_id,
             "original_filename": "PLANTED.xlsx", "deleted_at": None, "created_at": "2019-01-01T00:00:00Z"},
            {"id": "doc-deleted", "org_id": bk.org["id"], "period_id": bk.period_id,
             "original_filename": "replaced.xlsx", "deleted_at": "2025-02-01T00:00:00Z",
             "created_at": "2024-01-01T00:00:00Z"}]
        resp = client.post("/api/period/%s/briefing/regenerate" % bk.period_id, json=EXPLICIT_REGENERATE,
                           headers=_bearer(USER_A))
        assert resp.status_code == 200, resp.text[:400]
        stub_doc = narrated[-1]["doc"]
        db.tables["documents"].append(
            {"id": "doc-live", "org_id": bk.org["id"], "period_id": bk.period_id,
             "original_filename": "live.xlsx", "deleted_at": None, "created_at": "2025-03-01T00:00:00Z"})
        resp = client.post("/api/period/%s/briefing/regenerate" % bk.period_id, json=EXPLICIT_REGENERATE,
                           headers=_bearer(USER_A))
        assert resp.status_code == 200, resp.text[:400]
        live_doc = narrated[-1]["doc"]
    assert stub_doc["id"] == "regenerate" and stub_doc["org_id"] == bk.org["id"], stub_doc
    assert live_doc["id"] == "doc-live", live_doc
