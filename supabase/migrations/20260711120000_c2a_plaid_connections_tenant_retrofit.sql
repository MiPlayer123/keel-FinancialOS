-- Stage 1C C2a: Plaid connection metadata, tenant-integrity retrofit,
-- removal tombstones, and server-side connection satellites.

-- ---------------------------------------------------------------------------
-- Connections are provider items. Plaid item ids are globally unambiguous so
-- the existing STRICT worker/webhook lookup remains deterministic.
-- ---------------------------------------------------------------------------
alter table public.connections
  add column institution_id text,
  add column consent_expires_at timestamptz,
  add column last_successful_sync_at timestamptz,
  add column sync_lease_owner uuid,
  add column sync_leased_until timestamptz,
  add column sync_desired_generation int not null default 0,
  add column sync_committed_generation int not null default 0;

create unique index connections_plaid_provider_external_ref_key
  on public.connections (provider, external_ref)
  where provider = 'plaid';

-- Composite parent keys are required before tenant-scoped child FKs can be
-- installed. The existing primary keys remain the physical row identities.
alter table public.connections
  add constraint connections_household_id_id_key unique (household_id, id);
alter table public.accounts
  add constraint accounts_household_id_id_key unique (household_id, id);
alter table public.entities
  add constraint entities_household_id_id_key unique (household_id, id);
alter table public.canonical_transactions
  add constraint canonical_transactions_household_id_id_key unique (household_id, id);
alter table public.normalized_source_records
  add constraint normalized_source_records_household_id_id_key unique (household_id, id);

-- MATCH SIMPLE deliberately permits nullable child ids (for example, manual
-- accounts without a connection) while enforcing tenant agreement when set.
alter table public.accounts
  add constraint fk_accounts_connection_tenant
  foreign key (household_id, connection_id)
  references public.connections (household_id, id)
  match simple on delete restrict;

alter table public.raw_provider_events
  add constraint fk_raw_events_connection_tenant
  foreign key (household_id, connection_id)
  references public.connections (household_id, id)
  match simple on delete restrict;

alter table public.normalized_source_records
  add constraint fk_normalized_records_account_tenant
  foreign key (household_id, account_id)
  references public.accounts (household_id, id)
  match simple on delete restrict;

alter table public.canonical_transactions
  add constraint fk_canonical_transactions_account_tenant
  foreign key (household_id, account_id)
  references public.accounts (household_id, id)
  match simple on delete restrict,
  add constraint fk_canonical_transactions_entity_tenant
  foreign key (household_id, entity_id)
  references public.entities (household_id, id)
  match simple on delete restrict;

alter table public.transaction_source_links
  add column household_id uuid;

update public.transaction_source_links as link
   set household_id = txn.household_id
  from public.canonical_transactions as txn
 where txn.id = link.canonical_transaction_id;

-- Backfill household_id automatically from the canonical transaction so the
-- already-deployed keel_worker_apply_promotion (which inserts only
-- canonical_transaction_id + normalized_source_record_id) keeps working
-- non-breakingly until C5a rewrites it. The tenant value is always derived
-- from the parent, never trusted from a caller.
create function public.keel_fill_source_link_household() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.household_id is null then
    select ct.household_id into new.household_id
      from public.canonical_transactions ct
     where ct.id = new.canonical_transaction_id;
  end if;
  return new;
end;
$$;

create trigger transaction_source_links_fill_household
  before insert on public.transaction_source_links
  for each row execute function public.keel_fill_source_link_household();

alter table public.transaction_source_links
  alter column household_id set not null,
  add constraint fk_transaction_links_canonical_tenant
  foreign key (household_id, canonical_transaction_id)
  references public.canonical_transactions (household_id, id)
  match simple on delete restrict,
  add constraint fk_transaction_links_normalized_tenant
  foreign key (household_id, normalized_source_record_id)
  references public.normalized_source_records (household_id, id)
  match simple on delete restrict;

-- Raw JSON remains a parsed convenience value. These nullable columns hold
-- exact provider response bytes and their digest for new archival paths.
alter table public.raw_provider_events
  add column body_text text,
  add column body_sha256 text;

-- Normalized removal events are explicit tombstones. Existing economic rows
-- receive kind='added'; only removal rows may omit their economic payload.
create type public.source_record_kind as enum ('added', 'modified', 'removed');

alter table public.normalized_source_records
  add column kind public.source_record_kind not null default 'added',
  alter column account_id drop not null,
  alter column amount_minor drop not null,
  alter column currency drop not null,
  alter column effective_date drop not null,
  alter column description drop not null,
  add constraint normalized_removed_requires_provider_transaction_id
    check (kind <> 'removed' or provider_transaction_id is not null),
  add constraint normalized_non_removal_requires_economic_fields
    check (
      kind = 'removed'
      or (
        account_id is not null
        and amount_minor is not null
        and currency is not null
        and effective_date is not null
        and description is not null
      )
    );

-- ---------------------------------------------------------------------------
-- Connection satellites. Composite FKs enforce tenant agreement at every
-- provider/account boundary. Client-facing tables are read-only through RLS;
-- credential/link/sync state remains server-only with no permissive policy.
-- ---------------------------------------------------------------------------
create table public.connection_credentials (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null,
  connection_id uuid not null,
  credential_owner_user_id uuid not null,
  ciphertext bytea not null,
  iv bytea not null,
  wrapped_dek bytea not null,
  wrap_iv bytea not null,
  kek_version int not null default 1,
  created_at timestamptz not null default now(),
  constraint fk_credentials_connection
    foreign key (household_id, connection_id)
    references public.connections (household_id, id)
    match simple on delete restrict
);

create table public.connection_health_events (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null,
  connection_id uuid not null,
  event_type text not null,
  severity text not null check (severity in ('info', 'warn', 'error', 'critical')),
  details jsonb,
  occurred_at timestamptz not null default now(),
  constraint fk_health_connection
    foreign key (household_id, connection_id)
    references public.connections (household_id, id)
    match simple on delete restrict
);

create table public.account_lineage (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null,
  account_id uuid not null,
  event_type text not null,
  previous_state jsonb,
  new_state jsonb,
  occurred_at timestamptz not null default now(),
  constraint fk_lineage_account
    foreign key (household_id, account_id)
    references public.accounts (household_id, id)
    match simple on delete restrict
);

create table public.balance_snapshots (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null,
  account_id uuid not null,
  as_of timestamptz not null,
  available_minor bigint,
  current_minor bigint not null,
  currency text not null,
  source text not null,
  snapshot_metadata jsonb,
  created_at timestamptz not null default now(),
  constraint fk_snapshot_account
    foreign key (household_id, account_id)
    references public.accounts (household_id, id)
    match simple on delete restrict
);

create table public.link_attempts (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null,
  initiated_by_user_id uuid not null,
  provider text not null,
  institution_id text,
  state text not null default 'initiated'
    check (state in ('initiated', 'pending', 'succeeded', 'failed', 'expired')),
  credential_ciphertext bytea,
  failure_code text,
  failure_message text,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  connection_id uuid
);

create table public.removal_attempts (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null,
  connection_id uuid not null,
  initiated_by_user_id uuid not null,
  state text not null default 'pending'
    check (state in ('pending', 'succeeded', 'failed')),
  reason text,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint fk_removal_connection
    foreign key (household_id, connection_id)
    references public.connections (household_id, id)
    match simple on delete restrict
);

create type public.sync_attempt_state as enum ('open', 'completed', 'abandoned');

create table public.sync_attempts (
  attempt_id uuid primary key default gen_random_uuid(),
  household_id uuid not null,
  connection_id uuid not null,
  base_cursor text,
  next_request_cursor text,
  page_ordinal int not null default 0,
  generation int not null,
  state public.sync_attempt_state not null default 'open',
  promoted_at timestamptz,
  created_at timestamptz not null default now(),
  constraint fk_sync_connection
    foreign key (household_id, connection_id)
    references public.connections (household_id, id)
    match simple on delete restrict
);

create table public.usage_events (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null,
  actor_user_id uuid,
  event_type text not null,
  resource_type text,
  resource_id uuid,
  metadata jsonb,
  occurred_at timestamptz not null default now()
);

alter table public.connection_credentials enable row level security;
alter table public.connection_health_events enable row level security;
alter table public.account_lineage enable row level security;
alter table public.balance_snapshots enable row level security;
alter table public.link_attempts enable row level security;
alter table public.removal_attempts enable row level security;
alter table public.sync_attempts enable row level security;
alter table public.usage_events enable row level security;

-- Supabase may apply client-role default privileges to tables created after
-- the Stage 1A blanket revoke. Start from zero, then expose only scoped reads.
revoke all on public.connection_credentials from anon, authenticated;
revoke all on public.connection_health_events from anon, authenticated;
revoke all on public.account_lineage from anon, authenticated;
revoke all on public.balance_snapshots from anon, authenticated;
revoke all on public.link_attempts from anon, authenticated;
revoke all on public.removal_attempts from anon, authenticated;
revoke all on public.sync_attempts from anon, authenticated;
revoke all on public.usage_events from anon, authenticated;

grant select on public.connection_health_events to authenticated;
grant select on public.account_lineage to authenticated;
grant select on public.balance_snapshots to authenticated;
grant select on public.removal_attempts to authenticated;
grant select on public.usage_events to authenticated;

create policy connection_health_events_member_read
  on public.connection_health_events
  for select to authenticated
  using (public.keel_is_household_member(household_id));

create policy account_lineage_member_read
  on public.account_lineage
  for select to authenticated
  using (public.keel_is_household_member(household_id));

create policy balance_snapshots_member_read
  on public.balance_snapshots
  for select to authenticated
  using (public.keel_is_household_member(household_id));

create policy removal_attempts_member_read
  on public.removal_attempts
  for select to authenticated
  using (public.keel_is_household_member(household_id));

create policy usage_events_member_read
  on public.usage_events
  for select to authenticated
  using (public.keel_is_household_member(household_id));

-- The local stack's table default ACL does not include SELECT for
-- service_role, so grant it explicitly on the readable satellite tables.
grant select on public.connection_health_events to service_role;
grant select on public.account_lineage to service_role;
grant select on public.balance_snapshots to service_role;
grant select on public.removal_attempts to service_role;
grant select on public.usage_events to service_role;
