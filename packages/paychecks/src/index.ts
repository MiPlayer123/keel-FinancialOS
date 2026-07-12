export const PAYCHECK_FORMULA_VERSION = 'paycheck-reconciliation-v1' as const;

export type PaycheckComponentKind =
  | 'gross_salary' | 'bonus' | 'commission' | 'reimbursement'
  | 'federal_withholding' | 'state_withholding' | 'local_withholding' | 'fica_withholding'
  | 'benefit' | 'retirement_401k' | 'employer_match' | 'hsa' | 'fsa' | 'espp'
  | 'rsu_withholding' | 'garnishment' | 'direct_deposit';

export interface PaycheckComponentInput {
  readonly key: string;
  readonly kind: PaycheckComponentKind;
  readonly amountMinor: string;
}

export interface PaycheckMatchInput {
  readonly transactionId: string;
  readonly componentKey: string;
  readonly amountMinor: string;
}

export interface PaycheckInput {
  readonly grossMinor: string;
  readonly netMinor: string;
  readonly components: readonly PaycheckComponentInput[];
  readonly matches: readonly PaycheckMatchInput[];
  readonly transactionAmounts: Readonly<Record<string, string>>;
}

export type PaycheckViolation =
  | { readonly code: 'gross_mismatch'; readonly expectedMinor: string; readonly actualMinor: string }
  | { readonly code: 'net_mismatch'; readonly expectedMinor: string; readonly actualMinor: string }
  | { readonly code: 'direct_deposit_mismatch'; readonly expectedMinor: string; readonly actualMinor: string }
  | { readonly code: 'component_destination_mismatch'; readonly componentKey: string; readonly expectedMinor: string; readonly actualMinor: string }
  | { readonly code: 'transaction_overallocated'; readonly transactionId: string; readonly capacityMinor: string; readonly allocatedMinor: string };

const GROSS = new Set<PaycheckComponentKind>(['gross_salary', 'bonus', 'commission']);
const ADDITIONS = new Set<PaycheckComponentKind>(['reimbursement']);
const DEDUCTIONS = new Set<PaycheckComponentKind>([
  'federal_withholding', 'state_withholding', 'local_withholding', 'fica_withholding',
  'benefit', 'retirement_401k', 'hsa', 'fsa', 'espp', 'rsu_withholding', 'garnishment',
]);
const DESTINATIONS = new Set<PaycheckComponentKind>([
  'retirement_401k', 'employer_match', 'hsa', 'fsa', 'espp', 'direct_deposit',
]);

const parseNonnegative = (wire: string, label: string): bigint => {
  if (!/^(0|[1-9][0-9]*)$/u.test(wire)) throw new RangeError(`${label} must be canonical non-negative minor units`);
  return BigInt(wire);
};

const sum = (values: readonly bigint[]): bigint => values.reduce((total, value) => total + value, 0n);

export const reconcilePaycheck = (input: PaycheckInput): {
  readonly ok: boolean;
  readonly totals: {
    readonly grossComponentsMinor: string;
    readonly computedNetMinor: string;
    readonly directDepositsMinor: string;
    readonly matchedDestinationsMinor: string;
  };
  readonly violations: readonly PaycheckViolation[];
} => {
  const gross = parseNonnegative(input.grossMinor, 'grossMinor');
  const net = parseNonnegative(input.netMinor, 'netMinor');
  const components = new Map<string, PaycheckComponentInput & { amount: bigint }>();
  for (const component of input.components) {
    if (component.key.length === 0 || components.has(component.key)) throw new RangeError('component keys must be unique and non-empty');
    components.set(component.key, { ...component, amount: parseNonnegative(component.amountMinor, 'component amountMinor') });
  }

  const allocatedByComponent = new Map<string, bigint>();
  const allocatedByTransaction = new Map<string, bigint>();
  for (const match of input.matches) {
    if (!components.has(match.componentKey)) throw new RangeError('match references an unknown component');
    if (match.transactionId.length === 0) throw new RangeError('match transactionId must be non-empty');
    const amount = parseNonnegative(match.amountMinor, 'match amountMinor');
    allocatedByComponent.set(match.componentKey, (allocatedByComponent.get(match.componentKey) ?? 0n) + amount);
    allocatedByTransaction.set(match.transactionId, (allocatedByTransaction.get(match.transactionId) ?? 0n) + amount);
  }

  const values = [...components.values()];
  const grossComponents = sum(values.filter((row) => GROSS.has(row.kind)).map((row) => row.amount));
  const additions = sum(values.filter((row) => ADDITIONS.has(row.kind)).map((row) => row.amount));
  const deductions = sum(values.filter((row) => DEDUCTIONS.has(row.kind)).map((row) => row.amount));
  const computedNet = grossComponents + additions - deductions;
  const directDeposits = sum(values.filter((row) => row.kind === 'direct_deposit').map((row) => row.amount));
  const matchedDestinations = sum(input.matches.map((row) => parseNonnegative(row.amountMinor, 'match amountMinor')));
  const violations: PaycheckViolation[] = [];
  if (grossComponents !== gross) violations.push({ code: 'gross_mismatch', expectedMinor: gross.toString(), actualMinor: grossComponents.toString() });
  if (computedNet !== net) violations.push({ code: 'net_mismatch', expectedMinor: net.toString(), actualMinor: computedNet.toString() });
  if (directDeposits !== net) violations.push({ code: 'direct_deposit_mismatch', expectedMinor: net.toString(), actualMinor: directDeposits.toString() });
  for (const component of values.filter((row) => DESTINATIONS.has(row.kind))) {
    const actual = allocatedByComponent.get(component.key) ?? 0n;
    if (actual !== component.amount) violations.push({
      code: 'component_destination_mismatch', componentKey: component.key,
      expectedMinor: component.amount.toString(), actualMinor: actual.toString(),
    });
  }
  for (const [transactionId, allocated] of [...allocatedByTransaction.entries()].sort()) {
    const capacityWire = input.transactionAmounts[transactionId];
    if (capacityWire === undefined) throw new RangeError('match transaction has no capacity evidence');
    const capacity = parseNonnegative(capacityWire, 'transaction capacity');
    if (allocated > capacity) violations.push({
      code: 'transaction_overallocated', transactionId,
      capacityMinor: capacity.toString(), allocatedMinor: allocated.toString(),
    });
  }
  return {
    ok: violations.length === 0,
    totals: {
      grossComponentsMinor: grossComponents.toString(), computedNetMinor: computedNet.toString(),
      directDepositsMinor: directDeposits.toString(), matchedDestinationsMinor: matchedDestinations.toString(),
    },
    violations,
  };
};
