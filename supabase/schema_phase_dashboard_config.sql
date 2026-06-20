-- F6.0.4 (2026-06-20) — Per-user configurable dashboard layout.
--
-- Stores each user's metric-card layout so it follows them across
-- devices. The frontend (src/stores/dashboard.tsx) is localStorage-
-- primary and treats this table as a progressive enhancement: until
-- this migration is applied + the backend endpoint deployed, the
-- feature works device-locally; once live, layouts sync to the account.
--
-- ── OPERATOR RUNBOOK (locked discipline — F3.24 / §14) ───────────────
-- 1. Run this SQL in Supabase Studio (includes the NOTIFY at the bottom).
-- 2. IMMEDIATELY click Supabase Dashboard → Settings → API →
--    "Reload schema cache". The NOTIFY is optimistic on Supabase managed
--    infra; the Dashboard click is the deterministic step.
-- 3. If the column/table stays invisible to PostgREST (400 Bad Request
--    on explicit selects), this is the F3.25 Bug #4 persistent-cache
--    case — do NOT push the backend endpoint through; wait for the
--    Supabase support resolution. The frontend keeps working on
--    localStorage in the meantime (no user-facing breakage).
-- ─────────────────────────────────────────────────────────────────────

create table if not exists dashboard_configs (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  cards       jsonb not null default '[]'::jsonb,
  updated_at  timestamptz not null default now()
);

alter table dashboard_configs enable row level security;

-- A user reads only their own row.
drop policy if exists "dashboard_configs own_select" on dashboard_configs;
create policy "dashboard_configs own_select"
  on dashboard_configs for select
  using (user_id = auth.uid());

-- A user updates only their own row.
drop policy if exists "dashboard_configs own_update" on dashboard_configs;
create policy "dashboard_configs own_update"
  on dashboard_configs for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Inserts go through the service-role backend (which scopes user_id from
-- the verified JWT), so allow insert at the policy layer; the API never
-- accepts a client-supplied user_id.
drop policy if exists "dashboard_configs service_insert" on dashboard_configs;
create policy "dashboard_configs service_insert"
  on dashboard_configs for insert
  with check (true);

-- Upsert RPC (service role) — single round-trip put.
create or replace function upsert_dashboard_config(
  p_user_id uuid,
  p_cards   jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cards jsonb;
begin
  insert into dashboard_configs (user_id, cards, updated_at)
  values (p_user_id, p_cards, now())
  on conflict (user_id) do update
    set cards = excluded.cards,
        updated_at = now()
  returning cards into v_cards;
  return v_cards;
end;
$$;

-- F3.24 schema-migration discipline: optimistic PostgREST reload.
NOTIFY pgrst, 'reload schema';
