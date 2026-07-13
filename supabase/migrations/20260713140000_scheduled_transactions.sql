-- Scheduled transactions (Quicken bill & income reminders): user-declared
-- future bills/income/one-offs with a frequency and a next-due date. The
-- schedule itself is mutable, audited configuration; ENTERING an occurrence
-- posts a REAL manual transaction through the existing envelope with
-- economic key manual:sched:{schedule_id}:{due_date} — idempotent economics
-- (invariant 3): re-entering the same occurrence replays, never duplicates.
-- Advancing the due date is a separate idempotent step fenced on the exact
-- due date it advances from. Money never moves (AI ladder class D untouched);
-- this is bookkeeping the user performs explicitly.

create type public.schedule_frequency as enum (
  'once', 'weekly', 'biweekly', 'monthly', 'quarterly', 'semiannual', 'annual'
);

create type public.schedule_status as enum ('active', 'paused', 'ended');

create table if not exists public.scheduled_transactions (
  id                          uuid primary key default gen_random_uuid(),
  household_id                uuid not null references public.households (id),
  account_id                  uuid not null references public.accounts (id),
  description                 text not null check (char_length(description) between 1 and 140),
  -- Signed cash on the account: negative = bill, positive = income (Law 4).
  amount_minor                bigint not null check (amount_minor <> 0),
  currency                    text not null default 'USD',
  category_ledger_account_id  uuid references public.ledger_accounts (id),
  frequency                   public.schedule_frequency not null,
  next_due_date               date not null,
  -- Show as due (and later: auto-enter) this many days early. NULL = remind on the day.
  auto_enter_days             integer check (auto_enter_days between 0 and 30),
  status                      public.schedule_status not null default 'active',
  created_at                  timestamptz not null default now()
);
create index if not exists scheduled_transactions_household
  on public.scheduled_transactions (household_id, status, next_due_date);

-- Fail-closed ACLs from birth (pgTAP 002 convention).
revoke all on public.scheduled_transactions from public, anon, authenticated;
grant select on public.scheduled_transactions to authenticated;

alter table public.scheduled_transactions enable row level security;
drop policy if exists scheduled_transactions_member_read on public.scheduled_transactions;
create policy scheduled_transactions_member_read on public.scheduled_transactions
  for select to authenticated
  using (exists (
    select 1 from public.household_memberships m
    where m.household_id = scheduled_transactions.household_id and m.user_id = auth.uid()
  ));

-- ---------------------------------------------------------------------------
-- Procs (house style: auth gate → membership gate → validate → mutate →
-- audit; revoke PUBLIC/anon, grant authenticated).
-- ---------------------------------------------------------------------------

-- Create (p_schedule_id null) or update a schedule.
create function public.keel_schedule_save(
  p_household_id uuid,
  p_schedule_id uuid,
  p_account_id uuid,
  p_description text,
  p_amount_minor bigint,
  p_category_ledger_account_id uuid,
  p_frequency text,
  p_next_due_date date,
  p_auto_enter_days integer
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_id uuid;
  v_kind text;
begin
  if v_uid is null then
    raise exception 'KEEL_NOT_AUTHENTICATED' using errcode = 'P0004';
  end if;
  if not exists (
    select 1 from public.household_memberships
    where household_id = p_household_id and user_id = v_uid
  ) then
    raise exception 'KEEL_NOT_FOUND' using errcode = 'P0006';
  end if;
  if not exists (
    select 1 from public.accounts
    where id = p_account_id and household_id = p_household_id
  ) then
    raise exception 'KEEL_NOT_FOUND: account' using errcode = 'P0006';
  end if;
  if p_description is null or char_length(trim(p_description)) = 0
     or char_length(p_description) > 140 then
    raise exception 'KEEL_INVALID_DESCRIPTION' using errcode = 'P0009';
  end if;
  if p_amount_minor is null or p_amount_minor = 0 then
    raise exception 'KEEL_INVALID_AMOUNT' using errcode = 'P0009';
  end if;
  if p_frequency is null or not exists (
    select 1 from unnest(enum_range(null::public.schedule_frequency)) f
    where f::text = p_frequency
  ) then
    raise exception 'KEEL_INVALID_FREQUENCY: %', coalesce(p_frequency, '<null>')
      using errcode = 'P0009';
  end if;
  if p_next_due_date is null
     or p_next_due_date < date '1900-01-01'
     or p_next_due_date > (current_date + interval '5 years')::date then
    raise exception 'KEEL_INVALID_DUE_DATE' using errcode = 'P0009';
  end if;
  if p_auto_enter_days is not null and (p_auto_enter_days < 0 or p_auto_enter_days > 30) then
    raise exception 'KEEL_INVALID_AUTO_ENTER' using errcode = 'P0009';
  end if;
  if p_category_ledger_account_id is not null then
    select kind::text into v_kind from public.ledger_accounts
      where id = p_category_ledger_account_id
        and household_id = p_household_id
        and is_category = true
        and archived_at is null;
    if v_kind is null then
      raise exception 'KEEL_NOT_FOUND: category' using errcode = 'P0006';
    end if;
    -- Sign must agree with the category side: bills → expense, income → income.
    if (p_amount_minor < 0 and v_kind <> 'expense')
       or (p_amount_minor > 0 and v_kind <> 'income') then
      raise exception 'KEEL_CATEGORY_SIGN_MISMATCH' using errcode = 'P0009';
    end if;
  end if;

  if p_schedule_id is null then
    insert into public.scheduled_transactions
      (household_id, account_id, description, amount_minor, currency,
       category_ledger_account_id, frequency, next_due_date, auto_enter_days)
    select p_household_id, p_account_id, trim(p_description), p_amount_minor,
           a.currency, p_category_ledger_account_id,
           p_frequency::public.schedule_frequency, p_next_due_date, p_auto_enter_days
      from public.accounts a where a.id = p_account_id
    returning id into v_id;
  else
    update public.scheduled_transactions
      set account_id = p_account_id,
          -- The account may have changed; amount_minor is denominated in the
          -- posting account's currency, so it must follow.
          currency = (select a.currency from public.accounts a where a.id = p_account_id),
          description = trim(p_description),
          amount_minor = p_amount_minor,
          category_ledger_account_id = p_category_ledger_account_id,
          frequency = p_frequency::public.schedule_frequency,
          next_due_date = p_next_due_date,
          auto_enter_days = p_auto_enter_days
      where id = p_schedule_id and household_id = p_household_id
      returning id into v_id;
    if v_id is null then
      raise exception 'KEEL_NOT_FOUND: schedule' using errcode = 'P0006';
    end if;
  end if;

  insert into public.audit_log (household_id, actor, action, object_type, object_id, after)
  values (p_household_id, jsonb_build_object('kind', 'user', 'userId', v_uid),
          case when p_schedule_id is null then 'schedule.create' else 'schedule.update' end,
          'scheduled_transaction', v_id,
          jsonb_build_object(
            'description', trim(p_description), 'amountMinor', p_amount_minor::text,
            'accountId', p_account_id, 'categoryLedgerAccountId', p_category_ledger_account_id,
            'frequency', p_frequency, 'nextDueDate', p_next_due_date,
            'autoEnterDays', p_auto_enter_days));
  return v_id;
end;
$$;

revoke all on function public.keel_schedule_save(uuid,uuid,uuid,text,bigint,uuid,text,date,integer) from public, anon;
grant execute on function public.keel_schedule_save(uuid,uuid,uuid,text,bigint,uuid,text,date,integer) to authenticated;

-- Pause / resume / end a schedule.
create function public.keel_schedule_set_status(
  p_household_id uuid,
  p_schedule_id uuid,
  p_status text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_before public.schedule_status;
begin
  if v_uid is null then
    raise exception 'KEEL_NOT_AUTHENTICATED' using errcode = 'P0004';
  end if;
  if not exists (
    select 1 from public.household_memberships
    where household_id = p_household_id and user_id = v_uid
  ) then
    raise exception 'KEEL_NOT_FOUND' using errcode = 'P0006';
  end if;
  if p_status is null or not exists (
    select 1 from unnest(enum_range(null::public.schedule_status)) st
    where st::text = p_status
  ) then
    raise exception 'KEEL_INVALID_STATUS: %', coalesce(p_status, '<null>')
      using errcode = 'P0009';
  end if;

  select status into v_before from public.scheduled_transactions
    where id = p_schedule_id and household_id = p_household_id
    for update;
  if not found then
    raise exception 'KEEL_NOT_FOUND: schedule' using errcode = 'P0006';
  end if;
  if v_before::text = p_status then
    return; -- idempotent replay: no mutation, no audit row
  end if;

  update public.scheduled_transactions
    set status = p_status::public.schedule_status
    where id = p_schedule_id;

  insert into public.audit_log (household_id, actor, action, object_type, object_id, before, after)
  values (p_household_id, jsonb_build_object('kind', 'user', 'userId', v_uid),
          'schedule.set_status', 'scheduled_transaction', p_schedule_id,
          jsonb_build_object('status', v_before),
          jsonb_build_object('status', p_status));
end;
$$;

revoke all on function public.keel_schedule_set_status(uuid,uuid,text) from public, anon;
grant execute on function public.keel_schedule_set_status(uuid,uuid,text) to authenticated;

-- Advance the due date past one occurrence (after Enter, or as Skip).
-- Fenced on the exact due date being advanced from: replays and races no-op
-- (P0009 would punish the honest retry, so a mismatch just returns the
-- current state instead).
create function public.keel_schedule_advance(
  p_household_id uuid,
  p_schedule_id uuid,
  p_from_due date,
  p_reason text  -- 'entered' | 'skipped' (audit color only)
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.scheduled_transactions%rowtype;
  v_next date;
  v_status public.schedule_status;
begin
  if v_uid is null then
    raise exception 'KEEL_NOT_AUTHENTICATED' using errcode = 'P0004';
  end if;
  if not exists (
    select 1 from public.household_memberships
    where household_id = p_household_id and user_id = v_uid
  ) then
    raise exception 'KEEL_NOT_FOUND' using errcode = 'P0006';
  end if;
  if p_reason is null or p_reason not in ('entered', 'skipped') then
    raise exception 'KEEL_INVALID_REASON' using errcode = 'P0009';
  end if;

  select * into v_row from public.scheduled_transactions
    where id = p_schedule_id and household_id = p_household_id
    for update;
  if not found then
    raise exception 'KEEL_NOT_FOUND: schedule' using errcode = 'P0006';
  end if;

  if v_row.next_due_date is distinct from p_from_due or v_row.status = 'ended' then
    -- Already advanced (double-click, retry) — idempotent no-op.
    return jsonb_build_object(
      'advanced', false,
      'nextDueDate', v_row.next_due_date,
      'status', v_row.status);
  end if;

  v_next := case v_row.frequency
    when 'weekly' then p_from_due + interval '7 days'
    when 'biweekly' then p_from_due + interval '14 days'
    when 'monthly' then p_from_due + interval '1 month'
    when 'quarterly' then p_from_due + interval '3 months'
    when 'semiannual' then p_from_due + interval '6 months'
    when 'annual' then p_from_due + interval '1 year'
    else p_from_due
  end;
  v_status := case when v_row.frequency = 'once' then 'ended'::public.schedule_status
                   else v_row.status end;

  update public.scheduled_transactions
    set next_due_date = v_next, status = v_status
    where id = p_schedule_id;

  insert into public.audit_log (household_id, actor, action, object_type, object_id, before, after)
  values (p_household_id, jsonb_build_object('kind', 'user', 'userId', v_uid),
          'schedule.advance', 'scheduled_transaction', p_schedule_id,
          jsonb_build_object('nextDueDate', p_from_due),
          jsonb_build_object('nextDueDate', v_next, 'status', v_status, 'reason', p_reason));

  return jsonb_build_object('advanced', true, 'nextDueDate', v_next, 'status', v_status);
end;
$$;

revoke all on function public.keel_schedule_advance(uuid,uuid,date,text) from public, anon;
grant execute on function public.keel_schedule_advance(uuid,uuid,date,text) to authenticated;

-- List schedules for the household (active + paused; ended stay export-only).
create function public.keel_list_schedules(p_household_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := coalesce(
    nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
    nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid;
  v_rows jsonb;
begin
  if v_uid is not null and not exists (
    select 1 from public.household_memberships m
     where m.household_id = p_household_id and m.user_id = v_uid
  ) then
    raise exception 'KEEL_SCOPE_VIOLATION' using errcode = 'P0006';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'scheduleId', s.id,
           'accountId', s.account_id,
           'description', s.description,
           'amountMinor', s.amount_minor::text,
           'currency', s.currency,
           'categoryLedgerAccountId', s.category_ledger_account_id,
           'categoryName', c.name,
           'frequency', s.frequency,
           'nextDueDate', s.next_due_date,
           'autoEnterDays', s.auto_enter_days,
           'status', s.status
         ) order by s.next_due_date, s.description), '[]'::jsonb)
    into v_rows
    from public.scheduled_transactions s
    left join public.ledger_accounts c on c.id = s.category_ledger_account_id
    where s.household_id = p_household_id
      and s.status <> 'ended';
  return v_rows;
end;
$$;

revoke all on function public.keel_list_schedules(uuid) from public, anon;
grant execute on function public.keel_list_schedules(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Export (Law 6): new table → grant + policy for keel_export, new wrapper
-- link appending {tables,scheduled_transactions}.
-- ---------------------------------------------------------------------------
grant select on public.scheduled_transactions to keel_export;
create policy scheduled_transactions_export on public.scheduled_transactions
  for select to keel_export using (true);

alter function public.keel_export_household(uuid,timestamptz)
  rename to keel_export_household_pre_schedules;
revoke all on function public.keel_export_household_pre_schedules(uuid,timestamptz)
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
  v_base := public.keel_export_household_pre_schedules(p_household_id, p_as_of);
  select jsonb_build_object(
    'scheduled_transactions', coalesce((select jsonb_agg(jsonb_build_object(
      'id', x.id,
      'household_id', x.household_id,
      'account_id', x.account_id,
      'description', x.description,
      'amount_minor', x.amount_minor::text,
      'currency', x.currency,
      'category_ledger_account_id', x.category_ledger_account_id,
      'frequency', x.frequency::text,
      'next_due_date', to_char(x.next_due_date, 'YYYY-MM-DD'),
      'auto_enter_days', x.auto_enter_days,
      'status', x.status::text,
      'created_at', to_char(x.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    ) order by x.id)
      from public.scheduled_transactions x where x.household_id = p_household_id), '[]'::jsonb)
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
