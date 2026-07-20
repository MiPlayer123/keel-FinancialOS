'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
import {
  ArrowUp,
  CircleStop,
  Check,
  Loader2,
  MessageSquareText,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react';

import { PageHeader } from '@/components/keel/page-header';
import { useHousehold } from '@/components/keel/household-context';
import {
  archiveNote,
  askKeel,
  categorizeTransaction,
  createCategory,
  getAiProfile,
  keelCommand,
  newId,
  renameCategory,
  saveAiProfile,
  saveNote,
  saveTask,
  setTaskStatus,
  unarchiveNote,
  type AgentAppliedAction,
  type AgentProposedAction,
  type AiChatRecord,
} from '@/lib/keel-api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { toast } from 'sonner';

/**
 * KEEL Assistant — a tool-use finance agent on @assistant-ui/react.
 *
 * The agent reaches data ONLY through KEEL's authorized read tools (Law 7);
 * every number comes from the deterministic ledger (Law 1), never the model's
 * arithmetic. Law 11: the backend returns a typed record (tldr / body / as-of /
 * scope / tools used), rendered TLDR-first with provenance on every answer. The
 * provenance discloses which read TOOLS ran — never raw data.
 *
 * This slice is read-only (writes — notes auto+undo, budgets/reimbursements as
 * approval cards — land in later slices). The thread is client-side state
 * (LocalRuntime keeps history); each run sends only the latest question.
 * Errors surface as typed states (ai_unavailable → "not configured" notice),
 * never as fabricated answers.
 */

/** Friendly labels for the read tools the agent can call (provenance display). */
const TOOL_LABELS: Record<string, string> = {
  list_entities: 'Entities',
  get_account_balances: 'Account balances',
  list_transactions: 'Transactions',
  search_transactions: 'Transaction search',
  list_categories: 'Categories',
  get_budget_month: 'Budget plan',
  list_budgets: 'Budgets',
  list_reimbursements: 'Reimbursements',
  list_notes_and_tasks: 'Notes & tasks',
  list_recurring: 'Recurring',
  list_paychecks: 'Paychecks',
  list_statements: 'Statements',
  list_transfers: 'Transfers',
  list_holdings: 'Holdings',
  get_investments_overview: 'Investments',
  get_net_worth: 'Net worth',
  get_cash_flow: 'Cash flow',
  get_cash_flow_forecast: 'Cash-flow forecast',
  list_goals: 'Goals',
  list_rules: 'Rules',
  list_tags: 'Tags',
};

const prettifyTool = (name: string): string =>
  TOOL_LABELS[name] ?? name.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

const SUGGESTED_QUESTIONS = [
  'What are my account balances?',
  'What did I spend the most on recently?',
  'Am I over budget in any category this month?',
];

const QUESTION_MAX = 2000;

/** Key under which the typed AI record rides on assistant-message metadata. */
const RECORD_KEY = 'keelRecord';
const PROPOSAL_KEY = 'keelProposal';

type AssistantProposal = { kind: 'task'; title: string; source: 'local-intent@v1' };

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

// Tasks are still drafted client-side (the agent has no task-write tool yet).
// NOTES are NOT intercepted here — they flow to the agent, which creates them
// as Class A auto+undo writes. Task-write tools are a future slice.
function parseAssistantProposal(question: string): AssistantProposal | null {
  const text = question.trim().replace(/\s+/g, ' ');
  if (text.length === 0) return null;

  const taskPrefixes = [
    'task:',
    'todo:',
    'to do:',
    'remind me to ',
    'create a task to ',
    'add a task to ',
    'add task:',
  ];
  const lower = text.toLowerCase();

  for (const prefix of taskPrefixes) {
    if (lower.startsWith(prefix)) {
      const title = text.slice(prefix.length).trim();
      return title.length > 0 ? { kind: 'task', title, source: 'local-intent@v1' } : null;
    }
  }

  return null;
}

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
        actions={null}
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
        const proposal = parseAssistantProposal(question);
        if (proposal !== null) {
          return {
            content: [{ type: 'text', text: 'I drafted a task. Review it before I save anything.' }],
            metadata: { custom: { [PROPOSAL_KEY]: proposal } },
          };
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
        const text = record.body !== record.tldr ? `${record.tldr}\n\n${record.body}` : record.tldr;
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
      <div className="mx-auto flex h-[calc(100dvh-9.5rem)] min-h-[520px] w-full max-w-3xl flex-col px-4 py-5 sm:px-6 lg:h-[calc(100dvh-6rem)]">
        <ChatThread />
      </div>
    </AssistantRuntimeProvider>
  );
}

function ChatThread() {
  return (
    <ThreadPrimitive.Root className="flex min-h-0 flex-1 flex-col gap-4">
      <ThreadPrimitive.Viewport autoScroll className="min-h-0 flex-1 overflow-y-auto pb-2">
        <div className="flex min-h-full flex-col justify-end gap-5">
          <AuiIf condition={(s) => s.thread.isEmpty}>
            <EmptyThread />
          </AuiIf>
          <ThreadPrimitive.Messages>
            {({ message }) => (message.role === 'user' ? <UserMessage /> : <AssistantMessage />)}
          </ThreadPrimitive.Messages>
        </div>
      </ThreadPrimitive.Viewport>
      <Composer />
    </ThreadPrimitive.Root>
  );
}

function EmptyThread() {
  return (
    <div className="flex flex-1 flex-col justify-end gap-5 pb-4">
      <Card size="sm" className="bg-secondary/30">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <ShieldCheck className="size-4 text-muted-foreground" />
            Your finance copilot
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm text-muted-foreground">
          <p>
            Every figure comes from KEEL&apos;s ledger, not the model. The assistant can read
            across your finances and manage notes for you — anything it changes is undoable.
            Moving money and editing the ledger still require your explicit approval.
          </p>
          <div className="flex flex-wrap gap-2">
            {SUGGESTED_QUESTIONS.map((suggestion) => (
              <ThreadPrimitive.Suggestion key={suggestion} prompt={suggestion} send asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-auto whitespace-normal py-1.5 text-left"
                >
                  {suggestion}
                </Button>
              </ThreadPrimitive.Suggestion>
            ))}
          </div>
        </CardContent>
      </Card>
      <ProfileEditor />
    </div>
  );
}

/** User-authored personal context the agent receives (slice 5). */
function ProfileEditor() {
  const { householdId } = useHousehold();
  const [text, setText] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (householdId === null) return;
    void getAiProfile({ householdId })
      .then((r) => {
        if (!cancelled) {
          setText(r.profileText);
          setLoaded(true);
        }
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [householdId]);

  async function save() {
    if (householdId === null || saving) return;
    setSaving(true);
    try {
      await saveAiProfile({ householdId, profileText: text });
      toast.success('Assistant context saved.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <details className="rounded-xl border bg-card px-4 py-3">
      <summary className="flex cursor-pointer items-center gap-2 text-sm font-medium">
        <Sparkles className="size-4 text-muted-foreground" />
        Personalize your assistant
      </summary>
      <div className="mt-3 flex flex-col gap-2">
        <p className="text-xs text-muted-foreground">
          Tell KEEL about your goals, how you think about money, and the tone you prefer. It stays
          private to this household and is used only to guide the assistant.
        </p>
        <textarea
          value={text}
          disabled={!loaded}
          onChange={(e) => {
            setText(e.target.value.slice(0, 4000));
          }}
          rows={4}
          placeholder="e.g. I'm saving aggressively for a house down payment; flag any subscription over $20; keep answers brief."
          className="w-full resize-y rounded-lg border bg-transparent px-3 py-2 text-sm outline-none focus:border-ring focus:ring-3 focus:ring-ring/50 disabled:opacity-50"
        />
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-muted-foreground">{text.length}/4000</span>
          <Button type="button" size="sm" disabled={!loaded || saving} onClick={() => void save()}>
            {saving ? <Loader2 data-icon="inline-start" className="animate-spin" /> : null}
            Save context
          </Button>
        </div>
      </div>
    </details>
  );
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="flex justify-end">
      <UserBubble>
        <MessagePrimitive.Parts />
      </UserBubble>
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  const record = useAuiState(
    (s) => s.message.metadata.custom[RECORD_KEY] as AiChatRecord | undefined,
  );
  const proposal = useAuiState(
    (s) => s.message.metadata.custom[PROPOSAL_KEY] as AssistantProposal | undefined,
  );
  const status = useAuiState((s) => s.message.status);
  return (
    <MessagePrimitive.Root className="flex justify-start">
      <div className="w-full max-w-2xl py-1 text-card-foreground">
        {record !== undefined ? (
          <KeelAnswer record={record} />
        ) : proposal !== undefined ? (
          <ProposalReviewCard proposal={proposal} />
        ) : (
          <PendingOrFailed status={status} />
        )}
      </div>
    </MessagePrimitive.Root>
  );
}

function ProposalReviewCard({ proposal }: { proposal: AssistantProposal }) {
  const { householdId } = useHousehold();
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'cancelled'>('idle');

  async function confirm() {
    if (householdId === null || state !== 'idle') return;
    setState('saving');
    try {
      await saveTask({ householdId, title: proposal.title });
      setState('saved');
      toast.success('Task saved.');
    } catch (err) {
      setState('idle');
      toast.error(err instanceof Error ? err.message : 'Could not save the task.');
    }
  }

  return (
    <Card size="sm" className="max-w-xl">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <Sparkles className="size-4 text-muted-foreground" />
          Review assistant proposal
        </CardTitle>
        <CardDescription>
          Nothing changes until you confirm. This uses KEEL&apos;s normal notes/tasks API.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="rounded-lg border bg-secondary/20 px-3 py-2">
          <div className="mb-1 flex items-center gap-2">
            <Badge variant="secondary">Task</Badge>
            <Badge variant="outline" className="font-normal">
              Draft
            </Badge>
          </div>
          <p className="text-sm text-foreground">{proposal.title}</p>
        </div>
        {state === 'saved' ? (
          <p className="text-sm text-muted-foreground">Saved. You can manage it from Home.</p>
        ) : state === 'cancelled' ? (
          <p className="text-sm text-muted-foreground">Cancelled. No note or task was created.</p>
        ) : null}
      </CardContent>
      <CardFooter className="justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={state !== 'idle'}
          onClick={() => {
            setState('cancelled');
          }}
        >
          <X data-icon="inline-start" />
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={householdId === null || state !== 'idle'}
          onClick={() => {
            void confirm();
          }}
        >
          {state === 'saving' ? (
            <Loader2 data-icon="inline-start" className="animate-spin" />
          ) : (
            <Check data-icon="inline-start" />
          )}
          Confirm
        </Button>
      </CardFooter>
    </Card>
  );
}

function UserBubble({ children }: { children: ReactNode }) {
  return (
    <div className="max-w-[88%] whitespace-pre-wrap rounded-2xl rounded-tr-md bg-secondary px-4 py-2.5 text-sm leading-relaxed text-secondary-foreground shadow-sm sm:max-w-[72%]">
      {children}
    </div>
  );
}

/** Non-answer states: running, typed error notice, or a user-initiated stop. */
function PendingOrFailed({ status }: { status: MessageStatus | undefined }) {
  if (status?.type === 'incomplete') {
    if (status.reason === 'cancelled') {
      return <p className="text-sm text-muted-foreground">Stopped — no answer was produced.</p>;
    }
    return (
      <div className="flex flex-col gap-1">
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
  const body = dedupedBody(record);
  return (
    <article className="flex flex-col gap-3 text-sm leading-relaxed">
      <div className="flex flex-col gap-2">
        <p className="text-base font-medium leading-snug text-foreground">{record.tldr}</p>
        {body !== '' ? (
          <p className="whitespace-pre-wrap text-sm text-muted-foreground">{body}</p>
        ) : null}
      </div>

      {record.appliedActions.length > 0 ? (
        <AppliedActionsList actions={record.appliedActions} />
      ) : null}

      {record.proposedActions.length > 0 ? (
        <ProposedActionsList actions={record.proposedActions} />
      ) : null}

      <Separator />

      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="outline" className="font-normal">
            As of {formatAsOf(record.asOf)}
          </Badge>
          <Badge variant="secondary" className="font-normal">
            Household scope
            {record.scope.entityIds.length > 0
              ? ` · ${String(record.scope.entityIds.length)} ${
                  record.scope.entityIds.length === 1 ? 'entity' : 'entities'
                }`
              : ''}
          </Badge>
        </div>

        <details className="group/provenance rounded-lg border bg-secondary/20 px-3 py-2">
          <summary className="flex cursor-pointer items-center gap-2 text-xs font-medium text-muted-foreground">
            <MessageSquareText className="size-3.5" />
            {record.toolsUsed.length > 0
              ? `What the agent checked (${String(record.toolsUsed.length)})`
              : 'What the agent checked'}
          </summary>
          <div className="mt-2 flex flex-col gap-2">
            {record.toolsUsed.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {[...new Set(record.toolsUsed)].map((tool) => (
                  <Badge key={tool} variant="outline" className="font-normal">
                    {prettifyTool(tool)}
                  </Badge>
                ))}
              </div>
            ) : (
              <p className="text-[11px] text-muted-foreground">
                Answered directly — no data lookups were needed.
              </p>
            )}
            <p className="text-[11px] text-muted-foreground">
              Every figure comes from KEEL&apos;s ledger, not the model — model {record.modelVersion},
              prompt {record.promptVersion}.
              {record.displayOnly ? ' Read-only; no actions were taken.' : ''}
            </p>
          </div>
        </details>
      </div>
    </article>
  );
}

/** Class-B changes the agent proposes — nothing happens until the user approves (Law 2/10). */
function ProposedActionsList({ actions }: { actions: AgentProposedAction[] }) {
  return (
    <div className="flex flex-col gap-2">
      {actions.map((action, i) => (
        <ProposedActionCard key={`${action.command}-${String(i)}`} action={action} />
      ))}
    </div>
  );
}

function ProposedActionCard({ action }: { action: AgentProposedAction }) {
  const { householdId, userId } = useHousehold();
  const [state, setState] = useState<'idle' | 'approving' | 'approved' | 'rejected'>('idle');
  // Stable per proposal: a double-submit that races the state guard replays
  // idempotently server-side (keel_idempotency_check) instead of applying twice.
  const commandId = useMemo(() => newId(), []);
  const eventKey = useMemo(() => `${action.command}:${newId()}`, [action.command]);

  async function approve() {
    if (householdId === null || userId === null || state !== 'idle') return;
    setState('approving');
    try {
      const p = action.payload;
      // Most commands ride the /commands envelope; a few are bespoke routes with
      // their own typed client fns. Route by command name.
      if (action.command === 'transactions.categorize') {
        await categorizeTransaction({
          householdId,
          transactionId: String(p['transactionId']),
          categoryLedgerAccountId: String(p['categoryLedgerAccountId']),
        });
      } else if (action.command === 'categories.create') {
        await createCategory({
          householdId,
          name: String(p['name']),
          kind: p['kind'] === 'income' ? 'income' : 'expense',
        });
      } else if (action.command === 'categories.rename') {
        await renameCategory({
          householdId,
          categoryLedgerAccountId: String(p['categoryLedgerAccountId']),
          name: String(p['name']),
        });
      } else {
        await keelCommand({
          commandId,
          command: action.command,
          economicEventKey: eventKey,
          actor: { kind: 'user', userId },
          householdId,
          payload: action.payload,
        });
      }
      setState('approved');
      toast.success('Approved and applied.');
    } catch (err) {
      setState('idle');
      toast.error(err instanceof Error ? err.message : 'Could not apply the change.');
    }
  }

  return (
    <Card size="sm" className="max-w-xl">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <Sparkles className="size-4 text-muted-foreground" />
          Proposed change
        </CardTitle>
        <CardDescription>Nothing changes until you approve. This runs KEEL&apos;s normal command.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="rounded-lg border bg-secondary/20 px-3 py-2">
          <div className="mb-1 flex items-center gap-2">
            <Badge variant="secondary">{action.command}</Badge>
            <Badge variant="outline" className="font-normal">
              Needs approval
            </Badge>
          </div>
          <p className="text-sm text-foreground">{action.summary}</p>
          {/* The EXACT payload that will be committed on approve (Law 11) — so
              the user verifies the bound values, not just the summary. */}
          <details className="mt-2">
            <summary className="cursor-pointer text-[11px] text-muted-foreground">
              Exactly what will change
            </summary>
            <div className="mt-1 flex flex-col gap-0.5 rounded border bg-background/50 px-2 py-1 text-[11px] text-muted-foreground">
              {Object.entries(action.payload).map(([k, v]) => (
                <div key={k} className="flex gap-2">
                  <span className="shrink-0 font-medium">{k}:</span>
                  <span className="truncate break-all">{String(v)}</span>
                </div>
              ))}
            </div>
          </details>
        </div>
        {state === 'approved' ? (
          <p className="mt-2 text-sm text-muted-foreground">Applied. You can review it on the Budgets page.</p>
        ) : state === 'rejected' ? (
          <p className="mt-2 text-sm text-muted-foreground">Dismissed. Nothing changed.</p>
        ) : null}
      </CardContent>
      {state === 'idle' || state === 'approving' ? (
        <CardFooter className="justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={state !== 'idle'}
            onClick={() => {
              setState('rejected');
            }}
          >
            <X data-icon="inline-start" />
            Reject
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={householdId === null || userId === null || state !== 'idle'}
            onClick={() => {
              void approve();
            }}
          >
            {state === 'approving' ? (
              <Loader2 data-icon="inline-start" className="animate-spin" />
            ) : (
              <Check data-icon="inline-start" />
            )}
            Approve
          </Button>
        </CardFooter>
      ) : null}
    </Card>
  );
}

/** Class-A auto writes the agent applied this turn, each with a one-tap undo (Law 2). */
function AppliedActionsList({ actions }: { actions: AgentAppliedAction[] }) {
  return (
    <div className="flex flex-col gap-1.5">
      {actions.map((action, i) => (
        <AppliedActionRow key={`${action.ref}-${String(i)}`} action={action} />
      ))}
    </div>
  );
}

function AppliedActionRow({ action }: { action: AgentAppliedAction }) {
  const { householdId } = useHousehold();
  const [state, setState] = useState<'idle' | 'undoing' | 'undone'>('idle');
  const canUndo = action.undo !== undefined && householdId !== null;

  async function undo() {
    const u = action.undo;
    if (householdId === null || u === undefined || state !== 'idle') return;
    setState('undoing');
    try {
      if (u.op === 'archive_note' && u.noteId) {
        await archiveNote({ householdId, noteId: u.noteId });
      } else if (u.op === 'unarchive_note' && u.noteId) {
        await unarchiveNote({ householdId, noteId: u.noteId });
      } else if (u.op === 'edit_note' && u.noteId) {
        await saveNote({ householdId, noteId: u.noteId, body: u.body ?? '', pinned: u.pinned ?? false });
      } else if (u.op === 'set_task_status' && u.taskId && u.status) {
        await setTaskStatus({ householdId, taskId: u.taskId, status: u.status });
      } else if (u.op === 'edit_task' && u.taskId) {
        await saveTask({
          householdId,
          taskId: u.taskId,
          title: u.title ?? '',
          description: u.description ?? null,
          dueOn: u.dueOn ?? null,
          ...(u.priority ? { priority: u.priority } : {}),
        });
      }
      setState('undone');
      toast.success('Undone.');
    } catch (err) {
      setState('idle');
      toast.error(err instanceof Error ? err.message : 'Could not undo.');
    }
  }

  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border bg-secondary/20 px-3 py-2">
      <div className="flex min-w-0 items-center gap-2 text-sm">
        <Check className="size-4 shrink-0 text-muted-foreground" />
        <span
          className={
            state === 'undone'
              ? 'truncate text-muted-foreground line-through'
              : 'truncate text-foreground'
          }
        >
          {action.summary}
        </span>
      </div>
      {canUndo ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="shrink-0"
          disabled={state !== 'idle'}
          onClick={() => {
            void undo();
          }}
        >
          {state === 'undoing' ? <Loader2 data-icon="inline-start" className="animate-spin" /> : null}
          {state === 'undone' ? 'Undone' : 'Undo'}
        </Button>
      ) : null}
    </div>
  );
}

function Composer() {
  return (
    <div className="flex flex-col gap-2">
      <ComposerPrimitive.Root className="rounded-2xl border bg-card p-2 shadow-sm transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50">
        <ComposerPrimitive.Input
          minRows={1}
          maxRows={5}
          maxLength={QUESTION_MAX}
          placeholder="Ask KEEL about your finances…"
          aria-label="Question for KEEL Assistant"
          className="max-h-36 min-h-12 w-full resize-none bg-transparent px-2 py-2 text-base outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 md:text-sm"
        />
        <div className="flex items-center justify-between gap-2 px-1 pb-1">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Sparkles className="size-3.5" />
            Note edits are undoable; financial changes need your approval
          </div>
          <AuiIf condition={(s) => !s.thread.isRunning}>
            <ComposerPrimitive.Send asChild>
              <Button type="submit" size="sm" className="shrink-0">
                <ArrowUp data-icon="inline-start" />
                Ask
              </Button>
            </ComposerPrimitive.Send>
          </AuiIf>
          <AuiIf condition={(s) => s.thread.isRunning}>
            <ComposerPrimitive.Cancel asChild>
              <Button type="button" variant="outline" size="sm" className="shrink-0">
                <CircleStop data-icon="inline-start" />
                Stop
              </Button>
            </ComposerPrimitive.Cancel>
          </AuiIf>
        </div>
      </ComposerPrimitive.Root>
      <p className="px-2 text-[11px] text-muted-foreground">
        Answers narrate KEEL&apos;s ledger. Actions will appear as reviewable proposals before
        anything changes.
      </p>
    </div>
  );
}
