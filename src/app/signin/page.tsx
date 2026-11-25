import { asc } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { getDb } from '@/db/client';
import { users } from '@/db/schema';
import { getUser } from '@/lib/session';
import { signInAction } from './actions';

export const dynamic = 'force-dynamic';

const BLURB: Record<string, string> = {
  handler: 'Works only the cases assigned to them.',
  supervisor: 'Sees every case and can approve and export.',
  analyst: 'Read-only access to every case.',
};

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (await getUser()) redirect('/');
  const { error } = await searchParams;
  const db = await getDb();
  const all = await db.select().from(users).orderBy(asc(users.role));
  return (
    <div className="mx-auto max-w-xl py-10">
      <h1 className="text-3xl font-semibold tracking-tight">Sign in</h1>
      <p className="mt-3 text-muted">
        Demo access with three fictional users, one per role. No real credentials are used or stored.
      </p>
      {error ? (
        <p role="alert" className="mt-6 rounded-lg border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">
          Could not sign in. Pick one of the listed users.
        </p>
      ) : null}
      <div className="mt-8 space-y-4">
        {all.map((u) => (
          <form key={u.id} action={signInAction} className="card flex items-center justify-between gap-4 p-6">
            <input type="hidden" name="userId" value={u.id} />
            <div>
              <div className="font-medium">{u.name}</div>
              <div className="text-sm text-muted">{BLURB[u.role]}</div>
            </div>
            <button className="btn" data-testid={`signin-${u.role}`}>
              Continue as {u.role}
            </button>
          </form>
        ))}
      </div>
    </div>
  );
}
