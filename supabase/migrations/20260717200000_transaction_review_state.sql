-- P0-B follow-ups (design/TEARDOWN-STATUS-2026-07-17.md queue items 2/3,
-- the residuals left after the categorization review loop shipped in
-- 20260717160000): reviewed/unreviewed transaction state + the visible
-- "Auto" badge it powers. Both read off a primitive that ALREADY EXISTS —
-- transaction_categories.source ('user' | 'rule' | 'plaid_pfc', set since
-- 20260712200100 / 20260713040000) — so this migration adds NO new table,
-- NO new column, and NO new command. It is pure read-model plumbing
-- (Law 1 n/a — no arithmetic): keel_list_transactions_rich gains one
-- additive field, categorySource, so the web client can derive "has a human
-- looked at this?" without a second query per row.
--
-- Full recreate of the tags+counterparty-aware body (20260713220000), the
-- most recent definition — same house pattern every prior redefinition of
-- this function has used. Only the 'categorySource' field is new.
--
-- Semantics (Law 9 explicit ownership — inference is never silently treated
-- as fact):
--   * single-offset transaction with an overlay row -> tc.source verbatim
--     ('user' a human decision; 'rule'/'plaid_pfc' machine-filed, unreviewed).
--   * single-offset transaction with NO overlay row -> null. Nothing has
--     ever been assigned (still on the Uncategorized landing pad per the
--     20260712200100 comment) — distinct from "auto-assigned"; there is
--     nothing to badge.
--   * multi-split transaction -> 'user'. A split carries no overlay row at
--     all (20260717190000 deletes it on re-split to >1 category), but a
--     split can only exist because a user built it through the audited
--     transactions.set_splits command — reviewed by construction, not by
--     overlay source. See apps/web/src/lib/review-state.ts for the client
--     derivation this field feeds (isAutoCategorized / isReviewedCategory).
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
        'amountMinor', cashp.amount_minor::text,
        'currency', cashp.currency,
        'categoryLedgerAccountId',
          case when offs.n = 1 then coalesce(catov.id, offs.one_id) end,
        'categoryName',
          case when offs.n = 1 then coalesce(catov.name, offs.one_name) else 'Split' end,
        'categoryKind',
          case when offs.n = 1 then coalesce(catov.kind::text, offs.one_kind) end,
        'categoryPfcKey',
          case when offs.n = 1 then coalesce(catov.pfc_key, offs.one_pfc_key) end,
        -- New field (P0-B follow-up): see the header comment for the
        -- three-way semantics.
        'categorySource', case when offs.n > 1 then 'user' else tc.source end,
        'splits', case when offs.n > 1 then offs.splits end,
        'tags', tgs.tags,
        'transferStatus', tl.status,
        -- Only a CONFIRMED pairing is a settled fact worth surfacing outside
        -- the Review page; 'suggested' stays silent until approved.
        'counterpartyAccountId', case when tl.status = 'confirmed' then cp.account_id end,
        'counterpartyAccountName', case when tl.status = 'confirmed' then cp.account_name end,
        'counterpartyTransactionId', case when tl.status = 'confirmed' then cp.txn_id end
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
      -- Counterparty leg's cash account, via whichever side of transfer_links
      -- isn't this row's own transaction (txn_out/txn_in each reference
      -- canonical_transactions.id directly — see 20260710210700). Same
      -- live-batch filter as this row's own cash posting: a superseded sync
      -- revision must not surface a stale counterparty account.
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
