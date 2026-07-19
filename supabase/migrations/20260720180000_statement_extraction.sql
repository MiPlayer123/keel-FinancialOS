-- SLICE 3 (statement-ingestion-v2.md §5 first migration) — statement
-- extraction staging + tenant content registry + token-bound draft approval.
--
-- Builds ON TOP of SLICE 0 (20260720100000_approval_tokens.sql, live): the
-- approval-token primitive (keel_approval_token_redeem) and the ONE shared
-- keel_statement_validate_and_materialize(household, payload, actor) helper.
--
-- Laws honoured here:
--  * Law 5 (data-tier isolation): every extracted string (bank memos, OFX
--    NAME/MEMO, symbol names) is inert DATA. raw_evidence is jsonb that is only
--    ever read back as text, never executed, never a fetch/tool trigger.
--  * Law 9 (source preservation + idempotent economics + explicit ownership):
--    extractions/lines/holdings are append-only immutable; the persist proc is
--    replay-idempotent per (household, document_version, extractor, version); an
--    extraction is a SUGGESTION (a draft), never silently promoted to a
--    statement — promotion requires an explicit token-bound approval.
--  * Law 11 (approval tokens bind exact payload/actor/scope/version/expiry):
--    keel_cmd_statements_approve_draft binds ONE local v_payload and passes THE
--    SAME variable to keel_approval_token_redeem AND
--    keel_statement_validate_and_materialize inside ONE transaction — the exact
--    bytes approved are provably the exact bytes materialized. This is the HARD
--    GATE (advisory A carried forward from Slice 0).
--  * Law 7 (one authorization compiler): the draft list uses the account-scoped
--    gate keel_recurring_account_access(...,false) [A10], never household-only.
--  * Law 2 (soft delete / reversible): dismiss is a status flip, never a delete;
--    approved/dismissed are terminal (a terminal-state-lock trigger forbids any
--    transition OUT of them).
--  * Law 4 (money is BIGINT minor units; enums over strings).
--
-- Grant shape mirrors 20260718170000 receipts exactly: worker-facing write proc
-- SECURITY DEFINER owned by keel_worker (service_role-only); user-facing
-- read/command procs owned by keel_api (authenticated path, fail-closed).
-- Export chain follows the receipts/approval-token rename-then-wrap idiom.

-- ===========================================================================
-- Enums
-- ===========================================================================
create type public.statement_extract_kind as enum ('bank', 'card', 'investment', 'unknown');
create type public.statement_draft_status as enum ('pending', 'extracted', 'failed', 'approved', 'dismissed');

-- ===========================================================================
-- statement_extractions — one typed extraction per (household, document_version,
-- extractor, extractor_version). Append-only; replay-idempotent via the unique
-- key. Every extracted field is inert DATA (Law 5). raw_evidence is inert jsonb.
-- ===========================================================================
create table public.statement_extractions (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id),
  document_version_id uuid not null references public.document_versions (id),
  account_id uuid not null,
  kind_hint public.statement_extract_kind not null default 'unknown',
  period_start date,
  period_end date,
  opening_minor bigint,
  ending_minor bigint,
  currency text check (currency is null or currency ~ '^[A-Z]{3}$'),
  -- Provenance (Law 11): who/what read this and with which prompt/model.
  extractor text not null check (char_length(extractor) between 1 and 100),
  extractor_version text not null check (char_length(extractor_version) between 1 and 100),
  model_version text check (model_version is null or char_length(model_version) between 1 and 100),
  prompt_version text check (prompt_version is null or char_length(prompt_version) between 1 and 100),
  confidence numeric(4, 3) check (confidence is null or (confidence >= 0 and confidence <= 1)),
  -- Verbatim model/parse response, retained as inert evidence (Law 5).
  raw_evidence jsonb not null default '{}'::jsonb check (jsonb_typeof(raw_evidence) = 'object'),
  status public.extraction_status not null,
  error_code text check (error_code is null or char_length(error_code) between 1 and 100),
  created_at timestamptz not null default now(),
  unique (household_id, document_version_id, extractor, extractor_version),
  -- Composite tenant FK: the account must belong to this household (cross-tenant
  -- reference smuggling fails closed — same idiom as approval_tokens).
  constraint fk_statement_extraction_account_tenant
    foreign key (household_id, account_id) references public.accounts (household_id, id)
);
create trigger statement_extractions_immutable
  before update or delete on public.statement_extractions
  for each row execute function public.keel_forbid_mutation();

create index statement_extractions_version on public.statement_extractions (document_version_id);
create index statement_extractions_household on public.statement_extractions (household_id);
create index statement_extractions_account on public.statement_extractions (household_id, account_id);

-- ===========================================================================
-- statement_extraction_lines — typed BIGINT amount per line (Law 4), immutable.
-- Per-field provenance columns record where each datum came from in the source
-- (page/bbox/row/col/byte offset for CSV/PDF, ofx_path for OFX) so a material
-- number is reproducible back to the source rows (BC-v2.1 §9.1). null_reason
-- explains a field the extractor could not read (never a guess).
-- ===========================================================================
create table public.statement_extraction_lines (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id),
  extraction_id uuid not null references public.statement_extractions (id),
  line_no int not null check (line_no >= 0 and line_no <= 5000),
  line_date date,
  amount_minor bigint,
  description_raw text check (description_raw is null or char_length(description_raw) <= 2000),
  currency text check (currency is null or currency ~ '^[A-Z]{3}$'),
  -- Per-field provenance (all nullable; the extractor fills what it can prove).
  src_page int,
  src_bbox text check (src_bbox is null or char_length(src_bbox) <= 200),
  src_row int,
  src_col int,
  src_byte_offset bigint,
  ofx_path text check (ofx_path is null or char_length(ofx_path) <= 500),
  field_confidence numeric(4, 3) check (field_confidence is null or (field_confidence >= 0 and field_confidence <= 1)),
  null_reason text check (null_reason is null or char_length(null_reason) <= 200),
  created_at timestamptz not null default now(),
  unique (household_id, extraction_id, line_no)
);
create trigger statement_extraction_lines_immutable
  before update or delete on public.statement_extraction_lines
  for each row execute function public.keel_forbid_mutation();

create index statement_extraction_lines_extraction
  on public.statement_extraction_lines (household_id, extraction_id);

-- ===========================================================================
-- statement_extraction_holdings — investment positions. CUSIP/ISIN carried, not
-- symbol-alone. qty is a decimal STRING stored as numeric (NOT money, never
-- summed as minor units); the money columns are BIGINT minor units (Law 4).
-- Immutable.
-- ===========================================================================
create table public.statement_extraction_holdings (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id),
  extraction_id uuid not null references public.statement_extractions (id),
  symbol text not null check (char_length(symbol) between 1 and 100),
  cusip text check (cusip is null or char_length(cusip) <= 20),
  isin text check (isin is null or char_length(isin) <= 20),
  name text check (name is null or char_length(name) <= 300),
  qty numeric,
  price_minor bigint,
  value_minor bigint,
  cost_basis_minor bigint,
  currency text check (currency is null or currency ~ '^[A-Z]{3}$'),
  src_page int,
  src_bbox text check (src_bbox is null or char_length(src_bbox) <= 200),
  ofx_path text check (ofx_path is null or char_length(ofx_path) <= 500),
  field_confidence numeric(4, 3) check (field_confidence is null or (field_confidence >= 0 and field_confidence <= 1)),
  null_reason text check (null_reason is null or char_length(null_reason) <= 200),
  created_at timestamptz not null default now(),
  unique (household_id, extraction_id, symbol)
);
create trigger statement_extraction_holdings_immutable
  before update or delete on public.statement_extraction_holdings
  for each row execute function public.keel_forbid_mutation();

create index statement_extraction_holdings_extraction
  on public.statement_extraction_holdings (household_id, extraction_id);

-- ===========================================================================
-- document_hashes — tenant content registry [A4]. confirm-upload's document_id
-- is fresh per upload and document_versions unique is document-local
-- (document_id, content_sha256), so re-uploads never dedupe across documents.
-- This registry is household-scoped by (household_id, content_sha256): the FIRST
-- upload of a given byte-content in a household wins; a later
-- `insert ... on conflict do nothing returning` sees no row -> the upload is a
-- tenant re-upload (duplicate) and must not spawn a second draft.
-- ===========================================================================
create table public.document_hashes (
  household_id uuid not null references public.households (id),
  content_sha256 text not null check (content_sha256 ~ '^[a-f0-9]{64}$'),
  first_document_id uuid not null,
  first_version_id uuid not null,
  byte_size bigint not null,
  created_at timestamptz not null default now(),
  primary key (household_id, content_sha256)
);
create trigger document_hashes_immutable
  before update or delete on public.document_hashes
  for each row execute function public.keel_forbid_mutation();

-- ===========================================================================
-- statement_drafts — the ingest lifecycle record. One draft per document_version
-- (unique), account NON-NULL (ingest always targets an account — [A3]).
-- source_hash is bound from the SERVER document_versions.content_sha256 [A4].
-- unique(household_id, account_id, source_hash): one live ingest per file per
-- account. Terminal-state-lock trigger forbids transition OUT of
-- approved/dismissed (Law 2 reversible only up to a terminal decision).
-- ===========================================================================
create table public.statement_drafts (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id),
  document_version_id uuid not null unique references public.document_versions (id),
  account_id uuid not null,
  source_hash text not null check (source_hash ~ '^[a-f0-9]{64}$'),
  status public.statement_draft_status not null default 'pending',
  extraction_id uuid references public.statement_extractions (id),
  statement_id uuid,
  decided_by uuid references auth.users (id),
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  unique (household_id, account_id, source_hash),
  constraint fk_statement_draft_account_tenant
    foreign key (household_id, account_id) references public.accounts (household_id, id),
  constraint fk_statement_draft_statement_tenant
    foreign key (household_id, statement_id) references public.statements (household_id, id)
);
create index statement_drafts_household_status on public.statement_drafts (household_id, status);
create index statement_drafts_account on public.statement_drafts (household_id, account_id);

-- Terminal-state-lock: once a draft is approved or dismissed it is frozen. Every
-- other transition is allowed (pending->extracted/failed, extracted->approved/
-- dismissed, failed->extracted on re-extract). A DELETE is never allowed (Law 2:
-- soft-delete; dismissed IS the soft delete).
create function public.keel_statement_draft_guard() returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'KEEL_IMMUTABLE: statement drafts are never deleted (dismiss instead)'
      using errcode = 'P0001';
  end if;
  if old.status in ('approved', 'dismissed') then
    raise exception 'KEEL_IMMUTABLE: statement draft % is terminal (%) and cannot change', old.id, old.status
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger statement_drafts_terminal_lock
  before update or delete on public.statement_drafts
  for each row execute function public.keel_statement_draft_guard();

-- ===========================================================================
-- Lockdown: browser never writes these; reads go through the procs below.
-- ===========================================================================
revoke all on public.statement_extractions, public.statement_extraction_lines,
  public.statement_extraction_holdings, public.document_hashes, public.statement_drafts
  from public, anon, authenticated;
alter table public.statement_extractions enable row level security;
alter table public.statement_extraction_lines enable row level security;
alter table public.statement_extraction_holdings enable row level security;
alter table public.document_hashes enable row level security;
alter table public.statement_drafts enable row level security;

-- keel_api owns the user-facing read/command procs.
grant select on public.statement_extractions, public.statement_extraction_lines,
  public.statement_extraction_holdings to keel_api;
grant select, insert on public.document_hashes to keel_api;
grant select, insert, update on public.statement_drafts to keel_api;
create policy statement_extractions_definer_all on public.statement_extractions
  for all to keel_api using (true) with check (true);
create policy statement_extraction_lines_definer_all on public.statement_extraction_lines
  for all to keel_api using (true) with check (true);
create policy statement_extraction_holdings_definer_all on public.statement_extraction_holdings
  for all to keel_api using (true) with check (true);
create policy document_hashes_definer_all on public.document_hashes
  for all to keel_api using (true) with check (true);
create policy statement_drafts_definer_all on public.statement_drafts
  for all to keel_api using (true) with check (true);

-- keel_worker owns the persist proc. It must read document_versions/documents to
-- scope-check (receipts already granted it those reads in 20260718170000) and
-- write the extraction family + flip the draft. Grant + policy those here.
grant select, insert on public.statement_extractions to keel_worker;
grant select, insert on public.statement_extraction_lines to keel_worker;
grant select, insert on public.statement_extraction_holdings to keel_worker;
grant select, update on public.statement_drafts to keel_worker;
create policy statement_extractions_worker_all on public.statement_extractions
  for all to keel_worker using (true) with check (true);
create policy statement_extraction_lines_worker_all on public.statement_extraction_lines
  for all to keel_worker using (true) with check (true);
create policy statement_extraction_holdings_worker_all on public.statement_extraction_holdings
  for all to keel_worker using (true) with check (true);
create policy statement_drafts_worker_all on public.statement_drafts
  for all to keel_worker using (true) with check (true);

-- ===========================================================================
-- keel_worker_persist_statement_extraction — worker-only. Atomic parent +
-- children insert in ONE transaction (the whole proc is one statement's txn).
-- Idempotent per (household, document_version, extractor, extractor_version): a
-- replayed job no-ops (on-conflict do nothing) and returns the existing id
-- rather than duplicating an economic read (Law 9). Money arrives as decimal
-- STRINGS and is cast ::bigint (exact; never a float — Law 4). Flips the draft
-- pending -> extracted|failed. line_no > 5000 is rejected BEFORE building the
-- child arrays [A9].
--
-- p_lines / p_holdings are jsonb arrays; the worker composed them from the pure
-- parser output. They are inert here — this proc only casts + inserts.
-- ===========================================================================
create function public.keel_worker_persist_statement_extraction(
  p_household_id uuid,
  p_document_version_id uuid,
  p_account_id uuid,
  p_status public.extraction_status,
  p_kind_hint public.statement_extract_kind,
  p_period_start date,
  p_period_end date,
  p_opening_minor text,
  p_ending_minor text,
  p_currency text,
  p_extractor text,
  p_extractor_version text,
  p_model_version text,
  p_prompt_version text,
  p_confidence numeric,
  p_raw_evidence jsonb,
  p_error_code text,
  p_lines jsonb,
  p_holdings jsonb
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_line jsonb;
  v_holding jsonb;
  v_draft_status public.statement_draft_status;
begin
  -- Defence in depth: the document_version must belong to the claimed household
  -- AND the account must belong to it too (never trust the caller's scope).
  if not exists (
    select 1
      from public.document_versions dv
      join public.documents d on d.id = dv.document_id
     where dv.id = p_document_version_id and d.household_id = p_household_id
  ) then
    raise exception 'KEEL_NOT_FOUND: document version not in household' using errcode = 'P0006';
  end if;
  if not exists (
    select 1 from public.accounts a
     where a.household_id = p_household_id and a.id = p_account_id
  ) then
    raise exception 'KEEL_NOT_FOUND: account not in household' using errcode = 'P0006';
  end if;

  -- Reject an out-of-bounds line_no BEFORE we do any child insert [A9]. A
  -- hostile/oversized parse must fail closed, not build a 100k-row array.
  if p_lines is not null and jsonb_typeof(p_lines) = 'array' then
    if exists (
      select 1 from jsonb_array_elements(p_lines) l
       where (l->>'line_no') is null
          or (l->>'line_no') !~ '^[0-9]+$'
          or (l->>'line_no')::bigint > 5000
          or (l->>'line_no')::bigint < 0
    ) then
      raise exception 'KEEL_INVALID_COMMAND: statement line_no out of range' using errcode = 'P0009';
    end if;
  end if;

  -- Idempotent parent insert.
  insert into public.statement_extractions
    (household_id, document_version_id, account_id, kind_hint, period_start, period_end,
     opening_minor, ending_minor, currency, extractor, extractor_version, model_version,
     prompt_version, confidence, raw_evidence, status, error_code)
  values
    (p_household_id, p_document_version_id, p_account_id,
     coalesce(p_kind_hint, 'unknown'), p_period_start, p_period_end,
     case when p_opening_minor is null or btrim(p_opening_minor) = '' then null
          else p_opening_minor::bigint end,
     case when p_ending_minor is null or btrim(p_ending_minor) = '' then null
          else p_ending_minor::bigint end,
     p_currency, p_extractor, p_extractor_version, p_model_version, p_prompt_version,
     p_confidence, coalesce(p_raw_evidence, '{}'::jsonb), p_status, p_error_code)
  on conflict (household_id, document_version_id, extractor, extractor_version) do nothing
  returning id into v_id;

  if v_id is null then
    -- Replay: the extraction already exists. Return it unchanged; do NOT
    -- re-insert children (they are immutable and already present).
    select id into v_id from public.statement_extractions
     where household_id = p_household_id
       and document_version_id = p_document_version_id
       and extractor = p_extractor and extractor_version = p_extractor_version;
    return v_id;
  end if;

  -- Children — only on the first (winning) insert. Money strings ::bigint.
  if p_lines is not null and jsonb_typeof(p_lines) = 'array' then
    for v_line in select value from jsonb_array_elements(p_lines) loop
      insert into public.statement_extraction_lines
        (household_id, extraction_id, line_no, line_date, amount_minor, description_raw,
         currency, src_page, src_bbox, src_row, src_col, src_byte_offset, ofx_path,
         field_confidence, null_reason)
      values
        (p_household_id, v_id, (v_line->>'line_no')::int,
         nullif(v_line->>'line_date', '')::date,
         case when v_line->>'amount_minor' is null or btrim(v_line->>'amount_minor') = '' then null
              else (v_line->>'amount_minor')::bigint end,
         v_line->>'description_raw', v_line->>'currency',
         nullif(v_line->>'src_page', '')::int, v_line->>'src_bbox',
         nullif(v_line->>'src_row', '')::int, nullif(v_line->>'src_col', '')::int,
         nullif(v_line->>'src_byte_offset', '')::bigint, v_line->>'ofx_path',
         nullif(v_line->>'field_confidence', '')::numeric, v_line->>'null_reason');
    end loop;
  end if;

  if p_holdings is not null and jsonb_typeof(p_holdings) = 'array' then
    for v_holding in select value from jsonb_array_elements(p_holdings) loop
      insert into public.statement_extraction_holdings
        (household_id, extraction_id, symbol, cusip, isin, name, qty, price_minor,
         value_minor, cost_basis_minor, currency, src_page, src_bbox, ofx_path,
         field_confidence, null_reason)
      values
        (p_household_id, v_id, v_holding->>'symbol', v_holding->>'cusip', v_holding->>'isin',
         v_holding->>'name', nullif(v_holding->>'qty', '')::numeric,
         case when v_holding->>'price_minor' is null or btrim(v_holding->>'price_minor') = '' then null
              else (v_holding->>'price_minor')::bigint end,
         case when v_holding->>'value_minor' is null or btrim(v_holding->>'value_minor') = '' then null
              else (v_holding->>'value_minor')::bigint end,
         case when v_holding->>'cost_basis_minor' is null or btrim(v_holding->>'cost_basis_minor') = '' then null
              else (v_holding->>'cost_basis_minor')::bigint end,
         v_holding->>'currency', nullif(v_holding->>'src_page', '')::int, v_holding->>'src_bbox',
         v_holding->>'ofx_path', nullif(v_holding->>'field_confidence', '')::numeric,
         v_holding->>'null_reason')
      on conflict (household_id, extraction_id, symbol) do nothing;
    end loop;
  end if;

  -- Flip the draft (if one exists for this version) pending -> extracted|failed.
  -- Only pending drafts move; a re-run against an already-decided draft is a
  -- no-op (the terminal-lock trigger would refuse an approved/dismissed anyway).
  v_draft_status := case when p_status = 'failed' then 'failed'::public.statement_draft_status
                         else 'extracted'::public.statement_draft_status end;
  update public.statement_drafts
     set status = v_draft_status, extraction_id = v_id
   where household_id = p_household_id
     and document_version_id = p_document_version_id
     and status = 'pending';

  return v_id;
end;
$$;

-- ===========================================================================
-- keel_list_statement_drafts — user READ. Account-scoped [A10]: a viewer sees a
-- draft only for accounts they can access (keel_recurring_account_access with
-- write=false), NOT household-wide. Returns each draft with its latest
-- extraction summary and a discrepancy preview = the ledger balance at
-- period_end MINUS the extracted ending (the same period-bounded ledger sum the
-- reconciliation-close proc computes), so the reviewer sees the gap before they
-- approve.
-- ===========================================================================
create function public.keel_list_statement_drafts(p_household_id uuid)
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
        -- Discrepancy preview: ledger balance at period_end - extracted ending.
        -- Reproduced from the account's postings summed through period_end in
        -- the extraction currency (same formula as keel_reconciliation_close).
        -- Null when there is no extracted ending yet.
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
        -- Account-scoped gate [A10]: only drafts on accounts this actor can read.
        and public.keel_recurring_account_access(p_household_id, dr.account_id, false)
    ) t;

  return jsonb_build_object(
    'scope', jsonb_build_object('householdId', p_household_id),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'formulaVersion', 'statement-drafts-v1',
    'rows', v_rows
  );
end;
$$;

-- ===========================================================================
-- keel_cmd_statements_dismiss_draft — user command (class B, Law 10). Flip an
-- extracted/failed/pending draft to 'dismissed' (Law 2: reversible up to this
-- terminal decision; never a hard delete). Full envelope ritual.
-- ===========================================================================
create function public.keel_cmd_statements_dismiss_draft(
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
  v_actor jsonb;
  v_uid uuid;
  v_draft public.statement_drafts%rowtype;
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

  if jsonb_typeof(p_payload) <> 'object'
     or (p_payload - 'draft_id') <> '{}'::jsonb
     or coalesce(p_payload->>'draft_id', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception 'KEEL_INVALID_COMMAND: malformed dismiss payload' using errcode = 'P0009';
  end if;

  select * into v_draft
    from public.statement_drafts
   where household_id = p_household_id and id = (p_payload->>'draft_id')::uuid
   for update;
  if not found or not public.keel_recurring_account_access(p_household_id, v_draft.account_id, true) then
    raise exception 'KEEL_SCOPE_VIOLATION: draft not found' using errcode = 'P0006';
  end if;
  if v_draft.status in ('approved', 'dismissed') then
    raise exception 'KEEL_INVALID_COMMAND: draft already terminal' using errcode = 'P0009';
  end if;

  update public.statement_drafts
     set status = 'dismissed', decided_by = v_uid, decided_at = now()
   where id = v_draft.id;

  v_after := jsonb_build_object('draftId', v_draft.id, 'status', 'dismissed');
  v_result := jsonb_build_object(
    'commandId', p_command_id, 'economicEventKey', p_economic_event_key,
    'idempotentReplay', false, 'effects', v_after,
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  );
  perform public.keel_finish_command(
    p_command_id, 'statements.dismiss_draft', p_economic_event_key, p_household_id, v_actor,
    v_hash, 'statements.draft_dismissed', 'statement_draft', v_draft.id, v_after, v_result
  );
  return v_result;
end;
$$;

-- ===========================================================================
-- keel_cmd_statements_approve_draft — THE TOKEN-BOUND COMMAND (HARD GATE,
-- advisory A). Class B (Law 10). Promotes an extracted draft into a real
-- statement.
--
-- THE GATE (Law 11): the server normalizes ONE local v_payload (the statement
-- body: account_id/period/opening/ending/currency/lines + the SERVER-bound
-- source_hash) and passes THE SAME v_payload variable to BOTH:
--   (a) keel_approval_token_redeem(...)               — proves it == approved
--   (b) keel_statement_validate_and_materialize(...)  — materializes it
-- inside ONE transaction. There is no second payload variable in scope, so it is
-- impossible by construction to redeem body A and materialize body B.
--
-- source_hash is bound from the SERVER document_versions.content_sha256 for this
-- draft's document_version — NEVER from the client payload [A4]. Any client-
-- supplied source_hash is ignored: the server strips it and re-binds the true
-- one before hashing, so the token's payload_sha256 (issued over the same
-- server-normalized body) matches only if the client approved the true source.
-- ===========================================================================
create function public.keel_cmd_statements_approve_draft(
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

  -- Build THE ONE server-normalized payload. account_id is forced to the DRAFT's
  -- account (never the client's), balanceCheck is stamped in, and source_hash is
  -- the SERVER content_sha256 — any client-supplied source_hash/account_id is
  -- overwritten. This single value is what gets both redeemed AND materialized.
  v_payload := (v_body - 'source_hash' - 'account_id' - 'balance_check')
    || jsonb_build_object(
         'account_id', v_draft.account_id::text,
         'source_hash', v_server_source_hash,
         'balance_check', v_balance_check
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
$$;

-- ===========================================================================
-- Ownership + grants
-- ===========================================================================
-- Worker persist proc: owned by keel_worker (least-privilege), service_role only.
grant create on schema public to keel_worker;
alter function public.keel_worker_persist_statement_extraction(uuid, uuid, uuid, public.extraction_status, public.statement_extract_kind, date, date, text, text, text, text, text, text, text, numeric, jsonb, text, jsonb, jsonb) owner to keel_worker;
revoke create on schema public from keel_worker;

-- User procs: owned by keel_api, authenticated execute (fail-closed inside).
grant create on schema public to keel_api;
alter function public.keel_list_statement_drafts(uuid) owner to keel_api;
alter function public.keel_cmd_statements_dismiss_draft(uuid, text, jsonb, uuid, jsonb) owner to keel_api;
alter function public.keel_cmd_statements_approve_draft(uuid, text, jsonb, uuid, jsonb) owner to keel_api;
revoke create on schema public from keel_api;

revoke all on function public.keel_worker_persist_statement_extraction(uuid, uuid, uuid, public.extraction_status, public.statement_extract_kind, date, date, text, text, text, text, text, text, text, numeric, jsonb, text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.keel_list_statement_drafts(uuid) from public, anon;
revoke all on function public.keel_cmd_statements_dismiss_draft(uuid, text, jsonb, uuid, jsonb) from public, anon;
revoke all on function public.keel_cmd_statements_approve_draft(uuid, text, jsonb, uuid, jsonb) from public, anon;

grant execute on function public.keel_worker_persist_statement_extraction(uuid, uuid, uuid, public.extraction_status, public.statement_extract_kind, date, date, text, text, text, text, text, text, text, numeric, jsonb, text, jsonb, jsonb) to service_role;
grant execute on function public.keel_list_statement_drafts(uuid) to authenticated;
grant execute on function public.keel_cmd_statements_dismiss_draft(uuid, text, jsonb, uuid, jsonb) to authenticated;
grant execute on function public.keel_cmd_statements_approve_draft(uuid, text, jsonb, uuid, jsonb) to authenticated;

-- Ownership assertion (fail-closed): the new definer procs must be owned by the
-- right least-privilege role; keel_worker/keel_api must stay non-super, non-BYPASSRLS.
do $$
begin
  if (select r.rolname from pg_proc p join pg_roles r on r.oid = p.proowner
        where p.oid = 'public.keel_worker_persist_statement_extraction(uuid,uuid,uuid,public.extraction_status,public.statement_extract_kind,date,date,text,text,text,text,text,text,text,numeric,jsonb,text,jsonb,jsonb)'::regprocedure)
     <> 'keel_worker' then
    raise exception 'KEEL_OWNERSHIP: persist proc not owned by keel_worker';
  end if;
  if exists (
    select 1 from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     join pg_roles r on r.oid = p.proowner
     where n.nspname = 'public'
       and p.proname in ('keel_list_statement_drafts',
                         'keel_cmd_statements_dismiss_draft',
                         'keel_cmd_statements_approve_draft')
       and p.prosecdef and r.rolname <> 'keel_api'
  ) then
    raise exception 'KEEL_OWNERSHIP: statement draft proc not owned by keel_api';
  end if;
  if not exists (
    select 1 from pg_roles where rolname = 'keel_worker' and rolsuper = false and rolbypassrls = false
  ) or not exists (
    select 1 from pg_roles where rolname = 'keel_api' and rolcanlogin = false and rolsuper = false and rolbypassrls = false
  ) then
    raise exception 'KEEL_OWNERSHIP: invalid worker/api role';
  end if;
end$$;

-- ===========================================================================
-- Export (Law 6). All 5 new tables join the audited export contract. Every
-- column is portable household data; raw_evidence is inert ledger-adjacent
-- evidence (a verbatim parser/model read of an already-exported source file),
-- carrying no secrets — the same reasoning as approval_tokens.normalized_payload,
-- and the json-secret export scan guards it. Rename-then-wrap idiom (receipts /
-- approval-tokens chain).
-- ===========================================================================
grant select on public.statement_extractions, public.statement_extraction_lines,
  public.statement_extraction_holdings, public.document_hashes, public.statement_drafts
  to keel_export;
create policy statement_extractions_export on public.statement_extractions
  for select to keel_export using (true);
create policy statement_extraction_lines_export on public.statement_extraction_lines
  for select to keel_export using (true);
create policy statement_extraction_holdings_export on public.statement_extraction_holdings
  for select to keel_export using (true);
create policy document_hashes_export on public.document_hashes
  for select to keel_export using (true);
create policy statement_drafts_export on public.statement_drafts
  for select to keel_export using (true);

alter function public.keel_export_household(uuid, timestamptz)
  rename to keel_export_household_pre_statement_extraction;
revoke all on function public.keel_export_household_pre_statement_extraction(uuid, timestamptz)
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
  v_base := public.keel_export_household_pre_statement_extraction(p_household_id, p_as_of);

  select jsonb_build_object(
    'statement_extractions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', e.id, 'household_id', e.household_id, 'document_version_id', e.document_version_id,
        'account_id', e.account_id, 'kind_hint', e.kind_hint::text,
        'period_start', e.period_start, 'period_end', e.period_end,
        'opening_minor', e.opening_minor::text, 'ending_minor', e.ending_minor::text,
        'currency', e.currency, 'extractor', e.extractor, 'extractor_version', e.extractor_version,
        'model_version', e.model_version, 'prompt_version', e.prompt_version,
        'confidence', e.confidence, 'raw_evidence', e.raw_evidence,
        'status', e.status::text, 'error_code', e.error_code,
        'created_at', to_char(e.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
      ) order by e.id)
      from public.statement_extractions e where e.household_id = p_household_id), '[]'::jsonb),
    'statement_extraction_lines', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', l.id, 'household_id', l.household_id, 'extraction_id', l.extraction_id,
        'line_no', l.line_no, 'line_date', l.line_date, 'amount_minor', l.amount_minor::text,
        'description_raw', l.description_raw, 'currency', l.currency,
        'src_page', l.src_page, 'src_bbox', l.src_bbox, 'src_row', l.src_row,
        'src_col', l.src_col, 'src_byte_offset', l.src_byte_offset::text, 'ofx_path', l.ofx_path,
        'field_confidence', l.field_confidence, 'null_reason', l.null_reason,
        'created_at', to_char(l.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
      ) order by l.household_id, l.id)
      from public.statement_extraction_lines l where l.household_id = p_household_id), '[]'::jsonb),
    'statement_extraction_holdings', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', h.id, 'household_id', h.household_id, 'extraction_id', h.extraction_id,
        'symbol', h.symbol, 'cusip', h.cusip, 'isin', h.isin, 'name', h.name,
        'qty', h.qty::text, 'price_minor', h.price_minor::text, 'value_minor', h.value_minor::text,
        'cost_basis_minor', h.cost_basis_minor::text, 'currency', h.currency,
        'src_page', h.src_page, 'src_bbox', h.src_bbox, 'ofx_path', h.ofx_path,
        'field_confidence', h.field_confidence, 'null_reason', h.null_reason,
        'created_at', to_char(h.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
      ) order by h.household_id, h.id)
      from public.statement_extraction_holdings h where h.household_id = p_household_id), '[]'::jsonb),
    'document_hashes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'household_id', dh.household_id, 'content_sha256', dh.content_sha256,
        'first_document_id', dh.first_document_id, 'first_version_id', dh.first_version_id,
        'byte_size', dh.byte_size::text,
        'created_at', to_char(dh.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
      ) order by dh.content_sha256)
      from public.document_hashes dh where dh.household_id = p_household_id), '[]'::jsonb),
    'statement_drafts', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', dr.id, 'household_id', dr.household_id, 'document_version_id', dr.document_version_id,
        'account_id', dr.account_id, 'source_hash', dr.source_hash, 'status', dr.status::text,
        'extraction_id', dr.extraction_id, 'statement_id', dr.statement_id,
        'decided_by', dr.decided_by,
        'decided_at', case when dr.decided_at is null then null else to_char(dr.decided_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end,
        'created_at', to_char(dr.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
      ) order by dr.id)
      from public.statement_drafts dr where dr.household_id = p_household_id), '[]'::jsonb)
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
