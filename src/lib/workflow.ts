import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { cases, findings } from '@/db/schema';
import { audit } from './audit';
import type { Role, WorkflowState } from './contracts';
import { refreshAttention } from './cases';

export const TRANSITIONS: Record<WorkflowState, readonly WorkflowState[]> = {
  intake: ['extraction'],
  extraction: ['evidence_review'],
  evidence_review: ['exception_resolution', 'approval'],
  exception_resolution: ['evidence_review', 'approval'],
  approval: ['exception_resolution', 'exported'],
  exported: [], // only reopen() leaves this state
};

/** States from which a case may be reopened. */
export const REOPENABLE: readonly WorkflowState[] = ['approval', 'exported'];
export const REOPEN_TARGET: WorkflowState = 'evidence_review';

export class WorkflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowError';
  }
}

export interface TransitionContext {
  role: Role;
  openFindings: number;
}

/** Pure guard. Returns an error message, or null when the transition is allowed. */
export function checkTransition(from: WorkflowState, to: WorkflowState, ctx: TransitionContext): string | null {
  if (ctx.role === 'analyst') return 'Analysts are read-only';
  if (!TRANSITIONS[from].includes(to)) return `Cannot move from ${from} to ${to}`;
  if ((to === 'approval' || to === 'exported') && ctx.openFindings > 0) {
    return `${ctx.openFindings} unresolved finding(s) must be resolved first`;
  }
  if (to === 'exported' && ctx.role !== 'supervisor' && ctx.role !== 'handler') return 'Not permitted to export';
  return null;
}

export function checkReopen(from: WorkflowState, reason: string, role: Role): string | null {
  if (role === 'analyst') return 'Analysts are read-only';
  if (!REOPENABLE.includes(from)) return `Cannot reopen a case in ${from}`;
  if (reason.trim().length < 5) return 'A reason of at least 5 characters is required to reopen';
  if (reason.length > 500) return 'Reason is too long';
  return null;
}

async function countOpen(db: Db, caseId: string): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(findings)
    .where(and(eq(findings.caseId, caseId), eq(findings.status, 'open')));
  return r?.n ?? 0;
}

export async function transitionCase(db: Db, args: { caseId: string; to: WorkflowState; actorId: string; role: Role }) {
  const [c] = await db.select().from(cases).where(eq(cases.id, args.caseId));
  if (!c) throw new WorkflowError('Case not found');
  const err = checkTransition(c.status, args.to, { role: args.role, openFindings: await countOpen(db, c.id) });
  if (err) throw new WorkflowError(err);
  // Compare-and-set on the current status so two concurrent moves cannot both succeed.
  const moved = await db
    .update(cases)
    .set({ status: args.to, updatedAt: new Date() })
    .where(and(eq(cases.id, c.id), eq(cases.status, c.status)))
    .returning({ id: cases.id });
  if (!moved.length) throw new WorkflowError('Case state changed concurrently; reload and retry');
  await audit(db, {
    actorId: args.actorId,
    action: 'case.transition',
    caseId: c.id,
    entity: 'case',
    entityId: c.id,
    meta: { from: c.status, to: args.to },
  });
  await refreshAttention(db, c.id);
}

export async function reopenCase(db: Db, args: { caseId: string; reason: string; actorId: string; role: Role }) {
  const [c] = await db.select().from(cases).where(eq(cases.id, args.caseId));
  if (!c) throw new WorkflowError('Case not found');
  const err = checkReopen(c.status, args.reason, args.role);
  if (err) throw new WorkflowError(err);
  const moved = await db
    .update(cases)
    .set({ status: REOPEN_TARGET, reopenCount: sql`${cases.reopenCount} + 1`, updatedAt: new Date() })
    .where(and(eq(cases.id, c.id), eq(cases.status, c.status)))
    .returning({ id: cases.id });
  if (!moved.length) throw new WorkflowError('Case state changed concurrently; reload and retry');
  await audit(db, {
    actorId: args.actorId,
    action: 'case.reopened',
    caseId: c.id,
    entity: 'case',
    entityId: c.id,
    // Reason is operator-typed free text (not document content); length-capped by checkReopen.
    meta: { from: c.status, to: REOPEN_TARGET, reasonText: args.reason.trim().slice(0, 120) },
  });
  await refreshAttention(db, c.id);
}
