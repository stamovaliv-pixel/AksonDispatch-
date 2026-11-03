-- v0.4.6: explicit private registry download access for all authorized roles.
-- Customers can read files attached to their own requests only.
-- Dispatcher, UTZ and administrator can read files attached to all requests.
drop policy if exists "dispatch files read" on storage.objects;
create policy "dispatch files read"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'dispatch-files'
    and (
      (
        split_part(name, '/', 1) = 'templates'
        and public.current_role() in ('customer', 'dispatcher', 'utz', 'admin')
      )
      or (
        split_part(name, '/', 1) = 'requests'
        and exists (
          select 1
            from public.transport_requests r
           where r.id::text = split_part(name, '/', 2)
             and (
               (public.current_role() = 'customer' and r.requester_id = auth.uid())
               or public.current_role() in ('dispatcher', 'utz', 'admin')
             )
        )
      )
    )
  );
