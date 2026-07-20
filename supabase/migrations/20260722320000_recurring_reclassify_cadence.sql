-- 20260722320000_recurring_reclassify_cadence.sql
-- feat(recurring): editable cadence — user-corrected cadence/anchor for a series.
--
-- APPLY (⚑ human applies live; migration is later than live tip 20260722310000):
--   source supabase/.env.remote
--   psql "postgresql://postgres@db.<ref>.supabase.co:5432/postgres" \
--     -v ON_ERROR_STOP=1 --single-transaction \
--     -f supabase/migrations/20260722320000_recurring_reclassify_cadence.sql
-- No enum change (recurring_cadence already carries 'semimonthly'; day_pair anchor
-- already supported by keel_recurring_cadence_dates since 20260712120000), so this
-- file is a single ordinary --single-transaction apply.
--
-- WHY (founder feedback 2026-07-20): the Deeptune payroll series
-- (1c446787-…) pays on the 15th and the last calendar day of every month
-- (semi-monthly), but detection classified it 'biweekly' (epoch_grid, 14-day).
-- The cadence MODEL already supports semi-monthly end-to-end (enum value +
-- day_pair anchor + month-end-aware keel_recurring_cadence_dates), and the TS
-- detector (packages/detectors, recurring-grid-v2) already emits semimonthlyFits
-- — but there was NO command to CORRECT an already-CONFIRMED series' cadence, so
-- the founder was stuck with the wrong biweekly projection. This adds that
-- command: keel_recurring_reclassify_cadence.
--
-- LAWS:
--  Law 1  — deterministic spine, no LLM arithmetic. Projection reuses the exact
--           integer/calendar keel_recurring_cadence_dates generator.
--  Law 2  — reversible correction, audited. This mints a NEW candidate version
--           (append-only; the prior version and its occurrences are preserved,
--           just no longer 'current'), never mutates the old candidate. A later
--           reclassify (or a fresh detector run under suggested/rejected) can
--           re-point again. Writes audit_log + domain_events + command_executions.
--  Law 7  — one authorized domain contract. Same command envelope + dispatch as
--           every other recurring.* command (web/MCP/support console call this,
--           no side door). Reuses keel_recurring_cadence_dates (the SAME generator
--           the detector's confirm path uses), not a second cadence interpreter.
--  Law 9  — explicit ownership (inference never silently treated as fact): the new
--           candidate is stamped detectorVersion='manual-cadence-v1' +
--           manualCadenceOverride=true so a subsequent detector run does NOT clobber
--           the user's hand-set cadence back to a detector guess. Source preservation:
--           evidence, amountSummary, amounts all copied verbatim from the current
--           candidate — only cadence + cadenceAnchor change. Reproducible numbers:
--           occurrences carry the new input_fingerprint; as_of stamped.
--  Law 10 — Class B (suggest→approve): a user-initiated correction on their own data,
--           requiresApproval already satisfied by the fact the USER issues it (same
--           class as recurring.confirm). No money moves (Class D untouched).
--
-- MECHANISM (no occurrence deletion): recurring_occurrences is immutable
-- (recurring_occurrences_immutable trigger blocks UPDATE/DELETE). We do NOT need to
-- delete stale occurrences: both keel_list_recurring and keel_cash_flow_forecast
-- filter occurrences to ro.candidate_version_id = rs.current_candidate_version_id, so
-- re-pointing current_candidate_version_id to the new version silently switches every
-- projection/forecast to the corrected cadence while the old rows remain as history.

-- ---------------------------------------------------------------------------
-- keel_recurring_reclassify_cadence
--   payload: { series_id uuid,
--              cadence text,               -- one of the recurring_cadence enum labels
--              cadence_anchor jsonb,       -- {kind:'epoch_grid'|'day_of_month'|'day_pair', ...}
--              effective_date 'YYYY-MM-DD',
--              horizon_days int 1..366 }
-- ---------------------------------------------------------------------------
create or replace function public.keel_recurring_reclassify_cadence(
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
  v_new_anchor jsonb;
  v_new_cadence text;
  v_new_fingerprint text;
  v_new_candidate_hash text;
  v_new_candidate_id uuid;
  v_run_id uuid;
  v_effective_date date;
  v_last_effective_date date;
  v_horizon_days integer;
  v_projection_start date;
  v_projection_end date;
  v_expected_date date;
  v_effective_transition public.recurring_transition;
  v_expected_amount text;
  v_occurrence_key text;
  v_occurrence_fingerprint text;
  v_occurrence_evidence jsonb;
  v_timeline_snapshot jsonb;
  v_before jsonb;
  v_after jsonb;
  v_result jsonb;
  v_probe date;
begin
  perform public.keel_assert_member_write(p_household_id);
  v_actor := public.keel_actor_from_jwt();
  v_replay := public.keel_idempotency_check(p_household_id, p_economic_event_key, v_hash);
  if v_replay is not null then return v_replay; end if;

  -- Payload shape: exactly these keys.
  if jsonb_typeof(p_payload) <> 'object'
     or (p_payload - 'series_id' - 'cadence' - 'cadence_anchor'
                   - 'effective_date' - 'horizon_days') <> '{}'::jsonb
     or coalesce(p_payload->>'series_id','') !~*
        '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or not (p_payload ? 'cadence')
     or not (p_payload ? 'cadence_anchor')
     or not (p_payload ? 'effective_date')
     or coalesce(p_payload->>'horizon_days','') !~ '^[0-9]+$' then
    raise exception 'KEEL_INVALID_COMMAND: malformed reclassify payload'
      using errcode = 'P0009';
  end if;

  -- Cadence must be a real enum label (guards the jsonb text that becomes
  -- candidate->>'cadence', which downstream casts to recurring_cadence).
  v_new_cadence := p_payload->>'cadence';
  if v_new_cadence is null
     or not exists (
       select 1 from pg_catalog.pg_enum e
       join pg_catalog.pg_type t on t.oid = e.enumtypid
       where t.typname = 'recurring_cadence' and e.enumlabel = v_new_cadence
     ) then
    raise exception 'KEEL_INVALID_COMMAND: unknown cadence %', coalesce(v_new_cadence,'(null)')
      using errcode = 'P0009';
  end if;

  -- The web API snake-cases the WHOLE payload (toSnakeKeys, recursive), so the
  -- incoming anchor arrives with snake keys (interval_days, anchor_epoch_day,
  -- interval_months). keel_recurring_cadence_dates and the stored candidate jsonb
  -- speak the detector's CAMELCASE anchor (intervalDays, anchorEpochDay,
  -- intervalMonths). Normalize here to a canonical camelCase anchor so both the
  -- projection generator and the persisted candidate stay in the detector's shape.
  -- Accept either casing on input (idempotent: camelCase in -> camelCase out).
  declare v_in jsonb := p_payload->'cadence_anchor';
  begin
    if jsonb_typeof(v_in) <> 'object' then
      raise exception 'KEEL_INVALID_COMMAND: cadence_anchor must be an object'
        using errcode = 'P0009';
    end if;
    if (v_in->>'kind') = 'epoch_grid' then
      v_new_anchor := jsonb_build_object(
        'kind', 'epoch_grid',
        'intervalDays', (coalesce(v_in->'intervalDays', v_in->'interval_days')),
        'anchorEpochDay', (coalesce(v_in->'anchorEpochDay', v_in->'anchor_epoch_day')));
    elsif (v_in->>'kind') = 'day_of_month' then
      v_new_anchor := jsonb_build_object(
        'kind', 'day_of_month',
        'day', v_in->'day',
        'intervalMonths', (coalesce(v_in->'intervalMonths', v_in->'interval_months')),
        'phase', v_in->'phase');
    elsif (v_in->>'kind') = 'day_pair' then
      v_new_anchor := jsonb_build_object('kind', 'day_pair', 'days', v_in->'days');
    else
      raise exception 'KEEL_INVALID_COMMAND: unsupported cadence anchor kind %',
        coalesce(v_in->>'kind','(null)') using errcode = 'P0009';
    end if;
  end;
  if jsonb_typeof(v_new_anchor) <> 'object' then
    raise exception 'KEEL_INVALID_COMMAND: cadence_anchor must be an object'
      using errcode = 'P0009';
  end if;

  -- Cadence <-> anchor.kind must agree (one authoritative mapping, mirrors the
  -- TS detector's cadence/anchor pairing).
  if not (
       (v_new_cadence in ('weekly','biweekly') and v_new_anchor->>'kind' = 'epoch_grid')
    or (v_new_cadence in ('monthly','quarterly','annual') and v_new_anchor->>'kind' = 'day_of_month')
    or (v_new_cadence = 'semimonthly' and v_new_anchor->>'kind' = 'day_pair')
  ) then
    raise exception 'KEEL_INVALID_COMMAND: cadence % does not match anchor kind %',
      v_new_cadence, coalesce(v_new_anchor->>'kind','(null)') using errcode = 'P0009';
  end if;
  -- Extra guard: the epoch interval must match weekly(7)/biweekly(14).
  if v_new_anchor->>'kind' = 'epoch_grid'
     and (
       (v_new_cadence = 'weekly'   and v_new_anchor->>'intervalDays' <> '7')
    or (v_new_cadence = 'biweekly' and v_new_anchor->>'intervalDays' <> '14')
     ) then
    raise exception 'KEEL_INVALID_COMMAND: epoch interval does not match cadence %', v_new_cadence
      using errcode = 'P0009';
  end if;
  -- And monthly/quarterly/annual intervalMonths must match 1/3/12.
  if v_new_anchor->>'kind' = 'day_of_month'
     and (
       (v_new_cadence = 'monthly'   and coalesce(v_new_anchor->>'intervalMonths','1') <> '1')
    or (v_new_cadence = 'quarterly' and v_new_anchor->>'intervalMonths' <> '3')
    or (v_new_cadence = 'annual'    and v_new_anchor->>'intervalMonths' <> '12')
     ) then
    raise exception 'KEEL_INVALID_COMMAND: intervalMonths does not match cadence %', v_new_cadence
      using errcode = 'P0009';
  end if;

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

  -- Only a live (suggested/confirmed/paused) series can be reclassified; a
  -- cancelled/rejected/withdrawn series is terminal (re-detect to revive it).
  if v_series.status not in ('suggested','confirmed','paused') then
    raise exception 'KEEL_INVALID_COMMAND: cannot reclassify a % series', v_series.status
      using errcode = 'P0009';
  end if;

  select * into v_old_candidate from public.recurring_candidate_versions
   where household_id = p_household_id
     and id = v_series.current_candidate_version_id
     and series_id = v_series.id;
  if not found then
    raise exception 'KEEL_IDEMPOTENCY_CONFLICT: candidate version is not current'
      using errcode = 'P0007';
  end if;

  -- Validate the new anchor by test-projecting one month with the SAME generator
  -- the confirm path uses (keel_recurring_cadence_dates raises P0009 on a bad
  -- anchor). Deterministic, side-effect-free.
  begin
    select cadence.expected_date into v_probe
      from public.keel_recurring_cadence_dates(
        jsonb_build_object('cadenceAnchor', v_new_anchor),
        v_effective_date, v_effective_date + 62) cadence
     limit 1;
  exception when sqlstate 'P0009' then
    raise;
  end;

  -- Build the corrected candidate: copy the current candidate verbatim (evidence,
  -- amounts, counterparty, account — Law 9 source preservation) and override ONLY
  -- cadence + cadenceAnchor, stamping manual provenance so detection never
  -- silently reverts it (Law 9 explicit ownership).
  v_new_candidate := v_old_candidate.candidate
    || jsonb_build_object(
         'cadence', v_new_cadence,
         'cadenceAnchor', v_new_anchor,
         'detectorVersion', 'manual-cadence-v1',
         'manualCadenceOverride', true,
         'asOf', to_char(v_effective_date, 'YYYY-MM-DD')
       );

  -- New identity: fingerprint must be UNIQUE per (household, series) and stable
  -- for idempotent replay of the SAME correction. Derive it from the prior
  -- fingerprint + the new cadence/anchor (not from wall-clock), so a replay lands
  -- on the SAME row via the unique (household_id, series_id, input_fingerprint).
  v_new_fingerprint := left(public.keel_payload_hash(jsonb_build_object(
    'base', v_old_candidate.input_fingerprint,
    'cadence', v_new_cadence,
    'cadenceAnchor', v_new_anchor,
    'override', 'manual-cadence-v1'
  )), 40);
  v_new_candidate := v_new_candidate || jsonb_build_object('inputFingerprint', v_new_fingerprint);
  v_new_candidate_hash := public.keel_payload_hash(v_new_candidate);

  -- A detector run row is required by the candidate FK. Reuse a manual-override run
  -- keyed to this command so replay is a no-op.
  insert into public.recurring_detector_runs
    (household_id, run_key, as_of, detector_version, confidence_version, normalizer_version,
     candidate_snapshot_hash)
  values
    (p_household_id, 'manual-cadence:' || p_command_id::text,
     v_effective_date::timestamp at time zone 'utc',
     'manual-cadence-v1', v_old_candidate.confidence_version, v_old_candidate.normalizer_version,
     v_new_candidate_hash)
  on conflict (household_id, run_key) do update set run_key = excluded.run_key
  returning id into v_run_id;

  insert into public.recurring_candidate_versions
    (household_id, series_id, detector_run_id, candidate_hash, input_fingerprint,
     detector_version, confidence_version, normalizer_version, as_of, score_bps,
     evidence, candidate)
  values
    (p_household_id, v_series.id, v_run_id, v_new_candidate_hash, v_new_fingerprint,
     'manual-cadence-v1', v_old_candidate.confidence_version, v_old_candidate.normalizer_version,
     v_effective_date::timestamp at time zone 'utc', v_old_candidate.score_bps,
     v_old_candidate.evidence, v_new_candidate)
  on conflict (household_id, series_id, input_fingerprint) do nothing
  returning id into v_new_candidate_id;
  if v_new_candidate_id is null then
    -- Exact same correction already recorded (idempotent within-session or a prior
    -- non-current version). Re-point to it and re-project below.
    select id into v_new_candidate_id
      from public.recurring_candidate_versions
     where household_id = p_household_id and series_id = v_series.id
       and input_fingerprint = v_new_fingerprint;
  end if;

  v_before := jsonb_build_object(
    'seriesId', v_series.id,
    'candidateVersionId', v_series.current_candidate_version_id,
    'cadence', v_old_candidate.candidate->>'cadence',
    'cadenceAnchor', v_old_candidate.candidate->'cadenceAnchor');

  update public.recurring_series
     set current_candidate_version_id = v_new_candidate_id, updated_at = now()
   where household_id = p_household_id and id = v_series.id;

  -- Re-project occurrences under the NEW candidate version, but ONLY if the series
  -- is confirmed (a suggested/paused series has no live projection to refresh; it
  -- will project on its next confirm/resume). Mirrors keel_recurring_transition_core.
  if v_series.status = 'confirmed' then
    begin
      v_projection_start := (v_new_candidate->>'lastSeen')::date + 1;
      v_projection_end := v_effective_date + v_horizon_days;
    exception when invalid_datetime_format or datetime_field_overflow then
      raise exception 'KEEL_INVALID_COMMAND: candidate lastSeen is invalid' using errcode = 'P0009';
    end;
    v_expected_amount := case v_new_candidate->>'amountKind'
      when 'fixed' then v_new_candidate->>'representativeAmountMinor'
      when 'variable' then v_new_candidate->'amountSummary'->>'lowerMedianMinor'
      else null
    end;
    if coalesce(v_expected_amount,'') !~ '^-?(0|[1-9][0-9]*)$' or v_expected_amount = '-0' then
      raise exception 'KEEL_INVALID_COMMAND: candidate amount derivation is invalid'
        using errcode = 'P0009';
    end if;
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
         v_expected_date, v_expected_amount::bigint, v_series.currency,
         (v_new_candidate->>'amountKind')::public.recurring_amount_kind,
         'expected', null, v_old_candidate.score_bps, v_occurrence_evidence,
         v_occurrence_fingerprint, 'manual-cadence-v1',
         v_old_candidate.confidence_version,
         v_effective_date::timestamp at time zone 'utc')
      on conflict (household_id, series_id, candidate_version_id, expected_date) do nothing;
    end loop;
  end if;

  v_after := jsonb_build_object(
    'seriesId', v_series.id,
    'candidateVersionId', v_new_candidate_id,
    'candidateVersionHash', v_new_candidate_hash,
    'cadence', v_new_cadence,
    'cadenceAnchor', v_new_anchor,
    'manualCadenceOverride', true,
    'effectiveDate', to_char(v_effective_date,'YYYY-MM-DD'));

  v_result := jsonb_build_object(
    'commandId', p_command_id, 'economicEventKey', p_economic_event_key,
    'idempotentReplay', false, 'effects', v_after,
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  );

  insert into public.audit_log
    (household_id, actor, action, object_type, object_id, command_id, before, after)
  values
    (p_household_id, v_actor, 'recurring.reclassify_cadence',
     'recurring_series', v_series.id, p_command_id, v_before, v_after);
  insert into public.domain_events
    (event_type, household_id, command_id, economic_event_key, actor, payload)
  values
    ('recurring.reclassify_cadence', p_household_id, p_command_id,
     p_economic_event_key, v_actor, v_after);
  insert into public.command_executions
    (household_id, economic_event_key, command_id, command, payload_sha256, result)
  values
    (p_household_id, p_economic_event_key, p_command_id,
     'recurring.reclassify_cadence', v_hash, v_result);
  return v_result;
end;
$$;

-- Runtime grant + unprivileged definer (mirrors the other recurring.* commands).
grant execute on function public.keel_recurring_reclassify_cadence(uuid, text, jsonb, uuid, jsonb)
  to keel_api, keel_worker;
alter function public.keel_recurring_reclassify_cadence(uuid, text, jsonb, uuid, jsonb)
  owner to keel_api;
revoke all on function public.keel_recurring_reclassify_cadence(uuid, text, jsonb, uuid, jsonb)
  from public, anon;
