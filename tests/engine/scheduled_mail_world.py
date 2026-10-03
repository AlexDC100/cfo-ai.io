"""THE WORLD of GATE scheduled-mail-tenancy — NO SCHEDULED MAIL REACHES A PERSON WHO IS
NOT ENTITLED TO IT, CARRIES ANOTHER TENANT'S DATA, OR GOES OUT TWICE.

THE AUDIT (owner ticket 2026-10-02, before the Firm Cockpit flag flips).
Every scheduled or cron-triggered route that queues or sends mail runs under
the SERVICE ROLE, where no row-level policy applies: the filter the code
writes IS the access control. Read end to end, five defects were live in the
code (none reachable in production while FIRM_COCKPIT_ENABLED is unset and no
scheduler calls the renewal cron — which is why they are closed here, first):

  R1  POST /api/billing/cron/renewal-reminders chose its recipient as the
      FIRST `memberships` row of the subscription's workspace ordered
      `role.asc` — 'admin' < 'member' < 'owner'. The payer sorts LAST. The
      firm's `import_firm_client` RPC writes the responsible accountant into
      a client workspace as 'admin', so with the Cockpit on, a client's
      renewal date and price went to the firm's accountant.
  R2  The same cron had no idempotency marker (its docstring claimed one):
      every run queued another reminder.
  F1  The firm digest read open file requests by `client_org_id` alone. A
      client that moved from firm X to firm Y carried X's request into every
      digest of Y — the row `firm_file_requests firm read` (RLS) hides.
  F2  The digest computed every workspace ATTACHED to the firm, archived
      ones included: a client in its 30-day purge window stayed in the mail.
  F6  The drains sent whatever was queued. A member removed between the cron
      and the drain still received the firm's client list; a subscription
      cancelled in between was still told "we'll charge the card on file".

THE LAW, on the REAL `create_app()` over the tenancy suite's two-firm world
(FirmWorld: tables, policies and RPCs parsed from the migrations), through
the real cron and drain routes, with the mail provider replaced by a
recorder (nothing here can reach a provider: RESEND_API_KEY is deleted and
`_email.send_email` / `send_batch` are the recorder):

  1. A digest names only workspaces its recipient reads TODAY: clients the
     named firm serves now, unarchived; for a personal digest, the
     recipient's own live workspaces. Audited on every sent digest row —
     body, text and payload.
  2. A request another firm minted never appears in this firm's digest.
  3. A removed member, a member of an archived firm, a user who opted out
     after the cron ran, and a workspace the user left are not mailed —
     decided again AT SEND TIME, not only when the row was queued.
  4. A reminder is not sent for a request whose firm no longer serves the
     client, whose client is archived, or that was revoked after queueing.
  5. A renewal reminder goes to the SUBSCRIBER (`subscriptions.user_id`),
     else the workspace's oldest OWNER — never to an admin or member, never
     to a firm accountant; never for a subscription that is cancelling; and
     not at all once the subscription changed between queue and drain.
  6. One run, two runs, two interleaved runs, a drain whose mark-sent write
     fails, two drains: ONE mail per (recipient, subject matter).
  7. The drains refuse a missing bearer (401) and a signed non-admin (403)
     and send nothing. (The crons' 503 / 401 is tests/engine/test_cron_auth.)
  8. Every function that queues or sends mail is on the census below; a new
     sender is red until it is classified with its recipient rule.

REDS ON, with the defects repaired (TC-11): a recipient chosen by a
membership row that is not the subscriber / an owner; a digest read of
`firm_file_requests` without the firm; an archived workspace in a digest; a
drain that sends without re-deciding entitlement; a send before the queue
row is claimed; a digest queued before its day is claimed in
`firm_digest_log`; a renewal queued twice for one renewal date; a mail
sender missing from the census.
CANNOT SEE: the real provider (never called); the database's own unique
indexes (enforced here from a declared copy of the two that matter —
`firm_digest_log_user_firm_day_uidx` and the renewal queue's dedupe index);
two schedulers racing on different hosts beyond the interleavings planted
here; a `subscriptions` row whose columns differ from what `_billing` reads
(the table's `org_id` / `is_founder` columns exist in production and in no
migration of this repository — CLAUDE.md §16 "Known drift").

THE FILES. This module is the harness (the real app, the world, the
recorder, the route drivers, the digest audit); the laws are
test_scheduled_mail_renewals.py (5, 6), test_scheduled_mail_digest.py
(1, 2, 3, 6), test_scheduled_mail_requests.py (4) and
test_scheduled_mail_census.py (7, 8).

PLANT LOG: docs/engine_book/gates.md "scheduled-mail-tenancy".

Python 3.9 — no `match`, no `X | Y` unions.
"""

from __future__ import annotations

import copy
import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

import pytest
from fastapi.testclient import TestClient

import firm_postgrest_double as D
import test_firm_tenancy as T
from engine.api import _billing, _email, _supabase
from engine.api import _firm_requests as FR

REPO = Path(__file__).resolve().parents[2]
API_DIR = REPO / "src" / "engine" / "api"

SCHEDULER_TOKEN = "scheduled-mail-law-token"
SCHED = {"Authorization": "Bearer %s" % SCHEDULER_TOKEN}
#: The operator who drains: on the admin allowlist, a member of nothing.
OPS = T.U(41)
OPS_EMAIL = "ops@example.test"
#: A teammate in the payer's workspace, and a workspace with no owner row.
TEAMMATE = T.U(42)
ORG_ORPHAN = T.U(206)
ORG_SOLO2 = T.U(207)
NIL = "00000000-0000-0000-0000-000000000000"

#: The cron's "today" and wall clock for the firm routes (the world's own
#: clock is frozen at 2026-09-03 12:00 UTC; 09:00 is past every send hour).
DAY = "2026-09-20"
NOW = datetime(2026, 9, 20, 9, 0, tzinfo=timezone.utc)

#: A period no other row carries: finding it in a body says WHOSE request
#: was read.
FOREIGN_PERIOD = "2024-02-29"


# ── the world ────────────────────────────────────────────────────────────


def _manifest_env(setenv: Callable[[str, str], None]) -> None:
    setenv("VITE_SUPABASE_URL", "https://test.supabase.co")
    setenv("VITE_SUPABASE_ANON_KEY", "test-anon")
    setenv("SUPABASE_SERVICE_ROLE_KEY", "test-service")
    setenv("CFO_AI_SKIP_BOOT_VERIFY", "1")
    # The Cockpit mounts only behind this flag and it is UNSET in production
    # (test_firm_real_app.py::test_the_cockpit_is_not_mounted_without_its_flag).
    # This gate is the audit that must be clean BEFORE it is set, so it
    # builds the app with the surface on.
    setenv("FIRM_COCKPIT_ENABLED", "1")
    setenv(FR.SIGNING_KEY_ENV, "scheduled-mail-signing-key-0123456789")


@pytest.fixture(scope="module")
def app():
    """The REAL app — the object `python -m engine serve` runs."""
    for key in ("PUBLIC_TEST_MODE", "ENGINE_TEST_MODE", "PRICING_ADMIN_USER_IDS",
                "SUPABASE_JWT_SECRET", "ANTHROPIC_API_KEY", "RESEND_API_KEY"):
        os.environ.pop(key, None)
    _manifest_env(os.environ.__setitem__)
    os.environ.setdefault("AI_BREAKER_STATE_DIR",
                          str(Path(os.environ.get("TMPDIR", "/tmp")) / "scheduled-mail-ai"))
    assert "test." in os.environ["VITE_SUPABASE_URL"], "refusing a non-manifest Supabase URL"
    from engine.api.server import create_app
    application = create_app(config_path=REPO / "config.yaml")
    paths = set(getattr(r, "path", "") for r in application.routes)
    for needed in ("/api/firm/digest/cron/run", "/api/firm/requests/cron/nudge",
                   "/api/firm/email/drain", "/api/billing/cron/renewal-reminders",
                   "/api/newsletter/drain-renewals"):
        assert needed in paths, "the real app does not serve %s — the law would be vacuous" % needed
    return application


#: The unique indexes the laws depend on, as the migrations declare them
#: (schema_phase_firm_requests.sql §4; schema_phase_email_idempotency.sql).
#: The tenancy double models policies, not indexes, so they are enforced
#: here: a second row with the same key is PostgREST's 409 / SQLSTATE 23505.
UNIQUE_KEYS = {
    "firm_digest_log": ("firm_digest_log_user_firm_day_uidx",
                        lambda r: (str(r.get("user_id")), str(r.get("firm_id") or NIL),
                                   str(r.get("sent_for_date"))[:10])),
    "renewal_email_queue": ("renewal_email_queue_dedupe_uidx",
                            lambda r: (str(r.get("subscription_id")), str(r.get("template")),
                                       str(((r.get("payload") or {}).get("vars") or {})
                                           .get("renewal_date"))[:10])),
}  # type: Dict[str, Tuple[str, Callable[[Dict[str, Any]], Any]]]

#: Column defaults the database applies and the double does not.
DEFAULTS = {"renewal_email_queue": {"status": "queued"},
            "firm_email_queue": {"status": "queued"}}


class _MailClient(T._Client):
    """The tenancy suite's client, plus what the mail paths need: verified
    identity, the two range operators the renewal cron sends, the unique
    index the digest claims on, and two planted-fault seams."""

    def get_user(self, jwt):  # type: (str) -> Dict[str, Any]
        return D.verified_identity(jwt)

    def select(self, table, filters=None, columns="*", limit=None, order=None, single=False):
        params = dict(filters or {})
        ranged = [(k, v) for k, v in params.items()
                  if isinstance(v, str) and (v.startswith("gte.") or v.startswith("lte."))]
        for key, _ in ranged:
            params.pop(key)
        fault = self.world.select_faults.get(table)
        if fault is not None and self.service_role:
            raise RuntimeError("HTTP 503: planted read failure on %s (%s)" % (table, fault))
        if not ranged:
            return super(_MailClient, self).select(table, filters=params, columns=columns,
                                                   limit=limit, order=order, single=single)
        rows = super(_MailClient, self).select(table, filters=params, columns="*", order=order)
        for key, expr in ranged:
            if key not in self.world.columns[table]:
                raise RuntimeError("HTTP 400: column %s.%s does not exist" % (table, key))
            bound = expr[4:]
            rows = [r for r in rows if r.get(key) is not None and
                    (str(r[key]) >= bound if expr.startswith("gte.") else str(r[key]) <= bound)]
        return rows[:limit] if limit is not None else rows

    def insert(self, table, rows, returning=True):
        rows_list = rows if isinstance(rows, list) else [rows]
        hook = self.world.before_insert.pop(table, None)
        if hook is not None:
            hook()   # an interleaving: whatever it wrote is there before this row lands
        unique = UNIQUE_KEYS.get(table) if table not in self.world.indexes_absent else None
        if unique is not None:
            name, key_of = unique
            held = set(key_of(r) for r in self.world.rows(table))
            for r in rows_list:
                if key_of(r) in held:
                    raise RuntimeError(
                        "Supabase insert into %s failed (HTTP 409): {'code': '23505', 'message': "
                        "'duplicate key value violates unique constraint \"%s\"'}" % (table, name))
        for r in rows_list:
            for column, value in DEFAULTS.get(table, {}).items():
                r.setdefault(column, value)
        return super(_MailClient, self).insert(table, rows_list, returning=returning)

    def update(self, table, patch, filters):
        self._maybe_fault(table, patch)
        return super(_MailClient, self).update(table, patch, filters)

    def update_returning(self, table, patch, filters):
        self._maybe_fault(table, patch)
        return super(_MailClient, self).update_returning(table, patch, filters)

    def _maybe_fault(self, table, patch):  # type: (str, Dict[str, Any]) -> None
        for fault in list(self.world.update_faults):
            if fault(table, patch):
                self.world.update_faults.remove(fault)
                raise RuntimeError("HTTP 503: planted write failure on %s" % table)


def _newsletter_columns() -> Dict[str, List[str]]:
    sql = (REPO / "supabase" / "schema_phase_newsletter.sql").read_text(encoding="utf-8")
    return T.parse_table_columns(sql)


def _extend_world(w: Any) -> None:
    """The billing / newsletter tables the mail paths read. The two queue
    tables' columns are PARSED from their migration; `subscriptions` is
    schema.sql:171 plus the columns `_billing` writes that no migration in
    this repository declares (CLAUDE.md §16 "Known drift": org_id,
    is_founder, plan_key, founder_renewal_*). Service-role only: no policy."""
    parsed = _newsletter_columns()
    extra = {
        "renewal_email_queue": parsed["renewal_email_queue"],
        "email_send_log": parsed["email_send_log"],
        "subscriptions": ["id", "user_id", "org_id", "status", "is_founder", "plan_key",
                          "current_period_start", "current_period_end", "cancel_at_period_end",
                          "stripe_customer_id", "stripe_subscription_id", "created_at",
                          "updated_at"],
    }
    ops = getattr(T, "_TABLE_PRIVILEGE_OPS", ("insert", "update", "delete"))
    for table, cols in extra.items():
        w.columns[table] = list(cols)
        w.tables[table] = []
        w.policies[table] = []
        for role in T.API_ROLES:
            w.privileges[(role, table)] = dict((op, False) for op in ops)
    #: Tables whose unique index is NOT in this database. The renewal
    #: queue's dedupe index is a migration production has not applied yet
    #: (schema_phase_email_idempotency.sql): a law that must hold today is
    #: run with it absent; only the interleaving law needs it.
    w.indexes_absent = set(["renewal_email_queue"])
    w.before_insert = {}   # table -> a callable fired once, BEFORE the next insert lands
    w.update_faults = []   # [(table, patch) -> bool], each fires once
    w.select_faults = {}   # table -> reason: every service-role read of it fails
    w.auth_users[OPS] = OPS_EMAIL
    w.auth_users[TEAMMATE] = "teammate@example.test"


class Outbox(object):
    """What the provider WOULD have been asked to deliver. Nothing leaves."""

    def __init__(self) -> None:
        self.sent = []  # type: List[Dict[str, Any]]

    def send_email(self, *, to: Any, subject: str, html: str, **_kw: Any) -> Dict[str, Any]:
        for addr in ([to] if isinstance(to, str) else list(to)):
            self.sent.append({"to": addr, "subject": subject, "html": html})
        return {"ok": True, "skipped": False, "id": "recorded-%d" % len(self.sent)}

    def send_batch(self, messages: List[Dict[str, Any]]) -> Dict[str, Any]:
        for m in messages:
            self.send_email(to=m["to"], subject=m["subject"], html=m["html"])
        return {"ok": True, "skipped": False, "sent": len(messages), "failed": 0}

    def to(self, address: str) -> List[Dict[str, Any]]:
        return [m for m in self.sent if m["to"] == address]

    def recipients(self) -> List[str]:
        return sorted(m["to"] for m in self.sent)


@pytest.fixture()
def world(monkeypatch):
    _manifest_env(monkeypatch.setenv)
    for key in ("PUBLIC_TEST_MODE", "ENGINE_TEST_MODE", "SUPABASE_JWT_SECRET", "RESEND_API_KEY"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("ENGINE_API_TOKEN", SCHEDULER_TOKEN)
    monkeypatch.setenv("PRICING_ADMIN_USER_IDS", OPS)
    w = T.world.__wrapped__(monkeypatch, T.served_envelope.__wrapped__())
    _extend_world(w)

    def _per_user(jwt):  # type: (str) -> _MailClient
        ident = D.verified_identity(jwt)
        if not ident.get("id"):
            return _MailClient(w, None, None, service_role=False)
        return _MailClient(w, ident["id"], ident.get("email"), service_role=False)

    monkeypatch.setattr(_supabase, "per_user", _per_user)
    monkeypatch.setattr(_supabase, "admin", lambda: _MailClient(w, None, None, service_role=True))
    # auth.users.email is the auth admin API, which the double does not
    # serve; the address book is the world's.
    monkeypatch.setattr(_billing, "_user_email", lambda user_id: w.auth_users.get(str(user_id)))
    monkeypatch.setattr(FR, "_now", lambda: NOW)
    # The tenancy world seeds one queued request e-mail, one digest log row
    # and one ENABLED preference for ITS laws; this gate starts from an
    # empty queue and log, and nobody is opted in until a test says so.
    w.tables["firm_email_queue"] = []
    w.tables["firm_digest_log"] = []
    for pref in w.rows("firm_digest_prefs"):
        pref["enabled"] = False
    return w


@pytest.fixture()
def outbox(monkeypatch):
    box = Outbox()
    assert not os.environ.get("RESEND_API_KEY"), "a provider key is present — refusing to run"
    monkeypatch.setattr(_email, "send_email", box.send_email)
    monkeypatch.setattr(_email, "send_batch", box.send_batch)
    return box


@pytest.fixture()
def client(app, world, outbox):
    return TestClient(app)


def hdr(user_id: str, email: Optional[str] = None) -> Dict[str, str]:
    return {"Authorization": "Bearer %s" % D.mint_jwt(
        user_id, email or T.EMAILS.get(user_id) or OPS_EMAIL)}


# ── driving the routes ───────────────────────────────────────────────────


def run_digest(client: TestClient, day: str = DAY) -> Dict[str, Any]:
    r = client.post("/api/firm/digest/cron/run", params={"as_of": day}, headers=SCHED)
    assert r.status_code == 200, (r.status_code, r.text[:400])
    return r.json()


def run_nudge(client: TestClient, day: str = DAY) -> Dict[str, Any]:
    r = client.post("/api/firm/requests/cron/nudge", params={"as_of": day}, headers=SCHED)
    assert r.status_code == 200, (r.status_code, r.text[:400])
    return r.json()


def drain_firm(client: TestClient) -> Dict[str, Any]:
    r = client.post("/api/firm/email/drain", headers=hdr(OPS))
    assert r.status_code == 200, (r.status_code, r.text[:400])
    return r.json()


def run_renewals(client: TestClient) -> Dict[str, Any]:
    r = client.post("/api/billing/cron/renewal-reminders", headers=SCHED)
    assert r.status_code == 200, (r.status_code, r.text[:400])
    return r.json()


def drain_renewals(client: TestClient) -> Dict[str, Any]:
    r = client.post("/api/newsletter/drain-renewals", headers=hdr(OPS))
    assert r.status_code == 200, (r.status_code, r.text[:400])
    return r.json()


def enable_digest(w: Any, user_id: str, firm_id: Optional[str]) -> None:
    for row in w.rows("firm_digest_prefs"):
        if row["user_id"] == user_id and row.get("firm_id") == firm_id:
            row["enabled"] = True
            return
    w.add("firm_digest_prefs", {"user_id": user_id, "firm_id": firm_id, "enabled": True,
                                "frequency": "daily", "send_hour_utc": 7, "last_item_ids": []})


def org(w: Any, org_id: str) -> Dict[str, Any]:
    return next(o for o in w.rows("organizations") if o["id"] == org_id)


def archive(w: Any, org_id: str) -> None:
    """What `archive_workspace` writes: hidden now, purged in 30 days."""
    row = org(w, org_id)
    row["archived_at"] = w.now_iso()
    row["purge_after"] = (w.clock + timedelta(days=30)).isoformat()


def digest_rows(w: Any, status: Optional[str] = None) -> List[Dict[str, Any]]:
    return [r for r in w.rows("firm_email_queue") if r["kind"] == FR.EMAIL_KIND_DIGEST
            and (status is None or r["status"] == status)]


def digest_text(row: Dict[str, Any]) -> str:
    payload = row.get("payload") or {}
    return "\n".join([str(payload.get("subject") or ""), str(payload.get("html") or ""),
                      str(payload.get("text") or ""), json.dumps(payload.get("digest") or {})])


def readable_now(w: Any, user_id: str, firm_id: Optional[str]) -> List[str]:
    """The workspaces `user_id` reads TODAY through `firm_id` (or, with no
    firm, through their own memberships) — computed from the world's rows,
    independently of the code under test."""
    live = dict((o["id"], o) for o in w.rows("organizations") if o.get("archived_at") is None)
    if firm_id:
        firm = next((f for f in w.rows("firms") if f["id"] == firm_id), None)
        member = [m for m in w.rows("firm_memberships")
                  if m["firm_id"] == firm_id and m["user_id"] == user_id]
        if firm is None or firm.get("archived_at") is not None or not member:
            return []
        return sorted(i for i, o in live.items() if o.get("firm_id") == firm_id)
    return sorted(m["org_id"] for m in w.rows("memberships")
                  if m["user_id"] == user_id and m["org_id"] in live)


def audit_sent_digests(w: Any, outbox: Outbox) -> int:
    """LAW 1, on every digest the drain marked sent: the recipient is the
    row's user, at that user's address, and neither the body nor the
    payload names a workspace that user does not read today. Returns the
    number audited (a caller asserts it is not zero)."""
    names = dict((o["id"], o["name"]) for o in w.rows("organizations"))
    audited = 0
    for row in digest_rows(w, "sent"):
        user_id, firm_id = str(row["user_id"]), row.get("firm_id")
        assert row["to_email"] == w.auth_users[user_id], (
            "DIGEST RECIPIENT — queued for user %s but addressed to %s" % (user_id, row["to_email"]))
        allowed = set(readable_now(w, user_id, firm_id))
        text = digest_text(row)
        foreign = sorted(name for oid, name in names.items() if oid not in allowed and name in text)
        assert not foreign, (
            "CROSS-TENANT DIGEST — the digest sent to %s (firm %s) names workspace(s) the "
            "recipient does not read today: %s" % (row["to_email"], firm_id, foreign))
        sections = ((row.get("payload") or {}).get("digest") or {}).get("sections") or []
        outside = sorted(str(s.get("client_org_id")) for s in sections
                         if str(s.get("client_org_id")) not in allowed)
        assert not outside, (
            "CROSS-TENANT DIGEST — payload sections for workspace(s) outside the recipient's "
            "scope: %s (to %s)" % (outside, row["to_email"]))
        assert outbox.to(row["to_email"]), "a row marked sent that the provider never saw"
        audited += 1
    return audited


# ── renewal seeds ────────────────────────────────────────────────────────


def renewal_day(days_ahead: int) -> str:
    # UTC, as the cron windows (see test_billing_stripe._seed_founder_for_renewal).
    return (datetime.now(timezone.utc).date() + timedelta(days=days_ahead)).isoformat()


def founder(w: Any, sub_id: str, org_id: str, user_id: Optional[str], days_ahead: int = 14,
             **over: Any) -> Dict[str, Any]:
    row = {"id": sub_id, "org_id": org_id, "user_id": user_id, "is_founder": True,
           "status": "active", "cancel_at_period_end": False,
           "current_period_end": renewal_day(days_ahead) + "T12:00:00+00:00"}
    row.update(over)
    return w.add("subscriptions", row)


def team(w: Any) -> None:
    """The payer's workspace as the Cockpit makes it: the owner who pays,
    the firm's responsible accountant written in as 'admin' (what
    `import_firm_client` does — schema_phase_firm.sql), and a teammate."""
    w.add("memberships", {"user_id": T.A_ACCOUNTANT, "org_id": T.ORG_S, "role": "admin"})
    w.add("memberships", {"user_id": TEAMMATE, "org_id": T.ORG_S, "role": "member"})
