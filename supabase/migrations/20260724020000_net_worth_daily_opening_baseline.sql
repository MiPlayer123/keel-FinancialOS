-- Fix: the net-worth-over-time chart (keel_net_worth_daily v1) rebuilt history as a
-- plain cumulative sum of every asset/liability posting BY ITS effective_date. But
-- opening-balance anchors are posted dated at the moment the account was connected /
-- re-anchored (all of this household's are 2026-07-18..20), not when the money
-- existed. So the running total showed only transaction flows for months (~$15k,
-- dipping NEGATIVE where credit-card liabilities were the only counted rows) and then
-- CLIFFED up ~$80k on 07-18/19 as the opening anchors landed. The founder's net worth
-- was never ~$0 — the reconstruction was wrong, not the data.
--
-- Root cause confirmed live: every non-transaction batch (canonical_transaction_id IS
-- NULL) for the household is an opening-balance anchor ('Opening balance',
-- 'Opening balance (re-anchored)') or its re-anchoring reversal — all dated in the
-- last 3 days. An opening anchor is a PRE-transaction starting balance (anchor + the
-- account's transactions reconcile to its current balance), so temporally it belongs
-- at/behind the earliest activity, not on the connection date.
--
-- Fix (v2): date opening-balance postings (canonical_transaction_id IS NULL) at
-- LEAST(effective_date, p_from) — i.e. seed them as a baseline at the window start —
-- while real transactions (canonical_transaction_id IS NOT NULL) keep their true
-- effective_date. Cumulative-sum's final value is order-independent, so the AS-OF
-- (today) net worth is byte-identical (verified live: $96,568.88 before and after);
-- only the intermediate daily history straightens out. Re-anchoring reversals also
-- carry NULL canonical_transaction_id, so they shift to the same baseline and net
-- against their originals correctly. Deterministic, BIGINT minor (Laws 1, 4);
-- reproducible formulaVersion bump (Law 9). This also subsumes the one-day Fidelity
-- LLC anchor blip (was tracked separately) — the anchor is now baseline, no cliff.
--
-- Ownership/grants unchanged from v1 (SECURITY DEFINER; no owner change, so no
-- grant-drift wrapper needed). Auth + range guards preserved verbatim.

create or replace function public.keel_net_worth_daily(p_household_id uuid, p_from date, p_to date)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare
  v_uid uuid := coalesce(
    nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
    nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid;
  v_rows jsonb;
begin
  if v_uid is null then
    raise exception 'KEEL_NOT_AUTHENTICATED' using errcode = 'P0004';
  end if;
  if not exists (
    select 1 from public.household_memberships m
     where m.household_id = p_household_id and m.user_id = v_uid
  ) then
    raise exception 'KEEL_SCOPE_VIOLATION' using errcode = 'P0006';
  end if;
  if p_from > p_to or p_to - p_from > 366 then
    raise exception 'KEEL_INVALID_RANGE' using errcode = 'P0001';
  end if;

  with flows as (
    select
      -- Opening-balance anchors (no canonical txn) are a starting baseline: pull
      -- them back to the window start so the account is counted throughout, instead
      -- of appearing as connection-day income. Real transactions keep their date.
      case when b.canonical_transaction_id is null
           then least(b.effective_date, p_from)
           else b.effective_date end as d,
      p.currency, sum(p.amount_minor)::bigint as amt
      from public.journal_postings p
      join public.journal_batches b on b.id = p.batch_id
      join public.ledger_accounts la on la.id = p.ledger_account_id
      where b.household_id = p_household_id
        and b.effective_date <= p_to
        and la.kind in ('asset', 'liability')
        and not exists (
          select 1 from public.accounts a
           where a.ledger_account_id = p.ledger_account_id
             and a.archived_at is not null
        )
      group by 1, 2
  ),
  currencies as (select distinct currency from flows),
  days as (
    select generate_series(
      least(p_from, coalesce((select min(d) from flows), p_from)),
      p_to, interval '1 day'
    )::date as d
  ),
  cum as (
    select g.d, g.currency,
           sum(coalesce(f.amt, 0)) over (partition by g.currency order by g.d) as bal
      from (select days.d, c.currency from days cross join currencies c) g
      left join flows f on f.d = g.d and f.currency = g.currency
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'date', to_char(d, 'YYYY-MM-DD'),
           'currency', currency,
           'balanceMinor', bal::text
         ) order by d, currency), '[]'::jsonb)
    into v_rows
    from cum
    where d >= p_from;

  return jsonb_build_object(
    'scope', jsonb_build_object('householdId', p_household_id),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'formulaVersion', 'net-worth-daily-v2',
    'rows', v_rows
  );
end;
$function$;
