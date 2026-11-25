import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { cases, findings, kpiEvents, reviews } from '@/db/schema';
import { FIXTURE_REF_PREFIX } from './fixtures';

export type ClaimKpiKind = 'review_minutes' | 'repeat_request' | 'finding_corrected' | 'reviewer_override' | 'false_match';

/** One source per case, decided by the case itself, so fixture and pilot data never mix on a case. */
export const kpiSourceFor = (reference: string): 'fixture' | 'pilot' => (reference.startsWith(FIXTURE_REF_PREFIX) ? 'fixture' : 'pilot');

/** Classifications that assert a match: a human rejecting them is a false match. */
const MATCH_ASSERTIONS = ['satisfied_pending_verification', 'partially_satisfied'];
const MAX_MINUTES = 480;

async function emit(db: Db, a: { caseId: string; kind: ClaimKpiKind; value?: number; dedupeKey: string; meta?: Record<string, unknown> }): Promise<void> {
  const [c] = await db.select({ reference: cases.reference }).from(cases).where(eq(cases.id, a.caseId));
  if (!c) return;
  await db
    .insert(kpiEvents)
    .values({
      caseId: a.caseId,
      module: 'claim-reconciler',
      kind: a.kind,
      value: String(a.value ?? 1),
      source: kpiSourceFor(c.reference),
      meta: a.meta,
      dedupeKey: a.dedupeKey,
    })
    .onConflictDoNothing({ target: kpiEvents.dedupeKey });
}

/** After a review: one repeat_request event per repeated-request finding. Re-running a review adds nothing. */
export async function emitRunKpis(db: Db, caseId: string): Promise<number> {
  const [rev] = await db.select().from(reviews).where(eq(reviews.caseId, caseId)).orderBy(desc(reviews.version)).limit(1);
  if (!rev) return 0;
  const rows = await db.select().from(findings).where(and(eq(findings.reviewId, rev.id), eq(findings.classification, 'repeated_request')));
  for (const f of rows) await emit(db, { caseId, kind: 'repeat_request', dedupeKey: `claim:repeat_request:${f.id}`, meta: { findingId: f.id, reviewVersion: rev.version } });
  return rows.length;
}

/**
 * After a handler decision. review_minutes = minutes from the finding being raised to the first
 * decision on it (capped at 8h): a wait-inclusive proxy, recorded as such in meta.basis.
 */
export async function emitDecisionKpis(db: Db, a: { findingId: string; decision: 'accept' | 'override' | 'dismiss' }): Promise<void> {
  const [f] = await db.select().from(findings).where(eq(findings.id, a.findingId));
  if (!f) return;
  const minutes = Math.min(MAX_MINUTES, Math.max(0, (Date.now() - f.createdAt.getTime()) / 60_000));
  await emit(db, {
    caseId: f.caseId,
    kind: 'review_minutes',
    value: Math.round(minutes * 100) / 100,
    dedupeKey: `claim:review_minutes:${f.id}`,
    meta: { findingId: f.id, basis: 'finding_created_to_first_decision' },
  });
  if (a.decision === 'override') {
    await emit(db, { caseId: f.caseId, kind: 'reviewer_override', dedupeKey: `claim:reviewer_override:${f.id}`, meta: { findingId: f.id, classification: f.classification } });
  }
  if (a.decision !== 'accept' && MATCH_ASSERTIONS.includes(f.classification)) {
    await emit(db, { caseId: f.caseId, kind: 'false_match', dedupeKey: `claim:false_match:${f.id}`, meta: { findingId: f.id, classification: f.classification } });
  }
}

/** After a classification correction (the finding row already holds the new value and history). */
export async function emitCorrectionKpis(db: Db, a: { findingId: string }): Promise<void> {
  const [f] = await db.select().from(findings).where(eq(findings.id, a.findingId));
  if (!f) return;
  const last = f.corrections[f.corrections.length - 1];
  if (!last) return;
  await emit(db, {
    caseId: f.caseId,
    kind: 'finding_corrected',
    dedupeKey: `claim:finding_corrected:${f.id}:${f.corrections.length}`,
    meta: { findingId: f.id, from: String(last.from), to: String(last.to) },
  });
  if (MATCH_ASSERTIONS.includes(String(last.from)) && last.from !== last.to) {
    await emit(db, { caseId: f.caseId, kind: 'false_match', dedupeKey: `claim:false_match:${f.id}`, meta: { findingId: f.id, classification: String(last.from) } });
  }
}
