-- PREFLIGHT / POST-CHECK REPORT for supabase/schema_phase_calibration_queue_write_revoke.sql
--
-- ONE read-only statement, ONE row, one jsonb column. Catalog only — it reads
-- no table row — and it answers where public.calibration_rules does not
-- exist. Run it before the migration ("hole_open": true → apply) and after
-- it ("hole_open": false).
--
-- The table is OPEN when anon or authenticated holds INSERT, UPDATE, DELETE
-- or TRUNCATE on it AND either row level security is off or a permissive
-- policy admits a write (INSERT / UPDATE / DELETE / ALL).
--
--   listed     the migration's one table: whether it exists here, its owner
--              and whether the role running this report can revoke that
--              owner's grants ("this_role_can_revoke" — where false the
--              migration's revoke changes nothing and says so under
--              "not_closed"), row level security, the write privileges the
--              API roles hold, its write policies WITH THEIR CHECK
--              EXPRESSIONS ("admits_a_global_row": the check holds
--              `org_id IS NULL` — a rule for every company), "open", and
--              whether authenticated still holds SELECT.
--   hole_open  the table is open: a signed-in user's own JWT puts a row into
--              the operator's calibration review queue.
--
-- The list is held to the migration's (tests/engine/test_entitlement_hole_laws.py).
-- The whole census of open tables is in
-- supabase/preflight/schema_phase_public_tables_write_revoke_preflight_report.sql.

with listed(name) as (values
    ('calibration_rules')
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
         (select coalesce(jsonb_agg(jsonb_build_object(
                    'name', pol.polname,
                    'cmd', case pol.polcmd when 'a' then 'INSERT' when 'w' then 'UPDATE'
                                           when 'd' then 'DELETE' else 'ALL' end,
                    'using', pg_get_expr(pol.polqual, pol.polrelid),
                    'with_check', pg_get_expr(pol.polwithcheck, pol.polrelid),
                    'admits_a_global_row', coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid),
                                                    pg_get_expr(pol.polqual, pol.polrelid), '') ~* 'org_id\s+is\s+null')
                  order by pol.polname), '[]'::jsonb)
            from pg_policy pol
           where pol.polrelid = c.oid and pol.polpermissive and pol.polcmd in ('a', 'w', 'd', '*')) as write_policy_detail,
         has_table_privilege('authenticated', c.oid, 'SELECT') as authenticated_select
    from pg_class c
    join listed l on l.name = c.relname
   where c.relnamespace = to_regnamespace('public') and c.relkind in ('r', 'p')
)
select jsonb_build_object(
  'report', 'calibration-queue-write-revoke',
  'migration', 'supabase/schema_phase_calibration_queue_write_revoke.sql',
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
                'write_policies', coalesce(c.write_policy_detail, '[]'::jsonb),
                'open', coalesce(cardinality(c.privs) > 0 and (not c.rls or cardinality(c.write_policies) > 0), false),
                'authenticated_still_reads', c.authenticated_select
              ) order by l.name)
               from listed l left join census c on c.name = l.name)
) as report;
