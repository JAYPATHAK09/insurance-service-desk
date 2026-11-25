import { z } from 'zod';

/**
 * Scenario calculator for monthly hours released. Pure arithmetic on user-entered assumptions.
 * It never reads measured data, and its output is always labelled a scenario estimate.
 *
 *   gross saved minutes per case = minutesPerCaseToday * pctMinutesSaved / 100
 *   net saved minutes per case   = max(0, gross - retainedMinutesPerCase)
 *   cases on new workflow        = casesPerMonth * rampPct / 100
 *   hours released per month     = cases on new workflow * net saved minutes per case / 60
 */
export interface ScenarioInputs {
  casesPerMonth: number;
  minutesPerCaseToday: number;
  pctMinutesSaved: number;
  retainedMinutesPerCase: number;
  rampPct: number;
}

export const SCENARIO_LABEL = 'Scenario estimate, not a measured result';

export const SCENARIO_FORMULA = [
  'gross saved minutes per case = minutes per case today x % minutes saved / 100',
  'net saved minutes per case = max(0, gross saved minutes - review/verification minutes retained per case)',
  'cases on new workflow = cases per month x ramp % / 100',
  'hours released per month = cases on new workflow x net saved minutes per case / 60',
];

/** Placeholders only. They are not measurements, forecasts or targets; replace them with your own assumptions. */
export const SCENARIO_PLACEHOLDERS: ScenarioInputs = {
  casesPerMonth: 100,
  minutesPerCaseToday: 60,
  pctMinutesSaved: 20,
  retainedMinutesPerCase: 5,
  rampPct: 100,
};

export const SCENARIO_FIELDS: { key: keyof ScenarioInputs; param: string; label: string; min: number; max: number; unit: string }[] = [
  { key: 'casesPerMonth', param: 'cases', label: 'Cases per month', min: 0, max: 1_000_000, unit: 'cases' },
  { key: 'minutesPerCaseToday', param: 'minutes', label: 'Minutes per case today', min: 0, max: 10_000, unit: 'min' },
  { key: 'pctMinutesSaved', param: 'saved', label: '% of minutes saved', min: 0, max: 100, unit: '%' },
  { key: 'retainedMinutesPerCase', param: 'retained', label: 'Review/verification time retained per case', min: 0, max: 10_000, unit: 'min' },
  { key: 'rampPct', param: 'ramp', label: 'Ramp (share of cases on the new workflow)', min: 0, max: 100, unit: '%' },
];

export interface ScenarioParse {
  inputs: ScenarioInputs;
  errors: string[];
  /** True when no field was supplied, so every value is still a placeholder. */
  usingPlaceholders: boolean;
}

/** Parse user-supplied strings (query params). Invalid fields fall back to the placeholder and are reported. */
export function parseScenarioInputs(raw: Record<string, string | undefined>): ScenarioParse {
  const inputs = { ...SCENARIO_PLACEHOLDERS };
  const errors: string[] = [];
  let supplied = 0;
  for (const f of SCENARIO_FIELDS) {
    const v = raw[f.param];
    if (v === undefined || v.trim() === '') continue;
    supplied++;
    const n = z.coerce.number().finite().min(f.min).max(f.max).safeParse(v.trim());
    if (n.success) inputs[f.key] = n.data;
    else errors.push(`${f.label}: enter a number from ${f.min} to ${f.max}.`);
  }
  return { inputs, errors, usingPlaceholders: supplied === 0 };
}

export interface ScenarioResult {
  grossSavedMinutesPerCase: number;
  netSavedMinutesPerCase: number;
  casesOnWorkflow: number;
  hoursReleasedPerMonth: number;
  label: typeof SCENARIO_LABEL;
}

export function computeScenario(i: ScenarioInputs): ScenarioResult {
  const gross = (i.minutesPerCaseToday * i.pctMinutesSaved) / 100;
  const net = Math.max(0, gross - i.retainedMinutesPerCase);
  const cases = (i.casesPerMonth * i.rampPct) / 100;
  return {
    grossSavedMinutesPerCase: gross,
    netSavedMinutesPerCase: net,
    casesOnWorkflow: cases,
    hoursReleasedPerMonth: (cases * net) / 60,
    label: SCENARIO_LABEL,
  };
}
