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
      [base({ evidence: [{ doc_id: 'd1', page: 1, quote: 'Discharge summary: copy, unsigned', verified: false }] })],
      [doc],
    );
    expect(f!.evidence[0]!.verified).toBe(true);
    expect(f!.classification).toBe('satisfied_pending_verification');
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
