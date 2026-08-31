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
IDEMPOTENT="$TMP/idempotent.sql"
python3 - "$TESTSQL" "$MEMBERWRITE" "$MIGRATION" "$RENDERED" "$IDEMPOTENT" <<'PY'
import sys
test, member, migration, out, idem = sys.argv[1:6]
src = open(test).read()
member_marker = '-- __MEMBER_WRITE_BODY__  (replaced by the runner with the real function DDL)'
migration_marker = '-- __MIGRATION_BODY__  (replaced by the runner with the real migration file)'
member_body, migration_body = open(member).read(), open(migration).read()
for marker in (member_marker, migration_marker):
    if marker not in src:
        raise SystemExit('FATAL: marker not found in test file: ' + marker)
open(out, 'w').write(src.replace(member_marker, member_body).replace(migration_marker, migration_body))

# Re-runnability probe: the minimal schema (everything the test file declares
# before the injection point), then the migration applied TWICE. CLAUDE.md
# applies migrations by hand to the live project with no migration-history
# table, so a file that errors on a second apply is a production hazard.
prelude = src.split(member_marker)[0]
prelude = chr(10).join(
    line for line in prelude.splitlines()
    if line.strip() != 'begin;' and not line.strip().startswith('select plan(')
)
open(idem, 'w').write(prelude + member_body + migration_body + migration_body)
PY

echo "=== re-runnability: applying the migration twice ==="
"$PGBIN/createdb" -h "$SOCK" -U postgres idempotency_probe >/dev/null
if ! "$PGBIN/psql" -X -v ON_ERROR_STOP=1 -h "$SOCK" -U postgres -d idempotency_probe \
     -f "$IDEMPOTENT" >"$TMP/idem.log" 2>&1; then
  echo "=== RESULT: FAIL (migration is not re-runnable) ==="
  tail -20 "$TMP/idem.log"
  exit 1
fi
echo "second apply clean ($(grep -c 'already exists, skipping' "$TMP/idem.log") guarded objects skipped)"

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
