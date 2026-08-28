create function public.keel_guard_expected_receipt_reversal()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if tg_op <> 'UPDATE'
     or current_user <> 'keel_api'
     or old.status is distinct from 'active'::public.settlement_status
     or new.status is distinct from 'reversed'::public.settlement_status
     or new.household_id is distinct from old.household_id
     or new.id is distinct from old.id
     or new.expected_id is distinct from old.expected_id
     or new.transaction_id is distinct from old.transaction_id
     or new.allocated_minor is distinct from old.allocated_minor
     or new.note is distinct from old.note
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at
     or new.updated_at < old.updated_at then
    raise exception 'KEEL_IMMUTABLE: expected reimbursement receipts allow only controlled reversal'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

grant create on schema public to keel_api;
alter function public.keel_guard_expected_receipt_reversal() owner to keel_api;
revoke create on schema public from keel_api;

revoke all on function public.keel_guard_expected_receipt_reversal()
  from public, anon, authenticated;

drop trigger expected_reimbursement_receipts_immutable
  on public.expected_reimbursement_receipts;

create trigger expected_reimbursement_receipts_reversal_guard
before update or delete on public.expected_reimbursement_receipts
for each row execute function public.keel_guard_expected_receipt_reversal();
