-- Hot-path indexes for the ledger read model and balance lookups.
create index if not exists journal_batches_canonical
  on public.journal_batches (canonical_transaction_id);
create index if not exists journal_batches_household
  on public.journal_batches (household_id);
create index if not exists balance_snapshots_account_asof
  on public.balance_snapshots (household_id, account_id, as_of desc);
create index if not exists normalized_source_records_provider_txn
  on public.normalized_source_records (provider_transaction_id);
create index if not exists canonical_transactions_household
  on public.canonical_transactions (household_id);
