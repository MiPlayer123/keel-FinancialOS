#!/usr/bin/env bash
# Throwaway-Postgres validation for balance snapshot compaction, phase 2
# (20260831200000_balance_snapshot_compaction.sql).
#
# This is the file that removes 186k rows from a Free-tier project with no
# PITR, so it is not enough to show it works on good data. Four things are
# proven here, against a real Postgres, with the migration loaded VERBATIM:
#
#   1. on correct data it keeps exactly the survivor set, archives the whole
#      before-image intact, and writes the Law 2 audit row;
#   2. it is re-runnable -- a second apply is a no-op, not a second archive or
#      a second pass over the data;
#   3. every abort path is ATOMIC: when a precondition or a gate check fails,
#      the table still holds every original row and no archive is left behind;
#   4. the internal gate is load-bearing -- with a deliberately broken survivor
#      predicate the migration must refuse to commit, NOT quietly remove the
#      wrong rows. `--mutate` runs those.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MIGRATION="$ROOT/supabase/migrations/20260831200000_balance_snapshot_compaction.sql"
[ -f "$MIGRATION" ] || { echo "FATAL: missing $MIGRATION"; exit 1; }

MUTATE=0
[ "${1:-}" = "--mutate" ] && MUTATE=1

PGBIN="$(dirname "$(command -v initdb || echo /usr/lib/postgresql/16/bin/initdb)")"
[ -x "$PGBIN/initdb" ] || { echo "FATAL: initdb not found"; exit 1; }

TMP="$(mktemp -d)"
DATADIR="$TMP/data"; SOCK="$TMP/sock"; mkdir -p "$SOCK"
cleanup() { "$PGBIN/pg_ctl" -D "$DATADIR" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATADIR" -U postgres --auth=trust >/dev/null
"$PGBIN/pg_ctl" -D "$DATADIR" -o "-k $SOCK -c listen_addresses=''" -w start >/dev/null

FIXTURE="$TMP/fixture.sql"
cat > "$FIXTURE" <<'FIX'
create table public.households (id uuid primary key, name text not null);
create table public.audit_log (
  id bigint generated always as identity primary key,
  household_id uuid not null references public.households (id),
  actor jsonb not null,
  action text not null check (length(action) between 1 and 200),
  object_type text not null check (length(object_type) between 1 and 100),
  object_id uuid,
  command_id uuid,
  before jsonb,
  after jsonb,
  at timestamptz not null default now()
);
create table public.balance_snapshots (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null,
  account_id uuid not null,
  as_of timestamptz not null,
  available_minor bigint,
  current_minor bigint not null,
  limit_minor bigint,
  currency text not null,
  source text not null,
  snapshot_metadata jsonb,
  created_at timestamptz not null default now()
);
insert into public.households values ('00000000-0000-4000-8000-000000000001', 'Fixture');

create function public.f(
  acct text, src text, tick int,
  cur bigint, avail bigint, lim bigint, curr text default 'USD', meta jsonb default '{}'::jsonb
) returns void language sql as $$
  insert into public.balance_snapshots
    (household_id, account_id, as_of, available_minor, current_minor, limit_minor,
     currency, source, snapshot_metadata, created_at)
  values
    ('00000000-0000-4000-8000-000000000001',
     ('00000000-0000-4000-8000-00000000000' || acct)::uuid,
     timestamptz '2026-08-01T00:00:00Z' + (tick || ' minutes')::interval,
     avail, cur, lim, curr, src, meta,
     timestamptz '2026-08-01T00:00:00Z' + (tick || ' minutes')::interval);
$$;

-- Same fixture as scripts/run-balance-snapshot-gate-check.sh: 25 rows, 18
-- survivors, 7 removable, covering plain runs, a second source on the same
-- account, a series of one, nulls, snapshot_metadata, a length-1 final run, an
-- all-duplicate two-row series, and a run boundary only a NULL-safe
-- comparison can see.
select public.f('a','plaid',1,100,100,null);
select public.f('a','plaid',2,100,100,null);
select public.f('a','plaid',3,100,100,null);
select public.f('a','plaid',4,200,200,null);
select public.f('a','plaid',5,200,200,null);
select public.f('a','plaid',6,200,200,null);
select public.f('a','statement',1,200,200,null);
select public.f('a','statement',2,200,200,null);
select public.f('a','statement',3,200,200,null);
select public.f('b','plaid',1,300,300,null);
select public.f('c','plaid',1,100,null,null);
select public.f('c','plaid',2,100,null,null);
select public.f('c','plaid',3,100,null,5);
select public.f('d','plaid',1,100,100,null,'USD','{}'::jsonb);
select public.f('d','plaid',2,100,100,null,'USD','{"a":1}'::jsonb);
select public.f('d','plaid',3,100,100,null,'USD','{}'::jsonb);
select public.f('e','plaid',1,400,400,null);
select public.f('e','plaid',2,400,400,null);
select public.f('e','plaid',3,500,500,null);
select public.f('f','plaid',1,600,600,null);
select public.f('f','plaid',2,600,600,null);
select public.f('9','plaid',1,100,50,null);
select public.f('9','plaid',2,100,null,null);
select public.f('9','plaid',3,100,null,null);
select public.f('9','plaid',4,100,60,null);
FIX

fresh_db() { # fresh_db <name> [extra.sql]
  "$PGBIN/dropdb" -h "$SOCK" -U postgres --if-exists "$1" >/dev/null
  "$PGBIN/createdb" -h "$SOCK" -U postgres "$1" >/dev/null
  "$PGBIN/psql" -X -q -v ON_ERROR_STOP=1 -h "$SOCK" -U postgres -d "$1" -f "$FIXTURE" >/dev/null
  [ -n "${2:-}" ] && "$PGBIN/psql" -X -q -v ON_ERROR_STOP=1 -h "$SOCK" -U postgres -d "$1" -f "$2" >/dev/null
  return 0
}
q() { "$PGBIN/psql" -X -tA -h "$SOCK" -U postgres -d "$1" -c "$2"; }
apply() { "$PGBIN/psql" -X -v ON_ERROR_STOP=1 -h "$SOCK" -U postgres -d "$1" -f "$2" 2>&1; }

FAILED=0
expect() { # expect <label> <got> <want>
  if [ "$2" = "$3" ]; then echo "  ok   $1 = $3"
  else echo "  FAIL $1: got '$2', want '$3'"; FAILED=1; fi
}

echo "=== 1. happy path ==="
fresh_db good
BEFORE_HASH="$(q good "select md5(string_agg(h,'' order by h)) from (select md5(t.*::text) h from public.balance_snapshots t) s")"
OUT="$(apply good "$MIGRATION")"
echo "$OUT" | grep -E 'NOTICE|ERROR' | sed 's/^/    /'
expect "rows remaining"        "$(q good 'select count(*) from public.balance_snapshots')" 18
expect "rows archived"         "$(q good 'select count(*) from keel_archive.balance_snapshots_20260831')" 25
expect "archive matches the original before-image" \
  "$(q good "select md5(string_agg(h,'' order by h)) from (select md5(t.*::text) h from keel_archive.balance_snapshots_20260831 t) s")" \
  "$BEFORE_HASH"
expect "audit rows written"    "$(q good "select count(*) from public.audit_log where action='balance_snapshots.compact'")" 1
expect "audit records the archive location" \
  "$(q good "select before->>'archive' from public.audit_log where action='balance_snapshots.compact'")" \
  'keel_archive.balance_snapshots_20260831'
expect "audit before/after row counts" \
  "$(q good "select (before->>'rows')||'->'||(after->>'rows') from public.audit_log where action='balance_snapshots.compact'")" \
  '25->18'
expect "no series lost" \
  "$(q good 'select count(*) from (select household_id,account_id,source from keel_archive.balance_snapshots_20260831 except select household_id,account_id,source from public.balance_snapshots) t')" 0
expect "archive schema is not readable by PUBLIC" \
  "$(q good "select has_schema_privilege('public','keel_archive','usage')::text")" false
# The point of the whole exercise: every historical instant still answers the
# same value out of the compacted table.
expect "step function preserved for all 25 original instants" \
  "$(q good "select count(*) from keel_archive.balance_snapshots_20260831 a left join lateral (select 1 as found, b.current_minor, b.available_minor, b.limit_minor, b.currency, b.snapshot_metadata from public.balance_snapshots b where b.household_id=a.household_id and b.account_id=a.account_id and b.source=a.source and (b.as_of,b.id)<=(a.as_of,a.id) order by b.as_of desc, b.id desc limit 1) c on true where c.found is null or c.current_minor is distinct from a.current_minor or c.available_minor is distinct from a.available_minor or c.limit_minor is distinct from a.limit_minor or c.currency is distinct from a.currency or c.snapshot_metadata is distinct from a.snapshot_metadata")" 0

echo
echo "=== 2. re-runnable ==="
OUT="$(apply good "$MIGRATION")"
echo "$OUT" | grep -E 'NOTICE|ERROR' | sed 's/^/    /'
expect "second apply leaves the row count alone" "$(q good 'select count(*) from public.balance_snapshots')" 18
expect "second apply writes no second audit row" \
  "$(q good "select count(*) from public.audit_log where action='balance_snapshots.compact'")" 1
expect "second apply does not re-archive" \
  "$(q good 'select count(*) from keel_archive.balance_snapshots_20260831')" 25

echo
echo "=== 3. abort is atomic: a precondition failure changes nothing ==="
TIE="$TMP/tie.sql"
printf "%s\n" \
  "insert into public.balance_snapshots (household_id, account_id, as_of, available_minor, current_minor, limit_minor, currency, source, snapshot_metadata, created_at)" \
  "select household_id, account_id, as_of, available_minor, current_minor, limit_minor, currency, source, snapshot_metadata, created_at" \
  "  from public.balance_snapshots order by as_of limit 1;" > "$TIE"
fresh_db tie "$TIE"
OUT="$(apply tie "$MIGRATION" || true)"
echo "$OUT" | grep -E 'ERROR|DETAIL' | head -2 | sed 's/^/    /'
expect "aborted on the as_of tie" \
  "$(echo "$OUT" | grep -c 'KEEL_COMPACTION_ABORT: 1 as_of ties' || true)" 1
expect "every row still present after the abort" "$(q tie 'select count(*) from public.balance_snapshots')" 26
# The precondition is checked in BOTH statements, so a tie is caught before the
# archive statement creates anything at all.
expect "no archive left behind after the abort" \
  "$(q tie "select coalesce(to_regclass('keel_archive.balance_snapshots_20260831')::text,'none')")" none

echo
echo "=== 3b. the removal statement refuses to run without an archive ==="
SECOND="$TMP/second_only.sql"
python3 - "$MIGRATION" "$SECOND" <<'PY'
import sys
# Everything from the third `do` block onwards: the removal on its own.
s = open(sys.argv[1]).read()
open(sys.argv[2], 'w').write(s[s.index('do $compact$'):])
PY
fresh_db noarchive
OUT="$(apply noarchive "$SECOND" || true)"
expect "removal refuses without an archive" \
  "$(echo "$OUT" | grep -c 'no archive; run the archive statement first' || true)" 1
expect "and removed nothing" "$(q noarchive 'select count(*) from public.balance_snapshots')" 25

# ...and refuses with an archive but no plan, so the gate can never be skipped.
PLANLESS="$TMP/planless.sql"
python3 - "$MIGRATION" "$PLANLESS" <<'PY'
import sys
s = open(sys.argv[1]).read()
# The archive statement, then the removal statement, with the plan step (and
# therefore the whole equivalence gate) omitted.
open(sys.argv[2], 'w').write(
    s[s.index('do $archive$'):s.index('do $plan$')] + s[s.index('do $compact$'):])
PY
fresh_db noplan
OUT="$(apply noplan "$PLANLESS" || true)"
expect "removal refuses without a plan (the gate cannot be skipped)" \
  "$(echo "$OUT" | grep -c 'no plan; run the plan statement first' || true)" 1
expect "and removed nothing" "$(q noplan 'select count(*) from public.balance_snapshots')" 25
expect "though the before-image was still taken" \
  "$(q noplan 'select count(*) from keel_archive.balance_snapshots_20260831')" 25

if [ "$MUTATE" != "1" ]; then
  echo
  [ "$FAILED" = 0 ] && echo "=== RESULT: PASS === (re-run with --mutate to break the predicate on purpose)" \
                    || { echo "=== RESULT: FAIL ==="; exit 1; }
  exit 0
fi

# ---------------------------------------------------------------------------
# 4. Break the survivor predicate. The migration must refuse to commit.
# ---------------------------------------------------------------------------
echo
echo "=== 4. mutating the survivor predicate ==="
mutate() { # mutate <name> <python-file>
  local mfile="$TMP/mut.sql" out
  if ! python3 "$2" "$MIGRATION" "$mfile"; then
    echo "MUTATION '$1': FAILED TO APPLY"; FAILED=1; return
  fi
  cmp -s "$MIGRATION" "$mfile" && { echo "MUTATION '$1': did not change the file"; FAILED=1; return; }
  fresh_db mut
  out="$(apply mut "$mfile" || true)"
  if ! echo "$out" | grep -q 'KEEL_COMPACTION_ABORT'; then
    echo "MUTATION '$1': COMMITTED with a broken predicate -- the gate is not load-bearing"
    echo "$out" | tail -3 | sed 's/^/    /'; FAILED=1; return
  fi
  # The archive statement commits before the removal statement runs, so after
  # a rejected removal the archive is expected to EXIST and hold the complete
  # before-image, while the table itself is untouched. That is the safe way
  # round: an archive without a removal costs disk, a removal without an
  # archive costs the data.
  local rows arch audit
  rows="$(q mut 'select count(*) from public.balance_snapshots')"
  arch="$(q mut 'select count(*) from keel_archive.balance_snapshots_20260831')"
  audit="$(q mut "select count(*) from public.audit_log where action='balance_snapshots.compact'")"
  if [ "$rows" != "25" ] || [ "$arch" != "25" ] || [ "$audit" != "0" ]; then
    echo "MUTATION '$1': aborted but NOT atomically (rows=$rows archive=$arch audit=$audit)"; FAILED=1; return
  fi
  echo "MUTATION '$1': refused and rolled back cleanly"
  echo "$out" | grep -o 'KEEL_COMPACTION_ABORT[^"]*' | head -1 | sed 's/^/    /'
}

cat > "$TMP/p1.py" <<'PY'
import sys
# Stop keeping the newest row of each series unconditionally.
s = open(sys.argv[1]).read()
old = """         (o.rn_asc = 1
          or o.rn_desc = 1
          or not ("""
new = """         (o.rn_asc = 1
          or not ("""
assert s.count(old) == 1
open(sys.argv[2], 'w').write(s.replace(old, new))
PY
mutate "newest row of a series no longer kept" "$TMP/p1.py"

cat > "$TMP/p2.py" <<'PY'
import sys
# Stop treating snapshot_metadata as information.
s = open(sys.argv[1]).read()
old = """           and o.snapshot_metadata is not distinct from '{}'::jsonb
           and o.p_meta            is not distinct from '{}'::jsonb
         )) as is_surv,"""
assert s.count(old) == 1
open(sys.argv[2], 'w').write(s.replace(old, "         )) as is_surv,"))
PY
mutate "snapshot_metadata dropped from the dedupe key" "$TMP/p2.py"

cat > "$TMP/p3.py" <<'PY'
import sys
# The `=` vs `is not distinct from` trap.
s = open(sys.argv[1]).read()
head, sep, tail = s.partition(')) as is_surv,')
assert sep
open(sys.argv[2], 'w').write(head.replace('is not distinct from', '=') + sep + tail)
PY
mutate "null-unsafe dedupe key (= instead of is not distinct from)" "$TMP/p3.py"

cat > "$TMP/p4.py" <<'PY'
import sys
# Keep only the endpoints of each series: mid-series value changes are lost.
s = open(sys.argv[1]).read()
start = s.index('         (o.rn_asc = 1\n          or o.rn_desc = 1')
end = s.index(')) as is_surv,')
open(sys.argv[2], 'w').write(
    s[:start] + '         (o.rn_asc = 1 or o.rn_desc = 1 or (false\n' + s[end:])
PY
mutate "only the first and newest rows kept (value changes dropped)" "$TMP/p4.py"

cat > "$TMP/p5.py" <<'PY'
import sys
# Ignore `source`, so the two series on account 'a' are folded into one.
s = open(sys.argv[1]).read()
old = """    window w_asc  as (partition by bs.household_id, bs.account_id, bs.source order by bs.as_of asc,  bs.id asc),
           w_desc as (partition by bs.household_id, bs.account_id, bs.source order by bs.as_of desc, bs.id desc)"""
new = """    window w_asc  as (partition by bs.household_id, bs.account_id order by bs.as_of asc,  bs.id asc),
           w_desc as (partition by bs.household_id, bs.account_id order by bs.as_of desc, bs.id desc)"""
assert s.count(old) == 1
open(sys.argv[2], 'w').write(s.replace(old, new))
PY
mutate "series partitioned by account only, ignoring source" "$TMP/p5.py"


# ---------------------------------------------------------------------------
# 5. Scale. The first live attempt exceeded the 60 s client ceiling and was
#    killed (it rolled back cleanly, which is the design working, but it did
#    not finish). Two shapes were responsible and neither is visible at 25
#    rows: a `where id = any(<186,810-element array>)` removal, and a
#    `left join lateral (... limit 1)` verification doing one index probe per
#    archived row at the exact moment the index still physically holds every
#    entry the same statement just removed. Both are now set-based, and this
#    step exists so a future edit cannot quietly reintroduce either.
# ---------------------------------------------------------------------------
echo
echo "=== 5. scale: production-shaped volume ==="
SCALE="$TMP/scale.sql"
cat > "$SCALE" <<'BULK'
-- 16 accounts x 12,000 cycles, the live shape: a value that moves rarely and
-- is otherwise reconfirmed every 3 minutes. ~99.9% of rows are repeats, and
-- roughly a third of the accounts report a null available/limit, which is what
-- makes the NULL-safe comparison load-bearing at this size too.
insert into public.balance_snapshots
  (household_id, account_id, as_of, available_minor, current_minor, limit_minor,
   currency, source, snapshot_metadata, created_at)
select '00000000-0000-4000-8000-000000000001',
       ('00000000-0000-4000-8000-0000000001' || lpad(a::text, 2, '0'))::uuid,
       timestamptz '2026-01-01T00:00:00Z' + (c * 3 || ' minutes')::interval,
       case when a % 3 = 0 then null else 1000 + a * 100 + (c / 4000) end,
       50000 + a * 1000 + (c / 4000) * 7,
       case when a % 2 = 0 then null else 900000 end,
       'USD', 'plaid', '{}'::jsonb,
       timestamptz '2026-01-01T00:00:00Z' + (c * 3 || ' minutes')::interval
  from generate_series(1, 16) a, generate_series(1, 12000) c;
create index on public.balance_snapshots (household_id, account_id, as_of);
analyze public.balance_snapshots;
BULK
fresh_db scale "$SCALE"
SCALE_ROWS="$(q scale 'select count(*) from public.balance_snapshots')"
START=$(date +%s)
OUT="$(apply scale "$MIGRATION" || true)"
ELAPSED=$(( $(date +%s) - START ))
echo "$OUT" | grep -E 'NOTICE|ERROR' | sed 's/^/    /'
expect "scale run committed"        "$(echo "$OUT" | grep -c 'KEEL_COMPACTION_ABORT' || true)" 0
expect "scale rows archived"        "$(q scale 'select count(*) from keel_archive.balance_snapshots_20260831')" "$SCALE_ROWS"
expect "scale: step function preserved for every original instant" \
  "$(q scale "with i as (select household_id,account_id,source,as_of,id,current_minor,available_minor,limit_minor,currency,snapshot_metadata,false is_live from keel_archive.balance_snapshots_20260831 union all select household_id,account_id,source,as_of,id,current_minor,available_minor,limit_minor,currency,snapshot_metadata,true from public.balance_snapshots), s as (select i.*, row_number() over (partition by household_id,account_id,source order by as_of,id,is_live desc) rn from i), g as (select s.*, max(case when s.is_live then s.rn end) over (partition by s.household_id,s.account_id,s.source order by s.rn rows between unbounded preceding and current row) gov_rn from s) select count(*) from g a left join g c on c.household_id=a.household_id and c.account_id=a.account_id and c.source=a.source and c.rn=a.gov_rn where not a.is_live and (c.rn is null or c.current_minor is distinct from a.current_minor or c.available_minor is distinct from a.available_minor or c.limit_minor is distinct from a.limit_minor or c.currency is distinct from a.currency or c.snapshot_metadata is distinct from a.snapshot_metadata)")" 0
echo "  ..  ${SCALE_ROWS} rows -> $(q scale 'select count(*) from public.balance_snapshots') survivors in ${ELAPSED}s"
if [ "$ELAPSED" -gt 60 ]; then
  echo "  FAIL scale run took ${ELAPSED}s, over the 60s client ceiling that killed the first live attempt"
  FAILED=1
else
  echo "  ok   scale run inside the 60s client ceiling (${ELAPSED}s)"
fi

echo
if [ "$FAILED" = 1 ]; then echo "=== RESULT: FAIL ==="; exit 1; fi
echo "=== RESULT: PASS (correct on good data, atomic on every abort, refuses every broken predicate, finishes at production volume) ==="
