-- Investments-page header vs sidebar discrepancy (user report 2026-08-13):
-- "Total investment balance" read $57,903.17 while the sidebar's investment
-- accounts sum to $70,299.02 — the gap is EXACTLY the manual Roth 401(k)'s
-- $12,395.85. keel_investments_overview coalesced a missing balance snapshot
-- to 0, but a MANUAL investment account never has a snapshot — its value is
-- its ledger sum (funded by paycheck distribution legs). The sidebar, accounts
-- page, and keel_net_worth_* already use snapshot-else-ledger; this brings the
-- overview in line, so every surface shows the same number. Body is the live
-- definition verbatim with the three coalesce sites given a ledger fallback
-- (snapshot still wins when present; connected accounts unchanged).

CREATE OR REPLACE FUNCTION public.keel_investments_overview(p_household_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := coalesce(
    nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
    nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid;
  v_accounts jsonb;
  v_holdings jsonb;
  v_allocation jsonb;
  v_errors jsonb;
  v_total_value bigint;
  v_total_balance bigint;
  v_balances_by_currency jsonb;
  v_holdings_value_by_currency jsonb;
  v_total_cost_basis bigint;
  v_total_unrealized_gain bigint;
  v_holdings_with_basis_count int;
  v_holdings_count int;
begin
  -- Fail CLOSED (mirrors keel_list_holdings): a missing JWT subject is a hard
  -- authentication failure, never an implicit service bypass. A real service
  -- path uses service_role (which bypasses RLS entirely and does not call this
  -- read model), so there is no legitimate null-subject caller here.
  if v_uid is null then
    raise exception 'KEEL_NOT_AUTHENTICATED' using errcode = 'P0004';
  end if;
  if not exists (
    select 1 from public.household_memberships m
     where m.household_id = p_household_id and m.user_id = v_uid
  ) then
    raise exception 'KEEL_SCOPE_VIOLATION' using errcode = 'P0006';
  end if;

  -- Investment accounts (connected + manual) with their latest balance.
  with inv_accounts as (
    select a.id, a.name, a.subtype, a.currency, a.connection_id, a.entity_id,
           a.holdings_provider_count, a.holdings_cash_equivalent_count,
           a.holdings_synced_at
      from public.accounts a
     where a.household_id = p_household_id
       and a.archived_at is null
       and public.keel_is_investment_subtype(a.subtype)
  ),
  latest_bal as (
    select distinct on (bs.account_id)
           bs.account_id, bs.current_minor, bs.available_minor, bs.as_of
      from public.balance_snapshots bs
      join inv_accounts ia on ia.id = bs.account_id
     where bs.household_id = p_household_id
     order by bs.account_id, bs.as_of desc
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'accountId', ia.id,
      'name', ia.name,
      'subtype', ia.subtype,
      'currency', ia.currency,
      'isManual', ia.connection_id is null,
      'connectionId', ia.connection_id,
      'currentMinor', coalesce(lb.current_minor, lf.ledger_minor, 0)::text,
      'availableMinor', lb.available_minor::text,
      'balanceAsOf', lb.as_of,
      -- Holdings-sync stats (Item 2): what the provider reported at the last
      -- holdings sync. All three are null until a sync has captured them —
      -- null means "unknown", never a fabricated 0 (Law 9).
      'holdingsProviderCount', ia.holdings_provider_count,
      'holdingsCashEquivalentCount', ia.holdings_cash_equivalent_count,
      'holdingsSyncedAt', to_char(ia.holdings_synced_at at time zone 'UTC',
                                  'YYYY-MM-DD"T"HH24:MI:SS"Z"')
    ) order by ia.name), '[]'::jsonb),
    -- USD-only headline total: mixing currencies into one integer and calling
    -- it USD is wrong (no FX here). Non-USD balances are surfaced separately in
    -- balancesByCurrency below, never fabricated into the USD figure.
    coalesce(sum(coalesce(lb.current_minor, lf.ledger_minor, 0)) filter (where ia.currency = 'USD'), 0)
    into v_accounts, v_total_balance
    from inv_accounts ia
    left join latest_bal lb on lb.account_id = ia.id
    -- 20260813190000: a MANUAL investment account has no provider snapshot; its
    -- balance is its ledger sum (e.g. a hand-tracked Roth 401k funded by
    -- paycheck distribution legs). Coalescing to 0 made the Investments page
    -- header disagree with the sidebar/net worth (which already fall back to
    -- ledger) by exactly that account's value. Snapshot still wins when present.
    left join lateral (
      select sum(p.amount_minor) as ledger_minor
        from public.journal_postings p
        join public.accounts a2 on a2.ledger_account_id = p.ledger_account_id
       where a2.id = ia.id
    ) lf on lb.account_id is null;

  -- Per-currency account-balance totals (one row per currency actually held),
  -- so the UI renders each group in its own currency rather than a fabricated
  -- global USD sum.
  with inv_accounts as (
    select a.id, a.currency
      from public.accounts a
     where a.household_id = p_household_id
       and a.archived_at is null
       and public.keel_is_investment_subtype(a.subtype)
  ),
  latest_bal as (
    select distinct on (bs.account_id)
           bs.account_id, bs.current_minor
      from public.balance_snapshots bs
      join inv_accounts ia on ia.id = bs.account_id
     where bs.household_id = p_household_id
     order by bs.account_id, bs.as_of desc
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'currency', currency,
           'totalMinor', total::text
         ) order by currency), '[]'::jsonb)
    into v_balances_by_currency
    from (
      select ia.currency, coalesce(sum(coalesce(lb.current_minor, lf.ledger_minor, 0)), 0) as total
        from inv_accounts ia
        left join latest_bal lb on lb.account_id = ia.id
        left join lateral (
          select sum(p.amount_minor) as ledger_minor
            from public.journal_postings p
            join public.accounts a2 on a2.ledger_account_id = p.ledger_account_id
           where a2.id = ia.id
        ) lf on lb.account_id is null
       group by ia.currency
    ) g;

  -- Household holdings: latest as_of snapshot per account (same "latest per
  -- account" rule as keel_list_holdings), across investment accounts only.
  with inv_accounts as (
    select a.id, a.name
      from public.accounts a
     where a.household_id = p_household_id
       and a.archived_at is null
       and public.keel_is_investment_subtype(a.subtype)
  ),
  latest as (
    select h.account_id, max(h.as_of) as as_of
      from public.holdings h
      join inv_accounts ia on ia.id = h.account_id
     where h.household_id = p_household_id
     group by h.account_id
  ),
  rows as (
    select h.*, ia.name as account_name
      from public.holdings h
      join latest l on l.account_id = h.account_id and l.as_of = h.as_of
      join inv_accounts ia on ia.id = h.account_id
     where h.household_id = p_household_id
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'holdingId', r.id,
      'accountId', r.account_id,
      'accountName', r.account_name,
      'asOf', r.as_of,
      'symbol', r.symbol,
      'name', r.name,
      'qty', r.qty::text,
      'priceMinor', r.price_minor::text,
      'valueMinor', r.value_minor::text,
      'costBasisMinor', r.cost_basis_minor::text,
      -- Unrealized gain/loss (Law 9 derived fact): value − basis. A missing
      -- basis stays JSON null; it is NEVER coerced to a fabricated 0 gain.
      'unrealizedGainMinor', (case
        when r.cost_basis_minor is null then null
        else (r.value_minor - r.cost_basis_minor)
      end)::text,
      -- Integer basis points ((value − basis) / basis × 10000). Guards BOTH a
      -- null basis and a zero basis (no divide-by-zero raise).
      'unrealizedGainBps', (case
        when r.cost_basis_minor is null or r.cost_basis_minor = 0 then null
        else round((r.value_minor - r.cost_basis_minor) * 10000.0 / r.cost_basis_minor)::bigint
      end)::text,
      'currency', r.currency,
      'source', r.source
    ) order by r.account_name, r.symbol), '[]'::jsonb),
    coalesce(sum(r.value_minor) filter (where r.currency = 'USD'), 0),
    -- USD-only portfolio aggregates. Null-basis rows are excluded from BOTH the
    -- cost total and the gain total so the gain is measured over the same
    -- with-basis subset (never a full-value total against a partial-cost total).
    -- Coalesced to 0 (mirrors the totalHoldingsValueMinor pattern above): an
    -- empty with-basis subset is $0 of tracked basis, which the surfaced
    -- holdingsWithBasisCount=0 already qualifies — the UI gates on that count,
    -- never on a magic-number total.
    coalesce(sum(r.cost_basis_minor) filter (
      where r.currency = 'USD' and r.cost_basis_minor is not null), 0),
    coalesce(sum(r.value_minor - r.cost_basis_minor) filter (
      where r.currency = 'USD' and r.cost_basis_minor is not null), 0),
    count(*) filter (
      where r.currency = 'USD' and r.cost_basis_minor is not null),
    count(*) filter (where r.currency = 'USD')
    into
      v_holdings, v_total_value, v_total_cost_basis, v_total_unrealized_gain,
      v_holdings_with_basis_count, v_holdings_count
    from rows r;

  -- Per-currency holdings-value totals (parallels balancesByCurrency). The
  -- USD-only headline stays in totalHoldingsValueMinor; this array carries the
  -- rest honestly rather than folding non-USD into the USD number.
  with inv_accounts as (
    select a.id from public.accounts a
     where a.household_id = p_household_id
       and a.archived_at is null
       and public.keel_is_investment_subtype(a.subtype)
  ),
  latest as (
    select h.account_id, max(h.as_of) as as_of
      from public.holdings h
      join inv_accounts ia on ia.id = h.account_id
     where h.household_id = p_household_id
     group by h.account_id
  ),
  rows as (
    select h.currency, h.value_minor
      from public.holdings h
      join latest l on l.account_id = h.account_id and l.as_of = h.as_of
     where h.household_id = p_household_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'currency', currency,
           'valueMinor', total::text
         ) order by currency), '[]'::jsonb)
    into v_holdings_value_by_currency
    from (
      select currency, sum(value_minor) as total from rows group by currency
    ) g;

  -- Allocation breakdown by symbol (USD only; largest first). A symbol-level
  -- breakdown is the reproducible baseline; the web layer can further bucket
  -- by asset class using its holdings-allocation lib.
  with inv_accounts as (
    select a.id from public.accounts a
     where a.household_id = p_household_id
       and a.archived_at is null
       and public.keel_is_investment_subtype(a.subtype)
  ),
  latest as (
    select h.account_id, max(h.as_of) as as_of
      from public.holdings h
      join inv_accounts ia on ia.id = h.account_id
     where h.household_id = p_household_id
     group by h.account_id
  ),
  rows as (
    select h.symbol, h.name, h.value_minor
      from public.holdings h
      join latest l on l.account_id = h.account_id and l.as_of = h.as_of
     where h.household_id = p_household_id and h.currency = 'USD'
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'symbol', symbol,
           'name', name,
           'valueMinor', total::text
         ) order by total desc), '[]'::jsonb)
    into v_allocation
    from (
      select symbol, max(name) as name, sum(value_minor) as total
        from rows group by symbol
    ) g;

  -- Holdings sync errors (F-014): any active connection currently carrying an
  -- unresolved holdings error. This is what tells the user to re-link.
  select coalesce(jsonb_agg(jsonb_build_object(
           'connectionId', c.id,
           'displayName', coalesce(c.display_name, c.institution_id),
           'errorCode', c.holdings_last_error_code,
           'errorMessage', c.holdings_last_error_message,
           'errorAt', to_char(c.holdings_last_error_at at time zone 'UTC',
                              'YYYY-MM-DD"T"HH24:MI:SS"Z"')
         ) order by c.holdings_last_error_at desc), '[]'::jsonb)
    into v_errors
    from public.connections c
   where c.household_id = p_household_id
     and c.status <> 'disconnected'
     and c.holdings_last_error_code is not null;

  return jsonb_build_object(
    'scope', jsonb_build_object('householdId', p_household_id),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'formulaVersion', 'investments-overview-v3',
    'accounts', v_accounts,
    'holdings', v_holdings,
    'allocation', v_allocation,
    'holdingsErrors', v_errors,
    'totalHoldingsValueMinor', v_total_value::text,
    'totalBalanceMinor', v_total_balance::text,
    -- USD-only portfolio cost/gain over the with-basis subset. holdingsWithBasisCount
    -- < holdingsCount is the SURFACED exclusion (Law 9) the UI must show prominently.
    'totalCostBasisMinor', v_total_cost_basis::text,
    'totalUnrealizedGainMinor', v_total_unrealized_gain::text,
    'holdingsWithBasisCount', coalesce(v_holdings_with_basis_count, 0),
    'holdingsCount', coalesce(v_holdings_count, 0),
    'balancesByCurrency', v_balances_by_currency,
    'holdingsValueByCurrency', v_holdings_value_by_currency,
    'currency', 'USD'
  );
end;
$function$;
