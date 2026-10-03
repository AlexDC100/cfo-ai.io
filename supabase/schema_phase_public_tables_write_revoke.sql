-- ═══════════════════════════════════════════════════════════════════════
-- schema_phase_public_tables_write_revoke.sql — the anon key (and a signed-in
-- session) lose the WRITE privileges on the tables only the engine's service
-- role writes and nothing scopes: the public-market / intelligence tables,
-- and the calibration review queue.
-- ═══════════════════════════════════════════════════════════════════════
--
-- THE HOLE (measured 2026-10-03, review of the subscriptions lockdown; the
-- list re-derived from the catalog of a database built from this
-- repository). Supabase grants every new table in schema public to anon and
-- authenticated — ALL privileges. Row level security is what stands between
-- that grant and the internet, and
--
--   · TWELVE tables were created WITHOUT row level security
--     (schema_phase_nasdaq_public_companies.sql,
--     schema_phase_intelligence_engine.sql): with the anon key alone, an
--     INSERT, an UPDATE or a DELETE of any row lands. No entitlement is in
--     them; what the product SHOWS about a listed company is.
--   · calibration_rules has row level security and one INSERT policy that
--     admits a row with org_id NULL — a GLOBAL rule — from any signed-in
--     user (status 'pending'): anyone can put a rule into the operator's
--     approval queue for every company (schema_phase_f3_calibration.sql).
--
-- WHO WRITES THEM LEGITIMATELY. The engine and the operator's seed scripts,
-- with the SERVICE ROLE, and nothing else: src/engine/public/intelligence/
-- filings_cache.py (`admin()`), scripts/seed_bvb_companies.py
-- (SUPABASE_SERVICE_ROLE_KEY), src/engine/api/pipeline.py's review routes
-- (`_supabase.admin()` — three write sites on calibration_rules). No browser
-- file, no edge function, no mobile file and no `_supabase.per_user(jwt)`
-- block in the engine names one of these tables
-- (tests/engine/test_entitlement_hole_laws.py holds that).
-- WHO READS THEM with the anon key or a user's JWT: nobody directly — the
-- browser reads public-company data through the engine's API (the one
-- direct anon read in the frontend is the founder_cohort_public view, which
-- is not in this file). SELECT is nevertheless left EXACTLY as found.
--
-- WHAT THIS FILE DOES — restrict only, nothing deleted, no row touched: on
-- each listed table that exists, INSERT, UPDATE, DELETE and TRUNCATE are
-- revoked from anon and authenticated (and from PUBLIC where a grant to
-- PUBLIC is what gives them the privilege). Row level security is NOT
-- switched on, no policy is created or dropped, SELECT / REFERENCES / TRIGGER
-- are not touched, the service role keeps everything.
--
-- WHAT IT LEAVES, on purpose:
--   · every table a user's JWT legitimately writes (documents, periods,
--     alerts, chat, prefs, the firm tables …) — their policies scope the
--     write to the caller's organization or user; measured, table by table,
--     in the builder's report;
--   · the six tables the engine DERIVES (statement lines, metrics, briefings,
--     benchmark reports, SKU analyses, COA overrides) — a member can write
--     their OWN organization's rows there; that is
--     schema_phase_derived_tables_write_revoke.sql, a separate decision;
--   · dashboard_configs — schema_phase_dashboard_config_caller.sql;
--   · subscriptions and the meters — the subscriptions write lockdown;
--   · any table this repository does not define (production holds some):
--     the preflight report LISTS every such table that is open, by name;
--     this file does not guess who writes them.
--
-- ── HOW IT IS APPLIED ────────────────────────────────────────────────────
--   0. PREFLIGHT (read-only, one row):
--        supabase/preflight/schema_phase_public_tables_write_revoke_preflight_report.sql
--      Apply this file only where it answers  "hole_open": true.
--   1. Run this file as one batch (`supabase db query --linked -f <file>`,
--      or pasted whole into the SQL editor). One DO block: everything or — on
--      any error, a lock timeout included (5 s) — nothing. Its LAST statement
--      returns one jsonb row: per table, what was revoked from whom; the
--      tables that do not exist here; anything it could not close.
--   2. Dashboard → Settings → API → "Reload schema cache" (CLAUDE.md §14).
--   3. POST-CHECK: the preflight report again — "hole_open": false.
-- Idempotent: a second run changes nothing and says so. A table that is
-- absent is skipped and named. A privilege granted by a role other than the
-- one running this file is not removed by its revoke: the result names it
-- under "not_closed" (then, as the table's owner:
--   revoke <privilege> on public.<table> from <grantor> cascade;  and re-run).
--
-- ⚠ A NEW ENVIRONMENT: the tables are created with the default grants again.
--   Run this file after schema_phase_nasdaq_public_companies.sql,
--   schema_phase_intelligence_engine.sql and schema_phase_f3_calibration.sql.
--   (Re-running THOSE on a database that has the tables re-grants nothing.)
--
-- ROLLBACK (re-opens the hole), per table:
--   grant insert, update, delete, truncate on public.<table> to anon, authenticated;
--
-- Gate: scripts/check_hole_public_tables.sh (hole-public-tables);
-- static laws: tests/engine/test_entitlement_hole_laws.py.
-- ═══════════════════════════════════════════════════════════════════════

do $migration$
declare
  -- THE LIST. One place: the gate, the static laws and the preflight report
  -- are held to it (tests/engine/test_entitlement_hole_laws.py).
  v_tables constant text[] := array[
    -- PUBLIC-TABLES-RLS-OFF-BEGIN
    'company_exposure_profiles',
    'company_signal_links',
    'intelligence_signals',
    'macro_signal_cache',
    'nasdaq_responses',
    'public_companies',
    'public_company_opportunity_scores',
    'public_company_periods',
    'public_company_quotes',
    'public_company_risk_scores',
    'risk_interpretations',
    'sector_risk_models',
    -- PUBLIC-TABLES-RLS-OFF-END
    -- PUBLIC-TABLES-UNSCOPED-POLICY-BEGIN
    'calibration_rules'
    -- PUBLIC-TABLES-UNSCOPED-POLICY-END
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
      if exists (select 1 from pg_class c, aclexplode(c.relacl) a
                  where c.oid = v_rel and a.grantee = 0 and a.privilege_type = v_priv) then
        execute format('revoke %s on table public.%I from public', v_priv, v_t);
        v_here := v_here || to_jsonb(format('PUBLIC:%s', v_priv));
        v_count := v_count + 1;
      end if;
      foreach v_role in array array['anon', 'authenticated'] loop
        if has_table_privilege(v_role, v_rel, v_priv)
           or (v_priv in ('INSERT', 'UPDATE') and has_any_column_privilege(v_role, v_rel, v_priv)) then
          execute format('revoke %s on table public.%I from %I', v_priv, v_t, v_role);
          v_here := v_here || to_jsonb(format('%s:%s', v_role, v_priv));
          v_count := v_count + 1;
        end if;
        -- Read back. Do not pretend.
        if has_table_privilege(v_role, v_rel, v_priv)
           or (v_priv in ('INSERT', 'UPDATE') and has_any_column_privilege(v_role, v_rel, v_priv)) then
          v_left := v_left || to_jsonb(format('%s still holds %s on public.%s (granted by: %s)', v_role, v_priv, v_t,
            coalesce((select string_agg(distinct pg_get_userbyid(a.grantor), ', ')
                        from pg_class c, aclexplode(c.relacl) a
                       where c.oid = v_rel and a.privilege_type = v_priv
                         and a.grantee in (0, (select oid from pg_roles where rolname = v_role))),
                     'a column-level grant or a role membership')));
        end if;
      end loop;
    end loop;
    if jsonb_array_length(v_here) > 0 then
      v_revoked := v_revoked || jsonb_build_object(v_t, v_here);
    end if;
  end loop;

  notify pgrst, 'reload schema';

  perform set_config('cfo_holes.result', jsonb_build_object(
    'migration', 'schema_phase_public_tables_write_revoke.sql',
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
