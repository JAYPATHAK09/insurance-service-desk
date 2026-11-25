import { NextResponse } from 'next/server';
import { getDb } from '@/db/client';
import { listQueue } from '@/lib/cases';
import { api } from '@/lib/http';
import { requireUser } from '@/lib/session';

export const dynamic = 'force-dynamic';

/** The caller's visible cases (handlers: assigned only). */
export const GET = api(async () => {
  const user = await requireUser();
  const rows = await listQueue(await getDb(), user);
  return NextResponse.json(
    rows.map((r) => ({
      id: r.id, reference: r.reference, module: r.module, insurer: r.insurer, owner: r.ownerName,
      status: r.status, dueDate: r.dueDate, attention: r.attention,
    })),
  );
});
