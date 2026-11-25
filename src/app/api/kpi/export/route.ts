import { getDb } from '@/db/client';
import { api } from '@/lib/http';
import { requireRole } from '@/lib/session';
import { kpiCsv } from '@/modules/dashboard/csv';
import { getKpiReport } from '@/modules/dashboard/kpi';
import { parseWindow } from '@/modules/dashboard/window';

export const dynamic = 'force-dynamic';

/** CSV of every KPI row for every source, with definitions and window. Supervisor and analyst only (handler gets 403). */
export const GET = api(async (req: Request) => {
  await requireRole('supervisor', 'analyst');
  const url = new URL(req.url);
  const window = parseWindow({ from: url.searchParams.get('from'), to: url.searchParams.get('to') });
  const report = await getKpiReport(await getDb(), window);
  return new Response(kpiCsv(report), {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="kpi-export-${report.asOf.toISOString().slice(0, 10)}.csv"`,
      'cache-control': 'no-store',
    },
  });
});
