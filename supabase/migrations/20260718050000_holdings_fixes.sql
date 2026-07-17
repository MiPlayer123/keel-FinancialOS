-- Fixes to 20260718040000_holdings.sql caught by independent review before
-- merge (already live, so this is a follow-up migration, not an edit in
-- place):
--
-- 1. keel_holding_upsert's edit-by-id path validated p_account_id but then
--    looked the row up by holding_id alone -- a caller could pass a
--    holding id from a DIFFERENT account than p_account_id and silently
--    edit that other account's row. Now the lookup requires account_id to
--    match too.
-- 2. The unique constraint (account_id, as_of, symbol, source) plus
--    "latest as_of per account" in keel_list_holdings was a snapshot-history
--    model this slice never needed: adding a new symbol on a LATER date
--    made that date "the latest snapshot" and silently hid every
--    previously-entered position for that account -- the normal way a
--    portfolio gets built (add a position today, another next week) broke
--    the whole list. Manual holdings are "what you currently own," not a
--    dated history -- there is no history feature in this slice. Constraint
--    is now (account_id, symbol, source): one current row per position,
--    upserted in place. keel_list_holdings simplifies to "every row in
--    scope," no snapshot-latest filtering (that filtering is deferred to
--    when Plaid sync actually produces real dated snapshots).
-- 3. The ON CONFLICT insert path never captured a "before" state, so an
--    upsert that actually updated an existing symbol was audited as
--    'holdings.create' even though it changed an existing row (Law 2:
--    every mutation is audited -- accurately). Both the by-id and the
--    by-natural-key paths now do an explicit SELECT ... FOR UPDATE first,
--    so before/after and the create-vs-update audit action are always
--    correct regardless of which path found the row.
-- 4. Manual holdings hard-coded currency = 'USD' instead of the account's
--    actual currency, which would silently mismatch on any non-USD
--    account.
alter table public.holdings drop constraint holdings_account_id_as_of_symbol_source_key;
alter table public.holdings add constraint holdings_account_id_symbol_source_key
  unique (account_id, symbol, source);

create or replace function public.keel_holding_upsert(
  p_household_id uuid,
  p_account_id uuid,
  p_holding_id uuid,
  p_symbol text,
  p_name text,
  p_qty numeric,
  p_price_minor bigint,
  p_cost_basis_minor bigint default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := coalesce(
    nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
    nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid;
  v_symbol text := upper(btrim(coalesce(p_symbol, '')));
  v_name text := nullif(btrim(coalesce(p_name, '')), '');
  v_currency text;
  v_value_minor bigint;
  v_existing public.holdings%rowtype;
  v_found boolean;
  v_id uuid;
  v_before jsonb;
  v_after jsonb;
begin
  perform public.keel_assert_member_write(p_household_id);

  if char_length(v_symbol) < 1 or char_length(v_symbol) > 20 then
    raise exception 'KEEL_INVALID_COMMAND: symbol must be 1-20 characters' using errcode = 'P0009';
  end if;
  if p_qty is null or p_qty <= 0 then
    raise exception 'KEEL_INVALID_COMMAND: quantity must be positive' using errcode = 'P0009';
  end if;
  if p_price_minor is null or p_price_minor < 0 then
    raise exception 'KEEL_INVALID_COMMAND: price must be non-negative' using errcode = 'P0009';
  end if;
  if p_cost_basis_minor is not null and p_cost_basis_minor < 0 then
    raise exception 'KEEL_INVALID_COMMAND: cost basis must be non-negative' using errcode = 'P0009';
  end if;

  select currency into v_currency from public.accounts
    where id = p_account_id and household_id = p_household_id;
  if v_currency is null then
    raise exception 'KEEL_NOT_FOUND: account' using errcode = 'P0006';
  end if;

  v_value_minor := round(p_qty * p_price_minor)::bigint;

  if p_holding_id is not null then
    select * into v_existing from public.holdings
      where id = p_holding_id and household_id = p_household_id
        and account_id = p_account_id and source = 'manual'
      for update;
    v_found := found;
    if not v_found then
      raise exception 'KEEL_NOT_FOUND: holding' using errcode = 'P0006';
    end if;
  else
    -- Natural key lookup: re-adding a symbol you already track updates it
    -- in place instead of duplicating (idempotent economics, Law 9 §9.1).
    select * into v_existing from public.holdings
      where account_id = p_account_id and symbol = v_symbol and source = 'manual'
      for update;
    v_found := found;
  end if;

  v_before := case when v_found then to_jsonb(v_existing) else null end;

  if v_found then
    update public.holdings
       set symbol = v_symbol, name = v_name, qty = p_qty, price_minor = p_price_minor,
           value_minor = v_value_minor, cost_basis_minor = p_cost_basis_minor,
           as_of = current_date, updated_at = now()
     where id = v_existing.id
    returning id into v_id;
  else
    insert into public.holdings
      (household_id, account_id, as_of, symbol, name, qty, price_minor, value_minor,
       cost_basis_minor, currency, source)
    values
      (p_household_id, p_account_id, current_date, v_symbol, v_name, p_qty, p_price_minor,
       v_value_minor, p_cost_basis_minor, v_currency, 'manual')
    returning id into v_id;
  end if;

  select to_jsonb(h) into v_after from public.holdings h where h.id = v_id;
  insert into public.audit_log (household_id, actor, action, object_type, object_id, before, after)
  values (p_household_id, jsonb_build_object('kind', 'user', 'userId', v_uid),
          case when v_found then 'holdings.update' else 'holdings.create' end,
          'holding', v_id, v_before, v_after);

  return v_id;
end;
$$;

-- Simplified: (account_id, symbol, source) is now unique, so there is
-- exactly one current row per position -- no "latest snapshot" filtering
-- needed. That filtering returns when Plaid sync (S-inv-1b) actually
-- produces dated history worth distinguishing.
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
