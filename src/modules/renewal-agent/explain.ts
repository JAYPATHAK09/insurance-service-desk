import { createHash } from 'node:crypto';
import { fmtInr, describeValue } from './parse';
import { CLARIFY_PREFIX, FIELD_LABEL, type FieldId, type Value } from './types';

export const EXPLANATION_LANGS = ['en', 'hi'] as const;
export type ExplanationLang = (typeof EXPLANATION_LANGS)[number];
export const TEMPLATE_VERSION = 'renewal-expl-1';

export interface ExplainFinding {
  id: string;
  classification: string;
  status: string;
  decisionNote?: string | null;
  attributes: Record<string, unknown> | null;
}

interface Side {
  display?: string;
  value?: Value;
}
interface Attrs {
  field?: FieldId;
  item?: string;
  item_label?: string;
  material?: boolean;
  old?: Side | null;
  new?: Side | null;
  policyholder?: string;
  product?: string;
  renewal_period?: { start: string; end: string };
}

export interface ExplainItem {
  findingId: string;
  field: FieldId;
  item: string;
  itemLabel: string;
  old: Side | null;
  new: Side | null;
}

export interface Explanation {
  lang: ExplanationLang;
  text: string;
  /** Template version plus a short hash of the exact text: what the customer is shown is what gets approved and acknowledged. */
  version: string;
  changes: ExplainItem[];
  clarifications: ExplainItem[];
}

const attrsOf = (f: ExplainFinding): Attrs => (f.attributes ?? {}) as Attrs;

const toItem = (f: ExplainFinding): ExplainItem | null => {
  const a = attrsOf(f);
  if (!a.field) return null;
  return { findingId: f.id, field: a.field, item: a.item ?? '', itemLabel: a.item_label ?? a.item ?? '', old: a.old ?? null, new: a.new ?? null };
};

/** Material confirmed changes the reviewer has not rejected, and points marked for insurer clarification. */
export function selectExplainItems(findings: ExplainFinding[]): { changes: ExplainItem[]; clarifications: ExplainItem[] } {
  const changes: ExplainItem[] = [];
  const clarifications: ExplainItem[] = [];
  for (const f of findings) {
    const a = attrsOf(f);
    if (!a.material || f.status === 'dismissed') continue;
    const item = toItem(f);
    if (!item) continue;
    const clarify = f.status === 'overridden' && (f.decisionNote ?? '').startsWith(CLARIFY_PREFIX.trim());
    if (clarify) {
      if (['confirmed_change', 'ambiguous'].includes(f.classification)) clarifications.push(item);
      continue;
    }
    if (f.classification === 'confirmed_change' && f.status !== 'overridden') changes.push(item);
  }
  return { changes, clarifications };
}

// ---------- values ----------

const HI_BASIS: Record<string, string> = {
  per_claim: 'प्रति क्लेम', per_year: 'प्रति पॉलिसी वर्ष', per_eye: 'प्रति आँख', per_day: 'प्रति दिन',
  per_admission: 'प्रति अस्पताल में भर्ती', per_knee: 'प्रति घुटना', per_event: 'प्रति घटना',
};

function hiScope(s: Extract<Value, { kind: 'copay' }>['entries'][number]['scope']): string {
  switch (s.type) {
    case 'all': return 'सभी क्लेम';
    case 'age_gte': return `${s.age} वर्ष या उससे अधिक आयु के बीमित व्यक्तियों के क्लेम`;
    case 'age_lt': return `${s.age} वर्ष से कम आयु के बीमित व्यक्तियों के क्लेम`;
    case 'non_network': return 'नेटवर्क के बाहर के अस्पतालों के क्लेम';
    case 'text': return s.text;
  }
}

function hiDuration(v: Extract<Value, { kind: 'duration' }>): string {
  if (v.unit === 'days') return `${v.n} दिन`;
  return v.n % 12 === 0 ? `${v.n / 12} वर्ष` : `${v.n} महीने`;
}

export function renderValue(side: Side | null, lang: ExplanationLang): string {
  if (!side) return lang === 'hi' ? 'दस्तावेज़ में नहीं दिखाया गया' : 'not shown in the document';
  const v = side.value;
  if (!v || v.kind === 'text') return side.display ?? (v ? v.text : '');
  if (lang === 'en') return describeValue(v);
  switch (v.kind) {
    case 'money': {
      const b = v.basis ? ` ${HI_BASIS[v.basis] ?? v.basis}` : '';
      return `${v.amount === 0 ? 'शून्य (₹0)' : `₹${fmtInr(v.amount)}`}${b}`;
    }
    case 'pct_si': return `बीमित राशि का ${v.percent}%${v.basis ? ' ' + (HI_BASIS[v.basis] ?? v.basis) : ''}`;
    case 'copay': return v.entries.map((e) => `${e.percent}% (${hiScope(e.scope)})`).join('; ');
    case 'room':
      if (v.mode === 'pct_si') return `बीमित राशि का ${v.percent}% प्रति दिन`;
      if (v.mode === 'amount_per_day') return `₹${fmtInr(v.amount ?? 0)} प्रति दिन`;
      if (v.mode === 'none') return 'कोई सीमा नहीं दिखाई गई';
      if (v.mode === 'single_private') return 'सिंगल प्राइवेट रूम';
      return v.text ?? '';
    case 'duration': return hiDuration(v);
  }
}

// ---------- templates ----------

const EN_LEAD: Record<FieldId, string> = {
  premium: 'Premium (the amount you pay for the policy)',
  sum_insured: 'Sum insured (the maximum cover amount)',
  copay: 'Co-payment (the share of a claim you pay yourself)',
  deductible: 'Deductible (the amount you pay before the insurer pays)',
  room_rent: 'Room rent limit',
  sub_limit: 'Sub-limit (a cap on a specific treatment)',
  exclusion: 'Exclusion',
  waiting_period: 'Waiting period',
};
const HI_LEAD: Record<FieldId, string> = {
  premium: 'प्रीमियम (पॉलिसी के लिए आपके द्वारा दी जाने वाली राशि)',
  sum_insured: 'बीमित राशि (अधिकतम कवर राशि)',
  copay: 'को-पेमेंट (क्लेम की राशि में आपका अपना हिस्सा)',
  deductible: 'डिडक्टिबल (वह राशि जो बीमा कंपनी के भुगतान से पहले आपको स्वयं देनी होती है)',
  room_rent: 'कमरे के किराये की सीमा',
  sub_limit: 'उप-सीमा (किसी विशेष इलाज पर अधिकतम राशि)',
  exclusion: 'बहिष्करण',
  waiting_period: 'प्रतीक्षा अवधि',
};
const HI_WAIT: Record<string, string> = {
  initial: 'प्रारंभिक प्रतीक्षा अवधि',
  pre_existing: 'पहले से मौजूद बीमारियों की प्रतीक्षा अवधि',
  specific: 'विशिष्ट बीमारियों की प्रतीक्षा अवधि',
  maternity: 'मातृत्व लाभ की प्रतीक्षा अवधि',
};
const HI_ITEMS: Record<string, string> = { 'cataract-surgery': 'मोतियाबिंद की सर्जरी', cataract: 'मोतियाबिंद की सर्जरी' };
const EN_WAIT: Record<string, string> = {
  initial: 'Initial waiting period',
  pre_existing: 'Waiting period for pre-existing diseases',
  specific: 'Waiting period for specific illnesses',
  maternity: 'Waiting period for maternity',
};

function line(i: ExplainItem, lang: ExplanationLang): string {
  const o = renderValue(i.old, lang);
  const n = renderValue(i.new, lang);
  if (lang === 'hi') {
    if (i.field === 'exclusion') {
      return `नया बहिष्करण (जिन बातों को पॉलिसी में शामिल नहीं दिखाया गया है): "${i.itemLabel}" (दस्तावेज़ में यह अंग्रेज़ी में लिखा है)।`;
    }
    let lead = HI_LEAD[i.field];
    if (i.field === 'sub_limit') lead = `उप-सीमा (${HI_ITEMS[i.item] ?? i.itemLabel})`;
    if (i.field === 'waiting_period') lead = HI_WAIT[i.item] ?? `${HI_LEAD.waiting_period}: ${i.itemLabel}`;
    return `${lead}: पहले ${o}, अब ${n}।`;
  }
  if (i.field === 'exclusion') {
    return `New exclusion (something the document shows the policy does not include): "${i.itemLabel}".`;
  }
  let lead = EN_LEAD[i.field];
  if (i.field === 'sub_limit') lead = `Sub-limit for ${i.itemLabel} (a cap on this treatment)`;
  if (i.field === 'waiting_period') lead = EN_WAIT[i.item] ?? `Waiting period (${i.itemLabel})`;
  return `${lead}: the document shows ${o} before and ${n} now.`;
}

const fmtDateEn = (iso: string) => {
  const [y, m, d] = iso.split('-');
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m) - 1] ?? m;
  return `${d} ${mon} ${y}`;
};
const fmtDateHi = (iso: string) => iso.split('-').reverse().join('/');

export function buildExplanation(findings: ExplainFinding[], lang: ExplanationLang): Explanation {
  const { changes, clarifications } = selectExplainItems(findings);
  const ctx = findings.map(attrsOf).find((a) => a.policyholder || a.product) ?? {};
  const name = ctx.policyholder ?? (lang === 'hi' ? 'पॉलिसीधारक' : 'Policyholder');
  const product = ctx.product ?? '';
  const p = ctx.renewal_period;
  const out: string[] = [];

  if (lang === 'hi') {
    const period = p ? ` (${fmtDateHi(p.start)} से ${fmtDateHi(p.end)})` : '';
    out.push('मसौदा (ड्राफ़्ट): यह संदेश अभी ग्राहक को भेजने के लिए नहीं है। भेजने से पहले किसी अधिकृत व्यक्ति की मंज़ूरी ज़रूरी है।', '');
    out.push(`प्रिय ${name},`, '');
    out.push(`आपकी ${product ? `"${product}" ` : ''}पॉलिसी के नवीनीकरण${period} के दस्तावेज़ों में हमें नीचे दिए गए बदलाव दिखे हैं। कृपया इन्हें ध्यान से पढ़ें।`, '');
    if (changes.length) {
      out.push('बदलाव:');
      changes.forEach((c, n) => out.push(`${n + 1}. ${line(c, lang)}`));
    } else out.push('दस्तावेज़ों में हमें ऐसा कोई बदलाव पुष्ट नहीं दिखा जिसे बताना ज़रूरी हो।');
    if (clarifications.length) {
      out.push('', 'इन बातों पर हम बीमा कंपनी से स्पष्टीकरण ले रहे हैं, इसलिए अभी इन्हें पक्का बदलाव न मानें:');
      clarifications.forEach((c) => out.push(`- ${HI_LEAD[c.field].split(' (')[0]}${c.itemLabel && c.field !== 'exclusion' ? ` (${c.itemLabel})` : ''}`));
    }
    out.push('', 'कृपया हर बदलाव के बारे में हमें बताएँ कि आपने उसे पढ़ और समझ लिया है। यह सारांश केवल दस्तावेज़ों में दिखाई गई जानकारी पर आधारित है; क्लेम स्वीकार होगा या नहीं, यह निर्णय बीमा कंपनी का होता है। कोई प्रश्न हो तो कृपया अपने सलाहकार से संपर्क करें।', '', 'धन्यवाद।');
  } else {
    const period = p ? ` (${fmtDateEn(p.start)} to ${fmtDateEn(p.end)})` : '';
    out.push('DRAFT - for internal review only. Do not send to the customer until a supervisor has approved this text.', '');
    out.push(`Dear ${name},`, '');
    out.push(`We compared the documents for the renewal${period} of your${product ? ` "${product}"` : ''} policy with your current policy. The documents show the changes below. Please read them carefully.`, '');
    if (changes.length) {
      out.push('Changes:');
      changes.forEach((c, n) => out.push(`${n + 1}. ${line(c, lang)}`));
    } else out.push('We did not find any confirmed change in the documents that needs to be explained.');
    if (clarifications.length) {
      out.push('', 'We are asking the insurer to clarify the points below, so please do not treat them as confirmed changes yet:');
      clarifications.forEach((c) => out.push(`- ${FIELD_LABEL[c.field]}${c.itemLabel && c.field !== 'exclusion' ? ` (${c.itemLabel})` : ''}`));
    }
    out.push('', 'Please tell us for each change that you have read and understood it. This summary is based only on what the documents show; whether a claim is accepted is the insurer\'s decision. If you have any question, please contact your advisor.', '', 'Thank you.');
  }

  const text = out.join('\n');
  const version = `${TEMPLATE_VERSION}-${lang}:${createHash('sha256').update(text).digest('hex').slice(0, 12)}`;
  return { lang, text, version, changes, clarifications };
}
