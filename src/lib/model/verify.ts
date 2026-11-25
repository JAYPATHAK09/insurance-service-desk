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

const MIN_QUOTE = 4;

export function quoteAppearsOnPage(
  docs: Pick<DocumentRecord, 'id' | 'pages'>[],
  e: { doc_id: string; page: number; quote: string },
): boolean {
  const q = normaliseForMatch(e.quote);
  if (q.length < MIN_QUOTE) return false;
  const doc = docs.find((d) => d.id === e.doc_id);
  const page = doc?.pages.find((p) => p.page === e.page);
  if (!page || page.ocr_status === 'failed') return false;
  return normaliseForMatch(page.text).includes(q);
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
    if (ok || f.classification === 'ambiguous') return { ...f, evidence };
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
