/**
 * KEEL `worker` — queue consumer. auth: 'secret:automations' — accepts ONLY
 * the named automations secret; publishable keys and user JWTs are rejected
 * by @supabase/server before the handler runs (TASK-000 test 10).
 *
 * Small idempotent batches (INFRA §9): read with visibility timeout, plan
 * with the pure @keel/ingest planner, persist via worker procs, archive on
 * success. Poison messages (read_ct > MAX_ATTEMPTS) are archived with a
 * failure marker — at-least-once delivery + idempotent handlers (PLAN §3.6.6).
 */
import { withSupabase } from 'npm:@supabase/server@1.3.0';
import {
  ProviderSyncEventSchema,
  emptyIngestState,
  planEvent,
  parseMinorUnits,
  type CanonicalTxnView,
  type IngestState,
} from '../_shared/vendor/keel-domain.mjs';
import { json, mapDbError, toSnakeKeys } from '../_shared/http.ts';

const MAX_ATTEMPTS = 5;
const VISIBILITY_TIMEOUT_S = 30;

// deno-lint-ignore no-explicit-any
type AdminClient = any;

interface QueueMessage {
  msg_id: number;
  read_ct: number;
  message: {
    jobType: string;
    economicEventKey: string;
    refs: Record<string, string>;
  };
}

/** Choose the offset category for an uncategorized sync posting (Law 1: this
 * is deterministic sign-based routing, not AI). Debit-positive convention:
 * outflow (negative on the asset) offsets to expense (positive). */
const offsetName = (amountMinor: bigint): string =>
  amountMinor < 0n ? 'Uncategorized Expense' : 'Uncategorized Income';

const processPromoteJob = async (
  admin: AdminClient,
  msg: QueueMessage,
): Promise<{ ok: boolean; detail: string }> => {
  const rawEventId = msg.message.refs['rawEventId'];
  const { data: raw, error: rawErr } = await admin
    .from('raw_provider_events')
    .select('id, connection_id, provider, account_external_ref, body, household_id')
    .eq('id', rawEventId)
    .single();
  if (rawErr || !raw) return { ok: false, detail: `raw event ${rawEventId} not found` };

  const event = ProviderSyncEventSchema.safeParse(raw.body);
  if (!event.success) {
    // Malformed body is data, not an instruction: park as terminal failure.
    return { ok: false, detail: 'body is not a ProviderSyncEvent' };
  }

  const { data: conn } = await admin
    .from('connections')
    .select('external_ref, provider')
    .eq('id', raw.connection_id)
    .single();
  if (!conn) return { ok: false, detail: 'connection missing' };

  // Reconstruct just the planner state entries this event can touch.
  const ids: string[] = [];
  if (event.data.kind === 'transaction_removed') {
    ids.push(event.data.providerTransactionId);
  } else {
    ids.push(event.data.transaction.providerTransactionId);
    if (event.data.transaction.pendingTransactionId) {
      ids.push(event.data.transaction.pendingTransactionId);
    }
  }
  const { data: stateRows, error: stateErr } = await admin.rpc('keel_worker_lookup_state', {
    p_connection_id: raw.connection_id,
    p_provider_txn_ids: ids,
  });
  if (stateErr) return { ok: false, detail: `state lookup failed: ${stateErr.message}` };

  const byProviderTxnId = new Map<string, CanonicalTxnView>();
  for (const row of (stateRows ?? []) as CanonicalTxnView[] & { providerTransactionId: string }[]) {
    byProviderTxnId.set(row.providerTransactionId, row as unknown as CanonicalTxnView);
  }
  const state: IngestState = { byProviderTxnId };

  const { action } = planEvent(state, event.data, {
    provider: conn.provider,
    connectionExternalRef: conn.external_ref,
  });

  // Compute balanced postings for create/revise (deterministic arithmetic
  // only — the DB trigger re-verifies the sum).
  let postings: unknown[] = [];
  if (action.kind === 'create' || action.kind === 'revise') {
    const txn = action.txn;
    const amount = parseMinorUnits(txn.amountMinor);
    const { data: account } = await admin
      .from('accounts')
      .select('id, entity_id, ledger_account_id, household_id')
      .eq('connection_id', raw.connection_id)
      .eq('external_ref', txn.accountExternalRef)
      .single();
    if (!account) return { ok: false, detail: `unknown account ${txn.accountExternalRef}` };
    const { data: offset } = await admin
      .from('ledger_accounts')
      .select('id')
      .eq('entity_id', account.entity_id)
      .eq('name', offsetName(amount))
      .single();
    if (!offset) return { ok: false, detail: 'offset category missing from seed' };
    postings = [
      {
        ledgerAccountId: account.ledger_account_id,
        entityId: account.entity_id,
        amountMinor: amount.toString(),
        currency: 'USD',
      },
      {
        ledgerAccountId: offset.id,
        entityId: account.entity_id,
        amountMinor: (-amount).toString(),
        currency: 'USD',
      },
    ];
  }

  const { error: applyErr } = await admin.rpc('keel_worker_apply_promotion', {
    p_raw_event_id: raw.id,
    p_apply_key: msg.message.economicEventKey,
    p_action: toSnakeKeys({ ...action, postings }),
  });
  if (applyErr) return { ok: false, detail: `apply failed: ${applyErr.message}` };
  return { ok: true, detail: action.kind };
};

export default {
  fetch: withSupabase({ auth: 'secret:automations' }, async (req, ctx) => {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/worker/, '');

    if (req.method === 'GET' && path === '/health') {
      return json(200, { ok: true, service: 'worker' });
    }
    if (req.method !== 'POST' || path !== '/drain') {
      return json(404, { code: 'not_found', message: 'Not found.', details: {} });
    }

    const body = (await req.json().catch(() => ({}))) as {
      queue?: string;
      batchSize?: number;
    };
    const queue = body.queue ?? 'sync_events';
    const batchSize = Math.min(body.batchSize ?? 10, 50);

    const admin = ctx.supabaseAdmin;
    const { data: messages, error: readErr } = await admin.rpc('keel_worker_queue_read', {
      p_queue: queue,
      p_vt: VISIBILITY_TIMEOUT_S,
      p_qty: batchSize,
    });
    if (readErr) return mapDbError(readErr);

    const results: Array<{ msgId: number; status: string; detail: string }> = [];
    for (const msg of (messages ?? []) as QueueMessage[]) {
      let outcome: { ok: boolean; detail: string };
      if (msg.message.jobType === 'promote_raw_event') {
        outcome = await processPromoteJob(admin, msg);
      } else if (msg.message.jobType === 'enrich_transaction' || msg.message.jobType === 'enrich_batch') {
        // Enrichment is a Stage 1D concern; acknowledge so queues stay clean.
        outcome = { ok: true, detail: 'enrichment deferred (stage 1D)' };
      } else {
        outcome = { ok: false, detail: `unknown jobType ${msg.message.jobType}` };
      }

      if (outcome.ok) {
        await admin.rpc('keel_worker_queue_archive', { p_queue: queue, p_msg_id: msg.msg_id });
        results.push({ msgId: msg.msg_id, status: 'done', detail: outcome.detail });
      } else if (msg.read_ct >= MAX_ATTEMPTS) {
        // Dead-letter: archive with the failure recorded in the result log.
        await admin.rpc('keel_worker_queue_archive', { p_queue: queue, p_msg_id: msg.msg_id });
        results.push({ msgId: msg.msg_id, status: 'dead_letter', detail: outcome.detail });
        console.error('dead-letter', queue, msg.msg_id, outcome.detail);
      } else {
        // Leave invisible until the visibility timeout expires, then retried.
        results.push({ msgId: msg.msg_id, status: 'retry', detail: outcome.detail });
      }
    }

    return json(200, { queue, processed: results });
  }),
};
