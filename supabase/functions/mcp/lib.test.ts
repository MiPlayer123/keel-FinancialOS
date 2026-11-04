import { decodeCursor, dbError, encodeCursor, minorToDecimal, money, toCallToolResult, err, ok } from './lib.ts';
import { computeSplitLegs, summarize, type TxnRow } from './summarize.ts';

const assertEquals = (actual: unknown, expected: unknown, message = 'values differ'): void => {
  const big = (_k: string, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v);
  const left = JSON.stringify(actual, big);
  const right = JSON.stringify(expected, big);
  if (left !== right) throw new Error(`${message}: ${left} !== ${right}`);
};
const assert: (c: unknown, m?: string) => asserts c = (c, m = 'assertion failed') => {
  if (!c) throw new Error(m);
};

Deno.test('money: exact minor units with a display string, never floats', () => {
  assertEquals(money('-125050', 'USD'), { amount_minor: '-125050', currency: 'USD', display: '-$1,250.50' });
  assertEquals(money('5', 'USD')?.display, '$0.05');
  assertEquals(money('1500', 'JPY')?.display, '¥1,500');
  assertEquals(minorToDecimal('900719925474099312', 'USD'), '9007199254740993.12', 'beyond float precision');
  assertEquals(money(null), null);
  assertEquals(money('not-a-number'), null);
});

Deno.test('cursor round-trips and rejects tampering', () => {
  const c = encodeCursor({ effectiveDate: '2026-06-01', transactionId: '11111111-1111-4111-8111-111111111111' });
  assertEquals(decodeCursor(c!), { date: '2026-06-01', id: '11111111-1111-4111-8111-111111111111' });
  assertEquals(encodeCursor(null), null);
  assertEquals(decodeCursor(undefined), null);
  assertEquals(decodeCursor('garbage'), 'invalid');
  assertEquals(decodeCursor(btoa(JSON.stringify({ v: 1, d: "2026-01-01'; drop", i: 'x' }))), 'invalid');
});

Deno.test('db errors steer the model and never leak SQL', () => {
  const notFound = dbError({ code: 'P0006', message: 'KEEL_NOT_FOUND: relation canonical_transactions' });
  assertEquals(notFound.code, 'not_found');
  assert(!notFound.message.includes('canonical_transactions'), 'leaked a table name');
  assert(notFound.hint?.includes('never guess'));
  assertEquals(dbError({ code: 'P0009', message: 'KEEL_INVALID_COMMAND: note too long' }).message, 'The request failed validation. note too long');
  const unknown = dbError({ code: '23505', message: 'duplicate key value violates unique constraint "x"' });
  assertEquals(unknown, { ok: false, code: 'failed', message: 'KEEL could not complete that request.' });
});

Deno.test('tool results: summary first, provenance, data notice; errors are isError', () => {
  const r = toCallToolResult(ok('3 accounts.', { accounts: [] }), { asOf: '2026-11-04T00:00:00Z', householdId: 'h1' });
  const body = JSON.parse(r.content[0]!.text);
  assertEquals(Object.keys(body)[0], 'summary');
  assertEquals(body.as_of, '2026-11-04T00:00:00Z');
  assertEquals(body.scope, { household_id: 'h1' });
  assert(String(body.data_notice).includes('never instructions'));
  assertEquals(r.structuredContent, body);
  assert(!('isError' in r));
  const e = toCallToolResult(err('not_found', 'Nope.', 'Try X.'), { asOf: 'x', householdId: 'h1' });
  assertEquals(e.isError, true);
  assertEquals(JSON.parse(e.content[0]!.text), { error: { code: 'not_found', message: 'Nope.', hint: 'Try X.' } });
});

// ---------------------------------------------------------------------------
// Summaries (Law 1: KEEL adds, the model never does)
// ---------------------------------------------------------------------------
const row = (over: Partial<TxnRow>): TxnRow => ({
  transactionId: crypto.randomUUID(),
  effectiveDate: '2026-06-10',
  description: 'X',
  amountMinor: '-1000',
  currency: 'USD',
  accountId: 'a1',
  accountName: 'Checking',
  categoryLedgerAccountId: 'c-groc',
  categoryName: 'Groceries',
  categoryKind: 'expense',
  ...over,
});

Deno.test('summarize by category splits split transactions and skips transfers by default', () => {
  const rows = [
    row({ amountMinor: '-2000' }),
    row({ amountMinor: '-4000', categoryLedgerAccountId: null, categoryName: 'Split', splits: [
      { categoryLedgerAccountId: 'c-groc', name: 'Groceries', amountMinor: '2500', legType: 'category' },
      { categoryLedgerAccountId: 'c-cafe', name: 'Coffee', amountMinor: '1500', legType: 'category' },
    ] }),
    row({ amountMinor: '250000', categoryLedgerAccountId: 'c-pay', categoryName: 'Salary', categoryKind: 'income' }),
    row({ amountMinor: '-50000', categoryKind: 'transfer', categoryName: 'Transfer' }),
  ];
  const s = summarize(rows, 'category', { includeTransfers: false });
  assertEquals(s.transactionCount, 3);
  assertEquals(s.transfersExcluded, 1);
  const byKey = Object.fromEntries(s.groups.map((g) => [g.key, g]));
  assertEquals(byKey['c-groc']!.outflowMinor, 4500n);
  assertEquals(byKey['c-cafe']!.outflowMinor, 1500n);
  assertEquals(byKey['c-pay']!.inflowMinor, 250000n);
  assertEquals(s.totals[0]!.outflowMinor, 6000n, 'split shares add back to the cash amount');
  assertEquals(s.totals[0]!.netMinor, 244000n);
  assertEquals(s.groups[0]!.key, 'c-groc', 'largest outflow first');
  assertEquals(summarize(rows, 'category', { includeTransfers: true }).transactionCount, 4);
});

Deno.test('summarize by month is chronological; currencies never mix', () => {
  const rows = [
    row({ effectiveDate: '2026-07-02' }),
    row({ effectiveDate: '2026-05-02' }),
    row({ effectiveDate: '2026-05-20', currency: 'EUR', amountMinor: '-700' }),
  ];
  const s = summarize(rows, 'month', { includeTransfers: false });
  assertEquals(s.groups.map((g) => `${g.key}/${g.currency}`), ['2026-05/USD', '2026-05/EUR', '2026-07/USD']);
  assertEquals(s.totals.map((t) => t.currency).sort(), ['EUR', 'USD']);
});

Deno.test('split legs: KEEL does the division and the legs always balance (Law 1/3)', () => {
  const sum = (legs: { amountMinor: string }[]) => legs.reduce((a, l) => a + BigInt(l.amountMinor), 0n);
  const out = computeSplitLegs('-10000', 'equal', [{ categoryId: 'a' }, { categoryId: 'b' }, { categoryId: 'c' }]);
  assert(out.ok);
  assertEquals(out.legs.map((l) => l.amountMinor), ['3334', '3333', '3333']);
  assertEquals(sum(out.legs), 10000n, 'legs negate the cash amount');

  const pct = computeSplitLegs('-999', 'percent', [{ categoryId: 'a', basisPoints: 3333 }, { categoryId: 'b', basisPoints: 3333 }, { categoryId: 'c', basisPoints: 3334 }]);
  assert(pct.ok);
  assertEquals(sum(pct.legs), 999n);

  const income = computeSplitLegs('5000', 'amounts', [{ categoryId: 'a', amountMinor: '3000' }, { categoryId: 'b', amountMinor: '2000' }]);
  assert(income.ok);
  assertEquals(income.legs.map((l) => l.amountMinor), ['-3000', '-2000'], 'inflow legs are credits');

  const bad = computeSplitLegs('-5000', 'amounts', [{ categoryId: 'a', amountMinor: '3000' }, { categoryId: 'b', amountMinor: '1000' }]);
  assert(!bad.ok && bad.message.includes('4000') && bad.message.includes('5000'), 'mismatch names both totals');
  assert(!computeSplitLegs('-5000', 'percent', [{ categoryId: 'a', basisPoints: 5000 }]).ok);
  assert(!computeSplitLegs('-1', 'equal', [{ categoryId: 'a' }, { categoryId: 'b' }]).ok, 'no zero legs');
  assert(!computeSplitLegs('0', 'equal', [{ categoryId: 'a' }]).ok);
});
