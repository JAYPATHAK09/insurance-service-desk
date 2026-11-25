import { createHash } from 'node:crypto';
import { typeLabel } from './parse';

export interface DraftItem {
  n: number;
  itemType: string;
  itemText: string;
  classification: string;
  /** open | accepted | overridden | dismissed */
  status: string;
  nextAction?: string | null;
  submissionRefs: string[];
}

export interface DraftInput {
  insurer: string;
  reference: string;
  queryRef?: string | null;
  queryDate?: string | null;
  items: DraftItem[];
}

export const DRAFT_BANNER = 'DRAFT - NOT SENT. Requires explicit handler approval. This system never sends messages.';

const refs = (i: DraftItem) => (i.submissionRefs.length ? i.submissionRefs.join(', ') : 'the reference to be confirmed');

function itemParagraph(i: DraftItem): string {
  const label = typeLabel(i.itemType);
  const head = `${i.n}. ${i.itemText.replace(/\s+/g, ' ').slice(0, 200)}`;
  const tag = i.status === 'open' ? ' [UNREVIEWED]' : '';
  const act = i.nextAction ? i.nextAction.replace(/\s+/g, ' ') : 'handler to decide';
  switch (i.classification) {
    case 'satisfied_pending_verification':
      return `${head}${tag}\n   We refer to the ${label} submitted under reference ${refs(i)}.\n   [HANDLER TO VERIFY before sending: confirm it is the document asked for. Whether it is sufficient is for the insurer to say.]`;
    case 'repeated_request':
      return `${head}${tag}\n   Our records show this item was requested in your earlier query and submitted under reference ${refs(i)}. Kindly tell us whether anything further is needed and, if so, what.\n   [HANDLER TO VERIFY the earlier submission before sending.]`;
    case 'partially_satisfied':
      return `${head}${tag}\n   [HANDLER TO COMPLETE: what is being sent, and when. Issue found: ${act}]`;
    case 'missing':
      return `${head}${tag}\n   [HANDLER TO COMPLETE: the document is not yet on file. ${act}]`;
    default:
      return `${head}${tag}\n   [HANDLER TO RESOLVE before any statement is made: ${act}]`;
  }
}

/** Plain-text response draft. Statements about the claim outcome are never generated. */
export function buildDraft(input: DraftInput): { body: string; hash: string } {
  const items = input.items.filter((i) => i.status !== 'dismissed').sort((a, b) => a.n - b.n);
  const dismissed = input.items.filter((i) => i.status === 'dismissed').map((i) => i.n);
  const lines = [
    `To: Claims team, ${input.insurer}`,
    `Re: Claim ${input.reference}${input.queryRef ? ` - your query ${input.queryRef}` : ''}${input.queryDate ? ` dated ${input.queryDate}` : ''}`,
    '',
    'Dear Sir/Madam,',
    '',
    'We refer to your query. Our response to each item is below.',
    '',
    ...items.flatMap((i) => [itemParagraph(i), '']),
    ...(dismissed.length ? [`[Item(s) ${dismissed.join(', ')} set aside by the handler and not addressed here.]`, ''] : []),
    'Kindly acknowledge receipt.',
    '',
    'Regards,',
    '[Handler name and contact: to be completed]',
  ];
  const body = lines.join('\n');
  return { body, hash: createHash('sha256').update(body).digest('hex') };
}

export interface ApprovalInfo {
  by: string;
  at: string;
}
export interface DraftStatus {
  status: 'draft' | 'ready';
  handler?: ApprovalInfo;
  supervisor?: ApprovalInfo;
}

/** The approval is tied to the exact text: any change to the findings produces a new hash and returns it to DRAFT. */
export function draftStatus(
  hash: string,
  approvals: Array<{ action: string; actor: string; at: string; draftHash: unknown }>,
): DraftStatus {
  const pick = (action: string) => {
    const a = approvals.filter((x) => x.action === action && x.draftHash === hash).sort((p, q) => q.at.localeCompare(p.at))[0];
    return a ? { by: a.actor, at: a.at } : undefined;
  };
  const handler = pick('claim.draft_approved');
  return { status: handler ? 'ready' : 'draft', handler, supervisor: handler ? pick('claim.draft_supervisor_approved') : undefined };
}

/** Text as downloaded: the status line comes first and is not part of the hashed body. */
export function draftDocument(body: string, st: DraftStatus): string {
  const status = st.status === 'ready' ? `STATUS: READY (approved by handler ${st.handler!.by}). Still NOT SENT: send it yourself, outside this system.` : `STATUS: ${DRAFT_BANNER}`;
  return `${status}\n\n${body}\n`;
}
