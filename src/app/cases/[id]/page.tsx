import { asc, desc, eq } from 'drizzle-orm';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getDb } from '@/db/client';
import { auditLog, cases, documents, findings, reviews, users } from '@/db/schema';
import { AttentionTag, fmtDate, fmtDateTime, MODULE_LABEL, ModeBadge, STATE_LABEL, StatusPill } from '@/components/ui';
import { canAccessCase } from '@/lib/access';
import { computeAttention, countsFor } from '@/lib/cases';
import { WORKFLOW_STATES, type WorkflowState } from '@/lib/contracts';
import { listDocuments } from '@/lib/ingest';
import { ERRORS, NOTICES, messageFor } from '@/lib/messages';
import { getUser } from '@/lib/session';
import { downloadUrl } from '@/lib/storage';
import { REOPENABLE, TRANSITIONS } from '@/lib/workflow';
import { getModule } from '@/modules/registry';
import { decideAction, reopenAction, reviewAction, transitionAction, uploadAction } from './actions';

export const dynamic = 'force-dynamic';

const TABS = [
  ['documents', 'Documents'],
  ['findings', 'Findings'],
  ['chronology', 'Chronology'],
  ['audit', 'Audit'],
] as const;
type Tab = (typeof TABS)[number][0];

export default async function CasePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string; error?: string; notice?: string }>;
}) {
  const user = await getUser();
  if (!user) redirect('/signin');
  const { id } = await params;
  const sp = await searchParams;
  const tab: Tab = TABS.some(([k]) => k === sp.tab) ? (sp.tab as Tab) : 'documents';

  const db = await getDb();
  const [row] = await db
    .select({ c: cases, owner: users.name })
    .from(cases)
    .innerJoin(users, eq(users.id, cases.ownerId))
    .where(eq(cases.id, id));
  if (!row) notFound();
  // Unauthorised and unknown look the same to the caller: no case-existence leak.
  if (!canAccessCase(user, row.c, 'read')) notFound();
  const c = row.c;
  const canWrite = canAccessCase(user, c, 'write');
  const engine = getModule(c.module);
  const attention = computeAttention(c, (await countsFor(db, [c.id])).get(c.id)!);

  const upload = uploadAction.bind(null, c.id);
  const transition = transitionAction.bind(null, c.id);
  const reopen = reopenAction.bind(null, c.id);
  const review = reviewAction.bind(null, c.id);
  const decide = decideAction.bind(null, c.id);

  const next = TRANSITIONS[c.status];
  const stepIdx = WORKFLOW_STATES.indexOf(c.status);

  return (
    <div className="space-y-8">
      <div>
        <Link href="/" className="text-sm text-muted">
          ← Case queue
        </Link>
        <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">{c.reference}</h1>
            <p className="mt-1 text-muted">{c.title}</p>
          </div>
          <AttentionTag reasons={attention} />
        </div>
        <dl className="mt-6 grid grid-cols-2 gap-6 text-sm md:grid-cols-5">
          {[
            ['Module', MODULE_LABEL[c.module]],
            ['Insurer', c.insurer],
            ['Owner', row.owner],
            ['Due date', fmtDate(c.dueDate)],
            ['Priority', c.priority],
          ].map(([k, v]) => (
            <div key={k}>
              <dt className="text-xs uppercase tracking-wide text-muted">{k}</dt>
              <dd className="mt-1 font-medium">{v}</dd>
            </div>
          ))}
        </dl>
      </div>

      <ol className="flex flex-wrap gap-2" aria-label="Workflow">
        {WORKFLOW_STATES.map((s, i) => (
          <li
            key={s}
            aria-current={s === c.status ? 'step' : undefined}
            className={`rounded-full border px-3 py-1 text-xs font-medium ${
              s === c.status ? 'border-accent bg-accent text-accent-ink' : i < stepIdx ? 'border-line text-ink' : 'border-line text-muted'
            }`}
          >
            {STATE_LABEL[s]}
          </li>
        ))}
      </ol>

      {messageFor(ERRORS, sp.error) ? (
        <p role="alert" className="rounded-lg border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">
          {messageFor(ERRORS, sp.error)}
        </p>
      ) : null}
      {messageFor(NOTICES, sp.notice) ? (
        <p role="status" className="rounded-lg border border-success/40 bg-success/10 px-4 py-3 text-sm text-success">
          {messageFor(NOTICES, sp.notice)}
        </p>
      ) : null}

      {canWrite ? (
        <div className="card flex flex-wrap items-center gap-3 p-5">
          {next.map((to) => (
            <form key={to} action={transition}>
              <input type="hidden" name="to" value={to} />
              <button className="btn-quiet">Move to {STATE_LABEL[to as WorkflowState]}</button>
            </form>
          ))}
          <form action={review}>
            <button className="btn">Run review</button>
          </form>
          <Link href={engine.route.replace('{id}', c.id)} className="btn-quiet no-underline">
            Open {engine.label}
          </Link>
        </div>
      ) : (
        <p className="text-sm text-muted">Read-only access: you can view this case but not change it.</p>
      )}

      <nav className="flex gap-1 border-b border-line" aria-label="Case sections">
        {TABS.map(([k, label]) => (
          <Link
            key={k}
            href={`/cases/${c.id}?tab=${k}`}
            aria-current={tab === k ? 'page' : undefined}
            className={`-mb-px border-b-2 px-4 py-3 text-sm font-medium no-underline ${
              tab === k ? 'border-accent text-accent' : 'border-transparent text-muted hover:text-ink'
            }`}
          >
            {label}
          </Link>
        ))}
      </nav>

      {tab === 'documents' ? (
        <DocumentsTab caseId={c.id} canWrite={canWrite} upload={upload} />
      ) : tab === 'findings' ? (
        <FindingsTab caseId={c.id} canWrite={canWrite} decide={decide} />
      ) : tab === 'chronology' ? (
        <ChronologyTab caseId={c.id} />
      ) : (
        <AuditTab caseId={c.id} canReopen={canWrite && REOPENABLE.includes(c.status)} reopen={reopen} />
      )}
    </div>
  );
}

async function DocumentsTab({ caseId, canWrite, upload }: { caseId: string; canWrite: boolean; upload: (f: FormData) => Promise<void> }) {
  const db = await getDb();
  const docs = await listDocuments(db, caseId);
  return (
    <div className="space-y-6" data-tab="documents">
      {canWrite ? (
        <form action={upload} className="card flex flex-wrap items-end gap-4 p-5">
          <label className="text-xs text-muted">
            File (PDF, TXT or CSV)
            <input type="file" name="file" accept=".pdf,.txt,.csv" required className="input mt-1" />
          </label>
          <label className="text-xs text-muted">
            Kind
            <select name="kind" className="input mt-1" defaultValue="other">
              {['other', 'query_letter', 'document_register', 'correspondence', 'receipt', 'submission', 'proposal', 'disclosure', 'policy_schedule', 'endorsement', 'renewal_proposal'].map((k) => (
                <option key={k} value={k}>
                  {k.replace(/_/g, ' ')}
                </option>
              ))}
            </select>
          </label>
          <button className="btn">Upload</button>
        </form>
      ) : null}
      <div className="card overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-line">
              <th className="th">File</th>
              <th className="th">Kind</th>
              <th className="th">Pages</th>
              <th className="th">OCR</th>
              <th className="th">SHA-256</th>
              <th className="th">Link (5 min)</th>
            </tr>
          </thead>
          <tbody>
            {docs.map((d) => {
              const failed = d.pages.filter((p) => p.ocr_status === 'failed').length;
              return (
                <tr key={d.id} className="border-b border-line last:border-0">
                  <td className="td font-medium">{d.filename}</td>
                  <td className="td">{d.kind.replace(/_/g, ' ')}</td>
                  <td className="td">{d.pages.length}</td>
                  <td className="td">{failed ? <span className="text-danger">{failed} page(s) failed</span> : 'OK'}</td>
                  <td className="td font-mono text-xs text-muted">{d.sha256.slice(0, 12)}</td>
                  <td className="td">
                    <a href={downloadUrl(d.id)}>Download</a>
                  </td>
                </tr>
              );
            })}
            {docs.length === 0 ? (
              <tr>
                <td colSpan={6} className="td py-12 text-center text-muted">
                  No documents yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

async function FindingsTab({ caseId, canWrite, decide }: { caseId: string; canWrite: boolean; decide: (f: FormData) => Promise<void> }) {
  const db = await getDb();
  const revs = await db.select().from(reviews).where(eq(reviews.caseId, caseId)).orderBy(desc(reviews.version));
  const fs = await db.select().from(findings).where(eq(findings.caseId, caseId)).orderBy(asc(findings.createdAt));
  if (!revs.length) return <p className="text-muted">No review has been run yet. Upload documents, then choose Run review.</p>;
  return (
    <div className="space-y-8" data-tab="findings">
      {revs.map((r) => (
        <section key={r.id} className="space-y-4">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <h2 className="text-lg font-semibold">Review v{r.version}</h2>
            <ModeBadge mode={r.mode} model={r.modelId} />
            <span className="text-muted">
              prompt {r.promptVersion} · {r.documentHashes.length} document(s) · {fmtDateTime(r.createdAt)}
            </span>
          </div>
          {fs
            .filter((f) => f.reviewId === r.id)
            .map((f) => (
              <article key={f.id} className="card space-y-3 p-5" data-finding={f.id}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="pill">{f.classification.replace(/_/g, ' ')}</span>
                  <span className="pill">{f.status}</span>
                  <ModeBadge mode={r.mode} model={r.modelId} />
                </div>
                <p>{f.summary}</p>
                {f.evidence.map((e, i) => (
                  <blockquote key={i} className="border-l-2 border-line pl-4 text-sm text-muted">
                    “{e.quote}” <span className="text-xs">(page {e.page}, {e.verified ? 'citation verified' : 'citation NOT verified'})</span>
                  </blockquote>
                ))}
                {f.nextAction ? <p className="text-sm">Next action: {f.nextAction}</p> : null}
                {f.decision ? (
                  <p className="text-sm text-muted">
                    Decision: {f.decision.decision} {f.decision.note ? `- ${f.decision.note}` : ''}
                  </p>
                ) : canWrite ? (
                  <form action={decide} className="flex flex-wrap items-end gap-3">
                    <input type="hidden" name="findingId" value={f.id} />
                    <label className="flex-1 text-xs text-muted">
                      Note (required to override or dismiss)
                      <input name="note" className="input mt-1" maxLength={1000} />
                    </label>
                    {(['accept', 'override', 'dismiss'] as const).map((d) => (
                      <button key={d} name="decision" value={d} className="btn-quiet">
                        {d}
                      </button>
                    ))}
                  </form>
                ) : null}
              </article>
            ))}
        </section>
      ))}
    </div>
  );
}

async function ChronologyTab({ caseId }: { caseId: string }) {
  const db = await getDb();
  const [docs, revs, events] = await Promise.all([
    listDocumentsWithDates(caseId),
    db.select().from(reviews).where(eq(reviews.caseId, caseId)),
    db.select().from(auditLog).where(eq(auditLog.caseId, caseId)),
  ]);
  const items = [
    ...docs.map((d) => ({ at: d.createdAt, text: `Document added: ${d.filename}` })),
    ...revs.map((r) => ({ at: r.createdAt, text: `Review v${r.version} (${r.mode === 'synthetic' ? 'Synthetic' : `Live (${r.modelId})`})` })),
    ...events.map((e) => ({ at: e.at, text: e.action })),
  ].sort((a, b) => a.at.getTime() - b.at.getTime());
  return (
    <ol className="space-y-3" data-tab="chronology">
      {items.map((i, n) => (
        <li key={n} className="flex gap-4 text-sm">
          <span className="w-44 shrink-0 text-muted">{fmtDateTime(i.at)}</span>
          <span>{i.text}</span>
        </li>
      ))}
      {items.length === 0 ? <p className="text-muted">Nothing recorded yet.</p> : null}
    </ol>
  );
}

async function listDocumentsWithDates(caseId: string) {
  const db = await getDb();
  return db.select({ filename: documents.filename, createdAt: documents.createdAt }).from(documents).where(eq(documents.caseId, caseId));
}

async function AuditTab({ caseId, canReopen, reopen }: { caseId: string; canReopen: boolean; reopen: (f: FormData) => Promise<void> }) {
  const db = await getDb();
  const rows = await db.select().from(auditLog).where(eq(auditLog.caseId, caseId)).orderBy(desc(auditLog.at)).limit(200);
  return (
    <div className="space-y-6" data-tab="audit">
      {canReopen ? (
        <form action={reopen} className="card flex flex-wrap items-end gap-4 p-5">
          <label className="flex-1 text-xs text-muted">
            Reason for reopening (recorded in the audit trail)
            <input name="reason" required minLength={5} maxLength={500} className="input mt-1" />
          </label>
          <button className="btn-quiet">Reopen case</button>
        </form>
      ) : null}
      <div className="card overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-line">
              <th className="th">When</th>
              <th className="th">Action</th>
              <th className="th">Actor</th>
              <th className="th">Details (no document contents)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-line last:border-0">
                <td className="td whitespace-nowrap">{fmtDateTime(r.at)}</td>
                <td className="td font-medium">{r.action}</td>
                <td className="td text-muted">{r.actorId ?? 'system'}</td>
                <td className="td font-mono text-xs text-muted">{JSON.stringify(r.meta)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
