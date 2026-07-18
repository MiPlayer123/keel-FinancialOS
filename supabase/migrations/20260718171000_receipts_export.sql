-- WS-J / FEEDBACK.md F-030 — Receipts export layer (Law 6: full export always
-- works). Adds the documents family to the household export:
--   * documents / document_versions / document_attachments — the attach-only
--     substrate (20260717234500) shipped WITHOUT export wiring (X-004 Law 6
--     gap, honestly excluded in pgTAP 008); folded in here now that the fuller
--     receipts layer ships.
--   * document_extractions / document_transaction_matches — new this slice.
--     The extracted merchant/amount/date and match reason_codes ARE exportable
--     user data (a business/LLC expense record wants its receipts + matches in
--     the export). raw_evidence is the verbatim model read — inert data, also
--     exported. No secrets: object bytes live in Storage (not a DB column);
--     the DTO exports the storage pointer, same as every other pointer.
--
-- Follows the chain idiom: rename the current outermost export to a
-- pre_receipts layer, then create a new keel_export_household that calls it and
-- merges the new table keys. keel_export runs WITH RLS, so each new table needs
-- a SELECT grant + a keel_export_select policy.

grant select on public.documents, public.document_versions, public.document_attachments,
  public.document_extractions, public.document_transaction_matches
  to keel_export;
create policy keel_export_select on public.documents
  for select to keel_export using (true);
create policy keel_export_select on public.document_versions
  for select to keel_export using (true);
create policy keel_export_select on public.document_attachments
  for select to keel_export using (true);
create policy keel_export_select on public.document_extractions
  for select to keel_export using (true);
create policy keel_export_select on public.document_transaction_matches
  for select to keel_export using (true);

alter function public.keel_export_household(uuid, timestamptz)
  rename to keel_export_household_pre_receipts;
revoke all on function public.keel_export_household_pre_receipts(uuid, timestamptz)
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
  v_base := public.keel_export_household_pre_receipts(p_household_id, p_as_of);

  select jsonb_build_object(
    'documents', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', d.id,
        'household_id', d.household_id,
        'entity_id', d.entity_id,
        'kind', d.kind::text,
        'original_filename', d.original_filename,
        'created_by', d.created_by,
        'created_at', to_char(d.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'deleted_at', case when d.deleted_at is null then null else to_char(d.deleted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end
      ) order by d.id)
      from public.documents d where d.household_id = p_household_id), '[]'::jsonb),
    'document_versions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', dv.id,
        'document_id', dv.document_id,
        'storage_bucket', dv.storage_bucket,
        'storage_path', dv.storage_path,
        'content_sha256', dv.content_sha256,
        'mime_type', dv.mime_type,
        'byte_size', dv.byte_size::text,
        'created_at', to_char(dv.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
      ) order by dv.id)
      from public.document_versions dv
      join public.documents d on d.id = dv.document_id
      where d.household_id = p_household_id), '[]'::jsonb),
    'document_attachments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', da.id,
        'household_id', da.household_id,
        'document_id', da.document_id,
        'canonical_transaction_id', da.canonical_transaction_id,
        'paycheck_id', da.paycheck_id,
        'reimbursement_claim_id', da.reimbursement_claim_id,
        'statement_id', da.statement_id,
        'attached_by', da.attached_by,
        'attached_at', to_char(da.attached_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'detached_by', da.detached_by,
        'detached_at', case when da.detached_at is null then null else to_char(da.detached_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end
      ) order by da.id)
      from public.document_attachments da where da.household_id = p_household_id), '[]'::jsonb),
    'document_extractions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', ex.id,
        'household_id', ex.household_id,
        'document_version_id', ex.document_version_id,
        'status', ex.status::text,
        'extractor', ex.extractor,
        'extractor_version', ex.extractor_version,
        'merchant', ex.merchant,
        'amount_minor', ex.amount_minor::text,
        'currency', ex.currency,
        'txn_date', case when ex.txn_date is null then null else to_char(ex.txn_date, 'YYYY-MM-DD') end,
        'confidence', ex.confidence::text,
        'raw_evidence', ex.raw_evidence,
        'error_code', ex.error_code,
        'created_at', to_char(ex.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
      ) order by ex.id)
      from public.document_extractions ex where ex.household_id = p_household_id), '[]'::jsonb),
    'document_transaction_matches', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', m.id,
        'household_id', m.household_id,
        'document_version_id', m.document_version_id,
        'canonical_transaction_id', m.canonical_transaction_id,
        'status', m.status::text,
        'score', m.score,
        'reason_codes', to_jsonb(m.reason_codes),
        'suggested_by', m.suggested_by,
        'attachment_id', m.attachment_id,
        'decided_by', m.decided_by,
        'decided_at', case when m.decided_at is null then null else to_char(m.decided_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end,
        'created_at', to_char(m.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
      ) order by m.id)
      from public.document_transaction_matches m where m.household_id = p_household_id), '[]'::jsonb)
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
