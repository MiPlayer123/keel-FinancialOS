export interface CanonicalTxnView {
  economicKey: string;
  providerTransactionId: string;
  accountExternalRef: string;
  amountMinor: bigint;
  status: 'pending' | 'posted' | 'voided';
  description: string;
  effectiveDate: string;
}

export interface IngestState {
  byProviderTxnId: ReadonlyMap<string, CanonicalTxnView>;
}

export const emptyIngestState = (): IngestState => ({
  byProviderTxnId: new Map(),
});
