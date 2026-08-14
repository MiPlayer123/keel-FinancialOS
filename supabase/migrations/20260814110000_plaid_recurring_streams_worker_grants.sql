-- Phase 1 follow-up: the ingest proc is SECURITY DEFINER owned by keel_worker,
-- but 20260814100000 granted the new tables only to authenticated/service_role
-- — so the definer role had neither table privileges nor an RLS policy and the
-- first live call failed with `permission denied for table
-- plaid_recurring_streams`. Same grant+definer-policy pair the core-sweep
-- suppressions table already carries (20260725000000 L155-166).
grant select, insert, update on public.plaid_recurring_streams to keel_worker;
grant select on public.plaid_recurring_allowlist to keel_worker;

drop policy if exists plaid_recurring_streams_definer_all on public.plaid_recurring_streams;
create policy plaid_recurring_streams_definer_all on public.plaid_recurring_streams
  for all to keel_worker using (true) with check (true);

drop policy if exists plaid_recurring_allowlist_definer_read on public.plaid_recurring_allowlist;
create policy plaid_recurring_allowlist_definer_read on public.plaid_recurring_allowlist
  for select to keel_worker using (true);
