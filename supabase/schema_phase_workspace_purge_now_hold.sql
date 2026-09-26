-- A HELD archive can never be permanently deleted from the workspace hub.
--
-- The one-company-per-workspace migration (scripts/workspace_migration.py,
-- 2026-09-21) archives workspaces with `purge_after` NULL: the per-user
-- holding workspace "Arhivă (migrare <date>)" that keeps every archived
-- period, and the no-company workspaces it splits (whose storage objects are
-- the ORIGINALS the rollback, scripts/db_restore.py, points documents back
-- at). NULL means "no deletion date": `purge_expired_workspaces()` keys on
-- `purge_after is not null and purge_after < now()` and never selects them.
--
-- But `purge_workspace(p_org_id)` — "Delete forever" on the hub — checked
-- only owner + archived, so one click erased the archive (periods,
-- documents, metrics and every object under '<org>/'). This file adds the
-- missing guard: an archived workspace with NO purge date is HELD, and
-- purge_workspace refuses it. Nothing else changes.
--
-- Deliberately NOT guarded: `_purge_org_data` / `_purge_org_content`.
-- `delete_my_account()` and `delete_all_my_data()` (schema_phase_account_
-- deletion.sql) call them for EVERY workspace the user owns — erasing the
-- user's own archives with their account is the point of those calls, and
-- a guard in the shared body would make account deletion raise.
--
-- `workspace_hold_guard_version()` is a marker the migration script reads
-- from PostgREST's OpenAPI document (a GET): `--execute` refuses to create
-- a held archive while this guard is not installed.
--
-- ── OPERATOR RUNBOOK (locked discipline — §14 / F3.24) ────────────────
-- 1. Apply AFTER schema_phase_workspace_purge_now.sql (this file redefines
--    its purge_workspace; the file name sorts after it on purpose).
-- 2. Run this SQL in Supabase Studio (includes the NOTIFY at the bottom).
-- 3. IMMEDIATELY click Supabase Dashboard → Settings → API →
--    "Reload schema cache".
-- 4. Only then run scripts/workspace_migration.py --execute.
-- Idempotent: safe to re-run. Re-running schema_phase_workspace_purge_now.
-- sql afterwards REMOVES the guard — re-run this file after it, always.
-- ─────────────────────────────────────────────────────────────────────

create or replace function purge_workspace(p_org_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from memberships
    where org_id = p_org_id and user_id = auth.uid() and role = 'owner'
  ) then
    raise exception 'Only a workspace owner can permanently delete it.'
      using errcode = '42501';
  end if;

  if not exists (
    select 1 from organizations
    where id = p_org_id and archived_at is not null
  ) then
    raise exception 'Only an archived workspace can be permanently deleted.'
      using errcode = 'P0001';
  end if;

  -- HELD: archived with no deletion date (the workspace migration's holding
  -- archive and the workspaces it split). Never erased from here.
  if exists (
    select 1 from organizations
    where id = p_org_id and archived_at is not null and purge_after is null
  ) then
    raise exception 'This archived workspace is held (it has no deletion date) and cannot be permanently deleted.'
      using errcode = 'P0001';
  end if;

  perform _purge_org_data(p_org_id);
end;
$$;

create or replace function workspace_hold_guard_version()
returns int
language sql
immutable
set search_path = public
as $$ select 1 $$;

revoke execute on function purge_workspace(uuid) from public, anon;
grant execute on function purge_workspace(uuid) to authenticated;

revoke all on function workspace_hold_guard_version() from public, anon, authenticated;
grant execute on function workspace_hold_guard_version() to service_role;

-- F3.24 schema-migration discipline: optimistic PostgREST reload.
NOTIFY pgrst, 'reload schema';
