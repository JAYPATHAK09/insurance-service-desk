import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { drizzle as drizzlePg } from 'drizzle-orm/postgres-js';
import { migrate as migratePg } from 'drizzle-orm/postgres-js/migrator';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import postgres from 'postgres';
import * as schema from './schema';

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

const migrationsFolder = path.join(process.cwd(), 'drizzle');

export type DbKind = 'neon' | 'pglite';

export function dbKind(): DbKind {
  return process.env.DATABASE_URL ? 'neon' : 'pglite';
}

/** PGlite location: in-memory for tests and read-only hosts, a local dir otherwise. */
function pgliteLocation(): string | undefined {
  if (process.env.NODE_ENV === 'test' || process.env.VITEST) return undefined;
  if (process.env.PGLITE_DIR) {
    fs.mkdirSync(path.dirname(process.env.PGLITE_DIR), { recursive: true });
    return process.env.PGLITE_DIR;
  }
  if (process.env.VERCEL) return undefined;
  const dir = path.join(process.cwd(), '.data', 'pglite');
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  return dir;
}

async function open(): Promise<Db> {
  if (dbKind() === 'neon') {
    const client = postgres(process.env.DATABASE_URL as string, { max: 5, ssl: 'require' });
    const db = drizzlePg(client, { schema }) as unknown as Db;
    if (process.env.AUTO_MIGRATE === '1') await migratePg(drizzlePg(client), { migrationsFolder });
    return db;
  }
  const client = new PGlite(pgliteLocation());
  const db = drizzlePglite(client, { schema });
  await migratePglite(db, { migrationsFolder });
  return db as unknown as Db;
}

const g = globalThis as unknown as { __isdDb?: Promise<Db> };

/** Process-wide singleton. Migrates (and, in synthetic mode, seeds) on first use. */
export function getDb(): Promise<Db> {
  if (!g.__isdDb) {
    g.__isdDb = (async () => {
      const db = await open();
      const wantSeed = !process.env.VITEST && (dbKind() === 'pglite' || process.env.DEMO_SEED === '1');
      if (wantSeed) {
        const { seedIfEmpty } = await import('./seed');
        await seedIfEmpty(db);
      }
      return db;
    })();
    g.__isdDb.catch(() => {
      g.__isdDb = undefined;
    });
  }
  return g.__isdDb;
}

/** Test helper: wipe all rows (keeps schema). */
export async function resetDb(): Promise<void> {
  const db = await getDb();
  const { sql } = await import('drizzle-orm');
  await db.execute(
    sql`truncate table kpi_events, acknowledgements, findings, reviews, jobs, documents, audit_log, cases, retention_policy, users restart identity cascade`,
  );
}

export { schema };
