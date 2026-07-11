export interface ProviderTransaction {
  providerTransactionId: string;
  accountExternalRef: string;
  amountMinor: string;
  currency: string;
  date: string;
  description: string;
  pending: boolean;
  pendingTransactionId: string | null;
}

export type ProviderSyncEvent =
  | { kind: 'transaction_added'; eventId: string; transaction: ProviderTransaction }
  | { kind: 'transaction_modified'; eventId: string; transaction: ProviderTransaction }
  | { kind: 'transaction_removed'; eventId: string; providerTransactionId: string };

export interface SyncPage {
  provider: 'plaid';
  events: ProviderSyncEvent[];
  nextCursor: string;
  hasMore: boolean;
}

export interface PlaidRecordedSyncResponse {
  readonly connectionExternalRef: string;
  readonly cursor: string;
  readonly status: number;
  readonly rawResponseText: string;
}

export interface PlaidSyncPage extends SyncPage {
  readonly skippedTransactions: readonly {
    kind: 'transaction_added' | 'transaction_modified';
    providerTransactionId: string;
    currency: string | null;
    reason: 'non_usd_currency';
  }[];
}

export class PlaidProviderError extends Error {
  readonly errorCode: string;
  readonly requestId: string | null;
  readonly status: number;

  constructor(errorCode: string, message: string, status: number, requestId: string | null) {
    super(message);
    this.name = 'PlaidProviderError';
    this.errorCode = errorCode;
    this.requestId = requestId;
    this.status = status;
  }
}

export class PlaidMutationRestart extends PlaidProviderError {
  readonly cursor: string;

  constructor(cursor: string, requestId: string | null, message: string) {
    super('TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION', message, 400, requestId);
    this.name = 'PlaidMutationRestart';
    this.cursor = cursor;
  }
}

interface AmountToken {
  start: number;
  end: number;
  lexeme: string;
  numeric: boolean;
}

const NUMBER_PATTERN = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const USD_PATTERN = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,2}))?$/;
const MAX_INT64 = 9_223_372_036_854_775_807n;

const endOfJsonString = (text: string, start: number): number => {
  let escaped = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const character = text[index];
    if (escaped) escaped = false;
    else if (character === '\\') escaped = true;
    else if (character === '"') return index + 1;
  }
  throw new SyntaxError('unterminated JSON string');
};

const skipWhitespace = (text: string, start: number): number => {
  let index = start;
  while (index < text.length && /\s/.test(text[index] ?? '')) index += 1;
  return index;
};

const amountTokens = (rawText: string): AmountToken[] => {
  const tokens: AmountToken[] = [];
  let index = 0;
  while (index < rawText.length) {
    if (rawText[index] !== '"') {
      index += 1;
      continue;
    }
    const keyEnd = endOfJsonString(rawText, index);
    const key = JSON.parse(rawText.slice(index, keyEnd)) as string;
    let valueStart = skipWhitespace(rawText, keyEnd);
    if (key !== 'amount' || rawText[valueStart] !== ':') {
      index = keyEnd;
      continue;
    }
    valueStart = skipWhitespace(rawText, valueStart + 1);
    if (rawText[valueStart] === '"') {
      const valueEnd = endOfJsonString(rawText, valueStart);
      tokens.push({
        start: valueStart,
        end: valueEnd,
        lexeme: JSON.parse(rawText.slice(valueStart, valueEnd)) as string,
        numeric: false,
      });
      index = valueEnd;
      continue;
    }
    NUMBER_PATTERN.lastIndex = valueStart;
    const match = NUMBER_PATTERN.exec(rawText);
    if (match !== null) {
      tokens.push({
        start: valueStart,
        end: NUMBER_PATTERN.lastIndex,
        lexeme: match[0],
        numeric: true,
      });
      index = NUMBER_PATTERN.lastIndex;
      continue;
    }
    index = keyEnd;
  }
  return tokens;
};

const parseLossless = (rawText: string): unknown => {
  let protectedText = rawText;
  for (const token of amountTokens(rawText).filter((value) => value.numeric).reverse()) {
    protectedText = `${protectedText.slice(0, token.start)}${JSON.stringify(token.lexeme)}${protectedText.slice(token.end)}`;
  }
  return JSON.parse(protectedText) as unknown;
};

const decimalToMinor = (lexeme: string): bigint => {
  const negative = lexeme.startsWith('-');
  const unsigned = negative ? lexeme.slice(1) : lexeme;
  const match = USD_PATTERN.exec(unsigned);
  if (match === null || match[1] === undefined) {
    throw new PlaidProviderError('INVALID_MONEY', 'Plaid amount is not exact USD', 0, null);
  }
  const absolute = BigInt(`${match[1]}${(match[2] ?? '').padEnd(2, '0')}`);
  if ((negative && absolute === 0n) || absolute > MAX_INT64) {
    throw new PlaidProviderError('INVALID_MONEY', 'Plaid amount exceeds int64', 0, null);
  }
  return negative ? -absolute : absolute;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const record = (value: unknown, label: string): Record<string, unknown> => {
  if (!isRecord(value)) throw new PlaidProviderError('INVALID_RESPONSE', `${label} is invalid`, 0, null);
  return value;
};

const stringValue = (value: Record<string, unknown>, key: string): string => {
  if (typeof value[key] !== 'string') {
    throw new PlaidProviderError('INVALID_RESPONSE', `${key} must be a string`, 0, null);
  }
  return value[key] as string;
};

const nullableString = (value: Record<string, unknown>, key: string): string | null => {
  if (value[key] === null) return null;
  return stringValue(value, key);
};

const booleanValue = (value: Record<string, unknown>, key: string): boolean => {
  if (typeof value[key] !== 'boolean') {
    throw new PlaidProviderError('INVALID_RESPONSE', `${key} must be boolean`, 0, null);
  }
  return value[key] as boolean;
};

const arrayValue = (value: Record<string, unknown>, key: string): unknown[] => {
  if (!Array.isArray(value[key])) {
    throw new PlaidProviderError('INVALID_RESPONSE', `${key} must be an array`, 0, null);
  }
  return value[key] as unknown[];
};

const transaction = (raw: Record<string, unknown>): ProviderTransaction => {
  const currency = nullableString(raw, 'iso_currency_code');
  if (currency !== 'USD') {
    throw new PlaidProviderError('CURRENCY_MISMATCH', 'non-USD transaction reached mapper', 0, null);
  }
  return {
    providerTransactionId: stringValue(raw, 'transaction_id'),
    accountExternalRef: stringValue(raw, 'account_id'),
    // Plaid positive means holder outflow; KEEL asset perspective is negative.
    amountMinor: (-decimalToMinor(stringValue(raw, 'amount'))).toString(),
    currency,
    date: stringValue(raw, 'date'),
    description: stringValue(raw, 'name'),
    pending: booleanValue(raw, 'pending'),
    pendingTransactionId: nullableString(raw, 'pending_transaction_id'),
  };
};

export class PlaidBankProvider {
  readonly name = 'plaid' as const;

  constructor(readonly responses: readonly PlaidRecordedSyncResponse[]) {}

  responseFor(connectionExternalRef: string, cursor: string): PlaidRecordedSyncResponse {
    const response = this.responses.find(
      (candidate) =>
        candidate.connectionExternalRef === connectionExternalRef && candidate.cursor === cursor,
    );
    if (!response) {
      throw new PlaidProviderError(
        'RECORDED_PAGE_NOT_FOUND',
        'No injected Plaid response matches the connection and cursor',
        0,
        null,
      );
    }
    return response;
  }

  async sync(connectionExternalRef: string, cursor: string): Promise<PlaidSyncPage> {
    const response = this.responseFor(connectionExternalRef, cursor);
    const parsed = record(parseLossless(response.rawResponseText), 'Plaid response');
    if (response.status >= 400) {
      const errorCode = stringValue(parsed, 'error_code');
      const requestId = nullableString(parsed, 'request_id');
      const message = typeof parsed.error_message === 'string' ? parsed.error_message : errorCode;
      if (errorCode === 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION') {
        throw new PlaidMutationRestart(cursor, requestId, message);
      }
      throw new PlaidProviderError(errorCode, message, response.status, requestId);
    }

    const requestId = stringValue(parsed, 'request_id');
    const events: ProviderSyncEvent[] = [];
    const skippedTransactions: PlaidSyncPage['skippedTransactions'][number][] = [];
    for (const [key, kind] of [
      ['added', 'transaction_added'],
      ['modified', 'transaction_modified'],
    ] as const) {
      for (const value of arrayValue(parsed, key)) {
        const raw = record(value, `${key} transaction`);
        const providerTransactionId = stringValue(raw, 'transaction_id');
        const currency = nullableString(raw, 'iso_currency_code');
        if (currency !== 'USD') {
          skippedTransactions.push({
            kind,
            providerTransactionId,
            currency,
            reason: 'non_usd_currency',
          });
          continue;
        }
        events.push({
          kind,
          eventId: `plaid:${requestId}:${key}:${providerTransactionId}`,
          transaction: transaction(raw),
        });
      }
    }
    for (const value of arrayValue(parsed, 'removed')) {
      const providerTransactionId = stringValue(record(value, 'removed transaction'), 'transaction_id');
      events.push({
        kind: 'transaction_removed',
        eventId: `plaid:${requestId}:removed:${providerTransactionId}`,
        providerTransactionId,
      });
    }
    return {
      provider: 'plaid',
      events,
      nextCursor: stringValue(parsed, 'next_cursor'),
      hasMore: booleanValue(parsed, 'has_more'),
      skippedTransactions,
    };
  }
}

const raw = (body: unknown): string => JSON.stringify(body);
const pending = {
  transaction_id: 'txn-pending-meal',
  account_id: 'acct-checking',
  amount: '48.20',
  iso_currency_code: 'USD',
  date: '2026-07-04',
  name: 'Dinner Place',
  pending: true,
  pending_transaction_id: null,
};
const posted = {
  transaction_id: 'txn-posted-meal',
  account_id: 'acct-checking',
  amount: '52.18',
  iso_currency_code: 'USD',
  date: '2026-07-05',
  name: 'Dinner Place',
  pending: false,
  pending_transaction_id: 'txn-pending-meal',
};

const response = (
  connectionExternalRef: string,
  cursor: string,
  status: number,
  body: unknown,
): PlaidRecordedSyncResponse => ({
  connectionExternalRef,
  cursor,
  status,
  rawResponseText: raw(body),
});

/** Local-only deterministic injection for the seeded Plaid routing item. */
export const injectedPlaidProvider = (
  connectionExternalRef: string,
  abandonedAttempts: number,
): PlaidBankProvider | null => {
  if (Deno.env.get('BANK_PROVIDER') !== 'simulator' || connectionExternalRef !== 'plaid-item-alpha') {
    return null;
  }

  if (abandonedAttempts === 0) {
    return new PlaidBankProvider([
      response(connectionExternalRef, '', 200, {
        added: [pending],
        modified: [],
        removed: [],
        next_cursor: 'mutation-page-2',
        has_more: true,
        request_id: 'req-mutation-1',
      }),
      response(connectionExternalRef, 'mutation-page-2', 400, {
        error_type: 'TRANSACTIONS_ERROR',
        error_code: 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION',
        error_message: 'Transactions changed during pagination; restart from the original cursor.',
        display_message: null,
        request_id: 'req-mutation-2',
      }),
    ]);
  }

  return new PlaidBankProvider([
    response(connectionExternalRef, '', 200, {
      added: [pending],
      modified: [],
      removed: [],
      next_cursor: 'promotion-page-2',
      has_more: true,
      request_id: 'req-promotion-1',
    }),
    response(connectionExternalRef, 'promotion-page-2', 200, {
      added: [posted],
      modified: [],
      removed: [{ transaction_id: 'txn-pending-meal' }],
      next_cursor: 'promotion-complete',
      has_more: false,
      request_id: 'req-promotion-2',
    }),
    response(connectionExternalRef, 'promotion-complete', 200, {
      added: [],
      modified: [],
      removed: [],
      next_cursor: 'promotion-complete',
      has_more: false,
      request_id: 'req-promotion-replay',
    }),
  ]);
};

/** Rebuild a provider around an already archived successful page. */
export const parseArchivedPlaidPage = (
  connectionExternalRef: string,
  cursor: string,
  rawResponseText: string,
): Promise<PlaidSyncPage> =>
  new PlaidBankProvider([
    { connectionExternalRef, cursor, status: 200, rawResponseText },
  ]).sync(connectionExternalRef, cursor);
