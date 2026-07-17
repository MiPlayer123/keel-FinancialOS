-- Categorization review loop (P0-B core — design/TEARDOWN-STATUS-2026-07-17.md
-- queue item 1). Auto-categorization today is a SILENT class-A write: PFC
-- mapping (keel_autocategorize_household) and rules (keel_apply_rules) file
-- transactions with no visible suggest→approve step. Law 2 / Law 10 put
-- category assignment in class B (suggest+approve), so this migration makes
-- the loop real:
--
--   1. category_suggestions — typed suggestion records (Law 11: source,
--      reason_code, evidence; TLDR on the card, proof in the Why panel).
--      Append-ish: rows are inserted by detection and their status advances
--      exactly once (suggested → accepted|dismissed) via the decision command
--      below — no other writer.
--   2. keel_detect_category_suggestions — DETERMINISTIC detection (Law 1, no
--      LLM): for transactions whose current effective category is still
--      machine-defaulted (an Uncategorized landing pad, or an overlay the PFC
--      mapper wrote), propose the category a user rule or the PFC mapping
--      would file it under. User rules beat PFC (the precedence lattice of
--      20260713040000); the current category is never re-suggested; work per
--      call is capped. Suggestions change NOTHING until approved.
--   3. keel_cmd_decide_category_suggestion — full command envelope (Law 2
--      audited, Law 9 idempotent, scope-safe). Accept applies the overlay
--      through the same upsert effect as keel_categorize_transaction
--      (20260713100000 §5a) with source='user' — an approval is a USER
--      decision, so no later rule/PFC pass can silently overwrite it.
--   4. keel_list_category_suggestions — read model joining display data for
--      the Review page cards.
--
-- Settled classifications (overlay source 'user' or 'rule') are never
-- re-litigated by detection: 'user' is a human decision; 'rule' rows were
-- created by the user-initiated preview→confirm apply flow.

-- ---------------------------------------------------------------------------
-- 1. Table + RLS/grants (house ritual: member read for authenticated,
-- whole-table policy for the keel_api definer role — a grant alone yields
-- ZERO rows for keel_api because it is non-BYPASSRLS; see the
-- balance_snapshots comment in 20260717120000).
-- ---------------------------------------------------------------------------
create table public.category_suggestions (
  id                                   uuid primary key default gen_random_uuid(),
  household_id                         uuid not null references public.households (id),
  canonical_transaction_id             uuid not null references public.canonical_transactions (id),
  suggested_category_ledger_account_id uuid not null references public.ledger_accounts (id),
  source                               text not null check (source in ('pfc', 'rule')),
  reason_code                          text not null check (char_length(reason_code) between 1 and 40),
  -- Machine-readable proof refs only (rule id/pattern, PFC key) — NEVER raw
  -- provider payloads or secrets. The read model joins display data live.
  evidence                             jsonb not null default '{}'::jsonb,
  status                               text not null default 'suggested'
    check (status in ('suggested', 'accepted', 'dismissed')),
  created_at                           timestamptz not null default now(),
  decided_at                           timestamptz,
  decided_by                           uuid references auth.users (id),
  check (
    (status = 'suggested' and decided_by is null and decided_at is null)
    or (status in ('accepted', 'dismissed') and decided_at is not null)
  ),
  -- Idempotent re-detection: the same proposal is one row forever; a decided
  -- row keeps its slot so a dismissed suggestion is never re-raised.
  unique (household_id, canonical_transaction_id, suggested_category_ledger_account_id, source)
);
create index category_suggestions_household_status
  on public.category_suggestions (household_id, status);

revoke all on public.category_suggestions from anon, authenticated;
grant select on public.category_suggestions to authenticated;
grant select, insert, update on public.category_suggestions to keel_api;
-- Tables created after 210500's catch-all grant need an explicit service_role
-- re-grant (same note as transfer_links in 20260710210700).
grant select on public.category_suggestions to service_role;
alter table public.category_suggestions enable row level security;
create policy category_suggestions_member_read on public.category_suggestions
  for select to authenticated using (public.keel_is_household_member(household_id));
create policy category_suggestions_api_all on public.category_suggestions
  for all to keel_api using (true) with check (true);

-- Detection reads user rules; keel_api has no grant on category_rules yet
-- (its writers are user-JWT definer procs owned by the migration role).
-- Grant + policy pair, per the house ritual.
grant select on public.category_rules to keel_api;
create policy category_rules_api_read on public.category_rules
  for select to keel_api using (true);

-- ---------------------------------------------------------------------------
-- 2. Detection (deterministic, Law 1). Mirrors keel_detect_transfers'
-- auth posture: a user-driven call requires membership; the service path
-- (auth.uid() null) is for the api function's future cron/worker use.
-- ---------------------------------------------------------------------------
create function public.keel_detect_category_suggestions(p_household_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  if auth.uid() is not null and not exists (
    select 1 from public.household_memberships
    where household_id = p_household_id and user_id = auth.uid()
  ) then
    raise exception 'KEEL_NOT_FOUND' using errcode = 'P0006';
  end if;

  with targets as (
    -- Single-offset, live-batch, non-voided transactions whose current
    -- EFFECTIVE category is still machine-defaulted: parked on an
    -- Uncategorized landing pad (whatever wrote it there), or carrying an
    -- overlay the PFC mapper auto-applied. 'user'/'rule' overlays pointing at
    -- real categories are settled decisions — never re-litigated.
    select ct.id as txn_id, ct.description, offp.entity_id,
           offcat.kind as txn_kind,
           coalesce(tc.category_ledger_account_id, offcat.id) as current_cat
      from public.canonical_transactions ct
      join public.journal_batches jb
        on jb.canonical_transaction_id = ct.id and jb.reverses_batch_id is null
       and not exists (
         select 1 from public.journal_revisions rev where rev.original_batch_id = jb.id
       )
      join public.journal_postings offp on offp.batch_id = jb.id
      join public.ledger_accounts offcat
        on offcat.id = offp.ledger_account_id and offcat.is_category = true
      left join public.transaction_categories tc on tc.canonical_transaction_id = ct.id
      left join public.ledger_accounts cur on cur.id = tc.category_ledger_account_id
      where ct.household_id = p_household_id
        and ct.voided_at is null
        -- Single-offset only: split transactions are categorized by their
        -- splits (20260713100000 §5).
        and (
          select count(*) from public.journal_postings p2
          join public.ledger_accounts l2 on l2.id = p2.ledger_account_id and l2.is_category
          where p2.batch_id = jb.id
        ) = 1
        and (
          (case when tc.canonical_transaction_id is not null
                then cur.pfc_key else offcat.pfc_key end)
            in ('uncategorized_expense', 'uncategorized_income')
          or tc.source = 'plaid_pfc'
        )
  ),
  rule_winners as (
    -- Deterministic winner per transaction: lowest (priority, created_at, id)
    -- among matching rules — same lattice as keel_apply_rules. Kind- and
    -- entity-safe; matched against the IMMUTABLE provider description.
    select distinct on (t.txn_id)
           t.txn_id, r.id as rule_id, r.pattern,
           r.category_ledger_account_id as cat_id
      from targets t
      join public.category_rules r
        on r.household_id = p_household_id
       and r.active
       and r.category_ledger_account_id is not null
       and position(lower(r.pattern) in lower(t.description)) > 0
      join public.ledger_accounts rc
        on rc.id = r.category_ledger_account_id
       and rc.is_category = true and rc.archived_at is null
       and rc.entity_id = t.entity_id
       and rc.kind = t.txn_kind
      order by t.txn_id, r.priority, r.created_at, r.id
  ),
  pfc as (
    -- Latest PFC primary per provider transaction (same extraction as
    -- keel_autocategorize_household, 20260713090000 §5).
    select distinct on (elem->>'transaction_id')
           elem->>'transaction_id' as ptid,
           coalesce(elem->'personal_finance_category'->>'primary', '') as primary
      from public.raw_provider_events r
      cross join lateral jsonb_array_elements(
        coalesce(r.body_text::jsonb->'added', '[]'::jsonb)) elem
      where r.household_id = p_household_id
        and (r.body_text::jsonb) ? 'added'
      order by elem->>'transaction_id', r.received_at desc
  ),
  pfc_proposals as (
    -- ONE proposal per transaction (adversarial review P2-1): a canonical
    -- transaction can carry several source links (pending + posted records
    -- with different PFC primaries), which would fan out into contradictory
    -- pending cards. Deterministic winner: posted record first, then the
    -- newest normalized record, then id.
    select distinct on (t.txn_id)
           t.txn_id, pfc.primary as pfc_primary,
           cat.pfc_key as cat_key, cat.id as cat_id
      from targets t
      join public.transaction_source_links tsl on tsl.canonical_transaction_id = t.txn_id
      join public.normalized_source_records nsr on nsr.id = tsl.normalized_source_record_id
      join pfc on pfc.ptid = nsr.provider_transaction_id
      join public.ledger_accounts cat
        on cat.entity_id = t.entity_id
       and cat.pfc_key = public.keel_pfc_to_category_key(pfc.primary, t.txn_kind)
       and cat.is_category = true and cat.kind = t.txn_kind and cat.archived_at is null
      -- Precedence: user rules beat PFC — a transaction with a rule proposal
      -- never also gets a PFC proposal.
      where not exists (select 1 from rule_winners w where w.txn_id = t.txn_id)
      order by t.txn_id, nsr.pending asc, nsr.created_at desc, nsr.id
  ),
  proposals as (
    select w.txn_id, w.cat_id, 'rule'::text as source, 'rule_match'::text as reason_code,
           jsonb_build_object('ruleId', w.rule_id, 'pattern', w.pattern,
                              'matchedField', 'description') as evidence
      from rule_winners w
    union all
    select p.txn_id, p.cat_id, 'pfc', 'pfc_mapping',
           jsonb_build_object('pfcPrimary', p.pfc_primary, 'pfcKey', p.cat_key)
      from pfc_proposals p
  )
  insert into public.category_suggestions
    (household_id, canonical_transaction_id, suggested_category_ledger_account_id,
     source, reason_code, evidence)
  select p_household_id, pr.txn_id, pr.cat_id, pr.source, pr.reason_code, pr.evidence
    from proposals pr
    join targets t on t.txn_id = pr.txn_id
    -- Never suggest what the transaction already effectively carries.
    where pr.cat_id <> t.current_cat
    -- Only genuinely-NEW proposals may consume LIMIT slots (adversarial
    -- review P1-1): the LIMIT applies before ON CONFLICT, so without this
    -- anti-join on the full unique key, existing pending/dismissed rows
    -- permanently occupy the deterministic ordered prefix and rows 201+
    -- would never be suggested. ON CONFLICT stays as the concurrency
    -- backstop for two detection passes racing.
    and not exists (
      select 1 from public.category_suggestions cs
      where cs.household_id = p_household_id
        and cs.canonical_transaction_id = pr.txn_id
        and cs.suggested_category_ledger_account_id = pr.cat_id
        and cs.source = pr.source
    )
    order by pr.txn_id, pr.source
    limit 200  -- bound one detection pass; the next call picks up the rest
  on conflict (household_id, canonical_transaction_id,
               suggested_category_ledger_account_id, source) do nothing;
  get diagnostics v_count = row_count;

  if v_count > 0 then
    insert into public.audit_log (household_id, actor, action, object_type, object_id, after)
    values (p_household_id,
            case when auth.uid() is null
                 then jsonb_build_object('kind', 'system', 'source', 'categorization_detector')
                 else jsonb_build_object('kind', 'user', 'userId', auth.uid()) end,
            'categorization.detect', 'household', p_household_id,
            jsonb_build_object('suggested', v_count));
  end if;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Read model for the Review page (envelope shape; mirrors
-- keel_list_transfers). Pending suggestions only — decided ones live on in
-- the ledger, the audit log, and the suggestion row itself.
-- ---------------------------------------------------------------------------
create function public.keel_list_category_suggestions(p_household_id uuid)
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

  select coalesce(jsonb_agg(row order by row->>'effectiveDate' desc, row->>'suggestionId'), '[]'::jsonb)
    into v_rows
    from (
      select jsonb_build_object(
        'suggestionId', s.id,
        'status', s.status,
        'source', s.source,
        'reasonCode', s.reason_code,
        'evidence', s.evidence,
        'canonicalTransactionId', ct.id,
        'effectiveDate', ct.effective_date,
        'description', left(coalesce(tov.display_description, rr.display_name, ct.description), 140),
        'originalDescription', left(ct.description, 140),
        'accountName', acc.name,
        'amountMinor', cashp.amount_minor::text,
        'currency', cashp.currency,
        'suggestedCategoryLedgerAccountId', sc.id,
        'suggestedCategoryName', sc.name,
        'suggestedCategoryKind', sc.kind,
        'currentCategoryName', coalesce(cur.name, offcat.name),
        -- FROZEN as-detected pattern (Law 9: the reason line must describe
        -- the match that actually produced this suggestion, not the rule's
        -- present-day text — adversarial review P2-2). The live pattern rides
        -- separately for the Why panel's "rule as of now" line only.
        'rulePattern', s.evidence->>'pattern',
        'ruleLivePattern', r.pattern
      ) as row
      from public.category_suggestions s
      join public.canonical_transactions ct on ct.id = s.canonical_transaction_id
      join public.journal_batches jb
        on jb.canonical_transaction_id = ct.id and jb.reverses_batch_id is null
       and not exists (
         select 1 from public.journal_revisions rev where rev.original_batch_id = jb.id
       )
      join public.journal_postings cashp on cashp.batch_id = jb.id
      join public.ledger_accounts cashla
        on cashla.id = cashp.ledger_account_id and cashla.is_category = false
      join public.accounts acc on acc.ledger_account_id = cashla.id
      join public.journal_postings offp on offp.batch_id = jb.id and offp.id <> cashp.id
      join public.ledger_accounts offcat
        on offcat.id = offp.ledger_account_id and offcat.is_category = true
      join public.ledger_accounts sc on sc.id = s.suggested_category_ledger_account_id
      left join public.transaction_categories tc on tc.canonical_transaction_id = ct.id
      left join public.ledger_accounts cur on cur.id = tc.category_ledger_account_id
      left join public.transaction_overrides tov on tov.canonical_transaction_id = ct.id
      left join public.rule_renames rr on rr.canonical_transaction_id = ct.id
      left join public.category_rules r on r.id = (s.evidence->>'ruleId')::uuid
      where s.household_id = p_household_id
        and s.status = 'suggested'
        and ct.voided_at is null
        -- Settled classifications drop off the Review page (adversarial
        -- review P1-2b): once the transaction's effective category is no
        -- longer machine-defaulted (user or rule filed it on a real
        -- category), the pending suggestion is stale — same predicate as
        -- detection targeting and the decide-accept guard.
        and (
          (case when tc.canonical_transaction_id is not null
                then cur.pfc_key else offcat.pfc_key end)
            in ('uncategorized_expense', 'uncategorized_income')
          or tc.source = 'plaid_pfc'
        )
    ) t;

  return jsonb_build_object(
    'scope', jsonb_build_object('householdId', p_household_id),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'formulaVersion', 'category-suggestions-v1',
    'rows', v_rows
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Decision command — full envelope (modeled on keel_cmd_reanchor_balance /
-- keel_cmd_manual_transaction). Payload (post-toSnakeKeys):
--   { suggestion_id, accept: true|false }
-- Accept applies the overlay through the SAME effect as the user-initiated
-- keel_categorize_transaction (20260713100000 §5a): single-offset live batch,
-- same-entity live category, upsert with source='user'. Dismiss records the
-- decision and touches nothing else.
-- ---------------------------------------------------------------------------
create function public.keel_cmd_decide_category_suggestion(
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
  v_suggestion public.category_suggestions%rowtype;
  v_accept boolean;
  v_entity uuid;
  v_offsets int;
  v_offset_pfc text;
  v_overlay_source text;
  v_overlay_pfc text;
  v_cat public.ledger_accounts%rowtype;
  v_old uuid;
  v_new_status text;
  v_result jsonb;
begin
  perform public.keel_assert_member_write(p_household_id);
  p_actor := public.keel_actor_from_jwt();  -- ignore caller-supplied actor (forgery guard)
  v_replay := public.keel_idempotency_check(p_household_id, p_economic_event_key, v_hash);
  if v_replay is not null then
    return v_replay;
  end if;

  if coalesce(p_payload->>'suggestion_id', '') = '' then
    raise exception 'KEEL_INVALID_COMMAND: suggestion_id is required' using errcode = 'P0009';
  end if;
  if jsonb_typeof(p_payload->'accept') <> 'boolean' then
    raise exception 'KEEL_INVALID_COMMAND: accept must be a boolean' using errcode = 'P0009';
  end if;
  v_accept := (p_payload->>'accept')::boolean;

  -- Scope safety: the suggestion must belong to the commanding household.
  -- FOR UPDATE serializes two concurrent decisions with different keys; the
  -- second then sees a decided status and fails typed.
  select * into v_suggestion
    from public.category_suggestions
    where id = (p_payload->>'suggestion_id')::uuid
      and household_id = p_household_id
    for update;
  if not found then
    raise exception 'KEEL_SCOPE_VIOLATION: suggestion not in household' using errcode = 'P0006';
  end if;
  if v_suggestion.status <> 'suggested' then
    raise exception 'KEEL_INVALID_COMMAND: suggestion already decided' using errcode = 'P0009';
  end if;

  if v_accept then
    -- Same validation lattice as keel_categorize_transaction: live batch,
    -- single offset, category is a live same-entity classification target.
    select jp.entity_id, count(*) over (), la.pfc_key
      into v_entity, v_offsets, v_offset_pfc
      from public.canonical_transactions ct
      join public.journal_batches jb
        on jb.canonical_transaction_id = ct.id and jb.reverses_batch_id is null
       and not exists (
         select 1 from public.journal_revisions rev where rev.original_batch_id = jb.id
       )
      join public.journal_postings jp on jp.batch_id = jb.id
      join public.ledger_accounts la on la.id = jp.ledger_account_id and la.is_category = true
      where ct.id = v_suggestion.canonical_transaction_id
        and ct.household_id = p_household_id
        and ct.voided_at is null
      limit 1;
    if v_entity is null then
      raise exception 'KEEL_NOT_FOUND: transaction' using errcode = 'P0006';
    end if;
    if v_offsets > 1 then
      raise exception 'KEEL_INVALID_COMMAND: split transactions are categorized by their splits'
        using errcode = 'P0009';
    end if;

    select * into v_cat
      from public.ledger_accounts
      where id = v_suggestion.suggested_category_ledger_account_id;
    if v_cat.is_category is not true or v_cat.entity_id <> v_entity
       or v_cat.archived_at is not null then
      raise exception 'KEEL_INVALID_COMMAND: suggested category is no longer valid'
        using errcode = 'P0009';
    end if;

    select tc.category_ledger_account_id, tc.source, curla.pfc_key
      into v_old, v_overlay_source, v_overlay_pfc
      from public.transaction_categories tc
      left join public.ledger_accounts curla on curla.id = tc.category_ledger_account_id
      where tc.canonical_transaction_id = v_suggestion.canonical_transaction_id;

    -- Stale-suggestion guard (adversarial review P1-2a; Law 9 explicit
    -- ownership): between detection and this approval the user (or the
    -- preview→confirm rule apply) may have settled the classification. If
    -- the transaction's effective category is no longer machine-defaulted
    -- (an Uncategorized landing pad, or a plaid_pfc overlay), accepting
    -- would silently overwrite a human decision — fail typed instead. The
    -- read model hides such rows with the same predicate; this is the
    -- authoritative re-check under the row lock.
    if not (
      coalesce(case when v_old is not null then v_overlay_pfc else v_offset_pfc end, '')
        in ('uncategorized_expense', 'uncategorized_income')
      or coalesce(v_overlay_source, '') = 'plaid_pfc'
    ) then
      raise exception
        'KEEL_INVALID_COMMAND: suggestion is stale; this transaction was already categorized'
        using errcode = 'P0009';
    end if;

    -- Overlay upsert, source='user': the approval is a human decision, so the
    -- rules engine's "never a user row" guard now protects it (Law 2).
    insert into public.transaction_categories
      (canonical_transaction_id, household_id, category_ledger_account_id, source)
    values (v_suggestion.canonical_transaction_id, p_household_id,
            v_suggestion.suggested_category_ledger_account_id, 'user')
    on conflict (canonical_transaction_id) do update
      set category_ledger_account_id = excluded.category_ledger_account_id,
          source = 'user', rule_id = null, updated_at = now();

    v_new_status := 'accepted';
  else
    v_new_status := 'dismissed';
  end if;

  update public.category_suggestions
     set status = v_new_status,
         decided_at = now(),
         decided_by = (p_actor->>'userId')::uuid
   where id = v_suggestion.id;

  v_result := jsonb_build_object(
    'commandId', p_command_id,
    'economicEventKey', p_economic_event_key,
    'idempotentReplay', false,
    'effects', jsonb_build_object(
      'suggestionId', v_suggestion.id,
      'status', v_new_status,
      'canonicalTransactionId', v_suggestion.canonical_transaction_id,
      'categoryLedgerAccountId',
        case when v_accept then v_suggestion.suggested_category_ledger_account_id end,
      'previousCategoryLedgerAccountId', v_old
    ),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  );

  perform public.keel_finish_command(
    p_command_id, 'categorization.decide_suggestion', p_economic_event_key,
    p_household_id, p_actor, v_hash,
    'categorization.suggestion_decided', 'category_suggestion', v_suggestion.id,
    jsonb_build_object(
      'suggestionId', v_suggestion.id,
      'status', v_new_status,
      'canonicalTransactionId', v_suggestion.canonical_transaction_id,
      'categoryLedgerAccountId',
        case when v_accept then v_suggestion.suggested_category_ledger_account_id end,
      'previousCategoryLedgerAccountId', v_old
    ),
    v_result
  );

  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Ownership ritual (procs owned by keel_api; execute for authenticated;
-- detection also for service_role like keel_detect_transfers) — matching
-- keel_cmd_manual_transaction / keel_cmd_reanchor_balance.
-- ---------------------------------------------------------------------------
grant create on schema public to keel_api;
alter function public.keel_detect_category_suggestions(uuid) owner to keel_api;
alter function public.keel_cmd_decide_category_suggestion(uuid, text, jsonb, uuid, jsonb) owner to keel_api;
revoke create on schema public from keel_api;

revoke all on function public.keel_detect_category_suggestions(uuid) from public, anon;
grant execute on function public.keel_detect_category_suggestions(uuid) to authenticated, service_role;

revoke all on function public.keel_cmd_decide_category_suggestion(uuid, text, jsonb, uuid, jsonb)
  from public, anon;
grant execute on function public.keel_cmd_decide_category_suggestion(uuid, text, jsonb, uuid, jsonb)
  to authenticated;

revoke all on function public.keel_list_category_suggestions(uuid) from public, anon;
grant execute on function public.keel_list_category_suggestions(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. Law 6 export ruling: suggestion records are classification provenance
-- with user decisions on them (same footing as transfer_links) → INCLUDE.
-- Same wrapper chain as every table added since 20260711180000.
-- ---------------------------------------------------------------------------
grant select on public.category_suggestions to keel_export;
create policy category_suggestions_export on public.category_suggestions
  for select to keel_export using (true);

alter function public.keel_export_household(uuid,timestamptz)
  rename to keel_export_household_pre_category_suggestions;
revoke all on function public.keel_export_household_pre_category_suggestions(uuid,timestamptz)
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
  v_base := public.keel_export_household_pre_category_suggestions(p_household_id, p_as_of);
  select jsonb_build_object(
    'category_suggestions', coalesce((select jsonb_agg(to_jsonb(x) order by x.id)
      from public.category_suggestions x where x.household_id = p_household_id), '[]'::jsonb)
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
