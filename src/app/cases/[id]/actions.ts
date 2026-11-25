'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { HttpError } from '@/lib/access';
import { refreshAttention } from '@/lib/cases';
import { WORKFLOW_STATES } from '@/lib/contracts';
import { FindingError, decideFinding } from '@/lib/findings';
import { IngestError, ingestDocument } from '@/lib/ingest';
import { enforceRateLimit } from '@/lib/ratelimit';
import { ReviewError, runReview } from '@/lib/review';
import { requireCase } from '@/lib/session';
import { WorkflowError, reopenCase, transitionCase } from '@/lib/workflow';
import { ModelCallError } from '@/lib/model/providers';
import { ModelOutputError } from '@/lib/model/validate';
import { eq } from 'drizzle-orm';
import { findings } from '@/db/schema';

const Id = z.string().min(1).max(100);

/** Redirect with a short code; the page maps it to fixed text (see lib/messages.ts). */
function back(caseId: string, tab: string, key: 'error' | 'notice', code: string): never {
  redirect(`/cases/${encodeURIComponent(caseId)}?tab=${tab}&${key}=${encodeURIComponent(code)}`);
}

/** Domain errors become an error code; HttpErrors (401/403/404/429) propagate to the framework. */
function errorCode(err: unknown): string | null {
  if (err instanceof HttpError) return null;
  if (err instanceof IngestError) return err.code;
  if (err instanceof WorkflowError) return 'workflow_refused';
  if (err instanceof ReviewError) return 'review_failed';
  if (err instanceof FindingError) return 'finding_refused';
  if (err instanceof ModelCallError || err instanceof ModelOutputError) return 'model_failed';
  return null;
}

export async function uploadAction(caseId: string, formData: FormData) {
  const id = Id.parse(caseId);
  const { user, db } = await requireCase(id, 'write');
  const file = formData.get('file');
  const kind = z.string().max(40).catch('other').parse(formData.get('kind') ?? 'other');
  let notice: string;
  try {
    await enforceRateLimit('upload');
    if (!(file instanceof File) || file.size === 0) throw new IngestError('Choose a file to upload', 400, 'choose_file');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const { duplicate } = await ingestDocument(db, { caseId: id, filename: file.name, bytes, kind, uploadedBy: user.id });
    await refreshAttention(db, id);
    notice = duplicate ? 'duplicate' : 'uploaded';
  } catch (err) {
    if (err instanceof HttpError && err.status === 429) back(id, 'documents', 'error', 'rate_limited');
    const c = errorCode(err);
    if (c === null) throw err;
    back(id, 'documents', 'error', c);
  }
  revalidatePath(`/cases/${id}`);
  back(id, 'documents', 'notice', notice);
}

export async function transitionAction(caseId: string, formData: FormData) {
  const id = Id.parse(caseId);
  const to = z.enum(WORKFLOW_STATES).parse(formData.get('to'));
  const { user, db } = await requireCase(id, 'write');
  try {
    await transitionCase(db, { caseId: id, to, actorId: user.id, role: user.role });
  } catch (err) {
    const c = errorCode(err);
    if (c === null) throw err;
    back(id, 'documents', 'error', c);
  }
  revalidatePath(`/cases/${id}`);
  back(id, 'documents', 'notice', 'status_updated');
}

export async function reopenAction(caseId: string, formData: FormData) {
  const id = Id.parse(caseId);
  const reason = z.string().max(500).catch('').parse(formData.get('reason') ?? '');
  const { user, db } = await requireCase(id, 'write');
  try {
    await reopenCase(db, { caseId: id, reason, actorId: user.id, role: user.role });
  } catch (err) {
    const c = errorCode(err);
    if (c === null) throw err;
    back(id, 'audit', 'error', c);
  }
  revalidatePath(`/cases/${id}`);
  back(id, 'audit', 'notice', 'reopened');
}

export async function reviewAction(caseId: string) {
  const id = Id.parse(caseId);
  const { user, db } = await requireCase(id, 'write');
  let notice: string;
  try {
    const out = await runReview(db, { caseId: id, actorId: user.id });
    notice = out.state === 'replayed' ? 'review_reused' : out.state === 'ran' ? 'review_complete' : 'review_running';
  } catch (err) {
    const c = errorCode(err);
    if (c === null) throw err;
    back(id, 'findings', 'error', c);
  }
  revalidatePath(`/cases/${id}`);
  back(id, 'findings', 'notice', notice);
}

export async function decideAction(caseId: string, formData: FormData) {
  const id = Id.parse(caseId);
  const input = z
    .object({
      findingId: Id,
      decision: z.enum(['accept', 'override', 'dismiss']),
      note: z.string().max(1000).catch(''),
    })
    .parse({ findingId: formData.get('findingId'), decision: formData.get('decision'), note: formData.get('note') ?? '' });
  const { user, db } = await requireCase(id, 'write');
  // The finding must belong to this case: never trust the id alone.
  const [f] = await db.select({ caseId: findings.caseId }).from(findings).where(eq(findings.id, input.findingId));
  if (!f || f.caseId !== id) throw new HttpError(404, 'Finding not found');
  try {
    await decideFinding(db, { findingId: input.findingId, actorId: user.id, decision: input.decision, note: input.note });
  } catch (err) {
    const c = errorCode(err);
    if (c === null) throw err;
    back(id, 'findings', 'error', c);
  }
  revalidatePath(`/cases/${id}`);
  back(id, 'findings', 'notice', 'decision_recorded');
}
