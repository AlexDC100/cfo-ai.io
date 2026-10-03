-- THE PRE-FLIGHT AND THE AUDIT of supabase/schema_phase_subscriptions_write_lockdown.sql,
-- AS GRIDS FOR A PERSON — READ-ONLY. Every statement below is a SELECT; the
-- file is safe to paste whole and changes nothing.
--
-- An editor (Studio) shows the result of the LAST statement it ran: select
-- ONE block and run it (Cmd/Ctrl+Enter runs the selection), or run the whole
-- file with psql, which prints every grid. For one answer in one row use the
-- two report files instead:
--   …_preflight_report.sql   (one jsonb row, with a computed `verdict`)
--   …_audit_report.sql       (one jsonb row; does not need founding_members
--                             or billing_events to exist)
-- Run (a)–(e) before the migration and again after it (the post-check).
--
-- THE LIST in each block is the migration's (the static law reds when one
-- falls behind).

-- ── (a) THE POLICIES on the listed tables ─────────────────────────────
-- OPEN when subscriptions carries a policy whose cmd is INSERT, UPDATE,
-- DELETE or ALL — and (b) shows authenticated holding INSERT or UPDATE.
-- AFTER the migration: on subscriptions, user_usage and plan_chat_daily_usage
-- exactly ONE row each — "subscriptions self select", "users_see_own_usage",
-- "plan_chat_daily_usage_own_select": cmd SELECT, roles {authenticated}, an
-- own-row expression — and no row whose cmd is not SELECT anywhere.
select tablename, policyname, cmd, permissive, roles, qual, with_check
  from pg_policies
 where schemaname = 'public'
   and tablename in ('subscriptions', 'user_usage', 'plan_chat_daily_usage',
                     'document_quota_ledger', 'founding_members', 'billing_events',
                     'renewal_email_queue', 'plan_assignment_audit')
 order by tablename, cmd, policyname;

-- ── (b) WHO HOLDS WHAT — the table ACL and the column ACLs ────────────
-- Rows for anon, authenticated and PUBLIC only (`postgres`, `service_role`
-- and `supabase_admin` are expected and left out). `granted_by` matters: the
-- migration can revoke what the table's owner granted; a grant made by
-- another role is named in its error, with the statement that removes it.
-- On Postgres 17 and later the default grant shows MAINTAIN too.
-- AFTER the migration: anon and PUBLIC absent; authenticated with SELECT on
-- subscriptions (and on the two meters if it held it before); no column row.
select c.relname as table_name, 'table' as level, null::name as column_name,
       case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee)::text end as grantee,
       string_agg(a.privilege_type, ', ' order by a.privilege_type) as privileges,
       pg_get_userbyid(a.grantor) as granted_by
  from pg_class c
 cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
 where c.relnamespace = 'public'::regnamespace
   and c.relname in ('subscriptions', 'user_usage', 'plan_chat_daily_usage',
                     'document_quota_ledger', 'founding_members', 'billing_events',
                     'renewal_email_queue', 'plan_assignment_audit')
   and (a.grantee = 0 or pg_get_userbyid(a.grantee) in ('anon', 'authenticated'))
 group by c.relname, a.grantee, a.grantor
union all
select c.relname, 'column', att.attname,
       case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee)::text end,
       string_agg(a.privilege_type, ', ' order by a.privilege_type),
       pg_get_userbyid(a.grantor)
  from pg_class c
  join pg_attribute att on att.attrelid = c.oid and att.attnum > 0 and not att.attisdropped
 cross join lateral aclexplode(att.attacl) a
 where c.relnamespace = 'public'::regnamespace
   and c.relname in ('subscriptions', 'user_usage', 'plan_chat_daily_usage',
                     'document_quota_ledger', 'founding_members', 'billing_events',
                     'renewal_email_queue', 'plan_assignment_audit')
   and (a.grantee = 0 or pg_get_userbyid(a.grantee) in ('anon', 'authenticated'))
 group by c.relname, att.attname, a.grantee, a.grantor
 order by 1, 2 desc, 3, 4;

-- ── (c) ROW LEVEL SECURITY, AND WHO OWNS THE TABLE ────────────────────
-- A table missing from this grid does not exist here (plan_assignment_audit
-- before schema_phase_owner_plan.sql) — fine. relrowsecurity false with a
-- write privilege in (b) is open to every signed-in user, on every row.
-- `you_can_act_as_owner` must be true on every row: only a table's owner can
-- change its policies and grants. Where it is false the migration stops
-- before changing anything, names the table and its owner, and gives the
-- statement that hands it over (Postgres itself would answer a bare
-- "must be owner of table …").
select c.relname as table_name, c.relrowsecurity, c.relforcerowsecurity,
       pg_get_userbyid(c.relowner) as owner,
       pg_has_role(current_user, c.relowner, 'USAGE') as you_can_act_as_owner
  from pg_class c
 where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
   and c.relname in ('subscriptions', 'user_usage', 'plan_chat_daily_usage',
                     'document_quota_ledger', 'founding_members', 'billing_events',
                     'renewal_email_queue', 'plan_assignment_audit')
 order by 1;

-- ── (d) THE VIEWS over a listed table — directly, or through another view ──
-- A VIEW IS NOT CLOSED BY A REVOKE ON ITS TABLE, AND THE MIGRATION CHANGES NO
-- VIEW: a plain view runs with its owner's rights, and Supabase's default
-- privileges hand ALL on every new public view to anon and authenticated.
-- `depth` 1 reads a listed table; 2 and more read it through another view.
--  · security_invoker false, can_be_written_through TRUE, and INSERT / UPDATE
--    / DELETE among api_privileges: A WRITE PATH AROUND THE MIGRATION. Close
--    it by hand, on the view:
--      revoke insert, update, delete, truncate on public.<view> from anon, authenticated;
--  · security_invoker false with SELECT: the view shows what it selects to
--    whoever holds SELECT. Right for an aggregate; a leak for rows per user.
--  · security_invoker TRUE with SELECT for anon / authenticated: after the
--    migration the view answers them only what the TABLE lets them read.
-- The two views this repository creates (current_user_usage,
-- founding_member_count) are security_invoker with api_privileges `-`.
-- ⚠ `founder_cohort_public` (the pricing page reads it with the anon key) is
-- created by NO file in this repository. If it is not in this grid it reads
-- no listed table, neither directly nor through another view.
with recursive listed as (
  select c.oid from pg_class c
   where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
     and c.relname in ('subscriptions', 'user_usage', 'plan_chat_daily_usage',
                       'document_quota_ledger', 'founding_members', 'billing_events',
                       'renewal_email_queue', 'plan_assignment_audit')
), walk (view_oid, depth) as (
  select w.ev_class, 1
    from pg_rewrite w
    join pg_depend d on d.classid = 'pg_rewrite'::regclass and d.objid = w.oid
                    and d.refclassid = 'pg_class'::regclass
    join listed t on t.oid = d.refobjid
   where w.ev_class <> d.refobjid
  union
  select w.ev_class, walk.depth + 1
    from walk
    join pg_depend d on d.refclassid = 'pg_class'::regclass and d.refobjid = walk.view_oid
                    and d.classid = 'pg_rewrite'::regclass
    join pg_rewrite w on w.oid = d.objid
   where w.ev_class <> walk.view_oid and walk.depth < 10
)
select v.relnamespace::regnamespace::text || '.' || v.relname as view_name,
       min(walk.depth) as depth,
       coalesce((select o.option_value from pg_options_to_table(v.reloptions) o
                  where o.option_name = 'security_invoker'), 'false') as security_invoker,
       (pg_relation_is_updatable(v.oid, false) & 28) <> 0 as can_be_written_through,
       coalesce((select string_agg(r || ':' || p, ' ' order by r, p)
                   from unnest(array['anon', 'authenticated']) r,
                        unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p
                  where has_table_privilege(r, v.oid, p)), '-') as api_privileges
  from walk
  join pg_class v on v.oid = walk.view_oid and v.relkind in ('v', 'm')
 group by v.oid, v.relnamespace, v.relname, v.reloptions
 order by 1;

-- ── (d2) ANY view in public an API role holds a WRITE privilege on ────
-- Whatever it reads. Expected: no row.
select v.relname as view_name,
       (pg_relation_is_updatable(v.oid, false) & 28) <> 0 as can_be_written_through,
       (select string_agg(r || ':' || p, ' ' order by r, p)
          from unnest(array['anon', 'authenticated']) r,
               unnest(array['INSERT', 'UPDATE', 'DELETE']) p
         where has_table_privilege(r, v.oid, p)) as api_write_privileges
  from pg_class v
 where v.relnamespace = 'public'::regnamespace and v.relkind in ('v', 'm')
   and exists (select 1 from unnest(array['anon', 'authenticated']) r,
                             unnest(array['INSERT', 'UPDATE', 'DELETE']) p
                where has_table_privilege(r, v.oid, p))
 order by 1;

-- ── (e) THE FUNCTIONS whose body names a listed table ─────────────────
-- Listed: every such function that is NOT security definer, or that anon or
-- authenticated may execute.
--  · security_definer false: it writes as its caller, and is REFUSED after
--    the migration when the caller is a signed-in user — check that nothing
--    the product needs is on this list in that form.
--  · security_definer true and an API role may execute it: it writes past
--    the migration. On a database built from this repository the list is
--    create_workspace (reads the plan) and delete_my_account (deletes the
--    caller's own rows). Anything else here was made by hand: read its body.
select p.oid::regprocedure as function, p.prosecdef as security_definer,
       has_function_privilege('anon', p.oid, 'EXECUTE') as anon_may_execute,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_may_execute
  from pg_proc p
 where p.pronamespace = 'public'::regnamespace
   and p.prosrc ~* '\m(subscriptions|user_usage|plan_chat_daily_usage|document_quota_ledger|founding_members|billing_events|renewal_email_queue|plan_assignment_audit)\M'
   and (not p.prosecdef
        or has_function_privilege('anon', p.oid, 'EXECUTE')
        or has_function_privilege('authenticated', p.oid, 'EXECUTE'))
 order by 1;

-- ── THE AUDIT, 1 — rows whose entitlement has no payment visible behind it ──
-- A LIST FOR A PERSON TO READ, NOT A VERDICT. No email, no Stripe id.
-- WHERE founding_members DOES NOT EXIST: delete the line marked [FM-1], the
-- three lines marked [FM-2] and the two lines marked [FM-3].
-- WHERE billing_events DOES NOT EXIST: delete the three lines marked [BE-1].
-- (…_audit_report.sql needs neither table and needs no editing.)
-- FALSE POSITIVES — legitimate rows this lists:
--  · every account that existed when schema_phase5_usage_limits.sql was
--    applied, or re-applied: it backfills tier from plan on EVERY row whose
--    tier is NULL (professional -> business, starter -> solo, enterprise ->
--    professional), paid or not — updated_at is at that run;
--  · an intro unlock whose Stripe session carried no customer —
--    stripe_event_names_user is true;
--  · a founding seat claimed through claim_founding_seat —
--    founding_seat_claimed is true;
--  · a paid row whose Stripe ids the backend cleared after a test / live mode
--    switch — stripe_event_names_user is true;
--  · rows the product's own browser code wrote before 2026-09-08 (status
--    active, current_period_end about updated_at + 30 or 365 days);
--  · a legacy checkout that wrote the plan column; an operator's manual comp;
--  · with schema_phase_owner_plan.sql: an internal plan (tier owner) — see
--    plan_assignment_audit;
--  · locally: the test-mode seed user.
-- IT CANNOT SEE: a row written back or overwritten by a later webhook; a
-- PAYING user who raised their own tier (audit 3 below); a self-written tier
-- WITH forged Stripe ids of the right shape (audit 2 below); a zeroed
-- extra_docs_billed_period; cancel_at_period_end flips. updated_at is the
-- time of the LAST write, whoever made it.
select s.user_id, s.tier, s.plan, s.status,
       (s.stripe_customer_id is not null)     as has_stripe_customer,
       (s.stripe_subscription_id is not null) as has_stripe_subscription,
       s.is_founding_member,
       (s.custom_limits is not null)          as has_custom_limits,
       s.intro_unlock_expiry, s.trial_end, s.current_period_end,
       s.created_at, s.updated_at,
       exists (select 1 from public.founding_members f where f.user_id = s.user_id) as founding_seat_claimed,  -- [FM-1]
       exists (select 1 from public.billing_events b                                       -- [BE-1]
                where strpos(b.payload::text, s.user_id::text) > 0)                        -- [BE-1]
                                                          as stripe_event_names_user,      -- [BE-1]
       array_remove(array[
         case when s.tier is not null and lower(s.tier) <> 'trial'
                   and s.stripe_subscription_id is null
                   and not (lower(s.tier) = 'intro' and s.stripe_customer_id is not null)
              then 'tier set, no Stripe subscription' end,
         case when s.status in ('active', 'founding_trial', 'past_due')
                   and s.stripe_customer_id is null
              then 'status ' || s.status || ', no Stripe customer' end,
         case when s.plan <> 'professional' and s.stripe_subscription_id is null
              then 'plan column is not the signup default' end,
         case when s.is_founding_member                                                      -- [FM-2]
                   and not exists (select 1 from public.founding_members f where f.user_id = s.user_id)  -- [FM-2]
              then 'founding flag, no claimed seat' end,                                     -- [FM-2]
         case when s.custom_limits is not null then 'custom_limits set' end,
         case when s.intro_unlock_expiry is not null and s.stripe_customer_id is null
              then 'intro unlock, no Stripe customer' end,
         case when s.intro_unlock_expiry > s.updated_at + interval '8 days'
              then 'intro unlock longer than 7 days' end,
         case when s.stripe_subscription_id is null
                   and s.trial_end > s.created_at + interval '15 days'
              then 'trial longer than the signup trial' end,
         case when s.current_period_end > now() + interval '400 days'
              then 'period end more than 400 days out' end,
         case when s.stripe_customer_id is not null
                   and s.stripe_customer_id !~ '^cus_[A-Za-z0-9]+$'
              then 'Stripe customer id of another shape' end,
         case when s.stripe_subscription_id is not null
                   and s.stripe_subscription_id !~ '^sub_[A-Za-z0-9]+$'
              then 'Stripe subscription id of another shape' end,
         case when s.stripe_customer_id is not null and exists (
                   select 1 from public.subscriptions o
                    where o.stripe_customer_id = s.stripe_customer_id and o.user_id <> s.user_id)
              then 'Stripe customer id also on another user''s row' end,
         case when s.stripe_subscription_id is not null and exists (
                   select 1 from public.subscriptions o
                    where o.stripe_subscription_id = s.stripe_subscription_id and o.user_id <> s.user_id)
              then 'Stripe subscription id also on another user''s row' end
       ], null) as why_listed
  from public.subscriptions s
 where (s.tier is not null and lower(s.tier) <> 'trial' and s.stripe_subscription_id is null
        and not (lower(s.tier) = 'intro' and s.stripe_customer_id is not null))
    or (s.status in ('active', 'founding_trial', 'past_due') and s.stripe_customer_id is null)
    or (s.plan <> 'professional' and s.stripe_subscription_id is null)
    or (s.is_founding_member                                                                 -- [FM-3]
        and not exists (select 1 from public.founding_members f where f.user_id = s.user_id))  -- [FM-3]
    or s.custom_limits is not null
    or (s.intro_unlock_expiry is not null and s.stripe_customer_id is null)
    or s.intro_unlock_expiry > s.updated_at + interval '8 days'
    or (s.stripe_subscription_id is null and s.trial_end > s.created_at + interval '15 days')
    or s.current_period_end > now() + interval '400 days'
    or (s.stripe_customer_id is not null and s.stripe_customer_id !~ '^cus_[A-Za-z0-9]+$')
    or (s.stripe_subscription_id is not null and s.stripe_subscription_id !~ '^sub_[A-Za-z0-9]+$')
    or (s.stripe_customer_id is not null and exists (
          select 1 from public.subscriptions o
           where o.stripe_customer_id = s.stripe_customer_id and o.user_id <> s.user_id))
    or (s.stripe_subscription_id is not null and exists (
          select 1 from public.subscriptions o
           where o.stripe_subscription_id = s.stripe_subscription_id and o.user_id <> s.user_id))
 order by s.updated_at desc;

-- ── THE AUDIT, 2 — a Stripe id that appears in NO recorded Stripe event ──
-- What audit 1 cannot see: a self-written tier WITH forged ids of the right
-- shape. The webhook stores each Stripe event whole in billing_events.payload,
-- so a real subscription or customer id appears there.
-- CAVEAT: billing_events only reaches back to the day the webhook started
-- recording, and holds only the events it received — an id from before that
-- day is listed although it is real. Needs billing_events (use
-- …_audit_report.sql where it is absent).
select s.user_id, s.tier, s.plan, s.status,
       (s.stripe_subscription_id is not null and not exists (
          select 1 from public.billing_events b
           where strpos(b.payload::text, s.stripe_subscription_id) > 0)) as subscription_id_in_no_event,
       (s.stripe_customer_id is not null and not exists (
          select 1 from public.billing_events b
           where strpos(b.payload::text, s.stripe_customer_id) > 0))     as customer_id_in_no_event,
       s.created_at, s.updated_at
  from public.subscriptions s
 where (s.stripe_subscription_id is not null and not exists (
          select 1 from public.billing_events b
           where strpos(b.payload::text, s.stripe_subscription_id) > 0))
    or (s.stripe_customer_id is not null and not exists (
          select 1 from public.billing_events b
           where strpos(b.payload::text, s.stripe_customer_id) > 0))
 order by s.updated_at desc;

-- ── THE AUDIT, 3 — tier by Stripe subscription, to reconcile against Stripe ──
-- The counts per tier and cycle must match Stripe's own subscriptions per
-- price. This is what covers a PAYING user who raised their own tier — and a
-- forged id: a row counted here that Stripe does not know is one too many.
select s.tier, s.billing_cycle, s.status, count(*)
  from public.subscriptions s
 where s.stripe_subscription_id is not null
 group by 1, 2, 3
 order by 4 desc, 1;

-- ── EVERY ROW, COUNTED — tier × plan × status ─────────────────────────
-- The engine reads `tier`, else `plan`: a row with tier NULL and plan
-- 'professional' (what the signup trigger of this repository seeds) is read
-- by the engine as the Multi allowance. This grid says how many there are.
select coalesce(s.tier, 'NULL') as tier, s.plan, s.status, count(*)
  from public.subscriptions s
 group by 1, 2, 3
 order by 4 desc, 1, 2, 3;
