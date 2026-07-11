export const MAX_WEBHOOK_BYTES = 1024 * 1024;

export type BoundedWebhookBody =
  | { ok: true; bodyBytes: Uint8Array }
  | { ok: false; status: 401; reason: 'webhook body too large' };

interface RequestBodySource {
  headers: Headers;
  body?: ReadableStream<Uint8Array> | null;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export const declaredWebhookBodyTooLarge = (headers: Headers): boolean => {
  const declaredLength = headers.get('content-length');
  return declaredLength !== null &&
    (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_WEBHOOK_BYTES);
};

const tooLarge = (): BoundedWebhookBody => ({
  ok: false,
  status: 401,
  reason: 'webhook body too large',
});

/**
 * Bounded read (post-build review, Codex #1): a missing/untrustworthy
 * Content-Length (e.g. chunked transfer) must NOT be buffered in full before
 * the size check — that is a memory-exhaustion DoS on a public endpoint. We
 * STREAM the body and abort once it exceeds the cap, so at most
 * MAX_WEBHOOK_BYTES (+ one chunk) is ever held. The declared-length header is
 * still an early fast-reject.
 */
export const readBoundedWebhookBody = async (
  request: RequestBodySource,
): Promise<BoundedWebhookBody> => {
  if (declaredWebhookBodyTooLarge(request.headers)) return tooLarge();

  const stream = request.body ?? null;
  if (stream === null) {
    // No stream available (e.g. a test double): fall back to arrayBuffer with
    // the post-read cap. Production requests always carry a body stream.
    const bodyBytes = new Uint8Array(await request.arrayBuffer());
    return bodyBytes.byteLength > MAX_WEBHOOK_BYTES ? tooLarge() : { ok: true, bodyBytes };
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > MAX_WEBHOOK_BYTES) {
          await reader.cancel();
          return tooLarge();
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }

  const bodyBytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bodyBytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bodyBytes };
};
