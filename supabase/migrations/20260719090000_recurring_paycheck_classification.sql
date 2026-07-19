-- Distinguish PAYROLL (paychecks) from other recurring income, surface paychecks
-- on both the Recurring/Review and Paychecks pages, and let a detected paycheck
-- occurrence be DECLINED (soft-hidden) while keeping the employer + latest
-- detected deposit as the prefill template.
--
-- Two backend pieces here:
--   1. keel_recurring_classification gains a 'paycheck' bucket for INFLOW series
--      that are payroll/wages, keeping non-payroll inflows (dividends, interest,
--      other) as plain 'income'. Deterministic SQL, no LLM (Law 1).
--   2. detected_paycheck_dismissals (soft-state, user directive 2026-07-17) +
--      keel_cmd_dismiss_detected_paycheck (envelope-shaped, append-only,
--      idempotent, audited) to persist a declined detected-paycheck occurrence.
--
-- ---------------------------------------------------------------------------
-- WHY the rule is keyed off the counterparty token, not Plaid's detailed PFC.
-- ---------------------------------------------------------------------------
-- Verified on the live founder household (2026-07-19). KEEL denormalizes only
-- Plaid's PFC *primary* (normalized_source_records.pfc_primary); the detailed
-- sub-label (INCOME_WAGES vs INCOME_DIVIDENDS) is NOT stored anywhere queryable.
-- On the real data the primary is identical for both classes:
--     "deeptune payroll ppd id: ..."          -> pfc_primary = INCOME   (wages)
--     "rillavoice inc payroll ppd id: ..."     -> pfc_primary = INCOME   (wages)
--     "dividend received ... spaxx (cash)"     -> pfc_primary = INCOME   (dividend)
-- So PFC primary CANNOT separate a paycheck from a dividend -- both are INCOME.
-- The deterministic discriminator that IS available is the series'
-- counterparty_key (the detector's normalized merchant/memo fingerprint):
-- payroll deposits carry an unambiguous payroll token (payroll / salary / wages
-- / direct dep / ppd id), dividends/interest carry their own terms. We therefore
-- classify a payroll INFLOW as 'paycheck' when its counterparty_key matches a
-- payroll token AND does not match a dividend/interest/refund/P2P term; PFC is
-- kept ONLY as a negative guard (a TRANSFER_IN/OUT dominant PFC still routes to
-- 'excluded' first, exactly as before, so a mislabeled transfer can never be a
-- paycheck). This is pure calendar/string logic over data already on the row --
-- Law 1 (no model arithmetic), reproducible, replay-safe.
--
-- The proc SIGNATURE is unchanged (uuid -> jsonb): CREATE OR REPLACE keeps the
-- ACL; ownership + grants are re-asserted to match 20260718161000 / 20260719010000
-- exactly (definer owned by keel_api, execute to authenticated only).

-- ---------------------------------------------------------------------------
-- 1. Classifier: add the 'paycheck' bucket for payroll inflows.
-- ---------------------------------------------------------------------------
create or replace function public.keel_recurring_classification(p_household_id uuid)
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
             -- C: personal P2P transfers are never a subscription OR income, on
             -- either sign. Plaid classifies Venmo/Zelle/Cash App/PayPal-personal
             -- as TRANSFER_IN / TRANSFER_OUT. Route them to 'excluded' first, so
             -- neither the income nor the subscription lane offers them. (This
             -- also guards the paycheck rule: a payroll-token series whose money
             -- is really a transfer can never become a 'paycheck'.)
             when mode() within group (order by pfc.pfc_primary)
                    filter (where pfc.pfc_primary is not null and pfc.pfc_primary <> '')
                  in ('TRANSFER_IN', 'TRANSFER_OUT') then 'excluded'
             when s.sign = 'inflow' then
               -- PAYROLL / WAGES only. A paycheck's counterparty_key carries an
               -- unambiguous payroll token ('payroll', 'salary', 'wages',
               -- 'direct dep'/'dir dep', 'ppd id', 'paychex'/'adp'/'gusto') and
               -- NOT a non-wage income term (dividend/interest/redemption/spaxx)
               -- or a P2P rail (zelle/venmo/cash app). Everything else that is an
               -- inflow (dividends, interest, other) stays plain 'income'.
               case
                 when s.counterparty_key ~* '(payroll|salary|wages?|direct dep|dir dep|dir/dep|paycheck|ppd id|paychex|\madp\M|gusto)'
                  and s.counterparty_key !~* '(dividend|interest|redemption|spaxx|refund|cashback|reward|rebate|zelle|venmo|cash app|paypal)'
                   then 'paycheck'
                 else 'income'
               end
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
    group by s.id, s.sign, s.counterparty_key
  ) c;

  return jsonb_build_object(
    'scope', jsonb_build_object('householdId', p_household_id),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'formulaVersion', 'recurring-classification-v3-paycheck',
    'rows', v_rows
  );
end;
$$;

-- Re-assert ownership + grants exactly (definer owned by keel_api).
grant create on schema public to keel_api;
alter function public.keel_recurring_classification(uuid) owner to keel_api;
revoke create on schema public from keel_api;
revoke all on function public.keel_recurring_classification(uuid) from public, anon;
grant execute on function public.keel_recurring_classification(uuid) to authenticated;

do $$begin
  if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_roles r on r.oid=p.proowner
    where n.nspname='public' and p.proname = 'keel_recurring_classification'
      and p.prosecdef and r.rolname<>'keel_api') then
    raise exception 'KEEL_OWNERSHIP: recurring-classification definer owner'; end if;
end$$;

-- ---------------------------------------------------------------------------
-- 2. Declined detected-paycheck occurrences (soft-state).
-- ---------------------------------------------------------------------------
-- A DECLINE hides ONE detected occurrence (employer + occurrence_date) from the
-- Paychecks page's "detected paychecks" section. It does NOT mute the employer:
-- the recurring series, its occurrences, and any recorded paychecks are
-- untouched, so the latest detected deposit still prefills the next real one.
-- Keyed by a normalized employer_key (lower(trim(counterparty_key))) so it
-- matches the same way the page joins detected income to employer templates.
create table public.detected_paycheck_dismissals (
  household_id uuid not null references public.households(id),
  id uuid not null default gen_random_uuid(),
  series_id uuid not null,
  employer_key text not null check (length(employer_key) between 1 and 200),
  occurrence_date date not null,
  dismissed_by uuid not null references auth.users(id),
  command_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (household_id, id),
  constraint fk_dpd_series_tenant foreign key (household_id, series_id)
    references public.recurring_series(household_id, id) on delete restrict
);
-- At most one dismissal per (employer_key, occurrence_date): declining the same
-- occurrence twice is a no-op (idempotent economics).
create unique index detected_paycheck_dismissals_unique
  on public.detected_paycheck_dismissals(household_id, employer_key, occurrence_date);

-- Immutable + never hard-deleted (there is no "un-decline" delete: the user
-- simply records the paycheck, which is a separate positive fact). Blocks
-- UPDATE/DELETE the same way the recurring link table does.
create function public.keel_dpd_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  raise exception 'KEEL_IMMUTABLE: detected-paycheck dismissals are append-only'
    using errcode = 'P0010';
end;
$$;
create trigger detected_paycheck_dismissals_guard
  before update or delete on public.detected_paycheck_dismissals
  for each row execute function public.keel_dpd_guard();

-- ---------------------------------------------------------------------------
-- 3. Decline command (envelope-shaped, class-B user fact: suggest->approve; the
-- user is approving "not this occurrence"). Append-only, idempotent by
-- economic_event_key, audited via keel_finish_command.
-- ---------------------------------------------------------------------------
create function public.keel_cmd_dismiss_detected_paycheck(
  p_command_id uuid, p_economic_event_key text, p_actor jsonb, p_household_id uuid, p_payload jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_hash text := public.keel_payload_hash(p_payload); v_replay jsonb; v_actor jsonb;
  v_series public.recurring_series%rowtype; v_id uuid := gen_random_uuid();
  v_employer_key text; v_occ_date date; v_after jsonb; v_result jsonb;
begin
  perform public.keel_assert_member_write(p_household_id);
  v_actor := public.keel_actor_from_jwt();
  v_replay := public.keel_idempotency_check(p_household_id, p_economic_event_key, v_hash);
  if v_replay is not null then return v_replay; end if;
  if jsonb_typeof(p_payload) <> 'object'
     or (p_payload - 'series_id' - 'occurrence_date') <> '{}'::jsonb
     or coalesce(p_payload->>'series_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or coalesce(p_payload->>'occurrence_date','') !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception 'KEEL_INVALID_COMMAND: malformed dismiss payload' using errcode = 'P0009';
  end if;
  select * into v_series from public.recurring_series
   where household_id = p_household_id and id = (p_payload->>'series_id')::uuid for update;
  if not found or not public.keel_recurring_account_access(p_household_id, v_series.account_id, true) then
    raise exception 'KEEL_SCOPE_VIOLATION: recurring series not found' using errcode = 'P0006';
  end if;
  -- Only an INFLOW series can be a detected paycheck.
  if v_series.sign <> 'inflow' then
    raise exception 'KEEL_INVALID_COMMAND: only an inflow series has detected paychecks' using errcode = 'P0009';
  end if;
  v_employer_key := lower(btrim(v_series.counterparty_key));
  v_occ_date := (p_payload->>'occurrence_date')::date;

  insert into public.detected_paycheck_dismissals
    (household_id, id, series_id, employer_key, occurrence_date, dismissed_by, command_id)
  values (p_household_id, v_id, v_series.id, v_employer_key, v_occ_date, (v_actor->>'userId')::uuid, p_command_id)
  on conflict (household_id, employer_key, occurrence_date) do nothing;

  -- Whether or not this exact occurrence was already dismissed, the effect is
  -- the same declared fact; report the persisted row's id for the audit trail.
  select id into v_id from public.detected_paycheck_dismissals
   where household_id = p_household_id and employer_key = v_employer_key and occurrence_date = v_occ_date;

  v_after := jsonb_build_object('dismissalId', v_id, 'seriesId', v_series.id,
    'employerKey', v_employer_key, 'occurrenceDate', to_char(v_occ_date, 'YYYY-MM-DD'));
  v_result := jsonb_build_object('commandId', p_command_id, 'economicEventKey', p_economic_event_key,
    'idempotentReplay', false, 'effects', v_after,
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'));
  perform public.keel_finish_command(p_command_id, 'paychecks.dismiss_detected', p_economic_event_key,
    p_household_id, v_actor, v_hash, 'paychecks.detected_dismissed', 'detected_paycheck_dismissal', v_id, v_after, v_result);
  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Read model: list all dismissals so the Paychecks page can exclude them.
-- Small, household-scoped, definer + membership check like its siblings.
-- ---------------------------------------------------------------------------
create function public.keel_list_detected_paycheck_dismissals(p_household_id uuid)
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
           'dismissalId', d.id, 'seriesId', d.series_id,
           'employerKey', d.employer_key,
           'occurrenceDate', to_char(d.occurrence_date, 'YYYY-MM-DD')
         ) order by d.employer_key, d.occurrence_date), '[]'::jsonb)
    into v_rows
  from public.detected_paycheck_dismissals d
  join public.recurring_series s on s.household_id = d.household_id and s.id = d.series_id
  where d.household_id = p_household_id
    and public.keel_recurring_account_access(p_household_id, s.account_id, false);
  return jsonb_build_object(
    'scope', jsonb_build_object('householdId', p_household_id),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'rows', v_rows
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. RLS + grants (mirror the recurring domain exactly).
-- ---------------------------------------------------------------------------
alter table public.detected_paycheck_dismissals enable row level security;
revoke all on public.detected_paycheck_dismissals from public, anon, authenticated;
grant select on public.detected_paycheck_dismissals to authenticated, service_role;
grant select, insert on public.detected_paycheck_dismissals to keel_api;
create policy dpd_authorized_read on public.detected_paycheck_dismissals for select to authenticated
  using (exists (select 1 from public.recurring_series s
    where s.household_id = detected_paycheck_dismissals.household_id
      and s.id = detected_paycheck_dismissals.series_id
      and public.keel_recurring_account_access(s.household_id, s.account_id, false)));
create policy dpd_api_all on public.detected_paycheck_dismissals for all to keel_api using (true) with check (true);

grant create on schema public to keel_api;
alter function public.keel_dpd_guard() owner to keel_api;
alter function public.keel_cmd_dismiss_detected_paycheck(uuid,text,jsonb,uuid,jsonb) owner to keel_api;
alter function public.keel_list_detected_paycheck_dismissals(uuid) owner to keel_api;
revoke create on schema public from keel_api;

revoke all on function public.keel_cmd_dismiss_detected_paycheck(uuid,text,jsonb,uuid,jsonb),
  public.keel_list_detected_paycheck_dismissals(uuid) from public, anon;
grant execute on function public.keel_cmd_dismiss_detected_paycheck(uuid,text,jsonb,uuid,jsonb),
  public.keel_list_detected_paycheck_dismissals(uuid) to authenticated;
-- keel_dpd_guard is a definer trigger; lock its direct EXECUTE down.
revoke all on function public.keel_dpd_guard() from public, anon, authenticated;

do $$begin
  if exists(select 1 from pg_roles where rolname='keel_api' and (rolcanlogin or rolbypassrls or rolsuper)) then
    raise exception 'KEEL_OWNERSHIP: dismiss-detected definer privileged'; end if;
  if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_roles r on r.oid=p.proowner
    where n.nspname='public' and p.proname in
      ('keel_cmd_dismiss_detected_paycheck','keel_list_detected_paycheck_dismissals','keel_dpd_guard')
      and p.prosecdef and r.rolname<>'keel_api') then
    raise exception 'KEEL_OWNERSHIP: dismiss-detected definer owner'; end if;
end$$;

-- ---------------------------------------------------------------------------
-- 6. Export chain: dismissals are durable household data (Data Access
-- Guarantee, Law 6).
-- ---------------------------------------------------------------------------
grant select on public.detected_paycheck_dismissals to keel_export;
create policy dpd_export on public.detected_paycheck_dismissals for select to keel_export using (true);
alter function public.keel_export_household(uuid,timestamptz) rename to keel_export_household_pre_paycheck_dismissals;
revoke all on function public.keel_export_household_pre_paycheck_dismissals(uuid,timestamptz) from public,anon,authenticated,service_role;
create function public.keel_export_household(p_household_id uuid, p_as_of timestamptz default null)
returns jsonb language plpgsql security definer stable set search_path = pg_catalog, public as $$
declare v_base jsonb; v_tables jsonb; begin
  v_base := public.keel_export_household_pre_paycheck_dismissals(p_household_id, p_as_of);
  select jsonb_build_object(
    'detected_paycheck_dismissals',
    coalesce((select jsonb_agg(to_jsonb(x) order by x.household_id, x.id)
      from public.detected_paycheck_dismissals x where x.household_id = p_household_id),'[]'::jsonb)
  ) into v_tables;
  return jsonb_set(v_base, '{tables}', v_base->'tables' || v_tables);
end$$;
revoke all on function public.keel_export_household(uuid,timestamptz) from public,anon,authenticated,service_role;
grant create on schema public to keel_export;
alter function public.keel_export_household(uuid,timestamptz) owner to keel_export;
revoke create on schema public from keel_export;
grant execute on function public.keel_export_household(uuid,timestamptz) to service_role;
