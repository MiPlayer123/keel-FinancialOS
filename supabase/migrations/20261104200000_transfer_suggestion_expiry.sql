-- Transfer suggestions whose transaction is voided are rejected by KEEL.
--
-- keel_list_transfers shows a suggested pair only while both transactions are
-- live, so a suggestion whose side was later voided (sync removal of a pending
-- charge, a manual void, a reconnect dedupe) vanished from review and lingered
-- forever: 31 such rows in one household on 2026-11-04 (NOTES.md). They never
-- moved money; they were just unreachable clutter.
--
-- Now any transaction that becomes voided rejects its open suggestions in the
-- same statement, with an audit row saying KEEL did it and why (Law 2). The
-- decision has no person behind it, so a rejected row may carry no decided_by.
-- Confirmed pairings are untouched: undoing those stays a user action.
-- Re-runnable.

-- 1. A rejection by KEEL itself has no decided_by.
do $$
declare
  v_name text;
begin
  for v_name in
    select conname from pg_constraint
     where conrelid = 'public.transfer_links'::regclass
       and contype = 'c'
       and conname <> 'transfer_links_decision_shape'
       and pg_get_constraintdef(oid) like '%decided_by%'
  loop
    execute format('alter table public.transfer_links drop constraint %I', v_name);
  end loop;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.transfer_links'::regclass and conname = 'transfer_links_decision_shape'
  ) then
    alter table public.transfer_links add constraint transfer_links_decision_shape check (
      (status = 'suggested' and decided_by is null and decided_at is null)
      or (status = 'confirmed' and decided_by is not null and decided_at is not null)
      or (status = 'rejected' and decided_at is not null)
    );
  end if;
end $$;

-- 2. Voiding a transaction rejects the suggestions that involve it.
create or replace function public.keel_expire_transfer_suggestions_on_void()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  with expired as (
    update public.transfer_links tl
       set status = 'rejected', decided_by = null, decided_at = now()
     where tl.household_id = new.household_id
       and tl.status = 'suggested'
       and (tl.txn_out = new.id or tl.txn_in = new.id)
    returning tl.id
  )
  insert into public.audit_log (household_id, actor, action, object_type, object_id, before, after)
  select new.household_id,
         jsonb_build_object('kind', 'system', 'processName', 'transfer-suggestion-expiry'),
         'transfers.suggestion_expired', 'transfer_link', expired.id,
         jsonb_build_object('status', 'suggested'),
         jsonb_build_object('status', 'rejected', 'reason', 'transaction_voided', 'transactionId', new.id)
    from expired;
  return null;
end;
$$;
revoke all on function public.keel_expire_transfer_suggestions_on_void() from public, anon, authenticated;

drop trigger if exists keel_expire_transfer_suggestions_on_void on public.canonical_transactions;
create trigger keel_expire_transfer_suggestions_on_void
  after update of status on public.canonical_transactions
  for each row
  when (new.status = 'voided' and old.status is distinct from 'voided')
  execute function public.keel_expire_transfer_suggestions_on_void();

-- 3. Backfill: suggestions already orphaned by an earlier void.
with expired as (
  update public.transfer_links tl
     set status = 'rejected', decided_by = null, decided_at = now()
   where tl.status = 'suggested'
     and exists (
       select 1 from public.canonical_transactions ct
        where ct.id in (tl.txn_out, tl.txn_in) and ct.status = 'voided'
     )
  returning tl.id, tl.household_id
)
insert into public.audit_log (household_id, actor, action, object_type, object_id, before, after)
select expired.household_id,
       jsonb_build_object('kind', 'system', 'processName', 'transfer-suggestion-expiry'),
       'transfers.suggestion_expired', 'transfer_link', expired.id,
       jsonb_build_object('status', 'suggested'),
       jsonb_build_object('status', 'rejected', 'reason', 'transaction_voided', 'backfill', true)
  from expired;
