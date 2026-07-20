-- Expected (pending / future-dated) reimbursements — an accounts-receivable line
-- for "someone owes me money" tracked BEFORE it arrives. Builds ON the existing
-- reimbursement domain (20260712140000): reuses public.counterparties and the
-- keel_live_real_posting expense-capacity helper, but is a distinct, lighter
-- surface. An expected reimbursement is NOT an economic event — money has not
-- moved (Law 2/9), so it writes ZERO journal postings. It only becomes visible
-- as an upcoming/receivable item. When a real inbound transaction lands, the
-- user (suggest→approve) records a receipt against it; partial receipts leave a
-- remaining balance; one that never arrives is written off (reversible) or left
-- open as a remainder. Every mutation rides the standard command spine
-- (keel_finish_command: audit_log + domain_events + command_executions) and is
-- idempotent + reversible.
--
-- Apply (⚑ human, live cloud): source supabase/.env.remote then
--   psql "postgresql://postgres@db.<ref>.supabase.co:5432/postgres" \
--     -v ON_ERROR_STOP=1 --single-transaction -f <this file>

create type public.expected_reimbursement_status as enum('open','received','written_off');
create type public.expected_reimbursement_transition as enum('created','received','written_off','reopened','receipt_reversed');

create table public.expected_reimbursements(
 household_id uuid not null references public.households(id),
 id uuid not null default gen_random_uuid(),
 counterparty_id uuid not null,
 -- nullable: a standalone expectation ("Leo owes me for cruise tickets") need
 -- not be carved from an existing expense. When present it links the source
 -- outflow the expectation was carved from.
 source_transaction_id uuid,
 expected_minor bigint not null check(expected_minor>0),
 currency char(3) not null check(currency=upper(currency)),
 expected_date date not null,
 description text not null check(length(description) between 1 and 500),
 status public.expected_reimbursement_status not null default 'open',
 created_by uuid not null references auth.users(id),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 primary key(household_id,id),
 constraint fk_expected_counterparty_tenant foreign key(household_id,counterparty_id) references public.counterparties(household_id,id),
 constraint fk_expected_source_txn_tenant foreign key(household_id,source_transaction_id) references public.canonical_transactions(household_id,id));

create table public.expected_reimbursement_receipts(
 household_id uuid not null references public.households(id),
 id uuid not null default gen_random_uuid(),
 expected_id uuid not null,
 transaction_id uuid not null,
 allocated_minor bigint not null check(allocated_minor>0),
 status public.settlement_status not null default 'active',
 note text not null check(length(note) between 1 and 500),
 created_by uuid not null references auth.users(id),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 primary key(household_id,id),
 unique(household_id,expected_id,transaction_id),
 constraint fk_expected_receipt_expected_tenant foreign key(household_id,expected_id) references public.expected_reimbursements(household_id,id),
 constraint fk_expected_receipt_txn_tenant foreign key(household_id,transaction_id) references public.canonical_transactions(household_id,id));

create table public.expected_reimbursement_status_events(
 household_id uuid not null references public.households(id),
 id uuid not null default gen_random_uuid(),
 expected_id uuid not null,
 transition public.expected_reimbursement_transition not null,
 reason text,
 actor jsonb not null,
 command_id uuid not null,
 created_at timestamptz not null default now(),
 primary key(household_id,id),
 unique(household_id,expected_id,command_id),
 constraint fk_expected_event_tenant foreign key(household_id,expected_id) references public.expected_reimbursements(household_id,id));

create index expected_reimbursements_open_idx on public.expected_reimbursements(household_id,status,expected_date);
create index expected_reimbursement_receipts_expected_idx on public.expected_reimbursement_receipts(household_id,expected_id);
create index expected_reimbursement_receipts_txn_idx on public.expected_reimbursement_receipts(household_id,transaction_id);

-- receipts + status events are append-only; the parent row's status/updated_at
-- is the only mutable surface and only the definer commands touch it.
create trigger expected_reimbursement_receipts_immutable before update or delete on public.expected_reimbursement_receipts for each row execute function public.keel_forbid_mutation();
create trigger expected_reimbursement_status_events_immutable before update or delete on public.expected_reimbursement_status_events for each row execute function public.keel_forbid_mutation();

-- Access: an expectation is visible/writable if the caller can access its
-- source expense's account (when carved from one) OR is simply a household
-- member (standalone expectations have no account to anchor on — membership +
-- role via keel_recurring_account_access with a null-safe fallback).
create function public.keel_expected_reimbursement_access(p_household_id uuid,p_expected_id uuid,p_write boolean)
returns boolean language sql security definer stable set search_path=public as $$
 select exists(
  select 1 from public.expected_reimbursements e
  where e.household_id=p_household_id and e.id=p_expected_id
   and case
    when e.source_transaction_id is not null then
     exists(select 1 from public.canonical_transactions t where t.household_id=e.household_id and t.id=e.source_transaction_id
      and public.keel_recurring_account_access(p_household_id,t.account_id,p_write))
    else
     exists(select 1 from public.household_memberships m
      where m.household_id=p_household_id
       and m.user_id=coalesce(nullif(pg_catalog.current_setting('request.jwt.claim.sub',true),''),nullif(pg_catalog.current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid
       and (not p_write or m.role in('owner','partner')))
   end);
$$;

-- Remaining balance = expected − Σ active receipts (never negative). Pure read.
create function public.keel_expected_reimbursement_remaining(p_household_id uuid,p_expected_id uuid)
returns bigint language sql security definer stable set search_path=public as $$
 select greatest(e.expected_minor-coalesce((select sum(r.allocated_minor) from public.expected_reimbursement_receipts r
   where r.household_id=e.household_id and r.expected_id=e.id and r.status='active'),0),0)
 from public.expected_reimbursements e where e.household_id=p_household_id and e.id=p_expected_id;
$$;

-- CREATE: standalone OR carved from an existing outflow. Zero postings.
create function public.keel_expected_reimbursement_create(p_command_id uuid,p_economic_event_key text,p_actor jsonb,p_household_id uuid,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_hash text:=public.keel_payload_hash(p_payload);v_replay jsonb;v_actor jsonb;v_counterparty uuid;v_expected uuid:=gen_random_uuid();
 v_amount bigint;v_source uuid;v_account uuid;v_capacity numeric;v_src_currency text;v_after jsonb;v_result jsonb;
begin
 perform public.keel_assert_member_write(p_household_id);v_actor:=public.keel_actor_from_jwt();
 v_replay:=public.keel_idempotency_check(p_household_id,p_economic_event_key,v_hash);if v_replay is not null then return v_replay;end if;
 if jsonb_typeof(p_payload)<>'object'
  or (p_payload-'counterparty_name'-'kind'-'amount_minor'-'currency'-'expected_date'-'description'-'source_transaction_id')<>'{}'::jsonb
  or coalesce(p_payload->>'counterparty_name','')='' or length(p_payload->>'counterparty_name')>200
  or coalesce(p_payload->>'kind','') not in('friend','employer','client','insurance','household')
  or coalesce(p_payload->>'amount_minor','')!~'^[1-9][0-9]*$'
  or coalesce(p_payload->>'currency','')!~'^[A-Z]{3}$'
  or coalesce(p_payload->>'expected_date','')!~'^\d{4}-\d{2}-\d{2}$'
  or length(coalesce(p_payload->>'description','')) not between 1 and 500
  or (p_payload ? 'source_transaction_id' and coalesce(p_payload->>'source_transaction_id','')!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
 then raise exception 'KEEL_INVALID_COMMAND: malformed expected reimbursement' using errcode='P0009';end if;
 begin v_amount:=(p_payload->>'amount_minor')::bigint;exception when others then raise exception 'KEEL_INVALID_COMMAND: invalid expected money' using errcode='P0009';end;
 -- reject an obviously bad date (::date raises on e.g. 2026-13-40)
 begin perform (p_payload->>'expected_date')::date;exception when others then raise exception 'KEEL_INVALID_COMMAND: invalid expected date' using errcode='P0009';end;
 if p_payload ? 'source_transaction_id' then
  v_source:=(p_payload->>'source_transaction_id')::uuid;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_household_id::text||':expected-src:'||v_source::text,0));
  -- carve from a real posted outflow the caller can access; cap at the expense.
  select account_id,-(amount_minor::numeric),currency into v_account,v_capacity,v_src_currency
   from public.keel_live_real_posting(p_household_id,v_source) where amount_minor<0;
  if not found or not public.keel_recurring_account_access(p_household_id,v_account,true) then raise exception 'KEEL_SCOPE_VIOLATION: source expense not found' using errcode='P0006';end if;
  if v_src_currency<>p_payload->>'currency' or v_amount::numeric>v_capacity then raise exception 'KEEL_INVALID_COMMAND: expectation exceeds source expense' using errcode='P0009';end if;
 end if;
 insert into public.counterparties(household_id,name,kind) values(p_household_id,p_payload->>'counterparty_name',(p_payload->>'kind')::public.counterparty_kind)
  on conflict(household_id,name,kind) do nothing returning id into v_counterparty;
 if v_counterparty is null then select id into v_counterparty from public.counterparties where household_id=p_household_id and name=p_payload->>'counterparty_name' and kind=(p_payload->>'kind')::public.counterparty_kind;end if;
 insert into public.expected_reimbursements(household_id,id,counterparty_id,source_transaction_id,expected_minor,currency,expected_date,description,status,created_by)
  values(p_household_id,v_expected,v_counterparty,v_source,v_amount,p_payload->>'currency',(p_payload->>'expected_date')::date,p_payload->>'description','open',(v_actor->>'userId')::uuid);
 insert into public.expected_reimbursement_status_events(household_id,expected_id,transition,reason,actor,command_id) values(p_household_id,v_expected,'created',null,v_actor,p_command_id);
 v_after:=jsonb_build_object('expectedId',v_expected,'counterpartyId',v_counterparty,'sourceTransactionId',v_source,'amountMinor',v_amount::text,'remainingMinor',v_amount::text,'expectedDate',p_payload->>'expected_date','incomeImpactMinor','0','status','open');
 v_result:=jsonb_build_object('commandId',p_command_id,'economicEventKey',p_economic_event_key,'idempotentReplay',false,'effects',v_after,'asOf',to_char(now() at time zone'utc','YYYY-MM-DD"T"HH24:MI:SS"Z"'));
 perform public.keel_finish_command(p_command_id,'expected_reimbursements.create',p_economic_event_key,p_household_id,v_actor,v_hash,'expected_reimbursements.created','expected_reimbursement',v_expected,v_after,v_result);return v_result;
exception when unique_violation then raise exception 'KEEL_IDEMPOTENCY_CONFLICT: duplicate expected reimbursement' using errcode='P0007';end;$$;

-- RECORD RECEIPT: match a real inbound transaction (suggest→approve). Reduces
-- remaining; auto-closes to 'received' once fully covered. No postings.
create function public.keel_expected_reimbursement_record_receipt(p_command_id uuid,p_economic_event_key text,p_actor jsonb,p_household_id uuid,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_hash text:=public.keel_payload_hash(p_payload);v_replay jsonb;v_actor jsonb;v_row public.expected_reimbursements%rowtype;
 v_alloc bigint;v_remaining bigint;v_account uuid;v_capacity bigint;v_tx_currency text;v_prior_txn numeric;v_receipt uuid:=gen_random_uuid();v_new_status public.expected_reimbursement_status;v_after jsonb;v_result jsonb;
begin
 perform public.keel_assert_member_write(p_household_id);v_actor:=public.keel_actor_from_jwt();
 v_replay:=public.keel_idempotency_check(p_household_id,p_economic_event_key,v_hash);if v_replay is not null then return v_replay;end if;
 if jsonb_typeof(p_payload)<>'object' or (p_payload-'expected_id'-'transaction_id'-'amount_minor'-'note')<>'{}'::jsonb
  or coalesce(p_payload->>'expected_id','')!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  or coalesce(p_payload->>'transaction_id','')!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  or coalesce(p_payload->>'amount_minor','')!~'^[1-9][0-9]*$' or length(coalesce(p_payload->>'note','')) not between 1 and 500
 then raise exception 'KEEL_INVALID_COMMAND: malformed receipt' using errcode='P0009';end if;
 begin v_alloc:=(p_payload->>'amount_minor')::bigint;exception when others then raise exception 'KEEL_INVALID_COMMAND: invalid receipt money' using errcode='P0009';end;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_household_id::text||':expected:'||(p_payload->>'expected_id'),0));
 select * into v_row from public.expected_reimbursements where household_id=p_household_id and id=(p_payload->>'expected_id')::uuid for update;
 if not found or v_row.status<>'open' or not public.keel_expected_reimbursement_access(p_household_id,v_row.id,true) then raise exception 'KEEL_SCOPE_VIOLATION: expected reimbursement not found' using errcode='P0006';end if;
 -- must be a real inbound the caller can access; cap allocation at the txn's inflow.
 select account_id,amount_minor,currency into v_account,v_capacity,v_tx_currency from public.keel_live_real_posting(p_household_id,(p_payload->>'transaction_id')::uuid) where amount_minor>0;
 if not found or not public.keel_recurring_account_access(p_household_id,v_account,true) then raise exception 'KEEL_SCOPE_VIOLATION: receipt transaction not found' using errcode='P0006';end if;
 if v_tx_currency<>v_row.currency then raise exception 'KEEL_INVALID_COMMAND: receipt currency mismatch' using errcode='P0009';end if;
 select coalesce(sum(allocated_minor),0) into v_prior_txn from public.expected_reimbursement_receipts where household_id=p_household_id and transaction_id=(p_payload->>'transaction_id')::uuid and status='active';
 if v_prior_txn+v_alloc>v_capacity then raise exception 'KEEL_INVALID_COMMAND: receipt transaction overallocated' using errcode='P0009';end if;
 v_remaining:=public.keel_expected_reimbursement_remaining(p_household_id,v_row.id);
 if v_alloc>v_remaining then raise exception 'KEEL_INVALID_COMMAND: receipt exceeds remaining balance' using errcode='P0009';end if;
 insert into public.expected_reimbursement_receipts(household_id,id,expected_id,transaction_id,allocated_minor,status,note,created_by)
  values(p_household_id,v_receipt,v_row.id,(p_payload->>'transaction_id')::uuid,v_alloc,'active',p_payload->>'note',(v_actor->>'userId')::uuid);
 v_new_status:=case when v_alloc>=v_remaining then 'received' else 'open' end;
 if v_new_status='received' then
  update public.expected_reimbursements set status='received',updated_at=now() where household_id=p_household_id and id=v_row.id;
  insert into public.expected_reimbursement_status_events(household_id,expected_id,transition,reason,actor,command_id) values(p_household_id,v_row.id,'received',null,v_actor,p_command_id);
 end if;
 v_after:=jsonb_build_object('expectedId',v_row.id,'receiptId',v_receipt,'transactionId',p_payload->>'transaction_id','allocatedMinor',v_alloc::text,'remainingMinor',public.keel_expected_reimbursement_remaining(p_household_id,v_row.id)::text,'incomeImpactMinor','0','status',v_new_status);
 v_result:=jsonb_build_object('commandId',p_command_id,'economicEventKey',p_economic_event_key,'idempotentReplay',false,'effects',v_after,'asOf',to_char(now() at time zone'utc','YYYY-MM-DD"T"HH24:MI:SS"Z"'));
 perform public.keel_finish_command(p_command_id,'expected_reimbursements.record_receipt',p_economic_event_key,p_household_id,v_actor,v_hash,'expected_reimbursements.receipt_recorded','expected_reimbursement_receipt',v_receipt,v_after,v_result);return v_result;
exception when unique_violation then raise exception 'KEEL_IDEMPOTENCY_CONFLICT: duplicate receipt evidence' using errcode='P0007';end;$$;

-- WRITE OFF: close an open remainder that never arrived (reversible via reopen).
create function public.keel_expected_reimbursement_write_off(p_command_id uuid,p_economic_event_key text,p_actor jsonb,p_household_id uuid,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_hash text:=public.keel_payload_hash(p_payload);v_replay jsonb;v_actor jsonb;v_row public.expected_reimbursements%rowtype;v_before jsonb;v_after jsonb;v_result jsonb;
begin
 perform public.keel_assert_member_write(p_household_id);v_actor:=public.keel_actor_from_jwt();
 v_replay:=public.keel_idempotency_check(p_household_id,p_economic_event_key,v_hash);if v_replay is not null then return v_replay;end if;
 if jsonb_typeof(p_payload)<>'object' or (p_payload-'expected_id'-'reason')<>'{}'::jsonb
  or coalesce(p_payload->>'expected_id','')!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  or length(coalesce(p_payload->>'reason','')) not between 1 and 500 then raise exception 'KEEL_INVALID_COMMAND: invalid write-off' using errcode='P0009';end if;
 select * into v_row from public.expected_reimbursements where household_id=p_household_id and id=(p_payload->>'expected_id')::uuid for update;
 if not found or v_row.status<>'open' or not public.keel_expected_reimbursement_access(p_household_id,v_row.id,true) then raise exception 'KEEL_SCOPE_VIOLATION: expected reimbursement not found' using errcode='P0006';end if;
 v_before:=jsonb_build_object('expectedId',v_row.id,'status','open');
 update public.expected_reimbursements set status='written_off',updated_at=now() where household_id=p_household_id and id=v_row.id;
 insert into public.expected_reimbursement_status_events(household_id,expected_id,transition,reason,actor,command_id) values(p_household_id,v_row.id,'written_off',p_payload->>'reason',v_actor,p_command_id);
 v_after:=jsonb_build_object('expectedId',v_row.id,'status','written_off','reason',p_payload->>'reason','incomeImpactMinor','0');
 v_result:=jsonb_build_object('commandId',p_command_id,'economicEventKey',p_economic_event_key,'idempotentReplay',false,'effects',v_after,'asOf',to_char(now() at time zone'utc','YYYY-MM-DD"T"HH24:MI:SS"Z"'));
 perform public.keel_finish_command(p_command_id,'expected_reimbursements.write_off',p_economic_event_key,p_household_id,v_actor,v_hash,'expected_reimbursements.written_off','expected_reimbursement',v_row.id,v_after,v_result);return v_result;
exception when unique_violation then raise exception 'KEEL_IDEMPOTENCY_CONFLICT: duplicate write-off' using errcode='P0007';end;$$;

-- REOPEN: undo a write-off or a full-receipt close, back to 'open' (the
-- remainder resurfaces). Active receipts are preserved; remaining recomputes.
create function public.keel_expected_reimbursement_reopen(p_command_id uuid,p_economic_event_key text,p_actor jsonb,p_household_id uuid,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_hash text:=public.keel_payload_hash(p_payload);v_replay jsonb;v_actor jsonb;v_row public.expected_reimbursements%rowtype;v_before jsonb;v_after jsonb;v_result jsonb;
begin
 perform public.keel_assert_member_write(p_household_id);v_actor:=public.keel_actor_from_jwt();
 v_replay:=public.keel_idempotency_check(p_household_id,p_economic_event_key,v_hash);if v_replay is not null then return v_replay;end if;
 if jsonb_typeof(p_payload)<>'object' or (p_payload-'expected_id'-'reason')<>'{}'::jsonb
  or coalesce(p_payload->>'expected_id','')!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  or length(coalesce(p_payload->>'reason','')) not between 1 and 500 then raise exception 'KEEL_INVALID_COMMAND: invalid reopen' using errcode='P0009';end if;
 select * into v_row from public.expected_reimbursements where household_id=p_household_id and id=(p_payload->>'expected_id')::uuid for update;
 if not found or v_row.status='open' or not public.keel_expected_reimbursement_access(p_household_id,v_row.id,true) then raise exception 'KEEL_SCOPE_VIOLATION: expected reimbursement not found' using errcode='P0006';end if;
 v_before:=jsonb_build_object('expectedId',v_row.id,'status',v_row.status::text);
 update public.expected_reimbursements set status='open',updated_at=now() where household_id=p_household_id and id=v_row.id;
 insert into public.expected_reimbursement_status_events(household_id,expected_id,transition,reason,actor,command_id) values(p_household_id,v_row.id,'reopened',p_payload->>'reason',v_actor,p_command_id);
 v_after:=jsonb_build_object('expectedId',v_row.id,'status','open','remainingMinor',public.keel_expected_reimbursement_remaining(p_household_id,v_row.id)::text,'reason',p_payload->>'reason','incomeImpactMinor','0');
 v_result:=jsonb_build_object('commandId',p_command_id,'economicEventKey',p_economic_event_key,'idempotentReplay',false,'effects',v_after,'asOf',to_char(now() at time zone'utc','YYYY-MM-DD"T"HH24:MI:SS"Z"'));
 perform public.keel_finish_command(p_command_id,'expected_reimbursements.reopen',p_economic_event_key,p_household_id,v_actor,v_hash,'expected_reimbursements.reopened','expected_reimbursement',v_row.id,v_after,v_result);return v_result;
exception when unique_violation then raise exception 'KEEL_IDEMPOTENCY_CONFLICT: duplicate reopen' using errcode='P0007';end;$$;

-- REVERSE RECEIPT: undo a mistaken match. Marks the receipt reversed (append-
-- only status flip on the receipt) and reopens the parent if it had closed.
create function public.keel_expected_reimbursement_reverse_receipt(p_command_id uuid,p_economic_event_key text,p_actor jsonb,p_household_id uuid,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_hash text:=public.keel_payload_hash(p_payload);v_replay jsonb;v_actor jsonb;v_receipt public.expected_reimbursement_receipts%rowtype;v_expected public.expected_reimbursements%rowtype;v_before jsonb;v_after jsonb;v_result jsonb;
begin
 perform public.keel_assert_member_write(p_household_id);v_actor:=public.keel_actor_from_jwt();
 v_replay:=public.keel_idempotency_check(p_household_id,p_economic_event_key,v_hash);if v_replay is not null then return v_replay;end if;
 if jsonb_typeof(p_payload)<>'object' or (p_payload-'receipt_id'-'reason')<>'{}'::jsonb
  or coalesce(p_payload->>'receipt_id','')!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  or length(coalesce(p_payload->>'reason','')) not between 1 and 500 then raise exception 'KEEL_INVALID_COMMAND: invalid receipt reversal' using errcode='P0009';end if;
 select * into v_receipt from public.expected_reimbursement_receipts where household_id=p_household_id and id=(p_payload->>'receipt_id')::uuid for update;
 if not found or v_receipt.status<>'active' or not public.keel_expected_reimbursement_access(p_household_id,v_receipt.expected_id,true) then raise exception 'KEEL_SCOPE_VIOLATION: receipt not found' using errcode='P0006';end if;
 select * into v_expected from public.expected_reimbursements where household_id=p_household_id and id=v_receipt.expected_id for update;
 -- the receipts table is append-only for user roles but the definer flips its
 -- status column (keel_forbid_mutation blocks non-definer UPDATE/DELETE).
 v_before:=jsonb_build_object('receiptId',v_receipt.id,'status','active');
 update public.expected_reimbursement_receipts set status='reversed',updated_at=now() where household_id=p_household_id and id=v_receipt.id;
 if v_expected.status='received' then
  update public.expected_reimbursements set status='open',updated_at=now() where household_id=p_household_id and id=v_expected.id;
  insert into public.expected_reimbursement_status_events(household_id,expected_id,transition,reason,actor,command_id) values(p_household_id,v_expected.id,'receipt_reversed',p_payload->>'reason',v_actor,p_command_id);
 else
  insert into public.expected_reimbursement_status_events(household_id,expected_id,transition,reason,actor,command_id) values(p_household_id,v_expected.id,'receipt_reversed',p_payload->>'reason',v_actor,p_command_id);
 end if;
 v_after:=jsonb_build_object('receiptId',v_receipt.id,'expectedId',v_expected.id,'status','reversed','remainingMinor',public.keel_expected_reimbursement_remaining(p_household_id,v_expected.id)::text,'reason',p_payload->>'reason','incomeImpactMinor','0');
 v_result:=jsonb_build_object('commandId',p_command_id,'economicEventKey',p_economic_event_key,'idempotentReplay',false,'effects',v_after,'asOf',to_char(now() at time zone'utc','YYYY-MM-DD"T"HH24:MI:SS"Z"'));
 perform public.keel_finish_command(p_command_id,'expected_reimbursements.reverse_receipt',p_economic_event_key,p_household_id,v_actor,v_hash,'expected_reimbursements.receipt_reversed','expected_reimbursement_receipt',v_receipt.id,v_after,v_result);return v_result;
exception when unique_violation then raise exception 'KEEL_IDEMPOTENCY_CONFLICT: duplicate receipt reversal' using errcode='P0007';end;$$;

-- LIST: AR-style read model — every non-archived expectation with remaining,
-- status, source, receipts. Reproducible-numbers envelope (as_of + formula).
create function public.keel_list_expected_reimbursements(p_household_id uuid) returns jsonb language plpgsql security definer stable set search_path=public as $$
declare v_uid uuid:=coalesce(nullif(pg_catalog.current_setting('request.jwt.claim.sub',true),''),nullif(pg_catalog.current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid;v_rows jsonb;
begin
 if v_uid is null then raise exception 'KEEL_NOT_AUTHENTICATED' using errcode='P0004';end if;
 if not exists(select 1 from public.household_memberships where household_id=p_household_id and user_id=v_uid) then raise exception 'KEEL_SCOPE_VIOLATION' using errcode='P0006';end if;
 select coalesce(jsonb_agg(row.dto order by row.expected_date,row.created_at,row.id),'[]'::jsonb) into v_rows from(
  select e.id,e.expected_date,e.created_at,jsonb_build_object(
   'expectedId',e.id,'counterpartyId',e.counterparty_id,'counterpartyName',cp.name,'kind',cp.kind,
   'sourceTransactionId',e.source_transaction_id,'amountMinor',e.expected_minor::text,'currency',e.currency::text,
   'expectedDate',to_char(e.expected_date,'YYYY-MM-DD'),'description',e.description,
   'remainingMinor',public.keel_expected_reimbursement_remaining(e.household_id,e.id)::text,
   'status',e.status::text,'incomeImpactMinor','0','formulaVersion','expected-reimbursement-v1',
   'receipts',coalesce((select jsonb_agg(jsonb_build_object('receiptId',r.id,'transactionId',r.transaction_id,'allocatedMinor',r.allocated_minor::text,'status',r.status,'note',r.note) order by r.created_at,r.id)
     from public.expected_reimbursement_receipts r where r.household_id=e.household_id and r.expected_id=e.id),'[]'::jsonb)) dto
  from public.expected_reimbursements e join public.counterparties cp on cp.household_id=e.household_id and cp.id=e.counterparty_id
  where e.household_id=p_household_id and public.keel_expected_reimbursement_access(p_household_id,e.id,false))row;
 return jsonb_build_object('scope',jsonb_build_object('householdId',p_household_id),'asOf',to_char(now() at time zone'utc','YYYY-MM-DD"T"HH24:MI:SS"Z"'),'formulaVersion','expected-reimbursement-v1','rows',v_rows);
end;$$;

-- ---- RLS + grants (mirror the reimbursement-domain pattern) ----
alter table public.expected_reimbursements enable row level security;
alter table public.expected_reimbursement_receipts enable row level security;
alter table public.expected_reimbursement_status_events enable row level security;
revoke all on public.expected_reimbursements,public.expected_reimbursement_receipts,public.expected_reimbursement_status_events from public,anon,authenticated;
grant select on public.expected_reimbursements,public.expected_reimbursement_receipts,public.expected_reimbursement_status_events to authenticated,service_role;
create policy expected_reimbursements_read on public.expected_reimbursements for select to authenticated using(public.keel_expected_reimbursement_access(household_id,id,false));
create policy expected_receipts_read on public.expected_reimbursement_receipts for select to authenticated using(public.keel_expected_reimbursement_access(household_id,expected_id,false));
create policy expected_events_read on public.expected_reimbursement_status_events for select to authenticated using(public.keel_expected_reimbursement_access(household_id,expected_id,false));

grant select,insert,update on public.expected_reimbursements to keel_api;
grant select,insert,update on public.expected_reimbursement_receipts to keel_api;
grant select,insert on public.expected_reimbursement_status_events to keel_api;
create policy expected_reimbursements_api_all on public.expected_reimbursements for all to keel_api using(true) with check(true);
create policy expected_receipts_api_all on public.expected_reimbursement_receipts for all to keel_api using(true) with check(true);
create policy expected_events_api_all on public.expected_reimbursement_status_events for all to keel_api using(true) with check(true);

grant create on schema public to keel_api;
alter function public.keel_expected_reimbursement_access(uuid,uuid,boolean) owner to keel_api;
alter function public.keel_expected_reimbursement_remaining(uuid,uuid) owner to keel_api;
alter function public.keel_expected_reimbursement_create(uuid,text,jsonb,uuid,jsonb) owner to keel_api;
alter function public.keel_expected_reimbursement_record_receipt(uuid,text,jsonb,uuid,jsonb) owner to keel_api;
alter function public.keel_expected_reimbursement_write_off(uuid,text,jsonb,uuid,jsonb) owner to keel_api;
alter function public.keel_expected_reimbursement_reopen(uuid,text,jsonb,uuid,jsonb) owner to keel_api;
alter function public.keel_expected_reimbursement_reverse_receipt(uuid,text,jsonb,uuid,jsonb) owner to keel_api;
alter function public.keel_list_expected_reimbursements(uuid) owner to keel_api;
revoke create on schema public from keel_api;

revoke all on function public.keel_expected_reimbursement_access(uuid,uuid,boolean),public.keel_expected_reimbursement_remaining(uuid,uuid) from public,anon,authenticated;
grant execute on function public.keel_expected_reimbursement_access(uuid,uuid,boolean),public.keel_expected_reimbursement_remaining(uuid,uuid) to authenticated,keel_api;
revoke all on function public.keel_expected_reimbursement_create(uuid,text,jsonb,uuid,jsonb),public.keel_expected_reimbursement_record_receipt(uuid,text,jsonb,uuid,jsonb),public.keel_expected_reimbursement_write_off(uuid,text,jsonb,uuid,jsonb),public.keel_expected_reimbursement_reopen(uuid,text,jsonb,uuid,jsonb),public.keel_expected_reimbursement_reverse_receipt(uuid,text,jsonb,uuid,jsonb),public.keel_list_expected_reimbursements(uuid) from public,anon;
grant execute on function public.keel_expected_reimbursement_create(uuid,text,jsonb,uuid,jsonb),public.keel_expected_reimbursement_record_receipt(uuid,text,jsonb,uuid,jsonb),public.keel_expected_reimbursement_write_off(uuid,text,jsonb,uuid,jsonb),public.keel_expected_reimbursement_reopen(uuid,text,jsonb,uuid,jsonb),public.keel_expected_reimbursement_reverse_receipt(uuid,text,jsonb,uuid,jsonb),public.keel_list_expected_reimbursements(uuid) to authenticated;

do $$begin if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_roles r on r.oid=p.proowner where n.nspname='public' and p.proname like 'keel%expected_reimbursement%' and p.prosecdef and r.rolname<>'keel_api')then raise exception 'KEEL_OWNERSHIP: expected reimbursement definer owner';end if;end$$;

-- ---- Export (Data Access Guarantee — Law 6). Chain onto current export. ----
grant select on public.expected_reimbursements,public.expected_reimbursement_receipts,public.expected_reimbursement_status_events to keel_export;
create policy expected_reimbursements_export on public.expected_reimbursements for select to keel_export using(true);
create policy expected_receipts_export on public.expected_reimbursement_receipts for select to keel_export using(true);
create policy expected_events_export on public.expected_reimbursement_status_events for select to keel_export using(true);
alter function public.keel_export_household(uuid,timestamptz) rename to keel_export_household_pre_expected_reimb;
revoke all on function public.keel_export_household_pre_expected_reimb(uuid,timestamptz) from public,anon,authenticated,service_role;
create function public.keel_export_household(p_household_id uuid,p_as_of timestamptz default null)returns jsonb language plpgsql security definer stable set search_path=pg_catalog,public as $$declare v_base jsonb;v_tables jsonb;begin v_base:=public.keel_export_household_pre_expected_reimb(p_household_id,p_as_of);select jsonb_build_object(
'expected_reimbursements',coalesce((select jsonb_agg(to_jsonb(x)||jsonb_build_object('expected_minor',x.expected_minor::text)order by x.household_id,x.id)from public.expected_reimbursements x where x.household_id=p_household_id),'[]'::jsonb),
'expected_reimbursement_receipts',coalesce((select jsonb_agg(to_jsonb(x)||jsonb_build_object('allocated_minor',x.allocated_minor::text)order by x.household_id,x.id)from public.expected_reimbursement_receipts x where x.household_id=p_household_id),'[]'::jsonb),
'expected_reimbursement_status_events',coalesce((select jsonb_agg(to_jsonb(x)order by x.household_id,x.id)from public.expected_reimbursement_status_events x where x.household_id=p_household_id),'[]'::jsonb))into v_tables;return jsonb_set(v_base,'{tables}',v_base->'tables'||v_tables);end$$;
revoke all on function public.keel_export_household(uuid,timestamptz)from public,anon,authenticated,service_role;grant create on schema public to keel_export;alter function public.keel_export_household(uuid,timestamptz)owner to keel_export;revoke create on schema public from keel_export;grant execute on function public.keel_export_household(uuid,timestamptz)to service_role;
