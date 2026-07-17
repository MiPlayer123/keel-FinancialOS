-- Ledger reconciled status (teardown D-047, build-queue item 7 — "Statements
-- moat"): surface per-transaction reconciliation status ON THE LEDGER, not
-- only on the Statements page. KEEL already links a canonical_transaction to
-- a matched bank-statement line via reconciliation_items.transaction_id
-- (resolution = 'matched_transaction'), written exactly once, only inside
-- keel_reconciliation_close (20260712150000 §"reconciliation_items"). That
-- table carries keel_forbid_mutation (no UPDATE/DELETE grant — Law 2 append-
-- only audit), so "this transaction has a matched_transaction item row" is a
-- permanent, reproducible fact (Law 9 reproducible numbers) even if the
-- owning statement's reconciliation session is later reopened for a
-- correction (period_locks.reopened_at) — reopening unlocks the PERIOD for
-- new corrective entries, it does not retract the historical match. Read
-- model change is additive only: one new boolean column in the existing
-- keel_list_transactions_rich SELECT list. No new table, no new command —
-- reconciliation itself still only happens via the Statements page's
-- existing keel_reconciliation_close flow (unchanged here).

-- ---------------------------------------------------------------------------
-- 1. Index: reconciliation_items has a FK to canonical_transactions
-- (fk_item_txn_tenant) but Postgres never auto-indexes the referencing side
-- of a FK, and the table's only indexes are its PK (household_id, id) and
-- the (household_id, session_id, statement_line_id) uniqueness constraint —
-- neither helps a lookup by transaction_id. Without this, the new EXISTS
-- check below would seq-scan reconciliation_items once per ledger row on
-- every /dashboard/ledger load — the exact class of finding that forced
-- 20260717170000's pfc_primary denormalization (37s scan → statement
-- timeout). Partial + household-scoped: only matched_transaction rows ever
-- carry a transaction_id, so the predicate keeps the index small.
-- ---------------------------------------------------------------------------
create index if not exists reconciliation_items_household_txn
  on public.reconciliation_items (household_id, transaction_id)
  where transaction_id is not null;

-- ---------------------------------------------------------------------------
-- 2. keel_list_transactions_rich: full recreate of the CURRENT body
-- (20260717200000, the P0-B follow-ups migration — categorySource +
-- tags/counterparty/splits-aware shape), with ONE new field, 'reconciled'.
-- Review r3604380927 caught the original version of this migration
-- recreating the function from the much OLDER 20260712200200 shape instead
-- — that would have dropped display overrides/original description/note/
-- source, categoryPfcKey, split aggregation, tags, transfer/counterparty
-- fields, and the live-batch + voided_at filters for every consumer of
-- transactions.rich. Renumbered 20260717200000 -> 20260717210000 at
-- convergence (timestamp collision with the P0-B migration, which merged
-- first and correctly claimed that slot). A transaction may in principle be
-- matched from more than one statement line (household == household of the
-- transaction row; correlated EXISTS keeps that a single boolean rather
-- than fanning the ledger row out). create-or-replace preserves the
-- function's existing grants (execute to authenticated, service_role).
-- ---------------------------------------------------------------------------
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
        'categorySource', case when offs.n > 1 then 'user' else tc.source end,
        'splits', case when offs.n > 1 then offs.splits end,
        'tags', tgs.tags,
        'transferStatus', tl.status,
        'counterpartyAccountId', case when tl.status = 'confirmed' then cp.account_id end,
        'counterpartyAccountName', case when tl.status = 'confirmed' then cp.account_name end,
        'counterpartyTransactionId', case when tl.status = 'confirmed' then cp.txn_id end,
        -- Reconciled (D-047): permanent once a closed reconciliation session
        -- matched this transaction to a statement line. See header comment.
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
