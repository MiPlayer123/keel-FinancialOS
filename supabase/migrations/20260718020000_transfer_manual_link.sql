-- GAP (docs/harness/plans/entities-investments-transfers.md, TRANSFER-1):
-- keel_detect_transfers only pairs EXACT opposite amounts within 3 days, so
-- a transfer with a wire fee, a rounding difference, or a longer float
-- window (e.g. $500.00 out, $498.50 in five days later) is never suggested
-- and there was no way to tell KEEL "these two are the same transfer"
-- yourself. This adds that manual path, without weakening detection or
-- bypassing the suggest->approve loop everything else in this feature uses
-- (Law 2): it inserts a transfer_links row with status = 'suggested', same
-- as keel_detect_transfers -- the user still confirms or rejects it on the
-- Review page like any other suggestion.
--
-- Follows keel_decide_transfer's own auth shape (raw auth.uid() + household
-- membership check), not keel_assert_member_write -- consistency within
-- this feature's existing procs matters more than matching an unrelated
-- subsystem's convention.
create or replace function public.keel_link_transfer(
  p_household_id uuid,
  p_txn_a uuid,
  p_txn_b uuid
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_a record;
  v_b record;
  v_out uuid;
  v_in uuid;
  v_link_id uuid;
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

  if p_txn_a = p_txn_b then
    raise exception 'KEEL_INVALID_COMMAND: cannot link a transaction to itself' using errcode = 'P0009';
  end if;

  -- Resolve each side's live cash posting -- same shape as
  -- keel_detect_transfers' `cash` CTE (transfers.sql): the non-category
  -- posting on the transaction's live batch, never a superseded sync
  -- revision.
  select ct.id as txn_id, acc.id as account_id, p.amount_minor, p.currency
    into v_a
    from public.canonical_transactions ct
    join public.journal_batches jb
      on jb.canonical_transaction_id = ct.id and jb.reverses_batch_id is null
     and not exists (select 1 from public.journal_revisions rev where rev.original_batch_id = jb.id)
    join public.journal_postings p on p.batch_id = jb.id
    join public.ledger_accounts la on la.id = p.ledger_account_id and la.is_category = false
    join public.accounts acc on acc.ledger_account_id = la.id
   where ct.id = p_txn_a and ct.household_id = p_household_id and ct.voided_at is null;
  if v_a.txn_id is null then
    raise exception 'KEEL_NOT_FOUND: transaction' using errcode = 'P0006';
  end if;

  select ct.id as txn_id, acc.id as account_id, p.amount_minor, p.currency
    into v_b
    from public.canonical_transactions ct
    join public.journal_batches jb
      on jb.canonical_transaction_id = ct.id and jb.reverses_batch_id is null
     and not exists (select 1 from public.journal_revisions rev where rev.original_batch_id = jb.id)
    join public.journal_postings p on p.batch_id = jb.id
    join public.ledger_accounts la on la.id = p.ledger_account_id and la.is_category = false
    join public.accounts acc on acc.ledger_account_id = la.id
   where ct.id = p_txn_b and ct.household_id = p_household_id and ct.voided_at is null;
  if v_b.txn_id is null then
    raise exception 'KEEL_NOT_FOUND: transaction' using errcode = 'P0006';
  end if;

  if v_a.account_id = v_b.account_id then
    raise exception 'KEEL_INVALID_COMMAND: both transactions are on the same account' using errcode = 'P0009';
  end if;
  if v_a.currency <> v_b.currency then
    raise exception 'KEEL_CURRENCY_MISMATCH: transactions are in different currencies' using errcode = 'P0010';
  end if;
  if v_a.amount_minor = 0 or v_b.amount_minor = 0 or sign(v_a.amount_minor) = sign(v_b.amount_minor) then
    raise exception 'KEEL_INVALID_COMMAND: a transfer needs one outflow and one inflow' using errcode = 'P0009';
  end if;

  -- Orient by sign, not by argument order the caller happened to pass:
  -- negative = money leaving (txn_out), positive = money arriving (txn_in)
  -- -- the same convention keel_detect_transfers uses, so a manually-linked
  -- pair reads identically to an auto-detected one everywhere downstream.
  if v_a.amount_minor < 0 then
    v_out := v_a.txn_id;
    v_in := v_b.txn_id;
  else
    v_out := v_b.txn_id;
    v_in := v_a.txn_id;
  end if;

  if exists (
    select 1 from public.transfer_links
     where household_id = p_household_id
       and status in ('suggested', 'confirmed')
       and (v_out in (txn_out, txn_in) or v_in in (txn_out, txn_in))
  ) then
    raise exception 'KEEL_INVALID_COMMAND: one of these transactions is already part of a transfer' using errcode = 'P0009';
  end if;

  insert into public.transfer_links (household_id, txn_out, txn_in, status)
  values (p_household_id, v_out, v_in, 'suggested')
  on conflict (txn_out, txn_in) do nothing
  returning id into v_link_id;

  -- Only reachable when this exact pair already exists as a REJECTED link
  -- (an active suggested/confirmed match would have hit the exists() check
  -- above first) -- surface that plainly instead of a bare conflict error.
  if v_link_id is null then
    raise exception
      'KEEL_INVALID_COMMAND: this pair was already reviewed and rejected as a transfer'
      using errcode = 'P0009';
  end if;

  insert into public.audit_log (household_id, actor, action, object_type, object_id, after)
  values (p_household_id, jsonb_build_object('kind', 'user', 'userId', auth.uid()),
          'transfers.link_manual', 'transfer_link', v_link_id,
          jsonb_build_object('txnOut', v_out, 'txnIn', v_in, 'status', 'suggested'));

  return v_link_id;
end;
$$;

revoke all on function public.keel_link_transfer(uuid, uuid, uuid) from public, anon;
grant execute on function public.keel_link_transfer(uuid, uuid, uuid) to authenticated;
