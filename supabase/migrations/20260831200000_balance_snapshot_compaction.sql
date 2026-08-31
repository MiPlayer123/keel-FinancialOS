-- Balance snapshot compaction, phase 2: remove the 186,810 rows that phase 1
-- stopped creating. docs/BALANCE-SNAPSHOT-COMPACTION.md §3 phase 2 and §4.
--
-- Phase 1 (20260831190000) stopped the amplification at the write side.
-- This removes the backlog: 186,943 rows over one household and 16 accounts,
-- 50 MB and 26% of the database, of which the survivor predicate keeps 133.
-- keel_latest_balances and keel_investments_overview both do
-- `distinct on (account_id) ... order by as_of desc` with no index-skip scan
-- available, so their cost is LINEAR in this count: 186,889 rows and 87,233
-- buffers scanned to return 10 rows, 2.06 s. Compaction IS the latency fix,
-- not a tidy-up alongside it.
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
-- is a superset of the removals and is trivially verifiable (row counts and
-- an order-independent hash of every row must match before anything goes).
--
-- Everything runs inside ONE `do` block, which is a single statement and
-- therefore atomic regardless of how the caller wraps it. Every check is a
-- `raise exception`, so any failure rolls back the archive AND the removal and
-- leaves the table exactly as it was.
--
-- The final check is the one that actually protects the data, because it does
-- not depend on the survivor predicate at all: afterwards, for EVERY row in
-- the archived before-image, the compacted table's step-function value at that
-- row's instant must equal the archived value. If this file's predicate ever
-- drifts from scripts/audit/balance-snapshot-compaction-gate.sql, that check
-- still fails closed.
--
-- Not done here, because neither can run inside a transaction:
--   VACUUM (FULL) public.balance_snapshots;
--   REINDEX TABLE public.balance_snapshots;
-- A plain removal returns none of the 50 MB and the 27 MB of index bloats
-- worst. Run both immediately after this commits; on the ~130 rows left they
-- take an ACCESS EXCLUSIVE lock for well under a second.

do $compaction$
declare
  v_total        bigint;
  v_archived     bigint;
  v_survivors    bigint;
  v_removable    bigint;
  v_bad          bigint;
  v_hash_source  text;
  v_hash_archive text;
  v_household    uuid;
  -- Per-phase timing. This is not decoration: the first live attempt blew a
  -- 60 s client ceiling and there was no way to tell which phase had eaten it.
  v_t            timestamptz;
begin
  v_t := clock_timestamp();
  -- -------------------------------------------------------------------------
  -- 0. Already done? This file is applied by hand against the live project
  --    with no migration-history table, so it must be safe to re-run.
  -- -------------------------------------------------------------------------
  if to_regclass('keel_archive.balance_snapshots_20260831') is not null then
    raise notice 'balance snapshot compaction already applied (archive exists); nothing to do';
    return;
  end if;

  select count(*) into v_total from public.balance_snapshots;

  -- -------------------------------------------------------------------------
  -- 1. Preconditions (§3 step 1). as_of is the edge function's own wall clock
  --    with no unique constraint, and four consumers order by `as_of desc`
  --    with no tiebreaker, so a tie makes the row they return
  --    planner-dependent and the survivor predicate ill-defined.
  -- -------------------------------------------------------------------------
  select count(*) into v_bad from (
    select 1 from public.balance_snapshots
     group by household_id, account_id, source, as_of having count(*) > 1
  ) t;
  if v_bad <> 0 then
    raise exception 'KEEL_COMPACTION_ABORT: % as_of ties within a series; predicate is ill-defined', v_bad;
  end if;

  -- -------------------------------------------------------------------------
  -- 2. Classify every row ONCE, into a temp table, so the gate below and the
  --    removal further down provably operate on the same set.
  --
  --    Survivor predicate: per (household_id, account_id, source) ordered by
  --    (as_of, id), keep the FIRST row of every run of NULL-safe-equal dedupe
  --    keys, plus the NEWEST row of each series unconditionally.
  --
  --    `is not distinct from`, not `=`: 149,481 rows have a null limit_minor
  --    and 43,609 a null available_minor, and measured over the real table
  --    `=` finds 20.0% of rows redundant where `is not distinct from` finds
  --    99.94%. It is also not merely conservative -- under `=` a run boundary
  --    where a value goes 50 -> null evaluates to NULL, so the row that STARTS
  --    the new run is misclassified as removable and the step function breaks.
  --
  --    `rn_asc = 1` rather than `p_cur is null`: lag() returns NULL for the
  --    first row of a partition, which is indistinguishable from a genuinely
  --    NULL value.
  -- -------------------------------------------------------------------------
  create temporary table _compaction_marked on commit drop as
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

  create index on _compaction_marked (household_id, account_id, source, rn_asc);
  create index on _compaction_marked (id);
  -- A temp table has NO statistics until it is analyzed, so the planner sizes
  -- it by a hardcoded default. That is how the removal below can be planned as
  -- a nested loop over 186k x 186k rows instead of a hash join.
  analyze _compaction_marked;

  raise notice '  [compaction] %: %', 'classify', clock_timestamp() - v_t; v_t := clock_timestamp();
  select count(*) into v_bad
    from _compaction_marked where p_created is not null and created_at < p_created;
  if v_bad <> 0 then
    raise exception 'KEEL_COMPACTION_ABORT: % out-of-order arrivals', v_bad;
  end if;

  select count(*) filter (where is_surv), count(*) filter (where not is_surv)
    into v_survivors, v_removable
    from _compaction_marked;

  -- -------------------------------------------------------------------------
  -- 3. The equivalence gate (§4). Compaction is safe only if it preserves all
  --    THREE properties in §2, not just the step function.
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
      from _compaction_marked m
  )
  select count(*) into v_bad
    from governed g
    left join _compaction_marked s
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

  -- PROPERTY 2: existence per (household_id, account_id, source).
  -- keel_net_worth_daily and keel_net_worth_as_of both gate an investment
  -- account's ledger flows on `exists (select 1 from balance_snapshots ...)`,
  -- so dropping a series' last row silently re-admits its postings to net
  -- worth; keel_cmd_reanchor_balance hard-fails without one. Per SERIES, not
  -- per account: keel_latest_balances filters on no source at all, so an
  -- account-level rule plus a second source arriving later drops the newest
  -- row of one of them.
  raise notice '  [compaction] %: %', 'gate prop1 (step function)', clock_timestamp() - v_t; v_t := clock_timestamp();
  select count(*) into v_bad from (
    select household_id, account_id, source from _compaction_marked
    except
    select household_id, account_id, source from _compaction_marked where is_surv
  ) t;
  if v_bad <> 0 then
    raise exception 'KEEL_COMPACTION_ABORT: % series would lose every row', v_bad;
  end if;

  select count(*) into v_bad
    from _compaction_marked where rn_desc = 1 and not is_surv;
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
      from _compaction_marked m
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
      from _compaction_marked m
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

  -- -------------------------------------------------------------------------
  -- 4. ARCHIVE, BEFORE ANYTHING IS REMOVED. The whole table, not the survivors.
  --
  --    Its own schema rather than public: it is an operator recovery artifact,
  --    not household data with a read model, and public is where the export
  --    catalog test (supabase/tests/008_export.sql) requires every base table
  --    to be explicitly classified. No grants are issued, so only the table
  --    owner and service_role can read it.
  -- -------------------------------------------------------------------------
  raise notice '  [compaction] %: %', 'gate prop2 + prop3', clock_timestamp() - v_t; v_t := clock_timestamp();
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

  -- -------------------------------------------------------------------------
  -- 5. Remove, with an audit_log row in the SAME transaction. balance_snapshots
  --    has no trigger and no audit coverage (audit P1-5), so this would
  --    otherwise leave zero trace anywhere, and Law 2 requires the actor, the
  --    counts, the archive location and the predicate be recorded.
  -- -------------------------------------------------------------------------
  raise notice '  [compaction] %: %', 'archive + verify hashes', clock_timestamp() - v_t; v_t := clock_timestamp();
  -- `using` join, NOT `id = any(array_agg(...))`. The array form is the
  -- obvious way to write this and it is what the first live attempt used; it
  -- ran past 60 s and was killed. A 186,810-element array is a quadratic trap,
  -- and building it also materialises the whole id set in backend memory for
  -- no reason when the classification is already sitting in a table.
  delete from public.balance_snapshots bs
   using _compaction_marked m
   where m.id = bs.id and not m.is_surv;
  get diagnostics v_bad = row_count;
  if v_bad <> v_removable then
    raise exception 'KEEL_COMPACTION_ABORT: removed % rows, classified % as removable', v_bad, v_removable;
  end if;

  raise notice '  [compaction] %: %', 'remove', clock_timestamp() - v_t; v_t := clock_timestamp();
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
        'archive', 'keel_archive.balance_snapshots_20260831'),
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
  -- 6. Prove it against the before-image, not against the predicate.
  --
  --    For every row that ever existed, ask the COMPACTED table what the value
  --    was at that row's instant, and require the archived answer. This makes
  --    no reference to is_surv, so a predicate that drifted from the gate --
  --    or from scripts/audit/balance-snapshot-compaction-gate.sql -- still
  --    fails closed here and rolls everything back.
  -- -------------------------------------------------------------------------
  --    Set-based, deliberately: the obvious `left join lateral (... order by
  --    as_of desc limit 1)` does one index probe per archived row, and at this
  --    point in the transaction the index still physically contains all
  --    186,810 entries this statement just removed and which are invisible to
  --    it, so every probe walks past them to reach a live one. That is the
  --    other half of what made the first live attempt exceed 60 s. Interleaving
  --    the two tables and taking a running "last live row" instead costs one
  --    sort of 2n rows and no probes at all.
  --
  --    `is_live desc` in the ordering matters: a surviving row and its own
  --    archived copy share (as_of, id), and the live one has to sort first so
  --    that a kept row is governed by itself rather than by its predecessor.
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
  seq as (
    select i.*,
           row_number() over (partition by household_id, account_id, source
                              order by as_of, id, is_live desc) as rn
      from interleaved i
  ),
  gov as (
    select s.*,
           max(case when s.is_live then s.rn end) over (
             partition by s.household_id, s.account_id, s.source
             order by s.rn rows between unbounded preceding and current row
           ) as gov_rn
      from seq s
  )
  select count(*) into v_bad
    from gov a
    left join gov c
      on c.household_id = a.household_id and c.account_id = a.account_id
     and c.source = a.source and c.rn = a.gov_rn
   where not a.is_live
     and (c.rn is null
      or c.current_minor     is distinct from a.current_minor
      or c.available_minor   is distinct from a.available_minor
      or c.limit_minor       is distinct from a.limit_minor
      or c.currency          is distinct from a.currency
      or c.snapshot_metadata is distinct from a.snapshot_metadata);
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

  select count(*) into v_bad from public.balance_snapshots;
  if v_bad <> v_survivors then
    raise exception 'KEEL_COMPACTION_ABORT: % rows remain, expected %', v_bad, v_survivors;
  end if;

  raise notice '  [compaction] %: %', 'final counts', clock_timestamp() - v_t; v_t := clock_timestamp();
  raise notice 'balance snapshot compaction: % rows -> % survivors (% removed), archived to keel_archive.balance_snapshots_20260831',
    v_total, v_survivors, v_removable;
end
$compaction$;
