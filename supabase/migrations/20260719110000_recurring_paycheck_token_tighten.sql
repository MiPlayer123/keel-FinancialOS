-- fix(recurring): tighten the payroll classifier so generic ACH credits and
-- recurring tax refunds are NOT mislabeled 'paycheck'.
--
-- GAP-1 from the end-to-end validation (2026-07-19): the inflow paycheck rule in
-- 20260719090000 accepted a bare `ppd id` (the generic ACH "Prearranged Payment
-- and Deposit" batch tag — present on payroll AND on countless non-payroll ACH
-- credits) as a payroll signal, and its negative guard lacked tax/government
-- terms. So a *recurring* IRS tax refund ("IRS TREAS 310 TAX REF ... PPD ID") or a
-- generic vendor ACH credit could classify as 'paycheck'. No live founder data
-- trips this today (all real payroll literally contains "payroll"), but it would
-- mislabel paychecks for other users — and "paycheck = payroll only" is the
-- product rule. Low blast radius (class-B suggest→approve; a wrong "paycheck" is
-- declinable and posts nothing), but worth hardening for generalizability.
--
-- Change (only the inflow discriminator; everything else byte-identical to
-- 20260719090000):
--   * positive tokens: DROP bare `ppd id` (too generic). Keep the unambiguous
--     payroll words + direct-deposit + the big payroll providers.
--   * negative guard: ADD tax/government/refund terms (tax ref | treas | \mirs\M |
--     \mgov\M | reimburs) so anything that reads like a government/refund credit
--     can never be a paycheck even if it says "direct dep".
-- Deterministic string logic (Law 1). Definer owner/grants re-asserted exactly.

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
