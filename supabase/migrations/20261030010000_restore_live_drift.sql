-- Bring production back in line with supabase/migrations where
-- live-schema-drift (2026-10-30) found it had diverged. Every statement here
-- re-states an existing migration's definition verbatim, so on any database
-- where those migrations applied as written this file changes nothing. Safe to
-- re-run: CREATE OR REPLACE for functions (owner and grants kept), DROP POLICY
-- IF EXISTS before each CREATE POLICY.
--
-- 1. keel_disconnect_complete (20260718051000_credential_delete_guard.sql).
--    Production's copy lacked
--        perform set_config('keel.credential_delete_acknowledged', 'false', true);
--    right after the one sanctioned connection_credentials delete, so the
--    acknowledgement stayed set for the rest of the calling transaction instead
--    of covering exactly one delete. Not reachable through the API today (the
--    edge function deletes nothing else in that transaction), but it is the
--    guard CLAUDE.md "Ops facts" relies on after the 2026-07-17 incident.
--
-- 2. Nine RLS policies from 20260713010000, 20260713040000 and 20260713050000
--    that never reached production. RLS is on for all five tables there, so the
--    gap hid rows rather than exposing them: keel_export (NOBYPASSRLS) owns the
--    export layers that read these tables, and with no keel_export policy
--    admin.export_all returned zero budgets, category rules, rule renames,
--    transaction categories and transaction overrides (Law 6). The member_read
--    policies have no current reader (the web reads these through definer
--    procs) and are restored so production matches the migrations.
--
-- 3. Three admin.export_all wrapper layers. Production applied 20260719090000,
--    20260719120100, 20260720100000, 20260720270000 and 20260721180000 out of
--    order, so the same layers sit under different names. Every table was still
--    exported; this re-states each name with the body the migrations give it.

-- 1 ---------------------------------------------------------------------------
create or replace function public.keel_disconnect_complete(
  p_household_id uuid,
  p_connection_id uuid,
  p_removal_attempt_id uuid,
  p_removed boolean,
  p_failure text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_conn public.connections%rowtype;
  v_attempt public.removal_attempts%rowtype;
  v_actor jsonb;
begin
  select * into v_conn
    from public.connections
   where id = p_connection_id and household_id = p_household_id
   for update;
  if not found then
    raise exception 'KEEL_SCOPE_VIOLATION: connection not in household' using errcode = 'P0006';
  end if;
  select * into v_attempt
    from public.removal_attempts
   where id = p_removal_attempt_id
     and household_id = p_household_id
     and connection_id = p_connection_id
   for update;
  if not found then
    raise exception 'KEEL_SCOPE_VIOLATION: removal attempt mismatch' using errcode = 'P0006';
  end if;

  if v_conn.status = 'disconnected' and v_attempt.state = 'succeeded' then
    return;
  end if;
  if v_conn.status <> 'disconnecting' or v_attempt.state <> 'pending' then
    raise exception 'KEEL_INVALID_COMMAND: stale disconnect transition' using errcode = 'P0009';
  end if;

  v_actor := jsonb_build_object('kind', 'user', 'userId', v_attempt.initiated_by_user_id);
  if p_removed then
    perform set_config('keel.credential_delete_acknowledged', 'true', true);
    delete from public.connection_credentials
     where household_id = p_household_id and connection_id = p_connection_id;
    -- Re-arm immediately: the ack is a single-delete permission slip, not a
    -- standing grant for the rest of whatever transaction called this proc.
    perform set_config('keel.credential_delete_acknowledged', 'false', true);
    update public.connections set status = 'disconnected' where id = p_connection_id;
    update public.removal_attempts
       set state = 'succeeded', completed_at = now(), failure_code = null
     where id = p_removal_attempt_id;
    insert into public.audit_log
      (household_id, actor, action, object_type, object_id, after)
    values
      (p_household_id, v_actor, 'connection.disconnected', 'connection', p_connection_id,
       jsonb_build_object('connectionId', p_connection_id,
                          'removalAttemptId', p_removal_attempt_id));
  else
    update public.removal_attempts
       set state = 'failed', completed_at = now(), failure_code = p_failure
     where id = p_removal_attempt_id;
    insert into public.audit_log
      (household_id, actor, action, object_type, object_id, after)
    values
      (p_household_id, v_actor, 'connection.disconnect_failed', 'connection', p_connection_id,
       jsonb_build_object('connectionId', p_connection_id,
                          'removalAttemptId', p_removal_attempt_id,
                          'failureCode', p_failure));
  end if;
end;
$$;

-- 2 ---------------------------------------------------------------------------
-- Verbatim from 20260713010000_transaction_overrides.sql.
drop policy if exists transaction_overrides_member_read on public.transaction_overrides;
create policy transaction_overrides_member_read on public.transaction_overrides
  for select to authenticated
  using (exists (
    select 1 from public.household_memberships m
    where m.household_id = transaction_overrides.household_id and m.user_id = auth.uid()
  ));
grant select on public.transaction_overrides to authenticated;
grant select on public.transaction_categories, public.transaction_overrides to keel_export;
drop policy if exists transaction_categories_export on public.transaction_categories;
create policy transaction_categories_export on public.transaction_categories
  for select to keel_export using (true);
drop policy if exists transaction_overrides_export on public.transaction_overrides;
create policy transaction_overrides_export on public.transaction_overrides
  for select to keel_export using (true);

-- Verbatim from 20260713040000_category_rules.sql.
drop policy if exists category_rules_member_read on public.category_rules;
create policy category_rules_member_read on public.category_rules
  for select to authenticated
  using (exists (
    select 1 from public.household_memberships m
    where m.household_id = category_rules.household_id and m.user_id = auth.uid()
  ));
grant select on public.category_rules to authenticated;
drop policy if exists rule_renames_member_read on public.rule_renames;
create policy rule_renames_member_read on public.rule_renames
  for select to authenticated
  using (exists (
    select 1 from public.household_memberships m
    where m.household_id = rule_renames.household_id and m.user_id = auth.uid()
  ));
grant select on public.rule_renames to authenticated;
grant select on public.category_rules, public.rule_renames to keel_export;
drop policy if exists category_rules_export on public.category_rules;
create policy category_rules_export on public.category_rules
  for select to keel_export using (true);
drop policy if exists rule_renames_export on public.rule_renames;
create policy rule_renames_export on public.rule_renames
  for select to keel_export using (true);

-- Verbatim from 20260713050000_budgets.sql.
drop policy if exists budgets_member_read on public.budgets;
create policy budgets_member_read on public.budgets
  for select to authenticated
  using (exists (
    select 1 from public.household_memberships m
    where m.household_id = budgets.household_id and m.user_id = auth.uid()
  ));
grant select on public.budgets to authenticated;
grant select on public.budgets to keel_export;
drop policy if exists budgets_export on public.budgets;
create policy budgets_export on public.budgets
  for select to keel_export using (true);

-- 3 ---------------------------------------------------------------------------
-- keel_export_household_pre_approval_tokens: verbatim from 20260719120100_schedule_semimonthly.sql, where it was created as keel_export_household.
create or replace function public.keel_export_household_pre_approval_tokens(
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

-- keel_export_household_pre_schedule_anchor2: verbatim from 20260719090000_recurring_paycheck_classification.sql, where it was created as keel_export_household.
create or replace function public.keel_export_household_pre_schedule_anchor2(p_household_id uuid, p_as_of timestamptz default null)
returns jsonb language plpgsql security definer stable set search_path = pg_catalog, public as $$
declare v_base jsonb; v_tables jsonb; begin
  v_base := public.keel_export_household_pre_paycheck_dismissals(p_household_id, p_as_of);
  select jsonb_build_object(
    'detected_paycheck_dismissals',
    coalesce((select jsonb_agg(to_jsonb(x) order by x.household_id, x.id)
      from public.detected_paycheck_dismissals x where x.household_id = p_household_id),'[]'::jsonb)
  ) into v_tables;
  return jsonb_set(v_base, '{tables}', v_base->'tables' || v_tables);
end$$;

-- keel_export_household_pre_paycheck_split_templates: verbatim from 20260720270000_statement_holdings_apply.sql, where it was created as keel_export_household.
create or replace function public.keel_export_household_pre_paycheck_split_templates(
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
  v_base := public.keel_export_household_pre_statement_holding_applications(p_household_id, p_as_of);

  select jsonb_build_object(
    'statement_holding_applications', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', a.id, 'household_id', a.household_id,
        'statement_id', a.statement_id, 'extraction_id', a.extraction_id,
        'account_id', a.account_id, 'applied_by', a.applied_by,
        'approval_token_id', a.approval_token_id, 'period_end', a.period_end,
        'revoked_by', a.revoked_by,
        'revoked_at', case when a.revoked_at is null then null else to_char(a.revoked_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end,
        'created_at', to_char(a.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
      ) order by a.id)
      from public.statement_holding_applications a where a.household_id = p_household_id), '[]'::jsonb)
  ) into v_tables;

  return jsonb_set(v_base, '{tables}', (v_base->'tables') || v_tables);
end;
$$;
