// Seeds fictional demo data when the users table is empty.
import { getDb } from '../src/db/client';
import { seedIfEmpty } from '../src/db/seed';

process.env.AUTO_MIGRATE = '1';
getDb()
  .then(async (db) => {
    console.log((await seedIfEmpty(db)) ? 'seeded' : 'already seeded');
    process.exit(0);
  })
  .catch((e) => {
    console.error('seed failed:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
