import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '@/db/client';
import { cases } from '@/db/schema';
import type { DocumentRecord, PageText } from '@/lib/contracts';
import { ingestDocument } from '@/lib/ingest';
import { SyntheticOcrAdapter } from '@/lib/ocr';
import { makeTextPdf } from '@/lib/pdf-fixture';
import { runReview } from '@/lib/review';
import type { ObjectStorage } from '@/lib/storage';

const ExpectedFinding = z.object({
  member: z.string(),
  question_id: z.string(),
  classification: z.string(),
  customer_quote: z.string().optional(),
  proposal_quote: z.string().optional(),
});
export const ExpectedSchema = z.object({
  case: z.string(),
  description: z.string(),
  insurer: z.string(),
  reference: z.string(),
  files: z.array(z.object({ file: z.string(), kind: z.enum(['disclosure', 'proposal']), scan: z.enum(['sidecar', 'failed']).optional() })),
  findings: z.array(ExpectedFinding),
  docFindings: z.array(z.object({ type: z.string(), classification: z.string() })),
  matched: z.number().int(),
});
export type FixtureExpected = z.infer<typeof ExpectedSchema>;

export interface FixtureFile {
  file: string;
  kind: 'disclosure' | 'proposal';
  scan?: 'sidecar' | 'failed';
  /** Text content (txt) or OCR sidecar text (scan: sidecar). Empty for failed scans. */
  text: string;
}
export interface FixtureCase {
  name: string;
  dir: string;
  expected: FixtureExpected;
  files: FixtureFile[];
}

export const fixturesDir = () => path.join(process.env.FIXTURES_DIR ?? path.join(process.cwd(), 'fixtures'), 'disclosure-checker');

export async function loadFixtureCases(root = fixturesDir()): Promise<FixtureCase[]> {
  const entries = (await readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  const out: FixtureCase[] = [];
  for (const name of entries) {
    const dir = path.join(root, name);
    const expected = ExpectedSchema.parse(JSON.parse(await readFile(path.join(dir, 'expected.json'), 'utf8')));
    const files: FixtureFile[] = [];
    for (const f of expected.files) {
      let text = '';
      if (f.scan === 'sidecar') text = await readFile(path.join(dir, `${f.file}.ocr.txt`), 'utf8');
      else if (!f.scan) text = await readFile(path.join(dir, f.file), 'utf8');
      files.push({ ...f, text });
    }
    out.push({ name, dir, expected, files });
  }
  return out;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * In-memory DocumentRecords, as ingestion would produce them (used by the evaluation, no database).
 * Byte-identical files collapse to one document, like the (case, sha256) unique constraint does.
 */
export function buildDocs(fc: FixtureCase): DocumentRecord[] {
  const seen = new Set<string>();
  const docs: DocumentRecord[] = [];
  for (const f of fc.files) {
    const hash = sha(f.scan === 'failed' ? `failed:${f.file}` : f.text);
    if (seen.has(hash)) continue;
    seen.add(hash);
    const pages: PageText[] =
      f.scan === 'failed'
        ? [{ page: 1, text: '', ocr_status: 'failed' }]
        : f.text.split('\f').map((t, i) => ({ page: i + 1, text: t.trim(), ocr_status: f.scan === 'sidecar' ? ('ok' as const) : ('not_needed' as const) }));
    docs.push({ id: `${fc.name}:${f.file}`, caseId: fc.name, sha256: hash, filename: f.file, mime: f.scan ? 'application/pdf' : 'text/plain', kind: f.kind, pages, storageKey: `fixture/${fc.name}/${f.file}` });
  }
  return docs;
}

export interface SeedOptions {
  /** Existing user id that will own the cases (FK to users). */
  ownerId: string;
  /** Run the (synthetic) review right after upload. Default true. */
  runReviews?: boolean;
  dir?: string;
  storage?: ObjectStorage;
}

/**
 * Seed one disclosure-checker case per fixture folder through the normal upload path. Idempotent:
 * existing cases (module + insurer + reference) are reused and documents/reviews dedupe by hash.
 * Not wired into src/db/seed.ts (core file): call it from there or from a script.
 */
export async function seedDisclosureFixtures(db: Db, opts: SeedOptions): Promise<Array<{ name: string; caseId: string; duplicatesSkipped: number }>> {
  const root = opts.dir ?? fixturesDir();
  const out: Array<{ name: string; caseId: string; duplicatesSkipped: number }> = [];
  for (const fc of await loadFixtureCases(root)) {
    const e = fc.expected;
    const [existing] = await db
      .select()
      .from(cases)
      .where(and(eq(cases.module, 'disclosure-checker'), eq(cases.insurer, e.insurer), eq(cases.reference, e.reference)));
    const caseId =
      existing?.id ??
      (
        await db
          .insert(cases)
          .values({
            module: 'disclosure-checker',
            insurer: e.insurer,
            reference: e.reference,
            title: `Disclosure fixture (${fc.name}): ${e.description}`.slice(0, 200),
            ownerId: opts.ownerId,
            status: 'evidence_review',
            dueDate: new Date(Date.now() + 7 * 86_400_000),
          })
          .returning({ id: cases.id })
      )[0]!.id;

    let duplicatesSkipped = 0;
    for (const f of fc.files) {
      const enc = new TextEncoder();
      const bytes = f.scan ? makeTextPdf(['']) : enc.encode(f.text);
      const ocr = new SyntheticOcrAdapter(async () => (f.scan === 'sidecar' ? f.text : null));
      const r = await ingestDocument(db, { caseId, filename: f.file, bytes, kind: f.kind, uploadedBy: opts.ownerId }, { ocr, storage: opts.storage });
      if (r.duplicate) duplicatesSkipped++;
    }
    if (opts.runReviews !== false) await runReview(db, { caseId, actorId: opts.ownerId });
    out.push({ name: fc.name, caseId, duplicatesSkipped });
  }
  return out;
}
