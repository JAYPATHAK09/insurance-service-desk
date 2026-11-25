import fs from 'node:fs/promises';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { cases } from '@/db/schema';
import { SEED_USERS } from '@/db/seed';
import type { DocumentRecord } from '@/lib/contracts';
import { extractPages, ingestDocument } from '@/lib/ingest';
import { SyntheticOcrAdapter } from '@/lib/ocr';
import { makeTextPdf } from '@/lib/pdf-fixture';
import { refreshAttention } from '@/lib/cases';
import { audit } from '@/lib/audit';

export { FIXTURE_REF_PREFIX } from './types';

export interface FixtureDocSpec {
  file: string;
  kind: string;
  /** Build a PDF from the text pages; an empty page has no text layer, so it is unreadable (OCR fails). */
  pdf?: boolean;
}
export interface FixtureCase {
  name: string;
  reference: string;
  insurer: string;
  title: string;
  documents: FixtureDocSpec[];
}

export const fixturesRoot = () => path.join(process.env.FIXTURES_DIR ?? path.join(process.cwd(), 'fixtures'), 'renewal-agent');

export async function listFixtureCases(root = fixturesRoot()): Promise<FixtureCase[]> {
  const out: FixtureCase[] = [];
  for (const e of await fs.readdir(root, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    try {
      out.push(JSON.parse(await fs.readFile(path.join(root, e.name, 'case.json'), 'utf8')) as FixtureCase);
    } catch {
      /* not a fixture directory */
    }
  }
  return out.sort((a, b) => a.reference.localeCompare(b.reference));
}

/** The bytes and filename a fixture document is uploaded as (PDFs are generated, never committed). */
export async function fixtureBytes(root: string, c: FixtureCase, d: FixtureDocSpec): Promise<{ filename: string; bytes: Uint8Array }> {
  const raw = await fs.readFile(path.join(root, c.name, d.file));
  if (!d.pdf) return { filename: d.file, bytes: new Uint8Array(raw) };
  const pages = raw.toString('utf8').split('\f').map((p) => p.trim());
  return { filename: d.file.replace(/\.txt$/, '.pdf'), bytes: makeTextPdf(pages) };
}

/** Documents as the platform would hold them, without a database (used by the evaluation). */
export async function loadFixtureDocuments(c: FixtureCase, root = fixturesRoot()): Promise<DocumentRecord[]> {
  const docs: DocumentRecord[] = [];
  for (const d of c.documents) {
    const { filename, bytes } = await fixtureBytes(root, c, d);
    const ext = filename.split('.').pop()!;
    const pages = await extractPages(bytes, filename, ext, new SyntheticOcrAdapter(async () => null));
    docs.push({
      id: `fx-${c.name}-${d.file.replace(/\.[a-z]+$/, '')}`,
      caseId: `fx-${c.name}`,
      sha256: `fx-${c.name}-${d.file}`,
      filename,
      mime: ext === 'pdf' ? 'application/pdf' : 'text/plain',
      kind: d.kind,
      pages,
      storageKey: '',
    });
  }
  return docs;
}

/**
 * Seed the renewal fixture cases (idempotent: cases are keyed by module+insurer+reference, documents by hash).
 * Fixture cases carry the REN-FX- reference prefix, which is what marks their KPI events as source=fixture.
 * Run a review on each afterwards with runReview if findings are wanted (see `runReviews`).
 */
export async function seedRenewalFixtures(
  db: Db,
  opts: { ownerId?: string; uploadedBy?: string; root?: string; ocr?: SyntheticOcrAdapter } = {},
): Promise<Array<{ name: string; caseId: string; reference: string; documents: number }>> {
  const root = opts.root ?? fixturesRoot();
  const owner = opts.ownerId ?? SEED_USERS.handler.id;
  const uploader = opts.uploadedBy ?? owner;
  const out: Array<{ name: string; caseId: string; reference: string; documents: number }> = [];
  for (const c of await listFixtureCases(root)) {
    const [inserted] = await db
      .insert(cases)
      .values({
        module: 'renewal-agent',
        insurer: c.insurer,
        reference: c.reference,
        title: c.title,
        ownerId: owner,
        status: 'evidence_review',
        dueDate: new Date(Date.now() + 10 * 86_400_000),
      })
      .onConflictDoNothing()
      .returning({ id: cases.id });
    const caseId =
      inserted?.id ??
      (await db.select({ id: cases.id }).from(cases).where(and(eq(cases.module, 'renewal-agent'), eq(cases.insurer, c.insurer), eq(cases.reference, c.reference))))[0]!.id;
    if (inserted) await audit(db, { actorId: uploader, action: 'case.seeded', caseId, entity: 'case', entityId: caseId, meta: { reference: c.reference } });
    for (const d of c.documents) {
      const { filename, bytes } = await fixtureBytes(root, c, d);
      await ingestDocument(db, { caseId, filename, bytes, kind: d.kind, uploadedBy: uploader }, opts.ocr ? { ocr: opts.ocr } : {});
    }
    await refreshAttention(db, caseId);
    out.push({ name: c.name, caseId, reference: c.reference, documents: c.documents.length });
  }
  return out;
}
