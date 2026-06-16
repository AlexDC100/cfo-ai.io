-- billing_events — Stripe webhook idempotency log.
-- =============================================================================
-- WHY
--   `src/engine/api/_billing.py::_process_event()` does a SELECT then INSERT
--   against `billing_events` on every Stripe webhook delivery to short-circuit
--   re-processing of retried events. Both calls were wrapped in
--   `try/except Exception: pass`, so when the table didn't exist the webhook
--   silently kept working — but lost its idempotency guarantee. A Stripe retry
--   would re-execute the dispatch path (`_upsert_tier_subscription_from_stripe`,
--   `_grant_intro_entitlement`, etc.) and produce duplicate side effects.
--
--   Discovered during STRIPE-1 deployment verification on 2026-05-25 when the
--   diagnostic script queried the table and got 404. Not a go-live blocker, but
--   needs to land before significant subscription volume.
--
-- WHAT THIS ADDS
--   - billing_events table: append-only log keyed by stripe_event_id (UNIQUE).
--   - org_id FK with ON DELETE SET NULL — preserves the audit trail if an
--     organization is deleted later; the Stripe event history outlives the org.
--   - jsonb payload column — full Stripe event for forensic replay.
--   - Indexes on stripe_event_id (lookup hot path) and created_at DESC
--     (recency queries for diagnostics dashboards).
--
-- ACCESS MODEL
--   Service-role only. The webhook handler runs under the admin client; user
--   JWTs must never read this table (payloads can contain Stripe customer
--   data). RLS is enabled with no policies — the service role bypasses RLS,
--   and JWT-authenticated queries get zero rows.

set search_path = public;

-- ───────────────────────────────────────────────────────────────────────
-- 1. billing_events table
-- ───────────────────────────────────────────────────────────────────────
create table if not exists billing_events (
  id                uuid primary key default gen_random_uuid(),
  stripe_event_id   text unique not null,
  event_type        text not null,
  org_id            uuid references organizations(id) on delete set null,
  payload           jsonb not null,
  created_at        timestamptz not null default now()
);

-- ───────────────────────────────────────────────────────────────────────
-- 2. Indexes
-- ───────────────────────────────────────────────────────────────────────
-- Note: the UNIQUE constraint on stripe_event_id already creates a btree
-- index named `billing_events_stripe_event_id_key`. The explicit index
-- below is included for parity with the STRIPE-1 spec and named so it
-- matches the diagnostic queries; harmless duplication.
create index if not exists idx_billing_events_stripe_event_id
  on billing_events (stripe_event_id);

create index if not exists idx_billing_events_created_at
  on billing_events (created_at desc);

-- ───────────────────────────────────────────────────────────────────────
-- 3. RLS — service-role only
-- ───────────────────────────────────────────────────────────────────────
alter table billing_events enable row level security;

-- No policies on purpose. Reads and writes go through the admin client
-- (service role), which bypasses RLS. JWT-scoped clients get zero rows.

-- End of migration.


-- ─────────────────────────────────────────────────────────────────────
-- F3.24 (2026-05-26) — invalidate PostgREST schema cache after schema change.
-- Backfilled retroactively into existing migration files so re-running them
-- after a Postgres restore or fresh-environment setup stays safe. Harmless
-- on already-applied migrations. See CLAUDE.md §14 discipline rule.
-- ─────────────────────────────────────────────────────────────────────
NOTIFY pgrst, 'reload schema';
