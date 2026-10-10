-- supabase/ops/2026-10-10_ban_test_identities.sql
-- =============================================================================
-- APPLIED TO PRODUCTION 2026-10-10T06:05Z (ops_log, "PRODUCTION AUTH: the two
-- test identities BANNED"). OPERATIONAL, NOT A SCHEMA MIGRATION: it changes no
-- table, column, index, policy or grant — it sets `banned_until` on the
-- project's OWN test identities in auth.users. It is kept here so that every
-- production change has a committed file (owner addendum 2026-10-10, item 2).
--
-- WHY. The repository is public and carries a fixed password for the
-- test-mode identity (src/engine/api/_test_mode.py) and a static one for the
-- Playwright sign-ups (e2e/real-e2e.spec.ts). Production auth held one of
-- each (read_18: test_mode_users 1, playwright_users 1). Anyone reading the
-- repository could sign in as them on production and spend on the model keys.
--
-- WHAT IT TOUCHES. Only rows whose e-mail matches the three test patterns
-- below. No customer row. No deletion. Verified after the run:
-- banned_test_identities = 2.
--
-- A FRESH DATABASE does not need this file: the identities do not exist there
-- unless schema_phase_test_mode.sql (test mode only) or a Playwright run
-- against that database created them.
--
-- REVERSAL (the owner's): update auth.users set banned_until = null where …
-- (the same predicate). Follow-ups: tickets T118 / T119 — move both passwords
-- to the environment and make _bootstrap_test_user refuse outside
-- PUBLIC_TEST_MODE.
--
-- RUN WITH: supabase db query --linked -f supabase/ops/2026-10-10_ban_test_identities.sql
-- (the Management API runs it as `postgres`; the last statement's row comes back).
-- =============================================================================

-- RESTRICT-ONLY (owner order 2026-10-10: "apply migrations that add or restrict"). The repository is PUBLIC and carries a
-- fixed password for the test-mode identity (src/engine/api/_test_mode.py) and a static one for Playwright sign-ups
-- (e2e/real-e2e.spec.ts); both identities exist in production auth. Nobody may sign in as them: ban, do not delete.
-- These are the project's own test identities, not customers. Reversible: set banned_until = null.
update auth.users
   set banned_until = '2099-12-31 00:00:00+00'
 where (email ilike 'test%@cfo-ai.io' or email ilike 'playwright+%' or email ilike '%@cfoai.dev')
   and (banned_until is null or banned_until <= now());
select jsonb_build_object(
  'banned_test_identities', (select count(*) from auth.users where (email ilike 'test%@cfo-ai.io' or email ilike 'playwright+%' or email ilike '%@cfoai.dev') and banned_until > now()),
  'users_total', (select count(*) from auth.users)
) as after;
