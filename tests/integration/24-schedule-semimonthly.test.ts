/**
 * Semi-monthly (twice a month) scheduled income/bills.
 *
 * Proves the server-side keel_schedule_advance 'semimonthly' branch walks the
 * two anchor days in lockstep with the client mirror stepScheduleDue:
 *   1. A [15, 30] schedule advances Jan 15 -> Jan 30 -> Feb 15 -> Feb 28
 *      (Feb "30th" clamps to the last day) -> Mar 15 -> Mar 30, then recovers
 *      the 30th once the target month is long enough again — the exact
 *      month-end behavior the anchor clamp exists to give (Law: reproducible
 *      numbers, deterministic spine).
 *   2. keel_schedule_save normalizes the two days (anchor_day < anchor_day_2)
 *      and rejects a same-day / single-day semimonthly schedule (P0009).
 *   3. Advancing is fenced on the exact from-due date (idempotent replay).
 *
 * Mirrors the direct-RPC style of 16-reanchor-balance.test.ts: a signed-in
 * user client so auth.uid() is populated for the SECURITY DEFINER procs.
 */
import { describe, expect, it } from 'vitest';
import { serviceClient, SEED, signIn } from './helpers.js';

const HOUSEHOLD = SEED.households.alpha;
const ACCOUNT = SEED.accounts.alphaChecking;

/** Plant a semimonthly schedule and return its id. Category left null — the
 * advance path needs no category (only Enter posts a transaction). */
const saveSemimonthly = async (
  nextDue: string,
  day1: number,
  day2: number,
): Promise<string> => {
  const alex = await signIn(SEED.users.alex.email);
  const { data, error } = await alex.rpc('keel_schedule_save', {
    p_household_id: HOUSEHOLD,
    p_schedule_id: null,
    p_account_id: ACCOUNT,
    p_description: `itest semimonthly ${crypto.randomUUID().slice(0, 8)}`,
    p_amount_minor: '250000',
    p_category_ledger_account_id: null,
    p_frequency: 'semimonthly',
    p_next_due_date: nextDue,
    p_auto_enter_days: 3,
    p_anchor_day: day1,
    p_anchor_day_2: day2,
  });
  if (error) throw new Error(error.message);
  return data as string;
};

/** Advance once from the given due date; returns the new next due date. */
const advance = async (scheduleId: string, fromDue: string): Promise<string> => {
  const alex = await signIn(SEED.users.alex.email);
  const { data, error } = await alex.rpc('keel_schedule_advance', {
    p_household_id: HOUSEHOLD,
    p_schedule_id: scheduleId,
    p_from_due: fromDue,
    p_reason: 'skipped',
  });
  if (error) throw new Error(error.message);
  return (data as { nextDueDate: string }).nextDueDate;
};

const anchors = async (scheduleId: string): Promise<[number, number]> => {
  const { data, error } = await serviceClient()
    .from('scheduled_transactions')
    .select('anchor_day, anchor_day_2')
    .eq('id', scheduleId)
    .single();
  if (error) throw new Error(error.message);
  return [data.anchor_day as number, data.anchor_day_2 as number];
};

describe('keel_schedule_advance — semimonthly', () => {
  it('walks a [15, 30] schedule across the Feb short-month edge and recovers', async () => {
    const id = await saveSemimonthly('2026-01-15', 15, 30);

    let due = '2026-01-15';
    due = await advance(id, due);
    expect(due).toBe('2026-01-30');
    due = await advance(id, due);
    expect(due).toBe('2026-02-15');
    due = await advance(id, due);
    // Feb has no 30th — clamps to the last day (Feb 28 in 2026).
    expect(due).toBe('2026-02-28');
    due = await advance(id, due);
    // From the clamped Feb 28, roll forward to Mar 15 (not back to Feb 28).
    expect(due).toBe('2026-03-15');
    due = await advance(id, due);
    // Recovers the 30th now that March is long enough.
    expect(due).toBe('2026-03-30');
  });

  it('clamps the 30th to Feb 29 in a leap year (2028)', async () => {
    const id = await saveSemimonthly('2028-02-15', 15, 30);
    const due = await advance(id, '2028-02-15');
    expect(due).toBe('2028-02-29');
    const due2 = await advance(id, due);
    expect(due2).toBe('2028-03-15');
  });

  it('normalizes the two days so anchor_day < anchor_day_2 regardless of input order', async () => {
    const id = await saveSemimonthly('2026-01-30', 30, 15);
    expect(await anchors(id)).toEqual([15, 30]);
  });

  it('is a fenced idempotent no-op when the from-due does not match', async () => {
    const id = await saveSemimonthly('2026-01-15', 15, 30);
    const alex = await signIn(SEED.users.alex.email);
    const { data } = await alex.rpc('keel_schedule_advance', {
      p_household_id: HOUSEHOLD,
      p_schedule_id: id,
      p_from_due: '2026-06-01', // wrong date
      p_reason: 'skipped',
    });
    expect((data as { advanced: boolean }).advanced).toBe(false);
    expect((data as { nextDueDate: string }).nextDueDate).toBe('2026-01-15');
  });
});

describe('keel_schedule_save — semimonthly validation', () => {
  const saveRaw = async (day1: number | null, day2: number | null) => {
    const alex = await signIn(SEED.users.alex.email);
    return alex.rpc('keel_schedule_save', {
      p_household_id: HOUSEHOLD,
      p_schedule_id: null,
      p_account_id: ACCOUNT,
      p_description: 'itest semimonthly invalid',
      p_amount_minor: '250000',
      p_category_ledger_account_id: null,
      p_frequency: 'semimonthly',
      p_next_due_date: '2026-01-15',
      p_auto_enter_days: 3,
      p_anchor_day: day1,
      p_anchor_day_2: day2,
    });
  };

  it('rejects a semimonthly schedule missing the second day', async () => {
    const { error } = await saveRaw(15, null);
    expect(error?.message).toMatch(/SEMIMONTHLY_NEEDS_TWO_DAYS/);
  });

  it('rejects a semimonthly schedule whose two days are identical', async () => {
    const { error } = await saveRaw(15, 15);
    expect(error?.message).toMatch(/SEMIMONTHLY_DAYS_MUST_DIFFER/);
  });
});
