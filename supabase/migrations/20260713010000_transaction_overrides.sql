-- User-editable transaction display name + note ("everything editable", §5.2).
-- Same append-only-safe pattern as transaction_categories: canonical
-- transactions and journal postings stay immutable (source preservation,
-- keel_forbid_mutation); what the USER wants to call a transaction is a
-- mutable, audited presentation overlay keyed to the canonical transaction.
-- The original provider description is always preserved and always returned.

create table if not exists public.transaction_overrides (
  canonical_transaction_id uuid primary key
    references public.canonical_transactions (id),
  household_id             uuid not null references public.households (id),
  display_description      text,
  note                     text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  check (display_description is null or char_length(display_description) between 1 and 140),
  check (note is null or char_length(note) between 1 and 2000),
  check (display_description is not null or note is not null)
);
create index if not exists transaction_overrides_household
  on public.transaction_overrides (household_id);

alter table public.transaction_overrides enable row level security;
drop policy if exists transaction_overrides_member_read on public.transaction_overrides;
create policy transaction_overrides_member_read on public.transaction_overrides
  for select to authenticated
  using (exists (
    select 1 from public.household_memberships m
    where m.household_id = transaction_overrides.household_id and m.user_id = auth.uid()
  ));
grant select on public.transaction_overrides to authenticated;

-- Set / clear the override. Blank or null for BOTH fields deletes the row
-- (the ledger falls back to the immutable provider description).
create or replace function public.keel_set_transaction_override(
  p_household_id uuid,
  p_txn_id uuid,
  p_display_description text,
  p_note text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_desc text := nullif(btrim(coalesce(p_display_description, '')), '');
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_before jsonb;
begin
  if auth.uid() is null then
    raise exception 'KEEL_NOT_AUTHENTICATED' using errcode = 'P0004';
  end if;
  if not exists (
    select 1 from public.household_memberships
    where household_id = p_household_id and user_id = auth.uid()
  ) then
    raise exception 'KEEL_NOT_FOUND' using errcode = 'P0006';
  end if;
  if not exists (
    select 1 from public.canonical_transactions
    where id = p_txn_id and household_id = p_household_id
  ) then
    raise exception 'KEEL_NOT_FOUND: transaction' using errcode = 'P0006';
  end if;
  if v_desc is not null and char_length(v_desc) > 140 then
    raise exception 'KEEL_INVALID_COMMAND: display description too long' using errcode = 'P0009';
  end if;
  if v_note is not null and char_length(v_note) > 2000 then
    raise exception 'KEEL_INVALID_COMMAND: note too long' using errcode = 'P0009';
  end if;

  select jsonb_build_object('displayDescription', display_description, 'note', note)
    into v_before
    from public.transaction_overrides
    where canonical_transaction_id = p_txn_id;

  if v_desc is null and v_note is null then
    delete from public.transaction_overrides where canonical_transaction_id = p_txn_id;
  else
    insert into public.transaction_overrides
      (canonical_transaction_id, household_id, display_description, note)
    values (p_txn_id, p_household_id, v_desc, v_note)
    on conflict (canonical_transaction_id) do update
      set display_description = excluded.display_description,
          note = excluded.note,
          updated_at = now();
  end if;

  insert into public.audit_log (household_id, actor, action, object_type, object_id, before, after)
  values (p_household_id, jsonb_build_object('kind', 'user', 'userId', auth.uid()),
          'transaction.override', 'canonical_transaction', p_txn_id,
          coalesce(v_before, 'null'::jsonb),
          jsonb_build_object('displayDescription', v_desc, 'note', v_note));
end;
$$;

grant execute on function public.keel_set_transaction_override(uuid, uuid, text, text)
  to authenticated, service_role;

-- Rich ledger read model now returns the override alongside the immutable
-- original: displayDescription/note when set, originalDescription always.
create or replace function public.keel_list_transactions_rich(p_household_id uuid)
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

  select coalesce(jsonb_agg(row order by row->>'effectiveDate' desc, row->>'transactionId'), '[]'::jsonb)
    into v_rows
    from (
      select jsonb_build_object(
        'transactionId', ct.id,
        'effectiveDate', ct.effective_date,
        'description', left(coalesce(tov.display_description, ct.description), 140),
        'originalDescription', left(ct.description, 140),
        'note', tov.note,
        'status', ct.status,
        'accountId', acc.id,
        'accountName', acc.name,
        'amountMinor', cashp.amount_minor::text,
        'currency', cashp.currency,
        'categoryLedgerAccountId', coalesce(catov.id, offcat.id),
        'categoryName', coalesce(catov.name, offcat.name),
        'categoryKind', coalesce(catov.kind, offcat.kind)
      ) as row
      from public.canonical_transactions ct
      join public.journal_batches jb
        on jb.canonical_transaction_id = ct.id and jb.reverses_batch_id is null
      join public.journal_postings cashp on cashp.batch_id = jb.id
      join public.ledger_accounts cashla
        on cashla.id = cashp.ledger_account_id and cashla.is_category = false
      join public.accounts acc on acc.ledger_account_id = cashla.id
      join public.journal_postings offp on offp.batch_id = jb.id and offp.id <> cashp.id
      join public.ledger_accounts offcat
        on offcat.id = offp.ledger_account_id and offcat.is_category = true
      left join public.transaction_categories tc on tc.canonical_transaction_id = ct.id
      left join public.ledger_accounts catov on catov.id = tc.category_ledger_account_id
      left join public.transaction_overrides tov on tov.canonical_transaction_id = ct.id
      where ct.household_id = p_household_id
    ) t;

  return jsonb_build_object(
    'scope', jsonb_build_object('householdId', p_household_id),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'rows', v_rows
  );
end;
$$;

grant execute on function public.keel_list_transactions_rich(uuid) to authenticated, service_role;

-- Law 6 export ruling: transaction_categories (created 20260712200100 but never
-- ruled into the export contract — completeness gap fixed here) and
-- transaction_overrides are durable user classification/presentation data →
-- INCLUDE. Same wrapper chain as recurring/paychecks/reimbursements/reconciliation.
grant select on public.transaction_categories, public.transaction_overrides to keel_export;
create policy transaction_categories_export on public.transaction_categories
  for select to keel_export using (true);
create policy transaction_overrides_export on public.transaction_overrides
  for select to keel_export using (true);

alter function public.keel_export_household(uuid,timestamptz)
  rename to keel_export_household_pre_overlays;
revoke all on function public.keel_export_household_pre_overlays(uuid,timestamptz)
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
  v_tables jsonb;
begin
  v_base := public.keel_export_household_pre_overlays(p_household_id, p_as_of);
  select jsonb_build_object(
    'transaction_categories', coalesce((select jsonb_agg(to_jsonb(x) order by x.canonical_transaction_id)
      from public.transaction_categories x where x.household_id = p_household_id), '[]'::jsonb),
    'transaction_overrides', coalesce((select jsonb_agg(to_jsonb(x) order by x.canonical_transaction_id)
      from public.transaction_overrides x where x.household_id = p_household_id), '[]'::jsonb)
  ) into v_tables;
  return jsonb_set(v_base, '{tables}', (v_base->'tables') || v_tables);
end;
$$;
revoke all on function public.keel_export_household(uuid,timestamptz)
  from public, anon, authenticated, service_role;
grant create on schema public to keel_export;
alter function public.keel_export_household(uuid,timestamptz) owner to keel_export;
revoke create on schema public from keel_export;
grant execute on function public.keel_export_household(uuid,timestamptz) to service_role;
