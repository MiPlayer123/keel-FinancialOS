-- Account last-4 mask (teardown C6 residual, D-050 — "Master-detail txn
-- surface"): surface a masked account-number suffix (e.g. "Chase Checking
-- ••1234") so a household with two accounts at the same institution can
-- disambiguate at a glance in the transaction ledger/detail. Plaid's
-- `/accounts/get` response already carries a top-level `mask` field per
-- account (last 2-4 digits/chars the institution reports; nullable — some
-- institutions/account types omit it) that KEEL was not yet capturing
-- anywhere (packages/providers/plaid/src/accounts.ts dropped it on the
-- floor). This migration adds ONE nullable column and threads it through
-- the existing link-finalize path — additive only, no new command, same
-- shape as 20260717210000's reconciled-column precedent.
--
-- NOT executed against a live database: no Docker/Supabase CLI available in
-- this sandbox. Hand-verified against the current schema/grants below;
-- flagged in NOTES.md (D-050) as unexecuted-but-hand-verified, matching how
-- other slices this session have handled the same constraint.
--
-- Residual gap this does NOT close: accounts linked BEFORE this migration
-- ships will have mask = null until their connection's next full Plaid
-- accounts-get resync (or a manual re-link) — there is no backfill command
-- (Law 9 reproducible numbers: no fabricated data). The UI must render the
-- absence of a mask as "no suffix," never a guess.

-- ---------------------------------------------------------------------------
-- 1. accounts.mask: nullable, short (Plaid masks are 2-4 chars in practice;
-- generous upper bound of 10 to tolerate any institution oddities without
-- another migration). No uniqueness — two accounts CAN legitimately share a
-- mask across different institutions/connections.
-- ---------------------------------------------------------------------------
alter table public.accounts
  add column mask text check (mask is null or length(mask) between 1 and 10);

comment on column public.accounts.mask is
  'Provider-reported masked account-number suffix (e.g. last 4 digits), nullable. Populated at link time from Plaid /accounts/get; not backfilled for pre-existing accounts.';

-- ---------------------------------------------------------------------------
-- 2. keel_finalize_link: same signature (uuid, uuid, text, timestamptz,
-- jsonb) — p_accounts already carries one jsonb object per account, so
-- reading an additional 'mask' key is additive. create-or-replace preserves
-- the function's existing ownership/grants (keel_api owner, execute to
-- service_role only), same as the reconciled-status precedent.
-- ---------------------------------------------------------------------------
create or replace function public.keel_finalize_link(
  p_attempt_id uuid,
  p_household_id uuid,
  p_institution_id text,
  p_consent_expires_at timestamptz,
  p_accounts jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
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

    insert into public.ledger_accounts
      (household_id, entity_id, name, kind, currency, is_category)
    values
      (p_household_id, v_attempt.entity_id, v_account->>'name', v_kind, 'USD', false)
    returning id into v_ledger_account_id;

    insert into public.accounts
      (household_id, entity_id, connection_id, ledger_account_id,
       name, subtype, currency, external_ref, mask)
    values
      (p_household_id, v_attempt.entity_id, v_connection_id, v_ledger_account_id,
       v_account->>'name', v_account->>'subtype', 'USD', v_account->>'external_ref',
       nullif(v_account->>'mask', ''))
    returning id into v_account_id;

    insert into public.account_owners (account_id, user_id)
    values (v_account_id, v_attempt.initiated_by_user_id);

    insert into public.audit_log
      (household_id, actor, action, object_type, object_id, command_id, after)
    values
      (p_household_id, v_actor, 'connection.account_linked', 'account', v_account_id,
       v_attempt.command_id,
       jsonb_build_object('accountId', v_account_id, 'connectionId', v_connection_id,
                          'externalRef', v_account->>'external_ref', 'kind', v_kind));
  end loop;

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
$$;

-- ---------------------------------------------------------------------------
-- 3. keel_list_transactions_rich: full recreate of the CURRENT body
-- (20260717210000, which added 'reconciled'), with ONE new field,
-- 'accountMask' — same additive pattern, same correlated join (acc is
-- already joined for accountName; no new join required). create-or-replace
-- preserves the function's existing grants (execute to authenticated,
-- service_role).
-- ---------------------------------------------------------------------------
create or replace function public.keel_list_transactions_rich(p_household_id uuid)
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

  select coalesce(jsonb_agg(row order by row->>'effectiveDate' desc, row->>'transactionId'), '[]'::jsonb)
    into v_rows
    from (
      select jsonb_build_object(
        'transactionId', ct.id,
        'effectiveDate', ct.effective_date,
        'description', left(coalesce(tov.display_description, rr.display_name, ct.description), 140),
        'originalDescription', left(ct.description, 140),
        'note', tov.note,
        'status', ct.status,
        'source', ct.source,
        'accountId', acc.id,
        'accountName', acc.name,
        -- Account last-4 (teardown C6/D-050): masked suffix for disambiguating
        -- multiple accounts at the same institution. Null until the owning
        -- connection's accounts have gone through a link/resync that captured
        -- Plaid's `mask` field (see header comment) — the UI must hide the
        -- suffix, never guess it, when this is null (Law 8/9).
        'accountMask', acc.mask,
        'amountMinor', cashp.amount_minor::text,
        'currency', cashp.currency,
        'categoryLedgerAccountId',
          case when offs.n = 1 then coalesce(catov.id, offs.one_id) end,
        'categoryName',
          case when offs.n = 1 then coalesce(catov.name, offs.one_name) else 'Split' end,
        'categoryKind',
          case when offs.n = 1 then coalesce(catov.kind::text, offs.one_kind) end,
        'categoryPfcKey',
          case when offs.n = 1 then coalesce(catov.pfc_key, offs.one_pfc_key) end,
        'categorySource', case when offs.n > 1 then 'user' else tc.source end,
        'splits', case when offs.n > 1 then offs.splits end,
        'tags', tgs.tags,
        'transferStatus', tl.status,
        'counterpartyAccountId', case when tl.status = 'confirmed' then cp.account_id end,
        'counterpartyAccountName', case when tl.status = 'confirmed' then cp.account_name end,
        'counterpartyTransactionId', case when tl.status = 'confirmed' then cp.txn_id end,
        -- Reconciled (D-047): permanent once a closed reconciliation session
        -- matched this transaction to a statement line. See 20260717210000.
        'reconciled', exists (
          select 1 from public.reconciliation_items ri
           where ri.household_id = ct.household_id
             and ri.transaction_id = ct.id
             and ri.resolution = 'matched_transaction'
        )
      ) as row
      from public.canonical_transactions ct
      join public.journal_batches jb
        on jb.canonical_transaction_id = ct.id and jb.reverses_batch_id is null
       and not exists (
         select 1 from public.journal_revisions rev where rev.original_batch_id = jb.id
       )
      join public.journal_postings cashp on cashp.batch_id = jb.id
      join public.ledger_accounts cashla
        on cashla.id = cashp.ledger_account_id and cashla.is_category = false
      join public.accounts acc on acc.ledger_account_id = cashla.id
      cross join lateral (
        select count(*)::int as n,
               min(oc.id::text)::uuid as one_id,
               min(oc.name)           as one_name,
               min(oc.kind::text)     as one_kind,
               min(oc.pfc_key)        as one_pfc_key,
               jsonb_agg(jsonb_build_object(
                 'categoryLedgerAccountId', oc.id,
                 'name', oc.name,
                 'kind', oc.kind,
                 'amountMinor', op.amount_minor::text
               ) order by op.amount_minor desc, op.id) as splits
          from public.journal_postings op
          join public.ledger_accounts oc on oc.id = op.ledger_account_id and oc.is_category = true
         where op.batch_id = jb.id
      ) offs
      cross join lateral (
        select coalesce(jsonb_agg(jsonb_build_object('tagId', tg.id, 'name', tg.name)
                 order by tg.name), '[]'::jsonb) as tags
          from public.transaction_tags tt
          join public.tags tg on tg.id = tt.tag_id
         where tt.canonical_transaction_id = ct.id
      ) tgs
      left join public.transaction_categories tc on tc.canonical_transaction_id = ct.id
      left join public.ledger_accounts catov on catov.id = tc.category_ledger_account_id
      left join public.transaction_overrides tov on tov.canonical_transaction_id = ct.id
      left join public.rule_renames rr on rr.canonical_transaction_id = ct.id
      left join public.transfer_links tl
        on (tl.txn_out = ct.id or tl.txn_in = ct.id)
       and tl.status in ('suggested', 'confirmed')
      left join lateral (
        select cpacc.id as account_id, cpacc.name as account_name, cpct.id as txn_id
          from public.canonical_transactions cpct
          join public.journal_batches cpjb
            on cpjb.canonical_transaction_id = cpct.id and cpjb.reverses_batch_id is null
           and not exists (
             select 1 from public.journal_revisions rev where rev.original_batch_id = cpjb.id
           )
          join public.journal_postings cpp on cpp.batch_id = cpjb.id
          join public.ledger_accounts cpla
            on cpla.id = cpp.ledger_account_id and cpla.is_category = false
          join public.accounts cpacc on cpacc.ledger_account_id = cpla.id
         where cpct.id = case when tl.txn_out = ct.id then tl.txn_in else tl.txn_out end
         limit 1
      ) cp on tl.status = 'confirmed'
      where ct.household_id = p_household_id
        and ct.voided_at is null
        and offs.n >= 1
    ) t;

  return jsonb_build_object(
    'scope', jsonb_build_object('householdId', p_household_id),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'rows', v_rows
  );
end;
$$;

revoke all on function public.keel_list_transactions_rich(uuid) from public, anon;
grant execute on function public.keel_list_transactions_rich(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. keel_apply_account_balance: persist the provider-reported mask on every
-- scheduled balance refresh, not just at initial link (review r3604673536).
-- keel_finalize_link (section 2) only writes mask for brand-new accounts;
-- the worker's processRefreshBalances path (every 3-min cycle thereafter)
-- calls keel_apply_account_balance per account with the SAME accountsGet
-- response Plaid already returned mask on, but had no parameter to receive
-- it — so an account linked before this migration ships, or one whose
-- initial link response omitted mask for any reason, could never pick one
-- up on a later resync, contradicting this migration's own "next resync"
-- backfill note.
--
-- Adds ONE new trailing default parameter (p_mask, defaulting null) via
-- CREATE OR REPLACE on the CURRENT 7-arg signature (20260717180000) — this
-- is an in-place extension, not a new overload (Postgres permits appending
-- default-valued parameters this way; the function's OID, ownership, and
-- existing grants carry over unchanged, so no revoke/grant restatement is
-- needed here, unlike the 6-arg -> 7-arg conversion which changed an
-- existing parameter's position and required a full drop+create). An old
-- worker build calling with 7 named args keeps working across the deploy
-- window, same convention as p_limit_minor before it.
--
-- mask is written via `coalesce(nullif(p_mask, ''), accounts.mask)` — set it
-- when the provider reports one, never CLEAR an already-known mask just
-- because one particular refresh response happened to omit the field.
-- ---------------------------------------------------------------------------
create or replace function public.keel_apply_account_balance(
  p_household_id uuid,
  p_account_id uuid,
  p_current_minor bigint,
  p_available_minor bigint,
  p_currency text,
  p_as_of timestamptz,
  p_limit_minor bigint default null,
  p_mask text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ledger        uuid;
  v_entity        uuid;
  v_curr          char(3);
  v_kind          public.ledger_account_kind;
  v_opening_ledger uuid;
  v_target        bigint;
  v_current_sum   bigint;
  v_opening       bigint;
  v_batch         uuid;
  v_has_opening   boolean;
  v_connection_id uuid;
  v_sync_done     timestamptz;
begin
  select a.ledger_account_id, a.entity_id, a.currency, a.connection_id
    into v_ledger, v_entity, v_curr, v_connection_id
    from public.accounts a
    where a.id = p_account_id and a.household_id = p_household_id;
  if v_ledger is null then
    raise exception 'KEEL_NOT_FOUND: account' using errcode = 'P0006';
  end if;
  select kind into v_kind from public.ledger_accounts where id = v_ledger;

  -- Mask backfill (D-050 residual fix): every refresh cycle, not just link
  -- time. Never clears an existing mask — only fills it in or updates it
  -- when the provider actually reports a non-empty value this cycle.
  if p_mask is not null and p_mask <> '' then
    update public.accounts set mask = p_mask where id = p_account_id and mask is distinct from p_mask;
  end if;

  -- Provider snapshot (history for trend + future reconciliation + re-anchor).
  -- Recorded every cycle regardless of the anchor gate below. limit_minor is
  -- stored verbatim (null when the provider reports none).
  insert into public.balance_snapshots
    (household_id, account_id, as_of, available_minor, current_minor, limit_minor,
     currency, source, snapshot_metadata)
  values
    (p_household_id, p_account_id, p_as_of, p_available_minor, p_current_minor, p_limit_minor,
     coalesce(nullif(p_currency, ''), v_curr), 'plaid', '{}'::jsonb);

  -- Defer the one-time anchor until the connection's first full sync has
  -- completed, so the backfilled window is already in Σ(postings) when we take
  -- the delta. A provider-connected account with no completed sync yet skips
  -- the anchor this cycle; a later refresh (after the backfill lands) books it
  -- correctly. Accounts without a connection (manual) are never gated.
  if v_connection_id is not null then
    select last_successful_sync_at into v_sync_done
      from public.connections where id = v_connection_id;
    if v_sync_done is null then
      return;
    end if;
  end if;

  select id into v_opening_ledger
    from public.ledger_accounts
    where entity_id = v_entity and name = 'Opening Balances' and archived_at is null;
  if v_opening_ledger is null then
    raise exception 'KEEL_INVALID_COMMAND: opening balances account missing' using errcode = 'P0009';
  end if;

  -- Opening balance is booked once. The unambiguous marker for "this account
  -- already has an opening entry" is a live (non-reversal) batch touching BOTH
  -- this account's own ledger account AND the entity's Opening Balances equity
  -- account — a manual transfer moves between two real asset/liability accounts
  -- and never touches equity, so it can't satisfy both.
  select exists (
    select 1
      from public.journal_batches b
      where b.household_id = p_household_id
        and b.canonical_transaction_id is null
        and b.reverses_batch_id is null
        and exists (
          select 1 from public.journal_postings p
          where p.batch_id = b.id and p.ledger_account_id = v_ledger
        )
        and exists (
          select 1 from public.journal_postings p2
          where p2.batch_id = b.id and p2.ledger_account_id = v_opening_ledger
        )
  ) into v_has_opening;
  if v_has_opening then
    return;
  end if;

  v_target := case when v_kind = 'liability' then -p_current_minor else p_current_minor end;
  select coalesce(sum(amount_minor), 0) into v_current_sum
    from public.journal_postings where ledger_account_id = v_ledger;
  v_opening := v_target - v_current_sum;
  if v_opening = 0 then
    return;
  end if;

  insert into public.journal_batches
    (household_id, canonical_transaction_id, description, effective_date, command_id, posted_at)
  values
    (p_household_id, null, 'Opening balance', current_date, gen_random_uuid(), now())
  returning id into v_batch;

  insert into public.journal_postings (batch_id, ledger_account_id, entity_id, amount_minor, currency)
  values
    (v_batch, v_ledger,         v_entity,  v_opening, coalesce(nullif(p_currency, ''), v_curr)),
    (v_batch, v_opening_ledger, v_entity, -v_opening, coalesce(nullif(p_currency, ''), v_curr));
end;
$$;
