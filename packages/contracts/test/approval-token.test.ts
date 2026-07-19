import { describe, expect, it } from 'vitest';
import { ApprovalTokenSchema } from '@keel/contracts';

// SLICE 0 (statement-ingestion-v2.md) — the SQL keel_approval_token_issue proc
// is the enforcement primitive behind ApprovalTokenSchema (Law 11). This proves
// the wire shape the proc returns, combined with the scope/policyVersion the
// caller already holds, satisfies the Zod contract — so the token a class-B+
// command later redeems is a well-typed ApprovalToken end to end.

// Exact JSON the issue proc returns (jsonb_build_object in the migration):
//   { tokenId, payloadSha256, actorUserId, expiresAt }
const issueProcOutput = {
  tokenId: '11111111-1111-4111-8111-111111111111',
  payloadSha256: 'a'.repeat(64),
  actorUserId: '00000000-0000-4000-8000-000000000001',
  expiresAt: '2026-06-30T12:15:00Z',
};

// scope + policyVersion are supplied by the caller at issue time (they are proc
// inputs), so the full ApprovalToken record is the proc output merged with them.
const callerContext = {
  scope: {
    entities: [],
    accounts: ['00000000-0000-4000-8000-00000000a401'],
    period: '2026-06-01/2026-06-30',
  },
  policyVersion: 'statement-close-v1',
};

describe('ApprovalTokenSchema round-trips the issue proc output shape', () => {
  it('parses the proc output merged with the caller scope/policyVersion', () => {
    const token = ApprovalTokenSchema.parse({ ...issueProcOutput, ...callerContext });
    expect(token.tokenId).toBe(issueProcOutput.tokenId);
    expect(token.payloadSha256).toBe(issueProcOutput.payloadSha256);
    expect(token.actorUserId).toBe(issueProcOutput.actorUserId);
    expect(token.expiresAt).toBe(issueProcOutput.expiresAt);
    expect(token.policyVersion).toBe('statement-close-v1');
  });

  it('rejects a payloadSha256 that is not 64 lowercase hex (tamper-shaped)', () => {
    expect(() =>
      ApprovalTokenSchema.parse({ ...issueProcOutput, ...callerContext, payloadSha256: 'ZZZ' }),
    ).toThrow();
    // An UPPERCASE 64-char hex is also rejected — the SQL CHECK is ^[a-f0-9]{64}$.
    expect(() =>
      ApprovalTokenSchema.parse({ ...issueProcOutput, ...callerContext, payloadSha256: 'A'.repeat(64) }),
    ).toThrow();
  });

  it('requires the actor to be a valid user id (forgery guard is upstream, shape guard is here)', () => {
    expect(() =>
      ApprovalTokenSchema.parse({ ...issueProcOutput, ...callerContext, actorUserId: 'not-a-uuid' }),
    ).toThrow();
  });
});
