import { mapRecurringStream, streamAmountMinor } from './recurring-streams.ts';

const assertEquals = (actual: unknown, expected: unknown, message = 'values differ'): void => {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`${message}: ${left} !== ${right}`);
};

Deno.test('stream amounts flip to the KEEL sign convention', () => {
  // Plaid: positive = money out. KEEL: money out is negative.
  assertEquals(streamAmountMinor({ amount: '795.00' }), '-79500');
  assertEquals(streamAmountMinor({ amount: '-2045.25' }), '204525');
});

Deno.test('averaged amounts round to cents instead of being dropped', () => {
  // The live regression: Plaid's average_amount is a mean over the stream's
  // transactions and routinely carries more than two decimals. The exact
  // ledger parser rejects those, which silently dropped 5 of the first 6
  // streams fetched from the real Chase item.
  assertEquals(streamAmountMinor({ amount: '34.996666666666666' }), '-3500');
  assertEquals(streamAmountMinor({ amount: '12.334' }), '-1233');
  assertEquals(streamAmountMinor({ amount: '12.335' }), '-1234');
  assertEquals(streamAmountMinor({ amount: '-116.555' }), '11656');
  // Half away from zero on both sides of zero, and no float in the path.
  assertEquals(streamAmountMinor({ amount: 34.996666666666666 }), '-3500');
});

Deno.test('unusable amounts are rejected rather than guessed', () => {
  assertEquals(streamAmountMinor({ amount: 'not-a-number' }), null);
  assertEquals(streamAmountMinor({}), null);
  assertEquals(streamAmountMinor(null), null);
});

Deno.test('a stream maps onto the KEEL account when its Plaid account is tracked', () => {
  const stream = {
    stream_id: 'stream-1',
    account_id: 'plaid-acct-1',
    first_date: '2026-01-15',
    last_date: '2026-08-06',
    predicted_next_date: '2026-09-06',
    frequency: 'MONTHLY',
    status: 'MATURE',
    is_active: true,
    description: 'Payment to card',
    merchant_name: null,
    personal_finance_category: { primary: 'LOAN_PAYMENTS' },
    average_amount: { amount: '2402.63', iso_currency_code: 'USD' },
    last_amount: { amount: '2402.63', iso_currency_code: 'USD' },
  };
  const mapped = mapRecurringStream(
    stream,
    'outflow',
    new Map([['plaid-acct-1', 'keel-acct-1']]),
  );
  assertEquals(mapped?.accountId, 'keel-acct-1');
  assertEquals(mapped?.averageAmountMinor, '-240263');
  assertEquals(mapped?.categoryPrimary, 'LOAN_PAYMENTS');

  // An account KEEL does not track is still a legitimate stream — it stores
  // with a null account_id rather than being dropped.
  const untracked = mapRecurringStream(stream, 'outflow', new Map());
  assertEquals(untracked?.accountId, null);
  assertEquals(untracked?.externalAccountRef, 'plaid-acct-1');
});

Deno.test('a stream missing its identity or dates is dropped, not half-stored', () => {
  const base = {
    stream_id: 'stream-2',
    account_id: 'plaid-acct-1',
    first_date: '2026-01-15',
    last_date: '2026-08-06',
    average_amount: { amount: '10.00' },
  };
  assertEquals(mapRecurringStream({ ...base, stream_id: undefined }, 'inflow', new Map()), null);
  assertEquals(mapRecurringStream({ ...base, last_date: undefined }, 'inflow', new Map()), null);
  assertEquals(mapRecurringStream({ ...base, average_amount: {} }, 'inflow', new Map()), null);
});
