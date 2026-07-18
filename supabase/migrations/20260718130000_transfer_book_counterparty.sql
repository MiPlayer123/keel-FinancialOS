-- FEEDBACK.md F-012 — "Transfer" category should book the counterparty leg.
--
-- Picking category "Transfers" today is a ONE-SIDED tag: the transaction is
-- excluded from spending analytics but NOT from keel_cash_flow (which only
-- excludes CONFIRMED transfer_links pairs), and no opposite cash leg is ever
-- booked on the other account. So a $2,000 sweep from Checking to a manual
-- 401k still counts as $2,000 of "expense" in cash flow, and the 401k's
-- balance never moved.
--
-- This migration adds the missing server side of the counterparty flow the
-- UI (txn detail sidebar, F-010) drives:
--
--   1) MATCH path — when an opposite transaction already exists on the chosen
--      counterparty account, link the two AND confirm the pairing in one
--      command (keel_link_and_confirm_transfer). Cash-flow exclusion then
--      works through the existing confirmed-links mechanism, unchanged.
--
--   2) BOOK path — when NO opposite transaction exists (the common case for a
--      manual/unconnected account: a cash jar, a private loan, a 401k), post
--      the balanced opposite CASH leg on the counterparty account, create its
--      canonical transaction, and insert a CONFIRMED transfer_links row
--      pairing source↔booked — atomically, idempotent, replay-safe
--      (keel_book_transfer_counterparty). Mirrors journal.post_batch /
--      manual_create posting semantics (two cash postings summing to zero,
--      BIGINT minor units, Law 3/4).
--
--   3) UNDO path — reverse a booked transfer (keel_undo_transfer): void the
--      synthesized counterparty leg with a compensating reversal batch (never
--      a DELETE — Law 2, corrections are reversals) and mark the link
--      'rejected'. A match-linked or detector pair has no synthesized leg, so
--      undo there is a plain reject (no reversal) — the same proc handles both
--      by branching on transfer_links.booked_txn.
--
-- Nothing here lets an LLM do arithmetic (Law 1) — the amount is the source
-- transaction's own posted cash amount, negated. Every write hits audit_log
-- (Law 2). Postings sum to zero per currency (Law 3, re-verified by the
-- deferred trigger). Money is BIGINT minor units (Law 4).

-- ---------------------------------------------------------------------------
-- 0. Schema: mark which leg (if any) KEEL synthesized for a link, so undo
--    knows whether to reverse a booked leg or just reject the pairing.
--    Nullable + additive: existing detector/manual-link rows keep booked_txn
--    NULL (both their legs are real bank transactions), and the export
--    systems below gain the one new column.
-- ---------------------------------------------------------------------------
alter table public.transfer_links
  add column if not exists booked_txn uuid references public.canonical_transactions (id);

comment on column public.transfer_links.booked_txn is
  'The canonical_transactions.id of the counterparty leg KEEL SYNTHESIZED for '
  'this pairing (keel_book_transfer_counterparty). NULL for detector/manual '
  'links whose two legs are both real bank transactions. Undo reverses this '
  'leg when set.';

-- ---------------------------------------------------------------------------
-- 1. keel_link_and_confirm_transfer — MATCH path. The user picked "Transfers"
--    and KEEL (or the user) found an existing opposite transaction on the
--    counterparty account. Create the link AND confirm it in one round-trip,
--    reusing keel_link_transfer's exact resolution/orientation/guards and
--    keel_decide_transfer's confirm semantics, but atomically so cash-flow
--    exclusion takes effect immediately with no intermediate 'suggested' state
--    the user would otherwise have to approve on Review.
-- ---------------------------------------------------------------------------
create or replace function public.keel_link_and_confirm_transfer(
  p_household_id uuid,
  p_txn_a uuid,
  p_txn_b uuid
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_link_id uuid;
begin
  if v_uid is null then
    raise exception 'KEEL_NOT_AUTHENTICATED' using errcode = 'P0004';
  end if;
  if not exists (
    select 1 from public.household_memberships
    where household_id = p_household_id and user_id = v_uid
  ) then
    raise exception 'KEEL_NOT_FOUND' using errcode = 'P0006';
  end if;

  -- Reuse the fully-guarded suggested-link creation (self-link, same-account,
  -- currency, one-out/one-in, already-linked, rejected-pair — all enforced
  -- there). Runs in THIS transaction, so the confirm below is atomic with it.
  v_link_id := public.keel_link_transfer(p_household_id, p_txn_a, p_txn_b);

  -- Immediately confirm (the whole point of the match path — the user already
  -- said "these are a transfer" by picking the counterparty). keel_decide_
  -- transfer re-checks membership and the suggested→confirmed transition and
  -- writes its own audit row.
  perform public.keel_decide_transfer(p_household_id, v_link_id, true);

  return v_link_id;
end;
$$;

revoke all on function public.keel_link_and_confirm_transfer(uuid, uuid, uuid) from public, anon;
grant execute on function public.keel_link_and_confirm_transfer(uuid, uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. keel_book_transfer_counterparty — BOOK path. No opposite transaction
--    exists, so KEEL posts one on the counterparty account. Atomic:
--      a) posts the balanced opposite cash leg (two postings summing to zero:
--         the counterparty account's cash side + a category offset) — mirrors
--         keel_cmd_manual_transaction / journal.post_batch posting semantics,
--      b) creates a canonical_transaction for that leg (source='manual'),
--      c) inserts a CONFIRMED transfer_links row pairing source↔booked with
--         booked_txn set to the synthesized leg,
--      d) writes audit + a command_executions idempotency row.
--
--    Idempotent economic_event_key derived from the SOURCE transaction id
--    (transfer.book:<source_txn_id>): a retry after a timeout replays to the
--    SAME booked leg + link instead of posting a second phantom transaction
--    (Law 9 idempotent economics). Fails CLOSED on a null JWT sub (mirrors
--    keel_list_holdings' auth shape). No LLM arithmetic: the booked amount is
--    exactly the source leg's own posted cash amount, negated.
--
--    Offset category: the transfer needs a second posting to balance. We use
--    the counterparty account's entity's system "Transfers" category
--    (is_category, kind matched to the leg's sign). This keeps the booked leg
--    itself out of spending totals BEFORE the pair is even considered
--    (Transfers is analytics-excluded), and the CONFIRMED link then excludes
--    BOTH legs from cash flow through the existing mechanism.
-- ---------------------------------------------------------------------------
create or replace function public.keel_book_transfer_counterparty(
  p_household_id uuid,
  p_source_txn_id uuid,
  p_counterparty_account_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
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
  if v_uid is null then
    raise exception 'KEEL_NOT_AUTHENTICATED' using errcode = 'P0004';
  end if;
  if not exists (
    select 1 from public.household_memberships
    where household_id = p_household_id and user_id = v_uid
  ) then
    raise exception 'KEEL_NOT_FOUND' using errcode = 'P0006';
  end if;
  v_actor := jsonb_build_object('kind', 'user', 'userId', v_uid::text);

  -- Idempotency: key off the SOURCE transaction so a replayed click can't
  -- book a second phantom leg. Payload hash covers the counterparty account
  -- too, so re-invoking with a DIFFERENT counterparty is a typed conflict
  -- rather than a silent no-op.
  v_key := 'transfer.book:' || p_source_txn_id::text;
  v_hash := public.keel_payload_hash(jsonb_build_object(
    'sourceTxnId', p_source_txn_id, 'counterpartyAccountId', p_counterparty_account_id
  ));
  v_replay := public.keel_idempotency_check(p_household_id, v_key, v_hash);
  if v_replay is not null then
    return v_replay;
  end if;

  -- Resolve the source transaction's LIVE cash posting (same shape as
  -- keel_link_transfer): the non-category posting on its live batch.
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

  -- The source transaction must not already be part of an active transfer.
  if exists (
    select 1 from public.transfer_links
     where household_id = p_household_id
       and status in ('suggested', 'confirmed')
       and (txn_out = v_src.txn_id or txn_in = v_src.txn_id)
  ) then
    raise exception 'KEEL_INVALID_COMMAND: this transaction is already part of a transfer'
      using errcode = 'P0009';
  end if;

  -- Resolve the counterparty account (must be postable, same household, same
  -- currency — a transfer is a same-currency move).
  select a.id, a.entity_id, a.ledger_account_id, a.name,
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
  if v_cp.currency <> v_src.currency then
    raise exception 'KEEL_CURRENCY_MISMATCH: accounts use different currencies'
      using errcode = 'P0010';
  end if;

  -- The booked leg is the exact negation of the source cash amount (Law 1: no
  -- arithmetic beyond a sign flip; Law 4: BIGINT).
  v_booked_amount := -v_src.amount_minor;

  -- Category offset that balances the booked cash posting. Σ per currency = 0
  -- is purely amount-based (keel_insert_postings enforces no kind/sign
  -- correlation), so the offset's KIND is irrelevant to the invariant; and
  -- because the CONFIRMED link below excludes BOTH legs from cash flow, the
  -- offset never affects income/expense totals either way. We therefore reuse
  -- the entity's single seeded system "Transfers" category (pfc_key
  -- 'transfers', expense-kind — the seed defines exactly one, no income
  -- counterpart; see 20260713090000_subcategories.sql) for both directions.
  -- It is analytics-excluded on its own, and every seeded entity has it.
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
    -- Fall back to Uncategorized Expense so a partially-seeded or renamed
    -- taxonomy never blocks booking the leg; still analytics-neutral once the
    -- link is confirmed. A hard error here would strand manual accounts.
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

  -- a) Canonical transaction for the booked leg.
  insert into public.canonical_transactions
    (household_id, entity_id, account_id, status, source, description,
     effective_date, economic_event_key)
  values
    (p_household_id, v_cp.entity_id, v_cp.id, 'posted', 'manual',
     left('Transfer: ' || coalesce(v_src.description, 'transfer'), 500),
     v_src.effective_date, v_key)
  returning id into v_txn_id;

  -- b) Balanced batch: cash leg on the counterparty account + Transfers offset.
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

  -- Pin the booked leg's category as a USER overlay so no rule re-labels it.
  insert into public.transaction_categories
    (canonical_transaction_id, household_id, category_ledger_account_id, source)
  values (v_txn_id, p_household_id, v_cat_id, 'user');

  -- c) Confirmed link, oriented by sign the same way the detector does
  --    (negative = txn_out, positive = txn_in).
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

  v_result := jsonb_build_object(
    'commandId', v_command_id,
    'economicEventKey', v_key,
    'idempotentReplay', false,
    'effects', jsonb_build_object(
      'linkId', v_link_id, 'bookedTxnId', v_txn_id, 'batchId', v_batch_id
    ),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  );

  -- d) Audit + domain event + idempotency record (single call, Law 2/9).
  perform public.keel_finish_command(
    v_command_id, 'transfers.book_counterparty', v_key, p_household_id, v_actor,
    v_hash, 'transfers.counterparty_booked', 'transfer_link', v_link_id,
    jsonb_build_object('linkId', v_link_id, 'sourceTxnId', v_src.txn_id,
                       'bookedTxnId', v_txn_id, 'counterpartyAccountId', v_cp.id),
    v_result
  );

  return v_result;
end;
$$;

-- keel_finish_command / keel_insert_postings / keel_idempotency_check are
-- keel_api-owned; this proc calls them, so it must be keel_api-owned too
-- (SECURITY DEFINER runs as the owner; a definer owned by `authenticated`
-- couldn't touch the canonical tables). Same ownership ritual as
-- keel_cmd_manual_transaction (20260713100000).
grant create on schema public to keel_api;
alter function public.keel_book_transfer_counterparty(uuid, uuid, uuid) owner to keel_api;
revoke create on schema public from keel_api;
revoke all on function public.keel_book_transfer_counterparty(uuid, uuid, uuid) from public, anon;
grant execute on function public.keel_book_transfer_counterparty(uuid, uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. keel_undo_transfer — reverse a confirmed transfer from the txn detail.
--    Booked links (booked_txn set): void the synthesized leg with a
--    compensating reversal batch (Law 2 — never a DELETE) AND mark the link
--    'rejected' so cash-flow exclusion stops. Match/detector links
--    (booked_txn null): the two legs are real bank transactions we must NOT
--    reverse — just reject the pairing (undo = unlink), re-including both
--    legs in cash flow. Idempotent on an already-rejected link.
-- ---------------------------------------------------------------------------
create or replace function public.keel_undo_transfer(
  p_household_id uuid,
  p_link_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_actor jsonb;
  v_link public.transfer_links%rowtype;
  v_batch public.journal_batches%rowtype;
  v_reversal_id uuid;
  v_command_id uuid := gen_random_uuid();
begin
  if v_uid is null then
    raise exception 'KEEL_NOT_AUTHENTICATED' using errcode = 'P0004';
  end if;
  if not exists (
    select 1 from public.household_memberships
    where household_id = p_household_id and user_id = v_uid
  ) then
    raise exception 'KEEL_NOT_FOUND' using errcode = 'P0006';
  end if;
  v_actor := jsonb_build_object('kind', 'user', 'userId', v_uid::text);

  -- FOR UPDATE: serialize concurrent undos so a booked leg can't be reversed
  -- twice (mirrors keel_cmd_manual_void's race guard).
  select * into v_link
    from public.transfer_links
   where id = p_link_id and household_id = p_household_id
   for update;
  if v_link.id is null then
    raise exception 'KEEL_NOT_FOUND: transfer link' using errcode = 'P0006';
  end if;
  if v_link.status = 'rejected' then
    -- Already undone: idempotent no-op (a retry after a timeout lands here).
    return jsonb_build_object('linkId', p_link_id, 'status', 'rejected',
                              'idempotentReplay', true);
  end if;

  -- Booked leg (if any): reverse it. Void the canonical transaction with a
  -- compensating reversal batch, exactly like keel_cmd_manual_void.
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
$$;

grant create on schema public to keel_api;
alter function public.keel_undo_transfer(uuid, uuid) owner to keel_api;
revoke create on schema public from keel_api;
revoke all on function public.keel_undo_transfer(uuid, uuid) from public, anon;
grant execute on function public.keel_undo_transfer(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Rich list: surface the transfer LINK ID + whether the counterparty leg
--    was booked by KEEL, so the txn detail sidebar can offer "Undo transfer"
--    and know whether undo reverses a leg or just unlinks. Full recreate of
--    the counterparty-aware body (20260713220000) with two added fields; all
--    existing columns untouched.
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
        'tags', tgs.tags,
        'transferStatus', tl.status,
        -- Link id + booked flag drive the sidebar's Undo affordance (F-012).
        'transferLinkId', tl.id,
        'transferBooked', tl.booked_txn is not null,
        'counterpartyAccountId', case when tl.status = 'confirmed' then cp.account_id end,
        'counterpartyAccountName', case when tl.status = 'confirmed' then cp.account_name end,
        'counterpartyTransactionId', case when tl.status = 'confirmed' then cp.txn_id end
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
-- 5. Export systems: the new transfer_links.booked_txn column must appear in
--    the SQL export DTO so full export stays complete (Law 6). The original
--    transfer_links DTO is inlined in keel_export_household's base
--    (20260711180000) and omits booked_txn. Rather than recreate that whole
--    function, follow the established WRAPPER CHAIN pattern
--    (20260713010000_transaction_overrides §): rename the current export
--    function aside, then define a new keel_export_household that calls it and
--    OVERRIDES the transfer_links key (jsonb `||` overwrites) with a DTO that
--    adds booked_txn. The packages/exports manifest + pgTAP allowlist
--    (008_export.sql) are updated in this same slice's non-migration files.
-- ---------------------------------------------------------------------------
alter function public.keel_export_household(uuid, timestamptz)
  rename to keel_export_household_pre_transfer_booked;
revoke all on function public.keel_export_household_pre_transfer_booked(uuid, timestamptz)
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
  v_links jsonb;
begin
  v_base := public.keel_export_household_pre_transfer_booked(p_household_id, p_as_of);
  select coalesce(jsonb_agg(dto order by id), '[]'::jsonb) into v_links
    from (
      select link.id,
        jsonb_build_object(
          'id', link.id,
          'household_id', link.household_id,
          'txn_out', link.txn_out,
          'txn_in', link.txn_in,
          'status', link.status,
          'booked_txn', link.booked_txn,
          'decided_by', link.decided_by,
          'decided_at', case when link.decided_at is null then null else to_char(link.decided_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end,
          'created_at', to_char(link.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
        ) as dto
      from public.transfer_links link
      join public.canonical_transactions outgoing
        on outgoing.id = link.txn_out and outgoing.household_id = link.household_id
      join public.canonical_transactions incoming
        on incoming.id = link.txn_in and incoming.household_id = link.household_id
      where link.household_id = p_household_id
    ) t;
  return jsonb_set(v_base, '{tables}',
    (v_base->'tables') || jsonb_build_object('transfer_links', v_links));
end;
$$;
revoke all on function public.keel_export_household(uuid, timestamptz)
  from public, anon, authenticated, service_role;
grant create on schema public to keel_export;
alter function public.keel_export_household(uuid, timestamptz) owner to keel_export;
revoke create on schema public from keel_export;
grant execute on function public.keel_export_household(uuid, timestamptz) to service_role;
