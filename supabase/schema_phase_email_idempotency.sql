-- ─────────────────────────────────────────────────────────────────────────────
-- schema_phase_email_idempotency.sql — one renewal reminder per
-- (subscription, template, renewal date), enforced by the database.
--
-- WHY. POST /api/billing/cron/renewal-reminders had no idempotency marker
-- (its docstring claimed one): every run queued another reminder. The engine
-- now reads the queue before it writes (`_billing._renewal_already_queued`),
-- which closes the re-run, the retry and the manual second call. It cannot
-- close two runs that OVERLAP — both read an empty queue, both insert. This
-- index is the lock for that case: the second insert is refused with 23505,
-- which `_billing.send_founder_renewal_reminders` counts as "already queued".
-- Gate: scheduled-mail-tenancy (tests/engine/test_scheduled_mail_renewals.py
-- ::test_two_interleaved_renewal_runs_queue_one_reminder).
--
-- The engine works WITHOUT this migration (read-before-write) and with it
-- (the index); apply it before a scheduler is pointed at the cron.
--
-- OPERATOR RUNBOOK
--   1. PRE-FLIGHT — must return ZERO rows, or the index cannot be built.
--      Any row it returns is a reminder the old cron queued more than once;
--      keep the oldest of each group and delete the rest, then re-run it.
--
--        select subscription_id, template, payload->'vars'->>'renewal_date' as renewal_date,
--               count(*)
--          from renewal_email_queue
--         where subscription_id is not null
--         group by 1, 2, 3
--        having count(*) > 1;
--
--   2. Run this file in Supabase Studio.
--   3. Click "Reload schema cache" (Dashboard → Settings → API) — CLAUDE.md
--      §14; an index adds no column, the click is the discipline.
--   4. Verify:
--        select indexname from pg_indexes
--         where tablename = 'renewal_email_queue'
--           and indexname = 'renewal_email_queue_dedupe_uidx';
--
-- Idempotent: `create unique index if not exists`. No table, column, policy
-- or grant changes. Rollback: drop index if exists renewal_email_queue_dedupe_uidx;
-- ─────────────────────────────────────────────────────────────────────────────

create unique index if not exists renewal_email_queue_dedupe_uidx
  on renewal_email_queue (subscription_id, template, ((payload -> 'vars' ->> 'renewal_date')))
  where subscription_id is not null;

-- Required by the locked schema-migration discipline. The Dashboard
-- "Reload schema cache" click is the deterministic step on Supabase.
NOTIFY pgrst, 'reload schema';
