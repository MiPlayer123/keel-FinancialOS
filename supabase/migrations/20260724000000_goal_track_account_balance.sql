-- Savings goals that TRACK a linked account's balance (Monarch/Copilot-style).
--
-- A savings goal's progress used to be Σ goal_contributions ONLY — a purely
-- hand-entered earmark; the optional "Lives in" account was decorative. Debt
-- goals, by contrast, already DERIVE progress from the ledger balance of their
-- account (Law 9 reproducible; Law 1 no shadow arithmetic). This adds the asset
-- mirror of that path: a savings goal may TRACK a linked account, so progress =
-- the account's current asset-balance magnitude, derived at read time from
-- journal_postings — zero data entry, always recomputable from source rows.
--
-- Balance convention (debit-positive, per keel_apply_account_balance and the
-- existing debt-goal code): an asset's usable magnitude is greatest(Σ postings,
-- 0); a liability's owed magnitude is greatest(-Σ postings, 0). We branch on
-- ledger_accounts.kind so a tracked asset reads its positive balance.
--
-- Two savings tracking modes:
--   manual          — progress = Σ contributions (existing behavior, unchanged).
--   account_balance — progress = derived asset balance of account_id; requires
--                     an account; contributions REFUSED (one source of truth,
--                     exactly like debt goals).

create type public.goal_tracking as enum ('manual', 'account_balance');

alter table public.savings_goals
  add column tracking public.goal_tracking not null default 'manual';

comment on column public.savings_goals.tracking is
  'Savings goals only. manual: progress = Σ goal_contributions. account_balance: progress derived from the ledger asset-balance magnitude of account_id (contributions refused). Debt goals are always ''manual'' here — their derivation is the debt path and this column is not consulted.';

-- ---------------------------------------------------------------------------
-- keel_goal_save: signature gains p_tracking. Signature change => drop first
-- (grants die with the old signature; restated below for the new one).
-- ---------------------------------------------------------------------------
drop function public.keel_goal_save(uuid, uuid, text, bigint, date, uuid, text);

create function public.keel_goal_save(
  p_household_id uuid,
  p_goal_id uuid,
  p_name text,
  p_target_minor bigint,
  p_target_date date,
  p_account_id uuid,
  p_kind text default 'savings',
  p_tracking text default 'manual'
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_id uuid;
  v_currency text := 'USD';
  v_row public.savings_goals%rowtype;
  v_saved bigint;
  v_paid bigint;
  v_status public.goal_status;
  v_kind public.goal_kind;
  v_tracking public.goal_tracking;
  v_ledger_kind public.ledger_account_kind;
  v_ledger_account_id uuid;
  v_raw_balance bigint;
  v_start_balance bigint;
  v_progress bigint;
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
  if p_tracking is null or p_tracking not in ('manual', 'account_balance') then
    raise exception 'KEEL_INVALID_TRACKING' using errcode = 'P0009';
  end if;
  v_tracking := p_tracking::public.goal_tracking;
  -- account_balance tracking is a SAVINGS concept: a debt goal already derives
  -- from the ledger, so pairing it with account_balance is a contradiction.
  if v_kind = 'debt' and v_tracking = 'account_balance' then
    raise exception 'KEEL_DEBT_GOAL_NO_ACCOUNT_TRACKING' using errcode = 'P0009';
  end if;
  if v_kind = 'debt' and p_account_id is null then
    raise exception 'KEEL_DEBT_GOAL_REQUIRES_ACCOUNT' using errcode = 'P0009';
  end if;
  -- A tracked savings goal has nothing to track without an account.
  if v_tracking = 'account_balance' and p_account_id is null then
    raise exception 'KEEL_TRACKED_GOAL_REQUIRES_ACCOUNT' using errcode = 'P0009';
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
    -- A tracked SAVINGS goal must point at an asset — you accumulate toward a
    -- target in an asset account; tracking a liability's positive-balance
    -- magnitude would be nonsense.
    if v_tracking = 'account_balance' and v_ledger_kind is distinct from 'asset'::public.ledger_account_kind then
      raise exception 'KEEL_TRACKED_GOAL_REQUIRES_ASSET' using errcode = 'P0009';
    end if;
  end if;

  if p_goal_id is null then
    -- A NEW goal can't target the past; an existing overdue goal must stay
    -- editable (rename etc.) while keeping its own date.
    if p_target_date is not null and p_target_date < current_date then
      raise exception 'KEEL_INVALID_TARGET_DATE' using errcode = 'P0009';
    end if;

    if v_kind = 'debt' then
      -- Current ledger balance, debit-positive convention: a liability's
      -- "owed" magnitude is -Σ postings, floored at 0.
      select coalesce(sum(jp.amount_minor), 0) into v_raw_balance
        from public.journal_postings jp where jp.ledger_account_id = v_ledger_account_id;
      v_start_balance := greatest(-v_raw_balance, 0);
    else
      v_start_balance := null;
    end if;

    insert into public.savings_goals
      (household_id, name, target_minor, target_date, account_id, currency, kind,
       start_balance_minor, tracking)
    values (p_household_id, trim(p_name), p_target_minor, p_target_date, p_account_id, v_currency,
            v_kind, v_start_balance, v_tracking)
    returning id into v_id;
  else
    select * into v_row from public.savings_goals
      where id = p_goal_id and household_id = p_household_id
      for update;
    if not found then
      raise exception 'KEEL_NOT_FOUND: goal' using errcode = 'P0006';
    end if;
    -- Kind is set at creation and never migrates in place.
    if v_kind is distinct from v_row.kind then
      raise exception 'KEEL_GOAL_KIND_IMMUTABLE' using errcode = 'P0009';
    end if;
    -- Tracking mode is likewise fixed at creation: switching manual <->
    -- account_balance changes what savedMinor MEANS (a stored earmark sum vs a
    -- derived balance), and manual contributions would silently strand under a
    -- goal that no longer reads them. Immutable like kind.
    if v_tracking is distinct from v_row.tracking then
      raise exception 'KEEL_GOAL_TRACKING_IMMUTABLE' using errcode = 'P0009';
    end if;
    -- A debt goal's start_balance_minor was captured against ONE account; a
    -- tracked savings goal's progress IS that account's balance — re-pointing
    -- either would break reproducible numbers (BC-v2.1 §9.1). Immutable.
    if v_row.kind = 'debt'
       and p_account_id is distinct from v_row.account_id then
      raise exception 'KEEL_DEBT_GOAL_ACCOUNT_IMMUTABLE' using errcode = 'P0009';
    end if;
    if v_row.tracking = 'account_balance'
       and p_account_id is distinct from v_row.account_id then
      raise exception 'KEEL_TRACKED_GOAL_ACCOUNT_IMMUTABLE' using errcode = 'P0009';
    end if;
    -- Past dates are refused only when the date actually changes.
    if p_target_date is not null
       and p_target_date is distinct from v_row.target_date
       and p_target_date < current_date then
      raise exception 'KEEL_INVALID_TARGET_DATE' using errcode = 'P0009';
    end if;
    -- No funding account given: the goal keeps its currency.
    if p_account_id is null then
      v_currency := v_row.currency;
    end if;

    -- 'reached' is derived state; a target change recomputes it (archived goals
    -- keep their lifecycle status). Progress source depends on kind + tracking.
    if v_row.kind = 'debt' then
      select a.ledger_account_id into v_ledger_account_id
        from public.accounts a where a.id = coalesce(p_account_id, v_row.account_id);
      select coalesce(sum(jp.amount_minor), 0) into v_raw_balance
        from public.journal_postings jp where jp.ledger_account_id = v_ledger_account_id;
      v_progress := greatest(coalesce(v_row.start_balance_minor, 0) - greatest(-v_raw_balance, 0), 0);
    elsif v_row.tracking = 'account_balance' then
      select a.ledger_account_id into v_ledger_account_id
        from public.accounts a where a.id = coalesce(p_account_id, v_row.account_id);
      select coalesce(sum(jp.amount_minor), 0) into v_raw_balance
        from public.journal_postings jp where jp.ledger_account_id = v_ledger_account_id;
      v_progress := greatest(v_raw_balance, 0);
    else
      select coalesce(sum(amount_minor), 0) into v_progress
        from public.goal_contributions where goal_id = p_goal_id;
    end if;
    v_status := case
      when v_row.status = 'archived' then 'archived'::public.goal_status
      when v_progress >= p_target_minor then 'reached'::public.goal_status
      else 'active'::public.goal_status
    end;

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
                             'kind', v_kind::text, 'tracking', v_tracking::text,
                             'startBalanceMinor', v_start_balance::text));
  return v_id;
end;
$$;

revoke all on function public.keel_goal_save(uuid,uuid,text,bigint,date,uuid,text,text) from public, anon;
grant execute on function public.keel_goal_save(uuid,uuid,text,bigint,date,uuid,text,text) to authenticated;

-- ---------------------------------------------------------------------------
-- keel_goal_contribute: refuse contributions to account_balance-tracked goals
-- (same rationale as debt goals — one source of truth is the account balance).
-- No signature change => create-or-replace.
-- ---------------------------------------------------------------------------
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
  v_uid uuid := auth.uid();
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
  -- earmark ledger.
  if v_goal.kind = 'debt' then
    raise exception 'KEEL_DEBT_GOAL_NO_CONTRIB' using errcode = 'P0009';
  end if;
  -- A tracked savings goal's progress IS the account balance — a contribution
  -- here would be double bookkeeping against the same money (Law 1).
  if v_goal.tracking = 'account_balance' then
    raise exception 'KEEL_TRACKED_GOAL_NO_CONTRIB' using errcode = 'P0009';
  end if;

  select coalesce(sum(amount_minor), 0) into v_saved
    from public.goal_contributions where goal_id = p_goal_id;
  if v_saved + p_amount_minor < 0 then
    raise exception 'KEEL_GOAL_OVERDRAWN' using errcode = 'P0009';
  end if;

  insert into public.goal_contributions (goal_id, household_id, amount_minor, contributed_on)
  values (p_goal_id, p_household_id, p_amount_minor, p_contributed_on);
  v_saved := v_saved + p_amount_minor;

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

revoke all on function public.keel_goal_contribute(uuid,uuid,bigint,date) from public, anon;
grant execute on function public.keel_goal_contribute(uuid,uuid,bigint,date) to authenticated;

-- ---------------------------------------------------------------------------
-- keel_goal_set_status: restoring to 'active' recomputes 'reached' from the
-- correct progress source (ledger for debt/tracked, Σ contributions for
-- manual). No signature change => create-or-replace.
-- ---------------------------------------------------------------------------
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
  v_uid uuid := auth.uid();
  v_before public.goal_status;
  v_goal public.savings_goals%rowtype;
  v_ledger_account_id uuid;
  v_raw_balance bigint;
  v_progress bigint;
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
      v_progress := greatest(coalesce(v_goal.start_balance_minor, 0) - greatest(-v_raw_balance, 0), 0);
    elsif v_goal.tracking = 'account_balance' then
      select a.ledger_account_id into v_ledger_account_id
        from public.accounts a where a.id = v_goal.account_id;
      select coalesce(sum(jp.amount_minor), 0) into v_raw_balance
        from public.journal_postings jp where jp.ledger_account_id = v_ledger_account_id;
      v_progress := greatest(v_raw_balance, 0);
    else
      select coalesce(sum(amount_minor), 0) into v_progress
        from public.goal_contributions where goal_id = p_goal_id;
    end if;
    p_status := case when v_progress >= v_goal.target_minor then 'reached' else 'active' end;
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

revoke all on function public.keel_goal_set_status(uuid,uuid,text) from public, anon;
grant execute on function public.keel_goal_set_status(uuid,uuid,text) to authenticated;

-- ---------------------------------------------------------------------------
-- keel_list_goals: emit tracking; for account_balance-tracked savings goals,
-- DERIVE savedMinor from the ledger asset balance (Law 9) and recompute
-- reached on read, plus emit trackedBalanceMinor for the UI. Debt output
-- unchanged. No signature change => create-or-replace.
-- ---------------------------------------------------------------------------
create or replace function public.keel_list_goals(p_household_id uuid)
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

  select coalesce(jsonb_agg(
           -- Base object; savedMinor is the manual Σ contributions, overridden
           -- below for account_balance goals with the derived ledger balance.
           jsonb_build_object(
             'goalId', g.id,
             'name', g.name,
             'targetMinor', g.target_minor::text,
             'targetDate', g.target_date,
             'accountId', g.account_id,
             'currency', g.currency,
             'kind', g.kind,
             'tracking', g.tracking,
             'status', case
               when g.status = 'archived' then g.status
               when g.kind = 'debt' then
                 case when greatest(
                   coalesce(g.start_balance_minor, 0) - greatest(-coalesce(lb.raw_balance, 0), 0), 0
                 ) >= g.target_minor then 'reached'::public.goal_status
                 else 'active'::public.goal_status end
               when g.tracking = 'account_balance' then
                 case when greatest(coalesce(lb.raw_balance, 0), 0) >= g.target_minor
                   then 'reached'::public.goal_status
                   else 'active'::public.goal_status end
               else g.status
             end,
             'savedMinor', case
               when g.tracking = 'account_balance'
                 then greatest(coalesce(lb.raw_balance, 0), 0)::text
               else coalesce(c.saved, 0)::text
             end
           )
           || case when g.kind = 'debt' then jsonb_build_object(
                'paidMinor', greatest(
                  coalesce(g.start_balance_minor, 0) - greatest(-coalesce(lb.raw_balance, 0), 0), 0
                )::text,
                'currentBalanceMinor', greatest(-coalesce(lb.raw_balance, 0), 0)::text
              )
              when g.tracking = 'account_balance' then jsonb_build_object(
                'trackedBalanceMinor', greatest(coalesce(lb.raw_balance, 0), 0)::text
              )
              else '{}'::jsonb end
         order by g.status, g.target_date nulls last, g.name), '[]'::jsonb)
    into v_rows
    from public.savings_goals g
    left join lateral (
      select sum(gc.amount_minor) as saved
        from public.goal_contributions gc where gc.goal_id = g.id
    ) c on true
    -- Ledger balance is needed for BOTH debt goals and account_balance-tracked
    -- savings goals now (previously debt-only).
    left join lateral (
      select sum(jp.amount_minor) as raw_balance
        from public.accounts a
        join public.journal_postings jp on jp.ledger_account_id = a.ledger_account_id
        where a.id = g.account_id
    ) lb on (g.kind = 'debt' or g.tracking = 'account_balance')
    where g.household_id = p_household_id;
  return v_rows;
end;
$$;

revoke all on function public.keel_list_goals(uuid) from public, anon;
grant execute on function public.keel_list_goals(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Export (Law 6): savings_goals gained the `tracking` column. Add a NEW export
-- chain link rather than editing the shipped one. Table count unchanged
-- (column only).
-- ---------------------------------------------------------------------------
alter function public.keel_export_household(uuid,timestamptz)
  rename to keel_export_household_pre_goal_tracking;
revoke all on function public.keel_export_household_pre_goal_tracking(uuid,timestamptz)
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
  v_goals jsonb;
begin
  v_base := public.keel_export_household_pre_goal_tracking(p_household_id, p_as_of);
  -- Re-emit savings_goals with the new column so the export stays complete.
  select coalesce((select jsonb_agg(jsonb_build_object(
      'id', x.id,
      'household_id', x.household_id,
      'name', x.name,
      'target_minor', x.target_minor::text,
      'target_date', case when x.target_date is null then null
                          else to_char(x.target_date, 'YYYY-MM-DD') end,
      'account_id', x.account_id,
      'currency', x.currency,
      'status', x.status::text,
      'created_at', to_char(x.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'kind', x.kind::text,
      'start_balance_minor', x.start_balance_minor::text,
      'tracking', x.tracking::text
    ) order by x.id)
      from public.savings_goals x where x.household_id = p_household_id), '[]'::jsonb)
    into v_goals;
  return jsonb_set(v_base, '{tables,savings_goals}', v_goals);
end;
$$;
revoke all on function public.keel_export_household(uuid,timestamptz)
  from public, anon, authenticated, service_role;
grant create on schema public to keel_export;
alter function public.keel_export_household(uuid,timestamptz) owner to keel_export;
revoke create on schema public from keel_export;
grant execute on function public.keel_export_household(uuid,timestamptz) to service_role;

-- ---------------------------------------------------------------------------
-- Ownership hardening: the goal procs run SECURITY DEFINER; keel_api owns them
-- (matching 20260713180000). OWNER TO requires keel_api to hold CREATE on the
-- schema (the prod migration role is NOT superuser) — grant, alter, revoke.
-- ---------------------------------------------------------------------------
grant create on schema public to keel_api;
alter function public.keel_goal_save(uuid,uuid,text,bigint,date,uuid,text,text) owner to keel_api;
alter function public.keel_goal_contribute(uuid,uuid,bigint,date) owner to keel_api;
alter function public.keel_goal_set_status(uuid,uuid,text) owner to keel_api;
alter function public.keel_list_goals(uuid) owner to keel_api;
revoke create on schema public from keel_api;

revoke all on function public.keel_goal_save(uuid,uuid,text,bigint,date,uuid,text,text) from public, anon;
grant execute on function public.keel_goal_save(uuid,uuid,text,bigint,date,uuid,text,text) to authenticated;
revoke all on function public.keel_goal_contribute(uuid,uuid,bigint,date) from public, anon;
grant execute on function public.keel_goal_contribute(uuid,uuid,bigint,date) to authenticated;
revoke all on function public.keel_goal_set_status(uuid,uuid,text) from public, anon;
grant execute on function public.keel_goal_set_status(uuid,uuid,text) to authenticated;
revoke all on function public.keel_list_goals(uuid) from public, anon;
grant execute on function public.keel_list_goals(uuid) to authenticated, service_role;
