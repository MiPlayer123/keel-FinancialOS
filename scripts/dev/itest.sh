#!/usr/bin/env bash
# One-shot integration gate: fresh DB, fresh function server, full suite.
# `supabase db reset` restarts containers and KILLS any running
# `functions serve`, so the order here is load-bearing.
set -euo pipefail
cd "$(dirname "$0")/../.."

supabase db reset
pkill -f "supabase functions serve" 2>/dev/null || true
sleep 1
nohup supabase functions serve --env-file supabase/functions/.env \
  > /tmp/keel-functions.log 2>&1 &

for _ in $(seq 1 45); do
  if curl -sf http://127.0.0.1:55321/functions/v1/webhook-provider/health >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
curl -sf http://127.0.0.1:55321/functions/v1/webhook-provider/health >/dev/null

pnpm test:integration
