import fs from 'node:fs/promises';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '@/db/client';
import { cases } from '@/db/schema';
import { audit } from '@/lib/audit';
import { refreshAttention } from '@/lib/cases';
import { ingestDocument, type IngestDeps } from '@/lib/ingest';
import { makeTextPdf } from '@/lib/pdf-fixture';

/** Fixture cases are recognised by this reference prefix; their KPI events are always source=fixture. */
export const FIXTURE_REF_PREFIX = 'FX-CLM-';

const Expected = z.object({
  item: z.number().int().min(1),
  classification: z.string(),
  reason: z.string().optional(),
  quote: z.string().optional(),
});
const FixtureCase = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  reference: z.string(),
  insurer: z.string(),
  title: z.string(),
  files: z.array(
    z.object({
      name: z.string().regex(/^[A-Za-z0-9._-]+$/),
      kind: z.string(),
      generate: z.literal('blank-pdf').optional(),
    }),
  ),
  expected: z.array(Expected),
});
const Manifest = z.object({ cases: z.array(FixtureCase) });
export type FixtureCaseDef = z.infer<typeof FixtureCase>;
export type ExpectedItem = z.infer<typeof Expected>;

export const fixturesRoot = () => path.join(process.env.FIXTURES_DIR ?? path.join(process.cwd(), 'fixtures'), 'claim-reconciler');

export async function loadManifest(root = fixturesRoot()): Promise<FixtureCaseDef[]> {
  const raw = await fs.readFile(path.join(root, 'expected.json'), 'utf8');
  return Manifest.parse(JSON.parse(raw)).cases;
}

export interface FixtureFile {
  filename: string;
  kind: string;
  bytes: Uint8Array;
}

/** A scan with no text layer. A trailing PDF comment makes each file's hash unique within a case. */
const blankPdf = (name: string) => {
  const base = makeTextPdf(['']);
  const tail = new TextEncoder().encode(`% fixture scan: ${name}\n`);
  const out = new Uint8Array(base.length + tail.length);
  out.set(base);
  out.set(tail, base.length);
  return out;
};

/** Bytes of every file in a fixture case. A blank-pdf is a PDF with no text layer (a scan). */
export async function loadCaseFiles(c: FixtureCaseDef, root = fixturesRoot()): Promise<FixtureFile[]> {
  const out: FixtureFile[] = [];
  for (const f of c.files) {
    const bytes = f.generate === 'blank-pdf' ? blankPdf(f.name) : new Uint8Array(await fs.readFile(path.join(root, c.id, f.name)));
    out.push({ filename: f.name, kind: f.kind, bytes });
  }
  return out;
}

export interface SeedOptions {
  /** Existing user id that will own the cases (e.g. the seeded handler). */
  ownerId: string;
  uploadedBy?: string;
  root?: string;
  deps?: IngestDeps;
}

/**
 * Load the claim-reconciler fixtures as fictional cases with their documents. Idempotent: cases are
 * keyed by (module, insurer, reference) and documents by (case, sha256), so re-running adds nothing.
 * Does NOT run a review; the handler (or the lead's seed) triggers that.
 */
export async function seedClaimFixtures(db: Db, opts: SeedOptions): Promise<Array<{ reference: string; caseId: string; created: boolean }>> {
  const root = opts.root ?? fixturesRoot();
  const out: Array<{ reference: string; caseId: string; created: boolean }> = [];
  let n = 0;
  for (const c of await loadManifest(root)) {
    n++;
    const [row] = await db
      .insert(cases)
      .values({
        module: 'claim-reconciler',
        insurer: c.insurer,
        reference: c.reference,
        title: c.title,
        ownerId: opts.ownerId,
        status: 'evidence_review',
        dueDate: new Date(Date.now() + (n + 1) * 86_400_000),
      })
      .onConflictDoNothing()
      .returning({ id: cases.id });
    const caseId =
      row?.id ??
      (await db.select({ id: cases.id }).from(cases).where(and(eq(cases.module, 'claim-reconciler'), eq(cases.insurer, c.insurer), eq(cases.reference, c.reference))))[0]!.id;
    for (const f of await loadCaseFiles(c, root)) {
      await ingestDocument(db, { caseId, filename: f.filename, bytes: f.bytes, kind: f.kind, uploadedBy: opts.uploadedBy ?? opts.ownerId }, opts.deps);
    }
    if (row) await audit(db, { actorId: opts.uploadedBy ?? opts.ownerId, action: 'case.seeded', caseId, entity: 'case', entityId: caseId, meta: { reference: c.reference, fixture: true } });
    await refreshAttention(db, caseId);
    out.push({ reference: c.reference, caseId, created: Boolean(row) });
  }
  return out;
}
