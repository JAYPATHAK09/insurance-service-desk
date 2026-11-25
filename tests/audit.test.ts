import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { auditLog } from '@/db/schema';
import { audit } from '@/lib/audit';
import { ingestDocument } from '@/lib/ingest';
import { SyntheticOcrAdapter } from '@/lib/ocr';
import { sanitizeRecord } from '@/lib/sanitize';
import { MemoryStorage } from '@/lib/storage';
import { bytes, freshDb, makeCase, U } from './helpers';

const SECRET = 'PATIENT-JOHN-DOE-DIAGNOSIS-XYZ';

describe('audit log has no document contents', () => {
  it('drops denylisted keys and long free text', () => {
    const out = sanitizeRecord({ text: SECRET, quote: SECRET, nested: { pages: [SECRET] }, note: SECRET.repeat(10), ok: 'enum_value', n: 3 });
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(out).toMatchObject({ ok: 'enum_value', n: 3 });
  });

  it('uploading a document audits hashes and counts only', async () => {
    const db = await freshDb();
    const c = await makeCase(U.handlerA.id);
    await ingestDocument(db, { caseId: c.id, filename: 'letter.txt', bytes: bytes(`Diagnosis: ${SECRET}`), uploadedBy: U.handlerA.id }, { storage: new MemoryStorage(), ocr: new SyntheticOcrAdapter(async () => null) });
    await audit(db, { caseId: c.id, action: 'x', meta: { text: `Diagnosis: ${SECRET}`, excerpt: SECRET } });
    const rows = await db.select().from(auditLog).where(eq(auditLog.caseId, c.id));
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(rows)).not.toContain(SECRET);
    expect(rows.find((r) => r.action === 'document.uploaded')!.meta).toMatchObject({ pageCount: 1, kind: 'other' });
  });
});
