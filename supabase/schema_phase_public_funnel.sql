-- schema_phase_public_funnel.sql — signup attribution for the public
-- funnel (Lane 5, public-data acquisition engine, 2026-08-28).
--
-- ═══════════════════════════ OPERATOR RUNBOOK ═══════════════════════════
-- 1. Run this whole file in Supabase Studio (SQL editor). The NOTIFY at
--    the bottom is the optimistic PostgREST reload signal.
-- 2. IMMEDIATELY click "Reload schema cache" in Supabase Dashboard →
--    Settings → API. On Supabase managed infrastructure the NOTIFY alone
--    is NOT sufficient (CLAUDE.md §14 schema-migration discipline,
--    locked after F3.16-3b.5). If the new column still 400s via REST,
--    toggle any API setting (e.g. Max Rows) to force a PostgREST worker
--    restart; if all three signals fail, follow the
--    [F3.25-SUPABASE-POSTGREST-CACHE-PERSISTENT-STALENESS] escalation.
-- 3. Idempotent: safe to re-run (IF NOT EXISTS + create-or-replace).
-- ════════════════════════════════════════════════════════════════════════
--
-- What this adds:
--   * profiles.first_touch jsonb — the immutable first-touch attribution
--     blob captured client-side (frontend/lib/attribution.ts: utm_*,
--     ft_cui, landing_path, referrer, captured_at) and passed through
--     supabase.auth.signUp options.data → raw_user_meta_data.
--   * A SECOND, additive trigger on auth.users that lifts
--     raw_user_meta_data->'first_touch' into profiles.first_touch.
--     Deliberately NOT a rewrite of handle_new_user_v2 (schema_phase3.sql)
--     — duplicating that body here would drift. Trigger name sorts AFTER
--     'on_auth_user_created' so the profiles row already exists when it
--     fires (same-event triggers run in name order).
--
-- What this deliberately does NOT add:
--   * No cohort column. public_only vs activated is COMPUTED server-side
--     (engine.public_ro.funnel.cohort_for_user) from attribution + the
--     user_usage uploads counters — never stored as a mutable flag.
--   * No funnel-events table in Supabase. Anonymous public-page events
--     live in data/public_ro.db (SQLite), keyed by a daily-salted IP
--     hash — they never join to auth.users and don't belong here.

alter table public.profiles
  add column if not exists first_touch jsonb;

create or replace function public.handle_new_user_public_funnel()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.raw_user_meta_data ? 'first_touch' then
    update public.profiles
       set first_touch = new.raw_user_meta_data->'first_touch'
     where id = new.id
       and first_touch is null;   -- first touch is immutable once set
  end if;
  return new;
end;
$$;

-- Security-hardening discipline (schema_phase_security_hardening.sql):
-- no PUBLIC/anon/authenticated EXECUTE on SECURITY DEFINER functions.
revoke execute on function public.handle_new_user_public_funnel()
  from public, anon, authenticated;

drop trigger if exists on_auth_user_created_public_funnel on auth.users;
create trigger on_auth_user_created_public_funnel
  after insert on auth.users
  for each row execute function public.handle_new_user_public_funnel();

-- first_touch is covered by the existing own-row RLS on profiles
-- (select/update own row); no new policy needed. The engine reads it
-- via the service role for the funnel rollup.

NOTIFY pgrst, 'reload schema';
