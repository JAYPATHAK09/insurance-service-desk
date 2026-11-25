import { readFileSync } from 'node:fs';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError, requireRoleOf, type SessionUser } from '@/lib/access';
import { cases, findings, kpiEvents, reviews } from '@/db/schema';
import { csvCell, kpiCsv } from '@/modules/dashboard/csv';
import { AGE_BUCKETS, KPI_DEFINITIONS } from '@/modules/dashboard/definitions';
import { readEvalResults } from '@/modules/dashboard/eval-results';
import {
  computeKpis,
  getKpiReport,
  ageDays,
  type CaseRow,
  type Dataset,
  type EventRow,
  type FindingRow,
} from '@/modules/dashboard/kpi';
import { SCENARIO_LABEL, computeScenario, parseScenarioInputs } from '@/modules/dashboard/scenario';
import { parseWindow } from '@/modules/dashboard/window';
import { freshDb, makeCase, U } from './helpers';

let current: SessionUser = U.supervisor;
vi.mock('@/lib/session', () => ({
  requireRole: async (...roles: SessionUser['role'][]) => {
    requireRoleOf(current, ...roles);
    return current;
  },
}));

const ASOF = new Date('2026-03-31T12:00:00Z');
const WIN = { from: new Date('2026-03-01T00:00:00Z'), to: new Date('2026-04-01T00:00:00Z') };
const at = (d: string) => new Date(`${d}T10:00:00Z`);
const ev = (kind: string, caseId: string | null, value = 1, source: EventRow['source'] = 'pilot'): EventRow => ({
  kind,
  source,
  caseId,
  value,
  at: at('2026-03-10'),
});
const fnd = (caseId: string, module: string, classification: string, status = 'open'): FindingRow => ({
  caseId,
  module,
  classification,
  status,
  createdAt: at('2026-03-05'),
});
const cs = (id: string, status: string, created: string): CaseRow => ({ id, status, createdAt: at(created) });

/** Hand-built pilot dataset. Cases p1..p3 pilot; f1 fixture; m1 mixed. */
function dataset(): Dataset {
  return {
    events: [
      ev('review_minutes', 'p1', 30),
      ev('review_minutes', 'p1', 10), // p1 total 40
      ev('review_minutes', 'p2', 20), // mean (40+20)/2 = 30
      ev('review_minutes', 'p3', -5), // ignored
      ev('repeat_request', 'p1'),
      ev('repeat_request', 'p2'),
      ev('finding_corrected', 'p1'),
      ev('change_acknowledged', 'p3'),
      ev('reviewer_override', 'p2'),
      ev('false_match', 'p1'),
      ev('review_minutes', 'f1', 999, 'fixture'),
      ev('review_minutes', 'm1', 500, 'pilot'), // mixed case: excluded
      ev('review_minutes', null, 77, 'pilot'), // no case: excluded
    ],
    findings: [
      fnd('p1', 'claim-reconciler', 'satisfied_pending_verification', 'accepted'),
      fnd('p1', 'claim-reconciler', 'repeated_request', 'open'),
      fnd('p2', 'claim-reconciler', 'partially_satisfied', 'overridden'),
      fnd('p2', 'claim-reconciler', 'missing', 'dismissed'),
      fnd('p3', 'renewal-agent', 'confirmed_change', 'open'),
      fnd('p3', 'renewal-agent', 'unchanged', 'accepted'),
      fnd('p3', 'disclosure-checker', 'omission', 'open'),
      fnd('f1', 'claim-reconciler', 'missing', 'open'),
      fnd('m1', 'claim-reconciler', 'missing', 'open'),
    ],
    cases: [
      cs('p1', 'evidence_review', '2026-03-30'), // age 1
      cs('p2', 'approval', '2026-03-26'), // age 5
      cs('p3', 'exported', '2026-03-01'), // resolved
      cs('p4', 'intake', '2026-03-20'), // age 11
      cs('p5', 'intake', '2026-03-10'), // age 21
      cs('p6', 'exception_resolution', '2026-03-28'), // age 3
      cs('f1', 'intake', '2026-03-30'),
      cs('m1', 'intake', '2026-03-30'),
      cs('u1', 'intake', '2026-03-30'), // no events: unattributed
    ],
    caseSources: {
      p1: ['pilot'],
      p2: ['pilot'],
      p3: ['pilot'],
      p4: ['pilot'],
      p5: ['pilot'],
      p6: ['pilot'],
      f1: ['fixture'],
      m1: ['pilot', 'fixture'],
    },
    totalEvents: { fixture: 1, pilot: 12, scenario: 0 },
  };
}

const get = (r: ReturnType<typeof computeKpis>, id: string) => r.kpis.find((k) => k.id === id)!;

describe('KPI numerators and denominators (hand-built dataset)', () => {
  const pilot = computeKpis(dataset(), 'pilot', WIN, ASOF);

  it('review minutes: per-case sums, mean over cases, ignores negatives, mixed and caseless events', () => {
    const k = get(pilot, 'review_minutes_mean');
    expect([k.numerator, k.denominator, k.value]).toEqual([60, 2, 30]);
  });
  it('repeat requests: events / claim-reconciler findings', () => {
    const k = get(pilot, 'repeat_request_rate');
    expect([k.numerator, k.denominator, k.value]).toEqual([2, 4, 0.5]);
  });
  it('corrected discrepancies: events / all findings of attributed cases', () => {
    const k = get(pilot, 'corrected_discrepancy_rate');
    expect([k.numerator, k.denominator]).toEqual([1, 7]);
  });
  it('acknowledged changes: events / confirmed_change findings', () => {
    const k = get(pilot, 'acknowledged_change_rate');
    expect([k.numerator, k.denominator, k.value]).toEqual([1, 1, 1]);
  });
  it('reviewer overrides: events / decided findings', () => {
    const k = get(pilot, 'reviewer_override_rate');
    expect([k.numerator, k.denominator]).toEqual([1, 4]);
  });
  it('false matches: events / match-asserting findings', () => {
    const k = get(pilot, 'false_match_rate');
    expect([k.numerator, k.denominator]).toEqual([1, 3]);
  });
  it('zero denominator gives null, never a number', () => {
    const empty = computeKpis({ ...dataset(), events: [], findings: [] }, 'pilot', WIN, ASOF);
    expect(get(empty, 'review_minutes_mean').value).toBeNull();
    expect(get(empty, 'repeat_request_rate').value).toBeNull();
  });
  it('reports exclusions', () => {
    expect(pilot.excluded).toMatchObject({ mixedSourceCases: 1, events: 2 });
    expect(pilot.attributedCases).toBe(6);
  });
});

describe('unresolved cases by age', () => {
  it('ageDays floors whole days and clamps negatives', () => {
    expect(ageDays(new Date('2026-03-29T13:00:00Z'), ASOF)).toBe(1);
    expect(ageDays(new Date('2026-04-05T00:00:00Z'), ASOF)).toBe(0);
  });
  it('buckets 0-2, 3-7, 8-14, 15+ exclude exported cases', () => {
    const r = computeKpis(dataset(), 'pilot', WIN, ASOF);
    const b = Object.fromEntries(AGE_BUCKETS.map((x) => [x.id, get(r, `unresolved_${x.id}`)]));
    expect(b['0_2']!.numerator).toBe(1); // p1 age 1 (floor of 1.08)
    expect(b['3_7']!.numerator).toBe(2); // p2, p6
    expect(b['8_14']!.numerator).toBe(1); // p4
    expect(b['15_plus']!.numerator).toBe(1); // p5
    for (const x of Object.values(b)) expect(x.denominator).toBe(5);
  });
  it('boundaries land in the right bucket', () => {
    const mk = (days: number): Dataset => ({
      ...dataset(),
      events: [],
      findings: [],
      cases: [{ id: 'p1', status: 'intake', createdAt: new Date(ASOF.getTime() - days * 86_400_000) }],
      caseSources: { p1: ['pilot'] },
    });
    const idx = (d: number) => {
      const r = computeKpis(mk(d), 'pilot', WIN, ASOF);
      return AGE_BUCKETS.find((x) => get(r, `unresolved_${x.id}`).numerator === 1)!.id;
    };
    expect([2, 3, 7, 8, 14, 15].map(idx)).toEqual(['0_2', '3_7', '3_7', '8_14', '8_14', '15_plus']);
  });
});

describe('source separation', () => {
  it('fixture and pilot never share numerators or denominators', () => {
    const ds = dataset();
    const fixture = computeKpis(ds, 'fixture', WIN, ASOF);
    const pilot = computeKpis(ds, 'pilot', WIN, ASOF);
    expect(get(fixture, 'review_minutes_mean')).toMatchObject({ numerator: 999, denominator: 1 });
    expect(get(pilot, 'review_minutes_mean').numerator).toBe(60);
    expect(get(fixture, 'repeat_request_rate').denominator).toBe(1);
    const scenario = computeKpis(ds, 'scenario', WIN, ASOF);
    expect(scenario.kpis.every((k) => k.value === null)).toBe(true);
  });

  it('database path: pilot empty state data, labels and per-source totals', async () => {
    const db = await freshDb();
    const c = await makeCase(U.handlerA.id);
    const now = new Date();
    await db.insert(kpiEvents).values([
      { kind: 'review_minutes', value: '12', source: 'fixture', caseId: c.id, at: now, dedupeKey: 'a' },
    ]);
    const win = { from: new Date(now.getTime() - 86_400_000), to: new Date(now.getTime() + 86_400_000) };
    const r = await getKpiReport(db, win, now);
    expect(r.sources.pilot.totalEventsAllTime).toBe(0);
    expect(r.sources.pilot.kpis.every((k) => k.value === null)).toBe(true);
    expect(r.sources.fixture.totalEventsAllTime).toBe(1);
    expect(r.sources.fixture.kpis.find((k) => k.id === 'review_minutes_mean')).toMatchObject({ numerator: 12, denominator: 1, value: 12 });
    // the same case later gets a pilot event: it becomes mixed and leaves both sources
    await db.insert(kpiEvents).values({ kind: 'review_minutes', value: '5', source: 'pilot', caseId: c.id, at: now, dedupeKey: 'b' });
    const r2 = await getKpiReport(db, win, now);
    expect(r2.sources.fixture.kpis.find((k) => k.id === 'review_minutes_mean')!.denominator).toBe(0);
    expect(r2.sources.pilot.kpis.find((k) => k.id === 'review_minutes_mean')!.denominator).toBe(0);
  });

  it('database path: findings denominators use real findings rows', async () => {
    const db = await freshDb();
    const c = await makeCase(U.handlerA.id, { module: 'claim-reconciler' });
    const [rv] = await db
      .insert(reviews)
      .values({ caseId: c.id, module: c.module, version: 1, documentHashes: [], inputHash: 'h', mode: 'synthetic', modelId: 'm', promptVersion: 'p' })
      .returning();
    await db.insert(findings).values([
      { caseId: c.id, reviewId: rv!.id, module: c.module, key: 'k1', type: 't', classification: 'missing', summary: 's', evidence: [] },
      { caseId: c.id, reviewId: rv!.id, module: c.module, key: 'k2', type: 't', classification: 'repeated_request', summary: 's', evidence: [] },
    ]);
    await db.insert(kpiEvents).values({ kind: 'repeat_request', source: 'pilot', caseId: c.id, dedupeKey: 'r1' });
    const now = new Date();
    const r = await getKpiReport(db, { from: new Date(now.getTime() - 86_400_000), to: new Date(now.getTime() + 86_400_000) }, now);
    expect(r.sources.pilot.kpis.find((k) => k.id === 'repeat_request_rate')).toMatchObject({ numerator: 1, denominator: 2, value: 0.5 });
    expect(r.sources.fixture.kpis.find((k) => k.id === 'repeat_request_rate')!.denominator).toBe(0);
    expect((await db.select().from(cases)).length).toBe(1);
  });
});

describe('scenario calculator', () => {
  it('computes hours released from the stated formula', () => {
    const r = computeScenario({ casesPerMonth: 200, minutesPerCaseToday: 50, pctMinutesSaved: 40, retainedMinutesPerCase: 5, rampPct: 50 });
    expect(r.grossSavedMinutesPerCase).toBe(20);
    expect(r.netSavedMinutesPerCase).toBe(15);
    expect(r.casesOnWorkflow).toBe(100);
    expect(r.hoursReleasedPerMonth).toBe(25); // 100 * 15 / 60
    expect(r.label).toBe(SCENARIO_LABEL);
    expect(SCENARIO_LABEL).toBe('Scenario estimate, not a measured result');
  });
  it('never goes negative when retained time exceeds the saving', () => {
    const r = computeScenario({ casesPerMonth: 100, minutesPerCaseToday: 10, pctMinutesSaved: 10, retainedMinutesPerCase: 5, rampPct: 100 });
    expect(r.netSavedMinutesPerCase).toBe(0);
    expect(r.hoursReleasedPerMonth).toBe(0);
  });
  it('flags placeholders when nothing is supplied, validates input otherwise', () => {
    expect(parseScenarioInputs({}).usingPlaceholders).toBe(true);
    const p = parseScenarioInputs({ cases: '300', saved: '150', minutes: 'abc' });
    expect(p.usingPlaceholders).toBe(false);
    expect(p.inputs.casesPerMonth).toBe(300);
    expect(p.errors).toHaveLength(2); // saved > 100, minutes not a number
  });
});

describe('window parsing', () => {
  it('treats `to` as an inclusive day and rejects bad input', () => {
    const w = parseWindow({ from: '2026-03-01', to: '2026-03-31' });
    expect(w.to.toISOString()).toBe('2026-04-01T00:00:00.000Z');
    expect(() => parseWindow({ from: '2026-02-30' })).toThrow(HttpError);
    expect(() => parseWindow({ from: 'x' })).toThrow(HttpError);
    expect(() => parseWindow({ from: '2026-03-05', to: '2026-03-01' })).toThrow(HttpError);
  });
});

describe('definitions and CSV', () => {
  it('every KPI has numerator, denominator and window, and is documented', () => {
    const doc = readFileSync(path.join(process.cwd(), 'docs/KPI_DEFINITIONS.md'), 'utf8');
    for (const d of KPI_DEFINITIONS) {
      expect(d.numerator.length).toBeGreaterThan(10);
      expect(d.denominator.length).toBeGreaterThan(10);
      expect(d.window.length).toBeGreaterThan(10);
      expect(doc).toContain(`\`${d.id}\``);
    }
  });
  it('CSV has every KPI for every source with definitions, window and source label; escapes formulas', () => {
    const ds = dataset();
    const sources = {
      fixture: computeKpis(ds, 'fixture', WIN, ASOF),
      pilot: computeKpis(ds, 'pilot', WIN, ASOF),
      scenario: computeKpis(ds, 'scenario', WIN, ASOF),
    };
    const csv = kpiCsv({ window: WIN, asOf: ASOF, sources });
    const lines = csv.trim().split('\r\n');
    expect(lines).toHaveLength(1 + 3 * KPI_DEFINITIONS.length);
    expect(lines[0]).toContain('source_label');
    expect(csv).toContain('Measured pilot results');
    expect(csv).toContain('2026-03-01T00:00:00.000Z');
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell(null)).toBe('');
  });
});

describe('export route authorisation', () => {
  beforeEach(async () => {
    await freshDb();
  });
  it('handler gets 403; supervisor and analyst get CSV', async () => {
    const { GET } = await import('@/app/api/kpi/export/route');
    const req = () => new Request('http://x.test/api/kpi/export?from=2026-03-01&to=2026-03-31');
    current = U.handlerA;
    expect((await GET(req())).status).toBe(403);
    for (const u of [U.supervisor, U.analyst]) {
      current = u;
      const res = await GET(req());
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/csv');
      expect(await res.text()).toContain('numerator_definition');
    }
    current = U.supervisor;
    expect((await GET(new Request('http://x.test/api/kpi/export?from=nope'))).status).toBe(400);
  });
  it('JSON endpoint is also closed to handlers', async () => {
    const { GET } = await import('@/app/api/kpi/route');
    current = U.handlerA;
    expect((await GET(new Request('http://x.test/api/kpi'))).status).toBe(403);
  });
});

describe('fixture evaluation reader', () => {
  it('reads valid files, computes accuracy from counts, flags invalid ones, ignores missing', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'evalfx-'));
    mkdirSync(path.join(dir, 'claim-reconciler'));
    mkdirSync(path.join(dir, 'renewal-agent'));
    mkdirSync(path.join(dir, 'disclosure-checker'));
    writeFileSync(
      path.join(dir, 'claim-reconciler/eval-results.json'),
      JSON.stringify({ classification: { correct: 9, total: 10, accuracy: 1 }, citation: { correct: 5, total: 5 } }),
    );
    writeFileSync(path.join(dir, 'renewal-agent/eval-results.json'), JSON.stringify({ classification: { correct: 3, total: 2 } }));
    const out = await readEvalResults(dir);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ module: 'claim-reconciler', ok: true, classification: { accuracy: 0.9 }, citation: { accuracy: 1 } });
    expect(out[1]).toMatchObject({ module: 'renewal-agent', ok: false });
    expect(await readEvalResults(path.join(dir, 'nope'))).toEqual([]);
  });
});
