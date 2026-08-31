#!/usr/bin/env bash
# Concurrency probe for business-tag adoption (20260831120000).
#
# The pgTAP suite is single-session, so the one-business-per-transaction
# invariant's RACE conditions are invisible to it — a Codex review of PR #179
# found a lost-update in the adoption path that 62/62 green did not notice.
# This runs the real proc from two concurrent sessions against a throwaway
# cluster loading the shipped SQL verbatim.
#
# The race: two entities whose names both truncate to the SAME 40-char tag name
# (tags.name is capped at 40, entities.name at 200) racing to adopt one existing
# unbound tag. Without the FOR UPDATE + conditional update, both sessions read
# entity_id as null, both pass the guard, and both are handed the same tag id —
# so the loser attributes its transaction to the winner's business while being
# told it succeeded. With the fix, one binds and the other refuses.
#
# Expected output: one session returns a uuid, the other raises, and exactly one
# tag ends up bound.
set -euo pipefail
ROOT=/home/user/keel-FinancialOS
PGBIN=/usr/lib/postgresql/16/bin
TMP=$(mktemp -d); DATA=$TMP/data; SOCK=$TMP/sock; mkdir -p $SOCK
trap '"$PGBIN/pg_ctl" -D "$DATA" -m immediate stop >/dev/null 2>&1 || true; rm -rf $TMP' EXIT
$PGBIN/initdb -D $DATA -U postgres --auth=trust >/dev/null
$PGBIN/pg_ctl -D $DATA -o "-k $SOCK -c listen_addresses=''" -w start >/dev/null
P="$PGBIN/psql -X -v ON_ERROR_STOP=1 -h $SOCK -U postgres -d postgres"
$P -c "do \$\$ begin
 if not exists (select 1 from pg_roles where rolname='keel_api') then create role keel_api nologin; end if;
 if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin; end if;
 if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
 if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
end \$\$;" >/dev/null

# Minimal schema (sliced from the pgTAP suite) + real member_write + real migration.
python3 - "$ROOT/tests/pgtap/business_entity_tag.sql" "$ROOT/supabase/migrations/20260710210600_command_procs.sql" "$ROOT/supabase/migrations/20260831120000_business_entity_tag.sql" "$TMP/base.sql" <<'PY'
import sys,re
test,cmds,mig,out=sys.argv[1:5]
src=open(test).read()
marker='-- __MEMBER_WRITE_BODY__  (replaced by the runner with the real function DDL)'
prelude=src.split(marker)[0]
prelude='\n'.join(l for l in prelude.splitlines() if l.strip()!='begin;' and not l.strip().startswith('select plan('))
m=re.search(r'^create function public\.keel_assert_member_write[\s\S]*?^\$\$;$', open(cmds).read(), re.M)
open(out,'w').write(prelude + m.group(0) + '\n' + open(mig).read())
PY
$P -f $TMP/base.sql >/dev/null 2>&1

# Two entities whose 200-char names both truncate to the SAME 40-char tag name,
# and one pre-existing unbound tag with that name for them to race over.
NAME40="Northwest Consulting Group of Greater Se"
$P >/dev/null <<SQL
create schema if not exists auth;
insert into auth.users values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') on conflict do nothing;
insert into public.households values ('11111111-1111-1111-1111-111111111111','Alpha') on conflict do nothing;
insert into public.household_memberships values ('11111111-1111-1111-1111-111111111111','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','owner') on conflict do nothing;
insert into public.entities (id,household_id,name,kind) values
 ('e1111111-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','${NAME40}attle LLC','llc_single'),
 ('e1111111-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','${NAME40}attle Inc','llc_single') on conflict do nothing;
insert into public.tags (household_id,name) values ('11111111-1111-1111-1111-111111111111','${NAME40}') on conflict do nothing;
SQL

run_session() {
  $PGBIN/psql -X -q -h $SOCK -U postgres -d postgres -v ON_ERROR_STOP=0 -tA <<SQL 2>&1 | tail -1
begin;
set local request.jwt.claim.sub = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
select pg_sleep($2);
select coalesce(public.keel_entity_business_tag_ensure('11111111-1111-1111-1111-111111111111','$1')::text,'null');
commit;
SQL
}
run_session 'e1111111-0000-0000-0000-000000000001' 0 > $TMP/a.out &
run_session 'e1111111-0000-0000-0000-000000000002' 0 > $TMP/b.out &
wait
echo "session A (LLC): $(cat $TMP/a.out)"
echo "session B (Inc): $(cat $TMP/b.out)"
echo "--- final bindings ---"
$P -tA -c "select coalesce(entity_id::text,'UNBOUND')||' <- '||name from public.tags where household_id='11111111-1111-1111-1111-111111111111';"
echo "--- entities holding a business tag (want exactly 1) ---"
$P -tA -c "select count(*) from public.tags where entity_id is not null;"
