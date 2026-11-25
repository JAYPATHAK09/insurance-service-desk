import { desc, eq } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { auditLog } from '@/db/schema';
import { sanitizeRecord } from './sanitize';

export interface AuditInput {
  actorId?: string | null;
  action: string;
  caseId?: string | null;
  entity?: string;
  entityId?: string;
  meta?: Record<string, unknown>;
}

type Executor = Pick<Db, 'insert'>;

/** Append an audit row. Metadata is sanitised: document contents never reach this table. */
export async function audit(db: Executor, input: AuditInput): Promise<void> {
  await db.insert(auditLog).values({
    actorId: input.actorId ?? null,
    action: input.action,
    caseId: input.caseId ?? null,
    entity: input.entity,
    entityId: input.entityId,
    meta: sanitizeRecord(input.meta),
  });
}

export async function listAudit(db: Db, caseId: string, limit = 200) {
  return db.select().from(auditLog).where(eq(auditLog.caseId, caseId)).orderBy(desc(auditLog.at)).limit(limit);
}
