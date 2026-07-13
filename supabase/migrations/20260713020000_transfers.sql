-- Transfer detection + confirm/exclude (BC-v2.1 §3 transfer_links, D-012).
-- Closes the top correctness gap in design/FEATURE-GAP-REPORT.md: without
-- pairing, an inter-account transfer double-counts as income on one side and
-- expense on the other. Detection is DETERMINISTIC (Law 1: no LLM): exact
-- opposite cash amounts, same currency, different accounts, within 3 days.
-- Suggestions require explicit user confirmation (suggest→approve, Law 2);
-- only CONFIRMED links change reported cash flow, and the ledger itself is
-- never touched (classification overlay semantics, postings stay append-only).

-- 1) Deterministic detection. One-to-one greedy pairing ordered by
--    (date gap, id) so replays produce the same pairs; already-linked
--    (suggested/confirmed) transactions never re-pair; a rejected pair can
--    never be re-suggested (unique (txn_out, txn_in) + do nothing).
create or replace function public.keel_detect_transfers(p_household_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  -- User-driven detection requires membership; the service path (worker cron)
  -- carries no user claim. Execute privilege is limited to authenticated +
  -- service_role below.
  if auth.uid() is not null and not exists (
    select 1 from public.household_memberships
    where household_id = p_household_id and user_id = auth.uid()
  ) then
    raise exception 'KEEL_NOT_FOUND' using errcode = 'P0006';
  end if;

  with cash as (
    select ct.id as txn_id, ct.effective_date, acc.id as account_id,
           p.amount_minor, p.currency
      from public.canonical_transactions ct
      join public.journal_batches jb
        on jb.canonical_transaction_id = ct.id and jb.reverses_batch_id is null
      join public.journal_postings p on p.batch_id = jb.id
      join public.ledger_accounts la
        on la.id = p.ledger_account_id and la.is_category = false
      join public.accounts acc on acc.ledger_account_id = la.id
      where ct.household_id = p_household_id
        and ct.voided_at is null
        and p.amount_minor <> 0
  ),
  linked as (
    select txn_out as txn from public.transfer_links
      where household_id = p_household_id and status in ('suggested', 'confirmed')
    union
    select txn_in from public.transfer_links
      where household_id = p_household_id and status in ('suggested', 'confirmed')
  ),
  pairs as (
    select o.txn_id as txn_out, i.txn_id as txn_in,
           abs(i.effective_date - o.effective_date) as day_gap
      from cash o
      join cash i
        on i.currency = o.currency
       and i.amount_minor = -o.amount_minor
       and i.account_id <> o.account_id
       and abs(i.effective_date - o.effective_date) <= 3
      where o.amount_minor < 0
        and not exists (select 1 from linked l where l.txn = o.txn_id)
        and not exists (select 1 from linked l where l.txn = i.txn_id)
  ),
  best_out as (
    select txn_out, txn_in, day_gap,
           row_number() over (partition by txn_out order by day_gap, txn_in) as rn
      from pairs
  ),
  uniq as (
    select txn_out, txn_in,
           row_number() over (partition by txn_in order by day_gap, txn_out) as rn_in
      from best_out where rn = 1
  )
  insert into public.transfer_links (household_id, txn_out, txn_in, status)
  select p_household_id, txn_out, txn_in, 'suggested'
    from uniq where rn_in = 1
  on conflict (txn_out, txn_in) do nothing;
  get diagnostics v_count = row_count;

  if v_count > 0 then
    insert into public.audit_log (household_id, actor, action, object_type, object_id, after)
    values (p_household_id,
            case when auth.uid() is null
                 then jsonb_build_object('kind', 'system', 'source', 'transfer_detector')
                 else jsonb_build_object('kind', 'user', 'userId', auth.uid()) end,
            'transfers.detect', 'household', p_household_id,
            jsonb_build_object('suggested', v_count));
  end if;
  return v_count;
end;
$$;

revoke all on function public.keel_detect_transfers(uuid) from public, anon;
grant execute on function public.keel_detect_transfers(uuid) to authenticated, service_role;

-- 2) Read model: suggested + confirmed links with both sides' display data.
create or replace function public.keel_list_transfers(p_household_id uuid)
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

  with cash as (
    select ct.id as txn_id,
           left(coalesce(tov.display_description, ct.description), 140) as description,
           ct.effective_date, acc.name as account_name,
           p.amount_minor, p.currency
      from public.canonical_transactions ct
      join public.journal_batches jb
        on jb.canonical_transaction_id = ct.id and jb.reverses_batch_id is null
      join public.journal_postings p on p.batch_id = jb.id
      join public.ledger_accounts la
        on la.id = p.ledger_account_id and la.is_category = false
      join public.accounts acc on acc.ledger_account_id = la.id
      left join public.transaction_overrides tov on tov.canonical_transaction_id = ct.id
      where ct.household_id = p_household_id
  )
  select coalesce(jsonb_agg(row order by row->>'status' desc, row->>'effectiveDate' desc, row->>'linkId'), '[]'::jsonb)
    into v_rows
    from (
      select jsonb_build_object(
        'linkId', tl.id,
        'status', tl.status,
        'effectiveDate', o.effective_date,
        'amountMinor', abs(o.amount_minor)::text,
        'currency', o.currency,
        'outTxnId', o.txn_id,
        'outDescription', o.description,
        'outAccountName', o.account_name,
        'inTxnId', i.txn_id,
        'inDescription', i.description,
        'inAccountName', i.account_name,
        'dayGap', abs(i.effective_date - o.effective_date)
      ) as row
      from public.transfer_links tl
      join cash o on o.txn_id = tl.txn_out
      join cash i on i.txn_id = tl.txn_in
      where tl.household_id = p_household_id
        and tl.status in ('suggested', 'confirmed')
    ) t;

  return jsonb_build_object(
    'scope', jsonb_build_object('householdId', p_household_id),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'formulaVersion', 'transfer-links-v1',
    'rows', v_rows
  );
end;
$$;

revoke all on function public.keel_list_transfers(uuid) from public, anon;
grant execute on function public.keel_list_transfers(uuid) to authenticated, service_role;

-- 3) User decision: confirm (exclude from cash flow) or reject (never
--    re-suggested). Audited; suggested-only transition.
create or replace function public.keel_decide_transfer(
  p_household_id uuid,
  p_link_id uuid,
  p_confirm boolean
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status public.transfer_link_status;
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

  select status into v_status
    from public.transfer_links
    where id = p_link_id and household_id = p_household_id
    for update;
  if v_status is null then
    raise exception 'KEEL_NOT_FOUND: transfer link' using errcode = 'P0006';
  end if;
  if v_status <> 'suggested' then
    raise exception 'KEEL_INVALID_COMMAND: transfer link already decided' using errcode = 'P0009';
  end if;

  update public.transfer_links
     set status = case when p_confirm then 'confirmed' else 'rejected' end::public.transfer_link_status,
         decided_by = auth.uid(),
         decided_at = now()
   where id = p_link_id;

  insert into public.audit_log (household_id, actor, action, object_type, object_id, before, after)
  values (p_household_id, jsonb_build_object('kind', 'user', 'userId', auth.uid()),
          'transfers.decide', 'transfer_link', p_link_id,
          jsonb_build_object('status', 'suggested'),
          jsonb_build_object('status', case when p_confirm then 'confirmed' else 'rejected' end));
end;
$$;

revoke all on function public.keel_decide_transfer(uuid, uuid, boolean) from public, anon;
grant execute on function public.keel_decide_transfer(uuid, uuid, boolean) to authenticated;

-- 4) Cash flow now excludes CONFIRMED transfers on both sides (the offsets of
--    the paired transactions no longer report as income/expense). Suggested
--    links change nothing until approved.
create or replace function public.keel_cash_flow(p_household_id uuid, p_from date, p_to date)
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
  if p_from > p_to then
    raise exception 'KEEL_INVALID_RANGE' using errcode = 'P0001';
  end if;

  select coalesce(jsonb_agg(row order by row->>'currency'), '[]'::jsonb) into v_rows
    from (
      select jsonb_build_object(
        'currency', p.currency,
        'inflowMinor', coalesce(-sum(p.amount_minor) filter (where la.kind = 'income'), 0)::text,
        'outflowMinor', coalesce(sum(p.amount_minor) filter (where la.kind = 'expense'), 0)::text,
        'netMinor', (
          coalesce(-sum(p.amount_minor) filter (where la.kind = 'income'), 0)
          - coalesce(sum(p.amount_minor) filter (where la.kind = 'expense'), 0)
        )::text
      ) as row
      from public.journal_postings p
      join public.journal_batches b on b.id = p.batch_id
      join public.ledger_accounts la on la.id = p.ledger_account_id
      where b.household_id = p_household_id
        and b.effective_date between p_from and p_to
        and la.kind in ('income', 'expense')
        and not exists (
          select 1 from public.transfer_links tl
          where tl.household_id = p_household_id
            and tl.status = 'confirmed'
            and (tl.txn_out = b.canonical_transaction_id
                 or tl.txn_in = b.canonical_transaction_id)
        )
      group by p.currency
    ) t;

  return jsonb_build_object(
    'scope', jsonb_build_object('householdId', p_household_id),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'formulaVersion', 'cash-flow-v2-transfer-excluded',
    'rows', v_rows
  );
end;
$$;

-- 5) Rich ledger rows carry the transfer status so the UI can badge pairs
--    and exclude confirmed transfers from category math.
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
        'categoryKind', coalesce(catov.kind, offcat.kind),
        'transferStatus', tl.status
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
      left join public.transfer_links tl
        on (tl.txn_out = ct.id or tl.txn_in = ct.id)
       and tl.status in ('suggested', 'confirmed')
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
