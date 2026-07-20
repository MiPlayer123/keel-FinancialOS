#!/usr/bin/env bash
# Throwaway-Postgres validation for keel_cmd_documents_attach
# (20260723000000_documents_attach_existing_and_storage_summary.sql). Mirrors
# run-recurring-dismissal-durable-pgtap.sh: initdb a temp cluster, load the
# minimal schema + helper stubs (in the test file), slice the REAL attach proc
# body from the migration, inject it at the marker, run tests/pgtap/
# documents_attach_existing.sql. A tiny TAP shim (plan/ok/is/throws_ok/finish)
# stands in for pgTAP when the extension is absent.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MIGRATION="$ROOT/supabase/migrations/20260723000000_documents_attach_existing_and_storage_summary.sql"
TESTSQL="$ROOT/tests/pgtap/documents_attach_existing.sql"

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

# Slice the REAL keel_cmd_documents_attach body from the migration (create
# function ... up to its closing $$;). The other objects in the migration
# (list_household / storage_summary / grants referencing keel_api) are not
# needed for this proc's behavioral test and are skipped.
PROC="$TMP/attach_proc.sql"
awk "/create function public\\.keel_cmd_documents_attach/{f=1} f{print} f && /^\\\$\\\$;\$/{exit}" \
  "$MIGRATION" > "$PROC"
grep -q "public.keel_cmd_documents_attach" "$PROC" || { echo "FATAL: could not slice attach proc"; exit 1; }
# Neutralize SECURITY DEFINER for the throwaway single-role cluster.
sed -i.bak 's/^security definer$/security invoker/' "$PROC" && rm -f "$PROC.bak"
echo "sliced $(wc -l < "$PROC") lines of keel_cmd_documents_attach from the migration"

RENDERED="$TMP/rendered.sql"
python3 - "$TESTSQL" "$PROC" "$RENDERED" <<'PY'
import sys
test, proc, out = sys.argv[1:4]
src = open(test).read()
m = '-- __MIGRATION_ATTACH_PROC__  (replaced by the runner with the REAL proc body)'
assert m in src, 'migration marker missing'
open(out, 'w').write(src.replace(m, open(proc).read()))
PY

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
-- throws_ok(sql, errcode, errmsg, name): passes when the statement raises the
-- expected SQLSTATE (errmsg is ignored by this shim; pass null).
create or replace function public.throws_ok(sql text, code text, msg text, name text)
  returns setof text language plpgsql as $$
declare r int; got text;
begin update _tap.state set ran=ran+1 returning ran into r;
  begin execute sql; got := null;
  exception when others then got := SQLSTATE; end;
  if got is not distinct from code then return next 'ok '||r||' - '||name;
  else update _tap.state set failed=failed+1;
    return next 'not ok '||r||' - '||name;
    return next '# got sqlstate: '||coalesce(got,'<none — did not throw>');
    return next '# want sqlstate: '||coalesce(code,'<null>');
  end if; end $$;
create or replace function public.finish() returns setof text language plpgsql as $$
declare s _tap.state;
begin select * into s from _tap.state;
  if s.failed > 0 then return next '# FAILED '||s.failed||' of '||s.ran;
  else return next '# all '||s.ran||' passed'; end if; end $$;
SHIM
fi

echo "=== running tests/pgtap/documents_attach_existing.sql ==="
OUT="$("${PSQL[@]}" -tAf "$RENDERED")"
echo "$OUT"
if echo "$OUT" | grep -q '^not ok'; then
  echo "=== RESULT: FAIL ==="; exit 1
fi
echo "=== RESULT: PASS ==="
