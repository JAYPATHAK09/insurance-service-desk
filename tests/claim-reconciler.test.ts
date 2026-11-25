import fs from 'node:fs/promises';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { cases, findings, kpiEvents, reviews } from '@/db/schema';
import type { DocumentRecord, Finding, ModelProvider, ModelRequest, PageText } from '@/lib/contracts';
import { correctClassification, decideFinding } from '@/lib/findings';
import { runReview } from '@/lib/review';
import { ModelOutputError } from '@/lib/model/validate';
import { verifyCitations } from '@/lib/model/verify';
import { claimReconciler } from '@/modules/claim-reconciler';
import { buildChronology, chronologyCsv } from '@/modules/claim-reconciler/chronology';
import { buildDraft } from '@/modules/claim-reconciler/draft';
import { enforceReceiptRule, reconcile } from '@/modules/claim-reconciler/engine';
import { itemNo, runCase, runEval } from '@/modules/claim-reconciler/eval';
import { fixturesRoot, loadManifest, seedClaimFixtures } from '@/modules/claim-reconciler/fixtures';
import { emitCorrectionKpis, emitDecisionKpis, emitRunKpis } from '@/modules/claim-reconciler/kpi';
import type { DocIn } from '@/modules/claim-reconciler/parse';
import { ClaimError, approveDraft, currentDraft, loadChronoDocs, supervisorApproveDraft } from '@/modules/claim-reconciler/service';
import { freshDb, U } from './helpers';

const page = (text: string): PageText[] => [{ page: 1, text, ocr_status: 'ok' }];
const doc = (id: string, kind: string, text: string, name = `${id}.txt`): DocIn => ({ id, name, kind, pages: page(text) });

const LETTER = (items: string[]) => `Northstar General - Claim Query Letter\nQuery ref: QRY-T-1\nDate: 10-Mar-2025\n${items.map((t, i) => `${i + 1}. ${t}`).join('\n')}`;
const RECEIPT = (...lines: string[]) => `SUBMISSION RECEIPT\nReference: SUB-T1\nDate: 12-Mar-2025\nItems acknowledged:\n${lines.map((l) => `- ${l}`).join('\n')}`;

const byItem = (fs: Finding[], n: number) => fs.find((f) => itemNo(f) === n)!;

describe('fixtures vs expected.json', () => {
  it('classifies every fixture item as expected, with the expected quote cited and every citation verified', async () => {
    const root = fixturesRoot();
    const manifest = await loadManifest(root);
    expect(manifest.map((c) => c.id)).toEqual(['complete', 'partial', 'duplicate', 'contradictory', 'unreadable', 'wrongbill']);
    for (const c of manifest) {
      const { findings: out } = await runCase(c, root);
      expect(out.map(itemNo).sort(), c.id).toEqual(c.expected.map((e) => e.item).sort());
      for (const e of c.expected) {
        const f = byItem(out, e.item);
        expect(f.classification, `${c.id} item ${e.item}`).toBe(e.classification);
        if (e.reason) expect((f.attributes as { reason: string }).reason, `${c.id} item ${e.item} reason`).toBe(e.reason);
        if (e.quote) expect(f.evidence.some((ev) => ev.verified && ev.quote === e.quote), `${c.id} item ${e.item} quote`).toBe(true);
        for (const ev of f.evidence) expect(ev.verified, `${c.id} item ${e.item} evidence "${ev.quote}"`).toBe(true);
        expect(f.suggestedOwner).toBeTruthy();
        expect(f.nextAction).toBeTruthy();
      }
    }
  });

  it('eval computes its numbers and writes the agreed file shape', async () => {
    const { result, rows } = await runEval({ write: true });
    expect(Object.keys(result).sort()).toEqual(['citation', 'classification', 'mode']);
    expect(result.classification.total).toBe(rows.length);
    expect(result.classification.correct).toBe(rows.filter((r) => r.classificationOk).length);
    const file = JSON.parse(await fs.readFile(path.join(fixturesRoot(), 'eval-results.json'), 'utf8'));
    expect(file).toEqual(result);
    expect(result.classification.correct).toBe(result.classification.total);
    expect(result.citation.correct).toBe(result.citation.total);
  });

  it('keys are stable per (query item, letter hash) across runs', async () => {
    const root = fixturesRoot();
    const c = (await loadManifest(root)).find((x) => x.id === 'partial')!;
    const a = (await runCase(c, root)).findings.map((f) => f.key);
    const b = (await runCase(c, root)).findings.map((f) => f.key);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(a.length);
  });
});

describe('receipt rule', () => {
  it('a receipt alone can never yield satisfied; it is ambiguous with "sufficiency unverified"', () => {
    const { findings: out } = reconcile([
      doc('l', 'query_letter', LETTER(['Original discharge summary, duly signed.'])),
      doc('r', 'receipt', RECEIPT('Discharge summary (signed original)')),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.classification).toBe('ambiguous');
    expect((out[0]!.attributes as { receipt_only: boolean }).receipt_only).toBe(true);
    expect(out[0]!.nextAction).toMatch(/sufficiency unverified/i);
  });

  it('enforceReceiptRule downgrades a (live-model style) satisfied finding that cites only a receipt', () => {
    const f: Finding = {
      key: 'k',
      type: 'requested_item',
      classification: 'satisfied_pending_verification',
      summary: 's',
      evidence: [{ doc_id: 'r', page: 1, quote: '- Discharge summary', verified: false }],
    };
    const [d] = enforceReceiptRule([f], new Set(['doc-1']));
    expect(d!.classification).toBe('ambiguous');
    expect(d!.attributes).toMatchObject({ downgradedFrom: 'satisfied_pending_verification', downgradeReason: 'receipt_alone' });
    const [kept] = enforceReceiptRule([{ ...f, evidence: [{ ...f.evidence[0]!, doc_id: 'doc-1' }] }], new Set(['doc-1']));
    expect(kept!.classification).toBe('satisfied_pending_verification');
  });

  it('a receipt for the WRONG bill number does not support the bill that was asked for', () => {
    const { findings: out } = reconcile([
      doc('l', 'query_letter', LETTER(['Itemised hospital bill no. HB-100.'])),
      doc('r', 'receipt', RECEIPT('Hospital bill no. HB-999')),
    ]);
    expect(out[0]!.classification).toBe('ambiguous');
    expect((out[0]!.attributes as { reason: string }).reason).toBe('different_reference');
  });

  it('a document that looks right but whose receipt lists another bill stays ambiguous', async () => {
    const root = fixturesRoot();
    const c = (await loadManifest(root)).find((x) => x.id === 'wrongbill')!;
    const { findings: out } = await runCase(c, root);
    expect(byItem(out, 1).classification).toBe('ambiguous');
    expect((byItem(out, 1).attributes as { reason: string }).reason).toBe('receipt_for_different_document');
  });
});

describe('qualifiers', () => {
  const bill = (extra: string) => `ITEMISED HOSPITAL BILL\nBill no: HB-1\nDate: 05-Mar-2025\n${extra}`;
  it('unsigned where signed is required is partially satisfied; signed passes', () => {
    const mk = (sig: string) =>
      reconcile([
        doc('l', 'query_letter', LETTER(['Original discharge summary, duly signed by the doctor.'])),
        doc('d', 'other', `DISCHARGE SUMMARY\nStatus: ORIGINAL\nDoctor signature: ${sig}`, 'discharge-summary.txt'),
        doc('r', 'receipt', RECEIPT('Discharge summary')),
      ]).findings[0]!;
    const unsigned = mk('not signed');
    expect(unsigned.classification).toBe('partially_satisfied');
    expect((unsigned.attributes as { unmet: Array<{ qualifier: string }> }).unmet.map((u) => u.qualifier)).toEqual(['signed']);
    expect(mk('Signed - Dr. T. Rao').classification).toBe('satisfied_pending_verification');
  });

  it('consolidated vs itemised, copy vs original, and unknown signature', () => {
    const run = (letter: string, text: string, name = 'hospital-bill.txt') =>
      reconcile([doc('l', 'query_letter', LETTER([letter])), doc('d', 'other', text, name), doc('r', 'receipt', RECEIPT('Hospital bill'))]).findings[0]!;
    expect(run('Itemised hospital bill.', bill('Bill type: Consolidated')).classification).toBe('partially_satisfied');
    expect(run('Original hospital bill.', bill('Status: PHOTOCOPY\nBill type: Itemised')).classification).toBe('partially_satisfied');
    // Asked signed, document says nothing about a signature: cannot be confirmed.
    expect(run('Signed hospital bill.', bill('Bill type: Itemised')).classification).toBe('ambiguous');
    expect(run('Itemised hospital bill.', bill('Bill type: Itemised')).classification).toBe('satisfied_pending_verification');
  });

  it('a document on file with no submission record is partially satisfied (not yet sent)', () => {
    const f = reconcile([doc('l', 'query_letter', LETTER(['Hospital bill.'])), doc('d', 'other', bill('Bill type: Itemised'), 'hospital-bill.txt')]).findings[0]!;
    expect(f.classification).toBe('partially_satisfied');
    expect((f.attributes as { reason: string }).reason).toBe('not_yet_submitted');
  });

  it('an item with no document anywhere is missing and may cite only the request line', () => {
    const f = reconcile([doc('l', 'query_letter', LETTER(['Doctor prescription.']))]).findings[0]!;
    expect(f.classification).toBe('missing');
    expect(f.evidence).toHaveLength(1);
  });

  it('prompt injection inside a letter changes nothing: nothing is satisfied', async () => {
    const text = await fs.readFile(path.join(process.cwd(), 'fixtures', 'shared', 'injection.txt'), 'utf8');
    const out = reconcile([doc('l', 'query_letter', text)]).findings;
    expect(out).toHaveLength(1);
    expect(out[0]!.classification).toBe('missing');
  });
});

describe('citation verification', () => {
  it('every produced quote is verbatim on its cited page; an invented quote is downgraded', async () => {
    const docs: DocumentRecord[] = [
      { id: 'l', caseId: 'c', sha256: 'a'.repeat(64), filename: 'l.txt', mime: 'text/plain', kind: 'query_letter', pages: page(LETTER(['Doctor prescription.'])), storageKey: 'k' },
    ];
    const good = verifyCitations(reconcile(docs.map((d) => ({ id: d.id, name: d.filename, kind: d.kind, sha: d.sha256, pages: d.pages }))).findings, docs);
    expect(good.every((f) => f.evidence.every((e) => e.verified))).toBe(true);
    const bad = verifyCitations([{ ...good[0]!, classification: 'partially_satisfied', evidence: [{ doc_id: 'l', page: 1, quote: 'signed and sealed original', verified: false }] }], docs);
    expect(bad[0]!.classification).toBe('ambiguous');
  });
});

describe('live path', () => {
  const live = (output: unknown): ModelProvider => ({
    mode: 'live',
    model: 'test-live',
    async complete(req: ModelRequest) {
      // Document text is only ever in `documents`, which the prompt builder delimits.
      expect(req.instructions).not.toContain('Doctor prescription');
      expect(req.documents.length).toBeGreaterThan(0);
      return { mode: 'live', model: 'test-live', promptVersion: req.promptVersion, output };
    },
  });
  const docs: DocumentRecord[] = [
    { id: 'l', caseId: 'c', sha256: 'b'.repeat(64), filename: 'l.txt', mime: 'text/plain', kind: 'query_letter', pages: page(LETTER(['Doctor prescription.'])), storageKey: 'k' },
    { id: 'r', caseId: 'c', sha256: 'c'.repeat(64), filename: 'r.txt', mime: 'text/plain', kind: 'receipt', pages: page(RECEIPT('Prescription')), storageKey: 'k' },
  ];

  it('validates with Zod, pins keys, and applies the receipt rule to model output', async () => {
    const out = await claimReconciler.run(
      'c',
      docs,
      live(JSON.stringify({ findings: [{ key: 'item one', type: 'requested_item', classification: 'satisfied_pending_verification', summary: 'ok', evidence: [{ doc_id: 'r', page: 1, quote: '- Prescription' }], attributes: { item_no: 1 } }] })),
    );
    expect(out[0]!.key).toBe(`qi-${'b'.repeat(12)}-1`);
    expect(out[0]!.classification).toBe('ambiguous');
  });

  it('rejects unknown classifications and malformed output', async () => {
    await expect(claimReconciler.run('c', docs, live({ findings: [{ key: 'k', type: 't', classification: 'approved', summary: 's', evidence: [] }] }))).rejects.toBeInstanceOf(ModelOutputError);
    await expect(claimReconciler.run('c', docs, live('not json'))).rejects.toBeInstanceOf(ModelOutputError);
  });
});

describe('chronology', () => {
  it('is in date order, carries submission refs, and neutralises spreadsheet formulas', async () => {
    const rows = buildChronology([
      { ...doc('r', 'receipt', RECEIPT('Hospital bill no. HB-1')), filename: '=cmd.txt', sha256: 'f'.repeat(64), createdAt: new Date('2025-04-01') },
      { ...doc('l', 'query_letter', LETTER(['Hospital bill no. HB-1.'])), filename: 'l.txt', sha256: 'e'.repeat(64), createdAt: new Date('2025-04-02') },
      { ...doc('d', 'other', 'HOSPITAL BILL\nBill no: HB-1\nDate: 01-Mar-2025', 'hospital-bill.txt'), filename: 'hospital-bill.txt', sha256: 'd'.repeat(64), createdAt: new Date('2025-04-03') },
    ]);
    expect(rows.map((r) => r.date)).toEqual(['2025-03-01', '2025-03-10', '2025-03-12']);
    expect(rows[2]!.submissionRef).toBe('SUB-T1');
    const csv = chronologyCsv(rows);
    expect(csv.split('\r\n')[0]).toBe('date,date_basis,event,description,submission_ref,document,sha256_12');
    expect(csv).toContain("'=cmd.txt");
  });
});

describe('draft response', () => {
  it('never states an outcome and always carries handler-verification placeholders', () => {
    const { body } = buildDraft({
      insurer: 'Northstar General',
      reference: 'FX-1',
      items: [
        { n: 1, itemType: 'hospital_bill', itemText: 'Itemised hospital bill', classification: 'satisfied_pending_verification', status: 'accepted', submissionRefs: ['SUB-1'] },
        { n: 2, itemType: 'prescription', itemText: 'Prescription', classification: 'missing', status: 'open', nextAction: 'Obtain it', submissionRefs: [] },
      ],
    });
    expect(body).toMatch(/HANDLER TO VERIFY/);
    expect(body).toMatch(/\[UNREVIEWED\]/);
    expect(body).not.toMatch(/\b(approved|rejected|admissible|payable|settled|will be paid)\b/i);
  });
});

async function seeded() {
  const db = await freshDb();
  await seedClaimFixtures(db, { ownerId: U.handlerA.id });
  const rows = await db.select().from(cases);
  const byRef = (ref: string) => rows.find((c) => c.reference === ref)!;
  return { db, byRef };
}

describe('seed, review, idempotency, KPIs and approval (database)', () => {
  it('seedClaimFixtures is idempotent and loads all fixture cases with documents', async () => {
    const { db } = await seeded();
    const again = await seedClaimFixtures(db, { ownerId: U.handlerA.id });
    expect(again.every((r) => !r.created)).toBe(true);
    expect(again).toHaveLength(6);
    expect((await db.select().from(cases)).length).toBe(6);
  });

  it('re-running a review creates no second review and no duplicate findings or KPI rows', async () => {
    const { db, byRef } = await seeded();
    const c = byRef('FX-CLM-300');
    const first = await runReview(db, { caseId: c.id, actorId: U.handlerA.id });
    await emitRunKpis(db, c.id);
    const second = await runReview(db, { caseId: c.id, actorId: U.handlerA.id });
    await emitRunKpis(db, c.id);
    expect(first.state).toBe('ran');
    expect(second.state).toBe('replayed');
    expect(await db.select().from(reviews).where(eq(reviews.caseId, c.id))).toHaveLength(1);
    const fs2 = await db.select().from(findings).where(eq(findings.caseId, c.id));
    expect(fs2).toHaveLength(2);
    expect(fs2.every((f) => f.evidence.every((e) => e.verified))).toBe(true);
    const kpi = await db.select().from(kpiEvents).where(eq(kpiEvents.caseId, c.id));
    expect(kpi.filter((k) => k.kind === 'repeat_request')).toHaveLength(1);
    expect(kpi.every((k) => k.source === 'fixture' && k.dedupeKey && k.module === 'claim-reconciler')).toBe(true);
  });

  it('decisions and corrections emit review_minutes, reviewer_override, finding_corrected and false_match once', async () => {
    const { db, byRef } = await seeded();
    const c = byRef('FX-CLM-100');
    await runReview(db, { caseId: c.id, actorId: U.handlerA.id });
    const [f1, f2] = await db.select().from(findings).where(eq(findings.caseId, c.id));
    await decideFinding(db, { findingId: f1!.id, actorId: U.handlerA.id, decision: 'override', note: 'Wrong document attached' });
    await emitDecisionKpis(db, { findingId: f1!.id, decision: 'override' });
    await emitDecisionKpis(db, { findingId: f1!.id, decision: 'override' });
    await correctClassification(db, { findingId: f2!.id, actorId: U.handlerA.id, to: 'ambiguous', reason: 'Signature illegible', allowed: claimReconciler.classifications });
    await emitCorrectionKpis(db, { findingId: f2!.id });
    await emitCorrectionKpis(db, { findingId: f2!.id });
    const kinds = (await db.select().from(kpiEvents).where(eq(kpiEvents.caseId, c.id))).map((k) => k.kind).sort();
    expect(kinds).toEqual(['false_match', 'false_match', 'finding_corrected', 'review_minutes', 'reviewer_override']);
  });

  it('the draft is DRAFT until the handler approves the exact text; edits reset it; analysts and open findings are blocked', async () => {
    const { db, byRef } = await seeded();
    const c = byRef('FX-CLM-300');
    await runReview(db, { caseId: c.id, actorId: U.handlerA.id });
    let d = (await currentDraft(db, c.id))!;
    expect(d.status.status).toBe('draft');
    expect(d.document.startsWith('STATUS: DRAFT')).toBe(true);
    await expect(approveDraft(db, { caseId: c.id, user: U.handlerA, seenHash: d.hash })).rejects.toBeInstanceOf(ClaimError); // open findings
    const fs2 = await db.select().from(findings).where(eq(findings.caseId, c.id));
    for (const f of fs2) await decideFinding(db, { findingId: f.id, actorId: U.handlerA.id, decision: 'accept', note: '' });
    d = (await currentDraft(db, c.id))!;
    await expect(approveDraft(db, { caseId: c.id, user: U.analyst, seenHash: d.hash })).rejects.toBeInstanceOf(ClaimError);
    await expect(approveDraft(db, { caseId: c.id, user: U.handlerA, seenHash: 'x'.repeat(64) })).rejects.toBeInstanceOf(ClaimError);
    await expect(supervisorApproveDraft(db, { caseId: c.id, user: U.supervisor, seenHash: d.hash })).rejects.toThrow(/handler must approve/);
    await approveDraft(db, { caseId: c.id, user: U.handlerA, seenHash: d.hash });
    const ready = (await currentDraft(db, c.id))!;
    expect(ready.status.status).toBe('ready');
    expect(ready.document).toMatch(/NOT SENT/);
    await expect(supervisorApproveDraft(db, { caseId: c.id, user: U.handlerA, seenHash: d.hash })).rejects.toBeInstanceOf(ClaimError);
    await supervisorApproveDraft(db, { caseId: c.id, user: U.supervisor, seenHash: d.hash });
    expect((await currentDraft(db, c.id))!.status.supervisor).toBeTruthy();
    // Changing a finding changes the text, so the approval no longer applies.
    const [target] = await db.select().from(findings).where(and(eq(findings.caseId, c.id), eq(findings.classification, 'missing')));
    await correctClassification(db, { findingId: target!.id, actorId: U.handlerA.id, to: 'ambiguous', reason: 'Checked again', allowed: claimReconciler.classifications });
    expect((await currentDraft(db, c.id))!.status.status).toBe('draft');
  });

  it('chronology of a seeded case lists its documents and receipt reference', async () => {
    const { db, byRef } = await seeded();
    const c = byRef('FX-CLM-600');
    const rows = buildChronology(await loadChronoDocs(db, c.id));
    expect(rows.some((r) => r.event === 'Submission receipt' && r.submissionRef === 'SUB-94001')).toBe(true);
    expect([...rows].map((r) => r.date)).toEqual([...rows.map((r) => r.date)].sort());
  });
});
