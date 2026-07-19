#!/usr/bin/env bash
# Throwaway-Postgres validation for the archived-account reconnect dedupe +
# superseded-account auto-archive (20260719210000_dedupe_archived_duplicates.sql).
# Same pattern as run-finalize-entity-pgtap.sh / run-networth-archived-pgtap.sh:
# initdb a temporary cluster, build the minimal real schema from the test file,
# load the REAL shared command helpers (sliced verbatim from 20260710210600) and
# the REAL migration file, and run tests/pgtap/dedupe_archived_duplicates.sql.
#
# pgTAP is not bundled with a vanilla PG install; if the extension is missing we
# fall back to a tiny shim that implements plan()/is()/finish() with the same
# TAP output, so the same test file runs either way.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HELPERS_MIGRATION="$ROOT/supabase/migrations/20260710210600_command_procs.sql"
MIGRATION="$ROOT/supabase/migrations/20260719210000_dedupe_archived_duplicates.sql"
TESTSQL="$ROOT/tests/pgtap/dedupe_archived_duplicates.sql"

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

# Roles the migration's owner/grant statements reference.
"${PSQL[@]}" -c "do \$\$ begin
  if not exists (select 1 from pg_roles where rolname='keel_api') then create role keel_api nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin; end if;
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
end \$\$;" >/dev/null
"${PSQL[@]}" -c "grant keel_api to postgres;" >/dev/null

# Slice the REAL shared command helpers out of 20260710210600 so the command
# under test runs against the shipped auth/idempotency/audit plumbing, not a
# paraphrase. Each block runs from its "create function" line to the first
# terminating "$$;" line.
HELPERS="$TMP/helpers.sql"
: > "$HELPERS"
for fn in keel_actor_from_jwt keel_assert_member_write keel_idempotency_check keel_payload_hash keel_finish_command; do
  awk "/create function public\\.$fn/{f=1} f{print} f && /^\\\$\\\$;\$/{exit}" \
    "$HELPERS_MIGRATION" >> "$HELPERS"
  if ! grep -q "public.$fn" "$HELPERS"; then
    echo "FATAL: could not slice $fn from $HELPERS_MIGRATION"; exit 1
  fi
  printf '\n' >> "$HELPERS"
done
echo "sliced $(wc -l < "$HELPERS") lines of shared helper DDL from 20260710210600"

# Render the test: inject the real helper DDL and the real migration file at
# their markers.
RENDERED="$TMP/rendered.sql"
python3 - "$TESTSQL" "$HELPERS" "$MIGRATION" "$RENDERED" <<'PY'
import sys
test, helpers, migration, out = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
src = open(test).read()
h_marker = '-- __SHARED_HELPERS__  (replaced by the runner with the real 20260710210600 helper DDL)'
m_marker = '-- __MIGRATION_BODY__  (replaced by the runner with the real migration file)'
assert h_marker in src, 'helpers marker missing'
assert m_marker in src, 'migration marker missing'
src = src.replace(h_marker, open(helpers).read())
src = src.replace(m_marker, open(migration).read())
open(out, 'w').write(src)
PY

# pgTAP shim (plan/is/finish -> TAP) unless the real extension is available.
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
create or replace function public.is(got text, want text, name text) returns setof text language plpgsql as $$
declare ok boolean := got is not distinct from want; r int;
begin update _tap.state set ran=ran+1 where true returning ran into r;
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

echo "=== running tests/pgtap/dedupe_archived_duplicates.sql ==="
OUT="$("${PSQL[@]}" -tAf "$RENDERED")"
echo "$OUT"
if echo "$OUT" | grep -q '^not ok'; then
  echo "=== RESULT: FAIL ==="; exit 1
fi
echo "=== RESULT: PASS ==="
