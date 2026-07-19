-- Soft-delete for connections (Stage 1 / connection lifecycle; CLAUDE.md
-- "prefer soft delete over hard delete", Law 9 source preservation).
--
-- Context: a disconnect+relink of the same real-world institution leaves the
-- OLD Plaid Item as a `status='disconnected'` connection row that still shows
-- on the Connections page forever. Its encrypted credentials are already
-- destroyed at disconnect (keel_disconnect_complete, after Plaid /item/remove),
-- but the row itself, its accounts, and — critically — its immutable
-- raw_provider_events (source-of-truth events, Law 9) remain. A hard DELETE
-- would violate source preservation and repeat the exact incident that
-- orphaned live Plaid Items before. So "delete this dead/duplicate connection"
-- must be a SOFT delete: mark it archived, hide it from the UI, keep the
-- immutable source rows intact and recoverable.
--
-- This migration adds the generic `connections.archived_at` marker. The web
-- Connections list (fetchConnections) filters `archived_at is null`; the
-- reconnect-match reader already filters on `accounts.archived_at`, so
-- archiving the accounts alongside removes the stale "replace previously
-- disconnected account?" banner too.

alter table public.connections
  add column if not exists archived_at timestamptz;

comment on column public.connections.archived_at is
  'Soft-delete marker. When set, the connection is hidden from the UI but its '
  'rows (including immutable raw_provider_events) are preserved (Law 9). Only '
  'a disconnected connection should be archived.';

-- ---------------------------------------------------------------------------
-- One-off cleanup (user-authorized 2026-07-19): archive the duplicate,
-- already-disconnected Fidelity Item (conn 8ab78400) and its two EMPTY
-- accounts. Guarded so it can only ever touch a disconnected connection whose
-- accounts carry zero live (non-voided) canonical transactions — if that ever
-- stops being true this block silently no-ops rather than hiding real data.
-- ---------------------------------------------------------------------------
do $$
declare
  v_conn   uuid := '8ab78400-483d-46ee-a7bf-3030315eca7c';
  v_hh     uuid := 'a1ba3759-b7a7-4880-93e2-49eb6f91636c';
  v_livetx int;
  v_acct   record;
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

  -- Safety: refuse if any of its accounts hold live transactions.
  select count(*) into v_livetx
    from public.canonical_transactions ct
    join public.journal_batches jb
      on jb.canonical_transaction_id = ct.id and jb.reverses_batch_id is null
    join public.journal_postings p on p.batch_id = jb.id
    join public.accounts a on a.ledger_account_id = p.ledger_account_id
   where a.connection_id = v_conn and ct.voided_at is null;
  if v_livetx > 0 then
    raise exception 'refusing to archive connection % — % live transactions present', v_conn, v_livetx;
  end if;

  -- Archive the accounts (soft delete) + audit each.
  for v_acct in
    select id from public.accounts where connection_id = v_conn and archived_at is null
  loop
    update public.accounts set archived_at = now() where id = v_acct.id;
    insert into public.audit_log (household_id, actor, action, object_type, object_id, before, after)
    values (v_hh, jsonb_build_object('kind','admin','reason','user-authorized duplicate Fidelity cleanup'),
            'account.archived', 'account', v_acct.id,
            jsonb_build_object('archived_at', null),
            jsonb_build_object('archived_at', 'now()'));
  end loop;

  -- Archive the connection itself + audit.
  update public.connections set archived_at = now() where id = v_conn;
  insert into public.audit_log (household_id, actor, action, object_type, object_id, before, after)
  values (v_hh, jsonb_build_object('kind','admin','reason','user-authorized duplicate Fidelity cleanup'),
          'connection.archived', 'connection', v_conn,
          jsonb_build_object('status','disconnected','archived_at', null),
          jsonb_build_object('status','disconnected','archived_at','now()'));

  raise notice 'archived duplicate Fidelity connection % and its empty accounts', v_conn;
end $$;
