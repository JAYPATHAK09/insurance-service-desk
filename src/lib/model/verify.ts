import { ABSENCE_CLASSIFICATIONS, type DocumentRecord, type Evidence, type Finding } from '../contracts';

export function normaliseForMatch(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A quote shorter than this cannot be cited at all (it would match almost anywhere). */
const MIN_QUOTE = 4;
/**
 * Each finding with evidence needs at least one quote of this many normalised characters (or the whole
 * cited page, when the page is shorter). Short supporting lines ("Date: 05-Mar-2025") are still
 * accepted next to it, because the rule engines cite whole lines, but they cannot carry a finding alone.
 */
export const MIN_SUBSTANTIAL_QUOTE = 20;

/**
 * For TRUSTED rule-engine output only (never model output): widen a short whole-line quote with the
 * lines that follow it (or precede it, at the end of a page) until it reaches the substantial length.
 * The result is still a contiguous stretch of the cited page, so it verifies like any other quote.
 */
export function widenShortQuotes<E extends { doc_id: string; page: number; quote: string }>(
  evidence: E[],
  docs: Pick<DocumentRecord, 'id' | 'pages'>[],
): E[] {
  return evidence.map((e) => {
    if (normaliseForMatch(e.quote).length >= MIN_SUBSTANTIAL_QUOTE) return e;
    const page = docs.find((d) => d.id === e.doc_id)?.pages.find((p) => p.page === e.page);
    if (!page || page.ocr_status === 'failed') return e;
    const lines = page.text.split('\n').map((l) => l.trim()).filter(Boolean);
    const at = lines.findIndex((l) => normaliseForMatch(l) === normaliseForMatch(e.quote));
    if (at < 0) return e;
    let lo = at;
    let hi = at;
    const len = () => normaliseForMatch(lines.slice(lo, hi + 1).join(' ')).length;
    while (len() < MIN_SUBSTANTIAL_QUOTE && (hi < lines.length - 1 || lo > 0)) {
      if (hi < lines.length - 1) hi++;
      else lo--;
    }
    return { ...e, quote: lines.slice(lo, hi + 1).join('\n') };
  });
}

function citedPageText(docs: Pick<DocumentRecord, 'id' | 'pages'>[], e: { doc_id: string; page: number }): string | null {
  const page = docs.find((d) => d.id === e.doc_id)?.pages.find((p) => p.page === e.page);
  return !page || page.ocr_status === 'failed' ? null : normaliseForMatch(page.text);
}

export function quoteAppearsOnPage(
  docs: Pick<DocumentRecord, 'id' | 'pages'>[],
  e: { doc_id: string; page: number; quote: string },
): boolean {
  const q = normaliseForMatch(e.quote);
  if (q.length < MIN_QUOTE) return false;
  const text = citedPageText(docs, e);
  return text !== null && text.includes(q);
}

/** True when the quote is long enough to stand as evidence on its own (see MIN_SUBSTANTIAL_QUOTE). */
export function quoteIsSubstantial(docs: Pick<DocumentRecord, 'id' | 'pages'>[], e: { doc_id: string; page: number; quote: string }): boolean {
  const text = citedPageText(docs, e);
  return text !== null && normaliseForMatch(e.quote).length >= Math.min(MIN_SUBSTANTIAL_QUOTE, text.length);
}

const REF_PATTERN = /\b[A-Za-z]{2,}[-\/]?\d{3,}[\w\/-]*|\b\d{2,}[-\/][\w\/-]*\d/;

/** Strings a `satisfied_pending_verification` quote may legitimately contain: item text or a document reference. */
function anchorStrings(f: Finding): string[] {
  const a = f.attributes ?? {};
  const out: unknown[] = [a.item_text, a.query_ref, ...(Array.isArray(a.submission_refs) ? a.submission_refs : [])];
  const req = a.requested as { ref_no?: unknown } | undefined;
  if (req && typeof req === 'object') out.push(req.ref_no);
  return out.filter((x): x is string => typeof x === 'string' && x.trim().length >= 3).map((x) => normaliseForMatch(x).toLowerCase());
}

/** A positive claim must cite text tied to the item (its wording or a document reference), not any line on the page. */
function quoteTiedToItem(f: Finding, evidence: Evidence[]): boolean {
  const anchors = anchorStrings(f);
  return evidence.some((e) => {
    if (!e.verified) return false;
    const q = normaliseForMatch(e.quote).toLowerCase();
    return REF_PATTERN.test(q) || anchors.some((s) => q.includes(s) || (q.length >= 12 && s.includes(q)));
  });
}

/**
 * Check every cited quote really appears (whitespace/quote-normalised) on the cited page and set
 * evidence.verified. A finding with any unverifiable citation, or no evidence where evidence is
 * expected, is downgraded to `ambiguous` and keeps its original classification in attributes.
 * Absence-type classifications (missing, unanswered, ...) may legitimately have no evidence.
 */
export function verifyCitations(
  findings: Finding[],
  docs: Pick<DocumentRecord, 'id' | 'pages'>[],
  opts: { absenceClassifications?: readonly string[] } = {},
): Finding[] {
  const absence = opts.absenceClassifications ?? ABSENCE_CLASSIFICATIONS;
  return findings.map((f) => {
    const evidence: Evidence[] = f.evidence.map((e) => ({ ...e, verified: quoteAppearsOnPage(docs, e) }));
    const allVerified = evidence.every((e) => e.verified);
    const needsEvidence = !absence.includes(f.classification);
    const ok = allVerified && (evidence.length > 0 || !needsEvidence);
    if (f.classification === 'ambiguous') return { ...f, evidence };
    // Positive claims only: absence findings cite context ("Page 2 of 6") that is legitimately short.
    if (ok && needsEvidence && evidence.length > 0 && !f.evidence.some((e) => quoteIsSubstantial(docs, e))) {
      return {
        ...f,
        evidence,
        classification: 'ambiguous',
        attributes: { ...f.attributes, downgradedFrom: f.classification, downgradeReason: 'quote_too_short' },
      };
    }
    if (ok && f.classification === 'satisfied_pending_verification' && !quoteTiedToItem(f, evidence)) {
      return {
        ...f,
        evidence,
        classification: 'ambiguous',
        attributes: { ...f.attributes, downgradedFrom: f.classification, downgradeReason: 'quote_not_tied_to_item' },
      };
    }
    if (ok) return { ...f, evidence };
    return {
      ...f,
      evidence,
      classification: 'ambiguous',
      attributes: {
        ...f.attributes,
        downgradedFrom: f.classification,
        downgradeReason: evidence.length === 0 ? 'no_evidence' : 'citation_unverified',
      },
    };
  });
}
