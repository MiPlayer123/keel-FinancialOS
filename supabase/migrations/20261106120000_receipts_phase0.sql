-- Receipts phase 0 (docs/research/RECEIPT-CAPTURE-FEASIBILITY-2026-11-06.md §10).
--
-- 1. keel_documents_confirm_upload: an upload with no target (the Receipts
--    page inbox) inserted an attachment row with every target null, which the
--    "exactly one target" CHECK on document_attachments rejects — so every
--    inbox upload failed. Now the attachment is written only when a target is
--    given, and a half-given target pair is refused.
--    Also: identical bytes already filed in this household (same kind, live)
--    are not stored twice. The existing document is reused (and attached to
--    the target, if one was given) and the result says duplicate=true.
-- 2. keel_worker_receipt_candidates: purchase receipts only match money out
--    (refund receipts, printed negative, only match money in), and each row
--    says whether the transaction already has a receipt attached.
-- 3. keel_receipts_inbox: a receipt attached directly (picked by hand, or from
--    a transaction) now reads as attached, with that transaction's details.
--
-- Same signatures throughout (create or replace keeps owners and grants).
-- Re-runnable.

-- ---------------------------------------------------------------------------
-- 1. confirm_upload
-- ---------------------------------------------------------------------------
create or replace function public.keel_documents_confirm_upload(
  p_household_id uuid,
  p_entity_id uuid,
  p_document_id uuid,
  p_kind public.document_kind,
  p_storage_bucket text,
  p_storage_path text,
  p_content_sha256 text,
  p_mime_type text,
  p_byte_size bigint,
  p_original_filename text,
  p_created_by uuid,
  p_target_type public.document_target_type,
  p_target_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_command_id uuid := gen_random_uuid();
  v_actor jsonb := jsonb_build_object('kind', 'user', 'userId', p_created_by::text);
  v_key text := 'document:' || p_document_id::text || ':confirm';
  v_hash text := public.keel_payload_hash(jsonb_build_object(
    'documentId', p_document_id, 'contentSha256', p_content_sha256,
    'targetType', p_target_type, 'targetId', p_target_id
  ));
  v_replay jsonb;
  v_document_id uuid := p_document_id;
  v_version_id uuid;
  v_attachment_id uuid;
  v_duplicate boolean := false;
  v_result jsonb;
begin
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
  if (p_target_type is null) <> (p_target_id is null) then
    raise exception 'KEEL_INVALID_COMMAND: targetType and targetId go together' using errcode = 'P0009';
  end if;

  v_replay := public.keel_idempotency_check(p_household_id, v_key, v_hash);
  if v_replay is not null then
    return v_replay;
  end if;

  -- Target must already belong to this household — never let an attachment
  -- smuggle a document onto another tenant's transaction/paycheck/claim/statement.
  if p_target_type = 'transaction' and not exists (
    select 1 from public.canonical_transactions t
     where t.id = p_target_id and t.household_id = p_household_id
  ) then
    raise exception 'KEEL_SCOPE_VIOLATION: transaction not in household' using errcode = 'P0006';
  elsif p_target_type = 'paycheck' and not exists (
    select 1 from public.paychecks pc where pc.id = p_target_id and pc.household_id = p_household_id
  ) then
    raise exception 'KEEL_SCOPE_VIOLATION: paycheck not in household' using errcode = 'P0006';
  elsif p_target_type = 'reimbursement_claim' and not exists (
    select 1 from public.reimbursement_claims c
     where c.id = p_target_id and c.household_id = p_household_id
  ) then
    raise exception 'KEEL_SCOPE_VIOLATION: reimbursement claim not in household' using errcode = 'P0006';
  elsif p_target_type = 'statement' and not exists (
    select 1 from public.statements s where s.id = p_target_id and s.household_id = p_household_id
  ) then
    raise exception 'KEEL_SCOPE_VIOLATION: statement not in household' using errcode = 'P0006';
  end if;

  -- Same bytes already filed here as a live document of this kind: reuse it.
  select d.id, dv.id into v_document_id, v_version_id
    from public.documents d
    join public.document_versions dv on dv.document_id = d.id
   where d.household_id = p_household_id
     and d.kind = p_kind
     and d.deleted_at is null
     and d.id <> p_document_id
     and dv.content_sha256 = p_content_sha256
   order by dv.created_at, dv.id
   limit 1;

  if v_document_id is not null then
    v_duplicate := true;
  else
    v_document_id := p_document_id;

    insert into public.documents
      (id, household_id, entity_id, kind, original_filename, created_by)
    values
      (p_document_id, p_household_id, p_entity_id, p_kind, p_original_filename, p_created_by)
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
  end if;

  -- Attach only when a target was given (an inbox upload has none; matching
  -- or the user attaches it later). Never twice to the same target.
  if p_target_type is not null then
    select da.id into v_attachment_id
      from public.document_attachments da
     where da.household_id = p_household_id
       and da.document_id = v_document_id
       and da.detached_at is null
       and (
         (p_target_type = 'transaction' and da.canonical_transaction_id = p_target_id) or
         (p_target_type = 'paycheck' and da.paycheck_id = p_target_id) or
         (p_target_type = 'reimbursement_claim' and da.reimbursement_claim_id = p_target_id) or
         (p_target_type = 'statement' and da.statement_id = p_target_id)
       )
     limit 1;

    if v_attachment_id is null then
      insert into public.document_attachments
        (household_id, document_id, attached_by,
         canonical_transaction_id, paycheck_id, reimbursement_claim_id, statement_id)
      values
        (p_household_id, v_document_id, p_created_by,
         case when p_target_type = 'transaction' then p_target_id end,
         case when p_target_type = 'paycheck' then p_target_id end,
         case when p_target_type = 'reimbursement_claim' then p_target_id end,
         case when p_target_type = 'statement' then p_target_id end)
      returning id into v_attachment_id;
    end if;
  end if;

  v_result := jsonb_build_object(
    'commandId', v_command_id,
    'economicEventKey', v_key,
    'idempotentReplay', false,
    'effects', jsonb_build_object(
      'documentId', v_document_id,
      'documentVersionId', v_version_id,
      'attachmentId', v_attachment_id,
      'duplicate', v_duplicate
    ),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  );

  perform public.keel_finish_command(
    v_command_id, 'documents.confirm_upload', v_key, p_household_id, v_actor,
    v_hash, 'documents.uploaded', 'document', v_document_id,
    jsonb_build_object('documentVersionId', v_version_id, 'attachmentId', v_attachment_id,
                       'duplicate', v_duplicate),
    v_result
  );

  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Receipt candidates: direction + "already has a receipt"
-- ---------------------------------------------------------------------------
create or replace function public.keel_worker_receipt_candidates(
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
        'accountName', acc.name,
        'hasConfirmedMatch', exists (
          select 1 from public.document_transaction_matches m
           where m.canonical_transaction_id = ct.id and m.status = 'confirmed'
        ),
        'hasAttachment', exists (
          select 1 from public.document_attachments da
            join public.documents dd on dd.id = da.document_id
           where da.canonical_transaction_id = ct.id
             and da.detached_at is null
             and dd.kind = 'receipt'
             and dd.deleted_at is null
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
        -- Account side: negative = money out. A purchase receipt (positive
        -- total) only matches money out; a refund receipt only money in.
        and (case when p_amount_minor >= 0 then p.amount_minor < 0 else p.amount_minor > 0 end)
        and p.currency = p_currency
        and ct.effective_date between (p_txn_date - p_date_before) and (p_txn_date + p_date_after)
        and abs(p.amount_minor) between v_abs and v_max
    ) t;
  return jsonb_build_object('rows', v_rows);
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Inbox: direct attachments count as attached
-- ---------------------------------------------------------------------------
create or replace function public.keel_receipts_inbox(p_household_id uuid)
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
        'match', (
          select jsonb_build_object(
            'matchId', m.id,
            'status', m.status,
            'score', m.score,
            'reasonCodes', to_jsonb(m.reason_codes),
            'transactionId', m.canonical_transaction_id,
            'txnDescription', left(coalesce(mtov.display_description, mct.description), 140),
            'txnAmountMinor', mp.amount_minor::text,
            'txnCurrency', mp.currency,
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
        ),
        -- A live direct attachment to a transaction (picked by hand, or added
        -- from the transaction). Confirmed matches also create one.
        'attached', (
          select jsonb_build_object(
            'attachmentId', da.id,
            'transactionId', act.id,
            'txnDescription', left(coalesce(atov.display_description, act.description), 140),
            'txnAmountMinor', ap.amount_minor::text,
            'txnCurrency', ap.currency,
            'txnDate', to_char(act.effective_date, 'YYYY-MM-DD'),
            'txnAccountName', aacc.name
          )
          from public.document_attachments da
          join public.canonical_transactions act on act.id = da.canonical_transaction_id
          join public.journal_batches ajb
            on ajb.canonical_transaction_id = act.id and ajb.reverses_batch_id is null
          join public.journal_postings ap on ap.batch_id = ajb.id
          join public.ledger_accounts ala on ala.id = ap.ledger_account_id and ala.is_category = false
          join public.accounts aacc on aacc.ledger_account_id = ala.id
          left join public.transaction_overrides atov on atov.canonical_transaction_id = act.id
          where da.document_id = d.id
            and da.household_id = p_household_id
            and da.detached_at is null
          order by da.attached_at desc
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
    'formulaVersion', 'receipts-inbox-v2',
    'rows', v_rows
  );
end;
$$;
