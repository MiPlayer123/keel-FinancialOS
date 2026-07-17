-- Attach-only documents (receipts/statements/paycheck stubs/reimbursement
-- proof). Deliberately the SMALLEST correct slice of BC-v2.1's "Documents and
-- receipts" contract (lines 181-194): immutable original + a plain many-
-- attachment-points link. No OCR/extraction/matching — that fuller pipeline
-- is researched (docs/research/RECEIPTS-2026-07-16.md) but explicitly
-- deferred; this migration only creates documents/document_versions and a
-- generic attachment row, never document_extractions/extracted_fields/
-- document_transaction_matches.
--
-- Storage buckets `receipts` and `statements` were already named in
-- INFRA.md §10; the `quarantine` bucket + malware-scan/promotion step is
-- part of the deferred pipeline and is NOT created here — the edge function
-- itself validates size/mime and computes the content hash synchronously
-- before the object is ever referenced by a documents row (no async worker
-- needed for a plain attach).

create type public.document_kind as enum ('receipt', 'statement');
create type public.document_target_type as enum (
  'transaction', 'paycheck', 'reimbursement_claim', 'statement'
);

create table public.documents (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id),
  entity_id uuid not null references public.entities (id),
  kind public.document_kind not null,
  original_filename text not null check (char_length(original_filename) between 1 and 255),
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  -- Soft delete only (Law 2/9: source preservation) — the storage object and
  -- every document_versions row persist for the export/audit window.
  deleted_at timestamptz
);

-- Immutable original (source preservation, BC-v2.1 invariant 2). One row per
-- distinct uploaded byte-content; re-uploading identical bytes for the same
-- document is a no-op via the unique constraint, not a new version.
create table public.document_versions (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents (id),
  storage_bucket text not null check (storage_bucket in ('receipts', 'statements')),
  storage_path text not null check (char_length(storage_path) between 1 and 1024),
  content_sha256 text not null check (char_length(content_sha256) = 64),
  mime_type text not null check (char_length(mime_type) between 1 and 127),
  byte_size bigint not null check (byte_size > 0 and byte_size <= 10485760),
  created_at timestamptz not null default now(),
  unique (document_id, content_sha256),
  unique (storage_bucket, storage_path)
);
create trigger document_versions_immutable
  before update or delete on public.document_versions
  for each row execute function public.keel_forbid_mutation();

-- Generic attachment: a document attached to EXACTLY one target row. Detach
-- is undo (Law 2) — soft, via detached_at/detached_by — never a delete, so a
-- confirmed attachment's history stays.
create table public.document_attachments (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id),
  document_id uuid not null references public.documents (id),
  canonical_transaction_id uuid references public.canonical_transactions (id),
  paycheck_id uuid references public.paychecks (id),
  -- reimbursement_claims has no standalone unique on `id` (household_id, id)
  -- composite PK only, same tenant-scoped pattern as its own FKs below.
  reimbursement_claim_id uuid,
  statement_id uuid references public.statements (id),
  attached_by uuid not null references auth.users (id),
  attached_at timestamptz not null default now(),
  detached_by uuid references auth.users (id),
  detached_at timestamptz,
  constraint fk_document_attachment_claim_tenant foreign key (household_id, reimbursement_claim_id)
    references public.reimbursement_claims (household_id, id),
  check (
    (case when canonical_transaction_id is not null then 1 else 0 end
     + case when paycheck_id is not null then 1 else 0 end
     + case when reimbursement_claim_id is not null then 1 else 0 end
     + case when statement_id is not null then 1 else 0 end) = 1
  )
);

create index documents_household_active on public.documents (household_id) where deleted_at is null;
create index document_versions_document on public.document_versions (document_id);
create index document_attachments_txn on public.document_attachments (canonical_transaction_id)
  where detached_at is null and canonical_transaction_id is not null;
create index document_attachments_paycheck on public.document_attachments (paycheck_id)
  where detached_at is null and paycheck_id is not null;
create index document_attachments_claim on public.document_attachments (reimbursement_claim_id)
  where detached_at is null and reimbursement_claim_id is not null;
create index document_attachments_statement on public.document_attachments (statement_id)
  where detached_at is null and statement_id is not null;

-- Fully locked down for the browser (BC-v2.1 §Documents: "browser: no direct
-- writes; reads only via api views"). Object access needs a signed URL,
-- which only the edge function (service_role) can mint, so there is no
-- useful direct SELECT for authenticated here either — everything goes
-- through the RPCs below.
revoke all on public.documents, public.document_versions, public.document_attachments
  from public, anon, authenticated;
alter table public.documents enable row level security;
alter table public.document_versions enable row level security;
alter table public.document_attachments enable row level security;

-- keel_api owns none of these tables and is deliberately non-BYPASSRLS
-- (matches every other definer role in this schema), so it needs both the
-- table grant AND a permissive RLS policy — same "_definer_all" pattern as
-- 20260710210500_grants_rls.sql. Authorization is enforced by the procs
-- below + the TS authz compiler, not by per-row policies at this layer.
grant select, insert on public.documents, public.document_versions, public.document_attachments
  to keel_api;
grant update (deleted_at) on public.documents to keel_api;
grant update (detached_at, detached_by) on public.document_attachments to keel_api;

create policy documents_definer_all on public.documents
  for all to keel_api using (true) with check (true);
create policy document_versions_definer_all on public.document_versions
  for all to keel_api using (true) with check (true);
create policy document_attachments_definer_all on public.document_attachments
  for all to keel_api using (true) with check (true);

-- ---------------------------------------------------------------------------
-- Storage: private buckets already named in INFRA.md §10.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('receipts', 'receipts', false, 10485760,
   array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']),
  ('statements', 'statements', false, 10485760,
   array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
on conflict (id) do nothing;

-- No storage.objects policies for anon/authenticated: every read/write goes
-- through signed URLs minted server-side by the edge function's service-role
-- client, which bypasses RLS entirely — matching the credential-envelope and
-- raw-provider-event precedent elsewhere in this schema (no browser-facing
-- bucket access at all).

-- ---------------------------------------------------------------------------
-- keel_documents_confirm_upload: durable write. Called by the edge function
-- AFTER it has downloaded the just-uploaded object from Storage and computed
-- content_sha256/byte_size/mime_type itself (Postgres cannot reach Storage),
-- so those values are attacker-uncontrolled by the time they reach this proc.
-- Idempotent on (household, document_id): a retried confirm for the same
-- document_id + identical inputs replays the same result.
-- ---------------------------------------------------------------------------
create function public.keel_documents_confirm_upload(
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
  v_version_id uuid;
  v_attachment_id uuid;
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

  insert into public.document_attachments
    (household_id, document_id, attached_by,
     canonical_transaction_id, paycheck_id, reimbursement_claim_id, statement_id)
  values
    (p_household_id, p_document_id, p_created_by,
     case when p_target_type = 'transaction' then p_target_id end,
     case when p_target_type = 'paycheck' then p_target_id end,
     case when p_target_type = 'reimbursement_claim' then p_target_id end,
     case when p_target_type = 'statement' then p_target_id end)
  returning id into v_attachment_id;

  v_result := jsonb_build_object(
    'commandId', v_command_id,
    'economicEventKey', v_key,
    'idempotentReplay', false,
    'effects', jsonb_build_object(
      'documentId', p_document_id,
      'documentVersionId', v_version_id,
      'attachmentId', v_attachment_id
    ),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  );

  perform public.keel_finish_command(
    v_command_id, 'documents.confirm_upload', v_key, p_household_id, v_actor,
    v_hash, 'documents.uploaded', 'document', p_document_id,
    jsonb_build_object('documentVersionId', v_version_id, 'attachmentId', v_attachment_id),
    v_result
  );

  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- keel_cmd_documents_detach / keel_cmd_documents_delete: ordinary command-
-- shaped procs (called via the generic /commands dispatch, same signature as
-- every other keel_cmd_* proc).
-- ---------------------------------------------------------------------------
create function public.keel_cmd_documents_detach(
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
  v_role public.household_role;
  v_attachment public.document_attachments%rowtype;
  v_reason text := btrim(coalesce(p_payload->>'reason', ''));
  v_result jsonb;
begin
  v_role := public.keel_assert_member_write(p_household_id);
  p_actor := public.keel_actor_from_jwt();
  v_replay := public.keel_idempotency_check(p_household_id, p_economic_event_key, v_hash);
  if v_replay is not null then
    return v_replay;
  end if;

  if char_length(v_reason) < 1 or char_length(v_reason) > 500 then
    raise exception 'KEEL_INVALID_COMMAND: reason must be 1-500 characters' using errcode = 'P0009';
  end if;

  select * into v_attachment
    from public.document_attachments
   where id = (p_payload->>'attachmentId')::uuid and household_id = p_household_id
   for update;
  if not found then
    raise exception 'KEEL_SCOPE_VIOLATION: attachment not in household' using errcode = 'P0006';
  end if;
  if v_attachment.detached_at is not null then
    raise exception 'KEEL_IMMUTABLE: attachment is already detached' using errcode = 'P0001';
  end if;

  update public.document_attachments
     set detached_at = now(),
         detached_by = (p_actor->>'userId')::uuid
   where id = v_attachment.id;

  v_result := jsonb_build_object(
    'commandId', p_command_id, 'economicEventKey', p_economic_event_key,
    'idempotentReplay', false,
    'effects', jsonb_build_object('attachmentId', v_attachment.id),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  );
  perform public.keel_finish_command(
    p_command_id, 'documents.detach', p_economic_event_key, p_household_id, p_actor,
    v_hash, 'documents.detached', 'document_attachment', v_attachment.id,
    jsonb_build_object('reason', v_reason), v_result
  );
  return v_result;
end;
$$;

create function public.keel_cmd_documents_delete(
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
  v_doc public.documents%rowtype;
  v_reason text := btrim(coalesce(p_payload->>'reason', ''));
  v_result jsonb;
begin
  perform public.keel_assert_member_write(p_household_id);
  p_actor := public.keel_actor_from_jwt();
  v_replay := public.keel_idempotency_check(p_household_id, p_economic_event_key, v_hash);
  if v_replay is not null then
    return v_replay;
  end if;

  if char_length(v_reason) < 1 or char_length(v_reason) > 500 then
    raise exception 'KEEL_INVALID_COMMAND: reason must be 1-500 characters' using errcode = 'P0009';
  end if;

  select * into v_doc
    from public.documents
   where id = (p_payload->>'documentId')::uuid and household_id = p_household_id
   for update;
  if not found then
    raise exception 'KEEL_SCOPE_VIOLATION: document not in household' using errcode = 'P0006';
  end if;
  if v_doc.deleted_at is not null then
    raise exception 'KEEL_IMMUTABLE: document is already deleted' using errcode = 'P0001';
  end if;

  update public.documents set deleted_at = now() where id = v_doc.id;
  update public.document_attachments
     set detached_at = now(), detached_by = (p_actor->>'userId')::uuid
   where document_id = v_doc.id and detached_at is null;

  v_result := jsonb_build_object(
    'commandId', p_command_id, 'economicEventKey', p_economic_event_key,
    'idempotentReplay', false,
    'effects', jsonb_build_object('documentId', v_doc.id),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  );
  perform public.keel_finish_command(
    p_command_id, 'documents.delete', p_economic_event_key, p_household_id, p_actor,
    v_hash, 'documents.deleted', 'document', v_doc.id,
    jsonb_build_object('reason', v_reason), v_result
  );
  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- keel_documents_list_for_target: read. Returns storage pointers, NOT signed
-- URLs — the edge function mints those per-row after this call (Postgres
-- cannot sign Storage URLs). Only non-detached attachments on non-deleted
-- documents are returned.
-- ---------------------------------------------------------------------------
create function public.keel_documents_list_for_target(
  p_household_id uuid,
  p_target_type public.document_target_type,
  p_target_id uuid
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
  if not exists (
    select 1 from public.household_memberships m
     where m.household_id = p_household_id and m.user_id = v_uid
  ) then
    raise exception 'KEEL_SCOPE_VIOLATION' using errcode = 'P0006';
  end if;

  select coalesce(jsonb_agg(row order by row->>'attachedAt' desc), '[]'::jsonb)
    into v_rows
    from (
      select jsonb_build_object(
        'attachmentId', da.id,
        'documentId', d.id,
        'kind', d.kind,
        'originalFilename', d.original_filename,
        'storageBucket', dv.storage_bucket,
        'storagePath', dv.storage_path,
        'mimeType', dv.mime_type,
        'byteSize', dv.byte_size,
        'attachedAt', da.attached_at
      ) as row
      from public.document_attachments da
      join public.documents d on d.id = da.document_id and d.deleted_at is null
      join public.document_versions dv on dv.document_id = d.id
      where da.household_id = p_household_id
        and da.detached_at is null
        and (
          (p_target_type = 'transaction' and da.canonical_transaction_id = p_target_id) or
          (p_target_type = 'paycheck' and da.paycheck_id = p_target_id) or
          (p_target_type = 'reimbursement_claim' and da.reimbursement_claim_id = p_target_id) or
          (p_target_type = 'statement' and da.statement_id = p_target_id)
        )
    ) t;

  return jsonb_build_object('rows', v_rows);
end;
$$;

-- ---------------------------------------------------------------------------
-- Ownership + grants
-- ---------------------------------------------------------------------------
grant create on schema public to keel_api;
alter function public.keel_documents_confirm_upload(
  uuid, uuid, uuid, public.document_kind, text, text, text, text, bigint, text, uuid,
  public.document_target_type, uuid
) owner to keel_api;
alter function public.keel_cmd_documents_detach(uuid, text, jsonb, uuid, jsonb) owner to keel_api;
alter function public.keel_cmd_documents_delete(uuid, text, jsonb, uuid, jsonb) owner to keel_api;
alter function public.keel_documents_list_for_target(uuid, public.document_target_type, uuid) owner to keel_api;
revoke create on schema public from keel_api;

revoke all on function public.keel_documents_confirm_upload(
  uuid, uuid, uuid, public.document_kind, text, text, text, text, bigint, text, uuid,
  public.document_target_type, uuid
) from public, anon;
revoke all on function public.keel_cmd_documents_detach(uuid, text, jsonb, uuid, jsonb) from public, anon;
revoke all on function public.keel_cmd_documents_delete(uuid, text, jsonb, uuid, jsonb) from public, anon;
revoke all on function public.keel_documents_list_for_target(uuid, public.document_target_type, uuid) from public, anon;

-- confirm_upload is called with the service-role client (the edge function
-- already verified the object server-side); detach/delete/list go through
-- the normal user-JWT command/query path like every other keel_cmd_*/keel_list_*.
grant execute on function public.keel_documents_confirm_upload(
  uuid, uuid, uuid, public.document_kind, text, text, text, text, bigint, text, uuid,
  public.document_target_type, uuid
) to service_role;
grant execute on function public.keel_cmd_documents_detach(uuid, text, jsonb, uuid, jsonb) to authenticated;
grant execute on function public.keel_cmd_documents_delete(uuid, text, jsonb, uuid, jsonb) to authenticated;
grant execute on function public.keel_documents_list_for_target(uuid, public.document_target_type, uuid) to authenticated;
