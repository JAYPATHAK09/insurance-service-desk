import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { auditLog, cases, documents, findings, reviews, users } from '@/db/schema';
import { audit } from '@/lib/audit';
import type { SessionUser } from '@/lib/access';
import { buildChronology, type ChronoDoc } from './chronology';
import { buildDraft, draftDocument, draftStatus, type DraftItem, type DraftStatus } from './draft';

export class ClaimError extends Error {}

/** Documents with upload time, as the chronology needs. */
export async function loadChronoDocs(db: Db, caseId: string): Promise<ChronoDoc[]> {
  const rows = await db.select().from(documents).where(eq(documents.caseId, caseId)).orderBy(asc(documents.createdAt));
  return rows.map((r) => ({ id: r.id, name: r.filename, filename: r.filename, kind: r.kind, sha: r.sha256, sha256: r.sha256, pages: r.pages, createdAt: r.createdAt }));
}

export async function caseChronology(db: Db, caseId: string) {
  return buildChronology(await loadChronoDocs(db, caseId));
}

export async function latestReview(db: Db, caseId: string) {
  const [r] = await db.select().from(reviews).where(eq(reviews.caseId, caseId)).orderBy(desc(reviews.version)).limit(1);
  return r ?? null;
}

export async function latestFindings(db: Db, caseId: string) {
  const rev = await latestReview(db, caseId);
  if (!rev) return { review: null, rows: [] as Array<typeof findings.$inferSelect> };
  const rows = await db.select().from(findings).where(and(eq(findings.caseId, caseId), eq(findings.reviewId, rev.id))).orderBy(asc(findings.createdAt), asc(findings.key));
  return { review: rev, rows };
}

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export interface DraftView {
  body: string;
  hash: string;
  status: DraftStatus;
  open: number;
  document: string;
}

/** Build the current draft from the latest review and read its approval state from the audit trail. */
export async function currentDraft(db: Db, caseId: string): Promise<DraftView | null> {
  const [c] = await db.select().from(cases).where(eq(cases.id, caseId));
  if (!c) return null;
  const { rows } = await latestFindings(db, caseId);
  if (!rows.length) return null;
  const first = rows[0]!.attributes as Record<string, unknown> | null;
  const items: DraftItem[] = rows.map((f) => {
    const a = (f.attributes ?? {}) as Record<string, unknown>;
    return {
      n: Number(a.item_no) || 0,
      itemType: String(a.item_type ?? 'other'),
      itemText: String(a.item_text ?? f.summary).slice(0, 200),
      classification: f.classification,
      status: f.status,
      nextAction: f.nextAction,
      submissionRefs: strs(a.submission_refs),
    };
  });
  const { body, hash } = buildDraft({
    insurer: c.insurer,
    reference: c.reference,
    queryRef: (first?.query_ref as string | null) ?? null,
    queryDate: (first?.query_date as string | null) ?? null,
    items,
  });
  const logs = await db
    .select({ action: auditLog.action, actorId: auditLog.actorId, at: auditLog.at, meta: auditLog.meta })
    .from(auditLog)
    .where(and(eq(auditLog.caseId, caseId), inArray(auditLog.action, ['claim.draft_approved', 'claim.draft_supervisor_approved'])));
  const ids = [...new Set(logs.map((l) => l.actorId).filter((x): x is string => !!x))];
  const names = new Map((ids.length ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids)) : []).map((u) => [u.id, u.name]));
  const status = draftStatus(
    hash,
    logs.map((l) => ({ action: l.action, actor: names.get(l.actorId ?? '') ?? 'unknown', at: l.at.toISOString(), draftHash: (l.meta as Record<string, unknown>).draftHash })),
  );
  return { body, hash, status, open: rows.filter((f) => f.status === 'open').length, document: draftDocument(body, status) };
}

/**
 * Explicit handler approval of the CURRENT draft text. Requires write access (checked by the caller),
 * a handler or supervisor, the hash the user actually saw, and no unreviewed findings.
 */
export async function approveDraft(db: Db, a: { caseId: string; user: SessionUser; seenHash: string }): Promise<void> {
  if (a.user.role === 'analyst') throw new ClaimError('Analysts are read-only');
  const d = await currentDraft(db, a.caseId);
  if (!d) throw new ClaimError('Run the review first');
  if (d.hash !== a.seenHash) throw new ClaimError('The draft changed since you opened it. Read it again, then approve.');
  if (d.open > 0) throw new ClaimError(`${d.open} finding(s) are still unreviewed. Decide each one first.`);
  await audit(db, { actorId: a.user.id, action: 'claim.draft_approved', caseId: a.caseId, entity: 'draft', entityId: d.hash.slice(0, 16), meta: { draftHash: d.hash } });
}

/** Supervisor sign-off, only on a draft the handler has already approved. Still nothing is sent. */
export async function supervisorApproveDraft(db: Db, a: { caseId: string; user: SessionUser; seenHash: string }): Promise<void> {
  if (a.user.role !== 'supervisor') throw new ClaimError('Only a supervisor can give supervisor approval');
  const d = await currentDraft(db, a.caseId);
  if (!d) throw new ClaimError('Run the review first');
  if (d.hash !== a.seenHash) throw new ClaimError('The draft changed since you opened it. Read it again, then approve.');
  if (d.status.status !== 'ready') throw new ClaimError('The handler must approve the draft first');
  await audit(db, { actorId: a.user.id, action: 'claim.draft_supervisor_approved', caseId: a.caseId, entity: 'draft', entityId: d.hash.slice(0, 16), meta: { draftHash: d.hash } });
}
