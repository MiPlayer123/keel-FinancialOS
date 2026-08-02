-- One-off cleanup (user-authorized 2026-07-19): archive the SECOND stale,
-- already-disconnected duplicate Fidelity Item (conn a08bc4aa) and its two
-- accounts — the sibling of 8ab78400 that 20260719080000 already handled.
--
-- Context: three Fidelity connections point at the same real-world accounts;
-- only 7e9bdccf (the good reconnect) should count toward net worth. 8ab78400
-- is already archived. a08bc4aa is disconnected but its accounts were never
-- archived, so the balance read models (which summed postings without checking
-- accounts.archived_at) triple-counted Fidelity. This block soft-archives
-- a08bc4aa exactly the way 8ab78400 was archived: id-scoped, guarded, audited,
-- NEVER a hard DELETE (its 56+ immutable raw_provider_events must survive —
-- Law 9 source preservation; CLAUDE.md soft-delete directive).
--
-- Guard nuance vs. 8ab78400: a08bc4aa's Cash Management account (855af8e8)
-- carries 35 live canonical transactions, but they net to 0 in the ledger —
-- its entire ledger contribution is only its one-time opening-balance anchor
-- (4824). So the "zero live transactions" guard used for 8ab78400 would wrongly
-- refuse here. Instead we assert the economically meaningful invariant: the sum
-- of this connection's per-account ledger balances must equal the sum of its
-- accounts' opening-balance anchors (i.e. every synced posting nets out and the
-- only remaining value is the anchor). If real, un-netted economic value were
-- present, this would differ and the block raises rather than hiding money.
--
-- NOTE (future dedupe): archiving here removes the CMA-transaction reconnect
-- dedupe match list for 7e9bdccf (which requires the OLD account un-archived).
-- That is intentionally fine: the CMA txns net to 0 and 7e9bdccf re-pulls its
-- own history. Any later per-txn dedup against 7e9bdccf is a separate step.

do $$
declare
  v_conn        uuid := 'a08bc4aa-c7d6-4ed2-8ce2-118878531e12';
  v_hh          uuid := 'a1ba3759-b7a7-4880-93e2-49eb6f91636c';
  v_ledger_sum  bigint;
  v_anchor_sum  bigint;
  v_acct        record;
begin
  -- Only proceed if the connection exists, is disconnected, and is unarchived.
  if not exists (
    select 1 from public.connections
     where id = v_conn and household_id = v_hh
       and status = 'disconnected' and archived_at is null
  ) then
    raise notice 'connection % not in expected (disconnected, unarchived) state; skipping', v_conn;
    return;
  end if;

  -- Sum of this connection's per-account ledger balances (Σ postings on each
  -- account's ledger account).
  select coalesce(sum(p.amount_minor), 0) into v_ledger_sum
    from public.accounts a
    join public.journal_postings p on p.ledger_account_id = a.ledger_account_id
   where a.connection_id = v_conn;

  -- Sum of this connection's opening-balance anchors: postings on these
  -- accounts' ledger accounts that belong to a null-canonical, non-reversal
  -- batch (the opening-balance marker booked once by keel_apply_account_balance).
  select coalesce(sum(p.amount_minor), 0) into v_anchor_sum
    from public.accounts a
    join public.journal_postings p on p.ledger_account_id = a.ledger_account_id
    join public.journal_batches b on b.id = p.batch_id
   where a.connection_id = v_conn
     and b.canonical_transaction_id is null
     and b.reverses_batch_id is null;

  -- If the ledger balance is anything other than the opening anchors, real
  -- un-netted economic value is present — refuse rather than hide it.
  if v_ledger_sum <> v_anchor_sum then
    raise exception 'refusing to archive connection % — ledger balance % <> opening anchors % (un-netted economic value present)',
      v_conn, v_ledger_sum, v_anchor_sum;
  end if;

  -- Archive the accounts (soft delete) + audit each.
  for v_acct in
    select id from public.accounts where connection_id = v_conn and archived_at is null
  loop
    update public.accounts set archived_at = now() where id = v_acct.id;
    insert into public.audit_log (household_id, actor, action, object_type, object_id, before, after)
    values (v_hh, jsonb_build_object('kind','admin','reason','user-authorized duplicate Fidelity cleanup (a08bc4aa)'),
            'account.archived', 'account', v_acct.id,
            jsonb_build_object('archived_at', null),
            jsonb_build_object('archived_at', 'now()'));
  end loop;

  -- Archive the connection itself + audit.
  update public.connections set archived_at = now() where id = v_conn;
  insert into public.audit_log (household_id, actor, action, object_type, object_id, before, after)
  values (v_hh, jsonb_build_object('kind','admin','reason','user-authorized duplicate Fidelity cleanup (a08bc4aa)'),
          'connection.archived', 'connection', v_conn,
          jsonb_build_object('status','disconnected','archived_at', null),
          jsonb_build_object('status','disconnected','archived_at','now()'));

  raise notice 'archived duplicate Fidelity connection % and its accounts (ledger balance % = anchors %)',
    v_conn, v_ledger_sum, v_anchor_sum;
end $$;
