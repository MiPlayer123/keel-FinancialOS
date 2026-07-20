-- pgTAP: SQL gross-up math parity for keel_paycheck_template_compute
-- (SLICE D, docs/harness/plans/paycheck-split-templates-v2.md §D4). Proves the
-- SQL port of packages/paychecks/src/template.ts produces byte-identical gross /
-- taxes / remainder numbers — the correctness linchpin (the math set_splits does
-- NOT do). Runs on a throwaway cluster via scripts/run-paycheck-compute-pgtap.sh.
--
-- This suite builds a MINIMAL real schema (households + a stripped
-- paycheck_template_lines carrying only what compute reads) and defines the REAL
-- keel_paycheck_template_compute body verbatim (sliced from the migration by the
-- runner at the __MIGRATION_COMPUTE__ marker). No paraphrase.

begin;

-- Minimal roles the sliced function's owner/grant lines would reference are NOT
-- needed here (the runner slices ONLY the create function body, not the grants).

create table public.paycheck_template_lines (
  household_id uuid not null,
  id uuid not null default gen_random_uuid(),
  template_id uuid not null,
  line_key text not null,
  kind text not null,
  role text not null,
  amount_kind text not null,
  amount_minor bigint,
  bps integer,
  category_ledger_account_id uuid,
  destination_account_id uuid,
  position integer not null,
  primary key (household_id, id)
);

-- The REAL compute function (sliced from the migration).
-- __MIGRATION_COMPUTE__

-- Test fixtures: a household + template. We insert lines directly (bypassing the
-- enum casts the real table has — this minimal table uses text columns, and
-- compute reads them as ::text anyway).
create or replace function _seed_template(
  p_hh uuid, p_tpl uuid, p_lines jsonb
) returns void language plpgsql as $$
declare v_line jsonb; v_pos int := 0;
begin
  delete from public.paycheck_template_lines where household_id = p_hh and template_id = p_tpl;
  for v_line in select value from jsonb_array_elements(p_lines) loop
    insert into public.paycheck_template_lines
      (household_id, template_id, line_key, kind, role, amount_kind, amount_minor, bps,
       category_ledger_account_id, destination_account_id, position)
    values (
      p_hh, p_tpl, v_line->>'line_key', v_line->>'kind', v_line->>'role', v_line->>'amount_kind',
      nullif(v_line->>'amount_minor','')::bigint, nullif(v_line->>'bps','')::int,
      nullif(v_line->>'category_ledger_account_id','')::uuid,
      nullif(v_line->>'destination_account_id','')::uuid,
      v_pos);
    v_pos := v_pos + 1;
  end loop;
end;$$;

select plan(11);

-- ---- Fixture A: the Codex worked example (N=100000, F=12300, bps {1,1,246}) ----
-- earning(remainder) + fixed medical 12300 + three percent lines + net_deposit remainder.
select _seed_template(
  '11111111-1111-4111-8111-111111111111'::uuid,
  '22222222-2222-4222-8222-222222222222'::uuid,
  jsonb_build_array(
    jsonb_build_object('line_key','gross','kind','gross_salary','role','earning','amount_kind','remainder'),
    jsonb_build_object('line_key','medical','kind','benefit','role','posttax_deduction','amount_kind','fixed_minor','amount_minor','12300','category_ledger_account_id','33333333-3333-4333-8333-333333333333'),
    jsonb_build_object('line_key','local1','kind','local_withholding','role','tax','amount_kind','percent_of_gross_bps','bps','1','category_ledger_account_id','33333333-3333-4333-8333-333333333333'),
    jsonb_build_object('line_key','local2','kind','local_withholding','role','tax','amount_kind','percent_of_gross_bps','bps','1','category_ledger_account_id','33333333-3333-4333-8333-333333333333'),
    jsonb_build_object('line_key','fed','kind','federal_withholding','role','tax','amount_kind','percent_of_gross_bps','bps','246','category_ledger_account_id','33333333-3333-4333-8333-333333333333'),
    jsonb_build_object('line_key','deposit','kind','direct_deposit','role','net_deposit','amount_kind','remainder','destination_account_id','44444444-4444-4444-8444-444444444444')
  )
);

select is(
  (public.keel_paycheck_template_compute('11111111-1111-4111-8111-111111111111'::uuid,'22222222-2222-4222-8222-222222222222'::uuid,100000::bigint))->>'grossMinor',
  '115157', 'Codex example: G = 115157');
select is(
  (public.keel_paycheck_template_compute('11111111-1111-4111-8111-111111111111'::uuid,'22222222-2222-4222-8222-222222222222'::uuid,100000::bigint))->>'netMinor',
  '100000', 'Codex example: net = N = 100000');
-- fed tax = round_half_up(115157*246,10000) = 2833
select is(
  (select l->>'amountMinor' from jsonb_array_elements((public.keel_paycheck_template_compute('11111111-1111-4111-8111-111111111111'::uuid,'22222222-2222-4222-8222-222222222222'::uuid,100000::bigint))->'legs') l where l->>'lineKey'='fed'),
  '2833', 'Codex example: fed tax = 2833');
-- local1 = round_half_up(115157*1,10000) = 12
select is(
  (select l->>'amountMinor' from jsonb_array_elements((public.keel_paycheck_template_compute('11111111-1111-4111-8111-111111111111'::uuid,'22222222-2222-4222-8222-222222222222'::uuid,100000::bigint))->'legs') l where l->>'lineKey'='local1'),
  '12', 'Codex example: local1 = 12');
-- remainder deposit = 100000
select is(
  (select l->>'amountMinor' from jsonb_array_elements((public.keel_paycheck_template_compute('11111111-1111-4111-8111-111111111111'::uuid,'22222222-2222-4222-8222-222222222222'::uuid,100000::bigint))->'legs') l where l->>'lineKey'='deposit'),
  '100000', 'Codex example: deposit remainder = 100000');

-- ---- Fixture B: simple single-percent 401k transfer paycheck ----
-- earning + fed 2000bps (20%) + 401k 500bps (5%) pretax_transfer + deposit.
-- For N: choose N and let compute find G. Use N=750000 (7500.00 take-home).
select _seed_template(
  '11111111-1111-4111-8111-111111111111'::uuid,
  '55555555-5555-4555-8555-555555555555'::uuid,
  jsonb_build_array(
    jsonb_build_object('line_key','gross','kind','gross_salary','role','earning','amount_kind','remainder'),
    jsonb_build_object('line_key','fed','kind','federal_withholding','role','tax','amount_kind','percent_of_gross_bps','bps','2000','category_ledger_account_id','33333333-3333-4333-8333-333333333333'),
    jsonb_build_object('line_key','r401k','kind','retirement_401k','role','pretax_transfer','amount_kind','percent_of_gross_bps','bps','500','destination_account_id','44444444-4444-4444-8444-444444444444'),
    jsonb_build_object('line_key','deposit','kind','direct_deposit','role','net_deposit','amount_kind','remainder','destination_account_id','66666666-6666-4666-8666-666666666666')
  )
);
-- net(G) = G - round(G*0.20) - round(G*0.05). For G=1000000: fed=200000, 401k=50000, net=750000. So G=1000000.
select is(
  (public.keel_paycheck_template_compute('11111111-1111-4111-8111-111111111111'::uuid,'55555555-5555-4555-8555-555555555555'::uuid,750000::bigint))->>'grossMinor',
  '1000000', '401k fixture: G = 1000000 for net 750000');
select is(
  (select l->>'amountMinor' from jsonb_array_elements((public.keel_paycheck_template_compute('11111111-1111-4111-8111-111111111111'::uuid,'55555555-5555-4555-8555-555555555555'::uuid,750000::bigint))->'legs') l where l->>'lineKey'='r401k'),
  '50000', '401k fixture: 401k leg = 50000');
select is(
  (select l->>'destinationAccountId' from jsonb_array_elements((public.keel_paycheck_template_compute('11111111-1111-4111-8111-111111111111'::uuid,'55555555-5555-4555-8555-555555555555'::uuid,750000::bigint))->'legs') l where l->>'lineKey'='r401k'),
  '44444444-4444-4444-8444-444444444444', '401k fixture: 401k leg carries the destination account');

-- ---- Fixture C: N=0 → G=0, all legs 0 ----
select _seed_template(
  '11111111-1111-4111-8111-111111111111'::uuid,
  '77777777-7777-4777-8777-777777777777'::uuid,
  jsonb_build_array(
    jsonb_build_object('line_key','gross','kind','gross_salary','role','earning','amount_kind','remainder'),
    jsonb_build_object('line_key','fed','kind','federal_withholding','role','tax','amount_kind','percent_of_gross_bps','bps','2500','category_ledger_account_id','33333333-3333-4333-8333-333333333333'),
    jsonb_build_object('line_key','deposit','kind','direct_deposit','role','net_deposit','amount_kind','remainder','destination_account_id','66666666-6666-4666-8666-666666666666')
  )
);
select is(
  (public.keel_paycheck_template_compute('11111111-1111-4111-8111-111111111111'::uuid,'77777777-7777-4777-8777-777777777777'::uuid,0::bigint))->>'grossMinor',
  '0', 'N=0 → G=0');

-- ---- Fixture D: aggregate ΣP>=10000 rejected ----
select _seed_template(
  '11111111-1111-4111-8111-111111111111'::uuid,
  '88888888-8888-4888-8888-888888888888'::uuid,
  jsonb_build_array(
    jsonb_build_object('line_key','gross','kind','gross_salary','role','earning','amount_kind','remainder'),
    jsonb_build_object('line_key','a','kind','federal_withholding','role','tax','amount_kind','percent_of_gross_bps','bps','6000','category_ledger_account_id','33333333-3333-4333-8333-333333333333'),
    jsonb_build_object('line_key','b','kind','state_withholding','role','tax','amount_kind','percent_of_gross_bps','bps','4000','category_ledger_account_id','33333333-3333-4333-8333-333333333333'),
    jsonb_build_object('line_key','deposit','kind','direct_deposit','role','net_deposit','amount_kind','remainder','destination_account_id','66666666-6666-4666-8666-666666666666')
  )
);
select throws_ok(
  $$ select public.keel_paycheck_template_compute('11111111-1111-4111-8111-111111111111'::uuid,'88888888-8888-4888-8888-888888888888'::uuid,100000::bigint) $$,
  'P0009', null, 'aggregate ΣP>=10000 rejected');

-- ---- Fixture E: single-cent residue (bps=1, N=1) → G=1, tax=round_half_up(1,10000)=0, net=1 ----
select _seed_template(
  '11111111-1111-4111-8111-111111111111'::uuid,
  '99999999-9999-4999-8999-999999999999'::uuid,
  jsonb_build_array(
    jsonb_build_object('line_key','gross','kind','gross_salary','role','earning','amount_kind','remainder'),
    jsonb_build_object('line_key','fed','kind','federal_withholding','role','tax','amount_kind','percent_of_gross_bps','bps','1','category_ledger_account_id','33333333-3333-4333-8333-333333333333'),
    jsonb_build_object('line_key','deposit','kind','direct_deposit','role','net_deposit','amount_kind','remainder','destination_account_id','66666666-6666-4666-8666-666666666666')
  )
);
select is(
  (public.keel_paycheck_template_compute('11111111-1111-4111-8111-111111111111'::uuid,'99999999-9999-4999-8999-999999999999'::uuid,1::bigint))->>'grossMinor',
  '1', 'single-cent: G=1 for N=1');

select * from finish();
rollback;
