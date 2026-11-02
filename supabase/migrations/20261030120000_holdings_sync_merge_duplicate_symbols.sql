-- Holdings sync: merge rows that map to the same (account, symbol) before the
-- upsert. Stage 2, BC-v2.1 §Connections (investments holdings).
--
-- Incident 2026-10-30: an Empower 401(k) failed every holdings sync with
-- "ON CONFLICT DO UPDATE command cannot affect row a second time". Plaid can
-- return several holdings in one account that map to one KEEL symbol:
--   * the same fund held in two contribution sources (pre-tax / Roth / match),
--   * ticker-less plan funds whose names share the first 20 characters
--     (symbolFor() in packages/providers/plaid/src/investments.ts truncates).
-- A single INSERT ... ON CONFLICT cannot touch the same target row twice, so
-- the whole sync aborted and the account showed no positions.
--
-- Fix: aggregate per (account, symbol) first. qty, value and cost basis are
-- summed (cost basis only when every leg reports one — a partial sum would be
-- a wrong number, not a smaller one). price_minor is the blended
-- value / qty. All arithmetic stays in numeric/bigint minor units (Law 4).
-- Signature, grants and the stale-row cleanup are unchanged.

create or replace function public.keel_worker_sync_holdings(
  p_household_id uuid,
  p_connection_id uuid,
  p_holdings jsonb,
  p_account_stats jsonb default null
)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_count int;
begin
  if not exists (
    select 1 from public.connections
     where id = p_connection_id and household_id = p_household_id
  ) then
    raise exception 'KEEL_NOT_FOUND: connection' using errcode = 'P0006';
  end if;

  with legs as (
    select
      a.id as account_id,
      upper(btrim(h->>'symbol')) as symbol,
      nullif(btrim(h->>'name'), '') as name,
      (h->>'qty')::numeric as qty,
      round((h->>'qty')::numeric * (h->>'priceMinor')::bigint)::bigint as value_minor,
      nullif(h->>'costBasisMinor', '')::bigint as cost_basis_minor,
      coalesce(nullif(h->>'currency', ''), 'USD') as currency,
      nullif(h->>'securityType', '') as security_type
      from jsonb_array_elements(p_holdings) h
      join public.accounts a
        on a.external_ref = h->>'accountExternalRef'
       and a.household_id = p_household_id
       and a.connection_id = p_connection_id
  ),
  merged as (
    select
      account_id,
      symbol,
      min(name) as name,
      sum(qty) as qty,
      sum(value_minor)::bigint as value_minor,
      case when bool_and(cost_basis_minor is not null)
           then sum(cost_basis_minor)::bigint end as cost_basis_minor,
      min(currency) as currency,
      min(security_type) as security_type
      from legs
     group by account_id, symbol
  )
  insert into public.holdings
    (household_id, account_id, as_of, symbol, name, qty, price_minor, value_minor,
     cost_basis_minor, currency, source, security_type)
  select
    p_household_id,
    m.account_id,
    current_date,
    m.symbol,
    m.name,
    m.qty,
    round(m.value_minor / nullif(m.qty, 0))::bigint,
    m.value_minor,
    m.cost_basis_minor,
    m.currency,
    'plaid',
    m.security_type
    from merged m
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

  if p_account_stats is not null then
    update public.accounts a
       set holdings_provider_count = nullif(s->>'providerCount', '')::int,
           holdings_cash_equivalent_count = nullif(s->>'cashEquivalentCount', '')::int,
           holdings_synced_at = now()
      from jsonb_array_elements(p_account_stats) s
     where a.external_ref = s->>'externalRef'
       and a.household_id = p_household_id
       and a.connection_id = p_connection_id;
  end if;

  return v_count;
end;
$function$;
