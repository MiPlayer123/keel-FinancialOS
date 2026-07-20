-- fix(recurring): make a USER DISMISSAL of a recurring suggestion durable so the
-- next detection run does NOT resurface it.
--
-- ROOT CAUSE (traced read-only on the live founder household 2026-07-19..-20):
--   keel_recurring_upsert_candidates (live def; introduced in
--   20260719031000_recurring_exclude_transfers_and_reap_stale.sql:358-370)
--   RE-SUGGESTS any series whose materialized status is in
--     ('suggested', 'rejected', 'withdrawn')
--   the moment a fresh detection run writes a NEW candidate version for it
--   (v_inserted = true, i.e. the underlying transactions changed enough to
--   produce a different input_fingerprint). For a genuinely-active series (e.g.
--   an ongoing payroll deposit) that happens on nearly every run. The block
--   unconditionally sets `status = 'suggested'` and re-points
--   current_candidate_version_id, OVERWRITING the user's dismissal.
--
--   'rejected' is a USER action ("I don't want this tracked"); it is a DIFFERENT
--   fact from 'withdrawn' (a SYSTEM reap that means "the detector stopped seeing
--   this", which legitimately comes back when re-detected — see 20260719030000).
--   Treating them identically means a user dismissal never sticks.
--
--   LIVE PROOF (series 56565ad6-f20d-44c3-851f-1096daddf9ba, rillavoice payroll):
--     2026-07-19 15:00  candidate c260862d… suggested
--     2026-07-19 17:25  EVENT withdrawn        (system reap)
--     2026-07-19 19:39  EVENT rejected         (USER dismissed; status -> rejected)
--     2026-07-20 03:00  daily cron re-detects: NEW candidate 52449bd2…,
--                       audit 'recurring.suggested' with before-status 'rejected',
--                       recurring_series.status flipped rejected -> SUGGESTED.
--   The append-only recurring_status_events timeline still ends at 'rejected'
--   (source preservation held), but the materialized status was overwritten, so
--   the dismissed series reappeared on Review. Multiple founder series show the
--   same "…-> rejected@<date>" timeline with a live status of 'suggested'.
--
-- THE FIX (deterministic, minimal — Law 1: no model logic):
--   Remove 'rejected' from the re-suggestion predicate. A rejected series is left
--   ENTIRELY untouched by detection: its materialized status stays 'rejected' and
--   its current_candidate_version_id stays pinned to the candidate the user saw
--   and rejected. 'suggested' (re-point to the freshest candidate) and 'withdrawn'
--   (a system-retracted stale suggestion legitimately re-detected) keep their
--   existing behavior; 'confirmed'/'paused'/'cancelled' keep their locked
--   candidate exactly as before.
--
--   The NEW candidate version row is STILL inserted for a rejected series (the
--   INSERT ... ON CONFLICT block above the predicate is unchanged), so detector
--   history stays complete and append-only (Law 9 source preservation) and a
--   later re-confirm still has fresh evidence available — we simply do not let
--   detection flip the user's terminal 'rejected' state.
--
-- REVERSIBILITY (Law 2): unchanged and intact. keel_recurring_transition_core
--   still allows 'rejected' -> 'confirmed' (20260719130000 line 121), so a user
--   can UN-dismiss by confirming; the pinned current candidate is exactly what
--   they rejected. This migration does not touch that path.
--
-- WHY NO SEPARATE GUARD TABLE (unlike detected_paycheck_dismissals, 20260719090000):
--   The recurring domain ALREADY carries a durable, append-only dismissal record
--   keyed to the series identity — the 'rejected' row in recurring_status_events
--   plus recurring_series.status. The series_key (counterparty + account + sign +
--   cadence fingerprint) is stable across runs and the series row is upserted
--   ON CONFLICT (household_id, series_key) DO NOTHING, so a re-detected identical
--   pattern maps back to the SAME series row that already holds the rejection.
--   The bug was never a missing record; it was the upsert overwriting that record.
--   So the correct, smallest fix is to stop the overwrite, not to add a parallel
--   table. (This mirrors the transfer-detector "never resurrect a rejected link"
--   rule: on-conflict keep the terminal state.)
--
-- Body is byte-identical to the live definition (verified via pg_get_functiondef
-- 2026-07-19) except the single predicate change on the re-suggestion branch and
-- an updated comment. Same signature -> CREATE OR REPLACE keeps the ACL; the
-- worker-owned definer ownership + grants are re-asserted (grant-create ->
-- alter-owner -> revoke-create wrapper) so a fresh apply cannot leave it
-- postgres-owned or lose EXECUTE. No table/column/enum change -> export DTO,
-- pgTAP allowlist, and the web status union are all unaffected.
--
-- Migration timestamp: live tip is 20260720280000 and the founder has parallel
-- 20260721* work in flight (verified: none of those in this worktree); 20260722
-- is clearly later than both and non-colliding.
--
-- FILE ONLY — never applied to any remote DB by this agent. The orchestrator
-- applies it (single-transaction psql, live cloud project) after review.
-- Validated on a throwaway plain Postgres 17 cluster (see NOTES / pgTAP below).

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
      -- 20260722010000 (dismissal-durable fix): 'rejected' is a DELIBERATE USER
      -- dismissal and is NO LONGER re-suggested by detection. Only 'suggested'
      -- (re-point to the freshest candidate) and 'withdrawn' (a system-reaped
      -- stale suggestion legitimately re-detected — 20260719030000) come back.
      -- A 'rejected' series is left untouched: status stays 'rejected' and its
      -- current_candidate_version_id stays pinned to the candidate the user saw
      -- and rejected, so a later user-initiated 'rejected' -> 'confirmed'
      -- (reversible, Law 2) confirms exactly that. The NEW candidate version was
      -- still recorded above (append-only history preserved).
      -- 'confirmed'/'paused'/'cancelled' keep their locked candidate.
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

-- Ownership/grants must match the original definition (worker-owned definer).
-- grant-create -> alter-owner -> revoke-create wrapper: without CREATE on schema
-- public the ALTER FUNCTION ... OWNER TO keel_worker raises 'permission denied
-- for schema public' (prior slices hit this).
grant create on schema public to keel_worker;
alter function public.keel_recurring_upsert_candidates(uuid,text,timestamptz,text,text,text,jsonb)
  owner to keel_worker;
revoke create on schema public from keel_worker;
revoke all on function public.keel_recurring_upsert_candidates(uuid,text,timestamptz,text,text,text,jsonb)
  from public, anon, authenticated;
grant execute on function public.keel_recurring_upsert_candidates(uuid,text,timestamptz,text,text,text,jsonb)
  to service_role;

-- Ownership sanity: no recurring runtime SECURITY DEFINER left postgres-owned,
-- and the runtime definers stay unprivileged (mirrors 20260719031000's tail).
do $$
begin
  if exists (select 1 from pg_roles where rolname in ('keel_api','keel_worker')
    and (rolcanlogin or rolbypassrls or rolsuper)) then
    raise exception 'KEEL_OWNERSHIP: recurring definer role is privileged';
  end if;
  if exists (
    select 1 from pg_proc proc
    join pg_namespace namespace on namespace.oid = proc.pronamespace
    join pg_roles owner_role on owner_role.oid = proc.proowner
    where namespace.nspname = 'public' and proc.proname like 'keel%recurring%'
      and proc.proname not like 'keel_cron_%'
      and proc.proname not like 'keel_export_%'
      and proc.prosecdef and owner_role.rolname not in ('keel_api','keel_worker')
  ) then
    raise exception 'KEEL_OWNERSHIP: recurring definer has unexpected owner';
  end if;
end
$$;
