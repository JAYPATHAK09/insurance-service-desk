import { describe, expect, it, vi } from 'vitest';
import { runJob } from '@/lib/jobs';
import { freshDb } from './helpers';

describe('jobs', () => {
  it('runs once per idempotency key and replays the stored result', async () => {
    const db = await freshDb();
    const fn = vi.fn(async () => ({ n: 1 }));
    const a = await runJob(db, { idempotencyKey: 'k1', type: 't', run: fn });
    const b = await runJob(db, { idempotencyKey: 'k1', type: 't', run: fn });
    expect(a.state).toBe('ran');
    expect(b).toMatchObject({ state: 'replayed', result: { n: 1 } });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('concurrent callers with the same key run the work once', async () => {
    const db = await freshDb();
    const fn = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 30));
      return { ok: true };
    });
    const out = await Promise.all([1, 2, 3].map(() => runJob(db, { idempotencyKey: 'race', type: 't', run: fn })));
    expect(fn).toHaveBeenCalledTimes(1);
    expect(out.filter((o) => o.state === 'ran')).toHaveLength(1);
  });

  it('retries a failed job with attempts+1 and stops after the maximum', async () => {
    const db = await freshDb();
    let calls = 0;
    const flaky = async () => {
      calls++;
      if (calls < 2) throw new Error('boom');
      return { done: true };
    };
    await expect(runJob(db, { idempotencyKey: 'f', type: 't', run: flaky })).rejects.toThrow();
    const second = await runJob(db, { idempotencyKey: 'f', type: 't', run: flaky });
    expect(second).toMatchObject({ state: 'ran', attempts: 2 });

    const always = vi.fn(async () => {
      throw new Error('x');
    });
    for (let i = 0; i < 3; i++) await expect(runJob(db, { idempotencyKey: 'dead', type: 't', run: always })).rejects.toThrow();
    const last = await runJob(db, { idempotencyKey: 'dead', type: 't', run: always });
    expect(last.state).toBe('exhausted');
    expect(always).toHaveBeenCalledTimes(3);
  });
});
