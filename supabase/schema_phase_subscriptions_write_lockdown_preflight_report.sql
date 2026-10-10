-- PRE-FLIGHT and POST-CHECK of supabase/schema_phase_subscriptions_write_lockdown.sql
-- — READ-ONLY. ONE statement, ONE row, one jsonb column: `report`.
--
-- Run it BEFORE the migration (is the hole open here? what will the file
-- change? what will it not close?) and AGAIN AFTER it (the post-check:
-- `report.verdict.fully_locked` must be true). It changes nothing: a single
-- WITH … SELECT over the system catalogs, no function that writes, no table
-- of the product read. It runs as one prepared statement, so every client
-- takes it: `supabase db query --linked -f <this file>`, Studio, psql.
--
-- WHAT `report.verdict` SAYS
--   state                "hole_open" | "stopgap_in_place" | "fully_locked" | "neither"
--   hole_open            public.subscriptions has row level security off or a
--                        policy whose command is not SELECT, AND anon or
--                        authenticated holds INSERT, UPDATE or DELETE on it
--                        (table or column level). A signed-in user can write
--                        their own plan row.
--   stopgap_in_place     no such policy, row level security on, and neither
--                        role holds INSERT / UPDATE / DELETE / TRUNCATE /
--                        REFERENCES / TRIGGER on subscriptions — but the
--                        database is not yet in the migration's end state.
--   fully_locked         the exact end state the migration verifies before it
--                        commits, read here from the catalog: on every listed
--                        table that exists — row level security on; anon
--                        holding nothing; authenticated holding nothing but
--                        SELECT on the three user-readable tables (MAINTAIN
--                        counted on Postgres 17+); no policy that is not a
--                        SELECT policy; each user-readable table carrying
--                        exactly its one own-row SELECT policy; authenticated
--                        holding SELECT on subscriptions.
--   why_not_fully_locked one line per reason (empty when fully_locked).
--   tables_not_owned_by_runner   the migration stops on these ("is owned by …").
--   policies_this_file_will_drop every policy the migration would drop today
--                        (a kept policy in another form — say without `to
--                        authenticated` — is dropped and re-created: it is on
--                        both lists);
--   policies_this_file_will_create   the kept policies it would create.
--   views_that_can_be_written_through   NOT closed by the migration.
--   functions_an_api_role_may_execute   that name a listed table.
-- The sections beside it: `listed_tables` (per table: exists, row level
-- security, owner, what anon / authenticated / PUBLIC hold, the table ACL and
-- the column ACLs with their grantors, the policies), `views` (every view
-- that reads a listed table directly or through another view, with
-- security_invoker, whether it can be written through, and what the API roles
-- hold on it), `public_views_with_an_api_write_privilege` (whatever they
-- read), `functions`, `server_version_num`.
--
-- THE LIST below is the migration's (tests/engine/test_entitlement_write_laws.py
-- reds when the two differ).

with recursive
listed (name, user_readable) as (
  values
    -- ENTITLEMENT-TABLES-USER-READABLE-BEGIN
    ('subscriptions', true),
    ('user_usage', true),
    ('plan_chat_daily_usage', true),
    -- ENTITLEMENT-TABLES-USER-READABLE-END
    -- ENTITLEMENT-TABLES-SERVICE-ONLY-BEGIN
    ('document_quota_ledger', false),
    ('founding_members', false),
    ('billing_events', false),
    ('renewal_email_queue', false),
    ('plan_assignment_audit', false)
    -- ENTITLEMENT-TABLES-SERVICE-ONLY-END
),
kept (name, policy, using_expr) as (
  values
    -- ENTITLEMENT-KEPT-POLICIES-BEGIN
    ('subscriptions', 'subscriptions self select', '(auth.uid() = user_id)'),
    ('user_usage', 'users_see_own_usage', '(auth.uid() = user_id)'),
    ('plan_chat_daily_usage', 'plan_chat_daily_usage_own_select', '(user_id = auth.uid())')
    -- ENTITLEMENT-KEPT-POLICIES-END
),
privs (p) as (
  select unnest(array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'SELECT']
                || case when current_setting('server_version_num')::int >= 170000
                        then array['MAINTAIN'] else array[]::text[] end)
),
api (role, role_oid) as (
  select r.rolname::text, r.oid from pg_roles r where r.rolname in ('anon', 'authenticated')
),
t as (
  select l.name, l.user_readable, c.oid,
         c.relrowsecurity as rls, c.relforcerowsecurity as force_rls,
         pg_get_userbyid(c.relowner)::text as owner,
         case when c.oid is not null then pg_has_role(current_user, c.relowner, 'USAGE') end as runner_owns,
         c.relacl, c.relowner
    from listed l
    left join pg_class c
      on c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and c.relname = l.name
),
eff as (
  select t.name, t.user_readable, a.role,
         coalesce((select array_agg(p.p order by p.p) from privs p
                    where case when p.p in ('INSERT', 'UPDATE', 'REFERENCES', 'SELECT')
                               then has_any_column_privilege(a.role_oid, t.oid, p.p)
                               else has_table_privilege(a.role_oid, t.oid, p.p) end),
                  '{}'::text[]) as held
    from t cross join api a
   where t.oid is not null
),
pol as (
  select p.tablename::text as name, p.policyname::text as policy, p.cmd, p.permissive,
         p.roles::text as roles, p.qual, p.with_check,
         (k.name is not null and p.policyname = k.policy and p.cmd = 'SELECT'
          and p.permissive = 'PERMISSIVE' and p.roles = array['authenticated']::name[]
          and p.qual = k.using_expr) as is_the_kept_policy,
         (k.name is not null) as on_a_user_readable_table
    from pg_policies p
    join listed l on l.name = p.tablename
    left join kept k on k.name = p.tablename
   where p.schemaname = 'public'
),
problems as (
  select t.name, 'row level security is OFF' as why
    from t where t.oid is not null and not t.rls
  union all
  select e.name,
         e.role || ' holds ' || array_to_string(array(
           select x from unnest(e.held) x
            where not (x = 'SELECT' and e.role = 'authenticated' and e.user_readable)), ', ')
    from eff e
   where exists (select 1 from unnest(e.held) x
                  where not (x = 'SELECT' and e.role = 'authenticated' and e.user_readable))
  union all
  select t.name,
         (select count(*) from pol p where p.name = t.name)
         || ' policy(ies) — exactly one is expected: "' || k.policy || '", own row, SELECT, to authenticated'
    from t join kept k on k.name = t.name
   where t.oid is not null
     and ((select count(*) from pol p where p.name = t.name) <> 1
          or not exists (select 1 from pol p where p.name = t.name and p.is_the_kept_policy))
  union all
  select t.name,
         (select count(*) from pol p where p.name = t.name and p.cmd <> 'SELECT')
         || ' policy(ies) with a command other than SELECT'
    from t
   where t.oid is not null and not t.user_readable
     and exists (select 1 from pol p where p.name = t.name and p.cmd <> 'SELECT')
  union all
  select 'subscriptions', 'the table does not exist — this is not the product''s database'
   where not exists (select 1 from t where t.name = 'subscriptions' and t.oid is not null)
  union all
  select t.name, 'authenticated does not hold SELECT — the product reads its own row'
    from t
   where t.name = 'subscriptions' and t.oid is not null
     and not has_table_privilege((select a.role_oid from api a where a.role = 'authenticated'), t.oid, 'SELECT')
),
walk (view_oid, depth) as (
  select w.ev_class, 1
    from pg_rewrite w
    join pg_depend d on d.classid = 'pg_rewrite'::regclass and d.objid = w.oid
                    and d.refclassid = 'pg_class'::regclass
    join t on t.oid = d.refobjid
   where w.ev_class <> d.refobjid
  union
  select w.ev_class, walk.depth + 1
    from walk
    join pg_depend d on d.refclassid = 'pg_class'::regclass and d.refobjid = walk.view_oid
                    and d.classid = 'pg_rewrite'::regclass
    join pg_rewrite w on w.oid = d.objid
   where w.ev_class <> walk.view_oid and walk.depth < 10
),
vw as (
  select v.oid,
         v.relnamespace::regnamespace::text || '.' || quote_ident(v.relname) as view,
         min(walk.depth) as depth,
         coalesce((select o.option_value from pg_options_to_table(v.reloptions) o
                    where o.option_name = 'security_invoker'), 'false') = 'true' as security_invoker,
         (pg_relation_is_updatable(v.oid, false) & 28) <> 0 as updatable,
         pg_get_userbyid(v.relowner)::text as owner
    from walk
    join pg_class v on v.oid = walk.view_oid and v.relkind in ('v', 'm')
   group by v.oid, v.relnamespace, v.relname, v.reloptions, v.relowner
),
vwp as (
  select vw.*,
         coalesce((select array_agg(a.role || ':' || p order by a.role, p)
                     from api a, unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p
                    where has_table_privilege(a.role_oid, vw.oid, p)), '{}'::text[]) as api_privileges,
         exists (select 1 from api a, unnest(array['INSERT', 'UPDATE', 'DELETE']) p
                  where has_table_privilege(a.role_oid, vw.oid, p)) as api_write
    from vw
),
pubviews as (
  select v.relname::text as view,
         (select array_agg(a.role || ':' || p order by a.role, p)
            from api a, unnest(array['INSERT', 'UPDATE', 'DELETE']) p
           where has_table_privilege(a.role_oid, v.oid, p)) as api_write_privileges,
         (pg_relation_is_updatable(v.oid, false) & 28) <> 0 as updatable,
         coalesce((select o.option_value from pg_options_to_table(v.reloptions) o
                    where o.option_name = 'security_invoker'), 'false') = 'true' as security_invoker
    from pg_class v
   where v.relnamespace = 'public'::regnamespace and v.relkind in ('v', 'm')
     and exists (select 1 from api a, unnest(array['INSERT', 'UPDATE', 'DELETE']) p
                  where has_table_privilege(a.role_oid, v.oid, p))
),
fn as (
  select p.oid::regprocedure::text as function, p.prosecdef as security_definer,
         has_function_privilege((select a.role_oid from api a where a.role = 'anon'), p.oid, 'EXECUTE') as anon_may_execute,
         has_function_privilege((select a.role_oid from api a where a.role = 'authenticated'), p.oid, 'EXECUTE') as authenticated_may_execute,
         (select array_agg(l.name order by l.name) from listed l
           where p.prosrc ~* ('\m' || l.name || '\M')) as names
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and exists (select 1 from listed l where p.prosrc ~* ('\m' || l.name || '\M'))
),
v as (
  select exists (select 1 from pol p where p.name = 'subscriptions' and p.cmd <> 'SELECT') as sub_write_policy,
         coalesce((select not t.rls from t where t.name = 'subscriptions' and t.oid is not null), false) as sub_rls_off,
         exists (select 1 from eff e where e.name = 'subscriptions'
                    and e.held && array['INSERT', 'UPDATE', 'DELETE']) as sub_api_write,
         exists (select 1 from eff e where e.name = 'subscriptions'
                    and e.held && array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) as sub_api_any_write,
         not exists (select 1 from problems) as fully_locked
)
select jsonb_build_object(
  'what', 'entitlement write lockdown — pre-flight / post-check (read-only)',
  'generated_at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  'database', current_database(),
  'run_as', current_user,
  'server_version_num', current_setting('server_version_num')::int,
  'verdict', jsonb_build_object(
    'state', case when v.fully_locked then 'fully_locked'
                  when (v.sub_write_policy or v.sub_rls_off) and v.sub_api_write then 'hole_open'
                  when not v.sub_write_policy and not v.sub_rls_off and not v.sub_api_any_write then 'stopgap_in_place'
                  else 'neither' end,
    'hole_open', ((v.sub_write_policy or v.sub_rls_off) and v.sub_api_write),
    'stopgap_in_place', (not v.fully_locked and not v.sub_write_policy and not v.sub_rls_off and not v.sub_api_any_write),
    'fully_locked', v.fully_locked,
    'why_not_fully_locked',
      (select coalesce(jsonb_agg('public.' || p.name || ': ' || p.why order by p.name, p.why), '[]'::jsonb) from problems p),
    'tables_not_owned_by_runner',
      (select coalesce(jsonb_agg(jsonb_build_object('table', t.name, 'owner', t.owner) order by t.name), '[]'::jsonb)
         from t where t.oid is not null and not t.runner_owns),
    'policies_this_file_will_drop',
      (select coalesce(jsonb_agg(jsonb_build_object('table', p.name, 'policy', p.policy, 'cmd', p.cmd, 'roles', p.roles)
                                 order by p.name, p.policy), '[]'::jsonb)
         from pol p
        where case when p.on_a_user_readable_table then not p.is_the_kept_policy else p.cmd <> 'SELECT' end),
    'policies_this_file_will_create',
      (select coalesce(jsonb_agg(jsonb_build_object('table', k.name, 'policy', k.policy,
                                                    'as', 'for select to authenticated using ' || k.using_expr)
                                 order by k.name), '[]'::jsonb)
         from kept k
         join t on t.name = k.name and t.oid is not null
        where not exists (select 1 from pol p where p.name = k.name and p.is_the_kept_policy)),
    'views_that_can_be_written_through',
      (select coalesce(jsonb_agg(x.view order by x.view), '[]'::jsonb)
         from vwp x where x.api_write and x.updatable and not x.security_invoker),
    'functions_an_api_role_may_execute',
      (select coalesce(jsonb_agg(f.function order by f.function), '[]'::jsonb)
         from fn f where f.anon_may_execute or f.authenticated_may_execute)),
  'listed_tables',
    (select jsonb_object_agg(t.name, case when t.oid is null then jsonb_build_object('exists', false)
       else jsonb_build_object(
         'exists', true,
         'user_readable', t.user_readable,
         'row_level_security', t.rls,
         'force_row_level_security', t.force_rls,
         'owner', t.owner,
         'runner_can_act_as_owner', t.runner_owns,
         'anon', (select array_to_string(e.held, ', ') from eff e where e.name = t.name and e.role = 'anon'),
         'authenticated', (select array_to_string(e.held, ', ') from eff e where e.name = t.name and e.role = 'authenticated'),
         'table_acl',
           (select coalesce(jsonb_agg(jsonb_build_object(
                     'grantee', case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee)::text end,
                     'privilege', a.privilege_type, 'grantor', pg_get_userbyid(a.grantor)::text,
                     'with_grant_option', a.is_grantable)
                     order by a.grantee, a.privilege_type), '[]'::jsonb)
              from aclexplode(coalesce(t.relacl, acldefault('r', t.relowner))) a
             where a.grantee = 0 or a.grantee in (select api.role_oid from api)),
         'column_acl',
           (select coalesce(jsonb_agg(jsonb_build_object(
                     'column', att.attname,
                     'grantee', case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee)::text end,
                     'privilege', a.privilege_type, 'grantor', pg_get_userbyid(a.grantor)::text)
                     order by att.attnum, a.grantee, a.privilege_type), '[]'::jsonb)
              from pg_attribute att, aclexplode(att.attacl) a
             where att.attrelid = t.oid and att.attnum > 0 and not att.attisdropped),
         'policies',
           (select coalesce(jsonb_agg(jsonb_build_object(
                     'policy', p.policy, 'cmd', p.cmd, 'roles', p.roles, 'using', p.qual,
                     'with_check', p.with_check, 'is_the_kept_policy', p.is_the_kept_policy)
                     order by p.policy), '[]'::jsonb)
              from pol p where p.name = t.name)) end)
       from t),
  'views',
    (select coalesce(jsonb_agg(jsonb_build_object(
              'view', x.view, 'depth', x.depth, 'owner', x.owner,
              'security_invoker', x.security_invoker,
              'can_be_written_through', (x.api_write and x.updatable and not x.security_invoker),
              'api_privileges', array_to_string(x.api_privileges, ' ')) order by x.view), '[]'::jsonb)
       from vwp x),
  'public_views_with_an_api_write_privilege',
    (select coalesce(jsonb_agg(jsonb_build_object(
              'view', x.view, 'api_write_privileges', array_to_string(x.api_write_privileges, ' '),
              'updatable', x.updatable, 'security_invoker', x.security_invoker) order by x.view), '[]'::jsonb)
       from pubviews x),
  'functions',
    (select coalesce(jsonb_agg(jsonb_build_object(
              'function', f.function, 'security_definer', f.security_definer,
              'anon_may_execute', f.anon_may_execute,
              'authenticated_may_execute', f.authenticated_may_execute,
              'names', array_to_string(f.names, ', ')) order by f.function), '[]'::jsonb)
       from fn f
      where not f.security_definer or f.anon_may_execute or f.authenticated_may_execute),
  'functions_naming_a_listed_table', (select count(*) from fn)
) as report
from v;
