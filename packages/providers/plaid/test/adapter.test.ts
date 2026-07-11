import { SyncPageSchema } from '@keel/contracts';
import { describe, expect, it } from 'vitest';
import {
  PlaidBankProvider,
  PlaidMutationRestart,
  PlaidProviderError,
  type PlaidRecordedSyncResponse,
} from '../src/adapter.js';
import {
  BASELINE_ADDED,
  INITIAL_EMPTY,
  ITEM_LOGIN_REQUIRED,
  MUTATION_RESTART_PAGES,
  NON_USD,
  PENDING_TO_POSTED_PAGES,
} from '../src/fixtures.js';

describe('PlaidBankProvider', () => {
  it('maps baseline added and modified transactions to exact signed contract events', async () => {
    const provider = new PlaidBankProvider([BASELINE_ADDED]);

    const page = await provider.sync('item-baseline', '');

    expect(SyncPageSchema.safeParse(page).success).toBe(true);
    expect(page).toMatchObject({ provider: 'plaid', nextCursor: 'baseline-cursor', hasMore: false });
    expect(page.events).toEqual([
      {
        kind: 'transaction_added',
        eventId: 'plaid:req-baseline:added:txn-groceries',
        transaction: {
          providerTransactionId: 'txn-groceries',
          accountExternalRef: 'acct-checking',
          amountMinor: '-1234',
          currency: 'USD',
          date: '2026-07-01',
          description: 'Neighborhood Market',
          pending: false,
          pendingTransactionId: null,
        },
      },
      {
        kind: 'transaction_modified',
        eventId: 'plaid:req-baseline:modified:txn-coffee',
        transaction: {
          providerTransactionId: 'txn-coffee',
          accountExternalRef: 'acct-checking',
          amountMinor: '-575',
          currency: 'USD',
          date: '2026-07-02',
          description: 'Coffee Shop',
          pending: true,
          pendingTransactionId: null,
        },
      },
    ]);
    expect(page.skippedTransactions).toEqual([]);
  });

  it('maps pending removal and posted addition across later pages of the same sync', async () => {
    const provider = new PlaidBankProvider(PENDING_TO_POSTED_PAGES);

    const first = await provider.sync('item-promotion', '');
    const second = await provider.sync('item-promotion', first.nextCursor);

    expect(first.hasMore).toBe(true);
    expect(first.events[0]).toMatchObject({
      kind: 'transaction_added',
      transaction: { providerTransactionId: 'txn-pending-meal', pending: true },
    });
    expect(second.events).toHaveLength(2);
    expect(second.events[0]).toMatchObject({
      kind: 'transaction_added',
      transaction: {
        providerTransactionId: 'txn-posted-meal',
        pending: false,
        pendingTransactionId: 'txn-pending-meal',
      },
    });
    expect(second.events[1]).toEqual({
      kind: 'transaction_removed',
      eventId: 'plaid:req-promotion-2:removed:txn-pending-meal',
      providerTransactionId: 'txn-pending-meal',
    });
    expect(second.hasMore).toBe(false);
  });

  it('returns an initial empty page', async () => {
    const provider = new PlaidBankProvider([INITIAL_EMPTY]);

    await expect(provider.sync('item-empty', '')).resolves.toMatchObject({
      events: [],
      nextCursor: 'empty-cursor',
      hasMore: false,
      skippedTransactions: [],
    });
  });

  it('skips a non-USD transaction and records a deterministic reason', async () => {
    const provider = new PlaidBankProvider([NON_USD]);

    const page = await provider.sync('item-multicurrency', '');

    expect(page.events).toEqual([]);
    expect(page.skippedTransactions).toEqual([
      {
        kind: 'transaction_added',
        providerTransactionId: 'txn-eur',
        currency: 'EUR',
        reason: 'non_usd_currency',
      },
    ]);
  });

  it('throws a typed restart signal for mutation during pagination', async () => {
    const provider = new PlaidBankProvider(MUTATION_RESTART_PAGES);
    const first = await provider.sync('item-mutation', '');

    await expect(provider.sync('item-mutation', first.nextCursor)).rejects.toMatchObject({
      name: 'PlaidMutationRestart',
      errorCode: 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION',
      requestId: 'req-mutation-2',
      cursor: 'mutation-page-2',
    } satisfies Partial<PlaidMutationRestart>);
  });

  it('preserves ITEM_LOGIN_REQUIRED as a typed provider error', async () => {
    const provider = new PlaidBankProvider([ITEM_LOGIN_REQUIRED]);

    await expect(provider.sync('item-login-required', '')).rejects.toMatchObject({
      name: 'PlaidProviderError',
      errorCode: 'ITEM_LOGIN_REQUIRED',
      requestId: 'req-login-required',
      status: 400,
    } satisfies Partial<PlaidProviderError>);
  });

  it('uses raw amount lexemes even when they exceed Number safe range', async () => {
    const hugePage: PlaidRecordedSyncResponse = {
      connectionExternalRef: 'item-huge',
      cursor: '',
      status: 200,
      rawResponseText:
        '{"added":[{"transaction_id":"txn-huge","account_id":"acct-huge","amount":90071992547409.93,"iso_currency_code":"USD","date":"2026-07-03","name":"Large exact transfer","pending":false,"pending_transaction_id":null}],"modified":[],"removed":[],"next_cursor":"huge-cursor","has_more":false,"request_id":"req-huge"}',
    };
    const provider = new PlaidBankProvider([hugePage]);

    const page = await provider.sync('item-huge', '');

    expect(page.events[0]).toMatchObject({ transaction: { amountMinor: '-9007199254740993' } });
  });
});
