-- Stage 1D paycheck decomposition (BC-v2.1 gate 6 / mandatory gate §6).
-- User-authored facts only: no payroll execution and no AI/model arithmetic.

create type public.paycheck_status as enum ('active','reversed');
create type public.paycheck_transition as enum ('created','reversed','restored');
create type public.paycheck_component_kind as enum (
  'gross_salary','bonus','commission','reimbursement',
  'federal_withholding','state_withholding','local_withholding','fica_withholding',
  'benefit','retirement_401k','employer_match','hsa','fsa','espp',
  'rsu_withholding','garnishment','direct_deposit'
);
create type public.paycheck_source_kind as enum ('manual','paystub','payroll_provider');

create table public.employers (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id),
  name text not null check (length(name) between 1 and 200),
  created_at timestamptz not null default now(),
  unique (household_id,id), unique (household_id,name)
);

create table public.payroll_provider_imports (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id),
  provider text not null check (length(provider) between 1 and 100),
  source_ref text not null check (length(source_ref) between 1 and 500),
  content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
  imported_at timestamptz not null default now(),
  unique (household_id,id), unique (household_id,provider,source_ref,content_hash)
);

create table public.paychecks (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id),
  employer_id uuid not null,
  pay_date date not null,
  gross_minor bigint not null check (gross_minor >= 0),
  net_minor bigint not null check (net_minor >= 0),
  currency char(3) not null check (currency=upper(currency)),
  status public.paycheck_status not null,
  formula_version text not null check (length(formula_version) between 1 and 100),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (household_id,id),
  constraint fk_paycheck_employer_tenant foreign key (household_id,employer_id)
    references public.employers(household_id,id) on delete restrict
);

create table public.paycheck_components (
  household_id uuid not null references public.households(id),
  id uuid not null default gen_random_uuid(),
  paycheck_id uuid not null,
  component_key text not null check (length(component_key) between 1 and 100),
  kind public.paycheck_component_kind not null,
  amount_minor bigint not null check (amount_minor >= 0),
  created_at timestamptz not null default now(),
  primary key (household_id,id), unique (household_id,paycheck_id,component_key),
  constraint fk_paycheck_component_tenant foreign key (household_id,paycheck_id)
    references public.paychecks(household_id,id) on delete restrict
);

create table public.paycheck_templates (
  household_id uuid not null references public.households(id),
  id uuid not null default gen_random_uuid(),
  employer_id uuid not null,
  template_version integer not null check (template_version > 0),
  component_blueprint jsonb not null check (jsonb_typeof(component_blueprint)='array'),
  formula_version text not null,
  created_at timestamptz not null default now(),
  primary key (household_id,id), unique (household_id,employer_id,template_version),
  constraint fk_paycheck_template_employer_tenant foreign key (household_id,employer_id)
    references public.employers(household_id,id) on delete restrict
);

create table public.paycheck_sources (
  household_id uuid not null references public.households(id),
  id uuid not null default gen_random_uuid(),
  paycheck_id uuid not null,
  source_kind public.paycheck_source_kind not null,
  source_ref text not null check (length(source_ref) between 1 and 500),
  content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
  payroll_provider_import_id uuid,
  created_at timestamptz not null default now(),
  primary key (household_id,id), unique (household_id,source_kind,source_ref,content_hash),
  constraint fk_paycheck_source_paycheck_tenant foreign key (household_id,paycheck_id)
    references public.paychecks(household_id,id) on delete restrict,
  constraint fk_paycheck_source_import_tenant foreign key (household_id,payroll_provider_import_id)
    references public.payroll_provider_imports(household_id,id) on delete restrict
);

create table public.paycheck_transaction_matches (
  household_id uuid not null references public.households(id),
  id uuid not null default gen_random_uuid(),
  paycheck_id uuid not null,
  component_id uuid not null,
  transaction_id uuid not null,
  allocated_minor bigint not null check (allocated_minor >= 0),
  created_at timestamptz not null default now(),
  primary key (household_id,id),
  unique (household_id,paycheck_id,component_id,transaction_id),
  constraint fk_paycheck_match_paycheck_tenant foreign key (household_id,paycheck_id)
    references public.paychecks(household_id,id) on delete restrict,
  constraint fk_paycheck_match_component_tenant foreign key (household_id,component_id)
    references public.paycheck_components(household_id,id) on delete restrict,
  constraint fk_paycheck_match_transaction_tenant foreign key (household_id,transaction_id)
    references public.canonical_transactions(household_id,id) on delete restrict
);

create table public.paycheck_status_events (
  household_id uuid not null references public.households(id),
  id uuid not null default gen_random_uuid(),
  paycheck_id uuid not null,
  transition public.paycheck_transition not null,
  reason text check (reason is null or length(reason) between 1 and 500),
  actor jsonb not null,
  command_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (household_id,id), unique (household_id,paycheck_id,command_id),
  constraint fk_paycheck_status_tenant foreign key (household_id,paycheck_id)
    references public.paychecks(household_id,id) on delete restrict
);

create trigger payroll_provider_imports_immutable before update or delete on public.payroll_provider_imports
  for each row execute function public.keel_forbid_mutation();
create trigger paycheck_components_immutable before update or delete on public.paycheck_components
  for each row execute function public.keel_forbid_mutation();
create trigger paycheck_templates_immutable before update or delete on public.paycheck_templates
  for each row execute function public.keel_forbid_mutation();
create trigger paycheck_sources_immutable before update or delete on public.paycheck_sources
  for each row execute function public.keel_forbid_mutation();
create trigger paycheck_matches_immutable before update or delete on public.paycheck_transaction_matches
  for each row execute function public.keel_forbid_mutation();
create trigger paycheck_status_events_immutable before update or delete on public.paycheck_status_events
  for each row execute function public.keel_forbid_mutation();

create function public.keel_paycheck_access(p_household_id uuid,p_paycheck_id uuid,p_write boolean)
returns boolean language sql security definer stable set search_path=public as $$
  select exists (
    select 1 from public.household_memberships m
    where m.household_id=p_household_id and m.user_id=coalesce(
      nullif(pg_catalog.current_setting('request.jwt.claim.sub',true),''),
      nullif(pg_catalog.current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid
      and (not p_write or m.role in ('owner','partner'))
  ) and exists (select 1 from public.paychecks p where p.household_id=p_household_id and p.id=p_paycheck_id)
  and not exists (
    select 1 from public.paycheck_transaction_matches pm
    join public.canonical_transactions t on t.household_id=pm.household_id and t.id=pm.transaction_id
    where pm.household_id=p_household_id and pm.paycheck_id=p_paycheck_id
      and not public.keel_recurring_account_access(p_household_id,t.account_id,p_write)
  );
$$;

create function public.keel_paycheck_create(
  p_command_id uuid,p_economic_event_key text,p_actor jsonb,p_household_id uuid,p_payload jsonb
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_hash text:=public.keel_payload_hash(p_payload); v_replay jsonb; v_actor jsonb;
  v_employer_id uuid; v_paycheck_id uuid:=gen_random_uuid(); v_component jsonb; v_match jsonb;
  v_component_id uuid; v_gross bigint; v_net bigint; v_gross_sum bigint; v_additions bigint;
  v_deductions bigint; v_deposits bigint; v_allocated bigint; v_capacity bigint; v_account_id uuid;
  v_result jsonb; v_after jsonb; v_source jsonb:=p_payload->'source';
begin
  perform public.keel_assert_member_write(p_household_id); v_actor:=public.keel_actor_from_jwt();
  v_replay:=public.keel_idempotency_check(p_household_id,p_economic_event_key,v_hash);
  if v_replay is not null then return v_replay; end if;
  if jsonb_typeof(p_payload)<>'object' or jsonb_typeof(p_payload->'components')<>'array'
    or jsonb_array_length(p_payload->'components')<2 or jsonb_array_length(p_payload->'components')>100
    or jsonb_typeof(p_payload->'matches')<>'array' or jsonb_array_length(p_payload->'matches')<1
    or jsonb_array_length(p_payload->'matches')>100 or jsonb_typeof(v_source)<>'object'
    or (p_payload-'employer_name'-'pay_date'-'gross_minor'-'net_minor'-'currency'-'components'-'matches'-'source')<>'{}'::jsonb
  then raise exception 'KEEL_INVALID_COMMAND: malformed paycheck payload' using errcode='P0009'; end if;
  if coalesce(p_payload->>'employer_name','')='' or length(p_payload->>'employer_name')>200
    or coalesce(p_payload->>'currency','') !~ '^[A-Z]{3}$'
    or coalesce(p_payload->>'gross_minor','') !~ '^(0|[1-9][0-9]*)$'
    or coalesce(p_payload->>'net_minor','') !~ '^(0|[1-9][0-9]*)$'
    or coalesce(v_source->>'kind','') not in ('manual','paystub','payroll_provider')
    or coalesce(v_source->>'ref','')='' or length(v_source->>'ref')>500
    or coalesce(v_source->>'content_hash','') !~ '^[a-f0-9]{64}$'
    or (v_source-'kind'-'ref'-'content_hash')<>'{}'::jsonb
  then raise exception 'KEEL_INVALID_COMMAND: paycheck scalar fields invalid' using errcode='P0009'; end if;
  if exists(select 1 from public.paycheck_sources where household_id=p_household_id
    and source_kind=(v_source->>'kind')::public.paycheck_source_kind and source_ref=v_source->>'ref'
    and content_hash=v_source->>'content_hash')
  then raise exception 'KEEL_IDEMPOTENCY_CONFLICT: paycheck source already recorded' using errcode='P0007'; end if;
  begin
    if coalesce(p_payload->>'pay_date','') !~ '^\d{4}-\d{2}-\d{2}$'
      or to_char((p_payload->>'pay_date')::date,'YYYY-MM-DD')<>p_payload->>'pay_date'
    then raise exception 'bad date'; end if;
    v_gross:=(p_payload->>'gross_minor')::bigint; v_net:=(p_payload->>'net_minor')::bigint;
  exception when others then raise exception 'KEEL_INVALID_COMMAND: paycheck date/money invalid' using errcode='P0009'; end;
  if exists (select 1 from jsonb_array_elements(p_payload->'components') c
    where jsonb_typeof(c)<>'object' or (c-'key'-'kind'-'amount_minor')<>'{}'::jsonb
      or coalesce(c->>'key','')='' or length(c->>'key')>100
      or coalesce(c->>'amount_minor','') !~ '^(0|[1-9][0-9]*)$'
      or coalesce(c->>'kind','') not in ('gross_salary','bonus','commission','reimbursement','federal_withholding','state_withholding','local_withholding','fica_withholding','benefit','retirement_401k','employer_match','hsa','fsa','espp','rsu_withholding','garnishment','direct_deposit'))
    or (select count(*)<>count(distinct c->>'key') from jsonb_array_elements(p_payload->'components') c)
  then raise exception 'KEEL_INVALID_COMMAND: paycheck components invalid' using errcode='P0009'; end if;
  select coalesce(sum((c->>'amount_minor')::bigint) filter(where c->>'kind' in ('gross_salary','bonus','commission')),0),
    coalesce(sum((c->>'amount_minor')::bigint) filter(where c->>'kind'='reimbursement'),0),
    coalesce(sum((c->>'amount_minor')::bigint) filter(where c->>'kind' in ('federal_withholding','state_withholding','local_withholding','fica_withholding','benefit','retirement_401k','hsa','fsa','espp','rsu_withholding','garnishment')),0),
    coalesce(sum((c->>'amount_minor')::bigint) filter(where c->>'kind'='direct_deposit'),0)
    into v_gross_sum,v_additions,v_deductions,v_deposits from jsonb_array_elements(p_payload->'components') c;
  if v_gross_sum<>v_gross or v_gross_sum+v_additions-v_deductions<>v_net or v_deposits<>v_net
  then raise exception 'KEEL_INVALID_COMMAND: paycheck gross/net/direct deposits do not reconcile' using errcode='P0009'; end if;
  if exists (select 1 from jsonb_array_elements(p_payload->'matches') m
    where jsonb_typeof(m)<>'object' or (m-'transaction_id'-'component_key'-'amount_minor')<>'{}'::jsonb
      or coalesce(m->>'transaction_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or coalesce(m->>'amount_minor','') !~ '^(0|[1-9][0-9]*)$'
      or not exists (select 1 from jsonb_array_elements(p_payload->'components') c
        where c->>'key'=m->>'component_key' and c->>'kind' in ('retirement_401k','employer_match','hsa','fsa','espp','direct_deposit')))
  then raise exception 'KEEL_INVALID_COMMAND: paycheck matches invalid' using errcode='P0009'; end if;
  if (select count(*)<>count(distinct (m->>'transaction_id',m->>'component_key'))
      from jsonb_array_elements(p_payload->'matches') m)
  then raise exception 'KEEL_INVALID_COMMAND: duplicate paycheck match' using errcode='P0009'; end if;
  if exists (select 1 from jsonb_array_elements(p_payload->'components') c
    where c->>'kind' in ('retirement_401k','employer_match','hsa','fsa','espp','direct_deposit')
      and (c->>'amount_minor')::bigint<>(select coalesce(sum((m->>'amount_minor')::bigint),0)
        from jsonb_array_elements(p_payload->'matches') m where m->>'component_key'=c->>'key'))
  then raise exception 'KEEL_INVALID_COMMAND: destination component is not fully matched' using errcode='P0009'; end if;
  for v_match in select value from jsonb_array_elements(p_payload->'matches') loop
    select t.account_id,abs(asset.amount_minor) into v_account_id,v_capacity
    from public.canonical_transactions t join public.accounts a on a.household_id=t.household_id and a.id=t.account_id
    join lateral (select b.id from public.journal_batches b where b.household_id=t.household_id
      and b.canonical_transaction_id=t.id and b.reverses_batch_id is null
      and not exists(select 1 from public.journal_revisions r where r.original_batch_id=b.id)
      order by b.posted_at desc,b.id desc limit 1) live on true
    join public.journal_postings asset on asset.batch_id=live.id and asset.ledger_account_id=a.ledger_account_id
    where t.household_id=p_household_id and t.id=(v_match->>'transaction_id')::uuid
      and t.status in ('posted','reviewed') and t.voided_at is null and asset.currency=p_payload->>'currency'
      and asset.amount_minor>0 and (select count(*) from public.journal_postings jp
        join public.accounts real on real.household_id=t.household_id and real.ledger_account_id=jp.ledger_account_id
        where jp.batch_id=live.id)=1;
    if not found or not public.keel_recurring_account_access(p_household_id,v_account_id,true)
    then raise exception 'KEEL_SCOPE_VIOLATION: paycheck destination not found' using errcode='P0006'; end if;
    select sum((m->>'amount_minor')::bigint) into v_allocated from jsonb_array_elements(p_payload->'matches') m
      where m->>'transaction_id'=v_match->>'transaction_id';
    select v_allocated+coalesce(sum(existing.allocated_minor),0) into v_allocated
      from public.paycheck_transaction_matches existing
      where existing.household_id=p_household_id and existing.transaction_id=(v_match->>'transaction_id')::uuid;
    if v_allocated>v_capacity then raise exception 'KEEL_INVALID_COMMAND: destination overallocated' using errcode='P0009'; end if;
  end loop;
  insert into public.employers(household_id,name) values(p_household_id,p_payload->>'employer_name')
    on conflict(household_id,name) do nothing returning id into v_employer_id;
  if v_employer_id is null then select id into v_employer_id from public.employers
    where household_id=p_household_id and name=p_payload->>'employer_name'; end if;
  insert into public.paychecks(id,household_id,employer_id,pay_date,gross_minor,net_minor,currency,status,formula_version,created_by)
    values(v_paycheck_id,p_household_id,v_employer_id,(p_payload->>'pay_date')::date,v_gross,v_net,p_payload->>'currency','active','paycheck-reconciliation-v1',(v_actor->>'userId')::uuid);
  for v_component in select value from jsonb_array_elements(p_payload->'components') loop
    insert into public.paycheck_components(household_id,paycheck_id,component_key,kind,amount_minor)
      values(p_household_id,v_paycheck_id,v_component->>'key',(v_component->>'kind')::public.paycheck_component_kind,(v_component->>'amount_minor')::bigint);
  end loop;
  insert into public.paycheck_sources(household_id,paycheck_id,source_kind,source_ref,content_hash)
    values(p_household_id,v_paycheck_id,(v_source->>'kind')::public.paycheck_source_kind,v_source->>'ref',v_source->>'content_hash');
  for v_match in select value from jsonb_array_elements(p_payload->'matches') loop
    select id into v_component_id from public.paycheck_components where household_id=p_household_id
      and paycheck_id=v_paycheck_id and component_key=v_match->>'component_key';
    insert into public.paycheck_transaction_matches(household_id,paycheck_id,component_id,transaction_id,allocated_minor)
      values(p_household_id,v_paycheck_id,v_component_id,(v_match->>'transaction_id')::uuid,(v_match->>'amount_minor')::bigint);
  end loop;
  insert into public.paycheck_status_events(household_id,paycheck_id,transition,reason,actor,command_id)
    values(p_household_id,v_paycheck_id,'created',null,v_actor,p_command_id);
  v_after:=jsonb_build_object('paycheckId',v_paycheck_id,'status','active','grossMinor',v_gross::text,'netMinor',v_net::text,'currency',p_payload->>'currency','formulaVersion','paycheck-reconciliation-v1');
  v_result:=jsonb_build_object('commandId',p_command_id,'economicEventKey',p_economic_event_key,'idempotentReplay',false,'effects',v_after,'asOf',to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS"Z"'));
  perform public.keel_finish_command(p_command_id,'paychecks.create',p_economic_event_key,p_household_id,v_actor,v_hash,'paychecks.created','paycheck',v_paycheck_id,v_after,v_result);
  return v_result;
exception
  when numeric_value_out_of_range then raise exception 'KEEL_INVALID_COMMAND: paycheck money outside bigint' using errcode='P0009';
  when unique_violation then raise exception 'KEEL_IDEMPOTENCY_CONFLICT: duplicate paycheck economic evidence' using errcode='P0007';
end; $$;

create function public.keel_paycheck_transition_core(
  p_command_id uuid,p_economic_event_key text,p_actor jsonb,p_household_id uuid,p_payload jsonb,p_transition public.paycheck_transition
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_hash text:=public.keel_payload_hash(p_payload); v_replay jsonb; v_actor jsonb; v_row public.paychecks%rowtype;
  v_before jsonb; v_after jsonb; v_result jsonb; v_status public.paycheck_status; v_command text;
begin
  perform public.keel_assert_member_write(p_household_id); v_actor:=public.keel_actor_from_jwt();
  v_replay:=public.keel_idempotency_check(p_household_id,p_economic_event_key,v_hash); if v_replay is not null then return v_replay; end if;
  if jsonb_typeof(p_payload)<>'object' or (p_payload-'paycheck_id'-'reason')<>'{}'::jsonb
    or coalesce(p_payload->>'paycheck_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or length(coalesce(p_payload->>'reason','')) not between 1 and 500
  then raise exception 'KEEL_INVALID_COMMAND: malformed paycheck transition' using errcode='P0009'; end if;
  select * into v_row from public.paychecks where household_id=p_household_id and id=(p_payload->>'paycheck_id')::uuid for update;
  if not found or not public.keel_paycheck_access(p_household_id,v_row.id,true)
  then raise exception 'KEEL_SCOPE_VIOLATION: paycheck not found' using errcode='P0006'; end if;
  if (p_transition='reversed' and v_row.status<>'active') or (p_transition='restored' and v_row.status<>'reversed')
  then raise exception 'KEEL_INVALID_COMMAND: invalid paycheck transition' using errcode='P0009'; end if;
  v_status:=case when p_transition='reversed' then 'reversed'::public.paycheck_status else 'active'::public.paycheck_status end;
  v_command:=case when p_transition='reversed' then 'paychecks.reverse' else 'paychecks.restore' end;
  v_before:=jsonb_build_object('paycheckId',v_row.id,'status',v_row.status);
  insert into public.paycheck_status_events(household_id,paycheck_id,transition,reason,actor,command_id)
    values(p_household_id,v_row.id,p_transition,p_payload->>'reason',v_actor,p_command_id);
  update public.paychecks set status=v_status,updated_at=now() where household_id=p_household_id and id=v_row.id;
  v_after:=jsonb_build_object('paycheckId',v_row.id,'status',v_status,'reason',p_payload->>'reason');
  v_result:=jsonb_build_object('commandId',p_command_id,'economicEventKey',p_economic_event_key,'idempotentReplay',false,'effects',v_after,'asOf',to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS"Z"'));
  insert into public.audit_log(household_id,actor,action,object_type,object_id,command_id,before,after)
    values(p_household_id,v_actor,v_command,'paycheck',v_row.id,p_command_id,v_before,v_after);
  insert into public.domain_events(event_type,household_id,command_id,economic_event_key,actor,payload)
    values('paychecks.'||p_transition::text,p_household_id,p_command_id,p_economic_event_key,v_actor,v_after);
  insert into public.command_executions(household_id,economic_event_key,command_id,command,payload_sha256,result)
    values(p_household_id,p_economic_event_key,p_command_id,v_command,v_hash,v_result);
  return v_result;
end; $$;

create function public.keel_paycheck_reverse(p_command_id uuid,p_economic_event_key text,p_actor jsonb,p_household_id uuid,p_payload jsonb)
returns jsonb language sql security definer set search_path=public as $$select public.keel_paycheck_transition_core($1,$2,$3,$4,$5,'reversed')$$;
create function public.keel_paycheck_restore(p_command_id uuid,p_economic_event_key text,p_actor jsonb,p_household_id uuid,p_payload jsonb)
returns jsonb language sql security definer set search_path=public as $$select public.keel_paycheck_transition_core($1,$2,$3,$4,$5,'restored')$$;

create function public.keel_list_paychecks(p_household_id uuid) returns jsonb language plpgsql security definer stable set search_path=public as $$
declare v_uid uuid:=coalesce(nullif(pg_catalog.current_setting('request.jwt.claim.sub',true),''),nullif(pg_catalog.current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid; v_rows jsonb;
begin
  if v_uid is null then raise exception 'KEEL_NOT_AUTHENTICATED' using errcode='P0004'; end if;
  if not exists(select 1 from public.household_memberships where household_id=p_household_id and user_id=v_uid)
  then raise exception 'KEEL_SCOPE_VIOLATION' using errcode='P0006'; end if;
  select coalesce(jsonb_agg(row.dto order by row.pay_date desc,row.id),'[]'::jsonb) into v_rows from (
    select p.id,p.pay_date,jsonb_build_object('paycheckId',p.id,'employerId',p.employer_id,'employerName',e.name,
      'payDate',to_char(p.pay_date,'YYYY-MM-DD'),'grossMinor',p.gross_minor::text,'netMinor',p.net_minor::text,
      'currency',p.currency::text,'status',p.status,'formulaVersion',p.formula_version,
      'components',coalesce((select jsonb_agg(jsonb_build_object('componentId',c.id,'key',c.component_key,'kind',c.kind,'amountMinor',c.amount_minor::text) order by c.component_key)
        from public.paycheck_components c where c.household_id=p.household_id and c.paycheck_id=p.id),'[]'::jsonb),
      'matches',coalesce((select jsonb_agg(jsonb_build_object('matchId',m.id,'componentId',m.component_id,'transactionId',m.transaction_id,'allocatedMinor',m.allocated_minor::text) order by m.id)
        from public.paycheck_transaction_matches m where m.household_id=p.household_id and m.paycheck_id=p.id),'[]'::jsonb),
      'sources',coalesce((select jsonb_agg(jsonb_build_object('sourceId',s.id,'kind',s.source_kind,'ref',s.source_ref,'contentHash',s.content_hash) order by s.id)
        from public.paycheck_sources s where s.household_id=p.household_id and s.paycheck_id=p.id),'[]'::jsonb),
      'statusEvents',coalesce((select jsonb_agg(jsonb_build_object('transition',se.transition,'reason',se.reason,'commandId',se.command_id,'createdAt',to_char(se.created_at at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) order by se.created_at,se.command_id)
        from public.paycheck_status_events se where se.household_id=p.household_id and se.paycheck_id=p.id),'[]'::jsonb)) dto
    from public.paychecks p join public.employers e on e.household_id=p.household_id and e.id=p.employer_id
    where p.household_id=p_household_id and public.keel_paycheck_access(p_household_id,p.id,false)
  ) row;
  return jsonb_build_object('scope',jsonb_build_object('householdId',p_household_id),'asOf',to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS"Z"'),'formulaVersion','paycheck-reconciliation-v1','rows',v_rows);
end; $$;

alter table public.employers enable row level security; alter table public.payroll_provider_imports enable row level security;
alter table public.paychecks enable row level security; alter table public.paycheck_components enable row level security;
alter table public.paycheck_templates enable row level security; alter table public.paycheck_sources enable row level security;
alter table public.paycheck_transaction_matches enable row level security; alter table public.paycheck_status_events enable row level security;
revoke all on public.employers,public.payroll_provider_imports,public.paychecks,public.paycheck_components,public.paycheck_templates,public.paycheck_sources,public.paycheck_transaction_matches,public.paycheck_status_events from public,anon,authenticated;
grant select on public.employers,public.paychecks,public.paycheck_components,public.paycheck_templates,public.paycheck_sources,public.paycheck_transaction_matches,public.paycheck_status_events to authenticated;
grant select on public.employers,public.payroll_provider_imports,public.paychecks,public.paycheck_components,public.paycheck_templates,public.paycheck_sources,public.paycheck_transaction_matches,public.paycheck_status_events to service_role;
create policy employers_member_read on public.employers for select to authenticated using(public.keel_is_household_member(household_id));
create policy paychecks_authorized_read on public.paychecks for select to authenticated using(public.keel_paycheck_access(household_id,id,false));
create policy paycheck_components_read on public.paycheck_components for select to authenticated using(public.keel_paycheck_access(household_id,paycheck_id,false));
create policy paycheck_templates_member_read on public.paycheck_templates for select to authenticated using(public.keel_is_household_member(household_id));
create policy paycheck_sources_read on public.paycheck_sources for select to authenticated using(public.keel_paycheck_access(household_id,paycheck_id,false));
create policy paycheck_matches_read on public.paycheck_transaction_matches for select to authenticated using(public.keel_paycheck_access(household_id,paycheck_id,false));
create policy paycheck_status_read on public.paycheck_status_events for select to authenticated using(public.keel_paycheck_access(household_id,paycheck_id,false));
grant select,insert,update on public.employers,public.paychecks to keel_api; grant select,insert on public.paycheck_components,public.paycheck_sources,public.paycheck_transaction_matches,public.paycheck_status_events to keel_api;
create policy employers_api_all on public.employers for all to keel_api using(true) with check(true);
create policy paychecks_api_all on public.paychecks for all to keel_api using(true) with check(true);
create policy paycheck_components_api_all on public.paycheck_components for all to keel_api using(true) with check(true);
create policy paycheck_sources_api_all on public.paycheck_sources for all to keel_api using(true) with check(true);
create policy paycheck_matches_api_all on public.paycheck_transaction_matches for all to keel_api using(true) with check(true);
create policy paycheck_status_api_all on public.paycheck_status_events for all to keel_api using(true) with check(true);

grant create on schema public to keel_api;
alter function public.keel_paycheck_access(uuid,uuid,boolean) owner to keel_api;
alter function public.keel_paycheck_create(uuid,text,jsonb,uuid,jsonb) owner to keel_api;
alter function public.keel_paycheck_transition_core(uuid,text,jsonb,uuid,jsonb,public.paycheck_transition) owner to keel_api;
alter function public.keel_paycheck_reverse(uuid,text,jsonb,uuid,jsonb) owner to keel_api;
alter function public.keel_paycheck_restore(uuid,text,jsonb,uuid,jsonb) owner to keel_api;
alter function public.keel_list_paychecks(uuid) owner to keel_api; revoke create on schema public from keel_api;
revoke all on function public.keel_paycheck_access(uuid,uuid,boolean),public.keel_paycheck_transition_core(uuid,text,jsonb,uuid,jsonb,public.paycheck_transition) from public,anon,authenticated;
grant execute on function public.keel_paycheck_access(uuid,uuid,boolean) to authenticated,keel_api;
revoke all on function public.keel_paycheck_create(uuid,text,jsonb,uuid,jsonb),public.keel_paycheck_reverse(uuid,text,jsonb,uuid,jsonb),public.keel_paycheck_restore(uuid,text,jsonb,uuid,jsonb),public.keel_list_paychecks(uuid) from public,anon;
grant execute on function public.keel_paycheck_create(uuid,text,jsonb,uuid,jsonb),public.keel_paycheck_reverse(uuid,text,jsonb,uuid,jsonb),public.keel_paycheck_restore(uuid,text,jsonb,uuid,jsonb),public.keel_list_paychecks(uuid) to authenticated;

do $$begin
  if exists(select 1 from pg_roles where rolname='keel_api' and (rolcanlogin or rolbypassrls or rolsuper)) then raise exception 'KEEL_OWNERSHIP: paycheck definer privileged'; end if;
  if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_roles r on r.oid=p.proowner where n.nspname='public' and p.proname like 'keel%paycheck%' and p.prosecdef and r.rolname<>'keel_api') then raise exception 'KEEL_OWNERSHIP: paycheck definer owner'; end if;
end$$;

-- Durable paycheck history is part of the Data Access Guarantee.
grant select on public.employers,public.payroll_provider_imports,public.paychecks,public.paycheck_components,public.paycheck_templates,public.paycheck_sources,public.paycheck_transaction_matches,public.paycheck_status_events to keel_export;
create policy employers_export on public.employers for select to keel_export using(true);
create policy payroll_imports_export on public.payroll_provider_imports for select to keel_export using(true);
create policy paychecks_export on public.paychecks for select to keel_export using(true);
create policy paycheck_components_export on public.paycheck_components for select to keel_export using(true);
create policy paycheck_templates_export on public.paycheck_templates for select to keel_export using(true);
create policy paycheck_sources_export on public.paycheck_sources for select to keel_export using(true);
create policy paycheck_matches_export on public.paycheck_transaction_matches for select to keel_export using(true);
create policy paycheck_status_export on public.paycheck_status_events for select to keel_export using(true);
alter function public.keel_export_household(uuid,timestamptz) rename to keel_export_household_pre_paychecks;
revoke all on function public.keel_export_household_pre_paychecks(uuid,timestamptz) from public,anon,authenticated,service_role;
create function public.keel_export_household(p_household_id uuid,p_as_of timestamptz default null) returns jsonb language plpgsql security definer stable set search_path=pg_catalog,public as $$
declare v_base jsonb; v_tables jsonb; begin
  v_base:=public.keel_export_household_pre_paychecks(p_household_id,p_as_of);
  select jsonb_build_object(
    'employers',coalesce((select jsonb_agg(to_jsonb(x) order by x.id) from public.employers x where x.household_id=p_household_id),'[]'::jsonb),
    'payroll_provider_imports',coalesce((select jsonb_agg(to_jsonb(x) order by x.id) from public.payroll_provider_imports x where x.household_id=p_household_id),'[]'::jsonb),
    'paychecks',coalesce((select jsonb_agg(to_jsonb(x)||jsonb_build_object('gross_minor',x.gross_minor::text,'net_minor',x.net_minor::text) order by x.id) from public.paychecks x where x.household_id=p_household_id),'[]'::jsonb),
    'paycheck_components',coalesce((select jsonb_agg(to_jsonb(x)||jsonb_build_object('amount_minor',x.amount_minor::text) order by x.household_id,x.id) from public.paycheck_components x where x.household_id=p_household_id),'[]'::jsonb),
    'paycheck_templates',coalesce((select jsonb_agg(to_jsonb(x) order by x.household_id,x.id) from public.paycheck_templates x where x.household_id=p_household_id),'[]'::jsonb),
    'paycheck_sources',coalesce((select jsonb_agg(to_jsonb(x) order by x.household_id,x.id) from public.paycheck_sources x where x.household_id=p_household_id),'[]'::jsonb),
    'paycheck_transaction_matches',coalesce((select jsonb_agg(to_jsonb(x)||jsonb_build_object('allocated_minor',x.allocated_minor::text) order by x.household_id,x.id) from public.paycheck_transaction_matches x where x.household_id=p_household_id),'[]'::jsonb),
    'paycheck_status_events',coalesce((select jsonb_agg(to_jsonb(x) order by x.household_id,x.id) from public.paycheck_status_events x where x.household_id=p_household_id),'[]'::jsonb)
  ) into v_tables; return jsonb_set(v_base,'{tables}',v_base->'tables'||v_tables);
end$$;
revoke all on function public.keel_export_household(uuid,timestamptz) from public,anon,authenticated,service_role;
grant create on schema public to keel_export; alter function public.keel_export_household(uuid,timestamptz) owner to keel_export; revoke create on schema public from keel_export;
grant execute on function public.keel_export_household(uuid,timestamptz) to service_role;
