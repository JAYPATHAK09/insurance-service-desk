import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { findings, reviews } from '@/db/schema';
import type { DocumentRecord, Finding, ModelProvider } from '@/lib/contracts';
import { ingestDocument } from '@/lib/ingest';
import { SyntheticOcrAdapter } from '@/lib/ocr';
import { runReview } from '@/lib/review';
import { MemoryStorage } from '@/lib/storage';
import { classifyAnswer, parseDoc } from '@/modules/disclosure-checker/parse';
import { similarNameKeys } from '@/modules/disclosure-checker/compare';
import { disclosureChecker, stableKey } from '@/modules/disclosure-checker';
import { buildDocs, loadFixtureCases, seedDisclosureFixtures } from '@/modules/disclosure-checker/fixtures';
import { SyntheticProvider } from '@/lib/model';
import { bytes, freshDb, makeCase, U } from './helpers';

const doc = (id: string, kind: string, text: string, sha = id): DocumentRecord => ({
  id, caseId: 'c', sha256: sha, filename: `${id}.txt`, mime: 'text/plain', kind, storageKey: id,
  pages: text.split('\f').map((t, i) => ({ page: i + 1, text: t, ocr_status: 'not_needed' as const })),
});
const C = (rows: string, name = 'Asha Test') => `CUSTOMER DISCLOSURE CONFIRMATION\nInsured person: ${name}\nConfirmed on: 2026-03-02\n\nMEMBER: ${name} (self)\n${rows}`;
const P = (rows: string, name = 'Asha Test') => `DRAFT PROPOSAL\nInsured person: ${name}\nProposal date: 2026-03-04\n\nMEMBER: ${name} (self)\n${rows}`;
const run = (docs: DocumentRecord[]) => disclosureChecker.run('c', docs, new SyntheticProvider());

describe('answer parsing', () => {
  it('keeps blank, explicit No and ambiguous apart', () => {
    expect(classifyAnswer('')).toBe('blank');
    expect(classifyAnswer('____')).toBe('blank');
    expect(classifyAnswer('No')).toBe('no');
    expect(classifyAnswer('Nil')).toBe('no');
    expect(classifyAnswer('Yes, since 2019')).toBe('yes');
    for (const a of ['N/A', '-', 'not sure', 'Yes / No', '[ ] Yes [x] No', 'No, but under review']) expect(classifyAnswer(a), a).toBe('ambiguous');
  });
  it('rejects question rows outside a member block rather than guessing a member', () => {
    const d = parseDoc(doc('x', 'proposal', 'DRAFT PROPOSAL\nQ1 | Diabetes | No'), 'proposal');
    expect(d.unparsed).toHaveLength(1);
    expect(d.members).toHaveLength(0);
  });
});

describe('comparison safety rules', () => {
  it('blank in the proposal is unanswered, never treated as No', async () => {
    const f = await run([doc('c', 'disclosure', C('Q1 | Diabetes | No | 2026-03-02')), doc('p', 'proposal', P('Q1 | Diabetes |'))]);
    expect(f.map((x) => x.classification)).toEqual(['unanswered']);
    expect(f[0]!.attributes).toMatchObject({ customer_answer: 'No', proposal_answer: '', proposal_answer_kind: 'blank' });
  });
  it('an explicit No stays explicit_negative and a matching No yields no finding', async () => {
    const f = await run([doc('c', 'disclosure', C('Q1 | Diabetes | | 2026-03-02\nQ2 | Asthma | No | 2026-03-02')), doc('p', 'proposal', P('Q1 | Diabetes | No\nQ2 | Asthma | No'))]);
    expect(f.map((x) => [x.attributes?.question_id, x.classification])).toEqual([['Q1', 'explicit_negative']]);
  });
  it('never merges similar-named members and reports the near names', async () => {
    const cust = `CUSTOMER DISCLOSURE CONFIRMATION\nInsured person: Pooja Mehra\n\nMEMBER: Rohan Mehra (child)\nQ3 | Asthma | Yes, since 2021 | 2026-03-02\n\nMEMBER: Rohit Mehra (child)\nQ3 | Asthma | No | 2026-03-02`;
    const prop = `DRAFT PROPOSAL\nInsured person: Pooja Mehra\n\nMEMBER: Rohit Mehra (child)\nQ3 | Asthma | No\n\nMEMBER: R. Mehra (child)\nQ3 | Asthma | No`;
    const f = await run([doc('c', 'disclosure', cust), doc('p', 'proposal', prop)]);
    const byMember = Object.fromEntries(f.map((x) => [String(x.attributes?.member), x]));
    expect(byMember['Rohan Mehra']!.classification).toBe('omission'); // Rohan has no entry; Rohit's No is NOT used for him
    expect(byMember['Rohan Mehra']!.attributes?.similar_members).toEqual(expect.arrayContaining(['Rohit Mehra', 'R. Mehra']));
    expect(byMember['Rohit Mehra']).toBeUndefined();
    expect(byMember['R. Mehra']!.classification).toBe('explicit_negative');
    expect(similarNameKeys('rohan mehra', ['rohit mehra', 'r mehra', 'rohan shah'])).toEqual(['rohit mehra', 'r mehra']);
  });
  it('refuses to compare different insured persons and different dates of birth', async () => {
    const f = await run([doc('c', 'disclosure', C('Q1 | Diabetes | Yes', 'Rakesh Nair')), doc('p', 'proposal', P('Q1 | Diabetes | No', 'Rakesh Nayar'))]);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ type: 'insured_mismatch', classification: 'ambiguous' });
    const dob = await run([doc('c', 'disclosure', C('Q1 | D | No').replace('Confirmed', 'Date of birth: 1980-01-01\nConfirmed')), doc('p', 'proposal', P('Q1 | D | Yes').replace('Proposal date', 'Date of birth: 1981-01-01\nProposal date'))]);
    expect(dob.map((x) => x.type)).toEqual(['insured_mismatch']);
  });
  it('does not turn differing wording into a contradiction or a match (no inference)', async () => {
    const f = await run([doc('c', 'disclosure', C('Q1 | Diabetes | Yes, type 2 diabetes | 2026-03-02')), doc('p', 'proposal', P('Q1 | Diabetes | Yes, sugar'))]);
    expect(f.map((x) => x.classification)).toEqual(['ambiguous']);
    expect(f[0]!.attributes?.customer_answer).toBe('Yes, type 2 diabetes');
  });
  it('flags an unreadable page instead of comparing', async () => {
    const bad = doc('c', 'disclosure', '');
    bad.pages = [{ page: 1, text: '', ocr_status: 'failed' }];
    const f = await run([bad, doc('p', 'proposal', P('Q1 | D | No'))]);
    expect(f.map((x) => x.type)).toEqual(['unreadable_document']);
  });
  it('flags a missing document and conflicting versions', async () => {
    expect((await run([doc('p', 'proposal', P('Q1 | D | No'))])).map((x) => x.type)).toEqual(['missing_document']);
    const f = await run([doc('c', 'disclosure', C('Q1 | D | No')), doc('p1', 'proposal', P('Q1 | D | No')), doc('p2', 'proposal', P('Q1 | D | Yes'))]);
    expect(f.map((x) => x.type)).toEqual(['multiple_versions']);
  });
  it('keeps findings keyed per (member, question, doc hashes) and stable across runs', async () => {
    const docs = [doc('c', 'disclosure', C('Q1 | D | Yes, 2019')), doc('p', 'proposal', P('Q1 | D | No'))];
    const a = await run(docs);
    const b = await run(docs);
    expect(a[0]!.key).toBe(b[0]!.key);
    expect(a[0]!.key).toBe(stableKey('Asha  Test', 'q1', 'c', 'p'));
    expect(stableKey('Asha Test', 'Q1', 'c', 'p2')).not.toBe(a[0]!.key);
  });
  it('cites the second page of a multi-page document with the right page number', async () => {
    const cust = C('Q1 | D | No') + '\f' + 'MEMBER: Asha Test (self)\nQ2 | Asthma | Yes, 2020 | 2026-03-02';
    const f = await run([doc('c', 'disclosure', cust), doc('p', 'proposal', P('Q1 | D | No\nQ2 | Asthma | No'))]);
    expect(f).toHaveLength(1);
    expect(f[0]!.evidence.find((e) => e.doc_id === 'c')!.page).toBe(2);
  });
});

describe('live path guard', () => {
  it('downgrades a model finding the rules disagree with and adds one the model missed', async () => {
    const docs = [doc('c', 'disclosure', C('Q1 | D | Yes, 2019\nQ2 | A | No\nQ3 | H | Yes, 2020')), doc('p', 'proposal', P('Q1 | D | No\nQ2 | A | No\nQ3 | H | No'))];
    const lying: ModelProvider = {
      mode: 'live',
      model: 'fake',
      async complete() {
        return {
          mode: 'live', model: 'fake', promptVersion: 'x',
          output: JSON.stringify({ findings: [
            { key: 'a', type: 't', classification: 'omission', summary: 's', evidence: [], attributes: { member: 'Asha Test', question_id: 'Q2' } },
            { key: 'a1', type: 't', classification: 'omission', summary: 's', evidence: [], attributes: { member: 'Asha Test', question_id: 'Q1' } },
            { key: 'b', type: 't', classification: 'contradiction', summary: 'diagnosed diabetes', evidence: [], attributes: { member: 'Nobody', question_id: 'Q9' } },
          ] }),
        };
      },
    };
    const f = await disclosureChecker.run('c', docs, lying);
    const q2 = f.find((x) => x.attributes?.question_id === 'Q2')!;
    expect(q2.classification).toBe('ambiguous');
    expect(q2.attributes).toMatchObject({ downgradedFrom: 'omission', downgradeReason: 'not_supported_by_rule_check' });
    const q1 = f.find((x) => x.attributes?.question_id === 'Q1')!;
    expect(q1.classification).toBe('ambiguous');
    expect(q1.attributes).toMatchObject({ downgradedFrom: 'omission', downgradeReason: 'disagrees_with_rule_check' });
    expect(f.find((x) => x.attributes?.member === 'Nobody')!.classification).toBe('ambiguous');
    expect(f.find((x) => x.attributes?.question_id === 'Q3')!.classification).toBe('contradiction'); // missed by the model, added from the rule check
  });

  it('accepts issue-type findings only from the rule engine and takes answers/dates from the rule comparison (M3)', async () => {
    const docs = [doc('c', 'disclosure', C('Q1 | D | Yes, 2019 | 2026-03-02')), doc('p', 'proposal', P('Q1 | D | No'))];
    const injecting: ModelProvider = {
      mode: 'live',
      model: 'fake',
      async complete() {
        return {
          mode: 'live', model: 'fake', promptVersion: 'x',
          output: JSON.stringify({ findings: [
            // An invented document-level issue, by key prefix and by attribute.
            { key: 'issue|insured_mismatch|fake', type: 'insured_mismatch', classification: 'ambiguous', summary: 'INJECTED: documents belong to different people', evidence: [], attributes: { issue: true, source: 'rule_check' } },
            { key: 'sneaky', type: 'unreadable_document', classification: 'ambiguous', summary: 'INJECTED: page unreadable', evidence: [], attributes: { issue: true } },
            // A real row, but the model lies about the answers and the date.
            { key: 'q1', type: 'disclosure_difference', classification: 'contradiction', summary: 'model wording', evidence: [], attributes: {
              member: 'Asha Test', question_id: 'Q1', customer_answer: 'No', proposal_answer: 'Yes, 2019', customer_date: '1999-01-01', proposal_date: '2000-02-02', customer_answer_kind: 'no', relation: 'spouse',
            } },
            // A row the rules do not have: its claimed answers are stripped, never kept.
            { key: 'q9', type: 't', classification: 'contradiction', summary: 's', evidence: [], attributes: { member: 'Asha Test', question_id: 'Q9', customer_answer: 'Yes', proposal_answer: 'No', customer_date: '2020-01-01' } },
          ] }),
        };
      },
    };
    const out = await disclosureChecker.run('c', docs, injecting);
    expect(out.some((x) => /INJECTED/.test(x.summary))).toBe(false);
    expect(out.some((x) => x.attributes?.issue === true || x.key.includes('fake'))).toBe(false);
    expect(out.map((x) => x.type)).not.toContain('insured_mismatch');
    expect(out.map((x) => x.type)).not.toContain('unreadable_document');

    const q1 = out.find((x) => x.attributes?.question_id === 'Q1')!;
    expect(q1.classification).toBe('contradiction');
    expect(q1.attributes).toMatchObject({
      member: 'Asha Test', relation: 'self',
      customer_answer: 'Yes, 2019', customer_answer_kind: 'yes', customer_date: '2026-03-02',
      proposal_answer: 'No', proposal_answer_kind: 'no', proposal_date: '2026-03-04', source: 'rule_check',
    });

    const q9 = out.find((x) => x.attributes?.question_id === 'Q9')!;
    expect(q9.classification).toBe('ambiguous');
    for (const k of ['customer_answer', 'proposal_answer', 'customer_date']) expect(q9.attributes).not.toHaveProperty(k);
  });

  it('still reports a genuine rule-engine issue when the model says nothing about it (M3)', async () => {
    const f = await run([doc('c', 'disclosure', C('Q1 | D | No', 'Rakesh Nair')), doc('p', 'proposal', P('Q1 | D | No', 'Rakesh Nayar'))]);
    expect(f.map((x) => x.type)).toEqual(['insured_mismatch']);
  });
});

describe('persisted review via runReview', () => {
  it('seeds fixtures through the upload path, is idempotent, and never duplicates findings for duplicate uploads', async () => {
    const db = await freshDb();
    const storage = new MemoryStorage();
    const seeded = await seedDisclosureFixtures(db, { ownerId: U.handlerA.id, storage });
    expect(seeded.length).toBe((await loadFixtureCases()).length);
    expect(seeded.find((s) => s.name === 'duplicate')!.duplicatesSkipped).toBe(1);
    const dup = seeded.find((s) => s.name === 'duplicate')!;
    const fs = await db.select().from(findings).where(eq(findings.caseId, dup.caseId));
    expect(fs).toHaveLength(1);
    expect(fs[0]!.classification).toBe('contradiction');
    expect(fs[0]!.evidence.every((e) => e.verified)).toBe(true);

    const again = await seedDisclosureFixtures(db, { ownerId: U.handlerA.id, storage });
    expect(again.map((a) => a.caseId)).toEqual(seeded.map((s) => s.caseId));
    expect(await db.select().from(reviews).where(eq(reviews.caseId, dup.caseId))).toHaveLength(1);

    const scan = seeded.find((s) => s.name === 'unreadable')!;
    const sf = await db.select().from(findings).where(eq(findings.caseId, scan.caseId));
    expect(sf.map((x) => x.type)).toEqual(['unreadable_document']);
    const om = seeded.find((s) => s.name === 'omission')!;
    const of = await db.select().from(findings).where(eq(findings.caseId, om.caseId));
    expect(of.map((x) => x.classification).sort()).toEqual(['omission', 'omission', 'omission']);
    expect(of.every((x) => x.evidence.every((e) => e.verified))).toBe(true);
  });

  it('a hand-built case runs end to end', async () => {
    const db = await freshDb();
    const c = await makeCase(U.handlerA.id, { module: 'disclosure-checker' });
    const ocr = new SyntheticOcrAdapter(async () => null);
    await ingestDocument(db, { caseId: c.id, filename: 'c.txt', kind: 'disclosure', bytes: bytes(C('Q1 | D | Yes, 2019')) }, { storage: new MemoryStorage(), ocr });
    await ingestDocument(db, { caseId: c.id, filename: 'p.txt', kind: 'proposal', bytes: bytes(P('Q1 | D | No')) }, { storage: new MemoryStorage(), ocr });
    const out = await runReview(db, { caseId: c.id, actorId: U.handlerA.id });
    expect(out.state).toBe('ran');
    const fs: Finding[] = (await db.select().from(findings).where(eq(findings.caseId, c.id))) as never;
    expect(fs).toHaveLength(1);
  });
});

describe('fixture expectations are internally consistent', () => {
  it('every fixture builds documents', async () => {
    for (const fc of await loadFixtureCases()) expect(buildDocs(fc).length).toBeGreaterThan(0);
  });
});
