-- Stage 1D P2P/reimbursement/bill-split domain (BC-v2.1 mandatory gate 7).
-- Relationships preserve the original expense; settlement never writes ledger postings.
create type public.counterparty_kind as enum('friend','employer','client','insurance','household');
create type public.reimbursement_claim_status as enum('open','reversed');
create type public.settlement_status as enum('active','reversed');
create type public.reimbursement_transition as enum('created','reversed');

create table public.counterparties(
 id uuid primary key default gen_random_uuid(),household_id uuid not null references public.households(id),
 name text not null check(length(name) between 1 and 200),kind public.counterparty_kind not null,
 created_at timestamptz not null default now(),unique(household_id,id),unique(household_id,name,kind));
create table public.expense_shares(
 household_id uuid not null references public.households(id),id uuid not null default gen_random_uuid(),
 original_transaction_id uuid not null,counterparty_id uuid not null,amount_minor bigint not null check(amount_minor>0),
 currency char(3) not null check(currency=upper(currency)),description text not null check(length(description) between 1 and 500),
 created_at timestamptz not null default now(),primary key(household_id,id),unique(household_id,original_transaction_id,counterparty_id),
 constraint fk_expense_share_txn_tenant foreign key(household_id,original_transaction_id) references public.canonical_transactions(household_id,id),
 constraint fk_expense_share_counterparty_tenant foreign key(household_id,counterparty_id) references public.counterparties(household_id,id));
create table public.reimbursement_claims(
 household_id uuid not null references public.households(id),id uuid not null default gen_random_uuid(),expense_share_id uuid not null,
 counterparty_id uuid not null,original_transaction_id uuid not null,amount_minor bigint not null check(amount_minor>0),currency char(3) not null,
 status public.reimbursement_claim_status not null,created_by uuid not null references auth.users(id),created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 primary key(household_id,id),unique(household_id,expense_share_id),
 constraint fk_claim_share_tenant foreign key(household_id,expense_share_id) references public.expense_shares(household_id,id),
 constraint fk_claim_counterparty_tenant foreign key(household_id,counterparty_id) references public.counterparties(household_id,id),
 constraint fk_claim_txn_tenant foreign key(household_id,original_transaction_id) references public.canonical_transactions(household_id,id));
create table public.settlements(
 household_id uuid not null references public.households(id),id uuid not null default gen_random_uuid(),counterparty_id uuid not null,
 transaction_id uuid not null,total_minor bigint not null check(total_minor>0),currency char(3) not null,status public.settlement_status not null,
 note text not null check(length(note) between 1 and 500),created_by uuid not null references auth.users(id),created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 primary key(household_id,id),unique(household_id,transaction_id,counterparty_id),
 constraint fk_settlement_counterparty_tenant foreign key(household_id,counterparty_id) references public.counterparties(household_id,id),
 constraint fk_settlement_txn_tenant foreign key(household_id,transaction_id) references public.canonical_transactions(household_id,id));
create table public.settlement_matches(
 household_id uuid not null references public.households(id),id uuid not null default gen_random_uuid(),settlement_id uuid not null,claim_id uuid not null,
 allocated_minor bigint not null check(allocated_minor>0),created_at timestamptz not null default now(),primary key(household_id,id),unique(household_id,settlement_id,claim_id),
 constraint fk_settlement_match_settlement_tenant foreign key(household_id,settlement_id) references public.settlements(household_id,id),
 constraint fk_settlement_match_claim_tenant foreign key(household_id,claim_id) references public.reimbursement_claims(household_id,id));
create table public.refund_expectations(
 household_id uuid not null references public.households(id),id uuid not null default gen_random_uuid(),original_transaction_id uuid not null,
 expected_minor bigint not null check(expected_minor>0),currency char(3) not null,evidence jsonb not null,created_at timestamptz not null default now(),
 primary key(household_id,id),constraint fk_refund_expectation_txn_tenant foreign key(household_id,original_transaction_id) references public.canonical_transactions(household_id,id));
create table public.refund_matches(
 household_id uuid not null references public.households(id),id uuid not null default gen_random_uuid(),expectation_id uuid not null,transaction_id uuid not null,
 allocated_minor bigint not null check(allocated_minor>0),created_at timestamptz not null default now(),primary key(household_id,id),
 constraint fk_refund_match_expectation_tenant foreign key(household_id,expectation_id) references public.refund_expectations(household_id,id),
 constraint fk_refund_match_txn_tenant foreign key(household_id,transaction_id) references public.canonical_transactions(household_id,id));
create table public.settlement_status_events(
 household_id uuid not null references public.households(id),id uuid not null default gen_random_uuid(),settlement_id uuid not null,
 transition public.reimbursement_transition not null,reason text,actor jsonb not null,command_id uuid not null,created_at timestamptz not null default now(),
 primary key(household_id,id),unique(household_id,settlement_id,command_id),constraint fk_settlement_event_tenant foreign key(household_id,settlement_id) references public.settlements(household_id,id));
create table public.reimbursement_claim_status_events(
 household_id uuid not null references public.households(id),id uuid not null default gen_random_uuid(),claim_id uuid not null,
 transition public.reimbursement_transition not null,reason text,actor jsonb not null,command_id uuid not null,created_at timestamptz not null default now(),
 primary key(household_id,id),unique(household_id,claim_id,command_id),constraint fk_claim_event_tenant foreign key(household_id,claim_id) references public.reimbursement_claims(household_id,id));

create trigger expense_shares_immutable before update or delete on public.expense_shares for each row execute function public.keel_forbid_mutation();
create trigger settlement_matches_immutable before update or delete on public.settlement_matches for each row execute function public.keel_forbid_mutation();
create trigger refund_expectations_immutable before update or delete on public.refund_expectations for each row execute function public.keel_forbid_mutation();
create trigger refund_matches_immutable before update or delete on public.refund_matches for each row execute function public.keel_forbid_mutation();
create trigger settlement_status_events_immutable before update or delete on public.settlement_status_events for each row execute function public.keel_forbid_mutation();
create trigger claim_status_events_immutable before update or delete on public.reimbursement_claim_status_events for each row execute function public.keel_forbid_mutation();

create function public.keel_live_real_posting(p_household_id uuid,p_transaction_id uuid)
returns table(account_id uuid,amount_minor bigint,currency text) language sql security definer stable set search_path=public as $$
 select t.account_id,asset.amount_minor,asset.currency::text from public.canonical_transactions t
 join public.accounts a on a.household_id=t.household_id and a.id=t.account_id
 join lateral(select b.id from public.journal_batches b where b.household_id=t.household_id and b.canonical_transaction_id=t.id
   and b.reverses_batch_id is null and not exists(select 1 from public.journal_revisions r where r.original_batch_id=b.id)
   order by b.posted_at desc,b.id desc limit 1) live on true
 join public.journal_postings asset on asset.batch_id=live.id and asset.ledger_account_id=a.ledger_account_id
 where t.household_id=p_household_id and t.id=p_transaction_id and t.status in('posted','reviewed') and t.voided_at is null
 and (select count(*) from public.journal_postings jp join public.accounts real on real.household_id=t.household_id and real.ledger_account_id=jp.ledger_account_id where jp.batch_id=live.id)=1;
$$;
create function public.keel_reimbursement_claim_access(p_household_id uuid,p_claim_id uuid,p_write boolean)
returns boolean language sql security definer stable set search_path=public as $$
 select exists(select 1 from public.reimbursement_claims c join public.canonical_transactions t on t.household_id=c.household_id and t.id=c.original_transaction_id
  where c.household_id=p_household_id and c.id=p_claim_id and public.keel_recurring_account_access(p_household_id,t.account_id,p_write));
$$;
create function public.keel_is_non_income_settlement(p_household_id uuid,p_transaction_id uuid)
returns boolean language sql security definer stable set search_path=public as $$
 select exists(select 1 from public.settlements s where s.household_id=p_household_id and s.transaction_id=p_transaction_id and s.status='active');
$$;

create function public.keel_reimbursement_create_claim(p_command_id uuid,p_economic_event_key text,p_actor jsonb,p_household_id uuid,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_hash text:=public.keel_payload_hash(p_payload);v_replay jsonb;v_actor jsonb;v_account uuid;v_capacity numeric;v_currency text;
 v_counterparty uuid;v_share uuid;v_claim uuid:=gen_random_uuid();v_amount bigint;v_after jsonb;v_result jsonb;
begin perform public.keel_assert_member_write(p_household_id);v_actor:=public.keel_actor_from_jwt();v_replay:=public.keel_idempotency_check(p_household_id,p_economic_event_key,v_hash);if v_replay is not null then return v_replay;end if;
 if jsonb_typeof(p_payload)<>'object' or (p_payload-'original_transaction_id'-'counterparty_name'-'kind'-'amount_minor'-'currency'-'description')<>'{}'::jsonb
 or coalesce(p_payload->>'original_transaction_id','')!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' or coalesce(p_payload->>'counterparty_name','')='' or length(p_payload->>'counterparty_name')>200
 or coalesce(p_payload->>'kind','') not in('friend','employer','client','insurance','household') or coalesce(p_payload->>'amount_minor','')!~'^[1-9][0-9]*$'
 or coalesce(p_payload->>'currency','')!~'^[A-Z]{3}$' or length(coalesce(p_payload->>'description','')) not between 1 and 500
 then raise exception 'KEEL_INVALID_COMMAND: malformed reimbursement claim' using errcode='P0009';end if;
 begin v_amount:=(p_payload->>'amount_minor')::bigint;exception when others then raise exception 'KEEL_INVALID_COMMAND: invalid claim money' using errcode='P0009';end;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_household_id::text||':expense:'||(p_payload->>'original_transaction_id'),0));
 select account_id,-(amount_minor::numeric),currency into v_account,v_capacity,v_currency from public.keel_live_real_posting(p_household_id,(p_payload->>'original_transaction_id')::uuid) where amount_minor<0;
 if not found or not public.keel_recurring_account_access(p_household_id,v_account,true) then raise exception 'KEEL_SCOPE_VIOLATION: original expense not found' using errcode='P0006';end if;
 if v_currency<>p_payload->>'currency' or v_amount::numeric+coalesce((select sum(amount_minor) from public.expense_shares where household_id=p_household_id and original_transaction_id=(p_payload->>'original_transaction_id')::uuid),0)>v_capacity
 then raise exception 'KEEL_INVALID_COMMAND: expense share exceeds original expense' using errcode='P0009';end if;
 insert into public.counterparties(household_id,name,kind) values(p_household_id,p_payload->>'counterparty_name',(p_payload->>'kind')::public.counterparty_kind) on conflict(household_id,name,kind) do nothing returning id into v_counterparty;
 if v_counterparty is null then select id into v_counterparty from public.counterparties where household_id=p_household_id and name=p_payload->>'counterparty_name' and kind=(p_payload->>'kind')::public.counterparty_kind;end if;
 insert into public.expense_shares(household_id,original_transaction_id,counterparty_id,amount_minor,currency,description)
 values(p_household_id,(p_payload->>'original_transaction_id')::uuid,v_counterparty,v_amount,p_payload->>'currency',p_payload->>'description') returning id into v_share;
 insert into public.reimbursement_claims(household_id,id,expense_share_id,counterparty_id,original_transaction_id,amount_minor,currency,status,created_by)
 values(p_household_id,v_claim,v_share,v_counterparty,(p_payload->>'original_transaction_id')::uuid,v_amount,p_payload->>'currency','open',(v_actor->>'userId')::uuid);
 insert into public.reimbursement_claim_status_events(household_id,claim_id,transition,reason,actor,command_id) values(p_household_id,v_claim,'created',null,v_actor,p_command_id);
 v_after:=jsonb_build_object('claimId',v_claim,'counterpartyId',v_counterparty,'originalTransactionId',p_payload->>'original_transaction_id','amountMinor',v_amount::text,'remainingMinor',v_amount::text,'incomeImpactMinor','0','status','open');
 v_result:=jsonb_build_object('commandId',p_command_id,'economicEventKey',p_economic_event_key,'idempotentReplay',false,'effects',v_after,'asOf',to_char(now() at time zone'utc','YYYY-MM-DD"T"HH24:MI:SS"Z"'));
 perform public.keel_finish_command(p_command_id,'reimbursements.create_claim',p_economic_event_key,p_household_id,v_actor,v_hash,'reimbursements.claim_created','reimbursement_claim',v_claim,v_after,v_result);return v_result;
exception when unique_violation then raise exception 'KEEL_IDEMPOTENCY_CONFLICT: duplicate claim evidence' using errcode='P0007';end;$$;

create function public.keel_reimbursement_settle(p_command_id uuid,p_economic_event_key text,p_actor jsonb,p_household_id uuid,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_hash text:=public.keel_payload_hash(p_payload);v_replay jsonb;v_actor jsonb;v_allocation jsonb;v_claim public.reimbursement_claims%rowtype;
 v_counterparty uuid;v_currency text;v_total numeric:=0;v_alloc bigint;v_prior numeric;v_account uuid;v_capacity bigint;v_tx_currency text;v_settlement uuid:=gen_random_uuid();v_after jsonb;v_result jsonb;
begin perform public.keel_assert_member_write(p_household_id);v_actor:=public.keel_actor_from_jwt();v_replay:=public.keel_idempotency_check(p_household_id,p_economic_event_key,v_hash);if v_replay is not null then return v_replay;end if;
 if jsonb_typeof(p_payload)<>'object' or (p_payload-'transaction_id'-'allocations'-'note')<>'{}'::jsonb or coalesce(p_payload->>'transaction_id','')!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
 or jsonb_typeof(p_payload->'allocations')<>'array' or jsonb_array_length(p_payload->'allocations')<1 or jsonb_array_length(p_payload->'allocations')>100 or length(coalesce(p_payload->>'note','')) not between 1 and 500
 then raise exception 'KEEL_INVALID_COMMAND: malformed settlement' using errcode='P0009';end if;
 if(select count(*)<>count(distinct a->>'claim_id') from jsonb_array_elements(p_payload->'allocations') a) then raise exception 'KEEL_INVALID_COMMAND: duplicate claim allocation' using errcode='P0009';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_household_id::text||':settlement:'||(p_payload->>'transaction_id'),0));
 for v_allocation in select value from jsonb_array_elements(p_payload->'allocations') loop
  if coalesce(v_allocation->>'claim_id','')!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' or coalesce(v_allocation->>'amount_minor','')!~'^[1-9][0-9]*$' or (v_allocation-'claim_id'-'amount_minor')<>'{}'::jsonb then raise exception 'KEEL_INVALID_COMMAND: invalid allocation' using errcode='P0009';end if;
  begin v_alloc:=(v_allocation->>'amount_minor')::bigint;exception when others then raise exception 'KEEL_INVALID_COMMAND: invalid allocation money' using errcode='P0009';end;
  select * into v_claim from public.reimbursement_claims where household_id=p_household_id and id=(v_allocation->>'claim_id')::uuid for update;
  if not found or v_claim.status<>'open' or not public.keel_reimbursement_claim_access(p_household_id,v_claim.id,true) then raise exception 'KEEL_SCOPE_VIOLATION: claim not found' using errcode='P0006';end if;
  if v_counterparty is null then v_counterparty:=v_claim.counterparty_id;v_currency:=v_claim.currency;elsif v_counterparty<>v_claim.counterparty_id or v_currency<>v_claim.currency then raise exception 'KEEL_INVALID_COMMAND: settlement allocations must share counterparty/currency' using errcode='P0009';end if;
  select coalesce(sum(m.allocated_minor),0) into v_prior from public.settlement_matches m join public.settlements s on s.household_id=m.household_id and s.id=m.settlement_id where m.household_id=p_household_id and m.claim_id=v_claim.id and s.status='active';
  if v_prior+v_alloc>v_claim.amount_minor then raise exception 'KEEL_INVALID_COMMAND: settlement exceeds claim balance' using errcode='P0009';end if;v_total:=v_total+v_alloc;
 end loop;
 select account_id,amount_minor,currency into v_account,v_capacity,v_tx_currency from public.keel_live_real_posting(p_household_id,(p_payload->>'transaction_id')::uuid) where amount_minor>0;
 if not found or not public.keel_recurring_account_access(p_household_id,v_account,true) then raise exception 'KEEL_SCOPE_VIOLATION: settlement transaction not found' using errcode='P0006';end if;
 select v_total+coalesce(sum(total_minor) filter(where status='active'),0) into v_total from public.settlements where household_id=p_household_id and transaction_id=(p_payload->>'transaction_id')::uuid;
 if v_tx_currency<>v_currency or v_total>v_capacity then raise exception 'KEEL_INVALID_COMMAND: settlement transaction overallocated' using errcode='P0009';end if;
 insert into public.settlements(household_id,id,counterparty_id,transaction_id,total_minor,currency,status,note,created_by)
 values(p_household_id,v_settlement,v_counterparty,(p_payload->>'transaction_id')::uuid,(select sum((a->>'amount_minor')::bigint) from jsonb_array_elements(p_payload->'allocations') a),v_currency,'active',p_payload->>'note',(v_actor->>'userId')::uuid);
 for v_allocation in select value from jsonb_array_elements(p_payload->'allocations') loop insert into public.settlement_matches(household_id,settlement_id,claim_id,allocated_minor) values(p_household_id,v_settlement,(v_allocation->>'claim_id')::uuid,(v_allocation->>'amount_minor')::bigint);end loop;
 insert into public.settlement_status_events(household_id,settlement_id,transition,reason,actor,command_id) values(p_household_id,v_settlement,'created',null,v_actor,p_command_id);
 v_after:=jsonb_build_object('settlementId',v_settlement,'transactionId',p_payload->>'transaction_id','allocatedMinor',(select total_minor::text from public.settlements where household_id=p_household_id and id=v_settlement),'incomeImpactMinor','0','status','active');
 v_result:=jsonb_build_object('commandId',p_command_id,'economicEventKey',p_economic_event_key,'idempotentReplay',false,'effects',v_after,'asOf',to_char(now() at time zone'utc','YYYY-MM-DD"T"HH24:MI:SS"Z"'));
 perform public.keel_finish_command(p_command_id,'reimbursements.settle',p_economic_event_key,p_household_id,v_actor,v_hash,'reimbursements.settled','settlement',v_settlement,v_after,v_result);return v_result;
exception when unique_violation then raise exception 'KEEL_IDEMPOTENCY_CONFLICT: duplicate settlement evidence' using errcode='P0007';end;$$;

create function public.keel_reimbursement_reverse_settlement(p_command_id uuid,p_economic_event_key text,p_actor jsonb,p_household_id uuid,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_hash text:=public.keel_payload_hash(p_payload);v_replay jsonb;v_actor jsonb;v_row public.settlements%rowtype;v_before jsonb;v_after jsonb;v_result jsonb;
begin perform public.keel_assert_member_write(p_household_id);v_actor:=public.keel_actor_from_jwt();v_replay:=public.keel_idempotency_check(p_household_id,p_economic_event_key,v_hash);if v_replay is not null then return v_replay;end if;
 if jsonb_typeof(p_payload)<>'object' or (p_payload-'settlement_id'-'reason')<>'{}'::jsonb or coalesce(p_payload->>'settlement_id','')!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' or length(coalesce(p_payload->>'reason','')) not between 1 and 500 then raise exception 'KEEL_INVALID_COMMAND: invalid settlement reversal' using errcode='P0009';end if;
 select * into v_row from public.settlements where household_id=p_household_id and id=(p_payload->>'settlement_id')::uuid for update;
 if not found or v_row.status<>'active' then raise exception 'KEEL_SCOPE_VIOLATION: settlement not found' using errcode='P0006';end if;
 if exists(select 1 from public.settlement_matches m where m.household_id=p_household_id and m.settlement_id=v_row.id and not public.keel_reimbursement_claim_access(p_household_id,m.claim_id,true)) then raise exception 'KEEL_SCOPE_VIOLATION: settlement not found' using errcode='P0006';end if;
 v_before:=jsonb_build_object('settlementId',v_row.id,'status','active');update public.settlements set status='reversed',updated_at=now() where household_id=p_household_id and id=v_row.id;
 insert into public.settlement_status_events(household_id,settlement_id,transition,reason,actor,command_id) values(p_household_id,v_row.id,'reversed',p_payload->>'reason',v_actor,p_command_id);
 v_after:=jsonb_build_object('settlementId',v_row.id,'status','reversed','reason',p_payload->>'reason');v_result:=jsonb_build_object('commandId',p_command_id,'economicEventKey',p_economic_event_key,'idempotentReplay',false,'effects',v_after,'asOf',to_char(now() at time zone'utc','YYYY-MM-DD"T"HH24:MI:SS"Z"'));
 insert into public.audit_log(household_id,actor,action,object_type,object_id,command_id,before,after) values(p_household_id,v_actor,'reimbursements.reverse_settlement','settlement',v_row.id,p_command_id,v_before,v_after);
 insert into public.domain_events(event_type,household_id,command_id,economic_event_key,actor,payload) values('reimbursements.settlement_reversed',p_household_id,p_command_id,p_economic_event_key,v_actor,v_after);
 insert into public.command_executions(household_id,economic_event_key,command_id,command,payload_sha256,result) values(p_household_id,p_economic_event_key,p_command_id,'reimbursements.reverse_settlement',v_hash,v_result);return v_result;end;$$;

create function public.keel_reimbursement_reverse_claim(p_command_id uuid,p_economic_event_key text,p_actor jsonb,p_household_id uuid,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_hash text:=public.keel_payload_hash(p_payload);v_replay jsonb;v_actor jsonb;v_row public.reimbursement_claims%rowtype;v_before jsonb;v_after jsonb;v_result jsonb;
begin perform public.keel_assert_member_write(p_household_id);v_actor:=public.keel_actor_from_jwt();v_replay:=public.keel_idempotency_check(p_household_id,p_economic_event_key,v_hash);if v_replay is not null then return v_replay;end if;
 if jsonb_typeof(p_payload)<>'object' or (p_payload-'claim_id'-'reason')<>'{}'::jsonb or coalesce(p_payload->>'claim_id','')!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' or length(coalesce(p_payload->>'reason','')) not between 1 and 500 then raise exception 'KEEL_INVALID_COMMAND: invalid claim reversal' using errcode='P0009';end if;
 select * into v_row from public.reimbursement_claims where household_id=p_household_id and id=(p_payload->>'claim_id')::uuid for update;
 if not found or v_row.status<>'open' or not public.keel_reimbursement_claim_access(p_household_id,v_row.id,true) then raise exception 'KEEL_SCOPE_VIOLATION: claim not found' using errcode='P0006';end if;
 if exists(select 1 from public.settlement_matches m join public.settlements s on s.household_id=m.household_id and s.id=m.settlement_id where m.household_id=p_household_id and m.claim_id=v_row.id and s.status='active') then raise exception 'KEEL_INVALID_COMMAND: reverse active settlements first' using errcode='P0009';end if;
 v_before:=jsonb_build_object('claimId',v_row.id,'status','open');update public.reimbursement_claims set status='reversed',updated_at=now() where household_id=p_household_id and id=v_row.id;
 insert into public.reimbursement_claim_status_events(household_id,claim_id,transition,reason,actor,command_id) values(p_household_id,v_row.id,'reversed',p_payload->>'reason',v_actor,p_command_id);
 v_after:=jsonb_build_object('claimId',v_row.id,'status','reversed','reason',p_payload->>'reason');v_result:=jsonb_build_object('commandId',p_command_id,'economicEventKey',p_economic_event_key,'idempotentReplay',false,'effects',v_after,'asOf',to_char(now() at time zone'utc','YYYY-MM-DD"T"HH24:MI:SS"Z"'));
 insert into public.audit_log(household_id,actor,action,object_type,object_id,command_id,before,after) values(p_household_id,v_actor,'reimbursements.reverse_claim','reimbursement_claim',v_row.id,p_command_id,v_before,v_after);
 insert into public.domain_events(event_type,household_id,command_id,economic_event_key,actor,payload) values('reimbursements.claim_reversed',p_household_id,p_command_id,p_economic_event_key,v_actor,v_after);
 insert into public.command_executions(household_id,economic_event_key,command_id,command,payload_sha256,result) values(p_household_id,p_economic_event_key,p_command_id,'reimbursements.reverse_claim',v_hash,v_result);return v_result;end;$$;

create function public.keel_list_reimbursements(p_household_id uuid) returns jsonb language plpgsql security definer stable set search_path=public as $$
declare v_uid uuid:=coalesce(nullif(pg_catalog.current_setting('request.jwt.claim.sub',true),''),nullif(pg_catalog.current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid;v_rows jsonb;
begin if v_uid is null then raise exception 'KEEL_NOT_AUTHENTICATED' using errcode='P0004';end if;if not exists(select 1 from public.household_memberships where household_id=p_household_id and user_id=v_uid) then raise exception 'KEEL_SCOPE_VIOLATION' using errcode='P0006';end if;
 select coalesce(jsonb_agg(row.dto order by row.created_at,row.id),'[]'::jsonb) into v_rows from(select c.id,c.created_at,jsonb_build_object(
 'claimId',c.id,'counterpartyId',c.counterparty_id,'counterpartyName',cp.name,'kind',cp.kind,'originalTransactionId',c.original_transaction_id,
 'amountMinor',c.amount_minor::text,'currency',c.currency::text,'remainingMinor',case when c.status='reversed' then '0' else greatest(c.amount_minor-coalesce((select sum(m.allocated_minor) from public.settlement_matches m join public.settlements s on s.household_id=m.household_id and s.id=m.settlement_id where m.household_id=c.household_id and m.claim_id=c.id and s.status='active'),0),0)::text end,
 'status',case when c.status='reversed' then 'reversed' when coalesce((select sum(m.allocated_minor) from public.settlement_matches m join public.settlements s on s.household_id=m.household_id and s.id=m.settlement_id where m.household_id=c.household_id and m.claim_id=c.id and s.status='active'),0)>=c.amount_minor then 'settled' else 'open' end,
 'incomeImpactMinor','0','formulaVersion','claim-settlement-v1','settlements',coalesce((select jsonb_agg(jsonb_build_object('settlementId',s.id,'transactionId',s.transaction_id,'allocatedMinor',m.allocated_minor::text,'status',s.status) order by s.created_at,s.id) from public.settlement_matches m join public.settlements s on s.household_id=m.household_id and s.id=m.settlement_id where m.household_id=c.household_id and m.claim_id=c.id),'[]'::jsonb)) dto
 from public.reimbursement_claims c join public.counterparties cp on cp.household_id=c.household_id and cp.id=c.counterparty_id where c.household_id=p_household_id and public.keel_reimbursement_claim_access(p_household_id,c.id,false))row;
 return jsonb_build_object('scope',jsonb_build_object('householdId',p_household_id),'asOf',to_char(now() at time zone'utc','YYYY-MM-DD"T"HH24:MI:SS"Z"'),'formulaVersion','claim-settlement-v1','rows',v_rows);end;$$;

alter table public.counterparties enable row level security;alter table public.expense_shares enable row level security;alter table public.reimbursement_claims enable row level security;alter table public.settlements enable row level security;alter table public.settlement_matches enable row level security;alter table public.refund_expectations enable row level security;alter table public.refund_matches enable row level security;alter table public.settlement_status_events enable row level security;alter table public.reimbursement_claim_status_events enable row level security;
revoke all on public.counterparties,public.expense_shares,public.reimbursement_claims,public.settlements,public.settlement_matches,public.refund_expectations,public.refund_matches,public.settlement_status_events,public.reimbursement_claim_status_events from public,anon,authenticated;
grant select on public.counterparties,public.expense_shares,public.reimbursement_claims,public.settlements,public.settlement_matches,public.refund_expectations,public.refund_matches,public.settlement_status_events,public.reimbursement_claim_status_events to authenticated,service_role;
create policy counterparties_member_read on public.counterparties for select to authenticated using(public.keel_is_household_member(household_id));
create policy shares_claim_read on public.expense_shares for select to authenticated using(exists(select 1 from public.reimbursement_claims c where c.household_id=expense_shares.household_id and c.expense_share_id=expense_shares.id and public.keel_reimbursement_claim_access(c.household_id,c.id,false)));
create policy claims_authorized_read on public.reimbursement_claims for select to authenticated using(public.keel_reimbursement_claim_access(household_id,id,false));
create policy settlements_authorized_read on public.settlements for select to authenticated using(not exists(select 1 from public.settlement_matches m where m.household_id=settlements.household_id and m.settlement_id=settlements.id and not public.keel_reimbursement_claim_access(m.household_id,m.claim_id,false)));
create policy settlement_matches_read on public.settlement_matches for select to authenticated using(public.keel_reimbursement_claim_access(household_id,claim_id,false));
create policy refund_expectations_member_read on public.refund_expectations for select to authenticated using(public.keel_is_household_member(household_id));
create policy refund_matches_member_read on public.refund_matches for select to authenticated using(public.keel_is_household_member(household_id));
create policy settlement_events_read on public.settlement_status_events for select to authenticated using(exists(select 1 from public.settlement_matches m where m.household_id=settlement_status_events.household_id and m.settlement_id=settlement_status_events.settlement_id and public.keel_reimbursement_claim_access(m.household_id,m.claim_id,false)));
create policy claim_events_read on public.reimbursement_claim_status_events for select to authenticated using(public.keel_reimbursement_claim_access(household_id,claim_id,false));
grant select,insert,update on public.counterparties,public.reimbursement_claims,public.settlements to keel_api;grant select,insert on public.expense_shares,public.settlement_matches,public.settlement_status_events,public.reimbursement_claim_status_events to keel_api;
create policy counterparties_api_all on public.counterparties for all to keel_api using(true) with check(true);create policy shares_api_all on public.expense_shares for all to keel_api using(true) with check(true);create policy claims_api_all on public.reimbursement_claims for all to keel_api using(true) with check(true);create policy settlements_api_all on public.settlements for all to keel_api using(true) with check(true);create policy settlement_matches_api_all on public.settlement_matches for all to keel_api using(true) with check(true);create policy settlement_events_api_all on public.settlement_status_events for all to keel_api using(true) with check(true);create policy claim_events_api_all on public.reimbursement_claim_status_events for all to keel_api using(true) with check(true);

grant create on schema public to keel_api;alter function public.keel_live_real_posting(uuid,uuid) owner to keel_api;alter function public.keel_reimbursement_claim_access(uuid,uuid,boolean) owner to keel_api;alter function public.keel_is_non_income_settlement(uuid,uuid) owner to keel_api;alter function public.keel_reimbursement_create_claim(uuid,text,jsonb,uuid,jsonb) owner to keel_api;alter function public.keel_reimbursement_settle(uuid,text,jsonb,uuid,jsonb) owner to keel_api;alter function public.keel_reimbursement_reverse_settlement(uuid,text,jsonb,uuid,jsonb) owner to keel_api;alter function public.keel_reimbursement_reverse_claim(uuid,text,jsonb,uuid,jsonb) owner to keel_api;alter function public.keel_list_reimbursements(uuid) owner to keel_api;revoke create on schema public from keel_api;
revoke all on function public.keel_live_real_posting(uuid,uuid),public.keel_reimbursement_claim_access(uuid,uuid,boolean),public.keel_is_non_income_settlement(uuid,uuid) from public,anon,authenticated;grant execute on function public.keel_reimbursement_claim_access(uuid,uuid,boolean),public.keel_is_non_income_settlement(uuid,uuid) to authenticated,keel_api;
revoke all on function public.keel_reimbursement_create_claim(uuid,text,jsonb,uuid,jsonb),public.keel_reimbursement_settle(uuid,text,jsonb,uuid,jsonb),public.keel_reimbursement_reverse_settlement(uuid,text,jsonb,uuid,jsonb),public.keel_reimbursement_reverse_claim(uuid,text,jsonb,uuid,jsonb),public.keel_list_reimbursements(uuid) from public,anon;
grant execute on function public.keel_reimbursement_create_claim(uuid,text,jsonb,uuid,jsonb),public.keel_reimbursement_settle(uuid,text,jsonb,uuid,jsonb),public.keel_reimbursement_reverse_settlement(uuid,text,jsonb,uuid,jsonb),public.keel_reimbursement_reverse_claim(uuid,text,jsonb,uuid,jsonb),public.keel_list_reimbursements(uuid) to authenticated;
do $$begin if exists(select 1 from pg_roles where rolname='keel_api' and(rolcanlogin or rolbypassrls or rolsuper))then raise exception 'KEEL_OWNERSHIP: reimbursement definer privileged';end if;if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_roles r on r.oid=p.proowner where n.nspname='public' and p.proname like 'keel%reimbursement%' and p.prosecdef and r.rolname<>'keel_api')then raise exception 'KEEL_OWNERSHIP: reimbursement definer owner';end if;end$$;

grant select on public.counterparties,public.expense_shares,public.reimbursement_claims,public.settlements,public.settlement_matches,public.refund_expectations,public.refund_matches,public.settlement_status_events,public.reimbursement_claim_status_events to keel_export;
create policy counterparties_export on public.counterparties for select to keel_export using(true);create policy shares_export on public.expense_shares for select to keel_export using(true);create policy claims_export on public.reimbursement_claims for select to keel_export using(true);create policy settlements_export on public.settlements for select to keel_export using(true);create policy settlement_matches_export on public.settlement_matches for select to keel_export using(true);create policy refund_expectations_export on public.refund_expectations for select to keel_export using(true);create policy refund_matches_export on public.refund_matches for select to keel_export using(true);create policy settlement_events_export on public.settlement_status_events for select to keel_export using(true);create policy claim_events_export on public.reimbursement_claim_status_events for select to keel_export using(true);
alter function public.keel_export_household(uuid,timestamptz) rename to keel_export_household_pre_reimbursements;revoke all on function public.keel_export_household_pre_reimbursements(uuid,timestamptz) from public,anon,authenticated,service_role;
create function public.keel_export_household(p_household_id uuid,p_as_of timestamptz default null)returns jsonb language plpgsql security definer stable set search_path=pg_catalog,public as $$declare v_base jsonb;v_tables jsonb;begin v_base:=public.keel_export_household_pre_reimbursements(p_household_id,p_as_of);select jsonb_build_object(
'counterparties',coalesce((select jsonb_agg(to_jsonb(x)order by x.id)from public.counterparties x where x.household_id=p_household_id),'[]'::jsonb),
'expense_shares',coalesce((select jsonb_agg(to_jsonb(x)||jsonb_build_object('amount_minor',x.amount_minor::text)order by x.household_id,x.id)from public.expense_shares x where x.household_id=p_household_id),'[]'::jsonb),
'reimbursement_claims',coalesce((select jsonb_agg(to_jsonb(x)||jsonb_build_object('amount_minor',x.amount_minor::text)order by x.household_id,x.id)from public.reimbursement_claims x where x.household_id=p_household_id),'[]'::jsonb),
'settlements',coalesce((select jsonb_agg(to_jsonb(x)||jsonb_build_object('total_minor',x.total_minor::text)order by x.household_id,x.id)from public.settlements x where x.household_id=p_household_id),'[]'::jsonb),
'settlement_matches',coalesce((select jsonb_agg(to_jsonb(x)||jsonb_build_object('allocated_minor',x.allocated_minor::text)order by x.household_id,x.id)from public.settlement_matches x where x.household_id=p_household_id),'[]'::jsonb),
'refund_expectations',coalesce((select jsonb_agg(to_jsonb(x)||jsonb_build_object('expected_minor',x.expected_minor::text)order by x.household_id,x.id)from public.refund_expectations x where x.household_id=p_household_id),'[]'::jsonb),
'refund_matches',coalesce((select jsonb_agg(to_jsonb(x)||jsonb_build_object('allocated_minor',x.allocated_minor::text)order by x.household_id,x.id)from public.refund_matches x where x.household_id=p_household_id),'[]'::jsonb),
'settlement_status_events',coalesce((select jsonb_agg(to_jsonb(x)order by x.household_id,x.id)from public.settlement_status_events x where x.household_id=p_household_id),'[]'::jsonb),
'reimbursement_claim_status_events',coalesce((select jsonb_agg(to_jsonb(x)order by x.household_id,x.id)from public.reimbursement_claim_status_events x where x.household_id=p_household_id),'[]'::jsonb))into v_tables;return jsonb_set(v_base,'{tables}',v_base->'tables'||v_tables);end$$;
revoke all on function public.keel_export_household(uuid,timestamptz)from public,anon,authenticated,service_role;grant create on schema public to keel_export;alter function public.keel_export_household(uuid,timestamptz)owner to keel_export;revoke create on schema public from keel_export;grant execute on function public.keel_export_household(uuid,timestamptz)to service_role;
