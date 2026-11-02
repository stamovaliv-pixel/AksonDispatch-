-- AksonDispatch v0.4.3
-- Optional BE assignment for customer accounts and optional request registry files.
-- Apply after migrations 0001-0005 in the Transport Portal Supabase project.

begin;

-- 1) Customer profile BE is optional. A request still requires an explicit route
-- (from_unit_id/from_other_address and to_unit_id/to_other_address).
alter table public.transport_requests
  alter column business_unit_id drop not null;

-- Registry attachment metadata is stored on the request; the file itself is in
-- the private Storage bucket below.
alter table public.transport_requests
  add column if not exists registry_file_path text,
  add column if not exists registry_file_name text;

alter table public.portal_settings
  add column if not exists registry_template_path text,
  add column if not exists registry_template_name text;

-- 2) Insert policy for customers now accepts a NULL customer BE but requires
-- the request snapshot to match the profile assignment exactly (including NULL).
drop policy if exists "customer creates own request" on public.transport_requests;
create policy "customer creates own request"
  on public.transport_requests for insert to authenticated
  with check (
    requester_id = auth.uid()
    and public.current_role() = 'customer'
    and business_unit_id is not distinct from (
      select p.business_unit_id from public.profiles p
       where p.id = auth.uid() and p.is_active = true
    )
    and (
      business_unit_id is null
      or exists (
        select 1 from public.business_units bu
         where bu.id = business_unit_id and bu.kind = 'BE' and bu.is_active = true
      )
    )
  );

-- Admin-created requests must also support a customer without profile BE.
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

-- Customer may continue editing/cancelling their own created request even if
-- their profile BE was changed after that request was originally created.
-- The guard trigger from migration 0004 keeps business_unit_id immutable.
drop policy if exists "role based request updates" on public.transport_requests;
create policy "role based request updates"
  on public.transport_requests for update to authenticated
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
    )
  );

-- 3) Replace the monthly/advance-time trigger so a missing profile BE is valid.
-- If the profile has a BE, new requests must use that active BE. If the profile
-- has no BE, new requests must store NULL in business_unit_id.
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
    raise exception 'Заявка должна принадлежать активному пользователю с ролью «Заказчик».'
      using errcode = 'check_violation';
  end if;

  -- Validate the customer-BE snapshot on new requests and when changing owner.
  if TG_OP = 'INSERT' or new.requester_id is distinct from old.requester_id then
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
    raise exception 'Достигнут месячный лимит заявок для роли «%»: % шт.', v_role, v_limit
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

-- 4) Private storage bucket for templates and request-level registries.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'dispatch-files',
  'dispatch-files',
  false,
  20971520,
  array[
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel',
    'text/csv',
    'application/csv',
    'application/vnd.oasis.opendocument.spreadsheet',
    'application/octet-stream'
  ]::text[]
)
on conflict (id) do update
set public = false,
    file_size_limit = 20971520,
    allowed_mime_types = excluded.allowed_mime_types;

-- Templates can be downloaded by all active portal users, but only admins
-- can upload, replace or remove the current template.
drop policy if exists "dispatch files read" on storage.objects;
create policy "dispatch files read"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'dispatch-files'
    and (
      (split_part(name, '/', 1) = 'templates' and public.current_role() is not null)
      or (
        split_part(name, '/', 1) = 'requests'
        and exists (
          select 1 from public.transport_requests r
           where r.id::text = split_part(name, '/', 2)
             and (r.requester_id = auth.uid() or public.is_staff())
        )
      )
    )
  );

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
               or (public.current_role() = 'customer' and r.requester_id = auth.uid() and r.status = 'created')
             )
        )
      )
    )
  );

drop policy if exists "dispatch template update" on storage.objects;
create policy "dispatch template update"
  on storage.objects for update to authenticated
  using (bucket_id = 'dispatch-files' and split_part(name, '/', 1) = 'templates' and public.is_admin())
  with check (bucket_id = 'dispatch-files' and split_part(name, '/', 1) = 'templates' and public.is_admin());

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
               or (public.current_role() = 'customer' and r.requester_id = auth.uid() and r.status = 'created')
             )
        )
      )
    )
  );

-- Template metadata is included in the existing settings audit record.
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
      'new_registry_template_name', case when TG_OP = 'DELETE' then null else new.registry_template_name end
    )
  );
  if TG_OP = 'DELETE' then return old; end if;
  return new;
end;
$$;

-- Audit a request registry attachment without exposing storage object paths.
create or replace function public.audit_request_registry_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.registry_file_path is distinct from new.registry_file_path
     or old.registry_file_name is distinct from new.registry_file_name then
    insert into public.audit_log(actor_id, action, entity_type, entity_id, details)
    values (
      auth.uid(),
      'request_registry_update',
      'transport_request',
      new.id,
      jsonb_build_object(
        'request_no', new.request_no,
        'old_registry_file_name', old.registry_file_name,
        'new_registry_file_name', new.registry_file_name
      )
    );
  end if;
  return new;
end;
$$;

drop trigger if exists requests_registry_audit on public.transport_requests;
create trigger requests_registry_audit
after update of registry_file_path, registry_file_name on public.transport_requests
for each row execute function public.audit_request_registry_change();

commit;
