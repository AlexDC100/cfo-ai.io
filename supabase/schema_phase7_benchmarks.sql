-- Phase 7 — Industry Benchmarks.
--
-- Adds CAEN industry classification + the industry_benchmarks table that
-- holds typical-value percentiles per CAEN code, sourced from public RO
-- SME filings + Eurostat SBS. The benchmark engine reads from the
-- canonical `calculated_metrics` table (populated by either the trial
-- balance OR statutory F30+F10 pipeline — both write the same metric
-- names), so the comparison feature works across all upload types.
--
-- NOTHING in this migration touches existing parsers, mapping rules, or
-- the calculated_metrics schema itself. It only ADDS columns/tables.

-- ─── CAEN on the org (industry classification) ──────────────────────────────
-- The spec referenced a `companies` table, but this codebase tracks
-- per-tenant context on `organizations`. CAEN code + provenance go here.
alter table organizations
  add column if not exists caen_code text,
  add column if not exists caen_code_confirmed_at timestamptz,
  add column if not exists caen_code_source text check (
    caen_code_source is null or caen_code_source in ('user', 'auto_suggested')
  );


-- ─── Industry-typical benchmark dataset ─────────────────────────────────────
-- Seeded from `benchmarks_seed.json`. The `confidence` column is the
-- intellectual-honesty anchor: every benchmark must declare whether
-- the percentiles are 'estimated' (current Phase 1 source), 'derived'
-- (computed from real customer-anonymized aggregates — Phase 2), or
-- 'licensed' (Bisnode/KeysFin — Phase 2+).
create table if not exists industry_benchmarks (
  id uuid primary key default gen_random_uuid(),
  caen_code text not null,
  caen_label text not null,
  industry_category text not null,        -- e.g. 'manufacturing_consumer', 'real_estate_commercial'
  metric_name text not null,              -- matches calculated_metrics.name
  metric_type text not null check (metric_type in ('ratio', 'pct_of_revenue', 'absolute')),
  p25_value numeric,
  p50_value numeric,                      -- median (typical value)
  p75_value numeric,
  unit text,                              -- 'pct' | 'ratio' | 'days'
  source_label text not null,             -- attribution string shown in the UI tooltip
  source_year integer not null,
  confidence text not null default 'estimated' check (
    confidence in ('estimated', 'derived', 'licensed')
  ),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (caen_code, metric_name)
);

create index if not exists industry_benchmarks_caen_idx
  on industry_benchmarks (caen_code);
create index if not exists industry_benchmarks_metric_idx
  on industry_benchmarks (metric_name);


-- ─── Cached comparison reports ──────────────────────────────────────────────
-- One report per period. Re-opens hit the cached JSON instead of
-- recomputing — comparison math is deterministic, so caching is safe.
-- Recomputed whenever the period itself is re-analyzed (re-run pipeline
-- → new period_id → cache key changes).
create table if not exists benchmark_reports (
  id uuid primary key default gen_random_uuid(),
  period_id uuid not null references financial_periods(id) on delete cascade,
  org_id uuid not null references organizations(id) on delete cascade,
  caen_code text not null,
  report_data jsonb not null,             -- entire computed comparison payload
  generated_at timestamptz not null default now(),
  unique (period_id)
);

create index if not exists benchmark_reports_org_idx
  on benchmark_reports (org_id);


-- ─── RLS ────────────────────────────────────────────────────────────────────
-- Benchmark catalogue: readable by anyone authenticated (it's reference
-- data — no PII, no per-tenant scoping needed). Write access reserved
-- for the service role via the admin client.
alter table industry_benchmarks enable row level security;

drop policy if exists "benchmarks_readable_by_authenticated" on industry_benchmarks;
create policy "benchmarks_readable_by_authenticated"
  on industry_benchmarks
  for select
  using (auth.role() = 'authenticated');

-- Reports: scoped to the user's org via the membership table (same
-- pattern that financial_periods / documents / calculated_metrics use).
alter table benchmark_reports enable row level security;

drop policy if exists "benchmark_reports_member_select" on benchmark_reports;
create policy "benchmark_reports_member_select"
  on benchmark_reports
  for select
  using (
    org_id in (
      select org_id from memberships where user_id = auth.uid()
    )
  );

drop policy if exists "benchmark_reports_member_write" on benchmark_reports;
create policy "benchmark_reports_member_write"
  on benchmark_reports
  for all
  using (
    org_id in (
      select org_id from memberships where user_id = auth.uid()
    )
  );


-- ─── updated_at trigger ─────────────────────────────────────────────────────
-- Reuse the existing project trigger function `set_updated_at()` if it
-- exists; otherwise this is a no-op.
do $$
begin
  if exists (select 1 from pg_proc where proname = 'set_updated_at') then
    drop trigger if exists industry_benchmarks_set_updated_at on industry_benchmarks;
    create trigger industry_benchmarks_set_updated_at
      before update on industry_benchmarks
      for each row execute function set_updated_at();
  end if;
end$$;
