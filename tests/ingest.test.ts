import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { documents } from '@/db/schema';
import { IngestError, ingestDocument } from '@/lib/ingest';
import { SyntheticOcrAdapter } from '@/lib/ocr';
import { makeTextPdf } from '@/lib/pdf-fixture';
import { MemoryStorage } from '@/lib/storage';
import { bytes, freshDb, makeCase, U } from './helpers';

const deps = () => ({ storage: new MemoryStorage(), ocr: new SyntheticOcrAdapter(async () => null) });

describe('ingest', () => {
  beforeEach(async () => {
    await freshDb();
  });

  it('dedupes by sha256 within a case: re-upload creates no second row', async () => {
    const db = await freshDb();
    const c = await makeCase(U.handlerA.id);
    const d = deps();
    const first = await ingestDocument(db, { caseId: c.id, filename: 'a.txt', bytes: bytes('same bytes'), uploadedBy: U.handlerA.id }, d);
    const again = await ingestDocument(db, { caseId: c.id, filename: 'renamed.txt', bytes: bytes('same bytes') }, d);
    expect(first.duplicate).toBe(false);
    expect(again.duplicate).toBe(true);
    expect(again.document.id).toBe(first.document.id);
    expect(await db.select().from(documents).where(eq(documents.caseId, c.id))).toHaveLength(1);
  });

  it('the same bytes may exist in different cases', async () => {
    const db = await freshDb();
    const c1 = await makeCase(U.handlerA.id);
    const c2 = await makeCase(U.handlerA.id);
    const d = deps();
    await ingestDocument(db, { caseId: c1.id, filename: 'a.txt', bytes: bytes('x1') }, d);
    const r = await ingestDocument(db, { caseId: c2.id, filename: 'a.txt', bytes: bytes('x1') }, d);
    expect(r.duplicate).toBe(false);
  });

  it('concurrent identical uploads still produce a single document', async () => {
    const db = await freshDb();
    const c = await makeCase(U.handlerA.id);
    const d = deps();
    await Promise.all([1, 2, 3].map(() => ingestDocument(db, { caseId: c.id, filename: 'a.txt', bytes: bytes('race') }, d)));
    expect(await db.select().from(documents).where(eq(documents.caseId, c.id))).toHaveLength(1);
  });

  it('extracts per-page text from a PDF and keeps page numbers', async () => {
    const db = await freshDb();
    const c = await makeCase(U.handlerA.id);
    const pdf = makeTextPdf(['Page one has the discharge summary text', 'Page two has the itemised bill text']);
    const { document } = await ingestDocument(db, { caseId: c.id, filename: 'two.pdf', bytes: pdf }, deps());
    expect(document.pages.map((p) => p.page)).toEqual([1, 2]);
    expect(document.pages[0]!.text).toContain('discharge summary');
    expect(document.pages[1]!.text).toContain('itemised bill');
    expect(document.pages.every((p) => p.ocr_status === 'not_needed')).toBe(true);
  });

  it('uses the OCR sidecar for a scanned page, and marks unreadable files as failed', async () => {
    const db = await freshDb();
    const c = await makeCase(U.handlerA.id);
    const ocr = new SyntheticOcrAdapter(async (f) => (f === 'scan.pdf' ? 'Recovered text from the scan' : null));
    const ok = await ingestDocument(db, { caseId: c.id, filename: 'scan.pdf', bytes: makeTextPdf(['']) }, { ...deps(), ocr });
    expect(ok.document.pages[0]).toMatchObject({ ocr_status: 'ok', text: 'Recovered text from the scan' });
    const bad = await ingestDocument(db, { caseId: c.id, filename: 'unreadable.pdf', bytes: makeTextPdf(['', '']) }, { ...deps(), ocr });
    expect(bad.document.pages.every((p) => p.ocr_status === 'failed' && p.text === '')).toBe(true);
  });

  it('rejects unsupported types, fake PDFs and empty files', async () => {
    const db = await freshDb();
    const c = await makeCase(U.handlerA.id);
    const d = deps();
    await expect(ingestDocument(db, { caseId: c.id, filename: 'x.exe', bytes: bytes('MZ') }, d)).rejects.toBeInstanceOf(IngestError);
    await expect(ingestDocument(db, { caseId: c.id, filename: 'x.pdf', bytes: bytes('not a pdf') }, d)).rejects.toBeInstanceOf(IngestError);
    await expect(ingestDocument(db, { caseId: c.id, filename: 'x.txt', bytes: new Uint8Array() }, d)).rejects.toBeInstanceOf(IngestError);
  });
});
