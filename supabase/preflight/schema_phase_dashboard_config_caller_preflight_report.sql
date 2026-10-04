-- PREFLIGHT / POST-CHECK REPORT for supabase/schema_phase_dashboard_config_caller.sql
--
-- ONE read-only statement, ONE row, one jsonb column. It reads the catalog
-- only (no table row), and answers on a database where the function or the
-- table does not exist. Run it before the migration ("hole_open": true →
-- apply) and after it ("hole_open": false).
--
--   function_open  upsert_dashboard_config(uuid, jsonb) exists, is SECURITY
--                  DEFINER, does NOT carry the caller check (its body is not
--                  the one the migration installs), and anon, PUBLIC or
--                  authenticated may execute it: whoever calls it writes the
--                  row of whatever user id they hand it.
--   table_open     anon or authenticated holds INSERT on dashboard_configs
--                  and row level security is off or an INSERT / ALL policy
--                  admits them (the repository's "service_insert" policy is
--                  `with check (true)`), or holds UPDATE / DELETE with row
--                  level security off.
--
-- 'e44e90445fd49871e00e4d3451bc9738' is md5(prosrc) of the body the
-- migration installs (tests/engine/test_entitlement_hole_laws.py holds the
-- two files to each other).

with fn as (
  select p.oid,
         p.prosecdef,
         pg_get_userbyid(p.proowner) as owner,
         pg_has_role(current_user, p.proowner, 'USAGE') as replaceable,
         md5(p.prosrc) as body_md5,
         pg_get_function_result(p.oid) as returns,
         has_function_privilege('anon', p.oid, 'execute') as anon_x,
         has_function_privilege('authenticated', p.oid, 'execute') as authenticated_x,
         has_function_privilege('service_role', p.oid, 'execute') as service_role_x,
         exists (select 1
                   from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                  where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_x
    from pg_proc p
   where p.oid = to_regprocedure('public.upsert_dashboard_config(uuid,jsonb)')
),
tbl as (
  select c.oid,
         c.relrowsecurity as rls,
         pg_get_userbyid(c.relowner) as owner,
         pg_has_role(current_user, c.relowner, 'USAGE') as revocable
    from pg_class c
   where c.oid = to_regclass('public.dashboard_configs')
),
privs as (
  select r.rolname as role, pr as privilege
    from tbl
   cross join (values ('anon'), ('authenticated')) as r(rolname)
   cross join unnest(array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) as pr
   where has_table_privilege(r.rolname, tbl.oid, pr)
      or (pr in ('INSERT', 'UPDATE') and has_any_column_privilege(r.rolname, tbl.oid, pr))
),
pols as (
  select pol.polname as name,
         case pol.polcmd when 'r' then 'SELECT' when 'a' then 'INSERT' when 'w' then 'UPDATE'
                         when 'd' then 'DELETE' else 'ALL' end as cmd,
         pol.polpermissive as permissive,
         (select coalesce(array_agg(case when x = 0 then 'public' else pg_get_userbyid(x)::text end order by 1), array['public'])
            from unnest(pol.polroles) x) as roles,
         pg_get_expr(pol.polqual, pol.polrelid) as using_expr,
         pg_get_expr(pol.polwithcheck, pol.polrelid) as check_expr
    from pg_policy pol
    join tbl on tbl.oid = pol.polrelid
),
verdict as (
  select
    coalesce((select fn.prosecdef
                     and fn.body_md5 <> 'e44e90445fd49871e00e4d3451bc9738'
                     and (fn.anon_x or fn.public_x or fn.authenticated_x)
                from fn), false) as function_open,
    coalesce((select exists (
                       select 1 from privs p
                        where p.privilege = 'INSERT'
                          and (not tbl.rls
                               or exists (select 1 from pols
                                           where pols.permissive and pols.cmd in ('INSERT', 'ALL')
                                             and (pols.roles && array['public', p.role]))))
                     or (not tbl.rls and exists (select 1 from privs p where p.privilege in ('UPDATE', 'DELETE')))
                from tbl), false) as table_open
)
select jsonb_build_object(
  'report', 'dashboard-config-caller',
  'migration', 'supabase/schema_phase_dashboard_config_caller.sql',
  'hole_open', (select function_open or table_open from verdict),
  'function_open', (select function_open from verdict),
  'table_open', (select table_open from verdict),
  'function', coalesce((select jsonb_build_object(
      'exists', true,
      'security_definer', fn.prosecdef,
      'owner', fn.owner,
      'this_role_can_replace_it', fn.replaceable,
      'returns', fn.returns,
      'body_md5', fn.body_md5,
      'body_checks_the_caller', fn.body_md5 = 'e44e90445fd49871e00e4d3451bc9738',
      'body_is_the_repository_original', fn.body_md5 = 'ea2c5ab53ed8b7ee97994e05a8b48a10',
      'migration_will', case
          when not fn.replaceable then 'NOT touch it: another role owns it — run the migration as that role'
          when fn.body_md5 = 'e44e90445fd49871e00e4d3451bc9738' then 'leave the body (it already checks the caller)'
          when fn.body_md5 = 'ea2c5ab53ed8b7ee97994e05a8b48a10' and fn.returns = 'jsonb' then 'replace the body with the caller-checked one'
          else 'NOT replace the body (not one this repository committed): EXECUTE goes from PUBLIC, anon and authenticated — the service role only' end,
      'anon_can_execute', fn.anon_x,
      'public_can_execute', fn.public_x,
      'authenticated_can_execute', fn.authenticated_x,
      'service_role_can_execute', fn.service_role_x) from fn),
    jsonb_build_object('exists', false)),
  'other_overloads', (select coalesce(jsonb_agg(p.oid::regprocedure::text order by 1), '[]'::jsonb)
                        from pg_proc p
                       where p.pronamespace = to_regnamespace('public')
                         and p.proname = 'upsert_dashboard_config'
                         and p.oid is distinct from to_regprocedure('public.upsert_dashboard_config(uuid,jsonb)')),
  'table', coalesce((select jsonb_build_object(
      'exists', true,
      'row_level_security', tbl.rls,
      'owner', tbl.owner,
      'this_role_can_revoke_its_grants', tbl.revocable,
      'api_write_privileges', (select coalesce(jsonb_agg(p.role || ':' || p.privilege order by p.role, p.privilege), '[]'::jsonb) from privs p),
      'policies', (select coalesce(jsonb_agg(jsonb_build_object(
                      'name', pols.name, 'cmd', pols.cmd, 'roles', to_jsonb(pols.roles),
                      'using', pols.using_expr, 'with_check', pols.check_expr) order by pols.name), '[]'::jsonb) from pols)) from tbl),
    jsonb_build_object('exists', false))
) as report;
