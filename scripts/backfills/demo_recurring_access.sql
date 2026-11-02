-- One-off ops fix for the FICTIONAL demo household only (2026-11-02).
-- Household c7f53fdb-6283-453b-b3f6-963be73de434, login demo@mikul.com.
-- Run with the demo login's auth uid as a psql variable (looked up at run
-- time, never committed):  psql ... -v demo_uid=<auth.users.id> -f this-file
-- Never run against any other
-- household; the guards abort if the shape is not what we expect.
-- Applied to live through the supabase-keel MCP in the three steps below.
--
-- CAUSE 1 (nothing visible). recurring.list (keel_list_recurring) filters every
-- series through keel_recurring_account_access(), which requires the CALLER to
-- be an account_owner of the series' account (or hold a resource_permissions
-- grant). The demo was seeded table-direct on 2026-07-20 while signed in as the
-- real user, so all 9 demo accounts listed only that user in account_owners.
-- The demo login was later attached by household_membership alone, so it saw
-- zero series. Other read models check membership only, so Home still worked.
--
-- CAUSE 2 (nothing projected). The 5 "confirmed" series were inserted
-- table-direct with a cadenceAnchor shape the projector rejects
-- ({"kind":"day_of_month","days":[27]} instead of the detector contract
-- {"kind":"day_of_month","day":27,"intervalMonths":1,"phase":0}), and were
-- never run through the confirm transition, the only path that projects
-- recurring_occurrences. Candidate versions are immutable and confirmed series
-- keep their locked candidate, so these rows could never project. The real
-- detector had meanwhile found the same 5 merchants (plus 9 more) as valid
-- 'suggested' series on the same accounts.
--
-- FIX (no journal rows touched, no occurrence rows hand-written):
--   1. Add the demo user as an owner of each demo account (additive; the
--      stale rows for the real user stay; they grant nothing because that user
--      is not a member of this household). One audit_log row per account.
--   2. Queue a detection run through the worker (keel_force_recurring_redetect)
--      so candidates reflect the +3-month re-date. Drained by cron every 15 min.
--   3. As the demo user, via the sanctioned commands: recurring.cancel each
--      malformed seeded series, then recurring.confirm the detector's matching
--      series (90-day horizon, same as the web client). confirm projects the
--      occurrences.

-- ---------------------------------------------------------------- step 1 + 2
begin;
-- psql variables don't expand inside $$ bodies; hand the uid in via a GUC.
select set_config('keel.demo_uid', :'demo_uid', true);
do $$
begin
  if not exists (select 1 from public.household_memberships
     where household_id = 'c7f53fdb-6283-453b-b3f6-963be73de434'
       and user_id = current_setting('keel.demo_uid')::uuid and role = 'owner') then
    raise exception 'demo membership not as expected; aborting';
  end if;
  if (select count(*) from public.household_memberships
       where household_id = 'c7f53fdb-6283-453b-b3f6-963be73de434') <> 1 then
    raise exception 'demo household has unexpected members; aborting';
  end if;
end $$;

with added as (
  insert into public.account_owners (account_id, user_id)
  select a.id, :'demo_uid'::uuid
    from public.accounts a
   where a.household_id = 'c7f53fdb-6283-453b-b3f6-963be73de434'
     and not exists (select 1 from public.account_owners o
                      where o.account_id = a.id
                        and o.user_id = :'demo_uid')
  returning account_id
)
insert into public.audit_log (household_id, actor, action, object_type, object_id, before, after)
select 'c7f53fdb-6283-453b-b3f6-963be73de434',
       jsonb_build_object('kind', 'system', 'processName', 'ops:demo-recurring-access'),
       'accounts.owner_added', 'account', added.account_id, null,
       jsonb_build_object('userId', :'demo_uid'::text,
                          'reason', 'demo login attached by membership only; seed ran as another user')
  from added;

select public.keel_force_recurring_redetect('c7f53fdb-6283-453b-b3f6-963be73de434');
commit;

-- ---------------------------------------------------------------- step 3
-- Run after the detection job has drained (check recurring_candidate_versions
-- for an as_of later than the re-date).
begin;
select set_config('request.jwt.claim.sub', :'demo_uid', true);

-- seeded (malformed, confirmed) -> detector series on the same account + sign
create temp table demo_series_map on commit drop as
select a.id as seeded_id, b.id as detected_id
  from public.recurring_series a
  join public.recurring_series b
    on b.household_id = a.household_id and b.status = 'suggested'
   and b.account_id = a.account_id and b.sign = a.sign
   and (b.counterparty_key = a.counterparty_key
        or b.counterparty_key like a.counterparty_key || ' %')
 where a.household_id = 'c7f53fdb-6283-453b-b3f6-963be73de434'
   and a.status = 'confirmed';

do $$ begin
  if (select count(*) from demo_series_map) <> 5
     or (select count(distinct detected_id) from demo_series_map) <> 5 then
    raise exception 'expected a 1:1 map of 5 seeded -> detected series; aborting';
  end if;
end $$;

select m.seeded_id,
       public.keel_recurring_cancel(
         gen_random_uuid(), 'ops:demo-recurring:' || m.seeded_id || ':cancel', '{}'::jsonb,
         'c7f53fdb-6283-453b-b3f6-963be73de434',
         jsonb_build_object('series_id', m.seeded_id, 'effective_date', '2026-11-02')) ->> 'commandId'
  from demo_series_map m;

select m.detected_id,
       public.keel_recurring_confirm(
         gen_random_uuid(), 'ops:demo-recurring:' || m.detected_id || ':confirm', '{}'::jsonb,
         'c7f53fdb-6283-453b-b3f6-963be73de434',
         jsonb_build_object('series_id', m.detected_id, 'effective_date', '2026-11-02',
                            'horizon_days', '90')) ->> 'commandId'
  from demo_series_map m;
commit;
