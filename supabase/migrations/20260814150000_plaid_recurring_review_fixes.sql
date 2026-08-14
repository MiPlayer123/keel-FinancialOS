-- Codex review fixes for the Plaid-primary recurring slices (#172, #173).
-- Every finding below was confirmed against the live database before fixing.
--
-- 1. [P1] The KEEL-only reaper withdrew Plaid series. Confirmed by reading the
--    live body of keel_recurring_reap_stale_suggestions: it withdraws EVERY
--    'suggested' series absent from the grid detector's emitted-id list, and
--    provider series are never in that list. Worse, the Plaid pass would not
--    restore them — an unchanged stream fingerprint takes the no-op branch. The
--    03:00 UTC detection cron would therefore have silently retired the whole
--    feature within a day of shipping it.
-- 2. [P1] Plaid-first, KEEL-later produced the very twin the guard exists to
--    prevent: the grid detector's series key is derived from cadence/anchor/
--    amount and can never equal a provider key, and keel_recurring_upsert_
--    candidates conflicts only on (household_id, series_key).
-- 3. [P1] Two distinct streams from ONE counterparty (a monthly and an annual
--    plan, say) collapsed onto the first stream's series, losing a projection.
-- 4. [P2] normalized_source_records is append-only with added/modified/removed
--    versions, so joining on provider_transaction_id counted one revised
--    transaction as several occurrences — skewing the median, the day-of-month
--    mode, and the >= 3 history gate. 12 provider transactions in the live
--    household already carry multiple versions.
--
-- Worker-side findings (partial-mapping reconciliation and the swallowed
-- account-lookup error) are fixed in supabase/functions/worker/index.ts; the
-- ingest proc gains the parameter that makes the first of those expressible.

-- ===========================================================================
-- 1. Reap by provenance. The emitted-id list is the GRID detector's opinion
-- about its own candidates; it says nothing about series another detector
-- produced. A provider series' staleness signal is Plaid marking its stream
-- inactive, which the mapping pass now acts on directly (step 3 below).
-- Body reproduced verbatim from live pg_get_functiondef with one added
-- predicate.
-- ===========================================================================
create or replace function public.keel_recurring_reap_stale_suggestions(
  p_household_id uuid, p_run_id uuid, p_emitted_series_ids uuid[], p_detection_ran boolean
)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
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
  if not exists (
    select 1 from public.recurring_detector_runs
    where id = p_run_id and household_id = p_household_id
  ) then
    raise exception 'KEEL_SCOPE_VIOLATION: detector run not in household' using errcode = 'P0006';
  end if;

  if p_detection_ran is not true
     or coalesce(array_length(p_emitted_series_ids, 1), 0) = 0 then
    return 0;
  end if;

  for v_series in
    select s.id, s.current_candidate_version_id, s.status
    from public.recurring_series s
    where s.household_id = p_household_id
      and s.status = 'suggested'
      and not (s.id = any(p_emitted_series_ids))
      -- Provenance scope: a grid-detector run cannot judge a provider-detected
      -- series stale, because it never had the chance to emit one.
      and not exists (
        select 1 from public.recurring_candidate_versions cv
         where cv.id = s.current_candidate_version_id
           and cv.detector_version like 'plaid-%'
      )
  loop
    v_candidate_id := v_series.current_candidate_version_id;
    if v_candidate_id is null then
      continue;
    end if;

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
$function$;

-- ===========================================================================
-- 2. Stream ingest gains p_seen_stream_ids: the ids Plaid RETURNED, which is
-- not the same as the ids we could map. Without it, one stream failing shape
-- validation looked identical to Plaid dropping it, and the mirror deactivated
-- a stream that is very much alive.
-- ===========================================================================
drop function if exists public.keel_ingest_plaid_recurring_streams(uuid, uuid, jsonb);

create or replace function public.keel_ingest_plaid_recurring_streams(
  p_household_id    uuid,
  p_connection_id   uuid,
  p_streams         jsonb,
  p_seen_stream_ids text[] default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_upserted    integer := 0;
  v_deactivated integer := 0;
  v_seen        text[];
begin
  if p_household_id is null or p_connection_id is null then
    raise exception 'household and connection are required' using errcode = 'raise_exception';
  end if;
  if jsonb_typeof(p_streams) <> 'array' then
    raise exception 'streams payload must be a json array' using errcode = 'raise_exception';
  end if;
  if not exists (
    select 1 from public.connections c
     where c.id = p_connection_id and c.household_id = p_household_id
  ) then
    raise exception 'connection not found in household' using errcode = 'raise_exception';
  end if;

  with incoming as (
    select
      (s ->> 'streamId')                       as stream_id,
      (s ->> 'accountId')::uuid                as account_id,
      (s ->> 'externalAccountRef')             as external_account_ref,
      (s ->> 'direction')                      as direction,
      (s ->> 'status')                         as status,
      (s ->> 'frequency')                      as frequency,
      (s ->> 'isActive')::boolean              as is_active,
      (s ->> 'description')                    as description,
      (s ->> 'merchantName')                   as merchant_name,
      (s ->> 'categoryPrimary')                as category_primary,
      (s ->> 'firstDate')::date                as first_date,
      (s ->> 'lastDate')::date                 as last_date,
      (s ->> 'predictedNextDate')::date        as predicted_next_date,
      (s ->> 'averageAmountMinor')::bigint     as average_amount_minor,
      (s ->> 'lastAmountMinor')::bigint        as last_amount_minor,
      coalesce(s ->> 'currency', 'USD')        as currency,
      (s -> 'raw')                             as raw
      from jsonb_array_elements(p_streams) as s
  ), upserted as (
    insert into public.plaid_recurring_streams (
      household_id, connection_id, account_id, external_account_ref, stream_id,
      direction, status, frequency, is_active, description, merchant_name,
      category_primary, first_date, last_date, predicted_next_date,
      average_amount_minor, last_amount_minor, currency, raw, last_seen_at, absent_since
    )
    select
      p_household_id, p_connection_id, i.account_id, i.external_account_ref, i.stream_id,
      i.direction, i.status, i.frequency, i.is_active, i.description, i.merchant_name,
      i.category_primary, i.first_date, i.last_date, i.predicted_next_date,
      i.average_amount_minor, i.last_amount_minor, i.currency, i.raw, now(), null
      from incoming i
    on conflict (household_id, stream_id) do update
      set connection_id        = excluded.connection_id,
          account_id           = excluded.account_id,
          external_account_ref = excluded.external_account_ref,
          direction            = excluded.direction,
          status               = excluded.status,
          frequency            = excluded.frequency,
          is_active            = excluded.is_active,
          description          = excluded.description,
          merchant_name        = excluded.merchant_name,
          category_primary     = excluded.category_primary,
          first_date           = excluded.first_date,
          last_date            = excluded.last_date,
          predicted_next_date  = excluded.predicted_next_date,
          average_amount_minor = excluded.average_amount_minor,
          last_amount_minor    = excluded.last_amount_minor,
          currency             = excluded.currency,
          raw                  = excluded.raw,
          last_seen_at         = now(),
          absent_since         = null
    returning stream_id
  )
  select count(*)::integer, coalesce(array_agg(stream_id), array[]::text[])
    into v_upserted, v_seen
    from upserted;

  -- Deactivate only what Plaid genuinely stopped reporting. A stream the caller
  -- fetched but could not map stays untouched with its last known state.
  v_seen := v_seen || coalesce(p_seen_stream_ids, array[]::text[]);

  update public.plaid_recurring_streams s
     set is_active    = false,
         absent_since = coalesce(s.absent_since, now())
   where s.household_id = p_household_id
     and s.connection_id = p_connection_id
     and not (s.stream_id = any (v_seen))
     and (s.is_active or s.absent_since is null);
  get diagnostics v_deactivated = row_count;

  return jsonb_build_object(
    'upserted', v_upserted,
    'deactivated', v_deactivated,
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  );
end;
$$;

grant create on schema public to keel_worker;
alter function public.keel_ingest_plaid_recurring_streams(uuid, uuid, jsonb, text[]) owner to keel_worker;
revoke create on schema public from keel_worker;
revoke all on function public.keel_ingest_plaid_recurring_streams(uuid, uuid, jsonb, text[])
  from public, anon, authenticated;
grant execute on function public.keel_ingest_plaid_recurring_streams(uuid, uuid, jsonb, text[])
  to keel_worker, service_role;

-- ===========================================================================
-- 3. Mapping pass, corrected. Changes against 20260814140000:
--   * source records are de-duplicated to the latest non-removed version per
--     provider transaction id;
--   * the duplicate guard ignores series that ANOTHER stream already created,
--     so two streams from one merchant get one series each;
--   * a provider series converges onto a KEEL series that appears later: the
--     provider twin is withdrawn and its stream re-links to the KEEL series;
--   * a stream Plaid stopped reporting (or marked inactive) withdraws its own
--     provider-created suggestion — the staleness path the grid reaper used to
--     provide before it was scoped away in step 1.
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
  v_converged       integer := 0;
  v_retired         integer := 0;
begin
  if not exists (select 1 from public.households where id = p_household_id) then
    raise exception 'KEEL_SCOPE_VIOLATION: household not found' using errcode = 'P0006';
  end if;

  v_run_key := 'plaid-streams:' || to_char(v_as_of at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS');
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

  -- ---------------------------------------------------------------------
  -- Retire provider suggestions whose stream Plaid no longer reports as
  -- active. Only ever touches a series this pass created and the user has not
  -- acted on; a confirmed one keeps its status and its schedule.
  -- ---------------------------------------------------------------------
  update public.recurring_series s
     set status = 'withdrawn', updated_at = now()
   where s.household_id = p_household_id
     and s.status = 'suggested'
     and exists (
       select 1 from public.plaid_recurring_streams st
        where st.matched_series_id = s.id
          and st.household_id = p_household_id
          and st.link_kind = 'created'
          and not st.is_active
     );
  get diagnostics v_retired = row_count;

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

    if public.keel_recurring_suppression_reason(
         coalesce(nullif(v_stream.merchant_name, ''), v_stream.description)) is not null then
      update public.plaid_recurring_streams set skip_reason = 'suppressed'
       where id = v_stream.id;
      v_skipped := v_skipped + 1;
      continue;
    end if;

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

    -- One observation per PROVIDER TRANSACTION, not per source-record version:
    -- normalized_source_records is append-only (added / modified / removed), so
    -- a revised transaction otherwise counted two or three times and skewed the
    -- median, the day-of-month mode and the >= 3 history gate.
    select array_agg(latest.effective_date order by latest.effective_date),
           array_agg(latest.amount_minor order by latest.effective_date)
      into v_dates, v_amounts
      from (
        select distinct on (n.provider_transaction_id)
               n.provider_transaction_id, n.effective_date, n.amount_minor
          from jsonb_array_elements_text(coalesce(v_stream.raw->'transaction_ids', '[]'::jsonb)) tid
          join public.normalized_source_records n
            on n.provider_transaction_id = tid and n.household_id = p_household_id
         where n.kind <> 'removed'
           and n.effective_date is not null
           and n.amount_minor is not null
         order by n.provider_transaction_id, n.created_at desc, n.id desc
      ) latest;

    v_count := coalesce(array_length(v_dates, 1), 0);
    if v_count < 3 then
      update public.plaid_recurring_streams set skip_reason = 'insufficient_history'
       where id = v_stream.id;
      v_skipped := v_skipped + 1;
      continue;
    end if;
    v_first := v_dates[1];
    v_last := v_dates[v_count];

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
        'phase', case v_cadence when 'annual'
          then mod((extract(year from v_last)::integer * 12 + extract(month from v_last)::integer - 1), 12)
          else 0 end);
    end if;

    select min(a), max(a) into v_min, v_max from unnest(v_amounts) as a;
    select a into v_median from unnest(v_amounts) as a
     order by a offset ((v_count - 1) / 2) limit 1;
    v_amount_kind := case when v_min = v_max then 'fixed' else 'variable' end;

    select count(*)::integer into v_total_slots
      from public.keel_recurring_cadence_dates(
        jsonb_build_object('cadenceAnchor', v_anchor), v_first, v_last);
    v_total_slots := greatest(v_total_slots, v_count);

    v_score_bps := case v_stream.status when 'MATURE' then 9000 else 6000 end;

    v_counterparty := public.keel_provider_stream_label(
      v_stream.merchant_name, v_stream.description);

    -- Duplicate guard. ANY status counts, so a dismissal cannot be undone by
    -- the provider re-detecting the same thing. Series created by a DIFFERENT
    -- stream are excluded: two streams from one merchant (a monthly plan and an
    -- annual one, say) are two series, and collapsing them would silently drop
    -- a projection.
    v_existing_id := null;
    if v_stream.matched_series_id is not null
       and exists (select 1 from public.recurring_series
                    where id = v_stream.matched_series_id and household_id = p_household_id) then
      if v_stream.link_kind = 'matched' then
        v_matched := v_matched + 1;
        continue;
      end if;
    else
      select id into v_existing_id
        from public.recurring_series r
       where r.household_id = p_household_id
         and r.account_id = v_stream.account_id
         and r.sign::text = v_stream.direction
         and (
           r.counterparty_key = v_counterparty
           or (length(r.counterparty_key) >= 5 and position(r.counterparty_key in v_counterparty) > 0)
           or (length(v_counterparty) >= 5 and position(v_counterparty in r.counterparty_key) > 0)
         )
         and not exists (
           select 1 from public.plaid_recurring_streams other
            where other.matched_series_id = r.id
              and other.household_id = p_household_id
              and other.link_kind = 'created'
              and other.stream_id <> v_stream.stream_id
         )
       order by case r.status when 'confirmed' then 0 when 'paused' then 1 when 'suggested' then 2 else 3 end,
                r.created_at
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

    -- Convergence: the grid detector derives its series key from cadence,
    -- anchor and amount, so it can never land on a provider key — once enough
    -- live postings accumulate it mints its OWN series for the same merchant.
    -- When that happens the provider suggestion steps aside rather than sitting
    -- next to it as a twin. A provider series the user already acted on is left
    -- alone; only an untouched suggestion is withdrawn.
    if v_stream.link_kind = 'created' and v_stream.matched_series_id is not null then
      select r.id into v_existing_id
        from public.recurring_series r
        left join public.recurring_candidate_versions cv on cv.id = r.current_candidate_version_id
       where r.household_id = p_household_id
         and r.id <> v_stream.matched_series_id
         and r.account_id = v_stream.account_id
         and r.sign::text = v_stream.direction
         and coalesce(cv.detector_version, '') not like 'plaid-%'
         and (
           r.counterparty_key = v_counterparty
           or (length(r.counterparty_key) >= 5 and position(r.counterparty_key in v_counterparty) > 0)
           or (length(v_counterparty) >= 5 and position(v_counterparty in r.counterparty_key) > 0)
         )
       order by case r.status when 'confirmed' then 0 when 'paused' then 1 when 'suggested' then 2 else 3 end,
                r.created_at
       limit 1;
      if v_existing_id is not null then
        update public.recurring_series
           set status = 'withdrawn', updated_at = now()
         where household_id = p_household_id
           and id = v_stream.matched_series_id
           and status = 'suggested';
        update public.plaid_recurring_streams
           set matched_series_id = v_existing_id,
               link_kind = 'matched',
               linked_at = now()
         where id = v_stream.id;
        v_converged := v_converged + 1;
        continue;
      end if;
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
      'coverage', jsonb_build_object('matchedSlots', v_count, 'totalSlots', v_total_slots,
                                     'basis', 'provider_sample'),
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

  return jsonb_build_object(
    'consideredStreams', v_considered,
    'candidatesWritten', v_created,
    'matched', v_matched,
    'converged', v_converged,
    'retired', v_retired,
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
