-- fix(cash-flow): net out reversed/superseded journal batches in the cash-flow
-- read models (keel_cash_flow v8, keel_cash_flow_monthly v7).
-- Stage 2 / BC-v2.1 §9.1 (reversible correction + reproducible numbers).
--
-- PROBLEM. Every correction on the spine is a reversal batch (reverses_batch_id
-- -> the original) plus, for re-dates/revisions, a replacement batch. v7/v6
-- split category postings into money-in / money-out by posting SIGN (see
-- 20260722320000). A reversal of an expense is a CREDIT to the expense
-- category, so it was counted as money IN, while the original it cancels was
-- still counted as money OUT. Net was right; both gross bars were inflated by
-- the full amount of every corrected transaction.
--
-- Found on the demo household (c7f53fdb…) after it was re-dated +3 months with
-- keel_cmd_set_date (one reversal + one replacement per transaction): May-2026
-- held 47 reversed originals + 47 reversals and ZERO live batches, yet the
-- monthly chart showed ~$36K in and ~$36K out of phantom activity. Any user who
-- re-dates, re-categorizes via revision, or voids a transaction hits the same
-- gross inflation in that month.
--
-- FIX. Before the sign split, drop BOTH sides of every reversal pair:
--   * the reversal batch itself (reverses_batch_id is not null), and
--   * any batch that a reversal batch points at (it has been superseded).
-- The replacement batch (if any) is an ordinary live batch and still counts on
-- its own date.
--
-- INVARIANTS (validated read-only against live before authoring, 2026-11-02):
--   * All 1,192 reversal pairs on live mirror their original exactly (per
--     ledger account + currency the pair sums to 0) and share its
--     effective_date; no batch is reversed twice. So excluding a pair removes
--     exactly 0 from every month's NET — net is identical to v7/v6; only the
--     gross inflow/outflow drop by the phantom amount.
--   * Exclusions from v7/v6 (confirmed transfers, non-income settlements,
--     transfer-category overlays) are unchanged and still applied first.
--   * No journal rows are touched (read model only); BIGINT minor units, no
--     floats (Law 1, Law 4).
--
-- Ownership/grants re-asserted exactly as 20260722320000 did.

create index if not exists journal_batches_reverses_batch
  on public.journal_batches (reverses_batch_id)
  where reverses_batch_id is not null;

create or replace function public.keel_cash_flow(p_household_id uuid, p_from date, p_to date)
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
  if p_from > p_to then
    raise exception 'KEEL_INVALID_RANGE' using errcode = 'P0001';
  end if;

  select coalesce(jsonb_agg(row order by row->>'currency'), '[]'::jsonb) into v_rows
    from (
      select jsonb_build_object(
        'currency', dir.currency,
        -- CASH DIRECTION (v7): credit to a category (< 0) = inflow; debit (> 0) = outflow.
        'inflowMinor', coalesce(-sum(dir.amount_minor) filter (where dir.amount_minor < 0), 0)::text,
        'outflowMinor', coalesce(sum(dir.amount_minor) filter (where dir.amount_minor > 0), 0)::text,
        'netMinor', (
          coalesce(-sum(dir.amount_minor) filter (where dir.amount_minor < 0), 0)
          - coalesce(sum(dir.amount_minor) filter (where dir.amount_minor > 0), 0)
        )::text
      ) as row
      from (
        select p.currency, p.amount_minor
        from public.journal_postings p
        join public.journal_batches b on b.id = p.batch_id
        join public.ledger_accounts offcat
          on offcat.id = p.ledger_account_id and offcat.is_category = true
        where b.household_id = p_household_id
          and b.effective_date between p_from and p_to
          -- v8: corrections net out. Drop reversal batches and the batches
          -- they reverse; replacements count as ordinary live batches.
          and b.reverses_batch_id is null
          and not exists (
            select 1 from public.journal_batches rv
            where rv.reverses_batch_id = b.id
          )
          -- EXCLUSIONS, UNCHANGED FROM v6/v7:
          and not exists (
            select 1 from public.transfer_links tl
            where tl.household_id = p_household_id
              and tl.status = 'confirmed'
              and (tl.txn_out = b.canonical_transaction_id
                   or tl.txn_in = b.canonical_transaction_id)
          )
          and not public.keel_is_non_income_settlement(b.household_id, b.canonical_transaction_id)
          and (b.canonical_transaction_id is null
               or not public.keel_txn_is_transfer_category(p_household_id, b.canonical_transaction_id))
      ) dir
      group by dir.currency
    ) t;

  return jsonb_build_object(
    'scope', jsonb_build_object('householdId', p_household_id),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'formulaVersion', 'cash-flow-v8-net-reversals',
    'rows', v_rows
  );
end;
$function$;

create or replace function public.keel_cash_flow_monthly(p_household_id uuid, p_from date, p_to date)
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
  if p_from > p_to or p_to - p_from > 750 then
    raise exception 'KEEL_INVALID_RANGE' using errcode = 'P0001';
  end if;

  select coalesce(jsonb_agg(row order by row->>'month', row->>'currency'), '[]'::jsonb)
    into v_rows
    from (
      select jsonb_build_object(
        'month', to_char(dir.month, 'YYYY-MM'),
        'currency', dir.currency,
        'inflowMinor', coalesce(-sum(dir.amount_minor) filter (where dir.amount_minor < 0), 0)::text,
        'outflowMinor', coalesce(sum(dir.amount_minor) filter (where dir.amount_minor > 0), 0)::text,
        'netMinor', (
          coalesce(-sum(dir.amount_minor) filter (where dir.amount_minor < 0), 0)
          - coalesce(sum(dir.amount_minor) filter (where dir.amount_minor > 0), 0)
        )::text
      ) as row
      from (
        select date_trunc('month', b.effective_date) as month, p.currency, p.amount_minor
        from public.journal_postings p
        join public.journal_batches b on b.id = p.batch_id
        join public.ledger_accounts offcat
          on offcat.id = p.ledger_account_id and offcat.is_category = true
        where b.household_id = p_household_id
          and b.effective_date between p_from and p_to
          -- v7: corrections net out (see keel_cash_flow).
          and b.reverses_batch_id is null
          and not exists (
            select 1 from public.journal_batches rv
            where rv.reverses_batch_id = b.id
          )
          -- EXCLUSIONS, UNCHANGED FROM v6. See keel_cash_flow.
          and not exists (
            select 1 from public.transfer_links tl
            where tl.household_id = p_household_id
              and tl.status = 'confirmed'
              and (tl.txn_out = b.canonical_transaction_id
                   or tl.txn_in = b.canonical_transaction_id)
          )
          and not public.keel_is_non_income_settlement(b.household_id, b.canonical_transaction_id)
          and (b.canonical_transaction_id is null
               or not public.keel_txn_is_transfer_category(p_household_id, b.canonical_transaction_id))
      ) dir
      group by dir.month, dir.currency
    ) t;

  return jsonb_build_object(
    'scope', jsonb_build_object('householdId', p_household_id),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'formulaVersion', 'cash-flow-monthly-v7-net-reversals',
    'rows', v_rows
  );
end;
$function$;

grant create on schema public to keel_api;
alter function public.keel_cash_flow(uuid, date, date) owner to keel_api;
revoke create on schema public from keel_api;

revoke all on function public.keel_cash_flow(uuid, date, date) from public, anon;
revoke all on function public.keel_cash_flow_monthly(uuid, date, date) from public, anon;
grant execute on function public.keel_cash_flow(uuid, date, date) to authenticated;
grant execute on function public.keel_cash_flow_monthly(uuid, date, date) to authenticated, service_role;
