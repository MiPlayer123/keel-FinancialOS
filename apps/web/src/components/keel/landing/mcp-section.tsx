import {
  BookOpen,
  Calculator,
  History,
  KeyRound,
  PencilLine,
  ShieldOff,
  SlidersHorizontal,
} from 'lucide-react';
import { Reveal } from '@/components/keel/landing/reveal';
import { getSiteUrl } from '@/lib/site';

/** Public connector URL, same value Settings → Connected apps shows. */
export function mcpConnectorUrl(): string {
  return new URL('/mcp', getSiteUrl()).toString();
}

const CAPABILITIES = [
  {
    icon: BookOpen,
    title: 'Read',
    body: 'Ask about net worth, spending, budgets, bills due, investments, and paychecks. Totals come from the ledger, so the agent quotes numbers instead of adding them up.',
    tools: ['overview_get', 'transactions_summarize', 'transactions_list', 'budgets_get', 'recurring_list'],
  },
  {
    icon: SlidersHorizontal,
    title: 'Manage',
    body: 'Clear the review queue, categorize and split transactions, save rules, link transfers, and attach receipts that are already uploaded to KEEL.',
    tools: ['transactions_categorize', 'transactions_split', 'rules_save', 'review_decide', 'receipts_attach'],
  },
  {
    icon: PencilLine,
    title: 'Write',
    body: 'Record cash or manual transactions, enter bills, set budgets, and save notes and tasks. Every write is logged as made by that app and can be reversed.',
    tools: ['transactions_create', 'bills_enter', 'budgets_set', 'notes_save', 'transactions_void'],
  },
];

const GUARDRAILS = [
  {
    icon: KeyRound,
    title: 'You choose the access',
    body: 'Sign in with OAuth, pick a household, and grant read-only or read-and-change. Revoke it in Settings at any time.',
  },
  {
    icon: ShieldOff,
    title: 'No money movement',
    body: 'Agents cannot move money, pay bills, connect or disconnect banks, or export your data.',
  },
  {
    icon: History,
    title: 'Logged and undoable',
    body: 'Changes go through the same audited path as the app. Bank history is kept; manual entries are voided, never hard-deleted.',
  },
  {
    icon: Calculator,
    title: 'The ledger does the math',
    body: 'Balances and totals are computed by a deterministic double-entry ledger, never by a language model.',
  },
];

const EXAMPLE_PROMPTS = [
  'How much did I spend on dining in October, and am I over budget?',
  'Categorize last week’s uncategorized transactions and list what you changed.',
  'Split the $184.20 warehouse-club charge: $120 groceries, the rest office supplies.',
  'Log a $12 cash parking receipt under my business.',
];

/**
 * Visible FAQ + FAQPage JSON-LD share this list, so the structured data
 * always matches the page text. Answers are self-contained on purpose:
 * search and AI engines quote them without the surrounding page.
 */
export const MCP_FAQ = [
  {
    q: 'What is the KEEL MCP server?',
    a: 'KEEL includes a remote Model Context Protocol (MCP) server. It lets AI assistants such as Claude, Claude Code, ChatGPT, and Codex read your KEEL finances and, if you allow it, make changes like categorizing, splitting, and recording transactions through the same audited path as the KEEL app.',
  },
  {
    q: 'Which AI apps can connect to KEEL?',
    a: 'Any MCP client that supports remote servers with OAuth sign-in. That includes Claude on web, desktop, and mobile through custom connectors, Claude Code, Codex, and ChatGPT. You add one connector URL, sign in with your KEEL account, and choose a household and access level.',
  },
  {
    q: 'Can an AI agent move my money through KEEL?',
    a: 'No. The KEEL MCP server cannot move money, pay bills, place trades, connect or disconnect bank accounts, or export your data. Its tools only read and edit records in your KEEL ledger, and only within the household and access level you granted.',
  },
  {
    q: 'Can the agent write or change transactions?',
    a: 'Only if you grant read-and-change access. The agent can then create manual transactions, categorize, split, tag, link transfers, and void manual entries. Each change is logged as made by that app and can be reversed. Bank-synced history is preserved rather than deleted.',
  },
  {
    q: 'Does the AI calculate my balances?',
    a: 'No. KEEL computes balances, budgets, and summaries in a deterministic double-entry ledger that stores money as integer cents. The agent calls summary tools and reports those results, so the numbers match what you see in the app.',
  },
  {
    q: 'Is the KEEL MCP server free?',
    a: 'Yes. KEEL is free and open source under AGPL-3.0, and connecting an AI app costs nothing on the KEEL side. Your AI app’s own plan and usage limits still apply.',
  },
];

export const MCP_FAQ_JSON_LD = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: MCP_FAQ.map(({ q, a }) => ({
    '@type': 'Question',
    name: q,
    acceptedAnswer: { '@type': 'Answer', text: a },
  })),
};

export function McpSection() {
  const url = mcpConnectorUrl();
  return (
    <section
      id="mcp"
      aria-labelledby="mcp-heading"
      className="scroll-mt-24 border-t border-border"
    >
      <div className="mx-auto w-full max-w-6xl px-6 py-20 sm:py-28">
        <div className="grid gap-10 lg:grid-cols-[1.1fr_1fr] lg:gap-16">
          <Reveal className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-widest text-primary">
              MCP server · agentic finance
            </p>
            <h2
              id="mcp-heading"
              className="mt-3 text-balance text-2xl font-semibold tracking-tight sm:text-4xl"
            >
              Connect Claude, ChatGPT, or Codex to your finances.
            </h2>
            <p className="mt-4 max-w-xl text-pretty leading-relaxed text-muted-foreground">
              KEEL ships a remote MCP server, so the AI agent you already use can read your
              accounts, transactions, budgets, and bills. With your permission, it can also
              categorize, split, and record transactions. Every change goes through the same
              audited, undoable path as the app, and the ledger still does every calculation.
            </p>
          </Reveal>

          <Reveal delayMs={100} className="min-w-0">
            <div className="rounded-lg border border-border bg-card p-5 sm:p-6">
              <p className="text-xs font-medium text-muted-foreground">Connector URL</p>
              <code className="mt-1.5 block truncate rounded-md border border-border bg-secondary/40 px-3 py-2 font-mono text-xs">
                {url}
              </code>
              <p className="mt-4 text-xs font-medium text-muted-foreground">Claude Code</p>
              <code className="mt-1.5 block overflow-x-auto whitespace-nowrap rounded-md border border-border bg-secondary/40 px-3 py-2 font-mono text-xs">
                claude mcp add --transport http keel {url}
              </code>
              <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                Claude: Settings → Connectors → Add custom connector. Codex:{' '}
                <code className="break-all font-mono">codex mcp add keel --url {url}</code>. Then sign
                in with your KEEL account and choose an access level.
              </p>
              <p className="mt-5 text-xs font-medium text-muted-foreground">Try asking</p>
              <ul className="mt-2 space-y-2">
                {EXAMPLE_PROMPTS.map((prompt) => (
                  <li
                    key={prompt}
                    className="rounded-md bg-secondary/40 px-3 py-2 text-sm leading-snug"
                  >
                    “{prompt}”
                  </li>
                ))}
              </ul>
            </div>
          </Reveal>
        </div>

        <div className="mt-12 grid gap-4 md:grid-cols-3">
          {CAPABILITIES.map((cap, i) => (
            <Reveal key={cap.title} delayMs={i * 80}>
              <div className="h-full rounded-lg border border-border bg-card p-6">
                <cap.icon className="size-5 text-primary" aria-hidden />
                <h3 className="mt-4 text-base font-semibold tracking-tight">{cap.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{cap.body}</p>
                <div className="mt-4 flex flex-wrap gap-1.5">
                  {cap.tools.map((tool) => (
                    <span
                      key={tool}
                      className="rounded-full border border-border bg-secondary px-2.5 py-1 font-mono text-[11px] text-secondary-foreground"
                    >
                      {tool}
                    </span>
                  ))}
                </div>
              </div>
            </Reveal>
          ))}
        </div>

        <ul className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {GUARDRAILS.map((g) => (
            <li key={g.title} className="flex gap-3">
              <g.icon className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
              <div>
                <h3 className="text-sm font-semibold">{g.title}</h3>
                <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{g.body}</p>
              </div>
            </li>
          ))}
        </ul>

        <div className="mt-16">
          <h3 className="text-lg font-semibold tracking-tight">MCP questions</h3>
          <div className="mt-4 divide-y divide-border rounded-lg border border-border bg-card">
            {MCP_FAQ.map(({ q, a }) => (
              <details key={q} className="group px-5 py-4">
                <summary className="cursor-pointer list-none text-sm font-medium marker:hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                  <span className="flex items-center justify-between gap-4">
                    {q}
                    <span
                      aria-hidden
                      className="text-muted-foreground transition-transform group-open:rotate-45"
                    >
                      +
                    </span>
                  </span>
                </summary>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{a}</p>
              </details>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
