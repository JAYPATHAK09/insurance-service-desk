import { fmtIso, detectRole, parseDocDate, parseQueryLetter, parseReceipt, parseRegister, parseSubject, typeLabel, type DocIn } from './parse';

export interface ChronoDoc extends DocIn {
  filename: string;
  sha256: string;
  createdAt: Date;
}

export interface ChronoRow {
  /** ISO date (YYYY-MM-DD) used for ordering. */
  date: string;
  dateBasis: 'stated in document' | 'upload date';
  event: 'Insurer query' | 'Submission receipt' | 'Correspondence' | 'Document register' | 'Document on file';
  description: string;
  submissionRef: string;
  document: string;
  sha256: string;
}

const list = (xs: string[]) => (xs.length ? xs.join('; ') : 'no recognised items');

/** Chronology of the case file in date order: query letters, receipts, correspondence, register, documents. */
export function buildChronology(docs: ChronoDoc[]): ChronoRow[] {
  const rows: Array<ChronoRow & { sort: number; seq: number }> = [];
  docs.forEach((d, seq) => {
    const role = detectRole(d);
    let stated: number | undefined;
    let event: ChronoRow['event'];
    let description: string;
    let ref = '';
    if (role === 'query_letter') {
      const l = parseQueryLetter(d);
      stated = l.date;
      event = 'Insurer query';
      description = `${l.queryRef ? `Query ${l.queryRef}: ` : ''}${l.items.length} item(s) requested: ${list(l.items.map((i) => `${i.n}. ${typeLabel(i.docType)}${i.refNo ? ` ${i.refNo}` : ''}`))}`;
    } else if (role === 'receipt' || role === 'correspondence') {
      const r = parseReceipt(d, role);
      stated = r.date;
      ref = r.ref ?? '';
      event = role === 'receipt' ? 'Submission receipt' : 'Correspondence';
      description = `${role === 'receipt' ? 'Receipt (confirms sending only, not sufficiency)' : 'Correspondence'}; items: ${list(r.offers.map((o) => `${typeLabel(o.type)}${o.refNo ? ` ${o.refNo}` : ''}`))}`;
    } else if (role === 'register') {
      event = 'Document register';
      const o = parseRegister(d);
      description = `Register of ${o.length} document(s): ${list(o.map((x) => typeLabel(x.type)))}`;
      ref = [...new Set(o.map((x) => x.submissionRef).filter((x): x is string => !!x))].join(' ');
    } else {
      event = 'Document on file';
      const o = parseSubject(d);
      stated = o?.date ?? parseDocDate(d);
      description = o ? `${typeLabel(o.type)}${o.refNo ? ` ${o.refNo}` : ''}${o.readable ? '' : ' (unreadable scan)'}` : 'Document (type not recognised)';
    }
    const ms = stated ?? Date.UTC(d.createdAt.getUTCFullYear(), d.createdAt.getUTCMonth(), d.createdAt.getUTCDate());
    rows.push({
      sort: ms,
      seq,
      date: fmtIso(ms),
      dateBasis: stated !== undefined ? 'stated in document' : 'upload date',
      event,
      description,
      submissionRef: ref,
      document: d.filename,
      sha256: d.sha256.slice(0, 12),
    });
  });
  return rows.sort((a, b) => a.sort - b.sort || a.seq - b.seq).map(({ sort: _s, seq: _q, ...r }) => r);
}

/** Spreadsheet formula injection guard: a leading = + - @ tab or CR becomes text. */
const cell = (v: string) => {
  const s = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function chronologyCsv(rows: ChronoRow[]): string {
  const head = ['date', 'date_basis', 'event', 'description', 'submission_ref', 'document', 'sha256_12'];
  return [head.join(','), ...rows.map((r) => [r.date, r.dateBasis, r.event, r.description, r.submissionRef, r.document, r.sha256].map(cell).join(','))].join('\r\n') + '\r\n';
}

export function chronologyText(rows: ChronoRow[], head: { reference: string; insurer: string }): string {
  const lines = [
    `CLAIM CHRONOLOGY - ${head.reference} - ${head.insurer}`,
    'Built from the case documents, receipts and query letters. A receipt shows something was sent, not that it was sufficient.',
    '',
  ];
  for (const r of rows) {
    lines.push(`${r.date}  ${r.event}${r.submissionRef ? `  [${r.submissionRef}]` : ''}`);
    lines.push(`    ${r.description}`);
    lines.push(`    Source: ${r.document} (sha256 ${r.sha256}; date ${r.dateBasis})`);
  }
  if (!rows.length) lines.push('No documents on file.');
  return lines.join('\n') + '\n';
}
