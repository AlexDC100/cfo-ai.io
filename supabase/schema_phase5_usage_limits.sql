-- ============================================================================
-- Phase 5 — Final pricing schema: Solo/Business/Professional + usage limits +
-- founding-member counter + contact-sales leads.
--
-- Additive migration. Does not break existing rows: the legacy `plan` column
-- stays valid and existing values are mapped onto the new `tier` column by
-- the backfill below.
--
-- Apply order: AFTER schema.sql + any earlier phaseN migrations.
-- Reversal: copy-paste the DROP block at the bottom.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Extend `subscriptions` with the new tier model
-- ---------------------------------------------------------------------------

alter table subscriptions
  add column if not exists tier text
    check (tier in (
      -- New 3-tier model (Pro is contact-sales, stored as 'professional')
      'solo', 'business', 'professional',
      -- Legacy plan values kept valid so existing rows don't break CHECK
      'starter', 'professional_legacy_marker_unused', 'enterprise'
    ));

alter table subscriptions
  add column if not exists is_founding_member boolean not null default false;

-- Per-customer custom limits — only populated for Pro contracts. Solo and
-- Business read from the static TIERS config in code.
alter table subscriptions
  add column if not exists custom_limits jsonb;

-- Extend status enum to include the founding-trial state without breaking
-- existing rows. PostgREST accepts text comparisons against an updated
-- CHECK constraint; we drop & recreate it.
alter table subscriptions drop constraint if exists subscriptions_status_check;
alter table subscriptions
  add constraint subscriptions_status_check
    check (status in (
      'founding_trial', 'trial', 'active', 'past_due', 'canceled', 'incomplete', 'expired'
    ));

-- Backfill `tier` from the legacy `plan` column. Mapping:
--   starter      → solo
--   professional → business
--   enterprise   → professional (the contact-sales tier)
update subscriptions
set tier = case
  when plan = 'starter' then 'solo'
  when plan = 'professional' then 'business'
  when plan = 'enterprise' then 'professional'
  else 'solo'
end
where tier is null;

-- ---------------------------------------------------------------------------
-- 2. user_usage — per-user, per-calendar-month counters
-- ---------------------------------------------------------------------------

create table if not exists user_usage (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  month text not null,  -- 'YYYY-MM' (UTC)

  uploads integer not null default 0,
  llm_calls integer not null default 0,
  exports integer not null default 0,
  storage_bytes bigint not null default 0,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique(user_id, month)
);

create index if not exists user_usage_lookup_idx on user_usage(user_id, month);
create index if not exists user_usage_month_idx on user_usage(month);

drop trigger if exists user_usage_set_updated_at on user_usage;
create trigger user_usage_set_updated_at
  before update on user_usage
  for each row execute function set_updated_at_now();

alter table user_usage enable row level security;
drop policy if exists "users_see_own_usage" on user_usage;
create policy "users_see_own_usage" on user_usage
  for select using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- 3. founding_members — DB-backed 500-seat counter
-- ---------------------------------------------------------------------------
-- Honest scarcity. Every successful €1 founding charge inserts a row;
-- `founding_member_count` derives `remaining` from `500 - count(*)`.

create table if not exists founding_members (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  claimed_at timestamptz not null default now(),
  tier text not null check (tier in ('solo', 'business')),
  stripe_subscription_id text,
  unique(stripe_subscription_id)
);

create index if not exists founding_members_claimed_idx on founding_members(claimed_at);

alter table founding_members enable row level security;
-- No SELECT/INSERT policy for end users; only the service-role backend
-- writes rows here. The public `founding_member_count` view (below) is
-- granted SELECT to anon so the pricing page can read `remaining`.

create or replace view founding_member_count as
select
  count(*)::int                  as claimed,
  greatest(0, 500 - count(*))::int as remaining,
  500                            as cap
from founding_members;

grant select on founding_member_count to authenticated, anon;

-- ---------------------------------------------------------------------------
-- 4. contact_sales_leads — Pro inquiry inbox
-- ---------------------------------------------------------------------------

create table if not exists contact_sales_leads (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null,
  company text,
  role text,
  num_companies text,           -- '1-3' / '4-10' / '11-25' / '26+'
  use_case text,
  preferred_contact text default 'email'
    check (preferred_contact in ('email', 'phone', 'video_call')),
  phone text,
  source text default 'pricing_page',
  status text default 'new'
    check (status in ('new', 'contacted', 'qualified', 'won', 'lost')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists contact_sales_leads_status_idx on contact_sales_leads(status, created_at desc);

drop trigger if exists contact_sales_leads_set_updated_at on contact_sales_leads;
create trigger contact_sales_leads_set_updated_at
  before update on contact_sales_leads
  for each row execute function set_updated_at_now();

alter table contact_sales_leads enable row level security;
-- Service-role-only: end users never read this table directly. The form
-- POSTs to the backend, which writes via the admin client.

-- ---------------------------------------------------------------------------
-- 5. current_user_usage view — join active sub + current-month usage
-- ---------------------------------------------------------------------------

create or replace view current_user_usage as
select
  s.user_id,
  s.tier,
  s.status as subscription_status,
  s.is_founding_member,
  s.custom_limits,
  s.trial_end,
  s.current_period_end,
  to_char(now() at time zone 'utc', 'YYYY-MM') as current_month,
  coalesce(u.uploads, 0)       as uploads_used,
  coalesce(u.llm_calls, 0)     as llm_calls_used,
  coalesce(u.exports, 0)       as exports_used,
  coalesce(u.storage_bytes, 0) as storage_bytes_used
from subscriptions s
left join user_usage u
  on u.user_id = s.user_id
 and u.month = to_char(now() at time zone 'utc', 'YYYY-MM');

grant select on current_user_usage to authenticated, anon;

-- ---------------------------------------------------------------------------
-- 6. increment_user_usage(user_id, month, action, amount) — atomic counter
-- ---------------------------------------------------------------------------

create or replace function increment_user_usage(
  p_user_id uuid,
  p_month text,
  p_action text,
  p_amount integer default 1
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  new_val integer;
begin
  if p_action not in ('uploads', 'llm_calls', 'exports', 'storage_bytes') then
    raise exception 'increment_user_usage: invalid action %', p_action;
  end if;

  if p_action = 'uploads' then
    insert into user_usage (user_id, month, uploads) values (p_user_id, p_month, p_amount)
      on conflict (user_id, month) do update set uploads = user_usage.uploads + p_amount
      returning uploads into new_val;
  elsif p_action = 'llm_calls' then
    insert into user_usage (user_id, month, llm_calls) values (p_user_id, p_month, p_amount)
      on conflict (user_id, month) do update set llm_calls = user_usage.llm_calls + p_amount
      returning llm_calls into new_val;
  elsif p_action = 'exports' then
    insert into user_usage (user_id, month, exports) values (p_user_id, p_month, p_amount)
      on conflict (user_id, month) do update set exports = user_usage.exports + p_amount
      returning exports into new_val;
  else
    insert into user_usage (user_id, month, storage_bytes) values (p_user_id, p_month, p_amount)
      on conflict (user_id, month) do update set storage_bytes = user_usage.storage_bytes + p_amount
      returning storage_bytes into new_val;
  end if;

  return new_val;
end;
$$;

revoke all on function increment_user_usage(uuid, text, text, integer) from public, anon, authenticated;
grant execute on function increment_user_usage(uuid, text, text, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 7. claim_founding_seat(user_id, tier, stripe_sub_id) — atomic 500-cap claim
-- ---------------------------------------------------------------------------
-- Inserts a founding_members row only if `remaining > 0`. Returns the new
-- `remaining` count, or NULL if no seats left. Caller (the Stripe webhook
-- handler) reads the return to decide whether the founding €1 actually
-- applied.

create or replace function claim_founding_seat(
  p_user_id uuid,
  p_tier text,
  p_stripe_subscription_id text
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  current_count integer;
  remaining integer;
begin
  if p_tier not in ('solo', 'business') then
    return null;
  end if;
  -- Lock the table so two parallel webhooks can't both insert seat 500.
  lock table founding_members in exclusive mode;
  select count(*) into current_count from founding_members;
  if current_count >= 500 then
    return null;
  end if;
  insert into founding_members (user_id, tier, stripe_subscription_id)
  values (p_user_id, p_tier, p_stripe_subscription_id)
  on conflict (stripe_subscription_id) do nothing;
  select count(*) into current_count from founding_members;
  remaining := greatest(0, 500 - current_count);
  return remaining;
end;
$$;

revoke all on function claim_founding_seat(uuid, text, text) from public, anon, authenticated;
grant execute on function claim_founding_seat(uuid, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- Reversal (don't auto-run; copy-paste manually if you need to back out):
-- ---------------------------------------------------------------------------
--
--   drop function if exists claim_founding_seat(uuid, text, text);
--   drop function if exists increment_user_usage(uuid, text, text, integer);
--   drop view if exists current_user_usage;
--   drop view if exists founding_member_count;
--   drop table if exists contact_sales_leads;
--   drop table if exists founding_members;
--   drop table if exists user_usage;
--   alter table subscriptions drop column if exists custom_limits;
--   alter table subscriptions drop column if exists is_founding_member;
--   alter table subscriptions drop column if exists tier;
--   alter table subscriptions drop constraint if exists subscriptions_status_check;
--   alter table subscriptions
--     add constraint subscriptions_status_check
--       check (status in ('trial','active','past_due','canceled','incomplete'));
--
-- ---------------------------------------------------------------------------
