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
  CONFIDENCE_VERSION,
  DETECTOR_VERSION,
  NORMALIZER_VERSION,
  detectRecurringSeries,
  planEvent,
  reconcileSyncBatch,
  type CanonicalTxnView,
  type IngestState,
  type PromotionAction,
  type ProviderSyncEvent,
  type RecurringTransaction,
} from '../_shared/vendor/keel-domain.mjs';
import { json, mapDbError } from '../_shared/http.ts';
import { decryptToken, type EncryptedRecord } from '../_shared/credential-crypto.ts';
import { getKek } from '../_shared/credential-kek.ts';
import {
  createPlaidClient,
  PlaidClientError,
  ProviderBudgetExhaustedError,
} from '../_shared/plaid-client.ts';
import {
  parsePlaidSyncPage,
  PlaidMutationRestart,
  PlaidSyncTransientError,
  readSyncPages,
  type LiveSyncResult,
} from '../_shared/plaid-sync.ts';
import {
  abandonLiveSyncAttempt,
  completeSyncAttempt,
  SyncCompletionError,
} from './sync-completion.ts';

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

export const orderQueueMessages = (messages: QueueMessage[]): QueueMessage[] =>
  [...messages].sort((left, right) => left.msg_id - right.msg_id);

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

interface ReapClaim extends EncryptedRecord {
  attemptId: string;
  householdId: string;
  credentialId: string;
  plaidItemId: string;
  reapClaimId: string;
}

const processRecurringDetection = async (
  admin: AdminClient,
  msg: QueueMessage,
): Promise<ProcessOutcome> => {
  const householdId = msg.message.refs['householdId'];
  const asOfTimestamp = msg.message.refs['asOf'];
  if (!householdId || !asOfTimestamp || !/^\d{4}-\d{2}-\d{2}T/u.test(asOfTimestamp)) {
    return { ok: false, detail: 'recurring detection scope/asOf missing' };
  }
  const asOf = asOfTimestamp.slice(0, 10);
  try {
    const { data: rows, error: readError } = await admin.rpc('keel_recurring_read_txns', {
      p_household_id: householdId,
    });
    if (readError) throw new Error(`recurring read failed: ${readError.message}`);
    const candidates = detectRecurringSeries((rows ?? []) as RecurringTransaction[], { asOf });
    const { error: upsertError } = await admin.rpc('keel_recurring_upsert_candidates', {
      p_household_id: householdId,
      p_run_key: msg.message.economicEventKey,
      p_as_of: asOfTimestamp,
      p_detector_version: DETECTOR_VERSION,
      p_confidence_version: CONFIDENCE_VERSION,
      p_normalizer_version: NORMALIZER_VERSION,
      p_candidates: candidates,
    });
    if (upsertError) throw new Error(`recurring upsert failed: ${upsertError.message}`);
    await admin.rpc('keel_meter_recurring_detection', {
      p_household_id: householdId,
      p_ok: true,
      p_error_code: null,
      p_quantity: candidates.length,
    });
    return { ok: true, detail: `recurring candidates: ${candidates.length}` };
  } catch (error) {
    await admin.rpc('keel_meter_recurring_detection', {
      p_household_id: householdId,
      p_ok: false,
      p_error_code: 'detection_failed',
      p_quantity: 0,
    });
    return {
      ok: false,
      detail: error instanceof Error ? error.message : 'recurring detection failed',
    };
  }
};

/** Deterministic sign-based offset routing (Law 1: not AI). Debit-positive:
 * outflow (negative on the asset) offsets to expense (positive). Looked up by
 * stable pfc_key, never name — system categories are renameable. */
const offsetKey = (amountMinor: bigint): string =>
  amountMinor < 0n ? 'uncategorized_expense' : 'uncategorized_income';

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
      .eq('pfc_key', offsetKey(amount))
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

export const processSyncNotification = async (
  admin: AdminClient,
  msg: QueueMessage,
  readPages: typeof readSyncPages = readSyncPages,
): Promise<ProcessOutcome> => {
  let owner: string | null = null;
  let attemptId: string | null = null;
  let connectionId: string | null = null;
  let syncResult: LiveSyncResult | null = null;
  const rawPageIdByEventId = new Map<string, string>();
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

    connectionId = raw?.connection_id ?? msg.message.refs['connectionId'] ?? null;
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

    owner = continuation?.owner ?? crypto.randomUUID();
    const { data: lease, error: leaseError } = await admin.rpc('keel_worker_acquire_sync_lease', {
      p_connection_id: connectionId,
      p_owner: owner,
      p_ttl_seconds: SYNC_LEASE_TTL_S,
    });
    if (leaseError) return { ok: false, detail: `lease acquire failed: ${leaseError.message}` };
    if (!lease?.acquired) {
      const reason = String(lease?.reason ?? 'unknown');
      if (reason === 'disconnected') {
        return { ok: true, detail: 'connection disconnected; notification dropped' };
      }
      if (reason === 'reauth_required' || reason === 'disconnecting') {
        return { ok: false, detail: `sync lease unavailable: ${reason}` };
      }
      return {
        ok: false,
        retry: true,
        detail: `sync lease unavailable: ${reason}`,
      };
    }

    const baseCursor = String(lease.baseCursor ?? '');
    attemptId = continuation?.attemptId ?? null;
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
        .select('id, provider_event_id, body_text')
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
        for (const event of restored.events) {
          if (!rawPageIdByEventId.has(event.eventId)) {
            rawPageIdByEventId.set(event.eventId, archivedPage.id);
          }
        }
        finalNextCursor = restored.nextCursor;
      }
    }

    const renewLiveLease = async (): Promise<void> => {
      const { data: renewed, error: renewError } = await admin.rpc('keel_worker_renew_sync_lease', {
        p_connection_id: connectionId,
        p_owner: owner,
        p_ttl_seconds: SYNC_LEASE_TTL_S,
      });
      if (renewError || !renewed) throw new Error('sync lease lost while paging');
    };
    syncResult = await readPages(admin, connectionId, {
      baseCursor,
      externalRef: connection.external_ref,
      maxPages: MAX_PAGES_PER_INVOCATION,
      renewLease: renewLiveLease,
    });
    const pages = syncResult.pages;

    if (syncResult.source === 'injected') {
      // The injected C5b path remains authoritative and keeps its same-attempt
      // continuation plus worker-visible mutation-marker replay.
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
        const { data: renewed, error: renewError } = await admin.rpc(
          'keel_worker_renew_sync_lease',
          {
            p_connection_id: connectionId,
            p_owner: owner,
            p_ttl_seconds: SYNC_LEASE_TTL_S,
          },
        );
        if (renewError || !renewed) {
          return { ok: false, retry: true, detail: 'sync lease lost while paging' };
        }

        const { data: archivedRawEventId, error: archiveError } = await admin.rpc(
          'keel_worker_archive_page',
          {
            p_attempt_id: attemptId,
            p_owner: owner,
            p_page_ordinal: pageOrdinal,
            p_body_text: injected.bodyText,
          },
        );
        if (archiveError || !archivedRawEventId) {
          return {
            ok: false,
            detail: `page archive failed: ${archiveError?.message ?? 'no raw page id'}`,
          };
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
          for (const event of parsed.events) {
            if (!rawPageIdByEventId.has(event.eventId)) {
              rawPageIdByEventId.set(event.eventId, archivedRawEventId);
            }
          }
          finalNextCursor = parsed.nextCursor;
          for (const skipped of parsed.skippedTransactions) {
            const { error: skipError } = await admin.rpc('keel_worker_record_ingestion_skip', {
              p_raw_event_id: archivedRawEventId,
              p_provider_transaction_id: skipped.providerTransactionId,
              p_currency: skipped.currency,
              p_reason: 'non_usd',
            });
            if (skipError) {
              return { ok: false, detail: `ingestion skip record failed: ${skipError.message}` };
            }
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
          rawPageIdByEventId.clear();
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
    } else if (syncResult.source === 'live') {
      let pageOrdinal = 0;
      for (const livePage of pages) {
        await renewLiveLease();
        const { data: archivedRawEventId, error: archiveError } = await admin.rpc(
          'keel_worker_archive_page',
          {
            p_attempt_id: attemptId,
            p_owner: owner,
            p_page_ordinal: pageOrdinal,
            p_body_text: livePage.bodyText,
          },
        );
        if (archiveError || !archivedRawEventId) {
          throw new Error(`page archive failed: ${archiveError?.message ?? 'no raw page id'}`);
        }

        const parsed = await parsePlaidSyncPage(
          livePage.bodyText,
          connection.external_ref,
          finalNextCursor,
        );
        allEvents.push(...parsed.events);
        for (const event of parsed.events) {
          if (!rawPageIdByEventId.has(event.eventId)) {
            rawPageIdByEventId.set(event.eventId, archivedRawEventId);
          }
        }
        finalNextCursor = parsed.nextCursor;
        for (const skipped of parsed.skippedTransactions) {
          const { error: skipError } = await admin.rpc('keel_worker_record_ingestion_skip', {
            p_raw_event_id: archivedRawEventId,
            p_provider_transaction_id: skipped.providerTransactionId,
            p_currency: skipped.currency,
            p_reason: 'non_usd',
          });
          if (skipError) {
            throw new Error(`ingestion skip record failed: ${skipError.message}`);
          }
        }
        pageOrdinal += 1;
      }
      finalNextCursor = syncResult.nextCursor;
    } else {
      finalNextCursor = syncResult.nextCursor;
    }

    const sourceFailure = (detail: string): ProcessOutcome => {
      if (syncResult?.source !== 'injected') throw new Error(detail);
      return { ok: false, detail };
    };

    const touchedProviderIds = [...new Set(allEvents.map(eventProviderTransactionId))];
    const { data: stateRows, error: stateError } = await admin.rpc('keel_worker_lookup_state', {
      p_connection_id: connectionId,
      p_provider_txn_ids: touchedProviderIds,
    });
    if (stateError) return sourceFailure(`state lookup failed: ${stateError.message}`);

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
      await renewLiveLease();
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
        return sourceFailure(`source event missing for ${action.type} action`);
      }
      const sourceRawEventId = rawPageIdByEventId.get(sourceEvent.eventId);
      if (!sourceRawEventId) {
        return sourceFailure(`raw page missing for ${action.type} action`);
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
          return sourceFailure(`unknown account ${transaction.accountExternalRef}`);
        }
        accountId = account.id;
      }

      const kind = sourceEvent.kind.replace('transaction_', '');
      const { data: normalizedId, error: normalizedError } = await admin.rpc(
        'keel_worker_create_normalized',
        {
          p_attempt_id: attemptId,
          p_owner: owner,
          p_raw_event_id: sourceRawEventId,
          p_account_id: accountId,
          p_provider_transaction_id: providerTransactionId,
          p_kind: kind,
          p_amount_minor: transaction?.amountMinor ?? null,
          p_currency: transaction?.currency ?? null,
          p_effective_date: transaction?.date ?? null,
          p_description: transaction?.description ?? null,
          p_pending: transaction?.pending ?? false,
        },
      );
      if (normalizedError || !normalizedId) {
        return sourceFailure(`normalized create failed: ${normalizedError?.message ?? 'no id'}`);
      }
      const economicKey =
        action.type === 'revise' ? action.next.economicKey : action.view.economicKey;
      const { error: applyError } = await admin.rpc('keel_worker_apply_action', {
        p_normalized_id: normalizedId,
        p_action_kind: action.type,
        p_economic_key: economicKey,
        p_apply_key: `${originalEconomicEventKey}:${providerTransactionId}`,
      });
      if (applyError) return sourceFailure(`sync apply failed: ${applyError.message}`);
    }

    await renewLiveLease();
    if (syncResult.source === 'injected') {
      const { error: completeError } = await admin.rpc('keel_worker_complete_attempt', {
        p_attempt_id: attemptId,
        p_owner: owner,
        p_next_cursor: finalNextCursor,
        p_fully_synced: true,
      });
      if (completeError) {
        return { ok: false, detail: `attempt complete failed: ${completeError.message}` };
      }
    } else {
      await completeSyncAttempt(admin, {
        attemptId,
        owner,
        connectionId,
        nextCursor: finalNextCursor,
        status: syncResult.status,
      });
    }
    return {
      ok: true,
      detail:
        syncResult.status === 'partial'
          ? 'live sync continuation enqueued'
          : syncResult.status === 'noop'
            ? 'sync noop'
        : 'sync complete',
    };
  } catch (error) {
    const liveFailure = syncResult?.source !== 'injected';
    const reauthCode = error instanceof PlaidSyncTransientError ? error.reauthCode : null;
    const attemptAlreadyCompleted = error instanceof SyncCompletionError && error.attemptCompleted;
    if (liveFailure && !attemptAlreadyCompleted && attemptId !== null && owner !== null) {
      try {
        await abandonLiveSyncAttempt(admin, { attemptId, owner });
      } catch {
        return { ok: false, retry: true, detail: 'live sync cleanup failed' };
      }
    }
    if (reauthCode !== null && connectionId !== null) {
      const { error: reauthError } = await admin.rpc('keel_set_connection_reauth', {
        p_connection_id: connectionId,
        p_event_type: reauthCode,
        p_required: true,
      });
      if (reauthError) {
        return { ok: false, retry: true, detail: 'connection reauthentication update failed' };
      }
      return {
        ok: false,
        detail: `Plaid sync requires reauthentication (${reauthCode})`,
      };
    }
    return {
      ok: false,
      ...(liveFailure ? { retry: true } : {}),
      detail: error instanceof Error ? error.message : 'unknown Plaid sync failure',
    };
  }
};

const processReapLinks = async (admin: AdminClient): Promise<Response> => {
  const { data, error } = await admin.rpc('keel_reap_orphan_link_attempts', {});
  if (error) return mapDbError(error);
  const claims = (data ?? []) as ReapClaim[];
  const processed: Array<{ attemptId: string; removed: boolean; errorCode: string | null }> = [];

  for (const claim of claims.slice(0, 25)) {
    const plaid = createPlaidClient(admin, {
      env: Deno.env.get('PLAID_ENV') ?? 'sandbox',
      clientId: Deno.env.get('PLAID_CLIENT_ID'),
      secret: Deno.env.get('PLAID_SECRET'),
      householdId: claim.householdId,
    });
    let removed = false;
    let errorCode: string | null = null;
    try {
      const token = await decryptToken(
        claim,
        claim.credentialId,
        claim.householdId,
        'plaid',
        getKek(claim.kekVersion),
      );
      removed = await plaid.itemRemove(claim.attemptId, { access_token: token });
    } catch (claimError) {
      errorCode =
        claimError instanceof ProviderBudgetExhaustedError
          ? 'provider_budget_exhausted'
          : claimError instanceof PlaidClientError
            ? (claimError.errorCode ?? 'provider_error')
        : 'credential_decrypt_failed';
    }

    const { error: markError } = await admin.rpc('keel_mark_link_attempt_reaped', {
      p_attempt_id: claim.attemptId,
      p_reap_claim_id: claim.reapClaimId,
      p_removed: removed,
      p_error: errorCode,
    });
    if (markError) return mapDbError(markError);
    processed.push({ attemptId: claim.attemptId, removed, errorCode });
  }
  return json(200, { processed });
};

// Provider balances are 2-decimal fiat and arrive already JSON-parsed (no raw
// lexeme available from accountsGet), so we anchor to minor units by rounding.
// This is the opening-balance anchor only — per-transaction economics stay
// lexeme-lossless. Safe for realistic magnitudes (well within 2^53).
const dollarsToMinor = (value: unknown): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.round(value * 100);
};

interface BalanceCredential {
  credentialId: string;
  householdId: string;
  kekVersion: number;
}

const processRefreshBalances = async (admin: AdminClient): Promise<Response> => {
  const { data: conns, error } = await admin
    .from('connections')
    .select('id, household_id')
    .eq('provider', 'plaid')
    .eq('status', 'active');
  if (error) return mapDbError(error);

  const results: Array<{ connectionId: string; accounts: number; error?: string }> = [];
  for (const c of (conns ?? []) as Array<{ id: string; household_id: string }>) {
    try {
      const { data: envData } = await admin.rpc('keel_get_connection_credential_envelope', {
        p_connection_id: c.id,
      });
      if (!envData) {
        results.push({ connectionId: c.id, accounts: 0, error: 'no_credential' });
        continue;
      }
      const envelope = envData as BalanceCredential & Record<string, unknown>;
      const token = await decryptToken(
        envelope as unknown as EncryptedRecord,
        envelope.credentialId,
        c.household_id,
        'plaid',
        getKek(envelope.kekVersion),
      );
      const plaid = createPlaidClient(admin, {
        env: Deno.env.get('PLAID_ENV') ?? 'sandbox',
        clientId: Deno.env.get('PLAID_CLIENT_ID'),
        secret: Deno.env.get('PLAID_SECRET'),
        householdId: c.household_id,
      });
      const body = (await plaid.accountsGet(c.id, { access_token: token })) as {
        accounts?: Array<{
          account_id?: string;
          balances?: {
            current?: unknown;
            available?: unknown;
            iso_currency_code?: unknown;
          };
        }>;
      };
      const { data: dbAccts } = await admin
        .from('accounts')
        .select('id, external_ref')
        .eq('connection_id', c.id);
      const byRef = new Map(
        ((dbAccts ?? []) as Array<{ id: string; external_ref: string | null }>).map((a) => [
          a.external_ref,
          a.id,
        ]),
      );

      let applied = 0;
      for (const acct of body.accounts ?? []) {
        const accountId = typeof acct.account_id === 'string' ? byRef.get(acct.account_id) : undefined;
        if (!accountId) continue;
        const currentMinor = dollarsToMinor(acct.balances?.current);
        if (currentMinor === null) continue;
        const availableMinor = dollarsToMinor(acct.balances?.available);
        const currency =
          typeof acct.balances?.iso_currency_code === 'string'
            ? acct.balances.iso_currency_code
            : 'USD';
        const { error: applyErr } = await admin.rpc('keel_apply_account_balance', {
          p_household_id: c.household_id,
          p_account_id: accountId,
          p_current_minor: currentMinor,
          p_available_minor: availableMinor,
          p_currency: currency,
          p_as_of: new Date().toISOString(),
        });
        if (!applyErr) applied++;
      }
      results.push({ connectionId: c.id, accounts: applied });
    } catch (e) {
      results.push({
        connectionId: c.id,
        accounts: 0,
        error: e instanceof Error ? e.message : 'error',
      });
    }
  }

  // Deterministic classification passes for whatever the drain just landed:
  // PFC auto-categorization (never overrides user edits) and transfer-pair
  // SUGGESTIONS (nothing excluded until the user confirms). Best-effort —
  // a failure here must not fail the balance refresh; the next 3-min cycle
  // retries.
  const households = [...new Set(
    ((conns ?? []) as Array<{ household_id: string }>).map((c) => c.household_id),
  )];
  const classified: Array<{ householdId: string; categorized?: number; transfers?: number }> = [];
  for (const householdId of households) {
    const entry: { householdId: string; categorized?: number; transfers?: number } = {
      householdId,
    };
    // Rules first (user intent beats provider hints; user edits beat both —
    // the proc's upsert predicate enforces the lattice), then PFC fills the
    // remainder. Best-effort: keel_apply_rules may not exist until the rules
    // migration lands.
    await admin.rpc('keel_apply_rules', { p_household_id: householdId, p_dry_run: false });
    const { data: categorized, error: catErr } = await admin.rpc(
      'keel_autocategorize_household',
      { p_household_id: householdId },
    );
    if (!catErr && typeof categorized === 'number') entry.categorized = categorized;
    const { data: transfers, error: trErr } = await admin.rpc('keel_detect_transfers', {
      p_household_id: householdId,
    });
    if (!trErr && typeof transfers === 'number') entry.transfers = transfers;
    classified.push(entry);
  }

  return json(200, { refreshed: results, classified });
};

export default {
  fetch: withSupabase({ auth: 'secret:automations', env: keelSecretKeys() }, async (req, ctx) => {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/worker/, '');

    if (req.method === 'GET' && path === '/health') {
      return json(200, { ok: true, service: 'worker' });
    }
    if (req.method === 'POST' && path === '/reap-links') {
      return processReapLinks(ctx.supabaseAdmin);
    }
    if (req.method === 'POST' && path === '/refresh-balances') {
      return processRefreshBalances(ctx.supabaseAdmin);
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
    for (const msg of orderQueueMessages((messages ?? []) as QueueMessage[])) {
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
      } else if (msg.message.jobType === 'recurring_detection') {
        outcome = await processRecurringDetection(admin, msg);
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
