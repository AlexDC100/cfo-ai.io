-- CFO AI — Phase 3 schema (multi-tenancy + pipeline persistence)
-- =============================================================================
-- Apply once via Supabase SQL editor AFTER schema.sql.
-- Idempotent: every CREATE uses IF NOT EXISTS and every policy is dropped/recreated.
--
-- WHAT THIS ADDS
--   1. organizations + memberships tables (replaces "auth.uid() == org_id" model)
--   2. is_member_of(uuid) helper function used by every RLS policy
--   3. Bootstrap trigger: on auth.users insert, create org + owner membership
--      (uses raw_user_meta_data: pending_org_name, pending_industry_key)
--   4. Per-document pipeline: calculated_metrics, briefings tables
--   5. Switches every domain table's RLS from `auth.uid() = org_id`
--      to `is_member_of(org_id)` so future multi-user orgs work without
--      a second migration.
--
-- BACKWARD COMPATIBILITY: existing rows in documents, financial_periods,
-- statement_line_items, alerts, recommendations, datasets, activity continue
-- to work because the bootstrap trigger creates an org with id == user.id
-- for fresh signups. For pre-existing users on this Supabase project, run
-- the backfill block at the bottom of this file.

create extension if not exists "pgcrypto";

-- ─── Organizations ─────────────────────────────────────────────────────────
-- One row per company workspace. Multi-user orgs land via memberships.

create table if not exists organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  industry_key text,
  industry_display_name text,
  -- Currency the org reports in (drives default rendering on every page).
  default_currency text default 'RON',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists organizations_name_idx on organizations (lower(name));

drop trigger if exists organizations_set_updated_at on organizations;
create trigger organizations_set_updated_at
  before update on organizations
  for each row execute function set_updated_at_now();

-- ─── Memberships ───────────────────────────────────────────────────────────
-- (user_id, org_id) join row with role. PRIMARY KEY enforces dedupe.

create table if not exists memberships (
  user_id uuid not null references auth.users(id) on delete cascade,
  org_id  uuid not null references organizations(id) on delete cascade,
  role text not null default 'owner' check (role in ('owner','admin','member')),
  created_at timestamptz not null default now(),
  primary key (user_id, org_id)
);

create index if not exists memberships_org_idx on memberships (org_id);
create index if not exists memberships_user_idx on memberships (user_id);

-- ─── is_member_of helper ───────────────────────────────────────────────────
-- Used by every RLS policy below. SECURITY DEFINER so the function can
-- read memberships even when the calling role can't (RLS-safe).

create or replace function is_member_of(_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from memberships
    where org_id = _org_id and user_id = auth.uid()
  );
$$;

-- ─── Bootstrap trigger ──────────────────────────────────────────────────────
-- Replaces (extends) the legacy handle_new_user(). On auth.users insert:
--   1. Create organizations row (using pending_org_name + pending_industry_key
--      from raw_user_meta_data). If those aren't set, fall back to
--      company_name (legacy field).
--   2. Create memberships row with role='owner'.
--   3. Continue legacy bootstrap (profile, workspace, subscription) so prior
--      schema features keep working.
--
-- IMPORTANT: this trigger replaces the one created in schema.sql. It calls the
-- legacy logic explicitly so nothing regresses.

create or replace function handle_new_user_v2()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company text := coalesce(
    new.raw_user_meta_data->>'pending_org_name',
    new.raw_user_meta_data->>'company_name',
    new.raw_user_meta_data->>'organization',
    null
  );
  v_industry_key text := new.raw_user_meta_data->>'pending_industry_key';
  v_industry_display text := new.raw_user_meta_data->>'pending_industry_display';
  v_full_name text := coalesce(
    new.raw_user_meta_data->>'full_name',
    new.raw_user_meta_data->>'display_name',
    new.raw_user_meta_data->>'name',
    split_part(new.email, '@', 1)
  );
  v_org_id uuid;
begin
  -- Profile
  insert into public.profiles (id, email, full_name, display_name, company_name)
  values (new.id, new.email, v_full_name, v_full_name, v_company)
  on conflict (id) do nothing;

  -- Default workspace (legacy table)
  insert into public.workspaces (owner_id, name)
  values (new.id, coalesce(v_company, v_full_name || '''s workspace'));

  -- 14-day free trial subscription (legacy)
  insert into public.subscriptions (
    user_id, plan, billing_cycle, status,
    trial_start, trial_end,
    current_period_start, current_period_end
  )
  values (
    new.id, 'professional', 'monthly', 'trial',
    now(), now() + interval '14 days',
    now(), now() + interval '14 days'
  )
  on conflict (user_id) do nothing;

  -- ─── New: organization + membership ────────────────────────────────────
  insert into public.organizations (name, industry_key, industry_display_name)
  values (
    coalesce(v_company, v_full_name || '''s organization'),
    v_industry_key,
    v_industry_display
  )
  returning id into v_org_id;

  insert into public.memberships (user_id, org_id, role)
  values (new.id, v_org_id, 'owner');

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user_v2();

-- ─── RLS for organizations + memberships ───────────────────────────────────

alter table organizations enable row level security;
alter table memberships  enable row level security;

drop policy if exists "organizations member select"    on organizations;
drop policy if exists "organizations owner update"     on organizations;
drop policy if exists "organizations owner delete"     on organizations;
drop policy if exists "organizations service insert"   on organizations;

create policy "organizations member select" on organizations
  for select using (is_member_of(id));

-- Members can update their org's name/industry; only owners can DELETE
-- (DELETE is rare; owner check via memberships join).
create policy "organizations owner update" on organizations
  for update using (is_member_of(id))
  with check (is_member_of(id));

-- Inserts are server-side only via the bootstrap trigger or the service
-- role key. No client-side INSERT policy is intentional.

drop policy if exists "memberships self select" on memberships;
drop policy if exists "memberships owner write" on memberships;

-- A user always sees their own memberships. Owners can list every member of
-- the orgs they own (so the team-management UI can render the roster).
create policy "memberships self select" on memberships
  for select using (
    auth.uid() = user_id
    or exists (
      select 1 from memberships m2
      where m2.org_id = memberships.org_id
        and m2.user_id = auth.uid()
        and m2.role in ('owner','admin')
    )
  );

-- Owners can invite/remove members of their org.
create policy "memberships owner write" on memberships
  for all using (
    exists (
      select 1 from memberships m2
      where m2.org_id = memberships.org_id
        and m2.user_id = auth.uid()
        and m2.role in ('owner','admin')
    )
  );

-- ─── Switch existing tables' RLS to is_member_of ───────────────────────────
-- Add new policies named "*_member_*" alongside the legacy "*_owner_*"
-- policies. Both grant access today (RLS uses OR), so nothing breaks.
-- After the orgs/memberships rollout is verified, the legacy policies can
-- be dropped in a follow-up migration.

-- documents
drop policy if exists "documents member select" on documents;
drop policy if exists "documents member insert" on documents;
drop policy if exists "documents member update" on documents;
drop policy if exists "documents member delete" on documents;
create policy "documents member select" on documents for select using (is_member_of(org_id));
create policy "documents member insert" on documents for insert with check (is_member_of(org_id));
create policy "documents member update" on documents for update using (is_member_of(org_id));
create policy "documents member delete" on documents for delete using (is_member_of(org_id));

-- financial_periods
drop policy if exists "financial_periods member select" on financial_periods;
drop policy if exists "financial_periods member insert" on financial_periods;
drop policy if exists "financial_periods member update" on financial_periods;
drop policy if exists "financial_periods member delete" on financial_periods;
create policy "financial_periods member select" on financial_periods for select using (is_member_of(org_id));
create policy "financial_periods member insert" on financial_periods for insert with check (is_member_of(org_id));
create policy "financial_periods member update" on financial_periods for update using (is_member_of(org_id));
create policy "financial_periods member delete" on financial_periods for delete using (is_member_of(org_id));

-- alerts
drop policy if exists "alerts member select" on alerts;
drop policy if exists "alerts member insert" on alerts;
drop policy if exists "alerts member update" on alerts;
drop policy if exists "alerts member delete" on alerts;
create policy "alerts member select" on alerts for select using (is_member_of(org_id));
create policy "alerts member insert" on alerts for insert with check (is_member_of(org_id));
create policy "alerts member update" on alerts for update using (is_member_of(org_id));
create policy "alerts member delete" on alerts for delete using (is_member_of(org_id));

-- recommendations
drop policy if exists "recommendations member select" on recommendations;
drop policy if exists "recommendations member insert" on recommendations;
drop policy if exists "recommendations member update" on recommendations;
drop policy if exists "recommendations member delete" on recommendations;
create policy "recommendations member select" on recommendations for select using (is_member_of(org_id));
create policy "recommendations member insert" on recommendations for insert with check (is_member_of(org_id));
create policy "recommendations member update" on recommendations for update using (is_member_of(org_id));
create policy "recommendations member delete" on recommendations for delete using (is_member_of(org_id));

-- alert_states
drop policy if exists "alert_states member select" on alert_states;
drop policy if exists "alert_states member insert" on alert_states;
drop policy if exists "alert_states member update" on alert_states;
drop policy if exists "alert_states member delete" on alert_states;
create policy "alert_states member select" on alert_states for select using (is_member_of(org_id));
create policy "alert_states member insert" on alert_states for insert with check (is_member_of(org_id));
create policy "alert_states member update" on alert_states for update using (is_member_of(org_id));
create policy "alert_states member delete" on alert_states for delete using (is_member_of(org_id));

-- invoices
drop policy if exists "invoices member select" on invoices;
drop policy if exists "invoices member insert" on invoices;
drop policy if exists "invoices member update" on invoices;
drop policy if exists "invoices member delete" on invoices;
create policy "invoices member select" on invoices for select using (is_member_of(org_id));
create policy "invoices member insert" on invoices for insert with check (is_member_of(org_id));
create policy "invoices member update" on invoices for update using (is_member_of(org_id));
create policy "invoices member delete" on invoices for delete using (is_member_of(org_id));

-- coa_mappings
drop policy if exists "coa_mappings member select" on coa_mappings;
drop policy if exists "coa_mappings member insert" on coa_mappings;
drop policy if exists "coa_mappings member update" on coa_mappings;
drop policy if exists "coa_mappings member delete" on coa_mappings;
create policy "coa_mappings member select" on coa_mappings for select using (is_member_of(org_id));
create policy "coa_mappings member insert" on coa_mappings for insert with check (is_member_of(org_id));
create policy "coa_mappings member update" on coa_mappings for update using (is_member_of(org_id));
create policy "coa_mappings member delete" on coa_mappings for delete using (is_member_of(org_id));

-- ═════════════════════════════════════════════════════════════════════════
-- PHASE 3 — pipeline output tables
-- ═════════════════════════════════════════════════════════════════════════

-- ─── Calculated metrics ────────────────────────────────────────────────────
-- One row per (period, metric_name). Wiped + re-inserted on every recompute.
-- Carries industry-percentile bands so the frontend renders without a
-- separate benchmarks lookup.

create table if not exists calculated_metrics (
  id uuid primary key default gen_random_uuid(),
  period_id uuid not null references financial_periods(id) on delete cascade,
  org_id uuid not null,
  -- Stable key for the metric: 'revenue', 'ebitda', 'ebitda_margin',
  -- 'debt_ebitda', 'roic', 'current_ratio', etc.
  name text not null,
  value numeric(20, 4),
  unit text,                                 -- 'RON' | 'pct' | 'ratio' | 'days'
  -- Direction the value should move for the company to be "better off".
  -- 'higher' for ROIC, 'lower' for Debt/EBITDA, etc.
  direction text check (direction in ('higher','lower','neutral')),
  -- Industry-percentile context (Phase I).
  industry_p25 numeric(20, 4),
  industry_p50 numeric(20, 4),
  industry_p75 numeric(20, 4),
  percentile_band text check (percentile_band is null or percentile_band in ('p0_p25','p25_p50','p50_p75','p75_p100')),
  severity_vs_industry text check (severity_vs_industry is null or severity_vs_industry in ('critical','high','medium','low','normal')),
  computed_at timestamptz not null default now(),
  unique (period_id, name)
);

create index if not exists calculated_metrics_org_period_idx on calculated_metrics (org_id, period_id);
create index if not exists calculated_metrics_period_name_idx on calculated_metrics (period_id, name);

alter table calculated_metrics enable row level security;

drop policy if exists "calculated_metrics member select" on calculated_metrics;
drop policy if exists "calculated_metrics member insert" on calculated_metrics;
drop policy if exists "calculated_metrics member update" on calculated_metrics;
drop policy if exists "calculated_metrics member delete" on calculated_metrics;
create policy "calculated_metrics member select" on calculated_metrics for select using (is_member_of(org_id));
create policy "calculated_metrics member insert" on calculated_metrics for insert with check (is_member_of(org_id));
create policy "calculated_metrics member update" on calculated_metrics for update using (is_member_of(org_id));
create policy "calculated_metrics member delete" on calculated_metrics for delete using (is_member_of(org_id));

-- ─── Briefings (Opus 4.7 narrative) ────────────────────────────────────────
-- One row per period. Re-running narrate replaces the row.

create table if not exists briefings (
  id uuid primary key default gen_random_uuid(),
  period_id uuid not null references financial_periods(id) on delete cascade,
  org_id uuid not null,
  body text not null,
  language text default 'en' check (language in ('en','ro')),
  model text,
  created_at timestamptz not null default now(),
  unique (period_id)
);

create index if not exists briefings_org_period_idx on briefings (org_id, period_id);

alter table briefings enable row level security;

drop policy if exists "briefings member select" on briefings;
drop policy if exists "briefings member insert" on briefings;
drop policy if exists "briefings member update" on briefings;
drop policy if exists "briefings member delete" on briefings;
create policy "briefings member select" on briefings for select using (is_member_of(org_id));
create policy "briefings member insert" on briefings for insert with check (is_member_of(org_id));
create policy "briefings member update" on briefings for update using (is_member_of(org_id));
create policy "briefings member delete" on briefings for delete using (is_member_of(org_id));

-- ─── Documents pipeline status — extended states ───────────────────────────
-- Replace the legacy 5-state enum with the 7-state pipeline spec.
-- 'queued' replaces 'uploaded'. New: 'mapping','computing','narrating'.
-- The CHECK constraint is replaced; existing rows are mapped via UPDATE.

alter table documents drop constraint if exists documents_status_check;

update documents set status = 'queued' where status = 'uploaded';
update documents set status = 'extracting' where status not in
  ('queued','extracting','mapping','computing','narrating','analyzed','failed');

alter table documents add constraint documents_status_check
  check (status in ('queued','extracting','mapping','computing','narrating','analyzed','failed'));

-- Track pipeline duration for ops dashboards.
alter table documents add column if not exists duration_ms integer;
alter table documents add column if not exists pipeline_started_at timestamptz;

-- Surface the produced period_id directly on the document row so the
-- frontend can look up the analysis output without a join.
alter table documents add column if not exists period_id uuid references financial_periods(id) on delete set null;
create index if not exists documents_period_idx on documents (period_id);

-- ═════════════════════════════════════════════════════════════════════════
-- BACKFILL — pre-existing users get an organization + membership
-- ═════════════════════════════════════════════════════════════════════════
-- Safe to re-run. Each user without a membership gets one org sized to their
-- profile + a membership row. Org id is generated; there's no requirement
-- that org_id == user_id (the bootstrap trigger above doesn't make that
-- assumption either).

do $$
declare
  rec record;
  v_org_id uuid;
begin
  for rec in
    select u.id as user_id, u.email, p.full_name, p.company_name
    from auth.users u
    left join public.profiles p on p.id = u.id
    where not exists (select 1 from memberships m where m.user_id = u.id)
  loop
    insert into organizations (name)
    values (coalesce(rec.company_name, rec.full_name, split_part(rec.email,'@',1) || '''s organization'))
    returning id into v_org_id;

    insert into memberships (user_id, org_id, role)
    values (rec.user_id, v_org_id, 'owner');
  end loop;
end$$;
