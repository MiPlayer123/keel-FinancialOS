'use client';

import { useState } from 'react';
import { Loader2, ShieldCheck, Sparkles } from 'lucide-react';

import { PageHeader } from '@/components/keel/page-header';
import { useHousehold } from '@/components/keel/household-context';
import { askKeel, type AiChatRecord } from '@/lib/keel-api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

/**
 * KEEL Assistant (Preview) — read-only AI chat POC.
 *
 * Law 10: class C, preview-only. Answers are display-only narration of
 * KEEL's deterministic numbers; nothing here can write, propose, or approve.
 * Law 11: the backend returns a typed record (tldr / body / as-of / scope /
 * evidence refs), rendered TLDR-first with provenance one tap away.
 * The evidence disclosure lists section LABELS only — never raw data.
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

function formatAsOf(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime())
    ? iso
    : parsed.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export default function AssistantPage() {
  return (
    <>
      <PageHeader
        title="Assistant"
        description="Ask about your accounts, spending, and budgets — read-only narration of KEEL's numbers."
        actions={<Badge variant="secondary">Preview</Badge>}
      />
      <div className="mx-auto w-full max-w-2xl p-4 sm:p-6">
        <AssistantBody />
      </div>
    </>
  );
}

function AssistantBody() {
  const { householdId } = useHousehold();
  const [question, setQuestion] = useState('');
  const [askedQuestion, setAskedQuestion] = useState<string | null>(null);
  const [record, setRecord] = useState<AiChatRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function ask(text: string) {
    if (!householdId || loading) return;
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    setLoading(true);
    setError(null);
    setRecord(null);
    setAskedQuestion(trimmed);
    try {
      setRecord(await askKeel({ householdId, question: trimmed }));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'The assistant is unavailable.';
      setError(
        message.includes('ai_unavailable')
          ? 'The assistant is not configured on this KEEL server yet — everything else keeps working without it.'
          : message,
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="flex items-start gap-2 rounded-lg border border-border bg-secondary/40 px-3 py-2 text-xs text-muted-foreground">
        <ShieldCheck className="mt-0.5 size-3.5 shrink-0" />
        <span>
          Preview, read-only. Every figure is computed by KEEL&apos;s ledger — the assistant only
          narrates it, and it can never move money or change your books.
        </span>
      </p>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void ask(question);
        }}
        className="flex flex-col gap-2 sm:flex-row"
      >
        <Input
          value={question}
          onChange={(e) => {
            setQuestion(e.target.value);
          }}
          maxLength={QUESTION_MAX}
          placeholder="Ask about your finances…"
          aria-label="Question for KEEL Assistant"
          disabled={loading}
        />
        <Button type="submit" disabled={loading || question.trim().length === 0}>
          {loading ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
          Ask
        </Button>
      </form>

      {record === null && error === null && !loading ? (
        <div className="flex flex-wrap gap-2">
          {SUGGESTED_QUESTIONS.map((suggestion) => (
            <Button
              key={suggestion}
              variant="outline"
              size="sm"
              className="h-auto whitespace-normal py-1.5 text-left text-xs"
              onClick={() => {
                setQuestion(suggestion);
                void ask(suggestion);
              }}
            >
              {suggestion}
            </Button>
          ))}
        </div>
      ) : null}

      {loading ? (
        <Card>
          <CardContent className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Reading your KEEL numbers…
          </CardContent>
        </Card>
      ) : null}

      {error !== null ? (
        <Card>
          <CardContent className="space-y-1 py-4">
            <p className="text-sm font-medium">The assistant couldn&apos;t answer</p>
            <p className="text-sm text-muted-foreground">{error}</p>
          </CardContent>
        </Card>
      ) : null}

      {record !== null ? (
        <Card>
          <CardContent className="space-y-3 py-4">
            {askedQuestion !== null ? (
              <p className="text-xs text-muted-foreground">You asked: {askedQuestion}</p>
            ) : null}

            <p className="text-base font-medium leading-snug">{record.tldr}</p>
            {record.body !== record.tldr ? (
              <p className="whitespace-pre-wrap text-sm text-muted-foreground">{record.body}</p>
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
                Precomputed summaries only — model {record.modelVersion}, prompt{' '}
                {record.promptVersion}. Display-only; no actions were proposed or taken.
              </p>
            </details>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
