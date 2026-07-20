-- Issue #47 — single-source the statement draft-approval payload normalization
-- (CLAUDE.md Law 7 "ONE normalization compiler"; Law 11 approval-token binding;
--  Law 9 scope-safe/reproducible calculation).
--
-- PROBLEM. Two procs build the SAME server-normalized approve payload with two
-- separate, hand-copied expressions:
--   * keel_cmd_statements_issue_draft_approval (20260720250000) -> via the shared
--     helper keel_statement_draft_approval_payload;
--   * keel_cmd_statements_approve_draft (20260720180000) -> INLINED the identical
--     expression:
--       v_payload := (v_body - 'source_hash' - 'account_id' - 'balance_check')
--         || jsonb_build_object('account_id', draft.account_id::text,
--                               'source_hash', server_content_sha256,
--                               'balance_check', v_balance_check);
-- They are byte-identical TODAY, so issue-hash == redeem-hash and approvals pass.
-- But they can DRIFT: edit one expression and the other is unchanged, the issued
-- token's payload_sha256 no longer equals the approve-side hash, and EVERY draft
-- approval silently fails (KEEL_INVALID_COMMAND tamper) — a full-feature outage
-- with no schema error. Law 7 requires exactly one normalization compiler.
--
-- FIX. Refactor keel_cmd_statements_approve_draft so its v_payload comes from the
-- SAME helper the issue side already calls:
--     v_payload := public.keel_statement_draft_approval_payload(
--       p_household_id, v_draft.id, v_balance_check, v_body);
-- Now there is ONE expression; issue and redeem cannot diverge by construction.
-- (This mirrors the discipline already shipped in Slice 9, where issue/apply of
--  holdings share keel_statement_holdings_apply_payload.)
--
-- ORDERING SAFETY (why the STABLE helper's re-read is consistent in-txn):
--   1. approve already holds `for update` on the draft BEFORE building v_payload,
--      so no concurrent txn can change the draft while the helper re-reads it.
--   2. approve asserts the draft is status='extracted' BEFORE this point and only
--      flips it to 'approved' AFTER v_payload is built + the token is redeemed +
--      the statement is materialized. The helper's own status='extracted' guard
--      therefore always sees 'extracted' here — it can never see 'approved'.
--   3. The helper re-derives source_hash from document_versions.content_sha256 and
--      asserts draft.source_hash == that value — the SAME server fact approve just
--      asserted two statements earlier. approve still keeps its own document_versions
--      JOIN (it needs v_doc_id / v_entity_id for the attachment), so nothing else
--      about the command changes.
--   4. The helper is SECURITY DEFINER owned by keel_api and re-checks account
--      write access via keel_recurring_account_access (defense in depth) — approve
--      is also keel_api/definer, so the call is in-role and the JWT actor set for
--      the transaction is unchanged across the call.
-- Net: for an unchanged body the produced v_payload is character-for-character the
-- same value as before; the only change is WHERE that expression lives.
--
-- The body below is regenerated verbatim from the LIVE pg_get_functiondef output
-- (2026-07-19) with ONLY the v_payload construction swapped, so nothing else drifts.

create or replace function public.keel_cmd_statements_approve_draft(
  p_command_id uuid,
  p_economic_event_key text,
  p_actor jsonb,
  p_household_id uuid,
  p_payload jsonb
) returns jsonb
language plpgsql
security definer
set search_path = 'public'
as $function$
declare
  v_hash text := public.keel_payload_hash(p_payload);
  v_replay jsonb;
  v_actor jsonb;
  v_uid uuid;
  v_draft public.statement_drafts%rowtype;
  v_token_id uuid;
  v_balance_check text;
  v_server_source_hash text;
  v_doc_id uuid;
  v_entity_id uuid;
  v_body jsonb;
  v_payload jsonb;               -- THE ONE bound payload (server-normalized).
  v_statement uuid;
  v_attachment_id uuid;
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

  -- The command envelope: draftId + approvalTokenId + balanceCheck + statement.
  if jsonb_typeof(p_payload) <> 'object'
     or (p_payload - 'draft_id' - 'approval_token_id' - 'balance_check' - 'statement') <> '{}'::jsonb
     or coalesce(p_payload->>'draft_id', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or coalesce(p_payload->>'approval_token_id', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or coalesce(p_payload->>'balance_check', '') not in ('strict', 'anchor')
     or jsonb_typeof(p_payload->'statement') <> 'object' then
    raise exception 'KEEL_INVALID_COMMAND: malformed approve payload' using errcode = 'P0009';
  end if;

  v_token_id := (p_payload->>'approval_token_id')::uuid;
  v_balance_check := p_payload->>'balance_check';
  v_body := p_payload->'statement';

  -- Resolve the draft (locked) and its account scope.
  select * into v_draft
    from public.statement_drafts
   where household_id = p_household_id and id = (p_payload->>'draft_id')::uuid
   for update;
  if not found or not public.keel_recurring_account_access(p_household_id, v_draft.account_id, true) then
    raise exception 'KEEL_SCOPE_VIOLATION: draft not found' using errcode = 'P0006';
  end if;
  if v_draft.status = 'approved' then
    raise exception 'KEEL_IDEMPOTENCY_CONFLICT: draft already approved' using errcode = 'P0007';
  end if;
  if v_draft.status <> 'extracted' then
    raise exception 'KEEL_INVALID_COMMAND: only an extracted draft can be approved' using errcode = 'P0009';
  end if;

  -- SERVER-bind source_hash from document_versions.content_sha256 [A4]. The
  -- client's statement body must NOT carry source_hash — the server supplies it.
  -- (approve keeps its OWN document JOIN because it also needs v_doc_id/v_entity_id
  --  for the attachment below — the helper only returns the payload.)
  select dv.content_sha256, d.id, d.entity_id
    into v_server_source_hash, v_doc_id, v_entity_id
    from public.document_versions dv
    join public.documents d on d.id = dv.document_id
   where dv.id = v_draft.document_version_id;
  if v_server_source_hash is null then
    raise exception 'KEEL_SCOPE_VIOLATION: draft document version not found' using errcode = 'P0006';
  end if;
  -- The draft's recorded source_hash and the version's content_sha256 must agree
  -- (both are the same server fact; a mismatch means corruption).
  if v_draft.source_hash <> v_server_source_hash then
    raise exception 'KEEL_INVALID_COMMAND: draft source hash mismatch' using errcode = 'P0009';
  end if;

  -- Build THE ONE server-normalized payload via the SHARED helper — the exact
  -- same expression the ISSUE side hashed (keel_cmd_statements_issue_draft_approval
  -- -> keel_statement_draft_approval_payload). Single normalization compiler
  -- (Law 7): issue-hash and redeem-hash cannot diverge because there is now only
  -- ONE expression. The helper is STABLE and re-reads the (already for-update
  -- locked, still-extracted) draft + its document version, so the value it returns
  -- is character-for-character identical to the previous inline construction:
  --   (v_body - 'source_hash' - 'account_id' - 'balance_check')
  --   || {account_id: draft.account_id, source_hash: server_sha, balance_check: v_balance_check}
  v_payload := public.keel_statement_draft_approval_payload(
    p_household_id, v_draft.id, v_balance_check, v_body
  );

  -- (a) REDEEM the token against THE SAME v_payload (one-use, tamper-evident,
  -- expiry-enforcing, actor+command+version-bound). If the client approved a
  -- different body, hash(v_payload) != token.payload_sha256 -> reject.
  perform public.keel_approval_token_redeem(
    p_household_id, v_token_id, p_command_id, v_actor,
    'statements.approve_draft', v_payload, 1
  );

  -- (b) MATERIALIZE the SAME v_payload. The exact bytes approved are the exact
  -- bytes written — there is no other payload variable in scope. (Anchor-mode
  -- validation semantics land in 20260720190000; this passes v_payload through
  -- unchanged with balance_check now part of the normalized body.)
  v_statement := public.keel_statement_validate_and_materialize(p_household_id, v_payload, v_actor);

  -- Attach the source file to the new statement (existing mechanism).
  insert into public.document_attachments
    (household_id, document_id, attached_by, statement_id)
  values
    (p_household_id, v_doc_id, v_uid, v_statement)
  returning id into v_attachment_id;

  -- Flip the draft -> approved + record the produced statement.
  update public.statement_drafts
     set status = 'approved', statement_id = v_statement,
         decided_by = v_uid, decided_at = now()
   where id = v_draft.id;

  v_after := jsonb_build_object(
    'draftId', v_draft.id, 'status', 'approved',
    'statementId', v_statement, 'attachmentId', v_attachment_id,
    'approvalTokenId', v_token_id
  );
  v_result := jsonb_build_object(
    'commandId', p_command_id, 'economicEventKey', p_economic_event_key,
    'idempotentReplay', false, 'effects', v_after,
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  );
  perform public.keel_finish_command(
    p_command_id, 'statements.approve_draft', p_economic_event_key, p_household_id, v_actor,
    v_hash, 'statements.draft_approved', 'statement', v_statement, v_after, v_result
  );
  return v_result;
exception
  when unique_violation then
    raise exception 'KEEL_IDEMPOTENCY_CONFLICT: duplicate statement source' using errcode = 'P0007';
end;
$function$;

-- ---------------------------------------------------------------------------
-- Ownership + grants ritual (verbatim idiom from 20260720180000). CREATE OR
-- REPLACE preserves ownership/grants, but re-assert fail-closed so a future move
-- of this proc cannot silently land under the wrong owner.
-- ---------------------------------------------------------------------------
grant create on schema public to keel_api;
alter function public.keel_cmd_statements_approve_draft(uuid, text, jsonb, uuid, jsonb) owner to keel_api;
revoke create on schema public from keel_api;

revoke all on function public.keel_cmd_statements_approve_draft(uuid, text, jsonb, uuid, jsonb) from public, anon;
grant execute on function public.keel_cmd_statements_approve_draft(uuid, text, jsonb, uuid, jsonb) to authenticated;

-- Ownership assertion (fail-closed): the token-bound command stays keel_api.
do $$
begin
  if exists (
    select 1 from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     join pg_roles r on r.oid = p.proowner
     where n.nspname = 'public'
       and p.proname = 'keel_cmd_statements_approve_draft'
       and p.prosecdef and r.rolname <> 'keel_api'
  ) then
    raise exception 'KEEL_OWNERSHIP: approve_draft not owned by keel_api';
  end if;
end$$;
