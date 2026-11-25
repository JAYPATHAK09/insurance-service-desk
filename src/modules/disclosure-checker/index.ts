import { createHash } from 'node:crypto';
import {
  CLASSIFICATIONS,
  type DocumentRecord,
  type Finding,
  type ModelRequest,
  type ModuleEngine,
} from '@/lib/contracts';
import { registerSyntheticHandler, runModelTask } from '@/lib/model';
import { compareDocs, type Comparison, type DocLevelIssue } from './compare';
import { detectRole, normName, parseDoc, type DocRole, type ParsedDoc } from './parse';

export const DISCLOSURE_TASK = 'disclosure-checker.compare';
export const PROMPT_VERSION = 'disclosure-checker-1';

export const NEVER_COMPLETES_STATEMENT =
  'The advisor and customer decide the answers; this tool never completes medical answers.';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** Stable per (member, question id, both document hashes): retries and re-runs give the same key. */
export function stableKey(memberName: string, qid: string, customerSha: string, proposalSha: string): string {
  return 'dc:' + sha(`${normName(memberName)}|${qid.toUpperCase()}|${customerSha}|${proposalSha}`).slice(0, 24);
}

const docKey = (type: string, ref: string, shas: string[]) =>
  'dc:doc:' + sha(`${type}|${ref}|${[...shas].sort().join(',')}`).slice(0, 24);

// ---------------------------------------------------------------- pre-checks (deterministic, both modes)

type Prep = { ok: true; customer: ParsedDoc; proposal: ParsedDoc; duplicatesCollapsed: number } | { ok: false; findings: Finding[] };

function docFinding(type: string, ref: string, shas: string[], summary: string, nextAction: string, attributes: Record<string, unknown> = {}): Finding {
  return {
    key: docKey(type, ref, shas),
    type,
    classification: 'ambiguous',
    summary,
    evidence: [],
    suggestedOwner: 'Advisor',
    nextAction,
    attributes: { ...attributes, refused_comparison: true, doc_hashes: shas, statement: NEVER_COMPLETES_STATEMENT },
  };
}

const signature = (d: ParsedDoc) =>
  JSON.stringify([
    d.insuredName && normName(d.insuredName),
    d.members.map((m) => [m.nameKey, m.relation, [...m.rows.entries()].map(([q, rows]) => [q, rows.map((r) => [r.question, r.answer, r.date])])]),
  ]);

export function prepare(docs: DocumentRecord[]): Prep {
  const allShas = docs.map((d) => d.sha256);
  const failed = docs.filter((d) => d.pages.some((p) => p.ocr_status === 'failed'));
  if (failed.length) {
    return {
      ok: false,
      findings: failed.map((d) =>
        docFinding(
          'unreadable_document',
          d.sha256,
          allShas,
          `${d.filename}: ${d.pages.filter((p) => p.ocr_status === 'failed').length} page(s) could not be read (OCR failed). Nothing was compared, and no answers were assumed.`,
          'Obtain a legible copy or re-key the page, then upload it. Do not complete answers from memory.',
          { filename: d.filename },
        ),
      ),
    };
  }

  const byRole: Record<DocRole, ParsedDoc[]> = { customer: [], proposal: [] };
  const conflicts: Finding[] = [];
  for (const d of docs) {
    const { role, conflict } = detectRole(d);
    if (conflict) {
      conflicts.push(
        docFinding('document_role_conflict', d.sha256, allShas, `${d.filename}: the upload type and the document's own heading disagree about whether it is the customer confirmation or the proposal.`, 'Re-upload with the correct type.', { filename: d.filename }),
      );
    } else if (role) byRole[role].push(parseDoc(d, role));
  }
  if (conflicts.length) return { ok: false, findings: conflicts };

  const missing = (['customer', 'proposal'] as const).filter((r) => byRole[r].length === 0);
  if (missing.length) {
    return {
      ok: false,
      findings: missing.map((r) =>
        docFinding(
          'missing_document',
          r,
          allShas,
          r === 'customer' ? 'No customer-confirmed disclosure was found in this case, so nothing can be compared.' : 'No draft proposal was found in this case, so nothing can be compared.',
          r === 'customer' ? 'Upload the call record or confirmation form (type: disclosure).' : 'Upload the draft proposal (type: proposal).',
          { missing_role: r },
        ),
      ),
    };
  }

  let collapsed = 0;
  const pick: Partial<Record<DocRole, ParsedDoc>> = {};
  const versionFindings: Finding[] = [];
  for (const r of ['customer', 'proposal'] as const) {
    const list = byRole[r];
    if (new Set(list.map(signature)).size > 1) {
      versionFindings.push(
        docFinding('multiple_versions', r, allShas, `Several different ${r === 'customer' ? 'customer confirmations' : 'draft proposals'} were uploaded with different answers. It is unclear which is current, so nothing was compared.`, 'Keep only the current version in the case, or decide with the customer which one applies.', { role: r, versions: list.length }),
      );
    }
    collapsed += list.length - 1; // content-identical copies count as one document
    pick[r] = list[0];
  }
  if (versionFindings.length) return { ok: false, findings: versionFindings };
  const customer = pick.customer!;
  const proposal = pick.proposal!;

  const shas = [customer.sha256, proposal.sha256];
  if (!customer.insuredName || !proposal.insuredName) {
    return {
      ok: false,
      findings: [docFinding('insured_unverified', 'name', shas, 'The insured person is not stated in both documents, so it cannot be confirmed that they concern the same person. Nothing was compared.', 'Add the insured person to the document or upload the right pair.')],
    };
  }
  const reasons: string[] = [];
  if (normName(customer.insuredName) !== normName(proposal.insuredName)) reasons.push('name');
  if (customer.dob && proposal.dob && normName(customer.dob) !== normName(proposal.dob)) reasons.push('date of birth');
  if (customer.reference && proposal.reference && normName(customer.reference) !== normName(proposal.reference)) reasons.push('reference');
  if (reasons.length) {
    return {
      ok: false,
      findings: [
        docFinding(
          'insured_mismatch',
          'insured',
          shas,
          `The customer confirmation (insured: ${customer.insuredName}) and the proposal (insured: ${proposal.insuredName}) do not match on ${reasons.join(', ')}. They are not compared.`,
          'Check that both documents belong to the same insured person and the same proposal.',
          { customer_insured: customer.insuredName, proposal_insured: proposal.insuredName, mismatch_on: reasons },
        ),
      ],
    };
  }
  return { ok: true, customer, proposal, duplicatesCollapsed: collapsed };
}

// ---------------------------------------------------------------- model-shaped output

interface Raw {
  key: string;
  type: string;
  classification: string;
  summary: string;
  evidence: Array<{ doc_id: string; page: number; quote: string }>;
  suggested_owner: string;
  next_action: string;
  attributes: Record<string, unknown>;
}

function comparisonToRaw(c: Comparison): Raw {
  const evidence = [c.customer, c.proposal].filter((s): s is NonNullable<typeof s> => !!s).map((s) => ({ doc_id: s.docId, page: s.page, quote: s.quote }));
  return {
    key: `${normName(c.member)}|${c.qid}`,
    type: c.type,
    classification: c.classification,
    summary: c.summary,
    evidence,
    suggested_owner: 'Advisor',
    next_action: c.nextAction,
    attributes: {
      member: c.member,
      relation: c.relation,
      question_id: c.qid,
      question: c.question,
      customer_answer: c.customer?.answer ?? null,
      customer_answer_kind: c.customer?.kind ?? 'absent',
      customer_date: c.customer?.date ?? null,
      customer_page: c.customer?.page ?? null,
      customer_doc_id: c.customer?.docId ?? null,
      proposal_answer: c.proposal?.answer ?? null,
      proposal_answer_kind: c.proposal?.kind ?? 'absent',
      proposal_date: c.proposal?.date ?? null,
      proposal_page: c.proposal?.page ?? null,
      proposal_doc_id: c.proposal?.docId ?? null,
      similar_members: c.similarMembers,
      source: 'rule_check',
    },
  };
}

function issueToRaw(i: DocLevelIssue): Raw {
  return {
    key: `issue|${i.type}|${i.ref}`,
    type: i.type,
    classification: 'ambiguous',
    summary: i.summary,
    evidence: i.evidence ? [{ doc_id: i.evidence.docId, page: i.evidence.page, quote: i.evidence.quote }] : [],
    suggested_owner: 'Advisor',
    next_action: i.nextAction,
    attributes: { source: 'rule_check', issue: true },
  };
}

/** Synthetic handler: a pure function of the (delimited) document pages. */
export function syntheticHandler(req: ModelRequest) {
  const parsed: Partial<Record<DocRole, ParsedDoc>> = {};
  for (const d of req.documents) {
    const role: DocRole | null = d.name.startsWith('customer_confirmation') ? 'customer' : d.name.startsWith('draft_proposal') ? 'proposal' : null;
    if (!role) continue;
    parsed[role] = parseDoc({ id: d.id, sha256: '', filename: d.name, pages: d.pages.map((p) => ({ page: p.page, text: p.text, ocr_status: 'not_needed' as const })) }, role);
  }
  if (!parsed.customer || !parsed.proposal) return { findings: [] };
  const res = compareDocs(parsed.customer, parsed.proposal);
  return { findings: [...res.comparisons.map(comparisonToRaw), ...res.issues.map(issueToRaw)] };
}
registerSyntheticHandler(DISCLOSURE_TASK, syntheticHandler);

const INSTRUCTIONS = [
  'Compare the customer_confirmation document with the draft_proposal document for the same insured person, member by member and question by question.',
  'Rows have the form: Q<n> | question | answer | date. Members are introduced by "MEMBER: <name> (<relation>)".',
  'Match members only by exactly the same name. Similar names (Rohan vs Rohit, same surname with an initial) are different people: never merge them.',
  'Classify each difference as one of: omission (customer-confirmed answer has no entry in the proposal), contradiction (the two answers conflict),',
  'unanswered (proposal field is blank; a blank is NOT "No"), explicit_negative (proposal says an explicit "No" that the customer record does not confirm), ambiguous (cannot be compared safely).',
  'Do not report matches. Never infer a diagnosis, never fill in a missing answer, never treat one condition as another.',
  'Each finding: key, type, classification, summary, evidence [{doc_id, page, quote}] with quotes copied verbatim from the cited page (the whole Q row),',
  'attributes {member, relation, question_id, question, customer_answer, customer_date, proposal_answer, proposal_date}. Output JSON {"findings": [...]} only.',
].join('\n');

export function buildRequest(customer: ParsedDoc, proposal: ParsedDoc, docs: DocumentRecord[]): ModelRequest {
  const pageList = (id: string) => docs.find((d) => d.id === id)!.pages.map((p) => ({ page: p.page, text: p.text }));
  return {
    task: DISCLOSURE_TASK,
    promptVersion: PROMPT_VERSION,
    instructions: INSTRUCTIONS,
    documents: [
      { id: customer.docId, name: `customer_confirmation ${customer.filename}`, pages: pageList(customer.docId) },
      { id: proposal.docId, name: `draft_proposal ${proposal.filename}`, pages: pageList(proposal.docId) },
    ],
  };
}

/**
 * Re-key every finding and use the rule check as a guard on whatever the model returned:
 * - a finding the rules do not support, or classify differently, is downgraded to ambiguous (original kept)
 * - a difference the rules found but the model missed is added from the rule check
 * - document-level `issue` findings (unreadable, mismatch, missing, ...) come ONLY from the rule engine:
 *   any the model returns are dropped, because a model must not be able to raise or fake one
 * - the answer, date, page and member attributes always come from the rule comparison, never from model output
 * So a live model can add explanation but cannot invent or soften a discrepancy.
 */
const RULE_OWNED_ATTRS = [
  'member', 'relation', 'question_id', 'question',
  'customer_answer', 'customer_answer_kind', 'customer_date', 'customer_page', 'customer_doc_id',
  'proposal_answer', 'proposal_answer_kind', 'proposal_date', 'proposal_page', 'proposal_doc_id',
  'similar_members', 'source',
] as const;
const isIssueFinding = (f: Finding) => f.attributes?.issue === true || f.key.startsWith('issue|');

export function finalise(model: Finding[], customer: ParsedDoc, proposal: ParsedDoc): Finding[] {
  const res = compareDocs(customer, proposal);
  const shas = [customer.sha256, proposal.sha256];
  const expected = new Map(res.comparisons.map((c) => [`${normName(c.member)}|${c.qid}`, c]));
  const out: Finding[] = [];
  const used = new Set<string>();
  const seen = new Set<string>();
  const uniq = (k: string) => {
    let n = k;
    for (let i = 2; seen.has(n); i++) n = `${k}-${i}`;
    seen.add(n);
    return n;
  };
  const common = { doc_hashes: { customer: customer.sha256, proposal: proposal.sha256 }, statement: NEVER_COMPLETES_STATEMENT };

  for (const f of model) {
    if (isIssueFinding(f)) continue; // rule engine only (added below)
    // Model-supplied answers/dates are never trusted: without a matching rule row they are removed outright.
    const a = Object.fromEntries(
      Object.entries(f.attributes ?? {}).filter(([k]) => !/^(customer|proposal)_/.test(k) && k !== 'issue'),
    ) as Record<string, unknown>;
    const member = typeof a.member === 'string' ? a.member : '';
    const qid = typeof a.question_id === 'string' ? a.question_id.toUpperCase() : '';
    if (!member || !qid) {
      out.push({ ...f, key: uniq(docKey('unattributed', f.key, shas)), classification: 'ambiguous', attributes: { ...a, ...common, downgradedFrom: f.classification, downgradeReason: 'no_member_or_question' } });
      continue;
    }
    const ek = `${normName(member)}|${qid}`;
    const exp = expected.get(ek);
    used.add(ek);
    const key = uniq(stableKey(member, qid, customer.sha256, proposal.sha256));
    if (!exp) {
      out.push({ ...f, key, classification: 'ambiguous', attributes: { ...a, ...common, downgradedFrom: f.classification, downgradeReason: 'not_supported_by_rule_check' } });
    } else if (exp.classification !== f.classification) {
      out.push({ ...f, key, classification: 'ambiguous', attributes: { ...a, ...common, downgradedFrom: f.classification, downgradeReason: 'disagrees_with_rule_check' } });
    } else {
      const ruleAttrs = comparisonToRaw(exp).attributes;
      const owned = Object.fromEntries(RULE_OWNED_ATTRS.map((k) => [k, ruleAttrs[k]]));
      out.push({ ...f, key, attributes: { ...a, ...owned, ...common } });
    }
  }
  for (const c of res.comparisons) {
    const ek = `${normName(c.member)}|${c.qid}`;
    if (used.has(ek)) continue;
    const r = comparisonToRaw(c);
    out.push({
      key: uniq(stableKey(c.member, c.qid, customer.sha256, proposal.sha256)),
      type: r.type,
      classification: r.classification,
      summary: r.summary,
      evidence: r.evidence.map((e) => ({ ...e, verified: false })),
      suggestedOwner: r.suggested_owner,
      nextAction: r.next_action,
      attributes: { ...r.attributes, ...common },
    });
  }
  for (const i of res.issues) {
    const r = issueToRaw(i);
    out.push({
      key: uniq(docKey(i.type, r.key, shas)),
      type: r.type,
      classification: 'ambiguous',
      summary: r.summary,
      evidence: r.evidence.map((e) => ({ ...e, verified: false })),
      suggestedOwner: r.suggested_owner,
      nextAction: r.next_action,
      attributes: { ...r.attributes, ...common },
    });
  }
  return out;
}

export const disclosureChecker: ModuleEngine = {
  id: 'disclosure-checker',
  label: 'Proposal Disclosure Checker',
  promptVersion: PROMPT_VERSION,
  classifications: CLASSIFICATIONS['disclosure-checker'],
  route: '/cases/{id}/disclosure-checker',
  async run(_caseId, docs, provider) {
    const prep = prepare(docs);
    if (!prep.ok) return prep.findings; // refuse: never send a mismatched or unreadable pair to any model
    const req = buildRequest(prep.customer, prep.proposal, docs);
    const modelFindings = await runModelTask(provider, req, CLASSIFICATIONS['disclosure-checker']);
    return finalise(modelFindings, prep.customer, prep.proposal);
  },
};
