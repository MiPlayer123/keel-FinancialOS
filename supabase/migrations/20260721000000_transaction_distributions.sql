-- Q5: account-target split legs compiled to KEEL's existing two-linked-
-- canonical-transactions transfer model. canonical_transactions remains
-- single-account and transfer_links remains transaction-level. A mixed source
-- is modeled as: provider source rebooked to category-only gross/net-of-tax,
-- plus one generated source-account transaction per account leg; the latter is
-- linked to a real connected counterparty or a booked unconnected counterparty.
-- Confirmed transfer links keep the generated movement out of cash flow with no
-- report formula changes.

-- ==========================================================================
-- 1. Durable distribution formula + compiled-leg provenance.
-- ==========================================================================
create table if not exists public.transaction_distributions (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id),
  source_canonical_transaction_id uuid not null,
  formula_version text not null check (length(formula_version) between 1 and 100),
  status text not null check (status in ('pending', 'active', 'reversed')),
  created_at timestamptz not null default now(),
  reversed_at timestamptz,
  reversal_reason text check (reversal_reason is null or length(reversal_reason) between 1 and 500),
  unique (household_id, id),
  constraint transaction_distributions_source_tenant_fk
    foreign key (household_id, source_canonical_transaction_id)
    references public.canonical_transactions (household_id, id) on delete restrict,
  constraint transaction_distributions_reversal_shape check (
    (status = 'reversed' and reversed_at is not null and reversal_reason is not null)
    or (status in ('pending', 'active'))
  )
);

create table if not exists public.transaction_distribution_legs (
  id uuid primary key default gen_random_uuid(),
  distribution_id uuid not null references public.transaction_distributions (id) on delete restrict,
  leg_type text not null check (leg_type in ('category', 'account')),
  category_ledger_account_id uuid references public.ledger_accounts (id) on delete restrict,
  account_id uuid references public.accounts (id) on delete restrict,
  signed_amount_minor bigint not null check (signed_amount_minor <> 0),
  currency char(3) not null check (currency = upper(currency)),
  generated_transaction_id uuid references public.canonical_transactions (id) on delete restrict,
  transfer_link_id uuid references public.transfer_links (id) on delete restrict,
  status text not null check (status in ('pending', 'active', 'reversed')),
  constraint transaction_distribution_legs_exactly_one_target check (
    (category_ledger_account_id is not null)::integer
      + (account_id is not null)::integer = 1
  ),
  constraint transaction_distribution_legs_type_target check (
    (leg_type = 'category' and category_ledger_account_id is not null and account_id is null)
    or (leg_type = 'account' and account_id is not null and category_ledger_account_id is null)
  )
);

create unique index if not exists transaction_distributions_one_active_source
  on public.transaction_distributions (source_canonical_transaction_id)
  where status = 'active';
create index if not exists transaction_distributions_household_source_idx
  on public.transaction_distributions (household_id, source_canonical_transaction_id, created_at desc);
create index if not exists transaction_distribution_legs_distribution_idx
  on public.transaction_distribution_legs (distribution_id, leg_type, id);
create unique index if not exists transaction_distribution_legs_category_once
  on public.transaction_distribution_legs (distribution_id, category_ledger_account_id)
  where category_ledger_account_id is not null;
create unique index if not exists transaction_distribution_legs_account_once
  on public.transaction_distribution_legs (distribution_id, account_id)
  where account_id is not null;
create unique index if not exists transaction_distribution_legs_transfer_once
  on public.transaction_distribution_legs (transfer_link_id)
  where transfer_link_id is not null;

comment on table public.transaction_distributions is
  'A versioned account/category split formula whose account legs compile to ordinary confirmed transfer_links.';
comment on column public.transaction_distribution_legs.signed_amount_minor is
  'Debit-positive amount on the TARGET category/account. A generated source-account transfer leg uses its exact negation.';

alter table public.transaction_distributions enable row level security;
alter table public.transaction_distribution_legs enable row level security;

revoke all on public.transaction_distributions, public.transaction_distribution_legs
  from public, anon, authenticated;
grant select on public.transaction_distributions, public.transaction_distribution_legs
  to authenticated, service_role;
grant select, insert, update on public.transaction_distributions, public.transaction_distribution_legs
  to keel_api, keel_worker;

drop policy if exists transaction_distributions_member_read on public.transaction_distributions;
create policy transaction_distributions_member_read on public.transaction_distributions
  for select to authenticated using (public.keel_is_household_member(household_id));
drop policy if exists transaction_distribution_legs_member_read on public.transaction_distribution_legs;
create policy transaction_distribution_legs_member_read on public.transaction_distribution_legs
  for select to authenticated using (exists (
    select 1 from public.transaction_distributions d
     where d.id = distribution_id and public.keel_is_household_member(d.household_id)
  ));
drop policy if exists transaction_distributions_definer_all on public.transaction_distributions;
create policy transaction_distributions_definer_all on public.transaction_distributions
  for all to keel_api, keel_worker using (true) with check (true);
drop policy if exists transaction_distribution_legs_definer_all on public.transaction_distribution_legs;
create policy transaction_distribution_legs_definer_all on public.transaction_distribution_legs
  for all to keel_api, keel_worker using (true) with check (true);

-- Internal JSON compiler shared by manual_create, set_splits and paycheck
-- integration. It validates the wire-money representation and target shape;
-- keel_materialize_distribution owns household/entity/currency/postability
-- validation against live rows.
create or replace function public.keel_distribution_create_from_splits(
  p_household_id uuid,
  p_source_transaction_id uuid,
  p_splits jsonb,
  p_source_amount_minor bigint,
  p_currency text
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_distribution_id uuid;
  v_leg jsonb;
  v_leg_type text;
  v_amount bigint;
  v_sum numeric := 0;
  v_count integer;
  v_account_count integer := 0;
  v_seen_categories uuid[] := '{}';
  v_seen_accounts uuid[] := '{}';
  v_target uuid;
begin
  if jsonb_typeof(p_splits) <> 'array' then
    raise exception 'KEEL_INVALID_COMMAND: splits must be an array' using errcode = 'P0009';
  end if;
  v_count := jsonb_array_length(p_splits);
  if v_count < 1 or v_count > 30 then
    raise exception 'KEEL_INVALID_COMMAND: 1-30 splits per transaction' using errcode = 'P0009';
  end if;
  if p_currency !~ '^[A-Z]{3}$' then
    raise exception 'KEEL_CURRENCY_MISMATCH: invalid distribution currency' using errcode = 'P0010';
  end if;

  insert into public.transaction_distributions
    (household_id, source_canonical_transaction_id, formula_version, status)
  values (p_household_id, p_source_transaction_id, 'transaction-distribution-v1', 'pending')
  returning id into v_distribution_id;

  for v_leg in select value from jsonb_array_elements(p_splits) loop
    if jsonb_typeof(v_leg) <> 'object' then
      raise exception 'KEEL_INVALID_COMMAND: each split must be an object' using errcode = 'P0009';
    end if;
    v_leg_type := coalesce(nullif(v_leg->>'leg_type', ''), 'category');
    if v_leg_type not in ('category', 'account') then
      raise exception 'KEEL_INVALID_COMMAND: leg_type must be category or account' using errcode = 'P0009';
    end if;
    if jsonb_typeof(v_leg->'amount_minor') <> 'string'
       or (v_leg->>'amount_minor') !~ '^-?[0-9]+$' then
      raise exception 'KEEL_INVALID_MONEY: split amount_minor must be an integer string' using errcode = 'P0008';
    end if;
    begin
      v_amount := (v_leg->>'amount_minor')::bigint;
    exception when numeric_value_out_of_range then
      raise exception 'KEEL_INVALID_MONEY: split amount outside bigint' using errcode = 'P0008';
    end;
    if v_amount = 0 then
      raise exception 'KEEL_INVALID_MONEY: split amount cannot be zero' using errcode = 'P0008';
    end if;

    if v_leg_type = 'category' then
      if coalesce(v_leg->>'category_ledger_account_id', '')
           !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
         or nullif(v_leg->>'account_id', '') is not null then
        raise exception 'KEEL_INVALID_COMMAND: category leg requires exactly category_ledger_account_id'
          using errcode = 'P0009';
      end if;
      v_target := (v_leg->>'category_ledger_account_id')::uuid;
      if v_target = any (v_seen_categories) then
        raise exception 'KEEL_INVALID_COMMAND: duplicate split category — merge the amounts'
          using errcode = 'P0009';
      end if;
      v_seen_categories := v_seen_categories || v_target;
      insert into public.transaction_distribution_legs
        (distribution_id, leg_type, category_ledger_account_id, signed_amount_minor, currency, status)
      values (v_distribution_id, 'category', v_target, v_amount, p_currency, 'pending');
    else
      if coalesce(v_leg->>'account_id', '')
           !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
         or nullif(v_leg->>'category_ledger_account_id', '') is not null then
        raise exception 'KEEL_INVALID_COMMAND: account leg requires exactly account_id'
          using errcode = 'P0009';
      end if;
      v_target := (v_leg->>'account_id')::uuid;
      if v_target = any (v_seen_accounts) then
        raise exception 'KEEL_INVALID_COMMAND: duplicate split account — merge the amounts'
          using errcode = 'P0009';
      end if;
      v_seen_accounts := v_seen_accounts || v_target;
      v_account_count := v_account_count + 1;
      insert into public.transaction_distribution_legs
        (distribution_id, leg_type, account_id, signed_amount_minor, currency, status)
      values (v_distribution_id, 'account', v_target, v_amount, p_currency, 'pending');
    end if;
    v_sum := v_sum + v_amount;
  end loop;

  if v_account_count = 0 then
    raise exception 'KEEL_INVALID_COMMAND: distribution requires at least one account leg'
      using errcode = 'P0009';
  end if;
  if v_sum <> -p_source_amount_minor::numeric then
    raise exception 'KEEL_UNBALANCED: splits sum to % but must equal % (delta %)',
      v_sum, -p_source_amount_minor, v_sum + p_source_amount_minor using errcode = 'P0002';
  end if;
  return v_distribution_id;
end;
$$;

-- ==========================================================================
-- 2. Distribution reversal. Generated source/booked counterparty transactions
-- are voided by compensating batches; connected provider counterparties are
-- never voided. The modeled source batch is replaced with an exact copy of the
-- raw pre-materialization batch recorded in journal_revisions.
-- ==========================================================================
create or replace function public.keel_reverse_distribution(
  p_distribution_id uuid,
  p_actor_id uuid,
  p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_dist public.transaction_distributions%rowtype;
  v_leg public.transaction_distribution_legs%rowtype;
  v_link public.transfer_links%rowtype;
  v_batch public.journal_batches%rowtype;
  v_source_batch public.journal_batches%rowtype;
  v_source_original uuid;
  v_reversal uuid;
  v_replacement uuid;
  v_command_id uuid := gen_random_uuid();
  v_actor jsonb;
begin
  if p_reason is null or length(btrim(p_reason)) not between 1 and 500 then
    raise exception 'KEEL_INVALID_COMMAND: reversal reason must be 1-500 characters'
      using errcode = 'P0009';
  end if;
  select * into v_dist from public.transaction_distributions
   where id = p_distribution_id for update;
  if not found then
    raise exception 'KEEL_NOT_FOUND: transaction distribution' using errcode = 'P0006';
  end if;
  if p_actor_id is null or not exists (
    select 1 from public.household_memberships m
     where m.household_id = v_dist.household_id and m.user_id = p_actor_id
       and m.role in ('owner', 'partner')
  ) then
    raise exception 'KEEL_SCOPE_VIOLATION: distribution actor cannot write household'
      using errcode = 'P0006';
  end if;
  if v_dist.status = 'reversed' then
    return jsonb_build_object('distributionId', v_dist.id, 'status', 'reversed',
                              'idempotentReplay', true);
  end if;
  v_actor := jsonb_build_object('kind', 'user', 'userId', p_actor_id::text);

  for v_leg in
    select * from public.transaction_distribution_legs
     where distribution_id = v_dist.id and leg_type = 'account'
     order by id for update
  loop
    if v_leg.transfer_link_id is not null then
      select * into v_link from public.transfer_links
       where id = v_leg.transfer_link_id and household_id = v_dist.household_id for update;
      if found and v_link.status <> 'rejected' then
        perform public.keel_transfer_restore_legs(
          v_dist.household_id, v_link.txn_out, v_link.txn_in, v_actor);

        -- Only the BOOK path sets booked_txn. A connected provider transaction
        -- is real evidence and is deliberately left untouched.
        if v_link.booked_txn is not null then
          select jb.* into v_batch
            from public.journal_batches jb
            join public.canonical_transactions ct on ct.id = jb.canonical_transaction_id
           where jb.canonical_transaction_id = v_link.booked_txn
             and jb.reverses_batch_id is null
             and not exists (select 1 from public.journal_revisions r where r.original_batch_id = jb.id)
             and ct.voided_at is null
           order by jb.posted_at desc, jb.id desc limit 1;
          if v_batch.id is not null then
            insert into public.journal_batches
              (household_id, canonical_transaction_id, description, effective_date,
               reverses_batch_id, command_id)
            values (v_dist.household_id, v_link.booked_txn,
                    left('VOID: distribution reversed — ' || btrim(p_reason), 500),
                    v_batch.effective_date, v_batch.id, v_command_id)
            returning id into v_reversal;
            insert into public.journal_postings
              (batch_id, ledger_account_id, entity_id, amount_minor, currency)
            select v_reversal, p.ledger_account_id, p.entity_id, -p.amount_minor, p.currency
              from public.journal_postings p where p.batch_id = v_batch.id;
            insert into public.journal_revisions (original_batch_id, reversal_batch_id, reason)
            values (v_batch.id, v_reversal, left('distribution reversed: ' || p_reason, 500));
            update public.canonical_transactions set status = 'voided', voided_at = now()
             where id = v_link.booked_txn;
          end if;
        end if;

        update public.transfer_links
           set status = 'rejected', decided_by = p_actor_id, decided_at = now()
         where id = v_link.id;
      end if;
    end if;

    -- Mixed distributions synthesize a source-account transaction. A pure
    -- one-account-leg transfer reuses the provider/manual source itself and
    -- must never void that evidence row.
    if v_leg.generated_transaction_id is not null
       and v_leg.generated_transaction_id <> v_dist.source_canonical_transaction_id then
      v_batch := null;
      select jb.* into v_batch
        from public.journal_batches jb
        join public.canonical_transactions ct on ct.id = jb.canonical_transaction_id
       where jb.canonical_transaction_id = v_leg.generated_transaction_id
         and jb.reverses_batch_id is null
         and not exists (select 1 from public.journal_revisions r where r.original_batch_id = jb.id)
         and ct.voided_at is null
       order by jb.posted_at desc, jb.id desc limit 1;
      if v_batch.id is not null then
        insert into public.journal_batches
          (household_id, canonical_transaction_id, description, effective_date,
           reverses_batch_id, command_id)
        values (v_dist.household_id, v_leg.generated_transaction_id,
                left('VOID: distribution source leg — ' || btrim(p_reason), 500),
                v_batch.effective_date, v_batch.id, v_command_id)
        returning id into v_reversal;
        insert into public.journal_postings
          (batch_id, ledger_account_id, entity_id, amount_minor, currency)
        select v_reversal, p.ledger_account_id, p.entity_id, -p.amount_minor, p.currency
          from public.journal_postings p where p.batch_id = v_batch.id;
        insert into public.journal_revisions (original_batch_id, reversal_batch_id, reason)
        values (v_batch.id, v_reversal, left('distribution source leg reversed: ' || p_reason, 500));
        update public.canonical_transactions set status = 'voided', voided_at = now()
         where id = v_leg.generated_transaction_id;
      end if;
    end if;
  end loop;

  -- Restore the provider/manual source to the exact pre-materialization batch.
  select jb.* into v_source_batch from public.journal_batches jb
   where jb.canonical_transaction_id = v_dist.source_canonical_transaction_id
     and jb.reverses_batch_id is null
     and not exists (select 1 from public.journal_revisions r where r.original_batch_id = jb.id)
   order by jb.posted_at desc, jb.id desc limit 1;
  if v_source_batch.id is not null then
    select r.original_batch_id into v_source_original
      from public.journal_revisions r
     where r.replacement_batch_id = v_source_batch.id
       and r.reason = 'distribution:' || v_dist.id::text || ':materialize'
     order by r.created_at desc, r.id desc limit 1;
  end if;
  if v_source_original is not null then
    insert into public.journal_batches
      (household_id, canonical_transaction_id, description, effective_date,
       reverses_batch_id, command_id)
    values (v_dist.household_id, v_dist.source_canonical_transaction_id,
            left('REVERSE DISTRIBUTION: ' || btrim(p_reason), 500),
            v_source_batch.effective_date, v_source_batch.id, v_command_id)
    returning id into v_reversal;
    insert into public.journal_postings
      (batch_id, ledger_account_id, entity_id, amount_minor, currency)
    select v_reversal, p.ledger_account_id, p.entity_id, -p.amount_minor, p.currency
      from public.journal_postings p where p.batch_id = v_source_batch.id;
    insert into public.journal_batches
      (household_id, canonical_transaction_id, description, effective_date, command_id)
    select v_dist.household_id, v_dist.source_canonical_transaction_id,
           left('RESTORED RAW: ' || b.description, 500), b.effective_date, v_command_id
      from public.journal_batches b where b.id = v_source_original
    returning id into v_replacement;
    insert into public.journal_postings
      (batch_id, ledger_account_id, entity_id, amount_minor, currency)
    select v_replacement, p.ledger_account_id, p.entity_id, p.amount_minor, p.currency
      from public.journal_postings p where p.batch_id = v_source_original;
    insert into public.journal_revisions
      (original_batch_id, reversal_batch_id, replacement_batch_id, reason)
    values (v_source_batch.id, v_reversal, v_replacement,
            left('distribution:' || v_dist.id::text || ':reverse:' || p_reason, 500));
  end if;

  update public.transaction_distribution_legs set status = 'reversed'
   where distribution_id = v_dist.id;
  update public.transaction_distributions
     set status = 'reversed', reversed_at = now(), reversal_reason = btrim(p_reason)
   where id = v_dist.id;
  insert into public.audit_log (household_id, actor, action, object_type, object_id, before, after)
  values (v_dist.household_id, v_actor, 'transaction_distribution.reverse',
          'transaction_distribution', v_dist.id,
          jsonb_build_object('status', v_dist.status),
          jsonb_build_object('status', 'reversed', 'reason', btrim(p_reason)));
  return jsonb_build_object('distributionId', v_dist.id, 'status', 'reversed',
                            'idempotentReplay', false);
end;
$$;
