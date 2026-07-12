-- Stage 1D recurring domain (BC-v2.1 gate 5, PLAN-1D-RECURRING v2).
-- Detection is suggest-only. Immutable detector inputs/candidates are kept
-- separately from the user-owned logical series and append-only status events.

create type public.recurring_series_status as enum
  ('suggested', 'confirmed', 'paused', 'cancelled', 'rejected');
create type public.recurring_transition as enum
  ('suggested', 'confirmed', 'paused', 'resumed', 'cancelled', 'rejected');
create type public.recurring_cadence as enum
  ('weekly', 'biweekly', 'semimonthly', 'monthly', 'quarterly', 'annual');
create type public.recurring_amount_kind as enum ('fixed', 'variable');
create type public.recurring_sign as enum ('inflow', 'outflow');
create type public.recurring_occurrence_status as enum
  ('expected', 'matched', 'skipped', 'unexpected', 'paused', 'cancelled');

alter table public.ledger_accounts
  add constraint ledger_accounts_household_id_id_key unique (household_id, id);

create table public.recurring_detector_runs (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id),
  run_key text not null check (length(run_key) between 8 and 256),
  as_of timestamptz not null,
  detector_version text not null check (length(detector_version) between 1 and 100),
  confidence_version text not null check (length(confidence_version) between 1 and 100),
  normalizer_version text not null check (length(normalizer_version) between 1 and 100),
  candidate_snapshot_hash text not null check (candidate_snapshot_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  unique (household_id, run_key),
  unique (household_id, id)
);

create table public.recurring_series (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id),
  series_key text not null check (length(series_key) between 1 and 128),
  account_id uuid not null,
  ledger_account_id uuid not null,
  counterparty_key text not null check (length(counterparty_key) between 1 and 500),
  currency char(3) not null check (currency = upper(currency)),
  sign public.recurring_sign not null,
  status public.recurring_series_status not null,
  current_candidate_version_id uuid,
  confirmed_by uuid references auth.users(id),
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (household_id, id),
  unique (household_id, series_key),
  constraint fk_recurring_series_account_tenant
    foreign key (household_id, account_id)
    references public.accounts(household_id, id) match simple on delete restrict,
  constraint fk_recurring_series_ledger_account_tenant
    foreign key (household_id, ledger_account_id)
    references public.ledger_accounts(household_id, id) match simple on delete restrict
);

create table public.recurring_candidate_versions (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id),
  series_id uuid not null,
  detector_run_id uuid not null,
  candidate_hash text not null check (candidate_hash ~ '^[a-f0-9]{64}$'),
  input_fingerprint text not null check (input_fingerprint ~ '^[a-f0-9]{16,64}$'),
  detector_version text not null,
  confidence_version text not null,
  normalizer_version text not null,
  as_of timestamptz not null,
  score_bps integer not null check (score_bps between 1 and 10000),
  evidence jsonb not null check (jsonb_typeof(evidence) = 'array' and jsonb_array_length(evidence) >= 3),
  candidate jsonb not null check (jsonb_typeof(candidate) = 'object'),
  created_at timestamptz not null default now(),
  unique (household_id, id),
  unique (household_id, series_id, input_fingerprint),
  constraint fk_recurring_candidate_series_tenant
    foreign key (household_id, series_id)
    references public.recurring_series(household_id, id) match simple on delete restrict,
  constraint fk_recurring_candidate_run_tenant
    foreign key (household_id, detector_run_id)
    references public.recurring_detector_runs(household_id, id) match simple on delete restrict
);

alter table public.recurring_series
  add constraint fk_recurring_series_current_candidate_tenant
  foreign key (household_id, current_candidate_version_id)
  references public.recurring_candidate_versions(household_id, id)
  match simple on delete restrict;

create table public.recurring_occurrences (
  household_id uuid not null references public.households(id),
  id uuid not null default gen_random_uuid(),
  series_id uuid not null,
  candidate_version_id uuid not null,
  occurrence_key text not null check (occurrence_key ~ '^[a-f0-9]{16,64}$'),
  expected_date date not null,
  expected_amount_minor bigint not null,
  currency char(3) not null check (currency = upper(currency)),
  amount_kind public.recurring_amount_kind not null,
  status public.recurring_occurrence_status not null,
  matched_txn_id uuid,
  score_bps integer not null check (score_bps between 1 and 10000),
  evidence jsonb not null check (jsonb_typeof(evidence) = 'array' and jsonb_array_length(evidence) >= 3),
  input_fingerprint text not null check (input_fingerprint ~ '^[a-f0-9]{16,64}$'),
  detector_version text not null,
  confidence_version text not null,
  as_of timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (household_id, id),
  unique (household_id, series_id, candidate_version_id, expected_date),
  unique (household_id, occurrence_key),
  constraint fk_recurring_occurrence_series_tenant
    foreign key (household_id, series_id)
    references public.recurring_series(household_id, id) match simple on delete restrict,
  constraint fk_recurring_occurrence_candidate_tenant
    foreign key (household_id, candidate_version_id)
    references public.recurring_candidate_versions(household_id, id) match simple on delete restrict,
  constraint fk_recurring_occurrence_matched_txn_tenant
    foreign key (household_id, matched_txn_id)
    references public.canonical_transactions(household_id, id) match simple on delete restrict
);

create table public.recurring_status_events (
  household_id uuid not null references public.households(id),
  id uuid not null default gen_random_uuid(),
  series_id uuid not null,
  candidate_version_id uuid not null,
  transition public.recurring_transition not null,
  effective_date date not null,
  actor jsonb not null,
  command_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (household_id, id),
  unique (household_id, series_id, command_id, transition),
  constraint fk_recurring_status_series_tenant
    foreign key (household_id, series_id)
    references public.recurring_series(household_id, id) match simple on delete restrict,
  constraint fk_recurring_status_candidate_tenant
    foreign key (household_id, candidate_version_id)
    references public.recurring_candidate_versions(household_id, id) match simple on delete restrict
);

create trigger recurring_detector_runs_immutable
  before update or delete on public.recurring_detector_runs
  for each row execute function public.keel_forbid_mutation();
create trigger recurring_candidate_versions_immutable
  before update or delete on public.recurring_candidate_versions
  for each row execute function public.keel_forbid_mutation();
create trigger recurring_occurrences_immutable
  before update or delete on public.recurring_occurrences
  for each row execute function public.keel_forbid_mutation();
create trigger recurring_status_events_immutable
  before update or delete on public.recurring_status_events
  for each row execute function public.keel_forbid_mutation();

-- Same account-scope rule used by RLS and command procedures. Household
-- membership alone never reveals a hidden account.
create function public.keel_recurring_account_access(
  p_household_id uuid,
  p_account_id uuid,
  p_write boolean
) returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.household_memberships membership
     where membership.household_id = p_household_id
       and membership.user_id = coalesce(
         nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
         nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
       )::uuid
       and (not p_write or membership.role in ('owner', 'partner'))
  ) and (
    exists (
      select 1 from public.account_owners owner_row
      join public.accounts account_row on account_row.id = owner_row.account_id
       where owner_row.user_id = coalesce(
         nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
         nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
       )::uuid
         and account_row.household_id = p_household_id
         and account_row.id = p_account_id
    )
    or exists (
      select 1 from public.resource_permissions permission_row
       where permission_row.household_id = p_household_id
         and permission_row.user_id = coalesce(
           nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
           nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
         )::uuid
         and permission_row.resource_kind = 'account'
         and permission_row.resource_id = p_account_id
         and (
           (not p_write and permission_row.permission in ('view', 'edit', 'export'))
           or (p_write and permission_row.permission = 'edit')
         )
    )
  );
$$;

-- Service-only ledger read. Amount truth comes from the current live batch's
-- one asset real-account posting; pending/voided/multi-real-account rows fail closed.
create function public.keel_recurring_read_txns(p_household_id uuid) returns jsonb
language sql
security definer
stable
set search_path = public
as $$
  select coalesce(jsonb_agg(row.dto order by row.effective_date, row.txn_id), '[]'::jsonb)
  from (
    select transaction_row.id as txn_id,
      transaction_row.effective_date,
      jsonb_build_object(
        'txnId', transaction_row.id,
        'batchId', live_batch.id,
        'postingId', asset_posting.id,
        'accountId', account_row.id,
        'ledgerAccountId', asset_posting.ledger_account_id,
        'effectiveDate', to_char(transaction_row.effective_date, 'YYYY-MM-DD'),
        'amountMinor', asset_posting.amount_minor::text,
        'currency', asset_posting.currency::text,
        'description', transaction_row.description
      ) as dto
    from public.canonical_transactions transaction_row
    join public.accounts account_row
      on account_row.household_id = transaction_row.household_id
     and account_row.id = transaction_row.account_id
    join lateral (
      select batch_row.*
      from public.journal_batches batch_row
      where batch_row.household_id = transaction_row.household_id
        and batch_row.canonical_transaction_id = transaction_row.id
        and batch_row.reverses_batch_id is null
        and not exists (
          select 1 from public.journal_revisions revision
           where revision.original_batch_id = batch_row.id
        )
      order by batch_row.posted_at desc, batch_row.id desc
      limit 1
    ) live_batch on true
    join public.journal_postings asset_posting
      on asset_posting.batch_id = live_batch.id
     and asset_posting.ledger_account_id = account_row.ledger_account_id
    join public.ledger_accounts asset_ledger
      on asset_ledger.household_id = transaction_row.household_id
     and asset_ledger.id = asset_posting.ledger_account_id
     and asset_ledger.kind = 'asset'
    where transaction_row.household_id = p_household_id
      and transaction_row.status in ('posted', 'reviewed')
      and transaction_row.voided_at is null
      and (
        select count(*)
        from public.journal_postings posting_row
        join public.accounts real_account
          on real_account.household_id = transaction_row.household_id
         and real_account.ledger_account_id = posting_row.ledger_account_id
        where posting_row.batch_id = live_batch.id
      ) = 1
    order by transaction_row.effective_date desc, transaction_row.id desc
    limit 10000
  ) row;
$$;

-- SQL-authoritative cadence projection. Epoch grids use integer days from
-- 1970-01-01; month grids use proleptic-Gregorian make_date and explicit
-- end-of-month clamping, matching packages/detectors/src/cadence.ts.
create function public.keel_recurring_cadence_dates(
  p_candidate jsonb,
  p_from_date date,
  p_to_date date
) returns table(expected_date date)
language plpgsql
immutable
strict
set search_path = pg_catalog
as $$
declare
  v_anchor jsonb := p_candidate->'cadenceAnchor';
  v_kind text;
  v_interval integer;
  v_anchor_epoch integer;
  v_from_epoch integer;
  v_to_epoch integer;
  v_first_epoch integer;
  v_month_index integer;
  v_from_month integer;
  v_to_month integer;
  v_year integer;
  v_month integer;
  v_day integer;
  v_phase integer;
  v_anchor_day integer;
  v_last_day integer;
begin
  if p_from_date > p_to_date then return; end if;
  if jsonb_typeof(v_anchor) <> 'object' then
    raise exception 'KEEL_INVALID_COMMAND: cadence anchor must be an object' using errcode = 'P0009';
  end if;
  v_kind := v_anchor->>'kind';

  if v_kind = 'epoch_grid' then
    if coalesce(v_anchor->>'intervalDays','') !~ '^[0-9]+$'
       or coalesce(v_anchor->>'anchorEpochDay','') !~ '^-?[0-9]+$' then
      raise exception 'KEEL_INVALID_COMMAND: invalid epoch cadence anchor' using errcode = 'P0009';
    end if;
    v_interval := (v_anchor->>'intervalDays')::integer;
    v_anchor_epoch := (v_anchor->>'anchorEpochDay')::integer;
    if v_interval not in (7,14) then
      raise exception 'KEEL_INVALID_COMMAND: invalid epoch cadence interval' using errcode = 'P0009';
    end if;
    v_from_epoch := p_from_date - date '1970-01-01';
    v_to_epoch := p_to_date - date '1970-01-01';
    v_first_epoch := v_from_epoch + mod(v_interval - mod(mod(v_from_epoch - v_anchor_epoch, v_interval) + v_interval, v_interval), v_interval);
    for v_anchor_epoch in v_first_epoch..v_to_epoch by v_interval loop
      expected_date := date '1970-01-01' + v_anchor_epoch;
      return next;
    end loop;
    return;
  end if;

  v_from_month := extract(year from p_from_date)::integer * 12
    + extract(month from p_from_date)::integer - 1;
  v_to_month := extract(year from p_to_date)::integer * 12
    + extract(month from p_to_date)::integer - 1;

  if v_kind = 'day_of_month' then
    if coalesce(v_anchor->>'day','') !~ '^[0-9]+$'
       or coalesce(v_anchor->>'intervalMonths','') !~ '^[0-9]+$'
       or coalesce(v_anchor->>'phase','') !~ '^[0-9]+$' then
      raise exception 'KEEL_INVALID_COMMAND: invalid monthly cadence anchor' using errcode = 'P0009';
    end if;
    v_day := (v_anchor->>'day')::integer;
    v_interval := (v_anchor->>'intervalMonths')::integer;
    v_phase := (v_anchor->>'phase')::integer;
    if v_day not between 1 and 31 or v_interval not in (1,3,12)
       or v_phase < 0 or v_phase >= v_interval then
      raise exception 'KEEL_INVALID_COMMAND: invalid monthly cadence values' using errcode = 'P0009';
    end if;
  elsif v_kind = 'day_pair' then
    if jsonb_typeof(v_anchor->'days') <> 'array'
       or jsonb_array_length(v_anchor->'days') <> 2
       or exists (select 1 from jsonb_array_elements_text(v_anchor->'days') value
                   where value !~ '^[0-9]+$' or value::integer not between 1 and 31) then
      raise exception 'KEEL_INVALID_COMMAND: invalid semimonthly cadence anchor' using errcode = 'P0009';
    end if;
  else
    raise exception 'KEEL_INVALID_COMMAND: unsupported cadence anchor' using errcode = 'P0009';
  end if;

  for v_month_index in v_from_month..v_to_month loop
    if v_kind = 'day_of_month' and mod(v_month_index, v_interval) <> v_phase then continue; end if;
    v_year := v_month_index / 12;
    v_month := mod(v_month_index, 12) + 1;
    v_last_day := extract(day from (make_date(v_year, v_month, 1) + interval '1 month - 1 day'))::integer;
    for v_anchor_day in
      select value::integer from (
        select v_day::text as value where v_kind = 'day_of_month'
        union all
        select value from jsonb_array_elements_text(v_anchor->'days') where v_kind = 'day_pair'
      ) anchor_days order by value::integer
    loop
      expected_date := make_date(v_year, v_month, least(v_anchor_day, v_last_day));
      if expected_date between p_from_date and p_to_date then return next; end if;
    end loop;
  end loop;
exception
  when invalid_datetime_format or datetime_field_overflow or numeric_value_out_of_range then
    raise exception 'KEEL_INVALID_COMMAND: invalid cadence civil date' using errcode = 'P0009';
end;
$$;

create function public.keel_recurring_upsert_candidates(
  p_household_id uuid,
  p_run_key text,
  p_as_of timestamptz,
  p_detector_version text,
  p_confidence_version text,
  p_normalizer_version text,
  p_candidates jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run_id uuid;
  v_candidate jsonb;
  v_series public.recurring_series%rowtype;
  v_candidate_id uuid;
  v_candidate_hash text;
  v_requested_candidate_hash text;
  v_snapshot_hash text := public.keel_payload_hash(p_candidates);
  v_series_key text;
  v_inserted boolean;
  v_result jsonb := '[]'::jsonb;
begin
  if not exists (select 1 from public.households where id = p_household_id) then
    raise exception 'KEEL_SCOPE_VIOLATION: household not found' using errcode = 'P0006';
  end if;
  if jsonb_typeof(p_candidates) <> 'array' then
    raise exception 'KEEL_INVALID_COMMAND: candidates must be an array' using errcode = 'P0009';
  end if;

  insert into public.recurring_detector_runs
    (household_id, run_key, as_of, detector_version, confidence_version, normalizer_version,
     candidate_snapshot_hash)
  values
    (p_household_id, p_run_key, p_as_of, p_detector_version, p_confidence_version,
     p_normalizer_version, v_snapshot_hash)
  on conflict (household_id, run_key) do nothing
  returning id into v_run_id;
  if v_run_id is null then
    select id into v_run_id from public.recurring_detector_runs
     where household_id = p_household_id and run_key = p_run_key
       and as_of = p_as_of and detector_version = p_detector_version
       and confidence_version = p_confidence_version
       and normalizer_version = p_normalizer_version
       and candidate_snapshot_hash = v_snapshot_hash;
    if v_run_id is null then
      raise exception 'KEEL_IDEMPOTENCY_CONFLICT: detector run changed' using errcode = 'P0007';
    end if;
  end if;

  for v_candidate in select value from jsonb_array_elements(p_candidates) loop
    if v_candidate->>'detectorVersion' is distinct from p_detector_version
       or v_candidate->>'confidenceVersion' is distinct from p_confidence_version
       or v_candidate->>'normalizerVersion' is distinct from p_normalizer_version
       or v_candidate->>'asOf' is distinct from to_char(p_as_of at time zone 'utc', 'YYYY-MM-DD')
       or coalesce((v_candidate->>'requiresApproval')::boolean, false) is not true
       or jsonb_typeof(v_candidate->'evidence') <> 'array'
       or jsonb_array_length(v_candidate->'evidence') < 3 then
      raise exception 'KEEL_INVALID_COMMAND: candidate derivation metadata mismatch'
        using errcode = 'P0009';
    end if;
    if exists (
      select 1 from jsonb_array_elements(v_candidate->'evidence') evidence_row
      where jsonb_typeof(evidence_row) <> 'object'
         or not (evidence_row ?& array['txnId','batchId','postingId'])
         or evidence_row->>'txnId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
         or evidence_row->>'batchId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
         or evidence_row->>'postingId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    ) then
      raise exception 'KEEL_INVALID_COMMAND: malformed recurring evidence reference'
        using errcode = 'P0009';
    end if;
    if not exists (
      select 1 from public.accounts account_row
      join public.ledger_accounts ledger_row
        on ledger_row.household_id = account_row.household_id
       and ledger_row.id = account_row.ledger_account_id
       where account_row.household_id = p_household_id
         and account_row.id = (v_candidate->>'accountId')::uuid
         and ledger_row.id = (v_candidate->>'ledgerAccountId')::uuid
         and account_row.currency = v_candidate->>'currency'
    ) then
      raise exception 'KEEL_SCOPE_VIOLATION: candidate account is not in household'
        using errcode = 'P0006';
    end if;

    if exists (
      select 1 from jsonb_array_elements(v_candidate->'evidence') evidence_row
      where not exists (
        select 1
        from public.canonical_transactions transaction_row
        join lateral (
          select batch_row.id
          from public.journal_batches batch_row
          where batch_row.household_id = transaction_row.household_id
            and batch_row.canonical_transaction_id = transaction_row.id
            and batch_row.reverses_batch_id is null
            and not exists (select 1 from public.journal_revisions revision
              where revision.original_batch_id = batch_row.id)
          order by batch_row.posted_at desc, batch_row.id desc
          limit 1
        ) live_batch on live_batch.id = (evidence_row->>'batchId')::uuid
        join public.journal_postings posting_row
          on posting_row.id = (evidence_row->>'postingId')::uuid
         and posting_row.batch_id = live_batch.id
         and posting_row.ledger_account_id = (v_candidate->>'ledgerAccountId')::uuid
        where transaction_row.household_id = p_household_id
          and transaction_row.id = (evidence_row->>'txnId')::uuid
          and transaction_row.account_id = (v_candidate->>'accountId')::uuid
          and transaction_row.status in ('posted','reviewed')
          and transaction_row.voided_at is null
      )
    ) then
      raise exception 'KEEL_SCOPE_VIOLATION: recurring evidence is not a tenant-owned live posting'
        using errcode = 'P0006';
    end if;

    v_series_key := v_candidate->>'seriesKey';
    insert into public.recurring_series
      (household_id, series_key, account_id, ledger_account_id, counterparty_key,
       currency, sign, status)
    values
      (p_household_id, v_series_key, (v_candidate->>'accountId')::uuid,
       (v_candidate->>'ledgerAccountId')::uuid, v_candidate->>'counterpartyKey',
       v_candidate->>'currency', (v_candidate->>'sign')::public.recurring_sign,
       'suggested')
    on conflict (household_id, series_key) do nothing;
    select * into v_series from public.recurring_series
     where household_id = p_household_id and series_key = v_series_key
     for update;
    if not found then
      raise exception 'KEEL_IDEMPOTENCY_CONFLICT: series creation lost'
        using errcode = 'P0007';
    elsif v_series.account_id <> (v_candidate->>'accountId')::uuid
       or v_series.ledger_account_id <> (v_candidate->>'ledgerAccountId')::uuid
       or v_series.currency <> v_candidate->>'currency'
       or v_series.sign <> (v_candidate->>'sign')::public.recurring_sign then
      raise exception 'KEEL_IDEMPOTENCY_CONFLICT: series key changed scope'
        using errcode = 'P0007';
    end if;

    v_requested_candidate_hash := public.keel_payload_hash(v_candidate);
    v_candidate_hash := v_requested_candidate_hash;
    v_candidate_id := null;
    insert into public.recurring_candidate_versions
      (household_id, series_id, detector_run_id, candidate_hash, input_fingerprint,
       detector_version, confidence_version, normalizer_version, as_of, score_bps,
       evidence, candidate)
    values
      (p_household_id, v_series.id, v_run_id, v_requested_candidate_hash,
       v_candidate->>'inputFingerprint', p_detector_version, p_confidence_version,
       p_normalizer_version, p_as_of, (v_candidate->>'scoreBps')::integer,
       v_candidate->'evidence', v_candidate)
    on conflict (household_id, series_id, input_fingerprint) do nothing
    returning id into v_candidate_id;
    v_inserted := v_candidate_id is not null;
    if v_candidate_id is null then
      select id, candidate_hash into v_candidate_id, v_candidate_hash
        from public.recurring_candidate_versions
       where household_id = p_household_id and series_id = v_series.id
         and input_fingerprint = v_candidate->>'inputFingerprint';
      if v_candidate_hash is distinct from v_requested_candidate_hash then
        raise exception 'KEEL_IDEMPOTENCY_CONFLICT: candidate fingerprint changed material result'
          using errcode = 'P0007';
      end if;
    end if;

    if v_inserted then
      if v_series.status in ('suggested', 'rejected') then
        update public.recurring_series
           set current_candidate_version_id = v_candidate_id, updated_at = now()
         where household_id = p_household_id and id = v_series.id;
      end if;
      insert into public.audit_log
        (household_id, actor, action, object_type, object_id, command_id, before, after)
      values
        (p_household_id, jsonb_build_object('kind','system','processName','recurring-detector'),
         'recurring.suggested', 'recurring_series', v_series.id, gen_random_uuid(), null,
         jsonb_build_object('seriesId', v_series.id, 'candidateVersionId', v_candidate_id,
                            'candidateVersionHash', v_candidate_hash, 'status', v_series.status));
    end if;
    v_result := v_result || jsonb_build_object(
      'seriesId', v_series.id,
      'candidateVersionId', v_candidate_id,
      'candidateVersionHash', v_candidate_hash,
      'inserted', v_inserted,
      'status', v_series.status
    );
  end loop;
  return jsonb_build_object('runId', v_run_id, 'candidates', v_result);
end;
$$;

create function public.keel_recurring_transition_core(
  p_command_id uuid,
  p_economic_event_key text,
  p_actor jsonb,
  p_household_id uuid,
  p_payload jsonb,
  p_transition public.recurring_transition
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hash text := public.keel_payload_hash(p_payload);
  v_replay jsonb;
  v_actor jsonb;
  v_series public.recurring_series%rowtype;
  v_candidate public.recurring_candidate_versions%rowtype;
  v_before jsonb;
  v_after jsonb;
  v_status public.recurring_series_status;
  v_latest_transition public.recurring_transition;
  v_effective_transition public.recurring_transition;
  v_effective_date date;
  v_last_effective_date date;
  v_projection_start date;
  v_projection_end date;
  v_expected_date date;
  v_horizon_days integer;
  v_expected_amount text;
  v_occurrence_key text;
  v_occurrence_fingerprint text;
  v_occurrence_evidence jsonb;
  v_timeline_snapshot jsonb;
  v_result jsonb;
begin
  perform public.keel_assert_member_write(p_household_id);
  v_actor := public.keel_actor_from_jwt();
  v_replay := public.keel_idempotency_check(p_household_id, p_economic_event_key, v_hash);
  if v_replay is not null then return v_replay; end if;

  if jsonb_typeof(p_payload) <> 'object'
     or coalesce(p_payload->>'series_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or not (p_payload ? 'effective_date') then
    raise exception 'KEEL_INVALID_COMMAND: malformed recurring transition payload'
      using errcode = 'P0009';
  end if;
  if p_transition in ('confirmed','resumed') then
    if (p_payload - 'series_id' - 'effective_date' - 'horizon_days') <> '{}'::jsonb
       or coalesce(p_payload->>'horizon_days','') !~ '^[0-9]+$' then
      raise exception 'KEEL_INVALID_COMMAND: projection payload fields are invalid'
        using errcode = 'P0009';
    end if;
    begin
      v_horizon_days := (p_payload->>'horizon_days')::integer;
    exception when numeric_value_out_of_range then
      raise exception 'KEEL_INVALID_COMMAND: projection horizon is invalid' using errcode = 'P0009';
    end;
    if v_horizon_days not between 1 and 366 then
      raise exception 'KEEL_INVALID_COMMAND: projection horizon must be between 1 and 366'
        using errcode = 'P0009';
    end if;
  elsif (p_payload - 'series_id' - 'effective_date') <> '{}'::jsonb then
    raise exception 'KEEL_INVALID_COMMAND: transition payload fields are invalid'
      using errcode = 'P0009';
  end if;
  begin
    if coalesce(p_payload->>'effective_date','') !~ '^\d{4}-\d{2}-\d{2}$' then
      raise exception 'invalid date shape';
    end if;
    v_effective_date := (p_payload->>'effective_date')::date;
    if to_char(v_effective_date, 'YYYY-MM-DD') is distinct from p_payload->>'effective_date' then
      raise exception 'non-canonical date';
    end if;
  exception when others then
    raise exception 'KEEL_INVALID_COMMAND: invalid Gregorian effective date' using errcode = 'P0009';
  end;

  select * into v_series from public.recurring_series
   where household_id = p_household_id and id = (p_payload->>'series_id')::uuid
   for update;
  if not found or not public.keel_recurring_account_access(p_household_id, v_series.account_id, true) then
    raise exception 'KEEL_SCOPE_VIOLATION: recurring series not found' using errcode = 'P0006';
  end if;
  select * into v_candidate from public.recurring_candidate_versions
   where household_id = p_household_id
     and id = v_series.current_candidate_version_id
     and series_id = v_series.id;
  if not found then
    raise exception 'KEEL_IDEMPOTENCY_CONFLICT: candidate version is not current'
      using errcode = 'P0007';
  end if;

  select max(effective_date) into v_last_effective_date
    from public.recurring_status_events
   where household_id = p_household_id and series_id = v_series.id;
  if v_last_effective_date is not null and v_effective_date <= v_last_effective_date then
    raise exception 'KEEL_INVALID_COMMAND: effective date must be later than prior transitions'
      using errcode = 'P0009';
  end if;

  if (p_transition = 'confirmed' and v_series.status not in ('suggested','rejected','cancelled'))
     or (p_transition = 'paused' and v_series.status <> 'confirmed')
     or (p_transition = 'resumed' and v_series.status <> 'paused')
     or (p_transition = 'cancelled' and v_series.status not in ('confirmed','paused'))
     or (p_transition = 'rejected' and v_series.status <> 'suggested') then
    raise exception 'KEEL_INVALID_COMMAND: invalid recurring transition from % to %',
      v_series.status, p_transition using errcode = 'P0009';
  end if;

  v_before := jsonb_build_object('seriesId', v_series.id, 'status', v_series.status,
    'candidateVersionHash', v_candidate.candidate_hash);
  insert into public.recurring_status_events
    (household_id, series_id, candidate_version_id, transition, effective_date,
     actor, command_id)
  values
    (p_household_id, v_series.id, v_candidate.id, p_transition,
     v_effective_date, v_actor, p_command_id);

  select transition into v_latest_transition
    from public.recurring_status_events
   where household_id = p_household_id and series_id = v_series.id
   order by effective_date desc, created_at desc, command_id desc
   limit 1;
  v_status := case v_latest_transition
    when 'confirmed' then 'confirmed'::public.recurring_series_status
    when 'resumed' then 'confirmed'::public.recurring_series_status
    when 'paused' then 'paused'::public.recurring_series_status
    when 'cancelled' then 'cancelled'::public.recurring_series_status
    when 'rejected' then 'rejected'::public.recurring_series_status
    else 'suggested'::public.recurring_series_status
  end;
  update public.recurring_series
     set status = v_status, updated_at = now(),
         confirmed_by = case when p_transition = 'confirmed' then (v_actor->>'userId')::uuid else confirmed_by end,
         confirmed_at = case when p_transition = 'confirmed' then now() else confirmed_at end
   where household_id = p_household_id and id = v_series.id;

  if p_transition in ('confirmed','resumed') then
    begin
      v_projection_start := (v_candidate.candidate->>'lastSeen')::date + 1;
      v_projection_end := v_effective_date + v_horizon_days;
    exception when invalid_datetime_format or datetime_field_overflow then
      raise exception 'KEEL_INVALID_COMMAND: candidate lastSeen is invalid' using errcode = 'P0009';
    end;
    v_expected_amount := case v_candidate.candidate->>'amountKind'
      when 'fixed' then v_candidate.candidate->>'representativeAmountMinor'
      when 'variable' then v_candidate.candidate->'amountSummary'->>'lowerMedianMinor'
      else null
    end;
    if coalesce(v_expected_amount,'') !~ '^-?(0|[1-9][0-9]*)$'
       or v_expected_amount = '-0' then
      raise exception 'KEEL_INVALID_COMMAND: candidate amount derivation is invalid'
        using errcode = 'P0009';
    end if;
    select jsonb_agg(jsonb_build_object(
      'txn_id', evidence_row->>'txnId',
      'batch_id', evidence_row->>'batchId',
      'posting_id', evidence_row->>'postingId'
    ) order by evidence_ordinal) into v_occurrence_evidence
    from jsonb_array_elements(v_candidate.evidence) with ordinality
      as evidence(evidence_row, evidence_ordinal);
    select coalesce(jsonb_agg(jsonb_build_object(
      'transition', status_event.transition,
      'effectiveDate', to_char(status_event.effective_date,'YYYY-MM-DD'),
      'commandId', status_event.command_id
    ) order by status_event.effective_date, status_event.created_at, status_event.command_id), '[]'::jsonb)
      into v_timeline_snapshot
    from public.recurring_status_events status_event
    where status_event.household_id = p_household_id and status_event.series_id = v_series.id;

    for v_expected_date in
      select cadence.expected_date from public.keel_recurring_cadence_dates(
        v_candidate.candidate, v_projection_start, v_projection_end) cadence
    loop
      select transition into v_effective_transition
        from public.recurring_status_events
       where household_id = p_household_id and series_id = v_series.id
         and effective_date <= v_expected_date
       order by effective_date desc, created_at desc, command_id desc
       limit 1;
      if v_effective_transition is null
         or v_effective_transition not in ('confirmed','resumed') then continue; end if;
      v_occurrence_key := public.keel_payload_hash(jsonb_build_object(
        'seriesId', v_series.id,
        'candidateVersionHash', v_candidate.candidate_hash,
        'expectedDate', to_char(v_expected_date,'YYYY-MM-DD')
      ));
      v_occurrence_fingerprint := public.keel_payload_hash(jsonb_build_object(
        'candidateInputFingerprint', v_candidate.input_fingerprint,
        'expectedDate', to_char(v_expected_date,'YYYY-MM-DD'),
        'statusEvents', v_timeline_snapshot
      ));
      insert into public.recurring_occurrences
        (household_id, series_id, candidate_version_id, occurrence_key,
         expected_date, expected_amount_minor, currency, amount_kind, status,
         matched_txn_id, score_bps, evidence, input_fingerprint,
         detector_version, confidence_version, as_of)
      values
        (p_household_id, v_series.id, v_candidate.id, v_occurrence_key,
         v_expected_date, v_expected_amount::bigint, v_series.currency,
         (v_candidate.candidate->>'amountKind')::public.recurring_amount_kind,
         'expected', null, v_candidate.score_bps, v_occurrence_evidence,
         v_occurrence_fingerprint, v_candidate.detector_version,
         v_candidate.confidence_version,
         v_effective_date::timestamp at time zone 'utc')
      on conflict (household_id, series_id, candidate_version_id, expected_date) do nothing;
    end loop;
  end if;

  v_after := jsonb_build_object('seriesId', v_series.id, 'status', v_status,
    'candidateVersionHash', v_candidate.candidate_hash,
    'effectiveDate', to_char(v_effective_date,'YYYY-MM-DD'));
  v_result := jsonb_build_object(
    'commandId', p_command_id, 'economicEventKey', p_economic_event_key,
    'idempotentReplay', false, 'effects', v_after,
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  );
  insert into public.audit_log
    (household_id, actor, action, object_type, object_id, command_id, before, after)
  values
    (p_household_id, v_actor, 'recurring.' || p_transition::text,
     'recurring_series', v_series.id, p_command_id, v_before, v_after);
  insert into public.domain_events
    (event_type, household_id, command_id, economic_event_key, actor, payload)
  values
    ('recurring.' || p_transition::text, p_household_id, p_command_id,
     p_economic_event_key, v_actor, v_after);
  insert into public.command_executions
    (household_id, economic_event_key, command_id, command, payload_sha256, result)
  values
    (p_household_id, p_economic_event_key, p_command_id,
     'recurring.' || p_transition::text, v_hash, v_result);
  return v_result;
end;
$$;

create function public.keel_recurring_confirm(
  p_command_id uuid,
  p_economic_event_key text,
  p_actor jsonb,
  p_household_id uuid,
  p_payload jsonb
) returns jsonb
language sql security definer set search_path = public
as $$ select public.keel_recurring_transition_core($1,$2,$3,$4,$5,'confirmed') $$;
create function public.keel_recurring_pause(
  p_command_id uuid,
  p_economic_event_key text,
  p_actor jsonb,
  p_household_id uuid,
  p_payload jsonb
) returns jsonb
language sql security definer set search_path = public
as $$ select public.keel_recurring_transition_core($1,$2,$3,$4,$5,'paused') $$;
create function public.keel_recurring_resume(
  p_command_id uuid,
  p_economic_event_key text,
  p_actor jsonb,
  p_household_id uuid,
  p_payload jsonb
) returns jsonb
language sql security definer set search_path = public
as $$ select public.keel_recurring_transition_core($1,$2,$3,$4,$5,'resumed') $$;
create function public.keel_recurring_cancel(
  p_command_id uuid,
  p_economic_event_key text,
  p_actor jsonb,
  p_household_id uuid,
  p_payload jsonb
) returns jsonb
language sql security definer set search_path = public
as $$ select public.keel_recurring_transition_core($1,$2,$3,$4,$5,'cancelled') $$;
create function public.keel_recurring_reject(
  p_command_id uuid,
  p_economic_event_key text,
  p_actor jsonb,
  p_household_id uuid,
  p_payload jsonb
) returns jsonb
language sql security definer set search_path = public
as $$ select public.keel_recurring_transition_core($1,$2,$3,$4,$5,'rejected') $$;

create function public.keel_list_recurring(p_household_id uuid) returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_rows jsonb;
  v_uid uuid := coalesce(
    nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
    nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid;
begin
  if v_uid is null then
    raise exception 'KEEL_NOT_AUTHENTICATED' using errcode = 'P0004';
  end if;
  if not exists (select 1 from public.household_memberships
    where household_id = p_household_id and user_id = v_uid) then
    raise exception 'KEEL_SCOPE_VIOLATION' using errcode = 'P0006';
  end if;
  select coalesce(jsonb_agg(row.dto order by row.series_key), '[]'::jsonb) into v_rows
  from (
    select series_row.series_key,
      jsonb_build_object(
        'seriesKey', series_row.series_key,
        'counterpartyKey', series_row.counterparty_key,
        'accountId', series_row.account_id,
        'ledgerAccountId', series_row.ledger_account_id,
        'currency', series_row.currency::text,
        'sign', series_row.sign,
        'cadence', candidate_row.candidate->>'cadence',
        'cadenceAnchor', candidate_row.candidate->'cadenceAnchor',
        'amountKind', candidate_row.candidate->>'amountKind',
        'representativeAmountMinor', candidate_row.candidate->'representativeAmountMinor',
        'amountSummary', candidate_row.candidate->'amountSummary',
        'lastSeen', candidate_row.candidate->>'lastSeen',
        'occurrenceCount', candidate_row.candidate->'occurrenceCount',
        'coverage', candidate_row.candidate->'coverage',
        'residualDays', candidate_row.candidate->'residualDays',
        'scoreBps', candidate_row.score_bps,
        'evidence', candidate_row.evidence,
        'inputFingerprint', candidate_row.input_fingerprint,
        'detectorVersion', candidate_row.detector_version,
        'confidenceVersion', candidate_row.confidence_version,
        'normalizerVersion', candidate_row.normalizer_version,
        'asOf', to_char(candidate_row.as_of at time zone 'utc', 'YYYY-MM-DD'),
        'requiresApproval', true,
        'seriesId', series_row.id,
        'status', series_row.status,
        'candidateVersionId', candidate_row.id,
        'candidateVersionHash', candidate_row.candidate_hash,
        'statusEvents', coalesce((
          select jsonb_agg(jsonb_build_object(
            'transition', status_event.transition,
            'effectiveDate', to_char(status_event.effective_date, 'YYYY-MM-DD'),
            'commandId', status_event.command_id,
            'actorId', status_event.actor->>'userId',
            'createdAt', to_char(status_event.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
          ) order by status_event.effective_date, status_event.created_at, status_event.command_id)
          from public.recurring_status_events status_event
          where status_event.household_id = series_row.household_id
            and status_event.series_id = series_row.id
        ), '[]'::jsonb),
        'occurrences', coalesce((
          select jsonb_agg(jsonb_build_object(
            'occurrenceId', occurrence.id,
            'occurrenceKey', occurrence.occurrence_key,
            'expectedDate', to_char(occurrence.expected_date, 'YYYY-MM-DD'),
            'expectedAmountMinor', occurrence.expected_amount_minor::text,
            'currency', occurrence.currency::text,
            'amountKind', occurrence.amount_kind,
            'status', case coalesce((
              select lifecycle.transition::text
              from public.recurring_status_events lifecycle
              where lifecycle.household_id = occurrence.household_id
                and lifecycle.series_id = occurrence.series_id
                and lifecycle.effective_date <= occurrence.expected_date
              order by lifecycle.effective_date desc, lifecycle.created_at desc, lifecycle.command_id desc
              limit 1
            ), 'suggested')
              when 'paused' then 'paused'
              when 'cancelled' then 'cancelled'
              when 'rejected' then 'cancelled'
              when 'suggested' then 'cancelled'
              else occurrence.status::text
            end,
            'matchedTxnId', occurrence.matched_txn_id,
            'scoreBps', occurrence.score_bps,
            'evidence', occurrence.evidence,
            'inputFingerprint', occurrence.input_fingerprint,
            'detectorVersion', occurrence.detector_version,
            'confidenceVersion', occurrence.confidence_version,
            'asOf', to_char(occurrence.as_of at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
          ) order by occurrence.expected_date, occurrence.id)
          from public.recurring_occurrences occurrence
          where occurrence.household_id = series_row.household_id
            and occurrence.series_id = series_row.id
            and occurrence.candidate_version_id = series_row.current_candidate_version_id
        ), '[]'::jsonb)
      ) as dto
    from public.recurring_series series_row
    join public.recurring_candidate_versions candidate_row
      on candidate_row.household_id = series_row.household_id
     and candidate_row.id = series_row.current_candidate_version_id
    where series_row.household_id = p_household_id
      and public.keel_recurring_account_access(p_household_id, series_row.account_id, false)
  ) row;
  return jsonb_build_object(
    'scope', jsonb_build_object('householdId', p_household_id),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'formulaVersion', 'recurring-grid-v1',
    'rows', v_rows
  );
end;
$$;

-- Idempotent recurring-detection scheduling. The claim and pgmq send share
-- one transaction; retries of the same time bucket cannot enqueue twice.
select pgmq.create('recurring_detection');
-- Queue tables are created after the Stage 1A blanket pgmq grant.
grant select, insert, update, delete on all tables in schema pgmq to keel_api, keel_worker;
create table public.recurring_detection_claims (
  household_id uuid not null references public.households(id),
  bucket timestamptz not null,
  message_id bigint,
  created_at timestamptz not null default now(),
  primary key (household_id, bucket)
);
alter table public.recurring_detection_claims enable row level security;
revoke all on public.recurring_detection_claims from public, anon, authenticated;

create function public.keel_cron_enqueue_recurring_detection(
  p_min_interval_seconds integer default 86400
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bucket timestamptz;
  v_count integer;
begin
  if p_min_interval_seconds is null or p_min_interval_seconds <= 0 then return 0; end if;
  v_bucket := to_timestamp(
    floor(extract(epoch from statement_timestamp()) / p_min_interval_seconds)
      * p_min_interval_seconds
  );
  with claimed as (
    insert into public.recurring_detection_claims(household_id, bucket)
    select household.id, v_bucket from public.households household
    where exists (select 1 from public.accounts account_row
      where account_row.household_id = household.id and account_row.archived_at is null)
    on conflict do nothing
    returning household_id
  ), sent as materialized (
    select claimed.household_id,
      public.keel_enqueue('recurring_detection', jsonb_build_object(
        'jobType', 'recurring_detection',
        'economicEventKey', 'recurring:detect:' || claimed.household_id::text || ':' || extract(epoch from v_bucket)::bigint::text,
        'refs', jsonb_build_object(
          'householdId', claimed.household_id::text,
          'asOf', to_char(v_bucket at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
        )
      )) as message_id
    from claimed
  ) select count(*)::integer into v_count from sent;
  return v_count;
end;
$$;

alter table public.usage_events drop constraint usage_events_provider_kind_check;
alter table public.usage_events add constraint usage_events_provider_kind_check check (
  kind is null or kind in (
    'link_token_create','sandbox_public_token_create','item_public_token_exchange',
    'accounts_get','item_remove','webhook_key_get','transactions_sync',
    'cron_enqueue_syncs','quarantine_capped','budget_refused','recurring_detection'
  )
);

create function public.keel_meter_recurring_detection(
  p_household_id uuid,
  p_ok boolean,
  p_error_code text,
  p_quantity integer
) returns void
language sql
security definer
set search_path = public
as $$
  insert into public.usage_events
    (household_id, event_type, provider, kind, ok, error_code, quantity)
  values
    (p_household_id, 'domain_meter', null, 'recurring_detection', p_ok,
     case when p_error_code is null or p_error_code = 'detection_failed'
       then p_error_code else 'detection_failed' end,
     p_quantity);
$$;

-- Grants and RLS. Clients can read only account-authorized rows and can never
-- mutate tables directly; all mutations go through audited commands.
alter table public.recurring_detector_runs enable row level security;
alter table public.recurring_series enable row level security;
alter table public.recurring_candidate_versions enable row level security;
alter table public.recurring_occurrences enable row level security;
alter table public.recurring_status_events enable row level security;

revoke all on public.recurring_detector_runs, public.recurring_series,
  public.recurring_candidate_versions, public.recurring_occurrences,
  public.recurring_status_events from public, anon, authenticated;
grant select on public.recurring_series, public.recurring_candidate_versions,
  public.recurring_occurrences, public.recurring_status_events to authenticated;
grant select on public.recurring_detector_runs, public.recurring_series,
  public.recurring_candidate_versions, public.recurring_occurrences,
  public.recurring_status_events, public.recurring_detection_claims to service_role;

create policy recurring_series_authorized_read on public.recurring_series
  for select to authenticated
  using (public.keel_recurring_account_access(household_id, account_id, false));
create policy recurring_candidates_authorized_read on public.recurring_candidate_versions
  for select to authenticated using (exists (
    select 1 from public.recurring_series series_row
    where series_row.household_id = recurring_candidate_versions.household_id
      and series_row.id = recurring_candidate_versions.series_id
      and public.keel_recurring_account_access(series_row.household_id, series_row.account_id, false)
  ));
create policy recurring_occurrences_authorized_read on public.recurring_occurrences
  for select to authenticated using (exists (
    select 1 from public.recurring_series series_row
    where series_row.household_id = recurring_occurrences.household_id
      and series_row.id = recurring_occurrences.series_id
      and public.keel_recurring_account_access(series_row.household_id, series_row.account_id, false)
  ));
create policy recurring_status_authorized_read on public.recurring_status_events
  for select to authenticated using (exists (
    select 1 from public.recurring_series series_row
    where series_row.household_id = recurring_status_events.household_id
      and series_row.id = recurring_status_events.series_id
      and public.keel_recurring_account_access(series_row.household_id, series_row.account_id, false)
  ));

grant select, insert on public.recurring_detector_runs, public.recurring_candidate_versions to keel_worker;
grant select, insert on public.recurring_series to keel_worker;
grant update (current_candidate_version_id, updated_at) on public.recurring_series to keel_worker;
grant select on public.recurring_series, public.recurring_candidate_versions to keel_api;
grant update (status, updated_at, confirmed_by, confirmed_at) on public.recurring_series to keel_api;
grant select, insert on public.recurring_occurrences, public.recurring_status_events to keel_api;
grant select, insert, update on public.recurring_detection_claims to keel_worker;
grant insert on public.usage_events to keel_worker;

create policy recurring_runs_worker_all on public.recurring_detector_runs
  for all to keel_worker using (true) with check (true);
create policy recurring_series_definer_all on public.recurring_series
  for all to keel_api, keel_worker using (true) with check (true);
create policy recurring_candidates_definer_all on public.recurring_candidate_versions
  for all to keel_api, keel_worker using (true) with check (true);
create policy recurring_occurrences_api_all on public.recurring_occurrences
  for all to keel_api using (true) with check (true);
create policy recurring_status_api_all on public.recurring_status_events
  for all to keel_api using (true) with check (true);
create policy recurring_claims_worker_all on public.recurring_detection_claims
  for all to keel_worker using (true) with check (true);

grant create on schema public to keel_worker, keel_api;
alter function public.keel_recurring_read_txns(uuid) owner to keel_worker;
alter function public.keel_recurring_upsert_candidates(uuid,text,timestamptz,text,text,text,jsonb) owner to keel_worker;
alter function public.keel_cron_enqueue_recurring_detection(integer) owner to keel_worker;
alter function public.keel_meter_recurring_detection(uuid,boolean,text,integer) owner to keel_worker;

alter function public.keel_recurring_account_access(uuid,uuid,boolean) owner to keel_api;
alter function public.keel_recurring_cadence_dates(jsonb,date,date) owner to keel_api;
alter function public.keel_recurring_transition_core(uuid,text,jsonb,uuid,jsonb,public.recurring_transition) owner to keel_api;
alter function public.keel_recurring_confirm(uuid,text,jsonb,uuid,jsonb) owner to keel_api;
alter function public.keel_recurring_pause(uuid,text,jsonb,uuid,jsonb) owner to keel_api;
alter function public.keel_recurring_resume(uuid,text,jsonb,uuid,jsonb) owner to keel_api;
alter function public.keel_recurring_cancel(uuid,text,jsonb,uuid,jsonb) owner to keel_api;
alter function public.keel_recurring_reject(uuid,text,jsonb,uuid,jsonb) owner to keel_api;
alter function public.keel_list_recurring(uuid) owner to keel_api;
revoke create on schema public from keel_worker, keel_api;

revoke all on function public.keel_recurring_read_txns(uuid),
  public.keel_recurring_upsert_candidates(uuid,text,timestamptz,text,text,text,jsonb),
  public.keel_cron_enqueue_recurring_detection(integer),
  public.keel_meter_recurring_detection(uuid,boolean,text,integer)
from public, anon, authenticated;
grant execute on function public.keel_recurring_read_txns(uuid),
  public.keel_recurring_upsert_candidates(uuid,text,timestamptz,text,text,text,jsonb),
  public.keel_cron_enqueue_recurring_detection(integer),
  public.keel_meter_recurring_detection(uuid,boolean,text,integer)
to service_role;

revoke all on function public.keel_recurring_account_access(uuid,uuid,boolean),
  public.keel_recurring_cadence_dates(jsonb,date,date),
  public.keel_recurring_transition_core(uuid,text,jsonb,uuid,jsonb,public.recurring_transition)
from public, anon, authenticated;
grant execute on function public.keel_recurring_account_access(uuid,uuid,boolean) to authenticated, keel_api;
grant execute on function public.keel_recurring_cadence_dates(jsonb,date,date) to keel_api;

revoke all on function public.keel_recurring_confirm(uuid,text,jsonb,uuid,jsonb),
  public.keel_recurring_pause(uuid,text,jsonb,uuid,jsonb),
  public.keel_recurring_resume(uuid,text,jsonb,uuid,jsonb),
  public.keel_recurring_cancel(uuid,text,jsonb,uuid,jsonb),
  public.keel_recurring_reject(uuid,text,jsonb,uuid,jsonb),
  public.keel_list_recurring(uuid)
from public, anon;
grant execute on function public.keel_recurring_confirm(uuid,text,jsonb,uuid,jsonb),
  public.keel_recurring_pause(uuid,text,jsonb,uuid,jsonb),
  public.keel_recurring_resume(uuid,text,jsonb,uuid,jsonb),
  public.keel_recurring_cancel(uuid,text,jsonb,uuid,jsonb),
  public.keel_recurring_reject(uuid,text,jsonb,uuid,jsonb),
  public.keel_list_recurring(uuid)
to authenticated;

-- Ownership block: runtime definers are NOLOGIN/non-BYPASSRLS and no
-- recurring SECURITY DEFINER function is accidentally left postgres-owned.
do $$
begin
  if exists (select 1 from pg_roles where rolname in ('keel_api','keel_worker')
    and (rolcanlogin or rolbypassrls or rolsuper)) then
    raise exception 'KEEL_OWNERSHIP: recurring definer role is privileged';
  end if;
  if exists (
    select 1 from pg_proc proc
    join pg_namespace namespace on namespace.oid = proc.pronamespace
    join pg_roles owner_role on owner_role.oid = proc.proowner
    where namespace.nspname = 'public' and proc.proname like 'keel%recurring%'
      and proc.prosecdef and owner_role.rolname not in ('keel_api','keel_worker')
  ) then
    raise exception 'KEEL_OWNERSHIP: recurring definer has unexpected owner';
  end if;
end
$$;

-- Worker-owned wrappers call API-owned shared idempotency/audit helpers.
grant execute on function public.keel_payload_hash(jsonb) to keel_worker;
grant execute on function public.keel_enqueue(text,jsonb) to keel_worker;

-- Extend the already-shipped export snapshot without duplicating its large,
-- explicit v2 DTO. The original is retained as a private keel_export helper;
-- this wrapper adds all durable recurring history under the same statement.
grant select on public.recurring_detector_runs, public.recurring_series,
  public.recurring_candidate_versions, public.recurring_occurrences,
  public.recurring_status_events to keel_export;
revoke all on public.recurring_detection_claims from keel_export;
create policy recurring_runs_export on public.recurring_detector_runs
  for select to keel_export using (true);
create policy recurring_series_export on public.recurring_series
  for select to keel_export using (true);
create policy recurring_candidates_export on public.recurring_candidate_versions
  for select to keel_export using (true);
create policy recurring_occurrences_export on public.recurring_occurrences
  for select to keel_export using (true);
create policy recurring_status_export on public.recurring_status_events
  for select to keel_export using (true);

alter function public.keel_export_household(uuid,timestamptz)
  rename to keel_export_household_pre_recurring;
revoke all on function public.keel_export_household_pre_recurring(uuid,timestamptz)
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
  v_recurring jsonb;
begin
  v_base := public.keel_export_household_pre_recurring(p_household_id, p_as_of);
  select jsonb_build_object(
    'recurring_detector_runs', coalesce((select jsonb_agg(to_jsonb(run_row) order by run_row.id)
      from public.recurring_detector_runs run_row where run_row.household_id=p_household_id), '[]'::jsonb),
    'recurring_series', coalesce((select jsonb_agg(to_jsonb(series_row) order by series_row.id)
      from public.recurring_series series_row where series_row.household_id=p_household_id), '[]'::jsonb),
    'recurring_candidate_versions', coalesce((select jsonb_agg(to_jsonb(candidate_row) order by candidate_row.id)
      from public.recurring_candidate_versions candidate_row where candidate_row.household_id=p_household_id), '[]'::jsonb),
    'recurring_occurrences', coalesce((select jsonb_agg(
      to_jsonb(occurrence_row) || jsonb_build_object('expected_amount_minor', occurrence_row.expected_amount_minor::text)
      order by occurrence_row.household_id, occurrence_row.id)
      from public.recurring_occurrences occurrence_row where occurrence_row.household_id=p_household_id), '[]'::jsonb),
    'recurring_status_events', coalesce((select jsonb_agg(to_jsonb(status_row) order by status_row.household_id, status_row.id)
      from public.recurring_status_events status_row where status_row.household_id=p_household_id), '[]'::jsonb)
  ) into v_recurring;
  return jsonb_set(v_base, '{tables}', (v_base->'tables') || v_recurring);
end;
$$;
revoke all on function public.keel_export_household(uuid,timestamptz)
  from public, anon, authenticated, service_role;
grant create on schema public to keel_export;
alter function public.keel_export_household(uuid,timestamptz) owner to keel_export;
revoke create on schema public from keel_export;
grant execute on function public.keel_export_household(uuid,timestamptz) to service_role;

do $$
declare
  v_job_id bigint;
begin
  create extension if not exists pg_cron;
  for v_job_id in select jobid from cron.job where jobname = 'keel-recurring-detection'
  loop perform cron.unschedule(v_job_id); end loop;
  perform cron.schedule(
    'keel-recurring-detection', '0 3 * * *',
    $command$ select public.keel_cron_enqueue_recurring_detection(); $command$
  );
exception when others then
  raise notice 'pg_cron unavailable; recurring enqueue callable via /scheduled/tick';
end
$$;
