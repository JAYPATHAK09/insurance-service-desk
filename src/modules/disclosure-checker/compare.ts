/**
 * Deterministic comparison of a customer-confirmed disclosure against a draft proposal.
 *
 * Safety rules enforced here (and tested):
 *  - members are matched ONLY by exact normalised name; similar names are reported, never merged
 *  - a blank answer is `unanswered`, never `no`; an explicit "No" is kept distinct (`explicit_negative`)
 *  - nothing is inferred: an answer's text is compared as written, a condition is never mapped to another
 *  - if the insured person differs, no answers are compared at all
 */
import type { AnswerKind, ParsedDoc, ParsedMember, ParsedRow } from './parse';
import { normName } from './parse';

export type DisclosureClassification = 'omission' | 'contradiction' | 'unanswered' | 'explicit_negative' | 'ambiguous';

export interface Side {
  docId: string;
  page: number;
  /** Verbatim source line: the citation quote. */
  quote: string;
  answer: string;
  kind: AnswerKind;
  date: string | null;
}

export interface Comparison {
  member: string;
  relation: string;
  qid: string;
  question: string;
  classification: DisclosureClassification;
  type: string;
  summary: string;
  nextAction: string;
  customer: Side | null;
  proposal: Side | null;
  similarMembers: string[];
}

export interface DocLevelIssue {
  type: string;
  /** Stable discriminator inside the key. */
  ref: string;
  summary: string;
  nextAction: string;
  /** Only used when the quote really exists on the page. */
  evidence?: { docId: string; page: number; quote: string };
}

export interface CompareResult {
  comparisons: Comparison[];
  issues: DocLevelIssue[];
  matched: number;
}

export const NEXT_ACTION: Record<DisclosureClassification, string> = {
  contradiction:
    'Ask the customer which answer is correct and record their confirmation. Do not change the proposal answer on the customer\'s behalf.',
  omission: 'Ask the customer whether the confirmed answer belongs in the proposal. The advisor and customer complete it, not this tool.',
  unanswered: 'The proposal field is blank. Ask the customer for the answer; a blank is not a "No".',
  explicit_negative:
    'The proposal states an explicit "No" that the customer record does not confirm. Confirm with the customer that this was their answer.',
  ambiguous: 'The answers cannot be compared safely. Ask the customer to clarify and record what they confirm.',
};

const yearsOf = (s: string) => new Set(s.match(/\b(?:19|20)\d{2}\b/g) ?? []);
const words = (s: string) => new Set(normName(s).split(' ').filter((w) => w.length > 2));
const sameSet = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x));

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 1;
  const inter = [...a].filter((x) => b.has(x)).length;
  return inter / (a.size + b.size - inter);
}

export function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length]![b.length]!;
}

/** Names that look alike (same surname and same initial, or first names within edit distance 2). Warning only. */
export function similarNameKeys(nameKey: string, candidates: string[]): string[] {
  const [first = '', ...rest] = nameKey.split(' ');
  const last = rest.length ? rest[rest.length - 1]! : '';
  return candidates.filter((c) => {
    if (c === nameKey) return false;
    const [cf = '', ...cr] = c.split(' ');
    const cl = cr.length ? cr[cr.length - 1]! : '';
    if (!last || last !== cl) return false;
    return first[0] === cf[0] || levenshtein(first, cf) <= 2;
  });
}

const side = (doc: ParsedDoc, r: ParsedRow | undefined): Side | null =>
  r ? { docId: doc.docId, page: r.page, quote: r.line, answer: r.answer, kind: r.kind, date: r.date ?? doc.docDate } : null;

const qnum = (q: string) => Number(q.replace(/\D/g, ''));

const show = (s: Side | null) => (s ? (s.answer ? `"${s.answer}"` : 'blank') : 'no entry');
const when = (s: Side | null) => (s?.date ? ` (${s.date})` : '');

function classify(c: Side | null, p: Side | null): { classification: DisclosureClassification; type: string } | null {
  const ck: AnswerKind | 'absent' = c?.kind ?? 'absent';
  const pk: AnswerKind | 'absent' = p?.kind ?? 'absent';
  if (pk === 'blank') return { classification: 'unanswered', type: 'proposal_field_blank' };
  if (pk === 'absent') {
    if (ck === 'yes' || ck === 'no') return { classification: 'omission', type: 'missing_from_proposal' };
    if (ck === 'ambiguous') return { classification: 'ambiguous', type: 'customer_answer_unclear' };
    return { classification: 'unanswered', type: 'no_answer_recorded' };
  }
  if (pk === 'ambiguous' || ck === 'ambiguous') return { classification: 'ambiguous', type: 'answer_unclear' };
  if (ck === 'absent' || ck === 'blank') {
    return pk === 'no'
      ? { classification: 'explicit_negative', type: 'negative_not_confirmed_by_customer' }
      : { classification: 'ambiguous', type: 'positive_not_confirmed_by_customer' };
  }
  if (ck !== pk) return { classification: 'contradiction', type: 'yes_no_conflict' };
  if (ck === 'no') return null; // both explicit No: a match
  // Both Yes: compare as written. Differing years are a contradiction; differing wording is left to a human.
  const cy = yearsOf(c!.answer);
  const py = yearsOf(p!.answer);
  if (cy.size && py.size && !sameSet(cy, py)) return { classification: 'contradiction', type: 'detail_date_conflict' };
  if (normName(c!.answer) === normName(p!.answer)) return null;
  return { classification: 'ambiguous', type: 'detail_differs' };
}

function pickRow(rows: ParsedRow[] | undefined): { row?: ParsedRow; conflict: boolean } {
  if (!rows?.length) return { conflict: false };
  const distinct = new Set(rows.map((r) => `${r.kind}|${normName(r.answer)}`));
  return { row: rows[0], conflict: distinct.size > 1 };
}

export function compareDocs(cust: ParsedDoc, prop: ParsedDoc): CompareResult {
  const comparisons: Comparison[] = [];
  const issues: DocLevelIssue[] = [];
  let matched = 0;

  for (const doc of [cust, prop]) {
    for (const u of doc.unparsed) {
      issues.push({
        type: 'unparsed_row',
        ref: `${doc.role}:${u.page}:${normName(u.line).slice(0, 40)}`,
        summary: `A line in the ${doc.role === 'customer' ? 'customer confirmation' : 'proposal'} (page ${u.page}) looks like a question but could not be read as Q | question | answer | date. It was not compared.`,
        nextAction: 'Correct the source line or review it manually. The tool does not guess the answer.',
        evidence: { docId: doc.docId, page: u.page, quote: u.line },
      });
    }
    for (const d of doc.duplicateMembers) {
      issues.push({
        type: 'duplicate_member',
        ref: `${doc.role}:${d.nameKey}`,
        summary: `${d.name} appears more than once in the ${doc.role === 'customer' ? 'customer confirmation' : 'proposal'}. Members are never merged, so this member was not compared.`,
        nextAction: 'Check whether this is the same person listed twice or two people with the same name.',
        evidence: { docId: doc.docId, page: d.page, quote: d.line },
      });
    }
  }
  const dupKeys = new Set([...cust.duplicateMembers, ...prop.duplicateMembers].map((m) => m.nameKey));

  const cKeys = cust.members.map((m) => m.nameKey);
  const pKeys = prop.members.map((m) => m.nameKey);
  const order: Array<{ c?: ParsedMember; p?: ParsedMember }> = [
    ...cust.members.map((c) => ({ c, p: prop.members.find((m) => m.nameKey === c.nameKey) })),
    ...prop.members.filter((p) => !cKeys.includes(p.nameKey)).map((p) => ({ p })),
  ];

  for (const { c, p } of order) {
    const m = (c ?? p)!;
    if (dupKeys.has(m.nameKey)) continue;
    const similar = c && !p ? similarNameKeys(c.nameKey, pKeys) : p && !c ? similarNameKeys(p.nameKey, cKeys) : [];
    const similarNames = similar.map((k) => (c && !p ? prop : cust).members.find((x) => x.nameKey === k)!.name);

    if (c && p && c.relation !== p.relation) {
      comparisons.push({
        member: m.name,
        relation: c.relation,
        qid: 'ALL',
        question: 'Member relationship',
        classification: 'ambiguous',
        type: 'relation_mismatch',
        summary: `${m.name} is listed as "${c.relation}" in the customer confirmation but "${p.relation}" in the proposal. Answers for this member were not compared.`,
        nextAction: NEXT_ACTION.ambiguous,
        customer: { docId: cust.docId, page: c.page, quote: c.line, answer: '', kind: 'blank', date: cust.docDate },
        proposal: { docId: prop.docId, page: p.page, quote: p.line, answer: '', kind: 'blank', date: prop.docDate },
        similarMembers: [],
      });
      continue;
    }

    const qids = [
      ...new Set([...(c ? [...c.rows.keys()] : []), ...(p ? [...p.rows.keys()] : [])]),
    ].sort((a, b) => qnum(a) - qnum(b));
    // Preserve customer order is unnecessary: numeric order is stable and readable.
    for (const qid of qids) {
      const cr = pickRow(c?.rows.get(qid));
      const pr = pickRow(p?.rows.get(qid));
      const cs = side(cust, cr.row);
      const ps = side(prop, pr.row);
      const question = (cr.row ?? pr.row)!.question;
      const relation = m.relation;
      const base = { member: m.name, relation, qid, question, customer: cs, proposal: ps, similarMembers: similarNames };

      let res: { classification: DisclosureClassification; type: string } | null;
      if (cr.conflict || pr.conflict) {
        res = { classification: 'ambiguous', type: 'duplicate_answer_in_document' };
      } else if (cr.row && pr.row && jaccard(words(cr.row.question), words(pr.row.question)) < 0.4) {
        res = { classification: 'ambiguous', type: 'question_text_differs' };
      } else {
        res = classify(cs, ps);
      }
      if (!res) {
        matched++;
        continue;
      }
      const lead = `${m.name} (${relation}), ${qid} "${question}": `;
      const summary =
        lead +
        (res.type === 'duplicate_answer_in_document'
          ? 'the same question is answered differently more than once in one document, so it was not compared.'
          : res.type === 'question_text_differs'
            ? 'the two documents word this question differently, so the answers were not compared.'
            : `customer-confirmed ${show(cs)}${when(cs)}; proposal ${show(ps)}${when(ps)}.`) +
        (similarNames.length ? ` Similar-named member(s) exist in the other document (${similarNames.join(', ')}); they were NOT merged.` : '');
      comparisons.push({ ...base, ...res, summary, nextAction: NEXT_ACTION[res.classification] });
    }
  }
  return { comparisons, issues, matched };
}
