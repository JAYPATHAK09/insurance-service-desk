'use server';

import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { findings } from '@/db/schema';
import { HttpError } from '@/lib/access';
import { CLASSIFICATIONS } from '@/lib/contracts';
import { FindingError, correctClassification, decideFinding } from '@/lib/findings';
import { ReviewError, runReview } from '@/lib/review';
import { requireCase } from '@/lib/session';
import { ModelCallError } from '@/lib/model/providers';
import { ModelOutputError } from '@/lib/model/validate';
import { emitCorrectionKpis, emitDecisionKpis, emitRunKpis } from '@/modules/claim-reconciler/kpi';
import { ClaimError, approveDraft, supervisorApproveDraft } from '@/modules/claim-reconciler/service';

const Id = z.string().min(1).max(100);

function back(caseId: string, key: 'error' | 'notice', code: string): never {
  redirect(`/cases/${encodeURIComponent(caseId)}/claim-reconciler?${key}=${encodeURIComponent(code)}`);
}

/** Domain errors become a short code (mapped to fixed text by the page); HttpErrors propagate. */
function errorCode(err: unknown): string | null {
  if (err instanceof HttpError) return null;
  if (err instanceof ClaimError) return 'claim_refused';
  if (err instanceof FindingError) return 'finding_refused';
  if (err instanceof ReviewError) return 'review_failed';
  if (err instanceof ModelCallError || err instanceof ModelOutputError) return 'model_failed';
  return null;
}

async function ownFinding(db: Awaited<ReturnType<typeof requireCase>>['db'], caseId: string, findingId: string) {
  // The finding must belong to this case: never trust the id alone.
  const [f] = await db.select({ caseId: findings.caseId }).from(findings).where(eq(findings.id, findingId));
  if (!f || f.caseId !== caseId) throw new HttpError(404, 'Finding not found');
}

export async function runAction(caseId: string) {
  const id = Id.parse(caseId);
  const { user, db } = await requireCase(id, 'write');
  let msg: string;
  try {
    const out = await runReview(db, { caseId: id, actorId: user.id });
    await emitRunKpis(db, id);
    msg = out.state === 'replayed' ? 'review_reused' : out.state === 'ran' ? 'review_complete' : 'review_running';
  } catch (err) {
    const m = errorCode(err);
    if (m === null) throw err;
    back(id, 'error', m);
  }
  revalidatePath(`/cases/${id}/claim-reconciler`);
  back(id, 'notice', msg);
}

export async function decideAction(caseId: string, formData: FormData) {
  const id = Id.parse(caseId);
  const input = z
    .object({ findingId: Id, decision: z.enum(['accept', 'override', 'dismiss']), note: z.string().max(1000).catch('') })
    .parse({ findingId: formData.get('findingId'), decision: formData.get('decision'), note: formData.get('note') ?? '' });
  const { user, db } = await requireCase(id, 'write');
  await ownFinding(db, id, input.findingId);
  try {
    await decideFinding(db, { findingId: input.findingId, actorId: user.id, decision: input.decision, note: input.note });
    await emitDecisionKpis(db, { findingId: input.findingId, decision: input.decision });
  } catch (err) {
    const m = errorCode(err);
    if (m === null) throw err;
    back(id, 'error', m);
  }
  revalidatePath(`/cases/${id}/claim-reconciler`);
  back(id, 'notice', 'cr_verified');
}

export async function correctAction(caseId: string, formData: FormData) {
  const id = Id.parse(caseId);
  const input = z
    .object({ findingId: Id, to: z.enum(CLASSIFICATIONS['claim-reconciler']), reason: z.string().max(500).catch('') })
    .parse({ findingId: formData.get('findingId'), to: formData.get('to'), reason: formData.get('reason') ?? '' });
  const { user, db } = await requireCase(id, 'write');
  await ownFinding(db, id, input.findingId);
  try {
    await correctClassification(db, { findingId: input.findingId, actorId: user.id, to: input.to, reason: input.reason, allowed: CLASSIFICATIONS['claim-reconciler'] });
    await emitCorrectionKpis(db, { findingId: input.findingId });
  } catch (err) {
    const m = errorCode(err);
    if (m === null) throw err;
    back(id, 'error', m);
  }
  revalidatePath(`/cases/${id}/claim-reconciler`);
  back(id, 'notice', 'cr_corrected');
}

export async function approveDraftAction(caseId: string, formData: FormData) {
  const id = Id.parse(caseId);
  const seenHash = z.string().regex(/^[0-9a-f]{64}$/).parse(formData.get('draftHash'));
  const { user, db } = await requireCase(id, 'write');
  try {
    await approveDraft(db, { caseId: id, user, seenHash });
  } catch (err) {
    const m = errorCode(err);
    if (m === null) throw err;
    back(id, 'error', m);
  }
  revalidatePath(`/cases/${id}/claim-reconciler`);
  back(id, 'notice', 'cr_draft_ready');
}

export async function supervisorApproveAction(caseId: string, formData: FormData) {
  const id = Id.parse(caseId);
  const seenHash = z.string().regex(/^[0-9a-f]{64}$/).parse(formData.get('draftHash'));
  const { user, db } = await requireCase(id, 'write');
  try {
    await supervisorApproveDraft(db, { caseId: id, user, seenHash });
  } catch (err) {
    const m = errorCode(err);
    if (m === null) throw err;
    back(id, 'error', m);
  }
  revalidatePath(`/cases/${id}/claim-reconciler`);
  back(id, 'notice', 'cr_supervisor_approved');
}
