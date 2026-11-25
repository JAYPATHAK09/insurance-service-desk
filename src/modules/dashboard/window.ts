import { z } from 'zod';
import { HttpError } from '@/lib/access';
import type { KpiWindow } from './kpi';

const DAY = 86_400_000;
const DateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const Params = z.object({ from: DateOnly.optional(), to: DateOnly.optional() });

const parseDay = (s: string): Date | null => {
  const d = new Date(`${s}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? null : d;
};

/**
 * Window from `from`/`to` (YYYY-MM-DD, UTC; `to` is inclusive as a day, stored exclusive as the next midnight).
 * Defaults: the 30 days ending at `now`. Throws HttpError(400) on invalid or inverted input or a span over 5 years.
 */
export function parseWindow(raw: { from?: string | null; to?: string | null }, now: Date = new Date()): KpiWindow {
  const p = Params.safeParse({ from: raw.from || undefined, to: raw.to || undefined });
  if (!p.success) throw new HttpError(400, 'Dates must be YYYY-MM-DD');
  const from = p.data.from ? parseDay(p.data.from) : new Date(now.getTime() - 30 * DAY);
  const toDay = p.data.to ? parseDay(p.data.to) : null;
  const to = toDay ? new Date(toDay.getTime() + DAY) : new Date(now.getTime() + 1);
  if (!from || (p.data.to && !toDay)) throw new HttpError(400, 'Invalid date');
  if (from >= to) throw new HttpError(400, 'from must be before to');
  if (to.getTime() - from.getTime() > 5 * 366 * DAY) throw new HttpError(400, 'Window too long');
  return { from, to };
}
