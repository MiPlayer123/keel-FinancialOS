-- Stage 1A foundation: extensions, runtime roles, enum types.
-- INFRA.md §6 (roles), CLAUDE.md Law 4 (enums over strings).

create extension if not exists pgmq;

-- ---------------------------------------------------------------------------
-- Runtime roles (cluster-level; guarded because `db reset` recreates the
-- database but not roles). NOLOGIN grant-bundles: they own SECURITY DEFINER
-- command functions and hold the only DML privileges on canonical tables
-- (PLAN.md §3.5.1). They are not table owners and never receive BYPASSRLS.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'keel_api') then
    create role keel_api nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'keel_worker') then
    create role keel_worker nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'keel_readonly') then
    create role keel_readonly nologin;
  end if;
end
$$;

-- The definer roles must be usable by the migrator when it creates functions
-- owned by them, and traversable by PostgREST's authenticator.
grant keel_api to postgres;
grant keel_worker to postgres;

-- ---------------------------------------------------------------------------
-- Enums (Law 4: enums over strings; no implicit defaults anywhere).
-- ---------------------------------------------------------------------------
create type household_role as enum ('owner', 'partner', 'viewer', 'professional');
create type entity_kind as enum
  ('personal', 'sole_prop', 'llc_single', 'llc_multi', 's_corp', 'trust', 'other');
create type ledger_account_kind as enum ('asset', 'liability', 'income', 'expense', 'equity');
create type transaction_status as enum ('pending', 'posted', 'reviewed', 'voided');
create type transaction_source as enum ('sync', 'manual', 'import', 'split_child', 'system');
create type bank_provider as enum ('simulator', 'plaid');
create type connection_status as enum ('linking', 'active', 'reauth_required', 'disconnected');
create type resource_kind as enum ('account', 'entity', 'document');
create type resource_permission_level as enum ('view', 'edit', 'export');
create type ai_risk_class as enum ('A', 'B', 'C', 'D');
create type autonomy_level as enum ('off', 'suggest', 'auto_with_log');
