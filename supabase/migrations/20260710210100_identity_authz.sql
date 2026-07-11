-- Identity, households, entities, accounts, ownership, grants.
-- BC-v2.1 §3 "Identity, households, entities, and sharing"; INFRA.md §6.
-- Supabase Auth answers WHO; these tables answer WHAT the person may touch.

create table households (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 200),
  created_at timestamptz not null default now()
);

create table household_memberships (
  household_id uuid not null references households (id),
  user_id uuid not null references auth.users (id),
  role household_role not null,
  created_at timestamptz not null default now(),
  primary key (household_id, user_id)
);

create table entities (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households (id),
  name text not null check (length(name) between 1 and 200),
  kind entity_kind not null,
  created_at timestamptz not null default now(),
  archived_at timestamptz
);

create table entity_memberships (
  entity_id uuid not null references entities (id),
  user_id uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  primary key (entity_id, user_id)
);

create table connections (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households (id),
  provider bank_provider not null,
  external_ref text not null check (length(external_ref) between 1 and 256),
  status connection_status not null,
  created_at timestamptz not null default now(),
  unique (household_id, provider, external_ref)
);

-- Formal chart of accounts: postings reference ONLY these. Real financial
-- accounts (below) each own one backing ledger account; categories are
-- income/expense ledger accounts without a real-account wrapper.
create table ledger_accounts (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households (id),
  entity_id uuid not null references entities (id),
  name text not null check (length(name) between 1 and 200),
  kind ledger_account_kind not null,
  currency char(3) not null check (currency = upper(currency)),
  is_category boolean not null,
  created_at timestamptz not null default now(),
  archived_at timestamptz
);

-- Real-world financial accounts (checking, card, …). BC-v2.1 separates these
-- from the ledger chart; the backing ledger account carries their postings.
create table accounts (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households (id),
  entity_id uuid not null references entities (id),
  connection_id uuid references connections (id),
  ledger_account_id uuid not null unique references ledger_accounts (id),
  name text not null check (length(name) between 1 and 200),
  subtype text not null check (length(subtype) between 1 and 100),
  currency char(3) not null check (currency = upper(currency)),
  external_ref text check (external_ref is null or length(external_ref) between 1 and 256),
  created_at timestamptz not null default now(),
  archived_at timestamptz
);

create unique index accounts_provider_ref
  on accounts (connection_id, external_ref)
  where connection_id is not null and external_ref is not null;

create table account_owners (
  account_id uuid not null references accounts (id),
  user_id uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  primary key (account_id, user_id)
);

create table resource_permissions (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households (id),
  user_id uuid not null references auth.users (id),
  resource_kind resource_kind not null,
  resource_id uuid not null,
  permission resource_permission_level not null,
  created_at timestamptz not null default now(),
  unique (household_id, user_id, resource_kind, resource_id, permission)
);

create table approval_policies (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households (id),
  risk_class ai_risk_class not null,
  autonomy autonomy_level not null,
  created_at timestamptz not null default now(),
  unique (household_id, risk_class)
);

-- Class D is disabled, always (CLAUDE.md Law 10). Refuse any policy row that
-- grants class-D autonomy above 'off'.
alter table approval_policies add constraint approval_policies_class_d_off
  check (risk_class <> 'D' or autonomy = 'off');
