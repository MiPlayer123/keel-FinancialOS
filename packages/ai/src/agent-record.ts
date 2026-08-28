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
export const AGENT_POLICY_VERSION = 'keel-ai-policy@v1';

/** How the UI reverses an auto-applied action (Law 2: every AI write is undoable). */
export interface AppliedActionUndo {
  readonly op:
    | 'archive_note'
    | 'unarchive_note'
    | 'edit_note'
    | 'set_task_status'
    | 'edit_task'
    | 'detach_document';
  /** Present for note ops. */
  readonly noteId?: string;
  /** Present for task ops. */
  readonly taskId?: string;
  /** Present for detach_document (the receipt attachment to remove). */
  readonly attachmentId?: string;
  /** Prior body, for note edit-undo. */
  readonly body?: string;
  readonly pinned?: boolean;
  /** For set_task_status undo (restore prior status). */
  readonly status?: 'open' | 'done' | 'dismissed';
  /** Prior task fields, for task edit-undo. */
  readonly title?: string;
  readonly description?: string | null;
  readonly dueOn?: string | null;
  readonly priority?: 'low' | 'normal' | 'high';
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

/**
 * A change the agent proposes; requires the user's explicit approval before it
 * happens (Class B, suggest→approve — Law 2/10). The agent NEVER dispatches
 * these; it only stages the exact command + payload. On approve, the UI issues
 * the change as a normal authorized user command (the user already has direct
 * write capability — no new privilege), so the approval IS the user acting.
 */
export interface ProposedAction {
  /** e.g. 'budgets.set_target' — also the command dispatched on approve. */
  readonly kind: string;
  /** The authorized command name the UI dispatches when the user approves. */
  readonly command: string;
  /** Human-readable description of exactly what will change. */
  readonly summary: string;
  /** The exact command payload (contracts shape) shown and approved. */
  readonly payload: Record<string, unknown>;
}

export interface AgentResponseRecord {
  readonly verdict: 'yes' | 'no' | 'uncertain';
  readonly tldr: string;
  readonly body: string;
  readonly confidence: number | null;
  readonly asOf: string;
  readonly scope: SnapshotScope;
  readonly reasonCodes: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly requiresApproval: boolean;
  /** True while the agent only read data / applied auto actions. */
  readonly displayOnly: boolean;
  readonly modelVersion: string;
  readonly promptVersion: string;
  readonly policyVersion: string;
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
    verdict: 'uncertain',
    tldr: deriveTldr(body, AGENT_TLDR_MAX_LENGTH),
    body,
    confidence: null,
    asOf: input.asOf,
    scope: input.scope,
    reasonCodes: [
      input.toolsUsed.length > 0 ? 'TOOL_EVIDENCE' : 'NO_TOOL_EVIDENCE',
      'CONFIDENCE_UNAVAILABLE',
    ],
    evidenceRefs: [...new Set(input.toolsUsed)],
    requiresApproval: proposedActions.length > 0,
    displayOnly: proposedActions.length === 0 && appliedActions.length === 0,
    modelVersion: input.modelVersion,
    promptVersion: AGENT_PROMPT_VERSION,
    policyVersion: AGENT_POLICY_VERSION,
    toolsUsed: input.toolsUsed,
    steps: input.steps,
    stoppedReason: input.stoppedReason,
    appliedActions,
    proposedActions,
  };
};
