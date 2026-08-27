-- Plan caps (2026-08 tier restructure) — workspace cap hard floor +
-- non-RO document meter.
--
-- Pairs with:
--   · src/engine/api/_pricing_config.py   (the tier table; solo/pro/multi)
--   · src/engine/api/_usage_gate.py       (reserve/commit/release_nonro_document)
--   · src/engine/api/pipeline.py          (_enforce_nonro_plan_gate + terminal commit)
--   · tests/engine/test_pricing_tiers.py  (spec lock)
--
-- WHAT'S ADDED
-- ============
-- · create_workspace() body REPLACED — enforces the per-tier workspace
--   cap in SQL (the hard floor; backend/FE mirror it as soft gates via
--   _plan_state.max_workspaces_for). Cap by subscriptions.tier for
--   auth.uid(): solo → 1, pro/multi/starter/pro_legacy → 5, anything
--   else (trial/intro/no row) → 1. Raises
--   'workspace_cap_reached: …' — the FE matches the prefix.
-- · user_usage.nonro_uploads / nonro_uploads_reserved — the SEPARATE
--   monthly non-RO counter (least-invasive shape: two columns on the
--   existing per-(user, month) row; no new table).
-- · documents.nonro_doc / nonro_metered_extra — stamps written by the
--   pipeline's non-RO gate so the daemon-thread terminal commit knows
--   which meter to settle (mirrors the existing `metered_extra` flag).
-- · subscriptions.nonro_extra_billed_period — billed non-RO overages
--   tally (mirrors extra_docs_billed_period).
-- · reserve_user_nonro_upload / commit_user_nonro_upload /
--   release_user_nonro_upload — atomic RPCs, SECURITY DEFINER, granted
--   to service_role ONLY (the Python admin client calls them). Same
--   reservation model + WHERE-guard atomicity as
--   schema_phase_pricing_v3_atomic.sql.
--
-- Fully idempotent: IF NOT EXISTS everywhere + CREATE OR REPLACE FUNCTION.
--
-- ── OPERATOR RUNBOOK (locked discipline — CLAUDE.md §14 / F3.24) ──────
-- 1. Run this SQL in Supabase Studio (includes the NOTIFY at the bottom).
-- 2. IMMEDIATELY click Supabase Dashboard → Settings → API →
--    "Reload schema cache". The NOTIFY is optimistic on Supabase managed
--    infra; the Dashboard click is the deterministic step.
-- 3. Verify PostgREST sees the new surface — these must NOT 400:
--      select user_id, nonro_uploads, nonro_uploads_reserved
--        from user_usage limit 1;
--      select id, nonro_doc, nonro_metered_extra from documents limit 1;
--      select user_id, nonro_extra_billed_period from subscriptions limit 1;
--    If they stay invisible after the Settings-toggle escalation, this is
--    the F3.25 Bug #4 persistent-cache case: stop, open a Supabase ticket.
-- 4. ONE-TIME CUTOVER (run ONCE, at deploy of the 2026-08 tiers, BEFORE
--    any NEW-price pro checkout can complete — deliberately NOT part of
--    this idempotent file because re-running it after new-pro
--    subscribers exist would wrongly upgrade them):
--
--      -- Every row with tier='pro' today is, by definition, a
--      -- 39.99-era subscriber (the new 9.99 pro didn't exist yet).
--      -- Stamp them pro_legacy → the multi entitlement set.
--      update subscriptions
--         set tier = 'pro_legacy', updated_at = now()
--       where tier = 'pro'
--         and stripe_subscription_id is not null;
--
--    (Rows created after cutover resolve via the webhook's
--    STRIPE_PRICE_PRO_LEGACY price-id check instead — see _billing.py.)
-- ─────────────────────────────────────────────────────────────────────

set search_path = public;

-- ───────────────────────────────────────────────────────────────────────
-- 0. subscriptions.tier CHECK — accept the 2026-08 keys
-- ───────────────────────────────────────────────────────────────────────
-- Without this, customer.subscription.created webhooks for Multi-Country
-- (tier='multi') or a grandfathered legacy pro (tier='pro_legacy') fail
-- with 23514 subscriptions_tier_check and the row is never written even
-- though the Stripe payment succeeded — the exact failure
-- schema_phase_pricing_v2_tier_check.sql fixed for the May 2026 keys.
-- Safe to run repeatedly (drop-if-exists + recreate).
alter table subscriptions drop constraint if exists subscriptions_tier_check;
alter table subscriptions
  add constraint subscriptions_tier_check
    check (tier in (
      -- 2026-08 tier model
      'trial', 'intro', 'solo', 'pro', 'multi',
      -- Retired-from-purchase + grandfathered synthetic keys
      'starter', 'pro_legacy',
      -- Phase 5 legacy values (kept for backward compat with old rows)
      'business', 'professional', 'enterprise',
      'professional_legacy_marker_unused'
    ));

-- ───────────────────────────────────────────────────────────────────────
-- 1. user_usage — non-RO monthly counters (additive, idempotent)
-- ───────────────────────────────────────────────────────────────────────
alter table if exists user_usage
  add column if not exists nonro_uploads          int not null default 0,
  add column if not exists nonro_uploads_reserved int not null default 0;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'user_usage_nonro_uploads_nonneg') then
    alter table user_usage
      add constraint user_usage_nonro_uploads_nonneg check (nonro_uploads >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'user_usage_nonro_reserved_nonneg') then
    alter table user_usage
      add constraint user_usage_nonro_reserved_nonneg check (nonro_uploads_reserved >= 0);
  end if;
end$$;

-- ───────────────────────────────────────────────────────────────────────
-- 2. documents — non-RO stamps for the daemon-thread terminal commit
-- ───────────────────────────────────────────────────────────────────────
alter table if exists documents
  add column if not exists nonro_doc           boolean not null default false,
  add column if not exists nonro_metered_extra boolean not null default false;

-- ───────────────────────────────────────────────────────────────────────
-- 3. subscriptions — billed non-RO overage tally
-- ───────────────────────────────────────────────────────────────────────
alter table if exists subscriptions
  add column if not exists nonro_extra_billed_period int not null default 0;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'subscriptions_nonro_extra_billed_nonneg') then
    alter table subscriptions
      add constraint subscriptions_nonro_extra_billed_nonneg check (nonro_extra_billed_period >= 0);
  end if;
end$$;

-- ═══════════════════════════════════════════════════════════════════════
-- 4. Atomic RPCs — non-RO uploads (reservation model, gap-C/gap-D
--    discipline inherited from schema_phase_pricing_v3_atomic.sql)
-- ═══════════════════════════════════════════════════════════════════════

-- reserve_user_nonro_upload — atomic check-and-reserve for ONE non-RO
-- document. Returns jsonb { kind, used, reserved, cap, extra }:
--   · kind='allowed', extra=false — within included_nonro_docs.
--   · kind='allowed', extra=true  — above the included cap on a plan
--     that allows overage (multi): reservation still lands; the caller
--     records one metered unit at commit time.
--   · kind='blocked'              — above cap, no overage allowed.
-- The "is this plan allowed to run non-RO at all" decision is made in
-- Python (_usage_gate.reserve_nonro_document) BEFORE this RPC — a plan
-- with allows_non_ro=false never reaches here.
create or replace function reserve_user_nonro_upload(
  p_user_id     uuid,
  p_month       text,
  p_base_cap    int,
  p_allow_extra boolean
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_used     int;
  v_reserved int;
begin
  insert into user_usage (user_id, month, uploads, uploads_reserved,
                          nonro_uploads, nonro_uploads_reserved)
       values (p_user_id, p_month, 0, 0, 0, 0)
  on conflict (user_id, month) do nothing;

  -- Within the included cap: atomic guarded reserve (extra=false).
  update user_usage
     set nonro_uploads_reserved = nonro_uploads_reserved + 1
   where user_id = p_user_id
     and month   = p_month
     and (nonro_uploads + nonro_uploads_reserved) < p_base_cap
  returning nonro_uploads, nonro_uploads_reserved
       into v_used, v_reserved;

  if v_used is not null then
    return jsonb_build_object(
      'kind', 'allowed', 'extra', false,
      'used', v_used, 'reserved', v_reserved, 'cap', p_base_cap);
  end if;

  if p_allow_extra then
    -- Overage: reservation still lands, flagged extra so the terminal
    -- commit bills one metered unit (success-only, gap D).
    update user_usage
       set nonro_uploads_reserved = nonro_uploads_reserved + 1
     where user_id = p_user_id and month = p_month
    returning nonro_uploads, nonro_uploads_reserved
         into v_used, v_reserved;
    return jsonb_build_object(
      'kind', 'allowed', 'extra', true,
      'used', coalesce(v_used, 0), 'reserved', coalesce(v_reserved, 0),
      'cap', p_base_cap);
  end if;

  select nonro_uploads, nonro_uploads_reserved
    into v_used, v_reserved
    from user_usage
   where user_id = p_user_id and month = p_month;
  return jsonb_build_object(
    'kind', 'blocked',
    'used', coalesce(v_used, 0), 'reserved', coalesce(v_reserved, 0),
    'cap', p_base_cap);
end;
$$;

-- commit_user_nonro_upload — analysis succeeded: reservation → consumed;
-- when p_was_extra, bump the billed tally. Floors prevent underflow so a
-- double commit is a no-op on the reservation side.
create or replace function commit_user_nonro_upload(
  p_user_id   uuid,
  p_month     text,
  p_was_extra boolean
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update user_usage
     set nonro_uploads          = nonro_uploads + 1,
         nonro_uploads_reserved = greatest(nonro_uploads_reserved - 1, 0)
   where user_id = p_user_id and month = p_month;

  if p_was_extra then
    update subscriptions
       set nonro_extra_billed_period = nonro_extra_billed_period + 1
     where user_id = p_user_id;
  end if;
end;
$$;

-- release_user_nonro_upload — analysis failed: drop the reservation,
-- nothing consumed, nothing billed (gap D).
create or replace function release_user_nonro_upload(
  p_user_id   uuid,
  p_month     text,
  p_was_extra boolean
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update user_usage
     set nonro_uploads_reserved = greatest(nonro_uploads_reserved - 1, 0)
   where user_id = p_user_id and month = p_month;
  -- p_was_extra is accepted for call-shape symmetry with commit; the
  -- billed tally is only ever bumped on commit, so there is nothing to
  -- unwind here.
end;
$$;

revoke all on function reserve_user_nonro_upload(uuid, text, int, boolean) from public, anon, authenticated;
revoke all on function commit_user_nonro_upload(uuid, text, boolean)       from public, anon, authenticated;
revoke all on function release_user_nonro_upload(uuid, text, boolean)      from public, anon, authenticated;
grant execute on function reserve_user_nonro_upload(uuid, text, int, boolean) to service_role;
grant execute on function commit_user_nonro_upload(uuid, text, boolean)       to service_role;
grant execute on function release_user_nonro_upload(uuid, text, boolean)      to service_role;

-- ═══════════════════════════════════════════════════════════════════════
-- 5. create_workspace() — REPLACED with the per-tier workspace cap
-- ═══════════════════════════════════════════════════════════════════════
-- Body is the schema_phase_multi_workspace.sql original plus the cap
-- check. SECURITY DEFINER reading memberships inside a FUNCTION is the
-- prescribed pattern (never inside a POLICY on memberships — the 42P17
-- recursion trap, see schema_phase3.sql:193).
--
-- Cap source: subscriptions.tier for auth.uid() (billing is per USER —
-- one plan covers all their SRLs). Missing row / unknown tier → 1
-- (trial). Archived workspaces don't count — a user at the cap can
-- archive one and create another.
create or replace function create_workspace(
  p_name text,
  p_industry_key text default null,
  p_industry_display text default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid;
  v_name text := nullif(btrim(p_name), '');
  v_tier text;
  v_cap  int;
  v_count int;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated.' using errcode = '28000';
  end if;
  if v_name is null then
    raise exception 'Workspace name is required.' using errcode = '22023';
  end if;

  -- NOTE: only `tier` — this repo's schema has no plan_key column on
  -- subscriptions (the org-keyed legacy writer's plan_key is documented
  -- drift, CLAUDE.md §16).
  select lower(coalesce(tier, ''))
    into v_tier
    from subscriptions
   where user_id = auth.uid()
   limit 1;

  -- Keep in sync with _pricing_config max_workspaces + the mirror in
  -- _plan_state.max_workspaces_for (SQL is the hard floor).
  v_cap := case v_tier
             when 'solo'       then 1
             when 'pro'        then 5
             when 'multi'      then 5
             when 'starter'    then 5
             when 'pro_legacy' then 5
             else 1
           end;

  select count(*)
    into v_count
    from memberships m
    join organizations o on o.id = m.org_id
   where m.user_id = auth.uid()
     and o.archived_at is null;

  if v_count >= v_cap then
    raise exception
      'workspace_cap_reached: your % plan allows % workspace(s). Upgrade to add more.',
      coalesce(nullif(v_tier, ''), 'trial'), v_cap
      using errcode = 'P0001';
  end if;

  insert into organizations (name, industry_key, industry_display_name)
  values (v_name, p_industry_key, p_industry_display)
  returning id into v_org_id;

  insert into memberships (user_id, org_id, role)
  values (auth.uid(), v_org_id, 'owner');

  return v_org_id;
end;
$$;

-- Grant unchanged from schema_phase_multi_workspace.sql (idempotent —
-- re-asserted so this file stands alone after a restore).
grant execute on function create_workspace(text, text, text) to authenticated;

-- F3.24 schema-migration discipline: optimistic PostgREST reload. The
-- Dashboard "Reload schema cache" click (runbook step 2) is the
-- deterministic action on Supabase managed infrastructure.
NOTIFY pgrst, 'reload schema';
