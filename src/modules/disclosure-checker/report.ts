/** Disclosure reconciliation report: CSV and printable text. Pure functions, no I/O. */
import type { WorkspaceState } from './resolve';

export const RECORD_NOTICE = 'Advisor record of a disclosure reconciliation. Not an underwriting decision and not a proposal submission.';
export const STATEMENT = 'The advisor and customer decide the answers; this tool never completes medical answers.';

export interface ReportMeta {
  reference: string;
  insurer: string;
  title: string;
  generatedAt: Date;
  generatedBy: string;
}

/** Quote every field, double embedded quotes, and defuse spreadsheet formulas. */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

const attr = (f: WorkspaceState['findings'][number], k: string): string => {
  const v = (f.attributes ?? {})[k];
  return v === null || v === undefined ? '' : String(v);
};
const quoteFor = (f: WorkspaceState['findings'][number], docId: string) => f.evidence.find((e) => e.doc_id === docId);

const resolutionText = (f: WorkspaceState['findings'][number]) =>
  f.escalated ? 'escalated to supervisor' : f.decision ? { accept: 'customer confirmed / accepted', override: 'resolved: no action needed', dismiss: 'resolved: false match' }[f.decision.decision] : 'open';

const COLUMNS = [
  'record_notice', 'mode', 'model', 'review_version', 'finding_key', 'member', 'relation', 'question_id', 'question', 'classification', 'type', 'status',
  'customer_answer', 'customer_answer_date', 'customer_page', 'customer_quote', 'proposal_answer', 'proposal_date', 'proposal_page', 'proposal_quote',
  'resolution', 'resolution_note', 'resolved_by', 'resolved_at', 'customer_confirmed_by', 'customer_confirmed_channel', 'customer_confirmed_at', 'customer_confirmed_value', 'proposal_change', 'history_entries', 'supervisor_approval',
] as const;

export function buildCsv(state: WorkspaceState, _meta: ReportMeta): string {
  const rev = state.review;
  const approval = state.approval?.valid ? `approved by ${state.approval.by} at ${state.approval.at.toISOString()}` : 'not approved';
  const rows = state.findings.map((f) => {
    const c = quoteFor(f, attr(f, 'customer_doc_id'));
    const p = quoteFor(f, attr(f, 'proposal_doc_id'));
    const cc = f.confirmation;
    const cells: Record<(typeof COLUMNS)[number], unknown> = {
      record_notice: RECORD_NOTICE,
      mode: rev?.mode === 'live' ? 'live' : 'synthetic',
      model: rev?.modelId ?? '',
      review_version: rev?.version ?? '',
      finding_key: f.key,
      member: attr(f, 'member'),
      relation: attr(f, 'relation'),
      question_id: attr(f, 'question_id'),
      question: attr(f, 'question'),
      classification: f.classification,
      type: f.type,
      status: f.status,
      customer_answer: attr(f, 'customer_answer'),
      customer_answer_date: attr(f, 'customer_date'),
      customer_page: c?.page ?? '',
      customer_quote: c?.quote ?? '',
      proposal_answer: attr(f, 'proposal_answer'),
      proposal_date: attr(f, 'proposal_date'),
      proposal_page: p?.page ?? '',
      proposal_quote: p?.quote ?? '',
      resolution: resolutionText(f),
      resolution_note: f.decision?.note ?? '',
      resolved_by: f.decidedByName ?? '',
      resolved_at: f.decision?.at ?? '',
      customer_confirmed_by: cc?.by ?? '',
      customer_confirmed_channel: cc?.channel ?? '',
      customer_confirmed_at: cc?.confirmedAt ?? '',
      customer_confirmed_value: cc?.value ?? '',
      proposal_change: cc?.proposalChange ?? '',
      history_entries: f.corrections.length,
      supervisor_approval: approval,
    };
    return COLUMNS.map((k) => csvCell(cells[k])).join(',');
  });
  return [COLUMNS.map((c) => csvCell(c)).join(','), ...rows].join('\r\n') + '\r\n';
}

export function buildText(state: WorkspaceState, meta: ReportMeta): string {
  const rev = state.review;
  const L: string[] = [];
  L.push('DISCLOSURE RECONCILIATION REPORT');
  L.push(RECORD_NOTICE);
  L.push(STATEMENT);
  L.push('='.repeat(72));
  L.push(`Case: ${meta.reference} (${meta.insurer})`);
  L.push(`Title: ${meta.title}`);
  if (rev) {
    L.push(`Review: v${rev.version} | mode: ${rev.mode === 'live' ? `Live (${rev.modelId})` : 'Synthetic'} | prompt ${rev.promptVersion}`);
    L.push(`Reviewed documents (SHA-256): ${state.docs.map((d) => `${d.filename} ${d.sha256.slice(0, 12)}`).join('; ')}`);
  } else L.push('No comparison has been run.');
  L.push(`Generated: ${meta.generatedAt.toISOString()} by ${meta.generatedBy}`);
  L.push(
    state.approval?.valid
      ? `Supervisor approval: approved by ${state.approval.by} at ${state.approval.at.toISOString()}`
      : state.approval
        ? 'Supervisor approval: WITHDRAWN (findings changed after approval)'
        : 'Supervisor approval: NOT APPROVED (draft)',
  );
  const open = state.findings.filter((f) => f.status === 'open').length;
  L.push(`Findings: ${state.findings.length} (${open} open)`);
  L.push('');
  state.findings.forEach((f, i) => {
    L.push(`${i + 1}. [${f.classification.toUpperCase().replace(/_/g, ' ')}] ${attr(f, 'member') || 'Document'} ${attr(f, 'question_id')} ${attr(f, 'question')}`.trim());
    L.push(`   ${f.summary}`);
    for (const [label, key] of [['Customer-confirmed', 'customer_doc_id'], ['Proposal', 'proposal_doc_id']] as const) {
      const e = quoteFor(f, attr(f, key));
      const dateKey = label === 'Proposal' ? 'proposal_date' : 'customer_date';
      L.push(e ? `   ${label} (page ${e.page}, ${attr(f, dateKey) || 'no date'}): "${e.quote}"` : `   ${label}: no entry`);
    }
    L.push(`   Status: ${resolutionText(f)}${f.decision ? ` by ${f.decidedByName} on ${f.decision.at}` : ''}${f.decision?.note ? ` - ${f.decision.note}` : ''}`);
    if (f.confirmation) {
      const c = f.confirmation;
      L.push(`   Customer confirmation: ${c.by} via ${c.channel} on ${c.confirmedAt}: "${c.value}" (${c.proposalChange === 'change_needed' ? 'proposal needs correcting by the advisor and customer' : 'proposal answer stands'})`);
    }
    for (const h of f.corrections) L.push(`   History ${h.at}: ${h.field} changed (${h.reason})`);
    L.push('');
  });
  L.push('-'.repeat(72));
  L.push(RECORD_NOTICE);
  return L.join('\n') + '\n';
}
