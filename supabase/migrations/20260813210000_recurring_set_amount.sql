-- recurring.set_amount — user correction of a detected series' expected amount
-- ("everything editable": cadence got its editor in 20260723020000; amount is
-- the remaining detected-series field a user could not correct).
--
-- Mirrors keel_recurring_reclassify_cadence structurally, clause for clause:
--  Law 2  — reversible correction, audited. Mints a NEW candidate version (the
--           old one is preserved verbatim, just no longer 'current'), never
--           mutates the old candidate.
--  Law 9  — explicit ownership: the new candidate is stamped
--           detectorVersion='manual-amount-v1' + manualAmountOverride=true as
--           provenance. The nightly detector cannot clobber it on a live
--           edited series because keel_recurring_upsert_candidates re-points
--           current_candidate_version_id ONLY for 'suggested'/'withdrawn'
--           series — confirmed/paused keep their locked candidate (verified
--           against the live definition). Any existing manualCadenceOverride
--           flag is preserved by the jsonb merge. Evidence, coverage,
--           counterparty, account are copied verbatim — ONLY the amount
--           fields change.
--  Law 1  — no arithmetic beyond identity: the user's amount IS the expected
--           amount (amountKind flips to 'fixed'); the historical amountSummary
--           is kept verbatim as observation data.
--  Law 10 — Class B: an explicit user action on their own series.
--
-- Payload: { series_id uuid, amount_minor text (signed integer, sign must match
--            the series direction: inflow > 0, outflow < 0),
--            effective_date YYYY-MM-DD, horizon_days int 1..366 }
create or replace function public.keel_recurring_set_amount(
  p_command_id uuid,
  p_economic_event_key text,
  p_actor jsonb,
  p_household_id uuid,
  p_payload jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hash text := public.keel_payload_hash(p_payload);
  v_replay jsonb;
  v_actor jsonb;
  v_series public.recurring_series%rowtype;
  v_old_candidate public.recurring_candidate_versions%rowtype;
  v_new_candidate jsonb;
  v_new_amount text;
  v_effective_date date;
  v_horizon_days integer;
  v_new_fingerprint text;
  v_new_candidate_hash text;
  v_new_candidate_id uuid;
  v_run_id uuid;
  v_before jsonb;
  v_after jsonb;
  v_result jsonb;
  v_projection_start date;
  v_projection_end date;
  v_expected_date date;
  v_effective_transition public.recurring_transition;
  v_occurrence_key text;
  v_occurrence_fingerprint text;
  v_occurrence_evidence jsonb;
  v_timeline_snapshot jsonb;
begin
  perform public.keel_assert_member_write(p_household_id);
  v_actor := public.keel_actor_from_jwt();
  v_replay := public.keel_idempotency_check(p_household_id, p_economic_event_key, v_hash);
  if v_replay is not null then
    return v_replay;
  end if;

  if jsonb_typeof(p_payload) <> 'object'
     or (p_payload - 'series_id' - 'amount_minor' - 'effective_date' - 'horizon_days')
        <> '{}'::jsonb
     or coalesce(p_payload->>'series_id','') !~*
        '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or not (p_payload ? 'amount_minor')
     or not (p_payload ? 'effective_date')
     or coalesce(p_payload->>'horizon_days','') !~ '^[0-9]+$' then
    raise exception 'KEEL_INVALID_COMMAND: malformed set-amount payload'
      using errcode = 'P0009';
  end if;

  -- Signed integer minor units, never zero, no "-0" (Law 4: BIGINT strings).
  v_new_amount := p_payload->>'amount_minor';
  if v_new_amount !~ '^-?(0|[1-9][0-9]*)$' or v_new_amount in ('0','-0') then
    raise exception 'KEEL_INVALID_COMMAND: amount_minor must be a non-zero signed integer'
      using errcode = 'P0009';
  end if;
  begin
    perform v_new_amount::bigint;
  exception when others then
    raise exception 'KEEL_INVALID_COMMAND: amount_minor out of range' using errcode = 'P0009';
  end;

  -- effective_date: canonical Gregorian YYYY-MM-DD.
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

  begin
    v_horizon_days := (p_payload->>'horizon_days')::integer;
  exception when numeric_value_out_of_range then
    raise exception 'KEEL_INVALID_COMMAND: projection horizon is invalid' using errcode = 'P0009';
  end;
  if v_horizon_days not between 1 and 366 then
    raise exception 'KEEL_INVALID_COMMAND: projection horizon must be between 1 and 366'
      using errcode = 'P0009';
  end if;

  -- Lock the series; tenant + account authorization.
  select * into v_series from public.recurring_series
   where household_id = p_household_id and id = (p_payload->>'series_id')::uuid
   for update;
  if not found or not public.keel_recurring_account_access(p_household_id, v_series.account_id, true) then
    raise exception 'KEEL_SCOPE_VIOLATION: recurring series not found' using errcode = 'P0006';
  end if;

  if v_series.status not in ('suggested','confirmed','paused') then
    raise exception 'KEEL_INVALID_COMMAND: cannot set the amount of a % series', v_series.status
      using errcode = 'P0009';
  end if;

  -- The user-entered amount must point the same direction the series flows:
  -- an outflow (subscription/bill) expects a NEGATIVE amount, an inflow a
  -- POSITIVE one — same convention the detector stores and the occurrence
  -- renderer signs by (a mismatch would flip every projection's sign).
  if (v_series.sign = 'outflow' and left(v_new_amount, 1) <> '-')
     or (v_series.sign = 'inflow' and left(v_new_amount, 1) = '-') then
    raise exception 'KEEL_INVALID_COMMAND: amount sign must match the series direction (%)',
      v_series.sign using errcode = 'P0009';
  end if;

  select * into v_old_candidate from public.recurring_candidate_versions
   where household_id = p_household_id
     and id = v_series.current_candidate_version_id
     and series_id = v_series.id;
  if not found then
    raise exception 'KEEL_IDEMPOTENCY_CONFLICT: candidate version is not current'
      using errcode = 'P0007';
  end if;

  -- Corrected candidate: verbatim copy, override ONLY the amount fields. The
  -- user's number is a FIXED expectation from here on (amountKind 'fixed' is
  -- what the projection generator reads representativeAmountMinor for); the
  -- observed amountSummary is retained untouched as historical evidence.
  v_new_candidate := v_old_candidate.candidate
    || jsonb_build_object(
         'amountKind', 'fixed',
         'representativeAmountMinor', v_new_amount,
         'detectorVersion', 'manual-amount-v1',
         'manualAmountOverride', true,
         'asOf', to_char(v_effective_date, 'YYYY-MM-DD')
       );

  v_new_fingerprint := left(public.keel_payload_hash(jsonb_build_object(
    'base', v_old_candidate.input_fingerprint,
    'amountMinor', v_new_amount,
    'override', 'manual-amount-v1'
  )), 40);
  v_new_candidate := v_new_candidate || jsonb_build_object('inputFingerprint', v_new_fingerprint);
  v_new_candidate_hash := public.keel_payload_hash(v_new_candidate);

  insert into public.recurring_detector_runs
    (household_id, run_key, as_of, detector_version, confidence_version, normalizer_version,
     candidate_snapshot_hash)
  values
    (p_household_id, 'manual-amount:' || p_command_id::text,
     v_effective_date::timestamp at time zone 'utc',
     'manual-amount-v1', v_old_candidate.confidence_version, v_old_candidate.normalizer_version,
     v_new_candidate_hash)
  on conflict (household_id, run_key) do update set run_key = excluded.run_key
  returning id into v_run_id;

  insert into public.recurring_candidate_versions
    (household_id, series_id, detector_run_id, candidate_hash, input_fingerprint,
     detector_version, confidence_version, normalizer_version, as_of, score_bps,
     evidence, candidate)
  values
    (p_household_id, v_series.id, v_run_id, v_new_candidate_hash, v_new_fingerprint,
     'manual-amount-v1', v_old_candidate.confidence_version, v_old_candidate.normalizer_version,
     v_effective_date::timestamp at time zone 'utc', v_old_candidate.score_bps,
     v_old_candidate.evidence, v_new_candidate)
  on conflict (household_id, series_id, input_fingerprint) do nothing
  returning id into v_new_candidate_id;
  if v_new_candidate_id is null then
    select id into v_new_candidate_id
      from public.recurring_candidate_versions
     where household_id = p_household_id and series_id = v_series.id
       and input_fingerprint = v_new_fingerprint;
  end if;

  v_before := jsonb_build_object(
    'seriesId', v_series.id,
    'candidateVersionId', v_series.current_candidate_version_id,
    'amountKind', v_old_candidate.candidate->>'amountKind',
    'representativeAmountMinor', v_old_candidate.candidate->>'representativeAmountMinor');

  update public.recurring_series
     set current_candidate_version_id = v_new_candidate_id, updated_at = now()
   where household_id = p_household_id and id = v_series.id;

  -- Re-project occurrences under the NEW candidate, confirmed series only
  -- (mirrors reclassify_cadence / keel_recurring_transition_core).
  if v_series.status = 'confirmed' then
    begin
      v_projection_start := (v_new_candidate->>'lastSeen')::date + 1;
      v_projection_end := v_effective_date + v_horizon_days;
    exception when invalid_datetime_format or datetime_field_overflow then
      raise exception 'KEEL_INVALID_COMMAND: candidate lastSeen is invalid' using errcode = 'P0009';
    end;
    select jsonb_agg(jsonb_build_object(
      'txn_id', evidence_row->>'txnId',
      'batch_id', evidence_row->>'batchId',
      'posting_id', evidence_row->>'postingId'
    ) order by evidence_ordinal) into v_occurrence_evidence
    from jsonb_array_elements(v_new_candidate->'evidence') with ordinality
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
        v_new_candidate, v_projection_start, v_projection_end) cadence
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
        'candidateVersionHash', v_new_candidate_hash,
        'expectedDate', to_char(v_expected_date,'YYYY-MM-DD')
      ));
      v_occurrence_fingerprint := public.keel_payload_hash(jsonb_build_object(
        'candidateInputFingerprint', v_new_fingerprint,
        'expectedDate', to_char(v_expected_date,'YYYY-MM-DD'),
        'statusEvents', v_timeline_snapshot
      ));
      insert into public.recurring_occurrences
        (household_id, series_id, candidate_version_id, occurrence_key,
         expected_date, expected_amount_minor, currency, amount_kind, status,
         matched_txn_id, score_bps, evidence, input_fingerprint,
         detector_version, confidence_version, as_of)
      values
        (p_household_id, v_series.id, v_new_candidate_id, v_occurrence_key,
         v_expected_date, v_new_amount::bigint, v_series.currency,
         'fixed'::public.recurring_amount_kind,
         'expected', null, v_old_candidate.score_bps, v_occurrence_evidence,
         v_occurrence_fingerprint, 'manual-amount-v1',
         v_old_candidate.confidence_version,
         v_effective_date::timestamp at time zone 'utc')
      on conflict (household_id, series_id, candidate_version_id, expected_date) do nothing;
    end loop;
  end if;

  v_after := jsonb_build_object(
    'seriesId', v_series.id,
    'candidateVersionId', v_new_candidate_id,
    'candidateVersionHash', v_new_candidate_hash,
    'amountKind', 'fixed',
    'representativeAmountMinor', v_new_amount,
    'manualAmountOverride', true,
    'effectiveDate', to_char(v_effective_date,'YYYY-MM-DD'));

  v_result := jsonb_build_object(
    'commandId', p_command_id, 'economicEventKey', p_economic_event_key,
    'idempotentReplay', false, 'effects', v_after,
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  );

  insert into public.audit_log
    (household_id, actor, action, object_type, object_id, command_id, before, after)
  values
    (p_household_id, v_actor, 'recurring.set_amount',
     'recurring_series', v_series.id, p_command_id, v_before, v_after);
  insert into public.domain_events
    (event_type, household_id, command_id, economic_event_key, actor, payload)
  values
    ('recurring.set_amount', p_household_id, p_command_id,
     p_economic_event_key, v_actor, v_after);
  insert into public.command_executions
    (household_id, economic_event_key, command_id, command, payload_sha256, result)
  values
    (p_household_id, p_economic_event_key, p_command_id,
     'recurring.set_amount', v_hash, v_result);
  return v_result;
end;
$$;

-- Runtime grants + unprivileged definer. NOTE deliberate deviation from the
-- reclassify_cadence migration's final `revoke ... from authenticated`: the
-- /commands dispatcher calls procs over the USER's JWT (ctx.supabase.rpc →
-- role `authenticated`), so authenticated needs EXECUTE — the live ACLs of
-- every working command proc (cancel, reclassify_cadence, …) carry
-- `authenticated=X` via the later grant-floor migration. Mirroring the
-- original file verbatim reproduced the exact bug that needed
-- 20260723030000: live 500 (permission denied) on first API call, caught by
-- this session's pre-merge live test. anon stays revoked.
revoke all on function public.keel_recurring_set_amount(uuid, text, jsonb, uuid, jsonb)
  from public, anon;
grant execute on function public.keel_recurring_set_amount(uuid, text, jsonb, uuid, jsonb)
  to keel_api, keel_worker, authenticated, service_role;
grant create on schema public to keel_api;
alter function public.keel_recurring_set_amount(uuid, text, jsonb, uuid, jsonb)
  owner to keel_api;
revoke create on schema public from keel_api;
