-- RADAR — dismissals with a reason.
--
-- Radar (engine.radar, GET /api/radar/{period_id}) is COMPUTED from data
-- the engine already holds: the period's persisted line items and its
-- assembled_canonical_v1 envelope. It needs no table of findings. What it
-- needs persisted is the one thing a human decides:
--
--   · radar_dismissals — "stop showing me this (rule, subject)", WITH a
--     reason, by whom, when, from which period, for how many periods. A
--     reason is NOT NULL and non-empty at the schema: a dismissal without
--     one is not a decision. Dismissals are never deleted — they are
--     revoked (revoked_at), so the audit trail survives. A finding whose
--     GROUP is graded CRITICAL is never hidden by a dismissal: the engine
--     keeps it surfaced, flagged, with the reason beside it
--     (engine.api._finding_rank.rank_findings + engine.radar.serve).
--
--     A dismissal is ANCHORED ON A PERIOD, never on a spine position: it
--     records the id AND the period end of the period it was made on, and
--     its reach (`periods`) is counted from that period's ordinal on the
--     workspace spine AS IT IS AT SERVE TIME (engine.api._radar
--     .anchor_ordinal). A period uploaded earlier moves every ordinal and
--     moves nothing about which periods a dismissal covers.
--     `from_period_ordinal` is kept as information (the position when the
--     decision was made); it is never read to apply the dismissal.
--
-- TENANCY. A workspace IS an organization (CLAUDE.md §16). Reads and
-- writes use is_member_of(org_id) from schema_phase_multi_workspace.sql,
-- which MUST be applied first; this file fails loudly (unknown function)
-- rather than falling back to a weaker check. No policy here touches
-- `memberships` directly — the 42P17 recursion trap is avoided by reading
-- memberships only inside the SECURITY DEFINER helper that already exists.
--
-- ── OPERATOR RUNBOOK (locked discipline — CLAUDE.md §14) ─────────────
-- 1. Apply supabase/schema_phase_multi_workspace.sql (is_member_of) FIRST.
-- 2. Run this SQL in Supabase Studio (it ends with the NOTIFY).
-- 3. IMMEDIATELY click Supabase Dashboard → Settings → API →
--    "Reload schema cache". The NOTIFY alone is insufficient on Supabase
--    managed infrastructure.
-- 4. Verify PostgREST sees the table AND the anchor column — it may not 400:
--      select org_id, rule_id, scope_key, reason, period_id, from_period_end
--        from radar_dismissals limit 1;
-- 5. GET /api/radar/{period_id} must no longer list radar_dismissals under
--    `notices` ("not readable — no dismissal applied").
-- ─────────────────────────────────────────────────────────────────────

create table if not exists radar_dismissals (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references organizations(id) on delete cascade,
  -- The period the reader was looking at when they dismissed — the ANCHOR
  -- of the dismissal's reach. Resolved to an ordinal on the spine at every
  -- serve; when the period is later deleted, from_period_end anchors it
  -- where it stood.
  period_id           uuid references financial_periods(id) on delete set null,
  from_period_end     date,
  -- The detector id (engine.api.findings — e.g. 'liquidity_cash_tight',
  -- 'm_direction.ar_net') — the rule id of the _finding_rank.Dismissal.
  rule_id             text not null check (length(btrim(rule_id)) > 0),
  -- '*' = every subject of the rule in this workspace; otherwise the
  -- finding's root_cause (its ledger accounts, e.g. '5121+5124+531').
  scope_key           text not null default '*',
  reason              text not null check (length(btrim(reason)) > 0),
  dismissed_by        uuid not null default auth.uid() references auth.users(id) on delete set null,
  dismissed_at        timestamptz not null default now(),
  -- Reach: for this many periods counting the anchor period; a null span
  -- is open-ended (allowed, and served as such). from_period_ordinal is the
  -- spine position WHEN the decision was recorded — information only.
  from_period_ordinal int,
  periods             int check (periods is null or periods > 0),
  -- Revoked, never deleted: the audit trail keeps every decision.
  revoked_at          timestamptz,
  revoked_by          uuid references auth.users(id) on delete set null,
  created_at          timestamptz not null default now()
);

-- Idempotent for a table created by an earlier version of this file
-- (before dismissals were anchored on a period end).
alter table radar_dismissals add column if not exists from_period_end date;

create index if not exists radar_dismissals_org_idx
  on radar_dismissals (org_id, rule_id) where revoked_at is null;

alter table radar_dismissals enable row level security;

drop policy if exists "radar_dismissals read" on radar_dismissals;
drop policy if exists "radar_dismissals insert" on radar_dismissals;
drop policy if exists "radar_dismissals revoke" on radar_dismissals;

create policy "radar_dismissals read"
  on radar_dismissals for select
  using (is_member_of(org_id));

-- The author is always the caller (auth.uid()), and the caller must be a
-- member of the workspace.
create policy "radar_dismissals insert"
  on radar_dismissals for insert
  with check (dismissed_by = auth.uid() and is_member_of(org_id));

-- The only permitted update is a revocation: the row's identity, rule,
-- scope and reason are immutable once written.
create policy "radar_dismissals revoke"
  on radar_dismissals for update
  using (is_member_of(org_id))
  with check (revoked_by = auth.uid());

-- A purged workspace takes its dismissals with it (on delete cascade above);
-- purge_expired_workspaces() needs no extra line.

NOTIFY pgrst, 'reload schema';
