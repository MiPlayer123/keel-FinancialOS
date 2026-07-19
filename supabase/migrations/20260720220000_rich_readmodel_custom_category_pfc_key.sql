-- 20260720220000_rich_readmodel_custom_category_pfc_key.sql
-- Fix: keel_list_transactions_rich reported categoryPfcKey from the posting
-- offset even when a custom-category overlay (pfc_key IS NULL) was present,
-- making custom-categorized transactions read as "uncategorized" on the Review
-- page (isUncategorized checks pfc_key first). Root cause: coalesce(catov.pfc_key,
-- offs.one_pfc_key) leaks the underlying key when catov.pfc_key is null.
-- Idempotent CREATE OR REPLACE; no data change; category name/id/kind and the
-- no-overlay path are unchanged.

create or replace function public.keel_list_transactions_rich(p_household_id uuid)
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

  select coalesce(jsonb_agg(row order by row->>'effectiveDate' desc, row->>'transactionId'), '[]'::jsonb)
    into v_rows
    from (
      select jsonb_build_object(
        'transactionId', ct.id,
        'effectiveDate', ct.effective_date,
        'description', left(coalesce(tov.display_description, rr.display_name, ct.description), 140),
        'originalDescription', left(ct.description, 140),
        'note', tov.note,
        'status', ct.status,
        'source', ct.source,
        'accountId', acc.id,
        'accountName', acc.name,
        -- Account last-4 (teardown C6/D-050): masked suffix for disambiguating
        -- multiple accounts at the same institution. Null until the owning
        -- connection's accounts have gone through a link/resync that captured
        -- Plaid's `mask` field — the UI must hide the suffix, never guess it,
        -- when this is null (Law 8/9). Preserved from 20260717220000.
        'accountMask', acc.mask,
        'amountMinor', cashp.amount_minor::text,
        'currency', cashp.currency,
        'categoryLedgerAccountId',
          case when offs.n = 1 then coalesce(catov.id, offs.one_id) end,
        'categoryName',
          case when offs.n = 1 then coalesce(catov.name, offs.one_name) else 'Split' end,
        'categoryKind',
          case when offs.n = 1 then coalesce(catov.kind::text, offs.one_kind) end,
        'categoryPfcKey',
          -- FIX (20260720220000): a user-created custom category has pfc_key=null.
          -- The old coalesce fell through to the ORIGINAL posting offset's key,
          -- so a txn overlaid to a custom category leaked 'uncategorized_*' and
          -- read as uncategorized despite a real category NAME. Resolve pfc_key
          -- from the SAME source as name/id/kind: the overlay when one exists.
          case when offs.n = 1 then
            case when catov.id is not null then catov.pfc_key else offs.one_pfc_key end
          end,
        -- categorySource (019): explicit-ownership signal (Law 9). Splits are
        -- reviewed by construction ('user'); otherwise the overlay's source.
        -- Preserved from 20260717200000/20260717220000.
        'categorySource', case when offs.n > 1 then 'user' else tc.source end,
        'splits', case when offs.n > 1 then offs.splits end,
        'tags', tgs.tags,
        'transferStatus', tl.status,
        -- Link id + booked flag drive the sidebar's Undo affordance (F-012).
        'transferLinkId', tl.id,
        'transferBooked', tl.booked_txn is not null,
        'counterpartyAccountId', case when tl.status = 'confirmed' then cp.account_id end,
        'counterpartyAccountName', case when tl.status = 'confirmed' then cp.account_name end,
        'counterpartyTransactionId', case when tl.status = 'confirmed' then cp.txn_id end,
        -- Reconciled (D-047): permanent once a closed reconciliation session
        -- matched this transaction to a statement line. Preserved from
        -- 20260717210000/20260717220000.
        'reconciled', exists (
          select 1 from public.reconciliation_items ri
           where ri.household_id = ct.household_id
             and ri.transaction_id = ct.id
             and ri.resolution = 'matched_transaction'
        )
      ) as row
      from public.canonical_transactions ct
      join public.journal_batches jb
        on jb.canonical_transaction_id = ct.id and jb.reverses_batch_id is null
       and not exists (
         select 1 from public.journal_revisions rev where rev.original_batch_id = jb.id
       )
      join public.journal_postings cashp on cashp.batch_id = jb.id
      join public.ledger_accounts cashla
        on cashla.id = cashp.ledger_account_id and cashla.is_category = false
      join public.accounts acc on acc.ledger_account_id = cashla.id
      cross join lateral (
        select count(*)::int as n,
               min(oc.id::text)::uuid as one_id,
               min(oc.name)           as one_name,
               min(oc.kind::text)     as one_kind,
               min(oc.pfc_key)        as one_pfc_key,
               jsonb_agg(jsonb_build_object(
                 'categoryLedgerAccountId', oc.id,
                 'name', oc.name,
                 'kind', oc.kind,
                 'amountMinor', op.amount_minor::text
               ) order by op.amount_minor desc, op.id) as splits
          from public.journal_postings op
          join public.ledger_accounts oc on oc.id = op.ledger_account_id and oc.is_category = true
         where op.batch_id = jb.id
      ) offs
      cross join lateral (
        select coalesce(jsonb_agg(jsonb_build_object('tagId', tg.id, 'name', tg.name)
                 order by tg.name), '[]'::jsonb) as tags
          from public.transaction_tags tt
          join public.tags tg on tg.id = tt.tag_id
         where tt.canonical_transaction_id = ct.id
      ) tgs
      left join public.transaction_categories tc on tc.canonical_transaction_id = ct.id
      left join public.ledger_accounts catov on catov.id = tc.category_ledger_account_id
      left join public.transaction_overrides tov on tov.canonical_transaction_id = ct.id
      left join public.rule_renames rr on rr.canonical_transaction_id = ct.id
      left join public.transfer_links tl
        on (tl.txn_out = ct.id or tl.txn_in = ct.id)
       and tl.status in ('suggested', 'confirmed')
      left join lateral (
        select cpacc.id as account_id, cpacc.name as account_name, cpct.id as txn_id
          from public.canonical_transactions cpct
          join public.journal_batches cpjb
            on cpjb.canonical_transaction_id = cpct.id and cpjb.reverses_batch_id is null
           and not exists (
             select 1 from public.journal_revisions rev where rev.original_batch_id = cpjb.id
           )
          join public.journal_postings cpp on cpp.batch_id = cpjb.id
          join public.ledger_accounts cpla
            on cpla.id = cpp.ledger_account_id and cpla.is_category = false
          join public.accounts cpacc on cpacc.ledger_account_id = cpla.id
         where cpct.id = case when tl.txn_out = ct.id then tl.txn_in else tl.txn_out end
         limit 1
      ) cp on tl.status = 'confirmed'
      where ct.household_id = p_household_id
        and ct.voided_at is null
        and offs.n >= 1
    ) t;

  return jsonb_build_object(
    'scope', jsonb_build_object('householdId', p_household_id),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'rows', v_rows
  );
end;
$$;

revoke all on function public.keel_list_transactions_rich(uuid) from public, anon;
grant execute on function public.keel_list_transactions_rich(uuid) to authenticated, service_role;
