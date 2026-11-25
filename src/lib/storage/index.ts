import { createHmac, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { derivedSecret, downloadLinkTtlSeconds } from '../env';

/**
 * Private object storage. Implement this for S3 / Neon-adjacent blob stores; objects must never be
 * publicly readable: downloads go through the signed-link route which also checks case access.
 */
export interface ObjectStorage {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
}

export class MemoryStorage implements ObjectStorage {
  private m = new Map<string, Uint8Array>();
  async put(key: string, bytes: Uint8Array) {
    this.m.set(key, bytes);
  }
  async get(key: string) {
    return this.m.get(key) ?? null;
  }
  async delete(key: string) {
    this.m.delete(key);
  }
}

export class LocalFsStorage implements ObjectStorage {
  constructor(private root: string) {}
  private resolve(key: string): string {
    if (!/^[A-Za-z0-9_\-./]+$/.test(key) || key.includes('..')) throw new Error('invalid storage key');
    return path.join(this.root, key);
  }
  async put(key: string, bytes: Uint8Array) {
    const p = this.resolve(key);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, bytes);
  }
  async get(key: string) {
    try {
      return new Uint8Array(await fs.readFile(this.resolve(key)));
    } catch {
      return null;
    }
  }
  async delete(key: string) {
    await fs.rm(this.resolve(key), { force: true });
  }
}

const g = globalThis as unknown as { __isdStorage?: ObjectStorage };

export function getStorage(): ObjectStorage {
  if (!g.__isdStorage) {
    const memory = process.env.VITEST || process.env.VERCEL || process.env.STORAGE_DRIVER === 'memory';
    g.__isdStorage = memory
      ? new MemoryStorage()
      : new LocalFsStorage(process.env.STORAGE_DIR ?? path.join(process.cwd(), '.data', 'files'));
  }
  return g.__isdStorage;
}

/** Tests / S3 wiring can swap the implementation. */
export function setStorage(s: ObjectStorage): void {
  g.__isdStorage = s;
}

// ---- short-lived signed download links ----

const b64 = (s: string) => Buffer.from(s).toString('base64url');

function mac(payload: string): string {
  return createHmac('sha256', derivedSecret('download')).update(payload).digest('base64url');
}

export function signDownloadToken(documentId: string, opts?: { ttlSeconds?: number; now?: number }): string {
  const now = opts?.now ?? Date.now();
  const exp = Math.floor(now / 1000) + (opts?.ttlSeconds ?? downloadLinkTtlSeconds());
  const payload = b64(JSON.stringify({ d: documentId, e: exp }));
  return `${payload}.${mac(payload)}`;
}

export function verifyDownloadToken(token: string, now = Date.now()): { documentId: string } | null {
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = mac(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const { d, e } = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { d: string; e: number };
    if (typeof d !== 'string' || typeof e !== 'number' || e * 1000 < now) return null;
    return { documentId: d };
  } catch {
    return null;
  }
}

export function downloadUrl(documentId: string): string {
  return `/api/documents/${documentId}/download?t=${signDownloadToken(documentId)}`;
}
