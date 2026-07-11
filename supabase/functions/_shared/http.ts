/**
 * Shared HTTP plumbing for KEEL Edge Functions: JSON responses and the
 * mapping from KEEL SQLSTATE codes (raised by command procs) to wire errors.
 *
 * Scope violations return 404/not_found deliberately: cross-tenant probes
 * must not learn whether a resource exists (fail closed, INFRA §17 rule 9).
 */

export const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

interface WireError {
  status: number;
  code: string;
  message: string;
}

const SQLSTATE_MAP: Record<string, WireError> = {
  P0001: { status: 409, code: 'immutable_record', message: 'Record is append-only.' },
  P0002: { status: 422, code: 'unbalanced_batch', message: 'Journal batch does not balance.' },
  P0003: { status: 423, code: 'period_locked', message: 'Period is locked.' },
  P0004: { status: 401, code: 'not_authenticated', message: 'Authentication required.' },
  P0005: { status: 403, code: 'not_authorized', message: 'Not authorized.' },
  P0006: { status: 404, code: 'not_found', message: 'Not found.' },
  P0007: {
    status: 409,
    code: 'idempotency_conflict',
    message: 'Economic event key replayed with a different payload.',
  },
  P0008: { status: 422, code: 'invalid_money', message: 'Invalid monetary value.' },
  P0009: { status: 400, code: 'invalid_command', message: 'Invalid command.' },
};

/** Map a supabase-js/PostgREST error to a KEEL wire error response. */
export const mapDbError = (error: { code?: string; message?: string }): Response => {
  const known = error.code ? SQLSTATE_MAP[error.code] : undefined;
  if (known) {
    return json(known.status, { code: known.code, message: known.message, details: {} });
  }
  // Unknown failure: no internals on the wire.
  console.error('unmapped db error', error.code, error.message);
  return json(500, { code: 'transaction_failed', message: 'Command failed.', details: {} });
};

/** Deep camelCase→snake_case key transform for proc jsonb payloads. */
export const toSnakeKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(toSnakeKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`),
        toSnakeKeys(v),
      ]),
    );
  }
  return value;
};
