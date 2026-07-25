-- ============================================================================
-- Allow deleting the LAST workspace (2026-07-25)
--
-- The original archive_workspace() (schema_phase_multi_workspace.sql) refused
-- to archive a user's only remaining workspace ("Cannot archive your only
-- workspace."). The product now supports the zero-workspace state — it's the
-- same state a brand-new signup starts from, and the Workspace hub renders an
-- empty state + Create flow for it — so that guard is removed.
--
-- This redefines archive_workspace() WITHOUT the "only workspace" check. The
-- owner check, the 30-day purge window, and clearing active_org_id (so the
-- user isn't left pointing at an archived org) are all preserved.
--
-- IDEMPOTENT: create-or-replace. Safe to re-run.
-- Apply order: after schema_phase_multi_workspace.sql.
-- ============================================================================

create or replace function archive_workspace(p_org_id uuid)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  v_purge_after timestamptz;
begin
  if not exists (
    select 1 from memberships
    where org_id = p_org_id and user_id = auth.uid() and role = 'owner'
  ) then
    raise exception 'Only a workspace owner can archive it.' using errcode = '42501';
  end if;

  -- (2026-07-25) The "cannot archive your only workspace" guard is
  -- intentionally gone — deleting the last workspace drops the user into the
  -- supported zero-workspace state (hub empty state + Create flow).

  v_purge_after := now() + interval '30 days';
  update organizations
     set archived_at = now(), purge_after = v_purge_after
   where id = p_org_id;

  -- Anyone sitting in this workspace gets bounced to another (or to the empty
  -- state) on next load.
  update user_prefs set active_org_id = null where active_org_id = p_org_id;

  return v_purge_after;
end;
$$;

grant execute on function archive_workspace(uuid) to authenticated;

-- Schema-cache refresh (CLAUDE.md §14/§15 discipline). Harmless here since no
-- columns changed, but kept for consistency with every other migration.
NOTIFY pgrst, 'reload schema';
