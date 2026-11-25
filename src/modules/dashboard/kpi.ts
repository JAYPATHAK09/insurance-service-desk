import { and, gte, isNotNull, lt, sql } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { cases, findings, kpiEvents } from '@/db/schema';
import { AGE_BUCKETS, KPI_DEFINITIONS, KPI_EVENT_KINDS, SOURCES, type KpiSource } from './definitions';

export interface KpiWindow {
  /** Inclusive. */
  from: Date;
  /** Exclusive. */
  to: Date;
}

export interface EventRow {
  kind: string;
  source: KpiSource;
  caseId: string | null;
  value: number;
  at: Date;
}
export interface FindingRow {
  caseId: string;
  module: string;
  classification: string;
  status: string;
  createdAt: Date;
}
export interface CaseRow {
  id: string;
  status: string;
  createdAt: Date;
}
export interface Dataset {
  /** Events with at in the window. */
  events: EventRow[];
  /** Findings with created_at in the window. */
  findings: FindingRow[];
  /** All cases (the unresolved snapshot does not use the window). */
  cases: CaseRow[];
  /** Every distinct source seen on any kpi_events row for the case, all time. */
  caseSources: Record<string, KpiSource[]>;
  /** All-time kpi_events row count per source (drives the "No pilot data yet" state). */
  totalEvents: Record<KpiSource, number>;
}

export interface KpiResult {
  id: string;
  label: string;
  source: KpiSource;
  unit: string;
  numerator: number;
  denominator: number;
  /** null when the denominator is 0: never a made-up number. */
  value: number | null;
  windowFrom: string | null;
  windowTo: string | null;
  windowNote: string;
}

export interface SourceReport {
  source: KpiSource;
  totalEventsAllTime: number;
  eventsInWindow: number;
  attributedCases: number;
  excluded: { mixedSourceCases: number; unattributedCases: number; events: number };
  kpis: KpiResult[];
}

const DAY = 86_400_000;
const FINDING_MATCH_CLASSES = ['satisfied_pending_verification', 'partially_satisfied', 'unchanged', 'rephrasing_only'];

export const ageDays = (createdAt: Date, asOf: Date) => Math.max(0, Math.floor((asOf.getTime() - createdAt.getTime()) / DAY));
export const bucketOf = (days: number) => AGE_BUCKETS.find((b) => days >= b.min && days <= b.max)!;

/** Pure: compute every KPI for one source from an in-memory dataset. */
export function computeKpis(ds: Dataset, source: KpiSource, window: KpiWindow, asOf: Date): SourceReport {
  const caseIds = Object.keys(ds.caseSources);
  const attributed = new Set(caseIds.filter((id) => ds.caseSources[id]!.length === 1 && ds.caseSources[id]![0] === source));
  const mixed = caseIds.filter((id) => ds.caseSources[id]!.length > 1).length;

  const sourceEvents = ds.events.filter((e) => e.source === source);
  const events = sourceEvents.filter((e) => e.caseId !== null && attributed.has(e.caseId));
  const ev = (kind: string) => events.filter((e) => e.kind === kind);
  const fs = ds.findings.filter((f) => attributed.has(f.caseId));

  const windowFrom = window.from.toISOString();
  const windowTo = window.to.toISOString();
  const defs = new Map(KPI_DEFINITIONS.map((d) => [d.id, d]));
  const make = (id: string, numerator: number, denominator: number, snapshot = false): KpiResult => {
    const d = defs.get(id)!;
    return {
      id,
      label: d.label,
      source,
      unit: d.unit,
      numerator,
      denominator,
      value: denominator > 0 ? numerator / denominator : null,
      windowFrom: snapshot ? null : windowFrom,
      windowTo: snapshot ? null : windowTo,
      windowNote: snapshot ? `${d.window} As of ${asOf.toISOString()}.` : d.window,
    };
  };

  // Review minutes: sum per case, then mean across cases. Non-finite or negative values are ignored.
  const perCase = new Map<string, number>();
  for (const e of ev('review_minutes')) {
    if (!Number.isFinite(e.value) || e.value < 0) continue;
    perCase.set(e.caseId!, (perCase.get(e.caseId!) ?? 0) + e.value);
  }
  const minutesSum = [...perCase.values()].reduce((a, b) => a + b, 0);

  const kpis: KpiResult[] = [
    make('review_minutes_mean', minutesSum, perCase.size),
    make('repeat_request_rate', ev('repeat_request').length, fs.filter((f) => f.module === 'claim-reconciler').length),
    make('corrected_discrepancy_rate', ev('finding_corrected').length, fs.length),
    make(
      'acknowledged_change_rate',
      ev('change_acknowledged').length,
      fs.filter((f) => f.module === 'renewal-agent' && f.classification === 'confirmed_change').length,
    ),
    make('reviewer_override_rate', ev('reviewer_override').length, fs.filter((f) => f.status !== 'open').length),
    make('false_match_rate', ev('false_match').length, fs.filter((f) => FINDING_MATCH_CLASSES.includes(f.classification)).length),
  ];

  const unresolved = ds.cases.filter((c) => attributed.has(c.id) && c.status !== 'exported');
  const counts = new Map<string, number>(AGE_BUCKETS.map((b) => [b.id, 0]));
  for (const c of unresolved) {
    const b = bucketOf(ageDays(c.createdAt, asOf));
    counts.set(b.id, counts.get(b.id)! + 1);
  }
  for (const b of AGE_BUCKETS) kpis.push(make(`unresolved_${b.id}`, counts.get(b.id)!, unresolved.length, true));

  return {
    source,
    totalEventsAllTime: ds.totalEvents[source],
    eventsInWindow: sourceEvents.length,
    attributedCases: attributed.size,
    excluded: {
      mixedSourceCases: mixed,
      unattributedCases: ds.cases.filter((c) => !ds.caseSources[c.id]).length,
      events: sourceEvents.length - events.length,
    },
    kpis,
  };
}

export async function loadDataset(db: Db, window: KpiWindow): Promise<Dataset> {
  const kinds = [...KPI_EVENT_KINDS];
  const evRows = await db
    .select({ kind: kpiEvents.kind, source: kpiEvents.source, caseId: kpiEvents.caseId, value: kpiEvents.value, at: kpiEvents.at })
    .from(kpiEvents)
    .where(and(gte(kpiEvents.at, window.from), lt(kpiEvents.at, window.to)));
  const events: EventRow[] = evRows
    .filter((r) => (kinds as string[]).includes(r.kind))
    .map((r) => ({ ...r, value: Number(r.value) }));

  const fRows = await db
    .select({
      caseId: findings.caseId,
      module: findings.module,
      classification: findings.classification,
      status: findings.status,
      createdAt: findings.createdAt,
    })
    .from(findings)
    .where(and(gte(findings.createdAt, window.from), lt(findings.createdAt, window.to)));

  const caseRows = await db.select({ id: cases.id, status: cases.status, createdAt: cases.createdAt }).from(cases);

  const pairs = await db
    .selectDistinct({ caseId: kpiEvents.caseId, source: kpiEvents.source })
    .from(kpiEvents)
    .where(isNotNull(kpiEvents.caseId));
  const caseSources: Record<string, KpiSource[]> = {};
  for (const p of pairs) (caseSources[p.caseId!] ??= []).push(p.source);

  const totals = await db
    .select({ source: kpiEvents.source, n: sql<number>`count(*)::int` })
    .from(kpiEvents)
    .groupBy(kpiEvents.source);
  const totalEvents: Record<KpiSource, number> = { fixture: 0, pilot: 0, scenario: 0 };
  for (const t of totals) totalEvents[t.source] = Number(t.n);

  return { events, findings: fRows, cases: caseRows, caseSources, totalEvents };
}

export interface KpiReport {
  window: KpiWindow;
  asOf: Date;
  sources: Record<KpiSource, SourceReport>;
}

export async function getKpiReport(db: Db, window: KpiWindow, asOf: Date = new Date()): Promise<KpiReport> {
  const ds = await loadDataset(db, window);
  const sources = Object.fromEntries(SOURCES.map((s) => [s, computeKpis(ds, s, window, asOf)])) as Record<KpiSource, SourceReport>;
  return { window, asOf, sources };
}
