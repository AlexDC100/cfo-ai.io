-- FIRM COCKPIT — attention items: suppressions + declared covenants.
--
-- The attention board (engine.firm, GET /api/firm/attention) is COMPUTED
-- from data the engine already holds; it needs no table of its own. What
-- it needs persisted is the two things a human decides:
--
--   · firm_attention_suppressions — "stop showing me this (client, kind,
--     scope)", WITH a reason, by whom, when, for how long. A reason is
--     NOT NULL and non-empty at the schema: a suppression without one is
--     not a decision. Suppressions are never deleted — they are revoked
--     (revoked_at), so the audit trail survives. A CRITICAL item is never
--     hidden by a suppression: the engine keeps it on the board, flagged,
--     with the reason beside it (engine.firm.suppress).
--
--   · firm_covenants — the DECLARED covenant model (packs/firm/
--     attention.yaml, COVENANT_RISK.covenant_schema). No covenant model
--     existed before; with no row for a client the kind emits nothing and
--     the board says so.
--
-- Cadence per client (firm_client_cadence) is Part C's table
-- (schema_phase_firm_requests.sql); the board reads it when present and
-- takes the pack default otherwise.
--
-- TENANCY. Reads: the workspace's own members (`is_member_of(org_id)`,
-- the pre-firm primitive, kept as its own policy) AND a firm role whose
-- `read` cell is true — PINNED TO THE ERA (below). Writes use the member
-- predicate OR the firm role matrix (`suppress` for suppressions,
-- `assign` for covenants). Both predicates come from
-- schema_phase_firm.sql, which MUST be applied first; this file fails
-- loudly (unknown function) rather than falling back to a weaker check.
--
-- THE ERA PIN (D3, 2026-09-05). Both tables carry `firm_id`: the firm
-- that served the client WHEN THE ROW WAS WRITTEN. It is stamped by a
-- BEFORE INSERT trigger (`firm_attention_pin_era`) as
-- `firm_of_org(org_id)`, whatever the client sent. A trigger, not a
-- default and not a generated column: a column DEFAULT cannot read a
-- sibling column (`org_id`), and a GENERATED column must be IMMUTABLE
-- while `firm_of_org` reads `organizations` — so a trigger is the only
-- in-database shape that writes the pin without trusting the caller.
-- The firm read policies then ask `firm_id is null or firm_id =
-- firm_of_org(org_id)`: a client that leaves firm A for firm B carries
-- A's suppressions (with A's accountant's uuid) and A's covenants
-- nowhere B's roles can read them — at RLS alone. The workspace's own
-- members keep the full history through the member policy, exactly as
-- requests (C3) and cadence (W3) do. The routes pin the same way
-- (engine.api._firm_attention.current_era_rows), so either wall alone
-- holds. A NULL pin is the client's own row (a workspace with no firm
-- when it was written) and reads for whichever firm serves it now.
--
-- COLUMN PRIVILEGES (D1, 2026-09-05). Supabase's project default is
--     alter default privileges in schema public
--       grant all on tables to anon, authenticated, service_role
-- so every table this file creates inherits TABLE-WIDE INSERT / UPDATE /
-- DELETE for `authenticated` (and `anon`); RLS chooses ROWS, never
-- COLUMNS. That default is what made a supabase-js PATCH of
-- {org_id, dismissed_by} on a caller's OWN suppression reachable with the
-- anon key + a user JWT: the revoke policy's WITH CHECK asked only
-- `revoked_by = auth.uid()`, so firm B rewrote its own row into firm A's
-- client, forged A's owner as the dismisser, and the row was ACTIVE on
-- A's board. Closed TWICE below: (a) the revoke WITH CHECK re-pins the
-- NEW row through the same predicate as the USING; (b) UPDATE is revoked
-- from anon/authenticated table-wide and granted back on
-- (revoked_at, revoked_by) ONLY — a PATCH naming any other column is
-- refused by Postgres BEFORE any policy runs (42501 permission denied
-- for table …). `reason` is NOT in the grant: the file's own contract is
-- that a decision's identity, kind, scope and reason are immutable once
-- written, nothing in the code path updates it, and this table has ONE
-- reason column — a revoker who could rewrite it would erase the
-- original decision's reason, which is the audit trail the revoke-not-
-- delete rule exists to keep. Covenants keep their editable figures
-- (label, metric, comparator, limit_value, unit, headroom_warn_share,
-- test_date, source) and lose UPDATE on their identity (id, org_id,
-- firm_id, covenant_id, created_by, created_at, updated_at). A client-
-- side UPSERT of a covenant is therefore refused BY DESIGN (ON CONFLICT
-- DO UPDATE sets every payload column, identity included): insert, or
-- PATCH the granted columns.
--
-- No policy in this file touches `memberships` — the 42P17 recursion
-- trap (CLAUDE.md §16) is avoided by reading memberships only inside the
-- SECURITY DEFINER helpers that already exist.
--
-- ── OPERATOR RUNBOOK (locked discipline — CLAUDE.md §14) ─────────────
-- 1. Apply supabase/schema_phase_multi_workspace.sql (is_member_of,
--    organizations.archived_at) and supabase/schema_phase_firm.sql
--    (firms, firm_can, firm_of_org, can_read_client_org) FIRST.
-- 2. Run this SQL in Supabase Studio (it ends with the NOTIFY). It is
--    idempotent: re-running it adds `firm_id` only where missing,
--    re-stamps only rows whose pin is NULL, and drops-then-recreates
--    every policy and trigger; the revoke-then-grant of section 6 lands
--    the same privilege set every time.
-- 3. IMMEDIATELY click Supabase Dashboard → Settings → API →
--    "Reload schema cache". The NOTIFY alone is insufficient on Supabase
--    managed infrastructure.
-- 4. Verify PostgREST sees both tables AND the pin — neither may 400:
--      select org_id, firm_id, kind, scope_key, reason from firm_attention_suppressions limit 1;
--      select org_id, firm_id, covenant_id, metric, limit_value from firm_covenants limit 1;
--    Verify the policy rows — NINE expected:
--      select tablename, policyname, cmd from pg_policies
--       where tablename in ('firm_attention_suppressions', 'firm_covenants')
--       order by 1, 2;
--      -- firm_attention_suppressions  firm_attention_suppressions insert         INSERT
--      -- firm_attention_suppressions  firm_attention_suppressions member select  SELECT
--      -- firm_attention_suppressions  firm_attention_suppressions read           SELECT
--      -- firm_attention_suppressions  firm_attention_suppressions revoke         UPDATE
--      -- firm_covenants               firm_covenants delete                      DELETE
--      -- firm_covenants               firm_covenants insert                      INSERT
--      -- firm_covenants               firm_covenants member select               SELECT
--      -- firm_covenants               firm_covenants read                        SELECT
--      -- firm_covenants               firm_covenants update                      UPDATE
--      -- (nine rows: four on suppressions, five on covenants)
--    Verify the column grants — `authenticated` must hold UPDATE on
--    EXACTLY these columns and NO table-wide UPDATE:
--      select table_name, column_name from information_schema.column_privileges
--       where grantee = 'authenticated' and privilege_type = 'UPDATE'
--         and table_name in ('firm_attention_suppressions', 'firm_covenants')
--       order by 1, 2;
--      -- firm_attention_suppressions  revoked_at
--      -- firm_attention_suppressions  revoked_by
--      -- firm_covenants               comparator, headroom_warn_share, label, limit_value,
--      --                              metric, source, test_date, unit
--      -- (ten rows: two on suppressions, eight on covenants)
--      select table_name, privilege_type from information_schema.table_privileges
--       where grantee in ('anon', 'authenticated') and privilege_type in ('UPDATE', 'DELETE')
--         and table_name in ('firm_attention_suppressions', 'firm_covenants');
--      -- expect ONE row: firm_covenants DELETE for authenticated (the
--      -- delete policy's table); no UPDATE row for either table, nothing
--      -- for anon.
--    Verify the triggers:
--      select tgrelid::regclass, tgname from pg_trigger where tgname like '%pin_era';
--      -- firm_attention_suppressions_pin_era, firm_covenants_pin_era
-- 5. GET /api/firm/attention must no longer list either table under
--    `notices` ("not readable — treated as empty").
-- ─────────────────────────────────────────────────────────────────────

-- ─────────── 1. Suppressions — a decision, with its reason ─────────────

create table if not exists firm_attention_suppressions (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references organizations(id) on delete cascade,
  -- THE ERA PIN: the firm serving the client when this row was written.
  -- Stamped by firm_attention_pin_era (BEFORE INSERT), never taken from
  -- the caller, never client-updatable (column privileges, section 6).
  firm_id             uuid references firms(id) on delete set null,
  -- The attention KIND (packs/firm/attention.yaml `kinds[].kind`) —
  -- the rule id of the underlying _finding_rank.Dismissal.
  kind                text not null,
  -- '*' = every scope of the kind on this client; otherwise the item's
  -- scope_key (e.g. 'period:2025-12-31', 'covenant:bcr-net-assets').
  scope_key           text not null default '*',
  reason              text not null check (length(btrim(reason)) > 0),
  dismissed_by        uuid not null default auth.uid() references auth.users(id) on delete set null,
  dismissed_at        timestamptz not null default now(),
  -- Optional bound: from this period ordinal, for this many periods.
  from_period_ordinal int,
  periods             int check (periods is null or periods > 0),
  -- Revoked, never deleted: the audit trail keeps every decision.
  revoked_at          timestamptz,
  revoked_by          uuid references auth.users(id) on delete set null,
  created_at          timestamptz not null default now()
);

-- A table created by the previous version of this file gains the pin.
alter table firm_attention_suppressions
  add column if not exists firm_id uuid references firms(id) on delete set null;

create index if not exists firm_attention_suppressions_org_idx
  on firm_attention_suppressions (org_id, kind) where revoked_at is null;
create index if not exists firm_attention_suppressions_firm_idx
  on firm_attention_suppressions (firm_id);

-- ─────────── 2. RLS — suppressions ──────────────────────────────────────

alter table firm_attention_suppressions enable row level security;

drop policy if exists "firm_attention_suppressions member select" on firm_attention_suppressions;
drop policy if exists "firm_attention_suppressions read" on firm_attention_suppressions;
drop policy if exists "firm_attention_suppressions insert" on firm_attention_suppressions;
drop policy if exists "firm_attention_suppressions revoke" on firm_attention_suppressions;

-- The workspace's own members: the client's whole history (C3 / W3).
create policy "firm_attention_suppressions member select"
  on firm_attention_suppressions for select
  using (is_member_of(org_id));

-- A firm role whose `read` cell is true: only the rows of the CURRENT
-- era (firm_id null — the client's own — or the firm serving it now).
create policy "firm_attention_suppressions read"
  on firm_attention_suppressions for select
  using (can_read_client_org(org_id)
         and (firm_id is null or firm_id = firm_of_org(org_id)));

-- The author is always the caller (auth.uid()), the pin is the trigger's
-- (never the caller's — BEFORE ROW triggers run before this WITH CHECK,
-- so it sees the stamped value), and the caller must be a workspace
-- member or hold a firm role whose `suppress` cell is true.
create policy "firm_attention_suppressions insert"
  on firm_attention_suppressions for insert
  with check (
    dismissed_by = auth.uid()
    and firm_id is not distinct from firm_of_org(org_id)
    and (is_member_of(org_id)
         or coalesce(firm_can(firm_of_org(org_id), 'suppress'), false))
  );

-- The only permitted update is a revocation. USING selects the rows the
-- caller may revoke; WITH CHECK re-pins the NEW row through the SAME
-- predicate (D1) and names the caller as the revoker. Every other
-- column is non-updatable by the column grant in section 6, so a PATCH
-- that names org_id, dismissed_by, dismissed_at, kind, scope_key,
-- firm_id, reason or the period bounds is refused before this policy
-- runs.
create policy "firm_attention_suppressions revoke"
  on firm_attention_suppressions for update
  using (is_member_of(org_id)
         or coalesce(firm_can(firm_of_org(org_id), 'suppress'), false))
  with check (
    (is_member_of(org_id)
     or coalesce(firm_can(firm_of_org(org_id), 'suppress'), false))
    and revoked_by = auth.uid()
  );

-- ─────────── 3. Covenants — the declared model ──────────────────────────

create table if not exists firm_covenants (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references organizations(id) on delete cascade,
  -- THE ERA PIN (see suppressions).
  firm_id             uuid references firms(id) on delete set null,
  covenant_id         text not null,
  label               text not null,
  -- One of the metric ids packs/firm/attention.yaml declares under
  -- COVENANT_RISK.covenant_metrics (equity, total_assets, net_result,
  -- ebitda, revenue, working_capital, current_liabilities). Validated by
  -- the engine against the pack, not by a CHECK list that would drift.
  metric              text not null,
  comparator          text not null check (comparator in ('>=', '>', '<=', '<')),
  limit_value         numeric not null,
  unit                text not null default 'money' check (unit in ('money', 'ratio', 'percent')),
  -- Warn when headroom / |limit| falls below this share (0..1).
  headroom_warn_share numeric not null default 0.10
    check (headroom_warn_share >= 0 and headroom_warn_share <= 1),
  test_date           date,
  source              text,
  created_by          uuid references auth.users(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (org_id, covenant_id)
);

alter table firm_covenants
  add column if not exists firm_id uuid references firms(id) on delete set null;

create index if not exists firm_covenants_org_idx on firm_covenants (org_id);
create index if not exists firm_covenants_firm_idx on firm_covenants (firm_id);

drop trigger if exists firm_covenants_set_updated_at on firm_covenants;
create trigger firm_covenants_set_updated_at
  before update on firm_covenants
  for each row execute function set_updated_at_now();

-- ─────────── 4. The era pin — one trigger function, two triggers ────────
-- Runs as the inserting role; it only calls firm_of_org (SECURITY
-- DEFINER, granted to authenticated). A function returning `trigger`
-- cannot be called from SQL, so no EXECUTE revoke is needed. BEFORE ROW
-- triggers run BEFORE the RLS WITH CHECK, so the insert policies see the
-- stamped value, never the caller's — and the service role, which
-- bypasses RLS, is stamped too.
create or replace function firm_attention_pin_era()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.firm_id := firm_of_org(new.org_id);
  return new;
end;
$$;

drop trigger if exists firm_attention_suppressions_pin_era on firm_attention_suppressions;
create trigger firm_attention_suppressions_pin_era
  before insert on firm_attention_suppressions
  for each row execute function firm_attention_pin_era();

drop trigger if exists firm_covenants_pin_era on firm_covenants;
create trigger firm_covenants_pin_era
  before insert on firm_covenants
  for each row execute function firm_attention_pin_era();

-- BACKFILL. Rows written before the pin existed carry the firm serving
-- the client at apply time — the best evidence the database holds; a
-- NULL stays NULL for a workspace with no firm (the client's own row,
-- readable by whichever firm serves it later). Re-running re-stamps
-- only rows whose pin is still NULL.
update firm_attention_suppressions s set firm_id = firm_of_org(s.org_id) where s.firm_id is null;
update firm_covenants c set firm_id = firm_of_org(c.org_id) where c.firm_id is null;

-- ─────────── 5. RLS — covenants ─────────────────────────────────────────

alter table firm_covenants enable row level security;

drop policy if exists "firm_covenants member select" on firm_covenants;
drop policy if exists "firm_covenants read" on firm_covenants;
drop policy if exists "firm_covenants insert" on firm_covenants;
drop policy if exists "firm_covenants update" on firm_covenants;
drop policy if exists "firm_covenants delete" on firm_covenants;

create policy "firm_covenants member select"
  on firm_covenants for select
  using (is_member_of(org_id));

create policy "firm_covenants read"
  on firm_covenants for select
  using (can_read_client_org(org_id)
         and (firm_id is null or firm_id = firm_of_org(org_id)));

create policy "firm_covenants insert"
  on firm_covenants for insert
  with check (firm_id is not distinct from firm_of_org(org_id)
              and (is_member_of(org_id)
                   or coalesce(firm_can(firm_of_org(org_id), 'assign'), false)));

-- org_id and firm_id are non-updatable by the column grant in section 6;
-- the WITH CHECK re-pins the row's client through the same predicate
-- anyway (D1: a policy WITH CHECK re-pins every tenancy column on the
-- NEW row, or the column is non-updatable — here both).
create policy "firm_covenants update"
  on firm_covenants for update
  using (is_member_of(org_id)
         or coalesce(firm_can(firm_of_org(org_id), 'assign'), false))
  with check (is_member_of(org_id)
              or coalesce(firm_can(firm_of_org(org_id), 'assign'), false));

create policy "firm_covenants delete"
  on firm_covenants for delete
  using (is_member_of(org_id)
         or coalesce(firm_can(firm_of_org(org_id), 'assign'), false));

-- ─────────── 6. Column privileges — the second closure of D1 ────────────
-- Narrows the Supabase default table-wide grant (see the header).
-- Postgres checks these BEFORE row-level security: a PATCH naming a
-- column outside the grant is `42501 permission denied for table …`
-- whatever the policies would have said. A table-level REVOKE also
-- revokes every column-level grant of the same privilege, so the
-- revoke-then-grant pair lands exactly this set on every re-run.

revoke update, delete on firm_attention_suppressions from anon, authenticated;
grant update (revoked_at, revoked_by) on firm_attention_suppressions to authenticated;

revoke update on firm_covenants from anon, authenticated;
revoke delete on firm_covenants from anon;
grant update (label, metric, comparator, limit_value, unit, headroom_warn_share, test_date, source)
  on firm_covenants to authenticated;

-- Optimistic on Supabase managed infra; the Dashboard click (runbook
-- step 3) is the deterministic action.
NOTIFY pgrst, 'reload schema';
