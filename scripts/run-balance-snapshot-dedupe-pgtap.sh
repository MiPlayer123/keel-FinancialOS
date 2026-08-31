#!/usr/bin/env bash
# Throwaway-Postgres validation for balance snapshot dedupe, phase 1
# (20260831190000_balance_snapshot_dedupe.sql).
#
# Same shape as scripts/run-business-entity-tag-pgtap.sh: the Supabase local
# Docker stack is unavailable here, so we initdb a temporary cluster, build the
# minimal schema in the test file, and load the REAL SQL that ships:
#   - the PRIOR keel_apply_account_balance body, sliced verbatim out of
#     20260717220000_account_mask.sql, so the "before" half of the suite runs
#     the function that is in production today;
#   - the ENTIRE new migration file, verbatim.
#
# Three things run here:
#   1. re-runnability -- the migration is applied TWICE (CLAUDE.md applies
#      migrations by hand to the live project with no migration-history table,
#      so a file that errors on a second apply is a production hazard);
#   2. the suite itself;
#   3. --mutate, which deliberately breaks each guard in turn and requires the
#      suite to FAIL. A test that passes against a broken guard is not a test.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MIGRATION="$ROOT/supabase/migrations/20260831190000_balance_snapshot_dedupe.sql"
PRIOR="$ROOT/supabase/migrations/20260717220000_account_mask.sql"
TESTSQL="$ROOT/tests/pgtap/balance_snapshot_dedupe.sql"

for f in "$MIGRATION" "$PRIOR" "$TESTSQL"; do
  [ -f "$f" ] || { echo "FATAL: missing $f"; exit 1; }
done

MUTATE=0
[ "${1:-}" = "--mutate" ] && MUTATE=1

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

# Roles the migration's revoke/grant statements reference.
"${PSQL[@]}" -c "do \$\$ begin
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin; end if;
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
end \$\$;" >/dev/null

# Slice the real prior function DDL out of the account-mask migration.
PRIORFN="$TMP/prior_fn.sql"
awk '/^create or replace function public.keel_apply_account_balance/{f=1}
     f{print}
     f && /^\$\$;$/{exit}' "$PRIOR" > "$PRIORFN"
grep -q 'insert into public.balance_snapshots' "$PRIORFN" \
  || { echo "FATAL: could not slice keel_apply_account_balance from $PRIOR"; exit 1; }
echo "sliced $(wc -l < "$PRIORFN") lines of the CURRENT production function from $(basename "$PRIOR")"
echo "loading $(wc -l < "$MIGRATION") lines of migration verbatim"

render() {
  # render <migration-file> <out-rendered> [<out-idempotent>]
  python3 - "$TESTSQL" "$PRIORFN" "$1" "$2" "${3:-}" <<'PY'
import sys
test, prior, migration, out, idem = (sys.argv[1:6] + [''])[:5]
src = open(test).read()
prior_marker = "-- __PRIOR_FUNCTION_BODY__  (replaced by the runner with 20260717220000's DDL)"
migration_marker = '-- __MIGRATION_BODY__  (replaced by the runner with the real migration file)'
prior_body, migration_body = open(prior).read(), open(migration).read()
for marker in (prior_marker, migration_marker):
    if marker not in src:
        raise SystemExit('FATAL: marker not found in test file: ' + marker)
open(out, 'w').write(src.replace(prior_marker, prior_body).replace(migration_marker, migration_body))

if idem:
    # Re-runnability probe: the minimal schema and seed (everything the test
    # file declares before the prior-function injection point), the prior
    # function, then the migration applied TWICE.
    prelude = src.split(prior_marker)[0]
    prelude = chr(10).join(
        line for line in prelude.splitlines()
        if line.strip() != 'begin;' and not line.strip().startswith('select plan(')
    )
    open(idem, 'w').write(prelude + chr(10) + prior_body + migration_body + migration_body)
PY
}

RENDERED="$TMP/rendered.sql"
IDEMPOTENT="$TMP/idempotent.sql"
render "$MIGRATION" "$RENDERED" "$IDEMPOTENT"

echo "=== re-runnability: applying the migration twice ==="
"$PGBIN/createdb" -h "$SOCK" -U postgres idempotency_probe >/dev/null
if ! "$PGBIN/psql" -X -v ON_ERROR_STOP=1 -h "$SOCK" -U postgres -d idempotency_probe \
     -f "$IDEMPOTENT" >"$TMP/idem.log" 2>&1; then
  echo "=== RESULT: FAIL (migration is not re-runnable) ==="
  tail -20 "$TMP/idem.log"
  exit 1
fi
echo "second apply clean ($(grep -c 'already exists, skipping' "$TMP/idem.log" || true) guarded objects skipped)"

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

echo "=== running tests/pgtap/balance_snapshot_dedupe.sql ==="
OUT="$("${PSQL[@]}" -tAf "$RENDERED")"
echo "$OUT"
if echo "$OUT" | grep -qE '^not ok|^# FAILED'; then
  echo "=== RESULT: FAIL ==="; exit 1
fi
echo "=== RESULT: PASS ==="

[ "$MUTATE" = "1" ] || { echo "(re-run with --mutate to verify each guard is actually load-bearing)"; exit 0; }

# ---------------------------------------------------------------------------
# Mutation testing. Each entry breaks exactly one guard; the suite must go red.
# A test that still passes against a broken guard is not testing that guard.
# ---------------------------------------------------------------------------
MUTPY="$TMP/mutations.py"
cat > "$MUTPY" <<'PYEOF'
"""Single-guard mutations of the phase-1 migration.

Usage: mutations.py --list
       mutations.py <name> <migration-in> <migration-out>

Each mutation MUST change the file (the runner treats a no-op as a failure, so
a mutation that silently stops matching after an edit to the migration cannot
pass unnoticed).

Two predicates in the migration are deliberately NOT mutation-tested, because
they are provably unkillable rather than untested, and listing an unkillable
mutation would mean either a permanently red suite or a quietly deleted case:

  * `bs.household_id = p_household_id` in the guard's WHERE. accounts.id is a
    primary key and balance_snapshots carries a composite FK on
    (household_id, account_id) -> accounts (household_id, id), so no snapshot
    can exist whose household disagrees with its account. Given the account
    predicate, the household predicate cannot change any result. It is kept for
    the same reason every other query in this schema is tenant-scoped: the
    convention is what makes an unscoped query visible in review.

  * `not v_found` in the guard's condition. v_effective_currency is never null
    (it falls back to accounts.currency, which is NOT NULL), so on a first-ever
    observation `v_last.currency is distinct from v_effective_currency` is
    already true and the INSERT already happens. It is kept because "no
    previous row" is the case a reader looks for first, and leaving it implicit
    in a NULL comparison is how that reader gets it wrong.
"""
import sys

FRESHNESS = """  update public.accounts
     set balance_last_observed_at = greatest(coalesce(balance_last_observed_at, p_as_of), p_as_of)
   where id = p_account_id
     and balance_last_observed_at is distinct from
         greatest(coalesce(balance_last_observed_at, p_as_of), p_as_of);
"""
INSERT_TAIL = "       v_effective_currency, 'plaid', '{}'::jsonb);\n"


def null_unsafe(s):
    return (s.replace('is distinct from p_available_minor', '<> p_available_minor')
             .replace('is distinct from p_limit_minor', '<> p_limit_minor'))


def drop_current(s):
    return s.replace('or v_last.current_minor      is distinct from p_current_minor', '')


def drop_currency(s):
    return s.replace('or v_last.currency           is distinct from v_effective_currency', '')


def drop_metadata(s):
    return s.replace("or v_last.snapshot_metadata  is distinct from '{}'::jsonb", '')


def drop_source_filter(s):
    return s.replace("and bs.source = 'plaid'", '')


def drop_account_filter(s):
    return s.replace('and bs.account_id = p_account_id', '')


def flip_tiebreak(s):
    return s.replace('order by bs.as_of desc, bs.id desc', 'order by bs.as_of desc, bs.id asc')


def early_return(s):
    """The regression the proposal's P0-2 identified: skip the whole rest of
    the function instead of just the INSERT, which permanently strands the
    opening-balance anchor of any account whose balance never moves."""
    return s.replace("""  then
    insert into public.balance_snapshots""", """  then
    null;
  else
    return;
  end if;
  if true then
    insert into public.balance_snapshots""")


def freshness_inside_guard(s):
    assert FRESHNESS in s and INSERT_TAIL in s
    return s.replace(FRESHNESS, '').replace(INSERT_TAIL, INSERT_TAIL + FRESHNESS)


def freshness_rewinds(s):
    # Monotonicity is a property of the whole UPDATE: the SET pins the new
    # value and the WHERE decides whether to write at all, and either alone
    # blocks a rewind. Mutating only the SET leaves the WHERE guarding it and
    # the mutation is DEFEATED rather than survived -- which reads identically
    # to an untested guard. So replace both occurrences.
    return s.replace('greatest(coalesce(balance_last_observed_at, p_as_of), p_as_of)', 'p_as_of')


def drop_backfill(s):
    return s.replace(' where s.account_id = a.id', ' where false and s.account_id = a.id')


def drop_lockdown(s):
    return s.replace('revoke all on function public.keel_apply_account_balance', '-- x') \
            .replace('  from public, anon, authenticated;', '')


MUTATIONS = {
    'null-unsafe comparison (is distinct from -> <>)': null_unsafe,
    'guard drops current_minor from the comparison': drop_current,
    'guard drops currency from the comparison': drop_currency,
    'guard drops snapshot_metadata from the comparison': drop_metadata,
    'guard ignores source (compares across sources)': drop_source_filter,
    'guard ignores account_id (compares across accounts)': drop_account_filter,
    'guard loses the id tie-break on equal as_of': flip_tiebreak,
    'early return instead of a guarded INSERT (strands the anchor)': early_return,
    'freshness update moved inside the guard': freshness_inside_guard,
    'freshness update rewinds on out-of-order events': freshness_rewinds,
    'backfill of balance_last_observed_at dropped': drop_backfill,
    'execute lockdown dropped (PUBLIC keeps EXECUTE)': drop_lockdown,
}

if sys.argv[1] == '--list':
    for k in MUTATIONS:
        print(k)
    raise SystemExit(0)

name, src_path, out_path = sys.argv[1], sys.argv[2], sys.argv[3]
src = open(src_path).read()
out = MUTATIONS[name](src)
if out == src:
    raise SystemExit("mutation did not change the file: " + name)
open(out_path, 'w').write(out)
PYEOF

mutate() {
  local name="$1"
  local mfile="$TMP/mut.sql" mrendered="$TMP/mut_rendered.sql"
  if ! python3 "$MUTPY" "$name" "$MIGRATION" "$mfile" 2>"$TMP/mut.err"; then
    echo "MUTATION '$name': FAILED TO APPLY -- $(cat "$TMP/mut.err")"
    return 1
  fi
  render "$mfile" "$mrendered"
  local out
  out="$("${PSQL[@]}" -tAf "$mrendered" 2>&1 || true)"
  if echo "$out" | grep -qE '^not ok|^# FAILED|ERROR:'; then
    echo "MUTATION '$name': suite correctly FAILED"
    echo "$out" | grep -E '^not ok|^# FAILED|ERROR:' | head -2 | sed 's/^/    /'
    return 0
  fi
  echo "MUTATION '$name': suite still PASSED -- that guard is NOT tested"
  return 1
}

echo
echo "=== mutation testing ==="
FAILED=0
while IFS= read -r m; do
  mutate "$m" || FAILED=1
done < <(python3 "$MUTPY" --list)

echo
if [ "$FAILED" = "1" ]; then
  echo "=== MUTATION RESULT: FAIL (at least one guard is not load-bearing) ==="
  exit 1
fi
echo "=== MUTATION RESULT: PASS (every guard is individually load-bearing) ==="
