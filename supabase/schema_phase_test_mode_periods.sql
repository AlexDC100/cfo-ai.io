-- ─────────────────────────────────────────────────────────────────────────────
-- schema_phase_test_mode_periods.sql — restore the sentinel's period containers
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY THIS EXISTS (2026-09-06).
--   The junk-workspace cleanup filtered `organizations` by NAME
--   (`name = 'Test workspace'`). The sentinel org
--   00000000-0000-4000-8000-000000000002 — hardcoded as `_DEFAULT_TEST_ORG_ID`
--   in src/engine/api/_test_mode.py and `TEST_ORG_ID` in
--   frontend/lib/testMode.ts — was ITSELF named "Test workspace", so the
--   filter took it, and the cascade took its 4 financial_periods and every
--   document with it. Measured after the cleanup: 0 organizations rows for
--   that id, 0 financial_periods, 0 documents.
--
--   `schema_phase_test_mode.sql` restores the identity (auth.users +
--   organizations + memberships). It does NOT restore periods, because
--   periods were never seed data — they accumulated from visitor uploads.
--   This file restores the four EMPTY period containers the design-shot
--   harness records as its floor, so `usePeriodStepper().periods` is a real
--   list again rather than a genuine zero.
--
--   Empty containers are a first-class state, not a fiction: the Workspace
--   tab creates a period with no file attached, which is exactly why
--   usePeriodStepper merges the direct Supabase feed alongside the engine
--   feed (see the comment at frontend/lib/usePeriodStepper.ts:48).
--
-- ORDER:
--   1. supabase/schema_phase_test_mode.sql   (identity — must run first)
--   2. THIS FILE                             (period containers)
--   3. Dashboard → Settings → API → "Reload schema cache"
--
-- IDEMPOTENCY:
--   `where not exists` rather than `on conflict`, deliberately. The unique
--   constraint is (org_id, period_end, source_document_id) and these rows
--   carry source_document_id = NULL — Postgres treats NULLs as DISTINCT in a
--   unique index, so `on conflict` would NOT dedupe and a second run would
--   insert four more containers. Re-running this file is a no-op.
--
-- SAFETY:
--   Scoped to the sentinel org id and to four literal dates. It cannot touch
--   another organization's periods, and it creates no documents.
-- ─────────────────────────────────────────────────────────────────────────────

insert into financial_periods (org_id, period_start, period_end, currency)
select v.org_id, v.period_start, v.period_end, 'RON'
from (values
  ('00000000-0000-4000-8000-000000000002'::uuid, date '2025-12-01', date '2025-12-31'),
  ('00000000-0000-4000-8000-000000000002'::uuid, date '2026-07-01', date '2026-07-31'),
  ('00000000-0000-4000-8000-000000000002'::uuid, date '2026-08-01', date '2026-08-31'),
  ('00000000-0000-4000-8000-000000000002'::uuid, date '2026-09-01', date '2026-09-30')
) as v(org_id, period_start, period_end)
where not exists (
  select 1 from financial_periods fp
  where fp.org_id = v.org_id
    and fp.period_end = v.period_end
    and fp.source_document_id is null
);

-- Per CLAUDE.md §14 schema-migration discipline: every schema_phase_*.sql ends
-- with the NOTIFY. Data-only here, so it is belt-and-braces — the Dashboard
-- "Reload schema cache" click remains the deterministic action.
notify pgrst, 'reload schema';
