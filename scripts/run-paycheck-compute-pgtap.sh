#!/usr/bin/env bash
# Throwaway-Postgres validation for the SLICE-D gross-up MATH parity
# (20260722300000_paycheck_apply_template.sql keel_paycheck_template_compute;
#  docs/harness/plans/paycheck-split-templates-v2.md §D4). Same pattern as
# run-approval-tokens-pgtap.sh: initdb a temporary cluster, slice ONLY the
# keel_paycheck_template_compute create-function body from the real migration,
# inject it at the __MIGRATION_COMPUTE__ marker in the test, and run pgTAP.
# pgTAP shim used if the extension is unavailable.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MIGRATION="$ROOT/supabase/migrations/20260722300000_paycheck_apply_template.sql"
TESTSQL="$ROOT/tests/pgtap/paycheck_template_compute.sql"

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

# Slice ONLY the keel_paycheck_template_compute create-function body (from its
# "create function" line through the first terminating "$$;" line).
COMPUTE="$TMP/compute.sql"
awk '/create function public\.keel_paycheck_template_compute/{f=1} f{print} f && /^\$\$;$/{exit}' \
  "$MIGRATION" > "$COMPUTE"
if ! grep -q 'public.keel_paycheck_template_compute' "$COMPUTE"; then
  echo "FATAL: could not slice keel_paycheck_template_compute from $MIGRATION"; exit 1
fi
# Drop the SECURITY DEFINER (no keel_api role in the throwaway cluster).
sed -i.bak 's/security definer//' "$COMPUTE" && rm -f "$COMPUTE.bak"
echo "sliced $(wc -l < "$COMPUTE") lines of compute DDL"

RENDERED="$TMP/rendered.sql"
python3 - "$TESTSQL" "$COMPUTE" "$RENDERED" <<'PY'
import sys
test, compute, out = sys.argv[1], sys.argv[2], sys.argv[3]
src = open(test).read()
marker = '-- __MIGRATION_COMPUTE__'
assert marker in src, 'marker not found'
src = src.replace(marker, open(compute).read())
open(out, 'w').write(src)
PY

if "${PSQL[@]}" -tAc "select 1 from pg_available_extensions where name='pgtap'" | grep -q 1; then
  echo "using real pgTAP extension"
  "${PSQL[@]}" -c "create extension if not exists pgtap;" >/dev/null
else
  echo "pgTAP unavailable -> loading minimal TAP shim"
  "${PSQL[@]}" >/dev/null <<'SHIM'
create schema if not exists _tap;
grant usage on schema _tap to public;
create table _tap.state(total int, ran int default 0, failed int default 0);
grant all on _tap.state to public;
create or replace function public.plan(n int) returns setof text language plpgsql as $$
begin delete from _tap.state; insert into _tap.state(total) values(n); return next '1..'||n; end $$;
create or replace function _tap.pass(name text) returns setof text language plpgsql as $$
declare r int; begin update _tap.state set ran=ran+1 returning ran into r; return next 'ok '||r||' - '||name; end $$;
create or replace function _tap.fail(name text, diag text default null) returns setof text language plpgsql as $$
declare r int; begin update _tap.state set ran=ran+1, failed=failed+1 returning ran into r;
  return next 'not ok '||r||' - '||name; if diag is not null then return next '# '||diag; end if; end $$;
create or replace function public.ok(b boolean, name text) returns setof text language plpgsql as $$
begin if b then return query select * from _tap.pass(name); else return query select * from _tap.fail(name); end if; end $$;
create or replace function public.is(got text, want text, name text) returns setof text language plpgsql as $$
begin if got is not distinct from want then return query select * from _tap.pass(name);
  else return query select * from _tap.fail(name, 'got: '||coalesce(got,'<null>')||' want: '||coalesce(want,'<null>')); end if; end $$;
create or replace function public.throws_ok(sql text, code text, msg text, name text) returns setof text language plpgsql as $$
begin execute sql; return query select * from _tap.fail(name, 'did not throw');
exception when others then
  if code is null or sqlstate = code then return query select * from _tap.pass(name);
  else return query select * from _tap.fail(name, 'threw '||sqlstate||' expected '||code); end if; end $$;
create or replace function public.finish() returns setof text language plpgsql as $$
declare s _tap.state; begin select * into s from _tap.state;
  if s.failed > 0 then return next '# FAILED '||s.failed||' of '||s.ran;
  else return next '# all '||s.ran||' passed'; end if; end $$;
grant execute on all functions in schema _tap to public;
SHIM
fi

echo "=== running tests/pgtap/paycheck_template_compute.sql ==="
OUT="$("${PSQL[@]}" -tAf "$RENDERED")"
echo "$OUT"
if echo "$OUT" | grep -q '^not ok'; then
  echo "=== RESULT: FAIL ==="; exit 1
fi
echo "=== RESULT: PASS ==="
