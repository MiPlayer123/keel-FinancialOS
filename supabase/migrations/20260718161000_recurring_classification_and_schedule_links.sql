-- WS-I / FEEDBACK.md F-028: recurring classification + manual-schedule linking.
--
-- Two gaps addressed (the deterministic grid detector itself is UNTOUCHED):
--   1. Classification: map each detected series into a bucket
--      (income / subscription / utility / bill) from the SIGN plus the dominant
--      Plaid PFC-primary of its matched transactions. Deterministic SQL, no LLM
--      (Law 1). Exposed as a read-only query the Recurring page groups by.
--   2. Double-count fix: a link table between a manual scheduled_transaction and
--      a detected recurring_series so the projection can count one, not both.
--      Suggest→approve is not needed here (linking is a user-declared fact, not
--      an AI write) but it IS a reversible correction (Law 2): unlink is a soft
--      detach (detached_at), never a hard delete (user directive 2026-07-17).

-- ---------------------------------------------------------------------------
-- 0. scheduled_transactions gained no composite tenant key at creation
-- (20260713140000: PK is `id` only). Add one so the link table can carry the
-- household-scoped FK every other KEEL relationship uses (cross-tenant
-- reference smuggling fails closed). Additive + idempotent.
-- ---------------------------------------------------------------------------
alter table public.scheduled_transactions
  add constraint scheduled_transactions_household_id_id_key unique (household_id, id);

-- ---------------------------------------------------------------------------
-- 1. Link table (soft-delete via detached_at).
-- ---------------------------------------------------------------------------
create table public.recurring_series_schedule_links (
  household_id uuid not null references public.households(id),
  id uuid not null default gen_random_uuid(),
  series_id uuid not null,
  schedule_id uuid not null,
  linked_by uuid not null references auth.users(id),
  command_id uuid not null,
  created_at timestamptz not null default now(),
  detached_at timestamptz,
  detached_reason text check (detached_reason is null or length(detached_reason) between 1 and 500),
  primary key (household_id, id),
  constraint fk_rssl_series_tenant foreign key (household_id, series_id)
    references public.recurring_series(household_id, id) on delete restrict,
  constraint fk_rssl_schedule_tenant foreign key (household_id, schedule_id)
    references public.scheduled_transactions(household_id, id) on delete restrict
);
-- At most one ACTIVE link per (series, schedule) pair; detached rows may repeat.
create unique index recurring_series_schedule_links_active
  on public.recurring_series_schedule_links(household_id, series_id, schedule_id)
  where detached_at is null;

-- The link row's captured facts are immutable; only detached_at/detached_reason
-- may transition once (active → detached), via the unlink proc.
create function public.keel_rssl_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'KEEL_IMMUTABLE: recurring schedule links are soft-detached, not deleted'
      using errcode = 'P0010';
  end if;
  if old.detached_at is not null then
    raise exception 'KEEL_IMMUTABLE: link already detached' using errcode = 'P0010';
  end if;
  if (new.household_id, new.id, new.series_id, new.schedule_id, new.linked_by, new.command_id, new.created_at)
     is distinct from
     (old.household_id, old.id, old.series_id, old.schedule_id, old.linked_by, old.command_id, old.created_at) then
    raise exception 'KEEL_IMMUTABLE: only detachment may change a link' using errcode = 'P0010';
  end if;
  return new;
end;
$$;
create trigger recurring_series_schedule_links_guard
  before update or delete on public.recurring_series_schedule_links
  for each row execute function public.keel_rssl_guard();

-- ---------------------------------------------------------------------------
-- 2. Link / unlink commands (envelope-shaped, class-B-adjacent user facts).
-- ---------------------------------------------------------------------------
create function public.keel_recurring_link_schedule(
  p_command_id uuid, p_economic_event_key text, p_actor jsonb, p_household_id uuid, p_payload jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_hash text := public.keel_payload_hash(p_payload); v_replay jsonb; v_actor jsonb;
  v_series public.recurring_series%rowtype; v_schedule public.scheduled_transactions%rowtype;
  v_link uuid := gen_random_uuid(); v_after jsonb; v_result jsonb;
begin
  perform public.keel_assert_member_write(p_household_id);
  v_actor := public.keel_actor_from_jwt();
  v_replay := public.keel_idempotency_check(p_household_id, p_economic_event_key, v_hash);
  if v_replay is not null then return v_replay; end if;
  if jsonb_typeof(p_payload) <> 'object'
     or (p_payload - 'series_id' - 'schedule_id') <> '{}'::jsonb
     or coalesce(p_payload->>'series_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or coalesce(p_payload->>'schedule_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception 'KEEL_INVALID_COMMAND: malformed link payload' using errcode = 'P0009';
  end if;
  select * into v_series from public.recurring_series
   where household_id = p_household_id and id = (p_payload->>'series_id')::uuid for update;
  if not found or not public.keel_recurring_account_access(p_household_id, v_series.account_id, true) then
    raise exception 'KEEL_SCOPE_VIOLATION: recurring series not found' using errcode = 'P0006';
  end if;
  select * into v_schedule from public.scheduled_transactions
   where household_id = p_household_id and id = (p_payload->>'schedule_id')::uuid for update;
  if not found or not public.keel_recurring_account_access(p_household_id, v_schedule.account_id, true) then
    raise exception 'KEEL_SCOPE_VIOLATION: schedule not found' using errcode = 'P0006';
  end if;
  -- Sign must agree: an inflow series links to an income schedule and vice
  -- versa (schedule amount is signed: negative=bill, positive=income).
  if (v_series.sign = 'inflow') <> (v_schedule.amount_minor > 0) then
    raise exception 'KEEL_INVALID_COMMAND: series and schedule directions disagree' using errcode = 'P0009';
  end if;
  insert into public.recurring_series_schedule_links
    (household_id, id, series_id, schedule_id, linked_by, command_id)
  values (p_household_id, v_link, v_series.id, v_schedule.id, (v_actor->>'userId')::uuid, p_command_id);
  v_after := jsonb_build_object('linkId', v_link, 'seriesId', v_series.id, 'scheduleId', v_schedule.id);
  v_result := jsonb_build_object('commandId', p_command_id, 'economicEventKey', p_economic_event_key,
    'idempotentReplay', false, 'effects', v_after,
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'));
  perform public.keel_finish_command(p_command_id, 'recurring.link_schedule', p_economic_event_key,
    p_household_id, v_actor, v_hash, 'recurring.schedule_linked', 'recurring_series_schedule_link', v_link, v_after, v_result);
  return v_result;
exception when unique_violation then
  raise exception 'KEEL_INVALID_COMMAND: this series and schedule are already linked' using errcode = 'P0009';
end;
$$;

create function public.keel_recurring_unlink_schedule(
  p_command_id uuid, p_economic_event_key text, p_actor jsonb, p_household_id uuid, p_payload jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_hash text := public.keel_payload_hash(p_payload); v_replay jsonb; v_actor jsonb;
  v_row public.recurring_series_schedule_links%rowtype; v_after jsonb; v_result jsonb;
begin
  perform public.keel_assert_member_write(p_household_id);
  v_actor := public.keel_actor_from_jwt();
  v_replay := public.keel_idempotency_check(p_household_id, p_economic_event_key, v_hash);
  if v_replay is not null then return v_replay; end if;
  if jsonb_typeof(p_payload) <> 'object'
     or (p_payload - 'link_id' - 'reason') <> '{}'::jsonb
     or coalesce(p_payload->>'link_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or length(coalesce(p_payload->>'reason','')) not between 0 and 500 then
    raise exception 'KEEL_INVALID_COMMAND: malformed unlink payload' using errcode = 'P0009';
  end if;
  select * into v_row from public.recurring_series_schedule_links
   where household_id = p_household_id and id = (p_payload->>'link_id')::uuid for update;
  if not found or v_row.detached_at is not null
     or not public.keel_recurring_account_access(p_household_id,
          (select account_id from public.recurring_series s where s.household_id = p_household_id and s.id = v_row.series_id), true) then
    raise exception 'KEEL_SCOPE_VIOLATION: active link not found' using errcode = 'P0006';
  end if;
  update public.recurring_series_schedule_links
     set detached_at = now(), detached_reason = nullif(p_payload->>'reason','')
   where household_id = p_household_id and id = v_row.id;
  v_after := jsonb_build_object('linkId', v_row.id, 'detached', true);
  v_result := jsonb_build_object('commandId', p_command_id, 'economicEventKey', p_economic_event_key,
    'idempotentReplay', false, 'effects', v_after,
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'));
  perform public.keel_finish_command(p_command_id, 'recurring.unlink_schedule', p_economic_event_key,
    p_household_id, v_actor, v_hash, 'recurring.schedule_unlinked', 'recurring_series_schedule_link', v_row.id, v_after, v_result);
  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Classification + active-links read model.
-- ---------------------------------------------------------------------------
-- Deterministic bucket from the SIGN + dominant Plaid PFC-primary of matched
-- transactions. PFC primary is reached via the transaction's source link to the
-- normalized record (denormalized in 20260717170000). Ties/absence fall back to
-- the safe default for the sign (income for inflow, subscription for outflow).
create function public.keel_recurring_classification(p_household_id uuid)
returns jsonb language plpgsql security definer stable set search_path = public as $$
declare
  v_rows jsonb;
  v_uid uuid := coalesce(
    nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
    nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid;
begin
  if v_uid is null then raise exception 'KEEL_NOT_AUTHENTICATED' using errcode = 'P0004'; end if;
  if not exists (select 1 from public.household_memberships
    where household_id = p_household_id and user_id = v_uid) then
    raise exception 'KEEL_SCOPE_VIOLATION' using errcode = 'P0006';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'seriesId', c.series_id,
           'bucket', c.bucket,
           'dominantPfc', c.dominant_pfc,
           'matchedCount', c.matched_count
         ) order by c.series_id), '[]'::jsonb)
    into v_rows
  from (
    select s.id as series_id,
           count(pfc.pfc_primary) filter (where pfc.pfc_primary is not null and pfc.pfc_primary <> '') as matched_count,
           mode() within group (order by pfc.pfc_primary)
             filter (where pfc.pfc_primary is not null and pfc.pfc_primary <> '') as dominant_pfc,
           case
             when s.sign = 'inflow' then 'income'
             else case mode() within group (order by pfc.pfc_primary)
                    filter (where pfc.pfc_primary is not null and pfc.pfc_primary <> '')
               when 'RENT_AND_UTILITIES' then 'utility'
               when 'LOAN_PAYMENTS' then 'bill'
               when 'GOVERNMENT_AND_NON_PROFIT' then 'bill'
               when 'INSURANCE' then 'bill'
               when 'MEDICAL' then 'bill'
               when 'ENTERTAINMENT' then 'subscription'
               when 'GENERAL_SERVICES' then 'subscription'
               else 'subscription'
             end
           end as bucket
    from public.recurring_series s
    left join public.recurring_occurrences occ
      on occ.household_id = s.household_id and occ.series_id = s.id
     and occ.candidate_version_id = s.current_candidate_version_id
     and occ.matched_txn_id is not null
    left join public.transaction_source_links tsl
      on tsl.canonical_transaction_id = occ.matched_txn_id
    left join public.normalized_source_records pfc
      on pfc.id = tsl.normalized_source_record_id
    where s.household_id = p_household_id
      and public.keel_recurring_account_access(p_household_id, s.account_id, false)
    group by s.id, s.sign
  ) c;

  return jsonb_build_object(
    'scope', jsonb_build_object('householdId', p_household_id),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'formulaVersion', 'recurring-classification-v1',
    'rows', v_rows
  );
end;
$$;

create function public.keel_list_recurring_schedule_links(p_household_id uuid)
returns jsonb language plpgsql security definer stable set search_path = public as $$
declare
  v_rows jsonb;
  v_uid uuid := coalesce(
    nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
    nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid;
begin
  if v_uid is null then raise exception 'KEEL_NOT_AUTHENTICATED' using errcode = 'P0004'; end if;
  if not exists (select 1 from public.household_memberships
    where household_id = p_household_id and user_id = v_uid) then
    raise exception 'KEEL_SCOPE_VIOLATION' using errcode = 'P0006';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'linkId', l.id, 'seriesId', l.series_id, 'scheduleId', l.schedule_id
         ) order by l.series_id, l.schedule_id), '[]'::jsonb)
    into v_rows
  from public.recurring_series_schedule_links l
  join public.recurring_series s on s.household_id = l.household_id and s.id = l.series_id
  where l.household_id = p_household_id
    and l.detached_at is null
    and public.keel_recurring_account_access(p_household_id, s.account_id, false);
  return jsonb_build_object(
    'scope', jsonb_build_object('householdId', p_household_id),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'rows', v_rows
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. RLS + grants (mirror the recurring domain: authenticated read via access
-- gate; keel_api owns definers + all-access policy).
-- ---------------------------------------------------------------------------
alter table public.recurring_series_schedule_links enable row level security;
revoke all on public.recurring_series_schedule_links from public, anon, authenticated;
grant select on public.recurring_series_schedule_links to authenticated, service_role;
grant select, insert, update on public.recurring_series_schedule_links to keel_api;
create policy rssl_authorized_read on public.recurring_series_schedule_links for select to authenticated
  using (exists (select 1 from public.recurring_series s
    where s.household_id = recurring_series_schedule_links.household_id
      and s.id = recurring_series_schedule_links.series_id
      and public.keel_recurring_account_access(s.household_id, s.account_id, false)));
create policy rssl_api_all on public.recurring_series_schedule_links for all to keel_api using (true) with check (true);

grant create on schema public to keel_api;
alter function public.keel_rssl_guard() owner to keel_api;
alter function public.keel_recurring_link_schedule(uuid,text,jsonb,uuid,jsonb) owner to keel_api;
alter function public.keel_recurring_unlink_schedule(uuid,text,jsonb,uuid,jsonb) owner to keel_api;
alter function public.keel_recurring_classification(uuid) owner to keel_api;
alter function public.keel_list_recurring_schedule_links(uuid) owner to keel_api;
revoke create on schema public from keel_api;

revoke all on function public.keel_recurring_link_schedule(uuid,text,jsonb,uuid,jsonb),
  public.keel_recurring_unlink_schedule(uuid,text,jsonb,uuid,jsonb),
  public.keel_recurring_classification(uuid),
  public.keel_list_recurring_schedule_links(uuid) from public, anon;
grant execute on function public.keel_recurring_link_schedule(uuid,text,jsonb,uuid,jsonb),
  public.keel_recurring_unlink_schedule(uuid,text,jsonb,uuid,jsonb),
  public.keel_recurring_classification(uuid),
  public.keel_list_recurring_schedule_links(uuid) to authenticated;

-- keel_rssl_guard is a definer trigger; lock its direct EXECUTE down.
revoke all on function public.keel_rssl_guard() from public, anon, authenticated;

do $$begin
  if exists(select 1 from pg_roles where rolname='keel_api' and (rolcanlogin or rolbypassrls or rolsuper)) then
    raise exception 'KEEL_OWNERSHIP: recurring-link definer privileged'; end if;
  if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_roles r on r.oid=p.proowner
    where n.nspname='public' and p.proname in
      ('keel_recurring_link_schedule','keel_recurring_unlink_schedule','keel_recurring_classification',
       'keel_list_recurring_schedule_links','keel_rssl_guard') and p.prosecdef and r.rolname<>'keel_api') then
    raise exception 'KEEL_OWNERSHIP: recurring-link definer owner'; end if;
end$$;

-- ---------------------------------------------------------------------------
-- 5. Export chain: the link table is durable household data (Data Access
-- Guarantee, Law 6).
-- ---------------------------------------------------------------------------
grant select on public.recurring_series_schedule_links to keel_export;
create policy rssl_export on public.recurring_series_schedule_links for select to keel_export using (true);
alter function public.keel_export_household(uuid,timestamptz) rename to keel_export_household_pre_recurring_links;
revoke all on function public.keel_export_household_pre_recurring_links(uuid,timestamptz) from public,anon,authenticated,service_role;
create function public.keel_export_household(p_household_id uuid, p_as_of timestamptz default null)
returns jsonb language plpgsql security definer stable set search_path = pg_catalog, public as $$
declare v_base jsonb; v_tables jsonb; begin
  v_base := public.keel_export_household_pre_recurring_links(p_household_id, p_as_of);
  select jsonb_build_object(
    'recurring_series_schedule_links',
    coalesce((select jsonb_agg(to_jsonb(x) order by x.household_id, x.id)
      from public.recurring_series_schedule_links x where x.household_id = p_household_id),'[]'::jsonb)
  ) into v_tables;
  return jsonb_set(v_base, '{tables}', v_base->'tables' || v_tables);
end$$;
revoke all on function public.keel_export_household(uuid,timestamptz) from public,anon,authenticated,service_role;
grant create on schema public to keel_export;
alter function public.keel_export_household(uuid,timestamptz) owner to keel_export;
revoke create on schema public from keel_export;
grant execute on function public.keel_export_household(uuid,timestamptz) to service_role;
