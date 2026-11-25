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
    public status: 401 | 403 | 404 | 400 | 409 | 413 | 500,
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

/** Load the case and enforce access. Throws 404 for unknown ids and 403 when not permitted. */
export async function requireCaseAccess(db: Db, user: SessionUser, caseId: string, mode: AccessMode = 'read') {
  const [c] = await db.select().from(cases).where(eq(cases.id, caseId));
  if (!c) throw new HttpError(404, 'Case not found');
  if (!canAccessCase(user, c, mode)) throw new HttpError(403, 'Forbidden');
  return c;
}
