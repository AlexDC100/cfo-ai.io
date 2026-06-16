-- ─────────────────────────────────────────────────────────────────────────────
-- schema_phase_test_mode.sql — Public test-mode seed
-- ─────────────────────────────────────────────────────────────────────────────
-- WHEN TO APPLY:
--   Only run this migration when the deployment will be flipped into
--   PUBLIC_TEST_MODE (env vars `PUBLIC_TEST_MODE=1` on BE,
--   `VITE_PUBLIC_TEST_MODE=1` on FE bundle).
--
-- WHAT IT DOES:
--   Seeds a single synthetic identity that the BE+FE agree on:
--
--     auth.users  ── id 00000000-0000-4000-8000-000000000001
--                    email "test@cfo-ai.io"
--     organizations  id 00000000-0000-4000-8000-000000000002
--                    name "Test workspace"
--                    industry_key "food_manufacturing"
--     memberships  ── joins the two with role="owner"
--
--   The synthetic user_id matches `_DEFAULT_TEST_USER_ID` in
--   `src/engine/api/_test_mode.py` and `TEST_USER_ID` in
--   `scandi-desk-main/src/lib/testMode.ts`. The synthetic org_id matches
--   `_DEFAULT_TEST_ORG_ID` / `TEST_ORG_ID`. If the operator overrides
--   either via env vars (`TEST_USER_ID` / `TEST_ORG_ID` BE-side,
--   `VITE_TEST_USER_ID` / `VITE_TEST_ORG_ID` FE-side), the same UUIDs
--   must be applied to this migration's INSERTs before running it.
--
-- IDEMPOTENCY:
--   Every INSERT uses `ON CONFLICT DO NOTHING` so re-running this file
--   on an already-seeded database is a no-op. Safe to apply multiple
--   times during operator drills.
--
-- TURN-OFF PROCEDURE:
--   Test mode is gated by the env flag, not by the seed rows. Flipping
--   `PUBLIC_TEST_MODE` to "0" (or removing the var) is sufficient — the
--   seed rows can stay in place. To physically delete them after retiring
--   test mode, run:
--
--     delete from memberships where user_id = '00000000-0000-4000-8000-000000000001';
--     delete from organizations where id   = '00000000-0000-4000-8000-000000000002';
--     delete from auth.users    where id   = '00000000-0000-4000-8000-000000000001';
--
--   These deletes cascade cleanly through the FKs declared in schema_phase3.sql.
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── 1. Synthetic auth.users row ─────────────────────────────────────────────
-- Required because `memberships.user_id` references `auth.users(id)` with
-- ON DELETE CASCADE. Without this row the membership insert below would
-- 409 on the FK constraint.
--
-- The row is intentionally INCOMPLETE — no encrypted_password, no
-- confirmation tokens — because no one ever signs in as this user. The
-- BE auth bypass (see `_test_mode.is_bypass_token` + `_billing._require_jwt`)
-- short-circuits before any password check; the FE auth bypass (see
-- `AuthProvider` in `src/lib/auth.tsx`) returns a synthetic session
-- object without consulting Supabase. So the auth.users row's only job
-- is satisfying the FK on memberships.
--
-- `aud='authenticated'`, `role='authenticated'` mirror the shape Supabase
-- creates for a normal sign-up so any code path that introspects these
-- fields (very rare) sees expected values.

insert into auth.users (
  id,
  instance_id,
  aud,
  role,
  email,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
)
values (
  '00000000-0000-4000-8000-000000000001'::uuid,
  '00000000-0000-0000-0000-000000000000'::uuid,
  'authenticated',
  'authenticated',
  'test@cfo-ai.io',
  now(),
  jsonb_build_object('provider', 'test_mode', 'providers', array['test_mode']),
  jsonb_build_object(
    'display_name', 'Test visitor',
    'company_name', 'Test workspace'
  ),
  now(),
  now()
)
on conflict (id) do nothing;


-- ─── 2. Test organization (the shared workspace) ─────────────────────────────
-- Industry preseeded as `food_manufacturing` to skip AuthGuard's
-- onboarding bounce (`needsOnboarding` returns true while industry_key
-- is null). Test mode visitors never need to pick an industry.

insert into organizations (
  id,
  name,
  industry_key,
  industry_display_name,
  default_currency,
  created_at,
  updated_at
)
values (
  '00000000-0000-4000-8000-000000000002'::uuid,
  'Test workspace',
  'food_manufacturing',
  'Food manufacturing',
  'RON',
  now(),
  now()
)
on conflict (id) do nothing;


-- ─── 3. Membership joining the two ───────────────────────────────────────────
-- Role 'owner' so `_primary_org_for_user(test_user_id)` resolves and
-- any owner-gated UI surface (currently none reachable in test mode,
-- but defensively) lets the synthetic user pass.

insert into memberships (
  user_id,
  org_id,
  role,
  created_at
)
values (
  '00000000-0000-4000-8000-000000000001'::uuid,
  '00000000-0000-4000-8000-000000000002'::uuid,
  'owner',
  now()
)
on conflict (user_id, org_id) do nothing;


-- ─── 4. PostgREST schema-cache reload ────────────────────────────────────────
-- Per Lock #13 / CLAUDE.md §14 schema-migration discipline (2026-05-26):
-- emit the NOTIFY so vanilla PostgREST picks up the seed rows immediately.
-- On Supabase managed infra this is best-effort — the deterministic
-- action is to click "Reload schema cache" in
-- Supabase Dashboard → Settings → API right after running this file.
--
-- Because this migration only inserts data (no DDL), the reload is
-- belt-and-braces, not strictly required — but the discipline says
-- every schema_phase_*.sql file ends with NOTIFY.

notify pgrst, 'reload schema';
