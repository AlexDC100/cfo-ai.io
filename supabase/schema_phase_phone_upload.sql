-- ── Upload portal: send files from a phone into any upload section ──────────
--
-- NOT APPLIED. Written on branch `upload-portal` (2026-10-07); the owner
-- applies it by hand. Apply AFTER schema_phase_multi_workspace.sql (it reads
-- `organizations` and `is_member_of`).
--
-- Ported from DocVex's phone upload (docvex migrations 040 + 041, Edge
-- Function `phone-upload`). Every upload section of the web app on a PC
-- (the workspace drop zone, the year tile, Products' sales file, the budget
-- card, the chat attach, …) gets an "Upload from phone" portal: a QR code the
-- phone scans. Two routes:
--
--   Local network — the engine (FastAPI) itself serves the phone page and
--                   receives the files; nothing touches Supabase. Only when
--                   the engine runs on the user's own machine
--                   (src/engine/api/_phone_upload.py, PHONE_UPLOAD_LOCAL=1).
--   Cloud         — THIS migration. The phone is not signed in: it holds a
--                   random TOKEN (in the QR code; only its SHA-256 is stored)
--                   and the `phone-upload` Edge Function (service role) hands
--                   it a signed upload URL per file. The PC, signed in as the
--                   session's owner, hears each file (Realtime + a poll),
--                   downloads it, deletes the object at once (the bucket is a
--                   hand-off, not a store) and records its decision
--                   (imported / rejected) on the row, which the phone reads
--                   back through the function.
--
-- END-TO-END ENCRYPTED: the phone seals every file (AES-256-GCM, name and
-- type inside) with a key that exists only in the QR code's URL FRAGMENT. The
-- bucket, the rows and the function only ever see ciphertext; rows are
-- written with name "encrypted".
--
--   phone_upload_sessions   one per portal (owner, workspace, token hash, expiry)
--   phone_upload_files      one per file received; outlives the hand-off to
--                           carry the decision back to the phone
--   phone-upload (bucket)   <session id>/<random id> — private, 50 MB a file
--
-- Operator runbook (CLAUDE.md §14, schema-migration discipline):
--   1. Run this file in Supabase Studio (it ends with NOTIFY pgrst).
--   2. Dashboard → Settings → API → "Reload schema cache".
--   3. Deploy the function:
--        supabase functions deploy phone-upload --project-ref <ref> --use-api --no-verify-jwt
--      (verify_jwt OFF: the phone has no JWT; `create` / `close` verify the
--      caller's JWT themselves.)
--   4. Optional: schedule the hourly sweep (bottom of this file).
-- Restrict-only toward existing data: creates two tables, one bucket, one
-- helper function and their policies. No existing row or table is touched.

create table if not exists public.phone_upload_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- The workspace (organization) the portal was opened in. Informational —
  -- the files go to whatever upload section the PC had open; nullable for
  -- surfaces with no workspace (the chat attach before one exists).
  org_id uuid references public.organizations (id) on delete cascade,
  -- Which upload section opened it ("workspace", "products", "budget", …):
  -- shown on the phone page so the user knows where the files go.
  surface text not null default '',
  -- Only a HASH of the token: the token exists only in the QR code, so a
  -- leak or a backup of this table gives no way to upload.
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  closed_at timestamptz,
  file_count int not null default 0,
  byte_count bigint not null default 0
);
create index if not exists phone_upload_sessions_user_idx
  on public.phone_upload_sessions (user_id, created_at desc);

create table if not exists public.phone_upload_files (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.phone_upload_sessions (id) on delete cascade,
  path text not null,              -- the object in the bucket
  name text not null,              -- "encrypted" for a sealed file
  size bigint not null default 0,
  mime text,
  status text not null default 'waiting',
  taken_at timestamptz,            -- the PC downloaded it (object deleted)
  decided_at timestamptz,          -- the PC imported or rejected it
  created_at timestamptz not null default now(),
  constraint phone_upload_files_status_chk check (status in ('waiting', 'accepted', 'rejected'))
);
create index if not exists phone_upload_files_session_idx
  on public.phone_upload_files (session_id);

alter table public.phone_upload_sessions enable row level security;
alter table public.phone_upload_files enable row level security;

-- ── Grants: rows are WRITTEN by the function (service role) only ──────────
-- Supabase hands every new table ALL to anon/authenticated by default (§29).
-- The owner reads, deletes a session, and on a file sets ONLY the three
-- columns that carry the hand-off and the decision.
revoke all on public.phone_upload_sessions from anon, public;
revoke all on public.phone_upload_files    from anon, public;
revoke insert, update, delete, truncate on public.phone_upload_sessions from authenticated;
revoke insert, update, delete, truncate on public.phone_upload_files    from authenticated;
grant select, delete on public.phone_upload_sessions to authenticated;
grant select on public.phone_upload_files to authenticated;
grant update (status, taken_at, decided_at) on public.phone_upload_files to authenticated;

drop policy if exists "phone upload: owner reads sessions" on public.phone_upload_sessions;
create policy "phone upload: owner reads sessions"
  on public.phone_upload_sessions for select to authenticated
  using (user_id = auth.uid());

drop policy if exists "phone upload: owner deletes sessions" on public.phone_upload_sessions;
create policy "phone upload: owner deletes sessions"
  on public.phone_upload_sessions for delete to authenticated
  using (user_id = auth.uid());

drop policy if exists "phone upload: owner reads files" on public.phone_upload_files;
create policy "phone upload: owner reads files"
  on public.phone_upload_files for select to authenticated
  using (exists (
    select 1 from public.phone_upload_sessions s
    where s.id = session_id and s.user_id = auth.uid()
  ));

drop policy if exists "phone upload: owner updates files" on public.phone_upload_files;
create policy "phone upload: owner updates files"
  on public.phone_upload_files for update to authenticated
  using (exists (
    select 1 from public.phone_upload_sessions s
    where s.id = session_id and s.user_id = auth.uid()
  ))
  with check (exists (
    select 1 from public.phone_upload_sessions s
    where s.id = session_id and s.user_id = auth.uid()
  ));

-- The PC is told of each file as it lands.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'phone_upload_files'
  ) then
    alter publication supabase_realtime add table public.phone_upload_files;
  end if;
end $$;

-- ── The bucket ───────────────────────────────────────────────────────────────
insert into storage.buckets (id, name, public, file_size_limit)
values ('phone-upload', 'phone-upload', false, 52428800)
on conflict (id) do update set public = false, file_size_limit = 52428800;

-- An object's first path segment is its session. The session's owner may
-- read and delete it; uploads come only through the function's signed URLs.
create or replace function public.phone_upload_owner(object_name text)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select s.user_id from public.phone_upload_sessions s
  where (storage.foldername(object_name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and s.id = ((storage.foldername(object_name))[1])::uuid
$$;
revoke execute on function public.phone_upload_owner(text) from public, anon;
grant execute on function public.phone_upload_owner(text) to authenticated;

drop policy if exists "phone upload: owner reads objects" on storage.objects;
create policy "phone upload: owner reads objects"
  on storage.objects for select to authenticated
  using (bucket_id = 'phone-upload' and public.phone_upload_owner(name) = auth.uid());

drop policy if exists "phone upload: owner deletes objects" on storage.objects;
create policy "phone upload: owner deletes objects"
  on storage.objects for delete to authenticated
  using (bucket_id = 'phone-upload' and public.phone_upload_owner(name) = auth.uid());

-- ── Optional: the hourly sweep ─────────────────────────────────────────────
-- Sessions a day past their end lose their leftover objects and rows on the
-- owner's next `create` anyway; the sweep makes it happen without them. Needs
-- pg_cron + pg_net and the function deployed. Uncomment and fill the ref:
--
-- select cron.schedule('phone-upload-sweep', '17 * * * *', $cron$
--   select net.http_post(
--     url := 'https://<project-ref>.supabase.co/functions/v1/phone-upload',
--     headers := '{"content-type":"application/json"}'::jsonb,
--     body := '{"action":"sweep"}'::jsonb
--   );
-- $cron$);

-- F3.24 schema-migration discipline: optimistic PostgREST reload.
NOTIFY pgrst, 'reload schema';
