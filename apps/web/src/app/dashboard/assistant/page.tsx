'use client';

import { useEffect, useMemo, useRef } from 'react';
import {
  AssistantRuntimeProvider,
  AuiIf,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
  useLocalRuntime,
  type ChatModelAdapter,
  type ChatModelRunResult,
  type MessageStatus,
  type ThreadMessage,
} from '@assistant-ui/react';
import { CircleStop, Loader2, ShieldCheck, Sparkles } from 'lucide-react';

import { PageHeader } from '@/components/keel/page-header';
import { useHousehold } from '@/components/keel/household-context';
import { askKeel, type AiChatRecord } from '@/lib/keel-api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

/**
 * KEEL Assistant (Preview) — read-only AI chat POC on @assistant-ui/react.
 *
 * Law 10: class C, preview-only. Answers are display-only narration of
 * KEEL's deterministic numbers; nothing here can write, propose, or approve.
 * Law 11: the backend returns a typed record (tldr / body / as-of / scope /
 * evidence refs), rendered TLDR-first with provenance on every answer.
 * The evidence disclosure lists section LABELS only — never raw data.
 *
 * The thread is client-side state only (LocalRuntime keeps history); the
 * backend stays single-shot — each run sends ONLY the latest question.
 * Errors surface as typed states (ai_unavailable → "not configured" notice),
 * never as fabricated answers.
 */

const EVIDENCE_LABELS: Record<string, string> = {
  accounts: 'Accounts & balances',
  transactions: 'Recent transactions (up to 50)',
  categories: 'Category list',
  budgets: 'Budgets (current month)',
};

const SUGGESTED_QUESTIONS = [
  'What are my account balances?',
  'What did I spend the most on recently?',
  'Am I over budget in any category this month?',
];

const QUESTION_MAX = 500;

/** Key under which the typed AI record rides on assistant-message metadata. */
const RECORD_KEY = 'keelRecord';

function formatAsOf(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime())
    ? iso
    : parsed.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** Map backend error codes to the existing typed notices — never a fake answer. */
function friendlyError(err: unknown): string {
  const message = err instanceof Error ? err.message : 'The assistant is unavailable.';
  if (message.includes('ai_unavailable')) {
    return 'The assistant is not configured on this KEEL server yet — everything else keeps working without it.';
  }
  if (message.includes('ai_upstream_failed')) {
    return 'The AI provider could not be reached. Your books are unaffected — try again in a moment.';
  }
  return message;
}

/** Typed failure result: the message ends incomplete/error with a notice, no content. */
function failedRun(text: string): ChatModelRunResult {
  return { status: { type: 'incomplete', reason: 'error', error: text } };
}

/** Backend is single-shot: extract only the latest user question from the thread. */
function latestUserQuestion(messages: readonly ThreadMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m === undefined || m.role !== 'user') continue;
    return m.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n')
      .trim();
  }
  return '';
}

export default function AssistantPage() {
  return (
    <>
      <PageHeader
        title="Assistant"
        description="Ask about your accounts, spending, and budgets — read-only narration of KEEL's numbers."
        actions={<Badge variant="secondary">Preview</Badge>}
      />
      <AssistantChat />
    </>
  );
}

function AssistantChat() {
  const { householdId } = useHousehold();
  // The adapter must stay referentially stable for LocalRuntime; the current
  // household is read through a ref at run time instead.
  const householdRef = useRef(householdId);
  useEffect(() => {
    householdRef.current = householdId;
  }, [householdId]);

  const adapter = useMemo<ChatModelAdapter>(
    () => ({
      async run({ messages, abortSignal }) {
        const question = latestUserQuestion(messages);
        const targetHousehold = householdRef.current;
        if (targetHousehold === null) {
          return failedRun('No household is selected — pick one in the sidebar, then ask again.');
        }
        if (question.length === 0) {
          return failedRun('Type a question to ask the assistant.');
        }
        let record: AiChatRecord;
        try {
          record = await askKeel({ householdId: targetHousehold, question });
        } catch (err) {
          return failedRun(friendlyError(err));
        }
        // askKeel cannot abort mid-flight; honor a cancel that raced the reply
        // so a stopped run stays stopped instead of late-completing.
        if (abortSignal.aborted) {
          throw new DOMException('The request was cancelled.', 'AbortError');
        }
        const text =
          record.body !== record.tldr ? `${record.tldr}\n\n${record.body}` : record.tldr;
        return {
          content: [{ type: 'text', text }],
          metadata: { custom: { [RECORD_KEY]: record } },
        };
      },
    }),
    [],
  );

  const runtime = useLocalRuntime(adapter);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="mx-auto flex h-[calc(100dvh-9.5rem)] min-h-[420px] w-full max-w-2xl flex-col p-4 sm:p-6 lg:h-[calc(100dvh-6rem)]">
        <ChatThread />
      </div>
    </AssistantRuntimeProvider>
  );
}

function ChatThread() {
  return (
    <ThreadPrimitive.Root className="flex min-h-0 flex-1 flex-col">
      <ThreadPrimitive.Viewport autoScroll className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pb-4">
        <AuiIf condition={(s) => s.thread.isEmpty}>
          <EmptyThread />
        </AuiIf>
        <ThreadPrimitive.Messages>
          {({ message }) => (message.role === 'user' ? <UserMessage /> : <AssistantMessage />)}
        </ThreadPrimitive.Messages>
      </ThreadPrimitive.Viewport>
      <Composer />
    </ThreadPrimitive.Root>
  );
}

function EmptyThread() {
  return (
    <div className="flex flex-1 flex-col justify-end gap-4">
      <p className="flex items-start gap-2 rounded-lg border border-border bg-secondary/40 px-3 py-2 text-xs text-muted-foreground">
        <ShieldCheck className="mt-0.5 size-3.5 shrink-0" />
        <span>
          Preview, read-only. Every figure is computed by KEEL&apos;s ledger — the assistant only
          narrates it, and it can never move money or change your books.
        </span>
      </p>
      <div className="flex flex-wrap gap-2">
        {SUGGESTED_QUESTIONS.map((suggestion) => (
          <ThreadPrimitive.Suggestion key={suggestion} prompt={suggestion} send asChild>
            <Button
              variant="outline"
              size="sm"
              className="h-auto whitespace-normal py-1.5 text-left text-xs"
            >
              {suggestion}
            </Button>
          </ThreadPrimitive.Suggestion>
        ))}
      </div>
    </div>
  );
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="flex justify-end">
      <div className="max-w-[85%] whitespace-pre-wrap rounded-lg bg-secondary px-3 py-2 text-sm">
        <MessagePrimitive.Parts />
      </div>
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  const record = useAuiState(
    (s) => s.message.metadata.custom[RECORD_KEY] as AiChatRecord | undefined,
  );
  const status = useAuiState((s) => s.message.status);
  return (
    <MessagePrimitive.Root className="flex justify-start">
      <div className="w-full space-y-3 rounded-lg border border-border bg-card px-4 py-3 text-card-foreground sm:max-w-[92%]">
        {record !== undefined ? <KeelAnswer record={record} /> : <PendingOrFailed status={status} />}
      </div>
    </MessagePrimitive.Root>
  );
}

/** Non-answer states: running, typed error notice, or a user-initiated stop. */
function PendingOrFailed({ status }: { status: MessageStatus | undefined }) {
  if (status?.type === 'incomplete') {
    if (status.reason === 'cancelled') {
      return <p className="text-sm text-muted-foreground">Stopped — no answer was produced.</p>;
    }
    return (
      <div className="space-y-1">
        <p className="text-sm font-medium">The assistant couldn&apos;t answer</p>
        <p className="text-sm text-muted-foreground">
          {typeof status.error === 'string' ? status.error : 'The assistant is unavailable.'}
        </p>
      </div>
    );
  }
  return (
    <p className="flex items-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" />
      Reading your KEEL numbers…
    </p>
  );
}

function dedupedBody(record: { tldr: string; body: string }): string {
  const body = record.body.trim();
  const tldr = record.tldr.trim();
  if (body === tldr) return '';
  if (body.startsWith(tldr)) return body.slice(tldr.length).trimStart();
  return body;
}

/** Law 11 rendering: TLDR first, body, then as-of + scope + evidence labels. */
function KeelAnswer({ record }: { record: AiChatRecord }) {
  return (
    <>
      <p className="text-base font-medium leading-snug">{record.tldr}</p>
      {/* Models often open the body by restating the tldr verbatim — strip
          that leading repeat so the card reads TLDR-then-detail (Law 11),
          never the same sentence twice. */}
      {dedupedBody(record) !== '' ? (
        <p className="whitespace-pre-wrap text-sm text-muted-foreground">{dedupedBody(record)}</p>
      ) : null}

      <p className="text-xs text-muted-foreground">
        As of {formatAsOf(record.asOf)} · scope: this household
        {record.scope.entityIds.length > 0
          ? ` (${String(record.scope.entityIds.length)} ${
              record.scope.entityIds.length === 1 ? 'entity' : 'entities'
            })`
          : ''}
      </p>

      <details className="rounded-md border border-border px-3 py-2">
        <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
          What the model saw
        </summary>
        <ul className="mt-2 list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
          {record.evidenceRefs.map((ref) => (
            <li key={ref}>{EVIDENCE_LABELS[ref] ?? ref}</li>
          ))}
        </ul>
        <p className="mt-2 text-[11px] text-muted-foreground/80">
          Precomputed summaries only — model {record.modelVersion}, prompt {record.promptVersion}.
          Display-only; no actions were proposed or taken.
        </p>
      </details>
    </>
  );
}

function Composer() {
  return (
    <div className="space-y-1.5">
      <ComposerPrimitive.Root className="flex items-end gap-2">
        <ComposerPrimitive.Input
          minRows={1}
          maxRows={5}
          maxLength={QUESTION_MAX}
          placeholder="Ask about your finances…"
          aria-label="Question for KEEL Assistant"
          className="min-h-9 w-full resize-none rounded-lg border border-input bg-transparent px-2.5 py-2 text-base outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm dark:bg-input/30"
        />
        <AuiIf condition={(s) => !s.thread.isRunning}>
          <ComposerPrimitive.Send asChild>
            <Button type="submit" className="h-9 shrink-0">
              <Sparkles className="size-4" />
              Ask
            </Button>
          </ComposerPrimitive.Send>
        </AuiIf>
        <AuiIf condition={(s) => s.thread.isRunning}>
          <ComposerPrimitive.Cancel asChild>
            <Button type="button" variant="outline" className="h-9 shrink-0">
              <CircleStop className="size-4" />
              Stop
            </Button>
          </ComposerPrimitive.Cancel>
        </AuiIf>
      </ComposerPrimitive.Root>
      <p className="text-[11px] text-muted-foreground/80">
        Read-only preview — answers narrate KEEL&apos;s ledger and can never move money or change
        your books.
      </p>
    </div>
  );
}
