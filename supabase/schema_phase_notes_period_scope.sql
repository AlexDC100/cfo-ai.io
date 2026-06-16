-- ============================================================================
-- Phase D-backend (Phase Notes-Redesign root cause)
--
-- Scope: alerts + recommendations are currently org-scoped — `/api/period/:id`
-- queries `alerts WHERE org_id = ?` with no period filter, so every period
-- view returns the whole org's alert pool intermixed: live alerts for the
-- current period, plus stale alerts from old document_ids, plus alerts that
-- belong to OTHER periods entirely. For the EEI Dec 2025 demo period this
-- meant `(80 on file for this period)` with ~65 of those being noise.
--
-- Fix: scope alerts + recommendations to period_id via a new nullable
-- column + a (period_id, alert_key) / (period_id, source_alert_id) unique
-- key + ON DELETE CASCADE on the new FK so soft-deleted periods auto-clean.
--
-- The migration is IDEMPOTENT — safe to re-run. Uses DO blocks for
-- everything that's order-dependent (column add, constraint drop/add,
-- backfill) so reruns are no-ops.
--
-- Apply order (one transaction is fine):
--   1. Add period_id column (nullable) to alerts + recommendations
--   2. Backfill period_id by joining through documents.period_id where
--      possible (alerts.document_id → documents.period_id)
--   3. Drop the old (org_id, alert_key) unique on alerts; add
--      (period_id, alert_key) unique
--   4. Add ON DELETE CASCADE FK on alerts.period_id → financial_periods.id
--   5. Same shape for recommendations (different join: source_alert_id is
--      a text ref, harder to backfill — left nullable so historic rows
--      that can't be attributed don't get deleted, just become orphans
--      the FE filters out)
--
-- After deploy, the engine insert + the /api/period fetch must be updated
-- in lock-step (separate code commit) — see
-- src/engine/api/pipeline.py changes in the same Phase D-backend pass.
-- ============================================================================

begin;

-- ─── 1. alerts.period_id ─────────────────────────────────────────────
alter table alerts
  add column if not exists period_id uuid;

-- FK with ON DELETE CASCADE so when a period is dropped, its alerts go
-- away automatically. No more orphans.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'alerts_period_id_fkey'
      and conrelid = 'alerts'::regclass
  ) then
    alter table alerts
      add constraint alerts_period_id_fkey
      foreign key (period_id) references financial_periods(id)
      on delete cascade;
  end if;
end$$;

-- Backfill via the documents → financial_periods relationship.
-- documents.period_id is already populated (the Bug A fix lives in
-- pipeline.py:919-981, which assigns period_id on every persist). We
-- look up each alert's document → period and copy the period_id in.
update alerts a
   set period_id = d.period_id
  from documents d
 where a.document_id = d.id
   and a.period_id is null
   and d.period_id is not null;

-- ─── 2. recommendations.period_id ────────────────────────────────────
alter table recommendations
  add column if not exists period_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'recommendations_period_id_fkey'
      and conrelid = 'recommendations'::regclass
  ) then
    alter table recommendations
      add constraint recommendations_period_id_fkey
      foreign key (period_id) references financial_periods(id)
      on delete cascade;
  end if;
end$$;

-- Recommendations don't have a document_id today — backfill via
-- source_alert_id when it points at an alerts.id (UUID format).
-- Rows that can't be backfilled stay NULL and are filtered out of
-- /api/period responses by the new period_id filter (they become
-- legacy artifacts; the FE never shows them).
update recommendations r
   set period_id = a.period_id
  from alerts a
 where r.source_alert_id ~ '^[0-9a-f-]{36}$'
   and a.id::text = r.source_alert_id
   and r.period_id is null
   and a.period_id is not null;

-- ─── 3. New unique constraint (DEPLOY-SAFE: additive only) ───────────
-- alerts: ADD a new (period_id, alert_key) unique. INTENTIONALLY DOES
-- NOT DROP the existing (org_id, alert_key) constraint — keeping both
-- during the deploy window means:
--
--   · The OLD engine code (using `on_conflict="org_id,alert_key"`)
--     keeps working until you ship the new bundle, AND
--   · The NEW engine code (using `on_conflict="period_id,alert_key"`)
--     can write idempotently against the new constraint as soon as
--     it deploys.
--
-- Both constraints stay satisfied because alert_key already includes
-- a period_id suffix today (`{rule_key}:{period_id}` — see
-- pipeline.py:1346) — two different periods produce different
-- alert_keys so the legacy (org_id, alert_key) never collides
-- between periods.
--
-- After the new code is verified live, drop the legacy constraint in
-- a follow-up migration — see the bottom of this file (CLEANUP step).
--
-- NULL semantics: rows where period_id is NULL (unbackfillable legacy)
-- are allowed to exist with duplicate alert_keys — PostgreSQL's NULL
-- != NULL means the new constraint never fires when period_id is NULL.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'alerts'::regclass
      and contype = 'u'
      and conname = 'alerts_period_id_alert_key_key'
  ) then
    alter table alerts
      add constraint alerts_period_id_alert_key_key
      unique (period_id, alert_key);
  end if;
end$$;

-- ─── 4. Indexes for the new query shape ──────────────────────────────
-- /api/period filters alerts by period_id + resolved_at IS NULL.
-- An index on (period_id) where resolved_at IS NULL keeps that fast
-- as the alerts table grows.
create index if not exists alerts_period_unresolved_idx
  on alerts (period_id)
  where resolved_at is null;

create index if not exists recommendations_period_idx
  on recommendations (period_id);

-- ─── 5. One-shot stale-row cleanup ────────────────────────────────────
-- Delete alerts that have no period_id and no document_id (truly
-- orphaned, can't be attributed to any period). Keeps the table tidy
-- after the backfill. Note: rows with document_id but no period_id
-- are KEPT — they may be from a doc that was processed before
-- documents.period_id was reliably populated; we don't want to wipe
-- those silently.
delete from alerts
  where period_id is null
    and document_id is null;

commit;

-- ============================================================================
-- CLEANUP step — run AFTER the new engine code is deployed + verified live.
-- This drops the legacy (org_id, alert_key) constraint that's no longer used
-- by any code path (the new code uses (period_id, alert_key) exclusively).
-- ============================================================================
-- begin;
--   do $$
--   declare c_name text;
--   begin
--     select conname into c_name
--     from pg_constraint
--     where conrelid = 'alerts'::regclass
--       and contype = 'u'
--       and pg_get_constraintdef(oid) ilike '%(org_id, alert_key)%'
--     limit 1;
--     if c_name is not null then
--       execute format('alter table alerts drop constraint %I', c_name);
--     end if;
--   end$$;
-- commit;

-- ─── ROLLBACK (if Phase D-backend code change can't ship) ────────────
-- begin;
--   alter table alerts drop constraint if exists alerts_period_id_alert_key_key;
--   alter table alerts drop constraint if exists alerts_period_id_fkey;
--   alter table alerts drop column if exists period_id;
--   alter table recommendations drop constraint if exists recommendations_period_id_fkey;
--   alter table recommendations drop column if exists period_id;
--   drop index if exists alerts_period_unresolved_idx;
--   drop index if exists recommendations_period_idx;
-- commit;


-- ─────────────────────────────────────────────────────────────────────
-- F3.24 (2026-05-26) — invalidate PostgREST schema cache after schema change.
-- Backfilled retroactively into existing migration files so re-running them
-- after a Postgres restore or fresh-environment setup stays safe. Harmless
-- on already-applied migrations. See CLAUDE.md §14 discipline rule.
-- ─────────────────────────────────────────────────────────────────────
NOTIFY pgrst, 'reload schema';
