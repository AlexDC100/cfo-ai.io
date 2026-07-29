-- Ask CFO AI chat history — persisted per workspace.
--
-- Two things converge here.
--
-- 1. The FRONTEND store (frontend/components/cfo/chat/useChatStore.ts) kept
--    every conversation in localStorage under `cfo-ai-chat-history-v1`, so
--    chats died with the browser profile and never followed the user to
--    another device.
--
-- 2. The BACKEND has been writing to `chat_threads` / `chat_messages` since
--    the Ask endpoint shipped (src/engine/api/ask.py — _ensure_thread,
--    _append_user_message, _append_assistant_message, GET /api/ask/threads),
--    but NO migration ever created those tables. Every insert is wrapped in
--    `except Exception: logger.debug("... table may not exist yet")`, so the
--    writes have been failing silently this whole time.
--
-- This migration creates the tables the backend already expects, with the
-- extra columns the frontend store needs, so both paths write to one place.
-- Column names follow ask.py exactly (`active_period_id`, `tokens_input`,
-- `tokens_output`, `thread_id`) — renaming them would re-break the backend.
--
-- Chats are scoped to a WORKSPACE (org_id) and to the USER who had the
-- conversation: switching companies shows that company's chats, and a
-- colleague in the same workspace never reads your conversations.
--
-- ── OPERATOR RUNBOOK (locked discipline — §14 / F3.24) ────────────────
-- 1. Apply supabase/schema_phase_multi_workspace.sql FIRST — this file
--    depends on organizations + is_member_of().
-- 2. Run this SQL in Supabase Studio (includes the NOTIFY at the bottom).
-- 3. IMMEDIATELY click Supabase Dashboard → Settings → API →
--    "Reload schema cache".
-- 4. Verify PostgREST sees them — these must NOT 400:
--      select id, org_id, user_id, title, active_period_label from chat_threads limit 1;
--      select id, thread_id, role, grounded_period, attachments from chat_messages limit 1;
-- ─────────────────────────────────────────────────────────────────────

create table if not exists chat_threads (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references organizations(id) on delete cascade,
  user_id             uuid not null references auth.users(id) on delete cascade,
  title               text not null default 'New conversation',
  -- Period the conversation is grounded in. TEXT, not a FK to
  -- financial_periods: test mode uses synthetic period ids, and a chat
  -- should survive its period being deleted rather than vanish with it.
  active_period_id    text,
  active_period_label text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- Sidebar query: this user's threads in this workspace, newest first.
create index if not exists chat_threads_scope_idx
  on chat_threads (org_id, user_id, updated_at desc);

drop trigger if exists chat_threads_set_updated_at on chat_threads;
create trigger chat_threads_set_updated_at
  before update on chat_threads
  for each row execute function set_updated_at_now();

create table if not exists chat_messages (
  id              uuid primary key default gen_random_uuid(),
  thread_id       uuid not null references chat_threads(id) on delete cascade,
  role            text not null check (role in ('user', 'assistant')),
  content         text not null default '',
  -- Which period the answer was grounded in when it was produced, so a
  -- reopened conversation can still say what the numbers referred to.
  grounded_period text,
  attachments     jsonb,
  tokens_input    int not null default 0,
  tokens_output   int not null default 0,
  created_at      timestamptz not null default now()
);

create index if not exists chat_messages_thread_idx
  on chat_messages (thread_id, created_at asc);

-- ─────────── RLS ───────────────────────────────────────────────────────────

alter table chat_threads  enable row level security;
alter table chat_messages enable row level security;

-- A thread is visible to its author, inside a workspace they belong to.
-- Both conditions matter: is_member_of alone would expose one teammate's
-- conversations to another once teams land.
drop policy if exists "chat_threads own select" on chat_threads;
drop policy if exists "chat_threads own insert" on chat_threads;
drop policy if exists "chat_threads own update" on chat_threads;
drop policy if exists "chat_threads own delete" on chat_threads;

create policy "chat_threads own select"
  on chat_threads for select
  using (user_id = auth.uid() and is_member_of(org_id));
create policy "chat_threads own insert"
  on chat_threads for insert
  with check (user_id = auth.uid() and is_member_of(org_id));
create policy "chat_threads own update"
  on chat_threads for update
  using (user_id = auth.uid() and is_member_of(org_id))
  with check (user_id = auth.uid() and is_member_of(org_id));
create policy "chat_threads own delete"
  on chat_threads for delete
  using (user_id = auth.uid() and is_member_of(org_id));

-- Messages inherit their thread's visibility — the child-table pattern used
-- by statement_line_items (schema_phase3.sql:266).
drop policy if exists "chat_messages via thread select" on chat_messages;
drop policy if exists "chat_messages via thread insert" on chat_messages;
drop policy if exists "chat_messages via thread update" on chat_messages;
drop policy if exists "chat_messages via thread delete" on chat_messages;

create policy "chat_messages via thread select"
  on chat_messages for select
  using (exists (
    select 1 from chat_threads t
    where t.id = thread_id and t.user_id = auth.uid() and is_member_of(t.org_id)
  ));
create policy "chat_messages via thread insert"
  on chat_messages for insert
  with check (exists (
    select 1 from chat_threads t
    where t.id = thread_id and t.user_id = auth.uid() and is_member_of(t.org_id)
  ));
create policy "chat_messages via thread update"
  on chat_messages for update
  using (exists (
    select 1 from chat_threads t
    where t.id = thread_id and t.user_id = auth.uid() and is_member_of(t.org_id)
  ));
create policy "chat_messages via thread delete"
  on chat_messages for delete
  using (exists (
    select 1 from chat_threads t
    where t.id = thread_id and t.user_id = auth.uid() and is_member_of(t.org_id)
  ));

-- F3.24 schema-migration discipline: optimistic PostgREST reload.
NOTIFY pgrst, 'reload schema';
