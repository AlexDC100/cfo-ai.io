-- ============================================================================
-- sku_lines.dio_days — the column the SKU pipeline has been writing all along
--
-- Root cause (2026-07-26): `_sales_extract.py` puts `dio_days` on every parsed
-- line whenever the workbook carries explicit DIO columns (or a category DIO
-- map resolves one). `pipeline.py::stage_persist` inserts each line dict into
-- `sku_lines` verbatim — it only strips `inventory_value` / `cogs`
-- (`_LINE_INSERT_EXCLUDE`). `sku_lines` never had a `dio_days` column, so
-- PostgREST rejected the bulk insert (PGRST204), the code fell back to
-- per-row inserts, and EVERY row failed the same way:
--
--   [sales] dropped row product='BRAND-ONE Tomato cubes' reason=... 400
--   {"code":"PGRST204","message":"Could not find the 'dio_days' column of
--    'sku_lines' in the schema cache"}
--
-- The document still finished as `analyzed` (row drops are non-fatal), so the
-- UI reported success over a dataset with zero SKU lines and zero aggregates
-- — an upload that looked fine and showed nothing.
--
-- Adding the column is the additive half of the fix: nothing else in the
-- insert shape is missing, and per-line DIO is real parsed data worth keeping
-- (`sku_aggregates` already carries its rolled-up sibling
-- `days_inventory_on_hand`, added in schema_phase_sku_dio_columns.sql).
--
-- Nullable, so every existing row stays valid. No backfill: historical
-- datasets were written before the parser emitted DIO, and Products ›
-- Datasets › "Rerun" re-extracts a file when its DIO matters.
--
-- Idempotent. Safe to re-run.
-- ============================================================================

alter table sku_lines
  add column if not exists dio_days numeric(10, 2);

comment on column sku_lines.dio_days is
  'Days inventory on hand for this SKU line, parsed from the source workbook (explicit column or per-category DIO map). Nullable — most files do not carry it.';

-- ---------------------------------------------------------------------------
-- Reversal:
--   alter table sku_lines drop column if exists dio_days;
--   (Dropping it re-opens the silent row-drop above, so only revert together
--    with an engine change that excludes dio_days from the insert.)
-- ---------------------------------------------------------------------------

-- Schema-migration discipline (CLAUDE.md): optimistic PostgREST reload; on
-- Supabase managed infra ALSO click Dashboard → Settings → API → "Reload
-- schema cache" after applying.
NOTIFY pgrst, 'reload schema';
