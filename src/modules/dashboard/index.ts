// Owned by the dashboard agent. Reads kpi_events / findings / cases; no engine, no registry entry.
export * from './definitions';
export * from './kpi';
export * from './scenario';
export { parseWindow } from './window';
export { kpiCsv } from './csv';
export { readEvalResults } from './eval-results';
