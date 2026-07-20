import { z } from 'zod';
import {
  AccountIdSchema,
  CanonicalTransactionIdSchema,
  CategorySuggestionIdSchema,
  CommandIdSchema,
  DocumentAttachmentIdSchema,
  DocumentIdSchema,
  EconomicEventKeySchema,
  EntityIdSchema,
  HouseholdIdSchema,
  JournalBatchIdSchema,
  LedgerAccountIdSchema,
  RawProviderEventIdSchema,
  RecurringSeriesIdSchema,
  PaycheckIdSchema,
  ReimbursementClaimIdSchema,
  SettlementIdSchema,
  StatementIdSchema,
  StatementDraftIdSchema,
  ApprovalTokenIdSchema,
  ReconciliationSessionIdSchema,
  UserIdSchema,
} from './ids.js';
import { CurrencyCodeSchema, MinorUnitsStringSchema } from './money.js';
import {
  BankProviderNameSchema,
  DocumentKindSchema,
  DocumentTargetTypeSchema,
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

// F-028: link a detected series to a manual scheduled transaction so the
// projection stops double-counting. schedule_id / link_id are plain UUIDs
// (scheduled_transactions has no branded id schema — it uses a bespoke route).
export const RecurringLinkSchedulePayloadSchema = z.object({
  seriesId: RecurringSeriesIdSchema,
  scheduleId: z.string().uuid(),
}).strict();
export const RecurringUnlinkSchedulePayloadSchema = z.object({
  linkId: z.string().uuid(),
  reason: z.string().max(500).optional(),
}).strict();

// Decline (dismiss) one DETECTED-paycheck occurrence: hides that occurrence on
// the Paychecks page while keeping the employer + latest detected deposit as
// the prefill template (it never mutes the series). Soft-state, append-only,
// idempotent by (series, occurrence_date). Class-B user fact (suggest→approve).
export const DismissDetectedPaycheckPayloadSchema = z.object({
  seriesId: RecurringSeriesIdSchema,
  occurrenceDate: IsoDateSchema,
}).strict();

const PaycheckComponentSchema = z.object({
  key: z.string().min(1).max(100),
  kind: z.enum([
    'gross_salary', 'bonus', 'commission', 'reimbursement',
    'federal_withholding', 'state_withholding', 'local_withholding', 'fica_withholding',
    'benefit', 'retirement_401k', 'employer_match', 'hsa', 'fsa', 'espp',
    'rsu_withholding', 'garnishment', 'direct_deposit',
  ]),
  amountMinor: MinorUnitsStringSchema.regex(/^\d+$/u, 'paycheck components are non-negative'),
}).strict();
const PaycheckMatchSchema = z.object({
  transactionId: CanonicalTransactionIdSchema,
  componentKey: z.string().min(1).max(100),
  amountMinor: MinorUnitsStringSchema.regex(/^\d+$/u, 'match allocations are non-negative'),
}).strict();
export const CreatePaycheckPayloadSchema = z.object({
  employerName: z.string().min(1).max(200), payDate: IsoDateSchema,
  grossMinor: MinorUnitsStringSchema.regex(/^\d+$/u, 'gross is non-negative'),
  netMinor: MinorUnitsStringSchema.regex(/^\d+$/u, 'net is non-negative'),
  currency: CurrencyCodeSchema,
  components: z.array(PaycheckComponentSchema).min(2).max(100),
  matches: z.array(PaycheckMatchSchema).min(1).max(100),
  source: z.object({
    kind: z.enum(['manual', 'paystub', 'payroll_provider']),
    ref: z.string().min(1).max(500), contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
  }).strict(),
}).strict();
const PaycheckStatusPayloadSchema = z.object({
  paycheckId: PaycheckIdSchema, reason: z.string().min(1).max(500),
}).strict();
// Paychecks are immutable (Law 2) -- "edit" is reverse-the-old +
// create-the-corrected under one command, not an in-place mutation. Same
// shape as create, plus which paycheck it replaces; reason is optional
// (the proc defaults it) since not every correction needs an explanation.
export const EditPaycheckPayloadSchema = CreatePaycheckPayloadSchema.extend({
  paycheckId: PaycheckIdSchema,
  reason: z.string().min(1).max(500).optional(),
}).strict();

export const CreateReimbursementClaimPayloadSchema=z.object({
  originalTransactionId:CanonicalTransactionIdSchema,counterpartyName:z.string().min(1).max(200),
  kind:z.enum(['friend','employer','client','insurance','household']),
  amountMinor:MinorUnitsStringSchema.regex(/^\d+$/u),currency:CurrencyCodeSchema,description:z.string().min(1).max(500),
}).strict();
export const SettleReimbursementPayloadSchema=z.object({
  transactionId:CanonicalTransactionIdSchema,
  allocations:z.array(z.object({claimId:ReimbursementClaimIdSchema,amountMinor:MinorUnitsStringSchema.regex(/^\d+$/u)}).strict()).min(1).max(100),
  note:z.string().min(1).max(500),
}).strict();
export const ReverseSettlementPayloadSchema=z.object({settlementId:SettlementIdSchema,reason:z.string().min(1).max(500)}).strict();
export const ReverseClaimPayloadSchema=z.object({claimId:ReimbursementClaimIdSchema,reason:z.string().min(1).max(500)}).strict();
// [A6] statement balance-check mode: strict (opening+Σ=ending) or anchor
// (investment/valuation ending is a mark-to-market, not a line sum — carries a
// typed reason + a stored gap explanation, gate-8 provenance).
export const StatementBalanceCheckSchema=z.enum(['strict','anchor']);
export const StatementAnchorReasonSchema=z.enum(['investment_valuation','market_value','no_transaction_detail']);
const StatementLineSchema=z.object({lineKey:z.string().min(1).max(100),date:IsoDateSchema,amountMinor:MinorUnitsStringSchema,description:z.string().min(1).max(500)}).strict();
// [A6] lines min1 -> min0: zero-line anchor/valuation statements are expressible.
// balanceCheck/anchor fields optional; default strict on the server for the
// manual create path (byte-identical). See NOTES.md contract amendment.
export const CreateStatementPayloadSchema=z.object({accountId:AccountIdSchema,periodStart:IsoDateSchema,periodEnd:IsoDateSchema,
 openingMinor:MinorUnitsStringSchema,endingMinor:MinorUnitsStringSchema,currency:CurrencyCodeSchema,sourceHash:z.string().regex(/^[a-f0-9]{64}$/u),
 lines:z.array(StatementLineSchema).min(0).max(5000),
 balanceCheck:StatementBalanceCheckSchema.optional(),anchorReason:StatementAnchorReasonSchema.optional(),anchorGapExplanation:z.string().min(1).max(1000).optional()}).strict();
const ResolutionSchema=z.enum(['matched_transaction','stale_balance','missing_event','duplicate','pending_posting','opening_balance','adjustment']);
// [A6] items min1 -> min0: a zero-line anchor statement needs zero item explanations.
export const CloseReconciliationPayloadSchema=z.object({statementId:StatementIdSchema,items:z.array(z.object({lineId:z.uuid(),resolution:ResolutionSchema,transactionId:CanonicalTransactionIdSchema.optional(),explanation:z.string().min(1).max(500)}).strict()).min(0).max(5000),
 adjustments:z.array(z.object({kind:ResolutionSchema.exclude(['matched_transaction']),amountMinor:MinorUnitsStringSchema,explanation:z.string().min(1).max(500)}).strict()).max(100)}).strict();
// SLICE 3: dismiss a statement draft (Law 2 reversible-to-terminal; Class B).
export const DismissStatementDraftPayloadSchema=z.object({draftId:StatementDraftIdSchema}).strict();
// SLICE 3: the TOKEN-BOUND statement-draft approval (Law 11 HARD GATE). Carries
// draftId + approvalTokenId + balanceCheck + the full server-normalizable
// statement body. `sourceHash`/`accountId` in the body are ignored server-side
// (the server binds the true content_sha256 + draft account before hashing);
// lines min0 for anchor/zero-line statements.
export const ApproveStatementDraftPayloadSchema=z.object({
 draftId:StatementDraftIdSchema,
 approvalTokenId:ApprovalTokenIdSchema,
 balanceCheck:StatementBalanceCheckSchema,
 statement:z.object({
  accountId:AccountIdSchema,periodStart:IsoDateSchema,periodEnd:IsoDateSchema,
  openingMinor:MinorUnitsStringSchema,endingMinor:MinorUnitsStringSchema,currency:CurrencyCodeSchema,
  sourceHash:z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  lines:z.array(StatementLineSchema).min(0).max(5000),
  anchorReason:StatementAnchorReasonSchema.optional(),anchorGapExplanation:z.string().min(1).max(1000).optional()
 }).strict()
}).strict();
export const ReopenReconciliationPayloadSchema=z.object({sessionId:ReconciliationSessionIdSchema,reason:z.string().min(1).max(500)}).strict();
// F-029: set (1-31) or clear (null) an account's expected statement close day.
export const SetStatementCadencePayloadSchema=z.object({accountId:AccountIdSchema,closeDay:z.number().int().min(1).max(31).nullable()}).strict();
// SLICE 8 [A7]: decide a suggested card-payment↔statement link (Class B
// suggest→approve, Law 10). confirm=true → confirmed; false → rejected
// (terminal). Confirm may only RAISE a transfer SUGGESTION, never auto-confirm
// a transfer. detach undoes a confirmed link (Law 2 reversible, never delete).
export const DecideStatementPaymentLinkPayloadSchema=z.object({linkId:z.uuid(),confirm:z.boolean()}).strict();
export const DetachStatementPaymentLinkPayloadSchema=z.object({linkId:z.uuid()}).strict();

/** One split of a manual transaction: a category and its debit-positive share. */
export const ManualTransactionSplitSchema = z.object({
  categoryLedgerAccountId: LedgerAccountIdSchema,
  amountMinor: MinorUnitsStringSchema,
}).strict();

/**
 * Manual (user-entered) transaction. Splits are REAL offset postings; they
 * must sum to exactly -amountMinor so the batch balances (Law 3). Arithmetic
 * here is BigInt on integer strings — never floats (Law 4).
 */
export const ManualTransactionPayloadSchema = z.object({
  accountId: AccountIdSchema,
  description: z.string().min(1).max(500),
  effectiveDate: IsoDateSchema,
  amountMinor: MinorUnitsStringSchema,
  status: z.enum(['pending', 'posted']),
  splits: z.array(ManualTransactionSplitSchema).min(1).max(30),
}).strict().superRefine((value, ctx) => {
  if (BigInt(value.amountMinor) === 0n) {
    ctx.addIssue({ code: 'custom', path: ['amountMinor'], message: 'amount cannot be zero' });
    return;
  }
  let sum = 0n;
  for (const split of value.splits) {
    if (BigInt(split.amountMinor) === 0n) {
      ctx.addIssue({ code: 'custom', path: ['splits'], message: 'split amounts cannot be zero' });
      return;
    }
    sum += BigInt(split.amountMinor);
  }
  if (sum !== -BigInt(value.amountMinor)) {
    ctx.addIssue({
      code: 'custom',
      path: ['splits'],
      message: `splits must sum to ${(-BigInt(value.amountMinor)).toString()} (got ${sum.toString()})`,
    });
  }
});

export const ManualVoidPayloadSchema = z.object({
  transactionId: CanonicalTransactionIdSchema,
  reason: z.string().min(1).max(500),
}).strict();

/**
 * Re-split an EXISTING transaction across categories (teardown C7). The cash
 * posting is untouched; the category offsets of the live batch are replaced
 * through the house correction model (reversal + replacement batch — Law 2
 * reversible correction, Law 3 balanced). amountMinor is the signed cash
 * amount the CLIENT is looking at — a stale-view guard the server verifies
 * against the live batch before rebalancing anything. Splits must sum to its
 * exact negation; arithmetic is BigInt on integer strings, never floats.
 */
export const SetSplitsPayloadSchema = z.object({
  transactionId: CanonicalTransactionIdSchema,
  amountMinor: MinorUnitsStringSchema,
  splits: z.array(ManualTransactionSplitSchema).min(1).max(30),
}).strict().superRefine((value, ctx) => {
  if (BigInt(value.amountMinor) === 0n) {
    ctx.addIssue({ code: 'custom', path: ['amountMinor'], message: 'amount cannot be zero' });
    return;
  }
  let sum = 0n;
  for (const split of value.splits) {
    if (BigInt(split.amountMinor) === 0n) {
      ctx.addIssue({ code: 'custom', path: ['splits'], message: 'split amounts cannot be zero' });
      return;
    }
    sum += BigInt(split.amountMinor);
  }
  if (sum !== -BigInt(value.amountMinor)) {
    ctx.addIssue({
      code: 'custom',
      path: ['splits'],
      message: `splits must sum to ${(-BigInt(value.amountMinor)).toString()} (got ${sum.toString()})`,
    });
  }
});

/**
 * Correct an existing transaction's effective date (Quicken-style date edit).
 * Same house-correction model as set_splits: the live batch is reversed AS OF
 * ITS ORIGINAL DATE and a replacement batch carrying the identical postings
 * is posted AS OF THE NEW DATE — so period-scoped reports for the old date
 * net to zero and the new date picks up the full effect (Law 2 reversible
 * correction, Law 9 reproducible numbers). Rejected if either the old or the
 * new date falls inside a locked period.
 */
export const SetTransactionDatePayloadSchema = z.object({
  transactionId: CanonicalTransactionIdSchema,
  effectiveDate: IsoDateSchema,
}).strict();

/**
 * Docket item (disconnect+relink UX): void the NEW account's transactions
 * that duplicate ones already on an old, now-disconnected account at the
 * same real-world institution. Does not merge the two account rows (see
 * 20260718060000) — user-triggered, re-runnable, no-op if nothing new to
 * dedupe.
 */
export const DedupeReconnectAccountPayloadSchema = z.object({
  newAccountId: AccountIdSchema,
  oldAccountId: AccountIdSchema,
}).strict();

/**
 * "As of [date], this account's balance was $X" — a one-time statement that
 * anchors the running balance for a synced account whose transaction history
 * doesn't reach back far enough. balanceMinor is the REAL-WORLD magnitude
 * (positive = money in the account for an asset, or amount owed for a
 * liability); the proc applies the debit-positive sign flip for liabilities.
 * Re-submitting for the same account corrects it (reverse + repost), so this
 * schema carries no special "is this a correction" flag — the server decides.
 */
export const SetOpeningBalancePayloadSchema = z.object({
  accountId: AccountIdSchema,
  balanceMinor: MinorUnitsStringSchema,
  asOfDate: IsoDateSchema,
}).strict();

/**
 * Re-anchor a synced account's opening balance from provider truth. The client
 * supplies ONLY the account — the server reads the latest provider balance
 * snapshot and books a corrected delta so the displayed balance ties to the
 * bank, no matter how shallow the synced history is (Law 1: no ledger
 * arithmetic on the client). Reverses any prior opening entry first (Law 2).
 */
export const ReanchorBalancePayloadSchema = z.object({
  accountId: AccountIdSchema,
}).strict();

/**
 * Decide one machine-proposed categorization (P0-B suggest→approve loop,
 * Laws 2/10 class B). Accept applies the suggested category through the same
 * audited overlay path the user-initiated recategorize uses; dismiss records
 * the decision and changes nothing. Either way the suggestion row transitions
 * exactly once — the server rejects re-decisions.
 */
export const DecideCategorySuggestionPayloadSchema = z.object({
  suggestionId: CategorySuggestionIdSchema,
  accept: z.boolean(),
}).strict();

/**
 * Confirm-upload is a DISCRIMINATED UNION on `mode` [A3, statement-ingestion-v2
 * §3]. The upload URL itself is minted by a bespoke route, not a command
 * (nothing durable is written until the object exists in Storage); confirm is
 * the durable, audited step that verifies the uploaded object server-side
 * (size/mime/hash) and records it. The two modes are mutually exclusive by
 * construction so an attach can NEVER accidentally spawn an ingest draft and an
 * ingest can never silently attach to a target:
 *
 *   mode:'attach'  → targetType + targetId REQUIRED; records the version and
 *                    attaches it to exactly one existing target. No draft, no
 *                    account. This is the unchanged receipts/statement-detail
 *                    AttachmentsSection path.
 *   mode:'ingest'  → accountId REQUIRED (Law: ingest always targets an account
 *                    [A3]); creates a statement_draft + transactional-outbox row
 *                    and enqueues extraction. NO attachment, no target.
 *
 * Legacy callers that omit `mode` are treated as 'attach' by the server for
 * backward compatibility (they already send targetType/targetId); new callers
 * SHOULD send `mode` explicitly.
 */
export const AttachDocumentUploadPayloadSchema = z
  .object({
    mode: z.literal('attach'),
    documentId: DocumentIdSchema,
    entityId: EntityIdSchema,
    kind: DocumentKindSchema,
    storageBucket: z.enum(['receipts', 'statements']),
    storagePath: z.string().min(1).max(1024),
    originalFilename: z.string().min(1).max(255),
    // Target is optional (an unattached receipt in the bulk-upload inbox has
    // neither) but present-or-absent as a PAIR; never an account (that is ingest).
    targetType: DocumentTargetTypeSchema.optional(),
    targetId: z.uuid().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.targetType === undefined) !== (value.targetId === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['targetId'],
        message: 'targetType and targetId must both be present or both absent',
      });
    }
  });

/**
 * Statement ingest upload [A3]. Always kind:'statement', always an account,
 * never a target. Produces a draft the user reviews + token-approves (Slice 7).
 */
export const UploadStatementPayloadSchema = z
  .object({
    mode: z.literal('ingest'),
    documentId: DocumentIdSchema,
    entityId: EntityIdSchema,
    kind: z.literal('statement'),
    storageBucket: z.literal('statements'),
    storagePath: z.string().min(1).max(1024),
    originalFilename: z.string().min(1).max(255),
    accountId: AccountIdSchema,
  })
  .strict();

export const ConfirmDocumentUploadPayloadSchema = z.discriminatedUnion('mode', [
  AttachDocumentUploadPayloadSchema,
  UploadStatementPayloadSchema,
]);

/** Detach = undo (Law 2); the document and its versions are untouched. */
export const DetachDocumentPayloadSchema = z.object({
  attachmentId: DocumentAttachmentIdSchema,
  reason: z.string().min(1).max(500),
}).strict();

/** Soft-delete only — the storage object and versions persist for the export/audit window. */
export const DeleteDocumentPayloadSchema = z.object({
  documentId: DocumentIdSchema,
  reason: z.string().min(1).max(500),
}).strict();

/**
 * WS-J / F-030: confirm or reject a suggested receipt→transaction match
 * (AI class B, suggest→approve). `confirm=true` attaches the receipt to the
 * matched transaction; `confirm=false` rejects the pair (never re-suggested).
 * Approval binds the exact matchId (Law 11).
 */
export const DecideReceiptMatchPayloadSchema = z.object({
  matchId: z.string().uuid(),
  confirm: z.boolean(),
}).strict();

/** Undo a confirmed receipt match — detach (Law 2), never delete. */
export const DetachReceiptMatchPayloadSchema = z.object({
  matchId: z.string().uuid(),
}).strict();

// ---------------------------------------------------------------------------
// Budgeting v2 (SLICE B2) — planned total + opt-in category targets.
// Money rides the wire as minor-unit STRINGS (Law 4); percents are integer
// basis points (0..10000, 10000 = 100%). Amount-vs-percent exclusivity is a
// discriminated union so exactly one value shape is ever accepted, matching the
// budget_targets value-shape CHECK. `month` is any civil date; the proc
// truncates it to the first of the month (v1 keel_set_budget tolerance).
// ---------------------------------------------------------------------------

/** Integer basis points in [0, 10000]. 10000 bp = 100%. No floats (Law 4). */
export const BasisPointsSchema = z.number().int().min(0).max(10_000);

/** Non-negative minor-unit amount as a decimal string. */
const NonNegativeMinorSchema = MinorUnitsStringSchema.regex(/^\d+$/u, 'budget amounts are non-negative');

/** budgets.set_total — the plan total for a month (amount OR % of expected income). */
export const SetBudgetTotalPayloadSchema = z.discriminatedUnion('basis', [
  z.object({
    month: IsoDateSchema,
    basis: z.literal('amount'),
    amountMinor: NonNegativeMinorSchema,
    currency: CurrencyCodeSchema.optional(),
  }).strict(),
  z.object({
    month: IsoDateSchema,
    basis: z.literal('percent_of_income'),
    percentBp: BasisPointsSchema,
    currency: CurrencyCodeSchema.optional(),
  }).strict(),
]);

/** budgets.set_target — one category target (amount OR % of the plan total). */
export const SetBudgetTargetPayloadSchema = z.discriminatedUnion('kind', [
  z.object({
    month: IsoDateSchema,
    categoryLedgerAccountId: LedgerAccountIdSchema,
    kind: z.literal('amount'),
    amountMinor: NonNegativeMinorSchema,
    rollover: z.boolean().optional(),
  }).strict(),
  z.object({
    month: IsoDateSchema,
    categoryLedgerAccountId: LedgerAccountIdSchema,
    kind: z.literal('percent_of_total'),
    percentBp: BasisPointsSchema,
    rollover: z.boolean().optional(),
  }).strict(),
]);

/** budgets.remove_target — soft removal (end-date); never a DELETE. */
export const RemoveBudgetTargetPayloadSchema = z.object({
  month: IsoDateSchema,
  categoryLedgerAccountId: LedgerAccountIdSchema,
}).strict();

/** budgets.set_expected_income — user-confirmed expected income for a month. */
export const SetExpectedIncomePayloadSchema = z.object({
  month: IsoDateSchema,
  amountMinor: NonNegativeMinorSchema,
  currency: CurrencyCodeSchema.optional(),
}).strict();

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
  'recurring.link_schedule': RecurringLinkSchedulePayloadSchema,
  'recurring.unlink_schedule': RecurringUnlinkSchedulePayloadSchema,
  'paychecks.create': CreatePaycheckPayloadSchema,
  'paychecks.edit': EditPaycheckPayloadSchema,
  'paychecks.reverse': PaycheckStatusPayloadSchema,
  'paychecks.restore': PaycheckStatusPayloadSchema,
  'paychecks.dismiss_detected': DismissDetectedPaycheckPayloadSchema,
  'reimbursements.create_claim':CreateReimbursementClaimPayloadSchema,
  'reimbursements.settle':SettleReimbursementPayloadSchema,
  'reimbursements.reverse_settlement':ReverseSettlementPayloadSchema,
  'reimbursements.reverse_claim':ReverseClaimPayloadSchema,
  'statements.create':CreateStatementPayloadSchema,
  'statements.approve_draft':ApproveStatementDraftPayloadSchema,
  'statements.dismiss_draft':DismissStatementDraftPayloadSchema,
  'statements.set_cadence':SetStatementCadencePayloadSchema,
  'statements.decide_payment_link':DecideStatementPaymentLinkPayloadSchema,
  'statements.detach_payment_link':DetachStatementPaymentLinkPayloadSchema,
  'reconciliations.close':CloseReconciliationPayloadSchema,
  'reconciliations.reopen':ReopenReconciliationPayloadSchema,
  'transactions.manual_create': ManualTransactionPayloadSchema,
  'transactions.manual_void': ManualVoidPayloadSchema,
  'transactions.set_splits': SetSplitsPayloadSchema,
  'transactions.set_date': SetTransactionDatePayloadSchema,
  'accounts.dedupe_reconnect': DedupeReconnectAccountPayloadSchema,
  'accounts.set_opening_balance': SetOpeningBalancePayloadSchema,
  'accounts.reanchor_balance': ReanchorBalancePayloadSchema,
  'categorization.decide_suggestion': DecideCategorySuggestionPayloadSchema,
  'documents.detach': DetachDocumentPayloadSchema,
  'documents.delete': DeleteDocumentPayloadSchema,
  'receipts.decide_match': DecideReceiptMatchPayloadSchema,
  'receipts.detach_match': DetachReceiptMatchPayloadSchema,
  'budgets.set_total': SetBudgetTotalPayloadSchema,
  'budgets.set_target': SetBudgetTargetPayloadSchema,
  'budgets.remove_target': RemoveBudgetTargetPayloadSchema,
  'budgets.set_expected_income': SetExpectedIncomePayloadSchema,
} as const;
export type CommandProcedureName = keyof typeof COMMAND_PAYLOAD_SCHEMAS;
/**
 * `documents.confirm_upload` is deliberately NOT a CommandProcedureName: it
 * needs a server-side Storage download + hash computation before the RPC
 * call (Postgres can't reach Storage), so it's a bespoke route
 * (`/documents/confirm-upload`), not a generic `/commands` dispatch entry —
 * same reasoning as `connections.link`/`connections.disconnect` below.
 * `ConfirmDocumentUploadPayloadSchema` still documents/validates that
 * route's shape; it's just not wired into COMMAND_PAYLOAD_SCHEMAS.
 */
export type CommandName =
  | CommandProcedureName
  | 'connections.link'
  | 'connections.disconnect'
  | 'documents.confirm_upload'
  | 'admin.export_all';
export const CommandNameSchema = z.enum([
  ...(Object.keys(COMMAND_PAYLOAD_SCHEMAS) as CommandProcedureName[]),
  'connections.link',
  'connections.disconnect',
  'documents.confirm_upload',
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
