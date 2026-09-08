"""The Radar route: loading, tenancy, the dismissal round trip, the
incremental open, the explanation lane WIRED, and the F9 guard ACTIVE —
over the real serving layer and a PROJECTION-FAITHFUL client.

The client is `tests/engine/radar_fakes.ProjectingAdmin`: it honours
`columns=` exactly as PostgREST `select=` would, so the route is tested
on the rows its real projection returns and nothing more. The previous
double (`firm_fakes.FakeAdmin`) handed back whole rows whatever the
query asked for, and the route's rebuild read the envelope off a row
that never carried it in production — every test stayed green while the
served figures differed from the Capsule's on every corpus book
(design_review/radar/SERVE_GATES.md, A2). A fake that returns more than
the query asked for is the class of failure recorded under "fake stores
hid 20+ defects"; this suite is where that lesson lives for Radar.

What is asserted through the route:

  · the served figures are the Capsule's (the envelope is ON the row
    the rebuild seam reads, so the persisted reconciliation applies and
    statutory net income is account 121 — `saga_10_col_retail`:
    3,205,212.62, never the class-6/7 reconstruction 1,161,957.98);
  · the light projection names only columns `financial_periods` carries
    (there is no `period_label`; naming one is a PostgREST 400);
  · a dismissal is anchored on a PERIOD (id + period end): an earlier
    upload moves every ordinal and moves nothing about which periods it
    covers (the critic's exact sequence, A4);
  · explanations come from cache BEFORE the rows return and are drafted
    AFTER — the rows return with the model dead, sleeping, and hostile;
  · mounting the router installs the F9 numeral guard on the served
    path (a fresh interpreter, nothing else imported — B6).

Python 3.9 — no `match`, no `X | Y` unions.
"""

from __future__ import annotations

import ast
import copy
import json
import os
import re
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

from engine.ai import breaker
from engine.ai import finding_sharpen as FS
from engine.api import _org
from engine.api import _radar as RT
from engine.api import _supabase
from engine.radar import explain as X
from engine.radar import serve as RS
from engine.serving import FactsGateway
from tests.engine.radar_fakes import ProjectingAdmin
from tests.engine.test_radar_explain import (HIGH_REVIEW, GOOD_DRAFT, StubClient,
                                              _factory, _view_of, good_draft)

REPO = Path(__file__).resolve().parents[2]
FIXTURES = REPO / "tests" / "engine" / "fixtures" / "radar"
SCHEMA = REPO / "supabase" / "schema.sql"

CLOCK = "2026-09-04T10:00:00+00:00"
HEADERS = {"Authorization": "Bearer test", "X-Org-Id": "org-a"}
HEADERS_B = {"Authorization": "Bearer test", "X-Org-Id": "org-b"}

#: A GET must return its rows well inside this while a model is dead,
#: asleep or hostile. A cold serve measures ~0.1 s on this host.
ROWS_DEADLINE_S = 5.0


def fixture(case):
    with open(str(FIXTURES / (case + ".json")), encoding="utf-8") as fh:
        return json.load(fh)


def period_row(period_id, org_id, fx, period_end=None, doc_id=None):
    """A `financial_periods` row AS STORED — the JSON envelope column and
    the plain columns. The light aliases (`snapshot_hash`, `p121`, …) are
    NOT pre-set: the projection-faithful client derives them the way
    PostgREST does, which is the whole point."""
    end = period_end or fx["period_end"]
    return {
        "id": period_id, "org_id": org_id,
        "period_start": end[:4] + "-01-01", "period_end": end,
        "currency": fx["currency"], "source_document_id": doc_id or ("doc-" + period_id),
        "updated_at": "2026-01-02T10:00:00+00:00", "caen_code": None,
        "extraction_confidence": None,
        "assembled_canonical_v1": copy.deepcopy(fx["envelope"]),
    }


def line_item_rows(period_id, fx):
    return [dict(li, period_id=period_id) for li in fx["line_items"]]


def financial_periods_columns():
    """Every column `financial_periods` carries across the migrations:
    the create block in schema.sql plus every `alter table
    financial_periods … add column` in supabase/*.sql (`caen_code` came
    with phase 7, `assembled_canonical_v1` with F4.1e)."""
    source = SCHEMA.read_text(encoding="utf-8")
    start = source.index("create table if not exists financial_periods (")
    block = source[start:source.index(");", start)]
    declared = set(re.findall(r"^\s+([a-z_]+)\s+(?:uuid|date|text|numeric|timestamptz|jsonb|boolean|int)",
                              block, re.M))
    for path in sorted(SCHEMA.parent.glob("*.sql")):
        text = path.read_text(encoding="utf-8")
        for stmt in re.findall(r"alter\s+table\s+(?:public\.)?financial_periods\b(.*?);",
                               text, re.I | re.S):
            declared.update(re.findall(
                r"add\s+column\s+(?:if\s+not\s+exists\s+)?([a-z0-9_]+)", stmt, re.I))
    return declared


def p121_of(fx):
    cbs = (fx["envelope"].get("canonical_bs") or {})
    return float(((cbs.get("invariants") or {}).get("p121_cross_check") or {})["p121"])


@pytest.fixture(autouse=True)
def _isolated_ai_state(tmp_path, monkeypatch):
    """Never touch the real breaker counters, the real AI journal or the
    real explanation cache; never leave a draft in flight for the next
    test."""
    monkeypatch.setenv(breaker.STATE_DIR_ENV, str(tmp_path / "spend"))
    monkeypatch.setenv(FS.JOURNAL_DIR_ENV, str(tmp_path / "journal"))
    monkeypatch.setenv(X.CACHE_DIR_ENV, str(tmp_path / "explain_cache"))
    monkeypatch.delenv(FS.SPECIFICITY_FLOOR_ENV, raising=False)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_AUTH_TOKEN", raising=False)
    with RT._IN_FLIGHT_LOCK:
        RT._IN_FLIGHT.clear()
    yield
    with RT._IN_FLIGHT_LOCK:
        RT._IN_FLIGHT.clear()


@pytest.fixture()
def book():
    """Two workspaces: org-a with a 2025 period (agras) and a 2024 one
    (the same book, so the spine has history), org-b with one period —
    the retail book, which carries two CRITICAL leverage findings and
    the account-121 anchor that separates the statutory result from the
    reconstruction by a factor of 2.8."""
    agras = fixture("saga_10_col_agras")
    retail = fixture("saga_10_col_retail")
    tables = {
        "financial_periods": [
            period_row("p-a-2025", "org-a", agras),
            period_row("p-a-2024", "org-a", agras, period_end="2024-12-31"),
            period_row("p-b-2025", "org-b", retail),
        ],
        "statement_line_items": (line_item_rows("p-a-2025", agras)
                                 + line_item_rows("p-a-2024", agras)
                                 + line_item_rows("p-b-2025", retail)),
        "radar_dismissals": [],
        # CAEN lives HERE, on the org — `schema_phase7_benchmarks.sql`
        # put it here and not on `financial_periods`. org-b carries none,
        # so the route's fail-open path is exercised by a real fixture
        # rather than only asserted about.
        "organizations": [{"id": "org-a", "name": "Alpha SRL",
                           "caen_code": "1013"},
                          {"id": "org-b", "name": "Beta SRL",
                           "caen_code": None}],
    }
    return ProjectingAdmin(tables)


def _mount(book, monkeypatch, wiring=None):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    monkeypatch.setattr(_org, "resolve_org",
                        lambda jwt, requested=None: ("user-1", requested or "org-a"))
    monkeypatch.setattr(_supabase, "per_user", lambda jwt: book)
    # A fresh process cache per test: the module-level one survives across
    # tests by design (it survives across requests), and a hit from a
    # previous test would hide a load this test is counting.
    monkeypatch.setattr(RT, "_CACHE", RS.RadarCache())
    app = FastAPI()
    app.include_router(RT.build_router(clock=lambda: CLOCK, explain=wiring))
    return TestClient(app)


@pytest.fixture()
def client(book, monkeypatch):
    """Cache-only explanations, no background draft: the deterministic
    route, with the lane wired but idle."""
    return _mount(book, monkeypatch,
                  RT.ExplainWiring(store=X.MemoryExplainStore(), background=False))


def _line_item_reads(fake):
    return [c for c in fake.calls if c[0] == "select" and c[1] == "statement_line_items"]


def _period_selects(fake):
    return [c for c in fake.calls if c[0] == "select" and c[1] == "financial_periods"]


def stripped(payload):
    out = RS.strip_explanations(payload)
    out.pop("cache", None)
    out.pop("notices", None)
    return out


# ── shaping ──────────────────────────────────────────────────────────────


def test_the_spine_is_ordered_by_period_end_then_id_and_ordinals_are_stable():
    rows = [{"id": "z", "period_end": "2025-12-31"}, {"id": "a", "period_end": "2025-12-31"},
            {"id": "m", "period_end": "2024-12-31"}]
    assert [r["id"] for r in RT.order_periods(rows)] == ["m", "a", "z"]
    assert [r["id"] for r in RT.order_periods(list(reversed(rows)))] == ["m", "a", "z"]


def test_the_light_input_carries_the_content_hash_and_the_document_under_their_own_names(book):
    """The light row, AS PROJECTED: the content hash is the snapshot id
    (the id the FactsGateway stamps on every fact), the source document
    is under its own name, the key forms before anything heavy loads."""
    fx = fixture("saga_10_col_agras")
    light_rows = RT.list_light_periods(book, "org-a")
    row = [r for r in light_rows if r["id"] == "p-a-2025"][0]
    assert "assembled_canonical_v1" not in row, "the light listing loaded the envelope"
    assert row["p121"] == str(p121_of(fx)), "PostgREST renders ->> as text"
    light = RT.light_input(row, 4)
    hash_ = fx["envelope"]["provenance"]["content_hash"]
    assert light.snapshot_id == hash_ and light.content_key == hash_
    assert light.source_document_id == "doc-p-a-2025"
    assert light.engine_snapshot_id() == "doc-p-a-2025", (
        "the detectors are handed the source document, the Capsule's convention (R1)")
    assert light.statements is None and light.envelope is None
    assert light.ordinal == 4
    assert RS.snapshot_key(light) == "content:" + hash_
    # Without the alias (an older row, or a fake), the envelope's own
    # provenance answers; without that, updated_at keys the cache but
    # is NEVER a snapshot id.
    bare = dict(row)
    bare.pop("snapshot_hash")
    assert RT.content_key_of(bare) == row["updated_at"]
    assert RT.content_hash_of(bare) is None


def test_the_light_projection_names_only_columns_the_table_carries():
    """`financial_periods` has no `period_label` column (supabase/schema.sql).
    A projection naming one is a 400 from PostgREST — and the double
    answers the same way, so the assertion is on the real schema AND on
    the double's fidelity."""
    declared = financial_periods_columns()
    plain = [tok for tok in RT.LIGHT_PERIOD_COLUMNS.split(",") if ":" not in tok]
    missing = [col for col in plain if col not in declared]
    assert not missing, ("LIGHT_PERIOD_COLUMNS names columns financial_periods does "
                         "not carry (a PostgREST 400): %s" % missing)
    assert "period_label" not in declared
    assert "caen_code" not in declared, "phase 7 put CAEN on organizations, not here"
    assert "caen_code" not in plain, (
        "the light projection names caen_code — a 400 on every production listing")
    aliases = [tok.split(":", 1) for tok in RT.LIGHT_PERIOD_COLUMNS.split(",") if ":" in tok]
    for _alias, path in aliases:
        assert path.split("->")[0] in declared, path
    assert any(alias == "p121" for alias, _p in aliases), (
        "the account-121 anchor is not on the light projection")
    fake = ProjectingAdmin({"financial_periods": [
        period_row("p", "o", fixture("saga_10_col_agras"))]})
    with pytest.raises(RuntimeError) as exc:
        fake.select("financial_periods", filters={"id": "eq.p"},
                    columns=RT.LIGHT_PERIOD_COLUMNS + ",period_label")
    assert "period_label does not exist" in str(exc.value)
    assert RT.period_label_of({"period_end": "2025-12-31"}) == "2025-12-31"


def test_validate_dismiss_refuses_no_rule_no_reason_and_a_non_positive_span():
    with pytest.raises(RT.RadarLoadError) as exc:
        RT.validate_dismiss(RT.DismissBody(rule_id=" ", reason="x"))
    assert exc.value.status == 422
    with pytest.raises(RT.RadarLoadError) as exc:
        RT.validate_dismiss(RT.DismissBody(rule_id="r", reason="   "))
    assert exc.value.status == 422 and "reason" in exc.value.detail
    with pytest.raises(RT.RadarLoadError) as exc:
        RT.validate_dismiss(RT.DismissBody(rule_id="r", reason="x", periods=0))
    assert exc.value.status == 422
    assert RT.validate_dismiss(RT.DismissBody(rule_id="r", reason=" ok ", subject="")) == \
        ("r", "*", "ok", None)


# ── the served route ─────────────────────────────────────────────────────


def test_get_serves_the_period_through_the_real_engine_with_the_marker(client, book):
    r = client.get("/api/radar/p-a-2025", headers=HEADERS)
    assert r.status_code == 200, r.text
    payload = r.json()
    assert payload["source"] == "radar" and payload["available"] is True
    assert payload["version"] == RS.RADAR_VERSION
    assert payload["period_id"] == "p-a-2025"
    assert payload["surfaced"], "the real book surfaced nothing"
    assert all(row["source"] == "radar" for row in payload["surfaced"])
    assert payload["materiality"]["basis"]["source"] == RS.BASIS_SOURCE_GATEWAY
    assert payload["history"]["periods_with_statements"] == 2
    assert payload["lanes"][RS.LANE_MULTI]["ran"] is True
    assert payload["notices"] == []
    # The same findings, the same figures, the capture's engine run
    # produced — through the PROJECTION, so the envelope the rebuild
    # seam reads is the one the route loaded and put back on the row.
    golden = fixture("saga_10_col_agras")["radar"]
    assert [(row["rule_key"], row["severity"], row["rank"]) for row in payload["surfaced"]] == \
        [(row["rule_key"], row["severity"], row["rank"]) for row in golden["surfaced"]]
    for served, captured in zip(payload["surfaced"], golden["surfaced"]):
        assert served["facts_cited"] == captured["facts_cited"], served["rule_key"]
        assert served["materiality"] == captured["materiality"], served["rule_key"]
        assert served["facts_provenance"] == captured["facts_provenance"], served["rule_key"]
    assert payload["snapshot_id"] == golden["snapshot_id"]
    assert payload["source_document_id"] == "doc-p-a-2025"


def test_the_route_serves_account_121_as_statutory_net_income_like_every_other_surface(
        client, book):
    """Radar was the one surface still serving the class-6/7
    reconstruction under the statutory name, because its light
    projection never carried the envelope (NET_INCOME_ANCHOR.md §6).
    Through the projection-faithful client: the rebuilt statements are
    ANCHORED, the retail book's net income is account 121, and it is the
    figure `FactsGateway.net_result()` serves — verified on the row."""
    fx = fixture("saga_10_col_retail")
    p121 = p121_of(fx)
    payload = client.get("/api/radar/p-b-2025", headers=HEADERS_B).json()
    rows = dict((r["rule_key"], r) for r in payload["surfaced"])
    assert "affiliate_income_dependency" in rows, sorted(rows)
    row = rows["affiliate_income_dependency"]
    served = float(row["facts_cited"]["net_income"])
    assert abs(served - p121) < 0.005, (
        "Radar serves net_income = %.2f but account 121 = %.2f — the route is "
        "still serving the class-6/7 reconstruction (1,161,957.98 on this book)"
        % (served, p121))
    gateway = FactsGateway.from_envelope(fx["envelope"], currency=fx["currency"])
    assert abs(gateway.net_result().to_float() - served) < 0.005
    cited = row["facts_provenance"]["cited"]
    assert cited["net_income"]["accessor"] == "FactsGateway.net_result()"
    assert cited["net_income"]["snapshot_id"] == fx["envelope"]["provenance"]["content_hash"]
    # And the seam itself labelled the figure anchored on THIS row shape.
    light = [r for r in RT.list_light_periods(book, "org-b") if r["id"] == "p-b-2025"][0]
    # `load_statements` returns (statements, line_items) — the ROWS travel
    # on too, because the detector lane's served-tier spine is built from
    # them and fetching them a second time is two chances to disagree.
    statements, items = RT.load_statements(
        book, light, RT.load_envelope(book, "p-b-2025"))
    assert items, "the loader dropped the line items it read"
    pl = statements["assembled_pl"]
    assert pl["net_income_anchor_status"] == "anchored", pl.get("net_income_anchor_status")
    assert abs(float(pl["net_income_statutory"]) - p121) < 0.005


def test_a2_the_envelope_is_on_the_row_the_rebuild_seam_reads(book):
    """The route's OWN loader puts the persisted envelope back on the
    light row before the rebuild; without it the seam serves the raw
    assemble-path totals (agras total_assets 39,272,501.03 instead of
    the gateway's 39,319,114.09) and an unanchored net income."""
    fx = fixture("saga_10_col_agras")
    light = [r for r in RT.list_light_periods(book, "org-a") if r["id"] == "p-a-2025"][0]
    assert "assembled_canonical_v1" not in light
    heavy = RT.heavy_input(book, RT.light_input(light, 1), light)
    assert isinstance(heavy.envelope, dict)
    gateway = FactsGateway.from_envelope(fx["envelope"], currency=fx["currency"])
    total = float(heavy.statements["assembled_bs"]["total_assets"])
    assert abs(total - gateway.total_assets().to_float()) < 0.005, (
        "the rebuild did not apply the persisted reconciliation: total_assets "
        "%.2f vs the gateway's %.2f" % (total, gateway.total_assets().to_float()))
    assert heavy.statements["assembled_pl"]["net_income_anchor_status"] == "anchored"
    # The row the seam is handed carries the envelope under the column name.
    full = RT.full_row(light, heavy.envelope)
    assert full["assembled_canonical_v1"] is heavy.envelope
    # Handing the seam the LIGHT row is the recorded defect: measurably
    # different figures.
    bare, _items = RT.load_statements(book, dict(light, p121=None), None)
    assert abs(float(bare["assembled_bs"]["total_assets"]) - total) > 1.0
    assert bare["assembled_pl"]["net_income_anchor_status"] == "absent"


def test_get_is_a_thin_wrapper_over_compose(client, book):
    """The route's payload IS compose()'s payload over the same rebuilt
    statements — nothing added, nothing rounded, nothing reordered —
    plus the cache, notices and explanations keys the route owns."""
    served = client.get("/api/radar/p-a-2025", headers=HEADERS).json()
    notices = []
    request, target_row, spine = RT.build_request(book, "org-a", "p-a-2025", notices)
    from dataclasses import replace
    rows = dict((r["id"], r) for r in spine)
    target = RT.heavy_input(book, request.target, target_row)
    prior = tuple(RT.heavy_input(book, p, rows[p.period_id]) for p in request.prior_periods())
    direct = RS.compose(replace(request, target=target, history=prior)).payload
    assert json.dumps(stripped(served), sort_keys=True) == json.dumps(direct, sort_keys=True)


def test_get_a_period_outside_the_workspace_is_404_because_rls_never_returned_it(client, monkeypatch):
    monkeypatch.setattr(_org, "resolve_org", lambda jwt, requested=None: ("user-1", "org-a"))
    r = client.get("/api/radar/p-b-2025", headers=HEADERS)
    assert r.status_code == 404
    r = client.get("/api/radar/p-a-2025")
    assert r.status_code == 401


def test_get_twice_loads_line_items_once_and_hits_the_cache(client, book):
    RT.cache().reset_counters()
    first = client.get("/api/radar/p-a-2025", headers=HEADERS).json()
    reads_after_first = len(_line_item_reads(book))
    assert reads_after_first == 2, "target + one prior period on a miss"
    envelope_loads = [c for c in _period_selects(book) if c[3] == RT.ENVELOPE_COLUMNS]
    assert len(envelope_loads) == 2, "the envelope is loaded once per rebuilt period"
    second = client.get("/api/radar/p-a-2025", headers=HEADERS).json()
    assert len(_line_item_reads(book)) == reads_after_first, (
        "INCREMENTAL VIOLATED — an unchanged open reloaded line items")
    assert [c for c in _period_selects(book) if c[3] == RT.ENVELOPE_COLUMNS] == envelope_loads
    assert second["cache"]["hits"] >= 1
    assert RS.canonical_bytes(stripped(first)) == RS.canonical_bytes(stripped(second))
    # A hit still attaches explanations — from cache, never from a model.
    assert all("explanation" in r for r in second["surfaced"])
    assert second[RS.EXPLANATIONS_KEY]["critical_path"] == "cache-only"


def test_get_recomputes_when_the_envelope_content_hash_moves(client, book):
    client.get("/api/radar/p-a-2025", headers=HEADERS)
    before = len(_line_item_reads(book))
    for row in book.tables["financial_periods"]:
        if row["id"] == "p-a-2025":
            row["assembled_canonical_v1"]["provenance"]["content_hash"] = "sha256-rewritten"
    client.get("/api/radar/p-a-2025", headers=HEADERS)
    assert len(_line_item_reads(book)) > before


def test_get_without_the_dismissals_table_serves_with_a_notice_never_a_500(client, book, monkeypatch):
    real = book.select

    def select(table, **kwargs):
        if table == "radar_dismissals":
            raise RuntimeError("relation radar_dismissals does not exist")
        return real(table, **kwargs)
    monkeypatch.setattr(book, "select", select)
    r = client.get("/api/radar/p-a-2025", headers=HEADERS)
    assert r.status_code == 200
    assert any("radar_dismissals" in n for n in r.json()["notices"])


# ── the dismissal round trip ─────────────────────────────────────────────


def test_dismiss_persists_who_when_reason_scope_and_the_anchor_period_then_re_serves(client, book):
    first = client.get("/api/radar/p-a-2025", headers=HEADERS).json()
    victim = first["surfaced"][0]
    r = client.post("/api/radar/p-a-2025/dismiss", headers=HEADERS, json={
        "rule_id": victim["rule_key"], "subject": victim["root_cause"],
        "reason": "covered by the January facility", "periods": 2})
    assert r.status_code == 200, r.text
    body = r.json()
    row = body["dismissal"]
    assert row["org_id"] == "org-a" and row["period_id"] == "p-a-2025"
    assert row["from_period_end"] == "2025-12-31", "the human anchor is stored too"
    assert row["rule_id"] == victim["rule_key"] and row["scope_key"] == victim["root_cause"]
    assert row["reason"] == "covered by the January facility"
    assert row["dismissed_by"] == "user-1" and row["dismissed_at"] == CLOCK
    assert row["from_period_ordinal"] == 1 and row["periods"] == 2
    inserts = [c for c in book.calls if c[0] == "insert" and c[1] == "radar_dismissals"]
    assert len(inserts) == 1
    # The re-served payload already reflects it.
    radar = body["radar"]
    assert victim["rule_key"] not in [x["rule_key"] for x in radar["surfaced"]] or \
        victim["group_critical"]
    assert radar["dismissals"]["in_force"][0]["reason"] == "covered by the January facility"
    # And the next open persists it: same bytes as the re-serve.
    again = client.get("/api/radar/p-a-2025", headers=HEADERS).json()
    assert RS.canonical_bytes(stripped(again)) == RS.canonical_bytes(stripped(radar))


def test_a4_a_dismissal_is_anchored_on_its_period_not_on_a_spine_position(client, book):
    """The critic's exact sequence. Dismiss on p-a-2025 for ONE period;
    p-a-2024 is untouched. Then a 2023 period lands in the workspace —
    every ordinal shifts by one. Before the fix the stored ordinal (1)
    now pointed at 2024: 2025 showed the finding again and 2024 was
    suppressed while the row still said period_id=p-a-2025. Now the
    anchor is the period: nothing moves."""
    first = client.get("/api/radar/p-a-2025", headers=HEADERS).json()
    victim = [r for r in first["surfaced"] if not r["group_critical"]][0]
    r = client.post("/api/radar/p-a-2025/dismiss", headers=HEADERS, json={
        "rule_id": victim["rule_key"], "subject": victim["root_cause"],
        "reason": "one period only", "periods": 1}).json()
    assert r["radar"]["dismissals"]["applied"] == 1
    assert victim["rule_key"] not in [x["rule_key"] for x in r["radar"]["surfaced"]]
    p24 = client.get("/api/radar/p-a-2024", headers=HEADERS).json()
    assert p24["dismissals"]["applied"] == 0, "the dismissal reached a period it was not made on"

    agras = fixture("saga_10_col_agras")
    book.tables["financial_periods"].append(
        period_row("p-a-2023", "org-a", agras, period_end="2023-12-31"))
    book.tables["statement_line_items"].extend(line_item_rows("p-a-2023", agras))

    p25 = client.get("/api/radar/p-a-2025", headers=HEADERS).json()
    p24 = client.get("/api/radar/p-a-2024", headers=HEADERS).json()
    p23 = client.get("/api/radar/p-a-2023", headers=HEADERS).json()
    assert p25["dismissals"]["applied"] == 1, (
        "A4 VIOLATED — adding an earlier period moved the dismissal off the "
        "period it was made on (p-a-2025 now shows %s again)" % victim["rule_key"])
    assert victim["rule_key"] not in [x["rule_key"] for x in p25["surfaced"]]
    assert p24["dismissals"]["applied"] == 0, (
        "A4 VIOLATED — the dismissal slid onto p-a-2024, a period it was never made on")
    assert victim["rule_key"] in [x["rule_key"] for x in p24["surfaced"]]
    assert p23["dismissals"]["applied"] == 0
    stored = book.tables["radar_dismissals"][0]
    assert stored["period_id"] == "p-a-2025" and stored["from_period_end"] == "2025-12-31"
    # The served dismissal's reach is re-anchored: ordinal 2 on the new spine.
    assert p25["dismissals"]["in_force"][0]["from_period_ordinal"] == 2
    assert p25["notices"] == []


def test_a4_a_deleted_anchor_period_still_anchors_by_its_period_end_and_a_legacy_row_is_not_applied(book):
    """Two edges of the anchor. A dismissal whose period was deleted
    anchors where that period stood (its period end); a legacy row with
    neither a live period nor a period end cannot be anchored — it is
    NOT applied and the payload says so (an absent dismissal shows
    MORE, never less)."""
    spine = RT.order_periods([
        {"id": "p-2023", "period_end": "2023-12-31"},
        {"id": "p-2024", "period_end": "2024-12-31"},
        {"id": "p-2026", "period_end": "2026-12-31"},
    ])
    deleted = {"id": "d1", "rule_id": "fx_exposure", "scope_key": "*", "reason": "x",
               "dismissed_by": "u", "dismissed_at": CLOCK,
               "period_id": "p-2025-gone", "from_period_end": "2025-12-31",
               "from_period_ordinal": 99, "periods": 1}
    assert RT.anchor_ordinal(deleted, spine) == 2, "2025 stood between 2024 and 2026"
    live = dict(deleted, period_id="p-2024")
    assert RT.anchor_ordinal(live, spine) == 1, "a live period anchors by id, not by end"
    legacy = dict(deleted, from_period_end=None)
    assert RT.anchor_ordinal(legacy, spine) is None
    notices = []
    resolved = RT.resolve_dismissals([deleted, legacy], spine, notices)
    assert [d.from_period_ordinal for d in resolved] == [2]
    assert len(notices) == 1 and "could not be anchored" in notices[0] and "d1" in notices[0]
    # An open-ended legacy row needs no anchor at all.
    open_ended = dict(legacy, periods=None)
    assert RT.dismissal_from_row(open_ended, spine) is not None


def test_dismiss_refuses_an_empty_reason_and_an_unknown_period(client, book):
    r = client.post("/api/radar/p-a-2025/dismiss", headers=HEADERS,
                    json={"rule_id": "fx_exposure", "reason": "  "})
    assert r.status_code == 422 and "reason" in r.text
    r = client.post("/api/radar/p-nope/dismiss", headers=HEADERS,
                    json={"rule_id": "fx_exposure", "reason": "x"})
    assert r.status_code == 404
    assert not [c for c in book.calls if c[0] == "insert"]


def test_dismiss_fails_loudly_when_storage_refuses(client, book, monkeypatch):
    def refuse(table, rows, **kwargs):
        raise RuntimeError("new row violates row-level security policy")
    monkeypatch.setattr(book, "insert", refuse)
    r = client.post("/api/radar/p-a-2025/dismiss", headers=HEADERS,
                    json={"rule_id": "fx_exposure", "reason": "x"})
    assert r.status_code == 403 and "row-level security" in r.text


def test_revoke_is_an_update_never_a_delete_and_the_next_open_forgets_it(client, book):
    first = client.get("/api/radar/p-a-2025", headers=HEADERS).json()
    victim = first["surfaced"][0]
    dismissed = client.post("/api/radar/p-a-2025/dismiss", headers=HEADERS, json={
        "rule_id": victim["rule_key"], "subject": victim["root_cause"], "reason": "x"}).json()
    dismissal_id = dismissed["dismissal"]["id"]
    r = client.post("/api/radar/p-a-2025/dismissals/%s/revoke" % dismissal_id, headers=HEADERS)
    assert r.status_code == 200, r.text
    assert not [c for c in book.calls if c[0] == "delete"]
    stored = book.tables["radar_dismissals"][0]
    assert stored["revoked_at"] == CLOCK and stored["revoked_by"] == "user-1"
    assert stored["reason"] == "x", "the decision survives its revocation"
    after = r.json()["radar"]
    assert after["dismissals"]["in_force"] == []
    assert RS.canonical_bytes(stripped(after)) == RS.canonical_bytes(stripped(first))
    listed = client.get("/api/radar/p-a-2025/dismissals", headers=HEADERS).json()
    assert listed["dismissals"] == []


def test_a_dismissed_critical_survives_the_round_trip_flagged(client, book):
    """Through the route, on the workspace whose book carries the
    Criticals: dismiss one, and it is still served, flagged, with the
    reason."""
    first = client.get("/api/radar/p-b-2025", headers=HEADERS_B).json()
    crits = [r for r in first["surfaced"] if r["severity"] == "critical"]
    assert crits, "the retail book stopped carrying a Critical"
    crit = crits[0]
    body = client.post("/api/radar/p-b-2025/dismiss", headers=HEADERS_B, json={
        "rule_id": crit["rule_key"], "subject": crit["root_cause"],
        "reason": "the imbalance is a known year-end entry"}).json()
    rows = dict((r["rule_key"], r) for r in body["radar"]["surfaced"])
    assert crit["rule_key"] in rows
    assert rows[crit["rule_key"]]["dismissed_but_retained"] is True
    assert rows[crit["rule_key"]]["dismissal"]["reason"] == "the imbalance is a known year-end entry"
    assert body["radar"]["dismissals"]["retained_critical"] == 1


# ── the explanation lane, through the route ──────────────────────────────


def _shape(rows):
    return [(r["id"], r["rank"], r["severity"], r["effective_severity"],
             r["disposition"], r["dismissed"], r["group_severity"]) for r in rows]


def _wiring(draft, review=HIGH_REVIEW, **kw):
    done = threading.Event()
    seen = []

    def _on_done(out):
        seen.extend(out)
        done.set()
    wiring = RT.ExplainWiring(
        store=X.MemoryExplainStore(), background=True,
        client_factory=(_factory(StubClient(draft=draft)) if draft is not None else None),
        reviewer_factory=(_factory(StubClient(review=review)) if review is not None else None),
        on_done=_on_done, **kw)
    return wiring, done, seen


def test_the_route_attaches_cached_explanations_before_the_rows_return_and_drafts_after(
        book, monkeypatch):
    wiring, done, seen = _wiring(GOOD_DRAFT)
    client = _mount(book, monkeypatch, wiring)
    first = client.get("/api/radar/p-a-2025", headers=HEADERS).json()
    assert first["surfaced"]
    for row in first["surfaced"]:
        assert row["explanation"]["status"] == X.STATUS_ABSENT
        assert row["explanation"]["kind"] == X.KIND_NOT_YET
    summary = first[RS.EXPLANATIONS_KEY]
    assert summary["critical_path"] == "cache-only"
    assert summary["pending"] == len(first["surfaced"]) and summary["drafting_in_background"]
    assert done.wait(30), "the background draft did not finish"
    assert seen and all(e.status == X.STATUS_FRESH for e in seen), [
        (e.status, e.kind, e.reason) for e in seen]
    second = client.get("/api/radar/p-a-2025", headers=HEADERS).json()
    assert all(r["explanation"]["status"] == X.STATUS_CACHED for r in second["surfaced"])
    assert second[RS.EXPLANATIONS_KEY]["cached"] == len(second["surfaced"])
    assert second[RS.EXPLANATIONS_KEY]["drafting_in_background"] is False
    en = second["surfaced"][0]["explanation"]["en"]
    assert en["rationale"].strip() and en["steps"]
    # Prose was ADDED and nothing else moved: the deterministic bytes are
    # recoverable from both opens and equal.
    assert RS.canonical_bytes(stripped(first)) == RS.canonical_bytes(stripped(second))
    assert _shape(first["surfaced"]) == _shape(second["surfaced"])


def test_the_rows_return_with_the_model_dead_through_the_route(book, monkeypatch):
    """Production factories, nothing mocked but the death: the SDK is
    absent and no key is set. The rows return at once, every row carries
    an honest marker, and not one byte of model payload is served."""
    monkeypatch.setitem(sys.modules, "anthropic", None)
    wiring, done, seen = _wiring(None, review=None)
    client = _mount(book, monkeypatch, wiring)
    t0 = time.perf_counter()
    payload = client.get("/api/radar/p-a-2025", headers=HEADERS).json()
    elapsed = time.perf_counter() - t0
    assert elapsed < ROWS_DEADLINE_S, "the rows waited on a dead model: %.2fs" % elapsed
    assert payload["surfaced"] and all(
        r["explanation"]["status"] == X.STATUS_ABSENT for r in payload["surfaced"])
    assert done.wait(30)
    assert seen and all(e.status == X.STATUS_ABSENT and e.kind == X.KIND_ADVISORY_UNAVAILABLE
                        for e in seen), [(e.status, e.kind) for e in seen]
    again = client.get("/api/radar/p-a-2025", headers=HEADERS).json()
    blob = json.dumps(again, ensure_ascii=False, sort_keys=True)
    for token in ("Traceback", "messages.create", "raw_response", "anthropic"):
        assert token not in blob, token
    for row in again["surfaced"]:
        assert row["explanation"]["en"] is None
        assert row["explanation"]["reason"].strip() and "{" not in row["explanation"]["reason"]
        assert row["contract_elements"]["why_here"]["rationale"].strip()


def test_the_rows_return_while_the_model_sleeps_through_the_route(book, monkeypatch):
    """A model that takes 30 s answers a question nobody is waiting on."""
    release = threading.Event()

    class SlowClient(StubClient):
        def create(self, **kwargs):
            release.wait(30)
            return StubClient.create(self, **kwargs)

    done = threading.Event()
    wiring = RT.ExplainWiring(
        store=X.MemoryExplainStore(), background=True,
        client_factory=_factory(SlowClient(draft=GOOD_DRAFT)),
        reviewer_factory=_factory(StubClient(review=HIGH_REVIEW)),
        on_done=lambda out: done.set())
    client = _mount(book, monkeypatch, wiring)
    try:
        t0 = time.perf_counter()
        payload = client.get("/api/radar/p-a-2025", headers=HEADERS).json()
        elapsed = time.perf_counter() - t0
        assert elapsed < ROWS_DEADLINE_S, "the rows waited on a sleeping model: %.2fs" % elapsed
        assert payload["surfaced"]
        assert all(r["explanation"]["kind"] == X.KIND_NOT_YET for r in payload["surfaced"])
        assert not done.is_set(), "the draft finished before the model answered"
        # A second open while the draft is in flight neither waits nor
        # drafts again.
        t0 = time.perf_counter()
        again = client.get("/api/radar/p-a-2025", headers=HEADERS).json()
        assert time.perf_counter() - t0 < ROWS_DEADLINE_S
        assert again[RS.EXPLANATIONS_KEY]["drafting_in_background"] is False
        assert again[RS.EXPLANATIONS_KEY]["pending"] == len(again["surfaced"])
    finally:
        release.set()
    assert done.wait(30)


def test_a_hostile_model_moves_nothing_through_the_route(book, monkeypatch):
    """The model answers with a severity, a rank, a suppression and an
    extra finding. Through the REAL seam and the REAL route: the served
    rows are byte-identical to the AI-off rows once the prose is
    stripped, the explanation carries no ranking vocabulary, and the
    planted finding is nowhere."""
    hostile = {
        "severity": "critical", "effective_severity": "critical", "rank": 99,
        "surfaced": False, "dismissed": True, "suppress": True,
        "disposition": "all_checks", "order": ["fx_exposure"],
        "findings": [{"rule_key": "planted_by_model", "severity": "critical"}],
        "extra_finding": {"rule_key": "planted_by_model"},
        "cap": 1, "held_back": 3, "score": {"total": 9.9},
    }

    def hostile_draft(n, user_text):
        view = _view_of(user_text)
        draft = good_draft(view, extra=hostile)
        draft["ro"] = dict(draft["ro"], **hostile)
        return draft

    off = _mount(book, monkeypatch,
                 RT.ExplainWiring(store=X.MemoryExplainStore(), background=False)
                 ).get("/api/radar/p-a-2025", headers=HEADERS).json()
    wiring, done, seen = _wiring(hostile_draft)
    client = _mount(book, monkeypatch, wiring)
    client.get("/api/radar/p-a-2025", headers=HEADERS)
    assert done.wait(30)
    assert seen and all(e.status == X.STATUS_FRESH for e in seen), [
        (e.status, e.kind, e.reason) for e in seen]
    on = client.get("/api/radar/p-a-2025", headers=HEADERS).json()
    assert all(r["explanation"]["status"] == X.STATUS_CACHED for r in on["surfaced"])
    assert _shape(on["surfaced"]) == _shape(off["surfaced"])
    assert RS.canonical_bytes(stripped(on)) == RS.canonical_bytes(stripped(off))
    blob = json.dumps([r["explanation"] for r in on["surfaced"]], sort_keys=True)
    assert "planted_by_model" not in json.dumps(on)
    for word in X.RANKING_VOCABULARY:
        assert ('"%s":' % word) not in blob, word


# ── the F9 guard is ACTIVE on the served path (B6) ───────────────────────


_GUARD_PROBE = r'''
import json, socket, sys
def _blocked(self, addr):
    raise RuntimeError("NETBLOCK %r" % (addr,))
socket.socket.connect = _blocked
sys.path.insert(0, __SRC__)
import engine.country_packs.ro_romania  # noqa: F401
from engine.ai import finding_sharpen as FS
from engine.api import _finding as F
before = F.apply_advisory_narrative is FS.apply_advisory_narrative
from engine.api import _radar
_radar.build_router()
after = F.apply_advisory_narrative is FS.apply_advisory_narrative
from engine.api.findings import s_engine
fx = json.load(open(__FIXTURE__, encoding="utf-8"))
result = s_engine.run_single_period(fx["statements"], period_id="p", snapshot_id="doc")
finding = [f for f in result.finding_set.surfaced if f.rule_id == "concentration_related_party"][0]
invented = ("For a mid-size inventory-heavy operator this balance has grown 47% "
            "since the prior year.")
planted = F.apply_advisory_narrative(finding, rationale=invented)
print(json.dumps({"guard_before_mount": before, "guard_after_mount": after,
                  "plant_surfaced": planted.verdict().surfaced,
                  "fingerprint_unchanged": F._numeric_fingerprint(planted)
                                           == F._numeric_fingerprint(finding)}))
'''


def test_b6_mounting_the_router_installs_the_f9_guard_on_the_served_path(tmp_path):
    """In a FRESH interpreter that imports the route module and mounts
    it — and nothing else — `_finding.apply_advisory_narrative` is the
    guarded twin, and the F9 plant ("grown 47%") is demoted through it.
    Before this wave `_finding_advisory` was imported by nothing under
    src/ and the guard was active only while a test suite happened to
    import it."""
    env = dict(os.environ)
    for key in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "SUPABASE_SERVICE_ROLE_KEY",
                "VITE_SUPABASE_URL", "SUPABASE_URL"):
        env.pop(key, None)
    env[FS.JOURNAL_DIR_ENV] = str(tmp_path / "journal")
    env[breaker.STATE_DIR_ENV] = str(tmp_path / "spend")
    code = (_GUARD_PROBE
            .replace("__SRC__", repr(str(REPO / "src")))
            .replace("__FIXTURE__", repr(str(FIXTURES / "saga_10_col_agras.json"))))
    proc = subprocess.run([sys.executable, "-c", code], env=env, cwd=str(REPO),
                          capture_output=True, text=True, timeout=300)
    assert proc.returncode == 0, proc.stderr[-2000:]
    out = json.loads(proc.stdout.strip().splitlines()[-1])
    assert out["guard_before_mount"] is False, (
        "the guard was already installed before the mount — this probe is not "
        "measuring the mount")
    assert out["guard_after_mount"] is True, (
        "B6 VIOLATED — mounting the Radar router did not install the F9 guard on "
        "_finding.apply_advisory_narrative")
    assert out["plant_surfaced"] is False, (
        "B6 VIOLATED — the F9 plant ('grown 47%') is served through the advisory "
        "seam on the Radar path")
    assert out["fingerprint_unchanged"] is True


def test_b6_the_mount_is_where_the_guard_is_imported():
    """Static half: the import lives inside `build_router`, so mounting
    is the act and importing the module is not a side effect."""
    source = (REPO / "src" / "engine" / "api" / "_radar.py").read_text(encoding="utf-8")
    tree = ast.parse(source)
    found = False
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name == "build_router":
            for inner in ast.walk(node):
                if isinstance(inner, ast.ImportFrom) and any(
                        a.name == "_finding_advisory" for a in inner.names):
                    found = True
    assert found, "build_router does not import engine.api._finding_advisory"
    top = [n for n in tree.body if isinstance(n, ast.ImportFrom)
           and any(a.name == "_finding_advisory" for a in n.names)]
    assert not top, "the guard install must be the mount's act, not an import side effect"


def test_the_route_reads_the_clock_exactly_once_and_only_for_the_audit_stamp():
    source = (REPO / "src" / "engine" / "api" / "_radar.py").read_text(encoding="utf-8")
    assert source.count("datetime.now(") == 1
    assert "def utc_now_iso" in source
