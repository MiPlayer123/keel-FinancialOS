-- Server-side atomic Enter for scheduled transactions + day-of-month anchoring
-- (NOTES.md gaps from 20260713140000_scheduled_transactions.sql):
--
-- 1. Post-then-advance was client-orchestrated (two round trips): the post
--    could succeed and the advance fail, leaving a due date stuck on an
--    already-entered occurrence. keel_schedule_enter below does both inside
--    ONE function — one transaction, commits or rolls back together.
-- 2. Postgres `date + interval '1 month'` clamps to the last day of the
--    target month and STAYS there forever (Jan 31 -> Feb 28 -> Mar 28, never
--    back to 31). Quicken anchors to the originally-declared day of month and
--    recovers it whenever the target month is long enough again. anchor_day
--    records that original day; advancing now targets
--    min(anchor_day, days_in_target_month).

-- ---------------------------------------------------------------------------
-- 0. Schema: anchor_day, backfilled from the existing next_due_date.
-- ---------------------------------------------------------------------------
alter table public.scheduled_transactions
  add column anchor_day smallint check (anchor_day between 1 and 31);

update public.scheduled_transactions
   set anchor_day = extract(day from next_due_date)::smallint
 where anchor_day is null;

-- ---------------------------------------------------------------------------
-- 1. keel_schedule_save: unchanged behavior, plus anchor_day set from the day
-- of p_next_due_date on both create and update (an update always re-anchors
-- to whatever next_due_date it is given — including a user-changed date).
-- ---------------------------------------------------------------------------
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

revoke all on function public.keel_schedule_save(uuid,uuid,uuid,text,bigint,uuid,text,date,integer) from public, anon;
grant execute on function public.keel_schedule_save(uuid,uuid,uuid,text,bigint,uuid,text,date,integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. keel_schedule_advance: same fence semantics (advance only when
-- next_due_date = p_from_due; else idempotent no-op; 'once' -> ended; audit
-- on real advance only). Monthly/quarterly/semiannual/annual now target
-- min(anchor_day, days_in_target_month) instead of naive interval addition.
-- weekly/biweekly/once unchanged.
-- ---------------------------------------------------------------------------
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
  v_uid uuid := auth.uid();
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

revoke all on function public.keel_schedule_advance(uuid,uuid,date,text) from public, anon;
grant execute on function public.keel_schedule_advance(uuid,uuid,date,text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. keel_schedule_enter: atomic post + advance. A stale tab (fence mismatch)
-- is NOT an error — it returns {entered:false, reason:'moved', ...} so the
-- client can just refresh. Posts through the existing manual-transaction
-- envelope (keel_cmd_manual_transaction) so idempotent economics (invariant
-- 3), splits validation, period locks, etc. are inherited for free — this
-- proc adds nothing new to the money path, only the fence + advance wrapper.
--
-- Ownership/grants investigated on the scratch DB before writing this:
-- keel_cmd_manual_transaction is owned by keel_api (SECURITY DEFINER) and its
-- ACL already grants EXECUTE to authenticated (proacl:
-- "keel_api=X/keel_api,authenticated=X/keel_api"). This proc follows the
-- keel_schedule_* house pattern and is owned by postgres — a superuser on
-- this instance, which bypasses EXECUTE grant checks entirely, so the nested
-- call already works today. We restate the grant explicitly below anyway
-- (belt-and-suspenders): if this proc is ever re-owned to a non-superuser
-- role, the nested call keeps working without a silent permission-denied.
-- ---------------------------------------------------------------------------
create function public.keel_schedule_enter(
  p_household_id uuid,
  p_schedule_id uuid,
  p_from_due date
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
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

-- Explicit belt-and-suspenders grant (see comment above): does nothing extra
-- while postgres owns this function (superuser bypasses the check), but
-- keeps the nested call correct if ownership ever changes.
grant execute on function public.keel_cmd_manual_transaction(uuid,text,jsonb,uuid,jsonb) to postgres;

revoke all on function public.keel_schedule_enter(uuid,uuid,date) from public, anon;
grant execute on function public.keel_schedule_enter(uuid,uuid,date) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. keel_list_schedules: emit anchorDay (ACL restated per house rule).
-- ---------------------------------------------------------------------------
create or replace function public.keel_list_schedules(p_household_id uuid)
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
           'anchorDay', s.anchor_day,
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
-- 5. Export (Law 6): scheduled_transactions gained a column — the export
-- wrapper must build this table's DTO explicitly with the new field. New
-- chain link (same dance as _pre_goals): rename current head, revoke
-- everything from it, create the new head, own it to keel_export, grant
-- EXECUTE to service_role only.
-- ---------------------------------------------------------------------------
alter function public.keel_export_household(uuid,timestamptz)
  rename to keel_export_household_pre_schedule_anchor;
revoke all on function public.keel_export_household_pre_schedule_anchor(uuid,timestamptz)
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
  v_base := public.keel_export_household_pre_schedule_anchor(p_household_id, p_as_of);
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
      'anchor_day', x.anchor_day,
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
