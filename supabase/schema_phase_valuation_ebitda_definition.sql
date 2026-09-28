-- ============================================================================
-- User valuation overrides remember the EBITDA definition they were typed
-- under (owner ruling 2026-09-26: account 711 "Variația stocurilor de
-- produse" and 72x own work capitalised are inside EBITDA and the operating
-- result; 767 is financial).
--
-- An EBITDA a user typed into the Valuation tab before the ruling was typed
-- against the EBITDA the page showed then (without the stock variation). The
-- engine keeps the user's figure — it is theirs — but it must say which
-- definition it was typed under. `save_valuation_assumptions` writes
-- `engine.country_packs.ro_romania.chart_of_accounts.EBITDA_DEFINITION_REVISION`
-- here; `_valuation.override_definition_status` serves a row whose stamp is
-- not today's revision (NULL = every row saved before this column existed)
-- with the flag "salvat sub definiția anterioară a EBITDA".
--
-- Nullable, no default: NULL means "saved before the stamp existed", which
-- is exactly the set of rows the flag is for.
--
-- OPERATOR RUNBOOK (CLAUDE.md §14 schema-migration discipline) — apply
-- BEFORE the backend that writes the column is switched in:
--   1. Run this file in Supabase Studio (idempotent).
--   2. Dashboard → Settings → API → "Reload schema cache" (the NOTIFY below
--      is optimistic on Supabase managed infrastructure).
--   3. Verify through the REST API, not pg_catalog:
--        GET /rest/v1/user_valuation_assumptions?select=ebitda_definition&limit=1
--      must answer 200. Until it does, PUT /api/period/{id}/valuation-
--      assumptions fails (PostgREST rejects the unknown column) — do not
--      switch the backend in before this passes.
-- ============================================================================

alter table public.user_valuation_assumptions
  add column if not exists ebitda_definition text;

comment on column public.user_valuation_assumptions.ebitda_definition is
  'EBITDA definition revision the override was saved under (chart_of_accounts.EBITDA_DEFINITION_REVISION); NULL = saved before 2026-09-26.';

-- PostgREST schema-cache refresh (CLAUDE.md §14 discipline).
NOTIFY pgrst, 'reload schema';
