-- Denormalize Plaid personal_finance_category.primary onto
-- normalized_source_records (prod perf finding, 2026-07-17).
--
-- PROBLEM (production postgres logs): keel_detect_category_suggestions took
-- 37,453ms on the founder's real dataset and was killed by the API statement
-- timeout ("canceling statement due to statement timeout" ×3 →
-- transaction_failed 500s in the Review UI). Root cause: the proc's `pfc`
-- CTE scanned and jsonb-exploded EVERY raw_provider_events row carrying an
-- 'added' array on EVERY call — unbounded over the whole event history.
-- keel_autocategorize_household shares the same extraction on the worker
-- path (slow too, just hidden from the UI).
--
-- FIX: extract the PFC primary ONCE per record — at ingestion
-- (keel_worker_create_normalized parses only the single page that supplied
-- the event) — into normalized_source_records.pfc_primary, backfill existing
-- rows once here, and point both consumers at the column. Detection becomes
-- index/PK lookups over the household's target transactions only; no raw
-- scan, no jsonb explosion.
--
-- Law compliance: the raw event row remains the immutable source of truth
-- (source preservation, BC-v2.1 §9.1). pfc_primary is a parsed convenience
-- copy, reproducible from the exported raw body_text at any time — and is
-- accordingly an OMITTED export column, the same Law-6 ruling as
-- raw_provider_events.body ("parsed convenience copy omitted").

-- ---------------------------------------------------------------------------
-- 1. Column.
-- ---------------------------------------------------------------------------
alter table public.normalized_source_records
  add column if not exists pfc_primary text null;
comment on column public.normalized_source_records.pfc_primary is
  'Denormalized Plaid personal_finance_category.primary for this record, extracted from its own raw provider page at ingestion (keel_worker_create_normalized) or by the one-time 20260717170000 backfill. Empty string = the provider listed the transaction in ''added'' without a PFC (maps to Other / Other Income, exactly as the original request-time extraction did); NULL = no PFC evidence for this record. The raw event body remains the immutable source of truth.';

-- ---------------------------------------------------------------------------
-- 2. One-time backfill: the exact extraction the request-time CTEs performed
-- (latest 'added' entry per provider transaction, coalesced to '' when the
-- entry carries no PFC), run ONCE at migration time instead of per request.
-- Household-scoped dedupe: the per-request CTEs were implicitly inside one
-- household; a global pass must never let two tenants' provider transaction
-- ids collide.
--
-- normalized_source_records carries a keel_forbid_mutation trigger guarding
-- the CAPTURED source fields. Stamping a derived annotation column from a
-- migration is not a correction of observed data (the source fields are
-- untouched and the value is recomputable from the raw body), so the trigger
-- is disabled for exactly this statement and re-enabled immediately.
-- ---------------------------------------------------------------------------
alter table public.normalized_source_records
  disable trigger normalized_source_records_immutable;

with pfc as (
  select distinct on (r.household_id, elem->>'transaction_id')
         r.household_id,
         elem->>'transaction_id' as ptid,
         coalesce(elem->'personal_finance_category'->>'primary', '') as primary
    from public.raw_provider_events r
    cross join lateral jsonb_array_elements(
      coalesce(r.body_text::jsonb->'added', '[]'::jsonb)) elem
    where r.body_text is not null
      and (r.body_text::jsonb) ? 'added'
    order by r.household_id, elem->>'transaction_id', r.received_at desc
)
update public.normalized_source_records nsr
   set pfc_primary = pfc.primary
  from pfc
 where nsr.household_id = pfc.household_id
   and nsr.provider_transaction_id = pfc.ptid
   and nsr.pfc_primary is null;

alter table public.normalized_source_records
  enable trigger normalized_source_records_immutable;

-- ---------------------------------------------------------------------------
-- 3. Index ruling: NO new index. The rewritten consumers reach
-- normalized_source_records by PRIMARY KEY (targets → transaction_source_links
-- → nsr.id) and filter the fetched row's pfc_primary; the only
-- provider_transaction_id access path is already covered by
-- normalized_source_records_provider_txn (20260712210000). A partial index on
-- (provider_transaction_id) where pfc_primary is not null would duplicate it
-- with no reader.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 4. Ingestion write path: keel_worker_create_normalized (live body:
-- 20260711170000) now extracts THIS record's PFC primary from the single
-- page that supplied the event — one bounded jsonb parse per insert, never a
-- history scan. Lookup is 'added'-only, matching the original request-time
-- extraction exactly (it never trusted 'modified' entries for PFC).
-- create-or-replace preserves the original owner and ACLs.
-- ---------------------------------------------------------------------------
create or replace function public.keel_worker_create_normalized(
  p_attempt_id uuid,
  p_owner uuid,
  p_raw_event_id uuid,
  p_account_id uuid,
  p_provider_transaction_id text,
  p_kind text,
  p_amount_minor text,
  p_currency text,
  p_effective_date text,
  p_description text,
  p_pending boolean
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attempt public.sync_attempts%rowtype;
  v_page public.raw_provider_events%rowtype;
  v_pfc text;
  v_id uuid;
begin
  select * into v_attempt
    from public.sync_attempts
   where attempt_id = p_attempt_id;
  if not found then
    raise exception 'KEEL_INVALID_COMMAND: unknown attempt' using errcode = 'P0009';
  end if;
  perform public.keel_worker_assert_lease(v_attempt.connection_id, p_owner);

  select * into v_page
    from public.raw_provider_events
   where id = p_raw_event_id
     and household_id = v_attempt.household_id
     and connection_id = v_attempt.connection_id
     and provider_event_id like p_attempt_id::text || ':%';
  if not found then
    raise exception 'KEEL_SCOPE_VIOLATION: raw page is not part of attempt'
      using errcode = 'P0006';
  end if;
  if p_kind <> 'removed' and p_pending is null then
    raise exception 'KEEL_INVALID_COMMAND: pending state is required'
      using errcode = 'P0009';
  end if;

  -- Denormalized PFC primary (20260717170000): parse ONLY this event's page.
  -- '' = listed in 'added' without a PFC; NULL = not in this page's 'added'
  -- array (removed events, modified-only pages, simulator pages).
  if p_kind <> 'removed' and v_page.body_text is not null then
    select coalesce(elem->'personal_finance_category'->>'primary', '')
      into v_pfc
      from jsonb_array_elements(
        coalesce(v_page.body_text::jsonb->'added', '[]'::jsonb)) elem
      where elem->>'transaction_id' = p_provider_transaction_id
      limit 1;
  end if;

  insert into public.normalized_source_records
    (raw_event_id, household_id, account_id, provider_transaction_id, kind,
     amount_minor, currency, effective_date, description, pending, pfc_primary)
  values
    (v_page.id, v_attempt.household_id,
     case when p_kind = 'removed' then null else p_account_id end,
     p_provider_transaction_id, p_kind::public.source_record_kind,
     case when p_kind = 'removed' then null else p_amount_minor::bigint end,
     case when p_kind = 'removed' then null else p_currency end,
     case when p_kind = 'removed' then null else p_effective_date::date end,
     case when p_kind = 'removed' then null else p_description end,
     case when p_kind = 'removed' then false else p_pending end,
     v_pfc)
  returning id into v_id;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Detection reads the denormalized column. Full recreate of the live body
-- (20260717160000, incl. its JWT-claims gate) with ONLY the pfc extraction
-- changed: the `pfc` raw-scan CTE is gone; pfc_proposals joins targets →
-- transaction_source_links → normalized_source_records.pfc_primary directly.
-- Distinct-on tie-break semantics preserved exactly (posted record first,
-- newest normalized record, then id). create-or-replace preserves the
-- keel_api ownership and ACLs.
-- ---------------------------------------------------------------------------
create or replace function public.keel_detect_category_suggestions(p_household_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
  -- keel_api owns this definer and has NO usage on schema auth — the house
  -- pattern for keel_api-owned procs is the JWT-claims lookup, exactly as
  -- keel_actor_from_jwt does. Null claim = the api function's future
  -- cron/worker path.
  v_uid uuid := coalesce(
    nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
    nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid;
begin
  if v_uid is not null and not exists (
    select 1 from public.household_memberships
    where household_id = p_household_id and user_id = v_uid
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
  pfc_proposals as (
    -- ONE proposal per transaction (adversarial review P2-1). PFC primary now
    -- read from the record's denormalized pfc_primary — extracted once at
    -- ingestion (20260717170000) instead of re-exploding the whole raw event
    -- history per call (prod finding: 37s scans → statement timeout).
    -- Deterministic winner unchanged: posted record first, then the newest
    -- normalized record, then id.
    select distinct on (t.txn_id)
           t.txn_id, nsr.pfc_primary,
           cat.pfc_key as cat_key, cat.id as cat_id
      from targets t
      join public.transaction_source_links tsl on tsl.canonical_transaction_id = t.txn_id
      join public.normalized_source_records nsr
        on nsr.id = tsl.normalized_source_record_id
       and nsr.pfc_primary is not null
      join public.ledger_accounts cat
        on cat.entity_id = t.entity_id
       and cat.pfc_key = public.keel_pfc_to_category_key(nsr.pfc_primary, t.txn_kind)
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
            case when v_uid is null
                 then jsonb_build_object('kind', 'system', 'source', 'categorization_detector')
                 else jsonb_build_object('kind', 'user', 'userId', v_uid) end,
            'categorization.detect', 'household', p_household_id,
            jsonb_build_object('suggested', v_count));
  end if;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Same pass for keel_autocategorize_household (live body: 20260713090000
-- §5) — identical extraction change, worker path. Also gains distinct-on per
-- transaction (posted first, newest record, id) so a multi-source-link
-- transaction resolves deterministically instead of by insert-order accident
-- (the same fan-out P2-1 fixed in detection). create-or-replace preserves
-- the service_role grant.
-- ---------------------------------------------------------------------------
create or replace function public.keel_autocategorize_household(p_household_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  with mapped as (
    select distinct on (ct.id)
           ct.id as txn_id, ct.household_id, jp.entity_id, la.kind,
           public.keel_pfc_to_category_key(nsr.pfc_primary, la.kind) as cat_key
      from public.canonical_transactions ct
      join public.journal_batches jb
        on jb.canonical_transaction_id = ct.id and jb.reverses_batch_id is null
       -- Live batch only: a sign-flipping sync revision must not let the
       -- superseded batch's kind race the replacement's.
       and not exists (
         select 1 from public.journal_revisions rev where rev.original_batch_id = jb.id
       )
      join public.journal_postings jp on jp.batch_id = jb.id
      join public.ledger_accounts la on la.id = jp.ledger_account_id and la.is_category = true
      join public.transaction_source_links tsl on tsl.canonical_transaction_id = ct.id
      join public.normalized_source_records nsr
        on nsr.id = tsl.normalized_source_record_id
       and nsr.pfc_primary is not null
      where ct.household_id = p_household_id
      order by ct.id, nsr.pending asc, nsr.created_at desc, nsr.id
  )
  insert into public.transaction_categories
    (canonical_transaction_id, household_id, category_ledger_account_id, source)
  select m.txn_id, m.household_id, cat.id, 'plaid_pfc'
    from mapped m
    join public.ledger_accounts cat
      on cat.entity_id = m.entity_id and cat.pfc_key = m.cat_key
     and cat.is_category = true and cat.kind = m.kind and cat.archived_at is null
  on conflict (canonical_transaction_id) do nothing;
  get diagnostics v_count = row_count;

  if v_count > 0 then
    insert into public.audit_log (household_id, actor, action, object_type, object_id, after)
    values (p_household_id, jsonb_build_object('kind', 'system', 'source', 'plaid_pfc'),
            'transactions.autocategorize', 'household', p_household_id,
            jsonb_build_object('classified', v_count));
  end if;
  return v_count;
end;
$$;
