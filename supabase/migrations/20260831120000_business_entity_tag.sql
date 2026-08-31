-- Business expense attribution, layer 1: entity-bound tags.
-- docs/BUSINESS-EXPENSE-RESEARCH.md §4. Build plan T2.3; closes the
-- PERSONA-FEEDBACK.md §1 gap "an LLC owner can't mark a personal-card
-- purchase as the business's".
--
-- The problem: entity attribution is structural and derives from the ACCOUNT
-- (ledger_accounts.entity_id -> journal_postings.entity_id). A business cost
-- paid with a personal card is therefore personal, permanently, with no way
-- to say otherwise.
--
-- The mechanism, taken from Quicken Business & Personal: a business "owns" a
-- tag, and putting that tag on a transaction attributes the transaction to
-- that business regardless of which account paid. Built here out of two
-- primitives KEEL already has (entities, and the tags overlay from
-- 20260713120000) rather than a new one.
--
-- What this is NOT: it does not move money, write postings, or change any
-- total that claims to include the money. It is a presentation/scope overlay
-- in the same append-safe shape as transaction_categories and
-- transaction_tags. Whether the business OWES the payer for the expense (an
-- owner contribution / due-to-owner) is a separate economic fact, deliberately
-- left to layer 2 (research doc §5); this migration is classification only.
--
-- Invariants honoured:
--   - Explicit ownership (BC-v2.1 §9.1): the binding and every assignment are
--     user-set. Nothing here infers a business expense.
--   - Reversible correction: clearing is a first-class command, and the
--     binding is metadata on a mutable overlay, never on a posting.
--   - Law 2: every mutation writes audit_log, and only when something changed.
--   - Law 6: tags/transaction_tags are already exported with `to_jsonb(x)`,
--     so entity_id flows into the export with no export change needed.

-- ---------------------------------------------------------------------------
-- 1. The binding. On tags rather than on entities, because "is this a business
--    tag, and whose?" is the question both the ambiguity guard and the delete
--    guard below have to answer from a tag id.
--
--    Nullable: an ordinary tag is unbound. Partial-unique: at most one tag per
--    entity, so "the business tag" is always singular and a transaction's
--    business is never ambiguous through the binding itself.
--
--    Cross-table household consistency (tag.household_id = entity.household_id)
--    is enforced in keel_entity_business_tag_ensure below rather than by a
--    constraint: `tags` grants authenticated SELECT only, so the definer procs
--    are the only writers and there is no path that bypasses the check.
-- ---------------------------------------------------------------------------
alter table public.tags
  add column if not exists entity_id uuid references public.entities (id);

comment on column public.tags.entity_id is
  'When set, this tag is that entity''s business tag: a transaction carrying '
  'it belongs to that entity''s books regardless of which account paid for it '
  '(Quicken business-tag semantics). User-set only, never inferred.';

create unique index if not exists tags_business_entity_unique
  on public.tags (entity_id) where entity_id is not null;

-- ---------------------------------------------------------------------------
-- 2. Bind (idempotently) a business tag to an entity, creating it on first use.
--
--    Adoption: if a tag already exists with the entity's name and is unbound,
--    it is adopted rather than duplicated — the common case being a user who
--    already hand-rolled a tag for the business, which is exactly the Monarch
--    workaround this feature replaces. A name already bound to a DIFFERENT
--    entity is refused rather than silently renamed.
-- ---------------------------------------------------------------------------
create or replace function public.keel_entity_business_tag_ensure(
  p_household_id uuid,
  p_entity_id uuid
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := coalesce(
    nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
    nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid;
  v_entity_name text;
  v_entity_kind public.entity_kind;
  v_tag_name text;
  v_tag_id uuid;
  v_existing_entity uuid;
begin
  perform public.keel_assert_member_write(p_household_id);

  select e.name, e.kind into v_entity_name, v_entity_kind
    from public.entities e
   where e.id = p_entity_id
     and e.household_id = p_household_id
     and e.archived_at is null;
  if v_entity_name is null then
    raise exception 'KEEL_NOT_FOUND: entity' using errcode = 'P0006';
  end if;

  -- 'personal' is the household's own books, which is what an untagged
  -- transaction already means. Allowing it would create a second, redundant
  -- way to say "not business" and a tag that means nothing.
  if v_entity_kind = 'personal' then
    raise exception
      'KEEL_INVALID_COMMAND: a personal entity has no business tag'
      using errcode = 'P0009';
  end if;

  select t.id into v_tag_id
    from public.tags t
   where t.household_id = p_household_id and t.entity_id = p_entity_id;
  if v_tag_id is not null then
    return v_tag_id;
  end if;

  -- tags.name is capped at 40 chars; entities.name at 200.
  v_tag_name := left(btrim(v_entity_name), 40);

  select t.id, t.entity_id into v_tag_id, v_existing_entity
    from public.tags t
   where t.household_id = p_household_id and lower(t.name) = lower(v_tag_name);

  if v_tag_id is not null then
    if v_existing_entity is not null then
      raise exception
        'KEEL_INVALID_COMMAND: the tag "%" is already another business''s tag; rename the entity or that tag',
        v_tag_name using errcode = 'P0009';
    end if;
    update public.tags set entity_id = p_entity_id where id = v_tag_id;
  else
    begin
      insert into public.tags (household_id, name, entity_id)
      values (p_household_id, v_tag_name, p_entity_id)
      returning id into v_tag_id;
    exception when unique_violation then
      -- Concurrent creator won the name race; adopt theirs if it is unbound.
      select t.id, t.entity_id into v_tag_id, v_existing_entity
        from public.tags t
       where t.household_id = p_household_id and lower(t.name) = lower(v_tag_name);
      if v_tag_id is null or v_existing_entity is not null then
        raise exception
          'KEEL_INVALID_COMMAND: could not bind a business tag named "%"', v_tag_name
          using errcode = 'P0009';
      end if;
      update public.tags set entity_id = p_entity_id where id = v_tag_id;
    end;
  end if;

  insert into public.audit_log (household_id, actor, action, object_type, object_id, after)
  values (p_household_id, jsonb_build_object('kind', 'user', 'userId', v_uid),
          'tags.bind_entity', 'tag', v_tag_id,
          jsonb_build_object('entityId', p_entity_id, 'name', v_tag_name));

  return v_tag_id;
end;
$$;

revoke all on function public.keel_entity_business_tag_ensure(uuid, uuid) from public, anon;
grant execute on function public.keel_entity_business_tag_ensure(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. The command behind the checkbox: attribute one transaction to one
--    business, or clear it. p_entity_id null clears.
--
--    Setting a business REPLACES any other business tag on the transaction, so
--    this path can never produce the two-business ambiguity that §4 of the
--    research doc rules out (Quicken degrades to "Unknown Business"; KEEL
--    refuses instead — see the keel_tag_assign guard below for the path that
--    can still attempt it).
--
--    Returns the business tag id, or null after a clear.
-- ---------------------------------------------------------------------------
create or replace function public.keel_transaction_set_business(
  p_household_id uuid,
  p_txn_id uuid,
  p_entity_id uuid
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := coalesce(
    nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
    nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid;
  v_tag_id uuid;
  v_before uuid;
  v_removed int := 0;
  v_added int := 0;
begin
  perform public.keel_assert_member_write(p_household_id);

  if not exists (
    select 1 from public.canonical_transactions
     where id = p_txn_id and household_id = p_household_id and voided_at is null
  ) then
    raise exception 'KEEL_NOT_FOUND: transaction' using errcode = 'P0006';
  end if;

  -- Current attribution, for the audit before-image and for idempotency.
  select t.entity_id into v_before
    from public.transaction_tags tt
    join public.tags t on t.id = tt.tag_id
   where tt.canonical_transaction_id = p_txn_id and t.entity_id is not null
   limit 1;

  if p_entity_id is not null then
    v_tag_id := public.keel_entity_business_tag_ensure(p_household_id, p_entity_id);
  end if;

  -- Drop every business tag that is not the one being set. On a clear
  -- (p_entity_id null, v_tag_id null) this removes all of them.
  delete from public.transaction_tags tt
   using public.tags t
   where t.id = tt.tag_id
     and tt.canonical_transaction_id = p_txn_id
     and t.entity_id is not null
     and (v_tag_id is null or t.id <> v_tag_id);
  get diagnostics v_removed = row_count;

  if v_tag_id is not null then
    insert into public.transaction_tags (canonical_transaction_id, tag_id, household_id)
    values (p_txn_id, v_tag_id, p_household_id)
    on conflict do nothing;
    get diagnostics v_added = row_count;
  end if;

  -- Law 2: audit mutations, not replays. Re-setting the same business is a
  -- no-op and writes nothing.
  if v_removed > 0 or v_added > 0 then
    insert into public.audit_log (household_id, actor, action, object_type, object_id, before, after)
    values (p_household_id, jsonb_build_object('kind', 'user', 'userId', v_uid),
            case when p_entity_id is null
                 then 'transaction.clear_business'
                 else 'transaction.set_business' end,
            'canonical_transaction', p_txn_id,
            jsonb_build_object('entityId', v_before),
            jsonb_build_object('entityId', p_entity_id, 'tagId', v_tag_id));
  end if;

  return v_tag_id;
end;
$$;

revoke all on function public.keel_transaction_set_business(uuid, uuid, uuid) from public, anon;
grant execute on function public.keel_transaction_set_business(uuid, uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Guard the generic tag picker. Business tags remain ordinary tags in the
--    picker (so "#Acme LLC" is visible on the row like any other label), but a
--    SECOND business tag makes the transaction's business ambiguous.
--
--    Quicken reports that state as "Unknown Business". KEEL refuses it: this
--    attribution feeds a tax artifact, and silent ambiguity there violates the
--    explicit-ownership invariant. The user is pointed at splits, which is the
--    same answer Quicken and QuickBooks give for a genuinely mixed charge.
--
--    Full recreate of the 20260713120000 body with ONE added guard.
-- ---------------------------------------------------------------------------
create or replace function public.keel_tag_assign(
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
  v_entity_id uuid;
  v_other text;
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
  select t.entity_id into v_entity_id
    from public.tags t
   where t.id = p_tag_id and t.household_id = p_household_id;
  if not found then
    raise exception 'KEEL_NOT_FOUND: tag' using errcode = 'P0006';
  end if;

  -- One business per transaction (20260831120000). Refuse rather than record
  -- an attribution nobody can act on.
  if p_assigned and v_entity_id is not null then
    select t.name into v_other
      from public.transaction_tags tt
      join public.tags t on t.id = tt.tag_id
     where tt.canonical_transaction_id = p_txn_id
       and t.entity_id is not null
       and t.id <> p_tag_id
     limit 1;
    if v_other is not null then
      raise exception
        'KEEL_INVALID_COMMAND: this transaction already belongs to "%"; a transaction can belong to one business — split it to divide the amount between businesses',
        v_other using errcode = 'P0009';
    end if;
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

-- ---------------------------------------------------------------------------
-- 5. Guard tag deletion. Deleting an ordinary tag drops a label; deleting a
--    BUSINESS tag would silently un-attribute every transaction that business
--    owns — destroying a tax artifact through a presentation-level control.
--    Refused, in the spirit of the CLAUDE.md soft-delete directive.
--
--    Full recreate of the 20260713120000 body with ONE added guard.
-- ---------------------------------------------------------------------------
create or replace function public.keel_tag_delete(p_household_id uuid, p_tag_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text;
  v_uses int;
  v_entity_id uuid;
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
  select name, entity_id into v_name, v_entity_id from public.tags
    where id = p_tag_id and household_id = p_household_id;
  if v_name is null then
    raise exception 'KEEL_NOT_FOUND: tag' using errcode = 'P0006';
  end if;
  if v_entity_id is not null then
    raise exception
      'KEEL_INVALID_COMMAND: "%" is a business tag; deleting it would un-attribute every transaction that business owns',
      v_name using errcode = 'P0009';
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

-- ---------------------------------------------------------------------------
-- 6. Read: tags.list carries the binding.
--
--    This is the ONLY read model that changes. Every transaction row already
--    emits its tags (20260713120000 added the lateral), so a client that knows
--    which tag ids are business tags can derive a row's business attribution
--    with no change to keel_list_transactions_rich / _rich_page — the two
--    largest and most-recreated read models in the schema. Server-side entity
--    scope (accounts owned by the entity UNION transactions carrying its
--    business tag) belongs in the one authorization compiler and is deliberately
--    a separate slice (research doc §6, S3).
--
--    Full recreate of the 20260713120000 body with ONE added key.
-- ---------------------------------------------------------------------------
create or replace function public.keel_list_tags(p_household_id uuid)
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
           'entityId', t.entity_id,
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
