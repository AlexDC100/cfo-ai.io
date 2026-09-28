"""ONE COMPANY PER WORKSPACE — the upload flow's backend, on the REAL app.

Every request below goes through ``engine.api.create_app()`` — the object
``python -m engine serve`` runs — with its middleware (the body cap
included), its routing and every wall on the path. Nothing on the request
path is intercepted. What is doubled: PostgREST and Storage
(``WorkspaceDouble``: the tenancy suite's projection-faithful double, which
refuses a column no migration declares, plus the two RPCs and the storage
write the flow uses) and the two things a unit of this size must not do
for real — run an analysis thread and meter a real account. Most cases feed
the route a chosen identity through the `_identify_document` seam, so each
rule is driven by exactly the identity it is about; the "REAL identifier"
section runs `engine.workspaces.company_identity` over real workbook bytes
end to end. Bearers are real ES256 tokens, verified against the session's
test JWKS.

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
import re
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Dict, List, Optional

import pytest
from fastapi.testclient import TestClient

import _real_app_comparatives as RA
import firm_postgrest_double as D
from engine.api import _features, _supabase, _uploads, _usage_gate, pipeline

REPO = Path(__file__).resolve().parents[2]

#: The production seam, captured before any fixture replaces it.
_REAL_IDENTIFY = _uploads._identify_document

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
            # The plan's cap, exactly as schema_phase_plan_caps.sql raises it
            # (P0001) and SupabaseClient.rpc reports it: live memberships at
            # or over the cap refuse. No cap set: the plan allows enough.
            plan = self.db.plans.get(self.uid)
            if plan is not None:
                live = [m for m in self.db.rows("memberships") if m["user_id"] == self.uid
                        and not any(o["id"] == m["org_id"] and o.get("archived_at")
                                    for o in self.db.rows("organizations"))]
                if len(live) >= plan[1]:
                    raise RuntimeError("rpc create_workspace failed (400): %s" % {
                        "code": "P0001", "details": None, "hint": None,
                        "message": "workspace_cap_reached: your %s plan allows %d workspace(s). "
                                   "Upgrade to add more." % plan})
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
        #: user id -> (plan, workspace cap) for `create_workspace`'s SQL floor.
        self.plans = {}  # type: Dict[str, Any]

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
           token: Optional[str] = None, org: Optional[str] = None, **data: Any):
    form = dict((k, v if isinstance(v, str) else json.dumps(v)) for k, v in data.items() if v is not None)
    return _client(app).post("/api/uploads/commit", headers=_headers(user, org, token),
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
    # The switch is exercised on a row the product still sells as coming
    # soon (Forecast itself went active for everyone on 2026-09-26).
    key = "erp_connector"
    assert _features.FEATURES[key]["status"] == "coming_soon"
    env = {"CFO_FEATURES_ACTIVE": key}
    feats = _features.effective_features(env)
    assert feats[key]["status"] == "active"
    assert feats["dashboard"]["status"] == "active"
    assert feats["workspace_v2"]["status"] == "preview"
    assert _features.FEATURES[key]["status"] == "coming_soon"   # never mutated
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
    never matched. (Scandia holds a book here: an EMPTY CUI-less workspace
    becomes the new company whatever its name — the adoption tests below.)"""
    world.db.rows("org_prefs")[:] = [p for p in world.db.rows("org_prefs") if p["org_id"] != ORG_SCANDIA]
    _seed_doc(world, org=ORG_SCANDIA, body=b"PK\x03\x04 last year's book", period_end="2024-12-31")
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


def test_an_allowed_reservation_is_settled_by_the_run_ledger_and_nothing_bumps_at_enqueue(app, world, monkeypatch):
    """The meter's reservation is recorded in the run ledger the terminal
    settles (commit on `analyzed`, release on failure); the legacy
    enqueue-time bump that counted every upload twice is not called."""
    from engine.api import _usage_limits

    bumps = []  # type: List[Any]
    monkeypatch.setattr(_usage_limits, "record_usage", lambda *a, **kw: bumps.append(a))
    world.identities["balanta.xlsx"] = _identity(cui=CUI_SCANDIA)
    world.decision = "allowed"
    out = commit(app, target_org_id=ORG_SCANDIA, period_end="2025-12-31").json()
    run = pipeline._take_quota_run(out["document_id"])
    assert run is not None and run.user_id == USER and run.doc_reserved and not run.was_extra, out
    assert bumps == []


def test_a_twin_that_slipped_past_the_first_check_is_archived_at_the_claim(app, world, monkeypatch):
    """Two drops of one file at once: both pass the pre-store check, the
    first claims the run, the second is found at the CLAIM (the same
    `_doc_dedupe.enter_analysis` /api/pipeline/run takes) — archived, not
    analysed, its reservation handed back."""
    body = b"PK\x03\x04 the same bytes"
    world.identities["balanta.xlsx"] = _identity(cui=CUI_SCANDIA)
    twin = _seed_doc(world, org=ORG_SCANDIA, body=body, status="queued", with_period=False)
    twin["pipeline_started_at"] = "2026-09-21T10:00:00+00:00"          # the twin is running —
    from engine.api import _doc_dedupe                                  # ALIVE, in this process
    assert _doc_dedupe.try_mark_in_flight(twin["id"])                   # (a run a restart killed
    _doc_dedupe.mark_running(twin["id"])                                # is not an original)
    monkeypatch.setattr(_uploads, "find_duplicate", lambda **kw: None)  # the race window
    world.decision = "allowed"
    r = commit(app, body=body, target_org_id=ORG_SCANDIA, period_end="2025-12-31")
    assert r.status_code == 200, r.text[:300]
    out = r.json()
    assert out["status"] == "duplicate" and out["document_id"] == twin["id"], out
    (mine,) = [d for d in world.docs(org_id=ORG_SCANDIA) if d["id"] != twin["id"]]
    assert mine["deleted_at"] and str(mine["error"]).startswith("duplicate_of:" + twin["id"]), mine
    assert world.enqueued == [] and world.released == [(USER, False)]
    assert pipeline._take_quota_run(mine["id"]) is None


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


@pytest.mark.parametrize("decision", ["allowed", "disabled"])
def test_the_plans_workspace_cap_is_a_402_with_the_plan_and_cap_never_a_500(app, world, decision):
    """Live walkthrough, 2026-09-26: a new company's commit at the plan's
    workspace cap answered 500 — `create_workspace` raises
    'workspace_cap_reached: your % plan allows % workspace(s)…' — and the
    card read "We couldn't save the file". The cap is an ANSWER: 402
    {code, plan, cap, message}; no company, no document, no object; the
    meter's reservation handed back; nothing analysed."""
    world.db.plans[USER] = ("trial", 2)       # Scandia and Agras are live: at the cap
    world.identities["balanta.xlsx"] = _identity(cui=CUI_NEW, name="Nou Business SRL")
    world.decision = decision
    before = world.db.snapshot()
    r = commit(app, create_company={"name": "Nou Business SRL", "cui": CUI_NEW}, period_end="2025-12-31")
    assert r.status_code == 402, (r.status_code, r.text[:400])
    assert r.json()["detail"] == {
        "code": "workspace_cap_reached", "plan": "trial", "cap": 2,
        "message": "Your plan allows 2 companies. Upgrade to add another, or choose one of your "
                   "companies for this file."}, r.json()
    assert world.db.snapshot() == before, "a company, a row or an object exists after the cap refused"
    assert [f for f, _uid, _p in world.db.rpcs] == ["create_workspace"]
    assert world.enqueued == []
    assert world.released == ([(USER, False)] if decision == "allowed" else [])
    # One company fewer and the same commit creates it: the cap is the plan's, not a rule of the route.
    world.db.plans[USER] = ("trial", 3)
    r = commit(app, create_company={"name": "Nou Business SRL", "cui": CUI_NEW}, period_end="2025-12-31")
    assert r.status_code == 200 and r.json()["created_company"] is True, r.text[:300]


def test_the_cap_parser_reads_the_sql_floors_own_words_and_nothing_else():
    exc = RuntimeError("rpc create_workspace failed (400): {'code': 'P0001', 'details': None, 'hint': None, "
                       "'message': 'workspace_cap_reached: your solo plan allows 1 workspace(s). Upgrade to add more.'}")
    got = _uploads.workspace_cap_refusal(exc)
    assert got is not None and got.status_code == 402
    assert got.detail["plan"] == "solo" and got.detail["cap"] == 1
    assert got.detail["message"].startswith("Your plan allows 1 company.")
    for other in (RuntimeError("rpc create_workspace failed (400): name required"),
                  RuntimeError("rpc create_workspace failed (401): not authenticated"),
                  RuntimeError("Workspace limit reached")):
        assert _uploads.workspace_cap_refusal(other) is None, other


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


def _extra_meter(monkeypatch):
    """The real grant registry (`_usage_gate.confirm_extra_document` /
    `claim_extra_grant`) over a recorded RPC and a plan that sells extras."""
    from engine.api import _plan_state

    calls = []  # type: List[str]

    def _rpc(fn, params):
        calls.append(fn)
        return {"used": 15, "reserved": 1} if fn == "reserve_user_upload_extra" else {}

    monkeypatch.setattr(_usage_gate, "_rpc", _rpc)
    monkeypatch.setattr(_usage_gate, "enforced_for", lambda uid: True)
    monkeypatch.setattr(_plan_state, "get_plan_state", lambda uid: SimpleNamespace(
        plan=SimpleNamespace(key="professional", extra_doc_eur=3.0, included_docs=15)))
    return calls


def test_a_confirmed_extra_is_granted_to_the_document_this_commit_stores(app, world, monkeypatch):
    """The card's 402 -> Confirm -> the SAME commit with confirm_extra=1.
    There is no stored document yet for /api/plan/confirm-extra-doc to grant
    the extra to, so the commit reserves it as a grant for the document it is
    about to store and takes it there: one confirmation, one document
    (verifier P-B). The 402 itself stored and reserved nothing."""
    calls = _extra_meter(monkeypatch)
    world.identities["balanta.xlsx"] = _identity(cui=CUI_SCANDIA)
    world.decision = "extra_required"
    r = commit(app, target_org_id=ORG_SCANDIA, period_end="2025-12-31")
    assert r.status_code == 402 and r.json()["detail"]["code"] == "extra_doc_confirmation_required", r.text[:300]
    assert world.docs() == [] and world.db.storage == {} and calls == []
    r = commit(app, target_org_id=ORG_SCANDIA, period_end="2025-12-31", confirm_extra="1")
    assert r.status_code == 200 and r.json()["status"] == "queued", r.text[:300]
    (doc,) = world.docs()
    assert r.json()["document_id"] == doc["id"] and doc["metered_extra"] is True, doc
    run = pipeline._take_quota_run(doc["id"])
    assert run is not None and run.was_extra and run.user_id == USER, run
    assert calls == ["reserve_user_upload_extra"], calls
    # The meter was asked once (the 402); the confirmed commit took its grant.
    assert world.reserved_for == [USER]
    assert _usage_gate._EXTRA_GRANTS == {}, "the grant was not taken by its document"


def test_a_confirmed_extra_for_a_file_already_here_reserves_nothing(app, world, monkeypatch):
    calls = _extra_meter(monkeypatch)
    body = b"PK\x03\x04 the same bytes"
    world.identities["balanta.xlsx"] = _identity(cui=CUI_SCANDIA)
    mine = _seed_doc(world, org=ORG_SCANDIA, body=body)
    before = world.db.snapshot()
    r = commit(app, body=body, target_org_id=ORG_SCANDIA, period_end="2025-12-31", confirm_extra="1")
    assert r.json()["status"] == "duplicate" and r.json()["document_id"] == mine["id"], r.text[:300]
    assert world.db.snapshot() == before and calls == [] and _usage_gate._EXTRA_GRANTS == {}


def test_a_failed_document_insert_removes_the_object_and_hands_the_reservation_back(app, world, monkeypatch):
    world.identities["balanta.xlsx"] = _identity(cui=CUI_SCANDIA)
    world.decision = "allowed"
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
    world.decision = "allowed"

    def _boom(*a: Any, **kw: Any) -> None:
        raise RuntimeError("Storage upload failed (HTTP 500)")

    monkeypatch.setattr(world.db, "upload_object", _boom)
    r = commit(app, target_org_id=ORG_SCANDIA, period_end="2025-12-31")
    assert r.status_code == 500, r.text[:200]
    assert world.released == [(USER, False)] and world.enqueued == [] and world.docs() == []
    # Nothing reserved (metering off for this user): nothing to hand back.
    world.decision, world.released = "disabled", []
    assert commit(app, target_org_id=ORG_SCANDIA, period_end="2025-12-31").status_code == 500
    assert world.released == []


def test_the_industry_chosen_on_the_card_is_the_companys(app, world):
    world.identities["balanta.xlsx"] = _identity(cui=CUI_AGRAS)
    world.db.add("industry_profiles", {"key": "retail_generic", "display_name": "Retail",
                                       "display_name_ro": "Comert cu amanuntul"})
    r = commit(app, target_org_id=ORG_AGRAS, period_end="2025-12-31", industry_key="retail_generic")
    assert r.status_code == 200, r.text[:300]
    (org,) = [o for o in world.db.rows("organizations") if o["id"] == ORG_AGRAS]
    assert org["industry_key"] == "retail_generic" and org["industry_display_name"] == "Retail", org


def test_a_commit_that_chooses_no_industry_never_clears_the_companys(app, world):
    """The card's industry select left untouched sends no industry (and an
    empty choice is no choice): the company keeps the one it has."""
    world.identities["balanta.xlsx"] = _identity(cui=CUI_AGRAS)
    assert commit(app, target_org_id=ORG_AGRAS, period_end="2025-12-31").status_code == 200
    assert commit(app, body=b"PK\x03\x04 another year", target_org_id=ORG_AGRAS, period_end="2024-12-31",
                  industry_key="").status_code == 200
    (org,) = [o for o in world.db.rows("organizations") if o["id"] == ORG_AGRAS]
    assert org["industry_key"] == "food_manufacturing", org


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
# An empty workspace becomes the company (a new user's first balance)
# ══════════════════════════════════════════════════════════════════════
#
# Live walkthrough, 2026-09-26 (a launch blocker): a new trial account has
# exactly ONE auto-created workspace — no CUI, no data — and a plan that
# allows one company. Its first balance prints a CUI, so it routed to "new
# company" → create_workspace → the cap → refused. The rule: a new company's
# file ADOPTS the caller's live, OWNED, EMPTY (no period, no live document),
# CUI-less workspace instead of creating one.

NEWBIE = "5c0a0000-0000-4000-8000-0000000000c1"
ORG_EMPTY = "0a9a0000-0000-4000-8000-0000000000e0"
ORG_EMPTY_2 = "0a9a0000-0000-4000-8000-0000000000e2"
NEW_SPEC = {"name": "Nou Business SRL", "cui": "RO" + CUI_NEW, "caen_code": "1011",
            "industry_key": "food_manufacturing"}


def _workspace(world: World, org_id: str, user: str, *, name: str = "My workspace", role: str = "owner",
               created: str = "2026-09-26T00:00:00+00:00") -> None:
    world.db.add("organizations", {"id": org_id, "name": name, "default_currency": "RON",
                                   "industry_key": None, "archived_at": None, "created_at": created})
    world.db.add("memberships", {"user_id": user, "org_id": org_id, "role": role, "created_at": created})


@pytest.fixture()
def newbie(world):
    """A new trial account: one auto-created workspace, no CUI, no data;
    the plan allows ONE company (the create_workspace SQL floor)."""
    _workspace(world, ORG_EMPTY, NEWBIE)
    world.db.plans[NEWBIE] = ("trial", 1)
    world.identities["balanta.xlsx"] = _identity(cui=CUI_NEW, name="Nou Business SRL", caen="1011",
                                                 industry="food_manufacturing")
    return world


def test_a_new_users_first_balance_adopts_their_empty_workspace(app, newbie):
    world = newbie
    before = world.db.snapshot()
    body = identify(app, user=NEWBIE, org=ORG_EMPTY).json()
    assert body["target"] == {"org_id": ORG_EMPTY, "name": "Nou Business SRL", "is_new": True,
                              "reason": "adopt_empty_workspace"}, body["target"]
    assert world.db.snapshot() == before, "identify wrote something"

    r = commit(app, user=NEWBIE, org=ORG_EMPTY, create_company=NEW_SPEC, period_end="2025-12-31")
    assert r.status_code == 200, r.text[:400]
    out = r.json()
    assert out["org_id"] == ORG_EMPTY and out["company_name"] == "Nou Business SRL", out
    assert out["created_company"] is False and out["adopted_company"] is True, out
    assert [f for f, _uid, _p in world.db.rpcs if f == "create_workspace"] == [], "a company was created at the cap"
    (org,) = [o for o in world.db.rows("organizations") if o["id"] == ORG_EMPTY]
    assert org["name"] == "Nou Business SRL" and org["caen_code"] == "1011", org
    assert org["industry_key"] == "food_manufacturing" and org["industry_display_name"] == "Food manufacturing"
    (prefs,) = [p["prefs"] for p in world.db.rows("org_prefs") if p["org_id"] == ORG_EMPTY]
    assert prefs["cui"] == CUI_NEW and prefs["company_name"] == "Nou Business SRL", prefs
    assert prefs["identity_sources"]["cui"]["signal"] == "document_header_cui", prefs
    (doc,) = world.docs(org_id=ORG_EMPTY)
    assert doc["uploaded_by"] == NEWBIE and doc["storage_path"].startswith(ORG_EMPTY + "/uploads/")
    assert world.enqueued == [doc["id"]]
    assert len([m for m in world.db.rows("memberships") if m["user_id"] == NEWBIE]) == 1

    # Idempotent: the same commit again is the document already there; the
    # next year's book finds the company by its CUI — nothing adopted again.
    r = commit(app, user=NEWBIE, org=ORG_EMPTY, create_company=NEW_SPEC, period_end="2025-12-31")
    assert r.json()["status"] == "duplicate" and r.json()["document_id"] == doc["id"], r.text[:300]
    r = commit(app, user=NEWBIE, org=ORG_EMPTY, body=b"PK\x03\x04 next year", create_company=NEW_SPEC,
               period_end="2024-12-31")
    assert r.status_code == 200 and r.json()["org_id"] == ORG_EMPTY, r.text[:300]
    assert r.json()["created_company"] is False and r.json()["adopted_company"] is False, r.json()
    assert [o["name"] for o in world.db.rows("organizations") if o["id"] == ORG_EMPTY] == ["Nou Business SRL"]


@pytest.mark.parametrize("data", ["live_document", "period"])
def test_a_workspace_holding_any_data_is_never_adopted(app, newbie, data):
    world = newbie
    if data == "live_document":
        _seed_doc(world, org=ORG_EMPTY, user=NEWBIE, body=b"PK\x03\x04 a failed book", status="failed",
                  with_period=False)
    else:
        world.db.add("financial_periods", {"id": None, "org_id": ORG_EMPTY, "source_document_id": None,
                                           "period_start": "2024-12-31", "period_end": "2024-12-31",
                                           "currency": "RON"})
    body = identify(app, user=NEWBIE, org=ORG_EMPTY).json()
    assert body["target"]["reason"] == "new_cui" and body["target"]["org_id"] is None, body["target"]
    r = commit(app, user=NEWBIE, org=ORG_EMPTY, create_company=NEW_SPEC, period_end="2025-12-31")
    assert r.status_code == 402 and r.json()["detail"]["code"] == "workspace_cap_reached", r.text[:300]
    (org,) = [o for o in world.db.rows("organizations") if o["id"] == ORG_EMPTY]
    assert org["name"] == "My workspace"
    assert [p for p in world.db.rows("org_prefs") if p["org_id"] == ORG_EMPTY] == []


def test_a_deleted_document_alone_leaves_a_workspace_empty(app, newbie):
    world = newbie
    _seed_doc(world, org=ORG_EMPTY, user=NEWBIE, body=b"PK\x03\x04 deleted", deleted=True, with_period=False)
    assert identify(app, user=NEWBIE, org=ORG_EMPTY).json()["target"]["reason"] == "adopt_empty_workspace"


def test_a_workspace_with_a_cui_is_never_adopted(app, newbie):
    world = newbie
    world.db.add("org_prefs", {"org_id": ORG_EMPTY, "prefs": {"cui": "12345678"}})
    body = identify(app, user=NEWBIE, org=ORG_EMPTY).json()
    assert body["target"]["reason"] == "new_cui", body["target"]
    r = commit(app, user=NEWBIE, org=ORG_EMPTY, create_company=NEW_SPEC, period_end="2025-12-31")
    assert r.status_code == 402, r.text[:300]
    assert [p["prefs"]["cui"] for p in world.db.rows("org_prefs") if p["org_id"] == ORG_EMPTY] == ["12345678"]


def test_only_a_workspace_the_caller_owns_is_adopted(app, newbie):
    """A teammate's empty workspace the caller is only a MEMBER of is not
    theirs to rename; another account's empty workspace is never even seen."""
    world = newbie
    world.db.rows("memberships")[:] = [m for m in world.db.rows("memberships") if m["org_id"] != ORG_EMPTY]
    world.db.add("memberships", {"user_id": NEWBIE, "org_id": ORG_EMPTY, "role": "member",
                                 "created_at": "2026-09-26T00:00:00+00:00"})
    world.db.add("memberships", {"user_id": TEAMMATE, "org_id": ORG_EMPTY, "role": "owner",
                                 "created_at": "2026-09-25T00:00:00+00:00"})
    _workspace(world, ORG_EMPTY_2, OUTSIDER)
    body = identify(app, user=NEWBIE, org=ORG_EMPTY).json()
    assert body["target"]["reason"] == "new_cui", body["target"]
    r = commit(app, user=NEWBIE, org=ORG_EMPTY, create_company=NEW_SPEC, period_end="2025-12-31")
    assert r.status_code == 402, r.text[:300]
    assert {o["name"] for o in world.db.rows("organizations") if o["id"] in (ORG_EMPTY, ORG_EMPTY_2)} == {"My workspace"}


def test_the_empty_workspace_on_screen_is_adopted_first_else_the_oldest(app, newbie):
    world = newbie
    world.db.plans[NEWBIE] = ("pro", 5)
    _workspace(world, ORG_EMPTY_2, NEWBIE, name="Second", created="2026-09-27T00:00:00+00:00")
    assert identify(app, user=NEWBIE, org=ORG_EMPTY_2).json()["target"]["org_id"] == ORG_EMPTY_2
    r = commit(app, user=NEWBIE, create_company=NEW_SPEC, period_end="2025-12-31")
    assert r.json()["org_id"] == ORG_EMPTY and r.json()["adopted_company"] is True, r.text[:300]


# ══════════════════════════════════════════════════════════════════════
# The REAL identifier (engine.workspaces.company_identity), end to end
# ══════════════════════════════════════════════════════════════════════


def test_the_real_identifier_routes_by_the_documents_cui_and_reads_its_period(app, world, monkeypatch):
    """G1 + G2 over real workbook bytes: an Agras balance dropped while
    Scandia is on screen, in a file NAMED for 2019, is Agras's December
    2025 — the CUI and the period line the document prints — and commit
    files it there with that period as its hint. Registry absent (tolerated)."""
    from ws_migration_fixture import balance_xlsx, valid_cui

    monkeypatch.setattr(_uploads, "_identify_document", _REAL_IDENTIFY)
    monkeypatch.setattr(_uploads, "_open_registry", lambda: None)
    agras_cui = valid_cui("4278990")
    (prefs,) = [p for p in world.db.rows("org_prefs") if p["org_id"] == ORG_AGRAS]
    prefs["prefs"]["cui"] = agras_cui
    content = balance_xlsx(["AGRAS SA", "Balanta de Verificare - Decembrie 2025",
                            "Cod fiscal: RO%s" % agras_cui])
    r = identify(app, org=ORG_SCANDIA, name="balanta_2019_12.xlsx", body=content)
    assert r.status_code == 200, r.text[:400]
    body = r.json()
    assert body["target"] == {"org_id": ORG_AGRAS, "name": "Agras SA", "is_new": False,
                              "reason": "cui_match"}, body
    assert body["identity"]["cui"] == agras_cui
    assert body["identity"]["period_end"] == "2025-12-31", body["identity"]
    assert body["identity"]["sources"]["period_end"]["signal"] != "filename"
    assert body["identity"]["document_kind"] == "trial_balance"
    r = commit(app, name="balanta_2019_12.xlsx", body=content, target_org_id=body["target"]["org_id"],
               period_end=body["identity"]["period_end"])
    assert r.status_code == 200 and r.json()["org_id"] == ORG_AGRAS, r.text[:300]
    (doc,) = world.docs(org_id=ORG_AGRAS)
    assert doc["period_end_hint"] == "2025-12-31" and doc["storage_path"].startswith(ORG_AGRAS + "/")
    # The same company without a period line: the file name's 2019 is NOT offered.
    bare = balance_xlsx(["AGRAS SA", "Cod fiscal: RO%s" % agras_cui], seed=7)
    ident = identify(app, org=ORG_SCANDIA, name="balanta_2019_12.xlsx", body=bare).json()["identity"]
    assert ident["period_end"] is None and ident["cui"] == agras_cui, ident


def _five_pair_pdf(*, printed_period: bool = True) -> bytes:
    """A synthetic WinMentor five-pair balanta PDF (PyMuPDF; invented
    company, invented figures) — the layout that prints its period as
    "Decembrie 2025" closing the address line of its title block."""
    fitz = pytest.importorskip("fitz")
    from test_pdf_balanta_stage_extract import _synthetic_five_pair_lines

    lines = _synthetic_five_pair_lines()
    if not printed_period:
        lines = [ln.replace(" Decembrie 2025", "") for ln in lines]
    doc = fitz.open()
    page = doc.new_page(width=1400, height=1000)
    y = 30
    for line in lines:
        page.insert_text((20, y), line, fontsize=8)
        y += 14
    return doc.tobytes()


@pytest.mark.parametrize("filename", ["balanta.pdf", "balanta_2019_12.pdf"])
def test_the_period_a_five_pair_pdf_prints_is_the_period_identify_offers(app, world, monkeypatch, filename):
    """Live walkthrough, 2026-09-26: the filed WinMentor five-pair PDF
    prints "Decembrie 2025", and the card read PERIOD "Not in the document"
    — the header detector reads a date only beside closing-balance
    vocabulary, and the five-pair print closes its title block with the
    month on the ADDRESS line. The verified balanta reader already reads it
    there; identify now offers it when the header detector finds none —
    document text only: a file NAMED for 2019 is still the document's 2025."""
    from engine.country_packs.ro_romania import pdf_balanta_text

    monkeypatch.setattr(_uploads, "_identify_document", _REAL_IDENTIFY)
    monkeypatch.setattr(_uploads, "_open_registry", lambda: None)
    content = _five_pair_pdf()
    got = pdf_balanta_text.read_balanta_text_verdict(content)
    assert got.meta and got.meta.get("period_text") == "Decembrie 2025", "the reader refused the synthetic book"
    r = identify(app, org=ORG_SCANDIA, name=filename, body=content)
    assert r.status_code == 200, r.text[:400]
    ident = r.json()["identity"]
    assert ident["period_end"] == "2025-12-31", ident
    assert ident["sources"]["period_end"] == {"signal": "in_document", "evidence": "Decembrie 2025"}, ident["sources"]


def test_a_five_pair_pdf_that_prints_no_period_offers_none_never_the_file_names(app, world, monkeypatch):
    monkeypatch.setattr(_uploads, "_identify_document", _REAL_IDENTIFY)
    monkeypatch.setattr(_uploads, "_open_registry", lambda: None)
    content = _five_pair_pdf(printed_period=False)
    ident = identify(app, org=ORG_SCANDIA, name="balanta_2019_12.pdf", body=content).json()["identity"]
    assert ident["period_end"] is None, ident
    assert ident["sources"]["period_end"]["signal"] == "none", ident["sources"]


def test_the_full_verified_read_runs_only_for_a_pdf_whose_title_prints_a_period(app, world, monkeypatch):
    """Latency (live walkthrough, 2026-09-26): the verified read parses every
    page with word positions — 1-3 s on a real book — so identify asks for it
    only when the document's title lines print a period by the reader's own
    rule; a PDF that prints none is answered from the one text pass."""
    from engine.country_packs.ro_romania import pdf_balanta_text

    calls = []  # type: List[int]
    real = pdf_balanta_text.read_balanta_text_verdict
    monkeypatch.setattr(pdf_balanta_text, "read_balanta_text_verdict", lambda b: calls.append(1) or real(b))
    monkeypatch.setattr(_uploads, "_identify_document", _REAL_IDENTIFY)
    monkeypatch.setattr(_uploads, "_open_registry", lambda: None)
    ident = identify(app, org=ORG_SCANDIA, name="balanta.pdf", body=_five_pair_pdf(printed_period=False)).json()
    assert ident["identity"]["period_end"] is None and calls == [], (ident["identity"], calls)
    ident = identify(app, org=ORG_SCANDIA, name="balanta.pdf", body=_five_pair_pdf()).json()
    assert ident["identity"]["period_end"] == "2025-12-31" and calls == [1], (ident["identity"], calls)


def test_the_registry_is_opened_only_where_it_already_exists(tmp_path, monkeypatch):
    """Tolerate its absence — and never CREATE an empty registry by
    opening one (the store's constructor would)."""
    missing = tmp_path / "nope" / "public_ro.db"
    monkeypatch.setenv("PUBLIC_RO_DB_PATH", str(missing))
    assert _uploads._open_registry() is None
    assert not missing.exists() and not missing.parent.exists()
    from engine.public_ro.store import PublicRoStore

    present = tmp_path / "public_ro.db"
    PublicRoStore(present).close()
    monkeypatch.setenv("PUBLIC_RO_DB_PATH", str(present))
    store = _uploads._open_registry()
    try:
        assert isinstance(store, PublicRoStore)
    finally:
        store.close()


# ══════════════════════════════════════════════════════════════════════
# GET /api/companies/{org_id}/years
# ══════════════════════════════════════════════════════════════════════


def _envelopes():
    import _served_books as SB
    return (SB.book("agras").period["assembled_canonical_v1"],
            SB.book(SB.SCANDIA).period["assembled_canonical_v1"])


def agras_env_turnover(env: Dict[str, Any]) -> float:
    """Turnover as the methodology block states it (70x − 709)."""
    return round(float(env["methodology"]["totals"]["revenue_net"]), 2)


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
    # TURNOVER and its growth only (owner ruling 2026-09-26, design A6: the
    # company cards). `revenue` / `revenue_change_pct` are the page's names
    # for the same two figures.
    basis = {"ro": "cifra de afaceri netă (70x − 709)", "en": "net turnover (70x − 709)"}

    def tile(p, year, end, turnover, change):
        return {"period_id": p["id"], "year": year, "period_end": end,
                "turnover": turnover, "turnover_change_pct": change,
                "revenue": turnover, "revenue_change_pct": change,
                "basis": basis, "currency": "RON"}

    assert rows == [
        tile(p24, 2024, "2024-12-31", rev24, None),
        tile(p25, 2025, "2025-12-31", rev25, round((rev25 - rev24) / abs(rev24) * 100.0, 1)),
        # August year-to-date has no August a year earlier: no change, not a fake one against December.
        tile(p26, 2026, "2026-08-31", rev25, None),
    ], json.dumps(rows, indent=1)
    # The figure IS the statement's turnover (70x − 709) — never total
    # operating revenue.
    assert rev24 == agras_env_turnover(agras_env)


def test_a_period_without_an_envelope_has_no_revenue_not_zero(app, world):
    p = _period(world, ORG_AGRAS, "2025-12-31", None)
    rows = _client(app).get("/api/companies/%s/years" % ORG_AGRAS, headers=_headers(USER)).json()
    assert rows == [{"period_id": p["id"], "year": 2025, "period_end": "2025-12-31",
                     "turnover": None, "turnover_change_pct": None,
                     "revenue": None, "revenue_change_pct": None,
                     "basis": {"ro": "cifra de afaceri netă (70x − 709)",
                               "en": "net turnover (70x − 709)"},
                     "currency": "RON"}], rows


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


# ══════════════════════════════════════════════════════════════════════
# The real file type, from the bytes — never from the name
# ══════════════════════════════════════════════════════════════════════
#
# A Word document renamed .pdf (a PK container holding word/document.xml)
# used to reach the PDF path — pdfplumber failed, the card read "not in the
# document" everywhere, and Analyse handed it to Claude. The routes now read
# the real type from the magic bytes and refuse the mismatch with a plain
# sentence, before the identifier, the meter or storage.


def _docx_bytes() -> bytes:
    import io
    import zipfile

    bio = io.BytesIO()
    with zipfile.ZipFile(bio, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", "<Types/>")
        z.writestr("_rels/.rels", "<Relationships/>")
        z.writestr("word/document.xml", "<w:document/>")
    return bio.getvalue()


def _xlsx_bytes() -> bytes:
    import io
    import zipfile

    bio = io.BytesIO()
    with zipfile.ZipFile(bio, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", "<Types/>")
        z.writestr("xl/workbook.xml", "<workbook/>")
    return bio.getvalue()


def test_identify_refuses_a_word_document_renamed_pdf_before_anything_reads_it(app, world):
    r = identify(app, name="raport.pdf", body=_docx_bytes())
    assert r.status_code == 422, r.text[:300]
    detail = r.json()["detail"]
    assert detail["code"] == "format_mismatch", detail
    assert detail["message"] == "This is a Word document, not a PDF.", detail
    assert world.identify_calls == [], "the identifier ran on a file the routes should have refused"


def test_commit_refuses_a_word_document_renamed_pdf_and_stores_nothing(app, world):
    world.identities["raport.pdf"] = _identity(cui=CUI_SCANDIA, name="Scandia Food SRL")
    c = commit(app, name="raport.pdf", body=_docx_bytes(), target_org_id=ORG_SCANDIA, period_end="2025-12-31")
    assert c.status_code == 422, c.text[:300]
    assert c.json()["detail"]["code"] == "format_mismatch", c.json()
    assert world.docs() == [] and world.enqueued == [] and world.reserved_for == [], \
        "a refused file was stored, queued or metered"
    assert [k for k in world.db.storage if k.startswith("documents/")] == []


@pytest.mark.parametrize("name,body,message", [
    ("balanta.pdf", _xlsx_bytes(), "This is an Excel workbook, not a PDF."),
    ("balanta.xlsx", b"%PDF-1.7 a balance", "This is a PDF, not an Excel workbook."),
    ("balanta.xls", _docx_bytes(), "This is a Word document, not an Excel workbook."),
    ("balanta.csv", _docx_bytes(), "This is a Word document, not a CSV file."),
])
def test_every_mismatch_between_the_name_and_the_bytes_is_refused_plainly(app, world, name, body, message):
    r = identify(app, name=name, body=body)
    assert r.status_code == 422, r.text[:300]
    detail = r.json()["detail"]
    assert (detail["code"], detail["message"]) == ("format_mismatch", message), detail
    assert re.match(r"^[a-z]+_not_[a-z]+$", str(detail.get("kind") or "")), detail
    assert "source" not in message.lower()


def test_bytes_that_agree_with_the_name_or_say_nothing_are_never_refused(app, world):
    world.identities["balanta.xlsx"] = _identity(cui=CUI_SCANDIA, name="Scandia Food SRL")
    world.identities["balanta.pdf"] = _identity(cui=CUI_SCANDIA, name="Scandia Food SRL")
    world.identities["balanta.csv"] = _identity(cui=CUI_SCANDIA, name="Scandia Food SRL")
    assert identify(app, name="balanta.xlsx", body=_xlsx_bytes()).status_code == 200
    assert identify(app, name="balanta.pdf", body=b"%PDF-1.4 a scanned balance").status_code == 200
    assert identify(app, name="balanta.csv", body=b"cont;denumire;sold\n101;Capital;1000\n").status_code == 200
    # A PK container that names no Office part is not provably anything
    # else: a workbook exported by a tool that lays its zip out differently
    # is still a workbook.
    assert identify(app, name="balanta.xlsx", body=b"PK\x03\x04 a trial balance").status_code == 200
