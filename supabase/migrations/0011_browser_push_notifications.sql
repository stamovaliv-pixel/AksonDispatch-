-- In-app notifications + browser push subscriptions for Akson Dispatch.
-- Apply after migrations 0001-0010.

begin;

create table if not exists public.user_notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  request_id uuid references public.transport_requests(id) on delete set null,
  notification_type text not null check (notification_type in ('new_request','request_cancelled','request_updated','status_changed')),
  title text not null,
  body text not null,
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index if not exists user_notifications_user_created_idx
  on public.user_notifications(user_id, created_at desc);

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists push_subscriptions_user_idx on public.push_subscriptions(user_id);

alter table public.user_notifications enable row level security;
alter table public.push_subscriptions enable row level security;

revoke all on public.user_notifications from anon, authenticated;
grant select on public.user_notifications to authenticated;
grant update(read_at) on public.user_notifications to authenticated;

drop policy if exists "users read own notifications" on public.user_notifications;
create policy "users read own notifications"
  on public.user_notifications for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "users mark own notifications read" on public.user_notifications;
create policy "users mark own notifications read"
  on public.user_notifications for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- Push subscriptions are written only through the SECURITY DEFINER RPC below.
revoke all on public.push_subscriptions from anon, authenticated;

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
  if length(coalesce(p_endpoint, '')) < 30 or length(coalesce(p_endpoint, '')) > 4000
     or length(coalesce(p_p256dh, '')) < 20 or length(coalesce(p_auth, '')) < 10 then
    raise exception 'Invalid push subscription';
  end if;
  if not exists (
    select 1 from public.profiles p where p.id = v_user_id and p.is_active = true
  ) then
    raise exception 'Active profile required' using errcode = '42501';
  end if;

  -- One browser endpoint belongs to one currently signed-in account only.
  delete from public.push_subscriptions where endpoint = p_endpoint;
  insert into public.push_subscriptions(user_id, endpoint, p256dh, auth, updated_at)
  values (v_user_id, p_endpoint, p_p256dh, p_auth, now());
end;
$$;
revoke all on function public.register_push_subscription(text,text,text) from public, anon;
grant execute on function public.register_push_subscription(text,text,text) to authenticated;

create or replace function public.notify_transport_request_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_date text;
  v_title text;
  v_body text;
  v_type text;
begin
  v_date := to_char(new.transport_date, 'DD.MM.YYYY');

  if tg_op = 'INSERT' then
    v_type := 'new_request';
    v_title := 'Новая транспортная заявка';
    v_body := 'Заявка №' || new.request_no::text || ' на ' || v_date || ' создана.';

    insert into public.user_notifications(user_id, request_id, notification_type, title, body)
    select p.id, new.id, v_type, v_title, v_body
    from public.profiles p
    where p.is_active = true
      and p.role in ('dispatcher'::public.app_role, 'admin'::public.app_role)
      and p.id is distinct from v_actor;

    -- When staff creates a request on behalf of a customer, inform that customer too.
    if new.requester_id is distinct from v_actor then
      insert into public.user_notifications(user_id, request_id, notification_type, title, body)
      values (new.requester_id, new.id, 'new_request', 'Заявка создана от вашего имени',
              'Заявка №' || new.request_no::text || ' на ' || v_date || ' создана.');
    end if;

  elsif new.status is distinct from old.status then
    if new.status = 'cancelled' and v_actor is not distinct from old.requester_id then
      v_type := 'request_cancelled';
      v_title := 'Заявка отменена заказчиком';
      v_body := 'Заявка №' || new.request_no::text || ' на ' || v_date || ' отменена.';
      insert into public.user_notifications(user_id, request_id, notification_type, title, body)
      select p.id, new.id, v_type, v_title, v_body
      from public.profiles p
      where p.is_active = true
        and p.role in ('dispatcher'::public.app_role, 'admin'::public.app_role)
        and p.id is distinct from v_actor;
    elsif new.requester_id is distinct from v_actor then
      insert into public.user_notifications(user_id, request_id, notification_type, title, body)
      values (new.requester_id, new.id, 'status_changed', 'Изменён статус транспортной заявки',
              'По заявке №' || new.request_no::text || ' на ' || v_date || ' установлен статус: ' ||
              case new.status::text
                when 'created' then 'Создана'
                when 'search' then 'Поиск транспорта'
                when 'confirmed' then 'Подтверждена'
                when 'completed' then 'Выполнена'
                when 'cancelled' then 'Отменена'
                else new.status::text
              end || '.');
    else
      v_type := 'request_updated';
      v_title := 'Изменена транспортная заявка';
      v_body := 'По заявке №' || new.request_no::text || ' на ' || v_date || ' внесены изменения.';
      insert into public.user_notifications(user_id, request_id, notification_type, title, body)
      select p.id, new.id, v_type, v_title, v_body
      from public.profiles p
      where p.is_active = true
        and p.role in ('dispatcher'::public.app_role, 'admin'::public.app_role)
        and p.id is distinct from v_actor;
    end if;

  elsif v_actor is not distinct from new.requester_id then
    v_type := 'request_updated';
    v_title := 'Заказчик изменил заявку';
    v_body := 'В заявке №' || new.request_no::text || ' на ' || v_date || ' внесены изменения.';
    insert into public.user_notifications(user_id, request_id, notification_type, title, body)
    select p.id, new.id, v_type, v_title, v_body
    from public.profiles p
    where p.is_active = true
      and p.role in ('dispatcher'::public.app_role, 'admin'::public.app_role)
      and p.id is distinct from v_actor;

  elsif new.requester_id is distinct from v_actor then
    insert into public.user_notifications(user_id, request_id, notification_type, title, body)
    values (new.requester_id, new.id, 'request_updated', 'Изменена ваша транспортная заявка',
            'В заявке №' || new.request_no::text || ' на ' || v_date || ' внесены изменения.');
  end if;

  return new;
end;
$$;
revoke all on function public.notify_transport_request_change() from public, anon, authenticated;

drop trigger if exists transport_request_create_notifications on public.transport_requests;
create trigger transport_request_create_notifications
after insert or update on public.transport_requests
for each row execute function public.notify_transport_request_change();

-- Private per-user Realtime channel. Payload contains only the notification id.
drop policy if exists "users receive own notification broadcasts" on realtime.messages;
create policy "users receive own notification broadcasts"
  on realtime.messages for select to authenticated
  using (
    extension = 'broadcast'
    and realtime.topic() = 'user-notifications:' || (select auth.uid())::text
  );

create or replace function public.broadcast_user_notification()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  begin
    perform realtime.send(
      jsonb_build_object('id', new.id),
      'user-notification-created',
      'user-notifications:' || new.user_id::text,
      true
    );
  exception when others then
    raise warning 'Не удалось отправить realtime-уведомление: %', SQLERRM;
  end;
  return new;
end;
$$;
revoke all on function public.broadcast_user_notification() from public, anon, authenticated;

drop trigger if exists user_notification_realtime_broadcast on public.user_notifications;
create trigger user_notification_realtime_broadcast
after insert on public.user_notifications
for each row execute function public.broadcast_user_notification();

commit;
