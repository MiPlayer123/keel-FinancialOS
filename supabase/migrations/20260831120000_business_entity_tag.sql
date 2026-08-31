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
--   - Law 6: `packages/exports` enumerates columns explicitly and projects
--     strictly onto that list, so the new column is added to the `tags` entry
--     in packages/exports/src/manifest.ts in the same change. (The SQL-side
--     keel_export_household uses to_jsonb and picks it up on its own; the
--     manifest is the surface admin.export_all actually serves.)

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
-- 1b. Adoption guard.
--
--     Adopting a hand-rolled tag turns every transaction already carrying it
--     into that business's, in one statement. If any of those transactions
--     already belongs to a DIFFERENT business, adoption would create exactly
--     the two-business state that keel_tag_assign refuses and
--     keel_transaction_set_business is built to make impossible — silently,
--     in bulk, and with no per-transaction audit. Refused at the door.
--
--     VOIDED transactions are excluded from the clash check: a voided row is on
--     nobody's books (same rule as keel_transaction_set_business and the
--     keel_tag_assign guard), so a stale business tag on one must not block an
--     unrelated adoption the user cannot then unblock — the front door refuses
--     to clear a voided row at all.
-- ---------------------------------------------------------------------------
create or replace function public.keel_assert_adoptable_business_tag(
  p_tag_id uuid,
  p_tag_name text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_clash text;
begin
  -- Lock every transaction this adoption would re-attribute, BEFORE reading
  -- their current attribution. Without the lock the guard reads a snapshot and
  -- a concurrent keel_transaction_set_business can attribute one of these rows
  -- between the read and the update, leaving two businesses on it.
  perform 1
     from public.canonical_transactions c
     join public.transaction_tags tt on tt.canonical_transaction_id = c.id
    where tt.tag_id = p_tag_id and c.voided_at is null
    order by c.id
      for update of c;

  select other.name into v_clash
    from public.transaction_tags mine
    join public.canonical_transactions c
      on c.id = mine.canonical_transaction_id and c.voided_at is null
    join public.transaction_tags theirs
      on theirs.canonical_transaction_id = mine.canonical_transaction_id
     and theirs.tag_id <> mine.tag_id
    join public.tags other on other.id = theirs.tag_id
   where mine.tag_id = p_tag_id
     and other.entity_id is not null
   limit 1;
  if v_clash is not null then
    raise exception
      'KEEL_INVALID_COMMAND: the tag "%" is already on a transaction that belongs to "%"; a transaction can belong to one business, so remove it there first',
      p_tag_name, v_clash using errcode = 'P0009';
  end if;
end;
$$;

revoke all on function public.keel_assert_adoptable_business_tag(uuid, text)
  from public, anon, authenticated;

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

  -- tags.name is capped at 40 chars; entities.name at 200. btrim on BOTH
  -- sides of the truncation: entities' own check only requires 1..200 chars,
  -- so a seeded/imported whitespace-only name would otherwise fall through to
  -- tags' check constraint as a raw 23514 with no KEEL_ error code, and a cut
  -- landing mid-space would leave a trailing space in the picker.
  v_tag_name := btrim(left(btrim(v_entity_name), 40));
  if char_length(v_tag_name) = 0 then
    raise exception 'KEEL_INVALID_COMMAND: entity has no usable name for a business tag'
      using errcode = 'P0009';
  end if;

  select t.id, t.entity_id into v_tag_id, v_existing_entity
    from public.tags t
   where t.household_id = p_household_id and lower(t.name) = lower(v_tag_name);

  if v_tag_id is not null then
    if v_existing_entity is not null then
      raise exception
        'KEEL_INVALID_COMMAND: the tag "%" is already another business''s tag; rename the entity or that tag (entity names are shortened to 40 characters for the tag, so two long names can collide here)',
        v_tag_name using errcode = 'P0009';
    end if;
    perform public.keel_assert_adoptable_business_tag(v_tag_id, v_tag_name);
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
      -- The common race is two calls binding the SAME entity (a double-click on
      -- the first attribution, or a client retry). The winner already did what
      -- this call wanted, so return its tag rather than failing a caller whose
      -- request in fact succeeded — "bind idempotently" has to hold under
      -- concurrency too, not just on replay.
      if v_tag_id is not null and v_existing_entity = p_entity_id then
        return v_tag_id;
      end if;
      if v_tag_id is null or v_existing_entity is not null then
        raise exception
          'KEEL_INVALID_COMMAND: could not bind a business tag named "%"', v_tag_name
          using errcode = 'P0009';
      end if;
      perform public.keel_assert_adoptable_business_tag(v_tag_id, v_tag_name);
      update public.tags set entity_id = p_entity_id where id = v_tag_id;
    end;
  end if;

  -- Adoption retro-attributes every transaction already carrying the tag, so
  -- the audit records how many, and that the tag was previously unbound. Law 2:
  -- the record has to be enough to reverse the change, not just to notice it.
  insert into public.audit_log (household_id, actor, action, object_type, object_id, before, after)
  values (p_household_id, jsonb_build_object('kind', 'user', 'userId', v_uid),
          'tags.bind_entity', 'tag', v_tag_id,
          jsonb_build_object('entityId', null),
          jsonb_build_object(
            'entityId', p_entity_id,
            'name', v_tag_name,
            'assignments',
            (select count(*)::int from public.transaction_tags tt where tt.tag_id = v_tag_id)));

  return v_tag_id;
end;
$$;

revoke all on function public.keel_entity_business_tag_ensure(uuid, uuid) from public, anon;
grant execute on function public.keel_entity_business_tag_ensure(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 2b. Undo the bind.
--
--     Without this, binding the wrong entity is unrecoverable from inside the
--     product: keel_tag_delete refuses a business tag (section 5), and nothing
--     else writes tags.entity_id, so the only repair would be hand-written SQL
--     against production. Law 2 requires every mutation be undoable, and the
--     CLAUDE.md soft-delete directive exists precisely because an
--     unrecoverable path shipped once before.
--
--     Unbinding does NOT remove the tag from any transaction: the rows keep the
--     label, they simply stop counting as that business's. That is the
--     reversible-correction shape (nothing is destroyed) and it means bind and
--     unbind are exact inverses.
-- ---------------------------------------------------------------------------
create or replace function public.keel_entity_business_tag_unbind(
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
  v_tag_id uuid;
  v_name text;
  v_uses int;
  v_txns jsonb;
begin
  perform public.keel_assert_member_write(p_household_id);

  select t.id, t.name into v_tag_id, v_name
    from public.tags t
   where t.household_id = p_household_id and t.entity_id = p_entity_id;
  -- Idempotent: an entity with no business tag is already unbound.
  if v_tag_id is null then
    return null;
  end if;

  -- Record WHICH transactions this business owned, not just how many.
  -- keel_tag_delete cascades transaction_tags away, so unbind-then-delete is a
  -- two-call path to destroying every attribution; a count cannot rebuild that,
  -- a list can. Law 2: the audit has to be enough to reverse the change.
  select count(*)::int, coalesce(jsonb_agg(tt.canonical_transaction_id order by tt.canonical_transaction_id), '[]'::jsonb)
    into v_uses, v_txns
    from public.transaction_tags tt where tt.tag_id = v_tag_id;

  update public.tags set entity_id = null where id = v_tag_id;

  insert into public.audit_log (household_id, actor, action, object_type, object_id, before, after)
  values (p_household_id, jsonb_build_object('kind', 'user', 'userId', v_uid),
          'tags.unbind_entity', 'tag', v_tag_id,
          jsonb_build_object('entityId', p_entity_id, 'name', v_name,
                             'assignments', v_uses, 'transactionIds', v_txns),
          jsonb_build_object('entityId', null));

  return v_tag_id;
end;
$$;

revoke all on function public.keel_entity_business_tag_unbind(uuid, uuid) from public, anon;
grant execute on function public.keel_entity_business_tag_unbind(uuid, uuid) to authenticated;

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
  v_before jsonb;
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

  -- Serialize concurrent attribution of the SAME transaction. Without this,
  -- two sessions setting different businesses each delete what they can see
  -- (neither sees the other's uncommitted insert under READ COMMITTED) and
  -- both commit, leaving two business tags and telling both callers it worked.
  perform 1 from public.canonical_transactions where id = p_txn_id for update;

  -- Current attribution, for the audit before-image and for idempotency. An
  -- aggregate rather than `limit 1`: if the row somehow carries more than one
  -- business, a clear removes them ALL, and Law 2's reversible correction is
  -- worth nothing if the before-image only records one of them.
  select jsonb_agg(distinct t.entity_id) into v_before
    from public.transaction_tags tt
    join public.tags t on t.id = tt.tag_id
   where tt.canonical_transaction_id = p_txn_id and t.entity_id is not null;

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
            jsonb_build_object('entityIds', coalesce(v_before, '[]'::jsonb)),
            jsonb_build_object('entityId', p_entity_id, 'tagId', v_tag_id));
  end if;

  return v_tag_id;
end;
$$;

revoke all on function public.keel_transaction_set_business(uuid, uuid, uuid) from public, anon;
grant execute on function public.keel_transaction_set_business(uuid, uuid, uuid) to authenticated;

-- Deviation from the entity-proc house pattern, recorded deliberately
-- (CLAUDE.md: deviations without justification are bugs). keel_create_entity /
-- keel_list_entities are handed to keel_api for least privilege
-- (20260713210000). The functions above are NOT, because they would stop
-- working: 20260713120000 grants keel_api nothing on public.tags or
-- public.transaction_tags, and the definer_all RLS policy loop
-- (20260710210500) predates those tables, so keel_api has no policy on them
-- either. They therefore stay owned by the migration role, like every other
-- proc in 20260713120000. Handing them over is a follow-up that must add the
-- table grants and policies first.

-- ---------------------------------------------------------------------------
-- 4. Guard the generic tag picker. Business tags remain ordinary tags in the
--    picker (so "#Acme LLC" is visible on the row like any other label), but a
--    SECOND business tag makes the transaction's business ambiguous.
--
--    On the business path this proc now also enforces the write role and takes
--    the same row lock as keel_transaction_set_business, so the two doors agree
--    on who may write and cannot race each other. Ordinary tags are untouched.
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
  v_entity_archived timestamptz;
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
  select t.entity_id, e.archived_at into v_entity_id, v_entity_archived
    from public.tags t
    left join public.entities e on e.id = t.entity_id
   where t.id = p_tag_id and t.household_id = p_household_id;
  if not found then
    raise exception 'KEEL_NOT_FOUND: tag' using errcode = 'P0006';
  end if;

  -- Business-tag rules (20260831120000). Only the business path is tightened;
  -- ordinary tags keep the 20260713120000 behaviour exactly, including on
  -- voided rows and for whatever role this proc has always allowed.
  if v_entity_id is not null then
    -- Write-role gate. This proc has only ever checked MEMBERSHIP, which was
    -- defensible while it only moved presentation labels around. It now writes
    -- business attribution — a tax artifact — so on that path it must enforce
    -- what keel_transaction_set_business enforces, or the front door refuses a
    -- viewer (P0005) while the door beside it accepts the identical write
    -- (Law 7: no privileged side doors). Assign AND unassign: destroying an
    -- attribution is as much a write as creating one.
    perform public.keel_assert_member_write(p_household_id);

    -- Serialize against keel_transaction_set_business and against another
    -- concurrent assign. The guard below reads which businesses the row already
    -- has; without the lock that read is a snapshot, and two sessions can each
    -- see "no business" and each insert a different one.
    perform 1 from public.canonical_transactions where id = p_txn_id for update;
  end if;

  if p_assigned and v_entity_id is not null then
    -- A voided transaction is not on anyone's books. keel_transaction_set_business
    -- refuses one, and it must not be reachable through the side door either:
    -- that door can attribute a voided row, and the front door then refuses to
    -- clear it.
    if exists (
      select 1 from public.canonical_transactions
       where id = p_txn_id and voided_at is not null
    ) then
      raise exception 'KEEL_INVALID_COMMAND: a voided transaction cannot belong to a business'
        using errcode = 'P0009';
    end if;
    -- Same mismatch, other axis: keel_entity_business_tag_ensure refuses an
    -- archived entity, so the front door cannot book new expenses into closed
    -- books. This door must not either.
    if v_entity_archived is not null then
      raise exception
        'KEEL_INVALID_COMMAND: that business is archived; reopen it before attributing expenses to it'
        using errcode = 'P0009';
    end if;
    select t.name into v_other
      from public.transaction_tags tt
      join public.tags t on t.id = tt.tag_id
     where tt.canonical_transaction_id = p_txn_id
       and t.entity_id is not null
       and t.id <> p_tag_id
     limit 1;
    if v_other is not null then
      raise exception
        'KEEL_INVALID_COMMAND: this transaction already belongs to "%". A transaction can belong to one business; change it to this one instead, or record the two shares as separate transactions.',
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
      'KEEL_INVALID_COMMAND: "%" is a business tag; deleting it would un-attribute every transaction that business owns. Unbind it from the business first, then delete it.',
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
