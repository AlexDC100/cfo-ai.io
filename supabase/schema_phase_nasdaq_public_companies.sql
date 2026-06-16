-- CFO AI — NASDAQ-2: public-company data model (Nasdaq / Sharadar SF1 + DAILY).
-- =============================================================================
-- Apply after schema_phase_f4_canonical_v1.sql.
-- Idempotent.
--
-- WHAT THIS ADDS
--   1. public_companies            — global ticker registry (ticker = key)
--   2. public_company_periods      — fundamentals per (ticker × dimension ×
--                                    fiscal_period_end), with assembled_canonical_v1
--                                    JSONB column that mirrors the same shape
--                                    private periods carry. FE renderers don't
--                                    need to know the difference.
--   3. public_company_quotes       — daily market-derived metrics (market cap,
--                                    EV, P/E, EV/EBITDA, etc.)
--   4. nasdaq_responses            — raw payload cache, keyed by (table, ticker,
--                                    dim_or_date, query_hash) so the engine can
--                                    avoid re-hitting the wire and can also
--                                    re-normalize older payloads when the
--                                    canonical schema evolves.
--   5. benchmark_peers             — per-user peer selections (org-scoped).
--                                    Decoupled from public_companies so future
--                                    peer sources (private peer dashboards,
--                                    sector composites) can FK into the same
--                                    table.
--
-- RLS DESIGN
--   • public_companies / public_company_periods / public_company_quotes /
--     nasdaq_responses are GLOBAL — AAPL fundamentals are the same for every
--     user, so RLS would only hurt cache effectiveness without any privacy
--     benefit. Public ticker data is, by definition, public.
--   • benchmark_peers is org-scoped via auth.uid() — each org sees only its
--     own peer selections. Same pattern as financial_periods.
--   • Write paths to global tables run via the backend's service_role key,
--     which bypasses RLS. End users never write to these tables directly.
--
-- WHY assembled_canonical_v1 ON public_company_periods
--   The whole architectural trick: the FE consumes the same envelope shape
--   for public + private periods. PLStatementView, computeRatios, NavCascade
--   don't branch on source. To enable that, the public path must persist the
--   same JSONB column shape that F4.1e introduced for private periods. The
--   normalizer (engine/public/normalizer.py, NASDAQ-4) is responsible for
--   bridging US-GAAP Sharadar columns → the bucket-level canonical schema.
--
-- WHY source_payload IS A SEPARATE COLUMN FROM assembled_canonical_v1
--   Lesson from F4.1c-f calibration: when the canonical schema evolves
--   (e.g. v1.1 adds a new bucket), we need to re-run the normalizer over
--   historical Sharadar payloads. Storing the raw response keeps that path
--   open without re-hitting Sharadar (and re-spending API quota).

-- ─── 1. public_companies (global ticker registry) ──────────────────────

create table if not exists public_companies (
  id uuid primary key default gen_random_uuid(),
  -- Sharadar ticker (uppercase). Composite "BRK.B" style stored verbatim.
  ticker text not null unique,
  -- Display name from Sharadar TICKERS table (e.g. "Apple Inc").
  name text not null,
  -- Optional metadata — sector + industry feed industry-benchmark routing.
  sector text,
  industry text,
  exchange text,                -- "NASDAQ", "NYSE", "AMEX"
  country text default 'US',
  -- Reporting currency. Sharadar SF1 normalizes US-listed to USD.
  currency text not null default 'USD',
  isin text,
  is_active boolean not null default true,
  -- When the engine first synced this ticker / last successfully re-synced.
  -- NULL on first_synced means we know the ticker (from a search hit) but
  -- haven't fetched fundamentals yet.
  first_synced_at timestamptz,
  last_synced_at timestamptz,
  -- Free-form sync notes (last sync's NasdaqPartialData flags, etc.).
  last_sync_notes jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists public_companies_ticker_lower_idx
  on public_companies (lower(ticker));
create index if not exists public_companies_name_idx
  on public_companies (lower(name));
create index if not exists public_companies_sector_idx
  on public_companies (sector);

drop trigger if exists public_companies_set_updated_at on public_companies;
create trigger public_companies_set_updated_at
  before update on public_companies
  for each row execute function set_updated_at_now();

comment on table public_companies is
  'Global registry of public-company tickers known to the engine. '
  'Populated by Nasdaq Data Link / Sharadar TICKERS lookups. No RLS — public '
  'tickers are public information. Writes are backend-only via service_role.';


-- ─── 2. public_company_periods (fundamentals per period) ───────────────

create table if not exists public_company_periods (
  id uuid primary key default gen_random_uuid(),
  public_company_id uuid not null references public_companies(id) on delete cascade,
  -- Dimension code from Sharadar SF1:
  --   ARY / ARQ / ART = As Reported (annual / quarterly / trailing 12mo)
  --   MRY / MRQ / MRT = Most Recently Reported (restatement-aware variants)
  dimension text not null check (dimension in ('ARY','ARQ','ART','MRY','MRQ','MRT')),
  -- Fiscal period end date. For ART/MRT this is the trailing-12mo end date.
  fiscal_period_end date not null,
  -- Display label generated at sync time ("FY2024", "Q3 2025", "TTM 2025-Q3").
  period_label text not null,
  -- The reporting currency for THIS period. Usually matches
  -- public_companies.currency but kept per-row in case a historical filing
  -- was in a different unit (rare; ADRs etc.).
  currency text not null default 'USD',
  -- The canonical envelope. Same shape as private financial_periods'
  -- assembled_canonical_v1 column. FE renderers consume this directly.
  assembled_canonical_v1 jsonb,
  -- Raw Sharadar SF1 row (one period). Preserved so the engine can
  -- re-run the normalizer when the canonical schema evolves without
  -- re-paying Sharadar API quota.
  source_payload jsonb,
  -- Where the row came from (always 'nasdaq' in v1; reserved for future
  -- sources — EDGAR direct, BVB, LSE, etc.).
  source text not null default 'nasdaq',
  -- Sync provenance.
  synced_at timestamptz not null default now(),
  -- Engine version that normalized this row. Lets us detect rows that
  -- need re-normalization after a normalizer change ("rows older than
  -- v1.2 will be lazily re-normalized on next read").
  normalizer_version text,
  -- One row per (company, dimension, fiscal_period_end). Re-sync upserts.
  unique (public_company_id, dimension, fiscal_period_end)
);

create index if not exists public_company_periods_company_idx
  on public_company_periods (public_company_id, dimension, fiscal_period_end desc);
create index if not exists public_company_periods_synced_idx
  on public_company_periods (synced_at desc);

comment on table public_company_periods is
  'Fundamentals per (ticker × dimension × fiscal_period_end). The '
  'assembled_canonical_v1 JSONB column carries the same envelope shape as '
  'private financial_periods so frontend renderers (PLStatementView, '
  'BSStatementView, ratios engine) consume it without branching on source. '
  'source_payload preserves the raw Sharadar response for re-normalization.';


-- ─── 3. public_company_quotes (daily market metrics) ───────────────────

create table if not exists public_company_quotes (
  public_company_id uuid not null references public_companies(id) on delete cascade,
  as_of date not null,
  -- Currency for all amounts on this row. Usually USD; per-row for clarity.
  currency text not null default 'USD',
  -- Market metrics from Sharadar DAILY table. NULL means the metric was
  -- not provided for this ticker/date (Sharadar's DAILY coverage varies
  -- by ticker quality + subscription level).
  market_cap numeric(20, 2),
  enterprise_value numeric(20, 2),
  ev_ebitda numeric(20, 4),
  ev_ebit numeric(20, 4),
  ev_revenue numeric(20, 4),
  pe_ratio numeric(20, 4),
  pb_ratio numeric(20, 4),
  ps_ratio numeric(20, 4),
  dividend_yield numeric(10, 6),
  -- Provenance.
  synced_at timestamptz not null default now(),
  primary key (public_company_id, as_of)
);

create index if not exists public_company_quotes_as_of_idx
  on public_company_quotes (public_company_id, as_of desc);

comment on table public_company_quotes is
  'Daily market-derived metrics (market cap, EV, P/E, EV/EBITDA). One row '
  'per (company, trading day). Drives the Valuation tab on public-company '
  'dashboards. NULL columns mean Sharadar did not provide that metric for '
  'this ticker/date.';


-- ─── 4. nasdaq_responses (raw payload cache) ───────────────────────────

create table if not exists nasdaq_responses (
  -- Composite cache key. See engine/public/cache.py.
  table_name text not null,                 -- "SHARADAR/SF1", "SHARADAR/DAILY", "SHARADAR/TICKERS"
  ticker text not null default '',          -- '' for non-ticker-keyed responses (e.g. search)
  dimension_or_date text not null default '', -- "ARY", "2026-05-24", or '' for tickers table
  query_hash text not null,                 -- 16-char sha256 of full query params
  payload jsonb not null,                   -- raw Nasdaq response body
  fetched_at timestamptz not null default now(),
  expires_at timestamptz not null,
  primary key (table_name, ticker, dimension_or_date, query_hash)
);

create index if not exists nasdaq_responses_expires_idx
  on nasdaq_responses (expires_at);

comment on table nasdaq_responses is
  'Cache for raw Nasdaq Data Link responses. TTLs: 24h fundamentals, '
  '15min daily-metrics during US market hours (6h otherwise), 7d tickers '
  'reference. Survives backend restarts. No RLS — pure shared cache.';


-- ─── 5. benchmark_peers (per-user peer selections) ─────────────────────

create table if not exists benchmark_peers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default auth.uid(),
  -- Discriminator: 'public' (FK to public_companies), 'private' (reserved
  -- for future feature — currently always 'public').
  peer_kind text not null check (peer_kind in ('public', 'private')),
  -- Populated when peer_kind = 'public'. Reserved column for future kinds.
  public_company_id uuid references public_companies(id) on delete cascade,
  -- Default dimension to use when rendering this peer in comparisons.
  default_dimension text default 'ARY' check (
    default_dimension in ('ARY','ARQ','ART','MRY','MRQ','MRT')
  ),
  -- Optional user-supplied display order (for the peer cards rail).
  sort_order int default 0,
  -- Optional user-supplied label override (e.g. "Apple — main peer").
  display_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One peer entry per (org, kind, target). Re-adding upserts the timestamps.
  unique (org_id, peer_kind, public_company_id)
);

create index if not exists benchmark_peers_org_idx
  on benchmark_peers (org_id, sort_order);

drop trigger if exists benchmark_peers_set_updated_at on benchmark_peers;
create trigger benchmark_peers_set_updated_at
  before update on benchmark_peers
  for each row execute function set_updated_at_now();

alter table benchmark_peers enable row level security;

drop policy if exists "benchmark_peers owner select" on benchmark_peers;
drop policy if exists "benchmark_peers owner insert" on benchmark_peers;
drop policy if exists "benchmark_peers owner update" on benchmark_peers;
drop policy if exists "benchmark_peers owner delete" on benchmark_peers;
create policy "benchmark_peers owner select" on benchmark_peers
  for select using (auth.uid() = org_id);
create policy "benchmark_peers owner insert" on benchmark_peers
  for insert with check (auth.uid() = org_id);
create policy "benchmark_peers owner update" on benchmark_peers
  for update using (auth.uid() = org_id);
create policy "benchmark_peers owner delete" on benchmark_peers
  for delete using (auth.uid() = org_id);

comment on table benchmark_peers is
  'Per-user peer selections for the Benchmark page. RLS-scoped to '
  'auth.uid(). Each row points to a public_company (peer_kind=public) and '
  'carries a default dimension + sort order. The compare engine resolves '
  'these peers at render time by reading public_company_periods.assembled_'
  'canonical_v1 and feeding it through the same computeRatios path used '
  'for private periods.';


-- ─────────────────────────────────────────────────────────────────────
-- F3.24 (2026-05-26) — invalidate PostgREST schema cache after schema change.
-- Backfilled retroactively into existing migration files so re-running them
-- after a Postgres restore or fresh-environment setup stays safe. Harmless
-- on already-applied migrations. See CLAUDE.md §14 discipline rule.
-- ─────────────────────────────────────────────────────────────────────
NOTIFY pgrst, 'reload schema';
