-- fix(recurring): stop the outflow classifier from defaulting everything to
-- 'subscription' — map the full Plaid PFC primary taxonomy and add a neutral
-- 'recurring' bucket for generic recurring expenses.
--
-- GAP-2 from the end-to-end validation (2026-07-19): the outflow branch in
-- 20260719110000 mapped only 7 PFC primaries and fell through
-- `else 'subscription'` for everything else — including a NULL dominant PFC
-- (no matched occurrences at all, which is the live state for EVERY series in
-- the founder household today: recurring_occurrences.matched_txn_id is null
-- across the board, so dominant_pfc is null for all 56 series) and unmapped
-- primaries like TRANSPORTATION, FOOD_AND_DRINK, GENERAL_MERCHANDISE,
-- PERSONAL_CARE, TRAVEL. Result: a recurring rideshare P2P outflow, a grocery
-- store, and a recurring Zelle-to-person all rendered with the "Subscriptions"
-- label. "Subscription" is a strong product claim (an opt-in plan you could
-- cancel); asserting it with zero PFC evidence violates explicit ownership
-- (Law 9 / BC-v2.1 §9.1 — inference never silently treated as fact).
--
-- Change (only the outflow bucket CASE; everything else byte-identical to
-- 20260719110000): map every Plaid personal_finance_category primary
-- deterministically (Law 1 — pure enum lookup, no model calls), and route the
-- null/unknown/dead-taxonomy fallback to a new neutral bucket 'recurring'
-- (generic recurring expense — a claim of cadence only, which IS evidenced by
-- the detector, never of kind, which isn't).
--
-- PFC primary -> bucket (outflow series only; TRANSFER_* handled earlier):
--   RENT_AND_UTILITIES        -> 'utility'      (unchanged; rent+utility share one primary — detailed labels are not stored)
--   LOAN_PAYMENTS             -> 'bill'         (unchanged; debt obligations)
--   GOVERNMENT_AND_NON_PROFIT -> 'bill'         (unchanged; taxes/fines/donation pledges)
--   INSURANCE                 -> 'bill'         (unchanged; legacy primary kept for old snapshots)
--   MEDICAL                   -> 'bill'         (unchanged; obligations, not opt-in plans)
--   BANK_FEES                 -> 'bill'         (NEW; a recurring account/service fee is an obligation-style charge, not an opt-in plan)
--   ENTERTAINMENT             -> 'subscription' (unchanged; recurring entertainment = streaming/gaming plans)
--   GENERAL_SERVICES          -> 'subscription' (unchanged; recurring service plans — storage, software, security)
--   TRANSPORTATION            -> 'recurring'    (NEW; recurring rideshare/parking/tolls = habitual spend, not a plan or a bill)
--   FOOD_AND_DRINK            -> 'recurring'    (NEW; recurring groceries/coffee = habitual spend)
--   GENERAL_MERCHANDISE       -> 'recurring'    (NEW; primary alone can't distinguish a subscription box from routine shopping)
--   PERSONAL_CARE             -> 'recurring'    (NEW; primary alone can't distinguish a gym membership from a recurring salon visit)
--   TRAVEL                    -> 'recurring'    (NEW; habitual spend)
--   HOME_IMPROVEMENT          -> 'recurring'    (NEW; habitual spend / repeat services)
--   LOAN_DISBURSEMENTS        -> 'recurring'    (NEW; a disbursement-tagged outflow is anomalous — never assert 'bill' or 'subscription' from it)
--   INCOME                    -> 'recurring'    (NEW; an income-tagged outflow is anomalous — same rule)
--   OTHER / null / unknown    -> 'recurring'    (NEW fallback; no kind evidence -> no kind claim)
--
-- formulaVersion bumps to 'recurring-classification-v4-outflow-buckets'
-- (Law 9: reproducible numbers — consumers can tell which mapping produced a
-- row). Definer owner/grants re-asserted exactly as 20260719110000 does.

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
             when mode() within group (order by pfc.pfc_primary)
                    filter (where pfc.pfc_primary is not null and pfc.pfc_primary <> '')
                  in ('TRANSFER_IN', 'TRANSFER_OUT') then 'excluded'
             when s.sign = 'inflow' then
               -- PAYROLL / WAGES only. Positive tokens must be payroll-specific:
               -- an unambiguous payroll word, direct-deposit, or a major payroll
               -- provider -- NOT the generic ACH `ppd id` batch tag. The negative
               -- guard rejects non-wage income (dividend/interest/spaxx), P2P
               -- rails (zelle/venmo/cash app/paypal), and government/refund credits
               -- (tax ref/treas/irs/gov/reimburs). Everything else inflow -> income.
               case
                 when s.counterparty_key ~* '(payroll|salary|wages?|direct dep|dir dep|dir/dep|paycheck|paychex|\madp\M|gusto)'
                  and s.counterparty_key !~* '(dividend|interest|redemption|spaxx|refund|cashback|reward|rebate|zelle|venmo|cash app|paypal|tax ref|treas|\mirs\M|\mgov\M|reimburs)'
                   then 'paycheck'
                 else 'income'
               end
             else case mode() within group (order by pfc.pfc_primary)
                    filter (where pfc.pfc_primary is not null and pfc.pfc_primary <> '')
               -- Rent + utilities share one Plaid primary (detailed labels are
               -- not stored) -- one 'utility' bucket for both.
               when 'RENT_AND_UTILITIES' then 'utility'
               -- Obligation-style charges you owe rather than opt into.
               when 'LOAN_PAYMENTS' then 'bill'
               when 'GOVERNMENT_AND_NON_PROFIT' then 'bill'
               when 'INSURANCE' then 'bill'
               when 'MEDICAL' then 'bill'
               when 'BANK_FEES' then 'bill'
               -- Opt-in recurring plans: streaming/gaming and service plans.
               when 'ENTERTAINMENT' then 'subscription'
               when 'GENERAL_SERVICES' then 'subscription'
               -- Habitual spend at a fixed cadence: cadence is evidenced by the
               -- detector, kind is not -- claim neither 'bill' nor
               -- 'subscription'. Recurring rideshare (TRANSPORTATION) is the
               -- canonical case: a recurring expense, not a plan.
               when 'TRANSPORTATION' then 'recurring'
               when 'FOOD_AND_DRINK' then 'recurring'
               when 'GENERAL_MERCHANDISE' then 'recurring'
               when 'PERSONAL_CARE' then 'recurring'
               when 'TRAVEL' then 'recurring'
               when 'HOME_IMPROVEMENT' then 'recurring'
               -- Anomalous tags on an outflow (disbursement/income) and the
               -- catch-all OTHER carry no kind evidence.
               when 'LOAN_DISBURSEMENTS' then 'recurring'
               when 'INCOME' then 'recurring'
               -- Null dominant PFC (no matched occurrences yet), 'OTHER', or a
               -- primary this taxonomy doesn't know: no kind claim.
               else 'recurring'
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
    'formulaVersion', 'recurring-classification-v4-outflow-buckets',
    'rows', v_rows
  );
end;
$$;

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
