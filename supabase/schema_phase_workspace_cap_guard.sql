-- ═══════════════════════════════════════════════════════════════════════
-- schema_phase_workspace_cap_guard.sql — the plan's workspace cap holds on
-- the way BACK from the archive, and a browser session cannot write the
-- columns the cap, the purge and the firm model read.
-- ═══════════════════════════════════════════════════════════════════════
--
-- THE HOLE (measured 2026-10-03, review of the subscriptions lockdown; and
-- again at the SQL level for this file). create_workspace() enforces the
-- plan's cap by counting the caller's LIVE workspaces (archived ones do not
-- count — by design: a user at the cap may archive one and create another).
-- A trial user (cap 1) reached 2, 3, 4 … live workspaces without touching
-- the plan row:
--
--   (i)  PATCH organizations.archived_at on their own workspace (policy
--        "organizations owner update" + the default grants let a member
--        write EVERY column) → create_workspace → PATCH it back to null;
--        purge_after, firm_id and cui were writable the same way.
--   (ii) no direct write at all: archive_workspace → create_workspace →
--        restore_workspace. restore_workspace never re-checked the cap.
--   (iii) create_firm → import_firm_client ×N → detach_workspace_from_firm
--        (only where schema_phase_firm.sql is applied). NOT changed by this
--        file — whether a firm's clients count against the importer's cap is
--        the owner's ruling.
--   (iv) two requests at once (measured 2026-10-03, finishing this file):
--        create_workspace counts, then inserts, with no lock — so
--        archive_workspace → create_workspace ∥ create_workspace gave 2 live
--        workspaces on a 1-workspace plan (N in parallel give N). A cap
--        asked of create_workspace on a restore has the same race:
--        restore_workspace ∥ restore_workspace.
--
-- THE FIX — one trigger on public.organizations, restrict only. No function
-- this repository defines is replaced: create_workspace, restore_workspace
-- and archive_workspace keep their bodies byte for byte (the file reads
-- md5(prosrc) of each before and after and refuses to commit a difference),
-- so NO CAP NUMBER and no tier → cap mapping is touched or copied.
--
--   organizations_guard_write  BEFORE INSERT OR UPDATE … FOR EACH ROW
--     1. a statement that runs AS `anon` or `authenticated` — a PATCH from a
--        browser session — may not change archived_at, purge_after, firm_id
--        or cui (42501). The workspace functions (archive_workspace,
--        restore_workspace, purge_workspace, the purge cron, the firm
--        functions) are SECURITY DEFINER: inside them current_user is the
--        function's owner and the update passes. The service role passes
--        (the workspace migration and its rollback archive / un-archive
--        through PostgREST as the service role). Every other column — name,
--        industry_key, industry_display_name, caen_code, which the browser
--        and the upload commit route write with the user's JWT — is not
--        guarded.
--     2. a workspace going from ARCHIVED to LIVE under a signed-in user's
--        request — restore_workspace today, any function tomorrow — is
--        allowed only if create_workspace would let that user add one more
--        workspace right now. The trigger ASKS create_workspace: it calls it
--        inside a sub-transaction that is always rolled back, and lets its
--        refusal ('workspace_cap_reached: your … plan allows … workspace(s)…',
--        the message the engine and the frontend already parse) through
--        unchanged. One cap authority: whatever create_workspace is
--        installed — this repository's, or feat/owner-plan's with its
--        unlimited branch — is the cap on a restore too. The service role
--        and a session with no JWT (the SQL editor) are not asked.
--     3. ONE AT A TIME PER USER. Before it asks, the trigger takes a
--        transaction-scoped advisory lock keyed on the caller, and it asks
--        the same question when a signed-in user's request INSERTS a live
--        workspace that is not a firm's client (create_workspace's own
--        insert). The second of two simultaneous requests waits for the
--        first to commit, then asks create_workspace — which now counts the
--        first one's workspace and refuses. That closes (iv) for a create
--        and for a restore, without one byte of create_workspace changing.
--        A firm's client (firm_id set — import_firm_client) is not asked:
--        path (iii) is exactly as it was. An insert made from inside
--        another trigger (the signup trigger's first workspace; the probe's
--        own insert) is not asked either.
--
-- WHY A TRIGGER AND NOT A NEW restore_workspace BODY. (a) production's
-- function bodies are not known to be this repository's; replacing one would
-- overwrite a body nobody has read. (b) re-running
-- schema_phase_multi_workspace.sql or schema_phase_archive_hold_guard.sql —
-- both written to be re-run — re-creates restore_workspace; a cap inside it
-- would be silently lost, a cap on the table is not. (c) it covers every
-- path that un-archives, not the one function known today.
--
-- WHAT IT LEAVES. Path (iii) above. A user who is ALREADY over their cap
-- keeps every workspace they have (no row is read for change, none is
-- written); they cannot restore or create another until they are under it.
-- A workspace restored or created by the service role or from the SQL editor
-- is not capped. A direct INSERT / DELETE / TRUNCATE on organizations (no
-- policy admits the first two; no API verb reaches the third). The other
-- columns no user-JWT path writes and nothing reads for an entitlement
-- (default_currency, caen_code_source, caen_code_confirmed_at) stay writable
-- by a member. A database whose create_workspace enforces no cap (the
-- schema_phase_multi_workspace.sql body) has no cap to hold anything to: the
-- direct writes are refused, a restore is not.
--
-- WHAT A USER SEES. A restore refused at the cap answers create_workspace's
-- message through restore_workspace; the workspace screens show their
-- generic "couldn't restore" (frontend/lib/org.ts reads the message only on
-- a create). A sentence for it is a frontend change, not this file's.
--
-- ── HOW IT IS APPLIED ────────────────────────────────────────────────────
--   0. PREFLIGHT (read-only, one row):
--        supabase/preflight/schema_phase_workspace_cap_guard_preflight_report.sql
--      Apply this file only where it answers  "hole_open": true.
--   1. Run this file as one batch (`supabase db query --linked -f <file>`,
--      or pasted whole into the SQL editor). One DO block: everything or — on
--      any error, a lock timeout included (5 s) — nothing. A lock timeout
--      means nothing was applied: run it again. Its LAST statement returns
--      one jsonb row: what it changed, what it skipped, what it could NOT
--      close ("not_closed" — empty unless another role owns the table), and
--      the md5 of each workspace function before and after.
--   2. Dashboard → Settings → API → "Reload schema cache" (CLAUDE.md §14).
--      No table, column or function signature changes; the click is the
--      discipline.
--   3. POST-CHECK: the preflight report again — "hole_open": false.
-- Idempotent: a second run changes nothing and says so. Safe before or after
-- schema_phase_owner_plan.sql, schema_phase_firm.sql and the subscriptions
-- write lockdown. On a database without organizations.archived_at
-- (schema_phase_multi_workspace.sql not applied) it installs nothing and
-- says so.
--
-- ROLLBACK (re-opens the hole):
--   drop trigger if exists organizations_guard_write on public.organizations;
--   drop function if exists public._organizations_guard_write();
--
-- Gate: scripts/check_hole_workspace_cap.sh (hole-workspace-cap);
-- static laws: tests/engine/test_entitlement_hole_laws.py.
-- ═══════════════════════════════════════════════════════════════════════

do $migration$
declare
  v_org       regclass := to_regclass('public.organizations');
  v_changed   jsonb := '[]'::jsonb;
  v_skipped   jsonb := '[]'::jsonb;
  v_left      jsonb := '[]'::jsonb;
  v_before    jsonb;
  v_after     jsonb;
  v_guard_before text;
  v_guard_after  text;
  v_guard_was_definer boolean;
  v_trigger   record;
begin
  perform set_config('lock_timeout', '5s', true);
  perform set_config('cfo_holes.result', '', false);   -- never answer with another file's result

  if v_org is null then
    v_skipped := v_skipped || to_jsonb('public.organizations does not exist — nothing to guard'::text);
  elsif not exists (select 1 from pg_attribute
                     where attrelid = v_org and attname = 'archived_at' and not attisdropped) then
    v_skipped := v_skipped || to_jsonb('public.organizations has no archived_at column (schema_phase_multi_workspace.sql is not applied) — there is no archive to come back from; nothing installed'::text);
  elsif not has_table_privilege(current_user, v_org, 'TRIGGER') then
    -- Another role owns the table and this one may not put a trigger on it
    -- (Postgres would answer "must be owner of relation organizations" and
    -- the whole file would roll back with nothing said). Say it instead.
    v_left := v_left || to_jsonb(format('public.organizations is owned by %s and the role running this file (%s) may not create a trigger on it — the guard is NOT installed. Run this file as %s.',
      (select pg_get_userbyid(c.relowner) from pg_class c where c.oid = v_org), current_user,
      (select pg_get_userbyid(c.relowner) from pg_class c where c.oid = v_org)));
  else
    -- The workspace functions, before: this file must not change one byte of them.
    select coalesce(jsonb_object_agg(p.oid::regprocedure::text, md5(p.prosrc)), '{}'::jsonb)
      into v_before
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.proname in ('create_workspace', 'restore_workspace', 'archive_workspace',
                         'purge_workspace', 'purge_expired_workspaces');

    select md5(p.prosrc), p.prosecdef into v_guard_before, v_guard_was_definer
      from pg_proc p
     where p.oid = to_regprocedure('public._organizations_guard_write()');

    -- SECURITY INVOKER on purpose: current_user must be the role the
    -- statement runs as (authenticated for a PATCH, the owner inside a
    -- SECURITY DEFINER function). `create or replace` without a SECURITY
    -- clause sets it back to INVOKER where somebody altered it.
    create or replace function public._organizations_guard_write()
    returns trigger
    language plpgsql
    set search_path = public
    as $$
declare
  v_new    jsonb := to_jsonb(new);
  v_old    jsonb;
  v_col    text;
  v_asked  boolean := false;
begin
  if tg_op = 'UPDATE' then
    v_old := to_jsonb(old);

    -- 1. A browser session writes the lifecycle and firm columns only through
    --    the workspace functions.
    if current_user in ('anon', 'authenticated') then
      foreach v_col in array array['archived_at', 'purge_after', 'firm_id', 'cui'] loop
        if (v_new -> v_col) is distinct from (v_old -> v_col) then
          raise exception 'organizations.% is not writable directly: use the workspace functions (archive_workspace, restore_workspace, purge_workspace, the firm functions).', v_col
            using errcode = '42501';
        end if;
      end loop;
    end if;

    -- 2. Back from the archive.
    v_asked := old.archived_at is not null and new.archived_at is null;

  elsif tg_op = 'INSERT' then
    -- 3. A new live workspace that is not a firm's client, inserted by the
    --    request itself (trigger depth 1) — create_workspace's own insert.
    --    Deeper inserts are the signup trigger's and the probe's below.
    v_asked := new.archived_at is null
               and coalesce(v_new ->> 'firm_id', '') = ''
               and pg_trigger_depth() = 1;
  end if;

  -- Under a signed-in user's request: the plan's workspace cap, asked of
  -- create_workspace itself, one request at a time per user. The probe
  -- workspace never exists outside the sub-transaction; create_workspace's
  -- own refusal (workspace_cap_reached: …) passes through unchanged.
  if v_asked
     and auth.uid() is not null
     and coalesce(auth.jwt() ->> 'role', '') <> 'service_role'
     and to_regprocedure('public.create_workspace(text,text,text)') is not null then
    perform pg_advisory_xact_lock(hashtextextended('cfo-ai workspace cap ' || auth.uid()::text, 0));
    begin
      perform public.create_workspace('workspace cap probe (rolled back)');
      raise exception 'workspace cap probe passed' using errcode = 'ZC001';
    exception
      when sqlstate 'ZC001' then
        null;
    end;
  end if;

  return new;
end;
$$;

    -- A trigger function is fired, never called: no API role needs EXECUTE.
    revoke all on function public._organizations_guard_write() from public, anon, authenticated;

    select md5(p.prosrc) into v_guard_after
      from pg_proc p
     where p.oid = to_regprocedure('public._organizations_guard_write()');
    if v_guard_after is distinct from v_guard_before then
      v_changed := v_changed || to_jsonb(format('_organizations_guard_write(): %s (md5 %s)',
        case when v_guard_before is null then 'created' else 'body replaced, was md5 ' || v_guard_before end, v_guard_after));
    end if;
    if coalesce(v_guard_was_definer, false) then
      v_changed := v_changed || to_jsonb('_organizations_guard_write(): it was SECURITY DEFINER (inside it current_user is the owner — it refused nothing) — SECURITY INVOKER again'::text);
    end if;

    select t.tgenabled, t.tgtype, t.tgfoid into v_trigger
      from pg_trigger t
     where t.tgrelid = v_org and t.tgname = 'organizations_guard_write' and not t.tgisinternal;
    if not found then
      create trigger organizations_guard_write
        before insert or update on public.organizations
        for each row execute function public._organizations_guard_write();
      v_changed := v_changed || to_jsonb('trigger organizations_guard_write created (BEFORE INSERT OR UPDATE, FOR EACH ROW) on public.organizations'::text);
    elsif v_trigger.tgfoid <> 'public._organizations_guard_write()'::regprocedure
          or v_trigger.tgtype <> 23 then
      -- The name is taken by something that is not this guard (23 = ROW,
      -- BEFORE, INSERT, UPDATE).
      drop trigger organizations_guard_write on public.organizations;
      create trigger organizations_guard_write
        before insert or update on public.organizations
        for each row execute function public._organizations_guard_write();
      v_changed := v_changed || to_jsonb('trigger organizations_guard_write re-created (it existed with another function or other events)'::text);
    elsif v_trigger.tgenabled <> 'O' then
      alter table public.organizations enable trigger organizations_guard_write;
      v_changed := v_changed || to_jsonb(format('trigger organizations_guard_write enabled (it was %s)',
        case v_trigger.tgenabled when 'D' then 'DISABLED' when 'R' then 'REPLICA-only' when 'A' then 'ALWAYS' else v_trigger.tgenabled::text end));
    end if;

    -- The workspace functions, after.
    select coalesce(jsonb_object_agg(p.oid::regprocedure::text, md5(p.prosrc)), '{}'::jsonb)
      into v_after
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.proname in ('create_workspace', 'restore_workspace', 'archive_workspace',
                         'purge_workspace', 'purge_expired_workspaces');
    if v_after is distinct from v_before then
      raise exception 'workspace cap guard: a workspace function body changed during this file (before %, after %) — nothing was applied', v_before, v_after;
    end if;

    if to_regprocedure('public.create_workspace(text,text,text)') is null then
      v_skipped := v_skipped || to_jsonb('public.create_workspace(text, text, text) does not exist: the guard is installed, and there is no cap for a restore to be held to'::text);
    end if;
  end if;

  notify pgrst, 'reload schema';

  perform set_config('cfo_holes.result', jsonb_build_object(
    'migration', 'schema_phase_workspace_cap_guard.sql',
    'changed', v_changed,
    'changed_count', jsonb_array_length(v_changed),
    'skipped', v_skipped,
    'not_closed', v_left,
    'workspace_function_md5_before', coalesce(v_before, '{}'::jsonb),
    'workspace_function_md5_after', coalesce(v_after, '{}'::jsonb),
    'workspace_function_bodies_unchanged', coalesce(v_after, '{}'::jsonb) = coalesce(v_before, '{}'::jsonb),
    'not_changed_on_purpose', 'create_firm / import_firm_client / detach_workspace_from_firm (path iii — the owner''s ruling); no organizations row; no cap number',
    'next', 'Reload the schema cache (Dashboard → Settings → API), then run the preflight report again: "hole_open" must be false.'
  )::text, false);
end
$migration$;

select coalesce(nullif(current_setting('cfo_holes.result', true), ''),
                '{"error": "the migration block did not run"}')::jsonb as result;
