#!/usr/bin/env bash
# Throwaway-Postgres validation for paycheck split templates SLICE B
# (20260721180000_paycheck_split_templates.sql; paycheck-split-templates-v2.md
# §D3, §2 migration 180000). Same throwaway-cluster pattern as
# run-approval-tokens-pgtap.sh, but the SLICE-B migration FKs to a broad slice of
# the base schema (households, ledger_accounts, accounts, recurring_series,
# employers, canonical_transactions, paycheck_templates, paychecks) and rewraps
# the export function — reconstructing all of that from real migration slices is
# fragile (pgmq/auth/pg_cron aren't in a vanilla cluster). Instead we build the
# MINIMAL REAL base schema this migration needs — the exact tables + composite
# unique keys its FKs resolve against, the real keel_forbid_mutation +
# keel_is_household_member helpers (sliced verbatim), and a base
# keel_export_household so the rename+wrap chain works — then apply the REAL
# migration body verbatim and run tests/pgtap/paycheck_split_templates.sql.
#
# pgTAP is not bundled with vanilla PG; if missing we fall back to a TAP shim.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INGESTION_MIGRATION="$ROOT/supabase/migrations/20260710210200_ingestion.sql"
GRANTS_MIGRATION="$ROOT/supabase/migrations/20260710210500_grants_rls.sql"
MIGRATION="$ROOT/supabase/migrations/20260721180000_paycheck_split_templates.sql"
TESTSQL="$ROOT/tests/pgtap/paycheck_split_templates.sql"

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
  if not exists (select 1 from pg_roles where rolname='keel_export') then create role keel_export nologin; end if;
end \$\$;" >/dev/null
"${PSQL[@]}" -c "grant keel_api to postgres; grant keel_export to postgres;" >/dev/null

# --- Minimal REAL base schema the migration FKs to -------------------------
# Enums reused by the migration (paycheck_component_kind, autonomy_level) —
# defined verbatim from the shipped schema. Composite unique keys match live.
"${PSQL[@]}" >/dev/null <<'BASE'
create schema if not exists auth;
create table auth.users(id uuid primary key);
-- Supabase auth.uid() stub (reads request.jwt.claim.sub). keel_is_household_member
-- uses it in RLS predicates; the SLICE-B definer read models read the JWT sub
-- directly, so this is only needed for the base helper to compile.
create function auth.uid() returns uuid language sql stable as $$
  select nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

create type public.paycheck_component_kind as enum (
  'gross_salary','bonus','commission','reimbursement',
  'federal_withholding','state_withholding','local_withholding','fica_withholding',
  'benefit','retirement_401k','employer_match','hsa','fsa','espp',
  'rsu_withholding','garnishment','direct_deposit');
create type public.autonomy_level as enum ('off','suggest','auto_with_log');

create table public.households(id uuid primary key);
create table public.household_memberships(
  household_id uuid not null references public.households(id),
  user_id uuid not null references auth.users(id),
  role text not null,
  primary key (household_id, user_id));
create table public.ledger_accounts(
  household_id uuid not null references public.households(id),
  id uuid not null default gen_random_uuid(),
  name text not null,
  primary key (household_id, id), unique (household_id, id));
create table public.accounts(
  household_id uuid not null references public.households(id),
  id uuid not null default gen_random_uuid(),
  name text not null,
  primary key (household_id, id), unique (household_id, id));
create table public.employers(
  household_id uuid not null references public.households(id),
  id uuid not null default gen_random_uuid(),
  name text not null,
  primary key (household_id, id), unique (household_id, id));
create table public.recurring_series(
  household_id uuid not null references public.households(id),
  id uuid not null default gen_random_uuid(),
  primary key (household_id, id), unique (household_id, id));
create table public.paycheck_templates(
  household_id uuid not null references public.households(id),
  id uuid not null default gen_random_uuid(),
  employer_id uuid not null,
  template_version integer not null check (template_version > 0),
  formula_version text not null default 'paycheck-reconciliation-v1',
  created_at timestamptz not null default now(),
  primary key (household_id, id), unique (household_id, id),
  unique (household_id, employer_id, template_version));
create table public.canonical_transactions(
  household_id uuid not null references public.households(id),
  id uuid not null default gen_random_uuid(),
  effective_date date not null,
  description text not null,
  primary key (household_id, id), unique (household_id, id));
create table public.paychecks(
  household_id uuid not null references public.households(id),
  id uuid not null default gen_random_uuid(),
  primary key (household_id, id), unique (household_id, id));
-- In live, keel_export holds SELECT on every base table; the base
-- keel_export_household (owned by keel_export) reads households. Mirror that so
-- the wrapped export runs (the SLICE-B migration grants keel_export on its own
-- three tables itself).
grant select on public.households, public.household_memberships, public.ledger_accounts,
  public.accounts, public.employers, public.recurring_series, public.paycheck_templates,
  public.canonical_transactions, public.paychecks to keel_export;
BASE

# Real keel_forbid_mutation (sliced verbatim from the ingestion migration).
"${PSQL[@]}" >/dev/null <<'FORBID'
create function public.keel_forbid_mutation() returns trigger
language plpgsql as $$
begin
  raise exception 'KEEL_IMMUTABLE: % rows are append-only', tg_table_name
    using errcode = 'P0001';
end;
$$;
FORBID

# Real keel_is_household_member (sliced verbatim from the grants migration).
awk "/create function public\\.keel_is_household_member/{f=1} f{print} f && /^\\\$\\\$;\$/{exit}" \
  "$GRANTS_MIGRATION" > "$TMP/member.sql"
if ! grep -q "public.keel_is_household_member" "$TMP/member.sql"; then
  echo "FATAL: could not slice keel_is_household_member from $GRANTS_MIGRATION"; exit 1
fi
"${PSQL[@]}" -f "$TMP/member.sql" >/dev/null

# Base keel_export_household stub (the migration renames+wraps it). Returns the
# {tables:{...}} envelope shape the wrapper appends to; asserts household exists.
"${PSQL[@]}" >/dev/null <<'EXPORT'
create function public.keel_export_household(p_household_id uuid, p_as_of timestamptz default null)
returns jsonb language plpgsql security definer stable set search_path = pg_catalog, public as $$
begin
  if not exists (select 1 from public.households where id = p_household_id) then
    raise exception 'KEEL_SCOPE_VIOLATION' using errcode = 'P0006';
  end if;
  return jsonb_build_object('tables', '{}'::jsonb,
    'asOf', to_char(coalesce(p_as_of, now()) at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
end$$;
revoke all on function public.keel_export_household(uuid,timestamptz) from public,anon,authenticated,service_role;
grant create on schema public to keel_export;
alter function public.keel_export_household(uuid,timestamptz) owner to keel_export;
revoke create on schema public from keel_export;
grant execute on function public.keel_export_household(uuid,timestamptz) to service_role;
EXPORT

# Render the test: inject the real migration body at the marker.
RENDERED="$TMP/rendered.sql"
python3 - "$TESTSQL" "$MIGRATION" "$RENDERED" <<'PY'
import sys
test, migration, out = sys.argv[1], sys.argv[2], sys.argv[3]
src = open(test).read()
marker = '-- __MIGRATION_BODY__'
lines = src.splitlines(keepends=True)
for i, ln in enumerate(lines):
    if ln.lstrip().startswith(marker):
        lines[i] = open(migration).read() + "\n"
        break
else:
    raise AssertionError('marker not found')
open(out, 'w').write(''.join(lines))
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
create or replace function public.is(got int, want int, name text) returns setof text language sql as $$
  select * from public.is(got::text, want::text, name) $$;
create or replace function public.has_table(sch text, tbl text, name text) returns setof text language plpgsql as $$
begin return query select * from public.ok(to_regclass(sch||'.'||tbl) is not null, name); end $$;
create or replace function public.has_column(sch text, tbl text, col text, name text) returns setof text language plpgsql as $$
declare found boolean; begin
  select exists(select 1 from information_schema.columns
    where table_schema=sch and table_name=tbl and column_name=col) into found;
  return query select * from public.ok(found, name); end $$;
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

echo "=== running tests/pgtap/paycheck_split_templates.sql ==="
OUT="$("${PSQL[@]}" -tAf "$RENDERED")"
echo "$OUT"
if echo "$OUT" | grep -q '^not ok'; then
  echo "=== RESULT: FAIL ==="; exit 1
fi
echo "=== RESULT: PASS ==="
