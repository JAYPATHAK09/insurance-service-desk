import { eq } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { findings, type Correction, type ReviewerDecision } from '@/db/schema';
import { audit } from './audit';
import { refreshAttention } from './cases';

export class FindingError extends Error {}

const DECISION_TO_STATUS = { accept: 'accepted', override: 'overridden', dismiss: 'dismissed' } as const;

/**
 * Record a human decision on a finding. Overrides require a note. The caller must already have
 * passed requireCaseAccess(..., 'write') for the finding's case.
 */
export async function decideFinding(
  db: Db,
  args: { findingId: string; actorId: string; decision: ReviewerDecision['decision']; note: string },
) {
  const note = args.note.trim();
  if (args.decision !== 'accept' && note.length < 3) throw new FindingError('A note is required to override or dismiss');
  if (note.length > 1000) throw new FindingError('Note too long');
  const [f] = await db.select().from(findings).where(eq(findings.id, args.findingId));
  if (!f) throw new FindingError('Finding not found');
  const decision: ReviewerDecision = { by: args.actorId, decision: args.decision, note, at: new Date().toISOString() };
  await db.update(findings).set({ decision, status: DECISION_TO_STATUS[args.decision] }).where(eq(findings.id, f.id));
  await audit(db, {
    actorId: args.actorId,
    action: 'finding.decided',
    caseId: f.caseId,
    entity: 'finding',
    entityId: f.id,
    meta: { decision: args.decision, classification: f.classification },
  });
  await refreshAttention(db, f.caseId);
  return f.caseId;
}

/** Correct the classification; the previous value is kept in the corrections history. */
export async function correctClassification(
  db: Db,
  args: { findingId: string; actorId: string; to: string; reason: string; allowed: readonly string[] },
) {
  if (!args.allowed.includes(args.to)) throw new FindingError('Unknown classification');
  if (args.reason.trim().length < 3) throw new FindingError('A reason is required');
  const [f] = await db.select().from(findings).where(eq(findings.id, args.findingId));
  if (!f) throw new FindingError('Finding not found');
  const correction: Correction = {
    by: args.actorId,
    at: new Date().toISOString(),
    field: 'classification',
    from: f.classification,
    to: args.to,
    reason: args.reason.trim().slice(0, 500),
  };
  await db
    .update(findings)
    .set({ classification: args.to, corrections: [...f.corrections, correction] })
    .where(eq(findings.id, f.id));
  await audit(db, {
    actorId: args.actorId,
    action: 'finding.corrected',
    caseId: f.caseId,
    entity: 'finding',
    entityId: f.id,
    meta: { field: 'classification', from: f.classification, to: args.to },
  });
  return f.caseId;
}
