-- User-initiated permanent deletion of an archived workspace.
--
-- Until now the ONLY path to permanent deletion was the scheduler
-- (`purge_expired_workspaces()`, service-role, after the 30-day window).
-- The workspace hub now offers "Delete forever" on a recently-deleted
-- workspace, behind a GitHub-style type-the-name confirmation — this file
-- adds the RPC that backs it.
--
-- The actual data removal is refactored into `_purge_org_data(uuid)` so the
-- cron path and the user path share ONE table list. Two copies would drift,
-- and a drifted purge silently orphans rows (most org_id columns have no FK
-- to organizations — see schema_phase_multi_workspace.sql).
--
-- Guards on purge_workspace():
--   · caller must be an OWNER of the org (member is not enough to erase it)
--   · the org must already be ARCHIVED — live workspaces can't be nuked in
--     one call; archive first (which itself refuses the last workspace),
--     then permanently delete. Two distinct, deliberate steps.
--
-- ── OPERATOR RUNBOOK (locked discipline — §14 / F3.24) ────────────────
-- 1. Apply schema_phase_multi_workspace.sql first (organizations.archived_at,
--    memberships, the original purge function live there).
-- 2. Run this SQL in Supabase Studio (includes the NOTIFY at the bottom).
-- 3. IMMEDIATELY click Supabase Dashboard → Settings → API →
--    "Reload schema cache".
-- ─────────────────────────────────────────────────────────────────────

-- Shared purge body. Deletes org-scoped ROOTS explicitly (children cascade
-- via the FKs that do exist); storage objects live under
-- {org_id}/uploads/…; memberships + FK-bearing tables cascade from the
-- organizations row itself.
create or replace function _purge_org_data(p_org_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_table text;
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

  delete from storage.objects
   where bucket_id = 'documents'
     and (storage.foldername(name))[1] = p_org_id::text;

  delete from organizations where id = p_org_id;
end;
$$;

-- Immediate permanent deletion, called from the workspace hub after the
-- type-the-name confirmation.
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

  perform _purge_org_data(p_org_id);
end;
$$;

-- Cron path — re-pointed at the shared body so the two purges stay in
-- lock-step. Same signature and semantics as before.
create or replace function purge_expired_workspaces()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org record;
  v_count int := 0;
begin
  for v_org in
    select id from organizations
    where purge_after is not null and purge_after < now()
  loop
    perform _purge_org_data(v_org.id);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- Grants, per the hardening discipline (schema_phase_security_hardening.sql):
-- no PUBLIC/anon execute anywhere; the shared body is callable by nobody
-- but the two wrappers (definer context) and the service role.
revoke all on function _purge_org_data(uuid) from public, anon, authenticated;
grant execute on function _purge_org_data(uuid) to service_role;

revoke execute on function purge_workspace(uuid) from public, anon;
grant execute on function purge_workspace(uuid) to authenticated;

revoke all on function purge_expired_workspaces() from public, anon, authenticated;
grant execute on function purge_expired_workspaces() to service_role;

-- F3.24 schema-migration discipline: optimistic PostgREST reload.
NOTIFY pgrst, 'reload schema';
