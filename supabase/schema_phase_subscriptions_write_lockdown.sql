-- Entitlement tables are written by the service role only (owner task,
-- 2026-10-03: "Close self-service tier writes on subscriptions").
--
-- WHAT WAS OPEN
-- =============
-- supabase/schema.sql created three policies on public.subscriptions:
--   "subscriptions self select"  for select using      (auth.uid() = user_id)
--   "subscriptions self insert"  for insert with check (auth.uid() = user_id)
--   "subscriptions self update"  for update using      (auth.uid() = user_id)
-- and Supabase's default privileges grant ALL on every new public table to
-- `anon` and `authenticated`. No later file dropped the two write policies.
-- So a signed-in user could write their OWN row straight through the REST
-- API, with nothing but the public anon key and the session the page holds:
--
--   PATCH /rest/v1/subscriptions?user_id=eq.<own id>
--         {"tier": "multi", "status": "active"}                  -> 200, 1 row
--
-- — a paid plan with no payment. Measured on a local stack built from this
-- repository (docs/engine_book/gates.md, "subscriptions-write-lockdown"):
-- every sold tier, `status`, `plan`, `custom_limits`, `is_founding_member`,
-- `current_period_end`, `intro_unlock_expiry`, `extra_docs_billed_period`
-- (the billed-extras tally) and `stripe_customer_id` /
-- `stripe_subscription_id` (which POST /api/billing/portal and
-- /api/billing/cancel then hand to Stripe) were writable, and the row could
-- be INSERTed when none existed. The same write lands through the GraphQL
-- endpoint (/graphql/v1, pg_graphql — on by default on Supabase): it is the
-- privilege and the policy that were open, not one door. The engine
-- (src/engine/api/_plan_state.py get_plan_state), the SQL workspace cap
-- (create_workspace) and the chat edge function (supabase/functions/chat-llm)
-- all read the plan from that row.
--
-- This file does not depend on schema_phase_owner_plan.sql and is correct
-- with or without it. Without it (production on 2026-10-03) the tier CHECK
-- does not admit the internal `owner` tier at all; with it, a trigger refuses
-- `owner` from every writer but assign_internal_plan — and does nothing for
-- a SOLD tier. This file closes the sold tiers, and every other column.
--
-- No product code needs the write. Every legitimate writer is the SERVICE
-- ROLE or a SECURITY DEFINER function owned by the table owner: the Stripe
-- webhook and checkout (src/engine/api/_billing.py), the signup trigger, the
-- founding seat, every reserve / commit / release RPC. The browser's two
-- leftover writers — cancel() and reactivate() in frontend/lib/billing.ts —
-- had no caller and are deleted in the same change; Settings cancels through
-- POST /api/billing/cancel.
--
-- WHAT THIS FILE DOES
-- ===================
-- For every table on THE LIST below (the one list — the gate and the static
-- law read it from this file):
--   · row level security is ENABLED (a no-op where it already is);
--   · every policy whose command is not SELECT is DROPPED, whatever it is
--     called — a NOTICE names each one, so a policy somebody created by hand
--     in production is closed too, and you see that it was there;
--   · ALL privileges are revoked from `anon` and from PUBLIC;
--   · INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES and TRIGGER are revoked
--     from `authenticated` (table level, which takes the column level with it)
--     — and MAINTAIN on Postgres 17 and later, where the default grant
--     carries it (vacuum, analyze, reindex, lock table: not reachable through
--     the REST API; revoked so that SELECT is all that is left).
-- What a signed-in user KEEPS, per table:
--   · subscriptions — SELECT is granted, and the table is left with EXACTLY
--     ONE policy:  "subscriptions self select"  for select  to authenticated
--                  using (auth.uid() = user_id).
--     Every other policy on it is dropped, a second SELECT policy included (a
--     permissive `using (true)` would show every user's plan to every user).
--     frontend/lib/billing.ts fetchSubscription reads the row.
--   · user_usage, plan_chat_daily_usage — the SELECT privilege and the own-row
--     SELECT policy are left exactly as found. Nothing is granted here.
--   · the service-only tables — nothing: everything is revoked from
--     `authenticated` too.
-- `service_role` and the table owner are never touched.
-- NO VIEW IS CHANGED. A view over a listed table is not closed by a revoke
-- on the table; every such view an API role may use is NAMED (pre-flight (d)
-- below, and a NOTICE / WARNING when the file runs).
--
-- THE FILE CHECKS ITSELF. Before it ends it reads the result back from the
-- catalog and RAISES if a write privilege or a non-select policy survives on
-- a listed table (for example a grant made by a role other than the one
-- running this file: REVOKE removes only what the revoking role, or the
-- table's owner, granted). The file is one transaction in Studio: on that
-- error NOTHING is applied, and the message names the table, the role, the
-- privilege and who granted it.
--
-- SAFE ON EVERY STARTING STATE — each is a case of the gate, and each ends
-- in the same catalog:
--   (a) a database built from this repository (the two write policies
--       present, the default grants in place);
--   (b) a database where the three-statement STOPGAP was already run by hand
--       (the two write policies dropped; insert, update, delete, truncate,
--       references, trigger revoked from anon and authenticated).
--       THE STOPGAP MAY ALREADY BE IN PLACE IN PRODUCTION — THIS FILE IS SAFE
--       TO RUN ON TOP OF IT: nothing errors on a missing policy or an
--       already-revoked privilege, and it still does what the stopgap did
--       not — anon's remaining SELECT, the sibling tables, the sweep of
--       policies under other names;
--   (c) a database this file already ran on (idempotent: the second run
--       drops nothing);
--   (d) a database somebody re-opened by hand afterwards, under names this
--       file has never heard of: a `for all` policy to authenticated, a
--       permissive `using (true)` read, a column-level `grant update (tier)`,
--       row level security switched off on a meter, privileges handed back
--       to anon — every one is closed again, and the policies are named.
-- A listed table that does not exist is skipped with a NOTICE — except
-- public.subscriptions, whose absence means the wrong database and raises.
--
-- ORDER: none required against schema_phase_owner_plan.sql — before or after
-- it, the end state is the same (plan_assignment_audit is created, already
-- closed, by that file; where it does not exist yet it is skipped here). The
-- gate applies the two files in both orders.
-- On a FRESH environment run this file after every file that creates a
-- listed table (schema.sql, schema_phase5_usage_limits.sql,
-- schema_phase_pricing_v2.sql, schema_phase_billing_events.sql,
-- schema_phase_document_quota_ledger.sql): a `create table` hands the default
-- grants out again.
-- ⚠ RE-RUN THIS FILE AFTER supabase/schema.sql FROM AN OLD CHECKOUT: a
-- schema.sql from before 2026-10-03 re-creates the two write policies (the
-- current one drops them and never creates them —
-- tests/engine/test_entitlement_write_laws.py reds if any supabase/*.sql
-- creates a write policy or a write grant on a listed table). The same
-- discipline as schema_phase_security_hardening.sql after
-- schema_phase5_usage_limits.sql (CLAUDE.md §16).
--
-- Pairs with:
--   · scripts/check_subscriptions_write_lockdown.sh  (the gate: real PostgREST,
--                                                     a real GoTrue session)
--   · tests/engine/test_entitlement_write_laws.py    (no browser / edge-function
--                                                     writer; no SQL re-opens a table)
--   · frontend/lib/billing.ts                        (reads the row; writes nothing)
--
-- ── OPERATOR RUNBOOK (locked discipline — CLAUDE.md §14 / F3.24) ──────
-- 0. PRE-FLIGHT (read-only). Is the hole open in production? Four queries.
--
--    (a) the policies:
--      select tablename, policyname, cmd, roles, qual, with_check
--        from pg_policies
--       where schemaname = 'public'
--         and tablename in ('subscriptions', 'user_usage', 'plan_chat_daily_usage',
--                           'document_quota_ledger', 'founding_members',
--                           'billing_events', 'plan_assignment_audit')
--       order by tablename, cmd, policyname;
--
--    (b) who holds what (table level; `postgres`, `service_role` and
--        `supabase_admin` are expected and left out; on Postgres 17 and later
--        the default grant shows MAINTAIN too):
--      select c.relname as table_name,
--             coalesce(r.rolname, 'PUBLIC') as grantee,
--             string_agg(a.privilege_type, ', ' order by a.privilege_type) as privileges
--        from pg_class c
--        cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
--        left join pg_roles r on r.oid = a.grantee
--       where c.relnamespace = 'public'::regnamespace
--         and c.relname in ('subscriptions', 'user_usage', 'plan_chat_daily_usage',
--                           'document_quota_ledger', 'founding_members',
--                           'billing_events', 'plan_assignment_audit')
--         and coalesce(r.rolname, 'PUBLIC') not in ('postgres', 'service_role', 'supabase_admin')
--       group by 1, 2 order by 1, 2;
--
--    (c) row level security:
--      select relname, relrowsecurity
--        from pg_class
--       where relnamespace = 'public'::regnamespace
--         and relname in ('subscriptions', 'user_usage', 'plan_chat_daily_usage',
--                         'document_quota_ledger', 'founding_members',
--                         'billing_events', 'plan_assignment_audit')
--       order by 1;
--
--    READ IT: if (a) lists "subscriptions self insert" or "subscriptions self
--    update" (or ANY subscriptions policy whose cmd is INSERT / UPDATE /
--    DELETE / ALL) AND (b) shows `authenticated` holding INSERT or UPDATE on
--    subscriptions, THE HOLE IS OPEN IN PRODUCTION. If the two policies are
--    gone and (b) shows no write privilege on subscriptions, the stopgap is
--    already in place — this file is still to be run (it is safe on top of
--    it, and closes what the stopgap left). A table in (c) with
--    relrowsecurity = false and a write privilege in (b) is open to every
--    signed-in user, on every row. A table missing from (c) does not exist
--    (plan_assignment_audit before schema_phase_owner_plan.sql) — fine.
--
--    (d) the views over a listed table. A VIEW IS NOT CLOSED BY A REVOKE ON
--        ITS TABLE, AND THIS FILE CHANGES NO VIEW: a plain view runs with its
--        owner's rights, and Supabase's default privileges hand ALL on every
--        new public view to `anon` and `authenticated`.
--      select v.relname as view_name,
--             coalesce((select option_value from pg_options_to_table(v.reloptions)
--                        where option_name = 'security_invoker'), 'false') as security_invoker,
--             (pg_relation_is_updatable(v.oid, false) & 28) <> 0           as can_be_written_through,
--             string_agg(distinct t.relname, ', ')                         as reads,
--             coalesce((select string_agg(r || ':' || p, ' ' order by r, p)
--                         from unnest(array['anon', 'authenticated']) r,
--                              unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p
--                        where has_table_privilege(r, v.oid, p)), '-')    as api_privileges
--        from pg_rewrite w
--        join pg_class v on v.oid = w.ev_class and v.relkind in ('v', 'm')
--        join pg_depend d on d.classid = 'pg_rewrite'::regclass and d.objid = w.oid
--                        and d.refclassid = 'pg_class'::regclass
--        join pg_class t on t.oid = d.refobjid and t.relkind = 'r'
--                       and t.relnamespace = 'public'::regnamespace
--       where t.relname in ('subscriptions', 'user_usage', 'plan_chat_daily_usage',
--                           'document_quota_ledger', 'founding_members',
--                           'billing_events', 'plan_assignment_audit')
--       group by v.oid, v.relname, v.reloptions
--       order by 1;
--      READ IT, row by row:
--      · security_invoker false, can_be_written_through TRUE, and INSERT /
--        UPDATE / DELETE among api_privileges: THE VIEW IS A WRITE PATH AROUND
--        THIS FILE. Close it by hand, on the view:
--          revoke insert, update, delete, truncate on public.<view> from anon, authenticated;
--        (this file prints a WARNING naming it, and the local gate reds on it).
--      · security_invoker false with SELECT: the view shows what it selects
--        to whoever holds SELECT, whatever this file does to the table. Right
--        for an aggregate; a leak for a view that returns rows per user.
--      · security_invoker TRUE with SELECT for anon / authenticated: after
--        this file the view answers those roles only what the TABLE lets
--        them read — for `anon`, "permission denied".
--      The two views this repository creates (current_user_usage,
--      founding_member_count) are security_invoker and granted to neither
--      role (schema_phase_security_hardening.sql): expected here with
--      api_privileges `-`.
--      ⚠ `founder_cohort_public` — the pricing page reads it with the anon
--      key (frontend/lib/founder.ts) and POST /api/checkout/start reads it
--      with the service role — IS CREATED BY NO FILE IN THIS REPOSITORY: it
--      exists only where somebody made it by hand. If this query lists it,
--      read its row before step 1: with security_invoker false it is
--      untouched by this file; with security_invoker TRUE its anon read is
--      refused after this file and the Founding Member card falls back to
--      its built-in default (500 seats left) — checkout itself still reads
--      the true count. If it is not listed it reads no listed table.
--
-- 0b. AUDIT (read-only). Was the hole ever used? This lists subscription rows
--     whose entitlement has no payment visible behind it. IT IS A LIST FOR A
--     PERSON TO READ, NOT A VERDICT — see the false positives under it. No
--     email is selected; look a user up by id only if a row needs it. It
--     names no object of schema_phase_owner_plan.sql, so it runs before and
--     after that file.
--
--      select s.user_id, s.tier, s.plan, s.status,
--             (s.stripe_customer_id is not null)     as has_stripe_customer,
--             (s.stripe_subscription_id is not null) as has_stripe_subscription,
--             s.is_founding_member,
--             (s.custom_limits is not null)          as has_custom_limits,
--             s.intro_unlock_expiry, s.trial_end, s.current_period_end,
--             s.created_at, s.updated_at,
--             exists (select 1 from founding_members f
--                      where f.user_id = s.user_id)              as founding_seat_claimed,
--             exists (select 1 from billing_events b
--                      where b.payload::text like '%' || s.user_id::text || '%')
--                                                                as stripe_event_names_user,
--             array_remove(array[
--               case when s.tier is not null and lower(s.tier) <> 'trial'
--                         and s.stripe_subscription_id is null
--                         and not (lower(s.tier) = 'intro' and s.stripe_customer_id is not null)
--                    then 'tier set, no Stripe subscription' end,
--               case when s.status in ('active', 'founding_trial', 'past_due')
--                         and s.stripe_customer_id is null
--                    then 'status ' || s.status || ', no Stripe customer' end,
--               case when s.plan <> 'professional' and s.stripe_subscription_id is null
--                    then 'plan column is not the signup default' end,
--               case when s.is_founding_member
--                         and not exists (select 1 from founding_members f where f.user_id = s.user_id)
--                    then 'founding flag, no claimed seat' end,
--               case when s.custom_limits is not null then 'custom_limits set' end,
--               case when s.intro_unlock_expiry is not null and s.stripe_customer_id is null
--                    then 'intro unlock, no Stripe customer' end,
--               case when s.intro_unlock_expiry > s.updated_at + interval '8 days'
--                    then 'intro unlock longer than 7 days' end,
--               case when s.stripe_subscription_id is null
--                         and s.trial_end > s.created_at + interval '15 days'
--                    then 'trial longer than the signup trial' end,
--               case when s.current_period_end > now() + interval '400 days'
--                    then 'period end more than 400 days out' end,
--               case when s.stripe_customer_id is not null
--                         and s.stripe_customer_id !~ '^cus_[A-Za-z0-9]+$'
--                    then 'Stripe customer id of another shape' end,
--               case when s.stripe_subscription_id is not null
--                         and s.stripe_subscription_id !~ '^sub_[A-Za-z0-9]+$'
--                    then 'Stripe subscription id of another shape' end,
--               case when s.stripe_customer_id is not null and exists (
--                         select 1 from subscriptions o
--                          where o.stripe_customer_id = s.stripe_customer_id
--                            and o.user_id <> s.user_id)
--                    then 'Stripe customer id also on another user''s row' end,
--               case when s.stripe_subscription_id is not null and exists (
--                         select 1 from subscriptions o
--                          where o.stripe_subscription_id = s.stripe_subscription_id
--                            and o.user_id <> s.user_id)
--                    then 'Stripe subscription id also on another user''s row' end
--             ], null) as why_listed
--        from subscriptions s
--       where (s.tier is not null and lower(s.tier) <> 'trial' and s.stripe_subscription_id is null
--              and not (lower(s.tier) = 'intro' and s.stripe_customer_id is not null))
--          or (s.status in ('active', 'founding_trial', 'past_due') and s.stripe_customer_id is null)
--          or (s.plan <> 'professional' and s.stripe_subscription_id is null)
--          or (s.is_founding_member
--              and not exists (select 1 from founding_members f where f.user_id = s.user_id))
--          or s.custom_limits is not null
--          or (s.intro_unlock_expiry is not null and s.stripe_customer_id is null)
--          or s.intro_unlock_expiry > s.updated_at + interval '8 days'
--          or (s.stripe_subscription_id is null and s.trial_end > s.created_at + interval '15 days')
--          or s.current_period_end > now() + interval '400 days'
--          or (s.stripe_customer_id is not null and s.stripe_customer_id !~ '^cus_[A-Za-z0-9]+$')
--          or (s.stripe_subscription_id is not null and s.stripe_subscription_id !~ '^sub_[A-Za-z0-9]+$')
--          or (s.stripe_customer_id is not null and exists (
--                select 1 from subscriptions o
--                 where o.stripe_customer_id = s.stripe_customer_id and o.user_id <> s.user_id))
--          or (s.stripe_subscription_id is not null and exists (
--                select 1 from subscriptions o
--                 where o.stripe_subscription_id = s.stripe_subscription_id and o.user_id <> s.user_id))
--       order by s.updated_at desc;
--
--     FALSE POSITIVES — rows this lists that are legitimate:
--       · rows that existed when schema_phase5_usage_limits.sql ran: it
--         BACKFILLED tier from plan (`professional` -> `business`,
--         `starter` -> `solo`) on trial rows with no Stripe ids — recognisable
--         by a created_at before that migration and an updated_at AT it;
--       · an intro unlock whose Stripe session carried no customer (payment
--         mode): tier `intro`, status `active`, no Stripe ids —
--         `stripe_event_names_user` is true;
--       · a founding seat claimed through claim_founding_seat —
--         `founding_seat_claimed` is true;
--       · a paid row whose Stripe ids the backend CLEARED after a test / live
--         mode switch (/api/billing/portal and /cancel do that on "No such
--         customer") — `stripe_event_names_user` is true;
--       · rows the BROWSER itself wrote before 2026-09-08, when
--         frontend/lib/billing.ts still upserted status `active` with a 30- or
--         365-day period after signup — an entitlement with no payment handed
--         out by the product's own code (current_period_end ≈ updated_at + 30
--         or 365 days);
--       · a legacy (pre-tier) checkout that wrote the `plan` column;
--       · an account an operator comped by hand in Studio;
--       · where schema_phase_owner_plan.sql is applied (before it, `owner` is
--         not a tier the CHECK admits): an INTERNAL plan assigned through
--         assign_internal_plan — tier `owner`, status `active`, no Stripe
--         ids. Cross-check there, and only there (the table does not exist
--         before that file):
--           select user_id, from_tier, to_tier, reason, assigned_by, created_at
--             from plan_assignment_audit order by created_at;
--       · locally only: the test-mode seed user.
--     WHAT IT CANNOT SEE: a self-written row that was later written back or
--     that a later webhook overwrote; a PAYING user who raised their own tier
--     (the row has a Stripe subscription — reconcile `tier` per
--     `stripe_subscription_id` against Stripe by hand:
--       select tier, billing_cycle, status, count(*) from subscriptions
--        where stripe_subscription_id is not null group by 1, 2, 3 order by 4 desc;
--     the counts per tier must match Stripe's own subscriptions per price); a
--     zeroed `extra_docs_billed_period` (compare with the document quota
--     ledger if a row is in doubt); `cancel_at_period_end` flips; a forged
--     Stripe id of the right shape that no other row carries. `updated_at` is
--     set by a trigger on every update, so it is the time of the LAST write,
--     whoever made it; `stripe_event_names_user` only reaches back to the day
--     billing_events started recording.
--
-- 1. Run this SQL in Supabase Studio (includes the NOTIFY at the bottom). It
--    answers "Success" or one error; on the error nothing was applied. Each
--    dropped policy, each skipped table and each view over a listed table is
--    named in a NOTICE (a WARNING for a view that can be written through) —
--    psql prints them; Studio's editor may not (Logs -> Postgres has them).
--    Do not rely on seeing them: the proof is step 3.
-- 2. IMMEDIATELY click Supabase Dashboard -> Settings -> API ->
--    "Reload schema cache". The NOTIFY is optimistic on Supabase managed
--    infra; the Dashboard click is the deterministic step.
-- 3. POST-CHECKS.
--    (i)  Run the pre-flight queries again. Expected: (a) no policy
--         whose cmd is not SELECT, and subscriptions with exactly one policy,
--         "subscriptions self select", roles {authenticated}; (b) `anon` and
--         PUBLIC absent, `authenticated` holding SELECT only on subscriptions
--         (and on user_usage / plan_chat_daily_usage if it held it before),
--         nothing on the others; (c) relrowsecurity = true on every row;
--         (d) unchanged by this file — no row with can_be_written_through
--         true and a write privilege for anon / authenticated.
--    (ii) THE PROBE — signed in to the product, open the browser console on
--         any page of the app and paste the block below. It uses the session
--         the page already holds, reads your own row, then tries to write
--         `cancel_at_period_end` back to its CURRENT value (never a tier — a
--         no-op if it were to succeed). AFTER this file it must print
--         "CLOSED": the read answers 200 with one row and the write is refused
--         (403, "permission denied for table subscriptions"). Run it only
--         after step 1: before it, a success bumps `updated_at` on your own
--         row, which then shows in the audit's ordering.
--
--      (async () => {
--        const key = Object.keys(localStorage).find(k => /^sb-.+-auth-token$/.test(k));
--        const session = JSON.parse(localStorage.getItem(key));
--        const ref = key.replace(/^sb-/, '').replace(/-auth-token$/, '');
--        let apikey = null;   // the public anon key, read from the page's own scripts
--        for (const e of performance.getEntriesByType('resource').filter(e => /\.js(\?|$)/.test(e.name))) {
--          const text = await (await fetch(e.name)).text();
--          const pub = text.match(/sb_publishable_[A-Za-z0-9_-]+/);
--          if (pub) { apikey = pub[0]; break; }
--          for (const t of text.match(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g) || []) {
--            try {
--              const claims = JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
--              if (claims.role === 'anon') { apikey = t; break; }
--            } catch (_) {}
--          }
--          if (apikey) break;
--        }
--        if (!apikey) { console.log('PROBE INCONCLUSIVE — the anon key was not found in the page scripts; nothing was written. Set `apikey` by hand (Dashboard -> Settings -> API -> anon public).'); return; }
--        const url = `https://${ref}.supabase.co/rest/v1/subscriptions?user_id=eq.${session.user.id}`;
--        const headers = { apikey, Authorization: `Bearer ${session.access_token}`,
--                          'Content-Type': 'application/json', Prefer: 'return=representation' };
--        const read = await fetch(url + '&select=cancel_at_period_end', { headers });
--        const rows = await read.json();
--        console.log('read own row:', read.status, rows);
--        if (read.status !== 200 || !Array.isArray(rows) || rows.length !== 1) {
--          console.log('PROBE INCONCLUSIVE — the read did not return exactly one row; nothing was written.');
--          return;
--        }
--        const write = await fetch(url, { method: 'PATCH', headers,
--          body: JSON.stringify({ cancel_at_period_end: rows[0].cancel_at_period_end }) });
--        const body = await write.json().catch(() => null);
--        console.log('write own row:', write.status, body);
--        console.log(write.status === 401 || write.status === 403
--          ? 'CLOSED — a signed-in user cannot write the subscriptions row.'
--          : 'OPEN — the write was not refused. Do not ship; re-run the pre-flight.');
--      })();
--
--    (iii) Sign up a throw-away account: it must still get its subscriptions
--         row (the signup trigger is SECURITY DEFINER). Upload one document:
--         the quota must still count (the reserve / commit RPCs run as the
--         service role).
-- 4. WHAT CHANGES, AND FOR WHOM.
--    · The product: nothing. No browser code writes these tables (the law is
--      tests/engine/test_entitlement_write_laws.py); the backend writes with
--      the service role, which this file does not touch. This file is safe to
--      apply BEFORE or AFTER the frontend that deletes cancel() / reactivate().
--    · A signed-in user: reads their own subscriptions row as before; every
--      direct write answers 403. Anonymous: 401 on these tables (it was
--      200 with no rows).
--    · An operator in Studio: unaffected (the SQL editor is `postgres`).
--    · A RESTORE. A logical restore that re-creates the tables (pg_restore
--      without --no-privileges, or a dump taken BEFORE this file) brings the
--      old grants and policies back with it: RE-RUN THIS FILE after any
--      logical restore, after supabase/schema.sql from an old checkout, and in
--      every fresh environment. A physical restore (Supabase point-in-time
--      recovery) to a moment AFTER this file keeps it; to a moment before it,
--      re-run it. A NEW entitlement table gets Supabase's default grants on
--      the day it is created: add it to THE LIST below and re-run.
-- ─────────────────────────────────────────────────────────────────────

set search_path = public;

do $lockdown$
declare
  -- THE LIST. One name per line, quoted; the gate and the static law read
  -- the two blocks between the markers from this file. To add a table, add
  -- its line here and nowhere else (and name it in the pre-flight queries of
  -- the header — the static law reds when the two differ).
  --
  -- ENTITLEMENT-TABLES-USER-READABLE-BEGIN   (a signed-in user may READ their own row)
  v_user_readable text[] := array[
    'subscriptions',          -- the plan row: tier, status, limits, founding flag, periods, Stripe ids
    'user_usage',             -- the monthly meters: documents, non-RO documents, chat turns
    'plan_chat_daily_usage'   -- the daily Ask CFO AI counter
  ];
  -- ENTITLEMENT-TABLES-USER-READABLE-END
  -- ENTITLEMENT-TABLES-SERVICE-ONLY-BEGIN   (anon and authenticated hold nothing)
  v_service_only text[] := array[
    'document_quota_ledger',  -- one row per counted document; the reservation state
    'founding_members',       -- the founding seats
    'billing_events',         -- the Stripe webhook's idempotency log
    'plan_assignment_audit'   -- who was moved onto / off an internal plan
  ];
  -- ENTITLEMENT-TABLES-SERVICE-ONLY-END
  v_table text;
  v_rel   regclass;
  v_pol   record;
  v_view  record;
  v_role  text;
  v_priv  text;
  v_n     int;
  v_open  text := '';
  -- Postgres 17 added the MAINTAIN privilege; the keyword does not exist
  -- before it, so every statement that names it is behind this flag.
  v_pg17  boolean := current_setting('server_version_num')::int >= 170000;
begin
  -- ── 1. close ──────────────────────────────────────────────────────────
  foreach v_table in array v_user_readable || v_service_only loop
    v_rel := to_regclass(format('public.%I', v_table));
    if v_rel is null then
      if v_table = 'subscriptions' then
        raise exception 'write lockdown: public.subscriptions does not exist — this is not the product''s database; nothing was applied';
      end if;
      raise notice 'write lockdown: public.% does not exist here — skipped', v_table;
      continue;
    end if;

    execute format('alter table %s enable row level security', v_rel);

    -- Every policy that is not a SELECT policy goes, whatever its name. On
    -- subscriptions EVERY policy goes but the one it is to keep, when that
    -- one is already exactly what step 2 would create (so a second run of
    -- this file drops nothing and says nothing).
    for v_pol in
      select policyname, cmd from pg_policies
       where schemaname = 'public' and tablename = v_table
         and (cmd <> 'SELECT'
              or (v_table = 'subscriptions'
                  and not (policyname = 'subscriptions self select'
                           and permissive = 'PERMISSIVE'
                           and roles = array['authenticated']::name[]
                           and qual = '(auth.uid() = user_id)')))
       order by policyname
    loop
      execute format('drop policy %I on %s', v_pol.policyname, v_rel);
      raise notice 'write lockdown: dropped policy "%" (%) on public.%',
        v_pol.policyname, v_pol.cmd, v_table;
    end loop;

    execute format('revoke all on table %s from public, anon', v_rel);
    if v_table = any (v_user_readable) then
      -- SELECT is left as found (user_usage, plan_chat_daily_usage) …
      execute format(
        'revoke insert, update, delete, truncate, references, trigger on table %s from authenticated',
        v_rel);
      if v_pg17 then
        execute format('revoke maintain on table %s from authenticated', v_rel);
      end if;
    else
      execute format('revoke all on table %s from authenticated', v_rel);
    end if;
  end loop;
  -- … and granted on the one table the browser reads.
  grant select on table public.subscriptions to authenticated;

  -- ── 2. the ONE policy on subscriptions: a signed-in user reads their own row
  if not exists (select 1 from pg_policies
                  where schemaname = 'public' and tablename = 'subscriptions'
                    and policyname = 'subscriptions self select') then
    create policy "subscriptions self select" on public.subscriptions
      for select to authenticated
      using (auth.uid() = user_id);
  end if;

  -- ── 3. THE RESULT, READ BACK ──────────────────────────────────────────
  -- Raises — and so applies nothing — if a listed table is still writable
  -- by an API role, still carries a non-select policy, or has row level
  -- security off.
  foreach v_table in array v_user_readable || v_service_only loop
    v_rel := to_regclass(format('public.%I', v_table));
    continue when v_rel is null;

    if not (select relrowsecurity from pg_class where oid = v_rel) then
      v_open := v_open || format(E'\n  public.%s: row level security is OFF', v_table);
    end if;

    foreach v_role in array array['anon', 'authenticated'] loop
      foreach v_priv in array array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'SELECT'] loop
        continue when v_priv = 'SELECT' and v_role = 'authenticated' and v_table = any (v_user_readable);
        if (v_priv in ('INSERT', 'UPDATE', 'REFERENCES', 'SELECT')
              and has_any_column_privilege(v_role, v_rel, v_priv))
           or (v_priv in ('DELETE', 'TRUNCATE', 'TRIGGER')
              and has_table_privilege(v_role, v_rel, v_priv)) then
          v_open := v_open || format(E'\n  public.%s: %s still holds %s (granted by: %s)',
            v_table, v_role, v_priv,
            coalesce((select string_agg(distinct pg_get_userbyid(a.grantor), ', ')
                        from pg_class c, aclexplode(c.relacl) a
                       where c.oid = v_rel and a.privilege_type = v_priv
                         and a.grantee in (0, (select oid from pg_roles where rolname = v_role))),
                     'a column-level grant'));
        end if;
      end loop;
      if v_pg17 then
        if has_table_privilege(v_role, v_rel, 'MAINTAIN') then
          v_open := v_open || format(E'\n  public.%s: %s still holds MAINTAIN', v_table, v_role);
        end if;
      end if;
    end loop;

    select count(*) into v_n from pg_policies
     where schemaname = 'public' and tablename = v_table and cmd <> 'SELECT';
    if v_n > 0 then
      v_open := v_open || format(E'\n  public.%s: %s policy(ies) with a command other than SELECT', v_table, v_n);
    end if;
  end loop;

  select count(*) into v_n from pg_policies
   where schemaname = 'public' and tablename = 'subscriptions';
  if v_n <> 1 then
    v_open := v_open || format(E'\n  public.subscriptions: %s policies (exactly one is expected)', v_n);
  end if;

  if v_open <> '' then
    raise exception using
      errcode = '42501',
      message = 'write lockdown INCOMPLETE — nothing was applied:' || v_open,
      hint = 'A privilege granted by another role is revoked by that role (or by the table''s owner): '
             || 'run the revoke as the grantor named above, then run this file again.';
  end if;
  raise notice 'write lockdown: verified — every listed table is closed to anon and authenticated writes';

  -- ── 4. THE VIEWS — named, never changed ───────────────────────────────
  -- A view over a listed table is not closed by anything above (pre-flight
  -- (d) in the header). One an API role can WRITE THROUGH is the same hole
  -- by another door: a WARNING names it and the revoke that closes it. Any
  -- other view an API role may use is named in a NOTICE.
  for v_view in
    select v.relnamespace::regnamespace::text || '.' || quote_ident(v.relname) as view_name,
           coalesce((select option_value from pg_options_to_table(v.reloptions)
                      where option_name = 'security_invoker'), 'false') = 'true' as invoker,
           (pg_relation_is_updatable(v.oid, false) & 28) <> 0 as updatable,
           (select string_agg(r || ':' || p, ' ' order by r, p)
              from unnest(array['anon', 'authenticated']) r,
                   unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p
             where has_table_privilege(r, v.oid, p)) as api_privs,
           exists (select 1 from unnest(array['anon', 'authenticated']) r,
                                 unnest(array['INSERT', 'UPDATE', 'DELETE']) p
                    where has_table_privilege(r, v.oid, p)) as api_write
      from pg_class v
     where v.relkind in ('v', 'm')
       and exists (select 1
                     from pg_rewrite w
                     join pg_depend d on d.classid = 'pg_rewrite'::regclass and d.objid = w.oid
                                     and d.refclassid = 'pg_class'::regclass
                     join pg_class t on t.oid = d.refobjid
                    where w.ev_class = v.oid and t.relkind = 'r'
                      and t.relnamespace = 'public'::regnamespace
                      and t.relname = any (v_user_readable || v_service_only))
     order by 1
  loop
    continue when v_view.api_privs is null;
    if v_view.api_write and v_view.updatable and not v_view.invoker then
      raise warning 'write lockdown: view % reads a listed table, can be written through, and anon / authenticated hold [%] on it — THIS FILE DOES NOT CLOSE IT. Run: revoke insert, update, delete, truncate on % from anon, authenticated;',
        v_view.view_name, v_view.api_privs, v_view.view_name;
    else
      raise notice 'write lockdown: view % reads a listed table (security_invoker %, [%]) — left as found',
        v_view.view_name, v_view.invoker, v_view.api_privs;
    end if;
  end loop;
end
$lockdown$;

-- F3.24 schema-migration discipline: optimistic PostgREST reload. The
-- Dashboard "Reload schema cache" click (runbook step 2) is the deterministic one.
notify pgrst, 'reload schema';
