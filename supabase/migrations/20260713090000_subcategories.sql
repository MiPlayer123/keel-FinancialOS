-- Subcategories + category management (T0.5 completion; Quicken-style
-- one-level category tree). The blocker for rename/archive was that system
-- categories were joined BY NAME in four places (autocategorize, seeding
-- dedupe, worker offset lookups, opening-balance lookup). This migration
-- gives every seeded system category a STABLE KEY (pfc_key), rekeys every
-- name-based join to it, and only then introduces rename/archive/reparent.
-- Ordering inside this file matters: columns → backfill → key function →
-- rekeyed functions → tree trigger → management procs → export DTO.
--
-- Law 4 note (no implicit defaults): is_system uses `default false` solely so
-- the ALTER backfills existing rows; every write path below supplies it
-- explicitly. Deviation recorded in NOTES.md.

-- ---------------------------------------------------------------------------
-- 1. Columns + indexes
-- ---------------------------------------------------------------------------
alter table public.ledger_accounts
  add column if not exists pfc_key text null check (pfc_key ~ '^[a-z0-9_]{2,40}$'),
  add column if not exists is_system boolean not null default false,
  add column if not exists parent_ledger_account_id uuid null
    references public.ledger_accounts (id);

create unique index if not exists ledger_accounts_pfc_key
  on public.ledger_accounts (entity_id, pfc_key) where pfc_key is not null;
create index if not exists ledger_accounts_parent
  on public.ledger_accounts (parent_ledger_account_id)
  where parent_ledger_account_id is not null;

-- ---------------------------------------------------------------------------
-- 2. Backfill: stamp every seeded system category (keyed on name+kind — safe
-- exactly once, BEFORE rename exists; keel_create_category rejects CI name
-- collisions so user categories can't shadow these names). No is_category
-- filter: 'Opening Balances' is seeded is_category=false.
-- ---------------------------------------------------------------------------
update public.ledger_accounts la
   set pfc_key = m.key, is_system = true
  from (values
    ('Uncategorized Expense',  'expense', 'uncategorized_expense'),
    ('Uncategorized Income',   'income',  'uncategorized_income'),
    ('Opening Balances',       'equity',  'opening_balances'),
    ('Fees',                   'expense', 'fees'),
    ('Entertainment',          'expense', 'entertainment'),
    ('Food & Drink',           'expense', 'food_drink'),
    ('Shopping',               'expense', 'shopping'),
    ('Services',               'expense', 'services'),
    ('Government & Nonprofit', 'expense', 'government_nonprofit'),
    ('Home',                   'expense', 'home'),
    ('Loan Payments',          'expense', 'loan_payments'),
    ('Medical',                'expense', 'medical'),
    ('Personal Care',          'expense', 'personal_care'),
    ('Bills & Utilities',      'expense', 'bills_utilities'),
    ('Transportation',         'expense', 'transportation'),
    ('Travel',                 'expense', 'travel'),
    ('Transfers',              'expense', 'transfers'),
    ('Other',                  'expense', 'other'),
    ('Income',                 'income',  'income'),
    ('Other Income',           'income',  'other_income')
  ) m(name, kind, key)
 where la.name = m.name
   and la.kind = m.kind::public.ledger_account_kind
   and la.archived_at is null
   and la.pfc_key is null;

-- ---------------------------------------------------------------------------
-- 3. Plaid PFC primary → stable category key (companion to
-- keel_pfc_to_category_name, which stays for reference but is no longer
-- joined against — names are display-only from here on).
-- ---------------------------------------------------------------------------
create or replace function public.keel_pfc_to_category_key(
  p_primary text,
  p_kind public.ledger_account_kind
) returns text
language sql
immutable
as $$
  select case
    when p_kind = 'income' then
      case when p_primary = 'INCOME' then 'income' else 'other_income' end
    else
      case p_primary
        when 'BANK_FEES' then 'fees'
        when 'ENTERTAINMENT' then 'entertainment'
        when 'FOOD_AND_DRINK' then 'food_drink'
        when 'GENERAL_MERCHANDISE' then 'shopping'
        when 'GENERAL_SERVICES' then 'services'
        when 'GOVERNMENT_AND_NON_PROFIT' then 'government_nonprofit'
        when 'HOME_IMPROVEMENT' then 'home'
        when 'LOAN_PAYMENTS' then 'loan_payments'
        when 'MEDICAL' then 'medical'
        when 'PERSONAL_CARE' then 'personal_care'
        when 'RENT_AND_UTILITIES' then 'bills_utilities'
        when 'TRANSPORTATION' then 'transportation'
        when 'TRAVEL' then 'travel'
        when 'TRANSFER_OUT' then 'transfers'
        when 'TRANSFER_IN' then 'transfers'
        else 'other'
      end
  end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Seeding: supply pfc_key/is_system explicitly; dedupe by pfc_key (a
-- renamed system category must NOT be re-inserted under its canonical name,
-- and an archived one must NOT be resurrected behind the user's back).
-- ---------------------------------------------------------------------------
create or replace function public.keel_seed_entity_categories(
  p_entity_id uuid,
  p_household_id uuid
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Fail closed on a forged pairing: the entity must belong to the household
  -- (adversarial-review finding — this proc previously trusted its args).
  if not exists (
    select 1 from public.entities e
    where e.id = p_entity_id and e.household_id = p_household_id
  ) then
    raise exception 'KEEL_SCOPE_VIOLATION: entity not in household' using errcode = 'P0006';
  end if;

  insert into public.ledger_accounts
    (household_id, entity_id, name, kind, currency, is_category, pfc_key, is_system)
  select p_household_id, p_entity_id, d.name, d.kind::public.ledger_account_kind,
         'USD', d.is_category, d.pfc_key, true
  from (values
    ('Uncategorized Expense',  'expense', true,  'uncategorized_expense'),
    ('Uncategorized Income',   'income',  true,  'uncategorized_income'),
    ('Opening Balances',       'equity',  false, 'opening_balances'),
    ('Fees',                   'expense', true,  'fees'),
    ('Entertainment',          'expense', true,  'entertainment'),
    ('Food & Drink',           'expense', true,  'food_drink'),
    ('Shopping',               'expense', true,  'shopping'),
    ('Services',               'expense', true,  'services'),
    ('Government & Nonprofit', 'expense', true,  'government_nonprofit'),
    ('Home',                   'expense', true,  'home'),
    ('Loan Payments',          'expense', true,  'loan_payments'),
    ('Medical',                'expense', true,  'medical'),
    ('Personal Care',          'expense', true,  'personal_care'),
    ('Bills & Utilities',      'expense', true,  'bills_utilities'),
    ('Transportation',         'expense', true,  'transportation'),
    ('Travel',                 'expense', true,  'travel'),
    ('Transfers',              'expense', true,  'transfers'),
    ('Other',                  'expense', true,  'other'),
    ('Income',                 'income',  true,  'income'),
    ('Other Income',           'income',  true,  'other_income')
  ) as d(name, kind, is_category, pfc_key)
  where not exists (
    select 1 from public.ledger_accounts la
    where la.entity_id = p_entity_id and la.pfc_key = d.pfc_key
  );
end;
$$;

grant execute on function public.keel_seed_entity_categories(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 5. Autocategorize: join the PFC mapping by pfc_key (rename-proof; archived
-- system category degrades gracefully — the join misses and the transaction
-- stays uncategorized).
-- ---------------------------------------------------------------------------
create or replace function public.keel_autocategorize_household(p_household_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  with pfc as (
    select distinct on (elem->>'transaction_id')
           elem->>'transaction_id' as ptid,
           coalesce(elem->'personal_finance_category'->>'primary', '') as primary
      from public.raw_provider_events r
      cross join lateral jsonb_array_elements(
        coalesce(r.body_text::jsonb->'added', '[]'::jsonb)) elem
      where r.household_id = p_household_id
        and (r.body_text::jsonb) ? 'added'
      order by elem->>'transaction_id', r.received_at desc
  ),
  mapped as (
    select ct.id as txn_id, ct.household_id, jp.entity_id, la.kind,
           public.keel_pfc_to_category_key(pfc.primary, la.kind) as cat_key
      from public.canonical_transactions ct
      join public.journal_batches jb
        on jb.canonical_transaction_id = ct.id and jb.reverses_batch_id is null
       -- Live batch only: a sign-flipping sync revision must not let the
       -- superseded batch's kind race the replacement's.
       and not exists (
         select 1 from public.journal_revisions rev where rev.original_batch_id = jb.id
       )
      join public.journal_postings jp on jp.batch_id = jb.id
      join public.ledger_accounts la on la.id = jp.ledger_account_id and la.is_category = true
      join public.transaction_source_links tsl on tsl.canonical_transaction_id = ct.id
      join public.normalized_source_records nsr on nsr.id = tsl.normalized_source_record_id
      join pfc on pfc.ptid = nsr.provider_transaction_id
      where ct.household_id = p_household_id
  )
  insert into public.transaction_categories
    (canonical_transaction_id, household_id, category_ledger_account_id, source)
  select m.txn_id, m.household_id, cat.id, 'plaid_pfc'
    from mapped m
    join public.ledger_accounts cat
      on cat.entity_id = m.entity_id and cat.pfc_key = m.cat_key
     and cat.is_category = true and cat.kind = m.kind and cat.archived_at is null
  on conflict (canonical_transaction_id) do nothing;
  get diagnostics v_count = row_count;

  if v_count > 0 then
    insert into public.audit_log (household_id, actor, action, object_type, object_id, after)
    values (p_household_id, jsonb_build_object('kind', 'system', 'source', 'plaid_pfc'),
            'transactions.autocategorize', 'household', p_household_id,
            jsonb_build_object('classified', v_count));
  end if;
  return v_count;
end;
$$;

grant execute on function public.keel_autocategorize_household(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 6. Worker promotion offsets: look up the Uncategorized landing pads by
-- pfc_key. Without this, renaming either Uncategorized bricks sync ingestion
-- ("offset category missing"). Full recreate of keel_worker_apply_action
-- (live body: 20260711170000) with ONLY the two offset lookups changed.
-- ---------------------------------------------------------------------------
create or replace function public.keel_worker_apply_action(
  p_normalized_id uuid,
  p_action_kind text,
  p_economic_key text,
  p_apply_key text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_nsr public.normalized_source_records%rowtype;
  v_account public.accounts%rowtype;
  v_conn public.connections%rowtype;
  v_connection_id uuid;
  v_offset_id uuid;
  v_hash text := public.keel_payload_hash(jsonb_build_object(
    'normalizedId', p_normalized_id, 'kind', p_action_kind, 'key', p_economic_key));
  v_replay jsonb;
  v_actor jsonb := jsonb_build_object('kind', 'system', 'processName', 'sync-worker');
  v_command_id uuid := gen_random_uuid();
  v_txn_id uuid;
  v_batch_id uuid;
  v_reversal_id uuid;
  v_prev_batch record;
  v_result jsonb;
begin
  select * into v_nsr
    from public.normalized_source_records
   where id = p_normalized_id;
  if not found then
    raise exception 'KEEL_SCOPE_VIOLATION: unknown normalized record' using errcode = 'P0006';
  end if;

  select connection_id into v_connection_id
    from public.raw_provider_events
   where id = v_nsr.raw_event_id;
  select * into v_conn
    from public.connections
   where id = v_connection_id
   for no key update;
  if not found or v_conn.status is distinct from 'active' then
    raise exception 'KEEL_SYNC_SUPERSEDED' using errcode = 'P0007';
  end if;

  v_replay := public.keel_idempotency_check(v_nsr.household_id, p_apply_key, v_hash);
  if v_replay is not null then
    return v_replay;
  end if;

  if p_action_kind = 'noop' then
    v_result := jsonb_build_object(
      'commandId', v_command_id,
      'economicEventKey', p_apply_key,
      'idempotentReplay', false,
      'effects', jsonb_build_object('kind', 'noop'),
      'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
    );
    insert into public.command_executions
      (household_id, economic_event_key, command_id, command, payload_sha256, result)
    values
      (v_nsr.household_id, p_apply_key, v_command_id,
       'ingest.apply_action', v_hash, v_result);
    return v_result;
  end if;

  if p_action_kind in ('create', 'revise') and v_nsr.kind = 'removed' then
    raise exception 'KEEL_INVALID_COMMAND: removed record cannot be % ', p_action_kind
      using errcode = 'P0009';
  end if;

  if p_action_kind = 'create' then
    select * into v_account from public.accounts where id = v_nsr.account_id;
    select la.id into v_offset_id
      from public.ledger_accounts la
     where la.entity_id = v_account.entity_id
       and la.pfc_key = case when v_nsr.amount_minor < 0 then 'uncategorized_expense'
                             else 'uncategorized_income' end;
    if v_offset_id is null then
      raise exception 'KEEL_INVALID_COMMAND: offset category missing' using errcode = 'P0009';
    end if;

    insert into public.canonical_transactions
      (household_id, entity_id, account_id, status, source, description,
       effective_date, economic_event_key)
    values
      (v_nsr.household_id, v_account.entity_id, v_account.id,
       case when v_nsr.pending then 'pending'::public.transaction_status
            else 'posted'::public.transaction_status end,
       'sync', left(v_nsr.description, 500), v_nsr.effective_date, p_economic_key)
    returning id into v_txn_id;

    insert into public.transaction_source_links
      (canonical_transaction_id, normalized_source_record_id)
    values (v_txn_id, v_nsr.id);

    insert into public.journal_batches
      (household_id, canonical_transaction_id, description, effective_date, command_id)
    values
      (v_nsr.household_id, v_txn_id, left(v_nsr.description, 500),
       v_nsr.effective_date, v_command_id)
    returning id into v_batch_id;

    perform public.keel_insert_postings(v_nsr.household_id, v_batch_id, jsonb_build_array(
      jsonb_build_object(
        'ledger_account_id', v_account.ledger_account_id,
        'amount_minor', v_nsr.amount_minor::text,
        'currency', v_nsr.currency),
      jsonb_build_object(
        'ledger_account_id', v_offset_id,
        'amount_minor', (-v_nsr.amount_minor)::text,
        'currency', v_nsr.currency)
    ));

    v_result := jsonb_build_object(
      'commandId', v_command_id,
      'economicEventKey', p_apply_key,
      'idempotentReplay', false,
      'effects', jsonb_build_object(
        'kind', 'create', 'canonicalTransactionId', v_txn_id, 'batchId', v_batch_id),
      'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
    );
    perform public.keel_finish_command(
      v_command_id, 'ingest.apply_action', p_apply_key, v_nsr.household_id,
      v_actor, v_hash, 'ingest.transaction_created', 'canonical_transaction',
      v_txn_id, jsonb_build_object('economicKey', p_economic_key), v_result);
    return v_result;
  end if;

  select id into v_txn_id
    from public.canonical_transactions
   where household_id = v_nsr.household_id
     and economic_event_key = p_economic_key;
  if v_txn_id is null then
    raise exception 'KEEL_SCOPE_VIOLATION: unknown canonical for key %', p_economic_key
      using errcode = 'P0006';
  end if;

  select b.id, b.effective_date into v_prev_batch
    from public.journal_batches b
   where b.canonical_transaction_id = v_txn_id
     and b.reverses_batch_id is null
     and not exists (
       select 1 from public.journal_revisions r where r.original_batch_id = b.id
     )
   order by b.posted_at desc, b.id desc
   limit 1;
  if v_prev_batch.id is null then
    raise exception 'KEEL_IMMUTABLE: no live batch to correct' using errcode = 'P0001';
  end if;

  insert into public.journal_batches
    (household_id, canonical_transaction_id, description, effective_date,
     reverses_batch_id, command_id)
  values
    (v_nsr.household_id, v_txn_id, 'REVERSAL: sync ' || p_action_kind,
     v_prev_batch.effective_date, v_prev_batch.id, v_command_id)
  returning id into v_reversal_id;

  insert into public.journal_postings
    (batch_id, ledger_account_id, entity_id, amount_minor, currency)
  select v_reversal_id, p.ledger_account_id, p.entity_id, -p.amount_minor, p.currency
    from public.journal_postings p
   where p.batch_id = v_prev_batch.id;

  if p_action_kind = 'revise' then
    select * into v_account from public.accounts where id = v_nsr.account_id;
    select la.id into v_offset_id
      from public.ledger_accounts la
     where la.entity_id = v_account.entity_id
       and la.pfc_key = case when v_nsr.amount_minor < 0 then 'uncategorized_expense'
                             else 'uncategorized_income' end;
    if v_offset_id is null then
      raise exception 'KEEL_INVALID_COMMAND: offset category missing' using errcode = 'P0009';
    end if;

    insert into public.transaction_source_links
      (canonical_transaction_id, normalized_source_record_id)
    values (v_txn_id, v_nsr.id);

    insert into public.journal_batches
      (household_id, canonical_transaction_id, description, effective_date, command_id)
    values
      (v_nsr.household_id, v_txn_id, left(v_nsr.description, 500),
       v_nsr.effective_date, v_command_id)
    returning id into v_batch_id;

    perform public.keel_insert_postings(v_nsr.household_id, v_batch_id, jsonb_build_array(
      jsonb_build_object(
        'ledger_account_id', v_account.ledger_account_id,
        'amount_minor', v_nsr.amount_minor::text,
        'currency', v_nsr.currency),
      jsonb_build_object(
        'ledger_account_id', v_offset_id,
        'amount_minor', (-v_nsr.amount_minor)::text,
        'currency', v_nsr.currency)
    ));

    insert into public.journal_revisions
      (original_batch_id, reversal_batch_id, replacement_batch_id, reason)
    values (v_prev_batch.id, v_reversal_id, v_batch_id, 'sync supersession');

    update public.canonical_transactions
       set status = case when v_nsr.pending then 'pending'::public.transaction_status
                         else 'posted'::public.transaction_status end,
           description = left(v_nsr.description, 500),
           effective_date = v_nsr.effective_date,
           voided_at = null
     where id = v_txn_id;

    v_result := jsonb_build_object(
      'commandId', v_command_id,
      'economicEventKey', p_apply_key,
      'idempotentReplay', false,
      'effects', jsonb_build_object(
        'kind', 'revise', 'canonicalTransactionId', v_txn_id,
        'reversalBatchId', v_reversal_id, 'replacementBatchId', v_batch_id),
      'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
    );
    perform public.keel_finish_command(
      v_command_id, 'ingest.apply_action', p_apply_key, v_nsr.household_id,
      v_actor, v_hash, 'ingest.transaction_revised', 'canonical_transaction',
      v_txn_id, jsonb_build_object('economicKey', p_economic_key), v_result);
    return v_result;
  end if;

  insert into public.journal_revisions
    (original_batch_id, reversal_batch_id, replacement_batch_id, reason)
  values (v_prev_batch.id, v_reversal_id, null, 'sync removal');
  insert into public.transaction_source_links
    (canonical_transaction_id, normalized_source_record_id)
  values (v_txn_id, v_nsr.id);
  update public.canonical_transactions
     set status = 'voided', voided_at = now()
   where id = v_txn_id;

  v_result := jsonb_build_object(
    'commandId', v_command_id,
    'economicEventKey', p_apply_key,
    'idempotentReplay', false,
    'effects', jsonb_build_object(
      'kind', 'void', 'canonicalTransactionId', v_txn_id,
      'reversalBatchId', v_reversal_id),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  );
  perform public.keel_finish_command(
    v_command_id, 'ingest.apply_action', p_apply_key, v_nsr.household_id,
    v_actor, v_hash, 'ingest.transaction_voided', 'canonical_transaction',
    v_txn_id, jsonb_build_object('economicKey', p_economic_key), v_result);
  return v_result;
end;
$$;

-- create-or-replace preserves owner/grants, but re-assert the worker ritual
-- exactly as 20260711170000 did (defense against a fresh-db replay ordering).
grant create on schema public to keel_worker;
alter function public.keel_worker_apply_action(uuid, text, text, text) owner to keel_worker;
revoke all on function public.keel_worker_apply_action(uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.keel_worker_apply_action(uuid, text, text, text)
  to service_role;
revoke create on schema public from keel_worker;

-- ---------------------------------------------------------------------------
-- 7. Opening-balance booking: find the equity account by key, not name.
-- ---------------------------------------------------------------------------
create or replace function public.keel_apply_account_balance(
  p_household_id uuid,
  p_account_id uuid,
  p_current_minor bigint,
  p_available_minor bigint,
  p_currency text,
  p_as_of timestamptz
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
begin
  select a.ledger_account_id, a.entity_id, a.currency
    into v_ledger, v_entity, v_curr
    from public.accounts a
    where a.id = p_account_id and a.household_id = p_household_id;
  if v_ledger is null then
    raise exception 'KEEL_NOT_FOUND: account' using errcode = 'P0006';
  end if;
  select kind into v_kind from public.ledger_accounts where id = v_ledger;

  insert into public.balance_snapshots
    (household_id, account_id, as_of, available_minor, current_minor, currency, source, snapshot_metadata)
  values
    (p_household_id, p_account_id, p_as_of, p_available_minor, p_current_minor,
     coalesce(nullif(p_currency, ''), v_curr), 'plaid', '{}'::jsonb);

  select exists (
    select 1
      from public.journal_batches b
      join public.journal_postings p on p.batch_id = b.id
      where b.household_id = p_household_id
        and b.canonical_transaction_id is null
        and b.reverses_batch_id is null
        and p.ledger_account_id = v_ledger
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

  select id into v_opening_ledger
    from public.ledger_accounts
    where entity_id = v_entity and pfc_key = 'opening_balances' and archived_at is null;
  if v_opening_ledger is null then
    raise exception 'KEEL_INVALID_COMMAND: opening balances account missing' using errcode = 'P0009';
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

grant execute on function public.keel_apply_account_balance(uuid, uuid, bigint, bigint, text, timestamptz)
  to service_role;

-- ---------------------------------------------------------------------------
-- 8. Category list read model: expose the tree + system flags; drop the dead
-- name filter (Opening Balances is is_category=false — is_category is the
-- durable gate). Children sort directly under their parent.
-- ---------------------------------------------------------------------------
create or replace function public.keel_list_categories(p_household_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := coalesce(
    nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
    nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid;
  v_rows jsonb;
begin
  if v_uid is not null and not exists (
    select 1 from public.household_memberships m
     where m.household_id = p_household_id and m.user_id = v_uid
  ) then
    raise exception 'KEEL_SCOPE_VIOLATION' using errcode = 'P0006';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'ledgerAccountId', t.id,
           'name', t.name,
           'kind', t.kind,
           'entityId', t.entity_id,
           'parentLedgerAccountId', t.parent_ledger_account_id,
           'isSystem', t.is_system,
           'pfcKey', t.pfc_key
         ) order by t.kind, t.group_name, t.depth, t.name), '[]'::jsonb)
    into v_rows
    from (
      select la.*, coalesce(parent.name, la.name) as group_name,
             case when la.parent_ledger_account_id is null then 0 else 1 end as depth
        from public.ledger_accounts la
        left join public.ledger_accounts parent on parent.id = la.parent_ledger_account_id
        where la.household_id = p_household_id
          and la.is_category = true
          and la.archived_at is null
    ) t;
  return v_rows;
end;
$$;

grant execute on function public.keel_list_categories(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 9. One-level tree lattice, enforced at the row level. Structural rules:
-- parent in same entity + kind, both sides is_category, parent live, parent
-- not itself a child, and a row with children can never become a child —
-- cycles are structurally impossible without recursive checks.
-- ---------------------------------------------------------------------------
create or replace function public.keel_check_category_parent()
returns trigger
language plpgsql
as $$
declare
  v_parent public.ledger_accounts%rowtype;
begin
  -- Archiving a parent with live children would orphan them in every picker.
  if tg_op = 'UPDATE' and new.archived_at is not null and old.archived_at is null
     and exists (
       select 1 from public.ledger_accounts c
       where c.parent_ledger_account_id = new.id and c.archived_at is null
     ) then
    raise exception 'KEEL_INVALID_COMMAND: category has live subcategories' using errcode = 'P0009';
  end if;

  if new.parent_ledger_account_id is null then
    return new;
  end if;
  if new.parent_ledger_account_id = new.id then
    raise exception 'KEEL_INVALID_COMMAND: a category cannot be its own parent' using errcode = 'P0009';
  end if;
  if new.is_category is not true then
    raise exception 'KEEL_INVALID_COMMAND: only categories can be nested' using errcode = 'P0009';
  end if;
  if exists (
    select 1 from public.ledger_accounts c where c.parent_ledger_account_id = new.id
  ) then
    raise exception 'KEEL_INVALID_COMMAND: category has subcategories and cannot be nested' using errcode = 'P0009';
  end if;

  -- Key-share the parent so a concurrent "nest the parent under X" commits
  -- strictly before or after this row's check, not interleaved.
  select * into v_parent from public.ledger_accounts
    where id = new.parent_ledger_account_id
    for key share;
  if not found
     or v_parent.entity_id <> new.entity_id
     or v_parent.kind <> new.kind
     or v_parent.is_category is not true
     or v_parent.archived_at is not null
     or v_parent.parent_ledger_account_id is not null then
    raise exception 'KEEL_INVALID_COMMAND: invalid parent category' using errcode = 'P0009';
  end if;
  return new;
end;
$$;

drop trigger if exists ledger_accounts_category_parent on public.ledger_accounts;
create trigger ledger_accounts_category_parent
  before insert or update of parent_ledger_account_id, archived_at
  on public.ledger_accounts
  for each row execute function public.keel_check_category_parent();

-- ---------------------------------------------------------------------------
-- 10. Category management procs (house style of keel_create_category:
-- auth gate → membership gate → validate → mutate → audit_log).
-- ---------------------------------------------------------------------------

-- Rename. Allowed for system categories too: after the rekeys above, names
-- are display-only (pfc_key is never user-writable, so autocategorize /
-- worker offsets / seeding are rename-proof).
create or replace function public.keel_rename_category(
  p_household_id uuid,
  p_category_ledger_account_id uuid,
  p_name text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text := btrim(coalesce(p_name, ''));
  v_row public.ledger_accounts%rowtype;
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
  if char_length(v_name) < 1 or char_length(v_name) > 80 then
    raise exception 'KEEL_INVALID_COMMAND: category name must be 1-80 characters' using errcode = 'P0009';
  end if;

  select * into v_row from public.ledger_accounts
    where id = p_category_ledger_account_id and household_id = p_household_id
      and is_category = true and archived_at is null;
  if not found then
    raise exception 'KEEL_NOT_FOUND: category' using errcode = 'P0006';
  end if;
  if v_row.name = v_name then
    return;
  end if;
  if exists (
    select 1 from public.ledger_accounts
    where entity_id = v_row.entity_id and is_category = true and archived_at is null
      and lower(name) = lower(v_name) and id <> v_row.id
  ) then
    raise exception 'KEEL_INVALID_COMMAND: a category with this name exists' using errcode = 'P0009';
  end if;

  begin
    update public.ledger_accounts set name = v_name where id = v_row.id;
  exception when unique_violation then
    raise exception 'KEEL_INVALID_COMMAND: a category with this name exists' using errcode = 'P0009';
  end;

  insert into public.audit_log (household_id, actor, action, object_type, object_id, before, after)
  values (p_household_id, jsonb_build_object('kind', 'user', 'userId', auth.uid()),
          'categories.rename', 'ledger_account', v_row.id,
          jsonb_build_object('name', v_row.name),
          jsonb_build_object('name', v_name));
end;
$$;

revoke all on function public.keel_rename_category(uuid, uuid, text) from public, anon;
grant execute on function public.keel_rename_category(uuid, uuid, text) to authenticated;

-- Archive (soft-hide). Postings are never rewritten (append-only truth);
-- overlays/rules/budgets/series either move to p_reassign_to or degrade per
-- referrer. The Uncategorized landing pads are load-bearing and un-archivable.
create or replace function public.keel_archive_category(
  p_household_id uuid,
  p_category_ledger_account_id uuid,
  p_reassign_to uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.ledger_accounts%rowtype;
  v_target public.ledger_accounts%rowtype;
  v_moved_overlays int := 0;
  v_moved_budgets int := 0;
  v_moved_rules int := 0;
  v_deactivated_rules int := 0;
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

  select * into v_row from public.ledger_accounts
    where id = p_category_ledger_account_id and household_id = p_household_id
      and is_category = true;
  if not found then
    raise exception 'KEEL_NOT_FOUND: category' using errcode = 'P0006';
  end if;
  if v_row.archived_at is not null then
    return jsonb_build_object('alreadyArchived', true);
  end if;
  if v_row.pfc_key in ('uncategorized_expense', 'uncategorized_income') then
    raise exception 'KEEL_INVALID_COMMAND: this category is the landing pad for synced transactions and cannot be archived'
      using errcode = 'P0009';
  end if;
  if exists (
    select 1 from public.ledger_accounts c
    where c.parent_ledger_account_id = v_row.id and c.archived_at is null
  ) then
    raise exception 'KEEL_INVALID_COMMAND: archive or move its subcategories first' using errcode = 'P0009';
  end if;

  if p_reassign_to is not null then
    select * into v_target from public.ledger_accounts
      where id = p_reassign_to and household_id = p_household_id
        and is_category = true and archived_at is null;
    if not found or v_target.id = v_row.id
       or v_target.entity_id <> v_row.entity_id or v_target.kind <> v_row.kind then
      raise exception 'KEEL_INVALID_COMMAND: invalid reassignment category' using errcode = 'P0009';
    end if;

    update public.transaction_categories tc
       set category_ledger_account_id = v_target.id, updated_at = now()
     where tc.household_id = p_household_id
       and tc.category_ledger_account_id = v_row.id;
    get diagnostics v_moved_overlays = row_count;

    update public.category_rules r
       set category_ledger_account_id = v_target.id, updated_at = now()
     where r.household_id = p_household_id
       and r.category_ledger_account_id = v_row.id;
    get diagnostics v_moved_rules = row_count;

    update public.budgets b
       set category_ledger_account_id = v_target.id, updated_at = now()
     where b.household_id = p_household_id
       and b.category_ledger_account_id = v_row.id
       and b.month >= date_trunc('month', current_date)::date
       and not exists (
         select 1 from public.budgets b2
         where b2.household_id = b.household_id
           and b2.category_ledger_account_id = v_target.id
           and b2.month = b.month
       );
    get diagnostics v_moved_budgets = row_count;
  else
    -- No reassignment: active rules pointing here would keep filing
    -- transactions into a hidden category — deactivate them (audited below).
    update public.category_rules r
       set active = false, updated_at = now()
     where r.household_id = p_household_id
       and r.category_ledger_account_id = v_row.id
       and r.active;
    get diagnostics v_deactivated_rules = row_count;
  end if;
  -- recurring_series.ledger_account_id is the CASH-side ledger account (series
  -- are detected from cash postings), never a category — no handling needed.

  update public.ledger_accounts set archived_at = now() where id = v_row.id;

  insert into public.audit_log (household_id, actor, action, object_type, object_id, before, after)
  values (p_household_id, jsonb_build_object('kind', 'user', 'userId', auth.uid()),
          'categories.archive', 'ledger_account', v_row.id,
          jsonb_build_object('name', v_row.name),
          jsonb_build_object('reassignedTo', p_reassign_to,
                             'movedOverlays', v_moved_overlays,
                             'movedBudgets', v_moved_budgets,
                             'movedRules', v_moved_rules,
                             'deactivatedRules', v_deactivated_rules));

  return jsonb_build_object(
    'archived', true,
    'movedOverlays', v_moved_overlays,
    'movedBudgets', v_moved_budgets,
    'movedRules', v_moved_rules,
    'deactivatedRules', v_deactivated_rules);
end;
$$;

revoke all on function public.keel_archive_category(uuid, uuid, uuid) from public, anon;
grant execute on function public.keel_archive_category(uuid, uuid, uuid) to authenticated;

-- Re-parent (nest under a parent, or null to promote to top level). The
-- trigger enforces the lattice; this proc adds scope checks + audit.
create or replace function public.keel_reparent_category(
  p_household_id uuid,
  p_category_ledger_account_id uuid,
  p_parent_ledger_account_id uuid default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.ledger_accounts%rowtype;
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

  select * into v_row from public.ledger_accounts
    where id = p_category_ledger_account_id and household_id = p_household_id
      and is_category = true and archived_at is null;
  if not found then
    raise exception 'KEEL_NOT_FOUND: category' using errcode = 'P0006';
  end if;
  if p_parent_ledger_account_id is not null and not exists (
    select 1 from public.ledger_accounts
    where id = p_parent_ledger_account_id and household_id = p_household_id
  ) then
    raise exception 'KEEL_NOT_FOUND: parent category' using errcode = 'P0006';
  end if;
  if v_row.parent_ledger_account_id is not distinct from p_parent_ledger_account_id then
    return;
  end if;

  update public.ledger_accounts
     set parent_ledger_account_id = p_parent_ledger_account_id
   where id = v_row.id;

  insert into public.audit_log (household_id, actor, action, object_type, object_id, before, after)
  values (p_household_id, jsonb_build_object('kind', 'user', 'userId', auth.uid()),
          'categories.reparent', 'ledger_account', v_row.id,
          jsonb_build_object('parentLedgerAccountId', v_row.parent_ledger_account_id),
          jsonb_build_object('parentLedgerAccountId', p_parent_ledger_account_id));
end;
$$;

revoke all on function public.keel_reparent_category(uuid, uuid, uuid) from public, anon;
grant execute on function public.keel_reparent_category(uuid, uuid, uuid) to authenticated;

-- Create: gains an optional parent. Drop the 3-arg version first — PostgREST
-- rpc dispatch by named args would otherwise be ambiguous between overloads.
drop function if exists public.keel_create_category(uuid, text, public.ledger_account_kind);

create function public.keel_create_category(
  p_household_id uuid,
  p_name text,
  p_kind public.ledger_account_kind,
  p_parent_ledger_account_id uuid default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text := btrim(coalesce(p_name, ''));
  v_entity uuid;
  v_currency char(3);
  v_parent public.ledger_accounts%rowtype;
  v_id uuid;
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
  if char_length(v_name) < 1 or char_length(v_name) > 80 then
    raise exception 'KEEL_INVALID_COMMAND: category name must be 1-80 characters' using errcode = 'P0009';
  end if;
  if p_kind not in ('expense', 'income') then
    raise exception 'KEEL_INVALID_COMMAND: categories are expense or income' using errcode = 'P0009';
  end if;

  select id into v_entity from public.entities
    where household_id = p_household_id order by created_at limit 1;
  if v_entity is null then
    raise exception 'KEEL_NOT_FOUND: entity' using errcode = 'P0006';
  end if;

  if p_parent_ledger_account_id is not null then
    select * into v_parent from public.ledger_accounts
      where id = p_parent_ledger_account_id and household_id = p_household_id
        and entity_id = v_entity and is_category = true and archived_at is null;
    if not found or v_parent.kind <> p_kind or v_parent.parent_ledger_account_id is not null then
      raise exception 'KEEL_INVALID_COMMAND: invalid parent category' using errcode = 'P0009';
    end if;
  end if;

  if exists (
    select 1 from public.ledger_accounts
    where entity_id = v_entity and is_category = true and archived_at is null
      and lower(name) = lower(v_name)
  ) then
    raise exception 'KEEL_INVALID_COMMAND: a category with this name exists' using errcode = 'P0009';
  end if;

  if p_parent_ledger_account_id is not null then
    v_currency := v_parent.currency;
  else
    select currency into v_currency from public.ledger_accounts
      where entity_id = v_entity and is_category = true and archived_at is null
      order by created_at, id
      limit 1;
  end if;

  insert into public.ledger_accounts
    (household_id, entity_id, name, kind, currency, is_category,
     pfc_key, is_system, parent_ledger_account_id)
  values (p_household_id, v_entity, v_name, p_kind, coalesce(v_currency, 'USD'), true,
          null, false, p_parent_ledger_account_id)
  returning id into v_id;

  insert into public.audit_log (household_id, actor, action, object_type, object_id, after)
  values (p_household_id, jsonb_build_object('kind', 'user', 'userId', auth.uid()),
          'categories.create', 'ledger_account', v_id,
          jsonb_build_object('name', v_name, 'kind', p_kind,
                             'parentLedgerAccountId', p_parent_ledger_account_id));
  return v_id;
end;
$$;

revoke all on function public.keel_create_category(uuid, text, public.ledger_account_kind, uuid)
  from public, anon;
grant execute on function public.keel_create_category(uuid, text, public.ledger_account_kind, uuid)
  to authenticated;

-- ---------------------------------------------------------------------------
-- 11. Export DTO (Law 6 — every real column is exported): ledger_accounts
-- gains pfc_key / is_system / parent_ledger_account_id, and connections
-- gains display_name (added 20260712180000 but never entered the export
-- contract — pgTAP 008 catches the gap). Wrapper chain pattern: rename the
-- current head, patch {tables,ledger_accounts} and {tables,connections}.
-- ---------------------------------------------------------------------------
alter function public.keel_export_household(uuid,timestamptz)
  rename to keel_export_household_pre_subcategories;
revoke all on function public.keel_export_household_pre_subcategories(uuid,timestamptz)
  from public, anon, authenticated, service_role;

create function public.keel_export_household(
  p_household_id uuid,
  p_as_of timestamptz default null
) returns jsonb
language plpgsql
security definer
stable
set search_path = pg_catalog, public
as $$
declare
  v_base jsonb;
  v_ledger_accounts jsonb;
  v_connections jsonb;
begin
  v_base := public.keel_export_household_pre_subcategories(p_household_id, p_as_of);
  select coalesce(jsonb_agg(row.dto order by row.id), '[]'::jsonb)
    into v_ledger_accounts
    from (
      select account.id,
        jsonb_build_object(
          'id', account.id,
          'household_id', account.household_id,
          'entity_id', account.entity_id,
          'name', account.name,
          'kind', account.kind,
          'currency', account.currency::text,
          'is_category', account.is_category,
          'created_at', to_char(account.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
          'archived_at', case when account.archived_at is null then null else to_char(account.archived_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end,
          'pfc_key', account.pfc_key,
          'is_system', account.is_system,
          'parent_ledger_account_id', account.parent_ledger_account_id
        ) as dto
      from public.ledger_accounts account
      where account.household_id = p_household_id
    ) row;
  select coalesce(jsonb_agg(row.dto order by row.id), '[]'::jsonb)
    into v_connections
    from (
      select connection.id,
        jsonb_build_object(
          'id', connection.id,
          'household_id', connection.household_id,
          'provider', connection.provider,
          'external_ref', connection.external_ref,
          'status', connection.status,
          'created_at', to_char(connection.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
          'institution_id', connection.institution_id,
          'consent_expires_at', case when connection.consent_expires_at is null then null else to_char(connection.consent_expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end,
          'last_successful_sync_at', case when connection.last_successful_sync_at is null then null else to_char(connection.last_successful_sync_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end,
          'sync_lease_owner', connection.sync_lease_owner,
          'sync_leased_until', case when connection.sync_leased_until is null then null else to_char(connection.sync_leased_until at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end,
          'sync_desired_generation', connection.sync_desired_generation,
          'sync_committed_generation', connection.sync_committed_generation,
          'next_sync_eligible_at', case when connection.next_sync_eligible_at is null then null else to_char(connection.next_sync_eligible_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end,
          'display_name', connection.display_name
        ) as dto
      from public.connections connection
      where connection.household_id = p_household_id
    ) row;
  v_base := jsonb_set(v_base, '{tables,ledger_accounts}', v_ledger_accounts);
  return jsonb_set(v_base, '{tables,connections}', v_connections);
end;
$$;
revoke all on function public.keel_export_household(uuid,timestamptz)
  from public, anon, authenticated, service_role;
grant create on schema public to keel_export;
alter function public.keel_export_household(uuid,timestamptz) owner to keel_export;
revoke create on schema public from keel_export;
grant execute on function public.keel_export_household(uuid,timestamptz) to service_role;

-- ---------------------------------------------------------------------------
-- 12. SECURITY: functions created with grant-only statements keep PostgreSQL's
-- default PUBLIC EXECUTE — so several SECURITY DEFINER procs were callable by
-- anon/any-authenticated via PostgREST RPC (adversarial-review P0; worst:
-- keel_apply_account_balance could book an opening-balance batch into another
-- household). Fail closed: strip PUBLIC/anon everywhere, strip authenticated
-- from service-only procs, then re-grant exactly the intended callers.
-- ---------------------------------------------------------------------------
-- Service-only (worker paths; user surfaces never call these directly):
revoke all on function public.keel_apply_account_balance(uuid, uuid, bigint, bigint, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.keel_apply_account_balance(uuid, uuid, bigint, bigint, text, timestamptz)
  to service_role;
revoke all on function public.keel_seed_entity_categories(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.keel_seed_entity_categories(uuid, uuid) to service_role;
revoke all on function public.keel_autocategorize_household(uuid)
  from public, anon, authenticated;
grant execute on function public.keel_autocategorize_household(uuid) to service_role;

-- The five overlay/config tables created since the Stage-1A grants pass
-- (transaction_categories, transaction_overrides, category_rules,
-- rule_renames, budgets) kept this stack's DEFAULT ACL for anon and
-- authenticated (TRUNCATE/REFERENCES/TRIGGER) — pgTAP 002 "anon has no
-- grants at all" catches it. Strip anon entirely; authenticated keeps
-- exactly its explicit SELECT.
revoke all on public.transaction_categories, public.transaction_overrides,
  public.category_rules, public.rule_renames, public.budgets
  from anon;
revoke insert, update, delete, truncate, references, trigger
  on public.transaction_categories, public.transaction_overrides,
     public.category_rules, public.rule_renames, public.budgets
  from authenticated;

-- User read/write procs: keep authenticated (they gate membership in-body),
-- but anon must not be able to reach them at all.
revoke all on function public.keel_list_categories(uuid) from public, anon;
grant execute on function public.keel_list_categories(uuid) to authenticated, service_role;
revoke all on function public.keel_latest_balances(uuid) from public, anon;
grant execute on function public.keel_latest_balances(uuid) to authenticated, service_role;
revoke all on function public.keel_categorize_transaction(uuid, uuid, uuid) from public, anon;
grant execute on function public.keel_categorize_transaction(uuid, uuid, uuid)
  to authenticated, service_role;
