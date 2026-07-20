import { z } from 'zod';
import type { Brand } from './brand.js';

export type UserId = Brand<string, 'UserId'>;
export type HouseholdId = Brand<string, 'HouseholdId'>;
export type EntityId = Brand<string, 'EntityId'>;
export type ConnectionId = Brand<string, 'ConnectionId'>;
export type AccountId = Brand<string, 'AccountId'>;
export type LedgerAccountId = Brand<string, 'LedgerAccountId'>;
export type CanonicalTransactionId = Brand<string, 'CanonicalTransactionId'>;
export type JournalBatchId = Brand<string, 'JournalBatchId'>;
export type JournalPostingId = Brand<string, 'JournalPostingId'>;
export type RawProviderEventId = Brand<string, 'RawProviderEventId'>;
export type CommandId = Brand<string, 'CommandId'>;
export type PeriodLockId = Brand<string, 'PeriodLockId'>;
export type RecurringSeriesId = Brand<string, 'RecurringSeriesId'>;
export type PaycheckId = Brand<string, 'PaycheckId'>;
export type PaycheckTemplateId = Brand<string, 'PaycheckTemplateId'>;
export type PaycheckSplitSuggestionId = Brand<string, 'PaycheckSplitSuggestionId'>;
export type ReimbursementClaimId = Brand<string,'ReimbursementClaimId'>;
export type SettlementId = Brand<string,'SettlementId'>;
export type ExpectedReimbursementId = Brand<string,'ExpectedReimbursementId'>;
export type ExpectedReimbursementReceiptId = Brand<string,'ExpectedReimbursementReceiptId'>;
export type StatementId=Brand<string,'StatementId'>;export type ReconciliationSessionId=Brand<string,'ReconciliationSessionId'>;
export type StatementDraftId=Brand<string,'StatementDraftId'>;export type ApprovalTokenId=Brand<string,'ApprovalTokenId'>;
export type CategorySuggestionId = Brand<string, 'CategorySuggestionId'>;
export type DocumentId = Brand<string, 'DocumentId'>;
export type DocumentAttachmentId = Brand<string, 'DocumentAttachmentId'>;

/**
 * The idempotency key of an economic event (CLAUDE.md Law 9: idempotent
 * economics). Two commands/events with the same key must produce exactly one
 * economic result, no matter how many times either is retried or replayed.
 */
export type EconomicEventKey = Brand<string, 'EconomicEventKey'>;

const uuid = z.uuid();

export const UserIdSchema = uuid.brand<'UserId'>();
export const HouseholdIdSchema = uuid.brand<'HouseholdId'>();
export const EntityIdSchema = uuid.brand<'EntityId'>();
export const ConnectionIdSchema = uuid.brand<'ConnectionId'>();
export const AccountIdSchema = uuid.brand<'AccountId'>();
export const LedgerAccountIdSchema = uuid.brand<'LedgerAccountId'>();
export const CanonicalTransactionIdSchema = uuid.brand<'CanonicalTransactionId'>();
export const JournalBatchIdSchema = uuid.brand<'JournalBatchId'>();
export const JournalPostingIdSchema = uuid.brand<'JournalPostingId'>();
export const RawProviderEventIdSchema = uuid.brand<'RawProviderEventId'>();
export const CommandIdSchema = uuid.brand<'CommandId'>();
export const PeriodLockIdSchema = uuid.brand<'PeriodLockId'>();
export const RecurringSeriesIdSchema = uuid.brand<'RecurringSeriesId'>();
export const PaycheckIdSchema = uuid.brand<'PaycheckId'>();
export const PaycheckTemplateIdSchema = uuid.brand<'PaycheckTemplateId'>();
export const EmployerIdSchema = uuid.brand<'EmployerId'>();
export const PaycheckSplitSuggestionIdSchema = uuid.brand<'PaycheckSplitSuggestionId'>();
export const ReimbursementClaimIdSchema=uuid.brand<'ReimbursementClaimId'>();
export const SettlementIdSchema=uuid.brand<'SettlementId'>();
export const ExpectedReimbursementIdSchema=uuid.brand<'ExpectedReimbursementId'>();
export const ExpectedReimbursementReceiptIdSchema=uuid.brand<'ExpectedReimbursementReceiptId'>();
export const StatementIdSchema=uuid.brand<'StatementId'>();export const ReconciliationSessionIdSchema=uuid.brand<'ReconciliationSessionId'>();
export const StatementDraftIdSchema=uuid.brand<'StatementDraftId'>();export const ApprovalTokenIdSchema=uuid.brand<'ApprovalTokenId'>();
export const CategorySuggestionIdSchema = uuid.brand<'CategorySuggestionId'>();
export const DocumentIdSchema = uuid.brand<'DocumentId'>();
export const DocumentAttachmentIdSchema = uuid.brand<'DocumentAttachmentId'>();

/**
 * Economic-event keys are caller-constructed deterministic strings, e.g.
 * `sim:acct-1:evt-42:posted` — not random UUIDs, so that a replay of the same
 * upstream fact reproduces the same key.
 */
export const EconomicEventKeySchema = z
  .string()
  .min(8)
  .max(256)
  .regex(/^[a-z0-9][a-z0-9:._-]*$/i)
  .brand<'EconomicEventKey'>();
