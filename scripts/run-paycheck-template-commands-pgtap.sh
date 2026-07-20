#!/usr/bin/env bash
# Throwaway-Postgres validation for paycheck split templates SLICE C — the two
# authoring commands (20260722200000_paycheck_template_commands.sql;
# paycheck-split-templates-v2.md §D2/§D3, §7 stage C). Same throwaway-cluster
# pattern as run-paycheck-split-templates-pgtap.sh, but Slice C's commands run
# the FULL command envelope (keel_assert_member_*/keel_actor_from_jwt/
# keel_idempotency_check/keel_finish_command) and write audit_log + command_executions
# + domain_events. We therefore build the minimal REAL base schema those helpers +
# the Slice-B tables need, slice the FIVE envelope helpers verbatim from the
# command_procs migration, apply the REAL Slice-B migration body, then the REAL
# Slice-C migration body, then run tests/pgtap/paycheck_template_commands.sql.
#
# pgTAP is not bundled with vanilla PG; if missing we fall back to a TAP shim.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GRANTS_MIGRATION="$ROOT/supabase/migrations/20260710210500_grants_rls.sql"
CMD_PROCS_MIGRATION="$ROOT/supabase/migrations/20260710210600_command_procs.sql"
SLICE_B="$ROOT/supabase/migrations/20260721180000_paycheck_split_templates.sql"
SLICE_C="$ROOT/supabase/migrations/20260722200000_paycheck_template_commands.sql"
TESTSQL="$ROOT/tests/pgtap/paycheck_template_commands.sql"

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

# Roles the migration owner/grant statements reference.
"${PSQL[@]}" -c "do \$\$ begin
  if not exists (select 1 from pg_roles where rolname='keel_api') then create role keel_api nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin; end if;
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='keel_export') then create role keel_export nologin; end if;
end \$\$;" >/dev/null
"${PSQL[@]}" -c "grant keel_api to postgres; grant keel_export to postgres;" >/dev/null

# --- Minimal REAL base schema ------------------------------------------------
# The Slice-B FKs + the envelope helpers + the command-envelope tables. Column
# sets match live for every column Slice B / Slice C touch (entity_id, kind,
# is_category, archived_at on ledger_accounts; entity_id, ledger_account_id,
# connection_id, archived_at on accounts).
"${PSQL[@]}" >/dev/null <<'BASE'
create schema if not exists auth;
create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

create type public.paycheck_component_kind as enum (
  'gross_salary','bonus','commission','reimbursement',
  'federal_withholding','state_withholding','local_withholding','fica_withholding',
  'benefit','retirement_401k','employer_match','hsa','fsa','espp',
  'rsu_withholding','garnishment','direct_deposit');
create type public.autonomy_level as enum ('off','suggest','auto_with_log');
create type public.household_role as enum ('owner','partner','viewer','professional');
create type public.ledger_account_kind as enum ('asset','liability','equity','income','expense');

create table public.households(id uuid primary key);
create table public.household_memberships(
  household_id uuid not null references public.households(id),
  user_id uuid not null references auth.users(id),
  role public.household_role not null,
  primary key (household_id, user_id));
create table public.entities(
  household_id uuid not null references public.households(id),
  id uuid not null default gen_random_uuid(),
  name text not null,
  primary key (household_id, id), unique (household_id, id));
create table public.ledger_accounts(
  household_id uuid not null references public.households(id),
  id uuid not null default gen_random_uuid(),
  entity_id uuid not null,
  name text not null,
  kind public.ledger_account_kind not null,
  is_category boolean not null default false,
  archived_at timestamptz,
  primary key (household_id, id), unique (household_id, id));
create table public.accounts(
  household_id uuid not null references public.households(id),
  id uuid not null default gen_random_uuid(),
  entity_id uuid not null,
  ledger_account_id uuid not null,
  connection_id uuid,
  name text not null,
  archived_at timestamptz,
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
  component_blueprint jsonb not null default '[]'::jsonb,
  formula_version text not null default 'paycheck-reconciliation-v1',
  created_at timestamptz not null default now(),
  primary key (household_id, id), unique (household_id, id),
  unique (household_id, employer_id, template_version),
  constraint fk_paycheck_template_employer_tenant foreign key (household_id,employer_id)
    references public.employers(household_id,id) on delete restrict);
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

-- Command-envelope tables (verbatim column sets from 20260710210400).
create table public.audit_log(
  id bigint generated always as identity primary key,
  household_id uuid not null references public.households(id),
  actor jsonb not null,
  action text not null check (length(action) between 1 and 200),
  object_type text not null check (length(object_type) between 1 and 100),
  object_id uuid,
  command_id uuid,
  before jsonb,
  after jsonb,
  at timestamptz not null default now());
create table public.domain_events(
  id uuid primary key default gen_random_uuid(),
  event_type text not null check (length(event_type) between 1 and 200),
  household_id uuid not null references public.households(id),
  command_id uuid not null,
  economic_event_key text not null check (length(economic_event_key) between 8 and 256),
  actor jsonb not null,
  occurred_at timestamptz not null default now(),
  payload jsonb not null);
create table public.command_executions(
  household_id uuid not null references public.households(id),
  economic_event_key text not null check (length(economic_event_key) between 8 and 256),
  command_id uuid not null,
  command text not null check (length(command) between 1 and 200),
  payload_sha256 text not null check (payload_sha256 ~ '^[a-f0-9]{64}$'),
  result jsonb not null,
  executed_at timestamptz not null default now(),
  primary key (household_id, economic_event_key));

grant select on public.households, public.household_memberships, public.ledger_accounts,
  public.accounts, public.employers, public.recurring_series, public.paycheck_templates,
  public.canonical_transactions, public.paychecks, public.entities to keel_export;
-- keel_api must be able to write the envelope tables + Slice-B tables (the
-- Slice-B migration grants its own three tables; grant the envelope tables here).
grant insert on public.audit_log, public.domain_events, public.command_executions to keel_api;
grant select on public.command_executions, public.household_memberships,
  public.recurring_series, public.employers, public.ledger_accounts, public.accounts,
  public.paycheck_templates to keel_api;
grant insert on public.paycheck_templates to keel_api;
BASE

# Real keel_forbid_mutation.
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
grep -q "public.keel_is_household_member" "$TMP/member.sql" || { echo "FATAL: cannot slice keel_is_household_member"; exit 1; }
"${PSQL[@]}" -f "$TMP/member.sql" >/dev/null

# The FIVE envelope helpers sliced verbatim from the command-procs migration
# (keel_actor_from_jwt, keel_assert_member_write, keel_idempotency_check,
# keel_payload_hash, keel_finish_command). They live in a contiguous block that
# ends at the "Insert a batch's postings" comment.
awk '/^-- The TRUSTED actor identity/{f=1} /^-- Insert a batch.s postings/{f=0} f{print}' \
  "$CMD_PROCS_MIGRATION" > "$TMP/helpers.sql"
grep -q "keel_finish_command" "$TMP/helpers.sql" || { echo "FATAL: cannot slice envelope helpers"; exit 1; }
"${PSQL[@]}" -f "$TMP/helpers.sql" >/dev/null

# Base keel_export_household stub (Slice B renames+wraps it).
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

# Render the test: inject Slice-B body then Slice-C body at their markers.
RENDERED="$TMP/rendered.sql"
python3 - "$TESTSQL" "$SLICE_B" "$SLICE_C" "$RENDERED" <<'PY'
import sys
test, sliceb, slicec, out = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
lines = open(test).read().splitlines(keepends=True)
def inject(marker, path):
    for i, ln in enumerate(lines):
        if ln.lstrip().startswith(marker):
            lines[i] = open(path).read() + "\n"
            return
    raise AssertionError('marker not found: ' + marker)
inject('-- __SLICE_B_BODY__', sliceb)
inject('-- __SLICE_C_BODY__', slicec)
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
create or replace function public.is(got boolean, want boolean, name text) returns setof text language sql as $$
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

echo "=== running tests/pgtap/paycheck_template_commands.sql ==="
OUT="$("${PSQL[@]}" -tAf "$RENDERED")"
echo "$OUT"
if echo "$OUT" | grep -q '^not ok'; then
  echo "=== RESULT: FAIL ==="; exit 1
fi
echo "=== RESULT: PASS ==="
