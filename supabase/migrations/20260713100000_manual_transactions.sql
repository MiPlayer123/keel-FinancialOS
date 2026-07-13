-- Manual transactions + splits (T0.6). Design ruling (NOTES.md): splits are
-- REAL offset postings to the chosen category ledger accounts, not overlay
-- rows — trial balance, cash flow, net worth and budgets pick them up with
-- zero formula changes because they aggregate real postings by kind. The
-- category overlay remains a re-display layer for single-offset transactions
-- only; multi-split transactions are categorized by their splits.
--
-- Also fixes a live read-model bug: the rich list bound exactly ONE offset
-- row per batch, so any multi-offset batch rendered as N duplicate rows.

-- ---------------------------------------------------------------------------
-- 0. transaction_categories was created after the Stage-1A definer-grants
-- pass, with SELECT-only access for readers — no keel_api write path. The
-- overlay writers so far were owned by the migration role (RLS-exempt), but
-- keel_cmd_manual_transaction below is keel_api-owned and writes the
-- single-split overlay row. House pattern (20260710210500): grant + a
-- definer_all policy for the definer roles. (Scratch-PG replay finding:
-- without this, every single-split manual transaction fails with
-- "permission denied for table transaction_categories".)
-- ---------------------------------------------------------------------------
grant select, insert, update on public.transaction_categories to keel_api, keel_worker;
drop policy if exists transaction_categories_definer_all on public.transaction_categories;
create policy transaction_categories_definer_all on public.transaction_categories
  for all to keel_api, keel_worker using (true) with check (true);

-- ---------------------------------------------------------------------------
-- 1. transactions.manual_create — full command envelope (modeled on
-- keel_cmd_post_batch / keel_cmd_promote_event).
-- Payload (post-toSnakeKeys):
--   { account_id, description, effective_date, amount_minor: "-4500",
--     status: pending|posted,
--     splits: [ { category_ledger_account_id, amount_minor: "4500" }, ... ] }
-- Sign convention: debit-positive. Cash side signed as given; splits sum to
-- the exact negation (Σ per currency = 0, re-verified by the deferred trigger).
-- ---------------------------------------------------------------------------
create function public.keel_cmd_manual_transaction(
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
  v_account record;
  v_description text := btrim(coalesce(p_payload->>'description', ''));
  v_date date;
  v_status text := p_payload->>'status';
  v_amount bigint;
  v_split jsonb;
  v_split_count int;
  v_split_sum bigint := 0;
  v_split_amount bigint;
  v_cat record;
  v_seen_categories uuid[] := '{}';
  v_cat_id uuid;
  v_postings_in jsonb;
  v_postings jsonb;
  v_txn_id uuid;
  v_batch_id uuid;
  v_result jsonb;
begin
  perform public.keel_assert_member_write(p_household_id);
  p_actor := public.keel_actor_from_jwt();  -- ignore caller-supplied actor (forgery guard)
  v_replay := public.keel_idempotency_check(p_household_id, p_economic_event_key, v_hash);
  if v_replay is not null then
    return v_replay;
  end if;

  -- Canonical-key precheck: a manual key colliding with an existing canonical
  -- row (e.g. a sync key) must surface as a typed conflict, not a raw 23505.
  if exists (
    select 1 from public.canonical_transactions
    where household_id = p_household_id and economic_event_key = p_economic_event_key
  ) then
    raise exception 'KEEL_IDEMPOTENCY_CONFLICT: economic event key % already used', p_economic_event_key
      using errcode = 'P0007';
  end if;

  -- Account resolution: entity comes from the account row — never the payload.
  select a.id, a.entity_id, a.ledger_account_id, a.archived_at,
         la.currency as ledger_currency, la.is_category as ledger_is_category,
         la.archived_at as ledger_archived_at
    into v_account
    from public.accounts a
    join public.ledger_accounts la on la.id = a.ledger_account_id
    where a.id = (p_payload->>'account_id')::uuid
      and a.household_id = p_household_id;
  if not found then
    raise exception 'KEEL_SCOPE_VIOLATION: account not in household' using errcode = 'P0006';
  end if;
  if v_account.archived_at is not null
     or v_account.ledger_is_category
     or v_account.ledger_archived_at is not null then
    raise exception 'KEEL_INVALID_COMMAND: account is not postable' using errcode = 'P0009';
  end if;

  -- Field validation (typed errors before any raw CHECK/cast failure).
  if char_length(v_description) < 1 or char_length(v_description) > 500 then
    raise exception 'KEEL_INVALID_COMMAND: description must be 1-500 characters' using errcode = 'P0009';
  end if;
  if coalesce(p_payload->>'effective_date', '') !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception 'KEEL_INVALID_COMMAND: effective_date must be YYYY-MM-DD' using errcode = 'P0009';
  end if;
  v_date := (p_payload->>'effective_date')::date;
  if v_status not in ('pending', 'posted') then
    raise exception 'KEEL_INVALID_COMMAND: status must be pending or posted' using errcode = 'P0009';
  end if;
  if jsonb_typeof(p_payload->'amount_minor') <> 'string'
     or (p_payload->>'amount_minor') !~ '^-?[0-9]+$' then
    raise exception 'KEEL_INVALID_MONEY: amount_minor must be an integer string' using errcode = 'P0008';
  end if;
  v_amount := (p_payload->>'amount_minor')::bigint;
  if v_amount = 0 then
    raise exception 'KEEL_INVALID_MONEY: amount cannot be zero' using errcode = 'P0008';
  end if;

  -- Splits validation: 1-30 rows, each a live same-entity expense/income
  -- category in the account's currency; duplicates rejected (deterministic
  -- postings, simpler UX than silent collapse).
  if jsonb_typeof(p_payload->'splits') <> 'array' then
    raise exception 'KEEL_INVALID_COMMAND: splits must be an array' using errcode = 'P0009';
  end if;
  v_split_count := jsonb_array_length(p_payload->'splits');
  if v_split_count < 1 or v_split_count > 30 then
    raise exception 'KEEL_INVALID_COMMAND: 1-30 splits per transaction' using errcode = 'P0009';
  end if;

  v_postings_in := jsonb_build_array(jsonb_build_object(
    'ledger_account_id', v_account.ledger_account_id,
    'amount_minor', p_payload->>'amount_minor',
    'currency', v_account.ledger_currency
  ));

  for v_split in select * from jsonb_array_elements(p_payload->'splits') loop
    if jsonb_typeof(v_split->'amount_minor') <> 'string'
       or (v_split->>'amount_minor') !~ '^-?[0-9]+$' then
      raise exception 'KEEL_INVALID_MONEY: split amount_minor must be an integer string' using errcode = 'P0008';
    end if;
    v_split_amount := (v_split->>'amount_minor')::bigint;
    if v_split_amount = 0 then
      raise exception 'KEEL_INVALID_MONEY: split amount cannot be zero' using errcode = 'P0008';
    end if;

    v_cat_id := (v_split->>'category_ledger_account_id')::uuid;
    select la.id, la.kind, la.currency, la.entity_id, la.is_category, la.archived_at
      into v_cat
      from public.ledger_accounts la
      where la.id = v_cat_id and la.household_id = p_household_id;
    if not found then
      raise exception 'KEEL_SCOPE_VIOLATION: split category not in household' using errcode = 'P0006';
    end if;
    if v_cat.is_category is not true or v_cat.archived_at is not null
       or v_cat.kind not in ('expense', 'income') then
      raise exception 'KEEL_INVALID_COMMAND: split target is not a live category' using errcode = 'P0009';
    end if;
    if v_cat.entity_id <> v_account.entity_id then
      raise exception 'KEEL_INVALID_COMMAND: split category belongs to a different entity' using errcode = 'P0009';
    end if;
    if v_cat.currency <> v_account.ledger_currency then
      raise exception 'KEEL_CURRENCY_MISMATCH: split currency % on % account',
        v_cat.currency, v_account.ledger_currency using errcode = 'P0010';
    end if;
    if v_cat_id = any (v_seen_categories) then
      raise exception 'KEEL_INVALID_COMMAND: duplicate split category — merge the amounts' using errcode = 'P0009';
    end if;
    v_seen_categories := v_seen_categories || v_cat_id;

    v_split_sum := v_split_sum + v_split_amount;
    v_postings_in := v_postings_in || jsonb_build_object(
      'ledger_account_id', v_cat_id,
      'amount_minor', v_split->>'amount_minor',
      'currency', v_account.ledger_currency
    );
  end loop;

  if v_split_sum <> -v_amount then
    raise exception 'KEEL_UNBALANCED: splits sum to % but must equal % (delta %)',
      v_split_sum, -v_amount, v_split_sum + v_amount using errcode = 'P0002';
  end if;

  -- Period-lock precheck (the BEFORE INSERT posting trigger is the backstop).
  if exists (
    select 1 from public.period_locks l
    where l.household_id = p_household_id
      and (l.entity_id is null or l.entity_id = v_account.entity_id)
      and l.reopened_at is null
      and v_date between l.start_date and l.end_date
  ) then
    raise exception 'KEEL_PERIOD_LOCKED: % falls in a locked period', v_date
      using errcode = 'P0003';
  end if;

  insert into public.canonical_transactions
    (household_id, entity_id, account_id, status, source, description,
     effective_date, economic_event_key)
  values
    (p_household_id, v_account.entity_id, v_account.id,
     v_status::public.transaction_status, 'manual'::public.transaction_source,
     v_description, v_date, p_economic_event_key)
  returning id into v_txn_id;

  insert into public.journal_batches
    (household_id, canonical_transaction_id, description, effective_date, command_id)
  values
    (p_household_id, v_txn_id, v_description, v_date, p_command_id)
  returning id into v_batch_id;

  v_postings := public.keel_insert_postings(p_household_id, v_batch_id, v_postings_in);

  -- Single-split: pin the overlay as a USER classification so no rule can
  -- silently re-display the category the user explicitly posted. Multi-split
  -- transactions get no overlay (they are categorized by their splits).
  if v_split_count = 1 then
    insert into public.transaction_categories
      (canonical_transaction_id, household_id, category_ledger_account_id, source)
    values (v_txn_id, p_household_id, v_seen_categories[1], 'user');
  end if;

  v_result := jsonb_build_object(
    'commandId', p_command_id,
    'economicEventKey', p_economic_event_key,
    'idempotentReplay', false,
    'effects', jsonb_build_object(
      'canonicalTransactionId', v_txn_id, 'batchId', v_batch_id, 'postings', v_postings
    ),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  );

  perform public.keel_finish_command(
    p_command_id, 'transactions.manual_create', p_economic_event_key, p_household_id, p_actor,
    v_hash, 'transactions.manual_created', 'canonical_transaction', v_txn_id,
    jsonb_build_object('canonicalTransactionId', v_txn_id, 'batchId', v_batch_id),
    v_result
  );

  perform public.keel_enqueue('transaction_enrichment', jsonb_build_object(
    'jobType', 'enrich_transaction',
    'economicEventKey', p_economic_event_key || ':enrich',
    'refs', jsonb_build_object('canonicalTransactionId', v_txn_id::text)
  ));

  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. transactions.manual_void — reversal batch + journal_revisions + voided
-- status (Law 2: corrections are compensating events, originals preserved).
-- Guarded to source='manual' so the generic sync/void machinery stays the
-- only writer for synced rows. Payload: { transaction_id, reason }.
-- ---------------------------------------------------------------------------
create function public.keel_cmd_manual_void(
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
  v_txn public.canonical_transactions%rowtype;
  v_batch public.journal_batches%rowtype;
  v_reason text := btrim(coalesce(p_payload->>'reason', ''));
  v_reversal_id uuid;
  v_result jsonb;
begin
  perform public.keel_assert_member_write(p_household_id);
  p_actor := public.keel_actor_from_jwt();  -- ignore caller-supplied actor (forgery guard)
  v_replay := public.keel_idempotency_check(p_household_id, p_economic_event_key, v_hash);
  if v_replay is not null then
    return v_replay;
  end if;

  if char_length(v_reason) < 1 or char_length(v_reason) > 500 then
    raise exception 'KEEL_INVALID_COMMAND: reason must be 1-500 characters' using errcode = 'P0009';
  end if;

  select * into v_txn
    from public.canonical_transactions
    where id = (p_payload->>'transaction_id')::uuid
      and household_id = p_household_id;
  if not found then
    raise exception 'KEEL_SCOPE_VIOLATION: transaction not in household' using errcode = 'P0006';
  end if;
  if v_txn.source <> 'manual' then
    raise exception 'KEEL_INVALID_COMMAND: only manual transactions can be voided here' using errcode = 'P0009';
  end if;
  if v_txn.voided_at is not null then
    raise exception 'KEEL_IMMUTABLE: transaction is already voided' using errcode = 'P0001';
  end if;

  -- The live batch: non-reversal, not superseded by a revision.
  select jb.* into v_batch
    from public.journal_batches jb
    where jb.canonical_transaction_id = v_txn.id
      and jb.reverses_batch_id is null
      and not exists (
        select 1 from public.journal_revisions rev where rev.original_batch_id = jb.id
      )
    order by jb.posted_at desc, jb.id desc
    limit 1;
  if not found then
    raise exception 'KEEL_IMMUTABLE: no live batch to void' using errcode = 'P0001';
  end if;

  insert into public.journal_batches
    (household_id, canonical_transaction_id, description, effective_date,
     reverses_batch_id, command_id)
  values
    (p_household_id, v_txn.id, left('VOID: ' || v_reason, 500),
     v_batch.effective_date, v_batch.id, p_command_id)
  returning id into v_reversal_id;

  insert into public.journal_postings (batch_id, ledger_account_id, entity_id, amount_minor, currency)
  select v_reversal_id, p.ledger_account_id, p.entity_id, -p.amount_minor, p.currency
    from public.journal_postings p
   where p.batch_id = v_batch.id;

  insert into public.journal_revisions (original_batch_id, reversal_batch_id, reason)
  values (v_batch.id, v_reversal_id, v_reason);

  update public.canonical_transactions
     set status = 'voided', voided_at = now()
   where id = v_txn.id;

  v_result := jsonb_build_object(
    'commandId', p_command_id,
    'economicEventKey', p_economic_event_key,
    'idempotentReplay', false,
    'effects', jsonb_build_object(
      'canonicalTransactionId', v_txn.id,
      'originalBatchId', v_batch.id,
      'reversalBatchId', v_reversal_id
    ),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  );

  perform public.keel_finish_command(
    p_command_id, 'transactions.manual_void', p_economic_event_key, p_household_id, p_actor,
    v_hash, 'transactions.manual_voided', 'canonical_transaction', v_txn.id,
    jsonb_build_object('canonicalTransactionId', v_txn.id,
                       'originalBatchId', v_batch.id, 'reversalBatchId', v_reversal_id),
    v_result
  );

  return v_result;
end;
$$;

-- Ownership ritual (procs owned by keel_api; execute for authenticated only).
grant create on schema public to keel_api;
alter function public.keel_cmd_manual_transaction(uuid, text, jsonb, uuid, jsonb) owner to keel_api;
alter function public.keel_cmd_manual_void(uuid, text, jsonb, uuid, jsonb) owner to keel_api;
revoke create on schema public from keel_api;
revoke all on function public.keel_cmd_manual_transaction(uuid, text, jsonb, uuid, jsonb) from public, anon;
revoke all on function public.keel_cmd_manual_void(uuid, text, jsonb, uuid, jsonb) from public, anon;
grant execute on function public.keel_cmd_manual_transaction(uuid, text, jsonb, uuid, jsonb) to authenticated;
grant execute on function public.keel_cmd_manual_void(uuid, text, jsonb, uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Overlay hygiene: overlay rows on multi-offset batches predate the guards
-- below and can only disagree with the real split postings — remove them.
-- ---------------------------------------------------------------------------
delete from public.transaction_categories tc
using public.canonical_transactions ct
join public.journal_batches jb
  on jb.canonical_transaction_id = ct.id and jb.reverses_batch_id is null
 and not exists (
   select 1 from public.journal_revisions rev where rev.original_batch_id = jb.id
 )
where ct.id = tc.canonical_transaction_id
  and (
    select count(*) from public.journal_postings p
    join public.ledger_accounts l on l.id = p.ledger_account_id and l.is_category
    where p.batch_id = jb.id
  ) > 1;

-- ---------------------------------------------------------------------------
-- 4. Split-aware rich list. One row per transaction ALWAYS (fixes the live
-- duplicate-row bug for multi-offset batches). Single offset: unchanged
-- overlay-first category trio + NEW categoryPfcKey. Multi offset: category
-- trio null/'Split' + splits array; the overlay never re-labels a split txn.
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
        'splits', case when offs.n > 1 then offs.splits end,
        'transferStatus', tl.status
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
      left join public.transaction_categories tc on tc.canonical_transaction_id = ct.id
      left join public.ledger_accounts catov on catov.id = tc.category_ledger_account_id
      left join public.transaction_overrides tov on tov.canonical_transaction_id = ct.id
      left join public.rule_renames rr on rr.canonical_transaction_id = ct.id
      left join public.transfer_links tl
        on (tl.txn_out = ct.id or tl.txn_in = ct.id)
       and tl.status in ('suggested', 'confirmed')
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
-- 5. Overlay writers must skip split transactions (splits ARE the category).
-- 5a. keel_categorize_transaction: hard-error on multi-offset; also adopt the
-- live-batch predicate the read models use.
-- ---------------------------------------------------------------------------
create or replace function public.keel_categorize_transaction(
  p_household_id uuid,
  p_txn_id uuid,
  p_category_ledger_account_id uuid
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entity     uuid;
  v_offsets    int;
  v_new_is_cat boolean;
  v_new_entity uuid;
  v_old        uuid;
begin
  if auth.uid() is null then
    raise exception 'KEEL_NOT_AUTHENTICATED' using errcode = 'P0004';
  end if;
  if not exists (
    select 1 from public.household_memberships
    where household_id = p_household_id and user_id = auth.uid()
  ) then
    raise exception 'KEEL_NOT_FOUND' using errcode = 'P0006';
  end if;

  select jp.entity_id, count(*) over ()
    into v_entity, v_offsets
    from public.canonical_transactions ct
    join public.journal_batches jb
      on jb.canonical_transaction_id = ct.id and jb.reverses_batch_id is null
     and not exists (
       select 1 from public.journal_revisions rev where rev.original_batch_id = jb.id
     )
    join public.journal_postings jp on jp.batch_id = jb.id
    join public.ledger_accounts la on la.id = jp.ledger_account_id and la.is_category = true
    where ct.id = p_txn_id and ct.household_id = p_household_id
    limit 1;
  if v_entity is null then
    raise exception 'KEEL_NOT_FOUND: transaction' using errcode = 'P0006';
  end if;
  if v_offsets > 1 then
    raise exception 'KEEL_INVALID_COMMAND: split transactions are categorized by their splits' using errcode = 'P0009';
  end if;

  select is_category, entity_id into v_new_is_cat, v_new_entity
    from public.ledger_accounts where id = p_category_ledger_account_id;
  if v_new_is_cat is not true or v_new_entity <> v_entity then
    raise exception 'KEEL_INVALID_COMMAND: invalid category' using errcode = 'P0009';
  end if;

  select category_ledger_account_id into v_old
    from public.transaction_categories where canonical_transaction_id = p_txn_id;

  insert into public.transaction_categories
    (canonical_transaction_id, household_id, category_ledger_account_id, source)
  values (p_txn_id, p_household_id, p_category_ledger_account_id, 'user')
  on conflict (canonical_transaction_id) do update
    set category_ledger_account_id = excluded.category_ledger_account_id,
        source = 'user', updated_at = now();

  insert into public.audit_log (household_id, actor, action, object_type, object_id, before, after)
  values (p_household_id, jsonb_build_object('kind', 'user', 'userId', auth.uid()),
          'transaction.categorize', 'canonical_transaction', p_txn_id,
          jsonb_build_object('categoryLedgerAccountId', v_old),
          jsonb_build_object('categoryLedgerAccountId', p_category_ledger_account_id));
end;
$$;

grant execute on function public.keel_categorize_transaction(uuid, uuid, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5b. keel_apply_rules: match single-offset transactions only. One guard in
-- the matches CTE keeps dry-run == apply (preview integrity, BC §3) — split
-- transactions were named and categorized by the user at entry.
-- ---------------------------------------------------------------------------
create or replace function public.keel_apply_rules(
  p_household_id uuid,
  p_dry_run boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_categorized int := 0;
  v_renamed int := 0;
begin
  if auth.uid() is not null and not exists (
    select 1 from public.household_memberships
    where household_id = p_household_id and user_id = auth.uid()
  ) then
    raise exception 'KEEL_NOT_FOUND' using errcode = 'P0006';
  end if;

  drop table if exists _rule_winners;
  create temporary table _rule_winners on commit drop as
  with matches as (
    select ct.id as txn_id, r.id as rule_id,
           r.category_ledger_account_id, r.rename_to,
           r.priority, r.created_at, offcat.kind as txn_kind,
           rulecat.kind as rule_kind
      from public.canonical_transactions ct
      join public.journal_batches jb
        on jb.canonical_transaction_id = ct.id and jb.reverses_batch_id is null
      join public.journal_postings offp on offp.batch_id = jb.id
      join public.ledger_accounts offcat
        on offcat.id = offp.ledger_account_id and offcat.is_category = true
      join public.category_rules r
        on r.household_id = ct.household_id
       and r.active
       and position(lower(r.pattern) in lower(ct.description)) > 0
      left join public.ledger_accounts rulecat on rulecat.id = r.category_ledger_account_id
      where ct.household_id = p_household_id
        and ct.voided_at is null
        -- Live batch only (sync revisions leave a superseded non-reversal batch).
        and not exists (
          select 1 from public.journal_revisions rev where rev.original_batch_id = jb.id
        )
        -- Same-entity invariant: a rule's category may only classify
        -- transactions of that category's entity (matches keel_categorize).
        and (r.category_ledger_account_id is null or rulecat.entity_id = offp.entity_id)
        -- Single-offset only: a split transaction is categorized by its
        -- splits, and the multi-way join would fan out per split.
        and (
          select count(*) from public.journal_postings p2
          join public.ledger_accounts l2 on l2.id = p2.ledger_account_id and l2.is_category
          where p2.batch_id = jb.id
        ) = 1
  )
  select distinct on (txn_id)
         txn_id, rule_id, category_ledger_account_id, rename_to, txn_kind, rule_kind
    from matches
    order by txn_id, priority, created_at, rule_id;

  if p_dry_run then
    select count(*) into v_categorized
      from _rule_winners w
      left join public.transaction_categories tc on tc.canonical_transaction_id = w.txn_id
      where w.category_ledger_account_id is not null
        and w.rule_kind = w.txn_kind
        and (tc.canonical_transaction_id is null
             or (tc.source <> 'user'
                 and tc.category_ledger_account_id <> w.category_ledger_account_id));
    select count(*) into v_renamed
      from _rule_winners w
      left join public.rule_renames rr on rr.canonical_transaction_id = w.txn_id
      where w.rename_to is not null
        and (rr.canonical_transaction_id is null or rr.display_name <> w.rename_to);
    return jsonb_build_object('dryRun', true, 'categorized', v_categorized, 'renamed', v_renamed);
  end if;

  insert into public.transaction_categories
    (canonical_transaction_id, household_id, category_ledger_account_id, source, rule_id)
  select w.txn_id, p_household_id, w.category_ledger_account_id, 'rule', w.rule_id
    from _rule_winners w
    where w.category_ledger_account_id is not null and w.rule_kind = w.txn_kind
  -- Predicate matches the dry-run count EXACTLY (preview integrity, BC §3):
  -- only rows whose category actually changes, never user rows. A plaid_pfc
  -- row already holding the same category keeps its provenance untouched.
  on conflict (canonical_transaction_id) do update
    set category_ledger_account_id = excluded.category_ledger_account_id,
        source = 'rule', rule_id = excluded.rule_id, updated_at = now()
    where transaction_categories.source <> 'user'
      and transaction_categories.category_ledger_account_id
            <> excluded.category_ledger_account_id;
  get diagnostics v_categorized = row_count;

  insert into public.rule_renames
    (canonical_transaction_id, household_id, rule_id, display_name)
  select w.txn_id, p_household_id, w.rule_id, w.rename_to
    from _rule_winners w
    where w.rename_to is not null
  on conflict (canonical_transaction_id) do update
    set rule_id = excluded.rule_id, display_name = excluded.display_name, updated_at = now()
    where rule_renames.display_name <> excluded.display_name
       or rule_renames.rule_id <> excluded.rule_id;
  get diagnostics v_renamed = row_count;

  if v_categorized > 0 or v_renamed > 0 then
    insert into public.audit_log (household_id, actor, action, object_type, object_id, after)
    values (p_household_id,
            case when auth.uid() is null
                 then jsonb_build_object('kind', 'system', 'source', 'rules_engine')
                 else jsonb_build_object('kind', 'user', 'userId', auth.uid()) end,
            'rules.apply', 'household', p_household_id,
            jsonb_build_object('categorized', v_categorized, 'renamed', v_renamed));
  end if;
  return jsonb_build_object('dryRun', false, 'categorized', v_categorized, 'renamed', v_renamed);
end;
$$;

revoke all on function public.keel_apply_rules(uuid, boolean) from public, anon;
grant execute on function public.keel_apply_rules(uuid, boolean) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. Budgets: the spent CTE already sums per offset posting (splits land on
-- their own categories naturally), but the txn-level overlay must re-attribute
-- ONLY single-offset transactions. formulaVersion bumped.
-- ---------------------------------------------------------------------------
create or replace function public.keel_list_budgets(
  p_household_id uuid,
  p_month date
) returns jsonb
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
  v_month date := date_trunc('month', p_month)::date;
  v_next date := (date_trunc('month', p_month) + interval '1 month')::date;
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

  with offn as (
    select jp.batch_id, count(*) as n
      from public.journal_postings jp
      join public.ledger_accounts l on l.id = jp.ledger_account_id and l.is_category
      join public.journal_batches jb2 on jb2.id = jp.batch_id
      where jb2.household_id = p_household_id
      group by 1
  ),
  spent as (
    select case when offn.n = 1 then coalesce(tc.category_ledger_account_id, offcat.id)
                else offcat.id end as category_id,
           sum(offp.amount_minor)::bigint as spent_minor
      from public.canonical_transactions ct
      join public.journal_batches jb
        on jb.canonical_transaction_id = ct.id and jb.reverses_batch_id is null
       -- Live batch only: a sync revision leaves the superseded original as a
       -- second non-reversal batch; without this a revised charge double-counts.
       and not exists (
         select 1 from public.journal_revisions rev where rev.original_batch_id = jb.id
       )
      join public.journal_postings offp on offp.batch_id = jb.id
      join public.ledger_accounts offcat
        on offcat.id = offp.ledger_account_id and offcat.is_category = true
      join offn on offn.batch_id = jb.id
      left join public.transaction_categories tc on tc.canonical_transaction_id = ct.id
      left join public.ledger_accounts overcat
        on overcat.id = tc.category_ledger_account_id
      where ct.household_id = p_household_id
        and ct.voided_at is null
        and jb.effective_date >= v_month and jb.effective_date < v_next
        and (case when offn.n = 1 then coalesce(overcat.kind, offcat.kind)
                  else offcat.kind end) = 'expense'
        and offp.currency = (case when offn.n = 1 then coalesce(overcat.currency, offcat.currency)
                                  else offcat.currency end)
        and not exists (
          select 1 from public.transfer_links tl
          where tl.household_id = p_household_id
            and tl.status = 'confirmed'
            and (tl.txn_out = ct.id or tl.txn_in = ct.id)
        )
      group by 1
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'categoryLedgerAccountId', la.id,
           'categoryName', la.name,
           'currency', la.currency,
           'parentLedgerAccountId', la.parent_ledger_account_id,
           'budgetMinor', b.amount_minor::text,
           'spentMinor', coalesce(s.spent_minor, 0)::text
         ) order by la.name), '[]'::jsonb)
    into v_rows
    from public.ledger_accounts la
    left join public.budgets b
      on b.household_id = la.household_id
     and b.category_ledger_account_id = la.id
     and b.month = v_month
    left join spent s on s.category_id = la.id
    where la.household_id = p_household_id
      and la.is_category = true and la.kind = 'expense' and la.archived_at is null;

  return jsonb_build_object(
    'scope', jsonb_build_object('householdId', p_household_id, 'month', to_char(v_month, 'YYYY-MM')),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'formulaVersion', 'budget-spent-v2-split-aware',
    'rows', v_rows
  );
end;
$$;

revoke all on function public.keel_list_budgets(uuid, date) from public, anon;
grant execute on function public.keel_list_budgets(uuid, date) to authenticated, service_role;
