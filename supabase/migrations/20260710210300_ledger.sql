-- Canonical ledger: transactions, balanced journal batches/postings,
-- revisions, period locks. CLAUDE.md Law 3 (postings invariant) and Law 2
-- (corrections are reversals, never mutation). Debit-positive (doc 10 §2.4).

create table public.canonical_transactions (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id),
  entity_id uuid not null references public.entities (id),
  account_id uuid not null references public.accounts (id),
  status public.transaction_status not null,
  source public.transaction_source not null,
  description text not null check (length(description) <= 500),
  effective_date date not null,
  -- Idempotent economics (Law 9): one economic event, one canonical row.
  economic_event_key text not null unique check (length(economic_event_key) between 8 and 256),
  created_at timestamptz not null default now(),
  voided_at timestamptz
);

create table public.transaction_source_links (
  canonical_transaction_id uuid not null references public.canonical_transactions (id),
  normalized_source_record_id uuid not null references public.normalized_source_records (id),
  created_at timestamptz not null default now(),
  primary key (canonical_transaction_id, normalized_source_record_id)
);

create table public.journal_batches (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id),
  canonical_transaction_id uuid references public.canonical_transactions (id),
  description text not null check (length(description) <= 500),
  effective_date date not null,
  -- Set on compensating batches; the original row is never touched (Law 2).
  reverses_batch_id uuid references public.journal_batches (id),
  command_id uuid not null,
  posted_at timestamptz not null default now()
);

create table public.journal_postings (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.journal_batches (id),
  ledger_account_id uuid not null references public.ledger_accounts (id),
  entity_id uuid not null references public.entities (id),
  amount_minor bigint not null check (amount_minor <> 0),
  currency char(3) not null check (currency = upper(currency))
);

create index journal_postings_batch on public.journal_postings (batch_id);
create index journal_postings_account on public.journal_postings (ledger_account_id);

-- Postings and batches are append-only: corrections happen through new
-- compensating batches recorded in journal_revisions.
create trigger journal_batches_immutable
  before update or delete on public.journal_batches
  for each row execute function public.keel_forbid_mutation();
create trigger journal_postings_immutable
  before update or delete on public.journal_postings
  for each row execute function public.keel_forbid_mutation();

create table public.journal_revisions (
  id uuid primary key default gen_random_uuid(),
  original_batch_id uuid not null references public.journal_batches (id),
  reversal_batch_id uuid not null references public.journal_batches (id),
  replacement_batch_id uuid references public.journal_batches (id),
  reason text not null check (length(reason) between 1 and 500),
  created_at timestamptz not null default now(),
  unique (original_batch_id, reversal_batch_id)
);

create trigger journal_revisions_immutable
  before update or delete on public.journal_revisions
  for each row execute function public.keel_forbid_mutation();

create table public.period_locks (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id),
  entity_id uuid references public.entities (id),
  start_date date not null,
  end_date date not null check (end_date >= start_date),
  locked_by uuid not null references auth.users (id),
  locked_at timestamptz not null default now(),
  reopened_at timestamptz,
  reopen_reason text check (
    (reopened_at is null and reopen_reason is null)
    or (reopened_at is not null and length(reopen_reason) between 1 and 500)
  )
);

-- ---------------------------------------------------------------------------
-- Law 3, database layer: per batch per currency, Σ amount_minor = 0.
-- Deferred constraint trigger — validated at COMMIT so a batch's postings can
-- be inserted row by row inside the command transaction.
-- ---------------------------------------------------------------------------
create function public.keel_check_batch_balance() returns trigger
language plpgsql as $$
declare
  bad record;
begin
  select p.batch_id, p.currency, sum(p.amount_minor) as delta
    into bad
    from public.journal_postings p
   where p.batch_id = new.batch_id
   group by p.batch_id, p.currency
  having sum(p.amount_minor) <> 0
   limit 1;

  if found then
    raise exception
      'KEEL_UNBALANCED: batch % does not balance for % (delta %)',
      bad.batch_id, bad.currency, bad.delta
      using errcode = 'P0002';
  end if;

  -- A batch with fewer than two postings is not a journal entry.
  if (select count(*) from public.journal_postings p where p.batch_id = new.batch_id) < 2 then
    raise exception 'KEEL_UNBALANCED: batch % has fewer than two postings', new.batch_id
      using errcode = 'P0002';
  end if;

  return null;
end;
$$;

create constraint trigger journal_postings_balance
  after insert on public.journal_postings
  deferrable initially deferred
  for each row execute function public.keel_check_batch_balance();

-- ---------------------------------------------------------------------------
-- Period-lock guard: no posting may land inside a locked (un-reopened) period
-- for its household/entity scope.
-- ---------------------------------------------------------------------------
create function public.keel_check_period_lock() returns trigger
language plpgsql as $$
declare
  batch record;
  lock_row record;
begin
  select b.household_id, b.effective_date into batch
    from public.journal_batches b where b.id = new.batch_id;

  select l.id into lock_row
    from public.period_locks l
   where l.household_id = batch.household_id
     and (l.entity_id is null or l.entity_id = new.entity_id)
     and l.reopened_at is null
     and batch.effective_date between l.start_date and l.end_date
   limit 1;

  if found then
    raise exception 'KEEL_PERIOD_LOCKED: batch date % falls in locked period %',
      batch.effective_date, lock_row.id
      using errcode = 'P0003';
  end if;

  return new;
end;
$$;

create trigger journal_postings_period_lock
  before insert on public.journal_postings
  for each row execute function public.keel_check_period_lock();
