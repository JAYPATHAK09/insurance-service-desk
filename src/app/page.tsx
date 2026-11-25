import Link from 'next/link';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { getDb } from '@/db/client';
import { users } from '@/db/schema';
import { listQueue } from '@/lib/cases';
import { MODULE_IDS, WORKFLOW_STATES } from '@/lib/contracts';
import { getUser } from '@/lib/session';
import { AttentionTag, fmtDate, MODULE_LABEL, StatusPill, STATE_LABEL } from '@/components/ui';

export const dynamic = 'force-dynamic';

const Query = z.object({
  module: z.enum(MODULE_IDS).optional().catch(undefined),
  status: z.enum(WORKFLOW_STATES).optional().catch(undefined),
  insurer: z.string().max(100).optional().catch(undefined),
  owner: z.string().max(100).optional().catch(undefined),
  attention: z.literal('1').optional().catch(undefined),
});

export default async function QueuePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await getUser();
  if (!user) redirect('/signin');
  const q = Query.parse(await searchParams);
  const db = await getDb();
  const all = await listQueue(db, user);
  const rows = await listQueue(db, user, {
    module: q.module,
    status: q.status,
    insurer: q.insurer || undefined,
    ownerId: q.owner || undefined,
    attentionOnly: q.attention === '1',
  });
  const insurers = [...new Set(all.map((r) => r.insurer))].sort();
  const owners = user.role === 'handler' ? [] : await db.select({ id: users.id, name: users.name }).from(users);
  const needAttention = all.filter((r) => r.attention.length).length;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Case queue</h1>
        <p className="mt-2 text-muted">
          {user.role === 'handler' ? 'Your assigned cases.' : 'All cases.'} {needAttention} need attention and are listed first.
        </p>
      </div>

      <form method="get" className="card grid grid-cols-2 items-end gap-4 p-5 md:grid-cols-6" aria-label="Filters">
        <label className="text-xs text-muted">
          Module
          <select name="module" defaultValue={q.module ?? ''} className="input mt-1">
            <option value="">All</option>
            {MODULE_IDS.map((m) => (
              <option key={m} value={m}>
                {MODULE_LABEL[m]}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-muted">
          Status
          <select name="status" defaultValue={q.status ?? ''} className="input mt-1">
            <option value="">All</option>
            {WORKFLOW_STATES.map((s) => (
              <option key={s} value={s}>
                {STATE_LABEL[s]}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-muted">
          Insurer
          <select name="insurer" defaultValue={q.insurer ?? ''} className="input mt-1">
            <option value="">All</option>
            {insurers.map((i) => (
              <option key={i}>{i}</option>
            ))}
          </select>
        </label>
        {owners.length ? (
          <label className="text-xs text-muted">
            Owner
            <select name="owner" defaultValue={q.owner ?? ''} className="input mt-1">
              <option value="">All</option>
              {owners.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <span />
        )}
        <label className="flex items-center gap-2 pb-2 text-sm">
          <input type="checkbox" name="attention" value="1" defaultChecked={q.attention === '1'} />
          Needs attention
        </label>
        <div className="flex gap-2">
          <button className="btn">Apply</button>
          <Link href="/" className="btn-quiet no-underline">
            Reset
          </Link>
        </div>
      </form>

      <div className="card overflow-x-auto">
        <table className="w-full min-w-[900px] border-collapse" data-testid="case-queue">
          <thead>
            <tr className="border-b border-line">
              <th className="th">Case</th>
              <th className="th">Owner</th>
              <th className="th">Status</th>
              <th className="th">Due date</th>
              <th className="th">Insurer</th>
              <th className="th">Module</th>
              <th className="th">Attention</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={`border-b border-line last:border-0 ${r.attention.length ? 'bg-danger/5' : ''}`} data-attention={r.attention.length > 0}>
                <td className="td">
                  <Link href={`/cases/${r.id}`} className="font-medium">
                    {r.reference}
                  </Link>
                  <div className="mt-0.5 max-w-xs text-xs text-muted">{r.title}</div>
                </td>
                <td className="td">{r.ownerName}</td>
                <td className="td">
                  <StatusPill status={r.status} />
                </td>
                <td className="td whitespace-nowrap">{fmtDate(r.dueDate)}</td>
                <td className="td">{r.insurer}</td>
                <td className="td">{MODULE_LABEL[r.module]}</td>
                <td className="td">
                  <AttentionTag reasons={r.attention} />
                </td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={7} className="td py-12 text-center text-muted">
                  No cases match these filters.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
