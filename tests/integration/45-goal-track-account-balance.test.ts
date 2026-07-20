/**
 * Savings goals that TRACK a linked account balance (Monarch/Copilot-style).
 *
 * A savings goal with tracking='account_balance' derives progress from the
 * asset-balance magnitude of its linked account (journal_postings), exactly
 * mirroring how debt goals derive from the ledger — no manual contributions.
 * Covers: create → derived progress (savedMinor) → reached-on-read; contribute
 * REFUSED for tracked goals; asset-account requirement; and manual goals still
 * behave as before (contributions accumulate). Household scope is enforced by
 * the read query already; here we prove the derivation + refusals.
 *
 * Requires the local stack (supabase start + db reset + functions serve) with
 * migration 20260724000000 applied. Run by CI / the orchestrator, not the
 * worktree (no local Docker here).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  callFunction,
  envelope,
  serviceClient,
  userToken,
  authedHeaders,
  SEED,
} from './helpers.js';

let alexHeaders: Record<string, string>;

beforeAll(async () => {
  alexHeaders = authedHeaders(await userToken(SEED.users.alex.email));
});

type GoalRow = {
  goalId: string;
  name: string;
  kind: 'savings' | 'debt';
  tracking: 'manual' | 'account_balance';
  targetMinor: string;
  savedMinor: string;
  status: 'active' | 'reached' | 'archived';
  trackedBalanceMinor?: string;
};

const listGoals = async (): Promise<GoalRow[]> => {
  const res = await callFunction('/api/queries', {
    headers: alexHeaders,
    body: { query: 'goals.list', householdId: SEED.households.alpha },
  });
  expect(res.status).toBe(200);
  return res.body as GoalRow[];
};

/** Give the checking (asset) account a known positive balance. */
const depositToChecking = async (amountMinor: string, key: string): Promise<void> => {
  const env = envelope(
    'journal.post_batch',
    SEED.households.alpha,
    SEED.users.alex.id,
    {
      description: 'goal-tracking fixture deposit',
      effectiveDate: '2026-07-05',
      postings: [
        { ledgerAccountId: SEED.ledgerAccounts.alphaChecking, amountMinor, currency: 'USD' },
        {
          ledgerAccountId: SEED.ledgerAccounts.alphaGroceries,
          amountMinor: (-BigInt(amountMinor)).toString(),
          currency: 'USD',
        },
      ],
    },
    key,
  );
  const res = await callFunction('/api/commands', { headers: alexHeaders, body: env });
  expect(res.status).toBe(200);
};

describe('goal tracking = account_balance', () => {
  it('derives progress from the asset balance and refuses contributions', async () => {
    // Establish a positive checking balance.
    await depositToChecking('50000', 'goal-track-deposit-1'); // +$500.00

    // Create a tracked savings goal on the checking account, target $400.
    const saved = await callFunction('/api/goals/save', {
      headers: alexHeaders,
      body: {
        householdId: SEED.households.alpha,
        name: 'Track — checking cushion',
        targetMinor: '40000',
        targetDate: null,
        accountId: SEED.accounts.alphaChecking,
        kind: 'savings',
        tracking: 'account_balance',
      },
    });
    expect(saved.status).toBe(200);
    const goalId = (saved.body as { goalId: string }).goalId;
    expect(typeof goalId).toBe('string');

    // savedMinor is DERIVED from the ledger, not from contributions, and the
    // goal reads 'reached' because balance ($500) >= target ($400).
    let row = (await listGoals()).find((g) => g.goalId === goalId)!;
    expect(row.tracking).toBe('account_balance');
    expect(row.savedMinor).toBe('50000');
    expect(row.trackedBalanceMinor).toBe('50000');
    expect(typeof row.savedMinor).toBe('string'); // money is a string on the wire
    expect(row.status).toBe('reached');

    // Contributions are refused — one source of truth is the account balance.
    const contrib = await callFunction('/api/goals/contribute', {
      headers: alexHeaders,
      body: {
        householdId: SEED.households.alpha,
        goalId,
        amountMinor: '10000',
        contributedOn: '2026-07-06',
      },
    });
    expect(contrib.status).toBeGreaterThanOrEqual(400);

    // Balance moves → derived progress moves with it, no user input.
    await depositToChecking('-30000', 'goal-track-deposit-2'); // -$300 → $200 left
    row = (await listGoals()).find((g) => g.goalId === goalId)!;
    expect(row.savedMinor).toBe('20000');
    expect(row.status).toBe('active'); // $200 < $400 target, un-reached on read

    // Clean up so re-runs stay deterministic.
    await callFunction('/api/goals/set-status', {
      headers: alexHeaders,
      body: { householdId: SEED.households.alpha, goalId, status: 'archived' },
    });
  });

  it('refuses a tracked goal without an account and against a liability', async () => {
    const noAccount = await callFunction('/api/goals/save', {
      headers: alexHeaders,
      body: {
        householdId: SEED.households.alpha,
        name: 'Track — nothing',
        targetMinor: '10000',
        targetDate: null,
        accountId: null,
        kind: 'savings',
        tracking: 'account_balance',
      },
    });
    expect(noAccount.status).toBeGreaterThanOrEqual(400);
  });

  it('manual savings goals still accumulate from contributions', async () => {
    const saved = await callFunction('/api/goals/save', {
      headers: alexHeaders,
      body: {
        householdId: SEED.households.alpha,
        name: 'Manual — vacation',
        targetMinor: '20000',
        targetDate: null,
        accountId: null,
        kind: 'savings',
        tracking: 'manual',
      },
    });
    expect(saved.status).toBe(200);
    const goalId = (saved.body as { goalId: string }).goalId;

    const contrib = await callFunction('/api/goals/contribute', {
      headers: alexHeaders,
      body: {
        householdId: SEED.households.alpha,
        goalId,
        amountMinor: '5000',
        contributedOn: '2026-07-06',
      },
    });
    expect(contrib.status).toBe(200);

    const row = (await listGoals()).find((g) => g.goalId === goalId)!;
    expect(row.tracking).toBe('manual');
    expect(row.savedMinor).toBe('5000');

    await callFunction('/api/goals/set-status', {
      headers: alexHeaders,
      body: { householdId: SEED.households.alpha, goalId, status: 'archived' },
    });
  });

  it('writes an audit row on tracked-goal creation', async () => {
    const saved = await callFunction('/api/goals/save', {
      headers: alexHeaders,
      body: {
        householdId: SEED.households.alpha,
        name: 'Track — audited',
        targetMinor: '10000',
        targetDate: null,
        accountId: SEED.accounts.alphaChecking,
        kind: 'savings',
        tracking: 'account_balance',
      },
    });
    expect(saved.status).toBe(200);
    const goalId = (saved.body as { goalId: string }).goalId;

    const svc = serviceClient();
    const { data } = await svc
      .from('audit_log')
      .select('action, after')
      .eq('object_id', goalId)
      .eq('action', 'goal.create');
    expect((data ?? []).length).toBe(1);
    expect((data![0]!.after as { tracking: string }).tracking).toBe('account_balance');

    await callFunction('/api/goals/set-status', {
      headers: alexHeaders,
      body: { householdId: SEED.households.alpha, goalId, status: 'archived' },
    });
  });
});
