import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

/**
 * Fixture evaluation results: fixtures/<module>/eval-results.json, written by each module's evaluation test.
 * Shape (counts only, accuracy is computed here, never trusted from the file):
 *   { "classification": { "correct": 0, "total": 0 }, "citation": { "correct": 0, "total": 0 }, "mode"?: "synthetic" }
 */
const Ratio = z.object({ correct: z.number().int().min(0), total: z.number().int().min(0) }).refine((r) => r.correct <= r.total, 'correct > total');
const EvalFile = z.object({ classification: Ratio, citation: Ratio, mode: z.string().max(40).optional() });

export interface RatioResult {
  correct: number;
  total: number;
  accuracy: number | null;
}
export type EvalEntry =
  | { module: string; ok: true; classification: RatioResult; citation: RatioResult; mode?: string }
  | { module: string; ok: false; error: string };

const toRatio = (r: { correct: number; total: number }): RatioResult => ({ ...r, accuracy: r.total > 0 ? r.correct / r.total : null });
const MAX_BYTES = 256 * 1024;

export async function readEvalResults(fixturesDir = path.join(process.cwd(), 'fixtures')): Promise<EvalEntry[]> {
  let dirs: string[];
  try {
    dirs = (await readdir(fixturesDir, { withFileTypes: true })).filter((d) => d.isDirectory() && /^[a-z0-9-]+$/.test(d.name)).map((d) => d.name);
  } catch {
    return [];
  }
  const out: EvalEntry[] = [];
  for (const module of dirs.sort()) {
    const file = path.join(fixturesDir, module, 'eval-results.json');
    try {
      if ((await stat(file)).size > MAX_BYTES) {
        out.push({ module, ok: false, error: 'eval-results.json is too large' });
        continue;
      }
    } catch {
      continue; // no results published for this folder
    }
    try {
      const parsed = EvalFile.safeParse(JSON.parse(await readFile(file, 'utf8')));
      if (!parsed.success) out.push({ module, ok: false, error: 'eval-results.json does not match the expected shape' });
      else
        out.push({
          module,
          ok: true,
          classification: toRatio(parsed.data.classification),
          citation: toRatio(parsed.data.citation),
          mode: parsed.data.mode,
        });
    } catch {
      out.push({ module, ok: false, error: 'eval-results.json is not valid JSON' });
    }
  }
  return out;
}
