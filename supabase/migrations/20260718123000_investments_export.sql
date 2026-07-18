-- WS-C / FEEDBACK.md F-013/F-014/F-015 — Investments workstream, part 4 of 4.
--
-- Law 6 (full export always works): every new table/column must appear in the
-- household export. This adds one export layer that:
--   * re-emits `connections` WITH the four new holdings_* error columns (part
--     1) — the base connections DTO is an explicit jsonb_build_object, so new
--     columns are otherwise silently dropped (same pattern the continuation
--     columns already needed, 20260718102500).
--   * adds `holdings` (never exported before — a pre-existing gap from
--     yesterday's holdings work; folded in here so the register export is
--     complete).
--   * adds `holdings_snapshots` (part 1) and `investment_sync_state` (part 2).
--
-- Follows the established chain idiom: rename the current outermost export to a
-- pre_investments layer, then create a new keel_export_household that calls it
-- and merges the new/overridden keys.
--
-- keel_export runs with RLS (does NOT bypass it), so each new table needs a
-- SELECT grant + a keel_export_select policy, exactly like every other
-- exported table.

-- Export access for the new tables (holdings already has member_read but no
-- export path; snapshots + sync_state are new).
grant select on public.holdings, public.holdings_snapshots, public.investment_sync_state
  to keel_export;
create policy keel_export_select on public.holdings
  for select to keel_export using (true);
create policy keel_export_select on public.holdings_snapshots
  for select to keel_export using (true);
create policy keel_export_select on public.investment_sync_state
  for select to keel_export using (true);

alter function public.keel_export_household(uuid, timestamptz)
  rename to keel_export_household_pre_investments;
revoke all on function public.keel_export_household_pre_investments(uuid, timestamptz)
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
  v_connections jsonb;
  v_tables jsonb;
begin
  v_base := public.keel_export_household_pre_investments(p_household_id, p_as_of);

  -- Override connections to include the new holdings_* error columns.
  select coalesce(jsonb_agg(row.dto order by row.id), '[]'::jsonb)
    into v_connections
    from (
      select c.id,
        jsonb_build_object(
          'id', c.id,
          'household_id', c.household_id,
          'provider', c.provider,
          'external_ref', c.external_ref,
          'status', c.status,
          'created_at', to_char(c.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
          'institution_id', c.institution_id,
          'consent_expires_at', case when c.consent_expires_at is null then null else to_char(c.consent_expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end,
          'last_successful_sync_at', case when c.last_successful_sync_at is null then null else to_char(c.last_successful_sync_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end,
          'sync_lease_owner', c.sync_lease_owner,
          'sync_leased_until', case when c.sync_leased_until is null then null else to_char(c.sync_leased_until at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end,
          'sync_desired_generation', c.sync_desired_generation,
          'sync_committed_generation', c.sync_committed_generation,
          'next_sync_eligible_at', case when c.next_sync_eligible_at is null then null else to_char(c.next_sync_eligible_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end,
          'display_name', c.display_name,
          'sync_continuation_pending', c.sync_continuation_pending,
          'sync_continuation_marked_at', case when c.sync_continuation_marked_at is null then null else to_char(c.sync_continuation_marked_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end,
          'holdings_last_error_code', c.holdings_last_error_code,
          'holdings_last_error_message', c.holdings_last_error_message,
          'holdings_last_error_at', case when c.holdings_last_error_at is null then null else to_char(c.holdings_last_error_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end,
          'holdings_last_success_at', case when c.holdings_last_success_at is null then null else to_char(c.holdings_last_success_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end
        ) as dto
      from public.connections c
      where c.household_id = p_household_id
    ) row;

  select jsonb_build_object(
    'holdings', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', h.id,
        'household_id', h.household_id,
        'account_id', h.account_id,
        'as_of', to_char(h.as_of, 'YYYY-MM-DD'),
        'symbol', h.symbol,
        'name', h.name,
        'qty', h.qty::text,
        'price_minor', h.price_minor::text,
        'value_minor', h.value_minor::text,
        'cost_basis_minor', h.cost_basis_minor::text,
        'currency', h.currency,
        'source', h.source,
        'security_type', h.security_type,
        'created_at', to_char(h.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'updated_at', to_char(h.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
      ) order by h.id)
      from public.holdings h where h.household_id = p_household_id), '[]'::jsonb),
    'holdings_snapshots', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', s.id,
        'household_id', s.household_id,
        'account_id', s.account_id,
        'snapshot_date', to_char(s.snapshot_date, 'YYYY-MM-DD'),
        'symbol', s.symbol,
        'name', s.name,
        'qty', s.qty::text,
        'price_minor', s.price_minor::text,
        'value_minor', s.value_minor::text,
        'cost_basis_minor', s.cost_basis_minor::text,
        'currency', s.currency,
        'source', s.source,
        'created_at', to_char(s.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
      ) order by s.id)
      from public.holdings_snapshots s where s.household_id = p_household_id), '[]'::jsonb),
    'investment_sync_state', coalesce((
      select jsonb_agg(jsonb_build_object(
        'connection_id', st.connection_id,
        'household_id', st.household_id,
        'last_pulled_through', case when st.last_pulled_through is null then null else to_char(st.last_pulled_through, 'YYYY-MM-DD') end,
        'window_from', case when st.window_from is null then null else to_char(st.window_from, 'YYYY-MM-DD') end,
        'window_to', case when st.window_to is null then null else to_char(st.window_to, 'YYYY-MM-DD') end,
        'continuation_offset', st.continuation_offset,
        'last_synced_at', case when st.last_synced_at is null then null else to_char(st.last_synced_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end,
        'created_at', to_char(st.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'updated_at', to_char(st.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
      ) order by st.connection_id)
      from public.investment_sync_state st where st.household_id = p_household_id), '[]'::jsonb)
  ) into v_tables;

  v_base := jsonb_set(v_base, '{tables,connections}', v_connections);
  return jsonb_set(v_base, '{tables}', (v_base->'tables') || v_tables);
end;
$$;

revoke all on function public.keel_export_household(uuid, timestamptz)
  from public, anon, authenticated, service_role;
grant create on schema public to keel_export;
alter function public.keel_export_household(uuid, timestamptz) owner to keel_export;
revoke create on schema public from keel_export;
grant execute on function public.keel_export_household(uuid, timestamptz) to service_role;
