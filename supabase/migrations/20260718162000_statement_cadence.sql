-- WS-I / FEEDBACK.md F-029 (slice 1): per-account statement cadence + a
-- "statement due" reminder. CSV line import is DEFERRED (uploads stay
-- attach-only, lines hand-keyed) — see NOTES.md.
--
-- Cadence = the expected day-of-month a statement closes. It is either DERIVED
-- from the household's prior statements (the modal period_end day) or SET
-- MANUALLY per account (an override). The read model then computes the next
-- expected close date and whether a statement is overdue. No AI, no ledger
-- arithmetic — pure calendar derivation over user-authored statements.

-- ---------------------------------------------------------------------------
-- 1. Manual override table. Presence of a row = user set an explicit close day;
-- absence = fall back to the derived cadence. Mutable single row per account
-- (close day genuinely changes when a bank changes cycles) — this is a live
-- setting, not an immutable economic event, so UPDATE is allowed and audited
-- through the command, not the append-only ledger triggers.
-- ---------------------------------------------------------------------------
create table public.account_statement_cadence (
  household_id uuid not null references public.households(id),
  account_id uuid not null,
  close_day smallint not null check (close_day between 1 and 31),
  updated_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (household_id, account_id),
  constraint fk_asc_account_tenant foreign key (household_id, account_id)
    references public.accounts(household_id, id) on delete restrict
);

-- ---------------------------------------------------------------------------
-- 2. set / clear command. close_day null clears the override (back to derived).
-- ---------------------------------------------------------------------------
create function public.keel_statement_set_cadence(
  p_command_id uuid, p_economic_event_key text, p_actor jsonb, p_household_id uuid, p_payload jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_hash text := public.keel_payload_hash(p_payload); v_replay jsonb; v_actor jsonb;
  v_account uuid; v_close int; v_after jsonb; v_result jsonb;
begin
  perform public.keel_assert_member_write(p_household_id);
  v_actor := public.keel_actor_from_jwt();
  v_replay := public.keel_idempotency_check(p_household_id, p_economic_event_key, v_hash);
  if v_replay is not null then return v_replay; end if;
  if jsonb_typeof(p_payload) <> 'object'
     or (p_payload - 'account_id' - 'close_day') <> '{}'::jsonb
     or coalesce(p_payload->>'account_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or (p_payload ? 'close_day' and jsonb_typeof(p_payload->'close_day') not in ('number','null')) then
    raise exception 'KEEL_INVALID_COMMAND: malformed cadence payload' using errcode = 'P0009';
  end if;
  v_account := (p_payload->>'account_id')::uuid;
  if not public.keel_recurring_account_access(p_household_id, v_account, true) then
    raise exception 'KEEL_SCOPE_VIOLATION: account not found' using errcode = 'P0006';
  end if;
  if p_payload->'close_day' is null or p_payload->>'close_day' is null then
    delete from public.account_statement_cadence
     where household_id = p_household_id and account_id = v_account;
    v_after := jsonb_build_object('accountId', v_account, 'closeDay', null);
  else
    begin v_close := (p_payload->>'close_day')::int;
    exception when others then raise exception 'KEEL_INVALID_COMMAND: invalid close day' using errcode = 'P0009'; end;
    if v_close not between 1 and 31 then
      raise exception 'KEEL_INVALID_COMMAND: close day out of range' using errcode = 'P0009';
    end if;
    insert into public.account_statement_cadence(household_id, account_id, close_day, updated_by)
    values (p_household_id, v_account, v_close::smallint, (v_actor->>'userId')::uuid)
    on conflict (household_id, account_id)
      do update set close_day = excluded.close_day, updated_by = excluded.updated_by, updated_at = now();
    v_after := jsonb_build_object('accountId', v_account, 'closeDay', v_close);
  end if;
  v_result := jsonb_build_object('commandId', p_command_id, 'economicEventKey', p_economic_event_key,
    'idempotentReplay', false, 'effects', v_after,
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'));
  perform public.keel_finish_command(p_command_id, 'statements.set_cadence', p_economic_event_key,
    p_household_id, v_actor, v_hash, 'statements.cadence_set', 'account', v_account, v_after, v_result);
  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Read model: per account, the effective close day (manual override or the
-- modal period_end day of prior statements), the last covered period end, the
-- next expected close date, and whether it is overdue (a full cycle has elapsed
-- past the last statement's period_end without a newer statement).
-- Only accounts that have EITHER a manual cadence OR at least one statement are
-- returned — we never invent a cadence for an account the user never reconciles.
-- ---------------------------------------------------------------------------
create function public.keel_statement_cadence(p_household_id uuid)
returns jsonb language plpgsql security definer stable set search_path = public as $$
declare
  v_rows jsonb;
  v_uid uuid := coalesce(
    nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
    nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid;
  v_today date := (now() at time zone 'utc')::date;
begin
  if v_uid is null then raise exception 'KEEL_NOT_AUTHENTICATED' using errcode = 'P0004'; end if;
  if not exists (select 1 from public.household_memberships
    where household_id = p_household_id and user_id = v_uid) then
    raise exception 'KEEL_SCOPE_VIOLATION' using errcode = 'P0006';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'accountId', d.account_id,
           'closeDay', d.close_day,
           'closeDaySource', d.close_day_source,
           'lastPeriodEnd', case when d.last_period_end is null then null else to_char(d.last_period_end,'YYYY-MM-DD') end,
           'nextExpectedClose', case when d.next_close is null then null else to_char(d.next_close,'YYYY-MM-DD') end,
           'overdue', coalesce(d.next_close is not null and d.next_close <= v_today, false),
           'statementCount', d.statement_count
         ) order by d.account_id), '[]'::jsonb)
    into v_rows
  from (
    select base.account_id,
           coalesce(base.manual_day, base.modal_day) as close_day,
           case when base.manual_day is not null then 'manual'
                when base.modal_day is not null then 'derived'
                else 'unknown' end as close_day_source,
           base.last_period_end,
           base.statement_count,
           -- next expected close = first monthly close-day (clamped to the
           -- month's length) strictly after the last statement's period_end, or
           -- after yesterday when there are no statements yet.
           (
             select min(cd)
             from (
               select (date_trunc('month', gs)
                       + (least(coalesce(base.manual_day, base.modal_day),
                                extract(day from (date_trunc('month', gs) + interval '1 month' - interval '1 day'))::int) - 1)
                         * interval '1 day')::date as cd
               from generate_series(
                 date_trunc('month', coalesce(base.last_period_end, v_today))::date,
                 (date_trunc('month', coalesce(base.last_period_end, v_today)) + interval '2 months')::date,
                 interval '1 month') gs
             ) cds
             where coalesce(base.manual_day, base.modal_day) is not null
               and cd > coalesce(base.last_period_end, v_today - 1)
           ) as next_close
    from (
      select acc.account_id,
             cad.close_day as manual_day,
             derived.modal_day,
             stats.last_period_end,
             stats.statement_count
      from (
        -- accounts in scope that reconcile: have a manual cadence or a statement
        select a.id as account_id
        from public.accounts a
        where a.household_id = p_household_id
          and public.keel_recurring_account_access(p_household_id, a.id, false)
          and (exists (select 1 from public.account_statement_cadence c
                       where c.household_id = p_household_id and c.account_id = a.id)
               or exists (select 1 from public.statements s
                          where s.household_id = p_household_id and s.account_id = a.id))
      ) acc
      left join public.account_statement_cadence cad
        on cad.household_id = p_household_id and cad.account_id = acc.account_id
      left join lateral (
        select mode() within group (order by extract(day from s.period_end)::int) as modal_day
        from public.statements s
        where s.household_id = p_household_id and s.account_id = acc.account_id
      ) derived on true
      left join lateral (
        select max(s.period_end) as last_period_end, count(*)::int as statement_count
        from public.statements s
        where s.household_id = p_household_id and s.account_id = acc.account_id
      ) stats on true
    ) base
  ) d;

  return jsonb_build_object(
    'scope', jsonb_build_object('householdId', p_household_id),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'formulaVersion', 'statement-cadence-v1',
    'rows', v_rows
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. RLS + grants (mirror the statements domain).
-- ---------------------------------------------------------------------------
alter table public.account_statement_cadence enable row level security;
revoke all on public.account_statement_cadence from public, anon, authenticated;
grant select on public.account_statement_cadence to authenticated, service_role;
grant select, insert, update, delete on public.account_statement_cadence to keel_api;
create policy asc_authorized_read on public.account_statement_cadence for select to authenticated
  using (public.keel_recurring_account_access(household_id, account_id, false));
create policy asc_api_all on public.account_statement_cadence for all to keel_api using (true) with check (true);

grant create on schema public to keel_api;
alter function public.keel_statement_set_cadence(uuid,text,jsonb,uuid,jsonb) owner to keel_api;
alter function public.keel_statement_cadence(uuid) owner to keel_api;
revoke create on schema public from keel_api;
revoke all on function public.keel_statement_set_cadence(uuid,text,jsonb,uuid,jsonb),
  public.keel_statement_cadence(uuid) from public, anon;
grant execute on function public.keel_statement_set_cadence(uuid,text,jsonb,uuid,jsonb),
  public.keel_statement_cadence(uuid) to authenticated;

do $$begin
  if exists(select 1 from pg_roles where rolname='keel_api' and (rolcanlogin or rolbypassrls or rolsuper)) then
    raise exception 'KEEL_OWNERSHIP: cadence definer privileged'; end if;
  if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_roles r on r.oid=p.proowner
    where n.nspname='public' and p.proname in ('keel_statement_set_cadence','keel_statement_cadence')
      and p.prosecdef and r.rolname<>'keel_api') then
    raise exception 'KEEL_OWNERSHIP: cadence definer owner'; end if;
end$$;

-- ---------------------------------------------------------------------------
-- 5. Export chain (Data Access Guarantee).
-- ---------------------------------------------------------------------------
grant select on public.account_statement_cadence to keel_export;
create policy asc_export on public.account_statement_cadence for select to keel_export using (true);
alter function public.keel_export_household(uuid,timestamptz) rename to keel_export_household_pre_statement_cadence;
revoke all on function public.keel_export_household_pre_statement_cadence(uuid,timestamptz) from public,anon,authenticated,service_role;
create function public.keel_export_household(p_household_id uuid, p_as_of timestamptz default null)
returns jsonb language plpgsql security definer stable set search_path = pg_catalog, public as $$
declare v_base jsonb; v_tables jsonb; begin
  v_base := public.keel_export_household_pre_statement_cadence(p_household_id, p_as_of);
  select jsonb_build_object(
    'account_statement_cadence',
    coalesce((select jsonb_agg(to_jsonb(x) order by x.household_id, x.account_id)
      from public.account_statement_cadence x where x.household_id = p_household_id),'[]'::jsonb)
  ) into v_tables;
  return jsonb_set(v_base, '{tables}', v_base->'tables' || v_tables);
end$$;
revoke all on function public.keel_export_household(uuid,timestamptz) from public,anon,authenticated,service_role;
grant create on schema public to keel_export;
alter function public.keel_export_household(uuid,timestamptz) owner to keel_export;
revoke create on schema public from keel_export;
grant execute on function public.keel_export_household(uuid,timestamptz) to service_role;
