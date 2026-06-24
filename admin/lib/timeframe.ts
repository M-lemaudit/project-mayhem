/**
 * Timeframe presets shared by the dashboard and billing pages. A "range" is a
 * [start, end) pair of epoch ms; Infinity / -Infinity mean open-ended.
 */

export type PresetKey =
  | 'this_month'
  | 'last_month'
  | 'last_3_months'
  | 'this_year'
  | 'all_time'
  | 'custom';

export const PRESETS: { key: PresetKey; label: string }[] = [
  { key: 'this_month', label: 'This month' },
  { key: 'last_month', label: 'Last month' },
  { key: 'last_3_months', label: 'Last 3 months' },
  { key: 'this_year', label: 'This year' },
  { key: 'all_time', label: 'All time' },
  { key: 'custom', label: 'Custom' },
];

export type Range = [number, number];

/** Returns the [start, end) instants for a preset (custom uses the two date inputs). */
export function rangeFor(preset: PresetKey, customStart: string, customEnd: string): Range {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  switch (preset) {
    case 'this_month':
      return [new Date(y, m, 1).getTime(), Infinity];
    case 'last_month':
      return [new Date(y, m - 1, 1).getTime(), new Date(y, m, 1).getTime()];
    case 'last_3_months':
      return [new Date(y, m - 2, 1).getTime(), Infinity];
    case 'this_year':
      return [new Date(y, 0, 1).getTime(), Infinity];
    case 'custom': {
      const start = customStart ? new Date(customStart).getTime() : -Infinity;
      // Inclusive end-of-day for the picked end date.
      const end = customEnd ? new Date(customEnd).getTime() + 24 * 60 * 60_000 : Infinity;
      return [start, end];
    }
    case 'all_time':
    default:
      return [-Infinity, Infinity];
  }
}

export function inRange(ts: number, [start, end]: Range): boolean {
  return ts >= start && ts < end;
}

/** Currency-aware money formatter. Falls back gracefully on unknown codes. */
export function money(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency || 'EUR',
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

export function monthLabelOf(key: string): string {
  const [y, m] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}
