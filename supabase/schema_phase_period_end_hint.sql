-- ============================================================================
-- Period-end hint on documents (2026-07-25)
--
-- The upload flow now auto-detects each trial balance's closing month from its
-- filename and lets the user confirm or edit it BEFORE analysis. The chosen
-- date is written to `documents.period_end_hint`; the engine's stage_persist
-- prefers it over its own filename/content detection so the period is filed
-- under exactly the month the user confirmed.
--
-- Nullable — when the user leaves it blank (or on legacy uploads) the engine
-- falls back to its existing detection, so this is fully backward-compatible.
--
-- IDEMPOTENT. Apply any time; frontend degrades gracefully when it's absent
-- (uploadDocument retries the insert without the column).
-- ============================================================================

alter table documents
  add column if not exists period_end_hint date;

-- PostgREST schema-cache refresh (CLAUDE.md §14/§15 discipline).
NOTIFY pgrst, 'reload schema';
