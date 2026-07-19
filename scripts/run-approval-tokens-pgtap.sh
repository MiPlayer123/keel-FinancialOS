#!/usr/bin/env bash
# Throwaway-Postgres validation for the approval-token SQL primitive
# (20260720100000_approval_tokens.sql; SLICE 0, statement-ingestion-v2.md).
# Same pattern as run-dedupe-archived-pgtap.sh: initdb a temporary cluster,
# build the minimal real schema from the test file, load the REAL shared
# command helpers (sliced verbatim from 20260710210600) + the REAL
# keel_recurring_account_access (sliced from 20260712120000) and the REAL
# migration file, and run tests/pgtap/approval_tokens.sql.
#
# pgTAP is not bundled with a vanilla PG install; if the extension is missing we
# fall back to a tiny shim implementing plan()/is()/ok()/lives_ok()/throws_ok()/
# has_table()/has_function()/finish() with the same TAP output.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HELPERS_MIGRATION="$ROOT/supabase/migrations/20260710210600_command_procs.sql"
RECURRING_MIGRATION="$ROOT/supabase/migrations/20260712120000_recurring.sql"
MIGRATION="$ROOT/supabase/migrations/20260720100000_approval_tokens.sql"
TESTSQL="$ROOT/tests/pgtap/approval_tokens.sql"

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

# Roles the migration's owner/grant statements reference (also created inside
# the test transaction for idempotency; created here too so grants outside the
# txn resolve).
"${PSQL[@]}" -c "do \$\$ begin
  if not exists (select 1 from pg_roles where rolname='keel_api') then create role keel_api nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin; end if;
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='keel_export') then create role keel_export nologin; end if;
end \$\$;" >/dev/null
"${PSQL[@]}" -c "grant keel_api to postgres; grant keel_export to postgres;" >/dev/null

# Slice the REAL shared helpers so the primitive runs against the shipped
# auth/idempotency/audit plumbing, not a paraphrase. Each block runs from its
# "create function" line to the first terminating "$$;" line.
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
# keel_recurring_account_access lives in the recurring migration.
awk "/create function public\\.keel_recurring_account_access/{f=1} f{print} f && /^\\\$\\\$;\$/{exit}" \
  "$RECURRING_MIGRATION" >> "$HELPERS"
if ! grep -q "public.keel_recurring_account_access" "$HELPERS"; then
  echo "FATAL: could not slice keel_recurring_account_access from $RECURRING_MIGRATION"; exit 1
fi
printf '\n' >> "$HELPERS"
echo "sliced $(wc -l < "$HELPERS") lines of shared helper DDL"

# Render the test: inject the real helper DDL + the real migration at markers.
RENDERED="$TMP/rendered.sql"
python3 - "$TESTSQL" "$HELPERS" "$MIGRATION" "$RENDERED" <<'PY'
import sys
test, helpers, migration, out = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
src = open(test).read()
h_marker = '-- __SHARED_HELPERS__'
m_marker = '-- __MIGRATION_BODY__'
def replace_line(src, marker, payload):
    lines = src.splitlines(keepends=True)
    for i, ln in enumerate(lines):
        if ln.lstrip().startswith(marker):
            # replace from this line up to the next blank line boundary of the comment block
            j = i
            while j < len(lines) and lines[j].strip():  # consume the wrapped comment lines
                j += 1
            lines[i:j] = [payload]
            return ''.join(lines)
    raise AssertionError(f'{marker} not found')
src = replace_line(src, h_marker, open(helpers).read())
src = replace_line(src, m_marker, open(migration).read())
open(out, 'w').write(src)
PY

# pgTAP shim (subset used by this suite) unless the real extension is available.
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
create or replace function public.no_plan() returns setof text language plpgsql as $$
begin delete from _tap.state; insert into _tap.state(total) values(0); return; end $$;
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
create or replace function public.has_table(sch text, tbl text, name text) returns setof text language plpgsql as $$
begin return query select * from public.ok(to_regclass(sch||'.'||tbl) is not null, name); end $$;
create or replace function public.has_function(sch text, fn text, args text[], name text) returns setof text language plpgsql as $$
declare found boolean; begin
  select exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname=sch and p.proname=fn) into found;
  return query select * from public.ok(found, name); end $$;
create or replace function public.lives_ok(sql text, name text) returns setof text language plpgsql as $$
begin execute sql; return query select * from _tap.pass(name);
exception when others then return query select * from _tap.fail(name, 'threw '||sqlstate||': '||sqlerrm); end $$;
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

echo "=== running tests/pgtap/approval_tokens.sql ==="
OUT="$("${PSQL[@]}" -tAf "$RENDERED")"
echo "$OUT"
if echo "$OUT" | grep -q '^not ok'; then
  echo "=== RESULT: FAIL ==="; exit 1
fi
echo "=== RESULT: PASS ==="
