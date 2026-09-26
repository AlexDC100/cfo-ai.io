-- document_quota_ledger — what the plan has COUNTED, per document, where the
-- browser cannot write it.
-- =============================================================================
-- WHY (verifier lens S, 2026-09-21)
--   Whether a (re-)run of a document is metered was decided from
--   `documents.status`. Every column of `documents` is browser-writable (RLS
--   is_member_of(org_id), no column restriction) and — worse — the status of
--   a COUNTED book goes back to `failed` when a free correction re-run of it
--   fails (the re-run has already deleted its period). The next /retry, the
--   failed banner's /run, or a re-upload of the same bytes then took the book
--   for its FIRST analysis: reserved, committed, uploads + 1 — and at the
--   plan cap the €-dialog opened and the terminal billed a PAID EXTRA for a
--   book the plan had already counted.
--
-- WHAT THIS ADDS
--   document_quota_ledger — one row per document the quota meter has touched:
--     committed_at  set by the pipeline's settlement when the document was
--                   COUNTED (commit_user_upload). A document — or any live
--                   copy of the same book (company, uploader, content,
--                   scope, period) — with committed_at set is never metered,
--                   committed or billed again.
--     reserved_at   an OUTSTANDING reservation of this document's slot
--                   (reserve_user_upload / reserve_user_upload_extra), with
--                   its `reservation_id`, `was_extra`, `month`, the engine
--                   process that holds it (`owner`) and that process's
--                   `heartbeat_at`. It used to live only in the engine's
--                   memory: a deploy restart mid-run lost it and the slot
--                   stayed in user_usage.uploads_reserved — counted against
--                   the cap — for the rest of the month (lens S, S8). Now
--                   the document's next run ADOPTS it, and a reservation
--                   whose owner stopped heartbeating is released (the
--                   engine's sweep, scripts/recompute_document_quota.py).
--     nonro_*       the same for the non-RO meter's reservation.
--     settling_at   THE MARK BEFORE THE MOVE (P1 RESTART, second shape,
--                   2026-09-26). A settlement is two writes — the meter RPC
--                   and this row's record. A record that failed followed by
--                   a restart left a row reading "reserved" for a meter that
--                   had already moved, and the sweep settled the finished
--                   analysis as a commit AGAIN (a paid extra billed twice).
--                   The engine now stamps settling_at (compare-and-set on
--                   reservation_id) before every commit / release RPC; a row
--                   reserved + settling + not committed is "the meter may
--                   already have moved": never released, committed, adopted
--                   or metered again by the engine — listed by
--                   scripts/recompute_document_quota.py for a human. Retired
--                   once commit_user_upload takes p_document_id and writes
--                   this row in the same statement.
--   Backfill: every document analysed before this table existed is taken to
--   have been counted (the meter counted analysed documents; a re-run of an
--   analysed document was already a free correction).
--
-- ACCESS MODEL
--   Service role only. RLS is enabled with no policies and every privilege
--   is revoked from anon / authenticated: the browser can neither read nor
--   write it. Only the engine (service role) records a settlement.
--
-- DEPLOY (CLAUDE.md §14 schema-migration discipline)
--   1. Run this file in Supabase Studio BEFORE the engine that reads it.
--   2. Click Settings → API → "Reload schema cache".
--   3. Verify: scripts/_pgrst_visibility.verify_pgrst_visibility(ac,
--      'document_quota_ledger', 'committed_at').
--   An engine without the table degrades to the status rule (logged ERROR
--   on every read) — it never 500s, but the defect above is back.
--
-- Idempotent: safe to re-run.

set search_path = public;

create table if not exists document_quota_ledger (
  -- ON DELETE CASCADE: a document hard-deleted (the Recently-deleted shelf
  -- emptied, a workspace purge, an account deletion) takes its row with it;
  -- a soft delete keeps it (a deleted copy is no longer an original, and a
  -- re-upload after it is counted again — the live gate's rule).
  document_id   uuid primary key references documents(id) on delete cascade,
  -- The verified user the reservation was made for / the count charged to.
  user_id       uuid not null,
  -- The user_usage month bucket (YYYY-MM, UTC) of the reservation.
  month         text not null,
  was_extra     boolean not null default false,
  committed_at  timestamptz,
  -- The outstanding reservation (null = none).
  reservation_id     text,
  reserved_at        timestamptz,
  released_at        timestamptz,
  release_token      text,
  owner              text,
  heartbeat_at       timestamptz,
  settling_at        timestamptz,
  nonro_user_id      uuid,
  nonro_was_extra    boolean not null default false,
  nonro_month        text,
  nonro_reserved_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- A database that carries the table from before the mark existed.
alter table document_quota_ledger add column if not exists settling_at timestamptz;

create index if not exists document_quota_ledger_outstanding_idx
  on document_quota_ledger (heartbeat_at)
  where reserved_at is not null;

create index if not exists document_quota_ledger_user_committed_idx
  on document_quota_ledger (user_id)
  where committed_at is not null;

alter table document_quota_ledger enable row level security;
-- No policies on purpose. The service role bypasses RLS.
revoke all on document_quota_ledger from anon, authenticated;

-- ── Backfill: documents analysed before the ledger existed ─────────────────
-- An archived duplicate (deleted + `duplicate_of:` marker) was never counted.
insert into document_quota_ledger (document_id, user_id, month, committed_at)
select d.id,
       d.uploaded_by,
       to_char(d.created_at at time zone 'utc', 'YYYY-MM'),
       d.created_at
  from documents d
 where d.status = 'analyzed'
   and d.uploaded_by is not null
   and not (d.deleted_at is not null and coalesce(d.error, '') like 'duplicate_of:%')
on conflict (document_id) do nothing;

-- ─────────────────────────────────────────────────────────────────────
-- F3.24 — invalidate PostgREST schema cache after schema change. The
-- Dashboard "Reload schema cache" click is the deterministic step.
-- ─────────────────────────────────────────────────────────────────────
NOTIFY pgrst, 'reload schema';
