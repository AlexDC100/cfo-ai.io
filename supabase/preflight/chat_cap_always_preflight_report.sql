-- PREFLIGHT REPORT for the redeploy of supabase/functions/chat-llm
-- ("Ask CFO AI — the cap is always enforced", 2026-10-03).
--
-- WHY: the function FAILS CLOSED. From this deploy on, every call of a
-- signed-in user asks reserve_user_chat before the model is called, and a
-- meter that cannot be asked is answered 503 metering_unavailable — never
-- "allowed". Until this deploy the reservation sat behind
-- USAGE_LIMITS_ENABLED, unset in production: the three functions below may
-- never have been called there. If one of them, a table or a column is
-- missing on the database the function talks to, the deploy turns Ask CFO AI
-- off for EVERYONE. Run this first; deploy only on "ready": true.
--
-- ONE read-only statement, ONE row, one jsonb column. It answers on a
-- database where none of the objects exist (to_regclass / to_regprocedure;
-- the tables are read through query_to_xml only where they are there). It
-- writes nothing, locks nothing, sets nothing.
--
--   ready            the meter can be asked: the three functions exist under
--                    the names and argument names the function calls them
--                    with, each exactly once (an overload makes the call
--                    ambiguous), service_role may execute them, and the
--                    tables, columns and unique keys they use are there.
--   blocking         what is missing, in words, when ready is false.
--   functions_are_this_repository
--                    each body is, byte for byte, the one in
--                    supabase/schema_phase_pricing_v3_atomic.sql (md5 of
--                    prosrc; scripts/check_chat_cap_real.py holds the three
--                    literals below to that file). false → read the
--                    installed bodies before deploying: the cap would be
--                    whatever THEY decide.
--   meter_closed_to_browser_roles
--                    neither anon nor authenticated may execute any of the
--                    three (a browser that could would move its own counter).
--
-- It reads ROWS in three places and returns COUNTS only, never a user:
--   subscriptions.rows_by_stored_key   how many rows the function will read
--        as which tier string — `tier` when it is set, else `plan` (the
--        engine's `row.get("tier") or row.get("plan")`). The key → caps table
--        is CLAUDE.md, "Ask CFO AI — the cap is always enforced"; no cap
--        number is repeated here.
--   subscriptions.users_without_a_row  auth users with no row (trial caps).
--   meter                              counter rows that exist today, and
--        reservations left open (a call the platform killed mid-flight, or a
--        commit / release that failed: each still fills a slot).

with want(name, sig, argnames, repo_md5) as (
  values
    ('reserve_user_chat', 'public.reserve_user_chat(uuid,text,date,integer,integer)',
       array['p_user_id', 'p_month', 'p_day', 'p_daily_cap', 'p_monthly_cap'], '79ac6678d83f783861f799d906dc6f1a'),
    ('commit_user_chat',  'public.commit_user_chat(uuid,text,date)',
       array['p_user_id', 'p_month', 'p_day'], '7f8f5bebbb13f2ce4a9fdff0cb68bafb'),
    ('release_user_chat', 'public.release_user_chat(uuid,text,date)',
       array['p_user_id', 'p_month', 'p_day'], 'be8018f441f8a8fd5735d045237e2f67')
),
roles as (
  select exists (select 1 from pg_roles where rolname = 'service_role')  as has_service_role,
         exists (select 1 from pg_roles where rolname = 'anon')          as has_anon,
         exists (select 1 from pg_roles where rolname = 'authenticated') as has_authenticated
),
fn as (
  select w.name,
         w.sig,
         p.oid is not null as present,
         (select count(*) from pg_proc q join pg_namespace n on n.oid = q.pronamespace
           where n.nspname = 'public' and q.proname = w.name) as functions_of_this_name,
         coalesce(p.proargnames::text[] = w.argnames, false) as argument_names_match,
         p.prosecdef as security_definer,
         md5(p.prosrc) as body_md5,
         coalesce(md5(p.prosrc) = w.repo_md5, false) as body_is_this_repository,
         case when p.oid is not null and r.has_service_role
              then has_function_privilege('service_role', p.oid, 'EXECUTE') end as service_role_may_execute,
         case when p.oid is not null and r.has_anon
              then has_function_privilege('anon', p.oid, 'EXECUTE') end as anon_may_execute,
         case when p.oid is not null and r.has_authenticated
              then has_function_privilege('authenticated', p.oid, 'EXECUTE') end as authenticated_may_execute
    from want w
    cross join roles r
    left join pg_proc p on p.oid = to_regprocedure(w.sig)
),
tbl(name, cols) as (
  values
    ('public.subscriptions',          array['user_id', 'tier', 'plan']),
    ('public.user_usage',             array['user_id', 'month', 'llm_calls', 'llm_calls_reserved']),
    ('public.plan_chat_daily_usage',  array['user_id', 'day', 'count', 'reserved', 'updated_at'])
),
tbl_facts as (
  select t.name,
         to_regclass(t.name) is not null as present,
         (select coalesce(array_agg(c order by c), '{}'::text[])
            from unnest(t.cols) as c
           where not exists (select 1 from pg_attribute a
                              where a.attrelid = to_regclass(t.name) and a.attname = c
                                and a.attnum > 0 and not a.attisdropped)) as missing_columns
    from tbl t
),
uq(name, key) as (
  values
    ('public.user_usage',            array['month', 'user_id']),
    ('public.plan_chat_daily_usage', array['day', 'user_id'])
),
uq_facts as (
  select u.name, u.key,
         exists (select 1 from pg_index i
                  where i.indrelid = to_regclass(u.name) and i.indisunique and i.indisvalid and i.indpred is null
                    and (select array_agg(a.attname::text order by a.attname::text)
                           from pg_attribute a
                          where a.attrelid = i.indrelid and a.attnum = any (i.indkey::int2[])) = u.key) as present
    from uq u
),
blocking as (
  select array_remove(array[
      (select 'the role service_role does not exist' from roles where not has_service_role)
    ] || array(
      select case
               when not f.present and f.functions_of_this_name = 0 then f.sig || ' does not exist'
               when not f.present then f.name || ' exists, but not with the signature ' || f.sig
               when f.functions_of_this_name > 1 then f.name || ' is overloaded (' || f.functions_of_this_name || ' functions): a request by argument names may be ambiguous'
               when not f.argument_names_match then f.name || ' has other argument names than the function calls it with'
               when f.service_role_may_execute is not true then 'service_role may not execute ' || f.name
             end
        from fn f order by f.name
    ) || array(
      select case
               when not t.present then t.name || ' does not exist'
               when cardinality(t.missing_columns) > 0 then t.name || ' has no column ' || array_to_string(t.missing_columns, ', ')
             end
        from tbl_facts t order by t.name
    ) || array(
      select u.name || ' has no unique key on (' || array_to_string(u.key, ', ') || ') — the meter''s ON CONFLICT needs it'
        from uq_facts u
       where not u.present and to_regclass(u.name) is not null
       order by u.name
    ), null) as items
)
select jsonb_build_object(
  'report', 'chat-cap-always',
  'for', 'the deploy of supabase/functions/chat-llm',
  'ready', cardinality((select items from blocking)) = 0,
  'blocking', to_jsonb((select items from blocking)),
  'functions_are_this_repository', not exists (select 1 from fn where not body_is_this_repository),
  'meter_closed_to_browser_roles', not exists (select 1 from fn where anon_may_execute or authenticated_may_execute),
  'functions', (select jsonb_object_agg(f.name, jsonb_build_object(
      'signature', f.sig,
      'exists', f.present,
      'functions_of_this_name', f.functions_of_this_name,
      'argument_names_match', f.argument_names_match,
      'security_definer', f.security_definer,
      'body_md5', f.body_md5,
      'body_is_this_repository', f.body_is_this_repository,
      'service_role_may_execute', f.service_role_may_execute,
      'anon_may_execute', f.anon_may_execute,
      'authenticated_may_execute', f.authenticated_may_execute)) from fn f),
  'tables', (select jsonb_object_agg(t.name, jsonb_build_object(
      'exists', t.present,
      'missing_columns', to_jsonb(t.missing_columns),
      'unique_key', (select jsonb_build_object('columns', to_jsonb(u.key), 'exists', u.present)
                       from uq_facts u where u.name = t.name))) from tbl_facts t),
  'subscriptions', jsonb_build_object(
      'rows_by_stored_key', case
          when exists (select 1 from tbl_facts where name = 'public.subscriptions' and present and cardinality(missing_columns) = 0)
          then ((xpath('/row/j/text()', query_to_xml($count$
                  select coalesce(jsonb_agg(jsonb_build_object('read_from', x.src, 'key', x.k, 'rows', x.n)
                                            order by x.n desc, x.k, x.src), '[]'::jsonb)::text as j
                    from (select case when coalesce(tier::text, '') <> '' then 'tier'
                                      when coalesce(plan::text, '') <> '' then 'plan'
                                      else 'neither' end as src,
                                 lower(btrim(coalesce(nullif(tier::text, ''), nullif(plan::text, ''), ''))) as k,
                                 count(*) as n
                            from public.subscriptions
                           group by 1, 2) x
                $count$, false, true, '')))[1]::text)::jsonb
          end,
      'users_without_a_row', case
          when to_regclass('auth.users') is not null
               and exists (select 1 from tbl_facts where name = 'public.subscriptions' and present and not ('user_id' = any (missing_columns)))
          then ((xpath('/row/n/text()', query_to_xml($count$
                  select count(*) as n from auth.users u
                   where not exists (select 1 from public.subscriptions s where s.user_id = u.id)
                $count$, false, true, '')))[1]::text)::bigint
          end),
  'meter', jsonb_build_object(
      'utc_day', to_char(now() at time zone 'utc', 'YYYY-MM-DD'),
      'utc_month', to_char(now() at time zone 'utc', 'YYYY-MM'),
      'daily_rows_today', case
          when exists (select 1 from tbl_facts where name = 'public.plan_chat_daily_usage' and present and cardinality(missing_columns) = 0)
          then ((xpath('/row/j/text()', query_to_xml($count$
                  select jsonb_build_object(
                           'users', count(*),
                           'messages_counted', coalesce(sum("count"), 0),
                           'reservations_open', coalesce(sum(reserved), 0))::text as j
                    from public.plan_chat_daily_usage
                   where day = (now() at time zone 'utc')::date
                $count$, false, true, '')))[1]::text)::jsonb
          end,
      'monthly_rows_this_month', case
          when exists (select 1 from tbl_facts where name = 'public.user_usage' and present and cardinality(missing_columns) = 0)
          then ((xpath('/row/j/text()', query_to_xml($count$
                  select jsonb_build_object(
                           'users_with_a_message', count(*) filter (where llm_calls > 0),
                           'messages_counted', coalesce(sum(llm_calls), 0),
                           'reservations_open', coalesce(sum(llm_calls_reserved), 0))::text as j
                    from public.user_usage
                   where month = to_char(now() at time zone 'utc', 'YYYY-MM')
                $count$, false, true, '')))[1]::text)::jsonb
          end)
) as report;
