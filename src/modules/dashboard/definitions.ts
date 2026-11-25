/**
 * KPI definitions: the single source for the code, the page info panel, the CSV export and docs/KPI_DEFINITIONS.md.
 * Every KPI states numerator, denominator and date window. Keep docs/KPI_DEFINITIONS.md in step (a test checks the ids).
 */
export const SOURCES = ['fixture', 'pilot', 'scenario'] as const;
export type KpiSource = (typeof SOURCES)[number];

export const SOURCE_LABEL: Record<KpiSource, string> = {
  fixture: 'Fixture results',
  pilot: 'Measured pilot results',
  scenario: 'Scenario estimates',
};

export const AGE_BUCKETS = [
  { id: '0_2', label: '0-2 days', min: 0, max: 2 },
  { id: '3_7', label: '3-7 days', min: 3, max: 7 },
  { id: '8_14', label: '8-14 days', min: 8, max: 14 },
  { id: '15_plus', label: '15+ days', min: 15, max: Infinity },
] as const;

export interface KpiDefinition {
  id: string;
  label: string;
  unit: 'minutes_per_case' | 'ratio' | 'share';
  numerator: string;
  denominator: string;
  window: string;
}

const EVENT_WINDOW = 'Numerator events: kpi_events.at in [from, to). Denominator rows: findings.created_at in [from, to).';
const SNAPSHOT_WINDOW = 'Snapshot at the "as of" instant (no date range). Age = whole days from cases.created_at to as-of.';

export const KPI_DEFINITIONS: readonly KpiDefinition[] = [
  {
    id: 'review_minutes_mean',
    label: 'Review minutes per case (mean)',
    unit: 'minutes_per_case',
    numerator: 'Sum of kpi_events.value for kind review_minutes, over the attributed cases that have at least one such event in the window.',
    denominator: 'Number of distinct attributed cases with at least one review_minutes event in the window.',
    window: 'kpi_events.at in [from, to).',
  },
  {
    id: 'repeat_request_rate',
    label: 'Repeat requests',
    unit: 'ratio',
    numerator: 'Count of kpi_events of kind repeat_request.',
    denominator: 'Count of claim-reconciler findings (extracted insurer query items).',
    window: EVENT_WINDOW,
  },
  {
    id: 'corrected_discrepancy_rate',
    label: 'Corrected discrepancies',
    unit: 'ratio',
    numerator: 'Count of kpi_events of kind finding_corrected (a reviewer corrected a finding).',
    denominator: 'Count of findings, all modules.',
    window: EVENT_WINDOW,
  },
  {
    id: 'acknowledged_change_rate',
    label: 'Acknowledged changes',
    unit: 'ratio',
    numerator: 'Count of kpi_events of kind change_acknowledged (customer acknowledgement recorded for a material change).',
    denominator: 'Count of renewal-agent findings classified confirmed_change.',
    window: EVENT_WINDOW,
  },
  {
    id: 'reviewer_override_rate',
    label: 'Reviewer overrides',
    unit: 'ratio',
    numerator: 'Count of kpi_events of kind reviewer_override.',
    denominator: 'Count of findings with a reviewer decision (status accepted, overridden or dismissed).',
    window: EVENT_WINDOW,
  },
  {
    id: 'false_match_rate',
    label: 'False matches',
    unit: 'ratio',
    numerator: 'Count of kpi_events of kind false_match (a reviewer judged a system match wrong).',
    denominator:
      'Count of findings that assert a match: classification satisfied_pending_verification, partially_satisfied, unchanged or rephrasing_only.',
    window: EVENT_WINDOW,
  },
  ...AGE_BUCKETS.map(
    (b): KpiDefinition => ({
      id: `unresolved_${b.id}`,
      label: `Unresolved cases aged ${b.label}`,
      unit: 'share',
      numerator: `Count of attributed cases with status other than exported and age in ${b.label}.`,
      denominator: 'Count of all attributed cases with status other than exported.',
      window: SNAPSHOT_WINDOW,
    }),
  ),
];

export const ATTRIBUTION_RULE =
  'A case belongs to a source (fixture, pilot or scenario) only when every kpi_events row that references it carries that one source. ' +
  'Cases with no events, or with mixed sources, are excluded and counted separately. Events without a case, or whose case belongs to a different source, are excluded and counted.';

export const KPI_EVENT_KINDS = [
  'review_minutes',
  'repeat_request',
  'finding_corrected',
  'reviewer_override',
  'false_match',
  'change_acknowledged',
] as const;
export type KpiEventKind = (typeof KPI_EVENT_KINDS)[number];
