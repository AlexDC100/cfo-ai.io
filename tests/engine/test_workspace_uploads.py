"""ONE COMPANY PER WORKSPACE — the upload flow's backend, on the REAL app.

Every request below goes through ``engine.api.create_app()`` — the object
``python -m engine serve`` runs — with its middleware (the body cap
included), its routing and every wall on the path. Nothing on the request
path is intercepted. What is doubled: PostgREST and Storage
(``WorkspaceDouble``: the tenancy suite's projection-faithful double, which
refuses a column no migration declares, plus the two RPCs and the storage
write the flow uses) and the three things a unit of this size must not do
for real — run an analysis thread, meter a real account, and (until the
identifier is merged) read a real workbook. Bearers are real ES256 tokens,
verified against the session's test JWKS.

THE DOUBLE IS PRODUCTION-SHAPED WHERE IT MATTERS: ``organizations`` carries
NO ``cui`` (and no ``firm_id``) — schema_phase_firm.sql, which adds them, is
not applied in production — so any read or write of ``organizations.cui``
400s here exactly as it would there. The CUI lives in
``org_prefs.prefs.cui``.

WHAT IT REDS ON (TC-11, with the flow correct):
  · G1 — a file whose CUI is another of the caller's companies landing
    anywhere but THAT company (identify's target, commit's document row,
    its storage prefix, the response's org/company name);
  · G2 — a period taken from the file NAME being offered as the period; a
    commit without a confirmed period (or with an implausible one) being
    accepted; the stored document not carrying the confirmed period as its
    hint;
  · G4 — identify or commit writing a ``financial_periods`` row; a failed
    analysis leaving the period it created; a period with no live analysed
    source document appearing as a year;
  · a duplicate (same bytes, same account, same company, same period) being
    stored, analysed or metered — and a different account / failed / deleted
    document being treated as a duplicate;
  · authz — a non-member's commit / years being served (not 403), or
    moving any row or storing any object; a forged bearer served (not 401);
  · the meter — a 402 / 429 answered differently from /api/pipeline/run, or
    anything (a company, an object, a row) created before it answers;
  · a new company without its owner membership or its org_prefs identity,
    or a second company for a CUI the caller already holds;
  · years — revenue that is not the served ``FactsGateway.revenue`` of the
    same envelope, a change against a non-matching month, a missing year;
  · the workspace_v2 flag not served as ``preview``, or CFO_FEATURES_ACTIVE
    not promoting it on the NEXT request of the same app.

Python 3.9 — no ``match``, no ``X | Y`` unions.
"""
from __future__ import annotations

import copy
import glob
import hashlib
import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Dict, List, Optional

import pytest
from fastapi.testclient import TestClient

import _real_app_comparatives as RA
import firm_postgrest_double as D
from engine.api import _features, _supabase, _uploads, _usage_gate, pipeline

REPO = Path(__file__).resolve().parents[2]

USER = "5c0a0000-0000-4000-8000-0000000000a1"
TEAMMATE = "5c0a0000-0000-4000-8000-0000000000a2"
OUTSIDER = "5c0a0000-0000-4000-8000-0000000000b1"
ORG_SCANDIA = "0a9a0000-0000-4000-8000-000000000051"
ORG_AGRAS = "0a9a0000-0000-4000-8000-0000000000a9"
ORG_ARCHIVED = "0a9a0000-0000-4000-8000-0000000000de"
ORG_OUTSIDE = "0a9a0000-0000-4000-8000-0000000000ff"
CUI_SCANDIA = "16070576"
CUI_AGRAS = "4278990"
CUI_OUTSIDE = "31415926"
CUI_NEW = "46355095"

XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

#: The tables the flow reads or writes.
TABLES = ("organizations", "memberships", "org_prefs", "user_prefs", "documents",
          "financial_periods", "statement_line_items", "industry_profiles",
          "calculated_metrics")


def _migration_columns() -> Dict[str, List[str]]:
    """`create table` + `alter table … add column` over supabase/*.sql, for
    TABLES — then shaped to PRODUCTION where the repo's migrations and
    production disagree (both named, both deliberate)."""
    cols = {}  # type: Dict[str, List[str]]
    for path in sorted(glob.glob(str(REPO / "supabase" / "*.sql"))):
        text = Path(path).read_text(encoding="utf-8")
        for table, names in D.parse_table_columns(text).items():
            have = cols.setdefault(table, [])
            have += [n for n in names if n not in have]
        bare = "\n".join(line.split("--", 1)[0] for line in text.splitlines())
        for m in RA._ALTER_RX.finditer(bare):
            have = cols.setdefault(m.group(1).lower(), [])
            have += [n for n in RA._ADD_RX.findall(m.group(2)) if n not in have]
    out = dict((t, list(cols[t])) for t in TABLES)
    # schema_phase_firm.sql adds organizations.firm_id / .cui; it is NOT
    # applied in production. A read of either must 400 here as it would there.
    out["organizations"] = [c for c in out["organizations"] if c not in ("cui", "firm_id")]
    # Production columns no migration in this repository declares (they
    # predate the migrations) — the same three test_identity_wall adds.
    for col in ("deleted_at", "display_name", "is_active"):
        if col not in out["documents"]:
            out["documents"].append(col)
    return out


class _UserClient(object):
    """`_supabase.per_user(jwt)` over the double: the same rows, the identity
    the VERIFIER gave, and the two SECURITY DEFINER RPCs the flow calls —
    each re-asserting what its SQL re-asserts (schema_phase_multi_workspace
    / schema_phase_prefs)."""

    def __init__(self, db: "WorkspaceDouble", uid: Optional[str]) -> None:
        self.db = db
        self.uid = uid

    def __enter__(self) -> "_UserClient":
        return self

    def __exit__(self, *_: Any) -> None:
        return None

    def close(self) -> None:
        return None

    def select(self, *a: Any, **kw: Any) -> List[Dict[str, Any]]:
        return self.db.select(*a, **kw)

    def insert(self, *a: Any, **kw: Any) -> List[Dict[str, Any]]:
        return self.db.insert(*a, **kw)

    def update(self, *a: Any, **kw: Any) -> None:
        return self.db.update(*a, **kw)

    def delete(self, *a: Any, **kw: Any) -> None:
        return self.db.delete(*a, **kw)

    def rpc(self, fn: str, params: Optional[Dict[str, Any]] = None) -> Any:
        params = params or {}
        self.db.rpcs.append((fn, self.uid, copy.deepcopy(params)))
        if not self.uid:
            raise RuntimeError("rpc %s failed (401): not authenticated" % fn)
        if fn == "create_workspace":
            name = str(params.get("p_name") or "").strip()
            if not name:
                raise RuntimeError("rpc create_workspace failed (400): name required")
            org = self.db.add("organizations", {"id": None, "name": name,
                                                "industry_key": params.get("p_industry_key"),
                                                "industry_display_name": params.get("p_industry_display")})
            self.db.add("memberships", {"user_id": self.uid, "org_id": org["id"], "role": "owner"})
            return org["id"]
        if fn == "set_org_pref":
            org_id = params["p_org_id"]
            if not any(m["user_id"] == self.uid and m["org_id"] == org_id
                       for m in self.db.rows("memberships")):
                raise RuntimeError("rpc set_org_pref failed (403): not a member")
            row = next((r for r in self.db.rows("org_prefs") if r["org_id"] == org_id), None)
            if row is None:
                row = self.db.add("org_prefs", {"org_id": org_id, "prefs": {}})
            row["prefs"] = dict(row.get("prefs") or {}, **{params["p_key"]: copy.deepcopy(params["p_value"])})
            return row["prefs"]
        raise AssertionError("unexpected rpc %s" % fn)


class WorkspaceDouble(D.PostgrestDouble):
    """The projection-faithful PostgREST double, plus Storage."""

    def __init__(self) -> None:
        super(WorkspaceDouble, self).__init__(columns=_migration_columns())
        self.storage = {}  # type: Dict[str, bytes]
        self.rpcs = []  # type: List[Any]

    def upload_object(self, bucket: str, path: str, content: bytes, *, org_id: str,
                      content_type: str = "application/octet-stream") -> None:
        # The REAL tenant guard, exactly as SupabaseClient.upload_object runs it.
        _supabase.assert_tenant_path(bucket, path, org_id, op="upload")
        key = "%s/%s" % (bucket, path)
        if key in self.storage:
            raise RuntimeError("Storage upload to %s failed (HTTP 409): exists" % key)
        self.storage[key] = content

    def delete_object(self, bucket: str, path: str, *, org_id: str) -> None:
        _supabase.assert_tenant_path(bucket, path, org_id, op="delete")
        self.storage.pop("%s/%s" % (bucket, path), None)

    def rpc(self, fn: str, params: Optional[Dict[str, Any]] = None) -> Any:
        raise AssertionError("the flow calls no RPC as the service role (%s)" % fn)

    def snapshot(self) -> str:
        # An empty table and an absent one are the same state (a select
        # materialises the list).
        tables = dict((k, v) for k, v in self.tables.items() if v)
        return json.dumps({"tables": tables, "storage": sorted(self.storage)},
                          sort_keys=True, default=str)


# ── The app and the world ────────────────────────────────────────────────


@pytest.fixture(scope="module")
def app():
    return RA.build_app()


def _identity(cui: Optional[str] = None, name: Optional[str] = None,
              period_end: Optional[str] = "2025-12-31", period_signal: str = "in_document",
              caen: Optional[str] = None, industry: Optional[str] = None,
              name_signal: str = "document_header") -> SimpleNamespace:
    sources = {}  # type: Dict[str, Dict[str, str]]
    if cui:
        sources["cui"] = {"signal": "document_header_cui", "evidence": "Cod fiscal: RO%s" % cui}
    if name:
        sources["company_name"] = {"signal": name_signal, "evidence": name}
    if period_end:
        sources["period_end"] = {"signal": period_signal, "evidence": "31.12.2025"}
    if caen:
        sources["caen_code"] = {"signal": "registry", "evidence": "registry CUI %s" % cui}
    if industry:
        sources["industry_key"] = {"signal": "caen_catalogue", "evidence": "CAEN %s" % caen}
    return SimpleNamespace(cui=cui, company_name=name, period_end=period_end, caen_code=caen,
                           industry_key=industry, sources=sources, document_kind="trial_balance")


class World(object):
    def __init__(self, db: WorkspaceDouble) -> None:
        self.db = db
        self.identities = {}  # type: Dict[str, Any]
        self.identify_calls = []  # type: List[str]
        self.enqueued = []  # type: List[str]
        self.reserved_for = []  # type: List[str]
        self.released = []  # type: List[Any]
        self.decision = "disabled"

    def docs(self, **match: Any) -> List[Dict[str, Any]]:
        return [d for d in self.db.rows("documents")
                if all(d.get(k) == v for k, v in match.items())]


@pytest.fixture()
def world(app, monkeypatch):
    db = WorkspaceDouble()
    for org_id, name in ((ORG_SCANDIA, "Scandia Food SRL"), (ORG_AGRAS, "Agras SA"),
                         (ORG_ARCHIVED, "Old Company SRL"), (ORG_OUTSIDE, "Outside SRL")):
        db.add("organizations", {"id": org_id, "name": name, "default_currency": "RON",
                                 "industry_key": "food_manufacturing",
                                 "archived_at": "2026-09-01T00:00:00+00:00" if org_id == ORG_ARCHIVED else None,
                                 "created_at": "2026-01-01T00:00:00+00:00"})
    for i, org_id in enumerate((ORG_SCANDIA, ORG_AGRAS, ORG_ARCHIVED)):
        db.add("memberships", {"user_id": USER, "org_id": org_id, "role": "owner",
                               "created_at": "2026-01-0%dT00:00:00+00:00" % (i + 1)})
    db.add("memberships", {"user_id": TEAMMATE, "org_id": ORG_SCANDIA, "role": "member",
                           "created_at": "2026-01-05T00:00:00+00:00"})
    db.add("memberships", {"user_id": OUTSIDER, "org_id": ORG_OUTSIDE, "role": "owner",
                           "created_at": "2026-01-01T00:00:00+00:00"})
    for org_id, cui in ((ORG_SCANDIA, CUI_SCANDIA), (ORG_AGRAS, CUI_AGRAS),
                        (ORG_ARCHIVED, CUI_NEW), (ORG_OUTSIDE, CUI_OUTSIDE)):
        db.add("org_prefs", {"org_id": org_id, "prefs": {"cui": cui, "display_currency": "RON"}})
    db.add("industry_profiles", {"key": "food_manufacturing", "display_name": "Food manufacturing",
                                 "display_name_ro": "Industria alimentara"})
    w = World(db)

    def _identify(content: bytes, filename: str, registry: Any) -> Any:
        w.identify_calls.append(filename)
        return w.identities[filename]

    def _reserve(user_id: str) -> Any:
        w.reserved_for.append(user_id)
        return _usage_gate.DocReserveDecision(
            kind=w.decision, plan_key="professional", used=12, reserved=0, cap=12,
            extra_doc_eur=3.0, message="quota", was_extra=False)

    for key in ("CFO_FEATURES_ACTIVE", "USAGE_LIMITS_ENABLED", "PUBLIC_TEST_MODE"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setattr(_supabase, "per_user", lambda jwt: _UserClient(db, D.verified_identity(jwt).get("id")))
    monkeypatch.setattr(_supabase, "admin", lambda: db)
    monkeypatch.setattr(_uploads, "_identify_document", _identify)
    monkeypatch.setattr(pipeline, "_enqueue", lambda doc_id: w.enqueued.append(doc_id))
    monkeypatch.setattr(_usage_gate, "reserve_document", _reserve)
    monkeypatch.setattr(_usage_gate, "enforcement_enabled", lambda: True)
    monkeypatch.setattr(_usage_gate, "release_document",
                        lambda uid, was_extra: w.released.append((uid, was_extra)))
    return w


def _client(app) -> TestClient:
    return TestClient(app, raise_server_exceptions=False)


def _headers(user: str, org: Optional[str] = None, token: Optional[str] = None) -> Dict[str, str]:
    out = {"Authorization": "Bearer %s" % (token or D.mint_jwt(user))}
    if org:
        out["X-Org-Id"] = org
    return out


def _file(name: str = "balanta.xlsx", body: bytes = b"PK\x03\x04 a trial balance") -> Dict[str, Any]:
    return {"file": (name, body, XLSX)}


def identify(app, user: str = USER, org: Optional[str] = ORG_SCANDIA, name: str = "balanta.xlsx",
             body: bytes = b"PK\x03\x04 a trial balance", token: Optional[str] = None):
    return _client(app).post("/api/uploads/identify", headers=_headers(user, org, token),
                             files=_file(name, body))


def commit(app, user: str = USER, name: str = "balanta.xlsx", body: bytes = b"PK\x03\x04 a trial balance",
           token: Optional[str] = None, **data: Any):
    form = dict((k, v if isinstance(v, str) else json.dumps(v)) for k, v in data.items() if v is not None)
    return _client(app).post("/api/uploads/commit", headers=_headers(user, None, token),
                             files=_file(name, body), data=form)


def _seed_doc(world: World, *, org: str, body: bytes, user: str = USER, status: str = "analyzed",
              period_end: Optional[str] = "2025-12-31", with_period: bool = True,
              deleted: bool = False) -> Dict[str, Any]:
    doc = world.db.add("documents", {
        "id": None, "org_id": org, "uploaded_by": user, "storage_path": "%s/uploads/x.xlsx" % org,
        "original_filename": "earlier.xlsx", "mime_type": XLSX, "size_bytes": len(body),
        "status": status, "scope": "financial", "content_hash": hashlib.sha256(body).hexdigest(),
        "period_end_hint": period_end, "created_at": "2026-02-01T00:00:00+00:00",
        "deleted_at": "2026-03-01T00:00:00+00:00" if deleted else None})
    if with_period and period_end:
        period = world.db.add("financial_periods", {"id": None, "org_id": org, "source_document_id": doc["id"],
                                                    "period_start": period_end, "period_end": period_end,
                                                    "currency": "RON"})
        doc["period_id"] = period["id"]
    return doc


# ══════════════════════════════════════════════════════════════════════
# The flag
# ══════════════════════════════════════════════════════════════════════


def test_workspace_v2_is_served_as_preview_and_env_promotes_it_per_request(app, monkeypatch):
    monkeypatch.delenv("CFO_FEATURES_ACTIVE", raising=False)
    row = _client(app).get("/api/features/status").json()["features"]["workspace_v2"]
    assert row["status"] == "preview" and row["endpoint"] == "/api/uploads/identify", row
    # The SAME app, the next request: no rebuild, no restart.
    monkeypatch.setenv("CFO_FEATURES_ACTIVE", " workspace_v2 , not_a_feature,,")
    feats = _client(app).get("/api/features/status").json()["features"]
    assert feats["workspace_v2"]["status"] == "active"
    assert "not_a_feature" not in feats, "an unknown key must never be invented"
    assert _features.FEATURES["workspace_v2"]["status"] == "preview", "the registry itself was mutated"
    monkeypatch.delenv("CFO_FEATURES_ACTIVE")
    assert _client(app).get("/api/features/status").json()["features"]["workspace_v2"]["status"] == "preview"


def test_env_promotion_never_demotes_and_leaves_other_rows_alone(monkeypatch):
    env = {"CFO_FEATURES_ACTIVE": "forecast"}
    feats = _features.effective_features(env)
    assert feats["forecast"]["status"] == "active"
    assert feats["dashboard"]["status"] == "active"
    assert feats["workspace_v2"]["status"] == "preview"
    assert _features.FEATURES["forecast"]["status"] == "coming_soon"
    assert _features.promoted_keys({}) == frozenset()


# ══════════════════════════════════════════════════════════════════════
# POST /api/uploads/identify
# ══════════════════════════════════════════════════════════════════════


def test_identify_routes_another_companys_cui_to_that_company_g1(app, world):
    """G1 (backend half): an Agras file dropped while Scandia is on screen
    targets AGRAS. Nothing is stored, reserved or created."""
    world.identities["balanta.xlsx"] = _identity(cui="RO " + CUI_AGRAS, name="AGRAS S.A.",
                                                 caen="1011", industry="food_manufacturing")
    before = world.db.snapshot()
    r = identify(app, org=ORG_SCANDIA)
    assert r.status_code == 200, r.text[:400]
    body = r.json()
    assert body["target"] == {"org_id": ORG_AGRAS, "name": "Agras SA", "is_new": False,
                              "reason": "cui_match"}, body["target"]
    assert body["identity"]["cui"] == CUI_AGRAS
    assert body["identity"]["period_end"] == "2025-12-31"
    assert body["identity"]["industry_label"] == "Food manufacturing"
    assert body["identity"]["sources"]["cui"]["signal"] == "document_header_cui"
    assert body["content_hash"] == hashlib.sha256(b"PK\x03\x04 a trial balance").hexdigest()
    assert body["duplicate"] is None
    # The caller's LIVE companies only: the archived one and the outsider's are not places to land.
    assert body["companies"] == [{"org_id": ORG_SCANDIA, "name": "Scandia Food SRL", "cui": CUI_SCANDIA},
                                 {"org_id": ORG_AGRAS, "name": "Agras SA", "cui": CUI_AGRAS}]
    assert world.db.snapshot() == before, "identify wrote something"
    assert world.reserved_for == [] and world.enqueued == []


def test_identify_names_a_new_company_for_a_cui_none_of_mine_hold(app, world):
    world.identities["balanta.xlsx"] = _identity(cui=CUI_OUTSIDE, name="Nou Business SRL")
    body = identify(app, org=ORG_SCANDIA).json()
    # CUI_OUTSIDE belongs to ANOTHER user's company: not mine, so it is new to me.
    assert body["target"] == {"org_id": None, "name": "Nou Business SRL", "is_new": True,
                              "reason": "new_cui"}, body["target"]
    assert body["duplicate"] is None


def test_identify_without_a_readable_cui_lands_on_the_company_on_screen(app, world):
    world.identities["balanta.xlsx"] = _identity(cui=None, name=None)
    body = identify(app, org=ORG_AGRAS).json()
    assert body["target"] == {"org_id": ORG_AGRAS, "name": "Agras SA", "is_new": False,
                              "reason": "on_screen_company"}, body["target"]


def test_identify_with_no_company_on_screen_uses_the_callers_oldest_live_company(app, world):
    """No X-Org-Id (a cached bundle, a server-to-server call): the same
    fallback every route takes — the oldest LIVE membership — never an
    archived one."""
    world.identities["balanta.xlsx"] = _identity(cui=None, name=None)
    body = identify(app, org=None).json()
    assert body["target"]["org_id"] == ORG_SCANDIA and body["target"]["reason"] == "on_screen_company", body


def test_a_name_read_only_off_the_file_name_never_keys_a_company(app, world):
    """The on-screen pre-CUI workspace is adopted by NAME only when the
    DOCUMENT states the name — a name typed into the file name is shown,
    never matched."""
    world.db.rows("org_prefs")[:] = [p for p in world.db.rows("org_prefs") if p["org_id"] != ORG_SCANDIA]
    world.identities["Scandia Food.xlsx"] = _identity(cui="12345678", name="Scandia Food",
                                                      name_signal="filename")
    target = identify(app, name="Scandia Food.xlsx").json()["target"]
    assert target["is_new"] is True and target["reason"] == "new_cui", target


def test_identify_never_offers_a_period_read_off_the_file_name_g2(app, world):
    """G2: 'balanta_2019_12.xlsx' whose only date is its NAME gets no period
    — the card asks; a period the DOCUMENT states is offered."""
    world.identities["balanta_2019_12.xlsx"] = _identity(cui=CUI_SCANDIA, period_end="2019-12-31",
                                                         period_signal="filename")
    body = identify(app, name="balanta_2019_12.xlsx").json()
    assert body["identity"]["period_end"] is None, body["identity"]
    assert body["identity"]["sources"]["period_end"]["signal"] == "none"
    world.identities["balanta_2019_12.xlsx"] = _identity(cui=CUI_SCANDIA, period_end="2025-12-31",
                                                         period_signal="in_document")
    assert identify(app, name="balanta_2019_12.xlsx").json()["identity"]["period_end"] == "2025-12-31"


def test_identify_reports_the_duplicate_only_for_the_same_account_company_and_period(app, world):
    body = b"PK\x03\x04 the same bytes"
    world.identities["balanta.xlsx"] = _identity(cui=CUI_SCANDIA)
    mine = _seed_doc(world, org=ORG_SCANDIA, body=body)
    got = identify(app, body=body).json()["duplicate"]
    assert got == {"document_id": mine["id"], "period_id": mine["period_id"], "org_id": ORG_SCANDIA}, got
    # Another period stated by the document: not a duplicate.
    world.identities["balanta.xlsx"] = _identity(cui=CUI_SCANDIA, period_end="2024-12-31")
    assert identify(app, body=body).json()["duplicate"] is None
    # Another ACCOUNT's upload of the same bytes: not mine to dedupe against.
    world.identities["balanta.xlsx"] = _identity(cui=CUI_SCANDIA)
    world.db.rows("documents")[:] = []
    _seed_doc(world, org=ORG_SCANDIA, body=body, user=TEAMMATE)
    assert identify(app, body=body).json()["duplicate"] is None
    # A failed or deleted earlier upload may be sent again.
    world.db.rows("documents")[:] = []
    _seed_doc(world, org=ORG_SCANDIA, body=body, status="failed", with_period=False)
    _seed_doc(world, org=ORG_SCANDIA, body=body, deleted=True, with_period=False)
    assert identify(app, body=body).json()["duplicate"] is None


def test_identify_refuses_a_forged_bearer_and_a_company_that_is_not_mine(app, world):
    world.identities["balanta.xlsx"] = _identity(cui=CUI_SCANDIA)
    r = identify(app, token=D.forged_jwt(USER))
    assert r.status_code == 401, (r.status_code, r.text[:200])
    r = identify(app, org=ORG_OUTSIDE)
    assert r.status_code == 403, (r.status_code, r.text[:200])
    assert world.identify_calls == [], "the file was read before the caller was known"


# ══════════════════════════════════════════════════════════════════════
# POST /api/uploads/commit
# ══════════════════════════════════════════════════════════════════════


def test_commit_files_the_document_in_the_confirmed_company_g1_g2_g4(app, world):
    world.identities["balanta.xlsx"] = _identity(cui=CUI_AGRAS, name="Agras SA")
    r = commit(app, target_org_id=ORG_AGRAS, period_end="2025-12-31", output_language="ro")
    assert r.status_code == 200, r.text[:400]
    out = r.json()
    assert out["status"] == "queued" and out["org_id"] == ORG_AGRAS and out["company_name"] == "Agras SA", out
    assert out["created_company"] is False and out["period_end"] == "2025-12-31"
    (doc,) = world.docs(id=out["document_id"])
    assert doc["org_id"] == ORG_AGRAS and doc["uploaded_by"] == USER
    assert doc["storage_path"].startswith(ORG_AGRAS + "/uploads/"), doc["storage_path"]
    assert doc["period_end_hint"] == "2025-12-31", "G2: the confirmed period is the hint"
    assert doc["content_hash"] == hashlib.sha256(b"PK\x03\x04 a trial balance").hexdigest()
    assert doc["status"] == "queued" and doc["pipeline_started_at"], doc
    assert doc["detected_language"] == "ro" and doc["period_id"] is None
    assert world.db.storage["documents/" + doc["storage_path"]] == b"PK\x03\x04 a trial balance"
    assert world.enqueued == [doc["id"]] and world.reserved_for == [USER]
    assert world.db.rows("financial_periods") == [], "G4: commit created a period"


def test_commit_refuses_a_company_the_caller_is_not_a_member_of(app, world):
    world.identities["balanta.xlsx"] = _identity(cui=CUI_OUTSIDE)
    before = world.db.snapshot()
    r = commit(app, target_org_id=ORG_OUTSIDE, period_end="2025-12-31")
    assert r.status_code == 403, (r.status_code, r.text[:200])
    r = commit(app, target_org_id=ORG_SCANDIA, period_end="2025-12-31", token=D.forged_jwt(USER))
    assert r.status_code == 401, (r.status_code, r.text[:200])
    assert world.db.snapshot() == before and world.reserved_for == [] and world.enqueued == []


@pytest.mark.parametrize("period_end,code", [(None, "invalid_period_end"), ("", "invalid_period_end"),
                                             ("31.12.2025", "invalid_period_end"),
                                             ("2050-12-31", "implausible_period_end")])
def test_commit_never_invents_a_period(app, world, period_end, code):
    world.identities["balanta.xlsx"] = _identity(cui=CUI_SCANDIA)
    before = world.db.snapshot()
    r = commit(app, target_org_id=ORG_SCANDIA, period_end=period_end)
    assert r.status_code == 422, (r.status_code, r.text[:200])
    assert r.json()["detail"]["code"] == code, r.json()
    assert world.db.snapshot() == before and world.reserved_for == []


def test_commit_needs_a_target(app, world):
    world.identities["balanta.xlsx"] = _identity(cui=CUI_SCANDIA)
    r = commit(app, period_end="2025-12-31")
    assert r.status_code == 422 and r.json()["detail"]["code"] == "target_required", r.text[:200]


def test_commit_does_not_store_analyse_or_count_a_duplicate(app, world):
    body = b"PK\x03\x04 the same bytes"
    world.identities["balanta.xlsx"] = _identity(cui=CUI_SCANDIA)
    mine = _seed_doc(world, org=ORG_SCANDIA, body=body)
    before = world.db.snapshot()
    r = commit(app, body=body, target_org_id=ORG_SCANDIA, period_end="2025-12-31")
    assert r.status_code == 200, r.text[:300]
    assert r.json() == {"status": "duplicate", "document_id": mine["id"], "period_id": mine["period_id"],
                        "org_id": ORG_SCANDIA, "company_name": "Scandia Food SRL"}, r.json()
    assert world.db.snapshot() == before, "a duplicate was stored"
    assert world.reserved_for == [] and world.enqueued == [], "a duplicate was metered or analysed"
    # The same bytes confirmed for ANOTHER period are a new analysis.
    r = commit(app, body=body, target_org_id=ORG_SCANDIA, period_end="2024-12-31")
    assert r.json()["status"] == "queued", r.text[:300]


def test_commit_creates_a_new_company_with_its_owner_and_identity(app, world):
    world.identities["balanta.xlsx"] = _identity(cui=CUI_NEW, name="Nou Business SRL", caen="1011",
                                                 industry="food_manufacturing")
    spec = {"name": "Nou Business SRL", "cui": "RO" + CUI_NEW, "caen_code": "1011",
            "industry_key": "food_manufacturing"}
    r = commit(app, create_company=spec, period_end="2025-12-31")
    assert r.status_code == 200, r.text[:400]
    out = r.json()
    assert out["created_company"] is True and out["company_name"] == "Nou Business SRL", out
    org_id = out["org_id"]
    (org,) = [o for o in world.db.rows("organizations") if o["id"] == org_id]
    assert org["caen_code"] == "1011" and org["industry_key"] == "food_manufacturing"
    assert org["industry_display_name"] == "Food manufacturing"
    assert "cui" not in org, "organizations has no cui column in production"
    assert {"user_id": USER, "org_id": org_id, "role": "owner"} == dict(
        (k, m[k]) for m in world.db.rows("memberships") if m["org_id"] == org_id for k in ("user_id", "org_id", "role"))
    (prefs,) = [p["prefs"] for p in world.db.rows("org_prefs") if p["org_id"] == org_id]
    assert prefs["cui"] == CUI_NEW and prefs["company_name"] == "Nou Business SRL", prefs
    assert prefs["identity_sources"]["cui"]["signal"] == "document_header_cui", prefs
    (doc,) = world.docs(org_id=org_id)
    assert doc["storage_path"].startswith(org_id + "/uploads/") and world.enqueued == [doc["id"]]
    # The ARCHIVED company holding the same CUI was not reused (it is deleted).
    assert world.docs(org_id=ORG_ARCHIVED) == []
    # A second commit for the same CUI lands in the company just created — never a twin.
    r = commit(app, body=b"PK\x03\x04 next year", create_company=spec, period_end="2024-12-31")
    assert r.json()["org_id"] == org_id and r.json()["created_company"] is False, r.json()
    assert len([o for o in world.db.rows("organizations") if o["name"] == "Nou Business SRL"]) == 1


def test_commit_with_create_company_for_a_cui_i_hold_uses_that_company(app, world):
    world.identities["balanta.xlsx"] = _identity(cui=CUI_AGRAS, name="Agras SA")
    r = commit(app, create_company={"name": "Agras again", "cui": CUI_AGRAS}, period_end="2025-12-31")
    assert r.status_code == 200 and r.json()["org_id"] == ORG_AGRAS, r.text[:300]
    assert r.json()["created_company"] is False
    assert not any(o["name"] == "Agras again" for o in world.db.rows("organizations"))


@pytest.mark.parametrize("kind,status,code", [("extra_required", 402, "extra_doc_confirmation_required"),
                                              ("blocked", 429, "doc_quota_blocked")])
def test_the_meter_answers_like_pipeline_run_and_before_anything_is_created(app, world, kind, status, code):
    world.identities["balanta.xlsx"] = _identity(cui=CUI_NEW, name="Nou Business SRL")
    world.decision = kind
    before = world.db.snapshot()
    r = commit(app, create_company={"name": "Nou Business SRL", "cui": CUI_NEW}, period_end="2025-12-31")
    assert r.status_code == status and r.json()["detail"]["code"] == code, (r.status_code, r.text[:300])
    assert world.db.snapshot() == before, "a company, a row or an object exists after a refusal"
    assert world.enqueued == []
    # The SAME mapping /api/pipeline/run serves (one function, both routes).
    with pytest.raises(pipeline.HTTPException) as exc:
        pipeline.reserve_upload_or_refuse(USER)
    assert exc.value.status_code == status and exc.value.detail["code"] == code


def test_a_failed_document_insert_removes_the_object_and_hands_the_reservation_back(app, world, monkeypatch):
    world.identities["balanta.xlsx"] = _identity(cui=CUI_SCANDIA)
    real_insert = world.db.insert

    def _refuse(table: str, rows: Any, **kw: Any) -> Any:
        if table == "documents":
            raise RuntimeError("Supabase insert into documents failed (HTTP 403): RLS")
        return real_insert(table, rows, **kw)

    monkeypatch.setattr(world.db, "insert", _refuse)
    r = commit(app, target_org_id=ORG_SCANDIA, period_end="2025-12-31")
    assert r.status_code == 500, r.text[:200]
    assert world.db.storage == {}, "an object no document points at was left in storage"
    assert world.released == [(USER, False)] and world.enqueued == []


def test_a_failed_store_hands_the_reservation_back(app, world, monkeypatch):
    world.identities["balanta.xlsx"] = _identity(cui=CUI_SCANDIA)

    def _boom(*a: Any, **kw: Any) -> None:
        raise RuntimeError("Storage upload failed (HTTP 500)")

    monkeypatch.setattr(world.db, "upload_object", _boom)
    r = commit(app, target_org_id=ORG_SCANDIA, period_end="2025-12-31")
    assert r.status_code == 500, r.text[:200]
    assert world.released == [(USER, False)] and world.enqueued == [] and world.docs() == []


def test_the_industry_chosen_on_the_card_is_the_companys(app, world):
    world.identities["balanta.xlsx"] = _identity(cui=CUI_AGRAS)
    world.db.add("industry_profiles", {"key": "retail_generic", "display_name": "Retail",
                                       "display_name_ro": "Comert cu amanuntul"})
    r = commit(app, target_org_id=ORG_AGRAS, period_end="2025-12-31", industry_key="retail_generic")
    assert r.status_code == 200, r.text[:300]
    (org,) = [o for o in world.db.rows("organizations") if o["id"] == ORG_AGRAS]
    assert org["industry_key"] == "retail_generic" and org["industry_display_name"] == "Retail", org


def test_a_file_over_25_mb_is_refused_and_nothing_is_stored(app, world):
    world.identities["big.xlsx"] = _identity(cui=CUI_SCANDIA)
    before = world.db.snapshot()
    r = commit(app, name="big.xlsx", body=b"x" * (25 * 1024 * 1024 + 1), target_org_id=ORG_SCANDIA,
               period_end="2025-12-31")
    assert r.status_code == 413 and r.json()["detail"]["code"] == "file_too_large", r.text[:200]
    assert world.db.snapshot() == before and world.reserved_for == []


def test_a_workspace_from_before_cuis_adopts_the_documents_cui_only_when_its_name_matches(app, world):
    world.db.rows("org_prefs")[:] = [p for p in world.db.rows("org_prefs") if p["org_id"] != ORG_SCANDIA]
    world.identities["balanta.xlsx"] = _identity(cui=CUI_SCANDIA, name="SCANDIA FOOD S.R.L.")
    body = identify(app, org=ORG_SCANDIA).json()
    assert body["target"]["org_id"] == ORG_SCANDIA and body["target"]["reason"] == "on_screen_company"
    r = commit(app, target_org_id=ORG_SCANDIA, period_end="2025-12-31")
    assert r.status_code == 200, r.text[:300]
    (prefs,) = [p["prefs"] for p in world.db.rows("org_prefs") if p["org_id"] == ORG_SCANDIA]
    assert prefs["cui"] == CUI_SCANDIA and prefs["company_name"] == "Scandia Food SRL"
    # A differently-named company chosen by hand for the file never takes its CUI.
    world.identities["other.xlsx"] = _identity(cui="12345678", name="Totally Other SRL")
    world.db.rows("org_prefs")[:] = [p for p in world.db.rows("org_prefs") if p["org_id"] != ORG_AGRAS]
    r = commit(app, name="other.xlsx", body=b"other", target_org_id=ORG_AGRAS, period_end="2025-12-31")
    assert r.status_code == 200
    assert [p for p in world.db.rows("org_prefs") if p["org_id"] == ORG_AGRAS] == []


# ══════════════════════════════════════════════════════════════════════
# GET /api/companies/{org_id}/years
# ══════════════════════════════════════════════════════════════════════


def _envelopes():
    import _served_books as SB
    return (SB.book("agras").period["assembled_canonical_v1"],
            SB.book(SB.SCANDIA).period["assembled_canonical_v1"])


def _served(env: Dict[str, Any]) -> float:
    from engine.serving.facts import FactsGateway
    return FactsGateway.from_envelope(copy.deepcopy(env), currency="RON").revenue().to_float()


def _period(world: World, org: str, end: str, env: Optional[Dict[str, Any]], status: Optional[str] = "analyzed",
            deleted: bool = False) -> Dict[str, Any]:
    doc = None
    if status:
        doc = world.db.add("documents", {
            "id": None, "org_id": org, "uploaded_by": USER, "storage_path": "%s/uploads/y.xlsx" % org,
            "original_filename": "y.xlsx", "mime_type": XLSX, "size_bytes": 1, "status": status,
            "deleted_at": "2026-03-01T00:00:00+00:00" if deleted else None})
    return world.db.add("financial_periods", {
        "id": None, "org_id": org, "source_document_id": doc["id"] if doc else None,
        "period_start": end, "period_end": end, "currency": "RON",
        "assembled_canonical_v1": copy.deepcopy(env) if env else None,
        "updated_at": "2026-02-01T00:00:00+00:00"})


def test_years_read_the_served_revenue_and_list_only_analysed_periods(app, world):
    agras_env, scandia_env = _envelopes()
    p24 = _period(world, ORG_SCANDIA, "2024-12-31", agras_env)
    p25 = _period(world, ORG_SCANDIA, "2025-12-31", scandia_env)
    p26 = _period(world, ORG_SCANDIA, "2026-08-31", scandia_env)
    _period(world, ORG_SCANDIA, "2026-09-30", None, status=None)          # an empty container
    _period(world, ORG_SCANDIA, "2021-12-31", scandia_env, status="failed")
    _period(world, ORG_SCANDIA, "2022-12-31", scandia_env, deleted=True)
    _period(world, ORG_AGRAS, "2023-12-31", agras_env)                   # another company's
    r = _client(app).get("/api/companies/%s/years" % ORG_SCANDIA, headers=_headers(USER))
    assert r.status_code == 200, r.text[:300]
    rows = r.json()
    rev24, rev25 = _served(agras_env), _served(scandia_env)
    assert rev24 and rev25 and rev24 != rev25
    assert rows == [
        {"period_id": p24["id"], "year": 2024, "period_end": "2024-12-31", "revenue": rev24,
         "revenue_change_pct": None, "currency": "RON"},
        {"period_id": p25["id"], "year": 2025, "period_end": "2025-12-31", "revenue": rev25,
         "revenue_change_pct": round((rev25 - rev24) / abs(rev24) * 100.0, 1), "currency": "RON"},
        # August year-to-date has no August a year earlier: no change, not a fake one against December.
        {"period_id": p26["id"], "year": 2026, "period_end": "2026-08-31", "revenue": rev25,
         "revenue_change_pct": None, "currency": "RON"},
    ], json.dumps(rows, indent=1)


def test_a_period_without_an_envelope_has_no_revenue_not_zero(app, world):
    p = _period(world, ORG_AGRAS, "2025-12-31", None)
    rows = _client(app).get("/api/companies/%s/years" % ORG_AGRAS, headers=_headers(USER)).json()
    assert rows == [{"period_id": p["id"], "year": 2025, "period_end": "2025-12-31", "revenue": None,
                     "revenue_change_pct": None, "currency": "RON"}], rows


def test_years_refuse_a_company_the_caller_is_not_a_member_of(app, world):
    r = _client(app).get("/api/companies/%s/years" % ORG_OUTSIDE, headers=_headers(USER))
    assert r.status_code == 403, (r.status_code, r.text[:200])
    r = _client(app).get("/api/companies/%s/years" % ORG_SCANDIA, headers=_headers(USER, token=D.forged_jwt(USER)))
    assert r.status_code == 401, (r.status_code, r.text[:200])


# ══════════════════════════════════════════════════════════════════════
# G4 — the pipeline removes the period of a run that failed
# ══════════════════════════════════════════════════════════════════════


@pytest.fixture()
def run_world(world, monkeypatch):
    """`_run_pipeline_sync` over the double, the REAL `stage_persist`, and
    stubbed extraction / mapping / compute (this is about the period row,
    not the numbers)."""
    parsed = {"accounts": [{"code": "4111", "name": "Clienti", "amount": 10.0}], "currency": "RON",
              "confidence": 0.9, "detected_type": "trial_balance"}
    monkeypatch.setattr(pipeline, "stage_extract", lambda doc: copy.deepcopy(parsed))
    monkeypatch.setattr(pipeline, "stage_map", lambda doc, p, ind: {"lineItems": [], "statements": {}})
    state = {"compute": "raise"}

    def _compute(doc, assembled, period_id):
        if state["compute"] == "raise":
            raise RuntimeError("compute failed")
        return []

    monkeypatch.setattr(pipeline, "stage_compute", _compute)
    doc = world.db.add("documents", {
        "id": "d0c00000-0000-4000-8000-000000000001", "org_id": ORG_SCANDIA, "uploaded_by": USER,
        "storage_path": "%s/uploads/d.xlsx" % ORG_SCANDIA, "original_filename": "d.xlsx", "mime_type": XLSX,
        "size_bytes": 3, "status": "queued", "scope": "financial", "period_end_hint": "2025-12-31"})
    return SimpleNamespace(world=world, doc=doc, state=state)


def test_a_failed_analysis_removes_the_period_it_created(run_world):
    w, doc = run_world.world, run_world.doc
    pipeline._run_pipeline_sync(doc["id"])
    assert doc["status"] == "failed" and "compute failed" in (doc["error"] or ""), doc
    assert w.db.rows("financial_periods") == [], "G4: a failed run left its period behind"
    assert doc["period_id"] is None, "the failed document still points at a deleted period"
    assert pipeline._pop_period_minted(doc["id"]) is None


def test_a_failed_rerun_leaves_a_period_that_predates_it(run_world):
    w, doc = run_world.world, run_world.doc
    existing = w.db.add("financial_periods", {"id": None, "org_id": ORG_SCANDIA, "source_document_id": doc["id"],
                                              "period_start": "2025-12-31", "period_end": "2025-12-31",
                                              "currency": "RON"})
    pipeline._run_pipeline_sync(doc["id"])
    assert doc["status"] == "failed"
    assert [p["id"] for p in w.db.rows("financial_periods")] == [existing["id"]]


def test_a_same_month_takeover_that_fails_leaves_the_month(run_world):
    w, doc = run_world.world, run_world.doc
    month = w.db.add("financial_periods", {"id": None, "org_id": ORG_SCANDIA, "source_document_id": "an-older-doc",
                                           "period_start": "2025-12-31", "period_end": "2025-12-31",
                                           "currency": "RON"})
    pipeline._run_pipeline_sync(doc["id"])
    assert [p["id"] for p in w.db.rows("financial_periods")] == [month["id"]]


def test_an_analysis_that_gets_past_persist_keeps_its_period(run_world, monkeypatch):
    """The positive control: nothing is removed from a run that did not fail
    (the rollback record is cleared at `analyzed`)."""
    w, doc = run_world.world, run_world.doc
    from engine import ai_lane as _ai_lane

    monkeypatch.setattr(pipeline, "stage_extract", lambda d: {
        "detected_type": _ai_lane.AI_LANE_DETECTED_TYPE, "currency": "RON", "confidence": 0.9,
        "ai_lane": {"assembled": {"lineItems": []}, "jurisdiction": "HU"}})
    pipeline._run_pipeline_sync(doc["id"])
    assert doc["status"] == "analyzed", doc
    (period,) = w.db.rows("financial_periods")
    assert doc["period_id"] == period["id"] and period["source_document_id"] == doc["id"]
    assert pipeline._pop_period_minted(doc["id"]) is None
