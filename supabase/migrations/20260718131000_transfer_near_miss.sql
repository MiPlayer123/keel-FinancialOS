-- FEEDBACK.md F-011: near-miss transfer suggestions.
-- The exact-opposite-amount detector (20260713020000) misses the common case
-- where an inter-account transfer arrives net of a wire/ATM/FX fee: $500.00
-- leaves one account and $499.35 lands in the other. Those are still one
-- economic transfer and should be offered for pairing so cash flow can exclude
-- them once confirmed.
--
-- Design (Law 1: DETERMINISTIC, no LLM):
--   Tier 1 (UNCHANGED): exact opposite cash amounts, same currency, different
--     accounts, <=3-day gap. Runs and inserts FIRST so exact matches always win
--     and consume their transactions before the fuzzy pass sees them.
--   Tier 2 (NEW near-miss): opposite-sign magnitudes that DIFFER but only within
--     a tight integer tolerance = least(100, floor(0.01 * larger_abs)) minor
--     units -- i.e. the SMALLER of $1.00 or 1% of the larger leg. Same currency,
--     different accounts, <=4-day gap. Ranks strictly below tier 1: it only
--     considers transactions still unlinked AFTER tier 1 commits, and the linked
--     CTE is RECOMPUTED between passes (not a reused snapshot) so tier-1 rows are
--     visible. Both passes: same rejected-pair guard, same greedy 1:1 row_number
--     pairing, insert status='suggested' on conflict (txn_out,txn_in) do nothing.
--
-- One function, one return value: the two INSERT passes' row counts are summed
-- into the returned integer and into a single audit_log 'suggested' entry.
--
-- The near-miss reason line ("amounts differ by X (possible fee)") is a
-- READ-MODEL concern derived CLIENT-SIDE from the amount delta; keel_list_transfers
-- already returns dayGap and both amounts, so the delta is computable from the
-- pair. keel_list_transfers is intentionally NOT changed here (owned elsewhere).
--
-- Money is BIGINT minor units; all arithmetic below is integer-only (no floats).
create or replace function public.keel_detect_transfers(p_household_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_exact int;
  v_near  int;
  v_total int;
begin
  -- User-driven detection requires membership; the service path (worker cron)
  -- carries no user claim. Execute privilege is limited to authenticated +
  -- service_role below.
  if auth.uid() is not null and not exists (
    select 1 from public.household_memberships
    where household_id = p_household_id and user_id = auth.uid()
  ) then
    raise exception 'KEEL_NOT_FOUND' using errcode = 'P0006';
  end if;

  -- ---------------------------------------------------------------------------
  -- Tier 1 (UNCHANGED): exact opposite amounts, <=3-day gap. Inserts FIRST.
  -- ---------------------------------------------------------------------------
  with cash as (
    select ct.id as txn_id, ct.effective_date, acc.id as account_id,
           p.amount_minor, p.currency
      from public.canonical_transactions ct
      join public.journal_batches jb
        on jb.canonical_transaction_id = ct.id and jb.reverses_batch_id is null
       -- Live batch only: sync revisions leave the superseded original as a
       -- second non-reversal batch (stale amounts must not pair or render).
       and not exists (
         select 1 from public.journal_revisions rev where rev.original_batch_id = jb.id
       )
      join public.journal_postings p on p.batch_id = jb.id
      join public.ledger_accounts la
        on la.id = p.ledger_account_id and la.is_category = false
      join public.accounts acc on acc.ledger_account_id = la.id
      where ct.household_id = p_household_id
        and ct.voided_at is null
        and p.amount_minor <> 0
        -- WS-E review P2-8: BIGINT min has no positive counterpart, so
        -- -amount_minor / abs(amount_minor) below would overflow. Exclude it
        -- (no real cash leg approaches this magnitude).
        and p.amount_minor <> -9223372036854775808
  ),
  linked as (
    select txn_out as txn from public.transfer_links
      where household_id = p_household_id and status in ('suggested', 'confirmed')
    union
    select txn_in from public.transfer_links
      where household_id = p_household_id and status in ('suggested', 'confirmed')
  ),
  pairs as (
    select o.txn_id as txn_out, i.txn_id as txn_in,
           abs(i.effective_date - o.effective_date) as day_gap
      from cash o
      join cash i
        on i.currency = o.currency
       and i.amount_minor = -o.amount_minor
       and i.account_id <> o.account_id
       and abs(i.effective_date - o.effective_date) <= 3
      where o.amount_minor < 0
        and not exists (select 1 from linked l where l.txn = o.txn_id)
        and not exists (select 1 from linked l where l.txn = i.txn_id)
        -- A REJECTED pair must not keep outranking valid alternatives: it
        -- would win the greedy pick every run and then no-op on conflict,
        -- permanently suppressing the second-best candidate.
        and not exists (
          select 1 from public.transfer_links tl
          where tl.txn_out = o.txn_id and tl.txn_in = i.txn_id
        )
  ),
  best_out as (
    select txn_out, txn_in, day_gap,
           row_number() over (partition by txn_out order by day_gap, txn_in) as rn
      from pairs
  ),
  uniq as (
    select txn_out, txn_in,
           row_number() over (partition by txn_in order by day_gap, txn_out) as rn_in
      from best_out where rn = 1
  )
  insert into public.transfer_links (household_id, txn_out, txn_in, status)
  select p_household_id, txn_out, txn_in, 'suggested'
    from uniq where rn_in = 1
  on conflict (txn_out, txn_in) do nothing;
  get diagnostics v_exact = row_count;

  -- ---------------------------------------------------------------------------
  -- Tier 2 (NEW near-miss): opposite magnitudes differing by 0 < delta <=
  -- least(100, floor(0.01 * larger_abs)) minor units, <=4-day gap. The `linked`
  -- CTE is RECOMPUTED here so tier-1's just-inserted 'suggested' rows are
  -- visible and their transactions cannot be re-paired by the fuzzy pass.
  -- Integer arithmetic only:
  --   tolerance = least(100, greatest(abs(out), abs(in)) / 100)   (floor via int div)
  --   delta     = abs(abs(in) - abs(out))                          (must be > 0)
  -- ---------------------------------------------------------------------------
  with cash as (
    select ct.id as txn_id, ct.effective_date, acc.id as account_id,
           p.amount_minor, p.currency
      from public.canonical_transactions ct
      join public.journal_batches jb
        on jb.canonical_transaction_id = ct.id and jb.reverses_batch_id is null
       and not exists (
         select 1 from public.journal_revisions rev where rev.original_batch_id = jb.id
       )
      join public.journal_postings p on p.batch_id = jb.id
      join public.ledger_accounts la
        on la.id = p.ledger_account_id and la.is_category = false
      join public.accounts acc on acc.ledger_account_id = la.id
      where ct.household_id = p_household_id
        and ct.voided_at is null
        and p.amount_minor <> 0
        -- WS-E review P2-8: same BIGINT-min guard as tier 1 (abs() overflows).
        and p.amount_minor <> -9223372036854775808
  ),
  linked as (
    select txn_out as txn from public.transfer_links
      where household_id = p_household_id and status in ('suggested', 'confirmed')
    union
    select txn_in from public.transfer_links
      where household_id = p_household_id and status in ('suggested', 'confirmed')
  ),
  pairs as (
    select o.txn_id as txn_out, i.txn_id as txn_in,
           abs(i.effective_date - o.effective_date) as day_gap,
           abs(abs(i.amount_minor) - abs(o.amount_minor)) as amount_diff
      from cash o
      join cash i
        on i.currency = o.currency
       and i.account_id <> o.account_id
       and abs(i.effective_date - o.effective_date) <= 4
      where o.amount_minor < 0            -- outflow leg
        and i.amount_minor > 0            -- inflow leg
        -- Near-miss ONLY: exactly-opposite pairs were consumed by tier 1.
        and abs(i.amount_minor) <> abs(o.amount_minor)
        -- 0 < delta <= least($1.00, 1% of the larger leg), integer division.
        and abs(abs(i.amount_minor) - abs(o.amount_minor))
              <= least(100::bigint,
                       greatest(abs(o.amount_minor), abs(i.amount_minor)) / 100)
        and not exists (select 1 from linked l where l.txn = o.txn_id)
        and not exists (select 1 from linked l where l.txn = i.txn_id)
        and not exists (
          select 1 from public.transfer_links tl
          where tl.txn_out = o.txn_id and tl.txn_in = i.txn_id
        )
  ),
  best_out as (
    -- Deterministic replay ordering: smallest fee first, then closest in time,
    -- then id tie-break. Greedy 1:1 exactly like tier 1.
    select txn_out, txn_in, amount_diff, day_gap,
           row_number() over (
             partition by txn_out order by amount_diff, day_gap, txn_in) as rn
      from pairs
  ),
  uniq as (
    select txn_out, txn_in,
           row_number() over (
             partition by txn_in order by amount_diff, day_gap, txn_out) as rn_in
      from best_out where rn = 1
  )
  insert into public.transfer_links (household_id, txn_out, txn_in, status)
  select p_household_id, txn_out, txn_in, 'suggested'
    from uniq where rn_in = 1
  on conflict (txn_out, txn_in) do nothing;
  get diagnostics v_near = row_count;

  v_total := v_exact + v_near;

  if v_total > 0 then
    insert into public.audit_log (household_id, actor, action, object_type, object_id, after)
    values (p_household_id,
            case when auth.uid() is null
                 then jsonb_build_object('kind', 'system', 'source', 'transfer_detector')
                 else jsonb_build_object('kind', 'user', 'userId', auth.uid()) end,
            'transfers.detect', 'household', p_household_id,
            jsonb_build_object('suggested', v_total));
  end if;
  return v_total;
end;
$$;

revoke all on function public.keel_detect_transfers(uuid) from public, anon;
grant execute on function public.keel_detect_transfers(uuid) to authenticated, service_role;
