"""THE IDENTITY WALL and THE WRITE WALL — FC1x, critics D5 + D4 (2026-09-05).

Two defects, one gate, both driven against the REAL ``create_app()`` (every
route the deployed process mounts, enumerated from its own route table —
never from an import-shape regex) over the tenancy suite's SQL-derived
Supabase double with one addition: the double now VERIFIES SIGNATURES.

D5 — A VERIFIED IDENTITY ON EVERY ROUTE. Until today every route derived
``auth.uid()`` from a LOCAL, UNVERIFIED base64 decode of the bearer's
payload (``_supabase._decode_jwt_claims``), trusting PostgREST to check the
signature on the next per-user read. Four routes never made that read and
wrote as the decoded ``sub`` through the service role: ``POST
/api/documents/clear-mine`` (a forged ``sub`` = the victim's owner id +
``X-Org-Id`` = the victim's org soft-deleted the victim's document — 200,
``deleted_count 1``, prod-identical), ``GET``/``PUT /api/dashboard/config``,
``POST /api/firm/email/drain`` (gated only by the forgeable ``sub`` being in
PRICING_ADMIN_USER_IDS). Every ``/api/firm`` route passed the Python wall
on a forged bearer. Now ``engine.api._jwt`` verifies ES256 against the
JWKS Supabase publishes (measured in production 2026-09-05: one P-256 key,
no HS256 secret), and the double mints real ES256 tokens under a
per-process test key and refuses any bearer whose signature does not
verify — so "the double cannot model it" is closed in BOTH directions.

D4 — NO WRITE ON READ VISIBILITY. The firm READ policies
(``can_read_client_org``, schema_phase_firm.sql) show a client's rows to a
firm viewer with a read cell and NO membership. Every mutating route
outside /api/firm that authorized on "is the row visible under per_user?"
and then wrote through the service role was therefore open to that viewer:
``DELETE /api/period/{id}`` 200 with the row HARD-DELETED, ``POST
.../reextract`` 200, ``POST /api/documents/{id}/move-period`` 200, ``POST
/api/pipeline/run`` 202 (crit_pipeline_census.py). A write now needs a
``memberships`` row in the org it targets (``_org.require_org_member``);
visibility is the READ wall and never the write wall.

WHAT THE GATE ASSERTS (claims, never shapes):
  * a forged bearer (bad signature / alg none / HS256 with the public key /
    expired / wrong iss / wrong aud / no sub / unknown kid / malformed) is
    401 on clear-mine AND the victim org's document rows are BYTE-IDENTICAL;
    a properly signed token on the same route is 200 and the rows move;
  * an unknown ``kid`` costs exactly ONE JWKS refetch, then 401; a second
    unknown kid inside the cooldown costs none;
  * JWKS unreachable with an empty cache → 503 naming the verifier, never
    200; unreachable with a warm cache → the last good key set serves;
  * the routes the critic named refuse a forged bearer with 401 and accept a
    signed one; every /api/firm route that reads a bearer refuses a forged
    one with 401;
  * no module under src/engine/api or src/engine/ai_lane reads an
    unverified claim for anything but a log line (a census by name);
  * EVERY mutating route of the real app is classified — member-walled
    (statically: its handler reaches ``require_org_member`` / ``resolve_org``
    / ``member_org_ids`` within one helper hop), firm-walled (under
    /api/firm, /api/capsule — swept by test_firm_tenancy.py), or DECLARED
    with its reason — and an unclassified one reds naming itself;
  * firm A's VIEWER, who SEES the client's period and documents, is
    refused on every member-walled route and EVERY table is byte-identical
    before/after; after the client is re-attached to firm B, firm B's
    viewer holds the same nothing; firm A's OWNER (a member) still writes.

TC-11 — what this gate reds on AFTER the defects are repaired: a route
that accepts an unverified identity (the plant: `_org.resolve_user_id` /
`SupabaseClient.get_user` put back on a payload decode → the clear-mine
test reds through its own message naming the route and the row), and a
route that writes a client's books on firm visibility (the plant: the
membership line removed from DELETE /api/period/{id} → the viewer sweep
reds naming the route and the hard-deleted row). It would ALSO red on the
correct behaviour being wrong: a verifier that refused a properly signed
token, or a wall that refused the owner — the positive controls assert
both.

Hermetic: ``-p netblock`` (any socket connect raises); the app is built
against the test-manifest URL with boot verification skipped; the JWKS is
served in-process by the double. Nothing here points at production.

Python 3.9 — no ``match``, no ``X | Y`` unions.
"""

from __future__ import annotations

import copy
import inspect
import json
import os
import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import httpx
import pytest
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient

import firm_postgrest_double as D
import test_firm_tenancy as T
from engine.api import _jwt, _org, _supabase

REPO = Path(__file__).resolve().parents[2]
API_DIR = REPO / "src" / "engine" / "api"
AI_LANE_DIR = REPO / "src" / "engine" / "ai_lane"

#: The client rows firm A's viewer can SEE (so a 403 is the wall, not
#: visibility). DOC_A1 is the tenancy world's live document; the two below
#: are seeded here.
DOC_A1 = T.U(401)
DOC_A1_GONE = T.U(403)      # soft-deleted: restore / permanent / clear-deleted
DATASET_A1 = T.U(411)
SKU_A1 = T.U(421)

#: The membership primitives a member-walled handler must reach within one
#: helper hop. `require_org_member` is THE wall; `resolve_org` refuses a
#: requested org the caller is not a member of (X-Org-Id) and falls back to
#: the caller's own membership; `member_org_ids` narrows a bulk scope.
PRIMITIVES = ("require_org_member(", "resolve_org(", "member_org_ids(")

#: Firm-walled prefixes — swept route by route by tests/engine/
#: test_firm_tenancy.py (the walls lane); this census only checks that
#: nothing else escapes classification.
FIRM_PREFIXES = ("/api/firm", "/api/capsule")

#: Every mutating route outside /api/firm that writes a client's books.
#: (method, path template, body, expectation as firm A's VIEWER).
#: "403" — the viewer SEES the target and is refused by the wall;
#: "200-empty" — a bulk route scoped to "mine": answers with nothing.
SWEEP = [
    ("DELETE", "/api/period/{PERIOD_A1}", None, "403"),
    ("PUT", "/api/period/{PERIOD_A1}/valuation-assumptions", {"ebitda_used": 1}, "403"),
    ("DELETE", "/api/period/{PERIOD_A1}/valuation-assumptions", None, "403"),
    ("POST", "/api/period/{PERIOD_A1}/briefing/regenerate", None, "403"),
    ("POST", "/api/period/{PERIOD_A1}/review/reanalyze", {"account_buckets": {}}, "403"),
    ("POST", "/api/period/{PERIOD_A1}/reconcile", None, "403"),
    ("POST", "/api/period/{PERIOD_A1}/reconcile/undo", None, "403"),
    ("POST", "/api/period/{PERIOD_A1}/reextract", {}, "403"),
    ("PATCH", "/api/documents/{DOC_A1}", {"display_name": "renamed-by-viewer"}, "403"),
    ("DELETE", "/api/documents/{DOC_A1}", None, "403"),
    ("POST", "/api/documents/{DOC_A1_GONE}/restore", None, "403"),
    ("DELETE", "/api/documents/{DOC_A1_GONE}/permanent", None, "403"),
    ("POST", "/api/documents/{DOC_A1}/move-period", {"period_end": "2025-12-31"}, "403"),
    ("POST", "/api/documents/{DOC_A1}/make-active", None, "403"),
    ("POST", "/api/pipeline/run", {"document_id": DOC_A1}, "403"),
    ("POST", "/api/pipeline/retry", {"document_id": DOC_A1}, "403"),
    ("POST", "/api/documents/clear-mine", None, "403"),
    ("DELETE", "/api/documents/clear-deleted", None, "200-empty"),
    ("POST", "/api/pipeline/recover-stuck", None, "200-empty"),
    ("PATCH", "/api/sales-datasets/{DATASET_A1}", {"label": "renamed-by-viewer"}, "403"),
    ("DELETE", "/api/sales-datasets/{DATASET_A1}", None, "403"),
    ("POST", "/api/sales-datasets/{DATASET_A1}/rerun", None, "403"),
    ("PATCH", "/api/sku-aggregates/{SKU_A1}/decision", {"user_override": None}, "403"),
    ("POST", "/api/industry/assignment/{PERIOD_A1}",
     {"selected_industry_key": "manufacturing_generic"}, "403"),
    ("POST", "/api/industry/assignment/{PERIOD_A1}/lock", {"locked": True}, "403"),
    ("POST", "/api/industry/assignment/{PERIOD_A1}/recalc", None, "403"),
]

_IDS = {"PERIOD_A1": T.PERIOD_A1, "DOC_A1": DOC_A1, "DOC_A1_GONE": DOC_A1_GONE,
        "DATASET_A1": DATASET_A1, "SKU_A1": SKU_A1}
_TEMPLATE_TO_ROUTE = {"PERIOD_A1": "period_id", "DOC_A1": "document_id", "DOC_A1_GONE": "document_id",
                      "DATASET_A1": "dataset_id", "SKU_A1": "sku_id"}


def _route_key(method: str, template: str) -> Tuple[str, str]:
    """The (method, path) the real app's route table carries for a SWEEP entry."""
    path = template
    for name, param in _TEMPLATE_TO_ROUTE.items():
        path = path.replace("{%s}" % name, "{%s}" % param)
    return (method, path)


MEMBER_WALLED = set(_route_key(m, p) for m, p, _b, _e in SWEEP)

#: Every other mutating route the real app mounts, each with the reason it
#: is NOT a member-walled write of a client's books. A route missing from
#: BOTH tables reds the census by name.
DECLARED = {
    # operator-gated: an engine bearer / admin allowlist on a VERIFIED id
    ("POST", "/api/admin/calibration/rules/{rule_id}/approve"): "operator: _require_engine_admin (engine bearer)",
    ("POST", "/api/admin/calibration/rules/{rule_id}/reject"): "operator: _require_engine_admin (engine bearer)",
    ("POST", "/api/billing/cron/renewal-reminders"): "operator: ENGINE_API_TOKEN, fails closed (test_cron_auth)",
    ("POST", "/api/workspaces/cron/purge-expired"): "operator: ENGINE_API_TOKEN, fails closed (test_cron_auth)",
    ("POST", "/api/newsletter/broadcast"): "operator: PRICING_ADMIN_USER_IDS on the VERIFIED user id",
    ("POST", "/api/newsletter/drain-renewals"): "operator: PRICING_ADMIN_USER_IDS on the VERIFIED user id",
    ("POST", "/api/public/intelligence/refresh-filings-cache"): "operator: walled, fails closed (public wave)",
    ("POST", "/api/public/intelligence/signals/manual"): "operator: walled, fails closed (public wave)",
    ("POST", "/api/public/ro/companies/{cui}/teardown"): "operator: _require_operator token (public_ro)",
    ("POST", "/api/public/ro/takedown"): "operator: _require_operator_token (public_ro)",
    ("POST", "/run-daily"): "operator: auth_dep engine bearer (legacy n8n contract)",
    # self-scoped: the VERIFIED user id keys every row read or written
    ("POST", "/api/billing/cancel"): "self-scoped: subscriptions are per user_id (verified)",
    ("POST", "/api/billing/portal"): "self-scoped: subscriptions are per user_id (verified)",
    ("POST", "/api/checkout/start"): "self-scoped: Stripe session for the verified user",
    ("PUT", "/api/dashboard/config"): "self-scoped: dashboard_configs keyed on the verified user_id",
    ("POST", "/api/plan/commit-document-usage"): "self-scoped: usage counters per verified user_id",
    ("POST", "/api/plan/confirm-extra-doc"): "self-scoped: usage counters per verified user_id",
    ("POST", "/api/plan/release-document-reservation"): "self-scoped: usage counters per verified user_id",
    ("POST", "/api/newsletter/subscribe-me"): "self-scoped: the verified identity's own e-mail",
    ("POST", "/api/newsletter/unsubscribe-me"): "self-scoped: the verified identity's own e-mail",
    ("POST", "/api/newsletter/debug-send"): "self-scoped: mails only the verified identity's own e-mail",
    ("POST", "/api/newsletter/debug-send-all"): "self-scoped: mails only the verified identity's own e-mail",
    # read-only compute behind a POST body: no table is written
    ("POST", "/api/period/detect"): "read-only compute: period detection on the request body (JWT required)",
    ("POST", "/api/period/{period_id}/valuation/recompute"): "read-only compute: stateless DCF, does not persist",
    ("POST", "/api/financial-statements/parse"): "read-only compute: stateless parse of the request body",
    ("POST", "/api/alerts"): "read-only compute: SKU engine over the request body",
    ("POST", "/api/analyze"): "read-only compute: SKU engine over the request body",
    ("POST", "/api/classify-rows"): "read-only compute: SKU engine over the request body",
    ("POST", "/api/drill"): "read-only compute: SKU engine over the request body",
    ("POST", "/api/skus"): "read-only compute: SKU engine over the request body",
    ("POST", "/api/upload-excel"): "read-only compute: SKU engine over the uploaded workbook",
    # public by design: no tenant data behind them
    ("POST", "/api/cfo/cash"): "public demo: computes from the request body (\"Demo Company\")",
    ("POST", "/api/cfo/profit"): "public demo: computes from the request body",
    ("POST", "/api/cfo/today"): "public demo: computes from the request body",
    ("POST", "/api/cfo/products"): "public demo: computes from the request body",
    ("POST", "/api/cfo/exports/action-list"): "public demo: computes from the request body",
    ("POST", "/api/cfo/exports/board-summary"): "public demo: computes from the request body",
    ("POST", "/api/cfo/decisions/{rec_id}/status"): "public demo: legacy SKU adapter, 503 without it; no Supabase tenant table",
    ("POST", "/api/contact-sales"): "public form: writes a contact row, no tenant data",
    ("POST", "/api/newsletter/subscribe"): "public: double opt-in subscription",
    ("POST", "/api/sessions/track"): "public by design (low-sensitivity session log)",
    ("POST", "/api/stripe/webhook"): "Stripe-signed webhook",
    ("POST", "/api/public/companies/compare"): "public market surface: no tenant data",
    ("POST", "/api/public/companies/{ticker}/refresh"): "public market surface: shielded cache bust, no tenant data",
    ("POST", "/api/public/companies/{ticker}/sync"): "public market surface: shielded, no tenant data",
    ("POST", "/api/public/intelligence/refresh-signals"): "public market surface: shielded cache bust, no tenant data",
    ("POST", "/api/public/ro/event"): "public funnel: always 204, no tenant data",
}


# ── The app and the world ────────────────────────────────────────────────


def _manifest_env(setenv: Any) -> None:
    setenv("VITE_SUPABASE_URL", "https://test.supabase.co")
    setenv("VITE_SUPABASE_ANON_KEY", "test-anon")
    setenv("SUPABASE_SERVICE_ROLE_KEY", "test-service")
    setenv("CFO_AI_SKIP_BOOT_VERIFY", "1")
    # The Cockpit mounts only behind FIRM_COCKPIT_ENABLED (server.py
    # `_firm_cockpit_enabled`; unset in production, so /api/firm is a 404
    # there). This gate asserts the identity wall ON those routes and has
    # its own vacuity guards ("only N /api/firm routes read a bearer"), so
    # it must build the app WITH the surface on. That the surface is absent
    # without the flag is test_firm_real_app.py::
    # test_the_cockpit_is_not_mounted_without_its_flag.
    setenv("FIRM_COCKPIT_ENABLED", "1")
    setenv(T._firm_requests.SIGNING_KEY_ENV, "identity-wall-signing-key-0123456789")


@pytest.fixture(scope="module")
def app():
    """The REAL app. Env is set with os.environ (module scope has no
    monkeypatch); the test-manifest URL is asserted so this can never
    build against production."""
    for key in ("PUBLIC_TEST_MODE", "ENGINE_API_TOKEN", "PRICING_ADMIN_USER_IDS",
                "SUPABASE_JWT_SECRET", "ANTHROPIC_API_KEY"):
        os.environ.pop(key, None)
    _manifest_env(os.environ.__setitem__)
    os.environ.setdefault("AI_BREAKER_STATE_DIR", str(Path(os.environ.get("TMPDIR", "/tmp")) / "identity-wall-ai"))
    assert "test." in os.environ["VITE_SUPABASE_URL"], "refusing a non-manifest Supabase URL"
    from engine.api.server import create_app
    return create_app(config_path=REPO / "config.yaml")


class _VerifiedClient(T._Client):
    """The tenancy suite's client with ONE change: identity is what the
    verifier says, never a payload decode."""

    def get_user(self, jwt):  # type: (str) -> Dict[str, Any]
        return D.verified_identity(jwt)


def _extend_world(w: Any) -> None:
    """The pipeline touches columns and two tables the tenancy world does
    not declare. `sales_datasets` / `sku_aggregates` are not in any
    migration under supabase/ (they predate it); they are modelled here
    the way prod's `documents` is — member select + firm read — which is
    the WORST case for the write wall: the viewer sees the row."""
    for col in ("deleted_at", "period_id", "storage_path", "display_name", "is_active",
                "pipeline_started_at", "scope", "error", "duration_ms", "updated_at",
                "jurisdiction_hint", "reextract_forced", "period_end"):
        if col not in w.columns["documents"]:
            w.columns["documents"].append(col)
    for row in w.rows("documents"):
        for col in w.columns["documents"]:
            row.setdefault(col, None)
    extra = {
        "sales_datasets": ["id", "org_id", "document_id", "label", "is_active",
                           "source_filename", "row_count", "created_at"],
        "sku_aggregates": ["id", "dataset_id", "org_id", "product_name", "user_override",
                           "classification", "created_at"],
    }
    ops = getattr(T, "_TABLE_PRIVILEGE_OPS", ("insert", "update", "delete"))
    for table, cols in extra.items():
        w.columns[table] = list(cols)
        w.tables[table] = []
        for role in T.API_ROLES:
            w.privileges[(role, table)] = dict((op, True) for op in ops)
        w.policies[table] = [T.parse_policy_expr("is_member_of(org_id)"),
                             T.parse_policy_expr("can_read_client_org(org_id)")]
    # The member UPDATE policies the tenancy world does not carry (it models
    # firm reads): `"documents member update" … for update using
    # (is_member_of(org_id))` — supabase/schema_phase3.sql:211 — mirrored
    # verbatim so the owner's per-user PATCH / soft-delete / restore LAND in
    # the positive control, exactly as PostgREST would apply them.
    member = T.parse_policy_expr("is_member_of(org_id)")
    w.update_policies.setdefault("documents", []).append((member, member))
    w.add("documents", {"id": DOC_A1_GONE, "org_id": T.ORG_A1, "original_filename": "a1-old.xlsx",
                        "status": "analyzed", "deleted_at": "2026-09-01T00:00:00+00:00"})
    w.add("sales_datasets", {"id": DATASET_A1, "org_id": T.ORG_A1, "document_id": DOC_A1,
                             "label": "Sales A1", "is_active": True})
    w.add("sku_aggregates", {"id": SKU_A1, "dataset_id": DATASET_A1, "org_id": T.ORG_A1,
                             "product_name": "SKU-A1", "classification": "keep"})


@pytest.fixture()
def world(monkeypatch):
    """The tenancy suite's two-firm world, re-wired so that BOTH clients
    (per_user and admin) derive identity from the verifier. The suite's
    own wiring is applied first (its RPCs, clocks and stores), then
    overridden at the two identity seams."""
    _manifest_env(monkeypatch.setenv)
    for key in ("PUBLIC_TEST_MODE", "ENGINE_API_TOKEN", "PRICING_ADMIN_USER_IDS", "SUPABASE_JWT_SECRET"):
        monkeypatch.delenv(key, raising=False)
    w = T.world.__wrapped__(monkeypatch, T.served_envelope.__wrapped__())
    _extend_world(w)

    def _per_user(jwt):  # type: (str) -> _VerifiedClient
        ident = D.verified_identity(jwt)
        if not ident.get("id"):
            return _VerifiedClient(w, None, None, service_role=False)
        return _VerifiedClient(w, ident["id"], ident.get("email"), service_role=False)

    monkeypatch.setattr(_supabase, "per_user", _per_user)
    monkeypatch.setattr(_supabase, "admin", lambda: _VerifiedClient(w, None, None, service_role=True))
    return w


def hdr(user_id: str, org_id: Optional[str] = None, token: Optional[str] = None) -> Dict[str, str]:
    out = {"Authorization": "Bearer %s" % (token or D.mint_jwt(user_id, T.EMAILS.get(user_id)))}
    if org_id:
        out["X-Org-Id"] = org_id
    return out


def snapshot(w: Any) -> Dict[str, List[Dict[str, Any]]]:
    return copy.deepcopy(w.tables)


def diff(before: Dict[str, Any], after: Dict[str, Any]) -> Dict[str, Dict[str, List[str]]]:
    out = {}  # type: Dict[str, Dict[str, List[str]]]
    for table in sorted(set(before) | set(after)):
        b = [json.dumps(r, sort_keys=True, default=str) for r in before.get(table, [])]
        a = [json.dumps(r, sort_keys=True, default=str) for r in after.get(table, [])]
        if b != a:
            out[table] = {"added": sorted(set(a) - set(b)), "removed": sorted(set(b) - set(a))}
    return out


def org_docs(w: Any, org_id: str) -> List[str]:
    return sorted(json.dumps(r, sort_keys=True, default=str)
                  for r in w.rows("documents") if r.get("org_id") == org_id)


def _fill(template: str) -> str:
    path = template
    for name, value in _IDS.items():
        path = path.replace("{%s}" % name, value)
    return path


# ══════════════════════════════════════════════════════════════════════
# D5 — the identity wall
# ══════════════════════════════════════════════════════════════════════


def test_forged_sub_with_a_bad_signature_cannot_clear_a_victims_documents(app, world):
    """The critics' exact forgery: the victim owner's ``sub`` under the
    published kid, signed by a key the JWKS does not hold, ``X-Org-Id`` the
    victim's org. Then the same route with a PROPERLY signed token — the
    intact path still does the work."""
    client = TestClient(app)
    before = org_docs(world, T.ORG_A1)
    assert any('"deleted_at": null' in r for r in before), "precondition: ORG_A1 has a live document"

    forged = D.forged_jwt(T.A_OWNER, T.EMAILS[T.A_OWNER])
    r = client.post("/api/documents/clear-mine", headers=hdr(T.A_OWNER, T.ORG_A1, token=forged))
    after = org_docs(world, T.ORG_A1)
    assert r.status_code == 401 and after == before, (
        "IDENTITY WALL VIOLATED — POST /api/documents/clear-mine accepted an UNVERIFIED identity "
        "(claimed sub=%s = firm A's owner, signature by a key the JWKS does not hold): HTTP %s %s; "
        "ORG_A1 document rows before=%s after=%s"
        % (T.A_OWNER, r.status_code, r.text[:200], before, after))

    # Positive control (non-vacuity): the real owner, properly signed.
    r = client.post("/api/documents/clear-mine", headers=hdr(T.A_OWNER, T.ORG_A1))
    assert r.status_code == 200, (r.status_code, r.text[:300])
    body = r.json()
    live_after = [d for d in world.rows("documents") if d["org_id"] == T.ORG_A1 and d.get("deleted_at") is None]
    assert body["deleted_count"] == 1 and body["org_id"] == T.ORG_A1 and live_after == [], (
        "the intact path did not soft-delete the owner's live document: %s / live rows left: %s"
        % (body, live_after))
    print("[identity-wall] clear-mine: forged bearer 401 + rows byte-identical; signed owner 200 deleted_count=1")


def _refusals():  # type: () -> List[Tuple[str, Any]]
    owner, email = T.A_OWNER, T.EMAILS[T.A_OWNER]
    return [
        ("alg none", lambda: D.mint_jwt(owner, email, alg="none")),
        ("HS256 signed with the PUBLIC key bytes (no secret configured)",
         lambda: D.mint_jwt(owner, email, alg="HS256", hs_secret=D.public_key_bytes())),
        ("expired 120 s ago (leeway is 60 s)", lambda: D.mint_jwt(owner, email, exp_in=-120)),
        ("wrong issuer", lambda: D.mint_jwt(owner, email, iss="https://evil.example.test/auth/v1")),
        ("wrong audience", lambda: D.mint_jwt(owner, email, aud="anon")),
        ("no subject", lambda: D.mint_jwt("", email)),
        ("no key id", lambda: D.mint_jwt(owner, email, kid=None)),
        ("malformed (two segments)", lambda: "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ4In0"),
        ("not a JWT at all", lambda: "PUBLIC_TEST_MODE_BYPASS"),
    ]


@pytest.mark.parametrize("label,mint", _refusals(), ids=[r[0] for r in _refusals()])
def test_every_unverifiable_bearer_is_401_and_moves_nothing(app, world, label, mint):
    client = TestClient(app)
    before = snapshot(world)
    r = client.post("/api/documents/clear-mine", headers=hdr(T.A_OWNER, T.ORG_A1, token=mint()))
    moved = diff(before, snapshot(world))
    assert r.status_code == 401 and not moved, (
        "IDENTITY WALL VIOLATED — POST /api/documents/clear-mine with a bearer that is %s: HTTP %s %s; "
        "tables moved: %s" % (label, r.status_code, r.text[:200], moved))


def test_hs256_is_enabled_only_by_a_configured_secret_and_never_by_the_public_key(app, world, monkeypatch):
    """With SUPABASE_JWT_SECRET set (a self-hosted GoTrue), a token signed
    with that secret verifies; one signed with the public key bytes — the
    alg-confusion attack — still does not."""
    client = TestClient(app)
    monkeypatch.setenv("SUPABASE_JWT_SECRET", "self-hosted-gotrue-secret")
    before = snapshot(world)
    confused = D.mint_jwt(T.A_OWNER, T.EMAILS[T.A_OWNER], alg="HS256", hs_secret=D.public_key_bytes())
    r = client.post("/api/documents/clear-mine", headers=hdr(T.A_OWNER, T.ORG_A1, token=confused))
    assert r.status_code == 401 and not diff(before, snapshot(world)), (
        "ALG CONFUSION — HS256 over the public key bytes was accepted with a secret configured: %s %s"
        % (r.status_code, r.text[:200]))
    honest = D.mint_jwt(T.A_OWNER, T.EMAILS[T.A_OWNER], alg="HS256", hs_secret=b"self-hosted-gotrue-secret")
    r = client.post("/api/documents/clear-mine", headers=hdr(T.A_OWNER, T.ORG_A1, token=honest))
    assert r.status_code == 200 and r.json()["deleted_count"] == 1, (r.status_code, r.text[:200])


def test_exp_leeway_admits_a_token_thirty_seconds_past_its_exp(app, world):
    client = TestClient(app)
    token = D.mint_jwt(T.A_OWNER, T.EMAILS[T.A_OWNER], exp_in=-30)
    r = client.post("/api/documents/clear-mine", headers=hdr(T.A_OWNER, T.ORG_A1, token=token))
    assert r.status_code == 200, ("a token 30 s past exp (leeway 60 s) was refused", r.status_code, r.text[:200])


def test_unknown_kid_costs_exactly_one_jwks_refetch_then_401(app, world):
    client = TestClient(app)
    # Warm the cache with a good bearer: fetch #1.
    r = client.get("/api/dashboard/config", headers=hdr(T.A_OWNER))
    assert r.status_code == 200, (r.status_code, r.text[:200])
    assert _jwt.cache_stats()["fetches"] == 1, _jwt.cache_stats()

    rotated = D.mint_jwt(T.A_OWNER, T.EMAILS[T.A_OWNER], kid="kid-the-jwks-does-not-hold")
    before = snapshot(world)
    r = client.post("/api/documents/clear-mine", headers=hdr(T.A_OWNER, T.ORG_A1, token=rotated))
    assert r.status_code == 401 and not diff(before, snapshot(world)), (r.status_code, r.text[:200])
    assert _jwt.cache_stats()["fetches"] == 2, (
        "an unknown kid must trigger EXACTLY ONE refetch (1 -> 2): %s" % _jwt.cache_stats())

    # A second unknown kid inside the cooldown: refused, no further fetch.
    r = client.post("/api/documents/clear-mine",
                    headers=hdr(T.A_OWNER, T.ORG_A1, token=D.mint_jwt(T.A_OWNER, None, kid="another-unknown")))
    assert r.status_code == 401 and _jwt.cache_stats()["fetches"] == 2, (
        "a flood of unknown kids must not turn the process into a JWKS crawler: %s" % _jwt.cache_stats())
    print("[identity-wall] unknown kid: fetches 1 -> 2 -> 2, both refused 401")


def test_jwks_unreachable_with_an_empty_cache_is_503_never_200(app, world, monkeypatch):
    client = TestClient(app)

    def _down(url):  # type: (str) -> Dict[str, Any]
        raise httpx.ConnectError("jwks endpoint unreachable (test)")

    monkeypatch.setattr(_jwt, "_fetch_jwks", _down)
    _jwt.reset_cache()
    before = snapshot(world)
    r = client.post("/api/documents/clear-mine", headers=hdr(T.A_OWNER, T.ORG_A1))
    assert r.status_code == 503 and _jwt.VERIFIER in r.text and not diff(before, snapshot(world)), (
        "FAIL-OPEN — with no signing key obtainable the identity must be UNAVAILABLE (503 naming %s), "
        "got %s %s" % (_jwt.VERIFIER, r.status_code, r.text[:200]))


def test_jwks_unreachable_with_a_warm_cache_serves_the_last_good_key_set(app, world, monkeypatch):
    client = TestClient(app)
    r = client.get("/api/dashboard/config", headers=hdr(T.A_OWNER))
    assert r.status_code == 200 and _jwt.cache_stats()["kids"] == [D.TEST_KID], _jwt.cache_stats()

    def _down(url):  # type: (str) -> Dict[str, Any]
        raise httpx.ConnectError("jwks endpoint unreachable (test)")

    monkeypatch.setattr(_jwt, "_fetch_jwks", _down)
    monkeypatch.setattr(_jwt, "JWKS_TTL_S", 0.0)  # every verify wants a refresh
    r = client.post("/api/documents/clear-mine", headers=hdr(T.A_OWNER, T.ORG_A1))
    assert r.status_code == 200 and r.json()["deleted_count"] == 1, (
        "STALE-WHILE-ERROR — a failed refetch must keep the last good key set: %s %s"
        % (r.status_code, r.text[:200]))
    assert _jwt.cache_stats()["failed_at"] > 0, _jwt.cache_stats()


def test_the_routes_the_critic_named_refuse_a_forged_bearer_and_accept_a_signed_one(app, world, monkeypatch):
    """clear-mine, GET/PUT dashboard config, the firm e-mail drain — and two
    more shapes of the same seam (`_pricing_routes._user_id_from_jwt`,
    `client.get_user` inside a period route)."""
    client = TestClient(app)
    monkeypatch.setenv("PRICING_ADMIN_USER_IDS", T.A_OWNER)  # the forged sub IS on the allowlist
    forged = D.forged_jwt(T.A_OWNER, T.EMAILS[T.A_OWNER])
    named = [
        ("POST", "/api/documents/clear-mine", None),
        ("GET", "/api/dashboard/config", None),
        ("PUT", "/api/dashboard/config", {"cards": []}),
        ("POST", "/api/firm/email/drain", None),
        ("POST", "/api/plan/commit-document-usage", None),
        ("PUT", "/api/period/%s/valuation-assumptions" % T.PERIOD_A1, {"ebitda_used": 1}),
    ]
    before = snapshot(world)
    failures = []
    for method, path, body in named:
        r = client.request(method, path, headers=hdr(T.A_OWNER, T.ORG_A1, token=forged), json=body)
        if r.status_code != 401:
            failures.append("%s %s -> %s %s" % (method, path, r.status_code, r.text[:120]))
    moved = diff(before, snapshot(world))
    assert not failures and not moved, (
        "IDENTITY WALL VIOLATED — route(s) accepted a forged bearer (sub=%s on the admin allowlist):\n  %s\n"
        "tables moved: %s" % (T.A_OWNER, "\n  ".join(failures), moved))

    # Positive controls: properly signed, each route does its work.
    r = client.get("/api/dashboard/config", headers=hdr(T.A_OWNER))
    assert r.status_code == 200 and r.json() == {"cards": []}, (r.status_code, r.text[:200])
    r = client.post("/api/firm/email/drain", headers=hdr(T.A_OWNER))
    assert r.status_code == 200 and r.json()["drained"] == 0, (r.status_code, r.text[:200])
    r = client.post("/api/firm/email/drain", headers=hdr(T.B_OWNER))
    assert r.status_code == 403, ("a verified id NOT on the allowlist must be refused", r.status_code, r.text[:200])
    print("[identity-wall] %d named routes: forged 401 each; signed owner served" % len(named))


#: /api/firm routes that take a bearer but resolve NO identity from it —
#: static reference data (`_require_jwt` only checks the header is there).
_FIRM_STATIC = {
    "/api/firm/roles": "the role matrix constants (FIRM_API_VERSION); no tenant data",
    "/api/firm/import/columns": "the CSV header contract; no tenant data",
    "/api/firm/attention/kinds": "the attention pack's kinds; no tenant data",
}

#: A plausible value per required field name, so a request reaches the
#: handler (FastAPI validates the body BEFORE any auth code runs — a 422
#: proves nothing about the wall).
_FIELD_VALUES = {
    "client_org_id": T.ORG_A1, "org_id": T.ORG_A1, "client_id": T.ORG_A1, "firm_id": T.FIRM_A,
    "user_id": T.A_VIEWER, "request_id": T.REQUEST_A1, "invitation_id": T.INVITATION_A,
    "period_id": T.PERIOD_A1, "token": "not-a-token", "email": "intruder@example.test",
    "role": "viewer", "kind": "CASH_RUNWAY", "cadence": "monthly", "period_end": "2025-12-31",
    "csv": "cui,name\n11111111,Client A1\n", "name": "Forged Firm", "reason": "forged",
}


def _firm_requests_reading_a_bearer(app) -> List[Tuple[str, str, Dict[str, Any], Dict[str, Any]]]:
    """(method, path template, query, body) for every /api/firm route that
    reads a bearer, the required fields filled from the OpenAPI schema."""
    schema = app.openapi()
    comps = schema.get("components", {}).get("schemas", {})
    out = []
    for route in app.routes:
        if not isinstance(route, APIRoute) or not route.path.startswith("/api/firm"):
            continue
        if "/cron/" in route.path or route.path in _FIRM_STATIC:
            continue  # crons: ENGINE_API_TOKEN, 503 fail-closed (test_cron_auth); static: declared above
        if "authorization" not in inspect.signature(route.endpoint).parameters:
            continue  # the signed-link landing (upload / resolve) carries no bearer
        for method in sorted(route.methods or ()):
            op = schema["paths"].get(route.path_format, {}).get(method.lower(), {})
            query = {"firm_id": T.FIRM_A}  # optional on the cockpit routes: names the firm up front
            for param in op.get("parameters", []) or []:
                if param.get("in") == "query" and param.get("required"):
                    query[param["name"]] = _FIELD_VALUES.get(param["name"], "x")
            body = {}  # type: Dict[str, Any]
            ref = (((op.get("requestBody") or {}).get("content") or {}).get("application/json", {})
                   .get("schema", {})).get("$ref")
            if ref:
                model = comps[ref.rsplit("/", 1)[1]]
                for field in model.get("required", []):
                    body[field] = _FIELD_VALUES.get(field, "x")
            out.append((method, route.path, query, body))
    return out


def test_every_api_firm_route_refuses_a_forged_bearer_with_401(app, world):
    """The Python wall on /api/firm used to pass a forged bearer (200 in the
    double, PostgREST alone standing in prod). Now every bearer-reading
    firm route is 401 before it touches a table — with a VALID request
    shape, so the refusal is the verifier's and not a 422."""
    client = TestClient(app)
    requests = _firm_requests_reading_a_bearer(app)
    assert len(requests) >= 25, "VACUOUS — only %d /api/firm routes read a bearer" % len(requests)
    forged = D.forged_jwt(T.A_OWNER, T.EMAILS[T.A_OWNER])
    before = snapshot(world)
    failures = []
    for method, template, query, body in requests:
        path = re.sub(r"\{(\w+)(?::\w+)?\}", lambda m: _FIELD_VALUES.get(m.group(1), T.U(999)), template)
        r = client.request(method, path, params=query, headers=hdr(T.A_OWNER, T.ORG_A1, token=forged),
                           json=body)
        if r.status_code != 401:
            failures.append("%s %s -> %s %s" % (method, template, r.status_code, r.text[:100]))
    moved = diff(before, snapshot(world))
    assert not failures and not moved, (
        "IDENTITY WALL VIOLATED on /api/firm — forged bearer not refused with 401:\n  %s\ntables moved: %s"
        % ("\n  ".join(failures), moved))
    # Non-vacuity: the same bearer shape, properly signed, gets past the verifier.
    r = client.get("/api/firm/%s/clients" % T.FIRM_A, headers=hdr(T.A_OWNER))
    assert r.status_code == 200 and T.ORG_A1 in r.text, (r.status_code, r.text[:200])
    print("[identity-wall] %d /api/firm requests refuse a forged bearer with 401 (%d static routes declared)"
          % (len(requests), len(_FIRM_STATIC)))


def _code_only(source: str) -> str:
    """The source minus every comment and string token — a docstring that
    names the old decode to explain its removal is not a call."""
    import io
    import tokenize
    kept = []
    try:
        for tok in tokenize.generate_tokens(io.StringIO(source).readline):
            if tok.type in (tokenize.COMMENT, tokenize.STRING):
                continue
            kept.append(tok.string)
    except tokenize.TokenError:
        return source
    return " ".join(kept)


#: The unverified-decode call sites this census ALLOWS, each with why.
_DECODE_ALLOWED = {
    "_jwt.py": "the verifier itself (unverified_claims_for_logging is a log line about a REFUSED bearer)",
    "_test_mode.py": "_parse_jwt_exp schedules the refresh of the test-mode token it minted itself; never an identity",
    "_firm_requests.py": "its own HMAC-signed request-link tokens (parse_token verifies them); not a JWT",
}


def test_no_module_derives_an_identity_from_an_unverified_claim():
    """Census by name: the old decode is gone from `_supabase`, the renamed
    log-only decode is called by nothing but the verifier, and every
    base64 payload decode under engine.api / engine.ai_lane is on the
    allowlist above with its reason."""
    assert not hasattr(_supabase, "_decode_jwt_claims"), \
        "the unverified decode is back under its old name in engine.api._supabase"
    offenders = []
    for path in sorted(list(API_DIR.glob("*.py")) + list(AI_LANE_DIR.glob("*.py"))):
        code = _code_only(path.read_text(encoding="utf-8"))
        if "_decode_jwt_claims" in code:
            offenders.append("%s references _decode_jwt_claims" % path.name)
        if "unverified_claims_for_logging(" in code and path.name != "_jwt.py":
            offenders.append("%s calls unverified_claims_for_logging (log-only; authorization must not)" % path.name)
        if "urlsafe_b64decode(" in code and path.name not in _DECODE_ALLOWED:
            offenders.append("%s decodes a base64url payload outside the verifier (undeclared)" % path.name)
    assert not offenders, "UNVERIFIED-IDENTITY CENSUS VIOLATED:\n  " + "\n  ".join(offenders)
    # The two identity seams are the verifier, not a client a double could wave through.
    assert "_jwt.verified_identity(" in inspect.getsource(_org.resolve_user_id) and \
        "per_user(" not in inspect.getsource(_org.resolve_user_id), inspect.getsource(_org.resolve_user_id)
    assert "_jwt.verified_identity(" in inspect.getsource(_supabase.SupabaseClient.get_user), \
        inspect.getsource(_supabase.SupabaseClient.get_user)


# ══════════════════════════════════════════════════════════════════════
# D4 — the write wall
# ══════════════════════════════════════════════════════════════════════


def _mutating_routes(app) -> List[Tuple[str, str, Any]]:
    out = []
    for route in app.routes:
        if isinstance(route, APIRoute):
            for method in sorted(route.methods or ()):
                if method in ("POST", "PUT", "PATCH", "DELETE"):
                    out.append((method, route.path, route.endpoint))
    return sorted(out, key=lambda t: (t[1], t[0]))


def _wall_text(endpoint: Any) -> str:
    """The handler's source plus the source of every function it calls by
    name that resolves through its globals or its closure — one hop, the
    depth every member-walled handler's wall sits at."""
    src = inspect.getsource(endpoint)
    out = [src]
    try:
        cv = inspect.getclosurevars(endpoint)
    except (TypeError, ValueError):
        return src
    for name in sorted(set(re.findall(r"\b([A-Za-z_][A-Za-z0-9_]*)\(", src))):
        fn = cv.nonlocals.get(name)
        if fn is None:
            fn = cv.globals.get(name)
        if inspect.isfunction(fn) and fn is not endpoint:
            try:
                out.append(inspect.getsource(fn))
            except (OSError, TypeError):
                pass
    return "\n".join(out)


def test_every_mutating_route_of_the_real_app_is_classified(app):
    routes = _mutating_routes(app)
    assert len(routes) >= 80, "VACUOUS — only %d mutating routes discovered" % len(routes)
    counts = {"member-walled": 0, "firm-walled": 0, "declared": 0}
    unclassified = []
    unwalled = []
    for method, path, endpoint in routes:
        key = (method, path)
        if path.startswith(FIRM_PREFIXES):
            counts["firm-walled"] += 1
        elif key in MEMBER_WALLED:
            counts["member-walled"] += 1
            text = _wall_text(endpoint)
            if not any(p in text for p in PRIMITIVES):
                unwalled.append("%s %s (%s.%s)" % (method, path, endpoint.__module__, endpoint.__name__))
        elif key in DECLARED:
            counts["declared"] += 1
        else:
            unclassified.append("%s %s (%s.%s)" % (method, path, endpoint.__module__, endpoint.__name__))
    stale = sorted(k for k in list(MEMBER_WALLED) + list(DECLARED) if k not in set((m, p) for m, p, _e in routes))
    assert not unclassified, (
        "WRITE-WALL CENSUS VIOLATED — mutating route(s) neither member-walled, firm-walled nor declared:\n  %s"
        % "\n  ".join(unclassified))
    assert not unwalled, (
        "WRITE-WALL VIOLATED — member-walled route(s) whose handler reaches none of %s within one hop:\n  %s"
        % (PRIMITIVES, "\n  ".join(unwalled)))
    assert not stale, "classification names routes the app no longer mounts: %s" % stale
    assert counts["member-walled"] == len(MEMBER_WALLED) == len(SWEEP), counts
    print("[write-wall] %d mutating routes: %s" % (len(routes), counts))


def _drive_sweep(client: TestClient, world: Any, actor: str, label: str) -> None:
    before = snapshot(world)
    violations = []
    transcript = []
    for method, template, body, expect in SWEEP:
        path = _fill(template)
        r = client.request(method, path, headers=hdr(actor, T.ORG_A1), json=body)
        moved = diff(before, snapshot(world))
        if expect == "403":
            ok = r.status_code == 403 and not moved
        else:
            ok = r.status_code == 200 and not moved
        transcript.append("%-6s %-55s -> %s%s" % (method, path, r.status_code, " MOVED %s" % moved if moved else ""))
        if not ok:
            violations.append("%s %s as %s -> HTTP %s %s; expected %s; tables moved: %s" % (
                method, path, label, r.status_code, r.text[:160].replace("\n", " "), expect,
                json.dumps(moved, default=str)[:600]))
        if moved:
            before = snapshot(world)  # keep the diff per route
    print("[write-wall] sweep as %s:\n  %s" % (label, "\n  ".join(transcript)))
    assert not violations, (
        "WRITE WALL VIOLATED — a firm %s with a read cell and NO membership wrote a client's books:\n  %s"
        % (label, "\n  ".join(violations)))


def test_a_firm_viewer_with_a_read_cell_and_no_membership_cannot_write_a_clients_books(app, world):
    client = TestClient(app)
    viewer_email = T.EMAILS[T.A_VIEWER]
    period = next(p for p in world.rows("financial_periods") if p["id"] == T.PERIOD_A1)
    doc = next(d for d in world.rows("documents") if d["id"] == DOC_A1)
    dataset = next(d for d in world.rows("sales_datasets") if d["id"] == DATASET_A1)
    # Precondition — the viewer SEES the targets (so every 403 below is the wall, not visibility)
    assert world.visible(T.A_VIEWER, viewer_email, "financial_periods", period)
    assert world.visible(T.A_VIEWER, viewer_email, "documents", doc)
    assert world.visible(T.A_VIEWER, viewer_email, "sales_datasets", dataset)
    assert not any(m["user_id"] == T.A_VIEWER for m in world.rows("memberships")), "A_VIEWER must hold no membership"
    _drive_sweep(client, world, T.A_VIEWER, "A_VIEWER (firm A viewer, client attached to firm A)")


def test_after_a_re_attach_the_new_firms_viewer_holds_the_same_nothing(app, world):
    """Client A1 moves from firm A to firm B. Firm B's viewer now SEES it
    (can_read_client_org follows organizations.firm_id) and still writes
    nothing; firm A's viewer no longer sees it at all."""
    client = TestClient(app)
    org = next(o for o in world.rows("organizations") if o["id"] == T.ORG_A1)
    org["firm_id"] = T.FIRM_B
    period = next(p for p in world.rows("financial_periods") if p["id"] == T.PERIOD_A1)
    assert world.visible(T.B_VIEWER, T.EMAILS[T.B_VIEWER], "financial_periods", period)
    assert not world.visible(T.A_VIEWER, T.EMAILS[T.A_VIEWER], "financial_periods", period)
    _drive_sweep(client, world, T.B_VIEWER, "B_VIEWER (firm B viewer, client re-attached A -> B)")
    r = client.delete("/api/period/%s" % T.PERIOD_A1, headers=hdr(T.A_VIEWER, T.ORG_A1))
    assert r.status_code == 404 and any(p["id"] == T.PERIOD_A1 for p in world.rows("financial_periods")), (
        "after the move firm A's viewer must not even see the period", r.status_code, r.text[:200])


def test_the_owner_still_writes_through_every_wall_it_holds_a_membership_for(app, world):
    """Non-vacuity: the member the wall is for gets the full result."""
    client = TestClient(app)
    r = client.patch("/api/documents/%s" % DOC_A1, headers=hdr(T.A_OWNER), json={"display_name": "renamed-by-owner"})
    assert r.status_code == 200 and r.json()["display_name"] == "renamed-by-owner", (r.status_code, r.text[:200])
    r = client.delete("/api/documents/%s" % DOC_A1, headers=hdr(T.A_OWNER))
    assert r.status_code == 200, (r.status_code, r.text[:200])
    doc = next(d for d in world.rows("documents") if d["id"] == DOC_A1)
    assert doc["deleted_at"] is not None, doc
    r = client.post("/api/documents/%s/restore" % DOC_A1, headers=hdr(T.A_OWNER))
    assert r.status_code == 200 and doc["deleted_at"] is None, (r.status_code, r.text[:200], doc)
    r = client.delete("/api/period/%s" % T.PERIOD_A1, headers=hdr(T.A_OWNER))
    assert r.status_code == 200 and r.json()["ok"] is True, (r.status_code, r.text[:200])
    assert not any(p["id"] == T.PERIOD_A1 for p in world.rows("financial_periods")), \
        "the owner's DELETE /api/period/{id} did not remove the period"
    assert any(p["id"] == T.PERIOD_A2 for p in world.rows("financial_periods")), "a sibling period was touched"
    print("[write-wall] owner: PATCH 200, DELETE doc 200, restore 200, DELETE period 200 (row gone)")


def test_require_org_member_never_falls_back_to_another_org_the_caller_belongs_to(world):
    """SOLO is a member of ORG_S only; naming ORG_A1 is 403 — the write is
    never re-targeted to a workspace the caller does belong to."""
    token = D.mint_jwt(T.SOLO, T.EMAILS[T.SOLO])
    assert _org.require_org_member(token, T.ORG_S) == T.SOLO
    for target in (T.ORG_A1, "", None, T.U(999)):
        with pytest.raises(_jwt.HTTPException) as exc:
            _org.require_org_member(token, target)
        assert exc.value.status_code == 403, (target, exc.value.status_code)
    with pytest.raises(_jwt.HTTPException) as exc:
        _org.require_org_member(D.forged_jwt(T.SOLO), T.ORG_S)
    assert exc.value.status_code == 401
