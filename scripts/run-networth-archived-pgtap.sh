#!/usr/bin/env bash
# Throwaway-Postgres validation for the "active accounts only" read-model filter
# (20260719130000_networth_exclude_archived_accounts.sql). The Supabase local
# Docker stack is unavailable this session (same as run-finalize-entity-pgtap.sh),
# so we initdb a temporary cluster, load ONLY the real read-model function DDL
# (the whole body of the migration, which is just CREATE OR REPLACE + grants),
# and run tests/pgtap/networth_exclude_archived_accounts.sql against it.
#
# pgTAP is not bundled with a vanilla PG install; if the extension is missing we
# fall back to a tiny shim that implements plan()/is()/finish() with the same
# TAP output, so the same test file runs either way.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# The SHIPPED read-model bodies are layered: 20260719130000 defines all five
# archived-filtered read models; 20260813140000 (market-value net worth, final
# perf-fixed bodies — superseding 20260813120000's first cut) redefines
# keel_net_worth_as_of + keel_net_worth_daily on top. Load both, in order, so
# the archived-account invariants are proven against what production actually
# runs — not a superseded formula (review finding on PR #165).
MIGRATION="$ROOT/supabase/migrations/20260719130000_networth_exclude_archived_accounts.sql"
MIGRATION2="$ROOT/supabase/migrations/20260813140000_net_worth_daily_perf_fix.sql"
TESTSQL="$ROOT/tests/pgtap/networth_exclude_archived_accounts.sql"

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

# The migration body is entirely CREATE OR REPLACE FUNCTION + owner/grant DDL
# for the 5 read models. Load it verbatim at the test's __READMODEL_BODIES__
# marker so the tests run the SHIPPED SQL, not a paraphrase.
BODIES="$MIGRATION"
if ! grep -q keel_net_worth_as_of "$BODIES"; then
  echo "FATAL: migration missing keel_net_worth_as_of"; exit 1
fi

if ! grep -q keel_net_worth_daily "$MIGRATION2"; then
  echo "FATAL: market-value migration missing keel_net_worth_daily"; exit 1
fi

RENDERED="$TMP/rendered.sql"
python3 - "$TESTSQL" "$BODIES" "$MIGRATION2" "$RENDERED" <<'PY'
import sys
test, bodies, bodies2, out = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
# Concatenate in migration order: later create-or-replace wins, exactly as the
# real migration chain applies (20260813140000 is pure function DDL).
body = open(bodies).read() + '\n' + open(bodies2).read()
src = open(test).read()
marker = '-- __READMODEL_BODIES__  (replaced by the runner with the real function DDL)'
assert marker in src, 'test marker missing'
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
  else return next '# all '||s.ran||' passed'; end if; end $$;
SHIM
fi

echo "=== running tests/pgtap/networth_exclude_archived_accounts.sql ==="
OUT="$("${PSQL[@]}" -tAf "$RENDERED")"
echo "$OUT"
if echo "$OUT" | grep -q '^not ok'; then
  echo "=== RESULT: FAIL ==="; exit 1
fi
echo "=== RESULT: PASS ==="
