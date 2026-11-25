import fs from 'node:fs/promises';
import path from 'node:path';
import { SyntheticProvider } from '@/lib/model/providers';
import { normaliseForMatch, verifyCitations } from '@/lib/model/verify';
import type { Finding } from '@/lib/contracts';
import { renewalAgent } from './index';
import { fixturesRoot, listFixtureCases, loadFixtureDocuments } from './fixtures';

interface ExpectedFinding {
  key: string;
  classification: string;
  material: boolean;
  old: string | null;
  new: string | null;
  old_pages: string[];
  new_pages: string[];
  quotes: Array<[string, number, string]>;
}
interface Expected {
  case: string;
  pair: 'verified' | 'mismatched';
  findings: ExpectedFinding[];
}

export interface EvalResults {
  classification: { correct: number; total: number };
  citation: { correct: number; total: number };
  mode: 'synthetic';
}

export interface EvalDetails {
  generatedFrom: string;
  note: string;
  classification: { expected: number; spurious: number; wrong: Array<{ case: string; key: string; expected: string; got: string | null }> };
  citation: { expectedQuotes: number; correct: number; missing: Array<{ case: string; key: string; quote: string; reason: string }>; producedEvidence: number; producedUnverified: number };
  fieldChecks: { values: { correct: number; total: number }; pages: { correct: number; total: number }; materiality: { correct: number; total: number } };
  /** Confirmed changes asserted where expected says otherwise: the number that must stay at zero. */
  falseConfirmedChanges: number;
  perCase: Array<{ case: string; expected: number; correct: number; spurious: number }>;
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|');

export async function runEval(opts: { write?: boolean; root?: string } = {}): Promise<{ results: EvalResults; details: EvalDetails }> {
  const root = opts.root ?? fixturesRoot();
  const provider = new SyntheticProvider();
  const det: EvalDetails = {
    generatedFrom: 'fixtures/renewal-agent/*/expected.json, synthetic engine, citations checked with verifyCitations',
    note: 'Fixtures were authored alongside the rule-based engine, so these numbers measure regression and the engine on its own grammar, not accuracy on unseen real-world documents.',
    classification: { expected: 0, spurious: 0, wrong: [] },
    citation: { expectedQuotes: 0, correct: 0, missing: [], producedEvidence: 0, producedUnverified: 0 },
    fieldChecks: { values: { correct: 0, total: 0 }, pages: { correct: 0, total: 0 }, materiality: { correct: 0, total: 0 } },
    falseConfirmedChanges: 0,
    perCase: [],
  };
  let classCorrect = 0;

  for (const c of await listFixtureCases(root)) {
    const expected = JSON.parse(await fs.readFile(path.join(root, c.name, 'expected.json'), 'utf8')) as Expected;
    const docs = await loadFixtureDocuments(c, root);
    const raw = await renewalAgent.run(`fx-${c.name}`, docs, provider);
    const produced: Finding[] = verifyCitations(raw, docs);
    const byKey = new Map(produced.map((f) => [f.key, f]));
    const fileOf = (id: string) => docs.find((d) => d.id === id)?.filename ?? id;
    let correct = 0;

    for (const e of expected.findings) {
      det.classification.expected++;
      const f = byKey.get(e.key);
      if (f && f.classification === e.classification) {
        correct++;
        classCorrect++;
      } else {
        det.classification.wrong.push({ case: c.name, key: e.key, expected: e.classification, got: f?.classification ?? null });
        if (f?.classification === 'confirmed_change') det.falseConfirmedChanges++;
      }
      // Field-level checks: values, source pages, materiality.
      if (f) {
        const at = (f.attributes ?? {}) as { old?: { display?: string; sources?: Array<{ filename: string; page: number }> } | null; new?: typeof at.old; material?: boolean };
        const isTerm = e.key.startsWith('renewal:');
        if (isTerm) {
          det.fieldChecks.values.total++;
          if ((at.old?.display ?? null) === e.old && (at.new?.display ?? null) === e.new) det.fieldChecks.values.correct++;
          det.fieldChecks.pages.total++;
          const pg = (s?: { sources?: Array<{ filename: string; page: number }> } | null) => [...new Set((s?.sources ?? []).map((x) => `${x.filename}:${x.page}`))];
          if (sameSet(pg(at.old), e.old_pages) && sameSet(pg(at.new), e.new_pages)) det.fieldChecks.pages.correct++;
        }
        det.fieldChecks.materiality.total++;
        if (Boolean(at.material) === e.material) det.fieldChecks.materiality.correct++;
      } else {
        det.fieldChecks.materiality.total++;
      }
      // Citations: each expected quote must be present at the expected page and verified.
      for (const [file, page, quote] of e.quotes) {
        det.citation.expectedQuotes++;
        const hit = f?.evidence.find((x) => fileOf(x.doc_id) === file && x.page === page && normaliseForMatch(x.quote).includes(normaliseForMatch(quote))); // short lines are widened with neighbours, so containment
        if (hit?.verified) det.citation.correct++;
        else det.citation.missing.push({ case: c.name, key: e.key, quote, reason: !f ? 'finding missing' : !hit ? 'quote not cited at that page' : 'cited but not verified' });
      }
    }
    const expectedKeys = new Set(expected.findings.map((e) => e.key));
    const spurious = produced.filter((f) => !expectedKeys.has(f.key));
    det.classification.spurious += spurious.length;
    for (const s of spurious) if (s.classification === 'confirmed_change') det.falseConfirmedChanges++;
    for (const f of produced) {
      det.citation.producedEvidence += f.evidence.length;
      det.citation.producedUnverified += f.evidence.filter((x) => !x.verified).length;
    }
    det.perCase.push({ case: c.name, expected: expected.findings.length, correct, spurious: spurious.length });
  }

  const results: EvalResults = {
    classification: { correct: classCorrect, total: det.classification.expected + det.classification.spurious },
    citation: { correct: det.citation.correct, total: det.citation.expectedQuotes },
    mode: 'synthetic',
  };
  if (opts.write !== false) {
    await fs.writeFile(path.join(root, 'eval-results.json'), JSON.stringify(results, null, 2) + '\n');
    await fs.writeFile(path.join(root, 'eval-details.json'), JSON.stringify(det, null, 2) + '\n');
  }
  return { results, details: det };
}

if (process.argv[1] && /eval\.ts$/.test(process.argv[1])) {
  runEval().then(({ results, details }) => {
    console.log(JSON.stringify(results));
    console.log(JSON.stringify(details.perCase));
    if (details.classification.wrong.length) console.log('WRONG', JSON.stringify(details.classification.wrong, null, 1));
    if (details.citation.missing.length) console.log('CITATION MISSING', JSON.stringify(details.citation.missing, null, 1));
  });
}
