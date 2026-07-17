-- S-inv-1c (docs/harness/plans/investments-v1.md): allocation view needs a
-- coarse asset class per holding ("equity / fixed income / cash / other,
-- derived from symbol/type where Plaid provides it, else unclassified").
-- Plaid's security `type` field (equity, etf, fixed income, mutual fund,
-- cryptocurrency, derivative, other -- cash is filtered out before it ever
-- reaches a holdings row, see mapHoldingsGetToKeel) already carries this;
-- S-inv-1a/1b just never persisted it. Stored RAW (not pre-bucketed into
-- the coarse groups) so the coarse-bucketing policy can be refined later
-- without a migration -- the allocation view does that mapping at read
-- time (apps/web/src/lib/holdings-allocation.ts).
--
-- Nullable, no backfill: existing rows (if any) simply show as
-- "Unclassified" until their next sync re-upserts them with a type.
alter table public.holdings add column security_type text;

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
     cost_basis_minor, currency, source, security_type)
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
    'plaid',
    nullif(h->>'securityType', '')
    from jsonb_array_elements(p_holdings) h
    join public.accounts a
      on a.external_ref = h->>'accountExternalRef'
     and a.household_id = p_household_id
     and a.connection_id = p_connection_id
  on conflict (account_id, symbol, source) do update
    set name = excluded.name, qty = excluded.qty, price_minor = excluded.price_minor,
        value_minor = excluded.value_minor, cost_basis_minor = excluded.cost_basis_minor,
        currency = excluded.currency, as_of = excluded.as_of,
        security_type = excluded.security_type, updated_at = now();
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

create or replace function public.keel_list_holdings(
  p_household_id uuid,
  p_account_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_uid uuid := coalesce(
    nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
    nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid;
  v_rows jsonb;
begin
  if v_uid is null then
    raise exception 'KEEL_NOT_AUTHENTICATED' using errcode = 'P0004';
  end if;
  if not exists (
    select 1 from public.household_memberships m
     where m.household_id = p_household_id and m.user_id = v_uid
  ) then
    raise exception 'KEEL_SCOPE_VIOLATION' using errcode = 'P0006';
  end if;

  select coalesce(jsonb_agg(row order by row->>'accountId', row->>'symbol'), '[]'::jsonb)
    into v_rows
    from (
      select jsonb_build_object(
        'holdingId', h.id,
        'accountId', h.account_id,
        'asOf', h.as_of,
        'symbol', h.symbol,
        'name', h.name,
        'qty', h.qty::text,
        'priceMinor', h.price_minor::text,
        'valueMinor', h.value_minor::text,
        'costBasisMinor', h.cost_basis_minor::text,
        'currency', h.currency,
        'source', h.source,
        'securityType', h.security_type,
        'updatedAt', to_char(h.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
      ) as row
      from public.holdings h
      where h.household_id = p_household_id
        and (p_account_id is null or h.account_id = p_account_id)
    ) t;

  return jsonb_build_object(
    'scope', jsonb_build_object('householdId', p_household_id),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'formulaVersion', 'holdings-v1',
    'rows', v_rows
  );
end;
$$;
