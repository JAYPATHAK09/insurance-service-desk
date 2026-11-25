import {
  findDates,
  findMoney,
  findPercents,
  normName,
  normText,
  parseBasis,
  parseDuration,
  parseScope,
  slug,
} from './parse';
import type { DocRole, FieldId, RoleDoc, Src, Stmt, Value } from './types';

export const pageLines = (text: string): string[] =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

// ---------- statements ----------

const FIELD_PATTERNS: Array<[FieldId, RegExp]> = [
  ['waiting_period', /waiting\s+period/i],
  ['copay', /co-?\s?pay(?:ment)?/i],
  ['deductible', /deductible/i],
  ['room_rent', /room\s+(?:rent|limit|category|type|eligibility)/i],
  ['sub_limit', /sub-?\s?limits?/i],
  ['sum_insured', /sum\s+(?:insured|assured)/i],
  ['premium', /premium/i],
];

const EXCLUSION_RE = /^(?:[-*•]\s*)?(?:permanent\s+|new\s+|specific\s+)?exclusions?(?:\s*(?:no\.?\s*)?\d+)?\s*[:\-–]\s*(.+)$/i;
const REVISION_RE = /\b(revised|changed|amended|increased|reduced|enhanced|modified|updated)\b/i;

const PRIOR_RE = /(?:last\s+year|previous|prior|earlier|expiring|old|was|from)\W[^\d]{0,25}$/i;

/**
 * Money that this line states as the operative value: after the last " to " on revision lines, else the first.
 * Returns ambiguous=true when the line states several different amounts and none is clearly "last year's" figure.
 */
function operativeMoney(line: string): { amount: number; ambiguous: boolean } | null {
  let region = line;
  const revision = REVISION_RE.test(line);
  if (revision) {
    const i = line.toLowerCase().lastIndexOf(' to ');
    if (i >= 0) region = line.slice(i + 4);
  }
  const hits = findMoney(region);
  if (!hits.length) return null;
  if (revision) return { amount: hits[0]!.amount, ambiguous: false };
  const current = hits.filter((h) => !PRIOR_RE.test(region.slice(0, h.index)));
  const distinct = new Set(current.map((h) => h.amount));
  return { amount: (current[0] ?? hits[0]!).amount, ambiguous: distinct.size > 1 };
}

/** On revision lines ("revised from A to B") the operative text is what follows the last " to ". */
function revisionTail(line: string): string {
  if (!REVISION_RE.test(line)) return line;
  const i = line.toLowerCase().lastIndexOf(' to ');
  return i >= 0 ? line.slice(i + 4) : line;
}

function copayValue(line: string): Value | null {
  const clauses = line.split(/;|\.\s/).map((c) => c.trim()).filter(Boolean);
  const entries: Array<{ percent: number; scope: ReturnType<typeof parseScope> }> = [];
  for (const clause of clauses) {
    const pcts = findPercents(clause);
    if (pcts.length) {
      const pct = pcts[0]!.percent;
      entries.push({ percent: pct, scope: pct === 0 ? { type: 'all' } : parseScope(clause) });
    } else if (/\b(nil|no co-?pay(?:ment)?|not applicable|waived|none)\b/i.test(clause)) {
      entries.push({ percent: 0, scope: { type: 'all' } });
    }
  }
  return entries.length ? { kind: 'copay', entries } : null;
}

function roomValue(line: string): Value | null {
  const l = line.toLowerCase();
  const pct = l.match(/(\d+(?:\.\d+)?)\s*(?:%|per\s*cent|percent)\s*of\s*(?:the\s*)?(?:sum\s*insured|si)\b/);
  if (pct) return { kind: 'room', mode: 'pct_si', percent: Number(pct[1]) };
  const money = findMoney(line)[0];
  if (money && /per\s+day|a\s+day|daily|each\s+day/.test(l)) return { kind: 'room', mode: 'amount_per_day', amount: money.amount };
  if (/single\s+private|private\s+single|single\s+room/.test(l)) return { kind: 'room', mode: 'single_private' };
  if (/\bno\s+(?:limit|cap|capping|restriction)|\bany\s+room|\bwithout\s+(?:any\s+)?(?:limit|cap)|\bactuals?\b/.test(l)) return { kind: 'room', mode: 'none' };
  const body = line.replace(/^.*?room\s+(?:rent|limit|category|type|eligibility)\s*[:\-–]?\s*/i, '');
  return body ? { kind: 'room', mode: 'text', text: normText(body) } : null;
}

const WAIT_CATS: Array<[string, RegExp]> = [
  ['pre_existing', /pre-?\s?existing|\bPED\b/i],
  ['initial', /initial|first\s+30|30[-\s]day/i],
  ['specific', /specific/i],
  ['maternity', /maternity/i],
];

/** Extract the statements one line makes (zero or one in the current grammar). */
function extractLineStrict(line: string, src: Omit<Src, 'quote'>): Stmt[] {
  const quote = line;
  const mk = (field: FieldId, item: string, itemLabel: string, value: Value): Stmt[] => [
    { field, item, itemLabel, value, src: { ...src, quote } },
  ];

  const ex = line.match(EXCLUSION_RE);
  if (ex) {
    const text = ex[1]!.trim().replace(/[.;]+$/, '');
    return mk('exclusion', slug(text), text, { kind: 'text', text });
  }

  // Choose the field keyword that appears earliest in the line.
  let best: { f: FieldId; i: number } | null = null;
  for (const [f, re] of FIELD_PATTERNS) {
    const m = re.exec(line);
    if (m && (best === null || m.index < best.i)) best = { f, i: m.index };
  }
  if (!best) return [];

  switch (best.f) {
    case 'premium': {
      const m = operativeMoney(line);
      return m && !m.ambiguous ? mk('premium', '', '', { kind: 'money', amount: m.amount }) : [];
    }
    case 'sum_insured': {
      const m = operativeMoney(line);
      return m && !m.ambiguous ? mk('sum_insured', '', '', { kind: 'money', amount: m.amount }) : [];
    }
    case 'copay': {
      const v = copayValue(revisionTail(line));
      return v ? mk('copay', '', '', v) : [];
    }
    case 'deductible': {
      const m = operativeMoney(line);
      const basis = parseBasis(line);
      if (m && !m.ambiguous) return mk('deductible', '', '', { kind: 'money', amount: m.amount, basis });
      if (m) return [];
      if (/\b(nil|none|not applicable|no deductible|zero)\b/i.test(line)) return mk('deductible', '', '', { kind: 'money', amount: 0 });
      return [];
    }
    case 'room_rent': {
      const v = roomValue(revisionTail(line));
      return v ? mk('room_rent', '', '', v) : [];
    }
    case 'waiting_period': {
      const cat = WAIT_CATS.find(([, re]) => re.test(line))?.[0] ?? `other-${slug(line.replace(/waiting\s+period/i, ''), 30)}`;
      const d = parseDuration(revisionTail(line));
      const label = cat.replace(/_/g, '-');
      return d ? mk('waiting_period', cat, label, { kind: 'duration', unit: d.unit, n: d.n }) : [];
    }
    case 'sub_limit': {
      const kw = /sub-?\s?limits?/i.exec(line)!;
      const before = line.slice(0, kw.index).replace(/[\s:\-–]+$/, '').trim();
      let after = line.slice(kw.index + kw[0].length).replace(/^[\s:\-–]*(?:(?:for|on|towards|applicable\s+to|of)\b)?\s*/i, '');
      after = after.split(/\s*(?::|\bof\s+(?:rs|inr|₹)|\bis\b|\blimited\b|\bcapped\b|(?:rs\.?|inr|₹)|\d+\s*%)/i)[0]!.trim();
      const item = (after || before).replace(/^(?:[-*•]\s*)/, '').trim();
      if (!item) return [];
      const pct = line.toLowerCase().match(/(\d+(?:\.\d+)?)\s*%\s*of\s*(?:the\s*)?sum\s*insured/);
      const basis = parseBasis(line);
      if (pct) return mk('sub_limit', slug(item), item, { kind: 'pct_si', percent: Number(pct[1]), basis });
      const m = operativeMoney(line);
      return m && !m.ambiguous ? mk('sub_limit', slug(item), item, { kind: 'money', amount: m.amount, basis }) : [];
    }
    default:
      return [];
  }
}

export function extractStatements(doc: RoleDoc, endorsementNo?: string): Stmt[] {
  const out: Stmt[] = [];
  for (const p of doc.pages) {
    if (p.failed) continue;
    for (const line of pageLines(p.text)) {
      out.push(...extractLine(line, { role: doc.role, docId: doc.id, filename: doc.filename, page: p.page, endorsementNo }));
    }
  }
  return out;
}

// ---------- headers ----------

export interface HeaderField<T = string> {
  value: T;
  src: Src;
}
export interface Header {
  policyholder?: HeaderField;
  product?: HeaderField;
  period?: HeaderField<{ start: string; end: string }>;
  policyNo?: HeaderField;
  priorPolicyNo?: HeaderField;
  effective?: HeaderField;
  endorsementNo?: HeaderField;
}

const H = {
  policyholder: /^(?:policy\s?holder|insured\s+name|proposer|name\s+of\s+(?:the\s+)?policy\s?holder)(?:\s+name)?\s*[:\-–]\s*(.+)$/i,
  product: /^(?:product(?:\s+name)?|plan(?:\s+name)?)\s*[:\-–]\s*(.+)$/i,
  period: /^(?:policy\s+period|period\s+of\s+(?:insurance|cover)|policy\s+term|renewal\s+period)\s*[:\-–]\s*(.+)$/i,
  priorPolicyNo: /^(?:previous\s+policy\s+(?:no\.?|number)|renewal\s+of\s+policy(?:\s+(?:no\.?|number))?|expiring\s+policy\s+(?:no\.?|number))\s*[:\-–]\s*(\S+)/i,
  policyNo: /^policy\s+(?:no\.?|number|#)\s*[:\-–]\s*(\S+)/i,
  effective: /^(?:effective\s+date|endorsement\s+effective(?:\s+date)?|w\.e\.f\.?)\s*[:\-–]\s*(.+)$/i,
  endorsementNo: /^endorsement\s+(?:no\.?|number)\s*[:\-–]\s*(\S+)/i,
};

export function extractHeader(doc: RoleDoc): Header {
  const h: Header = {};
  for (const p of doc.pages) {
    if (p.failed) continue;
    for (const line of pageLines(p.text)) {
      const src: Src = { role: doc.role, docId: doc.id, filename: doc.filename, page: p.page, quote: line };
      let m: RegExpMatchArray | null;
      if (!h.policyholder && (m = line.match(H.policyholder))) h.policyholder = { value: m[1]!.trim(), src };
      else if (!h.product && (m = line.match(H.product))) h.product = { value: m[1]!.trim(), src };
      else if (!h.period && (m = line.match(H.period))) {
        const d = findDates(m[1]!);
        if (d.length >= 2) h.period = { value: { start: d[0]!, end: d[1]! }, src };
      } else if (!h.priorPolicyNo && (m = line.match(H.priorPolicyNo))) h.priorPolicyNo = { value: m[1]!, src };
      else if (!h.policyNo && (m = line.match(H.policyNo))) h.policyNo = { value: m[1]!, src };
      else if (!h.effective && (m = line.match(H.effective))) {
        const d = findDates(m[1]!);
        if (d[0]) h.effective = { value: d[0], src };
      } else if (!h.endorsementNo && (m = line.match(H.endorsementNo))) h.endorsementNo = { value: m[1]!, src };
    }
  }
  return h;
}

export const sameName = (a: string, b: string) => normName(a) === normName(b);
export const sameProduct = (a: string, b: string) => slug(a, 120) === slug(b, 120);
export const normPolicyNo = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

// ---------- pages ----------

export interface PageStatus {
  failedPages: number[];
  missingPages: number[];
  declaredTotal: number | null;
  /** A footer quote proving the declared total, with its file page. */
  proof: { page: number; quote: string } | null;
}

const FOOTER_RE = /\bpage\s+(\d+)\s*(?:of|\/)\s*(\d+)\b/i;

export function pageStatus(doc: RoleDoc): PageStatus {
  const failedPages = doc.pages.filter((p) => p.failed).map((p) => p.page);
  const numbers = new Set<number>();
  let declared: number | null = null;
  let proof: PageStatus['proof'] = null;
  const footers = new Map<number, { page: number; quote: string }>();
  let anyFooter = false;
  for (const p of doc.pages) {
    if (p.failed) continue;
    const lines = pageLines(p.text);
    for (const line of lines) {
      const m = line.match(FOOTER_RE);
      if (m) {
        anyFooter = true;
        numbers.add(Number(m[1]));
        footers.set(Number(m[1]), { page: p.page, quote: line });
        declared = Math.max(declared ?? 0, Number(m[2]));
        proof = { page: p.page, quote: line };
      }
      const t = line.match(/^(?:total|document)\s+pages\s*[:\-–]\s*(\d+)/i);
      if (t) {
        declared = Math.max(declared ?? 0, Number(t[1]));
        proof ??= { page: p.page, quote: line };
      }
    }
  }
  if (!anyFooter && declared === null) return { failedPages, missingPages: [], declaredTotal: null, proof: null };
  if (!anyFooter) doc.pages.filter((p) => !p.failed).forEach((p) => numbers.add(p.page));
  const missing: number[] = [];
  for (let n = 1; n <= (declared ?? 0); n++) if (!numbers.has(n)) missing.push(n);
  if (missing.length) proof = footers.get(missing[0]! - 1) ?? proof;
  // Unreadable file pages occupy a slot: attribute them to missing numbers, preferring their own index.
  const remaining = [...missing];
  for (const fp of failedPages) {
    const idx = remaining.includes(fp) ? remaining.indexOf(fp) : 0;
    if (remaining.length) remaining.splice(idx, 1);
  }
  return { failedPages, missingPages: remaining, declaredTotal: declared, proof };
}

export const roleOfKind = (kind: string, filename: string): DocRole | null => {
  if (kind === 'policy_schedule' || kind === 'endorsement' || kind === 'renewal_proposal') return kind;
  const f = filename.toLowerCase();
  if (/endorse/.test(f)) return 'endorsement';
  if (/renew/.test(f)) return 'renewal_proposal';
  if (/schedule|expiring|policy/.test(f)) return 'policy_schedule';
  return null;
};

/**
 * A line that names a term but whose value we could not read (no currency symbol, several amounts, OCR noise, words
 * for numbers) becomes an unparsed "text" statement. It can never produce a confirmed change: comparing it with a
 * parsed value is ambiguous. Without this, an unreadable term would silently disappear from the comparison.
 */
export function extractLine(line: string, src: Omit<Src, 'quote'>): Stmt[] {
  const strict = extractLineStrict(line, src);
  if (strict.length) return strict;
  if (EXCLUSION_RE.test(line) || line.length > 300 || !/[:|\d]/.test(line)) return [];
  if (/^page\s+\d+\s*(?:of|\/)/i.test(line)) return [];
  if (/^(?:policy\s+(?:period|number|no)|policy\s?holder|product|plan|renewal\s+of|previous\s+policy|expiring\s+policy|endorsement|effective)/i.test(line)) return [];
  let best: { f: FieldId; i: number } | null = null;
  for (const [f, re] of FIELD_PATTERNS) {
    const m = re.exec(line);
    if (m && m.index <= 40 && (best === null || m.index < best.i)) best = { f, i: m.index };
  }
  if (!best) return [];
  const item = best.f === 'sub_limit' || best.f === 'waiting_period' ? slug(line, 40) : '';
  return [{ field: best.f, item, itemLabel: item ? line : '', value: { kind: 'text', text: line }, src: { ...src, quote: line } }];
}
