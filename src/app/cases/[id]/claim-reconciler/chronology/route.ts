import { z } from 'zod';
import { audit } from '@/lib/audit';
import { api } from '@/lib/http';
import { requireCase } from '@/lib/session';
import { chronologyCsv, chronologyText } from '@/modules/claim-reconciler/chronology';
import { caseChronology } from '@/modules/claim-reconciler/service';

export const dynamic = 'force-dynamic';

/** GET ?format=csv|txt. Read access to the case is required; the file carries no document text beyond short descriptions. */
export const GET = api(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const { user, db, case: c } = await requireCase(id, 'read');
  const format = z.enum(['csv', 'txt']).catch('csv').parse(new URL(req.url).searchParams.get('format') ?? 'csv');
  const rows = await caseChronology(db, c.id);
  await audit(db, { actorId: user.id, action: 'claim.chronology_downloaded', caseId: c.id, entity: 'case', entityId: c.id, meta: { format, rows: rows.length } });
  const body = format === 'csv' ? chronologyCsv(rows) : chronologyText(rows, { reference: c.reference, insurer: c.insurer });
  const safeRef = c.reference.replace(/[^A-Za-z0-9._-]/g, '_');
  return new Response(body, {
    headers: {
      'content-type': format === 'csv' ? 'text/csv; charset=utf-8' : 'text/plain; charset=utf-8',
      'content-disposition': `attachment; filename="chronology-${safeRef}.${format}"`,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  });
});
