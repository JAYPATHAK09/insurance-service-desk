import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { cases, documents, findings, users } from '@/db/schema';
import type { ModuleId, WorkflowState } from './contracts';
import type { SessionUser } from './access';

export type CaseRow = typeof cases.$inferSelect;

export type AttentionReason = 'Overdue' | 'Unresolved exceptions' | 'Awaiting approval' | 'OCR failed';
const ORDER: AttentionReason[] = ['OCR failed', 'Overdue', 'Unresolved exceptions', 'Awaiting approval'];

export interface CaseCounts {
  openFindings: number;
  ocrFailedDocs: number;
}

/** Pure: which attention reasons apply to a case right now (most urgent first). */
export function computeAttention(
  c: Pick<CaseRow, 'status' | 'dueDate'>,
  counts: CaseCounts,
  now = new Date(),
): AttentionReason[] {
  const r = new Set<AttentionReason>();
  if (counts.ocrFailedDocs > 0) r.add('OCR failed');
  if (c.status !== 'exported' && c.dueDate.getTime() < now.getTime()) r.add('Overdue');
  if (counts.openFindings > 0) r.add('Unresolved exceptions');
  if (c.status === 'approval') r.add('Awaiting approval');
  return ORDER.filter((x) => r.has(x));
}

export async function countsFor(db: Db, caseIds: string[]): Promise<Map<string, CaseCounts>> {
  const map = new Map<string, CaseCounts>(caseIds.map((id) => [id, { openFindings: 0, ocrFailedDocs: 0 }]));
  if (!caseIds.length) return map;
  const open = await db
    .select({ caseId: findings.caseId, n: sql<number>`count(*)::int` })
    .from(findings)
    .where(and(inArray(findings.caseId, caseIds), eq(findings.status, 'open')))
    .groupBy(findings.caseId);
  for (const o of open) map.get(o.caseId)!.openFindings = o.n;
  const docs = await db
    .select({ caseId: documents.caseId, pages: documents.pages })
    .from(documents)
    .where(inArray(documents.caseId, caseIds));
  for (const d of docs) {
    if (d.pages.some((p) => p.ocr_status === 'failed')) map.get(d.caseId)!.ocrFailedDocs++;
  }
  return map;
}

/** Recompute and persist cases.attention_reason. Call after any change that can affect it. */
export async function refreshAttention(db: Db, caseId: string): Promise<void> {
  const [c] = await db.select().from(cases).where(eq(cases.id, caseId));
  if (!c) return;
  const counts = (await countsFor(db, [caseId])).get(caseId)!;
  const reasons = computeAttention(c, counts);
  await db
    .update(cases)
    .set({ attentionReason: reasons.length ? reasons.join(', ') : null, updatedAt: new Date() })
    .where(eq(cases.id, caseId));
}

export interface QueueFilters {
  module?: ModuleId;
  status?: WorkflowState;
  insurer?: string;
  ownerId?: string;
  attentionOnly?: boolean;
}

export interface QueueRow extends CaseRow {
  ownerName: string;
  attention: AttentionReason[];
}

/** The operator queue: only cases visible to the user; attention rows first, then by due date. */
export async function listQueue(db: Db, user: SessionUser, f: QueueFilters = {}, now = new Date()): Promise<QueueRow[]> {
  const conds = [];
  if (user.role === 'handler') conds.push(eq(cases.ownerId, user.id));
  if (f.module) conds.push(eq(cases.module, f.module));
  if (f.status) conds.push(eq(cases.status, f.status));
  if (f.insurer) conds.push(eq(cases.insurer, f.insurer));
  if (f.ownerId && user.role !== 'handler') conds.push(eq(cases.ownerId, f.ownerId));
  const rows = await db
    .select({ c: cases, ownerName: users.name })
    .from(cases)
    .innerJoin(users, eq(users.id, cases.ownerId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(asc(cases.dueDate));
  const counts = await countsFor(db, rows.map((r) => r.c.id));
  let out: QueueRow[] = rows.map((r) => ({
    ...r.c,
    ownerName: r.ownerName,
    attention: computeAttention(r.c, counts.get(r.c.id)!, now),
  }));
  if (f.attentionOnly) out = out.filter((r) => r.attention.length > 0);
  // Stable sort: needs-attention first (more urgent reason first), then earliest due date.
  const rank = (r: QueueRow) => (r.attention.length ? ORDER.indexOf(r.attention[0]!) : ORDER.length);
  return out.sort((a, b) => rank(a) - rank(b) || a.dueDate.getTime() - b.dueDate.getTime());
}
