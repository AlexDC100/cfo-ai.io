-- PREFLIGHT / POST-CHECK REPORT for supabase/schema_phase_workspace_cap_guard.sql
--
-- ONE read-only statement, ONE row, one jsonb column. It answers on a
-- database where organizations, its archive columns, the workspace functions
-- or the firm functions do not exist. Run it before the migration
-- ("hole_open": true → apply) and after it ("hole_open": false).
--
--   direct_write_open  anon or authenticated may UPDATE organizations.archived_at
--                      (privilege, and row level security off or an UPDATE / ALL
--                      policy that admits them) and the guard is not in place:
--                      a member PATCHes archived_at, creates a workspace, and
--                      PATCHes it back.
--   restore_uncapped   authenticated may execute restore_workspace(uuid),
--                      create_workspace enforces a cap, and the guard is not in
--                      place: archive → create → restore. The same verdict
--                      covers two requests at once (archive → create ∥ create;
--                      restore ∥ restore): the per-user lock is the guard's.
--   guard_in_place     the trigger organizations_guard_write exists on
--                      public.organizations, BEFORE INSERT OR UPDATE FOR EACH
--                      ROW, enabled (origin), and runs
--                      _organizations_guard_write() with exactly the body the
--                      migration installs
--                      (md5 'b93ee1df602e2f6c2eebb425fa1b97e7' —
--                      tests/engine/test_entitlement_hole_laws.py holds the two
--                      files to each other), as SECURITY INVOKER. A guard
--                      altered to SECURITY DEFINER keeps its body and refuses
--                      nothing — inside it current_user is the function's
--                      owner, never `authenticated` — so it is NOT in place.
--
-- "organizations.this_role_can_install_the_guard": whether the role running
-- this report may create a trigger on the table (its owner, or a role that
-- holds TRIGGER). Where it is false the migration installs nothing and says
-- so under "not_closed" — run it as "organizations.owner".
--
-- It reads ROWS in one place only, and returns a COUNT, never a user:
-- "users_over_their_cap" — how many users hold more LIVE workspaces than
-- create_workspace would let them have. The tier → cap mapping is READ OUT OF
-- THE INSTALLED create_workspace BODY (its `when '<tier>' then <n>` arms and
-- its `else <n> end`), not written here a second time; "cap_mapping_read"
-- shows what was read, and the count is null when nothing could be read.
-- A tier the CASE does not name falls to its ELSE — so with
-- schema_phase_owner_plan.sql applied, an unlimited internal plan is counted
-- as over. Those users are NOT touched by the migration: they keep every
-- workspace and cannot restore another until they are under the cap.

with org as (
  select c.oid, c.relrowsecurity as rls,
         pg_get_userbyid(c.relowner) as owner,
         has_table_privilege(current_user, c.oid, 'TRIGGER') as can_trigger
    from pg_class c
   where c.oid = to_regclass('public.organizations')
),
cols as (
  select coalesce(jsonb_agg(a.attname order by a.attname), '[]'::jsonb) as present
    from org
    join pg_attribute a on a.attrelid = org.oid and not a.attisdropped
   where a.attname in ('archived_at', 'purge_after', 'firm_id', 'cui')
),
has_archive as (
  select exists (select 1 from org join pg_attribute a on a.attrelid = org.oid
                  where a.attname = 'archived_at' and not a.attisdropped) as yes
),
guard as (
  select coalesce((
    select t.tgenabled = 'O' and t.tgtype = 23
           and md5(p.prosrc) = 'b93ee1df602e2f6c2eebb425fa1b97e7'
           and not p.prosecdef
      from org
      join pg_trigger t on t.tgrelid = org.oid and t.tgname = 'organizations_guard_write' and not t.tgisinternal
      join pg_proc p on p.oid = t.tgfoid), false) as in_place,
    (select jsonb_build_object(
              'enabled', case t.tgenabled when 'O' then 'origin (enabled)' when 'D' then 'DISABLED'
                                          when 'R' then 'replica only' else 'always' end,
              'before_insert_or_update_for_each_row', t.tgtype = 23,
              'function', t.tgfoid::regprocedure::text,
              'function_md5', md5(p.prosrc),
              'function_is_security_invoker', not p.prosecdef)
       from org
       join pg_trigger t on t.tgrelid = org.oid and t.tgname = 'organizations_guard_write' and not t.tgisinternal
       join pg_proc p on p.oid = t.tgfoid) as detail
),
writers as (
  -- the API roles that can UPDATE archived_at today: the column privilege,
  -- and a way past row level security
  select r.rolname
    from org, has_archive, (values ('anon'), ('authenticated')) as r(rolname)
   where case when has_archive.yes
              then has_column_privilege(r.rolname, org.oid, 'archived_at', 'UPDATE')
              else false end
     and (not org.rls
          or exists (select 1 from pg_policy pol
                      where pol.polrelid = org.oid and pol.polpermissive and pol.polcmd in ('w', '*')
                        and (pol.polroles = '{0}'::oid[]
                             or (select oid from pg_roles where rolname = r.rolname) = any (pol.polroles))))
),
fns as (
  select coalesce(jsonb_object_agg(p.oid::regprocedure::text, jsonb_build_object(
           'md5', md5(p.prosrc),
           'security_definer', p.prosecdef,
           'owner', pg_get_userbyid(p.proowner),
           'anon_can_execute', has_function_privilege('anon', p.oid, 'execute'),
           'authenticated_can_execute', has_function_privilege('authenticated', p.oid, 'execute'))), '{}'::jsonb) as detail
    from pg_proc p
   where p.pronamespace = to_regnamespace('public')
     and p.proname in ('create_workspace', 'restore_workspace', 'archive_workspace', 'purge_workspace',
                       'purge_expired_workspaces', 'create_firm', 'import_firm_client',
                       'detach_workspace_from_firm', 'attach_workspace_to_firm')
),
cw as (
  select p.prosrc
    from pg_proc p
   where p.oid = to_regprocedure('public.create_workspace(text,text,text)')
),
cap as (
  select
    coalesce((select cw.prosrc ~* 'workspace_cap_reached' from cw), false) as enforced,
    (select coalesce(jsonb_object_agg(lower(m[1]), m[2]::int), '{}'::jsonb)
       from cw, regexp_matches(cw.prosrc, 'when\s+''([A-Za-z_0-9]+)''\s+then\s+(\d+)', 'gi') as m) as by_tier,
    (select ((regexp_match(cw.prosrc, 'else\s+(\d+)\s+end', 'i'))[1])::int from cw) as otherwise
),
restore as (
  select coalesce((select has_function_privilege('authenticated', p.oid, 'execute')
                          or has_function_privilege('anon', p.oid, 'execute')
                     from pg_proc p
                    where p.oid = to_regprocedure('public.restore_workspace(uuid)')), false) as callable
),
verdict as (
  select
    (select yes from has_archive) and not (select in_place from guard)
      and exists (select 1 from writers) as direct_write_open,
    (select yes from has_archive) and not (select in_place from guard)
      and (select callable from restore) and (select enforced from cap) as restore_uncapped
)
select jsonb_build_object(
  'report', 'workspace-cap-guard',
  'migration', 'supabase/schema_phase_workspace_cap_guard.sql',
  'hole_open', (select direct_write_open or restore_uncapped from verdict),
  'direct_write_open', (select direct_write_open from verdict),
  'restore_uncapped', (select restore_uncapped from verdict),
  'guard_in_place', (select in_place from guard),
  'guard_trigger', coalesce((select detail from guard), 'null'::jsonb),
  'organizations', jsonb_build_object(
      'exists', exists (select 1 from org),
      'owner', (select owner from org),
      'this_role_can_install_the_guard', (select can_trigger from org),
      'row_level_security', (select rls from org),
      'guarded_columns_present', (select present from cols),
      'api_roles_holding_update_on_archived_at', (select coalesce(jsonb_agg(rolname order by rolname), '[]'::jsonb) from writers),
      'update_policies', (select coalesce(jsonb_agg(jsonb_build_object(
                              'name', pol.polname,
                              'cmd', case pol.polcmd when 'w' then 'UPDATE' else 'ALL' end,
                              'using', pg_get_expr(pol.polqual, pol.polrelid),
                              'with_check', pg_get_expr(pol.polwithcheck, pol.polrelid)) order by pol.polname), '[]'::jsonb)
                            from org join pg_policy pol on pol.polrelid = org.oid and pol.polcmd in ('w', '*'))),
  'workspace_functions', (select detail from fns),
  'create_workspace_enforces_a_cap', (select enforced from cap),
  'cap_mapping_read', jsonb_build_object(
      'from', 'the installed create_workspace(text,text,text) body — not a second copy of the numbers',
      'by_tier', (select by_tier from cap),
      'otherwise', (select otherwise from cap)),
  'firm_path_iii', jsonb_build_object(
      'create_firm_exists', to_regproc('public.create_firm') is not null,
      'import_firm_client_exists', to_regproc('public.import_firm_client') is not null,
      'detach_workspace_from_firm_exists', to_regproc('public.detach_workspace_from_firm') is not null,
      'note', 'NOT closed by this migration: create_firm → import_firm_client ×N → detach_workspace_from_firm gives a user N live workspaces whatever their plan. Whether a firm''s clients count against the importer''s cap is the owner''s ruling.'),
  'users_over_their_cap', case
      when to_regclass('public.memberships') is null or to_regclass('public.subscriptions') is null
           or not (select yes from has_archive) or (select otherwise from cap) is null
           or not exists (select 1 from pg_attribute
                           where attrelid = to_regclass('public.subscriptions') and attname = 'tier' and not attisdropped)
        then null
      else ((xpath('/row/n/text()', query_to_xml($count$
              select count(*) as n
                from (select m.user_id, count(*) as live
                        from public.memberships m
                        join public.organizations o on o.id = m.org_id
                       where o.archived_at is null
                       group by m.user_id) l
                left join public.subscriptions s on s.user_id = l.user_id
               cross join (select prosrc from pg_proc
                            where oid = to_regprocedure('public.create_workspace(text,text,text)')) f
               where l.live > coalesce(
                       (select (m2)[2]::int
                          from regexp_matches(f.prosrc, 'when\s+''([A-Za-z_0-9]+)''\s+then\s+(\d+)', 'gi') as m2
                         where lower((m2)[1]) = lower(coalesce(s.tier, ''))
                         limit 1),
                       ((regexp_match(f.prosrc, 'else\s+(\d+)\s+end', 'i'))[1])::int)
            $count$, false, true, '')))[1]::text)::int
    end,
  'users_over_their_cap_note', 'a count, never a list; the migration alters none of their rows'
) as report;
