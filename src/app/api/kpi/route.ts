import { NextResponse } from 'next/server';
import { getDb } from '@/db/client';
import { api } from '@/lib/http';
import { requireRole } from '@/lib/session';
import { getKpiReport } from '@/modules/dashboard/kpi';
import { parseWindow } from '@/modules/dashboard/window';

export const dynamic = 'force-dynamic';

/** JSON KPI report, one section per source (never merged). Supervisor and analyst only. */
export const GET = api(async (req: Request) => {
  await requireRole('supervisor', 'analyst');
  const url = new URL(req.url);
  const window = parseWindow({ from: url.searchParams.get('from'), to: url.searchParams.get('to') });
  return NextResponse.json(await getKpiReport(await getDb(), window), { headers: { 'cache-control': 'no-store' } });
});
