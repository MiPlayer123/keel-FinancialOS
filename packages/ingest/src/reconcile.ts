import type { ProviderSyncEvent } from '@keel/contracts';
import { planEvent, type IngestContext, type PromotionAction } from './plan.js';
import type { IngestState } from './state.js';

type AddedEvent = Extract<ProviderSyncEvent, { kind: 'transaction_added' }>;
type ModifiedEvent = Extract<ProviderSyncEvent, { kind: 'transaction_modified' }>;
type RemovedEvent = Extract<ProviderSyncEvent, { kind: 'transaction_removed' }>;

const targetId = (event: ProviderSyncEvent): string =>
  event.kind === 'transaction_removed'
    ? event.providerTransactionId
    : event.transaction.providerTransactionId;

const eventKey = (event: ProviderSyncEvent): string =>
  `${targetId(event)}\u0000${event.kind}\u0000${event.eventId}\u0000${JSON.stringify(event)}`;

const compareEvents = (left: ProviderSyncEvent, right: ProviderSyncEvent): number =>
  eventKey(left).localeCompare(eventKey(right));

const uniqueSortedEvents = (events: readonly ProviderSyncEvent[]): ProviderSyncEvent[] => {
  const sorted = [...events].sort(compareEvents);
  const seenEventIds = new Set<string>();

  return sorted.filter((event) => {
    if (seenEventIds.has(event.eventId)) {
      return false;
    }
    seenEventIds.add(event.eventId);
    return true;
  });
};

const foldEvents = (
  events: readonly ProviderSyncEvent[],
  actions: PromotionAction[],
  state: IngestState,
  ctx: IngestContext,
): IngestState => {
  let nextState = state;

  for (const event of events) {
    const planned = planEvent(nextState, event, ctx);
    actions.push(planned.action);
    nextState = planned.nextState;
  }

  return nextState;
};

/**
 * Reconcile a completed Plaid sync attempt's full add/modify/remove set as a
 * batch (D-D). `ctx` MUST carry the real provider + connection item ref so the
 * economic keys match `txn:plaid:<item>:<providerTxnId>` — it is not optional.
 */
export const reconcileSyncBatch = (
  events: readonly ProviderSyncEvent[],
  priorState: IngestState,
  ctx: IngestContext,
): { actions: PromotionAction[]; nextState: IngestState } => {
  const batch = uniqueSortedEvents(events);
  const addedEvents = batch.filter(
    (event): event is AddedEvent => event.kind === 'transaction_added',
  );
  const modifiedEvents = batch.filter(
    (event): event is ModifiedEvent => event.kind === 'transaction_modified',
  );
  const removedEvents = batch.filter(
    (event): event is RemovedEvent => event.kind === 'transaction_removed',
  );

  const removedTransactionIds = new Set(
    removedEvents.map((event) => event.providerTransactionId),
  );
  const pairedAddsByPendingId = new Map<string, AddedEvent>();

  for (const event of addedEvents) {
    const pendingTransactionId = event.transaction.pendingTransactionId;
    if (
      pendingTransactionId !== null &&
      removedTransactionIds.has(pendingTransactionId) &&
      !pairedAddsByPendingId.has(pendingTransactionId)
    ) {
      pairedAddsByPendingId.set(pendingTransactionId, event);
    }
  }

  const pairedAdds = new Set(pairedAddsByPendingId.values());
  const pairedPendingIds = new Set(pairedAddsByPendingId.keys());
  const unpairedAdds = addedEvents.filter((event) => !pairedAdds.has(event));
  const unpairedRemovals = removedEvents.filter(
    (event) => !pairedPendingIds.has(event.providerTransactionId),
  );

  const actions: PromotionAction[] = [];
  let nextState = foldEvents(unpairedAdds, actions, priorState, ctx);
  nextState = foldEvents([...pairedAdds].sort(compareEvents), actions, nextState, ctx);
  nextState = foldEvents(modifiedEvents, actions, nextState, ctx);
  nextState = foldEvents(unpairedRemovals, actions, nextState, ctx);

  return { actions, nextState };
};
