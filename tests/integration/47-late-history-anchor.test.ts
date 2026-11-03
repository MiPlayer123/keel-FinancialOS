/**
 * Late-arriving Plaid history must not stack on top of the opening anchor.
 *
 * Reproduces the 2026-10-30 drift (fictional amounts): a connected account is
 * anchored after the first ~30-day sync page, then the multi-year history
 * lands and is added on top of a balance that already included it. Proves
 * keel_heal_late_history_anchor (20261102190000):
 *   1. books a balanced compensating "Opening balance adjustment (late
 *      history)" equal to −Σ(late backdated history) — Law 2 / Law 3;
 *   2. does NOT absorb ordinary posting lag (dated inside the initial window);
 *   3. is idempotent (second run books 0) and audited;
 *   4. composes with Fix balance (reanchor reverses base + adjustment and
 *      still ties to provider truth).
 *
 * Requires the local stack (supabase start + db reset + functions serve).
 * Run by CI, not the worktree (no local Docker here).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { serviceClient, SEED, signIn } from './helpers.js';

const HOUSEHOLD = SEED.households.alpha;
const ENTITY = SEED.entities.alphaPersonal;
const ACTOR = { kind: 'user' as const, userId: SEED.users.alex.id };

const isoDaysAgo = (days: number): string =>
  new Date(Date.now() - days * 24 * 3600 * 1000).toISOString().slice(0, 10);

const ledgerSum = async (ledgerAccountId: string): Promise<bigint> => {
  const { data, error } = await serviceClient()
    .from('journal_postings')
    .select('amount_minor')
    .eq('ledger_account_id', ledgerAccountId);
  if (error) throw new Error(error.message);
  return data.reduce((sum, row) => sum + BigInt(row.amount_minor as string), 0n);
};

let categoryLedgerId: string;

beforeAll(async () => {
  const { data, error } = await serviceClient()
    .from('ledger_accounts')
    .select('id')
    .eq('household_id', HOUSEHOLD)
    .eq('entity_id', ENTITY)
    .eq('is_category', true)
    .is('archived_at', null)
    .limit(1)
    .single();
  if (error) throw new Error(`no category ledger for entity: ${error.message}`);
  categoryLedgerId = data.id as string;
});

const postTxn = async (accountId: string, effectiveDate: string, amount: bigint): Promise<void> => {
  const alex = await signIn(SEED.users.alex.email);
  const { error } = await alex.rpc('keel_cmd_manual_transaction', {
    p_command_id: crypto.randomUUID(),
    p_economic_event_key: `itest:late-history:txn:${crypto.randomUUID()}`,
    p_actor: ACTOR,
    p_household_id: HOUSEHOLD,
    p_payload: {
      account_id: accountId,
      description: 'fictional synced activity (test)',
      effective_date: effectiveDate,
      status: 'posted',
      amount_minor: amount.toString(),
      splits: [{ category_ledger_account_id: categoryLedgerId, amount_minor: (-amount).toString() }],
    },
  });
  if (error) throw new Error(`manual txn failed: ${error.message}`);
};

const reanchor = async (accountId: string) => {
  const alex = await signIn(SEED.users.alex.email);
  const { data, error } = await alex.rpc('keel_cmd_reanchor_balance', {
    p_command_id: crypto.randomUUID(),
    p_economic_event_key: `itest:late-history:fix:${crypto.randomUUID()}`,
    p_actor: ACTOR,
    p_household_id: HOUSEHOLD,
    p_payload: { account_id: accountId },
  });
  if (error) throw new Error(`reanchor failed: ${error.message}`);
  return data as { effects: { batchId: string | null } };
};

describe('keel_heal_late_history_anchor', () => {
  it('absorbs late backdated history into the anchor, never ordinary posting lag', async () => {
    const svc = serviceClient();
    const alex = await signIn(SEED.users.alex.email);
    const { data: created, error: createError } = await alex.rpc('keel_cmd_create_account', {
      p_command_id: crypto.randomUUID(),
      p_economic_event_key: `itest:late-history:create:${crypto.randomUUID()}`,
      p_actor: ACTOR,
      p_household_id: HOUSEHOLD,
      p_payload: {
        entity_id: ENTITY,
        connection_id: SEED.connections.simAlpha.id,
        name: 'Fictional late-history checking',
        kind: 'asset',
        subtype: 'checking',
        currency: 'USD',
      },
    });
    if (createError) throw new Error(`account create failed: ${createError.message}`);
    const { accountId, ledgerAccountId } = (
      created as { effects: { accountId: string; ledgerAccountId: string } }
    ).effects;

    // (1) First sync page: the recent window only.
    await postTxn(accountId, isoDaysAgo(3), 5000n);

    // (2) Provider balance snapshot, then the base anchor (booked via the
    // explicit re-anchor command so the test does not depend on the
    // simulator connection's sync-completion bookkeeping).
    const provider = 100000n;
    const { error: snapError } = await svc.rpc('keel_apply_account_balance', {
      p_household_id: HOUSEHOLD,
      p_account_id: accountId,
      p_current_minor: Number(provider),
      p_available_minor: Number(provider),
      p_currency: 'USD',
      p_as_of: new Date().toISOString(),
    });
    if (snapError) throw new Error(`snapshot failed: ${snapError.message}`);
    await reanchor(accountId);
    expect(await ledgerSum(ledgerAccountId)).toBe(provider);

    // (3) The historical backfill lands AFTER the anchor (dated two years
    // back), plus one ordinary lagged posting dated inside the window.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const history = 30000n;
    const lag = -2000n;
    await postTxn(accountId, isoDaysAgo(730), history);
    await postTxn(accountId, isoDaysAgo(1), lag);
    expect(await ledgerSum(ledgerAccountId)).toBe(provider + history + lag); // the bug

    // (4) Heal: compensates exactly the late history; the lag still moves it.
    const heal = async (): Promise<bigint> => {
      const { data, error } = await svc.rpc('keel_heal_late_history_anchor', {
        p_household_id: HOUSEHOLD,
        p_account_id: accountId,
        p_ledger: ledgerAccountId,
        p_entity: ENTITY,
        p_opening_ledger: await openingLedger(),
        p_connection_id: SEED.connections.simAlpha.id,
        p_subtype: 'checking',
        p_currency: 'USD',
      });
      if (error) throw new Error(`heal failed: ${error.message}`);
      return BigInt(data as number | string);
    };
    expect(await heal()).toBe(-history);
    expect(await ledgerSum(ledgerAccountId)).toBe(provider + lag);

    // Law 3: the adjustment batch is balanced; Law 2: audited.
    const { data: adj, error: adjError } = await svc
      .from('journal_batches')
      .select('id')
      .eq('household_id', HOUSEHOLD)
      .eq('description', 'Opening balance adjustment (late history)')
      .order('posted_at', { ascending: false })
      .limit(1)
      .single();
    if (adjError) throw new Error(adjError.message);
    const { data: legs } = await svc
      .from('journal_postings')
      .select('amount_minor')
      .eq('batch_id', adj.id as string);
    expect((legs ?? []).reduce((s, r) => s + BigInt(r.amount_minor as string), 0n)).toBe(0n);
    const { count } = await svc
      .from('audit_log')
      .select('*', { count: 'exact', head: true })
      .eq('action', 'accounts.opening_balance_late_history_adjusted')
      .eq('object_id', accountId);
    expect(count).toBe(1);

    // (5) Idempotent: nothing new to compensate.
    expect(await heal()).toBe(0n);
    expect(await ledgerSum(ledgerAccountId)).toBe(provider + lag);

    // (6) Fix balance reverses base + adjustment together and ties to provider.
    await reanchor(accountId);
    expect(await ledgerSum(ledgerAccountId)).toBe(provider);
    expect(await heal()).toBe(0n);
  });
});

const openingLedger = async (): Promise<string> => {
  const { data, error } = await serviceClient()
    .from('ledger_accounts')
    .select('id')
    .eq('entity_id', ENTITY)
    .eq('name', 'Opening Balances')
    .is('archived_at', null)
    .single();
  if (error) throw new Error(error.message);
  return data.id as string;
};
