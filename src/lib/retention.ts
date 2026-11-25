import { and, eq, lt } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { documents, retentionPolicy } from '@/db/schema';
import { audit } from './audit';
import { runJob } from './jobs';
import { getStorage } from './storage';

export const DEFAULT_RETENTION_DAYS = 365;

export async function getRetentionDays(db: Db, scope: 'documents' | 'audit' = 'documents'): Promise<number> {
  const [row] = await db.select().from(retentionPolicy).where(eq(retentionPolicy.scope, scope));
  if (row) return row.days;
  const env = Number(process.env.RETENTION_DAYS);
  return Number.isInteger(env) && env > 0 ? env : DEFAULT_RETENTION_DAYS;
}

export async function setRetentionDays(db: Db, scope: 'documents' | 'audit', days: number, actorId: string) {
  if (!Number.isInteger(days) || days < 1 || days > 3650) throw new Error('days must be an integer 1..3650');
  await db
    .insert(retentionPolicy)
    .values({ scope, days, updatedBy: actorId })
    .onConflictDoUpdate({ target: retentionPolicy.scope, set: { days, updatedBy: actorId, updatedAt: new Date() } });
  await audit(db, { actorId, action: 'retention.policy_set', meta: { scope, days } });
}

/** Delete documents (rows and stored objects) older than the policy. Findings keep their evidence text. */
export async function applyRetention(db: Db, now = new Date(), actorId?: string) {
  const days = await getRetentionDays(db, 'documents');
  const cutoff = new Date(now.getTime() - days * 86_400_000);
  const stale = await db
    .select({ id: documents.id, caseId: documents.caseId, storageKey: documents.storageKey })
    .from(documents)
    .where(lt(documents.createdAt, cutoff));
  const storage = getStorage();
  let deleted = 0;
  for (const d of stale) {
    await storage.delete(d.storageKey);
    const gone = await db.delete(documents).where(and(eq(documents.id, d.id))).returning({ id: documents.id });
    if (gone.length) {
      deleted++;
      await audit(db, {
        actorId,
        action: 'document.deleted_by_retention',
        caseId: d.caseId,
        entity: 'document',
        entityId: d.id,
        meta: { days },
      });
    }
  }
  return { deleted, days, cutoff: cutoff.toISOString() };
}

/** Key part that changes whenever the effective policy does: 0 = no stored policy (env/default days). */
export async function retentionPolicyStamp(db: Db, scope: 'documents' | 'audit' = 'documents'): Promise<number> {
  const [row] = await db.select({ updatedAt: retentionPolicy.updatedAt }).from(retentionPolicy).where(eq(retentionPolicy.scope, scope));
  return row?.updatedAt.getTime() ?? 0;
}

/**
 * Idempotent per calendar day AND per effective policy (days + when it was last set): shortening the
 * retention period the same day is a new run, not a replay of the earlier, longer-period result.
 */
export async function runRetentionJob(db: Db, now = new Date(), actorId?: string) {
  const days = await getRetentionDays(db, 'documents');
  const stamp = await retentionPolicyStamp(db, 'documents');
  return runJob(db, {
    idempotencyKey: `retention:${now.toISOString().slice(0, 10)}:${days}:${stamp}`,
    type: 'retention',
    run: () => applyRetention(db, now, actorId),
  });
}
