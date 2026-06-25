/**
 * Money + ride aggregation shared by the dashboard and bot-detail pages.
 *
 * "made" = the full value of every ride the bot booked in the timeframe
 * (Σ booked price, keyed on created_at = when the bot caught it). We bill 3%
 * of that. finished_price/reconciliation only refines a ride once it completes;
 * it does NOT gate whether a booking counts toward the headline.
 */
import { BILLING_FEE_RATE, type AcceptedOfferRow } from '@/lib/supabase';
import type { Range } from '@/lib/timeframe';
import { inRange } from '@/lib/timeframe';

export interface MoneyByCurrency {
  currency: string;
  made: number; // gross booked value (Σ price)
  pay: number; // 3% fee
  completed: number; // booked ride count
}

export interface Metrics {
  booked: number; // accepted offers created in range
  byCurrency: MoneyByCurrency[]; // booked value, split by currency
}

/** Booked fare as a number — `price` is a plain numeric string (e.g. "251.35"). */
function bookedAmount(o: AcceptedOfferRow): number {
  if (o.price == null) return 0;
  const n = Number(String(o.price).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/**
 * Booked rows carry no currency (only reconciled rows get finished_currency),
 * so we attribute every booking to the fleet's dominant currency, defaulting
 * to EUR when nothing has reconciled yet.
 */
function dominantCurrency(offers: AcceptedOfferRow[]): string {
  const counts = new Map<string, number>();
  for (const o of offers) {
    if (o.finished_currency) counts.set(o.finished_currency, (counts.get(o.finished_currency) ?? 0) + 1);
  }
  let best = 'EUR';
  let bestN = 0;
  for (const [c, n] of Array.from(counts.entries())) if (n > bestN) ((best = c), (bestN = n));
  return best;
}

/** Headline figures for a timeframe: booked count + booked value/pay grouped by currency. */
export function madePayBooked(offers: AcceptedOfferRow[], range: Range): Metrics {
  let booked = 0;
  const fallback = dominantCurrency(offers);
  const byCur = new Map<string, MoneyByCurrency>();

  for (const o of offers) {
    if (!o.created_at || !inRange(new Date(o.created_at).getTime(), range)) continue;
    booked += 1;

    const currency = o.finished_currency || fallback;
    const price = bookedAmount(o);
    const agg = byCur.get(currency) ?? { currency, made: 0, pay: 0, completed: 0 };
    agg.made += price;
    agg.pay += price * BILLING_FEE_RATE;
    agg.completed += 1;
    byCur.set(currency, agg);
  }

  const byCurrency = Array.from(byCur.values()).sort((a, b) => b.made - a.made);
  return { booked, byCurrency };
}

/** The currency carrying the most booked rides in a set (defaults to EUR). */
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
 * buckets are included so the line reads as a real timeline. Keyed on the
 * booking date (created_at) so it tracks the full booked value, not just
 * reconciled rides.
 */
export function bucketSeries(offers: AcceptedOfferRow[], range: Range): {
  points: SeriesPoint[];
  currency: string;
} {
  const fallback = dominantCurrency(offers);
  const currency = primaryCurrency(madePayBooked(offers, range).byCurrency);
  const inCur = offers.filter(
    (o) =>
      o.created_at &&
      inRange(new Date(o.created_at).getTime(), range) &&
      (o.finished_currency || fallback) === currency
  );
  if (inCur.length === 0) return { points: [], currency };

  const times = inCur.map((o) => new Date(o.created_at).getTime());
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
    const key = keyer(new Date(o.created_at)).toISOString().slice(0, 10);
    const p = buckets.get(key);
    if (!p) continue;
    const price = bookedAmount(o);
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
  const fallback = dominantCurrency(offers);
  for (const o of offers) {
    const row = (out[o.bot_id] ??= { made: 0, pay: 0, booked: 0, currency: fallback });
    if (!o.created_at || !inRange(new Date(o.created_at).getTime(), range)) continue;
    row.booked += 1;
    if (!row.lastCatch || o.created_at > row.lastCatch) row.lastCatch = o.created_at;
    const price = bookedAmount(o);
    row.made += price;
    row.pay += price * BILLING_FEE_RATE;
    if (o.finished_currency) row.currency = o.finished_currency;
  }
  return out;
}
