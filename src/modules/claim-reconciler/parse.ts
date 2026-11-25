/**
 * Deterministic text parsing for the Claim Query Reconciler. Pure functions, no I/O.
 * Every quote returned is a whole trimmed line (or CSV row) copied from a page, so it can be
 * verified verbatim against that page.
 */

export interface PageIn {
  page: number;
  text: string;
  ocr_status?: string;
}
export interface DocIn {
  id: string;
  name: string;
  /** Broker-assigned kind (query_letter, document_register, ...). May be absent or 'other'. */
  kind?: string;
  sha?: string;
  pages: PageIn[];
}

export type DocRole = 'query_letter' | 'register' | 'receipt' | 'correspondence' | 'subject';

export interface Quote {
  docId: string;
  page: number;
  quote: string;
}

// ---------- document types ----------

export interface DocTypeDef {
  type: string;
  label: string;
  re: RegExp;
  owner: string;
}

/** Order matters: more specific patterns first. */
export const DOC_TYPES: DocTypeDef[] = [
  { type: 'pharmacy_bill', label: 'pharmacy bill', re: /pharmacy|medicine\s+(bill|invoice)|chemist/i, owner: 'Hospital pharmacy via handler' },
  { type: 'discharge_summary', label: 'discharge summary', re: /discharge\s+(summary|card|report)/i, owner: 'Treating hospital records desk' },
  { type: 'preauth_form', label: 'pre-authorisation form', re: /pre-?\s?auth(ori[sz]ation)?/i, owner: 'Network hospital desk' },
  { type: 'claim_form', label: 'claim form', re: /claim\s+form/i, owner: 'Insured (policyholder)' },
  { type: 'hospital_bill', label: 'hospital bill', re: /\b(hospital|final|interim|itemi[sz]ed|consolidated)?\s*(bills?|invoices?)\b/i, owner: 'Hospital billing desk' },
  { type: 'investigation_report', label: 'investigation report', re: /investigation|diagnostic|lab(oratory)?\s+report|pathology|radiology|x-?ray|\bmri\b|ct\s+scan/i, owner: 'Hospital diagnostics desk' },
  { type: 'prescription', label: 'prescription', re: /prescription/i, owner: 'Treating doctor' },
  { type: 'kyc', label: 'ID proof (KYC)', re: /\bkyc\b|identity\s+(proof|card)|\bid\s+proof|aadhaar|pan\s+card/i, owner: 'Insured (policyholder)' },
  { type: 'policy_copy', label: 'policy copy', re: /policy\s+(copy|schedule|document)/i, owner: 'Handler (policy file)' },
  { type: 'cancelled_cheque', label: 'cancelled cheque', re: /cancel+ed\s+cheque/i, owner: 'Insured (policyholder)' },
  { type: 'doctor_certificate', label: "doctor's certificate", re: /doctor'?s?\s+(certificate|note)|medical\s+certificate/i, owner: 'Treating doctor' },
];

export const typeLabel = (t: string) => DOC_TYPES.find((d) => d.type === t)?.label ?? t.replace(/_/g, ' ');
export const typeOwner = (t: string) => DOC_TYPES.find((d) => d.type === t)?.owner ?? 'Handler';

export function detectType(s: string): string | null {
  for (const d of DOC_TYPES) if (d.re.test(s)) return d.type;
  return null;
}

// ---------- dates ----------

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Parses DD-Mon-YYYY, DD Month YYYY, DD/MM/YYYY (India) and YYYY-MM-DD to UTC midnight ms. Else undefined. */
export function parseDate(s: string): number | undefined {
  let m = /\b(\d{1,2})[-\s/]([A-Za-z]{3,9})[-\s/,]+(\d{4})\b/.exec(s);
  if (m) {
    const mi = MONTHS.indexOf(m[2]!.slice(0, 3).toLowerCase());
    if (mi >= 0) return Date.UTC(Number(m[3]), mi, Number(m[1]));
  }
  m = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(s);
  if (m) return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  m = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/.exec(s);
  if (m) return Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  return undefined;
}

export const fmtIso = (ms: number | undefined) => (ms === undefined ? '' : new Date(ms).toISOString().slice(0, 10));

// ---------- helpers ----------

const LINE_REF = /\b([A-Z]{2,5}-\d{3,}[A-Z0-9-]*)\b/g;
const IGNORED_REF = /^(SUB|CLM|QRY|REC|REF|Q)-/;

/** First reference-number-like token (e.g. HB-5541) that is not a submission/claim/query reference. */
export function findRefNo(s: string): string | undefined {
  for (const m of s.matchAll(LINE_REF)) if (!IGNORED_REF.test(m[1]!)) return m[1]!;
  return undefined;
}

export function findSubmissionRef(s: string): string | undefined {
  return /\b(SUB-[A-Z0-9]+)\b/.exec(s)?.[1];
}

interface Line {
  page: number;
  text: string; // trimmed
}

function linesOf(doc: DocIn): Line[] {
  const out: Line[] = [];
  for (const p of doc.pages) {
    if (p.ocr_status === 'failed') continue;
    for (const raw of p.text.split('\n')) {
      const t = raw.trim();
      if (t) out.push({ page: p.page, text: t });
    }
  }
  return out;
}

const q = (doc: DocIn, l: Line): Quote => ({ docId: doc.id, page: l.page, quote: l.text });

// ---------- role detection ----------

export function detectRole(doc: DocIn): DocRole {
  const k = doc.kind ?? 'other';
  if (k === 'query_letter') return 'query_letter';
  if (k === 'document_register') return 'register';
  if (k === 'receipt' || k === 'submission') return 'receipt';
  if (k === 'correspondence') return 'correspondence';
  const head = linesOf(doc).slice(0, 4).map((l) => l.text).join(' | ');
  const name = doc.name;
  if (/query\s+letter|claim\s+query|deficiency\s+letter/i.test(head) || /query[-_ ]letter/i.test(name)) return 'query_letter';
  if (/document\s+register/i.test(head) || /register/i.test(name)) return 'register';
  if (/submission\s+receipt|acknowledg(e)?ment\s+receipt/i.test(head) || /receipt/i.test(name)) return 'receipt';
  if (/^(email|correspondence|reply|our\s+reply)/i.test(head) || /correspondence/i.test(name)) return 'correspondence';
  return 'subject';
}

// ---------- query letters ----------

export interface RequestedItem {
  n: number;
  /** Request text as written (joined wrapped lines). */
  text: string;
  quote: Quote; // first line of the item
  docType: string;
  original?: boolean;
  signed?: boolean;
  itemised?: boolean;
  dateEq?: number;
  dateFrom?: number;
  refNo?: string;
}

export interface QueryLetter {
  doc: DocIn;
  date?: number;
  queryRef?: string;
  items: RequestedItem[];
}

const NUMBERED = /^(\d{1,2})[.)]\s+(.*)$/;
const BULLET = /^[-*•]\s+(.*)$/;
const REQUEST_VERB = /\b(please\s+)?(provide|submit|furnish|send|share|forward|attach)\b/i;

export function parseRequestQualifiers(text: string): Pick<RequestedItem, 'original' | 'signed' | 'itemised' | 'dateEq' | 'dateFrom' | 'refNo'> {
  const out: Pick<RequestedItem, 'original' | 'signed' | 'itemised' | 'dateEq' | 'dateFrom' | 'refNo'> = {};
  if (/\boriginals?\b/i.test(text)) out.original = true;
  if (/(?<!un)\bsigned\b|\bsignature\b|\bsealed\b/i.test(text)) out.signed = true;
  if (/\bitemi[sz]ed\b|\bbreak-?up\b|line[- ]item/i.test(text)) out.itemised = true;
  const d = /\bdated\s+(on\s+or\s+after\s+|after\s+|from\s+)?(.{6,24}?)(?=[,.;)]|\s+(?:and|or)\b|$)/i.exec(text);
  if (d) {
    const when = parseDate(d[2]!);
    if (when !== undefined) {
      if (d[1]) out.dateFrom = when;
      else out.dateEq = when;
    }
  }
  const ref = findRefNo(text);
  if (ref) out.refNo = ref;
  return out;
}

export function parseQueryLetter(doc: DocIn): QueryLetter {
  const lines = linesOf(doc);
  let date: number | undefined;
  let queryRef: string | undefined;
  for (const l of lines) {
    const dm = /^(?:date|dated)\s*[:\-]\s*(.+)$/i.exec(l.text);
    if (dm && date === undefined) date = parseDate(dm[1]!);
    const qm = /^query\s*(?:ref(?:erence)?|no\.?|number)\s*[:\-]\s*(.+)$/i.exec(l.text);
    if (qm && !queryRef) queryRef = qm[1]!.trim().slice(0, 60);
  }

  const items: RequestedItem[] = [];
  let n = 0;
  let cur: { first: Line; text: string; num?: number } | null = null;
  const flush = () => {
    if (!cur) return;
    const docType = detectType(cur.text);
    if (docType) {
      n = cur.num ?? n + 1;
      items.push({ n, text: cur.text.slice(0, 400), quote: q(doc, cur.first), docType, ...parseRequestQualifiers(cur.text) });
    }
    cur = null;
  };
  for (const l of lines) {
    const num = NUMBERED.exec(l.text);
    const bul = BULLET.exec(l.text);
    if (num || bul) {
      flush();
      cur = { first: l, text: (num ? num[2]! : bul![1]!), num: num ? Number(num[1]) : undefined };
    } else if (cur && /^[a-z(]/.test(l.text) && !/^(reply|regards|thanks|dear|yours)/i.test(l.text) && l.page === cur.first.page) {
      cur.text += ' ' + l.text; // wrapped continuation (lowercase start)
    } else {
      flush();
      // Free-text request sentence: needs a request verb AND a known document type.
      if (REQUEST_VERB.test(l.text) && detectType(l.text)) {
        cur = { first: l, text: l.text };
        flush();
      }
    }
  }
  flush();
  // Number any items that came from sentences/bullets without their own number, keeping order unique.
  const seen = new Set<number>();
  let next = 1;
  for (const it of items) {
    if (seen.has(it.n)) {
      while (seen.has(next)) next++;
      it.n = next;
    }
    seen.add(it.n);
  }
  return { doc, date, queryRef, items };
}

// ---------- offers (what the case file holds) ----------

export type OfferSource = 'register' | 'document' | 'receipt' | 'correspondence';

export interface Offer {
  source: OfferSource;
  docId: string;
  type: string;
  refNo?: string;
  form?: 'original' | 'copy';
  signed?: boolean;
  billForm?: 'itemised' | 'consolidated';
  date?: number;
  submissionRef?: string;
  pagesTotal?: number;
  pagesMissing?: number[];
  readable: boolean;
  /** Lines that support what this offer says. First entry is the best anchor. */
  quotes: Quote[];
}

function formOf(s: string): 'original' | 'copy' | undefined {
  if (/\boriginal\b/i.test(s)) return 'original';
  if (/\b(photo-?copy|xerox|copy)\b/i.test(s)) return 'copy';
  return undefined;
}
function signedOf(s: string): boolean | undefined {
  if (/\bunsigned\b|not\s+signed|no\s+signature|signature\s+(missing|absent|pending)|\bblank\b|\bnil\b|_{3,}/i.test(s)) return false;
  if (/\bsigned\b|\bsealed\b|\bsignature\b/i.test(s)) return true;
  return undefined;
}
function billOf(s: string): 'itemised' | 'consolidated' | undefined {
  if (/\bitemi[sz]ed\b/i.test(s)) return 'itemised';
  if (/\bconsolidated\b|lump[- ]?sum|summary\s+bill/i.test(s)) return 'consolidated';
  return undefined;
}

/** Minimal RFC 4180 style CSV line splitter. */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') inQ = false;
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') {
      out.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  out.push(cur.trim());
  return out;
}

export function parseRegister(doc: DocIn): Offer[] {
  const lines = linesOf(doc);
  const out: Offer[] = [];
  const header = lines.find((l) => l.text.includes(',') && /\b(item|document)\b/i.test(splitCsvLine(l.text)[0] ?? ''));
  if (header) {
    const cols = splitCsvLine(header.text).map((c) => c.toLowerCase().replace(/[^a-z]/g, ''));
    const idx = (...names: string[]) => cols.findIndex((c) => names.includes(c));
    const iItem = idx('item', 'document');
    const iForm = idx('form', 'copytype', 'originalcopy');
    const iSig = idx('signature', 'signed');
    const iDate = idx('date', 'received', 'receiveddate');
    const iBill = idx('billtype', 'bill');
    const iRef = idx('referenceno', 'refno', 'reference');
    const iPages = idx('pages', 'pagecount');
    const iSub = idx('submissionref', 'submission', 'submissionreference');
    for (const l of lines) {
      if (l === header || l.page !== header.page) continue;
      const f = splitCsvLine(l.text);
      const label = f[iItem] ?? '';
      const type = detectType(label);
      if (!type) continue;
      const get = (i: number) => (i >= 0 ? (f[i] ?? '') : '');
      const pagesN = Number(get(iPages));
      out.push({
        source: 'register',
        docId: doc.id,
        type,
        refNo: get(iRef) || findRefNo(label),
        form: formOf(get(iForm)),
        signed: signedOf(get(iSig)),
        billForm: billOf(get(iBill)) ?? billOf(label),
        date: parseDate(get(iDate)),
        submissionRef: findSubmissionRef(get(iSub)) ?? (get(iSub) || undefined),
        pagesTotal: Number.isFinite(pagesN) && pagesN > 0 ? pagesN : undefined,
        readable: true,
        quotes: [q(doc, l)],
      });
    }
    return out;
  }
  // Free-text register lines "Label: attributes".
  for (const l of lines) {
    const m = /^([^:]{3,60}):\s*(.+)$/.exec(l.text);
    if (!m) continue;
    const type = detectType(m[1]!);
    if (!type) continue;
    out.push({
      source: 'register',
      docId: doc.id,
      type,
      refNo: findRefNo(l.text),
      form: formOf(m[2]!),
      signed: signedOf(m[2]!),
      billForm: billOf(m[2]!),
      date: parseDate(m[2]!),
      submissionRef: findSubmissionRef(m[2]!),
      readable: true,
      quotes: [q(doc, l)],
    });
  }
  return out;
}

export interface Receipt {
  doc: DocIn;
  source: 'receipt' | 'correspondence';
  date?: number;
  ref?: string;
  offers: Offer[];
}

/** Receipts and prior correspondence: they can show something was sent, never that it was sufficient. */
export function parseReceipt(doc: DocIn, source: 'receipt' | 'correspondence'): Receipt {
  const lines = linesOf(doc);
  let date: number | undefined;
  let ref: string | undefined;
  for (const l of lines) {
    const dm = /^(?:date|dated|submitted on)\s*[:\-]\s*(.+)$/i.exec(l.text);
    if (dm && date === undefined) date = parseDate(dm[1]!);
    if (!ref) ref = findSubmissionRef(l.text);
  }
  const offers: Offer[] = [];
  for (const l of lines) {
    const b = BULLET.exec(l.text) ?? NUMBERED.exec(l.text);
    const body = b ? (b[2] ?? b[1]!) : l.text;
    const type = detectType(body);
    if (!type) continue;
    if (!b && !/\b(enclos|attach|submitted|acknowledg|received)/i.test(body)) continue;
    // Bullet lines under a bullet-less header are items; sentences must be about sending something.
    offers.push({
      source,
      docId: doc.id,
      type,
      refNo: findRefNo(body),
      date,
      submissionRef: findSubmissionRef(l.text) ?? ref,
      readable: true,
      quotes: [q(doc, l)],
    });
  }
  return { doc, source, date, ref, offers };
}

// ---------- subject documents (the documents themselves) ----------

function typeFromName(name: string): string | null {
  return detectType(name.replace(/\.[A-Za-z0-9]+$/, '').replace(/\.pdf$/i, '').replace(/[-_.]+/g, ' '));
}

export function parseSubject(doc: DocIn): Offer | null {
  const failedPages = doc.pages.filter((p) => p.ocr_status === 'failed').length;
  const lines = linesOf(doc);
  const type = lines.slice(0, 3).map((l) => detectType(l.text)).find(Boolean) ?? typeFromName(doc.name);
  if (!type) return null;
  if (!lines.length) {
    // Unreadable scan: the filename hints at the type, the text is unavailable.
    return { source: 'document', docId: doc.id, type, readable: false, quotes: [] };
  }
  const quotes: Quote[] = [];
  const heading = lines.find((l) => detectType(l.text) === type) ?? lines[0]!;
  quotes.push(q(doc, heading));
  let form: Offer['form'];
  let signed: boolean | undefined;
  let billForm: Offer['billForm'];
  let date: number | undefined;
  let refNo: string | undefined;
  const seenPages = new Set<number>();
  let total: number | undefined;
  for (const l of lines) {
    let m = /^(?:status|copy\s+type|original\s*\/\s*copy|form)\s*[:\-]\s*(.+)$/i.exec(l.text);
    if (m && form === undefined && formOf(m[1]!)) {
      form = formOf(m[1]!);
      quotes.push(q(doc, l));
    }
    m = /^(?:[a-z' .]*\s)?(?:signature|signed\s+by|authori[sz]ed\s+signatory)\s*[:\-]\s*(.*)$/i.exec(l.text);
    if (m && signed === undefined) {
      signed = signedOf(m[1] ? m[1] : 'blank');
      if (signed === undefined && m[1]) signed = true; // a named signatory
      quotes.push(q(doc, l));
    } else if (!m && signed === undefined && /^\[?(unsigned)\]?$/i.test(l.text)) {
      signed = false;
      quotes.push(q(doc, l));
    }
    m = /^bill\s+type\s*[:\-]\s*(.+)$/i.exec(l.text);
    if (m && billForm === undefined && billOf(m[1]!)) {
      billForm = billOf(m[1]!);
      quotes.push(q(doc, l));
    }
    m = /^(?:date|dated|discharge\s+date|bill\s+date|issued(?:\s+on)?)\s*[:\-]\s*(.+)$/i.exec(l.text);
    if (m && date === undefined) {
      date = parseDate(m[1]!);
      if (date !== undefined) quotes.push(q(doc, l));
    }
    m = /^(?:bill|invoice|report|reference|ref)\s*(?:no\.?|number|#)?\s*[:\-]\s*(.+)$/i.exec(l.text);
    if (m && !refNo) refNo = findRefNo(m[1]!);
    const pm = /\bpage\s+(\d{1,3})\s+of\s+(\d{1,3})\b/i.exec(l.text);
    if (pm) {
      seenPages.add(Number(pm[1]));
      total = Math.max(total ?? 0, Number(pm[2]));
    }
  }
  if (!billForm && type === 'hospital_bill') billForm = billOf(heading.text);
  let pagesMissing: number[] | undefined;
  if (total && total > 1) {
    const miss: number[] = [];
    for (let p = 1; p <= total; p++) if (!seenPages.has(p)) miss.push(p);
    if (miss.length) {
      pagesMissing = miss;
      const marker = lines.find((l) => /\bpage\s+\d{1,3}\s+of\s+\d{1,3}\b/i.test(l.text));
      if (marker) quotes.push(q(doc, marker));
    }
  }
  return {
    source: 'document',
    docId: doc.id,
    type,
    refNo,
    form,
    signed,
    billForm,
    date,
    pagesTotal: total,
    pagesMissing,
    // A partly unreadable multi-page scan is still usable for what is readable.
    readable: failedPages < doc.pages.length,
    quotes,
  };
}

/** Short neutral description of any document, used by the chronology. */
export function parseDocDate(doc: DocIn): number | undefined {
  for (const l of linesOf(doc)) {
    const m = /^(?:date|dated|submitted on|received)\s*[:\-]\s*(.+)$/i.exec(l.text);
    if (m) {
      const d = parseDate(m[1]!);
      if (d !== undefined) return d;
    }
  }
  return undefined;
}
