import { describe, expect, it } from 'vitest';
import { writeEvalResults } from '@/modules/disclosure-checker/eval';

describe('disclosure checker fixture evaluation', () => {
  it('classifies every fixture finding correctly with verified citations, and publishes the numbers', async () => {
    const s = await writeEvalResults();
    for (const c of s.cases) expect(c.problems, c.case).toEqual([]);
    expect(s.classification.total).toBeGreaterThan(15);
    expect(s.classification.correct).toBe(s.classification.total);
    expect(s.citation.correct).toBe(s.citation.total);
    expect(s.cases.every((c) => c.emittedCitations.verified === c.emittedCitations.total)).toBe(true);
  });
});
