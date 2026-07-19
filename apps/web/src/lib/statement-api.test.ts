import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock the Supabase browser client so keel-api's `invoke`/`keelCommand` can be
// exercised in node (no DOM). functions.invoke returns { data, error }; storage
// uploadToSignedUrl returns { error }.
const invokeCalls: { fn: string; body: Record<string, unknown> }[] = [];
const invokeNext: unknown[] = [];
const invokeMock = vi.fn((fn: string, opts: { body: Record<string, unknown> }) => {
  invokeCalls.push({ fn, body: opts.body });
  return Promise.resolve({ data: invokeNext.shift() ?? {}, error: null });
});
const uploadToSignedUrl = vi.fn(() => Promise.resolve({ error: null }));

vi.mock('@/lib/supabase', () => ({
  getSupabaseBrowserClient: () => ({
    functions: { invoke: invokeMock },
    storage: { from: () => ({ uploadToSignedUrl }) },
  }),
}));

import {
  uploadStatement,
  issueStatementDraftApproval,
  approveStatementDraft,
} from './keel-api';
import type { StatementBody } from './statement-approve';

afterEach(() => {
  invokeCalls.length = 0;
  invokeNext.length = 0;
  invokeMock.mockClear();
  uploadToSignedUrl.mockClear();
});

function pngFile(): File {
  return new File([new Uint8Array([1, 2, 3])], 'statement.pdf', { type: 'application/pdf' });
}

describe('uploadStatement (ingest mode)', () => {
  it('mints an upload URL, PUTs bytes, then confirms with mode:ingest + account', async () => {
    invokeNext.push(
      { documentId: 'doc-1', storageBucket: 'statements', storagePath: 'p', uploadUrl: 'u', token: 't' },
      { duplicate: false, draftId: 'draft-1', documentVersionId: 'dv-1' },
    );
    const res = await uploadStatement({
      householdId: 'hh',
      entityId: 'ent',
      accountId: 'acc',
      file: pngFile(),
    });
    expect(res).toEqual({ duplicate: false, draftId: 'draft-1', documentVersionId: 'dv-1' });
    const confirm = invokeCalls.find((c) => c.fn === 'api/documents/confirm-upload');
    expect(confirm?.body).toMatchObject({ mode: 'ingest', accountId: 'acc', kind: 'statement' });
    expect(uploadToSignedUrl).toHaveBeenCalledOnce();
  });

  it('surfaces a re-upload as duplicate (not an error) [A4]', async () => {
    invokeNext.push(
      { documentId: 'doc-1', storageBucket: 'statements', storagePath: 'p', uploadUrl: 'u', token: 't' },
      { duplicate: true, draftId: 'existing-draft', documentVersionId: 'dv-1' },
    );
    const res = await uploadStatement({
      householdId: 'hh',
      entityId: 'ent',
      accountId: 'acc',
      file: pngFile(),
    });
    expect(res.duplicate).toBe(true);
    expect(res.draftId).toBe('existing-draft');
  });
});

describe('issue → approve wire shapes (the token gate at the API boundary)', () => {
  const body: StatementBody = {
    periodStart: '2026-06-01',
    periodEnd: '2026-06-30',
    openingMinor: '10000',
    endingMinor: '7550',
    currency: 'USD',
    lines: [{ lineKey: 'line-1', date: '2026-06-05', amountMinor: '-2450', description: 'x' }],
  };

  it('issue posts the statement body + balanceCheck to the bespoke route', async () => {
    invokeNext.push({ tokenId: 'tok-1', payloadSha256: 'a'.repeat(64), expiresAt: 'z' });
    await issueStatementDraftApproval({
      householdId: 'hh',
      draftId: 'd',
      balanceCheck: 'strict',
      statement: body,
    });
    const call = invokeCalls.find((c) => c.fn === 'api/statements/issue-draft-approval');
    expect(call?.body).toMatchObject({ draftId: 'd', balanceCheck: 'strict', statement: body });
    // The client never sends sourceHash/accountId in the body — the server binds.
    expect('sourceHash' in (call!.body.statement as object)).toBe(false);
    expect('accountId' in (call!.body.statement as object)).toBe(false);
  });

  it('approve sends the SAME statement body + the token via the command envelope', async () => {
    invokeNext.push({ commandId: 'c', economicEventKey: 'k', idempotentReplay: false, effects: {}, asOf: 'z' });
    await approveStatementDraft({
      householdId: 'hh',
      userId: 'u',
      draftId: 'd',
      approvalTokenId: 'tok-1',
      balanceCheck: 'strict',
      statement: body,
    });
    const call = invokeCalls.find((c) => c.fn === 'api/commands');
    expect(call?.body).toMatchObject({ command: 'statements.approve_draft' });
    const payload = call!.body.payload as Record<string, unknown>;
    expect(payload).toMatchObject({ draftId: 'd', approvalTokenId: 'tok-1', balanceCheck: 'strict' });
    expect(payload.statement).toBe(body);
  });
});
