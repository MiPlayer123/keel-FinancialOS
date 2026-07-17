# KEEL Full-App Audit Scope — 2026-07-17

This document turns the current audit request into one cohesive implementation scope. The work can still be sequenced internally for safety, but the target is one integrated PR that updates the assistant experience, UI standards, notes/tasks, and performance audit artifacts together.

## Evidence reviewed

- User-provided assistant screenshot comparing KEEL's current assistant against a cleaner Lightfield-style chat surface.
- Current assistant implementation in `apps/web/src/app/dashboard/assistant/page.tsx`.
- Current typed client API contract in `apps/web/src/lib/keel-api.ts`.
- Installed shadcn configuration and local UI component inventory in `apps/web/components.json` and `apps/web/src/components/ui`.
- Existing migration sequence, including prior performance indexes and recently added AI/provider/categorization work.
- Current external docs checked on 2026-07-17:
  - assistant-ui primitives: https://www.assistant-ui.com/docs/primitives
  - assistant-ui message primitive / message bubble composition: https://www.assistant-ui.com/docs/primitives/message
  - assistant-ui composer: https://www.assistant-ui.com/docs/primitives/composer
  - shadcn chat components changelog: https://ui.shadcn.com/docs/changelog/2026-06-chat-components
  - Supabase query optimization: https://supabase.com/docs/guides/database/query-optimization
  - Supabase index advisor: https://supabase.com/docs/guides/database/extensions/index_advisor

## Recommendation: one integrated PR with four workstreams

### Workstream 1 — Assistant visual/system polish

Goal: rebuild the assistant surface around assistant-ui's own chat primitives and message-bubble patterns first, then wrap them with KEEL/shadcn system styling so the chat looks native without hand-rolling generic bubbles.

Scope:

1. Use assistant-ui for the chat-specific pieces first: `ThreadPrimitive`, `MessagePrimitive`, `MessagePartPrimitive`, `ComposerPrimitive`, assistant-ui message bubble composition, and assistant-ui tool/part rendering where available. Do not build new chat bubble primitives from scratch when assistant-ui already provides the interaction model.
2. Use checked-in shadcn/KEEL system components around those chat primitives for the product chrome and finance-specific surfaces: `Card`, `Badge`, `Button`, `ScrollArea`, `Separator`, `InputGroup`, `Tooltip`, provenance disclosures, and action confirmation cards.
3. Keep `@assistant-ui/react` runtime/state, but make all visible pieces KEEL-branded compositions of assistant-ui bubbles plus system components: message rows, assistant answer cards, provenance disclosure, tool/action cards, composer, suggested prompts, empty state, loading state, and error state.
4. Tighten the layout:
   - readable centered conversation column,
   - assistant answer surface with TLDR, details, provenance, and evidence as distinct sections,
   - persistent composer that feels like a command input, not a generic textarea,
   - better empty state and suggested questions.
5. Improve markdown/text rendering without letting arbitrary model output own layout. Because the backend already returns typed `tldr`, `body`, `asOf`, `scope`, and `evidenceRefs`, prefer typed rendering over raw markdown. If markdown remains necessary later, add a constrained renderer component with tables/lists/code styled through semantic tokens.
6. Add the read/write interaction model now: the assistant may prepare actions such as creating notes/tasks, but writes must be explicit, reviewed, and confirmed by the user through KEEL command UI before any mutation runs.
7. Validate keyboard behavior, loading/cancel states, empty household state, provider failure states, write-confirmation states, and mobile width.

Notes:

- The current code already uses assistant-ui primitives (`ThreadPrimitive`, `MessagePrimitive`, `ComposerPrimitive`) and a single-shot local runtime. The UX problem is not the runtime itself; it is that we are not leaning enough on assistant-ui's message-bubble/parts composition and are styling too much like a generic card.
- Prefer assistant-ui's chat-specific bubble patterns over shadcn chat primitives for the core conversation surface. shadcn remains the surrounding design system for finance cards, badges, confirmations, command controls, and other non-chat product UI.
- Tool calls should render as system cards, not raw JSON or model-looking markdown. A note/task creation proposal should show the target object, affected household/entity/account if any, and explicit `Confirm` / `Cancel` actions.

Validation:

- `pnpm --filter @keel/web lint`
- `pnpm --filter @keel/web typecheck` or root `pnpm typecheck`
- targeted component/unit tests where existing setup supports it
- screenshot comparison for `/dashboard/assistant`

### Workstream 2 — UI/UX design-system audit and finance-specific standardization

Goal: reduce bespoke UI and make finance workflows trustworthy, consistent, and easier to scan.

Scope:

1. Inventory pages for patterns that should be standardized:
   - page headers and actions,
   - metric cards,
   - data tables and filters,
   - money/date/status formatting,
   - empty/error/loading states,
   - destructive/irreversible action confirmation,
   - forms/dialogs/sheets.
2. Create or refine KEEL-specific wrapper components only where the product has repeated domain needs:
   - `MoneyText` / amount polarity display,
   - `StatusBadge`,
   - `EntityAccountBadge`,
   - `EvidenceDisclosure`,
   - table toolbar/filter rows,
   - financial metric card.
3. Keep shadcn as the base system. Based on current research, the best leverage is not swapping frameworks; it is adopting more shadcn components/patterns consistently and adding a thin domain layer. A full framework switch would increase migration cost without solving KEEL-specific ledger UX.
4. Evaluate additions from the shadcn registry only after checking existing installed components. Current local components include foundational primitives but not the newer chat components or higher-level data-display blocks.

Validation:

- audit checklist committed as a markdown artifact,
- before/after screenshots for each touched screen,
- lint/typecheck,
- no raw one-off colors when semantic tokens or component variants exist.

### Workstream 3 — Notes and tasks domain model

Goal: add lightweight personal finance reminders without corrupting ledger immutability or creating vague AI-write behavior.

Proposed backend model:

- `notes`
  - `id uuid primary key`
  - `household_id uuid not null`
  - optional anchors: `entity_id`, `account_id`, `canonical_transaction_id`, `category_id`, `budget_id`, `goal_id`, `schedule_id`
  - `body text not null`
  - `pinned boolean not null default false`
  - `archived_at timestamptz`
  - `created_by uuid`, `created_at`, `updated_at`
- `tasks`
  - `id uuid primary key`
  - `household_id uuid not null`
  - same optional anchors as notes
  - `title text not null`
  - `description text`
  - `status text check in ('open','done','dismissed')`
  - `due_on date`
  - `priority text check in ('low','normal','high')`
  - `completed_at timestamptz`
  - `created_by uuid`, `created_at`, `updated_at`
- RLS: household-scoped, no cross-household reads/writes.
- Audit events for create/update/archive/complete.

Product UX:

1. Start with a dashboard module: “Notes & tasks”.
2. Add contextual creation from transaction/account/category/detail screens later.
3. Use plain language examples:
   - note: “Cash back on Xbox expires at month end.”
   - task: “Pay Alex back by Friday.”
4. Let the assistant participate in notes/tasks once the explicit write-confirmation path exists. It can draft note/task proposals from conversation context, but the final write must go through a visible KEEL review/confirmation action and normal API/RLS/audit paths.

Validation:

- migration tests / local database reset if available,
- API tests for RLS and household scoping,
- UI tests for create/edit/complete/archive,
- assistant proposal tests that prove no write happens before user confirmation,
- audit-log assertions for writes.

### Workstream 4 — Query/performance audit

Goal: identify real bottlenecks before adding indexes or denormalized read models.

Scope:

1. Static query inventory:
   - all Supabase client `.from(...)`, `.rpc(...)`, and edge-function database calls,
   - page/load boundaries that fire multiple serial requests,
   - queries missing household/entity/account filters,
   - query shapes likely to scan large tables.
2. Runtime instrumentation plan:
   - collect Supabase Query Performance Report / `pg_stat_statements`,
   - run `EXPLAIN (ANALYZE, BUFFERS)` for slow paths in a seeded or production-like database,
   - use Supabase Index Advisor for candidate indexes,
   - validate candidates against existing indexes to avoid duplicate write overhead.
3. Optimization candidates to validate, not assume:
   - combine serial dashboard reads into one RPC/read model where latency dominates,
   - ensure transaction ledger pages use keyset pagination rather than offset scans as data grows,
   - review category/budget/forecast queries for composite indexes that match household + date/category filters,
   - cache or precompute dashboard aggregates only when measured query cost warrants it.

Validation standard:

- No performance PR should claim a win without before/after query plans or timing.
- Every new index must map to a measured query and include write-cost consideration.
- Prefer removing duplicate indexes over adding more if the advisor reveals overlap.

## Integrated PR execution order

1. Start with the assistant system-UI refactor because it is the visible pain point and establishes the chat/tool-call patterns needed for notes/tasks.
2. Fold the design-system audit into the same PR by extracting repeated primitives only when the assistant or notes/tasks work needs them.
3. Add notes/tasks schema, API, and UI next, then wire assistant proposals through explicit confirmation.
4. Run the query/performance audit in parallel, but only ship database optimizations when backed by measured query plans or Supabase advisor output.

## Immediate implementation target

Start ripping on the assistant system-UI refactor inside this integrated PR. The first pass should include:

- assistant component refactor around assistant-ui message bubbles and parts,
- improved answer/provenance styling,
- standardized composer,
- system-styled assistant-ui tool/proposal cards for future note/task writes,
- empty/loading/error states,
- screenshot evidence,
- lint/typecheck.
