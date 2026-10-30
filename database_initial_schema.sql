-- Akson Transport Portal: initial schema
-- Apply to a NEW Supabase project only after reviewing README.
-- This migration does not disable RLS and does not expose personal data.

create extension if not exists pgcrypto;

do $$ begin
  create type public.app_role as enum ('customer','dispatcher','utz','admin');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.request_status as enum ('created','search','confirmed','completed','cancelled');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.business_unit_kind as enum ('BE','RC');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.cargo_kind as enum ('goods','equipment','packaging');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.loading_kind as enum ('rear','side');
exception when duplicate_object then null; end $$;

create table if not exists public.business_units (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  kind public.business_unit_kind not null,
  address text,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique,
  role public.app_role not null default 'customer',
  business_unit_id uuid references public.business_units(id),
  default_from_id uuid references public.business_units(id),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint username_format check (username ~ '^[A-Za-z0-9_-]{3,40}$')
);

create table if not exists public.transport_requests (
  id uuid primary key default gen_random_uuid(),
  request_no bigint generated always as identity unique,
  requester_id uuid not null references public.profiles(id),
  business_unit_id uuid not null references public.business_units(id),
  transport_date date not null,
  slot_number smallint not null check (slot_number between 1 and 3),
  from_unit_id uuid references public.business_units(id),
  from_other_address text,
  to_unit_id uuid references public.business_units(id),
  to_other_address text,
  capacity_tons numeric(5,2) not null check (capacity_tons in (1.5,5,10,20)),
  loading_type public.loading_kind not null,
  status public.request_status not null default 'created',
  dispatcher_comment text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((from_unit_id is not null) <> (from_other_address is not null)),
  check ((to_unit_id is not null) <> (to_other_address is not null))
);

-- Three shared slots per date. Cancelled requests release a slot.
create unique index if not exists transport_requests_active_slot_uq
  on public.transport_requests(transport_date, slot_number)
  where status <> 'cancelled';

create index if not exists transport_requests_date_idx on public.transport_requests(transport_date);
create index if not exists transport_requests_requester_date_idx on public.transport_requests(requester_id, transport_date);
create index if not exists transport_requests_status_date_idx on public.transport_requests(status, transport_date);

create table if not exists public.request_cargo (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.transport_requests(id) on delete cascade,
  cargo_type public.cargo_kind not null,
  stock_pallets integer not null default 0 check (stock_pallets >= 0),
  kdk_pallets integer not null default 0 check (kdk_pallets >= 0),
  packaging_qty integer not null default 0 check (packaging_qty >= 0),
  unique(request_id, cargo_type)
);

create table if not exists public.request_status_history (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.transport_requests(id) on delete cascade,
  old_status public.request_status,
  new_status public.request_status not null,
  changed_by uuid not null references public.profiles(id),
  changed_at timestamptz not null default now()
);

create table if not exists public.request_comments (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.transport_requests(id) on delete cascade,
  author_id uuid not null references public.profiles(id),
  comment text not null check (length(trim(comment)) > 0),
  created_at timestamptz not null default now()
);

create table if not exists public.audit_log (
  id bigint generated always as identity primary key,
  actor_id uuid references public.profiles(id),
  action text not null,
  entity_type text not null,
  entity_id uuid,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create or replace function public.current_role()
returns public.app_role
language sql stable security definer
set search_path = public
as $$
  select role from public.profiles where id = auth.uid() and is_active = true
$$;

create or replace function public.is_staff()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select coalesce(public.current_role() in ('dispatcher','utz','admin'), false)
$$;

create or replace function public.is_admin()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select coalesce(public.current_role() = 'admin', false)
$$;

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at before update on public.profiles
for each row execute function public.set_updated_at();
drop trigger if exists requests_set_updated_at on public.transport_requests;
create trigger requests_set_updated_at before update on public.transport_requests
for each row execute function public.set_updated_at();

-- Status and date/slot changes are recorded server-side.
create or replace function public.log_request_change()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if TG_OP = 'INSERT' then
    insert into public.request_status_history(request_id,old_status,new_status,changed_by)
    values(new.id,null,new.status,auth.uid());
    insert into public.audit_log(actor_id,action,entity_type,entity_id,details)
    values(auth.uid(),'create','transport_request',new.id,jsonb_build_object('date',new.transport_date,'slot',new.slot_number));
    return new;
  end if;
  if old.status is distinct from new.status then
    insert into public.request_status_history(request_id,old_status,new_status,changed_by)
    values(new.id,old.status,new.status,auth.uid());
  end if;
  if old.transport_date is distinct from new.transport_date or old.slot_number is distinct from new.slot_number then
    insert into public.audit_log(actor_id,action,entity_type,entity_id,details)
    values(auth.uid(),'reschedule','transport_request',new.id,jsonb_build_object('old_date',old.transport_date,'new_date',new.transport_date,'old_slot',old.slot_number,'new_slot',new.slot_number));
  end if;
  return new;
end $$;
drop trigger if exists requests_log_change on public.transport_requests;
create trigger requests_log_change after insert or update on public.transport_requests
for each row execute function public.log_request_change();

alter table public.business_units enable row level security;
alter table public.profiles enable row level security;
alter table public.transport_requests enable row level security;
alter table public.request_cargo enable row level security;
alter table public.request_status_history enable row level security;
alter table public.request_comments enable row level security;
alter table public.audit_log enable row level security;

-- Authenticated users may read active directory entries; only admin manages directories.
drop policy if exists "active units readable" on public.business_units;
create policy "active units readable" on public.business_units for select to authenticated
using (is_active or public.is_admin());
drop policy if exists "admin manages units" on public.business_units;
create policy "admin manages units" on public.business_units for all to authenticated
using (public.is_admin()) with check (public.is_admin());

-- Users see their own profile; staff see profiles for operational work.
drop policy if exists "profile visibility" on public.profiles;
create policy "profile visibility" on public.profiles for select to authenticated
using (id = auth.uid() or public.is_staff());
drop policy if exists "admin manages profiles" on public.profiles;
create policy "admin manages profiles" on public.profiles for all to authenticated
using (public.is_admin()) with check (public.is_admin());

-- Customer can see own requests; dispatcher/UTZ/admin see all.
drop policy if exists "request visibility" on public.transport_requests;
create policy "request visibility" on public.transport_requests for select to authenticated
using (requester_id = auth.uid() or public.is_staff());

drop policy if exists "customer creates own request" on public.transport_requests;
create policy "customer creates own request" on public.transport_requests for insert to authenticated
with check (
  requester_id = auth.uid()
  and business_unit_id = (select business_unit_id from public.profiles where id=auth.uid() and is_active)
  and public.current_role() is not null
);

drop policy if exists "request owner or staff updates" on public.transport_requests;
create policy "request owner or staff updates" on public.transport_requests for update to authenticated
using (requester_id = auth.uid() or public.is_staff())
with check (
  (public.is_staff() or (requester_id = auth.uid() and status = 'created'))
);

-- Cargo inherits request visibility and edit permissions through parent request.
drop policy if exists "cargo read via request" on public.request_cargo;
create policy "cargo read via request" on public.request_cargo for select to authenticated
using (exists(select 1 from public.transport_requests r where r.id=request_id and (r.requester_id=auth.uid() or public.is_staff())));
drop policy if exists "cargo insert via request" on public.request_cargo;
create policy "cargo insert via request" on public.request_cargo for insert to authenticated
with check (exists(select 1 from public.transport_requests r where r.id=request_id and (r.requester_id=auth.uid() or public.is_staff())));
drop policy if exists "cargo update via request" on public.request_cargo;
create policy "cargo update via request" on public.request_cargo for update to authenticated
using (exists(select 1 from public.transport_requests r where r.id=request_id and (r.requester_id=auth.uid() or public.is_staff())))
with check (exists(select 1 from public.transport_requests r where r.id=request_id and (r.requester_id=auth.uid() or public.is_staff())));
drop policy if exists "cargo delete via request" on public.request_cargo;
create policy "cargo delete via request" on public.request_cargo for delete to authenticated
using (exists(select 1 from public.transport_requests r where r.id=request_id and (r.requester_id=auth.uid() or public.is_staff())));

drop policy if exists "history read via request" on public.request_status_history;
create policy "history read via request" on public.request_status_history for select to authenticated
using (exists(select 1 from public.transport_requests r where r.id=request_id and (r.requester_id=auth.uid() or public.is_staff())));
drop policy if exists "comments read via request" on public.request_comments;
create policy "comments read via request" on public.request_comments for select to authenticated
using (exists(select 1 from public.transport_requests r where r.id=request_id and (r.requester_id=auth.uid() or public.is_staff())));
drop policy if exists "staff adds comments" on public.request_comments;
create policy "staff adds comments" on public.request_comments for insert to authenticated
with check (author_id=auth.uid() and public.is_staff());

drop policy if exists "staff reads audit log" on public.audit_log;
create policy "staff reads audit log" on public.audit_log for select to authenticated
using (public.is_staff());
-- No client-side insert/update/delete policy for audit_log: writes are trigger-owned.

grant usage on schema public to authenticated;
grant select, insert, update on public.transport_requests to authenticated;
grant select, insert, update, delete on public.request_cargo to authenticated;
grant select on public.profiles, public.business_units, public.request_status_history, public.request_comments, public.audit_log to authenticated;
grant insert on public.request_comments to authenticated;
grant usage, select on all sequences in schema public to authenticated;

-- No open registration. Create users through the Edge Function using service-role credentials.
-- Seed your own business units before creating users.
