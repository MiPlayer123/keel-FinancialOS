/**
 * KEEL `scheduled` — cron-triggered orchestration ONLY (INFRA §8: cron must
 * not contain financial business logic). auth: 'secret:automations', same
 * posture as worker (TASK-000 test 10).
 *
 * C6: `/tick` invokes the same atomic cadence claim used by pg_cron and
 * reports the number of sync notifications enqueued.
 */
import { keelSecretKeys } from '../_shared/bootstrap.ts';
import { withSupabase } from 'npm:@supabase/server@1.3.0';
import { json } from '../_shared/http.ts';
import { claimActiveSyncs } from '../_shared/plaid-meter.ts';

export default {
  fetch: withSupabase({ auth: 'secret:automations', env: keelSecretKeys() }, async (req, ctx) => {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/scheduled/, '');

    if (req.method === 'GET' && path === '/health') {
      return json(200, { ok: true, service: 'scheduled' });
    }
    if (req.method !== 'POST' || path !== '/tick') {
      return json(404, { code: 'not_found', message: 'Not found.', details: {} });
    }

    let enqueued: number;
    try {
      enqueued = await claimActiveSyncs(ctx.supabaseAdmin);
    } catch {
      return json(500, { code: 'transaction_failed', message: 'Tick failed.', details: {} });
    }

    return json(200, { ok: true, enqueued });
  }),
};
