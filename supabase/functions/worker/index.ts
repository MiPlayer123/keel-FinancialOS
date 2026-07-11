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
import { keelSecretKeys } from '../_shared/bootstrap.ts';
import { withSupabase } from 'npm:@supabase/server@1.3.0';
import {
  ProviderSyncEventSchema,
  planEvent,
  type CanonicalTxnView,
  type IngestState,
  type PromotionAction,
} from '../_shared/vendor/keel-domain.mjs';
import { json, mapDbError } from '../_shared/http.ts';

const MAX_ATTEMPTS = 5;
const VISIBILITY_TIMEOUT_S = 8;

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

/** Deterministic sign-based offset routing (Law 1: not AI). Debit-positive:
 * outflow (negative on the asset) offsets to expense (positive). */
const offsetName = (amountMinor: bigint): string =>
  amountMinor < 0n ? 'Uncategorized Expense' : 'Uncategorized Income';

/** Map a planner action + source event to keel_worker_apply_promotion's
 * jsonb contract ({kind, economic_key, reason, txn:{snake_case…}}). */
const actionToProcPayload = (
  action: PromotionAction,
  pendingRef: string | null,
): Record<string, unknown> => {
  if (action.type === 'noop') {
    return { kind: 'noop', economic_key: '', reason: action.reason };
  }
  const view: CanonicalTxnView = action.type === 'revise' ? action.next : action.view;
  return {
    kind: action.type,
    economic_key: view.economicKey,
    reason: action.type === 'create' ? 'provider_added' : action.reason,
    txn: {
      provider_transaction_id: view.providerTransactionId,
      account_external_ref: view.accountExternalRef,
      amount_minor: view.amountMinor.toString(),
      currency: 'USD',
      effective_date: view.effectiveDate,
      description: view.description,
      status: view.status,
      pending_transaction_ref: pendingRef ?? '',
    },
  };
};

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

  // Reconstruct just the planner-state entries this event can touch.
  const ids: string[] = [];
  let pendingRef: string | null = null;
  if (event.data.kind === 'transaction_removed') {
    ids.push(event.data.providerTransactionId);
  } else {
    ids.push(event.data.transaction.providerTransactionId);
    pendingRef = event.data.transaction.pendingTransactionId;
    if (pendingRef) ids.push(pendingRef);
  }
  const { data: stateRows, error: stateErr } = await admin.rpc('keel_worker_lookup_state', {
    p_connection_id: raw.connection_id,
    p_provider_txn_ids: ids,
  });
  if (stateErr) return { ok: false, detail: `state lookup failed: ${stateErr.message}` };

  const byProviderTxnId = new Map<string, CanonicalTxnView>();
  for (const row of (stateRows ?? []) as Array<
    Omit<CanonicalTxnView, 'amountMinor'> & { amountMinor: string }
  >) {
    byProviderTxnId.set(row.providerTransactionId, {
      ...row,
      amountMinor: BigInt(row.amountMinor),
    } as CanonicalTxnView);
  }
  const state: IngestState = { byProviderTxnId };

  const { action } = planEvent(state, event.data, {
    provider: conn.provider,
    connectionExternalRef: conn.external_ref,
  });

  // Balanced postings for create/revise — deterministic arithmetic only;
  // the deferred DB trigger re-verifies the sum at commit.
  let postings: unknown[] = [];
  if (action.type === 'create' || action.type === 'revise') {
    const view = action.type === 'revise' ? action.next : action.view;
    const amount = view.amountMinor;
    const { data: account } = await admin
      .from('accounts')
      .select('id, entity_id, ledger_account_id, household_id')
      .eq('connection_id', raw.connection_id)
      .eq('external_ref', view.accountExternalRef)
      .single();
    if (!account) return { ok: false, detail: `unknown account ${view.accountExternalRef}` };
    const { data: offset } = await admin
      .from('ledger_accounts')
      .select('id')
      .eq('entity_id', account.entity_id)
      .eq('name', offsetName(amount))
      .single();
    if (!offset) return { ok: false, detail: 'offset category missing from seed' };
    postings = [
      {
        ledger_account_id: account.ledger_account_id,
        entity_id: account.entity_id,
        amount_minor: amount.toString(),
        currency: 'USD',
      },
      {
        ledger_account_id: offset.id,
        entity_id: account.entity_id,
        amount_minor: (-amount).toString(),
        currency: 'USD',
      },
    ];
  }

  const { error: applyErr } = await admin.rpc('keel_worker_apply_promotion', {
    p_raw_event_id: raw.id,
    p_apply_key: msg.message.economicEventKey,
    p_action: { ...actionToProcPayload(action, pendingRef), postings },
  });
  if (applyErr) return { ok: false, detail: `apply failed: ${applyErr.message}` };
  return { ok: true, detail: action.type };
};

export default {
  fetch: withSupabase({ auth: 'secret:automations', env: keelSecretKeys() }, async (req, ctx) => {
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
      } else if (
        msg.message.jobType === 'enrich_transaction' ||
        msg.message.jobType === 'enrich_batch'
      ) {
        // Enrichment is a Stage 1D concern; acknowledge so queues stay clean.
        outcome = { ok: true, detail: 'enrichment deferred (stage 1D)' };
      } else if (msg.message.jobType === 'sync_notification') {
        // Verified provider notification; the /transactions/sync pull it
        // triggers is the Plaid adapter's job (stage 1C).
        outcome = { ok: true, detail: 'sync pull deferred (stage 1C)' };
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
        // Message stays invisible until the visibility timeout, then retries.
        results.push({ msgId: msg.msg_id, status: 'retry', detail: outcome.detail });
      }
    }

    const { data: depth } = await admin.rpc('keel_worker_queue_depth', { p_queue: queue });
    return json(200, { queue, processed: results, depth: Number(depth ?? 0) });
  }),
};
