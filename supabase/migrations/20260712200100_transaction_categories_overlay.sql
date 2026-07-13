-- journal_postings are append-only (keel_forbid_mutation), so a category cannot
-- be an in-place offset move. The double-entry ledger stays the immutable record
-- of money movement (offset remains Uncategorized Expense/Income for correct
-- income/expense/net-worth totals); the user-facing CATEGORY is a mutable,
-- audited classification overlay keyed to the canonical transaction. Category
-- P&L/reports read this overlay. Deviation rationale logged in NOTES.

create table if not exists public.transaction_categories (
  canonical_transaction_id   uuid primary key,
  household_id               uuid not null,
  category_ledger_account_id uuid not null references public.ledger_accounts(id),
  source                     text not null default 'user',
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now()
);
create index if not exists transaction_categories_household
  on public.transaction_categories (household_id);

alter table public.transaction_categories enable row level security;
drop policy if exists transaction_categories_member_read on public.transaction_categories;
create policy transaction_categories_member_read on public.transaction_categories
  for select to authenticated
  using (exists (
    select 1 from public.household_memberships m
    where m.household_id = transaction_categories.household_id and m.user_id = auth.uid()
  ));
grant select on public.transaction_categories to authenticated;

-- Bulk auto-categorization from Plaid PFC (system). Never overrides an existing
-- classification (user edits win).
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
  mapped as (
    select ct.id as txn_id, ct.household_id, jp.entity_id, la.kind,
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
  )
  insert into public.transaction_categories
    (canonical_transaction_id, household_id, category_ledger_account_id, source)
  select m.txn_id, m.household_id, cat.id, 'plaid_pfc'
    from mapped m
    join public.ledger_accounts cat
      on cat.entity_id = m.entity_id and cat.name = m.cat_name
     and cat.is_category = true and cat.kind = m.kind and cat.archived_at is null
  on conflict (canonical_transaction_id) do nothing;
  get diagnostics v_count = row_count;

  if v_count > 0 then
    insert into public.audit_log (household_id, actor, action, object_type, object_id, after)
    values (p_household_id, jsonb_build_object('kind', 'system', 'source', 'plaid_pfc'),
            'transactions.autocategorize', 'household', p_household_id,
            jsonb_build_object('classified', v_count));
  end if;
  return v_count;
end;
$$;

grant execute on function public.keel_autocategorize_household(uuid) to service_role;

-- User-initiated (re)categorization: upsert the overlay, same-entity category.
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
  v_entity     uuid;
  v_new_is_cat boolean;
  v_new_entity uuid;
  v_old        uuid;
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

  select jp.entity_id into v_entity
    from public.canonical_transactions ct
    join public.journal_batches jb
      on jb.canonical_transaction_id = ct.id and jb.reverses_batch_id is null
    join public.journal_postings jp on jp.batch_id = jb.id
    join public.ledger_accounts la on la.id = jp.ledger_account_id and la.is_category = true
    where ct.id = p_txn_id and ct.household_id = p_household_id
    limit 1;
  if v_entity is null then
    raise exception 'KEEL_NOT_FOUND: transaction' using errcode = 'P0006';
  end if;

  select is_category, entity_id into v_new_is_cat, v_new_entity
    from public.ledger_accounts where id = p_category_ledger_account_id;
  if v_new_is_cat is not true or v_new_entity <> v_entity then
    raise exception 'KEEL_INVALID_COMMAND: invalid category' using errcode = 'P0009';
  end if;

  select category_ledger_account_id into v_old
    from public.transaction_categories where canonical_transaction_id = p_txn_id;

  insert into public.transaction_categories
    (canonical_transaction_id, household_id, category_ledger_account_id, source)
  values (p_txn_id, p_household_id, p_category_ledger_account_id, 'user')
  on conflict (canonical_transaction_id) do update
    set category_ledger_account_id = excluded.category_ledger_account_id,
        source = 'user', updated_at = now();

  insert into public.audit_log (household_id, actor, action, object_type, object_id, before, after)
  values (p_household_id, jsonb_build_object('kind', 'user', 'userId', auth.uid()),
          'transaction.categorize', 'canonical_transaction', p_txn_id,
          jsonb_build_object('categoryLedgerAccountId', v_old),
          jsonb_build_object('categoryLedgerAccountId', p_category_ledger_account_id));
end;
$$;

grant execute on function public.keel_categorize_transaction(uuid, uuid, uuid) to authenticated, service_role;
