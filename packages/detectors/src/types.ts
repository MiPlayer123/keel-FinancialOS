export type Cadence = 'weekly' | 'biweekly' | 'semimonthly' | 'monthly' | 'quarterly' | 'annual';
export type AmountKind = 'fixed' | 'variable';
export type TransactionSign = 'inflow' | 'outflow';

export interface RecurringTransaction {
  readonly txnId: string;
  readonly batchId: string;
  readonly postingId: string;
  readonly accountId: string;
  readonly ledgerAccountId: string;
  readonly effectiveDate: string;
  readonly amountMinor: string;
  readonly currency: string;
  readonly description: string;
  readonly counterpartyKey?: string;
}

export interface RecurringEvidenceRef {
  readonly txnId: string;
  readonly batchId: string;
  readonly postingId: string;
}

export type CadenceAnchor =
  | { readonly kind: 'epoch_grid'; readonly intervalDays: 7 | 14; readonly anchorEpochDay: number }
  | { readonly kind: 'day_of_month'; readonly day: number; readonly intervalMonths: 1 | 3 | 12; readonly phase: number }
  | { readonly kind: 'day_pair'; readonly days: readonly [number, number] };

export interface DetectedSeries {
  readonly seriesKey: string;
  readonly counterpartyKey: string;
  readonly accountId: string;
  readonly ledgerAccountId: string;
  readonly currency: string;
  readonly sign: TransactionSign;
  readonly cadence: Cadence;
  readonly cadenceAnchor: CadenceAnchor;
  readonly amountKind: AmountKind;
  readonly representativeAmountMinor: string | null;
  readonly amountSummary: {
    readonly minMinor: string;
    readonly maxMinor: string;
    readonly lowerMedianMinor: string;
    readonly squaredResidualSum: string;
    readonly count: number;
  };
  readonly lastSeen: string;
  readonly occurrenceCount: number;
  readonly coverage: { readonly matchedSlots: number; readonly totalSlots: number };
  readonly residualDays: number;
  readonly scoreBps: number;
  readonly evidence: readonly RecurringEvidenceRef[];
  readonly inputFingerprint: string;
  readonly detectorVersion: string;
  readonly confidenceVersion: string;
  readonly normalizerVersion: string;
  readonly asOf: string;
  readonly requiresApproval: true;
}

export type RecurringSeriesStatus = 'suggested' | 'confirmed' | 'paused' | 'cancelled' | 'rejected';
export type RecurringTransition = 'suggested' | 'confirmed' | 'paused' | 'resumed' | 'cancelled' | 'rejected';

export interface RecurringStatusEvent {
  readonly transition: RecurringTransition;
  readonly effectiveDate: string;
  readonly commandId: string;
  readonly actorId: string;
  readonly createdAt: string;
}

export interface RecurringSeries extends DetectedSeries {
  readonly status: RecurringSeriesStatus;
  readonly statusEvents: readonly RecurringStatusEvent[];
  readonly candidateVersionHash: string;
}

export interface ExpectedOccurrence {
  readonly occurrenceKey: string;
  readonly seriesKey: string;
  readonly expectedDate: string;
  readonly expectedAmountMinor: string;
  readonly currency: string;
  readonly sign: TransactionSign;
  readonly amountKind: AmountKind;
  readonly variable: boolean;
  readonly status: 'expected';
  readonly scoreBps: number;
  readonly evidence: readonly RecurringEvidenceRef[];
  readonly inputFingerprint: string;
  readonly detectorVersion: string;
  readonly confidenceVersion: string;
  readonly candidateVersionHash: string;
  readonly asOf: string;
}

export interface BacktestResult {
  readonly matched: readonly (Omit<ExpectedOccurrence, 'status'> & {
    readonly status: 'matched';
    readonly txnId: string;
    readonly actualDate: string;
    readonly actualAmountMinor: string;
  })[];
  readonly skipped: readonly (Omit<ExpectedOccurrence, 'status'> & { readonly status: 'skipped' })[];
  readonly unexpected: readonly {
    readonly status: 'unexpected';
    readonly txnId: string;
    readonly effectiveDate: string;
    readonly amountMinor: string;
    readonly currency: string;
  }[];
}
