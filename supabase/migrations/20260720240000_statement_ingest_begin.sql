-- Statement ingestion Slice 6 — atomic ingest-begin + outbox export wire-in.
-- statement-ingestion-v2.md §3 [A3], §4 [A4], §8/§12 [A12], §9. Cites Laws 5,7,9,12.
--
-- What this closes (the MISSING Slice-5 piece): confirm-upload, for a statement
-- upload in mode='ingest', must — in ONE transaction — mint the document +
-- immutable version, register the tenant content hash (dedupe [A4]), create the
-- statement_drafts row (status 'pending'), AND write the statement_outbox
-- delivery record (transactional outbox [A12]). A committed draft ALWAYS has a
-- committed outbox row; the best-effort pgmq enqueue that follows is then just an
-- optimization, and keel_sweep_statement_outbox (Slice 5) re-drives anything the
-- enqueue drops. Idempotent: a re-confirm of the SAME (household, document_id,
-- content) is a no-op replay [Law 9].
--
-- Boundary (Law 5): Postgres cannot reach Storage. The edge function downloads
-- the just-uploaded object, computes byte_size + content_sha256 SERVER-side,
-- content-sniffs + immutably promotes it to the canonical bucket, and only THEN
-- calls this proc with those attacker-uncontrolled values. `source_hash` on the
-- draft is bound from this SERVER content_sha256 — never client input [A4].
--
-- Discriminated attach-vs-ingest [A3]: keel_documents_confirm_upload is the
-- ATTACH path (unchanged — always inserts a document_attachment, never a draft).
-- THIS proc is the INGEST path (account NON-NULL, never an attachment, always a
-- draft). confirm-upload branches on mode; the two never overlap.
--
-- Idempotent migration: guarded drops, CREATE OR REPLACE, rename-then-wrap for
-- the export function. Owner/grants mirror keel_documents_confirm_upload (owned
-- by keel_api, SECURITY DEFINER, service_role/authenticated execute).

-- ===========================================================================
-- keel_statement_ingest_begin — the atomic ingest transaction. Called by the
-- edge function's confirm-upload (mode='ingest') AFTER server-side download +
-- sniff + immutable promote. Returns { duplicate, draftId, documentId,
-- documentVersionId, extractionId(null), status } so the caller can enqueue the
-- extract job (best-effort) and answer the client.
--
--   duplicate=false → a fresh draft + outbox row were written this call.
--   duplicate=true  → this household already holds this exact byte-content; the
--                     prior document/version/draft is returned and NOTHING new is
--                     written (no second draft, no second outbox row) [A4].
--
-- Concurrency-safety [A4]: the tenant dedupe is `insert ... on conflict do
-- nothing returning` on document_hashes(household_id, content_sha256) — two
-- racing uploads of the same bytes: exactly one wins the insert and mints the
-- draft; the loser sees no returned row, looks up the winner, and answers
-- duplicate=true. No lost update, no double draft.
--
-- Replay-safety [Law 9]: a legitimate retry of the SAME confirm (same
-- document_id + same content) re-enters here. The document upsert is
-- on-conflict-do-nothing; the version upsert is on-conflict-do-nothing on
-- (document_id, content_sha256); the document_hash insert is
-- on-conflict-do-nothing. If a draft already exists for this version we return it
-- rather than erroring — a re-confirm is a no-op, not a duplicate.
-- ===========================================================================
create or replace function public.keel_statement_ingest_begin(
  p_household_id uuid,
  p_entity_id uuid,
  p_document_id uuid,
  p_account_id uuid,
  p_storage_bucket text,
  p_storage_path text,
  p_content_sha256 text,
  p_mime_type text,
  p_byte_size bigint,
  p_original_filename text,
  p_created_by uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_version_id uuid;
  v_hash_owner_document uuid;
  v_hash_owner_version uuid;
  v_first_document_id uuid;
  v_first_version_id uuid;
  v_draft public.statement_drafts%rowtype;
  v_existing_draft public.statement_drafts%rowtype;
begin
  -- --- Authorization (defense in depth; the edge already authorized) ---------
  if not exists (
    select 1 from public.household_memberships m
     where m.household_id = p_household_id and m.user_id = p_created_by
  ) then
    raise exception 'KEEL_SCOPE_VIOLATION: actor not a member of household' using errcode = 'P0006';
  end if;
  if not exists (
    select 1 from public.entities e where e.id = p_entity_id and e.household_id = p_household_id
  ) then
    raise exception 'KEEL_SCOPE_VIOLATION: entity not in household' using errcode = 'P0006';
  end if;
  -- Ingest ALWAYS targets an account in this household the actor can WRITE
  -- [A3][A10]. This proc is invoked by the edge function's service-role admin
  -- client (no request.jwt.claim.sub is set), so we CANNOT lean on the
  -- JWT-reading keel_recurring_account_access here — we verify write access
  -- explicitly against p_created_by (the same actor-by-parameter pattern
  -- keel_documents_confirm_upload uses). Write access = the account is in this
  -- household AND (the actor is owner/partner and owns the account) OR the actor
  -- holds an 'edit' resource_permission on it. The composite tenant FK on the
  -- draft re-checks the account↔household binding as a backstop.
  if not exists (
    select 1 from public.accounts a where a.id = p_account_id and a.household_id = p_household_id
  ) then
    raise exception 'KEEL_SCOPE_VIOLATION: account not in household' using errcode = 'P0006';
  end if;
  if not (
    (
      exists (
        select 1 from public.household_memberships m
         where m.household_id = p_household_id and m.user_id = p_created_by
           and m.role in ('owner', 'partner')
      )
      and exists (
        select 1 from public.account_owners o
         where o.account_id = p_account_id and o.user_id = p_created_by
      )
    )
    or exists (
      select 1 from public.resource_permissions rp
       where rp.household_id = p_household_id and rp.user_id = p_created_by
         and rp.resource_kind = 'account' and rp.resource_id = p_account_id
         and rp.permission = 'edit'
    )
  ) then
    raise exception 'KEEL_SCOPE_VIOLATION: account not writable by actor' using errcode = 'P0006';
  end if;
  if p_content_sha256 !~ '^[a-f0-9]{64}$' then
    raise exception 'KEEL_INVALID_COMMAND: content hash malformed' using errcode = 'P0001';
  end if;

  -- --- Document + immutable version (mirrors keel_documents_confirm_upload) ---
  insert into public.documents
    (id, household_id, entity_id, kind, original_filename, created_by)
  values
    (p_document_id, p_household_id, p_entity_id, 'statement', p_original_filename, p_created_by)
  on conflict (id) do nothing;

  insert into public.document_versions
    (document_id, storage_bucket, storage_path, content_sha256, mime_type, byte_size)
  values
    (p_document_id, p_storage_bucket, p_storage_path, p_content_sha256, p_mime_type, p_byte_size)
  on conflict (document_id, content_sha256) do nothing
  returning id into v_version_id;
  if v_version_id is null then
    select id into v_version_id from public.document_versions
     where document_id = p_document_id and content_sha256 = p_content_sha256;
  end if;

  -- --- Tenant content identity [A4]: concurrency-safe dedupe ------------------
  -- The FIRST upload of these bytes in this household wins the row and will mint
  -- the draft. A later upload of the same bytes (even under a fresh document_id)
  -- sees no returned row → it is a tenant re-upload. We DO NOT mint a second
  -- draft; we return the first document/version and duplicate=true.
  insert into public.document_hashes
    (household_id, content_sha256, first_document_id, first_version_id, byte_size)
  values
    (p_household_id, p_content_sha256, p_document_id, v_version_id, p_byte_size)
  on conflict (household_id, content_sha256) do nothing
  returning first_document_id, first_version_id
    into v_hash_owner_document, v_hash_owner_version;

  if v_hash_owner_document is null then
    -- Conflict: the household already registered this content. Fetch the winner.
    select first_document_id, first_version_id
      into v_first_document_id, v_first_version_id
      from public.document_hashes
     where household_id = p_household_id and content_sha256 = p_content_sha256;

    -- Return the prior draft for the FIRST version if one exists (the common
    -- case: the same file re-uploaded). If the first upload happened to be an
    -- attach (no draft) there is no draft to return; the client still learns it
    -- is a duplicate and is not charged a second extraction.
    select * into v_existing_draft
      from public.statement_drafts
     where household_id = p_household_id
       and document_version_id = v_first_version_id;

    return jsonb_build_object(
      'duplicate', true,
      'documentId', v_first_document_id,
      'documentVersionId', v_first_version_id,
      'draftId', case when v_existing_draft.id is null then null else v_existing_draft.id end,
      'accountId', case when v_existing_draft.id is null then null else v_existing_draft.account_id end,
      'status', case when v_existing_draft.id is null then null else v_existing_draft.status::text end,
      'extractionId', case when v_existing_draft.id is null then null else v_existing_draft.extraction_id end,
      'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
    );
  end if;

  -- --- Fresh ingest: draft + outbox in ONE txn [A12] -------------------------
  -- source_hash is the SERVER content_sha256 [A4] — the client never supplies it.
  -- A re-confirm of THIS exact version (same document_id + content) that already
  -- won the hash row (e.g. a retry after the hash insert committed but the reply
  -- was lost) re-enters with the draft already present: return it, no-op.
  select * into v_existing_draft
    from public.statement_drafts
   where household_id = p_household_id and document_version_id = v_version_id;
  if v_existing_draft.id is not null then
    return jsonb_build_object(
      'duplicate', false,
      'documentId', p_document_id,
      'documentVersionId', v_version_id,
      'draftId', v_existing_draft.id,
      'accountId', v_existing_draft.account_id,
      'status', v_existing_draft.status::text,
      'extractionId', v_existing_draft.extraction_id,
      'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
    );
  end if;

  insert into public.statement_drafts
    (household_id, document_version_id, account_id, source_hash, status)
  values
    (p_household_id, v_version_id, p_account_id, p_content_sha256, 'pending')
  returning * into v_draft;

  -- Transactional outbox [A12]: written in the SAME txn as the draft. Because
  -- both commit atomically, a committed draft always has a committed delivery
  -- record. The sweeper (Slice 5) re-enqueues from here if the best-effort pgmq
  -- send the caller issues next ever drops. unique(document_version_id) makes
  -- this idempotent under replay.
  insert into public.statement_outbox
    (household_id, document_version_id, account_id, status)
  values
    (p_household_id, v_version_id, p_account_id, 'pending')
  on conflict (document_version_id) do nothing;

  return jsonb_build_object(
    'duplicate', false,
    'documentId', p_document_id,
    'documentVersionId', v_version_id,
    'draftId', v_draft.id,
    'accountId', v_draft.account_id,
    'status', v_draft.status::text,
    'extractionId', null,
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  );
end;
$$;

-- keel_api owns it (it reads/writes documents, document_versions, document_hashes,
-- statement_drafts, statement_outbox — all keel_api-granted). SECURITY DEFINER +
-- service_role/authenticated execute, mirroring keel_documents_confirm_upload.
revoke all on function public.keel_statement_ingest_begin(
  uuid, uuid, uuid, uuid, text, text, text, text, bigint, text, uuid
) from public, anon;
-- keel_api needs CREATE on schema public to own a function there (revoked on
-- live — local-vs-live grant drift); grant-alter-revoke exactly as the export
-- section below and sibling migrations do.
grant create on schema public to keel_api;
alter function public.keel_statement_ingest_begin(
  uuid, uuid, uuid, uuid, text, text, text, text, bigint, text, uuid
) owner to keel_api;
revoke create on schema public from keel_api;
grant execute on function public.keel_statement_ingest_begin(
  uuid, uuid, uuid, uuid, text, text, text, text, bigint, text, uuid
) to service_role, authenticated;

-- ===========================================================================
-- keel_list_statement_drafts — REWRAP to surface storage pointers so the bespoke
-- /statements/drafts route can sign per-row read URLs (Postgres cannot sign).
-- Adds storageBucket + storagePath + mimeType (from the draft's document_version)
-- to each row; everything else is byte-identical to the Slice-3 proc. Same
-- account-scoped gate [A10], same discrepancy preview.
-- ===========================================================================
create or replace function public.keel_list_statement_drafts(p_household_id uuid)
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

  select coalesce(jsonb_agg(row order by row->>'createdAt' desc, row->>'draftId'), '[]'::jsonb)
    into v_rows
    from (
      select jsonb_build_object(
        'draftId', dr.id,
        'documentVersionId', dr.document_version_id,
        'accountId', dr.account_id,
        'accountName', acc.name,
        'accountSubtype', acc.subtype,
        'accountCurrency', acc.currency,
        'sourceHash', dr.source_hash,
        'status', dr.status,
        'statementId', dr.statement_id,
        'createdAt', dr.created_at,
        'originalFilename', d.original_filename,
        -- Storage pointers so /statements/drafts can sign a short-lived,
        -- attachment-only read URL. The canonical bucket only (never quarantine).
        'storageBucket', dv.storage_bucket,
        'storagePath', dv.storage_path,
        'mimeType', dv.mime_type,
        'extraction', case when ex.id is null then null else jsonb_build_object(
          'extractionId', ex.id,
          'kindHint', ex.kind_hint,
          'status', ex.status,
          'periodStart', ex.period_start,
          'periodEnd', ex.period_end,
          'openingMinor', ex.opening_minor::text,
          'endingMinor', ex.ending_minor::text,
          'currency', ex.currency,
          'extractor', ex.extractor,
          'extractorVersion', ex.extractor_version,
          'confidence', ex.confidence,
          'errorCode', ex.error_code,
          'lineCount', (
            select count(*) from public.statement_extraction_lines l
             where l.household_id = p_household_id and l.extraction_id = ex.id
          ),
          'holdingCount', (
            select count(*) from public.statement_extraction_holdings h
             where h.household_id = p_household_id and h.extraction_id = ex.id
          )
        ) end,
        'ledgerEndingMinor', case when ex.period_end is null or ex.currency is null then null else (
          select coalesce(sum(jp.amount_minor), 0)::bigint::text
            from public.journal_postings jp
            join public.journal_batches jb on jb.id = jp.batch_id
           where jp.ledger_account_id = acc.ledger_account_id
             and jp.currency = ex.currency
             and jb.household_id = p_household_id
             and jb.effective_date <= ex.period_end
        ) end,
        'discrepancyMinor', case when ex.ending_minor is null or ex.period_end is null or ex.currency is null then null else (
          (select coalesce(sum(jp.amount_minor), 0)::bigint
             from public.journal_postings jp
             join public.journal_batches jb on jb.id = jp.batch_id
            where jp.ledger_account_id = acc.ledger_account_id
              and jp.currency = ex.currency
              and jb.household_id = p_household_id
              and jb.effective_date <= ex.period_end) - ex.ending_minor
        )::text end
      ) as row
      from public.statement_drafts dr
      join public.accounts acc on acc.household_id = dr.household_id and acc.id = dr.account_id
      join public.document_versions dv on dv.id = dr.document_version_id
      join public.documents d on d.id = dv.document_id
      left join public.statement_extractions ex on ex.id = dr.extraction_id
      where dr.household_id = p_household_id
        and public.keel_recurring_account_access(p_household_id, dr.account_id, false)
    ) t;

  return jsonb_build_object(
    'scope', jsonb_build_object('householdId', p_household_id),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'formulaVersion', 'statement-drafts-v2',
    'rows', v_rows
  );
end;
$$;

-- ===========================================================================
-- Export [A11 / Law 6]: statement_outbox joins the audited export contract.
-- Slice 5 deferred it (shipped table + sweeper without the export layer); this is
-- where the layer lands — INCLUDE entry (packages/exports/manifest.ts), the
-- keel_export grant + RLS below, and the keel_export_household rewrap. The outbox
-- carries no secrets: household_id, document_version_id, account_id, and delivery
-- bookkeeping (status/counts/timestamps) — all portable household data. Same
-- rename-then-wrap idiom as the Slice-3 extraction export.
-- ===========================================================================
grant select on public.statement_outbox to keel_export;
do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public'
                 and tablename='statement_outbox' and policyname='statement_outbox_export') then
    create policy statement_outbox_export on public.statement_outbox
      for select to keel_export using (true);
  end if;
end
$$;

alter function public.keel_export_household(uuid, timestamptz)
  rename to keel_export_household_pre_statement_outbox;
revoke all on function public.keel_export_household_pre_statement_outbox(uuid, timestamptz)
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
  v_base := public.keel_export_household_pre_statement_outbox(p_household_id, p_as_of);

  select jsonb_build_object(
    'statement_outbox', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', o.id, 'household_id', o.household_id,
        'document_version_id', o.document_version_id, 'account_id', o.account_id,
        'status', o.status::text, 'enqueue_count', o.enqueue_count,
        'last_enqueued_at', case when o.last_enqueued_at is null then null else to_char(o.last_enqueued_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end,
        'delivered_at', case when o.delivered_at is null then null else to_char(o.delivered_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end,
        'created_at', to_char(o.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
      ) order by o.id)
      from public.statement_outbox o where o.household_id = p_household_id), '[]'::jsonb)
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
