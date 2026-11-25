import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getDb } from '@/db/client';
import { HttpError } from '@/lib/access';
import { isDemoPublic } from '@/lib/env';
import { api, assertJsonSameOrigin } from '@/lib/http';
import { getRetentionDays, runRetentionJob, setRetentionDays } from '@/lib/retention';
import { requireRole } from '@/lib/session';

export const dynamic = 'force-dynamic';

export const GET = api(async () => {
  await requireRole('supervisor');
  return NextResponse.json({ documentsDays: await getRetentionDays(await getDb(), 'documents') });
});

/** Supervisor only. JSON, same-origin. Body: { days?: number, run?: boolean }. */
export const POST = api(async (req: Request) => {
  assertJsonSameOrigin(req);
  const user = await requireRole('supervisor');
  const parsed = z
    .object({ days: z.number().int().min(1).max(3650).optional(), run: z.boolean().optional() })
    .safeParse(await req.json().catch(() => null));
  if (!parsed.success) throw new HttpError(400, 'Invalid body');
  // Public demo: nobody may trigger deletion, whatever their role.
  if (parsed.data.run && isDemoPublic()) throw new HttpError(403, 'Retention runs are disabled on the public demo');
  const db = await getDb();
  if (parsed.data.days) await setRetentionDays(db, 'documents', parsed.data.days, user.id);
  const outcome = parsed.data.run ? await runRetentionJob(db, new Date(), user.id) : null;
  return NextResponse.json({ documentsDays: await getRetentionDays(db, 'documents'), outcome });
});
