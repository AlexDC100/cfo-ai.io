-- CFO AI — F4.1e: persist assembled_canonical_v1 envelope on financial_periods.
-- =============================================================================
-- Apply after schema_phase_f3_calibration.sql (and any later phase migrations).
-- Idempotent.
--
-- WHAT THIS ADDS
--   - financial_periods.assembled_canonical_v1 (JSONB, NULL by default).
--     Holds the country-agnostic canonical envelope emitted by the engine's
--     assemble_canonical adapter (see CANONICAL_SCHEMA_V1.md §3a wide-grained
--     buckets, §3b always-positive magnitudes + sign_meaning metadata).
--     Written at stage_persist time on every TB pipeline run. NULL on periods
--     processed before F4.1e (back-compat: NULL is the "not yet canonicalized"
--     sentinel; new periods always get populated).
--
-- WHY JSONB AND NOT BROKEN-OUT COLUMNS
--   - The canonical envelope is ~3-10 KB per period (79 BS + 55 PL + 25 CF
--     leaves with sign_meaning + ras source mapping). Breaking 159 buckets
--     into individual columns would multiply table width by ~20× for a value
--     read whole-or-not-at-all.
--   - JSONB lets us evolve the schema (add a new bucket in v1.1, deprecate
--     one in v2) without ALTER TABLE per change; the envelope's own
--     schema_version field gates compatibility (F3.15 §3e parallel migration).
--   - PostgreSQL's JSONB GIN index covers field-level queries when the
--     analytics layer needs them (e.g. SELECT periods WHERE
--     assembled_canonical_v1->'aggregates'->'total_assets'->>'net' > '...').
--
-- WHAT THIS DOES NOT DO
--   - Does NOT backfill historical periods. NULL on pre-F4.1e rows. When the
--     pipeline re-runs a period (re-upload, re-extract), the column gets
--     populated. Read paths fall back to recomputing on-the-fly via
--     assemble_statements (mirrors how assembled_bs/pl/cf already work).
--   - Does NOT remove or shadow assembled_bs/pl/cf — F3.15 §3e parallel
--     migration discipline: legacy fields stay byte-identical for at least
--     2 quarters after canonical reaches feature parity.
--   - Does NOT add a JSONB index yet. Defer the GIN index to F4.4 (the
--     detection-routing chunk) where the query patterns are known. An
--     unindexed JSONB column is fine for write-everything-read-whole.

-- ─── financial_periods.assembled_canonical_v1 (JSONB) ───────────────────
-- Idempotent: re-running this migration on a DB where the column already
-- exists is a no-op. The IF NOT EXISTS clause is PG 9.6+; supabase is 14+.
alter table financial_periods
  add column if not exists assembled_canonical_v1 jsonb;

-- Comment for the operator browsing pg_dump / Supabase studio.
comment on column financial_periods.assembled_canonical_v1 is
  'Country-agnostic canonical envelope (CANONICAL_SCHEMA_V1.md). '
  'Populated at stage_persist time when the engine emits assembled_canonical_v1. '
  'NULL on periods processed before F4.1e (2026-05-23). '
  'Read path on get_period also recomputes on-the-fly from line_items, so a '
  'NULL persisted value does not block consumers — DB persistence is for '
  'archive, offline analytics, and audit.';


-- ─────────────────────────────────────────────────────────────────────
-- F3.24 (2026-05-26) — invalidate PostgREST schema cache after schema change.
-- Backfilled retroactively into existing migration files so re-running them
-- after a Postgres restore or fresh-environment setup stays safe. Harmless
-- on already-applied migrations. See CLAUDE.md §14 discipline rule.
-- ─────────────────────────────────────────────────────────────────────
NOTIFY pgrst, 'reload schema';
