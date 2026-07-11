-- KEEL local/dev seed. Deterministic fixed UUIDs; every configurable field
-- supplied explicitly (CLAUDE.md Law 4: no implicit defaults). LOCAL ONLY:
-- these users carry a well-known dev password and must never reach a real
-- deployment with data.

-- ---------------------------------------------------------------------------
-- Auth identities (PLAN §3.6.2). GoTrue requires the empty-string defaults on
-- token columns; password is 'keel-local-dev-password' for all seed users.
-- ---------------------------------------------------------------------------
insert into auth.users
  (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
   raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
   confirmation_token, recovery_token, email_change, email_change_token_new)
values
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-4000-8000-000000000001',
   'authenticated', 'authenticated', 'alex@keel.local',
   crypt('keel-local-dev-password', gen_salt('bf')), now(),
   '{"provider":"email","providers":["email"]}', '{"name":"Alex Founder"}', now(), now(),
   '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-4000-8000-000000000002',
   'authenticated', 'authenticated', 'blake@keel.local',
   crypt('keel-local-dev-password', gen_salt('bf')), now(),
   '{"provider":"email","providers":["email"]}', '{"name":"Blake Partner"}', now(), now(),
   '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-4000-8000-000000000003',
   'authenticated', 'authenticated', 'casey@keel.local',
   crypt('keel-local-dev-password', gen_salt('bf')), now(),
   '{"provider":"email","providers":["email"]}', '{"name":"Casey Other"}', now(), now(),
   '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-4000-8000-000000000004',
   'authenticated', 'authenticated', 'priya@keel.local',
   crypt('keel-local-dev-password', gen_salt('bf')), now(),
   '{"provider":"email","providers":["email"]}', '{"name":"Priya CPA"}', now(), now(),
   '', '', '', '');

insert into auth.identities
  (id, user_id, identity_data, provider, provider_id, last_sign_in_at, created_at, updated_at)
select
  u.id, u.id,
  jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true),
  'email', u.id::text, now(), now(), now()
from auth.users u
where u.email like '%@keel.local';

-- ---------------------------------------------------------------------------
-- Households + cross-membership matrix (tenant-isolation tests need a user
-- who exists in BOTH households with different roles).
-- ---------------------------------------------------------------------------
insert into public.households (id, name, created_at) values
  ('00000000-0000-4000-8000-00000000a001', 'Alpha Household', now()),
  ('00000000-0000-4000-8000-00000000b001', 'Beta Household', now());

insert into public.household_memberships (household_id, user_id, role, created_at) values
  ('00000000-0000-4000-8000-00000000a001', '00000000-0000-4000-8000-000000000001', 'owner', now()),
  ('00000000-0000-4000-8000-00000000a001', '00000000-0000-4000-8000-000000000002', 'partner', now()),
  ('00000000-0000-4000-8000-00000000a001', '00000000-0000-4000-8000-000000000004', 'professional', now()),
  ('00000000-0000-4000-8000-00000000b001', '00000000-0000-4000-8000-000000000003', 'owner', now()),
  ('00000000-0000-4000-8000-00000000b001', '00000000-0000-4000-8000-000000000001', 'viewer', now());

insert into public.entities (id, household_id, name, kind, created_at, archived_at) values
  ('00000000-0000-4000-8000-00000000a101', '00000000-0000-4000-8000-00000000a001',
   'Personal', 'personal', now(), null),
  ('00000000-0000-4000-8000-00000000a102', '00000000-0000-4000-8000-00000000a001',
   'Condo Services LLC', 'llc_single', now(), null),
  ('00000000-0000-4000-8000-00000000b101', '00000000-0000-4000-8000-00000000b001',
   'Personal', 'personal', now(), null);

insert into public.entity_memberships (entity_id, user_id, created_at) values
  ('00000000-0000-4000-8000-00000000a101', '00000000-0000-4000-8000-000000000001', now()),
  ('00000000-0000-4000-8000-00000000a101', '00000000-0000-4000-8000-000000000002', now()),
  ('00000000-0000-4000-8000-00000000a102', '00000000-0000-4000-8000-000000000001', now()),
  ('00000000-0000-4000-8000-00000000b101', '00000000-0000-4000-8000-000000000003', now());

insert into public.connections (id, household_id, provider, external_ref, status, created_at) values
  ('00000000-0000-4000-8000-00000000a201', '00000000-0000-4000-8000-00000000a001',
   'simulator', 'sim-conn-alpha', 'active', now()),
  ('00000000-0000-4000-8000-00000000b201', '00000000-0000-4000-8000-00000000b001',
   'simulator', 'sim-conn-beta', 'active', now()),
  -- Plaid item stub so verified webhook fixtures route to a household
  -- (real Plaid linking is stage 1C ⚑; this is a local routing target only).
  ('00000000-0000-4000-8000-00000000a202', '00000000-0000-4000-8000-00000000a001',
   'plaid', 'plaid-item-alpha', 'active', now());

-- ---------------------------------------------------------------------------
-- Chart of accounts. Real accounts get backing asset/liability ledger
-- accounts; categories are expense/income ledger accounts (is_category=true);
-- one equity account per entity for opening balances.
-- ---------------------------------------------------------------------------
insert into public.ledger_accounts (id, household_id, entity_id, name, kind, currency, is_category, created_at, archived_at) values
  -- Alpha / Personal — real account backings
  ('00000000-0000-4000-8000-00000000a301', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', 'Simulator Checking', 'asset', 'USD', false, now(), null),
  ('00000000-0000-4000-8000-00000000a302', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', 'Simulator Card', 'liability', 'USD', false, now(), null),
  -- Alpha / Personal — categories
  ('00000000-0000-4000-8000-00000000a311', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', 'Groceries', 'expense', 'USD', true, now(), null),
  ('00000000-0000-4000-8000-00000000a312', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', 'Household', 'expense', 'USD', true, now(), null),
  ('00000000-0000-4000-8000-00000000a313', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', 'Rent', 'expense', 'USD', true, now(), null),
  ('00000000-0000-4000-8000-00000000a314', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', 'Coffee Shops', 'expense', 'USD', true, now(), null),
  ('00000000-0000-4000-8000-00000000a315', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', 'Salary', 'income', 'USD', true, now(), null),
  ('00000000-0000-4000-8000-00000000a316', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', 'Opening Balances', 'equity', 'USD', false, now(), null),
  -- Default offsets for sync promotion before categorization (worker path)
  ('00000000-0000-4000-8000-00000000a317', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', 'Uncategorized Expense', 'expense', 'USD', true, now(), null),
  ('00000000-0000-4000-8000-00000000a318', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', 'Uncategorized Income', 'income', 'USD', true, now(), null),
  -- Beta / Personal
  ('00000000-0000-4000-8000-00000000b301', '00000000-0000-4000-8000-00000000b001',
   '00000000-0000-4000-8000-00000000b101', 'Beta Checking', 'asset', 'USD', false, now(), null),
  ('00000000-0000-4000-8000-00000000b311', '00000000-0000-4000-8000-00000000b001',
   '00000000-0000-4000-8000-00000000b101', 'Groceries', 'expense', 'USD', true, now(), null),
  ('00000000-0000-4000-8000-00000000b316', '00000000-0000-4000-8000-00000000b001',
   '00000000-0000-4000-8000-00000000b101', 'Opening Balances', 'equity', 'USD', false, now(), null),
  ('00000000-0000-4000-8000-00000000b317', '00000000-0000-4000-8000-00000000b001',
   '00000000-0000-4000-8000-00000000b101', 'Uncategorized Expense', 'expense', 'USD', true, now(), null),
  ('00000000-0000-4000-8000-00000000b318', '00000000-0000-4000-8000-00000000b001',
   '00000000-0000-4000-8000-00000000b101', 'Uncategorized Income', 'income', 'USD', true, now(), null);

insert into public.accounts
  (id, household_id, entity_id, connection_id, ledger_account_id, name, subtype, currency, external_ref, created_at, archived_at)
values
  ('00000000-0000-4000-8000-00000000a401', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', '00000000-0000-4000-8000-00000000a201',
   '00000000-0000-4000-8000-00000000a301', 'Simulator Checking', 'checking', 'USD',
   'sim-acct-checking', now(), null),
  ('00000000-0000-4000-8000-00000000a402', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', '00000000-0000-4000-8000-00000000a201',
   '00000000-0000-4000-8000-00000000a302', 'Simulator Card', 'credit_card', 'USD',
   'sim-acct-card', now(), null),
  ('00000000-0000-4000-8000-00000000b401', '00000000-0000-4000-8000-00000000b001',
   '00000000-0000-4000-8000-00000000b101', '00000000-0000-4000-8000-00000000b201',
   '00000000-0000-4000-8000-00000000b301', 'Beta Checking', 'checking', 'USD',
   'sim-acct-beta-checking', now(), null);

insert into public.account_owners (account_id, user_id, created_at) values
  ('00000000-0000-4000-8000-00000000a401', '00000000-0000-4000-8000-000000000001', now()),
  ('00000000-0000-4000-8000-00000000a401', '00000000-0000-4000-8000-000000000002', now()),
  ('00000000-0000-4000-8000-00000000a402', '00000000-0000-4000-8000-000000000001', now()),
  ('00000000-0000-4000-8000-00000000b401', '00000000-0000-4000-8000-000000000003', now());

-- Autonomy policies: explicit row per class per household; class D always off
-- (Law 10; the table CHECK also refuses anything else).
insert into public.approval_policies (id, household_id, risk_class, autonomy, created_at) values
  ('00000000-0000-4000-8000-00000000a501', '00000000-0000-4000-8000-00000000a001', 'A', 'auto_with_log', now()),
  ('00000000-0000-4000-8000-00000000a502', '00000000-0000-4000-8000-00000000a001', 'B', 'suggest', now()),
  ('00000000-0000-4000-8000-00000000a503', '00000000-0000-4000-8000-00000000a001', 'C', 'suggest', now()),
  ('00000000-0000-4000-8000-00000000a504', '00000000-0000-4000-8000-00000000a001', 'D', 'off', now()),
  ('00000000-0000-4000-8000-00000000b501', '00000000-0000-4000-8000-00000000b001', 'A', 'suggest', now()),
  ('00000000-0000-4000-8000-00000000b502', '00000000-0000-4000-8000-00000000b001', 'B', 'suggest', now()),
  ('00000000-0000-4000-8000-00000000b503', '00000000-0000-4000-8000-00000000b001', 'C', 'off', now()),
  ('00000000-0000-4000-8000-00000000b504', '00000000-0000-4000-8000-00000000b001', 'D', 'off', now());
