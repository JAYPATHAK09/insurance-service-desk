import { describe, expect, it } from 'vitest';
import { LocalFsStorage, MemoryStorage, signDownloadToken, verifyDownloadToken } from '@/lib/storage';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

describe('signed download links', () => {
  it('valid within the TTL, expired after it (default 5 minutes)', () => {
    const t0 = 1_700_000_000_000;
    const token = signDownloadToken('doc-1', { now: t0 });
    expect(verifyDownloadToken(token, t0 + 4 * 60_000)).toEqual({ documentId: 'doc-1' });
    expect(verifyDownloadToken(token, t0 + 5 * 60_000 + 1_000)).toBeNull();
  });

  it('rejects tampered tokens and tokens for another document', () => {
    const token = signDownloadToken('doc-1');
    const [payload, sig] = token.split('.');
    const other = Buffer.from(JSON.stringify({ d: 'doc-2', e: 9_999_999_999 })).toString('base64url');
    expect(verifyDownloadToken(`${other}.${sig}`)).toBeNull();
    expect(verifyDownloadToken(`${payload}.x${sig}`)).toBeNull();
    expect(verifyDownloadToken('garbage')).toBeNull();
  });
});

describe('storage adapters', () => {
  it('memory and local fs round-trip; local fs rejects path traversal', async () => {
    const m = new MemoryStorage();
    await m.put('a/b', new Uint8Array([1, 2]));
    expect(await m.get('a/b')).toEqual(new Uint8Array([1, 2]));
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'isd-'));
    const l = new LocalFsStorage(dir);
    await l.put('cases/x/y.txt', new Uint8Array([9]));
    expect(await l.get('cases/x/y.txt')).toEqual(new Uint8Array([9]));
    await l.delete('cases/x/y.txt');
    expect(await l.get('cases/x/y.txt')).toBeNull();
    await expect(l.put('../escape', new Uint8Array([1]))).rejects.toThrow();
    await fs.rm(dir, { recursive: true, force: true });
  });
});
