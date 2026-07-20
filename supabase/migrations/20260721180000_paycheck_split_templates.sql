-- Paycheck split templates SLICE B (docs/harness/plans/paycheck-split-templates-v2.md
-- §D3, §2 migration 180000, §3 export). Normalized template lines + the mutable
-- per-series pointer/autonomy-grant record + class-B split suggestions carrying
-- the FULL AiResponseRecordSchema (Law 11) + additive reproducibility columns on
-- paychecks (Law 9) + two viewer read models + Law-6 export wiring.
--
-- Slice B is deployable-inert: it creates schema + reads only. The save /
-- set-series-settings / apply / booking / detection COMMANDS land in later
-- slices (migrations 181000/182000/183000). The tables are live and empty; the
-- immutability discipline and constraints below are the enforced surface today.
--
-- Laws honored:
--  4 — money is BIGINT minor units; NO implicit financial/policy SQL defaults
--      (every column is NOT NULL or explicitly nullable-by-design; a writer must
--      supply every value). bps 0<bps<10000; amount_kind↔role↔kind coherence.
--  9 — a recorded paycheck references template_id + template_version (reproducible
--      numbers: the exact template version that produced the split is recorded).
-- 11 — split suggestions persist the full typed AI response record
--      (verdict/tldr/confidence/as_of+scope/reason_codes/evidence_refs/
--      proposed_actions/requires_approval/model+prompt+policy versions) — the
--      EXISTING AiResponseRecordSchema (packages/contracts/src/ai.ts), not a
--      reduced record (v2 [AMENDED 7]).
--
-- The aggregate ΣP<10000 constraint is enforced at APPLY/SAVE time (Slice A math
-- + the save command), NOT here (per-line 0<bps<10000 only) — v2 §D3.

-- ---------------------------------------------------------------------------
-- 1. Enums (new). paycheck_component_kind + autonomy_level + ai_risk_class are
-- REUSED from live (do not redefine).
-- ---------------------------------------------------------------------------
create type public.paycheck_line_role as enum (
  'earning','tax','pretax_transfer','posttax_deduction','net_deposit'
);
create type public.paycheck_amount_kind as enum (
  'fixed_minor','percent_of_gross_bps','remainder'
);

-- ---------------------------------------------------------------------------
-- 2. paycheck_template_lines — immutable, append-with-template-version. A
-- template version is a frozen set of lines; editing authors a NEW version
-- (Slice C save command). No implicit financial defaults (Law 4).
-- ---------------------------------------------------------------------------
create table public.paycheck_template_lines (
  household_id             uuid    not null references public.households (id),
  id                       uuid    not null default gen_random_uuid(),
  template_id              uuid    not null,
  line_key                 text    not null check (length(line_key) between 1 and 100),
  kind                     public.paycheck_component_kind not null,
  role                     public.paycheck_line_role      not null,
  amount_kind              public.paycheck_amount_kind    not null,
  amount_minor             bigint,
  bps                      integer check (bps is null or (bps > 0 and bps < 10000)),
  category_ledger_account_id uuid,
  destination_account_id   uuid,
  position                 integer not null,
  created_at               timestamptz not null default now(),
  primary key (household_id, id),
  unique (household_id, template_id, line_key),
  unique (household_id, template_id, position),
  -- Composite tenant FKs (no cross-household ref possible).
  constraint fk_ptl_template_tenant foreign key (household_id, template_id)
    references public.paycheck_templates (household_id, id) on delete restrict,
  constraint fk_ptl_category_tenant foreign key (household_id, category_ledger_account_id)
    references public.ledger_accounts (household_id, id) on delete restrict,
  constraint fk_ptl_destination_tenant foreign key (household_id, destination_account_id)
    references public.accounts (household_id, id) on delete restrict,
  -- amount_kind ↔ amount columns: exactly the right amount column is present.
  constraint ck_ptl_amount_shape check (
    (amount_kind = 'fixed_minor'          and amount_minor is not null and amount_minor >= 0 and bps is null)
    or (amount_kind = 'percent_of_gross_bps' and bps is not null and amount_minor is null)
    or (amount_kind = 'remainder'         and amount_minor is null and bps is null)
  ),
  -- role ↔ kind coherence (the component kind must fit its economic role).
  constraint ck_ptl_role_kind check (
    (role = 'earning'            and kind in ('gross_salary','bonus','commission'))
    or (role = 'tax'             and kind in ('federal_withholding','state_withholding','local_withholding','fica_withholding','rsu_withholding'))
    or (role = 'pretax_transfer' and kind in ('retirement_401k','employer_match','hsa','fsa','espp'))
    or (role = 'posttax_deduction' and kind in ('benefit','garnishment'))
    or (role = 'net_deposit'     and kind = 'direct_deposit')
  ),
  -- pretax_transfer MUST name a destination asset account (the 401k/HSA target);
  -- non-transfer roles must NOT carry one.
  constraint ck_ptl_destination_presence check (
    (role = 'pretax_transfer' and destination_account_id is not null)
    or (role <> 'pretax_transfer' and destination_account_id is null)
  ),
  -- earnings/net_deposit never carry a category ledger account; tax/posttax MAY
  -- (required for booking, enforced by the later booking proc — v2 §D3).
  constraint ck_ptl_category_role check (
    role in ('tax','posttax_deduction') or category_ledger_account_id is null
  )
);
-- Exactly-one-remainder is enforced by BOTH this partial unique index (at most
-- one) AND the save command's count=1 check (Slice C) — v2 §D3.
create unique index paycheck_template_lines_one_remainder
  on public.paycheck_template_lines (household_id, template_id)
  where amount_kind = 'remainder';
create index paycheck_template_lines_template
  on public.paycheck_template_lines (household_id, template_id);

-- ---------------------------------------------------------------------------
-- 3. paycheck_series_settings — the mutable pointer + per-series autonomy grant
-- (the Law-2 record an auto-apply needs). NO SQL defaults on booking_enabled or
-- autonomy — the set-settings command supplies both explicitly (v2 §D3).
-- ---------------------------------------------------------------------------
create table public.paycheck_series_settings (
  household_id                       uuid not null references public.households (id),
  series_id                          uuid not null,
  employer_id                        uuid not null,
  active_template_id                 uuid,
  booking_enabled                    boolean not null,
  income_category_ledger_account_id  uuid,
  autonomy                           public.autonomy_level not null,
  updated_at                         timestamptz not null default now(),
  primary key (household_id, series_id),
  unique (household_id, series_id),
  constraint fk_pss_series_tenant foreign key (household_id, series_id)
    references public.recurring_series (household_id, id) on delete restrict,
  constraint fk_pss_employer_tenant foreign key (household_id, employer_id)
    references public.employers (household_id, id) on delete restrict,
  constraint fk_pss_template_tenant foreign key (household_id, active_template_id)
    references public.paycheck_templates (household_id, id) on delete restrict,
  constraint fk_pss_income_category_tenant foreign key (household_id, income_category_ledger_account_id)
    references public.ledger_accounts (household_id, id) on delete restrict,
  -- auto_with_log is a standing grant to apply a specific template unattended;
  -- it is meaningless without an active template (v2 §D3 CHECK).
  constraint ck_pss_auto_requires_template check (
    autonomy <> 'auto_with_log' or active_template_id is not null
  )
);

-- ---------------------------------------------------------------------------
-- 4. paycheck_split_suggestions — class-B records (category_suggestions pattern
-- + the FULL AiResponseRecordSchema in ai_response, Law 11). Idempotent
-- re-detection: one row per (deposit, template, template_version) forever; a
-- decided row keeps its slot so a dismissed suggestion is never re-raised.
-- ---------------------------------------------------------------------------
create table public.paycheck_split_suggestions (
  household_id          uuid    not null references public.households (id),
  id                    uuid    not null default gen_random_uuid(),
  series_id             uuid    not null,
  template_id           uuid    not null,
  template_version      integer not null check (template_version > 0),
  deposit_txn_id        uuid    not null,
  computed_components   jsonb   not null check (jsonb_typeof(computed_components) = 'array'),
  computed_gross_minor  bigint  not null check (computed_gross_minor >= 0),
  computed_net_minor    bigint  not null check (computed_net_minor >= 0),
  source                text    not null check (source in ('detector','agent')),
  -- Law 11: the full BC-v2.1 material AI response record (AiResponseRecordSchema).
  -- ledger-derived, no secrets (json-secret export scan guards it).
  ai_response           jsonb   not null check (jsonb_typeof(ai_response) = 'object'),
  status                text    not null default 'suggested'
    check (status in ('suggested','accepted','dismissed','stale')),
  applied_paycheck_id   uuid,
  created_at            timestamptz not null default now(),
  decided_at            timestamptz,
  decided_by            uuid references auth.users (id),
  primary key (household_id, id),
  -- Idempotent re-detection key (Law 9): the same proposal is one row forever.
  unique (household_id, deposit_txn_id, template_id, template_version),
  constraint fk_pss_sug_series_tenant foreign key (household_id, series_id)
    references public.recurring_series (household_id, id) on delete restrict,
  constraint fk_pss_sug_template_tenant foreign key (household_id, template_id)
    references public.paycheck_templates (household_id, id) on delete restrict,
  constraint fk_pss_sug_deposit_tenant foreign key (household_id, deposit_txn_id)
    references public.canonical_transactions (household_id, id) on delete restrict,
  constraint fk_pss_sug_applied_paycheck_tenant foreign key (household_id, applied_paycheck_id)
    references public.paychecks (household_id, id) on delete restrict,
  -- Decision coherence (category_suggestions precedent): an undecided row has no
  -- decider/decided_at; a decided row records when. accepted rows bind the
  -- resulting paycheck.
  constraint ck_pss_sug_decision check (
    (status = 'suggested' and decided_by is null and decided_at is null and applied_paycheck_id is null)
    or (status = 'stale'    and applied_paycheck_id is null)
    or (status = 'dismissed' and decided_at is not null and applied_paycheck_id is null)
    or (status = 'accepted'  and decided_at is not null and applied_paycheck_id is not null)
  )
);
create index paycheck_split_suggestions_household_status
  on public.paycheck_split_suggestions (household_id, status);
create index paycheck_split_suggestions_series
  on public.paycheck_split_suggestions (household_id, series_id);

-- ---------------------------------------------------------------------------
-- 5. Immutability triggers. Template lines are frozen once written (a new
-- version is authored to change them). series_settings is deliberately mutable
-- (it is the pointer). Suggestions are insert-then-advance-once: their status
-- may advance via the Slice-D/E decision command (keel_api writer only), so they
-- are NOT under keel_forbid_mutation (like category_suggestions).
-- ---------------------------------------------------------------------------
create trigger paycheck_template_lines_immutable
  before update or delete on public.paycheck_template_lines
  for each row execute function public.keel_forbid_mutation();

-- ---------------------------------------------------------------------------
-- 6. Additive reproducibility columns on paychecks (Law 9). A template-applied
-- paycheck records the exact template + version that produced it. Nullable:
-- manually-entered paychecks (existing rows and manual creates) carry neither.
-- ---------------------------------------------------------------------------
alter table public.paychecks
  add column if not exists template_id uuid,
  add column if not exists template_version integer
    check (template_version is null or template_version > 0);
-- Composite tenant FK: a paycheck's template must be same-household.
alter table public.paychecks
  add constraint fk_paycheck_template_tenant
  foreign key (household_id, template_id)
  references public.paycheck_templates (household_id, id) on delete restrict;
-- template_id and template_version travel together (both present or both absent).
alter table public.paychecks
  add constraint ck_paycheck_template_pair
  check ((template_id is null) = (template_version is null));

-- ---------------------------------------------------------------------------
-- 7. RLS + grants (house ritual: member read for authenticated; whole-table
-- policy for the keel_api definer role because it is non-BYPASSRLS; explicit
-- service_role select — tables created after the 210500 catch-all need it).
-- ---------------------------------------------------------------------------
alter table public.paycheck_template_lines    enable row level security;
alter table public.paycheck_series_settings   enable row level security;
alter table public.paycheck_split_suggestions enable row level security;

revoke all on public.paycheck_template_lines, public.paycheck_series_settings, public.paycheck_split_suggestions
  from public, anon, authenticated;
grant select on public.paycheck_template_lines, public.paycheck_series_settings, public.paycheck_split_suggestions
  to authenticated;
grant select on public.paycheck_template_lines, public.paycheck_series_settings, public.paycheck_split_suggestions
  to service_role;
-- keel_api writers land in later slices; grant the writes now so those procs
-- (owned by keel_api) can operate without re-granting.
grant select, insert on public.paycheck_template_lines to keel_api;
grant select, insert, update on public.paycheck_series_settings to keel_api;
grant select, insert, update on public.paycheck_split_suggestions to keel_api;

-- CREATE POLICY is not idempotent — pre-drop guarded by to_regclass (ops fact).
do $$
begin
  if to_regclass('public.paycheck_template_lines') is not null then
    drop policy if exists paycheck_template_lines_member_read on public.paycheck_template_lines;
    drop policy if exists paycheck_template_lines_api_all on public.paycheck_template_lines;
  end if;
  if to_regclass('public.paycheck_series_settings') is not null then
    drop policy if exists paycheck_series_settings_member_read on public.paycheck_series_settings;
    drop policy if exists paycheck_series_settings_api_all on public.paycheck_series_settings;
  end if;
  if to_regclass('public.paycheck_split_suggestions') is not null then
    drop policy if exists paycheck_split_suggestions_member_read on public.paycheck_split_suggestions;
    drop policy if exists paycheck_split_suggestions_api_all on public.paycheck_split_suggestions;
  end if;
end$$;

create policy paycheck_template_lines_member_read on public.paycheck_template_lines
  for select to authenticated using (public.keel_is_household_member(household_id));
create policy paycheck_template_lines_api_all on public.paycheck_template_lines
  for all to keel_api using (true) with check (true);
create policy paycheck_series_settings_member_read on public.paycheck_series_settings
  for select to authenticated using (public.keel_is_household_member(household_id));
create policy paycheck_series_settings_api_all on public.paycheck_series_settings
  for all to keel_api using (true) with check (true);
create policy paycheck_split_suggestions_member_read on public.paycheck_split_suggestions
  for select to authenticated using (public.keel_is_household_member(household_id));
create policy paycheck_split_suggestions_api_all on public.paycheck_split_suggestions
  for all to keel_api using (true) with check (true);

-- ---------------------------------------------------------------------------
-- 8. Read model: keel_list_paycheck_templates — templates + their lines +
-- series_settings + effective autonomy. Viewer authz (household membership),
-- definer, ownership-asserted. Account/household scoped: destination and
-- category account refs are same-household by FK.
-- ---------------------------------------------------------------------------
create function public.keel_list_paycheck_templates(p_household_id uuid)
returns jsonb language plpgsql security definer stable set search_path = public as $$
declare
  v_uid uuid := coalesce(
    nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
    nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid;
  v_templates jsonb;
  v_series jsonb;
begin
  if v_uid is null then raise exception 'KEEL_NOT_AUTHENTICATED' using errcode = 'P0004'; end if;
  if not exists (
    select 1 from public.household_memberships m
     where m.household_id = p_household_id and m.user_id = v_uid
  ) then raise exception 'KEEL_SCOPE_VIOLATION' using errcode = 'P0006'; end if;

  select coalesce(jsonb_agg(t.dto order by t.employer_name, t.template_version desc), '[]'::jsonb)
    into v_templates
    from (
      select e.name as employer_name, tpl.template_version,
        jsonb_build_object(
          'templateId', tpl.id,
          'employerId', tpl.employer_id,
          'employerName', e.name,
          'templateVersion', tpl.template_version,
          'formulaVersion', tpl.formula_version,
          'createdAt', to_char(tpl.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
          'lines', coalesce((
            select jsonb_agg(jsonb_build_object(
              'lineId', l.id,
              'lineKey', l.line_key,
              'kind', l.kind,
              'role', l.role,
              'amountKind', l.amount_kind,
              'amountMinor', case when l.amount_minor is null then null else l.amount_minor::text end,
              'bps', l.bps,
              'categoryLedgerAccountId', l.category_ledger_account_id,
              'destinationAccountId', l.destination_account_id,
              'position', l.position
            ) order by l.position)
            from public.paycheck_template_lines l
            where l.household_id = tpl.household_id and l.template_id = tpl.id
          ), '[]'::jsonb)
        ) as dto
      from public.paycheck_templates tpl
      join public.employers e on e.household_id = tpl.household_id and e.id = tpl.employer_id
      where tpl.household_id = p_household_id
    ) t;

  select coalesce(jsonb_agg(jsonb_build_object(
      'seriesId', s.series_id,
      'employerId', s.employer_id,
      'activeTemplateId', s.active_template_id,
      'bookingEnabled', s.booking_enabled,
      'incomeCategoryLedgerAccountId', s.income_category_ledger_account_id,
      'autonomy', s.autonomy,
      'updatedAt', to_char(s.updated_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    ) order by s.series_id), '[]'::jsonb)
    into v_series
    from public.paycheck_series_settings s
    where s.household_id = p_household_id;

  return jsonb_build_object(
    'scope', jsonb_build_object('householdId', p_household_id),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'templates', v_templates,
    'seriesSettings', v_series
  );
end; $$;

-- ---------------------------------------------------------------------------
-- 9. Read model: keel_list_paycheck_split_suggestions — the class-B review
-- cards (TLDR from ai_response, proof on demand). Viewer authz, definer,
-- ownership-asserted, account-scoped via the deposit txn's household.
-- ---------------------------------------------------------------------------
create function public.keel_list_paycheck_split_suggestions(p_household_id uuid)
returns jsonb language plpgsql security definer stable set search_path = public as $$
declare
  v_uid uuid := coalesce(
    nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
    nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid;
  v_rows jsonb;
begin
  if v_uid is null then raise exception 'KEEL_NOT_AUTHENTICATED' using errcode = 'P0004'; end if;
  if not exists (
    select 1 from public.household_memberships m
     where m.household_id = p_household_id and m.user_id = v_uid
  ) then raise exception 'KEEL_SCOPE_VIOLATION' using errcode = 'P0006'; end if;

  select coalesce(jsonb_agg(row.dto order by row.created_at desc, row.id), '[]'::jsonb)
    into v_rows
    from (
      select sug.created_at, sug.id,
        jsonb_build_object(
          'suggestionId', sug.id,
          'seriesId', sug.series_id,
          'templateId', sug.template_id,
          'templateVersion', sug.template_version,
          'depositTxnId', sug.deposit_txn_id,
          'computedComponents', sug.computed_components,
          'computedGrossMinor', sug.computed_gross_minor::text,
          'computedNetMinor', sug.computed_net_minor::text,
          'source', sug.source,
          'status', sug.status,
          'appliedPaycheckId', sug.applied_paycheck_id,
          -- TLDR first, proof on demand (Law 11): surface the record's tldr +
          -- confidence + verdict on the card; the full ai_response rides for the
          -- Why panel.
          'tldr', sug.ai_response->>'tldr',
          'confidence', sug.ai_response->'confidence',
          'verdict', sug.ai_response->>'verdict',
          'aiResponse', sug.ai_response,
          'depositDate', to_char(ct.effective_date, 'YYYY-MM-DD'),
          'depositDescription', left(ct.description, 140),
          'createdAt', to_char(sug.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
          'decidedAt', case when sug.decided_at is null then null
            else to_char(sug.decided_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end
        ) as dto
      from public.paycheck_split_suggestions sug
      join public.canonical_transactions ct
        on ct.household_id = sug.household_id and ct.id = sug.deposit_txn_id
      where sug.household_id = p_household_id
    ) row;

  return jsonb_build_object(
    'scope', jsonb_build_object('householdId', p_household_id),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'rows', v_rows
  );
end; $$;

-- ---------------------------------------------------------------------------
-- 10. Read-model ownership/grant ritual (grant-create → alter-owner →
-- revoke-create wrapper: prior slices hit 'permission denied for schema public'
-- without it). Both read models owned by keel_api, executable by authenticated.
-- ---------------------------------------------------------------------------
grant create on schema public to keel_api;
alter function public.keel_list_paycheck_templates(uuid) owner to keel_api;
alter function public.keel_list_paycheck_split_suggestions(uuid) owner to keel_api;
revoke create on schema public from keel_api;
revoke all on function public.keel_list_paycheck_templates(uuid),
  public.keel_list_paycheck_split_suggestions(uuid) from public, anon;
grant execute on function public.keel_list_paycheck_templates(uuid),
  public.keel_list_paycheck_split_suggestions(uuid) to authenticated;

do $$begin
  if exists (select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    join pg_roles r on r.oid = p.proowner
    where n.nspname = 'public' and p.proname in
      ('keel_list_paycheck_templates','keel_list_paycheck_split_suggestions')
      and p.prosecdef and r.rolname <> 'keel_api')
  then raise exception 'KEEL_OWNERSHIP: paycheck split read model owner'; end if;
end$$;

-- ---------------------------------------------------------------------------
-- 11. Export (Law 6, v2 §3 [AMENDED 6]). Three new tables added to the export
-- chain: keel_export grant + RLS select policy + keel_export_household rewrap
-- (wrap the CURRENT outermost, which today wraps pre_statement_holding_applications).
-- ai_response / computed_components jsonb are ledger-derived (no secrets), so
-- INCLUDED verbatim; guarded by the export json-secret scan.
-- ---------------------------------------------------------------------------
grant select on public.paycheck_template_lines, public.paycheck_series_settings, public.paycheck_split_suggestions
  to keel_export;
do $$
begin
  drop policy if exists paycheck_template_lines_export on public.paycheck_template_lines;
  drop policy if exists paycheck_series_settings_export on public.paycheck_series_settings;
  drop policy if exists paycheck_split_suggestions_export on public.paycheck_split_suggestions;
end$$;
create policy paycheck_template_lines_export on public.paycheck_template_lines
  for select to keel_export using (true);
create policy paycheck_series_settings_export on public.paycheck_series_settings
  for select to keel_export using (true);
create policy paycheck_split_suggestions_export on public.paycheck_split_suggestions
  for select to keel_export using (true);

alter function public.keel_export_household(uuid, timestamptz)
  rename to keel_export_household_pre_paycheck_split_templates;
revoke all on function public.keel_export_household_pre_paycheck_split_templates(uuid, timestamptz)
  from public, anon, authenticated, service_role;
create function public.keel_export_household(p_household_id uuid, p_as_of timestamptz default null)
returns jsonb language plpgsql security definer stable set search_path = pg_catalog, public as $$
declare v_base jsonb; v_tables jsonb; begin
  v_base := public.keel_export_household_pre_paycheck_split_templates(p_household_id, p_as_of);
  select jsonb_build_object(
    'paycheck_template_lines', coalesce((
      select jsonb_agg(to_jsonb(x) || jsonb_build_object(
        'amount_minor', case when x.amount_minor is null then null else x.amount_minor::text end)
        order by x.household_id, x.id)
      from public.paycheck_template_lines x where x.household_id = p_household_id), '[]'::jsonb),
    'paycheck_series_settings', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.household_id, x.series_id)
      from public.paycheck_series_settings x where x.household_id = p_household_id), '[]'::jsonb),
    'paycheck_split_suggestions', coalesce((
      select jsonb_agg(to_jsonb(x) || jsonb_build_object(
        'computed_gross_minor', x.computed_gross_minor::text,
        'computed_net_minor', x.computed_net_minor::text)
        order by x.household_id, x.id)
      from public.paycheck_split_suggestions x where x.household_id = p_household_id), '[]'::jsonb)
  ) into v_tables;
  return jsonb_set(v_base, '{tables}', v_base->'tables' || v_tables);
end$$;
revoke all on function public.keel_export_household(uuid, timestamptz)
  from public, anon, authenticated, service_role;
grant create on schema public to keel_export;
alter function public.keel_export_household(uuid, timestamptz) owner to keel_export;
revoke create on schema public from keel_export;
grant execute on function public.keel_export_household(uuid, timestamptz) to service_role;
