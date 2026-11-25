import { z } from 'zod';
import { HttpError } from '@/lib/access';
import { audit } from '@/lib/audit';
import { api } from '@/lib/http';
import { requireCase } from '@/lib/session';
import { buildCsv, buildText } from '@/modules/disclosure-checker/report';
import { loadState } from '@/modules/disclosure-checker/resolve';

export const dynamic = 'force-dynamic';

/** GET /cases/{id}/disclosure-checker/export?format=csv|txt  (read access to the case is enough). */
export const GET = api(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const format = z.enum(['csv', 'txt']).safeParse(new URL(req.url).searchParams.get('format') ?? 'csv');
  if (!format.success) throw new HttpError(400, 'format must be csv or txt');
  const { user, db, case: c } = await requireCase(id, 'read');
  if (c.module !== 'disclosure-checker') throw new HttpError(404, 'Case not found');
  const state = await loadState(db, c.id);
  const meta = { reference: c.reference, insurer: c.insurer, title: c.title, generatedAt: new Date(), generatedBy: user.name };
  const body = format.data === 'csv' ? buildCsv(state, meta) : buildText(state, meta);
  await audit(db, { actorId: user.id, action: 'disclosure.exported', caseId: c.id, entity: 'case', entityId: c.id, meta: { format: format.data, findings: state.findings.length } });
  const safeRef = c.reference.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60);
  return new Response(body, {
    headers: {
      'content-type': format.data === 'csv' ? 'text/csv; charset=utf-8' : 'text/plain; charset=utf-8',
      'content-disposition': `attachment; filename="disclosure-reconciliation-${safeRef}.${format.data}"`,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
});
