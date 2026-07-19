-- SLICE 7 (statement-ingestion-v2.md §10 UI slice 1) — issue an approval token
-- for a statement-draft approval, bound to the EXACT server-normalized payload
-- the approve command will redeem.
--
-- Law 11 (approval tokens bind exact payload) + the SLICE 0 GATE advisory A:
-- "the exact bytes approved = exact bytes executed" holds only if the ISSUE side
-- hashes the SAME normalized payload the REDEEM side rebuilds. This proc is that
-- guarantee, implemented once: it reconstructs v_payload with the CHARACTER-FOR-
-- CHARACTER same expression as keel_cmd_statements_approve_draft (20260720180000
-- L713-718) —
--
--   v_payload := (v_body - 'source_hash' - 'account_id' - 'balance_check')
--     || jsonb_build_object('account_id', draft.account_id::text,
--                           'source_hash', server_content_sha256,
--                           'balance_check', v_balance_check);
--
-- — then calls keel_approval_token_issue over that value. Because the SAME
-- account_id/source_hash/balance_check the approve command forces are forced
-- here too (never trusting the client body), keel_payload_hash(v_payload) at
-- ISSUE == keel_payload_hash(v_payload) at REDEEM. A client that tampered the
-- statement body between issue and approve changes the hash on the approve side
-- and the redeem rejects it (KEEL_INVALID_COMMAND tamper). The client cannot
-- forge the binding by design: it never supplies source_hash/account_id, and it
-- passes the identical `statement` object to BOTH calls.
--
-- Ownership/grant ritual mirrors 20260720180000 exactly: owned by keel_api,
-- EXECUTE to authenticated (fail-closed inside via keel_recurring_account_access).

create function public.keel_statement_draft_approval_payload(
  p_household_id uuid,
  p_draft_id uuid,
  p_balance_check text,
  p_statement jsonb
) returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_draft public.statement_drafts%rowtype;
  v_server_source_hash text;
begin
  -- Envelope shape: balance_check strict|anchor, statement is an object.
  if p_balance_check is null or p_balance_check not in ('strict', 'anchor')
     or p_statement is null or jsonb_typeof(p_statement) <> 'object' then
    raise exception 'KEEL_INVALID_COMMAND: malformed draft-approval payload' using errcode = 'P0009';
  end if;

  -- Resolve the draft (its account is the ONLY account_id we will trust) and
  -- assert write access to it — same account-scoped gate [A10] the approve
  -- command uses. A draft the actor cannot write is "not found" (fail closed).
  select * into v_draft
    from public.statement_drafts
   where household_id = p_household_id and id = p_draft_id;
  if not found or not public.keel_recurring_account_access(p_household_id, v_draft.account_id, true) then
    raise exception 'KEEL_SCOPE_VIOLATION: draft not found' using errcode = 'P0006';
  end if;
  if v_draft.status <> 'extracted' then
    raise exception 'KEEL_INVALID_COMMAND: only an extracted draft can be approved' using errcode = 'P0009';
  end if;

  -- SERVER-bind source_hash from document_versions.content_sha256 [A4] — the
  -- same server fact the approve command binds. The client body's source_hash
  -- (if any) is discarded below.
  select dv.content_sha256 into v_server_source_hash
    from public.document_versions dv
   where dv.id = v_draft.document_version_id;
  if v_server_source_hash is null or v_draft.source_hash <> v_server_source_hash then
    raise exception 'KEEL_INVALID_COMMAND: draft source hash mismatch' using errcode = 'P0009';
  end if;

  -- THE ONE normalized payload — identical expression to
  -- keel_cmd_statements_approve_draft. account_id forced to the draft account,
  -- source_hash forced to the server content hash, balance_check stamped in.
  return (p_statement - 'source_hash' - 'account_id' - 'balance_check')
    || jsonb_build_object(
         'account_id', v_draft.account_id::text,
         'source_hash', v_server_source_hash,
         'balance_check', p_balance_check
       );
end;
$$;

-- keel_cmd_statements_issue_draft_approval — mint the approval token over that
-- normalized payload. Command bound to 'statements.approve_draft' (what the
-- approve proc redeems), proposal_kind 'statement_approve_draft', proposal
-- version 1 (matches the redeem call's p_proposal_version=1), account-scoped to
-- the draft account, short TTL (5 min, same as the signed-URL TTL). Returns the
-- issue result (tokenId, payloadSha256, expiresAt) verbatim.
create function public.keel_cmd_statements_issue_draft_approval(
  p_household_id uuid,
  p_draft_id uuid,
  p_balance_check text,
  p_statement jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor jsonb := public.keel_actor_from_jwt();
  v_draft public.statement_drafts%rowtype;
  v_payload jsonb;
begin
  perform public.keel_assert_member_write(p_household_id);

  -- Build the normalized payload via the shared helper (one normalization).
  v_payload := public.keel_statement_draft_approval_payload(
    p_household_id, p_draft_id, p_balance_check, p_statement
  );

  select * into v_draft
    from public.statement_drafts
   where household_id = p_household_id and id = p_draft_id;

  -- Issue a token bound to v_payload for the approve command. keel_approval_token_issue
  -- re-checks membership + account write access itself (defense in depth).
  return public.keel_approval_token_issue(
    p_household_id,
    v_actor,                                  -- ignored inside (JWT actor is trusted)
    'statements.approve_draft',               -- command the token redeems against
    v_payload,                                -- normalized_payload -> hashed
    jsonb_build_object('householdId', p_household_id, 'accountId', v_draft.account_id),
    v_draft.account_id,                        -- account scope [A10]
    'statement_approve_draft',                 -- proposal_kind
    p_draft_id,                                -- proposal_ref
    1,                                         -- proposal_version (redeem uses 1)
    'statement-ingestion-v2',                  -- policy_version
    300                                        -- ttl seconds (5 min)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Ownership + grants ritual (verbatim idiom from 20260720180000).
-- ---------------------------------------------------------------------------
grant create on schema public to keel_api;
alter function public.keel_statement_draft_approval_payload(uuid, uuid, text, jsonb) owner to keel_api;
alter function public.keel_cmd_statements_issue_draft_approval(uuid, uuid, text, jsonb) owner to keel_api;
revoke create on schema public from keel_api;

-- The normalization helper is internal: only the issue proc (and, by identical
-- expression, the approve proc) build this shape; clients never call it directly.
revoke all on function public.keel_statement_draft_approval_payload(uuid, uuid, text, jsonb)
  from public, anon, authenticated;
revoke all on function public.keel_cmd_statements_issue_draft_approval(uuid, uuid, text, jsonb)
  from public, anon;
grant execute on function public.keel_cmd_statements_issue_draft_approval(uuid, uuid, text, jsonb)
  to authenticated, keel_api;

-- ---------------------------------------------------------------------------
-- keel_statement_draft_detail — the extraction header + lines + holdings for ONE
-- draft, so the review dialog can prefill EVERY editable field (period, opening,
-- ending, each line, holdings preview). Account-scoped [A10]; viewer role. The
-- list query (keel_list_statement_drafts) only returns counts — this is the
-- on-demand detail read a reviewer needs before approving.
-- ---------------------------------------------------------------------------
create function public.keel_statement_draft_detail(
  p_household_id uuid,
  p_draft_id uuid
) returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_uid uuid := coalesce(
    nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
    nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid;
  v_draft public.statement_drafts%rowtype;
  v_ex public.statement_extractions%rowtype;
  v_lines jsonb;
  v_holdings jsonb;
begin
  if v_uid is null then
    raise exception 'KEEL_NOT_AUTHENTICATED' using errcode = 'P0004';
  end if;

  select * into v_draft
    from public.statement_drafts
   where household_id = p_household_id and id = p_draft_id;
  -- Account-scoped read gate [A10]: a draft on an account the actor cannot read
  -- is "not found" (fail closed, never confirm existence cross-scope).
  if not found or not public.keel_recurring_account_access(p_household_id, v_draft.account_id, false) then
    raise exception 'KEEL_SCOPE_VIOLATION: draft not found' using errcode = 'P0006';
  end if;

  if v_draft.extraction_id is not null then
    select * into v_ex from public.statement_extractions
     where household_id = p_household_id and id = v_draft.extraction_id;

    select coalesce(jsonb_agg(jsonb_build_object(
             'lineNo', l.line_no,
             'date', l.line_date,
             'amountMinor', l.amount_minor::text,
             'description', l.description_raw,
             'currency', l.currency
           ) order by l.line_no, l.id), '[]'::jsonb)
      into v_lines
      from public.statement_extraction_lines l
     where l.household_id = p_household_id and l.extraction_id = v_draft.extraction_id;

    select coalesce(jsonb_agg(jsonb_build_object(
             'symbol', h.symbol,
             'cusip', h.cusip,
             'isin', h.isin,
             'name', h.name,
             'qty', h.qty::text,
             'priceMinor', h.price_minor::text,
             'valueMinor', h.value_minor::text,
             'costBasisMinor', h.cost_basis_minor::text,
             'currency', h.currency
           ) order by h.symbol, h.id), '[]'::jsonb)
      into v_holdings
      from public.statement_extraction_holdings h
     where h.household_id = p_household_id and h.extraction_id = v_draft.extraction_id;
  end if;

  return jsonb_build_object(
    'scope', jsonb_build_object('householdId', p_household_id),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'formulaVersion', 'statement-draft-detail-v1',
    'draftId', v_draft.id,
    'accountId', v_draft.account_id,
    'status', v_draft.status,
    'extraction', case when v_ex.id is null then null else jsonb_build_object(
      'extractionId', v_ex.id,
      'kindHint', v_ex.kind_hint,
      'status', v_ex.status,
      'periodStart', v_ex.period_start,
      'periodEnd', v_ex.period_end,
      'openingMinor', v_ex.opening_minor::text,
      'endingMinor', v_ex.ending_minor::text,
      'currency', v_ex.currency,
      'confidence', v_ex.confidence
    ) end,
    'lines', coalesce(v_lines, '[]'::jsonb),
    'holdings', coalesce(v_holdings, '[]'::jsonb)
  );
end;
$$;

grant create on schema public to keel_api;
alter function public.keel_statement_draft_detail(uuid, uuid) owner to keel_api;
revoke create on schema public from keel_api;
revoke all on function public.keel_statement_draft_detail(uuid, uuid) from public, anon;
grant execute on function public.keel_statement_draft_detail(uuid, uuid) to authenticated, keel_api;

-- Ownership assertion (fail-closed): all new definer procs owned by keel_api.
do $$
begin
  if exists (
    select 1 from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     join pg_roles r on r.oid = p.proowner
     where n.nspname = 'public'
       and p.proname in ('keel_statement_draft_approval_payload',
                         'keel_cmd_statements_issue_draft_approval',
                         'keel_statement_draft_detail')
       and p.prosecdef and r.rolname <> 'keel_api'
  ) then
    raise exception 'KEEL_OWNERSHIP: issue-draft-approval proc not owned by keel_api';
  end if;
end$$;
