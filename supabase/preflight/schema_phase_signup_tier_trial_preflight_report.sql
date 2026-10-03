-- PREFLIGHT / POST-CHECK REPORT for supabase/schema_phase_signup_tier_trial.sql
--
-- ONE read-only statement, ONE row, one jsonb column. It answers on a
-- database where auth.users, public.subscriptions or its tier column does
-- not exist. Run it before the migration ("hole_open": true → apply) and
-- after it ("hole_open": false).
--
--   signup_triggers   every INSERT trigger on auth.users ON THIS DATABASE: the
--                     function it runs, whether it is enabled, whether that
--                     function seeds a subscriptions row and, if so, the
--                     column list and the values it writes (read out of the
--                     installed body).
--   hole_open         public.subscriptions has a tier column with no default,
--                     and an enabled INSERT trigger on auth.users runs a
--                     function that seeds a subscriptions row WITHOUT the
--                     statement the migration installs
--                     (… plan, tier, … / … 'professional', 'trial', …): a new
--                     signup is written with tier NULL, and the engine
--                     (`row.tier or row.plan` → legacy map) meters it as
--                     Multi-Country.
--   tier_checks       every CHECK constraint that reads tier, and whether it
--                     accepts 'trial' — where one does not, the migration
--                     installs nothing (a signup would be refused).
--
-- It reads ROWS in one place only, and returns COUNTS, never a user:
-- "existing_rows" — public.subscriptions grouped by (tier is null, plan,
-- status, has a Stripe subscription). The migration alters none of them.

with sub as (
  select c.oid from pg_class c where c.oid = to_regclass('public.subscriptions')
),
tier_col as (
  select a.attnum, pg_get_expr(d.adbin, d.adrelid) as default_expr
    from sub
    join pg_attribute a on a.attrelid = sub.oid and a.attname = 'tier' and not a.attisdropped
    left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
),
checks as (
  select c.conname, pg_get_constraintdef(c.oid) as def,
         pg_get_constraintdef(c.oid) ~ '''trial''' as names_trial
    from sub
    join tier_col on true
    join pg_constraint c on c.conrelid = sub.oid and c.contype = 'c' and tier_col.attnum = any (c.conkey)
),
trg as (
  select t.tgname,
         t.tgenabled,
         p.oid::regprocedure::text as fn,
         md5(p.prosrc) as fn_md5,
         p.prosecdef,
         pg_get_userbyid(p.proowner) as fn_owner,
         p.prosrc ~* 'insert\s+into\s+(?:public\.)?subscriptions\M' as seeds,
         p.prosrc ~* ('insert\s+into\s+(?:public\.)?subscriptions\s*\(\s*user_id\s*,\s*plan\s*,\s*tier\s*,'
                   || '\s*billing_cycle\s*,\s*status\s*,\s*trial_start\s*,\s*trial_end\s*,'
                   || '\s*current_period_start\s*,\s*current_period_end\s*\)\s*values\s*\(\s*new\.id\s*,\s*''professional''\s*,\s*''trial''\s*,'
                   || '\s*''monthly''\s*,\s*''trial''\s*,') as writes_tier_trial,
         regexp_match(p.prosrc, 'insert\s+into\s+(?:public\.)?subscriptions\s*\(([^)]*)\)\s*values\s*\((.*?)\)\s*on\s+conflict', 'i') as seed
    from pg_trigger t
    join pg_proc p on p.oid = t.tgfoid
   where t.tgrelid = to_regclass('auth.users') and not t.tgisinternal and (t.tgtype & 4) = 4
),
verdict as (
  select exists (select 1 from tier_col where default_expr is null)
         and exists (select 1 from trg where tgenabled <> 'D' and seeds and not writes_tier_trial) as hole_open
)
select jsonb_build_object(
  'report', 'signup-tier-trial',
  'migration', 'supabase/schema_phase_signup_tier_trial.sql',
  'hole_open', (select hole_open from verdict),
  'new_signup_tier', case
      when not exists (select 1 from tier_col) then 'no tier column'
      when not exists (select 1 from trg where tgenabled <> 'D' and seeds) then 'no enabled trigger on auth.users seeds a subscriptions row'
      when (select hole_open from verdict) then 'NULL — the engine then reads plan, and plan ''professional'' is the Multi-Country allowance'
      when exists (select 1 from tier_col where default_expr is not null) and exists (select 1 from trg where tgenabled <> 'D' and seeds and not writes_tier_trial)
        then 'the column default: ' || (select default_expr from tier_col)
      else 'trial' end,
  'subscriptions', jsonb_build_object(
      'exists', exists (select 1 from sub),
      'tier_column', exists (select 1 from tier_col),
      'tier_default', (select default_expr from tier_col),
      'tier_checks', (select coalesce(jsonb_agg(jsonb_build_object(
                         'name', conname, 'accepts_trial', names_trial, 'definition', def) order by conname), '[]'::jsonb) from checks),
      'every_tier_check_accepts_trial', not exists (select 1 from checks where not names_trial)),
  'signup_triggers', (select coalesce(jsonb_agg(jsonb_build_object(
      'trigger', tgname,
      'enabled', tgenabled <> 'D',
      'function', fn,
      'function_md5', fn_md5,
      'function_is', case
          when not seeds then 'seeds no subscriptions row — not this file''s concern'
          else case fn_md5
          when '77d2a9f3edf4d14c61a831a5a9512921' then 'handle_new_user_v2 as supabase/schema_phase3.sql defines it (no tier)'
          when '78db9d7e67d269a7bfc25878cf431ade' then 'handle_new_user as supabase/schema.sql defines it (no tier)'
          when '1d672e28785a49a4a74c6401b037cde9' then 'handle_new_user_v2, patched by the migration (tier trial)'
          when 'ad15b1fdd3103d823fde52d0e42458ca' then 'handle_new_user, patched by the migration (tier trial)'
          else 'a body this repository does not define' end end,
      'security_definer', prosecdef,
      'owner', fn_owner,
      'seeds_a_subscriptions_row', seeds,
      'writes_tier_trial', writes_tier_trial,
      'seed_columns', btrim(regexp_replace(seed[1], '\s+', ' ', 'g')),
      'seed_values', btrim(regexp_replace(seed[2], '\s+', ' ', 'g'))) order by tgname), '[]'::jsonb) from trg),
  'functions_by_name', (select coalesce(jsonb_object_agg(p.oid::regprocedure::text, md5(p.prosrc)), '{}'::jsonb)
                          from pg_proc p
                         where p.oid in (to_regprocedure('public.handle_new_user()'),
                                         to_regprocedure('public.handle_new_user_v2()'))),
  'existing_rows', case
      when not exists (select 1 from tier_col)
           or (select count(*) from pg_attribute
                where attrelid = to_regclass('public.subscriptions') and not attisdropped
                  and attname in ('plan', 'status', 'stripe_subscription_id')) <> 3
        then null
      else ((xpath('/row/j/text()', query_to_xml($count$
              select coalesce(jsonb_agg(x order by x.n desc, x.plan, x.status), '[]'::jsonb)::text as j
                from (select (tier is null) as tier_is_null,
                             coalesce(tier, 'NULL') as tier,
                             plan, status,
                             (stripe_subscription_id is not null) as has_stripe_subscription,
                             count(*) as n
                        from public.subscriptions
                       group by 1, 2, 3, 4, 5) x
            $count$, false, true, '')))[1]::text)::jsonb
    end,
  'existing_rows_note', 'counts, never a user; the migration alters none of these rows (no backfill). Rows with tier NULL and plan professional are what the engine meters as Multi-Country today.'
) as report;
