-- Return reaper-withdrawn series from keel_list_recurring.
--
-- 20260719031000 added `and series_row.status <> 'withdrawn'` so a reaped
-- stale suggestion "is never shown". That was right when nothing could act on
-- one — but it also made auto-withdrawn series (the nightly
-- keel_recurring_reap_stale_suggestions run) silently unrecoverable from the
-- UI: the state machine has always allowed confirm-from-withdrawn
-- (keel_recurring_transition_core), yet the read model hid the rows, so the
-- web app could never offer the Restore. On the founder household 25 series
-- sit invisible in 'withdrawn' — including, at one point, the payroll series.
--
-- The web app now renders a "Stopped by KEEL" lane with a Restore action
-- (PR #165), so the filter is removed. Consumers are status-driven and
-- unaffected: the dashboard renders confirmed only, the Paychecks detected
-- list confirmed|suggested, and the Recurring page's lanes filter
-- suggested/confirmed/paused explicitly — withdrawn rows surface ONLY in the
-- new lane. The occurrence-status mapping below (withdrawn -> 'cancelled')
-- already renders a withdrawn series' occurrences as not-expected, which stays
-- correct. Everything else in the body is byte-identical to the live
-- definition this replaces.

CREATE OR REPLACE FUNCTION public.keel_list_recurring(p_household_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
      and public.keel_recurring_account_access(p_household_id, series_row.account_id, false)
  ) row;
  return jsonb_build_object(
    'scope', jsonb_build_object('householdId', p_household_id),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'formulaVersion', 'recurring-grid-v1',
    'rows', v_rows
  );
end;
$function$;
