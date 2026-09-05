-- ───────────────────────────────────────────────────────────────────────────
-- schema_phase_firm_requests.sql — FIRM COCKPIT (backend): requests,
-- cadence, digest preferences, email queue, brief cache.
--
-- OWNERSHIP (lane split, 2026-09-03; walls pass 2026-09-04). This file owns
-- the REQUEST / CADENCE / DIGEST / BRIEF tables. The tenancy lane owns
-- `firms`, firm membership and the SECURITY DEFINER helpers (`firm_can`,
-- `firm_of_org`, `can_read_client_org`) in schema_phase_firm.sql — which
-- MUST be applied before this file (the firm-read policies below call
-- those helpers by name and fail loudly if they are missing; a weaker
-- fallback would be a single wall). A client is an organization
-- (workspace == organization, CLAUDE.md §16); `client_org_id` references
-- organizations(id) directly.
--
-- RLS — TWO WALLS, NEVER ONE — ON READS AND ON WRITES. Every table
-- enables RLS. READS are granted to members of the CLIENT organization
-- (`is_member_of(client_org_id)` — the pre-firm tenancy primitive, kept),
-- AND to a firm role whose `read` cell is true, through the tenancy lane's
-- helpers, PINNED TO THE FIRM THAT CURRENTLY SERVES THE CLIENT:
--   firm_file_requests   firm_id = firm_of_org(client_org_id) and
--                        firm_can(firm_id, 'read') — a request row is
--                        visible to the firm that CURRENTLY serves the
--                        client and minted it; a row from a previous firm
--                        (workspace detached then re-attached elsewhere)
--                        is not visible to the new firm (C3).
--   firm_client_cadence  can_read_client_org(client_org_id) AND the row is
--                        the client's own (firm_id null) or the CURRENT
--                        firm's (firm_id = firm_of_org) — a cadence firm A
--                        stored, carrying A's accountant in `set_by`, does
--                        not follow the client to firm B (W3).
--   firm_briefs          firm_can(firm_id, 'read') when the brief is a
--                        firm's; the user's own row when it is not; AND
--                        every client the brief names still belongs to
--                        that firm (`firm_brief_clients_readable`) — a
--                        brief naming a client that left is unreadable to
--                        the firm it left (W5).
-- WRITES of client data go through the CALLER's own client too, under an
-- INSERT / UPDATE policy that asks the same helpers (W1):
--   firm_client_cadence  insert/update: set_by = auth.uid() and the row is
--                        pinned to the client's CURRENT firm through a role
--                        whose `request_file` cell is true (or a workspace
--                        member, firm_id null);
--   firm_file_requests   insert/update: requested_by = auth.uid() and the
--                        same firm pin + `request_file` cell (revoke is the
--                        only update the route makes);
--   firm_digest_prefs    own row, and the firm named must be one the caller
--                        is a member of;
--   firm_briefs          own row (user_id = auth.uid()), `read` cell on the
--                        firm, every client named still the firm's.
-- The backend reads AND writes these tables through the CALLER's own
-- client (`_supabase.per_user`), so a Python-wall bug still reads nothing
-- and writes nothing, and a policy bug still meets the Python wall
-- (src/engine/api/_firm_requests.py authorize_client).
-- tests/engine/test_firm_tenancy.py evaluates these policy bodies (parsed
-- out of THIS file) against an in-memory double, drives every write with
-- the Python wall removed by hand, and shows the write lands only once the
-- policy is loosened too.
--
-- SERVICE-ROLE ACCESS THAT STAYS, and why (each route is bearer- or
-- token-gated, proven in test_firm_tenancy.py):
--   · the nudge / digest crons (POST /api/firm/requests/cron/nudge,
--     /api/firm/digest/cron/run) — ENGINE_API_TOKEN, no user JWT exists;
--     they expire / remind requests and write the digest log + queue;
--   · the public token landing (GET /api/firm/requests/resolve/{token},
--     POST /api/firm/requests/{token}/upload) — the signed token IS the
--     auth; the client uploading has no account; it marks the request
--     received / refused;
--   · POST /api/firm/email/drain — PRICING_ADMIN_USER_IDS only;
--   · the secret half `firm_file_request_tokens` — NO policy, ever; the
--     backend writes it right after the CALLER's insert of the request row
--     was admitted, never before;
--   · `firm_email_queue` — NO policy; queued by the backend after an
--     admitted write, drained by the admin route.
-- No policy below touches memberships except through the SECURITY DEFINER
-- helpers (the documented 42P17 recursion trap).
--
-- COLUMN PRIVILEGES (D1, 2026-09-05). Supabase's project default —
--     alter default privileges in schema public
--       grant all on tables to anon, authenticated, service_role
-- — gives every table here TABLE-WIDE INSERT / UPDATE / DELETE for
-- `authenticated` (and `anon`); RLS chooses rows, never columns, so a
-- supabase-js PATCH may name ANY column of a row the UPDATE policy's
-- USING selects, and only the WITH CHECK stands between the caller and
-- another firm's client. Section 9 narrows that default:
--   firm_file_requests   UPDATE on (status) only — the revocation is the
--                        one update a signed-in user makes; the landing
--                        and the crons write service-role.
--   firm_digest_prefs    UPDATE on (enabled, frequency, send_hour_utc)
--                        only; the cron writes last_* service-role.
--   firm_client_cadence  UPDATE stays table-wide ON PURPOSE: the route
--                        UPSERTS the whole row as the caller and ON
--                        CONFLICT DO UPDATE sets every payload column
--                        (client_org_id, firm_id, set_by included), so a
--                        column grant would refuse the legitimate write.
--                        The WITH CHECK re-pins every tenancy column
--                        instead (set_by = auth.uid(), firm_id =
--                        firm_of_org(client_org_id), the cell).
--   firm_briefs          UPDATE stays table-wide for the same reason
--                        (the cache upsert); the WITH CHECK re-pins
--                        user_id, firm_id, client_org_ids AND — new —
--                        firm_key, the cache lookup key, which must be
--                        the firm's id or, with no firm, the author's.
--   the no-policy tables (firm_file_request_tokens, firm_email_queue,
--                        firm_digest_log) lose INSERT / UPDATE / DELETE
--                        for anon/authenticated outright: RLS already
--                        refused them; now the table privilege does too.
-- DELETE is revoked from anon/authenticated on every table here: no
-- table in this file has a delete policy.
--
-- ── OPERATOR RUNBOOK (locked discipline — CLAUDE.md §14) ─────────────────
-- 0. PRE-FLIGHT — the tenancy helpers must exist:
--      select proname from pg_proc
--       where proname in ('firm_can', 'firm_of_org', 'can_read_client_org');
--    expect THREE rows (schema_phase_firm.sql). If any is missing, apply
--    schema_phase_firm.sql first; this file refuses to create the firm
--    read policies against a helper nobody defined.
-- 1. APPLY ORDER: schema_phase3.sql → schema_phase_multi_workspace.sql →
--    schema_phase_firm.sql → THIS FILE. Run it in Supabase Studio (it
--    ends with the NOTIFY).
-- 2. IMMEDIATELY click Supabase Dashboard → Settings → API → "Reload schema
--    cache". The NOTIFY is optimistic on Supabase managed infrastructure;
--    the Dashboard click is the deterministic step.
-- 3. Verify PostgREST sees the new surface — these must NOT 400:
--      select id, status, token_hash from firm_file_requests limit 1;
--      select request_id from firm_file_request_tokens limit 1;
--      select client_org_id, cadence from firm_client_cadence limit 1;
--      select user_id, enabled from firm_digest_prefs limit 1;
--      select id, kind, status from firm_email_queue limit 1;
--      select firm_key, firm_id, brief_date, item_set_hash from firm_briefs limit 1;
--    If any stays invisible after the three reload signals, it is the
--    F3.25 Bug #4 persistent-cache case: stop, open a Supabase ticket.
-- 4. VERIFY THE SECOND WALL is in place — on reads AND writes:
--      select tablename, policyname, cmd from pg_policies
--       where tablename in ('firm_file_requests', 'firm_client_cadence',
--                           'firm_briefs', 'firm_digest_prefs')
--       order by 1, 2;
--      -- firm_briefs          firm_briefs firm read              SELECT
--      -- firm_briefs          firm_briefs firm update            UPDATE
--      -- firm_briefs          firm_briefs firm write             INSERT
--      -- firm_client_cadence  firm_client_cadence firm read      SELECT
--      -- firm_client_cadence  firm_client_cadence firm update    UPDATE
--      -- firm_client_cadence  firm_client_cadence firm write     INSERT
--      -- firm_client_cadence  firm_client_cadence member select  SELECT
--      -- firm_digest_prefs    firm_digest_prefs own insert       INSERT
--      -- firm_digest_prefs    firm_digest_prefs own select       SELECT
--      -- firm_digest_prefs    firm_digest_prefs own update       UPDATE
--      -- firm_file_requests   firm_file_requests firm read       SELECT
--      -- firm_file_requests   firm_file_requests firm update     UPDATE
--      -- firm_file_requests   firm_file_requests firm write      INSERT
--      -- firm_file_requests   firm_file_requests member select   SELECT
--    and the helper the brief policies call:
--      select proname from pg_proc where proname = 'firm_brief_clients_readable';
--    and the column grants (D1) — `authenticated` holds UPDATE on EXACTLY:
--      select table_name, column_name from information_schema.column_privileges
--       where grantee = 'authenticated' and privilege_type = 'UPDATE'
--         and table_name in ('firm_file_requests', 'firm_digest_prefs')
--       order by 1, 2;
--      -- firm_digest_prefs   enabled, frequency, send_hour_utc
--      -- firm_file_requests  status
--      -- (four rows)
--      select table_name, privilege_type from information_schema.table_privileges
--       where grantee in ('anon', 'authenticated')
--         and privilege_type in ('UPDATE', 'DELETE')
--         and table_name in ('firm_file_requests', 'firm_client_cadence', 'firm_briefs',
--                            'firm_digest_prefs', 'firm_file_request_tokens',
--                            'firm_email_queue', 'firm_digest_log');
--      -- expect EXACTLY two rows, both UPDATE for authenticated:
--      -- firm_client_cadence and firm_briefs (the two upserted tables);
--      -- no DELETE row anywhere, nothing for anon.
-- 5. Set FIRM_REQUEST_SIGNING_KEY in the backend env (32+ random bytes,
--    base64). Without it the request routes FAIL CLOSED (503): a signed
--    link cannot be minted or verified against a key nobody set.
-- 6. Schedule the two crons with the ENGINE_API_TOKEN bearer:
--      POST /api/firm/requests/cron/nudge      (daily, e.g. 06:30 UTC)
--      POST /api/firm/digest/cron/run          (daily, e.g. 07:00 UTC)
--    and drain the queue: POST /api/firm/email/drain (admin JWT).
--
-- Idempotent: safe to re-run (create … if not exists / add column if not
-- exists / every policy dropped-if-exists before it is created / guarded
-- constraint block).
-- ───────────────────────────────────────────────────────────────────────────

-- 1. firm_client_cadence ─────────────────────────────────────────────────────
-- One row per client that a firm has configured; a client with NO row takes
-- the pack default (packs/firm/cadence.yaml). Every number here is an
-- OVERRIDE of pack data; the engine never carries a deadline in code.
create table if not exists firm_client_cadence (
  client_org_id                   uuid primary key references organizations (id) on delete cascade,
  firm_id                         uuid,
  cadence                         text not null
                                    check (cadence in ('monthly', 'quarterly')),
  deadline_days_after_period_end  int
                                    check (deadline_days_after_period_end is null
                                           or deadline_days_after_period_end between 1 and 120),
  fiscal_year_end_month           int not null default 12
                                    check (fiscal_year_end_month between 1 and 12),
  nudge_days_before               jsonb,                 -- e.g. [7, 2]; null → pack
  set_by                          uuid references auth.users (id) on delete set null,
  created_at                      timestamptz not null default now(),
  updated_at                      timestamptz not null default now()
);
create index if not exists firm_client_cadence_firm_idx on firm_client_cadence (firm_id);

drop trigger if exists firm_client_cadence_set_updated_at on firm_client_cadence;
create trigger firm_client_cadence_set_updated_at
  before update on firm_client_cadence
  for each row execute function set_updated_at_now();

alter table firm_client_cadence enable row level security;
drop policy if exists "firm_client_cadence member select" on firm_client_cadence;
drop policy if exists "firm_client_cadence firm read" on firm_client_cadence;
drop policy if exists "firm_client_cadence firm write" on firm_client_cadence;
drop policy if exists "firm_client_cadence firm update" on firm_client_cadence;
create policy "firm_client_cadence member select"
  on firm_client_cadence for select using (is_member_of(client_org_id));
-- The SECOND WALL on the read: a role whose `read` cell is true reads the
-- client's cadence ONLY while the row is the client's own (firm_id null)
-- or belongs to the firm that currently serves the client. A row firm A
-- stored (firm_id = A, set_by = A's accountant) is invisible to firm B
-- after a detach/attach (W3); the workspace's own members keep it.
create policy "firm_client_cadence firm read"
  on firm_client_cadence for select
  using (can_read_client_org(client_org_id)
         and (firm_id is null or firm_id = firm_of_org(client_org_id)));
-- The SECOND WALL on the write (W1): the caller is the author, and the row
-- is pinned to the client's CURRENT firm through a role whose
-- `request_file` cell is true — or it is the workspace's own setting
-- (firm_id null) written by one of its members. A firm-B owner writing
-- firm-A's client's cadence fails `firm_id = firm_of_org(client_org_id)`
-- whichever firm id they name, and `firm_can` when they name firm A.
create policy "firm_client_cadence firm write"
  on firm_client_cadence for insert
  with check (set_by = auth.uid()
              and ((firm_id is not null
                    and firm_id = firm_of_org(client_org_id)
                    and firm_can(firm_id, 'request_file'))
                   or (firm_id is null and is_member_of(client_org_id))));
-- The upsert's conflict half: whoever serves the client NOW (a member, or
-- the current firm's `request_file` role) may replace whatever row exists
-- — including a previous firm's — and the replacement must pass the same
-- pin as a fresh insert.
create policy "firm_client_cadence firm update"
  on firm_client_cadence for update
  using (is_member_of(client_org_id)
         or coalesce(firm_can(firm_of_org(client_org_id), 'request_file'), false))
  with check (set_by = auth.uid()
              and ((firm_id is not null
                    and firm_id = firm_of_org(client_org_id)
                    and firm_can(firm_id, 'request_file'))
                   or (firm_id is null and is_member_of(client_org_id))));
-- No delete policy: a cadence is replaced, never removed, by a client.

-- 2. firm_file_requests ──────────────────────────────────────────────────────
-- A request to a client for ONE period's trial balance. The signed link is
-- bound to (request, client_org_id, period_end) and expires; only its
-- SHA-256 is stored, so a leaked table cannot mint an upload. Single-use:
-- `consumed_at` is set exactly once, when a file lands.
create table if not exists firm_file_requests (
  id               uuid primary key default gen_random_uuid(),
  firm_id          uuid,
  client_org_id    uuid not null references organizations (id) on delete cascade,
  period_end       date not null,
  requested_by     uuid references auth.users (id) on delete set null,
  requested_at     timestamptz not null default now(),
  expires_at       timestamptz not null,
  token_hash       text not null,
  to_email         text,
  note             text,
  status           text not null default 'requested'
                     check (status in ('requested', 'reminded', 'received',
                                       'expired', 'revoked')),
  reminder_count   int not null default 0,
  last_reminded_at timestamptz,
  -- [[period_end, days_before], ...] — the nudges already queued for this
  -- request, so the cron is idempotent across re-runs.
  reminders_sent   jsonb not null default '[]'::jsonb,
  refusal_count    int not null default 0,
  consumed_at      timestamptz,
  document_id      uuid references documents (id) on delete set null,
  -- What the upload guards recorded (jsonb, engine-written):
  --   entity_guard: {verdict: match|mismatch|unknown, reason, document, expected}
  --   period_guard: {bound, proposed, signal, agrees, evidence}
  entity_guard     jsonb,
  period_guard     jsonb,
  -- Identity the request was minted against (name from organizations,
  -- optional CUI supplied by the requester) — frozen at mint time so a
  -- later rename cannot change what the guard compared.
  expected_identity jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create unique index if not exists firm_file_requests_token_hash_uidx
  on firm_file_requests (token_hash);
create index if not exists firm_file_requests_client_idx
  on firm_file_requests (client_org_id, period_end desc);
create index if not exists firm_file_requests_firm_idx
  on firm_file_requests (firm_id);
-- One OPEN request per (client, period): a second ask for the same month
-- is a reminder, not a new row.
create unique index if not exists firm_file_requests_open_uidx
  on firm_file_requests (client_org_id, period_end)
  where status in ('requested', 'reminded');
create index if not exists firm_file_requests_open_expiry_idx
  on firm_file_requests (expires_at)
  where status in ('requested', 'reminded');

drop trigger if exists firm_file_requests_set_updated_at on firm_file_requests;
create trigger firm_file_requests_set_updated_at
  before update on firm_file_requests
  for each row execute function set_updated_at_now();

alter table firm_file_requests enable row level security;
drop policy if exists "firm_file_requests member select" on firm_file_requests;
drop policy if exists "firm_file_requests firm read" on firm_file_requests;
drop policy if exists "firm_file_requests firm write" on firm_file_requests;
drop policy if exists "firm_file_requests firm update" on firm_file_requests;
create policy "firm_file_requests member select"
  on firm_file_requests for select using (is_member_of(client_org_id));
-- The SECOND WALL: the firm that CURRENTLY serves the client, through a
-- role whose `read` cell is true, sees the requests IT minted. A row a
-- previous firm minted (firm_id <> firm_of_org) stays invisible to the
-- new firm — the client's request history does not follow it across
-- firms (C3). The route filters by firm_id too; either wall alone holds.
create policy "firm_file_requests firm read"
  on firm_file_requests for select
  using (firm_id is not null
         and firm_id = firm_of_org(client_org_id)
         and firm_can(firm_id, 'read'));
-- The SECOND WALL on the write (W1): the caller is the requester, and the
-- row is pinned to the client's CURRENT firm through a role whose
-- `request_file` cell is true — or the workspace's own member asks (firm_id
-- null). The secret token and the queued e-mail are written by the backend
-- only AFTER this insert was admitted.
create policy "firm_file_requests firm write"
  on firm_file_requests for insert
  with check (requested_by = auth.uid()
              and ((firm_id is not null
                    and firm_id = firm_of_org(client_org_id)
                    and firm_can(firm_id, 'request_file'))
                   or (firm_id is null and is_member_of(client_org_id))));
-- The one update a signed-in user makes is a REVOCATION (the landing and
-- the crons write service-role, token- / bearer-gated). Same pin, same cell.
create policy "firm_file_requests firm update"
  on firm_file_requests for update
  using ((firm_id is not null
          and firm_id = firm_of_org(client_org_id)
          and firm_can(firm_id, 'request_file'))
         or (firm_id is null and is_member_of(client_org_id)))
  with check ((firm_id is not null
               and firm_id = firm_of_org(client_org_id)
               and firm_can(firm_id, 'request_file'))
              or (firm_id is null and is_member_of(client_org_id)));
-- No delete policy. token_hash is readable by members; it is a hash, not
-- the token.

-- 2b. firm_file_request_tokens ───────────────────────────────────────────────
-- The SECRET half. `firm_file_requests.token_hash` is member-readable and is
-- only a hash; the reminder cron needs the original link to put in the
-- email, so the token itself lives here, in a table with NO policy at all
-- (service role only). A leaked member session reads hashes, never links.
create table if not exists firm_file_request_tokens (
  request_id  uuid primary key references firm_file_requests (id) on delete cascade,
  token       text not null,
  created_at  timestamptz not null default now()
);
alter table firm_file_request_tokens enable row level security;
-- No policies: service-role only.

-- 3. firm_digest_prefs ───────────────────────────────────────────────────────
-- Per accountant (and per firm once firms exist). `enabled` DEFAULTS TO
-- FALSE: nothing is sent without an explicit opt-in, which the firm
-- creation flow records through PUT /api/firm/digest/prefs.
create table if not exists firm_digest_prefs (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users (id) on delete cascade,
  firm_id             uuid,
  enabled             boolean not null default false,
  frequency           text not null default 'daily'
                        check (frequency in ('daily', 'weekly')),
  send_hour_utc       int not null default 7 check (send_hour_utc between 0 and 23),
  last_sent_at        timestamptz,
  last_item_set_hash  text,
  -- The item ids the LAST digest carried. "New since your last digest" is
  -- decided against this set, never against a clock: an item is new when
  -- its id is not here. Empty until the first digest goes out.
  last_item_ids       jsonb not null default '[]'::jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
-- One preference row per (user, firm); the null firm (pre-tenancy) is
-- folded to the nil uuid so the uniqueness holds for it too.
create unique index if not exists firm_digest_prefs_user_firm_uidx
  on firm_digest_prefs (user_id, coalesce(firm_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index if not exists firm_digest_prefs_enabled_idx
  on firm_digest_prefs (enabled) where enabled;

drop trigger if exists firm_digest_prefs_set_updated_at on firm_digest_prefs;
create trigger firm_digest_prefs_set_updated_at
  before update on firm_digest_prefs
  for each row execute function set_updated_at_now();

alter table firm_digest_prefs enable row level security;
drop policy if exists "firm_digest_prefs own select" on firm_digest_prefs;
drop policy if exists "firm_digest_prefs own insert" on firm_digest_prefs;
drop policy if exists "firm_digest_prefs own update" on firm_digest_prefs;
create policy "firm_digest_prefs own select"
  on firm_digest_prefs for select using (user_id = auth.uid());
create policy "firm_digest_prefs own insert"
  on firm_digest_prefs for insert
  with check (user_id = auth.uid()
              and (firm_id is null or is_firm_member_of(firm_id)));
create policy "firm_digest_prefs own update"
  on firm_digest_prefs for update using (user_id = auth.uid())
  with check (user_id = auth.uid()
              and (firm_id is null or is_firm_member_of(firm_id)));
-- A preference names a firm the caller is a member of, or none: a row for
-- a firm the caller is not in would make the digest cron compute that
-- firm's book (it refuses — but the row should never exist).

-- 4. firm_digest_log ─────────────────────────────────────────────────────────
-- One row per digest actually queued — the idempotency record the cron
-- checks so a re-run inside the same day cannot send twice.
create table if not exists firm_digest_log (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users (id) on delete cascade,
  firm_id          uuid,
  sent_for_date    date not null,
  item_set_hash    text not null,
  item_count       int not null default 0,
  queued_email_id  uuid,
  created_at       timestamptz not null default now()
);
create unique index if not exists firm_digest_log_user_firm_day_uidx
  on firm_digest_log (user_id, coalesce(firm_id, '00000000-0000-0000-0000-000000000000'::uuid), sent_for_date);

alter table firm_digest_log enable row level security;
drop policy if exists "firm_digest_log own select" on firm_digest_log;
create policy "firm_digest_log own select"
  on firm_digest_log for select using (user_id = auth.uid());

-- 5. firm_email_queue ────────────────────────────────────────────────────────
-- The queued email stub — the renewal_email_queue pattern
-- (schema_phase_newsletter.sql), drained by POST /api/firm/email/drain.
-- `payload` carries {to, subject, template, vars}; the branded body is
-- rendered at drain time from `template` + `vars`.
create table if not exists firm_email_queue (
  id           uuid primary key default gen_random_uuid(),
  kind         text not null
                 check (kind in ('file_request', 'file_request_reminder', 'digest')),
  firm_id      uuid,
  client_org_id uuid,
  request_id   uuid references firm_file_requests (id) on delete set null,
  user_id      uuid references auth.users (id) on delete set null,
  to_email     text not null,
  send_at      timestamptz not null default now(),
  template     text not null,
  payload      jsonb not null default '{}'::jsonb,
  status       text not null default 'queued'
                 check (status in ('queued', 'sent', 'failed')),
  error        text,
  sent_at      timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists firm_email_queue_pending_idx
  on firm_email_queue (status, send_at) where sent_at is null;

alter table firm_email_queue enable row level security;
-- No policies: service-role only.

-- 6. firm_briefs ─────────────────────────────────────────────────────────────
-- The "brief me" cache: one row per (firm, day, item-set hash). `firm_key`
-- is the firm id, or the user id before firms exist. `payload` is the full
-- brief payload (deterministic order + guarded prose + notice); `degraded`
-- says whether the model contributed.
create table if not exists firm_briefs (
  id              uuid primary key default gen_random_uuid(),
  firm_key        text not null,
  -- The firm the brief belongs to (null before firms exist / for a
  -- membership-scoped brief): the column the firm read policy pins on.
  firm_id         uuid,
  -- Every client the brief names (W5) — see the policy helper below.
  client_org_ids  uuid[] not null default '{}'::uuid[],
  user_id         uuid references auth.users (id) on delete set null,
  brief_date      date not null,
  item_set_hash   text not null,
  payload         jsonb not null,
  model_id        text,
  prompt_version  text,
  degraded        boolean not null default true,
  created_at      timestamptz not null default now()
);
alter table firm_briefs add column if not exists firm_id uuid;
-- The CLIENT dimension (W5): every client the brief names. A brief is
-- readable by a firm only while every one of them still belongs to that
-- firm; a membership-scoped brief only while the reader is still a member
-- of each. The route writes the sorted, de-duplicated set of client ids
-- its items carry.
alter table firm_briefs add column if not exists client_org_ids uuid[] not null default '{}'::uuid[];
create unique index if not exists firm_briefs_key_day_hash_uidx
  on firm_briefs (firm_key, brief_date, item_set_hash);
create index if not exists firm_briefs_firm_idx on firm_briefs (firm_id);

-- SECURITY DEFINER helper for the brief policies: true when EVERY client
-- named still belongs to `_firm_id` (a firm brief), or — for a brief with
-- no firm — when the caller is still a member of every one. An empty or
-- null set is trivially readable. Reads `organizations` / `memberships`
-- only through the tenancy helpers (42P17-safe).
create or replace function firm_brief_clients_readable(_firm_id uuid, _client_org_ids uuid[])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select not exists (
    select 1 from unnest(_client_org_ids) as u(id)
    where (_firm_id is not null and firm_of_org(u.id) is distinct from _firm_id)
       or (_firm_id is null and not is_member_of(u.id))
  );
$$;
revoke execute on function firm_brief_clients_readable(uuid, uuid[]) from public, anon;
grant  execute on function firm_brief_clients_readable(uuid, uuid[]) to authenticated;

alter table firm_briefs enable row level security;
drop policy if exists "firm_briefs firm read" on firm_briefs;
drop policy if exists "firm_briefs firm write" on firm_briefs;
drop policy if exists "firm_briefs firm update" on firm_briefs;
-- The SECOND WALL on the cache: a firm's brief is readable by a role
-- whose `read` cell is true; a brief with no firm is its author's own;
-- and in both cases only while every client it names is still theirs.
create policy "firm_briefs firm read"
  on firm_briefs for select
  using (((firm_id is not null and firm_can(firm_id, 'read'))
          or (firm_id is null and user_id = auth.uid()))
         and firm_brief_clients_readable(firm_id, client_org_ids));
-- The SECOND WALL on the write (W1): the caller is the author, holds the
-- firm's `read` cell when a firm is named, and every client the brief
-- names is that firm's (or the caller's own workspace) RIGHT NOW.
-- firm_key is the cache LOOKUP key (the reader selects by it): pinned to
-- the firm's id, or the author's own id when the brief has no firm, so
-- no caller can park a row under another firm's key (D1).
create policy "firm_briefs firm write"
  on firm_briefs for insert
  with check (user_id = auth.uid()
              and (firm_id is null or firm_can(firm_id, 'read'))
              and firm_key = cast(coalesce(firm_id, user_id) as text)
              and firm_brief_clients_readable(firm_id, client_org_ids));
create policy "firm_briefs firm update"
  on firm_briefs for update
  using (((firm_id is not null and firm_can(firm_id, 'read'))
          or (firm_id is null and user_id = auth.uid()))
         and firm_brief_clients_readable(firm_id, client_org_ids))
  with check (user_id = auth.uid()
              and (firm_id is null or firm_can(firm_id, 'read'))
              and firm_key = cast(coalesce(firm_id, user_id) as text)
              and firm_brief_clients_readable(firm_id, client_org_ids));

-- 7. Foreign keys to the tenancy lane's `firms` table ─────────────────────
-- schema_phase_firm.sql is a prerequisite (the policies above call its
-- helpers), so `firms` exists here; the guard stays so a re-run is a no-op
-- and a partial earlier apply attaches the constraints.
do $$
begin
  if to_regclass('public.firms') is not null then
    if not exists (select 1 from pg_constraint where conname = 'firm_client_cadence_firm_fk') then
      alter table firm_client_cadence
        add constraint firm_client_cadence_firm_fk
        foreign key (firm_id) references firms (id) on delete set null;
    end if;
    if not exists (select 1 from pg_constraint where conname = 'firm_file_requests_firm_fk') then
      alter table firm_file_requests
        add constraint firm_file_requests_firm_fk
        foreign key (firm_id) references firms (id) on delete set null;
    end if;
    if not exists (select 1 from pg_constraint where conname = 'firm_digest_prefs_firm_fk') then
      alter table firm_digest_prefs
        add constraint firm_digest_prefs_firm_fk
        foreign key (firm_id) references firms (id) on delete cascade;
    end if;
    if not exists (select 1 from pg_constraint where conname = 'firm_digest_log_firm_fk') then
      alter table firm_digest_log
        add constraint firm_digest_log_firm_fk
        foreign key (firm_id) references firms (id) on delete cascade;
    end if;
    if not exists (select 1 from pg_constraint where conname = 'firm_email_queue_firm_fk') then
      alter table firm_email_queue
        add constraint firm_email_queue_firm_fk
        foreign key (firm_id) references firms (id) on delete set null;
    end if;
    if not exists (select 1 from pg_constraint where conname = 'firm_briefs_firm_fk') then
      alter table firm_briefs
        add constraint firm_briefs_firm_fk
        foreign key (firm_id) references firms (id) on delete cascade;
    end if;
  end if;
end$$;

-- 8. Purge hook ──────────────────────────────────────────────────────────────
-- purge_expired_workspaces() (schema_phase_multi_workspace.sql) deletes
-- org-scoped roots by name and cannot see these tables. The FK
-- `client_org_id → organizations on delete cascade` on the two org-scoped
-- tables here (firm_client_cadence, firm_file_requests) takes care of them
-- when an organization row is deleted; firm_email_queue rows for a purged
-- client keep their client_org_id as a plain uuid (no FK) and are drained
-- or fail harmlessly.

-- 9. Column privileges — the second closure of D1 ───────────────────────────
-- Narrows the Supabase default table-wide grant (see the header). Postgres
-- checks these BEFORE row-level security: a PATCH naming a column outside
-- the grant is `42501 permission denied for table …` whatever the policies
-- would have said. A table-level REVOKE also revokes every column-level
-- grant of the same privilege, so revoke-then-grant lands exactly this
-- set on every re-run. Idempotent.
revoke update, delete on firm_file_requests from anon, authenticated;
grant update (status) on firm_file_requests to authenticated;

revoke update, delete on firm_digest_prefs from anon, authenticated;
grant update (enabled, frequency, send_hour_utc) on firm_digest_prefs to authenticated;

-- The two upserted tables keep table-wide UPDATE for `authenticated`
-- (header); anon never passes a policy and loses it; DELETE goes.
revoke update, delete on firm_client_cadence from anon;
revoke delete on firm_client_cadence from authenticated;
revoke update, delete on firm_briefs from anon;
revoke delete on firm_briefs from authenticated;

-- No policy, no privilege: service-role only, twice over.
revoke insert, update, delete on firm_file_request_tokens from anon, authenticated;
revoke insert, update, delete on firm_email_queue from anon, authenticated;
revoke insert, update, delete on firm_digest_log from anon, authenticated;

-- Required by the locked schema-migration discipline. The Dashboard
-- "Reload schema cache" click is the deterministic step on Supabase.
NOTIFY pgrst, 'reload schema';
