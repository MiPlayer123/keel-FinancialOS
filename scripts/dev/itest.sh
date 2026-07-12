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

pnpm test:integration
if grep -q 'KEEL_PLAID_SYNC_FETCH_ATTEMPT' /tmp/keel-functions.log; then
  echo 'C5c hermeticity failure: Plaid live-sync fetch count was nonzero' >&2
  exit 1
fi
echo 'C5c Plaid live-sync fetch spy: 0 calls'
