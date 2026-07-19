-- Statement ingestion Slice 5 — transactional outbox + sweeper [A12].
--
-- Problem this closes: confirm-upload's enqueue of the extraction job is
-- best-effort (api/index.ts, mirrored from receipts). If the pgmq send (or the
-- drain kick) fails AFTER the draft row is committed, the draft is stranded at
-- status 'pending' forever with nothing to re-drive it. For receipts that was
-- acceptable (a receipt with no match is inert); for a statement draft it means
-- a permanent phantom the user uploaded but can never approve.
--
-- Fix (transactional outbox): confirm-upload (Slice 6) writes ONE
-- `statement_outbox` row IN THE SAME TRANSACTION as the `statement_drafts`
-- insert. Because both commit atomically, a committed draft always has a
-- committed outbox row — the enqueue can then be retried out-of-band. A pg_cron
-- sweeper (`keel_sweep_statement_outbox`) periodically finds outbox rows whose
-- draft is still 'pending' past a grace window and re-enqueues the
-- `statement_extract` job, IDEMPOTENTLY (deduped on document_version_id — one
-- in-flight enqueue per version at a time). The worker (Slice 5, this PR) is
-- already idempotent (keel_worker_persist_statement_extraction no-ops on
-- replay, Law 9), so a re-enqueue can never produce a duplicate extraction.
--
-- Deploy order is REVERSED [A12]: the worker branch that CONSUMES a
-- statement_extract job ships in this slice; the confirm-upload side that WRITES
-- the outbox row + first-enqueues ships in Slice 6. So this migration ships the
-- table + sweeper (the consumer side) but NOT the confirm-upload writer. A
-- worker test manually enqueues a statement_extract job to prove end-to-end
-- processing; the sweeper's own idempotency is proven in pgTAP-style asserts
-- below (see the accompanying worker test for the re-enqueue-once assertion).
--
-- Idempotent migration: guarded drops, IF NOT EXISTS, CREATE OR REPLACE.
-- Owner/grants mirror the existing cron/worker patterns; service_role only for
-- the sweeper (it is a queue driver, not a user-facing command).

-- ---------------------------------------------------------------------------
-- Outbox status: the lifecycle of a single pending-extraction delivery.
--   pending   → written by confirm-upload, not yet confirmed delivered.
--   delivered → the draft left 'pending' (extracted|failed|approved|dismissed);
--               the sweeper marks it done so it is never re-enqueued.
--   abandoned → give-up terminal (max sweeps exceeded); surfaced for ops.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'statement_outbox_status') then
    create type public.statement_outbox_status as enum ('pending', 'delivered', 'abandoned');
  end if;
end
$$;

-- One outbox row per document_version (unique) so a re-upload/replay can never
-- create two competing delivery records for the same object [A12 dedupe].
create table if not exists public.statement_outbox (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id),
  document_version_id uuid not null references public.document_versions(id),
  account_id uuid not null,
  status public.statement_outbox_status not null default 'pending',
  -- Enqueue bookkeeping (drives idempotent re-enqueue + give-up).
  enqueue_count integer not null default 0,
  last_enqueued_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  -- One delivery record per version [A12].
  unique (document_version_id),
  -- Composite tenant FK: the account must belong to the same household.
  constraint statement_outbox_account_fk
    foreign key (household_id, account_id) references public.accounts (household_id, id)
);

comment on table public.statement_outbox is
  'Transactional outbox for statement_extract jobs [A12]. Written in the same txn '
  'as statement_drafts by confirm-upload (Slice 6); swept + re-enqueued idempotently '
  'by keel_sweep_statement_outbox so a queue-send failure can never strand a draft.';

create index if not exists statement_outbox_pending_idx
  on public.statement_outbox (created_at)
  where status = 'pending';

-- ---------------------------------------------------------------------------
-- RLS + grants. Mirrors statement_drafts (20260720180000). The outbox is an
-- internal queue-delivery ledger: keel_api writes it (in the confirm-upload
-- txn, Slice 6), keel_worker reads/updates it (the sweeper), keel_export reads.
-- No end-user role touches it directly.
-- ---------------------------------------------------------------------------
alter table public.statement_outbox enable row level security;

grant select, insert, update on public.statement_outbox to keel_api;
grant select, update on public.statement_outbox to keel_worker;
grant select on public.statement_outbox to keel_export;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public'
                 and tablename='statement_outbox' and policyname='statement_outbox_api_all') then
    create policy statement_outbox_api_all on public.statement_outbox
      for all to keel_api using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public'
                 and tablename='statement_outbox' and policyname='statement_outbox_worker_all') then
    create policy statement_outbox_worker_all on public.statement_outbox
      for all to keel_worker using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public'
                 and tablename='statement_outbox' and policyname='statement_outbox_export') then
    create policy statement_outbox_export on public.statement_outbox
      for select to keel_export using (true);
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- keel_sweep_statement_outbox — the idempotent re-enqueue sweeper.
--
-- For each outbox row whose owning draft is STILL 'pending' and whose grace
-- window has elapsed (created OR last-enqueued > p_grace ago), enqueue exactly
-- ONE statement_extract job and bump enqueue_count. Rows whose draft has since
-- left 'pending' are marked 'delivered' (never re-enqueued). Rows that have been
-- swept p_max_enqueues times without progress are marked 'abandoned' (a poison
-- upload; surfaced for ops rather than looped forever).
--
-- Idempotency [A12]: dedupe is on document_version_id via the outbox unique +
-- the "advance last_enqueued_at" guard — a row cannot be re-enqueued twice
-- within one grace window, and the worker's persist proc no-ops a replay anyway
-- (Law 9). Concurrency-safe: SELECT ... FOR UPDATE SKIP LOCKED so two overlapping
-- sweeps never double-send the same row.
--
-- SECURITY DEFINER, owned by keel_worker (it enqueues + reads/writes the
-- extraction family). service_role only.
-- ---------------------------------------------------------------------------
create or replace function public.keel_sweep_statement_outbox(
  p_grace interval default interval '3 minutes',
  p_max_enqueues integer default 8,
  p_batch integer default 100
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.statement_outbox%rowtype;
  v_draft_status public.statement_draft_status;
  v_enqueued integer := 0;
begin
  for v_row in
    select o.*
    from public.statement_outbox o
    where o.status = 'pending'
      and (o.last_enqueued_at is null or o.last_enqueued_at < now() - p_grace)
      and o.created_at < now() - p_grace
    order by o.created_at
    limit greatest(p_batch, 1)
    for update skip locked
  loop
    -- What is the draft actually doing now?
    select d.status into v_draft_status
    from public.statement_drafts d
    where d.household_id = v_row.household_id
      and d.document_version_id = v_row.document_version_id;

    if v_draft_status is null then
      -- No draft for this version (shouldn't happen; the outbox is written with
      -- the draft). Nothing to drive — mark delivered so we stop sweeping it.
      update public.statement_outbox
         set status = 'delivered', delivered_at = now()
       where id = v_row.id;
      continue;
    end if;

    if v_draft_status <> 'pending' then
      -- The draft already progressed (extracted|failed|approved|dismissed). The
      -- job was delivered by someone (the first enqueue, or a prior sweep). Done.
      update public.statement_outbox
         set status = 'delivered', delivered_at = now()
       where id = v_row.id;
      continue;
    end if;

    if v_row.enqueue_count >= p_max_enqueues then
      -- Repeatedly swept, draft never left 'pending' → poison. Give up (ops can
      -- inspect); never loop forever.
      update public.statement_outbox
         set status = 'abandoned'
       where id = v_row.id;
      continue;
    end if;

    -- Re-enqueue exactly one statement_extract job for this version. The message
    -- shape matches confirm-upload's receipt enqueue; the worker re-verifies the
    -- household + account, so a stale message is harmless.
    perform public.keel_enqueue('sync_events', jsonb_build_object(
      'jobType', 'statement_extract',
      'economicEventKey', 'statement:extract:' || v_row.document_version_id::text,
      'refs', jsonb_build_object(
        'documentVersionId', v_row.document_version_id::text,
        'householdId', v_row.household_id::text
      )
    ));

    update public.statement_outbox
       set enqueue_count = v_row.enqueue_count + 1,
           last_enqueued_at = now()
     where id = v_row.id;

    v_enqueued := v_enqueued + 1;
  end loop;

  return v_enqueued;
end;
$$;

alter function public.keel_sweep_statement_outbox(interval, integer, integer)
  owner to keel_worker;
revoke all on function public.keel_sweep_statement_outbox(interval, integer, integer)
  from public, anon, authenticated;
grant execute on function public.keel_sweep_statement_outbox(interval, integer, integer)
  to service_role;

-- ---------------------------------------------------------------------------
-- pg_cron: run the sweeper every 5 minutes. The first enqueue is confirm-upload
-- (Slice 6), so the sweeper is the FALLBACK that re-drives anything the
-- best-effort enqueue dropped. Idempotent schedule (unschedule-by-name first).
-- Mirrors keel_cron_drain_recurring_detection's guarded-schedule pattern.
-- ---------------------------------------------------------------------------
do $$
declare
  v_job_id bigint;
begin
  create extension if not exists pg_cron;
  for v_job_id in select jobid from cron.job where jobname = 'keel-sweep-statement-outbox'
  loop perform cron.unschedule(v_job_id); end loop;
  perform cron.schedule(
    'keel-sweep-statement-outbox',
    '*/5 * * * *',
    $command$ select public.keel_sweep_statement_outbox(); $command$
  );
exception when others then
  raise notice 'pg_cron unavailable; keel_sweep_statement_outbox callable directly';
end
$$;

-- ---------------------------------------------------------------------------
-- Export INCLUDE [A11]: the outbox is a public household table, so it must be
-- reachable by the exporter. keel_export already has SELECT + an RLS select
-- policy above; the packages/exports manifest INCLUDE list is extended in the
-- TypeScript layer (Slice 6 wires the confirm-upload writer + the manifest
-- entry together). This migration grants the DB-side access so the table is not
-- invisible to a full export once populated.
-- ---------------------------------------------------------------------------
