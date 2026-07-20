-- 20260721040000_overlay_writers_skip_distributions.sql
--
-- Distribution follow-up (Codex review Finding 3). The overlay writers decide
-- "single-offset, categorize it" by counting only is_category postings — so a
-- distribution (one category + a real-account transfer leg) still looked
-- single-offset and could gain a transaction_categories overlay, which
-- disagrees with the split-aware read models. keel_autocategorize_household had
-- NO split guard at all and was in fact re-adding a stray plaid_pfc overlay to
-- the re-booked paychecks after each sync. Fix: a shared
-- keel_txn_is_distribution() predicate (batch has >1 real-account posting)
-- injected into every writer's guard, and autocategorize also gains the
-- single-category guard the others already had. Then clean the stray overlays
-- off existing distributions (the read model already ignored them, so display
-- is unchanged — this just aligns stored state with intent).

create or replace function public.keel_txn_is_distribution(p_txn_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.journal_batches jb
      join public.journal_postings p on p.batch_id = jb.id
      join public.ledger_accounts la
        on la.id = p.ledger_account_id and la.is_category = false
     where jb.canonical_transaction_id = p_txn_id
       and jb.reverses_batch_id is null
       and not exists (
         select 1 from public.journal_revisions rev where rev.original_batch_id = jb.id
       )
     group by jb.id
    having count(*) > 1
  );
$$;
revoke all on function public.keel_txn_is_distribution(uuid) from public, anon;
grant execute on function public.keel_txn_is_distribution(uuid) to authenticated, service_role;

CREATE OR REPLACE FUNCTION public.keel_categorize_transaction(p_household_id uuid, p_txn_id uuid, p_category_ledger_account_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_entity     uuid;
  v_offsets    int;
  v_new_is_cat boolean;
  v_new_entity uuid;
  v_old        uuid;
begin
  if auth.uid() is null then
    raise exception 'KEEL_NOT_AUTHENTICATED' using errcode = 'P0004';
  end if;
  if not exists (
    select 1 from public.household_memberships
    where household_id = p_household_id and user_id = auth.uid()
  ) then
    raise exception 'KEEL_NOT_FOUND' using errcode = 'P0006';
  end if;

  select jp.entity_id, count(*) over ()
    into v_entity, v_offsets
    from public.canonical_transactions ct
    join public.journal_batches jb
      on jb.canonical_transaction_id = ct.id and jb.reverses_batch_id is null
     and not exists (
       select 1 from public.journal_revisions rev where rev.original_batch_id = jb.id
     )
    join public.journal_postings jp on jp.batch_id = jb.id
    join public.ledger_accounts la on la.id = jp.ledger_account_id and la.is_category = true
    where ct.id = p_txn_id and ct.household_id = p_household_id
    limit 1;
  if v_entity is null then
    raise exception 'KEEL_NOT_FOUND: transaction' using errcode = 'P0006';
  end if;
  if v_offsets > 1 or public.keel_txn_is_distribution(p_txn_id) then
    raise exception 'KEEL_INVALID_COMMAND: split transactions are categorized by their splits' using errcode = 'P0009';
  end if;

  select is_category, entity_id into v_new_is_cat, v_new_entity
    from public.ledger_accounts where id = p_category_ledger_account_id;
  if v_new_is_cat is not true or v_new_entity <> v_entity then
    raise exception 'KEEL_INVALID_COMMAND: invalid category' using errcode = 'P0009';
  end if;

  select category_ledger_account_id into v_old
    from public.transaction_categories where canonical_transaction_id = p_txn_id;

  insert into public.transaction_categories
    (canonical_transaction_id, household_id, category_ledger_account_id, source)
  values (p_txn_id, p_household_id, p_category_ledger_account_id, 'user')
  on conflict (canonical_transaction_id) do update
    set category_ledger_account_id = excluded.category_ledger_account_id,
        source = 'user', updated_at = now();

  insert into public.audit_log (household_id, actor, action, object_type, object_id, before, after)
  values (p_household_id, jsonb_build_object('kind', 'user', 'userId', auth.uid()),
          'transaction.categorize', 'canonical_transaction', p_txn_id,
          jsonb_build_object('categoryLedgerAccountId', v_old),
          jsonb_build_object('categoryLedgerAccountId', p_category_ledger_account_id));
end;
$function$;

CREATE OR REPLACE FUNCTION public.keel_apply_rules(p_household_id uuid, p_dry_run boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_categorized int := 0;
  v_renamed int := 0;
begin
  if auth.uid() is not null and not exists (
    select 1 from public.household_memberships
    where household_id = p_household_id and user_id = auth.uid()
  ) then
    raise exception 'KEEL_NOT_FOUND' using errcode = 'P0006';
  end if;

  drop table if exists _rule_winners;
  create temporary table _rule_winners on commit drop as
  with matches as (
    select ct.id as txn_id, r.id as rule_id,
           r.category_ledger_account_id, r.rename_to,
           r.priority, r.created_at, offcat.kind as txn_kind,
           rulecat.kind as rule_kind
      from public.canonical_transactions ct
      join public.journal_batches jb
        on jb.canonical_transaction_id = ct.id and jb.reverses_batch_id is null
      join public.journal_postings offp on offp.batch_id = jb.id
      join public.ledger_accounts offcat
        on offcat.id = offp.ledger_account_id and offcat.is_category = true
      join public.category_rules r
        on r.household_id = ct.household_id
       and r.active
       and position(lower(r.pattern) in lower(ct.description)) > 0
       -- C18 residual: optional amount-range condition, AND'd with the
       -- pattern match above. Null bound => always true (no-op).
       and (r.amount_min_minor is null or abs(offp.amount_minor) >= r.amount_min_minor)
       and (r.amount_max_minor is null or abs(offp.amount_minor) <= r.amount_max_minor)
      left join public.ledger_accounts rulecat on rulecat.id = r.category_ledger_account_id
      where ct.household_id = p_household_id
        and ct.voided_at is null
        -- Live batch only (sync revisions leave a superseded non-reversal batch).
        and not exists (
          select 1 from public.journal_revisions rev where rev.original_batch_id = jb.id
        )
        -- Same-entity invariant: a rule's category may only classify
        -- transactions of that category's entity (matches keel_categorize).
        and (r.category_ledger_account_id is null or rulecat.entity_id = offp.entity_id)
        -- Single-offset only: a split transaction is categorized by its
        -- splits, and the multi-way join would fan out per split.
        and (
          select count(*) from public.journal_postings p2
          join public.ledger_accounts l2 on l2.id = p2.ledger_account_id and l2.is_category
          where p2.batch_id = jb.id
        ) = 1
        -- Distribution guard (Codex Finding 3): a batch with >1 real-account
        -- posting is a distribution (paycheck + 401k transfer); categorized by
        -- its splits, never by a rule overlay.
        and not public.keel_txn_is_distribution(ct.id)
  )
  select distinct on (txn_id)
         txn_id, rule_id, category_ledger_account_id, rename_to, txn_kind, rule_kind
    from matches
    order by txn_id, priority, created_at, rule_id;

  if p_dry_run then
    select count(*) into v_categorized
      from _rule_winners w
      left join public.transaction_categories tc on tc.canonical_transaction_id = w.txn_id
      where w.category_ledger_account_id is not null
        and w.rule_kind = w.txn_kind
        and (tc.canonical_transaction_id is null
             or (tc.source <> 'user'
                 and tc.category_ledger_account_id <> w.category_ledger_account_id));
    select count(*) into v_renamed
      from _rule_winners w
      left join public.rule_renames rr on rr.canonical_transaction_id = w.txn_id
      where w.rename_to is not null
        and (rr.canonical_transaction_id is null or rr.display_name <> w.rename_to);
    return jsonb_build_object('dryRun', true, 'categorized', v_categorized, 'renamed', v_renamed);
  end if;

  insert into public.transaction_categories
    (canonical_transaction_id, household_id, category_ledger_account_id, source, rule_id)
  select w.txn_id, p_household_id, w.category_ledger_account_id, 'rule', w.rule_id
    from _rule_winners w
    where w.category_ledger_account_id is not null and w.rule_kind = w.txn_kind
  -- Predicate matches the dry-run count EXACTLY (preview integrity, BC §3):
  -- only rows whose category actually changes, never user rows. A plaid_pfc
  -- row already holding the same category keeps its provenance untouched.
  on conflict (canonical_transaction_id) do update
    set category_ledger_account_id = excluded.category_ledger_account_id,
        source = 'rule', rule_id = excluded.rule_id, updated_at = now()
    where transaction_categories.source <> 'user'
      and transaction_categories.category_ledger_account_id
            <> excluded.category_ledger_account_id;
  get diagnostics v_categorized = row_count;

  insert into public.rule_renames
    (canonical_transaction_id, household_id, rule_id, display_name)
  select w.txn_id, p_household_id, w.rule_id, w.rename_to
    from _rule_winners w
    where w.rename_to is not null
  on conflict (canonical_transaction_id) do update
    set rule_id = excluded.rule_id, display_name = excluded.display_name, updated_at = now()
    where rule_renames.display_name <> excluded.display_name
       or rule_renames.rule_id <> excluded.rule_id;
  get diagnostics v_renamed = row_count;

  if v_categorized > 0 or v_renamed > 0 then
    insert into public.audit_log (household_id, actor, action, object_type, object_id, after)
    values (p_household_id,
            case when auth.uid() is null
                 then jsonb_build_object('kind', 'system', 'source', 'rules_engine')
                 else jsonb_build_object('kind', 'user', 'userId', auth.uid()) end,
            'rules.apply', 'household', p_household_id,
            jsonb_build_object('categorized', v_categorized, 'renamed', v_renamed));
  end if;
  return jsonb_build_object('dryRun', false, 'categorized', v_categorized, 'renamed', v_renamed);
end;
$function$;

CREATE OR REPLACE FUNCTION public.keel_cmd_decide_category_suggestion(p_command_id uuid, p_economic_event_key text, p_actor jsonb, p_household_id uuid, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_hash text := public.keel_payload_hash(p_payload);
  v_replay jsonb;
  v_suggestion public.category_suggestions%rowtype;
  v_accept boolean;
  v_entity uuid;
  v_offsets int;
  v_offset_pfc text;
  v_overlay_source text;
  v_overlay_pfc text;
  v_cat public.ledger_accounts%rowtype;
  v_old uuid;
  v_new_status text;
  v_result jsonb;
begin
  perform public.keel_assert_member_write(p_household_id);
  p_actor := public.keel_actor_from_jwt();  -- ignore caller-supplied actor (forgery guard)
  v_replay := public.keel_idempotency_check(p_household_id, p_economic_event_key, v_hash);
  if v_replay is not null then
    return v_replay;
  end if;

  if coalesce(p_payload->>'suggestion_id', '') = '' then
    raise exception 'KEEL_INVALID_COMMAND: suggestion_id is required' using errcode = 'P0009';
  end if;
  if jsonb_typeof(p_payload->'accept') <> 'boolean' then
    raise exception 'KEEL_INVALID_COMMAND: accept must be a boolean' using errcode = 'P0009';
  end if;
  v_accept := (p_payload->>'accept')::boolean;

  -- Scope safety: the suggestion must belong to the commanding household.
  -- FOR UPDATE serializes two concurrent decisions with different keys; the
  -- second then sees a decided status and fails typed.
  select * into v_suggestion
    from public.category_suggestions
    where id = (p_payload->>'suggestion_id')::uuid
      and household_id = p_household_id
    for update;
  if not found then
    raise exception 'KEEL_SCOPE_VIOLATION: suggestion not in household' using errcode = 'P0006';
  end if;
  if v_suggestion.status <> 'suggested' then
    raise exception 'KEEL_INVALID_COMMAND: suggestion already decided' using errcode = 'P0009';
  end if;

  if v_accept then
    -- Same validation lattice as keel_categorize_transaction: live batch,
    -- single offset, category is a live same-entity classification target.
    select jp.entity_id, count(*) over (), la.pfc_key
      into v_entity, v_offsets, v_offset_pfc
      from public.canonical_transactions ct
      join public.journal_batches jb
        on jb.canonical_transaction_id = ct.id and jb.reverses_batch_id is null
       and not exists (
         select 1 from public.journal_revisions rev where rev.original_batch_id = jb.id
       )
      join public.journal_postings jp on jp.batch_id = jb.id
      join public.ledger_accounts la on la.id = jp.ledger_account_id and la.is_category = true
      where ct.id = v_suggestion.canonical_transaction_id
        and ct.household_id = p_household_id
        and ct.voided_at is null
      limit 1;
    if v_entity is null then
      raise exception 'KEEL_NOT_FOUND: transaction' using errcode = 'P0006';
    end if;
    if v_offsets > 1 or public.keel_txn_is_distribution(v_suggestion.canonical_transaction_id) then
      raise exception 'KEEL_INVALID_COMMAND: split transactions are categorized by their splits'
        using errcode = 'P0009';
    end if;

    select * into v_cat
      from public.ledger_accounts
      where id = v_suggestion.suggested_category_ledger_account_id;
    if v_cat.is_category is not true or v_cat.entity_id <> v_entity
       or v_cat.archived_at is not null then
      raise exception 'KEEL_INVALID_COMMAND: suggested category is no longer valid'
        using errcode = 'P0009';
    end if;

    select tc.category_ledger_account_id, tc.source, curla.pfc_key
      into v_old, v_overlay_source, v_overlay_pfc
      from public.transaction_categories tc
      left join public.ledger_accounts curla on curla.id = tc.category_ledger_account_id
      where tc.canonical_transaction_id = v_suggestion.canonical_transaction_id;

    -- Stale-suggestion guard (adversarial review P1-2a; Law 9 explicit
    -- ownership): between detection and this approval the user (or the
    -- preview→confirm rule apply) may have settled the classification. If
    -- the transaction's effective category is no longer machine-defaulted
    -- (an Uncategorized landing pad, or a plaid_pfc overlay), accepting
    -- would silently overwrite a human decision — fail typed instead. The
    -- read model hides such rows with the same predicate; this is the
    -- authoritative re-check under the row lock.
    if not (
      coalesce(case when v_old is not null then v_overlay_pfc else v_offset_pfc end, '')
        in ('uncategorized_expense', 'uncategorized_income')
      or coalesce(v_overlay_source, '') = 'plaid_pfc'
    ) then
      raise exception
        'KEEL_INVALID_COMMAND: suggestion is stale; this transaction was already categorized'
        using errcode = 'P0009';
    end if;

    -- Overlay upsert, source='user': the approval is a human decision, so the
    -- rules engine's "never a user row" guard now protects it (Law 2).
    insert into public.transaction_categories
      (canonical_transaction_id, household_id, category_ledger_account_id, source)
    values (v_suggestion.canonical_transaction_id, p_household_id,
            v_suggestion.suggested_category_ledger_account_id, 'user')
    on conflict (canonical_transaction_id) do update
      set category_ledger_account_id = excluded.category_ledger_account_id,
          source = 'user', rule_id = null, updated_at = now();

    v_new_status := 'accepted';
  else
    v_new_status := 'dismissed';
  end if;

  update public.category_suggestions
     set status = v_new_status,
         decided_at = now(),
         decided_by = (p_actor->>'userId')::uuid
   where id = v_suggestion.id;

  v_result := jsonb_build_object(
    'commandId', p_command_id,
    'economicEventKey', p_economic_event_key,
    'idempotentReplay', false,
    'effects', jsonb_build_object(
      'suggestionId', v_suggestion.id,
      'status', v_new_status,
      'canonicalTransactionId', v_suggestion.canonical_transaction_id,
      'categoryLedgerAccountId',
        case when v_accept then v_suggestion.suggested_category_ledger_account_id end,
      'previousCategoryLedgerAccountId', v_old
    ),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  );

  perform public.keel_finish_command(
    p_command_id, 'categorization.decide_suggestion', p_economic_event_key,
    p_household_id, p_actor, v_hash,
    'categorization.suggestion_decided', 'category_suggestion', v_suggestion.id,
    jsonb_build_object(
      'suggestionId', v_suggestion.id,
      'status', v_new_status,
      'canonicalTransactionId', v_suggestion.canonical_transaction_id,
      'categoryLedgerAccountId',
        case when v_accept then v_suggestion.suggested_category_ledger_account_id end,
      'previousCategoryLedgerAccountId', v_old
    ),
    v_result
  );

  return v_result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.keel_autocategorize_household(p_household_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_count int;
begin
  with mapped as (
    select distinct on (ct.id)
           ct.id as txn_id, ct.household_id, jp.entity_id, la.kind,
           public.keel_pfc_to_category_key(nsr.pfc_primary, la.kind) as cat_key
      from public.canonical_transactions ct
      join public.journal_batches jb
        on jb.canonical_transaction_id = ct.id and jb.reverses_batch_id is null
       -- Live batch only: a sign-flipping sync revision must not let the
       -- superseded batch's kind race the replacement's.
       and not exists (
         select 1 from public.journal_revisions rev where rev.original_batch_id = jb.id
       )
      join public.journal_postings jp on jp.batch_id = jb.id
      join public.ledger_accounts la on la.id = jp.ledger_account_id and la.is_category = true
      join public.transaction_source_links tsl on tsl.canonical_transaction_id = ct.id
      join public.normalized_source_records nsr
        on nsr.id = tsl.normalized_source_record_id
       and nsr.pfc_primary is not null
      where ct.household_id = p_household_id
        -- Only auto-file a SINGLE-category transaction; a split (multiple
        -- category offsets) or a distribution (extra real-account leg) is
        -- categorized by its postings and must not gain a stray plaid_pfc
        -- overlay (Codex Finding 3 — the other writers already skip splits).
        and (
          select count(*) from public.journal_postings p2
          join public.ledger_accounts l2 on l2.id = p2.ledger_account_id and l2.is_category = true
          where p2.batch_id = jb.id
        ) = 1
        and not public.keel_txn_is_distribution(ct.id)
      order by ct.id, nsr.pending asc, nsr.created_at desc, nsr.id
  )
  insert into public.transaction_categories
    (canonical_transaction_id, household_id, category_ledger_account_id, source)
  select m.txn_id, m.household_id, cat.id, 'plaid_pfc'
    from mapped m
    join public.ledger_accounts cat
      on cat.entity_id = m.entity_id and cat.pfc_key = m.cat_key
     and cat.is_category = true and cat.kind = m.kind and cat.archived_at is null
  on conflict (canonical_transaction_id) do nothing;
  get diagnostics v_count = row_count;

  if v_count > 0 then
    insert into public.audit_log (household_id, actor, action, object_type, object_id, after)
    values (p_household_id, jsonb_build_object('kind', 'system', 'source', 'plaid_pfc'),
            'transactions.autocategorize', 'household', p_household_id,
            jsonb_build_object('classified', v_count));
  end if;
  return v_count;
end;
$function$;


-- Clean stray overlays off existing distributions (multi real-account batches).
delete from public.transaction_categories tc
 where public.keel_txn_is_distribution(tc.canonical_transaction_id);
