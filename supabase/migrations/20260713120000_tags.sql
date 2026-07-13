-- Tags: user labels orthogonal to categories (Monarch parity; the ask that
-- motivates it: "tax-deductible" across many categories). Presentation
-- overlay in the same append-only-safe pattern as transaction_categories —
-- canonical rows and postings stay immutable; tag membership is mutable,
-- audited, and exportable user configuration (Law 6 INCLUDE).

create table if not exists public.tags (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id),
  name         text not null check (char_length(name) between 1 and 40),
  created_at   timestamptz not null default now()
);
-- Case-insensitive uniqueness per household (race-proof; rename relies on it).
create unique index if not exists tags_household_name_ci
  on public.tags (household_id, lower(name));

create table if not exists public.transaction_tags (
  canonical_transaction_id uuid not null references public.canonical_transactions (id),
  tag_id                   uuid not null references public.tags (id) on delete cascade,
  household_id             uuid not null references public.households (id),
  created_at               timestamptz not null default now(),
  primary key (canonical_transaction_id, tag_id)
);
create index if not exists transaction_tags_household on public.transaction_tags (household_id);
create index if not exists transaction_tags_tag on public.transaction_tags (tag_id);

-- Fail-closed ACLs from birth (the five earlier overlay tables shipped with
-- this stack's default anon/authenticated grants — pgTAP 002 finding).
revoke all on public.tags, public.transaction_tags from public, anon, authenticated;
grant select on public.tags, public.transaction_tags to authenticated;

alter table public.tags enable row level security;
alter table public.transaction_tags enable row level security;
drop policy if exists tags_member_read on public.tags;
create policy tags_member_read on public.tags
  for select to authenticated
  using (exists (
    select 1 from public.household_memberships m
    where m.household_id = tags.household_id and m.user_id = auth.uid()
  ));
drop policy if exists transaction_tags_member_read on public.transaction_tags;
create policy transaction_tags_member_read on public.transaction_tags
  for select to authenticated
  using (exists (
    select 1 from public.household_memberships m
    where m.household_id = transaction_tags.household_id and m.user_id = auth.uid()
  ));

-- ---------------------------------------------------------------------------
-- Procs (house style: auth gate → membership gate → validate → mutate →
-- audit; revoke PUBLIC/anon, grant authenticated).
-- ---------------------------------------------------------------------------

-- Create (p_tag_id null) or rename a tag.
create function public.keel_tag_save(
  p_household_id uuid,
  p_tag_id uuid,
  p_name text
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text := btrim(coalesce(p_name, ''));
  v_id uuid;
  v_before text;
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
  if char_length(v_name) < 1 or char_length(v_name) > 40 then
    raise exception 'KEEL_INVALID_COMMAND: tag name must be 1-40 characters' using errcode = 'P0009';
  end if;

  begin
    if p_tag_id is null then
      insert into public.tags (household_id, name)
      values (p_household_id, v_name)
      returning id into v_id;
      insert into public.audit_log (household_id, actor, action, object_type, object_id, after)
      values (p_household_id, jsonb_build_object('kind', 'user', 'userId', auth.uid()),
              'tags.create', 'tag', v_id, jsonb_build_object('name', v_name));
    else
      select name into v_before from public.tags
        where id = p_tag_id and household_id = p_household_id;
      if v_before is null then
        raise exception 'KEEL_NOT_FOUND: tag' using errcode = 'P0006';
      end if;
      update public.tags set name = v_name where id = p_tag_id;
      v_id := p_tag_id;
      insert into public.audit_log (household_id, actor, action, object_type, object_id, before, after)
      values (p_household_id, jsonb_build_object('kind', 'user', 'userId', auth.uid()),
              'tags.rename', 'tag', v_id,
              jsonb_build_object('name', v_before), jsonb_build_object('name', v_name));
    end if;
  exception when unique_violation then
    raise exception 'KEEL_INVALID_COMMAND: a tag with this name exists' using errcode = 'P0009';
  end;
  return v_id;
end;
$$;

revoke all on function public.keel_tag_save(uuid, uuid, text) from public, anon;
grant execute on function public.keel_tag_save(uuid, uuid, text) to authenticated;

-- Delete a tag; assignments cascade (presentation only — nothing economic).
create function public.keel_tag_delete(p_household_id uuid, p_tag_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text;
  v_uses int;
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
  select name into v_name from public.tags
    where id = p_tag_id and household_id = p_household_id;
  if v_name is null then
    raise exception 'KEEL_NOT_FOUND: tag' using errcode = 'P0006';
  end if;
  select count(*)::int into v_uses from public.transaction_tags where tag_id = p_tag_id;
  delete from public.tags where id = p_tag_id;
  insert into public.audit_log (household_id, actor, action, object_type, object_id, before)
  values (p_household_id, jsonb_build_object('kind', 'user', 'userId', auth.uid()),
          'tags.delete', 'tag', p_tag_id,
          jsonb_build_object('name', v_name, 'assignments', v_uses));
end;
$$;

revoke all on function public.keel_tag_delete(uuid, uuid) from public, anon;
grant execute on function public.keel_tag_delete(uuid, uuid) to authenticated;

-- Assign or remove one tag on one transaction. Idempotent in both directions.
create function public.keel_tag_assign(
  p_household_id uuid,
  p_txn_id uuid,
  p_tag_id uuid,
  p_assigned boolean
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_changed integer;
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
  if not exists (
    select 1 from public.tags where id = p_tag_id and household_id = p_household_id
  ) then
    raise exception 'KEEL_NOT_FOUND: tag' using errcode = 'P0006';
  end if;

  if p_assigned then
    insert into public.transaction_tags (canonical_transaction_id, tag_id, household_id)
    values (p_txn_id, p_tag_id, p_household_id)
    on conflict do nothing;
  else
    delete from public.transaction_tags
      where canonical_transaction_id = p_txn_id and tag_id = p_tag_id;
  end if;
  get diagnostics v_changed = row_count;

  -- Idempotent replays change nothing; audit only mutations that happened (Law 2).
  if v_changed > 0 then
    insert into public.audit_log (household_id, actor, action, object_type, object_id, after)
    values (p_household_id, jsonb_build_object('kind', 'user', 'userId', auth.uid()),
            case when p_assigned then 'transaction.tag' else 'transaction.untag' end,
            'canonical_transaction', p_txn_id, jsonb_build_object('tagId', p_tag_id));
  end if;
end;
$$;

revoke all on function public.keel_tag_assign(uuid, uuid, uuid, boolean) from public, anon;
grant execute on function public.keel_tag_assign(uuid, uuid, uuid, boolean) to authenticated;

-- List tags with usage counts (picker + manager).
create function public.keel_list_tags(p_household_id uuid)
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
  if v_uid is null then
    raise exception 'KEEL_NOT_AUTHENTICATED' using errcode = 'P0004';
  end if;
  if not exists (
    select 1 from public.household_memberships m
     where m.household_id = p_household_id and m.user_id = v_uid
  ) then
    raise exception 'KEEL_SCOPE_VIOLATION' using errcode = 'P0006';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'tagId', t.id,
           'name', t.name,
           'usageCount', (select count(*)::int from public.transaction_tags tt where tt.tag_id = t.id)
         ) order by t.name), '[]'::jsonb)
    into v_rows
    from public.tags t
    where t.household_id = p_household_id;
  return v_rows;
end;
$$;

revoke all on function public.keel_list_tags(uuid) from public, anon;
grant execute on function public.keel_list_tags(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Rich list: emit 'tags' per transaction. Full recreate of the split-aware
-- body (20260713100000) with ONE added lateral + key.
-- ---------------------------------------------------------------------------
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
        'description', left(coalesce(tov.display_description, rr.display_name, ct.description), 140),
        'originalDescription', left(ct.description, 140),
        'note', tov.note,
        'status', ct.status,
        'source', ct.source,
        'accountId', acc.id,
        'accountName', acc.name,
        'amountMinor', cashp.amount_minor::text,
        'currency', cashp.currency,
        'categoryLedgerAccountId',
          case when offs.n = 1 then coalesce(catov.id, offs.one_id) end,
        'categoryName',
          case when offs.n = 1 then coalesce(catov.name, offs.one_name) else 'Split' end,
        'categoryKind',
          case when offs.n = 1 then coalesce(catov.kind::text, offs.one_kind) end,
        'categoryPfcKey',
          case when offs.n = 1 then coalesce(catov.pfc_key, offs.one_pfc_key) end,
        'splits', case when offs.n > 1 then offs.splits end,
        'tags', tgs.tags,
        'transferStatus', tl.status
      ) as row
      from public.canonical_transactions ct
      join public.journal_batches jb
        on jb.canonical_transaction_id = ct.id and jb.reverses_batch_id is null
       and not exists (
         select 1 from public.journal_revisions rev where rev.original_batch_id = jb.id
       )
      join public.journal_postings cashp on cashp.batch_id = jb.id
      join public.ledger_accounts cashla
        on cashla.id = cashp.ledger_account_id and cashla.is_category = false
      join public.accounts acc on acc.ledger_account_id = cashla.id
      cross join lateral (
        select count(*)::int as n,
               min(oc.id::text)::uuid as one_id,
               min(oc.name)           as one_name,
               min(oc.kind::text)     as one_kind,
               min(oc.pfc_key)        as one_pfc_key,
               jsonb_agg(jsonb_build_object(
                 'categoryLedgerAccountId', oc.id,
                 'name', oc.name,
                 'kind', oc.kind,
                 'amountMinor', op.amount_minor::text
               ) order by op.amount_minor desc, op.id) as splits
          from public.journal_postings op
          join public.ledger_accounts oc on oc.id = op.ledger_account_id and oc.is_category = true
         where op.batch_id = jb.id
      ) offs
      cross join lateral (
        select coalesce(jsonb_agg(jsonb_build_object('tagId', tg.id, 'name', tg.name)
                 order by tg.name), '[]'::jsonb) as tags
          from public.transaction_tags tt
          join public.tags tg on tg.id = tt.tag_id
         where tt.canonical_transaction_id = ct.id
      ) tgs
      left join public.transaction_categories tc on tc.canonical_transaction_id = ct.id
      left join public.ledger_accounts catov on catov.id = tc.category_ledger_account_id
      left join public.transaction_overrides tov on tov.canonical_transaction_id = ct.id
      left join public.rule_renames rr on rr.canonical_transaction_id = ct.id
      left join public.transfer_links tl
        on (tl.txn_out = ct.id or tl.txn_in = ct.id)
       and tl.status in ('suggested', 'confirmed')
      where ct.household_id = p_household_id
        and ct.voided_at is null
        and offs.n >= 1
    ) t;

  return jsonb_build_object(
    'scope', jsonb_build_object('householdId', p_household_id),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'rows', v_rows
  );
end;
$$;

revoke all on function public.keel_list_transactions_rich(uuid) from public, anon;
grant execute on function public.keel_list_transactions_rich(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Law 6 export: both tables are durable user configuration → INCLUDE.
-- ---------------------------------------------------------------------------
grant select on public.tags, public.transaction_tags to keel_export;
create policy tags_export on public.tags
  for select to keel_export using (true);
create policy transaction_tags_export on public.transaction_tags
  for select to keel_export using (true);

alter function public.keel_export_household(uuid,timestamptz)
  rename to keel_export_household_pre_tags;
revoke all on function public.keel_export_household_pre_tags(uuid,timestamptz)
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
  v_base := public.keel_export_household_pre_tags(p_household_id, p_as_of);
  select jsonb_build_object(
    'tags', coalesce((select jsonb_agg(to_jsonb(x) order by x.id)
      from public.tags x where x.household_id = p_household_id), '[]'::jsonb),
    'transaction_tags', coalesce((select jsonb_agg(to_jsonb(x)
      order by x.canonical_transaction_id, x.tag_id)
      from public.transaction_tags x where x.household_id = p_household_id), '[]'::jsonb)
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
