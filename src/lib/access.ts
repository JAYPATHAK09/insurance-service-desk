import { eq } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { cases } from '@/db/schema';
import type { Role } from './contracts';

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}

export class HttpError extends Error {
  constructor(
    public status: 401 | 403 | 404 | 400 | 409 | 413 | 415 | 429 | 500,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export type AccessMode = 'read' | 'write';

/**
 * The single authorisation rule for cases:
 *  - handler: only cases they own; may write those
 *  - supervisor: every case, read and write
 *  - analyst: every case, read only
 */
export function canAccessCase(user: SessionUser, c: { ownerId: string }, mode: AccessMode): boolean {
  if (mode === 'write' && user.role === 'analyst') return false;
  if (user.role === 'handler') return c.ownerId === user.id;
  return true;
}

export function requireRoleOf(user: SessionUser, ...roles: Role[]): void {
  if (!roles.includes(user.role)) throw new HttpError(403, 'Forbidden');
}

/**
 * Load the case and enforce access. A case the user may not see answers 404, identical to an unknown
 * id, so ids cannot be probed. The only 403 is a read-only role (analyst) attempting a write on a
 * case it can already read: nothing is revealed by that.
 */
export async function requireCaseAccess(db: Db, user: SessionUser, caseId: string, mode: AccessMode = 'read') {
  const [c] = await db.select().from(cases).where(eq(cases.id, caseId));
  if (!c || !canAccessCase(user, c, 'read')) throw new HttpError(404, 'Case not found');
  if (!canAccessCase(user, c, mode)) throw new HttpError(403, 'Forbidden');
  return c;
}
