import type { ProviderSyncEvent, ProviderTransaction } from '@keel/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  emptyIngestState,
  projectCanonicalState,
  reconcileSyncBatch,
  type CanonicalTxnView,
  type IngestState,
} from '@keel/ingest';

const CTX = { provider: 'plaid', connectionExternalRef: 'plaid-item-alpha' } as const;

const transaction = (
  providerTransactionId: string,
  overrides: Partial<ProviderTransaction> = {},
): ProviderTransaction => ({
  providerTransactionId,
  accountExternalRef: 'plaid-checking',
  amountMinor: '-1250',
  currency: 'USD',
  date: '2026-06-01',
  description: 'Harbor Grocery',
  pending: false,
  pendingTransactionId: null,
  ...overrides,
});

const added = (value: ProviderTransaction): ProviderSyncEvent => ({
  kind: 'transaction_added',
  eventId: `add-${value.providerTransactionId}`,
  transaction: value,
});

const removed = (providerTransactionId: string): ProviderSyncEvent => ({
  kind: 'transaction_removed',
  eventId: `remove-${providerTransactionId}`,
  providerTransactionId,
});

const pendingView = (providerTransactionId = 'pending-p'): CanonicalTxnView => ({
  economicKey: `txn:plaid:connection-1:${providerTransactionId}`,
  providerTransactionId,
  accountExternalRef: 'plaid-checking',
  amountMinor: -1000n,
  status: 'pending',
  description: 'Harbor Grocery authorization',
  effectiveDate: '2026-05-31',
});

const stateWith = (...views: CanonicalTxnView[]): IngestState => ({
  byProviderTxnId: new Map(views.map((view) => [view.providerTransactionId, view])),
});

describe('reconcileSyncBatch', () => {
  it('pairs a pending add with its removed and posted add in the same batch', () => {
    const pending = transaction('pending-p', {
      amountMinor: '-1000',
      pending: true,
      description: 'Harbor Grocery authorization',
    });
    const posted = transaction('posted-q', {
      amountMinor: '-1125',
      pendingTransactionId: 'pending-p',
      description: 'Harbor Grocery posted',
    });

    const result = reconcileSyncBatch(
      [added(pending), removed('pending-p'), added(posted)],
      emptyIngestState(),
      CTX,
    );

    expect(result.actions.filter((action) => action.type === 'revise')).toHaveLength(1);
    expect(result.actions.filter((action) => action.type === 'void')).toHaveLength(0);
    expect(result.actions.filter((action) => action.type === 'create')).toHaveLength(1);
    expect(result.nextState.byProviderTxnId.get('pending-p')).toMatchObject({
      providerTransactionId: 'posted-q',
      status: 'posted',
      amountMinor: -1125n,
      description: 'Harbor Grocery posted',
    });
    expect(result.nextState.byProviderTxnId.get('posted-q')).toEqual(
      result.nextState.byProviderTxnId.get('pending-p'),
    );
    expect(projectCanonicalState(result.nextState).transactions).toHaveLength(1);
  });

  it('supersedes a pending transaction promoted in a prior attempt without voiding it', () => {
    const pending = pendingView();
    const posted = transaction('posted-q', {
      amountMinor: '-1125',
      pendingTransactionId: pending.providerTransactionId,
      description: 'Harbor Grocery posted',
    });

    const result = reconcileSyncBatch(
      [removed(pending.providerTransactionId), added(posted)],
      stateWith(pending),
      CTX,
    );

    expect(result.actions).toEqual([
      {
        type: 'revise',
        reason: 'supersession',
        prev: pending,
        next: {
          ...pending,
          providerTransactionId: 'posted-q',
          amountMinor: -1125n,
          status: 'posted',
          description: 'Harbor Grocery posted',
          effectiveDate: '2026-06-01',
        },
      },
    ]);
    expect(projectCanonicalState(result.nextState).transactions).toEqual([
      {
        economicKey: pending.economicKey,
        accountExternalRef: 'plaid-checking',
        amountMinor: '-1125',
        status: 'posted',
        description: 'Harbor Grocery posted',
      },
    ]);
  });

  it('treats an unpaired removal as a true void', () => {
    const existing = { ...pendingView(), status: 'posted' as const };

    const result = reconcileSyncBatch(
      [removed(existing.providerTransactionId)],
      stateWith(existing),
      CTX,
    );

    expect(result.actions).toEqual([
      {
        type: 'void',
        reason: 'provider_removed',
        view: { ...existing, status: 'voided' },
      },
    ]);
    expect(result.nextState.byProviderTxnId.get(existing.providerTransactionId)?.status).toBe(
      'voided',
    );
  });

  it('is independent of whether the posted add precedes or follows the removal', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.integer({ min: -1_000_000, max: 1_000_000 }),
        (addedFirst, amountMinor) => {
          const pending = pendingView();
          const postedEvent = added(
            transaction('posted-q', {
              amountMinor: amountMinor.toString(),
              pendingTransactionId: pending.providerTransactionId,
            }),
          );
          const removedEvent = removed(pending.providerTransactionId);
          const orderedEvents = addedFirst
            ? [postedEvent, removedEvent]
            : [removedEvent, postedEvent];
          const reversedEvents = [...orderedEvents].reverse();

          expect(reconcileSyncBatch(orderedEvents, stateWith(pending), CTX)).toEqual(
            reconcileSyncBatch(reversedEvents, stateWith(pending), CTX),
          );
        },
      ),
    );
  });

  it('creates independent adds and noops every event when replayed', () => {
    const events = [
      added(transaction('txn-c', { amountMinor: '-300' })),
      added(transaction('txn-a', { amountMinor: '-100' })),
      added(transaction('txn-b', { amountMinor: '-200' })),
    ];

    const first = reconcileSyncBatch(events, emptyIngestState(), CTX);
    const replay = reconcileSyncBatch(events, first.nextState, CTX);

    expect(first.actions).toHaveLength(3);
    expect(first.actions.every((action) => action.type === 'create')).toBe(true);
    expect(projectCanonicalState(first.nextState).transactions).toHaveLength(3);
    expect(replay.actions).toHaveLength(3);
    expect(replay.actions.every((action) => action.type === 'noop')).toBe(true);
    expect(replay.nextState).toEqual(first.nextState);
  });

  it('projects the reconciled canonical state by economic identity', () => {
    const pending = pendingView();
    const independent = transaction('independent-r', {
      accountExternalRef: 'plaid-savings',
      amountMinor: '25000',
      description: 'Interest payment',
    });
    const posted = transaction('posted-q', {
      amountMinor: '-1125',
      pendingTransactionId: pending.providerTransactionId,
      description: 'Harbor Grocery posted',
    });

    const result = reconcileSyncBatch(
      [added(independent), removed(pending.providerTransactionId), added(posted)],
      stateWith(pending),
      CTX,
    );

    expect(projectCanonicalState(result.nextState)).toEqual({
      transactions: [
        {
          economicKey: pending.economicKey,
          accountExternalRef: 'plaid-checking',
          amountMinor: '-1125',
          status: 'posted',
          description: 'Harbor Grocery posted',
        },
        {
          economicKey: 'txn:plaid:plaid-item-alpha:independent-r',
          accountExternalRef: 'plaid-savings',
          amountMinor: '25000',
          status: 'posted',
          description: 'Interest payment',
        },
      ],
    });
  });
});
