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
  reconcileSyncBatch,
  type CanonicalTxnView,
  type IngestState,
  type PromotionAction,
  type ProviderSyncEvent,
} from '../_shared/vendor/keel-domain.mjs';
import { json, mapDbError } from '../_shared/http.ts';
import { parsePlaidSyncPage, PlaidMutationRestart, readSyncPages } from '../_shared/plaid-sync.ts';

const MAX_ATTEMPTS = 5;
const VISIBILITY_TIMEOUT_S = 8;
const MAX_PAGES_PER_INVOCATION = 5;
const MAX_MUTATION_RESTARTS = 3;
const SYNC_LEASE_TTL_S = 30;

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

interface ProcessOutcome {
  ok: boolean;
  detail: string;
  retry?: boolean;
}

interface SyncContinuation {
  attemptId: string;
  owner: string;
  nextPageOffset: number;
  pageOrdinal: number;
  restartCount: number;
  originalEconomicEventKey: string;
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
    Omit<CanonicalTxnView, 'amountMinor'> & { amountMinor: string; lookupKey: string }
  >) {
    // Key by the QUERIED id; the view carries the current canonical identity
    // (providerTransactionId = latest source record) so supersession resolves
    // exactly as the pure planner does.
    byProviderTxnId.set(row.lookupKey, {
      economicKey: row.economicKey,
      providerTransactionId: row.providerTransactionId,
      accountExternalRef: row.accountExternalRef,
      amountMinor: BigInt(row.amountMinor),
      status: row.status,
      description: row.description,
      effectiveDate: row.effectiveDate,
    });
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

const parseContinuation = (body: unknown): SyncContinuation | null => {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const value = (body as Record<string, unknown>)['keelSyncContinuation'];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate['attemptId'] !== 'string' ||
    typeof candidate['owner'] !== 'string' ||
    typeof candidate['nextPageOffset'] !== 'number' ||
    typeof candidate['pageOrdinal'] !== 'number' ||
    typeof candidate['restartCount'] !== 'number' ||
    typeof candidate['originalEconomicEventKey'] !== 'string'
  ) {
    return null;
  }
  return candidate as unknown as SyncContinuation;
};

const eventProviderTransactionId = (event: ProviderSyncEvent): string =>
  event.kind === 'transaction_removed'
    ? event.providerTransactionId
    : event.transaction.providerTransactionId;

const processSyncNotification = async (
  admin: AdminClient,
  msg: QueueMessage,
): Promise<ProcessOutcome> => {
  try {
    const rawEventId = msg.message.refs['rawEventId'];
    let raw: { connection_id: string; body: unknown } | null = null;
    if (rawEventId) {
      const { data, error } = await admin
        .from('raw_provider_events')
        .select('connection_id, body')
        .eq('id', rawEventId)
        .single();
      if (error || !data) {
        return { ok: false, detail: `raw event ${rawEventId} not found` };
      }
      raw = data;
    }

    const connectionId = raw?.connection_id ?? msg.message.refs['connectionId'];
    if (!connectionId) return { ok: false, detail: 'sync connection missing' };
    const continuation = parseContinuation(raw?.body);

    const { data: connection, error: connectionError } = await admin
      .from('connections')
      .select('external_ref, provider, sync_committed_generation, sync_desired_generation')
      .eq('id', connectionId)
      .single();
    if (connectionError || !connection) {
      return { ok: false, detail: `connection ${connectionId} missing` };
    }
    if (connection.provider !== 'plaid') {
      return { ok: false, detail: `sync provider ${connection.provider} is not plaid` };
    }

    // desired > committed means this notification (or a coalesced predecessor)
    // has already requested a generation that is not committed yet.
    if (
      !continuation &&
      connection.sync_desired_generation === connection.sync_committed_generation
    ) {
      const { error } = await admin.rpc('keel_worker_bump_generation', {
        p_connection_id: connectionId,
      });
      if (error) return { ok: false, detail: `generation bump failed: ${error.message}` };
    }

    const owner = continuation?.owner ?? crypto.randomUUID();
    const { data: lease, error: leaseError } = await admin.rpc('keel_worker_acquire_sync_lease', {
      p_connection_id: connectionId,
      p_owner: owner,
      p_ttl_seconds: SYNC_LEASE_TTL_S,
    });
    if (leaseError) return { ok: false, detail: `lease acquire failed: ${leaseError.message}` };
    if (!lease?.acquired) {
      return {
        ok: false,
        retry: true,
        detail: `sync lease unavailable: ${lease?.reason ?? 'unknown'}`,
      };
    }

    const baseCursor = String(lease.baseCursor ?? '');
    let attemptId = continuation?.attemptId;
    if (!attemptId) {
      const { data, error } = await admin.rpc('keel_worker_open_attempt', {
        p_connection_id: connectionId,
        p_owner: owner,
        p_base_cursor: baseCursor,
      });
      if (error || !data) {
        return { ok: false, detail: `attempt open failed: ${error?.message ?? 'no id'}` };
      }
      attemptId = data;
    }

    let allEvents: ProviderSyncEvent[] = [];
    let finalNextCursor = baseCursor;
    if (continuation) {
      const { data: archived, error } = await admin
        .from('raw_provider_events')
        .select('provider_event_id, body_text')
        .eq('connection_id', connectionId)
        .like('provider_event_id', `${attemptId}:%`);
      if (error) return { ok: false, detail: `attempt restore failed: ${error.message}` };
      const ordered = (archived ?? []).sort(
        (left: { provider_event_id: string }, right: { provider_event_id: string }) =>
          Number(left.provider_event_id.split(':').at(-1)) -
          Number(right.provider_event_id.split(':').at(-1)),
      );
      for (const archivedPage of ordered) {
        const restored = await parsePlaidSyncPage(
          archivedPage.body_text,
          connection.external_ref,
          finalNextCursor,
        );
        allEvents.push(...restored.events);
        finalNextCursor = restored.nextCursor;
      }
    }

    const pages = await readSyncPages(admin, connectionId);
    // No injected script is the guarded live-Plaid stub for C5b. Complete an
    // empty attempt so the notification is durably consumed without network.
    let completedPageSet = pages.length === 0;
    let pageOffset = continuation?.nextPageOffset ?? 0;
    let pageOrdinal = continuation?.pageOrdinal ?? 0;
    let restartCount = continuation?.restartCount ?? 0;
    let pagesProcessed = 0;

    while (
      pageOffset < pages.length &&
      pagesProcessed < MAX_PAGES_PER_INVOCATION &&
      !completedPageSet
    ) {
      const injected = pages[pageOffset]!;
      const { data: renewed, error: renewError } = await admin.rpc('keel_worker_renew_sync_lease', {
        p_connection_id: connectionId,
        p_owner: owner,
        p_ttl_seconds: SYNC_LEASE_TTL_S,
      });
      if (renewError || !renewed) {
        return { ok: false, retry: true, detail: 'sync lease lost while paging' };
      }

      const { error: archiveError } = await admin.rpc('keel_worker_archive_page', {
        p_attempt_id: attemptId,
        p_owner: owner,
        p_page_ordinal: pageOrdinal,
        p_body_text: injected.bodyText,
      });
      if (archiveError) {
        return { ok: false, detail: `page archive failed: ${archiveError.message}` };
      }

      pageOffset += 1;
      pagesProcessed += 1;
      try {
        const parsed = await parsePlaidSyncPage(
          injected.bodyText,
          connection.external_ref,
          finalNextCursor,
        );
        allEvents.push(...parsed.events);
        finalNextCursor = parsed.nextCursor;
        for (const skipped of parsed.skippedTransactions) {
          console.warn('plaid sync transaction skipped', skipped);
        }
        pageOrdinal += 1;
        completedPageSet = !parsed.hasMore;
      } catch (error) {
        if (!(error instanceof PlaidMutationRestart)) throw error;
        const { error: abandonError } = await admin.rpc('keel_worker_abandon_attempt', {
          p_attempt_id: attemptId,
          p_owner: owner,
        });
        if (abandonError) {
          return { ok: false, detail: `attempt abandon failed: ${abandonError.message}` };
        }
        restartCount += 1;
        if (restartCount > MAX_MUTATION_RESTARTS) {
          return { ok: false, detail: 'Plaid mutation restart limit exceeded' };
        }
        const { data: restartedAttempt, error: restartError } = await admin.rpc(
          'keel_worker_open_attempt',
          {
            p_connection_id: connectionId,
            p_owner: owner,
            p_base_cursor: baseCursor,
          },
        );
        if (restartError || !restartedAttempt) {
          return {
            ok: false,
            detail: `attempt restart failed: ${restartError?.message ?? 'no id'}`,
          };
        }
        attemptId = restartedAttempt;
        allEvents = [];
        finalNextCursor = baseCursor;
        pageOrdinal = 0;
      }
    }

    // An injected response script is authoritative. If its last row says
    // has_more but supplies no next row, finish at its last cursor rather than
    // manufacturing an infinite continuation.
    if (!completedPageSet && pageOffset >= pages.length) completedPageSet = true;

    if (!completedPageSet && pageOffset < pages.length) {
      const originalEconomicEventKey =
        continuation?.originalEconomicEventKey ?? msg.message.economicEventKey;
      const { error } = await admin.rpc('keel_worker_record_raw_event', {
        p_provider: 'plaid',
        p_connection_external_ref: connection.external_ref,
        p_provider_event_id: `sync-continuation:${attemptId}:${pageOffset}`,
        p_account_external_ref: 'item-notification',
        p_body: {
          keelSyncContinuation: {
            attemptId,
            owner,
            nextPageOffset: pageOffset,
            pageOrdinal,
            restartCount,
            originalEconomicEventKey,
          },
        },
        p_received_at: new Date().toISOString(),
      });
      if (error) return { ok: false, detail: `continuation enqueue failed: ${error.message}` };
      return { ok: true, detail: 'sync continuation enqueued' };
    }

    const touchedProviderIds = [...new Set(allEvents.map(eventProviderTransactionId))];
    const { data: stateRows, error: stateError } = await admin.rpc('keel_worker_lookup_state', {
      p_connection_id: connectionId,
      p_provider_txn_ids: touchedProviderIds,
    });
    if (stateError) return { ok: false, detail: `state lookup failed: ${stateError.message}` };

    const byProviderTxnId = new Map<string, CanonicalTxnView>();
    for (const row of (stateRows ?? []) as Array<
      Omit<CanonicalTxnView, 'amountMinor'> & { amountMinor: string; lookupKey: string }
    >) {
      byProviderTxnId.set(row.lookupKey, {
        economicKey: row.economicKey,
        providerTransactionId: row.providerTransactionId,
        accountExternalRef: row.accountExternalRef,
        amountMinor: BigInt(row.amountMinor),
        status: row.status,
        description: row.description,
        effectiveDate: row.effectiveDate,
      });
    }
    const priorState: IngestState = { byProviderTxnId };
    const { actions } = reconcileSyncBatch(allEvents, priorState, {
      provider: 'plaid',
      connectionExternalRef: connection.external_ref,
    });
    const originalEconomicEventKey =
      continuation?.originalEconomicEventKey ?? msg.message.economicEventKey;

    for (const action of actions) {
      if (action.type === 'noop') continue;
      let sourceEvent: ProviderSyncEvent | undefined;
      if (action.type === 'create') {
        sourceEvent = allEvents.find(
          (event) =>
            event.kind === 'transaction_added' &&
            event.transaction.providerTransactionId === action.view.providerTransactionId,
        );
      } else if (action.type === 'revise') {
        sourceEvent = allEvents.find(
          (event) =>
            event.kind ===
              (action.reason === 'supersession' ? 'transaction_added' : 'transaction_modified') &&
            event.transaction.providerTransactionId === action.next.providerTransactionId,
        );
      } else {
        sourceEvent = allEvents.find((event) => {
          if (event.kind !== 'transaction_removed') return false;
          const previous = priorState.byProviderTxnId.get(event.providerTransactionId);
          return previous?.economicKey === action.view.economicKey;
        });
      }
      if (!sourceEvent) {
        return { ok: false, detail: `source event missing for ${action.type} action` };
      }

      const providerTransactionId = eventProviderTransactionId(sourceEvent);
      const transaction =
        sourceEvent.kind === 'transaction_removed' ? null : sourceEvent.transaction;
      let accountId: string | null = null;
      if (transaction) {
        const { data: account, error: accountError } = await admin
          .from('accounts')
          .select('id')
          .eq('connection_id', connectionId)
          .eq('external_ref', transaction.accountExternalRef)
          .single();
        if (accountError || !account) {
          return { ok: false, detail: `unknown account ${transaction.accountExternalRef}` };
        }
        accountId = account.id;
      }

      const kind = sourceEvent.kind.replace('transaction_', '');
      const { data: normalizedId, error: normalizedError } = await admin.rpc(
        'keel_worker_create_normalized',
        {
          p_attempt_id: attemptId,
          p_owner: owner,
          p_account_id: accountId,
          p_provider_transaction_id: providerTransactionId,
          p_kind: kind,
          p_amount_minor: transaction?.amountMinor ?? null,
          p_currency: transaction?.currency ?? null,
          p_effective_date: transaction?.date ?? null,
          p_description: transaction?.description ?? null,
        },
      );
      if (normalizedError || !normalizedId) {
        return {
          ok: false,
          detail: `normalized create failed: ${normalizedError?.message ?? 'no id'}`,
        };
      }
      const economicKey =
        action.type === 'revise' ? action.next.economicKey : action.view.economicKey;
      const { error: applyError } = await admin.rpc('keel_worker_apply_action', {
        p_normalized_id: normalizedId,
        p_action_kind: action.type,
        p_economic_key: economicKey,
        p_apply_key: `${originalEconomicEventKey}:${providerTransactionId}`,
      });
      if (applyError) return { ok: false, detail: `sync apply failed: ${applyError.message}` };
    }

    const { error: completeError } = await admin.rpc('keel_worker_complete_attempt', {
      p_attempt_id: attemptId,
      p_owner: owner,
      p_next_cursor: finalNextCursor,
    });
    if (completeError) {
      return { ok: false, detail: `attempt complete failed: ${completeError.message}` };
    }
    return { ok: true, detail: 'sync complete' };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : 'unknown Plaid sync failure',
    };
  }
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
      let outcome: ProcessOutcome;
      if (msg.message.jobType === 'promote_raw_event') {
        outcome = await processPromoteJob(admin, msg);
      } else if (
        msg.message.jobType === 'enrich_transaction' ||
        msg.message.jobType === 'enrich_batch'
      ) {
        // Enrichment is a Stage 1D concern; acknowledge so queues stay clean.
        outcome = { ok: true, detail: 'enrichment deferred (stage 1D)' };
      } else if (msg.message.jobType === 'sync_notification') {
        outcome = await processSyncNotification(admin, msg);
      } else {
        outcome = { ok: false, detail: `unknown jobType ${msg.message.jobType}` };
      }

      if (outcome.ok) {
        await admin.rpc('keel_worker_queue_archive', { p_queue: queue, p_msg_id: msg.msg_id });
        results.push({ msgId: msg.msg_id, status: 'done', detail: outcome.detail });
      } else if (outcome.retry) {
        results.push({ msgId: msg.msg_id, status: 'retry', detail: outcome.detail });
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
