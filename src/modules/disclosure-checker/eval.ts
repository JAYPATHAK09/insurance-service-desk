/**
 * Fixture evaluation for the disclosure checker (synthetic mode, no network, no database).
 *
 * Classification accuracy = hits / (expected findings + unexpected findings):
 *   - an expected finding is a hit when an actual finding exists for the same member + question id (or same document-level
 *     type) with the same classification
 *   - every actual finding that matches no expected finding is a miss (false positive), so over-reporting lowers the score
 * Citation correctness = expected quotes that appear in the matching finding's evidence on the right page, verified against
 * the page text by the platform's verifier, and attached to the right document role.
 *
 * Run: `npx vitest run tests/disclosure-eval.test.ts` (writes the files) or `npx tsx src/modules/disclosure-checker/eval.ts`.
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Finding } from '@/lib/contracts';
import { SyntheticProvider, verifyCitations } from '@/lib/model';
import { disclosureChecker } from './index';
import { buildDocs, fixturesDir, loadFixtureCases } from './fixtures';
import { normName } from './parse';

export interface CaseEval {
  case: string;
  classification: { correct: number; total: number };
  citation: { correct: number; total: number };
  emittedCitations: { verified: number; total: number };
  problems: string[];
}
export interface EvalSummary {
  classification: { correct: number; total: number };
  citation: { correct: number; total: number };
  mode: 'synthetic';
  cases: CaseEval[];
}

const trimq = (s: string) => s.trim().replace(/\s+/g, ' ');

export async function runEval(root = fixturesDir()): Promise<EvalSummary> {
  const provider = new SyntheticProvider();
  const cases: CaseEval[] = [];
  for (const fc of await loadFixtureCases(root)) {
    const docs = buildDocs(fc);
    const raw = await disclosureChecker.run(fc.name, docs, provider);
    const actual: Finding[] = verifyCitations(raw, docs);
    const problems: string[] = [];
    const claimed = new Set<Finding>();
    let hit = 0;
    let cite = 0;
    let citeTotal = 0;
    const kindOf = (docId: string) => docs.find((d) => d.id === docId)?.kind;

    for (const e of fc.expected.findings) {
      const f = actual.find((a) => !claimed.has(a) && a.attributes?.member && normName(String(a.attributes.member)) === normName(e.member) && a.attributes.question_id === e.question_id);
      if (f) claimed.add(f);
      if (f && f.classification === e.classification) hit++;
      else problems.push(`${e.member} ${e.question_id}: expected ${e.classification}, got ${f?.classification ?? 'nothing'}`);
      for (const [q, role] of [[e.customer_quote, 'disclosure'], [e.proposal_quote, 'proposal']] as const) {
        if (!q) continue;
        citeTotal++;
        const ev = f?.evidence.find((x) => trimq(x.quote) === trimq(q) && kindOf(x.doc_id) === role);
        if (ev && ev.verified && ev.page === 1) cite++;
        else problems.push(`${e.member} ${e.question_id}: citation for ${role} missing or unverified`);
      }
    }
    for (const d of fc.expected.docFindings) {
      const f = actual.find((a) => !claimed.has(a) && a.type === d.type);
      if (f) claimed.add(f);
      if (f && f.classification === d.classification) hit++;
      else problems.push(`document-level ${d.type}: expected ${d.classification}, got ${f?.classification ?? 'nothing'}`);
    }
    const unexpected = actual.filter((a) => !claimed.has(a));
    for (const u of unexpected) problems.push(`unexpected finding ${u.type}/${u.classification}: ${String(u.attributes?.member ?? '')} ${String(u.attributes?.question_id ?? '')}`);
    const allEvidence = actual.flatMap((a) => a.evidence);
    cases.push({
      case: fc.name,
      classification: { correct: hit, total: fc.expected.findings.length + fc.expected.docFindings.length + unexpected.length },
      citation: { correct: cite, total: citeTotal },
      emittedCitations: { verified: allEvidence.filter((x) => x.verified).length, total: allEvidence.length },
      problems,
    });
  }
  const sum = (pick: (c: CaseEval) => { correct: number; total: number }) =>
    cases.reduce((a, c) => ({ correct: a.correct + pick(c).correct, total: a.total + pick(c).total }), { correct: 0, total: 0 });
  return { classification: sum((c) => c.classification), citation: sum((c) => c.citation), mode: 'synthetic', cases };
}

/** Writes eval-results.json in exactly the shape the dashboard reads, plus a separate details file. */
export async function writeEvalResults(root = fixturesDir()): Promise<EvalSummary> {
  const s = await runEval(root);
  const { classification, citation, mode } = s;
  await writeFile(path.join(root, 'eval-results.json'), JSON.stringify({ classification, citation, mode }, null, 2) + '\n');
  await writeFile(path.join(root, 'eval-details.json'), JSON.stringify(s, null, 2) + '\n');
  return s;
}

if (process.argv[1] && /disclosure-checker[\\/]eval\.ts$/.test(process.argv[1])) {
  writeEvalResults().then((s) => {
    console.log(JSON.stringify({ classification: s.classification, citation: s.citation }, null, 2));
    for (const c of s.cases) if (c.problems.length) console.log(c.case, c.problems);
  });
}
