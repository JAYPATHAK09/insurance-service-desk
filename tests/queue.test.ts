import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { findings, reviews, users } from '@/db/schema';
import { seedIfEmpty, SEED_USERS } from '@/db/seed';
import { listQueue, computeAttention } from '@/lib/cases';
import { applyRetention, setRetentionDays } from '@/lib/retention';
import { resetDb } from '@/db/client';
import { documents } from '@/db/schema';
import { getDb } from '@/db/client';
import { ingestDocument } from '@/lib/ingest';
import { freshDb, makeCase, bytes, U } from './helpers';

describe('queue and attention', () => {
  it('seeds idempotently and sorts attention rows first; handlers see only their cases', async () => {
    const db = await getDb();
    await resetDb();
    expect(await seedIfEmpty(db)).toBe(true);
    expect(await seedIfEmpty(db)).toBe(false);
    const sup = (await db.select().from(users).where(eq(users.id, SEED_USERS.supervisor.id)))[0]!;
    const all = await listQueue(db, { id: sup.id, email: sup.email, name: sup.name, role: sup.role });
    expect(all.length).toBeGreaterThanOrEqual(7);
    // Module fixtures are seeded and every fixture case has a synthetic review.
    const fixtureRows = all.filter((r) => /FX-/.test(r.reference) || r.title.startsWith('Disclosure fixture'));
    expect(new Set(fixtureRows.map((r) => r.module))).toEqual(new Set(['claim-reconciler', 'disclosure-checker', 'renewal-agent']));
    const reviewed = new Set((await db.select({ id: reviews.caseId }).from(reviews)).map((r) => r.id));
    expect(fixtureRows.every((r) => reviewed.has(r.id))).toBe(true);
    expect((await db.select().from(findings)).length).toBeGreaterThan(10);
    const firstClean = all.findIndex((r) => r.attention.length === 0);
    expect(all.slice(0, firstClean).every((r) => r.attention.length > 0)).toBe(true);
    expect(all.slice(firstClean).every((r) => r.attention.length === 0)).toBe(true);
    const reasons = new Set(all.flatMap((r) => r.attention));
    expect(reasons).toEqual(new Set(['OCR failed', 'Overdue', 'Unresolved exceptions', 'Awaiting approval']));

    const mine = await listQueue(db, SEED_USERS.handler);
    expect(mine.every((r) => r.ownerId === SEED_USERS.handler.id)).toBe(true);
    expect(mine.length).toBeLessThan(all.length);
  });

  it('exported cases are never overdue', () => {
    const past = new Date(Date.now() - 86_400_000);
    expect(computeAttention({ status: 'exported', dueDate: past }, { openFindings: 0, ocrFailedDocs: 0 })).toEqual([]);
    expect(computeAttention({ status: 'intake', dueDate: past }, { openFindings: 0, ocrFailedDocs: 0 })).toEqual(['Overdue']);
  });
});

describe('retention', () => {
  it('deletes documents older than the configured days and audits it', async () => {
    const db = await freshDb();
    const c = await makeCase(U.handlerA.id);
    const { document } = await ingestDocument(db, { caseId: c.id, filename: 'a.txt', bytes: bytes('old document') });
    await setRetentionDays(db, 'documents', 30, U.supervisor.id);
    const early = await applyRetention(db, new Date(Date.now() + 10 * 86_400_000));
    expect(early.deleted).toBe(0);
    const late = await applyRetention(db, new Date(Date.now() + 31 * 86_400_000));
    expect(late).toMatchObject({ deleted: 1, days: 30 });
    expect(await db.select().from(documents).where(eq(documents.id, document.id))).toHaveLength(0);
    await expect(setRetentionDays(db, 'documents', 0, U.supervisor.id)).rejects.toThrow();
  });
});
