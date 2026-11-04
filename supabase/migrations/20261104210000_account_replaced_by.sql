-- Account continuity: an account REPLACED BY another (a reissued card's old
-- number, a relinked bank account) reads as part of its successor.
--
-- KEEL never merges two accounts' ledgers (20260718061000 reconnect_dedupe
-- ruling: ledger_account_id is fixed, postings are immutable, Law 9). After a
-- card reissue the old number keeps its history frozen on an archived account
-- and the new number starts fresh, so the app showed one card as two. Now the
-- old account names its successor, and the successor's register includes the
-- old account's transactions on their own cash rows. Nothing in the ledger
-- moves; the link is one audited, reversible column. Re-runnable.

-- 1. The link.
alter table public.accounts
  add column if not exists replaced_by_account_id uuid references public.accounts (id);
do $$ begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.accounts'::regclass and conname = 'accounts_replaced_by_not_self'
  ) then
    alter table public.accounts
      add constraint accounts_replaced_by_not_self check (replaced_by_account_id is null or replaced_by_account_id <> id);
  end if;
end $$;
create index if not exists accounts_replaced_by_idx
  on public.accounts (replaced_by_account_id) where replaced_by_account_id is not null;

-- 2. Set or clear it. The old account must be closed (archived), the
--    successor live, both in this household with the same entity, currency
--    and kind (a card replaces a card), and no loop. Audited; clear with null.
create or replace function public.keel_set_account_replacement(
  p_household_id uuid,
  p_account_id uuid,
  p_replaced_by_account_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := coalesce(
    nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
    nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid;
  v_old public.accounts%rowtype;
  v_new public.accounts%rowtype;
  v_old_kind text;
  v_new_kind text;
begin
  perform public.keel_assert_member_write(p_household_id);

  select * into v_old from public.accounts
   where id = p_account_id and household_id = p_household_id
   for update;
  if not found then
    raise exception 'KEEL_NOT_FOUND: account' using errcode = 'P0006';
  end if;

  if p_replaced_by_account_id is not null then
    select * into v_new from public.accounts
     where id = p_replaced_by_account_id and household_id = p_household_id;
    if not found then
      raise exception 'KEEL_NOT_FOUND: replacement account' using errcode = 'P0006';
    end if;
    if v_new.id = v_old.id then
      raise exception 'KEEL_INVALID_COMMAND: an account cannot replace itself' using errcode = 'P0009';
    end if;
    if v_old.archived_at is null then
      raise exception 'KEEL_INVALID_COMMAND: only a closed (archived) account can be replaced' using errcode = 'P0009';
    end if;
    if v_new.archived_at is not null then
      raise exception 'KEEL_INVALID_COMMAND: the replacement must be a live account' using errcode = 'P0009';
    end if;
    select la.kind::text into v_old_kind from public.ledger_accounts la where la.id = v_old.ledger_account_id;
    select la.kind::text into v_new_kind from public.ledger_accounts la where la.id = v_new.ledger_account_id;
    if v_old.entity_id <> v_new.entity_id or v_old.currency <> v_new.currency
       or v_old_kind is distinct from v_new_kind then
      raise exception 'KEEL_INVALID_COMMAND: the replacement must have the same entity, currency and kind'
        using errcode = 'P0009';
    end if;
    -- No loop: the successor must not (transitively) be replaced by the old account.
    if exists (
      with recursive chain(id) as (
        select v_new.replaced_by_account_id
        union
        select a.replaced_by_account_id from public.accounts a join chain on a.id = chain.id
         where a.replaced_by_account_id is not null
      )
      select 1 from chain where chain.id = v_old.id
    ) then
      raise exception 'KEEL_INVALID_COMMAND: that would make a loop of replacements' using errcode = 'P0009';
    end if;
  end if;

  -- Idempotent: the same link again is a no-op with no audit noise.
  if v_old.replaced_by_account_id is not distinct from p_replaced_by_account_id then
    return jsonb_build_object('accountId', v_old.id, 'replacedByAccountId', p_replaced_by_account_id, 'changed', false);
  end if;

  update public.accounts set replaced_by_account_id = p_replaced_by_account_id where id = v_old.id;

  insert into public.audit_log (household_id, actor, action, object_type, object_id, before, after)
  values (p_household_id, jsonb_build_object('kind', 'user', 'userId', v_uid),
          'account.set_replacement', 'account', v_old.id,
          jsonb_build_object('replaced_by_account_id', v_old.replaced_by_account_id),
          jsonb_build_object('replaced_by_account_id', p_replaced_by_account_id));

  return jsonb_build_object('accountId', v_old.id, 'replacedByAccountId', p_replaced_by_account_id, 'changed', true);
end;
$$;
revoke all on function public.keel_set_account_replacement(uuid, uuid, uuid) from public, anon;
grant execute on function public.keel_set_account_replacement(uuid, uuid, uuid) to authenticated;
grant update (replaced_by_account_id) on public.accounts to keel_api;

grant create on schema public to keel_api;
alter function public.keel_set_account_replacement(uuid, uuid, uuid) owner to keel_api;
revoke create on schema public from keel_api;

-- 3. The register: the page builder (20261104100000) with the viewed-account
--    join widened to the account's family. Same signature, so both public
--    reads (keel_list_transactions_rich_page, keel_query_transactions) follow.
create or replace function public.keel_transactions_page(
  p_household_id uuid,
  p_limit integer,
  p_cursor_date date,
  p_cursor_id uuid,
  p_account_id uuid,
  p_category_id uuid,
  p_search text,
  p_from date,
  p_to date,
  p_transaction_ids uuid[],
  p_direction text,
  p_min_amount_minor bigint,
  p_max_amount_minor bigint,
  p_status text,
  p_entity_id uuid,
  p_tag_id uuid,
  p_uncategorized boolean,
  p_search_notes boolean
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_limit int := least(greatest(coalesce(p_limit, 100), 1), 200);
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
  v_pattern text;
  v_rows jsonb;
  v_next jsonb := null;
  v_last_date text;
  v_last_id text;
  v_count int;
  v_family uuid[];
begin
  -- The requested account plus every account it (transitively) replaced.
  if p_account_id is not null then
    with recursive fam(id) as (
      select p_account_id
      union
      select a.id from public.accounts a
        join fam on a.replaced_by_account_id = fam.id
       where a.household_id = p_household_id
    )
    select array_agg(fam.id) into v_family from fam;
  end if;
  if v_search is not null then
    v_pattern := '%' || replace(replace(replace(v_search, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;

  with page as (
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
        'accountMask', acc.mask,
        'entityId', acc.entity_id,
        'amountMinor', cashp.amount_minor::text,
        'currency', cashp.currency,
        -- A leg view (acc is NOT the header account) is a transfer INTO/out of
        -- the viewed account — no category, shown as Transfer.
        'categoryLedgerAccountId',
          case when acc.id <> ct.account_id then null
               when (offs.n > 1 or offs.account_legs > 0) then null
               else coalesce(catov.id, offs.one_id) end,
        'categoryName',
          case when acc.id <> ct.account_id then 'Transfer'
               when (offs.n > 1 or offs.account_legs > 0) then 'Split'
               else coalesce(catov.name, offs.one_name) end,
        'categoryKind',
          case when acc.id <> ct.account_id then 'transfer'
               when (offs.n > 1 or offs.account_legs > 0) then null
               else coalesce(catov.kind::text, offs.one_kind) end,
        'categoryPfcKey',
          case when acc.id <> ct.account_id then null
               when (offs.n > 1 or offs.account_legs > 0) then null
               else coalesce(catov.pfc_key, offs.one_pfc_key) end,
        'categorySource',
          case when acc.id <> ct.account_id then null
               when (offs.n > 1 or offs.account_legs > 0) then 'user'
               else tc.source end,
        'splits',
          case when acc.id <> ct.account_id then null
               when (offs.n > 1 or offs.account_legs > 0) then offs.splits end,
        'distributionTransfer', (acc.id <> ct.account_id),
        'tags', tgs.tags,
        'transferStatus', tl.status,
        'transferLinkId', tl.id,
        'transferBooked', tl.booked_txn is not null,
        'counterpartyAccountId',
          case when acc.id <> ct.account_id then hdr.id
               when tl.status = 'confirmed' then cp.account_id end,
        'counterpartyAccountName',
          case when acc.id <> ct.account_id then hdr.name
               when tl.status = 'confirmed' then cp.account_name end,
        'counterpartyTransactionId', case when tl.status = 'confirmed' then cp.txn_id end,
        'reconciled', exists (
          select 1 from public.reconciliation_items ri
           where ri.household_id = ct.household_id
             and ri.transaction_id = ct.id
             and ri.resolution = 'matched_transaction'
        )
      ) as row,
      ct.effective_date as eff_date,
      ct.id as txn_id
      from public.canonical_transactions ct
      join public.journal_batches jb
        on jb.canonical_transaction_id = ct.id and jb.reverses_batch_id is null
       and not exists (
         select 1 from public.journal_revisions rev where rev.original_batch_id = jb.id
       )
      -- Viewed account: the requested account (destination-register aware) or
      -- the header account for the global list. The cash row is that account's
      -- posting; a transaction with no posting to the requested account drops.
      -- An account it replaced (reissued card, 20261104210000) counts as the
      -- same register: its own transactions show on their own cash rows.
      join public.accounts acc on acc.id = case
        when p_account_id is null then ct.account_id
        when ct.account_id = any(v_family) then ct.account_id
        else p_account_id end
      join public.journal_postings cashp
        on cashp.batch_id = jb.id and cashp.ledger_account_id = acc.ledger_account_id
      left join public.accounts hdr on hdr.id = ct.account_id
      cross join lateral (
        select count(*)::int as n,
               count(*) filter (where legs.leg_type = 'account')::int as account_legs,
               (min(legs.cat_id::text) filter (where legs.leg_type = 'category'))::uuid as one_id,
               min(legs.name)    filter (where legs.leg_type = 'category') as one_name,
               min(legs.kind)    filter (where legs.leg_type = 'category') as one_kind,
               min(legs.pfc_key) filter (where legs.leg_type = 'category') as one_pfc_key,
               jsonb_agg(jsonb_build_object(
                 'categoryLedgerAccountId', legs.cat_id,
                 'name', legs.name,
                 'kind', legs.kind,
                 'amountMinor', legs.amount_minor::text,
                 'legType', legs.leg_type,
                 'accountId', legs.acct_id
               ) order by legs.amount_minor desc, legs.pid) as splits
          from (
            -- "category" leg: a real category (is_category=true), OR a
            -- non-category ledger account with NO matching `accounts` row
            -- (a bare offset like `investments` — not a distribution
            -- destination, just not a spend/income category either).
            select op.id as pid, op.amount_minor,
                   oc.id as cat_id, oc.name, oc.kind::text as kind, oc.pfc_key,
                   'category'::text as leg_type, null::uuid as acct_id
              from public.journal_postings op
              join public.ledger_accounts oc
                on oc.id = op.ledger_account_id
               and (
                 oc.is_category = true
                 or not exists (
                   select 1 from public.accounts a2 where a2.ledger_account_id = oc.id
                 )
               )
             where op.batch_id = jb.id
            union all
            select op.id as pid, op.amount_minor,
                   null::uuid as cat_id, oacc.name, 'transfer'::text as kind, null::text as pfc_key,
                   'account'::text as leg_type, oacc.id as acct_id
              from public.journal_postings op
              join public.ledger_accounts ola
                on ola.id = op.ledger_account_id and ola.is_category = false
              join public.accounts oacc on oacc.ledger_account_id = ola.id
             where op.batch_id = jb.id
               and op.ledger_account_id <> acc.ledger_account_id
          ) legs
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
      left join lateral (
        select cpacc.id as account_id, cpacc.name as account_name, cpct.id as txn_id
          from public.canonical_transactions cpct
          join public.accounts cpacc on cpacc.id = cpct.account_id
         where cpct.id = case when tl.txn_out = ct.id then tl.txn_in else tl.txn_out end
         limit 1
      ) cp on tl.status = 'confirmed'
      where ct.household_id = p_household_id
        and ct.voided_at is null
        and offs.n >= 1
        -- Optional filters (all null = the unfiltered page, unchanged).
        and (p_from is null or ct.effective_date >= p_from)
        and (p_to is null or ct.effective_date < p_to)
        and (p_transaction_ids is null or ct.id = any (p_transaction_ids))
        and (p_status is null or ct.status::text = p_status)
        and (p_entity_id is null or acc.entity_id = p_entity_id)
        and (p_direction is null
             or (p_direction = 'in' and cashp.amount_minor > 0)
             or (p_direction = 'out' and cashp.amount_minor < 0))
        and (p_min_amount_minor is null or abs(cashp.amount_minor) >= p_min_amount_minor)
        and (p_max_amount_minor is null or abs(cashp.amount_minor) <= p_max_amount_minor)
        and (p_tag_id is null or exists (
              select 1 from public.transaction_tags ftt
               where ftt.canonical_transaction_id = ct.id and ftt.tag_id = p_tag_id))
        -- The user's category wins over the posting's (same precedence as
        -- keel_txn_is_transfer_category): a custom category has no pfc_key.
        and (p_uncategorized is null or p_uncategorized = (
              acc.id = ct.account_id and offs.n = 1 and offs.account_legs = 0
              and (coalesce(catov.id, offs.one_id) is null
                   or (case when catov.id is not null then catov.pfc_key else offs.one_pfc_key end)
                        in ('uncategorized_expense', 'uncategorized_income'))))
        and (
          p_category_id is null
          or (acc.id = ct.account_id and offs.n = 1 and offs.account_legs = 0
              and coalesce(catov.id, offs.one_id) = p_category_id)
        )
        and (
          v_pattern is null
          or coalesce(tov.display_description, rr.display_name, ct.description) ilike v_pattern
          or ct.description ilike v_pattern
          or acc.name ilike v_pattern
          or (p_search_notes and tov.note ilike v_pattern)
        )
        and (
          p_cursor_date is null
          or ct.effective_date < p_cursor_date
          or (ct.effective_date = p_cursor_date and ct.id < p_cursor_id)
        )
      order by ct.effective_date desc, ct.id desc
      limit v_limit + 1
  )
  select coalesce(jsonb_agg(row order by eff_date desc, txn_id desc)
                    filter (where rn <= v_limit), '[]'::jsonb),
         count(*),
         max(eff_date::text) filter (where rn = v_limit),
         max(txn_id::text) filter (where rn = v_limit)
    into v_rows, v_count, v_last_date, v_last_id
    from (
      select row, eff_date, txn_id,
             row_number() over (order by eff_date desc, txn_id desc) as rn
        from page
    ) ranked;

  if v_count > v_limit then
    v_next := jsonb_build_object(
      'effectiveDate', v_last_date,
      'transactionId', v_last_id
    );
  end if;

  return jsonb_build_object(
    'scope', jsonb_build_object('householdId', p_household_id),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'rows', v_rows,
    'nextCursor', v_next
  );
end;
$$;

-- Internal: no membership check of its own. Never callable by clients.
revoke all on function public.keel_transactions_page(
  uuid, integer, date, uuid, uuid, uuid, text, date, date, uuid[], text, bigint, bigint, text, uuid, uuid, boolean, boolean
) from public, anon, authenticated;
grant execute on function public.keel_transactions_page(
  uuid, integer, date, uuid, uuid, uuid, text, date, date, uuid[], text, bigint, bigint, text, uuid, uuid, boolean, boolean
) to keel_api;
