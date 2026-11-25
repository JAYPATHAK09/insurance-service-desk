import { eq } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { documents } from '@/db/schema';
import { HttpError, requireCaseAccess } from '@/lib/access';
import { audit } from '@/lib/audit';
import { api } from '@/lib/http';
import { requireUser } from '@/lib/session';
import { getStorage, verifyDownloadToken } from '@/lib/storage';

export const dynamic = 'force-dynamic';

/**
 * Short-lived signed link AND a signed-in user with read access to the case. The link alone is not
 * enough, and a valid session alone is not enough without the unexpired token.
 */
export const GET = api(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const { id } = await ctx.params;
  const token = new URL(req.url).searchParams.get('t') ?? '';
  const claim = verifyDownloadToken(token);
  if (!claim || claim.documentId !== id) throw new HttpError(403, 'Link invalid or expired');
  const db = await getDb();
  const [doc] = await db.select().from(documents).where(eq(documents.id, id));
  if (!doc) throw new HttpError(404, 'Not found');
  await requireCaseAccess(db, user, doc.caseId, 'read');
  const bytes = await getStorage().get(doc.storageKey);
  if (!bytes) throw new HttpError(404, 'File no longer available');
  await audit(db, { actorId: user.id, action: 'document.downloaded', caseId: doc.caseId, entity: 'document', entityId: doc.id });
  return new Response(Buffer.from(bytes), {
    headers: {
      'content-type': doc.mime,
      'content-disposition': `attachment; filename="${doc.filename.replace(/"/g, '')}"`,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  });
});
