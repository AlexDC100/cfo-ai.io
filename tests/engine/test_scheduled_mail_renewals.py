"""GATE scheduled-mail-tenancy — THE RENEWAL REMINDERS (laws 5, 6).

The reminder goes to the SUBSCRIBER, else the workspace's oldest owner — never
to an admin, a member or a firm accountant; never for a subscription that is
cancelling; once per (subscription, template, renewal date); and the drain
re-reads the subscription and re-resolves the recipient before it sends.

The statement of the gate, what it reds on and what it cannot see are in
tests/engine/scheduled_mail_world.py; the plant log is docs/engine_book/
gates.md "scheduled-mail-tenancy".

Python 3.9 — no `match`, no `X | Y` unions.
"""

from __future__ import annotations


import firm_postgrest_double as D  # noqa: F401
import test_firm_tenancy as T
from engine.api import _firm_requests as FR  # noqa: F401
from scheduled_mail_world import app, client, outbox, world  # noqa: F401 — fixtures
from scheduled_mail_world import (
    OPS, ORG_ORPHAN, TEAMMATE, drain_renewals, founder, hdr, renewal_day, run_renewals, team,
)


# ══════════════════════════════════════════════════════════════════════════
# 4. THE RENEWAL REMINDERS
# ══════════════════════════════════════════════════════════════════════════


def test_the_renewal_reminder_goes_to_the_subscriber_never_to_a_teammate(client, world, outbox):
    """R1. `memberships … order=role.asc limit 1` is 'admin' before 'owner'."""
    team(world)
    founder(world, T.U(901), T.ORG_S, T.SOLO)
    out = run_renewals(client)
    assert out["t14"]["queued"] == 1, out
    drain_renewals(client)
    assert outbox.recipients() == [T.EMAILS[T.SOLO]], (
        "RENEWAL REMINDER TO THE WRONG PERSON — the subscriber is %s; the mail went to %s "
        "(a.accountant is the firm's accountant, written into the client workspace as 'admin')"
        % (T.EMAILS[T.SOLO], outbox.recipients()))


def test_a_legacy_workspace_keyed_subscription_goes_to_the_oldest_owner(client, world, outbox):
    """Founder rows written before per-user billing carry `org_id` and no
    `user_id`. The payer is the workspace's owner — the oldest one."""
    team(world)
    world.add("memberships", {"user_id": T.NOBODY, "org_id": T.ORG_S, "role": "owner"})  # a later owner
    founder(world, T.U(902), T.ORG_S, None)
    run_renewals(client)
    drain_renewals(client)
    assert outbox.recipients() == [T.EMAILS[T.SOLO]], outbox.recipients()


def test_a_workspace_with_no_owner_row_mails_nobody(client, world, outbox):
    world.add("organizations", {"id": ORG_ORPHAN, "name": "No Owner Workspace",
                                "default_currency": "RON"})
    world.add("memberships", {"user_id": T.A_ACCOUNTANT, "org_id": ORG_ORPHAN, "role": "admin"})
    founder(world, T.U(903), ORG_ORPHAN, None)
    out = run_renewals(client)
    drain_renewals(client)
    assert outbox.sent == [] and out["t14"]["queued"] == 0, (
        "RENEWAL REMINDER TO A NON-OWNER — nobody owns the workspace and %s was mailed (%s)"
        % (outbox.recipients(), out))
    assert world.rows("renewal_email_queue") == [], "an address-less row was queued"


def test_running_the_renewal_cron_twice_queues_one_reminder(client, world, outbox):
    """R2. A retry, a manual re-run, a second scheduler — with NO dedupe
    index in the database (production today): the engine reads the queue
    before it writes."""
    assert "renewal_email_queue" in world.indexes_absent
    founder(world, T.U(904), T.ORG_S, T.SOLO)
    first, second = run_renewals(client), run_renewals(client)
    assert first["t14"]["queued"] == 1 and second["t14"]["queued"] == 0, (first, second)
    assert len(world.rows("renewal_email_queue")) == 1, (
        "DOUBLE RENEWAL REMINDER — two runs queued %d rows for one subscription and one "
        "renewal date" % len(world.rows("renewal_email_queue")))
    drain_renewals(client)
    drain_renewals(client)
    assert outbox.recipients() == [T.EMAILS[T.SOLO]], outbox.recipients()


def test_two_interleaved_renewal_runs_queue_one_reminder(client, world, outbox):
    """The scheduler retried while the first run was still running: the
    second run starts at the instant the first is about to queue, reads an
    empty queue and writes its row. The first run's row then meets the
    dedupe index (supabase/schema_phase_email_idempotency.sql) — and that
    refusal is counted as "already queued", never as a failure and never as
    a second reminder. WITHOUT that index in the database this interleaving
    queues two rows; the read-before-write alone closes only the re-run."""
    world.indexes_absent.discard("renewal_email_queue")   # the migration is applied
    founder(world, T.U(912), T.ORG_S, T.SOLO)
    nested = []
    world.before_insert["renewal_email_queue"] = lambda: nested.append(run_renewals(client))
    out = run_renewals(client)
    assert nested and nested[0]["t14"]["queued"] == 1, nested
    assert out["t14"]["queued"] == 0 and out["t14"]["already_queued"] == 1, out
    assert len(world.rows("renewal_email_queue")) == 1
    drain_renewals(client)
    assert outbox.recipients() == [T.EMAILS[T.SOLO]], outbox.recipients()


def test_the_t14_and_the_t3_reminders_are_two_different_mails(client, world, outbox):
    """The dedupe key is (subscription, template, renewal date): the T-3
    reminder is not swallowed by the T-14 one."""
    founder(world, T.U(905), T.ORG_S, T.SOLO, days_ahead=14)
    run_renewals(client)
    sub = world.rows("subscriptions")[0]
    for q in world.rows("renewal_email_queue"):   # eleven days later, same renewal date
        q["payload"]["vars"]["renewal_date"] = renewal_day(3)
    sub["current_period_end"] = renewal_day(3) + "T12:00:00+00:00"
    out = run_renewals(client)
    assert out["t3"]["queued"] == 1, out
    assert sorted(q["template"] for q in world.rows("renewal_email_queue")) == [
        "renewal_reminder_t14", "renewal_reminder_t3"]


def test_a_cancelling_subscription_is_not_told_it_renews(client, world, outbox):
    """`cancel_at_period_end`: the status stays 'active' until the period
    ends, and the mail says "we'll charge the card on file"."""
    founder(world, T.U(906), T.ORG_S, T.SOLO, cancel_at_period_end=True)
    out = run_renewals(client)
    drain_renewals(client)
    assert outbox.sent == [] and out["t14"]["queued"] == 0, (out, outbox.recipients())


def test_a_subscription_cancelled_after_queueing_is_not_mailed(client, world, outbox):
    founder(world, T.U(907), T.ORG_S, T.SOLO)
    assert run_renewals(client)["t14"]["queued"] == 1
    world.rows("subscriptions")[0]["cancel_at_period_end"] = True
    drained = drain_renewals(client)
    assert outbox.sent == [] and drained.get("cancelled") == 1, (drained, outbox.recipients())


def test_a_row_queued_for_the_wrong_person_is_corrected_at_the_drain(client, world, outbox):
    """Rows the OLD cron queued carry the first membership's address. The
    drain resolves the recipient again and never trusts the stored one."""
    team(world)
    founder(world, T.U(908), T.ORG_S, T.SOLO)
    world.add("renewal_email_queue", {
        "subscription_id": T.U(908), "send_at": world.now_iso(), "template": "renewal_reminder_t14",
        "status": "queued",
        "payload": {"to": T.EMAILS[T.A_ACCOUNTANT], "template": "renewal_reminder_t14",
                    "subject": "Your CFO AI subscription renews in 14 days at €99",
                    "vars": {"renewal_date": renewal_day(14), "renewal_price": "€99",
                             "manage_url": "/settings/billing"}}})
    drain_renewals(client)
    assert outbox.to(T.EMAILS[T.A_ACCOUNTANT]) == [], (
        "STORED RECIPIENT TRUSTED — a row queued for the accountant was delivered to them")
    assert outbox.recipients() == [T.EMAILS[T.SOLO]], outbox.recipients()


def test_an_addressless_row_does_not_block_the_queue(client, world, outbox):
    """`_user_email(...) or ""` queued rows the drain skipped forever; 200
    of them at the head of the queue stopped every later reminder."""
    for n in range(3):
        world.add("renewal_email_queue", {
            "subscription_id": T.U(950 + n), "send_at": "2026-01-01T00:00:00+00:00",
            "template": "renewal_reminder_t14", "status": "queued",
            "payload": {"to": "", "subject": "s", "vars": {"renewal_date": renewal_day(14)}}})
    founder(world, T.U(909), T.ORG_S, T.SOLO)
    run_renewals(client)
    r = client.post("/api/newsletter/drain-renewals", params={"limit": 3}, headers=hdr(OPS))
    assert r.status_code == 200, r.text
    drain_renewals(client)
    assert outbox.recipients() == [T.EMAILS[T.SOLO]], (
        "QUEUE BLOCKED — address-less rows stayed queued at the head and the real reminder "
        "was never reached: %s" % [q["status"] for q in world.rows("renewal_email_queue")])
    assert not [q for q in world.rows("renewal_email_queue") if q["status"] == "queued"]


def test_a_renewal_drain_whose_mark_sent_write_fails_does_not_send_again(client, world, outbox):
    founder(world, T.U(910), T.ORG_S, T.SOLO)
    run_renewals(client)
    world.update_faults.append(
        lambda table, patch: table == "renewal_email_queue" and patch.get("status") == "sent")
    r = client.post("/api/newsletter/drain-renewals", headers=hdr(OPS))
    assert r.status_code in (200, 500), r.text
    drain_renewals(client)
    assert outbox.recipients() == [T.EMAILS[T.SOLO]], (
        "DOUBLE SEND — the renewal reminder was delivered %d times" % len(outbox.sent))
