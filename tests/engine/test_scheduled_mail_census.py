"""GATE scheduled-mail-tenancy — WHO MAY DRAIN, AND THE CENSUS (laws 7, 8).

The two drains refuse a missing bearer, a signed non-operator, the scheduler
token and a forged operator, and send nothing. Every function of
src/engine/api that queues or sends mail is classified with its recipient
rule and the gate that holds it; a new sender is red until it is.

The statement of the gate, what it reds on and what it cannot see are in
tests/engine/scheduled_mail_world.py; the plant log is docs/engine_book/
gates.md "scheduled-mail-tenancy".

Python 3.9 — no `match`, no `X | Y` unions.
"""

from __future__ import annotations

import ast
import re
from pathlib import Path
from typing import Dict, List, Tuple

import pytest

import firm_postgrest_double as D  # noqa: F401
import test_firm_tenancy as T
from engine.api import _firm_requests as FR  # noqa: F401
from scheduled_mail_world import app, client, outbox, world  # noqa: F401 — fixtures
from scheduled_mail_world import (
    API_DIR, OPS, OPS_EMAIL, SCHED, enable_digest, founder, hdr, run_digest, run_renewals,
)


# ══════════════════════════════════════════════════════════════════════════
# 5. AUTH — the drains (the crons are tests/engine/test_cron_auth.py)
# ══════════════════════════════════════════════════════════════════════════

DRAINS = ("/api/firm/email/drain", "/api/newsletter/drain-renewals")


@pytest.mark.parametrize("path", DRAINS)
def test_a_drain_refuses_everyone_but_the_operator_and_sends_nothing(client, world, outbox, monkeypatch, path):
    enable_digest(world, T.A_OWNER, T.FIRM_A)
    run_digest(client)
    founder(world, T.U(911), T.ORG_S, T.SOLO)
    run_renewals(client)
    assert client.post(path).status_code == 401
    assert client.post(path, headers=hdr(T.A_OWNER)).status_code == 403, "a firm owner is not the operator"
    assert client.post(path, headers=SCHED).status_code in (401, 403), "the scheduler token is not a user"
    forged = {"Authorization": "Bearer %s" % D.forged_jwt(OPS, OPS_EMAIL)}
    assert client.post(path, headers=forged).status_code == 401, "an unsigned bearer naming the operator"
    monkeypatch.delenv("PRICING_ADMIN_USER_IDS")
    assert client.post(path, headers=hdr(OPS)).status_code == 403, "no allowlist: nobody is the operator"
    assert outbox.sent == [], "a refused drain sent mail: %s" % outbox.recipients()


# ══════════════════════════════════════════════════════════════════════════
# 6. THE CENSUS — every function that queues or sends mail
# ══════════════════════════════════════════════════════════════════════════

#: (module, function) -> the recipient rule and the gate that holds it. A
#: function of `src/engine/api` that calls the provider or writes a mail
#: queue and is not here is RED until it is classified.
MAIL_SENDERS = {
    ("_firm_requests.py", "queue_email"):
        "the ONE writer of firm_email_queue; its callers are classified below",
    ("_firm_requests.py", "run_digest_cron"):
        "SCHEDULER (ENGINE_API_TOKEN). The opted-in user's own address; scope = the firm's live "
        "clients / own live workspaces — this gate, §1-2",
    ("_firm_requests.py", "run_nudge_cron"):
        "SCHEDULER (ENGINE_API_TOKEN). The open request's contact, while the firm still serves "
        "the client — this gate, §3",
    ("_firm_requests.py", "create_request"):
        "SIGNED-IN, role cell `request_file` (FC1, test_firm_tenancy). The contact the caller "
        "names; the sender name is the firm of record — this gate, §3",
    ("_firm_requests.py", "drain_email"):
        "OPERATOR (PRICING_ADMIN_USER_IDS on a verified id). Entitlement re-decided and the row "
        "claimed before each send — this gate, §1-3, §5",
    ("_firm_invites.py", "enqueue_invitation_email"):
        "SIGNED-IN, role cell `invite` (FC1). Queued to the invited address; NO route drains "
        "firm_invite_email_queue — nothing is sent (the accept link is in the response)",
    ("_billing.py", "send_founder_renewal_reminders"):
        "SCHEDULER (ENGINE_API_TOKEN). The subscriber, else the workspace's oldest owner; one "
        "row per (subscription, template, renewal date) — this gate, §4",
    ("_newsletter.py", "drain_renewals"):
        "OPERATOR. Recipient re-resolved, subscription re-read, row claimed before the send — "
        "this gate, §4-5",
    ("_newsletter.py", "subscribe"):
        "PUBLIC double opt-in: the confirmation goes to the address typed, and nothing else does",
    ("_newsletter.py", "confirm"):
        "PUBLIC link from the confirmation mail: the welcome goes to that subscriber row's address",
    ("_newsletter.py", "subscribe_me"):
        "SIGNED-IN: the caller's own verified address",
    ("_newsletter.py", "debug_send"):
        "SIGNED-IN: the caller's own verified address, no `to` field",
    ("_newsletter.py", "debug_send_all"):
        "SIGNED-IN: the caller's own verified address, no `to` field",
    ("_newsletter.py", "broadcast"):
        "OPERATOR, not scheduled: every CONFIRMED newsletter subscriber, operator-written body, "
        "no tenant data",
}

_QUEUE_TABLE_RX = re.compile(r"email_queue$")


def _mail_sites(path: Path) -> List[Tuple[str, str, int]]:
    """(enclosing function, what it does, line) for every provider call and
    every mail-queue insert in a module."""
    source = path.read_text(encoding="utf-8")
    tree = ast.parse(source)
    constants = {}  # type: Dict[str, str]
    for stmt in tree.body:
        if isinstance(stmt, ast.Assign) and isinstance(stmt.value, ast.Constant) \
                and isinstance(stmt.value.value, str):
            for target in stmt.targets:
                if isinstance(target, ast.Name):
                    constants[target.id] = stmt.value.value
    out = []  # type: List[Tuple[str, str, int]]

    def visit(node: ast.AST, fn: str) -> None:
        for child in ast.iter_child_nodes(node):
            name = fn
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                name = child.name
            if isinstance(child, ast.Call):
                func = child.func
                attr = func.attr if isinstance(func, ast.Attribute) else (
                    func.id if isinstance(func, ast.Name) else "")
                if attr in ("send_email", "send_batch", "queue_email"):
                    out.append((fn, attr, child.lineno))
                elif attr in ("insert", "upsert") and child.args:
                    first = child.args[0]
                    table = first.value if isinstance(first, ast.Constant) else (
                        constants.get(first.id, "") if isinstance(first, ast.Name) else "")
                    if isinstance(table, str) and _QUEUE_TABLE_RX.search(table):
                        out.append((fn, "insert:%s" % table, child.lineno))
            visit(child, name)

    visit(tree, "<module>")
    return out


def test_every_function_that_queues_or_sends_mail_is_classified():
    found = set()  # type: set
    for path in sorted(API_DIR.glob("*.py")):
        if path.name == "_email.py":
            continue   # the provider client itself
        for fn, _what, _line in _mail_sites(path):
            found.add((path.name, fn))
    assert len(found) >= 10, "the mail census found %d senders — discovery broken: %s" % (
        len(found), sorted(found))
    unclassified = found - set(MAIL_SENDERS)
    assert not unclassified, (
        "MAIL CENSUS — function(s) that queue or send mail with no declared recipient rule "
        "(classify each in MAIL_SENDERS with the gate that holds it): %s" % sorted(unclassified))
    stale = set(MAIL_SENDERS) - found
    assert not stale, "declared mail sender(s) the code no longer has: %s" % sorted(stale)


def test_the_mail_census_is_not_vacuous(tmp_path):
    src = ("T = 'x_email_queue'\n"
           "def a(c):\n    _email.send_email(to='t', subject='s', html='h')\n"
           "def b(c):\n    c.insert(T, {})\n"
           "def d(c):\n    c.insert('documents', {})\n"
           "def e(c):\n    queue_email(c, kind='k')\n")
    path = tmp_path / "planted.py"
    path.write_text(src, encoding="utf-8")
    assert [(fn, what) for fn, what, _l in _mail_sites(path)] == [
        ("a", "send_email"), ("b", "insert:x_email_queue"), ("e", "queue_email")]
