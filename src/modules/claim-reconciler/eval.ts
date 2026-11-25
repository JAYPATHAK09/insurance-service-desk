/**
 * Fixture evaluation. Runs the real engine path (claimReconciler.run -> SyntheticProvider ->
 * runModelTask) over every fixture case, then verifyCitations, and COMPUTES:
 *  - classification accuracy: expected.json classification vs produced, per requested item;
 *  - citation correctness: per expected quote, a produced finding for that item cites it on a page
 *    where it really appears (verified). Counts are never hard-coded.
 * Writes fixtures/claim-reconciler/eval-results.json as {classification, citation, mode}.
 * Run: npx tsx src/modules/claim-reconciler/eval.ts
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { DocumentRecord, Finding } from '@/lib/contracts';
import { extractPages, sha256Hex } from '@/lib/ingest';
import { SyntheticProvider } from '@/lib/model/providers';
import { verifyCitations, normaliseForMatch } from '@/lib/model/verify';
import { SyntheticOcrAdapter } from '@/lib/ocr';
import { claimReconciler } from './index';
import { fixturesRoot, loadCaseFiles, loadManifest, type FixtureCaseDef } from './fixtures';

export interface EvalRow {
  caseId: string;
  item: number;
  expected: string;
  actual: string | null;
  classificationOk: boolean;
  quote?: string;
  citationOk?: boolean;
}

/** Build the case's DocumentRecords in memory (no database), exactly as ingestion would. */
export async function buildDocs(c: FixtureCaseDef, root: string): Promise<DocumentRecord[]> {
  const ocr = new SyntheticOcrAdapter(async (filename) => {
    try {
      return await fs.readFile(path.join(root, c.id, `${filename}.ocr.txt`), 'utf8');
    } catch {
      return null;
    }
  });
  const docs: DocumentRecord[] = [];
  for (const f of await loadCaseFiles(c, root)) {
    const ext = f.filename.split('.').pop()!.toLowerCase();
    docs.push({
      id: `${c.id}:${f.filename}`,
      caseId: c.id,
      sha256: sha256Hex(f.bytes),
      filename: f.filename,
      mime: ext,
      kind: f.kind,
      pages: await extractPages(f.bytes, f.filename, ext, ocr),
      storageKey: `eval/${c.id}/${f.filename}`,
    });
  }
  return docs;
}

export async function runCase(c: FixtureCaseDef, root: string): Promise<{ docs: DocumentRecord[]; findings: Finding[] }> {
  const docs = await buildDocs(c, root);
  const raw = await claimReconciler.run(c.id, docs, new SyntheticProvider());
  return { docs, findings: verifyCitations(raw, docs) };
}

export const itemNo = (f: Finding) => Number((f.attributes as { item_no?: unknown } | undefined)?.item_no);

export async function runEval(opts: { root?: string; write?: boolean } = {}) {
  const root = opts.root ?? fixturesRoot();
  const rows: EvalRow[] = [];
  for (const c of await loadManifest(root)) {
    const { findings } = await runCase(c, root);
    for (const e of c.expected) {
      const f = findings.find((x) => itemNo(x) === e.item);
      const row: EvalRow = {
        caseId: c.id,
        item: e.item,
        expected: e.classification,
        actual: f?.classification ?? null,
        classificationOk: f?.classification === e.classification,
      };
      if (e.quote) {
        const want = normaliseForMatch(e.quote);
        row.quote = e.quote;
        row.citationOk = Boolean(f?.evidence.some((ev) => ev.verified && normaliseForMatch(ev.quote) === want));
      }
      rows.push(row);
    }
  }
  const cited = rows.filter((r) => r.quote !== undefined);
  const result = {
    classification: { correct: rows.filter((r) => r.classificationOk).length, total: rows.length },
    citation: { correct: cited.filter((r) => r.citationOk).length, total: cited.length },
    mode: 'synthetic' as const,
  };
  if (opts.write !== false) {
    await fs.writeFile(path.join(root, 'eval-results.json'), JSON.stringify(result, null, 2) + '\n');
  }
  return { result, rows };
}

if (process.argv[1] && /claim-reconciler[\\/]eval\.ts$/.test(process.argv[1])) {
  runEval().then(({ result, rows }) => {
    for (const r of rows.filter((x) => !x.classificationOk || x.citationOk === false)) console.log('MISS', JSON.stringify(r));
    console.log(JSON.stringify(result));
  });
}
