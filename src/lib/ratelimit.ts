import { headers } from 'next/headers';
import { HttpError } from './access';

/**
 * Fixed-window, in-memory limiter keyed by action + client IP. Best effort only: state is per server
 * instance (each serverless instance has its own counters) and resets on restart. Put Vercel Firewall
 * rate limiting in front of a public deployment for a real guarantee.
 */
export const RATE_LIMIT_PER_MINUTE = 30;
const WINDOW_MS = 60_000;
const MAX_KEYS = 5_000;

const buckets = new Map<string, { start: number; count: number }>();

/** Returns true when the request is allowed. */
export function rateLimit(action: string, ip: string, now = Date.now(), limit = RATE_LIMIT_PER_MINUTE): boolean {
  const key = `${action}|${ip}`;
  const b = buckets.get(key);
  if (!b || now - b.start >= WINDOW_MS) {
    if (buckets.size >= MAX_KEYS) {
      for (const [k, v] of buckets) if (now - v.start >= WINDOW_MS) buckets.delete(k);
      if (buckets.size >= MAX_KEYS) buckets.clear(); // memory guard: fail open rather than grow without bound
    }
    buckets.set(key, { start: now, count: 1 });
    return true;
  }
  b.count++;
  return b.count <= limit;
}

export function resetRateLimits(): void {
  buckets.clear();
}

/** First hop of x-forwarded-for (set by the platform proxy), else x-real-ip, else a shared bucket. */
export function clientIp(h: { get(name: string): string | null }): string {
  const fwd = h.get('x-forwarded-for')?.split(',')[0]?.trim();
  return (fwd || h.get('x-real-ip') || 'unknown').slice(0, 64);
}

/** Throws HttpError(429) when the caller exceeds the limit for this action. */
export async function enforceRateLimit(action: string): Promise<void> {
  if (!rateLimit(action, clientIp(await headers()))) throw new HttpError(429, 'Too many requests, try again in a minute');
}
