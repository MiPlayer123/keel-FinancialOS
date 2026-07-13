-- keel_api-owned SECURITY DEFINER procs may not call auth.uid(): the auth
-- schema is owned by supabase_auth_admin and keel_api has no USAGE on it
-- (discovered in CI pgTAP 014 — 42501 "permission denied for schema auth";
-- the scratch shim granted auth to PUBLIC, masking it, and the envelope
-- procs never hit it because the actor arrives as a parameter). The list
-- procs already read the JWT claim GUCs directly — this migration moves the
-- seven remaining procs to the same pattern. Behavior is identical: the GUC
-- is what auth.uid() reads.

create or replace function public.keel_schedule_save(
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
  v_uid uuid := coalesce(
    nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
    nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid;
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
       category_ledger_account_id, frequency, next_due_date, auto_enter_days, anchor_day)
    select p_household_id, p_account_id, trim(p_description), p_amount_minor,
           a.currency, p_category_ledger_account_id,
           p_frequency::public.schedule_frequency, p_next_due_date, p_auto_enter_days,
           extract(day from p_next_due_date)::smallint
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
          auto_enter_days = p_auto_enter_days,
          -- Re-anchor ONLY when the caller actually changed the due date. An
          -- edit that echoes back an already-clamped date (a 31-anchor sitting
          -- on Feb 28) must not collapse the anchor to 28 — that would
          -- reintroduce the month-end drift this migration exists to fix.
          anchor_day = case
            when p_next_due_date is distinct from next_due_date
              then extract(day from p_next_due_date)::smallint
            else anchor_day
          end
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

create or replace function public.keel_schedule_advance(
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
  v_uid uuid := coalesce(
    nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
    nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid;
  v_row public.scheduled_transactions%rowtype;
  v_next date;
  v_status public.schedule_status;
  v_months int;
  v_target_month_start date;
  v_days_in_month int;
  v_anchor int;
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

  v_months := case v_row.frequency
    when 'monthly' then 1
    when 'quarterly' then 3
    when 'semiannual' then 6
    when 'annual' then 12
    else null
  end;

  if v_months is not null then
    -- Anchor stepping: target the anchor day within the target month,
    -- clamped to that month's length. Recovers the original day the next
    -- time the target month is long enough (Jan 31 -> Feb 28 -> Mar 31).
    v_target_month_start := (date_trunc('month', p_from_due) + (v_months || ' months')::interval)::date;
    v_days_in_month := extract(day from ((v_target_month_start + interval '1 month') - interval '1 day'))::int;
    v_anchor := coalesce(v_row.anchor_day, extract(day from p_from_due)::int);
    v_next := (v_target_month_start + (least(v_anchor, v_days_in_month) - 1) * interval '1 day')::date;
  else
    v_next := case v_row.frequency
      when 'weekly' then p_from_due + interval '7 days'
      when 'biweekly' then p_from_due + interval '14 days'
      else p_from_due  -- 'once'
    end;
  end if;

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

create or replace function public.keel_schedule_enter(
  p_household_id uuid,
  p_schedule_id uuid,
  p_from_due date
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := coalesce(
    nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
    nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid;
  v_row public.scheduled_transactions%rowtype;
  v_command_id uuid := gen_random_uuid();
  v_key text;
  v_actor jsonb;
  v_payload jsonb;
  v_envelope jsonb;
  v_advance jsonb;
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

  select * into v_row from public.scheduled_transactions
    where id = p_schedule_id and household_id = p_household_id
    for update;
  if not found then
    raise exception 'KEEL_NOT_FOUND: schedule' using errcode = 'P0006';
  end if;

  -- Fence: a stale tab (another tab already Entered/Skipped/paused/ended
  -- this occurrence) is not an error — just tell the caller it moved.
  if v_row.status <> 'active' or v_row.next_due_date is distinct from p_from_due then
    return jsonb_build_object(
      'entered', false,
      'reason', 'moved',
      'nextDueDate', v_row.next_due_date,
      'status', v_row.status);
  end if;

  if v_row.category_ledger_account_id is null then
    raise exception 'KEEL_SCHEDULE_NEEDS_CATEGORY' using errcode = 'P0009';
  end if;

  v_key := 'manual:sched:' || p_schedule_id || ':' || to_char(p_from_due, 'YYYY-MM-DD');
  v_actor := jsonb_build_object('kind', 'user', 'userId', v_uid);
  v_payload := jsonb_build_object(
    'account_id', v_row.account_id,
    'description', v_row.description,
    'effective_date', to_char(p_from_due, 'YYYY-MM-DD'),
    'amount_minor', v_row.amount_minor::text,
    'status', 'posted',
    'splits', jsonb_build_array(jsonb_build_object(
      'category_ledger_account_id', v_row.category_ledger_account_id,
      'amount_minor', (-v_row.amount_minor)::text
    ))
  );

  -- Same transaction as the row lock above and the advance below: post and
  -- advance commit or roll back together (gap 1 from NOTES.md).
  v_envelope := public.keel_cmd_manual_transaction(
    v_command_id, v_key, v_actor, p_household_id, v_payload);

  v_advance := public.keel_schedule_advance(p_household_id, p_schedule_id, p_from_due, 'entered');

  return jsonb_build_object(
    'entered', true,
    'idempotentReplay', coalesce((v_envelope->>'idempotentReplay')::boolean, false),
    'nextDueDate', v_advance->>'nextDueDate',
    'status', v_advance->>'status');
end;
$$;

create or replace function public.keel_schedule_set_status(
  p_household_id uuid,
  p_schedule_id uuid,
  p_status text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := coalesce(
    nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
    nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid;
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

create or replace function public.keel_goal_save(
  p_household_id uuid,
  p_goal_id uuid,
  p_name text,
  p_target_minor bigint,
  p_target_date date,
  p_account_id uuid,
  p_kind text default 'savings'
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
  v_id uuid;
  v_currency text := 'USD';
  v_row public.savings_goals%rowtype;
  v_saved bigint;
  v_paid bigint;
  v_status public.goal_status;
  v_kind public.goal_kind;
  v_ledger_kind public.ledger_account_kind;
  v_ledger_account_id uuid;
  v_raw_balance bigint;
  v_start_balance bigint;
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
  if p_name is null or char_length(trim(p_name)) = 0 or char_length(p_name) > 80 then
    raise exception 'KEEL_INVALID_NAME' using errcode = 'P0009';
  end if;
  if p_target_minor is null or p_target_minor <= 0 then
    raise exception 'KEEL_INVALID_TARGET' using errcode = 'P0009';
  end if;
  if p_target_date is not null and p_target_date > (current_date + interval '50 years')::date then
    raise exception 'KEEL_INVALID_TARGET_DATE' using errcode = 'P0009';
  end if;
  if p_kind is null or p_kind not in ('savings', 'debt') then
    raise exception 'KEEL_INVALID_KIND' using errcode = 'P0009';
  end if;
  v_kind := p_kind::public.goal_kind;
  if v_kind = 'debt' and p_account_id is null then
    raise exception 'KEEL_DEBT_GOAL_REQUIRES_ACCOUNT' using errcode = 'P0009';
  end if;

  if p_account_id is not null then
    select a.currency, a.ledger_account_id, la.kind
      into v_currency, v_ledger_account_id, v_ledger_kind
      from public.accounts a
      join public.ledger_accounts la on la.id = a.ledger_account_id
      where a.id = p_account_id and a.household_id = p_household_id;
    if not found then
      raise exception 'KEEL_NOT_FOUND: account' using errcode = 'P0006';
    end if;
    if v_kind = 'debt' and v_ledger_kind is distinct from 'liability'::public.ledger_account_kind then
      raise exception 'KEEL_DEBT_GOAL_REQUIRES_LIABILITY' using errcode = 'P0009';
    end if;
  end if;

  if p_goal_id is null then
    if p_target_date is not null and p_target_date < current_date then
      raise exception 'KEEL_INVALID_TARGET_DATE' using errcode = 'P0009';
    end if;

    if v_kind = 'debt' then
      select coalesce(sum(jp.amount_minor), 0) into v_raw_balance
        from public.journal_postings jp where jp.ledger_account_id = v_ledger_account_id;
      v_start_balance := greatest(-v_raw_balance, 0);
      -- Unachievable goals are refused up front: paidMinor is capped by the
      -- captured balance, so a larger target could never be reached.
      if v_start_balance = 0 then
        raise exception 'KEEL_DEBT_GOAL_NOTHING_OWED' using errcode = 'P0009';
      end if;
      if p_target_minor > v_start_balance then
        raise exception 'KEEL_DEBT_GOAL_TARGET_EXCEEDS_BALANCE' using errcode = 'P0009';
      end if;
    else
      v_start_balance := null;
    end if;

    insert into public.savings_goals
      (household_id, name, target_minor, target_date, account_id, currency, kind, start_balance_minor)
    values (p_household_id, trim(p_name), p_target_minor, p_target_date, p_account_id, v_currency,
            v_kind, v_start_balance)
    returning id into v_id;
  else
    select * into v_row from public.savings_goals
      where id = p_goal_id and household_id = p_household_id
      for update;
    if not found then
      raise exception 'KEEL_NOT_FOUND: goal' using errcode = 'P0006';
    end if;
    if v_kind is distinct from v_row.kind then
      raise exception 'KEEL_GOAL_KIND_IMMUTABLE' using errcode = 'P0009';
    end if;
    if v_row.kind = 'debt'
       and p_account_id is distinct from v_row.account_id then
      raise exception 'KEEL_DEBT_GOAL_ACCOUNT_IMMUTABLE' using errcode = 'P0009';
    end if;
    -- Raising a debt target past the captured baseline is the same
    -- unachievable trap on the edit path.
    if v_row.kind = 'debt'
       and p_target_minor > coalesce(v_row.start_balance_minor, 0) then
      raise exception 'KEEL_DEBT_GOAL_TARGET_EXCEEDS_BALANCE' using errcode = 'P0009';
    end if;
    if p_target_date is not null
       and p_target_date is distinct from v_row.target_date
       and p_target_date < current_date then
      raise exception 'KEEL_INVALID_TARGET_DATE' using errcode = 'P0009';
    end if;
    if p_account_id is null then
      v_currency := v_row.currency;
    end if;

    if v_row.kind = 'debt' then
      select a.ledger_account_id into v_ledger_account_id
        from public.accounts a where a.id = coalesce(p_account_id, v_row.account_id);
      select coalesce(sum(jp.amount_minor), 0) into v_raw_balance
        from public.journal_postings jp where jp.ledger_account_id = v_ledger_account_id;
      v_paid := greatest(coalesce(v_row.start_balance_minor, 0) - greatest(-v_raw_balance, 0), 0);
      v_status := case
        when v_row.status = 'archived' then 'archived'::public.goal_status
        when v_paid >= p_target_minor then 'reached'::public.goal_status
        else 'active'::public.goal_status
      end;
    else
      select coalesce(sum(amount_minor), 0) into v_saved
        from public.goal_contributions where goal_id = p_goal_id;
      v_status := case
        when v_row.status = 'archived' then 'archived'::public.goal_status
        when v_saved >= p_target_minor then 'reached'::public.goal_status
        else 'active'::public.goal_status
      end;
    end if;

    update public.savings_goals
      set name = trim(p_name),
          target_minor = p_target_minor,
          target_date = p_target_date,
          account_id = p_account_id,
          currency = v_currency,
          status = v_status
      where id = p_goal_id
      returning id into v_id;
  end if;

  insert into public.audit_log (household_id, actor, action, object_type, object_id, after)
  values (p_household_id, jsonb_build_object('kind', 'user', 'userId', v_uid),
          case when p_goal_id is null then 'goal.create' else 'goal.update' end,
          'savings_goal', v_id,
          jsonb_build_object('name', trim(p_name), 'targetMinor', p_target_minor::text,
                             'targetDate', p_target_date, 'accountId', p_account_id,
                             'kind', v_kind::text, 'startBalanceMinor', v_start_balance::text));
  return v_id;
end;
$$;

create or replace function public.keel_goal_contribute(
  p_household_id uuid,
  p_goal_id uuid,
  p_amount_minor bigint,
  p_contributed_on date
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := coalesce(
    nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
    nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid;
  v_goal public.savings_goals%rowtype;
  v_saved bigint;
  v_status public.goal_status;
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
  if p_amount_minor is null or p_amount_minor = 0 then
    raise exception 'KEEL_INVALID_AMOUNT' using errcode = 'P0009';
  end if;
  if p_contributed_on is null
     or p_contributed_on < date '1900-01-01'
     or p_contributed_on > (current_date + interval '1 day')::date then
    raise exception 'KEEL_INVALID_DATE' using errcode = 'P0009';
  end if;

  select * into v_goal from public.savings_goals
    where id = p_goal_id and household_id = p_household_id
    for update;
  if not found then
    raise exception 'KEEL_NOT_FOUND: goal' using errcode = 'P0006';
  end if;
  if v_goal.status = 'archived' then
    raise exception 'KEEL_GOAL_ARCHIVED' using errcode = 'P0009';
  end if;
  -- Debt-goal progress is derived from the ledger, never from a parallel
  -- earmark ledger: a contribution here would be double bookkeeping.
  if v_goal.kind = 'debt' then
    raise exception 'KEEL_DEBT_GOAL_NO_CONTRIB' using errcode = 'P0009';
  end if;

  select coalesce(sum(amount_minor), 0) into v_saved
    from public.goal_contributions where goal_id = p_goal_id;
  if v_saved + p_amount_minor < 0 then
    raise exception 'KEEL_GOAL_OVERDRAWN' using errcode = 'P0009';
  end if;

  insert into public.goal_contributions (goal_id, household_id, amount_minor, contributed_on)
  values (p_goal_id, p_household_id, p_amount_minor, p_contributed_on);
  v_saved := v_saved + p_amount_minor;

  -- Reaching the target flips status automatically (deterministic and
  -- reversible: withdrawing back below flips it back).
  v_status := case
    when v_saved >= v_goal.target_minor then 'reached'::public.goal_status
    else 'active'::public.goal_status
  end;
  if v_goal.status is distinct from v_status then
    update public.savings_goals set status = v_status where id = p_goal_id;
  end if;

  insert into public.audit_log (household_id, actor, action, object_type, object_id, after)
  values (p_household_id, jsonb_build_object('kind', 'user', 'userId', v_uid),
          case when p_amount_minor > 0 then 'goal.contribute' else 'goal.withdraw' end,
          'savings_goal', p_goal_id,
          jsonb_build_object('amountMinor', p_amount_minor::text,
                             'contributedOn', p_contributed_on,
                             'savedMinor', v_saved::text, 'status', v_status));

  return jsonb_build_object('savedMinor', v_saved::text, 'status', v_status);
end;
$$;

create or replace function public.keel_goal_set_status(
  p_household_id uuid,
  p_goal_id uuid,
  p_status text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := coalesce(
    nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
    nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid;
  v_before public.goal_status;
  v_goal public.savings_goals%rowtype;
  v_ledger_account_id uuid;
  v_raw_balance bigint;
  v_paid bigint;
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
  -- 'reached' is derived (from Σ contributions or the ledger vs target),
  -- never set by hand.
  if p_status is null or p_status not in ('active', 'archived') then
    raise exception 'KEEL_INVALID_STATUS: %', coalesce(p_status, '<null>') using errcode = 'P0009';
  end if;

  select * into v_goal from public.savings_goals
    where id = p_goal_id and household_id = p_household_id
    for update;
  if not found then
    raise exception 'KEEL_NOT_FOUND: goal' using errcode = 'P0006';
  end if;
  v_before := v_goal.status;

  -- Restoring recomputes active vs reached instead of blindly trusting the caller.
  if p_status = 'active' then
    if v_goal.kind = 'debt' then
      select a.ledger_account_id into v_ledger_account_id
        from public.accounts a where a.id = v_goal.account_id;
      select coalesce(sum(jp.amount_minor), 0) into v_raw_balance
        from public.journal_postings jp where jp.ledger_account_id = v_ledger_account_id;
      v_paid := greatest(coalesce(v_goal.start_balance_minor, 0) - greatest(-v_raw_balance, 0), 0);
      p_status := case when v_paid >= v_goal.target_minor then 'reached' else 'active' end;
    else
      select case
        when coalesce(sum(amount_minor), 0) >= v_goal.target_minor
        then 'reached' else 'active' end
        into p_status
        from public.goal_contributions where goal_id = p_goal_id;
    end if;
  end if;
  if v_before::text = p_status then
    return;
  end if;

  update public.savings_goals set status = p_status::public.goal_status where id = p_goal_id;

  insert into public.audit_log (household_id, actor, action, object_type, object_id, before, after)
  values (p_household_id, jsonb_build_object('kind', 'user', 'userId', v_uid),
          'goal.set_status', 'savings_goal', p_goal_id,
          jsonb_build_object('status', v_before), jsonb_build_object('status', p_status));
end;
$$;

-- create-or-replace preserves owner (keel_api) and ACLs; restated per house style.
revoke all on function public.keel_schedule_save(uuid,uuid,uuid,text,bigint,uuid,text,date,integer) from public, anon;
grant execute on function public.keel_schedule_save(uuid,uuid,uuid,text,bigint,uuid,text,date,integer) to authenticated;
revoke all on function public.keel_schedule_set_status(uuid,uuid,text) from public, anon;
grant execute on function public.keel_schedule_set_status(uuid,uuid,text) to authenticated;
revoke all on function public.keel_schedule_advance(uuid,uuid,date,text) from public, anon;
grant execute on function public.keel_schedule_advance(uuid,uuid,date,text) to authenticated;
grant execute on function public.keel_schedule_advance(uuid,uuid,date,text) to keel_api;
revoke all on function public.keel_schedule_enter(uuid,uuid,date) from public, anon;
grant execute on function public.keel_schedule_enter(uuid,uuid,date) to authenticated;
revoke all on function public.keel_goal_save(uuid,uuid,text,bigint,date,uuid,text) from public, anon;
grant execute on function public.keel_goal_save(uuid,uuid,text,bigint,date,uuid,text) to authenticated;
revoke all on function public.keel_goal_contribute(uuid,uuid,bigint,date) from public, anon;
grant execute on function public.keel_goal_contribute(uuid,uuid,bigint,date) to authenticated;
revoke all on function public.keel_goal_set_status(uuid,uuid,text) from public, anon;
grant execute on function public.keel_goal_set_status(uuid,uuid,text) to authenticated;
