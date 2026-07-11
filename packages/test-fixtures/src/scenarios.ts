import type { ProviderSyncEvent, ProviderTransaction, SyncPage } from '@keel/contracts';

export type ScenarioName =
  | 'baseline'
  | 'duplicate_delivery'
  | 'out_of_order'
  | 'delayed_posting'
  | 'changed_amount'
  | 'removed_transaction';

export interface ExpectedCanonicalTransaction {
  economicKey: string;
  accountExternalRef: string;
  amountMinor: string;
  status: 'pending' | 'posted' | 'voided';
  description: string;
}

export interface ExpectedCanonicalState {
  transactions: ExpectedCanonicalTransaction[];
}

export interface Scenario {
  name: ScenarioName;
  description: string;
  pages: SyncPage[];
  expectedCanonical: ExpectedCanonicalState;
}

const transaction = (
  providerTransactionId: string,
  accountExternalRef: string,
  amountMinor: string,
  date: string,
  description: string,
  pending: boolean,
  pendingTransactionId: string | null = null,
): ProviderTransaction => ({
  providerTransactionId,
  accountExternalRef,
  amountMinor,
  currency: 'USD',
  date,
  description,
  pending,
  pendingTransactionId,
});

const page = (events: ProviderSyncEvent[], nextCursor: string, hasMore: boolean): SyncPage => ({
  provider: 'simulator',
  events,
  nextCursor,
  hasMore,
});

const baselineFirstPageEvents: ProviderSyncEvent[] = [
  {
    kind: 'transaction_added',
    eventId: 'sim-event-baseline-groceries-added',
    transaction: transaction(
      'sim-txn-baseline-groceries',
      'sim-acct-checking',
      '-8742',
      '2026-01-03',
      'Fresh Market weekly groceries',
      false,
    ),
  },
  {
    kind: 'transaction_added',
    eventId: 'sim-event-baseline-paycheck-added',
    transaction: transaction(
      'sim-txn-baseline-paycheck',
      'sim-acct-checking',
      '314159',
      '2026-01-05',
      'Northstar Labs payroll direct deposit',
      false,
    ),
  },
  {
    kind: 'transaction_added',
    eventId: 'sim-event-baseline-coffee-added',
    transaction: transaction(
      'sim-txn-baseline-coffee',
      'sim-acct-card',
      '-650',
      '2026-01-06',
      'Juniper Coffee Roasters',
      false,
    ),
  },
];

const baselineSecondPageEvents: ProviderSyncEvent[] = [
  {
    kind: 'transaction_added',
    eventId: 'sim-event-baseline-rent-added',
    transaction: transaction(
      'sim-txn-baseline-rent',
      'sim-acct-checking',
      '-185000',
      '2026-01-07',
      'January rent — Lakeview Property Management',
      false,
    ),
  },
  {
    kind: 'transaction_added',
    eventId: 'sim-event-baseline-card-payment-checking-added',
    transaction: transaction(
      'sim-txn-baseline-card-payment-checking',
      'sim-acct-checking',
      '-25000',
      '2026-01-08',
      'Payment to Harbor Rewards Card',
      false,
    ),
  },
  {
    kind: 'transaction_added',
    eventId: 'sim-event-baseline-card-payment-card-added',
    transaction: transaction(
      'sim-txn-baseline-card-payment-card',
      'sim-acct-card',
      '25000',
      '2026-01-08',
      'Payment received from checking account',
      false,
    ),
  },
];

const baseline: Scenario = {
  name: 'baseline',
  description:
    'Two-account posted history with ordinary purchases, income, rent, a transfer pair, and cursor pagination.',
  pages: [page(baselineFirstPageEvents, '1', true), page(baselineSecondPageEvents, '2', false)],
  expectedCanonical: {
    transactions: [
      {
        economicKey: 'baseline:card-payment:card',
        accountExternalRef: 'sim-acct-card',
        amountMinor: '25000',
        status: 'posted',
        description: 'Payment received from checking account',
      },
      {
        economicKey: 'baseline:card-payment:checking',
        accountExternalRef: 'sim-acct-checking',
        amountMinor: '-25000',
        status: 'posted',
        description: 'Payment to Harbor Rewards Card',
      },
      {
        economicKey: 'baseline:coffee',
        accountExternalRef: 'sim-acct-card',
        amountMinor: '-650',
        status: 'posted',
        description: 'Juniper Coffee Roasters',
      },
      {
        economicKey: 'baseline:groceries',
        accountExternalRef: 'sim-acct-checking',
        amountMinor: '-8742',
        status: 'posted',
        description: 'Fresh Market weekly groceries',
      },
      {
        economicKey: 'baseline:paycheck',
        accountExternalRef: 'sim-acct-checking',
        amountMinor: '314159',
        status: 'posted',
        description: 'Northstar Labs payroll direct deposit',
      },
      {
        economicKey: 'baseline:rent',
        accountExternalRef: 'sim-acct-checking',
        amountMinor: '-185000',
        status: 'posted',
        description: 'January rent — Lakeview Property Management',
      },
    ],
  },
};

const duplicateDelivery: Scenario = {
  name: 'duplicate_delivery',
  description:
    'The first baseline page is delivered verbatim twice, exercising event and provider-transaction idempotency.',
  pages: [page(baselineFirstPageEvents, '1', true), page(baselineFirstPageEvents, '2', false)],
  expectedCanonical: {
    transactions: [
      {
        economicKey: 'baseline:coffee',
        accountExternalRef: 'sim-acct-card',
        amountMinor: '-650',
        status: 'posted',
        description: 'Juniper Coffee Roasters',
      },
      {
        economicKey: 'baseline:groceries',
        accountExternalRef: 'sim-acct-checking',
        amountMinor: '-8742',
        status: 'posted',
        description: 'Fresh Market weekly groceries',
      },
      {
        economicKey: 'baseline:paycheck',
        accountExternalRef: 'sim-acct-checking',
        amountMinor: '314159',
        status: 'posted',
        description: 'Northstar Labs payroll direct deposit',
      },
    ],
  },
};

const outOfOrder: Scenario = {
  name: 'out_of_order',
  description:
    'Three posted transactions arrive newest-first even though canonical expectations are independent of delivery order.',
  pages: [
    page(
      [
        {
          kind: 'transaction_added',
          eventId: 'sim-event-out-of-order-newest-added',
          transaction: transaction(
            'sim-txn-out-of-order-newest',
            'sim-acct-checking',
            '-2399',
            '2026-02-09',
            'Riverside Pharmacy',
            false,
          ),
        },
        {
          kind: 'transaction_added',
          eventId: 'sim-event-out-of-order-middle-added',
          transaction: transaction(
            'sim-txn-out-of-order-middle',
            'sim-acct-checking',
            '-12000',
            '2026-02-06',
            'City Electric utility payment',
            false,
          ),
        },
        {
          kind: 'transaction_added',
          eventId: 'sim-event-out-of-order-oldest-added',
          transaction: transaction(
            'sim-txn-out-of-order-oldest',
            'sim-acct-card',
            '-1895',
            '2026-02-02',
            'Paper Trail Books',
            false,
          ),
        },
      ],
      '1',
      false,
    ),
  ],
  expectedCanonical: {
    transactions: [
      {
        economicKey: 'out-of-order:2026-02-02:books',
        accountExternalRef: 'sim-acct-card',
        amountMinor: '-1895',
        status: 'posted',
        description: 'Paper Trail Books',
      },
      {
        economicKey: 'out-of-order:2026-02-06:electric',
        accountExternalRef: 'sim-acct-checking',
        amountMinor: '-12000',
        status: 'posted',
        description: 'City Electric utility payment',
      },
      {
        economicKey: 'out-of-order:2026-02-09:pharmacy',
        accountExternalRef: 'sim-acct-checking',
        amountMinor: '-2399',
        status: 'posted',
        description: 'Riverside Pharmacy',
      },
    ],
  },
};

const delayedPendingId = 'sim-txn-delayed-pending';
const delayedPosting: Scenario = {
  name: 'delayed_posting',
  description:
    'A pending authorization is followed by empty sync windows before a posted replacement links back to it.',
  pages: [
    page(
      [
        {
          kind: 'transaction_added',
          eventId: 'sim-event-delayed-pending-added',
          transaction: transaction(
            delayedPendingId,
            'sim-acct-card',
            '-1299',
            '2026-03-10',
            'Metro Market authorization',
            true,
          ),
        },
      ],
      '1',
      true,
    ),
    page([], '2', true),
    page([], '3', true),
    page(
      [
        {
          kind: 'transaction_added',
          eventId: 'sim-event-delayed-posted-added',
          transaction: transaction(
            'sim-txn-delayed-posted',
            'sim-acct-card',
            '-1299',
            '2026-03-12',
            'Metro Market',
            false,
            delayedPendingId,
          ),
        },
      ],
      '4',
      false,
    ),
  ],
  expectedCanonical: {
    transactions: [
      {
        economicKey: 'delayed-posting:metro-market',
        accountExternalRef: 'sim-acct-card',
        amountMinor: '-1299',
        status: 'posted',
        description: 'Metro Market',
      },
    ],
  },
};

const changedPendingId = 'sim-txn-changed-amount-pending';
const changedAmount: Scenario = {
  name: 'changed_amount',
  description:
    'A pending restaurant charge is revised for its tip and then replaced by a posted transaction with explicit lineage.',
  pages: [
    page(
      [
        {
          kind: 'transaction_added',
          eventId: 'sim-event-changed-amount-pending-added',
          transaction: transaction(
            changedPendingId,
            'sim-acct-card',
            '-4200',
            '2026-04-18',
            'Saffron Table pending charge',
            true,
          ),
        },
      ],
      '1',
      true,
    ),
    page(
      [
        {
          kind: 'transaction_modified',
          eventId: 'sim-event-changed-amount-tip-modified',
          transaction: transaction(
            changedPendingId,
            'sim-acct-card',
            '-4650',
            '2026-04-18',
            'Saffron Table — tip included',
            true,
          ),
        },
      ],
      '2',
      true,
    ),
    page(
      [
        {
          kind: 'transaction_added',
          eventId: 'sim-event-changed-amount-posted-added',
          transaction: transaction(
            'sim-txn-changed-amount-posted',
            'sim-acct-card',
            '-4650',
            '2026-04-20',
            'Saffron Table — tip included',
            false,
            changedPendingId,
          ),
        },
      ],
      '3',
      false,
    ),
  ],
  expectedCanonical: {
    transactions: [
      {
        economicKey: 'changed-amount:saffron-table',
        accountExternalRef: 'sim-acct-card',
        amountMinor: '-4650',
        status: 'posted',
        description: 'Saffron Table — tip included',
      },
    ],
  },
};

const removedTransaction: Scenario = {
  name: 'removed_transaction',
  description:
    'A posted transaction is later removed by the provider and remains represented canonically as voided.',
  pages: [
    page(
      [
        {
          kind: 'transaction_added',
          eventId: 'sim-event-removed-added',
          transaction: transaction(
            'sim-txn-removed',
            'sim-acct-checking',
            '-7600',
            '2026-05-04',
            'Lakeshore Internet monthly service',
            false,
          ),
        },
      ],
      '1',
      true,
    ),
    page(
      [
        {
          kind: 'transaction_removed',
          eventId: 'sim-event-removed-voided',
          providerTransactionId: 'sim-txn-removed',
        },
      ],
      '2',
      false,
    ),
  ],
  expectedCanonical: {
    transactions: [
      {
        economicKey: 'removed-transaction:lakeshore-internet',
        accountExternalRef: 'sim-acct-checking',
        amountMinor: '-7600',
        status: 'voided',
        description: 'Lakeshore Internet monthly service',
      },
    ],
  },
};

export const SCENARIOS: Record<ScenarioName, Scenario> = {
  baseline,
  duplicate_delivery: duplicateDelivery,
  out_of_order: outOfOrder,
  delayed_posting: delayedPosting,
  changed_amount: changedAmount,
  removed_transaction: removedTransaction,
};
