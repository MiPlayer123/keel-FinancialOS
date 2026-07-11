/**
 * KEEL `scheduled` — cron-triggered orchestration ONLY (INFRA §8: cron must
 * not contain financial business logic). auth: 'secret:automations', same
 * posture as worker (TASK-000 test 10).
 *
 * Stage 1A: a stub that enqueues nothing and reports what it WOULD schedule;
 * real sync scheduling arrives with the Plaid adapter (Stage 1C).
 */
import { withSupabase } from 'npm:@supabase/server@1.3.0';
import { json } from '../_shared/http.ts';

export default {
  fetch: withSupabase({ auth: 'secret:automations' }, async (req, ctx) => {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/scheduled/, '');

    if (req.method === 'GET' && path === '/health') {
      return json(200, { ok: true, service: 'scheduled' });
    }
    if (req.method !== 'POST' || path !== '/tick') {
      return json(404, { code: 'not_found', message: 'Not found.', details: {} });
    }

    const { data: connections, error } = await ctx.supabaseAdmin
      .from('connections')
      .select('id, provider, status')
      .eq('status', 'active');
    if (error) {
      return json(500, { code: 'transaction_failed', message: 'Tick failed.', details: {} });
    }

    return json(200, {
      ok: true,
      wouldSchedule: (connections ?? []).length,
      note: 'sync scheduling activates with the provider adapter (stage 1C)',
    });
  }),
};
