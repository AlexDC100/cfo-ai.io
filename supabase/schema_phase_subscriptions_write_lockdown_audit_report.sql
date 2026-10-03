-- THE AUDIT beside supabase/schema_phase_subscriptions_write_lockdown.sql —
-- READ-ONLY. ONE statement, ONE row, one jsonb column: `audit`.
--
-- Was the hole ever used? This lists the subscription rows whose entitlement
-- has no payment visible behind it. IT IS A LIST FOR A PERSON TO READ, NOT A
-- VERDICT: `audit.false_positives` names the legitimate rows it lists and
-- `audit.cannot_see` what it misses. It selects NO email and NO Stripe id
-- value — a user id, the plan columns, dates, and booleans. Look a user up by
-- id only if a row needs it.
--
--   audit.rows                           one object per listed row, with `why_listed`
--   audit.listed_count                   how many
--   audit.stripe_ids_in_no_billing_event rows whose stripe_subscription_id or
--                                        stripe_customer_id appears in NO recorded
--                                        Stripe event (billing_events.payload) —
--                                        what `rows` cannot see: a self-written
--                                        tier WITH forged ids of the right shape
--   audit.tier_by_stripe_subscription    tier × cycle × status counts of the rows
--                                        that carry a Stripe subscription: they
--                                        must match Stripe's own subscriptions per
--                                        price (this is what covers a PAYING user
--                                        who raised their own tier, and forged ids)
--   audit.rows_by_tier_plan_status       every row of the table, counted
--   audit.tables_present                 founding_members / billing_events: the
--                                        statement does not need either — where
--                                        one is absent its columns answer null and
--                                        its checks are skipped, and it says so
--
-- It runs before and after the migration, and before and after
-- schema_phase_owner_plan.sql (it names none of that file's objects). A single
-- WITH … SELECT: `supabase db query --linked -f <this file>`, Studio, psql.
-- The two optional tables are read through query_to_xml(), which runs its
-- query read-only; nothing else here can write.

with
present as (
  select to_regclass('public.founding_members') is not null as fm_present,
         (to_regclass('public.billing_events') is not null
          and exists (select 1 from pg_attribute a
                       where a.attrelid = to_regclass('public.billing_events')
                         and a.attname = 'payload' and not a.attisdropped)) as be_present
),
fm as (
  select x.user_id
    from present
    cross join lateral (
      select case when present.fm_present
                  then query_to_xml('select user_id::text as user_id from public.founding_members',
                                    false, false, '') end as doc) q
    cross join lateral xmltable('/table/row' passing q.doc columns user_id text path 'user_id') x
   where q.doc is not null
),
ev as (
  select x.user_id, x.names_user, x.sub_in_events, x.cus_in_events
    from present
    cross join lateral (
      select case when present.be_present
                  then query_to_xml($events$
                         with e as materialized (select payload::text as p from public.billing_events)
                         select s.user_id::text as user_id,
                                exists (select 1 from e where strpos(e.p, s.user_id::text) > 0) as names_user,
                                (s.stripe_subscription_id is not null and exists (
                                   select 1 from e where strpos(e.p, s.stripe_subscription_id) > 0)) as sub_in_events,
                                (s.stripe_customer_id is not null and exists (
                                   select 1 from e where strpos(e.p, s.stripe_customer_id) > 0)) as cus_in_events
                           from public.subscriptions s
                       $events$, false, false, '') end as doc) q
    cross join lateral xmltable('/table/row' passing q.doc
                                columns user_id text path 'user_id',
                                        names_user boolean path 'names_user',
                                        sub_in_events boolean path 'sub_in_events',
                                        cus_in_events boolean path 'cus_in_events') x
   where q.doc is not null
),
s as (
  select sub.user_id, sub.tier, sub.plan, sub.status, sub.billing_cycle,
         (sub.stripe_customer_id is not null)     as has_stripe_customer,
         (sub.stripe_subscription_id is not null) as has_stripe_subscription,
         sub.is_founding_member,
         (sub.custom_limits is not null)          as has_custom_limits,
         sub.intro_unlock_expiry, sub.trial_end, sub.current_period_end,
         sub.created_at, sub.updated_at,
         case when present.fm_present then (fm.user_id is not null) end as founding_seat_claimed,
         case when present.be_present then coalesce(ev.names_user, false) end as stripe_event_names_user,
         case when present.be_present and sub.stripe_subscription_id is not null
              then not coalesce(ev.sub_in_events, false) end as subscription_id_in_no_event,
         case when present.be_present and sub.stripe_customer_id is not null
              then not coalesce(ev.cus_in_events, false) end as customer_id_in_no_event,
         array_remove(array[
           case when sub.tier is not null and lower(sub.tier) <> 'trial'
                     and sub.stripe_subscription_id is null
                     and not (lower(sub.tier) = 'intro' and sub.stripe_customer_id is not null)
                then 'tier set, no Stripe subscription' end,
           case when sub.status in ('active', 'founding_trial', 'past_due')
                     and sub.stripe_customer_id is null
                then 'status ' || sub.status || ', no Stripe customer' end,
           case when sub.plan <> 'professional' and sub.stripe_subscription_id is null
                then 'plan column is not the signup default' end,
           case when sub.is_founding_member and present.fm_present and fm.user_id is null
                then 'founding flag, no claimed seat' end,
           case when sub.is_founding_member and not present.fm_present
                then 'founding flag (no founding_members table here to check the seat against)' end,
           case when sub.custom_limits is not null then 'custom_limits set' end,
           case when sub.intro_unlock_expiry is not null and sub.stripe_customer_id is null
                then 'intro unlock, no Stripe customer' end,
           case when sub.intro_unlock_expiry > sub.updated_at + interval '8 days'
                then 'intro unlock longer than 7 days' end,
           case when sub.stripe_subscription_id is null
                     and sub.trial_end > sub.created_at + interval '15 days'
                then 'trial longer than the signup trial' end,
           case when sub.current_period_end > now() + interval '400 days'
                then 'period end more than 400 days out' end,
           case when sub.stripe_customer_id is not null
                     and sub.stripe_customer_id !~ '^cus_[A-Za-z0-9]+$'
                then 'Stripe customer id of another shape' end,
           case when sub.stripe_subscription_id is not null
                     and sub.stripe_subscription_id !~ '^sub_[A-Za-z0-9]+$'
                then 'Stripe subscription id of another shape' end,
           case when sub.stripe_customer_id is not null and exists (
                     select 1 from public.subscriptions o
                      where o.stripe_customer_id = sub.stripe_customer_id and o.user_id <> sub.user_id)
                then 'Stripe customer id also on another user''s row' end,
           case when sub.stripe_subscription_id is not null and exists (
                     select 1 from public.subscriptions o
                      where o.stripe_subscription_id = sub.stripe_subscription_id and o.user_id <> sub.user_id)
                then 'Stripe subscription id also on another user''s row' end
         ], null) as why_listed
    from public.subscriptions sub
    cross join present
    left join fm on fm.user_id = sub.user_id::text
    left join ev on ev.user_id = sub.user_id::text
)
select jsonb_build_object(
  'what', 'entitlement audit — subscription rows with no payment visible behind them (read-only; a list, not a verdict)',
  'generated_at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  'database', current_database(),
  'tables_present', (select jsonb_build_object('founding_members', p.fm_present,
                                               'billing_events', p.be_present) from present p),
  'subscriptions_total', (select count(*) from s),
  'listed_count', (select count(*) from s where cardinality(s.why_listed) > 0),
  'rows',
    (select coalesce(jsonb_agg(jsonb_build_object(
              'user_id', s.user_id, 'tier', s.tier, 'plan', s.plan, 'status', s.status,
              'has_stripe_customer', s.has_stripe_customer,
              'has_stripe_subscription', s.has_stripe_subscription,
              'is_founding_member', s.is_founding_member,
              'has_custom_limits', s.has_custom_limits,
              'intro_unlock_expiry', s.intro_unlock_expiry, 'trial_end', s.trial_end,
              'current_period_end', s.current_period_end,
              'created_at', s.created_at, 'updated_at', s.updated_at,
              'founding_seat_claimed', s.founding_seat_claimed,
              'stripe_event_names_user', s.stripe_event_names_user,
              'why_listed', to_jsonb(s.why_listed)) order by s.updated_at desc), '[]'::jsonb)
       from s where cardinality(s.why_listed) > 0),
  'stripe_ids_in_no_billing_event_count',
    (select count(*) from s where s.subscription_id_in_no_event or s.customer_id_in_no_event),
  'stripe_ids_in_no_billing_event', jsonb_build_object(
    'checked', (select p.be_present from present p),
    'count', (select count(*) from s where s.subscription_id_in_no_event or s.customer_id_in_no_event),
    'rows',
      (select coalesce(jsonb_agg(jsonb_build_object(
                'user_id', s.user_id, 'tier', s.tier, 'plan', s.plan, 'status', s.status,
                'subscription_id_in_no_event', coalesce(s.subscription_id_in_no_event, false),
                'customer_id_in_no_event', coalesce(s.customer_id_in_no_event, false),
                'created_at', s.created_at, 'updated_at', s.updated_at) order by s.updated_at desc), '[]'::jsonb)
         from s where s.subscription_id_in_no_event or s.customer_id_in_no_event),
    'caveat', 'billing_events only reaches back to the day the webhook started recording events, and holds only the '
              || 'events the webhook received: an id from before that day, or from a Stripe mode whose events never '
              || 'reached this database, is listed although it is real. Where billing_events is absent this list is '
              || 'empty and `checked` is false.'),
  'tier_by_stripe_subscription',
    (select coalesce(jsonb_agg(jsonb_build_object('tier', g.tier, 'billing_cycle', g.billing_cycle,
                                                  'status', g.status, 'count', g.n)
                               order by g.n desc, g.tier), '[]'::jsonb)
       from (select s.tier, s.billing_cycle, s.status, count(*) as n
               from s where s.has_stripe_subscription group by 1, 2, 3) g),
  'rows_by_tier_plan_status',
    (select coalesce(jsonb_agg(jsonb_build_object('tier', g.tier, 'plan', g.plan, 'status', g.status, 'count', g.n)
                               order by g.n desc, g.tier, g.plan, g.status), '[]'::jsonb)
       from (select s.tier, s.plan, s.status, count(*) as n from s group by 1, 2, 3) g),
  'false_positives', jsonb_build_array(
    'every account that existed when supabase/schema_phase5_usage_limits.sql was applied, or re-applied: that file backfills tier from plan on EVERY row whose tier is NULL (professional -> business, starter -> solo, enterprise -> professional), paid or not — recognisable by an updated_at at that run',
    'an intro unlock whose Stripe session carried no customer (payment mode): tier intro, status active, no Stripe ids — stripe_event_names_user is true',
    'a founding seat claimed through claim_founding_seat — founding_seat_claimed is true',
    'a paid row whose Stripe ids the backend cleared after a test / live mode switch (/api/billing/portal and /cancel do that on "No such customer") — stripe_event_names_user is true',
    'rows the product''s own browser code wrote before 2026-09-08, when frontend/lib/billing.ts still upserted status active with a 30- or 365-day period after signup (current_period_end is about updated_at + 30 or 365 days)',
    'a legacy (pre-tier) checkout that wrote the plan column',
    'an account an operator comped by hand in Studio',
    'where schema_phase_owner_plan.sql is applied: an internal plan assigned through assign_internal_plan (tier owner, status active, no Stripe ids) — cross-check plan_assignment_audit',
    'on a local stack: the test-mode seed user'),
  'cannot_see', jsonb_build_array(
    'a self-written row that was later written back, or that a later webhook overwrote',
    'a PAYING user who raised their own tier: the row has a real Stripe subscription — reconcile tier_by_stripe_subscription against Stripe''s own subscriptions per price; the same reconciliation covers a forged id',
    'a self-written tier WITH forged Stripe ids of the right shape is not in `rows` — it is in stripe_ids_in_no_billing_event, within that list''s caveat',
    'a zeroed extra_docs_billed_period (compare with the document quota ledger if a row is in doubt); cancel_at_period_end flips',
    'updated_at is set by a trigger on every update: it is the time of the LAST write, whoever made it')
) as audit;
