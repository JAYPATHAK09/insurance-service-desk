import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { cases } from '@/db/schema';
import { fmtDateTime, ModeBadge } from '@/components/ui';
import { canAccessCase } from '@/lib/access';
import { ERRORS, NOTICES, messageFor } from '@/lib/messages';
import { getUser } from '@/lib/session';
import { NEVER_COMPLETES_STATEMENT } from '@/modules/disclosure-checker';
import { RECORD_NOTICE } from '@/modules/disclosure-checker/report';
import { CHANNELS, CLASS_ORDER, loadState, type WorkspaceState } from '@/modules/disclosure-checker/resolve';
import { approveAction, resolveAction, runComparisonAction } from './actions';

export const dynamic = 'force-dynamic';

type F = WorkspaceState['findings'][number];
const a = (f: F, k: string): string => {
  const v = (f.attributes ?? {})[k];
  return v === null || v === undefined ? '' : String(v);
};
const label = (s: string) => s.replace(/_/g, ' ');

export default async function DisclosurePage({
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
  const [c] = await db.select().from(cases).where(eq(cases.id, id));
  // Unknown and unauthorised look the same: no case-existence leak.
  if (!c || c.module !== 'disclosure-checker' || !canAccessCase(user, c, 'read')) notFound();
  const canWrite = canAccessCase(user, c, 'write');
  const state = await loadState(db, c.id);
  const run = runComparisonAction.bind(null, c.id);
  const approve = approveAction.bind(null, c.id);
  const resolve = resolveAction.bind(null, c.id);

  const sorted = [...state.findings].sort(
    (x, y) => (CLASS_ORDER as readonly string[]).indexOf(x.classification) - (CLASS_ORDER as readonly string[]).indexOf(y.classification),
  );
  const groups = new Map<string, F[]>();
  for (const f of sorted) {
    const k = a(f, 'member') ? `${a(f, 'member')} (${a(f, 'relation')})` : 'Whole documents';
    groups.set(k, [...(groups.get(k) ?? []), f]);
  }
  const open = state.findings.filter((f) => f.status === 'open').length;
  const docName = new Map(state.docs.map((d) => [d.id, d.filename]));

  return (
    <div className="space-y-8">
      <div>
        <Link href={`/cases/${c.id}`} className="text-sm text-muted">
          ← Case {c.reference}
        </Link>
        <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">Proposal Disclosure Checker</h1>
            <p className="mt-1 text-muted">
              {c.reference} · {c.insurer} · {c.title}
            </p>
          </div>
          {state.review ? <ModeBadge mode={state.review.mode} model={state.review.modelId} /> : null}
        </div>
      </div>

      <p className="card border-accent/40 p-4 text-sm font-medium" data-testid="never-completes">
        {NEVER_COMPLETES_STATEMENT}
      </p>

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
            <button className="btn">Run comparison</button>
          </form>
        ) : (
          <span className="text-sm text-muted">Read-only access.</span>
        )}
        {state.review ? (
          <>
            <a className="btn-quiet no-underline" href={`/cases/${c.id}/disclosure-checker/export?format=csv`}>
              Export CSV
            </a>
            <a className="btn-quiet no-underline" href={`/cases/${c.id}/disclosure-checker/export?format=txt`}>
              Export printable report
            </a>
          </>
        ) : null}
        {user.role === 'supervisor' && state.review ? (
          <form action={approve}>
            <button className="btn" disabled={open > 0} title={open > 0 ? 'Every finding must be resolved first' : undefined}>
              Approve reconciliation
            </button>
          </form>
        ) : null}
        <span className="text-sm text-muted">
          {state.review ? `${state.findings.length} finding(s), ${open} open` : 'No comparison run yet.'}
          {' · '}
          {state.approval?.valid
            ? `Approved by ${state.approval.by}, ${fmtDateTime(state.approval.at)}`
            : state.approval
              ? 'Approval withdrawn: findings changed afterwards'
              : 'Not approved'}
        </span>
      </div>
      <p className="text-xs text-muted">{RECORD_NOTICE} Nothing here is ever submitted to the insurer or written into the proposal.</p>

      {state.review ? (
        <p className="text-sm text-muted">
          Review v{state.review.version} · prompt {state.review.promptVersion} · {state.review.documentHashes.length} document(s) ·{' '}
          {fmtDateTime(state.review.createdAt)}
          {state.previousReviews > 0 ? ` · ${state.previousReviews} earlier version(s) kept in the case history` : ''}
        </p>
      ) : (
        <p className="text-muted">Upload the customer-confirmed disclosure (type: disclosure) and the draft proposal (type: proposal) on the case page, then run the comparison.</p>
      )}
      {state.review && state.findings.length === 0 ? (
        <p className="card p-5" data-testid="no-findings">
          No differences found: every answer in the customer confirmation matches the proposal as written.
        </p>
      ) : null}

      {[...groups.entries()].map(([group, items]) => (
        <section key={group} className="space-y-4" data-member={group}>
          <h2 className="text-lg font-semibold">{group}</h2>
          {items.map((f) => (
            <article key={f.id} className="card space-y-4 p-5" data-finding={f.id} data-classification={f.classification}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="pill">{label(f.classification)}</span>
                <span className="pill">{label(f.type)}</span>
                <span className="pill">{f.escalated ? 'escalated' : f.status}</span>
                {a(f, 'question_id') ? <span className="text-sm font-medium">{a(f, 'question_id')} {a(f, 'question')}</span> : null}
              </div>
              <p>{f.summary}</p>
              {a(f, 'downgradedFrom') ? (
                <p className="text-sm text-muted">Downgraded to ambiguous from {label(a(f, 'downgradedFrom'))} ({label(a(f, 'downgradeReason'))}).</p>
              ) : null}

              {f.evidence.length || a(f, 'customer_doc_id') || a(f, 'proposal_doc_id') ? (
                <div className="grid gap-4 md:grid-cols-2" data-testid="side-by-side">
                  <Passage title="Customer-confirmed" f={f} docId={a(f, 'customer_doc_id')} date={a(f, 'customer_date')} docName={docName} />
                  <Passage title="Draft proposal" f={f} docId={a(f, 'proposal_doc_id')} date={a(f, 'proposal_date')} docName={docName} />
                </div>
              ) : null}
              {!a(f, 'customer_doc_id') && !a(f, 'proposal_doc_id') ? <GenericEvidence f={f} docName={docName} /> : null}

              {f.nextAction ? <p className="text-sm">Next step for the advisor: {f.nextAction}</p> : null}

              {f.confirmation ? (
                <div className="rounded-lg border border-line bg-subtle p-3 text-sm" data-testid="confirmation-record">
                  <p className="font-medium">Customer confirmation recorded</p>
                  <p>
                    {f.confirmation.by} via {label(f.confirmation.channel)}, confirmed {fmtDateTime(f.confirmation.confirmedAt)}: “{f.confirmation.value}” ·{' '}
                    {f.confirmation.proposalChange === 'change_needed' ? 'proposal needs correcting by the advisor and customer' : 'proposal answer stands'}
                  </p>
                </div>
              ) : null}
              {f.decision ? (
                <p className="text-sm text-muted">
                  Last decision: {f.decision.decision} by {f.decidedByName}, {fmtDateTime(f.decision.at)}
                  {f.decision.note ? ` - ${f.decision.note}` : ''}
                </p>
              ) : null}
              {f.corrections.length ? (
                <details className="text-sm">
                  <summary className="cursor-pointer text-muted">Correction history ({f.corrections.length})</summary>
                  <ul className="mt-2 space-y-1 text-muted">
                    {f.corrections.map((h, i) => (
                      <li key={i}>
                        {fmtDateTime(h.at)} · {h.field}: {typeof h.from === 'object' && h.from ? JSON.stringify(h.from) : String(h.from)} → {JSON.stringify(h.to)} ({h.reason})
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}

              {canWrite ? <ResolveForms findingId={f.id} resolve={resolve} reResolve={f.status !== 'open'} /> : null}
            </article>
          ))}
        </section>
      ))}
    </div>
  );
}

function Passage({ title, f, docId, date, docName }: { title: string; f: F; docId: string; date: string; docName: Map<string, string> }) {
  const e = docId ? f.evidence.find((x) => x.doc_id === docId) : undefined;
  return (
    <div className="rounded-lg border border-line p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted">{title}</p>
      {e ? (
        <>
          <blockquote className="mt-2 border-l-2 border-line pl-3 font-mono text-sm">{e.quote}</blockquote>
          <p className="mt-2 text-xs text-muted">
            {docName.get(e.doc_id) ?? 'document'} · page {e.page} · {date ? `dated ${date}` : 'no date'} · {e.verified ? 'quote verified on page' : 'quote NOT verified'}
          </p>
        </>
      ) : (
        <p className="mt-2 text-sm text-muted">No entry in this document. A missing entry is not a “No”.</p>
      )}
    </div>
  );
}

function GenericEvidence({ f, docName }: { f: F; docName: Map<string, string> }) {
  if (!f.evidence.length) return null;
  return (
    <div className="space-y-2">
      {f.evidence.map((e, i) => (
        <blockquote key={i} className="border-l-2 border-line pl-3 font-mono text-sm">
          {e.quote} <span className="font-sans text-xs text-muted">({docName.get(e.doc_id) ?? 'document'}, page {e.page}, {e.verified ? 'verified' : 'NOT verified'})</span>
        </blockquote>
      ))}
    </div>
  );
}

function ResolveForms({ findingId, resolve, reResolve }: { findingId: string; resolve: (f: FormData) => Promise<void>; reResolve: boolean }) {
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted">{reResolve ? 'Re-resolving keeps the earlier decision in the history.' : 'Resolve this finding:'}</p>
      <details className="rounded-lg border border-line p-3">
        <summary className="cursor-pointer text-sm font-medium">Customer confirmed the correct value</summary>
        <form action={resolve} className="mt-3 grid gap-3 md:grid-cols-2">
          <input type="hidden" name="findingId" value={findingId} />
          <input type="hidden" name="outcome" value="customer_confirmed" />
          <label className="text-xs text-muted">
            Who confirmed
            <input name="customerName" required minLength={2} maxLength={100} className="input mt-1" />
          </label>
          <label className="text-xs text-muted">
            Channel
            <select name="channel" className="input mt-1" defaultValue="call">
              {CHANNELS.map((ch) => (
                <option key={ch} value={ch}>
                  {label(ch)}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-muted">
            When confirmed (date)
            <input name="confirmedAt" type="date" required className="input mt-1" />
          </label>
          <label className="text-xs text-muted">
            Does the proposal need correcting?
            <select name="proposalChange" className="input mt-1" defaultValue="change_needed">
              <option value="change_needed">Yes, the advisor and customer will correct it</option>
              <option value="proposal_correct">No, the proposal answer stands</option>
            </select>
          </label>
          <label className="text-xs text-muted md:col-span-2">
            Value the customer stated (typed by the advisor, in the customer&apos;s words)
            <input name="value" required maxLength={300} className="input mt-1" />
          </label>
          <label className="text-xs text-muted md:col-span-2">
            Note (optional)
            <input name="note" maxLength={900} className="input mt-1" />
          </label>
          <div className="md:col-span-2">
            <button className="btn">Record customer confirmation</button>
          </div>
        </form>
      </details>
      <details className="rounded-lg border border-line p-3">
        <summary className="cursor-pointer text-sm font-medium">Mark resolved without a change</summary>
        <form action={resolve} className="mt-3 flex flex-wrap items-end gap-3">
          <input type="hidden" name="findingId" value={findingId} />
          <input type="hidden" name="outcome" value="resolved" />
          <label className="text-xs text-muted">
            Reason
            <select name="reason" className="input mt-1">
              <option value="no_action_needed">No action needed</option>
              <option value="false_match">The tool matched wrongly (false match)</option>
            </select>
          </label>
          <label className="flex-1 text-xs text-muted">
            Note (required)
            <input name="note" required minLength={3} maxLength={1000} className="input mt-1" />
          </label>
          <button className="btn-quiet">Resolve</button>
        </form>
      </details>
      <details className="rounded-lg border border-line p-3">
        <summary className="cursor-pointer text-sm font-medium">Escalate to a supervisor</summary>
        <form action={resolve} className="mt-3 flex flex-wrap items-end gap-3">
          <input type="hidden" name="findingId" value={findingId} />
          <input type="hidden" name="outcome" value="escalate" />
          <label className="flex-1 text-xs text-muted">
            Why (required)
            <input name="note" required minLength={3} maxLength={1000} className="input mt-1" />
          </label>
          <button className="btn-quiet">Escalate</button>
        </form>
      </details>
    </div>
  );
}
