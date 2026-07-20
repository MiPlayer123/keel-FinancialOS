-- Statement ingestion SLICE 8 (docs/harness/plans/statement-ingestion-v2.md §5
-- [A7], §9, §10 slice 2). Card-payment ↔ statement linking.
--
-- For a LIABILITY (credit-card) statement, deterministically find the card-side
-- payment credit — the inflow that paid the balance down — and link the
-- statement to the transfer that funded it.
--
-- Law 1: the matcher is DETERMINISTIC (exact amount, same currency, sign, and a
--   fixed inclusive date window). No LLM does ledger arithmetic here.
-- Law 7: one authorized domain contract — the suggester runs SECURITY DEFINER
--   with its OWN membership check; decide/detach ride the standard
--   command-envelope ritual (keel_assert_member_write → idempotency →
--   keel_finish_command), the same door web/MCP/support all use.
-- Law 10: card-payment linking is AI class B (suggest→approve). The suggester
--   NEVER auto-confirms; confirm may only RAISE a keel_detect_transfers
--   SUGGESTION (status 'suggested') — it NEVER calls keel_decide_transfer(...,
--   true). The transfer keeps its own approval on the Review page. A 'rejected'
--   link is terminal-for-that-pair and is never re-suggested (on-conflict do
--   nothing).
-- Law 2: reversible — confirm→detach is a status transition, never a delete.
--
-- V1 = EXACT-ONLY per the plan: exact |ending_minor| match; >1 exact candidate
-- ABSTAINS (writes nothing, reason 'ambiguous'). Fuzzy/partial matching and
-- multi-leg splits are a later slice.

-- ---------------------------------------------------------------------------
-- Enum + table
-- ---------------------------------------------------------------------------
create type public.statement_payment_status as enum ('suggested', 'confirmed', 'rejected', 'detached');

-- transfer_links needs a composite tenant unique for the payment-link FK below.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'transfer_links_household_id_id_key'
  ) then
    alter table public.transfer_links add constraint transfer_links_household_id_id_key
      unique (household_id, id);
  end if;
end
$$;

create table public.statement_payment_links (
  household_id uuid not null references public.households (id),
  id uuid not null default gen_random_uuid(),
  statement_id uuid not null,
  -- The card-side payment transaction (the inflow that paid the balance down).
  canonical_transaction_id uuid not null,
  -- The transfer_links row this payment belongs to, when the card-side leg is
  -- already part of a suggested/confirmed transfer. Nullable: a payment can be
  -- linked to a statement without KEEL seeing the funding leg yet.
  transfer_link_id uuid,
  status public.statement_payment_status not null,
  score integer not null,
  matcher_version text not null check (char_length(matcher_version) between 1 and 100),
  reason_codes text[] not null default '{}',
  created_at timestamptz not null default now(),
  decided_by uuid references auth.users (id),
  decided_at timestamptz,
  primary key (household_id, id),
  -- One link row per (statement, card-payment txn). Deliberately NOT a partial
  -- unique on confirmed: partial payments mean a single statement can have
  -- MULTIPLE confirmed payment links (several credits paying one balance).
  unique (household_id, statement_id, canonical_transaction_id),
  constraint fk_payment_link_statement_tenant
    foreign key (household_id, statement_id) references public.statements (household_id, id),
  constraint fk_payment_link_txn_tenant
    foreign key (household_id, canonical_transaction_id)
      references public.canonical_transactions (household_id, id),
  constraint fk_payment_link_transfer_tenant
    foreign key (household_id, transfer_link_id) references public.transfer_links (household_id, id)
);

create index statement_payment_links_statement
  on public.statement_payment_links (household_id, statement_id)
  where status in ('suggested', 'confirmed');
create index statement_payment_links_txn
  on public.statement_payment_links (canonical_transaction_id)
  where status in ('suggested', 'confirmed');

-- ---------------------------------------------------------------------------
-- Lockdown: browser never writes this table; reads/writes go through procs.
-- ---------------------------------------------------------------------------
alter table public.statement_payment_links enable row level security;
revoke all on public.statement_payment_links from public, anon, authenticated;
grant select on public.statement_payment_links to authenticated, service_role;
grant select, insert, update on public.statement_payment_links to keel_api;
create policy statement_payment_links_read on public.statement_payment_links
  for select to authenticated
  using (public.keel_statement_access(household_id, statement_id, false));
create policy statement_payment_links_api on public.statement_payment_links
  for all to keel_api using (true) with check (true);

-- ---------------------------------------------------------------------------
-- keel_statement_suggest_payments(household, statement_id): DETERMINISTIC,
-- SECURITY DEFINER, own membership check. V1 = EXACT-ONLY.
--
-- Candidate = a canonical_transaction on the statement's LIABILITY account whose
-- live cash-side posting is an INFLOW (amount_minor > 0 — a payment reducing the
-- balance), SAME currency as the statement, status ∈ posted|reviewed and not
-- voided, effective_date within [period_end, period_end + 35 days] INCLUSIVE on
-- both ends, matching the EXACT |ending_minor| only.
--
--   score = 100 (exact).
--   TIE-BREAK order (prefer a candidate already in a transfer_links pair →
--     nearest date → lowest txn id) is defined for provenance. AMBIGUITY: when
--     >1 exact candidate exists we ABSTAIN (write nothing, reason 'ambiguous')
--     rather than auto-pick — a class-B suggestion the user cannot disambiguate
--     at a glance is noise. We only auto-suggest when exactly ONE exact match.
--   When exactly one candidate: reason_codes = {'exact_amount'} plus
--     'transfer_pair' if the card-side txn is already in a suggested/confirmed
--     transfer_links pair, plus 'date_proximity' when the payment lands within
--     10 days of period_end. transfer_link_id is bound from that pair if present.
--   NEVER resurrect a 'rejected' link (unique + on-conflict do nothing).
--   NEVER auto-confirm (always inserts status 'suggested').
-- Returns the number of NEW suggestions written (0 or 1).
-- ---------------------------------------------------------------------------
create function public.keel_statement_suggest_payments(
  p_household_id uuid,
  p_statement_id uuid
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_s public.statements%rowtype;
  v_is_liability boolean;
  v_target bigint;
  v_count int;
  v_candidate uuid;
  v_transfer uuid;
  v_gap int;
  v_reasons text[];
  v_written int := 0;
begin
  -- Own membership check (service cron path carries no user claim).
  if auth.uid() is not null and not exists (
    select 1 from public.household_memberships
    where household_id = p_household_id and user_id = auth.uid()
  ) then
    raise exception 'KEEL_NOT_FOUND' using errcode = 'P0006';
  end if;

  select * into v_s from public.statements
   where household_id = p_household_id and id = p_statement_id;
  if not found then
    raise exception 'KEEL_NOT_FOUND: statement' using errcode = 'P0006';
  end if;

  -- Liability (credit-card) only — the canonical signal is the backing ledger
  -- account's kind, not the display subtype string.
  select la.kind = 'liability' into v_is_liability
    from public.accounts a
    join public.ledger_accounts la on la.id = a.ledger_account_id
   where a.household_id = p_household_id and a.id = v_s.account_id;
  if not coalesce(v_is_liability, false) then
    return 0;
  end if;

  -- |ending_minor| — the balance the payment(s) settle. A zero-balance
  -- statement has nothing to pay off.
  v_target := abs(v_s.ending_minor);
  if v_target = 0 then
    return 0;
  end if;

  -- Count exact candidates: card-side inflows on the liability account, same
  -- currency, non-void posted/reviewed, in [period_end, period_end+35d]
  -- INCLUSIVE, whose absolute cash amount equals |ending_minor| exactly.
  with candidates as (
    select ct.id as txn_id
      from public.canonical_transactions ct
      join public.journal_batches jb
        on jb.canonical_transaction_id = ct.id and jb.reverses_batch_id is null
       and not exists (
         select 1 from public.journal_revisions rev where rev.original_batch_id = jb.id
       )
      join public.journal_postings p on p.batch_id = jb.id
      join public.ledger_accounts la
        on la.id = p.ledger_account_id and la.is_category = false
      join public.accounts acc on acc.ledger_account_id = la.id
     where ct.household_id = p_household_id
       and acc.id = v_s.account_id
       and ct.voided_at is null
       and ct.status in ('posted', 'reviewed')
       and p.currency = v_s.currency
       and p.amount_minor > 0                                  -- card-side INFLOW
       and abs(p.amount_minor) = v_target                      -- exact
       and ct.effective_date >= v_s.period_end                 -- window start (inclusive)
       and ct.effective_date <= v_s.period_end + interval '35 days'  -- window end (inclusive)
  )
  select count(*) into v_count from candidates;

  -- AMBIGUITY: more than one exact candidate → ABSTAIN. Write nothing; the
  -- "Find payment" UI reports this as ambiguous.
  if v_count = 0 then
    return 0;
  end if;
  if v_count > 1 then
    insert into public.audit_log (household_id, actor, action, object_type, object_id, after)
    values (p_household_id,
            case when auth.uid() is null
                 then jsonb_build_object('kind', 'system', 'source', 'statement_payment_matcher')
                 else jsonb_build_object('kind', 'user', 'userId', auth.uid()) end,
            'statements.payment_abstained', 'statement', p_statement_id,
            jsonb_build_object('reason', 'ambiguous', 'candidateCount', v_count));
    return 0;
  end if;

  -- Exactly one exact candidate. Resolve it + its transfer pair (if any),
  -- ordering by the documented tie-break (moot with one candidate, but explicit
  -- for reproducibility): transfer pair first → nearest date → lowest txn id.
  select c.txn_id, c.transfer_link_id, c.date_gap
    into v_candidate, v_transfer, v_gap
    from (
      select ct.id as txn_id,
             (select tl.id from public.transfer_links tl
               where tl.household_id = p_household_id
                 and tl.status in ('suggested', 'confirmed')
                 and (tl.txn_out = ct.id or tl.txn_in = ct.id)
               order by tl.created_at, tl.id limit 1) as transfer_link_id,
             abs(ct.effective_date - v_s.period_end) as date_gap
        from public.canonical_transactions ct
        join public.journal_batches jb
          on jb.canonical_transaction_id = ct.id and jb.reverses_batch_id is null
         and not exists (
           select 1 from public.journal_revisions rev where rev.original_batch_id = jb.id
         )
        join public.journal_postings p on p.batch_id = jb.id
        join public.ledger_accounts la
          on la.id = p.ledger_account_id and la.is_category = false
        join public.accounts acc on acc.ledger_account_id = la.id
       where ct.household_id = p_household_id
         and acc.id = v_s.account_id
         and ct.voided_at is null
         and ct.status in ('posted', 'reviewed')
         and p.currency = v_s.currency
         and p.amount_minor > 0
         and abs(p.amount_minor) = v_target
         and ct.effective_date >= v_s.period_end
         and ct.effective_date <= v_s.period_end + interval '35 days'
       order by (transfer_link_id is not null) desc, date_gap, ct.id
       limit 1
    ) c;

  -- Build reason_codes. NB: the appended literal MUST be cast to text — an
  -- untyped literal makes Postgres resolve `||` as string concat (not
  -- array-append) and fail with "malformed array literal".
  v_reasons := array['exact_amount'];
  if v_transfer is not null then
    v_reasons := v_reasons || 'transfer_pair'::text;
  end if;
  if v_gap <= 10 then                                           -- date_proximity: within 10d of period_end
    v_reasons := v_reasons || 'date_proximity'::text;
  end if;

  insert into public.statement_payment_links
    (household_id, statement_id, canonical_transaction_id, transfer_link_id,
     status, score, matcher_version, reason_codes)
  values
    (p_household_id, p_statement_id, v_candidate, v_transfer,
     'suggested', 100, 'statement-payment-exact-v1', v_reasons)
  on conflict (household_id, statement_id, canonical_transaction_id) do nothing;
  get diagnostics v_written = row_count;

  if v_written > 0 then
    insert into public.audit_log (household_id, actor, action, object_type, object_id, after)
    values (p_household_id,
            case when auth.uid() is null
                 then jsonb_build_object('kind', 'system', 'source', 'statement_payment_matcher')
                 else jsonb_build_object('kind', 'user', 'userId', auth.uid()) end,
            'statements.payment_suggested', 'statement', p_statement_id,
            jsonb_build_object('transactionId', v_candidate, 'transferLinkId', v_transfer,
                               'score', 100, 'reasonCodes', to_jsonb(v_reasons)));
  end if;

  return v_written;
end;
$$;

-- ---------------------------------------------------------------------------
-- keel_cmd_statements_decide_payment_link: user command (partner authz). Confirm
-- or reject a suggested card-payment link. Full command-envelope ritual.
--
-- On CONFIRM: flip 'suggested' → 'confirmed'. If the card-side txn is NOT yet in
-- an active transfer pair, RAISE a transfer-detector pass so a funding-leg
-- suggestion can appear on the Review page — but NEVER auto-confirm that
-- transfer (Law 10). If the detector produced a pair for our txn, bind its
-- transfer_link_id onto the payment link. The transfer's own confirm command is
-- NEVER invoked from here.
-- On REJECT: flip 'suggested' → 'rejected' (terminal; never re-suggested).
-- ---------------------------------------------------------------------------
create function public.keel_cmd_statements_decide_payment_link(
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
  v_link public.statement_payment_links%rowtype;
  v_confirm boolean := (p_payload->>'confirm')::boolean;
  v_uid uuid;
  v_transfer uuid;
  v_result jsonb;
begin
  perform public.keel_assert_member_write(p_household_id);
  p_actor := public.keel_actor_from_jwt();
  v_uid := (p_actor->>'userId')::uuid;
  v_replay := public.keel_idempotency_check(p_household_id, p_economic_event_key, v_hash);
  if v_replay is not null then
    return v_replay;
  end if;

  if jsonb_typeof(p_payload) <> 'object'
     or (p_payload - 'linkId' - 'confirm') <> '{}'::jsonb
     or coalesce(p_payload->>'confirm', '') not in ('true', 'false') then
    raise exception 'KEEL_INVALID_COMMAND: malformed decide payment link' using errcode = 'P0009';
  end if;

  select * into v_link
    from public.statement_payment_links
   where id = (p_payload->>'linkId')::uuid and household_id = p_household_id
   for update;
  if not found then
    raise exception 'KEEL_NOT_FOUND: payment link' using errcode = 'P0006';
  end if;
  if v_link.status <> 'suggested' then
    raise exception 'KEEL_INVALID_COMMAND: payment link already decided' using errcode = 'P0009';
  end if;

  v_transfer := v_link.transfer_link_id;

  if v_confirm then
    -- If the card-side leg is not already in an active transfer pair, run the
    -- deterministic transfer detector so a funding-leg SUGGESTION can surface on
    -- the Review page. This never confirms a transfer — the detector writes
    -- status 'suggested' only, and the transfer keeps its own separate approval.
    if v_transfer is null then
      perform public.keel_detect_transfers(p_household_id);
      select tl.id into v_transfer
        from public.transfer_links tl
       where tl.household_id = p_household_id
         and tl.status in ('suggested', 'confirmed')
         and (tl.txn_out = v_link.canonical_transaction_id
              or tl.txn_in = v_link.canonical_transaction_id)
       order by tl.created_at, tl.id
       limit 1;
    end if;

    update public.statement_payment_links
       set status = 'confirmed', transfer_link_id = v_transfer,
           decided_by = v_uid, decided_at = now()
     where household_id = p_household_id and id = v_link.id;
  else
    update public.statement_payment_links
       set status = 'rejected', decided_by = v_uid, decided_at = now()
     where household_id = p_household_id and id = v_link.id;
  end if;

  v_result := jsonb_build_object(
    'commandId', p_command_id, 'economicEventKey', p_economic_event_key,
    'idempotentReplay', false,
    'effects', jsonb_build_object(
      'linkId', v_link.id,
      'status', case when v_confirm then 'confirmed' else 'rejected' end,
      'transferLinkId', v_transfer
    ),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  );
  perform public.keel_finish_command(
    p_command_id, 'statements.decide_payment_link', p_economic_event_key, p_household_id, p_actor,
    v_hash,
    case when v_confirm then 'statements.payment_confirmed' else 'statements.payment_rejected' end,
    'statement_payment_link', v_link.id,
    jsonb_build_object('status', case when v_confirm then 'confirmed' else 'rejected' end,
                       'transferLinkId', v_transfer),
    v_result
  );
  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- keel_cmd_statements_detach_payment_link: user command (partner authz). Undo a
-- CONFIRMED payment link — flip 'confirmed' → 'detached' (Law 2: undo, never
-- delete). Leaves the transfer_link untouched (it keeps its own lifecycle).
-- ---------------------------------------------------------------------------
create function public.keel_cmd_statements_detach_payment_link(
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
  v_link public.statement_payment_links%rowtype;
  v_uid uuid;
  v_result jsonb;
begin
  perform public.keel_assert_member_write(p_household_id);
  p_actor := public.keel_actor_from_jwt();
  v_uid := (p_actor->>'userId')::uuid;
  v_replay := public.keel_idempotency_check(p_household_id, p_economic_event_key, v_hash);
  if v_replay is not null then
    return v_replay;
  end if;

  if jsonb_typeof(p_payload) <> 'object'
     or (p_payload - 'linkId') <> '{}'::jsonb then
    raise exception 'KEEL_INVALID_COMMAND: malformed detach payment link' using errcode = 'P0009';
  end if;

  select * into v_link
    from public.statement_payment_links
   where id = (p_payload->>'linkId')::uuid and household_id = p_household_id
   for update;
  if not found then
    raise exception 'KEEL_NOT_FOUND: payment link' using errcode = 'P0006';
  end if;
  if v_link.status <> 'confirmed' then
    raise exception 'KEEL_INVALID_COMMAND: only a confirmed payment link can be detached' using errcode = 'P0009';
  end if;

  update public.statement_payment_links
     set status = 'detached', decided_by = v_uid, decided_at = now()
   where household_id = p_household_id and id = v_link.id;

  v_result := jsonb_build_object(
    'commandId', p_command_id, 'economicEventKey', p_economic_event_key,
    'idempotentReplay', false,
    'effects', jsonb_build_object('linkId', v_link.id, 'status', 'detached'),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  );
  perform public.keel_finish_command(
    p_command_id, 'statements.detach_payment_link', p_economic_event_key, p_household_id, p_actor,
    v_hash, 'statements.payment_detached', 'statement_payment_link', v_link.id,
    jsonb_build_object('status', 'detached'), v_result
  );
  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- keel_list_statement_payment_links(household, statement_id): user READ. The
-- active/decided payment links for one statement, with the card-side txn's
-- display data. Fail-closed auth via keel_statement_access.
-- ---------------------------------------------------------------------------
create function public.keel_list_statement_payment_links(
  p_household_id uuid,
  p_statement_id uuid
) returns jsonb
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
  if not public.keel_statement_access(p_household_id, p_statement_id, false) then
    raise exception 'KEEL_SCOPE_VIOLATION' using errcode = 'P0006';
  end if;

  select coalesce(jsonb_agg(row order by row->>'status', row->>'txnDate' desc, row->>'linkId'), '[]'::jsonb)
    into v_rows
    from (
      select jsonb_build_object(
        'linkId', pl.id,
        'status', pl.status,
        'score', pl.score,
        'reasonCodes', to_jsonb(pl.reason_codes),
        'matcherVersion', pl.matcher_version,
        'transferLinkId', pl.transfer_link_id,
        'transactionId', pl.canonical_transaction_id,
        'txnDate', to_char(ct.effective_date, 'YYYY-MM-DD'),
        'txnDescription', left(coalesce(tov.display_description, ct.description), 140),
        'txnAmountMinor', p.amount_minor::text,
        'currency', p.currency
      ) as row
      from public.statement_payment_links pl
      join public.canonical_transactions ct on ct.id = pl.canonical_transaction_id
      join public.journal_batches jb
        on jb.canonical_transaction_id = ct.id and jb.reverses_batch_id is null
       and not exists (
         select 1 from public.journal_revisions rev where rev.original_batch_id = jb.id
       )
      join public.journal_postings p on p.batch_id = jb.id
      join public.ledger_accounts la on la.id = p.ledger_account_id and la.is_category = false
      left join public.transaction_overrides tov on tov.canonical_transaction_id = ct.id
      where pl.household_id = p_household_id
        and pl.statement_id = p_statement_id
        and pl.status in ('suggested', 'confirmed')
    ) t;

  return jsonb_build_object(
    'scope', jsonb_build_object('householdId', p_household_id, 'statementId', p_statement_id),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'formulaVersion', 'statement-payment-links-v1',
    'rows', v_rows
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Ownership + grants. User procs owned by keel_api (fail-closed inside),
-- authenticated execute. The suggester is user+service (Find-payment button and
-- future cron), authenticated + service_role execute.
--
-- keel_api needs CREATE on schema public to own a function there (revoked on
-- live — local-vs-live grant drift); grant-alter-revoke exactly as the sibling
-- statement migrations do. keel_grant_create_reassign does NOT exist on live.
-- ---------------------------------------------------------------------------
revoke all on function public.keel_statement_suggest_payments(uuid, uuid) from public, anon;
revoke all on function public.keel_cmd_statements_decide_payment_link(uuid, text, jsonb, uuid, jsonb) from public, anon;
revoke all on function public.keel_cmd_statements_detach_payment_link(uuid, text, jsonb, uuid, jsonb) from public, anon;
revoke all on function public.keel_list_statement_payment_links(uuid, uuid) from public, anon;

grant create on schema public to keel_api;
alter function public.keel_statement_suggest_payments(uuid, uuid) owner to keel_api;
alter function public.keel_cmd_statements_decide_payment_link(uuid, text, jsonb, uuid, jsonb) owner to keel_api;
alter function public.keel_cmd_statements_detach_payment_link(uuid, text, jsonb, uuid, jsonb) owner to keel_api;
alter function public.keel_list_statement_payment_links(uuid, uuid) owner to keel_api;
revoke create on schema public from keel_api;

grant execute on function public.keel_statement_suggest_payments(uuid, uuid) to authenticated, service_role;
grant execute on function public.keel_cmd_statements_decide_payment_link(uuid, text, jsonb, uuid, jsonb) to authenticated;
grant execute on function public.keel_cmd_statements_detach_payment_link(uuid, text, jsonb, uuid, jsonb) to authenticated;
grant execute on function public.keel_list_statement_payment_links(uuid, uuid) to authenticated;

-- Ownership guard: the class-B/definer procs must be owned by keel_api.
do $$
begin
  if exists (
    select 1 from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     join pg_roles r on r.oid = p.proowner
    where n.nspname = 'public'
      and p.proname in ('keel_statement_suggest_payments',
                        'keel_cmd_statements_decide_payment_link',
                        'keel_cmd_statements_detach_payment_link',
                        'keel_list_statement_payment_links')
      and p.prosecdef and r.rolname <> 'keel_api'
  ) then
    raise exception 'KEEL_OWNERSHIP: statement payment link owner';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Export [A11 / Law 6]: statement_payment_links joins the audited export
-- contract. No secrets — tenant scope + a link between an already-exported
-- statement and an already-exported canonical transaction. INCLUDE entry
-- (packages/exports/src/manifest.ts) + this keel_export grant/RLS + the rewrap.
-- The CURRENT outermost keel_export_household wraps
-- keel_export_household_pre_statement_outbox (Slice 6); we rename this current
-- outermost to _pre_statement_payment_links and wrap it.
-- ---------------------------------------------------------------------------
grant select on public.statement_payment_links to keel_export;
create policy statement_payment_links_export on public.statement_payment_links
  for select to keel_export using (true);

alter function public.keel_export_household(uuid, timestamptz)
  rename to keel_export_household_pre_statement_payment_links;
revoke all on function public.keel_export_household_pre_statement_payment_links(uuid, timestamptz)
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
  v_base := public.keel_export_household_pre_statement_payment_links(p_household_id, p_as_of);

  select jsonb_build_object(
    'statement_payment_links', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', pl.id, 'household_id', pl.household_id,
        'statement_id', pl.statement_id,
        'canonical_transaction_id', pl.canonical_transaction_id,
        'transfer_link_id', pl.transfer_link_id,
        'status', pl.status::text, 'score', pl.score,
        'matcher_version', pl.matcher_version,
        'reason_codes', to_jsonb(pl.reason_codes),
        'decided_by', pl.decided_by,
        'decided_at', case when pl.decided_at is null then null else to_char(pl.decided_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end,
        'created_at', to_char(pl.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
      ) order by pl.id)
      from public.statement_payment_links pl where pl.household_id = p_household_id), '[]'::jsonb)
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
