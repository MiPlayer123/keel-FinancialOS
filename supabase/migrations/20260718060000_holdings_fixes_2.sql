-- Second follow-up to 20260718040000_holdings.sql, from a focused review
-- of the first fix-up migration:
--
-- 1. The UPDATE branch of keel_holding_upsert never wrote `currency`, so
--    an edit to a holding created before an account's currency was
--    correct (or before this column existed) couldn't self-heal. Now kept
--    in sync with the account on every edit, same as the insert branch.
-- 2. The by-natural-key create path (SELECT ... FOR UPDATE, then decide
--    INSERT vs UPDATE) is correct for the common case and gets the audit
--    before/after right, but a `FOR UPDATE` lock only holds a row that
--    already exists -- it locks nothing when the symbol is brand new, so
--    two near-simultaneous creates for the same new symbol could both
--    pass the "not found" check before either commits, and the second
--    INSERT would raise a raw unique-violation instead of a friendly
--    result. The INSERT now carries an ON CONFLICT DO UPDATE backstop:
--    the common path still goes through the explicit lookup (correct
--    audit action), and the rare race resolves as a graceful update
--    instead of an error.
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
           currency = v_currency, as_of = current_date, updated_at = now()
     where id = v_existing.id
    returning id into v_id;
  else
    insert into public.holdings
      (household_id, account_id, as_of, symbol, name, qty, price_minor, value_minor,
       cost_basis_minor, currency, source)
    values
      (p_household_id, p_account_id, current_date, v_symbol, v_name, p_qty, p_price_minor,
       v_value_minor, p_cost_basis_minor, v_currency, 'manual')
    on conflict (account_id, symbol, source) do update
      set name = excluded.name, qty = excluded.qty, price_minor = excluded.price_minor,
          value_minor = excluded.value_minor, cost_basis_minor = excluded.cost_basis_minor,
          currency = excluded.currency, as_of = excluded.as_of, updated_at = now()
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
