#!/usr/bin/env bash
# Throwaway-Postgres validation for the budget-v4 MULTI-MONTH v3-equivalence
# (20260720170000_budgeting_v2_plan.sql). The Supabase local Docker stack is
# unavailable this session (same as run-networth-archived-pgtap.sh), so we
# initdb a temporary cluster, build the minimal real schema inside the test
# file, splice in the ACTUAL shipped function bodies (v3 keel_list_budgets and
# the v4 migration's backfill + keel_budget_month), and run
# tests/pgtap/budget_v4_multimonth_equivalence.sql against it.
#
# The test proves keel_budget_month reproduces keel_list_budgets EXACTLY across
# >=2 consecutive rollover months. It FAILS before the backfill-contiguity fix
# (v4 carry inflates ~2x) and PASSES after.
#
# pgTAP is not bundled with a vanilla PG install; if the extension is missing we
# fall back to a tiny TAP shim (plan/is/finish), so the same test file runs
# either way.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
V3="$ROOT/supabase/migrations/20260713110000_budget_rollover.sql"
V4="$ROOT/supabase/migrations/20260720170000_budgeting_v2_plan.sql"
TESTSQL="$ROOT/tests/pgtap/budget_v4_multimonth_equivalence.sql"

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

RENDERED="$TMP/rendered.sql"
python3 - "$TESTSQL" "$V3" "$V4" "$RENDERED" <<'PY'
import re, sys
test, v3f, v4f, out = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
src = open(test).read()
v3src = open(v3f).read()
v4src = open(v4f).read()

# --- v3: slice the CREATE OR REPLACE FUNCTION public.keel_list_budgets ...$$; block
m = re.search(r'create or replace function public\.keel_list_budgets.*?\n\$\$;', v3src, re.S | re.I)
assert m, 'could not slice keel_list_budgets from v3 migration'
v3_body = m.group(0)

# --- v4: run the shipped migration but strip statements that need the full
#     production schema (RLS policies, ownership guards, and the whole export
#     chain in section 9). We keep: enums, budget_targets/budget_expected_income
#     tables + indexes, the BACKFILL (incl. the contiguity fix under test), the
#     command functions, and keel_budget_month (the read model under test).
# Cut everything from the "9. Export chain" banner onward.
cut = v4src.find('-- 9. Export chain')
if cut == -1:
    cut = v4src.find('Export chain (Law 6')
assert cut != -1, 'could not find export-chain section to trim'
# back up to the banner comment line that precedes section 9
banner = v4src.rfind('-- ===', 0, cut)
v4_body = v4src[:banner]

# Neutralize statements that reference roles/objects absent from the minimal
# schema: RLS enable/policies, revoke/grant on tables, ownership ALTER/guards.
# The read model + backfill do not depend on any of these.
drop_res = [
    r'alter table [^;]*enable row level security;',
    r'revoke all on public\.budget_targets[^;]*;',
    r'grant [^;]*budget_targets[^;]*;',
    r'grant [^;]*budget_expected_income[^;]*;',
    r'drop policy if exists [^;]*;',
    r'create policy [^;]*;',
    r'grant create on schema public[^;]*;',
    r'revoke create on schema public[^;]*;',
    r'alter function [^;]*owner to keel_api;',
    r'revoke all on function[^;]*;',
    r'grant execute on function[^;]*;',
]
for pat in drop_res:
    v4_body = re.sub(pat, '', v4_body, flags=re.S | re.I)
# The ownership-guard DO block raises if a definer proc is not owned by keel_api;
# ownership was stripped above, so neutralize the guard too.
v4_body = re.sub(r"do \$\$begin\s*if exists \(select 1 from pg_proc.*?raise exception 'KEEL_OWNERSHIP.*?end\$\$;",
                 '', v4_body, flags=re.S | re.I)

assert 'create function public.keel_budget_month' in v4_body, 'v4 read model missing after trim'
assert 'CONTIGUITY' in v4_body or 'set end_month = nxt.effective_month' in v4_body, \
    'v4 backfill body missing (contiguity fix not present?)'

src = src.replace('-- __V3_READMODEL_BODY__  (replaced by the runner with the real keel_list_budgets DDL)', v3_body)
src = src.replace('-- __V4_MIGRATION_BODY__  (replaced by the runner with the real migration)', v4_body)
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
-- security definer: the tests run under `set local role authenticated`, so the
-- shim must write its bookkeeping table as the (superuser) owner.
create or replace function public.plan(n int) returns setof text language plpgsql security definer as $$
begin delete from _tap.state; insert into _tap.state(total) values(n);
  return next '1..'||n; end $$;
create or replace function public.is(got text, want text, name text) returns setof text language plpgsql security definer as $$
declare ok boolean := got is not distinct from want; r int;
begin update _tap.state set ran=ran+1 where true returning ran into r;
  if ok then return next 'ok '||r||' - '||name;
  else update _tap.state set failed=failed+1;
    return next 'not ok '||r||' - '||name;
    return next '# got: '||coalesce(got,'<null>');
    return next '# want: '||coalesce(want,'<null>');
  end if; end $$;
create or replace function public.finish() returns setof text language plpgsql security definer as $$
declare s _tap.state;
begin select * into s from _tap.state;
  if s.failed > 0 then return next '# FAILED '||s.failed||' of '||s.ran;
  else return next '# all '||s.ran||' passed'; end if; end $$;
grant usage on schema _tap to public;
SHIM
fi

echo "=== running tests/pgtap/budget_v4_multimonth_equivalence.sql ==="
OUT="$("${PSQL[@]}" -tAf "$RENDERED")"
echo "$OUT"
if echo "$OUT" | grep -q '^not ok'; then
  echo "=== RESULT: FAIL ==="; exit 1
fi
echo "=== RESULT: PASS ==="
