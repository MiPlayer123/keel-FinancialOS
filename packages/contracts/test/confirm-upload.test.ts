import { describe, expect, it } from 'vitest';
import {
  ConfirmDocumentUploadPayloadSchema,
  UploadStatementPayloadSchema,
  AttachDocumentUploadPayloadSchema,
} from '@keel/contracts';

const uuid = '5d3f8c9a-1b2e-4f6a-9c8d-7e6f5a4b3c2d';
const uuid2 = '11111111-1b2e-4f6a-9c8d-7e6f5a4b3c2d';

// Discriminated attach-vs-ingest confirm-upload contract [A3,
// statement-ingestion-v2 §3]. Attach and ingest are mutually exclusive by
// construction: an attach can never carry an accountId; an ingest can never
// carry a target.
describe('confirm-upload discriminated union [A3]', () => {
  it('accepts a well-formed attach with a target', () => {
    const parsed = ConfirmDocumentUploadPayloadSchema.safeParse({
      mode: 'attach',
      documentId: uuid,
      entityId: uuid,
      kind: 'statement',
      storageBucket: 'statements',
      storagePath: `${uuid}/${uuid}/x`,
      originalFilename: 'stmt.pdf',
      targetType: 'statement',
      targetId: uuid2,
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts a well-formed attach with NO target (unattached receipt)', () => {
    const parsed = ConfirmDocumentUploadPayloadSchema.safeParse({
      mode: 'attach',
      documentId: uuid,
      entityId: uuid,
      kind: 'receipt',
      storageBucket: 'receipts',
      storagePath: `${uuid}/${uuid}/x`,
      originalFilename: 'r.png',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an attach that carries an accountId (ingest smuggled in)', () => {
    const parsed = ConfirmDocumentUploadPayloadSchema.safeParse({
      mode: 'attach',
      documentId: uuid,
      entityId: uuid,
      kind: 'statement',
      storageBucket: 'statements',
      storagePath: `${uuid}/${uuid}/x`,
      originalFilename: 'stmt.pdf',
      targetType: 'statement',
      targetId: uuid2,
      accountId: uuid2,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects an attach with a half-target (type without id)', () => {
    const parsed = AttachDocumentUploadPayloadSchema.safeParse({
      mode: 'attach',
      documentId: uuid,
      entityId: uuid,
      kind: 'statement',
      storageBucket: 'statements',
      storagePath: `${uuid}/${uuid}/x`,
      originalFilename: 'stmt.pdf',
      targetType: 'statement',
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts a well-formed ingest (account, no target)', () => {
    const parsed = ConfirmDocumentUploadPayloadSchema.safeParse({
      mode: 'ingest',
      documentId: uuid,
      entityId: uuid,
      kind: 'statement',
      storageBucket: 'statements',
      storagePath: `${uuid}/${uuid}/x`,
      originalFilename: 'stmt.pdf',
      accountId: uuid2,
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an ingest with NO accountId', () => {
    const parsed = UploadStatementPayloadSchema.safeParse({
      mode: 'ingest',
      documentId: uuid,
      entityId: uuid,
      kind: 'statement',
      storageBucket: 'statements',
      storagePath: `${uuid}/${uuid}/x`,
      originalFilename: 'stmt.pdf',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects an ingest that carries a target (attach smuggled in)', () => {
    const parsed = ConfirmDocumentUploadPayloadSchema.safeParse({
      mode: 'ingest',
      documentId: uuid,
      entityId: uuid,
      kind: 'statement',
      storageBucket: 'statements',
      storagePath: `${uuid}/${uuid}/x`,
      originalFilename: 'stmt.pdf',
      accountId: uuid2,
      targetType: 'statement',
      targetId: uuid2,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects an ingest for a receipt (statements only)', () => {
    const parsed = UploadStatementPayloadSchema.safeParse({
      mode: 'ingest',
      documentId: uuid,
      entityId: uuid,
      kind: 'receipt',
      storageBucket: 'receipts',
      storagePath: `${uuid}/${uuid}/x`,
      originalFilename: 'r.png',
      accountId: uuid2,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects an unknown mode', () => {
    const parsed = ConfirmDocumentUploadPayloadSchema.safeParse({
      mode: 'sideways',
      documentId: uuid,
      entityId: uuid,
      kind: 'statement',
      storageBucket: 'statements',
      storagePath: `${uuid}/${uuid}/x`,
      originalFilename: 'stmt.pdf',
    });
    expect(parsed.success).toBe(false);
  });
});
