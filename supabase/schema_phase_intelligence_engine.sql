-- Public Company AI Intelligence — Phase A schema migration.
--
-- Adds 8 tables that back the macro-to-micro risk engine described in
-- docs/PUBLIC-COMPANY-AI-INTELLIGENCE-PLAN.md. All tables are GLOBAL scope
-- (no RLS) — same convention as the existing public_companies + public_company_periods
-- tables, because intelligence data is universe-wide reference, not org-scoped.
--
-- The ONLY org-scoped table is `intelligence_manual_signals` — operator uploads
-- are private to the uploading org until promoted to global by the operator.
-- (Phase A: org-scoped is the default for safety.)
--
-- §14 deploy protocol applies:
--   1. apply this SQL via Supabase Studio
--   2. click "Reload schema cache" in Supabase → Settings → API (DETERMINISTIC step)
--   3. verify pgrst visibility via scripts/_pgrst_visibility.py
--   4. confirm /api/public/intelligence/health responds 200
--
-- Idempotent: ALTER TABLE / CREATE TABLE IF NOT EXISTS — safe to re-run after
-- a Postgres restore or fresh-environment setup.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. intelligence_signals — the unified signal feed
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS intelligence_signals (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    signal_type                 TEXT NOT NULL,         -- SignalType enum
    title                       TEXT NOT NULL,
    summary                     TEXT NOT NULL,
    source                      TEXT NOT NULL,         -- "sector_model:Semiconductors", "manual:alex", etc.
    source_url                  TEXT,
    severity                    TEXT NOT NULL,         -- low|medium|high|critical
    time_horizon                TEXT NOT NULL,         -- immediate|3m|12m|long_term
    confidence                  NUMERIC(4,3) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    published_at                TIMESTAMPTZ,
    affected_sectors            TEXT[] DEFAULT '{}',
    affected_industries         TEXT[] DEFAULT '{}',
    affected_companies          TEXT[] DEFAULT '{}',
    affected_tickers            TEXT[] DEFAULT '{}',
    geography                   TEXT[] DEFAULT '{}',
    financial_impact_channels   TEXT[] DEFAULT '{}',
    risk_categories             TEXT[] DEFAULT '{}',
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at                  TIMESTAMPTZ            -- optional auto-prune
);
CREATE INDEX IF NOT EXISTS idx_intsig_published_at ON intelligence_signals (published_at DESC);
CREATE INDEX IF NOT EXISTS idx_intsig_signal_type  ON intelligence_signals (signal_type);
CREATE INDEX IF NOT EXISTS idx_intsig_tickers      ON intelligence_signals USING GIN (affected_tickers);
CREATE INDEX IF NOT EXISTS idx_intsig_sectors      ON intelligence_signals USING GIN (affected_sectors);
CREATE INDEX IF NOT EXISTS idx_intsig_categories   ON intelligence_signals USING GIN (risk_categories);

-- ─────────────────────────────────────────────────────────────────────────
-- 2. company_exposure_profiles — manual + filings-derived overrides
--
-- Phase A doesn't actually WRITE here — every profile is built on-the-fly
-- from the sector library. This table exists so Phase B (filings extraction)
-- and operator manual overrides have a home WITHOUT changing the route layer
-- (build_company_exposure_profile already takes a `manual_overrides` arg).
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS company_exposure_profiles (
    ticker                   TEXT PRIMARY KEY,
    company_name             TEXT,
    sector                   TEXT,
    industry                 TEXT,
    geographic_exposure      JSONB NOT NULL DEFAULT '{}'::jsonb,
    supply_chain_exposure    JSONB NOT NULL DEFAULT '{}'::jsonb,
    financial_sensitivity    JSONB NOT NULL DEFAULT '{}'::jsonb,
    main_risks               JSONB NOT NULL DEFAULT '[]'::jsonb,
    main_opportunities       JSONB NOT NULL DEFAULT '[]'::jsonb,
    confidence               NUMERIC(4,3) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    source                   TEXT NOT NULL CHECK (source IN ('filings','sector_model','ai_inferred','manual')),
    last_updated             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by               TEXT,
    notes                    TEXT
);

-- ─────────────────────────────────────────────────────────────────────────
-- 3. public_company_risk_scores — cached score snapshots
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public_company_risk_scores (
    ticker                   TEXT NOT NULL,
    computed_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    overall_risk_score       INT NOT NULL CHECK (overall_risk_score BETWEEN 0 AND 100),
    risk_level               TEXT NOT NULL,
    categories               JSONB NOT NULL,
    top_risks                JSONB NOT NULL DEFAULT '[]'::jsonb,
    top_opportunities        JSONB NOT NULL DEFAULT '[]'::jsonb,
    explanation              TEXT,
    confidence               NUMERIC(4,3),
    engine_version           TEXT NOT NULL DEFAULT 'v1',
    PRIMARY KEY (ticker, computed_at)
);
CREATE INDEX IF NOT EXISTS idx_risk_scores_ticker ON public_company_risk_scores (ticker, computed_at DESC);

-- ─────────────────────────────────────────────────────────────────────────
-- 4. public_company_opportunity_scores
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public_company_opportunity_scores (
    ticker                       TEXT NOT NULL,
    computed_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    overall_opportunity_score    INT NOT NULL CHECK (overall_opportunity_score BETWEEN 0 AND 100),
    strength_level               TEXT NOT NULL,
    top_opportunities            JSONB NOT NULL DEFAULT '[]'::jsonb,
    explanation                  TEXT,
    confidence                   NUMERIC(4,3),
    engine_version               TEXT NOT NULL DEFAULT 'v1',
    PRIMARY KEY (ticker, computed_at)
);
CREATE INDEX IF NOT EXISTS idx_opp_scores_ticker ON public_company_opportunity_scores (ticker, computed_at DESC);

-- ─────────────────────────────────────────────────────────────────────────
-- 5. sector_risk_models — operator overrides on the in-code library
--
-- Phase A: the SECTOR_RISK_LIBRARY in Python is the source of truth. This
-- table lets operators tweak a sector profile (e.g. raise a risk severity)
-- WITHOUT a code deploy. Empty at Phase A. The lookup order in
-- company_exposure_service is: DB row > Python library default.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sector_risk_models (
    sector                   TEXT PRIMARY KEY,
    risks                    JSONB NOT NULL DEFAULT '[]'::jsonb,
    opportunities            JSONB NOT NULL DEFAULT '[]'::jsonb,
    default_geographic_exposure  JSONB DEFAULT '{}'::jsonb,
    default_supply_chain_exposure JSONB DEFAULT '{}'::jsonb,
    default_financial_sensitivity JSONB DEFAULT '{}'::jsonb,
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by               TEXT,
    notes                    TEXT
);

-- ─────────────────────────────────────────────────────────────────────────
-- 6. company_signal_links — many-to-many between signals and tickers
--
-- Denormalization: intelligence_signals.affected_tickers already lists
-- the tickers, but this join table makes per-ticker queries (e.g. "give
-- me all signals affecting NVDA in the last 30 days") cheap via index.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS company_signal_links (
    signal_id                UUID NOT NULL REFERENCES intelligence_signals(id) ON DELETE CASCADE,
    ticker                   TEXT NOT NULL,
    linked_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    link_reason              TEXT,                           -- "explicit", "sector_model", "industry_match", etc.
    PRIMARY KEY (signal_id, ticker)
);
CREATE INDEX IF NOT EXISTS idx_csl_ticker ON company_signal_links (ticker);
CREATE INDEX IF NOT EXISTS idx_csl_signal ON company_signal_links (signal_id);

-- ─────────────────────────────────────────────────────────────────────────
-- 7. macro_signal_cache — TTL cache for outbound provider responses
--
-- Parallel to nasdaq_responses but for the news/RSS/commodity/rates feeds.
-- Empty at Phase A (no live adapters configured yet).
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS macro_signal_cache (
    cache_key                TEXT PRIMARY KEY,
    provider                 TEXT NOT NULL,
    payload                  JSONB NOT NULL,
    fetched_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at               TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mscache_expires_at ON macro_signal_cache (expires_at);

-- ─────────────────────────────────────────────────────────────────────────
-- 8. risk_interpretations — cached AI Market Read narratives
--
-- Each row is one Claude-generated narrative tied to (subject, computed_at).
-- Subjects can be tickers, sectors, or "universe". TTL applies — re-run
-- generation when the underlying score changes meaningfully.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS risk_interpretations (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subject                  TEXT NOT NULL,
    subject_kind             TEXT NOT NULL CHECK (subject_kind IN ('ticker','sector','universe')),
    headline                 TEXT NOT NULL,
    summary                  TEXT NOT NULL,
    top_risks                JSONB NOT NULL DEFAULT '[]'::jsonb,
    top_opportunities        JSONB NOT NULL DEFAULT '[]'::jsonb,
    what_to_watch            JSONB NOT NULL DEFAULT '[]'::jsonb,
    confidence               NUMERIC(4,3),
    model_id                 TEXT NOT NULL,
    source_signal_ids        UUID[] DEFAULT '{}',
    feed_status              TEXT NOT NULL,
    computed_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at               TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_risk_interp_subject ON risk_interpretations (subject, subject_kind, computed_at DESC);


-- ─────────────────────────────────────────────────────────────────────────
-- F3.24 / Lock #9 — schema-migration discipline: trigger PostgREST reload.
-- After running this SQL, ALSO click "Reload schema cache" in
-- Supabase Dashboard → Settings → API. The NOTIFY below is the optimistic
-- complement; the Dashboard click is the deterministic step.
-- ─────────────────────────────────────────────────────────────────────────
NOTIFY pgrst, 'reload schema';
