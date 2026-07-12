-- Dashboard read-model: cash flow (period) and net worth (as-of), computed from the
-- ledger. Read-only, deterministic, bigint-exact (Law 4). One row PER CURRENCY — never
-- combine currencies without an FX model (Seven invariants: reproducible numbers).
--
-- Sign convention is debit-positive (asset/expense positive; liability/income negative),
-- matching keel_trial_balance. Reversal batches net out automatically because their
-- postings are the arithmetic opposite of the originals (no special-casing needed).

-- Net worth as-of a date = Σ debit-positive balances across ASSET + LIABILITY ledger
-- accounts over all postings whose batch effective_date <= p_as_of, grouped by currency.
create function public.keel_net_worth_as_of(p_household_id uuid, p_as_of date)
  returns jsonb
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

  select coalesce(jsonb_agg(row order by row->>'currency'), '[]'::jsonb) into v_rows
    from (
      select jsonb_build_object(
        'currency', p.currency,
        'netWorthMinor', sum(p.amount_minor)::text
      ) as row
      from public.journal_postings p
      join public.journal_batches b on b.id = p.batch_id
      join public.ledger_accounts la on la.id = p.ledger_account_id
      where b.household_id = p_household_id
        and b.effective_date <= p_as_of
        and la.kind in ('asset', 'liability')
      group by p.currency
    ) t;

  return jsonb_build_object(
    'scope', jsonb_build_object('householdId', p_household_id),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'rows', v_rows
  );
end;
$$;

-- Cash flow over [p_from, p_to] = inflow (income, credit-normal → negated to positive),
-- outflow (expense, debit-normal → positive), net = inflow − outflow, grouped by currency.
create function public.keel_cash_flow(p_household_id uuid, p_from date, p_to date)
  returns jsonb
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
  if p_from > p_to then
    raise exception 'KEEL_INVALID_RANGE' using errcode = 'P0001';
  end if;

  select coalesce(jsonb_agg(row order by row->>'currency'), '[]'::jsonb) into v_rows
    from (
      select jsonb_build_object(
        'currency', p.currency,
        'inflowMinor', coalesce(-sum(p.amount_minor) filter (where la.kind = 'income'), 0)::text,
        'outflowMinor', coalesce(sum(p.amount_minor) filter (where la.kind = 'expense'), 0)::text,
        'netMinor', (
          coalesce(-sum(p.amount_minor) filter (where la.kind = 'income'), 0)
          - coalesce(sum(p.amount_minor) filter (where la.kind = 'expense'), 0)
        )::text
      ) as row
      from public.journal_postings p
      join public.journal_batches b on b.id = p.batch_id
      join public.ledger_accounts la on la.id = p.ledger_account_id
      where b.household_id = p_household_id
        and b.effective_date between p_from and p_to
        and la.kind in ('income', 'expense')
      group by p.currency
    ) t;

  return jsonb_build_object(
    'scope', jsonb_build_object('householdId', p_household_id),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'rows', v_rows
  );
end;
$$;

-- keel_api must hold CREATE on the schema to own objects in it; grant transiently.
grant create on schema public to keel_api;
alter function public.keel_net_worth_as_of(uuid, date) owner to keel_api;
alter function public.keel_cash_flow(uuid, date, date) owner to keel_api;
revoke create on schema public from keel_api;

revoke all on function public.keel_net_worth_as_of(uuid, date) from public, anon;
revoke all on function public.keel_cash_flow(uuid, date, date) from public, anon;
grant execute on function public.keel_net_worth_as_of(uuid, date) to authenticated;
grant execute on function public.keel_cash_flow(uuid, date, date) to authenticated;
