-- 20260721010000_distribution_transfer_detection_pin.sql
--
-- Distribution follow-up (Codex review Finding 1). keel_detect_transfers built
-- its 'cash' rows from EVERY non-category posting, so a distribution's second
-- real leg (e.g. a paycheck's Roth 401k posting) was treated as an independent
-- cash row keyed to the same canonical_transaction. That let the detector (a)
-- self-pair an opposite-sign distribution (cash -X / account +X) into a link
-- with txn_out = txn_in, which violates the transfer_links check and ABORTS
-- detection for the whole household, and (b) suggest spurious links against a
-- distribution's account leg. Fix: pin each tier's cash row to the transaction's
-- OWN account (canonical_transactions.account_id) — the same pin the rich read
-- model uses — so a distribution contributes exactly one cash row (its header
-- account) and its transfer legs are invisible to detection (correct: they are
-- already an in-transaction transfer, not a separate movement to pair).
--
-- Restated verbatim from the live definition with the three identical cash-CTE
-- joins re-pinned; all matching tiers, guards, and the audit write unchanged.
-- Existing single-account transactions are unaffected: their sole non-category
-- posting IS the header-account posting (verified: 0 null account_id, 0 batches
-- whose header account has no posting).

CREATE OR REPLACE FUNCTION public.keel_detect_transfers(p_household_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
      join public.accounts acc on acc.id = ct.account_id
      join public.journal_postings p
        on p.batch_id = jb.id and p.ledger_account_id = acc.ledger_account_id
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
      join public.accounts acc on acc.id = ct.account_id
      join public.journal_postings p
        on p.batch_id = jb.id and p.ledger_account_id = acc.ledger_account_id
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
      join public.accounts acc on acc.id = ct.account_id
      join public.journal_postings p
        on p.batch_id = jb.id and p.ledger_account_id = acc.ledger_account_id
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
$function$
