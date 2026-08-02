-- Law 11 (typed AI responses / approval tokens): optional token binding for
-- budget commands. Pattern copied from
-- 20260720280000_statement_approve_draft_single_source.sql /
-- public.keel_cmd_statements_approve_draft and
-- 20260720270000_statement_holdings_apply.sql /
-- public.keel_cmd_statements_apply_holdings.

-- budgets.set_total — plan total for a month (amount or percent_of_income).
create or replace function public.keel_cmd_budgets_set_total(
  p_command_id uuid, p_economic_event_key text, p_actor jsonb, p_household_id uuid, p_payload jsonb,
  p_approval_token_id uuid default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_hash text := public.keel_payload_hash(p_payload); v_replay jsonb; v_actor jsonb;
  v_month date; v_basis public.budget_total_basis; v_amount bigint; v_bp int;
  v_currency char(3); v_after jsonb; v_result jsonb; v_approval_payload jsonb;
begin
  perform public.keel_assert_member_write(p_household_id);
  v_actor := public.keel_actor_from_jwt();
  v_replay := public.keel_idempotency_check(p_household_id, p_economic_event_key, v_hash);
  if v_replay is not null then return v_replay; end if;

  v_month := date_trunc('month', (p_payload->>'month')::date)::date;
  v_basis := (p_payload->>'basis')::public.budget_total_basis;
  v_currency := coalesce(nullif(p_payload->>'currency',''), 'USD');
  if v_basis = 'amount' then
    v_amount := (p_payload->>'amount_minor')::bigint;
    if v_amount is null or v_amount < 0 then
      raise exception 'KEEL_INVALID_COMMAND: total amount must be non-negative' using errcode='P0009'; end if;
    v_bp := null;
  else
    v_bp := (p_payload->>'percent_bp')::int;
    if v_bp is null or v_bp < 0 or v_bp > 10000 then
      raise exception 'KEEL_INVALID_COMMAND: percent_bp out of range' using errcode='P0009'; end if;
    v_amount := null;
  end if;

  if p_approval_token_id is not null then
    v_approval_payload := jsonb_build_object(
      'month', to_char(v_month, 'YYYY-MM-DD'),
      'basis', v_basis::text,
      'amount_minor', v_amount::text,
      'percent_bp', v_bp,
      'currency', v_currency::text
    );
    perform public.keel_approval_token_redeem(
      p_household_id, p_approval_token_id, p_command_id, v_actor,
      'budgets.set_total', v_approval_payload, 1
    );
  end if;

  -- End-date any live total row that STARTED BEFORE this month (a new era).
  update public.budget_targets
     set end_month = v_month
   where household_id = p_household_id and category_ledger_account_id is null
     and end_month is null and effective_month < v_month;
  -- Replace a same-month open total row in place (correction). Law 2 + the
  -- 2026-07-17 soft-delete directive: TOMBSTONE the superseded row (end_month =
  -- effective_month → covers zero live months) instead of DELETE, so the
  -- correction is reversible and audit-consistent — matching remove_target. The
  -- 'one live total' partial index (WHERE end_month IS NULL) no longer sees the
  -- tombstoned row, so the fresh insert below does not collide.
  update public.budget_targets
     set end_month = effective_month
   where household_id = p_household_id and category_ledger_account_id is null
     and end_month is null and effective_month = v_month;
  insert into public.budget_targets
    (household_id, category_ledger_account_id, effective_month, total_basis, amount_minor, percent_bp, rollover, currency)
  values (p_household_id, null, v_month, v_basis, v_amount, v_bp, false, v_currency);

  v_after := jsonb_build_object('month', to_char(v_month,'YYYY-MM'), 'basis', v_basis,
    'amountMinor', v_amount::text, 'percentBp', v_bp);
  v_result := jsonb_build_object('commandId', p_command_id, 'economicEventKey', p_economic_event_key,
    'idempotentReplay', false, 'effects', v_after,
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'));
  perform public.keel_finish_command(p_command_id, 'budgets.set_total', p_economic_event_key,
    p_household_id, v_actor, v_hash, 'budgets.total_set', 'household', p_household_id, v_after, v_result);
  return v_result;
end;
$$;

-- budgets.set_target — a category target (amount or percent_of_total).
create or replace function public.keel_cmd_budgets_set_target(
  p_command_id uuid, p_economic_event_key text, p_actor jsonb, p_household_id uuid, p_payload jsonb,
  p_approval_token_id uuid default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_hash text := public.keel_payload_hash(p_payload); v_replay jsonb; v_actor jsonb;
  v_month date; v_cat uuid; v_kind public.budget_target_kind; v_amount bigint; v_bp int;
  v_rollover boolean; v_currency char(3); v_after jsonb; v_result jsonb; v_approval_payload jsonb;
begin
  perform public.keel_assert_member_write(p_household_id);
  v_actor := public.keel_actor_from_jwt();
  v_replay := public.keel_idempotency_check(p_household_id, p_economic_event_key, v_hash);
  if v_replay is not null then return v_replay; end if;

  v_month := date_trunc('month', (p_payload->>'month')::date)::date;
  v_cat := (p_payload->>'category_ledger_account_id')::uuid;
  v_kind := (p_payload->>'kind')::public.budget_target_kind;
  v_rollover := coalesce((p_payload->>'rollover')::boolean, false);

  -- Category MUST be a live expense category in this household. currency is
  -- pinned to the category's own currency (Law 4), never caller-supplied.
  select la.currency into v_currency
    from public.ledger_accounts la
   where la.id = v_cat and la.household_id = p_household_id
     and la.is_category = true and la.kind = 'expense' and la.archived_at is null;
  if v_currency is null then
    raise exception 'KEEL_INVALID_COMMAND: invalid budget category' using errcode='P0009'; end if;

  if v_kind = 'amount' then
    v_amount := (p_payload->>'amount_minor')::bigint;
    if v_amount is null or v_amount < 0 then
      raise exception 'KEEL_INVALID_COMMAND: target amount must be non-negative' using errcode='P0009'; end if;
    v_bp := null;
  else
    v_bp := (p_payload->>'percent_bp')::int;
    if v_bp is null or v_bp < 0 or v_bp > 10000 then
      raise exception 'KEEL_INVALID_COMMAND: percent_bp out of range' using errcode='P0009'; end if;
    v_amount := null;
  end if;

  if p_approval_token_id is not null then
    v_approval_payload := jsonb_build_object(
      'month', to_char(v_month, 'YYYY-MM-DD'),
      'category_ledger_account_id', v_cat::text,
      'kind', v_kind::text,
      'amount_minor', v_amount::text,
      'percent_bp', v_bp,
      'rollover', v_rollover,
      'currency', v_currency::text
    );
    perform public.keel_approval_token_redeem(
      p_household_id, p_approval_token_id, p_command_id, v_actor,
      'budgets.set_target', v_approval_payload, 1
    );
  end if;

  update public.budget_targets
     set end_month = v_month
   where household_id = p_household_id and category_ledger_account_id = v_cat
     and end_month is null and effective_month < v_month;
  -- Same-month correction: TOMBSTONE the superseded open row (Law 2 + 2026-07-17
  -- soft-delete directive), never DELETE. end_month = effective_month → zero live
  -- months, excluded by the 'one live category' partial index (WHERE end_month IS
  -- NULL), so the fresh insert below is collision-free and the old target stays
  -- auditable/reversible.
  update public.budget_targets
     set end_month = effective_month
   where household_id = p_household_id and category_ledger_account_id = v_cat
     and end_month is null and effective_month = v_month;
  insert into public.budget_targets
    (household_id, category_ledger_account_id, effective_month, target_kind, amount_minor, percent_bp, rollover, currency)
  values (p_household_id, v_cat, v_month, v_kind, v_amount, v_bp, v_rollover, v_currency);

  v_after := jsonb_build_object('month', to_char(v_month,'YYYY-MM'), 'categoryLedgerAccountId', v_cat,
    'kind', v_kind, 'amountMinor', v_amount::text, 'percentBp', v_bp, 'rollover', v_rollover);
  v_result := jsonb_build_object('commandId', p_command_id, 'economicEventKey', p_economic_event_key,
    'idempotentReplay', false, 'effects', v_after,
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'));
  perform public.keel_finish_command(p_command_id, 'budgets.set_target', p_economic_event_key,
    p_household_id, v_actor, v_hash, 'budgets.target_set', 'ledger_account', v_cat, v_after, v_result);
  return v_result;
end;
$$;

-- budgets.remove_target — soft removal (end-date), never DELETE.
create or replace function public.keel_cmd_budgets_remove_target(
  p_command_id uuid, p_economic_event_key text, p_actor jsonb, p_household_id uuid, p_payload jsonb,
  p_approval_token_id uuid default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_hash text := public.keel_payload_hash(p_payload); v_replay jsonb; v_actor jsonb;
  v_month date; v_cat uuid; v_after jsonb; v_result jsonb; v_affected int; v_approval_payload jsonb;
begin
  perform public.keel_assert_member_write(p_household_id);
  v_actor := public.keel_actor_from_jwt();
  v_replay := public.keel_idempotency_check(p_household_id, p_economic_event_key, v_hash);
  if v_replay is not null then return v_replay; end if;

  v_month := date_trunc('month', (p_payload->>'month')::date)::date;
  v_cat := (p_payload->>'category_ledger_account_id')::uuid;
  if v_cat is null then
    raise exception 'KEEL_INVALID_COMMAND: category required' using errcode='P0009'; end if;

  if p_approval_token_id is not null then
    v_approval_payload := jsonb_build_object(
      'month', to_char(v_month, 'YYYY-MM-DD'),
      'category_ledger_account_id', v_cat::text
    );
    perform public.keel_approval_token_redeem(
      p_household_id, p_approval_token_id, p_command_id, v_actor,
      'budgets.remove_target', v_approval_payload, 1
    );
  end if;

  -- Soft removal from THIS month onward. A row that STARTED BEFORE this month is
  -- end-dated at v_month (it stays effective for prior months — reversible). A
  -- row that STARTS this month is tombstoned (end_month = effective_month), so
  -- it covers zero live months but is never DELETEd (soft-delete directive).
  update public.budget_targets
     set end_month = case when effective_month < v_month then v_month
                          else effective_month end
   where household_id = p_household_id and category_ledger_account_id = v_cat
     and end_month is null and effective_month <= v_month;
  get diagnostics v_affected = row_count;
  if v_affected = 0 then
    raise exception 'KEEL_INVALID_COMMAND: no live target to remove' using errcode='P0009'; end if;

  v_after := jsonb_build_object('month', to_char(v_month,'YYYY-MM'), 'categoryLedgerAccountId', v_cat, 'removed', true);
  v_result := jsonb_build_object('commandId', p_command_id, 'economicEventKey', p_economic_event_key,
    'idempotentReplay', false, 'effects', v_after,
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'));
  perform public.keel_finish_command(p_command_id, 'budgets.remove_target', p_economic_event_key,
    p_household_id, v_actor, v_hash, 'budgets.target_removed', 'ledger_account', v_cat, v_after, v_result);
  return v_result;
end;
$$;

-- budgets.set_expected_income — user-confirmed expected income for a month.
create or replace function public.keel_cmd_budgets_set_expected_income(
  p_command_id uuid, p_economic_event_key text, p_actor jsonb, p_household_id uuid, p_payload jsonb,
  p_approval_token_id uuid default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_hash text := public.keel_payload_hash(p_payload); v_replay jsonb; v_actor jsonb;
  v_month date; v_amount bigint; v_currency char(3); v_after jsonb; v_result jsonb; v_approval_payload jsonb;
begin
  perform public.keel_assert_member_write(p_household_id);
  v_actor := public.keel_actor_from_jwt();
  v_replay := public.keel_idempotency_check(p_household_id, p_economic_event_key, v_hash);
  if v_replay is not null then return v_replay; end if;

  v_month := date_trunc('month', (p_payload->>'month')::date)::date;
  v_amount := (p_payload->>'amount_minor')::bigint;
  v_currency := coalesce(nullif(p_payload->>'currency',''), 'USD');
  if v_amount is null or v_amount < 0 then
    raise exception 'KEEL_INVALID_COMMAND: expected income must be non-negative' using errcode='P0009'; end if;

  if p_approval_token_id is not null then
    v_approval_payload := jsonb_build_object(
      'month', to_char(v_month, 'YYYY-MM-DD'),
      'amount_minor', v_amount::text,
      'currency', v_currency::text
    );
    perform public.keel_approval_token_redeem(
      p_household_id, p_approval_token_id, p_command_id, v_actor,
      'budgets.set_expected_income', v_approval_payload, 1
    );
  end if;

  update public.budget_expected_income
     set end_month = v_month
   where household_id = p_household_id and end_month is null and effective_month < v_month;
  -- Same-month correction: TOMBSTONE the superseded open row (Law 2 + 2026-07-17
  -- soft-delete directive), never DELETE. end_month = effective_month → zero live
  -- months, excluded by budget_expected_income_one_live (WHERE end_month IS NULL),
  -- so the fresh insert is collision-free and the prior figure stays auditable.
  update public.budget_expected_income
     set end_month = effective_month
   where household_id = p_household_id and end_month is null and effective_month = v_month;
  insert into public.budget_expected_income
    (household_id, effective_month, amount_minor, currency)
  values (p_household_id, v_month, v_amount, v_currency);

  v_after := jsonb_build_object('month', to_char(v_month,'YYYY-MM'), 'amountMinor', v_amount::text);
  v_result := jsonb_build_object('commandId', p_command_id, 'economicEventKey', p_economic_event_key,
    'idempotentReplay', false, 'effects', v_after,
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'));
  perform public.keel_finish_command(p_command_id, 'budgets.set_expected_income', p_economic_event_key,
    p_household_id, v_actor, v_hash, 'budgets.expected_income_set', 'household', p_household_id, v_after, v_result);
  return v_result;
end;
$$;

-- The trailing parameter creates the token-aware overload. Preserve the
-- existing keel_api ownership and authenticated-only execution posture.
grant create on schema public to keel_api;
alter function public.keel_cmd_budgets_set_total(uuid,text,jsonb,uuid,jsonb,uuid) owner to keel_api;
alter function public.keel_cmd_budgets_set_target(uuid,text,jsonb,uuid,jsonb,uuid) owner to keel_api;
alter function public.keel_cmd_budgets_remove_target(uuid,text,jsonb,uuid,jsonb,uuid) owner to keel_api;
alter function public.keel_cmd_budgets_set_expected_income(uuid,text,jsonb,uuid,jsonb,uuid) owner to keel_api;
revoke create on schema public from keel_api;

revoke all on function public.keel_cmd_budgets_set_total(uuid,text,jsonb,uuid,jsonb,uuid),
  public.keel_cmd_budgets_set_target(uuid,text,jsonb,uuid,jsonb,uuid),
  public.keel_cmd_budgets_remove_target(uuid,text,jsonb,uuid,jsonb,uuid),
  public.keel_cmd_budgets_set_expected_income(uuid,text,jsonb,uuid,jsonb,uuid) from public, anon;
grant execute on function public.keel_cmd_budgets_set_total(uuid,text,jsonb,uuid,jsonb,uuid),
  public.keel_cmd_budgets_set_target(uuid,text,jsonb,uuid,jsonb,uuid),
  public.keel_cmd_budgets_remove_target(uuid,text,jsonb,uuid,jsonb,uuid),
  public.keel_cmd_budgets_set_expected_income(uuid,text,jsonb,uuid,jsonb,uuid) to authenticated;

do $$begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_roles r on r.oid=p.proowner
    where n.nspname='public' and p.proname in ('keel_cmd_budgets_set_total','keel_cmd_budgets_set_target',
      'keel_cmd_budgets_remove_target','keel_cmd_budgets_set_expected_income')
      and p.prosecdef and r.rolname<>'keel_api') then
    raise exception 'KEEL_OWNERSHIP: budget approval-token definer owner'; end if;
end$$;
