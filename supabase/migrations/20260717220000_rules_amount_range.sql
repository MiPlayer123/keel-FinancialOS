-- C18 residual: rules multi-condition→action (design/TEARDOWN-STATUS-2026-07-17.md
-- queue item C18; BC-v2.1 §3 rules). The dry-run preview count already
-- shipped (20260713040000/20260713100000); the rule builder itself only
-- supported ONE condition (description_contains). This adds a second,
-- optional condition dimension — an amount RANGE, AND'd with the existing
-- pattern match — the smallest deterministic extension that covers a real
-- pattern ("subscriptions over $50") without a rule-builder rewrite
-- (Law 1: matching stays pure SQL, no LLM anywhere in the loop).
--
-- Semantics: amount_min_minor/amount_max_minor bound the MAGNITUDE (absolute
-- value) of the transaction's cash-leg amount, not its signed value — a rule
-- author thinks "over $50" regardless of whether the leg happens to be an
-- outflow (negative) or inflow (positive) in the ledger's sign convention
-- (apps/web/src/lib/money.ts / category-picker.ts: negative = expense,
-- positive = income). Both columns nullable and independent; either, both,
-- or neither may be set. Both null is the ORIGINAL shape exactly — Law 9
-- backward compatibility: every existing single-condition rule keeps
-- matching precisely as before, because a null bound is a no-op AND branch.
-- Proven in supabase/tests/020_rules_amount_range.sql.

alter table public.category_rules
  add column if not exists amount_min_minor bigint,
  add column if not exists amount_max_minor bigint;

alter table public.category_rules
  drop constraint if exists category_rules_amount_min_nonneg;
alter table public.category_rules
  add constraint category_rules_amount_min_nonneg
    check (amount_min_minor is null or amount_min_minor >= 0);

alter table public.category_rules
  drop constraint if exists category_rules_amount_max_nonneg;
alter table public.category_rules
  add constraint category_rules_amount_max_nonneg
    check (amount_max_minor is null or amount_max_minor >= 0);

alter table public.category_rules
  drop constraint if exists category_rules_amount_range_order;
alter table public.category_rules
  add constraint category_rules_amount_range_order
    check (amount_min_minor is null or amount_max_minor is null
           or amount_min_minor <= amount_max_minor);

comment on column public.category_rules.amount_min_minor is
  'Optional AND condition (C18 residual): matches only when abs(cash-leg amount_minor) >= this value. BIGINT minor units, non-negative. Null = no lower bound. Both this and amount_max_minor null reproduces the original single-condition (pattern-only) rule exactly.';
comment on column public.category_rules.amount_max_minor is
  'Optional AND condition (C18 residual): matches only when abs(cash-leg amount_minor) <= this value. BIGINT minor units, non-negative. Null = no upper bound.';

-- ---------------------------------------------------------------------------
-- keel_rule_save: signature gains two optional trailing bigint params.
-- Signature change => drop first (grants die with the old signature;
-- restated below for the new one) — same convention as 20260713180000's
-- keel_goal_save p_kind extension and 20260717180000's keel_apply_account_
-- balance rebuild.
-- ---------------------------------------------------------------------------
drop function public.keel_rule_save(uuid, uuid, text, uuid, text, integer, boolean);

create function public.keel_rule_save(
  p_household_id uuid,
  p_rule_id uuid,
  p_pattern text,
  p_category_ledger_account_id uuid,
  p_rename_to text,
  p_priority integer,
  p_active boolean,
  p_amount_min_minor bigint default null,
  p_amount_max_minor bigint default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entity uuid;
  v_pattern text := btrim(coalesce(p_pattern, ''));
  v_rename text := nullif(btrim(coalesce(p_rename_to, '')), '');
  v_id uuid;
  v_before jsonb;
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
  if char_length(v_pattern) < 2 or char_length(v_pattern) > 140 then
    raise exception 'KEEL_INVALID_COMMAND: pattern must be 2-140 characters' using errcode = 'P0009';
  end if;
  if p_category_ledger_account_id is null and v_rename is null then
    raise exception 'KEEL_INVALID_COMMAND: a rule needs a category or a rename' using errcode = 'P0009';
  end if;
  -- Amount-range condition validation (C18 residual). Mirrors the same
  -- non-negative-magnitude + ordered-bounds check enforced by the table's
  -- CHECK constraints, so a bad payload fails fast with a typed error
  -- instead of a bare constraint-violation from the INSERT/UPDATE below.
  if p_amount_min_minor is not null and p_amount_min_minor < 0 then
    raise exception 'KEEL_INVALID_COMMAND: amount_min_minor must be >= 0' using errcode = 'P0009';
  end if;
  if p_amount_max_minor is not null and p_amount_max_minor < 0 then
    raise exception 'KEEL_INVALID_COMMAND: amount_max_minor must be >= 0' using errcode = 'P0009';
  end if;
  if p_amount_min_minor is not null and p_amount_max_minor is not null
     and p_amount_min_minor > p_amount_max_minor then
    raise exception 'KEEL_INVALID_COMMAND: amount_min_minor must be <= amount_max_minor' using errcode = 'P0009';
  end if;

  if p_category_ledger_account_id is not null then
    select entity_id into v_entity
      from public.ledger_accounts
      where id = p_category_ledger_account_id
        and household_id = p_household_id
        and is_category = true and archived_at is null;
    if v_entity is null then
      raise exception 'KEEL_INVALID_COMMAND: invalid category' using errcode = 'P0009';
    end if;
  else
    select id into v_entity from public.entities
      where household_id = p_household_id order by created_at limit 1;
    if v_entity is null then
      raise exception 'KEEL_NOT_FOUND: entity' using errcode = 'P0006';
    end if;
  end if;

  if p_rule_id is null then
    insert into public.category_rules
      (household_id, entity_id, pattern, category_ledger_account_id, rename_to, priority, active,
       amount_min_minor, amount_max_minor)
    values
      (p_household_id, v_entity, v_pattern, p_category_ledger_account_id, v_rename,
       coalesce(p_priority, 100), coalesce(p_active, true), p_amount_min_minor, p_amount_max_minor)
    returning id into v_id;
    insert into public.audit_log (household_id, actor, action, object_type, object_id, after)
    values (p_household_id, jsonb_build_object('kind', 'user', 'userId', auth.uid()),
            'rules.create', 'category_rule', v_id,
            jsonb_build_object('pattern', v_pattern,
                               'categoryLedgerAccountId', p_category_ledger_account_id,
                               'renameTo', v_rename, 'priority', coalesce(p_priority, 100),
                               'active', coalesce(p_active, true),
                               'amountMinMinor', p_amount_min_minor,
                               'amountMaxMinor', p_amount_max_minor));
  else
    select jsonb_build_object('pattern', pattern,
                              'categoryLedgerAccountId', category_ledger_account_id,
                              'renameTo', rename_to, 'priority', priority, 'active', active,
                              'amountMinMinor', amount_min_minor, 'amountMaxMinor', amount_max_minor)
      into v_before
      from public.category_rules
      where id = p_rule_id and household_id = p_household_id;
    if v_before is null then
      raise exception 'KEEL_NOT_FOUND: rule' using errcode = 'P0006';
    end if;
    update public.category_rules
       set pattern = v_pattern,
           entity_id = v_entity,
           category_ledger_account_id = p_category_ledger_account_id,
           rename_to = v_rename,
           priority = coalesce(p_priority, 100),
           active = coalesce(p_active, true),
           amount_min_minor = p_amount_min_minor,
           amount_max_minor = p_amount_max_minor,
           updated_at = now()
     where id = p_rule_id;
    v_id := p_rule_id;
    insert into public.audit_log (household_id, actor, action, object_type, object_id, before, after)
    values (p_household_id, jsonb_build_object('kind', 'user', 'userId', auth.uid()),
            'rules.update', 'category_rule', v_id, v_before,
            jsonb_build_object('pattern', v_pattern,
                               'categoryLedgerAccountId', p_category_ledger_account_id,
                               'renameTo', v_rename, 'priority', coalesce(p_priority, 100),
                               'active', coalesce(p_active, true),
                               'amountMinMinor', p_amount_min_minor,
                               'amountMaxMinor', p_amount_max_minor));
  end if;
  return v_id;
end;
$$;

revoke all on function public.keel_rule_save(uuid, uuid, text, uuid, text, integer, boolean, bigint, bigint)
  from public, anon;
grant execute on function public.keel_rule_save(uuid, uuid, text, uuid, text, integer, boolean, bigint, bigint)
  to authenticated;

-- ---------------------------------------------------------------------------
-- keel_apply_rules: signature UNCHANGED (uuid, boolean) — plain create-or-
-- replace. Rebuilt from the CURRENT live body in 20260713100000 (the later
-- of the two historical definitions — it added the single-offset-only
-- guard; the original 20260713040000 body is stale and must NOT be used as
-- the base, confirmed via `grep -n "create or replace function
-- public.keel_apply_rules" supabase/migrations/*.sql` before writing this
-- file). Only change: the rule-match join in the `matches` CTE also requires
-- the amount-range condition (when set) against abs(offp.amount_minor) —
-- the category-offset posting's magnitude, which by the balanced-postings
-- invariant (Law 3) always equals the cash leg's magnitude for a single-
-- offset transaction, so no extra join to the cash posting is needed. Both
-- bounds null (the untouched-rule case) is a no-op AND, so dry-run and
-- apply counts for every pre-existing rule are byte-for-byte identical to
-- before this migration (Law 9 backward compatibility).
-- ---------------------------------------------------------------------------
create or replace function public.keel_apply_rules(
  p_household_id uuid,
  p_dry_run boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
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
$$;

revoke all on function public.keel_apply_rules(uuid, boolean) from public, anon;
grant execute on function public.keel_apply_rules(uuid, boolean) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- keel_list_rules: signature unchanged (uuid) — plain create-or-replace,
-- rows gain amountMinMinor/amountMaxMinor (text-serialized BIGINT, Law 4:
-- money never travels as a JSON number). Null-safe: existing rules with no
-- amount condition simply report both fields null.
-- ---------------------------------------------------------------------------
create or replace function public.keel_list_rules(p_household_id uuid)
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

  select coalesce(jsonb_agg(jsonb_build_object(
           'ruleId', r.id,
           'pattern', r.pattern,
           'categoryLedgerAccountId', r.category_ledger_account_id,
           'categoryName', la.name,
           'renameTo', r.rename_to,
           'priority', r.priority,
           'active', r.active,
           'amountMinMinor', r.amount_min_minor::text,
           'amountMaxMinor', r.amount_max_minor::text
         ) order by r.priority, r.created_at), '[]'::jsonb)
    into v_rows
    from public.category_rules r
    left join public.ledger_accounts la on la.id = r.category_ledger_account_id
    where r.household_id = p_household_id;

  return jsonb_build_object(
    'scope', jsonb_build_object('householdId', p_household_id),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'formulaVersion', 'category-rules-v1',
    'rows', v_rows
  );
end;
$$;

revoke all on function public.keel_list_rules(uuid) from public, anon;
grant execute on function public.keel_list_rules(uuid) to authenticated, service_role;
