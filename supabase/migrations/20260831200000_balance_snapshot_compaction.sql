-- Balance snapshot compaction, phase 2: remove the 186,810 rows that phase 1
-- stopped creating. docs/BALANCE-SNAPSHOT-COMPACTION.md §3 phase 2 and §4.
--
-- Phase 1 (20260831190000) stopped the amplification at the write side.
-- This removes the backlog: 186,943 rows over one household and 16 accounts,
-- 50 MB and 26% of the database, of which the survivor predicate keeps 133.
-- keel_latest_balances and keel_investments_overview both do
-- `distinct on (account_id) ... order by as_of desc` with no index-skip scan
-- available, so their cost is LINEAR in this count: 186,943 rows and 87,229
-- buffers scanned to return 16 rows, 4.8 s. Compaction IS the latency fix, not
-- a tidy-up alongside it.
--
-- ==========================================================================
-- THIS FILE REMOVES PRODUCTION ROWS. Read the sequencing before changing it.
-- ==========================================================================
--
-- CLAUDE.md's standing directive is soft delete over hard delete, because a
-- raw hard delete on connection_credentials once destroyed the only copy of
-- two live Plaid access tokens on a Free-tier project with no PITR. A status
-- flag cannot serve here: the whole point is to stop `order by as_of desc`
-- reading 186k rows, and a soft-deleted row is still a row the index walks.
-- So recoverability comes from an archive instead, and the ordering below is
-- the part that matters:
--
--   ARCHIVE FIRST, VERIFY THE ARCHIVE, GATE, ONLY THEN REMOVE.
--
-- v1 of the proposal said to archive the SURVIVORS. That is backwards (audit
-- P0-1): the survivors are precisely the rows that are NOT removed, so the
-- 186k rows being destroyed would have had no copy anywhere -- the
-- connection_credentials shape exactly. This archives the WHOLE table, which
-- is a superset of the removals and is trivially verifiable (row counts and an
-- order-independent hash of every row must match before anything goes).
--
-- THREE `do` blocks, so three statements, each atomic on its own and each
-- separately re-runnable. That is not a stylistic choice. The live project is
-- reached through a client with a hard 60 s ceiling that ABORTS the
-- transaction when it expires, and the whole job does not fit: three attempts
-- were killed at 60 s, and all three rolled back completely -- the atomicity
-- working, but never finishing. The audited plan called for this split
-- (§3 step 4, "in batches, each in its own transaction"); writing it as one
-- statement was the deviation, and this is it corrected.
--
-- The split runs the safe way round, and each step is a precondition of the
-- next:
--
--   1. $archive$  writes the complete before-image and verifies it. An archive
--                 that exists without a removal is harmless; a removal without
--                 an archive is the failure this file exists to prevent, and
--                 after this step it cannot happen even if nothing else runs.
--   2. $plan$     classifies every row into keel_archive.compaction_plan_20260831
--                 and runs the whole equivalence gate against that
--                 classification. Writes nothing to public. Refuses to run
--                 without the archive.
--   3. $compact$  removes exactly the rows the COMMITTED plan marks removable,
--                 writes the Law 2 audit row in the same transaction, and then
--                 proves the result against the COMMITTED archive. Refuses to
--                 run without both.
--
-- Because the plan is committed before anything is removed, step 3 removes a
-- fixed, inspectable set of ids rather than re-deriving them next to the
-- delete. `keel_archive.compaction_plan_20260831` is therefore also the record
-- of exactly which rows went.
--
-- A sync landing between the steps is safe: a new snapshot is newer than
-- everything in the archive and everything in the plan, so it governs no
-- archived instant, it is not marked removable, and it survives untouched.
--
-- Not done here, because neither can run inside a transaction:
--   VACUUM (FULL) public.balance_snapshots;
--   REINDEX TABLE public.balance_snapshots;
-- A plain removal returns none of the 50 MB and the 27 MB of index bloats
-- worst. Run both immediately after step 3 commits; on the ~130 rows left they
-- take an ACCESS EXCLUSIVE lock for well under a second.


-- ===========================================================================
-- STEP 1 of 3 -- the before-image.
-- ===========================================================================
do $archive$
declare
  v_total        bigint;
  v_archived     bigint;
  v_bad          bigint;
  v_hash_source  text;
  v_hash_archive text;
  v_t            timestamptz;
begin
  v_t := clock_timestamp();
  -- Applied by hand against the live project with no migration-history table,
  -- so every step must be safe to re-run.
  if to_regclass('keel_archive.balance_snapshots_20260831') is not null then
    raise notice 'before-image already archived; leaving it alone';
    return;
  end if;

  select count(*) into v_total from public.balance_snapshots;

  -- Precondition (§3 step 1), checked here AND in step 2. as_of is the edge
  -- function's own wall clock with no unique constraint, and four consumers
  -- order by `as_of desc` with no tiebreaker, so a tie makes the row they
  -- return planner-dependent and the survivor predicate ill-defined.
  select count(*) into v_bad from (
    select 1 from public.balance_snapshots
     group by household_id, account_id, source, as_of having count(*) > 1
  ) t;
  if v_bad <> 0 then
    raise exception 'KEEL_COMPACTION_ABORT: % as_of ties within a series; predicate is ill-defined', v_bad;
  end if;

  -- Its own schema rather than public: these are operator recovery artifacts,
  -- not household data with a read model, and public is where the export
  -- catalog test (supabase/tests/008_export.sql) requires every base table to
  -- be explicitly classified. No grants are issued, so only the table owner
  -- and service_role can read them.
  create schema if not exists keel_archive;
  revoke all on schema keel_archive from public;
  comment on schema keel_archive is
    'Operator-side before-images kept for recovery. Not household-facing, not '
    'exported, no grants. Contents are discarded only on an explicit human instruction.';

  create table keel_archive.balance_snapshots_20260831
    (like public.balance_snapshots including defaults including constraints);
  comment on table keel_archive.balance_snapshots_20260831 is
    'Complete before-image of public.balance_snapshots taken 2026-08-31, prior '
    'to compaction (20260831200000). Superset of the rows removed. Retain until '
    'the human says otherwise.';

  insert into keel_archive.balance_snapshots_20260831
    select * from public.balance_snapshots;

  select count(*) into v_archived from keel_archive.balance_snapshots_20260831;
  if v_archived <> v_total then
    raise exception 'KEEL_COMPACTION_ABORT: archive holds % rows, source has %', v_archived, v_total;
  end if;

  -- Order-independent hash over every column of every row. Counts alone would
  -- not notice a column silently dropped by `like`.
  select md5(string_agg(h, '' order by h)) into v_hash_source
    from (select md5(t.*::text) as h from public.balance_snapshots t) s;
  select md5(string_agg(h, '' order by h)) into v_hash_archive
    from (select md5(t.*::text) as h from keel_archive.balance_snapshots_20260831 t) s;
  if v_hash_source is distinct from v_hash_archive then
    raise exception 'KEEL_COMPACTION_ABORT: archive row hashes do not match the source';
  end if;

  raise notice '  [compaction] %: % (% rows archived)', 'archive', clock_timestamp() - v_t, v_archived;
end
$archive$;


-- ===========================================================================
-- STEP 2 of 3 -- classify, and run the equivalence gate. Writes nothing to
-- public; every check is an abort.
-- ===========================================================================
do $plan$
declare
  v_bad       bigint;
  v_survivors bigint;
  v_removable bigint;
  v_t         timestamptz;
begin
  v_t := clock_timestamp();
  if to_regclass('keel_archive.balance_snapshots_20260831') is null then
    raise exception 'KEEL_COMPACTION_ABORT: no archive; run the archive statement first';
  end if;
  if exists (select 1 from public.audit_log
              where action = 'balance_snapshots.compact'
                and actor->>'migration' = '20260831200000') then
    raise notice 'balance snapshot compaction already applied; not re-planning';
    return;
  end if;

  select count(*) into v_bad from (
    select 1 from public.balance_snapshots
     group by household_id, account_id, source, as_of having count(*) > 1
  ) t;
  if v_bad <> 0 then
    raise exception 'KEEL_COMPACTION_ABORT: % as_of ties within a series; predicate is ill-defined', v_bad;
  end if;

  -- Rebuilt rather than reused: nothing has been removed yet, so a plan left
  -- over from an interrupted attempt is at best stale, and re-deriving it is
  -- a couple of seconds.
  drop table if exists keel_archive.compaction_plan_20260831;

  -- -------------------------------------------------------------------------
  -- The survivor predicate, evaluated ONCE and committed, so step 3 removes a
  -- fixed set of ids rather than re-deriving them next to the delete.
  --
  -- Per (household_id, account_id, source) ordered by (as_of, id): keep the
  -- FIRST row of every run of NULL-safe-equal dedupe keys, plus the NEWEST row
  -- of each series unconditionally.
  --
  -- `is not distinct from`, not `=`: 149,481 rows have a null limit_minor and
  -- 43,609 a null available_minor, and measured over the real table `=` finds
  -- 20.0% of rows redundant where `is not distinct from` finds 99.94%. It is
  -- also not merely conservative -- under `=` a run boundary where a value
  -- goes 50 -> null evaluates to NULL, so the row that STARTS the new run is
  -- misclassified as removable and the step function breaks.
  --
  -- `rn_asc = 1` rather than `p_cur is null`: lag() returns NULL for the first
  -- row of a partition, which is indistinguishable from a genuinely NULL
  -- value.
  -- -------------------------------------------------------------------------
  create table keel_archive.compaction_plan_20260831 as
  with ordered as (
    select bs.id, bs.household_id, bs.account_id, bs.source, bs.as_of, bs.created_at,
           bs.current_minor, bs.available_minor, bs.limit_minor, bs.currency, bs.snapshot_metadata,
           row_number()              over w_asc  as rn_asc,
           row_number()              over w_desc as rn_desc,
           lag(bs.current_minor)     over w_asc  as p_cur,
           lag(bs.available_minor)   over w_asc  as p_avail,
           lag(bs.limit_minor)       over w_asc  as p_lim,
           lag(bs.currency)          over w_asc  as p_curr,
           lag(bs.snapshot_metadata) over w_asc  as p_meta,
           lag(bs.created_at)        over w_asc  as p_created
      from public.balance_snapshots bs
    window w_asc  as (partition by bs.household_id, bs.account_id, bs.source order by bs.as_of asc,  bs.id asc),
           w_desc as (partition by bs.household_id, bs.account_id, bs.source order by bs.as_of desc, bs.id desc)
  )
  select o.*,
         (o.rn_asc = 1
          or o.rn_desc = 1
          or not (
               o.current_minor     is not distinct from o.p_cur
           and o.available_minor   is not distinct from o.p_avail
           and o.limit_minor       is not distinct from o.p_lim
           and o.currency          is not distinct from o.p_curr
           and o.snapshot_metadata is not distinct from '{}'::jsonb
           and o.p_meta            is not distinct from '{}'::jsonb
         )) as is_surv,
         (o.rn_asc = 1
          or not (
               o.current_minor     is not distinct from o.p_cur
           and o.available_minor   is not distinct from o.p_avail
           and o.limit_minor       is not distinct from o.p_lim
           and o.currency          is not distinct from o.p_curr
           and o.snapshot_metadata is not distinct from '{}'::jsonb
           and o.p_meta            is not distinct from '{}'::jsonb
         )) as starts_run
    from ordered o;

  comment on table keel_archive.compaction_plan_20260831 is
    'Survivor classification for compaction 20260831200000, committed before '
    'any row was removed. is_surv = false is exactly the set that went. Kept '
    'alongside the before-image as the record of what happened.';

  create index on keel_archive.compaction_plan_20260831 (household_id, account_id, source, rn_asc);
  create index on keel_archive.compaction_plan_20260831 (id);
  -- A freshly created table has NO statistics until it is analyzed, so the
  -- planner sizes it by a hardcoded default. That is how step 3's removal gets
  -- planned as a nested loop over 186k x 186k rows instead of a hash join, and
  -- it is what took a local scale run from 5 s to 437 s.
  analyze keel_archive.compaction_plan_20260831;
  raise notice '  [compaction] %: %', 'classify', clock_timestamp() - v_t; v_t := clock_timestamp();

  select count(*) into v_bad
    from keel_archive.compaction_plan_20260831
   where p_created is not null and created_at < p_created;
  if v_bad <> 0 then
    raise exception 'KEEL_COMPACTION_ABORT: % out-of-order arrivals', v_bad;
  end if;

  -- -------------------------------------------------------------------------
  -- The equivalence gate (§4). Compaction is safe only if it preserves all
  -- THREE properties in §2, not just the step function.
  -- -------------------------------------------------------------------------

  -- PROPERTY 1: the step function. Every instant in the history is some row's
  -- as_of (no ties, asserted above), so the value at or before instant D over
  -- the full table is that row's own value, and over the survivor set it is
  -- the nearest preceding survivor. Comparing those for every row is the
  -- exhaustive check, at O(n log n) rather than the O(n^2) a per-instant
  -- correlated subquery would cost.
  with governed as (
    select m.*,
           max(case when m.is_surv then m.rn_asc end) over (
             partition by m.household_id, m.account_id, m.source
             order by m.rn_asc rows between unbounded preceding and current row
           ) as gov_rn
      from keel_archive.compaction_plan_20260831 m
  )
  select count(*) into v_bad
    from governed g
    left join keel_archive.compaction_plan_20260831 s
      on s.household_id = g.household_id and s.account_id = g.account_id
     and s.source = g.source and s.rn_asc = g.gov_rn
   where g.gov_rn is null
      or s.id is null
      or g.current_minor     is distinct from s.current_minor
      or g.available_minor   is distinct from s.available_minor
      or g.limit_minor       is distinct from s.limit_minor
      or g.currency          is distinct from s.currency
      or g.snapshot_metadata is distinct from s.snapshot_metadata;
  if v_bad <> 0 then
    raise exception 'KEEL_COMPACTION_ABORT: step function differs at % instants', v_bad;
  end if;
  raise notice '  [compaction] %: %', 'gate prop1 (step function)', clock_timestamp() - v_t; v_t := clock_timestamp();

  -- PROPERTY 2: existence per (household_id, account_id, source).
  -- keel_net_worth_daily and keel_net_worth_as_of both gate an investment
  -- account's ledger flows on `exists (select 1 from balance_snapshots ...)`,
  -- so dropping a series' last row silently re-admits its postings to net
  -- worth; keel_cmd_reanchor_balance hard-fails without one. Per SERIES, not
  -- per account: keel_latest_balances filters on no source at all, so an
  -- account-level rule plus a second source arriving later drops the newest
  -- row of one of them.
  select count(*) into v_bad from (
    select household_id, account_id, source from keel_archive.compaction_plan_20260831
    except
    select household_id, account_id, source from keel_archive.compaction_plan_20260831 where is_surv
  ) t;
  if v_bad <> 0 then
    raise exception 'KEEL_COMPACTION_ABORT: % series would lose every row', v_bad;
  end if;

  select count(*) into v_bad
    from keel_archive.compaction_plan_20260831 where rn_desc = 1 and not is_surv;
  if v_bad <> 0 then
    raise exception 'KEEL_COMPACTION_ABORT: % series would lose their newest row', v_bad;
  end if;

  -- PROPERTY 3: the first-observation instant of each value. Re-derive the
  -- runs from the SURVIVING rows alone -- which is what a future reader of the
  -- compacted table would do -- and require the same (series, first instant,
  -- value) multiset as the full table.
  with runs as (
    select m.*,
           sum(case when m.starts_run then 1 else 0 end) over (
             partition by m.household_id, m.account_id, m.source
             order by m.rn_asc rows between unbounded preceding and current row
           ) as run_id
      from keel_archive.compaction_plan_20260831 m
  ),
  full_starts as (
    select household_id, account_id, source, min(as_of) as first_as_of,
           min(current_minor) as cur, min(available_minor) as avail,
           min(limit_minor) as lim, min(currency) as curr, min(snapshot_metadata::text) as meta
      from runs group by household_id, account_id, source, run_id
  ),
  surv_ordered as (
    select m.id, m.household_id, m.account_id, m.source, m.as_of,
           m.current_minor, m.available_minor, m.limit_minor, m.currency, m.snapshot_metadata,
           row_number()             over w as s_rn,
           lag(m.current_minor)     over w as p_cur,
           lag(m.available_minor)   over w as p_avail,
           lag(m.limit_minor)       over w as p_lim,
           lag(m.currency)          over w as p_curr,
           lag(m.snapshot_metadata) over w as p_meta
      from keel_archive.compaction_plan_20260831 m
     where m.is_surv
    window w as (partition by m.household_id, m.account_id, m.source order by m.as_of asc, m.id asc)
  ),
  surv_runs as (
    select s.*,
           sum(case when s.s_rn = 1
                     or not (
                          s.current_minor     is not distinct from s.p_cur
                      and s.available_minor   is not distinct from s.p_avail
                      and s.limit_minor       is not distinct from s.p_lim
                      and s.currency          is not distinct from s.p_curr
                      and s.snapshot_metadata is not distinct from '{}'::jsonb
                      and s.p_meta            is not distinct from '{}'::jsonb
                    ) then 1 else 0 end) over (
             partition by s.household_id, s.account_id, s.source
             order by s.s_rn rows between unbounded preceding and current row
           ) as run_id
      from surv_ordered s
  ),
  surv_starts as (
    select household_id, account_id, source, min(as_of) as first_as_of,
           min(current_minor) as cur, min(available_minor) as avail,
           min(limit_minor) as lim, min(currency) as curr, min(snapshot_metadata::text) as meta
      from surv_runs group by household_id, account_id, source, run_id
  )
  select count(*) into v_bad from (
    (select * from full_starts except all select * from surv_starts)
    union all
    (select * from surv_starts except all select * from full_starts)
  ) t;
  if v_bad <> 0 then
    raise exception 'KEEL_COMPACTION_ABORT: % first-observation instants differ', v_bad;
  end if;

  select count(*) filter (where is_surv), count(*) filter (where not is_surv)
    into v_survivors, v_removable
    from keel_archive.compaction_plan_20260831;
  raise notice '  [compaction] %: %', 'gate prop2 + prop3', clock_timestamp() - v_t;
  raise notice '  [compaction] plan committed: % survivors, % removable', v_survivors, v_removable;
end
$plan$;


-- ===========================================================================
-- STEP 3 of 3 -- remove exactly what the committed plan marks removable, audit
-- it, and prove the result against the committed before-image.
-- ===========================================================================
do $compact$
declare
  v_total     bigint;
  v_survivors bigint;
  v_removable bigint;
  v_bad       bigint;
  v_household uuid;
  v_t         timestamptz;
begin
  v_t := clock_timestamp();
  if to_regclass('keel_archive.balance_snapshots_20260831') is null then
    raise exception 'KEEL_COMPACTION_ABORT: no archive; run the archive statement first';
  end if;
  if to_regclass('keel_archive.compaction_plan_20260831') is null then
    raise exception 'KEEL_COMPACTION_ABORT: no plan; run the plan statement first';
  end if;
  if exists (select 1 from public.audit_log
              where action = 'balance_snapshots.compact'
                and actor->>'migration' = '20260831200000') then
    raise notice 'balance snapshot compaction already applied (audit row exists); nothing to do';
    return;
  end if;

  -- The archive IS the before-image, so it is the authority on how many rows
  -- there were. Counting balance_snapshots here would count what is left.
  select count(*) into v_total from keel_archive.balance_snapshots_20260831;
  select count(*) filter (where is_surv), count(*) filter (where not is_surv)
    into v_survivors, v_removable
    from keel_archive.compaction_plan_20260831;

  -- `using` join against the committed plan, NOT `id = any(array_agg(...))`.
  -- The array form is the obvious way to write this and it is what the first
  -- live attempt used; a 186,810-element array is a quadratic trap.
  delete from public.balance_snapshots bs
   using keel_archive.compaction_plan_20260831 m
   where m.id = bs.id and not m.is_surv;
  get diagnostics v_bad = row_count;
  if v_bad <> v_removable then
    raise exception 'KEEL_COMPACTION_ABORT: removed % rows, plan marks % removable', v_bad, v_removable;
  end if;
  raise notice '  [compaction] %: %', 'remove', clock_timestamp() - v_t; v_t := clock_timestamp();

  -- Law 2. balance_snapshots has no trigger and no audit coverage (audit
  -- P1-5), so this would otherwise leave zero trace anywhere, and Law 2
  -- requires the actor, the counts, the archive location and the predicate be
  -- recorded. Same transaction as the removal.
  for v_household in select distinct household_id from keel_archive.balance_snapshots_20260831 loop
    insert into public.audit_log
      (household_id, actor, action, object_type, object_id, command_id, before, after)
    values (
      v_household,
      jsonb_build_object('kind', 'maintenance', 'migration', '20260831200000',
                         'db_user', current_user),
      'balance_snapshots.compact',
      'balance_snapshots',
      null,
      null,
      jsonb_build_object(
        'rows', (select count(*) from keel_archive.balance_snapshots_20260831
                  where household_id = v_household),
        'archive', 'keel_archive.balance_snapshots_20260831',
        'plan', 'keel_archive.compaction_plan_20260831'),
      jsonb_build_object(
        'rows', (select count(*) from public.balance_snapshots where household_id = v_household),
        'predicate', 'per (household_id, account_id, source) ordered by (as_of, id): '
                     'keep the first row of every run of NULL-safe-equal '
                     '(current_minor, available_minor, limit_minor, currency) with '
                     'snapshot_metadata = ''{}'', plus the newest row of each series',
        'reversible', 'restore from keel_archive.balance_snapshots_20260831')
    );
  end loop;

  -- -------------------------------------------------------------------------
  -- Prove it against the before-image, not against the predicate.
  --
  -- For every row that ever existed, ask the COMPACTED table what the value
  -- was at that row's instant, and require the archived answer. This makes no
  -- reference to is_surv or to the plan, so a predicate that drifted from
  -- scripts/audit/balance-snapshot-compaction-gate.sql still fails closed here
  -- and rolls the removal and its audit row back.
  --
  -- Interleave the two tables and carry the last live row forward, rather than
  -- either of the two obvious shapes:
  --
  --   * `left join lateral (... order by as_of desc limit 1)` does one index
  --     probe per archived row at the exact moment the index still physically
  --     holds every entry this transaction just removed and which is invisible
  --     to it, so every probe walks past them;
  --   * a self-join on a materialised CTE of the interleaving measured over
  --     60 s on the live instance -- it is what blew the third attempt's
  --     budget. The carry below measured 6.4 s on the same data.
  --
  -- The carry uses the standard grouping trick, because Postgres has no
  -- `IGNORE NULLS`: count the live rows seen so far, which makes each live row
  -- the FIRST member of its own group, then take first_value within the group.
  -- `is_live desc` in the ordering is load-bearing: a surviving row and its own
  -- archived copy share (as_of, id), and the live one has to sort first so a
  -- kept row is governed by itself rather than by its predecessor. `g = 0`
  -- means no live row at or before that instant at all.
  -- -------------------------------------------------------------------------
  with interleaved as (
    select household_id, account_id, source, as_of, id,
           current_minor, available_minor, limit_minor, currency, snapshot_metadata,
           false as is_live
      from keel_archive.balance_snapshots_20260831
    union all
    select household_id, account_id, source, as_of, id,
           current_minor, available_minor, limit_minor, currency, snapshot_metadata,
           true
      from public.balance_snapshots
  ),
  grp as (
    select i.*, count(case when i.is_live then 1 end) over w as g
      from interleaved i
    window w as (partition by household_id, account_id, source
                 order by as_of, id, is_live desc rows unbounded preceding)
  ),
  carried as (
    select g.*,
           first_value(current_minor)     over w2 as gov_cur,
           first_value(available_minor)   over w2 as gov_avail,
           first_value(limit_minor)       over w2 as gov_lim,
           first_value(currency)          over w2 as gov_curr,
           first_value(snapshot_metadata) over w2 as gov_meta
      from grp g
    window w2 as (partition by household_id, account_id, source, g
                  order by as_of, id, is_live desc)
  )
  select count(*) into v_bad from carried
   where not is_live
     and (g = 0
       or gov_cur   is distinct from current_minor
       or gov_avail is distinct from available_minor
       or gov_lim   is distinct from limit_minor
       or gov_curr  is distinct from currency
       or gov_meta  is distinct from snapshot_metadata);
  if v_bad <> 0 then
    raise exception 'KEEL_COMPACTION_ABORT: compacted table disagrees with the before-image at % instants', v_bad;
  end if;
  raise notice '  [compaction] %: %', 'verify against the before-image', clock_timestamp() - v_t; v_t := clock_timestamp();

  select count(*) into v_bad from (
    select household_id, account_id, source from keel_archive.balance_snapshots_20260831
    except
    select household_id, account_id, source from public.balance_snapshots
  ) t;
  if v_bad <> 0 then
    raise exception 'KEEL_COMPACTION_ABORT: % series vanished from the compacted table', v_bad;
  end if;

  -- `>=` not `=`: a sync landing between the plan and here adds a survivor the
  -- plan never saw, which is correct and must not be treated as a failure.
  select count(*) into v_bad from public.balance_snapshots;
  if v_bad < v_survivors then
    raise exception 'KEEL_COMPACTION_ABORT: % rows remain, plan expected at least %', v_bad, v_survivors;
  end if;

  raise notice 'balance snapshot compaction: % rows -> % survivors (% removed), before-image in keel_archive.balance_snapshots_20260831, plan in keel_archive.compaction_plan_20260831',
    v_total, v_bad, v_removable;
end
$compact$;
