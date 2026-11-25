import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { findings, reviews } from '@/db/schema';
import type { Finding } from '@/lib/contracts';
import { ingestDocument } from '@/lib/ingest';
import { SyntheticOcrAdapter } from '@/lib/ocr';
import { runReview, ReviewError } from '@/lib/review';
import { MemoryStorage } from '@/lib/storage';
import { claimReconciler } from '@/modules/claim-reconciler';
import { bytes, freshDb, makeCase, U } from './helpers';

afterEach(() => vi.restoreAllMocks());

describe('runReview', () => {
  it('versions reviews against exact hashes and mode, verifies citations, and is idempotent', async () => {
    const db = await freshDb();
    const c = await makeCase(U.handlerA.id);
    const { document } = await ingestDocument(db, { caseId: c.id, filename: 'a.txt', bytes: bytes('Discharge summary: copy, unsigned') }, { storage: new MemoryStorage(), ocr: new SyntheticOcrAdapter(async () => null) });
    const produced: Finding[] = [
      { key: 'good', type: 't', classification: 'partially_satisfied', summary: 's', evidence: [{ doc_id: document.id, page: 1, quote: 'Discharge summary: copy, unsigned', verified: false }] },
      { key: 'invented', type: 't', classification: 'satisfied_pending_verification', summary: 's', evidence: [{ doc_id: document.id, page: 1, quote: 'signed original attached', verified: false }] },
    ];
    const spy = vi.spyOn(claimReconciler, 'run').mockResolvedValue(produced);

    const first = await runReview(db, { caseId: c.id, actorId: U.handlerA.id });
    const second = await runReview(db, { caseId: c.id, actorId: U.handlerA.id });
    expect(first.state).toBe('ran');
    expect(second.state).toBe('replayed');
    expect(spy).toHaveBeenCalledTimes(1);

    const revs = await db.select().from(reviews).where(eq(reviews.caseId, c.id));
    expect(revs).toHaveLength(1);
    expect(revs[0]).toMatchObject({ version: 1, mode: 'synthetic', modelId: 'synthetic-v1', documentHashes: [document.sha256] });
    const fs = await db.select().from(findings).where(eq(findings.caseId, c.id));
    expect(fs).toHaveLength(2);
    expect(fs.find((f) => f.key === 'good')).toMatchObject({ classification: 'partially_satisfied' });
    expect(fs.find((f) => f.key === 'invented')).toMatchObject({ classification: 'ambiguous' });

    // A changed document set is a new, higher version.
    await ingestDocument(db, { caseId: c.id, filename: 'b.txt', bytes: bytes('Another page of evidence') }, { storage: new MemoryStorage(), ocr: new SyntheticOcrAdapter(async () => null) });
    await runReview(db, { caseId: c.id, actorId: U.handlerA.id });
    const after = await db.select().from(reviews).where(eq(reviews.caseId, c.id));
    expect(after.map((r) => r.version).sort()).toEqual([1, 2]);
  });

  it('refuses to review a case with no documents', async () => {
    const db = await freshDb();
    const c = await makeCase(U.handlerA.id);
    await expect(runReview(db, { caseId: c.id, actorId: U.handlerA.id })).rejects.toBeInstanceOf(ReviewError);
  });
});
