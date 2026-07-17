/**
 * Reviewed/unreviewed transaction state (P0-B follow-up — teardown queue
 * item 2): keel_list_transactions_rich's new `categorySource` field, proven
 * end to end through the REAL command/worker surfaces that produce each
 * state (Law 7: RPC/commands only, zero direct DML on financial tables):
 *   1. keel_categorize_transaction (the user-initiated recategorize path)
 *      -> categorySource 'user'.
 *   2. keel_rule_save + keel_apply_rules (the rules engine) -> 'rule'. The
 *      fixture MUST reach the rule via a synced, never-overlaid transaction
 *      (keel_worker_record_raw_event + drainQueue, same pattern 04-replay/
 *      06-redteam/08-plaid-sync already use) — a manualTxn single-split
 *      entry pins its own source='user' overlay unconditionally
 *      (20260713100000 §"Single-split"), and keel_apply_rules' own
 *      conflict guard (`where transaction_categories.source <> 'user'`)
 *      refuses to touch that row (review r3604432441: the original fixture
 *      used manualTxn here, so `categorized` was always 0).
 *   3. keel_cmd_set_splits (a real multi-category split, no overlay row at
 *      all) -> 'user' — reviewed by construction, per 20260717200000.
 *
 * The fourth state (categorySource null) is also exercised at the SQL layer
 * (supabase/tests/019_transaction_review_state.sql) for a cheaper/more
 * direct read-model assertion, but it is emphatically NOT true that a
 * fresh sync is unreachable through a command — case 2 below IS that same
 * synced-and-uncategorized starting point, just before a rule ever runs.
 */
import { describe, expect, it } from 'vitest';
import { drainQueue, serviceClient, SEED, signIn } from './helpers.js';

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
    const svc = serviceClient();
    const pattern = `RULE STATE MERCHANT ${Date.now().toString(36)}`;

    // A rule must land on a transaction with NO existing overlay — the same
    // starting point a real Plaid sync produces before anything has
    // classified it. manualTxn (used by the other two cases here) always
    // pins a source='user' overlay on a single-split entry, which
    // keel_apply_rules' own conflict guard refuses to touch (review
    // r3604432441) — so this fixture goes through the sync/worker path
    // instead, exactly like 04-replay/06-redteam/08-plaid-sync.
    const providerTxnId = `rulestate-${Date.now().toString(36)}`;
    const { error: recordError } = await svc.rpc('keel_worker_record_raw_event', {
      p_provider: 'simulator',
      p_connection_external_ref: SEED.connections.simAlpha.ref,
      p_provider_event_id: `rulestate:${providerTxnId}`,
      p_account_external_ref: 'sim-acct-checking',
      p_body: {
        kind: 'transaction_added',
        eventId: `rulestate-evt-${providerTxnId}`,
        transaction: {
          providerTransactionId: providerTxnId,
          accountExternalRef: 'sim-acct-checking',
          amountMinor: '-1000',
          currency: 'USD',
          date: new Date().toISOString().slice(0, 10),
          description: pattern,
          pending: false,
          pendingTransactionId: null,
        },
      },
      p_received_at: new Date().toISOString(),
    });
    if (recordError) throw new Error(`record raw event failed: ${recordError.message}`);

    const outcomes = await drainQueue('sync_events');
    expect(outcomes.every((o) => o.startsWith('done:'))).toBe(true);

    const economicEventKey = `txn:simulator:${SEED.connections.simAlpha.ref}:${providerTxnId}`;
    const { data: canonical, error: canonicalError } = await svc
      .from('canonical_transactions')
      .select('id')
      .eq('economic_event_key', economicEventKey)
      .single();
    if (canonicalError) throw new Error(`canonical lookup failed: ${canonicalError.message}`);
    const txnId = canonical.id;

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
