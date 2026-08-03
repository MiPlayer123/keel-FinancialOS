-- fix(schedules): re-apply the definer-uid fix to keel_schedule_save /
-- keel_schedule_advance.
--
-- 20260713200000_definer_uid_fix.sql rewrote the keel_api-owned SECURITY
-- DEFINER schedule procs to read the actor from request.jwt claims, because
-- keel_api deliberately has NO USAGE on schema `auth` (least privilege) and so
-- cannot call auth.uid(). 20260719120100_schedule_semimonthly.sql then
-- redeclared keel_schedule_save and keel_schedule_advance with the semimonthly
-- anchor logic but REINTRODUCED `v_uid uuid := auth.uid();`, regressing the fix:
--   42501: permission denied for schema auth
--     ... during statement block local variable initialization
-- (pgTAP 014). keel_schedule_enter was not redeclared by the semimonthly
-- migration, so it still carries the fix and is left untouched here.
--
-- These bodies are byte-for-byte the semimonthly versions; only the v_uid
-- initializer changes back to the request.jwt claim coalesce.

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
  v_uid uuid := coalesce(
    nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
    nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid;
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

alter function public.keel_schedule_save(uuid,uuid,uuid,text,bigint,uuid,text,date,integer,smallint,smallint) owner to keel_api;
revoke all on function public.keel_schedule_save(uuid,uuid,uuid,text,bigint,uuid,text,date,integer,smallint,smallint) from public, anon;
grant execute on function public.keel_schedule_save(uuid,uuid,uuid,text,bigint,uuid,text,date,integer,smallint,smallint) to authenticated;

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

alter function public.keel_schedule_advance(uuid,uuid,date,text) owner to keel_api;
revoke all on function public.keel_schedule_advance(uuid,uuid,date,text) from public, anon;
grant execute on function public.keel_schedule_advance(uuid,uuid,date,text) to authenticated;

-- Same class of bug in the statement payment matcher: keel_statement_suggest_payments
-- (keel_api-owned SECURITY DEFINER, 20260720260000_statement_payment_links.sql)
-- calls auth.uid() for its own membership check and audit actor, which raises
-- 42501 "permission denied for schema auth" (pgTAP 035). Compute the actor from
-- the JWT claims (null on the service/cron path, exactly as the original
-- `auth.uid() is null` branches intend) instead. Body is otherwise verbatim.
create or replace function public.keel_statement_suggest_payments(p_household_id uuid, p_statement_id uuid)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_uid uuid := coalesce(
    nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
    nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid;
  v_s public.statements%rowtype;
  v_is_liability boolean;
  v_target bigint;
  v_count int;
  v_candidate uuid;
  v_transfer uuid;
  v_gap int;
  v_reasons text[];
  v_written int := 0;
begin
  -- Own membership check (service cron path carries no user claim).
  if v_uid is not null and not exists (
    select 1 from public.household_memberships
    where household_id = p_household_id and user_id = v_uid
  ) then
    raise exception 'KEEL_NOT_FOUND' using errcode = 'P0006';
  end if;

  select * into v_s from public.statements
   where household_id = p_household_id and id = p_statement_id;
  if not found then
    raise exception 'KEEL_NOT_FOUND: statement' using errcode = 'P0006';
  end if;

  -- Liability (credit-card) only — the canonical signal is the backing ledger
  -- account's kind, not the display subtype string.
  select la.kind = 'liability' into v_is_liability
    from public.accounts a
    join public.ledger_accounts la on la.id = a.ledger_account_id
   where a.household_id = p_household_id and a.id = v_s.account_id;
  if not coalesce(v_is_liability, false) then
    return 0;
  end if;

  -- |ending_minor| — the balance the payment(s) settle. A zero-balance
  -- statement has nothing to pay off.
  v_target := abs(v_s.ending_minor);
  if v_target = 0 then
    return 0;
  end if;

  -- Count exact candidates: card-side inflows on the liability account, same
  -- currency, non-void posted/reviewed, in [period_end, period_end+35d]
  -- INCLUSIVE, whose absolute cash amount equals |ending_minor| exactly.
  with candidates as (
    select ct.id as txn_id
      from public.canonical_transactions ct
      join public.journal_batches jb
        on jb.canonical_transaction_id = ct.id and jb.reverses_batch_id is null
       and not exists (
         select 1 from public.journal_revisions rev where rev.original_batch_id = jb.id
       )
      join public.journal_postings p on p.batch_id = jb.id
      join public.ledger_accounts la
        on la.id = p.ledger_account_id and la.is_category = false
      join public.accounts acc on acc.ledger_account_id = la.id
     where ct.household_id = p_household_id
       and acc.id = v_s.account_id
       and ct.voided_at is null
       and ct.status in ('posted', 'reviewed')
       and p.currency = v_s.currency
       and p.amount_minor > 0                                  -- card-side INFLOW
       and abs(p.amount_minor) = v_target                      -- exact
       and ct.effective_date >= v_s.period_end                 -- window start (inclusive)
       and ct.effective_date <= v_s.period_end + interval '35 days'  -- window end (inclusive)
  )
  select count(*) into v_count from candidates;

  -- AMBIGUITY: more than one exact candidate → ABSTAIN. Write nothing; the
  -- "Find payment" UI reports this as ambiguous.
  if v_count = 0 then
    return 0;
  end if;
  if v_count > 1 then
    insert into public.audit_log (household_id, actor, action, object_type, object_id, after)
    values (p_household_id,
            case when v_uid is null
                 then jsonb_build_object('kind', 'system', 'source', 'statement_payment_matcher')
                 else jsonb_build_object('kind', 'user', 'userId', v_uid) end,
            'statements.payment_abstained', 'statement', p_statement_id,
            jsonb_build_object('reason', 'ambiguous', 'candidateCount', v_count));
    return 0;
  end if;

  -- Exactly one exact candidate. Resolve it + its transfer pair (if any),
  -- ordering by the documented tie-break (moot with one candidate, but explicit
  -- for reproducibility): transfer pair first → nearest date → lowest txn id.
  select c.txn_id, c.transfer_link_id, c.date_gap
    into v_candidate, v_transfer, v_gap
    from (
      select ct.id as txn_id,
             (select tl.id from public.transfer_links tl
               where tl.household_id = p_household_id
                 and tl.status in ('suggested', 'confirmed')
                 and (tl.txn_out = ct.id or tl.txn_in = ct.id)
               order by tl.created_at, tl.id limit 1) as transfer_link_id,
             abs(ct.effective_date - v_s.period_end) as date_gap,
             exists (select 1 from public.transfer_links tl
               where tl.household_id = p_household_id
                 and tl.status in ('suggested', 'confirmed')
                 and (tl.txn_out = ct.id or tl.txn_in = ct.id)) as has_transfer
        from public.canonical_transactions ct
        join public.journal_batches jb
          on jb.canonical_transaction_id = ct.id and jb.reverses_batch_id is null
         and not exists (
           select 1 from public.journal_revisions rev where rev.original_batch_id = jb.id
         )
        join public.journal_postings p on p.batch_id = jb.id
        join public.ledger_accounts la
          on la.id = p.ledger_account_id and la.is_category = false
        join public.accounts acc on acc.ledger_account_id = la.id
       where ct.household_id = p_household_id
         and acc.id = v_s.account_id
         and ct.voided_at is null
         and ct.status in ('posted', 'reviewed')
         and p.currency = v_s.currency
         and p.amount_minor > 0
         and abs(p.amount_minor) = v_target
         and ct.effective_date >= v_s.period_end
         and ct.effective_date <= v_s.period_end + interval '35 days'
       order by has_transfer desc, date_gap, ct.id
       limit 1
    ) c;

  -- Build reason_codes. NB: the appended literal MUST be cast to text — an
  -- untyped literal makes Postgres resolve `||` as string concat (not
  -- array-append) and fail with "malformed array literal".
  v_reasons := array['exact_amount'];
  if v_transfer is not null then
    v_reasons := v_reasons || 'transfer_pair'::text;
  end if;
  if v_gap <= 10 then                                           -- date_proximity: within 10d of period_end
    v_reasons := v_reasons || 'date_proximity'::text;
  end if;

  insert into public.statement_payment_links
    (household_id, statement_id, canonical_transaction_id, transfer_link_id,
     status, score, matcher_version, reason_codes)
  values
    (p_household_id, p_statement_id, v_candidate, v_transfer,
     'suggested', 100, 'statement-payment-exact-v1', v_reasons)
  on conflict (household_id, statement_id, canonical_transaction_id) do nothing;
  get diagnostics v_written = row_count;

  if v_written > 0 then
    insert into public.audit_log (household_id, actor, action, object_type, object_id, after)
    values (p_household_id,
            case when v_uid is null
                 then jsonb_build_object('kind', 'system', 'source', 'statement_payment_matcher')
                 else jsonb_build_object('kind', 'user', 'userId', v_uid) end,
            'statements.payment_suggested', 'statement', p_statement_id,
            jsonb_build_object('transactionId', v_candidate, 'transferLinkId', v_transfer,
                               'score', 100, 'reasonCodes', to_jsonb(v_reasons)));
  end if;

  return v_written;
end;
$function$;

alter function public.keel_statement_suggest_payments(uuid,uuid) owner to keel_api;
revoke all on function public.keel_statement_suggest_payments(uuid,uuid) from public, anon;
grant execute on function public.keel_statement_suggest_payments(uuid,uuid) to authenticated, service_role;
