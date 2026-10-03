-- SCRATCH DATABASE BOOTSTRAP — LOCAL GATES ONLY. Never applied to a served
-- database (scripts/entitlement_holes/lib.sh runs it in a database it has
-- just created, and nowhere else).
--
-- The entitlement-hole gates (scripts/check_hole_*.sh) build a throw-away
-- database inside a LOCAL Supabase Postgres cluster and apply this
-- repository's supabase/*.sql to it. The cluster already holds Supabase's
-- roles (anon, authenticated, service_role, authenticator — roles are
-- cluster-wide). A database created empty holds none of the schemas GoTrue
-- and the storage API create in the served one. This file creates the
-- minimum the committed SQL needs in order to apply and to behave:
--
--   · schema `extensions` with pgcrypto / uuid-ossp;
--   · the DEFAULT PRIVILEGES Supabase sets on schema public — every new
--     table, function and sequence is granted to anon, authenticated and
--     service_role (taken from the image's own
--     /docker-entrypoint-initdb.d/init-scripts/00000000000000-initial-schema.sql).
--     This is the reason a table created without row level security is
--     writable with the anon key alone, and a function created without a
--     revoke is callable by anon;
--   · auth.users in GoTrue's column shape, and auth.uid() / auth.role() /
--     auth.jwt() / auth.email() reading the request.jwt.claims setting —
--     what PostgREST sets for a request;
--   · storage.buckets / storage.objects / storage.foldername() and the
--     `documents` bucket the storage policies hang on;
--   · the empty supabase_realtime publication schema_phase3.sql adds to.
--
-- It is NOT Supabase: no GoTrue, no PostgREST, no pg_graphql, no realtime.
-- The gates therefore test at the SQL level — `set local role authenticated`
-- plus request.jwt.claims, then the UPDATE a PATCH is and the function call
-- an RPC is — which is what PostgREST does with a request.

create schema if not exists extensions;
create extension if not exists "uuid-ossp" with schema extensions;
create extension if not exists pgcrypto    with schema extensions;
grant usage on schema extensions to postgres, anon, authenticated, service_role;

grant usage on schema public to postgres, anon, authenticated, service_role;
alter default privileges in schema public grant all on tables    to postgres, anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to postgres, anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to postgres, anon, authenticated, service_role;

-- ── auth ────────────────────────────────────────────────────────────────
create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;

create table if not exists auth.users (
  instance_id uuid,
  id uuid primary key,
  aud varchar(255),
  role varchar(255),
  email varchar(255),
  encrypted_password varchar(255),
  email_confirmed_at timestamptz,
  invited_at timestamptz,
  confirmation_token varchar(255),
  confirmation_sent_at timestamptz,
  recovery_token varchar(255),
  recovery_sent_at timestamptz,
  email_change_token_new varchar(255),
  email_change varchar(255),
  email_change_sent_at timestamptz,
  last_sign_in_at timestamptz,
  raw_app_meta_data jsonb,
  raw_user_meta_data jsonb,
  is_super_admin boolean,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  phone text,
  phone_confirmed_at timestamptz,
  phone_change text default '',
  phone_change_token varchar(255) default '',
  phone_change_sent_at timestamptz,
  confirmed_at timestamptz generated always as (least(email_confirmed_at, phone_confirmed_at)) stored,
  email_change_token_current varchar(255) default '',
  email_change_confirm_status smallint default 0,
  banned_until timestamptz,
  reauthentication_token varchar(255) default '',
  reauthentication_sent_at timestamptz,
  is_sso_user boolean not null default false,
  deleted_at timestamptz,
  is_anonymous boolean not null default false
);

create or replace function auth.uid() returns uuid language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;
create or replace function auth.role() returns text language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;
create or replace function auth.email() returns text language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.email', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email')
  )::text
$$;
create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')
  )::jsonb
$$;
grant execute on function auth.uid(), auth.role(), auth.email(), auth.jwt()
  to anon, authenticated, service_role;

-- ── storage ─────────────────────────────────────────────────────────────
create schema if not exists storage;
grant usage on schema storage to postgres, anon, authenticated, service_role;

create table if not exists storage.buckets (
  id text primary key,
  name text not null unique,
  owner uuid,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  public boolean default false
);
create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id),
  name text,
  owner uuid,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  last_accessed_at timestamptz default now(),
  metadata jsonb,
  path_tokens text[] generated always as (string_to_array(name, '/')) stored
);
alter table storage.objects enable row level security;
alter table storage.buckets enable row level security;
grant all on storage.buckets, storage.objects to anon, authenticated, service_role;

create or replace function storage.foldername(name text) returns text[]
language plpgsql immutable as $$
declare
  _parts text[];
begin
  select string_to_array(name, '/') into _parts;
  return _parts[1:array_length(_parts, 1) - 1];
end
$$;
grant execute on function storage.foldername(text) to anon, authenticated, service_role;

insert into storage.buckets (id, name) values ('documents', 'documents')
on conflict (id) do nothing;

-- ── realtime ────────────────────────────────────────────────────────────
do $$ begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;
