/**
 * Regression (migration 20260720220000): a user-created CUSTOM category has
 * pfc_key = null. keel_list_transactions_rich must report categoryPfcKey from
 * the OVERLAY (null for a custom category), never leaking the underlying posting
 * offset's 'uncategorized_*' key. The old coalesce(catov.pfc_key, one_pfc_key)
 * fell through to the offset when catov.pfc_key was null, so a transaction filed
 * under a custom category read as "Still uncategorized" on the Review page
 * (isUncategorized inspects pfc_key first). This regressed 419 real rows.
 */
import { describe, expect, it } from 'vitest';
import { SEED, signIn } from './helpers.js';

const HOUSEHOLD = SEED.households.alpha;
const ACTOR = { kind: 'user' as const, userId: SEED.users.alex.id };
// Uncategorized Expense landing pad (alpha entity a101) — supabase/seed.sql.
const UNCATEGORIZED_EXPENSE = '00000000-0000-4000-8000-00000000a317';

type RichRow = {
  transactionId: string;
  categoryName: string | null;
  categoryPfcKey: string | null;
  categoryLedgerAccountId: string | null;
};

describe('keel_list_transactions_rich — custom-category pfc_key (regression 20260720220000)', () => {
  it('reports the overlay pfc_key (null), not the underlying uncategorized offset', async () => {
    const alex = await signIn(SEED.users.alex.email);
    const token = `customcat${Date.now().toString(36)}`;

    // (1) An uncategorized transaction on the Uncategorized Expense landing pad.
    const { data: mt, error: mtErr } = await alex.rpc('keel_cmd_manual_transaction', {
      p_command_id: crypto.randomUUID(),
      p_economic_event_key: `itest:customcat:${crypto.randomUUID()}`,
      p_actor: ACTOR,
      p_household_id: HOUSEHOLD,
      p_payload: {
        account_id: SEED.accounts.alphaChecking,
        description: `TRIP FRONT ${token}`,
        effective_date: new Date().toISOString().slice(0, 10),
        status: 'posted',
        amount_minor: '-4300',
        splits: [{ category_ledger_account_id: UNCATEGORIZED_EXPENSE, amount_minor: '4300' }],
      },
    });
    if (mtErr) throw new Error(`manual txn failed: ${mtErr.message}`);
    const txnId = (mt as { effects: { canonicalTransactionId: string } }).effects
      .canonicalTransactionId;

    // (2) The user creates a custom category (pfc_key = null) and files it there.
    const catName = `Trip ${token}`;
    const { data: catId, error: catErr } = await alex.rpc('keel_create_category', {
      p_household_id: HOUSEHOLD,
      p_name: catName,
      p_kind: 'expense',
      p_parent_ledger_account_id: null,
      p_entity_id: SEED.entities.alphaPersonal,
    });
    if (catErr) throw new Error(`create category failed: ${catErr.message}`);

    const { error: catzErr } = await alex.rpc('keel_categorize_transaction', {
      p_household_id: HOUSEHOLD,
      p_txn_id: txnId,
      p_category_ledger_account_id: catId as string,
    });
    if (catzErr) throw new Error(`categorize failed: ${catzErr.message}`);

    // (3) The rich read model must reflect the overlay: real name, NULL pfc_key.
    const { data: rich, error: richErr } = await alex.rpc('keel_list_transactions_rich', {
      p_household_id: HOUSEHOLD,
    });
    if (richErr) throw new Error(`rich list failed: ${richErr.message}`);
    const row = (rich as { rows: RichRow[] }).rows.find((r) => r.transactionId === txnId);
    expect(row).toBeDefined();
    expect(row!.categoryLedgerAccountId).toBe(catId);
    expect(row!.categoryName).toBe(catName);
    // The regression: must be null (overlay), NOT 'uncategorized_expense'.
    expect(row!.categoryPfcKey).toBeNull();

    // (4) …so the Review-page predicate (isUncategorized: pfc_key first, then
    // name) treats it as categorized rather than "Still uncategorized".
    const isUncat =
      row!.categoryPfcKey != null
        ? row!.categoryPfcKey.startsWith('uncategorized')
        : row!.categoryName
          ? row!.categoryName.startsWith('Uncategorized')
          : true;
    expect(isUncat).toBe(false);
  });
});
