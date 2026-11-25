import { and, asc, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '@/db/client';
import { acknowledgements, auditLog, cases, findings, kpiEvents, reviews } from '@/db/schema';
import type { SessionUser } from '@/lib/access';
import { audit } from '@/lib/audit';
import { CLASSIFICATIONS } from '@/lib/contracts';
import { correctClassification, decideFinding } from '@/lib/findings';
import { buildExplanation, EXPLANATION_LANGS, type ExplainFinding, type Explanation, type ExplanationLang } from './explain';
import { CLARIFY_PREFIX, FIXTURE_REF_PREFIX } from './types';

export class RenewalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RenewalError';
  }
}

export const CHANNELS = ['phone', 'in_person', 'email', 'whatsapp', 'letter'] as const;
export type Channel = (typeof CHANNELS)[number];
export const CHOICES = ['confirm', 'reject', 'clarify'] as const;
export type Choice = (typeof CHOICES)[number];

export const AckInput = z.object({
  customerName: z.string().trim().min(2).max(120),
  channel: z.enum(CHANNELS),
  lang: z.enum(EXPLANATION_LANGS),
});

/** A case belongs to exactly one KPI source for its whole life, so fixture and pilot events never mix on a case. */
export const kpiSourceFor = (reference: string): 'fixture' | 'pilot' => (reference.startsWith(FIXTURE_REF_PREFIX) ? 'fixture' : 'pilot');

type FindingRow = typeof findings.$inferSelect;
type AckRow = typeof acknowledgements.$inferSelect;

export interface AckNote {
  channel: Channel;
  textVersion: string;
  acknowledgedAt: string;
}
export function parseAckNote(note: string | null): AckNote | null {
  if (!note) return null;
  try {
    const j = JSON.parse(note) as Partial<AckNote>;
    if (typeof j.channel === 'string' && typeof j.textVersion === 'string' && typeof j.acknowledgedAt === 'string') return j as AckNote;
  } catch {
    /* free text note from elsewhere */
  }
  return null;
}

export const isClarify = (f: Pick<FindingRow, 'status' | 'decision'>) =>
  f.status === 'overridden' && (f.decision?.note ?? '').startsWith(CLARIFY_PREFIX.trim());

export const decisionLabel = (f: Pick<FindingRow, 'status' | 'decision'>): 'confirmed' | 'rejected' | 'needs clarification' | 'open' =>
  f.status === 'open' ? 'open' : isClarify(f) ? 'needs clarification' : f.status === 'dismissed' ? 'rejected' : 'confirmed';

export const toExplainFinding = (f: FindingRow): ExplainFinding => ({
  id: f.id,
  classification: f.classification,
  status: f.status,
  decisionNote: f.decision?.note ?? null,
  attributes: f.attributes,
});

// ---------- state ----------

export async function loadState(db: Db, caseId: string) {
  const [c] = await db.select().from(cases).where(eq(cases.id, caseId));
  if (!c) throw new RenewalError('Case not found');
  const [review] = await db.select().from(reviews).where(eq(reviews.caseId, caseId)).orderBy(desc(reviews.version)).limit(1);
  const rows = review ? await db.select().from(findings).where(and(eq(findings.caseId, caseId), eq(findings.reviewId, review.id))).orderBy(asc(findings.key)) : [];
  const acks = await db.select().from(acknowledgements).where(eq(acknowledgements.caseId, caseId));
  const approvals = await listApprovals(db, caseId);
  return { case: c, review: review ?? null, findings: rows, acks, approvals };
}

export interface Approval {
  lang: ExplanationLang;
  version: string;
  by: string | null;
  at: Date;
}

export async function listApprovals(db: Db, caseId: string): Promise<Approval[]> {
  const rows = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.caseId, caseId), eq(auditLog.action, 'renewal.explanation_approved')))
    .orderBy(desc(auditLog.at));
  return rows.flatMap((r) => {
    const m = r.meta as { lang?: string; version?: string };
    return m.lang === 'en' || m.lang === 'hi' ? [{ lang: m.lang, version: String(m.version), by: r.actorId, at: r.at }] : [];
  });
}

/** The newest approval for a language counts, and only while it matches the text that would be generated now. */
export const approvalIsCurrent = (approvals: Approval[], exp: Explanation) =>
  approvals.find((a) => a.lang === exp.lang)?.version === exp.version;

const ATTENTION = ['confirmed_change', 'ambiguous', 'absent_page', 'ocr_failure', 'mismatched_pair'];

export function readiness(rows: FindingRow[]): string | null {
  if (!rows.length) return 'Run a review first.';
  if (rows.some((f) => f.classification === 'mismatched_pair' && f.status !== 'dismissed'))
    return 'The document pair is flagged as mismatched. Reject the flag (if it is wrong) or resolve the pair with the insurer before explaining changes.';
  const open = rows.filter((f) => f.status === 'open' && ATTENTION.includes(f.classification)).length;
  return open ? `${open} finding(s) still need a reviewer decision.` : null;
}

// ---------- decisions ----------

async function getCaseFinding(db: Db, caseId: string, findingId: string): Promise<FindingRow> {
  const [f] = await db.select().from(findings).where(eq(findings.id, findingId));
  if (!f || f.caseId !== caseId || f.module !== 'renewal-agent') throw new RenewalError('Finding not found');
  return f;
}

async function emitKpi(db: Pick<Db, 'insert'>, e: { caseId: string; reference: string; kind: string; value?: number; dedupeKey: string; meta?: Record<string, unknown> }) {
  await db
    .insert(kpiEvents)
    .values({
      caseId: e.caseId,
      module: 'renewal-agent',
      kind: e.kind,
      value: String(e.value ?? 1),
      source: kpiSourceFor(e.reference),
      meta: e.meta,
      dedupeKey: e.dedupeKey,
    })
    .onConflictDoNothing();
}

export async function recordDecision(db: Db, args: { caseId: string; findingId: string; user: SessionUser; choice: Choice; note: string }) {
  const f = await getCaseFinding(db, args.caseId, args.findingId);
  const [c] = await db.select().from(cases).where(eq(cases.id, args.caseId));
  const note = args.note.trim();
  if (args.choice === 'reject' && note.length < 3) throw new RenewalError('A note is required to reject a finding.');
  const decision = args.choice === 'confirm' ? 'accept' : args.choice === 'reject' ? 'dismiss' : 'override';
  const stored = args.choice === 'clarify' ? `${CLARIFY_PREFIX}${note}`.trim() : note;
  await decideFinding(db, { findingId: f.id, actorId: args.user.id, decision, note: stored });
  if (args.choice === 'reject') {
    await emitKpi(db, { caseId: f.caseId, reference: c!.reference, kind: 'reviewer_override', dedupeKey: `rn:override:${f.id}`, meta: { classification: f.classification } });
    if (f.classification === 'unchanged' || f.classification === 'rephrasing_only') {
      await emitKpi(db, { caseId: f.caseId, reference: c!.reference, kind: 'false_match', dedupeKey: `rn:false_match:${f.id}`, meta: { classification: f.classification } });
    }
  }
}

export async function recordCorrection(db: Db, args: { caseId: string; findingId: string; user: SessionUser; to: string; reason: string }) {
  const f = await getCaseFinding(db, args.caseId, args.findingId);
  const [c] = await db.select().from(cases).where(eq(cases.id, args.caseId));
  if (f.classification === args.to) throw new RenewalError('The finding already has that classification.');
  await correctClassification(db, { findingId: f.id, actorId: args.user.id, to: args.to, reason: args.reason, allowed: CLASSIFICATIONS['renewal-agent'] });
  const [after] = await db.select({ n: findings.corrections }).from(findings).where(eq(findings.id, f.id));
  await emitKpi(db, {
    caseId: f.caseId,
    reference: c!.reference,
    kind: 'finding_corrected',
    dedupeKey: `rn:corrected:${f.id}:${after?.n.length ?? 0}`,
    meta: { from: f.classification, to: args.to },
  });
}

// ---------- explanation, approval, acknowledgement ----------

export async function currentExplanation(db: Db, caseId: string, lang: ExplanationLang): Promise<Explanation> {
  const st = await loadState(db, caseId);
  return buildExplanation(st.findings.map(toExplainFinding), lang);
}

/** Supervisor sign-off of one exact text version. Nothing is sent by the platform. */
export async function approveExplanation(db: Db, args: { caseId: string; user: SessionUser; lang: ExplanationLang; version: string }) {
  if (args.user.role !== 'supervisor') throw new RenewalError('Only a supervisor can approve the customer explanation.');
  const st = await loadState(db, args.caseId);
  const blocked = readiness(st.findings);
  if (blocked) throw new RenewalError(blocked);
  const exp = buildExplanation(st.findings.map(toExplainFinding), args.lang);
  if (exp.version !== args.version) throw new RenewalError('The explanation changed since you opened it. Review the new text and approve again.');
  await audit(db, {
    actorId: args.user.id,
    action: 'renewal.explanation_approved',
    caseId: args.caseId,
    entity: 'case',
    entityId: args.caseId,
    meta: { lang: args.lang, version: exp.version, changes: exp.changes.length, clarifications: exp.clarifications.length },
  });
  if (st.review) {
    // Wall-clock minutes from the review being created to the first supervisor approval of its output.
    const minutes = Math.max(0, Math.round(((Date.now() - st.review.createdAt.getTime()) / 60_000) * 100) / 100);
    await emitKpi(db, {
      caseId: args.caseId,
      reference: st.case.reference,
      kind: 'review_minutes',
      value: minutes,
      dedupeKey: `rn:review_minutes:${st.review.id}`,
      meta: { basis: 'review_created_to_first_supervisor_approval', reviewVersion: st.review.version },
    });
  }
  return exp;
}

export async function recordAcknowledgement(db: Db, args: { caseId: string; findingId: string; user: SessionUser; input: z.infer<typeof AckInput> }) {
  const input = AckInput.parse(args.input);
  const f = await getCaseFinding(db, args.caseId, args.findingId);
  if (f.classification !== 'confirmed_change' || !(f.attributes as { material?: boolean } | null)?.material)
    throw new RenewalError('Only a material confirmed change can be acknowledged.');
  if (f.status !== 'accepted') throw new RenewalError('The reviewer must confirm this change before the customer acknowledgement is recorded.');
  const st = await loadState(db, args.caseId);
  const exp = buildExplanation(st.findings.map(toExplainFinding), input.lang);
  if (!approvalIsCurrent(st.approvals, exp)) throw new RenewalError('A supervisor must approve the current customer explanation in this language first.');
  if (!exp.changes.some((i) => i.findingId === f.id)) throw new RenewalError('This change is not part of the approved explanation.');
  if (st.acks.some((a) => a.findingId === f.id)) throw new RenewalError('An acknowledgement is already recorded for this change.');

  const note: AckNote = { channel: input.channel, textVersion: exp.version, acknowledgedAt: new Date().toISOString() };
  await db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    await t.insert(acknowledgements).values({
      caseId: f.caseId,
      findingId: f.id,
      acknowledgedBy: input.customerName,
      recordedBy: args.user.id,
      language: input.lang,
      note: JSON.stringify(note),
    });
    await emitKpi(t, { caseId: f.caseId, reference: st.case.reference, kind: 'change_acknowledged', dedupeKey: `rn:ack:${f.id}`, meta: { channel: input.channel, lang: input.lang, field: (f.attributes as { field?: string })?.field } });
    await audit(t, {
      actorId: args.user.id,
      action: 'renewal.change_acknowledged',
      caseId: f.caseId,
      entity: 'finding',
      entityId: f.id,
      meta: { channel: input.channel, lang: input.lang, textVersion: exp.version },
    });
  });
}

// ---------- export ----------

export interface ExportRow {
  field: string;
  item: string;
  classification: string;
  material: boolean;
  oldValue: string;
  newValue: string;
  oldPages: string;
  newPages: string;
  oldQuote: string;
  newQuote: string;
  decision: string;
  decisionNote: string;
  acknowledgedBy: string;
  ackChannel: string;
  ackTextVersion: string;
  ackRecordedAt: string;
}

export interface SideAttr {
  display?: string;
  sources?: Array<{ filename: string; page: number; quote: string; role?: string; endorsement_no?: string }>;
}
export const pagesOf = (s?: SideAttr | null) =>
  [...new Set((s?.sources ?? []).map((x) => `${x.endorsement_no ? `endorsement ${x.endorsement_no}` : x.role === 'renewal_proposal' ? 'renewal' : 'schedule'} p${x.page}`))].join('; ');

export function buildExportRows(rows: FindingRow[], acks: AckRow[]): ExportRow[] {
  return rows
    .map((f) => {
      const a = (f.attributes ?? {}) as { field?: string; item_label?: string; material?: boolean; old?: SideAttr | null; new?: SideAttr | null };
      const ack = acks.find((x) => x.findingId === f.id);
      const note = parseAckNote(ack?.note ?? null);
      return {
        field: a.field ?? f.type,
        item: a.item_label ?? '',
        classification: f.classification,
        material: Boolean(a.material),
        oldValue: a.old?.display ?? '',
        newValue: a.new?.display ?? '',
        oldPages: pagesOf(a.old),
        newPages: pagesOf(a.new),
        oldQuote: (a.old?.sources ?? []).map((s) => s.quote).join(' | '),
        newQuote: (a.new?.sources ?? []).map((s) => s.quote).join(' | '),
        decision: decisionLabel(f),
        decisionNote: f.decision?.note ?? '',
        acknowledgedBy: ack?.acknowledgedBy ?? '',
        ackChannel: note?.channel ?? '',
        ackTextVersion: note?.textVersion ?? '',
        ackRecordedAt: ack ? ack.createdAt.toISOString() : '',
      };
    });
}

const COLS: Array<[keyof ExportRow, string]> = [
  ['field', 'Field'], ['item', 'Item'], ['classification', 'Classification'], ['material', 'Material'],
  ['oldValue', 'Old value'], ['newValue', 'New value'], ['oldPages', 'Old source pages'], ['newPages', 'New source pages'],
  ['oldQuote', 'Old quote'], ['newQuote', 'New quote'], ['decision', 'Reviewer decision'], ['decisionNote', 'Reviewer note'],
  ['acknowledgedBy', 'Acknowledged by'], ['ackChannel', 'Channel'], ['ackTextVersion', 'Text version'], ['ackRecordedAt', 'Recorded at'],
];

/** CSV with formula-injection protection: document text can start with = + - @ and must not run in a spreadsheet. */
export function csvCell(v: unknown): string {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: ExportRow[]): string {
  const head = COLS.map(([, h]) => csvCell(h)).join(',');
  return [head, ...rows.map((r) => COLS.map(([k]) => csvCell(r[k])).join(','))].join('\r\n') + '\r\n';
}

/** Export requires supervisor approval of at least one current explanation. */
export async function exportData(db: Db, args: { caseId: string; user: SessionUser }) {
  const st = await loadState(db, args.caseId);
  if (!st.review) throw new RenewalError('Run a review first.');
  const current = EXPLANATION_LANGS.map((l) => buildExplanation(st.findings.map(toExplainFinding), l));
  const approved = current.filter((e) => approvalIsCurrent(st.approvals, e));
  if (!approved.length) throw new RenewalError('Export needs supervisor approval of the customer explanation (in at least one language) for the current findings.');
  await audit(db, { actorId: args.user.id, action: 'renewal.exported', caseId: args.caseId, entity: 'case', entityId: args.caseId, meta: { rows: st.findings.length, approvedLangs: approved.map((a) => a.lang) } });
  return { state: st, rows: buildExportRows(st.findings, st.acks), approved };
}
