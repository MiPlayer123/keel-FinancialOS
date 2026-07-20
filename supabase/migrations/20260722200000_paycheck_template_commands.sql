-- Paycheck split templates SLICE C — template-authoring commands
-- (docs/harness/plans/paycheck-split-templates-v2.md §2 migration 181000 [renumbered],
--  §D2, §D3, §7 stage C).
--
-- Two commands land here, both under the full command-envelope ritual
-- (keel_assert_member_*/keel_actor_from_jwt/keel_idempotency_check/keel_finish_command):
--
--  1. keel_cmd_paycheck_save_template — author a NEW immutable template version
--     (a change = a new version, Law 2/9). Save-time validation enforces the
--     invariants the Slice-B CHECKs cannot express across the whole line set:
--       * EXACTLY ONE remainder net_deposit line (Slice B index is "at most one";
--         this is the "= 1" half — §D3).
--       * Aggregate ΣP < 10000 across percent lines (per-line bps<10000 can each
--         hold yet sum ≥10000, leaving no room for a non-negative remainder — §D3/§D4).
--       * category_ledger_account_id must be a LIVE (not archived) same-entity
--         category (is_category=true) in this household (§D2 / Law 7 scope-safe).
--       * destination_account_id must be a MANUAL (connection_id is null,
--         unconnected) LIVE ASSET account in this household (§D2). A 401k/HSA
--         placeholder is a manual asset account; a connected/Plaid account or a
--         liability is rejected.
--       * Every category/destination line resolves to ONE entity (a paycheck
--         belongs to one entity) — "same-entity" is enforced as a single shared
--         entity_id across the template.
--     Then it inserts the new paycheck_templates row (version = max+1 for the
--     employer), keeps a jsonb component_blueprint for export/back-compat, writes
--     the normalized lines, and UPSERTS paycheck_series_settings.active_template_id
--     WITHOUT touching autonomy (autonomy is a separate OWNER-only grant, below).
--
--  2. keel_cmd_paycheck_set_series_settings — the AUTONOMY GRANT record
--     (paycheck_series_settings IS the per-series Law-2 grant). Sets
--     active_template_id + booking_enabled + income_category_ledger_account_id +
--     autonomy (off|suggest|auto_with_log). Autonomy is a POLICY CHANGE, so it
--     requires OWNER — enforced by keel_assert_member_owner IN THE PROC (the
--     package-authz owner floor is bypassable via a direct RPC, and
--     keel_assert_member_write permits owner OR partner — §3/[AMENDED 6]).
--     auto_with_log requires an active_template_id (Slice-B CHECK; re-asserted
--     with a typed error). The audit_log before/after (keel_finish_command records
--     `after`; we also stamp `before`) makes this row the grant record (§D7).
--
-- Laws honored: 2 (suggest→approve / explicit grant; every mutation audited;
-- versioned-immutable corrections), 4 (BIGINT minor units; enums; NO implicit
-- defaults — every value supplied), 7 (one authorization compiler: the same
-- scope checks the read models use; owner floor enforced at the DB, not only in
-- TS), 9 (reproducible: a template version is frozen; the grant records
-- before/after).

-- ---------------------------------------------------------------------------
-- 0. keel_assert_member_owner — OWNER-only assertion mirroring
-- keel_assert_member_write (which permits owner OR partner). Autonomy is a
-- policy change; only an owner may grant it (§3/[AMENDED 6]). Created only if
-- absent (idempotent verify: it does not exist on live as of Slice C).
-- ---------------------------------------------------------------------------
-- Narrow the Slice-B "at most one remainder" partial unique index to the
-- NET_DEPOSIT residue line only. The Slice-A math (packages/paychecks/template.ts
-- partition()) uses amount_kind='remainder' on TWO roles: the single net_deposit
-- residue line ("the remainder line", §D3/§D4) AND the earning line as a
-- "derive-me" gross marker (there is no fixed/percent amount_kind that means
-- "carry the derived gross"). The Slice-B index counted BOTH, so a valid
-- template (earning-remainder + net_deposit-remainder) collided. "The remainder
-- line" is by definition the net_deposit residue; scope the uniqueness to it.
-- Slice-B tables are live-but-empty (0 rows), so this reindex is safe.
drop index if exists public.paycheck_template_lines_one_remainder;
create unique index paycheck_template_lines_one_remainder
  on public.paycheck_template_lines (household_id, template_id)
  where amount_kind = 'remainder' and role = 'net_deposit';

create or replace function public.keel_assert_member_owner(p_household_id uuid)
returns public.household_role
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := coalesce(
    nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
    nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid;
  v_role public.household_role;
begin
  if v_uid is null then
    raise exception 'KEEL_NOT_AUTHENTICATED' using errcode = 'P0004';
  end if;
  select role into v_role
    from public.household_memberships
   where household_id = p_household_id and user_id = v_uid;
  if v_role is null then
    raise exception 'KEEL_SCOPE_VIOLATION: not a member of household %', p_household_id
      using errcode = 'P0006';
  end if;
  if v_role <> 'owner' then
    raise exception 'KEEL_NOT_AUTHORIZED: role % may not change autonomy policy', v_role
      using errcode = 'P0005';
  end if;
  return v_role;
end;
$$;

-- ---------------------------------------------------------------------------
-- Shared line validator (used by save_template). Given the household + the
-- lines array, returns the derived entity_id (the single entity every
-- category/destination account belongs to), raising a typed KEEL_INVALID_COMMAND
-- on any scope/shape violation. Kept as an internal helper so the tests can probe
-- it and the command stays readable. SECURITY DEFINER, keel_api-owned.
-- ---------------------------------------------------------------------------
create or replace function public.keel_paycheck_template_validate_lines(
  p_household_id uuid, p_lines jsonb
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_line jsonb;
  v_role text; v_kind text; v_amount_kind text;
  v_remainder_count int := 0;
  v_earning_count int := 0;
  v_aggregate_bps bigint := 0;
  v_bps bigint;
  v_cat uuid; v_dest uuid;
  v_entity uuid;         -- the single entity every scoped line resolves to
  v_line_entity uuid;
  v_positions int[] := '{}';
  v_line_keys text[] := '{}';
begin
  if jsonb_typeof(p_lines) <> 'array'
     or jsonb_array_length(p_lines) < 2
     or jsonb_array_length(p_lines) > 100
  then raise exception 'KEEL_INVALID_COMMAND: template needs 2..100 lines' using errcode='P0009'; end if;

  for v_line in select value from jsonb_array_elements(p_lines) loop
    if jsonb_typeof(v_line) <> 'object'
       or (v_line - 'line_key' - 'kind' - 'role' - 'amount_kind' - 'amount_minor'
                  - 'bps' - 'category_ledger_account_id' - 'destination_account_id'
                  - 'position') <> '{}'::jsonb
    then raise exception 'KEEL_INVALID_COMMAND: unexpected line keys' using errcode='P0009'; end if;

    v_role := v_line->>'role';
    v_kind := v_line->>'kind';
    v_amount_kind := v_line->>'amount_kind';

    -- line_key + position uniqueness within the payload (before the table's own
    -- unique constraints; a duplicate would otherwise raise 23505 as a generic
    -- conflict — surface a typed error instead).
    if coalesce(v_line->>'line_key','') = '' or length(v_line->>'line_key') > 100 then
      raise exception 'KEEL_INVALID_COMMAND: line_key 1..100 chars' using errcode='P0009';
    end if;
    if v_line_keys @> array[v_line->>'line_key'] then
      raise exception 'KEEL_INVALID_COMMAND: duplicate line_key %', v_line->>'line_key' using errcode='P0009';
    end if;
    v_line_keys := v_line_keys || array[v_line->>'line_key'];
    if coalesce(v_line->>'position','') !~ '^(0|[1-9][0-9]*)$' then
      raise exception 'KEEL_INVALID_COMMAND: position must be a non-negative integer' using errcode='P0009';
    end if;
    if v_positions @> array[(v_line->>'position')::int] then
      raise exception 'KEEL_INVALID_COMMAND: duplicate position %', v_line->>'position' using errcode='P0009';
    end if;
    v_positions := v_positions || array[(v_line->>'position')::int];

    -- role/kind/amount_kind must be in-enum (a bad value would otherwise fail the
    -- ::enum cast on insert as 22P02 — surface it as a command error here).
    if v_role not in ('earning','tax','pretax_transfer','posttax_deduction','net_deposit')
       or v_kind not in ('gross_salary','bonus','commission','reimbursement',
            'federal_withholding','state_withholding','local_withholding','fica_withholding',
            'benefit','retirement_401k','employer_match','hsa','fsa','espp',
            'rsu_withholding','garnishment','direct_deposit')
       or v_amount_kind not in ('fixed_minor','percent_of_gross_bps','remainder')
    then raise exception 'KEEL_INVALID_COMMAND: role/kind/amount_kind out of enum' using errcode='P0009'; end if;

    -- amount shape (mirrors ck_ptl_amount_shape but typed).
    if v_amount_kind = 'fixed_minor' then
      if coalesce(v_line->>'amount_minor','') !~ '^(0|[1-9][0-9]*)$' or (v_line ? 'bps') then
        raise exception 'KEEL_INVALID_COMMAND: fixed_minor line needs amount_minor and no bps' using errcode='P0009';
      end if;
    elsif v_amount_kind = 'percent_of_gross_bps' then
      if coalesce(v_line->>'bps','') !~ '^[1-9][0-9]*$' or (v_line ? 'amount_minor') then
        raise exception 'KEEL_INVALID_COMMAND: percent line needs bps and no amount_minor' using errcode='P0009';
      end if;
      v_bps := (v_line->>'bps')::bigint;
      if v_bps <= 0 or v_bps >= 10000 then
        raise exception 'KEEL_INVALID_COMMAND: bps must be in (0,10000)' using errcode='P0009';
      end if;
      v_aggregate_bps := v_aggregate_bps + v_bps;
    else -- remainder
      if (v_line ? 'amount_minor') or (v_line ? 'bps') then
        raise exception 'KEEL_INVALID_COMMAND: remainder line carries no amount' using errcode='P0009';
      end if;
    end if;

    -- role tallies. The remainder net_deposit is THE residue line (exactly one).
    if v_role = 'earning' then v_earning_count := v_earning_count + 1; end if;
    if v_role = 'net_deposit' and v_amount_kind = 'remainder' then
      v_remainder_count := v_remainder_count + 1;
    end if;

    -- category presence coherence (mirrors ck_ptl_category_role) + LIVE
    -- same-entity category scope (§D2, Law 7).
    v_cat := nullif(v_line->>'category_ledger_account_id','')::uuid;
    if v_cat is not null then
      if v_role not in ('tax','posttax_deduction') then
        raise exception 'KEEL_INVALID_COMMAND: only tax/posttax lines carry a category' using errcode='P0009';
      end if;
      select entity_id into v_line_entity from public.ledger_accounts la
        where la.household_id = p_household_id and la.id = v_cat
          and la.is_category = true and la.archived_at is null;
      if v_line_entity is null then
        raise exception 'KEEL_INVALID_COMMAND: category_ledger_account_id must be a live same-household category' using errcode='P0009';
      end if;
      if v_entity is null then v_entity := v_line_entity;
      elsif v_entity <> v_line_entity then
        raise exception 'KEEL_INVALID_COMMAND: all template categories/destinations must share one entity' using errcode='P0009';
      end if;
    end if;

    -- destination presence coherence (mirrors ck_ptl_destination_presence) +
    -- MANUAL LIVE ASSET account scope (§D2).
    v_dest := nullif(v_line->>'destination_account_id','')::uuid;
    if v_role = 'pretax_transfer' then
      if v_dest is null then
        raise exception 'KEEL_INVALID_COMMAND: pretax_transfer needs a destination account' using errcode='P0009';
      end if;
      select la.entity_id into v_line_entity
        from public.accounts a
        join public.ledger_accounts la on la.household_id = a.household_id and la.id = a.ledger_account_id
        where a.household_id = p_household_id and a.id = v_dest
          and a.connection_id is null           -- MANUAL (unconnected) only (§D2)
          and a.archived_at is null              -- LIVE
          and la.kind = 'asset';                 -- ASSET only (§D2)
      if v_line_entity is null then
        raise exception 'KEEL_INVALID_COMMAND: destination must be a live manual (unconnected) asset account' using errcode='P0009';
      end if;
      if v_entity is null then v_entity := v_line_entity;
      elsif v_entity <> v_line_entity then
        raise exception 'KEEL_INVALID_COMMAND: all template categories/destinations must share one entity' using errcode='P0009';
      end if;
    elsif v_dest is not null then
      raise exception 'KEEL_INVALID_COMMAND: only pretax_transfer lines carry a destination' using errcode='P0009';
    end if;
  end loop;

  if v_earning_count <> 1 then
    raise exception 'KEEL_INVALID_COMMAND: template needs exactly one earning line (carries gross)' using errcode='P0009';
  end if;
  if v_remainder_count <> 1 then
    raise exception 'KEEL_INVALID_COMMAND: template needs exactly one remainder net_deposit line' using errcode='P0009';
  end if;
  -- The aggregate ΣP<10000 gate (§D3/§D4): without it the remainder can never be
  -- non-negative (net(G) = G(1 − P/10000) − ΣF …). Enforced at SAVE, not the table.
  if v_aggregate_bps >= 10000 then
    raise exception 'KEEL_INVALID_COMMAND: aggregate percent (%) must be < 10000 bps', v_aggregate_bps using errcode='P0009';
  end if;

  return v_entity;  -- may be null (a template with no category/destination lines)
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. keel_cmd_paycheck_save_template
-- Payload (snake_case, as delivered by the API's toSnakeKeys):
--   { series_id, employer_id, booking_enabled, lines: [ { line_key, kind, role,
--     amount_kind, amount_minor?, bps?, category_ledger_account_id?,
--     destination_account_id?, position } ] }
-- ---------------------------------------------------------------------------
create or replace function public.keel_cmd_paycheck_save_template(
  p_command_id uuid, p_economic_event_key text, p_actor jsonb, p_household_id uuid, p_payload jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_hash text := public.keel_payload_hash(p_payload);
  v_replay jsonb; v_actor jsonb;
  v_series_id uuid; v_employer_id uuid; v_booking_enabled boolean;
  v_lines jsonb; v_line jsonb;
  v_template_id uuid := gen_random_uuid();
  v_version int;
  v_entity uuid;
  v_blueprint jsonb;
  v_after jsonb; v_result jsonb;
  v_existing_autonomy public.autonomy_level;
begin
  -- save_template is a WRITE (partner or owner) — not an autonomy grant.
  perform public.keel_assert_member_write(p_household_id);
  v_actor := public.keel_actor_from_jwt();  -- derive actor from JWT (forgery guard, [AMENDED 5])
  v_replay := public.keel_idempotency_check(p_household_id, p_economic_event_key, v_hash);
  if v_replay is not null then return v_replay; end if;

  if jsonb_typeof(p_payload) <> 'object'
     or (p_payload - 'series_id' - 'employer_id' - 'booking_enabled' - 'lines') <> '{}'::jsonb
     or jsonb_typeof(p_payload->'lines') <> 'array'
     or jsonb_typeof(p_payload->'booking_enabled') <> 'boolean'
  then raise exception 'KEEL_INVALID_COMMAND: malformed save_template payload' using errcode='P0009'; end if;

  v_series_id := (p_payload->>'series_id')::uuid;
  v_employer_id := (p_payload->>'employer_id')::uuid;
  v_booking_enabled := (p_payload->>'booking_enabled')::boolean;
  v_lines := p_payload->'lines';

  -- Series + employer must be same-household (FK below re-checks, but a typed
  -- error is friendlier than a raw 23503).
  if not exists (select 1 from public.recurring_series s
                  where s.household_id = p_household_id and s.id = v_series_id) then
    raise exception 'KEEL_INVALID_COMMAND: series not in household' using errcode='P0009';
  end if;
  if not exists (select 1 from public.employers e
                  where e.household_id = p_household_id and e.id = v_employer_id) then
    raise exception 'KEEL_INVALID_COMMAND: employer not in household' using errcode='P0009';
  end if;

  -- Full cross-line validation (exactly-one-remainder, ΣP<10000, scope checks).
  v_entity := public.keel_paycheck_template_validate_lines(p_household_id, v_lines);

  -- New immutable version = max existing + 1 for this employer (Law 2/9).
  select coalesce(max(template_version), 0) + 1 into v_version
    from public.paycheck_templates
    where household_id = p_household_id and employer_id = v_employer_id;

  -- component_blueprint keeps the authored lines as jsonb for export/back-compat.
  v_blueprint := coalesce((
    select jsonb_agg(jsonb_build_object(
      'lineKey', l->>'line_key', 'kind', l->>'kind', 'role', l->>'role',
      'amountKind', l->>'amount_kind',
      'amountMinor', l->>'amount_minor', 'bps', (l->>'bps'),
      'categoryLedgerAccountId', l->>'category_ledger_account_id',
      'destinationAccountId', l->>'destination_account_id',
      'position', (l->>'position')::int)
      order by (l->>'position')::int)
    from jsonb_array_elements(v_lines) l), '[]'::jsonb);

  insert into public.paycheck_templates
    (household_id, id, employer_id, template_version, component_blueprint, formula_version)
  values (p_household_id, v_template_id, v_employer_id, v_version, v_blueprint, 'paycheck-split-template-v2');

  for v_line in select value from jsonb_array_elements(v_lines) loop
    insert into public.paycheck_template_lines
      (household_id, template_id, line_key, kind, role, amount_kind,
       amount_minor, bps, category_ledger_account_id, destination_account_id, position)
    values (
      p_household_id, v_template_id, v_line->>'line_key',
      (v_line->>'kind')::public.paycheck_component_kind,
      (v_line->>'role')::public.paycheck_line_role,
      (v_line->>'amount_kind')::public.paycheck_amount_kind,
      nullif(v_line->>'amount_minor','')::bigint,
      nullif(v_line->>'bps','')::int,
      nullif(v_line->>'category_ledger_account_id','')::uuid,
      nullif(v_line->>'destination_account_id','')::uuid,
      (v_line->>'position')::int
    );
  end loop;

  -- Upsert the series pointer WITHOUT changing autonomy. A new series row is
  -- created with autonomy 'off' (the safe default the OWNER later grants up via
  -- set_series_settings). booking_enabled is authored here (still owner-only to
  -- FLIP autonomy, but booking is a partner-level display choice).
  select autonomy into v_existing_autonomy from public.paycheck_series_settings
    where household_id = p_household_id and series_id = v_series_id;

  insert into public.paycheck_series_settings
    (household_id, series_id, employer_id, active_template_id, booking_enabled, autonomy)
  values (p_household_id, v_series_id, v_employer_id, v_template_id, v_booking_enabled, 'off')
  on conflict (household_id, series_id) do update
    set active_template_id = excluded.active_template_id,
        booking_enabled = excluded.booking_enabled,
        employer_id = excluded.employer_id,
        updated_at = now();

  v_after := jsonb_build_object(
    'templateId', v_template_id, 'templateVersion', v_version,
    'seriesId', v_series_id, 'employerId', v_employer_id,
    'bookingEnabled', v_booking_enabled, 'lineCount', jsonb_array_length(v_lines),
    'entityId', v_entity, 'formulaVersion', 'paycheck-split-template-v2');
  v_result := jsonb_build_object(
    'commandId', p_command_id, 'economicEventKey', p_economic_event_key,
    'idempotentReplay', false, 'effects', v_after,
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'));

  perform public.keel_finish_command(
    p_command_id, 'paychecks.save_template', p_economic_event_key, p_household_id,
    v_actor, v_hash, 'paychecks.template_saved', 'paycheck_template', v_template_id,
    v_after, v_result);
  return v_result;
exception
  when numeric_value_out_of_range then
    raise exception 'KEEL_INVALID_COMMAND: template amount outside bigint' using errcode='P0009';
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. keel_cmd_paycheck_set_series_settings — the OWNER-only autonomy grant.
-- Payload (snake_case):
--   { series_id, employer_id, active_template_id?, booking_enabled,
--     income_category_ledger_account_id?, autonomy }
-- ---------------------------------------------------------------------------
create or replace function public.keel_cmd_paycheck_set_series_settings(
  p_command_id uuid, p_economic_event_key text, p_actor jsonb, p_household_id uuid, p_payload jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_hash text := public.keel_payload_hash(p_payload);
  v_replay jsonb; v_actor jsonb;
  v_series_id uuid; v_employer_id uuid; v_template_id uuid; v_income_cat uuid;
  v_booking_enabled boolean; v_autonomy public.autonomy_level;
  v_before jsonb; v_after jsonb; v_result jsonb;
  v_existing public.paycheck_series_settings%rowtype;
begin
  -- Autonomy is a POLICY change — OWNER only, enforced at the DB (§3/[AMENDED 6];
  -- keel_assert_member_write would wrongly permit a partner).
  perform public.keel_assert_member_owner(p_household_id);
  v_actor := public.keel_actor_from_jwt();  -- derive actor from JWT (forgery guard)
  v_replay := public.keel_idempotency_check(p_household_id, p_economic_event_key, v_hash);
  if v_replay is not null then return v_replay; end if;

  if jsonb_typeof(p_payload) <> 'object'
     or (p_payload - 'series_id' - 'employer_id' - 'active_template_id'
                   - 'booking_enabled' - 'income_category_ledger_account_id' - 'autonomy') <> '{}'::jsonb
     or jsonb_typeof(p_payload->'booking_enabled') <> 'boolean'
     or coalesce(p_payload->>'autonomy','') not in ('off','suggest','auto_with_log')
  then raise exception 'KEEL_INVALID_COMMAND: malformed set_series_settings payload' using errcode='P0009'; end if;

  v_series_id := (p_payload->>'series_id')::uuid;
  v_employer_id := (p_payload->>'employer_id')::uuid;
  v_template_id := nullif(p_payload->>'active_template_id','')::uuid;
  v_income_cat := nullif(p_payload->>'income_category_ledger_account_id','')::uuid;
  v_booking_enabled := (p_payload->>'booking_enabled')::boolean;
  v_autonomy := (p_payload->>'autonomy')::public.autonomy_level;

  if not exists (select 1 from public.recurring_series s
                  where s.household_id = p_household_id and s.id = v_series_id) then
    raise exception 'KEEL_INVALID_COMMAND: series not in household' using errcode='P0009';
  end if;
  if not exists (select 1 from public.employers e
                  where e.household_id = p_household_id and e.id = v_employer_id) then
    raise exception 'KEEL_INVALID_COMMAND: employer not in household' using errcode='P0009';
  end if;
  -- active_template_id must be same-household + same-employer when present.
  if v_template_id is not null and not exists (
    select 1 from public.paycheck_templates t
     where t.household_id = p_household_id and t.id = v_template_id and t.employer_id = v_employer_id
  ) then
    raise exception 'KEEL_INVALID_COMMAND: active_template_id not a template of this employer' using errcode='P0009';
  end if;
  -- income category (booking anchor) must be a live same-household income category.
  if v_income_cat is not null and not exists (
    select 1 from public.ledger_accounts la
     where la.household_id = p_household_id and la.id = v_income_cat
       and la.is_category = true and la.kind = 'income' and la.archived_at is null
  ) then
    raise exception 'KEEL_INVALID_COMMAND: income category must be a live income category' using errcode='P0009';
  end if;
  -- auto_with_log requires an active template (Slice-B CHECK; typed here).
  if v_autonomy = 'auto_with_log' and v_template_id is null then
    raise exception 'KEEL_INVALID_COMMAND: auto_with_log requires an active_template_id' using errcode='P0009';
  end if;

  -- Capture BEFORE (this row IS the grant record — audit shows before/after, §D7).
  select * into v_existing from public.paycheck_series_settings
    where household_id = p_household_id and series_id = v_series_id;
  if found then
    v_before := jsonb_build_object(
      'activeTemplateId', v_existing.active_template_id,
      'bookingEnabled', v_existing.booking_enabled,
      'incomeCategoryLedgerAccountId', v_existing.income_category_ledger_account_id,
      'autonomy', v_existing.autonomy);
  else
    v_before := null;
  end if;

  insert into public.paycheck_series_settings
    (household_id, series_id, employer_id, active_template_id, booking_enabled,
     income_category_ledger_account_id, autonomy)
  values (p_household_id, v_series_id, v_employer_id, v_template_id, v_booking_enabled,
     v_income_cat, v_autonomy)
  on conflict (household_id, series_id) do update
    set active_template_id = excluded.active_template_id,
        booking_enabled = excluded.booking_enabled,
        income_category_ledger_account_id = excluded.income_category_ledger_account_id,
        autonomy = excluded.autonomy,
        employer_id = excluded.employer_id,
        updated_at = now();

  v_after := jsonb_build_object(
    'seriesId', v_series_id, 'employerId', v_employer_id,
    'activeTemplateId', v_template_id, 'bookingEnabled', v_booking_enabled,
    'incomeCategoryLedgerAccountId', v_income_cat, 'autonomy', v_autonomy);
  v_result := jsonb_build_object(
    'commandId', p_command_id, 'economicEventKey', p_economic_event_key,
    'idempotentReplay', false, 'effects', v_after,
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'));

  -- The grant record: an explicit before/after audit row. keel_finish_command
  -- records `after` only, so the BEFORE (prior autonomy/template) would otherwise
  -- be lost — §D7 wants the policy transition visible. audit_log is append-only;
  -- this companion row carries before → after for the autonomy grant.
  insert into public.audit_log
    (household_id, actor, action, object_type, object_id, command_id, before, after)
  values (p_household_id, v_actor, 'paychecks.set_series_settings.grant',
          'paycheck_series_settings', v_series_id, p_command_id, v_before, v_after);

  -- keel_finish_command records the domain event + command execution
  -- (idempotency) + its own after-only audit row.
  perform public.keel_finish_command(
    p_command_id, 'paychecks.set_series_settings', p_economic_event_key, p_household_id,
    v_actor, v_hash, 'paychecks.series_settings_set', 'paycheck_series_settings', v_series_id,
    v_after, v_result);
  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- Ownership / grant ritual (grant-create → alter-owner → revoke-create wrapper
-- for every new keel_api-owned function; prior slices hit 'permission denied for
-- schema public' without it — ops fact). All four new functions owned by
-- keel_api, executable by authenticated (the API calls them via keel_api).
-- ---------------------------------------------------------------------------
grant create on schema public to keel_api;
alter function public.keel_assert_member_owner(uuid) owner to keel_api;
alter function public.keel_paycheck_template_validate_lines(uuid, jsonb) owner to keel_api;
alter function public.keel_cmd_paycheck_save_template(uuid, text, jsonb, uuid, jsonb) owner to keel_api;
alter function public.keel_cmd_paycheck_set_series_settings(uuid, text, jsonb, uuid, jsonb) owner to keel_api;
revoke create on schema public from keel_api;

revoke all on function public.keel_assert_member_owner(uuid) from public, anon;
revoke all on function public.keel_paycheck_template_validate_lines(uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.keel_cmd_paycheck_save_template(uuid, text, jsonb, uuid, jsonb) from public, anon;
revoke all on function public.keel_cmd_paycheck_set_series_settings(uuid, text, jsonb, uuid, jsonb) from public, anon;

-- keel_assert_member_owner is an internal assertion; authenticated may call it
-- (it only ever raises or returns the role) — mirrors keel_assert_member_write's
-- exposure. The command procs are execute-granted to authenticated (via keel_api).
grant execute on function public.keel_cmd_paycheck_save_template(uuid, text, jsonb, uuid, jsonb) to authenticated;
grant execute on function public.keel_cmd_paycheck_set_series_settings(uuid, text, jsonb, uuid, jsonb) to authenticated;

-- Fail-closed ownership assertion (mirrors 20260721180000 §10 / approval_tokens).
do $$begin
  if exists (select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    join pg_roles r on r.oid = p.proowner
    where n.nspname = 'public' and p.proname in
      ('keel_assert_member_owner','keel_paycheck_template_validate_lines',
       'keel_cmd_paycheck_save_template','keel_cmd_paycheck_set_series_settings')
      and p.prosecdef and r.rolname <> 'keel_api')
  then raise exception 'KEEL_OWNERSHIP: paycheck template command owner'; end if;
end$$;
