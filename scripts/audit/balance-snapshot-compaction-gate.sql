-- The phase 2 equivalence gate, docs/BALANCE-SNAPSHOT-COMPACTION.md §4.
--
-- Read-only. Runs against the real balance_snapshots table and decides whether
-- the survivor predicate is LOSSLESS for that exact data. It is an abort
-- condition, not a report: every row it returns whose `value` is not the
-- expected one blocks the delete.
--
-- Why it is shaped like this: v1 of the proposal wanted to "compare compacted
-- vs current output through the real read models". That is not executable
-- here -- the read models are SECURITY DEFINER and raise
-- KEEL_NOT_AUTHENTICATED without a JWT subject, and the Free tier has no
-- branch and no PITR, so there is no second database to compare against. A
-- hand-copied duplicate of each function's SQL would test the copy. So the
-- gate instead proves the three properties §2 says compaction must preserve,
-- directly over the rows, exhaustively:
--
--   1. the step function -- for every instant in the entire history, the
--      latest value at or before it is unchanged;
--   2. existence per (household_id, account_id, source) -- keel_net_worth_daily
--      and keel_net_worth_as_of both gate an investment account's ledger flows
--      on `exists (select 1 from balance_snapshots ...)`, so dropping a
--      series' last row silently re-admits its postings to net worth, and
--      keel_cmd_reanchor_balance hard-fails;
--   3. the first-observation instant of each value -- keep the FIRST row of
--      each equal run, not the last, so "when did this value first appear"
--      survives.
--
-- Survivor predicate: per (household_id, account_id, source) ordered by
-- (as_of, id), keep the first row of every run of NULL-safe-equal dedupe keys,
-- plus the newest row of each series unconditionally. Dedupe key is
-- (current_minor, available_minor, limit_minor, currency) compared with
-- `is not distinct from`, and both sides must carry snapshot_metadata = '{}'.
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
),
-- `rn_asc = 1` rather than `p_cur is null`: lag() returns NULL for the first
-- row of a partition, which is indistinguishable from a genuinely NULL value
-- (43,609 rows have a null available_minor and 149,481 a null limit_minor).
marked as (
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
    from ordered o
),
-- Property 1, set-based. Every instant in the history is some row's as_of (no
-- ties, asserted below), so "the latest value at or before instant D" over the
-- full table is that row's own value. Over the survivor set it is the nearest
-- preceding survivor. Comparing the two for EVERY row is therefore the
-- exhaustive step-function check, in O(n log n) rather than the O(n^2) a
-- correlated subquery per instant would cost.
governed as (
  select m.*,
         max(case when m.is_surv then m.rn_asc end) over (
           partition by m.household_id, m.account_id, m.source
           order by m.rn_asc rows between unbounded preceding and current row
         ) as gov_rn
    from marked m
),
-- Property 3. Group the full table into runs, then group the SURVIVORS into
-- runs independently, and require the two produce the same
-- (series, first instant, value) multiset. This is a real comparison, not a
-- restatement of the predicate: it re-derives the runs from the surviving rows
-- alone, which is what a future reader of the compacted table would do.
runs as (
  select m.*,
         sum(case when m.starts_run then 1 else 0 end) over (
           partition by m.household_id, m.account_id, m.source
           order by m.rn_asc rows between unbounded preceding and current row
         ) as run_id
    from marked m
),
full_starts as (
  select household_id, account_id, source,
         min(as_of) as first_as_of,
         min(current_minor) as cur, min(available_minor) as avail,
         min(limit_minor) as lim, min(currency) as curr, min(snapshot_metadata::text) as meta
    from runs
   group by household_id, account_id, source, run_id
),
surv_ordered as (
  select m.id, m.household_id, m.account_id, m.source, m.as_of,
         m.current_minor, m.available_minor, m.limit_minor, m.currency, m.snapshot_metadata,
         row_number()              over w as s_rn,
         lag(m.current_minor)      over w as p_cur,
         lag(m.available_minor)    over w as p_avail,
         lag(m.limit_minor)        over w as p_lim,
         lag(m.currency)           over w as p_curr,
         lag(m.snapshot_metadata)  over w as p_meta
    from marked m
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
  select household_id, account_id, source,
         min(as_of) as first_as_of,
         min(current_minor) as cur, min(available_minor) as avail,
         min(limit_minor) as lim, min(currency) as curr, min(snapshot_metadata::text) as meta
    from surv_runs
   group by household_id, account_id, source, run_id
)
select 'rows_total' as check, count(*)::text as value, 'informational' as expected from marked
union all
select 'survivors', count(*)::text, 'informational' from marked where is_surv
union all
select 'to_delete', count(*)::text, 'informational' from marked where not is_surv
union all
-- Preconditions (§3 step 1). as_of is the edge function's own wall clock with
-- no unique constraint, and four consumers order by as_of desc with no
-- tiebreaker, so a tie makes the returned row planner-dependent and the
-- survivor predicate ill-defined.
select 'PRECOND_as_of_ties_within_a_series', count(*)::text, '0'
  from (select 1 from public.balance_snapshots
         group by household_id, account_id, source, as_of having count(*) > 1) t
union all
select 'PRECOND_out_of_order_arrival', count(*)::text, '0'
  from marked where p_created is not null and created_at < p_created
union all
-- Property 1.
select 'PROP1_rows_with_no_governing_survivor', count(*)::text, '0'
  from governed where gov_rn is null
union all
select 'PROP1_step_function_differences', count(*)::text, '0'
  from governed g
  join marked s
    on s.household_id = g.household_id and s.account_id = g.account_id
   and s.source = g.source and s.rn_asc = g.gov_rn
 where g.current_minor     is distinct from s.current_minor
    or g.available_minor   is distinct from s.available_minor
    or g.limit_minor       is distinct from s.limit_minor
    or g.currency          is distinct from s.currency
    or g.snapshot_metadata is distinct from s.snapshot_metadata
union all
-- Property 2.
select 'PROP2_series_lost', count(*)::text, '0' from (
  select household_id, account_id, source from marked
  except
  select household_id, account_id, source from marked where is_surv
) t
union all
select 'PROP2_newest_row_of_a_series_not_kept', count(*)::text, '0'
  from marked where rn_desc = 1 and not is_surv
union all
-- Property 3.
select 'PROP3_first_observation_instants_differ', count(*)::text, '0' from (
  (select * from full_starts except all select * from surv_starts)
  union all
  (select * from surv_starts except all select * from full_starts)
) t
union all
-- Nothing outside the plaid series should be touched by a phase-1-era
-- assumption; report the source breakdown so a second source arriving later is
-- visible rather than silently folded in.
select 'sources_present', string_agg(distinct source, ','), 'informational' from public.balance_snapshots
order by 1;
