-- Add DIO columns to sku_aggregates.
--
-- Root cause (2026-05-26 audit): Trading_analysis_YTDMar'26.xlsx uploads
-- correctly parsed the per-category DIO map (Analysis sheet cols 60-63
-- + DIO sheet Region 2) and `aggregate_sku_lines` assigned per-SKU DIO
-- via the category fallback. But the INSERT into `sku_aggregates`
-- failed silently because the table was created without these columns —
-- pipeline.py:2754 catches the PostgREST schema error, retries the
-- insert WITHOUT the DIO fields, and logs:
--
--   [sales] DIO columns absent from sku_aggregates; inserted N rows
--   without them (add the columns to persist DIO).
--
-- The retry preserves the rest of the upload at the cost of dropping
-- every DIO value. Frontend then renders `—` on every category card
-- because the SKU rows it aggregates have null DIO. Adding the columns
-- ends the silent-drop path; the next /rerun or fresh upload populates
-- them from the parsed DIO map and the cards finally show real values.
--
-- All columns are nullable so existing rows keep working. No backfill
-- needed for old data — the rerun endpoint (Products › DatasetsPanel ›
-- "Rerun") re-extracts DIO from the source XLSX and updates each row
-- whose category appears in the merged DIO map.
--
-- Run this in Supabase Studio SQL editor (or via psql) once. Idempotent.

alter table sku_aggregates
  add column if not exists days_inventory_on_hand numeric(10, 2),
  add column if not exists inventory_value_krn    numeric(14, 2),
  add column if not exists cogs_krn               numeric(14, 2);

-- Sanity check after running — should show three new column rows.
-- comment out before committing if you don't want it to fire on re-run.
-- select column_name, data_type, is_nullable
--   from information_schema.columns
--  where table_name = 'sku_aggregates'
--    and column_name in ('days_inventory_on_hand', 'inventory_value_krn', 'cogs_krn')
--  order by column_name;


-- ─────────────────────────────────────────────────────────────────────
-- F3.24 (2026-05-26) — invalidate PostgREST schema cache after schema change.
-- Backfilled retroactively into existing migration files so re-running them
-- after a Postgres restore or fresh-environment setup stays safe. Harmless
-- on already-applied migrations. See CLAUDE.md §14 discipline rule.
-- ─────────────────────────────────────────────────────────────────────
NOTIFY pgrst, 'reload schema';
