import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { acknowledgements, findings, kpiEvents } from '@/db/schema';
import { canAccessCase } from '@/lib/access';
import { FindingError } from '@/lib/findings';
import { MemoryStorage } from '@/lib/storage';
import { seedDisclosureFixtures } from '@/modules/disclosure-checker/fixtures';
import { buildCsv, buildText, csvCell, RECORD_NOTICE } from '@/modules/disclosure-checker/report';
import { approveReview, loadState, resolveFinding } from '@/modules/disclosure-checker/resolve';
import { freshDb, U } from './helpers';

async function setup() {
  const db = await freshDb();
  const seeded = await seedDisclosureFixtures(db, { ownerId: U.handlerA.id, storage: new MemoryStorage() });
  const caseId = seeded.find((s) => s.name === 'contradictory')!.caseId;
  const rows = await db.select().from(findings).where(eq(findings.caseId, caseId));
  return { db, caseId, rows, seeded };
}
const confirm = (over: Record<string, unknown> = {}) => ({
  outcome: 'customer_confirmed', customerName: 'Neelam Joshi', channel: 'call', confirmedAt: '2026-03-05', value: 'Yes, diabetes since 2019', proposalChange: 'change_needed', note: '', ...over,
});
const args = (caseId: string, findingId: string, input: unknown, user = U.handlerA) => ({ caseId, findingId, actorId: user.id, role: user.role, input });

describe('advisor resolution', () => {
  it('records who, when and channel, keeps history on re-resolution, and counts the KPI once', async () => {
    const { db, caseId, rows } = await setup();
    const f = rows[0]!;
    await resolveFinding(db, args(caseId, f.id, confirm()));
    const [ack] = await db.select().from(acknowledgements).where(eq(acknowledgements.findingId, f.id));
    expect(ack!.acknowledgedBy).toBe('Neelam Joshi');
    expect(JSON.parse(ack!.note!)).toMatchObject({ channel: 'call', value: 'Yes, diabetes since 2019', recordedBy: U.handlerA.id });
    expect(JSON.parse(ack!.note!).confirmedAt).toContain('2026-03-05');
    let [row] = await db.select().from(findings).where(eq(findings.id, f.id));
    expect(row).toMatchObject({ status: 'accepted' });
    expect(row!.corrections).toHaveLength(0);

    // The customer corrects themselves later: the first confirmation must stay in the history.
    await resolveFinding(db, args(caseId, f.id, confirm({ value: 'Yes, diabetes since 2018', channel: 'email', note: 'customer wrote back' })));
    [row] = await db.select().from(findings).where(eq(findings.id, f.id));
    expect(row!.corrections).toHaveLength(1);
    expect(JSON.stringify(row!.corrections[0]!.from)).toContain('Yes, diabetes since 2019');
    const [ack2] = await db.select().from(acknowledgements).where(eq(acknowledgements.findingId, f.id));
    expect(JSON.parse(ack2!.note!)).toMatchObject({ value: 'Yes, diabetes since 2018', channel: 'email' });

    const kpis = await db.select().from(kpiEvents).where(and(eq(kpiEvents.caseId, caseId), eq(kpiEvents.kind, 'finding_corrected')));
    expect(kpis).toHaveLength(1);
    expect(kpis[0]).toMatchObject({ source: 'fixture', module: 'disclosure-checker', dedupeKey: `dc:finding_corrected:${f.id}` });
  });

  it('emits reviewer_override and false_match, and no correction KPI when the proposal answer stands', async () => {
    const { db, caseId, rows } = await setup();
    await resolveFinding(db, args(caseId, rows[0]!.id, { outcome: 'resolved', reason: 'no_action_needed', note: 'checked the form' }));
    await resolveFinding(db, args(caseId, rows[1]!.id, { outcome: 'resolved', reason: 'false_match', note: 'wrong row' }));
    await resolveFinding(db, args(caseId, rows[2]!.id, confirm({ proposalChange: 'proposal_correct' })));
    const kinds = (await db.select().from(kpiEvents).where(eq(kpiEvents.caseId, caseId))).map((k) => k.kind).sort();
    expect(kinds).toEqual(['false_match', 'reviewer_override']);
    const after = await db.select().from(findings).where(eq(findings.caseId, caseId));
    expect(after.map((r) => r.status).sort()).toEqual(['accepted', 'dismissed', 'overridden']);
  });

  it('validates on the server and rejects foreign findings', async () => {
    const { db, caseId, rows, seeded } = await setup();
    const f = rows[0]!;
    await expect(resolveFinding(db, args(caseId, f.id, confirm({ confirmedAt: '2999-01-01' })))).rejects.toBeInstanceOf(FindingError);
    await expect(resolveFinding(db, args(caseId, f.id, confirm({ channel: 'carrier-pigeon' })))).rejects.toBeInstanceOf(FindingError);
    await expect(resolveFinding(db, args(caseId, f.id, confirm({ value: '' })))).rejects.toBeInstanceOf(FindingError);
    await expect(resolveFinding(db, args(caseId, f.id, { outcome: 'resolved', reason: 'no_action_needed', note: '' }))).rejects.toBeInstanceOf(FindingError);
    const other = seeded.find((s) => s.name === 'partial')!.caseId;
    await expect(resolveFinding(db, args(other, f.id, confirm()))).rejects.toBeInstanceOf(FindingError); // finding belongs to another case
    expect((await db.select().from(findings).where(eq(findings.id, f.id)))[0]!.status).toBe('open');
  });

  it('escalation keeps the finding open and only a supervisor can then resolve it', async () => {
    const { db, caseId, rows } = await setup();
    const f = rows[0]!;
    await resolveFinding(db, args(caseId, f.id, { outcome: 'escalate', note: 'customer unsure' }));
    expect((await loadState(db, caseId)).findings.find((x) => x.id === f.id)).toMatchObject({ status: 'open', escalated: true });
    await expect(resolveFinding(db, args(caseId, f.id, confirm()))).rejects.toBeInstanceOf(FindingError);
    await resolveFinding(db, args(caseId, f.id, confirm(), U.supervisor));
    expect((await loadState(db, caseId)).findings.find((x) => x.id === f.id)).toMatchObject({ status: 'accepted', escalated: false });
  });
});

describe('supervisor approval', () => {
  it('needs a supervisor and no open findings, records review_minutes once, and is withdrawn by later changes', async () => {
    const { db, caseId, rows } = await setup();
    await expect(approveReview(db, { caseId, actorId: U.handlerA.id, role: 'handler' })).rejects.toBeInstanceOf(FindingError);
    await expect(approveReview(db, { caseId, actorId: U.supervisor.id, role: 'supervisor' })).rejects.toThrow(/still open/);
    for (const r of rows) await resolveFinding(db, args(caseId, r.id, { outcome: 'resolved', reason: 'no_action_needed', note: 'verified' }));
    await approveReview(db, { caseId, actorId: U.supervisor.id, role: 'supervisor' });
    await approveReview(db, { caseId, actorId: U.supervisor.id, role: 'supervisor' });
    const mins = await db.select().from(kpiEvents).where(and(eq(kpiEvents.caseId, caseId), eq(kpiEvents.kind, 'review_minutes')));
    expect(mins).toHaveLength(1);
    expect(Number(mins[0]!.value)).toBeGreaterThanOrEqual(0);
    expect((await loadState(db, caseId)).approval).toMatchObject({ by: 'Supervisor', valid: true });
    await new Promise((r) => setTimeout(r, 5));
    await resolveFinding(db, args(caseId, rows[0]!.id, confirm()));
    expect((await loadState(db, caseId)).approval!.valid).toBe(false);
  });

  it('keeps one KPI source per case', async () => {
    const { db, caseId, rows } = await setup();
    await resolveFinding(db, args(caseId, rows[0]!.id, confirm()));
    await resolveFinding(db, args(caseId, rows[1]!.id, { outcome: 'resolved', reason: 'false_match', note: 'wrong row' }));
    const sources = new Set((await db.select().from(kpiEvents).where(eq(kpiEvents.caseId, caseId))).map((k) => k.source));
    expect([...sources]).toEqual(['fixture']);
  });
});

describe('report export', () => {
  it('marks the record as advisor record, keeps both passages, history and approval, and defuses formulas', async () => {
    const { db, caseId, rows } = await setup();
    await resolveFinding(db, args(caseId, rows[0]!.id, confirm({ value: '=HYPERLINK("http://x")' })));
    await resolveFinding(db, args(caseId, rows[0]!.id, confirm()));
    const state = await loadState(db, caseId);
    const meta = { reference: 'DSC-F-004', insurer: 'Bluebird Health', title: 't', generatedAt: new Date(), generatedBy: 'Asha' };
    const csv = buildCsv(state, meta);
    const lines = csv.trim().split('\r\n');
    expect(lines).toHaveLength(1 + state.findings.length);
    expect(csv).toContain(RECORD_NOTICE);
    expect(csv).toContain('not approved');
    expect(csv).toContain('"Yes, diabetes since 2019"');
    expect(csv).toMatch(/customer_quote/);
    expect(csv).toContain('Q1 | Diabetes or raised blood sugar | No');
    const txt = buildText(state, meta);
    expect(txt).toContain('never completes medical answers');
    expect(txt).toContain('Not an underwriting decision');
    expect(txt).toContain('History');
    expect(txt).toContain('Synthetic');
    expect(csvCell('=1+1')).toBe(`"'=1+1"`);
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
  });
});

describe('case access', () => {
  it('a handler cannot reach another handler\'s disclosure case; analysts are read-only', () => {
    const c = { ownerId: U.handlerA.id };
    expect(canAccessCase(U.handlerB, c, 'read')).toBe(false);
    expect(canAccessCase(U.analyst, c, 'write')).toBe(false);
    expect(canAccessCase(U.analyst, c, 'read')).toBe(true);
  });
});
