-- ─────────────────────────────────────────────────────────────────────────
-- Account-level destructive actions — Settings → Danger zone
-- ─────────────────────────────────────────────────────────────────────────
--
-- Adds the two RPCs behind the GitHub-style type-to-confirm dialogs:
--
--   delete_all_my_data()  — erases the CONTENT of every workspace the caller
--                           owns (documents, periods, analyses, alerts,
--                           chats, storage objects) but KEEPS the workspaces
--                           and the account. The user lands back on an empty
--                           but working app.
--   delete_my_account()   — erases those workspaces entirely AND the auth
--                           user. Irreversible; the caller is signed out
--                           because their identity no longer exists.
--
-- WHY THE TABLE LIST ISN'T COPIED: schema_phase_workspace_purge_now.sql
-- already documents that two copies of the purge list drift, and a drifted
-- purge silently orphans rows (most `org_id` columns have no FK to
-- `organizations`). So this file EXTRACTS the existing body into
-- `_purge_org_content(uuid)` — content only, no `organizations` row — and
-- redefines `_purge_org_data(uuid)` as "content + drop the org row". Same
-- signature, same semantics, still exactly one table list, now shared by
-- four callers (cron purge, single-workspace purge, delete-all-data,
-- delete-account).
--
-- ⚠ ORDERING: this file redefines `_purge_org_data`. If
-- schema_phase_workspace_purge_now.sql is ever re-run afterwards it restores
-- the old single-function form and `_purge_org_content` loses its only
-- caller — re-run THIS file after it, the same way
-- schema_phase_security_hardening.sql must follow schema_phase5.
--
-- OWNER-ONLY: both RPCs act on orgs where the caller's membership role is
-- 'owner'. Workspaces the caller merely belongs to are untouched — their
-- membership row disappears with the account (FK cascade) but the
-- workspace and its data survive for the other members.
--
-- OPERATOR RUNBOOK
--   1. Apply schema_phase_multi_workspace.sql and
--      schema_phase_workspace_purge_now.sql first.
--   2. Run this file in Supabase Studio.
--   3. IMMEDIATELY click Dashboard → Settings → API → "Reload schema cache".
--   4. Smoke-test on a THROWAWAY account before letting it near real users.
--      There is no undo for either call.
--
-- Idempotent: safe to re-run.

-- ── Shared purge body — CONTENT ONLY ────────────────────────────────────
-- Everything scoped to an org except the `organizations` row itself.
create or replace function _purge_org_content(p_org_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_table text;
  -- THE canonical org-scoped table list. Add new org-scoped tables here and
  -- every purge path picks them up at once.
  v_tables text[] := array[
    'billing_events', 'benchmark_peers', 'coa_mappings', 'datasets',
    'activity', 'recommendations', 'alert_states', 'alerts',
    'sku_analyses', 'calculated_metrics', 'briefings',
    'invoices', 'financial_periods', 'documents',
    'chat_threads', 'org_prefs'
  ];
begin
  foreach v_table in array v_tables loop
    if to_regclass('public.' || v_table) is not null then
      execute format('delete from public.%I where org_id = $1', v_table)
        using p_org_id;
    end if;
  end loop;

  -- Uploaded files live under {org_id}/uploads/… in the documents bucket.
  delete from storage.objects
   where bucket_id = 'documents'
     and (storage.foldername(name))[1] = p_org_id::text;
end;
$$;

-- ── Existing entry point, re-pointed at the shared body ─────────────────
-- Unchanged signature + semantics: content, then the org row (memberships
-- and other FK-bearing children cascade from it).
create or replace function _purge_org_data(p_org_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform _purge_org_content(p_org_id);
  delete from organizations where id = p_org_id;
end;
$$;

-- ── Delete all my data (keep the account and the workspaces) ────────────
create or replace function delete_all_my_data()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org record;
  v_count int := 0;
begin
  if auth.uid() is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;

  for v_org in
    select org_id from memberships
    where user_id = auth.uid() and role = 'owner'
  loop
    perform _purge_org_content(v_org.org_id);
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

-- ── Delete my account (everything, including the auth user) ─────────────
create or replace function delete_my_account()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_org record;
begin
  if v_uid is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;

  -- Owned workspaces go completely — content, storage, and the org row.
  for v_org in
    select org_id from memberships
    where user_id = v_uid and role = 'owner'
  loop
    perform _purge_org_data(v_org.org_id);
  end loop;

  -- User-scoped rows with NO foreign key to auth.users — these would be
  -- left behind by the cascade below. (profiles, subscriptions, user_usage,
  -- user_prefs and memberships all cascade on delete and need no help.)
  if to_regclass('public.plan_chat_daily_usage') is not null then
    delete from plan_chat_daily_usage where user_id = v_uid;
  end if;

  -- Deliberately NOT deleted: `founding_members` and
  -- `newsletter_subscribers` both declare `on delete set null` on their
  -- user_id, i.e. the row is meant to outlive the account — a surrendered
  -- founding seat still counts against the cohort, and an unsubscribe
  -- record has to survive so a deleted user isn't re-mailed.

  -- Finally the identity itself. Everything with an `on delete cascade`
  -- reference to auth.users goes with it. This runs as the function owner
  -- (postgres), which is why a normal client can't do it directly.
  delete from auth.users where id = v_uid;
end;
$$;

-- ── Grants (per schema_phase_security_hardening.sql discipline) ─────────
-- Internal bodies: service role only, never reachable from a client.
revoke all on function _purge_org_content(uuid) from public, anon, authenticated;
grant execute on function _purge_org_content(uuid) to service_role;

revoke all on function _purge_org_data(uuid) from public, anon, authenticated;
grant execute on function _purge_org_data(uuid) to service_role;

-- The two user-facing calls must be callable by a signed-in client; each
-- re-asserts auth.uid() and owner-role internally.
revoke all on function delete_all_my_data() from public, anon;
grant execute on function delete_all_my_data() to authenticated;

revoke all on function delete_my_account() from public, anon;
grant execute on function delete_my_account() to authenticated;

-- F3.24 schema-migration discipline: optimistic PostgREST reload. The
-- deterministic step is the Dashboard "Reload schema cache" click.
NOTIFY pgrst, 'reload schema';
