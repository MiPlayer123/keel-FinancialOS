-- Every entity that can hold synced transactions needs the offset categories
-- the sync worker routes uncategorized economics into. The promotion procs
-- (c5b_sync_pull, c3_link_disconnect_saga, stage1c_exit_hardening) resolve the
-- offset by NAME per entity ('Uncategorized Expense' / 'Uncategorized Income')
-- and raise KEEL_INVALID_COMMAND: offset category missing when absent.
--
-- Until now these categories existed ONLY for the demo/fixture entities in
-- seed.sql, so any REAL entity (created at onboarding/link) failed its very
-- first Plaid sync. This migration guarantees the defaults for every entity:
--   * a trigger seeds them at entity creation (the real onboarding path), and
--   * a one-time backfill repairs entities that predate this migration.
--
-- Demo/fixture entities are seeded with STABLE ids in seed.sql (tests reference
-- e.g. Uncategorized Income 00000000-0000-4000-8000-00000000a318), so the
-- trigger skips them to keep those ids deterministic. seed.sql runs on local
-- resets only; cloud is unaffected by that path.

create or replace function public.keel_seed_entity_default_categories()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Demo/fixture entities are seeded explicitly (stable ids) by seed.sql.
  if new.id in (
    '00000000-0000-4000-8000-00000000a101',
    '00000000-0000-4000-8000-00000000a102',
    '00000000-0000-4000-8000-00000000b101'
  ) then
    return new;
  end if;

  insert into public.ledger_accounts
    (household_id, entity_id, name, kind, currency, is_category)
  select new.household_id, new.id, d.name, d.kind::public.ledger_account_kind, 'USD', d.is_category
  from (values
    ('Uncategorized Expense', 'expense', true),
    ('Uncategorized Income',  'income',  true),
    ('Opening Balances',      'equity',  false)
  ) as d(name, kind, is_category)
  where not exists (
    select 1 from public.ledger_accounts la
    where la.entity_id = new.id and la.name = d.name and la.archived_at is null
  );

  return new;
end;
$$;

drop trigger if exists trg_entity_default_categories on public.entities;
create trigger trg_entity_default_categories
  after insert on public.entities
  for each row execute function public.keel_seed_entity_default_categories();

-- One-time backfill for entities created before this migration (excludes the
-- fixture entities, which seed.sql owns).
insert into public.ledger_accounts
  (household_id, entity_id, name, kind, currency, is_category)
select e.household_id, e.id, d.name, d.kind::public.ledger_account_kind, 'USD', d.is_category
from public.entities e
cross join (values
  ('Uncategorized Expense', 'expense', true),
  ('Uncategorized Income',  'income',  true),
  ('Opening Balances',      'equity',  false)
) as d(name, kind, is_category)
where e.id not in (
  '00000000-0000-4000-8000-00000000a101',
  '00000000-0000-4000-8000-00000000a102',
  '00000000-0000-4000-8000-00000000b101'
)
and not exists (
  select 1 from public.ledger_accounts la
  where la.entity_id = e.id and la.name = d.name and la.archived_at is null
);
