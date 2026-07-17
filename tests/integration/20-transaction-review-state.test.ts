/**
 * Reviewed/unreviewed transaction state (P0-B follow-up — teardown queue
 * item 2): keel_list_transactions_rich's new `categorySource` field, proven
 * end to end through the REAL command surfaces that produce each state
 * (Law 7: RPC/commands only, zero direct DML on financial tables):
 *   1. keel_categorize_transaction (the user-initiated recategorize path)
 *      -> categorySource 'user'.
 *   2. keel_rule_save + keel_apply_rules (the rules engine) -> 'rule'.
 *   3. keel_cmd_set_splits (a real multi-category split, no overlay row at
 *      all) -> 'user' — reviewed by construction, per 20260717200000.
 *
 * The fourth state (categorySource null — a freshly synced transaction that
 * has NEVER been touched by any of the above) is not reachable through a
 * command at all by definition, so it is covered at the SQL layer instead:
 * supabase/tests/019_transaction_review_state.sql.
 */
import { describe, expect, it } from 'vitest';
import { SEED, signIn } from './helpers.js';

const HOUSEHOLD = SEED.households.alpha;
const ACTOR = { kind: 'user' as const, userId: SEED.users.alex.id };

// Seed fixtures (supabase/seed.sql): alpha entity a101 categories.
const UNCATEGORIZED_EXPENSE = '00000000-0000-4000-8000-00000000a317';
const GROCERIES = SEED.ledgerAccounts.alphaGroceries;
const COFFEE_SHOPS = '00000000-0000-4000-8000-00000000a314';

type RichRow = {
  transactionId: string;
  categoryName: string | null;
  categorySource: 'user' | 'rule' | 'plaid_pfc' | null;
  splits: { categoryLedgerAccountId: string; amountMinor: string }[] | null;
};

const richRow = async (
  alex: Awaited<ReturnType<typeof signIn>>,
  txnId: string,
): Promise<RichRow | undefined> => {
  const { data, error } = await alex.rpc('keel_list_transactions_rich', {
    p_household_id: HOUSEHOLD,
  });
  if (error) throw new Error(`rich list failed: ${error.message}`);
  return (data as { rows: RichRow[] }).rows.find((r) => r.transactionId === txnId);
};

const manualTxn = async (
  alex: Awaited<ReturnType<typeof signIn>>,
  description: string,
): Promise<string> => {
  const { data, error } = await alex.rpc('keel_cmd_manual_transaction', {
    p_command_id: crypto.randomUUID(),
    p_economic_event_key: `itest:reviewstate:txn:${crypto.randomUUID()}`,
    p_actor: ACTOR,
    p_household_id: HOUSEHOLD,
    p_payload: {
      account_id: SEED.accounts.alphaChecking,
      description,
      effective_date: new Date().toISOString().slice(0, 10),
      status: 'posted',
      amount_minor: '-1000',
      splits: [{ category_ledger_account_id: UNCATEGORIZED_EXPENSE, amount_minor: '1000' }],
    },
  });
  if (error) throw new Error(`fixture create failed: ${error.message}`);
  return (data as { effects: { canonicalTransactionId: string } }).effects.canonicalTransactionId;
};

describe('reviewed/unreviewed transaction state (categorySource)', () => {
  it('keel_categorize_transaction (user path) yields categorySource "user"', async () => {
    const alex = await signIn(SEED.users.alex.email);
    const txnId = await manualTxn(alex, `REVIEW STATE USER ${Date.now().toString(36)}`);

    const { error } = await alex.rpc('keel_categorize_transaction', {
      p_household_id: HOUSEHOLD,
      p_txn_id: txnId,
      p_category_ledger_account_id: GROCERIES,
    });
    if (error) throw new Error(`categorize failed: ${error.message}`);

    const row = await richRow(alex, txnId);
    expect(row?.categorySource).toBe('user');
    expect(row?.categoryName).toBe('Groceries');
  });

  it('the rules engine (keel_rule_save + keel_apply_rules) yields categorySource "rule"', async () => {
    const alex = await signIn(SEED.users.alex.email);
    const pattern = `RULE STATE MERCHANT ${Date.now().toString(36)}`;
    const txnId = await manualTxn(alex, pattern);

    const { data: ruleId, error: ruleError } = await alex.rpc('keel_rule_save', {
      p_household_id: HOUSEHOLD,
      p_rule_id: null,
      p_pattern: pattern,
      p_category_ledger_account_id: COFFEE_SHOPS,
      p_rename_to: null,
      p_priority: 100,
      p_active: true,
    });
    if (ruleError) throw new Error(`rule save failed: ${ruleError.message}`);
    expect(ruleId).toBeTruthy();

    const { data: applied, error: applyError } = await alex.rpc('keel_apply_rules', {
      p_household_id: HOUSEHOLD,
      p_dry_run: false,
    });
    if (applyError) throw new Error(`apply rules failed: ${applyError.message}`);
    expect((applied as { categorized: number }).categorized).toBeGreaterThan(0);

    const row = await richRow(alex, txnId);
    expect(row?.categorySource).toBe('rule');
    expect(row?.categoryName).toBe('Coffee Shops');
  });

  it('transactions.set_splits (a real multi-category split) yields categorySource "user"', async () => {
    const alex = await signIn(SEED.users.alex.email);
    const txnId = await manualTxn(alex, `SPLIT STATE ${Date.now().toString(36)}`);

    const { error } = await alex.rpc('keel_cmd_set_splits', {
      p_command_id: crypto.randomUUID(),
      p_economic_event_key: `itest:reviewstate:split:${txnId}`,
      p_actor: ACTOR,
      p_household_id: HOUSEHOLD,
      p_payload: {
        transaction_id: txnId,
        amount_minor: '-1000',
        splits: [
          { category_ledger_account_id: GROCERIES, amount_minor: '600' },
          { category_ledger_account_id: COFFEE_SHOPS, amount_minor: '400' },
        ],
      },
    });
    if (error) throw new Error(`set_splits failed: ${error.message}`);

    const row = await richRow(alex, txnId);
    // No transaction_categories row exists for a multi-split transaction at
    // all (20260717190000 deletes it on re-split) — categorySource still
    // reports 'user' because the split itself is a reviewed, audited user
    // action, not an inferred one.
    expect(row?.categorySource).toBe('user');
    expect(row?.categoryName).toBe('Split');
    expect(row?.splits).toHaveLength(2);
  });
});
