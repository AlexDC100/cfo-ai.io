-- PREFLIGHT / POST-CHECK REPORT for supabase/schema_phase_derived_tables_write_revoke.sql
--
-- ONE read-only statement, ONE row, one jsonb column. Catalog only — it reads
-- no table row — and it answers where a listed table does not exist. Run it
-- before the migration ("hole_open": true → apply) and after it
-- ("hole_open": false).
--
-- A table is OPEN when anon or authenticated holds INSERT, UPDATE, DELETE or
-- TRUNCATE on it AND either row level security is off or a permissive policy
-- admits a write (INSERT / UPDATE / DELETE / ALL).
--
--   listed     the migration's six tables, one entry each: whether it exists
--              here, row level security, the write privileges the API roles
--              hold, its write policies, "open", and whether SELECT is still
--              held by authenticated (the engine's per_user reads need it).
--   hole_open  some listed table is open: a member can write their own
--              organization's derived figures through the REST API.
--
-- The list is held to the migration's (tests/engine/test_entitlement_hole_laws.py).
-- The whole census of open tables is in
-- supabase/preflight/schema_phase_public_tables_write_revoke_preflight_report.sql.

with listed(name) as (values
    ('benchmark_reports'),
    ('briefings'),
    ('calculated_metrics'),
    ('org_coa_mappings_overrides'),
    ('sku_analyses'),
    ('statement_line_items')
),
census as (
  select c.oid, c.relname::text as name, c.relrowsecurity as rls,
         pg_get_userbyid(c.relowner) as owner,
         pg_has_role(current_user, c.relowner, 'USAGE') as revocable,
         array(select r.rolname || ':' || pr
                 from (values ('anon'), ('authenticated')) as r(rolname)
                cross join unnest(array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) as pr
                where has_table_privilege(r.rolname, c.oid, pr)
                   or (pr in ('INSERT', 'UPDATE') and has_any_column_privilege(r.rolname, c.oid, pr))
                order by 1) as privs,
         array(select pol.polname::text || ' [' || case pol.polcmd when 'a' then 'INSERT' when 'w' then 'UPDATE'
                                                       when 'd' then 'DELETE' else 'ALL' end || ']'
                 from pg_policy pol
                where pol.polrelid = c.oid and pol.polpermissive and pol.polcmd in ('a', 'w', 'd', '*')
                order by 1) as write_policies,
         has_table_privilege('authenticated', c.oid, 'SELECT') as authenticated_select
    from pg_class c
    join listed l on l.name = c.relname
   where c.relnamespace = to_regnamespace('public') and c.relkind in ('r', 'p')
)
select jsonb_build_object(
  'report', 'derived-tables-write-revoke',
  'migration', 'supabase/schema_phase_derived_tables_write_revoke.sql',
  'hole_open', exists (select 1 from census c
                        where cardinality(c.privs) > 0 and (not c.rls or cardinality(c.write_policies) > 0)),
  'listed_open_count', (select count(*) from census c
                         where cardinality(c.privs) > 0 and (not c.rls or cardinality(c.write_policies) > 0)),
  'listed_this_role_cannot_revoke', (select coalesce(jsonb_agg(c.name order by c.name), '[]'::jsonb) from census c
                                       where cardinality(c.privs) > 0 and (not c.rls or cardinality(c.write_policies) > 0)
                                         and not c.revocable),
  'listed', (select jsonb_agg(jsonb_build_object(
                'table', l.name,
                'exists', c.oid is not null,
                'owner', c.owner,
                'this_role_can_revoke', c.revocable,
                'row_level_security', c.rls,
                'api_write_privileges', coalesce(to_jsonb(c.privs), '[]'::jsonb),
                'write_policies', coalesce(to_jsonb(c.write_policies), '[]'::jsonb),
                'open', coalesce(cardinality(c.privs) > 0 and (not c.rls or cardinality(c.write_policies) > 0), false),
                'authenticated_still_reads', c.authenticated_select
              ) order by l.name)
               from listed l left join census c on c.name = l.name)
) as report;
