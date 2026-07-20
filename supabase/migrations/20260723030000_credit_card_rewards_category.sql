-- ---------------------------------------------------------------------------
-- Credit card rewards income category (F: card-rewards-breakeven)
--
-- The founder tracks whether a card "pays for itself": an annual fee (a "Bank
-- Charges" expense) vs the rewards / statement credits / cashback it earns.
-- Today those rewards land in "Uncategorized Income" / "Other Income". KEEL's
-- ledger expresses a reward as INCOME (money received on a liability account —
-- a credit, negative posting), NOT as a positive number forced into the expense
-- fee category (keel_categorize_transaction rejects a cross-kind move, and it
-- must — an expense debit and an income credit have opposite signs in the Σ=0
-- postings invariant and in the cash-flow graph). So the correct home for a
-- reward is a dedicated INCOME category; the reports break-even view then PAIRS
-- rewards (income) against fees (the Fees expense family) per card.
--
-- This migration:
--   1. Adds a seeded top-level income category "Credit card rewards"
--      (pfc_key 'income_card_rewards') to keel_seed_entity_categories, so new
--      entities get it automatically.
--   2. Backfills it for every EXISTING entity, idempotently — dedupe by pfc_key
--      AND skip a live case-insensitive name collision (a user may already own a
--      "Credit card rewards"), exactly the seed's own contract.
--
-- No schema change, no owner change (the function is security-definer, granted
-- to service_role only — the create-or-replace preserves that ACL and we
-- re-assert it below). Data-only + one function body refresh.
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
    ('Transfers Out',          'expense', true,  'transfers_out'),
    -- NEW (F: card-rewards-breakeven): income-kind home for cashback /
    -- statement credits / redemptions, so a reward offsets a card's annual fee
    -- in the break-even view instead of hiding in "Other Income".
    ('Credit card rewards',    'income',  true,  'income_card_rewards')
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

  -- Default subcategories (F-016a). Byte-identical to 20260720140000.
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
-- Backfill the new income category for every EXISTING entity. Idempotent: the
-- pfc_key dedupe and the live case-insensitive name-collision guard mirror the
-- seed function exactly, so re-running (or an entity that already owns a
-- "Credit card rewards") is a no-op.
-- ---------------------------------------------------------------------------
insert into public.ledger_accounts
  (household_id, entity_id, name, kind, currency, is_category, pfc_key, is_system)
select e.household_id, e.id, 'Credit card rewards', 'income'::public.ledger_account_kind,
       'USD', true, 'income_card_rewards', true
from public.entities e
where not exists (
  select 1 from public.ledger_accounts la
  where la.entity_id = e.id and la.pfc_key = 'income_card_rewards'
)
and not exists (
  select 1 from public.ledger_accounts la
  where la.entity_id = e.id and la.is_category = true
    and la.archived_at is null and lower(la.name) = lower('Credit card rewards')
);
