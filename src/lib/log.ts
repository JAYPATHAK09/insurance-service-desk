import { sanitizeRecord } from './sanitize';

/** Structured logger. Meta passes through the same sanitiser as the audit log. */
export function log(level: 'info' | 'warn' | 'error', event: string, meta?: Record<string, unknown>): void {
  if (process.env.VITEST) return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, event, ...sanitizeRecord(meta) });
  (level === 'error' ? console.error : console.log)(line);
}
