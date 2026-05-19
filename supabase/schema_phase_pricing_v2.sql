-- Pricing V2 — additive schema for the new tier model.
--
-- WHAT THIS MIGRATION ADDS
-- ========================
-- Three minimal, additive columns on `subscriptions` for the per-user
-- plan-state fields the new pricing spec needs:
--   · intro_unlock_expiry      timestamptz   — when the €0.99 7-day
--                                              window ends (NULL for
--                                              starter/pro/trial)
--   · extra_docs_billed_period int           — running tally of paid
--                                              extras in the current
--                                              monthly window
--   · billing_period_anchor    date          — the day-of-month the
--                                              quota resets on
--
-- Plus ONE new tiny table for the daily chat cap:
--   · plan_chat_daily_usage(user_id, day, count)
--
-- The existing `user_usage(user_id, month, llm_calls, uploads, ...)`
-- table already carries monthly counters — we reuse it. Daily caps
-- need a separate row keyed on (user_id, day).
--
-- WHAT THIS DOES NOT TOUCH
-- ========================
-- · `subscriptions.tier` still stores the legacy strings
--   (solo/business/professional) — pricing_config.legacy_tier_map
--   maps them to the new keys at read time. No destructive rename.
-- · The analysis pipeline. The canonical metric object. The engine.
--   Parsing. Bug A. Anything fenced by the spec.
--
-- RLS — `plan_chat_daily_usage` is tenant data; rows are scoped to the
-- caller's own user_id (auth.uid()). The admin client (service role)
-- writes counters via an RPC like the existing `increment_user_usage`.

set search_path = public;

-- ───────────────────────────────────────────────────────────────────────
-- 1. subscriptions — add 3 nullable columns (additive, idempotent)
-- ───────────────────────────────────────────────────────────────────────
alter table if exists subscriptions
  add column if not exists intro_unlock_expiry      timestamptz,
  add column if not exists extra_docs_billed_period int not null default 0,
  add column if not exists billing_period_anchor    date;

-- ───────────────────────────────────────────────────────────────────────
-- 2. plan_chat_daily_usage — one row per (user, day) for the daily cap
-- ───────────────────────────────────────────────────────────────────────
create table if not exists plan_chat_daily_usage (
  user_id     uuid not null,
  day         date not null,
  count       int  not null default 0,
  updated_at  timestamptz not null default now(),
  primary key (user_id, day)
);

create index if not exists plan_chat_daily_usage_user_idx on plan_chat_daily_usage (user_id);

-- ───────────────────────────────────────────────────────────────────────
-- RLS — own-row read; writes through the service role only
-- ───────────────────────────────────────────────────────────────────────
alter table plan_chat_daily_usage enable row level security;

drop policy if exists "plan_chat_daily_usage_own_select" on plan_chat_daily_usage;
create policy "plan_chat_daily_usage_own_select"
  on plan_chat_daily_usage for select
  using (user_id = auth.uid());

-- No write policy on purpose — counter bumps go through the admin
-- client (service role) via the RPC below, never through user JWTs.

-- ───────────────────────────────────────────────────────────────────────
-- RPC — atomic upsert+increment for the daily chat counter
-- ───────────────────────────────────────────────────────────────────────
-- Mirrors the shape of the existing `increment_user_usage` RPC so the
-- Python client doesn't need a new code path — just a different RPC name.
create or replace function increment_plan_chat_daily(
  p_user_id uuid,
  p_day     date,
  p_amount  int
) returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_new_count int;
begin
  insert into plan_chat_daily_usage (user_id, day, count, updated_at)
  values (p_user_id, p_day, p_amount, now())
  on conflict (user_id, day) do update
    set count = plan_chat_daily_usage.count + excluded.count,
        updated_at = now()
  returning count into v_new_count;
  return v_new_count;
end;
$$;

-- End of migration.
