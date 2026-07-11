import {
  parseMinorUnits,
  type ProviderSyncEvent,
  type ProviderTransaction,
  type SyncPage,
} from '@keel/contracts';
import type { CanonicalTxnView, IngestState } from './state.js';

export type PromotionAction =
  | { type: 'create'; view: CanonicalTxnView }
  | {
      type: 'revise';
      reason: 'supersession' | 'provider_modified';
      prev: CanonicalTxnView;
      next: CanonicalTxnView;
    }
  | { type: 'void'; reason: 'provider_removed'; view: CanonicalTxnView }
  | {
      type: 'noop';
      reason: 'duplicate' | 'unknown_target' | 'already_applied';
    };

export interface IngestContext {
  provider: string;
  connectionExternalRef: string;
}

export interface PlanEventResult {
  action: PromotionAction;
  nextState: IngestState;
}

export interface PlanStreamResult {
  actions: PromotionAction[];
  nextState: IngestState;
}

export interface CanonicalTxnProjection {
  economicKey: string;
  accountExternalRef: string;
  amountMinor: string;
  status: CanonicalTxnView['status'];
  description: string;
}

export interface CanonicalStateProjection {
  transactions: CanonicalTxnProjection[];
}

const economicKeyFor = (providerTransactionId: string, ctx: IngestContext): string =>
  `txn:${ctx.provider}:${ctx.connectionExternalRef}:${providerTransactionId}`;

const viewFromTransaction = (
  transaction: ProviderTransaction,
  economicKey: string,
  status: CanonicalTxnView['status'] = transaction.pending ? 'pending' : 'posted',
): CanonicalTxnView => ({
  economicKey,
  providerTransactionId: transaction.providerTransactionId,
  accountExternalRef: transaction.accountExternalRef,
  amountMinor: parseMinorUnits(transaction.amountMinor),
  status,
  description: transaction.description,
  effectiveDate: transaction.date,
});

const sameView = (left: CanonicalTxnView, right: CanonicalTxnView): boolean =>
  left.economicKey === right.economicKey &&
  left.providerTransactionId === right.providerTransactionId &&
  left.accountExternalRef === right.accountExternalRef &&
  left.amountMinor === right.amountMinor &&
  left.status === right.status &&
  left.description === right.description &&
  left.effectiveDate === right.effectiveDate;

const replaceEconomicView = (
  state: IngestState,
  next: CanonicalTxnView,
  additionalProviderTxnId?: string,
): IngestState => {
  const byProviderTxnId = new Map(state.byProviderTxnId);

  for (const [providerTransactionId, current] of byProviderTxnId) {
    if (current.economicKey === next.economicKey) {
      byProviderTxnId.set(providerTransactionId, next);
    }
  }
  if (additionalProviderTxnId !== undefined) {
    byProviderTxnId.set(additionalProviderTxnId, next);
  }

  return { byProviderTxnId };
};

const planAdded = (
  state: IngestState,
  event: Extract<ProviderSyncEvent, { kind: 'transaction_added' }>,
  ctx: IngestContext,
): PlanEventResult => {
  const transaction = event.transaction;
  const known = state.byProviderTxnId.get(transaction.providerTransactionId);

  if (known !== undefined) {
    const delivered = viewFromTransaction(transaction, known.economicKey);
    return sameView(known, delivered)
      ? { action: { type: 'noop', reason: 'duplicate' }, nextState: state }
      : { action: { type: 'noop', reason: 'already_applied' }, nextState: state };
  }

  if (transaction.pendingTransactionId !== null) {
    const pending = state.byProviderTxnId.get(transaction.pendingTransactionId);
    if (pending?.status === 'pending') {
      const next = viewFromTransaction(transaction, pending.economicKey, 'posted');
      return {
        action: {
          type: 'revise',
          reason: 'supersession',
          prev: pending,
          next,
        },
        nextState: replaceEconomicView(state, next, transaction.providerTransactionId),
      };
    }
  }

  const created = viewFromTransaction(
    transaction,
    economicKeyFor(transaction.providerTransactionId, ctx),
  );
  const byProviderTxnId = new Map(state.byProviderTxnId);
  byProviderTxnId.set(transaction.providerTransactionId, created);

  return {
    action: { type: 'create', view: created },
    nextState: { byProviderTxnId },
  };
};

const planModified = (
  state: IngestState,
  event: Extract<ProviderSyncEvent, { kind: 'transaction_modified' }>,
): PlanEventResult => {
  const transaction = event.transaction;
  const prev = state.byProviderTxnId.get(transaction.providerTransactionId);

  if (prev === undefined) {
    return { action: { type: 'noop', reason: 'unknown_target' }, nextState: state };
  }
  if (
    prev.status === 'voided' ||
    prev.providerTransactionId !== transaction.providerTransactionId
  ) {
    return { action: { type: 'noop', reason: 'already_applied' }, nextState: state };
  }

  const next = viewFromTransaction(transaction, prev.economicKey);
  if (sameView(prev, next)) {
    return { action: { type: 'noop', reason: 'duplicate' }, nextState: state };
  }

  return {
    action: { type: 'revise', reason: 'provider_modified', prev, next },
    nextState: replaceEconomicView(state, next),
  };
};

const planRemoved = (
  state: IngestState,
  event: Extract<ProviderSyncEvent, { kind: 'transaction_removed' }>,
): PlanEventResult => {
  const current = state.byProviderTxnId.get(event.providerTransactionId);

  if (current === undefined) {
    return { action: { type: 'noop', reason: 'unknown_target' }, nextState: state };
  }
  if (current.status === 'voided') {
    return { action: { type: 'noop', reason: 'already_applied' }, nextState: state };
  }

  const voided: CanonicalTxnView = { ...current, status: 'voided' };
  return {
    action: { type: 'void', reason: 'provider_removed', view: voided },
    nextState: replaceEconomicView(state, voided),
  };
};

export const planEvent = (
  state: IngestState,
  event: ProviderSyncEvent,
  ctx: IngestContext,
): PlanEventResult => {
  switch (event.kind) {
    case 'transaction_added':
      return planAdded(state, event, ctx);
    case 'transaction_modified':
      return planModified(state, event);
    case 'transaction_removed':
      return planRemoved(state, event);
  }
};

export const planStream = (
  state: IngestState,
  pages: readonly SyncPage[],
  ctx: IngestContext,
): PlanStreamResult => {
  const actions: PromotionAction[] = [];
  let nextState = state;

  for (const page of pages) {
    for (const event of page.events) {
      const planned = planEvent(nextState, event, ctx);
      actions.push(planned.action);
      nextState = planned.nextState;
    }
  }

  return { actions, nextState };
};

export const projectCanonicalState = (state: IngestState): CanonicalStateProjection => {
  const byEconomicKey = new Map<string, CanonicalTxnProjection>();

  for (const view of state.byProviderTxnId.values()) {
    byEconomicKey.set(view.economicKey, {
      economicKey: view.economicKey,
      accountExternalRef: view.accountExternalRef,
      amountMinor: view.amountMinor.toString(),
      status: view.status,
      description: view.description,
    });
  }

  return {
    transactions: [...byEconomicKey.values()].sort((left, right) =>
      left.economicKey.localeCompare(right.economicKey),
    ),
  };
};
