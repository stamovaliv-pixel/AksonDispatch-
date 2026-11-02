-- Role separation, safe calendar slot summaries and reports for Akson Dispatch.
-- Apply after 0001, 0002 and 0003 in the Transport Portal Supabase project.

-- 1) A narrower capability than is_staff(): only dispatcher and administrator
-- may edit existing requests or their cargo rows. UTZ remains read-only.
create or replace function public.can_operate_transport_requests()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(public.current_role() in ('dispatcher','admin'), false)
$$;

revoke all on function public.can_operate_transport_requests() from public;
grant execute on function public.can_operate_transport_requests() to authenticated;

-- Staff may read inactive directory entries for historical requests and reports;
-- only the administrator retains directory write policies from earlier migrations.
drop policy if exists "staff reads all business units" on public.business_units;
create policy "staff reads all business units" on public.business_units
for select to authenticated
using (public.is_staff());

-- 2) Replace broad staff update rules with the exact role matrix.
drop policy if exists "request owner or staff updates" on public.transport_requests;
create policy "role based request updates" on public.transport_requests
for update to authenticated
using (
  public.can_operate_transport_requests()
  or (
    public.current_role() = 'customer'
    and requester_id = auth.uid()
    and status = 'created'
  )
)
with check (
  public.can_operate_transport_requests()
  or (
    public.current_role() = 'customer'
    and requester_id = auth.uid()
    and status in ('created','cancelled')
    and business_unit_id = (
      select p.business_unit_id from public.profiles p
       where p.id = auth.uid() and p.is_active = true
    )
  )
);

-- A customer can edit own request while status is created. Once cancelling,
-- the only allowed data change is status: created -> cancelled.
create or replace function public.guard_customer_request_update()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if public.current_role() = 'customer' then
    if old.requester_id <> auth.uid() or old.status <> 'created' then
      raise exception 'Заказчик может изменять только собственную заявку со статусом «Создана».'
        using errcode = 'insufficient_privilege';
    end if;

    if new.requester_id is distinct from old.requester_id
       or new.business_unit_id is distinct from old.business_unit_id
       or new.dispatcher_comment is distinct from old.dispatcher_comment then
      raise exception 'Заказчик не может менять владельца, БЕ или комментарий диспетчера.'
        using errcode = 'insufficient_privilege';
    end if;

    if new.status is distinct from old.status then
      if new.status <> 'cancelled' then
        raise exception 'Заказчик может только отменить собственную заявку со статусом «Создана».'
          using errcode = 'insufficient_privilege';
      end if;
      if new.transport_date is distinct from old.transport_date
         or new.slot_number is distinct from old.slot_number
         or new.from_unit_id is distinct from old.from_unit_id
         or new.from_other_address is distinct from old.from_other_address
         or new.to_unit_id is distinct from old.to_unit_id
         or new.to_other_address is distinct from old.to_other_address
         or new.capacity_tons is distinct from old.capacity_tons
         or new.loading_type is distinct from old.loading_type then
        raise exception 'При отмене заявки нельзя одновременно менять её параметры.'
          using errcode = 'insufficient_privilege';
      end if;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists transport_requests_guard_customer_update on public.transport_requests;
create trigger transport_requests_guard_customer_update
before update on public.transport_requests
for each row execute function public.guard_customer_request_update();

-- UTZ retains read-only access. Dispatcher/admin can update request cargo;
-- customers can change cargo only while their own parent request is created.
drop policy if exists "cargo insert via request" on public.request_cargo;
create policy "role based cargo insert" on public.request_cargo
for insert to authenticated
with check (
  exists (
    select 1 from public.transport_requests r
     where r.id = request_id
       and (
         public.can_operate_transport_requests()
         or (public.current_role() = 'customer' and r.requester_id = auth.uid() and r.status = 'created')
       )
  )
);

drop policy if exists "cargo update via request" on public.request_cargo;
create policy "role based cargo update" on public.request_cargo
for update to authenticated
using (
  exists (
    select 1 from public.transport_requests r
     where r.id = request_id
       and (
         public.can_operate_transport_requests()
         or (public.current_role() = 'customer' and r.requester_id = auth.uid() and r.status = 'created')
       )
  )
)
with check (
  exists (
    select 1 from public.transport_requests r
     where r.id = request_id
       and (
         public.can_operate_transport_requests()
         or (public.current_role() = 'customer' and r.requester_id = auth.uid() and r.status = 'created')
       )
  )
);

drop policy if exists "cargo delete via request" on public.request_cargo;
create policy "role based cargo delete" on public.request_cargo
for delete to authenticated
using (
  exists (
    select 1 from public.transport_requests r
     where r.id = request_id
       and (
         public.can_operate_transport_requests()
         or (public.current_role() = 'customer' and r.requester_id = auth.uid() and r.status = 'created')
       )
  )
);

-- UTZ is strictly read-only; dispatcher/admin retain the staff comment action.
drop policy if exists "staff adds comments" on public.request_comments;
create policy "dispatcher and admin add comments" on public.request_comments
for insert to authenticated
with check (
  author_id = auth.uid()
  and public.current_role() in ('dispatcher','admin')
);

-- 3) Safe calendar data for every active role. A customer sees only the
-- status and departure BE code for other customers' reservations, not their
-- identities, destinations, quantities or request numbers.
create or replace function public.get_calendar_slot_summary(
  p_from_date date,
  p_to_date date
)
returns table (
  transport_date date,
  slot_number smallint,
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
         r.status,
         coalesce(bu.code, case when r.from_other_address is not null then 'АДРЕС' else '—' end)::text
    from public.transport_requests r
    left join public.business_units bu on bu.id = r.from_unit_id
   where r.status <> 'cancelled'
     and r.transport_date between p_from_date and p_to_date
   order by r.transport_date, r.slot_number;
end;
$$;

revoke all on function public.get_calendar_slot_summary(date,date) from public;
grant execute on function public.get_calendar_slot_summary(date,date) to authenticated;

-- 4) Audit history is available to dispatcher and administrator only.
drop policy if exists "staff reads audit log" on public.audit_log;
drop policy if exists "admin reads audit log" on public.audit_log;
create policy "dispatcher and admin read audit log" on public.audit_log
for select to authenticated
using (public.current_role() in ('dispatcher','admin'));

create or replace function public.admin_search_audit(
  p_search text default null,
  p_entity_type text default null,
  p_from_date date default null,
  p_to_date date default null,
  p_offset integer default 0,
  p_limit integer default 500
)
returns table (
  id bigint,
  actor_id uuid,
  action text,
  entity_type text,
  entity_id uuid,
  details jsonb,
  created_at timestamptz,
  actor_username text
)
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v_search text := nullif(trim(coalesce(p_search, '')), '');
begin
  if public.current_role() not in ('dispatcher','admin') then
    raise exception 'Доступ запрещён: требуется роль диспетчера или администратора.'
      using errcode = 'insufficient_privilege';
  end if;
  if p_offset is null or p_offset < 0 or p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception 'Некорректные параметры страницы истории.' using errcode = 'invalid_parameter_value';
  end if;
  if p_from_date is not null and p_to_date is not null and p_from_date > p_to_date then
    raise exception 'Начальная дата не может быть позже конечной.' using errcode = 'check_violation';
  end if;

  return query
  select a.id, a.actor_id, a.action, a.entity_type, a.entity_id, a.details,
         a.created_at, p.username::text
    from public.audit_log a
    left join public.profiles p on p.id = a.actor_id
   where (p_entity_type is null or a.entity_type = p_entity_type)
     and (p_from_date is null or a.created_at >= (p_from_date::timestamp at time zone 'Europe/Moscow'))
     and (p_to_date is null or a.created_at < ((p_to_date + 1)::timestamp at time zone 'Europe/Moscow'))
     and (v_search is null or concat_ws(' ', p.username, a.action, a.entity_type,
             a.entity_id::text, a.details::text) ilike '%' || v_search || '%')
   order by a.created_at desc, a.id desc
   offset p_offset limit p_limit;
end;
$$;

revoke all on function public.admin_search_audit(text,text,date,date,integer,integer) from public;
grant execute on function public.admin_search_audit(text,text,date,date,integer,integer) to authenticated;

-- 5) Aggregated reports. Period is selected by transport date. The RPC is
-- SECURITY INVOKER and is available only to dispatcher/admin; no row-level
-- details outside the allowed staff scope are returned.
create or replace function public.get_transport_report_data(
  p_from_date date,
  p_to_date date
)
returns table (
  section text,
  label text,
  request_count bigint,
  average_close_days numeric,
  closed_count bigint,
  open_count bigint
)
language plpgsql
stable
security invoker
set search_path = public
as $$
begin
  if public.current_role() not in ('dispatcher','admin') then
    raise exception 'Доступ запрещён: отчёты доступны диспетчеру и администратору.'
      using errcode = 'insufficient_privilege';
  end if;
  if p_from_date is null or p_to_date is null or p_from_date > p_to_date then
    raise exception 'Укажите корректный отчётный период.' using errcode = 'invalid_parameter_value';
  end if;

  return query
  with base as (
    select r.id,
           coalesce(p.username, 'Без пользователя')::text as customer_name,
           coalesce(nullif(trim(bf.code), '') || ' · ' || nullif(trim(bf.name), ''), r.from_other_address, 'Не указано')::text as origin_name,
           coalesce(nullif(trim(bt.code), '') || ' · ' || nullif(trim(bt.name), ''), r.to_other_address, 'Не указано')::text as destination_name,
           r.status,
           r.created_at,
           done.completed_at,
           case when r.status = 'completed' and done.completed_at is not null
             then greatest(0, extract(epoch from (done.completed_at - r.created_at)) / 86400.0)
             else null end as close_days
      from public.transport_requests r
      left join public.profiles p on p.id = r.requester_id
      left join public.business_units bf on bf.id = r.from_unit_id
      left join public.business_units bt on bt.id = r.to_unit_id
      left join lateral (
        select max(h.changed_at) as completed_at
          from public.request_status_history h
         where h.request_id = r.id and h.new_status = 'completed'
      ) done on true
     where r.transport_date between p_from_date and p_to_date
  ),
  cargo_rows as (
    select distinct b.id, c.cargo_type
      from base b
      join public.request_cargo c on c.request_id = b.id
  ),
  sections as (
    select 'summary'::text as section, 'Всего заявок'::text as label,
           count(*)::bigint as request_count,
           round(avg(b.close_days)::numeric, 2) as average_close_days,
           count(*) filter (where b.status = 'completed')::bigint as closed_count,
           count(*) filter (where b.status in ('created','search','confirmed'))::bigint as open_count
      from base b
    union all
    select 'customer', b.customer_name, count(*)::bigint,
           round(avg(b.close_days)::numeric, 2),
           count(*) filter (where b.status = 'completed')::bigint,
           count(*) filter (where b.status in ('created','search','confirmed'))::bigint
      from base b group by b.customer_name
    union all
    select 'from', b.origin_name, count(*)::bigint,
           round(avg(b.close_days)::numeric, 2),
           count(*) filter (where b.status = 'completed')::bigint,
           count(*) filter (where b.status in ('created','search','confirmed'))::bigint
      from base b group by b.origin_name
    union all
    select 'to', b.destination_name, count(*)::bigint,
           round(avg(b.close_days)::numeric, 2),
           count(*) filter (where b.status = 'completed')::bigint,
           count(*) filter (where b.status in ('created','search','confirmed'))::bigint
      from base b group by b.destination_name
    union all
    select 'cargo', case c.cargo_type when 'goods' then 'Товар' when 'equipment' then 'Оборудование' when 'packaging' then 'Тара' else c.cargo_type::text end,
           count(*)::bigint,
           null::numeric,
           count(*) filter (where b.status = 'completed')::bigint,
           count(*) filter (where b.status in ('created','search','confirmed'))::bigint
      from cargo_rows c join base b on b.id = c.id group by c.cargo_type
    union all
    select 'closing_speed',
           case when b.close_days < 1 then 'Менее 1 дня'
                when b.close_days < 3 then '1–2 дня'
                when b.close_days < 7 then '3–6 дней'
                when b.close_days < 14 then '7–13 дней'
                else '14 дней и более' end,
           count(*)::bigint,
           round(avg(b.close_days)::numeric, 2),
           count(*)::bigint,
           0::bigint
      from base b where b.status = 'completed' and b.close_days is not null
      group by 2
    union all
    select 'status',
           case b.status when 'created' then 'Создана' when 'search' then 'Поиск транспорта'
                when 'confirmed' then 'Подтверждена' when 'completed' then 'Выполнена'
                when 'cancelled' then 'Отменена' else b.status::text end,
           count(*)::bigint,
           round(avg(b.close_days)::numeric, 2),
           count(*) filter (where b.status = 'completed')::bigint,
           count(*) filter (where b.status in ('created','search','confirmed'))::bigint
      from base b group by b.status
  )
  select s.section, s.label, s.request_count, s.average_close_days, s.closed_count, s.open_count
    from sections s
   order by case s.section when 'summary' then 0 when 'customer' then 1 when 'from' then 2
             when 'to' then 3 when 'cargo' then 4 when 'closing_speed' then 5 when 'status' then 6 else 7 end,
            s.request_count desc, s.label;
end;
$$;

revoke all on function public.get_transport_report_data(date,date) from public;
grant execute on function public.get_transport_report_data(date,date) to authenticated;

-- Trigger helpers are not directly callable by client roles.
revoke all on function public.guard_customer_request_update() from public;
