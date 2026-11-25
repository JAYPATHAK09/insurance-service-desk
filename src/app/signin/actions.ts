'use server';

import { eq } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { getDb } from '@/db/client';
import { users } from '@/db/schema';
import { audit } from '@/lib/audit';
import { clearSessionCookie, setSessionCookie } from '@/lib/session';
import { clientIp, rateLimit } from '@/lib/ratelimit';
import { headers } from 'next/headers';

const Input = z.object({ userId: z.string().min(1).max(100) });

/** Demo sign-in: choose one of the seeded fictional users. Not for real credentials. */
export async function signInAction(formData: FormData) {
  if (!rateLimit('signin', clientIp(await headers()))) redirect('/signin?error=rate');
  const parsed = Input.safeParse({ userId: formData.get('userId') });
  if (!parsed.success) redirect('/signin?error=invalid');
  const db = await getDb();
  const [u] = await db.select().from(users).where(eq(users.id, parsed.data.userId));
  if (!u) redirect('/signin?error=invalid');
  await setSessionCookie(u.id);
  await audit(db, { actorId: u.id, action: 'auth.signed_in', meta: { role: u.role } });
  redirect('/');
}

export async function signOutAction() {
  await clearSessionCookie();
  redirect('/signin');
}
