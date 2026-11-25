/**
 * Deterministic parser for the two documents the disclosure checker compares:
 *
 *   customer-confirmed disclosure (call record / confirmation form)   header: CUSTOMER DISCLOSURE CONFIRMATION
 *   draft proposal                                                      header: DRAFT PROPOSAL
 *
 * Both use the same line grammar (see fixtures/disclosure-checker/README.md):
 *   Insured person: <name>          Date of birth: <date>        Reference: <ref>
 *   Confirmed on: <date> | Proposal date: <date>                 Channel: <call|...>
 *   MEMBER: <name> (<self|spouse|child|parent>)
 *   Q<n> | <question text> | <answer> | <date>
 *
 * The parser never fills, guesses or normalises an answer into a different one. An empty answer is
 * `blank`, which is NOT a `no`.
 */
import type { DocumentRecord } from '@/lib/contracts';

export type DocRole = 'customer' | 'proposal';
export type AnswerKind = 'yes' | 'no' | 'blank' | 'ambiguous';

export interface ParsedRow {
  qid: string;
  question: string;
  /** Verbatim answer text as written (may be empty). */
  answer: string;
  kind: AnswerKind;
  /** Row date if given, else null (callers fall back to the document date). */
  date: string | null;
  page: number;
  /** The full verbatim source line: used as the citation quote. */
  line: string;
}

export interface ParsedMember {
  name: string;
  /** Lowercased, punctuation-stripped, whitespace-collapsed name: the ONLY identity used to match members. */
  nameKey: string;
  relation: string;
  rows: Map<string, ParsedRow[]>;
  page: number;
  line: string;
}

export interface ParsedDoc {
  docId: string;
  sha256: string;
  filename: string;
  role: DocRole;
  insuredName: string | null;
  dob: string | null;
  reference: string | null;
  docDate: string | null;
  channel: string | null;
  members: ParsedMember[];
  duplicateMembers: ParsedMember[];
  unparsed: Array<{ page: number; line: string }>;
}

export const RELATIONS = ['self', 'spouse', 'child', 'parent'] as const;

export const normName = (s: string) =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Classify the answer text. Order matters: unmarked "Yes / No" templates must stay ambiguous. */
export function classifyAnswer(raw: string): AnswerKind {
  const t = raw.trim();
  if (t === '' || /^[_.\s]*$/.test(t)) return 'blank';
  if (/^(yes|y)\s*[/|]\s*(no|n)\b/i.test(t) || /^\[/.test(t)) return 'ambiguous'; // unmarked template / checkbox
  if (/^(no|nil|none|n)[.!]?$/i.test(t)) return 'no';
  if (/^(yes|y)\b/i.test(t)) return 'yes';
  return 'ambiguous';
}

const HEADER_RE = /^([A-Za-z][A-Za-z /]*?)\s*:\s*(.*)$/;
const ROW_RE = /^(Q\d+)\s*\|([^|]*)\|([^|]*)(?:\|([^|]*))?$/i;
const MEMBER_RE = /^MEMBER\s*:\s*(.+?)\s*\(\s*([A-Za-z ]+?)\s*\)\s*$/i;

/** Role from the document's own header first, then from its upload kind. null = not a comparison document. */
export function detectRole(doc: Pick<DocumentRecord, 'kind' | 'pages'>): { role: DocRole | null; conflict: boolean } {
  const head = (doc.pages[0]?.text ?? '').slice(0, 800);
  const byHeader: DocRole | null = /CUSTOMER DISCLOSURE CONFIRMATION/i.test(head)
    ? 'customer'
    : /DRAFT PROPOSAL/i.test(head)
      ? 'proposal'
      : null;
  const byKind: DocRole | null = doc.kind === 'disclosure' ? 'customer' : doc.kind === 'proposal' ? 'proposal' : null;
  if (byHeader && byKind && byHeader !== byKind) return { role: null, conflict: true };
  return { role: byHeader ?? byKind, conflict: false };
}

export function parseDoc(doc: Pick<DocumentRecord, 'id' | 'sha256' | 'filename' | 'pages'>, role: DocRole): ParsedDoc {
  const out: ParsedDoc = {
    docId: doc.id,
    sha256: doc.sha256,
    filename: doc.filename,
    role,
    insuredName: null,
    dob: null,
    reference: null,
    docDate: null,
    channel: null,
    members: [],
    duplicateMembers: [],
    unparsed: [],
  };
  let current: ParsedMember | null = null;
  for (const page of doc.pages) {
    if (page.ocr_status === 'failed') continue;
    for (const rawLine of page.text.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      const m = MEMBER_RE.exec(line);
      if (m) {
        const member: ParsedMember = {
          name: m[1]!.trim(),
          nameKey: normName(m[1]!),
          relation: m[2]!.trim().toLowerCase(),
          rows: new Map(),
          page: page.page,
          line,
        };
        if (out.members.some((x) => x.nameKey === member.nameKey)) out.duplicateMembers.push(member);
        else out.members.push(member);
        current = member;
        continue;
      }
      const r = ROW_RE.exec(line);
      if (r) {
        if (!current) {
          out.unparsed.push({ page: page.page, line });
          continue;
        }
        const answer = r[3]!.trim();
        const row: ParsedRow = {
          qid: r[1]!.toUpperCase(),
          question: r[2]!.trim(),
          answer,
          kind: classifyAnswer(answer),
          date: r[4]?.trim() ? r[4].trim().slice(0, 40) : null,
          page: page.page,
          line,
        };
        const list = current.rows.get(row.qid) ?? [];
        list.push(row);
        current.rows.set(row.qid, list);
        continue;
      }
      if (/^Q\s*\d+\b/i.test(line)) {
        out.unparsed.push({ page: page.page, line });
        continue;
      }
      const h = HEADER_RE.exec(line);
      if (!h) continue;
      const key = h[1]!.trim().toLowerCase();
      const val = h[2]!.trim();
      if (key === 'insured person' && out.insuredName === null) out.insuredName = val;
      else if (key === 'date of birth' && out.dob === null) out.dob = val;
      else if ((key === 'reference' || key === 'proposal reference') && out.reference === null) out.reference = val;
      else if ((key === 'confirmed on' || key === 'proposal date') && out.docDate === null) out.docDate = val;
      else if (key === 'channel' && out.channel === null) out.channel = val;
    }
  }
  return out;
}
