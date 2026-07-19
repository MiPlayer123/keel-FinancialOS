import { describe, expect, it, vi } from 'vitest';

import {
  buildStatementBody,
  runIssueThenApprove,
  type ApproveDeps,
  type ApproveFormInput,
  type StatementBody,
} from './statement-approve';

const strictForm: ApproveFormInput = {
  periodStart: '2026-06-01',
  periodEnd: '2026-06-30',
  opening: '100.00',
  ending: '75.50',
  currency: 'USD',
  balanceCheck: 'strict',
  lines: [
    { date: '2026-06-05', amount: '-20.00', description: 'Coffee' },
    { date: '2026-06-15', amount: '-4.50', description: 'Snack' },
  ],
};

describe('buildStatementBody', () => {
  it('builds a balanced strict body and omits sourceHash/accountId (server binds them)', () => {
    const res = buildStatementBody(strictForm);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // opening + Σ lines = ending: 10000 + (-2000 -450) = 7550 == endingMinor.
    expect(res.body.openingMinor).toBe('10000');
    expect(res.body.endingMinor).toBe('7550');
    expect(res.body.currency).toBe('USD');
    expect(res.body.lines).toHaveLength(2);
    expect(res.body.lines[0]).toEqual({
      lineKey: 'line-1',
      date: '2026-06-05',
      amountMinor: '-2000',
      description: 'Coffee',
    });
    // The client MUST NOT carry sourceHash/accountId — the server binds those.
    expect('sourceHash' in res.body).toBe(false);
    expect('accountId' in res.body).toBe(false);
  });

  it('uses the account currency, not a hardcoded USD [A6]', () => {
    const res = buildStatementBody({ ...strictForm, currency: 'EUR' });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.body.currency).toBe('EUR');
  });

  it('rejects a strict statement whose lines do not reconcile', () => {
    const res = buildStatementBody({ ...strictForm, ending: '80.00' });
    expect(res.ok).toBe(false);
  });

  it('supports a ZERO-LINE anchor statement [A6]', () => {
    const res = buildStatementBody({
      periodStart: '2026-06-01',
      periodEnd: '2026-06-30',
      opening: '1000.00',
      ending: '1234.56',
      currency: 'USD',
      balanceCheck: 'anchor',
      anchorReason: 'investment_valuation',
      anchorGapExplanation: 'market moves, no per-trade detail',
      lines: [],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.body.lines).toHaveLength(0);
    expect(res.body.anchorReason).toBe('investment_valuation');
    // Anchor does NOT require opening + Σ = ending; a nonzero gap is fine.
    expect(res.body.endingMinor).toBe('123456');
  });

  it('requires a reason + gap for anchor mode', () => {
    const res = buildStatementBody({
      periodStart: '2026-06-01',
      periodEnd: '2026-06-30',
      opening: '0',
      ending: '100.00',
      currency: 'USD',
      balanceCheck: 'anchor',
      lines: [],
    });
    expect(res.ok).toBe(false);
  });

  it('rejects a line outside the period', () => {
    const res = buildStatementBody({
      ...strictForm,
      lines: [{ date: '2026-05-01', amount: '-24.50', description: 'early' }],
      ending: '75.50',
    });
    expect(res.ok).toBe(false);
  });
});

describe('runIssueThenApprove — the client half of the token gate (Law 11)', () => {
  const body: StatementBody = {
    periodStart: '2026-06-01',
    periodEnd: '2026-06-30',
    openingMinor: '10000',
    endingMinor: '7550',
    currency: 'USD',
    lines: [
      { lineKey: 'line-1', date: '2026-06-05', amountMinor: '-2000', description: 'Coffee' },
      { lineKey: 'line-2', date: '2026-06-15', amountMinor: '-450', description: 'Snack' },
    ],
  };

  function makeDeps() {
    const seen: {
      issue?: Parameters<ApproveDeps['issue']>[0];
      approve?: Parameters<ApproveDeps['approve']>[0];
    } = {};
    const issue: ApproveDeps['issue'] = (input) => {
      seen.issue = input;
      return Promise.resolve({ tokenId: 'tok-123', expiresAt: '2026-06-30T00:05:00Z' });
    };
    const approve: ApproveDeps['approve'] = (input) => {
      seen.approve = input;
      return Promise.resolve({ ok: true });
    };
    const deps: ApproveDeps = { issue, approve };
    return { seen, deps };
  }

  it('issues FIRST, then approves — order matters', async () => {
    const calls: string[] = [];
    const deps: ApproveDeps = {
      issue: vi.fn(() => {
        calls.push('issue');
        return Promise.resolve({ tokenId: 'tok-1', expiresAt: 'z' });
      }),
      approve: vi.fn(() => {
        calls.push('approve');
        return Promise.resolve({});
      }),
    };
    await runIssueThenApprove({
      householdId: 'hh',
      userId: 'u',
      draftId: 'd',
      balanceCheck: 'strict',
      body,
      deps,
    });
    expect(calls).toEqual(['issue', 'approve']);
  });

  it('passes the SAME body object reference to issue AND approve_draft (the binding)', async () => {
    const { seen, deps } = makeDeps();
    await runIssueThenApprove({
      householdId: 'hh',
      userId: 'u',
      draftId: 'd',
      balanceCheck: 'strict',
      body,
      deps,
    });
    const issuedStatement = seen.issue?.statement;
    const approvedStatement = seen.approve?.statement;
    // The exact same object reference — not a re-serialized copy — so the bytes
    // the token binds cannot diverge from the bytes the approve submits.
    expect(issuedStatement).toBe(body);
    expect(approvedStatement).toBe(body);
    expect(issuedStatement).toBe(approvedStatement);
  });

  it('threads the issued tokenId into the approve call, and the same balanceCheck to both', async () => {
    const { seen, deps } = makeDeps();
    await runIssueThenApprove({
      householdId: 'hh',
      userId: 'u',
      draftId: 'd',
      balanceCheck: 'anchor',
      body,
      deps,
    });
    expect(seen.issue?.balanceCheck).toBe('anchor');
    expect(seen.approve?.balanceCheck).toBe('anchor');
    expect(seen.approve?.approvalTokenId).toBe('tok-123');
  });

  it('does NOT approve if issue fails (no unbound write)', async () => {
    const approve = vi.fn(() => Promise.resolve({}));
    const deps: ApproveDeps = {
      issue: () => Promise.reject(new Error('KEEL_APPROVAL_EXPIRED')),
      approve,
    };
    await expect(
      runIssueThenApprove({
        householdId: 'hh',
        userId: 'u',
        draftId: 'd',
        balanceCheck: 'strict',
        body,
        deps,
      }),
    ).rejects.toThrow(/EXPIRED/);
    expect(approve).not.toHaveBeenCalled();
  });
});
