-- Statement ingestion SLICE 9 (docs/harness/plans/statement-ingestion-v2.md §5
-- 20260720140000 [A8], §10 UI slice 3, SLICE 9 row). Apply extracted investment
-- positions to an account's live holdings.
--
-- Investment statements already extract holdings into statement_extraction_holdings
-- (Slice 3). This slice lets the user APPLY those positions to the account's
-- `holdings` (the CURRENT portfolio breakdown), and REVERT.
--
-- Laws:
--  * Law 10: applying holdings is AI class B (suggest→approve). Never auto-applied;
--    the diff read model is a SUGGESTION only. Apply requires a redeemed approval
--    token (Law 11), issued over the SAME server-normalized positions payload the
--    apply command redeems.
--  * Law 11 + the SLICE 0 GATE (advisory A): the apply command binds ONE local
--    v_payload and passes it to BOTH keel_approval_token_redeem AND the holdings
--    write, in one transaction. "Exact bytes approved = exact bytes executed" holds
--    by construction — there is no second payload variable. The ISSUE side
--    (keel_cmd_statements_issue_holdings_approval) rebuilds v_payload with the
--    CHARACTER-FOR-CHARACTER same expression, so hash(issue)==hash(redeem).
--  * Law 9 (idempotent economics): re-applying the same statement is a no-op
--    (unique(household_id, statement_id) + on-conflict; holdings_snapshots
--    on-conflict do-update). Replay produces one economic history.
--  * Law 2 (reversible; audit != undo): unapply is revoked_at/revoked_by +
--    rebuild-from-prior, never a delete. Correction is a compensating rebuild.
--  * Law 4: money = BIGINT minor units; qty is exact numeric. No floats.
--
-- [A8] STALE-RISK DESIGN (verified against LIVE, not the plan's guess):
--   On live, `holdings` unique is (account_id, symbol, source) — NO as_of column
--   in the key; as_of is a plain data column and `keel_list_holdings` rebuilds
--   CURRENT from max(as_of) per account. So "current statement holdings" is exactly
--   the set of source='statement' rows for the account. The apply command REBUILDS
--   that set atomically from the NEWEST non-revoked application:
--     1. delete every source='statement' holding on the account,
--     2. insert the newest application's positions at as_of = its period_end.
--   Therefore a symbol absent from a newer full statement DROPS from current
--   (step 1 clears it, step 2 does not re-add it), and applying an OLDER statement
--   (period_end < the newest non-revoked application) does NOT regress current —
--   the rebuild always sources from the max-period_end application, never the one
--   just applied if a newer one exists.
--   holdings_snapshots is a SEPARATE audit table (per snapshot_date); its source
--   check must ALSO widen. A snapshot is written per applied statement at
--   snapshot_date = period_end (idempotent on-conflict).

-- ===========================================================================
-- 1. Widen BOTH source check constraints to include 'statement'
-- ===========================================================================
alter table public.holdings drop constraint holdings_source_check;
alter table public.holdings add constraint holdings_source_check
  check (source = any (array['manual'::text, 'plaid'::text, 'statement'::text]));

alter table public.holdings_snapshots drop constraint holdings_snapshots_source_check;
alter table public.holdings_snapshots add constraint holdings_snapshots_source_check
  check (source = any (array['manual'::text, 'plaid'::text, 'statement'::text]));

-- ===========================================================================
-- 2. Composite tenant unique on statement_extractions (needed for the
--    application's composite tenant FK). statements already has (household_id,id).
-- ===========================================================================
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'statement_extractions_household_id_id_key'
  ) then
    alter table public.statement_extractions
      add constraint statement_extractions_household_id_id_key unique (household_id, id);
  end if;
end
$$;

-- ===========================================================================
-- 3. statement_holding_applications — the audited record of "these positions
--    from this statement were applied to this account's holdings".
--    unique(household_id, statement_id): one live application per statement.
--    revoked_at != null marks a reverted application (Law 2, never deleted).
-- ===========================================================================
create table public.statement_holding_applications (
  household_id uuid not null references public.households (id),
  id uuid not null default gen_random_uuid(),
  statement_id uuid not null,
  extraction_id uuid not null,
  account_id uuid not null,
  applied_by uuid not null references auth.users (id),
  approval_token_id uuid not null,
  period_end date not null,
  revoked_at timestamptz,
  revoked_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  primary key (household_id, id),
  -- One application row per statement (idempotent apply; unapply flips revoked_at,
  -- it does not free the slot — a re-apply of the SAME statement reuses the row).
  unique (household_id, statement_id),
  constraint fk_holding_app_statement_tenant
    foreign key (household_id, statement_id) references public.statements (household_id, id),
  constraint fk_holding_app_extraction_tenant
    foreign key (household_id, extraction_id) references public.statement_extractions (household_id, id),
  constraint fk_holding_app_account_tenant
    foreign key (household_id, account_id) references public.accounts (household_id, id),
  constraint fk_holding_app_token_tenant
    foreign key (household_id, approval_token_id) references public.approval_tokens (household_id, token_id)
);

create index statement_holding_applications_account
  on public.statement_holding_applications (household_id, account_id)
  where revoked_at is null;

alter table public.statement_holding_applications enable row level security;
revoke all on public.statement_holding_applications from public, anon, authenticated;
grant select on public.statement_holding_applications to authenticated, service_role;
grant select, insert, update on public.statement_holding_applications to keel_api;
create policy statement_holding_applications_read on public.statement_holding_applications
  for select to authenticated
  using (public.keel_recurring_account_access(household_id, account_id, false));
create policy statement_holding_applications_api on public.statement_holding_applications
  for all to keel_api using (true) with check (true);

-- ===========================================================================
-- 4. keel_statement_holdings_rebuild(household, account) — INTERNAL helper.
--    Rebuild the account's source='statement' holdings from its NEWEST
--    non-revoked application (highest period_end, tie-break latest created_at).
--    Clears all source='statement' rows first (symbol-drop), then inserts the
--    winning application's extraction positions at as_of = period_end. If there
--    is no non-revoked application left, the account simply has no statement
--    holdings. Does NOT touch manual/plaid rows. Returns the winning
--    application id (or null). SECURITY DEFINER; callers pre-authorize.
-- ===========================================================================
create function public.keel_statement_holdings_rebuild(
  p_household_id uuid,
  p_account_id uuid
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_app public.statement_holding_applications%rowtype;
begin
  -- The winning (current) application: newest period_end, then latest apply.
  select * into v_app
    from public.statement_holding_applications
   where household_id = p_household_id
     and account_id = p_account_id
     and revoked_at is null
   order by period_end desc, created_at desc, id desc
   limit 1;

  -- Step 1 (symbol-drop): clear ALL statement-sourced current holdings for the
  -- account. Only source='statement' rows — manual/plaid are untouched. Hard
  -- delete is correct here: these are a fully rebuildable projection of the
  -- winning application, not a source of truth (the applications table + the
  -- immutable extraction rows + holdings_snapshots retain full history).
  delete from public.holdings
   where household_id = p_household_id
     and account_id = p_account_id
     and source = 'statement';

  if v_app.id is null then
    return null;                     -- all applications revoked: no statement holdings
  end if;

  -- Step 2: insert the winning application's positions as the new current set.
  -- qty>0 and value_minor>=0 are enforced by holdings CHECKs — a hostile/partial
  -- extraction row that violates them raises and aborts the whole apply txn
  -- (never silently drops a position). value_minor is coalesced from the
  -- extraction, else computed round(qty*price) (exact numeric, Law 4).
  insert into public.holdings
    (household_id, account_id, as_of, symbol, name, qty, price_minor, value_minor,
     cost_basis_minor, currency, source)
  select
    h.household_id, v_app.account_id, v_app.period_end,
    upper(btrim(h.symbol)), h.name, h.qty,
    coalesce(h.price_minor, 0),
    coalesce(h.value_minor, round(coalesce(h.qty,0) * coalesce(h.price_minor,0))::bigint),
    h.cost_basis_minor,
    coalesce(nullif(h.currency,''), 'USD'),
    'statement'
    from public.statement_extraction_holdings h
   where h.household_id = p_household_id
     and h.extraction_id = v_app.extraction_id
     and h.qty is not null and h.qty > 0;

  return v_app.id;
end;
$$;

-- ===========================================================================
-- 5. keel_statement_holdings_apply_payload(household, statement_id) — INTERNAL:
--    build THE ONE normalized positions payload for a statement's holdings, the
--    exact value both the ISSUE and the APPLY sides hash (Law 11 GATE). It is
--    derived ENTIRELY from server facts (the extraction rows) — the client never
--    supplies positions; it only names the statement. So issue and redeem
--    reconstruct byte-identical payloads by construction.
--    Shape: {statementId, extractionId, accountId, periodEnd, positions:[...]}
--    positions sorted by symbol for determinism; each is {symbol,cusip,isin,
--    qty,priceMinor,valueMinor,costBasisMinor,currency} as text (Law 4 strings).
-- ===========================================================================
create function public.keel_statement_holdings_apply_payload(
  p_household_id uuid,
  p_statement_id uuid
) returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_s public.statements%rowtype;
  v_extraction_id uuid;
  v_subtype text;
  v_positions jsonb;
begin
  select * into v_s from public.statements
   where household_id = p_household_id and id = p_statement_id;
  if not found then
    raise exception 'KEEL_NOT_FOUND: statement' using errcode = 'P0006';
  end if;

  -- Investment-subtype gate: holdings only apply to investment accounts.
  select a.subtype into v_subtype
    from public.accounts a
   where a.household_id = p_household_id and a.id = v_s.account_id;
  if not public.keel_is_investment_subtype(v_subtype) then
    raise exception 'KEEL_INVALID_COMMAND: account is not an investment account' using errcode = 'P0009';
  end if;

  -- Resolve the extraction via the draft that produced this statement (statements
  -- carries no extraction_id; the draft links statement_id -> extraction_id).
  select d.extraction_id into v_extraction_id
    from public.statement_drafts d
   where d.household_id = p_household_id and d.statement_id = p_statement_id
     and d.extraction_id is not null
   order by d.decided_at desc nulls last, d.created_at desc
   limit 1;
  if v_extraction_id is null then
    raise exception 'KEEL_INVALID_COMMAND: statement has no extracted holdings' using errcode = 'P0009';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'symbol', upper(btrim(h.symbol)),
           'cusip', h.cusip,
           'isin', h.isin,
           'qty', h.qty::text,
           'priceMinor', coalesce(h.price_minor, 0)::text,
           'valueMinor', coalesce(h.value_minor,
                           round(coalesce(h.qty,0) * coalesce(h.price_minor,0))::bigint)::text,
           'costBasisMinor', h.cost_basis_minor::text,
           'currency', coalesce(nullif(h.currency,''), 'USD')
         ) order by upper(btrim(h.symbol)), h.id), '[]'::jsonb)
    into v_positions
    from public.statement_extraction_holdings h
   where h.household_id = p_household_id
     and h.extraction_id = v_extraction_id
     and h.qty is not null and h.qty > 0;

  return jsonb_build_object(
    'statementId', p_statement_id::text,
    'extractionId', v_extraction_id::text,
    'accountId', v_s.account_id::text,
    'periodEnd', to_char(v_s.period_end, 'YYYY-MM-DD'),
    'positions', v_positions
  );
end;
$$;

-- ===========================================================================
-- 6. keel_cmd_statements_issue_holdings_approval — mint an approval token over
--    THE normalized positions payload the apply command redeems. Mirrors the
--    Slice 7 issue route exactly (keel_cmd_statements_issue_draft_approval).
--    Command 'statements.apply_holdings', proposal_kind 'statement_apply_holdings',
--    version 1, account-scoped, 5-min TTL.
-- ===========================================================================
create function public.keel_cmd_statements_issue_holdings_approval(
  p_household_id uuid,
  p_statement_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor jsonb := public.keel_actor_from_jwt();
  v_s public.statements%rowtype;
  v_payload jsonb;
begin
  perform public.keel_assert_member_write(p_household_id);

  select * into v_s from public.statements
   where household_id = p_household_id and id = p_statement_id;
  if not found or not public.keel_recurring_account_access(p_household_id, v_s.account_id, true) then
    raise exception 'KEEL_SCOPE_VIOLATION: statement not found' using errcode = 'P0006';
  end if;

  -- THE ONE normalized payload (server-derived) — identical to what apply redeems.
  v_payload := public.keel_statement_holdings_apply_payload(p_household_id, p_statement_id);

  return public.keel_approval_token_issue(
    p_household_id,
    v_actor,
    'statements.apply_holdings',                -- command the token redeems against
    v_payload,                                  -- normalized_payload -> hashed
    jsonb_build_object('householdId', p_household_id, 'accountId', v_s.account_id),
    v_s.account_id,                             -- account scope [A10]
    'statement_apply_holdings',                 -- proposal_kind
    p_statement_id,                             -- proposal_ref
    1,                                          -- proposal_version (redeem uses 1)
    'statement-ingestion-v2',                   -- policy_version
    300                                         -- ttl seconds (5 min)
  );
end;
$$;

-- ===========================================================================
-- 7. keel_cmd_statements_apply_holdings — class-B, TOKEN-BOUND. Full command
--    envelope. Redeems the token against v_payload, records/reactivates the
--    application, writes an idempotent holdings_snapshot, then rebuilds current
--    holdings from the newest non-revoked application (drop symbols absent from a
--    newer full statement; older applies don't regress). One txn, one v_payload.
-- ===========================================================================
create function public.keel_cmd_statements_apply_holdings(
  p_command_id uuid,
  p_economic_event_key text,
  p_actor jsonb,
  p_household_id uuid,
  p_payload jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hash text := public.keel_payload_hash(p_payload);
  v_replay jsonb;
  v_actor jsonb;
  v_uid uuid;
  v_statement_id uuid;
  v_token_id uuid;
  v_s public.statements%rowtype;
  v_payload jsonb;              -- THE ONE bound payload (server-derived positions)
  v_extraction_id uuid;
  v_period_end date;
  v_app_id uuid;
  v_winner uuid;
  v_after jsonb;
  v_result jsonb;
begin
  perform public.keel_assert_member_write(p_household_id);
  v_actor := public.keel_actor_from_jwt();
  v_uid := (v_actor->>'userId')::uuid;
  v_replay := public.keel_idempotency_check(p_household_id, p_economic_event_key, v_hash);
  if v_replay is not null then
    return v_replay;
  end if;

  -- Envelope: exactly statementId + approvalTokenId.
  if jsonb_typeof(p_payload) <> 'object'
     or (p_payload - 'statement_id' - 'approval_token_id') <> '{}'::jsonb
     or coalesce(p_payload->>'statement_id', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or coalesce(p_payload->>'approval_token_id', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception 'KEEL_INVALID_COMMAND: malformed apply holdings payload' using errcode = 'P0009';
  end if;

  v_statement_id := (p_payload->>'statement_id')::uuid;
  v_token_id := (p_payload->>'approval_token_id')::uuid;

  -- Resolve + lock the statement and assert account write access [A10].
  select * into v_s from public.statements
   where household_id = p_household_id and id = v_statement_id
   for update;
  if not found or not public.keel_recurring_account_access(p_household_id, v_s.account_id, true) then
    raise exception 'KEEL_SCOPE_VIOLATION: statement not found' using errcode = 'P0006';
  end if;

  -- Build THE ONE server-normalized payload (investment gate + extraction resolve
  -- live inside). This is the exact value the token was issued over.
  v_payload := public.keel_statement_holdings_apply_payload(p_household_id, v_statement_id);
  v_extraction_id := (v_payload->>'extractionId')::uuid;
  v_period_end := (v_payload->>'periodEnd')::date;

  -- (a) REDEEM the token against THE SAME v_payload. If the extraction changed or
  -- the client aimed at a different statement, hash(v_payload) != token hash ->
  -- reject (tamper). One-use, expiry- and version-enforcing.
  perform public.keel_approval_token_redeem(
    p_household_id, v_token_id, p_command_id, v_actor,
    'statements.apply_holdings', v_payload, 1
  );

  -- (b) Record/reactivate the application for THIS statement (idempotent).
  insert into public.statement_holding_applications
    (household_id, statement_id, extraction_id, account_id, applied_by,
     approval_token_id, period_end)
  values
    (p_household_id, v_statement_id, v_extraction_id, v_s.account_id, v_uid,
     v_token_id, v_period_end)
  on conflict (household_id, statement_id) do update
    set extraction_id = excluded.extraction_id,
        approval_token_id = excluded.approval_token_id,
        applied_by = excluded.applied_by,
        period_end = excluded.period_end,
        revoked_at = null, revoked_by = null
  returning id into v_app_id;

  -- (c) Idempotent snapshot of THIS statement's positions at snapshot_date =
  -- period_end (holdings_snapshots is the immutable audit trail; on-conflict
  -- do-update keeps replay a no-op). Written from the extraction directly so a
  -- snapshot always reflects the applied document even if a NEWER statement wins
  -- the current rebuild below.
  insert into public.holdings_snapshots
    (household_id, account_id, snapshot_date, symbol, name, qty, price_minor,
     value_minor, cost_basis_minor, currency, source)
  select
    h.household_id, v_s.account_id, v_period_end, upper(btrim(h.symbol)), h.name, h.qty,
    coalesce(h.price_minor, 0),
    coalesce(h.value_minor, round(coalesce(h.qty,0) * coalesce(h.price_minor,0))::bigint),
    h.cost_basis_minor, coalesce(nullif(h.currency,''), 'USD'), 'statement'
    from public.statement_extraction_holdings h
   where h.household_id = p_household_id
     and h.extraction_id = v_extraction_id
     and h.qty is not null and h.qty > 0
  on conflict (account_id, snapshot_date, symbol, source) do update
    set name = excluded.name, qty = excluded.qty, price_minor = excluded.price_minor,
        value_minor = excluded.value_minor, cost_basis_minor = excluded.cost_basis_minor,
        currency = excluded.currency;

  -- (d) Rebuild CURRENT holdings from the NEWEST non-revoked application. If this
  -- was an OLDER statement, the winner is a different (newer) application and
  -- current does NOT regress. Symbols absent from the winning full statement drop.
  v_winner := public.keel_statement_holdings_rebuild(p_household_id, v_s.account_id);

  v_after := jsonb_build_object(
    'applicationId', v_app_id, 'statementId', v_statement_id,
    'accountId', v_s.account_id, 'periodEnd', v_period_end,
    'approvalTokenId', v_token_id,
    'currentFromApplicationId', v_winner,
    'regressed', (v_winner is distinct from v_app_id)
  );
  v_result := jsonb_build_object(
    'commandId', p_command_id, 'economicEventKey', p_economic_event_key,
    'idempotentReplay', false, 'effects', v_after,
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  );
  perform public.keel_finish_command(
    p_command_id, 'statements.apply_holdings', p_economic_event_key, p_household_id, v_actor,
    v_hash, 'statements.holdings_applied', 'statement', v_statement_id, v_after, v_result
  );
  return v_result;
end;
$$;

-- ===========================================================================
-- 8. keel_cmd_statements_unapply_holdings — revert a prior application (Law 2:
--    undo, never delete). Flip revoked_at/revoked_by, then rebuild current from
--    the prior non-revoked application (or clear statement holdings if none).
-- ===========================================================================
create function public.keel_cmd_statements_unapply_holdings(
  p_command_id uuid,
  p_economic_event_key text,
  p_actor jsonb,
  p_household_id uuid,
  p_payload jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hash text := public.keel_payload_hash(p_payload);
  v_replay jsonb;
  v_actor jsonb;
  v_uid uuid;
  v_app public.statement_holding_applications%rowtype;
  v_winner uuid;
  v_after jsonb;
  v_result jsonb;
begin
  perform public.keel_assert_member_write(p_household_id);
  v_actor := public.keel_actor_from_jwt();
  v_uid := (v_actor->>'userId')::uuid;
  v_replay := public.keel_idempotency_check(p_household_id, p_economic_event_key, v_hash);
  if v_replay is not null then
    return v_replay;
  end if;

  if jsonb_typeof(p_payload) <> 'object'
     or (p_payload - 'statement_id') <> '{}'::jsonb
     or coalesce(p_payload->>'statement_id', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception 'KEEL_INVALID_COMMAND: malformed unapply holdings payload' using errcode = 'P0009';
  end if;

  select * into v_app
    from public.statement_holding_applications
   where household_id = p_household_id
     and statement_id = (p_payload->>'statement_id')::uuid
   for update;
  if not found or not public.keel_recurring_account_access(p_household_id, v_app.account_id, true) then
    raise exception 'KEEL_NOT_FOUND: application' using errcode = 'P0006';
  end if;
  if v_app.revoked_at is not null then
    raise exception 'KEEL_INVALID_COMMAND: application already reverted' using errcode = 'P0009';
  end if;

  update public.statement_holding_applications
     set revoked_at = now(), revoked_by = v_uid
   where household_id = p_household_id and id = v_app.id;

  -- Rebuild current from the prior non-revoked application (Law 2: current is a
  -- projection; reverting the winner falls back to the next-newest, or clears
  -- statement holdings if this was the only one).
  v_winner := public.keel_statement_holdings_rebuild(p_household_id, v_app.account_id);

  v_after := jsonb_build_object(
    'applicationId', v_app.id, 'statementId', v_app.statement_id,
    'accountId', v_app.account_id, 'revoked', true,
    'currentFromApplicationId', v_winner
  );
  v_result := jsonb_build_object(
    'commandId', p_command_id, 'economicEventKey', p_economic_event_key,
    'idempotentReplay', false, 'effects', v_after,
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  );
  perform public.keel_finish_command(
    p_command_id, 'statements.unapply_holdings', p_economic_event_key, p_household_id, v_actor,
    v_hash, 'statements.holdings_unapplied', 'statement', v_app.statement_id, v_after, v_result
  );
  return v_result;
end;
$$;

-- ===========================================================================
-- 9. keel_statement_holdings_diff(household, statement_id) — READ (viewer,
--    account-scoped [A10]). Per-symbol / CUSIP delta between the statement's
--    extracted positions and the account's CURRENT holdings (all sources). A
--    SUGGESTION only (Law 10) — nothing is auto-corrected. Rows carry the current
--    qty/value, the extracted qty/value, and the delta; `state` ∈ added
--    (in statement, not current), removed (in current, not statement), changed,
--    same.
-- ===========================================================================
create function public.keel_statement_holdings_diff(
  p_household_id uuid,
  p_statement_id uuid
) returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_uid uuid := coalesce(
    nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
    nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid;
  v_s public.statements%rowtype;
  v_extraction_id uuid;
  v_current_as_of date;
  v_rows jsonb;
begin
  if v_uid is null then
    raise exception 'KEEL_NOT_AUTHENTICATED' using errcode = 'P0004';
  end if;

  select * into v_s from public.statements
   where household_id = p_household_id and id = p_statement_id;
  if not found or not public.keel_recurring_account_access(p_household_id, v_s.account_id, false) then
    raise exception 'KEEL_SCOPE_VIOLATION: statement not found' using errcode = 'P0006';
  end if;

  -- Extraction for this statement (via the draft), else empty diff.
  select d.extraction_id into v_extraction_id
    from public.statement_drafts d
   where d.household_id = p_household_id and d.statement_id = p_statement_id
     and d.extraction_id is not null
   order by d.decided_at desc nulls last, d.created_at desc
   limit 1;

  -- The account's CURRENT holdings snapshot = rows at max(as_of) (all sources),
  -- matching keel_list_holdings semantics.
  select max(as_of) into v_current_as_of
    from public.holdings
   where household_id = p_household_id and account_id = v_s.account_id;

  with cur as (
    select upper(btrim(h.symbol)) as symbol,
           sum(h.qty) as qty, sum(h.value_minor) as value_minor
      from public.holdings h
     where h.household_id = p_household_id
       and h.account_id = v_s.account_id
       and v_current_as_of is not null
       and h.as_of = v_current_as_of
     group by upper(btrim(h.symbol))
  ),
  ext as (
    select upper(btrim(e.symbol)) as symbol,
           max(e.cusip) as cusip, max(e.isin) as isin, max(e.name) as name,
           sum(e.qty) as qty,
           sum(coalesce(e.value_minor, round(coalesce(e.qty,0)*coalesce(e.price_minor,0))::bigint)) as value_minor
      from public.statement_extraction_holdings e
     where e.household_id = p_household_id
       and v_extraction_id is not null
       and e.extraction_id = v_extraction_id
       and e.qty is not null and e.qty > 0
     group by upper(btrim(e.symbol))
  )
  select coalesce(jsonb_agg(row order by row->>'symbol'), '[]'::jsonb)
    into v_rows
    from (
      select jsonb_build_object(
        'symbol', coalesce(ext.symbol, cur.symbol),
        'cusip', ext.cusip,
        'isin', ext.isin,
        'name', ext.name,
        'currentQty', cur.qty::text,
        'currentValueMinor', cur.value_minor::text,
        'statementQty', ext.qty::text,
        'statementValueMinor', ext.value_minor::text,
        'qtyDelta', (coalesce(ext.qty,0) - coalesce(cur.qty,0))::text,
        'valueDeltaMinor', (coalesce(ext.value_minor,0) - coalesce(cur.value_minor,0))::text,
        'state', case
          when cur.symbol is null then 'added'
          when ext.symbol is null then 'removed'
          when coalesce(ext.qty,0) = coalesce(cur.qty,0)
               and coalesce(ext.value_minor,0) = coalesce(cur.value_minor,0) then 'same'
          else 'changed'
        end
      ) as row
      from ext
      full outer join cur on cur.symbol = ext.symbol
    ) t;

  return jsonb_build_object(
    'scope', jsonb_build_object('householdId', p_household_id, 'statementId', p_statement_id,
                                'accountId', v_s.account_id),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'formulaVersion', 'statement-holdings-diff-v1',
    'currentAsOf', v_current_as_of,
    'hasExtraction', v_extraction_id is not null,
    'rows', v_rows
  );
end;
$$;

-- ===========================================================================
-- 10. Ownership + grants. keel_api needs CREATE on schema public to own a
--     function there (revoked on live) — grant-alter-revoke exactly as the
--     sibling statement migrations do (Slice 5/6/8 hit 'permission denied for
--     schema public' without this wrapper).
-- ===========================================================================
revoke all on function public.keel_statement_holdings_rebuild(uuid, uuid) from public, anon;
revoke all on function public.keel_statement_holdings_apply_payload(uuid, uuid) from public, anon;
revoke all on function public.keel_cmd_statements_issue_holdings_approval(uuid, uuid) from public, anon;
revoke all on function public.keel_cmd_statements_apply_holdings(uuid, text, jsonb, uuid, jsonb) from public, anon;
revoke all on function public.keel_cmd_statements_unapply_holdings(uuid, text, jsonb, uuid, jsonb) from public, anon;
revoke all on function public.keel_statement_holdings_diff(uuid, uuid) from public, anon;

grant create on schema public to keel_api;
alter function public.keel_statement_holdings_rebuild(uuid, uuid) owner to keel_api;
alter function public.keel_statement_holdings_apply_payload(uuid, uuid) owner to keel_api;
alter function public.keel_cmd_statements_issue_holdings_approval(uuid, uuid) owner to keel_api;
alter function public.keel_cmd_statements_apply_holdings(uuid, text, jsonb, uuid, jsonb) owner to keel_api;
alter function public.keel_cmd_statements_unapply_holdings(uuid, text, jsonb, uuid, jsonb) owner to keel_api;
alter function public.keel_statement_holdings_diff(uuid, uuid) owner to keel_api;
revoke create on schema public from keel_api;

-- The internal helpers (rebuild/payload) are never called by clients directly.
grant execute on function public.keel_cmd_statements_issue_holdings_approval(uuid, uuid) to authenticated, keel_api;
grant execute on function public.keel_cmd_statements_apply_holdings(uuid, text, jsonb, uuid, jsonb) to authenticated;
grant execute on function public.keel_cmd_statements_unapply_holdings(uuid, text, jsonb, uuid, jsonb) to authenticated;
grant execute on function public.keel_statement_holdings_diff(uuid, uuid) to authenticated, service_role;

-- Ownership guard: the class-B/definer procs must be owned by keel_api.
do $$
begin
  if exists (
    select 1 from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     join pg_roles r on r.oid = p.proowner
    where n.nspname = 'public'
      and p.proname in ('keel_statement_holdings_rebuild',
                        'keel_statement_holdings_apply_payload',
                        'keel_cmd_statements_issue_holdings_approval',
                        'keel_cmd_statements_apply_holdings',
                        'keel_cmd_statements_unapply_holdings',
                        'keel_statement_holdings_diff')
      and p.prosecdef and r.rolname <> 'keel_api'
  ) then
    raise exception 'KEEL_OWNERSHIP: statement holdings apply owner';
  end if;
end
$$;

-- ===========================================================================
-- 11. Export [A11 / Law 6]: statement_holding_applications joins the audited
--     export contract. No secrets — tenant scope + a link between an
--     already-exported statement/extraction and the token that approved it.
--     INCLUDE entry (packages/exports/src/manifest.ts) + this grant/RLS + the
--     keel_export_household rewrap. The CURRENT outermost wraps
--     keel_export_household_pre_statement_payment_links (Slice 8); rename that to
--     _pre_statement_holding_applications and wrap it.
-- ===========================================================================
grant select on public.statement_holding_applications to keel_export;
create policy statement_holding_applications_export on public.statement_holding_applications
  for select to keel_export using (true);

alter function public.keel_export_household(uuid, timestamptz)
  rename to keel_export_household_pre_statement_holding_applications;
revoke all on function public.keel_export_household_pre_statement_holding_applications(uuid, timestamptz)
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
  v_base := public.keel_export_household_pre_statement_holding_applications(p_household_id, p_as_of);

  select jsonb_build_object(
    'statement_holding_applications', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', a.id, 'household_id', a.household_id,
        'statement_id', a.statement_id, 'extraction_id', a.extraction_id,
        'account_id', a.account_id, 'applied_by', a.applied_by,
        'approval_token_id', a.approval_token_id, 'period_end', a.period_end,
        'revoked_by', a.revoked_by,
        'revoked_at', case when a.revoked_at is null then null else to_char(a.revoked_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end,
        'created_at', to_char(a.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
      ) order by a.id)
      from public.statement_holding_applications a where a.household_id = p_household_id), '[]'::jsonb)
  ) into v_tables;

  return jsonb_set(v_base, '{tables}', (v_base->'tables') || v_tables);
end;
$$;

revoke all on function public.keel_export_household(uuid, timestamptz)
  from public, anon, authenticated, service_role;
grant create on schema public to keel_export;
alter function public.keel_export_household(uuid, timestamptz) owner to keel_export;
revoke create on schema public from keel_export;
grant execute on function public.keel_export_household(uuid, timestamptz) to service_role;
