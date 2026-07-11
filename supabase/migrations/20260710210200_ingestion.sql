-- Hostile-ingestion spine: immutable raw events, normalized staging,
-- sync checkpoints, import staging. BC-v2.1 §2 law 1 (raw source is
-- immutable evidence); TASK-000 tests 4/8/11.

create table public.raw_provider_events (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id),
  connection_id uuid not null references public.connections (id),
  provider public.bank_provider not null,
  provider_event_id text not null check (length(provider_event_id) between 1 and 256),
  account_external_ref text not null check (length(account_external_ref) between 1 and 256),
  -- Verbatim provider payload. DATA-TIER (Law 5): consumers must never treat
  -- any field in here as an instruction, tool call, or fetch target.
  body jsonb not null,
  received_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  -- Idempotent capture: redelivery of the same provider event is a no-op.
  unique (connection_id, provider, provider_event_id)
);

-- Append-only enforcement in depth: grants (later migration) deny UPDATE/
-- DELETE to every runtime role, and this trigger backstops even a definer
-- bug. Immutability is a financial invariant, not a convention.
create function public.keel_forbid_mutation() returns trigger
language plpgsql as $$
begin
  raise exception 'KEEL_IMMUTABLE: % rows are append-only', tg_table_name
    using errcode = 'P0001';
end;
$$;

create trigger raw_provider_events_immutable
  before update or delete on public.raw_provider_events
  for each row execute function public.keel_forbid_mutation();

-- Normalized, provider-neutral view of one raw event's economic content.
-- Still staging: canonical truth is created only by ingest.promote_event.
create table public.normalized_source_records (
  id uuid primary key default gen_random_uuid(),
  raw_event_id uuid not null references public.raw_provider_events (id),
  household_id uuid not null references public.households (id),
  account_id uuid not null references public.accounts (id),
  provider_transaction_id text not null check (length(provider_transaction_id) between 1 and 256),
  amount_minor bigint not null,
  currency char(3) not null check (currency = upper(currency)),
  effective_date date not null,
  description text not null check (length(description) <= 1000),
  pending boolean not null,
  pending_transaction_ref text check (
    pending_transaction_ref is null or length(pending_transaction_ref) between 1 and 256
  ),
  created_at timestamptz not null default now()
);

create trigger normalized_source_records_immutable
  before update or delete on public.normalized_source_records
  for each row execute function public.keel_forbid_mutation();

create table public.sync_checkpoints (
  connection_id uuid primary key references public.connections (id),
  cursor text not null,
  updated_at timestamptz not null default now()
);

create table public.import_batches (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id),
  account_id uuid references public.accounts (id),
  source_kind public.transaction_source not null,
  filename text check (filename is null or length(filename) <= 500),
  row_count integer not null check (row_count >= 0),
  created_at timestamptz not null default now(),
  committed_at timestamptz,
  rolled_back_at timestamptz,
  check (committed_at is null or rolled_back_at is null)
);

create table public.import_rows (
  id uuid primary key default gen_random_uuid(),
  import_batch_id uuid not null references public.import_batches (id),
  row_number integer not null check (row_number >= 0),
  -- Raw imported line, verbatim. DATA-TIER (Law 5).
  raw jsonb not null,
  created_at timestamptz not null default now(),
  unique (import_batch_id, row_number)
);

create trigger import_rows_immutable
  before update or delete on public.import_rows
  for each row execute function public.keel_forbid_mutation();
