-- Security hardening — closes every finding from the Supabase security
-- advisor scan of 2026-07-23.
--
-- The one REAL vulnerability in the batch:
--
--   `current_user_usage` (schema_phase5_usage_limits.sql:158) was a
--   SECURITY DEFINER view over subscriptions × user_usage with NO
--   auth.uid() filter, and SELECT granted to anon. Despite the name, it
--   returned EVERY user's tier, trial dates, and usage counters to any
--   unauthenticated visitor holding the public anon key. Nothing in the
--   codebase reads it (the backend uses `user_usage` + `subscriptions`
--   directly via service role), so it was pure attack surface.
--
-- Everything else is defense-in-depth:
--   · `founding_member_count` — served to the FE via the backend endpoint
--     /api/founding-member/count (service role), never queried directly by
--     clients, so its anon grant + SECURITY DEFINER were unnecessary.
--   · SECURITY DEFINER functions carried the default PUBLIC EXECUTE grant,
--     so `anon` could call them. Harmless today (every one either checks
--     auth.uid()/membership or is a trigger body), but pointless surface.
--   · Seven backend-only tables (email queues, logs, caches, leads) had
--     RLS deny-all but still held the default anon/authenticated table
--     grants.
--   · Two functions had a mutable search_path.
--
-- NOT fixed here (done via the Management API, not SQL): leaked-password
-- protection (HIBP) — `PATCH /v1/projects/{ref}/config/auth
-- {"password_hibp_enabled": true}`.
--
-- Remaining advisor entries that are BY DESIGN after this file:
--   · rls_enabled_no_policy (INFO) on the seven backend-only tables —
--     deny-all is the intended posture; only the service role touches
--     them. Do not add decorative policies.
--
-- ⚠ Ordering: re-running `schema_phase5_usage_limits.sql` re-creates the
-- two views WITHOUT security_invoker and re-grants them to anon. If that
-- file is ever re-applied (fresh environment, restore), re-run THIS file
-- afterwards.
--
-- ── OPERATOR RUNBOOK (locked discipline — §14 / F3.24) ────────────────
-- 1. Run this SQL in Supabase Studio (includes the NOTIFY at the bottom).
-- 2. IMMEDIATELY click Supabase Dashboard → Settings → API →
--    "Reload schema cache".
-- 3. Verify: the backend's /api/founding-member/count must still return
--    real numbers (service role path), and an anon
--    `GET /rest/v1/current_user_usage` must now be denied.
-- ─────────────────────────────────────────────────────────────────────

-- ─────────── 1. The leaking view ───────────────────────────────────────────
-- security_invoker makes the view enforce the QUERYING role's RLS; the
-- revokes close direct access for API roles entirely. The service role
-- (backend) bypasses RLS and keeps working.

alter view current_user_usage set (security_invoker = true);
revoke all on current_user_usage from anon, authenticated;

-- ─────────── 2. founding_member_count ──────────────────────────────────────
-- The seat counter reaches the FE only through /api/founding-member/count.

alter view founding_member_count set (security_invoker = true);
revoke all on founding_member_count from anon, authenticated;

-- ─────────── 3. SECURITY DEFINER function grants ───────────────────────────
-- Postgres grants EXECUTE to PUBLIC by default on new functions, which is
-- how `anon` ended up able to call all of these.

-- Called by signed-in clients — keep `authenticated`, drop PUBLIC/anon.
revoke execute on function public.is_member_of(uuid)                      from public, anon;
revoke execute on function public.list_workspaces()                       from public, anon;
revoke execute on function public.create_workspace(text, text, text)      from public, anon;
revoke execute on function public.archive_workspace(uuid)                 from public, anon;
revoke execute on function public.restore_workspace(uuid)                 from public, anon;
revoke execute on function public.set_user_pref(text, jsonb)              from public, anon;
revoke execute on function public.set_org_pref(uuid, text, jsonb)         from public, anon;

grant execute on function public.is_member_of(uuid)                       to authenticated;
grant execute on function public.list_workspaces()                        to authenticated;
grant execute on function public.create_workspace(text, text, text)       to authenticated;
grant execute on function public.archive_workspace(uuid)                  to authenticated;
grant execute on function public.restore_workspace(uuid)                  to authenticated;
grant execute on function public.set_user_pref(text, jsonb)               to authenticated;
grant execute on function public.set_org_pref(uuid, text, jsonb)          to authenticated;

-- Never called by clients: trigger bodies (run as table owner, need no
-- caller EXECUTE) and the backend-only daily chat counter
-- (_plan_state.py calls it via the service role).
revoke execute on function public.handle_new_user()                            from public, anon, authenticated;
revoke execute on function public.handle_new_user_v2()                         from public, anon, authenticated;
revoke execute on function public.increment_plan_chat_daily(uuid, date, int)   from public, anon, authenticated;

-- ─────────── 4. Backend-only tables: drop default API-role grants ──────────
-- All seven already deny via RLS (enabled, zero policies). Removing the
-- table grants makes the deny explicit and survives any future accidental
-- permissive policy.

revoke all on billing_events        from anon, authenticated;
revoke all on contact_sales_leads   from anon, authenticated;
revoke all on detection_opus_cache  from anon, authenticated;
revoke all on email_send_log        from anon, authenticated;
revoke all on founding_members      from anon, authenticated;
revoke all on newsletter_broadcasts from anon, authenticated;
revoke all on renewal_email_queue   from anon, authenticated;

-- ─────────── 5. Pin mutable search_paths ───────────────────────────────────
-- Prevents search_path hijacking inside these definer/trigger bodies.

alter function public.set_updated_at_now() set search_path = public;
alter function public.handle_new_user()    set search_path = public;

-- F3.24 schema-migration discipline: optimistic PostgREST reload.
NOTIFY pgrst, 'reload schema';
