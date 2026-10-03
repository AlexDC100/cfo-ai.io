-- ═══════════════════════════════════════════════════════════════════════
-- schema_phase_dashboard_config_caller.sql — a dashboard layout is written
-- by its own user (or by the engine's service role), and by nobody else.
-- ═══════════════════════════════════════════════════════════════════════
--
-- THE HOLE (measured 2026-10-03, review of the subscriptions lockdown).
-- supabase/schema_phase_dashboard_config.sql created
--
--   upsert_dashboard_config(p_user_id uuid, p_cards jsonb)
--     SECURITY DEFINER, no revoke — so Supabase's default grants made it
--     callable by `anon` — and it writes the row of WHATEVER user id it is
--     handed. POST /rest/v1/rpc/upsert_dashboard_config with only the anon
--     key and another user's id overwrote that user's dashboard_configs row.
--
--   policy "dashboard_configs service_insert" … for insert with check (true)
--     — to PUBLIC, on a table the default grants let anon and authenticated
--     INSERT into: the anon key alone plants a layout for any user who has
--     no row yet.
--
-- WHO WRITES THE TABLE LEGITIMATELY. One writer: the engine, with the
-- service role, keyed on the VERIFIED user id (src/engine/api/_dashboard.py
-- `PUT /api/dashboard/config`, `client.upsert("dashboard_configs", …)`).
-- The browser calls that route; it never touches the table or the function
-- (frontend/lib/dashboard/configApi.ts). NOTHING in this repository calls
-- upsert_dashboard_config — not the engine, not the frontend, not an edge
-- function, not the mobile shell.
--
-- WHAT THIS FILE DOES — restrict only, nothing deleted, no row touched:
--   1. upsert_dashboard_config keeps its signature and its insert, and now
--      REFUSES a p_user_id that is not the caller's (auth.uid()); the service
--      role may still name any user. EXECUTE is revoked from PUBLIC and anon
--      (authenticated and service_role keep it).
--      If the installed function does not return jsonb (a body nobody
--      committed), the body is NOT replaced; EXECUTE is then revoked from
--      authenticated as well, so only the service role can call it.
--   2. INSERT, UPDATE, DELETE and TRUNCATE on public.dashboard_configs are
--      revoked from anon and authenticated. SELECT is left as found (a user
--      reads their own row through "dashboard_configs own_select"); the
--      policies are left as found — without the privilege none of them
--      admits a write.
--
-- WHAT IT LEAVES. The engine route (service role) — unchanged, measured.
-- Any OTHER overload of upsert_dashboard_config (none in this repository)
-- is reported, not touched.
--
-- ── HOW IT IS APPLIED ────────────────────────────────────────────────────
--   0. PREFLIGHT (read-only, one row):
--        supabase/preflight/schema_phase_dashboard_config_caller_preflight_report.sql
--      Apply this file only where it answers  "hole_open": true.
--   1. Run this file as one batch (`supabase db query --linked -f <file>`,
--      or pasted whole into the SQL editor). One DO block: it applies
--      everything or — on any error, a lock timeout included (5 s) —
--      nothing. A lock timeout means nothing was applied: run it again.
--      Its LAST statement returns one jsonb row: what it changed, what it
--      skipped.
--   2. Dashboard → Settings → API → "Reload schema cache" (CLAUDE.md §14; the
--      NOTIFY below is the optimistic half).
--   3. POST-CHECK: the preflight report again — "hole_open": false.
-- Idempotent: a second run changes nothing and says so.
--
-- ⚠ RE-RUN THIS FILE AFTER RE-RUNNING supabase/schema_phase_dashboard_config.sql.
--   That file is written to be re-run and re-creates the function WITHOUT
--   the caller check (`create or replace` keeps the revoked grants, so anon
--   stays out — a signed-in user would again write another user's row).
--
-- Gate: scripts/check_hole_dashboard_config.sh (hole-dashboard-config);
-- static laws: tests/engine/test_entitlement_hole_laws.py.
-- ═══════════════════════════════════════════════════════════════════════

do $migration$
declare
  v_fn       regprocedure := to_regprocedure('public.upsert_dashboard_config(uuid,jsonb)');
  v_table    regclass     := to_regclass('public.dashboard_configs');
  v_changed  jsonb := '[]'::jsonb;
  v_skipped  jsonb := '[]'::jsonb;
  v_before   text;
  v_after    text;
  v_role     text;
  v_priv     text;
  v_left     jsonb := '[]'::jsonb;
begin
  perform set_config('lock_timeout', '5s', true);

  -- ── 1. the function ──────────────────────────────────────────────────
  if v_fn is null then
    v_skipped := v_skipped || to_jsonb('upsert_dashboard_config(uuid, jsonb) does not exist — nothing to close'::text);
  elsif (select prorettype from pg_proc where oid = v_fn) <> 'jsonb'::regtype then
    -- A body this repository never committed: do not replace what nobody
    -- has read. Close it at the door instead — the service role only.
    if has_function_privilege('authenticated', v_fn, 'execute')
       or has_function_privilege('anon', v_fn, 'execute') then
      revoke all on function public.upsert_dashboard_config(uuid, jsonb) from public, anon, authenticated;
      v_changed := v_changed || to_jsonb('upsert_dashboard_config: EXECUTE revoked from PUBLIC, anon AND authenticated (the installed function does not return jsonb — its body was not replaced)'::text);
    end if;
    v_skipped := v_skipped || to_jsonb('upsert_dashboard_config body NOT replaced: the installed function does not return jsonb'::text);
  else
    select md5(prosrc) into v_before from pg_proc where oid = v_fn;

    create or replace function public.upsert_dashboard_config(
      p_user_id uuid,
      p_cards   jsonb
    ) returns jsonb
    language plpgsql
    security definer
    set search_path = public
    as $$
declare
  v_cards   jsonb;
  v_service boolean := coalesce(auth.jwt() ->> 'role', '') = 'service_role';
begin
  -- The row written is the CALLER's. The service role (the engine, which
  -- has verified the user) may name any user; nobody else may.
  if not v_service then
    if auth.uid() is null then
      raise exception 'Not authenticated.' using errcode = '28000';
    end if;
    if p_user_id is distinct from auth.uid() then
      raise exception 'A dashboard layout is written by its own user only.'
        using errcode = '42501';
    end if;
  end if;

  insert into dashboard_configs (user_id, cards, updated_at)
  values (p_user_id, p_cards, now())
  on conflict (user_id) do update
    set cards = excluded.cards,
        updated_at = now()
  returning cards into v_cards;
  return v_cards;
end;
$$;

    select md5(prosrc) into v_after from pg_proc where oid = v_fn;
    if v_after is distinct from v_before then
      v_changed := v_changed || to_jsonb(format('upsert_dashboard_config: body replaced (md5 %s -> %s) — a p_user_id that is not the caller is refused', v_before, v_after));
    end if;

    if has_function_privilege('anon', v_fn, 'execute')
       or exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                   where p.oid = v_fn and a.grantee = 0 and a.privilege_type = 'EXECUTE') then
      revoke all on function public.upsert_dashboard_config(uuid, jsonb) from public, anon;
      v_changed := v_changed || to_jsonb('upsert_dashboard_config: EXECUTE revoked from PUBLIC and anon'::text);
    end if;
    if not has_function_privilege('authenticated', v_fn, 'execute')
       or not has_function_privilege('service_role', v_fn, 'execute') then
      grant execute on function public.upsert_dashboard_config(uuid, jsonb) to authenticated, service_role;
      v_changed := v_changed || to_jsonb('upsert_dashboard_config: EXECUTE granted to authenticated and service_role (PUBLIC''s grant was the only one)'::text);
    end if;
  end if;
  -- Read back: a grant this role did not make is not removed by its revoke.
  if v_fn is not null and has_function_privilege('anon', v_fn, 'execute') then
    v_left := v_left || to_jsonb('anon can still EXECUTE upsert_dashboard_config (a grant made by another role, or inherited through a role membership)'::text);
  end if;

  -- ── 2. the table ─────────────────────────────────────────────────────
  if v_table is null then
    v_skipped := v_skipped || to_jsonb('public.dashboard_configs does not exist — nothing to close'::text);
  else
    foreach v_role in array array['anon', 'authenticated'] loop
      foreach v_priv in array array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] loop
        if has_table_privilege(v_role, v_table, v_priv)
           or (v_priv in ('INSERT', 'UPDATE') and has_any_column_privilege(v_role, v_table, v_priv)) then
          execute format('revoke %s on table public.dashboard_configs from %I', v_priv, v_role);
          v_changed := v_changed || to_jsonb(format('dashboard_configs: %s revoked from %s', v_priv, v_role));
        end if;
        -- Read back: a grant made by a role other than the one running this
        -- file is not removed by its revoke. Say so; do not pretend.
        if has_table_privilege(v_role, v_table, v_priv)
           or (v_priv in ('INSERT', 'UPDATE') and has_any_column_privilege(v_role, v_table, v_priv)) then
          v_left := v_left || to_jsonb(format('%s still holds %s on dashboard_configs (granted by: %s)', v_role, v_priv,
            coalesce((select string_agg(distinct pg_get_userbyid(a.grantor), ', ')
                        from pg_class c, aclexplode(c.relacl) a
                       where c.oid = v_table and a.privilege_type = v_priv
                         and a.grantee in (0, (select oid from pg_roles where rolname = v_role))),
                     'a column-level grant or a role membership')));
        end if;
      end loop;
    end loop;
  end if;

  notify pgrst, 'reload schema';

  perform set_config('cfo_holes.result', jsonb_build_object(
    'migration', 'schema_phase_dashboard_config_caller.sql',
    'changed', v_changed,
    'changed_count', jsonb_array_length(v_changed),
    'skipped', v_skipped,
    'not_closed', v_left,
    'next', 'Reload the schema cache (Dashboard → Settings → API), then run the preflight report again: "hole_open" must be false.'
  )::text, false);
end
$migration$;

select coalesce(nullif(current_setting('cfo_holes.result', true), ''),
                '{"error": "the migration block did not run"}')::jsonb as result;
