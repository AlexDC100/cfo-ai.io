-- Phase 7b — Deep industry analysis (peers + leader rationale + dynamics).
--
-- The Phase-7 `industry_benchmarks` table holds typical-value percentiles
-- (P25 / P50 / P75) per CAEN. That's useful but thin. Real CFO-grade
-- benchmark reports name peers ("you vs Transavia 24.9% margin"),
-- explain WHY the leader wins (structural reasons with margin impact),
-- and surface industry dynamics + failure modes.
--
-- This migration adds three new tables that hold that qualitative
-- layer. All catalogue data — RLS allows authenticated reads, service
-- role writes via seed scripts. No per-tenant scoping.

-- ─── Named peers per CAEN ──────────────────────────────────────────────────
-- One row per (caen, company). FY-specific, since a peer might be a
-- different scale or profitability in different years.
create table if not exists industry_peers (
  id uuid primary key default gen_random_uuid(),
  caen_code text not null,
  company_name text not null,
  fiscal_year integer not null,
  revenue_mlei numeric,                   -- in million RON
  net_profit_mlei numeric,                -- in million RON (signed)
  net_margin_pct numeric,                 -- already in % (e.g. 24.9)
  ebitda_margin_pct numeric,
  equity_ratio_pct numeric,
  debt_to_equity numeric,
  specialization text,                    -- "Pui integrat (Fragedo)"
  -- 'leader' | 'strong' | 'median' | 'thin_margin' | 'distressed' | 'self'
  -- `self` marks the company that uploaded; we use it to highlight the
  -- "this is you" row in the peer table.
  tier text not null default 'median' check (
    tier in ('leader', 'strong', 'median', 'thin_margin', 'distressed', 'self')
  ),
  source text not null,                   -- "Ministerul Finanțelor 2024" etc
  notes text,
  display_order integer default 0,        -- controls peer-table sort
  created_at timestamptz not null default now(),
  unique (caen_code, company_name, fiscal_year)
);

create index if not exists industry_peers_caen_idx on industry_peers (caen_code, display_order);


-- ─── Why the leader wins — structural reasons ─────────────────────────────
-- Multiple reasons per CAEN, each with a margin-impact estimate. Sum of
-- impacts should approximate the gap between leader and median.
create table if not exists industry_leader_reasons (
  id uuid primary key default gen_random_uuid(),
  caen_code text not null,
  leader_company text not null,           -- duplicated for query convenience
  rank integer not null,                  -- 1..N display order
  title text not null,                    -- "Integrare verticală 100%..."
  description text not null,              -- 1-3 sentences
  margin_impact_pp numeric,               -- "+8.0pp"
  evidence_source text,
  created_at timestamptz not null default now(),
  unique (caen_code, rank)
);

create index if not exists industry_leader_reasons_caen_idx on industry_leader_reasons (caen_code);


-- ─── Industry-level qualitative data ──────────────────────────────────────
-- One row per CAEN. Holds the dynamics / patterns / failure-modes /
-- market-context blocks the deep report needs. Stored as jsonb so we
-- can evolve the schema without migrations.
create table if not exists industry_qualitative (
  id uuid primary key default gen_random_uuid(),
  caen_code text not null unique,
  -- target_tiers: { aspirational:{net,ebitda,comment}, realistic:{...}, minimum_viable:{...} }
  target_tiers jsonb,
  -- dynamics: { concentration:{verdict,detail}, growth:{...}, regulation:{...}, barriers:{...} }
  dynamics jsonb,
  -- list of strings
  success_patterns jsonb,                 -- ["Integrare verticală selectivă...", ...]
  failure_modes jsonb,                    -- ["Aaylex pattern: fuziune...", ...]
  market_context text,                    -- 2-3 paragraph RO market commentary
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);


-- ─── RLS ───────────────────────────────────────────────────────────────────
alter table industry_peers enable row level security;
drop policy if exists "industry_peers_readable_by_authenticated" on industry_peers;
create policy "industry_peers_readable_by_authenticated"
  on industry_peers for select using (auth.role() = 'authenticated');

alter table industry_leader_reasons enable row level security;
drop policy if exists "industry_leader_reasons_readable_by_authenticated" on industry_leader_reasons;
create policy "industry_leader_reasons_readable_by_authenticated"
  on industry_leader_reasons for select using (auth.role() = 'authenticated');

alter table industry_qualitative enable row level security;
drop policy if exists "industry_qualitative_readable_by_authenticated" on industry_qualitative;
create policy "industry_qualitative_readable_by_authenticated"
  on industry_qualitative for select using (auth.role() = 'authenticated');
