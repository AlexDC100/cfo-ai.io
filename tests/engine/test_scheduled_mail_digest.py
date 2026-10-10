"""GATE scheduled-mail-tenancy — THE FIRM DIGEST (laws 1, 2, 3, 6).

A digest names only workspaces its recipient reads TODAY; a request another
firm minted never reaches this firm's digest; a removed member, an archived
firm, an opted-out user and a left workspace are not mailed — decided again
at send time; one digest per (user, firm, day), whatever overlaps or fails.

The statement of the gate, what it reds on and what it cannot see are in
tests/engine/scheduled_mail_world.py; the plant log is docs/engine_book/
gates.md "scheduled-mail-tenancy".

Python 3.9 — no `match`, no `X | Y` unions.
"""

from __future__ import annotations

import copy
from datetime import date, timedelta
from typing import Any, Dict, List

import firm_postgrest_double as D  # noqa: F401
import test_firm_tenancy as T
from engine.api import _firm_requests as FR  # noqa: F401
from engine.api import _supabase
from scheduled_mail_world import app, client, outbox, world  # noqa: F401 — fixtures
from scheduled_mail_world import (
    DAY, FOREIGN_PERIOD, NOW, OPS, ORG_SOLO2, archive, audit_sent_digests, digest_rows, digest_text, drain_firm, enable_digest, hdr, org, run_digest,
)


# ══════════════════════════════════════════════════════════════════════════
# 1. THE FIRM DIGEST — who is mailed, and what the body names
# ══════════════════════════════════════════════════════════════════════════


def test_each_member_is_mailed_their_own_firms_live_clients_and_nothing_else(client, world, outbox):
    """The positive control: the laws below would hold of a cron that mails
    nobody. Both firms' owners opted in; each is mailed once, about their
    own firm's clients."""
    enable_digest(world, T.A_OWNER, T.FIRM_A)
    enable_digest(world, T.B_OWNER, T.FIRM_B)
    out = run_digest(client)
    assert out["queued"] == 2, out
    drained = drain_firm(client)
    assert drained["drained"] == 2 and drained["failed"] == 0, drained
    assert outbox.recipients() == sorted([T.EMAILS[T.A_OWNER], T.EMAILS[T.B_OWNER]])
    a_body = outbox.to(T.EMAILS[T.A_OWNER])[0]["html"]
    b_body = outbox.to(T.EMAILS[T.B_OWNER])[0]["html"]
    assert "Client A1" in a_body and "Client A2" in a_body, "firm A's digest lost its own clients"
    assert "Client B1" in b_body, "firm B's digest lost its own client"
    assert "Client B1" not in a_body and "Client A1" not in b_body and "Client A2" not in b_body
    assert audit_sent_digests(world, outbox) == 2


def test_a_request_another_firm_minted_never_reaches_this_firms_digest(client, world, outbox):
    """F1. Client B1 was firm A's before it was firm B's; A's request for it
    is still open. `firm_file_requests firm read` (RLS) shows a firm only
    the requests IT minted; the cron reads under the service role, so the
    code's own filter is the wall."""
    foreign = world.add("firm_file_requests", {
        "firm_id": T.FIRM_A, "client_org_id": T.ORG_B1, "period_end": FOREIGN_PERIOD,
        "requested_by": T.A_ACCOUNTANT, "requested_at": world.now_iso(),
        "expires_at": (world.clock + timedelta(days=60)).isoformat(),
        "token_hash": FR.token_hash("foreign-era.sig"), "to_email": "old-contact@example.test",
        "note": "firm A's note on a client it no longer serves",
        "status": FR.STATUS_REQUESTED, "reminder_count": 3, "reminders_sent": [],
        "refusal_count": 0})
    assert foreign["firm_id"] == T.FIRM_A and org(world, T.ORG_B1)["firm_id"] == T.FIRM_B
    enable_digest(world, T.B_OWNER, T.FIRM_B)
    run_digest(client)
    drain_firm(client)
    rows = digest_rows(world, "sent")
    assert len(rows) == 1 and rows[0]["to_email"] == T.EMAILS[T.B_OWNER], rows
    text = digest_text(rows[0])
    assert FOREIGN_PERIOD not in text and str(foreign["id"]) not in text, (
        "CROSS-FIRM REQUEST IN A DIGEST — firm B's digest carries the request firm A minted "
        "for %s (period %s, id %s)" % (T.ORG_B1, FOREIGN_PERIOD, foreign["id"]))
    # …and firm B's OWN open request is still there: a fix that dropped
    # every request item would pass the line above.
    assert str(T.REQUEST_B1) in text, "firm B's own request left its digest"
    assert audit_sent_digests(world, outbox) == 1


def test_a_provider_that_answers_with_another_firms_client_is_refused(world, outbox):
    """Either wall alone. The board computation is handed the scope; if it
    answers with a workspace outside it (a provider bug, a cache keyed too
    loosely), the digest is REFUSED — not trimmed, not sent."""
    enable_digest(world, T.A_OWNER, T.FIRM_A)
    real = FR.default_report_provider()

    def widened(ids, as_of):
        return real(list(ids) + [T.ORG_B1], as_of)

    with _supabase.admin() as ac:
        out = FR.run_digest_cron(date.fromisoformat(DAY), NOW, ac, report_provider=widened,
                                 email_of=world.auth_users.get)
    assert digest_rows(world) == [] and out["queued"] == 0 and out["gaps"] == 1, (
        "DIGEST WIDENED BY ITS PROVIDER — firm A's digest was queued naming Client B1: %s" % out)
    assert "outside the recipient's scope" in " ".join(out["notes"]), out


def test_an_archived_client_is_in_no_digest(client, world, outbox):
    """F2. Client A2's owner deleted the workspace: hidden now, purged in
    30 days. The board leaves archived clients out (critic D10); the mail
    must too — for the whole purge window."""
    archive(world, T.ORG_A2)
    enable_digest(world, T.A_OWNER, T.FIRM_A)
    run_digest(client)
    drain_firm(client)
    bodies = outbox.to(T.EMAILS[T.A_OWNER])
    assert len(bodies) == 1 and "Client A1" in bodies[0]["html"], "the live client left the digest"
    assert "Client A2" not in bodies[0]["html"], (
        "ARCHIVED CLIENT IN A DIGEST — Client A2 was archived (purge window) and is still mailed")
    assert audit_sent_digests(world, outbox) == 1


def test_a_client_archived_after_the_cron_ran_is_not_sent(client, world, outbox):
    """The same wall at SEND time: the digest was queued while A2 was live."""
    enable_digest(world, T.A_OWNER, T.FIRM_A)
    assert run_digest(client)["queued"] == 1
    archive(world, T.ORG_A2)
    drained = drain_firm(client)
    assert outbox.sent == [], (
        "STALE DIGEST SENT — queued before Client A2 was archived, delivered after: %s"
        % outbox.recipients())
    assert drained["drained"] == 0 and drained.get("cancelled") == 1, drained


def test_a_member_removed_before_the_cron_is_not_queued(client, world, outbox):
    enable_digest(world, T.A_VIEWER, T.FIRM_A)
    r = client.delete("/api/firm/%s/members/%s" % (T.FIRM_A, T.A_VIEWER), headers=hdr(T.A_OWNER))
    assert r.status_code == 200, r.text
    out = run_digest(client)
    drain_firm(client)
    assert outbox.to(T.EMAILS[T.A_VIEWER]) == [] and out["queued"] == 0, (out, outbox.recipients())


def test_a_member_removed_between_the_cron_and_the_drain_is_not_mailed(client, world, outbox):
    """F6. The drain is an operator action — hours or days after the cron.
    Entitlement is decided again when the mail is about to leave."""
    enable_digest(world, T.A_VIEWER, T.FIRM_A)
    enable_digest(world, T.A_OWNER, T.FIRM_A)
    assert run_digest(client)["queued"] == 2
    r = client.delete("/api/firm/%s/members/%s" % (T.FIRM_A, T.A_VIEWER), headers=hdr(T.A_OWNER))
    assert r.status_code == 200, r.text
    drained = drain_firm(client)
    assert outbox.to(T.EMAILS[T.A_VIEWER]) == [], (
        "REMOVED MEMBER MAILED — a.viewer left Firm Alpha after the cron and still received "
        "its client list")
    assert outbox.recipients() == [T.EMAILS[T.A_OWNER]], "the remaining member lost their digest"
    assert drained["drained"] == 1 and drained.get("cancelled") == 1, drained
    viewer_row = next(r for r in digest_rows(world) if r["user_id"] == T.A_VIEWER)
    assert viewer_row["status"] == "failed" and "cancelled" in str(viewer_row["error"]), viewer_row
    assert audit_sent_digests(world, outbox) == 1


def test_a_user_who_opted_out_after_the_cron_is_not_mailed(client, world, outbox):
    enable_digest(world, T.A_OWNER, T.FIRM_A)
    assert run_digest(client)["queued"] == 1
    r = client.put("/api/firm/digest/prefs", headers=hdr(T.A_OWNER),
                   json={"firm_id": T.FIRM_A, "enabled": False})
    assert r.status_code == 200, r.text
    drained = drain_firm(client)
    assert outbox.sent == [] and drained.get("cancelled") == 1, (drained, outbox.recipients())


def test_an_archived_firm_mails_nobody(client, world, outbox):
    next(f for f in world.rows("firms") if f["id"] == T.FIRM_B)["archived_at"] = world.now_iso()
    enable_digest(world, T.B_OWNER, T.FIRM_B)
    enable_digest(world, T.A_OWNER, T.FIRM_A)
    out = run_digest(client)
    drain_firm(client)
    assert outbox.recipients() == [T.EMAILS[T.A_OWNER]], (
        "ARCHIVED FIRM MAILED — Firm Beta is archived; its digest still went out: %s (%s)"
        % (outbox.recipients(), out))


def test_a_personal_digest_names_only_the_users_own_live_workspaces(client, world, outbox):
    """The no-firm digest: the recipient's own memberships, unarchived, and
    decided again at send time (a workspace left in between is not mailed)."""
    world.add("organizations", {"id": ORG_SOLO2, "name": "Solo Second Workspace",
                                "default_currency": "RON"})
    world.add("memberships", {"user_id": T.SOLO, "org_id": ORG_SOLO2, "role": "owner"})
    world.add("financial_periods", {"id": T.U(305), "org_id": ORG_SOLO2,
                                    "period_start": "2025-01-01", "period_end": "2025-12-31",
                                    "currency": "RON"})
    archive(world, ORG_SOLO2)
    enable_digest(world, T.SOLO, None)
    assert run_digest(client)["queued"] == 1
    drain_firm(client)
    bodies = outbox.to(T.EMAILS[T.SOLO])
    assert len(bodies) == 1 and "Solo Workspace" in bodies[0]["html"]
    assert "Solo Second Workspace" not in bodies[0]["html"]
    assert "Client A1" not in bodies[0]["html"] and "Client B1" not in bodies[0]["html"]
    assert audit_sent_digests(world, outbox) == 1

    # left between the cron and the drain: a fresh day, queued, then gone
    world.tables["memberships"] = [m for m in world.rows("memberships")
                                   if not (m["user_id"] == T.SOLO and m["org_id"] == T.ORG_S)]
    world.add("firm_email_queue", dict(
        copy.deepcopy(digest_rows(world, "sent")[0]), id=None, status="queued", sent_at=None,
        error=None))
    before = len(outbox.sent)
    drained = drain_firm(client)
    assert len(outbox.sent) == before and drained.get("cancelled") == 1, (drained, outbox.recipients())


# ══════════════════════════════════════════════════════════════════════════
# 2. THE FIRM DIGEST — one mail per recipient per day
# ══════════════════════════════════════════════════════════════════════════


def test_two_runs_and_two_drains_send_one_digest(client, world, outbox):
    enable_digest(world, T.A_OWNER, T.FIRM_A)
    first, second = run_digest(client), run_digest(client)
    assert first["queued"] == 1 and second["queued"] == 0, (first, second)
    drain_firm(client)
    drain_firm(client)
    assert outbox.recipients() == [T.EMAILS[T.A_OWNER]], outbox.recipients()
    assert len(digest_rows(world)) == 1 and len(world.rows("firm_digest_log")) == 1


def test_two_interleaved_runs_queue_one_digest(client, world, outbox):
    """The scheduler retried a slow run while it was still running: the
    second run starts at the instant the first is about to queue. The day
    must already be CLAIMED in `firm_digest_log` (its unique index) by then."""
    enable_digest(world, T.A_OWNER, T.FIRM_A)
    nested = []  # type: List[Dict[str, Any]]
    world.before_insert["firm_email_queue"] = lambda: nested.append(run_digest(client))
    out = run_digest(client)
    assert nested, "the interleaving never fired — the first run queued nothing"
    assert len(digest_rows(world)) == 1, (
        "DOUBLE DIGEST — two overlapping cron runs queued %d digests for one user and day "
        "(first %s, second %s)" % (len(digest_rows(world)), out, nested[0]))
    drain_firm(client)
    assert outbox.recipients() == [T.EMAILS[T.A_OWNER]]


def test_an_unreadable_digest_log_queues_nothing(client, world, outbox):
    """The idempotency record cannot be read: the cron does not guess that
    nothing was sent."""
    enable_digest(world, T.A_OWNER, T.FIRM_A)
    world.select_faults["firm_digest_log"] = "transient"
    out = run_digest(client)
    assert digest_rows(world) == [] and out["queued"] == 0 and out["gaps"] >= 1, (
        "FAIL-OPEN IDEMPOTENCY — the digest log could not be read and a digest was queued: %s" % out)


def test_a_digest_that_could_not_be_queued_is_not_recorded_as_sent(client, world, outbox):
    """The queue write fails: the day is released and the items stay NEW,
    so the next run carries them — never a digest "sent" that nobody got."""
    enable_digest(world, T.A_OWNER, T.FIRM_A)

    def _queue_down():  # type: () -> None
        raise RuntimeError("HTTP 503: planted queue failure")

    world.before_insert["firm_email_queue"] = _queue_down
    out = run_digest(client)
    pref = next(p for p in world.rows("firm_digest_prefs") if p["user_id"] == T.A_OWNER)
    assert out["queued"] == 0 and world.rows("firm_digest_log") == [], (out, world.rows("firm_digest_log"))
    assert pref.get("last_sent_at") is None and not pref.get("last_item_ids"), pref
    again = run_digest(client)
    assert again["queued"] == 1, again


def test_a_drain_whose_mark_sent_write_fails_does_not_send_again(client, world, outbox):
    """The row is CLAIMED before the provider is called. A crash or a failed
    write after the send leaves a row that is never sent again."""
    enable_digest(world, T.A_OWNER, T.FIRM_A)
    run_digest(client)
    world.update_faults.append(
        lambda table, patch: table == "firm_email_queue" and patch.get("status") == "sent")
    r = client.post("/api/firm/email/drain", headers=hdr(OPS))
    assert r.status_code in (200, 500), r.text
    drain_firm(client)
    drain_firm(client)
    assert outbox.recipients() == [T.EMAILS[T.A_OWNER]], (
        "DOUBLE SEND — the mark-sent write failed once and the digest was delivered %d times"
        % len(outbox.sent))
