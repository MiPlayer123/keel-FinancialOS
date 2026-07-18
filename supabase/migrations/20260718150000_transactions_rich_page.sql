-- WS-H / FEEDBACK.md F-005 (perf) + F-021 (Cmd+K transaction search).
--
-- PROBLEM (verified). keel_list_transactions_rich(p_household_id) is UNBOUNDED:
-- it aggregates the ENTIRE household history (1,351 live rows today, growing)
-- into one jsonb blob, with four correlated laterals PER ROW (splits agg, tags
-- agg, reconciled EXISTS, counterparty lateral). Seven pages fetch it on
-- mount, and every save nukes the whole client cache → a full re-download. The
-- account-detail page downloads the whole household then filters client-side.
--
-- THIS MIGRATION adds a BOUNDED, keyset-paginated, server-filtered variant that
-- emits the EXACT same per-row DTO as keel_list_transactions_rich, plus a
-- lightweight search proc for the command palette. The unbounded function is
-- left in place untouched (exports, the AI-chat snapshot, and pages this slice
-- does not migrate still call it); its signature/output shape are unchanged.
--
-- No table columns are added anywhere, so the export systems
-- (keel_export_household chain + packages/exports/src/manifest.ts) and the
-- pgTAP 008 export allowlist are unaffected — only new READ functions + one
-- hot-path index are introduced.
--
-- Laws honoured: no LLM/arithmetic (Law 1 — pure read); source strings stay
-- data-tier (Law 5 — search is a parameterized ILIKE, never executed as code);
-- money is BIGINT minor units, never floats (Law 4); the read fails CLOSED on a
-- null JWT sub and re-checks household membership (Law 7, mirrors
-- keel_list_transactions_rich's own auth). Numbers are reproducible: the page
-- carries scope + asOf, same envelope as the unbounded read (Law 9).

-- ---------------------------------------------------------------------------
-- 0. Hot-path index for keyset pagination. The deterministic page order is
--    (effective_date DESC, id DESC); the base table only had a plain
--    (household_id) index, so every page scan re-sorted the whole history.
--    This composite covers the WHERE household_id = ? + ORDER BY + the cursor
--    predicate. `id` is included so a page boundary that splits two rows with
--    the SAME effective_date is stable and never skips/duplicates a row.
--    Partial on the live set (voided_at is null) — voided rows are never
--    returned, so they should not bloat the index.
-- ---------------------------------------------------------------------------
create index if not exists canonical_transactions_household_effdate_id
  on public.canonical_transactions (household_id, effective_date desc, id desc)
  where voided_at is null;

-- account_id filter (account-detail page): the current function reaches the
-- account through postings, but canonical_transactions.account_id is the
-- authoritative owning account and is what we filter on. Index it per
-- household so the account page's server-side filter is a cheap index scan.
create index if not exists canonical_transactions_household_account_effdate
  on public.canonical_transactions (household_id, account_id, effective_date desc, id desc)
  where voided_at is null;

-- ---------------------------------------------------------------------------
-- 1. keel_list_transactions_rich_page — bounded page of the rich DTO.
--
--    Args:
--      p_household_id  scope (membership re-checked below)
--      p_limit         page size, clamped to [1, 200]
--      p_cursor_date   keyset cursor: the effective_date of the LAST row of the
--                      previous page (null = first page)
--      p_cursor_id     keyset cursor: the id of that last row (tie-breaker)
--      p_account_id    optional server-side account filter (null = all)
--      p_category_id   optional single-offset category filter (null = all)
--      p_search        optional case-insensitive text over description /
--                      original description / counterparty account name
--                      (null/'' = no text filter)
--
--    Returns { scope, asOf, rows, nextCursor } where nextCursor is
--    { effectiveDate, transactionId } of the last row when a further page may
--    exist, else null. Keyset (NOT offset) so pages are stable under concurrent
--    inserts and cheap at any depth.
--
--    The per-row DTO is byte-for-byte the same jsonb_build_object the unbounded
--    keel_list_transactions_rich emits (same keys, same casts, same laterals) —
--    consuming pages and WS-I/WS-J branches share the RichTransactionRow type,
--    so the shape is a contract. A pgTAP DTO-parity test (029) locks this.
-- ---------------------------------------------------------------------------
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
security definer
set search_path = public
stable
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
  -- Fail CLOSED on a null caller (Law 7); mirrors keel_list_transactions_rich.
  if v_uid is null then
    raise exception 'KEEL_NOT_AUTHENTICATED' using errcode = 'P0004';
  end if;
  if not exists (
    select 1 from public.household_memberships m
     where m.household_id = p_household_id and m.user_id = v_uid
  ) then
    raise exception 'KEEL_SCOPE_VIOLATION' using errcode = 'P0006';
  end if;

  -- ILIKE escape: the search string is DATA (Law 5). % and _ typed by the user
  -- are literals, never wildcards, and can never become SQL — it is a bound
  -- parameter to ILIKE, not concatenated into a query.
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
        'categorySource', case when offs.n > 1 then 'user' else tc.source end,
        'splits', case when offs.n > 1 then offs.splits end,
        'tags', tgs.tags,
        'transferStatus', tl.status,
        'transferLinkId', tl.id,
        'transferBooked', tl.booked_txn is not null,
        'counterpartyAccountId', case when tl.status = 'confirmed' then cp.account_id end,
        'counterpartyAccountName', case when tl.status = 'confirmed' then cp.account_name end,
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
      left join lateral (
        select cpacc.id as account_id, cpacc.name as account_name, cpct.id as txn_id
          from public.canonical_transactions cpct
          join public.journal_batches cpjb
            on cpjb.canonical_transaction_id = cpct.id and cpjb.reverses_batch_id is null
           and not exists (
             select 1 from public.journal_revisions rev where rev.original_batch_id = cpjb.id
           )
          join public.journal_postings cpp on cpp.batch_id = cpjb.id
          join public.ledger_accounts cpla
            on cpla.id = cpp.ledger_account_id and cpla.is_category = false
          join public.accounts cpacc on cpacc.ledger_account_id = cpla.id
         where cpct.id = case when tl.txn_out = ct.id then tl.txn_in else tl.txn_out end
         limit 1
      ) cp on tl.status = 'confirmed'
      where ct.household_id = p_household_id
        and ct.voided_at is null
        and offs.n >= 1
        -- Server-side account filter (account-detail page): filter on the
        -- authoritative owning account, matching the posting-derived acc.id so
        -- the DTO's accountId is always the filtered account.
        and (p_account_id is null or acc.id = p_account_id)
        -- Single-offset category filter (matches the DTO's categoryLedgerAccountId
        -- when the txn is not split; split rows never match a single category).
        and (
          p_category_id is null
          or (offs.n = 1 and coalesce(catov.id, offs.one_id) = p_category_id)
        )
        -- Text search over the DISPLAY description, the immutable ORIGINAL
        -- description, and the account name (Law 5: all data-tier, ILIKE-escaped).
        and (
          v_pattern is null
          or coalesce(tov.display_description, rr.display_name, ct.description) ilike v_pattern
          or ct.description ilike v_pattern
          or acc.name ilike v_pattern
        )
        -- Keyset cursor: strictly AFTER the previous page's last row in the
        -- (effective_date DESC, id DESC) order.
        and (
          p_cursor_date is null
          or ct.effective_date < p_cursor_date
          or (ct.effective_date = p_cursor_date and ct.id < p_cursor_id)
        )
      order by ct.effective_date desc, ct.id desc
      limit v_limit + 1   -- fetch one extra to know whether a next page exists
  )
  -- The cursor is the last RETURNED row (rn = v_limit). Exactly one row carries
  -- that rank, so max(..) over the filtered set is just that single value; the
  -- ::text casts avoid needing a max() aggregate for uuid (Postgres has none).
  -- v_count is the TOTAL fetched (up to v_limit+1) so we can tell whether the
  -- extra sentinel row exists — a next page exists iff v_count > v_limit. A
  -- WITH-CTE is only visible to the single statement that owns it, so this must
  -- be computed here, not in a second `select count(*) from page`.
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

  -- A next page exists iff we actually saw the extra (limit+1)th row.
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

-- ---------------------------------------------------------------------------
-- 2. keel_search_transactions — lightweight typeahead for the command palette
--    (F-021). Returns AT MOST p_limit slim hits (id, date, description,
--    account, amount, currency) matching a case-insensitive term over the
--    display / original description and the account name. Deliberately NOT the
--    heavy rich DTO: the palette shows a one-line result and navigates to the
--    ledger filtered to that row — it never needs splits/tags/counterparty.
--    Same fail-closed auth + membership check. Server-side so the palette never
--    downloads the full history (the whole point of F-021).
-- ---------------------------------------------------------------------------
create or replace function public.keel_search_transactions(
  p_household_id uuid,
  p_search text,
  p_limit integer default 8
)
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
  v_limit int := least(greatest(coalesce(p_limit, 8), 1), 25);
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
  v_pattern text;
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

  -- Empty term → empty result (the palette shows its other groups instead).
  if v_search is null then
    return jsonb_build_object(
      'scope', jsonb_build_object('householdId', p_household_id),
      'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'rows', '[]'::jsonb
    );
  end if;
  v_pattern := '%' || replace(replace(replace(v_search, '\', '\\'), '%', '\%'), '_', '\_') || '%';

  select coalesce(jsonb_agg(row order by row->>'effectiveDate' desc, row->>'transactionId' desc), '[]'::jsonb)
    into v_rows
    from (
      select jsonb_build_object(
        'transactionId', ct.id,
        'effectiveDate', ct.effective_date,
        'description', left(coalesce(tov.display_description, rr.display_name, ct.description), 140),
        'accountId', acc.id,
        'accountName', acc.name,
        'amountMinor', cashp.amount_minor::text,
        'currency', cashp.currency
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
      left join public.transaction_overrides tov on tov.canonical_transaction_id = ct.id
      left join public.rule_renames rr on rr.canonical_transaction_id = ct.id
      where ct.household_id = p_household_id
        and ct.voided_at is null
        and (
          coalesce(tov.display_description, rr.display_name, ct.description) ilike v_pattern
          or ct.description ilike v_pattern
          or acc.name ilike v_pattern
        )
      order by ct.effective_date desc, ct.id desc
      limit v_limit
    ) t;

  return jsonb_build_object(
    'scope', jsonb_build_object('householdId', p_household_id),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'rows', v_rows
  );
end;
$$;

revoke all on function public.keel_search_transactions(uuid, text, integer) from public, anon;
grant execute on function public.keel_search_transactions(uuid, text, integer) to authenticated, service_role;
