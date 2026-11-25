import { NextResponse } from 'next/server';
import { HttpError } from '@/lib/access';
import { api } from '@/lib/http';
import { requireCase } from '@/lib/session';
import { RenewalError, exportData, toCsv } from '@/modules/renewal-agent/service';

export const dynamic = 'force-dynamic';

/** CSV export. Case access is checked server-side; export itself needs a current supervisor approval. */
export const GET = api(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const { user, db, case: c } = await requireCase(id, 'read');
  if (c.module !== 'renewal-agent') throw new HttpError(404, 'Case not found');
  try {
    const { rows } = await exportData(db, { caseId: id, user });
    const name = `renewal-${c.reference.replace(/[^A-Za-z0-9_-]/g, '_')}.csv`;
    return new NextResponse(toCsv(rows), {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${name}"`,
        'cache-control': 'no-store',
      },
    });
  } catch (err) {
    if (err instanceof RenewalError) return NextResponse.json({ error: err.message }, { status: 409 });
    throw err;
  }
});
