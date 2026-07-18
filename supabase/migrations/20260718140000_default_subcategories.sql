-- WS-G / FEEDBACK.md F-016a: seed default subcategories under the existing
-- system taxonomy (20260712200000 seeded 18 top-level categories per entity;
-- 20260713090000 gave them stable pfc_keys + the one-level tree).
--
-- Mechanism (studied, not assumed): categories enter a household PER ENTITY —
-- keel_seed_entity_categories(entity_id, household_id) runs from the
-- entities-insert trigger (keel_seed_entity_default_categories) for every new
-- entity, and the original migrations backfilled existing entities with an
-- explicit loop. This migration therefore does BOTH:
--   1. extends keel_seed_entity_categories so every future entity gets the
--      subcategories, and
--   2. re-runs the seed for every existing non-fixture entity (the seed is
--      idempotent, so the re-run only adds what's missing).
--
-- Idempotency contract (matches the parent seed exactly):
--   · dedupe by pfc_key with NO archived_at filter — an archived seeded
--     subcategory must NOT be resurrected behind the user's back, and a
--     renamed one must not be re-inserted under its canonical name;
--   · additionally skip on a live case-insensitive NAME collision — a user
--     may already have created e.g. "Groceries" as their own category, and
--     ledger_accounts_category_name_ci (20260713070000) would reject the
--     insert; skipping (rather than erroring) keeps the seed re-run safe;
--   · the parent is located by ITS pfc_key and must be live, top-level, and
--     the same kind — otherwise the one-level trigger
--     (ledger_accounts_category_parent) would raise. A missing/archived
--     parent simply skips that parent's subs.
--
-- Law 4: every inserted column is supplied explicitly. All names are generic
-- taxonomy terms (fictional-safe). No new tables/columns — export DTO and
-- pgTAP allowlists are unaffected.

-- ---------------------------------------------------------------------------
-- 1. Seed proc: parents (unchanged from 20260713090000) + default subs.
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
    ('Other Income',           'income',  true,  'other_income')
  ) as d(name, kind, is_category, pfc_key)
  where not exists (
    select 1 from public.ledger_accounts la
    where la.entity_id = p_entity_id and la.pfc_key = d.pfc_key
  );

  -- Default subcategories (F-016a). Inserted AFTER the parents so a fresh
  -- entity resolves every parent within this same call. Landing pads
  -- (uncategorized_*), Transfers, Other, and Other Income deliberately get
  -- none — they are catch-alls, not taxonomies.
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
-- 2. Backfill existing entities (same loop + fixture exclusions as the
-- 20260712200000 backfill — fixture entities keep their deterministic
-- category sets for the pgTAP/integration suites).
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
