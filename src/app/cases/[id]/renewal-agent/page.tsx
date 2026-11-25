import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { inArray } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { users } from '@/db/schema';
import { fmtDateTime, ModeBadge, StatusPill } from '@/components/ui';
import { canAccessCase } from '@/lib/access';
import { CLASSIFICATIONS } from '@/lib/contracts';
import { ERRORS, NOTICES, messageFor } from '@/lib/messages';
import { getUser } from '@/lib/session';
import { buildExplanation, EXPLANATION_LANGS, type ExplanationLang } from '@/modules/renewal-agent/explain';
import {
  approvalIsCurrent,
  decisionLabel,
  loadState,
  pagesOf,
  parseAckNote,
  readiness,
  toExplainFinding,
  CHANNELS,
  type SideAttr,
} from '@/modules/renewal-agent/service';
import { FIELD_LABEL, type FieldId } from '@/modules/renewal-agent/types';
import { acknowledgeAction, approveAction, correctAction, decideRowAction, runReviewAction } from './actions';

export const dynamic = 'force-dynamic';

const CLASS_STYLE: Record<string, string> = {
  confirmed_change: 'border-accent text-accent',
  mismatched_pair: 'border-danger/50 text-danger',
  absent_page: 'border-warn/60 text-warn',
  ocr_failure: 'border-warn/60 text-warn',
  ambiguous: 'border-warn/60 text-warn',
};
const pretty = (s: string) => s.replace(/_/g, ' ');

export default async function RenewalAgentPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ lang?: string; error?: string; notice?: string }>;
}) {
  const user = await getUser();
  if (!user) redirect('/signin');
  const { id } = await params;
  const sp = await searchParams;
  const lang: ExplanationLang = (EXPLANATION_LANGS as readonly string[]).includes(sp.lang ?? '') ? (sp.lang as ExplanationLang) : 'en';

  const db = await getDb();
  let st;
  try {
    st = await loadState(db, id);
  } catch {
    notFound();
  }
  const c = st.case;
  // Unauthorised and unknown look the same: no case-existence leak.
  if (c.module !== 'renewal-agent' || !canAccessCase(user, c, 'read')) notFound();
  const canWrite = canAccessCase(user, c, 'write');
  const isSupervisor = user.role === 'supervisor' && canWrite;

  const names = new Map<string, string>();
  const ids = [...new Set(st.approvals.map((a) => a.by).filter((x): x is string => !!x))];
  if (ids.length) for (const u of await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids))) names.set(u.id, u.name);

  const rows = st.findings;
  const exp = buildExplanation(rows.map(toExplainFinding), lang);
  const approval = st.approvals.find((a) => a.lang === lang);
  const approved = approvalIsCurrent(st.approvals, exp);
  const blocked = readiness(rows);
  const pair = rows.filter((f) => f.classification === 'mismatched_pair' || f.key.startsWith('pair:'));
  const pageIssues = rows.filter((f) => f.key.startsWith('ocr:') || f.key.startsWith('absent:'));
  const terms = rows.filter((f) => f.key.startsWith('renewal:'));
  const anyApproved = EXPLANATION_LANGS.some((l) => approvalIsCurrent(st.approvals, buildExplanation(rows.map(toExplainFinding), l)));
  const base = `/cases/${c.id}/renewal-agent`;

  return (
    <div className="space-y-8" data-page="renewal-agent">
      <div className="space-y-2">
        <Link href={`/cases/${c.id}`} className="text-sm">
          &larr; Back to case
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold">Renewal terms change review</h1>
          <StatusPill status={c.status} />
          {st.review ? <ModeBadge mode={st.review.mode} model={st.review.modelId} /> : null}
        </div>
        <p className="text-sm text-muted">
          {c.insurer} · {c.reference} · {c.title}
          {st.review ? ` · review v${st.review.version}, prompt ${st.review.promptVersion}, ${fmtDateTime(st.review.createdAt)}` : ''}
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

      {canWrite ? (
        <form action={runReviewAction.bind(null, c.id)} className="card flex items-center gap-3 p-5">
          <input type="hidden" name="lang" value={lang} />
          <button className="btn">Run review</button>
          <span className="text-sm text-muted">Compares the expiring schedule and endorsements with the renewal proposal. Same documents and model reuse the existing review.</span>
        </form>
      ) : (
        <p className="text-sm text-muted">Read-only access: you can view this review but not change it.</p>
      )}

      {!st.review ? <p className="text-muted">No review has been run yet. Upload the schedule, endorsements and renewal proposal on the case page (set each document kind), then run the review.</p> : null}

      {pair.length ? (
        <section className="card space-y-3 border-danger/40 p-5" aria-label="Document pair check">
          <h2 className="text-lg font-semibold text-danger">Document pair could not be confirmed. No terms were compared.</h2>
          {pair.map((f) => (
            <div key={f.id} className="space-y-1" data-finding={f.id}>
              <span className="pill">{pretty(f.classification)}</span>
              <p className="text-sm">{f.summary}</p>
              {f.evidence.map((e, i) => (
                <blockquote key={i} className="border-l-2 border-line pl-4 text-sm text-muted">
                  “{e.quote}” <span className="text-xs">(page {e.page}, {e.verified ? 'citation verified' : 'citation NOT verified'})</span>
                </blockquote>
              ))}
              <DecisionForm f={f} canWrite={canWrite} lang={lang} caseId={c.id} />
            </div>
          ))}
        </section>
      ) : null}

      {pageIssues.length ? (
        <section className="card space-y-2 border-warn/40 p-5" aria-label="Incomplete documents">
          <h2 className="text-lg font-semibold text-warn">Incomplete or unreadable pages</h2>
          <p className="text-sm text-muted">No change is asserted for any term that may be on these pages.</p>
          <ul className="space-y-2 text-sm">
            {pageIssues.map((f) => (
              <li key={f.id} data-finding={f.id} className="space-y-1">
                <span className="pill mr-2">{pretty(f.classification)}</span>
                {f.summary}
                <DecisionForm f={f} canWrite={canWrite} lang={lang} caseId={c.id} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {terms.length ? (
        <section className="space-y-3" aria-label="Comparison">
          <h2 className="text-lg font-semibold">Old versus new</h2>
          <p className="text-sm text-muted">Old = expiring schedule with endorsements applied in date order (an endorsement overrides the schedule). Page numbers are file pages.</p>
          <div className="card overflow-x-auto">
            <table className="w-full border-collapse" data-testid="comparison-table">
              <thead>
                <tr className="border-b border-line">
                  <th className="th">Term</th>
                  <th className="th">Old</th>
                  <th className="th">New</th>
                  <th className="th">Result</th>
                  <th className="th">Source pages</th>
                  <th className="th">Reviewer decision</th>
                </tr>
              </thead>
              <tbody>
                {terms.map((f) => {
                  const a = (f.attributes ?? {}) as { field?: FieldId; item_label?: string; material?: boolean; incomplete_document?: boolean; old?: SideAttr | null; new?: SideAttr | null };
                  const ack = st.acks.find((x) => x.findingId === f.id);
                  return (
                    <tr key={f.id} className="border-b border-line align-top last:border-0" data-finding={f.id} data-classification={f.classification}>
                      <td className="td">
                        <div className="font-medium">{a.field ? FIELD_LABEL[a.field] : f.type}</div>
                        {a.item_label && a.field !== 'exclusion' ? <div className="text-xs text-muted">{a.item_label}</div> : null}
                        {a.material ? <span className="pill mt-1">material</span> : null}
                      </td>
                      <td className="td">{a.old?.display ?? <span className="text-muted">not shown</span>}</td>
                      <td className="td">{a.new?.display ?? <span className="text-muted">not shown</span>}</td>
                      <td className="td">
                        <span className={`inline-flex rounded-full border px-2.5 py-0.5 text-xs font-medium ${CLASS_STYLE[f.classification] ?? 'border-line text-ink'}`}>{pretty(f.classification)}</span>
                        {a.incomplete_document ? <div className="mt-1 text-xs text-warn">document incomplete</div> : null}
                        {f.corrections.length ? <div className="mt-1 text-xs text-muted">corrected {f.corrections.length}x</div> : null}
                      </td>
                      <td className="td text-xs">
                        <div>Old: {pagesOf(a.old) || '-'}</div>
                        <div>New: {pagesOf(a.new) || '-'}</div>
                        <details className="mt-2">
                          <summary className="cursor-pointer text-accent">Quotes</summary>
                          <p className="mt-1 text-sm">{f.summary}</p>
                          {f.evidence.map((e, i) => (
                            <blockquote key={i} className="mt-1 border-l-2 border-line pl-3 text-muted">
                              “{e.quote}” (page {e.page}, {e.verified ? 'verified' : 'NOT verified'})
                            </blockquote>
                          ))}
                        </details>
                      </td>
                      <td className="td">
                        <div className="text-sm font-medium">{decisionLabel(f)}</div>
                        {f.decision?.note ? <div className="text-xs text-muted">{f.decision.note}</div> : null}
                        {ack ? <div className="mt-1 text-xs text-success">Customer acknowledged ({ack.acknowledgedBy})</div> : null}
                        <DecisionForm f={f} canWrite={canWrite} lang={lang} caseId={c.id} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {st.review ? (
        <section className="card space-y-4 p-5" aria-label="Customer explanation">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-lg font-semibold">Customer explanation (draft)</h2>
            <nav className="flex gap-1" aria-label="Language">
              {EXPLANATION_LANGS.map((l) => (
                <Link key={l} href={`${base}?lang=${l}`} aria-current={l === lang ? 'page' : undefined} className={`pill no-underline ${l === lang ? 'border-accent text-accent' : ''}`}>
                  {l === 'en' ? 'English' : 'हिन्दी'}
                </Link>
              ))}
            </nav>
            <span className={`pill ${approved ? 'border-success text-success' : 'border-warn text-warn'}`}>{approved ? 'Approved by supervisor' : 'Draft: not approved'}</span>
          </div>
          <p className="text-sm text-muted">Never sent by the platform. A supervisor approves this exact text; the advisor then sends it outside the platform. Any change to a decision creates a new text version that needs approval again.</p>
          <pre lang={lang === 'hi' ? 'hi' : 'en'} className="whitespace-pre-wrap rounded-lg border border-line bg-subtle p-4 text-sm leading-relaxed" data-testid="explanation-text">
            {exp.text}
          </pre>
          <p className="font-mono text-xs text-muted">Text version: {exp.version}</p>
          {approval && approved ? (
            <p className="text-sm text-muted">
              Approved by {approval.by ? names.get(approval.by) ?? approval.by : 'unknown'} on {fmtDateTime(approval.at)}.
            </p>
          ) : null}
          {isSupervisor ? (
            <form action={approveAction.bind(null, c.id)} className="flex flex-wrap items-center gap-3">
              <input type="hidden" name="lang" value={lang} />
              <input type="hidden" name="version" value={exp.version} />
              <button className="btn" disabled={approved || !!blocked}>
                Approve this text ({lang === 'hi' ? 'Hindi' : 'English'})
              </button>
              {blocked ? <span className="text-sm text-warn">{blocked}</span> : null}
            </form>
          ) : canWrite ? (
            <p className="text-sm text-muted">Only a supervisor can approve the explanation.{blocked ? ` Open: ${blocked}` : ''}</p>
          ) : null}
        </section>
      ) : null}

      {st.review && exp.changes.length ? (
        <section className="card space-y-4 p-5" aria-label="Customer acknowledgements">
          <h2 className="text-lg font-semibold">Customer acknowledgement of material changes</h2>
          <p className="text-sm text-muted">Record each change the customer has acknowledged, after the approved text was sent by the advisor. Recorded: who, when, channel and text version.</p>
          <ul className="space-y-4">
            {exp.changes.map((i) => {
              const f = rows.find((r) => r.id === i.findingId)!;
              const ack = st.acks.find((x) => x.findingId === f.id);
              const note = parseAckNote(ack?.note ?? null);
              const label = `${FIELD_LABEL[i.field]}${i.itemLabel && i.field !== 'exclusion' ? ` (${i.itemLabel})` : ''}${i.field === 'exclusion' ? `: ${i.itemLabel}` : ''}`;
              return (
                <li key={f.id} className="space-y-2 border-b border-line pb-4 last:border-0" data-ack-for={f.id}>
                  <div className="font-medium">{label}</div>
                  {ack ? (
                    <p className="text-sm text-success">
                      Acknowledged by {ack.acknowledgedBy} via {note?.channel ?? 'unknown channel'} on {fmtDateTime(ack.createdAt)} · {ack.language === 'hi' ? 'Hindi' : 'English'} · version {note?.textVersion ?? 'n/a'}
                    </p>
                  ) : canWrite && approved && f.status === 'accepted' ? (
                    <form action={acknowledgeAction.bind(null, c.id)} className="flex flex-wrap items-end gap-3">
                      <input type="hidden" name="findingId" value={f.id} />
                      <input type="hidden" name="lang" value={lang} />
                      <label className="text-xs text-muted">
                        Customer name
                        <input name="customerName" required minLength={2} maxLength={120} className="input mt-1" />
                      </label>
                      <label className="text-xs text-muted">
                        Channel
                        <select name="channel" className="input mt-1" defaultValue="phone">
                          {CHANNELS.map((ch) => (
                            <option key={ch} value={ch}>
                              {pretty(ch)}
                            </option>
                          ))}
                        </select>
                      </label>
                      <button className="btn-quiet">Record acknowledgement</button>
                    </form>
                  ) : (
                    <p className="text-sm text-muted">{!approved ? 'Waiting for supervisor approval of the explanation in this language.' : f.status !== 'accepted' ? 'The reviewer must confirm this change first.' : 'Read-only.'}</p>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {st.review ? (
        <section className="card space-y-3 p-5" aria-label="Export">
          <h2 className="text-lg font-semibold">Export</h2>
          {anyApproved ? (
            <div className="flex flex-wrap gap-3">
              <a className="btn no-underline" href={`${base}/export`} data-testid="export-csv">
                Download CSV
              </a>
              <Link className="btn-quiet no-underline" href={`${base}/print?lang=${lang}`} data-testid="export-print">
                Printable view
              </Link>
            </div>
          ) : (
            <p className="text-sm text-muted">Export unlocks after a supervisor approves the customer explanation for the current findings.</p>
          )}
        </section>
      ) : null}
    </div>
  );
}

function DecisionForm({ f, canWrite, lang, caseId }: { f: { id: string; classification: string; status: string }; canWrite: boolean; lang: string; caseId: string }) {
  if (!canWrite) return null;
  return (
    <details className="mt-2">
      <summary className="cursor-pointer text-xs text-accent">{f.status === 'open' ? 'Decide' : 'Change decision'}</summary>
      <form action={decideRowAction.bind(null, caseId)} className="mt-2 space-y-2">
        <input type="hidden" name="findingId" value={f.id} />
        <input type="hidden" name="lang" value={lang} />
        <label className="block text-xs text-muted">
          Note (required to reject)
          <input name="note" maxLength={900} className="input mt-1" />
        </label>
        <div className="flex flex-wrap gap-2">
          <button name="choice" value="confirm" className="btn-quiet">
            Confirm
          </button>
          <button name="choice" value="reject" className="btn-quiet">
            Reject
          </button>
          <button name="choice" value="clarify" className="btn-quiet">
            Needs insurer clarification
          </button>
        </div>
      </form>
      <form action={correctAction.bind(null, caseId)} className="mt-3 space-y-2">
        <input type="hidden" name="findingId" value={f.id} />
        <input type="hidden" name="lang" value={lang} />
        <label className="block text-xs text-muted">
          Correct classification
          <select name="to" className="input mt-1" defaultValue={f.classification}>
            {CLASSIFICATIONS['renewal-agent'].map((k) => (
              <option key={k} value={k}>
                {pretty(k)}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-xs text-muted">
          Reason
          <input name="reason" minLength={3} maxLength={500} className="input mt-1" />
        </label>
        <button className="btn-quiet">Save correction</button>
      </form>
    </details>
  );
}
