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
-- every column of the row was writable, and the row could be INSERTed when
-- none existed. The same write lands through the GraphQL endpoint
-- (/graphql/v1, pg_graphql — on by default on Supabase): it is the privilege
-- and the policy that were open, not one door. The engine
-- (src/engine/api/_plan_state.py get_plan_state), the SQL workspace cap
-- (create_workspace) and the chat edge function (supabase/functions/chat-llm)
-- all read the plan from that row.
--
-- This file does not depend on schema_phase_owner_plan.sql and is correct
-- with or without it.
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
-- For every table on THE LIST below (the one list — the gate, the static law
-- and the three read-only files beside this one are held to it):
--   · row level security is switched ON where it is off (nothing is touched
--     where it is already on);
--   · every policy whose command is not SELECT is DROPPED, whatever it is
--     called — so a policy somebody created by hand in production is closed
--     too, and the result row names it;
--   · ALL privileges are revoked from `anon` and from PUBLIC;
--   · INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES and TRIGGER are revoked
--     from `authenticated` (table level, which takes the column level with
--     it) — and MAINTAIN on Postgres 17 and later, where the default grant
--     carries it.
-- What a signed-in user KEEPS:
--   · subscriptions, user_usage, plan_chat_daily_usage — each is left with
--     EXACTLY ONE policy: its own row, SELECT, to authenticated, under the
--     name and the expression this repository's own files give it
--       "subscriptions self select"         using (auth.uid() = user_id)
--       "users_see_own_usage"               using (auth.uid() = user_id)
--       "plan_chat_daily_usage_own_select"  using (user_id = auth.uid())
--     Every other policy on these three is dropped, a second SELECT policy
--     included (a permissive `using (true)` shows every user's plan, or every
--     user's usage, to every user). SELECT is granted on subscriptions
--     (frontend/lib/billing.ts reads the row); on the two meters the SELECT
--     privilege is left as found.
--   · the service-only tables — nothing.
-- `service_role` and the table owner are never touched.
-- NO ROW IS CHANGED. This file holds no INSERT, UPDATE, DELETE or TRUNCATE
-- and changes no table's columns: it removes and restricts access, nothing
-- else (the static law reds on a statement that would; the gate fingerprints
-- every row of every listed table around each run). In production the audit
-- report's `row_fingerprints`, read before and after, is the same proof.
-- NO VIEW IS CHANGED. A view over a listed table is not closed by a revoke
-- on the table; every such view an API role may use — directly or through
-- another view — is NAMED in the result row (and in a WARNING when it can be
-- written through).
--
-- ONE BATCH, ONE TRANSACTION, ONE RESULT ROW. The file holds no psql
-- meta-command and relies on no NOTICE. Sent whole — Studio's editor, the
-- Management API (`supabase db query --linked -f`), or `psql -1 -f` — it runs
-- as one transaction: on ANY error nothing is applied. Its LAST statement
-- returns one row, one jsonb column `applied`: what each table held before
-- and after, every policy dropped or created, every table skipped, every
-- view named, `changed_anything`, and `verified`. (`applied.applied` null
-- with a `note` means the client did not run the file as one batch on one
-- connection: the row cannot see the result — run the pre-flight report.)
-- A client that sends ONE PREPARED STATEMENT at a time (`supabase db query
-- --local` does) refuses a file of several statements — "cannot insert
-- multiple commands into a prepared statement" — and applies nothing. The
-- fallback there: send the `do $lockdown$ … $lockdown$;` block alone. It is
-- the whole migration in one statement (still one transaction, still
-- self-checking); what it does not give is the `applied` row — read the
-- post-check report instead:
--   supabase db query --linked "$(awk '/^do \$lockdown\$/,/^\$lockdown\$;/' <this file>)"
--
-- IT WAITS FOR NO ONE. lock_timeout is 5 s for this transaction. Dropping or
-- creating a policy and switching row level security on need a brief
-- exclusive lock on that table; a second run, which changes nothing, takes
-- none. If the lock is not free within 5 s the file answers
--     canceling statement due to lock timeout
-- NOTHING WAS APPLIED — run it again.
--
-- THE FILE CHECKS ITSELF, and says what to do:
--   · a listed table owned by another role than the one running the file
--     (Postgres would answer a bare "must be owner of table …"): the file
--     stops before changing anything and names the table, its owner and the
--     statement that hands it over;
--   · a write privilege or a non-select policy that survives (REVOKE removes
--     only what the revoking role, or the table's owner, granted): the file
--     raises "write lockdown INCOMPLETE — nothing was applied", and each line
--     ends with the statement that removes that grant — a grant made by
--     another role, a column-level grant made by another role, and a
--     privilege inherited through a role membership are three different
--     statements. A plain `revoke … from authenticated` by the owner answers
--     REVOKE and removes nothing in all three cases.
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
--       not — anon's remaining SELECT, MAINTAIN, the sibling tables, the
--       sweep of policies under other names;
--   (c) a database this file already ran on (idempotent: the second run
--       drops nothing, locks nothing, and says `changed_anything: false`);
--   (d) a database somebody re-opened by hand afterwards, under names this
--       file has never heard of: a `for all` policy to authenticated, a
--       permissive `using (true)` read, a column-level `grant update (tier)`,
--       row level security switched off on a meter, privileges handed back
--       to anon — every one is closed again, and the policies are named.
-- A listed table that does not exist is skipped and named in the result row
-- — except public.subscriptions, whose absence means the wrong database and
-- raises.
--
-- ORDER: none required against schema_phase_owner_plan.sql (the gate applies
-- the two files in both orders). On a FRESH environment run this file after
-- every file that creates a listed table: a `create table` hands the default
-- grants out again.
-- ⚠ RE-RUN THIS FILE AFTER supabase/schema.sql FROM A CHECKOUT OLDER THAN
-- 2026-10-03, after any logical restore, and in every fresh environment: the
-- old schema.sql re-creates the two write policies
-- (tests/engine/test_entitlement_write_laws.py reds if any supabase/*.sql
-- re-opens a listed table). The same discipline as
-- schema_phase_security_hardening.sql after schema_phase5_usage_limits.sql
-- (CLAUDE.md §16).
--
-- THE FILES BESIDE THIS ONE (all read-only but this one):
--   · schema_phase_subscriptions_write_lockdown_preflight_report.sql
--       ONE statement, ONE row, one jsonb column `report`: every pre-flight
--       section and a `verdict` — hole_open / stopgap_in_place / fully_locked.
--       The same file after the migration is the POST-CHECK.
--   · schema_phase_subscriptions_write_lockdown_audit_report.sql
--       ONE statement, ONE row, one jsonb column `audit`: the rows whose
--       entitlement has no payment visible behind it. A list for a person,
--       not a verdict. No email, no Stripe id. And `row_fingerprints`: for
--       each listed table the number of rows and one md5 over every row —
--       the same string before and after this file = no row changed.
--   · schema_phase_subscriptions_write_lockdown_preflight.sql
--       the same questions as grids, one SELECT each, for a person in Studio
--       or psql (run one block at a time: an editor shows the last result).
--   · schema_phase_subscriptions_write_lockdown_probe.js
--       the browser-console probe (signed in; writes one harmless field back
--       to its current value; must print CLOSED).
--   · scripts/check_subscriptions_write_lockdown.sh   (the gate, local stack)
--   · tests/engine/test_entitlement_write_laws.py     (the static laws)
--
-- ── OPERATOR RUNBOOK (locked discipline — CLAUDE.md §14 / F3.24) ──────
-- In this order. Steps 0, 0b and 3 change nothing.
--
-- 0. PRE-FLIGHT. Run …_preflight_report.sql. Read `report.verdict`:
--      state = "hole_open"         a write policy AND a write privilege for an
--                                  API role on subscriptions: THE HOLE IS OPEN
--                                  IN THIS DATABASE. Run step 0b, then step 1.
--      state = "stopgap_in_place"  the plan row is closed, the rest is not:
--                                  this file is still to be run.
--      state = "fully_locked"      this file's end state. Nothing to do.
--      state = "neither"           read `verdict.why_not_fully_locked`.
--    Before step 1 also read, in the same row:
--      · `verdict.tables_not_owned_by_runner` — must be empty, or step 1
--        stops with "is owned by …" and applies nothing;
--      · `verdict.policies_this_file_will_drop` — every policy on a listed
--        table that is not one of the three it keeps. A hand-made SELECT
--        policy on subscriptions or on a meter is on that list;
--      · `verdict.views_that_can_be_written_through` — each is a write path
--        this file does NOT close: revoke on the VIEW by hand
--        (`revoke insert, update, delete, truncate on public.<view> from
--        anon, authenticated;`);
--      · `views` — a view with security_invoker TRUE that anon or
--        authenticated may SELECT answers them, after this file, only what
--        the TABLE lets them read (for anon: "permission denied").
--        ⚠ `founder_cohort_public` — the pricing page reads it with the anon
--        key (frontend/lib/founder.ts) — IS CREATED BY NO FILE IN THIS
--        REPOSITORY. If it is in `views` with security_invoker false it is
--        untouched; with security_invoker TRUE its anon read is refused
--        after this file and the Founding Member card shows its built-in
--        default. If it is not in `views`, it reads no listed table — neither
--        directly nor through another view;
--      · `functions` — a function that is not SECURITY DEFINER and writes a
--        listed table runs as the caller and is REFUSED after this file; a
--        SECURITY DEFINER one that anon or authenticated may execute writes
--        past it. On a database built from this repository the list is
--        create_workspace and delete_my_account (both read or delete only
--        the caller's own).
--
-- 0b. AUDIT. Run …_audit_report.sql. `audit.rows` lists the subscription
--     rows whose entitlement has no payment visible behind it, each with
--     `why_listed`; `audit.stripe_ids_in_no_billing_event` lists the rows
--     whose Stripe id appears in no recorded Stripe event — the shape the
--     first list cannot see (a self-written tier WITH forged ids of the
--     right shape). IT IS A LIST FOR A PERSON TO READ, NOT A VERDICT: the
--     file's own `false_positives` and `cannot_see` say why.
--     KEEP `audit.row_fingerprints` — post-check (v) compares it.
--
-- 1. RUN THIS FILE, whole. Read the one row it returns:
--      `applied.verified` — the sentence; `applied.changed_anything`;
--      `applied.policies_dropped`, `applied.policies_created`,
--      `applied.row_level_security_switched_on`, `applied.tables_skipped`,
--      `applied.before` / `applied.after` (per table: row level security,
--      what anon, authenticated and PUBLIC hold, the policies),
--      `applied.views`.
--    An ERROR means NOTHING WAS APPLIED:
--      · "canceling statement due to lock timeout" — another session held a
--        lock for more than 5 s. Run the file again.
--      · "… is owned by …" — the statement that fixes it is in the message.
--      · "write lockdown INCOMPLETE" — each line ends with its statement.
-- 2. IMMEDIATELY click Supabase Dashboard -> Settings -> API ->
--    "Reload schema cache". The NOTIFY in this file is optimistic on
--    Supabase managed infra; the Dashboard click is the deterministic step.
-- 3. POST-CHECKS.
--    (i)   Run …_preflight_report.sql again: `verdict.fully_locked` must be
--          true, `verdict.state` "fully_locked".
--    (ii)  Anonymous, with the public anon key only:
--            GET  /rest/v1/subscriptions?select=user_id          -> 401
--            POST /rest/v1/subscriptions  {}                     -> 401
--          both with "permission denied for table subscriptions".
--    (iii) Signed in to the product, paste …_probe.js into the browser
--          console: it must print CLOSED (the read answers 200 with one row,
--          the write of `cancel_at_period_end` back to its CURRENT value is
--          refused, 403).
--    (iv)  Sign up a throw-away account: it still gets its subscriptions
--          row. Upload one document: the quota still counts.
--    (v)   Run …_audit_report.sql again — BEFORE (iv), which adds rows:
--          `audit.row_fingerprints.subscriptions` must be the string step 0b
--          returned: no subscription row was changed, added or removed. A
--          string that differs is somebody else's write in between, not this
--          file's (it writes no row): a signup, a Stripe webhook or a cancel
--          for `subscriptions`; an upload or a chat turn for a meter; a
--          Stripe event for `billing_events`. `audit.subscriptions_total`
--          and `audit.rows_by_tier_plan_status` say which.
--    WHAT PROVES "0 OF 35" IN PRODUCTION. The gate cannot run there (it
--    creates accounts and re-opens the hole to prove it sees one). On the
--    local stack it shows that the catalog state `fully_locked` refuses 35 of
--    the 35 named attacks, and one write per column of the table, from each
--    of four starting states. In production the same catalog state is (i);
--    (ii) and (iii) are the two doors seen from outside.
-- 4. WHAT CHANGES, AND FOR WHOM.
--    · The product: nothing. No browser code writes these tables; the
--      backend writes with the service role, which this file does not touch.
--      Safe to apply BEFORE or AFTER the frontend that deletes cancel() /
--      reactivate().
--    · A signed-in user: reads their own subscriptions row and their own
--      meters as before; every direct write answers 403. Anonymous: 401 on
--      these tables (it was 200 with no rows).
--    · An operator in Studio: unaffected (the SQL editor is `postgres`).
--    · A RESTORE. A logical restore that re-creates the tables brings the
--      old grants and policies back: RE-RUN THIS FILE. A point-in-time
--      recovery to a moment after this file keeps it; to a moment before it,
--      re-run it. A NEW entitlement table gets Supabase's default grants on
--      the day it is created: add it to THE LIST below and re-run.
-- ─────────────────────────────────────────────────────────────────────

select set_config('entitlement_lockdown.applied', '', false) as lockdown_report_reset;

do $lockdown$
declare
  -- THE LIST. One name per line, quoted. To add a table, add its line here
  -- and in the lists of the three read-only files beside this one (the static
  -- law reds when they differ).
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
    'renewal_email_queue',    -- the renewal mails a subscription has queued
    'plan_assignment_audit'   -- who was moved onto / off an internal plan
  ];
  -- ENTITLEMENT-TABLES-SERVICE-ONLY-END
  --
  -- THE ONE POLICY each user-readable table keeps — the name and the
  -- expression the repository's own files create, `to authenticated`.
  -- ENTITLEMENT-KEPT-POLICIES-BEGIN
  v_keep jsonb := jsonb_build_object(
    'subscriptions',         jsonb_build_object('policy', 'subscriptions self select',        'using', '(auth.uid() = user_id)'),
    'user_usage',            jsonb_build_object('policy', 'users_see_own_usage',              'using', '(auth.uid() = user_id)'),
    'plan_chat_daily_usage', jsonb_build_object('policy', 'plan_chat_daily_usage_own_select', 'using', '(user_id = auth.uid())'));
  -- ENTITLEMENT-KEPT-POLICIES-END

  v_all     text[];
  v_table   text;
  v_rel     regclass;
  v_owner   name;
  v_pol     record;
  v_src     record;
  v_view    record;
  v_role    text;
  v_role_oid oid;
  v_priv    text;
  v_n       int;
  v_found   boolean;
  v_open    text := '';
  v_foreign text := '';
  v_privs   text[] := array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'SELECT'];
  -- Postgres 17 added the MAINTAIN privilege; the keyword does not exist
  -- before it, so every statement that names it is behind this flag.
  v_pg17    boolean := current_setting('server_version_num')::int >= 170000;

  v_skipped text[] := '{}';
  v_rls_on  text[] := '{}';
  v_dropped jsonb := '[]'::jsonb;
  v_created jsonb := '[]'::jsonb;
  v_views   jsonb := '[]'::jsonb;
  v_before  jsonb;
  v_after   jsonb;
  v_applied jsonb;

  -- What a listed table holds: row level security, the effective privileges
  -- of anon and authenticated (table OR column level, PUBLIC and inherited
  -- included), what PUBLIC holds in the ACL, and the policies.
  v_snapshot constant text := $snapshot$
    select coalesce(jsonb_object_agg(c.relname, jsonb_build_object(
             'row_level_security', c.relrowsecurity,
             'anon', (select coalesce(string_agg(p, ', ' order by p), '') from unnest($2) p
                       where case when p in ('INSERT', 'UPDATE', 'REFERENCES', 'SELECT')
                                  then has_any_column_privilege('anon', c.oid, p)
                                  else has_table_privilege('anon', c.oid, p) end),
             'authenticated', (select coalesce(string_agg(p, ', ' order by p), '') from unnest($2) p
                       where case when p in ('INSERT', 'UPDATE', 'REFERENCES', 'SELECT')
                                  then has_any_column_privilege('authenticated', c.oid, p)
                                  else has_table_privilege('authenticated', c.oid, p) end),
             'public', (select coalesce(string_agg(a.privilege_type, ', ' order by a.privilege_type), '')
                          from aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a where a.grantee = 0),
             'policies', (select coalesce(jsonb_agg(jsonb_build_object(
                                   'policy', p.policyname, 'cmd', p.cmd, 'roles', p.roles::text,
                                   'using', p.qual, 'with_check', p.with_check) order by p.policyname), '[]'::jsonb)
                            from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname))),
           '{}'::jsonb)
      from pg_class c
     where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and c.relname = any ($1)
  $snapshot$;
begin
  -- ── 0. wait for no one; change nothing that is not ours to change ─────
  perform set_config('lock_timeout', '5s', true);
  v_all := v_user_readable || v_service_only;
  if v_pg17 then v_privs := v_privs || 'MAINTAIN'::text; end if;

  if to_regclass('public.subscriptions') is null then
    raise exception 'write lockdown: public.subscriptions does not exist — this is not the product''s database; nothing was applied';
  end if;

  foreach v_table in array v_all loop
    v_rel := to_regclass(format('public.%I', v_table));
    if v_rel is null then
      v_skipped := v_skipped || v_table;
      continue;
    end if;
    select pg_get_userbyid(c.relowner) into v_owner from pg_class c where c.oid = v_rel;
    if not pg_has_role(current_user, (select c.relowner from pg_class c where c.oid = v_rel), 'USAGE') then
      v_foreign := v_foreign || format(
        E'\n  public.%s is owned by %s. As %s (or a superuser) run: alter table public.%I owner to %I;',
        v_table, v_owner, v_owner, v_table, current_user);
    end if;
  end loop;
  if v_foreign <> '' then
    raise exception using
      errcode = '42501',
      message = format('write lockdown: this file is running as %s, which does not own every listed table — nothing was applied:%s',
                       current_user, v_foreign),
      hint = 'Only a table''s owner can change its policies and grants. Hand the table over with the statement above, '
             || 'or run this file as its owner; then run this file again.';
  end if;

  execute v_snapshot into v_before using v_all, v_privs;

  -- ── 1. close ──────────────────────────────────────────────────────────
  foreach v_table in array v_all loop
    v_rel := to_regclass(format('public.%I', v_table));
    continue when v_rel is null;

    -- Only where it is off: `enable row level security` takes an exclusive
    -- lock even when it changes nothing.
    if not (select c.relrowsecurity from pg_class c where c.oid = v_rel) then
      execute format('alter table %s enable row level security', v_rel);
      v_rls_on := v_rls_on || v_table;
    end if;

    -- Every policy goes, but: on a service-only table a SELECT policy (no
    -- role holds a privilege to use it); on a user-readable table the ONE
    -- policy it keeps, when that one is already exactly what step 2 would
    -- create (so a second run drops nothing).
    for v_pol in
      select p.policyname, p.cmd from pg_policies p
       where p.schemaname = 'public' and p.tablename = v_table
         and case when v_keep ? v_table
                  then not (p.policyname = v_keep -> v_table ->> 'policy'
                            and p.cmd = 'SELECT'
                            and p.permissive = 'PERMISSIVE'
                            and p.roles = array['authenticated']::name[]
                            and p.qual = v_keep -> v_table ->> 'using')
                  else p.cmd <> 'SELECT' end
       order by p.policyname
    loop
      execute format('drop policy %I on %s', v_pol.policyname, v_rel);
      v_dropped := v_dropped || jsonb_build_object('table', v_table, 'policy', v_pol.policyname, 'cmd', v_pol.cmd);
    end loop;

    execute format('revoke all on table %s from public, anon', v_rel);
    if v_table = any (v_user_readable) then
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
  -- SELECT is left as found on the two meters, and granted on the one table
  -- the browser reads.
  grant select on table public.subscriptions to authenticated;

  -- ── 2. the ONE policy of each user-readable table ─────────────────────
  foreach v_table in array v_user_readable loop
    v_rel := to_regclass(format('public.%I', v_table));
    continue when v_rel is null;
    if not exists (select 1 from pg_policies p
                    where p.schemaname = 'public' and p.tablename = v_table
                      and p.policyname = v_keep -> v_table ->> 'policy') then
      execute format('create policy %I on %s for select to authenticated using (%s)',
                     v_keep -> v_table ->> 'policy', v_rel, v_keep -> v_table ->> 'using');
      v_created := v_created || jsonb_build_object('table', v_table, 'policy', v_keep -> v_table ->> 'policy');
    end if;
  end loop;

  -- ── 3. THE RESULT, READ BACK ──────────────────────────────────────────
  -- Raises — and so applies nothing — if a listed table is still writable
  -- by an API role, still carries a policy it should not, or has row level
  -- security off. Each line ends with the statement that removes the grant.
  foreach v_table in array v_all loop
    v_rel := to_regclass(format('public.%I', v_table));
    continue when v_rel is null;
    select pg_get_userbyid(c.relowner) into v_owner from pg_class c where c.oid = v_rel;

    if not (select c.relrowsecurity from pg_class c where c.oid = v_rel) then
      v_open := v_open || format(E'\n  public.%s: row level security is OFF', v_table);
    end if;

    foreach v_role in array array['anon', 'authenticated'] loop
      select r.oid into v_role_oid from pg_roles r where r.rolname = v_role;
      foreach v_priv in array v_privs loop
        continue when v_priv = 'SELECT' and v_role = 'authenticated' and v_table = any (v_user_readable);
        continue when not (case when v_priv in ('INSERT', 'UPDATE', 'REFERENCES', 'SELECT')
                                then has_any_column_privilege(v_role, v_rel, v_priv)
                                else has_table_privilege(v_role, v_rel, v_priv) end);
        v_found := false;
        -- (i) an entry in the table's own ACL, for the role or for PUBLIC
        for v_src in
          select a.grantee, pg_get_userbyid(a.grantor) as grantor
            from pg_class c, aclexplode(c.relacl) a
           where c.oid = v_rel and a.privilege_type = v_priv and a.grantee in (0, v_role_oid)
        loop
          v_found := true;
          v_open := v_open || format(
            E'\n  public.%s: %s still holds %s — granted%s by %s. Run: %s',
            v_table, v_role, v_priv,
            case when v_src.grantee = 0 then ' to PUBLIC' else '' end, v_src.grantor,
            case when v_src.grantor = v_owner
                 then format('revoke %s on public.%I from %s;', lower(v_priv), v_table,
                             case when v_src.grantee = 0 then 'public' else quote_ident(v_role) end)
                 else format('revoke %s on public.%I from %I cascade;', lower(v_priv), v_table, v_src.grantor) end);
        end loop;
        -- (ii) a column-level grant
        for v_src in
          select att.attname, a.grantee, pg_get_userbyid(a.grantor) as grantor
            from pg_attribute att, aclexplode(att.attacl) a
           where att.attrelid = v_rel and att.attnum > 0 and not att.attisdropped
             and a.privilege_type = v_priv and a.grantee in (0, v_role_oid)
        loop
          v_found := true;
          v_open := v_open || format(
            E'\n  public.%s: %s still holds %s on column %s — a column-level grant%s made by %s. Run: %s',
            v_table, v_role, v_priv, v_src.attname,
            case when v_src.grantee = 0 then ' to PUBLIC' else '' end, v_src.grantor,
            case when v_src.grantor = v_owner
                 then format('revoke %s (%I) on public.%I from %s;', lower(v_priv), v_src.attname, v_table,
                             case when v_src.grantee = 0 then 'public' else quote_ident(v_role) end)
                 else format('grant %s (%I) on public.%I to %I with grant option; revoke %s (%I) on public.%I from %I cascade;',
                             lower(v_priv), v_src.attname, v_table, v_src.grantor,
                             lower(v_priv), v_src.attname, v_table, v_src.grantor) end);
        end loop;
        -- (iii) inherited through a role membership
        for v_src in
          select m.rolname
            from pg_roles m
           where m.oid <> v_role_oid and pg_has_role(v_role_oid, m.oid, 'USAGE')
             and (exists (select 1 from pg_class c, aclexplode(c.relacl) a
                           where c.oid = v_rel and a.privilege_type = v_priv and a.grantee = m.oid)
                  or exists (select 1 from pg_attribute att, aclexplode(att.attacl) a
                              where att.attrelid = v_rel and att.attnum > 0
                                and a.privilege_type = v_priv and a.grantee = m.oid))
        loop
          v_found := true;
          v_open := v_open || format(
            E'\n  public.%s: %s still holds %s — inherited through its membership in role %s. Run: revoke %s on public.%I from %I;  (or end the membership: revoke %I from %I;)',
            v_table, v_role, v_priv, v_src.rolname, lower(v_priv), v_table, v_src.rolname, v_src.rolname, v_role);
        end loop;
        if not v_found then
          v_open := v_open || format(
            E'\n  public.%s: %s still holds %s — the grant is in none of the table''s ACL, its column ACLs or a role %s is a member of; read the pre-flight report',
            v_table, v_role, v_priv, v_role);
        end if;
      end loop;
    end loop;

    if v_keep ? v_table then
      select count(*) into v_n from pg_policies p
       where p.schemaname = 'public' and p.tablename = v_table;
      if v_n <> 1 or not exists (
           select 1 from pg_policies p
            where p.schemaname = 'public' and p.tablename = v_table
              and p.policyname = v_keep -> v_table ->> 'policy' and p.cmd = 'SELECT'
              and p.permissive = 'PERMISSIVE' and p.roles = array['authenticated']::name[]
              and p.qual = v_keep -> v_table ->> 'using') then
        v_open := v_open || format(
          E'\n  public.%s: %s policy(ies) — exactly one is expected: "%s", own row, SELECT, to authenticated',
          v_table, v_n, v_keep -> v_table ->> 'policy');
      end if;
    else
      select count(*) into v_n from pg_policies p
       where p.schemaname = 'public' and p.tablename = v_table and p.cmd <> 'SELECT';
      if v_n > 0 then
        v_open := v_open || format(E'\n  public.%s: %s policy(ies) with a command other than SELECT', v_table, v_n);
      end if;
    end if;
  end loop;

  if not has_table_privilege('authenticated', 'public.subscriptions', 'SELECT') then
    v_open := v_open || E'\n  public.subscriptions: authenticated does not hold SELECT — the product reads its own row';
  end if;

  if v_open <> '' then
    raise exception using
      errcode = '42501',
      message = 'write lockdown INCOMPLETE — nothing was applied:' || v_open,
      hint = 'Each line ends with the statement that removes that grant: run it as the table''s owner, then run this file again. '
             || 'A plain `revoke … from anon` or `… from authenticated` answers REVOKE and removes nothing when another role made the grant.';
  end if;

  -- ── 4. THE VIEWS — named, never changed ───────────────────────────────
  -- A view over a listed table is not closed by anything above, and a view
  -- over such a view no more: the walk is transitive. One an API role can
  -- WRITE THROUGH is the same hole by another door.
  for v_view in
    with recursive listed as (
      select c.oid from pg_class c
       where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and c.relname = any (v_all)
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
    select v.relnamespace::regnamespace::text || '.' || quote_ident(v.relname) as view_name,
           min(walk.depth) as depth,
           coalesce((select o.option_value from pg_options_to_table(v.reloptions) o
                      where o.option_name = 'security_invoker'), 'false') = 'true' as invoker,
           (pg_relation_is_updatable(v.oid, false) & 28) <> 0 as updatable,
           (select string_agg(r || ':' || p, ' ' order by r, p)
              from unnest(array['anon', 'authenticated']) r,
                   unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p
             where has_table_privilege(r, v.oid, p)) as api_privs,
           exists (select 1 from unnest(array['anon', 'authenticated']) r,
                                 unnest(array['INSERT', 'UPDATE', 'DELETE']) p
                    where has_table_privilege(r, v.oid, p)) as api_write
      from walk
      join pg_class v on v.oid = walk.view_oid and v.relkind in ('v', 'm')
     group by v.oid, v.relnamespace, v.relname, v.reloptions
     order by 1
  loop
    continue when v_view.api_privs is null;
    v_views := v_views || jsonb_build_object(
      'view', v_view.view_name, 'depth', v_view.depth, 'security_invoker', v_view.invoker,
      'can_be_written_through', (v_view.api_write and v_view.updatable and not v_view.invoker),
      'api_privileges', v_view.api_privs);
    if v_view.api_write and v_view.updatable and not v_view.invoker then
      raise warning 'write lockdown: view % reads a listed table (depth %), can be written through, and anon / authenticated hold [%] on it — THIS FILE DOES NOT CLOSE IT. Run: revoke insert, update, delete, truncate on % from anon, authenticated;',
        v_view.view_name, v_view.depth, v_view.api_privs, v_view.view_name;
    end if;
  end loop;

  -- ── 5. the result row ─────────────────────────────────────────────────
  execute v_snapshot into v_after using v_all, v_privs;
  v_applied := jsonb_build_object(
    'applied', true,
    'verified', 'every listed table is closed to anon and authenticated writes',
    'changed_anything', (v_before is distinct from v_after),
    'at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'run_as', current_user,
    'server_version_num', current_setting('server_version_num')::int,
    'tables_skipped', to_jsonb(v_skipped),
    'row_level_security_switched_on', to_jsonb(v_rls_on),
    'policies_dropped', v_dropped,
    'policies_created', v_created,
    'views', v_views,
    'views_that_can_be_written_through',
      (select coalesce(jsonb_agg(x -> 'view'), '[]'::jsonb) from jsonb_array_elements(v_views) x
        where (x ->> 'can_be_written_through')::boolean),
    'before', v_before,
    'after', v_after);
  perform set_config('entitlement_lockdown.applied', v_applied::text, false);
  -- The reload is asked for here too, so that this block run ALONE — the
  -- fallback for a client that takes one statement at a time — asks for it.
  perform pg_notify('pgrst', 'reload schema');

  -- For a person at psql. Nothing in the runbook depends on these lines.
  for v_pol in select x ->> 'table' as t, x ->> 'policy' as p, x ->> 'cmd' as c from jsonb_array_elements(v_dropped) x loop
    raise notice 'write lockdown: dropped policy "%" (%) on public.%', v_pol.p, v_pol.c, v_pol.t;
  end loop;
  foreach v_table in array v_skipped loop
    raise notice 'write lockdown: public.% does not exist here — skipped', v_table;
  end loop;
  raise notice 'write lockdown: verified — every listed table is closed to anon and authenticated writes';
end
$lockdown$;

-- F3.24 schema-migration discipline: optimistic PostgREST reload. The
-- Dashboard "Reload schema cache" click (runbook step 2) is the deterministic one.
notify pgrst, 'reload schema';

-- THE RESULT ROW — the last statement, because a client that runs the file
-- as one batch returns the last result. Where this session holds no result
-- from the block above — it raised and the client carried on, or the client
-- sent the statements over separate connections — the row cannot know what
-- the catalog is now, and says which file does.
select coalesce(
         nullif(current_setting('entitlement_lockdown.applied', true), '')::jsonb,
         jsonb_build_object(
           'applied', null,
           'verified', null,
           'note', 'this session holds no result from the lockdown block: either it raised (the error is above this row, and that run changed nothing) or the statements were sent over separate connections, and this row cannot see what was applied. Run schema_phase_subscriptions_write_lockdown_preflight_report.sql and read verdict.fully_locked.')
       ) as applied;
