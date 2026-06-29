-- ───────────────────────────────────────────────────────────────────────────
-- schema_phase_newsletter.sql
--
-- Email feature (Resend-backed). Adds:
--   1. newsletter_subscribers   — double opt-in mailing list
--   2. email_send_log           — audit trail of every app-sent email
--   3. newsletter_broadcasts    — admin-composed broadcast campaigns
--   4. renewal_email_queue      — drain target for billing renewal reminders
--                                 (columns match _billing.send_founder_renewal_reminders)
--
-- All four are written by the backend via the SERVICE-ROLE client, which
-- bypasses RLS. RLS is still enabled (deny-by-default) so nothing leaks to
-- anon / per-user clients except a subscriber's own row.
--
-- Idempotent: safe to re-run. Ends with the PostgREST schema-reload NOTIFY
-- per the locked schema-migration discipline (also click "Reload schema
-- cache" in Supabase → Settings → API after applying).
-- ───────────────────────────────────────────────────────────────────────────

-- 1. newsletter_subscribers ─────────────────────────────────────────────────
create table if not exists newsletter_subscribers (
  id                 uuid primary key default gen_random_uuid(),
  email              text not null,
  status             text not null default 'pending'
                       check (status in ('pending', 'confirmed', 'unsubscribed')),
  confirm_token      uuid not null default gen_random_uuid(),
  unsubscribe_token  uuid not null default gen_random_uuid(),
  user_id            uuid references auth.users (id) on delete set null,
  source             text,
  created_at         timestamptz not null default now(),
  confirmed_at       timestamptz,
  unsubscribed_at    timestamptz
);

-- One row per email address, case-insensitive. Upserts target this index.
create unique index if not exists newsletter_subscribers_email_uidx
  on newsletter_subscribers (lower(email));
create index if not exists newsletter_subscribers_status_idx
  on newsletter_subscribers (status);
create index if not exists newsletter_subscribers_confirm_token_idx
  on newsletter_subscribers (confirm_token);
create index if not exists newsletter_subscribers_unsub_token_idx
  on newsletter_subscribers (unsubscribe_token);

alter table newsletter_subscribers enable row level security;

-- A signed-in user may read their own subscription row (the Settings page
-- shows their current status). All writes go through the service-role
-- backend; there is no anon insert/update policy on purpose.
drop policy if exists "newsletter_subscribers_self_select" on newsletter_subscribers;
create policy "newsletter_subscribers_self_select"
  on newsletter_subscribers for select
  using (user_id = auth.uid());

-- 2. email_send_log ─────────────────────────────────────────────────────────
create table if not exists email_send_log (
  id           uuid primary key default gen_random_uuid(),
  to_email     text not null,
  kind         text not null,         -- newsletter_confirm | newsletter_welcome
                                       -- | newsletter_broadcast | renewal_reminder
  subject      text,
  provider_id  text,                  -- Resend message id
  status       text not null default 'sent'
                 check (status in ('sent', 'failed', 'skipped')),
  error        text,
  meta         jsonb,
  created_at   timestamptz not null default now()
);
create index if not exists email_send_log_to_idx      on email_send_log (lower(to_email));
create index if not exists email_send_log_kind_idx    on email_send_log (kind);
create index if not exists email_send_log_created_idx on email_send_log (created_at desc);

alter table email_send_log enable row level security;
-- No policies: service-role only (deny-by-default for anon / per-user).

-- 3. newsletter_broadcasts ──────────────────────────────────────────────────
create table if not exists newsletter_broadcasts (
  id            uuid primary key default gen_random_uuid(),
  heading       text not null,
  subject       text not null,
  content_html  text not null,
  sent_by       uuid references auth.users (id) on delete set null,
  recipient_count int not null default 0,
  sent_count    int not null default 0,
  failed_count  int not null default 0,
  status        text not null default 'sent'
                  check (status in ('sent', 'partial', 'failed', 'skipped')),
  created_at    timestamptz not null default now()
);
create index if not exists newsletter_broadcasts_created_idx
  on newsletter_broadcasts (created_at desc);

alter table newsletter_broadcasts enable row level security;
-- No policies: service-role only.

-- 4. renewal_email_queue ────────────────────────────────────────────────────
-- Columns match the insert in _billing.send_founder_renewal_reminders():
--   subscription_id, send_at, template, payload(jsonb), sent_at
-- Plus status/error so the drain can mark + retry failures.
create table if not exists renewal_email_queue (
  id               uuid primary key default gen_random_uuid(),
  subscription_id  uuid,
  send_at          timestamptz not null default now(),
  template         text,
  payload          jsonb not null default '{}'::jsonb,
  status           text not null default 'queued'
                     check (status in ('queued', 'sent', 'failed')),
  error            text,
  sent_at          timestamptz,
  created_at       timestamptz not null default now()
);
create index if not exists renewal_email_queue_pending_idx
  on renewal_email_queue (status, send_at) where sent_at is null;

alter table renewal_email_queue enable row level security;
-- No policies: service-role only.

-- Required by the locked schema-migration discipline. The Dashboard
-- "Reload schema cache" click is the deterministic step on Supabase.
NOTIFY pgrst, 'reload schema';
