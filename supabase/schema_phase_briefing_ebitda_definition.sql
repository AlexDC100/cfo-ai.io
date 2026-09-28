-- ============================================================================
-- Briefings remember the EBITDA definition they were written under (owner
-- ruling 2026-09-26: account 711 "Variația stocurilor de produse" and 72x own
-- work capitalised are inside EBITDA and the operating result; 767 is
-- financial; margins divide by net turnover).
--
-- A briefing is prose written once from the numbers of its day. One written
-- before the ruling quotes an EBITDA (and margins, and leverage) the statements
-- no longer serve. The engine never rewrites a stored briefing; it serves
-- every briefing with the definition it was written under, so the page can
-- hide one written under the previous definition with a one-line note instead
-- of showing stale numbers beside the corrected ones.
--
-- `stage_persist_narrative` and POST /briefing/regenerate write
-- `engine.country_packs.ro_romania.chart_of_accounts.EBITDA_DEFINITION_REVISION`
-- here; GET /api/period/{id} serves `briefing.definition`
-- {written_under, current_definition, written_under_previous_definition, note}.
-- NULL = written before this column existed = the previous definition.
--
-- OPERATOR RUNBOOK (CLAUDE.md §14 schema-migration discipline) — apply BEFORE
-- the backend that writes the column is switched in:
--   1. Run this file in Supabase Studio (idempotent).
--   2. Dashboard → Settings → API → "Reload schema cache" (the NOTIFY below is
--      optimistic on Supabase managed infrastructure).
--   3. Verify through the REST API, not pg_catalog:
--        GET /rest/v1/briefings?select=ebitda_definition&limit=1
--      must answer 200. Until it does, every briefing upsert is rejected by
--      PostgREST (unknown column) — the narrate stage is non-fatal, so the
--      pipeline would complete WITHOUT a briefing. Do not switch the backend
--      in before this passes.
-- ============================================================================

alter table public.briefings
  add column if not exists ebitda_definition text;

comment on column public.briefings.ebitda_definition is
  'EBITDA definition revision the briefing was written under (chart_of_accounts.EBITDA_DEFINITION_REVISION); NULL = written before 2026-09-26.';

-- PostgREST schema-cache refresh (CLAUDE.md §14 discipline).
NOTIFY pgrst, 'reload schema';
