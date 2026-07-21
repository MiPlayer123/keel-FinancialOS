-- ###########################################################################
-- ##  REVIEW BEFORE APPLYING — data migration on the LIVE ledger.          ##
-- ##                                                                       ##
-- ##  This migration REPROCESSES existing investment canonical            ##
-- ##  transactions: it VOIDS core sweeps and RE-OFFSETS buys/sells/       ##
-- ##  dividends/fees onto the new investment ledger accounts. It writes    ##
-- ##  compensating REVERSAL + corrected batches (Law 2) and NEVER          ##
-- ##  UPDATEs/DELETEs prior postings. It is idempotent (a second run is a  ##
-- ##  no-op once every row already points at its correct offset), but it   ##
-- ##  is deliberately NOT auto-applied — a human applies it manually after ##
-- ##  reviewing, per the F-013 flow-classifier plan.                       ##
-- ##                                                                       ##
-- ##  It depends on 20260721060000 (the classifier migration) having been  ##
-- ##  applied first: it needs the per-entity investments / investment_     ##
-- ##  income / investment_fees ledger accounts and the recreated ingest    ##
-- ##  proc's routing rules.                                                ##
-- ###########################################################################
--
-- Scope: canonical_transactions with source='sync' and economic_event_key like
-- 'inv:%' (the investment-ingest economic-key prefix), for ALL households.
--
-- For each such canonical, we recompute the CORRECT offset ledger account by
-- its stored Plaid flow (recovered from the source raw-event body's 'flow'
-- field) and whether it is a core sweep, then:
--
--   * core sweep (flow buy/sell with a cash-equivalent security, OR the
--     description names the CORE ACCOUNT)  -> VOID (reverse live batch +
--     voided_at + un-confirm any transfer links it caused).
--   * buy / sell         -> re-offset to `investments` (asset)   if not already.
--   * dividend_interest  -> re-offset to `investment_income`     if not already.
--   * fee                -> re-offset to `investment_fees`       if not already.
--   * anything else      -> leave as-is (uncategorized is still correct).
--
-- "Re-offset" = reverse the live batch + post a corrected batch whose account
-- leg is unchanged and whose OFFSET leg is the new ledger account + a
-- journal_revisions row (identical machinery to the ingest proc's restatement).
--
-- Idempotency: a canonical whose live-batch offset posting ALREADY targets the
-- desired ledger account (and which is not a to-be-voided sweep) is skipped, so
-- re-running changes nothing.

do $$
declare
  r record;
  v_household uuid;
  v_entity uuid;
  v_account_ledger uuid;
  v_live_batch uuid;
  v_live_effective date;
  v_flow text;
  v_is_cash_equiv boolean;
  v_is_core_sweep boolean;
  v_desired_key text;
  v_desired_offset uuid;
  v_current_offset uuid;
  v_amount bigint;
  v_currency text;
  v_reversal uuid;
  v_batch uuid;
  v_command uuid;
  v_voided int := 0;
  v_reoffset int := 0;
  v_skipped int := 0;
begin
  for r in
    select ct.id as txn_id, ct.household_id, ct.entity_id, ct.account_id,
           ct.description, ct.effective_date, ct.voided_at
      from public.canonical_transactions ct
     where ct.source = 'sync'
       and ct.economic_event_key like 'inv:%'
     order by ct.id
  loop
    v_household := r.household_id;

    -- The account's own ledger account (the leg that must stay unchanged).
    select a.ledger_account_id, a.entity_id into v_account_ledger, v_entity
      from public.accounts a where a.id = r.account_id;
    if v_account_ledger is null then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    -- Recover the Plaid flow + cash-equivalent flag from the most recent source
    -- raw-event body for this canonical. Older rows may lack isCashEquivalent
    -- (defaults false); the CORE ACCOUNT description heuristic still catches
    -- description-labelled sweeps.
    select rpe.body->>'flow',
           coalesce((rpe.body->>'isCashEquivalent')::boolean, false)
      into v_flow, v_is_cash_equiv
      from public.transaction_source_links tsl
      join public.normalized_source_records nsr
        on nsr.id = tsl.normalized_source_record_id
      join public.raw_provider_events rpe
        on rpe.id = nsr.raw_event_id
     where tsl.canonical_transaction_id = r.txn_id
     order by rpe.received_at desc nulls last
     limit 1;

    v_is_core_sweep :=
      (coalesce(v_flow, '') in ('buy', 'sell') and coalesce(v_is_cash_equiv, false))
      or coalesce(r.description, '') ilike '%CORE ACCOUNT%';

    -- The live batch to correct (newest non-reversal, not already reversed).
    select b.id, b.effective_date into v_live_batch, v_live_effective
      from public.journal_batches b
     where b.canonical_transaction_id = r.txn_id
       and b.reverses_batch_id is null
       and not exists (
         select 1 from public.journal_revisions rev where rev.original_batch_id = b.id)
     order by b.posted_at desc
     limit 1;

    -- ---- CORE SWEEP: void (if not already voided). --------------------------
    if v_is_core_sweep then
      if r.voided_at is not null then
        v_skipped := v_skipped + 1;
        continue;  -- already suppressed
      end if;
      if v_live_batch is null then
        -- No live batch (already reversed some other way) but not voided: just
        -- stamp the header. Rare; keeps the register clean.
        update public.canonical_transactions
           set status = 'voided', voided_at = now() where id = r.txn_id;
      else
        v_command := gen_random_uuid();
        insert into public.journal_batches
          (household_id, canonical_transaction_id, description, effective_date,
           reverses_batch_id, command_id)
        values
          (v_household, r.txn_id, 'REVERSAL: investment core-sweep backfill suppression',
           v_live_effective, v_live_batch, v_command)
        returning id into v_reversal;

        insert into public.journal_postings
          (batch_id, ledger_account_id, entity_id, amount_minor, currency)
        select v_reversal, p.ledger_account_id, p.entity_id, -p.amount_minor, p.currency
          from public.journal_postings p where p.batch_id = v_live_batch;

        insert into public.journal_revisions
          (original_batch_id, reversal_batch_id, replacement_batch_id, reason)
        values (v_live_batch, v_reversal, null, 'investment core-sweep backfill suppression');

        update public.canonical_transactions
           set status = 'voided', voided_at = now() where id = r.txn_id;
      end if;

      -- Clear any transfer links this sweep participated in (the phantom
      -- "self-transfer" — actually the sweep leg paired against another leg on
      -- the same account, before the pinned detector's same-account guard).
      -- transfer_links is a DERIVED SUGGESTION table (re-derivable by
      -- keel_detect_transfers), not canonical financial truth, and its CHECK
      -- forbids setting a system-suggested link (decided_by null) to 'rejected'
      -- without a decider — so the correct, schema-honest clear is to remove the
      -- link rows referencing a now-voided sweep. The real economic legs are
      -- untouched; the detector will re-evaluate the remaining rows cleanly.
      delete from public.transfer_links
       where household_id = v_household
         and (txn_out = r.txn_id or txn_in = r.txn_id);

      v_voided := v_voided + 1;
      continue;
    end if;

    -- ---- Non-sweep: determine the desired offset by flow. -------------------
    v_desired_key := case
      when coalesce(v_flow, '') in ('buy', 'sell') then 'investments'
      when v_flow = 'dividend_interest' then 'investment_income'
      when v_flow = 'fee' then 'investment_fees'
      else null  -- deposit/withdrawal/transfer/other: leave uncategorized
    end;

    if v_desired_key is null then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    select la.id into v_desired_offset
      from public.ledger_accounts la
     where la.entity_id = v_entity and la.pfc_key = v_desired_key
       and la.archived_at is null;
    if v_desired_offset is null then
      -- The classifier migration should have seeded it; skip rather than break.
      v_skipped := v_skipped + 1;
      continue;
    end if;

    if v_live_batch is null then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    -- Current offset posting = the live-batch posting that is NOT the account
    -- ledger leg. Grab its amount/currency to rebuild the corrected batch.
    select p.ledger_account_id, p.amount_minor, p.currency
      into v_current_offset, v_amount, v_currency
      from public.journal_postings p
     where p.batch_id = v_live_batch
       and p.ledger_account_id <> v_account_ledger
     order by p.id
     limit 1;

    -- Already correct? -> idempotent skip.
    if v_current_offset is not distinct from v_desired_offset then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    -- The account-leg amount (mirror of the offset amount).
    -- offset amount = -(account amount), so account amount = -(offset amount).
    v_command := gen_random_uuid();

    -- Reversal of the live batch.
    insert into public.journal_batches
      (household_id, canonical_transaction_id, description, effective_date,
       reverses_batch_id, command_id)
    values
      (v_household, r.txn_id, 'REVERSAL: investment offset backfill',
       v_live_effective, v_live_batch, v_command)
    returning id into v_reversal;

    insert into public.journal_postings
      (batch_id, ledger_account_id, entity_id, amount_minor, currency)
    select v_reversal, p.ledger_account_id, p.entity_id, -p.amount_minor, p.currency
      from public.journal_postings p where p.batch_id = v_live_batch;

    -- Corrected batch: same account leg, new offset leg.
    insert into public.journal_batches
      (household_id, canonical_transaction_id, description, effective_date, command_id)
    values
      (v_household, r.txn_id, left(coalesce(r.description, ''), 500),
       r.effective_date, v_command)
    returning id into v_batch;

    perform public.keel_insert_postings(v_household, v_batch, jsonb_build_array(
      jsonb_build_object(
        'ledger_account_id', v_account_ledger,
        'amount_minor', (-v_amount)::text,
        'currency', v_currency),
      jsonb_build_object(
        'ledger_account_id', v_desired_offset,
        'amount_minor', v_amount::text,
        'currency', v_currency)
    ));

    insert into public.journal_revisions
      (original_batch_id, reversal_batch_id, replacement_batch_id, reason)
    values (v_live_batch, v_reversal, v_batch, 'investment offset backfill');

    v_reoffset := v_reoffset + 1;
  end loop;

  raise notice 'investment flow backfill: voided=% re-offset=% skipped=%',
    v_voided, v_reoffset, v_skipped;
end $$;
