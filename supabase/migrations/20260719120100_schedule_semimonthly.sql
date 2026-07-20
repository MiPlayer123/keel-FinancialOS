-- Semi-monthly (twice a month) scheduled income/bills — PART 2 of 2: column +
-- function replacements. The enum value 'semimonthly' is added by the
-- COMPANION migration 20260719120000_schedule_semimonthly_enum.sql, which MUST
-- be applied FIRST and NON-transactionally (ADD VALUE cannot be used in the
-- same transaction it is created in). See that file's header for the exact
-- psql commands.
--
-- Semi-monthly means two anchor days per month (default 15th & 30th). The
-- schedule already carries a single anchor_day; this migration adds a SECOND
-- anchor_day_2 (nullable; only meaningful for the 'semimonthly' frequency).
-- Advancing from any due date targets the NEXT of the two anchor days:
--   * this month's LARGER anchor, if the current due date is before it, else
--   * next month's SMALLER anchor,
-- each clamped with the SAME least(anchor, days_in_target_month) pattern the
-- monthly branch uses — so a "30th" anchor lands on Feb 28/29 automatically
-- and recovers to Mar 30 (Jan 15/30 -> Feb 15/28 -> Mar 15/30).

-- ---------------------------------------------------------------------------
-- 0. Schema: anchor_day_2 (second day of month for semi-monthly schedules).
-- ---------------------------------------------------------------------------
alter table public.scheduled_transactions
  add column if not exists anchor_day_2 smallint check (anchor_day_2 between 1 and 31);

-- ---------------------------------------------------------------------------
-- 1. keel_schedule_save: new signature accepting explicit anchor_day and
-- anchor_day_2 (both nullable). Non-semimonthly callers may still pass NULL
-- for both, in which case anchor_day continues to derive from the day of
-- p_next_due_date exactly as before (backward-compatible). anchor_day_2 is
-- only stored for semimonthly; it is cleared to NULL for every other
-- frequency so a later frequency change can't leave a stale second day.
--
-- The signature GAINS two trailing params, so `create or replace` would leave
-- the old 9-arg overload in place — two overloads reachable by the same named
-- args is an ambiguous-function error at call time. Drop the old one first.
-- ---------------------------------------------------------------------------
drop function if exists public.keel_schedule_save(uuid,uuid,uuid,text,bigint,uuid,text,date,integer);

create or replace function public.keel_schedule_save(
  p_household_id uuid,
  p_schedule_id uuid,
  p_account_id uuid,
  p_description text,
  p_amount_minor bigint,
  p_category_ledger_account_id uuid,
  p_frequency text,
  p_next_due_date date,
  p_auto_enter_days integer,
  p_anchor_day smallint default null,
  p_anchor_day_2 smallint default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_id uuid;
  v_kind text;
  v_anchor smallint;
  v_anchor_2 smallint;
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
  if p_anchor_day is not null and (p_anchor_day < 1 or p_anchor_day > 31) then
    raise exception 'KEEL_INVALID_ANCHOR_DAY' using errcode = 'P0009';
  end if;
  if p_anchor_day_2 is not null and (p_anchor_day_2 < 1 or p_anchor_day_2 > 31) then
    raise exception 'KEEL_INVALID_ANCHOR_DAY' using errcode = 'P0009';
  end if;
  -- Semi-monthly needs two distinct anchor days; every other frequency stores
  -- no second day (so a later frequency change leaves nothing stale behind).
  if p_frequency = 'semimonthly' then
    if p_anchor_day is null or p_anchor_day_2 is null then
      raise exception 'KEEL_SEMIMONTHLY_NEEDS_TWO_DAYS' using errcode = 'P0009';
    end if;
    if p_anchor_day = p_anchor_day_2 then
      raise exception 'KEEL_SEMIMONTHLY_DAYS_MUST_DIFFER' using errcode = 'P0009';
    end if;
    -- Normalize so anchor_day < anchor_day_2 (advance logic assumes ordered).
    v_anchor   := least(p_anchor_day, p_anchor_day_2);
    v_anchor_2 := greatest(p_anchor_day, p_anchor_day_2);
  else
    -- Fall back to the day of the next due date when no anchor is supplied,
    -- preserving the original derive-from-date behavior for callers that
    -- don't pass an explicit anchor (weekly/monthly/etc.).
    v_anchor   := coalesce(p_anchor_day, extract(day from p_next_due_date)::smallint);
    v_anchor_2 := null;
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
       category_ledger_account_id, frequency, next_due_date, auto_enter_days,
       anchor_day, anchor_day_2)
    select p_household_id, p_account_id, trim(p_description), p_amount_minor,
           a.currency, p_category_ledger_account_id,
           p_frequency::public.schedule_frequency, p_next_due_date, p_auto_enter_days,
           v_anchor, v_anchor_2
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
          -- Semi-monthly always re-anchors to the explicit (normalized) pair.
          -- For every other frequency, re-anchor ONLY when the caller actually
          -- changed the due date and passed no explicit anchor — an edit that
          -- echoes back an already-clamped date (a 31-anchor sitting on Feb 28)
          -- must not collapse the anchor to 28 (the month-end drift this
          -- subsystem exists to avoid).
          anchor_day = case
            when p_frequency = 'semimonthly' then v_anchor
            when p_anchor_day is not null then v_anchor
            when p_next_due_date is distinct from next_due_date
              then extract(day from p_next_due_date)::smallint
            else anchor_day
          end,
          anchor_day_2 = v_anchor_2
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
            'autoEnterDays', p_auto_enter_days,
            'anchorDay', v_anchor, 'anchorDay2', v_anchor_2));
  return v_id;
end;
$$;

revoke all on function public.keel_schedule_save(uuid,uuid,uuid,text,bigint,uuid,text,date,integer,smallint,smallint) from public, anon;
grant execute on function public.keel_schedule_save(uuid,uuid,uuid,text,bigint,uuid,text,date,integer,smallint,smallint) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. keel_schedule_advance: add a 'semimonthly' branch. From the current due
-- date, target the NEXT of the two anchor days:
--   * this month's LARGER anchor (clamped) when we're strictly before it, else
--   * next month's SMALLER anchor (clamped).
-- Same least(anchor, days_in_target_month) clamp as the monthly branch, so a
-- "30" anchor becomes Feb 28/29 and recovers to Mar 30 next time. Comparison
-- uses the CLAMPED larger anchor (e.g. a 30-anchor sitting on Feb 28 is "at"
-- its larger anchor, so it correctly rolls to Mar 15, not back to Feb 28).
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
  v_a1 int;
  v_a2 int;
  v_this_month_start date;
  v_this_days int;
  v_this_larger date;
  v_next_month_start date;
  v_next_days int;
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

  if v_row.frequency = 'semimonthly' then
    -- Two anchor days per month; step to the NEXT one. anchor_day <
    -- anchor_day_2 is guaranteed at save time; be defensive with least/
    -- greatest and a fallback for legacy/incomplete rows.
    v_a1 := least(coalesce(v_row.anchor_day, extract(day from p_from_due)::int),
                  coalesce(v_row.anchor_day_2, extract(day from p_from_due)::int));
    v_a2 := greatest(coalesce(v_row.anchor_day, extract(day from p_from_due)::int),
                     coalesce(v_row.anchor_day_2, extract(day from p_from_due)::int));

    v_this_month_start := date_trunc('month', p_from_due)::date;
    v_this_days := extract(day from ((v_this_month_start + interval '1 month') - interval '1 day'))::int;
    v_this_larger := (v_this_month_start + (least(v_a2, v_this_days) - 1) * interval '1 day')::date;

    if p_from_due < v_this_larger then
      -- Still before this month's larger anchor: that's the next occurrence.
      v_next := v_this_larger;
    else
      -- At/after this month's larger anchor: roll to next month's smaller.
      v_next_month_start := (v_this_month_start + interval '1 month')::date;
      v_next_days := extract(day from ((v_next_month_start + interval '1 month') - interval '1 day'))::int;
      v_next := (v_next_month_start + (least(v_a1, v_next_days) - 1) * interval '1 day')::date;
    end if;
  else
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
-- 3. keel_list_schedules: emit anchorDay2 alongside anchorDay.
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
           'anchorDay2', s.anchor_day_2,
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
-- 4. Export (Law 6): scheduled_transactions gained anchor_day_2 — the export
-- wrapper must build this table's DTO with the new field. New chain link:
-- rename current head, revoke everything from it, create the new head, own it
-- to keel_export, grant EXECUTE to service_role only.
-- ---------------------------------------------------------------------------
alter function public.keel_export_household(uuid,timestamptz)
  rename to keel_export_household_pre_schedule_anchor2;
revoke all on function public.keel_export_household_pre_schedule_anchor2(uuid,timestamptz)
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
  v_base := public.keel_export_household_pre_schedule_anchor2(p_household_id, p_as_of);
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
      'anchor_day_2', x.anchor_day_2,
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
