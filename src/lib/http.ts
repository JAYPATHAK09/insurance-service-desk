import { NextResponse } from 'next/server';
import { HttpError } from './access';
import { IngestError } from './ingest';
import { log } from './log';
import { WorkflowError } from './workflow';

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
