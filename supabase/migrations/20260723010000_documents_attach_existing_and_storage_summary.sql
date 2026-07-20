-- Attach an ALREADY-UPLOADED document to a target, + household document
-- storage hygiene reads. Founder ask (2026-07-20): "docs attached to when the
-- [transaction] elements too" — the existing attach-only slice
-- (20260717234500) can only attach a FRESH upload at confirm-upload time.
-- A receipt already in the inbox (or a doc attached to some other target)
-- could not be linked to a transaction. This migration closes that gap by
-- reusing the SAME document_attachments row + list + soft-detach that already
-- exist — no parallel storage path (Law 7).
--
-- Nothing here touches bytes: originals live only in Storage
-- (document_versions.storage_bucket/storage_path), never inline in Postgres
-- (confirmed: zero bytea columns on any document table). These procs are pure
-- metadata + a link row.
--
-- Apply (⚑ human, live cloud — after 20260722310000):
--   source supabase/.env.remote
--   psql "postgresql://postgres@db.<ref>.supabase.co:5432/postgres" \
--     -v ON_ERROR_STOP=1 --single-transaction \
--     -f supabase/migrations/20260723000000_documents_attach_existing_and_storage_summary.sql

-- ---------------------------------------------------------------------------
-- keel_cmd_documents_attach: link an EXISTING (non-deleted) document to a
-- target. Command-shaped (generic /commands dispatch), same 5-arg signature
-- as keel_cmd_documents_detach. Idempotent: a live attachment of the same
-- document to the same target is returned as-is, never duplicated.
--
-- Only the 'transaction' target is exercised by the UI today, but the proc
-- accepts every document_target_type for symmetry with confirm_upload and
-- list_for_target (paycheck/reimbursement_claim/statement).
-- ---------------------------------------------------------------------------
create function public.keel_cmd_documents_attach(
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
  v_document_id uuid := (p_payload->>'documentId')::uuid;
  v_target_type public.document_target_type := (p_payload->>'targetType')::public.document_target_type;
  v_target_id uuid := (p_payload->>'targetId')::uuid;
  v_uid uuid;
  v_existing_id uuid;
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

  if v_document_id is null or v_target_type is null or v_target_id is null then
    raise exception 'KEEL_INVALID_COMMAND: documentId, targetType and targetId are required'
      using errcode = 'P0009';
  end if;

  -- Document must be a live original in THIS household. deleted_at guards
  -- against re-attaching a soft-deleted document (Law 2/9 — a deleted doc's
  -- attachments were already detached in keel_cmd_documents_delete).
  if not exists (
    select 1 from public.documents d
     where d.id = v_document_id and d.household_id = p_household_id and d.deleted_at is null
  ) then
    raise exception 'KEEL_SCOPE_VIOLATION: document not in household' using errcode = 'P0006';
  end if;

  -- Target must belong to this household — never smuggle a document onto
  -- another tenant's row (mirror of keel_documents_confirm_upload's checks).
  if v_target_type = 'transaction' and not exists (
    select 1 from public.canonical_transactions t
     where t.id = v_target_id and t.household_id = p_household_id
  ) then
    raise exception 'KEEL_SCOPE_VIOLATION: transaction not in household' using errcode = 'P0006';
  elsif v_target_type = 'paycheck' and not exists (
    select 1 from public.paychecks pc where pc.id = v_target_id and pc.household_id = p_household_id
  ) then
    raise exception 'KEEL_SCOPE_VIOLATION: paycheck not in household' using errcode = 'P0006';
  elsif v_target_type = 'reimbursement_claim' and not exists (
    select 1 from public.reimbursement_claims c
     where c.id = v_target_id and c.household_id = p_household_id
  ) then
    raise exception 'KEEL_SCOPE_VIOLATION: reimbursement claim not in household' using errcode = 'P0006';
  elsif v_target_type = 'statement' and not exists (
    select 1 from public.statements s where s.id = v_target_id and s.household_id = p_household_id
  ) then
    raise exception 'KEEL_SCOPE_VIOLATION: statement not in household' using errcode = 'P0006';
  end if;

  -- Idempotent link: if this document is already actively attached to this
  -- exact target, return the existing attachment rather than a duplicate row.
  select da.id into v_existing_id
    from public.document_attachments da
   where da.household_id = p_household_id
     and da.document_id = v_document_id
     and da.detached_at is null
     and (
       (v_target_type = 'transaction' and da.canonical_transaction_id = v_target_id) or
       (v_target_type = 'paycheck' and da.paycheck_id = v_target_id) or
       (v_target_type = 'reimbursement_claim' and da.reimbursement_claim_id = v_target_id) or
       (v_target_type = 'statement' and da.statement_id = v_target_id)
     )
   limit 1;

  if v_existing_id is not null then
    v_attachment_id := v_existing_id;
  else
    insert into public.document_attachments
      (household_id, document_id, attached_by,
       canonical_transaction_id, paycheck_id, reimbursement_claim_id, statement_id)
    values
      (p_household_id, v_document_id, v_uid,
       case when v_target_type = 'transaction' then v_target_id end,
       case when v_target_type = 'paycheck' then v_target_id end,
       case when v_target_type = 'reimbursement_claim' then v_target_id end,
       case when v_target_type = 'statement' then v_target_id end)
    returning id into v_attachment_id;
  end if;

  v_result := jsonb_build_object(
    'commandId', p_command_id,
    'economicEventKey', p_economic_event_key,
    'idempotentReplay', false,
    'effects', jsonb_build_object(
      'attachmentId', v_attachment_id,
      'documentId', v_document_id,
      'alreadyAttached', v_existing_id is not null
    ),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  );

  perform public.keel_finish_command(
    p_command_id, 'documents.attach', p_economic_event_key, p_household_id, p_actor,
    v_hash, 'documents.attached', 'document_attachment', v_attachment_id,
    jsonb_build_object('documentId', v_document_id, 'targetType', v_target_type, 'targetId', v_target_id),
    v_result
  );

  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- keel_documents_list_household: every live document in the household with its
-- storage pointer + a live-attachment count. Powers (a) the "attach an
-- existing document" picker on a transaction, and (b) the storage-management
-- list. Read-only; storage pointers only (edge function signs URLs, Postgres
-- cannot). Deleted documents are excluded.
-- ---------------------------------------------------------------------------
create function public.keel_documents_list_household(p_household_id uuid)
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

  select coalesce(jsonb_agg(row order by row->>'createdAt' desc), '[]'::jsonb)
    into v_rows
    from (
      select jsonb_build_object(
        'documentId', d.id,
        'kind', d.kind,
        'originalFilename', d.original_filename,
        'storageBucket', dv.storage_bucket,
        'storagePath', dv.storage_path,
        'mimeType', dv.mime_type,
        'byteSize', dv.byte_size,
        'createdAt', d.created_at,
        'attachmentCount', (
          select count(*) from public.document_attachments da
           where da.document_id = d.id and da.detached_at is null
        )
      ) as row
      from public.documents d
      -- One storage version per document in this slice; if a document ever
      -- carries multiple content versions, take the most recent.
      join lateral (
        select dv.* from public.document_versions dv
         where dv.document_id = d.id
         order by dv.created_at desc
         limit 1
      ) dv on true
      where d.household_id = p_household_id and d.deleted_at is null
    ) t;

  return jsonb_build_object('rows', v_rows);
end;
$$;

-- ---------------------------------------------------------------------------
-- keel_documents_storage_summary: storage hygiene numbers for the founder's
-- Quicken-bloat worry. Pure metadata (byte_size lives in document_versions;
-- no bytes read). Surfaces total stored bytes, live vs deleted, and the
-- content-dedup saving (distinct sha256 vs version count) so the user can see
-- KEEL stays small.
-- ---------------------------------------------------------------------------
create function public.keel_documents_storage_summary(p_household_id uuid)
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
  v_result jsonb;
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

  select jsonb_build_object(
    'scope', jsonb_build_object('householdId', p_household_id),
    'liveDocuments', coalesce(count(distinct d.id) filter (where d.deleted_at is null), 0),
    'deletedDocuments', coalesce(count(distinct d.id) filter (where d.deleted_at is not null), 0),
    -- Bytes stored in Storage for LIVE documents (what actually counts toward
    -- the storage bill going forward; soft-deleted originals persist for the
    -- export/audit window but are not the growth the user manages).
    'liveBytes', coalesce(sum(dv.byte_size) filter (where d.deleted_at is null), 0)::text,
    'totalBytes', coalesce(sum(dv.byte_size), 0)::text,
    'versionCount', coalesce(count(dv.id), 0),
    -- Dedup: identical bytes re-uploaded for the same document are a no-op
    -- (unique (document_id, content_sha256)); this counts distinct content
    -- across the household so the UI can show "N unique files".
    'distinctContent', coalesce(count(distinct dv.content_sha256), 0),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  )
    into v_result
    from public.documents d
    join public.document_versions dv on dv.document_id = d.id
   where d.household_id = p_household_id;

  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- Ownership + grants (same _definer pattern as 20260717234500)
-- ---------------------------------------------------------------------------
grant create on schema public to keel_api;
alter function public.keel_cmd_documents_attach(uuid, text, jsonb, uuid, jsonb) owner to keel_api;
alter function public.keel_documents_list_household(uuid) owner to keel_api;
alter function public.keel_documents_storage_summary(uuid) owner to keel_api;
revoke create on schema public from keel_api;

revoke all on function public.keel_cmd_documents_attach(uuid, text, jsonb, uuid, jsonb) from public, anon;
revoke all on function public.keel_documents_list_household(uuid) from public, anon;
revoke all on function public.keel_documents_storage_summary(uuid) from public, anon;

grant execute on function public.keel_cmd_documents_attach(uuid, text, jsonb, uuid, jsonb) to authenticated;
grant execute on function public.keel_documents_list_household(uuid) to authenticated;
grant execute on function public.keel_documents_storage_summary(uuid) to authenticated;
