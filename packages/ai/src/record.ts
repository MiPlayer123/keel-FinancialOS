/**
 * Response-record mapper: model text → typed, display-only chat record
 * (CLAUDE.md Law 11 — material AI outputs are records, never bare strings).
 *
 * The model owns ONLY the prose. Everything else — as-of, scope, evidence
 * refs, versions — is stamped from the snapshot the server compiled, so the
 * model cannot fabricate provenance (Law 9 by construction).
 */
import type { FinancialContextSnapshot, SnapshotScope, SnapshotSectionId } from './snapshot.js';
import { evidenceRefsFor, PROMPT_VERSION } from './prompt.js';

/** Class C, display-only (Law 10): no proposed actions, no approvals, no writes. */
export interface ChatResponseRecord {
  readonly tldr: string;
  readonly body: string;
  readonly asOf: string;
  readonly scope: SnapshotScope;
  readonly riskClass: 'C';
  readonly displayOnly: true;
  readonly modelVersion: string;
  readonly promptVersion: string;
  /** Snapshot section ids that were rendered into the model's context. */
  readonly evidenceRefs: readonly SnapshotSectionId[];
}

export const TLDR_MAX_LENGTH = 280;

/** Thrown when the model returned nothing usable — callers fail closed. */
export class EmptyAiResponseError extends Error {
  constructor() {
    super('AI provider returned an empty response.');
    this.name = 'EmptyAiResponseError';
  }
}

/** First sentence-ish prefix of `text`, capped at `max` chars on a word boundary. */
const deriveTldr = (text: string, max: number): string => {
  const firstParagraph = text.split(/\n\s*\n/, 1)[0] ?? text;
  const collapsed = firstParagraph.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= max) return collapsed;
  const cut = collapsed.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${cut.slice(0, lastSpace > max / 2 ? lastSpace : max - 1).trimEnd()}…`;
};

export interface BuildRecordInput {
  /** Raw completion text from the provider. */
  readonly text: string;
  /** The exact snapshot that was rendered into the prompt. */
  readonly snapshot: FinancialContextSnapshot;
  /** Provider-reported model id. */
  readonly modelVersion: string;
}

/** Map a completion onto the typed record. Throws on empty text (fail closed). */
export const buildChatResponseRecord = (input: BuildRecordInput): ChatResponseRecord => {
  const body = input.text.trim();
  if (body.length === 0) throw new EmptyAiResponseError();
  if (input.modelVersion.trim().length === 0) {
    throw new Error('modelVersion is required on every chat record (Law 9).');
  }
  return {
    tldr: deriveTldr(body, TLDR_MAX_LENGTH),
    body,
    asOf: input.snapshot.asOf,
    scope: input.snapshot.scope,
    riskClass: 'C',
    displayOnly: true,
    modelVersion: input.modelVersion,
    promptVersion: PROMPT_VERSION,
    evidenceRefs: evidenceRefsFor(input.snapshot),
  };
};
