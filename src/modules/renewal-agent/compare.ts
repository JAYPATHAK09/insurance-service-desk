import {
  extractHeader,
  extractStatements,
  normPolicyNo,
  pageLines,
  pageStatus,
  sameName,
  sameProduct,
  type Header,
  type PageStatus,
} from './extract';
import { addDays, describeValue, normText, textSimilar, valueCanon, scopeCanon } from './parse';
import {
  FIELD_LABEL,
  LIST_FIELDS,
  ROLE_LABEL,
  isMaterialField,
  type DocRole,
  type FieldId,
  type RoleDoc,
  type Src,
  type Stmt,
  type Value,
} from './types';

/** A finding in the model-output shape (snake_case), as SyntheticProvider handlers return it. */
export interface RawFinding {
  key: string;
  type: string;
  classification: string;
  summary: string;
  evidence: Array<{ doc_id: string; page: number; quote: string }>;
  suggested_owner?: string;
  next_action?: string;
  attributes?: Record<string, unknown>;
}

const ROLE_ORDER: Record<DocRole, number> = { policy_schedule: 0, endorsement: 1, renewal_proposal: 2 };

/** Deterministic ordering and stable tags (role, role-2, ...). */
export function tagDocs(docs: Array<Omit<RoleDoc, 'tag'>>): RoleDoc[] {
  const sorted = [...docs].sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.filename.localeCompare(b.filename));
  const seen: Record<string, number> = {};
  return sorted.map((d) => {
    seen[d.role] = (seen[d.role] ?? 0) + 1;
    const short = d.role === 'policy_schedule' ? 'schedule' : d.role === 'renewal_proposal' ? 'renewal' : 'endorsement';
    return { ...d, tag: seen[d.role] === 1 ? short : `${short}-${seen[d.role]}` };
  });
}

const srcOut = (s: Src) => ({
  role: s.role,
  filename: s.filename,
  doc_id: s.docId,
  page: s.page,
  quote: s.quote,
  ...(s.endorsementNo ? { endorsement_no: s.endorsementNo } : {}),
});
const ev = (s: Src) => ({ doc_id: s.docId, page: s.page, quote: s.quote });
const dedupeEv = (list: Array<{ doc_id: string; page: number; quote: string }>) => {
  const seen = new Set<string>();
  return list.filter((e) => {
    const k = `${e.doc_id}|${e.page}|${e.quote}`;
    return seen.has(k) ? false : (seen.add(k), true);
  });
};
const docLabel = (d: RoleDoc) => (d.tag.includes('-') ? `${ROLE_LABEL[d.role]} (${d.tag.split('-').pop()})` : ROLE_LABEL[d.role]);

// ---------- page-level findings ----------

function pageFindings(docs: RoleDoc[]): { findings: RawFinding[]; status: Map<string, PageStatus> } {
  const out: RawFinding[] = [];
  const status = new Map<string, PageStatus>();
  for (const d of docs) {
    const st = pageStatus(d);
    status.set(d.id, st);
    for (const p of st.failedPages) {
      out.push({
        key: `ocr:${d.tag}:p${p}`,
        type: 'document_page',
        classification: 'ocr_failure',
        summary: `Page ${p} of the ${docLabel(d)} could not be read (OCR failed). Terms on that page cannot be compared, so no change is asserted from it.`,
        evidence: [],
        suggested_owner: 'Handler',
        next_action: 'Request a legible copy or key in the page manually, then re-run the review.',
        attributes: { role: d.role, filename: d.filename, doc_id: d.id, page: p, material: false, may_affect_material_terms: true },
      });
    }
    for (const n of st.missingPages) {
      out.push({
        key: `absent:${d.tag}:p${n}`,
        type: 'document_page',
        classification: 'absent_page',
        summary: `The ${docLabel(d)} is marked as ${st.declaredTotal} pages but page ${n} is not in the uploaded file. Terms on it cannot be compared, so no change is asserted from it.`,
        evidence: st.proof ? [{ doc_id: d.id, page: st.proof.page, quote: st.proof.quote }] : [],
        suggested_owner: 'Handler',
        next_action: `Ask the insurer for the complete document including page ${n}.`,
        attributes: { role: d.role, filename: d.filename, doc_id: d.id, missing_page: n, declared_total: st.declaredTotal, material: false, may_affect_material_terms: true },
      });
    }
  }
  return { findings: out, status };
}

// ---------- pair check ----------

const fmtPeriod = (p: { start: string; end: string }) => `${p.start} to ${p.end}`;

function pairFindings(docs: RoleDoc[], headers: Map<string, Header>): RawFinding[] {
  const out: RawFinding[] = [];
  const schedules = docs.filter((d) => d.role === 'policy_schedule');
  const endorsements = docs.filter((d) => d.role === 'endorsement');
  const renewals = docs.filter((d) => d.role === 'renewal_proposal');
  const hdr = (d: RoleDoc) => headers.get(d.id)!;

  // Unverifiable headers: cannot show it is the same policyholder / product / period.
  for (const d of docs) {
    const h = hdr(d);
    const need: Array<[string, unknown]> = [['policyholder', h.policyholder], ['period', h.period]];
    if (d.role !== 'endorsement') need.push(['product', h.product]);
    const missing = need.filter(([, v]) => !v).map(([k]) => k);
    if (!missing.length) continue;
    const unreadable = d.pages.some((p) => p.failed);
    out.push({
      key: `pair:${unreadable ? 'unreadable' : 'unverifiable'}:${d.tag}`,
      type: 'document_pair',
      classification: unreadable ? 'ocr_failure' : 'ambiguous',
      summary: `Could not confirm the ${missing.join(', ')} on the ${docLabel(d)}${unreadable ? ' because a page could not be read' : ' (not found in the document)'}. The documents cannot be shown to belong together, so no terms were compared.`,
      evidence: [],
      suggested_owner: 'Handler',
      next_action: 'Check the document pair manually, then re-run the review.',
      attributes: { material: false, missing_header_fields: missing, role: d.role, diff_refused: true },
    });
  }
  if (out.length) return out;

  const base = schedules[0]!;
  const bh = hdr(base);
  const mismatch = (field: string, d: RoleDoc, a: Src, b: Src, av: string, bv: string, why?: string) =>
    out.push({
      key: `pair:${field}:${d.tag}`,
      type: 'document_pair',
      classification: 'mismatched_pair',
      summary: `Document shows a different ${field.replace(/_/g, ' ')}: "${av}" in the ${docLabel(base)} but "${bv}" in the ${docLabel(d)}${why ? ` (${why})` : ''}. The documents may not belong together, so no terms were compared.`,
      evidence: dedupeEv([ev(a), ev(b)]),
      suggested_owner: 'Supervisor',
      next_action: 'Confirm with the insurer that these documents are for the same policyholder, product and period.',
      attributes: { material: false, field, diff_refused: true, compared: [srcOut(a), srcOut(b)] },
    });

  const others = docs.filter((d) => d !== base);
  for (const d of others) {
    const h = hdr(d);
    if (!sameName(bh.policyholder!.value, h.policyholder!.value))
      mismatch('policyholder', d, bh.policyholder!.src, h.policyholder!.src, bh.policyholder!.value, h.policyholder!.value);
    if (h.product && !sameProduct(bh.product!.value, h.product.value))
      mismatch('product', d, bh.product!.src, h.product.src, bh.product!.value, h.product.value);
    const bp = bh.period!.value;
    const p = h.period!.value;
    if (d.role === 'renewal_proposal') {
      const contiguous = p.start === addDays(bp.end, 1) || p.start === bp.end;
      if (!contiguous)
        mismatch('period', d, bh.period!.src, h.period!.src, fmtPeriod(bp), fmtPeriod(p), 'a renewal should start when the expiring period ends');
    } else if (p.start !== bp.start || p.end !== bp.end) {
      mismatch('period', d, bh.period!.src, h.period!.src, fmtPeriod(bp), fmtPeriod(p));
    }
    if (d.role === 'endorsement' && h.effective && (h.effective.value < bp.start || h.effective.value > bp.end))
      mismatch('effective_date', d, bh.period!.src, h.effective.src, fmtPeriod(bp), h.effective.value, 'endorsement effective outside the expiring period');
    const theirNo = d.role === 'renewal_proposal' ? h.priorPolicyNo : h.policyNo;
    if (theirNo && bh.policyNo && normPolicyNo(theirNo.value) !== normPolicyNo(bh.policyNo.value))
      mismatch('policy_number', d, bh.policyNo.src, theirNo.src, bh.policyNo.value, theirNo.value);
  }
  // Renewal copies must agree with each other too (checked against the first copy).
  for (const d of renewals.slice(1)) {
    const a = hdr(renewals[0]!);
    const b = hdr(d);
    if (!sameName(a.policyholder!.value, b.policyholder!.value) && !out.some((f) => f.key === `pair:policyholder:${d.tag}`))
      mismatch('policyholder', d, a.policyholder!.src, b.policyholder!.src, a.policyholder!.value, b.policyholder!.value);
  }
  return out;
}

// ---------- pooling ----------

interface Pooled {
  field: FieldId;
  item: string;
  itemLabel: string;
  value: Value;
  /** Sources that establish the value (schedule first, then overriding endorsements). */
  sources: Src[];
  /** Latest source: the one whose wording states the effective value. */
  latest: Src;
  viaEndorsements: string[];
  conflict?: { a: { value: Value; src: Src }; b: { value: Value; src: Src } };
}

const keyOf = (s: { field: FieldId; item: string }) => `${s.field}|${s.item}`;

function mergeCopay(a: Value & { kind: 'copay' }, b: Value & { kind: 'copay' }, override: boolean) {
  const byScope = new Map(a.entries.map((e) => [scopeCanon(e.scope), e]));
  let conflictWith: { percent: number } | null = null;
  for (const e of b.entries) {
    const k = scopeCanon(e.scope);
    const cur = byScope.get(k);
    if (cur && cur.percent !== e.percent && !override) conflictWith = cur;
    byScope.set(k, e);
  }
  return { value: { kind: 'copay', entries: [...byScope.values()] } as Value, conflict: conflictWith !== null };
}

function poolStatements(stmts: Stmt[]): Map<string, Pooled> {
  const pool = new Map<string, Pooled>();
  for (const s of stmts) {
    const k = keyOf(s);
    const cur = pool.get(k);
    if (!cur) {
      pool.set(k, { field: s.field, item: s.item, itemLabel: s.itemLabel, value: s.value, sources: [s.src], latest: s.src, viaEndorsements: [] });
      continue;
    }
    if (s.value.kind === 'copay' && cur.value.kind === 'copay') {
      const m = mergeCopay(cur.value, s.value, false);
      if (m.conflict) {
        cur.conflict ??= { a: { value: cur.value, src: cur.latest }, b: { value: s.value, src: s.src } };
        cur.sources.push(s.src);
      } else if (valueCanon(m.value) !== valueCanon(cur.value)) cur.sources.push(s.src);
      cur.value = m.value;
      continue;
    }
    if (valueCanon(cur.value) !== valueCanon(s.value)) {
      cur.conflict ??= { a: { value: cur.value, src: cur.latest }, b: { value: s.value, src: s.src } };
      cur.sources.push(s.src);
    }
  }
  return pool;
}

/** Apply endorsements to the schedule pool in date order; an endorsement overrides the schedule value. */
function applyEndorsements(base: Map<string, Pooled>, endorsements: RoleDoc[], headers: Map<string, Header>): Map<string, Pooled> {
  const ordered = endorsements
    .map((d) => ({ d, h: headers.get(d.id)! }))
    .sort((x, y) => (x.h.effective?.value ?? '').localeCompare(y.h.effective?.value ?? '') || (x.h.endorsementNo?.value ?? x.d.filename).localeCompare(y.h.endorsementNo?.value ?? y.d.filename));
  const lastSet = new Map<string, { date: string; canon: string; value: Value; src: Src }>();
  for (const { d, h } of ordered) {
    const no = h.endorsementNo?.value ?? d.tag;
    const date = h.effective?.value ?? '';
    const pool = poolStatements(extractStatements(d, no));
    for (const [k, p] of pool) {
      const cur = base.get(k);
      const prev = lastSet.get(k);
      if (prev && prev.date === date && prev.canon !== valueCanon(p.value)) {
        const target = cur ?? p;
        target.conflict ??= { a: { value: prev.value, src: prev.src }, b: { value: p.value, src: p.latest } };
        target.sources.push(p.latest);
        base.set(k, target);
        continue;
      }
      let value = p.value;
      if (cur && cur.value.kind === 'copay' && p.value.kind === 'copay') value = mergeCopay(cur.value, p.value, true).value;
      base.set(k, {
        field: p.field,
        item: p.item,
        itemLabel: p.itemLabel,
        value,
        sources: [...(cur?.sources ?? []), p.latest],
        latest: p.latest,
        viaEndorsements: [...(cur?.viaEndorsements ?? []), no],
        conflict: cur?.conflict,
      });
      lastSet.set(k, { date, canon: valueCanon(p.value), value: p.value, src: p.latest });
    }
  }
  return base;
}

// ---------- comparison ----------

interface Pair {
  field: FieldId;
  item: string;
  itemLabel: string;
  old?: Pooled;
  new?: Pooled;
  fuzzy?: boolean;
}

function matchPairs(oldPool: Map<string, Pooled>, newPool: Map<string, Pooled>): Pair[] {
  const pairs: Pair[] = [];
  const usedNew = new Set<string>();
  const unmatchedOld: Pooled[] = [];
  for (const [k, o] of oldPool) {
    const n = newPool.get(k);
    if (n) {
      pairs.push({ field: o.field, item: o.item, itemLabel: o.itemLabel, old: o, new: n });
      usedNew.add(k);
    } else unmatchedOld.push(o);
  }
  // Rephrased list items: pair by token similarity (same negations), exclusions and sub-limit names only.
  for (const o of unmatchedOld) {
    let hit: Pooled | undefined;
    if (o.field === 'exclusion' || o.field === 'sub_limit') {
      hit = [...newPool.entries()].find(([k, n]) => !usedNew.has(k) && n.field === o.field && textSimilar(o.itemLabel, n.itemLabel))?.[1];
    }
    if (hit) {
      usedNew.add(keyOf(hit));
      pairs.push({ field: o.field, item: o.item, itemLabel: o.itemLabel, old: o, new: hit, fuzzy: true });
    } else pairs.push({ field: o.field, item: o.item, itemLabel: o.itemLabel, old: o });
  }
  for (const [k, n] of newPool) if (!usedNew.has(k)) pairs.push({ field: n.field, item: n.item, itemLabel: n.itemLabel, new: n });
  const order = (f: FieldId) => ['premium', 'sum_insured', 'copay', 'deductible', 'room_rent', 'sub_limit', 'waiting_period', 'exclusion'].indexOf(f);
  return pairs.sort((a, b) => order(a.field) - order(b.field) || a.item.localeCompare(b.item));
}

const sideState = (docs: RoleDoc[], status: Map<string, PageStatus>) => {
  const failed: Array<{ tag: string; pages: number[] }> = [];
  const missing: Array<{ tag: string; pages: number[]; total: number | null }> = [];
  for (const d of docs) {
    const s = status.get(d.id)!;
    if (s.failedPages.length) failed.push({ tag: d.tag, pages: s.failedPages });
    if (s.missingPages.length) missing.push({ tag: d.tag, pages: s.missingPages, total: s.declaredTotal });
  }
  return { failed, missing, incomplete: failed.length > 0 || missing.length > 0 };
};

const sideValue = (p?: Pooled) =>
  p
    ? {
        display: p.field === 'exclusion' ? p.itemLabel : describeValue(p.value),
        value: p.value,
        sources: p.sources.map(srcOut),
        ...(p.viaEndorsements.length ? { via_endorsements: p.viaEndorsements } : {}),
      }
    : null;

export interface Context {
  policyholder?: string;
  product?: string;
  renewalPeriod?: { start: string; end: string };
  expiringPeriod?: { start: string; end: string };
}

function compareField(
  pair: Pair,
  oldSide: ReturnType<typeof sideState>,
  newSide: ReturnType<typeof sideState>,
  ctx: Context,
): RawFinding {
  const { field, old: o, new: n } = pair;
  const label = FIELD_LABEL[field] + (pair.item && field !== 'exclusion' ? ` (${pair.itemLabel})` : '');
  const key = `renewal:${field}${pair.item ? ':' + pair.item : ''}`;
  const incomplete = oldSide.incomplete || newSide.incomplete;
  const od = o ? (field === 'exclusion' ? o.itemLabel : describeValue(o.value)) : '';
  const nd = n ? (field === 'exclusion' ? n.itemLabel : describeValue(n.value)) : '';
  const via = o?.viaEndorsements.length ? ` (as revised by endorsement ${o.viaEndorsements.join(', ')})` : '';

  const base = {
    key,
    type: field,
    attributes: {
      field,
      item: pair.item,
      item_label: pair.itemLabel,
      label,
      material: isMaterialField(field),
      old: sideValue(o),
      new: sideValue(n),
      incomplete_document: incomplete,
      policyholder: ctx.policyholder,
      product: ctx.product,
      renewal_period: ctx.renewalPeriod,
      expiring_period: ctx.expiringPeriod,
    } as Record<string, unknown>,
  };
  const evidence = dedupeEv([...(o?.sources ?? []), ...(n?.sources ?? [])].map(ev));
  const mk = (classification: string, summary: string, extra: { next_action?: string; owner?: string; attrs?: Record<string, unknown>; ev?: typeof evidence } = {}): RawFinding => ({
    key: base.key,
    type: base.type,
    classification,
    summary,
    evidence: extra.ev ?? evidence,
    suggested_owner: extra.owner ?? 'Handler',
    next_action: extra.next_action,
    attributes: { ...base.attributes, ...extra.attrs },
  });

  // Contradictory statements on either side: never decide.
  const conflicted = o?.conflict ?? n?.conflict;
  if (conflicted) {
    const c = conflicted;
    const which = o?.conflict ? 'expiring terms' : 'renewal proposal';
    const d = (v: Value) => (field === 'exclusion' ? describeValue(v) : describeValue(v));
    return mk(
      'ambiguous',
      `Document shows two different values for ${label} in the ${which}: ${d(c.a.value)} (${where(c.a.src)}) and ${d(c.b.value)} (${where(c.b.src)}). The document does not say which applies.`,
      {
        owner: 'Supervisor',
        next_action: 'Ask the insurer which statement applies.',
        attrs: {
          reason: 'contradictory_statements',
          conflict: [srcOut(c.a.src), srcOut(c.b.src)],
          [o?.conflict ? 'old' : 'new']: {
            ...(o?.conflict ? sideValue(o) : sideValue(n)),
            display: `${describeValue(c.a.value)} / ${describeValue(c.b.value)} (conflicting)`,
          },
        },
        ev: dedupeEv([...evidence, ev(c.a.src), ev(c.b.src)]),
      },
    );
  }

  if (o && n) {
    const same = valueCanon(o.value) === valueCanon(n.value) || pair.fuzzy;
    if (same) {
      const rawSame = normText(o.latest.quote) === normText(n.latest.quote);
      if (rawSame && !pair.fuzzy) return mk('unchanged', `Document shows ${label} unchanged: ${nd}.`);
      return mk('rephrasing_only', `Document wording differs but the stated ${label} is the same (${nd})${via}.`);
    }
    // A value we could not read into a structured form (free text, noisy OCR, several amounts) is never a confirmed change.
    const freeText = (p: Pooled) => field !== 'exclusion' && (p.value.kind === 'text' || (p.value.kind === 'room' && p.value.mode === 'text'));
    if (freeText(o) || freeText(n)) {
      if (freeText(o) && freeText(n) && textSimilar(od, nd)) return mk('rephrasing_only', `Document wording differs but the stated ${label} is the same (${nd}).`);
      return mk('ambiguous', `Document shows ${label} as "${od}" in the expiring terms${via} and "${nd}" in the renewal proposal, but at least one value could not be read reliably, so no change is asserted.`, {
        next_action: 'Needs insurer clarification or a manual read of both lines.',
        attrs: { reason: 'value_not_machine_readable' },
      });
    }
    return mk(
      'confirmed_change',
      `Document shows ${label} as ${od} in the expiring terms${via} and ${nd} in the renewal proposal.`,
      { next_action: 'Reviewer to confirm, then explain the change to the customer.' },
    );
  }

  // One side missing: say why. Never confirm from an absent page or a failed OCR page.
  const missingSide = o ? newSide : oldSide;
  const sideName = o ? 'renewal proposal' : 'expiring terms';
  const present = o ?? n!;
  const presentDesc = field === 'exclusion' ? present.itemLabel : describeValue(present.value);
  if (missingSide.failed.length || missingSide.missing.length) {
    const ocr = missingSide.failed.length > 0;
    const pages = ocr
      ? missingSide.failed.map((f) => `page(s) ${f.pages.join(', ')}`).join('; ')
      : missingSide.missing.map((f) => `page(s) ${f.pages.join(', ')} of ${f.total}`).join('; ');
    return mk(
      ocr ? 'ocr_failure' : 'absent_page',
      `${label} is ${presentDesc} in the ${o ? 'expiring terms' : 'renewal proposal'}, but the ${sideName} ${ocr ? `has ${pages} that could not be read` : `is missing ${pages}`}. No change is asserted.`,
      {
        next_action: ocr ? 'Obtain a legible copy of the unreadable page and re-run the review.' : 'Ask the insurer for the complete document and re-run the review.',
        attrs: { reason: ocr ? 'ocr_failure_on_other_side' : 'absent_page_on_other_side', failed_pages: missingSide.failed, missing_pages: missingSide.missing },
      },
    );
  }
  if (n && !o && LIST_FIELDS.includes(field)) {
    return mk('confirmed_change', `Document shows a new ${label} in the renewal proposal: ${nd}. The expiring terms show no matching entry.`, {
      next_action: 'Reviewer to confirm, then explain the change to the customer.',
      attrs: { added: true },
    });
  }
  if (o) {
    return mk('ambiguous', `Document shows ${label} as ${od} in the expiring terms${via}; the renewal proposal does not state it. This could be a removal or an omission.`, {
      next_action: 'Needs insurer clarification: ask whether this term still applies.',
      attrs: { reason: 'not_stated_in_renewal', removed_or_omitted: true },
    });
  }
  return mk('ambiguous', `Document shows ${label} as ${nd} in the renewal proposal; the expiring terms do not state it.`, {
    next_action: 'Needs insurer clarification: ask whether this term is new.',
    attrs: { reason: 'not_stated_in_expiring_terms' },
  });
}

const where = (s: Src) => (s.endorsementNo ? `endorsement ${s.endorsementNo}, page ${s.page}` : `page ${s.page}`);

// ---------- entry point ----------

export interface Analysis {
  findings: RawFinding[];
  pairVerified: boolean;
  /** Page-level findings only (used by the live path, which merges them with model output). */
  pageFindings: RawFinding[];
  pairFindings: RawFinding[];
}

/** The whole deterministic pipeline: pages, pair check, then (only if the pair is verified) the term diff. */
export function analyse(input: Array<Omit<RoleDoc, 'tag'>>): Analysis {
  const docs = tagDocs(input);
  const { findings: pages, status } = pageFindings(docs);
  const schedules = docs.filter((d) => d.role === 'policy_schedule');
  const endorsements = docs.filter((d) => d.role === 'endorsement');
  const renewals = docs.filter((d) => d.role === 'renewal_proposal');

  if (!schedules.length || !renewals.length) {
    const f: RawFinding = {
      key: 'pair:missing-document',
      type: 'document_pair',
      classification: 'ambiguous',
      summary: `The case needs both an expiring policy schedule and a renewal proposal; ${!schedules.length ? 'no expiring schedule' : 'no renewal proposal'} was found among the uploaded documents (check the document kind).`,
      evidence: [],
      suggested_owner: 'Handler',
      next_action: 'Upload the missing document and set its kind, then re-run the review.',
      attributes: { material: false, diff_refused: true },
    };
    return { findings: [...pages, f], pairVerified: false, pageFindings: pages, pairFindings: [f] };
  }

  const headers = new Map(docs.map((d) => [d.id, extractHeader(d)]));
  const pair = pairFindings(docs, headers);
  if (pair.length) return { findings: [...pages, ...pair], pairVerified: false, pageFindings: pages, pairFindings: pair };

  const oldPool = applyEndorsements(poolStatements(schedules.flatMap((d) => extractStatements(d))), endorsements, headers);
  const newPool = poolStatements(renewals.flatMap((d) => extractStatements(d)));
  const sh = headers.get(schedules[0]!.id)!;
  const rh = headers.get(renewals[0]!.id)!;
  const ctx: Context = {
    policyholder: rh.policyholder?.value ?? sh.policyholder?.value,
    product: rh.product?.value ?? sh.product?.value,
    renewalPeriod: rh.period?.value,
    expiringPeriod: sh.period?.value,
  };
  const noTerms: RawFinding[] = [];
  for (const [pool, tag, what] of [[oldPool, 'expiring', 'expiring schedule'], [newPool, 'renewal', 'renewal proposal']] as const) {
    if (pool.size === 0) {
      noTerms.push({
        key: `terms:none-found:${tag}`,
        type: 'document_pair',
        classification: 'ambiguous',
        summary: `No recognisable policy terms (premium, sum insured, co-payment and so on) were found in the ${what}. It may be in an unsupported layout or language, so no comparison was made.`,
        evidence: [],
        suggested_owner: 'Handler',
        next_action: 'Read the document manually or obtain a text version.',
        attributes: { material: false, diff_refused: true },
      });
    }
  }
  if (noTerms.length) return { findings: [...pages, ...noTerms], pairVerified: true, pageFindings: pages, pairFindings: noTerms };
  const oldSide = sideState([...schedules, ...endorsements], status);
  const newSide = sideState(renewals, status);
  const terms = matchPairs(oldPool, newPool).map((p) => compareField(p, oldSide, newSide, ctx));
  return { findings: [...pages, ...terms], pairVerified: true, pageFindings: pages, pairFindings: [] };
}

export { pageLines };
