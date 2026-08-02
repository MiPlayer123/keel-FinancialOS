-- fix(recurring): two user-blocking transition-core guards, found live 2026-07-19.
--
-- 1. SAME-DAY GUARD (the "Invalid command" on every Review/Recurring
--    Confirm/Dismiss click): the core rejected any transition whose
--    effective_date was <= the series' last status-event date. The daily
--    detection run writes 'suggested' events dated TODAY, so every user
--    confirm/reject attempted the SAME day as a detection failed with
--    KEEL_INVALID_COMMAND. Events are already strictly ordered by insertion
--    (id/created_at); same-DATE user actions after a system event are
--    legitimate. Guard relaxed from `<=` to `<` (still rejects back-dating).
--
-- 2. WITHDRAWN -> CONFIRMED (user override): 'confirmed' was allowed from
--    suggested/rejected/cancelled but NOT from 'withdrawn' (a SYSTEM state
--    set by the stale-suggestion reap). A user re-affirming a series the
--    system withdrew is the suggest->approve loop working as intended (the
--    reap is class-B automation; the user outranks it). Concrete case: the
--    reap withdrew the founder's CURRENT ~$1,043 Deeptune payroll series
--    (recent amount change -> low detector score) while stale higher-scoring
--    patterns survived; the user explicitly wants the current one confirmed.
--    'withdrawn' added to the allowed-from set for 'confirmed' only — all
--    other transitions unchanged.
--
-- CREATE OR REPLACE of the live definition with exactly these two edits;
-- signature identical; owner (keel_api) + grants re-asserted.

CREATE OR REPLACE FUNCTION public.keel_recurring_transition_core(p_command_id uuid, p_economic_event_key text, p_actor jsonb, p_household_id uuid, p_payload jsonb, p_transition recurring_transition)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_hash text := public.keel_payload_hash(p_payload);
  v_replay jsonb;
  v_actor jsonb;
  v_series public.recurring_series%rowtype;
  v_candidate public.recurring_candidate_versions%rowtype;
  v_before jsonb;
  v_after jsonb;
  v_status public.recurring_series_status;
  v_latest_transition public.recurring_transition;
  v_effective_transition public.recurring_transition;
  v_effective_date date;
  v_last_effective_date date;
  v_projection_start date;
  v_projection_end date;
  v_expected_date date;
  v_horizon_days integer;
  v_expected_amount text;
  v_occurrence_key text;
  v_occurrence_fingerprint text;
  v_occurrence_evidence jsonb;
  v_timeline_snapshot jsonb;
  v_result jsonb;
begin
  perform public.keel_assert_member_write(p_household_id);
  v_actor := public.keel_actor_from_jwt();
  v_replay := public.keel_idempotency_check(p_household_id, p_economic_event_key, v_hash);
  if v_replay is not null then return v_replay; end if;

  if jsonb_typeof(p_payload) <> 'object'
     or coalesce(p_payload->>'series_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or not (p_payload ? 'effective_date') then
    raise exception 'KEEL_INVALID_COMMAND: malformed recurring transition payload'
      using errcode = 'P0009';
  end if;
  if p_transition in ('confirmed','resumed') then
    if (p_payload - 'series_id' - 'effective_date' - 'horizon_days') <> '{}'::jsonb
       or coalesce(p_payload->>'horizon_days','') !~ '^[0-9]+$' then
      raise exception 'KEEL_INVALID_COMMAND: projection payload fields are invalid'
        using errcode = 'P0009';
    end if;
    begin
      v_horizon_days := (p_payload->>'horizon_days')::integer;
    exception when numeric_value_out_of_range then
      raise exception 'KEEL_INVALID_COMMAND: projection horizon is invalid' using errcode = 'P0009';
    end;
    if v_horizon_days not between 1 and 366 then
      raise exception 'KEEL_INVALID_COMMAND: projection horizon must be between 1 and 366'
        using errcode = 'P0009';
    end if;
  elsif (p_payload - 'series_id' - 'effective_date') <> '{}'::jsonb then
    raise exception 'KEEL_INVALID_COMMAND: transition payload fields are invalid'
      using errcode = 'P0009';
  end if;
  begin
    if coalesce(p_payload->>'effective_date','') !~ '^\d{4}-\d{2}-\d{2}$' then
      raise exception 'invalid date shape';
    end if;
    v_effective_date := (p_payload->>'effective_date')::date;
    if to_char(v_effective_date, 'YYYY-MM-DD') is distinct from p_payload->>'effective_date' then
      raise exception 'non-canonical date';
    end if;
  exception when others then
    raise exception 'KEEL_INVALID_COMMAND: invalid Gregorian effective date' using errcode = 'P0009';
  end;

  select * into v_series from public.recurring_series
   where household_id = p_household_id and id = (p_payload->>'series_id')::uuid
   for update;
  if not found or not public.keel_recurring_account_access(p_household_id, v_series.account_id, true) then
    raise exception 'KEEL_SCOPE_VIOLATION: recurring series not found' using errcode = 'P0006';
  end if;
  select * into v_candidate from public.recurring_candidate_versions
   where household_id = p_household_id
     and id = v_series.current_candidate_version_id
     and series_id = v_series.id;
  if not found then
    raise exception 'KEEL_IDEMPOTENCY_CONFLICT: candidate version is not current'
      using errcode = 'P0007';
  end if;

  select max(effective_date) into v_last_effective_date
    from public.recurring_status_events
   where household_id = p_household_id and series_id = v_series.id;
  if v_last_effective_date is not null and v_effective_date < v_last_effective_date then
    raise exception 'KEEL_INVALID_COMMAND: effective date must be later than prior transitions'
      using errcode = 'P0009';
  end if;

  if (p_transition = 'confirmed' and v_series.status not in ('suggested','rejected','cancelled','withdrawn'))
     or (p_transition = 'paused' and v_series.status <> 'confirmed')
     or (p_transition = 'resumed' and v_series.status <> 'paused')
     or (p_transition = 'cancelled' and v_series.status not in ('confirmed','paused'))
     or (p_transition = 'rejected' and v_series.status <> 'suggested') then
    raise exception 'KEEL_INVALID_COMMAND: invalid recurring transition from % to %',
      v_series.status, p_transition using errcode = 'P0009';
  end if;

  v_before := jsonb_build_object('seriesId', v_series.id, 'status', v_series.status,
    'candidateVersionHash', v_candidate.candidate_hash);
  insert into public.recurring_status_events
    (household_id, series_id, candidate_version_id, transition, effective_date,
     actor, command_id)
  values
    (p_household_id, v_series.id, v_candidate.id, p_transition,
     v_effective_date, v_actor, p_command_id);

  select transition into v_latest_transition
    from public.recurring_status_events
   where household_id = p_household_id and series_id = v_series.id
   order by effective_date desc, created_at desc, command_id desc
   limit 1;
  v_status := case v_latest_transition
    when 'confirmed' then 'confirmed'::public.recurring_series_status
    when 'resumed' then 'confirmed'::public.recurring_series_status
    when 'paused' then 'paused'::public.recurring_series_status
    when 'cancelled' then 'cancelled'::public.recurring_series_status
    when 'rejected' then 'rejected'::public.recurring_series_status
    else 'suggested'::public.recurring_series_status
  end;
  update public.recurring_series
     set status = v_status, updated_at = now(),
         confirmed_by = case when p_transition = 'confirmed' then (v_actor->>'userId')::uuid else confirmed_by end,
         confirmed_at = case when p_transition = 'confirmed' then now() else confirmed_at end
   where household_id = p_household_id and id = v_series.id;

  if p_transition in ('confirmed','resumed') then
    begin
      v_projection_start := (v_candidate.candidate->>'lastSeen')::date + 1;
      v_projection_end := v_effective_date + v_horizon_days;
    exception when invalid_datetime_format or datetime_field_overflow then
      raise exception 'KEEL_INVALID_COMMAND: candidate lastSeen is invalid' using errcode = 'P0009';
    end;
    v_expected_amount := case v_candidate.candidate->>'amountKind'
      when 'fixed' then v_candidate.candidate->>'representativeAmountMinor'
      when 'variable' then v_candidate.candidate->'amountSummary'->>'lowerMedianMinor'
      else null
    end;
    if coalesce(v_expected_amount,'') !~ '^-?(0|[1-9][0-9]*)$'
       or v_expected_amount = '-0' then
      raise exception 'KEEL_INVALID_COMMAND: candidate amount derivation is invalid'
        using errcode = 'P0009';
    end if;
    select jsonb_agg(jsonb_build_object(
      'txn_id', evidence_row->>'txnId',
      'batch_id', evidence_row->>'batchId',
      'posting_id', evidence_row->>'postingId'
    ) order by evidence_ordinal) into v_occurrence_evidence
    from jsonb_array_elements(v_candidate.evidence) with ordinality
      as evidence(evidence_row, evidence_ordinal);
    select coalesce(jsonb_agg(jsonb_build_object(
      'transition', status_event.transition,
      'effectiveDate', to_char(status_event.effective_date,'YYYY-MM-DD'),
      'commandId', status_event.command_id
    ) order by status_event.effective_date, status_event.created_at, status_event.command_id), '[]'::jsonb)
      into v_timeline_snapshot
    from public.recurring_status_events status_event
    where status_event.household_id = p_household_id and status_event.series_id = v_series.id;

    for v_expected_date in
      select cadence.expected_date from public.keel_recurring_cadence_dates(
        v_candidate.candidate, v_projection_start, v_projection_end) cadence
    loop
      select transition into v_effective_transition
        from public.recurring_status_events
       where household_id = p_household_id and series_id = v_series.id
         and effective_date <= v_expected_date
       order by effective_date desc, created_at desc, command_id desc
       limit 1;
      if v_effective_transition is null
         or v_effective_transition not in ('confirmed','resumed') then continue; end if;
      v_occurrence_key := public.keel_payload_hash(jsonb_build_object(
        'seriesId', v_series.id,
        'candidateVersionHash', v_candidate.candidate_hash,
        'expectedDate', to_char(v_expected_date,'YYYY-MM-DD')
      ));
      v_occurrence_fingerprint := public.keel_payload_hash(jsonb_build_object(
        'candidateInputFingerprint', v_candidate.input_fingerprint,
        'expectedDate', to_char(v_expected_date,'YYYY-MM-DD'),
        'statusEvents', v_timeline_snapshot
      ));
      insert into public.recurring_occurrences
        (household_id, series_id, candidate_version_id, occurrence_key,
         expected_date, expected_amount_minor, currency, amount_kind, status,
         matched_txn_id, score_bps, evidence, input_fingerprint,
         detector_version, confidence_version, as_of)
      values
        (p_household_id, v_series.id, v_candidate.id, v_occurrence_key,
         v_expected_date, v_expected_amount::bigint, v_series.currency,
         (v_candidate.candidate->>'amountKind')::public.recurring_amount_kind,
         'expected', null, v_candidate.score_bps, v_occurrence_evidence,
         v_occurrence_fingerprint, v_candidate.detector_version,
         v_candidate.confidence_version,
         v_effective_date::timestamp at time zone 'utc')
      on conflict (household_id, series_id, candidate_version_id, expected_date) do nothing;
    end loop;
  end if;

  v_after := jsonb_build_object('seriesId', v_series.id, 'status', v_status,
    'candidateVersionHash', v_candidate.candidate_hash,
    'effectiveDate', to_char(v_effective_date,'YYYY-MM-DD'));
  v_result := jsonb_build_object(
    'commandId', p_command_id, 'economicEventKey', p_economic_event_key,
    'idempotentReplay', false, 'effects', v_after,
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  );
  insert into public.audit_log
    (household_id, actor, action, object_type, object_id, command_id, before, after)
  values
    (p_household_id, v_actor, 'recurring.' || p_transition::text,
     'recurring_series', v_series.id, p_command_id, v_before, v_after);
  insert into public.domain_events
    (event_type, household_id, command_id, economic_event_key, actor, payload)
  values
    ('recurring.' || p_transition::text, p_household_id, p_command_id,
     p_economic_event_key, v_actor, v_after);
  insert into public.command_executions
    (household_id, economic_event_key, command_id, command, payload_sha256, result)
  values
    (p_household_id, p_economic_event_key, p_command_id,
     'recurring.' || p_transition::text, v_hash, v_result);
  return v_result;
end;
$function$

;

grant create on schema public to keel_api;
alter function public.keel_recurring_transition_core(uuid, text, jsonb, uuid, jsonb, public.recurring_transition) owner to keel_api;
revoke create on schema public from keel_api;
