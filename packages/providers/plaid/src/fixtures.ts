import type { PlaidRecordedSyncResponse } from './adapter.js';

/**
 * Authored from Plaid's documented Sandbox response shapes; not live-captured.
 * Live capture plus sanitization and approval remains a Stage 1C human ⚑.
 */

const raw = (body: unknown): string => JSON.stringify(body);

export const BASELINE_ADDED: PlaidRecordedSyncResponse = {
  connectionExternalRef: 'item-baseline',
  cursor: '',
  status: 200,
  rawResponseText: raw({
    added: [
      {
        transaction_id: 'txn-groceries',
        account_id: 'acct-checking',
        amount: '12.34',
        iso_currency_code: 'USD',
        date: '2026-07-01',
        name: 'Neighborhood Market',
        merchant_name: 'Neighborhood Market',
        pending: false,
        pending_transaction_id: null,
      },
    ],
    modified: [
      {
        transaction_id: 'txn-coffee',
        account_id: 'acct-checking',
        amount: '5.75',
        iso_currency_code: 'USD',
        date: '2026-07-02',
        name: 'Coffee Shop',
        merchant_name: 'Coffee Shop',
        pending: true,
        pending_transaction_id: null,
      },
    ],
    removed: [],
    next_cursor: 'baseline-cursor',
    has_more: false,
    request_id: 'req-baseline',
  }),
};

export const PENDING_TO_POSTED_PAGES: readonly PlaidRecordedSyncResponse[] = [
  {
    connectionExternalRef: 'item-promotion',
    cursor: '',
    status: 200,
    rawResponseText: raw({
      added: [
        {
          transaction_id: 'txn-pending-meal',
          account_id: 'acct-checking',
          amount: '48.20',
          iso_currency_code: 'USD',
          date: '2026-07-04',
          name: 'Dinner Place',
          pending: true,
          pending_transaction_id: null,
        },
      ],
      modified: [],
      removed: [],
      next_cursor: 'promotion-page-2',
      has_more: true,
      request_id: 'req-promotion-1',
    }),
  },
  {
    connectionExternalRef: 'item-promotion',
    cursor: 'promotion-page-2',
    status: 200,
    rawResponseText: raw({
      added: [
        {
          transaction_id: 'txn-posted-meal',
          account_id: 'acct-checking',
          amount: '52.18',
          iso_currency_code: 'USD',
          date: '2026-07-05',
          name: 'Dinner Place',
          pending: false,
          pending_transaction_id: 'txn-pending-meal',
        },
      ],
      modified: [],
      removed: [{ transaction_id: 'txn-pending-meal' }],
      next_cursor: 'promotion-complete',
      has_more: false,
      request_id: 'req-promotion-2',
    }),
  },
];

export const MUTATION_RESTART_PAGES: readonly PlaidRecordedSyncResponse[] = [
  {
    connectionExternalRef: 'item-mutation',
    cursor: '',
    status: 200,
    rawResponseText: raw({
      added: [
        {
          transaction_id: 'txn-before-mutation',
          account_id: 'acct-checking',
          amount: '8.00',
          iso_currency_code: 'USD',
          date: '2026-07-06',
          name: 'Transit',
          pending: false,
          pending_transaction_id: null,
        },
      ],
      modified: [],
      removed: [],
      next_cursor: 'mutation-page-2',
      has_more: true,
      request_id: 'req-mutation-1',
    }),
  },
  {
    connectionExternalRef: 'item-mutation',
    cursor: 'mutation-page-2',
    status: 400,
    rawResponseText: raw({
      error_type: 'TRANSACTIONS_ERROR',
      error_code: 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION',
      error_message: 'Transactions changed during pagination; restart from the original cursor.',
      display_message: null,
      request_id: 'req-mutation-2',
    }),
  },
];

export const INITIAL_EMPTY: PlaidRecordedSyncResponse = {
  connectionExternalRef: 'item-empty',
  cursor: '',
  status: 200,
  rawResponseText: raw({
    added: [],
    modified: [],
    removed: [],
    next_cursor: 'empty-cursor',
    has_more: false,
    request_id: 'req-empty',
  }),
};

export const NON_USD: PlaidRecordedSyncResponse = {
  connectionExternalRef: 'item-multicurrency',
  cursor: '',
  status: 200,
  rawResponseText: raw({
    added: [
      {
        transaction_id: 'txn-eur',
        account_id: 'acct-eur',
        amount: '17.45',
        iso_currency_code: 'EUR',
        date: '2026-07-07',
        name: 'European Cafe',
        pending: false,
        pending_transaction_id: null,
      },
    ],
    modified: [],
    removed: [],
    next_cursor: 'multicurrency-cursor',
    has_more: false,
    request_id: 'req-multicurrency',
  }),
};

export const ITEM_LOGIN_REQUIRED: PlaidRecordedSyncResponse = {
  connectionExternalRef: 'item-login-required',
  cursor: '',
  status: 400,
  rawResponseText: raw({
    error_type: 'ITEM_ERROR',
    error_code: 'ITEM_LOGIN_REQUIRED',
    error_message: 'The login details for this item must be updated.',
    display_message: 'Please update your bank login.',
    request_id: 'req-login-required',
  }),
};

export const AUTHORED_PLAID_FIXTURES: readonly PlaidRecordedSyncResponse[] = [
  BASELINE_ADDED,
  ...PENDING_TO_POSTED_PAGES,
  ...MUTATION_RESTART_PAGES,
  INITIAL_EMPTY,
  NON_USD,
  ITEM_LOGIN_REQUIRED,
];
