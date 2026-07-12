#!/usr/bin/env bash
# One-shot integration gate: fresh DB, fresh function server, full suite.
# `supabase db reset` restarts containers and KILLS any running
# `functions serve`, so the order here is load-bearing.
set -euo pipefail
cd "$(dirname "$0")/../.."

ITEST_ENV="$(mktemp /tmp/keel-itest-env.XXXXXX)"
chmod 600 "$ITEST_ENV"
trap 'rm -f "$ITEST_ENV"' EXIT
awk '!/^[[:space:]]*(export[[:space:]]+)?(KEEL_LIVE_SYNC_ENABLED|KEEL_PLAID_FETCH_DENY|KEEL_PLAID_FETCH_SPY)=/' \
  supabase/functions/.env > "$ITEST_ENV"
printf '%s\n' \
  'KEEL_LIVE_SYNC_ENABLED=false' \
  'KEEL_PLAID_FETCH_DENY=true' \
  'KEEL_PLAID_FETCH_SPY=true' >> "$ITEST_ENV"

supabase db reset

# `db reset` can return before PostgREST has rebuilt its schema cache. Edge
# health does not exercise PostgREST, so wait for one authenticated relation
# query before starting the shared-DB suite (otherwise RPCs race with PGRST002).
STATUS_ENV="$(supabase status -o env)"
API_URL="$(printf '%s\n' "$STATUS_ENV" | sed -n 's/^API_URL="\{0,1\}\([^"[:space:]]*\)"\{0,1\}$/\1/p')"
SERVICE_ROLE_KEY="$(printf '%s\n' "$STATUS_ENV" | sed -n 's/^SERVICE_ROLE_KEY="\{0,1\}\([^"[:space:]]*\)"\{0,1\}$/\1/p')"
ANON_KEY="$(printf '%s\n' "$STATUS_ENV" | sed -n 's/^ANON_KEY="\{0,1\}\([^"[:space:]]*\)"\{0,1\}$/\1/p')"
AUTOMATIONS_SECRET="$(sed -n 's/^KEEL_LOCAL_AUTOMATIONS_SECRET=//p' .env.local-automations)"
test -n "$API_URL"
test -n "$SERVICE_ROLE_KEY"
test -n "$ANON_KEY"
test -n "$AUTOMATIONS_SECRET"
for _ in $(seq 1 45); do
  if curl -sf \
    -H "apikey: $SERVICE_ROLE_KEY" \
    -H "authorization: Bearer $SERVICE_ROLE_KEY" \
    "$API_URL/rest/v1/connections?select=id&limit=1" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
curl -sf \
  -H "apikey: $SERVICE_ROLE_KEY" \
  -H "authorization: Bearer $SERVICE_ROLE_KEY" \
  "$API_URL/rest/v1/connections?select=id&limit=1" >/dev/null

# A queryable table does NOT guarantee PostgREST has the newly-migrated
# FUNCTIONS in its schema cache yet: the function cache can lag the table
# cache after `db reset`, so an RPC added by the latest migration
# (`keel_recurring_confirm`) can transiently answer PGRST202 / HTTP 404
# ("not found in schema cache") while every earlier suite still passes. Gate
# on that RPC being exposed — a dummy call answers 403 (fenced) once cached,
# never 404 — so the recurring suite can't race the cache.
for _ in $(seq 1 45); do
  RPC_CODE="$(curl -s -o /dev/null -w '%{http_code}' \
    -X POST "$API_URL/rest/v1/rpc/keel_recurring_confirm" \
    -H "apikey: $SERVICE_ROLE_KEY" \
    -H "authorization: Bearer $SERVICE_ROLE_KEY" \
    -H 'content-type: application/json' \
    -d '{"p_command_id":"00000000-0000-0000-0000-000000000000","p_economic_event_key":"probe","p_actor":{},"p_household_id":"00000000-0000-0000-0000-000000000000","p_payload":{}}' || true)"
  if [ "$RPC_CODE" != "404" ]; then
    break
  fi
  sleep 1
done
test "$RPC_CODE" != "404"

pnpm build:functions
pkill -f "supabase functions serve" 2>/dev/null || true
sleep 1
KEEL_LIVE_SYNC_ENABLED=false \
KEEL_PLAID_FETCH_DENY=true \
KEEL_PLAID_FETCH_SPY=true \
nohup supabase functions serve --env-file "$ITEST_ENV" \
  > /tmp/keel-functions.log 2>&1 &

for _ in $(seq 1 45); do
  if curl -sf http://127.0.0.1:55321/functions/v1/webhook-provider/health >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
curl -sf http://127.0.0.1:55321/functions/v1/webhook-provider/health >/dev/null

# Warm the independently bundled authenticated API function too. A healthy
# unauthenticated probe is exactly 401; the local Edge gateway can briefly
# return 502 while that isolate starts even after webhook-provider is ready.
API_HEALTH_CODE=""
for _ in $(seq 1 45); do
  API_HEALTH_CODE="$(curl -s -o /dev/null -w '%{http_code}' \
    http://127.0.0.1:55321/functions/v1/api/health || true)"
  if [ "$API_HEALTH_CODE" = "401" ]; then
    break
  fi
  sleep 1
done
test "$API_HEALTH_CODE" = "401"

# Exercise the authenticated isolates, not only the gateway auth rejection.
# This removes a local Edge cold-start race where the first test sees 502 even
# though subsequent requests are healthy.
LOGIN_JSON="$(curl -sf -X POST "$API_URL/auth/v1/token?grant_type=password" \
  -H "apikey: $ANON_KEY" -H 'content-type: application/json' \
  -d '{"email":"alex@keel.local","password":"keel-local-dev-password"}')"
ACCESS_TOKEN="$(printf '%s' "$LOGIN_JSON" | node -e \
  "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>process.stdout.write(JSON.parse(s).access_token||''))")"
test -n "$ACCESS_TOKEN"
for _ in $(seq 1 45); do
  if curl -sf -H "apikey: $ANON_KEY" -H "authorization: Bearer $ACCESS_TOKEN" \
    http://127.0.0.1:55321/functions/v1/api/health >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
curl -sf -H "apikey: $ANON_KEY" -H "authorization: Bearer $ACCESS_TOKEN" \
  http://127.0.0.1:55321/functions/v1/api/health >/dev/null
for _ in $(seq 1 45); do
  if curl -sf -H "apikey: $AUTOMATIONS_SECRET" \
    http://127.0.0.1:55321/functions/v1/worker/health >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
curl -sf -H "apikey: $AUTOMATIONS_SECRET" \
  http://127.0.0.1:55321/functions/v1/worker/health >/dev/null

pnpm test:integration
if grep -q 'KEEL_PLAID_SYNC_FETCH_ATTEMPT' /tmp/keel-functions.log; then
  echo 'C5c hermeticity failure: Plaid live-sync fetch count was nonzero' >&2
  exit 1
fi
echo 'C5c Plaid live-sync fetch spy: 0 calls'
