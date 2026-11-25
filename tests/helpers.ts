import { getDb, resetDb } from '@/db/client';
import { cases, users } from '@/db/schema';
import type { SessionUser } from '@/lib/access';

export const U = {
  handlerA: { id: 'u-a', email: 'a@t.example', name: 'Handler A', role: 'handler' },
  handlerB: { id: 'u-b', email: 'b@t.example', name: 'Handler B', role: 'handler' },
  supervisor: { id: 'u-s', email: 's@t.example', name: 'Supervisor', role: 'supervisor' },
  analyst: { id: 'u-n', email: 'n@t.example', name: 'Analyst', role: 'analyst' },
} as const satisfies Record<string, SessionUser>;

export async function freshDb() {
  const db = await getDb();
  await resetDb();
  await db.insert(users).values(Object.values(U));
  return db;
}

export async function makeCase(
  ownerId: string,
  over: Partial<typeof cases.$inferInsert> = {},
): Promise<typeof cases.$inferSelect> {
  const db = await getDb();
  const [c] = await db
    .insert(cases)
    .values({
      module: 'claim-reconciler',
      insurer: 'Test Insurer',
      reference: `REF-${Math.random().toString(36).slice(2, 8)}`,
      title: 'Test case',
      ownerId,
      dueDate: new Date(Date.now() + 5 * 86_400_000),
      ...over,
    })
    .returning();
  return c!;
}

export const bytes = (s: string) => new TextEncoder().encode(s);
