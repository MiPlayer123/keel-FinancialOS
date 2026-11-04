/**
 * What a tool gets to work with, built once per request from the caller's
 * verified token and live KEEL grant. Every database call a tool makes goes
 * through the caller's own client (RLS + auth.uid() in every proc); the
 * service key is used only by index.ts to read the gateway key.
 */
import * as z from 'npm:zod@4.4.3';
import { dbError, err, type ToolErr, type ToolOutcome } from './lib.ts';

export type Access = 'read' | 'write';

export interface DbResult {
  readonly data: unknown;
  readonly error: { code?: string; message?: string } | null;
}

// deno-lint-ignore no-explicit-any
export type UserClient = any;

export interface ToolContext {
  readonly userId: string;
  readonly clientId: string;
  readonly householdId: string;
  readonly access: Access;
  readonly nowIso: string;
  readonly todayIso: string;
  /** The caller's supabase-js client (table reads under RLS). */
  readonly db: UserClient;
  readonly rpc: (proc: string, args: Record<string, unknown>) => Promise<DbResult>;
  /** Fail-closed authz compiler, same as the app (Law 7). */
  readonly authorize: (action: string, resource?: Record<string, unknown>) => Promise<boolean>;
  /** The shared typed command path (_shared/command-exec.ts). */
  readonly command: (
    command: string,
    payload: Record<string, unknown>,
    idempotencyKey: string | undefined,
  ) => Promise<{ ok: true; data: unknown } | ToolErr>;
}

export interface ToolDef<S extends z.ZodObject = z.ZodObject> {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly kind: 'read' | 'write';
  /** Writes: true when the tool overwrites, voids, archives or deletes (hosts confirm these). */
  readonly destructive?: boolean;
  readonly input: S;
  readonly run: (ctx: ToolContext, args: z.infer<S>) => Promise<ToolOutcome>;
}

export const defineTool = <S extends z.ZodObject>(def: ToolDef<S>): ToolDef<S> => def;

// ---------------------------------------------------------------------------
// Shared input schemas
// ---------------------------------------------------------------------------
export const uuid = (what: string) => z.string().uuid().describe(`${what} id (from a list_ or get_ tool)`);
export const isoDate = (what: string) =>
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD').describe(`${what} (YYYY-MM-DD)`);
export const minorString = (what: string) =>
  z.string().regex(/^-?(0|[1-9][0-9]*)$/, 'integer minor units, e.g. "-1250" for -$12.50').describe(
    `${what}, integer minor units as a string (cents for USD)`,
  );
export const idempotencyKey = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,100}$/)
  .optional()
  .describe('Optional. Reuse the same key when retrying the same change so it happens only once.');

// ---------------------------------------------------------------------------
// Small call helpers
// ---------------------------------------------------------------------------

/** Run a read proc for this household; map errors to steering tool errors. */
/**
 * `action` is the authz action the app checks for this read, or null where the
 * app relies on the proc's own membership check (same as `api` /queries).
 */
export const readProc = async (
  ctx: ToolContext,
  action: string | null,
  proc: string,
  args: Record<string, unknown> = {},
): Promise<{ ok: true; data: unknown } | ToolErr> => {
  if (action !== null && !(await ctx.authorize(action))) {
    return err('not_authorized', 'Your role in this household cannot read that.');
  }
  const { data, error } = await ctx.rpc(proc, { p_household_id: ctx.householdId, ...args });
  return error ? dbError(error) : { ok: true, data };
};

/** Run a bespoke write proc (the same one the app's route calls). */
export const writeProc = async (
  ctx: ToolContext,
  action: string | null,
  proc: string,
  args: Record<string, unknown>,
): Promise<{ ok: true; data: unknown } | ToolErr> => {
  if (action !== null && !(await ctx.authorize(action))) {
    return err('not_authorized', 'Your role in this household cannot make that change.');
  }
  const { data, error } = await ctx.rpc(proc, { p_household_id: ctx.householdId, ...args });
  return error ? dbError(error) : { ok: true, data };
};

export const rowsOf = (data: unknown): Record<string, unknown>[] => {
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  const rows = (data as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
};

/** Keep only the listed keys (drops heavy internals like evidence blobs). */
export const pick = (row: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> =>
  Object.fromEntries(keys.filter((k) => k in row).map((k) => [k, row[k]]));

/** Cap a list and say so (truncation must steer, never silently drop). */
export const capped = <T>(rows: readonly T[], limit: number) => ({
  rows: rows.slice(0, limit),
  ...(rows.length > limit ? { truncated: { shown: limit, total: rows.length, hint: 'Narrow the request to see the rest.' } } : {}),
});
