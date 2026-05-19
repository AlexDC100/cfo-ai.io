-- Phase Industry Intelligence — multi-table industry classification layer.
--
-- WHAT THIS MIGRATION ADDS
-- ========================
-- Seven new tables that turn "industry" from a single string column on
-- `organizations.caen_code` into a structured, per-analysis,
-- audit-logged classification entity:
--
--   industry_profiles            — 90+ canonical industries (FR sub-industries with parent
--                                  benchmarks, e.g. `packaged_canned_meat_prepared_foods` →
--                                  parent `food_manufacturing`)
--   industry_aliases             — search synonyms ("canned meat", "conserve", "1013")
--   caen_industry_mappings       — full 4-digit Romanian CAEN → industry_key map
--   benchmark_sets               — versioned benchmark revisions per industry
--   peer_candidates              — suggestion-layer peers (names only; financials only
--                                  appear in industry_peers once verified/uploaded)
--   company_industry_assignments — per-analysis override (the spec's core ask)
--   industry_change_audit_log    — every reassignment recorded
--
-- WHAT IT DOES NOT TOUCH
-- ======================
-- The existing `industry_benchmarks` / `industry_peers` /
-- `industry_leader_reasons` / `industry_qualitative` tables (Phase 7
-- and 7b) stay verbatim. Phase B (next) wires the new lookup path on
-- top: caen → caen_industry_mappings → industry_key → benchmark_sets
-- (latest) → benchmark_metrics. Until that's verified GREEN we
-- DUAL-WRITE so both paths resolve. No data is migrated destructively
-- in this file.
--
-- RLS PATTERNS MIRRORED FROM PHASE 7
-- ==================================
--   · Catalog tables (industry_profiles, industry_aliases,
--     caen_industry_mappings, benchmark_sets, peer_candidates) — public
--     read for authenticated users, no write policy (admin client only).
--   · Tenant tables (company_industry_assignments,
--     industry_change_audit_log) — org-scoped via `memberships`, same
--     pattern as financial_periods / documents / calculated_metrics.

set search_path = public;

-- ───────────────────────────────────────────────────────────────────────
-- 1. industry_profiles — the canonical industry catalog
-- ───────────────────────────────────────────────────────────────────────
create table if not exists industry_profiles (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,                    -- "packaged_canned_meat_prepared_foods"
  display_name text not null,                  -- English-only primary label
  display_name_ro text,                        -- optional Romanian label
  sector text not null,                        -- "food_manufacturing"
  parent_key text references industry_profiles(key),
  caen_codes text[] not null default '{}',     -- primary CAENs that resolve TO this industry
  description text,
  benchmark_depth text not null default 'directional' check (
    benchmark_depth in ('full', 'level_1_public_summary', 'trial_balance', 'directional')
  ),
  confidence_default real not null default 0.7,
  source_type text not null default 'seed_v1' check (
    source_type in ('seed_v1', 'curated', 'community')
  ),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists industry_profiles_sector_idx on industry_profiles (sector);
create index if not exists industry_profiles_parent_idx on industry_profiles (parent_key);
create index if not exists industry_profiles_caen_codes_gin on industry_profiles using gin (caen_codes);

-- ───────────────────────────────────────────────────────────────────────
-- 2. industry_aliases — searchable synonyms
-- ───────────────────────────────────────────────────────────────────────
create table if not exists industry_aliases (
  id uuid primary key default gen_random_uuid(),
  industry_key text not null references industry_profiles(key) on delete cascade,
  alias text not null,                         -- "canned meat", "conserve", "automotive retail"
  alias_lang text not null default 'en' check (alias_lang in ('en', 'ro')),
  weight real not null default 1.0,            -- search ranking nudge
  created_at timestamptz not null default now(),
  unique (industry_key, alias)
);

create index if not exists industry_aliases_alias_idx on industry_aliases (lower(alias));
create index if not exists industry_aliases_industry_idx on industry_aliases (industry_key);

-- ───────────────────────────────────────────────────────────────────────
-- 3. caen_industry_mappings — full 4-digit CAEN → industry_key resolver
-- ───────────────────────────────────────────────────────────────────────
create table if not exists caen_industry_mappings (
  caen_code text primary key,                  -- "1013", "4511", "6820", "7830"
  caen_label_en text not null,
  caen_label_ro text,
  industry_key text not null references industry_profiles(key),
  parent_industry_key text references industry_profiles(key),
  match_quality text not null default 'exact' check (
    match_quality in ('exact', 'close', 'sector_fallback')
  ),
  confidence real not null default 0.9,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists caen_industry_mappings_industry_idx on caen_industry_mappings (industry_key);

-- ───────────────────────────────────────────────────────────────────────
-- 4. benchmark_sets — versioned benchmark revisions per industry
-- ───────────────────────────────────────────────────────────────────────
-- The new lookup path: caen → caen_industry_mappings.industry_key →
-- benchmark_sets (latest revision where effective_to is null) →
-- benchmark_metrics. Phase B wires it; Phase A just creates the tables.
create table if not exists benchmark_sets (
  id uuid primary key default gen_random_uuid(),
  industry_key text not null references industry_profiles(key) on delete cascade,
  revision int not null,
  effective_from date not null default current_date,
  effective_to date,
  source_label text not null,                  -- "CFO AI internal aggregates v1", "Eurostat SBS 2023"
  source_year int not null,
  confidence text not null default 'estimated' check (
    confidence in ('estimated', 'derived', 'verified', 'licensed', 'directional')
  ),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (industry_key, revision)
);

create index if not exists benchmark_sets_industry_idx on benchmark_sets (industry_key);

-- ───────────────────────────────────────────────────────────────────────
-- 5. peer_candidates — suggestion layer
-- ───────────────────────────────────────────────────────────────────────
-- Names + meta only. Financial fields stay in the existing
-- `industry_peers` table (Phase 7b) and are only populated when a peer
-- is verified or has uploaded financials. The "Sadu / Bucegi as
-- internal brands not external peers" rule is enforced by the
-- `is_internal_brand` flag.
create table if not exists peer_candidates (
  id uuid primary key default gen_random_uuid(),
  industry_key text not null references industry_profiles(key) on delete cascade,
  company_name text not null,
  country text not null default 'RO',
  source text not null default 'internal_demo' check (
    source in ('user_provided', 'public_filing', 'internal_demo', 'verified')
  ),
  notes text,
  has_uploaded_financials boolean not null default false,
  -- When verified financials exist this can be linked to a
  -- benchmark_set; until then it's a name-only suggestion.
  benchmark_set_id uuid references benchmark_sets(id) on delete set null,
  -- When the candidate is an internal brand of the company being
  -- analyzed (Sadu/Bucegi for Scandia), the UI hides it from peer
  -- comparisons. Per-analysis override is recorded in the assignment
  -- table; this column is the default at the catalog level.
  is_internal_brand_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (industry_key, company_name)
);

create index if not exists peer_candidates_industry_idx on peer_candidates (industry_key);

-- ───────────────────────────────────────────────────────────────────────
-- 6. company_industry_assignments — per-analysis override (tenant data)
-- ───────────────────────────────────────────────────────────────────────
-- One row per analysis (period). When present, it overrides the
-- org-level `organizations.caen_code` default for that period only.
-- `locked_by_user = true` prevents the auto-detector from re-flipping
-- it on a re-run.
create table if not exists company_industry_assignments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  -- Spec calls this `analysis_id`; internally periods are the unit.
  period_id uuid not null references financial_periods(id) on delete cascade,
  company_name text,
  caen_code text,
  detected_industry_key text references industry_profiles(key),
  selected_industry_key text not null references industry_profiles(key),
  source text not null check (
    source in ('auto_caen', 'auto_keyword', 'auto_account_structure',
               'auto_activity_text', 'user_override', 'fallback')
  ),
  confidence real not null default 0.7,
  locked_by_user boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (period_id)
);

create index if not exists company_industry_assignments_org_idx on company_industry_assignments (organization_id);
create index if not exists company_industry_assignments_industry_idx on company_industry_assignments (selected_industry_key);

-- ───────────────────────────────────────────────────────────────────────
-- 7. industry_change_audit_log — every reassignment recorded
-- ───────────────────────────────────────────────────────────────────────
create table if not exists industry_change_audit_log (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  period_id uuid not null references financial_periods(id) on delete cascade,
  changed_at timestamptz not null default now(),
  changed_by uuid,                              -- auth.uid() — nullable for service-role writes
  prev_industry_key text,
  new_industry_key text not null,
  prev_source text,
  new_source text not null,
  reason text,
  payload jsonb                                 -- snapshot of the assignment row at change time
);

create index if not exists industry_change_audit_log_org_idx on industry_change_audit_log (organization_id);
create index if not exists industry_change_audit_log_period_idx on industry_change_audit_log (period_id);
create index if not exists industry_change_audit_log_changed_at_idx on industry_change_audit_log (changed_at desc);

-- ───────────────────────────────────────────────────────────────────────
-- RLS — catalog tables (public read for authenticated, no write policy)
-- ───────────────────────────────────────────────────────────────────────
alter table industry_profiles            enable row level security;
alter table industry_aliases             enable row level security;
alter table caen_industry_mappings       enable row level security;
alter table benchmark_sets               enable row level security;
alter table peer_candidates              enable row level security;

drop policy if exists "industry_profiles_readable_by_authenticated" on industry_profiles;
create policy "industry_profiles_readable_by_authenticated"
  on industry_profiles for select
  using (auth.role() = 'authenticated');

drop policy if exists "industry_aliases_readable_by_authenticated" on industry_aliases;
create policy "industry_aliases_readable_by_authenticated"
  on industry_aliases for select
  using (auth.role() = 'authenticated');

drop policy if exists "caen_industry_mappings_readable_by_authenticated" on caen_industry_mappings;
create policy "caen_industry_mappings_readable_by_authenticated"
  on caen_industry_mappings for select
  using (auth.role() = 'authenticated');

drop policy if exists "benchmark_sets_readable_by_authenticated" on benchmark_sets;
create policy "benchmark_sets_readable_by_authenticated"
  on benchmark_sets for select
  using (auth.role() = 'authenticated');

drop policy if exists "peer_candidates_readable_by_authenticated" on peer_candidates;
create policy "peer_candidates_readable_by_authenticated"
  on peer_candidates for select
  using (auth.role() = 'authenticated');

-- ───────────────────────────────────────────────────────────────────────
-- RLS — tenant tables (org-scoped via memberships, same as Phase 7)
-- ───────────────────────────────────────────────────────────────────────
alter table company_industry_assignments enable row level security;
alter table industry_change_audit_log    enable row level security;

drop policy if exists "company_industry_assignments_member_select" on company_industry_assignments;
create policy "company_industry_assignments_member_select"
  on company_industry_assignments for select
  using (organization_id in (select org_id from memberships where user_id = auth.uid()));

drop policy if exists "company_industry_assignments_member_write" on company_industry_assignments;
create policy "company_industry_assignments_member_write"
  on company_industry_assignments for all
  using (organization_id in (select org_id from memberships where user_id = auth.uid()));

drop policy if exists "industry_change_audit_log_member_select" on industry_change_audit_log;
create policy "industry_change_audit_log_member_select"
  on industry_change_audit_log for select
  using (organization_id in (select org_id from memberships where user_id = auth.uid()));

-- Audit log writes flow through the admin client (service role) only —
-- no member write policy. Tampering with the audit trail from a user
-- session is prevented by the absence of a policy + RLS enable.

-- ───────────────────────────────────────────────────────────────────────
-- updated_at triggers — reuse the existing project function
-- ───────────────────────────────────────────────────────────────────────
do $$
begin
  if exists (select 1 from pg_proc where proname = 'set_updated_at') then
    drop trigger if exists industry_profiles_set_updated_at on industry_profiles;
    create trigger industry_profiles_set_updated_at
      before update on industry_profiles
      for each row execute function set_updated_at();

    drop trigger if exists caen_industry_mappings_set_updated_at on caen_industry_mappings;
    create trigger caen_industry_mappings_set_updated_at
      before update on caen_industry_mappings
      for each row execute function set_updated_at();

    drop trigger if exists benchmark_sets_set_updated_at on benchmark_sets;
    create trigger benchmark_sets_set_updated_at
      before update on benchmark_sets
      for each row execute function set_updated_at();

    drop trigger if exists peer_candidates_set_updated_at on peer_candidates;
    create trigger peer_candidates_set_updated_at
      before update on peer_candidates
      for each row execute function set_updated_at();

    drop trigger if exists company_industry_assignments_set_updated_at on company_industry_assignments;
    create trigger company_industry_assignments_set_updated_at
      before update on company_industry_assignments
      for each row execute function set_updated_at();
  end if;
end$$;

-- End of migration.
