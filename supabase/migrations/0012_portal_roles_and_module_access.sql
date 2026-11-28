-- ПУЛЬС: порталная ролевая модель и доступ к модулям.
-- Применять ПОСЛЕ миграции 0011 в Supabase именно проекта ПУЛЬС.
-- Существующая операционная роль profiles.role и логика заявок сохраняются.

begin;

-- 1. Отделяем роль портала от прежней операционной роли.
alter table public.profiles
  add column if not exists portal_role text,
  add column if not exists position_title text;

update public.profiles
   set portal_role = role::text
 where portal_role is null;

alter table public.profiles alter column portal_role set not null;

alter table public.profiles
  drop constraint if exists profiles_portal_role_check;
alter table public.profiles
  add constraint profiles_portal_role_check
  check (portal_role in ('super_admin','admin','technician','utz','dispatcher','be','customer'));

alter table public.profiles
  drop constraint if exists profiles_dispatcher_position_check;
alter table public.profiles
  add constraint profiles_dispatcher_position_check
  check (
    position_title is null
    or (
      portal_role = 'dispatcher'
      and position_title in ('Диспетчер','Руководитель РЦ','Старший смены РЦ')
    )
  );

create index if not exists profiles_portal_role_active_idx
  on public.profiles(portal_role, is_active);

-- Текущая роль портала. Используется для серверной проверки доступа к модулям.
create or replace function public.current_portal_role()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(p.portal_role, p.role::text)
    from public.profiles p
   where p.id = auth.uid()
     and p.is_active = true
$$;

revoke all on function public.current_portal_role() from public;
grant execute on function public.current_portal_role() to authenticated;

-- Суперадминистратор сохраняет совместимость со старыми admin-проверками.
-- Техник и БЕ намеренно не получают операционную роль заявок на этом этапе.
create or replace function public.current_role()
returns public.app_role
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when coalesce(p.portal_role, p.role::text) in ('technician','be') then null::public.app_role
    when coalesce(p.portal_role, p.role::text) = 'super_admin' then 'admin'::public.app_role
    else p.role
  end
    from public.profiles p
   where p.id = auth.uid()
     and p.is_active = true
$$;

revoke all on function public.current_role() from public;
grant execute on function public.current_role() to authenticated;

create or replace function public.is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(public.current_portal_role() = 'super_admin', false)
$$;

revoke all on function public.is_super_admin() from public;
grant execute on function public.is_super_admin() to authenticated;

-- 2. Матрица разрешённых модулей. Отсутствующая строка означает запрет.
create table if not exists public.portal_role_modules (
  role_key text not null check (role_key in ('super_admin','admin','technician','utz','dispatcher','be','customer')),
  module_key text not null check (module_key in ('requests','dispatcher-journal','client-delivery','warehouse-logistics','rc-shipment')),
  is_enabled boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (role_key, module_key)
);

insert into public.portal_role_modules(role_key, module_key, is_enabled) values
  ('super_admin','requests',true), ('super_admin','dispatcher-journal',true), ('super_admin','client-delivery',true), ('super_admin','warehouse-logistics',true), ('super_admin','rc-shipment',true),
  ('admin','requests',true), ('admin','dispatcher-journal',true), ('admin','client-delivery',true), ('admin','warehouse-logistics',true), ('admin','rc-shipment',true),
  ('technician','client-delivery',true), ('technician','warehouse-logistics',true),
  ('utz','requests',true),
  ('dispatcher','requests',true), ('dispatcher','dispatcher-journal',true), ('dispatcher','rc-shipment',true),
  ('be','requests',true), ('be','client-delivery',true), ('be','warehouse-logistics',true),
  ('customer','requests',true)
on conflict (role_key, module_key) do update
  set is_enabled = excluded.is_enabled,
      updated_at = now();

alter table public.portal_role_modules enable row level security;
drop policy if exists "users read own portal module access" on public.portal_role_modules;
create policy "users read own portal module access"
  on public.portal_role_modules for select to authenticated
  using (role_key = public.current_portal_role());
drop policy if exists "super admin manages portal module access" on public.portal_role_modules;
create policy "super admin manages portal module access"
  on public.portal_role_modules for all to authenticated
  using (public.is_super_admin())
  with check (public.is_super_admin());

grant select, insert, update, delete on public.portal_role_modules to authenticated;

create or replace function public.has_portal_module_access(p_module_key text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.profiles p
      join public.portal_role_modules prm
        on prm.role_key = coalesce(p.portal_role, p.role::text)
     where p.id = auth.uid()
       and p.is_active = true
       and prm.module_key = p_module_key
       and prm.is_enabled = true
  )
$$;

revoke all on function public.has_portal_module_access(text) from public;
grant execute on function public.has_portal_module_access(text) to authenticated;

-- 3. Убираем широкое клиентское UPDATE профиля. Клиент может менять только
-- is_active через отдельную policy; роли и привязки меняют Edge Functions.
drop policy if exists "admin manages profiles" on public.profiles;
drop policy if exists "admin toggles account status" on public.profiles;
revoke update on public.profiles from authenticated;
grant update (is_active) on public.profiles to authenticated;
create policy "admin toggles account status"
  on public.profiles for update to authenticated
  using (
    public.is_admin()
    and (public.is_super_admin() or coalesce(portal_role, role::text) <> 'super_admin')
    and id <> auth.uid()
  )
  with check (
    public.is_admin()
    and (public.is_super_admin() or coalesce(portal_role, role::text) <> 'super_admin')
    and id <> auth.uid()
  );

-- 4. Защищаем старый операционный контур заявок от новых portal-only ролей.
-- Для всех прежних ролей условия эквивалентны их действующим разрешениям.
drop policy if exists "request visibility" on public.transport_requests;
create policy "request visibility"
  on public.transport_requests for select to authenticated
  using (
    public.current_role() is not null
    and (requester_id = auth.uid() or public.is_staff())
  );

drop policy if exists "request owner or staff updates" on public.transport_requests;
create policy "request owner or staff updates"
  on public.transport_requests for update to authenticated
  using (
    public.current_role() is not null
    and (requester_id = auth.uid() or public.is_staff())
  )
  with check (
    public.current_role() is not null
    and (public.is_staff() or (requester_id = auth.uid() and status = 'created'))
  );

drop policy if exists "role based request updates" on public.transport_requests;
create policy "role based request updates"
  on public.transport_requests for update to authenticated
  using (
    public.current_role() is not null
    and (
      public.can_operate_transport_requests()
      or (public.current_role() = 'customer' and requester_id = auth.uid() and status not in ('completed','cancelled'))
    )
  )
  with check (
    public.current_role() is not null
    and (
      public.can_operate_transport_requests()
      or (public.current_role() = 'customer' and requester_id = auth.uid() and status in ('created','search','confirmed','cancelled'))
    )
  );

-- Администратор и диспетчер по-прежнему могут оформлять заявку для заказчика,
-- но только для профиля именно с portal_role=customer.
drop policy if exists "admin creates requests for customers" on public.transport_requests;
create policy "admin creates requests for customers"
  on public.transport_requests for insert to authenticated
  with check (
    public.is_admin()
    and exists (
      select 1 from public.profiles p
       where p.id = requester_id
         and p.role = 'customer'
         and coalesce(p.portal_role, p.role::text) = 'customer'
         and p.is_active = true
         and p.business_unit_id is not distinct from transport_requests.business_unit_id
         and (
           p.business_unit_id is null
           or exists (
             select 1 from public.business_units bu
              where bu.id = p.business_unit_id and bu.kind = 'BE' and bu.is_active = true
           )
         )
    )
  );

drop policy if exists "dispatcher creates requests for customers" on public.transport_requests;
create policy "dispatcher creates requests for customers"
  on public.transport_requests for insert to authenticated
  with check (
    public.current_role() = 'dispatcher'
    and exists (
      select 1 from public.profiles p
       where p.id = requester_id
         and p.role = 'customer'
         and coalesce(p.portal_role, p.role::text) = 'customer'
         and p.is_active = true
         and p.business_unit_id is not distinct from transport_requests.business_unit_id
         and (
           p.business_unit_id is null
           or exists (
             select 1 from public.business_units bu
              where bu.id = p.business_unit_id and bu.kind = 'BE' and bu.is_active = true
           )
         )
    )
  );

-- Серверная защита от назначения техника/БЕ владельцем транспортной заявки,
-- включая действия сервисной роли или будущих серверных интеграций.
create or replace function public.guard_requester_portal_role()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role text;
  v_active boolean;
begin
  select coalesce(p.portal_role, p.role::text), p.is_active
    into v_role, v_active
    from public.profiles p
   where p.id = new.requester_id;

  if v_role is distinct from 'customer' or v_active is distinct from true then
    raise exception 'Владельцем транспортной заявки может быть только активный пользователь с ролью «Заказчик».'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

drop trigger if exists transport_requests_guard_requester_portal_role on public.transport_requests;
create trigger transport_requests_guard_requester_portal_role
before insert or update of requester_id on public.transport_requests
for each row execute function public.guard_requester_portal_role();

-- Данные заявок, cargo, история и комментарии доступны только пользователям,
-- у которых есть legacy operational role. Это не даёт technician/BE читать
-- старые заявки только потому, что их legacy fallback role = customer.
drop policy if exists "cargo read via request" on public.request_cargo;
create policy "cargo read via request"
  on public.request_cargo for select to authenticated
  using (
    public.current_role() is not null
    and exists (
      select 1 from public.transport_requests r
       where r.id = request_id
         and (r.requester_id = auth.uid() or public.is_staff())
    )
  );

drop policy if exists "history read via request" on public.request_status_history;
create policy "history read via request"
  on public.request_status_history for select to authenticated
  using (
    public.current_role() is not null
    and exists (
      select 1 from public.transport_requests r
       where r.id = request_id
         and (r.requester_id = auth.uid() or public.is_staff())
    )
  );

drop policy if exists "comments read via request" on public.request_comments;
create policy "comments read via request"
  on public.request_comments for select to authenticated
  using (
    public.current_role() is not null
    and exists (
      select 1 from public.transport_requests r
       where r.id = request_id
         and (r.requester_id = auth.uid() or public.is_staff())
    )
  );

-- Обновляем policies файлов, включая загрузку и удаление вложений заявок.
drop policy if exists "dispatch files read" on storage.objects;
create policy "dispatch files read"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'dispatch-files'
    and public.current_role() is not null
    and (
      (split_part(name, '/', 1) = 'templates' and public.current_role() in ('customer','dispatcher','utz','admin'))
      or (
        split_part(name, '/', 1) = 'requests'
        and exists (
          select 1 from public.transport_requests r
           where r.id::text = split_part(name, '/', 2)
             and (r.requester_id = auth.uid() and public.current_role() = 'customer' or public.current_role() in ('dispatcher','utz','admin'))
        )
      )
    )
  );

drop policy if exists "dispatch files insert" on storage.objects;
create policy "dispatch files insert"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'dispatch-files'
    and public.current_role() is not null
    and (
      (split_part(name, '/', 1) = 'templates' and public.is_admin())
      or (
        split_part(name, '/', 1) = 'requests'
        and exists (
          select 1 from public.transport_requests r
           where r.id::text = split_part(name, '/', 2)
             and (
               public.can_operate_transport_requests()
               or (public.current_role() = 'customer' and r.requester_id = auth.uid() and r.status not in ('completed','cancelled'))
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
    and public.current_role() is not null
    and (
      (split_part(name, '/', 1) = 'templates' and public.is_admin())
      or (
        split_part(name, '/', 1) = 'requests'
        and exists (
          select 1 from public.transport_requests r
           where r.id::text = split_part(name, '/', 2)
             and (
               public.can_operate_transport_requests()
               or (public.current_role() = 'customer' and r.requester_id = auth.uid() and r.status not in ('completed','cancelled'))
             )
        )
      )
    )
  );


-- У пользователей новых portal-only ролей пока нет старых заявочных уведомлений.
-- Не выдаём им чтение/изменение записей user_notifications до включения соответствующих модулей.
drop policy if exists "users read own notifications" on public.user_notifications;
create policy "users read own notifications"
  on public.user_notifications for select to authenticated
  using (user_id = auth.uid() and public.current_role() is not null);

drop policy if exists "users mark own notifications read" on public.user_notifications;
create policy "users mark own notifications read"
  on public.user_notifications for update to authenticated
  using (user_id = auth.uid() and public.current_role() is not null)
  with check (user_id = auth.uid() and public.current_role() is not null);


-- 5. Portal-only roles do not use the legacy dispatch push/realtime channels.
-- Keep the old notification flow unchanged for existing operational roles.
drop policy if exists "users receive own notification broadcasts" on realtime.messages;
create policy "users receive own notification broadcasts"
  on realtime.messages for select to authenticated
  using (
    extension = 'broadcast'
    and public.current_role() is not null
    and realtime.topic() = 'user-notifications:' || (select auth.uid())::text
  );

drop policy if exists "authenticated receive transport calendar refresh" on realtime.messages;
create policy "authenticated receive transport calendar refresh"
  on realtime.messages for select to authenticated
  using (
    extension = 'broadcast'
    and public.current_role() is not null
    and realtime.topic() = 'transport-calendar'
  );

create or replace function public.guard_legacy_push_subscription_role()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.portal_role in ('technician','be') then
    delete from public.push_subscriptions where user_id = new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_guard_legacy_push_subscription_role on public.profiles;
create trigger profiles_guard_legacy_push_subscription_role
after insert or update of portal_role on public.profiles
for each row execute function public.guard_legacy_push_subscription_role();

create or replace function public.register_push_subscription(
  p_endpoint text,
  p_p256dh text,
  p_auth text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if public.current_role() is null then
    raise exception 'This portal role cannot subscribe to legacy dispatch notifications.' using errcode = '42501';
  end if;
  if length(coalesce(p_endpoint, '')) < 30 or length(coalesce(p_endpoint, '')) > 4000
     or length(coalesce(p_p256dh, '')) < 20 or length(coalesce(p_auth, '')) < 10 then
    raise exception 'Invalid push subscription';
  end if;
  if not exists (
    select 1 from public.profiles p where p.id = v_user_id and p.is_active = true
  ) then
    raise exception 'Active profile required' using errcode = '42501';
  end if;

  delete from public.push_subscriptions where endpoint = p_endpoint;
  insert into public.push_subscriptions(user_id, endpoint, p256dh, auth, updated_at)
  values (v_user_id, p_endpoint, p_p256dh, p_auth, now());
end;
$$;
revoke all on function public.register_push_subscription(text,text,text) from public, anon;
grant execute on function public.register_push_subscription(text,text,text) to authenticated;

commit;
