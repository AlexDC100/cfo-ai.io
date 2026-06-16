-- ============================================================================
-- Phase pricing-v2 tier check expansion (May 2026)
-- Extends `subscriptions.tier` CHECK to accept the new 4-tier model
--   (trial / intro / starter / pro) shipped via PricingTableV2 + _pricing_config.py.
-- Without this, customer.subscription.created webhooks for Pro/Intro fail with
--   23514 "subscriptions_tier_check" and the DB row is never written, even
--   though the Stripe payment succeeded.
--
-- Safe to run repeatedly (drop-if-exists + recreate).
-- Reversal: drop the constraint and recreate the older one from
--           schema_phase5_usage_limits.sql line 19-24.
-- ============================================================================

alter table subscriptions drop constraint if exists subscriptions_tier_check;

alter table subscriptions
  add constraint subscriptions_tier_check
    check (tier in (
      -- New 4-tier model (May 2026)
      'trial', 'intro', 'starter', 'pro',
      -- Phase 5 legacy values (kept for backward compat with existing rows)
      'solo', 'business', 'professional', 'enterprise',
      'professional_legacy_marker_unused'
    ));

-- Sanity check: confirm the constraint exists with the expanded set
do $$
declare
  v_def text;
begin
  select pg_get_constraintdef(oid) into v_def
  from pg_constraint
  where conname = 'subscriptions_tier_check';
  raise notice 'subscriptions_tier_check now: %', v_def;
end$$;


-- ─────────────────────────────────────────────────────────────────────
-- F3.24 (2026-05-26) — invalidate PostgREST schema cache after schema change.
-- Backfilled retroactively into existing migration files so re-running them
-- after a Postgres restore or fresh-environment setup stays safe. Harmless
-- on already-applied migrations. See CLAUDE.md §14 discipline rule.
-- ─────────────────────────────────────────────────────────────────────
NOTIFY pgrst, 'reload schema';
