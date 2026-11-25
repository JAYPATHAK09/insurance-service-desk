import { KPI_DEFINITIONS, SOURCES, SOURCE_LABEL } from './definitions';
import type { KpiReport } from './kpi';

/** RFC 4180 quoting, plus a leading apostrophe on cells that a spreadsheet could read as a formula. */
export function csvCell(v: string | number | null): string {
  if (v === null) return '';
  let s = String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const CSV_HEADER = [
  'source',
  'source_label',
  'kpi_id',
  'kpi',
  'unit',
  'numerator',
  'denominator',
  'value',
  'window_from',
  'window_to',
  'numerator_definition',
  'denominator_definition',
  'window_definition',
] as const;

/** One row per KPI per source. Empty value = denominator 0 (not computable), never a placeholder number. */
export function kpiCsv(report: KpiReport): string {
  const defs = new Map(KPI_DEFINITIONS.map((d) => [d.id, d]));
  const lines = [CSV_HEADER.join(',')];
  for (const s of SOURCES) {
    for (const k of report.sources[s].kpis) {
      const d = defs.get(k.id)!;
      lines.push(
        [
          s,
          SOURCE_LABEL[s],
          k.id,
          k.label,
          k.unit,
          k.numerator,
          k.denominator,
          k.value,
          k.windowFrom,
          k.windowTo,
          d.numerator,
          d.denominator,
          k.windowNote,
        ]
          .map(csvCell)
          .join(','),
      );
    }
  }
  return lines.join('\r\n') + '\r\n';
}
