-- Broadcast a minimal refresh signal whenever a request changes.
-- The payload contains no customer, route, cargo, registry or request details.
-- Every connected role reloads data through its own existing RLS/RPC permissions.

begin;

-- Private Realtime channels require an explicit SELECT policy.
drop policy if exists "authenticated receive transport calendar refresh" on realtime.messages;
create policy "authenticated receive transport calendar refresh"
  on realtime.messages
  for select
  to authenticated
  using (
    extension = 'broadcast'
    and realtime.topic() = 'transport-calendar'
  );

create or replace function public.broadcast_transport_calendar_refresh()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  begin
    perform realtime.send(
      jsonb_build_object('refresh', true),
      'transport-request-updated',
      'transport-calendar',
      true
    );
  exception when others then
    -- A Realtime delivery issue must never roll back the business transaction.
    raise warning 'Не удалось отправить сигнал обновления календаря: %', SQLERRM;
  end;

  if TG_OP = 'DELETE' then
    return OLD;
  end if;
  return NEW;
end;
$$;

revoke all on function public.broadcast_transport_calendar_refresh() from public;

drop trigger if exists transport_requests_realtime_refresh on public.transport_requests;
create trigger transport_requests_realtime_refresh
after insert or update or delete on public.transport_requests
for each row execute function public.broadcast_transport_calendar_refresh();

-- Cargo lines are saved immediately after the parent request. Notify again
-- after these rows change so open request cards also refresh with the new cargo.
drop trigger if exists request_cargo_realtime_refresh on public.request_cargo;
create trigger request_cargo_realtime_refresh
after insert or update or delete on public.request_cargo
for each row execute function public.broadcast_transport_calendar_refresh();

commit;
