-- Dedupe reconnect duplicates ON archived accounts + auto-archive superseded
-- accounts at link-finalize (Stage 1 spine correction; Law 9 idempotent
-- economics / one economic history; Law 2 reversible correction; BC-v2.1 §9.1
-- invariants 3+5; CLAUDE.md soft-delete directive).
--
-- PROBLEM (verified live, household a1ba3759, 2026-07-19): after the Fidelity
-- disconnect->reconnect, the ARCHIVED account "Cash Management (Individual)"
-- (connection a08bc4aa, archived by 20260719120000) still carries NON-VOIDED
-- canonical transactions that are exact duplicates of transactions the ACTIVE
-- reconnected account "Fidelity (Individual)" (connection 7e9bdccf) re-pulled
-- under its own economic-key namespace. Both copies are posted and categorized,
-- so keel_cash_flow double-counts them (e.g. the 2026-05-29 money-market
-- dividend appears twice as Income). keel_cmd_dedupe_reconnect_account
-- (20260718061000) cannot fix this: it was designed to run BEFORE archiving --
-- its reader requires the old account un-archived, and it voids the NEW side,
-- keeping the OLD copies authoritative. Once the old account is archived the
-- roles invert: the ACTIVE account is the live system of record (it keeps
-- syncing, it is anchored, it is what net worth counts), so the duplicate
-- copies to void are the ones on the ARCHIVED account.
--
-- CRITICAL asymmetry (why matching must be one-to-one and conservative): some
-- archived-account transactions have NO active-side copy yet (live example:
-- the 2026-06-30 dividend exists ONLY on the archived account because the new
-- connection has not delivered it). Those are the sole record of a real
-- economic event and MUST NOT be voided. If the active connection later
-- delivers its own copy, a re-run of this command pairs and voids the archived
-- copy then -- history converges onto the active account with each economic
-- event counted exactly once (Law 9).
--
-- Shape:
--   1. keel_archived_duplicate_pairs      -- the matching core, single-sourced
--      (same predicate family as keel_cmd_dedupe_reconnect_account: same
--      household, same effective_date, same description, same cash-posting
--      amount+currency, rank-paired one-to-one so legitimate same-day
--      identical transactions never double-claim a match).
--   2. keel_list_archived_duplicate_matches -- read-only review surface
--      (suggest->approve, Law 2: the user sees exactly what would be voided
--      before triggering anything).
--   3. keel_cmd_dedupe_archived_duplicates -- the user-triggered command.
--      Voids the ARCHIVED-side copy via the standard reversal mechanism
--      (reversal batch + journal_revisions + status='voided'/voided_at +
--      audit_log). Never DELETEs. Idempotent on re-run (voided rows leave the
--      candidate set). Reversible (the void is itself a plain journal
--      reversal; un-voiding is a compensating re-reversal + clearing
--      voided_at -- nothing is destroyed).
--   4. keel_archive_superseded_accounts + keel_finalize_link replacement --
--      prevent recurrence: when a new connection's accounts are linked, any
--      same-institution, same-fingerprint (mask, or name+subtype when either
--      side lacks a mask) account on a DISCONNECTED connection is
--      soft-archived (archived_at + audit rows, never DELETE), and its
--      connection is archived once all of its accounts are. Ordering vs.
--      dedupe stops being load-bearing because (1)-(3) work on archived
--      accounts.

-- ---------------------------------------------------------------------------
-- 1. Matching core. Given a validated (old archived account, new active
-- account) pair, return the one-to-one duplicate transaction pairs. The OLD
-- txn is the void candidate; the NEW txn is the surviving copy. Rank pairing
-- (row_number over account/date/amount/currency/description) mirrors
-- keel_cmd_dedupe_reconnect_account so two identical same-day real
-- transactions on the old side match at most two identical copies on the new
-- side -- never one claiming both.
--
-- CAPACITY OFFSET (property-test finding, this migration's pgTAP suite):
-- because THIS command voids the OLD side, a naive live-rows-only rank join is
-- not idempotent when a duplicate group is asymmetric. Example: two identical
-- archived twins, ONE active copy. Run 1 voids twin #1 (rank 1 <-> rank 1).
-- On re-run twin #2 would re-rank to 1 and pair with the SAME active copy --
-- voiding a second real economic event (Law 9 violation: two events, one
-- surviving record). So already-voided old-side copies keep consuming match
-- capacity: an old live row at rank k only pairs with active rank
-- k + (voided old copies in the same date/amount/currency/description group).
-- Run 1: rank 1 pairs, rank 2 finds no active rank 2 -> preserved. Re-run:
-- the survivor needs active rank 2 -> none -> no-op. (Old-side voids from any
-- source count, which only ever makes matching MORE conservative.)
-- ---------------------------------------------------------------------------
create or replace function public.keel_archived_duplicate_pairs(
  p_household_id uuid,
  p_old_account_id uuid,
  p_new_account_id uuid
) returns table (
  old_txn_id uuid,
  new_txn_id uuid,
  effective_date date,
  description text,
  amount_minor bigint,
  currency char(3)
)
language sql
security definer
set search_path = public
stable
as $$
  with cash as (
    select ct.id as txn_id, ct.effective_date, ct.description, acc.id as account_id,
           p.amount_minor, p.currency
      from public.canonical_transactions ct
      join public.journal_batches jb
        on jb.canonical_transaction_id = ct.id and jb.reverses_batch_id is null
       and not exists (select 1 from public.journal_revisions rev where rev.original_batch_id = jb.id)
      join public.journal_postings p on p.batch_id = jb.id
      join public.ledger_accounts la on la.id = p.ledger_account_id and la.is_category = false
      join public.accounts acc on acc.ledger_account_id = la.id
     where ct.household_id = p_household_id
       and ct.voided_at is null
       and acc.id in (p_old_account_id, p_new_account_id)
  ),
  -- Old-side copies already voided (their original batch is revised by the
  -- void reversal, so they need their own lookup: the txn's FIRST non-reversal
  -- batch carries the original cash posting).
  voided_old as (
    select ct.effective_date, ct.description, x.amount_minor, x.currency,
           count(*) as n_prior
      from public.canonical_transactions ct
      cross join lateral (
        select p.amount_minor, p.currency
          from public.journal_batches jb
          join public.journal_postings p on p.batch_id = jb.id
          join public.ledger_accounts la on la.id = p.ledger_account_id and la.is_category = false
         where jb.canonical_transaction_id = ct.id
           and jb.reverses_batch_id is null
         order by jb.posted_at asc, jb.id asc
         limit 1
      ) x
     where ct.household_id = p_household_id
       and ct.account_id = p_old_account_id
       and ct.voided_at is not null
     group by 1, 2, 3, 4
  ),
  ranked as (
    select *, row_number() over (
      partition by account_id, effective_date, amount_minor, currency, description
      order by txn_id
    ) as rn
    from cash
  )
  select ol.txn_id as old_txn_id,
         nw.txn_id as new_txn_id,
         ol.effective_date,
         ol.description,
         ol.amount_minor,
         ol.currency
    from ranked ol
    left join voided_old vo
      on vo.effective_date = ol.effective_date
     and vo.amount_minor = ol.amount_minor
     and vo.currency = ol.currency
     and vo.description = ol.description
    join ranked nw
      on ol.account_id = p_old_account_id
     and nw.account_id = p_new_account_id
     and nw.effective_date = ol.effective_date
     and nw.amount_minor = ol.amount_minor
     and nw.currency = ol.currency
     and nw.description = ol.description
     and nw.rn = ol.rn + coalesce(vo.n_prior, 0)
$$;

-- ---------------------------------------------------------------------------
-- 2. Read: review surface. An account match is an ARCHIVED account (on a
-- disconnected connection) whose institution + fingerprint coincides with an
-- ACTIVE connection's un-archived account in the same household -- the same
-- predicate keel_list_reconnect_matches uses, with the old side archived
-- instead of live. duplicateCount previews exactly how many transactions the
-- command would void. Purely informational -- no state is written by looking.
-- ---------------------------------------------------------------------------
create or replace function public.keel_list_archived_duplicate_matches(p_household_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_uid uuid := coalesce(
    nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
    nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid;
  v_rows jsonb;
begin
  if v_uid is null then
    raise exception 'KEEL_NOT_AUTHENTICATED' using errcode = 'P0004';
  end if;
  if not exists (
    select 1 from public.household_memberships m
     where m.household_id = p_household_id and m.user_id = v_uid
  ) then
    raise exception 'KEEL_SCOPE_VIOLATION' using errcode = 'P0006';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'oldAccountId', old_acc.id,
    'oldAccountName', old_acc.name,
    'oldAccountArchivedAt', to_char(old_acc.archived_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'oldConnectionId', old_conn.id,
    'newAccountId', new_acc.id,
    'newAccountName', new_acc.name,
    'duplicateCount', (
      select count(*) from public.keel_archived_duplicate_pairs(
        p_household_id, old_acc.id, new_acc.id)
    )
  ) order by old_acc.name), '[]'::jsonb)
    into v_rows
    from public.accounts old_acc
    join public.connections old_conn
      on old_conn.id = old_acc.connection_id and old_conn.status = 'disconnected'
    join public.accounts new_acc
      on new_acc.household_id = old_acc.household_id
     and new_acc.id <> old_acc.id
     and new_acc.archived_at is null
     and (
       (old_acc.mask is not null and new_acc.mask is not null and old_acc.mask = new_acc.mask)
       or (
         (old_acc.mask is null or new_acc.mask is null)
         and old_acc.name = new_acc.name
         and old_acc.subtype = new_acc.subtype
       )
     )
    join public.connections new_conn
      on new_conn.id = new_acc.connection_id and new_conn.status = 'active'
     and new_conn.institution_id is not distinct from old_conn.institution_id
   where old_acc.household_id = p_household_id
     and old_acc.archived_at is not null;

  return jsonb_build_object(
    'scope', jsonb_build_object('householdId', p_household_id),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'rows', v_rows
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Write: accounts.dedupe_archived -> keel_cmd_dedupe_archived_duplicates.
-- User-triggered (not automatic), re-runnable (voided transactions leave the
-- matching set, so a second run finds nothing new). Payload:
--   { "old_account_id": <archived account>, "new_account_id": <active account> }
-- Voids the OLD (archived-side) copy of each matched pair; the ACTIVE copy
-- survives as the single economic history. Same reversal mechanism as
-- keel_cmd_dedupe_reconnect_account: reversal batch negating every posting of
-- the primary batch + journal_revisions row + status='voided'/voided_at.
-- ---------------------------------------------------------------------------
create or replace function public.keel_cmd_dedupe_archived_duplicates(
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
  v_new_account_id uuid;
  v_old_account_id uuid;
  v_new_acc record;
  v_old_acc record;
  v_pair record;
  v_locked_voided_at timestamptz;
  v_batch public.journal_batches%rowtype;
  v_reversal_id uuid;
  v_voided_count int := 0;
  v_voided_ids uuid[] := '{}';
  v_result jsonb;
begin
  perform public.keel_assert_member_write(p_household_id);
  p_actor := public.keel_actor_from_jwt();
  v_replay := public.keel_idempotency_check(p_household_id, p_economic_event_key, v_hash);
  if v_replay is not null then
    return v_replay;
  end if;

  v_new_account_id := (p_payload->>'new_account_id')::uuid;
  v_old_account_id := (p_payload->>'old_account_id')::uuid;

  select a.id, a.currency, a.name, a.subtype, a.mask, a.archived_at, la.kind,
         c.status as connection_status, c.institution_id
    into v_new_acc
    from public.accounts a
    join public.ledger_accounts la on la.id = a.ledger_account_id
    left join public.connections c on c.id = a.connection_id
   where a.id = v_new_account_id and a.household_id = p_household_id;
  if not found then
    raise exception 'KEEL_SCOPE_VIOLATION: new account not in household' using errcode = 'P0006';
  end if;

  select a.id, a.currency, a.name, a.subtype, a.mask, a.archived_at, la.kind,
         c.status as connection_status, c.institution_id
    into v_old_acc
    from public.accounts a
    join public.ledger_accounts la on la.id = a.ledger_account_id
    left join public.connections c on c.id = a.connection_id
   where a.id = v_old_account_id and a.household_id = p_household_id;
  if not found then
    raise exception 'KEEL_SCOPE_VIOLATION: old account not in household' using errcode = 'P0006';
  end if;

  if v_new_acc.id = v_old_acc.id then
    raise exception 'KEEL_INVALID_COMMAND: cannot dedupe an account against itself' using errcode = 'P0009';
  end if;
  -- Old side must be ARCHIVED and on a disconnected connection: this command
  -- exists precisely for the post-archive state keel_cmd_dedupe_reconnect_account
  -- cannot reach. (Pre-archive reconnect dedupe keeps using that command.)
  if v_old_acc.archived_at is null then
    raise exception 'KEEL_INVALID_COMMAND: the old account must be archived (use accounts.dedupe_reconnect before archiving)'
      using errcode = 'P0009';
  end if;
  if v_old_acc.connection_status is distinct from 'disconnected' then
    raise exception 'KEEL_INVALID_COMMAND: the old account''s connection must be disconnected'
      using errcode = 'P0009';
  end if;
  -- New side must be the live system of record.
  if v_new_acc.archived_at is not null then
    raise exception 'KEEL_INVALID_COMMAND: the new account must not be archived' using errcode = 'P0009';
  end if;
  if v_new_acc.connection_status is distinct from 'active' then
    raise exception 'KEEL_INVALID_COMMAND: the new account''s connection must be active'
      using errcode = 'P0009';
  end if;
  if v_new_acc.currency <> v_old_acc.currency or v_new_acc.kind <> v_old_acc.kind then
    raise exception 'KEEL_INVALID_COMMAND: accounts must match currency and kind' using errcode = 'P0009';
  end if;

  -- Same account-identity predicate as the reconnect dedupe (review finding
  -- r3606990724 carried over): institution must match and the fingerprint
  -- (mask, or name+subtype when either side lacks a mask) must coincide --
  -- otherwise coincidental same-day/same-amount/same-description transactions
  -- between genuinely UNRELATED accounts could get voided.
  if v_old_acc.institution_id is distinct from v_new_acc.institution_id then
    raise exception
      'KEEL_INVALID_COMMAND: accounts are not at the same institution -- not a reconnect match'
      using errcode = 'P0009';
  end if;
  if not (
    (v_old_acc.mask is not null and v_new_acc.mask is not null and v_old_acc.mask = v_new_acc.mask)
    or (
      (v_old_acc.mask is null or v_new_acc.mask is null)
      and v_old_acc.name = v_new_acc.name
      and v_old_acc.subtype = v_new_acc.subtype
    )
  ) then
    raise exception
      'KEEL_INVALID_COMMAND: accounts do not match by mask (or name+subtype) -- not a reconnect match'
      using errcode = 'P0009';
  end if;

  for v_pair in
    select * from public.keel_archived_duplicate_pairs(
      p_household_id, v_old_acc.id, v_new_acc.id)
  loop
    -- Lock the candidate row and re-check voided_at before reversing (same
    -- serialization pattern as keel_cmd_dedupe_reconnect_account, review
    -- finding r3606990731): the pairing query ran unlocked, so a concurrent
    -- run (double-clicked button) could otherwise select the SAME candidate
    -- before either commits and reverse it twice.
    select voided_at into v_locked_voided_at
      from public.canonical_transactions
     where id = v_pair.old_txn_id
     for update;
    if v_locked_voided_at is not null then
      continue;
    end if;

    select jb.* into v_batch
      from public.journal_batches jb
     where jb.canonical_transaction_id = v_pair.old_txn_id
       and jb.reverses_batch_id is null
       and not exists (select 1 from public.journal_revisions rev where rev.original_batch_id = jb.id)
     order by jb.posted_at desc, jb.id desc
     limit 1;
    if not found then
      continue;
    end if;

    insert into public.journal_batches
      (household_id, canonical_transaction_id, description, effective_date, reverses_batch_id, command_id)
    values
      (p_household_id, v_pair.old_txn_id,
       left('VOID: archived-account duplicate of active reconnected history', 500),
       v_batch.effective_date, v_batch.id, p_command_id)
    returning id into v_reversal_id;

    insert into public.journal_postings (batch_id, ledger_account_id, entity_id, amount_minor, currency)
    select v_reversal_id, p.ledger_account_id, p.entity_id, -p.amount_minor, p.currency
      from public.journal_postings p
     where p.batch_id = v_batch.id;

    insert into public.journal_revisions (original_batch_id, reversal_batch_id, reason)
    values (v_batch.id, v_reversal_id, 'archived-account duplicate of active reconnected history');

    update public.canonical_transactions
       set status = 'voided', voided_at = now()
     where id = v_pair.old_txn_id;

    v_voided_count := v_voided_count + 1;
    v_voided_ids := v_voided_ids || v_pair.old_txn_id;
  end loop;

  v_result := jsonb_build_object(
    'commandId', p_command_id,
    'economicEventKey', p_economic_event_key,
    'idempotentReplay', false,
    'effects', jsonb_build_object(
      'newAccountId', v_new_acc.id,
      'oldAccountId', v_old_acc.id,
      'voidedCount', v_voided_count,
      'voidedTransactionIds', to_jsonb(v_voided_ids)
    ),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  );

  perform public.keel_finish_command(
    p_command_id, 'accounts.dedupe_archived', p_economic_event_key, p_household_id, p_actor,
    v_hash, 'accounts.archived_deduped', 'account', v_old_acc.id,
    jsonb_build_object('newAccountId', v_new_acc.id, 'voidedCount', v_voided_count),
    v_result
  );

  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4a. Prevent recurrence: soft-archive superseded accounts once a reconnect's
-- accounts exist. Called from keel_finalize_link (below) after the new
-- connection's accounts are created. For each new account, any un-archived
-- account in the same household on a DISCONNECTED connection at the same
-- institution with the same fingerprint (mask, or name+subtype when either
-- side lacks a mask) is superseded: archived_at is set (never DELETE --
-- CLAUDE.md soft-delete directive; raw_provider_events and postings survive,
-- Law 9 source preservation) with one audit row per account. A disconnected
-- connection whose accounts are all archived is then archived itself.
-- Idempotent: already-archived rows are excluded from the candidate set.
--
-- Dedupe ordering is NOT load-bearing: keel_cmd_dedupe_archived_duplicates
-- (above) matches archived old accounts, so voiding duplicate history remains
-- available (suggest->approve) after this auto-archive runs.
-- ---------------------------------------------------------------------------
create or replace function public.keel_archive_superseded_accounts(
  p_household_id uuid,
  p_new_connection_id uuid,
  p_actor jsonb,
  p_command_id uuid
) returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old record;
  v_conn record;
  v_archived int := 0;
begin
  for v_old in
    select distinct old_acc.id, old_acc.connection_id, new_acc.id as new_account_id
      from public.accounts new_acc
      join public.connections new_conn on new_conn.id = new_acc.connection_id
      join public.accounts old_acc
        on old_acc.household_id = new_acc.household_id
       and old_acc.id <> new_acc.id
       and old_acc.archived_at is null
       and (
         (old_acc.mask is not null and new_acc.mask is not null and old_acc.mask = new_acc.mask)
         or (
           (old_acc.mask is null or new_acc.mask is null)
           and old_acc.name = new_acc.name
           and old_acc.subtype = new_acc.subtype
         )
       )
      join public.connections old_conn
        on old_conn.id = old_acc.connection_id
       and old_conn.id <> p_new_connection_id
       and old_conn.status = 'disconnected'
       and old_conn.institution_id is not distinct from new_conn.institution_id
     where new_acc.connection_id = p_new_connection_id
       and new_acc.household_id = p_household_id
       and new_acc.archived_at is null
  loop
    update public.accounts
       set archived_at = now()
     where id = v_old.id and archived_at is null;
    if found then
      v_archived := v_archived + 1;
      insert into public.audit_log
        (household_id, actor, action, object_type, object_id, command_id, before, after)
      values
        (p_household_id, p_actor, 'account.archived', 'account', v_old.id, p_command_id,
         jsonb_build_object('archived_at', null),
         jsonb_build_object('archived_at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                            'reason', 'superseded_by_reconnect',
                            'supersededByAccountId', v_old.new_account_id,
                            'supersededByConnectionId', p_new_connection_id));
    end if;
  end loop;

  -- Archive any disconnected connection left with no un-archived accounts.
  for v_conn in
    select c.id
      from public.connections c
     where c.household_id = p_household_id
       and c.id <> p_new_connection_id
       and c.status = 'disconnected'
       and c.archived_at is null
       and exists (select 1 from public.accounts a
                    where a.connection_id = c.id and a.archived_at is not null)
       and not exists (select 1 from public.accounts a
                        where a.connection_id = c.id and a.archived_at is null)
  loop
    update public.connections set archived_at = now() where id = v_conn.id;
    insert into public.audit_log
      (household_id, actor, action, object_type, object_id, command_id, before, after)
    values
      (p_household_id, p_actor, 'connection.archived', 'connection', v_conn.id, p_command_id,
       jsonb_build_object('status', 'disconnected', 'archived_at', null),
       jsonb_build_object('status', 'disconnected',
                          'archived_at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                          'reason', 'superseded_by_reconnect',
                          'supersededByConnectionId', p_new_connection_id));
  end loop;

  return v_archived;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4b. keel_finalize_link: identical to 20260719060000 except for ONE added
-- statement after the account-creation loop -- the auto-archive of superseded
-- accounts. Signature unchanged; CREATE OR REPLACE preserves owner (keel_api),
-- security-definer flag, search_path, and the execute-to-service_role-only
-- grant.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.keel_finalize_link(p_attempt_id uuid, p_household_id uuid, p_institution_id text, p_consent_expires_at timestamp with time zone, p_accounts jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_attempt public.link_attempts%rowtype;
  v_existing_connection_id uuid;
  v_connection_id uuid;
  v_ledger_account_id uuid;
  v_account_id uuid;
  v_account_ids jsonb;
  v_account jsonb;
  v_kind public.ledger_account_kind;
  v_actor jsonb;
  -- Per-account entity resolution (2026-07-19):
  v_default_entity_id uuid;       -- household Personal entity, else modal choice
  v_business_entity_id uuid;      -- the LONE non-personal entity, when exactly one
  v_business_entity_count int;
  v_target_entity_id uuid;        -- resolved per account
  v_account_name text;
  v_account_subtype text;
  v_account_mask text;
  v_entity_reason text;
begin
  select * into v_attempt
    from public.link_attempts
   where id = p_attempt_id
   for update;
  if not found or v_attempt.household_id <> p_household_id then
    raise exception 'KEEL_SCOPE_VIOLATION: link attempt not in household' using errcode = 'P0006';
  end if;

  if v_attempt.state = 'succeeded' then
    select coalesce(jsonb_agg(id order by created_at, id), '[]'::jsonb)
      into v_account_ids
      from public.accounts
     where connection_id = v_attempt.connection_id;
    return jsonb_build_object('connectionId', v_attempt.connection_id, 'accountIds', v_account_ids);
  end if;
  if v_attempt.state in ('reaping', 'reaped', 'failed', 'expired') then
    raise exception 'KEEL_INVALID_COMMAND: link attempt is terminal' using errcode = 'P0009';
  end if;
  if v_attempt.state <> 'exchanged' then
    raise exception 'KEEL_INVALID_COMMAND: link attempt is not exchanged' using errcode = 'P0009';
  end if;
  if v_attempt.credential_ciphertext is null then
    raise exception 'KEEL_INVALID_COMMAND: credential envelope unavailable' using errcode = 'P0009';
  end if;

  select c.id into v_existing_connection_id
    from public.connections c
    join public.connection_credentials cc
      on cc.household_id = c.household_id and cc.connection_id = c.id
   where c.household_id = p_household_id
     and c.provider = 'plaid'
     and c.external_ref = v_attempt.plaid_item_id
     and c.status = 'active'
   limit 1;

  v_actor := jsonb_build_object('kind', 'user', 'userId', v_attempt.initiated_by_user_id);
  if v_existing_connection_id is not null then
    update public.link_attempts
       set state = 'failed',
           failure_code = 'duplicate_item',
           connection_id = v_existing_connection_id,
           completed_at = now()
     where id = p_attempt_id;
    insert into public.audit_log
      (household_id, actor, action, object_type, object_id, command_id, after)
    values
      (p_household_id, v_actor, 'connection.link_duplicate', 'link_attempt', p_attempt_id,
       v_attempt.command_id,
       jsonb_build_object('attemptId', p_attempt_id,
                          'connectionId', v_existing_connection_id,
                          'itemId', v_attempt.plaid_item_id));
    select coalesce(jsonb_agg(id order by created_at, id), '[]'::jsonb)
      into v_account_ids
      from public.accounts
     where connection_id = v_existing_connection_id;
    return jsonb_build_object('connectionId', v_existing_connection_id, 'accountIds', v_account_ids);
  end if;

  if jsonb_typeof(p_accounts) <> 'array' or jsonb_array_length(p_accounts) = 0 then
    raise exception 'KEEL_INVALID_COMMAND: at least one USD account is required' using errcode = 'P0009';
  end if;

  -- ---------------------------------------------------------------------------
  -- Resolve the household's entity defaults ONCE (before the per-account loop).
  --   * v_default_entity_id: the household's 'personal' entity when present,
  --     otherwise fall back to the modal's per-connection choice so behaviour is
  --     never worse than the old one-entity-per-connection rule.
  --   * v_business_entity_id: the household's non-personal entity IFF there is
  --     exactly one -- the only case where the business-name heuristic can act
  --     without guessing which business.
  -- ---------------------------------------------------------------------------
  select id into v_default_entity_id
    from public.entities
   where household_id = p_household_id
     and kind = 'personal'
     and archived_at is null
   order by created_at, id
   limit 1;
  if v_default_entity_id is null then
    v_default_entity_id := v_attempt.entity_id;
  end if;

  select count(*), (array_agg(id order by id::text))[1]
    into v_business_entity_count, v_business_entity_id
    from public.entities
   where household_id = p_household_id
     and kind <> 'personal'
     and archived_at is null;
  if v_business_entity_count <> 1 then
    v_business_entity_id := null;  -- 0 or 2+: cannot disambiguate, disable heuristic
  end if;

  insert into public.connections
    (household_id, provider, external_ref, status, institution_id,
     consent_expires_at, sync_desired_generation, sync_committed_generation)
  values
    (p_household_id, 'plaid', v_attempt.plaid_item_id, 'active', p_institution_id,
     p_consent_expires_at, 0, 0)
  returning id into v_connection_id;

  insert into public.connection_credentials
    (id, household_id, connection_id, credential_owner_user_id,
     ciphertext, iv, wrapped_dek, wrap_iv, kek_version)
  values
    (v_attempt.credential_id, p_household_id, v_connection_id,
     v_attempt.initiated_by_user_id, v_attempt.credential_ciphertext,
     v_attempt.credential_iv, v_attempt.credential_wrapped_dek,
     v_attempt.credential_wrap_iv, v_attempt.credential_kek_version);

  for v_account in select value from jsonb_array_elements(p_accounts) loop
    if v_account->>'currency' <> 'USD' then
      raise exception 'KEEL_CURRENCY_MISMATCH: linked account must be USD' using errcode = 'P0010';
    end if;
    v_kind := (v_account->>'kind')::public.ledger_account_kind;
    if v_kind not in ('asset', 'liability') then
      raise exception 'KEEL_INVALID_COMMAND: linked account kind must be asset or liability'
        using errcode = 'P0009';
    end if;

    v_account_name    := v_account->>'name';
    v_account_subtype := v_account->>'subtype';
    v_account_mask    := nullif(v_account->>'mask', '');

    -- Per-account entity: reconnect-inherit -> business-name heuristic ->
    -- default Personal. institution_id is compared with `is not distinct from`
    -- inside the resolver so two nulls still match (current live data has null
    -- institution_id on every connection). Single-sourced in
    -- keel_resolve_finalize_entity so the pgTAP suite tests the same code.
    select r.o_entity_id, r.o_reason
      into v_target_entity_id, v_entity_reason
      from public.keel_resolve_finalize_entity(
        p_household_id, v_connection_id, p_institution_id,
        v_account_name, v_account_subtype, v_account_mask,
        v_default_entity_id, v_business_entity_id
      ) r;

    insert into public.ledger_accounts
      (household_id, entity_id, name, kind, currency, is_category)
    values
      (p_household_id, v_target_entity_id, v_account->>'name', v_kind, 'USD', false)
    returning id into v_ledger_account_id;

    insert into public.accounts
      (household_id, entity_id, connection_id, ledger_account_id,
       name, subtype, currency, external_ref, mask)
    values
      (p_household_id, v_target_entity_id, v_connection_id, v_ledger_account_id,
       v_account->>'name', v_account->>'subtype', 'USD', v_account->>'external_ref',
       v_account_mask)
    returning id into v_account_id;

    insert into public.account_owners (account_id, user_id)
    values (v_account_id, v_attempt.initiated_by_user_id);

    insert into public.audit_log
      (household_id, actor, action, object_type, object_id, command_id, after)
    values
      (p_household_id, v_actor, 'connection.account_linked', 'account', v_account_id,
       v_attempt.command_id,
       jsonb_build_object('accountId', v_account_id, 'connectionId', v_connection_id,
                          'externalRef', v_account->>'external_ref', 'kind', v_kind,
                          'entityId', v_target_entity_id,
                          'entitySource', v_entity_reason));
  end loop;

  -- Auto-archive superseded old accounts (2026-07-19, dedupe-archived slice):
  -- a reconnect leaves the same real-world account duplicated across the old
  -- (disconnected) and new (this) connection. Soft-archive the old copies now
  -- so read models stop double-counting the moment the new connection exists.
  -- Duplicate TRANSACTION history is not touched here -- that stays a
  -- suggest->approve pass (keel_cmd_dedupe_archived_duplicates), which matches
  -- archived accounts, so running it after this auto-archive is fully
  -- supported (ordering is not load-bearing).
  perform public.keel_archive_superseded_accounts(
    p_household_id, v_connection_id, v_actor, v_attempt.command_id);

  update public.link_attempts
     set state = 'succeeded',
         completed_at = now(),
         connection_id = v_connection_id,
         credential_ciphertext = null,
         credential_iv = null,
         credential_wrapped_dek = null,
         credential_wrap_iv = null,
         credential_kek_version = null
   where id = p_attempt_id;

  perform public.keel_enqueue('sync_events', jsonb_build_object(
    'jobType', 'sync_notification',
    'economicEventKey', 'plaid:link:' || v_connection_id::text,
    'refs', jsonb_build_object('connectionId', v_connection_id::text)
  ));

  insert into public.audit_log
    (household_id, actor, action, object_type, object_id, command_id, after)
  values
    (p_household_id, v_actor, 'connection.linked', 'connection', v_connection_id,
     v_attempt.command_id,
     jsonb_build_object('connectionId', v_connection_id, 'itemId', v_attempt.plaid_item_id,
                        'credentialId', v_attempt.credential_id));

  select coalesce(jsonb_agg(id order by created_at, id), '[]'::jsonb)
    into v_account_ids
    from public.accounts
   where connection_id = v_connection_id;
  return jsonb_build_object('connectionId', v_connection_id, 'accountIds', v_account_ids);
end;
$function$;

-- ---------------------------------------------------------------------------
-- Ownership + grants (same posture as 20260718061000): functions owned by
-- keel_api (non-BYPASSRLS definer), the user-facing reader + command
-- executable by authenticated, internal helpers by nobody but their callers.
-- ---------------------------------------------------------------------------
grant create on schema public to keel_api;
alter function public.keel_archived_duplicate_pairs(uuid, uuid, uuid) owner to keel_api;
alter function public.keel_list_archived_duplicate_matches(uuid) owner to keel_api;
alter function public.keel_cmd_dedupe_archived_duplicates(uuid, text, jsonb, uuid, jsonb) owner to keel_api;
alter function public.keel_archive_superseded_accounts(uuid, uuid, jsonb, uuid) owner to keel_api;
revoke create on schema public from keel_api;

revoke all on function public.keel_archived_duplicate_pairs(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.keel_list_archived_duplicate_matches(uuid) from public, anon;
grant execute on function public.keel_list_archived_duplicate_matches(uuid) to authenticated, service_role;
revoke all on function public.keel_cmd_dedupe_archived_duplicates(uuid, text, jsonb, uuid, jsonb) from public, anon;
grant execute on function public.keel_cmd_dedupe_archived_duplicates(uuid, text, jsonb, uuid, jsonb) to authenticated;
revoke all on function public.keel_archive_superseded_accounts(uuid, uuid, jsonb, uuid) from public, anon, authenticated;
