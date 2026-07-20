#!/usr/bin/env bash
# Throwaway-Postgres validation for the recurring dismissal-durable fix
# (20260722010000_recurring_dismissal_durable.sql). Mirrors
# run-dedupe-archived-pgtap.sh: initdb a temp cluster, build the minimal real
# schema (in the test file), slice the REAL keel_payload_hash helper from
# 20260710210600, inject the REAL fix migration, run tests/pgtap/
# recurring_dismissal_durable.sql. A tiny TAP shim stands in for pgTAP when the
# extension is absent (only plan/ok/is/finish are used).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HELPERS_MIGRATION="$ROOT/supabase/migrations/20260710210600_command_procs.sql"
MIGRATION="$ROOT/supabase/migrations/20260722010000_recurring_dismissal_durable.sql"
TESTSQL="$ROOT/tests/pgtap/recurring_dismissal_durable.sql"

PGBIN="$(dirname "$(command -v initdb)")"
TMP="$(mktemp -d)"
DATADIR="$TMP/data"
SOCK="$TMP/sock"
mkdir -p "$SOCK"
cleanup() { "$PGBIN/pg_ctl" -D "$DATADIR" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT

echo "initdb throwaway cluster in $DATADIR"
"$PGBIN/initdb" -D "$DATADIR" -U postgres --auth=trust >/dev/null
"$PGBIN/pg_ctl" -D "$DATADIR" -o "-k $SOCK -c listen_addresses=''" -w start >/dev/null
PSQL=("$PGBIN/psql" -X -v ON_ERROR_STOP=1 -h "$SOCK" -U postgres -d postgres)

# Slice the real keel_payload_hash (only shared helper this function calls).
HELPERS="$TMP/helpers.sql"
awk "/create function public\\.keel_payload_hash/{f=1} f{print} f && /^\\\$\\\$;\$/{exit}" \
  "$HELPERS_MIGRATION" > "$HELPERS"
grep -q "public.keel_payload_hash" "$HELPERS" || { echo "FATAL: could not slice keel_payload_hash"; exit 1; }
echo "sliced $(wc -l < "$HELPERS") lines of keel_payload_hash from 20260710210600"

# Render: inject helper DDL + migration at their markers.
RENDERED="$TMP/rendered.sql"
python3 - "$TESTSQL" "$HELPERS" "$MIGRATION" "$RENDERED" <<'PY'
import sys
test, helpers, migration, out = sys.argv[1:5]
src = open(test).read()
h = '-- __SHARED_HELPERS__  (replaced by the runner with the real keel_payload_hash DDL)'
m = '-- __MIGRATION_BODY__  (replaced by the runner with the real fix migration file)'
assert h in src, 'helpers marker missing'
assert m in src, 'migration marker missing'
src = src.replace(h, open(helpers).read())
src = src.replace(m, open(migration).read())
open(out, 'w').write(src)
PY

# pgTAP shim (plan/ok/is/finish) unless the real extension is available.
if "${PSQL[@]}" -tAc "select 1 from pg_available_extensions where name='pgtap'" | grep -q 1; then
  echo "using real pgTAP extension"
  "${PSQL[@]}" -c "create extension if not exists pgtap;" >/dev/null
else
  echo "pgTAP unavailable -> loading minimal TAP shim"
  "${PSQL[@]}" >/dev/null <<'SHIM'
create schema if not exists _tap;
create table _tap.state(total int, ran int default 0, failed int default 0);
create or replace function public.plan(n int) returns setof text language plpgsql as $$
begin delete from _tap.state; insert into _tap.state(total) values(n);
  return next '1..'||n; end $$;
create or replace function public.ok(b boolean, name text) returns setof text language plpgsql as $$
declare r int;
begin update _tap.state set ran=ran+1 returning ran into r;
  if coalesce(b,false) then return next 'ok '||r||' - '||name;
  else update _tap.state set failed=failed+1; return next 'not ok '||r||' - '||name; end if; end $$;
create or replace function public.is(got text, want text, name text) returns setof text language plpgsql as $$
declare ok boolean := got is not distinct from want; r int;
begin update _tap.state set ran=ran+1 returning ran into r;
  if ok then return next 'ok '||r||' - '||name;
  else update _tap.state set failed=failed+1;
    return next 'not ok '||r||' - '||name;
    return next '# got: '||coalesce(got,'<null>');
    return next '# want: '||coalesce(want,'<null>');
  end if; end $$;
create or replace function public.finish() returns setof text language plpgsql as $$
declare s _tap.state;
begin select * into s from _tap.state;
  if s.failed > 0 then return next '# FAILED '||s.failed||' of '||s.ran;
  else return next '# all '||s.ran||' passed'; end if; end $$;
SHIM
fi

echo "=== running tests/pgtap/recurring_dismissal_durable.sql ==="
OUT="$("${PSQL[@]}" -tAf "$RENDERED")"
echo "$OUT"
if echo "$OUT" | grep -q '^not ok'; then
  echo "=== RESULT: FAIL ==="; exit 1
fi
echo "=== RESULT: PASS ==="
