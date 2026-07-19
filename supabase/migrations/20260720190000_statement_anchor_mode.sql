-- SLICE 3 (statement-ingestion-v2.md §5 second migration) [A6] — statement
-- balance_check mode (strict | anchor) + the empty-array NULL-bypass fix on the
-- shared keel_statement_validate_and_materialize.
--
-- The v1 shared helper computed `select sum(...) into v_sum` with NO coalesce and
-- checked `v_open + v_sum <> v_end`. If the lines array were ever empty, sum() is
-- NULL, `v_open + NULL <> v_end` is NULL (never true), and the reconcile check
-- SILENTLY PASSES — a zero-line statement with any opening/ending would slip
-- through. Today that array is blocked at min1, but Slice 3 must accept zero-line
-- statements (investment/valuation anchor statements have no per-line ledger),
-- so the NULL bypass would become reachable. This migration:
--   * kills the bypass: coalesce(sum(...),0) — an empty array contributes 0, and
--     strict enforcement then requires opening == ending for a zero-line
--     statement (a real invariant, not a silent pass);
--   * adds balance_check ('strict' | 'anchor'): STRICT enforces opening+Σ=ending
--     for every statement; ANCHOR is permitted ONLY for investment/valuation
--     account subtypes, carries a typed anchor_reason + a stored
--     anchor_gap_explanation, and records the balances WITHOUT requiring the sum
--     identity (a brokerage statement's ending is a mark-to-market valuation, not
--     opening plus a line sum — BC-v2.1 §179 provenance / gate 8);
--   * relaxes CreateStatement lines min1->min0 and CloseReconciliation items
--     min1->min0 (contract side, in this PR) so anchor/zero-line statements are
--     expressible. The manual keel_statement_create path is otherwise unchanged.
--
-- Contract amendment (NOTES.md, this PR): lines/items min1->min0 for the
-- anchor/zero-line case; balance_check enum added to the statement body. Cites
-- BC-v2.1 §179 (reproducible numbers: a valuation-anchored ending stores its
-- provenance) + gate 8 (statement/reconciliation semantics unchanged for the
-- strict per-line path).

-- ===========================================================================
-- statements.balance_check + anchor provenance columns.
-- ===========================================================================
create type public.statement_balance_check as enum ('strict', 'anchor');
create type public.statement_anchor_reason as enum ('investment_valuation', 'market_value', 'no_transaction_detail');

alter table public.statements
  add column balance_check public.statement_balance_check not null default 'strict',
  add column anchor_reason public.statement_anchor_reason,
  add column anchor_gap_explanation text
    check (anchor_gap_explanation is null or char_length(anchor_gap_explanation) between 1 and 1000);

-- Integrity: anchor statements MUST carry a typed reason + a stored gap
-- explanation (gate-8 provenance); strict statements MUST NOT.
alter table public.statements
  add constraint statements_anchor_provenance check (
    (balance_check = 'anchor' and anchor_reason is not null and anchor_gap_explanation is not null)
    or (balance_check = 'strict' and anchor_reason is null and anchor_gap_explanation is null)
  );

-- ===========================================================================
-- Amend the SHARED keel_statement_validate_and_materialize (Law 7: one
-- authorization compiler — both manual create AND draft approval call THIS). The
-- body is the shipped one from 20260720100000 with three changes, marked inline:
--   [1] accept balance_check in the payload envelope + lines min1 -> min0;
--   [2] coalesce(sum(...),0) — kill the empty-array NULL bypass;
--   [3] branch on balance_check: strict -> enforce opening+Σ=ending; anchor ->
--       require investment/valuation subtype + typed reason + gap, DON'T enforce
--       the sum identity, and persist the anchor provenance columns.
-- ===========================================================================
create or replace function public.keel_statement_validate_and_materialize(
  p_household_id uuid,
  p_payload jsonb,
  p_actor jsonb
) returns uuid
language plpgsql
security definer
set search_path = public
as $$declare v_statement uuid:=gen_random_uuid();v_line jsonb;v_account uuid;v_start date;v_period_end date;v_open bigint;v_end bigint;v_sum numeric;v_balance_check text;v_anchor_reason text;v_anchor_gap text;v_subtype text;begin
-- [1] balance_check/anchor_reason/anchor_gap_explanation join the allowed keys;
-- lines min is now 0 (zero-line anchor/valuation statements are expressible).
if jsonb_typeof(p_payload)<>'object'or(p_payload-'account_id'-'period_start'-'period_end'-'opening_minor'-'ending_minor'-'currency'-'source_hash'-'lines'-'balance_check'-'anchor_reason'-'anchor_gap_explanation')<>'{}'::jsonb or jsonb_typeof(p_payload->'lines')<>'array'or jsonb_array_length(p_payload->'lines')>5000 or coalesce(p_payload->>'opening_minor','')!~'^-?(0|[1-9][0-9]*)$'or p_payload->>'opening_minor'='-0'or coalesce(p_payload->>'ending_minor','')!~'^-?(0|[1-9][0-9]*)$'or p_payload->>'ending_minor'='-0'or coalesce(p_payload->>'currency','')!~'^[A-Z]{3}$'or coalesce(p_payload->>'source_hash','')!~'^[a-f0-9]{64}$'then raise exception'KEEL_INVALID_COMMAND: malformed statement'using errcode='P0009';end if;
-- balance_check defaults to 'strict' when absent (manual create path parity).
v_balance_check:=coalesce(p_payload->>'balance_check','strict');
if v_balance_check not in('strict','anchor')then raise exception'KEEL_INVALID_COMMAND: invalid balance_check'using errcode='P0009';end if;
-- Anchor requires a typed reason + gap; strict must carry neither.
v_anchor_reason:=p_payload->>'anchor_reason';v_anchor_gap:=p_payload->>'anchor_gap_explanation';
if v_balance_check='anchor'then if coalesce(v_anchor_reason,'')not in('investment_valuation','market_value','no_transaction_detail')or v_anchor_gap is null or length(v_anchor_gap)not between 1 and 1000 then raise exception'KEEL_INVALID_COMMAND: anchor requires typed reason + gap explanation'using errcode='P0009';end if;else if v_anchor_reason is not null or v_anchor_gap is not null then raise exception'KEEL_INVALID_COMMAND: strict statement must not carry anchor provenance'using errcode='P0009';end if;end if;
begin v_account:=(p_payload->>'account_id')::uuid;v_start:=(p_payload->>'period_start')::date;v_period_end:=(p_payload->>'period_end')::date;v_open:=(p_payload->>'opening_minor')::bigint;v_end:=(p_payload->>'ending_minor')::bigint;if v_start>v_period_end then raise exception'bad';end if;exception when others then raise exception'KEEL_INVALID_COMMAND: invalid statement scalars'using errcode='P0009';end;
if not exists(select 1 from public.accounts a where a.household_id=p_household_id and a.id=v_account and a.currency=p_payload->>'currency')or not public.keel_recurring_account_access(p_household_id,v_account,true)then raise exception'KEEL_SCOPE_VIOLATION: account not found'using errcode='P0006';end if;
if(select count(*)<>count(distinct l->>'line_key')from jsonb_array_elements(p_payload->'lines')l)or exists(select 1 from jsonb_array_elements(p_payload->'lines')l where(l-'line_key'-'date'-'amount_minor'-'description')<>'{}'::jsonb or length(coalesce(l->>'line_key',''))not between 1 and 100 or coalesce(l->>'amount_minor','')!~'^-?(0|[1-9][0-9]*)$'or l->>'amount_minor'='-0'or length(coalesce(l->>'description',''))not between 1 and 500)then raise exception'KEEL_INVALID_COMMAND: invalid statement lines'using errcode='P0009';end if;
-- [2] coalesce(sum(...),0): an empty array contributes 0 instead of NULL, so the
-- strict identity below is a real check (not a silent pass) for zero-line inputs.
begin for v_line in select value from jsonb_array_elements(p_payload->'lines')loop if(v_line->>'date')::date not between v_start and v_period_end then raise exception'bad';end if;perform(v_line->>'amount_minor')::bigint;end loop;select coalesce(sum((l->>'amount_minor')::bigint),0)::numeric into v_sum from jsonb_array_elements(p_payload->'lines')l;exception when others then raise exception'KEEL_INVALID_COMMAND: invalid statement line values'using errcode='P0009';end;
-- [3] strict enforces opening+Σ=ending. anchor skips the identity but is only
-- legal for investment/valuation subtypes (a mark-to-market ending is not a line
-- sum); it still records opening/ending + the typed provenance.
if v_balance_check='strict'then
  if v_open::numeric+v_sum<>v_end::numeric then raise exception'KEEL_INVALID_COMMAND: statement lines do not reconcile'using errcode='P0009';end if;
else
  select a.subtype into v_subtype from public.accounts a where a.household_id=p_household_id and a.id=v_account;
  if coalesce(v_subtype,'')not in('brokerage','retirement','cash management')then raise exception'KEEL_INVALID_COMMAND: anchor mode only for investment/valuation accounts'using errcode='P0009';end if;
end if;
insert into public.statements(household_id,id,account_id,period_start,period_end,opening_minor,ending_minor,currency,source_hash,created_by,balance_check,anchor_reason,anchor_gap_explanation)values(p_household_id,v_statement,v_account,v_start,v_period_end,v_open,v_end,p_payload->>'currency',p_payload->>'source_hash',(p_actor->>'userId')::uuid,v_balance_check::public.statement_balance_check,v_anchor_reason::public.statement_anchor_reason,v_anchor_gap);
for v_line in select value from jsonb_array_elements(p_payload->'lines')loop insert into public.statement_lines(household_id,statement_id,line_key,line_date,amount_minor,description)values(p_household_id,v_statement,v_line->>'line_key',(v_line->>'date')::date,(v_line->>'amount_minor')::bigint,v_line->>'description');end loop;
return v_statement;end;$$;

-- Preserve ownership (keel_api) after the create-or-replace.
grant create on schema public to keel_api;
alter function public.keel_statement_validate_and_materialize(uuid,jsonb,jsonb) owner to keel_api;
revoke create on schema public from keel_api;
revoke all on function public.keel_statement_validate_and_materialize(uuid,jsonb,jsonb) from public, anon, authenticated;

-- ===========================================================================
-- Relax keel_reconciliation_close items min1 -> min0 for anchor/zero-line
-- statements. The shipped proc requires items array length >= 1 AND
-- items length == statement_lines count. A zero-line anchor statement has zero
-- statement_lines, so the correct relaxation is: allow 0 items when the
-- statement has 0 lines (the "one explanation per line" invariant is trivially
-- satisfied). Everything else about close (difference must be explained by
-- adjustments, period lock, etc.) is UNCHANGED (gate 8).
--
-- Rather than re-paste the whole ~40-line proc, replace only the malformed-close
-- guard's `items < 1` clause with `items < 0` (i.e. drop the min). The
-- "items count == statement_lines count" check already forces items==0 exactly
-- when lines==0, so a zero-line statement needs zero items and a lined statement
-- still needs one per line. We rebuild the proc from the live definition with
-- that single clause changed.
-- ===========================================================================
create or replace function public.keel_reconciliation_close(p_command_id uuid, p_economic_event_key text, p_actor jsonb, p_household_id uuid, p_payload jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_hash text:=public.keel_payload_hash(p_payload);v_replay jsonb;v_actor jsonb;v_s public.statements%rowtype;v_session uuid:=gen_random_uuid();v_lock uuid;v_ledger bigint;v_diff bigint;v_adj bigint;v_item jsonb;v_row jsonb;v_entity uuid;v_after jsonb;v_result jsonb;
begin
 perform public.keel_assert_member_write(p_household_id);v_actor:=public.keel_actor_from_jwt();v_replay:=public.keel_idempotency_check(p_household_id,p_economic_event_key,v_hash);if v_replay is not null then return v_replay;end if;
 -- [amended] items min 1 -> min 0: a zero-line anchor statement has zero lines
 -- and therefore needs zero items. The lines==items equality below still forces
 -- one explanation per line for every lined statement (gate 8 unchanged).
 if jsonb_typeof(p_payload)<>'object'or(p_payload-'statement_id'-'items'-'adjustments')<>'{}'::jsonb or jsonb_typeof(p_payload->'items')<>'array'or jsonb_typeof(p_payload->'adjustments')<>'array'or jsonb_array_length(p_payload->'items')<0 or jsonb_array_length(p_payload->'items')>5000 or jsonb_array_length(p_payload->'adjustments')>100 then raise exception'KEEL_INVALID_COMMAND: malformed reconciliation close'using errcode='P0009';end if;
 begin perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_household_id::text||':'||(p_payload->>'statement_id'),0));select*into v_s from public.statements where household_id=p_household_id and id=(p_payload->>'statement_id')::uuid;exception when invalid_text_representation then raise exception'KEEL_INVALID_COMMAND: invalid statement id'using errcode='P0009';end;
 if not found or exists(select 1 from public.reconciliation_sessions r where r.household_id=p_household_id and r.statement_id=v_s.id)or not public.keel_statement_access(p_household_id,v_s.id,true)then raise exception'KEEL_SCOPE_VIOLATION: statement not found'using errcode='P0006';end if;
 if jsonb_array_length(p_payload->'items')<>(select count(*)from public.statement_lines where household_id=p_household_id and statement_id=v_s.id)or(select count(*)<>count(distinct i->>'line_id')from jsonb_array_elements(p_payload->'items')i)then raise exception'KEEL_INVALID_COMMAND: every statement line requires one explanation'using errcode='P0009';end if;
 if exists(select 1 from jsonb_array_elements(p_payload->'items')i where (i-'line_id'-'resolution'-'transaction_id'-'explanation')<>'{}'::jsonb or coalesce(i->>'line_id','')!~'^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'or coalesce(i->>'resolution','')not in('matched_transaction','stale_balance','missing_event','duplicate','pending_posting','opening_balance','adjustment')or length(coalesce(i->>'explanation',''))not between 1 and 500 or(i->>'resolution'='matched_transaction'and coalesce(i->>'transaction_id','')!~'^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')or(i->>'resolution'<>'matched_transaction'and i?'transaction_id'))or exists(select 1 from jsonb_array_elements(p_payload->'adjustments')a where(a-'kind'-'amount_minor'-'explanation')<>'{}'::jsonb or coalesce(a->>'kind','')not in('stale_balance','missing_event','duplicate','pending_posting','opening_balance','adjustment')or coalesce(a->>'amount_minor','')!~'^-?(0|[1-9][0-9]*)$'or a->>'amount_minor'='-0'or length(coalesce(a->>'explanation',''))not between 1 and 500)then raise exception'KEEL_INVALID_COMMAND: invalid reconciliation evidence'using errcode='P0009';end if;
 begin select a.entity_id,coalesce((select sum(jp.amount_minor)from public.journal_postings jp join public.journal_batches jb on jb.id=jp.batch_id where jp.ledger_account_id=a.ledger_account_id and jp.currency=v_s.currency and jb.household_id=p_household_id and jb.effective_date<=v_s.period_end),0)::bigint into v_entity,v_ledger from public.accounts a where a.household_id=p_household_id and a.id=v_s.account_id;v_diff:=v_s.ending_minor-v_ledger;select coalesce(sum((x->>'amount_minor')::bigint),0)::bigint into v_adj from jsonb_array_elements(p_payload->'adjustments')x;exception when numeric_value_out_of_range then raise exception'KEEL_INVALID_COMMAND: reconciliation arithmetic overflow'using errcode='P0009';end;if v_adj<>v_diff then raise exception'KEEL_INVALID_COMMAND: ledger difference unexplained'using errcode='P0009';end if;
 insert into public.period_locks(household_id,entity_id,start_date,end_date,locked_by)values(p_household_id,v_entity,v_s.period_start,v_s.period_end,(v_actor->>'userId')::uuid)returning id into v_lock;insert into public.reconciliation_sessions(household_id,id,statement_id,account_id,ledger_ending_minor,difference_minor,status,formula_version,period_lock_id,closed_by,closed_at)values(p_household_id,v_session,v_s.id,v_s.account_id,v_ledger,v_diff,'closed','statement-close-v1',v_lock,(v_actor->>'userId')::uuid,now());
 for v_item in select value from jsonb_array_elements(p_payload->'items')loop if not exists(select 1 from public.statement_lines l where l.household_id=p_household_id and l.statement_id=v_s.id and l.id=(v_item->>'line_id')::uuid)then raise exception'KEEL_SCOPE_VIOLATION: statement line not found'using errcode='P0006';end if;if v_item->>'resolution'='matched_transaction'and not exists(select 1 from public.canonical_transactions t where t.household_id=p_household_id and t.account_id=v_s.account_id and t.id=(v_item->>'transaction_id')::uuid and t.effective_date between v_s.period_start and v_s.period_end and t.status in('posted','reviewed')and t.voided_at is null)then raise exception'KEEL_SCOPE_VIOLATION: matched transaction not found'using errcode='P0006';end if;insert into public.reconciliation_items(household_id,session_id,statement_line_id,resolution,transaction_id,explanation)values(p_household_id,v_session,(v_item->>'line_id')::uuid,(v_item->>'resolution')::public.reconciliation_resolution,nullif(v_item->>'transaction_id','')::uuid,v_item->>'explanation');end loop;
 for v_row in select value from jsonb_array_elements(p_payload->'adjustments')loop insert into public.reconciliation_adjustments(household_id,session_id,kind,amount_minor,explanation)values(p_household_id,v_session,(v_row->>'kind')::public.reconciliation_resolution,(v_row->>'amount_minor')::bigint,v_row->>'explanation');end loop;insert into public.close_checklists(household_id,session_id,checklist_version,checks)values(p_household_id,v_session,'statement-close-v1',jsonb_build_object('allLinesExplained',true,'differenceExplained',true,'historyLocked',true));insert into public.reconciliation_status_events(household_id,session_id,transition,actor,command_id)values(p_household_id,v_session,'closed',v_actor,p_command_id);
 v_after:=jsonb_build_object('sessionId',v_session,'statementId',v_s.id,'status','closed','ledgerEndingMinor',v_ledger::text,'statementEndingMinor',v_s.ending_minor::text,'differenceMinor',v_diff::text,'periodLockId',v_lock);v_result:=jsonb_build_object('commandId',p_command_id,'economicEventKey',p_economic_event_key,'idempotentReplay',false,'effects',v_after,'asOf',to_char(now()at time zone'utc','YYYY-MM-DD"T"HH24:MI:SS"Z"'));perform public.keel_finish_command(p_command_id,'reconciliations.close',p_economic_event_key,p_household_id,v_actor,v_hash,'reconciliations.closed','reconciliation_session',v_session,v_after,v_result);return v_result;
end;$function$;

grant create on schema public to keel_api;
alter function public.keel_reconciliation_close(uuid,text,jsonb,uuid,jsonb) owner to keel_api;
revoke create on schema public from keel_api;

-- ===========================================================================
-- Extend the statements export to carry the new balance_check/anchor columns.
-- Rename-then-wrap over the Slice-3-first-migration export layer. (Statements
-- rows already export their base columns via the pre-layer; here we replace the
-- 'statements' key with a richer projection including the anchor provenance.)
-- ===========================================================================
grant select on public.statements to keel_export;

alter function public.keel_export_household(uuid, timestamptz)
  rename to keel_export_household_pre_statement_anchor;
revoke all on function public.keel_export_household_pre_statement_anchor(uuid, timestamptz)
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
  v_statements jsonb;
begin
  v_base := public.keel_export_household_pre_statement_anchor(p_household_id, p_as_of);

  select coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', s.id, 'household_id', s.household_id, 'account_id', s.account_id,
      'period_start', s.period_start, 'period_end', s.period_end,
      'opening_minor', s.opening_minor::text, 'ending_minor', s.ending_minor::text,
      'currency', s.currency, 'source_hash', s.source_hash, 'created_by', s.created_by,
      'balance_check', s.balance_check::text, 'anchor_reason', s.anchor_reason::text,
      'anchor_gap_explanation', s.anchor_gap_explanation,
      'created_at', to_char(s.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    ) order by s.id)
    from public.statements s where s.household_id = p_household_id), '[]'::jsonb)
  into v_statements;

  return jsonb_set(v_base, '{tables,statements}', v_statements);
end;
$$;

revoke all on function public.keel_export_household(uuid, timestamptz)
  from public, anon, authenticated, service_role;
grant create on schema public to keel_export;
alter function public.keel_export_household(uuid, timestamptz) owner to keel_export;
revoke create on schema public from keel_export;
grant execute on function public.keel_export_household(uuid, timestamptz) to service_role;
