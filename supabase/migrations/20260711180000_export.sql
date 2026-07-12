-- Stage 1D CORE export: Law 6 portability with Law 9 scope and Law 12 ACLs.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'keel_export') then
    create role keel_export nologin nosuperuser nobypassrls;
  end if;
end;
$$;

grant keel_export to postgres;
grant usage on schema public to keel_export;

-- This is the complete table privilege boundary. In particular, the role has
-- no privilege on connection_credentials or any other EXCLUDE decision.
grant select on
  public.households,
  public.entities,
  public.household_memberships,
  public.entity_memberships,
  public.accounts,
  public.account_owners,
  public.ledger_accounts,
  public.connections,
  public.resource_permissions,
  public.approval_policies,
  public.canonical_transactions,
  public.journal_batches,
  public.journal_postings,
  public.journal_revisions,
  public.period_locks,
  public.transaction_source_links,
  public.transfer_links,
  public.raw_provider_events,
  public.normalized_source_records,
  public.import_batches,
  public.import_rows,
  public.ingestion_skips,
  public.account_lineage,
  public.balance_snapshots,
  public.connection_health_events,
  public.audit_log,
  public.domain_events,
  public.command_executions
to keel_export;

revoke all on
  public.connection_credentials,
  public.plaid_webhook_keys,
  public.webhook_rejections,
  public.webhook_rejection_counters,
  public.provider_call_budget,
  public.usage_events,
  public.plaid_test_responses,
  public.plaid_webhook_key_test_responses,
  public.sync_test_pages,
  public.sync_attempts,
  public.sync_checkpoints,
  public.link_attempts,
  public.removal_attempts
from keel_export;

-- keel_export does not bypass RLS. These policies permit its definer function
-- to read only the tables granted above; explicit household predicates in the
-- function remain the tenant boundary.
do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'households','entities','household_memberships','entity_memberships',
    'accounts','account_owners','ledger_accounts','connections',
    'resource_permissions','approval_policies','canonical_transactions',
    'journal_batches','journal_postings','journal_revisions','period_locks',
    'transaction_source_links','transfer_links','raw_provider_events',
    'normalized_source_records','import_batches','import_rows','ingestion_skips',
    'account_lineage','balance_snapshots','connection_health_events','audit_log',
    'domain_events','command_executions'
  ] loop
    execute format(
      'create policy keel_export_select on public.%I for select to keel_export using (true)',
      table_name
    );
  end loop;
end;
$$;

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
  v_as_of timestamptz := coalesce(p_as_of, statement_timestamp());
  v_export jsonb;
begin
  if not exists (select 1 from public.households where id = p_household_id) then
    raise exception 'KEEL_SCOPE_VIOLATION' using errcode = 'P0006';
  end if;

  -- One statement supplies the envelope, trial balance, and every table array
  -- under one PostgreSQL statement snapshot.
  select jsonb_build_object(
    'asOf', to_char(v_as_of at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'householdId', p_household_id,
    'trialBalance', (
      select coalesce(jsonb_agg(row.dto order by row.ledger_account_id, row.currency), '[]'::jsonb)
      from (
        select posting.ledger_account_id, posting.currency,
          jsonb_build_object(
            'ledgerAccountId', posting.ledger_account_id,
            'currency', posting.currency::text,
            'balanceMinor', sum(posting.amount_minor)::text
          ) as dto
        from public.journal_postings posting
        join public.journal_batches batch on batch.id = posting.batch_id
        where batch.household_id = p_household_id
        group by posting.ledger_account_id, posting.currency
      ) row
    ),
    'tables', jsonb_build_object(
    'households', (
      select coalesce(jsonb_agg(row.dto order by row.id), '[]'::jsonb)
      from (
        select h.id,
          jsonb_build_object(
            'id', h.id,
            'name', h.name,
            'created_at', to_char(h.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
          ) as dto
        from public.households h
        where h.id = p_household_id
      ) row
    ),
    'entities', (
      select coalesce(jsonb_agg(row.dto order by row.id), '[]'::jsonb)
      from (
        select e.id,
          jsonb_build_object(
            'id', e.id,
            'household_id', e.household_id,
            'name', e.name,
            'kind', e.kind,
            'created_at', to_char(e.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
            'archived_at', case when e.archived_at is null then null else to_char(e.archived_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end
          ) as dto
        from public.entities e
        where e.household_id = p_household_id
      ) row
    ),
    'household_memberships', (
      select coalesce(jsonb_agg(row.dto order by row.household_id, row.user_id), '[]'::jsonb)
      from (
        select m.household_id, m.user_id,
          jsonb_build_object(
            'household_id', m.household_id,
            'user_id', m.user_id,
            'role', m.role,
            'created_at', to_char(m.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
          ) as dto
        from public.household_memberships m
        where m.household_id = p_household_id
      ) row
    ),
    'entity_memberships', (
      select coalesce(jsonb_agg(row.dto order by row.entity_id, row.user_id), '[]'::jsonb)
      from (
        select membership.entity_id, membership.user_id,
          jsonb_build_object(
            'entity_id', membership.entity_id,
            'user_id', membership.user_id,
            'created_at', to_char(membership.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
          ) as dto
        from public.entity_memberships membership
        join public.entities entity on entity.id = membership.entity_id
        where entity.household_id = p_household_id
      ) row
    ),
    'accounts', (
      select coalesce(jsonb_agg(row.dto order by row.id), '[]'::jsonb)
      from (
        select a.id,
          jsonb_build_object(
            'id', a.id,
            'household_id', a.household_id,
            'entity_id', a.entity_id,
            'connection_id', a.connection_id,
            'ledger_account_id', a.ledger_account_id,
            'name', a.name,
            'subtype', a.subtype,
            'currency', a.currency::text,
            'external_ref', a.external_ref,
            'created_at', to_char(a.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
            'archived_at', case when a.archived_at is null then null else to_char(a.archived_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end
          ) as dto
        from public.accounts a
        where a.household_id = p_household_id
      ) row
    ),
    'account_owners', (
      select coalesce(jsonb_agg(row.dto order by row.account_id, row.user_id), '[]'::jsonb)
      from (
        select owner.account_id, owner.user_id,
          jsonb_build_object(
            'account_id', owner.account_id,
            'user_id', owner.user_id,
            'created_at', to_char(owner.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
          ) as dto
        from public.account_owners owner
        join public.accounts account on account.id = owner.account_id
        where account.household_id = p_household_id
      ) row
    ),
    'ledger_accounts', (
      select coalesce(jsonb_agg(row.dto order by row.id), '[]'::jsonb)
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
            'archived_at', case when account.archived_at is null then null else to_char(account.archived_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end
          ) as dto
        from public.ledger_accounts account
        where account.household_id = p_household_id
      ) row
    ),
    'connections', (
      select coalesce(jsonb_agg(row.dto order by row.id), '[]'::jsonb)
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
            'next_sync_eligible_at', case when connection.next_sync_eligible_at is null then null else to_char(connection.next_sync_eligible_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end
          ) as dto
        from public.connections connection
        where connection.household_id = p_household_id
      ) row
    ),
    'resource_permissions', (
      select coalesce(jsonb_agg(row.dto order by row.id), '[]'::jsonb)
      from (
        select permission.id,
          jsonb_build_object(
            'id', permission.id,
            'household_id', permission.household_id,
            'user_id', permission.user_id,
            'resource_kind', permission.resource_kind,
            'resource_id', permission.resource_id,
            'permission', permission.permission,
            'created_at', to_char(permission.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
          ) as dto
        from public.resource_permissions permission
        where permission.household_id = p_household_id
      ) row
    ),
    'approval_policies', (
      select coalesce(jsonb_agg(row.dto order by row.id), '[]'::jsonb)
      from (
        select policy.id,
          jsonb_build_object(
            'id', policy.id,
            'household_id', policy.household_id,
            'risk_class', policy.risk_class,
            'autonomy', policy.autonomy,
            'created_at', to_char(policy.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
          ) as dto
        from public.approval_policies policy
        where policy.household_id = p_household_id
      ) row
    ),
    'canonical_transactions', (
      select coalesce(jsonb_agg(row.dto order by row.id), '[]'::jsonb)
      from (
        select transaction.id,
          jsonb_build_object(
            'id', transaction.id,
            'household_id', transaction.household_id,
            'entity_id', transaction.entity_id,
            'account_id', transaction.account_id,
            'status', transaction.status,
            'source', transaction.source,
            'description', transaction.description,
            'effective_date', to_char(transaction.effective_date, 'YYYY-MM-DD'),
            'economic_event_key', transaction.economic_event_key,
            'created_at', to_char(transaction.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
            'voided_at', case when transaction.voided_at is null then null else to_char(transaction.voided_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end
          ) as dto
        from public.canonical_transactions transaction
        where transaction.household_id = p_household_id
      ) row
    ),
    'journal_batches', (
      select coalesce(jsonb_agg(row.dto order by row.id), '[]'::jsonb)
      from (
        select batch.id,
          jsonb_build_object(
            'id', batch.id,
            'household_id', batch.household_id,
            'canonical_transaction_id', batch.canonical_transaction_id,
            'description', batch.description,
            'effective_date', to_char(batch.effective_date, 'YYYY-MM-DD'),
            'reverses_batch_id', batch.reverses_batch_id,
            'command_id', batch.command_id,
            'posted_at', to_char(batch.posted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
          ) as dto
        from public.journal_batches batch
        where batch.household_id = p_household_id
      ) row
    ),
    'journal_postings', (
      select coalesce(jsonb_agg(row.dto order by row.id), '[]'::jsonb)
      from (
        select posting.id,
          jsonb_build_object(
            'id', posting.id,
            'batch_id', posting.batch_id,
            'ledger_account_id', posting.ledger_account_id,
            'entity_id', posting.entity_id,
            'amount_minor', posting.amount_minor::text,
            'currency', posting.currency::text
          ) as dto
        from public.journal_postings posting
        join public.journal_batches batch on batch.id = posting.batch_id
        where batch.household_id = p_household_id
      ) row
    ),
    'journal_revisions', (
      select coalesce(jsonb_agg(row.dto order by row.id), '[]'::jsonb)
      from (
        select revision.id,
          jsonb_build_object(
            'id', revision.id,
            'original_batch_id', revision.original_batch_id,
            'reversal_batch_id', revision.reversal_batch_id,
            'replacement_batch_id', revision.replacement_batch_id,
            'reason', revision.reason,
            'created_at', to_char(revision.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
          ) as dto
        from public.journal_revisions revision
        join public.journal_batches original on original.id = revision.original_batch_id
        join public.journal_batches reversal on reversal.id = revision.reversal_batch_id
        left join public.journal_batches replacement on replacement.id = revision.replacement_batch_id
        where original.household_id = p_household_id
          and reversal.household_id = p_household_id
          and (replacement.id is null or replacement.household_id = p_household_id)
      ) row
    ),
    'period_locks', (
      select coalesce(jsonb_agg(row.dto order by row.id), '[]'::jsonb)
      from (
        select lock.id,
          jsonb_build_object(
            'id', lock.id,
            'household_id', lock.household_id,
            'entity_id', lock.entity_id,
            'start_date', to_char(lock.start_date, 'YYYY-MM-DD'),
            'end_date', to_char(lock.end_date, 'YYYY-MM-DD'),
            'locked_by', lock.locked_by,
            'locked_at', to_char(lock.locked_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
            'reopened_at', case when lock.reopened_at is null then null else to_char(lock.reopened_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end,
            'reopen_reason', lock.reopen_reason
          ) as dto
        from public.period_locks lock
        where lock.household_id = p_household_id
      ) row
    ),
    'transaction_source_links', (
      select coalesce(jsonb_agg(row.dto order by row.canonical_transaction_id, row.normalized_source_record_id), '[]'::jsonb)
      from (
        select link.canonical_transaction_id, link.normalized_source_record_id,
          jsonb_build_object(
            'canonical_transaction_id', link.canonical_transaction_id,
            'normalized_source_record_id', link.normalized_source_record_id,
            'created_at', to_char(link.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
            'household_id', link.household_id
          ) as dto
        from public.transaction_source_links link
        join public.canonical_transactions transaction
          on transaction.id = link.canonical_transaction_id
         and transaction.household_id = link.household_id
        join public.normalized_source_records source
          on source.id = link.normalized_source_record_id
         and source.household_id = link.household_id
        where link.household_id = p_household_id
      ) row
    ),
    'transfer_links', (
      select coalesce(jsonb_agg(row.dto order by row.id), '[]'::jsonb)
      from (
        select link.id,
          jsonb_build_object(
            'id', link.id,
            'household_id', link.household_id,
            'txn_out', link.txn_out,
            'txn_in', link.txn_in,
            'status', link.status,
            'decided_by', link.decided_by,
            'decided_at', case when link.decided_at is null then null else to_char(link.decided_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end,
            'created_at', to_char(link.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
          ) as dto
        from public.transfer_links link
        join public.canonical_transactions outgoing
          on outgoing.id = link.txn_out and outgoing.household_id = link.household_id
        join public.canonical_transactions incoming
          on incoming.id = link.txn_in and incoming.household_id = link.household_id
        where link.household_id = p_household_id
      ) row
    ),
    'raw_provider_events', (
      select coalesce(jsonb_agg(row.dto order by row.id), '[]'::jsonb)
      from (
        select event.id,
          jsonb_build_object(
            'id', event.id,
            'household_id', event.household_id,
            'connection_id', event.connection_id,
            'provider', event.provider,
            'provider_event_id', event.provider_event_id,
            'account_external_ref', event.account_external_ref,
            'received_at', to_char(event.received_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
            'recorded_at', to_char(event.recorded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
            'body_text', event.body_text,
            'body_sha256', event.body_sha256
          ) as dto
        from public.raw_provider_events event
        join public.connections connection
          on connection.id = event.connection_id
         and connection.household_id = event.household_id
        where event.household_id = p_household_id
      ) row
    ),
    'normalized_source_records', (
      select coalesce(jsonb_agg(row.dto order by row.id), '[]'::jsonb)
      from (
        select source.id,
          jsonb_build_object(
            'id', source.id,
            'raw_event_id', source.raw_event_id,
            'household_id', source.household_id,
            'account_id', source.account_id,
            'provider_transaction_id', source.provider_transaction_id,
            'amount_minor', case when source.amount_minor is null then null else source.amount_minor::text end,
            'currency', source.currency::text,
            'effective_date', case when source.effective_date is null then null else to_char(source.effective_date, 'YYYY-MM-DD') end,
            'description', source.description,
            'pending', source.pending,
            'pending_transaction_ref', source.pending_transaction_ref,
            'created_at', to_char(source.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
            'kind', source.kind
          ) as dto
        from public.normalized_source_records source
        join public.raw_provider_events event
          on event.id = source.raw_event_id
         and event.household_id = source.household_id
        left join public.accounts account
          on account.id = source.account_id
         and account.household_id = source.household_id
        where source.household_id = p_household_id
          and (source.account_id is null or account.id is not null)
      ) row
    ),
    'import_batches', (
      select coalesce(jsonb_agg(row.dto order by row.id), '[]'::jsonb)
      from (
        select batch.id,
          jsonb_build_object(
            'id', batch.id,
            'household_id', batch.household_id,
            'account_id', batch.account_id,
            'source_kind', batch.source_kind,
            'filename', batch.filename,
            'row_count', batch.row_count,
            'created_at', to_char(batch.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
            'committed_at', case when batch.committed_at is null then null else to_char(batch.committed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end,
            'rolled_back_at', case when batch.rolled_back_at is null then null else to_char(batch.rolled_back_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end
          ) as dto
        from public.import_batches batch
        left join public.accounts account
          on account.id = batch.account_id
         and account.household_id = batch.household_id
        where batch.household_id = p_household_id
          and (batch.account_id is null or account.id is not null)
      ) row
    ),
    'import_rows', (
      select coalesce(jsonb_agg(row.dto order by row.import_batch_id, row.row_number, row.id), '[]'::jsonb)
      from (
        select import_row.id, import_row.import_batch_id, import_row.row_number,
          jsonb_build_object(
            'id', import_row.id,
            'import_batch_id', import_row.import_batch_id,
            'row_number', import_row.row_number,
            'raw', import_row.raw,
            'created_at', to_char(import_row.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
          ) as dto
        from public.import_rows import_row
        join public.import_batches batch on batch.id = import_row.import_batch_id
        where batch.household_id = p_household_id
      ) row
    ),
    'ingestion_skips', (
      select coalesce(jsonb_agg(row.dto order by row.id), '[]'::jsonb)
      from (
        select skip.id,
          jsonb_build_object(
            'id', skip.id,
            'household_id', skip.household_id,
            'connection_id', skip.connection_id,
            'raw_event_id', skip.raw_event_id,
            'provider_transaction_id', skip.provider_transaction_id,
            'currency', skip.currency,
            'reason', skip.reason,
            'created_at', to_char(skip.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
          ) as dto
        from public.ingestion_skips skip
        join public.connections connection
          on connection.id = skip.connection_id
         and connection.household_id = skip.household_id
        join public.raw_provider_events event
          on event.id = skip.raw_event_id
         and event.household_id = skip.household_id
        where skip.household_id = p_household_id
      ) row
    ),
    'account_lineage', (
      select coalesce(jsonb_agg(row.dto order by row.id), '[]'::jsonb)
      from (
        select lineage.id,
          jsonb_build_object(
            'id', lineage.id,
            'household_id', lineage.household_id,
            'account_id', lineage.account_id,
            'event_type', lineage.event_type,
            'previous_state', lineage.previous_state,
            'new_state', lineage.new_state,
            'occurred_at', to_char(lineage.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
          ) as dto
        from public.account_lineage lineage
        join public.accounts account
          on account.id = lineage.account_id
         and account.household_id = lineage.household_id
        where lineage.household_id = p_household_id
      ) row
    ),
    'balance_snapshots', (
      select coalesce(jsonb_agg(row.dto order by row.id), '[]'::jsonb)
      from (
        select snapshot.id,
          jsonb_build_object(
            'id', snapshot.id,
            'household_id', snapshot.household_id,
            'account_id', snapshot.account_id,
            'as_of', to_char(snapshot.as_of at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
            'available_minor', case when snapshot.available_minor is null then null else snapshot.available_minor::text end,
            'current_minor', snapshot.current_minor::text,
            'currency', snapshot.currency,
            'source', snapshot.source,
            'snapshot_metadata', snapshot.snapshot_metadata,
            'created_at', to_char(snapshot.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
          ) as dto
        from public.balance_snapshots snapshot
        join public.accounts account
          on account.id = snapshot.account_id
         and account.household_id = snapshot.household_id
        where snapshot.household_id = p_household_id
      ) row
    ),
    'connection_health_events', (
      select coalesce(jsonb_agg(row.dto order by row.id), '[]'::jsonb)
      from (
        select event.id,
          jsonb_build_object(
            'id', event.id,
            'household_id', event.household_id,
            'connection_id', event.connection_id,
            'event_type', event.event_type,
            'severity', event.severity,
            'details', event.details,
            'occurred_at', to_char(event.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
          ) as dto
        from public.connection_health_events event
        join public.connections connection
          on connection.id = event.connection_id
         and connection.household_id = event.household_id
        where event.household_id = p_household_id
      ) row
    ),
    'audit_log', (
      select coalesce(jsonb_agg(row.dto order by row.id), '[]'::jsonb)
      from (
        select audit.id,
          jsonb_build_object(
            'id', audit.id::text,
            'household_id', audit.household_id,
            'actor', audit.actor,
            'action', audit.action,
            'object_type', audit.object_type,
            'object_id', audit.object_id,
            'command_id', audit.command_id,
            'before', audit.before,
            'after', audit.after,
            'at', to_char(audit.at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
          ) as dto
        from public.audit_log audit
        where audit.household_id = p_household_id
      ) row
    ),
    'domain_events', (
      select coalesce(jsonb_agg(row.dto order by row.id), '[]'::jsonb)
      from (
        select event.id,
          jsonb_build_object(
            'id', event.id,
            'event_type', event.event_type,
            'household_id', event.household_id,
            'command_id', event.command_id,
            'economic_event_key', event.economic_event_key,
            'actor', event.actor,
            'occurred_at', to_char(event.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
            'payload', event.payload
          ) as dto
        from public.domain_events event
        where event.household_id = p_household_id
      ) row
    ),
    'command_executions', (
      select coalesce(jsonb_agg(row.dto order by row.household_id, row.economic_event_key), '[]'::jsonb)
      from (
        select execution.household_id, execution.economic_event_key,
          jsonb_build_object(
            'household_id', execution.household_id,
            'economic_event_key', execution.economic_event_key,
            'command', execution.command,
            'payload_sha256', execution.payload_sha256,
            'result', execution.result,
            'executed_at', to_char(execution.executed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
          ) as dto
        from public.command_executions execution
        where execution.household_id = p_household_id
      ) row
    )
  )) into v_export;

  return v_export;
end;
$$;

revoke all on function public.keel_export_household(uuid, timestamptz)
  from public, anon, authenticated, service_role;

grant create on schema public to keel_export;
alter function public.keel_export_household(uuid, timestamptz) owner to keel_export;
revoke create on schema public from keel_export;

grant execute on function public.keel_export_household(uuid, timestamptz) to service_role;
