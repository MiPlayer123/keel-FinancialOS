-- feat(transfers): when a transfer is CONFIRMED, categorize its legs so they
-- read as money movement everywhere, not just in cash-flow. The inflow leg →
-- "Transfers In", the outflow leg → "Transfers Out" (the categories seeded by
-- 20260719020000 / 20260720140000). Reversible (invariant 5): undo restores the
-- pre-confirm state.
--
-- WHY. A confirmed transfer_link already drops both legs out of cash-flow
-- (keel_cash_flow's confirmed-link exclusion). But the LEG CATEGORIES were left
-- on their Uncategorized landing pad, so the transactions page, category
-- reports, budgets and the ledger still showed a confirmed transfer's legs as
-- "Uncategorized Expense/Income" — inconsistent with the cash-flow treatment and
-- confusing (the user confirmed it's a transfer; it should read as one). This is
-- the two-sided, KEEL-sees-both-legs case the 2026-07-19 scope decision blesses:
-- a real transfer_link exists, so labelling the legs Transfers In/Out is fact,
-- not inference.
--
-- DESIGN (deterministic, Law 1; reversible, invariant 5; audited, Law 2):
--   * A shared helper keel_transfer_categorize_legs(hh, txn_out, txn_in) writes
--     an overlay (source 'transfer_confirm') on each leg: txn_out → Transfers
--     Out, txn_in → Transfers In, resolved on the leg's OWN entity. It ONLY
--     writes a leg that has no existing overlay (respects explicit ownership,
--     Law 9 — a user's deliberate category on a leg is never stomped) and is a
--     single-offset transaction. Each write captures before/after in audit_log.
--   * keel_decide_transfer (confirm branch) and keel_book_transfer_counterparty
--     call it. keel_link_and_confirm_transfer goes through keel_decide_transfer,
--     so it inherits the behavior with no change.
--   * keel_undo_transfer restores priors: it DELETES only the 'transfer_confirm'
--     overlays it wrote (the pre-confirm state for those legs was "no overlay",
--     so deletion is the exact inverse), captured in audit_log. A user overlay
--     is never touched (it was never written by the confirm, so undo leaves it).
--   * One audited backfill categorizes the 60 existing confirmed links' legs.
--   * keel_detect_category_suggestions gains a suppression predicate: never
--     propose a category (incl. the income-side transfers_in PFC suggestion from
--     20260719020000) for a transaction already part of an ACTIVE transfer_link
--     — the link + this leg categorization are authoritative.
--
-- No column/table changes (Law 6 export DTO unaffected — the new overlays are
-- ordinary transaction_categories rows, already exported).

-- ---------------------------------------------------------------------------
-- 1. Shared confirm-time leg categorizer. SECURITY DEFINER (owned by the
-- migration runner; the callers are already definer procs). Scope-checked by the
-- caller (all callers verify household membership/write first). Idempotent: a
-- leg already carrying a 'transfer_confirm' overlay is a no-op.
-- ---------------------------------------------------------------------------
create or replace function public.keel_transfer_categorize_legs(
  p_household_id uuid,
  p_txn_out uuid,
  p_txn_in uuid,
  p_actor jsonb
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_leg record;
  v_cat_id uuid;
  v_prior_cat uuid;
  v_prior_source text;
begin
  -- Iterate the two legs with the target transfer pfc_key for each direction.
  for v_leg in
    select p_txn_out as txn_id, 'transfers_out'::text as want_key
    union all
    select p_txn_in, 'transfers_in'
  loop
    if v_leg.txn_id is null then
      continue;  -- a one-sided/booked link may pass null for a missing leg
    end if;

    -- The leg must be a live, single-offset canonical transaction in this
    -- household. Resolve its offset entity so the target category is on the
    -- SAME entity as the leg.
    with legbatch as (
      select jb.id as batch_id, ct.id as txn_id
        from public.canonical_transactions ct
        join public.journal_batches jb
          on jb.canonical_transaction_id = ct.id and jb.reverses_batch_id is null
         and not exists (
           select 1 from public.journal_revisions rev where rev.original_batch_id = jb.id
         )
       where ct.id = v_leg.txn_id and ct.household_id = p_household_id
         and ct.voided_at is null
    )
    select cat.id into v_cat_id
      from legbatch lb
      join public.journal_postings offp on offp.batch_id = lb.batch_id
      join public.ledger_accounts offcat
        on offcat.id = offp.ledger_account_id and offcat.is_category = true
      join public.ledger_accounts cat
        on cat.entity_id = offcat.entity_id
       and cat.pfc_key = v_leg.want_key
       and cat.is_category = true
       and cat.archived_at is null
      -- Single-offset only: a split leg keeps its splits (never a whole-transfer).
      where (
        select count(*) from public.journal_postings p2
        join public.ledger_accounts l2 on l2.id = p2.ledger_account_id and l2.is_category
        where p2.batch_id = lb.batch_id
      ) = 1
      limit 1;

    if v_cat_id is null then
      continue;  -- no target category on the entity, or a split leg: skip safely
    end if;

    -- Capture the prior overlay (if any). NEVER overwrite an existing overlay
    -- (Law 9 explicit ownership): only fill a leg that has none. This also makes
    -- undo exact — the only overlays this proc creates are the ones it can
    -- cleanly delete on undo.
    select tc.category_ledger_account_id, tc.source
      into v_prior_cat, v_prior_source
      from public.transaction_categories tc
     where tc.canonical_transaction_id = v_leg.txn_id;

    if v_prior_cat is not null then
      continue;  -- respect the existing (user/rule/pfc) overlay; leave it
    end if;

    insert into public.transaction_categories
      (canonical_transaction_id, household_id, category_ledger_account_id, source)
    values (v_leg.txn_id, p_household_id, v_cat_id, 'transfer_confirm');

    insert into public.audit_log
      (household_id, actor, action, object_type, object_id, before, after)
    values (p_household_id, p_actor, 'transfers.categorize_leg', 'canonical_transaction',
            v_leg.txn_id,
            jsonb_build_object('categoryLedgerAccountId', null, 'source', null),
            jsonb_build_object('categoryLedgerAccountId', v_cat_id, 'source', 'transfer_confirm'));
  end loop;
end;
$$;
revoke all on function public.keel_transfer_categorize_legs(uuid, uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.keel_transfer_categorize_legs(uuid, uuid, uuid, jsonb)
  to service_role, keel_api;

-- ---------------------------------------------------------------------------
-- 2. Restore helper (undo). Deletes ONLY the 'transfer_confirm' overlays on the
-- link's legs (the exact inverse of the confirm write — their prior state was
-- "no overlay"). A user/rule/pfc overlay is never deleted (the confirm never
-- wrote it). Audited per leg.
-- ---------------------------------------------------------------------------
create or replace function public.keel_transfer_restore_legs(
  p_household_id uuid,
  p_txn_out uuid,
  p_txn_in uuid,
  p_actor jsonb
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_leg record;
  v_prior_cat uuid;
begin
  for v_leg in
    select p_txn_out as txn_id
    union all
    select p_txn_in
  loop
    if v_leg.txn_id is null then
      continue;
    end if;

    select tc.category_ledger_account_id into v_prior_cat
      from public.transaction_categories tc
     where tc.canonical_transaction_id = v_leg.txn_id
       and tc.household_id = p_household_id
       and tc.source = 'transfer_confirm';
    if v_prior_cat is null then
      continue;  -- nothing this proc wrote; leave any user overlay alone
    end if;

    delete from public.transaction_categories
     where canonical_transaction_id = v_leg.txn_id
       and household_id = p_household_id
       and source = 'transfer_confirm';

    insert into public.audit_log
      (household_id, actor, action, object_type, object_id, before, after)
    values (p_household_id, p_actor, 'transfers.restore_leg', 'canonical_transaction',
            v_leg.txn_id,
            jsonb_build_object('categoryLedgerAccountId', v_prior_cat, 'source', 'transfer_confirm'),
            jsonb_build_object('categoryLedgerAccountId', null, 'source', null));
  end loop;
end;
$$;
revoke all on function public.keel_transfer_restore_legs(uuid, uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.keel_transfer_restore_legs(uuid, uuid, uuid, jsonb)
  to service_role, keel_api;

-- ---------------------------------------------------------------------------
-- 3. keel_decide_transfer: on CONFIRM, categorize the two legs. Full recreate
-- (live body: current) with ONLY the categorize call added in the confirm path.
-- ---------------------------------------------------------------------------
create or replace function public.keel_decide_transfer(p_household_id uuid, p_link_id uuid, p_confirm boolean)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_status public.transfer_link_status;
  v_out uuid;
  v_in uuid;
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

  select status, txn_out, txn_in into v_status, v_out, v_in
    from public.transfer_links
    where id = p_link_id and household_id = p_household_id
    for update;
  if v_status is null then
    raise exception 'KEEL_NOT_FOUND: transfer link' using errcode = 'P0006';
  end if;
  if v_status <> 'suggested' then
    raise exception 'KEEL_INVALID_COMMAND: transfer link already decided' using errcode = 'P0009';
  end if;

  update public.transfer_links
     set status = case when p_confirm then 'confirmed' else 'rejected' end::public.transfer_link_status,
         decided_by = auth.uid(),
         decided_at = now()
   where id = p_link_id;

  insert into public.audit_log (household_id, actor, action, object_type, object_id, before, after)
  values (p_household_id, jsonb_build_object('kind', 'user', 'userId', auth.uid()),
          'transfers.decide', 'transfer_link', p_link_id,
          jsonb_build_object('status', 'suggested'),
          jsonb_build_object('status', case when p_confirm then 'confirmed' else 'rejected' end));

  -- 20260720150000: a confirmed transfer's legs read as money movement
  -- everywhere. Outflow → Transfers Out, inflow → Transfers In (source
  -- 'transfer_confirm'; reversible via keel_undo_transfer).
  if p_confirm then
    perform public.keel_transfer_categorize_legs(
      p_household_id, v_out, v_in,
      jsonb_build_object('kind', 'user', 'userId', auth.uid()::text));
  end if;
end;
$function$;
revoke all on function public.keel_decide_transfer(uuid, uuid, boolean) from public, anon;
grant execute on function public.keel_decide_transfer(uuid, uuid, boolean) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. keel_undo_transfer: restore leg categories BEFORE flipping status. Full
-- recreate (live body: current) with ONLY the restore call added.
-- ---------------------------------------------------------------------------
create or replace function public.keel_undo_transfer(p_household_id uuid, p_link_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_uid uuid := coalesce(
    nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
    nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid;
  v_actor jsonb;
  v_link public.transfer_links%rowtype;
  v_batch public.journal_batches%rowtype;
  v_reversal_id uuid;
  v_command_id uuid := gen_random_uuid();
begin
  perform public.keel_assert_member_write(p_household_id);
  v_uid := (public.keel_actor_from_jwt() ->> 'userId')::uuid;
  v_actor := jsonb_build_object('kind', 'user', 'userId', v_uid::text);

  select * into v_link
    from public.transfer_links
   where id = p_link_id and household_id = p_household_id
   for update;
  if v_link.id is null then
    raise exception 'KEEL_NOT_FOUND: transfer link' using errcode = 'P0006';
  end if;
  if v_link.status = 'rejected' then
    return jsonb_build_object('linkId', p_link_id, 'status', 'rejected',
                              'idempotentReplay', true);
  end if;

  -- 20260720150000: restore the pre-confirm leg categories (delete the
  -- 'transfer_confirm' overlays this link's confirm wrote). Runs before the
  -- status flip so it is atomic with the undo.
  perform public.keel_transfer_restore_legs(p_household_id, v_link.txn_out, v_link.txn_in, v_actor);

  if v_link.booked_txn is not null then
    select jb.* into v_batch
      from public.journal_batches jb
      join public.canonical_transactions ct on ct.id = jb.canonical_transaction_id
     where jb.canonical_transaction_id = v_link.booked_txn
       and jb.reverses_batch_id is null
       and not exists (select 1 from public.journal_revisions rev where rev.original_batch_id = jb.id)
       and ct.voided_at is null
     order by jb.posted_at desc, jb.id desc
     limit 1;

    if v_batch.id is not null then
      insert into public.journal_batches
        (household_id, canonical_transaction_id, description, effective_date,
         reverses_batch_id, command_id)
      values
        (p_household_id, v_link.booked_txn, 'VOID: transfer undone',
         v_batch.effective_date, v_batch.id, v_command_id)
      returning id into v_reversal_id;

      insert into public.journal_postings (batch_id, ledger_account_id, entity_id, amount_minor, currency)
      select v_reversal_id, p.ledger_account_id, p.entity_id, -p.amount_minor, p.currency
        from public.journal_postings p
       where p.batch_id = v_batch.id;

      insert into public.journal_revisions (original_batch_id, reversal_batch_id, reason)
      values (v_batch.id, v_reversal_id, 'transfer undone');

      update public.canonical_transactions
         set status = 'voided', voided_at = now()
       where id = v_link.booked_txn;
    end if;
  end if;

  update public.transfer_links
     set status = 'rejected', decided_by = v_uid, decided_at = now()
   where id = p_link_id;

  insert into public.audit_log (household_id, actor, action, object_type, object_id, before, after)
  values (p_household_id, v_actor, 'transfers.undo', 'transfer_link', p_link_id,
          jsonb_build_object('status', v_link.status, 'bookedTxn', v_link.booked_txn),
          jsonb_build_object('status', 'rejected', 'reversalBatchId', v_reversal_id));

  return jsonb_build_object(
    'linkId', p_link_id,
    'status', 'rejected',
    'reversalBatchId', v_reversal_id,
    'idempotentReplay', false
  );
end;
$function$;
revoke all on function public.keel_undo_transfer(uuid, uuid) from public, anon;
grant execute on function public.keel_undo_transfer(uuid, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. keel_book_transfer_counterparty: categorize the legs of the confirmed link
-- it creates. The booked leg already got a 'user' Transfers overlay in the proc;
-- categorize_legs skips it (existing overlay) and fills the SOURCE leg with
-- Transfers Out/In as appropriate. Full recreate (live body: current) with ONLY
-- the categorize call added just before the result is built.
-- ---------------------------------------------------------------------------
create or replace function public.keel_book_transfer_counterparty(p_household_id uuid, p_source_txn_id uuid, p_counterparty_account_id uuid, p_attempt_key text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_uid uuid := coalesce(
    nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
    nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid;
  v_actor jsonb;
  v_key text;
  v_hash text;
  v_replay jsonb;
  v_command_id uuid := gen_random_uuid();
  v_src record;
  v_cp record;
  v_booked_amount bigint;
  v_cat_id uuid;
  v_txn_id uuid;
  v_batch_id uuid;
  v_link_id uuid;
  v_out uuid;
  v_in uuid;
  v_result jsonb;
begin
  perform public.keel_assert_member_write(p_household_id);
  v_uid := (public.keel_actor_from_jwt() ->> 'userId')::uuid;
  v_actor := jsonb_build_object('kind', 'user', 'userId', v_uid::text);

  if p_attempt_key is null or char_length(btrim(p_attempt_key)) < 1
     or char_length(p_attempt_key) > 100 then
    raise exception 'KEEL_INVALID_COMMAND: attempt key required' using errcode = 'P0009';
  end if;
  v_key := 'transfer.book:' || p_source_txn_id::text || ':' || p_attempt_key;
  v_hash := public.keel_payload_hash(jsonb_build_object(
    'sourceTxnId', p_source_txn_id, 'counterpartyAccountId', p_counterparty_account_id
  ));
  v_replay := public.keel_idempotency_check(p_household_id, v_key, v_hash);
  if v_replay is not null then
    return v_replay;
  end if;

  select ct.id as txn_id, ct.effective_date, ct.description,
         acc.id as account_id, p.amount_minor, p.currency
    into v_src
    from public.canonical_transactions ct
    join public.journal_batches jb
      on jb.canonical_transaction_id = ct.id and jb.reverses_batch_id is null
     and not exists (select 1 from public.journal_revisions rev where rev.original_batch_id = jb.id)
    join public.journal_postings p on p.batch_id = jb.id
    join public.ledger_accounts la on la.id = p.ledger_account_id and la.is_category = false
    join public.accounts acc on acc.ledger_account_id = la.id
   where ct.id = p_source_txn_id and ct.household_id = p_household_id and ct.voided_at is null;
  if v_src.txn_id is null then
    raise exception 'KEEL_NOT_FOUND: source transaction' using errcode = 'P0006';
  end if;

  if exists (
    select 1 from public.transfer_links
     where household_id = p_household_id
       and status in ('suggested', 'confirmed')
       and (txn_out = v_src.txn_id or txn_in = v_src.txn_id)
  ) then
    raise exception 'KEEL_INVALID_COMMAND: this transaction is already part of a transfer'
      using errcode = 'P0009';
  end if;

  select a.id, a.entity_id, a.ledger_account_id, a.name, a.connection_id,
         la.currency, la.is_category, la.archived_at as ledger_archived_at, a.archived_at
    into v_cp
    from public.accounts a
    join public.ledger_accounts la on la.id = a.ledger_account_id
   where a.id = p_counterparty_account_id and a.household_id = p_household_id;
  if v_cp.id is null then
    raise exception 'KEEL_NOT_FOUND: counterparty account' using errcode = 'P0006';
  end if;
  if v_cp.id = v_src.account_id then
    raise exception 'KEEL_INVALID_COMMAND: counterparty must be a different account'
      using errcode = 'P0009';
  end if;
  if v_cp.archived_at is not null or v_cp.is_category or v_cp.ledger_archived_at is not null then
    raise exception 'KEEL_INVALID_COMMAND: counterparty account is not postable'
      using errcode = 'P0009';
  end if;
  if v_cp.connection_id is not null then
    raise exception
      'KEEL_INVALID_COMMAND: cannot book a leg onto a connected account — the bank feed will deliver it; match it instead'
      using errcode = 'P0009';
  end if;
  if v_cp.currency <> v_src.currency then
    raise exception 'KEEL_CURRENCY_MISMATCH: accounts use different currencies'
      using errcode = 'P0010';
  end if;

  if v_src.amount_minor = -9223372036854775808 then
    raise exception 'KEEL_INVALID_MONEY: amount out of range' using errcode = 'P0008';
  end if;

  v_booked_amount := -v_src.amount_minor;

  select la.id into v_cat_id
    from public.ledger_accounts la
   where la.household_id = p_household_id
     and la.entity_id = v_cp.entity_id
     and la.is_category = true
     and la.currency = v_cp.currency
     and la.archived_at is null
     and (la.pfc_key = 'transfers' or lower(la.name) = 'transfers')
   order by (la.pfc_key = 'transfers') desc, la.name
   limit 1;
  if v_cat_id is null then
    select la.id into v_cat_id
      from public.ledger_accounts la
     where la.household_id = p_household_id
       and la.entity_id = v_cp.entity_id
       and la.is_category = true
       and la.currency = v_cp.currency
       and la.archived_at is null
       and la.pfc_key = 'uncategorized_expense'
     limit 1;
  end if;
  if v_cat_id is null then
    raise exception 'KEEL_INVALID_COMMAND: no category available on the counterparty entity to offset the transfer'
      using errcode = 'P0009';
  end if;

  if exists (
    select 1 from public.period_locks l
    where l.household_id = p_household_id
      and (l.entity_id is null or l.entity_id = v_cp.entity_id)
      and l.reopened_at is null
      and v_src.effective_date between l.start_date and l.end_date
  ) then
    raise exception 'KEEL_PERIOD_LOCKED: % falls in a locked period', v_src.effective_date
      using errcode = 'P0003';
  end if;

  insert into public.canonical_transactions
    (household_id, entity_id, account_id, status, source, description,
     effective_date, economic_event_key)
  values
    (p_household_id, v_cp.entity_id, v_cp.id, 'posted', 'manual',
     left('Transfer: ' || coalesce(v_src.description, 'transfer'), 500),
     v_src.effective_date, v_key)
  returning id into v_txn_id;

  insert into public.journal_batches
    (household_id, canonical_transaction_id, description, effective_date, command_id)
  values
    (p_household_id, v_txn_id, left('Transfer: ' || coalesce(v_src.description, 'transfer'), 500),
     v_src.effective_date, v_command_id)
  returning id into v_batch_id;

  perform public.keel_insert_postings(p_household_id, v_batch_id, jsonb_build_array(
    jsonb_build_object('ledger_account_id', v_cp.ledger_account_id,
                       'amount_minor', v_booked_amount::text, 'currency', v_cp.currency),
    jsonb_build_object('ledger_account_id', v_cat_id,
                       'amount_minor', (-v_booked_amount)::text, 'currency', v_cp.currency)
  ));

  insert into public.transaction_categories
    (canonical_transaction_id, household_id, category_ledger_account_id, source)
  values (v_txn_id, p_household_id, v_cat_id, 'user');

  if v_src.amount_minor < 0 then
    v_out := v_src.txn_id; v_in := v_txn_id;
  else
    v_out := v_txn_id; v_in := v_src.txn_id;
  end if;

  insert into public.transfer_links
    (household_id, txn_out, txn_in, status, booked_txn, decided_by, decided_at)
  values
    (p_household_id, v_out, v_in, 'confirmed', v_txn_id, v_uid, now())
  returning id into v_link_id;

  -- 20260720150000: categorize the legs of the confirmed link. The booked leg
  -- already carries its 'user' Transfers overlay (skipped as an existing
  -- overlay); the SOURCE leg gets Transfers Out/In per its sign.
  perform public.keel_transfer_categorize_legs(p_household_id, v_out, v_in, v_actor);

  v_result := jsonb_build_object(
    'commandId', v_command_id,
    'economicEventKey', v_key,
    'idempotentReplay', false,
    'effects', jsonb_build_object(
      'linkId', v_link_id, 'bookedTxnId', v_txn_id, 'batchId', v_batch_id
    ),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  );

  perform public.keel_finish_command(
    v_command_id, 'transfers.book_counterparty', v_key, p_household_id, v_actor,
    v_hash, 'transfers.counterparty_booked', 'transfer_link', v_link_id,
    jsonb_build_object('linkId', v_link_id, 'sourceTxnId', v_src.txn_id,
                       'bookedTxnId', v_txn_id, 'counterpartyAccountId', v_cp.id),
    v_result
  );

  return v_result;
exception
  when unique_violation then
    raise exception
      'KEEL_INVALID_COMMAND: this transaction is already part of a transfer'
      using errcode = 'P0009';
end;
$function$;
-- Re-assert owner + grants exactly (create-or-replace preserves them; belt and
-- suspenders). keel_book_transfer_counterparty is owned by keel_api.
alter function public.keel_book_transfer_counterparty(uuid, uuid, uuid, text) owner to keel_api;
revoke all on function public.keel_book_transfer_counterparty(uuid, uuid, uuid, text) from public, anon;
grant execute on function public.keel_book_transfer_counterparty(uuid, uuid, uuid, text)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. Suppression predicate in keel_detect_category_suggestions: never propose a
-- category for a transaction that is already part of an ACTIVE (suggested /
-- confirmed) transfer_link. The link + its leg categorization are authoritative;
-- a competing suggestion (e.g. the income-side transfers_in PFC proposal from
-- 20260719020000, or any PFC proposal) would be noise. Full recreate (live body:
-- 20260719020000-era, UNCHANGED except the added `targets` predicate — there is
-- NO card-payment tier per the 2026-07-19 scope decision).
-- ---------------------------------------------------------------------------
create or replace function public.keel_detect_category_suggestions(p_household_id uuid)
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_count int;
  v_uid uuid := coalesce(
    nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
    nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid;
begin
  if v_uid is not null and not exists (
    select 1 from public.household_memberships
    where household_id = p_household_id and user_id = v_uid
  ) then
    raise exception 'KEEL_NOT_FOUND' using errcode = 'P0006';
  end if;

  with targets as (
    select ct.id as txn_id, ct.description, offp.entity_id, offp.amount_minor,
           offcat.kind as txn_kind,
           coalesce(tc.category_ledger_account_id, offcat.id) as current_cat
      from public.canonical_transactions ct
      join public.journal_batches jb
        on jb.canonical_transaction_id = ct.id and jb.reverses_batch_id is null
       and not exists (
         select 1 from public.journal_revisions rev where rev.original_batch_id = jb.id
       )
      join public.journal_postings offp on offp.batch_id = jb.id
      join public.ledger_accounts offcat
        on offcat.id = offp.ledger_account_id and offcat.is_category = true
      left join public.transaction_categories tc on tc.canonical_transaction_id = ct.id
      left join public.ledger_accounts cur on cur.id = tc.category_ledger_account_id
      where ct.household_id = p_household_id
        and ct.voided_at is null
        -- Single-offset only: split transactions are categorized by their
        -- splits (20260713100000 §5).
        and (
          select count(*) from public.journal_postings p2
          join public.ledger_accounts l2 on l2.id = p2.ledger_account_id and l2.is_category
          where p2.batch_id = jb.id
        ) = 1
        and (
          (case when tc.canonical_transaction_id is not null
                then cur.pfc_key else offcat.pfc_key end)
            in ('uncategorized_expense', 'uncategorized_income')
          or tc.source = 'plaid_pfc'
        )
        -- 20260720150000: never suggest for a transaction already in an ACTIVE
        -- transfer_link — the link + its leg categorization are authoritative.
        and not exists (
          select 1 from public.transfer_links tl
          where tl.household_id = p_household_id
            and tl.status in ('suggested', 'confirmed')
            and (tl.txn_out = ct.id or tl.txn_in = ct.id)
        )
  ),
  rule_winners as (
    select distinct on (t.txn_id)
           t.txn_id, r.id as rule_id, r.pattern,
           r.category_ledger_account_id as cat_id
      from targets t
      join public.category_rules r
        on r.household_id = p_household_id
       and r.active
       and r.category_ledger_account_id is not null
       and position(lower(r.pattern) in lower(t.description)) > 0
       and (r.amount_min_minor is null or abs(t.amount_minor) >= r.amount_min_minor)
       and (r.amount_max_minor is null or abs(t.amount_minor) <= r.amount_max_minor)
      join public.ledger_accounts rc
        on rc.id = r.category_ledger_account_id
       and rc.is_category = true and rc.archived_at is null
       and rc.entity_id = t.entity_id
       and rc.kind = t.txn_kind
      order by t.txn_id, r.priority, r.created_at, r.id
  ),
  pfc_proposals as (
    select distinct on (t.txn_id)
           t.txn_id, nsr.pfc_primary,
           cat.pfc_key as cat_key, cat.id as cat_id
      from targets t
      join public.transaction_source_links tsl on tsl.canonical_transaction_id = t.txn_id
      join public.normalized_source_records nsr
        on nsr.id = tsl.normalized_source_record_id
       and nsr.pfc_primary is not null
      join public.ledger_accounts cat
        on cat.entity_id = t.entity_id
       and cat.pfc_key = public.keel_pfc_to_category_key(nsr.pfc_primary, t.txn_kind)
       and cat.is_category = true and cat.kind = t.txn_kind and cat.archived_at is null
      where not exists (select 1 from rule_winners w where w.txn_id = t.txn_id)
      order by t.txn_id, nsr.pending asc, nsr.created_at desc, nsr.id
  ),
  proposals as (
    select w.txn_id, w.cat_id, 'rule'::text as source, 'rule_match'::text as reason_code,
           jsonb_build_object('ruleId', w.rule_id, 'pattern', w.pattern,
                              'matchedField', 'description') as evidence
      from rule_winners w
    union all
    select p.txn_id, p.cat_id, 'pfc', 'pfc_mapping',
           jsonb_build_object('pfcPrimary', p.pfc_primary, 'pfcKey', p.cat_key)
      from pfc_proposals p
  )
  insert into public.category_suggestions
    (household_id, canonical_transaction_id, suggested_category_ledger_account_id,
     source, reason_code, evidence)
  select p_household_id, pr.txn_id, pr.cat_id, pr.source, pr.reason_code, pr.evidence
    from proposals pr
    join targets t on t.txn_id = pr.txn_id
    where pr.cat_id <> t.current_cat
    and not exists (
      select 1 from public.category_suggestions cs
      where cs.household_id = p_household_id
        and cs.canonical_transaction_id = pr.txn_id
        and cs.suggested_category_ledger_account_id = pr.cat_id
        and cs.source = pr.source
    )
    order by pr.txn_id, pr.source
    limit 200
  on conflict (household_id, canonical_transaction_id,
               suggested_category_ledger_account_id, source) do nothing;
  get diagnostics v_count = row_count;

  if v_count > 0 then
    insert into public.audit_log (household_id, actor, action, object_type, object_id, after)
    values (p_household_id,
            case when v_uid is null
                 then jsonb_build_object('kind', 'system', 'source', 'categorization_detector')
                 else jsonb_build_object('kind', 'user', 'userId', v_uid) end,
            'categorization.detect', 'household', p_household_id,
            jsonb_build_object('suggested', v_count));
  end if;
  return v_count;
end;
$function$;
alter function public.keel_detect_category_suggestions(uuid) owner to keel_api;
revoke all on function public.keel_detect_category_suggestions(uuid) from public, anon;
grant execute on function public.keel_detect_category_suggestions(uuid)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7. One audited backfill of the existing confirmed links' legs. Runs as a
-- system actor. Idempotent (keel_transfer_categorize_legs skips legs that
-- already carry any overlay). Fixture households (a/b) are included — their legs
-- are transaction-local in pgTAP and never present at migration time, so this is
-- a no-op there; live confirmed links get categorized.
-- ---------------------------------------------------------------------------
do $$
declare r record;
begin
  for r in
    select id, household_id, txn_out, txn_in
      from public.transfer_links
     where status = 'confirmed'
  loop
    perform public.keel_transfer_categorize_legs(
      r.household_id, r.txn_out, r.txn_in,
      jsonb_build_object('kind', 'system', 'source', 'transfer_confirm_backfill',
                         'linkId', r.id::text));
  end loop;
end $$;
