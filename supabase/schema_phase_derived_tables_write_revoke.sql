-- ═══════════════════════════════════════════════════════════════════════
-- schema_phase_derived_tables_write_revoke.sql — what the ENGINE computes is
-- written by the engine: a browser session loses the write privileges on the
-- six tables that hold a period's derived figures.
-- ═══════════════════════════════════════════════════════════════════════
--
-- THIS IS NOT ONE OF THE FOUR HOLES THE REVIEW MEASURED — it is the rest of
-- the same census (every public table where anon or authenticated holds a
-- write privilege and a policy admits the write, and NO user-JWT path writes
-- it). Apply it on the owner's or the coordinator's decision; the other
-- files do not depend on it.
--
-- WHAT IS OPEN. Each of these tables has row level security and "member"
-- write policies (insert / update / delete where is_member_of(org_id), or
-- through the period's organization). The policies ARE scoped — no user
-- reaches another organization's rows (measured, table by table). But a
-- member can write their OWN organization's rows directly through the REST
-- API:
--
--   statement_line_items        the trial-balance lines every statement,
--                               ratio and credit figure is assembled from
--   calculated_metrics          the stored metrics (the benchmark reads them)
--   briefings                   the narrated briefing
--   benchmark_reports           the Section 9 industry report
--   sku_analyses                the SKU analysis
--   org_coa_mappings_overrides  the account → bucket overrides a re-analysis
--                               applies
--
-- i.e. a signed-in member can make the product serve — and export as the
-- "bank report" — figures the engine never computed.
--
-- WHO WRITES THEM LEGITIMATELY. The engine, with the SERVICE ROLE, after it
-- has verified the caller (src/engine/api/pipeline.py, _benchmarks.py,
-- _industry_intelligence.py, _period_move.py — every write site is an
-- `admin()` client). No browser file, no edge function, no mobile file and
-- no `_supabase.per_user(jwt)` block writes one
-- (tests/engine/test_entitlement_hole_laws.py holds that, and reds the day
-- a user-JWT writer of one appears).
-- WHO READS THEM with a user's JWT: the engine's `per_user(jwt)` reads
-- (statement_line_items, calculated_metrics, sku_analyses, briefings) — the
-- member SELECT policies are what scope those reads. SELECT is left EXACTLY
-- as found.
--
-- WHAT THIS FILE DOES — restrict only, nothing deleted, no row touched: on
-- each listed table that exists, INSERT, UPDATE, DELETE and TRUNCATE are
-- revoked from anon and authenticated (and from PUBLIC where a grant to
-- PUBLIC is what gives them the privilege). No policy is created or dropped
-- — without the privilege none of the write policies admits anything — and
-- SELECT / REFERENCES / TRIGGER are not touched; the service role keeps
-- everything.
--
-- THE RISK, stated: a user-JWT writer of one of these tables that the census
-- did not find would answer 403 after this file. The census read every
-- `.from("<table>")` chain in frontend/, mobile/ and supabase/functions/
-- (and the one dynamic table list), and every per_user(jwt) block in
-- src/engine with the helpers the client is passed to.
--
-- ── HOW IT IS APPLIED ────────────────────────────────────────────────────
--   0. PREFLIGHT (read-only, one row):
--        supabase/preflight/schema_phase_derived_tables_write_revoke_preflight_report.sql
--      Apply this file only where it answers  "hole_open": true.
--   1. Run this file as one batch (`supabase db query --linked -f <file>`,
--      or pasted whole into the SQL editor). One DO block: everything or — on
--      any error, a lock timeout included (5 s) — nothing. Its LAST statement
--      returns one jsonb row: per table, what was revoked from whom; the
--      tables that do not exist here; anything it could not close.
--   2. Dashboard → Settings → API → "Reload schema cache" (CLAUDE.md §14).
--   3. POST-CHECK: the preflight report again — "hole_open": false; then one
--      upload analysed end to end (the engine still writes every table).
-- Idempotent: a second run changes nothing and says so. A table that is
-- absent is skipped and named.
--
-- ROLLBACK, per table (re-opens it):
--   grant insert, update, delete on public.<table> to authenticated;
--
-- Gate: scripts/check_hole_derived_tables.sh (hole-derived-tables);
-- static laws: tests/engine/test_entitlement_hole_laws.py.
-- ═══════════════════════════════════════════════════════════════════════

do $migration$
declare
  -- THE LIST. One place: the gate, the static laws and the preflight report
  -- are held to it (tests/engine/test_entitlement_hole_laws.py).
  v_tables constant text[] := array[
    -- DERIVED-TABLES-BEGIN
    'benchmark_reports',
    'briefings',
    'calculated_metrics',
    'org_coa_mappings_overrides',
    'sku_analyses',
    'statement_line_items'
    -- DERIVED-TABLES-END
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

  notify pgrst, 'reload schema';

  perform set_config('cfo_holes.result', jsonb_build_object(
    'migration', 'schema_phase_derived_tables_write_revoke.sql',
    'revoked', v_revoked,
    'changed_count', v_count,
    'tables_absent_here', v_absent,
    'skipped', v_skipped,
    'not_closed', v_left,
    'left_as_found', 'SELECT, REFERENCES, TRIGGER; row level security; every policy; the service role; every table not on the list',
    'next', 'Reload the schema cache (Dashboard → Settings → API), then run the preflight report again: "hole_open" must be false.'
  )::text, false);
end
$migration$;

select coalesce(nullif(current_setting('cfo_holes.result', true), ''),
                '{"error": "the migration block did not run"}')::jsonb as result;
