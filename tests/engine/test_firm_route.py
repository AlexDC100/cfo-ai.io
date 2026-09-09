"""engine.api._firm_attention — the route, driven through PostgREST-faithful
reads, plus the pure shaping half.

Two things live here that nothing else gates:

  C4 / CADENCE   the cadence table is keyed ``client_org_id`` (Part C's
                 migration) and has no ``org_id``. The first cut selected
                 it by ``org_id``; PostgREST 400'd; the 400 was swallowed
                 as "table not applied"; every quarterly client was graded
                 against the pack's MONTHLY default and owed a January it
                 never had to file. The gate seeds a quarterly row through
                 the route's own read path — a double that 400s on an
                 unknown column exactly as PostgREST does — and asserts no
                 MISSING_FILE; a bad column now RAISES (a code defect),
                 and only a missing TABLE is a stated migration gap.
  FC9 / ROUTE    the performance gate in the ROUTE's shape: PERIODS_PER_
                 CLIENT periods per client, envelopes and line items read
                 through ``_load_book``'s real PostgREST calls, statements
                 rebuilt through ``pipeline._rebuild_assembled_for_briefing``
                 on every miss. Counts the heavy reads a warm open and a
                 one-client change cause (0 and one client's worth), and
                 holds the measured times to budgets derived from the
                 measurement.

Fixtures are REAL engine output (tests/engine/fixtures/firm, TC-1),
including the ``statement_line_items`` rows the real persist stage wrote.
Nothing here reaches a network: ``_supabase.per_user`` is routed to
``firm_postgrest_double.PostgrestDouble``.

Python 3.9 — no ``match``, no ``X | Y`` unions.
"""

from __future__ import annotations

import copy
import json
import time
from datetime import date
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from engine.api import _firm_attention as RT
from engine.api import _finding_rank as R
from engine.firm import attention as FA
from engine.firm import facts

from firm_postgrest_double import (PostgrestDouble, firm_table_columns, install, month_ends,
                                   postgrest_error, seed_client, unknown_column, unknown_table)

REPO = Path(__file__).resolve().parents[2]
FIXTURES = REPO / "tests" / "engine" / "fixtures" / "firm"
AUTH = {"Authorization": "Bearer test"}

CORPUS_CASES = ("saga_10_col_carniprod", "saga_10_col_agras",
                "saga_10_col_retail", "saga_10_col_realestate")


def _case(name: str) -> Dict[str, Any]:
    with open(str(FIXTURES / (name + ".json")), encoding="utf-8") as fh:
        return json.load(fh)


@pytest.fixture(scope="module")
def cases() -> Dict[str, Dict[str, Any]]:
    return dict((n, _case(n)) for n in CORPUS_CASES + ("imbalance_03pct",))


@pytest.fixture()
def fresh_cache():
    """The route's process-level cache, emptied before and after — a cold
    open must be cold, and the next test must not inherit this one's."""
    cache = RT.cache()
    cache.clear()
    yield cache
    cache.clear()


def _app(monkeypatch, double: PostgrestDouble, raise_server_exceptions: bool = True) -> TestClient:
    """``raise_server_exceptions=False`` makes an unhandled exception in
    the route the HTTP 500 a browser would see, so a gate about "the board
    is 200, never 500" reds through its OWN message (TC-2), not through
    the raw exception surfacing out of the TestClient."""
    install(monkeypatch, double)
    app = FastAPI()
    app.include_router(RT.build_router())
    return TestClient(app, raise_server_exceptions=raise_server_exceptions)


def _board(client: TestClient, as_of: str) -> Dict[str, Any]:
    r = client.get("/api/firm/attention?as_of=%s" % as_of, headers=AUTH)
    assert r.status_code == 200, r.text[:400]
    return r.json()


def _row(board: Dict[str, Any], client_id: str) -> Dict[str, Any]:
    for row in board["clients"]:
        if row["client_id"] == client_id:
            return row
    raise AssertionError("no row for %s in %s" % (client_id, [r["client_id"] for r in board["clients"]]))


# ══════════════════════════════════════════════════════════════════════
# 1. Pure shaping (no database)
# ══════════════════════════════════════════════════════════════════════


def _light_rows() -> List[Dict[str, Any]]:
    return [
        {"id": "p-1", "org_id": "org-a", "period_start": "2025-01-01",
         "period_end": "2025-12-31", "currency": "RON", "source_document_id": "d-1",
         "updated_at": "2026-01-02T10:00:00+00:00",
         "snapshot_hash": "sha256-abc", "has_envelope": "canonical_v1", "jurisdiction": "RO"},
        {"id": "p-0", "org_id": "org-a", "period_start": "2024-01-01",
         "period_end": "2024-12-31", "currency": "RON", "source_document_id": "d-0",
         "updated_at": "2025-01-02T10:00:00+00:00",
         "snapshot_hash": None, "has_envelope": None, "jurisdiction": None},
        {"id": "p-9", "org_id": "org-b", "period_start": "2025-01-01",
         "period_end": "2025-12-31", "currency": "RON", "source_document_id": "d-9",
         "updated_at": "2026-01-02T10:00:00+00:00",
         "snapshot_hash": "sha256-def", "has_envelope": "canonical_v1", "jurisdiction": "RO"},
    ]


def test_light_rows_group_per_client_newest_first_with_a_cap():
    grouped = RT.group_periods(_light_rows(), per_client=1)
    assert [r["id"] for r in grouped["org-a"]] == ["p-1"]
    assert [r["id"] for r in grouped["org-b"]] == ["p-9"]


def test_build_client_records_is_lazy_and_marks_attachment_from_the_light_columns():
    calls = {"env": [], "stmts": []}

    def env_loader(period_id: str):
        calls["env"].append(period_id)
        return _case("saga_10_col_agras")["envelope"]

    def stmts_loader(row: Dict[str, Any]):
        calls["stmts"].append(row["id"])
        return _case("saga_10_col_agras")["statements"]

    # CAEN lives on the ORG. It used to be seeded on the period row and
    # asserted from there — a green gate over a column
    # `financial_periods` does not declare.
    orgs = [{"id": "org-a", "name": "Alpha SRL", "default_currency": "RON"},
            {"id": "org-b", "name": "Beta SRL", "default_currency": "RON",
             "caen_code": "1011"}]
    records = RT.build_client_records(
        orgs, RT.group_periods(_light_rows()), {"org-b": {"cadence": "quarterly"}},
        {"org-a": [{"covenant_id": "c1", "label": "L", "metric": "equity",
                    "comparator": ">=", "limit_value": "1000", "unit": "money",
                    "headroom_warn_share": "0.1", "test_date": "2026-03-31T00:00:00",
                    "source": "doc"}]},
        env_loader, stmts_loader, lambda org: "")
    assert [r.client_id for r in records] == ["org-a", "org-b"]
    a = records[0]
    assert a.jurisdiction == "RO", "jurisdiction comes from the envelope's pack_provenance"
    assert calls == {"env": [], "stmts": []}, "shaping must not load anything"
    assert [p.period_id for p in a.periods_desc()] == ["p-1", "p-0"]
    assert a.periods_desc()[0].has_trial_balance() is True
    assert a.periods_desc()[1].has_trial_balance() is False
    assert a.periods_desc()[0].snapshot_id() == "sha256-abc"
    assert a.covenants[0].limit == 1000.0 and a.covenants[0].test_date == "2026-03-31"
    assert records[1].cadence_row == {"cadence": "quarterly"}
    # FROM THE ORG. This used to read a `caen_code` seeded on the PERIOD
    # row — a green gate over a column `financial_periods` does not
    # declare, which is what let `_firm_attention` name it in an explicit
    # projection and go unnoticed until the Cockpit flag flips.
    assert records[1].periods[0].caen == "1011"
    assert records[0].periods[0].caen is None, (
        "org-a declares no CAEN, so its periods must carry none")
    # The loaders run only on a facts build (a cache miss).
    pack = FA.load_attention_pack()
    facts.build_client_facts(a, pack.cash_row_ids, pack.fingerprint())
    assert calls["env"] == ["p-1"] and calls["stmts"] == ["p-1"]


def test_the_snapshot_key_of_a_light_record_is_stable_and_moves_with_updated_at():
    orgs = [{"id": "org-a", "name": "Alpha"}]
    pack = FA.load_attention_pack()
    rec1 = RT.build_client_records(orgs, RT.group_periods(_light_rows()), {}, {},
                                   lambda p: None, lambda r: None, lambda o: "RO")[0]
    rows = _light_rows()
    rows[0]["updated_at"] = "2026-02-02T10:00:00+00:00"
    rec2 = RT.build_client_records(orgs, RT.group_periods(rows), {}, {},
                                   lambda p: None, lambda r: None, lambda o: "RO")[0]
    k1 = facts.snapshot_key(rec1, pack.fingerprint())
    assert k1 == facts.snapshot_key(rec1, pack.fingerprint())
    assert k1 != facts.snapshot_key(rec2, pack.fingerprint())


def test_suppression_row_adapter_maps_kind_to_the_dismissal_rule_id():
    s = RT.suppression_from_row({"org_id": "org-a", "kind": "CASH_RUNWAY", "scope_key": None,
                                 "reason": "facility signed", "dismissed_by": "u",
                                 "dismissed_at": "t", "periods": 3, "from_period_ordinal": 12})
    assert s.client_id == "org-a" and s.kind == "CASH_RUNWAY"
    assert s.dismissal.scope_key == R.SCOPE_ANY and s.dismissal.periods == 3


def test_the_board_payload_has_the_contract_the_frontend_is_handed():
    case = _case("saga_10_col_agras")
    from engine.firm.model import ClientRecord, PeriodRecord
    client = ClientRecord("org-a", "Alpha", "RO", periods=(PeriodRecord(
        "p-1", "2025-12-31", "RON", "2025-01-01", "d-1", "v1",
        envelope=case["envelope"], statements=case["statements"]),))
    payload = FA.compute_firm_attention([client], as_of=date(2026, 3, 10)).to_payload()
    assert set(payload) >= {"version", "as_of", "pack", "materiality_policy", "clients",
                            "suppressed", "suppression_audit", "kinds_absent", "counts", "cache",
                            "duplicate_clients"}
    row = payload["clients"][0]
    assert set(row) >= {"client_id", "client_name", "top_severity", "top_kind", "top_reason",
                        "nearest_due_at", "nearest_days_to_due", "item_count", "counts",
                        "reasons", "items", "gaps", "suppressed_count"}
    item = row["items"][0]
    assert set(item) >= {"client_id", "kind", "severity", "reason", "action", "evidence",
                         "scope_key", "period_id", "due_at", "days_to_due", "base_severity",
                         "severity_breakdown", "materiality", "materiality_refusal",
                         "persistence", "source", "suppression", "suppressed_but_retained"}
    ev = item["evidence"][0]
    assert set(ev) == {"fact", "label", "unit", "value", "text", "currency", "provenance"}
    assert set(ev["provenance"]) >= {"period_id", "snapshot_id", "line_id", "source"}
    json.dumps(payload)  # serialisable as-is


def test_suppress_endpoint_refuses_an_empty_reason_and_an_unknown_kind(monkeypatch):
    from engine.api import _org

    monkeypatch.setattr(_org, "resolve_user_id", lambda jwt: "user-1")
    app = FastAPI()
    app.include_router(RT.build_router())
    client = TestClient(app)
    r = client.post("/api/firm/attention/suppress", headers=AUTH,
                    json={"client_id": "org-a", "kind": "CASH_RUNWAY", "reason": "   "})
    assert r.status_code == 422 and "reason" in r.text
    r = client.post("/api/firm/attention/suppress", headers=AUTH,
                    json={"client_id": "org-a", "kind": "NOT_A_KIND", "reason": "x"})
    assert r.status_code == 422 and "NOT_A_KIND" in r.text
    r = client.post("/api/firm/attention/suppress",
                    json={"client_id": "org-a", "kind": "CASH_RUNWAY", "reason": "x"})
    assert r.status_code == 401
    r = client.get("/api/firm/attention/kinds", headers=AUTH)
    assert r.status_code == 200
    body = r.json()
    assert "RADAR_FLAG" in [a["kind"] for a in body["absent_kinds"]]
    assert body["kind_specs"]["COVENANT_RISK"]["extra"]["covenant_schema"]


# ══════════════════════════════════════════════════════════════════════
# 2. C4 — the cadence row is read by the column the MIGRATION declares
# ══════════════════════════════════════════════════════════════════════

#: A day on which a MONTHLY client owes January (ended 2026-01-31, deadline
#: 2026-02-25 ahead -> an open MISSING_FILE) and a QUARTERLY client owes
#: nothing (Q4 filed, Q1 ends 2026-03-31). The date is what makes the
#: gate discriminate; test_cadence_the_pack_default_is_monthly_… proves it.
CADENCE_GATE_DAY = "2026-02-20"
#: A day on which the quarterly client IS stale (Q1 deadline 2026-04-25 passed).
CADENCE_STALE_DAY = "2026-05-10"


def _quarterly_world(cases, with_row: bool) -> PostgrestDouble:
    double = PostgrestDouble()
    seed_client(double, "org-q", "Quarterly SRL", cases["saga_10_col_agras"], ["2025-12-31"])
    if with_row:
        # Shaped exactly as schema_phase_firm_requests.sql declares the
        # table: PK client_org_id, no org_id. Added through the double's
        # column check, so a drift on either side fails right here.
        double.add(RT.TABLE_CADENCE, {"client_org_id": "org-q", "firm_id": "firm-1",
                                      "cadence": "quarterly", "fiscal_year_end_month": 12})
    return double


def test_cadence_key_names_a_column_the_migration_declares():
    """Structural half of C4: every optional table is read by a column its
    OWN migration declares — parsed from the SQL, not from a belief."""
    cols = firm_table_columns()
    assert len(cols[RT.TABLE_CADENCE]) >= 5, ("the migration parser collapsed: %r"
                                             % cols.get(RT.TABLE_CADENCE))
    for table, key in RT.CLIENT_COLUMN.items():
        assert key in cols[table], (
            "C4 — %s is read by %r, which %s does not declare (it declares %s)"
            % (table, key, "the migration", cols[table]))
    assert "org_id" not in cols[RT.TABLE_CADENCE], (
        "firm_client_cadence now carries org_id — the trap this gate guards has moved; "
        "re-read CLIENT_COLUMN and the migration together")


def test_cadence_quarterly_row_is_honoured_through_the_routes_own_read_path(
        monkeypatch, fresh_cache, cases):
    """C4, through the route: a QUARTERLY cadence row keyed client_org_id,
    read by GET /api/firm/attention on a day when the MONTHLY default
    would alarm. No MISSING_FILE, no notice about the table, and the
    stale verdict — when it comes — names the quarterly cadence."""
    client = _app(monkeypatch, _quarterly_world(cases, with_row=True))
    r = client.get("/api/firm/attention?as_of=%s" % CADENCE_GATE_DAY, headers=AUTH)
    assert r.status_code == 200, (
        "C4 CADENCE ROW LOST — the board could not read the stored quarterly cadence "
        "through its own read path: HTTP %d %s" % (r.status_code, r.text[:300]))
    body = r.json()
    # The claim FIRST (the FC4 lesson): the board's verdict, in its own words.
    row = _row(body, "org-q")
    missing = [i["scope_key"] for i in row["items"] if i["kind"] == "MISSING_FILE"]
    assert not missing, (
        "C4 CADENCE ROW LOST — a QUARTERLY client (Q4 filed, Q1 not due until 2026-03-31) "
        "was graded against the MONTHLY default on %s and 'owes' %s"
        % (CADENCE_GATE_DAY, missing))
    noticed = [n for n in body["notices"] if RT.TABLE_CADENCE in n]
    assert not noticed, (
        "C4 CADENCE ROW LOST — the cadence table was reported unreadable, so the client "
        "silently fell back to the pack default: %s" % noticed)
    assert not [g for g in row["gaps"] if g["kind"] in ("MISSING_FILE", "STALE_PERIOD")], row["gaps"]
    stale_row = _row(_board(client, CADENCE_STALE_DAY), "org-q")
    stale = [i for i in stale_row["items"] if i["kind"] == "STALE_PERIOD"]
    assert stale and "quarterly" in stale[0]["reason"], (
        "the stored cadence did not reach the verdict: %s" % [i["reason"] for i in stale])


def test_cadence_the_pack_default_is_monthly_and_the_gate_day_discriminates(
        monkeypatch, fresh_cache, cases):
    """TC-9: the same world WITHOUT the stored row, same day. The pack
    default (monthly) owes January — so the quiet board above is the
    row being honoured, not a day on which nobody owes anything."""
    client = _app(monkeypatch, _quarterly_world(cases, with_row=False))
    row = _row(_board(client, CADENCE_GATE_DAY), "org-q")
    missing = [i["scope_key"] for i in row["items"] if i["kind"] == "MISSING_FILE"]
    assert missing == ["period:2026-01-31"], missing


@pytest.mark.parametrize("exc, expected", [
    (unknown_column("firm_client_cadence", "org_id"), "bad_column"),
    (postgrest_error(400, "PGRST204", "Could not find the 'org_id' column of "
                     "'firm_client_cadence' in the schema cache", "firm_client_cadence"),
     "bad_column"),
    (unknown_table("firm_covenants"), "missing_table"),
    (postgrest_error(404, "42P01", 'relation "public.firm_covenants" does not exist',
                     "firm_covenants"), "missing_table"),
    (postgrest_error(503, "", "upstream unavailable", "firm_covenants"), "other"),
    (RuntimeError("connection refused"), "other"),
], ids=["42703", "PGRST204", "PGRST205", "42P01", "503", "no-response"])
def test_cadence_read_errors_are_classified_by_what_they_mean(exc, expected):
    kind, detail = RT.classify_read_error(exc)
    assert kind == expected, (kind, detail)
    if expected != "other":
        assert "HTTP" in detail and (exc.response.json()["code"] or "") in detail


def test_cadence_table_read_states_an_unapplied_migration_and_raises_on_a_bad_column():
    """The two failure shapes must not be confused: a missing TABLE is a
    notice on the payload, a missing COLUMN is a defect that raises."""
    class _Unapplied(object):
        def select(self, table, **kw):
            raise unknown_table(table)

    notices = []  # type: List[str]
    assert RT.read_optional_table(_Unapplied(), RT.TABLE_COVENANTS, ["org-1"], notices) == []
    assert len(notices) == 1 and "not applied" in notices[0] and "PGRST205" in notices[0], notices

    # The double itself, asked by the WRONG key, sends the same 400
    # PostgREST sends — through the route's reader, not through a stub.
    double = PostgrestDouble()
    double.add(RT.TABLE_CADENCE, {"client_org_id": "org-1", "cadence": "quarterly"})
    with pytest.raises(httpx.HTTPStatusError):
        double.select(RT.TABLE_CADENCE, filters={"org_id": 'in.("org-1")'})
    monkey = dict(RT.CLIENT_COLUMN)
    monkey[RT.TABLE_CADENCE] = "org_id"
    original = dict(RT.CLIENT_COLUMN)
    RT.CLIENT_COLUMN.update(monkey)
    try:
        with pytest.raises(RT.TableReadDefect) as caught:
            RT.read_optional_table(double, RT.TABLE_CADENCE, ["org-1"], [])
    finally:
        RT.CLIENT_COLUMN.clear()
        RT.CLIENT_COLUMN.update(original)
    assert "code defect" in str(caught.value) and "42703" in str(caught.value)
    assert "not applied" not in str(caught.value)
    # And by the right key the row comes back, keyed as the migration keys it.
    rows = RT.read_optional_table(double, RT.TABLE_CADENCE, ["org-1"], [])
    assert [r["client_org_id"] for r in rows] == ["org-1"]


def test_cadence_bad_column_surfaces_as_a_500_with_the_defect_named(monkeypatch, fresh_cache, cases):
    """Through the route: the 400 is not swallowed into a notice."""
    client = _app(monkeypatch, _quarterly_world(cases, with_row=True))
    monkeypatch.setitem(RT.CLIENT_COLUMN, RT.TABLE_CADENCE, "org_id")
    r = client.get("/api/firm/attention?as_of=%s" % CADENCE_GATE_DAY, headers=AUTH)
    assert r.status_code == 500 and "code defect" in r.text and "42703" in r.text, r.text[:300]


# ══════════════════════════════════════════════════════════════════════
# 3. The other two routes, through the same reads
# ══════════════════════════════════════════════════════════════════════


def test_suppress_and_list_go_through_the_callers_own_client(monkeypatch, fresh_cache, cases):
    double = PostgrestDouble()
    seed_client(double, "org-a", "Agras", cases["saga_10_col_agras"], ["2025-12-31"])
    client = _app(monkeypatch, double)
    r = client.post("/api/firm/attention/suppress", headers=AUTH,
                    json={"client_id": "org-a", "kind": "CASH_RUNWAY", "reason": "facility signed"})
    assert r.status_code == 200, r.text
    stored = double.rows(RT.TABLE_SUPPRESSIONS)
    assert len(stored) == 1 and stored[0]["dismissed_by"] == "user-double"
    assert stored[0]["scope_key"] == R.SCOPE_ANY and stored[0]["reason"] == "facility signed"
    row = _row(_board(client, "2026-01-10"), "org-a")
    runway = [i for i in row["items"] if i["kind"] == "CASH_RUNWAY"]
    assert runway, "the agras fixture's CASH_RUNWAY item is the subject of this suppression"
    assert runway[0]["severity"] == "critical" and runway[0]["suppressed_but_retained"] is True
    assert runway[0]["suppression"]["reason"] == "facility signed"
    listed = client.get("/api/firm/attention/suppressions", headers=AUTH).json()
    assert [s["kind"] for s in listed["suppressions"]] == ["CASH_RUNWAY"] and listed["notices"] == []


def test_an_unapplied_optional_table_is_a_notice_never_a_500(monkeypatch, fresh_cache, cases):
    double = PostgrestDouble()
    seed_client(double, "org-a", "Agras", cases["saga_10_col_agras"], ["2025-12-31"])
    del double.columns[RT.TABLE_COVENANTS]          # the migration is not applied
    body = _board(_app(monkeypatch, double), "2026-01-10")
    assert [n for n in body["notices"] if n.startswith(RT.TABLE_COVENANTS + ": not applied")]
    assert _row(body, "org-a")["items"], "the board still computes for the client"


# ══════════════════════════════════════════════════════════════════════
# 4. FC9 in the ROUTE's shape — 12 periods per client, real reads, rebuilt
#    statements, COUNTED (deterministic) and budgeted (wall-clock)
# ══════════════════════════════════════════════════════════════════════

FC9_ROUTE_CLIENTS = len(CORPUS_CASES)          # four real books, one per corpus fixture
FC9_ROUTE_AS_OF = "2026-01-10"

#: BUDGETS — derived from the measurement (TC-3), not negotiated. Reference
#: host 2026-09-04/05 (Python 3.9, macOS): cold 0.69–3.1 s per client (12
#: periods: 60 PostgREST requests + 12 statement rebuilds through
#: pipeline._rebuild_assembled_for_briefing at ~45 ms each + the facts
#: build), warm open 30–110 ms for the board (seven light reads, zero
#: heavy), incremental 0.67–2.5 s (one client's 12 periods re-read and
#: rebuilt). The wall-clock swung 3x across runs on the same host (critic
#: D12), so these are COARSE — the exact COUNTS and the SEAM below are the
#: claim; the wall-clock is the second assertion.
FC9_ROUTE_BUDGET_COLD_MS_PER_CLIENT = 5000.0
FC9_ROUTE_BUDGET_WARM_MS = 400.0
FC9_ROUTE_BUDGET_INCREMENTAL_MS = 4000.0
#: THE SEAM (D12). The route reaches the facts builder through the name
#: `engine.firm.attention.build_client_facts`, bound at import; a plant on
#: `engine.firm.facts.build_client_facts` never ran through the route, and
#: a 1,000 ms/client plant on the BOUND name stayed green under the coarse
#: cold budget above (2,288 ms/client measured under 5,000). This measures
#: the seam itself: the time INSIDE the bound-name call that is NOT inside
#: the period builders (facts.build_period_facts). Unplanted it is the
#: tuple + the snapshot key: 0–3 ms per client on the reference host; it
#: does not scale with the host's speed at rebuilding statements, so 100
#: ms is a budget a slow CI host cannot drift into and a 1,000 ms plant
#: cannot hide under.
FC9_ROUTE_BUDGET_SEAM_MS_PER_CLIENT = 100.0
#: EXACT per-client counts of a MISS through the route (N, stated): ONE
#: build of the client's facts; per period ONE envelope read, ONE full row
#: read, and ONE line-item walk — which is TWO requests, the page and the
#: empty page that proves it was the last (engine.api._paging stops on
#: nothing else). No headroom: these are the incremental claim.
FC9_BUILDS_PER_CLIENT = 1
FC9_HEAVY_REQUESTS_PER_PERIOD = {"envelope": 1, "period_full": 1, "line_items": 2}
FC9_HEAVY_WALKS_PER_PERIOD = {"envelope": 1, "period_full": 1, "line_items": 1}
#: The light reads of an UNCHANGED board over four clients, in order: every
#: list read is a walk that ends on an EMPTY page, so the two non-empty
#: tables cost two requests each and the three empty optional tables one.
FC9_WARM_LIGHT_READS = ["organizations", "organizations", "financial_periods",
                        "financial_periods", RT.TABLE_CADENCE, RT.TABLE_COVENANTS,
                        RT.TABLE_SUPPRESSIONS]


def _instrument_builds(monkeypatch) -> Dict[str, Any]:
    """Count and time the facts builds THE ROUTE makes, through the name it
    actually calls. The outer wrapper replaces `FA.build_client_facts`
    with a wrapper around WHATEVER IS BOUND THERE NOW — a plant included,
    which is the point: the critics' slow plant on the bound name is
    measured, not bypassed. The inner wrapper times `facts.
    build_period_facts`, which `facts.build_client_facts` reaches by a
    global lookup, so (outer - inner) is the seam and nothing else."""
    bound = FA.build_client_facts
    inner = facts.build_period_facts
    seen = {"builds": [], "outer_s": 0.0, "inner_s": 0.0}  # type: Dict[str, Any]

    def outer(client, *a, **k):
        seen["builds"].append(client.client_id)
        t = time.perf_counter()
        try:
            return bound(client, *a, **k)
        finally:
            seen["outer_s"] += time.perf_counter() - t

    def timed_inner(*a, **k):
        t = time.perf_counter()
        try:
            return inner(*a, **k)
        finally:
            seen["inner_s"] += time.perf_counter() - t

    monkeypatch.setattr(FA, "build_client_facts", outer)
    monkeypatch.setattr(facts, "build_period_facts", timed_inner)
    return seen


def _seam_ms_per_client(seen: Dict[str, Any], n: int) -> float:
    return max(0.0, seen["outer_s"] - seen["inner_s"]) * 1000.0 / max(1, n)


def _reset(seen: Dict[str, Any]) -> None:
    seen["builds"] = []
    seen["outer_s"] = 0.0
    seen["inner_s"] = 0.0


def test_fc9_route_shape_twelve_periods_per_client_through_the_real_reads(
        monkeypatch, fresh_cache, cases, capsys):
    """TC-11 — after D12 this gate reds on: a facts build the route makes
    twice (or never) for a client through the bound name; a heavy read
    that touches a period twice, or a period the walk never reads; an
    unchanged board that builds or reads anything heavy; a one-client
    change that rebuilds more than that client; time spent between the
    bound name and the period builders (a wrapper, a delay, a duplicate
    build) above 100 ms/client; and the coarse wall-clock budgets."""
    ends = month_ends(2025, 12, RT.PERIODS_PER_CLIENT)
    double = PostgrestDouble()
    for i, name in enumerate(CORPUS_CASES):
        seed_client(double, "org-%d" % i, "Client %d" % i, cases[name], ends)
    client = _app(monkeypatch, double)
    seen = _instrument_builds(monkeypatch)
    n, per = FC9_ROUTE_CLIENTS, RT.PERIODS_PER_CLIENT
    zero = {"envelope": 0, "period_full": 0, "line_items": 0}
    every = dict((k, v * n * per) for k, v in FC9_HEAVY_REQUESTS_PER_PERIOD.items())
    every_walk = dict((k, v * n * per) for k, v in FC9_HEAVY_WALKS_PER_PERIOD.items())

    # COLD: every client a miss; every period read exactly once, rebuilt once;
    # exactly ONE build per client THROUGH THE BOUND NAME.
    t0 = time.perf_counter()
    cold_board = _board(client, FC9_ROUTE_AS_OF)
    cold_ms = (time.perf_counter() - t0) * 1000.0
    cold_seam = _seam_ms_per_client(seen, n)
    assert cold_board["cache"] == {"hits": 0, "misses": n, "entries": n}, cold_board["cache"]
    assert seen["builds"] == ["org-%d" % i for i in range(n)], (
        "FC9 (route) — expected exactly %d build of each client's facts through "
        "engine.firm.attention.build_client_facts on a cold open, got %s"
        % (FC9_BUILDS_PER_CLIENT, seen["builds"]))
    assert double.heavy_walks() == every_walk, (
        "the cold open must read each of the %d periods exactly once: %s"
        % (n * per, double.heavy_walks()))
    assert double.heavy_reads() == every, (
        "the cold open's heavy REQUESTS are exact (%s per period): %s"
        % (FC9_HEAVY_REQUESTS_PER_PERIOD, double.heavy_reads()))
    for row in cold_board["clients"]:
        assert not [g for g in row["gaps"] if "no assembled statements" in g["reason"]], (
            "the statements rebuild path did not run for %s: %s" % (row["client_id"], row["gaps"]))
    for i in range(n):
        built = fresh_cache.facts_for("org-%d" % i)
        assert built is not None, (
            "FC9 NOT INCREMENTAL (route) — the board was computed against a cache the route "
            "does not keep: nothing for org-%d in the process-level cache after the cold open, "
            "so the next open will rebuild it" % i)
        assert len(built.periods) == per, (i, len(built.periods))
        assert all(p.has_trial_balance and p.profile is not None for p in built.periods), (
            "every period must carry rebuilt statements and a profile: %s"
            % [(p.period_id, p.profile_gap) for p in built.periods if p.profile is None])
        assert all(p.period_days and p.period_days < 32 for p in built.periods), (
            "period length must come from the period row, never the rebuild's 365 stub")

    # WARM: nothing changed -> the seven light reads, zero heavy, zero builds.
    double.reset_calls()
    fresh_cache.reset_counters()
    _reset(seen)
    t0 = time.perf_counter()
    warm_board = _board(client, FC9_ROUTE_AS_OF)
    warm_ms = (time.perf_counter() - t0) * 1000.0
    assert seen["builds"] == [], (
        "FC9 NOT INCREMENTAL (route) — an unchanged board built facts for %s through the "
        "bound name (0 expected)" % seen["builds"])
    assert warm_board["cache"] == {"hits": n, "misses": 0, "entries": n}, (
        "FC9 NOT INCREMENTAL (route) — an unchanged board recomputed %d client(s)"
        % warm_board["cache"]["misses"])
    assert double.heavy_reads() == zero, (
        "FC9 NOT INCREMENTAL (route) — an unchanged board re-read envelopes/statements: %s"
        % double.heavy_reads())
    assert [c[1] for c in double.selects()] == FC9_WARM_LIGHT_READS, [c[1] for c in double.selects()]
    assert warm_board["clients"] == cold_board["clients"]

    # INCREMENTAL: one period of one client changes (new envelope, new
    # updated_at) -> exactly that client's periods are re-read and rebuilt,
    # exactly that client built.
    changed = "org-1"
    latest = [r for r in double.rows("financial_periods") if r["org_id"] == changed][-1]
    latest["assembled_canonical_v1"] = copy.deepcopy(cases["imbalance_03pct"]["envelope"])
    latest["updated_at"] = "2026-01-09T00:00:00+00:00"
    double.tables["statement_line_items"] = [
        r for r in double.rows("statement_line_items") if r["period_id"] != latest["id"]]
    for item in cases["imbalance_03pct"]["line_items"]:
        double.add("statement_line_items", dict(item, period_id=latest["id"]))
    double.reset_calls()
    fresh_cache.reset_counters()
    _reset(seen)
    t0 = time.perf_counter()
    inc_board = _board(client, FC9_ROUTE_AS_OF)
    inc_ms = (time.perf_counter() - t0) * 1000.0
    assert inc_board["cache"] == {"hits": n - 1, "misses": 1, "entries": n}, (
        "FC9 NOT INCREMENTAL (route) — one client changed; expected exactly 1 recompute, "
        "got %d (0 = STALE facts served for a changed snapshot; %d = a full recompute)"
        % (inc_board["cache"]["misses"], n))
    assert seen["builds"] == [changed], (
        "FC9 NOT INCREMENTAL (route) — one client changed; expected exactly [%r] built, got %s"
        % (changed, seen["builds"]))
    assert double.heavy_walks() == dict((k, v * per) for k, v in FC9_HEAVY_WALKS_PER_PERIOD.items()), (
        "FC9 NOT INCREMENTAL (route) — one client changed; expected exactly its %d periods "
        "re-read, got %s" % (per, double.heavy_walks()))
    assert double.heavy_reads() == dict((k, v * per) for k, v in FC9_HEAVY_REQUESTS_PER_PERIOD.items()), (
        double.heavy_reads())
    assert [i["kind"] for i in _row(inc_board, changed)["items"] if i["kind"] == "IMBALANCED"], (
        "FC9 STALE — the changed client's new envelope was not reflected")
    assert not [i for i in _row(warm_board, changed)["items"] if i["kind"] == "IMBALANCED"]
    untouched = [r for r in warm_board["clients"] if r["client_id"] != changed]
    assert [r for r in inc_board["clients"] if r["client_id"] != changed] == untouched

    cold_per_client = cold_ms / n
    with capsys.disabled():
        print("\n[FC9/route] %d clients x %d periods — cold: %.0f ms/client (%d heavy requests "
              "over %d walks + %d rebuilds each, %d build/client through the bound name, seam "
              "%.1f ms/client [budget %.0f]), %.2f s total [budget %.0f ms/client]; warm open: "
              "%.0f ms, %d light reads, 0 heavy, 0 builds [budget %.0f ms]; incremental (1 "
              "client): %.0f ms, %d heavy requests, 1 build [budget %.0f ms]"
              % (n, per, cold_per_client, sum(every.values()) // n, 3 * per, per,
                 FC9_BUILDS_PER_CLIENT, cold_seam, FC9_ROUTE_BUDGET_SEAM_MS_PER_CLIENT,
                 cold_ms / 1000.0, FC9_ROUTE_BUDGET_COLD_MS_PER_CLIENT, warm_ms,
                 len(FC9_WARM_LIGHT_READS), FC9_ROUTE_BUDGET_WARM_MS, inc_ms,
                 sum(every.values()) // n, FC9_ROUTE_BUDGET_INCREMENTAL_MS))
    assert cold_seam <= FC9_ROUTE_BUDGET_SEAM_MS_PER_CLIENT, (
        "FC9 SEAM OVER BUDGET (route) — %.0f ms per client is spent between the route's bound "
        "name (engine.firm.attention.build_client_facts) and the period builders, budget %.0f "
        "(reference host: 0-3 ms). Something wraps, delays or duplicates the facts build on "
        "the route's own call path." % (cold_seam, FC9_ROUTE_BUDGET_SEAM_MS_PER_CLIENT))
    assert cold_per_client <= FC9_ROUTE_BUDGET_COLD_MS_PER_CLIENT, (
        "FC9 OVER BUDGET (route) — cold open cost %.0f ms per 12-period client, budget %.0f "
        "(reference host: ~1.2 s)" % (cold_per_client, FC9_ROUTE_BUDGET_COLD_MS_PER_CLIENT))
    assert warm_ms <= FC9_ROUTE_BUDGET_WARM_MS, (
        "FC9 OVER BUDGET (route) — the warm open of an unchanged %d-client board took %.0f ms, "
        "budget %.0f (reference host: ~50 ms)" % (n, warm_ms, FC9_ROUTE_BUDGET_WARM_MS))
    assert inc_ms <= FC9_ROUTE_BUDGET_INCREMENTAL_MS, (
        "FC9 OVER BUDGET (route) — a one-client change cost %.0f ms, budget %.0f "
        "(reference host: ~1.2 s)" % (inc_ms, FC9_ROUTE_BUDGET_INCREMENTAL_MS))


# ══════════════════════════════════════════════════════════════════════
# 5. A2 / D9 — PAGINATION: PostgREST caps every response at db-max-rows,
#    silently, and the cap is an OPERATOR KNOB. The walk stops only on an
#    EMPTY page, so it is proven at three caps the route never reads.
# ══════════════════════════════════════════════════════════════════════

A2_AS_OF = "2026-01-10"
#: The caps the walk is proven at: an odd small one no fixture can happen
#: to fit, the one an operator lands on when halving Supabase's default
#: (CLAUDE.md §14's "toggle Max Rows" escalation), and the default.
D9_CAPS = (37, 500, 1000)
#: The one MISSING_FILE basis a DETACHED period row produces — one item
#: per period row the route actually READ, which is what makes a lost
#: row visible on the payload without a single heavy read.
A2_ROW_BASIS = "period row exists without a trial balance"


def _detached_case() -> Dict[str, Any]:
    return {"currency": "RON", "envelope": None, "line_items": []}


def _detached_book(n_clients: int, periods_each: int,
                   max_rows: Optional[int] = None) -> PostgrestDouble:
    """``n_clients`` organizations, each with ``periods_each`` period rows
    that carry NO trial balance: the board computes them from the light
    rows alone (no envelope, no rebuild), so a 1,200-row book costs
    seconds, not the critics' eleven minutes."""
    double = PostgrestDouble(max_rows=max_rows)
    ends = month_ends(2025, 12, periods_each)
    for i in range(n_clients):
        seed_client(double, "org-%04d" % i, "Client %04d" % i, _detached_case(), ends,
                    attached=False)
    return double


def _period_rows_seen(row: Dict[str, Any]) -> int:
    """How many period rows the route read for this client: the
    MISSING_FILE items whose basis is the row itself."""
    n = 0
    for item in row["items"]:
        if item["kind"] != "MISSING_FILE":
            continue
        basis = [e["text"] for e in item["evidence"] if e["fact"] == "missing_basis"]
        if basis == [A2_ROW_BASIS]:
            n += 1
    return n


def _pages_for(rows: int, cap: int) -> int:
    """Requests a walk over ``rows`` rows costs at ``cap``: the pages that
    carry rows (``ceil(rows / cap)``) plus the empty page that ends it (an
    exact multiple still needs the empty page)."""
    return -(-rows // cap) + 1


@pytest.mark.parametrize("cap", D9_CAPS)
def test_a2_the_double_caps_at_max_rows_like_postgrest_and_records_only_the_caps_cuts(cap):
    """The plant is real before anything is asserted on it, at EVERY cap:
    cap+1 rows answer cap with no error; a caller's own limit is not a
    cap; an offset in the query string pages past it; a limit above the
    cap is capped and recorded. (The earlier form of this test pinned
    MAX_ROWS == PAGE_ROWS == 1000 — a test that reds when an operator
    toggles the knob CLAUDE.md tells them to toggle; TC-11.)"""
    double = PostgrestDouble(max_rows=cap)
    assert double.MAX_ROWS == cap
    for i in range(cap + 1):
        double.add("organizations", {"id": "o-%04d" % i, "name": "N%04d" % i})
    assert len(double.select("organizations", order="id.asc")) == cap
    assert double.truncations == [("organizations", cap + 1, cap)]
    assert len(double.select("organizations", order="id.asc", limit=5)) == 5
    assert len(double.truncations) == 1, "a caller's own limit is not the cap's cut"
    page2 = double.select("organizations", order="id.asc", limit=RT.PAGE_ROWS,
                          filters={"offset": str(cap)})
    assert [r["id"] for r in page2] == ["o-%04d" % cap]
    assert len(double.select("organizations", order="id.asc", limit=cap * 2)) == cap
    assert double.truncations[-1] == ("organizations", cap + 1, cap)
    with pytest.raises(httpx.HTTPStatusError):
        double.select("organizations", filters={"no_such_column": "eq.1"})


def test_a2_select_all_walks_an_ordered_page_sequence_and_refuses_an_unordered_one():
    from engine.api import _paging
    double = PostgrestDouble()
    for i in range(2500):
        double.add("firm_covenants", {"org_id": "org-%04d" % (i % 7), "covenant_id": "c%d" % i})
    rows = RT.select_all(double, "firm_covenants", order="org_id.asc,id.asc",
                         filters={"org_id": RT._in_filter(["org-%04d" % i for i in range(7)])})
    assert len(rows) == 2500 and len(set(r["id"] for r in rows)) == 2500
    # Three pages of rows and the EMPTY fourth that ends the walk.
    assert double.pages("firm_covenants") == [None, "1000", "2000", "2500"], double.pages("firm_covenants")
    # At the default cap the walk's own limit equals it, so the double records
    # no CAP cut (a caller's limit is not the cap's) — the offsets above are
    # the proof the walk went past 1000, twice.
    assert double.truncations == []
    with pytest.raises(ValueError):
        RT.select_all(double, "firm_covenants", order="")
    # A failing page is a PageWalkError carrying the rows that DID answer.
    flaky = PostgrestDouble()
    for i in range(1500):
        flaky.add("firm_covenants", {"org_id": "org-1", "covenant_id": "c%d" % i})
    real = flaky.select

    def second_page_503(table, **kw):
        if (kw.get("filters") or {}).get("offset") == "1000":
            raise postgrest_error(503, "PGRST001", "transient", table)
        return real(table, **kw)
    flaky.select = second_page_503
    with pytest.raises(RT.PageWalkError) as caught:
        RT.select_all(flaky, "firm_covenants", order="id.asc")
    assert len(caught.value.rows_read) == 1000 and caught.value.pages_read == 1
    assert "page 2" in str(caught.value) and "1000 row" in str(caught.value)
    assert RT.classify_read_error(caught.value)[0] == "other"
    # A runaway walk stops and SAYS it is incomplete; never infinite, never silent.
    small = PostgrestDouble()
    for i in range(5):
        small.add("organizations", {"id": "o-%d" % i, "name": "n"})
    notices = []  # type: List[str]
    original = _paging.MAX_PAGES
    _paging.MAX_PAGES = 2
    try:
        got = RT.select_all(small, "organizations", order="id.asc", page_rows=1, notices=notices)
    finally:
        _paging.MAX_PAGES = original
    assert len(got) == 2 and notices and "INCOMPLETE" in notices[0], notices


@pytest.mark.parametrize("cap", D9_CAPS)
def test_d9_twelve_hundred_clients_appear_at_every_cap(monkeypatch, fresh_cache, capsys, cap):
    """1,200 organizations, 1,200 period rows, the deployment's cap at 37,
    500 or 1000: BOTH list reads exceed it. A walk that stops on a SHORT
    page stops after the first page the day the cap is below the page
    size it asks for (D9: 500 clients on the board, one page, no notice).
    Every client appears, every client's one period row is read, every
    in.() filter is chunked, the cap cuts nothing, and the walk's request
    count is exactly the pages the cap dictates plus the empty page.
    TC-11 — after D9 this reds on: a client or a period row missing at any
    cap; a walk that issues more or fewer requests than the cap dictates;
    an in.() filter above IN_CHUNK; a heavy read on a detached book; and
    any notice about the organizations read on a book that read cleanly."""
    n = 1200
    double = _detached_book(n, 1, max_rows=cap)
    client = _app(monkeypatch, double)
    t0 = time.perf_counter()
    board = _board(client, A2_AS_OF)
    ms = (time.perf_counter() - t0) * 1000.0
    assert board["counts"]["clients"] == n and len(board["clients"]) == n, (
        "D9 CLIENTS LOST — %d of %d clients on the board at db-max-rows = %d (the walk "
        "stopped on a short page, or never paged)" % (len(board["clients"]), n, cap))
    assert sorted(r["client_id"] for r in board["clients"]) == ["org-%04d" % i for i in range(n)]
    short = [(r["client_id"], _period_rows_seen(r)) for r in board["clients"]
             if _period_rows_seen(r) != 1]
    assert not short, "D9 PERIODS LOST — clients whose period row was not read: %s" % short[:5]
    # Below the page size the cap is LIVE — it cut the first organizations
    # page — and not one row is missing: that is the claim. At the default
    # cap the walk's own limit equals it (no recorded cut); the page offsets
    # below are the proof the walk went past it either way.
    if cap < RT.PAGE_ROWS:
        assert double.truncations and double.truncations[0] == ("organizations", n, cap), (
            "the cap never fired at %d — nothing was proven: %s" % (cap, double.truncations[:3]))
    org_pages = double.pages("organizations")
    assert len(org_pages) == _pages_for(n, cap), (cap, org_pages)
    assert org_pages[0] is None and org_pages[-1] == str(n), org_pages
    period_pages = double.pages("financial_periods")
    chunks = (n + RT.IN_CHUNK - 1) // RT.IN_CHUNK
    assert period_pages.count(None) == chunks, period_pages
    assert len(period_pages) == chunks * _pages_for(RT.IN_CHUNK, cap), (cap, len(period_pages))
    assert max(double.in_list_sizes()) <= RT.IN_CHUNK, max(double.in_list_sizes())
    assert double.heavy_reads() == {"envelope": 0, "period_full": 0, "line_items": 0}
    assert not [x for x in board["notices"] if "INCOMPLETE" in x or "organizations" in x], board["notices"]
    with capsys.disabled():
        print("\n[D9] cap %d: %d clients x 1 detached period through the route: %.0f ms, %d light "
              "reads (organizations in %d requests, financial_periods in %d chunks x %d), cap "
              "cuts = %d" % (cap, n, ms, len(double.selects()), len(org_pages), chunks,
                             _pages_for(RT.IN_CHUNK, cap), len(double.truncations)))


@pytest.mark.parametrize("cap", D9_CAPS)
def test_d9_hundred_clients_twelve_periods_lose_no_period_at_every_cap(monkeypatch, fresh_cache, cap):
    """The critics' exact shape: 100 clients x PERIODS_PER_CLIENT = 1,200
    period rows behind one in.() filter, at every cap. Unpaged, the
    oldest rows — months of EVERY client — were silently gone and every
    client row on the board changed. Paged, every client's twelve rows
    are read whatever the cap."""
    n, per = 100, RT.PERIODS_PER_CLIENT
    double = _detached_book(n, per, max_rows=cap)
    assert len(double.rows("financial_periods")) == n * per > cap
    board = _board(_app(monkeypatch, double), A2_AS_OF)
    assert len(board["clients"]) == n
    seen = dict((r["client_id"], _period_rows_seen(r)) for r in board["clients"])
    short = dict((k, v) for k, v in seen.items() if v != per)
    assert not short, (
        "D9 PERIODS LOST at cap %d — %d client(s) had fewer than %d period rows read: %s"
        % (cap, len(short), per, sorted(short.items())[:5]))
    if cap < RT.PAGE_ROWS:
        assert ("financial_periods", n * per, cap) in double.truncations, (
            "the cap never fired at %d — nothing was proven: %s" % (cap, double.truncations[:3]))
    period_pages = double.pages("financial_periods")
    assert len(period_pages) == _pages_for(n * per, cap), (cap, period_pages)
    assert not [x for x in board["notices"] if "INCOMPLETE" in x], board["notices"]


def test_a2_the_cap_is_visible_when_a_read_is_not_paged():
    """Counter-plant, in memory: the same 1,200-row book through ONE
    unpaged select is exactly the silent loss the double reproduces —
    1,000 of 1,200 rows, no error. This is the mechanism the gates above
    red on."""
    double = _detached_book(100, RT.PERIODS_PER_CLIENT, max_rows=1000)
    rows = double.select("financial_periods", columns=RT.LIGHT_PERIOD_COLUMNS,
                         order=RT.PERIOD_ORDER)
    assert len(rows) == 1000 and double.truncations == [("financial_periods", 1200, 1000)]
    lost = set("org-%04d" % i for i in range(100)) - set(r["org_id"] for r in rows)
    grouped = RT.group_periods(rows)
    assert lost == set() and min(len(v) for v in grouped.values()) == 10, (
        "the cut falls on the two oldest months of every client")


def test_d8_the_suppressions_route_serves_every_row_past_the_cap(monkeypatch, fresh_cache):
    """GET /api/firm/attention/suppressions: 1,001 suppressions were 1,000
    through a bare select, no notice (critic D8). Every row, at the cap
    an operator may set. Each suppression's client is a live workspace of
    the caller's own (firm_id null), so the route's era pin keeps it.
    TC-11 — reds on a suppression missing at cap 500, on a duplicate id,
    on any notice, on the cap not firing, and on a walk with any other
    request sequence than the pages the cap dictates plus the empty one."""
    cols = firm_table_columns()[RT.TABLE_SUPPRESSIONS]
    double = PostgrestDouble(max_rows=500)
    for i in range(1001):
        double.add("organizations", {"id": "org-%04d" % i, "name": "C%04d" % i})
        double.add(RT.TABLE_SUPPRESSIONS, dict(
            (k, v) for k, v in {"org_id": "org-%04d" % i, "kind": "MISSING_FILE", "scope_key": "*",
                                "reason": "r", "dismissed_by": "u",
                                "dismissed_at": "2026-01-01T00:00:%02dZ" % (i % 60)}.items()
            if k in cols))
    client = _app(monkeypatch, double)
    r = client.get("/api/firm/attention/suppressions", headers=AUTH)
    assert r.status_code == 200, r.text[:300]
    body = r.json()
    assert len(body["suppressions"]) == 1001, (
        "D8 SUPPRESSIONS LOST — %d of 1001 served" % len(body["suppressions"]))
    assert len(set(s["id"] for s in body["suppressions"])) == 1001
    assert body["notices"] == []
    assert double.truncations[0] == (RT.TABLE_SUPPRESSIONS, 1001, 500), "the cap never fired"
    assert double.pages(RT.TABLE_SUPPRESSIONS) == [None, "500", "1000", "1001"]


# ══════════════════════════════════════════════════════════════════════
# 6. A1 / D6 in the ROUTE's shape — a dead model registry: the board is
#    the SAME board, plus one notice that names the registry
# ══════════════════════════════════════════════════════════════════════

_STRIPPED_ENV = ("ANTHROPIC_API_KEY", "VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY",
                 "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "ENGINE_AI_MODELS_PATH")

_ROUTE_UNDER_REGISTRY = r"""
import json, sys
from fastapi import FastAPI
from fastapi.testclient import TestClient
from engine.api import _firm_attention as RT
from engine.api import _org
import firm_postgrest_double as D
def ai(): return sorted(m for m in sys.modules if m == 'anthropic' or m.startswith('anthropic.') or m.startswith('engine.ai'))
class _MP(object):
    def setattr(self, obj, name, value): setattr(obj, name, value)
with open(%(fixture)r, encoding='utf-8') as fh:
    case = json.load(fh)
double = D.PostgrestDouble()
D.seed_client(double, 'org-agras', 'Agras SA', case, ['2025-12-31'])
D.install(_MP(), double)
_org.resolve_user_id = lambda jwt: 'user-double'
app = FastAPI(); app.include_router(RT.build_router())
r = TestClient(app).get('/api/firm/attention?as_of=2026-01-10', headers={'Authorization': 'Bearer t'})
body = r.json() if r.status_code == 200 else {'text': r.text[:400]}
rows = dict((row['client_id'], sorted(i['kind'] for i in row['items'])) for row in body.get('clients', []))
gaps = dict((row['client_id'], sorted(g['reason'] for g in row['gaps'])) for row in body.get('clients', []))
print(json.dumps({'status': r.status_code, 'rows': rows, 'gaps': gaps, 'after_request': ai(),
                  'pipeline_loaded': 'engine.api.pipeline' in sys.modules,
                  'notices': body.get('notices'), 'text': body.get('text')}))
"""


def _registry_without_the_role(tmp_path: Path) -> Path:
    import yaml
    raw = yaml.safe_load((REPO / "src" / "engine" / "ai" / "models.yaml").read_text(encoding="utf-8"))
    del raw["roles"]["reconcile_proposal"]
    path = tmp_path / "models_missing_reconcile_proposal.yaml"
    path.write_text(yaml.safe_dump(raw, sort_keys=False), encoding="utf-8")
    return path


def _route_under(registry_path: Optional[Path]) -> Dict[str, Any]:
    import os
    import subprocess
    import sys
    env = dict((k, v) for k, v in os.environ.items() if k not in _STRIPPED_ENV)
    env["PYTHONPATH"] = os.pathsep.join([str(REPO / "src"), str(REPO / "tests" / "engine")])
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    if registry_path is not None:
        env["ENGINE_AI_MODELS_PATH"] = str(registry_path)
    code = _ROUTE_UNDER_REGISTRY % {"fixture": str(FIXTURES / "saga_10_col_agras.json")}
    proc = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True,
                          env=env, timeout=240, cwd=str(REPO))
    assert proc.returncode == 0, proc.stderr[-2000:]
    return json.loads(proc.stdout.strip().splitlines()[-1])


def test_a1_route_answers_the_same_board_under_a_dead_registry_plus_one_notice_naming_it(
        tmp_path, capsys):
    """The route in a fresh process whose models.yaml lacks the
    `reconcile_proposal` role, against the SAME route in a fresh process
    with the real registry. Before A1 the first served read imported
    _reconcile, which read the registry at import: every client a 500.
    After A1 (and before D6) the statements rebuild — engine.api.pipeline,
    whose import graph read the registry at import — was stated absent on
    every period, and the earlier form of this test PINNED that absence as
    its law (TC-11). Now (D6) pipeline reads the registry at first AI use:
    the SAME rows, the SAME gaps (none about a provider), and exactly ONE
    notice more, the registry's own error, naming the file and the role.
    Non-vacuous: the healthy run carries no such notice. TC-11 — after D6
    this reds on: a 500; any row or gap that differs between the two runs
    (a rebuild that stops running, a provider that raises again); a dead
    registry stated zero times or twice; the anthropic SDK on the request."""
    healthy = _route_under(None)
    dead = _route_under(_registry_without_the_role(tmp_path))
    with capsys.disabled():
        print("\n[A1/route] healthy: HTTP %s rows=%s notices=%d | dead registry (missing role): "
              "HTTP %s rows=%s notices=%d, AI modules after the request = %d"
              % (healthy["status"], healthy["rows"], len(healthy["notices"] or []),
                 dead["status"], dead["rows"], len(dead["notices"] or []),
                 len(dead["after_request"])))
    assert healthy["status"] == 200 and dead["status"] == 200, (
        "A1 BOARD DEAD (route) — HTTP %s under a registry missing one role: %s"
        % (dead["status"], dead["text"]))
    assert "CASH_RUNWAY" in healthy["rows"]["org-agras"], "vacuous: the healthy board has no items"
    assert dead["rows"] == healthy["rows"], (
        "D6 — the dead registry changed the board's items: healthy %s, dead %s"
        % (healthy["rows"], dead["rows"]))
    assert dead["gaps"] == healthy["gaps"], (dead["gaps"], healthy["gaps"])
    assert not [g for g in dead["gaps"]["org-agras"] if "provider raised" in g or "RegistryError" in g], (
        "D6 — a provider still raises under a dead registry: %s" % dead["gaps"])
    healthy_notices = healthy["notices"] or []
    dead_notices = dead["notices"] or []
    assert not [n for n in healthy_notices if "model registry" in n], healthy_notices
    extra = [n for n in dead_notices if n not in healthy_notices]
    assert len(extra) == 1 and len(dead_notices) == len(healthy_notices) + 1, (
        "D6 — expected exactly one notice more than the healthy board, got %s" % dead_notices)
    assert "model registry" in extra[0] and "reconcile_proposal" in extra[0] and "RegistryError" in extra[0], extra
    assert not [m for m in dead["after_request"] if m == "anthropic" or m.startswith("anthropic.")], (
        dead["after_request"])


# ══════════════════════════════════════════════════════════════════════
# 7. D7 — one period's envelope read raising is a gap WITH ITS CAUSE on
#    that client; the other client is complete; the board is 200
# ══════════════════════════════════════════════════════════════════════


def test_d7_a_503_on_one_periods_envelope_read_is_a_gap_on_that_client_never_the_board(
        monkeypatch, fresh_cache, cases):
    """The critics' P3: a PostgREST 503 on the envelope select of ONE
    carniprod period was HTTP 500 for the whole board, agras included —
    facts.py's envelope read was the one provider its two siblings had
    wrapped and it had not. Now: 200; agras is the SAME row as on a
    healthy board; carniprod names the 503 on its gap, and the money
    kinds that need the envelope are absent, not zero. TC-11 — after D7
    this reds on: a 500; an agras row that differs from the healthy one;
    a CASH_RUNWAY computed from an envelope that never loaded; a gap that
    does not name the provider and the 503."""
    def world() -> PostgrestDouble:
        d = PostgrestDouble()
        seed_client(d, "org-agras", "Agras", cases["saga_10_col_agras"], ["2025-12-31"])
        seed_client(d, "org-carni", "Carni", cases["saga_10_col_carniprod"], ["2025-12-31"])
        return d

    healthy = _board(_app(monkeypatch, world()), "2026-01-10")
    fresh_cache.clear()
    double = world()
    real_select = double.select

    def flaky(table, **kw):
        f = kw.get("filters") or {}
        if (table == "financial_periods" and kw.get("columns") == "id,assembled_canonical_v1"
                and f.get("id") == "eq.org-carni:2025-12-31"):
            raise postgrest_error(503, "PGRST001",
                                  "Could not query the database for the schema cache. Retrying.",
                                  table)
        return real_select(table, **kw)
    double.select = flaky
    client = _app(monkeypatch, double, raise_server_exceptions=False)
    r = client.get("/api/firm/attention?as_of=2026-01-10", headers=AUTH)
    assert r.status_code == 200, (
        "D7 BOARD DEAD — one period's envelope read raised and the whole board answered HTTP "
        "%d: %s" % (r.status_code, r.text[:300]))
    board = r.json()
    assert _row(board, "org-agras") == _row(healthy, "org-agras"), (
        "D7 — agras changed because carniprod's read failed")
    carni = _row(board, "org-carni")
    assert "CASH_RUNWAY" in [i["kind"] for i in _row(healthy, "org-carni")["items"]], "vacuous"
    assert "CASH_RUNWAY" not in [i["kind"] for i in carni["items"]], (
        "D7 — a money item was computed from an envelope that never loaded")
    stated = [g["reason"] for g in carni["gaps"]
              if "envelope provider raised" in g["reason"] and "503" in g["reason"]]
    assert stated, "D7 — the failed read is not stated with its cause: %s" % carni["gaps"]


# ══════════════════════════════════════════════════════════════════════
# 8. D10 — the organizations read widens on ONE error only
# ══════════════════════════════════════════════════════════════════════


def _archived_book(n: int, archived: int, max_rows: Optional[int] = None) -> PostgrestDouble:
    double = _detached_book(n, 1, max_rows=max_rows)
    for r in double.rows("organizations")[:archived]:
        r["archived_at"] = "2025-06-01T00:00:00Z"
    return double


def _fail_nth_filtered_page(double: PostgrestDouble, nth: int) -> Dict[str, int]:
    """Make the ``nth`` request of the ARCHIVE-FILTERED organizations walk
    answer 503, once. Keyed on the request count, not on an offset value,
    so the plant fires at any cap."""
    real = double.select
    state = {"filtered_requests": 0, "fired": 0}

    def once(table, **kw):
        f = kw.get("filters") or {}
        if table == "organizations" and f.get("archived_at") == "is.null":
            state["filtered_requests"] += 1
            if state["filtered_requests"] == nth and not state["fired"]:
                state["fired"] += 1
                raise postgrest_error(503, "PGRST001", "transient", table)
        return real(table, **kw)
    double.select = once
    return state


@pytest.mark.parametrize("cap", (500, 1000))
def test_d10_a_transient_503_on_page_two_admits_no_archived_client_and_states_the_count(
        monkeypatch, fresh_cache, cap):
    """The critics' P9: 1,200 organizations, 200 archived; the second page
    of the archive-filtered read 503s. The old catch-all re-read WITHOUT
    the filter: 1,200 clients on the board, 200 of them archived, notices
    []. Now: exactly the clients the first page answered, ZERO archived,
    and a notice that says how many were read and why the walk stopped.
    TC-11 — after D10 this reds on: any archived client on the board; a
    client count other than the first page's; a missing or wrong notice;
    an unfiltered re-read; the plant not firing."""
    double = _archived_book(1200, 200, max_rows=cap)
    state = _fail_nth_filtered_page(double, 2)
    board = _board(_app(monkeypatch, double), A2_AS_OF)
    assert state["fired"] == 1, "the plant never fired — nothing was proven"
    on_board = [r["client_id"] for r in board["clients"]]
    archived_ids = set(r["id"] for r in double.rows("organizations") if r["archived_at"])
    archived_on_board = [c for c in on_board if c in archived_ids]
    assert archived_on_board == [], (
        "D10 WIDENED — %d archived clients on the board after a transient failure "
        "(the organizations read fell back to an unfiltered re-read)" % len(archived_on_board))
    assert len(on_board) == cap, (
        "D10 — expected exactly the %d clients the first page answered, got %d"
        % (cap, len(on_board)))
    notice = [n for n in board["notices"] if n.startswith("organizations:")]
    assert len(notice) == 1 and "page 2" in notice[0] and ("%d client(s)" % cap) in notice[0] \
        and "INCOMPLETE" in notice[0] and "no archived client admitted" in notice[0], board["notices"]
    assert state["filtered_requests"] == 2, state
    unfiltered = [c[2] for c in double.selects("organizations") if c[2].get("archived_at") != "is.null"]
    assert unfiltered == [], "D10 — an unfiltered re-read was issued: %s" % unfiltered


def test_d10_a_503_on_the_first_page_is_an_empty_incomplete_board_never_a_widened_one(
        monkeypatch, fresh_cache):
    double = _archived_book(50, 10)
    state = _fail_nth_filtered_page(double, 1)
    board = _board(_app(monkeypatch, double), A2_AS_OF)
    assert state["fired"] == 1
    assert board["clients"] == [], board["counts"]
    notice = [n for n in board["notices"] if n.startswith("organizations:")]
    assert len(notice) == 1 and "page 1" in notice[0] and "0 client(s)" in notice[0], board["notices"]
    assert state["filtered_requests"] == 1 and double.selects("organizations") == [], (
        "D10 — an unfiltered re-read was issued: %s" % [c[2] for c in double.selects("organizations")])


def test_d10_the_pre_archive_schema_is_the_one_widening_and_it_says_so(monkeypatch, fresh_cache):
    """A schema without `archived_at` answers 42703 on the FIRST page — the
    one case the unfiltered re-read exists for. Every client is read and
    the notice names the reason; nothing archived can exist."""
    double = _detached_book(30, 1)
    double.columns["organizations"] = [c for c in double.columns["organizations"] if c != "archived_at"]
    board = _board(_app(monkeypatch, double), A2_AS_OF)
    assert len(board["clients"]) == 30
    notice = [n for n in board["notices"] if n.startswith("organizations:")]
    assert len(notice) == 1 and "pre-archive schema" in notice[0] and "42703" in notice[0], board["notices"]
    assert [c[2].get("archived_at") for c in double.selects("organizations")] == ["is.null", None, None]


def test_d10_the_periods_read_failing_for_a_chunk_leaves_those_clients_off_with_a_notice(
        monkeypatch, fresh_cache):
    """The same law one read down: when a chunk's period list does not
    answer, its clients are NOT graded MISSING_FILE against a read that
    never happened — they are left off, named by count, with the cause."""
    double = _detached_book(250, 1)
    real = double.select
    state = {"fired": 0}

    def flaky(table, **kw):
        f = kw.get("filters") or {}
        if table == "financial_periods" and '"org-0150"' in (f.get("org_id") or "") and not state["fired"]:
            state["fired"] += 1
            raise postgrest_error(503, "PGRST001", "transient", table)
        return real(table, **kw)
    double.select = flaky
    board = _board(_app(monkeypatch, double), A2_AS_OF)
    assert state["fired"] == 1
    on_board = sorted(r["client_id"] for r in board["clients"])
    assert len(on_board) == 150 and "org-0150" not in on_board and "org-0199" not in on_board, len(on_board)
    notice = [n for n in board["notices"] if n.startswith("financial_periods:")]
    assert len(notice) == 1 and "100 client(s)" in notice[0] and "150 of 250" in notice[0] \
        and "503" in notice[0], board["notices"]
    assert all(_period_rows_seen(r) == 1 for r in board["clients"])


# ══════════════════════════════════════════════════════════════════════
# 9. D8 / D11 — the CENSUS: no list read outside the page walk, in any
#    _firm* module (AST, not grep); reds by file:line
# ══════════════════════════════════════════════════════════════════════

API_DIR = REPO / "src" / "engine" / "api"
PAGING = API_DIR / "_paging.py"


def _select_calls(source: str, filename: str) -> List[Tuple[int, bool, str]]:
    """Every ``<recv>.select(`` call: (line, bounded, enclosing function).
    A read is BOUNDED when it carries ``single=True`` or a ``limit=``
    keyword — ``limit=1`` is a single-row read, an explicit batch limit is
    the caller's own bound (``limit=60``, ``limit=limit``). Anything else
    is a list read and belongs in the walk."""
    import ast
    tree = ast.parse(source, filename=filename)
    parents = {}  # type: Dict[Any, Any]
    for node in ast.walk(tree):
        for child in ast.iter_child_nodes(node):
            parents[child] = node
    out = []  # type: List[Tuple[int, bool, str]]
    for node in ast.walk(tree):
        if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                and node.func.attr == "select"):
            continue
        bounded = False
        for kw in node.keywords:
            if kw.arg == "limit":
                bounded = True
            if kw.arg == "single" and isinstance(kw.value, ast.Constant) and kw.value.value is True:
                bounded = True
        func = "<module>"
        cur = parents.get(node)
        while cur is not None:
            if isinstance(cur, (ast.FunctionDef, ast.AsyncFunctionDef)):
                func = cur.name
                break
            cur = parents.get(cur)
        out.append((node.lineno, bounded, func))
    return out


def test_d11_census_every_list_read_of_a_firm_module_goes_through_the_page_walk():
    """AST over engine/api/_firm*.py and _paging.py: the ONE unbounded
    ``.select(`` allowed is inside ``_paging.select_all``. An unbounded
    select anywhere else is a read the cap cuts silently — reds by
    file:line. Not vacuous: the walk found >= 20 selects, the walk's own
    is present, and a planted bare read reds (test below). TC-11 — after
    D8/D11 this reds on: a new bare list read in any _firm* module; the
    walk's own read moving out of select_all; a census that finds fewer
    than 20 selects (a broken walk)."""
    offenders = []  # type: List[str]
    total = 0
    walk_reads = 0
    for path in sorted(API_DIR.glob("_firm*.py")) + [PAGING]:
        for line, bounded, func in _select_calls(path.read_text(encoding="utf-8"), str(path)):
            total += 1
            if path == PAGING and func == "select_all":
                walk_reads += 1
                continue
            if not bounded:
                offenders.append("%s:%d in %s()" % (path.name, line, func))
    assert total >= 20, "the census walk collapsed: %d selects" % total
    assert walk_reads == 1, "the page walk's own read is not where the census expects it"
    assert not offenders, (
        "D11 UNPAGED LIST READ — a bare .select( of a list outside engine.api._paging.select_all "
        "(PostgREST caps it at db-max-rows, silently); route it through select_all with a total "
        "order, or bound it with limit=/single=True on purpose:\n  " + "\n  ".join(offenders))


def test_d11_census_is_not_vacuous_on_a_planted_bare_read():
    planted = ("def f(client):\n    rows = client.select('firm_covenants', filters={})\n"
               "    one = client.select('firms', filters={}, limit=1)\n"
               "    batch = client.select('q', limit=limit)\n"
               "    only = client.select('x', single=True)\n"
               "def select_all(client):\n    return client.select('t')\n")
    calls = _select_calls(planted, "planted.py")
    assert [(l, b) for l, b, _f in calls] == [(2, False), (3, True), (4, True), (5, True), (7, False)], calls
    assert calls[0][2] == "f" and calls[-1][2] == "select_all"


# ══════════════════════════════════════════════════════════════════════
# 10. D11 — the SIBLINGS cover 1,200 clients: the firm's client list (the
#     wall under require_client), the digest cron, the brief
# ══════════════════════════════════════════════════════════════════════

FIRM_ID = "firm-x"
FIRM_USER = "user-firm-owner"
D11_CLIENTS = 1200
FIRM_MEMBERSHIP_COLUMNS = {"firm_memberships": ["firm_id", "user_id", "role", "created_at",
                                                "updated_at"]}


def _firm_book(n: int, cap: int) -> PostgrestDouble:
    """A firm with ``n`` attached clients, one owner, one open file request
    per client; every list the crons and the brief read exceeds ``cap``."""
    double = PostgrestDouble(columns=FIRM_MEMBERSHIP_COLUMNS, max_rows=cap)
    double.add("firm_memberships", {"firm_id": FIRM_ID, "user_id": FIRM_USER, "role": "owner"})
    cols = firm_table_columns()["firm_file_requests"]
    for i in range(n):
        org = "org-%04d" % i
        double.add("organizations", {"id": org, "name": "Client %04d" % i, "firm_id": FIRM_ID})
        double.add("firm_file_requests", dict((k, v) for k, v in {
            "firm_id": FIRM_ID, "client_org_id": org, "period_end": "2025-12-31",
            "requested_by": FIRM_USER, "requested_at": "2026-01-02T10:00:00+00:00",
            "expires_at": "2026-03-01T10:00:00+00:00", "token_hash": "h%04d" % i,
            "to_email": "c%04d@x.test" % i, "status": "requested", "reminder_count": 0,
            "reminders_sent": [], "refusal_count": 0}.items() if k in cols))
    return double


def _install_firm(monkeypatch, double: PostgrestDouble) -> None:
    from engine.api import _org, _supabase
    monkeypatch.setattr(_supabase, "admin", lambda: double)
    monkeypatch.setattr(_supabase, "per_user", lambda jwt: double)
    monkeypatch.setattr(_org, "resolve_user_id", lambda jwt: FIRM_USER)


def test_d11_the_firms_client_list_and_the_wall_under_it_cover_1200_clients(monkeypatch):
    """`_firm.client_org_ids` answered 1,000 of 1,200 (critic P10) — and it
    is the set `require_client` checks membership against, so client
    #1,001 was "Not a client of this firm" to its own firm. TC-11 — after
    D11 this reds on: a client missing from the list at cap 500; a walk
    with any other request sequence; the wall refusing the firm's own
    client #1,151; the wall admitting a stranger."""
    from engine.api import _firm
    double = _firm_book(D11_CLIENTS, cap=500)
    _install_firm(monkeypatch, double)
    ids = _firm.client_org_ids(FIRM_ID)
    assert len(ids) == D11_CLIENTS and len(set(ids)) == D11_CLIENTS, (
        "D11 CLIENTS LOST — client_org_ids answered %d of %d" % (len(ids), D11_CLIENTS))
    assert double.truncations[0] == ("organizations", D11_CLIENTS, 500), "the cap never fired"
    assert double.pages("organizations") == [None, "500", "1000", "1200"]
    ctx = _firm.FirmContext(FIRM_USER, FIRM_ID, "owner")
    assert _firm.require_client(ctx, "org-1150") == "org-1150", (
        "D11 — the wall refused the firm's own client #1,151")
    with pytest.raises(_firm.HTTPException):
        _firm.require_client(ctx, "org-9999")


def test_d11_the_digest_cron_enumerates_1200_clients(monkeypatch, capsys):
    """run_digest_cron over a 1,200-client firm at db-max-rows = 500,
    through the REAL report provider: the board it computes has 1,200
    rows and the open-request read it folds in carries 1,200 distinct
    clients — counted as clients, not rows."""
    from datetime import datetime, timezone
    from engine.api import _firm_requests as FR
    double = _firm_book(D11_CLIENTS, cap=500)
    _install_firm(monkeypatch, double)
    double.add("firm_digest_prefs", {"user_id": FIRM_USER, "firm_id": FIRM_ID, "enabled": True,
                                     "frequency": "daily", "send_hour_utc": 0,
                                     "last_item_ids": []})
    real_provider = FR.default_report_provider(lambda: double, firm_id=FIRM_ID)
    seen = {"ids": [], "report_rows": 0, "request_clients": set()}  # type: Dict[str, Any]

    def counting_provider(ids, as_of):
        seen["ids"] = list(ids)
        report = real_provider(ids, as_of)
        seen["report_rows"] = len(report.rows)
        return report

    real_items = FR.open_request_items

    def counting_items(rows, names, as_of):
        seen["request_clients"] = set(str(r.get("client_org_id")) for r in rows)
        return real_items(rows, names, as_of)
    monkeypatch.setattr(FR, "open_request_items", counting_items)
    t0 = time.perf_counter()
    out = FR.run_digest_cron(date(2026, 1, 10), datetime(2026, 1, 10, 9, 0, tzinfo=timezone.utc),
                             double, report_provider=counting_provider,
                             email_of=lambda uid: "owner@x.test", app_url="http://app.test")
    ms = (time.perf_counter() - t0) * 1000.0
    with capsys.disabled():
        print("\n[D11] digest cron over %d clients at cap 500: %d ids, %d board rows, %d request "
              "clients, %s, %.0f ms" % (D11_CLIENTS, len(seen["ids"]), seen["report_rows"],
                                         len(seen["request_clients"]), out, ms))
    assert out["prefs"] == 1 and out["queued"] == 1, out
    assert len(seen["ids"]) == D11_CLIENTS, (
        "D11 CLIENTS LOST — the digest enumerated %d of %d clients" % (len(seen["ids"]), D11_CLIENTS))
    assert seen["report_rows"] == D11_CLIENTS
    assert len(seen["request_clients"]) == D11_CLIENTS, (
        "D11 — the open-request read covered %d of %d clients" % (len(seen["request_clients"]), D11_CLIENTS))
    assert double.truncations and double.truncations[0][0] == "organizations", "the cap never fired"
    assert max(double.in_list_sizes()) <= RT.IN_CHUNK


def test_d11_the_brief_route_enumerates_1200_clients(monkeypatch, capsys):
    """POST /api/firm/brief over the same firm: the ids the brief is
    composed for and the open-request read behind it both cover 1,200
    clients. The model is never called: compose_brief is replaced by a
    stub that records what it was handed."""
    from engine.api import _firm_brief as FB
    from engine.api import _firm_requests as FR
    double = _firm_book(D11_CLIENTS, cap=500)
    _install_firm(monkeypatch, double)
    seen = {"names": {}, "request_clients": set(), "items": 0}  # type: Dict[str, Any]
    real_items = FR.open_request_items

    def counting_items(rows, names, as_of):
        seen["request_clients"] = set(str(r.get("client_org_id")) for r in rows)
        return real_items(rows, names, as_of)
    monkeypatch.setattr(FR, "open_request_items", counting_items)

    def stub_compose(items, as_of, firm_key, user_id="", store=None, force=False,
                     client_names=None, kind_order=None, **_kw):
        seen["names"] = dict(client_names or {})
        seen["items"] = len(items)
        return {"stub": True, "firm_key": firm_key, "clients": len(client_names or {})}
    monkeypatch.setattr(FB, "compose_brief", stub_compose)
    app = FastAPI()
    app.include_router(FB.build_router())
    t0 = time.perf_counter()
    r = TestClient(app).post("/api/firm/brief", headers=AUTH,
                             json={"firm_id": FIRM_ID, "as_of": "2026-01-10"})
    ms = (time.perf_counter() - t0) * 1000.0
    assert r.status_code == 200, r.text[:300]
    with capsys.disabled():
        print("\n[D11] brief route over %d clients at cap 500: %d client names, %d request clients, "
              "%d items, %.0f ms" % (D11_CLIENTS, len(seen["names"]), len(seen["request_clients"]),
                                     seen["items"], ms))
    assert r.json()["clients"] == D11_CLIENTS
    assert len(seen["names"]) == D11_CLIENTS, (
        "D11 CLIENTS LOST — the brief was composed for %d of %d clients" % (len(seen["names"]), D11_CLIENTS))
    assert len(seen["request_clients"]) == D11_CLIENTS, len(seen["request_clients"])
    assert seen["items"] >= D11_CLIENTS, "vacuous: no item per client reached the brief"
    assert double.truncations and double.truncations[0][0] == "organizations", "the cap never fired"
    assert max(double.in_list_sizes()) <= RT.IN_CHUNK
