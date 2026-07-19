-- feat(categorization): seed the EXPENSE-kind "Transfers Out" landing category
-- (the mirror of income-kind "Transfers In" from 20260719020000) and teach the
-- cash-flow read models to exclude it. This is the category HOME that Slice B
-- (leg-category consistency on a confirmed two-sided card-payment transfer) and
-- Slice D (client/server surface parity) both land on.
--
-- SCOPE DECISION (founder, 2026-07-19 — "LEAVE AS-IS FOR NOW"): the mechanism
-- must ONLY ever reclassify a card payment as a transfer when KEEL can see BOTH
-- legs. A one-sided bank debit paying an UNCONNECTED own card (e.g. the ~$36k of
-- Citibank payoffs with no opposite credit in KEEL) STAYS counted as
-- loan-payment expense exactly as it is today, until the founder connects those
-- cards. We deliberately do NOT build the aggressive one-sided suggester that
-- would flag unconnected-card outflows as Transfers Out on a memo/PFC signal.
--
-- WHAT THIS MIGRATION DOES (deterministic, Law 1 — no LLM):
--   1. Seed an EXPENSE-kind "Transfers Out" category (pfc_key 'transfers_out').
--      A DISTINCT name is mandatory: ledger_accounts_category_name_ci
--      (20260713070000) is unique on (entity_id, lower(name)) regardless of
--      kind, so a second "Transfers" would collide. Exactly the 20260719020000
--      pattern. Needed by Slice B (which categorizes the outflow leg of a
--      CONFIRMED card-payment transfer as Transfers Out).
--   2. keel_txn_is_transfer_category gains 'transfers_out' to its excluded set;
--      keel_cash_flow / keel_cash_flow_monthly formula versions bump so a debit
--      that IS categorized Transfers Out (via Slice B's confirm-time leg
--      categorization, or a manual user action) drops out of SPEND.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO (dropped per the scope decision):
--   * keel_detect_category_suggestions is NOT modified — there is NO
--     card-payment proposal tier that would suggest Transfers Out for one-sided
--     unconnected-card outflows. Those debits keep their 'loan_payments'
--     categorization untouched. (Two-sided connected-card pairs are handled by
--     the transfer DETECTOR in 20260720160000 + Slice B's confirm hook, never
--     by a one-sided memo/PFC suggester.)
--
-- No column/table changes (Law 6 export DTO unaffected). Nothing here
-- bulk-overwrites the ledger.

-- ---------------------------------------------------------------------------
-- 1. Seed the expense-kind "Transfers Out" landing category. Extend
-- keel_seed_entity_categories (live body: 20260719020000) with ONLY the one new
-- parent row; the entire subcategory block is byte-identical. Idempotent:
-- dedupe by pfc_key AND skip a live case-insensitive name collision (a user may
-- already own a "Transfers Out"), exactly the parent seed's contract.
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
    ('Transfers In',           'income',  true,  'transfers_in'),
    -- NEW: expense-kind counterpart of "Transfers In". A bank debit that pays an
    -- unconnected own card is money movement out, not spend, but it posts to an
    -- expense category by sign, so it needs a same-kind (expense) transfer home.
    -- Distinct name (the name-ci index ignores kind).
    ('Transfers Out',          'expense', true,  'transfers_out')
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

  -- Default subcategories (F-016a). Byte-identical to 20260718140000 /
  -- 20260719020000; Transfers Out (like Transfers / Transfers In / Other)
  -- deliberately gets none — it is a catch-all, not a taxonomy.
  insert into public.ledger_accounts
    (household_id, entity_id, name, kind, currency, is_category,
     pfc_key, is_system, parent_ledger_account_id)
  select p_household_id, p_entity_id, s.name, s.kind::public.ledger_account_kind,
         parent.currency, true, s.pfc_key, true, parent.id
  from (values
    ('Groceries',              'expense', 'food_drink',           'food_drink_groceries'),
    ('Restaurants',            'expense', 'food_drink',           'food_drink_restaurants'),
    ('Coffee shops',           'expense', 'food_drink',           'food_drink_coffee'),
    ('Delivery & takeout',     'expense', 'food_drink',           'food_drink_delivery'),
    ('Gas',                    'expense', 'transportation',       'transportation_gas'),
    ('Parking',                'expense', 'transportation',       'transportation_parking'),
    ('Rideshare',              'expense', 'transportation',       'transportation_rideshare'),
    ('Public transit',         'expense', 'transportation',       'transportation_public_transit'),
    ('Tolls',                  'expense', 'transportation',       'transportation_tolls'),
    ('Flights',                'expense', 'travel',               'travel_flights'),
    ('Lodging',                'expense', 'travel',               'travel_lodging'),
    ('Rental cars',            'expense', 'travel',               'travel_rental_cars'),
    ('Vacation',               'expense', 'travel',               'travel_vacation'),
    ('Clothing',               'expense', 'shopping',             'shopping_clothing'),
    ('Electronics',            'expense', 'shopping',             'shopping_electronics'),
    ('Home goods',             'expense', 'shopping',             'shopping_home_goods'),
    ('Hobbies',                'expense', 'shopping',             'shopping_hobbies'),
    ('Rent',                   'expense', 'bills_utilities',      'bills_utilities_rent'),
    ('Electric',               'expense', 'bills_utilities',      'bills_utilities_electric'),
    ('Water & sewer',          'expense', 'bills_utilities',      'bills_utilities_water'),
    ('Internet',               'expense', 'bills_utilities',      'bills_utilities_internet'),
    ('Phone',                  'expense', 'bills_utilities',      'bills_utilities_phone'),
    ('Streaming',              'expense', 'entertainment',        'entertainment_streaming'),
    ('Events',                 'expense', 'entertainment',        'entertainment_events'),
    ('Games',                  'expense', 'entertainment',        'entertainment_games'),
    ('Primary care',           'expense', 'medical',              'medical_primary_care'),
    ('Dental',                 'expense', 'medical',              'medical_dental'),
    ('Pharmacy',               'expense', 'medical',              'medical_pharmacy'),
    ('Vision',                 'expense', 'medical',              'medical_vision'),
    ('Gym & fitness',          'expense', 'personal_care',        'personal_care_fitness'),
    ('Hair & beauty',          'expense', 'personal_care',        'personal_care_hair_beauty'),
    ('Laundry & dry cleaning', 'expense', 'personal_care',        'personal_care_laundry'),
    ('Repairs & maintenance',  'expense', 'home',                 'home_repairs'),
    ('Furnishings',            'expense', 'home',                 'home_furnishings'),
    ('Garden & outdoor',       'expense', 'home',                 'home_garden'),
    ('Security',               'expense', 'home',                 'home_security'),
    ('Mortgage payment',       'expense', 'loan_payments',        'loan_payments_mortgage'),
    ('Credit card payment',    'expense', 'loan_payments',        'loan_payments_credit_card'),
    ('Car payment',            'expense', 'loan_payments',        'loan_payments_car'),
    ('Student loan payment',   'expense', 'loan_payments',        'loan_payments_student'),
    ('Bank fees',              'expense', 'fees',                 'fees_bank'),
    ('ATM fees',               'expense', 'fees',                 'fees_atm'),
    ('Interest charges',       'expense', 'fees',                 'fees_interest'),
    ('Late fees',              'expense', 'fees',                 'fees_late'),
    ('Insurance',              'expense', 'services',             'services_insurance'),
    ('Education',              'expense', 'services',             'services_education'),
    ('Childcare',              'expense', 'services',             'services_childcare'),
    ('Professional services',  'expense', 'services',             'services_professional'),
    ('Taxes',                  'expense', 'government_nonprofit', 'government_nonprofit_taxes'),
    ('Donations',              'expense', 'government_nonprofit', 'government_nonprofit_donations'),
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
-- 2. Backfill existing entities (same loop + fixture exclusions as
-- 20260719020000). Idempotent seed re-run adds only the missing 'transfers_out'
-- category.
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
-- (Section 2b + 3 — the card_payment suggestion source and the card-payment
-- proposal tier in keel_detect_category_suggestions — were DELIBERATELY DROPPED
-- per the founder's 2026-07-19 scope decision. keel_detect_category_suggestions
-- is left exactly as 20260719020000 left it; one-sided unconnected-card payoff
-- debits keep their existing 'loan_payments' categorization untouched. The
-- category_suggestions.source CHECK stays ('pfc','rule') — no new source.)

-- ---------------------------------------------------------------------------
-- 3. keel_txn_is_transfer_category gains 'transfers_out'; cash-flow read models
-- bump formula version. Full recreate of all three (live bodies:
-- 20260719020000) with ONLY 'transfers_out' added to the excluded set and the
-- version strings bumped. The DROP resets owner/grants, so re-assert exactly the
-- 20260719020000 state captured from live pg_proc.
-- ---------------------------------------------------------------------------
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
    (
      select case
               when tc.canonical_transaction_id is not null then curla.pfc_key
               else offcat.pfc_key
             end in ('transfers', 'transfers_in', 'transfers_out')
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
       limit 1
    ), false);
$$;
revoke all on function public.keel_txn_is_transfer_category(uuid, uuid) from public, anon;
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
        and not exists (
          select 1 from public.transfer_links tl
          where tl.household_id = p_household_id
            and tl.status = 'confirmed'
            and (tl.txn_out = b.canonical_transaction_id
                 or tl.txn_in = b.canonical_transaction_id)
        )
        and not public.keel_is_non_income_settlement(b.household_id, b.canonical_transaction_id)
        -- 20260719020000 + 20260720140000: a transaction categorized as a
        -- transfer ('transfers' / 'transfers_in' / 'transfers_out') is money
        -- movement, not income/spend — excluded even with no paired opposite leg
        -- (one-sided Venmo inflow, or an unconnected-card payoff debit).
        and (b.canonical_transaction_id is null
             or not public.keel_txn_is_transfer_category(p_household_id, b.canonical_transaction_id))
      group by p.currency
    ) t;

  return jsonb_build_object(
    'scope', jsonb_build_object('householdId', p_household_id),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'formulaVersion', 'cash-flow-v5-transfer-out-excluded',
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
        and not public.keel_is_non_income_settlement(b.household_id, b.canonical_transaction_id)
        -- 20260719020000 + 20260720140000: exclude user-categorized transfers
        -- ('transfers' / 'transfers_in' / 'transfers_out'). See keel_cash_flow.
        and (b.canonical_transaction_id is null
             or not public.keel_txn_is_transfer_category(p_household_id, b.canonical_transaction_id))
      group by date_trunc('month', b.effective_date), p.currency
    ) t;

  return jsonb_build_object(
    'scope', jsonb_build_object('householdId', p_household_id),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'formulaVersion', 'cash-flow-monthly-v4-transfer-out-excluded',
    'rows', v_rows
  );
end;
$$;

-- Re-apply ownership + grants exactly as 20260719020000 did (DROP reset them):
-- keel_cash_flow owned by keel_api; keel_cash_flow_monthly left owned by the
-- migration runner (postgres).
grant create on schema public to keel_api;
alter function public.keel_cash_flow(uuid, date, date) owner to keel_api;
revoke create on schema public from keel_api;

revoke all on function public.keel_cash_flow(uuid, date, date) from public, anon;
revoke all on function public.keel_cash_flow_monthly(uuid, date, date) from public, anon;
grant execute on function public.keel_cash_flow(uuid, date, date) to authenticated;
grant execute on function public.keel_cash_flow_monthly(uuid, date, date) to authenticated, service_role;
