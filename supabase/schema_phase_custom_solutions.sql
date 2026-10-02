-- Custom solutions — per-account access to bespoke workspaces built on top of
-- CFO AI, and the first one: AutoMasters (the CFO side of the AutoMasters
-- dealership app — Ferrari București, Bitton FR Holdings).
--
-- Two halves:
--
--   1. ACCESS. `custom_solutions` is the catalogue (one row per bespoke
--      solution, AutoMasters seeded below); `custom_solution_grants` links an
--      ACCOUNT (auth user) to a solution. Grants are written ONLY by the
--      engine's admin endpoints (`/api/admin/custom-solutions/*`, service
--      role, gated on the verified user id against the admin allowlist) —
--      there is deliberately no client INSERT/UPDATE/DELETE policy. A user
--      reads their own grants, which is all the frontend needs to show or
--      hide a solution. `has_solution(key)` is the one predicate every
--      solution table's RLS calls.
--
--   2. AUTOMASTERS DATA. Org-scoped tables (one CFO AI workspace = the
--      dealership's company) holding what the AutoMasters desktop app (or a
--      JSON import, until it is wired) sends: bank statement lines, open
--      documents, SAGA / e-Factura export items, monthly profit-centre
--      figures, the sales funnel, and the month-close state the CFO side
--      owns. Every policy is `am_can(org_id)` = workspace member AND holds
--      the `automasters` grant, so revoking the grant hides the data without
--      touching it.
--
-- The month close is the one place a rule is enforced in the database rather
-- than the UI: `am_close_period()` refuses while a checklist item is open or a
-- profit centre's DMS ↔ ledger difference is material (> 0.5%), and a closed
-- period's checklist cannot be edited (trigger). A blocked action must stay
-- blocked even for a client that skips the screen.
--
-- ── OPERATOR RUNBOOK (locked discipline — §14 / F3.24) ────────────────
-- 1. Apply schema_phase3.sql + schema_phase_multi_workspace.sql FIRST
--    (organizations, memberships, is_member_of live there).
-- 2. Run this SQL in Supabase Studio (includes the NOTIFY at the bottom).
-- 3. IMMEDIATELY click Supabase Dashboard → Settings → API →
--    "Reload schema cache".
-- 4. Verify PostgREST sees it — each must NOT 400:
--      select key, name from custom_solutions limit 1;
--      select solution_key, user_id from custom_solution_grants limit 1;
--      select org_id, period, centre from am_centre_figures limit 1;
-- 5. Set PLATFORM_ADMIN_USER_IDS (comma-separated auth user ids) on the
--    engine host — PRICING_ADMIN_USER_IDS is also honoured — then rebuild
--    the backend per §14. Without it nobody can link accounts.
-- Idempotent: safe to re-run.
-- ─────────────────────────────────────────────────────────────────────

-- ─────────── 1. Access ─────────────────────────────────────────────────────

create table if not exists custom_solutions (
  key         text primary key check (key ~ '^[a-z0-9][a-z0-9_-]{1,39}$'),
  name        text not null,
  description text,
  created_at  timestamptz not null default now()
);

insert into custom_solutions (key, name, description) values (
  'automasters',
  'AutoMasters',
  'Finance and management for the AutoMasters dealership (Ferrari București): payments reconciliation, SAGA and e-Factura exports, month close, dealer performance, profit centres and Ask CFO AI.'
)
on conflict (key) do update
  set name = excluded.name, description = excluded.description;

create table if not exists custom_solution_grants (
  solution_key text not null references custom_solutions(key) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  granted_by   uuid references auth.users(id) on delete set null,
  granted_at   timestamptz not null default now(),
  note         text check (note is null or length(note) <= 200),
  primary key (solution_key, user_id)
);

create index if not exists custom_solution_grants_user_idx
  on custom_solution_grants (user_id);

-- Reads custom_solution_grants inside a SECURITY DEFINER function rather than
-- a policy subquery, the same way is_member_of reads memberships.
create or replace function has_solution(_key text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from custom_solution_grants
    where solution_key = _key and user_id = auth.uid()
  );
$$;

alter table custom_solutions enable row level security;
alter table custom_solution_grants enable row level security;

drop policy if exists "custom_solutions granted select" on custom_solutions;
create policy "custom_solutions granted select"
  on custom_solutions for select using (has_solution(key));

drop policy if exists "custom_solution_grants own select" on custom_solution_grants;
create policy "custom_solution_grants own select"
  on custom_solution_grants for select using (user_id = auth.uid());

-- Admin lookups for the engine (service role only). auth.users is not exposed
-- through PostgREST, so linking an account by e-mail goes through these.
create or replace function admin_find_user_by_email(_email text)
returns table (id uuid, email text)
language sql
stable
security definer
set search_path = public, auth
as $$
  select u.id, u.email::text
  from auth.users u
  where lower(u.email) = lower(trim(_email))
  limit 1;
$$;

create or replace function admin_user_emails(_ids uuid[])
returns table (id uuid, email text)
language sql
stable
security definer
set search_path = public, auth
as $$
  select u.id, u.email::text from auth.users u where u.id = any(_ids);
$$;

-- ─────────── 2. AutoMasters data ───────────────────────────────────────────

create or replace function am_can(_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select is_member_of(_org_id) and has_solution('automasters');
$$;

-- Bank statement lines waiting to be matched to a document.
create table if not exists am_bank_lines (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations(id) on delete cascade,
  external_ref  text not null,
  booked_on     date not null,
  payer         text not null,
  reference     text,
  amount        numeric(14,2) not null,
  currency      text not null default 'EUR',
  -- The DMS's own guess at the document this payment settles (doc number).
  suggested_document text,
  created_at    timestamptz not null default now(),
  unique (org_id, external_ref)
);

-- Open receivable documents (final invoices, advances, service, deposits).
create table if not exists am_documents (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  doc_number  text not null,
  customer    text not null,
  kind        text not null default 'other'
              check (kind in ('final','advance','service','deposit','other')),
  amount      numeric(14,2) not null,
  currency    text not null default 'EUR',
  issued_on   date,
  created_at  timestamptz not null default now(),
  unique (org_id, doc_number)
);

-- A payment matched to a document. One payment ↔ one document; a non-zero
-- difference is booked as an accounting note by Finance.
create table if not exists am_payment_matches (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations(id) on delete cascade,
  bank_line_id  uuid not null unique references am_bank_lines(id) on delete cascade,
  document_id   uuid not null unique references am_documents(id) on delete cascade,
  difference    numeric(14,2) not null default 0,
  method        text not null default 'manual' check (method in ('manual','auto')),
  matched_by    uuid default auth.uid() references auth.users(id) on delete set null,
  matched_at    timestamptz not null default now()
);

-- A match may only pair a payment and a document of its own workspace.
create or replace function am_payment_match_same_org()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if not exists (select 1 from am_bank_lines where id = new.bank_line_id and org_id = new.org_id)
     or not exists (select 1 from am_documents where id = new.document_id and org_id = new.org_id) then
    raise exception 'payment and document must belong to the match''s workspace';
  end if;
  return new;
end;
$$;

drop trigger if exists am_payment_match_same_org on am_payment_matches;
create trigger am_payment_match_same_org
  before insert or update on am_payment_matches
  for each row execute function am_payment_match_same_org();

-- SAGA batches and RO e-Factura documents as the DMS reports them.
create table if not exists am_export_items (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organizations(id) on delete cascade,
  channel        text not null check (channel in ('saga','efactura')),
  ref            text not null,
  description    text,
  counterparty   text,
  doc_count      integer not null default 1 check (doc_count >= 0),
  amount         numeric(14,2) not null default 0,
  currency       text not null default 'EUR',
  status         text not null default 'pending'
                 check (status in ('pending','sent','accepted','error','rejected','reconciled')),
  error_message  text,
  -- [{ "at": ISO-8601, "text": "…" }] in time order.
  events         jsonb not null default '[]'::jsonb,
  retry_requested_at timestamptz,
  retry_requested_by uuid references auth.users(id) on delete set null,
  updated_at     timestamptz not null default now(),
  unique (org_id, channel, ref)
);

-- Monthly figures per profit centre. revenue / margin drive the profit-centre
-- and performance screens; dms_amount / ledger_amount (the DMS total vs what
-- SAGA booked) drive the month-close reconciliation.
create table if not exists am_centre_figures (
  org_id         uuid not null references organizations(id) on delete cascade,
  period         text not null check (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  centre         text not null check (length(centre) between 1 and 60),
  revenue        numeric(14,2) not null default 0,
  margin         numeric(14,2) not null default 0,
  budget_margin  numeric(14,2),
  dms_amount     numeric(14,2),
  ledger_amount  numeric(14,2),
  note           text,
  -- [{ "name": "SF90 Stradale (9 VIN)", "value": 412600 }]
  contributors   jsonb not null default '[]'::jsonb,
  updated_at     timestamptz not null default now(),
  primary key (org_id, period, centre)
);

-- Sales funnel counts per month (lead → delivery).
create table if not exists am_funnel (
  org_id    uuid not null references organizations(id) on delete cascade,
  period    text not null check (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  stage     text not null check (length(stage) between 1 and 60),
  position  integer not null default 0,
  count     integer not null default 0 check (count >= 0),
  primary key (org_id, period, stage)
);

-- Month close: one row per (workspace, month) + its checklist.
create table if not exists am_close_periods (
  org_id     uuid not null references organizations(id) on delete cascade,
  period     text not null check (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  status     text not null default 'open' check (status in ('open','closed')),
  closed_by  uuid references auth.users(id) on delete set null,
  closed_at  timestamptz,
  created_at timestamptz not null default now(),
  primary key (org_id, period)
);

create table if not exists am_close_checks (
  org_id     uuid not null,
  period     text not null,
  check_key  text not null check (check_key ~ '^[a-z0-9_]{1,40}$'),
  position   integer not null default 0,
  done       boolean not null default false,
  done_by    uuid references auth.users(id) on delete set null,
  done_at    timestamptz,
  primary key (org_id, period, check_key),
  foreign key (org_id, period) references am_close_periods(org_id, period) on delete cascade
);

-- A closed month's checklist is frozen.
create or replace function am_close_checks_frozen()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  _org uuid := coalesce(new.org_id, old.org_id);
  _per text := coalesce(new.period, old.period);
begin
  if exists (select 1 from am_close_periods
             where org_id = _org and period = _per and status = 'closed') then
    raise exception 'month % is closed; its checklist cannot change', _per;
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists am_close_checks_frozen on am_close_checks;
create trigger am_close_checks_frozen
  before insert or update or delete on am_close_checks
  for each row execute function am_close_checks_frozen();

-- Close a month. Refuses with a reason instead of raising, so the screen can
-- show it: { ok: true } | { ok: false, reason: 'not_found'|'already_closed'|
-- 'open_checks'|'material_difference', detail }.
create or replace function am_close_period(_org_id uuid, _period text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  _status text;
  _open int;
  _material text[];
begin
  if not am_can(_org_id) then
    raise exception 'not allowed';
  end if;

  select status into _status from am_close_periods
   where org_id = _org_id and period = _period for update;
  if _status is null then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if _status = 'closed' then
    return jsonb_build_object('ok', false, 'reason', 'already_closed');
  end if;

  select count(*) into _open from am_close_checks
   where org_id = _org_id and period = _period and not done;
  if _open > 0 then
    return jsonb_build_object('ok', false, 'reason', 'open_checks', 'detail', _open);
  end if;

  -- Material = |DMS − ledger| above 0.5% of the DMS amount (any difference
  -- at all when the DMS amount is zero). Same rule as the screen.
  select array_agg(centre order by centre) into _material
    from am_centre_figures
   where org_id = _org_id and period = _period
     and dms_amount is not null and ledger_amount is not null
     and dms_amount <> ledger_amount
     and (dms_amount = 0
          or abs(dms_amount - ledger_amount) / abs(dms_amount) > 0.005);
  if _material is not null then
    return jsonb_build_object('ok', false, 'reason', 'material_difference',
                              'detail', to_jsonb(_material));
  end if;

  update am_close_periods
     set status = 'closed', closed_by = auth.uid(), closed_at = now()
   where org_id = _org_id and period = _period;
  return jsonb_build_object('ok', true);
end;
$$;

-- Ask the DMS to resend an export item that failed (error / rejected). The
-- DMS picks up items with retry_requested_at set; the status itself is the
-- DMS's to change.
create or replace function am_request_export_retry(_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  _row am_export_items%rowtype;
begin
  select * into _row from am_export_items where id = _id for update;
  if _row.id is null or not am_can(_row.org_id) then
    raise exception 'not allowed';
  end if;
  if _row.status not in ('error','rejected') then
    return jsonb_build_object('ok', false, 'reason', 'not_failed');
  end if;
  update am_export_items
     set retry_requested_at = now(),
         retry_requested_by = auth.uid(),
         events = events || jsonb_build_array(jsonb_build_object(
           'at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
           'text', 'retry_requested')),
         updated_at = now()
   where id = _id;
  return jsonb_build_object('ok', true);
end;
$$;

-- ─────────── 3. RLS on the AutoMasters tables ──────────────────────────────

do $$
declare
  t text;
begin
  foreach t in array array['am_bank_lines','am_documents','am_payment_matches',
                           'am_export_items','am_centre_figures','am_funnel',
                           'am_close_checks']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists "%s member select" on %I', t, t);
    execute format('drop policy if exists "%s member insert" on %I', t, t);
    execute format('drop policy if exists "%s member update" on %I', t, t);
    execute format('drop policy if exists "%s member delete" on %I', t, t);
    execute format('create policy "%s member select" on %I for select using (am_can(org_id))', t, t);
    execute format('create policy "%s member insert" on %I for insert with check (am_can(org_id))', t, t);
    execute format('create policy "%s member update" on %I for update using (am_can(org_id)) with check (am_can(org_id))', t, t);
    execute format('create policy "%s member delete" on %I for delete using (am_can(org_id))', t, t);
  end loop;
end $$;

-- A month may be opened (insert, status 'open') by a member; it is closed
-- only through am_close_period and never edited or deleted by a client.
alter table am_close_periods enable row level security;
drop policy if exists "am_close_periods member select" on am_close_periods;
drop policy if exists "am_close_periods member insert" on am_close_periods;
create policy "am_close_periods member select"
  on am_close_periods for select using (am_can(org_id));
create policy "am_close_periods member insert"
  on am_close_periods for insert
  with check (am_can(org_id) and status = 'open' and closed_at is null and closed_by is null);

-- ─────────── 4. Grants ─────────────────────────────────────────────────────

revoke execute on function public.has_solution(text)                 from public, anon;
revoke execute on function public.am_can(uuid)                       from public, anon;
revoke execute on function public.am_close_period(uuid, text)        from public, anon;
revoke execute on function public.am_request_export_retry(uuid)      from public, anon;
revoke execute on function public.admin_find_user_by_email(text)     from public, anon, authenticated;
revoke execute on function public.admin_user_emails(uuid[])          from public, anon, authenticated;

grant execute on function public.has_solution(text)                  to authenticated;
grant execute on function public.am_can(uuid)                        to authenticated;
grant execute on function public.am_close_period(uuid, text)         to authenticated;
grant execute on function public.am_request_export_retry(uuid)       to authenticated;
grant execute on function public.admin_find_user_by_email(text)      to service_role;
grant execute on function public.admin_user_emails(uuid[])           to service_role;

revoke all on custom_solutions, custom_solution_grants from anon;
revoke all on am_bank_lines, am_documents, am_payment_matches, am_export_items,
              am_centre_figures, am_funnel, am_close_periods, am_close_checks
  from anon;

NOTIFY pgrst, 'reload schema';
