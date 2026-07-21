-- F-013 part 3/4 — Investment Flow Classifier.
-- Spec: docs/superpowers/specs/2026-07-21-investment-flow-classifier-design.md
--
-- keel_worker_ingest_investment_txn (20260718121000) offsets EVERY investment
-- cash-flow to uncategorized_expense / uncategorized_income by SIGN, ignoring
-- the already-computed p_flow. Consequences on the live Fidelity item: buys
-- look like spending, deposits/dividends look like income, and the SPAXX core
-- money-market sweep double-counts (both the real EFT/transfer AND its paired
-- "PURCHASE INTO / REDEMPTION FROM CORE ACCOUNT" sweep are booked, phantom-
-- swinging the per-line running balance and mis-detecting as a same-account
-- self-transfer).
--
-- This migration routes the offset BY FLOW and SUPPRESSES core sweeps:
--
--   flow / condition                       offset target            cash-flow?
--   buy / sell (security NOT cash-equiv)   investments  (asset)     excluded
--   dividend_interest                      investment_income (inc)  income ✓
--   fee                                    investment_fees   (exp)  expense ✓
--   deposit/withdrawal/transfer_in/out     uncategorized (unchanged) excluded once paired
--   core sweep (cash-equiv buy/sell,       SUPPRESSED — no canonical  n/a
--     OR description ILIKE '%CORE ACCOUNT%')
--
-- The lever: keel_cash_flow_monthly (20260713030000) sums only kind in
-- ('income','expense'), so an offset to the non-category `investments` ASSET
-- account is automatically excluded from spend/income while keeping postings
-- balanced (cash ↓, Investments asset ↑) and net worth correct.
--
-- Sections:
--   1. Seed investments / investment_income / investment_fees per entity
--      (extends keel_seed_entity_categories + backfills existing entities).
--   2. Recreate keel_worker_ingest_investment_txn with p_is_cash_equivalent,
--      flow-routed offset, core-sweep suppression + void-on-restatement.
--   3. Recreate keel_detect_transfers with an explicit same-account guard.
--
-- Laws honored: Σ postings = 0 (Law 3); BIGINT minor units (Law 4); void not
-- delete (soft-delete directive); idempotent economics reusing the existing
-- hash/economic_event_key restatement machinery (Law 9).

-- ===========================================================================
-- 1. Seed the three investment ledger accounts per entity.
--
-- Modelled on keel_seed_entity_categories (20260718140000). `investments` is an
-- ASSET with is_category=false (so it never counts in cash_flow — it is the
-- trade offset, cash converting to a held position). `investment_income` /
-- `investment_fees` ARE categories (they SHOULD show in cash-flow as income /
-- expense). All three carry stable pfc_keys so the ingest proc resolves them by
-- key (rename-proof), exactly like the uncategorized landing pads.
-- ===========================================================================
create or replace function public.keel_seed_investment_accounts(
  p_entity_id uuid,
  p_household_id uuid
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Fail closed on a forged pairing (house style).
  if not exists (
    select 1 from public.entities e
    where e.id = p_entity_id and e.household_id = p_household_id
  ) then
    raise exception 'KEEL_SCOPE_VIOLATION: entity not in household' using errcode = 'P0006';
  end if;

  insert into public.ledger_accounts
    (household_id, entity_id, name, kind, currency, is_category, pfc_key, is_system)
  select p_household_id, p_entity_id, d.name, d.kind::public.ledger_account_kind,
         'USD', d.is_category, d.pfc_key, true
  from (values
    ('Investments',        'asset',   false, 'investments'),
    ('Investment Income',  'income',  true,  'investment_income'),
    ('Investment Fees',    'expense', true,  'investment_fees')
  ) as d(name, kind, is_category, pfc_key)
  -- Dedupe by pfc_key with NO archived_at filter (matches the parent seed): a
  -- renamed/archived seeded account must not be re-inserted or resurrected.
  where not exists (
    select 1 from public.ledger_accounts la
    where la.entity_id = p_entity_id and la.pfc_key = d.pfc_key
  )
  -- A live case-insensitive NAME collision (user already made "Investments")
  -- would trip ledger_accounts_category_name_ci — skip rather than error so the
  -- backfill re-run stays safe. Note: the ci index only covers is_category=true,
  -- so this guard is load-bearing only for the two category rows, but applying
  -- it uniformly keeps the seed re-run idempotent.
  and not exists (
    select 1 from public.ledger_accounts la
    where la.entity_id = p_entity_id and la.is_category = true
      and la.archived_at is null and lower(la.name) = lower(d.name)
  );
end;
$$;

revoke all on function public.keel_seed_investment_accounts(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.keel_seed_investment_accounts(uuid, uuid) to service_role;

-- Extend the per-entity seed trigger path: future entities get these too. Wrap
-- the existing keel_seed_entity_categories (do NOT re-inline its 60-row body):
-- call it, then the investment accounts. keel_seed_entity_categories is
-- create-or-replace elsewhere; a later migration replacing it will NOT drop
-- this call because it is a SEPARATE proc invoked from the trigger wrapper.
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

  perform public.keel_seed_entity_categories(new.id, new.household_id);
  perform public.keel_seed_investment_accounts(new.id, new.household_id);
  return new;
end;
$$;

-- Trigger definition unchanged; re-assert it points at the (replaced) function.
drop trigger if exists trg_entity_default_categories on public.entities;
create trigger trg_entity_default_categories
  after insert on public.entities
  for each row execute function public.keel_seed_entity_default_categories();

-- Backfill every existing non-fixture entity (idempotent; the seed dedupes by
-- pfc_key). Fixture entities keep their deterministic sets for the suites.
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
    perform public.keel_seed_investment_accounts(r.id, r.household_id);
  end loop;
end $$;

-- ===========================================================================
-- 2. Recreate keel_worker_ingest_investment_txn.
--
-- Adds trailing p_is_cash_equivalent boolean default false. Resolves the offset
-- ledger account per the routing table. Suppresses core sweeps (return null on
-- fresh; VOID on restatement). All existing idempotency / restatement / raw-
-- event-versioning / command-dedupe machinery is preserved verbatim; only the
-- offset resolution and the two suppression branches are new.
-- ===========================================================================
-- Adding a DEFAULT-valued param creates a SEPARATE 10-arg function, leaving the
-- old 9-arg one in place — an ambiguous overload for 9-positional-arg callers.
-- Drop the old signature first so exactly one function answers the call.
drop function if exists public.keel_worker_ingest_investment_txn(
  uuid, uuid, text, text, bigint, text, date, text, text);

create or replace function public.keel_worker_ingest_investment_txn(
  p_household_id uuid,
  p_connection_id uuid,
  p_account_external_ref text,
  p_provider_transaction_id text,
  p_amount_minor bigint,
  p_currency text,
  p_effective_date date,
  p_description text,
  p_flow text,
  p_is_cash_equivalent boolean default false
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_conn public.connections%rowtype;
  v_account public.accounts%rowtype;
  v_raw_id uuid;
  v_provider_event_id text := 'inv-txn:' || p_provider_transaction_id;
  v_economic_key text;
  v_hash text;
  v_apply_key text;
  v_offset_id uuid;
  v_offset_key text;
  v_is_core_sweep boolean;
  v_txn_id uuid;
  v_batch_id uuid;
  v_nsr_id uuid;
  v_prev_batch_id uuid;
  v_prev_effective date;
  v_reversal_id uuid;
  v_command_id uuid := gen_random_uuid();
  v_actor jsonb := jsonb_build_object('kind', 'system', 'processName', 'sync-worker');
  v_existing_cmd public.command_executions%rowtype;
begin
  select * into v_conn
    from public.connections
   where id = p_connection_id and household_id = p_household_id;
  if not found then
    raise exception 'KEEL_NOT_FOUND: connection' using errcode = 'P0006';
  end if;

  if p_amount_minor is null or p_amount_minor = 0 then
    raise exception 'KEEL_INVALID_COMMAND: investment amount must be non-zero'
      using errcode = 'P0009';
  end if;
  if coalesce(p_currency, '') <> 'USD' then
    raise exception 'KEEL_INVALID_COMMAND: only USD investment transactions supported'
      using errcode = 'P0009';
  end if;

  -- Resolve the target account within THIS connection. Unknown ref = skip (null).
  select * into v_account
    from public.accounts
   where connection_id = p_connection_id
     and household_id = p_household_id
     and external_ref = p_account_external_ref;
  if not found then
    return null;
  end if;

  -- CORE SWEEP detection. The account's own core money-market (SPAXX) IS the
  -- account cash, so a buy/sell of it double-counts the paired real EFT/transfer
  -- that is ingested separately. Two signals: (a) the security is a cash-
  -- equivalent on a buy/sell, or (b) the description names the core account.
  v_is_core_sweep :=
    (p_flow in ('buy', 'sell') and coalesce(p_is_cash_equivalent, false))
    or coalesce(p_description, '') ilike '%CORE ACCOUNT%';

  v_economic_key := 'inv:' || v_conn.external_ref || ':' || p_provider_transaction_id;
  v_hash := public.keel_payload_hash(jsonb_build_object(
    'econ', v_economic_key, 'amt', p_amount_minor::text, 'date', p_effective_date));
  v_apply_key := 'inv-ingest:' || p_provider_transaction_id || ':' || v_hash;

  -- Command-level idempotency, versioned by hash: an IDENTICAL replay short-
  -- circuits. For a suppressed sweep the canonical does not exist, so this
  -- returns null (the recorded command's economic effect was "skipped").
  select * into v_existing_cmd
    from public.command_executions
   where household_id = p_household_id and economic_event_key = v_apply_key;
  if found then
    select id into v_txn_id
      from public.canonical_transactions
     where household_id = p_household_id and economic_event_key = v_economic_key;
    return v_txn_id;  -- null when this event was suppressed as a core sweep
  end if;

  -- Does the canonical already exist? Needed BEFORE the suppression branch so a
  -- row that FLIPS to a core sweep on restatement is VOIDED, not left stale.
  select id into v_txn_id
    from public.canonical_transactions
   where household_id = p_household_id and economic_event_key = v_economic_key;

  -- ---- CORE SWEEP: suppress. ------------------------------------------------
  if v_is_core_sweep then
    -- Record the source version + normalized record (source preservation, Law 9)
    -- so the suppression is auditable and idempotent, but create NO canonical.
    select id into v_raw_id
      from public.raw_provider_events
     where connection_id = p_connection_id
       and provider = v_conn.provider
       and provider_event_id = v_provider_event_id || ':' || v_hash;
    if v_raw_id is null then
      insert into public.raw_provider_events
        (household_id, connection_id, provider, provider_event_id,
         account_external_ref, body, received_at)
      values
        (p_household_id, p_connection_id, v_conn.provider,
         v_provider_event_id || ':' || v_hash,
         p_account_external_ref,
         jsonb_build_object(
           'source', 'investments_transactions_get',
           'providerTransactionId', p_provider_transaction_id,
           'amountMinor', p_amount_minor::text,
           'currency', p_currency,
           'date', p_effective_date,
           'flow', p_flow,
           'isCashEquivalent', coalesce(p_is_cash_equivalent, false),
           'suppressed', 'core_sweep',
           'description', left(coalesce(p_description, ''), 500)),
         now())
      returning id into v_raw_id;
    end if;

    -- If a prior (non-sweep) canonical exists for this economic event and this
    -- restatement makes it a sweep, VOID it: reverse the live batch and stamp
    -- voided_at. Never leave a stale offset row.
    if v_txn_id is not null then
      select b.id, b.effective_date into v_prev_batch_id, v_prev_effective
        from public.journal_batches b
       where b.canonical_transaction_id = v_txn_id
         and b.reverses_batch_id is null
         and not exists (
           select 1 from public.journal_revisions r where r.original_batch_id = b.id)
       order by b.posted_at desc
       limit 1;

      if v_prev_batch_id is not null then
        insert into public.journal_batches
          (household_id, canonical_transaction_id, description, effective_date,
           reverses_batch_id, command_id)
        values
          (p_household_id, v_txn_id, 'REVERSAL: investment core-sweep suppression',
           v_prev_effective, v_prev_batch_id, v_command_id)
        returning id into v_reversal_id;

        insert into public.journal_postings
          (batch_id, ledger_account_id, entity_id, amount_minor, currency)
        select v_reversal_id, p.ledger_account_id, p.entity_id, -p.amount_minor, p.currency
          from public.journal_postings p where p.batch_id = v_prev_batch_id;

        -- Mark the reversed batch as revised with no replacement (a void).
        insert into public.journal_revisions
          (original_batch_id, reversal_batch_id, replacement_batch_id, reason)
        values (v_prev_batch_id, v_reversal_id, null, 'investment core-sweep suppression');

        update public.canonical_transactions
           set status = 'voided', voided_at = now()
         where id = v_txn_id;
      end if;
    end if;

    perform public.keel_finish_command(
      v_command_id, 'ingest.investment_txn', v_apply_key, p_household_id,
      v_actor, v_hash, 'ingest.transaction_suppressed', 'canonical_transaction',
      coalesce(v_txn_id, v_command_id),
      jsonb_build_object('economicKey', v_economic_key, 'flow', p_flow,
                         'suppressed', 'core_sweep'),
      jsonb_build_object('suppressed', true, 'reason', 'core_sweep',
                         'voidedCanonicalTransactionId', v_txn_id));

    return null;
  end if;

  -- ---- Not a sweep: resolve the flow-routed offset ledger account. ----------
  -- buy/sell -> investments (asset, excluded from cash-flow)
  -- dividend_interest -> investment_income (income category)
  -- fee -> investment_fees (expense category)
  -- everything else (deposit/withdrawal/transfer_in/out/other) -> uncategorized,
  --   left for keel_detect_transfers to pair against the real counterparty.
  v_offset_key := case
    when p_flow in ('buy', 'sell') then 'investments'
    when p_flow = 'dividend_interest' then 'investment_income'
    when p_flow = 'fee' then 'investment_fees'
    else case when p_amount_minor < 0 then 'uncategorized_expense'
              else 'uncategorized_income' end
  end;

  select la.id into v_offset_id
    from public.ledger_accounts la
   where la.entity_id = v_account.entity_id
     and la.pfc_key = v_offset_key
     and la.archived_at is null;
  -- Fall back to the sign-based uncategorized offset if a flow-specific account
  -- is somehow missing (e.g. archived): keep ingestion working rather than
  -- bricking sync — the deterministic default keeps postings balanced.
  if v_offset_id is null then
    select la.id into v_offset_id
      from public.ledger_accounts la
     where la.entity_id = v_account.entity_id
       and la.pfc_key = case when p_amount_minor < 0 then 'uncategorized_expense'
                             else 'uncategorized_income' end
       and la.archived_at is null;
  end if;
  if v_offset_id is null then
    raise exception 'KEEL_INVALID_COMMAND: offset category missing' using errcode = 'P0009';
  end if;

  -- Layer (a): source preservation. Record a raw event VERSION.
  select id into v_raw_id
    from public.raw_provider_events
   where connection_id = p_connection_id
     and provider = v_conn.provider
     and provider_event_id = v_provider_event_id || ':' || v_hash;
  if v_raw_id is null then
    insert into public.raw_provider_events
      (household_id, connection_id, provider, provider_event_id,
       account_external_ref, body, received_at)
    values
      (p_household_id, p_connection_id, v_conn.provider,
       v_provider_event_id || ':' || v_hash,
       p_account_external_ref,
       jsonb_build_object(
         'source', 'investments_transactions_get',
         'providerTransactionId', p_provider_transaction_id,
         'amountMinor', p_amount_minor::text,
         'currency', p_currency,
         'date', p_effective_date,
         'flow', p_flow,
         'isCashEquivalent', coalesce(p_is_cash_equivalent, false),
         'description', left(coalesce(p_description, ''), 500)),
       now())
    returning id into v_raw_id;
  end if;

  insert into public.normalized_source_records
    (raw_event_id, household_id, account_id, provider_transaction_id, kind,
     amount_minor, currency, effective_date, description, pending)
  values
    (v_raw_id, p_household_id, v_account.id, p_provider_transaction_id, 'added',
     p_amount_minor, p_currency, p_effective_date, left(coalesce(p_description, ''), 500), false)
  returning id into v_nsr_id;

  if v_txn_id is not null then
    -- Restatement: reverse the live batch + post a corrected replacement.
    select b.id, b.effective_date into v_prev_batch_id, v_prev_effective
      from public.journal_batches b
     where b.canonical_transaction_id = v_txn_id
       and b.reverses_batch_id is null
       and not exists (
         select 1 from public.journal_revisions r where r.original_batch_id = b.id)
     order by b.posted_at desc
     limit 1;

    if v_prev_batch_id is null then
      raise exception 'KEEL_IMMUTABLE: no live batch to correct for txn %', v_txn_id
        using errcode = 'P0001';
    end if;

    insert into public.journal_batches
      (household_id, canonical_transaction_id, description, effective_date,
       reverses_batch_id, command_id)
    values
      (p_household_id, v_txn_id, 'REVERSAL: investment restatement',
       v_prev_effective, v_prev_batch_id, v_command_id)
    returning id into v_reversal_id;

    insert into public.journal_postings
      (batch_id, ledger_account_id, entity_id, amount_minor, currency)
    select v_reversal_id, p.ledger_account_id, p.entity_id, -p.amount_minor, p.currency
      from public.journal_postings p where p.batch_id = v_prev_batch_id;

    insert into public.journal_batches
      (household_id, canonical_transaction_id, description, effective_date, command_id)
    values
      (p_household_id, v_txn_id, left(coalesce(p_description, ''), 500),
       p_effective_date, v_command_id)
    returning id into v_batch_id;

    perform public.keel_insert_postings(p_household_id, v_batch_id, jsonb_build_array(
      jsonb_build_object(
        'ledger_account_id', v_account.ledger_account_id,
        'amount_minor', p_amount_minor::text,
        'currency', p_currency),
      jsonb_build_object(
        'ledger_account_id', v_offset_id,
        'amount_minor', (-p_amount_minor)::text,
        'currency', p_currency)
    ));

    insert into public.journal_revisions
      (original_batch_id, reversal_batch_id, replacement_batch_id, reason)
    values (v_prev_batch_id, v_reversal_id, v_batch_id, 'investment restatement');

    insert into public.transaction_source_links
      (canonical_transaction_id, normalized_source_record_id)
    values (v_txn_id, v_nsr_id);

    -- Un-void if a prior sweep-suppression voided this canonical and the event
    -- has now flipped back to a real economic one.
    update public.canonical_transactions
       set description = left(coalesce(p_description, ''), 500),
           effective_date = p_effective_date,
           status = 'posted',
           voided_at = null
     where id = v_txn_id;

    perform public.keel_finish_command(
      v_command_id, 'ingest.investment_txn', v_apply_key, p_household_id,
      v_actor, v_hash, 'ingest.transaction_revised', 'canonical_transaction',
      v_txn_id, jsonb_build_object('economicKey', v_economic_key, 'flow', p_flow),
      jsonb_build_object('canonicalTransactionId', v_txn_id, 'restated', true,
        'reversalBatchId', v_reversal_id, 'replacementBatchId', v_batch_id));

    return v_txn_id;
  end if;

  -- Fresh create.
  insert into public.canonical_transactions
    (household_id, entity_id, account_id, status, source, description,
     effective_date, economic_event_key)
  values
    (p_household_id, v_account.entity_id, v_account.id, 'posted', 'sync',
     left(coalesce(p_description, ''), 500), p_effective_date, v_economic_key)
  returning id into v_txn_id;

  insert into public.transaction_source_links
    (canonical_transaction_id, normalized_source_record_id)
  values (v_txn_id, v_nsr_id);

  insert into public.journal_batches
    (household_id, canonical_transaction_id, description, effective_date, command_id)
  values
    (p_household_id, v_txn_id, left(coalesce(p_description, ''), 500),
     p_effective_date, v_command_id)
  returning id into v_batch_id;

  perform public.keel_insert_postings(p_household_id, v_batch_id, jsonb_build_array(
    jsonb_build_object(
      'ledger_account_id', v_account.ledger_account_id,
      'amount_minor', p_amount_minor::text,
      'currency', p_currency),
    jsonb_build_object(
      'ledger_account_id', v_offset_id,
      'amount_minor', (-p_amount_minor)::text,
      'currency', p_currency)
  ));

  perform public.keel_finish_command(
    v_command_id, 'ingest.investment_txn', v_apply_key, p_household_id,
    v_actor, v_hash, 'ingest.transaction_created', 'canonical_transaction',
    v_txn_id, jsonb_build_object('economicKey', v_economic_key, 'flow', p_flow),
    jsonb_build_object('canonicalTransactionId', v_txn_id, 'idempotentReplay', false));

  return v_txn_id;
end;
$$;

-- Grants: the old 9-arg signature was dropped above; grant the new 10-arg one to
-- service_role only (public/anon/authenticated stripped), matching the original.
revoke all on function public.keel_worker_ingest_investment_txn(
  uuid, uuid, text, text, bigint, text, date, text, text, boolean)
  from public, anon, authenticated;
grant execute on function public.keel_worker_ingest_investment_txn(
  uuid, uuid, text, text, bigint, text, date, text, text, boolean)
  to service_role;

-- ===========================================================================
-- 3. keel_detect_transfers: explicit same-account guard on every tier.
--
-- Restated verbatim from the live definition (20260721010000 distribution pin).
-- That pin already pins each cash row to ct.account_id, and each tier already
-- joins with `i.account_id <> o.account_id`, so two legs of the SAME account can
-- never pair. This recreate keeps that identical body and adds a comment
-- affirming the guard (the spec calls it out explicitly as a required change,
-- and the core-sweep self-transfer symptom this feature fixes depended on it).
-- No behavioral change vs 20260721010000 — it is a guard-affirming restatement,
-- later-timestamped so a fresh replay lands it after every prior recreate.
-- ===========================================================================
create or replace function public.keel_detect_transfers(p_household_id uuid)
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_exact int;
  v_near  int;
  v_card  int;
  v_total int;
begin
  if auth.uid() is not null and not exists (
    select 1 from public.household_memberships
    where household_id = p_household_id and user_id = auth.uid()
  ) then
    raise exception 'KEEL_NOT_FOUND' using errcode = 'P0006';
  end if;

  -- ---------------------------------------------------------------------------
  -- Tier 1: exact opposite amounts, <=3-day gap. SAME-ACCOUNT GUARD:
  -- i.account_id <> o.account_id (a leg can never pair with itself or with
  -- another leg on the same account — this is what kills the core-sweep
  -- "Transfer -> / <- Cash Management within one account" false positive).
  -- ---------------------------------------------------------------------------
  with cash as (
    select ct.id as txn_id, ct.effective_date, acc.id as account_id,
           p.amount_minor, p.currency
      from public.canonical_transactions ct
      join public.journal_batches jb
        on jb.canonical_transaction_id = ct.id and jb.reverses_batch_id is null
       and not exists (
         select 1 from public.journal_revisions rev where rev.original_batch_id = jb.id
       )
      join public.accounts acc on acc.id = ct.account_id
      join public.journal_postings p
        on p.batch_id = jb.id and p.ledger_account_id = acc.ledger_account_id
      where ct.household_id = p_household_id
        and ct.voided_at is null
        and p.amount_minor <> 0
        and p.amount_minor <> -9223372036854775808
  ),
  linked as (
    select txn_out as txn from public.transfer_links
      where household_id = p_household_id and status in ('suggested', 'confirmed')
    union
    select txn_in from public.transfer_links
      where household_id = p_household_id and status in ('suggested', 'confirmed')
  ),
  pairs as (
    select o.txn_id as txn_out, i.txn_id as txn_in,
           abs(i.effective_date - o.effective_date) as day_gap
      from cash o
      join cash i
        on i.currency = o.currency
       and i.amount_minor = -o.amount_minor
       and i.account_id <> o.account_id
       and abs(i.effective_date - o.effective_date) <= 3
      where o.amount_minor < 0
        and not exists (select 1 from linked l where l.txn = o.txn_id)
        and not exists (select 1 from linked l where l.txn = i.txn_id)
        and not exists (
          select 1 from public.transfer_links tl
          where tl.txn_out = o.txn_id and tl.txn_in = i.txn_id
        )
  ),
  best_out as (
    select txn_out, txn_in, day_gap,
           row_number() over (partition by txn_out order by day_gap, txn_in) as rn
      from pairs
  ),
  uniq as (
    select txn_out, txn_in,
           row_number() over (partition by txn_in order by day_gap, txn_out) as rn_in
      from best_out where rn = 1
  )
  insert into public.transfer_links (household_id, txn_out, txn_in, status)
  select p_household_id, txn_out, txn_in, 'suggested'
    from uniq where rn_in = 1
  on conflict (txn_out, txn_in) do nothing;
  get diagnostics v_exact = row_count;

  -- ---------------------------------------------------------------------------
  -- Tier 2 near-miss: opposite magnitudes differing by
  -- 0 < delta <= least(100, floor(0.01*larger)), <=4-day gap.
  -- SAME-ACCOUNT GUARD: i.account_id <> o.account_id.
  -- ---------------------------------------------------------------------------
  with cash as (
    select ct.id as txn_id, ct.effective_date, acc.id as account_id,
           p.amount_minor, p.currency
      from public.canonical_transactions ct
      join public.journal_batches jb
        on jb.canonical_transaction_id = ct.id and jb.reverses_batch_id is null
       and not exists (
         select 1 from public.journal_revisions rev where rev.original_batch_id = jb.id
       )
      join public.accounts acc on acc.id = ct.account_id
      join public.journal_postings p
        on p.batch_id = jb.id and p.ledger_account_id = acc.ledger_account_id
      where ct.household_id = p_household_id
        and ct.voided_at is null
        and p.amount_minor <> 0
        and p.amount_minor <> -9223372036854775808
  ),
  linked as (
    select txn_out as txn from public.transfer_links
      where household_id = p_household_id and status in ('suggested', 'confirmed')
    union
    select txn_in from public.transfer_links
      where household_id = p_household_id and status in ('suggested', 'confirmed')
  ),
  pairs as (
    select o.txn_id as txn_out, i.txn_id as txn_in,
           abs(i.effective_date - o.effective_date) as day_gap,
           abs(abs(i.amount_minor) - abs(o.amount_minor)) as amount_diff
      from cash o
      join cash i
        on i.currency = o.currency
       and i.account_id <> o.account_id
       and abs(i.effective_date - o.effective_date) <= 4
      where o.amount_minor < 0
        and i.amount_minor > 0
        and abs(i.amount_minor) <> abs(o.amount_minor)
        and abs(abs(i.amount_minor) - abs(o.amount_minor))
              <= least(100::bigint,
                       greatest(abs(o.amount_minor), abs(i.amount_minor)) / 100)
        and not exists (select 1 from linked l where l.txn = o.txn_id)
        and not exists (select 1 from linked l where l.txn = i.txn_id)
        and not exists (
          select 1 from public.transfer_links tl
          where tl.txn_out = o.txn_id and tl.txn_in = i.txn_id
        )
  ),
  best_out as (
    select txn_out, txn_in, amount_diff, day_gap,
           row_number() over (
             partition by txn_out order by amount_diff, day_gap, txn_in) as rn
      from pairs
  ),
  uniq as (
    select txn_out, txn_in,
           row_number() over (
             partition by txn_in order by amount_diff, day_gap, txn_out) as rn_in
      from best_out where rn = 1
  )
  insert into public.transfer_links (household_id, txn_out, txn_in, status)
  select p_household_id, txn_out, txn_in, 'suggested'
    from uniq where rn_in = 1
  on conflict (txn_out, txn_in) do nothing;
  get diagnostics v_near = row_count;

  -- ---------------------------------------------------------------------------
  -- Tier 3 card-payment: EXACT opposite amounts, DEPOSITORY outflow <->
  -- CREDIT-CARD inflow, <=7-day gap. SAME-ACCOUNT GUARD:
  -- i.account_id <> o.account_id.
  -- ---------------------------------------------------------------------------
  with cash as (
    select ct.id as txn_id, ct.effective_date, acc.id as account_id,
           acc.subtype, p.amount_minor, p.currency
      from public.canonical_transactions ct
      join public.journal_batches jb
        on jb.canonical_transaction_id = ct.id and jb.reverses_batch_id is null
       and not exists (
         select 1 from public.journal_revisions rev where rev.original_batch_id = jb.id
       )
      join public.accounts acc on acc.id = ct.account_id
      join public.journal_postings p
        on p.batch_id = jb.id and p.ledger_account_id = acc.ledger_account_id
      where ct.household_id = p_household_id
        and ct.voided_at is null
        and p.amount_minor <> 0
        and p.amount_minor <> -9223372036854775808
  ),
  linked as (
    select txn_out as txn from public.transfer_links
      where household_id = p_household_id and status in ('suggested', 'confirmed')
    union
    select txn_in from public.transfer_links
      where household_id = p_household_id and status in ('suggested', 'confirmed')
  ),
  pairs as (
    select o.txn_id as txn_out, i.txn_id as txn_in,
           abs(i.effective_date - o.effective_date) as day_gap
      from cash o
      join cash i
        on i.currency = o.currency
       and i.amount_minor = -o.amount_minor
       and i.account_id <> o.account_id
       and abs(i.effective_date - o.effective_date) <= 7
      where o.amount_minor < 0                             -- depository outflow
        and o.subtype in ('checking', 'cash management')
        and i.amount_minor > 0                             -- credit-card inflow
        and i.subtype in ('credit card', 'credit_card')
        and not exists (select 1 from linked l where l.txn = o.txn_id)
        and not exists (select 1 from linked l where l.txn = i.txn_id)
        and not exists (
          select 1 from public.transfer_links tl
          where tl.txn_out = o.txn_id and tl.txn_in = i.txn_id
        )
  ),
  best_out as (
    select txn_out, txn_in, day_gap,
           row_number() over (partition by txn_out order by day_gap, txn_in) as rn
      from pairs
  ),
  uniq as (
    select txn_out, txn_in,
           row_number() over (partition by txn_in order by day_gap, txn_out) as rn_in
      from best_out where rn = 1
  )
  insert into public.transfer_links (household_id, txn_out, txn_in, status)
  select p_household_id, txn_out, txn_in, 'suggested'
    from uniq where rn_in = 1
  on conflict (txn_out, txn_in) do nothing;
  get diagnostics v_card = row_count;

  v_total := v_exact + v_near + v_card;

  if v_total > 0 then
    insert into public.audit_log (household_id, actor, action, object_type, object_id, after)
    values (p_household_id,
            case when auth.uid() is null
                 then jsonb_build_object('kind', 'system', 'source', 'transfer_detector')
                 else jsonb_build_object('kind', 'user', 'userId', auth.uid()) end,
            'transfers.detect', 'household', p_household_id,
            jsonb_build_object('suggested', v_total));
  end if;
  return v_total;
end;
$function$;

revoke all on function public.keel_detect_transfers(uuid) from public, anon;
grant execute on function public.keel_detect_transfers(uuid) to authenticated, service_role;
