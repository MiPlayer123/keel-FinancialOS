begin;
select plan(4);

select ok(
  pg_catalog.pg_get_functiondef(
    'public.keel_goal_save(uuid,uuid,text,bigint,date,uuid,text,text)'::regprocedure
  ) not like '%auth.uid()%',
  'goal save reads the caller id without auth schema access'
);

select ok(
  pg_catalog.pg_get_functiondef(
    'public.keel_goal_contribute(uuid,uuid,bigint,date)'::regprocedure
  ) not like '%auth.uid()%',
  'goal contribution reads the caller id without auth schema access'
);

select ok(
  pg_catalog.pg_get_functiondef(
    'public.keel_goal_set_status(uuid,uuid,text)'::regprocedure
  ) not like '%auth.uid()%',
  'goal status reads the caller id without auth schema access'
);

select ok(
  not pg_catalog.has_schema_privilege('keel_api', 'auth', 'usage'),
  'keel_api retains no auth schema usage'
);

select * from finish();
rollback;
