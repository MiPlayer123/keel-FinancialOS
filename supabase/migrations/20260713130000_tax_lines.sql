-- Tax-line mapping (Quicken-style): a category can carry an IRS line, turning
-- everyday categorization into a year-end tax artifact for free. Deterministic
-- attribute + report grouping only — no advice, no filing (AI ladder class D
-- stays disabled; this is bookkeeping metadata the user sets explicitly).
-- BC-v2.1 §9.1 explicit ownership: mapping is user-set, never inferred.

-- ---------------------------------------------------------------------------
-- 1. Enum + column (enums over strings, Law 4). Nullable: unmapped categories
--    simply don't appear on the tax schedule.
-- ---------------------------------------------------------------------------
create type public.tax_line as enum (
  -- income
  'w2_wages',
  'interest_income',
  'dividend_income',
  'capital_gains',
  'self_employment_income',
  'other_income',
  -- adjustments
  'hsa_contribution',
  'ira_contribution',
  'student_loan_interest',
  -- schedule A itemized
  'charitable_contributions',
  'medical_expenses',
  'mortgage_interest',
  'state_local_income_taxes',
  'property_taxes',
  -- schedule C
  'business_expense',
  -- payments
  'estimated_tax_payments',
  'federal_tax_withheld',
  'state_tax_withheld'
);

alter table public.ledger_accounts
  add column tax_line public.tax_line;

comment on column public.ledger_accounts.tax_line is
  'Optional IRS line for tax-schedule reporting. User-set only; no backfill — '
  'a wrong tax mapping is worse than none (no implicit defaults).';

-- ---------------------------------------------------------------------------
-- 2. Setter: member-gated, category-only, audited. NULL clears the mapping.
-- ---------------------------------------------------------------------------
create function public.keel_set_category_tax_line(
  p_household_id uuid,
  p_ledger_account_id uuid,
  p_tax_line text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_before public.tax_line;
  v_new public.tax_line;
begin
  if v_uid is null then
    raise exception 'KEEL_NOT_AUTHENTICATED' using errcode = 'P0004';
  end if;
  if not exists (
    select 1 from public.household_memberships
    where household_id = p_household_id and user_id = v_uid
  ) then
    raise exception 'KEEL_NOT_FOUND' using errcode = 'P0006';
  end if;

  if p_tax_line is not null then
    if not exists (
      select 1 from unnest(enum_range(null::public.tax_line)) e where e::text = p_tax_line
    ) then
      raise exception 'KEEL_INVALID_TAX_LINE: %', p_tax_line using errcode = 'P0009';
    end if;
    v_new := p_tax_line::public.tax_line;
  end if;

  select tax_line into v_before
    from public.ledger_accounts
    where id = p_ledger_account_id
      and household_id = p_household_id
      and is_category = true
    for update;
  if not found then
    raise exception 'KEEL_NOT_FOUND: category' using errcode = 'P0006';
  end if;

  if v_before is distinct from v_new then
    update public.ledger_accounts
      set tax_line = v_new
      where id = p_ledger_account_id;

    insert into public.audit_log (household_id, actor, action, object_type, object_id, before, after)
    values (p_household_id,
            jsonb_build_object('kind', 'user', 'userId', v_uid),
            'category.set_tax_line',
            'ledger_account', p_ledger_account_id,
            jsonb_build_object('taxLine', v_before),
            jsonb_build_object('taxLine', v_new));
  end if;
end;
$$;

revoke all on function public.keel_set_category_tax_line(uuid, uuid, text) from public, anon;
grant execute on function public.keel_set_category_tax_line(uuid, uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Categories list emits the mapping.
-- ---------------------------------------------------------------------------
create or replace function public.keel_list_categories(p_household_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := coalesce(
    nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
    nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid;
  v_rows jsonb;
begin
  if v_uid is not null and not exists (
    select 1 from public.household_memberships m
     where m.household_id = p_household_id and m.user_id = v_uid
  ) then
    raise exception 'KEEL_SCOPE_VIOLATION' using errcode = 'P0006';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'ledgerAccountId', t.id,
           'name', t.name,
           'kind', t.kind,
           'entityId', t.entity_id,
           'parentLedgerAccountId', t.parent_ledger_account_id,
           'isSystem', t.is_system,
           'pfcKey', t.pfc_key,
           'taxLine', t.tax_line
         ) order by t.kind, t.group_name, t.depth, t.name), '[]'::jsonb)
    into v_rows
    from (
      select la.*, coalesce(parent.name, la.name) as group_name,
             case when la.parent_ledger_account_id is null then 0 else 1 end as depth
        from public.ledger_accounts la
        left join public.ledger_accounts parent on parent.id = la.parent_ledger_account_id
        where la.household_id = p_household_id
          and la.is_category = true
          and la.archived_at is null
    ) t;
  return v_rows;
end;
$$;

-- create-or-replace keeps ACLs, restated defensively (birth default is PUBLIC EXECUTE).
revoke all on function public.keel_list_categories(uuid) from public, anon;
grant execute on function public.keel_list_categories(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Export (Law 6 — every real column is exported): the ledger_accounts DTO
--    is built with explicit columns in the wrapper chain, so tax_line needs a
--    new link: rename the current head, patch {tables,ledger_accounts}.
-- ---------------------------------------------------------------------------
alter function public.keel_export_household(uuid,timestamptz)
  rename to keel_export_household_pre_tax_lines;
revoke all on function public.keel_export_household_pre_tax_lines(uuid,timestamptz)
  from public, anon, authenticated, service_role;

create function public.keel_export_household(
  p_household_id uuid,
  p_as_of timestamptz default null
) returns jsonb
language plpgsql
security definer
stable
set search_path = pg_catalog, public
as $$
declare
  v_base jsonb;
  v_ledger_accounts jsonb;
begin
  v_base := public.keel_export_household_pre_tax_lines(p_household_id, p_as_of);
  select coalesce(jsonb_agg(row.dto order by row.id), '[]'::jsonb)
    into v_ledger_accounts
    from (
      select account.id,
        jsonb_build_object(
          'id', account.id,
          'household_id', account.household_id,
          'entity_id', account.entity_id,
          'name', account.name,
          'kind', account.kind,
          'currency', account.currency::text,
          'is_category', account.is_category,
          'created_at', to_char(account.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
          'archived_at', case when account.archived_at is null then null else to_char(account.archived_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end,
          'pfc_key', account.pfc_key,
          'is_system', account.is_system,
          'parent_ledger_account_id', account.parent_ledger_account_id,
          'tax_line', account.tax_line::text
        ) as dto
      from public.ledger_accounts account
      where account.household_id = p_household_id
    ) row;
  return jsonb_set(v_base, '{tables,ledger_accounts}', v_ledger_accounts);
end;
$$;
revoke all on function public.keel_export_household(uuid,timestamptz)
  from public, anon, authenticated, service_role;
grant create on schema public to keel_export;
alter function public.keel_export_household(uuid,timestamptz) owner to keel_export;
revoke create on schema public from keel_export;
grant execute on function public.keel_export_household(uuid,timestamptz) to service_role;
