-- Category system. A transaction's "category" is the ledger account on the
-- non-cash (offset) side of its posting. We seed a real taxonomy per entity,
-- map Plaid's personal_finance_category (deterministic — Law 1, no LLM) onto it,
-- and auto-file synced transactions off the Uncategorized defaults.
--
-- Re-categorization moves the offset posting between category accounts of the
-- SAME kind (expense↔expense, income↔income): amount, currency, cash account and
-- date are immutable, so the batch stays balanced and net worth is unaffected.
-- This is the mutable-classification model every consumer finance app uses;
-- every change is written to audit_log (undoable). Deviation logged in NOTES.

-- ---------------------------------------------------------------------------
-- Full default taxonomy for one entity (idempotent).
-- ---------------------------------------------------------------------------
create or replace function public.keel_seed_entity_categories(
  p_entity_id uuid,
  p_household_id uuid
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.ledger_accounts
    (household_id, entity_id, name, kind, currency, is_category)
  select p_household_id, p_entity_id, d.name, d.kind::public.ledger_account_kind, 'USD', d.is_category
  from (values
    -- offsets used before/around categorization
    ('Uncategorized Expense', 'expense', true),
    ('Uncategorized Income',  'income',  true),
    ('Opening Balances',      'equity',  false),
    -- expense categories (mapped from Plaid PFC primaries)
    ('Fees',                    'expense', true),
    ('Entertainment',           'expense', true),
    ('Food & Drink',            'expense', true),
    ('Shopping',                'expense', true),
    ('Services',                'expense', true),
    ('Government & Nonprofit',  'expense', true),
    ('Home',                    'expense', true),
    ('Loan Payments',           'expense', true),
    ('Medical',                 'expense', true),
    ('Personal Care',           'expense', true),
    ('Bills & Utilities',       'expense', true),
    ('Transportation',          'expense', true),
    ('Travel',                  'expense', true),
    ('Transfers',               'expense', true),
    ('Other',                   'expense', true),
    -- income categories
    ('Income',                  'income',  true),
    ('Other Income',            'income',  true)
  ) as d(name, kind, is_category)
  where not exists (
    select 1 from public.ledger_accounts la
    where la.entity_id = p_entity_id and la.name = d.name and la.archived_at is null
  );
end;
$$;

grant execute on function public.keel_seed_entity_categories(uuid, uuid) to service_role;

-- Trigger now seeds the full taxonomy (fixture entities still skipped so their
-- fixed ids stay deterministic).
create or replace function public.keel_seed_entity_default_categories()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.id in (
    '00000000-0000-4000-8000-00000000a101',
    '00000000-0000-4000-8000-00000000a102',
    '00000000-0000-4000-8000-00000000b101'
  ) then
    return new;
  end if;
  perform public.keel_seed_entity_categories(new.id, new.household_id);
  return new;
end;
$$;

-- Backfill full taxonomy for existing non-fixture entities.
do $$
declare r record;
begin
  for r in
    select id, household_id from public.entities
    where id not in (
      '00000000-0000-4000-8000-00000000a101',
      '00000000-0000-4000-8000-00000000a102',
      '00000000-0000-4000-8000-00000000b101')
  loop
    perform public.keel_seed_entity_categories(r.id, r.household_id);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Plaid PFC primary → category name, direction-aware (offset kind).
-- ---------------------------------------------------------------------------
create or replace function public.keel_pfc_to_category_name(
  p_primary text,
  p_kind public.ledger_account_kind
) returns text
language sql
immutable
as $$
  select case
    when p_kind = 'income' then
      case when p_primary = 'INCOME' then 'Income' else 'Other Income' end
    else
      case p_primary
        when 'BANK_FEES' then 'Fees'
        when 'ENTERTAINMENT' then 'Entertainment'
        when 'FOOD_AND_DRINK' then 'Food & Drink'
        when 'GENERAL_MERCHANDISE' then 'Shopping'
        when 'GENERAL_SERVICES' then 'Services'
        when 'GOVERNMENT_AND_NON_PROFIT' then 'Government & Nonprofit'
        when 'HOME_IMPROVEMENT' then 'Home'
        when 'LOAN_PAYMENTS' then 'Loan Payments'
        when 'MEDICAL' then 'Medical'
        when 'PERSONAL_CARE' then 'Personal Care'
        when 'RENT_AND_UTILITIES' then 'Bills & Utilities'
        when 'TRANSPORTATION' then 'Transportation'
        when 'TRAVEL' then 'Travel'
        when 'TRANSFER_OUT' then 'Transfers'
        when 'TRANSFER_IN' then 'Transfers'
        else 'Other'
      end
  end;
$$;

-- ---------------------------------------------------------------------------
-- Bulk auto-categorization (system): re-file postings currently on the
-- Uncategorized defaults onto their PFC-mapped category, never crossing kind.
-- ---------------------------------------------------------------------------
create or replace function public.keel_autocategorize_household(p_household_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  with pfc as (
    select distinct on (elem->>'transaction_id')
           elem->>'transaction_id' as ptid,
           coalesce(elem->'personal_finance_category'->>'primary', '') as primary
      from public.raw_provider_events r
      cross join lateral jsonb_array_elements(
        coalesce(r.body_text::jsonb->'added', '[]'::jsonb)) elem
      where r.household_id = p_household_id
        and (r.body_text::jsonb) ? 'added'
      order by elem->>'transaction_id', r.received_at desc
  ),
  targets as (
    select jp.id as posting_id, jp.entity_id, jp.ledger_account_id as old_la, la.kind,
           public.keel_pfc_to_category_name(pfc.primary, la.kind) as cat_name
      from public.canonical_transactions ct
      join public.journal_batches jb
        on jb.canonical_transaction_id = ct.id and jb.reverses_batch_id is null
      join public.journal_postings jp on jp.batch_id = jb.id
      join public.ledger_accounts la on la.id = jp.ledger_account_id and la.is_category = true
      join public.transaction_source_links tsl on tsl.canonical_transaction_id = ct.id
      join public.normalized_source_records nsr on nsr.id = tsl.normalized_source_record_id
      join pfc on pfc.ptid = nsr.provider_transaction_id
      where ct.household_id = p_household_id
        and la.name in ('Uncategorized Expense', 'Uncategorized Income')
  )
  update public.journal_postings jp
     set ledger_account_id = cat.id
    from targets t
    join public.ledger_accounts cat
      on cat.entity_id = t.entity_id and cat.name = t.cat_name
     and cat.is_category = true and cat.archived_at is null and cat.kind = t.kind
   where jp.id = t.posting_id
     and cat.id <> jp.ledger_account_id;
  get diagnostics v_count = row_count;

  if v_count > 0 then
    insert into public.audit_log (household_id, actor, action, object_type, object_id, after)
    values (p_household_id, jsonb_build_object('kind', 'system', 'source', 'plaid_pfc'),
            'transactions.autocategorize', 'household', p_household_id,
            jsonb_build_object('recategorized', v_count));
  end if;
  return v_count;
end;
$$;

grant execute on function public.keel_autocategorize_household(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- User-initiated single re-categorization (moves the offset, same kind only).
-- ---------------------------------------------------------------------------
create or replace function public.keel_categorize_transaction(
  p_household_id uuid,
  p_txn_id uuid,
  p_category_ledger_account_id uuid
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_posting_id uuid;
  v_old_la     uuid;
  v_entity     uuid;
  v_old_kind   public.ledger_account_kind;
  v_new_kind   public.ledger_account_kind;
  v_new_is_cat boolean;
  v_new_entity uuid;
begin
  if auth.uid() is null then
    raise exception 'KEEL_NOT_AUTHENTICATED' using errcode = 'P0004';
  end if;
  if not exists (
    select 1 from public.household_memberships
    where household_id = p_household_id and user_id = auth.uid()
  ) then
    raise exception 'KEEL_NOT_FOUND' using errcode = 'P0006';
  end if;

  select jp.id, jp.ledger_account_id, jp.entity_id, la.kind
    into v_posting_id, v_old_la, v_entity, v_old_kind
    from public.canonical_transactions ct
    join public.journal_batches jb
      on jb.canonical_transaction_id = ct.id and jb.reverses_batch_id is null
    join public.journal_postings jp on jp.batch_id = jb.id
    join public.ledger_accounts la on la.id = jp.ledger_account_id and la.is_category = true
    where ct.id = p_txn_id and ct.household_id = p_household_id
    limit 1;
  if v_posting_id is null then
    raise exception 'KEEL_NOT_FOUND: category posting' using errcode = 'P0006';
  end if;

  select kind, is_category, entity_id
    into v_new_kind, v_new_is_cat, v_new_entity
    from public.ledger_accounts where id = p_category_ledger_account_id;
  if v_new_is_cat is not true or v_new_entity <> v_entity or v_new_kind <> v_old_kind then
    raise exception 'KEEL_INVALID_COMMAND: category kind/entity mismatch' using errcode = 'P0009';
  end if;

  update public.journal_postings
     set ledger_account_id = p_category_ledger_account_id
   where id = v_posting_id;

  insert into public.audit_log (household_id, actor, action, object_type, object_id, before, after)
  values (p_household_id, jsonb_build_object('kind', 'user', 'userId', auth.uid()),
          'transaction.categorize', 'canonical_transaction', p_txn_id,
          jsonb_build_object('categoryLedgerAccountId', v_old_la),
          jsonb_build_object('categoryLedgerAccountId', p_category_ledger_account_id));
end;
$$;

grant execute on function public.keel_categorize_transaction(uuid, uuid, uuid) to authenticated, service_role;

-- List categories for a household (for the re-categorize picker).
create or replace function public.keel_list_categories(p_household_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'ledgerAccountId', id, 'name', name, 'kind', kind, 'entityId', entity_id
         ) order by kind, name), '[]'::jsonb)
  from public.ledger_accounts
  where household_id = p_household_id and is_category = true and archived_at is null
    and name not in ('Opening Balances');
$$;

grant execute on function public.keel_list_categories(uuid) to authenticated, service_role;
