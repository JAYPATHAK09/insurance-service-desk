// Applies migrations from ./drizzle to DATABASE_URL (or the local PGlite store when unset).
import { getDb } from '../src/db/client';

process.env.AUTO_MIGRATE = '1';
getDb()
  .then(() => {
    console.log('migrations applied');
    process.exit(0);
  })
  .catch((e) => {
    console.error('migration failed:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
