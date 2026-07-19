import type { RecurringBucket } from '@/lib/keel-api';

/**
 * Outflow bucket for a dominant Plaid PFC primary — the executable TS mirror
 * of the outflow CASE in `keel_recurring_classification`
 * (supabase/migrations/20260719210000_recurring_outflow_bucket_taxonomy.sql,
 * formulaVersion 'recurring-classification-v4-outflow-buckets'). The SQL
 * function is the authority (the UI always renders the server's bucket);
 * this mirror exists so the mapping has a deterministic unit-test fixture
 * suite (Law 1 — pure enum lookup, no model calls) the same way
 * `stepScheduleDue` mirrors `keel_schedule_advance`. Keep the two in
 * lockstep: any mapping change lands as a new migration + a matching edit
 * here + a formulaVersion bump.
 *
 * Rationale per line (GAP-2, e2e validation 2026-07-19): 'subscription' is a
 * strong product claim (an opt-in plan you could cancel) and 'bill' an
 * obligation claim — neither may be asserted without PFC evidence
 * (BC-v2.1 §9.1 explicit ownership). Habitual-spend primaries and the
 * null/OTHER/unknown fallback get the neutral 'recurring' bucket: a claim of
 * cadence only (which the detector evidences), never of kind (which it
 * doesn't).
 */
export function outflowBucketForPfc(
  dominantPfc: string | null,
): Extract<RecurringBucket, 'excluded' | 'utility' | 'bill' | 'subscription' | 'recurring'> {
  switch (dominantPfc) {
    // Internal transfers are not spend at all (checked before sign in SQL).
    case 'TRANSFER_IN':
    case 'TRANSFER_OUT':
      return 'excluded';
    // Rent + utilities share one Plaid primary (detailed labels not stored).
    case 'RENT_AND_UTILITIES':
      return 'utility';
    // Obligation-style charges you owe rather than opt into.
    case 'LOAN_PAYMENTS':
    case 'GOVERNMENT_AND_NON_PROFIT':
    case 'INSURANCE':
    case 'MEDICAL':
    case 'BANK_FEES':
      return 'bill';
    // Opt-in recurring plans: streaming/gaming and service plans.
    case 'ENTERTAINMENT':
    case 'GENERAL_SERVICES':
      return 'subscription';
    // Habitual spend at a fixed cadence (recurring rideshare is the canonical
    // case), anomalous tags (INCOME/LOAN_DISBURSEMENTS on an outflow), OTHER,
    // null (no matched occurrences yet), and unknown future primaries: no
    // kind evidence -> no kind claim.
    default:
      return 'recurring';
  }
}

/**
 * Singular badge labels, adjacent to the series name they qualify (Law 8:
 * status adjacent to the number/name; financial calm — neutral wording, no
 * alarm styling; the badge itself stays a neutral secondary/outline variant).
 */
export const RECURRING_BUCKET_BADGE_LABELS: Record<RecurringBucket, string> = {
  income: 'Income',
  paycheck: 'Paycheck',
  bill: 'Bill',
  utility: 'Utility',
  subscription: 'Subscription',
  recurring: 'Recurring',
  excluded: 'Excluded',
};
