import type { ProviderSyncEvent, ProviderTransaction, SyncPage } from '@keel/contracts';
import { describe, expect, it } from 'vitest';
import {
  emptyIngestState,
  planEvent,
  planStream,
  projectCanonicalState,
  type CanonicalTxnView,
  type IngestState,
} from '@keel/ingest';

const CTX = { provider: 'simulator', connectionExternalRef: 'sim-conn-alpha' };

const transaction = (
  providerTransactionId: string,
  overrides: Partial<ProviderTransaction> = {},
): ProviderTransaction => ({
  providerTransactionId,
  accountExternalRef: 'sim-acct-checking',
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

const modified = (value: ProviderTransaction): ProviderSyncEvent => ({
  kind: 'transaction_modified',
  eventId: `modify-${value.providerTransactionId}`,
  transaction: value,
});

const removed = (providerTransactionId: string): ProviderSyncEvent => ({
  kind: 'transaction_removed',
  eventId: `remove-${providerTransactionId}`,
  providerTransactionId,
});

const stateWith = (...views: CanonicalTxnView[]): IngestState => ({
  byProviderTxnId: new Map(views.map((view) => [view.providerTransactionId, view])),
});

const view = (overrides: Partial<CanonicalTxnView> = {}): CanonicalTxnView => ({
  economicKey: 'txn:simulator:sim-conn-alpha:txn-1',
  providerTransactionId: 'txn-1',
  accountExternalRef: 'sim-acct-checking',
  amountMinor: -1250n,
  status: 'posted',
  description: 'Harbor Grocery',
  effectiveDate: '2026-06-01',
  ...overrides,
});

describe('planEvent', () => {
  it('creates an unseen ADDED transaction with the production economic key', () => {
    const result = planEvent(emptyIngestState(), added(transaction('txn-1')), CTX);

    expect(result.action).toEqual({ type: 'create', view: view() });
    expect(result.nextState.byProviderTxnId.get('txn-1')).toEqual(view());
  });

  it('noops an identical ADDED re-delivery as duplicate', () => {
    const existing = view();
    const result = planEvent(stateWith(existing), added(transaction('txn-1')), CTX);

    expect(result.action).toEqual({ type: 'noop', reason: 'duplicate' });
    expect(result.nextState.byProviderTxnId.get('txn-1')).toBe(existing);
  });

  it('revises a known pending transaction on ADDED supersession and aliases both IDs', () => {
    const pending = view({ status: 'pending', description: 'Harbor Grocery authorization' });
    const posted = transaction('txn-posted', {
      pendingTransactionId: 'txn-1',
      description: 'Harbor Grocery',
    });

    const result = planEvent(stateWith(pending), added(posted), CTX);
    const next = view({ providerTransactionId: 'txn-posted' });

    expect(result.action).toEqual({
      type: 'revise',
      reason: 'supersession',
      prev: pending,
      next,
    });
    expect(result.nextState.byProviderTxnId.get('txn-1')).toEqual(next);
    expect(result.nextState.byProviderTxnId.get('txn-posted')).toEqual(next);
    expect(projectCanonicalState(result.nextState).transactions).toHaveLength(1);
  });

  it('revises a known materially changed MODIFIED transaction', () => {
    const existing = view();
    const changed = transaction('txn-1', {
      amountMinor: '-1499',
      description: 'Harbor Grocery corrected',
    });

    const result = planEvent(stateWith(existing), modified(changed), CTX);
    const next = view({ amountMinor: -1499n, description: 'Harbor Grocery corrected' });

    expect(result.action).toEqual({
      type: 'revise',
      reason: 'provider_modified',
      prev: existing,
      next,
    });
    expect(result.nextState.byProviderTxnId.get('txn-1')).toEqual(next);
  });

  it('noops a MODIFIED event with an unknown target', () => {
    const result = planEvent(emptyIngestState(), modified(transaction('missing')), CTX);

    expect(result.action).toEqual({ type: 'noop', reason: 'unknown_target' });
    expect(result.nextState.byProviderTxnId.size).toBe(0);
  });

  it('voids a known non-voided REMOVED transaction', () => {
    const existing = view();
    const result = planEvent(stateWith(existing), removed('txn-1'), CTX);
    const voided = view({ status: 'voided' });

    expect(result.action).toEqual({
      type: 'void',
      reason: 'provider_removed',
      view: voided,
    });
    expect(result.nextState.byProviderTxnId.get('txn-1')).toEqual(voided);
  });

  it('noops a REMOVED event with an unknown target', () => {
    const result = planEvent(emptyIngestState(), removed('missing'), CTX);

    expect(result.action).toEqual({ type: 'noop', reason: 'unknown_target' });
    expect(result.nextState.byProviderTxnId.size).toBe(0);
  });

  it('noops a REMOVED event whose target is already voided', () => {
    const existing = view({ status: 'voided' });
    const result = planEvent(stateWith(existing), removed('txn-1'), CTX);

    expect(result.action).toEqual({ type: 'noop', reason: 'already_applied' });
    expect(result.nextState.byProviderTxnId.get('txn-1')).toBe(existing);
  });

  it('treats an identical known MODIFIED event as a duplicate', () => {
    const existing = view();
    const result = planEvent(stateWith(existing), modified(transaction('txn-1')), CTX);

    expect(result.action).toEqual({ type: 'noop', reason: 'duplicate' });
  });
});

describe('stream planning and projection', () => {
  it('folds pages and events in order', () => {
    const pages: SyncPage[] = [
      {
        provider: 'simulator',
        events: [added(transaction('txn-1', { pending: true }))],
        nextCursor: '1',
        hasMore: true,
      },
      {
        provider: 'simulator',
        events: [
          modified(transaction('txn-1', { pending: true, amountMinor: '-1300' })),
          removed('txn-1'),
        ],
        nextCursor: '2',
        hasMore: false,
      },
    ];

    const result = planStream(emptyIngestState(), pages, CTX);

    expect(result.actions.map((action) => action.type)).toEqual(['create', 'revise', 'void']);
    expect(result.nextState.byProviderTxnId.get('txn-1')?.status).toBe('voided');
  });

  it('tolerates transactions arriving out of effective-date order', () => {
    const pages: SyncPage[] = [
      {
        provider: 'simulator',
        events: [
          added(transaction('txn-newest', { date: '2026-06-03' })),
          added(transaction('txn-oldest', { date: '2026-06-01' })),
          added(transaction('txn-middle', { date: '2026-06-02' })),
        ],
        nextCursor: '1',
        hasMore: false,
      },
    ];

    const result = planStream(emptyIngestState(), pages, CTX);

    expect(
      projectCanonicalState(result.nextState).transactions.map(
        (transactionView) => transactionView.economicKey,
      ),
    ).toEqual([
      'txn:simulator:sim-conn-alpha:txn-middle',
      'txn:simulator:sim-conn-alpha:txn-newest',
      'txn:simulator:sim-conn-alpha:txn-oldest',
    ]);
  });
});
