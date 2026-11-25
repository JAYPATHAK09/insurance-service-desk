'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { HttpError } from '@/lib/access';
import { FindingError } from '@/lib/findings';
import { ModelCallError } from '@/lib/model/providers';
import { ModelOutputError } from '@/lib/model/validate';
import { ReviewError, runReview } from '@/lib/review';
import { requireCase } from '@/lib/session';
import { EXPLANATION_LANGS } from '@/modules/renewal-agent/explain';
import { AckInput, CHOICES, RenewalError, approveExplanation, recordAcknowledgement, recordCorrection, recordDecision } from '@/modules/renewal-agent/service';
import { CLASSIFICATIONS } from '@/lib/contracts';

const Id = z.string().min(1).max(100);
const Lang = z.enum(EXPLANATION_LANGS).catch('en');

function back(caseId: string, lang: string, key: 'error' | 'notice', msg: string): never {
  redirect(`/cases/${encodeURIComponent(caseId)}/renewal-agent?lang=${lang}&${key}=${encodeURIComponent(msg.slice(0, 200))}`);
}

function userMessage(err: unknown): string | null {
  if (err instanceof HttpError) return null;
  if (err instanceof RenewalError || err instanceof FindingError || err instanceof ReviewError || err instanceof ModelCallError || err instanceof ModelOutputError || err instanceof z.ZodError) {
    return err instanceof z.ZodError ? 'Please check the form fields and try again.' : err.message;
  }
  return null;
}

/** Every action starts here: signed in, may write THIS case, and the case is a renewal case. */
async function guard(caseId: string) {
  const id = Id.parse(caseId);
  const ctx = await requireCase(id, 'write');
  if (ctx.case.module !== 'renewal-agent') throw new HttpError(404, 'Case not found');
  return { id, ...ctx };
}

export async function runReviewAction(caseId: string, formData: FormData) {
  const lang = Lang.parse(formData.get('lang'));
  const { id, user, db } = await guard(caseId);
  let msg: string;
  try {
    const out = await runReview(db, { caseId: id, actorId: user.id });
    msg = out.state === 'replayed' ? 'Same documents and model: existing review reused.' : out.state === 'ran' ? 'Review complete.' : 'A review is already running.';
  } catch (err) {
    const m = userMessage(err);
    if (m === null) throw err;
    back(id, lang, 'error', m);
  }
  revalidatePath(`/cases/${id}/renewal-agent`);
  back(id, lang, 'notice', msg);
}

export async function decideRowAction(caseId: string, formData: FormData) {
  const lang = Lang.parse(formData.get('lang'));
  const { id, user, db } = await guard(caseId);
  let msg: string;
  try {
    const input = z
      .object({ findingId: Id, choice: z.enum(CHOICES), note: z.string().max(900).catch('') })
      .parse({ findingId: formData.get('findingId'), choice: formData.get('choice'), note: formData.get('note') ?? '' });
    await recordDecision(db, { caseId: id, findingId: input.findingId, user, choice: input.choice, note: input.note });
    msg = 'Decision recorded.';
  } catch (err) {
    const m = userMessage(err);
    if (m === null) throw err;
    back(id, lang, 'error', m);
  }
  revalidatePath(`/cases/${id}/renewal-agent`);
  back(id, lang, 'notice', msg);
}

export async function correctAction(caseId: string, formData: FormData) {
  const lang = Lang.parse(formData.get('lang'));
  const { id, user, db } = await guard(caseId);
  let msg: string;
  try {
    const input = z
      .object({ findingId: Id, to: z.enum(CLASSIFICATIONS['renewal-agent']), reason: z.string().trim().min(3).max(500) })
      .parse({ findingId: formData.get('findingId'), to: formData.get('to'), reason: formData.get('reason') });
    await recordCorrection(db, { caseId: id, findingId: input.findingId, user, to: input.to, reason: input.reason });
    msg = 'Classification corrected; the previous value is kept in the history.';
  } catch (err) {
    const m = userMessage(err);
    if (m === null) throw err;
    back(id, lang, 'error', m);
  }
  revalidatePath(`/cases/${id}/renewal-agent`);
  back(id, lang, 'notice', msg);
}

export async function approveAction(caseId: string, formData: FormData) {
  const lang = Lang.parse(formData.get('lang'));
  const { id, user, db } = await guard(caseId);
  let msg: string;
  try {
    const version = z.string().min(1).max(100).parse(formData.get('version'));
    await approveExplanation(db, { caseId: id, user, lang, version });
    msg = 'Explanation approved by supervisor. The platform does not send it: the advisor sends it outside the platform.';
  } catch (err) {
    const m = userMessage(err);
    if (m === null) throw err;
    back(id, lang, 'error', m);
  }
  revalidatePath(`/cases/${id}/renewal-agent`);
  back(id, lang, 'notice', msg);
}

export async function acknowledgeAction(caseId: string, formData: FormData) {
  const lang = Lang.parse(formData.get('lang'));
  const { id, user, db } = await guard(caseId);
  let msg: string;
  try {
    const findingId = Id.parse(formData.get('findingId'));
    const input = AckInput.parse({ customerName: formData.get('customerName'), channel: formData.get('channel'), lang });
    await recordAcknowledgement(db, { caseId: id, findingId, user, input });
    msg = 'Customer acknowledgement recorded.';
  } catch (err) {
    const m = userMessage(err);
    if (m === null) throw err;
    back(id, lang, 'error', m);
  }
  revalidatePath(`/cases/${id}/renewal-agent`);
  back(id, lang, 'notice', msg);
}
