-- Budgets v1 (T1.1 category-mode slice): monthly amount per expense
-- category. Deterministic, user-set, audited; no AI anywhere. "Spent" is ONE
-- pinned SQL formula (budget-spent-v1): the transaction's expense-side
-- posting amount (net signed — refunds reduce spent), category resolved
-- overlay-first exactly like the rich list, confirmed transfers excluded
-- exactly like cash-flow-v2, voided transactions excluded, currency pinned
-- to the category's currency. Reproducible numbers: envelope carries
-- scope/asOf/formulaVersion (invariant 7).

create table if not exists public.budgets (
  household_id               uuid not null references public.households (id),
  category_ledger_account_id uuid not null references public.ledger_accounts (id),
  month                      date not null check (month = date_trunc('month', month)::date),
  amount_minor               bigint not null check (amount_minor >= 0),
  currency                   char(3) not null default 'USD',
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  primary key (household_id, category_ledger_account_id, month)
);

alter table public.budgets enable row level security;
drop policy if exists budgets_member_read on public.budgets;
create policy budgets_member_read on public.budgets
  for select to authenticated
  using (exists (
    select 1 from public.household_memberships m
    where m.household_id = budgets.household_id and m.user_id = auth.uid()
  ));
grant select on public.budgets to authenticated;

-- Set or clear (null amount) one category's budget for one month. Audited.
create or replace function public.keel_set_budget(
  p_household_id uuid,
  p_category_ledger_account_id uuid,
  p_month date,
  p_amount_minor bigint
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_month date := date_trunc('month', p_month)::date;
  v_currency char(3);
  v_before bigint;
begin
  if auth.uid() is null then
    raise exception 'KEEL_NOT_AUTHENTICATED' using errcode = 'P0004';
  end if;
  if not exists (
    select 1 from public.household_memberships
    where household_id = p_household_id and user_id = auth.uid()
  ) then
    raise exception 'KEEL_NOT_FOUND' using errcode = 'P0006';
  end if;
  select currency into v_currency
    from public.ledger_accounts
    where id = p_category_ledger_account_id
      and household_id = p_household_id
      and is_category = true and kind = 'expense' and archived_at is null;
  if v_currency is null then
    raise exception 'KEEL_INVALID_COMMAND: invalid budget category' using errcode = 'P0009';
  end if;
  if p_amount_minor is not null and p_amount_minor < 0 then
    raise exception 'KEEL_INVALID_COMMAND: budget must be non-negative' using errcode = 'P0009';
  end if;

  select amount_minor into v_before
    from public.budgets
    where household_id = p_household_id
      and category_ledger_account_id = p_category_ledger_account_id
      and month = v_month;

  if p_amount_minor is null then
    delete from public.budgets
      where household_id = p_household_id
        and category_ledger_account_id = p_category_ledger_account_id
        and month = v_month;
  else
    insert into public.budgets
      (household_id, category_ledger_account_id, month, amount_minor, currency)
    values (p_household_id, p_category_ledger_account_id, v_month, p_amount_minor, v_currency)
    on conflict (household_id, category_ledger_account_id, month) do update
      set amount_minor = excluded.amount_minor, updated_at = now();
  end if;

  insert into public.audit_log (household_id, actor, action, object_type, object_id, before, after)
  values (p_household_id, jsonb_build_object('kind', 'user', 'userId', auth.uid()),
          case when p_amount_minor is null then 'budgets.clear' else 'budgets.set' end,
          'ledger_account', p_category_ledger_account_id,
          jsonb_build_object('month', v_month, 'amountMinor', v_before::text),
          jsonb_build_object('month', v_month, 'amountMinor', p_amount_minor::text));
end;
$$;

revoke all on function public.keel_set_budget(uuid, uuid, date, bigint) from public, anon;
grant execute on function public.keel_set_budget(uuid, uuid, date, bigint) to authenticated;

-- Copy budgets from the previous month into p_month (only missing rows).
create or replace function public.keel_copy_budgets(
  p_household_id uuid,
  p_month date
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_month date := date_trunc('month', p_month)::date;
  v_prev date := (date_trunc('month', p_month) - interval '1 month')::date;
  v_count int;
begin
  if auth.uid() is null then
    raise exception 'KEEL_NOT_AUTHENTICATED' using errcode = 'P0004';
  end if;
  if not exists (
    select 1 from public.household_memberships
    where household_id = p_household_id and user_id = auth.uid()
  ) then
    raise exception 'KEEL_NOT_FOUND' using errcode = 'P0006';
  end if;

  insert into public.budgets
    (household_id, category_ledger_account_id, month, amount_minor, currency)
  select b.household_id, b.category_ledger_account_id, v_month, b.amount_minor, b.currency
    from public.budgets b
    join public.ledger_accounts la
      on la.id = b.category_ledger_account_id and la.archived_at is null
    where b.household_id = p_household_id and b.month = v_prev
  on conflict (household_id, category_ledger_account_id, month) do nothing;
  get diagnostics v_count = row_count;

  if v_count > 0 then
    insert into public.audit_log (household_id, actor, action, object_type, object_id, after)
    values (p_household_id, jsonb_build_object('kind', 'user', 'userId', auth.uid()),
            'budgets.copy', 'household', p_household_id,
            jsonb_build_object('month', v_month, 'copied', v_count));
  end if;
  return v_count;
end;
$$;

revoke all on function public.keel_copy_budgets(uuid, date) from public, anon;
grant execute on function public.keel_copy_budgets(uuid, date) to authenticated;

-- Month view: every live expense category with its budget (if set) and its
-- pinned spent figure.
create or replace function public.keel_list_budgets(
  p_household_id uuid,
  p_month date
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
  v_month date := date_trunc('month', p_month)::date;
  v_next date := (date_trunc('month', p_month) + interval '1 month')::date;
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

  with spent as (
    select coalesce(tc.category_ledger_account_id, offcat.id) as category_id,
           sum(offp.amount_minor)::bigint as spent_minor
      from public.canonical_transactions ct
      join public.journal_batches jb
        on jb.canonical_transaction_id = ct.id and jb.reverses_batch_id is null
       -- Live batch only: a sync revision leaves the superseded original as a
       -- second non-reversal batch; without this a revised charge double-counts.
       and not exists (
         select 1 from public.journal_revisions rev where rev.original_batch_id = jb.id
       )
      join public.journal_postings offp on offp.batch_id = jb.id
      join public.ledger_accounts offcat
        on offcat.id = offp.ledger_account_id and offcat.is_category = true
      left join public.transaction_categories tc on tc.canonical_transaction_id = ct.id
      left join public.ledger_accounts overcat
        on overcat.id = tc.category_ledger_account_id
      where ct.household_id = p_household_id
        and ct.voided_at is null
        and jb.effective_date >= v_month and jb.effective_date < v_next
        and coalesce(overcat.kind, offcat.kind) = 'expense'
        and offp.currency = coalesce(overcat.currency, offcat.currency)
        and not exists (
          select 1 from public.transfer_links tl
          where tl.household_id = p_household_id
            and tl.status = 'confirmed'
            and (tl.txn_out = ct.id or tl.txn_in = ct.id)
        )
      group by 1
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'categoryLedgerAccountId', la.id,
           'categoryName', la.name,
           'currency', la.currency,
           'budgetMinor', b.amount_minor::text,
           'spentMinor', coalesce(s.spent_minor, 0)::text
         ) order by la.name), '[]'::jsonb)
    into v_rows
    from public.ledger_accounts la
    left join public.budgets b
      on b.household_id = la.household_id
     and b.category_ledger_account_id = la.id
     and b.month = v_month
    left join spent s on s.category_id = la.id
    where la.household_id = p_household_id
      and la.is_category = true and la.kind = 'expense' and la.archived_at is null;

  return jsonb_build_object(
    'scope', jsonb_build_object('householdId', p_household_id, 'month', to_char(v_month, 'YYYY-MM')),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'formulaVersion', 'budget-spent-v1-transfer-excluded',
    'rows', v_rows
  );
end;
$$;

revoke all on function public.keel_list_budgets(uuid, date) from public, anon;
grant execute on function public.keel_list_budgets(uuid, date) to authenticated, service_role;

-- Law 6 export ruling: budgets are durable user configuration → INCLUDE.
grant select on public.budgets to keel_export;
create policy budgets_export on public.budgets
  for select to keel_export using (true);

alter function public.keel_export_household(uuid,timestamptz)
  rename to keel_export_household_pre_budgets;
revoke all on function public.keel_export_household_pre_budgets(uuid,timestamptz)
  from public, anon, authenticated, service_role;

create function public.keel_export_household(
  p_household_id uuid,
  p_as_of timestamptz default null
) returns jsonb
language plpgsql
security definer
stable
set search_path = pg_catalog, public
as $$
declare
  v_base jsonb;
  v_tables jsonb;
begin
  v_base := public.keel_export_household_pre_budgets(p_household_id, p_as_of);
  select jsonb_build_object(
    'budgets', coalesce((select jsonb_agg(
      to_jsonb(x) || jsonb_build_object('amount_minor', x.amount_minor::text)
      order by x.category_ledger_account_id, x.month)
      from public.budgets x where x.household_id = p_household_id), '[]'::jsonb)
  ) into v_tables;
  return jsonb_set(v_base, '{tables}', (v_base->'tables') || v_tables);
end;
$$;
revoke all on function public.keel_export_household(uuid,timestamptz)
  from public, anon, authenticated, service_role;
grant create on schema public to keel_export;
alter function public.keel_export_household(uuid,timestamptz) owner to keel_export;
revoke create on schema public from keel_export;
grant execute on function public.keel_export_household(uuid,timestamptz) to service_role;
