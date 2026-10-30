-- Admin workspace privileges for the separate Transport Portal project.
-- Safe to apply after 0001_initial_schema.sql in the NEW portal database only.
-- RLS policies remain the enforcement boundary; these grants only make the
-- already-defined admin-only policies usable from the application UI.

grant select, insert, update on public.business_units to authenticated;
grant select, update on public.profiles to authenticated;

-- Record administrative profile changes server-side. No client write access
-- to audit_log is granted; this trigger runs with its owner's privileges.
create or replace function public.audit_profile_access_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.role is distinct from new.role
     or old.is_active is distinct from new.is_active
     or old.business_unit_id is distinct from new.business_unit_id
     or old.default_from_id is distinct from new.default_from_id then
    insert into public.audit_log(actor_id, action, entity_type, entity_id, details)
    values (
      auth.uid(),
      'profile_access_update',
      'profile',
      new.id,
      jsonb_build_object(
        'username', new.username,
        'old_role', old.role,
        'new_role', new.role,
        'old_is_active', old.is_active,
        'new_is_active', new.is_active,
        'old_business_unit_id', old.business_unit_id,
        'new_business_unit_id', new.business_unit_id
      )
    );
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_audit_access_change on public.profiles;
create trigger profiles_audit_access_change
after update on public.profiles
for each row execute function public.audit_profile_access_change();

-- Tighten customer-side update rights: customers may edit only their own
-- not-yet-processed request and cannot move it to a different business unit.
drop policy if exists "request owner or staff updates" on public.transport_requests;
create policy "request owner or staff updates" on public.transport_requests
for update to authenticated
using (
  public.is_staff()
  or (requester_id = auth.uid() and status = 'created')
)
with check (
  public.is_staff()
  or (
    requester_id = auth.uid()
    and status = 'created'
    and business_unit_id = (
      select business_unit_id from public.profiles
      where id = auth.uid() and is_active = true
    )
  )
);

-- Customers may change cargo only while their request remains in the
-- initial status. Staff retain operational access to all visible requests.
drop policy if exists "cargo insert via request" on public.request_cargo;
create policy "cargo insert via request" on public.request_cargo
for insert to authenticated
with check (
  exists (
    select 1 from public.transport_requests r
    where r.id = request_id
      and (public.is_staff() or (r.requester_id = auth.uid() and r.status = 'created'))
  )
);

drop policy if exists "cargo update via request" on public.request_cargo;
create policy "cargo update via request" on public.request_cargo
for update to authenticated
using (
  exists (
    select 1 from public.transport_requests r
    where r.id = request_id
      and (public.is_staff() or (r.requester_id = auth.uid() and r.status = 'created'))
  )
)
with check (
  exists (
    select 1 from public.transport_requests r
    where r.id = request_id
      and (public.is_staff() or (r.requester_id = auth.uid() and r.status = 'created'))
  )
);

drop policy if exists "cargo delete via request" on public.request_cargo;
create policy "cargo delete via request" on public.request_cargo
for delete to authenticated
using (
  exists (
    select 1 from public.transport_requests r
    where r.id = request_id
      and (public.is_staff() or (r.requester_id = auth.uid() and r.status = 'created'))
  )
);

-- New requests are created by active customer accounts only, and the assigned
-- business unit must remain active. Operational staff only process requests.
drop policy if exists "customer creates own request" on public.transport_requests;
create policy "customer creates own request" on public.transport_requests
for insert to authenticated
with check (
  requester_id = auth.uid()
  and public.current_role() = 'customer'
  and business_unit_id = (
    select business_unit_id from public.profiles
    where id = auth.uid() and is_active = true
  )
  and exists (
    select 1 from public.business_units bu
    where bu.id = business_unit_id and bu.is_active = true
  )
);

-- Customers need to know which of the three shared slots are reserved, but
-- must not be able to read other customers' request details. This function
-- exposes only date + slot number for active requests.
create or replace function public.get_slot_occupancy(
  p_from_date date,
  p_to_date date
)
returns table (transport_date date, slot_number smallint)
language sql
stable
security definer
set search_path = public
as $$
  select r.transport_date, r.slot_number
  from public.transport_requests r
  where r.status <> 'cancelled'
    and r.transport_date between p_from_date and p_to_date
    and auth.uid() is not null
    and public.current_role() is not null
    and p_to_date >= p_from_date
    and p_to_date <= p_from_date + 93
  order by r.transport_date, r.slot_number;
$$;

revoke all on function public.get_slot_occupancy(date, date) from public;
grant execute on function public.get_slot_occupancy(date, date) to authenticated;
