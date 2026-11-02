-- Admin controls, booking rules and complete operational audit for Akson Transport Portal.
-- Apply after 0001_initial_schema.sql and 0002_admin_workspace.sql.
-- Run ONLY in the separate Transport Portal Supabase project.

-- 1) Configurable monthly request limits, one row for each application role.
create table if not exists public.role_request_limits (
  role public.app_role primary key,
  max_requests_per_month integer not null default 30
    check (max_requests_per_month between 1 and 10000),
  updated_at timestamptz not null default now()
);

insert into public.role_request_limits(role, max_requests_per_month)
values
  ('customer', 30),
  ('dispatcher', 30),
  ('utz', 30),
  ('admin', 30)
on conflict (role) do nothing;

-- 2) Global booking lead time. 0 = same-day booking, 1 = tomorrow or later, etc.
create table if not exists public.portal_settings (
  id boolean primary key default true check (id = true),
  booking_advance_days integer not null default 0
    check (booking_advance_days between 0 and 365),
  updated_at timestamptz not null default now()
);

insert into public.portal_settings(id, booking_advance_days)
values (true, 0)
on conflict (id) do nothing;

alter table public.role_request_limits enable row level security;
alter table public.portal_settings enable row level security;

drop policy if exists "authenticated read role request limits" on public.role_request_limits;
create policy "authenticated read role request limits"
  on public.role_request_limits for select to authenticated
  using (public.current_role() is not null);
drop policy if exists "admin manages role request limits" on public.role_request_limits;
create policy "admin manages role request limits"
  on public.role_request_limits for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists "authenticated read portal settings" on public.portal_settings;
create policy "authenticated read portal settings"
  on public.portal_settings for select to authenticated
  using (public.current_role() is not null);
drop policy if exists "admin manages portal settings" on public.portal_settings;
create policy "admin manages portal settings"
  on public.portal_settings for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

grant select, insert, update, delete on public.role_request_limits to authenticated;
grant select, insert, update, delete on public.portal_settings to authenticated;

-- Prevent changing BE/RC type when the directory entry is already referenced.
-- Code/name/address remain editable; a type conversion is safe only before first use.
create or replace function public.guard_business_unit_kind_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.kind is distinct from new.kind and (
    exists (select 1 from public.profiles p where p.business_unit_id = old.id or p.default_from_id = old.id)
    or exists (select 1 from public.transport_requests r where r.business_unit_id = old.id or r.from_unit_id = old.id or r.to_unit_id = old.id)
  ) then
    raise exception 'Нельзя менять тип БЕ/РЦ: запись уже используется в профилях или заявках.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists business_units_kind_guard on public.business_units;
create trigger business_units_kind_guard
before update of kind on public.business_units
for each row execute function public.guard_business_unit_kind_change();

-- 3) Allow an active customer selected by an administrator to own an admin-created request.
drop policy if exists "admin creates requests for customers" on public.transport_requests;
create policy "admin creates requests for customers"
  on public.transport_requests for insert to authenticated
  with check (
    public.is_admin()
    and exists (
      select 1
      from public.profiles p
      where p.id = requester_id
        and p.role = 'customer'
        and p.is_active = true
        and p.business_unit_id = transport_requests.business_unit_id
        and exists (
          select 1 from public.business_units bu
          where bu.id = transport_requests.business_unit_id
            and bu.kind = 'BE'
            and bu.is_active = true
        )
    )
  );

-- 4) Enforce advance booking and per-role monthly limits in the database.
-- Date arithmetic uses Moscow business time because the portal is intended for the
-- Akson Russia transport workflow; update the timezone here if the operating region changes.
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
  v_profile_business_unit_id uuid;
  v_count integer := 0;
  v_month_start date;
  v_month_end date;
begin
  if new.status = 'cancelled' then
    return new;
  end if;

  if TG_OP = 'UPDATE'
     and new.requester_id is not distinct from old.requester_id
     and new.transport_date is not distinct from old.transport_date
     and old.status <> 'cancelled' then
    -- Ordinary status changes do not consume quota. Re-activating a cancelled
    -- request is a new active booking and must be checked again below.
    return new;
  end if;

  select coalesce(s.booking_advance_days, 0)
    into v_advance_days
    from public.portal_settings s
   where s.id = true;
  v_advance_days := coalesce(v_advance_days, 0);

  if (TG_OP = 'INSERT'
      or new.transport_date is distinct from old.transport_date
      or (TG_OP = 'UPDATE' and old.status = 'cancelled'))
     and new.transport_date < ((now() at time zone 'Europe/Moscow')::date + v_advance_days) then
    raise exception 'Создание заявки доступно не ранее чем за % дн. до даты перевозки.', v_advance_days
      using errcode = 'check_violation';
  end if;

  select p.role, p.business_unit_id
    into v_role, v_profile_business_unit_id
    from public.profiles p
   where p.id = new.requester_id and p.is_active = true;
  if v_role is null or v_role <> 'customer' then
    raise exception 'Заявка должна принадлежать активному пользователю с ролью «Заказчик».' using errcode = 'check_violation';
  end if;
  if not exists (
    select 1 from public.business_units bu
     where bu.id = new.business_unit_id and bu.kind = 'BE' and bu.is_active = true
  ) then
    raise exception 'Для заявки необходимо выбрать действующую бизнес-единицу (БЕ).' using errcode = 'check_violation';
  end if;
  if (TG_OP = 'INSERT' or new.requester_id is distinct from old.requester_id)
     and v_profile_business_unit_id is distinct from new.business_unit_id then
    raise exception 'БЕ заявки должна совпадать с БЕ выбранного заказчика.' using errcode = 'check_violation';
  end if;

  select l.max_requests_per_month into v_limit
    from public.role_request_limits l
   where l.role = v_role;
  v_limit := coalesce(v_limit, 30);

  v_month_start := date_trunc('month', new.transport_date)::date;
  v_month_end := (v_month_start + interval '1 month')::date;

  -- Serialize creates for one customer/month so parallel requests cannot exceed the limit.
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
    raise exception 'Достигнут месячный лимит заявок для роли «%»: % шт.', v_role, v_limit
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists transport_requests_enforce_limits on public.transport_requests;
create trigger transport_requests_enforce_limits
before insert or update of requester_id, transport_date, status
on public.transport_requests
for each row execute function public.enforce_transport_request_limits();

-- 5) Audit helpers. The audit table remains write-protected for browser clients;
-- these SECURITY DEFINER triggers are the only database-side writers.
create or replace function public.audit_role_limit_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role public.app_role;
  v_action text;
begin
  v_role := coalesce(new.role, old.role);
  v_action := case when TG_OP = 'INSERT' then 'settings_create' when TG_OP = 'DELETE' then 'settings_delete' else 'settings_update' end;
  insert into public.audit_log(actor_id, action, entity_type, entity_id, details)
  values (
    auth.uid(), v_action, 'role_request_limit', null,
    jsonb_build_object(
      'role', v_role,
      'old_max_requests_per_month', case when TG_OP = 'UPDATE' then old.max_requests_per_month else null end,
      'new_max_requests_per_month', case when TG_OP = 'DELETE' then null else new.max_requests_per_month end
    )
  );
  if TG_OP = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists role_request_limits_audit on public.role_request_limits;
create trigger role_request_limits_audit
after insert or update or delete on public.role_request_limits
for each row execute function public.audit_role_limit_change();

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
      'new_booking_advance_days', case when TG_OP = 'DELETE' then null else new.booking_advance_days end
    )
  );
  if TG_OP = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists portal_settings_audit on public.portal_settings;
create trigger portal_settings_audit
after insert or update or delete on public.portal_settings
for each row execute function public.audit_portal_settings_change();

-- Directory: capture additions and every subsequent change, including activation/deactivation.
create or replace function public.audit_business_unit_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.audit_log(actor_id, action, entity_type, entity_id, details)
  values (
    auth.uid(),
    case when TG_OP = 'INSERT' then 'directory_create' when TG_OP = 'DELETE' then 'directory_delete' else 'directory_update' end,
    'business_unit', coalesce(new.id, old.id),
    jsonb_build_object(
      'old', case when TG_OP = 'UPDATE' then jsonb_build_object('code', old.code, 'name', old.name, 'kind', old.kind, 'address', old.address, 'is_active', old.is_active) else null end,
      'new', case when TG_OP = 'DELETE' then null else jsonb_build_object('code', new.code, 'name', new.name, 'kind', new.kind, 'address', new.address, 'is_active', new.is_active) end
    )
  );
  if TG_OP = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists business_units_audit on public.business_units;
create trigger business_units_audit
after insert or update or delete on public.business_units
for each row execute function public.audit_business_unit_change();

-- Profile edits done through this SQL/API path are also logged. The admin Edge Function
-- additionally writes an actor-aware entry because service-role calls have no auth.uid().
create or replace function public.audit_profile_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if TG_OP = 'INSERT' then
    if auth.uid() is not null then
      insert into public.audit_log(actor_id, action, entity_type, entity_id, details)
      values (auth.uid(), 'profile_create', 'profile', new.id,
        jsonb_build_object('username', new.username, 'role', new.role, 'business_unit_id', new.business_unit_id, 'default_from_id', new.default_from_id));
    end if;
    return new;
  end if;

  if old.username is distinct from new.username
     or old.role is distinct from new.role
     or old.business_unit_id is distinct from new.business_unit_id
     or old.default_from_id is distinct from new.default_from_id
     or old.is_active is distinct from new.is_active then
    if auth.uid() is not null then
      insert into public.audit_log(actor_id, action, entity_type, entity_id, details)
      values (
        auth.uid(), 'profile_update', 'profile', new.id,
        jsonb_build_object(
          'username', new.username,
          'old', jsonb_build_object('username', old.username, 'role', old.role, 'business_unit_id', old.business_unit_id, 'default_from_id', old.default_from_id, 'is_active', old.is_active),
          'new', jsonb_build_object('username', new.username, 'role', new.role, 'business_unit_id', new.business_unit_id, 'default_from_id', new.default_from_id, 'is_active', new.is_active)
        )
      );
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_audit_access_change on public.profiles;
drop trigger if exists profiles_audit_all_changes on public.profiles;
create trigger profiles_audit_all_changes
after insert or update on public.profiles
for each row execute function public.audit_profile_change();

-- Replace the initial request logger with a full before/after snapshot for request edits.
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
        'loading_type', new.loading_type, 'status', new.status
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
      old.capacity_tons, old.loading_type, old.status, old.dispatcher_comment
    ) is distinct from row(
      new.requester_id, new.business_unit_id, new.transport_date, new.slot_number,
      new.from_unit_id, new.from_other_address, new.to_unit_id, new.to_other_address,
      new.capacity_tons, new.loading_type, new.status, new.dispatcher_comment
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
          'status', old.status, 'dispatcher_comment', old.dispatcher_comment
        ),
        'new', jsonb_build_object(
          'requester_id', new.requester_id, 'business_unit_id', new.business_unit_id,
          'date', new.transport_date, 'slot', new.slot_number,
          'from_unit_id', new.from_unit_id, 'from_other_address', new.from_other_address,
          'to_unit_id', new.to_unit_id, 'to_other_address', new.to_other_address,
          'capacity_tons', new.capacity_tons, 'loading_type', new.loading_type,
          'status', new.status, 'dispatcher_comment', new.dispatcher_comment
        )
      )
    );
  end if;
  return new;
end;
$$;

-- Cargo is stored separately; log each row change with the parent request id.
create or replace function public.audit_request_cargo_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request_id uuid;
  v_action text;
begin
  v_request_id := coalesce(new.request_id, old.request_id);
  v_action := case when TG_OP = 'INSERT' then 'cargo_add' when TG_OP = 'DELETE' then 'cargo_remove' else 'cargo_update' end;
  insert into public.audit_log(actor_id, action, entity_type, entity_id, details)
  values (
    auth.uid(), v_action, 'request_cargo', v_request_id,
    jsonb_build_object(
      'old', case when TG_OP in ('UPDATE', 'DELETE') then jsonb_build_object('cargo_type', old.cargo_type, 'stock_pallets', old.stock_pallets, 'kdk_pallets', old.kdk_pallets, 'packaging_qty', old.packaging_qty) else null end,
      'new', case when TG_OP in ('INSERT', 'UPDATE') then jsonb_build_object('cargo_type', new.cargo_type, 'stock_pallets', new.stock_pallets, 'kdk_pallets', new.kdk_pallets, 'packaging_qty', new.packaging_qty) else null end
    )
  );
  if TG_OP = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists request_cargo_audit on public.request_cargo;
create trigger request_cargo_audit
after insert or update or delete on public.request_cargo
for each row execute function public.audit_request_cargo_change();

-- Keep history available to administrators only; no browser insert/update/delete access.
drop policy if exists "staff reads audit log" on public.audit_log;
drop policy if exists "admin reads audit log" on public.audit_log;
create policy "admin reads audit log" on public.audit_log
for select to authenticated using (public.is_admin());
grant select on public.audit_log to authenticated;

create index if not exists audit_log_created_at_id_idx
  on public.audit_log(created_at desc, id desc);
create index if not exists audit_log_entity_created_at_idx
  on public.audit_log(entity_type, created_at desc, id desc);

-- Search and filter the complete journal on the server, not only the loaded page.
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
  if not public.is_admin() then
    raise exception 'Доступ запрещён: требуется роль администратора.' using errcode = 'insufficient_privilege';
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

revoke all on function public.admin_search_audit(text, text, date, date, integer, integer) from public;
grant execute on function public.admin_search_audit(text, text, date, date, integer, integer) to authenticated;

-- Trigger functions are not intended to be called directly by end users.
revoke all on function public.enforce_transport_request_limits() from public;
revoke all on function public.audit_role_limit_change() from public;
revoke all on function public.audit_portal_settings_change() from public;
revoke all on function public.audit_business_unit_change() from public;
revoke all on function public.guard_business_unit_kind_change() from public;
revoke all on function public.audit_profile_change() from public;
revoke all on function public.audit_request_cargo_change() from public;

-- Save all editable rules in one transaction and only for an administrator.
create or replace function public.admin_save_portal_settings(
  p_booking_advance_days integer,
  p_role_limits jsonb
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_role public.app_role;
  v_limit integer;
begin
  if not public.is_admin() then
    raise exception 'Доступ запрещён: требуется роль администратора.' using errcode = 'insufficient_privilege';
  end if;
  if p_booking_advance_days is null or p_booking_advance_days < 0 or p_booking_advance_days > 365 then
    raise exception 'Срок предварительной записи должен быть от 0 до 365 дней.' using errcode = 'check_violation';
  end if;
  if p_role_limits is null or jsonb_typeof(p_role_limits) <> 'object' then
    raise exception 'Не переданы лимиты заявок по ролям.' using errcode = 'invalid_parameter_value';
  end if;

  update public.portal_settings
     set booking_advance_days = p_booking_advance_days,
         updated_at = now()
   where id = true;

  foreach v_role in array enum_range(null::public.app_role) loop
    begin
      v_limit := (p_role_limits ->> v_role::text)::integer;
    exception when others then
      raise exception 'Не задан корректный месячный лимит для роли %.', v_role
        using errcode = 'invalid_parameter_value';
    end;
    if v_limit is null or v_limit < 1 or v_limit > 10000 then
      raise exception 'Месячный лимит для роли % должен быть от 1 до 10000.', v_role
        using errcode = 'check_violation';
    end if;
    insert into public.role_request_limits(role, max_requests_per_month, updated_at)
    values (v_role, v_limit, now())
    on conflict (role) do update
      set max_requests_per_month = excluded.max_requests_per_month,
          updated_at = excluded.updated_at
      where public.role_request_limits.max_requests_per_month is distinct from excluded.max_requests_per_month;
  end loop;
end;
$$;

revoke all on function public.admin_save_portal_settings(integer, jsonb) from public;
grant execute on function public.admin_save_portal_settings(integer, jsonb) to authenticated;
