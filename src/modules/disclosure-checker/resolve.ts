/**
 * Advisor resolution, customer confirmation, supervisor approval and KPI facts for disclosure findings.
 * Callers must already have passed requireCase(caseId, 'write') (and 'read' for loadState).
 *
 * The tool never writes an answer into a proposal: a "customer confirmed" value is typed by the advisor
 * from what the customer said, stored as the advisor's record, and nothing is submitted anywhere.
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '@/db/client';
import { acknowledgements, auditLog, documents, findings, kpiEvents, reviews, users, type Correction } from '@/db/schema';
import { audit } from '@/lib/audit';
import type { Role } from '@/lib/contracts';
import { FindingError, decideFinding } from '@/lib/findings';

export const CHANNELS = ['call', 'email', 'whatsapp', 'in_person', 'form'] as const;
export type Channel = (typeof CHANNELS)[number];

const Note = z.string().trim().max(1000);

export const ResolveSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('resolved'),
    reason: z.enum(['no_action_needed', 'false_match']),
    note: Note.min(3, 'A note is required'),
  }),
  z.object({
    outcome: z.literal('customer_confirmed'),
    customerName: z.string().trim().min(2, 'Enter who confirmed').max(100),
    channel: z.enum(CHANNELS),
    /** When the customer confirmed (ISO date or datetime), as stated by the advisor. */
    confirmedAt: z.string().trim().min(8).max(40),
    value: z.string().trim().min(1, 'Record the value the customer confirmed').max(300),
    proposalChange: z.enum(['change_needed', 'proposal_correct']),
    note: Note.default(''),
  }),
  z.object({ outcome: z.literal('escalate'), note: Note.min(3, 'A note is required') }),
]);
export type ResolveInput = z.infer<typeof ResolveSchema>;

export interface CustomerConfirmation {
  by: string;
  channel: Channel;
  confirmedAt: string;
  value: string;
  proposalChange: 'change_needed' | 'proposal_correct';
  comment: string;
  recordedBy: string;
  recordedAt: string;
}

const parseDateInput = (s: string): Date | null => {
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** One source per case: reuse what the case already carries, else derive from the review mode. */
async function kpiSource(db: Db, caseId: string, mode: 'synthetic' | 'live'): Promise<'fixture' | 'pilot'> {
  const [row] = await db.select({ s: kpiEvents.source }).from(kpiEvents).where(eq(kpiEvents.caseId, caseId)).limit(1);
  if (row && (row.s === 'fixture' || row.s === 'pilot')) return row.s;
  return mode === 'synthetic' ? 'fixture' : 'pilot';
}

async function emitKpi(db: Db, a: { caseId: string; kind: string; value?: number; dedupeKey: string; mode: 'synthetic' | 'live'; meta?: Record<string, unknown> }) {
  await db
    .insert(kpiEvents)
    .values({
      caseId: a.caseId,
      module: 'disclosure-checker',
      kind: a.kind,
      value: String(a.value ?? 1),
      source: await kpiSource(db, a.caseId, a.mode),
      meta: a.meta,
      dedupeKey: a.dedupeKey,
    })
    .onConflictDoNothing({ target: kpiEvents.dedupeKey });
}

const ACTIONS = ['disclosure.escalated', 'disclosure.resolved', 'disclosure.approved', 'finding.decided', 'finding.corrected'] as const;

export async function isEscalated(db: Db, findingId: string): Promise<boolean> {
  const rows = await db
    .select({ action: auditLog.action })
    .from(auditLog)
    .where(and(eq(auditLog.entityId, findingId), inArray(auditLog.action, ['disclosure.escalated', 'disclosure.resolved'])))
    .orderBy(desc(auditLog.at))
    .limit(1);
  return rows[0]?.action === 'disclosure.escalated';
}

export async function resolveFinding(
  db: Db,
  args: { caseId: string; findingId: string; actorId: string; role: Role; input: unknown },
): Promise<{ outcome: ResolveInput['outcome'] }> {
  const parsed = ResolveSchema.safeParse(args.input);
  if (!parsed.success) throw new FindingError(parsed.error.issues[0]?.message ?? 'Invalid input');
  const input = parsed.data;
  const [f] = await db.select().from(findings).where(eq(findings.id, args.findingId));
  if (!f || f.caseId !== args.caseId || f.module !== 'disclosure-checker') throw new FindingError('Finding not found');
  const [review] = await db.select().from(reviews).where(eq(reviews.id, f.reviewId));
  if (!review) throw new FindingError('Review not found');
  const now = new Date();

  if (input.outcome === 'escalate') {
    await audit(db, { actorId: args.actorId, action: 'disclosure.escalated', caseId: f.caseId, entity: 'finding', entityId: f.id, meta: { classification: f.classification } });
    return { outcome: 'escalate' };
  }
  if ((await isEscalated(db, f.id)) && args.role !== 'supervisor') {
    throw new FindingError('This finding was escalated: a supervisor must resolve it');
  }

  let confirmedAt: Date | null = null;
  if (input.outcome === 'customer_confirmed') {
    confirmedAt = parseDateInput(input.confirmedAt);
    if (!confirmedAt) throw new FindingError('Enter a valid confirmation date');
    if (confirmedAt.getTime() > now.getTime() + 86_400_000) throw new FindingError('The confirmation date cannot be in the future');
  }

  // History is never overwritten: a re-resolution appends what it replaces.
  const history: Correction[] = [];
  const [priorAck] = await db.select().from(acknowledgements).where(eq(acknowledgements.findingId, f.id));
  if (f.decision) {
    history.push({
      by: args.actorId,
      at: now.toISOString(),
      field: 'resolution',
      from: { status: f.status, decision: f.decision.decision, decidedBy: f.decision.by, decidedAt: f.decision.at, note: f.decision.note, customerConfirmation: priorAck ? safeJson(priorAck.note) : null, customerName: priorAck?.acknowledgedBy ?? null },
      to: { outcome: input.outcome },
      reason: ('note' in input && input.note ? input.note : 'Re-resolved').slice(0, 500),
    });
  }

  if (input.outcome === 'resolved') {
    const dismiss = input.reason === 'false_match';
    await decideFinding(db, { findingId: f.id, actorId: args.actorId, decision: dismiss ? 'dismiss' : 'override', note: input.note });
    await emitKpi(db, { caseId: f.caseId, kind: dismiss ? 'false_match' : 'reviewer_override', dedupeKey: `dc:${dismiss ? 'false_match' : 'reviewer_override'}:${f.id}`, mode: review.mode, meta: { classification: f.classification, reviewId: review.id } });
  } else {
    const note = `Customer confirmed value recorded (${input.channel}).${input.note ? ' ' + input.note : ''}`;
    await decideFinding(db, { findingId: f.id, actorId: args.actorId, decision: 'accept', note });
    const record: CustomerConfirmation = {
      by: input.customerName,
      channel: input.channel,
      confirmedAt: confirmedAt!.toISOString(),
      value: input.value,
      proposalChange: input.proposalChange,
      comment: input.note,
      recordedBy: args.actorId,
      recordedAt: now.toISOString(),
    };
    await db
      .insert(acknowledgements)
      .values({ caseId: f.caseId, findingId: f.id, acknowledgedBy: input.customerName, recordedBy: args.actorId, note: JSON.stringify(record) })
      .onConflictDoUpdate({ target: acknowledgements.findingId, set: { acknowledgedBy: input.customerName, recordedBy: args.actorId, note: JSON.stringify(record) } });
    if (input.proposalChange === 'change_needed') {
      await emitKpi(db, { caseId: f.caseId, kind: 'finding_corrected', dedupeKey: `dc:finding_corrected:${f.id}`, mode: review.mode, meta: { classification: f.classification, reviewId: review.id, channel: input.channel } });
    }
  }
  if (history.length) {
    const [fresh] = await db.select({ c: findings.corrections }).from(findings).where(eq(findings.id, f.id));
    await db.update(findings).set({ corrections: [...(fresh?.c ?? []), ...history] }).where(eq(findings.id, f.id));
  }
  await audit(db, {
    actorId: args.actorId,
    action: 'disclosure.resolved',
    caseId: f.caseId,
    entity: 'finding',
    entityId: f.id,
    meta: { outcome: input.outcome, classification: f.classification, ...(input.outcome === 'customer_confirmed' ? { channel: input.channel, proposalChange: input.proposalChange } : { reason: input.reason }), rerun: history.length > 0 },
  });
  return { outcome: input.outcome };
}

function safeJson(s: string | null): unknown {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** Supervisor sign-off of the current review. Requires every finding decided; invalidated by later changes. */
export async function approveReview(db: Db, args: { caseId: string; actorId: string; role: Role }) {
  if (args.role !== 'supervisor') throw new FindingError('Only a supervisor can approve the reconciliation');
  const [review] = await db.select().from(reviews).where(eq(reviews.caseId, args.caseId)).orderBy(desc(reviews.version)).limit(1);
  if (!review || review.module !== 'disclosure-checker') throw new FindingError('Run the comparison first');
  const rows = await db.select().from(findings).where(and(eq(findings.caseId, args.caseId), eq(findings.reviewId, review.id)));
  const open = rows.filter((r) => r.status === 'open').length;
  if (open > 0) throw new FindingError(`${open} finding(s) are still open`);
  await audit(db, { actorId: args.actorId, action: 'disclosure.approved', caseId: args.caseId, entity: 'review', entityId: review.id, meta: { version: review.version, findings: rows.length } });
  const minutes = Math.max(0, Math.round(((Date.now() - review.createdAt.getTime()) / 60_000) * 10) / 10);
  await emitKpi(db, { caseId: args.caseId, kind: 'review_minutes', value: minutes, dedupeKey: `dc:review_minutes:${review.id}`, mode: review.mode, meta: { basis: 'wall_clock_review_created_to_supervisor_approval', reviewId: review.id } });
  return { reviewId: review.id, version: review.version };
}

export type FindingRow = typeof findings.$inferSelect;

export interface WorkspaceState {
  review: typeof reviews.$inferSelect | null;
  docs: Array<{ id: string; filename: string; kind: string; sha256: string }>;
  findings: Array<FindingRow & { escalated: boolean; confirmation: CustomerConfirmation | null; decidedByName: string | null }>;
  approval: { by: string; at: Date; valid: boolean } | null;
  previousReviews: number;
}

export async function loadState(db: Db, caseId: string): Promise<WorkspaceState> {
  const revs = await db.select().from(reviews).where(eq(reviews.caseId, caseId)).orderBy(desc(reviews.version));
  const review = revs[0] ?? null;
  const docs = await db.select({ id: documents.id, filename: documents.filename, kind: documents.kind, sha256: documents.sha256 }).from(documents).where(eq(documents.caseId, caseId));
  if (!review) return { review: null, docs, findings: [], approval: null, previousReviews: 0 };
  const rows = await db.select().from(findings).where(and(eq(findings.caseId, caseId), eq(findings.reviewId, review.id)));
  const acks = await db.select().from(acknowledgements).where(eq(acknowledgements.caseId, caseId));
  const ackBy = new Map(acks.map((a) => [a.findingId, a]));
  const events = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.caseId, caseId), inArray(auditLog.action, [...ACTIONS])))
    .orderBy(auditLog.at);
  const userRows = await db.select({ id: users.id, name: users.name }).from(users);
  const names = new Map(userRows.map((u) => [u.id, u.name]));

  const escalated = new Set<string>();
  for (const e of events) {
    if (!e.entityId) continue;
    if (e.action === 'disclosure.escalated') escalated.add(e.entityId);
    else if (e.action === 'disclosure.resolved') escalated.delete(e.entityId);
  }
  const approvals = events.filter((e) => e.action === 'disclosure.approved' && e.entityId === review.id);
  const last = approvals[approvals.length - 1];
  const changedAfter = last ? events.some((e) => e.at.getTime() > last.at.getTime() && e.action !== 'disclosure.approved') : false;
  return {
    review,
    docs,
    previousReviews: revs.length - 1,
    approval: last ? { by: names.get(last.actorId ?? '') ?? 'unknown', at: last.at, valid: !changedAfter } : null,
    findings: rows.map((r) => {
      const ack = ackBy.get(r.id);
      return {
        ...r,
        escalated: escalated.has(r.id),
        confirmation: ack ? (safeJson(ack.note) as CustomerConfirmation | null) : null,
        decidedByName: r.decision ? (names.get(r.decision.by) ?? r.decision.by) : null,
      };
    }),
  };
}

export const CLASS_ORDER = ['contradiction', 'omission', 'unanswered', 'ambiguous', 'explicit_negative'] as const;

export async function countOpen(db: Db, caseId: string): Promise<number> {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(findings).where(and(eq(findings.caseId, caseId), eq(findings.status, 'open')));
  return r?.n ?? 0;
}
