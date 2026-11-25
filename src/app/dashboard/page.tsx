import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getDb } from '@/db/client';
import { HttpError } from '@/lib/access';
import { requireRole } from '@/lib/session';
import { MODULE_LABEL } from '@/components/ui';
import { ATTRIBUTION_RULE, KPI_DEFINITIONS, SOURCE_LABEL, type KpiSource } from '@/modules/dashboard/definitions';
import { readEvalResults, type RatioResult } from '@/modules/dashboard/eval-results';
import { getKpiReport, type KpiResult, type SourceReport } from '@/modules/dashboard/kpi';
import {
  SCENARIO_FIELDS,
  SCENARIO_FORMULA,
  SCENARIO_LABEL,
  computeScenario,
  parseScenarioInputs,
} from '@/modules/dashboard/scenario';
import { parseWindow } from '@/modules/dashboard/window';

export const dynamic = 'force-dynamic';

const TABS: { id: 'fixture' | 'pilot' | 'scenario'; label: string }[] = [
  { id: 'fixture', label: SOURCE_LABEL.fixture },
  { id: 'pilot', label: SOURCE_LABEL.pilot },
  { id: 'scenario', label: SOURCE_LABEL.scenario },
];

const pct = (n: number | null) => (n === null ? 'n/a' : `${(n * 100).toFixed(1)}%`);
const fmtValue = (k: KpiResult) =>
  k.value === null ? 'n/a' : k.unit === 'minutes_per_case' ? `${k.value.toFixed(1)} min` : pct(k.value);
const num = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 2 });

function SourceBanner({ source }: { source: KpiSource }) {
  const text: Record<KpiSource, string> = {
    fixture: 'Computed from seeded synthetic cases and fixture evaluation files. Not real customer or business data.',
    pilot: 'Only events recorded with source=pilot from real reviews. Nothing here is simulated.',
    scenario: 'Assumptions you enter. Nothing on this tab is measured.',
  };
  return (
    <p className="rounded-lg border border-line bg-subtle px-4 py-3 text-sm text-muted" data-testid={`banner-${source}`}>
      <span className="font-medium text-ink">{SOURCE_LABEL[source]}.</span> {text[source]}
    </p>
  );
}

function KpiTable({ rep }: { rep: SourceReport }) {
  return (
    <div className="card overflow-x-auto">
      <table className="w-full min-w-[720px] border-collapse" data-testid={`kpi-table-${rep.source}`}>
        <thead>
          <tr className="border-b border-line">
            <th className="th">Measure</th>
            <th className="th text-right">Value</th>
            <th className="th text-right">Numerator</th>
            <th className="th text-right">Denominator</th>
          </tr>
        </thead>
        <tbody>
          {rep.kpis.map((k) => (
            <tr key={k.id} className="border-b border-line last:border-0">
              <td className="td">{k.label}</td>
              <td className="td text-right font-medium tabular-nums">{fmtValue(k)}</td>
              <td className="td text-right tabular-nums text-muted">{num(k.numerator)}</td>
              <td className="td text-right tabular-nums text-muted">{num(k.denominator)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="border-t border-line px-4 py-3 text-xs text-muted">
        {rep.attributedCases} attributed cases. Excluded: {rep.excluded.mixedSourceCases} mixed-source cases, {rep.excluded.events} events
        outside attributed cases. n/a means the denominator is zero.
      </p>
    </div>
  );
}

function Ratio({ r }: { r: RatioResult }) {
  return (
    <span className="tabular-nums">
      {pct(r.accuracy)} <span className="text-muted">({r.correct}/{r.total})</span>
    </span>
  );
}

async function FixtureEval() {
  const results = await readEvalResults();
  return (
    <section className="space-y-3" aria-label="Fixture evaluation results">
      <h2 className="text-lg font-semibold">Evaluation on fixtures (read-only)</h2>
      <div className="card overflow-x-auto">
        <table className="w-full min-w-[640px] border-collapse" data-testid="eval-table">
          <thead>
            <tr className="border-b border-line">
              <th className="th">Module</th>
              <th className="th">Classification accuracy</th>
              <th className="th">Citation correctness</th>
            </tr>
          </thead>
          <tbody>
            {results.map((e) => (
              <tr key={e.module} className="border-b border-line last:border-0">
                <td className="td">{MODULE_LABEL[e.module] ?? e.module}</td>
                {e.ok ? (
                  <>
                    <td className="td"><Ratio r={e.classification} /></td>
                    <td className="td"><Ratio r={e.citation} /></td>
                  </>
                ) : (
                  <td className="td text-danger" colSpan={2}>{e.error}</td>
                )}
              </tr>
            ))}
            {results.length === 0 ? (
              <tr>
                <td colSpan={3} className="td py-10 text-center text-muted">
                  No fixtures/&lt;module&gt;/eval-results.json published yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default async function DashboardPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  try {
    await requireRole('supervisor', 'analyst');
  } catch (err) {
    if (err instanceof HttpError && err.status === 401) redirect('/signin');
    return (
      <div className="card p-8" role="alert">
        <h1 className="text-2xl font-semibold tracking-tight">Founder&apos;s Office</h1>
        <p className="mt-2 text-muted">This dashboard is for supervisors and analysts. Your role does not have access.</p>
      </div>
    );
  }

  const q = await searchParams;
  const tab = TABS.find((t) => t.id === q.tab)?.id ?? 'fixture';
  let window;
  let windowError: string | null = null;
  try {
    window = parseWindow({ from: q.from, to: q.to });
  } catch (err) {
    windowError = err instanceof HttpError ? err.message : 'Invalid window';
    window = parseWindow({});
  }
  const report = await getKpiReport(await getDb(), window);
  const fromStr = window.from.toISOString().slice(0, 10);
  const toStr = new Date(window.to.getTime() - 1).toISOString().slice(0, 10);
  const exportHref = `/api/kpi/export?from=${fromStr}&to=${toStr}`;
  const scenario = parseScenarioInputs(q);
  const result = computeScenario(scenario.inputs);
  const pilot = report.sources.pilot;

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Founder&apos;s Office</h1>
          <p className="mt-2 max-w-2xl text-muted">
            Fixture results, measured pilot results and scenario estimates are kept apart. They are never summed or compared in one figure.
          </p>
        </div>
        <a href={exportHref} className="btn-quiet no-underline" data-testid="export-csv">
          Export CSV
        </a>
      </div>

      <form method="get" className="card flex flex-wrap items-end gap-4 p-5" aria-label="Date window">
        <input type="hidden" name="tab" value={tab} />
        <label className="text-xs text-muted">
          From
          <input type="date" name="from" defaultValue={fromStr} className="input mt-1" />
        </label>
        <label className="text-xs text-muted">
          To (inclusive)
          <input type="date" name="to" defaultValue={toStr} className="input mt-1" />
        </label>
        <button className="btn">Apply window</button>
        {windowError ? <span className="text-sm text-danger">{windowError}. Showing the last 30 days.</span> : null}
      </form>

      <nav className="flex gap-1 border-b border-line" aria-label="Result type">
        {TABS.map((t) => (
          <Link
            key={t.id}
            href={`/dashboard?tab=${t.id}&from=${fromStr}&to=${toStr}`}
            aria-current={t.id === tab ? 'page' : undefined}
            className={`-mb-px border-b-2 px-4 py-2.5 text-sm font-medium no-underline ${
              t.id === tab ? 'border-accent text-accent' : 'border-transparent text-muted hover:text-ink'
            }`}
          >
            {t.label}
          </Link>
        ))}
      </nav>

      {tab === 'fixture' ? (
        <div className="space-y-6" data-testid="section-fixture">
          <SourceBanner source="fixture" />
          <FixtureEval />
          <section className="space-y-3" aria-label="Fixture KPIs">
            <h2 className="text-lg font-semibold">Operational measures on seeded synthetic cases</h2>
            <KpiTable rep={report.sources.fixture} />
          </section>
        </div>
      ) : null}

      {tab === 'pilot' ? (
        <div className="space-y-6" data-testid="section-pilot">
          <SourceBanner source="pilot" />
          {pilot.totalEventsAllTime === 0 ? (
            <div className="card p-10 text-center" data-testid="pilot-empty">
              <p className="text-lg font-medium">No pilot data yet</p>
              <p className="mt-1 text-sm text-muted">Figures appear here only after real review events are recorded with source=pilot.</p>
            </div>
          ) : (
            <KpiTable rep={pilot} />
          )}
        </div>
      ) : null}

      {tab === 'scenario' ? (
        <div className="space-y-6" data-testid="section-scenario">
          <SourceBanner source="scenario" />
          <form method="get" className="card space-y-5 p-5" aria-label="Scenario calculator">
            <input type="hidden" name="tab" value="scenario" />
            <input type="hidden" name="from" value={fromStr} />
            <input type="hidden" name="to" value={toStr} />
            <h2 className="text-lg font-semibold">Monthly hours released</h2>
            {scenario.usingPlaceholders ? (
              <p className="text-sm text-warn" data-testid="placeholder-flag">
                Placeholder values. These are not measurements or targets. Replace each with your own assumption.
              </p>
            ) : null}
            <div className="grid grid-cols-1 gap-4 md:grid-cols-5">
              {SCENARIO_FIELDS.map((f) => (
                <label key={f.key} className="text-xs text-muted">
                  {f.label} ({f.unit})
                  <input
                    name={f.param}
                    inputMode="decimal"
                    defaultValue={scenario.inputs[f.key]}
                    className="input mt-1"
                    aria-describedby="scenario-note"
                  />
                </label>
              ))}
            </div>
            {scenario.errors.length ? (
              <ul className="text-sm text-danger" role="alert">
                {scenario.errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            ) : null}
            <button className="btn">Calculate</button>
          </form>

          <div className="card p-6" data-testid="scenario-result">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">{SCENARIO_LABEL}</p>
            <p className="mt-2 text-4xl font-semibold tracking-tight tabular-nums">
              {num(result.hoursReleasedPerMonth)} <span className="text-base font-normal text-muted">hours released per month</span>
            </p>
            <dl className="mt-4 grid grid-cols-1 gap-2 text-sm md:grid-cols-3">
              <div><dt className="text-muted">Gross saved per case</dt><dd className="tabular-nums">{num(result.grossSavedMinutesPerCase)} min</dd></div>
              <div><dt className="text-muted">Net saved per case</dt><dd className="tabular-nums">{num(result.netSavedMinutesPerCase)} min</dd></div>
              <div><dt className="text-muted">Cases on new workflow</dt><dd className="tabular-nums">{num(result.casesOnWorkflow)}</dd></div>
            </dl>
            <div id="scenario-note" className="mt-5 border-t border-line pt-4 text-sm text-muted">
              <p className="font-medium text-ink">Formula</p>
              <ol className="mt-1 list-decimal space-y-0.5 pl-5">
                {SCENARIO_FORMULA.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ol>
            </div>
          </div>
        </div>
      ) : null}

      <details className="card p-5" open data-testid="kpi-info">
        <summary className="cursor-pointer text-sm font-semibold">How each measure is defined</summary>
        <p className="mt-3 text-sm text-muted">{ATTRIBUTION_RULE}</p>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[800px] border-collapse">
            <thead>
              <tr className="border-b border-line">
                <th className="th">Measure</th>
                <th className="th">Numerator</th>
                <th className="th">Denominator</th>
                <th className="th">Date window</th>
              </tr>
            </thead>
            <tbody>
              {KPI_DEFINITIONS.map((d) => (
                <tr key={d.id} className="border-b border-line last:border-0">
                  <td className="td font-medium">{d.label}</td>
                  <td className="td text-muted">{d.numerator}</td>
                  <td className="td text-muted">{d.denominator}</td>
                  <td className="td text-muted">{d.window}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
