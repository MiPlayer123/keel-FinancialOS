#!/usr/bin/env bash
# Validates the phase 2 equivalence gate itself
# (scripts/audit/balance-snapshot-compaction-gate.sql).
#
# The gate is what authorises deleting 186k rows from a Free-tier project with
# no PITR. A gate that cannot fail is worth nothing, so before it is pointed at
# production it is run here against a throwaway Postgres holding a fixture
# table built to exercise every branch of the survivor predicate, and then run
# again against four deliberately broken predicates, each of which it must
# catch.
#
# The gate file is loaded VERBATIM. The mutations edit only the `is_surv`
# expression, never the checks, so a mutated run cannot make itself
# self-consistent.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GATE="$ROOT/scripts/audit/balance-snapshot-compaction-gate.sql"
[ -f "$GATE" ] || { echo "FATAL: missing $GATE"; exit 1; }

PGBIN="$(dirname "$(command -v initdb || echo /usr/lib/postgresql/16/bin/initdb)")"
[ -x "$PGBIN/initdb" ] || { echo "FATAL: initdb not found"; exit 1; }

TMP="$(mktemp -d)"
DATADIR="$TMP/data"; SOCK="$TMP/sock"; mkdir -p "$SOCK"
cleanup() { "$PGBIN/pg_ctl" -D "$DATADIR" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATADIR" -U postgres --auth=trust >/dev/null
"$PGBIN/pg_ctl" -D "$DATADIR" -o "-k $SOCK -c listen_addresses=''" -w start >/dev/null
PSQL=("$PGBIN/psql" -X -v ON_ERROR_STOP=1 -h "$SOCK" -U postgres -d postgres)

"${PSQL[@]}" >/dev/null <<'FIXTURE'
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

-- One helper so each fixture row reads as (series, tick, value) and the
-- created_at ordering matches the as_of ordering (the gate asserts that).
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

-- A: a plain run, then a second run. Survivors: first of each run + newest.
select public.f('a','plaid',1,100,100,null);
select public.f('a','plaid',2,100,100,null);
select public.f('a','plaid',3,100,100,null);
select public.f('a','plaid',4,200,200,null);
select public.f('a','plaid',5,200,200,null);
select public.f('a','plaid',6,200,200,null);
-- A again under a DIFFERENT source: must be its own series.
select public.f('a','statement',1,200,200,null);
select public.f('a','statement',2,200,200,null);
select public.f('a','statement',3,200,200,null);
-- B: a series of one.
select public.f('b','plaid',1,300,300,null);
-- C: nulls, ending on a real change that is also the newest row.
select public.f('c','plaid',1,100,null,null);
select public.f('c','plaid',2,100,null,null);
select public.f('c','plaid',3,100,null,5);
-- D: snapshot_metadata is information. Nothing here may be collapsed.
select public.f('d','plaid',1,100,100,null,'USD','{}'::jsonb);
select public.f('d','plaid',2,100,100,null,'USD','{"a":1}'::jsonb);
select public.f('d','plaid',3,100,100,null,'USD','{}'::jsonb);
-- E: last run has length 1, so the newest row is also a run start.
select public.f('e','plaid',1,400,400,null);
select public.f('e','plaid',2,400,400,null);
select public.f('e','plaid',3,500,500,null);
-- F: a two-row all-duplicate series -- first AND newest, nothing to delete.
select public.f('f','plaid',1,600,600,null);
select public.f('f','plaid',2,600,600,null);
-- G (account '9'): a run boundary that only a NULL-SAFE comparison can see. r2 differs from
-- r1 only by available_minor going 50 -> null, so under `=` the whole
-- comparison evaluates to NULL and r2 is misclassified.
select public.f('9','plaid',1,100,50,null);
select public.f('9','plaid',2,100,null,null);
select public.f('9','plaid',3,100,null,null);
select public.f('9','plaid',4,100,60,null);
FIXTURE

run_gate() { "${PSQL[@]}" -tA -F'|' -f "$1"; }

expect() { # expect <output> <check> <value>
  local got
  got="$(echo "$1" | awk -F'|' -v c="$2" '$1==c{print $2}')"
  if [ "$got" = "$3" ]; then
    echo "  ok   $2 = $3"
  else
    echo "  FAIL $2: got '${got:-<missing>}', want '$3'"
    return 1
  fi
}

echo "=== gate against the fixture (must be all-clear) ==="
OUT="$(run_gate "$GATE")"
echo "$OUT" | sed 's/^/    /'
echo
FAILED=0
for c in PRECOND_as_of_ties_within_a_series PRECOND_out_of_order_arrival \
         PROP1_rows_with_no_governing_survivor PROP1_step_function_differences \
         PROP2_series_lost PROP2_newest_row_of_a_series_not_kept \
         PROP3_first_observation_instants_differ; do
  expect "$OUT" "$c" 0 || FAILED=1
done
expect "$OUT" rows_total 25 || FAILED=1
expect "$OUT" survivors 18 || FAILED=1
expect "$OUT" to_delete 7 || FAILED=1
[ "$FAILED" = 0 ] || { echo "=== RESULT: FAIL (the gate is wrong about correct data) ==="; exit 1; }

# ---------------------------------------------------------------------------
# Mutations of the survivor predicate. Each must trip the named check.
# ---------------------------------------------------------------------------
mutate_gate() { # mutate_gate <python-expr-file> -> path of mutated gate
  local out="$TMP/gate_mut.sql"
  python3 "$1" "$GATE" "$out"
  cmp -s "$GATE" "$out" && { echo "  FAIL mutation did not change the gate"; return 1; }
  echo "$out"
}

check_trips() { # check_trips <name> <gate-path> <check-that-must-be-nonzero>
  local out got
  out="$(run_gate "$2" 2>&1 || true)"
  got="$(echo "$out" | awk -F'|' -v c="$3" '$1==c{print $2}')"
  if [ -n "$got" ] && [ "$got" != "0" ]; then
    echo "MUTATION '$1': correctly tripped $3 = $got"
    return 0
  fi
  echo "MUTATION '$1': $3 stayed at '${got:-<missing>}' -- the gate does not catch this"
  echo "$out" | sed 's/^/    /'
  return 1
}

echo
echo "=== mutating the survivor predicate ==="
FAILED=0

cat > "$TMP/m1.py" <<'PY'
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
check_trips "newest row of a series no longer kept" "$(mutate_gate "$TMP/m1.py")" \
  PROP2_newest_row_of_a_series_not_kept || FAILED=1

cat > "$TMP/m2.py" <<'PY'
import sys
# Stop treating snapshot_metadata as information (the audit's P2-10).
s = open(sys.argv[1]).read()
old = """           and o.snapshot_metadata is not distinct from '{}'::jsonb
           and o.p_meta            is not distinct from '{}'::jsonb
         )) as is_surv,"""
new = """         )) as is_surv,"""
assert s.count(old) == 1
open(sys.argv[2], 'w').write(s.replace(old, new))
PY
check_trips "snapshot_metadata dropped from the dedupe key" "$(mutate_gate "$TMP/m2.py")" \
  PROP1_step_function_differences || FAILED=1

cat > "$TMP/m3.py" <<'PY'
import sys
# The `=` vs `is not distinct from` trap, applied to the survivor predicate.
s = open(sys.argv[1]).read()
head, sep, tail = s.partition(')) as is_surv,')
assert sep
open(sys.argv[2], 'w').write(head.replace('is not distinct from', '=') + sep + tail)
PY
check_trips "null-unsafe dedupe key (= instead of is not distinct from)" "$(mutate_gate "$TMP/m3.py")" \
  PROP1_step_function_differences || FAILED=1

cat > "$TMP/m4.py" <<'PY'
import sys
# Keep only the endpoints of each series: every mid-series value change is lost.
s = open(sys.argv[1]).read()
start = s.index('         (o.rn_asc = 1\n          or o.rn_desc = 1')
end = s.index(')) as is_surv,')
open(sys.argv[2], 'w').write(
    s[:start] + '         (o.rn_asc = 1 or o.rn_desc = 1 or (false\n' + s[end:])
PY
check_trips "only the first and newest rows kept (value changes dropped)" "$(mutate_gate "$TMP/m4.py")" \
  PROP1_step_function_differences || FAILED=1

echo
if [ "$FAILED" = 1 ]; then
  echo "=== RESULT: FAIL (the gate does not catch a broken predicate) ==="
  exit 1
fi
echo "=== RESULT: PASS (gate is clean on correct data and trips on every break) ==="
