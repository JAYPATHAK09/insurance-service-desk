'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { HttpError } from '@/lib/access';
import { FindingError } from '@/lib/findings';
import { ReviewError, runReview } from '@/lib/review';
import { requireCase } from '@/lib/session';
import { approveReview, resolveFinding } from '@/modules/disclosure-checker/resolve';

const Id = z.string().min(1).max(100);

function back(caseId: string, key: 'error' | 'notice', code: string): never {
  redirect(`/cases/${encodeURIComponent(caseId)}/disclosure-checker?${key}=${encodeURIComponent(code)}`);
}

async function guard<T>(caseId: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof HttpError) throw err;
    if (err instanceof FindingError) back(caseId, 'error', 'finding_refused');
    if (err instanceof ReviewError) back(caseId, 'error', 'review_failed');
    throw err;
  }
}

async function assertDisclosureCase(module: string) {
  if (module !== 'disclosure-checker') throw new HttpError(404, 'Case not found');
}

export async function runComparisonAction(caseId: string) {
  const id = Id.parse(caseId);
  const { user, db, case: c } = await requireCase(id, 'write');
  await assertDisclosureCase(c.module);
  const out = await guard(id, () => runReview(db, { caseId: id, actorId: user.id }));
  revalidatePath(`/cases/${id}/disclosure-checker`);
  back(id, 'notice', out.state === 'replayed' ? 'dc_reused' : 'dc_complete');
}

export async function resolveAction(caseId: string, formData: FormData) {
  const id = Id.parse(caseId);
  const findingId = Id.parse(formData.get('findingId'));
  const { user, db, case: c } = await requireCase(id, 'write');
  await assertDisclosureCase(c.module);
  const s = (k: string) => (typeof formData.get(k) === 'string' ? (formData.get(k) as string) : '');
  const outcome = s('outcome');
  const input =
    outcome === 'resolved'
      ? { outcome, reason: s('reason'), note: s('note') }
      : outcome === 'customer_confirmed'
        ? { outcome, customerName: s('customerName'), channel: s('channel'), confirmedAt: s('confirmedAt'), value: s('value'), proposalChange: s('proposalChange'), note: s('note') }
        : { outcome, note: s('note') };
  await guard(id, () => resolveFinding(db, { caseId: id, findingId, actorId: user.id, role: user.role, input }));
  revalidatePath(`/cases/${id}/disclosure-checker`);
  back(id, 'notice', outcome === 'escalate' ? 'dc_escalated' : 'dc_resolved');
}

export async function approveAction(caseId: string) {
  const id = Id.parse(caseId);
  const { user, db, case: c } = await requireCase(id, 'write');
  await assertDisclosureCase(c.module);
  await guard(id, () => approveReview(db, { caseId: id, actorId: user.id, role: user.role }));
  revalidatePath(`/cases/${id}/disclosure-checker`);
  back(id, 'notice', 'dc_approved');
}
