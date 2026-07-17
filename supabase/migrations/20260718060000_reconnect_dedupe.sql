-- Docket item (NOTES.md, flagged 2026-07-17): disconnect+relink of the same
-- real-world bank account always creates a brand-new connections/accounts
-- row (a fresh Plaid Item has a new external_ref) with zero prior
-- categorization/notes/tags, and re-pulls the same historical window under a
-- different economic-key namespace -- duplicate transactions unless
-- corrected (exactly the manual dedup done once this session via
-- keel_admin_void_relink_duplicate, 20260717233000).
--
-- This generalizes that one-off admin pass into a self-service command, so
-- the user can trigger it themselves after any future reconnect instead of
-- needing hand-run SQL. Deliberately does NOT try to merge the two
-- `accounts` rows into one (accounts.ledger_account_id is effectively fixed
-- at creation, and journal_postings is immutable -- there is no clean way to
-- move existing postings onto a different ledger account without violating
-- Law 9 source preservation). Instead: both account rows stay permanently
-- (the old one frozen/historical, the new one live and receiving all future
-- syncs), and only the OVERLAPPING duplicate transactions on the NEW
-- account are voided, keeping the OLD account's copies (with any existing
-- categorization) authoritative for that window -- Law 2: suggest->approve,
-- nothing here runs automatically; the user explicitly triggers it after
-- reviewing the match (keel_list_reconnect_matches, below).

-- ---------------------------------------------------------------------------
-- 1. Read: surface candidate matches for the Connections page. A "match" is
-- an ACTIVE connection's account whose institution+mask (or, when either
-- side lacks a mask, institution+name+subtype) coincides with a DISCONNECTED
-- connection's account in the same household. Purely informational -- no
-- state is written by looking.
-- ---------------------------------------------------------------------------
create function public.keel_list_reconnect_matches(p_household_id uuid)
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
    'newAccountId', new_acc.id,
    'newAccountName', new_acc.name,
    'oldAccountId', old_acc.id,
    'oldAccountName', old_acc.name,
    'oldConnectionId', old_conn.id,
    'oldConnectionDisplayName', old_conn.display_name,
    'oldLastSyncedAt', old_conn.last_successful_sync_at
  ) order by new_acc.name), '[]'::jsonb)
    into v_rows
    from public.accounts new_acc
    join public.connections new_conn
      on new_conn.id = new_acc.connection_id and new_conn.status = 'active'
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
     and old_conn.status = 'disconnected'
     and old_conn.institution_id is not distinct from new_conn.institution_id
   where new_acc.household_id = p_household_id;

  return jsonb_build_object(
    'scope', jsonb_build_object('householdId', p_household_id),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'rows', v_rows
  );
end;
$$;

revoke all on function public.keel_list_reconnect_matches(uuid) from public, anon;
grant execute on function public.keel_list_reconnect_matches(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Write: accounts.dedupe_reconnect -> keel_cmd_dedupe_reconnect_account.
-- User-triggered (not automatic), re-runnable (already-voided transactions
-- are excluded from matching, so a second run just finds nothing new -- safe
-- to click again while a deep backfill is still draining).
-- ---------------------------------------------------------------------------
create function public.keel_cmd_dedupe_reconnect_account(
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

  select a.id, a.currency, la.kind, c.status as connection_status
    into v_new_acc
    from public.accounts a
    join public.ledger_accounts la on la.id = a.ledger_account_id
    left join public.connections c on c.id = a.connection_id
   where a.id = v_new_account_id and a.household_id = p_household_id;
  if not found then
    raise exception 'KEEL_SCOPE_VIOLATION: new account not in household' using errcode = 'P0006';
  end if;

  select a.id, a.currency, la.kind, c.status as connection_status
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
  if v_old_acc.connection_status is distinct from 'disconnected' then
    raise exception 'KEEL_INVALID_COMMAND: the old account''s connection must be disconnected'
      using errcode = 'P0009';
  end if;
  if v_new_acc.currency <> v_old_acc.currency or v_new_acc.kind <> v_old_acc.kind then
    raise exception 'KEEL_INVALID_COMMAND: accounts must match currency and kind' using errcode = 'P0009';
  end if;

  -- Pair up same-day/same-amount/same-description transactions between the
  -- two accounts by rank -- handles legitimate same-day duplicate real
  -- transactions correctly (e.g. two identical $6 coffee purchases), same
  -- methodology as the one-off admin dedup this generalizes.
  for v_pair in
    with cash as (
      select ct.id as txn_id, ct.effective_date, ct.description, acc.id as account_id,
             p.amount_minor
        from public.canonical_transactions ct
        join public.journal_batches jb
          on jb.canonical_transaction_id = ct.id and jb.reverses_batch_id is null
         and not exists (select 1 from public.journal_revisions rev where rev.original_batch_id = jb.id)
        join public.journal_postings p on p.batch_id = jb.id
        join public.ledger_accounts la on la.id = p.ledger_account_id and la.is_category = false
        join public.accounts acc on acc.ledger_account_id = la.id
       where ct.household_id = p_household_id
         and ct.voided_at is null
         and acc.id in (v_new_acc.id, v_old_acc.id)
    ),
    ranked as (
      select *, row_number() over (
        partition by account_id, effective_date, amount_minor, description
        order by txn_id
      ) as rn
      from cash
    )
    select nw.txn_id as new_txn_id
      from ranked nw
      join ranked ol
        on ol.account_id = v_old_acc.id
       and nw.account_id = v_new_acc.id
       and ol.effective_date = nw.effective_date
       and ol.amount_minor = nw.amount_minor
       and ol.description = nw.description
       and ol.rn = nw.rn
  loop
    select jb.* into v_batch
      from public.journal_batches jb
     where jb.canonical_transaction_id = v_pair.new_txn_id
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
      (p_household_id, v_pair.new_txn_id,
       left('VOID: duplicate of reconnected account history', 500),
       v_batch.effective_date, v_batch.id, p_command_id)
    returning id into v_reversal_id;

    insert into public.journal_postings (batch_id, ledger_account_id, entity_id, amount_minor, currency)
    select v_reversal_id, p.ledger_account_id, p.entity_id, -p.amount_minor, p.currency
      from public.journal_postings p
     where p.batch_id = v_batch.id;

    insert into public.journal_revisions (original_batch_id, reversal_batch_id, reason)
    values (v_batch.id, v_reversal_id, 'duplicate of reconnected account history');

    update public.canonical_transactions
       set status = 'voided', voided_at = now()
     where id = v_pair.new_txn_id;

    v_voided_count := v_voided_count + 1;
    v_voided_ids := v_voided_ids || v_pair.new_txn_id;
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
    p_command_id, 'accounts.dedupe_reconnect', p_economic_event_key, p_household_id, p_actor,
    v_hash, 'accounts.reconnect_deduped', 'account', v_new_acc.id,
    jsonb_build_object('oldAccountId', v_old_acc.id, 'voidedCount', v_voided_count),
    v_result
  );

  return v_result;
end;
$$;

grant create on schema public to keel_api;
alter function public.keel_list_reconnect_matches(uuid) owner to keel_api;
alter function public.keel_cmd_dedupe_reconnect_account(uuid, text, jsonb, uuid, jsonb) owner to keel_api;
revoke create on schema public from keel_api;
revoke all on function public.keel_cmd_dedupe_reconnect_account(uuid, text, jsonb, uuid, jsonb) from public, anon;
grant execute on function public.keel_cmd_dedupe_reconnect_account(uuid, text, jsonb, uuid, jsonb) to authenticated;
