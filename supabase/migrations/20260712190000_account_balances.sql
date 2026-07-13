-- Real account balances + net worth. Synced transactions alone are only a
-- ~30-day window, so an account's ledger total (Σ postings) is meaningless
-- until anchored to the provider's reported balance. We record each provider
-- balance snapshot and, ONCE per account, book an "Opening Balances" equity
-- entry so the ledger total equals the real balance at first capture; every
-- synced transaction thereafter moves the ledger exactly as the bank moves.
--
-- Sign convention is debit-positive (keel_trial_balance / keel_net_worth):
-- asset target = +current, liability target = -current.

create or replace function public.keel_apply_account_balance(
  p_household_id uuid,
  p_account_id uuid,
  p_current_minor bigint,
  p_available_minor bigint,
  p_currency text,
  p_as_of timestamptz
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ledger        uuid;
  v_entity        uuid;
  v_curr          char(3);
  v_kind          public.ledger_account_kind;
  v_opening_ledger uuid;
  v_target        bigint;
  v_current_sum   bigint;
  v_opening       bigint;
  v_batch         uuid;
  v_has_opening   boolean;
begin
  select a.ledger_account_id, a.entity_id, a.currency
    into v_ledger, v_entity, v_curr
    from public.accounts a
    where a.id = p_account_id and a.household_id = p_household_id;
  if v_ledger is null then
    raise exception 'KEEL_NOT_FOUND: account' using errcode = 'P0006';
  end if;
  select kind into v_kind from public.ledger_accounts where id = v_ledger;

  -- Provider snapshot (history for trend + future reconciliation).
  insert into public.balance_snapshots
    (household_id, account_id, as_of, available_minor, current_minor, currency, source, snapshot_metadata)
  values
    (p_household_id, p_account_id, p_as_of, p_available_minor, p_current_minor,
     coalesce(nullif(p_currency, ''), v_curr), 'plaid', '{}'::jsonb);

  -- Opening balance is booked once. A null-canonical, non-reversal batch with a
  -- posting on this ledger account is our opening-balance marker.
  select exists (
    select 1
      from public.journal_batches b
      join public.journal_postings p on p.batch_id = b.id
      where b.household_id = p_household_id
        and b.canonical_transaction_id is null
        and b.reverses_batch_id is null
        and p.ledger_account_id = v_ledger
  ) into v_has_opening;
  if v_has_opening then
    return;
  end if;

  v_target := case when v_kind = 'liability' then -p_current_minor else p_current_minor end;
  select coalesce(sum(amount_minor), 0) into v_current_sum
    from public.journal_postings where ledger_account_id = v_ledger;
  v_opening := v_target - v_current_sum;
  if v_opening = 0 then
    return;
  end if;

  select id into v_opening_ledger
    from public.ledger_accounts
    where entity_id = v_entity and name = 'Opening Balances' and archived_at is null;
  if v_opening_ledger is null then
    raise exception 'KEEL_INVALID_COMMAND: opening balances account missing' using errcode = 'P0009';
  end if;

  insert into public.journal_batches
    (household_id, canonical_transaction_id, description, effective_date, command_id, posted_at)
  values
    (p_household_id, null, 'Opening balance', current_date, gen_random_uuid(), now())
  returning id into v_batch;

  insert into public.journal_postings (batch_id, ledger_account_id, entity_id, amount_minor, currency)
  values
    (v_batch, v_ledger,         v_entity,  v_opening, coalesce(nullif(p_currency, ''), v_curr)),
    (v_batch, v_opening_ledger, v_entity, -v_opening, coalesce(nullif(p_currency, ''), v_curr));
end;
$$;

grant execute on function public.keel_apply_account_balance(uuid, uuid, bigint, bigint, text, timestamptz)
  to service_role;

-- Latest provider balance per account (for account/home read models).
create or replace function public.keel_latest_balances(p_household_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'accountId', account_id,
           'currentMinor', current_minor::text,
           'availableMinor', available_minor::text,
           'currency', currency,
           'asOf', as_of
         )), '[]'::jsonb)
  from (
    select distinct on (account_id)
           account_id, current_minor, available_minor, currency, as_of
      from public.balance_snapshots
      where household_id = p_household_id
      order by account_id, as_of desc
  ) latest;
$$;

grant execute on function public.keel_latest_balances(uuid) to authenticated, service_role;

-- Extend the cron drain bridge to also refresh provider balances each cycle so
-- displayed balances track the bank (opening balance is still booked only once).
create or replace function public.keel_cron_drain_sync()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key  text;
  v_base text;
begin
  begin
    select decrypted_secret into v_key  from vault.decrypted_secrets where name = 'keel_automations_key';
    select decrypted_secret into v_base from vault.decrypted_secrets where name = 'keel_functions_base';
  exception when others then
    return;
  end;
  if v_key is null or v_base is null then
    return;
  end if;
  perform net.http_post(
    url := v_base || '/worker/drain',
    headers := jsonb_build_object('apikey', v_key, 'authorization', 'Bearer ' || v_key, 'content-type', 'application/json'),
    body := '{}'::jsonb);
  perform net.http_post(
    url := v_base || '/worker/refresh-balances',
    headers := jsonb_build_object('apikey', v_key, 'authorization', 'Bearer ' || v_key, 'content-type', 'application/json'),
    body := '{}'::jsonb);
end;
$$;
