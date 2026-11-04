/**
 * Categorization setup: the category tree and tags (everything needed to
 * categorize or tag something), rules, and the same edits the app's settings
 * offer.
 */
import * as z from 'npm:zod@4.4.3';
import { defineTool, pick, readProc, rowsOf, uuid, writeProc } from '../context.ts';
import { err, money, ok } from '../lib.ts';

export const categoriesList = defineTool({
  name: 'categories_list',
  title: 'List categories and tags',
  description:
    'The household\'s category tree (id, name, income or expense, parent, entity, tax line) and its tags. Use these ids to categorize, split, budget or filter.',
  kind: 'read',
  input: z.object({}).strict(),
  run: async (ctx) => {
    const [cats, tags] = await Promise.all([
      readProc(ctx, 'categories.list', 'keel_list_categories'),
      readProc(ctx, 'tags.list', 'keel_list_tags'),
    ]);
    if (!cats.ok) return cats;
    const categories = rowsOf(cats.data).map((c) => ({
      id: c['ledgerAccountId'],
      name: c['name'],
      kind: c['kind'],
      parent_id: c['parentLedgerAccountId'] ?? null,
      entity: c['entityName'] ?? null,
      tax_line: c['taxLine'] ?? null,
      system: c['isSystem'] === true,
    }));
    return ok(`${categories.length} categories.`, {
      categories,
      tags: tags.ok ? rowsOf(tags.data).map((t) => pick(t, ['tagId', 'id', 'name', 'entityId', 'transactionCount'])) : [],
    });
  },
});

export const categoriesCreate = defineTool({
  name: 'categories_create',
  title: 'Create a category',
  description: 'Adds an income or expense category, optionally under a parent category or for a specific entity.',
  kind: 'write',
  destructive: false,
  input: z.object({
    name: z.string().min(1).max(100),
    kind: z.enum(['expense', 'income']),
    parent_id: uuid('Parent category').optional(),
    entity_id: uuid('Entity').optional(),
  }).strict(),
  run: async (ctx, args) => {
    const r = await writeProc(ctx, 'categories.create', 'keel_create_category', {
      p_name: args.name,
      p_kind: args.kind,
      p_parent_ledger_account_id: args.parent_id ?? null,
      p_entity_id: args.entity_id ?? null,
    });
    if (!r.ok) return r;
    return ok(`Created ${args.name}.`, { category_id: typeof r.data === 'string' ? r.data : (r.data as { ledgerAccountId?: string } | null)?.ledgerAccountId ?? null });
  },
});

export const categoriesUpdate = defineTool({
  name: 'categories_update',
  title: 'Edit a category',
  description: 'Renames a category, moves it under another parent (or to the top level), or sets its tax line.',
  kind: 'write',
  destructive: true,
  input: z.object({
    category_id: uuid('Category'),
    name: z.string().min(1).max(100).optional(),
    parent_id: uuid('New parent category').nullable().optional().describe('null = move to top level.'),
    tax_line: z.string().max(100).nullable().optional().describe('null clears it.'),
  }).strict(),
  run: async (ctx, args) => {
    const done: string[] = [];
    if (args.name) {
      const r = await writeProc(ctx, 'categories.rename', 'keel_rename_category', {
        p_category_ledger_account_id: args.category_id, p_name: args.name,
      });
      if (!r.ok) return r;
      done.push('name');
    }
    if (args.parent_id !== undefined) {
      const r = await writeProc(ctx, 'categories.rename', 'keel_reparent_category', {
        p_category_ledger_account_id: args.category_id, p_parent_ledger_account_id: args.parent_id,
      });
      if (!r.ok) return err(r.code, `${done.length ? 'Renamed; then ' : ''}move failed: ${r.message}`, r.hint);
      done.push('parent');
    }
    if (args.tax_line !== undefined) {
      const r = await writeProc(ctx, 'categories.rename', 'keel_set_category_tax_line', {
        p_ledger_account_id: args.category_id, p_tax_line: args.tax_line,
      });
      if (!r.ok) return err(r.code, `${done.length ? `Changed ${done.join(', ')}; then ` : ''}tax line failed: ${r.message}`, r.hint);
      done.push('tax line');
    }
    if (done.length === 0) return err('invalid_request', 'Nothing to change.');
    return ok(`Updated ${done.join(', ')}.`, { category_id: args.category_id, changed: done });
  },
});

export const categoriesArchive = defineTool({
  name: 'categories_archive',
  title: 'Archive a category',
  description:
    'Archives a category (it stays in history). Pass reassign_to_id to move its transactions, rules and budgets to another category first.',
  kind: 'write',
  destructive: true,
  input: z.object({
    category_id: uuid('Category'),
    reassign_to_id: uuid('Replacement category').optional(),
  }).strict(),
  run: async (ctx, args) => {
    const r = await writeProc(ctx, 'categories.rename', 'keel_archive_category', {
      p_category_ledger_account_id: args.category_id, p_reassign_to: args.reassign_to_id ?? null,
    });
    if (!r.ok) return r;
    return ok('Archived the category.', { category_id: args.category_id });
  },
});

export const tagsSave = defineTool({
  name: 'tags_save',
  title: 'Create or rename a tag',
  description: 'Creates a tag (omit tag_id) or renames one. Tag transactions with transactions_update.',
  kind: 'write',
  destructive: false,
  input: z.object({ tag_id: uuid('Tag').optional(), name: z.string().min(1).max(40) }).strict(),
  run: async (ctx, args) => {
    const r = await writeProc(ctx, null, 'keel_tag_save', { p_tag_id: args.tag_id ?? null, p_name: args.name });
    if (!r.ok) return r;
    return ok(args.tag_id ? `Renamed the tag to ${args.name}.` : `Created tag ${args.name}.`, {
      tag_id: args.tag_id ?? (typeof r.data === 'string' ? r.data : null),
    });
  },
});

export const tagsDelete = defineTool({
  name: 'tags_delete',
  title: 'Delete a tag',
  description: 'Deletes a tag and removes it from every transaction. Transactions themselves are untouched.',
  kind: 'write',
  destructive: true,
  input: z.object({ tag_id: uuid('Tag') }).strict(),
  run: async (ctx, args) => {
    const r = await writeProc(ctx, null, 'keel_tag_delete', { p_tag_id: args.tag_id });
    if (!r.ok) return r;
    return ok('Deleted the tag.', { tag_id: args.tag_id });
  },
});

export const rulesList = defineTool({
  name: 'rules_list',
  title: 'List rules',
  description: 'Categorization rules: what text they match, amount range, the category they set, any rename, priority, and whether active.',
  kind: 'read',
  input: z.object({}).strict(),
  run: async (ctx) => {
    const r = await readProc(ctx, 'rules.list', 'keel_list_rules');
    if (!r.ok) return r;
    const rules = rowsOf(r.data).map((x) => ({
      id: x['ruleId'] ?? x['id'],
      pattern: x['pattern'],
      category_id: x['categoryLedgerAccountId'] ?? null,
      category: x['categoryName'] ?? null,
      rename_to: x['renameTo'] ?? null,
      min_amount: money(x['amountMinMinor'] as string | null, 'USD'),
      max_amount: money(x['amountMaxMinor'] as string | null, 'USD'),
      priority: x['priority'],
      active: x['active'],
    }));
    return ok(`${rules.length} rules.`, { rules });
  },
});

export const rulesSave = defineTool({
  name: 'rules_save',
  title: 'Create or edit a rule',
  description:
    'Creates a categorization rule (omit rule_id) or edits one: transactions whose description contains pattern (and fall in the optional amount range, minor units, absolute) get category_id and/or are renamed. New transactions use it automatically; run rules_apply to apply it to history.',
  kind: 'write',
  destructive: false,
  input: z.object({
    rule_id: uuid('Rule').optional(),
    pattern: z.string().min(1).max(200),
    category_id: uuid('Category').optional(),
    rename_to: z.string().min(1).max(140).optional(),
    min_amount_minor: z.number().int().nonnegative().optional(),
    max_amount_minor: z.number().int().nonnegative().optional(),
    priority: z.number().int().min(0).max(1000).default(100),
    active: z.boolean().default(true),
  }).strict(),
  run: async (ctx, args) => {
    if (!args.category_id && !args.rename_to) {
      return err('invalid_request', 'A rule needs a category_id, a rename_to, or both.', 'categories_list has the category ids.');
    }
    const r = await writeProc(ctx, null, 'keel_rule_save', {
      p_rule_id: args.rule_id ?? null,
      p_pattern: args.pattern,
      p_category_ledger_account_id: args.category_id ?? null,
      p_rename_to: args.rename_to ?? null,
      p_priority: args.priority,
      p_active: args.active,
      p_amount_min_minor: args.min_amount_minor ?? null,
      p_amount_max_minor: args.max_amount_minor ?? null,
    });
    if (!r.ok) return r;
    return ok(args.rule_id ? 'Updated the rule.' : 'Created the rule.', {
      rule_id: args.rule_id ?? (typeof r.data === 'string' ? r.data : null),
      next: 'rules_apply with dry_run true previews what it would change in history.',
    });
  },
});

export const rulesDelete = defineTool({
  name: 'rules_delete',
  title: 'Delete a rule',
  description: 'Deletes a rule. Categories it already set stay as they are.',
  kind: 'write',
  destructive: true,
  input: z.object({ rule_id: uuid('Rule') }).strict(),
  run: async (ctx, args) => {
    const r = await writeProc(ctx, null, 'keel_rule_delete', { p_rule_id: args.rule_id });
    if (!r.ok) return r;
    return ok('Deleted the rule.', { rule_id: args.rule_id });
  },
});

export const rulesApply = defineTool({
  name: 'rules_apply',
  title: 'Apply rules to history',
  description:
    'Runs every active rule over existing transactions. dry_run true (the default) only reports what would change; run again with dry_run false to apply.',
  kind: 'write',
  destructive: true,
  input: z.object({ dry_run: z.boolean().default(true) }).strict(),
  run: async (ctx, args) => {
    const r = await writeProc(ctx, null, 'keel_apply_rules', { p_dry_run: args.dry_run });
    if (!r.ok) return r;
    return ok(args.dry_run ? 'Preview only; nothing changed.' : 'Applied rules.', { result: r.data });
  },
});

export const setupTools = [
  categoriesList,
  categoriesCreate,
  categoriesUpdate,
  categoriesArchive,
  tagsSave,
  tagsDelete,
  rulesList,
  rulesSave,
  rulesDelete,
  rulesApply,
];
