#!/usr/bin/env bash
# Throwaway-Postgres validation for the per-account entity resolver
# (20260719040000). The Supabase local Docker stack is unavailable this
# session, so we initdb a temporary cluster, load ONLY the real
# keel_resolve_finalize_entity function (sliced verbatim out of the migration
# file), and run tests/pgtap/finalize_link_entity.sql against it.
#
# pgTAP is not bundled with a vanilla PG install; if the extension is missing we
# fall back to a tiny shim that implements plan()/is()/finish() with the same
# TAP output, so the same test file runs either way.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MIGRATION="$ROOT/supabase/migrations/20260719040000_finalize_link_per_account_entity.sql"
TESTSQL="$ROOT/tests/pgtap/finalize_link_entity.sql"

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

# Roles the resolver's grant statements reference.
"${PSQL[@]}" -c "do \$\$ begin
  if not exists (select 1 from pg_roles where rolname='keel_api') then create role keel_api nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin; end if;
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
end \$\$;" >/dev/null
"${PSQL[@]}" -c "grant keel_api to postgres;" >/dev/null

# entity_kind enum must exist before the resolver's CREATE FUNCTION is loaded.
"${PSQL[@]}" -c "create type public.entity_kind as enum
  ('personal','sole_prop','llc_single','llc_multi','s_corp','trust','other');" >/dev/null

# Slice the real resolver DDL (CREATE ... \$resolve\$ ... \$resolve\$;) out of
# the migration so the test runs the SHIPPED body, not a copy.
RESOLVER="$TMP/resolver.sql"
awk '/create or replace function public.keel_resolve_finalize_entity/{f=1}
     f{print}
     f && /\$resolve\$;/{exit}' "$MIGRATION" > "$RESOLVER"
if ! grep -q keel_resolve_finalize_entity "$RESOLVER"; then
  echo "FATAL: could not slice resolver body from migration"; exit 1
fi
echo "sliced $(wc -l < "$RESOLVER") lines of resolver DDL from migration"

# The minimal-schema test needs the entities/accounts/etc tables BEFORE the
# resolver (it references public.accounts). The test file creates them at its
# __RESOLVER_BODY__ marker; inject the resolver there.
RENDERED="$TMP/rendered.sql"
python3 - "$TESTSQL" "$RESOLVER" "$RENDERED" <<'PY'
import sys
test, resolver, out = sys.argv[1], sys.argv[2], sys.argv[3]
body = open(resolver).read()
src = open(test).read()
src = src.replace('-- __RESOLVER_BODY__  (replaced by the runner with the real function DDL)', body)
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

echo "=== running tests/pgtap/finalize_link_entity.sql ==="
OUT="$("${PSQL[@]}" -tAf "$RENDERED")"
echo "$OUT"
if echo "$OUT" | grep -q '^not ok'; then
  echo "=== RESULT: FAIL ==="; exit 1
fi
echo "=== RESULT: PASS ==="
