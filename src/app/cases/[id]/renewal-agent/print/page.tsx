import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getDb } from '@/db/client';
import { fmtDateTime, ModeBadge } from '@/components/ui';
import { HttpError, requireCaseAccess } from '@/lib/access';
import { getUser } from '@/lib/session';
import { EXPLANATION_LANGS, type ExplanationLang } from '@/modules/renewal-agent/explain';
import { RenewalError, exportData } from '@/modules/renewal-agent/service';
import { PrintButton } from './PrintButton';

export const dynamic = 'force-dynamic';

/** Printable export: same gate as the CSV (needs a current supervisor approval). */
export default async function PrintPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ lang?: string }> }) {
  const user = await getUser();
  if (!user) redirect('/signin');
  const { id } = await params;
  const sp = await searchParams;
  const db = await getDb();
  try {
    // Authorise before anything is read or audited. Unknown and forbidden look the same.
    const c0 = await requireCaseAccess(db, user, id, 'read');
    if (c0.module !== 'renewal-agent') notFound();
  } catch (err) {
    if (err instanceof HttpError) notFound();
    throw err;
  }
  let data;
  try {
    data = await exportData(db, { caseId: id, user });
  } catch (err) {
    if (err instanceof RenewalError && err.message === 'Case not found') notFound();
    if (err instanceof RenewalError) {
      return (
        <div className="space-y-3">
          <p role="alert" className="rounded-lg border border-warn/40 bg-subtle px-4 py-3 text-sm">
            {err.message}
          </p>
          <Link href={`/cases/${id}/renewal-agent`}>Back to the review</Link>
        </div>
      );
    }
    throw err;
  }
  const c = data.state.case;
  const lang: ExplanationLang = data.approved.find((a) => a.lang === sp.lang)?.lang ?? data.approved[0]!.lang;
  const exp = data.approved.find((a) => a.lang === lang)!;
  const r = data.state.review!;

  return (
    <article className="space-y-6" data-page="renewal-print">
      <div className="flex items-center justify-between print:hidden">
        <Link href={`/cases/${id}/renewal-agent`}>&larr; Back to the review</Link>
        <PrintButton />
      </div>
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Renewal terms change report</h1>
        <p className="text-sm">
          {c.insurer} · {c.reference} · {c.title}
        </p>
        <p className="flex flex-wrap items-center gap-2 text-sm text-muted">
          <ModeBadge mode={r.mode} model={r.modelId} /> review v{r.version} · prompt {r.promptVersion} · {fmtDateTime(r.createdAt)}
        </p>
      </header>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-line text-left">
            <th className="py-2 pr-3">Term</th>
            <th className="py-2 pr-3">Old</th>
            <th className="py-2 pr-3">New</th>
            <th className="py-2 pr-3">Result</th>
            <th className="py-2 pr-3">Pages</th>
            <th className="py-2 pr-3">Decision</th>
            <th className="py-2">Acknowledged</th>
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row, i) => (
            <tr key={i} className="break-inside-avoid border-b border-line align-top">
              <td className="py-2 pr-3">
                {row.field}
                {row.item && row.field !== 'exclusion' ? ` (${row.item})` : ''}
                {row.material ? ' *' : ''}
              </td>
              <td className="py-2 pr-3">{row.oldValue || '-'}</td>
              <td className="py-2 pr-3">{row.newValue || '-'}</td>
              <td className="py-2 pr-3">{row.classification.replace(/_/g, ' ')}</td>
              <td className="py-2 pr-3">
                {row.oldPages || '-'} / {row.newPages || '-'}
              </td>
              <td className="py-2 pr-3">{row.decision}</td>
              <td className="py-2">{row.acknowledgedBy ? `${row.acknowledgedBy} (${row.ackChannel}, ${row.ackRecordedAt.slice(0, 10)})` : '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-xs text-muted">* material term. Page numbers are file pages. Document shows only what is written in the documents; coverage and claim decisions stay with the insurer.</p>
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Approved customer explanation ({lang === 'hi' ? 'Hindi' : 'English'})</h2>
        {data.approved.length > 1 ? (
          <p className="text-sm print:hidden">
            {EXPLANATION_LANGS.map((l) => (
              <Link key={l} href={`/cases/${id}/renewal-agent/print?lang=${l}`} className="mr-3">
                {l === 'hi' ? 'Hindi' : 'English'}
              </Link>
            ))}
          </p>
        ) : null}
        <pre lang={lang} className="whitespace-pre-wrap text-sm leading-relaxed">
          {exp.text}
        </pre>
        <p className="font-mono text-xs text-muted">Text version {exp.version}</p>
      </section>
      <p className="hidden text-xs text-muted print:block">
        Acknowledgement text versions: {[...new Set(data.rows.map((r2) => r2.ackTextVersion).filter(Boolean))].join(', ') || 'none recorded'}
      </p>
    </article>
  );
}
