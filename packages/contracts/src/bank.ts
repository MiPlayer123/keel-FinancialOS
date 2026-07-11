import { z } from 'zod';
import { BankProviderNameSchema } from './enums.js';
import { MinorUnitsStringSchema, CurrencyCodeSchema } from './money.js';
import { IsoDateSchema } from './commands.js';

/**
 * Provider-neutral sync event stream, modeled on Plaid /transactions/sync
 * semantics (added / modified / removed + cursor) so the simulator and the
 * real adapter exercise identical downstream code (doc 10 §3; TASK-000).
 *
 * Payloads are DATA-TIER (Law 5): descriptions/memos are never interpreted as
 * instructions by any downstream consumer.
 */

export const ProviderTransactionSchema = z.object({
  providerTransactionId: z.string().min(1).max(256),
  accountExternalRef: z.string().min(1).max(256),
  /** Signed from the account holder's perspective; wire-string minor units. */
  amountMinor: MinorUnitsStringSchema,
  currency: CurrencyCodeSchema,
  date: IsoDateSchema,
  description: z.string().max(1000),
  pending: z.boolean(),
  /** For pending→posted lineage: the pending event this one supersedes. */
  pendingTransactionId: z.string().min(1).max(256).nullable(),
});
export type ProviderTransaction = z.infer<typeof ProviderTransactionSchema>;

export const ProviderSyncEventSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('transaction_added'),
    eventId: z.string().min(1).max(256),
    transaction: ProviderTransactionSchema,
  }),
  z.object({
    kind: z.literal('transaction_modified'),
    eventId: z.string().min(1).max(256),
    transaction: ProviderTransactionSchema,
  }),
  z.object({
    kind: z.literal('transaction_removed'),
    eventId: z.string().min(1).max(256),
    providerTransactionId: z.string().min(1).max(256),
  }),
]);
export type ProviderSyncEvent = z.infer<typeof ProviderSyncEventSchema>;

export const SyncPageSchema = z.object({
  provider: BankProviderNameSchema,
  events: z.array(ProviderSyncEventSchema),
  nextCursor: z.string(),
  hasMore: z.boolean(),
});
export type SyncPage = z.infer<typeof SyncPageSchema>;

/**
 * The seam between KEEL and any bank-data provider. Implementations:
 * SimulatorBankProvider (packages/test-fixtures, Stage 1A) and a Plaid adapter
 * (Stage 1C, Sandbox-only until the production ⚑). Pure interface — no SDK
 * imports here (INFRA §2 dependency law).
 */
export interface BankProviderAdapter {
  readonly name: z.infer<typeof BankProviderNameSchema>;
  /** Pull the next page of sync events after `cursor` (empty string = start). */
  sync(connectionExternalRef: string, cursor: string): Promise<SyncPage>;
}
