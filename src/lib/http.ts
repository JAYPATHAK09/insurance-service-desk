import { NextResponse } from 'next/server';
import { HttpError } from './access';
import { IngestError } from './ingest';
import { log } from './log';
import { WorkflowError } from './workflow';

/** State-changing JSON endpoints: require application/json and, when the browser sends Origin, same-origin. */
export function assertJsonSameOrigin(req: Request): void {
  const type = req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (type !== 'application/json') throw new HttpError(415, 'Content-Type must be application/json');
  const origin = req.headers.get('origin');
  // Cross-site browser posts always carry Origin (possibly the literal "null"); non-browser clients send none.
  if (origin !== null && origin !== new URL(req.url).origin) throw new HttpError(403, 'Cross-origin request refused');
}

/** Wrap a route handler: maps domain errors to status codes and never leaks internals. */
export function api<A extends unknown[]>(fn: (...args: A) => Promise<Response>) {
  return async (...args: A): Promise<Response> => {
    try {
      return await fn(...args);
    } catch (err) {
      if (err instanceof HttpError) return NextResponse.json({ error: err.message }, { status: err.status });
      if (err instanceof IngestError) return NextResponse.json({ error: err.message }, { status: err.status });
      if (err instanceof WorkflowError) return NextResponse.json({ error: err.message }, { status: 409 });
      log('error', 'api.unhandled', { name: err instanceof Error ? err.name : 'unknown' });
      return NextResponse.json({ error: 'Internal error' }, { status: 500 });
    }
  };
}
