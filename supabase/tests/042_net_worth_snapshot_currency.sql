begin;
select no_plan();

insert into public.ledger_accounts (
  id,
  household_id,
  entity_id,
  name,
  kind,
  currency,
  is_category
) values (
  'f1000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-00000000a001',
  '00000000-0000-4000-8000-00000000a101',
  'Fictional EUR Brokerage Ledger',
  'asset',
  'EUR',
  false
), (
  'f1000000-0000-4000-8000-000000000006',
  '00000000-0000-4000-8000-00000000a001',
  '00000000-0000-4000-8000-00000000a101',
  'Fictional Future Brokerage Ledger',
  'asset',
  'GBP',
  false
);

insert into public.accounts (
  id,
  household_id,
  entity_id,
  ledger_account_id,
  name,
  subtype,
  currency,
  external_ref
) values (
  'f1000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-00000000a001',
  '00000000-0000-4000-8000-00000000a101',
  'f1000000-0000-4000-8000-000000000001',
  'Fictional EUR Brokerage',
  'brokerage',
  'EUR',
  'pgtap:net-worth:eur'
), (
  'f1000000-0000-4000-8000-000000000007',
  '00000000-0000-4000-8000-00000000a001',
  '00000000-0000-4000-8000-00000000a101',
  'f1000000-0000-4000-8000-000000000006',
  'Fictional Future Brokerage',
  'brokerage',
  'GBP',
  'pgtap:net-worth:future'
);

insert into public.balance_snapshots (
  id,
  household_id,
  account_id,
  as_of,
  current_minor,
  currency,
  source
) values
  (
    'f1000000-0000-4000-8000-000000000003',
    '00000000-0000-4000-8000-00000000a001',
    'f1000000-0000-4000-8000-000000000002',
    '2026-08-19T12:00:00Z',
    11111,
    'CAD',
    'plaid'
  ),
  (
    'f1000000-0000-4000-8000-000000000004',
    '00000000-0000-4000-8000-00000000a001',
    'f1000000-0000-4000-8000-000000000002',
    '2026-08-20T12:00:00Z',
    20000,
    'EUR',
    'plaid'
  ),
  (
    'f1000000-0000-4000-8000-000000000005',
    '00000000-0000-4000-8000-00000000a001',
    'f1000000-0000-4000-8000-000000000002',
    '2026-08-20T12:00:00Z',
    22222,
    'EUR',
    'plaid'
  ),
  (
    'f1000000-0000-4000-8000-000000000008',
    '00000000-0000-4000-8000-00000000a001',
    'f1000000-0000-4000-8000-000000000007',
    '2026-08-21T12:00:00Z',
    33333,
    'GBP',
    'plaid'
  );

select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-4000-8000-000000000001',
  true
);

select is(
  public.keel_net_worth_as_of(
    '00000000-0000-4000-8000-00000000a001',
    '2026-08-20'
  )->>'formulaVersion',
  'net-worth-market-v2',
  'as-of net worth advertises the currency-preserving formula'
);

select is(
  (
    select row->>'netWorthMinor'
      from jsonb_array_elements(
        public.keel_net_worth_as_of(
          '00000000-0000-4000-8000-00000000a001',
          '2026-08-20'
        )->'rows'
      ) row
     where row->>'currency' = 'EUR'
  ),
  '22222',
  'as-of net worth preserves EUR and resolves equal-time snapshots by id'
);

select is(
  public.keel_net_worth_daily(
    '00000000-0000-4000-8000-00000000a001',
    '2026-08-19',
    '2026-08-20'
  )->>'formulaVersion',
  'net-worth-daily-market-v2',
  'daily net worth advertises the currency-preserving formula'
);

select is(
  (
    select row->>'balanceMinor'
      from jsonb_array_elements(
        public.keel_net_worth_daily(
          '00000000-0000-4000-8000-00000000a001',
          '2026-08-19',
          '2026-08-20'
        )->'rows'
      ) row
     where row->>'date' = '2026-08-19'
       and row->>'currency' = 'CAD'
  ),
  '11111',
  'daily net worth uses each snapshot currency on its effective day'
);

select is(
  (
    select row->>'balanceMinor'
      from jsonb_array_elements(
        public.keel_net_worth_daily(
          '00000000-0000-4000-8000-00000000a001',
          '2026-08-19',
          '2026-08-20'
        )->'rows'
      ) row
     where row->>'date' = '2026-08-20'
       and row->>'currency' = 'EUR'
  ),
  '22222',
  'daily net worth preserves EUR and resolves equal-time snapshots by id'
);

select is(
  (
    select count(*)::int
      from jsonb_array_elements(
        public.keel_net_worth_daily(
          '00000000-0000-4000-8000-00000000a001',
          '2026-08-19',
          '2026-08-20'
        )->'rows'
      ) row
     where row->>'currency' = 'EUR'
  ),
  2,
  'daily net worth emits one EUR row per requested day'
);

select is(
  (
    select row->>'balanceMinor'
      from jsonb_array_elements(
        public.keel_net_worth_daily(
          '00000000-0000-4000-8000-00000000a001',
          '2026-08-19',
          '2026-08-20'
        )->'rows'
      ) row
     where row->>'date' = '2026-08-19'
       and row->>'currency' = 'EUR'
  ),
  '0',
  'daily net worth zero-pads a later snapshot currency before it becomes effective'
);

select is(
  (
    select count(*)::int
      from jsonb_array_elements(
        public.keel_net_worth_daily(
          '00000000-0000-4000-8000-00000000a001',
          '2026-08-19',
          '2026-08-20'
        )->'rows'
      ) row
     where row->>'currency' = 'GBP'
       and row->>'balanceMinor' = '0'
  ),
  2,
  'future-only investment snapshots preserve the existing zero-padded series'
);

select is(
  (
    select role.rolname
      from pg_proc p
      join pg_roles role on role.oid = p.proowner
     where p.oid = 'public.keel_net_worth_as_of(uuid,date)'::regprocedure
  ),
  'keel_api',
  'as-of function owner remains keel_api'
);

select is(
  (
    select role.rolname
      from pg_proc p
      join pg_roles role on role.oid = p.proowner
     where p.oid = 'public.keel_net_worth_daily(uuid,date,date)'::regprocedure
  ),
  'postgres',
  'daily function owner remains postgres'
);

select ok(
  not has_function_privilege(
    'anon',
    'public.keel_net_worth_as_of(uuid,date)',
    'EXECUTE'
  ),
  'anonymous callers cannot execute as-of net worth'
);

select ok(
  has_function_privilege(
    'authenticated',
    'public.keel_net_worth_daily(uuid,date,date)',
    'EXECUTE'
  ),
  'authenticated callers can execute daily net worth'
);

select * from finish();
rollback;
