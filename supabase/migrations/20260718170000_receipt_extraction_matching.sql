-- WS-J / FEEDBACK.md F-030 — Receipts: extraction + suggest→approve matching.
--
-- The DEFERRED next layer named in 20260717234500_documents_attach_only.sql's
-- header, now built per docs/research/RECEIPTS-2026-07-16.md:
--   * document_extractions   — per-document_version typed AI read (Law 11),
--                              immutable/append-only like the rest of the
--                              documents schema. Extracted merchant/amount/date
--                              are DATA-TIER (Law 5): inert scalars, never
--                              instructions.
--   * document_transaction_matches — suggest→approve link (AI class B, Law 10)
--                              between a document and a canonical_transaction.
--                              Reversible (Law 2): confirm→detach, reject is
--                              terminal-for-that-pair, never a hard delete.
--
-- Law 1: the MATCHER is deterministic (@keel/documents, pure TS). The model
-- only produced the extraction upstream. Amount/date comparison is arithmetic.
-- Law 4: money is BIGINT minor units.
--
-- Grant shape mirrors the investment/holdings worker procs
-- (20260718070000_holdings_plaid_sync.sql): worker-facing write procs are
-- SECURITY DEFINER, owned by keel_worker, service_role-only; the user-facing
-- confirm/reject/read procs are owned by keel_api and go through the normal
-- authenticated command/query path with fail-closed auth.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type public.extraction_status as enum ('pending', 'extracted', 'failed');
create type public.document_match_status as enum ('suggested', 'confirmed', 'rejected', 'detached');

-- ---------------------------------------------------------------------------
-- document_extractions: one typed extraction per (version, extractor, version).
-- Append-only; replay-idempotent via the unique key. The extracted fields are
-- inert DATA (Law 5) — merchant is a string, amount a bigint, nothing here is
-- ever interpreted as an instruction.
-- ---------------------------------------------------------------------------
create table public.document_extractions (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id),
  document_version_id uuid not null references public.document_versions (id),
  status public.extraction_status not null,
  -- 'fixture' | 'claude:<model>' | 'ollama:<model>' — provenance (Law 11).
  extractor text not null check (char_length(extractor) between 1 and 100),
  -- prompt/policy version stamp (Law 9/11).
  extractor_version text not null check (char_length(extractor_version) between 1 and 100),
  -- Extracted fields — all nullable; an unreadable receipt is an inert all-null
  -- 'extracted' or a 'failed' row, never a guess.
  merchant text check (merchant is null or char_length(merchant) between 1 and 200),
  amount_minor bigint,
  currency text check (currency is null or currency ~ '^[A-Z]{3}$'),
  txn_date date,
  -- Model self-reported confidence for the read, [0,1] (Law 11).
  confidence numeric(4, 3) check (confidence is null or (confidence >= 0 and confidence <= 1)),
  -- Verbatim model response, retained as inert evidence (Law 5). Never executed.
  raw_evidence jsonb not null default '{}'::jsonb,
  -- On 'failed', a short reason string (never provider bodies/keys).
  error_code text check (error_code is null or char_length(error_code) between 1 and 100),
  created_at timestamptz not null default now(),
  unique (document_version_id, extractor, extractor_version)
);
create trigger document_extractions_immutable
  before update or delete on public.document_extractions
  for each row execute function public.keel_forbid_mutation();

-- ---------------------------------------------------------------------------
-- document_transaction_matches: suggestion → approval (mirrors transfer_links).
-- A rejected (document_version, txn) pair is never re-suggested (unique + do
-- nothing). One confirmed match per document_version in this slice (partial
-- unique index below). Detach is undo — a status transition, not a delete.
-- ---------------------------------------------------------------------------
create table public.document_transaction_matches (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id),
  document_version_id uuid not null references public.document_versions (id),
  canonical_transaction_id uuid not null references public.canonical_transactions (id),
  status public.document_match_status not null,
  -- Deterministic matcher score; null for a manual attach.
  score integer,
  reason_codes text[] not null default '{}',
  -- 'matcher:<version>' | 'user' — who proposed this pair.
  suggested_by text not null check (char_length(suggested_by) between 1 and 100),
  -- The attachment row created when a match is confirmed (link back to the
  -- existing document_attachments mechanism). Null until confirmed.
  attachment_id uuid references public.document_attachments (id),
  decided_by uuid references auth.users (id),
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  unique (document_version_id, canonical_transaction_id)
);

-- At most one active suggested/confirmed match per document_version (a version
-- can suggest against several txns, but only one may be live at a time — the
-- others must be rejected/detached first). Enforced as a partial unique index.
create unique index document_matches_active_version_once
  on public.document_transaction_matches (document_version_id)
  where status in ('suggested', 'confirmed');

create index document_extractions_version on public.document_extractions (document_version_id);
create index document_extractions_household on public.document_extractions (household_id);
create index document_matches_txn on public.document_transaction_matches (canonical_transaction_id)
  where status in ('suggested', 'confirmed');
create index document_matches_household_suggested on public.document_transaction_matches (household_id)
  where status = 'suggested';

-- ---------------------------------------------------------------------------
-- Lockdown: browser never writes these; reads go through the procs below.
-- ---------------------------------------------------------------------------
revoke all on public.document_extractions, public.document_transaction_matches
  from public, anon, authenticated;
alter table public.document_extractions enable row level security;
alter table public.document_transaction_matches enable row level security;

-- keel_api owns the user-facing read/decide procs (needs table access + a
-- permissive RLS policy, same _definer_all pattern as the attach-only slice).
grant select, insert, update on public.document_transaction_matches to keel_api;
grant select on public.document_extractions to keel_api;
create policy document_extractions_definer_all on public.document_extractions
  for all to keel_api using (true) with check (true);
create policy document_matches_definer_all on public.document_transaction_matches
  for all to keel_api using (true) with check (true);

-- keel_worker owns the extraction+suggestion write procs (service_role only).
-- Those SECURITY DEFINER procs run AS keel_worker (non-BYPASSRLS) and must read
-- the document tables + transaction_overrides to scope-check and generate
-- candidates. keel_worker already has grants+policies on canonical_transactions,
-- journal_*, accounts, ledger_accounts, households, and audit_log (insert) from
-- 20260710210500; only documents / document_versions / transaction_overrides
-- were keel_api-only, so grant + policy those for the worker here.
grant select on public.documents, public.document_versions, public.transaction_overrides
  to keel_worker;
grant select, insert on public.document_extractions to keel_worker;
grant select, insert on public.document_transaction_matches to keel_worker;

create policy documents_worker_read on public.documents
  for select to keel_worker using (true);
create policy document_versions_worker_read on public.document_versions
  for select to keel_worker using (true);
create policy transaction_overrides_worker_read on public.transaction_overrides
  for select to keel_worker using (true);
create policy document_extractions_worker_all on public.document_extractions
  for all to keel_worker using (true) with check (true);
create policy document_matches_worker_all on public.document_transaction_matches
  for all to keel_worker using (true) with check (true);

-- ---------------------------------------------------------------------------
-- keel_worker_persist_extraction: worker-only. Idempotent per
-- (document_version, extractor, extractor_version) — a replayed extraction job
-- no-ops rather than duplicating. Returns the extraction id.
-- Money arrives as a decimal STRING and is cast ::bigint (exact; never a float).
-- ---------------------------------------------------------------------------
create function public.keel_worker_persist_extraction(
  p_household_id uuid,
  p_document_version_id uuid,
  p_status public.extraction_status,
  p_extractor text,
  p_extractor_version text,
  p_merchant text,
  p_amount_minor text,
  p_currency text,
  p_txn_date date,
  p_confidence numeric,
  p_raw_evidence jsonb,
  p_error_code text
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  -- The document_version must belong to the claimed household (defence in
  -- depth: the worker resolves this, but never trust the caller's scope).
  if not exists (
    select 1
      from public.document_versions dv
      join public.documents d on d.id = dv.document_id
     where dv.id = p_document_version_id and d.household_id = p_household_id
  ) then
    raise exception 'KEEL_NOT_FOUND: document version not in household' using errcode = 'P0006';
  end if;

  insert into public.document_extractions
    (household_id, document_version_id, status, extractor, extractor_version,
     merchant, amount_minor, currency, txn_date, confidence, raw_evidence, error_code)
  values
    (p_household_id, p_document_version_id, p_status, p_extractor, p_extractor_version,
     nullif(btrim(coalesce(p_merchant, '')), ''),
     case when p_amount_minor is null or btrim(p_amount_minor) = '' then null
          else p_amount_minor::bigint end,
     p_currency, p_txn_date, p_confidence,
     coalesce(p_raw_evidence, '{}'::jsonb), p_error_code)
  on conflict (document_version_id, extractor, extractor_version) do nothing
  returning id into v_id;

  if v_id is null then
    select id into v_id from public.document_extractions
     where document_version_id = p_document_version_id
       and extractor = p_extractor and extractor_version = p_extractor_version;
  end if;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- keel_worker_suggest_match: worker-only. Records ONE deterministic-matcher
-- suggestion (status 'suggested'). Idempotent per pair (unique + do nothing);
-- never re-suggests a rejected pair; never suggests a txn that already has an
-- active suggested/confirmed match for THIS version (partial unique index).
-- The score/reason_codes are the matcher's output (Law 1: computed in TS).
-- ---------------------------------------------------------------------------
create function public.keel_worker_suggest_match(
  p_household_id uuid,
  p_document_version_id uuid,
  p_canonical_transaction_id uuid,
  p_score integer,
  p_reason_codes text[],
  p_matcher_version text
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if not exists (
    select 1
      from public.document_versions dv
      join public.documents d on d.id = dv.document_id
     where dv.id = p_document_version_id and d.household_id = p_household_id
  ) then
    raise exception 'KEEL_NOT_FOUND: document version not in household' using errcode = 'P0006';
  end if;
  if not exists (
    select 1 from public.canonical_transactions ct
     where ct.id = p_canonical_transaction_id and ct.household_id = p_household_id
  ) then
    raise exception 'KEEL_NOT_FOUND: transaction not in household' using errcode = 'P0006';
  end if;

  -- Already an active match for this version? Leave it — the matcher only
  -- suggests the single best candidate, and re-runs must not pile up rows.
  if exists (
    select 1 from public.document_transaction_matches
     where document_version_id = p_document_version_id
       and status in ('suggested', 'confirmed')
  ) then
    return null;
  end if;

  insert into public.document_transaction_matches
    (household_id, document_version_id, canonical_transaction_id, status,
     score, reason_codes, suggested_by)
  values
    (p_household_id, p_document_version_id, p_canonical_transaction_id, 'suggested',
     p_score, coalesce(p_reason_codes, '{}'), 'matcher:' || p_matcher_version)
  on conflict (document_version_id, canonical_transaction_id) do nothing
  returning id into v_id;

  if v_id is not null then
    insert into public.audit_log (household_id, actor, action, object_type, object_id, after)
    values (p_household_id, jsonb_build_object('kind', 'system', 'source', 'receipt_matcher'),
            'receipts.match_suggested', 'document_transaction_match', v_id,
            jsonb_build_object('transactionId', p_canonical_transaction_id, 'score', p_score));
  end if;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- keel_worker_receipt_candidates: worker-only READ. Returns the in-scope cash
-- transactions the matcher should score against, in the SAME query shape
-- keel_detect_transfers uses (live non-reversal batch, account-side posting).
-- Blocks by the extraction's date window + amount band server-side so the
-- worker pulls O(small), then the deterministic TS matcher does the scoring.
-- ---------------------------------------------------------------------------
create function public.keel_worker_receipt_candidates(
  p_household_id uuid,
  p_currency text,
  p_txn_date date,
  p_amount_minor bigint,
  p_date_before integer default 1,
  p_date_after integer default 5,
  p_tip_bps integer default 2500
) returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_rows jsonb;
  v_abs bigint := abs(p_amount_minor);
  v_max bigint := abs(p_amount_minor) + (abs(p_amount_minor) * p_tip_bps) / 10000;
begin
  select coalesce(jsonb_agg(row order by row->>'transactionId'), '[]'::jsonb)
    into v_rows
    from (
      select jsonb_build_object(
        'transactionId', ct.id,
        'amountMinor', p.amount_minor::text,
        'currency', p.currency,
        'effectiveDate', to_char(ct.effective_date, 'YYYY-MM-DD'),
        'description', left(coalesce(tov.display_description, ct.description), 140),
        'hasConfirmedMatch', exists (
          select 1 from public.document_transaction_matches m
           where m.canonical_transaction_id = ct.id and m.status = 'confirmed'
        )
      ) as row
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
      left join public.transaction_overrides tov on tov.canonical_transaction_id = ct.id
      where ct.household_id = p_household_id
        and ct.voided_at is null
        and p.amount_minor <> 0
        and p.currency = p_currency
        and ct.effective_date between (p_txn_date - p_date_before) and (p_txn_date + p_date_after)
        and abs(p.amount_minor) between v_abs and v_max
    ) t;
  return jsonb_build_object('rows', v_rows);
end;
$$;

-- ---------------------------------------------------------------------------
-- keel_cmd_receipts_decide_match: user command (authenticated path). Confirm
-- or reject a suggested match. On CONFIRM, attach the receipt to the matched
-- transaction via the EXISTING document_attachments mechanism and flip the
-- match to 'confirmed'. On REJECT, flip to 'rejected' (never re-suggested).
-- Audited + domain event; reversible (detach is a separate command below).
-- Approval binds the exact (matchId) — Law 11.
-- ---------------------------------------------------------------------------
create function public.keel_cmd_receipts_decide_match(
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
  v_match public.document_transaction_matches%rowtype;
  v_confirm boolean := coalesce((p_payload->>'confirm')::boolean, null);
  v_uid uuid;
  v_doc_id uuid;
  v_entity_id uuid;
  v_attachment_id uuid;
  v_result jsonb;
begin
  perform public.keel_assert_member_write(p_household_id);
  p_actor := public.keel_actor_from_jwt();
  v_uid := (p_actor->>'userId')::uuid;
  v_replay := public.keel_idempotency_check(p_household_id, p_economic_event_key, v_hash);
  if v_replay is not null then
    return v_replay;
  end if;

  if v_confirm is null then
    raise exception 'KEEL_INVALID_COMMAND: confirm must be true or false' using errcode = 'P0009';
  end if;

  select * into v_match
    from public.document_transaction_matches
   where id = (p_payload->>'matchId')::uuid and household_id = p_household_id
   for update;
  if not found then
    raise exception 'KEEL_NOT_FOUND: match' using errcode = 'P0006';
  end if;
  if v_match.status <> 'suggested' then
    raise exception 'KEEL_INVALID_COMMAND: match already decided' using errcode = 'P0009';
  end if;

  if v_confirm then
    -- Resolve document + entity for the attachment row.
    select d.id, d.entity_id into v_doc_id, v_entity_id
      from public.document_versions dv
      join public.documents d on d.id = dv.document_id
     where dv.id = v_match.document_version_id;

    insert into public.document_attachments
      (household_id, document_id, attached_by, canonical_transaction_id)
    values
      (p_household_id, v_doc_id, v_uid, v_match.canonical_transaction_id)
    returning id into v_attachment_id;

    update public.document_transaction_matches
       set status = 'confirmed', attachment_id = v_attachment_id,
           decided_by = v_uid, decided_at = now()
     where id = v_match.id;
  else
    update public.document_transaction_matches
       set status = 'rejected', decided_by = v_uid, decided_at = now()
     where id = v_match.id;
  end if;

  v_result := jsonb_build_object(
    'commandId', p_command_id, 'economicEventKey', p_economic_event_key,
    'idempotentReplay', false,
    'effects', jsonb_build_object(
      'matchId', v_match.id,
      'status', case when v_confirm then 'confirmed' else 'rejected' end,
      'attachmentId', v_attachment_id
    ),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  );
  perform public.keel_finish_command(
    p_command_id, 'receipts.decide_match', p_economic_event_key, p_household_id, p_actor,
    v_hash,
    case when v_confirm then 'receipts.match_confirmed' else 'receipts.match_rejected' end,
    'document_transaction_match', v_match.id,
    jsonb_build_object('status', case when v_confirm then 'confirmed' else 'rejected' end,
                       'attachmentId', v_attachment_id),
    v_result
  );
  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- keel_cmd_receipts_detach_match: user command. Undo a CONFIRMED match — flip
-- to 'detached' and soft-detach the attachment (Law 2: undo, never delete).
-- ---------------------------------------------------------------------------
create function public.keel_cmd_receipts_detach_match(
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
  v_match public.document_transaction_matches%rowtype;
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

  select * into v_match
    from public.document_transaction_matches
   where id = (p_payload->>'matchId')::uuid and household_id = p_household_id
   for update;
  if not found then
    raise exception 'KEEL_NOT_FOUND: match' using errcode = 'P0006';
  end if;
  if v_match.status <> 'confirmed' then
    raise exception 'KEEL_INVALID_COMMAND: only a confirmed match can be detached' using errcode = 'P0009';
  end if;

  update public.document_transaction_matches
     set status = 'detached', decided_by = v_uid, decided_at = now()
   where id = v_match.id;
  if v_match.attachment_id is not null then
    update public.document_attachments
       set detached_at = now(), detached_by = v_uid
     where id = v_match.attachment_id and detached_at is null;
  end if;

  v_result := jsonb_build_object(
    'commandId', p_command_id, 'economicEventKey', p_economic_event_key,
    'idempotentReplay', false,
    'effects', jsonb_build_object('matchId', v_match.id, 'status', 'detached'),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  );
  perform public.keel_finish_command(
    p_command_id, 'receipts.detach_match', p_economic_event_key, p_household_id, p_actor,
    v_hash, 'receipts.match_detached', 'document_transaction_match', v_match.id,
    jsonb_build_object('status', 'detached'), v_result
  );
  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- keel_receipts_inbox: user READ. The receipts hub data — every receipt
-- document (all + filterable by account client-side), its latest extraction,
-- and any active/decided match with both sides' display data. Fail-closed auth.
-- ---------------------------------------------------------------------------
create function public.keel_receipts_inbox(p_household_id uuid)
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

  select coalesce(jsonb_agg(row order by row->>'createdAt' desc, row->>'documentVersionId'), '[]'::jsonb)
    into v_rows
    from (
      select jsonb_build_object(
        'documentId', d.id,
        'documentVersionId', dv.id,
        'kind', d.kind,
        'originalFilename', d.original_filename,
        'storageBucket', dv.storage_bucket,
        'storagePath', dv.storage_path,
        'mimeType', dv.mime_type,
        'byteSize', dv.byte_size,
        'createdAt', dv.created_at,
        'entityId', d.entity_id,
        -- Latest extraction (by created_at) for this version.
        'extraction', (
          select jsonb_build_object(
            'status', ex.status,
            'merchant', ex.merchant,
            'amountMinor', ex.amount_minor::text,
            'currency', ex.currency,
            'txnDate', ex.txn_date,
            'confidence', ex.confidence,
            'errorCode', ex.error_code
          )
          from public.document_extractions ex
          where ex.document_version_id = dv.id
          order by ex.created_at desc
          limit 1
        ),
        -- Active or most-recently decided match for this version.
        'match', (
          select jsonb_build_object(
            'matchId', m.id,
            'status', m.status,
            'score', m.score,
            'reasonCodes', to_jsonb(m.reason_codes),
            'transactionId', m.canonical_transaction_id,
            'txnDescription', left(coalesce(mtov.display_description, mct.description), 140),
            'txnAmountMinor', (
              select p.amount_minor::text
                from public.journal_batches jb
                join public.journal_postings p on p.batch_id = jb.id
                join public.ledger_accounts la on la.id = p.ledger_account_id and la.is_category = false
               where jb.canonical_transaction_id = mct.id and jb.reverses_batch_id is null
               limit 1
            ),
            'txnDate', to_char(mct.effective_date, 'YYYY-MM-DD'),
            'txnAccountName', macc.name
          )
          from public.document_transaction_matches m
          join public.canonical_transactions mct on mct.id = m.canonical_transaction_id
          join public.journal_batches mjb
            on mjb.canonical_transaction_id = mct.id and mjb.reverses_batch_id is null
          join public.journal_postings mp on mp.batch_id = mjb.id
          join public.ledger_accounts mla on mla.id = mp.ledger_account_id and mla.is_category = false
          join public.accounts macc on macc.ledger_account_id = mla.id
          left join public.transaction_overrides mtov on mtov.canonical_transaction_id = mct.id
          where m.document_version_id = dv.id
            and m.status in ('suggested', 'confirmed')
          order by m.created_at desc
          limit 1
        )
      ) as row
      from public.documents d
      join public.document_versions dv on dv.document_id = d.id
      where d.household_id = p_household_id
        and d.kind = 'receipt'
        and d.deleted_at is null
    ) t;

  return jsonb_build_object(
    'scope', jsonb_build_object('householdId', p_household_id),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'formulaVersion', 'receipts-inbox-v1',
    'rows', v_rows
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Ownership + grants
-- ---------------------------------------------------------------------------
-- Worker procs: owned by keel_worker (least-privilege, X-006 hardening pattern),
-- service_role-only execute (worker auth is the automations secret).
grant create on schema public to keel_worker;
alter function public.keel_worker_persist_extraction(uuid, uuid, public.extraction_status, text, text, text, text, text, date, numeric, jsonb, text) owner to keel_worker;
alter function public.keel_worker_suggest_match(uuid, uuid, uuid, integer, text[], text) owner to keel_worker;
alter function public.keel_worker_receipt_candidates(uuid, text, date, bigint, integer, integer, integer) owner to keel_worker;
revoke create on schema public from keel_worker;

-- User procs: owned by keel_api, authenticated execute (fail-closed inside).
grant create on schema public to keel_api;
alter function public.keel_cmd_receipts_decide_match(uuid, text, jsonb, uuid, jsonb) owner to keel_api;
alter function public.keel_cmd_receipts_detach_match(uuid, text, jsonb, uuid, jsonb) owner to keel_api;
alter function public.keel_receipts_inbox(uuid) owner to keel_api;
revoke create on schema public from keel_api;

revoke all on function public.keel_worker_persist_extraction(uuid, uuid, public.extraction_status, text, text, text, text, text, date, numeric, jsonb, text) from public, anon, authenticated;
revoke all on function public.keel_worker_suggest_match(uuid, uuid, uuid, integer, text[], text) from public, anon, authenticated;
revoke all on function public.keel_worker_receipt_candidates(uuid, text, date, bigint, integer, integer, integer) from public, anon, authenticated;
revoke all on function public.keel_cmd_receipts_decide_match(uuid, text, jsonb, uuid, jsonb) from public, anon;
revoke all on function public.keel_cmd_receipts_detach_match(uuid, text, jsonb, uuid, jsonb) from public, anon;
revoke all on function public.keel_receipts_inbox(uuid) from public, anon;

grant execute on function public.keel_worker_persist_extraction(uuid, uuid, public.extraction_status, text, text, text, text, text, date, numeric, jsonb, text) to service_role;
grant execute on function public.keel_worker_suggest_match(uuid, uuid, uuid, integer, text[], text) to service_role;
grant execute on function public.keel_worker_receipt_candidates(uuid, text, date, bigint, integer, integer, integer) to service_role;
grant execute on function public.keel_cmd_receipts_decide_match(uuid, text, jsonb, uuid, jsonb) to authenticated;
grant execute on function public.keel_cmd_receipts_detach_match(uuid, text, jsonb, uuid, jsonb) to authenticated;
grant execute on function public.keel_receipts_inbox(uuid) to authenticated;
