-- CFO AI — Supabase schema (auth-scoped)
-- =============================================================================
-- Apply once via the Supabase SQL editor (or `supabase db push`). Re-running
-- is safe — every CREATE uses IF NOT EXISTS, and policies are dropped/recreated.
--
-- Auth model: each authenticated user is their own org. `org_id` defaults to
-- auth.uid() on insert and every row-level policy enforces auth.uid() = org_id.
-- To support multi-user workspaces later, introduce an `org_members` table
-- and rewrite the policies to join through it.

create extension if not exists "pgcrypto";

-- ─────────── Alert states ───────────────────────────────────────────────────
-- One row per (org, alert_id). The Alert object itself is recomputed
-- deterministically by the engine on every run, so we only persist the
-- *user's* state on top: acknowledged, dismissed, assigned, etc.

create table if not exists alert_states (
  alert_id text not null,
  org_id uuid not null default auth.uid(),
  status text not null default 'new'
    check (status in ('new','acknowledged','assigned','in_progress','resolved','dismissed')),
  owner text,
  notes text,
  acknowledged_at timestamptz,
  resolved_at timestamptz,
  updated_by text,
  updated_at timestamptz not null default now(),
  primary key (org_id, alert_id)
);

create index if not exists alert_states_org_status_idx
  on alert_states (org_id, status, updated_at desc);

create or replace function set_updated_at_now()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists alert_states_set_updated_at on alert_states;
create trigger alert_states_set_updated_at
  before update on alert_states
  for each row execute function set_updated_at_now();

-- ─────────── Recommendations queue ──────────────────────────────────────────
-- Long-lived action items distinct from alerts: an alert is a deviation
-- detection, a recommendation is the operator's commitment to do something
-- about it. Owned, scheduled, persisted across runs.

create table if not exists recommendations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default auth.uid(),
  source_alert_id text,
  target_type text not null check (target_type in ('sku','category','customer','supplier','channel','dataset')),
  target_id text not null,
  title text not null,
  explanation text,
  bucket text check (bucket in ('PROTECT','WATCH','FIX','REDUCE','LIQUIDATE','SCALE')),
  action_type text,
  expected_cash_impact_kron numeric,
  expected_margin_impact_pct numeric,
  urgency text default 'medium' check (urgency in ('low','medium','high','critical')),
  status text default 'new'
    check (status in ('new','in_review','approved','assigned','done','rejected','archived')),
  owner text,
  due_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz
);

create index if not exists recommendations_org_status_idx
  on recommendations (org_id, status, updated_at desc);

drop trigger if exists recommendations_set_updated_at on recommendations;
create trigger recommendations_set_updated_at
  before update on recommendations
  for each row execute function set_updated_at_now();

-- ─────────── Datasets ───────────────────────────────────────────────────────
-- Metadata for each uploaded workbook so the operator can see history.

create table if not exists datasets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default auth.uid(),
  file_name text,
  row_count integer,
  period text,
  uploaded_by text,
  uploaded_at timestamptz not null default now(),
  metadata jsonb
);

create index if not exists datasets_org_uploaded_idx
  on datasets (org_id, uploaded_at desc);

-- ─────────── Activity log ──────────────────────────────────────────────────
-- Audit-style stream of state changes — useful for showing "what happened
-- today" on the dashboard without scanning multiple tables.

create table if not exists activity (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default auth.uid(),
  actor text,
  kind text not null,
  target_type text,
  target_id text,
  payload jsonb,
  created_at timestamptz not null default now()
);

create index if not exists activity_org_created_idx
  on activity (org_id, created_at desc);

-- ─────────── Profiles ───────────────────────────────────────────────────────
-- Mirror of auth.users with the human-friendly fields the UI needs (display
-- name, avatar, role). Created on first sign-in via the trigger below.

create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  full_name text,
  display_name text,
  company_name text,
  role text default 'owner',
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Backwards-compat: re-running the schema on a project where profiles
-- already existed without these columns adds them.
alter table profiles add column if not exists full_name text;
alter table profiles add column if not exists company_name text;

drop trigger if exists profiles_set_updated_at on profiles;
create trigger profiles_set_updated_at
  before update on profiles
  for each row execute function set_updated_at_now();

-- ─────────── Workspaces ────────────────────────────────────────────────────
-- One row per company workspace. Today every user is the sole owner of one
-- workspace; a future workspace_members table will allow multi-user access.

create table if not exists workspaces (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null default 'My workspace',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists workspaces_owner_idx on workspaces (owner_id);

drop trigger if exists workspaces_set_updated_at on workspaces;
create trigger workspaces_set_updated_at
  before update on workspaces
  for each row execute function set_updated_at_now();

-- ─────────── Subscriptions ─────────────────────────────────────────────────
-- One active subscription per user. Status flow:
--   trial      → 14-day free trial seeded on signup
--   active     → paid, in good standing
--   past_due   → payment failed, grace period
--   canceled   → cancel_at_period_end honoured
--   incomplete → checkout started but not finished

create table if not exists subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  plan text not null default 'professional'
    check (plan in ('starter','professional','enterprise')),
  billing_cycle text not null default 'monthly'
    check (billing_cycle in ('monthly','yearly')),
  status text not null default 'trial'
    check (status in ('trial','active','past_due','canceled','incomplete')),
  trial_start timestamptz,
  trial_end timestamptz,
  current_period_start timestamptz,
  current_period_end timestamptz,
  stripe_customer_id text,
  stripe_subscription_id text,
  cancel_at_period_end boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists subscriptions_user_idx on subscriptions (user_id);
create index if not exists subscriptions_status_idx on subscriptions (status);

drop trigger if exists subscriptions_set_updated_at on subscriptions;
create trigger subscriptions_set_updated_at
  before update on subscriptions
  for each row execute function set_updated_at_now();

-- ─────────── Onboarding trigger ────────────────────────────────────────────
-- When a new auth.users row lands, seed everything the app expects:
--   1. profile row mirroring the user
--   2. default workspace named after the company (or 'My workspace')
--   3. 14-day free trial subscription on the Professional plan
-- Runs as security definer so the trigger has the perms to insert into
-- locked-down tables.

create or replace function handle_new_user()
returns trigger language plpgsql security definer as $$
declare
  v_company text := coalesce(
    new.raw_user_meta_data->>'company_name',
    new.raw_user_meta_data->>'organization',
    null
  );
  v_full_name text := coalesce(
    new.raw_user_meta_data->>'full_name',
    new.raw_user_meta_data->>'display_name',
    new.raw_user_meta_data->>'name',
    split_part(new.email, '@', 1)
  );
begin
  -- Profile
  insert into public.profiles (id, email, full_name, display_name, company_name)
  values (new.id, new.email, v_full_name, v_full_name, v_company)
  on conflict (id) do nothing;

  -- Default workspace
  insert into public.workspaces (owner_id, name)
  values (new.id, coalesce(v_company, v_full_name || '''s workspace'));

  -- 14-day free trial subscription on the Professional plan
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

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ─────────── Row-level security ────────────────────────────────────────────
-- Each user only sees / writes their own org. Drop legacy anon policies if
-- they exist (re-running the schema after the open-demo version).

alter table alert_states     enable row level security;
alter table recommendations  enable row level security;
alter table datasets         enable row level security;
alter table activity         enable row level security;
alter table profiles         enable row level security;
alter table workspaces       enable row level security;
alter table subscriptions    enable row level security;

drop policy if exists "anon read alert_states"      on alert_states;
drop policy if exists "anon write alert_states"     on alert_states;
drop policy if exists "anon update alert_states"    on alert_states;
drop policy if exists "anon read recommendations"   on recommendations;
drop policy if exists "anon write recommendations"  on recommendations;
drop policy if exists "anon update recommendations" on recommendations;
drop policy if exists "anon read datasets"          on datasets;
drop policy if exists "anon write datasets"         on datasets;
drop policy if exists "anon read activity"          on activity;
drop policy if exists "anon write activity"         on activity;

-- alert_states
drop policy if exists "alert_states owner select" on alert_states;
drop policy if exists "alert_states owner insert" on alert_states;
drop policy if exists "alert_states owner update" on alert_states;
drop policy if exists "alert_states owner delete" on alert_states;
create policy "alert_states owner select" on alert_states for select using (auth.uid() = org_id);
create policy "alert_states owner insert" on alert_states for insert with check (auth.uid() = org_id);
create policy "alert_states owner update" on alert_states for update using (auth.uid() = org_id);
create policy "alert_states owner delete" on alert_states for delete using (auth.uid() = org_id);

-- recommendations
drop policy if exists "recommendations owner select" on recommendations;
drop policy if exists "recommendations owner insert" on recommendations;
drop policy if exists "recommendations owner update" on recommendations;
drop policy if exists "recommendations owner delete" on recommendations;
create policy "recommendations owner select" on recommendations for select using (auth.uid() = org_id);
create policy "recommendations owner insert" on recommendations for insert with check (auth.uid() = org_id);
create policy "recommendations owner update" on recommendations for update using (auth.uid() = org_id);
create policy "recommendations owner delete" on recommendations for delete using (auth.uid() = org_id);

-- datasets
drop policy if exists "datasets owner select" on datasets;
drop policy if exists "datasets owner insert" on datasets;
drop policy if exists "datasets owner delete" on datasets;
create policy "datasets owner select" on datasets for select using (auth.uid() = org_id);
create policy "datasets owner insert" on datasets for insert with check (auth.uid() = org_id);
create policy "datasets owner delete" on datasets for delete using (auth.uid() = org_id);

-- activity
drop policy if exists "activity owner select" on activity;
drop policy if exists "activity owner insert" on activity;
create policy "activity owner select" on activity for select using (auth.uid() = org_id);
create policy "activity owner insert" on activity for insert with check (auth.uid() = org_id);

-- profiles
drop policy if exists "profiles self select" on profiles;
drop policy if exists "profiles self update" on profiles;
create policy "profiles self select" on profiles for select using (auth.uid() = id);
create policy "profiles self update" on profiles for update using (auth.uid() = id);

-- workspaces
drop policy if exists "workspaces owner select" on workspaces;
drop policy if exists "workspaces owner insert" on workspaces;
drop policy if exists "workspaces owner update" on workspaces;
drop policy if exists "workspaces owner delete" on workspaces;
create policy "workspaces owner select" on workspaces for select using (auth.uid() = owner_id);
create policy "workspaces owner insert" on workspaces for insert with check (auth.uid() = owner_id);
create policy "workspaces owner update" on workspaces for update using (auth.uid() = owner_id);
create policy "workspaces owner delete" on workspaces for delete using (auth.uid() = owner_id);

-- subscriptions
drop policy if exists "subscriptions self select" on subscriptions;
drop policy if exists "subscriptions self insert" on subscriptions;
drop policy if exists "subscriptions self update" on subscriptions;
create policy "subscriptions self select" on subscriptions for select using (auth.uid() = user_id);
create policy "subscriptions self insert" on subscriptions for insert with check (auth.uid() = user_id);
create policy "subscriptions self update" on subscriptions for update using (auth.uid() = user_id);

-- ═════════════════════════════════════════════════════════════════════════
-- PHASE 1 — Document intake + persisted alerts
-- ═════════════════════════════════════════════════════════════════════════
-- New surface for the Financial Statement Intelligence flagship: upload a
-- PDF / XLSX / CSV / image, classify it, and operate on its derived alerts.
--
-- Single-tenant for now (org_id = auth.uid()) — multi-org via memberships
-- arrives in a later phase. RLS enforces ownership the same way the legacy
-- tables above do.

-- ─────────── Documents ────────────────────────────────────────────────────
-- One row per uploaded artifact. The actual file lives in the `documents`
-- Storage bucket under {org_id}/{document_id}.{ext}. Pipeline stages mutate
-- `status` as they progress.

create table if not exists documents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default auth.uid(),
  uploaded_by uuid references auth.users(id) on delete set null,
  storage_path text not null,
  original_filename text not null,
  mime_type text not null,
  size_bytes bigint not null check (size_bytes > 0),
  detected_type text
    check (detected_type is null or detected_type in
      ('invoice','bilant','pl','trial_balance','annual_report','xlsx_workbook','csv','image','unknown')),
  status text not null default 'uploaded'
    check (status in ('uploaded','extracting','mapped','analyzed','failed')),
  extraction_confidence numeric check (extraction_confidence is null or (extraction_confidence >= 0 and extraction_confidence <= 1)),
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists documents_org_created_idx
  on documents (org_id, created_at desc);
create index if not exists documents_status_idx
  on documents (status) where status in ('uploaded','extracting');

drop trigger if exists documents_set_updated_at on documents;
create trigger documents_set_updated_at
  before update on documents
  for each row execute function set_updated_at_now();

alter table documents enable row level security;

drop policy if exists "documents owner select" on documents;
drop policy if exists "documents owner insert" on documents;
drop policy if exists "documents owner update" on documents;
drop policy if exists "documents owner delete" on documents;
create policy "documents owner select" on documents for select using (auth.uid() = org_id);
create policy "documents owner insert" on documents for insert with check (auth.uid() = org_id);
create policy "documents owner update" on documents for update using (auth.uid() = org_id);
create policy "documents owner delete" on documents for delete using (auth.uid() = org_id);

-- ─────────── Alerts (persisted snapshot) ──────────────────────────────────
-- Distinct from `alert_states` (which records *user actions* like dismiss).
-- Every analysis run upserts the alerts it computed into this table so the
-- /alerts page can read from one source of truth, show empty states cleanly,
-- and survive page reloads. Recomputation is a separate concern: when a new
-- run lands, we wipe stale rows for that source and re-insert.

create table if not exists alerts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default auth.uid(),
  -- Stable engine key (e.g. 'margin:CategoryX' or 'liquidity:current<1') so
  -- alert_states can join + so re-runs upsert idempotently.
  alert_key text not null,
  severity text not null check (severity in ('critical','high','medium','low','info')),
  category text not null check (category in
    ('liquidity','leverage','margin','inventory','compliance','data_quality','working_capital','customer','supplier','opportunity')),
  title text not null,
  body text,
  document_id uuid references documents(id) on delete set null,
  payload jsonb,                  -- full Alert object from the engine, for the side-sheet
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, alert_key)
);

create index if not exists alerts_org_severity_idx
  on alerts (org_id, severity, created_at desc);
create index if not exists alerts_org_category_idx
  on alerts (org_id, category);

drop trigger if exists alerts_set_updated_at on alerts;
create trigger alerts_set_updated_at
  before update on alerts
  for each row execute function set_updated_at_now();

alter table alerts enable row level security;

drop policy if exists "alerts owner select" on alerts;
drop policy if exists "alerts owner insert" on alerts;
drop policy if exists "alerts owner update" on alerts;
drop policy if exists "alerts owner delete" on alerts;
create policy "alerts owner select" on alerts for select using (auth.uid() = org_id);
create policy "alerts owner insert" on alerts for insert with check (auth.uid() = org_id);
create policy "alerts owner update" on alerts for update using (auth.uid() = org_id);
create policy "alerts owner delete" on alerts for delete using (auth.uid() = org_id);

-- ─────────── Storage policies for the `documents` bucket ──────────────────
-- The bucket itself is created via the dashboard or `supabase storage` CLI.
-- Convention: object keys are `{auth.uid()}/{document_id}.{ext}`. Policies
-- below scope every operation to the user's own folder.

-- These statements are wrapped in a DO block so re-running the schema doesn't
-- explode if the policies (or bucket) don't exist yet. The bucket creation
-- happens out-of-band — see RUNBOOK.md.

do $$
begin
  -- Per-user folder access. The first path segment must equal auth.uid().
  if exists (select 1 from storage.buckets where id = 'documents') then
    drop policy if exists "documents storage select own" on storage.objects;
    drop policy if exists "documents storage insert own" on storage.objects;
    drop policy if exists "documents storage update own" on storage.objects;
    drop policy if exists "documents storage delete own" on storage.objects;

    create policy "documents storage select own" on storage.objects
      for select using (
        bucket_id = 'documents'
        and auth.uid()::text = (storage.foldername(name))[1]
      );
    create policy "documents storage insert own" on storage.objects
      for insert with check (
        bucket_id = 'documents'
        and auth.uid()::text = (storage.foldername(name))[1]
      );
    create policy "documents storage update own" on storage.objects
      for update using (
        bucket_id = 'documents'
        and auth.uid()::text = (storage.foldername(name))[1]
      );
    create policy "documents storage delete own" on storage.objects
      for delete using (
        bucket_id = 'documents'
        and auth.uid()::text = (storage.foldername(name))[1]
      );
  end if;
end$$;

-- ═════════════════════════════════════════════════════════════════════════
-- REFACTOR: Invoices merged into Financial Statements
-- ═════════════════════════════════════════════════════════════════════════
-- Per master prompt §3 — additive only, no breaking changes. Invoices ride
-- on top of the existing `documents` table (an invoice register IS a document
-- whose detected_type is 'invoice_register' or 'invoice_single'); these two
-- tables persist the parsed invoice rows + line items.

create table if not exists invoices (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default auth.uid(),
  document_id uuid references documents(id) on delete cascade,
  invoice_no text not null,
  invoice_date date not null,
  due_date date,
  paid_date date,
  customer_name text not null,
  customer_vat_id text,
  direction text not null check (direction in ('sale', 'purchase')),
  net_amount numeric(20, 2) not null,
  vat_amount numeric(20, 2) not null default 0,
  vat_rate numeric(5, 2),
  currency text not null default 'RON',
  created_at timestamptz not null default now(),
  -- Idempotent re-import: same invoice from same source is upsert-safe.
  unique (org_id, invoice_no, direction, invoice_date)
);

create index if not exists invoices_org_date_idx on invoices (org_id, invoice_date desc);
create index if not exists invoices_org_customer_idx on invoices (org_id, customer_name);
create index if not exists invoices_document_idx on invoices (document_id);

create table if not exists invoice_lines (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references invoices(id) on delete cascade,
  sku text,
  description text,
  qty numeric(20, 4),
  unit_price numeric(20, 4),
  net_amount numeric(20, 2) not null,
  vat_amount numeric(20, 2) not null default 0
);

create index if not exists invoice_lines_invoice_idx on invoice_lines (invoice_id);

alter table invoices enable row level security;
alter table invoice_lines enable row level security;

drop policy if exists "invoices owner select" on invoices;
drop policy if exists "invoices owner insert" on invoices;
drop policy if exists "invoices owner update" on invoices;
drop policy if exists "invoices owner delete" on invoices;
create policy "invoices owner select" on invoices for select using (auth.uid() = org_id);
create policy "invoices owner insert" on invoices for insert with check (auth.uid() = org_id);
create policy "invoices owner update" on invoices for update using (auth.uid() = org_id);
create policy "invoices owner delete" on invoices for delete using (auth.uid() = org_id);

-- Lines inherit access from their parent invoice — the join checks org_id
-- transitively, avoiding a redundant org_id column on every line row.
drop policy if exists "invoice_lines owner select" on invoice_lines;
drop policy if exists "invoice_lines owner insert" on invoice_lines;
drop policy if exists "invoice_lines owner update" on invoice_lines;
drop policy if exists "invoice_lines owner delete" on invoice_lines;
create policy "invoice_lines owner select" on invoice_lines
  for select using (
    exists (select 1 from invoices i where i.id = invoice_id and i.org_id = auth.uid())
  );
create policy "invoice_lines owner insert" on invoice_lines
  for insert with check (
    exists (select 1 from invoices i where i.id = invoice_id and i.org_id = auth.uid())
  );
create policy "invoice_lines owner update" on invoice_lines
  for update using (
    exists (select 1 from invoices i where i.id = invoice_id and i.org_id = auth.uid())
  );
create policy "invoice_lines owner delete" on invoice_lines
  for delete using (
    exists (select 1 from invoices i where i.id = invoice_id and i.org_id = auth.uid())
  );

-- ═════════════════════════════════════════════════════════════════════════
-- PHASE 2 — Document pipeline persistence
-- ═════════════════════════════════════════════════════════════════════════
-- Once a document is detected → ocr'd → extracted → mapped → assembled, the
-- pipeline writes one financial_periods row + N statement_line_items rows.
-- Recompute is idempotent on (org_id, period_end, source_document_id).
--
-- The coa_mappings table lets users correct a Romanian-COA → standardized
-- bucket assignment that the heuristic mapper got wrong; the next pipeline
-- run for that org reads these overrides first.

create table if not exists financial_periods (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default auth.uid(),
  source_document_id uuid references documents(id) on delete cascade,
  period_start date not null,
  period_end date not null,
  currency text not null default 'RON',
  -- Confidence emitted by the extraction layer (0..1). Drives the
  -- "Verifică datele extrase — încredere N%" banner.
  extraction_confidence numeric check (extraction_confidence is null or (extraction_confidence >= 0 and extraction_confidence <= 1)),
  -- One financial period per (org, period_end, document) — recompute upserts.
  unique (org_id, period_end, source_document_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists financial_periods_org_idx
  on financial_periods (org_id, period_end desc);
create index if not exists financial_periods_document_idx
  on financial_periods (source_document_id);

drop trigger if exists financial_periods_set_updated_at on financial_periods;
create trigger financial_periods_set_updated_at
  before update on financial_periods
  for each row execute function set_updated_at_now();

create table if not exists statement_line_items (
  id uuid primary key default gen_random_uuid(),
  period_id uuid not null references financial_periods(id) on delete cascade,
  -- Which statement this line belongs to. CF lines may carry is_derived=true
  -- when reconstructed via the indirect method from BS+PL alone.
  statement text not null check (statement in ('BS', 'PL', 'CF')),
  -- Standardized bucket key. Stable across companies; UI groups + sums on this.
  -- Examples: 'cash','ar','inventory','ppe','st_debt','revenue','cogs',
  --           'operating_expenses','depreciation','interest_expense',...
  bucket text not null,
  -- Romanian Chart of Accounts code that contributed to this bucket
  -- (e.g. '5121', '4111', '7015'). Null when the bucket was assembled from
  -- multiple accounts and we want a single rolled-up row.
  ro_account_code text,
  ro_account_name text,
  amount numeric(20, 2) not null,
  is_derived boolean not null default false
);

create index if not exists statement_line_items_period_stmt_idx
  on statement_line_items (period_id, statement);
create index if not exists statement_line_items_bucket_idx
  on statement_line_items (period_id, bucket);

create table if not exists coa_mappings (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default auth.uid(),
  -- Account code prefix this mapping applies to (e.g. '4111' or '70').
  ro_account_prefix text not null,
  bucket text not null,
  -- Sign override: 1 = additive, -1 = subtractive (e.g. accumulated depr).
  sign smallint not null default 1 check (sign in (1, -1)),
  -- Optional human label of what the prefix represents in the user's COA.
  description text,
  created_at timestamptz not null default now(),
  unique (org_id, ro_account_prefix)
);

create index if not exists coa_mappings_org_idx on coa_mappings (org_id);

alter table financial_periods enable row level security;
alter table statement_line_items enable row level security;
alter table coa_mappings enable row level security;

drop policy if exists "financial_periods owner select" on financial_periods;
drop policy if exists "financial_periods owner insert" on financial_periods;
drop policy if exists "financial_periods owner update" on financial_periods;
drop policy if exists "financial_periods owner delete" on financial_periods;
create policy "financial_periods owner select" on financial_periods for select using (auth.uid() = org_id);
create policy "financial_periods owner insert" on financial_periods for insert with check (auth.uid() = org_id);
create policy "financial_periods owner update" on financial_periods for update using (auth.uid() = org_id);
create policy "financial_periods owner delete" on financial_periods for delete using (auth.uid() = org_id);

drop policy if exists "statement_line_items owner select" on statement_line_items;
drop policy if exists "statement_line_items owner insert" on statement_line_items;
drop policy if exists "statement_line_items owner update" on statement_line_items;
drop policy if exists "statement_line_items owner delete" on statement_line_items;
create policy "statement_line_items owner select" on statement_line_items
  for select using (
    exists (select 1 from financial_periods p where p.id = period_id and p.org_id = auth.uid())
  );
create policy "statement_line_items owner insert" on statement_line_items
  for insert with check (
    exists (select 1 from financial_periods p where p.id = period_id and p.org_id = auth.uid())
  );
create policy "statement_line_items owner update" on statement_line_items
  for update using (
    exists (select 1 from financial_periods p where p.id = period_id and p.org_id = auth.uid())
  );
create policy "statement_line_items owner delete" on statement_line_items
  for delete using (
    exists (select 1 from financial_periods p where p.id = period_id and p.org_id = auth.uid())
  );

drop policy if exists "coa_mappings owner select" on coa_mappings;
drop policy if exists "coa_mappings owner insert" on coa_mappings;
drop policy if exists "coa_mappings owner update" on coa_mappings;
drop policy if exists "coa_mappings owner delete" on coa_mappings;
create policy "coa_mappings owner select" on coa_mappings for select using (auth.uid() = org_id);
create policy "coa_mappings owner insert" on coa_mappings for insert with check (auth.uid() = org_id);
create policy "coa_mappings owner update" on coa_mappings for update using (auth.uid() = org_id);
create policy "coa_mappings owner delete" on coa_mappings for delete using (auth.uid() = org_id);
