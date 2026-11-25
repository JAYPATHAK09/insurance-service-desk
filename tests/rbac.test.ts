import { describe, expect, it } from 'vitest';
import { HttpError, canAccessCase, requireCaseAccess, requireRoleOf } from '@/lib/access';
import { signSession, verifySession } from '@/lib/session';
import { freshDb, makeCase, U } from './helpers';

describe('case access (RBAC)', () => {
  it('refuses a handler access to a case assigned to someone else', async () => {
    const db = await freshDb();
    const theirs = await makeCase(U.handlerB.id);
    await expect(requireCaseAccess(db, U.handlerA, theirs.id, 'read')).rejects.toMatchObject({ status: 403 });
    await expect(requireCaseAccess(db, U.handlerA, theirs.id, 'write')).rejects.toMatchObject({ status: 403 });
  });

  it('lets a handler read and write their own case', async () => {
    const db = await freshDb();
    const mine = await makeCase(U.handlerA.id);
    await expect(requireCaseAccess(db, U.handlerA, mine.id, 'write')).resolves.toMatchObject({ id: mine.id });
  });

  it('supervisors see everything; analysts read everything but never write (403)', async () => {
    const db = await freshDb();
    const c = await makeCase(U.handlerB.id);
    await expect(requireCaseAccess(db, U.supervisor, c.id, 'write')).resolves.toBeTruthy();
    await expect(requireCaseAccess(db, U.analyst, c.id, 'read')).resolves.toBeTruthy();
    await expect(requireCaseAccess(db, U.analyst, c.id, 'write')).rejects.toMatchObject({ status: 403 });
  });

  it('unknown case is 404', async () => {
    const db = await freshDb();
    await expect(requireCaseAccess(db, U.supervisor, 'nope')).rejects.toBeInstanceOf(HttpError);
    await expect(requireCaseAccess(db, U.supervisor, 'nope')).rejects.toMatchObject({ status: 404 });
  });

  it('role gate', () => {
    expect(() => requireRoleOf(U.handlerA, 'supervisor')).toThrow(HttpError);
    expect(() => requireRoleOf(U.supervisor, 'supervisor')).not.toThrow();
    expect(canAccessCase(U.analyst, { ownerId: U.analyst.id }, 'write')).toBe(false);
  });
});

describe('session cookie signing', () => {
  it('round-trips, rejects tampering and expiry', () => {
    const t = signSession('u-a', 1_000_000, 60);
    expect(verifySession(t, 1_000_000 + 30_000)).toBe('u-a');
    expect(verifySession(t, 1_000_000 + 61_000)).toBeNull();
    const [p, s] = t.split('.');
    const forged = Buffer.from(JSON.stringify({ u: 'u-s', e: 9_999_999_999 })).toString('base64url');
    expect(verifySession(`${forged}.${s}`, 1_000_000)).toBeNull();
    expect(verifySession(`${p}.AAAA`, 1_000_000)).toBeNull();
    expect(verifySession(undefined)).toBeNull();
  });
});
