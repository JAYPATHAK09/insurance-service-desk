import { and, eq, lt, sql } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { jobs } from '@/db/schema';

export const MAX_ATTEMPTS = 3;

export type JobOutcome<T> =
  | { state: 'ran'; result: T; attempts: number }
  | { state: 'replayed'; result: T; attempts: number }
  | { state: 'in_progress' }
  | { state: 'exhausted'; error: string | null };

export interface JobSpec<T extends Record<string, unknown>> {
  idempotencyKey: string;
  type: string;
  caseId?: string | null;
  run: () => Promise<T>;
}

/**
 * Idempotent runner. The unique idempotency_key is the lock:
 *  - first caller inserts the row and runs the work;
 *  - a later caller with a succeeded key gets the stored result (replayed), nothing re-runs;
 *  - a failed job is retried (attempts+1) up to MAX_ATTEMPTS;
 *  - a running job is not run twice.
 * Results must be small structured data (ids, counts), never document text.
 */
export async function runJob<T extends Record<string, unknown>>(db: Db, spec: JobSpec<T>): Promise<JobOutcome<T>> {
  const inserted = await db
    .insert(jobs)
    .values({ idempotencyKey: spec.idempotencyKey, type: spec.type, caseId: spec.caseId ?? null, status: 'running' })
    .onConflictDoNothing({ target: jobs.idempotencyKey })
    .returning({ id: jobs.id, attempts: jobs.attempts });

  let claim = inserted[0];
  if (!claim) {
    const [existing] = await db.select().from(jobs).where(eq(jobs.idempotencyKey, spec.idempotencyKey));
    if (!existing) return { state: 'in_progress' };
    if (existing.status === 'succeeded') {
      return { state: 'replayed', result: (existing.result ?? {}) as T, attempts: existing.attempts };
    }
    if (existing.status === 'running') return { state: 'in_progress' };
    if (existing.attempts >= MAX_ATTEMPTS) return { state: 'exhausted', error: existing.error };
    // Atomic re-claim of a failed job.
    const reclaimed = await db
      .update(jobs)
      .set({ status: 'running', attempts: sql`${jobs.attempts} + 1`, updatedAt: new Date() })
      .where(and(eq(jobs.id, existing.id), eq(jobs.status, 'failed'), lt(jobs.attempts, MAX_ATTEMPTS)))
      .returning({ id: jobs.id, attempts: jobs.attempts });
    if (!reclaimed[0]) return { state: 'in_progress' };
    claim = reclaimed[0];
  }

  try {
    const result = await spec.run();
    await db
      .update(jobs)
      .set({ status: 'succeeded', result, error: null, updatedAt: new Date() })
      .where(eq(jobs.id, claim.id));
    return { state: 'ran', result, attempts: claim.attempts };
  } catch (err) {
    // Store the error class only: messages can echo document text.
    const label = err instanceof Error ? err.name : 'Error';
    await db.update(jobs).set({ status: 'failed', error: label, updatedAt: new Date() }).where(eq(jobs.id, claim.id));
    throw err;
  }
}
