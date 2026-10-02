# Ticket 2026-10-02 — the firm digest cron and the renewal-reminder recipient are audited before the Firm Cockpit flag flips

**Status: TICKETED by owner ruling 2026-10-02** ("firm digest cron and renewal
recipient audited before the Firm Cockpit flag flips"). Not started.
**Precondition:** `FIRM_COCKPIT_ENABLED` is not set in production, and neither
cron is scheduled, until both items below are closed with a green gate.

Found by the tenancy sweep of 2026-10-02
(`specs-durable/hotfix_overrides_tenancy/sweep_2026-10-02.json`; code read at
`e043845c`, reproduced in memory with the repo's own doubles, nothing written —
locate by symbol, line numbers have drifted).

## 1. Firm digest cron — another firm's requests and cadence in the digest

`POST /api/firm/digest/cron/run` → `_firm_requests.run_digest_cron`, under the
service role:

- the request read is `select_all(client, "firm_file_requests",
  filters={"client_org_id": "in.(…)"})` — **no firm in the filter**;
- ONE report provider is built with no firm and reused for every preference,
  so `_cadence_row(ac, org_id, firm_id=None)` never applies its firm pin.

A client that moved from firm P to firm Q keeps P's open file request (14-day
life) and P's cadence row (`detach_workspace_from_firm` clears neither). Q's
accountant's digest then lists P's request (period requested, days since,
reminder count, due date) and computes the board's deadlines from P's cadence.
Reproduced. Not leaked: note, to_email, requested_by.

The interactive routes already pin both reads (`list_requests`,
`/api/firm/brief`, `get_cadence`); the cron has neither wall.

**Fix (about ten lines, no schema change):** the firm in the request filter
when the preference has one (as `/api/firm/brief` builds it — NOT `is.null`
for a firm-less preference: a workspace member may read every request on their
own workspace); the provider built per preference with its firm. Test beside
`tests/engine/test_firm_requests_flow.py`: a previous firm's open request and
cadence row never reach the current firm's digest.

**Why it is not live:** every `/api/firm` route is unmounted while the flag is
unset; no scheduler calls the cron.

## 2. Founder renewal reminder — the recipient is not the payer

`POST /api/billing/cron/renewal-reminders` →
`_billing.send_founder_renewal_reminders`: for each founder subscription it
reads `memberships` by `org_id` only, `limit=1`, `order="role.asc"`. Roles are
`owner` / `admin` / `member`; ascending text puts `admin` first. Reproduced on
a stand-in: the reminder (renewal date, price, manage-billing link) was queued
to an admin, not to the payer.

**What to audit before anything is scheduled:**
- the recipient is the PAYER (the subscription's own user), never "the first
  member by role";
- the `subscriptions` drift recorded in CLAUDE.md §16: this code filters on
  `org_id`, `is_founder`, `plan_key` — columns no migration in the repository
  defines. Establish what production's table actually has, then either add the
  migration or delete the org-keyed path;
- both crons stay fail-closed on `ENGINE_API_TOKEN` (gate `cron-auth`).

**Why it is not live:** operator bearer only; no scheduler configured; the
queue is drained by a second, admin-only call.

## 3. Gate
One suite, real store, plant-proven: (a) a digest for firm Q carries no row of
firm P; (b) the renewal reminder is addressed to the subscription's user with
an admin and an owner both present.
