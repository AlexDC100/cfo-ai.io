-- ============================================================================
-- A kept briefing remembers that a later narration failed (owner ruling
-- 2026-10-02: "a failed regenerate must NEVER overwrite a stored briefing with
-- [NARRATIVE_UNAVAILABLE] — keep the last good one, mark it stale").
--
-- `briefings` holds ONE row per period and no history. Until this hotfix a
-- narration that failed (the provider refusing, no API key, an unparseable
-- reply) was written over the stored briefing by three writers — POST
-- /api/period/{id}/briefing/regenerate, every re-run of an analysed document
-- (`stage_persist_narrative`) and the same-month takeover — and the last good
-- briefing was gone. Those writers now KEEP the stored row when the new
-- narration is unusable. These two columns are how the kept row says so:
--
--   stale_since   when the FIRST narration since the last good write failed
--                 and this body was kept; NULL = the row is current.
--   stale_reason  a neutral code only: no_api_key | sdk_missing |
--                 provider_error | unparseable_reply | empty_reply |
--                 withheld_numerals. Never provider text, never a plan name.
--
-- GET /api/period/{id} serves them as `briefing.stale {since, reason}` (null
-- when the row is current); a successful briefing write clears both.
--
-- THIS MIGRATION IS OPTIONAL UNTIL APPLIED — and may be applied before OR
-- after the backend is switched in. The marker is written (and cleared) by a
-- SEPARATE best-effort `update` filtered by period_id and org_id, never inside
-- a briefing upsert payload: while these columns do not exist that update is
-- refused by PostgREST (unknown column), the backend logs one line, and every
-- briefing write and read works exactly as before. Until it is applied "stale"
-- is carried only by the regenerate response (shown for the session); after
-- it, the marker survives a reload.
--
-- OPERATOR RUNBOOK (CLAUDE.md §14 schema-migration discipline):
--   1. Run this file in Supabase Studio (idempotent).
--   2. Dashboard → Settings → API → "Reload schema cache" (the NOTIFY below is
--      optimistic on Supabase managed infrastructure).
--   3. Verify through the REST API, not pg_catalog:
--        GET /rest/v1/briefings?select=stale_since,stale_reason&limit=1
--      must answer 200. Until it does the marker is simply not stored (see
--      above) — nothing else depends on it.
-- ============================================================================

alter table public.briefings
  add column if not exists stale_since  timestamptz,
  add column if not exists stale_reason text;

comment on column public.briefings.stale_since is
  'Set when a later narration of this period failed and this (last good) body was kept; NULL = current.';

comment on column public.briefings.stale_reason is
  'Neutral code only (no_api_key | sdk_missing | provider_error | unparseable_reply | empty_reply | withheld_numerals). Never provider text, never a plan name.';

-- PostgREST schema-cache refresh (CLAUDE.md §14 discipline).
NOTIFY pgrst, 'reload schema';
