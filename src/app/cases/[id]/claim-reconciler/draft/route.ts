import { HttpError } from '@/lib/access';
import { audit } from '@/lib/audit';
import { api } from '@/lib/http';
import { requireCase } from '@/lib/session';
import { currentDraft } from '@/modules/claim-reconciler/service';

export const dynamic = 'force-dynamic';

/** The draft response as a text file. Its first line states DRAFT or READY; it is never sent by the platform. */
export const GET = api(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const { user, db, case: c } = await requireCase(id, 'read');
  const d = await currentDraft(db, c.id);
  if (!d) throw new HttpError(404, 'No review yet: run the review first');
  await audit(db, { actorId: user.id, action: 'claim.draft_downloaded', caseId: c.id, entity: 'case', entityId: c.id, meta: { status: d.status.status } });
  const safeRef = c.reference.replace(/[^A-Za-z0-9._-]/g, '_');
  return new Response(d.document, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'content-disposition': `attachment; filename="draft-response-${safeRef}.txt"`,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  });
});
