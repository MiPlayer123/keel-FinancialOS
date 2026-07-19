import { describe, it, expect, vi, beforeEach } from 'vitest';

// The handler reads AI_PROVIDER/OPENAI_* off Deno.env — stub it before import so
// the default (fixture) path is exercised and no network is ever attempted.
vi.stubGlobal('Deno', { env: { get: (_name: string): string | undefined => undefined } });

const {
  processStatementExtractJob,
  routeStatementExtraction,
  makeStatementJobIO,
} = await import('../statement-extract.ts');
import type {
  StatementJobIO,
  ResolvedStatementVersion,
  PersistStatementArgs,
} from '../statement-extract.ts';
import type {
  StatementExtractor,
  StatementExtractionRecord,
} from '../../_shared/vendor/keel-domain.mjs';

const HH = '00000000-0000-4000-8000-00000000a001';
const VER = '00000000-0000-4000-8000-0000000000c1';
const ACCT = '00000000-0000-4000-8000-0000000000f1';

const version = (over: Partial<ResolvedStatementVersion> = {}): ResolvedStatementVersion => ({
  documentVersionId: VER,
  householdId: HH,
  accountId: ACCT,
  storageBucket: 'statements',
  storagePath: 'p/obj',
  mimeType: 'text/csv',
  contentSha256: 'sha-1',
  ...over,
});

/** An inert extractor record (what a fixture/parser returns for unknown input). */
const inertRecord = (extractor: string): StatementExtractionRecord =>
  ({
    periodStart: null,
    periodEnd: null,
    openingMinor: null,
    endingMinor: null,
    currency: null,
    kindHint: 'unknown',
    accountHint: null,
    lines: [],
    holdings: [],
    confidence: 0,
    provenance: {} as never,
    extractor,
    extractorVersion: 'v1',
    model: null,
    promptVersion: null,
    rawEvidence: {},
  }) as unknown as StatementExtractionRecord;

/** A fixture extractor that always returns a fixed record (PDF path). */
const fixedExtractor = (record: StatementExtractionRecord): StatementExtractor => ({
  extract: () => Promise.resolve({ record }),
});

/**
 * A fake StatementJobIO that RECORDS every port call. Because the handler does
 * no IO of its own, this recorder captures the COMPLETE side-effect surface —
 * the capability-boundary assertion ([A1]) reads directly off it.
 */
interface PortLog {
  resolve: Array<{ documentVersionId: string; householdId: string }>;
  download: Array<{ bucket: string; path: string }>;
  persist: PersistStatementArgs[];
  extractorBuilds: number;
}

const makeFakeIO = (opts: {
  resolved?: ResolvedStatementVersion | null;
  bytes?: Uint8Array | null;
  record?: StatementExtractionRecord;
  extractorThrows?: boolean;
  log: PortLog;
}): StatementJobIO => ({
  resolveVersion(documentVersionId, householdId) {
    opts.log.resolve.push({ documentVersionId, householdId });
    return Promise.resolve(opts.resolved === undefined ? version() : opts.resolved);
  },
  download(bucket, path) {
    opts.log.download.push({ bucket, path });
    return Promise.resolve(opts.bytes === undefined ? new Uint8Array([1, 2, 3]) : opts.bytes);
  },
  buildExtractor() {
    opts.log.extractorBuilds += 1;
    if (opts.extractorThrows) {
      return { extract: () => Promise.reject(new Error('provider secret leak?')) };
    }
    return fixedExtractor(opts.record ?? inertRecord('fixture'));
  },
  persist(args) {
    opts.log.persist.push(args);
    return Promise.resolve({ ok: true, detail: 'persisted' });
  },
});

const freshLog = (): PortLog => ({ resolve: [], download: [], persist: [], extractorBuilds: 0 });

describe('processStatementExtractJob — capability boundary + flow [A1]', () => {
  it('persists ONE extraction through the port and reports success', async () => {
    const log = freshLog();
    const io = makeFakeIO({
      log,
      bytes: new TextEncoder().encode('Date,Amount,Description\n2026-07-01,-12.50,COFFEE\n'),
      record: undefined,
    });
    const result = await processStatementExtractJob(io, { documentVersionId: VER, householdId: HH });
    expect(result.ok).toBe(true);
    expect(log.resolve).toHaveLength(1);
    expect(log.download).toHaveLength(1);
    expect(log.persist).toHaveLength(1);
    expect(log.persist[0].status).toBe('extracted');
    expect(log.persist[0].accountId).toBe(ACCT);
  });

  it('CAPABILITY BOUNDARY: the ONLY rpc reachable is keel_worker_persist_statement_extraction', async () => {
    // Drive the handler with the REAL Supabase-backed port (makeStatementJobIO)
    // over a spying admin double. The spy records every .rpc/.from/.storage. The
    // assertion: the sole rpc name that ever appears is the allowlisted persist
    // proc — the handler cannot reach any other write (Law 5, [A1]).
    const rpcNames: string[] = [];
    const fromTables: string[] = [];
    let storageDownloads = 0;
    const admin = {
      from(table: string) {
        fromTables.push(table);
        const chain = {
          select: () => chain,
          eq: () => chain,
          single: () => {
            if (table === 'document_versions') {
              return {
                data: {
                  id: VER,
                  storage_bucket: 'statements',
                  storage_path: 'p/obj',
                  mime_type: 'text/csv',
                  content_sha256: 'sha-1',
                  document_id: 'doc-1',
                },
                error: null,
              };
            }
            if (table === 'documents') return { data: { id: 'doc-1', household_id: HH }, error: null };
            if (table === 'statement_drafts') return { data: { account_id: ACCT }, error: null };
            return { data: null, error: new Error('unexpected table') };
          },
        };
        return chain;
      },
      storage: {
        from: () => ({
          download: () => {
            storageDownloads += 1;
            return {
              data: new Blob([new TextEncoder().encode('Date,Amount\n2026-07-01,-1.00\n')]),
              error: null,
            };
          },
        }),
      },
      rpc: (name: string) => {
        rpcNames.push(name);
        return { data: 'ext-1', error: null };
      },
    };
    // deno-lint-ignore no-explicit-any
    const io = makeStatementJobIO(admin as any);
    const result = await processStatementExtractJob(io, { documentVersionId: VER, householdId: HH });
    expect(result.ok).toBe(true);
    // The complete rpc surface is exactly one call to the allowlisted proc.
    expect(rpcNames).toEqual(['keel_worker_persist_statement_extraction']);
    // Reads are only the scope-verifying .from chain + one Storage download.
    expect(new Set(fromTables)).toEqual(new Set(['document_versions', 'documents', 'statement_drafts']));
    expect(storageDownloads).toBe(1);
  });

  it('IDEMPOTENT re-delivery: a second run persists again with the SAME args (proc no-ops)', async () => {
    // The worker is stateless; idempotency lives in the persist proc's unique
    // key. Re-running the handler must produce byte-identical persist args so a
    // sweeper re-enqueue can never create a second economic read (Law 9).
    const record = inertRecord('csv');
    const log1 = freshLog();
    const log2 = freshLog();
    const bytes = new TextEncoder().encode('Date,Amount\n2026-07-01,-1.00\n');
    await processStatementExtractJob(makeFakeIO({ log: log1, bytes, record }), {
      documentVersionId: VER,
      householdId: HH,
    });
    await processStatementExtractJob(makeFakeIO({ log: log2, bytes, record }), {
      documentVersionId: VER,
      householdId: HH,
    });
    expect(log1.persist).toHaveLength(1);
    expect(log2.persist).toHaveLength(1);
    expect(log2.persist[0]).toEqual(log1.persist[0]);
  });

  it('HOUSEHOLD MISMATCH: an unresolvable version refuses with NO persist', async () => {
    const log = freshLog();
    const io = makeFakeIO({ log, resolved: null });
    const result = await processStatementExtractJob(io, {
      documentVersionId: VER,
      householdId: '00000000-0000-4000-8000-0000ffffffff',
    });
    expect(result.ok).toBe(false);
    expect(log.persist).toHaveLength(0);
    expect(log.download).toHaveLength(0);
  });

  it('DOWNLOAD FAILURE → status=failed with a short code, NO provider body (Law 12)', async () => {
    const log = freshLog();
    const io = makeFakeIO({ log, bytes: null });
    const result = await processStatementExtractJob(io, { documentVersionId: VER, householdId: HH });
    expect(result.ok).toBe(false);
    expect(log.persist).toHaveLength(1);
    expect(log.persist[0].status).toBe('failed');
    expect(log.persist[0].errorCode).toBe('object_download_failed');
    expect(log.persist[0].record).toBeNull();
  });

  it('EXTRACTOR THROW → status=failed, code=extraction_failed, no leaked message (Law 12)', async () => {
    const log = freshLog();
    // A PDF magic-byte object routes to the extractor, which throws.
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 1, 2, 3]);
    const io = makeFakeIO({ log, bytes: pdfBytes, extractorThrows: true });
    const result = await processStatementExtractJob(io, { documentVersionId: VER, householdId: HH });
    expect(result.ok).toBe(false);
    expect(log.persist).toHaveLength(1);
    expect(log.persist[0].status).toBe('failed');
    expect(log.persist[0].errorCode).toBe('extraction_failed');
    // The detail is a constant; the thrown message never appears.
    expect(result.detail).not.toContain('secret');
  });
});

describe('routeStatementExtraction — mime routing + magic-byte sniff (§6)', () => {
  const noopExtractor = (rec: StatementExtractionRecord): StatementExtractor => ({
    extract: () => Promise.resolve({ record: rec }),
  });

  it('routes text/csv to the CSV parser (produces a line record, bytes-only)', async () => {
    const bytes = new TextEncoder().encode('Date,Amount,Description\n2026-07-01,-12.50,COFFEE\n');
    const rec = await routeStatementExtraction('text/csv', bytes, noopExtractor(inertRecord('pdf')), 'sha');
    expect(rec.extractor).toBe('csv');
    expect(rec.lines.length).toBe(1);
  });

  it('routes application/x-ofx to the OFX parser', async () => {
    const ofx = new TextEncoder().encode(
      '<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>USD</CURDEF>' +
        '<BANKTRANLIST><STMTTRN><DTPOSTED>20260701</DTPOSTED><TRNAMT>-12.50</TRNAMT>' +
        '<NAME>COFFEE</NAME></STMTTRN></BANKTRANLIST>' +
        '<LEDGERBAL><BALAMT>100.00</BALAMT></LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>',
    );
    const rec = await routeStatementExtraction('application/x-ofx', ofx, noopExtractor(inertRecord('pdf')), 'sha');
    expect(rec.extractor).toBe('ofx');
    expect(rec.lines.length).toBeGreaterThanOrEqual(1);
  });

  it('routes real PDF magic bytes to the extractor EVEN when mime lies as text/csv', async () => {
    // A hostile ".csv" whose bytes are actually a PDF must go to the model path,
    // never the CSV parser (§6 magic-byte sniff over declared mime).
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
    const fixture = inertRecord('claude:fixture');
    const rec = await routeStatementExtraction('text/csv', pdfBytes, noopExtractor(fixture), 'sha');
    expect(rec.extractor).toBe('claude:fixture');
  });
});

/**
 * Sweeper idempotency [A12]. keel_sweep_statement_outbox is SQL, but its
 * re-enqueue state machine is deterministic and specified exactly; this models
 * it 1:1 and asserts the invariant that MATTERS: a stuck 'pending' draft is
 * re-enqueued AT MOST ONCE per grace window, and NEVER once the draft leaves
 * 'pending'. (The end-to-end DB behaviour is exercised by applying the migration
 * + the integration test; this guards the algorithm against regression.)
 */
interface OutboxRow {
  status: 'pending' | 'delivered' | 'abandoned';
  enqueueCount: number;
  lastEnqueuedAt: number | null;
  createdAt: number;
}
const sweepOutbox = (
  row: OutboxRow,
  draftStatus: 'pending' | 'extracted' | 'failed' | 'approved' | 'dismissed',
  now: number,
  opts: { grace: number; maxEnqueues: number },
  enqueue: () => void,
): void => {
  if (row.status !== 'pending') return;
  if (!(row.createdAt < now - opts.grace)) return;
  if (!(row.lastEnqueuedAt === null || row.lastEnqueuedAt < now - opts.grace)) return;
  if (draftStatus !== 'pending') {
    row.status = 'delivered';
    return;
  }
  if (row.enqueueCount >= opts.maxEnqueues) {
    row.status = 'abandoned';
    return;
  }
  enqueue();
  row.enqueueCount += 1;
  row.lastEnqueuedAt = now;
};

describe('keel_sweep_statement_outbox — idempotent re-enqueue model [A12]', () => {
  const opts = { grace: 180, maxEnqueues: 8 };

  it('re-enqueues a stuck pending draft EXACTLY ONCE per grace window', () => {
    const row: OutboxRow = { status: 'pending', enqueueCount: 0, lastEnqueuedAt: null, createdAt: 0 };
    let enqueues = 0;
    // t=100: still within grace of creation → NOT enqueued.
    sweepOutbox(row, 'pending', 100, opts, () => (enqueues += 1));
    expect(enqueues).toBe(0);
    // t=200: past grace → enqueued once.
    sweepOutbox(row, 'pending', 200, opts, () => (enqueues += 1));
    expect(enqueues).toBe(1);
    // t=250: within grace of the last enqueue → NOT re-enqueued (idempotent).
    sweepOutbox(row, 'pending', 250, opts, () => (enqueues += 1));
    expect(enqueues).toBe(1);
    // t=400: past grace again → one more.
    sweepOutbox(row, 'pending', 400, opts, () => (enqueues += 1));
    expect(enqueues).toBe(2);
  });

  it('marks delivered + STOPS re-enqueuing once the draft leaves pending', () => {
    const row: OutboxRow = { status: 'pending', enqueueCount: 1, lastEnqueuedAt: 0, createdAt: 0 };
    let enqueues = 0;
    sweepOutbox(row, 'extracted', 200, opts, () => (enqueues += 1));
    expect(enqueues).toBe(0);
    expect(row.status).toBe('delivered');
    // A subsequent sweep is a no-op on a delivered row.
    sweepOutbox(row, 'extracted', 400, opts, () => (enqueues += 1));
    expect(enqueues).toBe(0);
  });

  it('abandons a poison row after max sweeps without progress (never loops forever)', () => {
    const row: OutboxRow = { status: 'pending', enqueueCount: 8, lastEnqueuedAt: 0, createdAt: 0 };
    let enqueues = 0;
    sweepOutbox(row, 'pending', 200, opts, () => (enqueues += 1));
    expect(enqueues).toBe(0);
    expect(row.status).toBe('abandoned');
  });
});
