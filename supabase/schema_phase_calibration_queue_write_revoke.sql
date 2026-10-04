-- ═══════════════════════════════════════════════════════════════════════
-- schema_phase_calibration_queue_write_revoke.sql — the operator's
-- calibration review queue is written by the engine: a browser session loses
-- the WRITE privileges on public.calibration_rules.
-- ═══════════════════════════════════════════════════════════════════════
--
-- THIS IS NOT ONE OF THE FOUR HOLES THE REVIEW MEASURED — it is one table of
-- the same census (every public table where anon or authenticated holds a
-- write privilege and a policy admits the write, and NO user-JWT path writes
-- it). It is a file of its own because it is open where the twelve
-- public-market tables do not even exist: apply it on the owner's or the
-- coordinator's decision; no other file depends on it.
--
-- WHAT IS OPEN (measured 2026-10-03 on a database built from this
-- repository). calibration_rules has row level security and ONE write
-- policy (supabase/schema_phase_f3_calibration.sql):
--
--   "calibration_rules member write"  for insert  with check (
--        (org_id is null or is_member_of(org_id))
--    and status = 'pending' and source in ('review_mode', 'admin'))
--
-- `org_id is null` is a GLOBAL rule — one that applies to every company. So
-- any signed-in user, with their own JWT and the default grants, inserts a
-- pending GLOBAL account → bucket rule into the queue the operator approves
-- from. (The anon key is stopped only by accident: the policy calls
-- is_member_of, which anon may not execute.) Nothing is applied until the
-- operator approves it — the hole is who may fill the operator's queue, for
-- every company, not an entitlement.
--
-- WHO WRITES IT LEGITIMATELY. The engine, with the SERVICE ROLE, after it
-- has verified the caller: src/engine/api/pipeline.py — the review route's
-- proposal insert and the operator's approve / reject updates, every one an
-- `admin()` client. No browser file, no edge function, no mobile file and no
-- `_supabase.per_user(jwt)` block names the table
-- (tests/engine/test_entitlement_hole_laws.py holds that, and reds the day a
-- user-JWT writer appears).
-- WHO READS IT with a user's JWT: nobody directly today; the member SELECT
-- policy is left EXACTLY as found.
--
-- WHAT THIS FILE DOES — restrict only, nothing deleted, no row touched: on
-- public.calibration_rules, where it exists, INSERT, UPDATE, DELETE and
-- TRUNCATE are revoked from anon and authenticated (and from PUBLIC where a
-- grant to PUBLIC is what gives them the privilege). No policy is created or
-- dropped — without the privilege the write policy admits nothing — and
-- SELECT / REFERENCES / TRIGGER are not touched; the service role keeps
-- everything.
--
-- ── HOW IT IS APPLIED ────────────────────────────────────────────────────
--   0. PREFLIGHT (read-only, one row):
--        supabase/preflight/schema_phase_calibration_queue_write_revoke_preflight_report.sql
--      Apply this file only where it answers  "hole_open": true.
--   1. Run this file as one batch (`supabase db query --linked -f <file>`,
--      or pasted whole into the SQL editor). One DO block: everything or — on
--      any error, a lock timeout included (5 s) — nothing. Its LAST statement
--      returns one jsonb row: what was revoked from whom; whether the table
--      exists here; anything it could not close.
--   2. Dashboard → Settings → API → "Reload schema cache" (CLAUDE.md §14).
--   3. POST-CHECK: the preflight report again — "hole_open": false.
-- Idempotent: a second run changes nothing and says so. Where the table is
-- absent it is skipped and named, and "skipped" says there was nothing to do.
-- A privilege granted by a role the one running this file cannot act for is
-- NOT removed by its revoke (Postgres answers a warning, not an error): the
-- result names it under "not_closed" and the report keeps saying
-- "hole_open": true.
--
-- ⚠ A NEW ENVIRONMENT: the table is created with the default grants again.
--   Run this file after supabase/schema_phase_f3_calibration.sql.
--   (Re-running THAT file on a database that has the table re-grants nothing.)
--
-- ROLLBACK (re-opens it):
--   grant insert, update, delete, truncate on public.calibration_rules to anon, authenticated;
--
-- Gate: scripts/check_hole_calibration_queue.sh (hole-calibration-queue);
-- static laws: tests/engine/test_entitlement_hole_laws.py.
-- ═══════════════════════════════════════════════════════════════════════

do $migration$
declare
  -- THE LIST. One place: the gate, the static laws and the preflight report
  -- are held to it (tests/engine/test_entitlement_hole_laws.py).
  v_tables constant text[] := array[
    -- CALIBRATION-QUEUE-BEGIN
    'calibration_rules'
    -- CALIBRATION-QUEUE-END
  ];
  v_t        text;
  v_rel      regclass;
  v_role     text;
  v_priv     text;
  v_revoked  jsonb := '{}'::jsonb;
  v_here     jsonb;
  v_absent   jsonb := '[]'::jsonb;
  v_skipped  jsonb := '[]'::jsonb;
  v_left     jsonb := '[]'::jsonb;
  v_count    int := 0;
begin
  perform set_config('lock_timeout', '5s', true);
  perform set_config('cfo_holes.result', '', false);   -- never answer with another file's result

  foreach v_t in array v_tables loop
    v_rel := to_regclass(format('public.%I', v_t));
    if v_rel is null then
      v_absent := v_absent || to_jsonb(v_t);
      continue;
    end if;
    if (select relkind from pg_class where oid = v_rel) not in ('r', 'p') then
      v_skipped := v_skipped || to_jsonb(format('public.%s is not a table — not touched', v_t));
      continue;
    end if;

    v_here := '[]'::jsonb;
    foreach v_priv in array array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] loop
      -- A grant to PUBLIC gives the privilege to every role: it goes first.
      -- "revoked" names only what the READ-BACK confirms is gone: a grant
      -- made by a role this one cannot act for (a table another role owns)
      -- is not removed by this role's revoke — Postgres answers a warning,
      -- not an error.
      if exists (select 1 from pg_class c, aclexplode(c.relacl) a
                  where c.oid = v_rel and a.grantee = 0 and a.privilege_type = v_priv) then
        execute format('revoke %s on table public.%I from public', v_priv, v_t);
        if not exists (select 1 from pg_class c, aclexplode(c.relacl) a
                        where c.oid = v_rel and a.grantee = 0 and a.privilege_type = v_priv) then
          v_here := v_here || to_jsonb(format('PUBLIC:%s', v_priv));
          v_count := v_count + 1;
        end if;
      end if;
      foreach v_role in array array['anon', 'authenticated'] loop
        if has_table_privilege(v_role, v_rel, v_priv)
           or (v_priv in ('INSERT', 'UPDATE') and has_any_column_privilege(v_role, v_rel, v_priv)) then
          execute format('revoke %s on table public.%I from %I', v_priv, v_t, v_role);
          if has_table_privilege(v_role, v_rel, v_priv)
             or (v_priv in ('INSERT', 'UPDATE') and has_any_column_privilege(v_role, v_rel, v_priv)) then
            v_left := v_left || to_jsonb(format('%s still holds %s on public.%s (table owner: %s; granted by: %s)', v_role, v_priv, v_t,
              (select pg_get_userbyid(c.relowner) from pg_class c where c.oid = v_rel),
              coalesce((select string_agg(distinct pg_get_userbyid(a.grantor), ', ')
                          from pg_class c, aclexplode(c.relacl) a
                         where c.oid = v_rel and a.privilege_type = v_priv
                           and a.grantee in (0, (select oid from pg_roles where rolname = v_role))),
                       'a column-level grant or a role membership')));
          else
            v_here := v_here || to_jsonb(format('%s:%s', v_role, v_priv));
            v_count := v_count + 1;
          end if;
        end if;
      end loop;
    end loop;
    if jsonb_array_length(v_here) > 0 then
      v_revoked := v_revoked || jsonb_build_object(v_t, v_here);
    end if;
  end loop;

  if jsonb_array_length(v_absent) = cardinality(v_tables) then
    v_skipped := v_skipped || to_jsonb('public.calibration_rules does not exist in this database — nothing to do'::text);
  end if;

  notify pgrst, 'reload schema';

  perform set_config('cfo_holes.result', jsonb_build_object(
    'migration', 'schema_phase_calibration_queue_write_revoke.sql',
    'revoked', v_revoked,
    'changed_count', v_count,
    'tables_absent_here', v_absent,
    'skipped', v_skipped,
    'not_closed', v_left,
    'left_as_found', 'SELECT, REFERENCES, TRIGGER; row level security; every policy; the service role; every other table',
    'next', 'Reload the schema cache (Dashboard → Settings → API), then run the preflight report again: "hole_open" must be false.'
  )::text, false);
end
$migration$;

select coalesce(nullif(current_setting('cfo_holes.result', true), ''),
                '{"error": "the migration block did not run"}')::jsonb as result;
