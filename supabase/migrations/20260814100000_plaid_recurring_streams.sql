-- Plaid-primary recurring detection, Phase 1: STORAGE + INGEST ONLY.
--
-- User ruling (2026-08-13): "The recurring thing should just be detected via
-- [Plaid's] system, and then ... secondary will use our recurring." Plaid's
-- /transactions/recurring/get is a BILLED add-on (~$0.15-0.50 per item per
-- month at our tier), so it is called only for connections explicitly listed
-- in `plaid_recurring_allowlist` — the same connection-id flag-table idiom
-- proven by `regular_core_sweep_allowlist` (20260725000000), for the same
-- reason: adding an item is a one-row INSERT, no code change or redeploy.
--
-- This migration deliberately does NOT touch `recurring_series`,
-- `recurring_candidates`, or any read model. Phase 1 only lands the streams
-- where they can be inspected against real data; the stream <-> series_key
-- identity mapping and the primary/secondary arbitration (KEEL's own grid
-- stays primary on manual/CSV accounts, which Plaid cannot see at all) are
-- Phase 2 and must not duplicate already-confirmed series.
--
-- Law 5: every text field ingested here (description, merchant_name, the whole
-- `raw` envelope) is DATA-TIER. Nothing in this migration branches on it, and
-- nothing downstream may let it trigger a tool, write, or fetch.
-- Law 4: money is BIGINT minor units. Plaid returns decimal dollars; the
-- worker parses them from PRESERVED AMOUNT LEXEMES (never through a JS float —
-- see plaid-client.ts `preserveAmountLexemes`) and passes minor units here as
-- strings, so no float ever touches the value.

-- ===========================================================================
-- 1. Allowlist. Unlike the core-sweep allowlist this is NOT append-only: a
-- billed add-on has to be switchable off. Removal is a SOFT delete
-- (`removed_at`, standing directive 2026-07-17) so the history of what we were
-- ever billed for survives; hard DELETE stays forbidden.
-- ===========================================================================
create table public.plaid_recurring_allowlist (
  household_id  uuid not null references public.households (id),
  connection_id uuid not null references public.connections (id),
  note          text check (note is null or length(note) between 1 and 500),
  added_at      timestamptz not null default now(),
  removed_at    timestamptz,
  primary key (household_id, connection_id),
  constraint fk_plaid_recurring_allowlist_tenant foreign key (household_id, connection_id)
    references public.connections (household_id, id)
);

create or replace function public.keel_forbid_plaid_recurring_allowlist_delete()
returns trigger
language plpgsql
as $$
begin
  raise exception 'plaid_recurring_allowlist rows are soft-removed (set removed_at), never deleted'
    using errcode = 'raise_exception';
end;
$$;

create trigger plaid_recurring_allowlist_no_delete
  before delete on public.plaid_recurring_allowlist
  for each row execute function public.keel_forbid_plaid_recurring_allowlist_delete();

alter table public.plaid_recurring_allowlist enable row level security;
revoke all on public.plaid_recurring_allowlist from anon, authenticated;
grant select on public.plaid_recurring_allowlist to authenticated, service_role;
create policy plaid_recurring_allowlist_member_read on public.plaid_recurring_allowlist
  for select to authenticated
  using (exists (
    select 1 from public.household_memberships m
     where m.household_id = plaid_recurring_allowlist.household_id and m.user_id = auth.uid()
  ));

-- ===========================================================================
-- 2. Stream mirror. One row per (household, Plaid stream_id). Plaid returns
-- the FULL current stream set on every call, so a stream missing from a fetch
-- is deactivated (`absent_since`) rather than removed — a tombstoned stream is
-- still evidence about a series that used to exist.
-- ===========================================================================
create table public.plaid_recurring_streams (
  id                    uuid primary key default gen_random_uuid(),
  household_id          uuid not null references public.households (id),
  connection_id         uuid not null references public.connections (id),
  -- Resolved KEEL account when the Plaid account_id maps to one of ours;
  -- null when the stream belongs to an account we do not track (Plaid can
  -- report streams on accounts the household never linked into KEEL).
  account_id            uuid references public.accounts (id),
  external_account_ref  text not null check (length(external_account_ref) between 1 and 200),
  stream_id             text not null check (length(stream_id) between 1 and 200),
  direction             text not null check (direction in ('inflow', 'outflow')),
  -- Plaid's own vocabulary, stored verbatim (MATURE / EARLY_DETECTION /
  -- TOMBSTONED / UNKNOWN, and WEEKLY / BIWEEKLY / SEMI_MONTHLY / MONTHLY /
  -- ANNUALLY / UNKNOWN). NOT mapped onto a KEEL enum here: Phase 2 owns the
  -- translation, and pinning an enum now would silently drop a value Plaid
  -- adds later.
  status                text not null check (length(status) between 1 and 60),
  frequency             text not null check (length(frequency) between 1 and 60),
  is_active             boolean not null,
  description           text,
  merchant_name         text,
  category_primary      text,
  first_date            date not null,
  last_date             date not null,
  predicted_next_date   date,
  -- KEEL sign convention, not Plaid's: the worker runs both through
  -- plaidAmountToKeelMinor, so money OUT is negative here exactly as it is on
  -- postings and on recurring_series.sign. Phase 2's arbitration compares
  -- these against series amounts directly, with no sign translation.
  average_amount_minor  bigint not null,
  last_amount_minor     bigint not null,
  currency              text not null check (length(currency) = 3),
  raw                   jsonb not null,
  first_seen_at         timestamptz not null default now(),
  last_seen_at          timestamptz not null default now(),
  absent_since          timestamptz,
  unique (household_id, stream_id),
  constraint fk_plaid_recurring_streams_tenant foreign key (household_id, connection_id)
    references public.connections (household_id, id)
);

create index plaid_recurring_streams_conn_idx
  on public.plaid_recurring_streams (household_id, connection_id, is_active);
create index plaid_recurring_streams_account_idx
  on public.plaid_recurring_streams (household_id, account_id)
  where account_id is not null;

alter table public.plaid_recurring_streams enable row level security;
revoke all on public.plaid_recurring_streams from anon, authenticated;
grant select on public.plaid_recurring_streams to authenticated, service_role;
create policy plaid_recurring_streams_member_read on public.plaid_recurring_streams
  for select to authenticated
  using (exists (
    select 1 from public.household_memberships m
     where m.household_id = plaid_recurring_streams.household_id and m.user_id = auth.uid()
  ));

-- ===========================================================================
-- 3. Ingest. Worker-only. Takes the whole fetched stream set for ONE
-- connection and reconciles the mirror to it in a single statement pair:
-- upsert everything present, deactivate everything absent. Idempotent by
-- construction (same payload twice = same end state, only last_seen_at moves),
-- so a replayed worker pass cannot duplicate anything (Law 9).
-- ===========================================================================
create or replace function public.keel_ingest_plaid_recurring_streams(
  p_household_id  uuid,
  p_connection_id uuid,
  p_streams       jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_upserted    integer := 0;
  v_deactivated integer := 0;
  v_seen        text[];
begin
  if p_household_id is null or p_connection_id is null then
    raise exception 'household and connection are required' using errcode = 'raise_exception';
  end if;
  if jsonb_typeof(p_streams) <> 'array' then
    raise exception 'streams payload must be a json array' using errcode = 'raise_exception';
  end if;
  if not exists (
    select 1 from public.connections c
     where c.id = p_connection_id and c.household_id = p_household_id
  ) then
    raise exception 'connection not found in household' using errcode = 'raise_exception';
  end if;

  with incoming as (
    select
      (s ->> 'streamId')                       as stream_id,
      (s ->> 'accountId')::uuid                as account_id,
      (s ->> 'externalAccountRef')             as external_account_ref,
      (s ->> 'direction')                      as direction,
      (s ->> 'status')                         as status,
      (s ->> 'frequency')                      as frequency,
      (s ->> 'isActive')::boolean              as is_active,
      (s ->> 'description')                    as description,
      (s ->> 'merchantName')                   as merchant_name,
      (s ->> 'categoryPrimary')                as category_primary,
      (s ->> 'firstDate')::date                as first_date,
      (s ->> 'lastDate')::date                 as last_date,
      (s ->> 'predictedNextDate')::date        as predicted_next_date,
      (s ->> 'averageAmountMinor')::bigint     as average_amount_minor,
      (s ->> 'lastAmountMinor')::bigint        as last_amount_minor,
      coalesce(s ->> 'currency', 'USD')        as currency,
      (s -> 'raw')                             as raw
      from jsonb_array_elements(p_streams) as s
  ), upserted as (
    insert into public.plaid_recurring_streams (
      household_id, connection_id, account_id, external_account_ref, stream_id,
      direction, status, frequency, is_active, description, merchant_name,
      category_primary, first_date, last_date, predicted_next_date,
      average_amount_minor, last_amount_minor, currency, raw, last_seen_at, absent_since
    )
    select
      p_household_id, p_connection_id, i.account_id, i.external_account_ref, i.stream_id,
      i.direction, i.status, i.frequency, i.is_active, i.description, i.merchant_name,
      i.category_primary, i.first_date, i.last_date, i.predicted_next_date,
      i.average_amount_minor, i.last_amount_minor, i.currency, i.raw, now(), null
      from incoming i
    on conflict (household_id, stream_id) do update
      set connection_id        = excluded.connection_id,
          account_id           = excluded.account_id,
          external_account_ref = excluded.external_account_ref,
          direction            = excluded.direction,
          status               = excluded.status,
          frequency            = excluded.frequency,
          is_active            = excluded.is_active,
          description          = excluded.description,
          merchant_name        = excluded.merchant_name,
          category_primary     = excluded.category_primary,
          first_date           = excluded.first_date,
          last_date            = excluded.last_date,
          predicted_next_date  = excluded.predicted_next_date,
          average_amount_minor = excluded.average_amount_minor,
          last_amount_minor    = excluded.last_amount_minor,
          currency             = excluded.currency,
          raw                  = excluded.raw,
          last_seen_at         = now(),
          absent_since         = null
    returning stream_id
  )
  select count(*)::integer, coalesce(array_agg(stream_id), array[]::text[])
    into v_upserted, v_seen
    from upserted;

  update public.plaid_recurring_streams s
     set is_active    = false,
         absent_since = coalesce(s.absent_since, now())
   where s.household_id = p_household_id
     and s.connection_id = p_connection_id
     and not (s.stream_id = any (v_seen))
     and (s.is_active or s.absent_since is null);
  get diagnostics v_deactivated = row_count;

  return jsonb_build_object(
    'upserted', v_upserted,
    'deactivated', v_deactivated,
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  );
end;
$$;

grant create on schema public to keel_worker;
alter function public.keel_ingest_plaid_recurring_streams(uuid, uuid, jsonb) owner to keel_worker;
revoke create on schema public from keel_worker;
revoke all on function public.keel_ingest_plaid_recurring_streams(uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.keel_ingest_plaid_recurring_streams(uuid, uuid, jsonb)
  to keel_worker, service_role;
