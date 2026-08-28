do $migration$
declare
  v_proc regprocedure;
  v_definition text;
  v_old constant text := 'v_uid uuid := auth.uid();';
  v_new constant text := $replacement$v_uid uuid := coalesce(
    nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
    nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid;$replacement$;
begin
  foreach v_proc in array array[
    'public.keel_goal_save(uuid,uuid,text,bigint,date,uuid,text,text)'::regprocedure,
    'public.keel_goal_contribute(uuid,uuid,bigint,date)'::regprocedure,
    'public.keel_goal_set_status(uuid,uuid,text)'::regprocedure
  ]
  loop
    v_definition := pg_catalog.pg_get_functiondef(v_proc);
    if pg_catalog.strpos(v_definition, v_old) = 0 then
      raise exception 'KEEL_MIGRATION: expected auth.uid() in %', v_proc;
    end if;

    execute pg_catalog.replace(v_definition, v_old, v_new);
  end loop;
end;
$migration$;
