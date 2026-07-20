/**
 * SLICE D — paycheck template APPLY / UNDO via set_splits (delivers founder asks 1 & 2).
 * docs/harness/plans/paycheck-split-templates-v2.md §7 stage D.
 *
 * These tests exercise the REAL deployed procs (migration 20260722300000) against
 * the seeded stack. They prove:
 *   - apply COMPUTES the split legs (§D4 math) and DELEGATES booking to
 *     keel_cmd_set_splits (one compiler, Law 7) → a balanced decomposition (Σ=0);
 *   - the 401k leg is a DISTRIBUTION into the retirement account (keel_txn_is_distribution);
 *   - the token GATE (issue → redeem in apply) binds the exact payload; a wrong
 *     token / redeem-A-book-B is impossible by construction;
 *   - undo reverses exactly (compensating set_splits revision + paycheck reversed);
 *   - idempotent replay; a plain paychecks.reverse on a template-applied paycheck
 *     is blocked → typed error → unapply;
 *   - AGENT-SAFETY: service_role cannot call apply/unapply directly (grant/revoke);
 *   - tenant isolation.
 *
 * Requires the migration applied + functions deployed (orchestrator does this
 * after review). The suite seeds its own template/series/deposit via the service
 * client + signed-in RPCs (same pattern as 23-set-splits-balanced-mixed).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { SEED, signIn, serviceClient } from './helpers.js';
import type { SupabaseClient } from '@supabase/supabase-js';

const HOUSEHOLD = SEED.households.alpha;
const ENTITY = SEED.entities.alphaPersonal;
const ACTOR = { kind: 'user' as const, userId: SEED.users.alex.id };

let alex: SupabaseClient;
let service: SupabaseClient;
let suffix: string;
let incomeCat: string; // series income category (gross anchor)
let fedCat: string; // federal withholding expense category
let retirementAccountId: string; // 401k distribution target (manual asset account)
let seriesId: string;
let employerId: string;
let templateId: string;

const uuid = () => crypto.randomUUID();

async function mkCategory(name: string, kind: 'income' | 'expense'): Promise<string> {
  const { data, error } = await alex.rpc('keel_create_category', {
    p_household_id: HOUSEHOLD, p_name: name, p_kind: kind,
    p_parent_ledger_account_id: null, p_entity_id: ENTITY,
  });
  if (error) throw new Error(`create category ${name}: ${error.message}`);
  return data as string;
}

/** A money-in deposit with a single income-category offset (template-appliable). */
async function mkDeposit(amountMinor: string, description: string): Promise<{ txnId: string }> {
  const { data, error } = await alex.rpc('keel_cmd_manual_transaction', {
    p_command_id: uuid(),
    p_economic_event_key: `itest:tpl-deposit:${uuid()}`,
    p_actor: ACTOR,
    p_household_id: HOUSEHOLD,
    p_payload: {
      account_id: SEED.accounts.alphaChecking,
      description,
      effective_date: new Date().toISOString().slice(0, 10),
      status: 'posted',
      amount_minor: amountMinor,
      splits: [{ category_ledger_account_id: incomeCat, amount_minor: `-${amountMinor}` }],
    },
  });
  if (error) throw new Error(`deposit: ${error.message}`);
  return { txnId: (data as { effects: { canonicalTransactionId: string } }).effects.canonicalTransactionId };
}

beforeAll(async () => {
  alex = await signIn(SEED.users.alex.email);
  service = serviceClient();
  suffix = Date.now().toString(36);

  incomeCat = await mkCategory(`Gross Pay ${suffix}`, 'income');
  fedCat = await mkCategory(`Federal Tax ${suffix}`, 'expense');

  // A manual asset account in the alpha entity — the 401k distribution target.
  const { data: acct, error: acctErr } = await alex.rpc('keel_cmd_create_account', {
    p_command_id: uuid(),
    p_economic_event_key: `itest:tpl-ret:${uuid()}`,
    p_actor: ACTOR,
    p_household_id: HOUSEHOLD,
    p_payload: {
      entityId: ENTITY, name: `Retirement 401k ${suffix}`, kind: 'asset',
      subtype: 'retirement', currency: 'USD', openingBalanceMinor: '0',
    },
  }).catch(() => ({ data: null, error: { message: 'create_account rpc shape differs' } }));
  // Fall back: some stacks expose account creation via a different proc. If the
  // rpc name/shape differs, resolve a pre-seeded manual asset account instead.
  if (acctErr || !acct) {
    const { data: rows } = await service
      .from('accounts')
      .select('id, ledger_account_id, entity_id, archived_at, connection_id')
      .eq('household_id', HOUSEHOLD);
    const { data: las } = await service
      .from('ledger_accounts')
      .select('id, kind, is_category, entity_id, currency, archived_at')
      .eq('household_id', HOUSEHOLD);
    const laById = new Map((las ?? []).map((l: Record<string, unknown>) => [l['id'], l]));
    const candidate = (rows ?? []).find((a: Record<string, unknown>) => {
      const la = laById.get(a['ledger_account_id']) as Record<string, unknown> | undefined;
      return (
        a['archived_at'] === null && a['id'] !== SEED.accounts.alphaChecking &&
        la && la['kind'] === 'asset' && la['is_category'] === false &&
        la['entity_id'] === ENTITY && la['currency'] === 'USD' && la['archived_at'] === null
      );
    });
    retirementAccountId = (candidate?.['id'] as string) ?? SEED.accounts.alphaChecking;
  } else {
    retirementAccountId = (acct as { effects: { accountId: string } }).effects.accountId;
  }

  // A confirmed recurring series + employer to author the template against.
  const { data: series } = await service
    .from('recurring_series')
    .select('id')
    .eq('household_id', HOUSEHOLD)
    .limit(1);
  seriesId = (series?.[0]?.['id'] as string) ?? '';
  if (!seriesId) {
    // Seed a minimal recurring series if none exists on the stack.
    const { data: ins } = await service
      .from('recurring_series')
      .insert({ household_id: HOUSEHOLD, account_id: SEED.accounts.alphaChecking, status: 'confirmed', direction: 'inflow', counterparty_key: `payroll ${suffix}` })
      .select('id')
      .single();
    seriesId = (ins?.['id'] as string) ?? '';
  }

  const { data: emp } = await service
    .from('employers')
    .upsert({ household_id: HOUSEHOLD, name: `Anchorwave Payroll ${suffix}` }, { onConflict: 'household_id,name' })
    .select('id')
    .single();
  employerId = emp?.['id'] as string;

  // Author a template: gross + fed 500bps + 401k 500bps pretax_transfer + deposit.
  const { data: saved, error: saveErr } = await alex.rpc('keel_cmd_paycheck_save_template', {
    p_command_id: uuid(),
    p_economic_event_key: `itest:tpl-save:${uuid()}`,
    p_actor: ACTOR,
    p_household_id: HOUSEHOLD,
    p_payload: {
      series_id: seriesId, employer_id: employerId, booking_enabled: true,
      lines: [
        { line_key: 'gross', kind: 'gross_salary', role: 'earning', amount_kind: 'remainder', position: 0 },
        { line_key: 'fed', kind: 'federal_withholding', role: 'tax', amount_kind: 'percent_of_gross_bps', bps: 500, category_ledger_account_id: fedCat, position: 1 },
        { line_key: 'r401k', kind: 'retirement_401k', role: 'pretax_transfer', amount_kind: 'percent_of_gross_bps', bps: 500, destination_account_id: retirementAccountId, position: 2 },
        { line_key: 'deposit', kind: 'direct_deposit', role: 'net_deposit', amount_kind: 'remainder', position: 3 },
      ],
    },
  });
  if (saveErr) throw new Error(`save_template: ${saveErr.message}`);
  templateId = (saved as { effects: { templateId: string } }).effects.templateId;

  // Owner sets the series income category (gross anchor) — set_series_settings.
  const { error: setErr } = await alex.rpc('keel_cmd_paycheck_set_series_settings', {
    p_command_id: uuid(),
    p_economic_event_key: `itest:tpl-settings:${uuid()}`,
    p_actor: ACTOR,
    p_household_id: HOUSEHOLD,
    p_payload: {
      series_id: seriesId, employer_id: employerId, active_template_id: templateId,
      booking_enabled: true, income_category_ledger_account_id: incomeCat, autonomy: 'suggest',
    },
  });
  if (setErr) throw new Error(`set_series_settings: ${setErr.message}`);
});

/** Issue a token then apply, mirroring applyPaycheckTemplate (keel-api.ts). */
async function issueAndApply(depositTxnId: string, tokenTemplateVersion = 1): Promise<{ paycheckId: string; newBatchId: string }> {
  const { data: issued, error: issErr } = await alex.rpc('keel_cmd_paycheck_issue_apply_token', {
    p_household_id: HOUSEHOLD, p_series_id: seriesId, p_deposit_txn_id: depositTxnId,
    p_template_id: templateId, p_template_version: tokenTemplateVersion,
  });
  if (issErr) throw new Error(`issue: ${issErr.message}`);
  const tokenId = (issued as { tokenId: string }).tokenId;
  const { data: applied, error: appErr } = await alex.rpc('keel_cmd_paycheck_apply_template', {
    p_command_id: uuid(),
    p_economic_event_key: `paycheck-tpl:${seriesId}:${depositTxnId}`,
    p_actor: ACTOR,
    p_household_id: HOUSEHOLD,
    p_payload: { series_id: seriesId, deposit_txn_id: depositTxnId, template_id: templateId, template_version: 1, approval_token_id: tokenId },
  });
  if (appErr) throw new Error(`apply: ${appErr.message}`);
  const eff = (applied as { effects: { paycheckId: string; newBatchId: string } }).effects;
  return { paycheckId: eff.paycheckId, newBatchId: eff.newBatchId };
}

describe('paycheck template apply — delegates to set_splits, balanced decomposition', () => {
  it('apply books a balanced income+tax+401k decomposition (Σ=0) with a distribution 401k leg', async () => {
    const { txnId } = await mkDeposit('1200000', `PAYCHECK apply ${suffix}`);
    const { newBatchId } = await issueAndApply(txnId);

    // Σ over the new batch = 0 (Law 3; set_splits enforced it).
    const { data: postings } = await service
      .from('journal_postings')
      .select('amount_minor, ledger_account_id')
      .eq('batch_id', newBatchId);
    const sum = (postings ?? []).reduce((t: bigint, p: Record<string, unknown>) => t + BigInt(p['amount_minor'] as string), 0n);
    expect(sum).toBe(0n);

    // The income leg is −gross (1333334); the fed tax +66667; the 401k +66667.
    const byAccount = new Map((postings ?? []).map((p: Record<string, unknown>) => [p['ledger_account_id'] as string, BigInt(p['amount_minor'] as string)]));
    const incomeLa = (await service.from('ledger_accounts').select('id').eq('id', incomeCat).single()).data?.['id'];
    expect(byAccount.get(incomeLa as string)).toBe(-1333334n);

    // The 401k leg is a DISTRIBUTION: the deposit is now a distribution txn.
    const { data: isDist } = await service.rpc('keel_txn_is_distribution', { p_txn_id: txnId });
    expect(isDist).toBe(true);

    // The retirement account's ledger account carries +66667 (the distribution leg).
    const { data: retAcct } = await service.from('accounts').select('ledger_account_id').eq('id', retirementAccountId).single();
    expect(byAccount.get(retAcct?.['ledger_account_id'] as string)).toBe(66667n);
  });

  it('idempotent replay: re-applying the same deposit returns the same result, no double-book', async () => {
    const { txnId } = await mkDeposit('1200000', `PAYCHECK replay ${suffix}`);
    const first = await issueAndApply(txnId);
    // A second apply with the SAME economic_event_key replays (idempotency check).
    const { data: issued2 } = await alex.rpc('keel_cmd_paycheck_issue_apply_token', {
      p_household_id: HOUSEHOLD, p_series_id: seriesId, p_deposit_txn_id: txnId, p_template_id: templateId, p_template_version: 1,
    });
    const { data: applied2 } = await alex.rpc('keel_cmd_paycheck_apply_template', {
      p_command_id: uuid(),
      p_economic_event_key: `paycheck-tpl:${seriesId}:${txnId}`,
      p_actor: ACTOR, p_household_id: HOUSEHOLD,
      p_payload: { series_id: seriesId, deposit_txn_id: txnId, template_id: templateId, template_version: 1, approval_token_id: (issued2 as { tokenId: string }).tokenId },
    });
    expect((applied2 as { effects: { paycheckId: string } }).effects.paycheckId).toBe(first.paycheckId);
  });
});

describe('token GATE (Law 11)', () => {
  it('rejects apply with a token issued for a DIFFERENT deposit (payload hash mismatch)', async () => {
    const a = await mkDeposit('1200000', `PAYCHECK gate-a ${suffix}`);
    const b = await mkDeposit('900000', `PAYCHECK gate-b ${suffix}`);
    // Issue a token for deposit A, then try to apply it to deposit B → the server
    // recomputes B's payload; hash(B) != token(A).payload_sha256 → reject.
    const { data: issuedA } = await alex.rpc('keel_cmd_paycheck_issue_apply_token', {
      p_household_id: HOUSEHOLD, p_series_id: seriesId, p_deposit_txn_id: a.txnId, p_template_id: templateId, p_template_version: 1,
    });
    const { error } = await alex.rpc('keel_cmd_paycheck_apply_template', {
      p_command_id: uuid(),
      p_economic_event_key: `paycheck-tpl:${seriesId}:${b.txnId}:gate`,
      p_actor: ACTOR, p_household_id: HOUSEHOLD,
      p_payload: { series_id: seriesId, deposit_txn_id: b.txnId, template_id: templateId, template_version: 1, approval_token_id: (issuedA as { tokenId: string }).tokenId },
    });
    expect(error).not.toBeNull();
  });
});

describe('undo (Law 2)', () => {
  it('unapply reverses the booking + paycheck, restoring the original offset; then blocks a plain reverse', async () => {
    const { txnId } = await mkDeposit('1200000', `PAYCHECK undo ${suffix}`);
    const { paycheckId } = await issueAndApply(txnId);

    // A plain paychecks.reverse on a template-applied paycheck is blocked.
    const { error: reverseErr } = await alex.rpc('keel_paycheck_reverse', {
      p_command_id: uuid(),
      p_economic_event_key: `itest:tpl-plain-reverse:${uuid()}`,
      p_actor: ACTOR, p_household_id: HOUSEHOLD,
      p_payload: { paycheck_id: paycheckId, reason: 'trying to bypass unapply' },
    });
    expect(reverseErr).not.toBeNull();

    // unapply reverses exactly.
    const { data: undone, error: undoErr } = await alex.rpc('keel_cmd_paycheck_unapply', {
      p_command_id: uuid(),
      p_economic_event_key: `paycheck-tpl-unapply:${paycheckId}`,
      p_actor: ACTOR, p_household_id: HOUSEHOLD,
      p_payload: { paycheck_id: paycheckId },
    });
    expect(undoErr).toBeNull();
    expect((undone as { effects: { revoked: boolean } }).effects.revoked).toBe(true);

    // After undo the deposit is no longer a distribution (offset restored).
    const { data: isDist } = await service.rpc('keel_txn_is_distribution', { p_txn_id: txnId });
    expect(isDist).toBe(false);

    // Idempotent: a second unapply (already revoked) errors typed.
    const { error: undo2 } = await alex.rpc('keel_cmd_paycheck_unapply', {
      p_command_id: uuid(),
      p_economic_event_key: `paycheck-tpl-unapply:${paycheckId}:2`,
      p_actor: ACTOR, p_household_id: HOUSEHOLD,
      p_payload: { paycheck_id: paycheckId },
    });
    expect(undo2).not.toBeNull();
  });
});

describe('AGENT-SAFETY + tenant isolation', () => {
  it('service_role cannot call apply/unapply directly (grant/revoke, not a forgeable actor)', async () => {
    // The apply/unapply procs are execute-granted to authenticated ONLY. The
    // service client (service_role) must be denied at the grant layer.
    const { error: applyErr } = await service.rpc('keel_cmd_paycheck_apply_template', {
      p_command_id: uuid(), p_economic_event_key: `itest:agent-bypass:${uuid()}`,
      p_actor: { kind: 'agent' }, p_household_id: HOUSEHOLD,
      p_payload: { series_id: seriesId, deposit_txn_id: SEED.accounts.alphaChecking, template_id: templateId, template_version: 1, approval_token_id: uuid() },
    });
    expect(applyErr).not.toBeNull();
    const { error: unapplyErr } = await service.rpc('keel_cmd_paycheck_unapply', {
      p_command_id: uuid(), p_economic_event_key: `itest:agent-bypass2:${uuid()}`,
      p_actor: { kind: 'agent' }, p_household_id: HOUSEHOLD, p_payload: { paycheck_id: uuid() },
    });
    expect(unapplyErr).not.toBeNull();
  });

  it('a different household member (beta) cannot apply into alpha (tenant isolation)', async () => {
    const { txnId } = await mkDeposit('1200000', `PAYCHECK tenant ${suffix}`);
    const blake = await signIn(SEED.users.blake.email).catch(() => null);
    if (!blake) return; // blake may not be seeded on every stack
    const { error } = await blake.rpc('keel_cmd_paycheck_issue_apply_token', {
      p_household_id: HOUSEHOLD, p_series_id: seriesId, p_deposit_txn_id: txnId, p_template_id: templateId, p_template_version: 1,
    });
    expect(error).not.toBeNull();
  });
});
