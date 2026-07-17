-- Fix (self-caught during S-transfer-recurring build, before the
-- recurring-transfer grouping in apps/web/src/lib/transfer-grouping.ts
-- shipped): keel_list_transfers returned outAccountName/inAccountName but
-- never the underlying account ids. Grouping suggested transfer pairs into
-- a "recurring transfer" card by NAME alone is unsafe -- two different
-- accounts (a personal "Savings" and a business "Savings", say) can share
-- a display name, which would silently merge two unrelated transfer
-- relationships into one group and let "Confirm all" batch-approve a pair
-- that doesn't belong. Adds outAccountId/inAccountId so the frontend can
-- group by the real, unambiguous key.
create or replace function public.keel_list_transfers(p_household_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_uid uuid := coalesce(
    nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
    nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid;
  v_rows jsonb;
begin
  if v_uid is null then
    raise exception 'KEEL_NOT_AUTHENTICATED' using errcode = 'P0004';
  end if;
  if not exists (
    select 1 from public.household_memberships m
     where m.household_id = p_household_id and m.user_id = v_uid
  ) then
    raise exception 'KEEL_SCOPE_VIOLATION' using errcode = 'P0006';
  end if;

  with cash as (
    select ct.id as txn_id,
           left(coalesce(tov.display_description, ct.description), 140) as description,
           ct.effective_date, acc.id as account_id, acc.name as account_name,
           p.amount_minor, p.currency
      from public.canonical_transactions ct
      join public.journal_batches jb
        on jb.canonical_transaction_id = ct.id and jb.reverses_batch_id is null
       and not exists (
         select 1 from public.journal_revisions rev where rev.original_batch_id = jb.id
       )
      join public.journal_postings p on p.batch_id = jb.id
      join public.ledger_accounts la
        on la.id = p.ledger_account_id and la.is_category = false
      join public.accounts acc on acc.ledger_account_id = la.id
      left join public.transaction_overrides tov on tov.canonical_transaction_id = ct.id
      where ct.household_id = p_household_id
  )
  select coalesce(jsonb_agg(row order by row->>'status' desc, row->>'effectiveDate' desc, row->>'linkId'), '[]'::jsonb)
    into v_rows
    from (
      select jsonb_build_object(
        'linkId', tl.id,
        'status', tl.status,
        'effectiveDate', o.effective_date,
        'amountMinor', abs(o.amount_minor)::text,
        'currency', o.currency,
        'outTxnId', o.txn_id,
        'outDescription', o.description,
        'outAccountId', o.account_id,
        'outAccountName', o.account_name,
        'inTxnId', i.txn_id,
        'inDescription', i.description,
        'inAccountId', i.account_id,
        'inAccountName', i.account_name,
        'dayGap', abs(i.effective_date - o.effective_date)
      ) as row
      from public.transfer_links tl
      join cash o on o.txn_id = tl.txn_out
      join cash i on i.txn_id = tl.txn_in
      where tl.household_id = p_household_id
        and tl.status in ('suggested', 'confirmed')
    ) t;

  return jsonb_build_object(
    'scope', jsonb_build_object('householdId', p_household_id),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'formulaVersion', 'transfer-links-v1',
    'rows', v_rows
  );
end;
$$;

revoke all on function public.keel_list_transfers(uuid) from public, anon;
grant execute on function public.keel_list_transfers(uuid) to authenticated, service_role;
