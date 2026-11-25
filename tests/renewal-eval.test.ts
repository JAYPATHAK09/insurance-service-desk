import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runEval } from '@/modules/renewal-agent/eval';
import { fixturesRoot } from '@/modules/renewal-agent/fixtures';

describe('fixture evaluation', () => {
  it('measures classification accuracy and citation correctness and writes eval-results.json in the dashboard contract shape', async () => {
    const { results, details } = await runEval({ write: true });
    const written = JSON.parse(await fs.readFile(path.join(fixturesRoot(), 'eval-results.json'), 'utf8'));
    expect(Object.keys(written).sort()).toEqual(['citation', 'classification', 'mode']);
    expect(written).toEqual(results);
    expect(results.mode).toBe('synthetic');

    // 7 fixtures, 40 expected findings, 71 expected quotes. Totals are asserted so the fixtures cannot silently shrink.
    expect(results.classification.total).toBe(40);
    expect(results.citation.total).toBe(71);
    // Regression gate: these are the engine's own fixtures, so anything below 100% is a regression.
    expect(details.classification.wrong).toEqual([]);
    expect(details.classification.spurious).toBe(0);
    expect(results.classification.correct).toBe(results.classification.total);
    expect(details.citation.missing).toEqual([]);
    expect(results.citation.correct).toBe(results.citation.total);
    expect(details.citation.producedUnverified).toBe(0);
    // The one error that matters most: never a confirmed change where the fixtures say otherwise.
    expect(details.falseConfirmedChanges).toBe(0);
    expect(details.fieldChecks.values.correct).toBe(details.fieldChecks.values.total);
    expect(details.fieldChecks.pages.correct).toBe(details.fieldChecks.pages.total);
    expect(details.fieldChecks.materiality.correct).toBe(details.fieldChecks.materiality.total);
  });
});
