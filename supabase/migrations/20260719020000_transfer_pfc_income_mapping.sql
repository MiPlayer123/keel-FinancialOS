-- fix(categorization): Plaid TRANSFER_IN / TRANSFER_OUT / LOAN_PAYMENTS inflows
-- were being filed as "Other Income", inflating income and corrupting reports.
--
-- ROOT CAUSE (diagnosed on the live founder household, 2026-07-19). Of 1,351
-- categorized transactions, 881 sat in "Other Income" — Plaid's own PFC on
-- those 881 inflows is overwhelmingly a TRANSFER, not income:
--     TRANSFER_IN_TRANSFER_IN_FROM_APPS   309  (Venmo / Zelle / Apple Cash — the
--                                               counterparties array names them)
--     TRANSFER_OUT_ACCOUNT_TRANSFER        58  (inter-account credit legs)
--     LOAN_PAYMENTS_CREDIT_CARD_PAYMENT    12  (credit-card payment received)
--     TRANSFER_IN_* (deposit/account/other) 6
--     OTHER_OTHER                         466  (genuinely ambiguous P2P — Plaid
--                                               itself could not classify)
--     INCOME_* (salary/contractor)         ~0  (correctly filed as Income)
--
-- keel_pfc_to_category_key (20260713090000 §3) maps EVERY inflow (income-kind
-- offset) whose PFC primary is not exactly 'INCOME' to 'other_income':
--     when p_kind = 'income' then
--       case when p_primary = 'INCOME' then 'income' else 'other_income' end
-- so TRANSFER_IN / TRANSFER_OUT / LOAN_PAYMENTS inflows all collapse to Other
-- Income. The EXPENSE branch already routes TRANSFER_IN / TRANSFER_OUT →
-- 'transfers'; the income branch simply never gained the counterpart. (This is
-- the exact shape of the recurring-reader liability bug fixed in
-- 20260719000000: a sign/kind branch silently dropping a whole class.)
--
-- Why the TRANSFER DETECTOR does not rescue these: keel_detect_transfers pairs
-- EXACT opposite cash amounts across accounts within 3 days. Diagnosis showed
-- it already caught every genuinely-pairable pair (0 additional exact pairs
-- exist), because these transfers are ONE-SIDED in the data — the Venmo/CashApp
-- balance and most paid-off cards are not connected KEEL accounts, so an inflow
-- has no opposite leg to match. Widening the detector's date window to 5–14
-- days was tested and produces FALSE POSITIVES (this dataset is P2P-heavy with
-- many colliding round-dollar amounts: a "$30 to Prashanth" outflow pairs with
-- an unrelated "$30 Zara cruise" inflow). The 3-day exact-amount window is
-- correctly conservative and is intentionally left UNCHANGED — the fix belongs
-- entirely in the PFC→category mapping, which is where Plaid's own signal lives.
--
-- THE FIX (deterministic, Law 1 — no LLM; suggest→approve, Laws 2/10 class B):
--   1. A per-entity income-kind "Transfers In" category (pfc_key 'transfers_in')
--      — the picker requires the mapper's target category to share the
--      transaction's ledger KIND (income), and the seeded "Transfers" is
--      expense-kind only. A DISTINCT name is mandatory: ledger_accounts_
--      category_name_ci (20260713070000) is unique on (entity_id, lower(name))
--      regardless of kind, so a second "Transfers" would collide.
--   2. keel_pfc_to_category_key income branch routes TRANSFER_IN / TRANSFER_OUT
--      / LOAN_PAYMENTS → 'transfers_in' (mirrors the expense branch).
--   3. keel_cash_flow / keel_cash_flow_monthly exclude the 'transfers' and
--      'transfers_in' category pfc_keys from income/spend — a transaction the
--      user has (or accepts a suggestion to) categorize as a transfer must drop
--      out of the income total even when it is one-sided (no paired link). This
--      is the actual income-inflation fix; the category alone is cosmetic
--      without it because analytics key off ledger kind.
--
-- Nothing here bulk-overwrites the ledger. keel_autocategorize_household uses
-- ON CONFLICT DO NOTHING, so it never re-labels the existing 881 (their overlay
-- source is already 'plaid_pfc'); the corrected mapping reaches them ONLY as
-- keel_detect_category_suggestions proposals the user approves one card at a
-- time (the plaid_pfc-defaulted rows are exactly this detector's target class).
-- Future syncs get the correct category at ingestion via the same mapper.
--
-- HONEST SCOPE: this reclassifies the ~385 TRANSFER_*/LOAN_PAYMENTS inflows
-- (≈$62k currently double-counted as income) into Transfers-In suggestions. The
-- 466 OTHER_OTHER Venmo rows stay in Other Income — Plaid gave no transfer
-- signal for them, so they remain genuinely ambiguous and need manual user
-- categorization. No column/table changes (Law 6 export DTO unaffected: the new
-- rows are ordinary ledger_accounts, already fully exported).

-- ---------------------------------------------------------------------------
-- 1. Mapper: income branch gains the transfer routing (create-or-replace, same
-- signature → the two live callers keel_autocategorize_household /
-- keel_detect_category_suggestions pick this up with no recreation). Expense
-- branch is byte-identical to 20260713090000.
-- ---------------------------------------------------------------------------
create or replace function public.keel_pfc_to_category_key(
  p_primary text,
  p_kind public.ledger_account_kind
) returns text
language sql
immutable
as $$
  select case
    when p_kind = 'income' then
      case p_primary
        when 'INCOME' then 'income'
        -- Inflows Plaid labels as a transfer or a loan/credit-card payment are
        -- NOT income. There is no income-kind 'transfers' seed (that one is
        -- expense-kind), so these route to the income-kind 'transfers_in'
        -- landing category added by this migration. Mirrors the expense branch
        -- below, which has always sent TRANSFER_IN/OUT → 'transfers'.
        when 'TRANSFER_IN' then 'transfers_in'
        when 'TRANSFER_OUT' then 'transfers_in'
        when 'LOAN_PAYMENTS' then 'transfers_in'
        else 'other_income'
      end
    else
      case p_primary
        when 'BANK_FEES' then 'fees'
        when 'ENTERTAINMENT' then 'entertainment'
        when 'FOOD_AND_DRINK' then 'food_drink'
        when 'GENERAL_MERCHANDISE' then 'shopping'
        when 'GENERAL_SERVICES' then 'services'
        when 'GOVERNMENT_AND_NON_PROFIT' then 'government_nonprofit'
        when 'HOME_IMPROVEMENT' then 'home'
        when 'LOAN_PAYMENTS' then 'loan_payments'
        when 'MEDICAL' then 'medical'
        when 'PERSONAL_CARE' then 'personal_care'
        when 'RENT_AND_UTILITIES' then 'bills_utilities'
        when 'TRANSPORTATION' then 'transportation'
        when 'TRAVEL' then 'travel'
        when 'TRANSFER_OUT' then 'transfers'
        when 'TRANSFER_IN' then 'transfers'
        else 'other'
      end
  end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Seed the income-kind "Transfers In" landing category. Extend
-- keel_seed_entity_categories (live body: 20260718140000) so every FUTURE
-- entity gets it, then backfill existing non-fixture entities. Idempotent:
-- dedupe by pfc_key (no archived_at filter — an archived/renamed one is not
-- resurrected) AND skip a live case-insensitive name collision (a user may
-- already own a "Transfers In"), exactly the parent seed's contract. Full
-- recreate of the proc with ONLY the one new parent row; the entire
-- subcategory block is byte-identical to 20260718140000.
-- ---------------------------------------------------------------------------
create or replace function public.keel_seed_entity_categories(
  p_entity_id uuid,
  p_household_id uuid
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Fail closed on a forged pairing: the entity must belong to the household.
  if not exists (
    select 1 from public.entities e
    where e.id = p_entity_id and e.household_id = p_household_id
  ) then
    raise exception 'KEEL_SCOPE_VIOLATION: entity not in household' using errcode = 'P0006';
  end if;

  insert into public.ledger_accounts
    (household_id, entity_id, name, kind, currency, is_category, pfc_key, is_system)
  select p_household_id, p_entity_id, d.name, d.kind::public.ledger_account_kind,
         'USD', d.is_category, d.pfc_key, true
  from (values
    ('Uncategorized Expense',  'expense', true,  'uncategorized_expense'),
    ('Uncategorized Income',   'income',  true,  'uncategorized_income'),
    ('Opening Balances',       'equity',  false, 'opening_balances'),
    ('Fees',                   'expense', true,  'fees'),
    ('Entertainment',          'expense', true,  'entertainment'),
    ('Food & Drink',           'expense', true,  'food_drink'),
    ('Shopping',               'expense', true,  'shopping'),
    ('Services',               'expense', true,  'services'),
    ('Government & Nonprofit', 'expense', true,  'government_nonprofit'),
    ('Home',                   'expense', true,  'home'),
    ('Loan Payments',          'expense', true,  'loan_payments'),
    ('Medical',                'expense', true,  'medical'),
    ('Personal Care',          'expense', true,  'personal_care'),
    ('Bills & Utilities',      'expense', true,  'bills_utilities'),
    ('Transportation',         'expense', true,  'transportation'),
    ('Travel',                 'expense', true,  'travel'),
    ('Transfers',              'expense', true,  'transfers'),
    ('Other',                  'expense', true,  'other'),
    ('Income',                 'income',  true,  'income'),
    ('Other Income',           'income',  true,  'other_income'),
    -- NEW: income-kind counterpart of the expense "Transfers" so inflows Plaid
    -- labels TRANSFER_IN/OUT / LOAN_PAYMENTS have a same-kind home (they are
    -- not income). Distinct name (the name-ci index ignores kind).
    ('Transfers In',           'income',  true,  'transfers_in')
  ) as d(name, kind, is_category, pfc_key)
  where not exists (
    select 1 from public.ledger_accounts la
    where la.entity_id = p_entity_id and la.pfc_key = d.pfc_key
  )
  and not exists (
    select 1 from public.ledger_accounts la
    where la.entity_id = p_entity_id and la.is_category = true
      and la.archived_at is null and lower(la.name) = lower(d.name)
  );

  -- Default subcategories (F-016a). Inserted AFTER the parents so a fresh
  -- entity resolves every parent within this same call. Landing pads
  -- (uncategorized_*), Transfers, Transfers In, Other, and Other Income
  -- deliberately get none — they are catch-alls, not taxonomies.
  insert into public.ledger_accounts
    (household_id, entity_id, name, kind, currency, is_category,
     pfc_key, is_system, parent_ledger_account_id)
  select p_household_id, p_entity_id, s.name, s.kind::public.ledger_account_kind,
         parent.currency, true, s.pfc_key, true, parent.id
  from (values
    -- Food & Drink
    ('Groceries',              'expense', 'food_drink',           'food_drink_groceries'),
    ('Restaurants',            'expense', 'food_drink',           'food_drink_restaurants'),
    ('Coffee shops',           'expense', 'food_drink',           'food_drink_coffee'),
    ('Delivery & takeout',     'expense', 'food_drink',           'food_drink_delivery'),
    -- Transportation
    ('Gas',                    'expense', 'transportation',       'transportation_gas'),
    ('Parking',                'expense', 'transportation',       'transportation_parking'),
    ('Rideshare',              'expense', 'transportation',       'transportation_rideshare'),
    ('Public transit',         'expense', 'transportation',       'transportation_public_transit'),
    ('Tolls',                  'expense', 'transportation',       'transportation_tolls'),
    -- Travel
    ('Flights',                'expense', 'travel',               'travel_flights'),
    ('Lodging',                'expense', 'travel',               'travel_lodging'),
    ('Rental cars',            'expense', 'travel',               'travel_rental_cars'),
    ('Vacation',               'expense', 'travel',               'travel_vacation'),
    -- Shopping
    ('Clothing',               'expense', 'shopping',             'shopping_clothing'),
    ('Electronics',            'expense', 'shopping',             'shopping_electronics'),
    ('Home goods',             'expense', 'shopping',             'shopping_home_goods'),
    ('Hobbies',                'expense', 'shopping',             'shopping_hobbies'),
    -- Bills & Utilities
    ('Rent',                   'expense', 'bills_utilities',      'bills_utilities_rent'),
    ('Electric',               'expense', 'bills_utilities',      'bills_utilities_electric'),
    ('Water & sewer',          'expense', 'bills_utilities',      'bills_utilities_water'),
    ('Internet',               'expense', 'bills_utilities',      'bills_utilities_internet'),
    ('Phone',                  'expense', 'bills_utilities',      'bills_utilities_phone'),
    -- Entertainment
    ('Streaming',              'expense', 'entertainment',        'entertainment_streaming'),
    ('Events',                 'expense', 'entertainment',        'entertainment_events'),
    ('Games',                  'expense', 'entertainment',        'entertainment_games'),
    -- Medical
    ('Primary care',           'expense', 'medical',              'medical_primary_care'),
    ('Dental',                 'expense', 'medical',              'medical_dental'),
    ('Pharmacy',               'expense', 'medical',              'medical_pharmacy'),
    ('Vision',                 'expense', 'medical',              'medical_vision'),
    -- Personal Care
    ('Gym & fitness',          'expense', 'personal_care',        'personal_care_fitness'),
    ('Hair & beauty',          'expense', 'personal_care',        'personal_care_hair_beauty'),
    ('Laundry & dry cleaning', 'expense', 'personal_care',        'personal_care_laundry'),
    -- Home
    ('Repairs & maintenance',  'expense', 'home',                 'home_repairs'),
    ('Furnishings',            'expense', 'home',                 'home_furnishings'),
    ('Garden & outdoor',       'expense', 'home',                 'home_garden'),
    ('Security',               'expense', 'home',                 'home_security'),
    -- Loan Payments
    ('Mortgage payment',       'expense', 'loan_payments',        'loan_payments_mortgage'),
    ('Credit card payment',    'expense', 'loan_payments',        'loan_payments_credit_card'),
    ('Car payment',            'expense', 'loan_payments',        'loan_payments_car'),
    ('Student loan payment',   'expense', 'loan_payments',        'loan_payments_student'),
    -- Fees
    ('Bank fees',              'expense', 'fees',                 'fees_bank'),
    ('ATM fees',               'expense', 'fees',                 'fees_atm'),
    ('Interest charges',       'expense', 'fees',                 'fees_interest'),
    ('Late fees',              'expense', 'fees',                 'fees_late'),
    -- Services
    ('Insurance',              'expense', 'services',             'services_insurance'),
    ('Education',              'expense', 'services',             'services_education'),
    ('Childcare',              'expense', 'services',             'services_childcare'),
    ('Professional services',  'expense', 'services',             'services_professional'),
    -- Government & Nonprofit
    ('Taxes',                  'expense', 'government_nonprofit', 'government_nonprofit_taxes'),
    ('Donations',              'expense', 'government_nonprofit', 'government_nonprofit_donations'),
    -- Income
    ('Paycheck',               'income',  'income',               'income_paycheck'),
    ('Interest',               'income',  'income',               'income_interest'),
    ('Dividends',              'income',  'income',               'income_dividends')
  ) as s(name, kind, parent_key, pfc_key)
  join public.ledger_accounts parent
    on parent.entity_id = p_entity_id
   and parent.pfc_key = s.parent_key
   and parent.is_category = true
   and parent.kind = s.kind::public.ledger_account_kind
   and parent.archived_at is null
   and parent.parent_ledger_account_id is null
  where not exists (
    select 1 from public.ledger_accounts la
    where la.entity_id = p_entity_id and la.pfc_key = s.pfc_key
  )
  and not exists (
    select 1 from public.ledger_accounts la
    where la.entity_id = p_entity_id and la.is_category = true
      and la.archived_at is null and lower(la.name) = lower(s.name)
  );
end;
$$;

-- create-or-replace preserves the ACL, but re-assert the 20260713090000
-- lockdown exactly (defense against a fresh-db replay ordering surprise).
revoke all on function public.keel_seed_entity_categories(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.keel_seed_entity_categories(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 3. Backfill existing entities (same loop + fixture exclusions as the
-- 20260712200000 / 20260718140000 backfills — fixture entities keep their
-- deterministic category sets for the pgTAP/integration suites, which add the
-- Transfers-In fixture explicitly where needed). Idempotent seed re-run adds
-- only the missing 'transfers_in' category.
-- ---------------------------------------------------------------------------
do $$
declare r record;
begin
  for r in
    select id, household_id from public.entities
    where id not in (
      '00000000-0000-4000-8000-00000000a101',
      '00000000-0000-4000-8000-00000000a102',
      '00000000-0000-4000-8000-00000000b101')
  loop
    perform public.keel_seed_entity_categories(r.id, r.household_id);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Income read models exclude the transfer categories. A transaction the
-- user has categorized (or accepted a suggestion to categorize) as a transfer
-- posts to an income/expense ledger account by SIGN at ingestion, so cash-flow
-- would still count it as income/spend UNLESS the category is excluded. The
-- confirmed-transfer_links exclusion only covers PAIRED transfers; a one-sided
-- Venmo/credit-card-payment inflow has no pair, so we ALSO exclude any posting
-- whose category overlay (or, absent an overlay, its offset category) is a
-- transfer landing category ('transfers' / 'transfers_in'). Full recreate of
-- the two read models (live body: 20260718160000) with ONLY this predicate
-- added; the transfer-link and settlement exclusions are preserved verbatim.
--
-- Postgres gotcha: same signature → drop the exact signature first, then
-- create, then re-apply the ownership/grants 20260718160000 established.
-- ---------------------------------------------------------------------------

-- Helper predicate: is this transaction's EFFECTIVE category a transfer landing
-- category? Overlay (transaction_categories) wins over the offset posting,
-- exactly like the rich read model / detection targeting. STABLE, definer-safe,
-- scope-checked by the caller (household-scoped join). Kept counterparty-
-- agnostic and deterministic (Law 1).
create or replace function public.keel_txn_is_transfer_category(
  p_household_id uuid,
  p_transaction_id uuid
) returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select coalesce(
    -- Overlay category if present, else the single offset category's pfc_key.
    (
      select case
               when tc.canonical_transaction_id is not null then curla.pfc_key
               else offcat.pfc_key
             end in ('transfers', 'transfers_in')
        from public.canonical_transactions ct
        join public.journal_batches jb
          on jb.canonical_transaction_id = ct.id and jb.reverses_batch_id is null
         and not exists (
           select 1 from public.journal_revisions rev where rev.original_batch_id = jb.id
         )
        join public.journal_postings offp on offp.batch_id = jb.id
        join public.ledger_accounts offcat
          on offcat.id = offp.ledger_account_id and offcat.is_category = true
        left join public.transaction_categories tc on tc.canonical_transaction_id = ct.id
        left join public.ledger_accounts curla on curla.id = tc.category_ledger_account_id
       where ct.id = p_transaction_id
         and ct.household_id = p_household_id
       -- Single-offset only: a split transaction is never a whole-transfer.
       limit 1
    ), false);
$$;
revoke all on function public.keel_txn_is_transfer_category(uuid, uuid) from public, anon;
-- keel_cash_flow (owner keel_api) and keel_cash_flow_monthly both call this, so
-- keel_api needs EXECUTE. authenticated/service_role may also call it directly.
grant execute on function public.keel_txn_is_transfer_category(uuid, uuid)
  to authenticated, service_role, keel_api;

-- ---- keel_cash_flow ---------------------------------------------------------
drop function if exists public.keel_cash_flow(uuid, date, date);
create function public.keel_cash_flow(p_household_id uuid, p_from date, p_to date)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public
  stable
as $$
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
        'currency', p.currency,
        'inflowMinor', coalesce(-sum(p.amount_minor) filter (where la.kind = 'income'), 0)::text,
        'outflowMinor', coalesce(sum(p.amount_minor) filter (where la.kind = 'expense'), 0)::text,
        'netMinor', (
          coalesce(-sum(p.amount_minor) filter (where la.kind = 'income'), 0)
          - coalesce(sum(p.amount_minor) filter (where la.kind = 'expense'), 0)
        )::text
      ) as row
      from public.journal_postings p
      join public.journal_batches b on b.id = p.batch_id
      join public.ledger_accounts la on la.id = p.ledger_account_id
      where b.household_id = p_household_id
        and b.effective_date between p_from and p_to
        and la.kind in ('income', 'expense')
        -- Preserve the confirmed-transfer_links exclusion (20260713020000).
        and not exists (
          select 1 from public.transfer_links tl
          where tl.household_id = p_household_id
            and tl.status = 'confirmed'
            and (tl.txn_out = b.canonical_transaction_id
                 or tl.txn_in = b.canonical_transaction_id)
        )
        -- X-003: a settled reimbursement deposit is a settlement, not income.
        and not public.keel_is_non_income_settlement(b.household_id, b.canonical_transaction_id)
        -- 20260719020000: a transaction the user categorized as a transfer
        -- ('transfers' / 'transfers_in') is money movement, not income/spend —
        -- exclude it even when it has no paired opposite leg (one-sided Venmo,
        -- credit-card payment received). Excludes only NON-null canonical
        -- transactions (opening-balance batches carry no txn and are already
        -- kind='equity', so untouched here).
        and (b.canonical_transaction_id is null
             or not public.keel_txn_is_transfer_category(p_household_id, b.canonical_transaction_id))
      group by p.currency
    ) t;

  return jsonb_build_object(
    'scope', jsonb_build_object('householdId', p_household_id),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'formulaVersion', 'cash-flow-v4-transfer-category-excluded',
    'rows', v_rows
  );
end;
$$;

-- ---- keel_cash_flow_monthly -------------------------------------------------
drop function if exists public.keel_cash_flow_monthly(uuid, date, date);
create function public.keel_cash_flow_monthly(p_household_id uuid, p_from date, p_to date)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public
  stable
as $$
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
        'month', to_char(date_trunc('month', b.effective_date), 'YYYY-MM'),
        'currency', p.currency,
        'inflowMinor', coalesce(-sum(p.amount_minor) filter (where la.kind = 'income'), 0)::text,
        'outflowMinor', coalesce(sum(p.amount_minor) filter (where la.kind = 'expense'), 0)::text,
        'netMinor', (
          coalesce(-sum(p.amount_minor) filter (where la.kind = 'income'), 0)
          - coalesce(sum(p.amount_minor) filter (where la.kind = 'expense'), 0)
        )::text
      ) as row
      from public.journal_postings p
      join public.journal_batches b on b.id = p.batch_id
      join public.ledger_accounts la on la.id = p.ledger_account_id
      where b.household_id = p_household_id
        and b.effective_date between p_from and p_to
        and la.kind in ('income', 'expense')
        and not exists (
          select 1 from public.transfer_links tl
          where tl.household_id = p_household_id
            and tl.status = 'confirmed'
            and (tl.txn_out = b.canonical_transaction_id
                 or tl.txn_in = b.canonical_transaction_id)
        )
        -- X-003: exclude settled reimbursement deposits from income.
        and not public.keel_is_non_income_settlement(b.household_id, b.canonical_transaction_id)
        -- 20260719020000: exclude user-categorized transfers (see keel_cash_flow).
        and (b.canonical_transaction_id is null
             or not public.keel_txn_is_transfer_category(p_household_id, b.canonical_transaction_id))
      group by date_trunc('month', b.effective_date), p.currency
    ) t;

  return jsonb_build_object(
    'scope', jsonb_build_object('householdId', p_household_id),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'formulaVersion', 'cash-flow-monthly-v3-transfer-category-excluded',
    'rows', v_rows
  );
end;
$$;

-- Re-apply ownership + grants exactly as 20260718160000 did (DROP reset them):
-- keel_cash_flow owned by keel_api; keel_cash_flow_monthly left owned by the
-- migration runner (its original 20260713030000 never re-owned it).
grant create on schema public to keel_api;
alter function public.keel_cash_flow(uuid, date, date) owner to keel_api;
revoke create on schema public from keel_api;

revoke all on function public.keel_cash_flow(uuid, date, date) from public, anon;
revoke all on function public.keel_cash_flow_monthly(uuid, date, date) from public, anon;
grant execute on function public.keel_cash_flow(uuid, date, date) to authenticated;
grant execute on function public.keel_cash_flow_monthly(uuid, date, date) to authenticated, service_role;
