-- MCP connector: connected-app grants, gateway guard, audit attribution, and a
-- filtered transaction query (supabase/functions/mcp/README.md).
--
-- Supabase Auth's OAuth 2.1 server issues connected AI apps (Claude, Codex,
-- ChatGPT) ordinary user JWTs plus a `client_id` claim; it cannot bind an
-- audience or custom scopes. KEEL therefore owns three things here:
--   1. mcp_client_grants — what the user allowed each app (household + read or
--      write), set on KEEL's consent page, checked on every MCP call, revoked
--      by soft delete (revoked_at).
--   2. keel_pre_request — PostgREST refuses a connected-app token unless the
--      request comes through the `mcp` function (vault-held gateway key), so
--      an app's token cannot call keel_* procs or tables directly.
--   3. audit_log rows written under a connected-app token are stamped
--      actor.via = {kind:'connected_app', clientId} (Law 2: who did what).
-- Plus keel_query_transactions: the paginated rich read with date / id /
-- direction / amount / status / entity / tag / uncategorized filters, sharing
-- ONE page builder with keel_list_transactions_rich_page (unchanged contract).

-- ---------------------------------------------------------------------------
-- 1. Connected-app grants
-- ---------------------------------------------------------------------------
create type public.mcp_access_level as enum ('read', 'write');

create table public.mcp_client_grants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id),
  client_id text not null check (length(client_id) between 1 and 200),
  household_id uuid not null references public.households (id),
  access public.mcp_access_level not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revoked_at timestamptz
);

-- At most one live grant per (user, app); revoked rows are kept (soft delete).
create unique index mcp_client_grants_live
  on public.mcp_client_grants (user_id, client_id) where revoked_at is null;

alter table public.mcp_client_grants enable row level security;
create policy mcp_client_grants_own_read on public.mcp_client_grants
  for select to authenticated using (user_id = (select auth.uid()));
grant select on public.mcp_client_grants to authenticated;

-- Caller identity for the grant procs. A connected app may never grant or
-- revoke access itself: only the user's own KEEL session can.
create function public.keel_mcp_first_party_uid() returns uuid
language plpgsql
stable
set search_path = public
as $$
declare
  v_claims jsonb := nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb;
  v_uid uuid := coalesce(
    nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
    v_claims ->> 'sub'
  )::uuid;
begin
  if v_uid is null then
    raise exception 'KEEL_NOT_AUTHENTICATED' using errcode = 'P0004';
  end if;
  if coalesce(v_claims ->> 'client_id', '') <> '' then
    raise exception 'KEEL_NOT_AUTHORIZED: connected apps cannot change their own access'
      using errcode = 'P0005';
  end if;
  return v_uid;
end;
$$;
revoke all on function public.keel_mcp_first_party_uid() from public, anon;

create function public.keel_mcp_grant_set(
  p_client_id text,
  p_household_id uuid,
  p_access public.mcp_access_level
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.keel_mcp_first_party_uid();
  v_row public.mcp_client_grants%rowtype;
  v_before jsonb := null;
begin
  if p_client_id is null or length(p_client_id) not between 1 and 200 or p_access is null then
    raise exception 'KEEL_INVALID_COMMAND: client and access level required' using errcode = 'P0009';
  end if;
  if not exists (
    select 1 from public.household_memberships m
     where m.household_id = p_household_id and m.user_id = v_uid
  ) then
    raise exception 'KEEL_SCOPE_VIOLATION' using errcode = 'P0006';
  end if;

  select * into v_row from public.mcp_client_grants
   where user_id = v_uid and client_id = p_client_id and revoked_at is null
   for update;

  if found then
    if v_row.household_id = p_household_id and v_row.access = p_access then
      return v_row.id;  -- idempotent: no audit noise
    end if;
    v_before := jsonb_build_object('household_id', v_row.household_id, 'access', v_row.access);
    update public.mcp_client_grants
       set household_id = p_household_id, access = p_access, updated_at = now()
     where id = v_row.id;
  else
    insert into public.mcp_client_grants (user_id, client_id, household_id, access)
    values (v_uid, p_client_id, p_household_id, p_access)
    returning * into v_row;
  end if;

  insert into public.audit_log (household_id, actor, action, object_type, object_id, before, after)
  values (p_household_id, jsonb_build_object('kind', 'user', 'userId', v_uid),
          'mcp_grant.set', 'mcp_client_grant', v_row.id, v_before,
          jsonb_build_object('client_id', p_client_id, 'household_id', p_household_id, 'access', p_access));
  return v_row.id;
end;
$$;

create function public.keel_mcp_grant_revoke(p_client_id text) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.keel_mcp_first_party_uid();
  v_row public.mcp_client_grants%rowtype;
begin
  update public.mcp_client_grants
     set revoked_at = now(), updated_at = now()
   where user_id = v_uid and client_id = p_client_id and revoked_at is null
  returning * into v_row;
  if not found then
    return;  -- idempotent
  end if;
  insert into public.audit_log (household_id, actor, action, object_type, object_id, before, after)
  values (v_row.household_id, jsonb_build_object('kind', 'user', 'userId', v_uid),
          'mcp_grant.revoke', 'mcp_client_grant', v_row.id,
          jsonb_build_object('client_id', v_row.client_id, 'access', v_row.access),
          jsonb_build_object('revoked', true));
end;
$$;

-- The live grant for the calling connected app, or null. Called by the `mcp`
-- function on every request with the app's own token. A grant whose household
-- membership has since ended is not live.
create function public.keel_mcp_grant_current() returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_claims jsonb := nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb;
  v_uid uuid := (v_claims ->> 'sub')::uuid;
  v_client text := nullif(v_claims ->> 'client_id', '');
  v_row public.mcp_client_grants%rowtype;
begin
  if v_uid is null or v_client is null then
    return null;
  end if;
  select g.* into v_row from public.mcp_client_grants g
    join public.household_memberships m
      on m.household_id = g.household_id and m.user_id = g.user_id
   where g.user_id = v_uid and g.client_id = v_client and g.revoked_at is null;
  if not found then
    return null;
  end if;
  return jsonb_build_object(
    'grantId', v_row.id,
    'householdId', v_row.household_id,
    'access', v_row.access,
    'grantedAt', v_row.created_at
  );
end;
$$;

revoke all on function public.keel_mcp_grant_set(text, uuid, public.mcp_access_level) from public, anon;
revoke all on function public.keel_mcp_grant_revoke(text) from public, anon;
revoke all on function public.keel_mcp_grant_current() from public, anon;
grant execute on function public.keel_mcp_first_party_uid() to authenticated;
grant execute on function public.keel_mcp_grant_set(text, uuid, public.mcp_access_level) to authenticated;
grant execute on function public.keel_mcp_grant_revoke(text) to authenticated;
grant execute on function public.keel_mcp_grant_current() to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Audit attribution: stamp the connected app on every audit row written
--    under its token. One trigger covers every proc, however it builds actor.
-- ---------------------------------------------------------------------------
create function public.keel_audit_stamp_connected_app() returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_client text := nullif(
    nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'client_id', '');
begin
  if v_client is not null and jsonb_typeof(new.actor) = 'object' then
    new.actor := new.actor || jsonb_build_object(
      'via', jsonb_build_object('kind', 'connected_app', 'clientId', v_client));
  end if;
  return new;
end;
$$;

create trigger audit_log_stamp_connected_app
  before insert on public.audit_log
  for each row execute function public.keel_audit_stamp_connected_app();

-- ---------------------------------------------------------------------------
-- 3. Gateway guard. A connected-app token reaches PostgREST only through the
--    `mcp` function, which proves itself with the x-keel-mcp-gateway header
--    (vault secret `keel_mcp_gateway_key`, also set as the function secret
--    KEEL_MCP_GATEWAY_KEY). Missing secret = fail closed. Requests without a
--    client_id claim (every KEEL web session, anon, service) pass untouched.
-- ---------------------------------------------------------------------------
create function public.keel_pre_request() returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_claims jsonb := nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb;
  v_header text;
  v_key text;
begin
  if v_claims is null or coalesce(v_claims ->> 'client_id', '') = '' then
    return;
  end if;
  v_header := nullif(pg_catalog.current_setting('request.headers', true), '')::jsonb
                ->> 'x-keel-mcp-gateway';
  begin
    execute $q$
      select decrypted_secret from vault.decrypted_secrets
       where name = 'keel_mcp_gateway_key' limit 1
    $q$ into v_key;
  exception
    when undefined_table or insufficient_privilege or invalid_schema_name then
      v_key := null;
  end;
  if v_key is null or v_header is null
     or extensions.digest(v_header, 'sha256') <> extensions.digest(v_key, 'sha256') then
    raise exception 'connected-app tokens are accepted only through the KEEL MCP endpoint'
      using errcode = '42501';
  end if;
end;
$$;

revoke all on function public.keel_pre_request() from public;
grant execute on function public.keel_pre_request() to anon, authenticated, service_role;

-- Supabase's documented hook (docs: guides/api/securing-your-api). It covers the
-- Data API only; Storage has no client policies and no tables are published to
-- Realtime, so those paths expose nothing to app tokens.
alter role authenticator set pgrst.db_pre_request = 'public.keel_pre_request';
notify pgrst, 'reload config';

-- ---------------------------------------------------------------------------
-- 4. One page builder for the rich transaction read. The body is the
--    20260721070000 page query verbatim plus optional filters; both public
--    reads below delegate to it after their own membership check.
-- ---------------------------------------------------------------------------
create function public.keel_transactions_page(
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
  p_uncategorized boolean
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
begin
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
        -- Optional filters (all null = the unfiltered page, unchanged).
        and (p_from is null or ct.effective_date >= p_from)
        and (p_to is null or ct.effective_date < p_to)
        and (p_transaction_ids is null or ct.id = any (p_transaction_ids))
        and (p_status is null or ct.status::text = p_status)
        and (p_entity_id is null or ct.entity_id = p_entity_id)
        and (p_direction is null
             or (p_direction = 'in' and cashp.amount_minor > 0)
             or (p_direction = 'out' and cashp.amount_minor < 0))
        and (p_min_amount_minor is null or abs(cashp.amount_minor) >= p_min_amount_minor)
        and (p_max_amount_minor is null or abs(cashp.amount_minor) <= p_max_amount_minor)
        and (p_tag_id is null or exists (
              select 1 from public.transaction_tags ftt
               where ftt.canonical_transaction_id = ct.id and ftt.tag_id = p_tag_id))
        and (p_uncategorized is null or p_uncategorized = (
              acc.id = ct.account_id and offs.n = 1 and offs.account_legs = 0
              and (coalesce(catov.id, offs.one_id) is null
                   or coalesce(catov.pfc_key, offs.one_pfc_key)
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
  uuid, integer, date, uuid, uuid, uuid, text, date, date, uuid[], text, bigint, bigint, text, uuid, uuid, boolean
) from public, anon, authenticated;

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
  return public.keel_transactions_page(
    p_household_id, p_limit, p_cursor_date, p_cursor_id, p_account_id, p_category_id, p_search,
    null, null, null, null, null, null, null, null, null, null);
end;
$$;

-- Filtered rich read. p_filters keys (all optional): accountId, categoryId,
-- search, from (inclusive), to (exclusive), transactionIds (≤ 200), direction
-- ('in' | 'out', from the account's side), minAmountMinor / maxAmountMinor
-- (absolute, integer minor units), status ('pending' | 'posted'), entityId,
-- tagId, uncategorized (boolean). Unknown keys are rejected.
create function public.keel_query_transactions(
  p_household_id uuid,
  p_filters jsonb default '{}'::jsonb,
  p_limit integer default 50,
  p_cursor_date date default null,
  p_cursor_id uuid default null
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
  v_f jsonb := coalesce(p_filters, '{}'::jsonb);
  v_ids uuid[];
  v_direction text;
  v_status text;
  v_min bigint;
  v_max bigint;
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
  if jsonb_typeof(v_f) <> 'object' or exists (
    select 1 from jsonb_object_keys(v_f) k
     where k not in ('accountId', 'categoryId', 'search', 'from', 'to', 'transactionIds',
                     'direction', 'minAmountMinor', 'maxAmountMinor', 'status', 'entityId',
                     'tagId', 'uncategorized')
  ) then
    raise exception 'KEEL_INVALID_COMMAND: unknown filter' using errcode = 'P0009';
  end if;

  v_direction := v_f ->> 'direction';
  v_status := v_f ->> 'status';
  if v_direction is not null and v_direction not in ('in', 'out') then
    raise exception 'KEEL_INVALID_COMMAND: direction must be in or out' using errcode = 'P0009';
  end if;
  if v_status is not null and v_status not in ('pending', 'posted') then
    raise exception 'KEEL_INVALID_COMMAND: status must be pending or posted' using errcode = 'P0009';
  end if;

  begin
    if v_f ? 'transactionIds' then
      select array_agg(e::uuid) into v_ids from jsonb_array_elements_text(v_f -> 'transactionIds') e;
      if coalesce(array_length(v_ids, 1), 0) > 200 then
        raise exception 'too many ids';
      end if;
    end if;
    v_min := (v_f ->> 'minAmountMinor')::bigint;
    v_max := (v_f ->> 'maxAmountMinor')::bigint;
    if (v_min is not null and v_min < 0) or (v_max is not null and v_max < 0)
       or (v_min is not null and v_max is not null and v_min > v_max) then
      raise exception 'bad amount range';
    end if;
    return public.keel_transactions_page(
      p_household_id, p_limit, p_cursor_date, p_cursor_id,
      (v_f ->> 'accountId')::uuid, (v_f ->> 'categoryId')::uuid, v_f ->> 'search',
      (v_f ->> 'from')::date, (v_f ->> 'to')::date, v_ids, v_direction, v_min, v_max, v_status,
      (v_f ->> 'entityId')::uuid, (v_f ->> 'tagId')::uuid, (v_f ->> 'uncategorized')::boolean);
  exception
    when invalid_text_representation or invalid_datetime_format or datetime_field_overflow
      or numeric_value_out_of_range or raise_exception or invalid_parameter_value then
      raise exception 'KEEL_INVALID_COMMAND: filters failed validation' using errcode = 'P0009';
  end;
end;
$$;

revoke all on function public.keel_query_transactions(uuid, jsonb, integer, date, uuid) from public, anon;
grant execute on function public.keel_query_transactions(uuid, jsonb, integer, date, uuid)
  to authenticated, service_role;
