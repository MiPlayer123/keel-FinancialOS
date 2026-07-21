-- Fix: investment buy/sell transactions vanished from the transaction
-- register after F-013 part 3/4 (20260721060000). The classifier routes
-- buys/sells to the new `investments` ledger account (kind=asset,
-- is_category=false, and NOT linked to any `accounts` row — it's a bare
-- offset account, unlike a real distribution-destination account).
--
-- keel_list_transactions_rich_page's `legs` lateral only recognizes two leg
-- shapes: (a) is_category=true postings ("category" leg), and (b)
-- is_category=false postings that ARE linked to a real tracked account
-- ("account"/distribution leg, e.g. a 401k destination). A posting to
-- `investments` matches NEITHER — it's is_category=false but not tracked by
-- `accounts` — so it produces ZERO rows in `legs`, offs.n = 0, and the
-- transaction fails the register's `offs.n >= 1` filter and is silently
-- dropped entirely (not mis-categorized — INVISIBLE). Dividends/fees were
-- unaffected (investment_income/investment_fees ARE is_category=true).
--
-- Fix: broaden the "category" leg branch to also match any is_category=false
-- ledger account that has NO matching `accounts` row (i.e. a non-category
-- offset that isn't a real distribution-destination account either). This is
-- structurally safe:
--   * A viewed account's OWN cash ledger always HAS a matching `accounts` row
--     (that's what makes it "the account"), so it can never be miscaptured
--     here regardless of is_category.
--   * A real distribution-destination account leg (e.g. 401k) ALSO has a
--     matching `accounts` row, so it stays exclusively in the "account"
--     branch below (no double-counting).
--   * Only a bare, untracked, non-category ledger account (currently just
--     `investments`) newly matches — rendering as a normal single category
--     (categoryName='Investments', categoryKind='asset', categoryPfcKey=
--     'investments'), visible in the register, while remaining excluded from
--     cash_flow (keel_cash_flow_monthly still filters on is_category=true,
--     unchanged by this migration).
create or replace function public.keel_list_transactions_rich_page(
  p_household_id uuid,
  p_limit integer default 100,
  p_cursor_date date default null,
  p_cursor_id uuid default null,
  p_account_id uuid default null,
  p_category_id uuid default null,
  p_search text default null
)
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
  v_limit int := least(greatest(coalesce(p_limit, 100), 1), 200);
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
  v_pattern text;
  v_rows jsonb;
  v_next jsonb := null;
  v_last_date text;
  v_last_id text;
  v_count int;
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
      join public.accounts acc on acc.id = coalesce(p_account_id, ct.account_id)
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

revoke all on function public.keel_list_transactions_rich_page(uuid, integer, date, uuid, uuid, uuid, text)
  from public, anon;
grant execute on function public.keel_list_transactions_rich_page(uuid, integer, date, uuid, uuid, uuid, text)
  to authenticated, service_role;
