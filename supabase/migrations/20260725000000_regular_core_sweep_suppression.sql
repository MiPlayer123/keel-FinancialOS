-- Pair-gated suppression of regular-sync (`/transactions/sync`) core-account
-- money-market sweeps. Confirmed live bug: the Fidelity cash-management
-- connection (7e9bdccf-8fdc-4bdd-9805-5f3d4ac526e6, household
-- a1ba3759-b7a7-4880-93e2-49eb6f91636c) reports the SPAXX internal bookkeeping
-- step ("PURCHASE INTO CORE ACCOUNT" / "REDEMPTION FROM CORE ACCOUNT" /
-- "REINVESTMENT ... CORE ACCOUNT") AND the real external step ("TRANSFERRED TO
-- VS Z37-...", "Electronic Funds Transfer Received") as two SEPARATE real Plaid
-- `/transactions/sync` transactions (distinct provider ids, same date, exactly
-- offsetting amounts). Both post as real ledger rows, so the per-row running
-- balance in the register swings wildly (confirmed: a mid-list -$24,951.76
-- balance on an account whose true balance is $48.24) even though the total is
-- correct — a display/double-booking artifact.
--
-- This is the SAME class of bug 20260721060000_investment_flow_classifier.sql
-- already fixed on the `/investments/transactions/get` path, using a
-- structured signal (investment flow + cash-equivalent security) that does NOT
-- exist on the regular sync path (packages/providers/plaid/src/adapter.ts's
-- sync mapper carries only id/account/amount/date/description/pending).
--
-- Design (independent review) with two corrections applied here:
--   1. CONNECTION-ID allowlist, not institution_id: the live Fidelity
--      connection has institution_id = NULL in production (finalize-link only
--      captures it when Plaid's Link flow supplies one), so an institution_id
--      gate would silently never fire. `regular_core_sweep_allowlist` is a
--      small (household_id, connection_id) table — adding a future connection
--      is a one-row INSERT, no code change/redeploy.
--   2. The counterpart transfer-description anchor is written
--      `^TRANSFERRED (TO|FROM)([[:space:]]|$)`, not the design doc's literal
--      `\b` — PostgreSQL's Advanced Regular Expression dialect does not treat
--      `\b` as a word-boundary metacharacter (that is PCRE syntax; in ARE `\y`
--      is the word-boundary atom and `\b` is backspace inside a bracket
--      expression / an error outside one). The `[[:space:]]|$` anchor is the
--      same house idiom already used two lines below for the sweep regex.
--
-- PAIR-GATED, not a blanket description match: candidate detection AND
-- same-day/same-account/exact-opposite-amount pairing must BOTH hold, and both
-- sides of the pair must have UNAMBIGUOUS (degree-1) matches, before anything
-- is voided. An unmatched core-sweep-looking row is left alone (a visible miss
-- is fine; an invisible wrong suppression is not). AI-risk-ladder Class A
-- (auto+undo, Law 10) — deterministic, reversible, no fuzzy judgment call.
--
-- Laws honored: Σ postings = 0 (Law 3, BIGINT minor units Law 4); VOID via
-- reversal batch + voided_at, never hard-DELETE (standing directive); every
-- suppression is reversible via keel_cmd_restore_regular_core_sweep (Law 2);
-- idempotent (Law 9 — advisory lock + evidence-hash fingerprinting + a partial
-- unique index prevent double-suppression on replay).

-- ===========================================================================
-- 1. Allowlist table. Append-only (no legitimate reason to un-list a
-- connection once reviewed; a household disconnecting the item just stops
-- generating candidates). FK is tenant-scoped via connections'
-- (household_id, id) composite unique (20260711120000).
-- ===========================================================================
create table public.regular_core_sweep_allowlist (
  household_id  uuid not null references public.households (id),
  connection_id uuid not null references public.connections (id),
  note          text check (note is null or length(note) between 1 and 500),
  added_at      timestamptz not null default now(),
  primary key (household_id, connection_id),
  constraint fk_core_sweep_allowlist_tenant foreign key (household_id, connection_id)
    references public.connections (household_id, id)
);

create trigger regular_core_sweep_allowlist_immutable
  before update or delete on public.regular_core_sweep_allowlist
  for each row execute function public.keel_forbid_mutation();

alter table public.regular_core_sweep_allowlist enable row level security;
revoke all on public.regular_core_sweep_allowlist from anon, authenticated;
grant select on public.regular_core_sweep_allowlist to authenticated, service_role;
create policy regular_core_sweep_allowlist_member_read on public.regular_core_sweep_allowlist
  for select to authenticated
  using (exists (
    select 1 from public.household_memberships m
     where m.household_id = regular_core_sweep_allowlist.household_id and m.user_id = auth.uid()
  ));

-- Seed the ONE reviewed, evidenced connection. Guarded by `where exists` so
-- this is a no-op on any database that doesn't have this exact live
-- connection row (fresh/local/CI/test databases) — it only takes effect once
-- applied to the real cloud project where this connection actually exists.
insert into public.regular_core_sweep_allowlist (household_id, connection_id, note)
select c.household_id, c.id,
       'Live Fidelity cash-management connection — confirmed SPAXX core-sweep '
       || 'double-booking (distinct paired Plaid txns, same-day, exactly '
       || 'offsetting). Reviewed 2026-07-25.'
  from public.connections c
 where c.id = '7e9bdccf-8fdc-4bdd-9805-5f3d4ac526e6'::uuid
   and c.household_id = 'a1ba3759-b7a7-4880-93e2-49eb6f91636c'::uuid
on conflict (household_id, connection_id) do nothing;

-- ===========================================================================
-- 2. Suppression provenance table. One row per suppressed (candidate,
-- counterpart) pair. Never DELETEd — a restore sets released_at/reason and the
-- row remains as the permanent history + re-suppression guard (its
-- evidence_hash blocks the identical pair from being immediately re-voided by
-- the next reconcile pass — see step 2 of the RPC below).
-- ===========================================================================
create table public.regular_core_sweep_suppressions (
  id                            uuid primary key default gen_random_uuid(),
  household_id                  uuid not null references public.households (id),
  connection_id                 uuid not null references public.connections (id),
  account_id                    uuid not null references public.accounts (id),
  candidate_transaction_id      uuid not null references public.canonical_transactions (id),
  counterpart_transaction_id    uuid not null references public.canonical_transactions (id),
  candidate_source_record_id    uuid references public.normalized_source_records (id),
  counterpart_source_record_id  uuid references public.normalized_source_records (id),
  original_batch_id             uuid not null references public.journal_batches (id),
  reversal_batch_id             uuid not null references public.journal_batches (id),
  restore_batch_id              uuid references public.journal_batches (id),
  prior_status                  public.transaction_status not null,
  evidence_hash                 text not null check (evidence_hash ~ '^[a-f0-9]{64}$'),
  command_id                    uuid not null,
  created_at                    timestamptz not null default now(),
  released_at                   timestamptz,
  release_reason                text check (
    (released_at is null and release_reason is null)
    or (released_at is not null and length(release_reason) between 1 and 500)
  ),
  check (candidate_transaction_id <> counterpart_transaction_id)
);

-- Only ONE active (unreleased) suppression may exist per candidate / per
-- counterpart at a time (strict 1:1, matches the pairing's degree-1 rule).
create unique index regular_core_sweep_suppressions_active_candidate
  on public.regular_core_sweep_suppressions (candidate_transaction_id)
  where released_at is null;
create unique index regular_core_sweep_suppressions_active_counterpart
  on public.regular_core_sweep_suppressions (counterpart_transaction_id)
  where released_at is null;
create index regular_core_sweep_suppressions_household
  on public.regular_core_sweep_suppressions (household_id);
create index regular_core_sweep_suppressions_evidence
  on public.regular_core_sweep_suppressions (evidence_hash);

alter table public.regular_core_sweep_suppressions enable row level security;
revoke all on public.regular_core_sweep_suppressions from anon, authenticated;
grant select on public.regular_core_sweep_suppressions to authenticated, service_role;
grant select, insert, update on public.regular_core_sweep_suppressions to keel_api, keel_worker;
create policy regular_core_sweep_suppressions_member_read on public.regular_core_sweep_suppressions
  for select to authenticated
  using (exists (
    select 1 from public.household_memberships m
     where m.household_id = regular_core_sweep_suppressions.household_id and m.user_id = auth.uid()
  ));
create policy regular_core_sweep_suppressions_definer_all on public.regular_core_sweep_suppressions
  for all to keel_api, keel_worker using (true) with check (true);

-- ===========================================================================
-- 3. keel_reconcile_regular_core_sweeps(household_id, connection_id) — the
-- detection + pairing + suppression RPC. Mirrors the style/conventions of
-- keel_detect_transfers (20260721060000) and
-- keel_worker_ingest_investment_txn's core-sweep-suppression-on-restatement
-- branch (same migration): SECURITY DEFINER, search_path, an auth.uid()-gated
-- membership check (so it is safely callable by an authenticated user too,
-- not just the service-role worker), grants to authenticated + service_role.
-- ===========================================================================
create or replace function public.keel_reconcile_regular_core_sweeps(
  p_household_id uuid,
  p_connection_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_account_id uuid;
  v_candidates_considered int := 0;
  v_excluded_by_policy int := 0;
  v_ambiguous_skipped int := 0;
  v_suppressed int := 0;
  r record;
  v_prior_status public.transaction_status;
  v_candidate_voided_at timestamptz;
  v_command_id uuid;
  v_apply_key text;
  v_hash text;
  v_replay jsonb;
  v_reversal_id uuid;
  v_live_batch_id uuid;
  v_result jsonb;
begin
  if auth.uid() is not null and not exists (
    select 1 from public.household_memberships
    where household_id = p_household_id and user_id = auth.uid()
  ) then
    raise exception 'KEEL_NOT_FOUND' using errcode = 'P0006';
  end if;

  if not exists (
    select 1 from public.connections c
     where c.id = p_connection_id and c.household_id = p_household_id
  ) then
    raise exception 'KEEL_SCOPE_VIOLATION: connection not in household' using errcode = 'P0006';
  end if;

  -- Allowlist gate (correction #1 above): short-circuit cheaply for every
  -- household/connection except the reviewed few. Returning a zero summary
  -- (not an error) keeps this safe to call unconditionally from the sync/
  -- refresh pipeline for every connection.
  if not exists (
    select 1 from public.regular_core_sweep_allowlist a
     where a.household_id = p_household_id and a.connection_id = p_connection_id
  ) then
    return jsonb_build_object(
      'suppressed', 0, 'candidatesConsidered', 0, 'excludedByPolicy', 0,
      'ambiguousSkipped', 0, 'allowlisted', false);
  end if;

  -- Account-scoped advisory locks (one per cash-management account this
  -- connection could ever produce a candidate on), sorted for deterministic
  -- lock ordering. Prevents this RPC from racing itself when invoked
  -- concurrently from both the end-of-sync-attempt call site and the
  -- periodic refresh-balances recovery pass.
  for v_account_id in
    select a.id from public.accounts a
     where a.household_id = p_household_id
       and a.connection_id = p_connection_id
       and a.subtype = 'cash management'
       and a.archived_at is null
     order by a.id
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('core_sweep_account:' || v_account_id::text, 0));
  end loop;

  -- -------------------------------------------------------------------------
  -- candidatesConsidered / excludedByPolicy: every row matching the BASE
  -- sweep pattern (regex + PFC corroboration + subtype/source/split-guard +
  -- not-already-actively-suppressed), REGARDLESS of whether a counterpart was
  -- found — an unmatched sweep-looking row still counts as "considered", it
  -- just never gets suppressed. Split out separately from the policy
  -- exclusions (transfer_links/reconciliation/period-lock/overrides/
  -- documents) so the backfill script (which reuses this same RPC rather than
  -- duplicating the predicate) can report an honest "already excluded due to
  -- locks/links/reconciliation" bucket instead of that count silently
  -- vanishing into "considered but not suppressed for no visible reason".
  -- -------------------------------------------------------------------------
  with cash_leg as (
    select ct.id as txn_id, ct.household_id, ct.entity_id, ct.account_id,
           ct.effective_date, ct.description, ct.source, ct.economic_event_key,
           acc.connection_id, acc.subtype, jb.id as batch_id
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
  candidates_base as (
    select cl.txn_id,
           exists (
             select 1 from public.transfer_links tl
              where tl.status in ('suggested', 'confirmed')
                and (tl.txn_out = cl.txn_id or tl.txn_in = cl.txn_id)
           ) as excl_transfer_link,
           exists (
             select 1 from public.reconciliation_items ri
              where ri.household_id = cl.household_id and ri.transaction_id = cl.txn_id
           ) as excl_reconciled,
           exists (
             select 1 from public.period_locks pl
              where pl.household_id = cl.household_id
                and (pl.entity_id is null or pl.entity_id = cl.entity_id)
                and pl.reopened_at is null
                and cl.effective_date between pl.start_date and pl.end_date
           ) as excl_locked,
           exists (
             select 1 from public.transaction_overrides tov
              where tov.canonical_transaction_id = cl.txn_id
           ) as excl_override,
           exists (
             select 1 from public.document_attachments da
              where da.canonical_transaction_id = cl.txn_id and da.detached_at is null
           ) as excl_document
      from cash_leg cl
     where cl.connection_id = p_connection_id
       and cl.subtype = 'cash management'
       and cl.source = 'sync'
       and cl.economic_event_key like 'txn:plaid:%'
       and btrim(cl.description)
             ~* '^(REDEMPTION FROM|PURCHASE INTO|REINVESTMENT( INTO| IN)?) CORE ACCOUNT([[:space:]]|$)'
       and exists (
         select 1 from public.transaction_source_links tsl
         join public.normalized_source_records nsr on nsr.id = tsl.normalized_source_record_id
        where tsl.canonical_transaction_id = cl.txn_id
          and nsr.pfc_primary in ('TRANSFER_IN', 'TRANSFER_OUT')
       )
       and (select count(*) from public.journal_postings jp2 where jp2.batch_id = cl.batch_id) = 2
       and not exists (
         select 1 from public.regular_core_sweep_suppressions s
          where s.candidate_transaction_id = cl.txn_id and s.released_at is null
       )
  )
  select count(distinct txn_id),
         count(distinct txn_id) filter (
           where excl_transfer_link or excl_reconciled or excl_locked or excl_override or excl_document
         )
    into v_candidates_considered, v_excluded_by_policy
    from candidates_base;

  -- -------------------------------------------------------------------------
  -- Main pass: candidates joined to their same-account/same-day/exact-
  -- opposite-amount counterpart, with BOTH sides' exclusions applied and a
  -- strict degree-1 uniqueness check on both sides. Duplicates the CTE text
  -- above deliberately (same idiom as keel_detect_transfers' three near-
  -- identical tiers) rather than threading state through a temp table.
  -- -------------------------------------------------------------------------
  for r in
    with cash_leg as (
      select ct.id as txn_id, ct.household_id, ct.entity_id, ct.account_id,
             ct.effective_date, ct.description, ct.status, ct.source, ct.economic_event_key,
             acc.connection_id, acc.subtype, p.amount_minor, p.currency, jb.id as batch_id
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
    candidates as (
      select cl.*
        from cash_leg cl
       where cl.connection_id = p_connection_id
         and cl.subtype = 'cash management'
         and cl.source = 'sync'
         and cl.economic_event_key like 'txn:plaid:%'
         and btrim(cl.description)
               ~* '^(REDEMPTION FROM|PURCHASE INTO|REINVESTMENT( INTO| IN)?) CORE ACCOUNT([[:space:]]|$)'
         and exists (
           select 1 from public.transaction_source_links tsl
           join public.normalized_source_records nsr on nsr.id = tsl.normalized_source_record_id
          where tsl.canonical_transaction_id = cl.txn_id
            and nsr.pfc_primary in ('TRANSFER_IN', 'TRANSFER_OUT')
         )
         and (select count(*) from public.journal_postings jp2 where jp2.batch_id = cl.batch_id) = 2
         and not exists (
           select 1 from public.transfer_links tl
            where tl.status in ('suggested', 'confirmed')
              and (tl.txn_out = cl.txn_id or tl.txn_in = cl.txn_id)
         )
         and not exists (
           select 1 from public.reconciliation_items ri
            where ri.household_id = cl.household_id and ri.transaction_id = cl.txn_id
         )
         and not exists (
           select 1 from public.period_locks pl
            where pl.household_id = cl.household_id
              and (pl.entity_id is null or pl.entity_id = cl.entity_id)
              and pl.reopened_at is null
              and cl.effective_date between pl.start_date and pl.end_date
         )
         and not exists (
           select 1 from public.transaction_overrides tov where tov.canonical_transaction_id = cl.txn_id
         )
         and not exists (
           select 1 from public.document_attachments da
            where da.canonical_transaction_id = cl.txn_id and da.detached_at is null
         )
         and not exists (
           select 1 from public.regular_core_sweep_suppressions s
            where s.candidate_transaction_id = cl.txn_id and s.released_at is null
         )
    ),
    pair_candidates as (
      select c.txn_id as candidate_txn, c.household_id, c.connection_id, c.account_id,
             c.entity_id, c.effective_date, c.batch_id as candidate_batch_id,
             c.status as candidate_status,
             k.txn_id as counterpart_txn, k.batch_id as counterpart_batch_id
        from candidates c
        join cash_leg k
          on k.account_id = c.account_id
         and k.currency = c.currency
         and k.effective_date = c.effective_date
         and k.amount_minor = -c.amount_minor
         and k.txn_id <> c.txn_id
       where
         -- Counterpart must NOT itself look like a sweep (it's the real leg).
         not (btrim(k.description)
               ~* '^(REDEMPTION FROM|PURCHASE INTO|REINVESTMENT( INTO| IN)?) CORE ACCOUNT([[:space:]]|$)')
         and (
           exists (
             select 1 from public.transaction_source_links tsl
             join public.normalized_source_records nsr on nsr.id = tsl.normalized_source_record_id
            where tsl.canonical_transaction_id = k.txn_id
              and nsr.pfc_primary in ('TRANSFER_IN', 'TRANSFER_OUT')
           )
           -- Corrected anchor vs the design doc's literal `\b` — see header.
           or btrim(k.description) ~* '^TRANSFERRED (TO|FROM)([[:space:]]|$)'
         )
         and (select count(*) from public.journal_postings jp3 where jp3.batch_id = k.batch_id) = 2
         and not exists (
           select 1 from public.transfer_links tl
            where tl.status in ('suggested', 'confirmed')
              and (tl.txn_out = k.txn_id or tl.txn_in = k.txn_id)
         )
         and not exists (
           select 1 from public.reconciliation_items ri
            where ri.household_id = k.household_id and ri.transaction_id = k.txn_id
         )
         and not exists (
           select 1 from public.period_locks pl
            where pl.household_id = k.household_id
              and (pl.entity_id is null or pl.entity_id = k.entity_id)
              and pl.reopened_at is null
              and k.effective_date between pl.start_date and pl.end_date
         )
         and not exists (
           select 1 from public.transaction_overrides tov where tov.canonical_transaction_id = k.txn_id
         )
         and not exists (
           select 1 from public.document_attachments da
            where da.canonical_transaction_id = k.txn_id and da.detached_at is null
         )
         and not exists (
           select 1 from public.regular_core_sweep_suppressions s
            where s.counterpart_transaction_id = k.txn_id and s.released_at is null
         )
    ),
    scored as (
      select pc.*,
             count(*) over (partition by pc.candidate_txn) as candidate_degree,
             count(*) over (partition by pc.counterpart_txn) as counterpart_degree,
             public.keel_payload_hash(jsonb_build_object(
               'candidateTxnId', pc.candidate_txn::text,
               'counterpartTxnId', pc.counterpart_txn::text)) as evidence_hash
        from pair_candidates pc
    )
    select * from scored
    order by candidate_txn
  loop
    -- Strict 1:1 uniqueness: skip (never guess) if either side is ambiguous.
    if r.candidate_degree > 1 or r.counterpart_degree > 1 then
      v_ambiguous_skipped := v_ambiguous_skipped + 1;
      continue;
    end if;

    -- Rejected-fingerprint guard: a pair a human already RESTORED (released)
    -- with this exact evidence fingerprint must not be immediately
    -- re-suppressed by this same pass or the next one.
    if exists (
      select 1 from public.regular_core_sweep_suppressions rs
       where rs.released_at is not null and rs.evidence_hash = r.evidence_hash
    ) then
      continue;
    end if;

    -- Defensive re-check (Codex-review house pattern): lock both canonical
    -- rows and re-verify the pair still holds before mutating anything, in
    -- case something changed between the detection query above and here
    -- (e.g. a concurrent transfer confirmation or override on a DIFFERENT
    -- account not covered by this call's advisory locks).
    perform 1 from public.canonical_transactions where id = r.candidate_txn for update;
    perform 1 from public.canonical_transactions where id = r.counterpart_txn for update;

    select ct.status, ct.voided_at into v_prior_status, v_candidate_voided_at
      from public.canonical_transactions ct where ct.id = r.candidate_txn;
    if v_candidate_voided_at is not null then
      continue;  -- raced with something else; skip, next pass will re-evaluate
    end if;
    if exists (
      select 1 from public.transfer_links tl
       where tl.status in ('suggested', 'confirmed')
         and (tl.txn_out in (r.candidate_txn, r.counterpart_txn)
              or tl.txn_in in (r.candidate_txn, r.counterpart_txn))
    ) then
      continue;
    end if;
    if exists (
      select 1 from public.reconciliation_items ri
       where ri.household_id = r.household_id
         and ri.transaction_id in (r.candidate_txn, r.counterpart_txn)
    ) then
      continue;
    end if;

    -- Live batch to reverse (re-fetched fresh under lock; a plain local
    -- variable, not a write into the FOR-loop record, to keep the record
    -- read-only and avoid any ambiguity about SELECT INTO targeting a record
    -- field mid-loop).
    select b.id into v_live_batch_id
      from public.journal_batches b
     where b.canonical_transaction_id = r.candidate_txn
       and b.reverses_batch_id is null
       and not exists (select 1 from public.journal_revisions rev where rev.original_batch_id = b.id)
     order by b.posted_at desc
     limit 1;
    if v_live_batch_id is null then
      continue;  -- nothing live to reverse; skip rather than error
    end if;

    v_command_id := gen_random_uuid();
    v_apply_key := 'core-sweep-suppress:' || r.candidate_txn::text;
    v_hash := r.evidence_hash;
    v_replay := public.keel_idempotency_check(p_household_id, v_apply_key, v_hash);
    if v_replay is not null then
      continue;  -- already processed by an earlier concurrent/replayed pass
    end if;

    insert into public.journal_batches
      (household_id, canonical_transaction_id, description, effective_date,
       reverses_batch_id, command_id)
    values
      (p_household_id, r.candidate_txn, 'REVERSAL: regular-sync core-account sweep suppression',
       r.effective_date, v_live_batch_id, v_command_id)
    returning id into v_reversal_id;

    insert into public.journal_postings (batch_id, ledger_account_id, entity_id, amount_minor, currency)
    select v_reversal_id, p.ledger_account_id, p.entity_id, -p.amount_minor, p.currency
      from public.journal_postings p where p.batch_id = v_live_batch_id;

    insert into public.journal_revisions
      (original_batch_id, reversal_batch_id, replacement_batch_id, reason)
    values (v_live_batch_id, v_reversal_id, null, 'regular-sync core-account sweep suppression');

    update public.canonical_transactions
       set status = 'voided', voided_at = now()
     where id = r.candidate_txn;

    -- Clear only SUGGESTED transfer links this now-voided candidate
    -- participated in (no decider, freely re-derived); a CONFIRMED link is a
    -- real decision and is left for manual review (same posture as the
    -- investment classifier's identical guard).
    delete from public.transfer_links
     where household_id = p_household_id
       and status = 'suggested'
       and (txn_out = r.candidate_txn or txn_in = r.candidate_txn);

    insert into public.regular_core_sweep_suppressions
      (household_id, connection_id, account_id, candidate_transaction_id,
       counterpart_transaction_id, candidate_source_record_id, counterpart_source_record_id,
       original_batch_id, reversal_batch_id, prior_status, evidence_hash, command_id)
    values
      (p_household_id, p_connection_id, r.account_id, r.candidate_txn,
       r.counterpart_txn,
       (select tsl.normalized_source_record_id
          from public.transaction_source_links tsl
          join public.normalized_source_records nsr on nsr.id = tsl.normalized_source_record_id
         where tsl.canonical_transaction_id = r.candidate_txn
         order by nsr.created_at desc, nsr.id desc limit 1),
       (select tsl.normalized_source_record_id
          from public.transaction_source_links tsl
          join public.normalized_source_records nsr on nsr.id = tsl.normalized_source_record_id
         where tsl.canonical_transaction_id = r.counterpart_txn
         order by nsr.created_at desc, nsr.id desc limit 1),
       v_live_batch_id, v_reversal_id, v_prior_status, v_hash, v_command_id);

    v_result := jsonb_build_object(
      'commandId', v_command_id,
      'economicEventKey', v_apply_key,
      'idempotentReplay', false,
      'effects', jsonb_build_object(
        'kind', 'core_sweep_suppressed',
        'candidateTransactionId', r.candidate_txn,
        'counterpartTransactionId', r.counterpart_txn,
        'reversalBatchId', v_reversal_id),
      'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
    );
    perform public.keel_finish_command(
      v_command_id, 'ingest.regular_core_sweep_reconcile', v_apply_key, p_household_id,
      jsonb_build_object('kind', 'system', 'processName', 'core-sweep-reconciler'),
      v_hash, 'ingest.regular_core_sweep_suppressed', 'canonical_transaction', r.candidate_txn,
      jsonb_build_object('candidateTransactionId', r.candidate_txn,
                         'counterpartTransactionId', r.counterpart_txn),
      v_result);

    v_suppressed := v_suppressed + 1;
  end loop;

  return jsonb_build_object(
    'suppressed', v_suppressed,
    'candidatesConsidered', v_candidates_considered,
    'excludedByPolicy', v_excluded_by_policy,
    'ambiguousSkipped', v_ambiguous_skipped,
    'allowlisted', true
  );
end;
$$;

revoke all on function public.keel_reconcile_regular_core_sweeps(uuid, uuid) from public, anon;
grant execute on function public.keel_reconcile_regular_core_sweeps(uuid, uuid)
  to authenticated, service_role;
-- No ownership reassignment (stays owned by the migration role, same as
-- keel_detect_transfers/keel_cash_flow_monthly/keel_list_transactions_rich —
-- none of which reassign ownership either): it therefore already has full
-- access to keel_finish_command/keel_idempotency_check without any extra
-- grant. Deliberately NOT granting authenticated execute on those two
-- internal helpers here — 20260710210600_command_procs.sql explicitly
-- revoked them from authenticated, and this migration must not silently
-- re-open direct client access to internal command-bookkeeping primitives.

-- ===========================================================================
-- 4. keel_cmd_restore_regular_core_sweep — the undo command. Standard KEEL
-- command-proc shape (mirrors keel_cmd_reanchor_balance /
-- keel_cmd_set_opening_balance conventions): p_command_id/p_economic_event_key
-- /p_actor/p_household_id/p_payload, keel_assert_member_write,
-- keel_actor_from_jwt (forgery guard), keel_idempotency_check,
-- keel_finish_command. Owned by keel_api like the other keel_cmd_* procs.
-- Backend-only for v1 (no UI button per human decision) — still built as a
-- normal authenticated-callable command so a future UI can dispatch it via
-- the same `/api/commands` envelope with zero proc changes.
-- ===========================================================================
create or replace function public.keel_cmd_restore_regular_core_sweep(
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
  v_suppression_id uuid := nullif(p_payload->>'suppression_id', '')::uuid;
  v_supp public.regular_core_sweep_suppressions%rowtype;
  v_candidate public.canonical_transactions%rowtype;
  v_batch_id uuid;
  v_reason text := coalesce(nullif(p_payload->>'reason', ''), 'manual restore');
  v_result jsonb;
begin
  perform public.keel_assert_member_write(p_household_id);
  p_actor := public.keel_actor_from_jwt();  -- ignore caller-supplied actor (forgery guard)
  v_replay := public.keel_idempotency_check(p_household_id, p_economic_event_key, v_hash);
  if v_replay is not null then
    return v_replay;
  end if;

  if v_suppression_id is null then
    raise exception 'KEEL_INVALID_COMMAND: suppression_id is required' using errcode = 'P0009';
  end if;

  select * into v_supp
    from public.regular_core_sweep_suppressions
   where id = v_suppression_id and household_id = p_household_id
   for update;
  if not found then
    raise exception 'KEEL_SCOPE_VIOLATION: suppression not in household' using errcode = 'P0006';
  end if;
  if v_supp.released_at is not null then
    raise exception 'KEEL_INVALID_COMMAND: suppression already restored' using errcode = 'P0009';
  end if;

  select * into v_candidate
    from public.canonical_transactions
   where id = v_supp.candidate_transaction_id and household_id = p_household_id
   for update;
  if not found then
    raise exception 'KEEL_SCOPE_VIOLATION: candidate transaction not in household'
      using errcode = 'P0006';
  end if;

  -- Period-lock precheck on the date being re-posted (Law 2 — locks are never
  -- bypassed, even by an undo).
  if exists (
    select 1 from public.period_locks l
     where l.household_id = p_household_id
       and (l.entity_id is null or l.entity_id = v_candidate.entity_id)
       and l.reopened_at is null
       and v_candidate.effective_date between l.start_date and l.end_date
  ) then
    raise exception 'KEEL_PERIOD_LOCKED: % falls in a locked period', v_candidate.effective_date
      using errcode = 'P0003';
  end if;

  -- Re-post the ORIGINAL postings verbatim as a fresh batch (copy of the
  -- batch the suppression reversed, not the reversal itself). No new
  -- journal_revisions link: the suppression's own revision row
  -- (original_batch_id=v_supp.original_batch_id, replacement_batch_id=null)
  -- already fully captures that history; the voided_at -> null flip plus this
  -- fresh live batch are the audit signal a restore occurred — exactly the
  -- precedent set by the investment classifier's sweep-to-real un-void path
  -- (20260721060000).
  insert into public.journal_batches
    (household_id, canonical_transaction_id, description, effective_date, command_id)
  values
    (p_household_id, v_candidate.id, 'RESTORE: core-sweep suppression reversed',
     v_candidate.effective_date, p_command_id)
  returning id into v_batch_id;

  insert into public.journal_postings (batch_id, ledger_account_id, entity_id, amount_minor, currency)
  select v_batch_id, p.ledger_account_id, p.entity_id, p.amount_minor, p.currency
    from public.journal_postings p where p.batch_id = v_supp.original_batch_id;

  update public.canonical_transactions
     set status = v_supp.prior_status, voided_at = null
   where id = v_candidate.id;

  update public.regular_core_sweep_suppressions
     set released_at = now(), release_reason = v_reason, restore_batch_id = v_batch_id
   where id = v_supp.id;

  v_result := jsonb_build_object(
    'commandId', p_command_id,
    'economicEventKey', p_economic_event_key,
    'idempotentReplay', false,
    'effects', jsonb_build_object(
      'suppressionId', v_supp.id,
      'candidateTransactionId', v_candidate.id,
      'restoreBatchId', v_batch_id
    ),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  );

  perform public.keel_finish_command(
    p_command_id, 'ingest.restore_regular_core_sweep', p_economic_event_key, p_household_id, p_actor,
    v_hash, 'ingest.regular_core_sweep_restored', 'canonical_transaction', v_candidate.id,
    jsonb_build_object('suppressionId', v_supp.id, 'candidateTransactionId', v_candidate.id),
    v_result
  );

  return v_result;
end;
$$;

grant create on schema public to keel_api;
alter function public.keel_cmd_restore_regular_core_sweep(uuid, text, jsonb, uuid, jsonb) owner to keel_api;
revoke all on function public.keel_cmd_restore_regular_core_sweep(uuid, text, jsonb, uuid, jsonb)
  from public, anon;
revoke create on schema public from keel_api;
grant execute on function public.keel_cmd_restore_regular_core_sweep(uuid, text, jsonb, uuid, jsonb)
  to authenticated, service_role;

-- ===========================================================================
-- 5. Companion restatement-safety review (design's explicit ask): does
-- keel_worker_apply_action / keel_worker_lookup_state need a defensive change
-- so a suppressed-and-voided row isn't misreported to the sync planner as
-- "provider removed" when Plaid's own diff didn't remove it?
--
-- VERIFIED against the live planner (packages/ingest/src/plan.ts, current
-- body as of this migration) — NO CHANGE NEEDED, for two independent reasons:
--
--   1. planModified (plan.ts) already short-circuits to noop/'already_applied'
--      whenever `prev.status === 'voided'` (line ~150), BEFORE it would ever
--      emit a 'revise' action. So a later Plaid 'modified' event on a
--      candidate this RPC just voided never reaches
--      keel_worker_apply_action's revise branch at all — the branch that
--      raises KEEL_IMMUTABLE when it finds "no live batch to correct"
--      (20260713090000_subcategories.sql:377-379) is unreachable for this
--      case.
--   2. planRemoved similarly short-circuits to noop on `current.status ===
--      'voided'` — a genuine provider-side removal of an already-voided
--      candidate is a no-op, not a double-void.
--
-- The one theoretical gap is a Plaid pending->posted MINT (a NEW provider
-- transaction id P2 with pendingTransactionId=P1, where P1 is the candidate
-- this RPC already voided): planAdded's supersession branch only fires when
-- `pending?.status === 'pending'` (plan.ts ~line 112), so once P1 reads
-- 'voided' the check falls through to a plain 'create' for P2 — a BRAND NEW
-- canonical with its OWN economic key. This is not a permanent double-count:
-- P2 is a fresh, unsuppressed candidate that this RPC's OWN next invocation
-- (same-sync-attempt call site below, or the next periodic recovery pass)
-- re-evaluates from scratch and suppresses on its own merits (the query
-- excludes only ACTIVELY-suppressed candidates, so a brand-new row is fully
-- eligible). In practice this scenario is unlikely for these sweep rows
-- anyway — Fidelity's SPAXX core-sweep and TRANSFERRED-TO/FROM lines are
-- confirmed to post directly (not through a pending->posted transition) — but
-- even if it occurred, it self-heals within one reconcile cycle rather than
-- corrupting anything. Documented here per the task's explicit instruction to
-- verify against actual code rather than blindly patch "because the design
-- doc said so."
-- ===========================================================================
