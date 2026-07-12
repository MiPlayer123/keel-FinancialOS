begin;
select plan(6);

-- Dashboard read procs require authentication (no JWT subject → P0004).
set local role authenticated;
select throws_ok(
  $$select public.keel_cash_flow('00000000-0000-4000-8000-00000000a001'::uuid, '2026-06-01'::date, '2026-07-12'::date)$$,
  'P0004', null, 'cash_flow requires authentication');
select throws_ok(
  $$select public.keel_net_worth_as_of('00000000-0000-4000-8000-00000000a001'::uuid, '2026-07-12'::date)$$,
  'P0004', null, 'net_worth requires authentication');

-- As a real member of Alpha household (alex@keel.local seed uid).
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000001', true);

select is(
  public.keel_cash_flow('00000000-0000-4000-8000-00000000a001'::uuid, '2026-06-01'::date, '2026-07-12'::date)
    ->'scope'->>'householdId',
  '00000000-0000-4000-8000-00000000a001',
  'cash_flow returns the requested household scope');
select is(
  jsonb_typeof(public.keel_net_worth_as_of('00000000-0000-4000-8000-00000000a001'::uuid, '2026-07-12'::date)->'rows'),
  'array',
  'net_worth rows is a (per-currency) array');

-- Tenant isolation: a household the caller is not a member of → P0006, never another tenant's data.
select throws_ok(
  $$select public.keel_cash_flow('00000000-0000-4000-8000-0000000000ff'::uuid, '2026-06-01'::date, '2026-07-12'::date)$$,
  'P0006', null, 'cash_flow blocks cross-tenant access');

-- Inverted date range is rejected.
select throws_ok(
  $$select public.keel_cash_flow('00000000-0000-4000-8000-00000000a001'::uuid, '2026-07-12'::date, '2026-06-01'::date)$$,
  'P0001', null, 'cash_flow rejects an inverted date range');

select * from finish();
rollback;
