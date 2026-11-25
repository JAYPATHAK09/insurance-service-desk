import type { Scope, Value } from './types';

// ---------- numbers ----------

const ONES: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

/** "thirty six" / "thirty-six" / "twelve" -> number (0..99), else null. */
export function wordsToNumber(s: string): number | null {
  const parts = s.toLowerCase().trim().split(/[\s-]+/).filter(Boolean);
  if (!parts.length || parts.length > 2) return null;
  if (parts.length === 1) return ONES[parts[0]!] ?? TENS[parts[0]!] ?? null;
  const t = TENS[parts[0]!];
  const o = ONES[parts[1]!];
  return t !== undefined && o !== undefined && o < 10 ? t + o : null;
}

/** Indian digit grouping: 750000 -> "7,50,000". */
export function fmtInr(n: number): string {
  const neg = n < 0;
  const [int = '0', frac] = Math.abs(n).toString().split('.');
  const last3 = int.slice(-3);
  const rest = int.slice(0, -3);
  const grouped = rest ? rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + last3 : last3;
  return (neg ? '-' : '') + grouped + (frac ? '.' + frac : '');
}

export interface MoneyHit {
  amount: number;
  index: number;
  end: number;
}

const MONEY_RE = /(?:(rs\.?|inr|₹)\s*)?([0-9][0-9,]*(?:\.[0-9]+)?)\s*(lakhs?|lacs?|crores?)?(?:\s*\/-)?/gi;

/** All money amounts in a string. A bare number counts only with a currency marker or a lakh/crore unit. */
export function findMoney(text: string): MoneyHit[] {
  const out: MoneyHit[] = [];
  for (const m of text.matchAll(MONEY_RE)) {
    const cur = m[1];
    const unit = m[3]?.toLowerCase();
    if (!cur && !unit) continue;
    // Skip "20%" style numbers that slipped in via a unit-less match.
    const n = Number((m[2] ?? '').replace(/,/g, ''));
    if (!Number.isFinite(n)) continue;
    // A number glued to letters ("5,OO,OOO", "10,000per") is probably OCR noise: do not read a truncated amount from it.
    const numEnd = (m.index ?? 0) + m[0].indexOf(m[2]!) + m[2]!.length;
    if (!unit && /^[A-Za-z]/.test(text.slice(numEnd))) continue;
    const mult = !unit ? 1 : unit.startsWith('cr') ? 10_000_000 : 100_000;
    out.push({ amount: Math.round(n * mult), index: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
  }
  return out;
}

export function findPercents(text: string): Array<{ percent: number; index: number; end: number }> {
  const out: Array<{ percent: number; index: number; end: number }> = [];
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s*(?:%|per\s*cent|percent)/gi)) {
    out.push({ percent: Number(m[1]), index: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
  }
  return out;
}

export function parseDuration(text: string): { unit: 'days' | 'months'; n: number } | null {
  const re = /((?:[a-z]+(?:[\s-][a-z]+)?)|\d+)\s*(?:\((\d+)\))?\s*(day|days|month|months|year|years|yr|yrs)\b/gi;
  for (const m of text.matchAll(re)) {
    const word = m[1]!;
    const n = m[2] ? Number(m[2]) : /^\d+$/.test(word) ? Number(word) : wordsToNumber(word);
    if (n === null || n === undefined || !Number.isFinite(n)) continue;
    const u = m[3]!.toLowerCase();
    if (u.startsWith('day')) return { unit: 'days', n };
    if (u.startsWith('month')) return { unit: 'months', n };
    return { unit: 'months', n: n * 12 };
  }
  return null;
}

// ---------- dates ----------

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const pad = (n: number) => String(n).padStart(2, '0');
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

/** All dates in a string as ISO yyyy-mm-dd, in order of appearance. */
export function findDates(text: string): string[] {
  const hits: Array<{ i: number; v: string }> = [];
  for (const m of text.matchAll(/\b(\d{1,2})[\s\-/.]+([A-Za-z]{3,9})[\s\-/.,]+(\d{4})\b/g)) {
    const mi = MONTHS.indexOf(m[2]!.slice(0, 3).toLowerCase());
    if (mi >= 0) hits.push({ i: m.index ?? 0, v: iso(Number(m[3]), mi + 1, Number(m[1])) });
  }
  for (const m of text.matchAll(/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\b/g)) {
    hits.push({ i: m.index ?? 0, v: iso(Number(m[3]), Number(m[2]), Number(m[1])) });
  }
  for (const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) hits.push({ i: m.index ?? 0, v: m[0] });
  return hits.sort((a, b) => a.i - b.i).map((h) => h.v);
}

export function addDays(isoDate: string, n: number): string {
  const d = new Date(isoDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ---------- text ----------

export const STOP = new Set([
  'the', 'a', 'an', 'of', 'for', 'to', 'and', 'or', 'in', 'on', 'by', 'any', 'is', 'are', 'be', 'as', 'at', 'with', 'from', 'this', 'that', 'shall', 'will', 'under', 'due',
]);
const NEGATION = new Set(['not', 'no', 'except', 'excluding', 'unless', 'only', 'without', 'other', 'than']);

export function tokens(s: string): string[] {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .split(/[^a-z0-9ऀ-ॿ]+/)
    .filter((t) => t && !STOP.has(t))
    .map((t) => (t.length > 3 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t));
}

export function slug(s: string, max = 60): string {
  return tokens(s).join('-').slice(0, max).replace(/-+$/, '') || 'item';
}

export function normText(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').replace(/[.;,\s]+$/, '').trim();
}

/** True when two free-text clauses carry the same meaning by token overlap (and the same negations). */
export function textSimilar(a: string, b: string, threshold = 0.6): boolean {
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  const na = [...ta].filter((t) => NEGATION.has(t)).sort().join(',');
  const nb = [...tb].filter((t) => NEGATION.has(t)).sort().join(',');
  if (na !== nb) return false;
  const inter = [...ta].filter((t) => tb.has(t)).length;
  const union = new Set([...ta, ...tb]).size;
  return union > 0 && inter / union >= threshold;
}

export function normName(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\b(mr|mrs|ms|miss|shri|smt|dr|sri)\b\.?/g, ' ')
    .replace(/[^a-z0-9ऀ-ॿ]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

// ---------- scope / value canonicalisation ----------

export function parseScope(clause: string): Scope {
  const c = clause.toLowerCase();
  let m = c.match(/(?:aged?|age)\s*(?:of\s*)?(\d{2})\s*(?:years?|yrs?)?\s*(?:\+|and\s+above|and\s+over|or\s+above|or\s+older|and\s+older|plus|onwards|and\s+more)/);
  if (m) return { type: 'age_gte', age: Number(m[1]) };
  m = c.match(/(\d{2})\s*(?:years?|yrs?)?\s*(?:\+|and\s+above|and\s+over|or\s+above|or\s+older|and\s+older|plus|onwards)/);
  if (m) return { type: 'age_gte', age: Number(m[1]) };
  m = c.match(/(?:above|over|older than|more than)\s*(?:the\s*age\s*of\s*)?(\d{2})\s*(?:years?|yrs?)?/);
  if (m) return { type: 'age_gte', age: Number(m[1]) + 1 };
  m = c.match(/(?:below|under|younger than|less than)\s*(?:the\s*age\s*of\s*)?(\d{2})\s*(?:years?|yrs?)?/);
  if (m) return { type: 'age_lt', age: Number(m[1]) };
  if (/non[-\s]?network/.test(c)) return { type: 'non_network' };
  if (/\b(all|every|each|any)\b.*\bclaims?\b|\bclaims?\b.*\b(all|every|each)\b|\ball\s+insured|\bentire\b/.test(c) || !/[a-z]/.test(c.replace(/co-?pay(?:ment)?|admissible|claims?|applicable|applies|of|the|every|each/g, ''))) {
    return { type: 'all' };
  }
  const rest = normText(c.replace(/\d+(?:\.\d+)?\s*(?:%|per\s*cent|percent)/g, '').replace(/co-?pay(?:ment)?/g, ''));
  return rest ? { type: 'text', text: rest } : { type: 'all' };
}

export function scopeCanon(s: Scope): string {
  switch (s.type) {
    case 'all': return 'all';
    case 'age_gte': return `age>=${s.age}`;
    case 'age_lt': return `age<${s.age}`;
    case 'non_network': return 'non_network';
    case 'text': return `text:${slug(s.text, 40)}`;
  }
}

export function valueCanon(v: Value): string {
  switch (v.kind) {
    case 'money': return `money:${v.amount}:${v.basis ?? ''}`;
    case 'pct_si': return `pct_si:${v.percent}:${v.basis ?? ''}`;
    case 'copay':
      return 'copay:' + v.entries.map((e) => `${e.percent}@${scopeCanon(e.scope)}`).sort().join(';');
    case 'room':
      return `room:${v.mode}:${v.percent ?? ''}:${v.amount ?? ''}:${v.mode === 'text' ? slug(v.text ?? '', 40) : ''}`;
    case 'duration': return `duration:${v.n}${v.unit}`;
    case 'text': return `text:${slug(v.text, 80)}`;
  }
}

const BASIS_EN: Record<string, string> = {
  per_claim: 'per claim', per_year: 'per policy year', per_eye: 'per eye', per_day: 'per day',
  per_admission: 'per hospitalisation', per_knee: 'per knee', per_event: 'per event',
};
export const basisLabel = (b?: string) => (b ? BASIS_EN[b] ?? b.replace(/_/g, ' ') : '');

export function parseBasis(text: string): string | undefined {
  const t = text.toLowerCase();
  if (/(?:per|each|every|a)\s+(?:policy\s+)?year|annual|yearly/.test(t)) return 'per_year';
  if (/(?:per|each|every)\s+claim/.test(t)) return 'per_claim';
  if (/(?:per|each)\s+eye/.test(t)) return 'per_eye';
  if (/(?:per|each|every|a)\s+day|daily/.test(t)) return 'per_day';
  if (/(?:per|each)\s+(?:hospitali[sz]ation|admission)/.test(t)) return 'per_admission';
  if (/(?:per|each)\s+knee/.test(t)) return 'per_knee';
  if (/(?:per|each)\s+(?:event|illness)/.test(t)) return 'per_event';
  return undefined;
}

export function describeScopeEn(s: Scope): string {
  switch (s.type) {
    case 'all': return 'all claims';
    case 'age_gte': return `claims for insured persons aged ${s.age}+`;
    case 'age_lt': return `claims for insured persons below age ${s.age}`;
    case 'non_network': return 'claims at non-network hospitals';
    case 'text': return s.text;
  }
}

/** Plain English description of a value, normalised (so rephrased wording gives the same string). */
export function describeValue(v: Value | null | undefined): string {
  if (!v) return 'not stated';
  switch (v.kind) {
    case 'money': {
      const b = basisLabel(v.basis);
      return `${v.amount === 0 ? 'Nil (Rs 0)' : `Rs ${fmtInr(v.amount)}`}${b ? ' ' + b : ''}`;
    }
    case 'pct_si': {
      const b = basisLabel(v.basis);
      return `${v.percent}% of sum insured${b ? ' ' + b : ''}`;
    }
    case 'copay':
      return v.entries.map((e) => `${e.percent}% (${describeScopeEn(e.scope)})`).join('; ');
    case 'room':
      if (v.mode === 'pct_si') return `${v.percent}% of sum insured per day`;
      if (v.mode === 'amount_per_day') return `Rs ${fmtInr(v.amount ?? 0)} per day`;
      if (v.mode === 'none') return 'no limit stated';
      if (v.mode === 'single_private') return 'single private room';
      return v.text ?? '';
    case 'duration':
      return `${v.n} ${v.n === 1 ? v.unit.slice(0, -1) : v.unit}`;
    case 'text':
      return v.text;
  }
}
