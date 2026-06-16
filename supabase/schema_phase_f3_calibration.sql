-- CFO AI — F3.5 calibration learning database.
-- =============================================================================
-- Apply after schema_phase4_multicountry.sql. Idempotent.
--
-- WHAT THIS ADDS
--   - calibration_rules: user-proposed account → bucket mappings, with
--     status (pending/approved/rejected), so F3.4 Review Mode overrides
--     can become approved org-wide rules through F3.6 admin workflow.
--   - calibration_fixtures: real trial balances used as ground truth for
--     country-pack calibration tier promotion (the per-country "≥10
--     fixtures = deeply calibrated" rule from the F3 kickoff).
--   - calibration_results: engine-version × fixture-id × residual run
--     history, so we can prove a refactor didn't regress any calibrated
--     fixture's reconciliation.
--
-- WHAT THIS DOES NOT DO
--   - The engine's assemble_statements still consults
--     `org_coa_mappings_overrides` directly. Approved
--     calibration_rules are copied INTO that table by the F3.6 admin
--     approval endpoint, so the engine doesn't need to know about
--     calibration_rules existence.
--   - F3.7 (Bulgaria pack) is blocked on real fixtures (operator work,
--     not engineering).

-- ─── calibration_rules — proposed/approved mappings ────────────────
create table if not exists calibration_rules (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references organizations(id) on delete cascade,
  -- Country pack the rule applies to. Matches `coa_registries.key`
  -- (e.g. 'omfp_1802') so multi-pack engines route by COA.
  coa_key text references coa_registries(key) on delete cascade not null,
  -- The account code being mapped. May be a full code ('411') or a
  -- prefix ('4111') depending on how the user expressed their
  -- correction.
  account_code text not null,
  account_name_native text,
  -- Target canonical bucket (e.g. 'revenue', 'shortTermDebt'). Set
  -- of valid values matches what the country pack's bucket_for()
  -- emits; the F3.6 admin dashboard validates against this.
  standardized_bucket text not null,
  sign smallint not null default 1 check (sign in (1, -1)),
  -- Source: where this proposal came from. 'review_mode' = F3.4
  -- user override; 'admin' = direct admin entry; 'import' = bulk.
  source text not null default 'review_mode'
    check (source in ('review_mode', 'admin', 'import', 'system')),
  -- Approval state.
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'superseded')),
  -- Provenance — the period that generated this proposal (F3.4 hand-off).
  period_id uuid references financial_periods(id) on delete set null,
  proposed_by uuid references auth.users(id) on delete set null,
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  rejection_reason text,
  -- Confidence score the engine assigned at proposal time (0..1).
  -- Optional; helps admin triage low-confidence proposals.
  confidence numeric,
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists calibration_rules_org_status_idx
  on calibration_rules (org_id, status);
create index if not exists calibration_rules_coa_status_idx
  on calibration_rules (coa_key, status);

alter table calibration_rules enable row level security;

drop policy if exists "calibration_rules member select" on calibration_rules;
drop policy if exists "calibration_rules member write" on calibration_rules;
drop policy if exists "calibration_rules admin all" on calibration_rules;

-- Members can see their org's pending+approved proposals.
create policy "calibration_rules member select" on calibration_rules
  for select using (org_id is null or is_member_of(org_id));

-- Members can propose new rules (status='pending', source='review_mode')
-- via the F3.4 endpoint; admin-only flag elevates to approval.
create policy "calibration_rules member write" on calibration_rules
  for insert with check (
    (org_id is null or is_member_of(org_id))
    and status = 'pending'
    and source in ('review_mode', 'admin')
  );

-- ─── calibration_fixtures — real ground-truth uploads ──────────────
create table if not exists calibration_fixtures (
  id uuid primary key default gen_random_uuid(),
  coa_key text references coa_registries(key) on delete cascade not null,
  country_code text references countries(code) on delete cascade not null,
  -- Human-readable label. e.g. "EEI Imobiliara Dec 2025".
  display_name text not null,
  -- Industry context (helps cluster fixtures by sector for benchmarks).
  industry_key text,
  -- Storage path for the raw file (Supabase Storage bucket).
  storage_path text,
  -- Hash so the same fixture isn't double-counted.
  content_sha256 text,
  -- Operator-side metadata: who provided this fixture, when, under what
  -- agreement (anonymised / consented / public).
  source_org_id uuid references organizations(id) on delete set null,
  provenance text,
  -- Locking: once a fixture is "in use" for calibration tier
  -- promotion, its mapping shouldn't be tweaked silently.
  is_locked boolean not null default false,
  added_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists calibration_fixtures_coa_idx
  on calibration_fixtures (coa_key);

alter table calibration_fixtures enable row level security;
drop policy if exists "calibration_fixtures admin all" on calibration_fixtures;
-- No member-write policy: fixtures are admin/operator-managed only.
-- Read is open so the FE can show "we have N fixtures for this pack".
drop policy if exists "calibration_fixtures public select" on calibration_fixtures;
create policy "calibration_fixtures public select" on calibration_fixtures
  for select using (true);

-- ─── calibration_results — fixture × engine-version × residual ────
-- Run history so we can prove "engine v2.1 + Romania pack" produced
-- residual X% on fixture Y. F-A3.1 GREEN gates promote here.
create table if not exists calibration_results (
  id uuid primary key default gen_random_uuid(),
  fixture_id uuid references calibration_fixtures(id) on delete cascade not null,
  engine_version text not null,                 -- e.g. 'v2.1+f3.3'
  pack_version text not null,                   -- pack's pack_version
  -- The four headline reconciliation numbers.
  total_assets numeric,
  total_equity numeric,
  bs_balance_delta numeric,
  drift_pct numeric,                            -- 0..100
  verdict text check (verdict in ('green', 'amber', 'red')),
  unmapped_residual_pct numeric,
  -- Free-form notes for the operator (e.g. "regression test passed").
  notes text not null default '',
  run_at timestamptz not null default now()
);

create index if not exists calibration_results_fixture_engine_idx
  on calibration_results (fixture_id, engine_version, run_at desc);

alter table calibration_results enable row level security;
drop policy if exists "calibration_results public select" on calibration_results;
create policy "calibration_results public select" on calibration_results
  for select using (true);


-- ─────────────────────────────────────────────────────────────────────
-- F3.24 (2026-05-26) — invalidate PostgREST schema cache after schema change.
-- Backfilled retroactively into existing migration files so re-running them
-- after a Postgres restore or fresh-environment setup stays safe. Harmless
-- on already-applied migrations. See CLAUDE.md §14 discipline rule.
-- ─────────────────────────────────────────────────────────────────────
NOTIFY pgrst, 'reload schema';
