/**
 * Keeps document contents out of audit rows and logs.
 * Rule: metadata may carry ids, counts, states, short enum-like values. Anything that looks like
 * document text (denylisted keys, or long free text) is dropped or replaced by its length.
 */
const DENY_KEYS = new Set([
  'text', 'content', 'contents', 'body', 'quote', 'quotes', 'pages', 'excerpt', 'snippet',
  'prompt', 'output', 'raw', 'evidence', 'summary', 'document', 'data', 'bytes',
]);
const MAX_STRING = 120;

export function sanitizeMeta(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'string') {
    return value.length > MAX_STRING ? `[redacted:${value.length}]` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (depth >= 3) return '[depth]';
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => sanitizeMeta(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (DENY_KEYS.has(k.toLowerCase())) {
        out[k] = '[omitted]';
        continue;
      }
      out[k] = sanitizeMeta(v, depth + 1);
    }
    return out;
  }
  return '[unsupported]';
}

export function sanitizeRecord(meta: Record<string, unknown> | undefined): Record<string, unknown> {
  return (sanitizeMeta(meta ?? {}) as Record<string, unknown>) ?? {};
}
