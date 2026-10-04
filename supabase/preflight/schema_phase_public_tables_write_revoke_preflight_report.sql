-- PREFLIGHT / POST-CHECK REPORT for supabase/schema_phase_public_tables_write_revoke.sql
--
-- ONE read-only statement, ONE row, one jsonb column. Catalog only — it reads
-- no table row — and it answers whatever tables this database holds. Run it
-- before the migration ("hole_open": true → apply) and after it
-- ("hole_open": false).
--
-- A table is OPEN when anon or authenticated holds INSERT, UPDATE, DELETE or
-- TRUNCATE on it AND either row level security is off or a permissive policy
-- admits a write (INSERT / UPDATE / DELETE / ALL).
--
--   listed            the migration's tables, one entry each: whether it
--                     exists here, its owner and whether the role running
--                     this report can revoke that owner's grants
--                     ("this_role_can_revoke" — where false the migration's
--                     revoke changes nothing there and says so under
--                     "not_closed"), row level security, the write privileges
--                     the API roles hold, its write policies, and "open".
--   hole_open         some LISTED table is open.
--   other_open_tables THE REST OF THE CENSUS — every other open table in
--                     schema public, each with what this repository knows
--                     about it:
--                       "a user's JWT writes it" — its policies are what
--                           scope the write (not this file's to close);
--                       "closed by <another file>";
--                       "NOT KNOWN TO THIS REPOSITORY" — a table no committed
--                           file creates. READ THESE: with row level
--                           security off, the anon key writes them. This
--                           file does not guess who writes a table it has
--                           never seen.
--   api_writable_views  every VIEW in schema public that anon or
--                     authenticated may INSERT into, UPDATE or DELETE from
--                     and that Postgres will write through (auto-updatable,
--                     or with an INSTEAD OF trigger). A view that is not
--                     security_invoker writes its table AS THE VIEW'S OWNER —
--                     past the table's row level security and past every
--                     revoke in this file. The repository defines none; a
--                     hand-made one is named here with its options. Expected:
--                     []. NOT part of "hole_open" (the migration does not
--                     touch a view) — read it.
--
-- The three lists below are held to the migration's list and to the
-- classification in tests/engine/test_entitlement_hole_laws.py.

with listed(name, block) as (values
    ('company_exposure_profiles',         'row level security off'),
    ('company_signal_links',              'row level security off'),
    ('intelligence_signals',              'row level security off'),
    ('macro_signal_cache',                'row level security off'),
    ('nasdaq_responses',                  'row level security off'),
    ('public_companies',                  'row level security off'),
    ('public_company_opportunity_scores', 'row level security off'),
    ('public_company_periods',            'row level security off'),
    ('public_company_quotes',             'row level security off'),
    ('public_company_risk_scores',        'row level security off'),
    ('risk_interpretations',              'row level security off'),
    ('sector_risk_models',                'row level security off'),
    ('calibration_rules',                 'a policy admits a global row from any signed-in user')
),
known(name, what) as (values
    -- closed by another file
    ('dashboard_configs',           'closed by schema_phase_dashboard_config_caller.sql'),
    ('subscriptions',               'closed by the subscriptions write lockdown'),
    ('user_usage',                  'closed by the subscriptions write lockdown'),
    ('plan_chat_daily_usage',       'closed by the subscriptions write lockdown'),
    ('benchmark_reports',           'closed by schema_phase_derived_tables_write_revoke.sql'),
    ('briefings',                   'closed by schema_phase_derived_tables_write_revoke.sql'),
    ('calculated_metrics',          'closed by schema_phase_derived_tables_write_revoke.sql'),
    ('org_coa_mappings_overrides',  'closed by schema_phase_derived_tables_write_revoke.sql'),
    ('sku_analyses',                'closed by schema_phase_derived_tables_write_revoke.sql'),
    ('statement_line_items',        'closed by schema_phase_derived_tables_write_revoke.sql'),
    -- a user's JWT writes it (the browser, or the engine's per_user(jwt) client)
    ('activity',                     'a user''s JWT writes it'),
    ('alert_states',                 'a user''s JWT writes it'),
    ('alerts',                       'a user''s JWT writes it'),
    ('chat_messages',                'a user''s JWT writes it'),
    ('chat_threads',                 'a user''s JWT writes it'),
    ('company_industry_assignments', 'a user''s JWT writes it'),
    ('datasets',                     'a user''s JWT writes it'),
    ('documents',                    'a user''s JWT writes it'),
    ('financial_periods',            'a user''s JWT writes it'),
    ('firm_attention_suppressions',  'a user''s JWT writes it'),
    ('firm_briefs',                  'a user''s JWT writes it'),
    ('firm_client_cadence',          'a user''s JWT writes it'),
    ('firm_digest_prefs',            'a user''s JWT writes it'),
    ('firm_file_requests',           'a user''s JWT writes it'),
    ('organizations',                'a user''s JWT writes it'),
    ('profiles',                     'a user''s JWT writes it'),
    ('radar_dismissals',             'a user''s JWT writes it'),
    ('recommendations',              'a user''s JWT writes it'),
    ('user_prefs',                   'a user''s JWT writes it'),
    ('sales_datasets',               'a user''s JWT writes it'),
    ('sku_aggregates',               'a user''s JWT writes it'),
    ('user_valuation_assumptions',   'a user''s JWT writes it'),
    -- its policies were written for a user-JWT writer; no code path writes it today
    ('benchmark_peers',              'policies written for a user''s JWT; no writer today'),
    ('coa_mappings',                 'policies written for a user''s JWT; no writer today'),
    ('firm_covenants',               'policies written for a user''s JWT; no writer today'),
    ('firms',                        'policies written for a user''s JWT; no writer today'),
    ('invoice_lines',                'policies written for a user''s JWT; no writer today'),
    ('invoices',                     'policies written for a user''s JWT; no writer today'),
    ('org_prefs',                    'policies written for a user''s JWT; no writer today'),
    ('workspaces',                   'policies written for a user''s JWT; no writer today')
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
                order by 1) as write_policies
    from pg_class c
   where c.relnamespace = to_regnamespace('public') and c.relkind in ('r', 'p')
),
open_tables as (
  select * from census
   where cardinality(privs) > 0 and (not rls or cardinality(write_policies) > 0)
)
select jsonb_build_object(
  'report', 'public-tables-write-revoke',
  'migration', 'supabase/schema_phase_public_tables_write_revoke.sql',
  'hole_open', exists (select 1 from open_tables o join listed l on l.name = o.name),
  'listed_open_count', (select count(*) from open_tables o join listed l on l.name = o.name),
  'listed_this_role_cannot_revoke', (select coalesce(jsonb_agg(o.name order by o.name), '[]'::jsonb)
                                       from open_tables o join listed l on l.name = o.name where not o.revocable),
  'listed', (select jsonb_agg(jsonb_build_object(
                'table', l.name,
                'why_listed', l.block,
                'exists', c.oid is not null,
                'owner', c.owner,
                'this_role_can_revoke', c.revocable,
                'row_level_security', c.rls,
                'api_write_privileges', coalesce(to_jsonb(c.privs), '[]'::jsonb),
                'write_policies', coalesce(to_jsonb(c.write_policies), '[]'::jsonb),
                'open', coalesce(cardinality(c.privs) > 0 and (not c.rls or cardinality(c.write_policies) > 0), false),
                'anon_can_write', coalesce(exists (select 1 from unnest(c.privs) p where p like 'anon:%') and not c.rls, false)
              ) order by l.name)
               from listed l left join census c on c.name = l.name),
  'other_open_tables', (select coalesce(jsonb_agg(jsonb_build_object(
                'table', o.name,
                'row_level_security', o.rls,
                'api_write_privileges', to_jsonb(o.privs),
                'write_policies', to_jsonb(o.write_policies),
                'this_repository_says', coalesce(k.what, 'NOT KNOWN TO THIS REPOSITORY')
              ) order by (k.what is not null), o.rls, o.name), '[]'::jsonb)
               from open_tables o
               left join known k on k.name = o.name
              where not exists (select 1 from listed l where l.name = o.name)),
  'open_tables_not_known_to_this_repository', (select coalesce(jsonb_agg(o.name order by o.name), '[]'::jsonb)
               from open_tables o
              where not exists (select 1 from listed l where l.name = o.name)
                and not exists (select 1 from known k where k.name = o.name)),
  'rls_off_tables_not_known_to_this_repository', (select coalesce(jsonb_agg(o.name order by o.name), '[]'::jsonb)
               from open_tables o
              where not o.rls
                and not exists (select 1 from listed l where l.name = o.name)
                and not exists (select 1 from known k where k.name = o.name)),
  'api_writable_views', (select coalesce(jsonb_agg(jsonb_build_object(
                'view', v.relname,
                'security_invoker', coalesce(v.reloptions::text ~ 'security_invoker=(true|on)', false),
                'owner', pg_get_userbyid(v.relowner),
                'api_write_privileges', to_jsonb(array(
                    select r.rolname || ':' || pr
                      from (values ('anon'), ('authenticated')) as r(rolname)
                     cross join unnest(array['INSERT', 'UPDATE', 'DELETE']) as pr
                     where has_table_privilege(r.rolname, v.oid, pr)
                     order by 1))
              ) order by v.relname), '[]'::jsonb)
               from pg_class v
              where v.relnamespace = to_regnamespace('public') and v.relkind = 'v'
                and (pg_relation_is_updatable(v.oid, true) & 28) <> 0     -- 4 UPDATE, 8 INSERT, 16 DELETE
                and exists (select 1
                              from (values ('anon'), ('authenticated')) as r(rolname)
                             cross join unnest(array['INSERT', 'UPDATE', 'DELETE']) as pr
                             where has_table_privilege(r.rolname, v.oid, pr))),
  'public_tables_examined', (select count(*) from census)
) as report;
