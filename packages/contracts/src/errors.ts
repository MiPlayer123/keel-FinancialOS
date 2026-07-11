import { z } from 'zod';

export const KEEL_ERROR_CODES = [
  // authorization
  'not_authenticated',
  'not_authorized',
  'household_scope_violation',
  // validation
  'invalid_command',
  'invalid_money',
  'unbalanced_batch',
  'currency_mismatch',
  // state
  'idempotency_replay', // same key, same payload: safe no-op signal
  'idempotency_conflict', // same key, DIFFERENT payload: hard failure
  'period_locked',
  'immutable_record',
  'not_found',
  // infrastructure
  'transaction_failed',
  'queue_unavailable',
] as const;
export type KeelErrorCode = (typeof KEEL_ERROR_CODES)[number];
export const KeelErrorCodeSchema = z.enum(KEEL_ERROR_CODES);

export class KeelError extends Error {
  readonly code: KeelErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: KeelErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'KeelError';
    this.code = code;
    this.details = details;
  }
}

export const isKeelError = (value: unknown): value is KeelError => value instanceof KeelError;

/** Wire shape every KEEL surface returns on failure. */
export const ErrorDtoSchema = z.object({
  code: KeelErrorCodeSchema,
  message: z.string(),
  details: z.record(z.string(), z.unknown()).default({}),
});
export type ErrorDto = z.infer<typeof ErrorDtoSchema>;
