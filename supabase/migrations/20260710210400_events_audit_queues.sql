-- Append-only audit + domain events, idempotent command execution registry,
-- pgmq queues, and the atomic enqueue helper. INFRA.md §5 (one transaction),
-- §8 (queues); CLAUDE.md Law 2 (every mutation hits audit_log).

create table public.audit_log (
  id bigint generated always as identity primary key,
  household_id uuid not null references public.households (id),
  actor jsonb not null,
  action text not null check (length(action) between 1 and 200),
  object_type text not null check (length(object_type) between 1 and 100),
  object_id uuid,
  command_id uuid,
  before jsonb,
  after jsonb,
  at timestamptz not null default now()
);

create trigger audit_log_immutable
  before update or delete on public.audit_log
  for each row execute function public.keel_forbid_mutation();

create table public.domain_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null check (length(event_type) between 1 and 200),
  household_id uuid not null references public.households (id),
  command_id uuid not null,
  economic_event_key text not null check (length(economic_event_key) between 8 and 256),
  actor jsonb not null,
  occurred_at timestamptz not null default now(),
  payload jsonb not null
);

create trigger domain_events_immutable
  before update or delete on public.domain_events
  for each row execute function public.keel_forbid_mutation();

-- Idempotency registry (Law 9). Replaying a key with the same payload hash
-- returns the stored result; the same key with a different hash is a hard
-- conflict — an economic event cannot change shape on retry.
-- Scoped per household (Codex audit F7): a client-controlled key must never
-- collide across tenants — a global key would let household B read household
-- A's stored result or squat on its keys.
create table public.command_executions (
  household_id uuid not null references public.households (id),
  economic_event_key text not null check (length(economic_event_key) between 8 and 256),
  command_id uuid not null,
  command text not null check (length(command) between 1 and 200),
  payload_sha256 text not null check (payload_sha256 ~ '^[a-f0-9]{64}$'),
  result jsonb not null,
  executed_at timestamptz not null default now(),
  primary key (household_id, economic_event_key)
);

create trigger command_executions_immutable
  before update or delete on public.command_executions
  for each row execute function public.keel_forbid_mutation();

-- ---------------------------------------------------------------------------
-- Queues. Underscored names: pgmq identifier rules (deviation from INFRA §8's
-- hyphenated labels, recorded in NOTES.md D-009/PLAN §3.5.8).
-- ---------------------------------------------------------------------------
select pgmq.create('sync_events');
select pgmq.create('import_batches');
select pgmq.create('transaction_enrichment');

-- Atomic enqueue used inside command transactions: pgmq.send participates in
-- the surrounding transaction, so mutation + audit + event + message commit
-- or roll back together (TASK-000 test 7).
create function public.keel_enqueue(queue_name text, message jsonb) returns bigint
language sql as $$
  select pgmq.send(queue_name, message);
$$;
