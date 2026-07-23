-- Cross-device preferences.
--
-- Settings lived in ~20 localStorage keys, so a user who signed in on another
-- machine got defaults: wrong display currency, wrong decision thresholds,
-- light theme, onboarding banners they'd already dismissed.
--
-- They are split by NATURE, not stored in one bag:
--
--   · PERSONAL  → user_prefs.prefs (created in schema_phase_multi_workspace.sql)
--     Follows the human across every workspace: theme, UI language, learning
--     mode, dismissed banners, cookie consent.
--
--   · COMPANY   → org_prefs.prefs (this file)
--     Belongs to one SRL and MUST change when you switch workspace: display
--     currency, decision rules / thresholds, scenario levers, budget
--     comparison, benchmark peers, dashboard view. Keeping these per-user
--     would carry a RON manufacturer's thresholds into a EUR property vehicle.
--
-- Device-local settings deliberately stay in localStorage and are NOT synced:
-- sidebar collapsed, docs/datasets panel open flags, DocsPanel filters,
-- upload-resume state, the aicfo.* run caches and the *-verdict:* caches.
-- Those describe THIS screen, not the user or the company.
--
-- Both columns are jsonb bags rather than one column per setting: these are
-- UI preferences with no referential integrity to enforce and a long tail of
-- additions, so a schema migration per toggle would be pure friction. Anything
-- the engine needs to reason about (industry_key, default_currency) already
-- has a real typed column on `organizations`.
--
-- ── OPERATOR RUNBOOK (locked discipline — §14 / F3.24) ────────────────
-- 1. Apply supabase/schema_phase_multi_workspace.sql FIRST (user_prefs +
--    organizations + is_member_of live there).
-- 2. Run this SQL in Supabase Studio (includes the NOTIFY at the bottom).
-- 3. IMMEDIATELY click Supabase Dashboard → Settings → API →
--    "Reload schema cache".
-- 4. Verify PostgREST sees it — this must NOT 400:
--      select org_id, prefs from org_prefs limit 1;
-- ─────────────────────────────────────────────────────────────────────

create table if not exists org_prefs (
  org_id     uuid primary key references organizations(id) on delete cascade,
  prefs      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table org_prefs enable row level security;

-- Company settings are shared by everyone in the workspace — unlike chats,
-- these describe the company, so any member reads and writes them.
drop policy if exists "org_prefs member select" on org_prefs;
drop policy if exists "org_prefs member insert" on org_prefs;
drop policy if exists "org_prefs member update" on org_prefs;

create policy "org_prefs member select"
  on org_prefs for select using (is_member_of(org_id));
create policy "org_prefs member insert"
  on org_prefs for insert with check (is_member_of(org_id));
create policy "org_prefs member update"
  on org_prefs for update using (is_member_of(org_id)) with check (is_member_of(org_id));

drop trigger if exists org_prefs_set_updated_at on org_prefs;
create trigger org_prefs_set_updated_at
  before update on org_prefs
  for each row execute function set_updated_at_now();

-- ─────────── Partial-update helpers ────────────────────────────────────────
-- Preferences are written one key at a time from independent stores (currency,
-- decision rules, learning mode…). A read-modify-write from the client would
-- make concurrent writes clobber each other — flip the theme and set a
-- threshold in two tabs, and the slower write erases the faster one.
-- `||` merges server-side so each write only touches its own key.

create or replace function set_user_pref(p_key text, p_value jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prefs jsonb;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated.' using errcode = '28000';
  end if;
  insert into user_prefs (user_id, prefs)
  values (auth.uid(), jsonb_build_object(p_key, p_value))
  on conflict (user_id) do update
    set prefs = user_prefs.prefs || jsonb_build_object(p_key, p_value),
        updated_at = now()
  returning prefs into v_prefs;
  return v_prefs;
end;
$$;

create or replace function set_org_pref(p_org_id uuid, p_key text, p_value jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prefs jsonb;
begin
  -- SECURITY DEFINER bypasses RLS, so re-assert membership explicitly.
  if not is_member_of(p_org_id) then
    raise exception 'Not a member of this workspace.' using errcode = '42501';
  end if;
  insert into org_prefs (org_id, prefs)
  values (p_org_id, jsonb_build_object(p_key, p_value))
  on conflict (org_id) do update
    set prefs = org_prefs.prefs || jsonb_build_object(p_key, p_value),
        updated_at = now()
  returning prefs into v_prefs;
  return v_prefs;
end;
$$;

grant execute on function set_user_pref(text, jsonb)       to authenticated;
grant execute on function set_org_pref(uuid, text, jsonb)  to authenticated;

-- F3.24 schema-migration discipline: optimistic PostgREST reload.
NOTIFY pgrst, 'reload schema';
