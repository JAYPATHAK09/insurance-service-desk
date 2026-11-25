import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { cases, users } from '@/db/schema';
import { ModeBadge, fmtDateTime } from '@/components/ui';
import { canAccessCase } from '@/lib/access';
import { CLASSIFICATIONS } from '@/lib/contracts';
import { listDocuments } from '@/lib/ingest';
import { ERRORS, NOTICES, messageFor } from '@/lib/messages';
import { getUser } from '@/lib/session';
import { downloadUrl } from '@/lib/storage';
import { currentDraft, latestFindings } from '@/modules/claim-reconciler/service';
import { approveDraftAction, correctAction, decideAction, runAction, supervisorApproveAction } from './actions';

export const dynamic = 'force-dynamic';

const LABEL: Record<string, string> = {
  satisfied_pending_verification: 'Satisfied, pending handler verification',
  partially_satisfied: 'Partially satisfied',
  missing: 'Missing',
  ambiguous: 'Ambiguous',
  repeated_request: 'Repeated request',
};
/** Attention-first: what most needs a human decision comes first. */
const GROUP_ORDER = ['missing', 'ambiguous', 'partially_satisfied', 'repeated_request', 'satisfied_pending_verification'];
const TONE: Record<string, string> = {
  missing: 'border-danger/40 bg-danger/10 text-danger',
  ambiguous: 'border-warn/40 bg-warn/10 text-warn',
  partially_satisfied: 'border-warn/40 bg-warn/10 text-warn',
  repeated_request: 'border-accent/40 bg-accent/10 text-accent',
  satisfied_pending_verification: 'border-success/40 bg-success/10 text-success',
};

export default async function ClaimReconcilerPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const user = await getUser();
  if (!user) redirect('/signin');
  const { id } = await params;
  const sp = await searchParams;
  const db = await getDb();
  const [row] = await db.select({ c: cases, owner: users.name }).from(cases).innerJoin(users, eq(users.id, cases.ownerId)).where(eq(cases.id, id));
  // Unknown and unauthorised look the same: no case-existence leak.
  if (!row || !canAccessCase(user, row.c, 'read')) notFound();
  const c = row.c;
  if (c.module !== 'claim-reconciler') notFound();
  const canWrite = canAccessCase(user, c, 'write');

  const [{ review, rows }, docs, draft] = await Promise.all([latestFindings(db, c.id), listDocuments(db, c.id), currentDraft(db, c.id)]);
  const docById = new Map(docs.map((d) => [d.id, d]));
  const run = runAction.bind(null, c.id);
  const decide = decideAction.bind(null, c.id);
  const correct = correctAction.bind(null, c.id);
  const approve = approveDraftAction.bind(null, c.id);
  const supApprove = supervisorApproveAction.bind(null, c.id);

  const groups = GROUP_ORDER.map((k) => ({
    k,
    items: rows
      .filter((f) => f.classification === k)
      // Undecided first, then by item number.
      .sort((a, b) => Number(a.status !== 'open') - Number(b.status !== 'open') || Number((a.attributes as { item_no?: number } | null)?.item_no ?? 0) - Number((b.attributes as { item_no?: number } | null)?.item_no ?? 0)),
  })).filter((g) => g.items.length);

  return (
    <div className="space-y-8">
      <div>
        <Link href={`/cases/${c.id}`} className="text-sm text-muted">
          ← {c.reference}
        </Link>
        <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">Claim Query Reconciler</h1>
            <p className="mt-1 text-muted">
              {c.reference} · {c.insurer} · {c.title}
            </p>
          </div>
          {review ? <ModeBadge mode={review.mode} model={review.modelId} /> : null}
        </div>
        <p className="mt-3 max-w-3xl text-sm text-muted">
          Each item the insurer asked for is matched against the case documents, register and submission receipts. A receipt shows something was sent, never that it was enough. The
          tool does not decide the claim and sends nothing: every finding needs a handler decision.
        </p>
      </div>

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

      <div className="card flex flex-wrap items-center gap-3 p-5">
        {canWrite ? (
          <form action={run}>
            <button className="btn">{review ? 'Re-run review' : 'Run review'}</button>
          </form>
        ) : (
          <span className="text-sm text-muted">Read-only access.</span>
        )}
        <a href={`/cases/${c.id}/claim-reconciler/chronology?format=csv`} className="btn-quiet no-underline">
          Download chronology (CSV)
        </a>
        <a href={`/cases/${c.id}/claim-reconciler/chronology?format=txt`} className="btn-quiet no-underline">
          Download chronology (printable text)
        </a>
        {review ? (
          <span className="text-xs text-muted">
            Review v{review.version} · prompt {review.promptVersion} · {fmtDateTime(review.createdAt)}
          </span>
        ) : null}
      </div>

      {!review ? <p className="text-muted">No review yet. Documents on file: {docs.length}. Choose Run review.</p> : null}

      {groups.map((g) => (
        <section key={g.k} className="space-y-4" data-group={g.k}>
          <h2 className="flex items-center gap-3 text-lg font-semibold">
            <span className={`inline-flex rounded-full border px-2.5 py-0.5 text-xs font-medium ${TONE[g.k]}`}>{LABEL[g.k]}</span>
            <span className="text-muted">{g.items.length}</span>
          </h2>
          {g.items.map((f) => {
            const a = (f.attributes ?? {}) as { item_no?: number; item_text?: string; receipt_only?: boolean; submission_refs?: string[]; reason?: string; downgradedFrom?: string };
            return (
              <article key={f.id} className="card space-y-3 p-5" data-finding={f.id} data-classification={f.classification}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="pill">Item {a.item_no ?? '?'}</span>
                  <span className="pill">{f.status === 'open' ? 'Awaiting handler' : f.status}</span>
                  {a.receipt_only ? <span className="pill">Submitted, sufficiency unverified</span> : null}
                  {a.downgradedFrom ? <span className="pill">Downgraded from {a.downgradedFrom.replace(/_/g, ' ')}</span> : null}
                  {review ? <ModeBadge mode={review.mode} model={review.modelId} /> : null}
                </div>
                {a.item_text ? <p className="text-sm font-medium">Insurer asked: {a.item_text}</p> : null}
                <p>{f.summary}</p>
                {f.evidence.length ? (
                  <ul className="space-y-2">
                    {f.evidence.map((e, i) => {
                      const d = docById.get(e.doc_id);
                      return (
                        <li key={i}>
                          <blockquote className="border-l-2 border-line pl-4 text-sm text-muted">
                            “{e.quote}”{' '}
                            <span className="text-xs">
                              (page {e.page}, {d ? <a href={downloadUrl(d.id)}>{d.filename}</a> : 'document no longer on file'}, {e.verified ? 'citation verified' : <span className="text-danger">citation NOT verified</span>})
                            </span>
                          </blockquote>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className="text-sm text-muted">No document contains this item, so there is nothing to quote.</p>
                )}
                <dl className="grid gap-3 text-sm md:grid-cols-3">
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-muted">Submission reference</dt>
                    <dd className="mt-1 font-medium">{a.submission_refs?.length ? a.submission_refs.join(', ') : 'None on file'}</dd>
                  </div>
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-muted">Suggested owner</dt>
                    <dd className="mt-1 font-medium">{f.suggestedOwner ?? '-'}</dd>
                  </div>
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-muted">Next action</dt>
                    <dd className="mt-1">{f.nextAction ?? '-'}</dd>
                  </div>
                </dl>
                {f.corrections.length ? (
                  <p className="text-xs text-muted">
                    Corrections: {f.corrections.map((x) => `${String(x.from).replace(/_/g, ' ')} to ${String(x.to).replace(/_/g, ' ')} (${x.reason})`).join('; ')}
                  </p>
                ) : null}
                {f.decision ? (
                  <p className="text-sm text-muted">
                    Handler decision: {f.decision.decision}
                    {f.decision.note ? ` - ${f.decision.note}` : ''}
                  </p>
                ) : null}
                {canWrite ? (
                  <div className="space-y-3 border-t border-line pt-3">
                    {!f.decision ? (
                      <form action={decide} className="flex flex-wrap items-end gap-3">
                        <input type="hidden" name="findingId" value={f.id} />
                        <label className="flex-1 text-xs text-muted">
                          Verification note (required to override or dismiss)
                          <input name="note" className="input mt-1" maxLength={1000} />
                        </label>
                        <button name="decision" value="accept" className="btn-quiet">
                          Verified: accept
                        </button>
                        <button name="decision" value="override" className="btn-quiet">
                          Override
                        </button>
                        <button name="decision" value="dismiss" className="btn-quiet">
                          Dismiss
                        </button>
                      </form>
                    ) : null}
                    <form action={correct} className="flex flex-wrap items-end gap-3">
                      <input type="hidden" name="findingId" value={f.id} />
                      <label className="text-xs text-muted">
                        Correct classification
                        <select name="to" className="input mt-1" defaultValue={f.classification}>
                          {CLASSIFICATIONS['claim-reconciler'].map((k) => (
                            <option key={k} value={k}>
                              {LABEL[k]}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="flex-1 text-xs text-muted">
                        Reason
                        <input name="reason" className="input mt-1" maxLength={500} required minLength={3} />
                      </label>
                      <button className="btn-quiet">Record correction</button>
                    </form>
                  </div>
                ) : null}
              </article>
            );
          })}
        </section>
      ))}

      {draft ? (
        <section className="space-y-4" data-section="draft">
          <h2 className="flex flex-wrap items-center gap-3 text-lg font-semibold">
            Draft response
            <span className={`inline-flex rounded-full border px-2.5 py-0.5 text-xs font-medium ${draft.status.status === 'ready' ? 'border-success/40 bg-success/10 text-success' : 'border-warn/40 bg-warn/10 text-warn'}`} data-testid="draft-status">
              {draft.status.status === 'ready' ? 'READY (approved by handler, not sent)' : 'DRAFT'}
            </span>
          </h2>
          <p className="text-sm text-muted">
            A text draft for the handler to edit and send themselves. It is marked ready only after an explicit handler approval of this exact text; any later change to a finding returns it to DRAFT. Nothing is sent from here.
          </p>
          <pre className="card overflow-x-auto whitespace-pre-wrap p-5 text-sm">{`DRAFT - NOT SENT\n\n${draft.body}`}</pre>
          <div className="flex flex-wrap items-center gap-3">
            <a href={`/cases/${c.id}/claim-reconciler/draft`} className="btn-quiet no-underline">
              Download draft (text)
            </a>
            {draft.status.handler ? (
              <span className="text-sm text-muted">
                Handler approval: {draft.status.handler.by}, {fmtDateTime(draft.status.handler.at)}
              </span>
            ) : null}
            {draft.status.supervisor ? (
              <span className="text-sm text-muted">
                Supervisor approval: {draft.status.supervisor.by}, {fmtDateTime(draft.status.supervisor.at)}
              </span>
            ) : null}
          </div>
          {canWrite && draft.status.status === 'draft' ? (
            <form action={approve} className="card flex flex-wrap items-center gap-3 p-5">
              <input type="hidden" name="draftHash" value={draft.hash} />
              <button className="btn" disabled={draft.open > 0}>
                I have read this draft: approve as handler
              </button>
              {draft.open > 0 ? <span className="text-sm text-muted">{draft.open} finding(s) still need a decision.</span> : null}
            </form>
          ) : null}
          {canWrite && user.role === 'supervisor' && draft.status.status === 'ready' && !draft.status.supervisor ? (
            <form action={supApprove} className="card flex flex-wrap items-center gap-3 p-5">
              <input type="hidden" name="draftHash" value={draft.hash} />
              <button className="btn">Supervisor approval</button>
            </form>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
