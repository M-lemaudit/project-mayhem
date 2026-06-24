/**
 * Money + ride aggregation shared by the dashboard and bot-detail pages.
 *
 * Two distinct concepts, deliberately kept apart:
 *  - "booked"   — an accepted offer (created_at = when the bot caught it).
 *  - "made/pay" — only rides that completed on Blacklane and were reconciled
 *                 (finished_price is the authoritative billing base; pay = 3%).
 */
import { BILLING_FEE_RATE, type AcceptedOfferRow } from '@/lib/supabase';
import type { Range } from '@/lib/timeframe';
import { inRange } from '@/lib/timeframe';

export interface MoneyByCurrency {
  currency: string;
  made: number; // gross earnings (Σ finished_price)
  pay: number; // 3% fee
  completed: number; // billable ride count
}

export interface Metrics {
  booked: number; // accepted offers created in range
  byCurrency: MoneyByCurrency[]; // completed/billed, split by currency
}

function isBillable(o: AcceptedOfferRow): boolean {
  return Boolean(o.reconciled_at && o.completed_at);
}

/** Headline figures for a timeframe: bookings + made/pay grouped by currency. */
export function madePayBooked(offers: AcceptedOfferRow[], range: Range): Metrics {
  let booked = 0;
  const byCur = new Map<string, MoneyByCurrency>();

  for (const o of offers) {
    if (o.created_at && inRange(new Date(o.created_at).getTime(), range)) booked += 1;

    if (!isBillable(o)) continue;
    if (!inRange(new Date(o.completed_at as string).getTime(), range)) continue;
    const currency = o.finished_currency || 'EUR';
    const price = o.finished_price ?? 0;
    const agg = byCur.get(currency) ?? { currency, made: 0, pay: 0, completed: 0 };
    agg.made += price;
    agg.pay += price * BILLING_FEE_RATE;
    agg.completed += 1;
    byCur.set(currency, agg);
  }

  const byCurrency = Array.from(byCur.values()).sort((a, b) => b.made - a.made);
  return { booked, byCurrency };
}

/** The currency carrying the most completed rides in a set (defaults to EUR). */
export function primaryCurrency(byCurrency: MoneyByCurrency[]): string {
  if (byCurrency.length === 0) return 'EUR';
  return byCurrency.reduce((a, b) => (b.completed > a.completed ? b : a)).currency;
}

export interface SeriesPoint {
  key: string;
  label: string;
  made: number;
  pay: number;
  count: number;
}

type Granularity = 'day' | 'week' | 'month';

const DAY_MS = 86_400_000;

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
function startOfWeek(d: Date): Date {
  const s = startOfDay(d);
  const day = (s.getDay() + 6) % 7; // Monday = 0
  s.setDate(s.getDate() - day);
  return s;
}
function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function bucketKeyer(g: Granularity): (d: Date) => Date {
  return g === 'day' ? startOfDay : g === 'week' ? startOfWeek : startOfMonth;
}

function labelFor(d: Date, g: Granularity): string {
  if (g === 'month') return d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * Continuous time series of made/pay/count for the chart, in the primary
 * currency only (mixing currencies on one axis would be meaningless). Empty
 * buckets are included so the line reads as a real timeline.
 */
export function bucketSeries(offers: AcceptedOfferRow[], range: Range): {
  points: SeriesPoint[];
  currency: string;
} {
  const billable = offers.filter(
    (o) => isBillable(o) && inRange(new Date(o.completed_at as string).getTime(), range)
  );
  const currency = primaryCurrency(madePayBooked(offers, range).byCurrency);
  const inCur = billable.filter((o) => (o.finished_currency || 'EUR') === currency);
  if (inCur.length === 0) return { points: [], currency };

  const times = inCur.map((o) => new Date(o.completed_at as string).getTime());
  const [rs, re] = range;
  const now = Date.now();
  const minTs = Math.min(...times);
  const maxTs = Math.max(...times);
  const start = Number.isFinite(rs) ? Math.max(rs, minTs) : minTs;
  const endRaw = Number.isFinite(re) ? Math.min(re, now) : now;
  const end = Math.max(endRaw, maxTs) + 1;
  const spanDays = (end - start) / DAY_MS;
  const g: Granularity = spanDays <= 62 ? 'day' : spanDays <= 370 ? 'week' : 'month';

  const keyer = bucketKeyer(g);
  const buckets = new Map<string, SeriesPoint>();

  // Seed continuous, empty buckets across the span.
  let cursor = keyer(new Date(start));
  const endDate = new Date(end);
  let guard = 0;
  while (cursor.getTime() <= endDate.getTime() && guard < 1000) {
    const key = cursor.toISOString().slice(0, 10);
    buckets.set(key, { key, label: labelFor(cursor, g), made: 0, pay: 0, count: 0 });
    if (g === 'month') cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
    else cursor = new Date(cursor.getTime() + (g === 'week' ? 7 : 1) * DAY_MS);
    guard += 1;
  }

  for (const o of inCur) {
    const key = keyer(new Date(o.completed_at as string)).toISOString().slice(0, 10);
    const p = buckets.get(key);
    if (!p) continue;
    const price = o.finished_price ?? 0;
    p.made += price;
    p.pay += price * BILLING_FEE_RATE;
    p.count += 1;
  }

  return { points: Array.from(buckets.values()), currency };
}

/** Per-bot made (gross) + booked counts for a timeframe — for fleet rows & contribution bars. */
export function aggregateByBot(
  offers: AcceptedOfferRow[],
  range: Range
): Record<string, { made: number; pay: number; booked: number; currency: string; lastCatch?: string }> {
  const out: Record<
    string,
    { made: number; pay: number; booked: number; currency: string; lastCatch?: string }
  > = {};
  for (const o of offers) {
    const row = (out[o.bot_id] ??= { made: 0, pay: 0, booked: 0, currency: 'EUR' });
    if (o.created_at && inRange(new Date(o.created_at).getTime(), range)) {
      row.booked += 1;
      if (!row.lastCatch || o.created_at > row.lastCatch) row.lastCatch = o.created_at;
    }
    if (isBillable(o) && inRange(new Date(o.completed_at as string).getTime(), range)) {
      row.made += o.finished_price ?? 0;
      row.pay += (o.finished_price ?? 0) * BILLING_FEE_RATE;
      if (o.finished_currency) row.currency = o.finished_currency;
    }
  }
  return out;
}
