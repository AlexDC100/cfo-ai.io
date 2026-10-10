-- ═══════════════════════════════════════════════════════════════════════
-- schema_phase_signup_tier_trial.sql — a NEW signup's subscription row says
-- tier 'trial'. FORWARD ONLY: no existing row is read for change or written.
-- ═══════════════════════════════════════════════════════════════════════
--
-- THE HOLE (measured 2026-10-03, review of the subscriptions lockdown). The
-- signup trigger on auth.users (handle_new_user_v2; before schema_phase3.sql,
-- handle_new_user) seeds
--
--   insert into public.subscriptions (user_id, plan, billing_cycle, status, …)
--   values (new.id, 'professional', 'monthly', 'trial', …)
--
-- — no `tier`. The engine resolves a plan as `row.tier or row.plan`
-- (src/engine/api/_plan_state.get_plan_state), and 'professional' is a LEGACY
-- key that maps to the Multi-Country allowance
-- (_pricing_config.legacy_tier_map: 15 documents, 5 workspaces, non-RO
-- documents). So every brand-new free account is metered as Multi-Country —
-- while create_workspace's SQL, which reads `tier` only, says trial.
--
-- THE FIX — two words in the insert, nothing else. In every function that an
-- INSERT trigger on auth.users runs (and in handle_new_user /
-- handle_new_user_v2 by name), the subscriptions insert gains the `tier`
-- column and the value 'trial':
--
--   insert into public.subscriptions (user_id, plan, tier, billing_cycle, status, …)
--   values (new.id, 'professional', 'trial', 'monthly', 'trial', …)
--
-- The function is PATCHED IN PLACE — its installed definition
-- (pg_get_functiondef) with that one statement rewritten — so everything
-- else it does on the database this runs on (a body edited by hand
-- included), its owner, its grants, SECURITY DEFINER and its search_path stay
-- exactly as they are. A function whose subscriptions insert is not the
-- repository's text is NOT touched, and the result says so.
--
-- IT REFUSES TO BREAK SIGNUP. Nothing is installed unless
-- public.subscriptions has a `tier` column and every CHECK constraint on it
-- accepts 'trial' (schema_phase5_usage_limits.sql's original list did not;
-- schema_phase_pricing_v2_tier_check.sql and schema_phase_plan_caps.sql do).
-- Otherwise the file changes nothing and says why.
--
-- WHAT IT DOES NOT DO — on purpose (the owner's fence: no customer row is
-- altered, no plan limit changes):
--   · NO BACKFILL. Rows that exist keep the tier they have (NULL for every
--     free account created by the old trigger). What the engine gives THOSE
--     accounts does not change with this file. MEASURED, not promised: the
--     file takes one digest of every subscriptions row before it touches a
--     function and again after (the md5 of each whole row, sorted,
--     concatenated, md5'd — the preflight report's
--     "existing_rows_fingerprint"), answers both, and REFUSES TO COMMIT if a
--     row it found is no longer byte-identical.
--   · no engine change, no change to `plan`, `status` or the trial dates.
--
-- ── HOW IT IS APPLIED ────────────────────────────────────────────────────
--   0. PREFLIGHT (read-only, one row):
--        supabase/preflight/schema_phase_signup_tier_trial_preflight_report.sql
--      It names the function each trigger on auth.users calls on THIS
--      database and what tier a new signup would be written with.
--      Apply this file only where it answers  "hole_open": true.
--   1. Run this file as one batch (`supabase db query --linked -f <file>`,
--      or pasted whole into the SQL editor). One DO block: everything or — on
--      any error, a lock timeout included (5 s) — nothing. Its LAST statement
--      returns one jsonb row: each function it patched (md5 before → after),
--      each it left and why, and the digest of the existing rows before and
--      after ("existing_rows_unchanged": true).
--   2. Dashboard → Settings → API → "Reload schema cache" (CLAUDE.md §14; no
--      API surface changes, the click is the discipline).
--   3. POST-CHECK: the preflight report again — "hole_open": false, and its
--      "existing_rows_fingerprint" equal to the one read in step 0 (same
--      "rows", same "md5": no existing row was altered). Then one throw-away
--      signup: its subscriptions row reads tier 'trial'.
-- Idempotent: a second run changes nothing and says so.
--
-- ⚠ RE-RUN THIS FILE AFTER RE-RUNNING supabase/schema.sql OR
--   supabase/schema_phase3.sql — both re-create their signup function without
--   `tier` (and schema.sql re-attaches the LEGACY function to the trigger).
--
-- ROLLBACK (re-opens the hole): run the ONE statement
--     create or replace function handle_new_user_v2() … $$;
--   of supabase/schema_phase3.sql (its lines 88–147) — the statement ALONE,
--   never the whole file (which also re-creates policies and backfills
--   memberships). Measured on a production-shaped database: the function
--   reads md5 77d2a9f3… again, with its owner, SECURITY DEFINER, search_path
--   and grants as they were. The legacy handle_new_user is attached to no
--   trigger where schema_phase3.sql is applied; to put it back as well, run
--   its statement from supabase/schema.sql and then
--     alter function public.handle_new_user() set search_path = public;
--   (that statement carries no search_path; the hardening file pinned it).
--
-- Gate: scripts/check_hole_signup_tier.sh (hole-signup-tier);
-- static laws: tests/engine/test_entitlement_hole_laws.py.
-- ═══════════════════════════════════════════════════════════════════════

do $migration$
declare
  v_sub      regclass := to_regclass('public.subscriptions');
  v_users    regclass := to_regclass('auth.users');
  v_changed  jsonb := '[]'::jsonb;
  v_skipped  jsonb := '[]'::jsonb;
  v_left     jsonb := '[]'::jsonb;
  v_tier_att smallint;
  v_con      record;
  v_ok       boolean;
  v_refused  text := null;
  v_fn       record;
  v_def      text;
  v_new_def  text;
  v_before   text;
  v_after    text;
  -- THE FENCE, MEASURED: one md5 per whole subscriptions row, at the start
  -- and at the end. This file writes no row; it says so with a digest.
  v_rows_before text[];
  v_rows_after  text[];
  v_fp_before   text;
  v_fp_after    text;
  c_row_digests constant text :=
    'select coalesce(array_agg(md5(s::text) order by md5(s::text)), ''{}''::text[]) from public.subscriptions s';
  -- The repository's subscriptions insert, whitespace-tolerant. Three
  -- groups; the patch puts ` tier,` after the first and ` 'trial',` after
  -- the second.
  c_insert constant text :=
       '(insert\s+into\s+(?:public\.)?subscriptions\s*\(\s*user_id\s*,\s*plan\s*,)'
    || '(\s*billing_cycle\s*,\s*status\s*,\s*trial_start\s*,\s*trial_end\s*,'
    || '\s*current_period_start\s*,\s*current_period_end\s*\)\s*values\s*\(\s*new\.id\s*,\s*''professional''\s*,)'
    || '(\s*''monthly''\s*,\s*''trial''\s*,)';
  -- A subscriptions insert that already names tier: nothing to do.
  c_patched constant text :=
       'insert\s+into\s+(?:public\.)?subscriptions\s*\(\s*user_id\s*,\s*plan\s*,\s*tier\s*,'
    || '\s*billing_cycle\s*,\s*status\s*,\s*trial_start\s*,\s*trial_end\s*,'
    || '\s*current_period_start\s*,\s*current_period_end\s*\)\s*values\s*\(\s*new\.id\s*,\s*''professional''\s*,\s*''trial''\s*,'
    || '\s*''monthly''\s*,\s*''trial''\s*,';
begin
  perform set_config('lock_timeout', '5s', true);
  perform set_config('cfo_holes.result', '', false);   -- never answer with another file's result

  if v_sub is not null and has_table_privilege(current_user, v_sub, 'SELECT') then
    execute c_row_digests into v_rows_before;
    v_fp_before := md5(array_to_string(v_rows_before, ''));
  elsif v_sub is not null then
    v_skipped := v_skipped || to_jsonb(format('public.subscriptions is not readable by %s: the existing rows were NOT fingerprinted (this file writes no row either way)', current_user));
  end if;

  if v_sub is null then
    v_refused := 'public.subscriptions does not exist';
  else
    select attnum into v_tier_att from pg_attribute
     where attrelid = v_sub and attname = 'tier' and not attisdropped;
    if v_tier_att is null then
      v_refused := 'public.subscriptions has no tier column (schema_phase5_usage_limits.sql is not applied)';
    end if;
  end if;

  -- Every CHECK constraint that reads `tier` must accept 'trial' — or the
  -- patched trigger would refuse EVERY signup with 23514.
  if v_refused is null then
    for v_con in
      select c.conname, c.conkey, pg_get_expr(c.conbin, c.conrelid) as expr, pg_get_constraintdef(c.oid) as def
        from pg_constraint c
       where c.conrelid = v_sub and c.contype = 'c' and v_tier_att = any (c.conkey)
    loop
      v_ok := null;
      if v_con.conkey = array[v_tier_att] then
        begin
          execute format('select (%s) is not false from (select ''trial''::text as tier) as s', v_con.expr) into v_ok;
        exception when others then
          v_ok := null;
        end;
      end if;
      if v_ok is null then
        v_ok := v_con.def ~ '''trial''';
      end if;
      if not v_ok then
        v_refused := format('the CHECK constraint %s on public.subscriptions does not accept tier ''trial'' (%s) — a signup writing it would be refused',
                            v_con.conname, v_con.def);
      end if;
    end loop;
  end if;

  if v_refused is not null then
    v_skipped := v_skipped || to_jsonb(v_refused || ' — NOTHING was installed; signups are written as before');
  else
    for v_fn in
      select distinct p.oid, p.oid::regprocedure::text as name, p.prosrc,
             pg_get_userbyid(p.proowner) as owner,
             pg_has_role(current_user, p.proowner, 'USAGE') as replaceable
        from pg_proc p
       where p.prokind = 'f'
         and (   p.oid in (to_regprocedure('public.handle_new_user_v2()'),
                           to_regprocedure('public.handle_new_user()'))
              or (v_users is not null
                  and p.oid in (select t.tgfoid from pg_trigger t
                                 where t.tgrelid = v_users and not t.tgisinternal
                                   and (t.tgtype & 4) = 4)))   -- an INSERT trigger
       order by 2
    loop
      if v_fn.prosrc ~* c_patched then
        continue;                              -- already writes tier 'trial'
      end if;
      if v_fn.prosrc !~* 'insert\s+into\s+(?:public\.)?subscriptions\M' then
        continue;                              -- seeds no subscription row
      end if;
      if (select count(*) from regexp_matches(v_fn.prosrc, c_insert, 'gi')) <> 1 then
        v_skipped := v_skipped || to_jsonb(format(
          '%s inserts into subscriptions, but not with the repository''s statement — NOT patched (md5 %s). Read it; add `tier` to its column list and ''trial'' to its values by hand.',
          v_fn.name, md5(v_fn.prosrc)));
        continue;
      end if;

      if not v_fn.replaceable then
        -- Another role owns it: `create or replace` would answer "must be
        -- owner of function" and roll the whole file back with nothing said.
        v_skipped := v_skipped || to_jsonb(format(
          '%s is owned by %s: the role running this file (%s) cannot replace it — NOT patched. Run this file as %s.',
          v_fn.name, v_fn.owner, current_user, v_fn.owner));
        continue;
      end if;

      v_before  := md5(v_fn.prosrc);
      v_def     := pg_get_functiondef(v_fn.oid);
      v_new_def := regexp_replace(v_def, c_insert, '\1 tier,\2 ''trial'',\3', 'i');
      if v_new_def = v_def or v_new_def !~* c_patched then
        raise exception 'signup tier: the patch of % did not produce the expected statement — nothing was applied', v_fn.name;
      end if;
      execute v_new_def;
      select md5(p.prosrc) into v_after from pg_proc p where p.oid = v_fn.oid;
      v_changed := v_changed || to_jsonb(format(
        '%s: its subscriptions insert now writes tier ''trial'' (md5 %s -> %s); nothing else in the function changed',
        v_fn.name, v_before, v_after));
    end loop;

    -- Read back: what would a signup be written with now?
    if v_users is not null then
      for v_fn in
        select p.oid::regprocedure::text as name, p.prosrc, t.tgname
          from pg_trigger t
          join pg_proc p on p.oid = t.tgfoid
         where t.tgrelid = v_users and not t.tgisinternal and (t.tgtype & 4) = 4 and t.tgenabled <> 'D'
           and p.prosrc ~* 'insert\s+into\s+(?:public\.)?subscriptions\M'
           and p.prosrc !~* c_patched
      loop
        v_left := v_left || to_jsonb(format('trigger %s on auth.users runs %s, whose subscriptions insert does not write tier ''trial''',
                                            v_fn.tgname, v_fn.name));
      end loop;
    end if;
  end if;

  -- Every row that existed when this file started, read again: the digest
  -- of THOSE rows must be the one taken at the start. (A signup that lands
  -- while the file runs adds a row; it is counted, not compared.)
  if v_rows_before is not null then
    execute c_row_digests into v_rows_after;
    v_fp_after := md5(array_to_string(array(
      select x from unnest(v_rows_after) as x where x = any (v_rows_before) order by x), ''));
    if v_fp_after is distinct from v_fp_before then
      raise exception 'signup tier: a subscriptions row that existed when this file started is no longer byte-identical (digest % -> %). This file writes no row — nothing was applied; run it again.',
        v_fp_before, v_fp_after;
    end if;
  end if;

  notify pgrst, 'reload schema';

  perform set_config('cfo_holes.result', jsonb_build_object(
    'migration', 'schema_phase_signup_tier_trial.sql',
    'changed', v_changed,
    'changed_count', jsonb_array_length(v_changed),
    'skipped', v_skipped,
    'not_closed', v_left,
    'existing_rows', cardinality(v_rows_before),
    'existing_rows_fingerprint_before', v_fp_before,
    'existing_rows_fingerprint_after', v_fp_after,
    'existing_rows_unchanged', case when v_rows_before is null then null else v_fp_after is not distinct from v_fp_before end,
    'rows_added_while_this_file_ran', cardinality(v_rows_after) - cardinality(v_rows_before),
    'not_changed_on_purpose', 'no existing subscriptions row (no backfill); the engine; plan, status and the trial dates of a new row',
    'next', 'Reload the schema cache (Dashboard → Settings → API), then run the preflight report again: "hole_open" must be false.'
  )::text, false);
end
$migration$;

select coalesce(nullif(current_setting('cfo_holes.result', true), ''),
                '{"error": "the migration block did not run"}')::jsonb as result;
