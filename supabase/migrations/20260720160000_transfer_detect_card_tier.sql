-- feat(transfers): a third detection tier in keel_detect_transfers for
-- CREDIT-CARD PAYMENTS, widening the date window to <=7 days ONLY for the
-- depository-outflow ↔ credit-card-inflow shape.
--
-- CONTEXT. The two existing tiers (20260713 exact <=3d, 20260718131000
-- near-miss <=4d) already catch every genuinely-pairable two-sided transfer in
-- the founder household (investigation: 60 confirmed links, 0 missed). But a
-- card payoff can settle several days after the bank debit posts (the debit
-- leaves checking immediately; the credit posts to the card when the issuer
-- applies it), so a 3–4 day window occasionally misses a real, connected-card
-- pair. Widening the GENERAL window was tested and rejected (20260719020000
-- header): this dataset is P2P-heavy with colliding round-dollar amounts, so a
-- wide window manufactures false pairs (a "$30 to Prashanth" out pairs with an
-- unrelated "$30 Zara" in).
--
-- THE SAFE WIDENING. The card-payment shape cannot collide with those P2P
-- false positives: it requires the OUTFLOW leg on a DEPOSITORY account
-- (checking / cash management) AND the INFLOW leg on a CREDIT-CARD account,
-- EXACT opposite amounts. A liability↔depository exact-amount pair within 7 days
-- is a card payment, not a coincidental P2P collision (P2P legs are
-- depository↔depository or depository↔cash-app, never depository↔card-liability
-- with an exact offset). Tier 3 runs AFTER tiers 1 and 2, recomputing `linked`
-- so their just-inserted rows are visible and cannot be re-paired. Same greedy
-- 1:1, same rejected-pair guard, same idempotent on-conflict as the other tiers.
--
-- Dry-run on the live founder household: 0 NEW pairs in the 4–7 day window (the
-- existing tiers already caught the connected-card pairs), so this is safety
-- infrastructure for feeds that settle slower — it can only ADD correct pairs,
-- never remove or duplicate one. Deterministic (Law 1); the suggested links are
-- suggest→approve (Laws 2/10 class B) via the existing review surface.
--
-- Full recreate of keel_detect_transfers (live body captured from
-- pg_get_functiondef) with ONLY tier 3 appended and v_total summing all three.
-- Tiers 1 and 2 are byte-identical to the live body.

create or replace function public.keel_detect_transfers(p_household_id uuid)
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_exact int;
  v_near  int;
  v_card  int;
  v_total int;
begin
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
  -- Tier 2 (UNCHANGED near-miss): opposite magnitudes differing by
  -- 0 < delta <= least(100, floor(0.01*larger)), <=4-day gap.
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
      where o.amount_minor < 0
        and i.amount_minor > 0
        and abs(i.amount_minor) <> abs(o.amount_minor)
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

  -- ---------------------------------------------------------------------------
  -- Tier 3 (NEW card-payment): EXACT opposite amounts, DEPOSITORY outflow ↔
  -- CREDIT-CARD inflow, <=7-day gap. `linked` recomputed so tier-1/2 rows are
  -- visible. The liability↔depository exact-amount shape is immune to the
  -- round-dollar P2P collisions that killed general window-widening, so 7 days
  -- is safe here. Same greedy 1:1 / rejected-pair / on-conflict guards.
  -- (Both 'credit card' and 'credit_card' subtype spellings are accepted — live
  -- Plaid data uses the space form, the seed fixtures use the underscore form.)
  -- ---------------------------------------------------------------------------
  with cash as (
    select ct.id as txn_id, ct.effective_date, acc.id as account_id,
           acc.subtype, p.amount_minor, p.currency
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
       and abs(i.effective_date - o.effective_date) <= 7
      where o.amount_minor < 0                             -- depository outflow
        and o.subtype in ('checking', 'cash management')
        and i.amount_minor > 0                             -- credit-card inflow
        and i.subtype in ('credit card', 'credit_card')
        and not exists (select 1 from linked l where l.txn = o.txn_id)
        and not exists (select 1 from linked l where l.txn = i.txn_id)
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
  get diagnostics v_card = row_count;

  v_total := v_exact + v_near + v_card;

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
$function$;

-- create-or-replace preserves owner + ACL; re-assert exactly (live: authenticated
-- + service_role execute, anon denied).
revoke all on function public.keel_detect_transfers(uuid) from public, anon;
grant execute on function public.keel_detect_transfers(uuid) to authenticated, service_role;
