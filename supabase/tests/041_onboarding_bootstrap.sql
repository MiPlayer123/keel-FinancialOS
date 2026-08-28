begin;
select plan(11);

insert into auth.users (id, email)
values ('00000000-0000-4000-8000-00000000b001', 'onboarding-fixture@example.test');

select has_function(
  'public',
  'keel_bootstrap_household',
  array['uuid', 'text'],
  'onboarding bootstrap exists'
);

set local role service_role;

select lives_ok(
  $$select public.keel_bootstrap_household(
    '00000000-0000-4000-8000-00000000b001',
    'My household'
  )$$,
  'first bootstrap succeeds'
);

select is(
  (select count(*)::int from public.household_memberships
   where user_id = '00000000-0000-4000-8000-00000000b001'),
  1,
  'creates one household membership'
);

select is(
  (select role::text from public.household_memberships
   where user_id = '00000000-0000-4000-8000-00000000b001'),
  'owner',
  'new user owns the household'
);

select is(
  (select count(*)::int
   from public.entities e
   join public.household_memberships m on m.household_id = e.household_id
   where m.user_id = '00000000-0000-4000-8000-00000000b001'
     and e.kind = 'personal'
     and e.archived_at is null),
  1,
  'creates one personal entity'
);

select is(
  (select count(*)::int
   from public.approval_policies p
   join public.household_memberships m on m.household_id = p.household_id
   where m.user_id = '00000000-0000-4000-8000-00000000b001'),
  4,
  'seeds every AI risk policy explicitly'
);

select is(
  (select count(*)::int
   from public.audit_log a
   join public.household_memberships m on m.household_id = a.household_id
   where m.user_id = '00000000-0000-4000-8000-00000000b001'
     and a.action = 'household.bootstrap'),
  1,
  'records the bootstrap in the audit log'
);

select lives_ok(
  $$select public.keel_bootstrap_household(
    '00000000-0000-4000-8000-00000000b001',
    'A different name'
  )$$,
  'bootstrap replay succeeds'
);

select is(
  (select count(*)::int from public.household_memberships
   where user_id = '00000000-0000-4000-8000-00000000b001'),
  1,
  'bootstrap replay creates no second household'
);

reset role;

select is(
  (
    select role.rolname
      from pg_proc p
      join pg_roles role on role.oid = p.proowner
     where p.oid = 'public.keel_bootstrap_household(uuid,text)'::regprocedure
  ),
  'keel_api',
  'bootstrap runs with the least-privilege API owner'
);

select ok(
  not has_function_privilege(
    'anon',
    'public.keel_bootstrap_household(uuid,text)',
    'execute'
  ),
  'anonymous users cannot bootstrap households'
);

select * from finish();
rollback;
