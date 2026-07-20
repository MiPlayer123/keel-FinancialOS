-- Paycheck split templates SLICE D — apply / undo / booking DELEGATED to the
-- founder's set_splits primitive (docs/harness/plans/paycheck-split-templates-v2.md
-- §7 stage D; delivers founder asks 1 & 2).
--
-- ARCHITECTURE CORRECTION vs the v2 plan (see NOTES.md "SLICE D"):
--   The v2 plan §D1/§D5 designed a NEW booking proc keel_paycheck_book_splits that
--   re-implements posting via keel_insert_postings, because at plan-time
--   keel_cmd_set_splits' direction guard forbade mixed-sign splits
--   (20260717190000_set_splits.sql:192). That guard was SINCE corrected:
--     * PR #117 20260720230000_set_splits_balanced_mixed.sql — set_splits now books
--       BALANCED MIXED-direction splits (income −gross + tax +amount = net), each
--       leg validated against its OWN offset sign.
--     * PR #124 20260721000000_transaction_distributions.sql — a split leg
--       { account_id, amount_minor } TRANSFERS into another real account (the 401k
--       into the retirement account) inside ONE ledger line (a distribution;
--       keel_txn_is_distribution detects it).
--     * PR #130 20260721*_distribution_* — natural cash-effect signs.
--   Therefore SLICE D DELEGATES booking to keel_cmd_set_splits (Law 7 — ONE
--   booking compiler; NO second posting path). The template layer's only job is the
--   MATH set_splits does NOT do: COMPUTE the split-leg amounts from a template + the
--   deposit's observed net (Slice-A §D4 algorithm, here ported to SQL and
--   parity-tested against packages/paychecks/src/template.ts).
--
-- Laws honored:
--   1 — LLMs never do ledger arithmetic; the gross-up is deterministic SQL/bigint.
--   2 — every AI write is suggest→approve (class B, token-bound) + undoable; undo is
--       a compensating set_splits revision + paycheck reversal, never a delete.
--   3 — Σ=0 is enforced by keel_cmd_set_splits (not duplicated here); apply asserts
--       Σlegs == −net BEFORE delegating (defense in depth).
--   4 — money is BIGINT minor units; every intermediate overflow-guarded; no floats.
--   7 — ONE booking compiler (keel_cmd_set_splits) + ONE payload normalizer
--       (keel_paycheck_apply_payload) shared by issue + apply (issue-hash==redeem-hash
--       by construction).
--   9 — the recorded paycheck references template_id + template_version; apply is
--       idempotent by economic_event_key = 'paycheck-tpl:'||series||':'||deposit.
--   11 — token-bound apply (approval_token_issue/redeem) binds the EXACT normalized
--       payload; one v_payload passed to BOTH redeem AND book (the SLICE 0 HARD GATE,
--       mirroring keel_cmd_statements_apply_holdings).
--
-- AGENT-SAFETY (v2 [AMENDED 5]): the apply/unapply procs are execute-granted to
-- authenticated ONLY (they derive actor from the JWT + require a redeemed token) and
-- REVOKED from service_role/anon. A trusted agent principal can only SUGGEST (Slice
-- E), never apply — enforced by grant/revoke, not a forgeable actor.kind.

-- ===========================================================================
-- 0. Linkage: reproducibility + undo pointers on paychecks + an applications
--    table binding token + suggestion + the booked deposit txn (so unapply can
--    find and reverse exactly what apply booked). template_id/template_version
--    were added in Slice B (20260721180000).
-- ===========================================================================
alter table public.paychecks
  add column if not exists applied_from_suggestion_id uuid;

-- The audited apply record. One live application per (series, deposit) — a
-- re-apply of the SAME deposit reuses the row (idempotent). revoked_at marks an
-- unapplied application (Law 2, never deleted). It captures the deposit's
-- pre-apply single-category offset so unapply can restore it via set_splits.
create table public.paycheck_template_applications (
  household_id            uuid not null references public.households (id),
  id                      uuid not null default gen_random_uuid(),
  series_id               uuid not null,
  deposit_txn_id          uuid not null,
  template_id             uuid not null,
  template_version        integer not null check (template_version > 0),
  paycheck_id             uuid not null,
  approval_token_id       uuid not null,
  applied_from_suggestion_id uuid,
  -- The deposit's pre-apply category offset (a single is_category ledger account
  -- + the signed cash the client was looking at), so unapply restores the exact
  -- prior split via set_splits (Law 2: reversible correction, reproducible).
  prior_offset_ledger_account_id uuid,
  prior_amount_minor      bigint not null,
  applied_by              uuid not null references auth.users (id),
  revoked_at              timestamptz,
  revoked_by              uuid references auth.users (id),
  created_at              timestamptz not null default now(),
  primary key (household_id, id),
  unique (household_id, series_id, deposit_txn_id),
  constraint fk_pta_series_tenant foreign key (household_id, series_id)
    references public.recurring_series (household_id, id) on delete restrict,
  constraint fk_pta_deposit_tenant foreign key (household_id, deposit_txn_id)
    references public.canonical_transactions (household_id, id) on delete restrict,
  constraint fk_pta_template_tenant foreign key (household_id, template_id)
    references public.paycheck_templates (household_id, id) on delete restrict,
  constraint fk_pta_paycheck_tenant foreign key (household_id, paycheck_id)
    references public.paychecks (household_id, id) on delete restrict,
  constraint fk_pta_token_tenant foreign key (household_id, approval_token_id)
    references public.approval_tokens (household_id, token_id) on delete restrict,
  constraint fk_pta_prior_offset_tenant foreign key (household_id, prior_offset_ledger_account_id)
    references public.ledger_accounts (household_id, id) on delete restrict
);
create index paycheck_template_applications_deposit
  on public.paycheck_template_applications (household_id, deposit_txn_id)
  where revoked_at is null;

alter table public.paycheck_template_applications enable row level security;
revoke all on public.paycheck_template_applications from public, anon, authenticated;
grant select on public.paycheck_template_applications to authenticated, service_role;
grant select, insert, update on public.paycheck_template_applications to keel_api;
do $$ begin
  if to_regclass('public.paycheck_template_applications') is not null then
    drop policy if exists paycheck_template_applications_read on public.paycheck_template_applications;
    drop policy if exists paycheck_template_applications_api on public.paycheck_template_applications;
    drop policy if exists paycheck_template_applications_export on public.paycheck_template_applications;
  end if;
end $$;
create policy paycheck_template_applications_read on public.paycheck_template_applications
  for select to authenticated using (public.keel_is_household_member(household_id));
create policy paycheck_template_applications_api on public.paycheck_template_applications
  for all to keel_api using (true) with check (true);

-- ===========================================================================
-- 1. keel_paycheck_template_compute — the SQL port of Slice-A §D4 (the MATH the
--    booking primitive does NOT do). Given the household, a template id/version,
--    and the observed NET deposit N (bigint minor), COMPUTE the split-leg amounts:
--      * exact gross selection G (ceil seed + bounded window scan, smallest G),
--      * per-percent-line round_half_up(G·bps, 10000),
--      * the single remainder net_deposit = N.
--    Returns {grossMinor, netMinor, legs:[{lineKey, role, kind, amountMinor,
--    categoryLedgerAccountId, destinationAccountId}]} — legs in template position
--    order. PARITY: byte-for-byte the same numbers as applyPaycheckTemplate (TS).
--    All bigint; every product/sum guarded against int64 overflow (§D4).
-- ===========================================================================
create function public.keel_paycheck_template_compute(
  p_household_id uuid,
  p_template_id uuid,
  p_net_minor bigint
) returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_int64_max constant numeric := 9223372036854775807;
  v_line record;
  v_earning record := null;
  v_remainder record := null;
  v_fixed_total bigint := 0;
  v_reimbursement bigint := 0;
  v_aggregate_bps bigint := 0;
  v_k int := 0;              -- number of percent lines
  v_denominator bigint;
  v_seed_base bigint;
  v_seed_numerator numeric;
  v_seed bigint;
  v_pad bigint;
  v_lo bigint;
  v_hi bigint;
  v_gross bigint := null;
  v_g bigint;
  v_taxes bigint;
  v_net_at bigint;
  v_prod numeric;
  v_remainder_amount bigint;
  v_legs jsonb := '[]'::jsonb;
begin
  if p_net_minor is null or p_net_minor < 0 then
    raise exception 'KEEL_INVALID_COMMAND: net deposit must be a non-negative integer' using errcode = 'P0009';
  end if;

  -- Partition the (frozen) template lines. The earning line carries the derived
  -- gross (amount_kind='remainder', role='earning'); THE remainder line is the
  -- net_deposit residue. Reimbursements are an additive class (+R). Percent lines
  -- carry bps; fixed deduction lines carry amount_minor.
  for v_line in
    select line_key, kind::text as kind, role::text as role, amount_kind::text as amount_kind,
           amount_minor, bps, category_ledger_account_id, destination_account_id, position
      from public.paycheck_template_lines
     where household_id = p_household_id and template_id = p_template_id
     order by position
  loop
    if v_line.role = 'earning' then
      v_earning := v_line;
    elsif v_line.role = 'net_deposit' and v_line.amount_kind = 'remainder' then
      v_remainder := v_line;
    elsif v_line.kind = 'reimbursement' then
      v_reimbursement := v_reimbursement + coalesce(v_line.amount_minor, 0);
      if v_reimbursement > v_int64_max then
        raise exception 'KEEL_INVALID_COMMAND: reimbursement total exceeds bigint' using errcode = 'P0009';
      end if;
    elsif v_line.amount_kind = 'percent_of_gross_bps' then
      v_k := v_k + 1;
      v_aggregate_bps := v_aggregate_bps + v_line.bps;
    elsif v_line.amount_kind = 'fixed_minor' then
      v_fixed_total := v_fixed_total + coalesce(v_line.amount_minor, 0);
      if v_fixed_total > v_int64_max then
        raise exception 'KEEL_INVALID_COMMAND: fixed deduction total exceeds bigint' using errcode = 'P0009';
      end if;
    end if;
  end loop;

  if v_earning is null then
    raise exception 'KEEL_INVALID_COMMAND: template has no earning line' using errcode = 'P0009';
  end if;
  if v_remainder is null then
    raise exception 'KEEL_INVALID_COMMAND: template has no remainder net_deposit line' using errcode = 'P0009';
  end if;
  if v_aggregate_bps >= 10000 then
    raise exception 'KEEL_INVALID_COMMAND: aggregate percent (%) must be < 10000 bps', v_aggregate_bps using errcode = 'P0009';
  end if;

  v_denominator := 10000 - v_aggregate_bps;   -- > 0

  -- Seed G0 = ceil((N − R + ΣF)·10000 / (10000 − P)). N − R + ΣF must be >= 0
  -- (reimbursement alone cannot exceed the grossed-down target).
  v_seed_base := p_net_minor - v_reimbursement + v_fixed_total;
  if v_seed_base < 0 then
    raise exception 'KEEL_INVALID_COMMAND: reimbursement exceeds seed (paycheck nonsensical)' using errcode = 'P0009';
  end if;
  v_seed_numerator := v_seed_base::numeric * 10000;
  if v_seed_numerator > v_int64_max then
    raise exception 'KEEL_INVALID_COMMAND: gross seed exceeds bigint' using errcode = 'P0009';
  end if;
  if v_seed_numerator = 0 then
    v_seed := 0;
  else
    -- ceil(a/b) = (a + b − 1) / b for a>0, b>0 (integer division truncates).
    v_seed := floor((v_seed_numerator + v_denominator - 1) / v_denominator)::bigint;
  end if;

  -- Window bound: pad = ceil(k·10000/(10000−P)) + 2 strictly contains every exact
  -- solution around the seed (see §D4 / template.ts selectGross).
  if v_k = 0 then
    v_pad := 2;
  else
    v_pad := floor((v_k::numeric * 10000 + v_denominator - 1) / v_denominator)::bigint + 2;
  end if;
  v_lo := greatest(v_seed - v_pad, 0);
  v_hi := v_seed + v_pad;

  -- Linear scan ascending; take the SMALLEST reconciling G (net(G) = N).
  v_g := v_lo;
  while v_g <= v_hi loop
    v_taxes := 0;
    for v_line in
      select bps from public.paycheck_template_lines
       where household_id = p_household_id and template_id = p_template_id
         and amount_kind = 'percent_of_gross_bps'
    loop
      v_prod := v_g::numeric * v_line.bps;
      if v_prod > v_int64_max then
        raise exception 'KEEL_INVALID_COMMAND: gross*bps exceeds bigint' using errcode = 'P0009';
      end if;
      -- round_half_up(G·bps, 10000) = floor((G·bps + 5000) / 10000) — floor, NOT
      -- numeric-round (::bigint on a fraction rounds half-to-even, corrupting parity).
      v_taxes := v_taxes + floor((v_prod + 5000) / 10000)::bigint;
    end loop;
    v_net_at := v_g + v_reimbursement - v_fixed_total - v_taxes;
    if v_net_at = p_net_minor then
      v_gross := v_g;
      exit;
    end if;
    v_g := v_g + 1;
  end loop;

  if v_gross is null then
    raise exception 'KEEL_INVALID_COMMAND: template does not reconcile to net % (no integer gross near seed %)',
      p_net_minor, v_seed using errcode = 'P0009';
  end if;

  -- Remainder = net(G) = N by construction; recompute taxes to build the legs.
  v_taxes := 0;

  -- Emit legs in template position order: earning (+G as offset magnitude),
  -- reimbursements, fixed deductions, percent deductions, remainder deposit (=N).
  for v_line in
    select line_key, kind::text as kind, role::text as role, amount_kind::text as amount_kind,
           amount_minor, bps, category_ledger_account_id, destination_account_id, position
      from public.paycheck_template_lines
     where household_id = p_household_id and template_id = p_template_id
     order by position
  loop
    if v_line.role = 'earning' then
      v_legs := v_legs || jsonb_build_object(
        'lineKey', v_line.line_key, 'role', 'earning', 'kind', v_line.kind,
        'amountMinor', v_gross::text,
        'categoryLedgerAccountId', v_line.category_ledger_account_id,
        'destinationAccountId', null);
    elsif v_line.role = 'net_deposit' and v_line.amount_kind = 'remainder' then
      continue;  -- appended last
    elsif v_line.amount_kind = 'percent_of_gross_bps' then
      v_prod := v_gross::numeric * v_line.bps;
      v_legs := v_legs || jsonb_build_object(
        'lineKey', v_line.line_key, 'role', v_line.role, 'kind', v_line.kind,
        'amountMinor', (floor((v_prod + 5000) / 10000)::bigint)::text,
        'categoryLedgerAccountId', v_line.category_ledger_account_id,
        'destinationAccountId', v_line.destination_account_id);
    else -- fixed_minor (reimbursement or deduction)
      v_legs := v_legs || jsonb_build_object(
        'lineKey', v_line.line_key, 'role', v_line.role, 'kind', v_line.kind,
        'amountMinor', coalesce(v_line.amount_minor, 0)::text,
        'categoryLedgerAccountId', v_line.category_ledger_account_id,
        'destinationAccountId', v_line.destination_account_id);
    end if;
  end loop;

  v_remainder_amount := p_net_minor;
  v_legs := v_legs || jsonb_build_object(
    'lineKey', v_remainder.line_key, 'role', 'net_deposit', 'kind', 'direct_deposit',
    'amountMinor', v_remainder_amount::text,
    'categoryLedgerAccountId', null,
    'destinationAccountId', v_remainder.destination_account_id);

  return jsonb_build_object(
    'grossMinor', v_gross::text,
    'netMinor', p_net_minor::text,
    'formulaVersion', 'paycheck-split-template-v2',
    'legs', v_legs
  );
end;
$$;

-- ===========================================================================
-- 2. keel_paycheck_apply_payload — THE ONE server-normalized apply payload the
--    ISSUE and APPLY sides both hash (Law 7 single normalizer → issue-hash ==
--    redeem-hash by construction). Derived ENTIRELY from server facts (the
--    template lines + the deposit's live cash posting + the series income
--    category) — the client names only series/deposit/template/version. Shape:
--    {seriesId, depositTxnId, templateId, templateVersion, incomeCategoryLedgerAccountId,
--     cashLedgerAccountId, cashAmountMinor, grossMinor, netMinor,
--     splits:[{...set_splits leg...}]}
--    splits are EXACTLY the keel_cmd_set_splits leg objects (category leg
--    {categoryLedgerAccountId, amountMinor} or distribution leg {accountId,
--    amountMinor}) in deterministic order, so the bound bytes ARE the booking.
-- ===========================================================================
create function public.keel_paycheck_apply_payload(
  p_household_id uuid,
  p_series_id uuid,
  p_deposit_txn_id uuid,
  p_template_id uuid,
  p_template_version int
) returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_txn public.canonical_transactions%rowtype;
  v_batch public.journal_batches%rowtype;
  v_cash record;
  v_series public.paycheck_series_settings%rowtype;
  v_tpl public.paycheck_templates%rowtype;
  v_income_cat uuid;
  v_net bigint;
  v_computed jsonb;
  v_leg jsonb;
  v_gross bigint;
  v_splits jsonb := '[]'::jsonb;
  v_dest_ledger uuid;
  v_dest_acct uuid;
begin
  -- The deposit txn + its live single-account cash posting (a NOT-YET-booked
  -- deposit is a single-real-account batch; +net cash into checking).
  select * into v_txn from public.canonical_transactions
   where household_id = p_household_id and id = p_deposit_txn_id;
  if not found then
    raise exception 'KEEL_SCOPE_VIOLATION: deposit not in household' using errcode = 'P0006';
  end if;
  if v_txn.voided_at is not null then
    raise exception 'KEEL_IMMUTABLE: deposit is voided' using errcode = 'P0001';
  end if;

  select jb.* into v_batch
    from public.journal_batches jb
    where jb.canonical_transaction_id = v_txn.id
      and jb.reverses_batch_id is null
      and not exists (select 1 from public.journal_revisions rev where rev.original_batch_id = jb.id)
    order by jb.posted_at desc, jb.id desc
    limit 1;
  if not found then
    raise exception 'KEEL_IMMUTABLE: deposit has no live batch' using errcode = 'P0001';
  end if;

  -- The cash posting on the transaction's OWN account (the amount to re-split).
  select p.ledger_account_id, p.entity_id, p.amount_minor, p.currency
    into v_cash
    from public.accounts a
    join public.journal_postings p
      on p.batch_id = v_batch.id and p.ledger_account_id = a.ledger_account_id
   where a.id = v_txn.account_id and a.household_id = p_household_id;
  if not found then
    raise exception 'KEEL_INVALID_COMMAND: deposit has no cash posting on its own account' using errcode = 'P0009';
  end if;
  if v_cash.amount_minor <= 0 then
    raise exception 'KEEL_INVALID_COMMAND: deposit cash is not a positive inflow (net take-home)' using errcode = 'P0009';
  end if;
  v_net := v_cash.amount_minor;

  -- The series settings (income category = the gross income anchor) + template.
  select * into v_series from public.paycheck_series_settings
   where household_id = p_household_id and series_id = p_series_id;
  if not found then
    raise exception 'KEEL_INVALID_COMMAND: series has no settings' using errcode = 'P0009';
  end if;
  if v_series.active_template_id is distinct from p_template_id then
    raise exception 'KEEL_INVALID_COMMAND: template is not the series'' active template' using errcode = 'P0009';
  end if;
  v_income_cat := v_series.income_category_ledger_account_id;
  if v_income_cat is null then
    raise exception 'KEEL_INVALID_COMMAND: series has no income category (set it in series settings)' using errcode = 'P0009';
  end if;
  -- Income category must be a live same-entity income category in the cash currency.
  if not exists (
    select 1 from public.ledger_accounts la
     where la.household_id = p_household_id and la.id = v_income_cat
       and la.is_category = true and la.kind = 'income' and la.archived_at is null
       and la.entity_id = v_cash.entity_id and la.currency = v_cash.currency
  ) then
    raise exception 'KEEL_INVALID_COMMAND: series income category is not a live same-entity income category in the cash currency' using errcode = 'P0009';
  end if;

  select * into v_tpl from public.paycheck_templates
   where household_id = p_household_id and id = p_template_id and template_version = p_template_version;
  if not found then
    raise exception 'KEEL_INVALID_COMMAND: template version not found' using errcode = 'P0009';
  end if;

  -- COMPUTE the leg amounts (the math set_splits does NOT do).
  v_computed := public.keel_paycheck_template_compute(p_household_id, p_template_id, v_net);
  v_gross := (v_computed->>'grossMinor')::bigint;

  -- Build the keel_cmd_set_splits splits array from the computed legs:
  --   * earning  → income category leg, amount −gross (a credit offset; income).
  --   * tax / posttax_deduction → its category leg, amount +amount (debit; expense).
  --   * pretax_transfer → a DISTRIBUTION leg { accountId, amount +amount } into the
  --     template's destination retirement/HSA account (one ledger line, PR #124).
  --   * net_deposit remainder → NOT a split (it is the cash side itself); skipped.
  for v_leg in select value from jsonb_array_elements(v_computed->'legs') loop
    if v_leg->>'role' = 'earning' then
      v_splits := v_splits || jsonb_build_object(
        'categoryLedgerAccountId', v_income_cat::text,
        'amountMinor', (-v_gross)::text);
    elsif v_leg->>'role' in ('tax', 'posttax_deduction') then
      if nullif(v_leg->>'categoryLedgerAccountId', '') is null then
        raise exception 'KEEL_INVALID_COMMAND: tax/deduction line % has no category (set it in the template)', v_leg->>'lineKey' using errcode = 'P0009';
      end if;
      v_splits := v_splits || jsonb_build_object(
        'categoryLedgerAccountId', v_leg->>'categoryLedgerAccountId',
        'amountMinor', v_leg->>'amountMinor');   -- positive (debit expense)
    elsif v_leg->>'role' = 'pretax_transfer' then
      v_dest_acct := nullif(v_leg->>'destinationAccountId', '')::uuid;
      if v_dest_acct is null then
        raise exception 'KEEL_INVALID_COMMAND: pretax_transfer line % has no destination account', v_leg->>'lineKey' using errcode = 'P0009';
      end if;
      -- The destination must be a live postable real account in the same
      -- entity/currency (set_splits re-checks; a typed error here is friendlier).
      if not exists (
        select 1 from public.accounts a
        join public.ledger_accounts la on la.household_id = a.household_id and la.id = a.ledger_account_id
        where a.household_id = p_household_id and a.id = v_dest_acct
          and a.archived_at is null and la.is_category = false and la.archived_at is null
          and la.entity_id = v_cash.entity_id and la.currency = v_cash.currency
      ) then
        raise exception 'KEEL_INVALID_COMMAND: destination account % is not a live same-entity postable account', v_dest_acct using errcode = 'P0009';
      end if;
      v_splits := v_splits || jsonb_build_object(
        'accountId', v_dest_acct::text,
        'amountMinor', v_leg->>'amountMinor');   -- positive (debit into the asset account)
    end if;
    -- net_deposit remainder: skipped (it is the cash side).
  end loop;

  return jsonb_build_object(
    'seriesId', p_series_id::text,
    'depositTxnId', p_deposit_txn_id::text,
    'templateId', p_template_id::text,
    'templateVersion', p_template_version,
    'incomeCategoryLedgerAccountId', v_income_cat::text,
    'cashLedgerAccountId', v_cash.ledger_account_id::text,
    'cashAmountMinor', v_cash.amount_minor::text,
    'grossMinor', v_gross::text,
    'netMinor', v_net::text,
    'formulaVersion', 'paycheck-split-template-v2',
    'splits', v_splits
  );
end;
$$;

-- ===========================================================================
-- 3. keel_cmd_paycheck_issue_apply_token — mint an approval token over THE
--    normalized apply payload (Law 11 gate). Mirrors keel_cmd_statements_issue_
--    holdings_approval: client names only series/deposit/template/version; the
--    server COMPUTES + normalizes + hashes, so issue and apply bind byte-identical
--    payloads by construction. Command 'paychecks.apply_template', proposal_kind
--    'paycheck_split', account-scoped to the deposit's account, 5-min TTL.
-- ===========================================================================
create function public.keel_cmd_paycheck_issue_apply_token(
  p_household_id uuid,
  p_series_id uuid,
  p_deposit_txn_id uuid,
  p_template_id uuid,
  p_template_version int
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor jsonb := public.keel_actor_from_jwt();
  v_txn public.canonical_transactions%rowtype;
  v_payload jsonb;
begin
  perform public.keel_assert_member_write(p_household_id);

  select * into v_txn from public.canonical_transactions
   where household_id = p_household_id and id = p_deposit_txn_id;
  if not found or not public.keel_recurring_account_access(p_household_id, v_txn.account_id, true) then
    raise exception 'KEEL_SCOPE_VIOLATION: deposit not found' using errcode = 'P0006';
  end if;

  -- THE ONE normalized payload (server-computed) — identical to what apply redeems.
  v_payload := public.keel_paycheck_apply_payload(
    p_household_id, p_series_id, p_deposit_txn_id, p_template_id, p_template_version);

  return public.keel_approval_token_issue(
    p_household_id,
    v_actor,
    'paychecks.apply_template',                 -- command the token redeems against
    v_payload,                                  -- normalized_payload -> hashed
    jsonb_build_object('householdId', p_household_id, 'accountId', v_txn.account_id),
    v_txn.account_id,                           -- account scope
    'paycheck_split',                           -- proposal_kind
    p_deposit_txn_id,                           -- proposal_ref
    p_template_version,                         -- proposal_version (apply passes the same)
    'paycheck-split-template-v2',               -- policy_version
    300                                         -- ttl seconds (5 min)
  );
end;
$$;

-- ===========================================================================
-- 4. keel_cmd_paycheck_apply_template — class-B, TOKEN-BOUND, HARD GATE. Full
--    command envelope. Binds ONE v_payload; passes it to BOTH the token redeem
--    AND the keel_cmd_set_splits booking, in one transaction. Then records the
--    paycheck (Law 9) + the application row (undo linkage). Idempotent by
--    economic_event_key. Σ=0 is enforced by set_splits (not duplicated); apply
--    asserts Σsplits == −cash before delegating (defense in depth, Law 3).
-- ===========================================================================
create function public.keel_cmd_paycheck_apply_template(
  p_command_id uuid,
  p_economic_event_key text,
  p_actor jsonb,
  p_household_id uuid,
  p_payload jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hash text := public.keel_payload_hash(p_payload);
  v_replay jsonb;
  v_actor jsonb;
  v_uid uuid;
  v_series_id uuid;
  v_deposit_txn_id uuid;
  v_template_id uuid;
  v_template_version int;
  v_token_id uuid;
  v_txn public.canonical_transactions%rowtype;
  v_payload jsonb;              -- THE ONE bound payload (server-computed splits)
  v_split jsonb;
  v_split_sum bigint := 0;
  v_cash_amount bigint;
  v_gross bigint;
  v_net bigint;
  v_prior_offset uuid;
  v_prior_offset_count int;
  v_series public.paycheck_series_settings%rowtype;
  v_employer_name text;
  v_set_splits_payload jsonb;
  v_set_splits_result jsonb;
  v_suggestion_id uuid;
  v_computed jsonb;
  v_leg jsonb;
  v_components jsonb := '[]'::jsonb;
  v_paycheck_id uuid := gen_random_uuid();
  v_component_id uuid;
  v_employer_id uuid;
  v_app_id uuid;
  v_after jsonb;
  v_result jsonb;
begin
  perform public.keel_assert_member_write(p_household_id);
  v_actor := public.keel_actor_from_jwt();
  v_uid := (v_actor->>'userId')::uuid;
  v_replay := public.keel_idempotency_check(p_household_id, p_economic_event_key, v_hash);
  if v_replay is not null then
    return v_replay;
  end if;

  -- Envelope: seriesId + depositTxnId + templateId + templateVersion + approvalTokenId.
  if jsonb_typeof(p_payload) <> 'object'
     or (p_payload - 'series_id' - 'deposit_txn_id' - 'template_id' - 'template_version' - 'approval_token_id') <> '{}'::jsonb
     or coalesce(p_payload->>'series_id', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or coalesce(p_payload->>'deposit_txn_id', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or coalesce(p_payload->>'template_id', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or coalesce(p_payload->>'template_version', '') !~ '^[1-9][0-9]*$'
     or coalesce(p_payload->>'approval_token_id', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception 'KEEL_INVALID_COMMAND: malformed apply_template payload' using errcode = 'P0009';
  end if;

  v_series_id := (p_payload->>'series_id')::uuid;
  v_deposit_txn_id := (p_payload->>'deposit_txn_id')::uuid;
  v_template_id := (p_payload->>'template_id')::uuid;
  v_template_version := (p_payload->>'template_version')::int;
  v_token_id := (p_payload->>'approval_token_id')::uuid;

  -- Lock the deposit txn (serialize concurrent applies; also what set_splits locks).
  select * into v_txn from public.canonical_transactions
   where household_id = p_household_id and id = v_deposit_txn_id
   for update;
  if not found or not public.keel_recurring_account_access(p_household_id, v_txn.account_id, true) then
    raise exception 'KEEL_SCOPE_VIOLATION: deposit not found' using errcode = 'P0006';
  end if;

  -- Build THE ONE server-normalized payload (compute + splits live inside). This
  -- is the exact value the token was issued over.
  v_payload := public.keel_paycheck_apply_payload(
    p_household_id, v_series_id, v_deposit_txn_id, v_template_id, v_template_version);
  v_cash_amount := (v_payload->>'cashAmountMinor')::bigint;
  v_gross := (v_payload->>'grossMinor')::bigint;
  v_net := (v_payload->>'netMinor')::bigint;

  -- Assert Σsplits == −cash BEFORE delegating (Law 3 defense in depth; set_splits
  -- re-enforces this and the deferred trigger is the backstop — NOT duplicated as
  -- the authority, only a fail-closed precheck so a math regression never reaches
  -- the booking compiler).
  for v_split in select value from jsonb_array_elements(v_payload->'splits') loop
    v_split_sum := v_split_sum + (v_split->>'amountMinor')::bigint;
  end loop;
  if v_split_sum <> -v_cash_amount then
    raise exception 'KEEL_UNBALANCED: computed legs sum to % but must equal % (cash %)',
      v_split_sum, -v_cash_amount, v_cash_amount using errcode = 'P0002';
  end if;

  -- Capture the deposit's PRE-APPLY category offset (for undo). A not-yet-booked
  -- deposit has exactly one is_category offset (its landing-pad category) OR none
  -- (already a distribution / multi-offset → cannot template-apply here).
  select count(*) filter (where la.is_category = true),
         (array_agg(p.ledger_account_id) filter (where la.is_category = true))[1]
    into v_prior_offset_count, v_prior_offset
    from public.journal_batches jb
    join public.journal_postings p on p.batch_id = jb.id
    join public.ledger_accounts la on la.id = p.ledger_account_id
   where jb.canonical_transaction_id = v_txn.id
     and jb.reverses_batch_id is null
     and not exists (select 1 from public.journal_revisions rev where rev.original_batch_id = jb.id)
     and la.is_category = true;
  if public.keel_txn_is_distribution(v_txn.id) then
    raise exception 'KEEL_INVALID_COMMAND: deposit is already a distribution — unapply first to re-apply' using errcode = 'P0009';
  end if;
  if coalesce(v_prior_offset_count, 0) <> 1 then
    raise exception 'KEEL_INVALID_COMMAND: deposit must have exactly one category offset to template-apply' using errcode = 'P0009';
  end if;

  -- (a) REDEEM the token against THE SAME v_payload (one-use, tamper-evident,
  -- expiry/actor/command/version-enforcing). If the client aimed at a different
  -- deposit/template, hash(v_payload) != token.payload_sha256 -> reject.
  perform public.keel_approval_token_redeem(
    p_household_id, v_token_id, p_command_id, v_actor,
    'paychecks.apply_template', v_payload, v_template_version);

  -- (b) BOOK the SAME v_payload's splits through keel_cmd_set_splits (Law 7 — ONE
  -- booking compiler). The set_splits payload IS the bound splits + the cash
  -- amount + the transaction id; set_splits re-splits the deposit's live offset
  -- into the income/tax/401k legs, enforces Σ=0, and writes the correction model
  -- (reversal + replacement + journal_revisions). A distinct command_id is minted
  -- for the nested command (a child economic event of this apply).
  v_set_splits_payload := jsonb_build_object(
    'transaction_id', v_deposit_txn_id::text,
    'amount_minor', v_cash_amount::text,
    'splits', (
      select jsonb_agg(
        case
          when s ? 'accountId' then jsonb_build_object('account_id', s->>'accountId', 'amount_minor', s->>'amountMinor')
          else jsonb_build_object('category_ledger_account_id', s->>'categoryLedgerAccountId', 'amount_minor', s->>'amountMinor')
        end)
      from jsonb_array_elements(v_payload->'splits') s
    )
  );
  v_set_splits_result := public.keel_cmd_set_splits(
    gen_random_uuid(),
    p_economic_event_key || ':set_splits',
    v_actor,
    p_household_id,
    v_set_splits_payload);

  -- (c) RECORD the paycheck (the reproducible gross→net decomposition fact, Law 9).
  -- Built directly (not via keel_paycheck_create, whose per-component transaction
  -- matches assume the OLD separate-txn model — in the distribution model there is
  -- ONE deposit txn; the booking + the application row ARE the ledger linkage).
  v_computed := public.keel_paycheck_template_compute(p_household_id, v_template_id, v_net);
  for v_leg in select value from jsonb_array_elements(v_computed->'legs') loop
    v_components := v_components || jsonb_build_object(
      'key', v_leg->>'lineKey', 'kind', v_leg->>'kind', 'amount_minor', v_leg->>'amountMinor');
  end loop;

  -- Employer for the paycheck row: the series' employer.
  select employer_id into v_employer_id from public.paycheck_series_settings
   where household_id = p_household_id and series_id = v_series_id;
  if v_employer_id is null then
    raise exception 'KEEL_INVALID_COMMAND: series has no employer' using errcode = 'P0009';
  end if;

  insert into public.paychecks
    (id, household_id, employer_id, pay_date, gross_minor, net_minor, currency, status,
     formula_version, created_by, template_id, template_version)
  values
    (v_paycheck_id, p_household_id, v_employer_id, v_txn.effective_date, v_gross, v_net,
     (select currency from public.ledger_accounts where id = (v_payload->>'cashLedgerAccountId')::uuid),
     'active', 'paycheck-split-template-v2', v_uid, v_template_id, v_template_version);

  for v_leg in select value from jsonb_array_elements(v_components) loop
    insert into public.paycheck_components (household_id, paycheck_id, component_key, kind, amount_minor)
    values (p_household_id, v_paycheck_id, v_leg->>'key',
            (v_leg->>'kind')::public.paycheck_component_kind, (v_leg->>'amount_minor')::bigint);
  end loop;

  insert into public.paycheck_sources (household_id, paycheck_id, source_kind, source_ref, content_hash)
  values (p_household_id, v_paycheck_id, 'manual', 'paycheck-template-apply:' || v_deposit_txn_id::text, v_hash);

  insert into public.paycheck_status_events (household_id, paycheck_id, transition, reason, actor, command_id)
  values (p_household_id, v_paycheck_id, 'created', null, v_actor, p_command_id);

  -- Accept the originating suggestion (Slice E), if one exists for this exact
  -- (deposit, template, version). (No suggestion in Slice D; the E detection proc
  -- creates them. This is forward-compatible.) Done BEFORE the application insert
  -- so applied_from_suggestion_id is bound in one write.
  update public.paycheck_split_suggestions
     set status = 'accepted', decided_by = v_uid, decided_at = now(), applied_paycheck_id = v_paycheck_id
   where household_id = p_household_id and deposit_txn_id = v_deposit_txn_id
     and template_id = v_template_id and template_version = v_template_version
     and status = 'suggested'
  returning id into v_suggestion_id;

  -- (d) The application row (token + suggestion + prior-offset undo linkage).
  insert into public.paycheck_template_applications
    (household_id, series_id, deposit_txn_id, template_id, template_version, paycheck_id,
     approval_token_id, applied_from_suggestion_id, prior_offset_ledger_account_id,
     prior_amount_minor, applied_by)
  values
    (p_household_id, v_series_id, v_deposit_txn_id, v_template_id, v_template_version, v_paycheck_id,
     v_token_id, v_suggestion_id, v_prior_offset, v_cash_amount, v_uid)
  returning id into v_app_id;

  v_after := jsonb_build_object(
    'paycheckId', v_paycheck_id,
    'applicationId', v_app_id,
    'depositTxnId', v_deposit_txn_id,
    'grossMinor', v_gross::text,
    'netMinor', v_net::text,
    'newBatchId', v_set_splits_result->'effects'->>'newBatchId',
    'splitCount', v_set_splits_result->'effects'->>'splitCount',
    'approvalTokenId', v_token_id,
    'templateId', v_template_id,
    'templateVersion', v_template_version);
  v_result := jsonb_build_object(
    'commandId', p_command_id, 'economicEventKey', p_economic_event_key,
    'idempotentReplay', false, 'effects', v_after,
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'));

  perform public.keel_finish_command(
    p_command_id, 'paychecks.apply_template', p_economic_event_key, p_household_id, v_actor,
    v_hash, 'paychecks.template_applied', 'paycheck', v_paycheck_id, v_after, v_result);

  return v_result;
end;
$$;

-- ===========================================================================
-- 5. keel_cmd_paycheck_unapply — reverse via the SAME set_splits correction path
--    (Law 2: undo, never delete). Re-invokes keel_cmd_set_splits to restore the
--    deposit's ORIGINAL single-category offset (captured in the application row),
--    producing a compensating journal_revision; reverses the paycheck record; flips
--    the application revoked_at; dismisses the originating suggestion. Idempotent
--    (already-revoked → typed error / replay).
-- ===========================================================================
create function public.keel_cmd_paycheck_unapply(
  p_command_id uuid,
  p_economic_event_key text,
  p_actor jsonb,
  p_household_id uuid,
  p_payload jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hash text := public.keel_payload_hash(p_payload);
  v_replay jsonb;
  v_actor jsonb;
  v_uid uuid;
  v_app public.paycheck_template_applications%rowtype;
  v_restore_payload jsonb;
  v_restore_result jsonb;
  v_after jsonb;
  v_result jsonb;
begin
  perform public.keel_assert_member_write(p_household_id);
  v_actor := public.keel_actor_from_jwt();
  v_uid := (v_actor->>'userId')::uuid;
  v_replay := public.keel_idempotency_check(p_household_id, p_economic_event_key, v_hash);
  if v_replay is not null then
    return v_replay;
  end if;

  if jsonb_typeof(p_payload) <> 'object'
     or (p_payload - 'paycheck_id') <> '{}'::jsonb
     or coalesce(p_payload->>'paycheck_id', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception 'KEEL_INVALID_COMMAND: malformed unapply payload' using errcode = 'P0009';
  end if;

  select * into v_app from public.paycheck_template_applications
   where household_id = p_household_id and paycheck_id = (p_payload->>'paycheck_id')::uuid
   for update;
  if not found or not public.keel_recurring_account_access(p_household_id,
        (select account_id from public.canonical_transactions where household_id = p_household_id and id = v_app.deposit_txn_id), true) then
    raise exception 'KEEL_SCOPE_VIOLATION: application not found' using errcode = 'P0006';
  end if;
  if v_app.revoked_at is not null then
    raise exception 'KEEL_INVALID_COMMAND: application already unapplied' using errcode = 'P0009';
  end if;
  if v_app.prior_offset_ledger_account_id is null then
    raise exception 'KEEL_INVALID_COMMAND: no prior offset recorded to restore' using errcode = 'P0009';
  end if;

  -- (a) RESTORE the deposit's original single-category offset via set_splits (Law 7
  -- + Law 2: the same correction model produces the compensating revision). Splits
  -- sum to −cash: a single category leg = −cashAmount.
  v_restore_payload := jsonb_build_object(
    'transaction_id', v_app.deposit_txn_id::text,
    'amount_minor', v_app.prior_amount_minor::text,
    'splits', jsonb_build_array(jsonb_build_object(
      'category_ledger_account_id', v_app.prior_offset_ledger_account_id::text,
      'amount_minor', (-v_app.prior_amount_minor)::text)));
  v_restore_result := public.keel_cmd_set_splits(
    gen_random_uuid(),
    p_economic_event_key || ':restore_splits',
    v_actor,
    p_household_id,
    v_restore_payload);

  -- (b) Reverse the paycheck record (compensating status event, Law 2).
  perform public.keel_paycheck_transition_core(
    gen_random_uuid(),
    p_economic_event_key || ':paycheck_reverse',
    v_actor,
    p_household_id,
    jsonb_build_object('paycheck_id', v_app.paycheck_id::text, 'reason', 'template unapplied'),
    'reversed');

  -- (c) Flip the application revoked_at (Law 2: never deleted).
  update public.paycheck_template_applications
     set revoked_at = now(), revoked_by = v_uid
   where household_id = p_household_id and id = v_app.id;

  -- (d) Dismiss the originating suggestion (it is no longer applied).
  if v_app.applied_from_suggestion_id is not null then
    update public.paycheck_split_suggestions
       set status = 'dismissed', decided_by = v_uid, decided_at = now(), applied_paycheck_id = null
     where household_id = p_household_id and id = v_app.applied_from_suggestion_id
       and status = 'accepted';
  end if;

  v_after := jsonb_build_object(
    'applicationId', v_app.id, 'paycheckId', v_app.paycheck_id,
    'depositTxnId', v_app.deposit_txn_id, 'revoked', true,
    'restoreBatchId', v_restore_result->'effects'->>'newBatchId');
  v_result := jsonb_build_object(
    'commandId', p_command_id, 'economicEventKey', p_economic_event_key,
    'idempotentReplay', false, 'effects', v_after,
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'));

  perform public.keel_finish_command(
    p_command_id, 'paychecks.unapply', p_economic_event_key, p_household_id, v_actor,
    v_hash, 'paychecks.template_unapplied', 'paycheck', v_app.paycheck_id, v_after, v_result);

  return v_result;
end;
$$;

-- ===========================================================================
-- 6. Guard: a plain paychecks.reverse on a TEMPLATE-APPLIED paycheck must route
--    through unapply (which also reverses the booking). Add the guard to
--    keel_paycheck_transition_core: reject a 'reversed' transition when the
--    paycheck has a live (non-revoked) application, UNLESS the caller is the
--    unapply proc (which calls with reason 'template unapplied'). Recreated
--    verbatim from 20260712130000 with ONLY the guard inserted.
-- ===========================================================================
create or replace function public.keel_paycheck_transition_core(
  p_command_id uuid,p_economic_event_key text,p_actor jsonb,p_household_id uuid,p_payload jsonb,p_transition public.paycheck_transition
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_hash text:=public.keel_payload_hash(p_payload); v_replay jsonb; v_actor jsonb; v_row public.paychecks%rowtype;
  v_before jsonb; v_after jsonb; v_result jsonb; v_status public.paycheck_status; v_command text;
begin
  perform public.keel_assert_member_write(p_household_id); v_actor:=public.keel_actor_from_jwt();
  v_replay:=public.keel_idempotency_check(p_household_id,p_economic_event_key,v_hash); if v_replay is not null then return v_replay; end if;
  if jsonb_typeof(p_payload)<>'object' or (p_payload-'paycheck_id'-'reason')<>'{}'::jsonb
    or coalesce(p_payload->>'paycheck_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or length(coalesce(p_payload->>'reason','')) not between 1 and 500
  then raise exception 'KEEL_INVALID_COMMAND: malformed paycheck transition' using errcode='P0009'; end if;
  select * into v_row from public.paychecks where household_id=p_household_id and id=(p_payload->>'paycheck_id')::uuid for update;
  if not found or not public.keel_paycheck_access(p_household_id,v_row.id,true)
  then raise exception 'KEEL_SCOPE_VIOLATION: paycheck not found' using errcode='P0006'; end if;
  if (p_transition='reversed' and v_row.status<>'active')
    or (p_transition='restored' and (v_row.status<>'reversed' or v_row.superseded_by_paycheck_id is not null))
  then raise exception 'KEEL_INVALID_COMMAND: invalid paycheck transition' using errcode='P0009'; end if;
  -- Restore-time overallocation guard, restated VERBATIM from the live tip
  -- (20260718092000_paycheck_restore_capacity_guard). This §6 CREATE OR REPLACE
  -- runs last, so it MUST carry this guard forward or it silently reverts the fix
  -- and re-opens the paycheck-restore double-count bug (Slice-D review blocker).
  if p_transition='restored' and exists (
    select 1
    from (
      select pm.transaction_id,sum(pm.allocated_minor) as mine_minor
      from public.paycheck_transaction_matches pm
      where pm.household_id=p_household_id and pm.paycheck_id=v_row.id
      group by pm.transaction_id
    ) mine
    left join lateral (
      select abs(asset.amount_minor) as capacity_minor
      from public.canonical_transactions t
      join public.accounts a on a.household_id=t.household_id and a.id=t.account_id
      join lateral (
        select b.id from public.journal_batches b
        where b.household_id=t.household_id and b.canonical_transaction_id=t.id
          and b.reverses_batch_id is null
          and not exists(select 1 from public.journal_revisions r where r.original_batch_id=b.id)
        order by b.posted_at desc,b.id desc limit 1
      ) live on true
      join public.journal_postings asset on asset.batch_id=live.id and asset.ledger_account_id=a.ledger_account_id
      where t.household_id=p_household_id and t.id=mine.transaction_id and asset.amount_minor>0
    ) cap on true
    left join lateral (
      select coalesce(sum(other.allocated_minor),0) as others_minor
      from public.paycheck_transaction_matches other
      join public.paychecks op on op.household_id=other.household_id and op.id=other.paycheck_id
      where other.household_id=p_household_id and other.transaction_id=mine.transaction_id
        and op.status='active' and op.id<>v_row.id
    ) o on true
    where mine.mine_minor+coalesce(o.others_minor,0)>coalesce(cap.capacity_minor,0)
  ) then
    raise exception 'KEEL_INVALID_COMMAND: restoring would overallocate an already-claimed deposit' using errcode='P0009';
  end if;
  -- SLICE D guard: a template-applied paycheck (live application) must be undone via
  -- paychecks.unapply (which also reverses the booking). unapply itself calls this
  -- proc with reason 'template unapplied' AFTER flipping nothing yet, so allow that
  -- exact reason; block any other reverse.
  if p_transition='reversed'
     and coalesce(p_payload->>'reason','') <> 'template unapplied'
     and exists (
       select 1 from public.paycheck_template_applications a
        where a.household_id=p_household_id and a.paycheck_id=v_row.id and a.revoked_at is null
     )
  then raise exception 'KEEL_INVALID_COMMAND: template-applied paycheck must be undone via paychecks.unapply' using errcode='P0009'; end if;
  v_status:=case when p_transition='reversed' then 'reversed'::public.paycheck_status else 'active'::public.paycheck_status end;
  v_command:=case when p_transition='reversed' then 'paychecks.reverse' else 'paychecks.restore' end;
  v_before:=jsonb_build_object('paycheckId',v_row.id,'status',v_row.status);
  insert into public.paycheck_status_events(household_id,paycheck_id,transition,reason,actor,command_id)
    values(p_household_id,v_row.id,p_transition,p_payload->>'reason',v_actor,p_command_id);
  update public.paychecks set status=v_status,updated_at=now() where household_id=p_household_id and id=v_row.id;
  v_after:=jsonb_build_object('paycheckId',v_row.id,'status',v_status,'reason',p_payload->>'reason');
  v_result:=jsonb_build_object('commandId',p_command_id,'economicEventKey',p_economic_event_key,'idempotentReplay',false,'effects',v_after,'asOf',to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS"Z"'));
  insert into public.audit_log(household_id,actor,action,object_type,object_id,command_id,before,after)
    values(p_household_id,v_actor,v_command,'paycheck',v_row.id,p_command_id,v_before,v_after);
  insert into public.domain_events(event_type,household_id,command_id,economic_event_key,actor,payload)
    values('paychecks.'||p_transition::text,p_household_id,p_command_id,p_economic_event_key,v_actor,v_after);
  insert into public.command_executions(household_id,economic_event_key,command_id,command,payload_sha256,result)
    values(p_household_id,p_economic_event_key,p_command_id,v_command,v_hash,v_result);
  return v_result;
end; $$;

-- ===========================================================================
-- 6b. keel_list_paychecks — surface templateId/templateVersion + templateApplied
--     on each row so the UI can show the "Booked from template" badge + route a
--     template-applied paycheck's undo through paychecks.unapply. Restated verbatim
--     from 20260712130000 with ONLY those three DTO fields added.
-- ===========================================================================
create or replace function public.keel_list_paychecks(p_household_id uuid) returns jsonb language plpgsql security definer stable set search_path=public as $$
declare v_uid uuid:=coalesce(nullif(pg_catalog.current_setting('request.jwt.claim.sub',true),''),nullif(pg_catalog.current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid; v_rows jsonb;
begin
  if v_uid is null then raise exception 'KEEL_NOT_AUTHENTICATED' using errcode='P0004'; end if;
  if not exists(select 1 from public.household_memberships where household_id=p_household_id and user_id=v_uid)
  then raise exception 'KEEL_SCOPE_VIOLATION' using errcode='P0006'; end if;
  select coalesce(jsonb_agg(row.dto order by row.pay_date desc,row.id),'[]'::jsonb) into v_rows from (
    select p.id,p.pay_date,jsonb_build_object('paycheckId',p.id,'employerId',p.employer_id,'employerName',e.name,
      'payDate',to_char(p.pay_date,'YYYY-MM-DD'),'grossMinor',p.gross_minor::text,'netMinor',p.net_minor::text,
      'currency',p.currency::text,'status',p.status,'formulaVersion',p.formula_version,
      'templateId',p.template_id,'templateVersion',p.template_version,
      'templateApplied', exists (select 1 from public.paycheck_template_applications a
        where a.household_id=p.household_id and a.paycheck_id=p.id and a.revoked_at is null),
      'supersededByPaycheckId', p.superseded_by_paycheck_id,
      'components',coalesce((select jsonb_agg(jsonb_build_object('componentId',c.id,'key',c.component_key,'kind',c.kind,'amountMinor',c.amount_minor::text) order by c.component_key)
        from public.paycheck_components c where c.household_id=p.household_id and c.paycheck_id=p.id),'[]'::jsonb),
      'matches',coalesce((select jsonb_agg(jsonb_build_object('matchId',m.id,'componentId',m.component_id,'transactionId',m.transaction_id,'allocatedMinor',m.allocated_minor::text) order by m.id)
        from public.paycheck_transaction_matches m where m.household_id=p.household_id and m.paycheck_id=p.id),'[]'::jsonb),
      'sources',coalesce((select jsonb_agg(jsonb_build_object('sourceId',s.id,'kind',s.source_kind,'ref',s.source_ref,'contentHash',s.content_hash) order by s.id)
        from public.paycheck_sources s where s.household_id=p.household_id and s.paycheck_id=p.id),'[]'::jsonb),
      'statusEvents',coalesce((select jsonb_agg(jsonb_build_object('transition',se.transition,'reason',se.reason,'commandId',se.command_id,'createdAt',to_char(se.created_at at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) order by se.created_at,se.command_id)
        from public.paycheck_status_events se where se.household_id=p.household_id and se.paycheck_id=p.id),'[]'::jsonb)) dto
    from public.paychecks p join public.employers e on e.household_id=p.household_id and e.id=p.employer_id
    where p.household_id=p_household_id and public.keel_paycheck_access(p_household_id,p.id,false)
  ) row;
  return jsonb_build_object('scope',jsonb_build_object('householdId',p_household_id),'asOf',to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS"Z"'),'formulaVersion','paycheck-reconciliation-v1','rows',v_rows);
end; $$;

-- ===========================================================================
-- 7. Ownership + grants ritual (grant-create → alter-owner → revoke-create).
--    apply/unapply/issue procs owned by keel_api. AGENT-SAFETY: apply + unapply
--    are execute-granted to authenticated ONLY (NOT service_role/anon) — a trusted
--    agent principal has NO grant on them and can only suggest (Slice E). issue is
--    authenticated + keel_api. The internal compute/payload helpers are revoked
--    from clients (only the definer procs call them).
-- ===========================================================================
grant create on schema public to keel_api;
alter function public.keel_paycheck_template_compute(uuid, uuid, bigint) owner to keel_api;
alter function public.keel_paycheck_apply_payload(uuid, uuid, uuid, uuid, int) owner to keel_api;
alter function public.keel_cmd_paycheck_issue_apply_token(uuid, uuid, uuid, uuid, int) owner to keel_api;
alter function public.keel_cmd_paycheck_apply_template(uuid, text, jsonb, uuid, jsonb) owner to keel_api;
alter function public.keel_cmd_paycheck_unapply(uuid, text, jsonb, uuid, jsonb) owner to keel_api;
alter function public.keel_paycheck_transition_core(uuid, text, jsonb, uuid, jsonb, public.paycheck_transition) owner to keel_api;
alter function public.keel_list_paychecks(uuid) owner to keel_api;
revoke create on schema public from keel_api;

-- Internal helpers: never called by clients directly (only the definer procs).
revoke all on function public.keel_paycheck_template_compute(uuid, uuid, bigint) from public, anon, authenticated, service_role;
revoke all on function public.keel_paycheck_apply_payload(uuid, uuid, uuid, uuid, int) from public, anon, authenticated, service_role;
-- compute is also probed by the parity pgTAP + integration tests via keel_api/service.
grant execute on function public.keel_paycheck_template_compute(uuid, uuid, bigint) to keel_api, service_role;
grant execute on function public.keel_paycheck_apply_payload(uuid, uuid, uuid, uuid, int) to keel_api, service_role;

revoke all on function public.keel_cmd_paycheck_issue_apply_token(uuid, uuid, uuid, uuid, int) from public, anon, service_role;
revoke all on function public.keel_cmd_paycheck_apply_template(uuid, text, jsonb, uuid, jsonb) from public, anon, service_role;
revoke all on function public.keel_cmd_paycheck_unapply(uuid, text, jsonb, uuid, jsonb) from public, anon, service_role;

grant execute on function public.keel_cmd_paycheck_issue_apply_token(uuid, uuid, uuid, uuid, int) to authenticated, keel_api;
grant execute on function public.keel_cmd_paycheck_apply_template(uuid, text, jsonb, uuid, jsonb) to authenticated;
grant execute on function public.keel_cmd_paycheck_unapply(uuid, text, jsonb, uuid, jsonb) to authenticated;

-- Fail-closed ownership assertion.
do $$
begin
  if exists (
    select 1 from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     join pg_roles r on r.oid = p.proowner
    where n.nspname = 'public'
      and p.proname in ('keel_paycheck_template_compute','keel_paycheck_apply_payload',
                        'keel_cmd_paycheck_issue_apply_token','keel_cmd_paycheck_apply_template',
                        'keel_cmd_paycheck_unapply','keel_paycheck_transition_core')
      and p.prosecdef and r.rolname <> 'keel_api'
  ) then
    raise exception 'KEEL_OWNERSHIP: paycheck apply/unapply proc not owned by keel_api';
  end if;
end$$;

-- ===========================================================================
-- 8. Export (Law 6): paycheck_template_applications joins the audited export
--    contract (tenant scope + the link between an already-exported paycheck /
--    deposit / template and the token that approved it). No secrets. Wrap the
--    CURRENT outermost (keel_export_household_pre_paycheck_split_templates was
--    renamed to keel_export_household by Slice B; wrap that live tip).
-- ===========================================================================
grant select on public.paycheck_template_applications to keel_export;
create policy paycheck_template_applications_export on public.paycheck_template_applications
  for select to keel_export using (true);

alter function public.keel_export_household(uuid, timestamptz)
  rename to keel_export_household_pre_paycheck_template_apps;
revoke all on function public.keel_export_household_pre_paycheck_template_apps(uuid, timestamptz)
  from public, anon, authenticated, service_role;

create function public.keel_export_household(p_household_id uuid, p_as_of timestamptz default null)
returns jsonb language plpgsql security definer stable set search_path = pg_catalog, public as $$
declare v_base jsonb; v_tables jsonb; begin
  v_base := public.keel_export_household_pre_paycheck_template_apps(p_household_id, p_as_of);
  select jsonb_build_object(
    'paycheck_template_applications', coalesce((
      select jsonb_agg(to_jsonb(x) || jsonb_build_object('prior_amount_minor', x.prior_amount_minor::text)
        order by x.household_id, x.id)
      from public.paycheck_template_applications x where x.household_id = p_household_id), '[]'::jsonb)
  ) into v_tables;
  return jsonb_set(v_base, '{tables}', v_base->'tables' || v_tables);
end$$;
revoke all on function public.keel_export_household(uuid, timestamptz)
  from public, anon, authenticated, service_role;
grant create on schema public to keel_export;
alter function public.keel_export_household(uuid, timestamptz) owner to keel_export;
revoke create on schema public from keel_export;
grant execute on function public.keel_export_household(uuid, timestamptz) to service_role;
