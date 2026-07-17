/**
 * Typed financial context snapshot — the ONLY thing the chat model ever sees
 * about a household (docs/research/AI-CHAT-2026-07-16.md §3, CLAUDE.md Law 1).
 *
 * Every number here is precomputed server-side by KEEL's deterministic read
 * procs; the model narrates them and never derives new ones. Transaction
 * descriptions are ingested text (Law 5): they are data-tier and are rendered
 * inside delimited data blocks by the prompt builder, never as instructions.
 */

/** Household + entity scope the snapshot was compiled for (Law 9/11). */
export interface SnapshotScope {
  readonly householdId: string;
  readonly entityIds: readonly string[];
}

/** One account with its deterministic ledger balance (minor units). */
export interface AccountBalanceLine {
  readonly accountId: string;
  readonly name: string;
  readonly subtype: string;
  readonly currency: string;
  /** Signed decimal string of minor units, computed by keel_trial_balance. */
  readonly balanceMinor: string;
}

/** One recent transaction. `description` is INGESTED TEXT — data tier. */
export interface TransactionLine {
  readonly transactionId: string;
  readonly effectiveDate: string;
  /** Data-tier ingested text (bank memo / provider description). */
  readonly description: string;
  /** Signed decimal string of minor units (negative = money out). */
  readonly amountMinor: string;
  readonly currency: string;
  readonly accountName: string;
  readonly categoryName: string | null;
  readonly status: string;
}

/** One category available in the household. */
export interface CategoryLine {
  readonly name: string;
  readonly kind: 'income' | 'expense';
}

/** One budget row (current month), amounts precomputed server-side. */
export interface BudgetLine {
  readonly categoryName: string;
  readonly currency: string;
  /** Budgeted minor units, or null when no budget is set. */
  readonly budgetMinor: string | null;
  /** Spent minor units this month, computed by keel_list_budgets. */
  readonly spentMinor: string;
}

/** Stable section ids — these are the evidence_refs of a chat answer. */
export const SNAPSHOT_SECTION_IDS = [
  'accounts',
  'transactions',
  'categories',
  'budgets',
] as const;
export type SnapshotSectionId = (typeof SNAPSHOT_SECTION_IDS)[number];

/** Human labels for the "what the model saw" disclosure (UI shows labels, never raw data). */
export const SNAPSHOT_SECTION_LABELS: Readonly<Record<SnapshotSectionId, string>> = {
  accounts: 'Accounts & balances',
  transactions: 'Recent transactions',
  categories: 'Category list',
  budgets: 'Budgets (current month)',
};

/** The complete, bounded context snapshot for one chat question. */
export interface FinancialContextSnapshot {
  /** Server-stamped ISO timestamp the snapshot was compiled at. */
  readonly asOf: string;
  readonly scope: SnapshotScope;
  /** ISO date (first of month) the budgets section covers. */
  readonly budgetsMonth: string;
  readonly accounts: readonly AccountBalanceLine[];
  readonly transactions: readonly TransactionLine[];
  readonly categories: readonly CategoryLine[];
  readonly budgets: readonly BudgetLine[];
}
