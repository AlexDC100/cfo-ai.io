"""FC7 + FC8 — THE FIRM COCKPIT GATES this lane ships through.

FC7  A file uploaded via a REQUEST LINK lands in the intended period
     THROUGH THE NORMAL PIPELINE — the same documents-row shape the
     browser upload writes, the same storage path, the same status +
     enqueue calls /api/pipeline/run makes — and the period-mismatch
     and entity guards FIRE on a wrong-period and a wrong-entity file.
     Not a side channel. Proven on REAL bytes (the committed example
     trial balances carry a real preamble; the corpus files carry none)
     and at the REAL persist seam (`resolve_period_end_for_persist`).

FC8  With the model mocked DEAD, attention items, calendar deadlines,
     the digest and the brief all render COMPLETE with an honest
     notice and ZERO raw model payload — and a model call planted into
     the ranking path reds the structural no-AI assertion.

Every gate here has a PLANT — the defect it exists to catch, applied in
the test itself against a copy or a fake, observed red, never left in
the tree. The live-tree plant transcripts live in
docs/engine_book/gates.md § firm-cockpit-gates.

Fixtures are REAL ENGINE OUTPUT (TC-1): the corpus served envelopes +
regression statements drive the real attention runner; the example
trial balances are the bytes the product ships as its own template.

Python 3.9 — no `match`, no `X | Y` unions.
"""
from __future__ import annotations

import ast
import io
import json
import re
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List

import pytest
import yaml

from engine.ai import breaker, registry
from engine.api import _firm_brief as FB
from engine.api import _firm_requests as FR
from engine.api import _supabase
from engine.api import pipeline as _pipeline
from engine.api.pipeline import resolve_period_end_for_persist
from engine.firm import attention as A
from engine.firm import cadence as CAD
from engine.firm import digest as DG
from engine.firm import model as M

from firm_fakes import FakeAdmin, install

REPO = Path(__file__).resolve().parents[2]
EXAMPLES = REPO / "tests" / "fixtures" / "trial_balance"
CORPUS = REPO / "corpus"
BASELINES = REPO / "src" / "engine" / "country_packs" / "ro_romania" / "fixtures" / "regression_baselines"
FE_UPLOAD = REPO / "frontend" / "lib" / "supabase.ts"

AS_OF = date(2026, 9, 3)
KEY = "firm-gates-signing-key-0123456789"


# ── fixtures: real bytes, real reports ────────────────────────────────────


@pytest.fixture(scope="module")
def example_8col() -> bytes:
    return (EXAMPLES / "example_trial_balance_8col.xlsx").read_bytes()


@pytest.fixture(scope="module")
def corpus_carniprod() -> bytes:
    return (CORPUS / "saga_10_col_carniprod" / "input.xlsx").read_bytes()


def _client(case: str, baseline: str, org_id: str, name: str, period_end: str,
            detection: Any = None) -> M.ClientRecord:
    served = json.loads((CORPUS / case / "expected" / "served_envelope.json").read_text("utf-8"))
    statements = json.loads((BASELINES / (baseline + ".json")).read_text("utf-8"))["assembled"]["statements"]
    env = {"canonical_bs": served,
           "provenance": {"content_hash": "sha256-%s" % case, "source_document_id": "doc-%s" % case}}
    if detection is not None:
        env["period_detection"] = detection
    return M.ClientRecord(
        client_id=org_id, client_name=name, jurisdiction="RO",
        periods=(M.PeriodRecord(period_id="p-%s" % org_id, period_end=period_end,
                                envelope=env, statements=statements, updated_at="t"),))


@pytest.fixture(scope="module")
def report():
    """The REAL board over two real corpus books (TC-1)."""
    carni = _client("saga_10_col_carniprod", "carniprod_fy2025", "org-carni", "Carniprod SRL",
                    "2025-12-31",
                    detection={"resolved_period_end": "2025-12-31", "mismatch": True,
                               "detected": {"proposed_period_end": "2024-12-31",
                                            "signal_used": "filename", "confidence": 0.6,
                                            "evidence_snippet": "balanta_2024.xlsx"}})
    agras = _client("saga_10_col_agras", "agras_fy2025", "org-agras", "Agras SA", "2026-06-30")
    return A.compute_firm_attention([carni, agras], as_of=AS_OF)


@pytest.fixture()
def landing_recorder():
    """Fake side effects for `land_file`, recording ORDER."""
    calls = []  # type: List[Any]

    class _Decision(object):
        kind = "disabled"
        was_extra = False

    deps = FR.LandingDeps(
        upload_object=lambda bucket, path, content, ctype: calls.append(("upload", bucket, path, len(content), ctype)),
        insert_document=lambda row: (calls.append(("insert", dict(row))) or dict(row)),
        set_status=lambda doc_id, status, started: calls.append(("status", doc_id, status)),
        enqueue=lambda doc_id: calls.append(("enqueue", doc_id)),
        reserve=lambda user_id: _Decision(),
        record_usage=lambda user_id, kind: calls.append(("usage", user_id, kind)),
        now=lambda: datetime(2026, 9, 3, 8, 0, tzinfo=timezone.utc),
    )
    return deps, calls


def _request(org_id="org-exemplu", period_end="2025-12-31", name="Exemplu Comert SRL",
             cui="99999999") -> Dict[str, Any]:
    return {"id": "req-1", "client_org_id": org_id, "period_end": period_end,
            "requested_by": "user-acct", "status": FR.STATUS_REQUESTED,
            "expected_identity": {"name": name, "cui": cui}}


def _claims(request_id="req-1", org_id="org-exemplu", period_end="2025-12-31",
            days=14) -> FR.TokenClaims:
    return FR.TokenClaims(request_id=request_id, client_org_id=org_id, period_end=period_end,
                          expires_at=(datetime.now(timezone.utc) + timedelta(days=days)).isoformat(),
                          nonce="n1")


# ══ FC7 — THE REQUEST LINK IS NOT A SIDE CHANNEL ══════════════════════════


def test_fc7_token_is_signed_expiring_and_tamper_evident():
    key = KEY.encode("utf-8")
    claims = _claims()
    token = FR.mint_token(claims, key)
    assert FR.parse_token(token, key) == claims
    # tamper: flip the signature
    with pytest.raises(FR.TokenError) as exc:
        FR.parse_token(token[:-2] + ("aa" if not token.endswith("aa") else "bb"), key)
    assert exc.value.kind == "bad_signature"
    # tamper: edit the claims body (period) without re-signing
    body, sig = token.split(".")
    other = FR.mint_token(FR.TokenClaims("req-1", "org-exemplu", "2024-11-30",
                                         claims.expires_at, "n1"), key).split(".")[0]
    with pytest.raises(FR.TokenError) as exc:
        FR.parse_token(other + "." + sig, key)
    assert exc.value.kind == "bad_signature"
    # expiry is honoured only AFTER the signature verifies
    with pytest.raises(FR.TokenError) as exc:
        FR.parse_token(FR.mint_token(_claims(days=-1), key), key)
    assert exc.value.kind == "expired"
    # a different key never verifies
    with pytest.raises(FR.TokenError):
        FR.parse_token(token, b"another-key-0123456789abcdef")
    # only the hash is what the table stores, and it is not the token
    assert FR.token_hash(token) != token and len(FR.token_hash(token)) == 64


def test_fc7_no_signing_key_fails_closed(monkeypatch):
    monkeypatch.delenv(FR.SIGNING_KEY_ENV, raising=False)
    with pytest.raises(FR.SigningKeyMissing):
        FR.signing_key()
    monkeypatch.setenv(FR.SIGNING_KEY_ENV, "short")
    with pytest.raises(FR.SigningKeyMissing):
        FR.signing_key()


def test_fc7_link_is_single_use_and_state_aware(monkeypatch):
    monkeypatch.setenv(FR.SIGNING_KEY_ENV, KEY)
    key = KEY.encode("utf-8")
    claims = _claims()
    token = FR.mint_token(claims, key)
    row = dict(_request(), token_hash=FR.token_hash(token))
    fake = FakeAdmin({"firm_file_requests": [row]})
    got_claims, got_row = FR.open_request_for(fake, token)
    assert got_claims == claims and got_row["id"] == "req-1"
    # consumed → 410
    fake.tables["firm_file_requests"][0]["status"] = FR.STATUS_RECEIVED
    fake.tables["firm_file_requests"][0]["consumed_at"] = "2026-09-03T08:00:00+00:00"
    with pytest.raises(Exception) as exc:
        FR.open_request_for(fake, token)
    assert getattr(exc.value, "status_code", None) == 410
    # revoked → 410
    fake.tables["firm_file_requests"][0].update({"status": FR.STATUS_REVOKED, "consumed_at": None})
    with pytest.raises(Exception) as exc:
        FR.open_request_for(fake, token)
    assert getattr(exc.value, "status_code", None) == 410
    # a token whose claims disagree with its row → 403 (never a silent refile)
    fake.tables["firm_file_requests"][0].update({"status": FR.STATUS_REQUESTED, "period_end": "2024-11-30"})
    with pytest.raises(Exception) as exc:
        FR.open_request_for(fake, token)
    assert getattr(exc.value, "status_code", None) == 403
    # unknown hash → 404
    with pytest.raises(Exception) as exc:
        FR.open_request_for(FakeAdmin({"firm_file_requests": []}), token)
    assert getattr(exc.value, "status_code", None) == 404


def _fe_upload_row_keys() -> List[str]:
    """The columns lib/supabase.ts::uploadDocument writes into
    `documents` — read from the frontend source, not remembered."""
    source = FE_UPLOAD.read_text("utf-8")
    start = source.index("const baseRow: Record<string, unknown> = {")
    end = source.index("};", start)
    block = source[start:end]
    # plain `key:` lines and the conditional spreads `...(cond ? { key: … } : {})`
    keys = re.findall(r"^\s+(?:\.\.\.\([^{]*\{ )?([a-z_]+):", block, flags=re.M)
    return sorted(set(keys))


def test_fc7_request_link_lands_through_the_normal_pipeline(example_8col, landing_recorder):
    """THE property: same row shape, same path, same status + enqueue,
    period_end_hint = the request's period — then the REAL persist seam
    files it there with no mismatch."""
    deps, calls = landing_recorder
    result = FR.land_file(_request(), example_8col, "balanta_verificare_12_2025.xlsx",
                          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                          deps, document_id="doc-fc7")
    # 1. the ORDER the browser path takes: blob, row, queued, enqueue, counter
    assert [c[0] for c in calls] == ["upload", "insert", "status", "enqueue", "usage"]
    assert calls[0][1:3] == (FR.DOC_BUCKET, "org-exemplu/uploads/doc-fc7.xlsx")
    assert calls[2][1:] == ("doc-fc7", "queued")
    assert calls[3][1] == "doc-fc7"
    # 2. the row shape is the browser's row shape (+ the run-route's
    #    metered_extra) — every key we write, the frontend writes too
    row = calls[1][1]
    fe_keys = set(_fe_upload_row_keys())
    assert fe_keys >= {"org_id", "storage_path", "original_filename", "period_end_hint"}, fe_keys
    extra = set(row) - fe_keys - {"metered_extra"}
    assert not extra, "row writes columns the browser upload never writes: %s" % sorted(extra)
    assert row["org_id"] == "org-exemplu"
    assert row["status"] == "queued" and row["scope"] == "financial"
    assert row["period_end_hint"] == "2025-12-31"
    assert row["detected_type"] == "trial_balance"
    assert row["uploaded_by"] == "user-acct"
    # 3. the REAL persist seam: the hint is rank 1, and the document's own
    #    evidence agrees, so the period is 2025-12-31 with no mismatch
    period_end, record = resolve_period_end_for_persist(
        dict(row, id="doc-fc7"), {})
    assert period_end == "2025-12-31"
    assert record["signal_used"] == "user_confirmed"
    assert record["mismatch"] is False
    assert record["detected"]["proposed_period_end"] == "2025-12-31"
    # 4. the entity guard MATCHED on the real preamble (name + CUI)
    assert result.inspection.entity.verdict == FR.VERDICT_MATCH
    assert result.inspection.identity.cui == "99999999"
    assert result.inspection.period["agrees"] is True


def test_fc7_production_deps_are_the_pipelines_own_functions(monkeypatch):
    """`production_deps()` must call the pipeline's `_admin_set_status`
    and `_enqueue` — the exact functions /api/pipeline/run calls — not
    a re-implementation."""
    seen = []  # type: List[Any]
    monkeypatch.setattr(_pipeline, "_admin_set_status",
                        lambda doc_id, status, **kw: seen.append(("status", doc_id, status, kw)))
    monkeypatch.setattr(_pipeline, "_enqueue", lambda doc_id: seen.append(("enqueue", doc_id)))
    deps = FR.production_deps()
    deps.set_status("doc-1", "queued", "2026-09-03T00:00:00+00:00")
    deps.enqueue("doc-1")
    assert seen == [("status", "doc-1", "queued", {"pipeline_started_at": "2026-09-03T00:00:00+00:00"}),
                    ("enqueue", "doc-1")]
    # and the run route itself uses the same two names (source-level tie)
    source = (REPO / "src" / "engine" / "api" / "pipeline.py").read_text("utf-8")
    run_route = source[source.index('@router.post("/api/pipeline/run"'):]
    run_route = run_route[:run_route.index("@router.get")]
    assert '_admin_set_status(req.document_id, "queued"' in run_route
    assert "_enqueue(req.document_id)" in run_route


def test_fc7_plant_wrong_period_file_fires_the_period_mismatch_guard(example_8col, landing_recorder):
    """PLANT: the request is bound to 2024-11, the file is the December
    2025 trial balance. The landing's own precheck disagrees, and the
    REAL persist seam records the mismatch — the row is filed under the
    human-confirmed month (rank 1) and the disagreement is written into
    the record the PERIOD_MISMATCH surface reads."""
    deps, calls = landing_recorder
    result = FR.land_file(_request(period_end="2024-11-30"), example_8col,
                          "balanta_verificare_12_2025.xlsx", "", deps, document_id="doc-plant")
    assert result.inspection.period["agrees"] is False
    assert result.inspection.period["proposed"] == "2025-12-31"
    assert result.inspection.period["bound"] == "2024-11-30"
    row = [c for c in calls if c[0] == "insert"][0][1]
    assert row["period_end_hint"] == "2024-11-30"
    period_end, record = resolve_period_end_for_persist(dict(row, id="doc-plant"), {})
    assert period_end == "2024-11-30", "the hint stays rank 1 — the row is not silently refiled"
    assert record["mismatch"] is True
    assert record["detected"]["proposed_period_end"] == "2025-12-31"
    # the in-document channel fires too, from the real preamble
    assert result.inspection.period["signal"] == "closing_balance"


def test_fc7_counter_plant_agreeing_period_is_not_a_mismatch(example_8col, landing_recorder):
    """A guard that flags every upload flags nothing: the same file bound
    to its own month must NOT be a mismatch."""
    deps, calls = landing_recorder
    FR.land_file(_request(period_end="2025-12-31"), example_8col,
                 "balanta_verificare_12_2025.xlsx", "", deps, document_id="doc-ok")
    row = [c for c in calls if c[0] == "insert"][0][1]
    _period_end, record = resolve_period_end_for_persist(dict(row, id="doc-ok"), {})
    assert record["mismatch"] is False


def test_fc7_plant_wrong_entity_file_fires_the_entity_guard(example_8col, landing_recorder):
    """PLANT: a request minted for Carniprod receives the Exemplu Comert
    file (real preamble: EXEMPLU COMERT SRL, CUI RO99999999). Refused
    409, and — the part that matters — NOTHING happened: no blob, no
    row, no enqueue."""
    deps, calls = landing_recorder
    with pytest.raises(FR.LandingRefused) as exc:
        FR.land_file(_request(org_id="org-carni", name="Carniprod SRL", cui=None),
                     example_8col, "balanta.xlsx", "", deps)
    assert exc.value.status == 409
    assert exc.value.detail["code"] == "entity_mismatch"
    assert exc.value.detail["entity_guard"]["verdict"] == FR.VERDICT_MISMATCH
    assert "carniprod" in exc.value.detail["entity_guard"]["reason"]
    assert calls == [], "a refused landing must leave no side effect"


def test_fc7_entity_guard_cui_decides_over_name(example_8col):
    """Names can look alike; the CUI cannot. A matching name with a
    different CUI is a MISMATCH."""
    inspection = FR.inspect_upload(example_8col, "balanta.xlsx",
                                   {"name": "Exemplu Comert SRL", "cui": "RO1234567"},
                                   "2025-12-31")
    assert inspection.entity.verdict == FR.VERDICT_MISMATCH
    assert "99999999" in inspection.entity.reason


def test_fc7_unknown_identity_is_recorded_not_refused(corpus_carniprod, landing_recorder):
    """ABSENT != MISMATCH. The corpus export (anonymised down to the
    column header) carries no company name or CUI; the landing records
    UNKNOWN and lets the file through to the normal pipeline."""
    deps, calls = landing_recorder
    result = FR.land_file(_request(org_id="org-carni", name="Carniprod SRL", cui=None),
                          corpus_carniprod, "balanta_carniprod_12-2025.xlsx", "", deps,
                          document_id="doc-unknown")
    assert result.inspection.entity.verdict == FR.VERDICT_UNKNOWN
    assert result.inspection.identity.name is None and result.inspection.identity.cui is None
    assert [c[0] for c in calls] == ["upload", "insert", "status", "enqueue", "usage"]
    assert result.inspection.preamble.parse_ok is True


def test_fc7_http_seam_resolve_upload_and_single_use(monkeypatch, example_8col, landing_recorder):
    """The HTTP half, end to end on the real router: resolve prefills the
    period, the upload lands (202, status queued, the row written), and
    the SAME link is refused the second time (410)."""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    monkeypatch.setenv(FR.SIGNING_KEY_ENV, KEY)
    deps, calls = landing_recorder
    monkeypatch.setattr(FR, "production_deps", lambda: deps)
    key = KEY.encode("utf-8")
    claims = _claims()
    token = FR.mint_token(claims, key)
    fake = install(monkeypatch, FakeAdmin({
        "firm_file_requests": [dict(_request(), token_hash=FR.token_hash(token),
                                    requested_at="2026-09-01T10:00:00+00:00",
                                    expires_at=claims.expires_at)],
        "organizations": [{"id": "org-exemplu", "name": "Exemplu Comert SRL", "archived_at": None}],
    }))
    app = FastAPI()
    app.include_router(FR.build_router())
    client = TestClient(app)

    resolved = client.get("/api/firm/requests/resolve/%s" % token)
    assert resolved.status_code == 200, resolved.text
    body = resolved.json()
    assert body["period_end"] == "2025-12-31" and body["client_org_id"] == "org-exemplu"
    assert body["single_use"] is True and body["client_name"] == "Exemplu Comert SRL"

    files = {"file": ("balanta_verificare_12_2025.xlsx", io.BytesIO(example_8col),
                      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")}
    landed = client.post("/api/firm/requests/%s/upload" % token, files=files)
    assert landed.status_code == 202, landed.text
    payload = landed.json()
    assert payload["status"] == "queued" and payload["period_end"] == "2025-12-31"
    assert payload["period_end_hint"] == "2025-12-31"
    assert [c[0] for c in calls] == ["upload", "insert", "status", "enqueue", "usage"]
    row = fake.tables["firm_file_requests"][0]
    assert row["status"] == FR.STATUS_RECEIVED and row["consumed_at"]
    assert row["document_id"] == payload["document_id"]
    assert row["entity_guard"]["verdict"] == FR.VERDICT_MATCH

    again = client.post("/api/firm/requests/%s/upload" % token, files={
        "file": ("balanta_verificare_12_2025.xlsx", io.BytesIO(example_8col))})
    assert again.status_code == 410, again.text
    assert len([c for c in calls if c[0] == "insert"]) == 1, "single use means one row"


def test_fc7_firm_request_routes_resolve_past_the_tenancy_router():
    """The tenancy router is mounted first and owns `GET /api/firm/{firm_id}`
    and friends. Every route of this lane must still resolve to THIS
    lane's endpoint under Starlette's own matcher — a single-segment read
    would otherwise be swallowed as a firm id and answered 403."""
    from fastapi import FastAPI
    from starlette.routing import Match
    from engine.api import _firm, _firm_brief, _firm_requests

    app = FastAPI()
    app.include_router(_firm.build_router())
    app.include_router(_firm_requests.build_router())
    app.include_router(_firm_brief.build_router())
    mine = [r for r in app.routes if hasattr(r, "endpoint")
            and r.endpoint.__module__ in ("engine.api._firm_requests", "engine.api._firm_brief")]
    assert len(mine) >= 12, "the lane's routes were not mounted"
    shadowed = []
    for route in mine:
        for method in route.methods:
            concrete = route.path
            for name in ("token", "request_id"):
                concrete = concrete.replace("{%s}" % name, "abc.def")
            scope = {"type": "http", "method": method, "path": concrete,
                     "root_path": "", "path_params": {}}
            winner = None
            for candidate in app.routes:
                match, _child = candidate.matches(scope)
                if match == Match.FULL:
                    winner = candidate
                    break
            if winner is not route:
                shadowed.append("%s %s -> %s" % (method, concrete,
                                                 getattr(winner, "path", winner)))
    assert not shadowed, shadowed


# ══ FC8 — THE MODEL DEAD, EVERYTHING COMPLETE; NO MODEL IN THE RANKING ═══


def _dead_client_factory():
    raise RuntimeError("model is dead for this test")


@pytest.fixture()
def model_dead(monkeypatch, tmp_path):
    """The corpus-replay sentinel: ANY real SDK import raises, no key is
    set, the breaker state is a scratch dir."""
    monkeypatch.setitem(sys.modules, "anthropic", None)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setenv(breaker.STATE_DIR_ENV, str(tmp_path / "ai_spend"))
    return tmp_path


def test_fc8_dead_model_renders_items_calendar_digest_and_brief_complete(model_dead, report):
    """Attention items (the board), the calendar deadlines it carries,
    the digest and the brief — all present, all complete, an honest
    notice on the one advisory surface, and not one byte of model
    payload anywhere."""
    # the board: real items, real deadlines, no model consulted
    counts = report.counts()
    assert counts["items"] > 0
    assert counts["by_kind"].get("DEADLINE", 0) > 0, "the calendar rendered its deadlines"
    assert counts["by_kind"].get("CRITICAL_FINDING", 0) > 0
    # the digest: every board item present, complete
    items, refusals = DG.items_from_report(report)
    assert refusals == []
    assert len(items) == counts["items"]
    digest = DG.build_digest(report.items(), AS_OF, user_id="u", firm_key="f",
                             client_names={"org-carni": "Carniprod SRL", "org-agras": "Agras SA"},
                             kind_order=DG.kind_order_from_report(report))
    assert digest.counts["shown"] == counts["items"]
    text = DG.render_digest_text(digest, "https://cfo-ai.io")
    assert "Advisory summary: not shown" in text
    # the digest's one AI line, asked for with the model dead: honest
    summary = FB.ai_summary_line(items, AS_OF, client_factory=_dead_client_factory,
                                 state_dir=model_dead)
    assert summary.available is False and "unavailable" in summary.reason
    attached = DG.attach_ai_summary(digest, summary)
    assert attached.ai_summary.available is False
    # the brief: degraded, complete, same order, notice — and no raw payload
    brief = FB.compose_brief(items, AS_OF, "firm-fc8", client_factory=_dead_client_factory,
                             state_dir=model_dead)
    assert brief["degraded"] is True
    assert brief["advisory"]["available"] is False
    assert brief["advisory"]["kind"] == "credits_absent"
    assert brief["item_count"] == len(items)
    assert [r["item_id"] for r in brief["order"]] == [it.item_id for it in DG.deterministic_order(items, AS_OF)]
    assert brief["notice"].startswith("Advisory brief:")
    blob = json.dumps({"brief": brief, "digest": digest.to_payload(), "board": report.to_payload()},
                      ensure_ascii=False, default=str)
    for token in ("raw_response", "messages.create", "model is dead for this test"):
        assert token not in blob, token
    assert brief["advisory"]["opening"] is None and brief["advisory"]["groups"] == []


def test_fc8_breaker_open_degrades_with_the_reason(monkeypatch, tmp_path, report):
    """A tripped daily cap is the same honest state, with the breaker's
    own reason in the notice; the caps come from the registry row, not
    from a default."""
    raw = yaml.safe_load((REPO / "src" / "engine" / "ai" / "models.yaml").read_text("utf-8"))
    raw["roles"]["firm_brief"]["breaker"] = {"max_calls_per_day": 0, "max_tokens_per_day": 0}
    path = tmp_path / "models.yaml"
    path.write_text(yaml.safe_dump(raw, sort_keys=True), encoding="utf-8")
    monkeypatch.setenv(registry.PATH_ENV, str(path))
    registry.clear_cache()
    monkeypatch.setenv(breaker.STATE_DIR_ENV, str(tmp_path / "ai_spend"))
    try:
        items, _ = DG.items_from_report(report)
        called = []  # type: List[Any]

        def _factory():
            called.append(1)
            raise AssertionError("a tripped breaker must never construct a client")

        brief = FB.compose_brief(items, AS_OF, "firm-fc8", client_factory=_factory,
                                 state_dir=tmp_path / "ai_spend")
        assert called == []
        assert brief["degraded"] is True
        assert brief["advisory"]["kind"] == "breaker_open"
        assert "max_calls_per_day reached" in brief["advisory"]["reason"]
        assert brief["item_count"] == len(items)
    finally:
        registry.clear_cache()


class _StubClient(object):
    """Shaped like the client `call_strict_json` drives."""

    def __init__(self, payload: Any) -> None:
        self.payload = payload
        self.calls = 0

    @property
    def messages(self) -> "_StubClient":
        return self

    def create(self, **kwargs: Any) -> Any:
        self.calls += 1
        text = self.payload if isinstance(self.payload, str) else json.dumps(self.payload)
        block = type("Block", (), {"type": "text", "text": text})()
        return type("Resp", (), {"content": [block]})()


def _good_draft(view: FB.BriefView) -> Dict[str, Any]:
    ids = view.item_ids()
    return {"opening": "A busy morning; the balance-sheet control total comes first.",
            "groups": [{"title": "Act now", "item_ids": ids[:1],
                        "rationale": "The control total is the one item that changes every figure."},
                       {"title": "Everything else", "item_ids": ids[1:],
                        "rationale": "Work down the list in the engine's order."}],
            "suggested_order": list(reversed(ids))}


def test_fc8_model_may_suggest_but_never_ranks(model_dead, report):
    """An accepted draft with a REVERSED suggested order: `order` is
    still the deterministic order, byte for byte, and the suggestion
    ships beside it labeled advisory."""
    items, _ = DG.items_from_report(report)
    view = FB.build_view(items, AS_OF, "firm-fc8")
    draft = _good_draft(view)
    brief = FB.compose_brief(items, AS_OF, "firm-fc8", client_factory=lambda: _StubClient(draft),
                             state_dir=model_dead)
    assert brief["advisory"]["available"] is True
    assert [r["item_id"] for r in brief["order"]] == view.item_ids()
    assert brief["advisory"]["suggested_order"] == list(reversed(view.item_ids()))
    assert brief["advisory"]["suggested_order"] != [r["item_id"] for r in brief["order"]]
    assert [g["item_ids"] for g in brief["groups"]] == [g.to_payload()["item_ids"] for g in view.groups]


def test_fc8_a_model_numeral_is_rejected_at_parse_and_never_shipped(model_dead, report):
    """PLANT: the model writes a figure. The whole draft is refused, the
    deterministic brief ships, and the planted digits are nowhere in the
    payload."""
    items, _ = DG.items_from_report(report)
    view = FB.build_view(items, AS_OF, "firm-fc8")
    draft = _good_draft(view)
    # a figure the engine NEVER computed, plus a loose currency word
    draft["opening"] = "Carniprod's control total drifts by 8,999,999 RON, about 7.9% of assets."
    brief = FB.compose_brief(items, AS_OF, "firm-fc8", client_factory=lambda: _StubClient(draft),
                             state_dir=model_dead)
    assert brief["degraded"] is True and brief["advisory"]["kind"] == "rejected"
    assert "bare_numeral" in brief["advisory"]["reason"]
    blob = json.dumps(brief, ensure_ascii=False)
    assert "8,999,999" not in blob and "7.9%" not in blob and "drifts by" not in blob
    assert brief["item_count"] == len(items)
    # and even the engine's OWN figure, copied by the model with a loose
    # currency label, is refused: the placeholder carries the label
    draft["opening"] = "Carniprod's control total drifts by 8,562,437.54 RON."
    brief2 = FB.compose_brief(items, AS_OF, "firm-fc8", client_factory=lambda: _StubClient(draft),
                              state_dir=model_dead)
    assert brief2["advisory"]["kind"] == "rejected"
    assert "drifts by" not in json.dumps(brief2, ensure_ascii=False)


def test_fc8_a_model_that_drops_an_item_is_refused_as_suppression(model_dead, report):
    items, _ = DG.items_from_report(report)
    view = FB.build_view(items, AS_OF, "firm-fc8")
    draft = _good_draft(view)
    draft["groups"] = [draft["groups"][0]]
    draft["suggested_order"] = view.item_ids()[:1]
    brief = FB.compose_brief(items, AS_OF, "firm-fc8", client_factory=lambda: _StubClient(draft),
                             state_dir=model_dead)
    assert brief["advisory"]["available"] is False
    assert "suppression" in brief["advisory"]["reason"]
    assert brief["item_count"] == len(items), "the deterministic brief still carries every item"


def test_fc8_the_model_never_sees_a_figure(report):
    """C1, applied to the brief: no rendered fact value reaches the
    language channel; prose fields carry no digit; figures are named
    placeholders only."""
    items, _ = DG.items_from_report(report)
    view = FB.build_view(items, AS_OF, "firm-fc8")
    text = FB.user_text(view)
    for item in items:
        for fact in item.facts:
            if fact.is_absent():
                continue
            if fact.kind in ("money", "ratio"):
                assert fact.render() not in text, (fact.name, fact.render())
            elif fact.kind == "count" and len(fact.render()) >= 3:
                assert fact.render() not in text, (fact.name, fact.render())
    data = json.loads(text)
    for row in data["items"]:
        for field in ("client", "status", "reason", "action"):
            assert not re.search(r"\d", row[field]), (field, row[field])
        for label in row["fact_labels"].values():
            assert not re.search(r"\d", label), label
        assert row["placeholders"], "figures are offered as placeholders"


def test_fc8_plant_model_call_in_ranking_path_reds_the_structural_assertion(tmp_path):
    """PLANT, on a copy of the ranking file: (a) an AI import, (b) a
    client call token. Each alone must red `critical_path_violations`;
    the unplanted files must be clean."""
    assert DG.critical_path_violations() == []
    clean = DG.CRITICAL_PATH_FILES
    digest_src = (REPO / "src" / "engine" / "firm" / "digest.py").read_text("utf-8")
    cadence_src = (REPO / "src" / "engine" / "firm" / "cadence.py").read_text("utf-8")
    # (a) an import of the breaker in the order/digest file
    planted = tmp_path / "digest.py"
    planted.write_text(digest_src.replace("from . import model as _model",
                                          "from . import model as _model\nfrom engine.ai import breaker  # PLANT",
                                          1), encoding="utf-8")
    violations = DG.critical_path_violations([planted] + list(clean[:1]))
    assert any("digest.py imports engine.ai" in v for v in violations), violations
    with pytest.raises(DG.CriticalPathViolation):
        DG.assert_no_model_in_critical_path([planted])
    # (b) a client call inside the cadence verdict
    planted2 = tmp_path / "cadence.py"
    planted2.write_text(cadence_src.replace(
        "    latest_due = latest_due_period_end(cadence, day)\n",
        "    latest_due = latest_due_period_end(cadence, day)\n"
        "    _client.messages.create(model='x', messages=[])  # PLANT\n", 1), encoding="utf-8")
    violations = DG.critical_path_violations([planted2])
    assert any("messages.create" in v for v in violations), violations
    # (c) the router refuses to mount over a planted ranking path
    import engine.api._firm_brief as brief_module

    original = DG.critical_path_violations
    try:
        DG.critical_path_violations = lambda paths=DG.CRITICAL_PATH_FILES: ["digest.py imports anthropic"]
        with pytest.raises(DG.CriticalPathViolation):
            brief_module.build_router()
    finally:
        DG.critical_path_violations = original
    assert DG.critical_path_violations() == []


def test_fc8_the_one_model_role_is_registered_with_explicit_caps():
    """`firm_brief` is in the registry with breaker caps written in the
    row itself, not inherited from `defaults`."""
    raw = yaml.safe_load((REPO / "src" / "engine" / "ai" / "models.yaml").read_text("utf-8"))
    role = raw["roles"]["firm_brief"]
    assert "breaker" in role, "firm_brief must not inherit the default caps"
    assert set(role["breaker"]) == {"max_calls_per_day", "max_tokens_per_day"}
    assert role["temperature"] == 0
    params = registry.params_for("firm_brief")
    assert params["breaker"] == role["breaker"]
    assert params["prompt_version"] == "firm_brief_v1"
    assert FB.ROLE == "firm_brief"


# ══ THE NO-NAME-BRANCHES RULE, over this lane's four modules ═════════════

LANE_FILES = (
    REPO / "src" / "engine" / "firm" / "cadence.py",
    REPO / "src" / "engine" / "firm" / "digest.py",
    REPO / "src" / "engine" / "api" / "_firm_requests.py",
    REPO / "src" / "engine" / "api" / "_firm_brief.py",
)


def _compared_string_literals(path: Path) -> List[str]:
    tree = ast.parse(path.read_text("utf-8"))
    out = []  # type: List[str]
    for node in ast.walk(tree):
        if isinstance(node, ast.Compare):
            for side in [node.left] + list(node.comparators):
                if isinstance(side, ast.Constant) and isinstance(side.value, str):
                    out.append(side.value)
    return out


def test_no_firm_client_or_profile_name_branch_in_the_lane():
    from engine.api import _company_profile as CP

    profile_ids = set(p.id for p in CP.load_catalog().structural_profiles)
    names = {"carniprod", "scandia", "agras", "eei", "exemplu"}
    cadence_ids = set(CAD.load_cadence_pack().cadences)
    offenders = []  # type: List[str]
    for path in LANE_FILES:
        for literal in _compared_string_literals(path):
            low = literal.lower()
            if literal in profile_ids or literal in cadence_ids or any(n in low for n in names):
                offenders.append("%s compares against %r" % (path.name, literal))
    assert not offenders, offenders


def test_cadence_and_digest_read_no_clock():
    """`as_of` is explicit everywhere in the deterministic half."""
    for path in DG.CRITICAL_PATH_FILES:
        source = path.read_text("utf-8")
        assert "date.today()" not in source, path.name
        assert "datetime.now(" not in source, path.name
        assert "datetime.utcnow(" not in source, path.name
