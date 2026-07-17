-- S-inv-1b (docs/harness/plans/investments-v1.md, part of INVEST-1): Plaid
-- Investments holdings sync. Worker-only (service_role), mirroring
-- keel_apply_account_balance's grant shape -- no user JWT reaches this
-- path, so no keel_assert_member_write/auth.uid() check; trust is the
-- worker's own automations-secret auth (withSupabase auth:
-- 'secret:automations' in worker/index.ts), same as every other
-- worker-invoked proc.
--
-- Deliberately does NOT reuse the transaction-sync machinery
-- (reconcileSyncBatch / canonical_transactions / journal_batches):
-- holdings are a snapshot to replace, not a balanced economic event, and
-- routing them through the ledger-postings pipeline would import
-- complexity (idempotent replay against a mutable ledger, planEvent) that
-- doesn't apply and would risk violating the load-bearing invariant that
-- holdings never post to the journal (20260718040000_holdings.sql).
--
-- Full-replace semantics per connection: `/investments/holdings/get`
-- returns the CURRENT complete picture for every investment account under
-- one Plaid item in a single call, so a sold-out-of position is
-- represented by its ABSENCE, not a delta. This upserts every symbol the
-- sync reports (same (account_id, symbol, source) key S-inv-1a's fix
-- already established) and deletes every previously-synced 'plaid' row
-- for this connection's accounts that the new sync didn't report --
-- otherwise a fully-sold position would linger forever as a stale ghost
-- holding.
create or replace function public.keel_worker_sync_holdings(
  p_household_id uuid,
  p_connection_id uuid,
  p_holdings jsonb
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  if not exists (
    select 1 from public.connections
     where id = p_connection_id and household_id = p_household_id
  ) then
    raise exception 'KEEL_NOT_FOUND: connection' using errcode = 'P0006';
  end if;

  insert into public.holdings
    (household_id, account_id, as_of, symbol, name, qty, price_minor, value_minor,
     cost_basis_minor, currency, source)
  select
    p_household_id,
    a.id,
    current_date,
    upper(btrim(h->>'symbol')),
    nullif(btrim(h->>'name'), ''),
    (h->>'qty')::numeric,
    (h->>'priceMinor')::bigint,
    round((h->>'qty')::numeric * (h->>'priceMinor')::bigint)::bigint,
    nullif(h->>'costBasisMinor', '')::bigint,
    coalesce(nullif(h->>'currency', ''), 'USD'),
    'plaid'
    from jsonb_array_elements(p_holdings) h
    join public.accounts a
      on a.external_ref = h->>'accountExternalRef'
     and a.household_id = p_household_id
     and a.connection_id = p_connection_id
  on conflict (account_id, symbol, source) do update
    set name = excluded.name, qty = excluded.qty, price_minor = excluded.price_minor,
        value_minor = excluded.value_minor, cost_basis_minor = excluded.cost_basis_minor,
        currency = excluded.currency, as_of = excluded.as_of, updated_at = now();
  get diagnostics v_count = row_count;

  delete from public.holdings h
   where h.source = 'plaid'
     and h.account_id in (
       select id from public.accounts
        where connection_id = p_connection_id and household_id = p_household_id
     )
     and not exists (
       select 1
         from jsonb_array_elements(p_holdings) e
         join public.accounts a2
           on a2.external_ref = e->>'accountExternalRef'
          and a2.household_id = p_household_id
          and a2.connection_id = p_connection_id
        where a2.id = h.account_id and upper(btrim(e->>'symbol')) = h.symbol
     );

  return v_count;
end;
$$;

revoke all on function public.keel_worker_sync_holdings(uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.keel_worker_sync_holdings(uuid, uuid, jsonb)
  to service_role;
