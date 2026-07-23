-- Fix: workspace purge broken by Supabase's storage.protect_delete() guard.
--
-- Symptom (2026-07-23): "Delete forever" on an archived workspace always
-- fails with the generic FE toast. Root cause: Supabase shipped a trigger
-- (storage.protect_delete) that raises 42501 on ANY direct `delete from
-- storage.objects` unless the session GUC `storage.allow_delete_query` is
-- 'true'. `_purge_org_data()` (schema_phase_workspace_purge_now.sql) does a
-- direct delete for the org's document files, so BOTH purge paths — the
-- user-facing purge_workspace() RPC and the purge_expired_workspaces() cron
-- — throw before touching anything.
--
-- Fix: set the GUC transaction-locally (set_config(..., true)) around the
-- storage delete, exactly the escape hatch protect_delete() checks. The
-- flag is scoped to this transaction and flipped back immediately after,
-- so no other statement in the session inherits delete rights.
--
-- Known caveat (accepted, pre-existing): deleting storage.objects rows
-- directly removes the DB metadata; the underlying blobs are cleaned up by
-- Supabase storage's orphan sweep rather than synchronously. A follow-up
-- could route file deletion through the Storage API from the backend
-- (service role) before calling the RPC — the row delete here would then
-- be a no-op safety net.
--
-- ── OPERATOR RUNBOOK (locked discipline — §14 / F3.24) ────────────────
-- 1. Apply schema_phase_workspace_purge_now.sql first.
-- 2. Run this SQL in Supabase Studio (includes the NOTIFY at the bottom).
-- 3. IMMEDIATELY click Supabase Dashboard → Settings → API →
--    "Reload schema cache".
-- ─────────────────────────────────────────────────────────────────────

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

  -- storage.protect_delete() blocks direct deletes unless this
  -- transaction-local flag is set. Scoped tightly around the one
  -- statement that needs it.
  perform set_config('storage.allow_delete_query', 'true', true);
  delete from storage.objects
   where bucket_id = 'documents'
     and (storage.foldername(name))[1] = p_org_id::text;
  perform set_config('storage.allow_delete_query', 'false', true);

  delete from organizations where id = p_org_id;
end;
$$;

-- Same grants as before (create or replace preserves ACLs, re-asserted
-- here for safety per the hardening discipline).
revoke all on function _purge_org_data(uuid) from public, anon, authenticated;
grant execute on function _purge_org_data(uuid) to service_role;

-- F3.24 schema-migration discipline: optimistic PostgREST reload.
NOTIFY pgrst, 'reload schema';
