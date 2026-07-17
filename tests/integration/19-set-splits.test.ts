/**
 * Split editor write path (teardown C7 — transactions.set_splits). Proves,
 * end to end through the real command surface (Law 7: RPC/commands only, zero
 * direct DML on financial tables):
 *   1. Re-splitting an existing transaction replaces the category offsets via
 *      the correction model (reversal + replacement batch; original preserved)
 *      while the cash posting is untouched and every batch nets to 0 (Law 3).
 *   2. The rich read model renders ONE row carrying both splits.
 *   3. Replaying the same economic event key is a no-op replay (Law 9).
 *   4. Unbalanced splits and stale client amounts fail typed; nothing mutates.
 *   5. Collapsing back to a single category pins a USER overlay classification.
 */
import { describe, expect, it } from 'vitest';
import { serviceClient, SEED, signIn } from './helpers.js';

const HOUSEHOLD = SEED.households.alpha;
const ACTOR = { kind: 'user' as const, userId: SEED.users.alex.id };

// Seed fixtures (supabase/seed.sql): alpha entity a101 categories.
const UNCATEGORIZED_EXPENSE = '00000000-0000-4000-8000-00000000a317';
const GROCERIES = SEED.ledgerAccounts.alphaGroceries;
const COFFEE_SHOPS = '00000000-0000-4000-8000-00000000a314';

type RichRow = {
  transactionId: string;
  categoryName: string | null;
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

describe('transactions.set_splits (C7 split editor write path)', () => {
  it('re-splits, replays idempotently, fails typed, and collapses back to one category', async () => {
    const alex = await signIn(SEED.users.alex.email);
    const svc = serviceClient();

    // Fixture through the command surface: a manual transaction parked on the
    // Uncategorized landing pad, exactly as a synced row would be.
    const { data: created, error: createError } = await alex.rpc('keel_cmd_manual_transaction', {
      p_command_id: crypto.randomUUID(),
      p_economic_event_key: `itest:splits:txn:${crypto.randomUUID()}`,
      p_actor: ACTOR,
      p_household_id: HOUSEHOLD,
      p_payload: {
        account_id: SEED.accounts.alphaChecking,
        description: `COSTCO RUN ${Date.now().toString(36)}`,
        effective_date: new Date().toISOString().slice(0, 10),
        status: 'posted',
        amount_minor: '-4300',
        splits: [{ category_ledger_account_id: UNCATEGORIZED_EXPENSE, amount_minor: '4300' }],
      },
    });
    if (createError) throw new Error(`fixture create failed: ${createError.message}`);
    const txnId = (created as { effects: { canonicalTransactionId: string } }).effects
      .canonicalTransactionId;
    const originalBatchId = (created as { effects: { batchId: string } }).effects.batchId;

    // (1) Re-split into Groceries 3000 + Coffee Shops 1300.
    const envelope = {
      p_command_id: crypto.randomUUID(),
      p_economic_event_key: `itest:splits:set:${txnId}`,
      p_actor: ACTOR,
      p_household_id: HOUSEHOLD,
      p_payload: {
        transaction_id: txnId,
        amount_minor: '-4300',
        splits: [
          { category_ledger_account_id: GROCERIES, amount_minor: '3000' },
          { category_ledger_account_id: COFFEE_SHOPS, amount_minor: '1300' },
        ],
      },
    };
    const { data: result, error: setError } = await alex.rpc('keel_cmd_set_splits', envelope);
    if (setError) throw new Error(`set_splits failed: ${setError.message}`);
    const effects = (result as {
      idempotentReplay: boolean;
      effects: {
        originalBatchId: string;
        reversalBatchId: string;
        newBatchId: string;
        splitCount: number;
      };
    });
    expect(effects.idempotentReplay).toBe(false);
    expect(effects.effects.originalBatchId).toBe(originalBatchId);
    expect(effects.effects.splitCount).toBe(2);

    // Correction model: original preserved, reversal negates it, replacement
    // carries cash + both splits; everything nets to zero (Law 3). Read
    // errors must THROW (CI 29559262657 lesson: a permission failure can
    // masquerade as "no rows").
    const postings = await svc
      .from('journal_postings')
      .select('batch_id, ledger_account_id, amount_minor')
      .in('batch_id', [
        originalBatchId,
        effects.effects.reversalBatchId,
        effects.effects.newBatchId,
      ]);
    if (postings.error) throw new Error(`postings read failed: ${postings.error.message}`);
    const rows = postings.data as {
      batch_id: string;
      ledger_account_id: string;
      amount_minor: number;
    }[];
    const byBatch = (id: string) => rows.filter((p) => p.batch_id === id);
    expect(byBatch(originalBatchId)).toHaveLength(2); // untouched original
    expect(byBatch(effects.effects.reversalBatchId)).toHaveLength(2);
    expect(byBatch(effects.effects.newBatchId)).toHaveLength(3);
    expect(rows.reduce((sum, p) => sum + BigInt(p.amount_minor), 0n)).toBe(0n);
    const newSplits = byBatch(effects.effects.newBatchId);
    expect(
      newSplits.find((p) => p.ledger_account_id === GROCERIES)?.amount_minor,
    ).toBe(3000);
    expect(
      newSplits.find((p) => p.ledger_account_id === COFFEE_SHOPS)?.amount_minor,
    ).toBe(1300);

    // Revision record links original → reversal → replacement.
    const revision = await svc
      .from('journal_revisions')
      .select('reversal_batch_id, replacement_batch_id')
      .eq('original_batch_id', originalBatchId)
      .single();
    if (revision.error) throw new Error(`revision read failed: ${revision.error.message}`);
    expect(revision.data.reversal_batch_id).toBe(effects.effects.reversalBatchId);
    expect(revision.data.replacement_batch_id).toBe(effects.effects.newBatchId);

    // Multi-split coherence: the single-split USER overlay from manual entry
    // is deleted — the splits ARE the categorization now.
    const overlay = await svc
      .from('transaction_categories')
      .select('category_ledger_account_id')
      .eq('canonical_transaction_id', txnId)
      .maybeSingle();
    if (overlay.error) throw new Error(`overlay read failed: ${overlay.error.message}`);
    expect(overlay.data).toBeNull();

    // (2) Rich read model: one row, both splits, labeled Split.
    const row = await richRow(alex, txnId);
    expect(row).toBeDefined();
    expect(row!.categoryName).toBe('Split');
    expect(row!.splits).toHaveLength(2);

    // (3) Law 9: same key replays as a no-op, and the audit stays at one row.
    const { data: replay, error: replayError } = await alex.rpc('keel_cmd_set_splits', envelope);
    if (replayError) throw new Error(`replay failed: ${replayError.message}`);
    expect((replay as { idempotentReplay: boolean }).idempotentReplay).toBe(true);
    const { count: auditCount, error: auditError } = await svc
      .from('audit_log')
      .select('*', { count: 'exact', head: true })
      .eq('action', 'transactions.set_splits')
      .eq('object_id', txnId);
    if (auditError) throw new Error(auditError.message);
    expect(auditCount).toBe(1);

    // (4) Typed failures mutate nothing.
    const { error: unbalancedError } = await alex.rpc('keel_cmd_set_splits', {
      p_command_id: crypto.randomUUID(),
      p_economic_event_key: `itest:splits:unbalanced:${txnId}`,
      p_actor: ACTOR,
      p_household_id: HOUSEHOLD,
      p_payload: {
        transaction_id: txnId,
        amount_minor: '-4300',
        splits: [{ category_ledger_account_id: GROCERIES, amount_minor: '4200' }],
      },
    });
    expect(unbalancedError?.code).toBe('P0002');

    const { error: staleError } = await alex.rpc('keel_cmd_set_splits', {
      p_command_id: crypto.randomUUID(),
      p_economic_event_key: `itest:splits:stale:${txnId}`,
      p_actor: ACTOR,
      p_household_id: HOUSEHOLD,
      p_payload: {
        transaction_id: txnId,
        amount_minor: '-9999',
        splits: [{ category_ledger_account_id: GROCERIES, amount_minor: '9999' }],
      },
    });
    expect(staleError?.code).toBe('P0009');

    // (5) Collapse back to a single category: overlay pinned source=user.
    const { data: collapse, error: collapseError } = await alex.rpc('keel_cmd_set_splits', {
      p_command_id: crypto.randomUUID(),
      p_economic_event_key: `itest:splits:single:${txnId}`,
      p_actor: ACTOR,
      p_household_id: HOUSEHOLD,
      p_payload: {
        transaction_id: txnId,
        amount_minor: '-4300',
        splits: [{ category_ledger_account_id: GROCERIES, amount_minor: '4300' }],
      },
    });
    if (collapseError) throw new Error(`collapse failed: ${collapseError.message}`);
    expect((collapse as { effects: { splitCount: number } }).effects.splitCount).toBe(1);

    const pinned = await svc
      .from('transaction_categories')
      .select('category_ledger_account_id, source')
      .eq('canonical_transaction_id', txnId)
      .single();
    if (pinned.error) throw new Error(`pinned overlay read failed: ${pinned.error.message}`);
    expect(pinned.data.category_ledger_account_id).toBe(GROCERIES);
    expect(pinned.data.source).toBe('user');

    const finalRow = await richRow(alex, txnId);
    expect(finalRow!.splits ?? null).toBeNull();
    expect(finalRow!.categoryName).toBe('Groceries');
  });

  it('is scope-safe: a non-member cannot re-split another household transaction', async () => {
    const alex = await signIn(SEED.users.alex.email);
    const casey = await signIn(SEED.users.casey.email);

    const { data: created, error: createError } = await alex.rpc('keel_cmd_manual_transaction', {
      p_command_id: crypto.randomUUID(),
      p_economic_event_key: `itest:splits:scope:${crypto.randomUUID()}`,
      p_actor: ACTOR,
      p_household_id: HOUSEHOLD,
      p_payload: {
        account_id: SEED.accounts.alphaChecking,
        description: 'SCOPE PROBE',
        effective_date: new Date().toISOString().slice(0, 10),
        status: 'posted',
        amount_minor: '-1000',
        splits: [{ category_ledger_account_id: UNCATEGORIZED_EXPENSE, amount_minor: '1000' }],
      },
    });
    if (createError) throw new Error(`fixture create failed: ${createError.message}`);
    const txnId = (created as { effects: { canonicalTransactionId: string } }).effects
      .canonicalTransactionId;

    // Casey attacks through his own household (beta): scope violation.
    const { error: scopeError } = await casey.rpc('keel_cmd_set_splits', {
      p_command_id: crypto.randomUUID(),
      p_economic_event_key: `itest:splits:xhh:${txnId}`,
      p_actor: { kind: 'user', userId: SEED.users.casey.id },
      p_household_id: SEED.households.beta,
      p_payload: {
        transaction_id: txnId,
        amount_minor: '-1000',
        splits: [{ category_ledger_account_id: GROCERIES, amount_minor: '1000' }],
      },
    });
    expect(scopeError?.code).toBe('P0006');
  });
});
