-- 20260721030000_recurring_include_distributions.sql
--
-- Distribution follow-up (Codex review Finding 6). keel_recurring_read_txns
-- required EXACTLY ONE real-account posting per batch, which excluded every
-- distribution (a paycheck + its 401k transfer leg = two real postings) from
-- recurring detection — defeating auto-detection of the very paychecks the
-- feature enables. The asset_posting is already pinned to the transaction's own
-- (header) account, so each transaction still yields exactly one detection row;
-- the guard only needs to confirm the header posting exists. Relaxed `= 1` to
-- `>= 1`. Pre-distribution transactions (always one real posting) are unchanged.
--
-- Restated verbatim from the live definition with that single guard relaxed.

CREATE OR REPLACE FUNCTION public.keel_recurring_read_txns(p_household_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(jsonb_agg(row.dto order by row.effective_date, row.txn_id), '[]'::jsonb)
  from (
    select transaction_row.id as txn_id,
      transaction_row.effective_date,
      jsonb_build_object(
        'txnId', transaction_row.id,
        'batchId', live_batch.id,
        'postingId', asset_posting.id,
        'accountId', account_row.id,
        'ledgerAccountId', asset_posting.ledger_account_id,
        'effectiveDate', to_char(transaction_row.effective_date, 'YYYY-MM-DD'),
        'amountMinor', asset_posting.amount_minor::text,
        'currency', asset_posting.currency::text,
        'description', transaction_row.description
      ) as dto
    from public.canonical_transactions transaction_row
    join public.accounts account_row
      on account_row.household_id = transaction_row.household_id
     and account_row.id = transaction_row.account_id
    join lateral (
      select batch_row.*
      from public.journal_batches batch_row
      where batch_row.household_id = transaction_row.household_id
        and batch_row.canonical_transaction_id = transaction_row.id
        and batch_row.reverses_batch_id is null
        and not exists (
          select 1 from public.journal_revisions revision
           where revision.original_batch_id = batch_row.id
        )
      order by batch_row.posted_at desc, batch_row.id desc
      limit 1
    ) live_batch on true
    join public.journal_postings asset_posting
      on asset_posting.batch_id = live_batch.id
     and asset_posting.ledger_account_id = account_row.ledger_account_id
    join public.ledger_accounts asset_ledger
      on asset_ledger.household_id = transaction_row.household_id
     and asset_ledger.id = asset_posting.ledger_account_id
     -- Real-account posting for a bank account is an 'asset' ledger; for a
     -- credit card it is a 'liability' ledger. Both feed detection (card-billed
     -- subscriptions live on liability accounts) — 20260719000000.
     and asset_ledger.kind in ('asset', 'liability')
    where transaction_row.household_id = p_household_id
      and transaction_row.status in ('posted', 'reviewed')
      and transaction_row.voided_at is null
      -- Distribution-aware (Codex Finding 6): the asset_posting above is already
      -- pinned to the transaction's OWN account (one row per txn), so a
      -- distribution's extra transfer legs must NOT exclude it from recurring
      -- detection. Require at least one real-account posting (the header) — the
      -- prior `= 1` silently dropped every distribution (e.g. paycheck+401k).
      and (
        select count(*)
        from public.journal_postings posting_row
        join public.accounts real_account
          on real_account.household_id = transaction_row.household_id
         and real_account.ledger_account_id = posting_row.ledger_account_id
        where posting_row.batch_id = live_batch.id
      ) >= 1
      -- 20260719031000: exclude transfers (both directions) and unclassified
      -- inflows from recurring detection. The person-name Venmo / Zelle / card
      -- payments the detector cannot recognize from the description ARE
      -- recognizable by their EFFECTIVE category (overlay wins over the offset
      -- posting, exactly as keel_txn_is_transfer_category / the rich read model
      -- resolve it). Keeping this as a NOT EXISTS scalar keeps the single-offset
      -- guard above untouched; a split transaction (multiple offset categories)
      -- is never whole-transfer, so limit 1 on the single offset is correct.
      and not exists (
        select 1
        from (
          select case
                   when tc.canonical_transaction_id is not null then curla.pfc_key
                   else offcat.pfc_key
                 end as eff_pfc
          from public.journal_postings offp
          join public.ledger_accounts offcat
            on offcat.id = offp.ledger_account_id and offcat.is_category = true
          left join public.transaction_categories tc
            on tc.canonical_transaction_id = transaction_row.id
          left join public.ledger_accounts curla
            on curla.id = tc.category_ledger_account_id
          where offp.batch_id = live_batch.id
          limit 1
        ) eff
        where eff.eff_pfc in ('transfers', 'transfers_in', 'other_income', 'uncategorized_income')
      )
    order by transaction_row.effective_date desc, transaction_row.id desc
    limit 10000
  ) row;
$function$
