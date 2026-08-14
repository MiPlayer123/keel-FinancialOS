-- Plaid-primary recurring detection, Phase 2: turn mirrored streams into KEEL
-- recurring series.
--
-- Phase 1 (20260814100000) only stored what Plaid detects. This migration maps
-- a stream onto the EXISTING recurring spine so every downstream surface —
-- the Recurring page, confirm/pause/cancel/restore, occurrence projection,
-- schedule links — works unchanged. A Plaid-sourced series is an ordinary
-- `recurring_series` row whose current candidate carries
-- `detector_version = 'plaid-streams-v1'`; `keel_list_recurring` already
-- returns `detectorVersion`, so provenance reaches the UI with no read-model
-- change.
--
-- WHY NOT reuse keel_recurring_upsert_candidates: that proc requires every
-- evidence row to be a live tenant-owned POSTING (txnId/batchId/postingId).
-- Plaid's streams reference Plaid transaction ids, and after the 2026-08-13
-- relink most of those resolve to canonical transactions that were voided by
-- reconnect dedupe (the surviving copy lives on the archived account). Live
-- check on the real household: all 61 stream transaction ids resolve to
-- `normalized_source_records`, but only 4 to live canonical transactions. The
-- honest evidence for a provider-detected series is the PROVIDER's own record,
-- so these candidates cite {streamId, providerTransactionId, date} — Law 9
-- explicit ownership: provider inference is labelled as provider inference,
-- never silently promoted to a KEEL posting-backed claim.
--
-- Dates and amounts still come from OUR source-of-record
-- (`normalized_source_records`, immutable per Law 9 source preservation), not
-- from Plaid's summary fields, so the cadence anchor is derived from what
-- actually happened in this household.
--
-- Law 10 risk class B unchanged: a Plaid series lands as `suggested` and
-- requires approval exactly like ours. Nothing here books money.

-- ===========================================================================
-- 1. Counterparty normalization, mirroring packages/detectors/src/normalize.ts
-- (`normalizeCounterparty`, NORMALIZER_VERSION counterparty-v2) so a Plaid
-- stream and a KEEL-detected series produce the SAME key for the same
-- merchant — that equality is what the duplicate guard below relies on.
-- PostgreSQL ARE uses \y for the word boundary that JS spells \b.
-- ===========================================================================
create or replace function public.keel_normalize_counterparty(p_text text)
returns text
language sql
immutable
set search_path = pg_catalog
as $$
  select coalesce(nullif(
    regexp_replace(
      btrim(
        regexp_replace(
          regexp_replace(
            regexp_replace(
              regexp_replace(lower(coalesce(p_text, '')), '\y\d{4}-\d{2}-\d{2}\y', ' ', 'g'),
              '\y(store|shop)\s*#?\s*\d+\y', ' ', 'g'),
            '(\s|#)\d+\s*$', ' ', 'g'),
          '[^a-z0-9]+', ' ', 'g')
      ), '\s+', ' ', 'g'), ''), 'unknown');
$$;

-- Suppression policy, mirroring `recurringSuppressionReason` in the same
-- module: personal P2P rails and reward/refund lines are never offered as
-- recurring, whoever detected them. Applying it here keeps Plaid-sourced
-- suggestions consistent with our own — otherwise Plaid would resurrect
-- exactly the Venmo/cashback noise the detector deliberately suppresses.
create or replace function public.keel_recurring_suppression_reason(p_description text)
returns text
language sql
immutable
set search_path = pg_catalog
as $$
  select case
    when lower(coalesce(p_description, '')) ~ '\y(venmo|zelle|cashapp|cash\s*app|square\s*cash)\y' then 'p2p'
    when lower(coalesce(p_description, '')) ~ '\y(cash\s*back|cashback|rewards?|refunds?|refunded|rebates?|statement\s+credit)\y' then 'reward'
    else null
  end;
$$;

-- A provider stream's `description` is the memo of its LATEST transaction, so
-- it carries that occurrence's noise: "Payment to Chase card ending in 4550
-- 08/06", "Online Payment 30088296448 To Capital One 07/21". Feeding that
-- straight to the shared normalizer produces a label with a date baked into it
-- — bad to display, and worse for the duplicate guard, since KEEL's own series
-- for the same merchant is keyed on a cleaner string.
--
-- This pre-clean is deliberately SEPARATE from keel_normalize_counterparty:
-- that function must keep behaving exactly as packages/detectors does, because
-- its output is part of every KEEL series key already in the database.
create or replace function public.keel_provider_stream_label(
  p_merchant text,
  p_description text
)
returns text
language sql
immutable
set search_path = pg_catalog
as $$
  select public.keel_normalize_counterparty(
    case
      when coalesce(btrim(p_merchant), '') <> '' then p_merchant
      else
        -- Strip, in order: a trailing MM/DD or MM/DD/YY(YY); reference runs of
        -- 6+ digits; ACH batch descriptors (PPD/CCD/CTX/WEB/TEL "ID ..."); and
        -- a trailing "ending in 4550" card fragment, which otherwise leaves the
        -- label dangling on a preposition once the mask itself is stripped.
        regexp_replace(
          regexp_replace(
            regexp_replace(
              regexp_replace(coalesce(p_description, ''),
                '\s+\d{1,2}/\d{1,2}(/\d{2,4})?\s*$', ' '),
              '\y\d{6,}\y', ' ', 'g'),
            '\s+(ppd|ccd|ctx|web|tel)\s*id\y.*$', ' ', 'i'),
          '\s+ending\s+in\s*\d*\s*$', ' ', 'i')
    end);
$$;

-- ===========================================================================
-- 2. Stream -> series link. `matched` means the stream describes a series KEEL
-- already knows about (ours stays authoritative, no twin is created);
-- `created` means Plaid saw a series we had no evidence for.
-- ===========================================================================
alter table public.plaid_recurring_streams
  add column if not exists matched_series_id uuid references public.recurring_series (id),
  add column if not exists link_kind text check (link_kind is null or link_kind in ('created', 'matched')),
  add column if not exists linked_at timestamptz,
  add column if not exists skip_reason text;

create index if not exists plaid_recurring_streams_series_idx
  on public.plaid_recurring_streams (household_id, matched_series_id)
  where matched_series_id is not null;

-- ===========================================================================
-- 3. keel_recurring_ingest_plaid_series(household) — the mapping pass.
--
-- Per active stream on a live account:
--   * resolve its Plaid transaction ids to OUR normalized source records for
--     real dates/amounts (>= 3 required — a one-off is not a series);
--   * skip suppressed descriptions and UNKNOWN cadence (never guess);
--   * derive the cadence anchor from the observed dates;
--   * if a series for the same account+sign+counterparty already exists in ANY
--     status, LINK to it and create nothing — including `rejected`/`cancelled`,
--     so a series the user dismissed cannot come back wearing a Plaid badge;
--   * otherwise create a `suggested` series + candidate version.
--
-- Idempotent: the candidate's input_fingerprint covers the stream's observed
-- dates/amounts/status, and (household_id, series_id, input_fingerprint) is
-- unique, so re-running with unchanged data inserts nothing.
-- ===========================================================================
create or replace function public.keel_recurring_ingest_plaid_series(p_household_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_stream          record;
  v_run_id          uuid;
  v_run_key         text;
  v_as_of           timestamptz := now();
  v_dates           date[];
  v_amounts         bigint[];
  v_count           integer;
  v_first           date;
  v_last            date;
  v_cadence         text;
  v_anchor          jsonb;
  v_day             integer;
  v_days            integer[];
  v_min             bigint;
  v_max             bigint;
  v_median          bigint;
  v_amount_kind     text;
  v_counterparty    text;
  v_series_key      text;
  v_series          public.recurring_series%rowtype;
  v_existing_id     uuid;
  v_candidate       jsonb;
  v_candidate_id    uuid;
  v_fingerprint     text;
  v_evidence        jsonb;
  v_total_slots     integer;
  v_score_bps       integer;
  v_ledger_id       uuid;
  v_currency        text;
  v_created         integer := 0;
  v_matched         integer := 0;
  v_skipped         integer := 0;
  v_unchanged       integer := 0;
  v_considered      integer := 0;
begin
  if not exists (select 1 from public.households where id = p_household_id) then
    raise exception 'KEEL_SCOPE_VIOLATION: household not found' using errcode = 'P0006';
  end if;

  v_run_key := 'plaid-streams:' || to_char(v_as_of at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS');
  -- Two passes in the same second (a retry, or a manual call next to the cron)
  -- must reuse the run rather than collide on (household_id, run_key) — the
  -- same on-conflict-then-select idiom keel_recurring_upsert_candidates uses.
  insert into public.recurring_detector_runs
    (household_id, run_key, as_of, detector_version, confidence_version,
     normalizer_version, candidate_snapshot_hash)
  values
    (p_household_id, v_run_key, v_as_of, 'plaid-streams-v1', 'plaid-provider-v1',
     'counterparty-v2', public.keel_payload_hash(to_jsonb(v_run_key)))
  on conflict (household_id, run_key) do nothing
  returning id into v_run_id;
  if v_run_id is null then
    select id into v_run_id from public.recurring_detector_runs
     where household_id = p_household_id and run_key = v_run_key;
  end if;

  for v_stream in
    select s.*, a.ledger_account_id, a.currency as account_currency
      from public.plaid_recurring_streams s
      join public.accounts a
        on a.id = s.account_id and a.household_id = s.household_id
     where s.household_id = p_household_id
       and s.is_active
       and s.account_id is not null
       and a.archived_at is null
     order by s.stream_id
  loop
    v_considered := v_considered + 1;
    v_ledger_id := v_stream.ledger_account_id;
    v_currency := v_stream.account_currency;

    -- Suppression policy (P2P / rewards) applies to provider detections too.
    if public.keel_recurring_suppression_reason(
         coalesce(nullif(v_stream.merchant_name, ''), v_stream.description)) is not null then
      update public.plaid_recurring_streams set skip_reason = 'suppressed'
       where id = v_stream.id;
      v_skipped := v_skipped + 1;
      continue;
    end if;

    -- Cadence: never guessed. An UNKNOWN-frequency stream is stored but not
    -- offered, exactly as our own detector refuses a cadence it cannot fit.
    v_cadence := case v_stream.frequency
      when 'WEEKLY' then 'weekly'
      when 'BIWEEKLY' then 'biweekly'
      when 'SEMI_MONTHLY' then 'semimonthly'
      when 'MONTHLY' then 'monthly'
      when 'ANNUALLY' then 'annual'
      else null
    end;
    if v_cadence is null then
      update public.plaid_recurring_streams set skip_reason = 'unknown_cadence'
       where id = v_stream.id;
      v_skipped := v_skipped + 1;
      continue;
    end if;

    -- Real dates/amounts from OUR immutable source records, not Plaid's
    -- summary fields.
    select array_agg(n.effective_date order by n.effective_date),
           array_agg(n.amount_minor order by n.effective_date)
      into v_dates, v_amounts
      from jsonb_array_elements_text(coalesce(v_stream.raw->'transaction_ids', '[]'::jsonb)) tid
      join public.normalized_source_records n
        on n.provider_transaction_id = tid and n.household_id = p_household_id;

    v_count := coalesce(array_length(v_dates, 1), 0);
    if v_count < 3 then
      update public.plaid_recurring_streams set skip_reason = 'insufficient_history'
       where id = v_stream.id;
      v_skipped := v_skipped + 1;
      continue;
    end if;
    v_first := v_dates[1];
    v_last := v_dates[v_count];

    -- Cadence anchor from the observed dates: the most common day of month
    -- (ties break low, deterministically), or the epoch grid for week-based
    -- cadences.
    if v_cadence in ('weekly', 'biweekly') then
      v_anchor := jsonb_build_object(
        'kind', 'epoch_grid',
        'intervalDays', case v_cadence when 'weekly' then 7 else 14 end,
        'anchorEpochDay', v_last - date '1970-01-01');
    elsif v_cadence = 'semimonthly' then
      select array_agg(d order by d) into v_days from (
        select day_of_month as d
          from (
            select extract(day from unnest_date)::integer as day_of_month, count(*) as n
              from unnest(v_dates) as unnest_date
             group by 1
             order by n desc, 1
             limit 2
          ) top_two
         order by day_of_month
      ) ordered;
      if coalesce(array_length(v_days, 1), 0) <> 2 then
        update public.plaid_recurring_streams set skip_reason = 'ambiguous_semimonthly'
         where id = v_stream.id;
        v_skipped := v_skipped + 1;
        continue;
      end if;
      v_anchor := jsonb_build_object('kind', 'day_pair', 'days', to_jsonb(v_days));
    else
      select day_of_month into v_day
        from (
          select extract(day from unnest_date)::integer as day_of_month, count(*) as n
            from unnest(v_dates) as unnest_date
           group by 1
           order by n desc, 1
           limit 1
        ) top_day;
      v_anchor := jsonb_build_object(
        'kind', 'day_of_month',
        'day', v_day,
        'intervalMonths', case v_cadence when 'annual' then 12 else 1 end,
        -- phase must satisfy mod(monthIndex, intervalMonths) = phase, so an
        -- annual series is phased to the month it actually lands in.
        'phase', case v_cadence when 'annual'
          then mod((extract(year from v_last)::integer * 12 + extract(month from v_last)::integer - 1), 12)
          else 0 end);
    end if;

    select min(a), max(a) into v_min, v_max from unnest(v_amounts) as a;
    -- Lower median, matching bigintSummary in packages/detectors.
    select a into v_median from unnest(v_amounts) as a
     order by a offset ((v_count - 1) / 2) limit 1;
    v_amount_kind := case when v_min = v_max then 'fixed' else 'variable' end;

    -- How many slots the cadence expects across the observed window; the
    -- coverage the UI shows is measured, not asserted.
    select count(*)::integer into v_total_slots
      from public.keel_recurring_cadence_dates(
        jsonb_build_object('cadenceAnchor', v_anchor), v_first, v_last);
    v_total_slots := greatest(v_total_slots, v_count);

    -- Plaid publishes no numeric confidence; its own maturity label is the
    -- only honest signal, so it maps to two fixed values rather than a
    -- fabricated score.
    v_score_bps := case v_stream.status when 'MATURE' then 9000 else 6000 end;

    v_counterparty := public.keel_provider_stream_label(
      v_stream.merchant_name, v_stream.description);

    -- A stream this pass already resolved keeps its original verdict. Without
    -- this the duplicate guard below would re-find the series THIS stream
    -- created on an earlier run and downgrade its provenance from 'created' to
    -- 'matched'.
    v_existing_id := null;
    if v_stream.matched_series_id is not null
       and exists (select 1 from public.recurring_series
                    where id = v_stream.matched_series_id and household_id = p_household_id) then
      if v_stream.link_kind = 'matched' then
        v_matched := v_matched + 1;
        continue;
      end if;
    else
      -- Duplicate guard. ANY status counts: linking to a rejected or cancelled
      -- series deliberately creates nothing, so a dismissal cannot be undone by
      -- the provider re-detecting the same thing.
      select id into v_existing_id
        from public.recurring_series
       where household_id = p_household_id
         and account_id = v_stream.account_id
         and sign::text = v_stream.direction
         and (
           counterparty_key = v_counterparty
           or (length(counterparty_key) >= 5 and position(counterparty_key in v_counterparty) > 0)
           or (length(v_counterparty) >= 5 and position(v_counterparty in counterparty_key) > 0)
         )
       order by case status when 'confirmed' then 0 when 'paused' then 1 when 'suggested' then 2 else 3 end,
                created_at
       limit 1;
    end if;

    if v_existing_id is not null then
      update public.plaid_recurring_streams
         set matched_series_id = v_existing_id,
             link_kind = 'matched',
             linked_at = now(),
             skip_reason = null
       where id = v_stream.id;
      v_matched := v_matched + 1;
      continue;
    end if;

    v_series_key := public.keel_payload_hash(to_jsonb('plaid-stream:' || v_stream.stream_id));
    v_evidence := (
      select jsonb_agg(jsonb_build_object(
               'streamId', v_stream.stream_id,
               'providerTransactionId', tid,
               'source', 'plaid'))
        from jsonb_array_elements_text(v_stream.raw->'transaction_ids') tid
    );
    v_fingerprint := public.keel_payload_hash(jsonb_build_object(
      'streamId', v_stream.stream_id,
      'status', v_stream.status,
      'frequency', v_stream.frequency,
      'counterparty', v_counterparty,
      'dates', to_jsonb(v_dates),
      'amounts', to_jsonb(v_amounts)));

    v_candidate := jsonb_build_object(
      'seriesKey', v_series_key,
      'counterpartyKey', v_counterparty,
      'accountId', v_stream.account_id,
      'ledgerAccountId', v_ledger_id,
      'currency', v_currency,
      'sign', v_stream.direction,
      'cadence', v_cadence,
      'cadenceAnchor', v_anchor,
      'amountKind', v_amount_kind,
      'representativeAmountMinor', case when v_amount_kind = 'fixed' then v_median::text else null end,
      'amountSummary', jsonb_build_object(
        'minMinor', v_min::text,
        'maxMinor', v_max::text,
        'lowerMedianMinor', v_median::text,
        'squaredResidualSum', '0',
        'count', v_count),
      'lastSeen', to_char(v_last, 'YYYY-MM-DD'),
      'occurrenceCount', v_count,
      -- Coverage is measured over the transactions Plaid CITES for the stream
      -- (its transaction_ids list is a sample, not the full history), so a low
      -- ratio reflects that sampling rather than an irregular series. The basis
      -- is recorded so nothing downstream reads it as a KEEL-measured fit.
      'coverage', jsonb_build_object('matchedSlots', v_count, 'totalSlots', v_total_slots,
                                     'basis', 'provider_sample'),
      -- Plaid exposes no per-occurrence residual and we do not refit its
      -- stream, so this is reported as unmeasured rather than as zero.
      'residualDays', null,
      'scoreBps', v_score_bps,
      'evidence', v_evidence,
      'inputFingerprint', v_fingerprint,
      'detectorVersion', 'plaid-streams-v1',
      'confidenceVersion', 'plaid-provider-v1',
      'normalizerVersion', 'counterparty-v2',
      'asOf', to_char(v_as_of at time zone 'utc', 'YYYY-MM-DD'),
      'requiresApproval', true,
      'providerStatus', v_stream.status,
      'providerPredictedNextDate', to_char(v_stream.predicted_next_date, 'YYYY-MM-DD'));

    insert into public.recurring_series
      (household_id, series_key, account_id, ledger_account_id, counterparty_key,
       currency, sign, status)
    values
      (p_household_id, v_series_key, v_stream.account_id, v_ledger_id, v_counterparty,
       v_currency, v_stream.direction::public.recurring_sign, 'suggested')
    on conflict (household_id, series_key) do nothing;
    select * into v_series from public.recurring_series
     where household_id = p_household_id and series_key = v_series_key
     for update;

    -- The provider owns the label of a series the provider created, so a
    -- cleaner derivation (or a merchant name Plaid fills in later) refreshes
    -- it. Only while the series is still a suggestion: once the user has
    -- confirmed, paused, rejected or cancelled it, the name they acted on
    -- stays put.
    if v_series.counterparty_key is distinct from v_counterparty
       and v_series.status in ('suggested', 'withdrawn') then
      update public.recurring_series
         set counterparty_key = v_counterparty, updated_at = now()
       where household_id = p_household_id and id = v_series.id;
      v_series.counterparty_key := v_counterparty;
    end if;

    insert into public.recurring_candidate_versions
      (household_id, series_id, detector_run_id, candidate_hash, input_fingerprint,
       detector_version, confidence_version, normalizer_version, as_of, score_bps,
       evidence, candidate)
    values
      (p_household_id, v_series.id, v_run_id, public.keel_payload_hash(v_candidate),
       v_fingerprint, 'plaid-streams-v1', 'plaid-provider-v1', 'counterparty-v2',
       v_as_of, v_score_bps, v_evidence, v_candidate)
    on conflict (household_id, series_id, input_fingerprint) do nothing
    returning id into v_candidate_id;

    if v_candidate_id is null then
      v_unchanged := v_unchanged + 1;
    else
      -- Same lattice the KEEL detector honours (20260722010000): only a
      -- suggested or system-withdrawn series re-points at a fresh candidate.
      -- confirmed / paused / rejected / cancelled keep the candidate the user
      -- acted on.
      if v_series.status in ('suggested', 'withdrawn') then
        update public.recurring_series
           set current_candidate_version_id = v_candidate_id,
               status = 'suggested',
               updated_at = now()
         where household_id = p_household_id and id = v_series.id;
      end if;
      insert into public.audit_log
        (household_id, actor, action, object_type, object_id, command_id, before, after)
      values
        (p_household_id,
         jsonb_build_object('kind', 'system', 'processName', 'plaid-recurring-streams'),
         'recurring.suggested', 'recurring_series', v_series.id, gen_random_uuid(), null,
         jsonb_build_object('seriesId', v_series.id, 'candidateVersionId', v_candidate_id,
                            'streamId', v_stream.stream_id, 'source', 'plaid',
                            'status', v_series.status));
      v_created := v_created + 1;
    end if;

    update public.plaid_recurring_streams
       set matched_series_id = v_series.id,
           link_kind = 'created',
           linked_at = now(),
           skip_reason = null
     where id = v_stream.id;
  end loop;

  -- A pass that writes no candidates still leaves its run row:
  -- recurring_detector_runs is append-only (keel_forbid_mutation), and an
  -- empty run is itself the record that the pass ran and found nothing.
  -- (Caught live: once every stream is mapped, the steady-state pass writes
  -- nothing, and the tidy-up DELETE this replaced raised KEEL_IMMUTABLE.)

  return jsonb_build_object(
    'consideredStreams', v_considered,
    -- Candidate VERSIONS written, not series: a label or amount change on an
    -- existing provider series writes a fresh candidate under the same series.
    'candidatesWritten', v_created,
    'matched', v_matched,
    'unchanged', v_unchanged,
    'skipped', v_skipped,
    'asOf', to_char(v_as_of at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'));
end;
$$;

grant create on schema public to keel_worker;
alter function public.keel_recurring_ingest_plaid_series(uuid) owner to keel_worker;
revoke create on schema public from keel_worker;
revoke all on function public.keel_recurring_ingest_plaid_series(uuid) from public, anon, authenticated;
grant execute on function public.keel_recurring_ingest_plaid_series(uuid) to keel_worker, service_role;

-- The definer role owns the mapping pass, so it needs the same write reach on
-- the recurring spine the KEEL detector's proc already has, plus the new link
-- columns on the streams table (Phase 1 granted it select/insert/update there).
grant select, insert, update on public.recurring_series to keel_worker;
grant select, insert on public.recurring_candidate_versions to keel_worker;
grant select, insert on public.recurring_detector_runs to keel_worker;
-- Coverage is measured with the shared cadence helper, which the definer role
-- had no EXECUTE on (it only ever ran inside procs owned by keel_api).
grant execute on function public.keel_recurring_cadence_dates(jsonb, date, date) to keel_worker;
