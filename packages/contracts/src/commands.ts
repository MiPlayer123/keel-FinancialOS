import { z } from 'zod';
import {
  AccountIdSchema,
  CanonicalTransactionIdSchema,
  CommandIdSchema,
  EconomicEventKeySchema,
  EntityIdSchema,
  HouseholdIdSchema,
  JournalBatchIdSchema,
  LedgerAccountIdSchema,
  RawProviderEventIdSchema,
  RecurringSeriesIdSchema,
  UserIdSchema,
} from './ids.js';
import { CurrencyCodeSchema, MinorUnitsStringSchema } from './money.js';
import {
  BankProviderNameSchema,
  LedgerAccountKindSchema,
  TransactionSourceSchema,
} from './enums.js';

/**
 * Who is acting. AI agents act as `agent` and always route through proposals /
 * approval policies (Law 2); `system` is reserved for deterministic internal
 * processes (queue workers, cron orchestration).
 */
export const ActorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user'), userId: UserIdSchema }),
  z.object({ kind: z.literal('agent'), agentName: z.string().min(1), onBehalfOf: UserIdSchema }),
  z.object({ kind: z.literal('system'), processName: z.string().min(1) }),
]);
export type Actor = z.infer<typeof ActorSchema>;

const isGregorianCivilDate = (value: string): boolean => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;
  const maxDay = monthDays[month - 1];
  return maxDay !== undefined && day <= maxDay;
};

/** ISO-8601 Gregorian calendar date (no time component) — effective/posting dates. */
export const IsoDateSchema = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
  .refine(isGregorianCivilDate, 'invalid Gregorian civil date');

// ---------------------------------------------------------------------------
// Stage 1A command payloads (PLAN.md §3.5 amendment 5)
// ---------------------------------------------------------------------------

export const CreateAccountPayloadSchema = z.object({
  entityId: EntityIdSchema,
  name: z.string().min(1).max(200),
  kind: LedgerAccountKindSchema,
  subtype: z.string().min(1).max(100),
  currency: CurrencyCodeSchema,
});

/** Immutable raw-source capture: store first, interpret later (BC-v2.1 law 1). */
export const RecordRawEventPayloadSchema = z.object({
  provider: BankProviderNameSchema,
  providerEventId: z.string().min(1).max(256),
  connectionExternalRef: z.string().min(1).max(256),
  accountExternalRef: z.string().min(1).max(256),
  /** Verbatim provider payload. Data-tier only (Law 5): never interpreted as instructions. */
  body: z.record(z.string(), z.unknown()),
  receivedAt: z.iso.datetime(),
});

export const PostingInputSchema = z.object({
  ledgerAccountId: LedgerAccountIdSchema,
  amountMinor: MinorUnitsStringSchema,
  currency: CurrencyCodeSchema,
});

/** Promote one raw provider event into canonical transaction + balanced batch. */
export const PromoteEventPayloadSchema = z.object({
  rawEventId: RawProviderEventIdSchema,
  accountId: AccountIdSchema,
  entityId: EntityIdSchema,
  description: z.string().max(500),
  effectiveDate: IsoDateSchema,
  status: z.enum(['pending', 'posted']),
  source: TransactionSourceSchema,
  postings: z.array(PostingInputSchema).min(2),
});

export const PostBatchPayloadSchema = z.object({
  canonicalTransactionId: CanonicalTransactionIdSchema.optional(),
  description: z.string().max(500),
  effectiveDate: IsoDateSchema,
  postings: z.array(PostingInputSchema).min(2),
});

export const ReverseBatchPayloadSchema = z.object({
  batchId: JournalBatchIdSchema,
  reason: z.string().min(1).max(500),
});

const RecurringTransitionPayloadSchema = z.object({
  seriesId: RecurringSeriesIdSchema,
  effectiveDate: IsoDateSchema,
}).strict();

export const RecurringConfirmPayloadSchema = RecurringTransitionPayloadSchema.extend({
  horizonDays: z.number().int().min(1).max(366),
}).strict();
export const RecurringPausePayloadSchema = RecurringTransitionPayloadSchema;
export const RecurringResumePayloadSchema = RecurringTransitionPayloadSchema.extend({
  horizonDays: z.number().int().min(1).max(366),
}).strict();
export const RecurringCancelPayloadSchema = RecurringTransitionPayloadSchema;
export const RecurringRejectPayloadSchema = RecurringTransitionPayloadSchema;

export const COMMAND_PAYLOAD_SCHEMAS = {
  'accounts.create': CreateAccountPayloadSchema,
  'ingest.record_raw_event': RecordRawEventPayloadSchema,
  'ingest.promote_event': PromoteEventPayloadSchema,
  'journal.post_batch': PostBatchPayloadSchema,
  'journal.reverse_batch': ReverseBatchPayloadSchema,
  'recurring.confirm': RecurringConfirmPayloadSchema,
  'recurring.pause': RecurringPausePayloadSchema,
  'recurring.resume': RecurringResumePayloadSchema,
  'recurring.cancel': RecurringCancelPayloadSchema,
  'recurring.reject': RecurringRejectPayloadSchema,
} as const;
export type CommandProcedureName = keyof typeof COMMAND_PAYLOAD_SCHEMAS;
export type CommandName =
  | CommandProcedureName
  | 'connections.link'
  | 'connections.disconnect'
  | 'admin.export_all';
export const CommandNameSchema = z.enum([
  ...(Object.keys(COMMAND_PAYLOAD_SCHEMAS) as CommandProcedureName[]),
  'connections.link',
  'connections.disconnect',
  'admin.export_all',
]);
export const CommandProcedureNameSchema = z.enum(
  Object.keys(COMMAND_PAYLOAD_SCHEMAS) as [CommandProcedureName, ...CommandProcedureName[]],
);

/**
 * Envelope every mutation travels in, whatever the surface (web, MCP, worker,
 * support console) — Law 7: one authorized contract, no side doors.
 */
export const CommandEnvelopeSchema = z.object({
  commandId: CommandIdSchema,
  command: CommandProcedureNameSchema,
  economicEventKey: EconomicEventKeySchema,
  actor: ActorSchema,
  householdId: HouseholdIdSchema,
  payload: z.record(z.string(), z.unknown()),
});
export type CommandEnvelope = z.infer<typeof CommandEnvelopeSchema>;

/** Parse + narrow an envelope's payload to its command's schema. */
export const parseCommandPayload = <N extends CommandProcedureName>(
  name: N,
  payload: unknown,
): z.infer<(typeof COMMAND_PAYLOAD_SCHEMAS)[N]> => {
  const schema = COMMAND_PAYLOAD_SCHEMAS[name];
  return schema.parse(payload) as z.infer<(typeof COMMAND_PAYLOAD_SCHEMAS)[N]>;
};

/** Successful command result with provenance (INFRA §5 step 12). */
export const CommandResultSchema = z.object({
  commandId: CommandIdSchema,
  economicEventKey: EconomicEventKeySchema,
  /** True when the key had already been executed and this call was a no-op. */
  idempotentReplay: z.boolean(),
  effects: z.record(z.string(), z.unknown()),
  asOf: z.iso.datetime(),
});
export type CommandResult = z.infer<typeof CommandResultSchema>;
