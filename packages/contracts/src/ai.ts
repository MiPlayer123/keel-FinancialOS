import { z } from 'zod';
import { UserIdSchema } from './ids.js';
import { AiRiskClassSchema } from './enums.js';

/**
 * Typed AI response contract (CLAUDE.md Law 11, BC-v2.1 §3 "AI and agent
 * control"). Every material AI output is a record, never loose prose.
 */
export const AiVerdictSchema = z.enum(['yes', 'no', 'uncertain']);

export const AiScopeSchema = z.object({
  entities: z.array(z.string()),
  accounts: z.array(z.string()),
  period: z.string(), // e.g. "2026-06-01/2026-06-30"
});

export const AiProposedActionSchema = z.object({
  command: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  riskClass: AiRiskClassSchema,
});

export const AiResponseRecordSchema = z.object({
  verdict: AiVerdictSchema,
  tldr: z.string().min(1).max(500),
  confidence: z.number().min(0).max(1),
  asOf: z.iso.datetime(),
  scope: AiScopeSchema,
  reasonCodes: z.array(z.string()),
  evidenceRefs: z.array(z.string()),
  proposedActions: z.array(AiProposedActionSchema),
  requiresApproval: z.boolean(),
  modelVersion: z.string().min(1),
  promptVersion: z.string().min(1),
  policyVersion: z.string().min(1),
});
export type AiResponseRecord = z.infer<typeof AiResponseRecordSchema>;

/**
 * Approval tokens bind actor, exact payload hash, scope, policy version, and
 * expiry (Law 11). A class-B+ proposed action executes only with a token whose
 * hash matches the exact payload being executed.
 */
export const ApprovalTokenSchema = z.object({
  tokenId: z.uuid(),
  actorUserId: UserIdSchema,
  payloadSha256: z.string().regex(/^[a-f0-9]{64}$/),
  scope: AiScopeSchema,
  policyVersion: z.string().min(1),
  expiresAt: z.iso.datetime(),
});
export type ApprovalToken = z.infer<typeof ApprovalTokenSchema>;
