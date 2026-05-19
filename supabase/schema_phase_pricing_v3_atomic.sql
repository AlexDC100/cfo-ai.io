-- Pricing V3 — atomic reserve / commit / release for documents + chat.
--
-- WHY THIS MIGRATION EXISTS
-- =========================
-- Gap C of the refined spec: the "check docs_used < limit, then
-- increment" sequence MUST be atomic. The Pricing V2 implementation
-- did a read-then-write through PostgREST which is RACE-PRONE — two
-- concurrent uploads near the quota boundary could both pass the
-- check before either incremented.
--
-- Gap D of the refined spec: quota is consumed / extra-doc is billed
-- only on successful completion of analysis. A document that fails
-- parsing or pipeline error must not consume a slot. This requires a
-- reservation model: reserve a slot atomically up-front, then either
-- commit (success → counts toward the user's quota and is billed) or
-- release (failure → reservation evaporates, no quota consumed, no
-- charge).
--
-- WHAT'S ADDED
-- ============
-- · user_usage.uploads_reserved        int default 0
-- · user_usage.llm_calls_reserved      int default 0
-- · plan_chat_daily_usage.reserved     int default 0
-- · subscriptions.extra_docs_pending   int default 0  (pending extras)
--
-- · reserve_user_upload(uid, month, cap)      → atomic guarded reserve
-- · commit_user_upload(uid, month)            → reserve→consumed move
-- · release_user_upload(uid, month)           → drop a reservation
-- · reserve_user_chat(uid, month, day, daily_cap, monthly_cap)
--                                              → atomic dual-cap reserve
-- · commit_user_chat(uid, month, day)          → reserve→consumed move
-- · release_user_chat(uid, month, day)         → drop a reservation
--
-- All RPCs are SECURITY DEFINER and granted to service_role only —
-- the Python admin client invokes them; user JWTs cannot.
--
-- DESIGN NOTE — why a reservation model and not a single transaction?
-- The pipeline is async: HTTP request returns 202 immediately and the
-- analysis runs on a daemon thread. We can't hold a DB transaction
-- across the full analysis (could be 30+ seconds) — connection holds
-- + transaction-time amplify lock contention. Reservation gives us
-- atomicity at the right grain: the "do you have room?" decision is
-- a single atomic UPDATE, and the "did it succeed?" decision arrives
-- later as a separate atomic UPDATE.

set search_path = public;

-- ───────────────────────────────────────────────────────────────────────
-- 1. user_usage — add reservation columns (additive, idempotent)
-- ───────────────────────────────────────────────────────────────────────
alter table if exists user_usage
  add column if not exists uploads_reserved   int not null default 0,
  add column if not exists llm_calls_reserved int not null default 0;

-- Guards — reservations can never go negative. Belt-and-braces; the
-- RPC bodies below enforce this too, but a check constraint is the
-- last line of defence.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'user_usage_uploads_reserved_nonneg') then
    alter table user_usage
      add constraint user_usage_uploads_reserved_nonneg check (uploads_reserved >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'user_usage_llm_reserved_nonneg') then
    alter table user_usage
      add constraint user_usage_llm_reserved_nonneg check (llm_calls_reserved >= 0);
  end if;
end$$;

-- ───────────────────────────────────────────────────────────────────────
-- 2. plan_chat_daily_usage — add reservation column
-- ───────────────────────────────────────────────────────────────────────
alter table if exists plan_chat_daily_usage
  add column if not exists reserved int not null default 0;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'plan_chat_daily_reserved_nonneg') then
    alter table plan_chat_daily_usage
      add constraint plan_chat_daily_reserved_nonneg check (reserved >= 0);
  end if;
end$$;

-- ───────────────────────────────────────────────────────────────────────
-- 3. documents — flag for "this run was a metered extra"
-- ───────────────────────────────────────────────────────────────────────
-- The pipeline's analyze entry point calls reserve_document() and
-- gets back a DocReserveDecision. If was_extra=True, we need the
-- orchestrator's daemon thread (which has no HTTP context) to know
-- whether the eventual commit should bump extra_docs_billed_period
-- (gap D — bill only on success). Persist the flag onto the
-- document row so the daemon recovers it from disk.
alter table if exists documents
  add column if not exists metered_extra boolean not null default false;

-- ───────────────────────────────────────────────────────────────────────
-- 4. subscriptions — pending extras tally (separate from billed)
-- ───────────────────────────────────────────────────────────────────────
-- `extra_docs_billed_period` (Pricing V2) is incremented on user CONFIRM
-- but before analysis succeeds. With gap D, we need a separate tally
-- for "reserved an extra slot but the analysis is still running" so
-- the FE can show "pending extras" distinct from "billed extras".
alter table if exists subscriptions
  add column if not exists extra_docs_pending int not null default 0;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'subscriptions_extra_docs_pending_nonneg') then
    alter table subscriptions
      add constraint subscriptions_extra_docs_pending_nonneg check (extra_docs_pending >= 0);
  end if;
end$$;


-- ═══════════════════════════════════════════════════════════════════════
-- ATOMIC RPCs — uploads
-- ═══════════════════════════════════════════════════════════════════════

-- reserve_user_upload — atomic check-and-reserve for a document slot.
--
-- Returns jsonb { kind, used, reserved, cap, total } where `kind` is:
--   · 'allowed'                 — reservation created, caller may proceed
--   · 'extra_required'          — over base cap; caller must surface
--                                 the extra-doc confirm dialog. NO
--                                 reservation made — the caller has to
--                                 re-call after explicit confirm.
--   · 'blocked'                 — over cap AND no extra-doc path
--                                 (trial / intro). NO reservation made.
--
-- The reservation increment is the body of an atomic UPDATE with a
-- WHERE guard — two concurrent calls at the boundary cannot both
-- succeed. The INSERT-on-conflict pattern ensures the row exists
-- without a separate read first.
create or replace function reserve_user_upload(
  p_user_id     uuid,
  p_month       text,
  p_base_cap    int,      -- included docs for the plan
  p_allow_extra boolean   -- true for starter/pro; false for trial/intro
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_used     int;
  v_reserved int;
begin
  -- Make sure a row exists for this (user, month) so the UPDATE below
  -- always has a target. This is a no-op if the row is already there.
  insert into user_usage (user_id, month, uploads, uploads_reserved)
       values (p_user_id, p_month, 0, 0)
  on conflict (user_id, month) do nothing;

  -- Atomic guarded reserve. The WHERE clause is the gap-C atomicity
  -- guarantee: Postgres MVCC + the row lock acquired by UPDATE
  -- serialize concurrent attempts. Only the call that finds
  -- (used + reserved) < cap "wins" and increments; the loser sees 0
  -- rows updated and the RETURNING values stay null.
  update user_usage
     set uploads_reserved = uploads_reserved + 1
   where user_id = p_user_id
     and month   = p_month
     and (uploads + uploads_reserved) < p_base_cap
  returning uploads, uploads_reserved
       into v_used, v_reserved;

  if v_used is not null then
    return jsonb_build_object(
      'kind',     'allowed',
      'used',     v_used,
      'reserved', v_reserved,
      'cap',      p_base_cap,
      'total',    v_used + v_reserved
    );
  end if;

  -- Over cap. Read the current state for the response payload (no
  -- update — we didn't reserve anything).
  select uploads, uploads_reserved
    into v_used, v_reserved
    from user_usage
   where user_id = p_user_id and month = p_month;

  if not p_allow_extra then
    return jsonb_build_object(
      'kind',     'blocked',
      'used',     coalesce(v_used, 0),
      'reserved', coalesce(v_reserved, 0),
      'cap',      p_base_cap,
      'total',    coalesce(v_used, 0) + coalesce(v_reserved, 0)
    );
  end if;

  return jsonb_build_object(
    'kind',     'extra_required',
    'used',     coalesce(v_used, 0),
    'reserved', coalesce(v_reserved, 0),
    'cap',      p_base_cap,
    'total',    coalesce(v_used, 0) + coalesce(v_reserved, 0)
  );
end;
$$;

-- reserve_user_upload_extra — caller has already shown the user the
-- extra-doc confirm dialog and got explicit consent. Reserves a slot
-- ABOVE the base cap (no cap guard — pricing config decides the cost
-- of going over, server enforces nothing further at this layer).
-- Also bumps subscriptions.extra_docs_pending so the FE can show
-- "1 extra pending" while the analysis is running.
create or replace function reserve_user_upload_extra(
  p_user_id uuid,
  p_month   text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_used     int;
  v_reserved int;
begin
  insert into user_usage (user_id, month, uploads, uploads_reserved)
       values (p_user_id, p_month, 0, 1)
  on conflict (user_id, month) do update
       set uploads_reserved = user_usage.uploads_reserved + 1
   returning uploads, uploads_reserved
        into v_used, v_reserved;

  update subscriptions
     set extra_docs_pending = extra_docs_pending + 1
   where user_id = p_user_id;

  return jsonb_build_object(
    'kind',     'extra_reserved',
    'used',     v_used,
    'reserved', v_reserved,
    'total',    v_used + v_reserved
  );
end;
$$;

-- commit_user_upload — convert ONE reservation into a consumed slot.
-- Called when the pipeline reports analysis success. The
-- `p_was_extra` flag flips whether to bump subscriptions.
-- extra_docs_billed_period (gap D — bill only on success).
create or replace function commit_user_upload(
  p_user_id    uuid,
  p_month      text,
  p_was_extra  boolean
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_used     int;
  v_reserved int;
begin
  update user_usage
     set uploads          = uploads + 1,
         uploads_reserved = greatest(uploads_reserved - 1, 0)
   where user_id = p_user_id
     and month   = p_month
  returning uploads, uploads_reserved
       into v_used, v_reserved;

  if p_was_extra then
    update subscriptions
       set extra_docs_billed_period = extra_docs_billed_period + 1,
           extra_docs_pending       = greatest(extra_docs_pending - 1, 0)
     where user_id = p_user_id;
  end if;

  return jsonb_build_object(
    'used',     coalesce(v_used, 0),
    'reserved', coalesce(v_reserved, 0)
  );
end;
$$;

-- release_user_upload — drop a reservation without consuming. Called
-- when the pipeline reports analysis failure (gap D — no quota
-- consumed). Idempotent: floors at 0 so a double-release can't
-- underflow.
create or replace function release_user_upload(
  p_user_id   uuid,
  p_month     text,
  p_was_extra boolean
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_used     int;
  v_reserved int;
begin
  update user_usage
     set uploads_reserved = greatest(uploads_reserved - 1, 0)
   where user_id = p_user_id
     and month   = p_month
  returning uploads, uploads_reserved
       into v_used, v_reserved;

  if p_was_extra then
    update subscriptions
       set extra_docs_pending = greatest(extra_docs_pending - 1, 0)
     where user_id = p_user_id;
  end if;

  return jsonb_build_object(
    'used',     coalesce(v_used, 0),
    'reserved', coalesce(v_reserved, 0)
  );
end;
$$;


-- ═══════════════════════════════════════════════════════════════════════
-- ATOMIC RPCs — chat
-- ═══════════════════════════════════════════════════════════════════════

-- reserve_user_chat — atomic dual-cap reserve. Checks BOTH the daily
-- and monthly counters at once and reserves a slot only if BOTH are
-- under their cap. Returns the kind { 'allowed' | 'daily_cap_reached'
-- | 'monthly_cap_reached' }. The two-table reservation is wrapped in
-- a single transactional block so concurrent calls can't both pass.
create or replace function reserve_user_chat(
  p_user_id    uuid,
  p_month      text,
  p_day        date,
  p_daily_cap  int,     -- null = unlimited (not used by any tier today)
  p_monthly_cap int     -- null = unlimited
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_month_used     int;
  v_month_reserved int;
  v_day_used       int;
  v_day_reserved   int;
begin
  -- Ensure rows exist for both counters.
  insert into user_usage (user_id, month, llm_calls, llm_calls_reserved)
       values (p_user_id, p_month, 0, 0)
  on conflict (user_id, month) do nothing;

  insert into plan_chat_daily_usage (user_id, day, count, reserved)
       values (p_user_id, p_day, 0, 0)
  on conflict (user_id, day) do nothing;

  -- Lock both rows (FOR UPDATE) before deciding. This is the gap-C
  -- atomicity guarantee: two concurrent calls serialize on the lock.
  select llm_calls, llm_calls_reserved
    into v_month_used, v_month_reserved
    from user_usage
   where user_id = p_user_id and month = p_month
     for update;

  select count, reserved
    into v_day_used, v_day_reserved
    from plan_chat_daily_usage
   where user_id = p_user_id and day = p_day
     for update;

  -- Daily cap check
  if p_daily_cap is not null
     and (v_day_used + v_day_reserved) >= p_daily_cap then
    return jsonb_build_object(
      'kind',         'daily_cap_reached',
      'daily_used',   v_day_used,
      'daily_cap',    p_daily_cap,
      'monthly_used', v_month_used,
      'monthly_cap',  p_monthly_cap
    );
  end if;

  -- Monthly cap check
  if p_monthly_cap is not null
     and (v_month_used + v_month_reserved) >= p_monthly_cap then
    return jsonb_build_object(
      'kind',         'monthly_cap_reached',
      'daily_used',   v_day_used,
      'daily_cap',    p_daily_cap,
      'monthly_used', v_month_used,
      'monthly_cap',  p_monthly_cap
    );
  end if;

  -- Both clear — reserve in both counters atomically. The FOR UPDATE
  -- above already serialized other callers; this UPDATE is a free move.
  update user_usage
     set llm_calls_reserved = llm_calls_reserved + 1
   where user_id = p_user_id and month = p_month;

  update plan_chat_daily_usage
     set reserved   = reserved + 1,
         updated_at = now()
   where user_id = p_user_id and day = p_day;

  return jsonb_build_object(
    'kind',         'allowed',
    'daily_used',   v_day_used,
    'daily_cap',    p_daily_cap,
    'monthly_used', v_month_used,
    'monthly_cap',  p_monthly_cap
  );
end;
$$;

-- commit_user_chat — reserve→consumed move for one chat message.
-- Called when the Opus stream completes successfully.
create or replace function commit_user_chat(
  p_user_id uuid,
  p_month   text,
  p_day     date
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  update user_usage
     set llm_calls          = llm_calls + 1,
         llm_calls_reserved = greatest(llm_calls_reserved - 1, 0)
   where user_id = p_user_id and month = p_month;

  update plan_chat_daily_usage
     set count      = count + 1,
         reserved   = greatest(reserved - 1, 0),
         updated_at = now()
   where user_id = p_user_id and day = p_day;

  return jsonb_build_object('ok', true);
end;
$$;

-- release_user_chat — drop a reservation. Called when the Opus stream
-- errors before producing a complete response (gap D — optional
-- principle applied to chat).
create or replace function release_user_chat(
  p_user_id uuid,
  p_month   text,
  p_day     date
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  update user_usage
     set llm_calls_reserved = greatest(llm_calls_reserved - 1, 0)
   where user_id = p_user_id and month = p_month;

  update plan_chat_daily_usage
     set reserved   = greatest(reserved - 1, 0),
         updated_at = now()
   where user_id = p_user_id and day = p_day;

  return jsonb_build_object('ok', true);
end;
$$;


-- ═══════════════════════════════════════════════════════════════════════
-- GRANTS — service-role only for every RPC
-- ═══════════════════════════════════════════════════════════════════════
revoke all on function reserve_user_upload(uuid, text, int, boolean)         from public, anon, authenticated;
revoke all on function reserve_user_upload_extra(uuid, text)                 from public, anon, authenticated;
revoke all on function commit_user_upload(uuid, text, boolean)               from public, anon, authenticated;
revoke all on function release_user_upload(uuid, text, boolean)              from public, anon, authenticated;
revoke all on function reserve_user_chat(uuid, text, date, int, int)         from public, anon, authenticated;
revoke all on function commit_user_chat(uuid, text, date)                    from public, anon, authenticated;
revoke all on function release_user_chat(uuid, text, date)                   from public, anon, authenticated;

grant execute on function reserve_user_upload(uuid, text, int, boolean)         to service_role;
grant execute on function reserve_user_upload_extra(uuid, text)                 to service_role;
grant execute on function commit_user_upload(uuid, text, boolean)               to service_role;
grant execute on function release_user_upload(uuid, text, boolean)              to service_role;
grant execute on function reserve_user_chat(uuid, text, date, int, int)         to service_role;
grant execute on function commit_user_chat(uuid, text, date)                    to service_role;
grant execute on function release_user_chat(uuid, text, date)                   to service_role;

-- End of migration.
