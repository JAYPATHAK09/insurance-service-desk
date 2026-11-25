import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { acknowledgements, auditLog, cases, documents, findings, kpiEvents } from '@/db/schema';
import { canAccessCase } from '@/lib/access';
import { runReview } from '@/lib/review';
import { renewalAgent } from '@/modules/renewal-agent';
import { buildExplanation } from '@/modules/renewal-agent/explain';
import { seedRenewalFixtures } from '@/modules/renewal-agent/fixtures';
import {
  RenewalError,
  approveExplanation,
  buildExportRows,
  csvCell,
  exportData,
  kpiSourceFor,
  loadState,
  parseAckNote,
  recordAcknowledgement,
  recordCorrection,
  recordDecision,
  toCsv,
  toExplainFinding,
} from '@/modules/renewal-agent/service';
import { freshDb, U } from './helpers';

void renewalAgent; // registers the module's synthetic handler

let db: Db;
let seeded: Awaited<ReturnType<typeof seedRenewalFixtures>>;
const caseOf = (name: string) => seeded.find((s) => s.name === name)!.caseId;

async function reviewed(name: string) {
  const id = caseOf(name);
  await runReview(db, { caseId: id, actorId: U.handlerA.id });
  return id;
}
const finding = async (caseId: string, key: string) => {
  const st = await loadState(db, caseId);
  return st.findings.find((f) => f.key === key)!;
};
/** Confirm every attention finding that is a real confirmed change, clarify nothing: a fully decided case. */
async function decideAll(caseId: string, user = U.handlerA) {
  const st = await loadState(db, caseId);
  for (const f of st.findings) {
    if (f.status !== 'open') continue;
    if (['confirmed_change', 'ambiguous', 'absent_page', 'ocr_failure'].includes(f.classification)) {
      await recordDecision(db, { caseId, findingId: f.id, user, choice: f.classification === 'confirmed_change' ? 'confirm' : 'clarify', note: 'checked' });
    }
  }
}

beforeEach(async () => {
  db = await freshDb();
  seeded = await seedRenewalFixtures(db, { ownerId: U.handlerA.id });
});

describe('seedRenewalFixtures', () => {
  it('seeds seven cases (complete, partial, duplicate, contradictory, unreadable, mismatched, rephrasing) and is idempotent', async () => {
    expect(seeded.map((s) => s.name).sort()).toEqual(['complete', 'contradictory', 'duplicate', 'mismatched', 'partial', 'rephrasing', 'unreadable']);
    const again = await seedRenewalFixtures(db, { ownerId: U.handlerA.id });
    expect(again.map((s) => s.caseId)).toEqual(seeded.map((s) => s.caseId));
    expect(await db.select().from(cases)).toHaveLength(7);
    expect(await db.select().from(documents)).toHaveLength(seeded.reduce((n, s) => n + s.documents, 0));
  });

  it('the scanned fixture really fails OCR through the real ingest pipeline', async () => {
    const docs = await db.select().from(documents).where(eq(documents.caseId, caseOf('unreadable')));
    const pdf = docs.find((d) => d.filename.endsWith('.pdf'))!;
    expect(pdf.pages.map((p) => p.ocr_status)).toEqual(['not_needed', 'failed', 'not_needed']);
  });
});

describe('review through the platform', () => {
  it('runs idempotently, versions the review and persists verified findings', async () => {
    const id = caseOf('complete');
    const first = await runReview(db, { caseId: id, actorId: U.handlerA.id });
    const second = await runReview(db, { caseId: id, actorId: U.handlerA.id });
    expect(first.state).toBe('ran');
    expect(second.state).toBe('replayed');
    const st = await loadState(db, id);
    expect(st.review).toMatchObject({ mode: 'synthetic', modelId: 'synthetic-v1', promptVersion: renewalAgent.promptVersion });
    expect(st.findings).toHaveLength(11);
    expect(st.findings.every((f) => f.evidence.every((e) => e.verified))).toBe(true);
    expect(st.findings.find((f) => f.key === 'renewal:copay')).toMatchObject({ classification: 'confirmed_change' });
  });

  it('mismatched pair: only pair findings, no term findings', async () => {
    const st = await loadState(db, await reviewed('mismatched'));
    expect(st.findings.map((f) => f.classification)).toEqual(['mismatched_pair', 'mismatched_pair']);
  });

  it('duplicate renewal copies: one finding per term', async () => {
    const st = await loadState(db, await reviewed('duplicate'));
    expect(st.findings.map((f) => f.key).sort()).toEqual(['renewal:copay', 'renewal:premium', 'renewal:room_rent', 'renewal:sum_insured']);
  });
});

describe('reviewer decisions and KPI events', () => {
  it('confirm / reject / clarify map to decideFinding and are audited; reject needs a note', async () => {
    const id = await reviewed('complete');
    const premium = await finding(id, 'renewal:premium');
    await expect(recordDecision(db, { caseId: id, findingId: premium.id, user: U.handlerA, choice: 'reject', note: '' })).rejects.toThrow(/note is required/);
    await recordDecision(db, { caseId: id, findingId: premium.id, user: U.handlerA, choice: 'confirm', note: '' });
    expect((await finding(id, 'renewal:premium')).status).toBe('accepted');
    const copay = await finding(id, 'renewal:copay');
    await recordDecision(db, { caseId: id, findingId: copay.id, user: U.handlerA, choice: 'clarify', note: 'age band unclear' });
    const after = await finding(id, 'renewal:copay');
    expect(after.status).toBe('overridden');
    expect(after.decision?.note).toBe('[needs insurer clarification] age band unclear');
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.caseId, id), eq(auditLog.action, 'finding.decided')));
    expect(audits).toHaveLength(2);
  });

  it('a finding from another case cannot be decided through this case', async () => {
    const id = await reviewed('complete');
    const other = await reviewed('partial');
    const foreign = await finding(other, 'renewal:premium');
    await expect(recordDecision(db, { caseId: id, findingId: foreign.id, user: U.handlerA, choice: 'confirm', note: '' })).rejects.toThrow(/not found/i);
  });

  it('emits reviewer_override, false_match and finding_corrected once each, source=fixture, with a dedupe key', async () => {
    const id = await reviewed('rephrasing');
    const f = await finding(id, 'renewal:premium'); // rephrasing_only = a "same" match
    await recordDecision(db, { caseId: id, findingId: f.id, user: U.handlerA, choice: 'reject', note: 'amounts differ on page 1' });
    await recordDecision(db, { caseId: id, findingId: f.id, user: U.handlerA, choice: 'reject', note: 'amounts differ on page 1 (again)' });
    await recordCorrection(db, { caseId: id, findingId: f.id, user: U.handlerA, to: 'confirmed_change', reason: 'reviewer read both pages' });
    const ev = await db.select().from(kpiEvents).where(eq(kpiEvents.caseId, id));
    const kinds = ev.map((e) => e.kind).sort();
    expect(kinds).toEqual(['false_match', 'finding_corrected', 'reviewer_override']);
    expect(ev.every((e) => e.source === 'fixture' && e.module === 'renewal-agent' && !!e.dedupeKey)).toBe(true);
    expect((await finding(id, 'renewal:premium')).corrections).toHaveLength(1);
    await expect(recordCorrection(db, { caseId: id, findingId: f.id, user: U.handlerA, to: 'bogus', reason: 'x y z' })).rejects.toThrow();
  });

  it('rejecting a confirmed change is an override but not a false match', async () => {
    const id = await reviewed('complete');
    const f = await finding(id, 'renewal:premium');
    await recordDecision(db, { caseId: id, findingId: f.id, user: U.handlerA, choice: 'reject', note: 'not a change' });
    const kinds = (await db.select().from(kpiEvents).where(eq(kpiEvents.caseId, id))).map((e) => e.kind);
    expect(kinds).toEqual(['reviewer_override']);
  });

  it('a case outside the fixtures is source=pilot for every event (never mixed on one case)', () => {
    expect(kpiSourceFor('REN-FX-101')).toBe('fixture');
    expect(kpiSourceFor('REN-3001')).toBe('pilot');
  });
});

describe('supervisor approval, acknowledgement and export', () => {
  it('approval: supervisor only, blocked while findings are open, bound to the exact text version, emits review_minutes once', async () => {
    const id = await reviewed('complete');
    const v = (await currentVersion(id, 'en'));
    await expect(approveExplanation(db, { caseId: id, user: U.supervisor, lang: 'en', version: v })).rejects.toThrow(/still need a reviewer decision/);
    await decideAll(id);
    const v2 = await currentVersion(id, 'en');
    await expect(approveExplanation(db, { caseId: id, user: U.handlerA, lang: 'en', version: v2 })).rejects.toThrow(/Only a supervisor/);
    await expect(approveExplanation(db, { caseId: id, user: U.supervisor, lang: 'en', version: 'renewal-expl-1-en:000000000000' })).rejects.toThrow(/changed since/);
    await approveExplanation(db, { caseId: id, user: U.supervisor, lang: 'en', version: v2 });
    await approveExplanation(db, { caseId: id, user: U.supervisor, lang: 'hi', version: await currentVersion(id, 'hi') });
    const minutes = await db.select().from(kpiEvents).where(and(eq(kpiEvents.caseId, id), eq(kpiEvents.kind, 'review_minutes')));
    expect(minutes).toHaveLength(1);
    expect(Number(minutes[0]!.value)).toBeGreaterThanOrEqual(0);
    expect(minutes[0]!.source).toBe('fixture');
    expect(minutes[0]!.dedupeKey).toBeTruthy();
  });

  it('acknowledgement: needs a current approved explanation and a confirmed change; records who, when, channel, text version; one KPI event with it', async () => {
    const id = await reviewed('complete');
    await decideAll(id);
    const copay = await finding(id, 'renewal:copay');
    const input = { customerName: 'Anita Deshpande', channel: 'phone' as const, lang: 'en' as const };
    await expect(recordAcknowledgement(db, { caseId: id, findingId: copay.id, user: U.handlerA, input })).rejects.toThrow(/supervisor must approve/);

    const ver = await currentVersion(id, 'en');
    await approveExplanation(db, { caseId: id, user: U.supervisor, lang: 'en', version: ver });
    await recordAcknowledgement(db, { caseId: id, findingId: copay.id, user: U.handlerA, input });

    const [ack] = await db.select().from(acknowledgements).where(eq(acknowledgements.findingId, copay.id));
    expect(ack).toMatchObject({ acknowledgedBy: 'Anita Deshpande', recordedBy: U.handlerA.id, language: 'en', caseId: id });
    expect(ack!.createdAt).toBeInstanceOf(Date);
    const note = parseAckNote(ack!.note)!;
    expect(note).toMatchObject({ channel: 'phone', textVersion: ver });
    expect(new Date(note.acknowledgedAt).getTime()).toBeGreaterThan(0);
    const ev = await db.select().from(kpiEvents).where(and(eq(kpiEvents.caseId, id), eq(kpiEvents.kind, 'change_acknowledged')));
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ source: 'fixture', dedupeKey: `rn:ack:${copay.id}` });
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.caseId, id), eq(auditLog.action, 'renewal.change_acknowledged')));
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits[0]!.meta)).not.toContain('Anita'); // no customer text in audit

    // once per change
    await expect(recordAcknowledgement(db, { caseId: id, findingId: copay.id, user: U.handlerA, input })).rejects.toThrow(/already recorded/);
    // Hindi was never approved, so a Hindi acknowledgement is refused
    const prem = await finding(id, 'renewal:premium');
    await expect(recordAcknowledgement(db, { caseId: id, findingId: prem.id, user: U.handlerA, input: { ...input, lang: 'hi' } })).rejects.toThrow(/supervisor must approve/);
    // validation
    await expect(recordAcknowledgement(db, { caseId: id, findingId: prem.id, user: U.handlerA, input: { ...input, customerName: ' ' } })).rejects.toThrow();
    await expect(recordAcknowledgement(db, { caseId: id, findingId: prem.id, user: U.handlerA, input: { ...input, channel: 'carrier-pigeon' as never } })).rejects.toThrow();
  });

  it('only material confirmed changes can be acknowledged', async () => {
    const id = await reviewed('complete');
    await decideAll(id);
    await approveExplanation(db, { caseId: id, user: U.supervisor, lang: 'en', version: await currentVersion(id, 'en') });
    const unchanged = await finding(id, 'renewal:exclusion:treatment-obesity-weight-control');
    await expect(recordAcknowledgement(db, { caseId: id, findingId: unchanged.id, user: U.handlerA, input: { customerName: 'A B', channel: 'email', lang: 'en' } })).rejects.toThrow(/material confirmed change/);
  });

  it('changing a decision after approval makes the approval stale, so acknowledgement is refused until re-approved', async () => {
    const id = await reviewed('complete');
    await decideAll(id);
    await approveExplanation(db, { caseId: id, user: U.supervisor, lang: 'en', version: await currentVersion(id, 'en') });
    const deductible = await finding(id, 'renewal:deductible');
    await recordDecision(db, { caseId: id, findingId: deductible.id, user: U.handlerA, choice: 'reject', note: 'misread' });
    const premium = await finding(id, 'renewal:premium');
    await expect(recordAcknowledgement(db, { caseId: id, findingId: premium.id, user: U.handlerA, input: { customerName: 'A B', channel: 'phone', lang: 'en' } })).rejects.toThrow(/supervisor must approve/);
    await expect(recordAcknowledgement(db, { caseId: id, findingId: deductible.id, user: U.handlerA, input: { customerName: 'A B', channel: 'phone', lang: 'en' } })).rejects.toBeInstanceOf(RenewalError);
  });

  it('a mismatched pair blocks approval until the flag is resolved', async () => {
    const id = await reviewed('mismatched');
    await expect(approveExplanation(db, { caseId: id, user: U.supervisor, lang: 'en', version: await currentVersion(id, 'en') })).rejects.toThrow(/mismatched/);
  });

  it('export: refused before approval; CSV after; audited; rows carry decisions and acknowledgements', async () => {
    const id = await reviewed('complete');
    await expect(exportData(db, { caseId: id, user: U.supervisor })).rejects.toThrow(/needs supervisor approval/);
    await decideAll(id);
    await approveExplanation(db, { caseId: id, user: U.supervisor, lang: 'en', version: await currentVersion(id, 'en') });
    const copay = await finding(id, 'renewal:copay');
    await recordAcknowledgement(db, { caseId: id, findingId: copay.id, user: U.handlerA, input: { customerName: 'Anita Deshpande', channel: 'in_person', lang: 'en' } });

    const { rows } = await exportData(db, { caseId: id, user: U.supervisor });
    const csv = toCsv(rows);
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toBe('Field,Item,Classification,Material,Old value,New value,Old source pages,New source pages,Old quote,New quote,Reviewer decision,Reviewer note,Acknowledged by,Channel,Text version,Recorded at');
    expect(lines).toHaveLength(12);
    const copayRow = rows.find((r) => r.field === 'copay')!;
    expect(copayRow).toMatchObject({ oldValue: '0% (all claims)', newValue: '20% (claims for insured persons aged 61+)', oldPages: 'schedule p1', newPages: 'renewal p2', decision: 'confirmed', acknowledgedBy: 'Anita Deshpande', ackChannel: 'in_person' });
    const sum = rows.find((r) => r.field === 'sum_insured')!;
    expect(sum.oldPages).toBe('schedule p1; endorsement END-01 p1');
    expect((await db.select().from(auditLog).where(eq(auditLog.action, 'renewal.exported'))).length).toBe(1);
  });
});

describe('csv safety', () => {
  it('neutralises spreadsheet formulas and quotes separators', () => {
    expect(csvCell('=HYPERLINK("http://x")')).toBe(`"'=HYPERLINK(""http://x"")"`);
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('-1')).toBe("'-1");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell(null)).toBe('');
  });
});

describe('access rules the actions rely on', () => {
  it('handlers see only their own cases; analysts cannot write', async () => {
    const [c] = await db.select().from(cases).where(eq(cases.id, caseOf('complete')));
    expect(canAccessCase(U.handlerA, c!, 'write')).toBe(true);
    expect(canAccessCase(U.handlerB, c!, 'read')).toBe(false);
    expect(canAccessCase(U.analyst, c!, 'read')).toBe(true);
    expect(canAccessCase(U.analyst, c!, 'write')).toBe(false);
  });
});

async function currentVersion(caseId: string, lang: 'en' | 'hi') {
  const st = await loadState(db, caseId);
  return buildExplanation(st.findings.map(toExplainFinding), lang).version;
}

describe('export rows without a review', () => {
  it('no findings gives an empty export body', () => {
    expect(buildExportRows([], [])).toEqual([]);
    expect(findings).toBeDefined();
  });
});
