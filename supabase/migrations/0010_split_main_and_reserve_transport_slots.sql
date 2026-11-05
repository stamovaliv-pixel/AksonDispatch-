-- AksonDispatch v1.0.1
-- Apply after migrations 0001-0009; do not rerun earlier migrations.
-- Split daily transport capacity into independent main and reserve pools.
-- Main: 3 slots for destinations that are registered RCs.
-- Reserve: configurable count for all other destinations (BE / manual address).

begin;

alter table public.portal_settings
  add column if not exists reserve_slot_limit smallint not null default 3;

alter table public.portal_settings
  drop constraint if exists portal_settings_reserve_slot_limit_check;
alter table public.portal_settings
  add constraint portal_settings_reserve_slot_limit_check
  check (reserve_slot_limit between 0 and 20);

-- Keep directory addresses visible for old customer requests even after a unit
-- is deactivated. Customers see only active units plus units referenced by their
-- own requests; staff retain access to the full directory through the policy from 0004.
drop policy if exists "active units readable" on public.business_units;
create policy "active units readable" on public.business_units
for select to authenticated
using (
  is_active
  or public.is_staff()
  or exists (
    select 1
      from public.transport_requests r
     where r.requester_id = auth.uid()
       and (
         r.business_unit_id = public.business_units.id
         or r.from_unit_id = public.business_units.id
         or r.to_unit_id = public.business_units.id
       )
  )
);

alter table public.transport_requests
  add column if not exists slot_type text;

-- Backfill existing records according to their destination.
update public.transport_requests r
   set slot_type = case when bu.kind = 'RC' then 'main' else 'reserve' end
  from public.business_units bu
 where r.to_unit_id = bu.id
   and r.slot_type is null;
update public.transport_requests
   set slot_type = 'reserve'
 where slot_type is null;

alter table public.transport_requests
  alter column slot_type set default 'reserve',
  alter column slot_type set not null;

alter table public.transport_requests
  drop constraint if exists transport_requests_slot_number_check;
alter table public.transport_requests
  add constraint transport_requests_slot_number_check
  check (slot_number between 1 and 20);

alter table public.transport_requests
  drop constraint if exists transport_requests_slot_type_check;
alter table public.transport_requests
  add constraint transport_requests_slot_type_check
  check (slot_type in ('main', 'reserve'));


-- Old index enforced one shared pool. The new key keeps the pools independent.
drop index if exists public.transport_requests_active_slot_uq;
create unique index if not exists transport_requests_active_slot_pool_uq
  on public.transport_requests(transport_date, slot_type, slot_number)
  where status <> 'cancelled';

create or replace function public.assign_and_check_transport_slot()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_origin_kind text;
  v_destination_kind text;
  v_reserve_limit integer := 3;
  v_limit integer;
begin
  -- Validate route fields on inserts and whenever the route is changed.
  -- A legacy row with an old blank manual address can still be cancelled/edited
  -- outside the route without being blocked by this new validation.
  if TG_OP = 'INSERT'
     or new.from_unit_id is distinct from old.from_unit_id
     or new.from_other_address is distinct from old.from_other_address
     or new.to_unit_id is distinct from old.to_unit_id
     or new.to_other_address is distinct from old.to_other_address then
    if new.from_unit_id is not null then
      select kind::text into v_origin_kind
        from public.business_units
       where id = new.from_unit_id;
      if v_origin_kind is distinct from 'BE' then
        raise exception 'В поле «Откуда» можно выбрать только БЕ или указать другой адрес.'
          using errcode = 'check_violation';
      end if;
      new.from_other_address := null;
    else
      new.from_other_address := nullif(btrim(new.from_other_address), '');
      if new.from_other_address is null then
        raise exception 'Выберите БЕ в поле «Откуда» или вариант «Другой адрес» и укажите адрес вручную.'
          using errcode = 'check_violation';
      end if;
    end if;

    if new.to_unit_id is not null then
      select kind::text into v_destination_kind
        from public.business_units
       where id = new.to_unit_id;
      if v_destination_kind is null then
        raise exception 'Выбранное подразделение назначения не найдено в справочнике.'
          using errcode = 'check_violation';
      end if;
      new.to_other_address := null;
    else
      new.to_other_address := nullif(btrim(new.to_other_address), '');
      if new.to_other_address is null then
        raise exception 'Выберите БЕ/РЦ в поле «Куда» или вариант «Другой адрес» и укажите адрес вручную.'
          using errcode = 'check_violation';
      end if;
    end if;
  else
    if new.to_unit_id is not null then
      select kind::text into v_destination_kind from public.business_units where id = new.to_unit_id;
    end if;
  end if;

  -- Only a registered RC destination consumes the main pool.
  new.slot_type := case when v_destination_kind = 'RC' then 'main' else 'reserve' end;

  -- Existing allocations are grandfathered when the slot and route do not change.
  -- This keeps cancellation and edits possible after an administrator lowers the reserve limit.
  if TG_OP = 'UPDATE'
     and old.status <> 'cancelled'
     and new.transport_date is not distinct from old.transport_date
     and new.slot_number is not distinct from old.slot_number
     and new.to_unit_id is not distinct from old.to_unit_id
     and new.to_other_address is not distinct from old.to_other_address
     and new.slot_type is not distinct from old.slot_type then
    return new;
  end if;

  select coalesce(reserve_slot_limit, 3)::integer
    into v_reserve_limit
    from public.portal_settings
   where id = true;
  v_limit := case when new.slot_type = 'main' then 3 else coalesce(v_reserve_limit, 3) end;

  if new.slot_number is null or new.slot_number < 1 or new.slot_number > v_limit then
    if new.slot_type = 'main' then
      raise exception 'Основной пул содержит 3 слота. Выберите слот от 1 до 3.'
        using errcode = 'check_violation';
    else
      raise exception 'Количество резервных слотов на день: %. Выбранный слот недоступен.', coalesce(v_reserve_limit, 3)
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.assign_and_check_transport_slot() from public;

drop trigger if exists transport_requests_assign_slot_pool on public.transport_requests;
create trigger transport_requests_assign_slot_pool
before insert or update of transport_date, slot_number, slot_type, from_unit_id, from_other_address, to_unit_id, to_other_address, status
on public.transport_requests
for each row execute function public.assign_and_check_transport_slot();

-- Return the pool classification with the date/slot summary so the UI can
-- calculate available main and reserve capacity independently.
drop function if exists public.get_slot_occupancy(date, date);
create function public.get_slot_occupancy(
  p_from_date date,
  p_to_date date
)
returns table (transport_date date, slot_number smallint, slot_type text)
language sql
stable
security definer
set search_path = public
as $$
  select r.transport_date, r.slot_number, r.slot_type
    from public.transport_requests r
   where r.status <> 'cancelled'
     and r.transport_date between p_from_date and p_to_date
     and auth.uid() is not null
     and public.current_role() is not null
     and p_to_date >= p_from_date
     and p_to_date <= p_from_date + 93
   order by r.transport_date, r.slot_type, r.slot_number;
$$;
revoke all on function public.get_slot_occupancy(date, date) from public;
grant execute on function public.get_slot_occupancy(date, date) to authenticated;

drop function if exists public.get_calendar_slot_summary(date, date);
create function public.get_calendar_slot_summary(
  p_from_date date,
  p_to_date date
)
returns table (
  transport_date date,
  slot_number smallint,
  slot_type text,
  status public.request_status,
  from_be_code text
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or public.current_role() is null then
    raise exception 'Требуется авторизация.' using errcode = 'insufficient_privilege';
  end if;
  if p_from_date is null or p_to_date is null or p_to_date < p_from_date
     or p_to_date > p_from_date + 93 then
    raise exception 'Допустимый период календаря — не более 94 дней.' using errcode = 'invalid_parameter_value';
  end if;

  return query
  select r.transport_date,
         r.slot_number,
         r.slot_type,
         r.status,
         coalesce(bu.code, case when r.from_other_address is not null then 'АДРЕС' else '—' end)::text
    from public.transport_requests r
    left join public.business_units bu on bu.id = r.from_unit_id
   where r.status <> 'cancelled'
     and r.transport_date between p_from_date and p_to_date
   order by r.transport_date, r.slot_type, r.slot_number;
end;
$$;
revoke all on function public.get_calendar_slot_summary(date, date) from public;
grant execute on function public.get_calendar_slot_summary(date, date) to authenticated;

-- Preserve the existing audit behavior and include the new capacity setting.
create or replace function public.audit_portal_settings_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.audit_log(actor_id, action, entity_type, entity_id, details)
  values (
    auth.uid(),
    case when TG_OP = 'INSERT' then 'settings_create' when TG_OP = 'DELETE' then 'settings_delete' else 'settings_update' end,
    'portal_settings', null,
    jsonb_build_object(
      'old_booking_advance_days', case when TG_OP = 'UPDATE' then old.booking_advance_days else null end,
      'new_booking_advance_days', case when TG_OP = 'DELETE' then null else new.booking_advance_days end,
      'old_registry_template_name', case when TG_OP = 'UPDATE' then old.registry_template_name else null end,
      'new_registry_template_name', case when TG_OP = 'DELETE' then null else new.registry_template_name end,
      'old_reserve_slot_limit', case when TG_OP = 'UPDATE' then old.reserve_slot_limit else null end,
      'new_reserve_slot_limit', case when TG_OP = 'DELETE' then null else new.reserve_slot_limit end
    )
  );
  if TG_OP = 'DELETE' then return old; end if;
  return new;
end;
$$;

notify pgrst, 'reload schema';

commit;
