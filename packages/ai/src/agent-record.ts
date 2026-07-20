/**
 * Typed agent response record (Law 11 — material AI outputs are records, never
 * bare strings). The model owns ONLY the prose; every provenance field is
 * stamped by the server from the session it compiled, so the model cannot
 * fabricate provenance (Law 9 by construction).
 *
 * Slice 1 is read-only: `proposedActions` is always empty. The write slices
 * populate it with approval-token-bound proposals (budgets, reimbursements);
 * notes are auto-applied and reported in `appliedActions` instead.
 */
import type { SnapshotScope } from './snapshot.js';
import { AGENT_PROMPT_VERSION } from './agent-prompt.js';

export const AGENT_TLDR_MAX_LENGTH = 280;

/** How the UI reverses an auto-applied action (Law 2: every AI write is undoable). */
export interface AppliedActionUndo {
  readonly op: 'archive_note' | 'unarchive_note' | 'edit_note';
  readonly noteId: string;
  /** Prior body, for edit-undo (re-apply what was there before). */
  readonly body?: string;
  readonly pinned?: boolean;
}

/** A change the agent already applied (Class A auto, undoable). */
export interface AppliedAction {
  readonly kind: string;
  readonly summary: string;
  /** Object id the action affected. */
  readonly ref: string;
  /** Present when the UI can offer a one-tap undo. */
  readonly undo?: AppliedActionUndo;
}

/** A change the agent proposes; requires the user's approval (Class B). */
export interface ProposedAction {
  readonly kind: string;
  readonly summary: string;
  /** Law-11 approval token id binding the exact payload; redeemed on approve. */
  readonly approvalTokenId: string;
  /** Opaque, server-normalized payload the token is bound to. */
  readonly payload: Record<string, unknown>;
  readonly expiresAt: string;
}

export interface AgentResponseRecord {
  readonly tldr: string;
  readonly body: string;
  readonly asOf: string;
  readonly scope: SnapshotScope;
  /** True while the agent only read data / applied auto actions. */
  readonly displayOnly: boolean;
  readonly modelVersion: string;
  readonly promptVersion: string;
  /** Read tools the agent invoked, in order — the evidence for its answer. */
  readonly toolsUsed: readonly string[];
  readonly steps: number;
  readonly stoppedReason: 'final' | 'max_steps';
  readonly appliedActions: readonly AppliedAction[];
  readonly proposedActions: readonly ProposedAction[];
}

export class EmptyAgentResponseError extends Error {
  constructor() {
    super('Agent returned an empty response.');
    this.name = 'EmptyAgentResponseError';
  }
}

const deriveTldr = (text: string, max: number): string => {
  const firstParagraph = text.split(/\n\s*\n/, 1)[0] ?? text;
  const collapsed = firstParagraph.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= max) return collapsed;
  const cut = collapsed.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${cut.slice(0, lastSpace > max / 2 ? lastSpace : max - 1).trimEnd()}…`;
};

export interface BuildAgentRecordInput {
  readonly text: string;
  readonly asOf: string;
  readonly scope: SnapshotScope;
  readonly modelVersion: string;
  readonly toolsUsed: readonly string[];
  readonly steps: number;
  readonly stoppedReason: 'final' | 'max_steps';
  readonly appliedActions?: readonly AppliedAction[];
  readonly proposedActions?: readonly ProposedAction[];
}

export const buildAgentResponseRecord = (input: BuildAgentRecordInput): AgentResponseRecord => {
  const body = input.text.trim();
  if (body.length === 0) throw new EmptyAgentResponseError();
  if (input.modelVersion.trim().length === 0) {
    throw new Error('modelVersion is required on every agent record (Law 9).');
  }
  const proposedActions = input.proposedActions ?? [];
  const appliedActions = input.appliedActions ?? [];
  return {
    tldr: deriveTldr(body, AGENT_TLDR_MAX_LENGTH),
    body,
    asOf: input.asOf,
    scope: input.scope,
    displayOnly: proposedActions.length === 0 && appliedActions.length === 0,
    modelVersion: input.modelVersion,
    promptVersion: AGENT_PROMPT_VERSION,
    toolsUsed: input.toolsUsed,
    steps: input.steps,
    stoppedReason: input.stoppedReason,
    appliedActions,
    proposedActions,
  };
};
