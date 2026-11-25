import { afterEach, describe, expect, it, vi } from 'vitest';
import { U, freshDb } from './helpers';

const session = vi.hoisted(() => ({ role: 'supervisor' as 'supervisor' | 'handler' }));
vi.mock('@/lib/session', async () => {
  const { HttpError } = await import('@/lib/access');
  const { U } = await import('./helpers');
  return {
    requireRole: async (...roles: string[]) => {
      const user = session.role === 'supervisor' ? U.supervisor : U.handlerA;
      if (!roles.includes(user.role)) throw new HttpError(403, 'Forbidden');
      return user;
    },
  };
});

import { POST } from '@/app/api/retention/route';

const post = (body: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }) =>
  POST(new Request('https://desk.example/api/retention', { method: 'POST', headers, body: JSON.stringify(body) }));

afterEach(() => {
  vi.unstubAllEnvs();
  session.role = 'supervisor';
});

describe('POST /api/retention', () => {
  it('runs the job for a supervisor on a normal deployment', async () => {
    await freshDb();
    const res = await post({ run: true });
    expect(res.status).toBe(200);
    expect((await res.json()).outcome.state).toBe('ran');
  });

  it('returns 403 for run=true on the public demo, even for a supervisor, and runs nothing', async () => {
    await freshDb();
    vi.stubEnv('DEMO_PUBLIC', 'true');
    const res = await post({ run: true });
    expect(res.status).toBe(403);
    const withDays = await post({ days: 10, run: true });
    expect(withDays.status).toBe(403);
    // The policy was not changed by the refused request either.
    vi.unstubAllEnvs();
    expect((await post({})).status).toBe(200);
    const read = await (await post({})).json();
    expect(read.documentsDays).toBe(365);
  });

  it('still lets a supervisor set the period (without running) on the public demo', async () => {
    await freshDb();
    vi.stubEnv('DEMO_PUBLIC', 'true');
    const res = await post({ days: 90 });
    expect(res.status).toBe(200);
    expect((await res.json()).documentsDays).toBe(90);
  });

  it('refuses non-JSON bodies (415) and cross-origin posts (403)', async () => {
    await freshDb();
    expect((await post({ run: true }, { 'content-type': 'text/plain' })).status).toBe(415);
    expect((await post({ run: true }, { 'content-type': 'application/json', origin: 'https://evil.example' })).status).toBe(403);
    expect((await post({ run: true }, { 'content-type': 'application/json', origin: 'https://desk.example' })).status).toBe(200);
  });

  it('keeps the supervisor-only rule', async () => {
    await freshDb();
    session.role = 'handler';
    expect((await post({ run: true })).status).toBe(403);
    expect(U.handlerA.role).toBe('handler');
  });
});
