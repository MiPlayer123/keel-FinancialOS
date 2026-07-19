-- docs/RECURRING-RESEARCH.md item C (SQL half): teach the recurring classifier
-- to mark personal peer-to-peer transfers as EXCLUDED, so a legacy candidate
-- (detected before recurring-grid-v2 / counterparty-v2 suppression) is still
-- routed OUT of the subscription surface.
--
-- The detector (packages/detectors, recurring-grid-v2 + counterparty-v2) already
-- SUPPRESSES P2P rails and reward/refund lines at detection, so under v2 these
-- never become candidates in the first place. This migration is the defense-in-
-- depth / legacy-row half: any recurring_series that already exists whose matched
-- transactions are dominantly Plaid TRANSFER_IN / TRANSFER_OUT (the P2P PFC
-- primaries) is classified into a new 'excluded' bucket. The Recurring page hides
-- 'excluded' from both the subscription and income lanes.
--
-- This is SUGGESTION SUPPRESSION, not deletion (Law 6): the series row, its
-- occurrences, and the underlying ledger transactions are untouched and remain in
-- every read model and in full export. Only the *bucket label* changes, and only
-- the UI's grouping reacts to it.
--
-- No table or column changes → no pgTAP 008 allowlist change and no export-chain
-- change required. Deterministic SQL, no LLM (Law 1). The proc SIGNATURE is
-- unchanged (uuid → jsonb), so the old body is replaced via CREATE OR REPLACE;
-- ownership and grants are re-asserted to match 20260718161000 exactly.
--
-- FILE ONLY — do not apply to any remote DB. Validated on a throwaway local
-- stack (supabase start → db reset) and against the full pgTAP suite.

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
             -- neither the income nor the subscription lane offers them.
             when mode() within group (order by pfc.pfc_primary)
                    filter (where pfc.pfc_primary is not null and pfc.pfc_primary <> '')
                  in ('TRANSFER_IN', 'TRANSFER_OUT') then 'excluded'
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
    'formulaVersion', 'recurring-classification-v2',
    'rows', v_rows
  );
end;
$$;

-- Re-assert ownership + grants to match the original (definer owned by keel_api).
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
