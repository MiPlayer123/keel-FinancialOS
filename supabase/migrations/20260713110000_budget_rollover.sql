-- Budget rollover (T1.1 follow-up; Monarch-style carry-forward). A category
-- with rollover enabled carries (budget − spent) from each prior
-- rollover-enabled month into the current one: available = budget + carry.
-- Rulings (NOTES.md): carry may be NEGATIVE (overspend reduces next month);
-- months WITHOUT a budget row contribute nothing (skipping a month pauses
-- the ledger of carry rather than inventing a zero budget); carry displays
-- and applies only while the CURRENT month's row has rollover on. The spent
-- figure per month is the same pinned split-aware formula as v2, bucketed
-- by month. Law 4 note: `default false` exists only so the ALTER backfills;
-- every write path supplies the flag explicitly.

alter table public.budgets
  add column if not exists rollover boolean not null default false;

-- ---------------------------------------------------------------------------
-- keel_set_budget gains p_rollover. Drop the old 4-arg signature first —
-- PostgREST named-argument dispatch would otherwise be ambiguous.
-- ---------------------------------------------------------------------------
drop function if exists public.keel_set_budget(uuid, uuid, date, bigint);

create function public.keel_set_budget(
  p_household_id uuid,
  p_category_ledger_account_id uuid,
  p_month date,
  p_amount_minor bigint,
  p_rollover boolean default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_month date := date_trunc('month', p_month)::date;
  v_currency char(3);
  v_before bigint;
  v_before_rollover boolean;
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

  select amount_minor, rollover into v_before, v_before_rollover
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
      (household_id, category_ledger_account_id, month, amount_minor, currency, rollover)
    values (p_household_id, p_category_ledger_account_id, v_month, p_amount_minor, v_currency,
            coalesce(p_rollover, false))
    on conflict (household_id, category_ledger_account_id, month) do update
      set amount_minor = excluded.amount_minor,
          -- null p_rollover = leave the flag as it was.
          rollover = coalesce(p_rollover, budgets.rollover),
          updated_at = now();
  end if;

  insert into public.audit_log (household_id, actor, action, object_type, object_id, before, after)
  values (p_household_id, jsonb_build_object('kind', 'user', 'userId', auth.uid()),
          case when p_amount_minor is null then 'budgets.clear' else 'budgets.set' end,
          'ledger_account', p_category_ledger_account_id,
          jsonb_build_object('month', v_month, 'amountMinor', v_before::text,
                             'rollover', v_before_rollover),
          jsonb_build_object('month', v_month, 'amountMinor', p_amount_minor::text,
                             'rollover', coalesce(p_rollover, v_before_rollover, false)));
end;
$$;

revoke all on function public.keel_set_budget(uuid, uuid, date, bigint, boolean) from public, anon;
grant execute on function public.keel_set_budget(uuid, uuid, date, bigint, boolean) to authenticated;

-- Copy-forward keeps the rollover flag.
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
    (household_id, category_ledger_account_id, month, amount_minor, currency, rollover)
  select b.household_id, b.category_ledger_account_id, v_month, b.amount_minor, b.currency, b.rollover
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

-- ---------------------------------------------------------------------------
-- Month view v3: same split-aware spent formula, now bucketed by month over
-- the household's whole rollover horizon so carry is computed exactly.
-- ---------------------------------------------------------------------------
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

  with offn as (
    select jp.batch_id, count(*) as n
      from public.journal_postings jp
      join public.ledger_accounts l on l.id = jp.ledger_account_id and l.is_category
      join public.journal_batches jb2 on jb2.id = jp.batch_id
      where jb2.household_id = p_household_id
      group by 1
  ),
  monthly_spent as (
    select case when offn.n = 1 then coalesce(tc.category_ledger_account_id, offcat.id)
                else offcat.id end as category_id,
           date_trunc('month', jb.effective_date)::date as month,
           sum(offp.amount_minor)::bigint as spent_minor
      from public.canonical_transactions ct
      join public.journal_batches jb
        on jb.canonical_transaction_id = ct.id and jb.reverses_batch_id is null
       and not exists (
         select 1 from public.journal_revisions rev where rev.original_batch_id = jb.id
       )
      join public.journal_postings offp on offp.batch_id = jb.id
      join public.ledger_accounts offcat
        on offcat.id = offp.ledger_account_id and offcat.is_category = true
      join offn on offn.batch_id = jb.id
      left join public.transaction_categories tc on tc.canonical_transaction_id = ct.id
      left join public.ledger_accounts overcat
        on overcat.id = tc.category_ledger_account_id
      where ct.household_id = p_household_id
        and ct.voided_at is null
        and jb.effective_date < v_next
        and (case when offn.n = 1 then coalesce(overcat.kind, offcat.kind)
                  else offcat.kind end) = 'expense'
        and offp.currency = (case when offn.n = 1 then coalesce(overcat.currency, offcat.currency)
                                  else offcat.currency end)
        and not exists (
          select 1 from public.transfer_links tl
          where tl.household_id = p_household_id
            and tl.status = 'confirmed'
            and (tl.txn_out = ct.id or tl.txn_in = ct.id)
        )
      group by 1, 2
  ),
  carry as (
    -- Σ over PRIOR rollover-enabled budgeted months of (budget − spent).
    select b.category_ledger_account_id as category_id,
           sum(b.amount_minor - coalesce(ms.spent_minor, 0))::bigint as carry_minor
      from public.budgets b
      left join monthly_spent ms
        on ms.category_id = b.category_ledger_account_id and ms.month = b.month
      where b.household_id = p_household_id
        and b.rollover
        and b.month < v_month
      group by 1
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'categoryLedgerAccountId', la.id,
           'categoryName', la.name,
           'currency', la.currency,
           'parentLedgerAccountId', la.parent_ledger_account_id,
           'budgetMinor', b.amount_minor::text,
           'rollover', coalesce(b.rollover, false),
           'carryMinor', case when b.rollover then coalesce(c.carry_minor, 0)::text end,
           'availableMinor', case when b.rollover
             then (b.amount_minor + coalesce(c.carry_minor, 0))::text
             else b.amount_minor::text end,
           'spentMinor', coalesce(s.spent_minor, 0)::text
         ) order by la.name), '[]'::jsonb)
    into v_rows
    from public.ledger_accounts la
    left join public.budgets b
      on b.household_id = la.household_id
     and b.category_ledger_account_id = la.id
     and b.month = v_month
    left join monthly_spent s on s.category_id = la.id and s.month = v_month
    left join carry c on c.category_id = la.id
    where la.household_id = p_household_id
      and la.is_category = true and la.kind = 'expense' and la.archived_at is null;

  return jsonb_build_object(
    'scope', jsonb_build_object('householdId', p_household_id, 'month', to_char(v_month, 'YYYY-MM')),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'formulaVersion', 'budget-v3-split-aware-rollover',
    'rows', v_rows
  );
end;
$$;

revoke all on function public.keel_list_budgets(uuid, date) from public, anon;
grant execute on function public.keel_list_budgets(uuid, date) to authenticated, service_role;
