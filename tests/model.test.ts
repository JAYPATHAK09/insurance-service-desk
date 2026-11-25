import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLASSIFICATIONS, type DocumentRecord, type Finding } from '@/lib/contracts';
import {
  ModelOutputError,
  SYSTEM_GUARD,
  SyntheticProvider,
  buildPrompt,
  getProvider,
  registerSyntheticHandler,
  runModelTask,
  validateModelOutput,
  verifyCitations,
} from '@/lib/model';

const doc: DocumentRecord = {
  id: 'd1', caseId: 'c1', sha256: 'h', filename: 'f.txt', mime: 'text/plain', kind: 'other', storageKey: 'k',
  pages: [
    { page: 1, text: 'Discharge summary:   copy,\n unsigned, received 02-Mar', ocr_status: 'not_needed' },
    { page: 2, text: 'unreadable', ocr_status: 'failed' },
  ],
};
const base = (over: Partial<Finding>): Finding => ({
  key: 'k', type: 'requested_item', classification: 'satisfied_pending_verification', summary: 's', evidence: [], ...over,
});

describe('verifyCitations', () => {
  it('verifies a quote across whitespace differences on the cited page', () => {
    const [f] = verifyCitations(
      [base({
        attributes: { item_text: 'Discharge summary' },
        evidence: [{ doc_id: 'd1', page: 1, quote: 'Discharge summary: copy, unsigned', verified: false }],
      })],
      [doc],
    );
    expect(f!.evidence[0]!.verified).toBe(true);
    expect(f!.classification).toBe('satisfied_pending_verification');
  });

  describe('minimum quote length (M2)', () => {
    const long: DocumentRecord = {
      ...doc,
      pages: [{ page: 1, text: 'Bill no. HB-6001 dated 06-Mar-2025. Total payable Rs 42,000. Signed by the billing officer.', ocr_status: 'not_needed' }],
    };
    const ev = (quote: string) => [{ doc_id: 'd1', page: 1, quote, verified: false }];

    it('a short quote cannot carry a positive finding on its own, even though it is on the page', () => {
      const [f] = verifyCitations([base({ classification: 'partially_satisfied', evidence: ev('Signed') })], [long]);
      expect(f!.classification).toBe('ambiguous');
      expect(f!.attributes).toMatchObject({ downgradedFrom: 'partially_satisfied', downgradeReason: 'quote_too_short' });
    });

    it('19 characters fail and 20 pass; whitespace is normalised before counting', () => {
      const q20 = 'Total payable Rs 42,'; // 20 chars
      expect(q20).toHaveLength(20);
      const [short] = verifyCitations([base({ classification: 'partially_satisfied', evidence: ev(q20.slice(0, 19)) })], [long]);
      const [ok] = verifyCitations([base({ classification: 'partially_satisfied', evidence: ev(q20) })], [long]);
      const [spaced] = verifyCitations([base({ classification: 'partially_satisfied', evidence: ev('Total   payable\n Rs  42,') })], [long]);
      expect(short!.classification).toBe('ambiguous');
      expect(ok!.classification).toBe('partially_satisfied');
      expect(spaced!.classification).toBe('partially_satisfied');
    });

    it('a short quote is accepted when the whole page is shorter than the minimum', () => {
      const tiny: DocumentRecord = { ...doc, pages: [{ page: 1, text: 'Status: signed', ocr_status: 'not_needed' }] };
      const [f] = verifyCitations([base({ classification: 'partially_satisfied', evidence: ev('Status: signed') })], [tiny]);
      expect(f!.classification).toBe('partially_satisfied');
    });

    it('short context lines are fine next to a substantial quote; absence findings may cite short context', () => {
      const [f] = verifyCitations([base({ classification: 'partially_satisfied', evidence: [...ev('Total payable Rs 42,000.'), ...ev('Signed')] })], [long]);
      expect(f!.classification).toBe('partially_satisfied');
      const [m] = verifyCitations([base({ classification: 'missing', evidence: ev('Signed') })], [long]);
      expect(m!.classification).toBe('missing');
    });
  });

  describe('satisfied_pending_verification must cite the item or a document reference', () => {
    const page: DocumentRecord = {
      ...doc,
      pages: [{ page: 1, text: 'Hospital copy of the discharge summary is attached to this file for review purposes.', ocr_status: 'not_needed' }],
    };
    const ev = (quote: string) => [{ doc_id: 'd1', page: 1, quote, verified: false }];

    it('downgrades a long but unrelated quote', () => {
      const [f] = verifyCitations([base({ attributes: { item_text: 'Itemised hospital bill' }, evidence: ev('is attached to this file for review purposes') })], [page]);
      expect(f!.classification).toBe('ambiguous');
      expect(f!.attributes).toMatchObject({ downgradeReason: 'quote_not_tied_to_item' });
    });

    it('accepts a quote containing the item text', () => {
      const [f] = verifyCitations([base({ attributes: { item_text: 'discharge summary' }, evidence: ev('copy of the discharge summary is attached') })], [page]);
      expect(f!.classification).toBe('satisfied_pending_verification');
    });

    it('accepts a quote containing a document reference', () => {
      const refDoc: DocumentRecord = { ...doc, pages: [{ page: 1, text: 'Hospital bill HB-6001 was submitted under SUB-90001 on 06-Mar-2025.', ocr_status: 'not_needed' }] };
      const [f] = verifyCitations([base({ evidence: [{ doc_id: 'd1', page: 1, quote: 'Hospital bill HB-6001 was submitted', verified: false }] })], [refDoc]);
      expect(f!.classification).toBe('satisfied_pending_verification');
    });
  });

  it('downgrades to ambiguous when the quote is not on the cited page (wrong page, invented, failed OCR, unknown doc)', () => {
    const cases: Finding['evidence'] = [
      { doc_id: 'd1', page: 2, quote: 'Discharge summary: copy', verified: false },
      { doc_id: 'd1', page: 1, quote: 'Signed original attached', verified: false },
      { doc_id: 'd1', page: 2, quote: 'unreadable', verified: false },
      { doc_id: 'zz', page: 1, quote: 'Discharge summary', verified: false },
    ];
    for (const e of cases) {
      const [f] = verifyCitations([base({ evidence: [e] })], [doc]);
      expect(f!.classification).toBe('ambiguous');
      expect(f!.evidence[0]!.verified).toBe(false);
      expect(f!.attributes).toMatchObject({ downgradedFrom: 'satisfied_pending_verification', downgradeReason: 'citation_unverified' });
    }
  });

  it('downgrades if any one of several citations fails', () => {
    const [f] = verifyCitations(
      [base({ evidence: [
        { doc_id: 'd1', page: 1, quote: 'received 02-Mar', verified: false },
        { doc_id: 'd1', page: 1, quote: 'never written here', verified: false },
      ] })],
      [doc],
    );
    expect(f!.classification).toBe('ambiguous');
    expect(f!.evidence.map((e) => e.verified)).toEqual([true, false]);
  });

  it('requires evidence for positive findings but not for absence findings', () => {
    expect(verifyCitations([base({})], [doc])[0]!.classification).toBe('ambiguous');
    expect(verifyCitations([base({ classification: 'missing' })], [doc])[0]!.classification).toBe('missing');
  });
});

describe('validateModelOutput', () => {
  const ok = { findings: [{ key: 'a', type: 't', classification: 'missing', summary: 's', evidence: [{ doc_id: 'd1', page: 1, quote: 'q q q q' }], next_action: 'do it' }] };

  it('accepts objects and fenced JSON strings, mapping to camelCase with verified=false', () => {
    const a = validateModelOutput(ok, CLASSIFICATIONS['claim-reconciler']);
    const b = validateModelOutput('```json\n' + JSON.stringify(ok) + '\n```', CLASSIFICATIONS['claim-reconciler']);
    expect(a).toEqual(b);
    expect(a[0]).toMatchObject({ nextAction: 'do it', evidence: [{ verified: false }] });
  });

  it('rejects bad shape, unknown classification, duplicate keys and non-JSON', () => {
    const allowed = CLASSIFICATIONS['claim-reconciler'];
    expect(() => validateModelOutput({ findings: [{ key: 'a' }] }, allowed)).toThrow(ModelOutputError);
    expect(() => validateModelOutput({ findings: [{ ...ok.findings[0], classification: 'approved' }] }, allowed)).toThrow(ModelOutputError);
    expect(() => validateModelOutput({ findings: [ok.findings[0], ok.findings[0]] }, allowed)).toThrow(ModelOutputError);
    expect(() => validateModelOutput('not json', allowed)).toThrow(ModelOutputError);
    expect(() => validateModelOutput({ findings: [{ ...ok.findings[0], evidence: [{ doc_id: 'd', page: 0, quote: 'x' }] }] }, allowed)).toThrow(ModelOutputError);
  });

  it('error messages never echo values (which may be document text)', () => {
    try {
      validateModelOutput({ findings: [{ key: 'SECRET-PAYLOAD', type: 1 }] }, ['missing']);
      throw new Error('should fail');
    } catch (e) {
      expect((e as Error).message).not.toContain('SECRET-PAYLOAD');
    }
  });
});

describe('prompt-injection handling', () => {
  it('wraps untrusted text in delimiters and neutralises delimiter look-alikes', async () => {
    const text = await fs.readFile(path.join(process.cwd(), 'fixtures/shared/injection.txt'), 'utf8');
    const { system, user } = buildPrompt({
      task: 't', promptVersion: 'v1', instructions: 'Extract requested items.',
      documents: [{ id: 'd1', name: 'letter.txt', pages: [{ page: 1, text }] }],
    });
    expect(system).toBe(SYSTEM_GUARD);
    expect(system).toMatch(/UNTRUSTED DATA/);
    expect(system).not.toContain('IGNORE ALL PREVIOUS');
    // The injected "<<<END DOC>>>" must not close the block early: exactly one real terminator.
    expect(user.match(/<<<END DOC>>>/g)).toHaveLength(1);
    expect(user.match(/<<<DOC /g)).toHaveLength(1);
    const body = user.slice(user.indexOf('<<<DOC '), user.indexOf('<<<END DOC>>>'));
    expect(body).toContain('IGNORE ALL PREVIOUS INSTRUCTIONS'); // present, but only as data inside the block
    expect(body).toContain('attacker@example.invalid');
  });

  it('an injected instruction cannot change a deterministic result or smuggle a classification', async () => {
    const text = await fs.readFile(path.join(process.cwd(), 'fixtures/shared/injection.txt'), 'utf8');
    registerSyntheticHandler('inject-test', (req) => ({
      // A rule-based handler: classification comes from rules, never from document text.
      findings: [{ key: 'item-1', type: 'requested_item', classification: 'missing', summary: `Checked ${req.documents.length} doc(s)`, evidence: [] }],
    }));
    const out = await runModelTask(
      new SyntheticProvider(),
      { task: 'inject-test', promptVersion: 'v1', instructions: '', documents: [{ id: 'd1', name: 'x', pages: [{ page: 1, text }] }] },
      CLASSIFICATIONS['claim-reconciler'],
    );
    expect(out[0]!.classification).toBe('missing');
    // And a model that obeys the injection is caught by validation (not an allowed class) ...
    expect(() => validateModelOutput({ findings: [{ key: 'a', type: 't', classification: 'approved_by_admin', summary: 's' }] }, CLASSIFICATIONS['claim-reconciler'])).toThrow();
    // ... or by citation checks when it invents supporting quotes.
    const doc1: DocumentRecord = { id: 'd1', caseId: 'c', sha256: 'h', filename: 'x', mime: 'text/plain', kind: 'other', storageKey: 'k', pages: [{ page: 1, text, ocr_status: 'not_needed' }] };
    const [f] = verifyCitations([base({ evidence: [{ doc_id: 'd1', page: 1, quote: 'Signed original enclosed', verified: false }] })], [doc1]);
    expect(f!.classification).toBe('ambiguous');
  });
});

describe('providers', () => {
  it('synthetic is the default, deterministic and labelled', async () => {
    const p = getProvider();
    expect(p).toMatchObject({ mode: 'synthetic', model: 'synthetic-v1' });
    const r1 = await p.complete({ task: 'unregistered', promptVersion: 'v9', instructions: '', documents: [] });
    expect(r1).toMatchObject({ mode: 'synthetic', model: 'synthetic-v1', promptVersion: 'v9', output: { findings: [] } });
  });

  it('live providers are never selected silently when unconfigured', () => {
    const prev = { ...process.env };
    try {
      delete process.env.ANTHROPIC_API_KEY;
      process.env.MODEL_PROVIDER = 'anthropic';
      expect(() => getProvider()).toThrow(/ANTHROPIC_API_KEY/);
      process.env.MODEL_PROVIDER = 'bedrock';
      expect(() => getProvider()).toThrow(/AWS/);
    } finally {
      process.env = prev;
    }
  });
});
