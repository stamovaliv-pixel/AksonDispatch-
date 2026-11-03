-- AksonDispatch v0.4.4
-- Request detail fields, dispatcher request creation, customer registry editing,
-- and staff booking dates independent of customer advance-booking setting.
-- Apply after migrations 0001-0006 in the Transport Portal Supabase project.

begin;

-- 1) Optional request identifiers and free-form customer comment.
alter table public.transport_requests
  add column if not exists transport_task_number varchar(44),
  add column if not exists request_comment varchar(320);

-- 2) Dispatchers may create requests on behalf of an active customer.
-- The selected customer's BE snapshot is kept consistent, including NULL BE.
drop policy if exists "dispatcher creates requests for customers" on public.transport_requests;
create policy "dispatcher creates requests for customers"
  on public.transport_requests for insert to authenticated
  with check (
    public.current_role() = 'dispatcher'
    and exists (
      select 1
        from public.profiles p
       where p.id = requester_id
         and p.role = 'customer'
         and p.is_active = true
         and p.business_unit_id is not distinct from transport_requests.business_unit_id
         and (
           p.business_unit_id is null
           or exists (
             select 1 from public.business_units bu
              where bu.id = p.business_unit_id
                and bu.kind = 'BE'
                and bu.is_active = true
           )
         )
    )
  );

-- 3) Customers may update only their own active request's registry metadata
-- after processing has started. Dispatcher/admin continue to edit every field.
drop policy if exists "role based request updates" on public.transport_requests;
create policy "role based request updates"
  on public.transport_requests for update to authenticated
  using (
    public.can_operate_transport_requests()
    or (
      public.current_role() = 'customer'
      and requester_id = auth.uid()
      and status not in ('completed', 'cancelled')
    )
  )
  with check (
    public.can_operate_transport_requests()
    or (
      public.current_role() = 'customer'
      and requester_id = auth.uid()
      and status in ('created', 'search', 'confirmed', 'cancelled')
    )
  );

create or replace function public.guard_customer_request_update()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if public.current_role() = 'customer' then
    if old.requester_id <> auth.uid() then
      raise exception 'Заказчик может изменять только собственную заявку.'
        using errcode = 'insufficient_privilege';
    end if;

    if old.status in ('completed', 'cancelled') then
      raise exception 'Для выполненной или отменённой заявки изменение недоступно.'
        using errcode = 'insufficient_privilege';
    end if;

    if old.status <> 'created' then
      -- In statuses search/confirmed, only registry path/name may change.
      if row(
        old.requester_id, old.business_unit_id, old.transport_date, old.slot_number,
        old.from_unit_id, old.from_other_address, old.to_unit_id, old.to_other_address,
        old.capacity_tons, old.loading_type, old.status, old.dispatcher_comment,
        old.transport_task_number, old.request_comment
      ) is distinct from row(
        new.requester_id, new.business_unit_id, new.transport_date, new.slot_number,
        new.from_unit_id, new.from_other_address, new.to_unit_id, new.to_other_address,
        new.capacity_tons, new.loading_type, new.status, new.dispatcher_comment,
        new.transport_task_number, new.request_comment
      ) then
        raise exception 'После начала обработки заказчик может только загрузить или заменить реестр.'
          using errcode = 'insufficient_privilege';
      end if;
      return new;
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
      if row(
        old.transport_date, old.slot_number, old.from_unit_id, old.from_other_address,
        old.to_unit_id, old.to_other_address, old.capacity_tons, old.loading_type,
        old.transport_task_number, old.request_comment
      ) is distinct from row(
        new.transport_date, new.slot_number, new.from_unit_id, new.from_other_address,
        new.to_unit_id, new.to_other_address, new.capacity_tons, new.loading_type,
        new.transport_task_number, new.request_comment
      ) then
        raise exception 'При отмене заявки нельзя одновременно менять её параметры.'
          using errcode = 'insufficient_privilege';
      end if;
    end if;
  end if;
  return new;
end;
$$;

-- Customers may upload/replace a registry for their own request until it is
-- completed or cancelled. Other request fields remain protected by the trigger.
drop policy if exists "dispatch files insert" on storage.objects;
create policy "dispatch files insert"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'dispatch-files'
    and (
      (split_part(name, '/', 1) = 'templates' and public.is_admin())
      or (
        split_part(name, '/', 1) = 'requests'
        and exists (
          select 1 from public.transport_requests r
           where r.id::text = split_part(name, '/', 2)
             and (
               public.can_operate_transport_requests()
               or (
                 public.current_role() = 'customer'
                 and r.requester_id = auth.uid()
                 and r.status not in ('completed', 'cancelled')
               )
             )
        )
      )
    )
  );

drop policy if exists "dispatch files delete" on storage.objects;
create policy "dispatch files delete"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'dispatch-files'
    and (
      (split_part(name, '/', 1) = 'templates' and public.is_admin())
      or (
        split_part(name, '/', 1) = 'requests'
        and exists (
          select 1 from public.transport_requests r
           where r.id::text = split_part(name, '/', 2)
             and (
               public.can_operate_transport_requests()
               or (
                 public.current_role() = 'customer'
                 and r.requester_id = auth.uid()
                 and r.status not in ('completed', 'cancelled')
               )
             )
        )
      )
    )
  );

-- 4) Advance-booking settings apply to customers. Dispatcher/admin can create
-- or reschedule from today onward, but cannot set a new date in the past.
-- Monthly customer quota and selected customer's BE consistency remain active.
create or replace function public.enforce_transport_request_limits()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_advance_days integer := 0;
  v_limit integer := 30;
  v_role public.app_role;
  v_actor_role public.app_role;
  v_profile_business_unit_id uuid;
  v_count integer := 0;
  v_month_start date;
  v_month_end date;
  v_today date := (now() at time zone 'Europe/Moscow')::date;
  v_date_operation boolean := false;
begin
  v_actor_role := public.current_role();

  -- A status-only cancellation of an older request is allowed. Any actual
  -- edit of its shipment fields is still blocked for Dispatcher/Admin.
  if TG_OP = 'UPDATE'
     and v_actor_role in ('dispatcher', 'admin')
     and new.transport_date < v_today
     and row(
       old.requester_id, old.business_unit_id, old.transport_date, old.slot_number,
       old.from_unit_id, old.from_other_address, old.to_unit_id, old.to_other_address,
       old.capacity_tons, old.loading_type, old.dispatcher_comment,
       old.transport_task_number, old.request_comment
     ) is distinct from row(
       new.requester_id, new.business_unit_id, new.transport_date, new.slot_number,
       new.from_unit_id, new.from_other_address, new.to_unit_id, new.to_other_address,
       new.capacity_tons, new.loading_type, new.dispatcher_comment,
       new.transport_task_number, new.request_comment
     ) then
    raise exception 'Редактировать параметры перевозки можно только для заявок на сегодня или будущую дату.'
      using errcode = 'check_violation';
  end if;

  if new.status = 'cancelled' then
    return new;
  end if;

  if TG_OP = 'UPDATE' then
    if new.requester_id is not distinct from old.requester_id
       and new.transport_date is not distinct from old.transport_date
       and old.status <> 'cancelled' then
      return new;
    end if;
    v_date_operation := new.transport_date is distinct from old.transport_date
      or old.status = 'cancelled';
  else
    v_date_operation := true;
  end if;

  if v_date_operation then
    if v_actor_role in ('dispatcher', 'admin') then
      if new.transport_date < v_today then
        raise exception 'Сотрудники могут создавать и переносить заявки только на текущую или будущую дату.'
          using errcode = 'check_violation';
      end if;
    else
      select coalesce(s.booking_advance_days, 0)
        into v_advance_days
        from public.portal_settings s
       where s.id = true;
      v_advance_days := coalesce(v_advance_days, 0);
      if new.transport_date < (v_today + v_advance_days) then
        raise exception 'Создание заявки доступно не ранее чем за % дн. до даты перевозки.', v_advance_days
          using errcode = 'check_violation';
      end if;
    end if;
  end if;

  select p.role, p.business_unit_id
    into v_role, v_profile_business_unit_id
    from public.profiles p
   where p.id = new.requester_id and p.is_active = true;
  if v_role is null or v_role <> 'customer' then
    raise exception 'Заявка должна принадлежать активному пользователю с ролью «Заказчик». '
      using errcode = 'check_violation';
  end if;

  if TG_OP = 'INSERT' then
    if new.business_unit_id is distinct from v_profile_business_unit_id then
      raise exception 'БЕ заявки должна совпадать с БЕ профиля заказчика (или обе должны быть пустыми).'
        using errcode = 'check_violation';
    end if;
    if v_profile_business_unit_id is not null and not exists (
      select 1 from public.business_units bu
       where bu.id = v_profile_business_unit_id
         and bu.kind = 'BE'
         and bu.is_active = true
    ) then
      raise exception 'Назначенная заказчику БЕ должна быть действующей.'
        using errcode = 'check_violation';
    end if;
  elsif new.requester_id is distinct from old.requester_id then
    if new.business_unit_id is distinct from v_profile_business_unit_id then
      raise exception 'БЕ заявки должна совпадать с БЕ профиля заказчика (или обе должны быть пустыми).'
        using errcode = 'check_violation';
    end if;
    if v_profile_business_unit_id is not null and not exists (
      select 1 from public.business_units bu
       where bu.id = v_profile_business_unit_id
         and bu.kind = 'BE'
         and bu.is_active = true
    ) then
      raise exception 'Назначенная заказчику БЕ должна быть действующей.'
        using errcode = 'check_violation';
    end if;
  end if;

  select l.max_requests_per_month into v_limit
    from public.role_request_limits l
   where l.role = v_role;
  v_limit := coalesce(v_limit, 30);

  v_month_start := date_trunc('month', new.transport_date)::date;
  v_month_end := (v_month_start + interval '1 month')::date;

  perform pg_advisory_xact_lock(
    hashtextextended(new.requester_id::text || ':' || v_month_start::text, 0)
  );

  select count(*)::integer into v_count
    from public.transport_requests r
   where r.requester_id = new.requester_id
     and r.transport_date >= v_month_start
     and r.transport_date < v_month_end
     and r.status <> 'cancelled'
     and (TG_OP = 'INSERT' or r.id <> new.id);

  if v_count >= v_limit then
    raise exception 'Достигнут месячный лимит заявок для заказчика: % шт.', v_limit
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

-- Protect cargo rows too: staff cannot bypass the past-date restriction by
-- editing cargo lines while leaving the parent request fields unchanged.
create or replace function public.guard_staff_request_cargo_date()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request_id uuid;
  v_request_date date;
  v_actor_role public.app_role := public.current_role();
  v_today date := (now() at time zone 'Europe/Moscow')::date;
begin
  if v_actor_role in ('dispatcher', 'admin') then
    if TG_OP = 'DELETE' then
      v_request_id := old.request_id;
    else
      v_request_id := new.request_id;
    end if;

    select r.transport_date into v_request_date
      from public.transport_requests r
     where r.id = v_request_id;

    if v_request_date < v_today then
      raise exception 'Редактировать состав груза можно только для заявок на сегодня или будущую дату.'
        using errcode = 'check_violation';
    end if;
  end if;

  if TG_OP = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists guard_staff_request_cargo_date on public.request_cargo;
create trigger guard_staff_request_cargo_date
before insert or update or delete on public.request_cargo
for each row execute function public.guard_staff_request_cargo_date();

-- 5) Extend server-side audit snapshots with the two new request fields.
create or replace function public.log_request_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if TG_OP = 'INSERT' then
    insert into public.request_status_history(request_id, old_status, new_status, changed_by)
    values (new.id, null, new.status, auth.uid());
    insert into public.audit_log(actor_id, action, entity_type, entity_id, details)
    values (
      auth.uid(), 'create', 'transport_request', new.id,
      jsonb_build_object(
        'request_no', new.request_no, 'requester_id', new.requester_id,
        'business_unit_id', new.business_unit_id, 'date', new.transport_date,
        'slot', new.slot_number, 'from_unit_id', new.from_unit_id,
        'from_other_address', new.from_other_address, 'to_unit_id', new.to_unit_id,
        'to_other_address', new.to_other_address, 'capacity_tons', new.capacity_tons,
        'loading_type', new.loading_type, 'status', new.status,
        'transport_task_number', new.transport_task_number,
        'request_comment', new.request_comment
      )
    );
    return new;
  end if;

  if old.status is distinct from new.status then
    insert into public.request_status_history(request_id, old_status, new_status, changed_by)
    values (new.id, old.status, new.status, auth.uid());
  end if;

  if row(
      old.requester_id, old.business_unit_id, old.transport_date, old.slot_number,
      old.from_unit_id, old.from_other_address, old.to_unit_id, old.to_other_address,
      old.capacity_tons, old.loading_type, old.status, old.dispatcher_comment,
      old.transport_task_number, old.request_comment
    ) is distinct from row(
      new.requester_id, new.business_unit_id, new.transport_date, new.slot_number,
      new.from_unit_id, new.from_other_address, new.to_unit_id, new.to_other_address,
      new.capacity_tons, new.loading_type, new.status, new.dispatcher_comment,
      new.transport_task_number, new.request_comment
    ) then
    insert into public.audit_log(actor_id, action, entity_type, entity_id, details)
    values (
      auth.uid(),
      case when old.status is distinct from new.status then 'request_status_update' else 'request_update' end,
      'transport_request', new.id,
      jsonb_build_object(
        'request_no', new.request_no,
        'old', jsonb_build_object(
          'requester_id', old.requester_id, 'business_unit_id', old.business_unit_id,
          'date', old.transport_date, 'slot', old.slot_number,
          'from_unit_id', old.from_unit_id, 'from_other_address', old.from_other_address,
          'to_unit_id', old.to_unit_id, 'to_other_address', old.to_other_address,
          'capacity_tons', old.capacity_tons, 'loading_type', old.loading_type,
          'status', old.status, 'dispatcher_comment', old.dispatcher_comment,
          'transport_task_number', old.transport_task_number, 'request_comment', old.request_comment
        ),
        'new', jsonb_build_object(
          'requester_id', new.requester_id, 'business_unit_id', new.business_unit_id,
          'date', new.transport_date, 'slot', new.slot_number,
          'from_unit_id', new.from_unit_id, 'from_other_address', new.from_other_address,
          'to_unit_id', new.to_unit_id, 'to_other_address', new.to_other_address,
          'capacity_tons', new.capacity_tons, 'loading_type', new.loading_type,
          'status', new.status, 'dispatcher_comment', new.dispatcher_comment,
          'transport_task_number', new.transport_task_number, 'request_comment', new.request_comment
        )
      )
    );
  end if;
  return new;
end;
$$;

commit;
