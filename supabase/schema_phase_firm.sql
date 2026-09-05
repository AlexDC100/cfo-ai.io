-- FIRM MODEL — accounting firms over client workspaces (Firm Cockpit, Part A).
--
-- An accounting firm brings 30-80 client companies. Each client is a
-- WORKSPACE (workspace == organization, CLAUDE.md §16) exactly as today;
-- this migration adds the layer above it:
--
--   firms ──< firm_memberships (owner | partner | accountant | assistant | viewer)
--     │
--     └──< organizations.firm_id (NULLABLE — a workspace with no firm IS the
--             current product and is untouched by everything in this file)
--             └── client_assignments (one responsible accountant per client,
--                                     optional collaborators)
--
-- WHAT IS DATA HERE, ON PURPOSE. The five roles are ROWS in `firm_roles`
-- and the role × action matrix is ROWS in `firm_role_permissions`. Every
-- policy and every RPC asks `firm_can(firm_id, 'action')`; nothing in
-- this file or in src/engine/api/_firm.py branches on a role name to
-- grant an action. Tightening or loosening a role is an UPDATE on the
-- matrix, mirrored in `_firm.ROLE_MATRIX` (tests/engine/test_firm_tenancy.py
-- asserts the two agree PER CELL).
--
-- THE 42P17 TRAP, RESPECTED. `is_firm_member_of`, `firm_role_of`,
-- `firm_can`, `firm_of_org` and `can_read_client_org` are SECURITY
-- DEFINER FUNCTIONS. The policy on `firm_memberships` calls
-- `is_firm_member_of(firm_id)` — a function that reads firm_memberships —
-- which is the documented workaround; a self-referencing
-- `exists (select … from firm_memberships …)` INSIDE the policy would be
-- the infinite-recursion trap from schema_phase3.sql:193.
--
-- CLIENT DATA VISIBILITY IS ADDITIVE. The org-scoped tables keep their
-- `is_member_of(org_id)` policies untouched. This file ADDS a
-- select-only "<table> firm read" policy using `can_read_client_org(org_id)`
-- = is_member_of(org_id) OR firm_can(firm_of_org(org_id), 'read'). RLS
-- ORs policies, so a workspace with firm_id NULL evaluates exactly as
-- before, and a firm member sees a client only through a role whose
-- `read` cell is true. No write policy is added for firm members
-- anywhere: a firm reads its clients; it does not edit their books.
--
-- ── OPERATOR RUNBOOK (locked discipline — CLAUDE.md §14 / F3.24) ──────
-- 0. PRE-FLIGHT — all three must hold before running anything below:
--
--      -- (a) the helpers this file builds on exist
--      select proname from pg_proc
--       where proname in ('is_member_of', 'set_updated_at_now');
--      -- expect BOTH rows (schema_phase3.sql); if either is missing, apply
--      -- schema_phase3.sql first.
--
--      -- (b) the multi-workspace migration is applied
--      select column_name from information_schema.columns
--       where table_name = 'organizations' and column_name = 'archived_at';
--      -- expect one row (schema_phase_multi_workspace.sql).
--
--      -- (c) nothing already claims the names this file introduces
--      select to_regclass('public.firms'), to_regclass('public.firm_memberships'),
--             to_regclass('public.client_assignments');
--      -- expect three NULLs on a first apply; non-NULL means a partial
--      -- earlier apply — this file is idempotent, so proceed, but read
--      -- step 4 to confirm the matrix rows are the ones expected.
--
-- 1. APPLY ORDER: schema_phase3.sql → schema_phase_multi_workspace.sql →
--    schema_phase_industry_intelligence.sql (only needed for CSV-import
--    industry resolution; the firm model itself does not depend on it)
--    → THIS FILE. Run it in Supabase Studio; it ends with the NOTIFY.
-- 2. IMMEDIATELY click Supabase Dashboard → Settings → API →
--    "Reload schema cache". The NOTIFY is optimistic on Supabase managed
--    infra; the Dashboard click is the deterministic step.
-- 3. VERIFY PostgREST sees the surface — none of these may 400:
--      select id, name from firms limit 1;
--      select id, firm_id, cui from organizations limit 1;
--      select role, action, allowed from firm_role_permissions limit 1;
--    If they stay invisible after the click, this is the F3.25 Bug #4
--    persistent-cache case: stop, do not deploy the backend, open a
--    Supabase ticket.
-- 4. VERIFY THE MATRIX has exactly 35 rows (5 roles × 7 actions):
--      select count(*) from firm_role_permissions;   -- 35
--      select role, count(*) filter (where allowed) from firm_role_permissions
--       group by role order by role;
--      -- accountant 3 · assistant 2 · owner 7 · partner 6 · viewer 1
-- 5. ROLLBACK (order matters — policies and functions first, then
--    tables, then the organizations columns):
--      drop policy if exists "organizations firm read" on organizations;
--      drop policy if exists "financial_periods firm read" on financial_periods;
--      drop policy if exists "documents firm read" on documents;
--      drop policy if exists "alerts firm read" on alerts;
--      drop policy if exists "recommendations firm read" on recommendations;
--      drop policy if exists "calculated_metrics firm read" on calculated_metrics;
--      drop policy if exists "briefings firm read" on briefings;
--      drop policy if exists "statement_line_items firm read" on statement_line_items;
--      drop function if exists can_read_client_org(uuid);
--      drop function if exists firm_of_org(uuid);
--      drop function if exists list_firm_clients(uuid);
--      drop function if exists list_firm_members(uuid);
--      drop function if exists list_firms();
--      drop function if exists create_firm(text);
--      drop function if exists attach_workspace_to_firm(uuid, uuid);
--      drop function if exists detach_workspace_from_firm(uuid);
--      drop function if exists assign_client(uuid, uuid, uuid[]);
--      drop function if exists set_firm_member_role(uuid, uuid, text);
--      drop function if exists remove_firm_member(uuid, uuid);
--      drop function if exists create_firm_invitation(uuid, text, text, int);
--      drop function if exists accept_firm_invitation(uuid);
--      drop function if exists revoke_firm_invitation(uuid);
--      drop function if exists import_firm_client(uuid, text, text, text, text, text, uuid, jsonb);
--      drop function if exists firm_audit(uuid, text, jsonb);
--      drop function if exists firm_can(uuid, text);
--      drop function if exists firm_role_of(uuid);
--      drop function if exists is_firm_member_of(uuid);
--      drop table if exists firm_invite_email_queue;
--      drop table if exists firm_audit_log;
--      drop table if exists firm_invitations;
--      drop table if exists client_assignments;
--      drop table if exists firm_role_permissions;
--      drop table if exists firm_memberships;
--      alter table organizations drop column if exists firm_id;
--      alter table organizations drop column if exists cui;
--      drop table if exists firms;
--      drop table if exists firm_roles;
--      NOTIFY pgrst, 'reload schema';   -- then the Dashboard click again
--    Rollback touches no client data: the only writes this file makes to
--    pre-existing tables are two nullable columns on organizations. The
--    table privileges of section 15 go with the tables; nothing to undo.
-- 6. VERIFY THE TABLE PRIVILEGES (section 15) — `authenticated` holds
--    UPDATE on exactly (name, archived_at) of firms and no INSERT / UPDATE
--    / DELETE on any other table of this file:
--      select table_name, privilege_type from information_schema.table_privileges
--       where grantee in ('anon', 'authenticated')
--         and privilege_type in ('INSERT', 'UPDATE', 'DELETE')
--         and table_name in ('firms', 'firm_roles', 'firm_role_permissions',
--                            'firm_memberships', 'client_assignments',
--                            'firm_invitations', 'firm_audit_log',
--                            'firm_invite_email_queue');
--      -- expect NO row
--      select column_name from information_schema.column_privileges
--       where grantee = 'authenticated' and privilege_type = 'UPDATE'
--         and table_name = 'firms' order by 1;
--      -- archived_at, name  (two rows)
-- ─────────────────────────────────────────────────────────────────────

-- ─────────── 1. Roles — DATA, not a CHECK list ─────────────────────────────

create table if not exists firm_roles (
  role        text primary key,
  rank        int  not null unique,     -- 1 = most privileged; display order only
  description text not null
);

insert into firm_roles (role, rank, description) values
  ('owner',      1, 'Runs the firm: everything, including roles, rename, archive.'),
  ('partner',    2, 'Runs the client book: assigns, invites, imports, requests, suppresses.'),
  ('accountant', 3, 'Works the clients: reads, requests files, suppresses with a reason.'),
  ('assistant',  4, 'Supports the accountants: reads, requests files.'),
  ('viewer',     5, 'Read-only.')
on conflict (role) do update
  set rank = excluded.rank, description = excluded.description;

-- ─────────── 2. Firms ──────────────────────────────────────────────────────

create table if not exists firms (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  created_by  uuid references auth.users(id) on delete set null,
  archived_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

drop trigger if exists firms_set_updated_at on firms;
create trigger firms_set_updated_at
  before update on firms
  for each row execute function set_updated_at_now();

-- ─────────── 3. organizations.firm_id (nullable) + organizations.cui ───────
-- firm_id NULL == today's product. ON DELETE SET NULL: deleting a firm
-- leaves every client workspace standing, solo, exactly as if it had
-- been detached.
--
-- cui: the client's fiscal code. Written by the CSV import so a second
-- import of the same book is a DUPLICATE, not a second workspace. Free
-- text (normalised to digits by the importer), nullable — every
-- existing workspace has none.

alter table organizations add column if not exists firm_id uuid references firms(id) on delete set null;
alter table organizations add column if not exists cui text;

create index if not exists organizations_firm_id_idx
  on organizations (firm_id) where firm_id is not null;
create index if not exists organizations_firm_cui_idx
  on organizations (firm_id, cui) where firm_id is not null and cui is not null;

-- ─────────── 4. Firm memberships ───────────────────────────────────────────

create table if not exists firm_memberships (
  firm_id    uuid not null references firms(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  role       text not null references firm_roles(role),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (firm_id, user_id)
);

create index if not exists firm_memberships_user_idx on firm_memberships (user_id);

drop trigger if exists firm_memberships_set_updated_at on firm_memberships;
create trigger firm_memberships_set_updated_at
  before update on firm_memberships
  for each row execute function set_updated_at_now();

-- ─────────── 5. THE ROLE MATRIX — data, one row per cell ───────────────────
-- Actions:
--   read          see the firm's clients and their served data
--   assign        set the responsible accountant / collaborators on a client
--   invite        invite people into the firm (inviting an OWNER also needs manage)
--   import        attach workspaces / bulk-create clients from CSV
--   request_file  ask a client for a document (Part B wires the request)
--   suppress      dismiss an attention item WITH a reason (a dismissed
--                 Critical stays surfaced and flagged — _finding_rank.py)
--   manage        rename/archive the firm, change roles, remove members,
--                 detach a client the firm brought in
--
-- src/engine/api/_firm.py::ROLE_MATRIX mirrors this table; the test suite
-- parses THIS insert and compares cell by cell.

create table if not exists firm_role_permissions (
  role    text not null references firm_roles(role) on delete cascade,
  action  text not null check (action in
            ('read', 'assign', 'invite', 'import', 'request_file', 'suppress', 'manage')),
  allowed boolean not null,
  primary key (role, action)
);

insert into firm_role_permissions (role, action, allowed) values
  ('owner',      'read',         true),
  ('owner',      'assign',       true),
  ('owner',      'invite',       true),
  ('owner',      'import',       true),
  ('owner',      'request_file', true),
  ('owner',      'suppress',     true),
  ('owner',      'manage',       true),

  ('partner',    'read',         true),
  ('partner',    'assign',       true),
  ('partner',    'invite',       true),
  ('partner',    'import',       true),
  ('partner',    'request_file', true),
  ('partner',    'suppress',     true),
  ('partner',    'manage',       false),

  ('accountant', 'read',         true),
  ('accountant', 'assign',       false),
  ('accountant', 'invite',       false),
  ('accountant', 'import',       false),
  ('accountant', 'request_file', true),
  ('accountant', 'suppress',     true),
  ('accountant', 'manage',       false),

  ('assistant',  'read',         true),
  ('assistant',  'assign',       false),
  ('assistant',  'invite',       false),
  ('assistant',  'import',       false),
  ('assistant',  'request_file', true),
  ('assistant',  'suppress',     false),
  ('assistant',  'manage',       false),

  ('viewer',     'read',         true),
  ('viewer',     'assign',       false),
  ('viewer',     'invite',       false),
  ('viewer',     'import',       false),
  ('viewer',     'request_file', false),
  ('viewer',     'suppress',     false),
  ('viewer',     'manage',       false)
on conflict (role, action) do update set allowed = excluded.allowed;

-- ─────────── 6. Client assignments ─────────────────────────────────────────
-- One row per client workspace (unique on org_id — a workspace belongs to
-- at most one firm, so one responsible accountant per client). NULL
-- responsible is an honest "unassigned", never a default to whoever
-- attached it.
--
-- import_resolution: what the CSV import could and could not resolve —
-- {industry: {status, source, …}, public_data: {…}, responsible: {…}}.
-- An UNRESOLVED industry is recorded HERE as a status, and the org's
-- industry_key stays NULL; it is never filled with a guess.

create table if not exists client_assignments (
  id                   uuid primary key default gen_random_uuid(),
  firm_id              uuid not null references firms(id) on delete cascade,
  org_id               uuid not null references organizations(id) on delete cascade,
  responsible_user_id  uuid references auth.users(id) on delete set null,
  collaborator_user_ids uuid[] not null default '{}'::uuid[],
  import_resolution    jsonb,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (org_id)
);

create index if not exists client_assignments_firm_idx on client_assignments (firm_id);
create index if not exists client_assignments_responsible_idx
  on client_assignments (responsible_user_id) where responsible_user_id is not null;

drop trigger if exists client_assignments_set_updated_at on client_assignments;
create trigger client_assignments_set_updated_at
  before update on client_assignments
  for each row execute function set_updated_at_now();

-- ─────────── 7. Invitations — email-scoped, role-scoped, expiring ───────────

create table if not exists firm_invitations (
  id          uuid primary key default gen_random_uuid(),
  firm_id     uuid not null references firms(id) on delete cascade,
  email       text not null,
  role        text not null references firm_roles(role),
  token       uuid not null default gen_random_uuid() unique,
  invited_by  uuid references auth.users(id) on delete set null,
  expires_at  timestamptz not null,
  accepted_at timestamptz,
  accepted_by uuid references auth.users(id) on delete set null,
  revoked_at  timestamptz,
  created_at  timestamptz not null default now()
);

create index if not exists firm_invitations_firm_idx  on firm_invitations (firm_id);
create index if not exists firm_invitations_email_idx on firm_invitations (lower(email));

-- ─────────── 8. Audit log — append-only, service-role writes ───────────────
-- firm_id ON DELETE SET NULL: the trail outlives the firm.

create table if not exists firm_audit_log (
  id            uuid primary key default gen_random_uuid(),
  firm_id       uuid references firms(id) on delete set null,
  actor_user_id uuid,
  action        text not null,
  target        jsonb,
  created_at    timestamptz not null default now()
);

create index if not exists firm_audit_log_firm_idx on firm_audit_log (firm_id, created_at desc);

-- ─────────── 9. Invitation e-mail queue — renewal_email_queue pattern ───────
-- Columns mirror renewal_email_queue (schema_phase_newsletter.sql) so the
-- same drain shape applies: send_at, template, payload, status, error,
-- sent_at. Sending is a STUB in this wave: _firm_invites.py drops a row
-- here and nothing dispatches it until a drain is pointed at this table.

create table if not exists firm_invite_email_queue (
  id             uuid primary key default gen_random_uuid(),
  invitation_id  uuid references firm_invitations(id) on delete cascade,
  send_at        timestamptz not null default now(),
  template       text,
  payload        jsonb not null default '{}'::jsonb,
  status         text not null default 'queued'
                   check (status in ('queued', 'sent', 'failed')),
  error          text,
  sent_at        timestamptz,
  created_at     timestamptz not null default now()
);
create index if not exists firm_invite_email_queue_pending_idx
  on firm_invite_email_queue (status, send_at) where sent_at is null;

-- ─────────── 10. SECURITY DEFINER helpers (the 42P17-safe layer) ───────────

create or replace function is_firm_member_of(_firm_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from firm_memberships
    where firm_id = _firm_id and user_id = auth.uid()
  );
$$;

create or replace function firm_role_of(_firm_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from firm_memberships
  where firm_id = _firm_id and user_id = auth.uid();
$$;

-- The ONE permission question. Reads the matrix; never a role name.
create or replace function firm_can(_firm_id uuid, _action text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select p.allowed
    from firm_memberships m
    join firm_role_permissions p on p.role = m.role
    where m.firm_id = _firm_id
      and m.user_id = auth.uid()
      and p.action = _action
  ), false);
$$;

create or replace function firm_of_org(_org_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select firm_id from organizations where id = _org_id;
$$;

-- Client-data read predicate: the workspace's own members as before, OR a
-- member of the firm the workspace is attached to, through a role whose
-- `read` cell is true. NULL firm_id short-circuits to the old answer.
create or replace function can_read_client_org(_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select is_member_of(_org_id)
      or coalesce(firm_can(firm_of_org(_org_id), 'read'), false);
$$;

-- Internal audit writer. NOT granted to any API role; called from the
-- RPCs below (which run as the definer).
create or replace function firm_audit(_firm_id uuid, _action text, _target jsonb)
returns void
language sql
security definer
set search_path = public
as $$
  insert into firm_audit_log (firm_id, actor_user_id, action, target)
  values (_firm_id, auth.uid(), _action, _target);
$$;

-- ─────────── 11. RLS ───────────────────────────────────────────────────────

alter table firm_roles              enable row level security;
alter table firms                   enable row level security;
alter table firm_memberships        enable row level security;
alter table firm_role_permissions   enable row level security;
alter table client_assignments      enable row level security;
alter table firm_invitations        enable row level security;
alter table firm_audit_log          enable row level security;
alter table firm_invite_email_queue enable row level security;

-- Roles and the matrix are reference data: any signed-in client may read
-- them (the UI renders "what can I do"). No client writes.
drop policy if exists "firm_roles authenticated select" on firm_roles;
create policy "firm_roles authenticated select"
  on firm_roles for select using (auth.uid() is not null);

drop policy if exists "firm_role_permissions authenticated select" on firm_role_permissions;
create policy "firm_role_permissions authenticated select"
  on firm_role_permissions for select using (auth.uid() is not null);

-- Firms: members see their firm; rename needs `manage`; no client
-- insert/delete (create_firm RPC; deletion is an operator action).
drop policy if exists "firms member select" on firms;
drop policy if exists "firms manage update" on firms;
create policy "firms member select"
  on firms for select using (is_firm_member_of(id));
create policy "firms manage update"
  on firms for update using (firm_can(id, 'manage')) with check (firm_can(id, 'manage'));

-- Memberships: the roster is visible to every member — through the
-- SECURITY DEFINER helper, never a self-referencing subquery (42P17).
-- No client write policy: roles change through RPCs.
drop policy if exists "firm_memberships member select" on firm_memberships;
create policy "firm_memberships member select"
  on firm_memberships for select using (is_firm_member_of(firm_id));

-- Assignments: readable by anyone whose role reads the client book.
drop policy if exists "client_assignments firm read" on client_assignments;
create policy "client_assignments firm read"
  on client_assignments for select using (firm_can(firm_id, 'read'));

-- Invitations: the inviting side sees them by `invite`; the invitee sees
-- the ones addressed to their own e-mail (to accept from the app).
drop policy if exists "firm_invitations inviter select" on firm_invitations;
drop policy if exists "firm_invitations invitee select" on firm_invitations;
create policy "firm_invitations inviter select"
  on firm_invitations for select using (firm_can(firm_id, 'invite'));
create policy "firm_invitations invitee select"
  on firm_invitations for select
  using (lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')));

-- Audit: readable by `manage`; written only by firm_audit() / service role.
drop policy if exists "firm_audit_log manage select" on firm_audit_log;
create policy "firm_audit_log manage select"
  on firm_audit_log for select using (firm_can(firm_id, 'manage'));

-- firm_invite_email_queue: NO policies — service-role only (deny-by-default).

-- ─────────── 12. Client data — additive, select-only firm read ─────────────
-- The workspace's own `is_member_of` policies stay exactly as they are.
-- `to_regclass` guards keep this safe on a project where a later table
-- migration has not been applied.

drop policy if exists "organizations firm read" on organizations;
create policy "organizations firm read"
  on organizations for select
  using (firm_id is not null and firm_can(firm_id, 'read'));

drop policy if exists "financial_periods firm read" on financial_periods;
create policy "financial_periods firm read"
  on financial_periods for select using (can_read_client_org(org_id));

drop policy if exists "documents firm read" on documents;
create policy "documents firm read"
  on documents for select using (can_read_client_org(org_id));

drop policy if exists "alerts firm read" on alerts;
create policy "alerts firm read"
  on alerts for select using (can_read_client_org(org_id));

drop policy if exists "recommendations firm read" on recommendations;
create policy "recommendations firm read"
  on recommendations for select using (can_read_client_org(org_id));

do $$
begin
  if to_regclass('public.calculated_metrics') is not null then
    drop policy if exists "calculated_metrics firm read" on calculated_metrics;
    create policy "calculated_metrics firm read"
      on calculated_metrics for select using (can_read_client_org(org_id));
  end if;
  if to_regclass('public.briefings') is not null then
    drop policy if exists "briefings firm read" on briefings;
    create policy "briefings firm read"
      on briefings for select using (can_read_client_org(org_id));
  end if;
  if to_regclass('public.statement_line_items') is not null then
    drop policy if exists "statement_line_items firm read" on statement_line_items;
    create policy "statement_line_items firm read"
      on statement_line_items for select
      using (exists (
        select 1 from financial_periods p
        where p.id = period_id and can_read_client_org(p.org_id)
      ));
  end if;
end$$;

-- ─────────── 13. RPCs ──────────────────────────────────────────────────────
-- There is deliberately NO client INSERT policy on firms, firm_memberships,
-- client_assignments or firm_invitations, and organizations/memberships
-- have none either (schema_phase3.sql). Every mutation goes through one of
-- these SECURITY DEFINER functions, each of which asks firm_can() first
-- and writes an audit row last.
--
-- Error codes are what PostgREST maps to HTTP: 42501 → 403, P0002 → 404,
-- 22023 → 400 (bad parameter), P0001 → state conflict (the backend maps
-- it to 409), 28000 → 401.

create or replace function create_firm(p_name text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_firm_id uuid;
  v_name text := nullif(btrim(p_name), '');
begin
  if auth.uid() is null then
    raise exception 'Not authenticated.' using errcode = '28000';
  end if;
  if v_name is null then
    raise exception 'Firm name is required.' using errcode = '22023';
  end if;

  insert into firms (name, created_by) values (v_name, auth.uid())
  returning id into v_firm_id;

  insert into firm_memberships (firm_id, user_id, role)
  values (v_firm_id, auth.uid(), 'owner');

  perform firm_audit(v_firm_id, 'firm.create', jsonb_build_object('name', v_name));
  return v_firm_id;
end;
$$;

-- Every firm the caller belongs to, with their role and two counts.
create or replace function list_firms()
returns table (
  id uuid,
  name text,
  role text,
  member_count bigint,
  client_count bigint,
  archived_at timestamptz,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select f.id, f.name, m.role,
         (select count(*) from firm_memberships fm where fm.firm_id = f.id),
         (select count(*) from organizations o where o.firm_id = f.id and o.archived_at is null),
         f.archived_at, f.created_at
  from firm_memberships m
  join firms f on f.id = m.firm_id
  where m.user_id = auth.uid()
  order by f.created_at asc;
$$;

-- The roster, with e-mail (read from auth.users as the definer). Members
-- only — the same predicate as the table's select policy.
create or replace function list_firm_members(p_firm_id uuid)
returns table (
  user_id uuid,
  email text,
  role text,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select m.user_id, u.email::text, m.role, m.created_at
  from firm_memberships m
  left join auth.users u on u.id = m.user_id
  where m.firm_id = p_firm_id
    and is_firm_member_of(p_firm_id)
  order by m.created_at asc;
$$;

-- The client book: every attached workspace with its assignment. Gated by
-- the `read` cell, which is the same gate the row policies apply.
create or replace function list_firm_clients(p_firm_id uuid)
returns table (
  org_id uuid,
  name text,
  cui text,
  industry_key text,
  industry_display_name text,
  default_currency text,
  archived_at timestamptz,
  responsible_user_id uuid,
  collaborator_user_ids uuid[],
  import_resolution jsonb,
  attached_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select o.id, o.name, o.cui, o.industry_key, o.industry_display_name,
         o.default_currency, o.archived_at,
         a.responsible_user_id,
         coalesce(a.collaborator_user_ids, '{}'::uuid[]),
         a.import_resolution,
         a.created_at
  from organizations o
  left join client_assignments a on a.org_id = o.id
  where o.firm_id = p_firm_id
    and firm_can(p_firm_id, 'read')
  order by o.name asc, o.id asc;
$$;

-- Attach: the workspace's OWNER consents (they are the one giving the
-- firm read access to their books) AND the caller holds `import` in the
-- firm. Additive: sets firm_id, creates an UNASSIGNED assignment row.
create or replace function attach_workspace_to_firm(p_org_id uuid, p_firm_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current uuid;
begin
  if not exists (
    select 1 from memberships
    where org_id = p_org_id and user_id = auth.uid() and role = 'owner'
  ) then
    raise exception 'Only the workspace owner can attach it to a firm.' using errcode = '42501';
  end if;
  if not firm_can(p_firm_id, 'import') then
    raise exception 'Your firm role cannot bring clients in.' using errcode = '42501';
  end if;
  if exists (select 1 from firms where id = p_firm_id and archived_at is not null) then
    raise exception 'Firm is archived.' using errcode = 'P0001';
  end if;

  select firm_id into v_current from organizations where id = p_org_id;
  if v_current is not null then
    raise exception 'Workspace is already attached to a firm.' using errcode = 'P0001';
  end if;

  update organizations set firm_id = p_firm_id where id = p_org_id;

  insert into client_assignments (firm_id, org_id)
  values (p_firm_id, p_org_id)
  on conflict (org_id) do update set firm_id = excluded.firm_id;

  perform firm_audit(p_firm_id, 'client.attach', jsonb_build_object('org_id', p_org_id));
end;
$$;

-- Import: ONE client workspace from a CSV row (src/engine/api/_firm_import.py).
-- The SQL wall on the one firm-model write that used to be service-role
-- only (W1): the caller holds `import` in THIS firm, the firm is live, the
-- CUI is new to the firm, and the responsible accountant (when named) is a
-- firm member. Creates the organization, makes the importer its org OWNER
-- (so every per-workspace route works for them) and the responsible
-- accountant an org ADMIN, writes the assignment row carrying the full
-- import resolution, and audits. Called once per created row, as the USER.
create or replace function import_firm_client(
  p_firm_id uuid,
  p_name text,
  p_cui text,
  p_industry_key text,
  p_industry_display_name text,
  p_caen_code text,
  p_responsible uuid,
  p_resolution jsonb
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated.' using errcode = '28000';
  end if;
  if not firm_can(p_firm_id, 'import') then
    raise exception 'Your firm role cannot bring clients in.' using errcode = '42501';
  end if;
  if exists (select 1 from firms where id = p_firm_id and archived_at is not null) then
    raise exception 'Firm is archived.' using errcode = 'P0001';
  end if;
  if coalesce(btrim(p_name), '') = '' or coalesce(btrim(p_cui), '') = '' then
    raise exception 'A client needs a name and a CUI.' using errcode = '22023';
  end if;
  if exists (select 1 from organizations where firm_id = p_firm_id and cui = p_cui) then
    raise exception 'Already a client of this firm.' using errcode = '23505';
  end if;
  if p_responsible is not null and not exists (
    select 1 from firm_memberships where firm_id = p_firm_id and user_id = p_responsible
  ) then
    raise exception 'Responsible accountant must be a member of the firm.' using errcode = '22023';
  end if;

  insert into organizations (name, cui, firm_id, industry_key, industry_display_name, caen_code)
  values (p_name, p_cui, p_firm_id, p_industry_key, p_industry_display_name, p_caen_code)
  returning id into v_org;

  insert into memberships (user_id, org_id, role) values (auth.uid(), v_org, 'owner');
  if p_responsible is not null and p_responsible <> auth.uid() then
    insert into memberships (user_id, org_id, role) values (p_responsible, v_org, 'admin');
  end if;

  insert into client_assignments (firm_id, org_id, responsible_user_id, collaborator_user_ids, import_resolution)
  values (p_firm_id, v_org, p_responsible, '{}'::uuid[], p_resolution);

  perform firm_audit(p_firm_id, 'client.import', jsonb_build_object(
    'org_id', v_org, 'cui', p_cui, 'name', p_name,
    'industry_status', p_resolution -> 'industry' ->> 'status',
    'responsible_status', p_resolution -> 'responsible' ->> 'status'));
  return v_org;
end;
$$;

-- Detach: the workspace owner may always leave; the firm's `manage` may
-- release a client. firm_id goes back to NULL and the workspace keeps
-- working solo — the assignment row is the only thing removed.
create or replace function detach_workspace_from_firm(p_org_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_firm uuid := firm_of_org(p_org_id);
  v_is_owner boolean;
begin
  if v_firm is null then
    raise exception 'Workspace is not attached to a firm.' using errcode = 'P0002';
  end if;
  v_is_owner := exists (
    select 1 from memberships
    where org_id = p_org_id and user_id = auth.uid() and role = 'owner'
  );
  if not v_is_owner and not firm_can(v_firm, 'manage') then
    raise exception 'Only the workspace owner or the firm''s manager can detach it.' using errcode = '42501';
  end if;

  update organizations set firm_id = null where id = p_org_id;
  delete from client_assignments where org_id = p_org_id;

  perform firm_audit(v_firm, 'client.detach', jsonb_build_object('org_id', p_org_id));
end;
$$;

-- Assign: one responsible accountant (must be a firm member, or NULL for
-- honest "unassigned") and optional collaborators (all firm members).
create or replace function assign_client(
  p_org_id uuid,
  p_responsible uuid,
  p_collaborators uuid[] default '{}'::uuid[]
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_firm uuid := firm_of_org(p_org_id);
  v_collab uuid;
begin
  if v_firm is null then
    raise exception 'Workspace is not a client of any firm.' using errcode = 'P0002';
  end if;
  if not firm_can(v_firm, 'assign') then
    raise exception 'Your firm role cannot assign clients.' using errcode = '42501';
  end if;
  if p_responsible is not null and not exists (
    select 1 from firm_memberships where firm_id = v_firm and user_id = p_responsible
  ) then
    raise exception 'Responsible accountant must be a member of the firm.' using errcode = '22023';
  end if;
  foreach v_collab in array coalesce(p_collaborators, '{}'::uuid[]) loop
    if not exists (
      select 1 from firm_memberships where firm_id = v_firm and user_id = v_collab
    ) then
      raise exception 'Every collaborator must be a member of the firm.' using errcode = '22023';
    end if;
  end loop;

  insert into client_assignments (firm_id, org_id, responsible_user_id, collaborator_user_ids)
  values (v_firm, p_org_id, p_responsible, coalesce(p_collaborators, '{}'::uuid[]))
  on conflict (org_id) do update
    set responsible_user_id = excluded.responsible_user_id,
        collaborator_user_ids = excluded.collaborator_user_ids;

  perform firm_audit(v_firm, 'client.assign', jsonb_build_object(
    'org_id', p_org_id, 'responsible', p_responsible,
    'collaborators', to_jsonb(coalesce(p_collaborators, '{}'::uuid[]))));
end;
$$;

-- Role change: `manage`, with a last-owner guard so a firm can never be
-- left without anyone who can manage it.
create or replace function set_firm_member_role(p_firm_id uuid, p_user_id uuid, p_role text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old text;
begin
  if not firm_can(p_firm_id, 'manage') then
    raise exception 'Your firm role cannot change roles.' using errcode = '42501';
  end if;
  if not exists (select 1 from firm_roles where role = p_role) then
    raise exception 'Unknown firm role.' using errcode = '22023';
  end if;
  select role into v_old from firm_memberships
   where firm_id = p_firm_id and user_id = p_user_id;
  if v_old is null then
    raise exception 'Not a member of this firm.' using errcode = 'P0002';
  end if;
  if v_old = 'owner' and p_role <> 'owner' and (
    select count(*) from firm_memberships where firm_id = p_firm_id and role = 'owner'
  ) <= 1 then
    raise exception 'Cannot demote the last owner.' using errcode = 'P0001';
  end if;

  update firm_memberships set role = p_role
   where firm_id = p_firm_id and user_id = p_user_id;

  perform firm_audit(p_firm_id, 'member.role', jsonb_build_object(
    'user_id', p_user_id, 'from', v_old, 'to', p_role));
end;
$$;

-- Remove (or leave: p_user_id = auth.uid()). Same last-owner guard.
-- Assignments naming the removed member are scrubbed so no client is
-- "responsible: someone who is no longer here".
create or replace function remove_firm_member(p_firm_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old text;
begin
  if p_user_id <> auth.uid() and not firm_can(p_firm_id, 'manage') then
    raise exception 'Your firm role cannot remove members.' using errcode = '42501';
  end if;
  select role into v_old from firm_memberships
   where firm_id = p_firm_id and user_id = p_user_id;
  if v_old is null then
    raise exception 'Not a member of this firm.' using errcode = 'P0002';
  end if;
  if v_old = 'owner' and (
    select count(*) from firm_memberships where firm_id = p_firm_id and role = 'owner'
  ) <= 1 then
    raise exception 'Cannot remove the last owner.' using errcode = 'P0001';
  end if;

  delete from firm_memberships where firm_id = p_firm_id and user_id = p_user_id;
  update client_assignments
     set responsible_user_id = null
   where firm_id = p_firm_id and responsible_user_id = p_user_id;
  update client_assignments
     set collaborator_user_ids = array_remove(collaborator_user_ids, p_user_id)
   where firm_id = p_firm_id and p_user_id = any (collaborator_user_ids);

  perform firm_audit(p_firm_id, 'member.remove', jsonb_build_object(
    'user_id', p_user_id, 'role', v_old, 'self', p_user_id = auth.uid()));
end;
$$;

-- Invite: `invite`; inviting an OWNER additionally needs `manage` (a
-- partner must not be able to mint owners). Expiry is clamped to 1 h .. 30 d.
create or replace function create_firm_invitation(
  p_firm_id uuid,
  p_email text,
  p_role text,
  p_ttl_hours int default 168
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(nullif(btrim(p_email), ''));
  v_ttl int := least(greatest(coalesce(p_ttl_hours, 168), 1), 720);
  v_id uuid;
begin
  if not firm_can(p_firm_id, 'invite') then
    raise exception 'Your firm role cannot invite.' using errcode = '42501';
  end if;
  if v_email is null or position('@' in v_email) = 0 then
    raise exception 'A valid e-mail is required.' using errcode = '22023';
  end if;
  if not exists (select 1 from firm_roles where role = p_role) then
    raise exception 'Unknown firm role.' using errcode = '22023';
  end if;
  if p_role = 'owner' and not firm_can(p_firm_id, 'manage') then
    raise exception 'Only a firm manager can invite an owner.' using errcode = '42501';
  end if;

  insert into firm_invitations (firm_id, email, role, invited_by, expires_at)
  values (p_firm_id, v_email, p_role, auth.uid(), now() + make_interval(hours => v_ttl))
  returning id into v_id;

  perform firm_audit(p_firm_id, 'invite.create', jsonb_build_object(
    'invitation_id', v_id, 'email', v_email, 'role', p_role, 'ttl_hours', v_ttl));
  return v_id;
end;
$$;

-- Accept: the token names the invitation; the CALLER'S JWT e-mail must
-- match the invited e-mail (an invitation is not a bearer link that any
-- signed-in account can redeem). Not expired, not revoked, not already
-- accepted. Upserts the membership at the invited role.
create or replace function accept_firm_invitation(p_token uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inv firm_invitations%rowtype;
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
begin
  if auth.uid() is null then
    raise exception 'Not authenticated.' using errcode = '28000';
  end if;
  select * into v_inv from firm_invitations where token = p_token;
  if v_inv.id is null then
    raise exception 'Invitation not found.' using errcode = 'P0002';
  end if;
  if v_inv.revoked_at is not null then
    raise exception 'Invitation was revoked.' using errcode = 'P0001';
  end if;
  if v_inv.accepted_at is not null then
    raise exception 'Invitation was already accepted.' using errcode = 'P0001';
  end if;
  if v_inv.expires_at < now() then
    raise exception 'Invitation has expired.' using errcode = 'P0001';
  end if;
  if v_email = '' or lower(v_inv.email) <> v_email then
    raise exception 'This invitation was sent to a different e-mail address.' using errcode = '42501';
  end if;

  insert into firm_memberships (firm_id, user_id, role)
  values (v_inv.firm_id, auth.uid(), v_inv.role)
  on conflict (firm_id, user_id) do update set role = excluded.role;

  update firm_invitations
     set accepted_at = now(), accepted_by = auth.uid()
   where id = v_inv.id;

  perform firm_audit(v_inv.firm_id, 'invite.accept', jsonb_build_object(
    'invitation_id', v_inv.id, 'role', v_inv.role));
  return v_inv.firm_id;
end;
$$;

create or replace function revoke_firm_invitation(p_invitation_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_firm uuid;
begin
  select firm_id into v_firm from firm_invitations where id = p_invitation_id;
  if v_firm is null then
    raise exception 'Invitation not found.' using errcode = 'P0002';
  end if;
  if not firm_can(v_firm, 'invite') then
    raise exception 'Your firm role cannot revoke invitations.' using errcode = '42501';
  end if;

  update firm_invitations set revoked_at = now()
   where id = p_invitation_id and revoked_at is null and accepted_at is null;

  perform firm_audit(v_firm, 'invite.revoke', jsonb_build_object('invitation_id', p_invitation_id));
end;
$$;

-- ─────────── 14. Grants ────────────────────────────────────────────────────
-- Postgres grants EXECUTE to PUBLIC by default; close that on every
-- SECURITY DEFINER function here (schema_phase_security_hardening.sql
-- pattern), then open exactly what signed-in clients need.

revoke execute on function is_firm_member_of(uuid)                          from public, anon;
revoke execute on function firm_role_of(uuid)                               from public, anon;
revoke execute on function firm_can(uuid, text)                             from public, anon;
revoke execute on function firm_of_org(uuid)                                from public, anon;
revoke execute on function can_read_client_org(uuid)                        from public, anon;
revoke all     on function firm_audit(uuid, text, jsonb)                    from public, anon, authenticated;
revoke execute on function create_firm(text)                                from public, anon;
revoke execute on function list_firms()                                     from public, anon;
revoke execute on function list_firm_members(uuid)                          from public, anon;
revoke execute on function list_firm_clients(uuid)                          from public, anon;
revoke execute on function attach_workspace_to_firm(uuid, uuid)             from public, anon;
revoke execute on function detach_workspace_from_firm(uuid)                 from public, anon;
revoke execute on function assign_client(uuid, uuid, uuid[])                from public, anon;
revoke execute on function set_firm_member_role(uuid, uuid, text)           from public, anon;
revoke execute on function remove_firm_member(uuid, uuid)                   from public, anon;
revoke execute on function create_firm_invitation(uuid, text, text, int)    from public, anon;
revoke execute on function accept_firm_invitation(uuid)                     from public, anon;
revoke execute on function revoke_firm_invitation(uuid)                     from public, anon;
revoke execute on function import_firm_client(uuid, text, text, text, text, text, uuid, jsonb) from public, anon;

grant execute on function is_firm_member_of(uuid)                           to authenticated;
grant execute on function firm_role_of(uuid)                                to authenticated;
grant execute on function firm_can(uuid, text)                              to authenticated;
grant execute on function firm_of_org(uuid)                                 to authenticated;
grant execute on function can_read_client_org(uuid)                         to authenticated;
grant execute on function create_firm(text)                                 to authenticated;
grant execute on function list_firms()                                      to authenticated;
grant execute on function list_firm_members(uuid)                           to authenticated;
grant execute on function list_firm_clients(uuid)                           to authenticated;
grant execute on function attach_workspace_to_firm(uuid, uuid)              to authenticated;
grant execute on function detach_workspace_from_firm(uuid)                  to authenticated;
grant execute on function assign_client(uuid, uuid, uuid[])                 to authenticated;
grant execute on function set_firm_member_role(uuid, uuid, text)            to authenticated;
grant execute on function remove_firm_member(uuid, uuid)                    to authenticated;
grant execute on function create_firm_invitation(uuid, text, text, int)     to authenticated;
grant execute on function accept_firm_invitation(uuid)                      to authenticated;
grant execute on function revoke_firm_invitation(uuid)                      to authenticated;
grant execute on function import_firm_client(uuid, text, text, text, text, text, uuid, jsonb) to authenticated;

-- The service role (backend) keeps its implicit access to everything, but
-- no firm-model write goes through it any more: the CSV importer creates
-- each client through import_firm_client() AS THE USER, so `firm_can(...,
-- 'import')` is the wall even if the Python guard above it were removed.

-- ─────────── 15. Table privileges — the Supabase default, narrowed ────────
-- Supabase's project default (`alter default privileges in schema public
-- grant all on tables to anon, authenticated, service_role`) gives every
-- table here TABLE-WIDE INSERT / UPDATE / DELETE to anon and
-- authenticated; RLS chooses rows, never columns (D1, 2026-09-05). Every
-- firm-model mutation goes through the RPCs above (SECURITY DEFINER —
-- they run as the owner and are untouched by these grants), so the API
-- roles need no write privilege on any table below. `firms` keeps UPDATE
-- on (name, archived_at) for the `manage` rename/archive policy — its
-- identity (id, created_by, created_at) is non-updatable. Postgres checks
-- these BEFORE row-level security; a table-level REVOKE also revokes the
-- column grants of the same privilege, so revoke-then-grant lands exactly
-- this set on every re-run. Idempotent.
revoke insert, update, delete on firms                   from anon, authenticated;
grant  update (name, archived_at) on firms               to authenticated;
revoke insert, update, delete on firm_roles              from anon, authenticated;
revoke insert, update, delete on firm_role_permissions   from anon, authenticated;
revoke insert, update, delete on firm_memberships        from anon, authenticated;
revoke insert, update, delete on client_assignments      from anon, authenticated;
revoke insert, update, delete on firm_invitations        from anon, authenticated;
revoke insert, update, delete on firm_audit_log          from anon, authenticated;
revoke insert, update, delete on firm_invite_email_queue from anon, authenticated;

-- F3.24 schema-migration discipline: optimistic PostgREST reload. The
-- Dashboard "Reload schema cache" click in the runbook is the
-- deterministic step.
NOTIFY pgrst, 'reload schema';
