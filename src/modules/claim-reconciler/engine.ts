/**
 * Deterministic reconciliation core (the synthetic engine). Pure: documents in, draft findings out.
 *
 * Rules that must hold whatever else changes:
 *  - A receipt or prior correspondence can show something was SENT. It can never establish that it
 *    was sufficient, so it can never produce satisfied_pending_verification on its own.
 *  - `satisfied_pending_verification` always means "a human must still verify"; nothing here states
 *    a claim outcome.
 *  - Every quote is a verbatim line from the cited page.
 */
import { createHash } from 'node:crypto';
import type { Finding } from '@/lib/contracts';
import {
  detectRole,
  fmtIso,
  parseDocDate,
  parseQueryLetter,
  parseReceipt,
  parseRegister,
  parseSubject,
  typeLabel,
  typeOwner,
  type DocIn,
  type Offer,
  type Quote,
  type QueryLetter,
  type Receipt,
  type RequestedItem,
} from './parse';

export const TASK_ID = 'claim-reconciler.reconcile';

export interface Reconciliation {
  findings: Finding[];
  letter?: QueryLetter;
}

export interface Unmet {
  qualifier: 'original' | 'signed' | 'itemised' | 'date' | 'pages';
  have: string;
}

const an = (l: string) => (/^[aeiou]/i.test(l) ? 'An ' : 'A ') + l;
const short = (id: string) => createHash('sha256').update(id).digest('hex').slice(0, 12);
export const textHash = (d: DocIn) =>
  createHash('sha256').update(d.pages.map((p) => p.text).join('\f')).digest('hex');

export function findingKey(letterSha: string, itemNo: number): string {
  return `qi-${letterSha.slice(0, 12)}-${itemNo}`;
}

const sameRef = (want: string | undefined, have: string | undefined) => !want || !have || want === have;
const refsDiffer = (want: string | undefined, have: string | undefined) => Boolean(want && have && want !== have);

function quoteList(...qs: Array<Quote | Quote[] | undefined>): Quote[] {
  const seen = new Set<string>();
  const out: Quote[] = [];
  for (const x of qs.flat()) {
    if (!x) continue;
    const k = `${x.docId}|${x.page}|${x.quote}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(x);
    }
  }
  return out;
}

const ev = (qs: Quote[]) => qs.map((x) => ({ doc_id: x.docId, page: x.page, quote: x.quote, verified: false }));

type Class = 'satisfied_pending_verification' | 'partially_satisfied' | 'missing' | 'ambiguous' | 'repeated_request';

interface Outcome {
  classification: Class;
  reason: string;
  summary: string;
  nextAction: string;
  owner: string;
  quotes: Quote[];
  unmet?: Unmet[];
  unknown?: string[];
  submissionRefs?: string[];
  matchedDocIds?: string[];
  receiptOnly?: boolean;
}

function requirementText(r: RequestedItem): string {
  const bits = [r.original ? 'original' : '', r.signed ? 'signed' : '', r.itemised ? 'itemised' : ''].filter(Boolean);
  return `${bits.join(', ') || 'no stated qualifiers'}${r.refNo ? `, no. ${r.refNo}` : ''}${r.dateEq ? `, dated ${fmtIso(r.dateEq)}` : ''}${r.dateFrom ? `, dated on/after ${fmtIso(r.dateFrom)}` : ''}`;
}

/** Latest-dated group of offers (versions). Undated offers join the group only when nothing is dated. */
function latestVersion(offers: Offer[]): { group: Offer[]; superseded: Offer[] } {
  const dated = offers.filter((o) => o.date !== undefined);
  if (!dated.length) return { group: offers, superseded: [] };
  const max = Math.max(...dated.map((o) => o.date!));
  const group = offers.filter((o) => o.date === max || o.date === undefined);
  return { group, superseded: offers.filter((o) => !group.includes(o)) };
}

function merged<T>(vals: Array<T | undefined>): { value: T | undefined; conflict: boolean } {
  const known = [...new Set(vals.filter((v): v is T => v !== undefined))];
  return { value: known.length === 1 ? known[0] : undefined, conflict: known.length > 1 };
}

function evaluate(
  r: RequestedItem,
  offers: Offer[],
  receipts: Receipt[],
  letterDate: number | undefined,
): Outcome {
  const label = typeLabel(r.docType);
  const owner = typeOwner(r.docType);
  const ask = r.quote;
  const ofType = offers.filter((o) => o.type === r.docType);
  const compatible = ofType.filter((o) => sameRef(r.refNo, o.refNo));
  const otherRef = ofType.filter((o) => refsDiffer(r.refNo, o.refNo));
  const substantive = compatible.filter((o) => (o.source === 'register' || o.source === 'document') && o.readable);
  const unreadable = compatible.filter((o) => o.source === 'document' && !o.readable);
  const supportive = compatible.filter((o) => o.source === 'receipt' || o.source === 'correspondence');

  if (!substantive.length) {
    if (unreadable.length) {
      return {
        classification: 'ambiguous',
        reason: 'unreadable_scan',
        summary: `A scan that appears to be the ${label} is on file but could not be read, so nothing can be confirmed from it.`,
        nextAction: 'Request a legible copy or re-scan, then re-run the review.',
        owner: 'Handler (request fresh scan)',
        quotes: quoteList(ask, supportive.flatMap((o) => o.quotes)),
        submissionRefs: [...new Set(supportive.map((o) => o.submissionRef).filter((x): x is string => !!x))],
        matchedDocIds: unreadable.map((o) => o.docId),
      };
    }
    if (supportive.length) {
      const refs = [...new Set(supportive.map((o) => o.submissionRef).filter((x): x is string => !!x))];
      return {
        classification: 'ambiguous',
        reason: 'receipt_only',
        summary: `A submission record mentions the ${label}${refs.length ? ` (ref ${refs.join(', ')})` : ''}, but no copy of the document itself is on file. A receipt shows it was sent, not that it is sufficient.`,
        nextAction: `Submitted, sufficiency unverified: locate the ${label} actually sent and check it against the request (${requirementText(r)}).`,
        owner: 'Handler',
        quotes: quoteList(ask, supportive.flatMap((o) => o.quotes)),
        submissionRefs: refs,
        receiptOnly: true,
      };
    }
    if (otherRef.length) {
      const refs = [...new Set(otherRef.map((o) => o.submissionRef).filter((x): x is string => !!x))];
      return {
        classification: 'ambiguous',
        reason: 'different_reference',
        summary: `The insurer asked for ${label} no. ${r.refNo}, but the case file only holds a ${label} with a different number (${[...new Set(otherRef.map((o) => o.refNo))].join(', ')}). It may be the wrong document.`,
        nextAction: `Confirm with the hospital which ${label} was meant, and send no. ${r.refNo} if it was not sent.`,
        owner: 'Handler',
        quotes: quoteList(ask, otherRef.flatMap((o) => o.quotes)),
        submissionRefs: refs,
        receiptOnly: otherRef.every((o) => o.source === 'receipt' || o.source === 'correspondence'),
      };
    }
    return {
      classification: 'missing',
      reason: 'not_on_file',
      summary: `No ${label} was found among the case documents, register or submission records.`,
      nextAction: `Obtain the ${label} (${requirementText(r)}) and add it to the case before replying.`,
      owner,
      quotes: quoteList(ask),
    };
  }

  const { group, superseded } = latestVersion(substantive);
  const form = merged(group.map((o) => o.form));
  const signed = merged(group.map((o) => o.signed));
  const bill = merged(group.map((o) => o.billForm));
  const date = merged(group.map((o) => o.date));
  const missingPages = [...new Set(group.flatMap((o) => o.pagesMissing ?? []))].sort((a, b) => a - b);
  const docQuotes = quoteList(group.flatMap((o) => o.quotes));
  const matched = [...new Set(group.map((o) => o.docId))];

  // Submission evidence: receipts or register submission references for this item.
  const sentRecords = supportive.filter((o) => sameRef(r.refNo, o.refNo));
  const regRefs = group.map((o) => o.submissionRef).filter((x): x is string => !!x);
  const refs = [...new Set([...sentRecords.map((o) => o.submissionRef), ...regRefs].filter((x): x is string => !!x))];
  const receiptByRef = (ref: string) => receipts.find((rc) => rc.ref === ref);
  // A register that points at a receipt which lists a different bill is a wrong-document receipt.
  const wrongReceipt = regRefs.filter((ref) => {
    const rc = receiptByRef(ref);
    if (!rc) return false;
    const listed = rc.offers.filter((o) => o.type === r.docType);
    return listed.length > 0 && listed.every((o) => refsDiffer(r.refNo ?? group[0]?.refNo, o.refNo));
  });

  if (form.conflict || signed.conflict || bill.conflict || date.conflict) {
    const what = [form.conflict && 'original/copy', signed.conflict && 'signature', bill.conflict && 'bill format', date.conflict && 'date'].filter(Boolean).join(', ');
    return {
      classification: 'ambiguous',
      reason: 'contradictory_sources',
      summary: `The sources disagree about the ${label} (${what}); for example the register and the document itself describe it differently.`,
      nextAction: 'Open the document itself and the register entry, decide which is right, and correct the register.',
      owner: 'Handler',
      quotes: quoteList(ask, group.flatMap((o) => o.quotes)),
      matchedDocIds: matched,
      submissionRefs: refs,
    };
  }

  const unmet: Unmet[] = [];
  const unknown: string[] = [];
  if (r.original) {
    if (form.value === 'copy') unmet.push({ qualifier: 'original', have: 'copy' });
    else if (form.value === undefined) unknown.push('original');
  }
  if (r.signed) {
    if (signed.value === false) unmet.push({ qualifier: 'signed', have: 'unsigned' });
    else if (signed.value === undefined) unknown.push('signed');
  }
  if (r.itemised) {
    if (bill.value === 'consolidated') unmet.push({ qualifier: 'itemised', have: 'consolidated' });
    else if (bill.value === undefined) unknown.push('itemised');
  }
  if (r.dateEq !== undefined || r.dateFrom !== undefined) {
    if (date.value === undefined) unknown.push('date');
    else if ((r.dateEq !== undefined && date.value !== r.dateEq) || (r.dateFrom !== undefined && date.value < r.dateFrom)) {
      unmet.push({ qualifier: 'date', have: fmtIso(date.value) });
    }
  }
  if (missingPages.length) unmet.push({ qualifier: 'pages', have: `page(s) ${missingPages.join(', ')} not on file` });

  const versionNote = superseded.length ? ` An earlier version is also on file and was set aside because a later-dated one exists.` : '';

  if (unmet.length) {
    const parts = unmet.map((u) => (u.qualifier === 'pages' ? u.have : u.qualifier === 'date' ? `dated ${u.have}, not the date requested` : `${u.have} where ${u.qualifier} is required`));
    return {
      classification: 'partially_satisfied',
      reason: 'qualifier_unmet',
      summary: `${an(label)} is on file but does not meet the request: ${parts.join('; ')}.${versionNote}`,
      nextAction: `Ask ${owner.toLowerCase()} for a corrected ${label} (${requirementText(r)}), then resubmit.`,
      owner,
      quotes: quoteList(ask, docQuotes),
      unmet,
      unknown,
      matchedDocIds: matched,
      submissionRefs: refs,
    };
  }
  if (unknown.length) {
    return {
      classification: 'ambiguous',
      reason: 'qualifier_unknown',
      summary: `${an(label)} is on file, but the file does not show whether it is ${unknown.map((u) => (u === 'original' ? 'an original' : u)).join(' / ')} as requested.${versionNote}`,
      nextAction: 'Open the document and confirm the requested qualifiers by eye.',
      owner: 'Handler',
      quotes: quoteList(ask, docQuotes),
      unknown,
      matchedDocIds: matched,
      submissionRefs: refs,
    };
  }
  if (wrongReceipt.length) {
    const rc = receiptByRef(wrongReceipt[0]!)!;
    return {
      classification: 'ambiguous',
      reason: 'receipt_for_different_document',
      summary: `The ${label} on file looks right, but the submission receipt it points to (${wrongReceipt[0]}) lists a different ${label} number. It is unclear that the right document was sent.`,
      nextAction: `Check what was actually sent under ${wrongReceipt[0]} and resubmit the correct ${label} if needed.`,
      owner: 'Handler',
      quotes: quoteList(ask, docQuotes, rc.offers.filter((o) => o.type === r.docType).flatMap((o) => o.quotes)),
      matchedDocIds: matched,
      submissionRefs: wrongReceipt,
      unknown: ['submission_matches_document'],
    };
  }
  if (!refs.length) {
    return {
      classification: 'partially_satisfied',
      reason: 'not_yet_submitted',
      summary: `${an(label)} that matches the request is on file, but no submission receipt or reference shows it was sent to the insurer.${versionNote}`,
      nextAction: `Handler to verify the ${label}, then submit it and record the submission reference.`,
      owner: 'Handler',
      quotes: quoteList(ask, docQuotes),
      matchedDocIds: matched,
    };
  }
  return {
    classification: 'satisfied_pending_verification',
    reason: 'matches_on_file',
    summary: `${an(label)} on file matches the stated qualifiers (${requirementText(r)}) and a submission record exists (${refs.join(', ')}). A handler must still verify it before anything is said to the insurer.${versionNote}`,
    nextAction: 'Handler to verify the document against the insurer request; the insurer decides whether it is sufficient.',
    owner: 'Handler',
    quotes: quoteList(ask, docQuotes, sentRecords.flatMap((o) => o.quotes)),
    matchedDocIds: matched,
    submissionRefs: refs,
  };
}

/** True when the prior letter's request is no stricter than the current one's (a genuine repeat). */
function sameAsk(now: RequestedItem, before: RequestedItem): boolean {
  return (
    now.docType === before.docType &&
    sameRef(now.refNo, before.refNo) &&
    Boolean(now.original) === Boolean(before.original) &&
    Boolean(now.signed) === Boolean(before.signed) &&
    Boolean(now.itemised) === Boolean(before.itemised) &&
    now.dateEq === before.dateEq &&
    now.dateFrom === before.dateFrom
  );
}

/** Query letters oldest first (undated last, ties by file order). The last one is the current query. */
export function orderedLetters(docs: DocIn[]): QueryLetter[] {
  return docs
    .filter((d) => detectRole(d) === 'query_letter')
    .map((d, i) => ({ l: parseQueryLetter(d), i }))
    .sort((a, b) => (a.l.date ?? Infinity) - (b.l.date ?? Infinity) || a.i - b.i)
    .map((x) => x.l);
}

export function reconcile(docs: DocIn[]): Reconciliation {
  const roles = docs.map((d) => ({ d, role: detectRole(d) }));
  const letters = orderedLetters(docs);
  if (!letters.length) return { findings: [] };

  const offers: Offer[] = [];
  const receipts: Receipt[] = [];
  for (const { d, role } of roles) {
    if (role === 'register') offers.push(...parseRegister(d));
    else if (role === 'receipt' || role === 'correspondence') {
      const rc = parseReceipt(d, role);
      receipts.push(rc);
      offers.push(...rc.offers);
    } else if (role === 'subject') {
      const o = parseSubject(d);
      if (o) offers.push(o);
    }
  }

  const latest = letters[letters.length - 1]!;
  const prior = letters.slice(0, -1);
  const sha = (d: DocIn) => d.sha ?? textHash(d);
  const findings: Finding[] = [];

  for (const r of latest.items) {
    let o = evaluate(r, offers, receipts, latest.date);

    // Repeated request: asked before, with the same qualifiers, and already sent before this letter.
    const earlier = prior
      .flatMap((l) => l.items.map((it) => ({ l, it })))
      .find((x) => sameAsk(r, x.it));
    const sentBefore = offers.filter(
      (x) => x.type === r.docType && sameRef(r.refNo, x.refNo) && (x.date === undefined || latest.date === undefined || x.date < latest.date),
    );
    if (
      earlier &&
      sentBefore.length &&
      (o.classification === 'satisfied_pending_verification' || (o.classification === 'ambiguous' && o.reason === 'receipt_only'))
    ) {
      const refs = [...new Set(sentBefore.map((x) => x.submissionRef).filter((x): x is string => !!x))];
      o = {
        classification: 'repeated_request',
        reason: 'asked_and_sent_before',
        summary: `This item was already requested in an earlier query${earlier.l.date ? ` (${fmtIso(earlier.l.date)})` : ''} and a submission was recorded${refs.length ? ` (${refs.join(', ')})` : ''}. Whether what was sent is sufficient is not established here.`,
        nextAction: 'Handler to check the earlier submission and point the insurer to it, rather than resubmitting, unless the insurer says why it was not enough.',
        owner: 'Handler (reply to insurer); supervisor if the insurer keeps repeating',
        quotes: quoteList(r.quote, earlier.it.quote, sentBefore.flatMap((x) => x.quotes)),
        submissionRefs: refs,
        matchedDocIds: [...new Set(sentBefore.map((x) => x.docId))],
        receiptOnly: sentBefore.every((x) => x.source !== 'document' && x.source !== 'register'),
      };
    }

    findings.push({
      key: findingKey(sha(latest.doc), r.n),
      type: 'requested_item',
      classification: o.classification,
      summary: o.summary,
      evidence: ev(o.quotes),
      suggestedOwner: o.owner,
      nextAction: o.nextAction,
      attributes: {
        item_no: r.n,
        item_type: r.docType,
        item_text: r.text,
        requested: { original: !!r.original, signed: !!r.signed, itemised: !!r.itemised, ref_no: r.refNo ?? null, date: fmtIso(r.dateEq ?? r.dateFrom) || null },
        reason: o.reason,
        unmet: o.unmet ?? [],
        unknown: o.unknown ?? [],
        submission_refs: o.submissionRefs ?? [],
        matched_doc_ids: o.matchedDocIds ?? [],
        receipt_only: o.receiptOnly ?? false,
        query_doc_id: latest.doc.id,
        query_doc_sha: sha(latest.doc).slice(0, 12),
        query_ref: latest.queryRef ?? null,
        query_date: fmtIso(latest.date) || null,
      },
    });
  }
  return { findings, letter: latest };
}

/**
 * Last line of defence, applied to synthetic AND live output: a finding that claims satisfaction
 * without evidence from a substantive document or register entry (i.e. only a receipt, or nothing)
 * is downgraded to ambiguous. `substantiveDocIds` are docs whose role is subject or register.
 */
export function enforceReceiptRule(findings: Finding[], substantiveDocIds: ReadonlySet<string>): Finding[] {
  return findings.map((f) => {
    if (f.classification !== 'satisfied_pending_verification') return f;
    if (f.evidence.some((e) => substantiveDocIds.has(e.doc_id))) return f;
    return {
      ...f,
      classification: 'ambiguous',
      summary: `${f.summary} (Downgraded: only a receipt or no document supports this, so sufficiency is unverified.)`.slice(0, 1900),
      attributes: { ...f.attributes, downgradedFrom: f.classification, downgradeReason: 'receipt_alone', receipt_only: true },
    };
  });
}

export function substantiveDocIds(docs: DocIn[]): Set<string> {
  return new Set(docs.filter((d) => ['register', 'subject'].includes(detectRole(d))).map((d) => d.id));
}

export { parseDocDate, short as _short };
