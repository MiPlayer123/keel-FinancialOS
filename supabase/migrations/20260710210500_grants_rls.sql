-- Privilege model + RLS. INFRA.md §6, §17 rules 1-2, 8-9; TASK-000 tests 5/6.
--
-- Layers of defense:
--   1. Grants: authenticated/anon hold ZERO DML on canonical tables.
--   2. RLS: row policies scope reads to household membership; no write
--      policies exist for authenticated at all.
--   3. Append-only triggers (earlier migrations) backstop even definer bugs.
--   4. The authz compiler (packages/authz) gates every command in TS before
--      SQL is reached; the command procs re-check membership in-database.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Revoke the Supabase default broad grants from client roles on our tables.
-- ---------------------------------------------------------------------------
revoke all on all tables in schema public from anon, authenticated;

-- Presentation reads for signed-in users (rows still filtered by RLS below).
grant select on
  households, household_memberships, entities, entity_memberships,
  connections, accounts, account_owners, ledger_accounts,
  resource_permissions, approval_policies,
  canonical_transactions, transaction_source_links,
  journal_batches, journal_postings, journal_revisions, period_locks,
  audit_log, domain_events
to authenticated;

-- keel_api: the definer role behind user-facing command procs. Append-only
-- tables get INSERT+SELECT only; UPDATE is column-scoped where a state
-- machine legitimately advances.
grant usage on schema public to keel_api, keel_worker, keel_readonly;

grant select, insert on
  households, household_memberships, entities, entity_memberships,
  connections, accounts, account_owners, ledger_accounts,
  resource_permissions, approval_policies,
  raw_provider_events, normalized_source_records,
  import_batches, import_rows,
  canonical_transactions, transaction_source_links,
  journal_batches, journal_postings, journal_revisions, period_locks,
  audit_log, domain_events, command_executions
to keel_api;

grant update (status, voided_at) on canonical_transactions to keel_api;
grant update (reopened_at, reopen_reason) on period_locks to keel_api;
grant update (status) on connections to keel_api;
grant select, insert, update on sync_checkpoints to keel_api;

-- keel_worker: queue consumers; same append-only posture.
grant select, insert on
  raw_provider_events, normalized_source_records,
  canonical_transactions, transaction_source_links,
  journal_batches, journal_postings, journal_revisions,
  audit_log, domain_events, command_executions
to keel_worker;
grant select on
  households, household_memberships, entities, accounts, ledger_accounts, connections
to keel_worker;
grant update (status, voided_at) on canonical_transactions to keel_worker;
grant select, insert, update on sync_checkpoints to keel_worker;

grant select on all tables in schema public to keel_readonly;

-- Queue access for definer roles only — clients never touch pgmq.
grant usage on schema pgmq to keel_api, keel_worker;
grant select, insert, update, delete on all tables in schema pgmq to keel_api, keel_worker;
grant execute on all functions in schema pgmq to keel_api, keel_worker;

-- keel_enqueue is internal plumbing.
revoke all on function keel_enqueue(text, jsonb) from public, anon, authenticated;
grant execute on function keel_enqueue(text, jsonb) to keel_api, keel_worker;

-- ---------------------------------------------------------------------------
-- RLS. Membership helper runs as definer so policies can consult memberships
-- without recursive policy evaluation.
-- ---------------------------------------------------------------------------
create function keel_is_household_member(p_household_id uuid) returns boolean
language sql
security definer
set search_path = public
stable as $$
  select exists (
    select 1 from household_memberships m
     where m.household_id = p_household_id
       and m.user_id = (select auth.uid())
  );
$$;

grant execute on function keel_is_household_member(uuid) to authenticated, keel_api, keel_worker;

do $$
declare
  t text;
begin
  foreach t in array array[
    'households', 'household_memberships', 'entities', 'entity_memberships',
    'connections', 'accounts', 'account_owners', 'ledger_accounts',
    'resource_permissions', 'approval_policies',
    'raw_provider_events', 'normalized_source_records', 'sync_checkpoints',
    'import_batches', 'import_rows',
    'canonical_transactions', 'transaction_source_links',
    'journal_batches', 'journal_postings', 'journal_revisions', 'period_locks',
    'audit_log', 'domain_events', 'command_executions'
  ] loop
    execute format('alter table %I enable row level security', t);
  end loop;
end
$$;

-- Read policies for authenticated: household scope only. No write policies
-- for authenticated exist anywhere (test 6 fails closed at both layers).
create policy households_member_read on households
  for select to authenticated
  using (keel_is_household_member(id));

create policy household_memberships_self_read on household_memberships
  for select to authenticated
  using (user_id = (select auth.uid()) or keel_is_household_member(household_id));

create policy entities_member_read on entities
  for select to authenticated using (keel_is_household_member(household_id));
create policy entity_memberships_member_read on entity_memberships
  for select to authenticated
  using (exists (
    select 1 from entities e
     where e.id = entity_id and keel_is_household_member(e.household_id)
  ));
create policy connections_member_read on connections
  for select to authenticated using (keel_is_household_member(household_id));
create policy accounts_member_read on accounts
  for select to authenticated using (keel_is_household_member(household_id));
create policy account_owners_member_read on account_owners
  for select to authenticated
  using (exists (
    select 1 from accounts a
     where a.id = account_id and keel_is_household_member(a.household_id)
  ));
create policy ledger_accounts_member_read on ledger_accounts
  for select to authenticated using (keel_is_household_member(household_id));
create policy resource_permissions_member_read on resource_permissions
  for select to authenticated using (keel_is_household_member(household_id));
create policy approval_policies_member_read on approval_policies
  for select to authenticated using (keel_is_household_member(household_id));
create policy canonical_transactions_member_read on canonical_transactions
  for select to authenticated using (keel_is_household_member(household_id));
create policy transaction_source_links_member_read on transaction_source_links
  for select to authenticated
  using (exists (
    select 1 from canonical_transactions ct
     where ct.id = canonical_transaction_id
       and keel_is_household_member(ct.household_id)
  ));
create policy journal_batches_member_read on journal_batches
  for select to authenticated using (keel_is_household_member(household_id));
create policy journal_postings_member_read on journal_postings
  for select to authenticated
  using (exists (
    select 1 from journal_batches b
     where b.id = batch_id and keel_is_household_member(b.household_id)
  ));
create policy journal_revisions_member_read on journal_revisions
  for select to authenticated
  using (exists (
    select 1 from journal_batches b
     where b.id = original_batch_id and keel_is_household_member(b.household_id)
  ));
create policy period_locks_member_read on period_locks
  for select to authenticated using (keel_is_household_member(household_id));
create policy audit_log_member_read on audit_log
  for select to authenticated using (keel_is_household_member(household_id));
create policy domain_events_member_read on domain_events
  for select to authenticated using (keel_is_household_member(household_id));

-- Raw source evidence and import staging are server-side surfaces in Stage
-- 1A: no authenticated read policies yet (deliberate: BC-v2.1 raw bodies may
-- embed PII that presentation surfaces must not leak wholesale).

-- Definer-role policies: RLS applies to keel_api/keel_worker too (they own no
-- tables); their access is deliberately whole-table because authorization is
-- enforced by the command procs + authz compiler above this layer.
do $$
declare
  t text;
begin
  foreach t in array array[
    'households', 'household_memberships', 'entities', 'entity_memberships',
    'connections', 'accounts', 'account_owners', 'ledger_accounts',
    'resource_permissions', 'approval_policies',
    'raw_provider_events', 'normalized_source_records', 'sync_checkpoints',
    'import_batches', 'import_rows',
    'canonical_transactions', 'transaction_source_links',
    'journal_batches', 'journal_postings', 'journal_revisions', 'period_locks',
    'audit_log', 'domain_events', 'command_executions'
  ] loop
    execute format(
      'create policy %I on %I for all to keel_api, keel_worker using (true) with check (true)',
      t || '_definer_all', t
    );
  end loop;
end
$$;
