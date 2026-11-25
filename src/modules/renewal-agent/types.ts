/** Shared types for the Renewal Terms Change Agent. Pure types and constants. */

export const FIELDS = [
  'premium',
  'sum_insured',
  'copay',
  'deductible',
  'room_rent',
  'sub_limit',
  'exclusion',
  'waiting_period',
] as const;
export type FieldId = (typeof FIELDS)[number];

/** Every extracted field is a material term for the customer. */
export const MATERIAL_FIELDS: readonly FieldId[] = FIELDS;
export const isMaterialField = (f: string): boolean => (MATERIAL_FIELDS as readonly string[]).includes(f);

export const FIELD_LABEL: Record<FieldId, string> = {
  premium: 'Premium',
  sum_insured: 'Sum insured',
  copay: 'Co-payment',
  deductible: 'Deductible',
  room_rent: 'Room rent limit',
  sub_limit: 'Sub-limit',
  exclusion: 'Exclusion',
  waiting_period: 'Waiting period',
};

/** Items that are lists: a newly shown item is a change, a missing item is only ambiguous. */
export const LIST_FIELDS: readonly FieldId[] = ['exclusion', 'sub_limit', 'deductible', 'waiting_period'];

export const DOC_ROLES = ['policy_schedule', 'endorsement', 'renewal_proposal'] as const;
export type DocRole = (typeof DOC_ROLES)[number];
export const ROLE_LABEL: Record<DocRole, string> = {
  policy_schedule: 'Expiring schedule',
  endorsement: 'Endorsement',
  renewal_proposal: 'Renewal proposal',
};

export type Scope =
  | { type: 'all' }
  | { type: 'age_gte'; age: number }
  | { type: 'age_lt'; age: number }
  | { type: 'non_network' }
  | { type: 'text'; text: string };

export type Value =
  | { kind: 'money'; amount: number; basis?: string }
  | { kind: 'pct_si'; percent: number; basis?: string }
  | { kind: 'copay'; entries: Array<{ percent: number; scope: Scope }> }
  | { kind: 'room'; mode: 'pct_si' | 'amount_per_day' | 'none' | 'single_private' | 'text'; percent?: number; amount?: number; text?: string }
  | { kind: 'duration'; unit: 'days' | 'months'; n: number }
  | { kind: 'text'; text: string };

export interface Src {
  role: DocRole;
  docId: string;
  filename: string;
  page: number; // 1-based file page
  quote: string;
  endorsementNo?: string;
}

export interface Stmt {
  field: FieldId;
  /** '' for scalar fields; slug for list items. */
  item: string;
  /** Human label of the item (original casing) for display. */
  itemLabel: string;
  value: Value;
  src: Src;
}

export interface RoleDoc {
  id: string;
  filename: string;
  role: DocRole;
  /** Stable tag for keys: role, plus -2, -3 for further docs of the same role. */
  tag: string;
  pages: Array<{ page: number; text: string; failed: boolean }>;
}

export const RENEWAL_TASK = 'renewal-agent.compare';

/** decideFinding only knows accept | override | dismiss. "Needs insurer clarification" is an override whose note starts with this tag. */
export const CLARIFY_PREFIX = '[needs insurer clarification] ';

/** Cases seeded from fixtures carry this reference prefix; their KPI events are source=fixture. */
export const FIXTURE_REF_PREFIX = 'REN-FX-';
