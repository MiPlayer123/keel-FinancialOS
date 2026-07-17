/**
 * Categorization review loop (P0-B core — suggest→approve for the class-B
 * category write, Laws 2/10/11). Proves, end to end through the real command
 * surface (Law 7: RPC/commands only, zero direct DML on financial tables):
 *   1. Deterministic detection turns a rule match on an uncategorized
 *      transaction into a SUGGESTION (nothing applied).
 *   2. Re-detection is idempotent (no duplicate suggestions).
 *   3. Accepting via categorization.decide_suggestion applies the overlay as
 *      a USER classification, audits the decision, and replays idempotently.
 *   4. Dismissing records the decision and leaves the overlay untouched.
 */
import { describe, expect, it } from 'vitest';
import { serviceClient, SEED, signIn } from './helpers.js';

const HOUSEHOLD = SEED.households.alpha;
const ACTOR = { kind: 'user' as const, userId: SEED.users.alex.id };

// Seed fixtures (supabase/seed.sql): alpha entity a101 categories.
const UNCATEGORIZED_EXPENSE = '00000000-0000-4000-8000-00000000a317';
const COFFEE_SHOPS = '00000000-0000-4000-8000-00000000a314';

type SuggestionRow = {
  suggestionId: string;
  status: string;
  source: string;
  reasonCode: string;
  canonicalTransactionId: string;
  suggestedCategoryLedgerAccountId: string;
  suggestedCategoryName: string;
  currentCategoryName: string;
  rulePattern: string | null;
};

/** Manual transaction filed onto the Uncategorized landing pad → a target. */
const createUncategorizedTxn = async (
  alex: Awaited<ReturnType<typeof signIn>>,
  description: string,
): Promise<string> => {
  const { data, error } = await alex.rpc('keel_cmd_manual_transaction', {
    p_command_id: crypto.randomUUID(),
    p_economic_event_key: `itest:cat:txn:${crypto.randomUUID()}`,
    p_actor: ACTOR,
    p_household_id: HOUSEHOLD,
    p_payload: {
      account_id: SEED.accounts.alphaChecking,
      description,
      effective_date: new Date().toISOString().slice(0, 10),
      status: 'posted',
      amount_minor: '-4300',
      splits: [{ category_ledger_account_id: UNCATEGORIZED_EXPENSE, amount_minor: '4300' }],
    },
  });
  if (error) throw new Error(`manual transaction failed: ${error.message}`);
  return (data as { effects: { canonicalTransactionId: string } }).effects
    .canonicalTransactionId;
};

const listSuggestions = async (
  alex: Awaited<ReturnType<typeof signIn>>,
): Promise<SuggestionRow[]> => {
  const { data, error } = await alex.rpc('keel_list_category_suggestions', {
    p_household_id: HOUSEHOLD,
  });
  if (error) throw new Error(`list failed: ${error.message}`);
  return (data as { rows: SuggestionRow[] }).rows;
};

describe('categorization.decide_suggestion (P0-B suggest→approve loop)', () => {
  it('detects, lists, accepts (overlay + audit + idempotent replay) and dismisses', async () => {
    const alex = await signIn(SEED.users.alex.email);
    const svc = serviceClient();

    // Unique lowercase token so this run's rule matches ONLY this run's rows.
    const token = `itestcat${Date.now().toString(36)}`;
    const txn1 = await createUncategorizedTxn(alex, `BLUE BOTTLE ${token} #1`);
    const txn2 = await createUncategorizedTxn(alex, `BLUE BOTTLE ${token} #2`);

    // User rule: description containing the token files under Coffee Shops.
    const { error: ruleError } = await alex.rpc('keel_rule_save', {
      p_household_id: HOUSEHOLD,
      p_rule_id: null,
      p_pattern: token,
      p_category_ledger_account_id: COFFEE_SHOPS,
      p_rename_to: null,
      p_priority: 5,
      p_active: true,
    });
    if (ruleError) throw new Error(`rule save failed: ${ruleError.message}`);

    // (1) Detection proposes; nothing is applied yet (suggest→approve).
    const { data: detected, error: detectError } = await alex.rpc(
      'keel_detect_category_suggestions',
      { p_household_id: HOUSEHOLD },
    );
    if (detectError) throw new Error(`detect failed: ${detectError.message}`);
    expect(detected as number).toBeGreaterThanOrEqual(2);

    const rows = await listSuggestions(alex);
    const s1 = rows.find((r) => r.canonicalTransactionId === txn1);
    const s2 = rows.find((r) => r.canonicalTransactionId === txn2);
    expect(s1).toBeDefined();
    expect(s2).toBeDefined();
    expect(s1!.source).toBe('rule');
    expect(s1!.reasonCode).toBe('rule_match');
    expect(s1!.rulePattern).toBe(token);
    expect(s1!.suggestedCategoryLedgerAccountId).toBe(COFFEE_SHOPS);
    expect(s1!.currentCategoryName).toBe('Uncategorized Expense');

    // The suggestion did NOT touch the classification: "untouched" means no
    // overlay at all, or an overlay still on the landing pad (a single-split
    // manual transaction pins a 'user' overlay on its split category —
    // 20260713100000 §1 — so the landing-pad row is the expected shape here).
    // Read errors must THROW: CI runs 29558625154/29559262657 proved a
    // missing service_role grant surfaces as 42501 → data:null, which
    // masquerades as "no row" and misdirects the diagnosis.
    const overlayBefore = await svc
      .from('transaction_categories')
      .select('category_ledger_account_id, source')
      .eq('canonical_transaction_id', txn1)
      .maybeSingle();
    if (overlayBefore.error) throw new Error(`overlay read failed: ${overlayBefore.error.message}`);
    expect(
      overlayBefore.data === null ||
        overlayBefore.data.category_ledger_account_id === UNCATEGORIZED_EXPENSE,
    ).toBe(true);

    // (2) Idempotent re-detection: no duplicates for already-suggested rows.
    // (Other suites sharing this stack may legitimately add THEIR suggestions,
    // so assert on our transactions rather than a global zero.)
    const { error: redetectError } = await alex.rpc('keel_detect_category_suggestions', {
      p_household_id: HOUSEHOLD,
    });
    if (redetectError) throw new Error(`re-detect failed: ${redetectError.message}`);
    const rowsAgain = await listSuggestions(alex);
    expect(rowsAgain.filter((r) => r.canonicalTransactionId === txn1)).toHaveLength(1);
    expect(rowsAgain.filter((r) => r.canonicalTransactionId === txn2)).toHaveLength(1);

    // (3) Accept through the command envelope.
    const acceptEnvelope = {
      p_command_id: crypto.randomUUID(),
      p_economic_event_key: `itest:cat:decide:${s1!.suggestionId}:accept`,
      p_actor: ACTOR,
      p_household_id: HOUSEHOLD,
      p_payload: { suggestion_id: s1!.suggestionId, accept: true },
    };
    const { data: acceptResult, error: acceptError } = await alex.rpc(
      'keel_cmd_decide_category_suggestion',
      acceptEnvelope,
    );
    if (acceptError) throw new Error(`accept failed: ${acceptError.message}`);
    const acceptEffects = (acceptResult as {
      idempotentReplay: boolean;
      effects: { status: string; categoryLedgerAccountId: string };
    });
    expect(acceptEffects.idempotentReplay).toBe(false);
    expect(acceptEffects.effects.status).toBe('accepted');
    expect(acceptEffects.effects.categoryLedgerAccountId).toBe(COFFEE_SHOPS);

    // Overlay applied as a USER classification (rules can never clobber it).
    const overlayAfter = await svc
      .from('transaction_categories')
      .select('category_ledger_account_id, source')
      .eq('canonical_transaction_id', txn1)
      .single();
    if (overlayAfter.error) throw new Error(`overlay read failed: ${overlayAfter.error.message}`);
    expect(overlayAfter.data.category_ledger_account_id).toBe(COFFEE_SHOPS);
    expect(overlayAfter.data.source).toBe('user');

    // Law 2: the decision is on the append-only audit trail.
    const { count: auditCount, error: auditError } = await svc
      .from('audit_log')
      .select('*', { count: 'exact', head: true })
      .eq('action', 'categorization.decide_suggestion')
      .eq('object_id', s1!.suggestionId);
    if (auditError) throw new Error(auditError.message);
    expect(auditCount).toBe(1);

    // Law 9: replaying the same economic event is a no-op replay, not a
    // second execution (and not an error).
    const { data: replay, error: replayError } = await alex.rpc(
      'keel_cmd_decide_category_suggestion',
      acceptEnvelope,
    );
    if (replayError) throw new Error(`replay failed: ${replayError.message}`);
    expect((replay as { idempotentReplay: boolean }).idempotentReplay).toBe(true);
    const { count: auditCountAfterReplay } = await svc
      .from('audit_log')
      .select('*', { count: 'exact', head: true })
      .eq('action', 'categorization.decide_suggestion')
      .eq('object_id', s1!.suggestionId);
    expect(auditCountAfterReplay).toBe(1);

    // Accepted suggestions leave the pending list.
    const pending = await listSuggestions(alex);
    expect(pending.find((r) => r.canonicalTransactionId === txn1)).toBeUndefined();

    // (4) Dismiss the second suggestion: decision recorded, overlay untouched.
    const { data: dismissResult, error: dismissError } = await alex.rpc(
      'keel_cmd_decide_category_suggestion',
      {
        p_command_id: crypto.randomUUID(),
        p_economic_event_key: `itest:cat:decide:${s2!.suggestionId}:dismiss`,
        p_actor: ACTOR,
        p_household_id: HOUSEHOLD,
        p_payload: { suggestion_id: s2!.suggestionId, accept: false },
      },
    );
    if (dismissError) throw new Error(`dismiss failed: ${dismissError.message}`);
    expect((dismissResult as { effects: { status: string } }).effects.status).toBe('dismissed');

    // Dismiss writes nothing to the classification — same absent-or-landing-pad
    // shape as the pre-decision check above.
    const overlay2 = await svc
      .from('transaction_categories')
      .select('category_ledger_account_id')
      .eq('canonical_transaction_id', txn2)
      .maybeSingle();
    if (overlay2.error) throw new Error(`overlay read failed: ${overlay2.error.message}`);
    expect(
      overlay2.data === null ||
        overlay2.data.category_ledger_account_id === UNCATEGORIZED_EXPENSE,
    ).toBe(true);

    // A dismissed suggestion holds its unique slot: never re-raised.
    const { error: postDismissError } = await alex.rpc('keel_detect_category_suggestions', {
      p_household_id: HOUSEHOLD,
    });
    if (postDismissError) throw new Error(postDismissError.message);
    const finalPending = await listSuggestions(alex);
    expect(finalPending.find((r) => r.canonicalTransactionId === txn1)).toBeUndefined();
    expect(finalPending.find((r) => r.canonicalTransactionId === txn2)).toBeUndefined();

    // (5) Stale-suggestion guard (adversarial review P1-2, Law 9): the user
    // settles the classification between detection and approval — the card
    // must drop off the read model and accept must fail typed rather than
    // silently overwrite the user's own decision.
    const txn3 = await createUncategorizedTxn(alex, `BLUE BOTTLE ${token} #3`);
    const { error: detect3Error } = await alex.rpc('keel_detect_category_suggestions', {
      p_household_id: HOUSEHOLD,
    });
    if (detect3Error) throw new Error(detect3Error.message);
    const s3 = (await listSuggestions(alex)).find((r) => r.canonicalTransactionId === txn3);
    expect(s3).toBeDefined();

    // Reason line provenance (adversarial review P2-2): the FROZEN
    // as-detected pattern drives the card; the live pattern rides separately.
    expect(s3!.rulePattern).toBe(token);

    // User recategorizes the transaction himself (Groceries, source 'user').
    const { error: recatError } = await alex.rpc('keel_categorize_transaction', {
      p_household_id: HOUSEHOLD,
      p_txn_id: txn3,
      p_category_ledger_account_id: SEED.ledgerAccounts.alphaGroceries,
    });
    if (recatError) throw new Error(`recategorize failed: ${recatError.message}`);

    // Settled row drops off the Review read model.
    expect(
      (await listSuggestions(alex)).find((r) => r.canonicalTransactionId === txn3),
    ).toBeUndefined();

    // Accepting the stale suggestion fails typed (P0009) and changes nothing.
    const { error: staleError } = await alex.rpc('keel_cmd_decide_category_suggestion', {
      p_command_id: crypto.randomUUID(),
      p_economic_event_key: `itest:cat:decide:${s3!.suggestionId}:stale`,
      p_actor: ACTOR,
      p_household_id: HOUSEHOLD,
      p_payload: { suggestion_id: s3!.suggestionId, accept: true },
    });
    expect(staleError?.code).toBe('P0009');

    const overlay3 = await svc
      .from('transaction_categories')
      .select('category_ledger_account_id, source')
      .eq('canonical_transaction_id', txn3)
      .single();
    if (overlay3.error) throw new Error(`overlay read failed: ${overlay3.error.message}`);
    expect(overlay3.data.category_ledger_account_id).toBe(SEED.ledgerAccounts.alphaGroceries);
    expect(overlay3.data.source).toBe('user');
  });
});
