#!/usr/bin/env bash
# Throwaway-Postgres validation for business expense attribution, layer 1
# (20260831120000_business_entity_tag.sql).
#
# Same shape as scripts/run-finalize-entity-pgtap.sh: the Supabase local Docker
# stack is unavailable in this environment, so we initdb a temporary cluster,
# build the minimal schema the migration touches (in the test file), and load
# the REAL SQL that ships:
#   - keel_assert_member_write, sliced verbatim out of 20260710210600, so the
#     role gating under test is the shipped gate, not a stub;
#   - the ENTIRE migration file, verbatim.
# So these tests exercise the exact DDL that will be applied to the project.
#
# pgTAP is not bundled with a vanilla PG install; if the extension is missing we
# fall back to a tiny shim implementing plan()/is()/finish() with the same TAP
# output, so the same test file runs either way. The suite deliberately uses
# only plan/is/finish (error cases go through its own _try helper) so both
# paths assert identically.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MIGRATION="$ROOT/supabase/migrations/20260831120000_business_entity_tag.sql"
COMMANDS="$ROOT/supabase/migrations/20260710210600_command_procs.sql"
TESTSQL="$ROOT/tests/pgtap/business_entity_tag.sql"

for f in "$MIGRATION" "$COMMANDS" "$TESTSQL"; do
  [ -f "$f" ] || { echo "FATAL: missing $f"; exit 1; }
done

PGBIN="$(dirname "$(command -v initdb || echo /usr/lib/postgresql/16/bin/initdb)")"
[ -x "$PGBIN/initdb" ] || { echo "FATAL: initdb not found (install postgresql)"; exit 1; }

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

# Roles the migration's grant/revoke statements reference.
"${PSQL[@]}" -c "do \$\$ begin
  if not exists (select 1 from pg_roles where rolname='keel_api') then create role keel_api nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin; end if;
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
end \$\$;" >/dev/null

# Slice the real keel_assert_member_write DDL out of the commands migration.
MEMBERWRITE="$TMP/member_write.sql"
awk '/^create function public.keel_assert_member_write/{f=1}
     f{print}
     f && /^\$\$;$/{exit}' "$COMMANDS" > "$MEMBERWRITE"
grep -q keel_assert_member_write "$MEMBERWRITE" \
  || { echo "FATAL: could not slice keel_assert_member_write from $COMMANDS"; exit 1; }
echo "sliced $(wc -l < "$MEMBERWRITE") lines of keel_assert_member_write from the real migration"
echo "loading $(wc -l < "$MIGRATION") lines of migration verbatim"

RENDERED="$TMP/rendered.sql"
python3 - "$TESTSQL" "$MEMBERWRITE" "$MIGRATION" "$RENDERED" <<'PY'
import sys
test, member, migration, out = sys.argv[1:5]
src = open(test).read()
markers = {
    '-- __MEMBER_WRITE_BODY__  (replaced by the runner with the real function DDL)': open(member).read(),
    '-- __MIGRATION_BODY__  (replaced by the runner with the real migration file)': open(migration).read(),
}
for marker, body in markers.items():
    if marker not in src:
        raise SystemExit(f'FATAL: marker not found in test file: {marker}')
    src = src.replace(marker, body)
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
  elsif s.ran <> s.total then return next '# FAILED plan said '||s.total||' but '||s.ran||' ran';
  else return next '# all '||s.ran||' passed'; end if; end $$;
SHIM
fi

echo "=== running tests/pgtap/business_entity_tag.sql ==="
OUT="$("${PSQL[@]}" -tAf "$RENDERED")"
echo "$OUT"
if echo "$OUT" | grep -qE '^not ok|^# FAILED'; then
  echo "=== RESULT: FAIL ==="; exit 1
fi
echo "=== RESULT: PASS ==="
