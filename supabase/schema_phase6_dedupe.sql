-- ============================================================================
-- Phase 6 — Document dedupe by content hash + period delete cascade hardening
--
-- Additive. Adds an indexed `content_hash` column on `documents` so the
-- frontend can detect re-uploads of the same file BEFORE inserting a
-- duplicate row. Existing rows have NULL content_hash; that's fine — the
-- dedupe check skips them, and future uploads will populate the column.
--
-- The migration is idempotent. Safe to re-run.
-- ============================================================================

-- 1. content_hash column for upload-time dedupe
alter table documents
  add column if not exists content_hash text;

-- Partial index over not-deleted rows only — the FE filters dedupe checks
-- to active uploads (deleted_at IS NULL), so this matches the read pattern.
create index if not exists documents_content_hash_idx
  on documents (org_id, content_hash)
  where deleted_at is null and content_hash is not null;

comment on column documents.content_hash is
  'SHA-256 of the uploaded file bytes (hex, 64 chars). Populated client-side at upload. Used to detect duplicate uploads.';

-- 2. ON DELETE CASCADE hardening for period-scoped derivatives.
-- The DELETE /api/period/{id} endpoint runs explicit deletes per table, but
-- a CASCADE constraint is a defense-in-depth so a future code path can't
-- orphan rows. Where the FK already exists with ON DELETE CASCADE this
-- is a no-op; otherwise it backfills the constraint.
--
-- We use DO blocks because the constraint name varies between deployments
-- (Postgres auto-names them when the schema file uses inline REFERENCES).

do $$
declare
  c record;
begin
  for c in
    select table_name, constraint_name
    from information_schema.table_constraints
    where constraint_type = 'FOREIGN KEY'
      and table_schema = 'public'
      and table_name in (
        'statement_line_items', 'calculated_metrics', 'briefings',
        'valuations', 'alerts', 'user_valuation_assumptions'
      )
  loop
    -- Check whether this FK references financial_periods.id
    if exists (
      select 1
      from information_schema.referential_constraints rc
      join information_schema.constraint_column_usage ccu
        on rc.unique_constraint_name = ccu.constraint_name
      where rc.constraint_name = c.constraint_name
        and ccu.table_name = 'financial_periods'
    ) then
      -- Drop + recreate with ON DELETE CASCADE. The old FK column name is
      -- always `period_id` in our schema.
      execute format(
        'alter table %I drop constraint if exists %I',
        c.table_name, c.constraint_name
      );
      execute format(
        'alter table %I add constraint %I foreign key (period_id) references financial_periods(id) on delete cascade',
        c.table_name, c.constraint_name
      );
    end if;
  end loop;
end$$;

-- ---------------------------------------------------------------------------
-- Reversal:
--   alter table documents drop column if exists content_hash;
--   drop index if exists documents_content_hash_idx;
--   (FK cascade hardening — re-create constraints without ON DELETE CASCADE
--    if you need to roll back. The original schema doesn't specify CASCADE
--    so reverting is "just leave it"; the only behavioral change is that
--    deleting a period now cleans up derivatives at the DB level.)
-- ---------------------------------------------------------------------------

-- Schema-migration discipline (CLAUDE.md): optimistic PostgREST reload; on
-- Supabase managed infra ALSO click Dashboard → Settings → API → "Reload
-- schema cache" after applying.
NOTIFY pgrst, 'reload schema';
