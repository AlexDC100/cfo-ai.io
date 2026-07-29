-- Multi-workspace — one workspace per company (SRL), fully data-isolated.
--
-- Until now a "workspace" was a name in the browser's localStorage. Every data
-- table is keyed by `org_id` and already enforces `is_member_of(org_id)` RLS,
-- but each user had exactly ONE membership and every reader resolved it with
-- `memberships … limit 1`, so switching "workspace" changed a label and nothing
-- else. This migration makes workspace == organization, so a user can hold
-- several memberships and the existing RLS becomes the isolation boundary.
--
-- Nothing here adds a `workspace_id` column or rewrites a policy on the ~20
-- org-scoped tables: they are already correct. What changes is (a) the ability
-- to create/archive an organization from the client, (b) a durable record of
-- which one is active, and (c) removal of the single-org defaults.
--
-- The legacy `workspaces` table (schema.sql:148) stays dead and unread.
--
-- ── OPERATOR RUNBOOK (locked discipline — §14 / F3.24) ────────────────
-- 0. PRE-FLIGHT, before running anything below. Step 1 drops the
--    `default auth.uid()` on org_id. Any row whose org_id is a user id
--    rather than a real organization is a pre-existing phantom — find it
--    first, because it will become invisible once the app resolves a real
--    active org:
--
--      select 'documents' t, count(*) from documents
--        where org_id not in (select id from organizations)
--      union all select 'financial_periods', count(*) from financial_periods
--        where org_id not in (select id from organizations)
--      union all select 'alerts', count(*) from alerts
--        where org_id not in (select id from organizations)
--      union all select 'activity', count(*) from activity
--        where org_id not in (select id from organizations)
--      union all select 'datasets', count(*) from datasets
--        where org_id not in (select id from organizations)
--      union all select 'alert_states', count(*) from alert_states
--        where org_id not in (select id from organizations)
--      union all select 'recommendations', count(*) from recommendations
--        where org_id not in (select id from organizations)
--      union all select 'invoices', count(*) from invoices
--        where org_id not in (select id from organizations)
--      union all select 'coa_mappings', count(*) from coa_mappings
--        where org_id not in (select id from organizations);
--
--    All zeros → proceed. Non-zero → reconcile those rows onto the owner's
--    real org id first (they are reachable today only via the legacy
--    `auth.uid() = org_id` policies).
-- 1. Run this SQL in Supabase Studio (includes the NOTIFY at the bottom).
-- 2. IMMEDIATELY click Supabase Dashboard → Settings → API →
--    "Reload schema cache". The NOTIFY is optimistic on Supabase managed
--    infra; the Dashboard click is the deterministic step.
-- 3. Verify PostgREST sees the new surface — these must NOT 400:
--      select user_id, active_org_id from user_prefs limit 1;
--      select id, archived_at, purge_after from organizations limit 1;
--    If they stay invisible, this is the F3.25 Bug #4 persistent-cache case:
--    stop, do not deploy the frontend, open a Supabase ticket.
-- ─────────────────────────────────────────────────────────────────────

-- ─────────── 1. Drop the single-org default ────────────────────────────────
-- `org_id uuid not null default auth.uid()` dates from when "each user is
-- their own org" (schema.sql:6-7). Under multi-org an insert that omits
-- org_id would land in an organization that does not exist. Every insert
-- path in the app passes org_id explicitly, so removing the default turns a
-- silent mis-file into a loud not-null violation.

alter table alert_states     alter column org_id drop default;
alter table recommendations  alter column org_id drop default;
alter table datasets         alter column org_id drop default;
alter table activity         alter column org_id drop default;
alter table documents        alter column org_id drop default;
alter table alerts           alter column org_id drop default;
alter table invoices         alter column org_id drop default;
alter table financial_periods alter column org_id drop default;
alter table coa_mappings     alter column org_id drop default;

do $$
begin
  if to_regclass('public.benchmark_peers') is not null then
    alter table benchmark_peers alter column org_id drop default;
  end if;
end$$;

-- ─────────── 2. Soft-delete columns on organizations ───────────────────────
-- Archiving hides a workspace and schedules it for permanent deletion 30 days
-- later. Data is left untouched so restore is a column reset, not a rebuild.

alter table organizations add column if not exists archived_at timestamptz;
alter table organizations add column if not exists purge_after timestamptz;

create index if not exists organizations_purge_after_idx
  on organizations (purge_after)
  where purge_after is not null;

-- ─────────── 3. Active workspace + personal preferences ────────────────────
-- `active_org_id` is what makes the open workspace follow the user to another
-- device. `prefs` is the jsonb bag for personal (not company) settings —
-- theme, language, learning mode. Company-level settings live per-org.

create table if not exists user_prefs (
  user_id       uuid primary key references auth.users(id) on delete cascade,
  active_org_id uuid references organizations(id) on delete set null,
  prefs         jsonb not null default '{}'::jsonb,
  updated_at    timestamptz not null default now()
);

alter table user_prefs enable row level security;

drop policy if exists "user_prefs own select" on user_prefs;
drop policy if exists "user_prefs own insert" on user_prefs;
drop policy if exists "user_prefs own update" on user_prefs;

create policy "user_prefs own select"
  on user_prefs for select using (user_id = auth.uid());
create policy "user_prefs own insert"
  on user_prefs for insert with check (user_id = auth.uid());
create policy "user_prefs own update"
  on user_prefs for update using (user_id = auth.uid()) with check (user_id = auth.uid());

drop trigger if exists user_prefs_set_updated_at on user_prefs;
create trigger user_prefs_set_updated_at
  before update on user_prefs
  for each row execute function set_updated_at_now();

-- ─────────── 4. Workspace RPCs ─────────────────────────────────────────────
-- There is deliberately NO client INSERT policy on organizations or
-- memberships (schema_phase3.sql:159-200), so creating a workspace has to go
-- through SECURITY DEFINER functions.
--
-- IMPORTANT: none of these may put a self-referencing `exists (select …
-- from memberships …)` inside a POLICY on memberships — that caused
-- "42P17 infinite recursion" and broke every org lookup (see the warning at
-- schema_phase3.sql:193-200). Reading memberships inside a SECURITY DEFINER
-- *function*, as below, is the prescribed workaround and is safe.

-- Every workspace the caller belongs to, including archived ones (the UI
-- needs them to render the restore list).
create or replace function list_workspaces()
returns table (
  id uuid,
  name text,
  industry_key text,
  industry_display_name text,
  default_currency text,
  role text,
  archived_at timestamptz,
  purge_after timestamptz,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select o.id, o.name, o.industry_key, o.industry_display_name,
         o.default_currency, m.role, o.archived_at, o.purge_after, o.created_at
  from memberships m
  join organizations o on o.id = m.org_id
  where m.user_id = auth.uid()
  order by o.created_at asc;
$$;

-- Create a workspace and make the caller its owner.
create or replace function create_workspace(
  p_name text,
  p_industry_key text default null,
  p_industry_display text default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid;
  v_name text := nullif(btrim(p_name), '');
begin
  if auth.uid() is null then
    raise exception 'Not authenticated.' using errcode = '28000';
  end if;
  if v_name is null then
    raise exception 'Workspace name is required.' using errcode = '22023';
  end if;

  insert into organizations (name, industry_key, industry_display_name)
  values (v_name, p_industry_key, p_industry_display)
  returning id into v_org_id;

  insert into memberships (user_id, org_id, role)
  values (auth.uid(), v_org_id, 'owner');

  return v_org_id;
end;
$$;

-- Soft-delete: hide the workspace and schedule permanent deletion in 30 days.
create or replace function archive_workspace(p_org_id uuid)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  v_purge_after timestamptz;
begin
  if not exists (
    select 1 from memberships
    where org_id = p_org_id and user_id = auth.uid() and role = 'owner'
  ) then
    raise exception 'Only a workspace owner can archive it.' using errcode = '42501';
  end if;

  -- Refuse to leave the user with nothing to switch to.
  if (
    select count(*) from memberships m
    join organizations o on o.id = m.org_id
    where m.user_id = auth.uid() and o.archived_at is null
  ) <= 1 then
    raise exception 'Cannot archive your only workspace.' using errcode = 'P0001';
  end if;

  v_purge_after := now() + interval '30 days';
  update organizations
     set archived_at = now(), purge_after = v_purge_after
   where id = p_org_id;

  -- Anyone sitting in this workspace gets bounced to another on next load.
  update user_prefs set active_org_id = null where active_org_id = p_org_id;

  return v_purge_after;
end;
$$;

create or replace function restore_workspace(p_org_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from memberships
    where org_id = p_org_id and user_id = auth.uid() and role = 'owner'
  ) then
    raise exception 'Only a workspace owner can restore it.' using errcode = '42501';
  end if;

  update organizations
     set archived_at = null, purge_after = null
   where id = p_org_id;
end;
$$;

-- Permanent deletion of workspaces past their 30-day window.
--
-- This CANNOT be a plain `delete from organizations` — most org_id columns
-- carry NO foreign key to organizations (they predate the orgs table, back
-- when org_id defaulted to auth.uid()), so a cascade would silently orphan
-- every document, period and alert instead of removing them. Only
-- memberships, org_coa_mappings_overrides, benchmark_reports and the
-- calibration tables have a real FK.
--
-- So we delete the org-scoped ROOTS explicitly; their children follow via the
-- FKs that do exist (statement_line_items / calculated_metrics / briefings /
-- benchmark_reports cascade from financial_periods; sku_analyses and invoices
-- cascade from documents). `to_regclass` guards keep this safe on projects
-- where a later migration hasn't been applied.
create or replace function purge_expired_workspaces()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org record;
  v_table text;
  v_count int := 0;
  v_tables text[] := array[
    'billing_events', 'benchmark_peers', 'coa_mappings', 'datasets',
    'activity', 'recommendations', 'alert_states', 'alerts',
    'sku_analyses', 'calculated_metrics', 'briefings',
    'invoices', 'financial_periods', 'documents',
    -- chat_messages cascades from chat_threads (schema_phase_chat.sql).
    'chat_threads'
  ];
begin
  for v_org in
    select id from organizations
    where purge_after is not null and purge_after < now()
  loop
    foreach v_table in array v_tables loop
      if to_regclass('public.' || v_table) is not null then
        execute format('delete from public.%I where org_id = $1', v_table)
          using v_org.id;
      end if;
    end loop;

    -- Uploaded files are stored under {org_id}/uploads/{document_id}.{ext}
    delete from storage.objects
     where bucket_id = 'documents'
       and (storage.foldername(name))[1] = v_org.id::text;

    -- memberships + the FK-bearing tables cascade from here.
    delete from organizations where id = v_org.id;
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

-- ─────────── 5. Grants ─────────────────────────────────────────────────────
-- Signed-in users may list / create / archive / restore. Purging is
-- destructive and service-role only — it is driven by the scheduler endpoint
-- POST /api/workspaces/cron/purge-expired, never by a browser.

grant execute on function list_workspaces()                        to authenticated;
grant execute on function create_workspace(text, text, text)       to authenticated;
grant execute on function archive_workspace(uuid)                  to authenticated;
grant execute on function restore_workspace(uuid)                  to authenticated;

revoke all on function purge_expired_workspaces() from public, anon, authenticated;
grant execute on function purge_expired_workspaces() to service_role;

-- F3.24 schema-migration discipline: optimistic PostgREST reload.
NOTIFY pgrst, 'reload schema';
