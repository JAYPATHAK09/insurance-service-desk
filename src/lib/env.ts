import { createHmac } from 'node:crypto';

const DEV_SECRET = 'dev-only-insecure-session-secret-change-me';

/** Server-side secret. The dev default is only ever used outside production. */
export function sessionSecret(): string {
  const s = process.env.SESSION_SECRET;
  if (s && s.length >= 16) return s;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('SESSION_SECRET must be set (min 16 chars) in production');
  }
  return DEV_SECRET;
}

/** Domain-separated sub-key so a download token can never be replayed as a session cookie. */
export function derivedSecret(purpose: string): string {
  return createHmac('sha256', sessionSecret()).update(`isd:${purpose}`).digest('hex');
}

export function downloadLinkTtlSeconds(): number {
  const n = Number(process.env.DOWNLOAD_LINK_TTL_SECONDS);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 3600) : 300;
}

export function maxUploadBytes(): number {
  const n = Number(process.env.MAX_UPLOAD_BYTES);
  return Number.isFinite(n) && n > 0 ? n : 10 * 1024 * 1024;
}
