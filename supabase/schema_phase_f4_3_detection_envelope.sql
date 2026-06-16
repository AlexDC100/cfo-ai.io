-- CFO AI — F4.3: persist detection envelope on financial_periods.
-- =============================================================================
-- Apply after schema_phase_f4_canonical_v1.sql. Idempotent.
--
-- WHAT THIS ADDS
--   - financial_periods.detection_envelope (JSONB, NULL by default).
--     Holds the §7 detection envelope from CANONICAL_SCHEMA_V1.md —
--     country/standard/doc_type/industry detection with confidence +
--     evidence, methodology_version pin, routing decision (F4.4),
--     source_data_quality (F3.9).
--   - financial_periods.methodology_version (TEXT, NULL by default).
--     Convenience column duplicating detection_envelope.methodology_version
--     so analytics queries can filter without diving into JSONB. Stays
--     in sync via stage_persist write (no DB trigger needed).
--
-- WHY TWO COLUMNS
--   - JSONB envelope: complete provenance trail per period. Queryable
--     via Postgres JSON operators when needed.
--   - methodology_version scalar: cheap WHERE filter for "show me all
--     periods rendered under ro_ras_2025_v1" without JSONB index.

alter table financial_periods
  add column if not exists detection_envelope jsonb,
  add column if not exists methodology_version text;

comment on column financial_periods.detection_envelope is
  'F4.3 — country/standard/doc_type/industry detection envelope per '
  'CANONICAL_SCHEMA_V1.md §7. Populated at stage_persist time. NULL '
  'on periods processed before F4.3 (2026-05-23). Read path also '
  'serves a freshly-built envelope via on-the-fly recompute.';

comment on column financial_periods.methodology_version is
  'F4.3 — convenience scalar of detection_envelope.methodology_version. '
  'NULL on pre-F4.3 periods. Kept in sync by stage_persist write — no '
  'DB trigger; the JSONB envelope is the source of truth.';


-- ─────────────────────────────────────────────────────────────────────
-- F3.24 (2026-05-26) — invalidate PostgREST schema cache after schema change.
-- Backfilled retroactively into existing migration files so re-running them
-- after a Postgres restore or fresh-environment setup stays safe. Harmless
-- on already-applied migrations. See CLAUDE.md §14 discipline rule.
-- ─────────────────────────────────────────────────────────────────────
NOTIFY pgrst, 'reload schema';
