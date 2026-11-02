-- Equipment cargo quantity in pallet places.
-- Safe to apply once on top of portal migrations 0001-0004.

alter table public.request_cargo
  add column if not exists equipment_pallet_places integer not null default 0;

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conname = 'request_cargo_equipment_pallet_places_check'
       and conrelid = 'public.request_cargo'::regclass
  ) then
    alter table public.request_cargo
      add constraint request_cargo_equipment_pallet_places_check
      check (equipment_pallet_places >= 0);
  end if;
end;
$$;

-- New equipment cargo rows must have a positive pallet-place quantity.
-- Existing historical equipment rows are preserved with 0 until they are edited.
create or replace function public.validate_equipment_pallet_places()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.cargo_type = 'equipment' and new.equipment_pallet_places <= 0 then
    raise exception 'Для груза «Оборудование» укажите количество грузомест в паллетоместах.';
  end if;
  if new.cargo_type <> 'equipment' then
    new.equipment_pallet_places := 0;
  end if;
  return new;
end;
$$;

drop trigger if exists request_cargo_validate_equipment_places on public.request_cargo;
create trigger request_cargo_validate_equipment_places
before insert or update on public.request_cargo
for each row execute function public.validate_equipment_pallet_places();

-- Include the new value in the existing audit trail for cargo changes.
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
      'old', case when TG_OP in ('UPDATE', 'DELETE') then jsonb_build_object(
        'cargo_type', old.cargo_type,
        'stock_pallets', old.stock_pallets,
        'kdk_pallets', old.kdk_pallets,
        'packaging_qty', old.packaging_qty,
        'equipment_pallet_places', old.equipment_pallet_places
      ) else null end,
      'new', case when TG_OP in ('INSERT', 'UPDATE') then jsonb_build_object(
        'cargo_type', new.cargo_type,
        'stock_pallets', new.stock_pallets,
        'kdk_pallets', new.kdk_pallets,
        'packaging_qty', new.packaging_qty,
        'equipment_pallet_places', new.equipment_pallet_places
      ) else null end
    )
  );
  if TG_OP = 'DELETE' then return old; end if;
  return new;
end;
$$;

revoke all on function public.validate_equipment_pallet_places() from public;
