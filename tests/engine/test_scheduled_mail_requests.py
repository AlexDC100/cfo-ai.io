"""GATE scheduled-mail-tenancy — THE NUDGE CRON AND THE REQUEST MAILS (law 4).

A reminder goes to the open request's contact, once, in the name of the firm
of record — and not at all once the firm no longer serves the client, the
client is archived, or the request was revoked after the row was queued.

The statement of the gate, what it reds on and what it cannot see are in
tests/engine/scheduled_mail_world.py; the plant log is docs/engine_book/
gates.md "scheduled-mail-tenancy".

Python 3.9 — no `match`, no `X | Y` unions.
"""

from __future__ import annotations

from typing import Any, Dict, Optional

import firm_postgrest_double as D  # noqa: F401
import test_firm_tenancy as T
from engine.api import _firm_requests as FR  # noqa: F401
from scheduled_mail_world import app, client, outbox, world  # noqa: F401 — fixtures
from scheduled_mail_world import (
    archive, drain_firm, hdr, org, run_nudge,
)


# ══════════════════════════════════════════════════════════════════════════
# 3. THE NUDGE CRON AND THE REQUEST MAILS
# ══════════════════════════════════════════════════════════════════════════


def _due_request(w: Any, firm_id: Optional[str], client_org_id: str, to_email: str) -> Dict[str, Any]:
    """An open request for 2026-08-31 on a monthly client: the pack's 7-day
    nudge is due on 2026-09-18 (deadline 25 days after the period end)."""
    row = w.add("firm_file_requests", {
        "firm_id": firm_id, "client_org_id": client_org_id, "period_end": "2026-08-31",
        "requested_by": T.A_ACCOUNTANT, "requested_at": "2026-09-05T10:00:00+00:00",
        "expires_at": "2026-10-05T10:00:00+00:00", "token_hash": FR.token_hash("due.sig-" + to_email),
        "to_email": to_email, "note": "", "status": FR.STATUS_REQUESTED, "reminder_count": 0,
        "reminders_sent": [], "refusal_count": 0})
    w.add("firm_file_request_tokens", {"request_id": row["id"], "token": "due.sig-" + to_email})
    return row


def test_a_reminder_goes_to_the_requests_contact_once(client, world, outbox):
    """Positive control for the three laws below."""
    _due_request(world, T.FIRM_A, T.ORG_A2, "contact-a2@example.test")
    first, second = run_nudge(client), run_nudge(client)
    assert first["reminders_queued"] == 1 and second["reminders_queued"] == 0, (first, second)
    drain_firm(client)
    drain_firm(client)
    mails = outbox.to("contact-a2@example.test")
    assert len(mails) == 1 and "Client A2" in mails[0]["html"], outbox.recipients()
    assert "Firm Alpha" in mails[0]["html"], "the reminder does not name the firm of record"
    assert "Client A1" not in mails[0]["html"] and "Client B1" not in mails[0]["html"]


def test_two_interleaved_nudge_runs_queue_one_reminder(client, world, outbox):
    """The nudge is recorded on the request BEFORE the reminder is queued:
    a run that starts while the first is queueing finds it already taken."""
    _due_request(world, T.FIRM_A, T.ORG_A2, "contact-a2@example.test")
    nested = []
    world.before_insert["firm_email_queue"] = lambda: nested.append(run_nudge(client))
    out = run_nudge(client)
    assert nested and nested[0]["reminders_queued"] == 0 and out["reminders_queued"] == 1, (out, nested)
    drain_firm(client)
    assert len(outbox.to("contact-a2@example.test")) == 1, (
        "DOUBLE REMINDER — two overlapping nudge runs mailed the contact %d times"
        % len(outbox.to("contact-a2@example.test")))


def test_no_reminder_for_a_request_whose_firm_no_longer_serves_the_client(client, world, outbox):
    """The link is dead (`open_request_for`: 410) from the moment the firm
    stops serving the client; mailing it is a reminder to upload nowhere,
    in the name of a firm that is no longer the client's."""
    _due_request(world, T.FIRM_A, T.ORG_A2, "contact-a2@example.test")
    org(world, T.ORG_A2)["firm_id"] = T.FIRM_B
    out = run_nudge(client)
    drain_firm(client)
    assert outbox.to("contact-a2@example.test") == [] and out["reminders_queued"] == 0, (
        "REMINDER FOR ANOTHER FIRM'S CLIENT — Client A2 is now Firm Beta's; Firm Alpha's "
        "request still mailed its contact (%s)" % out)


def test_no_reminder_for_an_archived_client(client, world, outbox):
    _due_request(world, T.FIRM_A, T.ORG_A2, "contact-a2@example.test")
    archive(world, T.ORG_A2)
    out = run_nudge(client)
    drain_firm(client)
    assert outbox.sent == [] and out["reminders_queued"] == 0, (out, outbox.recipients())


def test_a_request_revoked_after_queueing_is_not_mailed(client, world, outbox):
    row = _due_request(world, T.FIRM_A, T.ORG_A2, "contact-a2@example.test")
    assert run_nudge(client)["reminders_queued"] == 1
    r = client.post("/api/firm/requests/%s/revoke" % row["id"], params={"firm_id": T.FIRM_A},
                    headers=hdr(T.A_OWNER))
    assert r.status_code == 200, r.text
    drained = drain_firm(client)
    assert outbox.sent == [] and drained.get("cancelled") == 1, (drained, outbox.recipients())


def test_the_request_mail_names_the_firm_of_record_not_the_callers_text(client, world, outbox):
    """`firm_name` in the request body was printed as the sender: a member
    of Firm Alpha could mail anyone "Firm Beta asks for the trial balance"."""
    r = client.post("/api/firm/requests", headers=hdr(T.A_OWNER), json={
        "client_org_id": T.ORG_A2, "period_end": "2026-08-31", "firm_id": T.FIRM_A,
        "to_email": "contact-a2@example.test", "firm_name": "Firm Beta"})
    assert r.status_code == 201, r.text
    drain_firm(client)
    mails = outbox.to("contact-a2@example.test")
    assert len(mails) == 1, outbox.recipients()
    assert "Firm Beta" not in mails[0]["html"] and "Firm Beta" not in mails[0]["subject"], (
        "SENDER NAME FROM THE REQUEST BODY — the mail claims to come from a firm the caller "
        "is not a member of")
    assert "Firm Alpha" in mails[0]["html"] and "Firm Alpha" in mails[0]["subject"]
