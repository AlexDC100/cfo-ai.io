-- ─────────────────────────────────────────────────────────────────────────
-- FX rates — shared server-side cache for the `fx-rates` Edge Function
-- ─────────────────────────────────────────────────────────────────────────
--
-- Moves the FX feed off the Python engine (`src/engine/api/fx_rates.py`,
-- GET /api/fx-rates) and onto Supabase, so display-currency conversion keeps
-- working with `cfo-ai-backend` fully stopped — same reasoning as the
-- chat-llm migration (root CLAUDE.md, "Milestone D").
--
-- Why a table and not just an in-function cache: Edge Function instances are
-- ephemeral, so a process-local dict (what the Python engine used) would
-- refetch BNR on every cold start and could serve two users different rates
-- in the same minute. One row here means one BNR call serves everyone, the
-- last-known-good rate survives restarts, and a BNR outage degrades to a
-- real recent rate instead of the 2026-05 bundled constant.
--
-- The table holds exactly ONE row (id = 'current'). This is public reference
-- data (BNR publishes it openly) so anon/authenticated may SELECT; only the
-- service role — i.e. the Edge Function — may write.
--
-- OPERATOR RUNBOOK
--   1. Run this file in Supabase Studio (SQL editor).
--   2. Click "Reload schema cache" in Dashboard → Settings → API.
--      (Required on Supabase managed infra — the NOTIFY below is optimistic
--      only. See root CLAUDE.md "Schema-migration discipline".)
--   3. Deploy the function:
--        supabase functions deploy fx-rates \
--          --project-ref cjclenykwlngqvapmisb --use-api --no-verify-jwt
--   4. Probe:  curl "https://<ref>.supabase.co/functions/v1/fx-rates"
--      Expect source="BNR" and a 1-EUR-in-RON value near 5.0.
--
-- Idempotent: safe to re-run.

create table if not exists public.fx_rates_cache (
  -- Single-row table; the check constraint makes "there is only one current
  -- rate set" a schema guarantee rather than an Edge-Function convention.
  id          text primary key default 'current' check (id = 'current'),
  base        text        not null default 'EUR',
  -- { "EUR": 1.0, "RON": 5.2348, "USD": 1.0812 } — units per 1 unit of `base`.
  rates       jsonb       not null,
  -- 'BNR' today. Kept as free text so a future ECB/other feed doesn't need a
  -- migration to start writing here.
  source      text        not null,
  -- Publication date claimed by the upstream feed (NOT when we fetched it) —
  -- BNR publishes once per business day, so this is what "as of" means to a
  -- user reading the provenance line in Settings.
  as_of       date        not null,
  fetched_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.fx_rates_cache is
  'Single-row shared cache of BNR reference FX rates, written only by the fx-rates Edge Function.';

alter table public.fx_rates_cache enable row level security;

-- Public read: these are published central-bank reference rates, and the
-- landing/pricing surfaces render prices before a user signs in.
drop policy if exists "fx rates are world readable" on public.fx_rates_cache;
create policy "fx rates are world readable"
  on public.fx_rates_cache for select
  to anon, authenticated
  using (true);

-- No INSERT/UPDATE/DELETE policy on purpose: the service role bypasses RLS,
-- and nothing but the Edge Function should ever write a rate.

notify pgrst, 'reload schema';
