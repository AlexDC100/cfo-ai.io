-- A HELD archive can be neither archived again with a deletion date nor
-- restored by its owner behind the operator's back.
--
-- The one-company-per-workspace migration (scripts/workspace_migration.py,
-- 2026-09-21) archives workspaces with `purge_after` NULL: the per-user
-- holding workspace "Arhivă (migrare <date>)" that keeps every archived
-- period, and the no-company workspaces it splits; its rollback
-- (scripts/db_restore.py --plan) archives the workspaces a run created the
-- same way. HELD means: listed nowhere in the hub (frontend/lib/org.ts
-- archivedWorkspaces() requires purge_after), never selected by
-- purge_expired_workspaces(), refused by purge_workspace()
-- (schema_phase_workspace_purge_now_hold.sql). Two RPCs still reached it:
--
--   * archive_workspace(p_org_id) updated `where id = p_org_id` with no
--     state check. Called on a held archive — its owner holds the
--     membership the migration created, and a stale client can still name
--     the id — it set purge_after = now() + 30 days, and the cron purge
--     erased the archive a month later: the archived periods, every row
--     scoped to them, and the ORIGINAL storage objects the rollback points
--     documents back at.
--   * restore_workspace(p_org_id) un-archived any archived workspace of
--     its owner. A held one came back live, holding what the migration
--     split out of it — another company's periods, a second copy of a
--     served month — beside the workspace that now serves that company.
--
-- This file adds the guards, nothing else changes:
--   · archive_workspace archives ONLY a live workspace (`and archived_at is
--     null`) and RAISES when no row matched — already archived, held or in
--     its recovery window. The owner check, the 30-day window, the
--     active_org_id bounce and the 2026-07-25 "the last workspace may be
--     archived" rule are kept.
--   · restore_workspace refuses a HELD archive (archived_at set, purge_after
--     NULL) unless the caller is the service role. The migration and its
--     rollback un-archive through PostgREST as the service role
--     (engine.workspaces.pgrest_io), never through this RPC; the door is
--     left for an operator on the SQL editor. An archive in its recovery
--     window restores as before.
--
-- `workspace_archive_hold_guard_version()` is the marker the migration
-- script reads from PostgREST's OpenAPI document (a GET, never called):
-- `--execute` refuses to create a held archive while this guard is not
-- installed, exactly as it does for the purge guard.
--
-- ── OPERATOR RUNBOOK (locked discipline — §14 / F3.24) ────────────────
-- 1. Apply AFTER schema_phase_multi_workspace.sql and
--    schema_phase_allow_delete_last_workspace.sql (this file redefines their
--    archive_workspace / restore_workspace) and AFTER
--    schema_phase_workspace_purge_now_hold.sql (the purge side of the same
--    hold; the migration script requires both markers).
-- 2. Run this SQL in Supabase Studio (includes the NOTIFY at the bottom).
-- 3. IMMEDIATELY click Supabase Dashboard → Settings → API →
--    "Reload schema cache".
-- 4. Only then run scripts/workspace_migration.py --execute: its dry-run
--    prints "ARCHIVE HOLD GUARD MISSING" until PostgREST exposes
--    workspace_archive_hold_guard_version.
-- Idempotent: safe to re-run. Re-running schema_phase_multi_workspace.sql
-- or schema_phase_allow_delete_last_workspace.sql afterwards REMOVES the
-- guards — re-run this file after them, always.
-- ─────────────────────────────────────────────────────────────────────

-- Soft-delete: hide a LIVE workspace and schedule permanent deletion in 30
-- days. An archived workspace — held (no deletion date) or in its recovery
-- window — is never archived again: that would give a held archive the
-- deletion date it must not have.
create or replace function archive_workspace(p_org_id uuid)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  v_purge_after timestamptz;
  v_rows int;
begin
  if not exists (
    select 1 from memberships
    where org_id = p_org_id and user_id = auth.uid() and role = 'owner'
  ) then
    raise exception 'Only a workspace owner can archive it.' using errcode = '42501';
  end if;

  -- (2026-07-25) The "cannot archive your only workspace" guard is
  -- intentionally absent — the zero-workspace state is supported.

  v_purge_after := now() + interval '30 days';
  update organizations
     set archived_at = now(), purge_after = v_purge_after
   where id = p_org_id
     and archived_at is null;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    raise exception 'This workspace is already archived and cannot be archived again (a held archive keeps no deletion date).'
      using errcode = 'P0001';
  end if;

  -- Anyone sitting in this workspace gets bounced to another (or to the empty
  -- state) on next load.
  update user_prefs set active_org_id = null where active_org_id = p_org_id;

  return v_purge_after;
end;
$$;

-- Restore an archived workspace from its recovery window. A HELD archive
-- (archived_at set, purge_after NULL) is the workspace migration's — only
-- the service role brings it back.
create or replace function restore_workspace(p_org_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_service boolean := coalesce(auth.jwt() ->> 'role', '') = 'service_role';
begin
  if not v_service and not exists (
    select 1 from memberships
    where org_id = p_org_id and user_id = auth.uid() and role = 'owner'
  ) then
    raise exception 'Only a workspace owner can restore it.' using errcode = '42501';
  end if;

  if not v_service and exists (
    select 1 from organizations
    where id = p_org_id and archived_at is not null and purge_after is null
  ) then
    raise exception 'This archived workspace is held by the workspace migration and can only be restored by an operator.'
      using errcode = 'P0001';
  end if;

  update organizations
     set archived_at = null, purge_after = null
   where id = p_org_id;
end;
$$;

create or replace function workspace_archive_hold_guard_version()
returns int
language sql
immutable
set search_path = public
as $$ select 1 $$;

revoke execute on function archive_workspace(uuid) from public, anon;
grant execute on function archive_workspace(uuid) to authenticated;
revoke execute on function restore_workspace(uuid) from public, anon;
grant execute on function restore_workspace(uuid) to authenticated;

revoke all on function workspace_archive_hold_guard_version() from public, anon, authenticated;
grant execute on function workspace_archive_hold_guard_version() to service_role;

-- F3.24 schema-migration discipline: optimistic PostgREST reload.
NOTIFY pgrst, 'reload schema';
