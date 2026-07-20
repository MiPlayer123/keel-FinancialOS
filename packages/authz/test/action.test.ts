import { describe, expect, it } from 'vitest';
import type { HouseholdRole } from '@keel/contracts';
import {
  ACTIONS,
  ACTION_MINIMUM_ROLES,
  EXPORT_ACTIONS,
  READ_ACTIONS,
  WRITE_ACTIONS,
  isReadAction,
  isWriteAction,
  roleAtLeast,
} from '../src/index.js';

describe('action vocabulary', () => {
  it('contains every Stage 1A command and read action', () => {
    expect(ACTIONS).toEqual([
      'accounts.create',
      'ingest.record_raw_event',
      'ingest.promote_event',
      'journal.post_batch',
      'journal.reverse_batch',
      'connections.link',
      'connections.disconnect',
      'recurring.confirm',
      'recurring.pause',
      'recurring.resume',
      'recurring.cancel',
      'recurring.reject',
      'recurring.reclassify_cadence',
      'recurring.link_schedule',
      'recurring.unlink_schedule',
      'paychecks.create',
      'paychecks.edit',
      'paychecks.reverse',
      'paychecks.restore',
      'paychecks.dismiss_detected',
      'paychecks.save_template',
      'paychecks.set_series_settings',
      'paychecks.apply_template',
      'paychecks.unapply',
      'reimbursements.create_claim',
      'reimbursements.settle',
      'reimbursements.reverse_settlement',
      'reimbursements.reverse_claim',
      'statements.create',
      'statements.approve_draft',
      'statements.dismiss_draft',
      'statements.set_cadence',
      'statements.decide_payment_link',
      'statements.detach_payment_link',
      'statements.apply_holdings',
      'statements.unapply_holdings',
      'reconciliations.close',
      'reconciliations.reopen',
      'transactions.manual_create',
      'transactions.manual_void',
      'transactions.set_splits',
      'transactions.set_date',
      'accounts.dedupe_reconnect',
      'accounts.set_opening_balance',
      'accounts.reanchor_balance',
      'categorization.decide_suggestion',
      'documents.confirm_upload',
      'documents.detach',
      'documents.delete',
      'receipts.decide_match',
      'receipts.detach_match',
      'budgets.set_total',
      'budgets.set_target',
      'budgets.remove_target',
      'budgets.set_expected_income',
      'ledger.trial_balance',
      'transactions.list',
      'recurring.list',
      'recurring.classification',
      'recurring.schedule_links',
      'paychecks.list',
      'paychecks.detected_dismissals',
      'paychecks.templates',
      'paychecks.split_suggestions',
      'reimbursements.list',
      'statements.list',
      'statements.drafts',
      'statements.cadence',
      'statements.find_payment',
      'statements.payment_links',
      'statements.holdings_diff',
      'documents.list_for_target',
      'receipts.inbox',
      'budgets.month',
      'audit.read',
      // AI-agent read reconciliation actions (added after the original Stage 1A
      // snapshot; this list had drifted out of date on main — brought current
      // here since Slice C edits this file). EXPORT_ACTIONS terminates READ_ACTIONS.
      'balances.latest',
      'categories.list',
      'entities.list',
      'budgets.list',
      'notes_tasks.list',
      'transfers.list',
      'transactions.rich',
      'transactions.rich_page',
      'transactions.search',
      'dashboard.net_worth',
      'dashboard.cash_flow',
      'dashboard.cash_flow_forecast',
      'holdings.list',
      'investments.overview',
      'goals.list',
      'rules.list',
      'tags.list',
      'admin.export_all',
      // AGENT_WRITE_ACTIONS (Law 10 Class A — auto+undo notes writes).
      'notes.save',
      'notes.archive',
      'notes.unarchive',
      'ai_profile.save',
      // AI-agent batch 2 write actions (Law 10 Class B — suggest→approve).
      'transactions.categorize',
      'categories.create',
      'categories.rename',
      'tasks.save',
      'tasks.set_status',
    ]);
  });

  it('requires partner for paycheck mutations and viewer for paycheck reads', () => {
    expect(ACTION_MINIMUM_ROLES['paychecks.create']).toBe('partner');
    expect(ACTION_MINIMUM_ROLES['paychecks.edit']).toBe('partner');
    expect(ACTION_MINIMUM_ROLES['paychecks.reverse']).toBe('partner');
    expect(ACTION_MINIMUM_ROLES['paychecks.restore']).toBe('partner');
    expect(ACTION_MINIMUM_ROLES['paychecks.dismiss_detected']).toBe('partner');
    expect(ACTION_MINIMUM_ROLES['paychecks.list']).toBe('viewer');
    expect(ACTION_MINIMUM_ROLES['paychecks.detected_dismissals']).toBe('viewer');
    expect(ACTION_MINIMUM_ROLES['paychecks.templates']).toBe('viewer');
    expect(ACTION_MINIMUM_ROLES['paychecks.split_suggestions']).toBe('viewer');
  });

  it('requires partner for reimbursement mutations and viewer for reads',()=>{
    expect(ACTION_MINIMUM_ROLES['reimbursements.create_claim']).toBe('partner');
    expect(ACTION_MINIMUM_ROLES['reimbursements.settle']).toBe('partner');
    expect(ACTION_MINIMUM_ROLES['reimbursements.reverse_settlement']).toBe('partner');
    expect(ACTION_MINIMUM_ROLES['reimbursements.reverse_claim']).toBe('partner');
    expect(ACTION_MINIMUM_ROLES['reimbursements.list']).toBe('viewer');
  });

  it('requires partner for recurring mutations and viewer for scoped recurring reads', () => {
    expect(ACTION_MINIMUM_ROLES['recurring.confirm']).toBe('partner');
    expect(ACTION_MINIMUM_ROLES['recurring.pause']).toBe('partner');
    expect(ACTION_MINIMUM_ROLES['recurring.resume']).toBe('partner');
    expect(ACTION_MINIMUM_ROLES['recurring.cancel']).toBe('partner');
    expect(ACTION_MINIMUM_ROLES['recurring.reject']).toBe('partner');
    expect(ACTION_MINIMUM_ROLES['recurring.reclassify_cadence']).toBe('partner');
    expect(ACTION_MINIMUM_ROLES['recurring.list']).toBe('viewer');
  });

  it('maps ordinary reads to viewer, writes to partner, and export to owner', () => {
    for (const action of READ_ACTIONS.filter((action) => action !== 'admin.export_all')) {
      expect(ACTION_MINIMUM_ROLES[action]).toBe('viewer');
    }

    // Every write is partner-floor EXCEPT paychecks.set_series_settings, which
    // is an OWNER-floor policy change (the per-series autonomy grant —
    // paycheck-split-templates-v2.md §3/[AMENDED 6]; enforced in the DB too via
    // keel_assert_member_owner). This is the one write that legitimately needs
    // owner; new writes default to partner.
    const OWNER_FLOOR_WRITES: readonly string[] = ['paychecks.set_series_settings'];
    for (const action of WRITE_ACTIONS) {
      expect(ACTION_MINIMUM_ROLES[action]).toBe(
        OWNER_FLOOR_WRITES.includes(action) ? 'owner' : 'partner',
      );
    }
    expect(ACTION_MINIMUM_ROLES['paychecks.set_series_settings']).toBe('owner');
    expect(ACTION_MINIMUM_ROLES['paychecks.save_template']).toBe('partner');
    expect(ACTION_MINIMUM_ROLES['paychecks.apply_template']).toBe('partner');
    expect(ACTION_MINIMUM_ROLES['paychecks.unapply']).toBe('partner');

    expect(EXPORT_ACTIONS).toEqual(['admin.export_all']);
    expect(ACTION_MINIMUM_ROLES['admin.export_all']).toBe('owner');
    expect(isReadAction('admin.export_all')).toBe(true);
    expect(isWriteAction('admin.export_all')).toBe(false);
  });
});

describe('role lattice', () => {
  it.each([
    { role: 'owner', read: true, write: true, export: true },
    { role: 'partner', read: true, write: true, export: false },
    { role: 'viewer', read: true, write: false, export: false },
    { role: 'professional', read: true, write: false, export: false },
  ] satisfies readonly { role: HouseholdRole; read: boolean; write: boolean; export: boolean }[])(
    '$role has the expected read/write/export access',
    ({ role, read, write, export: canExport }) => {
      expect(roleAtLeast(role, 'viewer')).toBe(read);
      expect(roleAtLeast(role, 'partner')).toBe(write);
      expect(roleAtLeast(role, 'owner')).toBe(canExport);
    },
  );
});
