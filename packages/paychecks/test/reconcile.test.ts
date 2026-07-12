import { describe, expect, it } from 'vitest';
import { reconcilePaycheck, type PaycheckInput } from '../src/index.js';

const input = (overrides: Partial<PaycheckInput> = {}): PaycheckInput => ({
  grossMinor: '10000000000000001',
  netMinor: '6910000000000001',
  components: [
    { key: 'salary', kind: 'gross_salary', amountMinor: '10000000000000001' },
    { key: 'federal', kind: 'federal_withholding', amountMinor: '2000000000000000' },
    { key: 'fica', kind: 'fica_withholding', amountMinor: '700000000000000' },
    { key: '401k', kind: 'retirement_401k', amountMinor: '500000000000000' },
    { key: 'match', kind: 'employer_match', amountMinor: '250000000000000' },
    { key: 'reimbursement', kind: 'reimbursement', amountMinor: '110000000000000' },
    { key: 'deposit-a', kind: 'direct_deposit', amountMinor: '6000000000000000' },
    { key: 'deposit-b', kind: 'direct_deposit', amountMinor: '910000000000001' },
  ],
  matches: [
    { transactionId: 'checking-a', componentKey: 'deposit-a', amountMinor: '6000000000000000' },
    { transactionId: 'checking-b', componentKey: 'deposit-b', amountMinor: '910000000000001' },
    { transactionId: 'retirement', componentKey: '401k', amountMinor: '500000000000000' },
    { transactionId: 'retirement', componentKey: 'match', amountMinor: '250000000000000' },
  ],
  transactionAmounts: {
    'checking-a': '6000000000000000',
    'checking-b': '910000000000001',
    retirement: '750000000000000',
  },
  ...overrides,
});

describe('reconcilePaycheck', () => {
  it('reconciles gross, net, multiple deposits, and component destinations with bigint exactness', () => {
    expect(reconcilePaycheck(input())).toEqual({
      ok: true,
      totals: {
        grossComponentsMinor: '10000000000000001',
        computedNetMinor: '6910000000000001',
        directDepositsMinor: '6910000000000001',
        matchedDestinationsMinor: '7660000000000001',
      },
      violations: [],
    });
  });

  it.each([
    ['gross', { grossMinor: '10000000000000000' }],
    ['net', { netMinor: '6910000000000000' }],
    ['direct deposits', { netMinor: '6910000000000002' }],
  ] as const)('reports a %s mismatch without inventing a correction', (_label, overrides) => {
    expect(reconcilePaycheck(input(overrides)).ok).toBe(false);
  });

  it('rejects under-matched destination components and transaction over-allocation', () => {
    const missing = input({ matches: input().matches.filter((row) => row.componentKey !== 'match') });
    expect(reconcilePaycheck(missing).violations).toContainEqual({
      code: 'component_destination_mismatch', componentKey: 'match', expectedMinor: '250000000000000', actualMinor: '0',
    });

    const over = input({
      matches: [...input().matches, { transactionId: 'retirement', componentKey: 'match', amountMinor: '1' }],
    });
    expect(reconcilePaycheck(over).violations).toContainEqual({
      code: 'transaction_overallocated', transactionId: 'retirement', capacityMinor: '750000000000000', allocatedMinor: '750000000000001',
    });
  });

  it.each(['1.00', '01', '-1', '-0', ''])(
    'rejects non-canonical or negative component money %j',
    (amountMinor) => {
      expect(() => reconcilePaycheck(input({
        components: [{ key: 'bad', kind: 'gross_salary', amountMinor }],
      }))).toThrow(RangeError);
    },
  );

  it('rejects duplicate component keys and matches to unknown components', () => {
    expect(() => reconcilePaycheck(input({ components: [
      { key: 'same', kind: 'gross_salary', amountMinor: '1' },
      { key: 'same', kind: 'bonus', amountMinor: '1' },
    ] }))).toThrow(RangeError);
    expect(() => reconcilePaycheck(input({ matches: [
      { transactionId: 'checking-a', componentKey: 'missing', amountMinor: '1' },
    ] }))).toThrow(RangeError);
  });
});
