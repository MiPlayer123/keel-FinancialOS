-- Rules engine v1 (deterministic, Law 1; BC-v2.1 §3 rules; T0.8).
-- User-authored condition→action rules: match the IMMUTABLE provider
-- description (never the display overlay — no feedback loops), set the
-- category overlay and/or a display rename. Precedence lattice, enforced
-- mechanically here: USER edits > rules > plaid_pfc. Rule renames live in
-- their OWN layer (rule_renames) so a user's name/note save can never
-- destroy a rule rename and a rule can never clobber a user's note
-- (adversarial audit finding). Retroactive apply is two-phase: dry-run
-- preview → confirm (BC-v2.1 §3 "retroactive only after preview").
-- Deviation logged in NOTES.md: rule versioning/simulation beyond
-- dry-run-count is deferred to the rules v2 pass.

create table if not exists public.category_rules (
  id                         uuid primary key default gen_random_uuid(),
  household_id               uuid not null references public.households (id),
  entity_id                  uuid not null references public.entities (id),
  matcher                    text not null default 'description_contains'
    check (matcher in ('description_contains')),
  pattern                    text not null check (char_length(pattern) between 2 and 140),
  category_ledger_account_id uuid references public.ledger_accounts (id),
  rename_to                  text check (rename_to is null or char_length(rename_to) between 1 and 140),
  priority                   integer not null default 100,
  active                     boolean not null default true,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  check (category_ledger_account_id is not null or rename_to is not null)
);
create index if not exists category_rules_household_active
  on public.category_rules (household_id, active, priority);

alter table public.category_rules enable row level security;
drop policy if exists category_rules_member_read on public.category_rules;
create policy category_rules_member_read on public.category_rules
  for select to authenticated
  using (exists (
    select 1 from public.household_memberships m
    where m.household_id = category_rules.household_id and m.user_id = auth.uid()
  ));
grant select on public.category_rules to authenticated;

-- Rule-authored display names: separate layer beneath the user override.
-- Read models coalesce: user override → rule rename → provider description.
create table if not exists public.rule_renames (
  canonical_transaction_id uuid primary key
    references public.canonical_transactions (id),
  household_id             uuid not null references public.households (id),
  rule_id                  uuid not null references public.category_rules (id) on delete cascade,
  display_name             text not null check (char_length(display_name) between 1 and 140),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);
create index if not exists rule_renames_household on public.rule_renames (household_id);
create index if not exists rule_renames_rule on public.rule_renames (rule_id);

alter table public.rule_renames enable row level security;
drop policy if exists rule_renames_member_read on public.rule_renames;
create policy rule_renames_member_read on public.rule_renames
  for select to authenticated
  using (exists (
    select 1 from public.household_memberships m
    where m.household_id = rule_renames.household_id and m.user_id = auth.uid()
  ));
grant select on public.rule_renames to authenticated;

-- Rule provenance on the category overlay (which rule wrote this row).
alter table public.transaction_categories
  add column if not exists rule_id uuid references public.category_rules (id) on delete set null;

-- Save (create or update) a rule. Audited; category must be a live category
-- of the same entity.
create or replace function public.keel_rule_save(
  p_household_id uuid,
  p_rule_id uuid,
  p_pattern text,
  p_category_ledger_account_id uuid,
  p_rename_to text,
  p_priority integer,
  p_active boolean
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
      (household_id, entity_id, pattern, category_ledger_account_id, rename_to, priority, active)
    values
      (p_household_id, v_entity, v_pattern, p_category_ledger_account_id, v_rename,
       coalesce(p_priority, 100), coalesce(p_active, true))
    returning id into v_id;
    insert into public.audit_log (household_id, actor, action, object_type, object_id, after)
    values (p_household_id, jsonb_build_object('kind', 'user', 'userId', auth.uid()),
            'rules.create', 'category_rule', v_id,
            jsonb_build_object('pattern', v_pattern,
                               'categoryLedgerAccountId', p_category_ledger_account_id,
                               'renameTo', v_rename, 'priority', coalesce(p_priority, 100),
                               'active', coalesce(p_active, true)));
  else
    select jsonb_build_object('pattern', pattern,
                              'categoryLedgerAccountId', category_ledger_account_id,
                              'renameTo', rename_to, 'priority', priority, 'active', active)
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
           updated_at = now()
     where id = p_rule_id;
    v_id := p_rule_id;
    insert into public.audit_log (household_id, actor, action, object_type, object_id, before, after)
    values (p_household_id, jsonb_build_object('kind', 'user', 'userId', auth.uid()),
            'rules.update', 'category_rule', v_id, v_before,
            jsonb_build_object('pattern', v_pattern,
                               'categoryLedgerAccountId', p_category_ledger_account_id,
                               'renameTo', v_rename, 'priority', coalesce(p_priority, 100),
                               'active', coalesce(p_active, true)));
  end if;
  return v_id;
end;
$$;

revoke all on function public.keel_rule_save(uuid, uuid, text, uuid, text, integer, boolean)
  from public, anon;
grant execute on function public.keel_rule_save(uuid, uuid, text, uuid, text, integer, boolean)
  to authenticated;

-- Delete a rule. Overlay rows it wrote keep their category (rule_id nulls
-- out); its renames disappear (cascade) and reads fall back.
create or replace function public.keel_rule_delete(p_household_id uuid, p_rule_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
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
  select jsonb_build_object('pattern', pattern, 'renameTo', rename_to,
                            'categoryLedgerAccountId', category_ledger_account_id)
    into v_before
    from public.category_rules
    where id = p_rule_id and household_id = p_household_id;
  if v_before is null then
    raise exception 'KEEL_NOT_FOUND: rule' using errcode = 'P0006';
  end if;
  delete from public.category_rules where id = p_rule_id;
  insert into public.audit_log (household_id, actor, action, object_type, object_id, before)
  values (p_household_id, jsonb_build_object('kind', 'user', 'userId', auth.uid()),
          'rules.delete', 'category_rule', p_rule_id, v_before);
end;
$$;

revoke all on function public.keel_rule_delete(uuid, uuid) from public, anon;
grant execute on function public.keel_rule_delete(uuid, uuid) to authenticated;

-- List rules (envelope shape).
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
           'active', r.active
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

-- Apply all active rules (or preview with p_dry_run). Deterministic winner
-- per transaction: lowest (priority, created_at, id) among matching rules,
-- matched against lower(ct.description) with position() — no LIKE-escaping
-- concerns. Category writes: rule beats plaid_pfc and stale rule, NEVER a
-- user row. Renames: own layer; user overrides win at read time. Kind-safe:
-- a rule's category applies only when its kind equals the transaction's
-- offset-category kind (an expense rule cannot misfile income).
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
      left join public.ledger_accounts rulecat on rulecat.id = r.category_ledger_account_id
      where ct.household_id = p_household_id
        and ct.voided_at is null
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
  on conflict (canonical_transaction_id) do update
    set category_ledger_account_id = excluded.category_ledger_account_id,
        source = 'rule', rule_id = excluded.rule_id, updated_at = now()
    where transaction_categories.source <> 'user'
      and (transaction_categories.category_ledger_account_id
             <> excluded.category_ledger_account_id
           or transaction_categories.source <> 'rule');
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

-- Rich read model: user override → rule rename → provider description.
create or replace function public.keel_list_transactions_rich(p_household_id uuid)
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

  select coalesce(jsonb_agg(row order by row->>'effectiveDate' desc, row->>'transactionId'), '[]'::jsonb)
    into v_rows
    from (
      select jsonb_build_object(
        'transactionId', ct.id,
        'effectiveDate', ct.effective_date,
        'description', left(coalesce(tov.display_description, rr.display_name, ct.description), 140),
        'originalDescription', left(ct.description, 140),
        'note', tov.note,
        'status', ct.status,
        'accountId', acc.id,
        'accountName', acc.name,
        'amountMinor', cashp.amount_minor::text,
        'currency', cashp.currency,
        'categoryLedgerAccountId', coalesce(catov.id, offcat.id),
        'categoryName', coalesce(catov.name, offcat.name),
        'categoryKind', coalesce(catov.kind, offcat.kind),
        'transferStatus', tl.status
      ) as row
      from public.canonical_transactions ct
      join public.journal_batches jb
        on jb.canonical_transaction_id = ct.id and jb.reverses_batch_id is null
      join public.journal_postings cashp on cashp.batch_id = jb.id
      join public.ledger_accounts cashla
        on cashla.id = cashp.ledger_account_id and cashla.is_category = false
      join public.accounts acc on acc.ledger_account_id = cashla.id
      join public.journal_postings offp on offp.batch_id = jb.id and offp.id <> cashp.id
      join public.ledger_accounts offcat
        on offcat.id = offp.ledger_account_id and offcat.is_category = true
      left join public.transaction_categories tc on tc.canonical_transaction_id = ct.id
      left join public.ledger_accounts catov on catov.id = tc.category_ledger_account_id
      left join public.transaction_overrides tov on tov.canonical_transaction_id = ct.id
      left join public.rule_renames rr on rr.canonical_transaction_id = ct.id
      left join public.transfer_links tl
        on (tl.txn_out = ct.id or tl.txn_in = ct.id)
       and tl.status in ('suggested', 'confirmed')
      where ct.household_id = p_household_id
    ) t;

  return jsonb_build_object(
    'scope', jsonb_build_object('householdId', p_household_id),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'rows', v_rows
  );
end;
$$;

grant execute on function public.keel_list_transactions_rich(uuid) to authenticated, service_role;

-- Law 6 export ruling: both rule tables are durable user configuration /
-- classification provenance → INCLUDE, same wrapper chain.
grant select on public.category_rules, public.rule_renames to keel_export;
create policy category_rules_export on public.category_rules
  for select to keel_export using (true);
create policy rule_renames_export on public.rule_renames
  for select to keel_export using (true);

alter function public.keel_export_household(uuid,timestamptz)
  rename to keel_export_household_pre_rules;
revoke all on function public.keel_export_household_pre_rules(uuid,timestamptz)
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
  v_base := public.keel_export_household_pre_rules(p_household_id, p_as_of);
  select jsonb_build_object(
    'category_rules', coalesce((select jsonb_agg(to_jsonb(x) order by x.id)
      from public.category_rules x where x.household_id = p_household_id), '[]'::jsonb),
    'rule_renames', coalesce((select jsonb_agg(to_jsonb(x) order by x.canonical_transaction_id)
      from public.rule_renames x where x.household_id = p_household_id), '[]'::jsonb)
  ) into v_tables;
  return jsonb_set(v_base, '{tables}', (v_base->'tables') || v_tables);
end;
$$;
revoke all on function public.keel_export_household(uuid,timestamptz)
  from public, anon, authenticated, service_role;
grant create on schema public to keel_export;
alter function public.keel_export_household(uuid,timestamptz) owner to keel_export;
revoke create on schema public from keel_export;
grant execute on function public.keel_export_household(uuid,timestamptz) to service_role;
