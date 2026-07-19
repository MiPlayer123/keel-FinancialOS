-- refine(recurring) part 2/2: stop surfacing person-to-person payments and
-- transfers as "recurring", and reap the stale suggestions the previous, noisier
-- runs already produced. Two deterministic, replayable pieces (Law 1: no LLM):
--
--   TASK 1 — READER EXCLUSION (the real fix). keel_recurring_read_txns feeds the
--   detector one row per real-account posting. The detector reads DESCRIPTIONS,
--   so it cannot tell "Austin Y Feng" (a Venmo from a person) or "Electronic
--   Payment" (a card payment) apart from a subscription — those P2P rows carry
--   NO Plaid transfer signal and NO rail keyword. But the CATEGORY overlay now
--   does: 20260719020000 maps Plaid TRANSFER_IN/OUT/LOAN_PAYMENTS to the
--   'transfers'/'transfers_in' categories, and the ambiguous person-name Venmo
--   (Plaid OTHER_OTHER) sit in the 'other_income' catch-all. So we exclude, by
--   EFFECTIVE category (overlay wins over the offset posting — the same overlay
--   the rich read model and keel_txn_is_transfer_category use), any transaction
--   whose effective category pfc_key is one of:
--       'transfers', 'transfers_in'          -- transfers BOTH directions
--                                                (kills Plaid-signalled transfers
--                                                 and credit-card payments)
--       'other_income', 'uncategorized_income' -- the inflow catch-alls where the
--                                                person-name Venmo/Zelle live
--   All four are inflow-only EXCEPT 'transfers' (expense-kind); 'other_income',
--   'uncategorized_income' and 'transfers_in' are income-kind by construction
--   (ledger_accounts.kind = 'income'), so this set is exactly "transfers, both
--   signs" + "unclassified inflow". Genuine payroll is categorized 'income'
--   (kind='income') and is NOT in the set, so it is KEPT. No outflow expense
--   category is touched (subscriptions/bills stay). Verified read-only on the
--   live founder household 2026-07-19: RILLAVOICE/DEEPTUNE payroll are effective
--   'income' (kept); "Austin yang"/"Brianna Wang"/"Zelle payment from …" inflows
--   are effective 'other_income' (dropped); 1046 of 1348 candidate-eligible rows
--   drop, 302 remain (real merchants + payroll). Deterministic — a pure
--   category-key predicate, no name heuristics.
--
--   The exclusion is a NOT EXISTS against a scalar "effective transfer/catch-all
--   category" subquery, mirroring keel_txn_is_transfer_category's overlay-first
--   resolution but widened to the four inflow/transfer keys and applied to the
--   detector INPUT rather than to cash flow. The single-real-account-posting
--   guard and asset|liability kind widening (20260719000000) are preserved
--   verbatim; this only ADDS a where-clause exclusion.
--
--   HONEST SIDE EFFECT: a small number of one-off reimbursements (a few
--   "Wagoo Inc PAY…", "DEEPTUNE INC. BREX REIMB", "RILLAVOICE INC BVC") also sit
--   in 'other_income' and are excluded — but each occurs ONCE, so the detector
--   (>=3 occurrences / regularity gate) would never have produced a series from
--   them anyway; nothing recurring is lost. If a user genuinely receives a
--   RECURRING inflow that Plaid can only classify as OTHER_OTHER (parked in
--   other_income), it would be excluded until they categorize it as 'income';
--   that is the correct suggest->approve behavior (ownership is explicit, never
--   inferred as fact — invariant 4).
--
--   TASK 2 — REAP STALE SUGGESTIONS. keel_recurring_upsert_candidates only
--   UPSERTS the series a run detects; it never RETRACTS a 'suggested' series a
--   later, correct run no longer produces. After Task 1 narrows the input, the
--   old false-positive suggestions (and v1->v2 transition twins) would linger on
--   Review. keel_recurring_reap_stale_suggestions marks every 'suggested' series
--   for the household that was NOT (re)emitted in this run as 'withdrawn' (the
--   status added in 20260719030000), appends a 'withdrawn' status event
--   (append-only timeline preserved) and an audit_log row. It NEVER touches
--   'confirmed' or 'rejected' (or 'paused'/'cancelled') series — only 'suggested'
--   ones absent from this run. Deterministic + idempotent: the command_id is a
--   stable hash of (run_id, series_id), so re-running the same reap is a no-op
--   via ON CONFLICT DO NOTHING, and the status flips only on the first pass.
--   A withdrawn series can be RE-suggested later: the upsert's re-suggestion
--   predicate below gains 'withdrawn' so a future run that detects it again flips
--   it back to 'suggested' and re-points its current candidate.
--
-- No table/column changes → export DTO unaffected (Law 6), pgTAP 008 unchanged.
-- keel_list_recurring also gains a 'withdrawn' filter so a retracted series never
-- reaches the client (the web RecurringSeriesRow union stays suggested|confirmed|
-- paused|cancelled|rejected — no frontend type change needed).
--
-- FILE ONLY — never applied to any remote DB. Validated on a throwaway plain
-- Postgres cluster (initdb, pgtap loaded, migrations replayed) + the pgTAP suite.

-- ---------------------------------------------------------------------------
-- TASK 1: reader exclusion. Body is identical to 20260719000000 (asset|liability
-- widening + single-real-account guard) except the added NOT EXISTS exclusion on
-- the effective category. Same signature → CREATE OR REPLACE; owner/grants
-- re-asserted to match the worker-owned definer contract.
-- ---------------------------------------------------------------------------
create or replace function public.keel_recurring_read_txns(p_household_id uuid) returns jsonb
language sql
security definer
stable
set search_path = public
as $$
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
      and (
        select count(*)
        from public.journal_postings posting_row
        join public.accounts real_account
          on real_account.household_id = transaction_row.household_id
         and real_account.ledger_account_id = posting_row.ledger_account_id
        where posting_row.batch_id = live_batch.id
      ) = 1
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
$$;

-- Ownership/grants must match the original definition (worker-owned definer).
grant create on schema public to keel_worker;
alter function public.keel_recurring_read_txns(uuid) owner to keel_worker;
revoke create on schema public from keel_worker;
revoke all on function public.keel_recurring_read_txns(uuid) from public, anon, authenticated;
grant execute on function public.keel_recurring_read_txns(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- TASK 1 (cont.): a withdrawn series can come back. The upsert only re-points a
-- series' current candidate + re-suggests when its status is in ('suggested',
-- 'rejected'); add 'withdrawn' so a later run that re-detects a previously reaped
-- series flips it back to 'suggested'. Body is byte-identical to 20260712120000
-- except: (a) the re-suggestion predicate gains 'withdrawn', and (b) after a
-- re-detected withdrawn/rejected series is re-pointed, its materialized status is
-- restored to 'suggested' (it was 'withdrawn'/'rejected'; without this the row
-- would keep the old terminal status while pointing at a fresh candidate). Same
-- signature → CREATE OR REPLACE; worker-owned definer, grants re-asserted.
-- ---------------------------------------------------------------------------
create or replace function public.keel_recurring_upsert_candidates(
  p_household_id uuid,
  p_run_key text,
  p_as_of timestamptz,
  p_detector_version text,
  p_confidence_version text,
  p_normalizer_version text,
  p_candidates jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run_id uuid;
  v_candidate jsonb;
  v_series public.recurring_series%rowtype;
  v_candidate_id uuid;
  v_candidate_hash text;
  v_requested_candidate_hash text;
  v_snapshot_hash text := public.keel_payload_hash(p_candidates);
  v_series_key text;
  v_inserted boolean;
  v_result jsonb := '[]'::jsonb;
begin
  if not exists (select 1 from public.households where id = p_household_id) then
    raise exception 'KEEL_SCOPE_VIOLATION: household not found' using errcode = 'P0006';
  end if;
  if jsonb_typeof(p_candidates) <> 'array' then
    raise exception 'KEEL_INVALID_COMMAND: candidates must be an array' using errcode = 'P0009';
  end if;

  insert into public.recurring_detector_runs
    (household_id, run_key, as_of, detector_version, confidence_version, normalizer_version,
     candidate_snapshot_hash)
  values
    (p_household_id, p_run_key, p_as_of, p_detector_version, p_confidence_version,
     p_normalizer_version, v_snapshot_hash)
  on conflict (household_id, run_key) do nothing
  returning id into v_run_id;
  if v_run_id is null then
    select id into v_run_id from public.recurring_detector_runs
     where household_id = p_household_id and run_key = p_run_key
       and as_of = p_as_of and detector_version = p_detector_version
       and confidence_version = p_confidence_version
       and normalizer_version = p_normalizer_version
       and candidate_snapshot_hash = v_snapshot_hash;
    if v_run_id is null then
      raise exception 'KEEL_IDEMPOTENCY_CONFLICT: detector run changed' using errcode = 'P0007';
    end if;
  end if;

  for v_candidate in select value from jsonb_array_elements(p_candidates) loop
    if v_candidate->>'detectorVersion' is distinct from p_detector_version
       or v_candidate->>'confidenceVersion' is distinct from p_confidence_version
       or v_candidate->>'normalizerVersion' is distinct from p_normalizer_version
       or v_candidate->>'asOf' is distinct from to_char(p_as_of at time zone 'utc', 'YYYY-MM-DD')
       or coalesce((v_candidate->>'requiresApproval')::boolean, false) is not true
       or jsonb_typeof(v_candidate->'evidence') <> 'array'
       or jsonb_array_length(v_candidate->'evidence') < 3 then
      raise exception 'KEEL_INVALID_COMMAND: candidate derivation metadata mismatch'
        using errcode = 'P0009';
    end if;
    if exists (
      select 1 from jsonb_array_elements(v_candidate->'evidence') evidence_row
      where jsonb_typeof(evidence_row) <> 'object'
         or not (evidence_row ?& array['txnId','batchId','postingId'])
         or evidence_row->>'txnId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
         or evidence_row->>'batchId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
         or evidence_row->>'postingId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    ) then
      raise exception 'KEEL_INVALID_COMMAND: malformed recurring evidence reference'
        using errcode = 'P0009';
    end if;
    if not exists (
      select 1 from public.accounts account_row
      join public.ledger_accounts ledger_row
        on ledger_row.household_id = account_row.household_id
       and ledger_row.id = account_row.ledger_account_id
       where account_row.household_id = p_household_id
         and account_row.id = (v_candidate->>'accountId')::uuid
         and ledger_row.id = (v_candidate->>'ledgerAccountId')::uuid
         and account_row.currency = v_candidate->>'currency'
    ) then
      raise exception 'KEEL_SCOPE_VIOLATION: candidate account is not in household'
        using errcode = 'P0006';
    end if;

    if exists (
      select 1 from jsonb_array_elements(v_candidate->'evidence') evidence_row
      where not exists (
        select 1
        from public.canonical_transactions transaction_row
        join lateral (
          select batch_row.id
          from public.journal_batches batch_row
          where batch_row.household_id = transaction_row.household_id
            and batch_row.canonical_transaction_id = transaction_row.id
            and batch_row.reverses_batch_id is null
            and not exists (select 1 from public.journal_revisions revision
              where revision.original_batch_id = batch_row.id)
          order by batch_row.posted_at desc, batch_row.id desc
          limit 1
        ) live_batch on live_batch.id = (evidence_row->>'batchId')::uuid
        join public.journal_postings posting_row
          on posting_row.id = (evidence_row->>'postingId')::uuid
         and posting_row.batch_id = live_batch.id
         and posting_row.ledger_account_id = (v_candidate->>'ledgerAccountId')::uuid
        where transaction_row.household_id = p_household_id
          and transaction_row.id = (evidence_row->>'txnId')::uuid
          and transaction_row.account_id = (v_candidate->>'accountId')::uuid
          and transaction_row.status in ('posted','reviewed')
          and transaction_row.voided_at is null
      )
    ) then
      raise exception 'KEEL_SCOPE_VIOLATION: recurring evidence is not a tenant-owned live posting'
        using errcode = 'P0006';
    end if;

    v_series_key := v_candidate->>'seriesKey';
    insert into public.recurring_series
      (household_id, series_key, account_id, ledger_account_id, counterparty_key,
       currency, sign, status)
    values
      (p_household_id, v_series_key, (v_candidate->>'accountId')::uuid,
       (v_candidate->>'ledgerAccountId')::uuid, v_candidate->>'counterpartyKey',
       v_candidate->>'currency', (v_candidate->>'sign')::public.recurring_sign,
       'suggested')
    on conflict (household_id, series_key) do nothing;
    select * into v_series from public.recurring_series
     where household_id = p_household_id and series_key = v_series_key
     for update;
    if not found then
      raise exception 'KEEL_IDEMPOTENCY_CONFLICT: series creation lost'
        using errcode = 'P0007';
    elsif v_series.account_id <> (v_candidate->>'accountId')::uuid
       or v_series.ledger_account_id <> (v_candidate->>'ledgerAccountId')::uuid
       or v_series.currency <> v_candidate->>'currency'
       or v_series.sign <> (v_candidate->>'sign')::public.recurring_sign then
      raise exception 'KEEL_IDEMPOTENCY_CONFLICT: series key changed scope'
        using errcode = 'P0007';
    end if;

    v_requested_candidate_hash := public.keel_payload_hash(v_candidate);
    v_candidate_hash := v_requested_candidate_hash;
    v_candidate_id := null;
    insert into public.recurring_candidate_versions
      (household_id, series_id, detector_run_id, candidate_hash, input_fingerprint,
       detector_version, confidence_version, normalizer_version, as_of, score_bps,
       evidence, candidate)
    values
      (p_household_id, v_series.id, v_run_id, v_requested_candidate_hash,
       v_candidate->>'inputFingerprint', p_detector_version, p_confidence_version,
       p_normalizer_version, p_as_of, (v_candidate->>'scoreBps')::integer,
       v_candidate->'evidence', v_candidate)
    on conflict (household_id, series_id, input_fingerprint) do nothing
    returning id into v_candidate_id;
    v_inserted := v_candidate_id is not null;
    if v_candidate_id is null then
      select id, candidate_hash into v_candidate_id, v_candidate_hash
        from public.recurring_candidate_versions
       where household_id = p_household_id and series_id = v_series.id
         and input_fingerprint = v_candidate->>'inputFingerprint';
      if v_candidate_hash is distinct from v_requested_candidate_hash then
        raise exception 'KEEL_IDEMPOTENCY_CONFLICT: candidate fingerprint changed material result'
          using errcode = 'P0007';
      end if;
    end if;

    if v_inserted then
      -- 20260719031000: 'withdrawn' joins 'suggested'/'rejected' as a status a
      -- fresh detection may re-suggest. A series the reap withdrew (or the user
      -- rejected) that the detector sees again is re-pointed at the new candidate
      -- AND its materialized status is restored to 'suggested' so it reappears on
      -- Review. 'confirmed'/'paused'/'cancelled' keep their locked candidate.
      if v_series.status in ('suggested', 'rejected', 'withdrawn') then
        update public.recurring_series
           set current_candidate_version_id = v_candidate_id,
               status = 'suggested',
               updated_at = now()
         where household_id = p_household_id and id = v_series.id;
      end if;
      insert into public.audit_log
        (household_id, actor, action, object_type, object_id, command_id, before, after)
      values
        (p_household_id, jsonb_build_object('kind','system','processName','recurring-detector'),
         'recurring.suggested', 'recurring_series', v_series.id, gen_random_uuid(), null,
         jsonb_build_object('seriesId', v_series.id, 'candidateVersionId', v_candidate_id,
                            'candidateVersionHash', v_candidate_hash, 'status', v_series.status));
    end if;
    v_result := v_result || jsonb_build_object(
      'seriesId', v_series.id,
      'candidateVersionId', v_candidate_id,
      'candidateVersionHash', v_candidate_hash,
      'inserted', v_inserted,
      'status', v_series.status
    );
  end loop;
  return jsonb_build_object('runId', v_run_id, 'candidates', v_result);
end;
$$;

grant create on schema public to keel_worker;
alter function public.keel_recurring_upsert_candidates(uuid,text,timestamptz,text,text,text,jsonb)
  owner to keel_worker;
revoke create on schema public from keel_worker;
revoke all on function public.keel_recurring_upsert_candidates(uuid,text,timestamptz,text,text,text,jsonb)
  from public, anon, authenticated;
grant execute on function public.keel_recurring_upsert_candidates(uuid,text,timestamptz,text,text,text,jsonb)
  to service_role;

-- keel_api needs UPDATE(status) on recurring_series (it already has it —
-- 20260712120000) for the reap definer; the reap is owned by keel_api and can
-- therefore flip status. It also inserts recurring_status_events (keel_api has
-- insert) and audit_log. Nothing new granted here beyond the reap EXECUTE below.

-- ---------------------------------------------------------------------------
-- TASK 2: reap stale suggestions. keel_api-owned SECURITY DEFINER (like the
-- other reap procs). Given a detector run and the exact set of series the run
-- (re)emitted, mark every OTHER 'suggested' series in the household 'withdrawn'.
-- Idempotent: a deterministic command_id per (run, series) makes the status
-- event insert a no-op on replay, and the status UPDATE only fires while the row
-- is still 'suggested'. Never touches confirmed/rejected/paused/cancelled.
-- Called by the worker AFTER keel_recurring_upsert_candidates, passing the run id
-- it just got back and the emitted series ids.
-- ---------------------------------------------------------------------------
create or replace function public.keel_recurring_reap_stale_suggestions(
  p_household_id uuid,
  p_run_id uuid,
  p_emitted_series_ids uuid[]
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_series record;
  v_candidate_id uuid;
  v_command_id uuid;
  v_reaped integer := 0;
  v_effective_date date := (now() at time zone 'utc')::date;
begin
  if not exists (select 1 from public.households where id = p_household_id) then
    raise exception 'KEEL_SCOPE_VIOLATION: household not found' using errcode = 'P0006';
  end if;
  -- The run must belong to the household (fail closed on a forged/foreign run).
  if not exists (
    select 1 from public.recurring_detector_runs
    where id = p_run_id and household_id = p_household_id
  ) then
    raise exception 'KEEL_SCOPE_VIOLATION: detector run not in household' using errcode = 'P0006';
  end if;

  for v_series in
    select s.id, s.current_candidate_version_id, s.status
    from public.recurring_series s
    where s.household_id = p_household_id
      and s.status = 'suggested'
      and not (s.id = any(coalesce(p_emitted_series_ids, array[]::uuid[])))
  loop
    -- A status event needs a candidate_version_id; use the series' current one.
    -- A 'suggested' series always has one (upsert sets it on insert). Guard
    -- anyway: skip a row with no current candidate rather than violate NOT NULL.
    v_candidate_id := v_series.current_candidate_version_id;
    if v_candidate_id is null then
      continue;
    end if;

    -- Deterministic command_id → idempotent reap. Same (run, series) always
    -- produces the same id, so the unique (household_id, series_id, command_id,
    -- transition) makes the event insert a no-op on replay. md5(...)::uuid is
    -- exactly 32 hex chars (keel_payload_hash returns 64 → not uuid-castable);
    -- a plain deterministic hash of the run+series is all that is needed here.
    v_command_id := md5(
      'recurring-withdraw-stale:' || p_run_id::text || ':' || v_series.id::text
    )::uuid;

    insert into public.recurring_status_events
      (household_id, series_id, candidate_version_id, transition, effective_date,
       actor, command_id)
    values
      (p_household_id, v_series.id, v_candidate_id, 'withdrawn', v_effective_date,
       jsonb_build_object('kind','system','processName','recurring-detector',
                          'reason','stale_suggestion_not_redetected'),
       v_command_id)
    on conflict (household_id, series_id, command_id, transition) do nothing;

    -- Flip the materialized status only while still 'suggested' (idempotent: a
    -- second pass finds it already 'withdrawn' and updates zero rows).
    update public.recurring_series
       set status = 'withdrawn', updated_at = now()
     where household_id = p_household_id and id = v_series.id and status = 'suggested';

    if found then
      v_reaped := v_reaped + 1;
      insert into public.audit_log
        (household_id, actor, action, object_type, object_id, command_id, before, after)
      values
        (p_household_id,
         jsonb_build_object('kind','system','processName','recurring-detector'),
         'recurring.withdrawn', 'recurring_series', v_series.id, v_command_id,
         jsonb_build_object('seriesId', v_series.id, 'status', 'suggested'),
         jsonb_build_object('seriesId', v_series.id, 'status', 'withdrawn',
                            'reason', 'stale_suggestion_not_redetected', 'runId', p_run_id));
    end if;
  end loop;

  return v_reaped;
end;
$$;

grant create on schema public to keel_api;
alter function public.keel_recurring_reap_stale_suggestions(uuid, uuid, uuid[]) owner to keel_api;
revoke create on schema public from keel_api;
revoke all on function public.keel_recurring_reap_stale_suggestions(uuid, uuid, uuid[])
  from public, anon, authenticated;
grant execute on function public.keel_recurring_reap_stale_suggestions(uuid, uuid, uuid[])
  to service_role;

-- ---------------------------------------------------------------------------
-- keel_list_recurring: drop 'withdrawn' series so a retracted suggestion never
-- reaches Review (or the web client's status union). Body byte-identical to
-- 20260712120000 except the added status filter. Same signature → CREATE OR
-- REPLACE; keel_api-owned definer, grants re-asserted.
-- ---------------------------------------------------------------------------
create or replace function public.keel_list_recurring(p_household_id uuid) returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_rows jsonb;
  v_uid uuid := coalesce(
    nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
    nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid;
begin
  if v_uid is null then
    raise exception 'KEEL_NOT_AUTHENTICATED' using errcode = 'P0004';
  end if;
  if not exists (select 1 from public.household_memberships
    where household_id = p_household_id and user_id = v_uid) then
    raise exception 'KEEL_SCOPE_VIOLATION' using errcode = 'P0006';
  end if;
  select coalesce(jsonb_agg(row.dto order by row.series_key), '[]'::jsonb) into v_rows
  from (
    select series_row.series_key,
      jsonb_build_object(
        'seriesKey', series_row.series_key,
        'counterpartyKey', series_row.counterparty_key,
        'accountId', series_row.account_id,
        'ledgerAccountId', series_row.ledger_account_id,
        'currency', series_row.currency::text,
        'sign', series_row.sign,
        'cadence', candidate_row.candidate->>'cadence',
        'cadenceAnchor', candidate_row.candidate->'cadenceAnchor',
        'amountKind', candidate_row.candidate->>'amountKind',
        'representativeAmountMinor', candidate_row.candidate->'representativeAmountMinor',
        'amountSummary', candidate_row.candidate->'amountSummary',
        'lastSeen', candidate_row.candidate->>'lastSeen',
        'occurrenceCount', candidate_row.candidate->'occurrenceCount',
        'coverage', candidate_row.candidate->'coverage',
        'residualDays', candidate_row.candidate->'residualDays',
        'scoreBps', candidate_row.score_bps,
        'evidence', candidate_row.evidence,
        'inputFingerprint', candidate_row.input_fingerprint,
        'detectorVersion', candidate_row.detector_version,
        'confidenceVersion', candidate_row.confidence_version,
        'normalizerVersion', candidate_row.normalizer_version,
        'asOf', to_char(candidate_row.as_of at time zone 'utc', 'YYYY-MM-DD'),
        'requiresApproval', true,
        'seriesId', series_row.id,
        'status', series_row.status,
        'candidateVersionId', candidate_row.id,
        'candidateVersionHash', candidate_row.candidate_hash,
        'statusEvents', coalesce((
          select jsonb_agg(jsonb_build_object(
            'transition', status_event.transition,
            'effectiveDate', to_char(status_event.effective_date, 'YYYY-MM-DD'),
            'commandId', status_event.command_id,
            'actorId', status_event.actor->>'userId',
            'createdAt', to_char(status_event.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
          ) order by status_event.effective_date, status_event.created_at, status_event.command_id)
          from public.recurring_status_events status_event
          where status_event.household_id = series_row.household_id
            and status_event.series_id = series_row.id
        ), '[]'::jsonb),
        'occurrences', coalesce((
          select jsonb_agg(jsonb_build_object(
            'occurrenceId', occurrence.id,
            'occurrenceKey', occurrence.occurrence_key,
            'expectedDate', to_char(occurrence.expected_date, 'YYYY-MM-DD'),
            'expectedAmountMinor', occurrence.expected_amount_minor::text,
            'currency', occurrence.currency::text,
            'amountKind', occurrence.amount_kind,
            'status', case coalesce((
              select lifecycle.transition::text
              from public.recurring_status_events lifecycle
              where lifecycle.household_id = occurrence.household_id
                and lifecycle.series_id = occurrence.series_id
                and lifecycle.effective_date <= occurrence.expected_date
              order by lifecycle.effective_date desc, lifecycle.created_at desc, lifecycle.command_id desc
              limit 1
            ), 'suggested')
              when 'paused' then 'paused'
              when 'cancelled' then 'cancelled'
              when 'rejected' then 'cancelled'
              when 'withdrawn' then 'cancelled'
              when 'suggested' then 'cancelled'
              else occurrence.status::text
            end,
            'matchedTxnId', occurrence.matched_txn_id,
            'scoreBps', occurrence.score_bps,
            'evidence', occurrence.evidence,
            'inputFingerprint', occurrence.input_fingerprint,
            'detectorVersion', occurrence.detector_version,
            'confidenceVersion', occurrence.confidence_version,
            'asOf', to_char(occurrence.as_of at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
          ) order by occurrence.expected_date, occurrence.id)
          from public.recurring_occurrences occurrence
          where occurrence.household_id = series_row.household_id
            and occurrence.series_id = series_row.id
            and occurrence.candidate_version_id = series_row.current_candidate_version_id
        ), '[]'::jsonb)
      ) as dto
    from public.recurring_series series_row
    join public.recurring_candidate_versions candidate_row
      on candidate_row.household_id = series_row.household_id
     and candidate_row.id = series_row.current_candidate_version_id
    where series_row.household_id = p_household_id
      -- 20260719031000: a withdrawn (reaped stale) suggestion is never shown.
      and series_row.status <> 'withdrawn'
      and public.keel_recurring_account_access(p_household_id, series_row.account_id, false)
  ) row;
  return jsonb_build_object(
    'scope', jsonb_build_object('householdId', p_household_id),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'formulaVersion', 'recurring-grid-v1',
    'rows', v_rows
  );
end;
$$;

grant create on schema public to keel_api;
alter function public.keel_list_recurring(uuid) owner to keel_api;
revoke create on schema public from keel_api;
revoke all on function public.keel_list_recurring(uuid) from public, anon;
grant execute on function public.keel_list_recurring(uuid) to authenticated;

-- Ownership sanity: no recurring SECURITY DEFINER left postgres-owned, and the
-- runtime definers stay unprivileged (mirrors 20260712120000's tail check).
do $$
begin
  if exists (
    select 1 from pg_proc proc
    join pg_namespace namespace on namespace.oid = proc.pronamespace
    join pg_roles owner_role on owner_role.oid = proc.proowner
    where namespace.nspname = 'public' and proc.proname like 'keel%recurring%'
      and proc.prosecdef and owner_role.rolname not in ('keel_api','keel_worker')
  ) then
    raise exception 'KEEL_OWNERSHIP: recurring definer has unexpected owner';
  end if;
end
$$;
