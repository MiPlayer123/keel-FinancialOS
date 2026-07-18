-- Third-round codex finding on PR #60: adding sync_continuation_pending /
-- sync_continuation_marked_at broke the export coverage check
-- (supabase/tests/008_export.sql:169-177, "every included-table column is
-- explicitly allowed or explicitly omitted") and, more importantly per Law 6
-- (full export always works), the household export DTO for connections
-- (keel_export_household_pre_tags -- the layer in the wrapper chain that
-- last touches 'tables.connections', confirmed live via pg_proc.prosrc since
-- the export function is built as a chain of create-or-replace layers, one
-- per feature migration) still built its jsonb_build_object without the two
-- new columns, so exports would silently omit this sync state.
create or replace function public.keel_export_household_pre_tags(
  p_household_id uuid,
  p_as_of timestamptz default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_base jsonb;
  v_ledger_accounts jsonb;
  v_connections jsonb;
begin
  v_base := public.keel_export_household_pre_subcategories(p_household_id, p_as_of);
  select coalesce(jsonb_agg(row.dto order by row.id), '[]'::jsonb)
    into v_ledger_accounts
    from (
      select account.id,
        jsonb_build_object(
          'id', account.id,
          'household_id', account.household_id,
          'entity_id', account.entity_id,
          'name', account.name,
          'kind', account.kind,
          'currency', account.currency::text,
          'is_category', account.is_category,
          'created_at', to_char(account.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
          'archived_at', case when account.archived_at is null then null else to_char(account.archived_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end,
          'pfc_key', account.pfc_key,
          'is_system', account.is_system,
          'parent_ledger_account_id', account.parent_ledger_account_id
        ) as dto
      from public.ledger_accounts account
      where account.household_id = p_household_id
    ) row;
  select coalesce(jsonb_agg(row.dto order by row.id), '[]'::jsonb)
    into v_connections
    from (
      select connection.id,
        jsonb_build_object(
          'id', connection.id,
          'household_id', connection.household_id,
          'provider', connection.provider,
          'external_ref', connection.external_ref,
          'status', connection.status,
          'created_at', to_char(connection.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
          'institution_id', connection.institution_id,
          'consent_expires_at', case when connection.consent_expires_at is null then null else to_char(connection.consent_expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end,
          'last_successful_sync_at', case when connection.last_successful_sync_at is null then null else to_char(connection.last_successful_sync_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end,
          'sync_lease_owner', connection.sync_lease_owner,
          'sync_leased_until', case when connection.sync_leased_until is null then null else to_char(connection.sync_leased_until at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end,
          'sync_desired_generation', connection.sync_desired_generation,
          'sync_committed_generation', connection.sync_committed_generation,
          'next_sync_eligible_at', case when connection.next_sync_eligible_at is null then null else to_char(connection.next_sync_eligible_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end,
          'display_name', connection.display_name,
          'sync_continuation_pending', connection.sync_continuation_pending,
          'sync_continuation_marked_at', case when connection.sync_continuation_marked_at is null then null else to_char(connection.sync_continuation_marked_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end
        ) as dto
      from public.connections connection
      where connection.household_id = p_household_id
    ) row;
  v_base := jsonb_set(v_base, '{tables,ledger_accounts}', v_ledger_accounts);
  return jsonb_set(v_base, '{tables,connections}', v_connections);
end;
$$;
