-- fix(statements): keel_list_statement_payment_links must emit exactly one row
-- per payment link.
--
-- The read model joined journal_postings filtered only by `la.is_category =
-- false`, so a matched payment transaction with more than one real-account
-- posting (a card payoff is a transfer: card leg + funding leg — BOTH
-- non-category) multiplied the link into N rows (pgTAP 035 "read model returns
-- the one active link": have 2, want 1). The display amount for a statement
-- payment is the posting on the STATEMENT's own account, so join through the
-- statement -> account and pick that single posting (mirrors how the suggester
-- resolves the card-side inflow). Body otherwise unchanged.

create or replace function public.keel_list_statement_payment_links(
  p_household_id uuid,
  p_statement_id uuid
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
  if not public.keel_statement_access(p_household_id, p_statement_id, false) then
    raise exception 'KEEL_SCOPE_VIOLATION' using errcode = 'P0006';
  end if;

  select coalesce(jsonb_agg(row order by row->>'status', row->>'txnDate' desc, row->>'linkId'), '[]'::jsonb)
    into v_rows
    from (
      select jsonb_build_object(
        'linkId', pl.id,
        'status', pl.status,
        'score', pl.score,
        'reasonCodes', to_jsonb(pl.reason_codes),
        'matcherVersion', pl.matcher_version,
        'transferLinkId', pl.transfer_link_id,
        'transactionId', pl.canonical_transaction_id,
        'txnDate', to_char(ct.effective_date, 'YYYY-MM-DD'),
        'txnDescription', left(coalesce(tov.display_description, ct.description), 140),
        'txnAmountMinor', p.amount_minor::text,
        'currency', p.currency
      ) as row
      from public.statement_payment_links pl
      join public.statements st on st.id = pl.statement_id
      join public.accounts sa on sa.id = st.account_id
      join public.canonical_transactions ct on ct.id = pl.canonical_transaction_id
      join public.journal_batches jb
        on jb.canonical_transaction_id = ct.id and jb.reverses_batch_id is null
       and not exists (
         select 1 from public.journal_revisions rev where rev.original_batch_id = jb.id
       )
      -- The payment amount shown is the posting on the STATEMENT's own account
      -- (the card-side leg), never the funding/offset leg — so a transfer-shaped
      -- payoff yields one row, not one per real-account posting.
      join public.journal_postings p
        on p.batch_id = jb.id and p.ledger_account_id = sa.ledger_account_id
      left join public.transaction_overrides tov on tov.canonical_transaction_id = ct.id
      where pl.household_id = p_household_id
        and pl.statement_id = p_statement_id
        and pl.status in ('suggested', 'confirmed')
    ) t;

  return jsonb_build_object(
    'scope', jsonb_build_object('householdId', p_household_id, 'statementId', p_statement_id),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'formulaVersion', 'statement-payment-links-v1',
    'rows', v_rows
  );
end;
$$;
