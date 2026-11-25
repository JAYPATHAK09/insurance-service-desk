import { createHmac, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { cookies } from 'next/headers';
import { getDb, type Db } from '@/db/client';
import { users } from '@/db/schema';
import { HttpError, requireCaseAccess, requireRoleOf, type AccessMode, type SessionUser } from './access';
import type { Role } from './contracts';
import { derivedSecret, sessionCookieName } from './env';

const SESSION_TTL_SECONDS = 8 * 3600;

const mac = (payload: string) => createHmac('sha256', derivedSecret('session')).update(payload).digest('base64url');

export function signSession(userId: string, now = Date.now(), ttl = SESSION_TTL_SECONDS): string {
  const payload = Buffer.from(JSON.stringify({ u: userId, e: Math.floor(now / 1000) + ttl })).toString('base64url');
  return `${payload}.${mac(payload)}`;
}

export function verifySession(token: string | undefined, now = Date.now()): string | null {
  if (!token) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const a = Buffer.from(sig);
  const b = Buffer.from(mac(payload));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const { u, e } = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { u: string; e: number };
    return typeof u === 'string' && typeof e === 'number' && e * 1000 > now ? u : null;
  } catch {
    return null;
  }
}

export async function setSessionCookie(userId: string): Promise<void> {
  // __Host- cookies must be Secure, Path=/ and carry no Domain attribute (none is set here).
  (await cookies()).set(sessionCookieName(), signSession(userId), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  });
}

export async function clearSessionCookie(): Promise<void> {
  (await cookies()).delete(sessionCookieName());
}

export async function getUser(): Promise<SessionUser | null> {
  const id = verifySession((await cookies()).get(sessionCookieName())?.value);
  if (!id) return null;
  const db = await getDb();
  const [u] = await db.select().from(users).where(eq(users.id, id));
  return u ? { id: u.id, email: u.email, name: u.name, role: u.role } : null;
}

/** Throws HttpError(401) when not signed in. */
export async function requireUser(): Promise<SessionUser> {
  const u = await getUser();
  if (!u) throw new HttpError(401, 'Sign in required');
  return u;
}

export async function requireRole(...roles: Role[]): Promise<SessionUser> {
  const u = await requireUser();
  requireRoleOf(u, ...roles);
  return u;
}

/** Sign-in + case access in one call: the standard prologue of every case route and server action. */
export async function requireCase(caseId: string, mode: AccessMode = 'read') {
  const user = await requireUser();
  const db: Db = await getDb();
  const c = await requireCaseAccess(db, user, caseId, mode);
  return { user, db, case: c };
}
